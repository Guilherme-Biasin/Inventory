// ─── mobile-scanner.js ───────────────────────────────────────────
// QR Code + Código de Barras — v5
//  • Android/Chrome: BarcodeDetector NATIVA (mesma engine da câmera
//    nativa — leitura instantânea de barcode e QR)
//  • iOS/Safari: ZXing MultiFormatReader direto no canvas (sem
//    conversão JPEG) + jsQR de reforço para QR Code
//  • Alterna frame inteiro ↔ zoom digital 2x (códigos distantes)
//  • Confirmação: 2 leituras idênticas + checksum matemático
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
//  SCANNER v5
// ─────────────────────────────────────────────────────────────────
let _stream      = null;
let _video       = null;
let _rafId       = null;
let _busy        = false;
let _detected    = false;
let _scanActive  = false;
let _frameToggle = 0;
let _targetField = 'f_serie';

// Engine de decodificação
let _engine        = null;   // 'native' | 'zxing'
let _nativeDet     = null;   // BarcodeDetector nativa
let _zxReader      = null;   // ZXing MultiFormatReader
let _zxingLoaded   = false;
let _jsqrLoaded    = false;

// Confirmação: 2 leituras idênticas (engines nativas/ZXing são precisas)
const CONFIRM_NEEDED    = 2;
const CONFIRM_WINDOW_MS = 6000;
let _lastValue    = null;
let _voteCount    = 0;
let _lastVoteTime = 0;

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

// ── INICIALIZAÇÃO DA ENGINE ───────────────────────────────────────
async function _initEngine() {
  if (_engine) return;

  // 1) BarcodeDetector nativa (Android Chrome, Samsung Internet)
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported && supported.length) {
        _nativeDet = new window.BarcodeDetector({ formats: supported });
        _engine = 'native';
        console.log('[Scanner] Engine: BarcodeDetector nativa —', supported.join(','));
        return;
      }
    } catch(_) { /* cai para ZXing */ }
  }

  // 2) ZXing (iOS Safari e navegadores sem BarcodeDetector)
  if (!_zxingLoaded) {
    await _loadScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
    _zxingLoaded = true;
  }
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.QR_CODE,
    Z.BarcodeFormat.EAN_13,  Z.BarcodeFormat.EAN_8,
    Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39,
    Z.BarcodeFormat.UPC_A,   Z.BarcodeFormat.UPC_E,
    Z.BarcodeFormat.ITF,     Z.BarcodeFormat.DATA_MATRIX
  ]);
  _zxReader = new Z.MultiFormatReader();
  _zxReader.setHints(hints);
  _engine = 'zxing';
  console.log('[Scanner] Engine: ZXing (canvas direto)');

  // jsQR como reforço para QR difíceis no iOS
  if (!_jsqrLoaded) {
    _loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js')
      .then(() => { _jsqrLoaded = true; }).catch(()=>{});
  }
}

// Converte enum de formato do ZXing para string padrão
function _zxFormatName(fmt) {
  const Z = window.ZXing;
  if (!Z) return '';
  switch (fmt) {
    case Z.BarcodeFormat.EAN_13:  return 'ean_13';
    case Z.BarcodeFormat.EAN_8:   return 'ean_8';
    case Z.BarcodeFormat.UPC_A:   return 'upc_a';
    case Z.BarcodeFormat.UPC_E:   return 'upc_e';
    case Z.BarcodeFormat.QR_CODE: return 'qr_code';
    default: return 'other';
  }
}

