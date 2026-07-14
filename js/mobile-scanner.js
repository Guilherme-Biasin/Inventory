// ─── mobile-scanner.js ───────────────────────────────────────────
// QR Code + Código de Barras — iOS Safari + Android Chrome
// iOS: @undecaf/barcode-detector-polyfill (ZBar WASM)
// Android: BarcodeDetector nativa
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
let _stream      = null;
let _scanTimer   = null;
let _detector    = null;
let _scanActive  = false;
let _targetField = 'f_serie';
let _polyfillReady = false;

// Pré-carrega os scripts do polyfill no <head> via type="module"
// Isso garante que o import funcione corretamente no iOS Safari
function _preloadPolyfill() {
  if (_polyfillReady) return;
  _polyfillReady = true;

  // Injeta script de módulo para importar o polyfill
  const s = document.createElement('script');
  s.type = 'module';
  s.textContent = `
    import { BarcodeDetectorPolyfill } from 'https://cdn.jsdelivr.net/npm/@undecaf/barcode-detector-polyfill@0.9.23/dist/main.js';
    window._BarcodeDetectorPolyfill = BarcodeDetectorPolyfill;
    window.dispatchEvent(new Event('polyfill-ready'));
  `;
  document.head.appendChild(s);
}

// Aguarda o polyfill estar disponível (máx 8 segundos)
function _waitPolyfill() {
  return new Promise((resolve, reject) => {
    if (window._BarcodeDetectorPolyfill) { resolve(); return; }
    const timeout = setTimeout(() => reject(new Error('Timeout ao carregar o leitor')), 8000);
    window.addEventListener('polyfill-ready', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

// Inicializa o detector correto: nativo (Android) ou polyfill (iOS)
async function _initDetector() {
  if (_detector) return; // já inicializado

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const hasNative = 'BarcodeDetector' in window;

  if (hasNative && !isIOS) {
    // Android/Chrome: usa BarcodeDetector nativa
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      _detector = new window.BarcodeDetector({ formats: supported });
      console.log('[Scanner] BarcodeDetector nativa (Android)');
      return;
    } catch(e) {
      console.warn('[Scanner] Nativa falhou, usando polyfill');
    }
  }

  // iOS ou fallback: usa polyfill ZBar WASM
  console.log('[Scanner] Carregando ZBar WASM polyfill...');
  await _waitPolyfill();

  const Cls = window._BarcodeDetectorPolyfill;
  if (!Cls) throw new Error('Polyfill não carregou corretamente');

  const supported = await Cls.getSupportedFormats();
  _detector = new Cls({ formats: supported });
  console.log('[Scanner] ZBar WASM polyfill pronto, formatos:', supported);
}

// ── ABRIR SCANNER ────────────────────────────────────────────────
async function openScanner(fieldId) {
  _targetField = fieldId || 'f_serie';

  _setHint('Inicializando câmera...');
  document.getElementById('scanner-modal').classList.add('open');

  try {
    // Inicializa detector (com timeout visual)
    await _initDetector();

    // Pede câmera traseira
    _stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:      { ideal: 1280 },
        height:     { ideal: 720 },
      }
    });

    const video = document.getElementById('scanner-video');
    video.srcObject = _stream;
    await new Promise(res => {
      video.onloadedmetadata = res;
      setTimeout(res, 2000); // fallback timeout
    });
    await video.play();

    _setHint('Aponte para o código de barras ou QR Code');
    _scanActive = true;
    _scanLoop(video);

  } catch(err) {
    console.error('[Scanner] Erro:', err);
    closeScanner();
    let msg = '📷 Não foi possível iniciar o scanner.';
    if (err.name === 'NotAllowedError' || err.message?.includes('Permission'))
      msg = '📷 Permissão de câmera negada.\n\niOS: Configurações → Safari → Câmera → Permitir\nAndroid: Toque nos 3 pontos → Configurações → Permissões';
    else if (err.name === 'NotFoundError')
      msg = '📷 Câmera não encontrada.';
    else if (err.message?.includes('Timeout') || err.message?.includes('Polyfill'))
      msg = '📷 Erro ao carregar leitor. Verifique sua conexão e tente novamente.';
    alert(msg);
  }
}

// ── LOOP DE SCAN ─────────────────────────────────────────────────
function _scanLoop(video) {
  if (!_scanActive || !_detector) return;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (!_scanActive) return;

    if (video.readyState >= 2 && video.videoWidth > 0) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;

      // Tenta 3 ângulos para pegar barcodes levemente inclinados
      for (const angle of [0, 25, -25]) {
        if (!_scanActive) return;
        try {
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((angle * Math.PI) / 180);
          ctx.drawImage(video, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
          ctx.restore();

          const symbols = await _detector.detect(canvas);
          if (symbols.length && symbols[0].rawValue) {
            _onDetected(symbols[0].rawValue.trim());
            return;
          }
        } catch (_) { /* NotFoundException é normal */ }
      }
    }

    _scanTimer = setTimeout(tick, 250);
  };

  _scanTimer = setTimeout(tick, 500); // aguarda câmera estabilizar
}

function _onDetected(value) {
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
  if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
  if (_scanStream) { /* alias */ }
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  const video = document.getElementById('scanner-video');
  if (video) { video.srcObject = null; video.load(); }
  document.getElementById('scanner-modal')?.classList.remove('open');
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

// Pré-carrega o polyfill em background assim que o script carrega
// (dá tempo de baixar o WASM antes do usuário abrir o scanner)
setTimeout(_preloadPolyfill, 1000);