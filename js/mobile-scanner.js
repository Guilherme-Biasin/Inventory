// ─── mobile-scanner.js ───────────────────────────────────────────
// Leitor de código de barras + lógica do sidebar mobile
// Carregado DEPOIS do app.js — não altera nenhuma função existente
// ─────────────────────────────────────────────────────────────────

// ── SIDEBAR MOBILE ────────────────────────────────────────────────
function toggleSidebar() {
  const sb  = document.querySelector('.sidebar');
  const ov  = document.getElementById('sidebar-overlay');
  const open = sb.classList.toggle('open');
  ov.classList.toggle('open', open);
}

function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// Fecha sidebar ao clicar em qualquer item de navegação no mobile
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => {
    if (window.innerWidth <= 768) closeSidebar();
  });
});

// ── DARK MODE: sincroniza ícone mobile ────────────────────────────
// Sobrescreve toggleDark para também atualizar o ícone mobile
const _origToggleDark = window.toggleDark;
window.toggleDark = function () {
  _origToggleDark();
  syncMobileDarkIcon();
};
function syncMobileDarkIcon() {
  const icon = document.getElementById('mobile-dark-icon');
  if (!icon) return;
  icon.className = document.documentElement.classList.contains('dark')
    ? 'ti ti-sun'
    : 'ti ti-moon';
}
// Sincroniza ao carregar (caso dark já esteja ativo)
syncMobileDarkIcon();

// ── BARCODE SCANNER ───────────────────────────────────────────────
let _scanStream      = null;
let _scanAnimFrame   = null;
let _barcodeDetector = null;
let _targetFieldId   = 'f_serie'; // campo que receberá o valor lido

async function openScanner(fieldId) {
  _targetFieldId = fieldId || 'f_serie';
  const modal    = document.getElementById('scanner-modal');

  // Navegadores sem BarcodeDetector API — fallback manual
  if (!('BarcodeDetector' in window)) {
    const v = prompt('Câmera não disponível neste navegador.\nDigite o número de série manualmente:');
    if (v && v.trim()) _applyScannedValue(v.trim());
    return;
  }

  try {
    _scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    document.getElementById('scanner-video').srcObject = _scanStream;
    modal.classList.add('open');

    const supported = await BarcodeDetector.getSupportedFormats();
    _barcodeDetector = new BarcodeDetector({
      formats: supported.length
        ? supported
        : ['code_128','ean_13','ean_8','qr_code','code_39','upc_a','upc_e','itf','data_matrix','aztec','pdf417','codabar']
    });

    _startScanLoop(document.getElementById('scanner-video'));
  } catch (err) {
    console.error('Scanner error:', err);
    modal.classList.remove('open');
    _stopScanner();
    let msg = '📷 Não foi possível acessar a câmera.';
    if (err.name === 'NotAllowedError') msg = '📷 Permissão de câmera negada. Habilite nas configurações do navegador.';
    if (err.name === 'NotFoundError')   msg = '📷 Câmera não encontrada neste dispositivo.';
    alert(msg);
  }
}

function _startScanLoop(video) {
  let lastDetect = 0;
  async function loop() {
    if (!_barcodeDetector || !_scanStream) return;
    const now = Date.now();
    if (now - lastDetect > 300 && video.readyState >= 2) {
      try {
        const codes = await _barcodeDetector.detect(video);
        if (codes.length && codes[0].rawValue) {
          lastDetect = now;
          _applyScannedValue(codes[0].rawValue.trim());
          return; // para o loop após leitura
        }
      } catch (_) {}
    }
    _scanAnimFrame = requestAnimationFrame(loop);
  }
  _scanAnimFrame = requestAnimationFrame(loop);
}

function _applyScannedValue(value) {
  closeScanner();
  const field = document.getElementById(_targetFieldId);
  if (field) {
    field.value = value;
    field.focus();
    // Destaca o campo brevemente
    field.style.borderColor  = '#059669';
    field.style.boxShadow    = '0 0 0 3px rgba(5,150,105,.2)';
    setTimeout(() => { field.style.borderColor = ''; field.style.boxShadow = ''; }, 2000);
  }
}

function _stopScanner() {
  if (_scanAnimFrame) { cancelAnimationFrame(_scanAnimFrame); _scanAnimFrame = null; }
  if (_scanStream)    { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  _barcodeDetector = null;
}

function closeScanner() {
  _stopScanner();
  document.getElementById('scanner-modal').classList.remove('open');
}

// ── PATCH: injeta botão de scan no campo N° de Série ─────────────
// Aguarda renderForm() do app.js ser chamado e adiciona o botão
const _origRenderForm = window.renderForm;
window.renderForm = function () {
  _origRenderForm.apply(this, arguments);
  _injectScanButton();
};

function _injectScanButton() {
  // Procura o input f_serie após o renderForm criar os campos
  const field = document.getElementById('f_serie');
  if (!field || field.dataset.scanInjected) return;
  field.dataset.scanInjected = '1';

  // Envolve o input em um wrapper com botão
  const wrap = document.createElement('div');
  wrap.className = 'scan-btn-wrap';
  field.parentNode.insertBefore(wrap, field);
  wrap.appendChild(field);

  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'scan-btn';
  btn.title     = 'Ler código de barras';
  btn.innerHTML = '<i class="ti ti-barcode"></i>';
  btn.onclick   = () => openScanner('f_serie');
  wrap.appendChild(btn);

  // Hint
  const hint = document.createElement('div');
  hint.className   = 'scan-hint';
  hint.textContent = 'Toque no ícone 📷 para ler o código de barras';
  wrap.parentNode.insertBefore(hint, wrap.nextSibling);
}