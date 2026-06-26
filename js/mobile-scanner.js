// ─── mobile-scanner.js ───────────────────────────────────────────
// Leitor de código de barras + QR Code (iOS Safari + Android)
// Usa ZXing como fallback quando BarcodeDetector não está disponível
// ─────────────────────────────────────────────────────────────────

// ── SIDEBAR MOBILE ────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const open = sb.classList.toggle('open');
  ov.classList.toggle('open', open);
}
function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => { if (window.innerWidth <= 768) closeSidebar(); });
});

// ── DARK MODE: sincroniza ícone mobile ────────────────────────────
const _origToggleDark = window.toggleDark;
window.toggleDark = function () {
  _origToggleDark();
  syncMobileDarkIcon();
};
function syncMobileDarkIcon() {
  const icon = document.getElementById('mobile-dark-icon');
  if (!icon) return;
  icon.className = document.documentElement.classList.contains('dark') ? 'ti ti-sun' : 'ti ti-moon';
}
syncMobileDarkIcon();

// ── SCANNER: estado global ────────────────────────────────────────
let _scanStream       = null;
let _scanAnimFrame    = null;
let _nativeDetector   = null;   // BarcodeDetector (Android/Chrome)
let _zxingReader      = null;   // ZXing (iOS/Safari fallback)
let _targetFieldId    = 'f_serie';
let _scanMode         = 'both'; // 'both' | 'barcode' | 'qr'
let _useZXing         = false;
let _scannerReady     = false;

// Formatos separados por tipo (para UI)
const BARCODE_FORMATS = ['code_128','code_39','code_93','codabar','ean_13','ean_8','upc_a','upc_e','itf','data_matrix','pdf417'];
const QR_FORMATS      = ['qr_code','aztec'];
const ALL_FORMATS     = [...BARCODE_FORMATS, ...QR_FORMATS];

// ── CARREGAR ZXing dinamicamente ─────────────────────────────────
function _loadZXing() {
  return new Promise((resolve, reject) => {
    if (window.ZXing) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js';
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── DETECTAR SUPORTE ─────────────────────────────────────────────
async function _detectSupport() {
  // iOS Safari: nunca tem BarcodeDetector, usa ZXing
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIOS || !('BarcodeDetector' in window)) {
    _useZXing = true;
  } else {
    _useZXing = false;
  }
}

// ── ABRIR SCANNER ────────────────────────────────────────────────
async function openScanner(fieldId, mode) {
  _targetFieldId = fieldId || 'f_serie';
  _scanMode      = mode    || 'both';

  await _detectSupport();

  // Atualiza label do modal conforme modo
  _updateScannerLabel();

  // Botões de modo ativos
  document.querySelectorAll('.scan-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === _scanMode);
  });

  const modal = document.getElementById('scanner-modal');

  try {
    // Pede permissão de câmera — funciona no iOS com estas constraints
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    };
    _scanStream = await navigator.mediaDevices.getUserMedia(constraints);

    const video = document.getElementById('scanner-video');
    video.srcObject = _scanStream;

    // iOS precisa do evento 'loadedmetadata' antes de detectar
    await new Promise(res => {
      if (video.readyState >= 2) { res(); return; }
      video.addEventListener('loadedmetadata', res, { once: true });
    });

    modal.classList.add('open');

    if (_useZXing) {
      await _startZXing(video);
    } else {
      await _startNative(video);
    }

  } catch (err) {
    console.error('Scanner error:', err);
    modal.classList.remove('open');
    _stopScanner();

    let msg = '📷 Não foi possível acessar a câmera.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      msg = '📷 Permissão de câmera negada.\n\niOS: Configurações → Safari → Câmera → Permitir\nAndroid: Configurações do navegador → Permissões → Câmera';
    else if (err.name === 'NotFoundError')
      msg = '📷 Câmera não encontrada neste dispositivo.';
    else if (err.name === 'NotReadableError')
      msg = '📷 A câmera está sendo usada por outro aplicativo.';

    alert(msg);
  }
}

// ── NATIVE BarcodeDetector (Chrome/Android) ───────────────────────
async function _startNative(video) {
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    let formats = [];
    if (_scanMode === 'barcode') formats = BARCODE_FORMATS.filter(f => supported.includes(f));
    else if (_scanMode === 'qr') formats = QR_FORMATS.filter(f => supported.includes(f));
    else formats = ALL_FORMATS.filter(f => supported.includes(f));
    if (!formats.length) formats = supported;

    _nativeDetector = new BarcodeDetector({ formats });
    _scannerReady   = true;
    _nativeLoop(video);
  } catch (e) {
    // Fallback para ZXing se BarcodeDetector falhar
    console.warn('BarcodeDetector failed, falling back to ZXing', e);
    _useZXing = true;
    await _startZXing(video);
  }
}

function _nativeLoop(video) {
  let lastDetect = 0;
  async function loop() {
    if (!_nativeDetector || !_scanStream) return;
    const now = Date.now();
    if (now - lastDetect > 250 && video.readyState >= 2) {
      try {
        const codes = await _nativeDetector.detect(video);
        if (codes.length && codes[0].rawValue) {
          _applyScannedValue(codes[0].rawValue.trim(), codes[0].format);
          return;
        }
      } catch (_) {}
    }
    lastDetect = now;
    _scanAnimFrame = requestAnimationFrame(loop);
  }
  _scanAnimFrame = requestAnimationFrame(loop);
}

