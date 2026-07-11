// ─── mobile-scanner.js ───────────────────────────────────────────
// Scanner de QR Code + Código de Barras
// Usa html5-qrcode (suporte real iOS Safari + Android Chrome)
// ─────────────────────────────────────────────────────────────────

// ── SIDEBAR MOBILE ────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.querySelector('.sidebar');
  const ov = document.getElementById('sidebar-overlay');
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
  _origToggleDark();
  _syncDarkIcon();
};
function _syncDarkIcon() {
  const icon = document.getElementById('mobile-dark-icon');
  if (!icon) return;
  icon.className = document.documentElement.classList.contains('dark') ? 'ti ti-sun' : 'ti ti-moon';
}
_syncDarkIcon();

// ── SCANNER ───────────────────────────────────────────────────────
let _html5Qr      = null;   // instância Html5Qrcode
let _scanRunning  = false;
let _targetField  = 'f_serie';

// Carrega a biblioteca html5-qrcode dinamicamente
function _loadHtml5Qrcode() {
  return new Promise((resolve, reject) => {
    if (window.Html5Qrcode) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    s.onload  = () => { resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function openScanner(fieldId) {
  _targetField = fieldId || 'f_serie';

  try {
    await _loadHtml5Qrcode();
  } catch(e) {
    alert('Erro ao carregar leitor. Verifique sua conexão.');
    return;
  }

  // Abre o modal
  document.getElementById('scanner-modal').classList.add('open');

  // Se já estava rodando, para antes de reiniciar
  if (_html5Qr && _scanRunning) {
    try { await _html5Qr.stop(); } catch(_) {}
    _scanRunning = false;
  }

  // Container onde o html5-qrcode renderiza o vídeo
  const container = document.getElementById('scanner-qr-container');
  container.innerHTML = ''; // limpa

  _html5Qr = new Html5Qrcode('scanner-qr-container', { verbose: false });

  // Todos os formatos suportados (QR + barcodes)
  const formatos = [
    Html5QrcodeSupportedFormats.QR_CODE,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.CODABAR,
    Html5QrcodeSupportedFormats.PDF_417,
    Html5QrcodeSupportedFormats.DATA_MATRIX,
    Html5QrcodeSupportedFormats.AZTEC,
  ];

  const config = {
    fps: 15,
    qrbox: { width: 260, height: 180 },
    aspectRatio: 1.5,
    formatsToSupport: formatos,
    showTorchButtonIfSupported: true,
    focusMode: 'continuous',
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  };

  try {
    await _html5Qr.start(
      { facingMode: 'environment' },
      config,
      (decodedText) => { _onScanned(decodedText); },
      () => {} // onScanFailure — silencioso (NotFoundException normal)
    );
    _scanRunning = true;
  } catch(err) {
    document.getElementById('scanner-modal').classList.remove('open');
    let msg = '📷 Não foi possível acessar a câmera.';
    if (err.toString().includes('NotAllowed') || err.toString().includes('Permission'))
      msg = '📷 Permissão de câmera negada.\n\niOS: Configurações → Safari → Câmera → Permitir\nAndroid: Configurações do navegador → Permissões → Câmera';
    else if (err.toString().includes('NotFound'))
      msg = '📷 Câmera não encontrada neste dispositivo.';
    alert(msg);
  }
}

function _onScanned(value) {
  closeScanner();
  const field = document.getElementById(_targetField);
  if (!field) return;
  field.value = value.trim();
  field.focus();
  field.style.borderColor = '#059669';
  field.style.boxShadow   = '0 0 0 3px rgba(5,150,105,.2)';
  setTimeout(() => { field.style.borderColor = ''; field.style.boxShadow = ''; }, 2500);
  _showScanToast('✅ Lido: ' + value.trim());
}

async function closeScanner() {
  document.getElementById('scanner-modal').classList.remove('open');
  if (_html5Qr && _scanRunning) {
    try { await _html5Qr.stop(); } catch(_) {}
    _scanRunning = false;
  }
  // Limpa container para liberar câmera
  const c = document.getElementById('scanner-qr-container');
  if (c) c.innerHTML = '';
}

function _showScanToast(msg) {
  let t = document.getElementById('scan-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'scan-toast';
    t.style.cssText = 'position:fixed;bottom:calc(20px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:#166534;color:#dcfce7;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:500;z-index:900;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.3);opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw;overflow:hidden;text-overflow:ellipsis;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── PATCH: injeta botão de scan no campo N° de Série ─────────────
const _origRenderForm = window.renderForm;
window.renderForm = function () {
  _origRenderForm.apply(this, arguments);
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

  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'scan-btn';
  btn.title     = 'Ler código de barras ou QR Code';
  btn.innerHTML = '<i class="ti ti-scan"></i>';
  btn.onclick   = () => openScanner('f_serie');
  wrap.appendChild(btn);

  const hint = document.createElement('div');
  hint.className = 'scan-hint';
  hint.innerHTML = '📷 Toque para ler <strong>código de barras</strong> ou <strong>QR Code</strong>';
  wrap.parentNode.insertBefore(hint, wrap.nextSibling);
}