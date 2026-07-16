// ─── mobile-scanner.js ───────────────────────────────────────────
// QR Code + Código de Barras — iOS Safari e Android
// Arquitetura v4:
//  • Câmera gerenciada manualmente (getUserMedia) — sem LiveStream
//  • Loop próprio alternando: frame inteiro ↔ zoom digital 2x do centro
//    (o zoom digital amplia códigos pequenos/distantes antes de decodificar)
//  • Quagga.decodeSingle por frame (sem listeners acumulados)
//  • jsQR em paralelo para QR Code
//  • Votação adaptativa: 3 leituras iguais, ou 2 se qualidade excelente
// ─────────────────────────────────────────────────────────────────

// ── SIDEBAR MOBILE ────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  const ov = document.getElementById('sidebar-overlay');
  if (!sb || !ov) return;
  const open = sb.classList.toggle('open');
  ov.classList.toggle('open', open);
}
function closeSidebar() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => { if (window.innerWidth <= 768) closeSidebar(); });
});

// ── DARK MODE ─────────────────────────────────────────────────────
const _origToggleDark = window.toggleDark;
window.toggleDark = function () { _origToggleDark?.(); _syncDarkIcon(); };
function _syncDarkIcon() {
  const icon = document.getElementById('mobile-dark-icon');
  if (icon) icon.className = document.documentElement.classList.contains('dark') ? 'ti ti-sun' : 'ti ti-moon';
}
_syncDarkIcon();

// ─────────────────────────────────────────────────────────────────
//  SCANNER
// ─────────────────────────────────────────────────────────────────
let _stream       = null;
let _video        = null;
let _scanTimer    = null;
let _busy         = false;
let _detected     = false;
let _scanActive   = false;
let _frameToggle  = 0;      // alterna: 0 = frame inteiro, 1 = zoom 2x centro
let _targetField  = 'f_serie';
let _libsLoaded   = false;

// Votação adaptativa
const CONFIRM_NEEDED    = 3;     // padrão: 3 leituras idênticas
const CONFIRM_FAST      = 2;     // aceita com 2 se qualidade excelente
const FAST_ERROR_MAX    = 0.06;  // limiar de "qualidade excelente"
const REJECT_ERROR_MIN  = 0.12;  // acima disso, leitura descartada
const CONFIRM_WINDOW_MS = 6000;  // janela longa: leituras raras ainda acumulam
let _lastValue    = null;
let _voteCount    = 0;
let _lastVoteTime = 0;
let _lastAvgErr   = 1;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('Falha ao baixar: ' + src));
    document.head.appendChild(s);
  });
}

async function _loadLibs() {
  if (_libsLoaded) return;
  await Promise.all([
    _loadScript('https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js'),
    _loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js')
  ]);
  _libsLoaded = true;
}

// ── ABRIR SCANNER ────────────────────────────────────────────────
async function openScanner(fieldId) {
  _targetField = fieldId || 'f_serie';
  _detected    = false;
  _lastValue   = null;
  _voteCount   = 0;
  _lastVoteTime = 0;
  _frameToggle = 0;

  _setHint('Carregando leitor...');
  document.getElementById('scanner-modal').classList.add('open');

  try {
    await _loadLibs();
  } catch(e) {
    closeScanner();
    alert('📷 Erro ao carregar o leitor. Verifique sua conexão e tente novamente.');
    return;
  }

  _setHint('Inicializando câmera...');

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });
  } catch(err) {
    closeScanner();
    let msg = '📷 Não foi possível acessar a câmera.';
    if (err.name === 'NotAllowedError')
      msg = '📷 Permissão de câmera negada.\n\niOS: Configurações → Safari → Câmera → Permitir\nAndroid: Configurações do navegador → Permissões';
    else if (err.name === 'NotFoundError')
      msg = '📷 Câmera não encontrada.';
    alert(msg);
    return;
  }

  // Monta o <video> dentro do container
  const container = document.getElementById('scanner-qr-container');
  container.innerHTML = '';
  _video = document.createElement('video');
  _video.setAttribute('autoplay', '');
  _video.setAttribute('muted', '');
  _video.setAttribute('playsinline', '');
  _video.setAttribute('webkit-playsinline', '');
  _video.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;top:0;left:0;';
  container.appendChild(_video);
  _video.srcObject = _stream;

  await new Promise(res => {
    _video.onloadedmetadata = res;
    setTimeout(res, 2500);
  });
  try { await _video.play(); } catch(_) {}

  // Trava zoom óptico em 1x se suportado (evita salto de lente)
  try {
    const track = _stream.getVideoTracks()[0];
    const caps  = track.getCapabilities?.();
    if (caps?.zoom) {
      const t = Math.min(Math.max(1, caps.zoom.min), caps.zoom.max);
      track.applyConstraints({ advanced: [{ zoom: t }] }).catch(() => {});
    }
  } catch(_) {}

  _setHint('Aponte para o código de barras ou QR Code');
  _scanActive = true;
  _scanTimer = setInterval(_processFrame, 350);
}