// ── ABRIR SCANNER ────────────────────────────────────────────────
async function openScanner(fieldId) {
  _targetField = fieldId || 'f_serie';
  _detected = false;
  _lastValue = null;
  _voteCount = 0;
  _lastVoteTime = 0;
  _frameToggle = 0;

  _setHint('Carregando leitor...');
  document.getElementById('scanner-modal').classList.add('open');

  try {
    await _initEngine();
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

  // Trava zoom óptico em 1x (evita lente ultra-wide)
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
  _scanLoop();
}

// ── LOOP DE PROCESSAMENTO ─────────────────────────────────────────
// requestAnimationFrame + throttle: processa um frame assim que o
// anterior termina (engine nativa é tão rápida que roda quase em
// tempo real; ZXing roda a ~4-6 fps sem travar a UI)
const _workCanvas = document.createElement('canvas');
const _workCtx    = _workCanvas.getContext('2d', { willReadFrequently: true });
let _lastProcess  = 0;

function _scanLoop() {
  if (!_scanActive) return;
  _rafId = requestAnimationFrame(_scanLoop);

  const now = performance.now();
  const minGap = _engine === 'native' ? 120 : 200;
  if (_busy || _detected || (now - _lastProcess) < minGap) return;
  if (!_video || _video.readyState < 2 || !_video.videoWidth) return;

  _lastProcess = now;
  _processFrame();
}

async function _processFrame() {
  _busy = true;
  try {
    const vw = _video.videoWidth, vh = _video.videoHeight;
    const mode = _frameToggle;
    _frameToggle = (_frameToggle + 1) % 2;

    // Resolução de trabalho: nativa aguenta full-res; ZXing usa 1100px
    const outW = _engine === 'native' ? Math.min(vw, 1920) : 1100;

    if (mode === 0) {
      // Frame inteiro
      const outH = Math.round(vh * (outW / vw));
      _workCanvas.width = outW; _workCanvas.height = outH;
      _workCtx.drawImage(_video, 0, 0, vw, vh, 0, 0, outW, outH);
    } else {
      // Zoom digital 2x — centro 55% x 45% ampliado
      const cw = Math.round(vw * 0.55), ch = Math.round(vh * 0.45);
      const cx = Math.round((vw - cw) / 2), cy = Math.round((vh - ch) / 2);
      const outH = Math.round(ch * (outW / cw));
      _workCanvas.width = outW; _workCanvas.height = outH;
      _workCtx.imageSmoothingEnabled = true;
      _workCtx.imageSmoothingQuality = 'high';
      _workCtx.drawImage(_video, cx, cy, cw, ch, 0, 0, outW, outH);
    }

    if (_engine === 'native') {
      // ── BarcodeDetector nativa: barcode + QR em uma chamada
      const codes = await _nativeDet.detect(_workCanvas);
      if (codes.length && codes[0].rawValue) {
        _registerVote(codes[0].rawValue.trim(), codes[0].format || 'other');
      }
    } else {
      // ── ZXing direto no canvas (sem JPEG)
      const Z = window.ZXing;
      try {
        const lum    = new Z.HTMLCanvasElementLuminanceSource(_workCanvas);
        const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(lum));
        const result = _zxReader.decode(bitmap);
        if (result) {
          _registerVote(result.getText().trim(), _zxFormatName(result.getBarcodeFormat()));
          _zxReader.reset();
          _busy = false;
          return;
        }
      } catch(_) { /* NotFoundException — normal */ }
      _zxReader.reset();

      // Reforço p/ QR difíceis: jsQR com inversão, só no frame inteiro
      if (mode === 0 && _jsqrLoaded && window.jsQR) {
        try {
          const img = _workCtx.getImageData(0, 0, _workCanvas.width, _workCanvas.height);
          const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (qr && qr.data) _registerVote(qr.data.trim(), 'qr_code');
        } catch(_) {}
      }
    }
  } catch(_) { /* frame ruim, segue */ }
  _busy = false;
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

// ── CONFIRMAÇÃO (2 leituras idênticas) ────────────────────────────
function _registerVote(value, format) {
  if (_detected || !value) return;
  if (!_passesChecksum(value, format)) return;

  const now = Date.now();
  if (value !== _lastValue || (now - _lastVoteTime) > CONFIRM_WINDOW_MS) {
    _lastValue = value;
    _voteCount = 1;
  } else {
    _voteCount++;
  }
  _lastVoteTime = now;

  _setHint(`Confirmando código... (${Math.min(_voteCount, CONFIRM_NEEDED)}/${CONFIRM_NEEDED})`);
  _pulseFrame();

  if (_voteCount >= CONFIRM_NEEDED) _onDetected(_lastValue);
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
  if (_rafId)  { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_video)  { _video.srcObject = null; _video = null; }
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

// Pré-carrega a engine em background (ZXing/jsQR só baixam se necessário)
setTimeout(() => { _initEngine().catch(()=>{}); }, 1200);