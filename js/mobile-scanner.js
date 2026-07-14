// ─── mobile-scanner.js ───────────────────────────────────────────
// Scanner QR Code + Código de Barras
// iOS Safari: ZBar WASM via barcode-detector-polyfill
// Android Chrome: BarcodeDetector nativa
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

// ── DARK MODE: sincroniza ícone mobile ────────────────────────────
const _origToggleDark = window.toggleDark;
window.toggleDark = function () {
  _origToggleDark?.();
  _syncDarkIcon();
};
function _syncDarkIcon() {
  const icon = document.getElementById('mobile-dark-icon');
  if (!icon) return;
  icon.className = document.documentElement.classList.contains('dark') ? 'ti ti-sun' : 'ti ti-moon';
}
_syncDarkIcon();

// ─────────────────────────────────────────────────────────────────
//  SCANNER — usa BarcodeDetector (nativo Android) ou polyfill ZBar
//  WASM para iOS Safari onde BarcodeDetector não existe
// ─────────────────────────────────────────────────────────────────
let _stream       = null;
let _scanFrame    = null;
let _detector     = null;
let _scanActive   = false;
let _targetField  = 'f_serie';

// Carrega o polyfill ZBar WASM apenas quando necessário
async function _ensureBarcodeDetector() {
  if (_detector) return; // já inicializado

  // Android/Chrome: BarcodeDetector nativa
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      _detector = new window.BarcodeDetector({ formats: supported });
      console.log('[Scanner] Usando BarcodeDetector nativo');
      return;
    } catch(e) {
      console.warn('[Scanner] BarcodeDetector nativo falhou, usando polyfill');
    }
  }

  // iOS Safari: carrega polyfill ZBar WASM
  console.log('[Scanner] iOS detectado, carregando ZBar WASM polyfill...');
  await _loadScript('https://cdn.jsdelivr.net/npm/@undecaf/zbar-wasm@0.11.0/dist/index.js');
  await _loadScript('https://cdn.jsdelivr.net/npm/@undecaf/barcode-detector-polyfill@0.9.23/dist/index.js');

  // Substitui BarcodeDetector global pelo polyfill
  if (window.barcodeDetectorPolyfill?.BarcodeDetectorPolyfill) {
    window.BarcodeDetector = window.barcodeDetectorPolyfill.BarcodeDetectorPolyfill;
    _detector = new window.BarcodeDetector({ formats: [
      'qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8',
      'upc_a', 'upc_e', 'itf', 'codabar', 'databar', 'isbn_10', 'isbn_13'
    ]});
    console.log('[Scanner] ZBar WASM polyfill carregado');
  } else {
    throw new Error('Não foi possível carregar o leitor de código de barras.');
  }
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error('Falha ao carregar: ' + src));
    document.head.appendChild(s);
  });
}

// ── ABRIR SCANNER ────────────────────────────────────────────────
async function openScanner(fieldId) {
  _targetField = fieldId || 'f_serie';
  const modal  = document.getElementById('scanner-modal');

  // Mostra feedback de carregamento
  const hint = document.getElementById('scanner-hint-text');
  if (hint) hint.textContent = 'Inicializando câmera...';
  modal.classList.add('open');

  try {
    // 1. Garante que o detector está pronto (carrega polyfill se preciso)
    await _ensureBarcodeDetector();

    // 2. Pede câmera traseira
    _stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:      { ideal: 1280 },
        height:     { ideal: 720 },
      }
    });

    // 3. Conecta vídeo
    const video = document.getElementById('scanner-video');
    video.srcObject = _stream;
    await video.play();

    if (hint) hint.textContent = 'Aponte para o código de barras ou QR Code';

    // 4. Inicia loop de detecção
    _scanActive = true;
    _scanLoop(video);

  } catch(err) {
    modal.classList.remove('open');
    _stopScanner();
    let msg = '📷 Não foi possível acessar a câmera.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      msg = '📷 Permissão de câmera negada.\n\niOS: Configurações → Safari → Câmera → Permitir\nAndroid: Configurações do navegador → Permissões → Câmera';
    else if (err.name === 'NotFoundError')
      msg = '📷 Câmera não encontrada neste dispositivo.';
    else if (err.message)
      msg = '📷 ' + err.message;
    alert(msg);
  }
}

// ── LOOP DE DETECÇÃO ─────────────────────────────────────────────
// Captura frame a cada 200ms, passa para BarcodeDetector
// Também tenta com rotação +30° e -30° para barcodes inclinados
async function _scanLoop(video) {
  if (!_scanActive || !_detector) return;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (!_scanActive) return;

    if (video.readyState >= 2 && video.videoWidth > 0) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;

      // Rotações para pegar barcodes inclinados (técnica do ZBar WASM)
      const angles = [0, 30, -30];
      for (const angle of angles) {
        if (!_scanActive) return;
        try {
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(angle * Math.PI / 180);
          ctx.drawImage(video, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
          ctx.restore();

          const codes = await _detector.detect(canvas);
          if (codes.length && codes[0].rawValue) {
            _onDetected(codes[0].rawValue.trim());
            return; // para o loop
          }
        } catch(_) { /* continua */ }
      }
    }

    _scanFrame = setTimeout(tick, 200);
  };

  _scanFrame = setTimeout(tick, 100);
}

function _onDetected(value) {
  _stopScanner();
  document.getElementById('scanner-modal').classList.remove('open');

  const field = document.getElementById(_targetField);
  if (field) {
    field.value = value;
    field.focus();
    field.style.borderColor = '#059669';
    field.style.boxShadow   = '0 0 0 3px rgba(5,150,105,.2)';
    setTimeout(() => { field.style.borderColor = ''; field.style.boxShadow = ''; }, 2500);
  }
  _showScanToast('✅ Lido: ' + value);
}

// ── FECHAR / PARAR ────────────────────────────────────────────────
function closeScanner() {
  _stopScanner();
  document.getElementById('scanner-modal').classList.remove('open');
}

function _stopScanner() {
  _scanActive = false;
  if (_scanFrame) { clearTimeout(_scanFrame); _scanFrame = null; }
  if (_stream)    { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  const video = document.getElementById('scanner-video');
  if (video) { video.srcObject = null; }
}

// ── TOAST ─────────────────────────────────────────────────────────
function _showScanToast(msg) {
  let t = document.getElementById('scan-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'scan-toast';
    t.style.cssText = [
      'position:fixed', 'bottom:calc(24px + env(safe-area-inset-bottom))',
      'left:50%', 'transform:translateX(-50%)',
      'background:#166534', 'color:#dcfce7',
      'padding:10px 18px', 'border-radius:10px', 'font-size:13px',
      'font-weight:600', 'z-index:900', 'max-width:90vw',
      'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
      'box-shadow:0 4px 20px rgba(0,0,0,.3)',
      'opacity:0', 'transition:opacity .2s', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── INJEÇÃO DO BOTÃO DE SCAN ──────────────────────────────────────
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

  const btn       = document.createElement('button');
  btn.type        = 'button';
  btn.className   = 'scan-btn';
  btn.title       = 'Ler código de barras ou QR Code';
  btn.innerHTML   = '<i class="ti ti-scan"></i>';
  btn.onclick     = () => openScanner('f_serie');
  wrap.appendChild(btn);

  const hint         = document.createElement('div');
  hint.className     = 'scan-hint';
  hint.innerHTML     = '📷 Toque para ler <strong>código de barras</strong> ou <strong>QR Code</strong>';
  wrap.parentNode.insertBefore(hint, wrap.nextSibling);
}