// ── PROCESSAMENTO DE FRAME ────────────────────────────────────────
// Alterna entre duas visões do mesmo frame:
//  0) frame inteiro (códigos próximos / grandes)
//  1) centro recortado e ampliado 2x — ZOOM DIGITAL
//     (códigos pequenos ou distantes ficam com o dobro de pixels,
//      exatamente o que faltava para ler a etiqueta de patrimônio)
const _workCanvas = document.createElement('canvas');
const _workCtx    = _workCanvas.getContext('2d', { willReadFrequently: true });

async function _processFrame() {
  if (!_scanActive || _busy || _detected) return;
  if (!_video || _video.readyState < 2 || !_video.videoWidth) return;

  _busy = true;
  try {
    const vw = _video.videoWidth, vh = _video.videoHeight;
    const outW = 1280;
    const mode = _frameToggle;
    _frameToggle = (_frameToggle + 1) % 2;

    if (mode === 0) {
      // Frame inteiro, redimensionado para 1280 de largura
      const outH = Math.round(vh * (outW / vw));
      _workCanvas.width = outW; _workCanvas.height = outH;
      _workCtx.drawImage(_video, 0, 0, vw, vh, 0, 0, outW, outH);
    } else {
      // Zoom digital 2x: recorta o centro (55% x 45%) e amplia
      const cw = Math.round(vw * 0.55), ch = Math.round(vh * 0.45);
      const cx = Math.round((vw - cw) / 2), cy = Math.round((vh - ch) / 2);
      const outH = Math.round(ch * (outW / cw));
      _workCanvas.width = outW; _workCanvas.height = outH;
      _workCtx.imageSmoothingEnabled = true;
      _workCtx.imageSmoothingQuality = 'high';
      _workCtx.drawImage(_video, cx, cy, cw, ch, 0, 0, outW, outH);
    }

    // 1) Tenta QR Code (jsQR) — rápido, direto no ImageData
    try {
      const imgData = _workCtx.getImageData(0, 0, _workCanvas.width, _workCanvas.height);
      const qr = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
      if (qr && qr.data) {
        _registerVote(qr.data.trim(), 'qr_code', 0);
        _busy = false;
        return;
      }
    } catch(_) {}

    // 2) Tenta código de barras (Quagga.decodeSingle no canvas)
    const dataUrl = _workCanvas.toDataURL('image/jpeg', 0.75);
    await new Promise(resolve => {
      Quagga.decodeSingle({
        src: dataUrl,
        numOfWorkers: 0,
        locate: true,
        inputStream: { size: 1280 },
        locator: { patchSize: 'medium', halfSample: false },
        decoder: {
          readers: [
            'code_128_reader', 'ean_reader', 'ean_8_reader',
            'code_39_reader', 'upc_reader', 'upc_e_reader', 'i2of5_reader'
          ],
          multiple: false
        }
      }, (result) => {
        const code   = result?.codeResult?.code;
        const format = result?.codeResult?.format;
        if (code) {
          const avgErr = _avgError(result);
          if (avgErr <= REJECT_ERROR_MIN) {
            _registerVote(code.trim(), format, avgErr);
          }
        }
        resolve();
      });
    });
  } catch(_) { /* frame com problema, segue o loop */ }
  _busy = false;
}

function _avgError(result) {
  const codes = result?.codeResult?.decodedCodes;
  if (!Array.isArray(codes)) return 0;
  const errs = codes.map(c => c.error).filter(e => typeof e === 'number');
  if (!errs.length) return 0;
  return errs.reduce((a, b) => a + b, 0) / errs.length;
}