// ── ZXing (iOS Safari + fallback universal) ───────────────────────
async function _startZXing(video) {
  try {
    await _loadZXing();
    const hints = new Map();

    // Formatos ZXing conforme modo
    const ZF = window.ZXing.BarcodeFormat;
    let fmts = [];
    if (_scanMode === 'barcode' || _scanMode === 'both') {
      fmts.push(ZF.CODE_128, ZF.CODE_39, ZF.CODE_93, ZF.EAN_13, ZF.EAN_8,
                ZF.UPC_A, ZF.UPC_E, ZF.ITF, ZF.CODABAR, ZF.PDF_417, ZF.DATA_MATRIX);
    }
    if (_scanMode === 'qr' || _scanMode === 'both') {
      fmts.push(ZF.QR_CODE, ZF.AZTEC);
    }
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, fmts);
    hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);

    _zxingReader = new window.ZXing.MultiFormatReader();
    _zxingReader.setHints(hints);

    _scannerReady = true;
    _zxingLoop(video);
  } catch (e) {
    console.error('ZXing load error:', e);
    alert('Erro ao carregar leitor de código. Verifique sua conexão.');
    closeScanner();
  }
}

function _zxingLoop(video) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  function loop() {
    if (!_zxingReader || !_scanStream) return;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const luminance = new window.ZXing.RGBLuminanceSource(imageData.data, canvas.width, canvas.height);
        const binary    = new window.ZXing.HybridBinarizer(luminance);
        const bmp       = new window.ZXing.BinaryBitmap(binary);
        const result    = _zxingReader.decode(bmp);
        if (result && result.getText()) {
          _applyScannedValue(result.getText().trim(), result.getBarcodeFormat());
          return;
        }
      } catch (_) { /* NotFoundException é normal — continua loop */ }
    }
    _scanAnimFrame = requestAnimationFrame(loop);
  }
  _scanAnimFrame = requestAnimationFrame(loop);
}

// ── APLICAR VALOR LIDO ────────────────────────────────────────────
function _applyScannedValue(value, format) {
  closeScanner();
  const field = document.getElementById(_targetFieldId);
  if (!field) return;

  field.value = value;
  field.focus();
  field.style.borderColor = '#059669';
  field.style.boxShadow   = '0 0 0 3px rgba(5,150,105,.2)';
  setTimeout(() => { field.style.borderColor = ''; field.style.boxShadow = ''; }, 2500);

  // Toast de confirmação
  _showScanToast('✅ Lido: ' + value);
}

function _showScanToast(msg) {
  let t = document.getElementById('scan-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'scan-toast';
    t.style.cssText = `
      position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;
      transform:translateX(-50%);background:#1a1a1a;color:#fff;
      padding:10px 18px;border-radius:10px;font-size:13px;font-weight:500;
      z-index:800;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.3);
      opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw;
      overflow:hidden;text-overflow:ellipsis;`;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── PARAR SCANNER ─────────────────────────────────────────────────
function _stopScanner() {
  if (_scanAnimFrame) { cancelAnimationFrame(_scanAnimFrame); _scanAnimFrame = null; }
  if (_scanStream)    { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  _nativeDetector = null;
  _zxingReader    = null;
  _scannerReady   = false;
}

function closeScanner() {
  _stopScanner();
  document.getElementById('scanner-modal').classList.remove('open');
}

// ── MUDAR MODO (barcode/qr/both) ─────────────────────────────────
function setScanMode(mode) {
  _scanMode = mode;
  _updateScannerLabel();
  document.querySelectorAll('.scan-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  // Reinicia detector com novos formatos
  if (_scanStream) {
    const video = document.getElementById('scanner-video');
    if (_useZXing) {
      if (_zxingReader) { _stopZXingOnly(); _startZXing(video); }
    } else {
      if (_nativeDetector) { _stopNativeOnly(); _startNative(video); }
    }
  }
}

function _stopZXingOnly() {
  if (_scanAnimFrame) { cancelAnimationFrame(_scanAnimFrame); _scanAnimFrame = null; }
  _zxingReader = null;
}
function _stopNativeOnly() {
  if (_scanAnimFrame) { cancelAnimationFrame(_scanAnimFrame); _scanAnimFrame = null; }
  _nativeDetector = null;
}

function _updateScannerLabel() {
  const el = document.getElementById('scanner-label-text');
  if (!el) return;
  const labels = { barcode: '📊 Código de Barras', qr: '⬛ QR Code', both: '📷 Código de Barras ou QR Code' };
  el.textContent = labels[_scanMode] || labels.both;
}

// ── PATCH: injeta botão de scan no campo N° de Série ─────────────
const _origRenderForm = window.renderForm;
window.renderForm = function () {
  _origRenderForm.apply(this, arguments);
  _injectScanButton();
};

function _injectScanButton() {
  const field = document.getElementById('f_serie');
  if (!field || field.dataset.scanInjected) return;
  field.dataset.scanInjected = '1';

  const wrap = document.createElement('div');
  wrap.className = 'scan-btn-wrap';
  field.parentNode.insertBefore(wrap, field);
  wrap.appendChild(field);

  // Botão único — abre sempre no modo "both"
  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'scan-btn';
  btn.title     = 'Ler código de barras ou QR Code';
  btn.innerHTML = '<i class="ti ti-scan"></i>';
  btn.onclick   = () => openScanner('f_serie', 'both');
  wrap.appendChild(btn);

  const hint = document.createElement('div');
  hint.className   = 'scan-hint';
  hint.innerHTML   = '📷 Toque para ler <strong>código de barras</strong> ou <strong>QR Code</strong>';
  wrap.parentNode.insertBefore(hint, wrap.nextSibling);
}
