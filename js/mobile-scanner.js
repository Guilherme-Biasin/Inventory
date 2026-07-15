// ─── mobile-scanner.js ───────────────────────────────────────────
// QR Code + Código de Barras — funciona em iOS Safari e Android
// Quagga2 (código de barras 1D) + jsQR (QR Code)
// Ambos são JS puro, sem depender de BarcodeDetector/WASM experimental
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
//  SCANNER — Quagga2 (barcodes) + jsQR (QR Code) em paralelo
//  Sistema de confirmação: só aceita após ler o MESMO código
//  repetidamente, evitando falsos positivos de leitura rápida
// ─────────────────────────────────────────────────────────────────
let _targetField   = 'f_serie';
let _quaggaRunning = false;
let _qrInterval    = null;
let _libsLoaded    = false;
let _detected      = false;

// Confirmação por votos consecutivos
const CONFIRM_NEEDED = 3;      // precisa ler o mesmo valor 3x seguidas
const CONFIRM_WINDOW_MS = 2500; // reseta se demorar mais que isso entre leituras
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
  _detected = false;
  _lastValue = null;
  _voteCount = 0;
  _lastVoteTime = 0;

  _setHint('Carregando leitor...');
  document.getElementById('scanner-modal').classList.add('open');

  try {
    await _loadLibs();
  } catch(e) {
    closeScanner();
    alert('📷 Erro ao carregar o leitor. Verifique sua conexão e tente novamente.');
    return;
  }

  const container = document.getElementById('scanner-qr-container');
  container.innerHTML = ''; // limpa scans anteriores

  _setHint('Inicializando câmera...');

  Quagga.init({
    inputStream: {
      name: 'Live',
      type: 'LiveStream',
      target: container,
      constraints: {
        facingMode: 'environment',
        width:  { min: 640, ideal: 1280 },
        height: { min: 480, ideal: 720 }
      },
      area: { top: '30%', right: '15%', left: '15%', bottom: '30%' }
    },
    locator: { patchSize: 'medium', halfSample: true },
    numOfWorkers: navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2,
    frequency: 8,
    decoder: {
      readers: [
        'code_128_reader', 'ean_reader', 'ean_8_reader',
        'code_39_reader', 'code_39_vin_reader', 'codabar_reader',
        'upc_reader', 'upc_e_reader', 'i2of5_reader', 'code_93_reader'
      ],
      multiple: false
    },
    locate: true
  }, (err) => {
    if (err) {
      console.error('[Quagga] init error:', err);
      closeScanner();
      let msg = '📷 Não foi possível acessar a câmera.';
      if (err.name === 'NotAllowedError' || String(err).includes('Permission'))
        msg = '📷 Permissão de câmera negada.\n\niOS: Configurações → Safari → Câmera → Permitir\nAndroid: Toque nos 3 pontos → Configurações → Permissões';
      else if (err.name === 'NotFoundError')
        msg = '📷 Câmera não encontrada.';
      alert(msg);
      return;
    }
    Quagga.start();
    _quaggaRunning = true;
    _setHint('Aponte para o código de barras ou QR Code');

    // Estiliza o vídeo/canvas que o Quagga injeta para preencher o modal
    _styleQuaggaVideo();

    // Inicia leitura paralela de QR Code via jsQR
    _startQrLoop(container);
  });

  Quagga.onDetected(_onBarcodeDetected);
}

function _styleQuaggaVideo() {
  const container = document.getElementById('scanner-qr-container');
  const video  = container.querySelector('video');
  const canvas = container.querySelector('canvas');
  [video, canvas].forEach(el => {
    if (!el) return;
    el.style.width    = '100%';
    el.style.height   = '100%';
    el.style.objectFit = 'cover';
    el.style.position = 'absolute';
    el.style.top = '0'; el.style.left = '0';
  });
}

function _onBarcodeDetected(result) {
  if (_detected) return;
  const code = result?.codeResult?.code;
  if (code) _registerVote(code.trim());
}

// ── QR CODE via jsQR ──────────────────────────────────────────────
function _startQrLoop(container) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });

  _qrInterval = setInterval(() => {
    if (_detected) return;
    const video = container.querySelector('video');
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth'
      });
      if (result && result.data) {
        _registerVote(result.data.trim());
      }
    } catch(_) { /* ignora frame inválido */ }
  }, 300);
}

// ── SISTEMA DE CONFIRMAÇÃO POR VOTOS ─────────────────────────────
// Só aceita um código depois de lê-lo IDENTICAMENTE várias vezes
// seguidas — evita aceitar leituras corrompidas/parciais.
function _registerVote(value) {
  if (_detected || !value) return;

  const now = Date.now();

  // Se demorou muito desde o último voto, ou o valor mudou, reseta contagem
  if (value !== _lastValue || (now - _lastVoteTime) > CONFIRM_WINDOW_MS) {
    _lastValue = value;
    _voteCount = 1;
  } else {
    _voteCount++;
  }
  _lastVoteTime = now;

  // Feedback visual de progresso
  _setHint(`Confirmando código... (${_voteCount}/${CONFIRM_NEEDED})`);
  _pulseFrame();

  if (_voteCount >= CONFIRM_NEEDED) {
    _onDetected(_lastValue);
  }
}

// Pisca a moldura verde brevemente a cada voto confirmado, dando feedback tátil visual
function _pulseFrame() {
  const frame = document.querySelector('.scanner-frame');
  if (!frame) return;
  frame.style.borderColor = 'rgba(34,197,94,.6)';
  setTimeout(() => { frame.style.borderColor = ''; }, 150);
}

function _onDetected(value) {
  if (_detected) return;
  _detected = true;
  _setHint('✅ Código confirmado!');
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
  if (_qrInterval) { clearInterval(_qrInterval); _qrInterval = null; }
  if (_quaggaRunning && window.Quagga) {
    try { Quagga.stop(); } catch(_) {}
    _quaggaRunning = false;
  }
  const container = document.getElementById('scanner-qr-container');
  if (container) container.innerHTML = '';
  document.getElementById('scanner-modal')?.classList.remove('open');
  _lastValue = null;
  _voteCount = 0;
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