// ── CHECKSUM ──────────────────────────────────────────────────────
function _isValidEAN13(str) {
  if (!/^\d{13}$/.test(str)) return false;
  const d = str.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  d.forEach((n, i) => { sum += n * (i % 2 === 0 ? 1 : 3); });
  return ((10 - (sum % 10)) % 10) === check;
}
function _isValidEAN8(str) {
  if (!/^\d{8}$/.test(str)) return false;
  const d = str.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  d.forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return ((10 - (sum % 10)) % 10) === check;
}
function _isValidUPCA(str) {
  if (!/^\d{12}$/.test(str)) return false;
  return _isValidEAN13('0' + str);
}
function _passesChecksum(value, format) {
  switch (format) {
    case 'ean_13': return _isValidEAN13(value);
    case 'ean_8':  return _isValidEAN8(value);
    case 'upc_a':  return _isValidUPCA(value);
    case 'upc_e':  return value.length >= 6;
    default:       return value.length >= 3;
  }
}

// ── VOTAÇÃO ADAPTATIVA ────────────────────────────────────────────
// 3 leituras idênticas confirmam. Se a qualidade for excelente
// (erro médio < 6%), 2 leituras bastam — acelera em boas condições
// sem abrir mão da segurança em condições ruins.
function _registerVote(value, format, avgErr) {
  if (_detected || !value) return;
  if (!_passesChecksum(value, format)) return;

  const now = Date.now();
  if (value !== _lastValue || (now - _lastVoteTime) > CONFIRM_WINDOW_MS) {
    _lastValue  = value;
    _voteCount  = 1;
    _lastAvgErr = avgErr;
  } else {
    _voteCount++;
    _lastAvgErr = Math.min(_lastAvgErr, avgErr);
  }
  _lastVoteTime = now;

  const needed = (_lastAvgErr <= FAST_ERROR_MAX) ? CONFIRM_FAST : CONFIRM_NEEDED;
  _setHint(`Confirmando código... (${Math.min(_voteCount, needed)}/${needed})`);
  _pulseFrame();

  if (_voteCount >= needed) _onDetected(_lastValue);
}

function _pulseFrame() {
  const frame = document.querySelector('.scanner-frame');
  if (!frame) return;
  frame.style.borderColor = 'rgba(34,197,94,.6)';
  setTimeout(() => { frame.style.borderColor = ''; }, 150);
}

function _onDetected(value) {
  if (_detected) return;
  _detected = true;
  closeScanner();

  const field = document.getElementById(_targetField);
  if (field) {
    field.value = value;
    field.focus();
    field.style.borderColor = '#059669';
    field.style.boxShadow   = '0 0 0 3px rgba(5,150,105,.2)';
    setTimeout(() => { field.style.borderColor = ''; field.style.boxShadow = ''; }, 2500);
  }
  _toast('✅ Lido: ' + value);
}

// ── FECHAR ────────────────────────────────────────────────────────
function closeScanner() {
  _scanActive = false;
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  if (_stream)    { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_video)     { _video.srcObject = null; _video = null; }
  const container = document.getElementById('scanner-qr-container');
  if (container) container.innerHTML = '';
  document.getElementById('scanner-modal')?.classList.remove('open');
  _lastValue = null;
  _voteCount = 0;
  _busy = false;
}

function _setHint(txt) {
  const el = document.getElementById('scanner-hint-text');
  if (el) el.textContent = txt;
}

function _toast(msg) {
  let t = document.getElementById('scan-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'scan-toast';
    t.style.cssText = 'position:fixed;bottom:calc(24px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:#166534;color:#dcfce7;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:900;max-width:90vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.3);opacity:0;transition:opacity .2s;pointer-events:none';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── INJEÇÃO DO BOTÃO ──────────────────────────────────────────────
const _origRenderForm = window.renderForm;
window.renderForm = function () {
  _origRenderForm?.apply(this, arguments);
  requestAnimationFrame(_injectScanButton);
};

function _injectScanButton() {
  const field = document.getElementById('f_serie');
  if (!field || field.dataset.scanInjected) return;
  field.dataset.scanInjected = '1';

  const wrap = document.createElement('div');
  wrap.className = 'scan-btn-wrap';
  field.parentNode.insertBefore(wrap, field);
  wrap.appendChild(field);

  const btn     = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'scan-btn';
  btn.title     = 'Ler código de barras ou QR Code';
  btn.innerHTML = '<i class="ti ti-scan"></i>';
  btn.onclick   = () => openScanner('f_serie');
  wrap.appendChild(btn);

  const hint     = document.createElement('div');
  hint.className = 'scan-hint';
  hint.innerHTML = '📷 Toque para ler <strong>código de barras</strong> ou <strong>QR Code</strong>';
  wrap.parentNode.insertBefore(hint, wrap.nextSibling);
}

// Pré-carrega as bibliotecas em background
setTimeout(() => { _loadLibs().catch(()=>{}); }, 1200);