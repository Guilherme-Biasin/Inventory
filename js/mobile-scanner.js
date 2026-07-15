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
const CONFIRM_NEEDED = 3;       // precisa ler o mesmo valor 3x seguidas
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
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        zoom:   { ideal: 1 }
      }
      // 'area' removida — estava cortando códigos que aparecem perto da
      // borda do quadro visual (ex: etiqueta de patrimônio). O quadro na
      // tela já orienta o usuário; a Quagga agora varre o frame inteiro.
    },
    // patchSize 'x-small' + halfSample:false — dá à Quagga resolução fina
    // o suficiente para decodificar códigos pequenos/finos como etiquetas
    // de patrimônio, ao custo de um pouco mais de processamento.
    locator: { patchSize: 'x-small', halfSample: false },
    numOfWorkers: navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2,
    frequency: 10,
    decoder: {
      readers: [
        'code_128_reader', 'ean_reader', 'ean_8_reader',
        'code_39_reader', 'upc_reader', 'upc_e_reader', 'i2of5_reader'
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

    // Trava o zoom em 1x — evita o navegador trocar de lente (grande-angular)
    // e dar aquele "salto" de zoom logo ao abrir a câmera
    _lockZoom(container);

    // Inicia leitura paralela de QR Code via jsQR
    _startQrLoop(container);
  });

  // Remove listener anterior antes de registrar um novo — Quagga é singleton
  // global e empilha listeners a cada chamada, o que fazia o contador de
  // confirmação (votos) somar em dobro/triplo nas leituras seguintes
  Quagga.offDetected(_onBarcodeDetected);
  Quagga.onDetected(_onBarcodeDetected);
}

// Define zoom = 1 explicitamente na track de vídeo, se o navegador suportar
// Define zoom = 1x explicitamente na track de vídeo, se o navegador suportar.
// IMPORTANTE: usar zoom.min aqui estava errado — no iPhone o mínimo geralmente
// corresponde à lente ultra grande-angular (0.5x), que mostra muito mais cena
// ao redor e faz o código de barras aparecer pequeno demais para ser lido.
// O alvo correto é 1x (mesmo padrão da câmera nativa), sempre respeitando
// os limites reais de zoom suportados pelo dispositivo.
function _lockZoom(container) {
  try {
    const video = container.querySelector('video');
    const track = video?.srcObject?.getVideoTracks?.()[0];
    if (!track) return;
    const caps = track.getCapabilities?.();
    if (caps && caps.zoom) {
      const target = Math.min(Math.max(1, caps.zoom.min), caps.zoom.max);
      track.applyConstraints({ advanced: [{ zoom: target }] }).catch(() => {});
    }
  } catch(_) { /* zoom não suportado neste dispositivo/navegador */ }
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
  const code   = result?.codeResult?.code;
  const format = result?.codeResult?.format;
  if (!code) return;

  // Filtro de qualidade: a Quagga expõe o "erro" de decodificação de
  // cada barra lida (decodedCodes[].error). Leituras com muito ruído
  // visual (reflexo, plástico, ângulo) tendem a ter erro alto mesmo
  // quando o checksum "acerta" por coincidência. Descartamos leituras
  // de baixa confiança ANTES de contarem como voto.
  const avgError = _quaggaAvgError(result);
  if (avgError > 0.12) return; // muito ruidosa, ignora este frame

  _registerVote(code.trim(), format);
}

function _quaggaAvgError(result) {
  const codes = result?.codeResult?.decodedCodes;
  if (!Array.isArray(codes)) return 0;
  const errors = codes.map(c => c.error).filter(e => typeof e === 'number');
  if (!errors.length) return 0;
  return errors.reduce((a, b) => a + b, 0) / errors.length;
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
        _registerVote(result.data.trim(), 'qr_code');
      }
    } catch(_) { /* ignora frame inválido */ }
  }, 300);
}

// ── VALIDAÇÃO DE CHECKSUM ─────────────────────────────────────────
// EAN-13/EAN-8/UPC-A têm um dígito verificador matemático.
// Sem validar isso, a Quagga pode "confirmar" 3 leituras erradas
// diferentes que por acaso pareceram plausíveis. Validando o
// checksum, leituras incorretas nunca chegam a ser contadas como voto.
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

// Retorna true se o valor "faz sentido" para o formato lido.
// Formatos sem checksum conhecido (code_128, code_39, itf, qr_code)
// passam direto — apenas exige um tamanho mínimo razoável.
function _passesChecksum(value, format) {
  switch (format) {
    case 'ean_13':  return _isValidEAN13(value);
    case 'ean_8':    return _isValidEAN8(value);
    case 'upc_a':    return _isValidUPCA(value);
    case 'upc_e':    return value.length >= 6; // UPC-E não tem checksum simples de validar aqui
    default:         return value.length >= 3; // code_128, code_39, itf, qr_code etc.
  }
}

// ── SISTEMA DE CONFIRMAÇÃO POR VOTOS ─────────────────────────────
// Só aceita um código depois de lê-lo IDENTICAMENTE várias vezes
// seguidas, E somente se o valor passar na validação de checksum
// (quando aplicável ao formato). Leituras que falham no checksum
// são descartadas silenciosamente — nem chegam a virar voto.
function _registerVote(value, format) {
  if (_detected || !value) return;

  // Filtra leituras matematicamente inválidas antes de tudo
  if (!_passesChecksum(value, format)) {
    return; // ignora este frame, não conta e não reseta a contagem atual
  }

  const now = Date.now();

  if (value !== _lastValue || (now - _lastVoteTime) > CONFIRM_WINDOW_MS) {
    _lastValue = value;
    _voteCount = 1;
  } else {
    _voteCount++;
  }
  _lastVoteTime = now;

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
    try { Quagga.offDetected(_onBarcodeDetected); } catch(_) {}
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