// ═══════════════════════════════════════════════════════════════
//  app.js — Inventory Guemat
//  Fala com a API em api-config.js (Node + SQL Server ESTOQUE_TI).
// ═══════════════════════════════════════════════════════════════

// ── Estado global
let S = {
  items: [], cats: [], pessoas: [], locais: [],
  statusOpts: [], vinculos: { entrada:{statusIds:[],localIds:[]}, saida:{statusIds:[],localIds:[]} },
  editId: null, dark: false, lastFiltered: [],
  papel: 'leitor',  // 'admin' | 'editor' | 'leitor'  — vem do login

  // ALMOXARIFADO (material de consumo). Lista própria, categorias próprias e
  // saldo por lote — ver o bloco ALMOXARIFADO mais abaixo.
  almox: [], catsAlmox: [], lastFilteredAlmox: [], almoxErro: null,
  editAlmoxId: null,
  tipoCadastro: 'patrimonio'   // o que o seletor do topo do Cadastro está mostrando
};

// Dark mode persiste localmente (preferência visual por usuário)
if (localStorage.getItem('dark') === '1') {
  S.dark = true;
  document.documentElement.classList.add('dark');
}

// ─── LOADING OVERLAY ─────────────────────────────────────────
function showLoading(msg='Carregando...') {
  document.getElementById('loading-overlay').style.display = 'flex';
  document.getElementById('loading-msg').textContent = msg;
}
function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}
function showToast(msg, type='ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast toast-' + type + ' show';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────
async function appInit() {
  // Observa sessão
  Auth.onAuthChange(async user => {
    if (user) {
      showScreen('app');
      document.getElementById('user-nome').textContent = user.nome || user.login;
      await loadAll(user);
    } else {
      // Encerra o observador de mudanças: sem isto ele continuaria consultando
      // a API depois do logout e cairia em 401 a cada 20 segundos.
      DB.unsubscribeItems();
      showScreen('login');
    }
  });
}

function showScreen(which) {
  document.getElementById('screen-login').style.display = which === 'login' ? 'flex'  : 'none';
  document.getElementById('screen-app').style.display   = which === 'app'   ? 'block' : 'none';
}

async function loadAll(user) {
  showLoading('Carregando dados...');
  try {
    // O papel já veio na conferência de sessão feita pelo Auth — não precisa
    // de uma segunda ida ao servidor só para lê-lo.
    S.papel = user?.papel || 'leitor';

    const [cfg, items] = await Promise.all([DB.loadConfig(), DB.loadItems()]);
    S.cats       = cfg.cats;
    S.catsAlmox  = cfg.catsAlmox || [];
    S.pessoas    = cfg.pessoas;
    S.locais     = cfg.locais;
    S.statusOpts = cfg.statusOpts;
    S.vinculos   = cfg.vinculos;
    S.items      = items;
    S.lastFiltered = [...items];

    // O almoxarifado carrega à parte, e uma falha dele NÃO derruba o resto: as
    // tabelas só existem depois da migração 05, e sem isto uma API atualizada
    // contra um banco antigo deixaria o sistema inteiro sem abrir. A aba
    // Almoxarifado mostra o motivo; patrimônio continua funcionando.
    await recarregarAlmox();

    // Aplica permissões na UI
    applyPapelUI();
    renderDash();

    DB.subscribeItems(async () => {
      const fresh = await DB.loadItems();
      S.items = fresh;
      S.lastFiltered = [...fresh];
      await recarregarAlmox();
      const page = document.querySelector('.page.active')?.id;
      if (page === 'page-dashboard')    renderDash();
      if (page === 'page-lista')        renderLista();
      if (page === 'page-almoxarifado') renderAlmox();
    });
  } catch(e) {
    showToast('Erro ao carregar dados: ' + e.message, 'err');
    console.error(e);
  } finally {
    hideLoading();
  }
}

// Busca a lista do almoxarifado guardando o motivo quando falha, em vez de
// deixar a exceção subir e parar o carregamento das outras telas.
async function recarregarAlmox() {
  try {
    S.almox = await DB.loadAlmox();
    S.lastFilteredAlmox = [...S.almox];
    S.almoxErro = null;
  } catch (e) {
    S.almox = []; S.lastFilteredAlmox = [];
    S.almoxErro = e.message;
    console.error('almoxarifado:', e);
  }
}

// Persiste apenas config (items salvos direto no banco via DB.*)
async function persistConfig() {
  try {
    await DB.saveConfig({
      cats: S.cats, catsAlmox: S.catsAlmox, pessoas: S.pessoas, locais: S.locais,
      statusOpts: S.statusOpts, vinculos: S.vinculos
    });
  } catch(e) { showToast('Erro ao salvar configuração: ' + e.message, 'err'); }
}

// ─── LOGIN ────────────────────────────────────────────────────
async function doLogin(e) {
  e.preventDefault();
  const login = document.getElementById('l-login').value.trim();
  const pass  = document.getElementById('l-pass').value;
  const btn   = document.getElementById('l-btn');
  const err   = document.getElementById('l-err');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  try {
    await Auth.login(login, pass);
    // onAuthChange cuida do resto
  } catch(ex) {
    // Mostra o motivo real: "muitas tentativas — tente em 10 min" é diferente
    // de senha errada, e o usuário precisa saber qual dos dois aconteceu.
    err.textContent = ex.message || 'Usuário ou senha incorretos.';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function doLogout() {
  await Auth.logout();
}

// ─── MODO ESCURO ─────────────────────────────────────────────
function toggleDark() {
  S.dark = !S.dark;
  document.documentElement.classList.toggle('dark', S.dark);
  localStorage.setItem('dark', S.dark ? '1' : '0');
}

// ─── ONDE O FORMULÁRIO É DESENHADO ───────────────────────────
// O mesmo formulário serve à aba Novo Cadastro e ao modal de edição; muda só o
// lugar em que ele aparece.
let formEmModal = false;

function alvoForm() {
  return formEmModal
    ? { wrap:'fm-corpo',  titulo:'fm-titulo',  alerta:'fm-alert'  }
    : { wrap:'form-wrap', titulo:'form-title', alerta:'form-alert' };
}

// Editar e movimentar abrem o formulário por cima da lista, sem trocar de tela.
// O formulário da página é limpo antes: os dois usam os mesmos ids de campo, e
// com os dois no ar o getElementById acharia primeiro o da página.
function abrirFormModal() {
  const pagina = document.getElementById('form-wrap');
  if (pagina) pagina.innerHTML = '';
  formEmModal = true;
  const m = document.getElementById('form-modal');
  m.style.display = 'flex';
  renderForm();
  m.querySelector('.modal-form').scrollTop = 0;
}

function fecharFormModal() {
  const m = document.getElementById('form-modal');
  if (m) m.style.display = 'none';
  const corpo = document.getElementById('fm-corpo');
  if (corpo) corpo.innerHTML = '';
  formEmModal = false;
}

// Saiu do formulário (salvou ou cancelou): no modal, fecha e redesenha a lista
// que está atrás; na página, navega como antes.
function voltarDoForm(pagina) {
  if (!formEmModal) { nav(pagina); return; }
  fecharFormModal();
  if (pagina === 'almoxarifado') { populateFiltersAlmox(); renderAlmox(); }
  else                           { populateFilters();      renderLista(); }
}

// ─── NAVEGAÇÃO ───────────────────────────────────────────────
function nav(p) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  // Ativa o item de nav correto pelo data-nav attribute
  const navEl = document.querySelector(`.nav-item[data-nav="${p}"]`);
  // O título é o mesmo texto do menu lateral: assim os dois nunca divergem
  // quando um item é renomeado (era uma lista à parte, que ficou defasada).
  const titles = {dashboard:'Dashboard',lista:'Patrimônios',almoxarifado:'Almoxarifado',cadastro:'Cadastro',config:'Personalizar',auditoria:'Auditoria',usuarios:'Usuários',importacao:'Importar/Exportar'};
  document.getElementById('topbar-title').textContent =
    (navEl ? navEl.textContent.trim() : '') || titles[p] || '';
  if (navEl) navEl.classList.add('active');
  if (p === 'dashboard') renderDash();
  if (p === 'lista')     { populateFilters(); renderLista(); }
  if (p === 'almoxarifado') { populateFiltersAlmox(); renderAlmox(); }
  // O botão do topo cadastra o que a aba aberta mostra: estando no
  // almoxarifado, "Novo Patrimônio" abriria o formulário errado.
  const rotulo = document.getElementById('btn-novo-label');
  if (rotulo) rotulo.textContent = p === 'almoxarifado' ? 'Novo Item' : 'Novo Patrimônio';
  if (p === 'cadastro')  {
    if (!can('cadastrar')) { showToast('Sem permissão para cadastrar.','err'); return; }
    // Quem chegou por "Editar" ou "Movimentar" já escolheu o item; só o
    // "Novo" do menu começa do zero.
    if (S.editId == null && S.editAlmoxId == null) { movMode = false; movModeAlmox = false; }
    renderForm();
  }
  if (p === 'config')    {
    if (!can('config')) { showToast('Sem permissão para configurações.','err'); return; }
    renderConfig();
  }
  if (p === 'auditoria') renderAuditoria();
  if (p === 'importacao') renderImportacao();
  if (p === 'usuarios')  {
    if (!can('gerenciar_usuarios')) { showToast('Acesso restrito a administradores.','err'); return; }
    renderUsuarios();
  }
}

// ─── HELPERS ─────────────────────────────────────────────────
function getCat(id)  { return S.cats.find(c => c.id === id) || {name:id, color:'#888'}; }
function getStat(id) { return S.statusOpts.find(s => s.id === id) || {name:id, color:'#888'}; }
function fmtDate(d)  { if (!d) return '—'; try { return new Date(d+'T12:00').toLocaleDateString('pt-BR'); } catch(e) { return d; } }
function fmtDT(ts)   { if (!ts) return '—'; try { return new Date(ts).toLocaleString('pt-BR'); } catch(e) { return ts; } }
function catPills(arr)  { return (arr||[]).map(id => { const c=getCat(id);  const cor=corSegura(c.color); return `<span class="cat-pill" style="background:${cor}22;color:${cor}">${esc(c.name)}</span>`; }).join('')||'—'; }
function statPills(arr) { return (arr||[]).map(id => { const s=getStat(id); const cor=corSegura(s.color); return `<span class="cat-pill" style="background:${cor}22;color:${cor}">${esc(s.name)}</span>`; }).join('')||'—'; }

// Cor que entra dentro de style="...". So aceita #rgb/#rrggbb: qualquer outra
// coisa ("red;background:url(...)") viraria CSS injetado na pagina de todos.
function corSegura(c) {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c || '')) ? c : '#888888';
}

// REGRA DA TELA: todo valor que veio do banco ou de planilha passa por esc()
// antes de entrar em innerHTML — inclusive numero, marca, modelo e serie.
// Sem isso, um editor que cadastrasse "<img src=x onerror=...>" como marca
// rodava codigo no navegador de quem abrisse a lista (um admin, por exemplo),
// com o token de login dele.
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Para valores que entram DENTRO de um onclick, como
// onclick="editar('${escJs(nome)}')".
//
// Só esc() não bastava: o navegador desfaz as entidades HTML ANTES de o
// JavaScript ser lido, então um nome como O'Brien virava 'O'Brien' e o botão
// quebrava. A barra invertida sobrevive a essa volta e mantém a aspa dentro do
// texto. Escapar a própria barra vem primeiro, senão um nome terminado em "\"
// escaparia a aspa de fechamento.
function escJs(str) {
  return esc(String(str ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

// ─── PERMISSÕES ──────────────────────────────────────────────
// Espelho do que o SERVIDOR já aplica (server.js, tabela PODE). Aqui é só
// para esconder botão: a decisão que vale é a da API.
const NIVEL = { admin:3, editor:2, leitor:1 };
function can(action) {
  const r = NIVEL[S.papel] || 1;
  switch(action) {
    case 'gerenciar_usuarios': return r >= 3;   // só admin
    case 'cadastrar':          return r >= 2;   // admin + editor
    case 'editar':             return r >= 2;
    case 'movimentar':         return r >= 2;
    case 'excluir':            return r >= 3;   // só admin
    case 'config':             return r >= 2;
    case 'exportar':           return r >= 1;   // todos
    default:                   return false;
  }
}

function applyPapelUI() {
  // Badge do papel no topbar
  const badge = document.getElementById('papel-badge');
  if (badge) {
    badge.textContent = PAPEL_LABELS[S.papel] || S.papel;
    badge.style.color = PAPEL_COLORS[S.papel] || '#888';
  }

  // Mostra/oculta aba de Usuários na sidebar
  const navUsuarios = document.getElementById('nav-usuarios');
  if (navUsuarios) navUsuarios.style.display = can('gerenciar_usuarios') ? '' : 'none';

  // O item Importar/Exportar fica visível para todos: exportar é permitido
  // até para o leitor. Quem não pode importar vê só o botão de exportar.
  const partesDeImportar = document.querySelectorAll('#tipo-import, #page-importacao .import-card');
  partesDeImportar.forEach(el => { el.style.display = can('cadastrar') ? '' : 'none'; });

  // Botão "Novo Patrimônio" no topbar
  const btnNovo = document.getElementById('btn-novo-topbar');
  if (btnNovo) {
    btnNovo.disabled = !can('cadastrar');
    btnNovo.title    = can('cadastrar') ? '' : 'Sem permissão para cadastrar';
  }

  // Exportar — sempre visível para todos
}

// Aplica disabled em botões de ação de um item conforme o papel
function actionButtons(id) {
  const edOk  = can('editar');
  const movOk = can('movimentar');
  const delOk = can('excluir');
  const dis   = (ok, tip) => !ok ? `disabled title="${tip}" style="opacity:.4;cursor:not-allowed"` : '';
  return `<div class="actions-cell">
    <button class="btn btn-sm" onclick="${edOk?`editItem(${id})`:''}" ${dis(edOk,'Sem permissão para editar')} title="${edOk?'Editar':'Sem permissão'}"><i class="ti ti-edit"></i> <span class="btn-label">Editar</span></button>
    <button class="btn btn-sm btn-warn" onclick="${movOk?`novaMovimentacao(${id})`:''}" ${dis(movOk,'Sem permissão para movimentar')} title="${movOk?'Movimentar':'Sem permissão'}"><i class="ti ti-transfer"></i> <span class="btn-label">Movimentar</span></button>
    <button class="btn btn-sm" style="${delOk?'border-color:var(--danger-txt);color:var(--danger-txt)':'opacity:.4;cursor:not-allowed'}" onclick="${delOk?`delItem(${id})`:''}" ${dis(delOk,'Sem permissão para excluir')} title="${delOk?'Excluir':'Sem permissão'}"><i class="ti ti-trash"></i> <span class="btn-label">Excluir</span></button>
  </div>`;
}

// ─── DASHBOARD ───────────────────────────────────────────────
function renderDash() {
  const total    = S.items.length;
  const totalMov = S.items.reduce((a,it) => a + (it.historico||[]).length, 0);
  document.getElementById('stats-row').innerHTML = `
    <div class="stat"><div class="stat-label">Total Patrimônios</div><div class="stat-val">${total}</div><div class="stat-sub">itens cadastrados</div></div>
    <div class="stat"><div class="stat-label">Categorias</div><div class="stat-val">${S.cats.length}</div><div class="stat-sub">tipos cadastrados</div></div>
    <div class="stat"><div class="stat-label">Movimentações</div><div class="stat-val">${totalMov}</div><div class="stat-sub">registros no histórico</div></div>
    <div class="stat"><div class="stat-label">Pessoas</div><div class="stat-val">${S.pessoas.length}</div><div class="stat-sub">cadastradas</div></div>
    <div class="stat" onclick="nav('almoxarifado')" style="cursor:pointer" title="Abrir o almoxarifado">
      <div class="stat-label">Almoxarifado</div>
      <div class="stat-val">${S.almox.length}</div>
      <div class="stat-sub">${alertaValidade()}</div></div>`;
  medirFaixas();

  const recent = [...S.items].slice(-5).reverse();
  document.getElementById('dash-tbody').innerHTML = recent.length
    ? recent.map(i => `<tr>
        <td><strong>${esc(i.patrimonio||'—')}</strong></td>
        <td>${esc(i.nome||'—')}</td>
        <td>${esc(i.modelo||'—')}</td>
        <td>${esc(i.serie||'—')}</td>
        <td>${catPills(i.categoria)}</td>
        <td>${statPills(i.status)}</td>
      </tr>`).join('')
    : '<tr class="empty-row"><td colspan="6">Nenhum patrimônio cadastrado</td></tr>';
}

// ─── FAIXA DE CARDS (carrossel) ──────────────────────────────
// Igual ao Gerente Assist: quando a fileira de cards não cabe na linha, ela
// corre para o lado com setas em vez de quebrar para a segunda linha.
// Manual de propósito — nada anda sozinho enquanto a pessoa lê.
function rolarFaixa(bt, dir) {
  const pista = bt.parentElement.querySelector('.faixa-pista');
  const card = pista.firstElementChild;
  const vao = parseFloat(getComputedStyle(pista).columnGap) || 10;
  const passo = (card ? card.getBoundingClientRect().width : 200) + vao;
  pista.scrollBy({ left: dir * passo, behavior: 'smooth' });
}

// Mostra as setas só quando há o que rolar, e apaga cada uma ao chegar na
// ponta. A folga de 2px é do arredondamento do zoom do navegador, que deixa
// scrollLeft com casas decimais e nunca fecha a conta exata.
function atualizarSetas(pista) {
  const wrap = pista.closest('.faixa-wrap');
  if (!wrap) return;
  const sobra = pista.scrollWidth - pista.clientWidth;
  wrap.classList.toggle('tem-setas', sobra > 2);
  const esq = wrap.querySelector('.faixa-seta.esq');
  const dir = wrap.querySelector('.faixa-seta.dir');
  if (esq) esq.disabled = pista.scrollLeft <= 2;
  if (dir) dir.disabled = pista.scrollLeft >= sobra - 2;
}

// Só dá para saber se cabe DEPOIS do layout. O setTimeout cobre a aba em
// segundo plano, onde o requestAnimationFrame não dispara.
function medirFaixas() {
  const passo = () => document.querySelectorAll('.faixa-pista')
    .forEach(p => { if (p.clientWidth) atualizarSetas(p); });
  requestAnimationFrame(passo);
  setTimeout(passo, 80);
}
window.addEventListener('resize', medirFaixas);

// Resumo de validade para o cartão do Dashboard. Vencido na frente: é o que
// precisa de ação hoje.
function alertaValidade() {
  let vencidos = 0, perto = 0;
  S.almox.forEach(it => (it.lotes || []).forEach(l => {
    if (!(l.saldo > 0) || !l.validade) return;
    const d = diasAte(l.validade);
    if (d < 0) vencidos++; else if (d <= 30) perto++;
  }));
  if (vencidos) return `${vencidos} lote(s) vencido(s)`;
  if (perto)    return `${perto} lote(s) vencendo em 30 dias`;
  return 'itens de consumo';
}

// ─── LISTA ───────────────────────────────────────────────────
function populateFilters() {
  const fc = document.getElementById('fcat'), fs = document.getElementById('fstat');
  const vc = fc.value, vs = fs.value;
  fc.innerHTML = '<option value="">Todas as categorias</option>' + S.cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  fs.innerHTML = '<option value="">Todos os status</option>'     + S.statusOpts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  fc.value = vc; fs.value = vs;
}
// ─── ORDENAR PELAS COLUNAS ───────────────────────────────────
// Um clique ordena do menor para o maior, o segundo inverte e o terceiro tira a
// ordenação (volta a ordem que veio do banco). Cada lista guarda a sua.
const ordemDaLista = { lista: { col: null, dir: 0 }, almox: { col: null, dir: 0 } };

// Colunas de cada lista: 'valor' é o que entra na comparação (o texto que a
// pessoa lê, não o id), e coluna sem 'chave' não ordena.
const COLUNAS = {
  lista: [
    { chave:'patrimonio',    titulo:'Nº',            tipo:'num', valor:i => i.patrimonio },
    { chave:'nome',          titulo:'Marca',         valor:i => i.nome },
    { chave:'modelo',        titulo:'Modelo',        valor:i => i.modelo },
    { chave:'serie',         titulo:'N° Série',      valor:i => i.serie },
    { chave:'categoria',     titulo:'Categoria',     valor:i => (i.categoria || []).map(id => getCat(id).name).join(', ') },
    { chave:'status',        titulo:'Status',        valor:i => (i.status || []).map(id => getStat(id).name).join(', ') },
    { chave:'local_atual',   titulo:'Local Atual',   valor:i => i.local_atual },
    { chave:'usuario_atual', titulo:'Usuário Atual', valor:i => i.usuario_atual },
    { chave:'movim',         titulo:'Movim.',        tipo:'num', valor:i => (i.historico || []).length },
    { titulo:'Ações' }
  ],
  almox: [
    { chave:'item',      titulo:'Item',               valor:i => i.item },
    { chave:'categoria', titulo:'Categoria',          valor:i => getCatAlmox(i.categoria).name },
    { chave:'modelo',    titulo:'Modelo',             valor:i => i.modelo },
    { chave:'serie',     titulo:'N° Série',           valor:i => i.serie },
    { chave:'saldo',     titulo:'Saldo',              tipo:'num', valor:i => i.saldo },
    { chave:'validade',  titulo:'Validade + próxima', valor:i => i.validadeProxima },
    { chave:'lotes',     titulo:'Lotes',              tipo:'num', valor:i => (i.lotes || []).filter(l => l.saldo > 0).length },
    { chave:'ultima',    titulo:'Última mov.',        valor:i => ((i.historico || []).slice(-1)[0] || {}).data_mov },
    { titulo:'Ações' }
  ]
};

// Linha sem valor na coluna vai para o fim nos DOIS sentidos: ela não é "a
// menor", é a que não tem o dado, e no meio da lista atrapalha a leitura.
function ordenarLinhas(linhas, qual) {
  const est = ordemDaLista[qual];
  if (!est.col || !est.dir) return linhas;
  const col = COLUNAS[qual].find(c => c.chave === est.col);
  if (!col) return linhas;
  const vazio = v => v === null || v === undefined || v === '';
  return [...linhas].sort((a, b) => {
    const va = col.valor(a), vb = col.valor(b);
    if (vazio(va) && vazio(vb)) return 0;
    if (vazio(va)) return 1;
    if (vazio(vb)) return -1;
    if (col.tipo === 'num') {
      const x = Number(va), y = Number(vb);
      if (!isNaN(x) && !isNaN(y)) return (x - y) * est.dir;
    }
    // numeric:true para "000010" vir depois de "000009" mesmo como texto.
    return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true, sensitivity: 'base' }) * est.dir;
  });
}

function cabecalhoOrdenavel(qual) {
  const est = ordemDaLista[qual];
  return COLUNAS[qual].map(c => {
    if (!c.chave) return `<th>${esc(c.titulo)}</th>`;
    const ativa = est.col === c.chave && est.dir;
    const seta  = !ativa ? '↕' : (est.dir > 0 ? '↑' : '↓');
    return `<th class="ord${ativa ? ' ativa' : ''}" onclick="ordenarPor('${escJs(qual)}','${escJs(c.chave)}')"
      title="Ordenar por ${esc(c.titulo)}">${esc(c.titulo)} <span class="ord-seta">${seta}</span></th>`;
  }).join('');
}

function ordenarPor(qual, chave) {
  const est = ordemDaLista[qual];
  if (est.col !== chave)   { est.col = chave; est.dir = 1; }   // 1º clique: crescente
  else if (est.dir === 1)  { est.dir = -1; }                   // 2º: decrescente
  else                     { est.col = null; est.dir = 0; }    // 3º: sem ordenação
  if (qual === 'almox') renderAlmox(); else renderLista();
}

function renderLista() {
  const srch  = (document.getElementById('srch').value||'').toLowerCase();
  const catF  = document.getElementById('fcat').value;
  const statF = document.getElementById('fstat').value;
  // A busca olha todos os campos de texto da linha: quem procura digita o que
  // está vendo na tela — às vezes o número, às vezes o nome de quem está com o
  // bem ou o setor onde ele fica.
  const camposBusca = i => [i.patrimonio, i.nome, i.modelo, i.serie, i.local_atual, i.usuario_atual];
  const filtered = S.items.filter(i => {
    if (srch && !camposBusca(i).some(v => (v || '').toLowerCase().includes(srch))) return false;
    if (catF  && !(i.categoria||[]).includes(catF))  return false;
    if (statF && !(i.status||[]).includes(statF))    return false;
    return true;
  });
  // A exportação leva a lista como ela está na tela, ordenação inclusive.
  const ordenados = ordenarLinhas(filtered, 'lista');
  S.lastFiltered = ordenados;
  document.getElementById('lista-head').innerHTML = cabecalhoOrdenavel('lista');
  document.getElementById('lista-tbody').innerHTML = ordenados.length
    ? ordenados.map(it => `<tr>
        <td><strong>${esc(it.patrimonio||'—')}</strong></td>
        <td>${esc(it.nome||'—')}</td>
        <td>${esc(it.modelo||'—')}</td>
        <td>${esc(it.serie||'—')}</td>
        <td>${catPills(it.categoria)}</td>
        <td>${statPills(it.status)}</td>
        <td>${esc(it.local_atual||'—')}</td>
        <td>${esc(it.usuario_atual||'—')}</td>
        <td><span class="badge b-gray">${(it.historico||[]).length}</span></td>
        <td>${actionButtons(it.id)}</td>
      </tr>`).join('')
    : '<tr class="empty-row"><td colspan="10">Nenhum resultado encontrado</td></tr>';
}

// ─── FORMULÁRIO ──────────────────────────────────────────────
let msState = {};
let movMode = false;

function renderForm() {
  atualizarTipoSwitch();
  // O seletor Patrimônio | Almoxarifado do topo manda aqui. renderForm continua
  // sendo a única porta de entrada porque o leitor de código de barras se
  // pendura nela (mobile-scanner.js) — os dois formulários têm o campo f_serie.
  if (S.tipoCadastro === 'almoxarifado') return renderFormAlmox();

  msState = {};
  const it     = S.editId != null ? (S.items.find(x => x.id === S.editId) || {}) : {};
  const isEdit = S.editId != null;
  document.getElementById(alvoForm().titulo).textContent = movMode
    ? 'Registrar Movimentação'
    : (isEdit ? 'Editar Patrimônio' : 'Novo Patrimônio');

  let h = '<form onsubmit="saveItem(event)"><div class="form-two-col">';

  if (!movMode) {
    h += `<div class="scard">
      <div class="scard-title"><i class="ti ti-clipboard-list"></i> Dados do Patrimônio
      </div>
      <div class="form-grid">
        <div class="fg"><label class="flabel">Nº Patrimônio<span class="req">*</span></label>
          <input class="finput" id="f_patrimonio" value="${esc(it.patrimonio||'')}" required placeholder="Ex: 001"></div>
        <div class="fg"><label class="flabel">Marca<span class="req">*</span></label>
          <input class="finput" id="f_nome" value="${esc(it.nome||'')}" required placeholder="Ex: Dell, Epson, Samsung"></div>
        <div class="fg"><label class="flabel">Modelo<span class="req">*</span></label>
          <input class="finput" id="f_modelo" value="${esc(it.modelo||'')}" required placeholder="Ex: Vostro 3500, L3250"></div>
        <div class="fg"><label class="flabel">N° de Série<span class="req">*</span></label>
          <input class="finput" id="f_serie" value="${esc(it.serie||'')}" required placeholder="Ex: SN-0001-XYZ"></div>
        <div class="fg"><label class="flabel">Categoria<span class="req">*</span></label>
          <select class="finput" id="f_categoria">
            <option value="">Selecione...</option>
            ${S.cats.map(x=>`<option value="${esc(x.id)}"${Array.isArray(it.categoria)&&it.categoria[0]===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}
          </select></div>
        <div class="fg"><label class="flabel">Status<span class="req">*</span></label>
          <select class="finput" id="f_status">
            <option value="">Selecione...</option>
            ${S.statusOpts.map(x=>`<option value="${esc(x.id)}"${Array.isArray(it.status)&&it.status[0]===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}
          </select></div>
      </div>
    </div>`;
  }

  if (movMode) {
    const it2 = S.items.find(x => x.id === S.editId) || {};
    h += `<div class="scard" style="background:var(--accent-bg);border-color:var(--accent)">
      <div style="font-size:13px;margin-bottom:.75rem;color:var(--accent-txt);font-weight:600">
        <i class="ti ti-info-circle"></i> Movimentando:<br><strong>${esc(it2.patrimonio||'')} — ${esc(it2.nome||'')} ${esc(it2.modelo||'')}</strong>
        <div style="margin-top:.5rem">${statPills(it2.status)}</div>
      </div>
    </div>`;
  }

  h += `<div class="${movMode?'scard':'mov-card'}">
    <div class="scard-title"><i class="ti ti-transfer"></i> Dados da Movimentação
    </div>
    <div class="form-grid">
      <div class="fg"><label class="flabel">Data de Movimentação</label>
        <input class="finput" type="date" id="f_data_mov"></div>
      <div class="fg"><label class="flabel">Entrada ou Saída?</label>
        ${(movMode || isEdit)
          ? `<select class="finput" id="f_quem_recebeu_retirou" onchange="onEntradaSaidaChange()">
               <option value="">Selecione...</option>
               <option value="Entrada">📥 Entrada</option>
               <option value="Saída">📤 Saída</option>
             </select>`
          : `<input class="finput" value="📥 Entrada" disabled title="Cadastrar o bem é a entrada dele; saída se registra em Movimentar">`}
        </div>
      <div class="fg"><label class="flabel">Usuário Atual</label>
        <input class="finput" id="f_usuario_atual" placeholder="Nome do usuário atual" value="${(!movMode && it.usuario_atual) ? esc(it.usuario_atual) : ''}"></div>
      <div class="fg"><label class="flabel">Local Atual</label>
        <select class="finput" id="f_local_atual"><option value="">Selecione...</option>
          ${S.locais.map(l=>`<option${(!movMode && it.local_atual===l)?' selected':''}>${esc(l)}</option>`).join('')}
        </select></div>
      ${movMode ? `<div class="fg"><label class="flabel">Status</label>
        <select class="finput" id="f_status">
          <option value="">— manter o atual —</option>
          ${S.statusOpts.map(x=>`<option value="${esc(x.id)}"${Array.isArray(it.status)&&it.status[0]===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}
        </select></div>` : ''}
      <div class="fg full"><label class="flabel">Observações da Movimentação</label>
        <textarea class="finput" id="f_obs_mov" rows="3" style="resize:vertical" placeholder="Descreva esta movimentação..."></textarea></div>
    </div>
  </div>`;

  h += '</div>'; // fecha form-two-col

  if (isEdit || movMode) {
    const itH = S.items.find(x => x.id === S.editId) || {};
    const hist = itH.historico || [];
    h += `<div class="hist-card">
      <div class="hist-card-title"><i class="ti ti-history" style="color:var(--accent)"></i> Histórico de Movimentações
        <span class="badge b-gray" style="margin-left:6px">${hist.length}</span>
      </div>`;
    if (hist.length) {
      h += `<div class="hist-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:.75rem">`;
      h += [...hist].reverse().map(hv => `
        <div class="hist-item">
          <div class="hist-meta">${fmtDT(hv.timestamp)} · ${hv.tipo==='entrada'?'📥 Entrada':'🔄 Movimentação'}</div>
          <div class="hist-detail">
            ${hv.data_mov ? `<span>Data: <strong>${fmtDate(hv.data_mov)}</strong>&nbsp;·&nbsp;</span>` : ''}
            ${hv.quem_recebeu_retirou ? `<span><strong>${esc(hv.quem_recebeu_retirou)}</strong>&nbsp;·&nbsp;</span>` : ''}
            ${hv.usuario_atual ? `<span>Usuário: <strong>${esc(hv.usuario_atual)}</strong>&nbsp;·&nbsp;</span>` : ''}
            ${hv.local ? `<span>Local: <strong>${esc(hv.local)}</strong>&nbsp;·&nbsp;</span>` : ''}
            ${hv.status ? `<span>Status: ${statPills([hv.status])}</span>` : ''}
            ${hv.obs_mov ? `<div style="margin-top:3px;color:var(--txt2)">📝 ${esc(hv.obs_mov)}</div>` : ''}
          </div>
        </div>`).join('');
      h += '</div>';
    } else {
      h += '<div style="color:var(--txt3);font-size:13px;padding:.5rem 0">Nenhuma movimentação registrada ainda.</div>';
    }
    h += '</div>';
  }

  h += `<div class="form-actions-row">
    <button type="button" class="btn btn-ghost" onclick="cancelEdit()">Cancelar</button>
    <button type="submit" class="btn btn-primary" id="save-btn"><i class="ti ti-device-floppy"></i> ${movMode?'Registrar Movimentação':(isEdit?'Salvar Alterações':'Cadastrar')}</button>
  </div></form>`;

  document.getElementById(alvoForm().wrap).innerHTML = h;
  document.getElementById(alvoForm().alerta).style.display = 'none';
  // Os vínculos de Entrada/Saída (Personalizar) NÃO são aplicados sozinhos no
  // cadastro. Foram, por um tempo: como o cadastro é sempre entrada, parecia
  // coerente já filtrar Status e Local. O efeito na prática foi outro — um
  // vínculo marcado meses antes escondia quase todos os locais na hora de
  // cadastrar, e quem cadastrava não tinha como saber por quê. O filtro
  // continua valendo onde a pessoa escolhe entrada ou saída na hora
  // (Movimentar e edição), que é onde ele foi pensado.
}

// Igual ao almoxarifado, onde o item nasce da primeira entrada: cadastrar um
// patrimônio É a entrada dele, então o campo vem travado em Entrada no cadastro
// novo. Na edição e no Movimentar continua seletor — ali a movimentação
// registrada junto pode ser entrada ou saída.
function tipoMovDoForm() {
  const sel = document.getElementById('f_quem_recebeu_retirou');
  return sel ? (sel.value || '') : 'Entrada';   // sem seletor = cadastro novo
}

function onEntradaSaidaChange() {
  const tipo = tipoMovDoForm();
  const v    = S.vinculos || {};
  const cfg  = tipo === 'Entrada' ? v.entrada : tipo === 'Saída' ? v.saida : null;

  const statSel = document.getElementById('f_status');
  if (statSel) {
    const allowedStat = cfg?.statusIds?.length ? cfg.statusIds : null;
    const prevVal = statSel.value;
    const vazio = movMode ? '— manter o atual —' : 'Selecione...';
    statSel.innerHTML = `<option value="">${vazio}</option>` +
      S.statusOpts.filter(s => !allowedStat || allowedStat.includes(s.id))
        .map(s => `<option value="${esc(s.id)}"${prevVal===s.id?' selected':''}>${esc(s.name)}</option>`).join('');
    if (allowedStat && !Array.from(statSel.options).some(o => o.value === prevVal)) statSel.value = '';
  }

  const localSel = document.getElementById('f_local_atual');
  if (localSel) {
    const allowedLoc = cfg?.localIds?.length ? cfg.localIds : null;
    const prevVal = localSel.value;
    localSel.innerHTML = '<option value="">Selecione...</option>' +
      S.locais.map((l,i) => (!allowedLoc || allowedLoc.includes(String(i))) ? `<option${prevVal===l?' selected':''}>${esc(l)}</option>` : '').join('');
    if (allowedLoc && !Array.from(localSel.options).some(o => o.value === prevVal)) localSel.value = '';
  }
}

// Botão "Novo" do topo: segue a aba em que a pessoa está.
function novoRegistro() {
  if (document.querySelector('.page.active')?.id === 'page-almoxarifado') return novoAlmox();
  S.tipoCadastro = 'patrimonio'; S.editId = null; movMode = false;
  nav('cadastro');
}

function editItem(id)          { S.editId = id; movMode = false; S.tipoCadastro = 'patrimonio'; abrirFormModal(); }
function novaMovimentacao(id)  { S.editId = id; movMode = true;  S.tipoCadastro = 'patrimonio'; abrirFormModal(); }

function cancelEdit() {
  const voltarPara = S.tipoCadastro === 'almoxarifado' ? 'almoxarifado' : 'lista';
  S.editId = null; S.editAlmoxId = null;
  movMode = false; movModeAlmox = false;
  voltarDoForm(voltarPara);
}

// O seletor só aparece em cadastro NOVO: ao editar ou movimentar, o tipo já
// está decidido pelo item que se abriu, e trocá-lo ali só geraria confusão.
function atualizarTipoSwitch() {
  const el = document.getElementById('tipo-cadastro');
  if (!el) return;
  const novo = S.editId == null && S.editAlmoxId == null && !movMode && !movModeAlmox;
  el.style.display = novo ? '' : 'none';
  el.querySelectorAll('.tipo-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.tipo === S.tipoCadastro));
}

async function delItem(id) {
  if (!can('excluir')) { showToast('Sem permissão para excluir patrimônios.','err'); return; }
  if (!confirm('Excluir este patrimônio e todo o histórico?')) return;
  showLoading('Excluindo...');
  try {
    await DB.deleteItem(id);
    S.items = S.items.filter(x => x.id !== id);
    showToast('Patrimônio excluído.');
    renderLista();
  } catch(e) { showToast('Erro ao excluir: ' + e.message, 'err'); }
  finally    { hideLoading(); }
}

async function saveItem(e) {
  e.preventDefault();
  if (!can('cadastrar')) { showToast('Sem permissão para salvar patrimônios.','err'); return; }
  const btn = document.getElementById('save-btn');
  btn.disabled = true;

  const data_mov            = document.getElementById('f_data_mov')?.value || '';
  const quem_recebeu_retirou = tipoMovDoForm();
  const local               = document.getElementById('f_local_atual')?.value || '';
  const usuario_atual       = document.getElementById('f_usuario_atual')?.value || '';
  const obs_mov             = document.getElementById('f_obs_mov')?.value || '';
  const status              = document.getElementById('f_status')?.value || '';
  const mov = { data_mov, quem_recebeu_retirou, local, usuario_atual, obs_mov, status };

  showLoading('Salvando...');
  try {
    if (movMode) {
      await DB.registrarMovimentacao(S.editId, mov);
      showToast('✅ Movimentação registrada!');
      movMode = false; S.editId = null;
    } else {
      const patrimonio = document.getElementById('f_patrimonio').value.trim();
      const nome       = document.getElementById('f_nome').value.trim();      // Marca
      const modelo     = document.getElementById('f_modelo').value.trim();
      const serie      = document.getElementById('f_serie').value.trim();
      const catVal     = document.getElementById('f_categoria').value;
      const statVal    = document.getElementById('f_status').value;

      if (!patrimonio) { showToast('Preencha o Nº Patrimônio.','err'); return; }
      if (!nome)       { showToast('Preencha a Marca.','err'); return; }
      if (!modelo)     { showToast('Preencha o Modelo.','err'); return; }
      if (!serie)      { showToast('Preencha o N° de Série.','err'); return; }
      if (!catVal)     { showToast('Selecione uma categoria.','err'); return; }
      if (!statVal)    { showToast('Selecione um status.','err'); return; }

      const item = { patrimonio, nome, modelo, serie, categoria:[catVal], status:[statVal] };

      if (S.editId != null) {
        await DB.updateItem(S.editId, item);
        // Registra movimentação se preencheu dados
        if (data_mov || quem_recebeu_retirou || obs_mov || local)
          await DB.registrarMovimentacao(S.editId, mov);
        showToast('✅ Patrimônio atualizado!');
      } else {
        await DB.createItem(item, mov);
        showToast('✅ Patrimônio cadastrado!');
      }
      S.editId = null;
    }
    // Recarrega lista
    S.items = await DB.loadItems();
    voltarDoForm('lista');
  } catch(ex) {
    showToast('Erro ao salvar: ' + ex.message, 'err');
    console.error(ex);
  } finally {
    hideLoading();
    btn.disabled = false;
  }
}

// ─── CONFIG ───────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.stab-panel').forEach(p => p.style.display='none');
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).style.display = 'block';
  const map = {tc:0,ta:1,tp:2,tl:3,ts:4,tv:5};
  document.querySelectorAll('.stab')[map[id]]?.classList.add('active');
  renderConfig();
}
function renderConfig() { renderCats(); renderCatsAlmox(); renderPessoas(); renderLocais(); renderStatOpts(); renderVinculos(); }

// ─── OPÇÕES DO PERSONALIZAR: EDITAR E EXCLUIR ────────────────
// Cada etiqueta tem lápis e ×. Antes só havia o ×, e corrigir um nome ou uma
// cor obrigava a excluir e criar de novo — o que trocava o id da opção e
// deixava todo patrimônio que a usava apontando para o vazio.
const OPCOES = {
  cat:      { titulo: 'categoria',              lista: () => S.cats,      cor: true,  onde: 'patrimônio(s)' },
  status:   { titulo: 'opção de status',        lista: () => S.statusOpts, cor: true, onde: 'patrimônio(s)' },
  catAlmox: { titulo: 'categoria do almoxarifado', lista: () => S.catsAlmox, cor: true, onde: 'item(ns)' },
  local:    { titulo: 'local',                  texto: () => S.locais,    onde: 'patrimônio(s)' },
  pessoa:   { titulo: 'pessoa',                 texto: () => S.pessoas,   onde: 'patrimônio(s)' }
};

// O valor guardado na opção: id para as que têm id, o próprio texto para local
// e pessoa (é assim que o patrimônio referencia cada uma).
function valorDaOpcao(tipo, chave) {
  const cfg = OPCOES[tipo];
  if (cfg.texto) return cfg.texto()[chave];
  const item = cfg.lista().find(x => String(x.id) === String(chave));
  return item ? item.id : null;
}

function nomeDaOpcao(tipo, chave) {
  const cfg = OPCOES[tipo];
  if (cfg.texto) return cfg.texto()[chave] || '';
  const item = cfg.lista().find(x => String(x.id) === String(chave));
  return item ? item.name : '';
}

// Quantos registros usam a opção AGORA. O histórico não entra: ele é registro
// do passado e, se contasse, um local antigo nunca mais poderia ser excluído.
function usosDaOpcao(tipo, chave) {
  const v = valorDaOpcao(tipo, chave);
  if (v == null) return 0;
  switch (tipo) {
    case 'cat':      return S.items.filter(i => (i.categoria || []).includes(v)).length;
    case 'status':   return S.items.filter(i => (i.status || []).includes(v)).length;
    case 'catAlmox': return S.almox.filter(i => i.categoria === v).length;
    case 'local':    return S.items.filter(i => i.local_atual === v).length;
    case 'pessoa':   return S.items.filter(i => i.usuario_atual === v).length;
  }
  return 0;
}

function acoesTag(tipo, chave) {
  return `<span class="tedit" title="Editar" onclick="editarOpcao('${escJs(tipo)}','${escJs(chave)}')">✎</span>` +
         `<span class="tdel" title="Excluir" onclick="excluirOpcao('${escJs(tipo)}','${escJs(chave)}')"><i class="ti ti-trash"></i></span>`;
}

let _opcaoEditando = null;

function editarOpcao(tipo, chave) {
  const cfg = OPCOES[tipo]; if (!cfg) return;
  _opcaoEditando = { tipo, chave };
  const nome = nomeDaOpcao(tipo, chave);
  document.getElementById('op-titulo').textContent = 'Editar ' + cfg.titulo;
  document.getElementById('op-sub').textContent = cfg.texto
    ? 'O nome novo entra também nos registros que já usam este ' + cfg.titulo + '.'
    : 'Os registros que usam esta opção passam a mostrar o nome novo.';
  const campoNome = document.getElementById('op-nome');
  campoNome.value = nome;
  const cor = document.getElementById('op-cor');
  cor.style.display = cfg.cor ? '' : 'none';
  if (cfg.cor) cor.value = corSegura((cfg.lista().find(x => String(x.id) === String(chave)) || {}).color);
  document.getElementById('opcao-modal').style.display = 'flex';
  campoNome.focus();
  campoNome.select();
}

function fecharOpcao() {
  document.getElementById('opcao-modal').style.display = 'none';
  _opcaoEditando = null;
}

async function salvarOpcao() {
  if (!_opcaoEditando) return;
  const { tipo, chave } = _opcaoEditando;
  const cfg = OPCOES[tipo];
  const nome = document.getElementById('op-nome').value.trim();
  if (!nome) { showToast('Informe o nome.', 'err'); return; }

  const nomeAntigo = nomeDaOpcao(tipo, chave);
  const jaExiste = cfg.texto
    ? cfg.texto().some((v, i) => i !== Number(chave) && v.toLowerCase() === nome.toLowerCase())
    : cfg.lista().some(x => String(x.id) !== String(chave) && (x.name || '').toLowerCase() === nome.toLowerCase());
  if (jaExiste) { showToast('Já existe uma opção com esse nome.', 'err'); return; }

  const btn = document.getElementById('op-salvar');
  btn.disabled = true;
  showLoading('Salvando...');
  try {
    if (cfg.texto) {
      // Local e pessoa vivem como texto dentro dos registros: o servidor troca
      // o nome neles antes de a lista mudar, senão o que já existe fica órfão.
      if (nome !== nomeAntigo) {
        const r = await DB.renomearOpcao(tipo, nomeAntigo, nome);
        cfg.texto()[Number(chave)] = nome;
        await persistConfig();
        S.items = await DB.loadItems();
        if (tipo === 'pessoa') { try { S.almox = await DB.loadAlmox(); } catch (e) { /* sem almoxarifado */ } }
        showToast(`✅ Renomeado em ${r.alterados} registro(s).`);
      }
    } else {
      const item = cfg.lista().find(x => String(x.id) === String(chave));
      if (item) { item.name = nome; if (cfg.cor) item.color = document.getElementById('op-cor').value; }
      await persistConfig();
      showToast('✅ Opção atualizada!');
    }
    fecharOpcao();
    renderConfig();
    populateFilters(); renderLista();
    if (tipo === 'catAlmox' || tipo === 'pessoa') { populateFiltersAlmox(); renderAlmox(); }
  } catch (e) {
    showToast('Erro ao salvar: ' + e.message, 'err');
  } finally {
    hideLoading();
    btn.disabled = false;
  }
}

// Excluir passa por confirmação — e é recusado enquanto alguém estiver usando
// a opção, para não deixar registro apontando para o que não existe mais.
async function excluirOpcao(tipo, chave) {
  const cfg = OPCOES[tipo]; if (!cfg) return;
  const nome = nomeDaOpcao(tipo, chave);
  const usos = usosDaOpcao(tipo, chave);
  if (usos) {
    showToast(`"${nome}" está em uso em ${usos} ${cfg.onde} — troque esses registros antes de excluir.`, 'err');
    return;
  }
  const ok = await confirmar({
    titulo: 'Excluir ' + cfg.titulo,
    texto: `Excluir <strong>${esc(nome)}</strong>? Ninguém está usando esta opção agora, e ela some da lista de escolhas.`,
    botao: 'Excluir'
  });
  if (!ok) return;
  if (tipo === 'cat')      delCat(chave);
  if (tipo === 'status')   delStat(chave);
  if (tipo === 'catAlmox') delCatAlmox(chave);
  if (tipo === 'local')    delLocal(Number(chave));
  if (tipo === 'pessoa')   delPess(Number(chave));
}

function renderCats() {
  const el = document.getElementById('cat-cloud'); if (!el) return;
  el.innerHTML = S.cats.map(c => `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${corSegura(c.color)};display:inline-block;margin-right:3px"></span>${esc(c.name)}${acoesTag('cat', c.id)}</div>`).join('');
}
function addCat() {
  const n = document.getElementById('ncat').value.trim();
  const col = document.getElementById('ncat-color').value;
  if (!n) return;
  S.cats.push({id:'c'+Date.now(), name:n, color:col});
  persistConfig(); renderCats(); document.getElementById('ncat').value = '';
}
function delCat(id) { S.cats = S.cats.filter(c => c.id!==id); persistConfig(); renderCats(); populateFilters(); renderLista(); }

function renderPessoas() {
  const el = document.getElementById('pess-cloud'); if (!el) return;
  el.innerHTML = S.pessoas.map((p,i) => `<div class="tag">${esc(p)}${acoesTag('pessoa', i)}</div>`).join('');
}
function addPess() {
  const v = document.getElementById('npess').value.trim();
  if (!v || S.pessoas.includes(v)) return;
  S.pessoas.push(v); persistConfig(); renderPessoas(); document.getElementById('npess').value = '';
}
function delPess(i) { S.pessoas.splice(i,1); persistConfig(); renderPessoas(); }

function renderLocais() {
  const el = document.getElementById('loc-cloud'); if (!el) return;
  el.innerHTML = S.locais.map((l,i) => `<div class="tag">${esc(l)}${acoesTag('local', i)}</div>`).join('');
}
function addLoc() {
  const v = document.getElementById('nloc').value.trim();
  if (!v || S.locais.includes(v)) return;
  S.locais.push(v); persistConfig(); renderLocais(); document.getElementById('nloc').value = '';
}
function delLocal(i) { S.locais.splice(i,1); persistConfig(); renderLocais(); }

function renderStatOpts() {
  const el = document.getElementById('stat-cloud'); if (!el) return;
  el.innerHTML = S.statusOpts.map(s => `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${corSegura(s.color)};display:inline-block;margin-right:3px"></span>${esc(s.name)}${acoesTag('status', s.id)}</div>`).join('');
}
function addStat() {
  const n = document.getElementById('nstat').value.trim();
  const col = document.getElementById('nstat-color').value;
  if (!n) return;
  S.statusOpts.push({id:'s'+Date.now(), name:n, color:col});
  persistConfig(); renderStatOpts(); document.getElementById('nstat').value = '';
}
function delStat(id) { S.statusOpts = S.statusOpts.filter(s => s.id!==id); persistConfig(); renderStatOpts(); populateFilters(); renderLista(); }

function renderVinculos() {
  const el = document.getElementById('tv'); if (!el || el.style.display==='none') return;
  const v = S.vinculos;
  function checkboxes(tipo, field, items, labelFn, idFn) {
    const sel = (v[tipo]?.[field]) || [];
    return items.map((item,i) => {
      const id = idFn(item,i); const lbl = labelFn(item); const chk = sel.includes(id)?'checked':'';
      return `<label class="chk-row">
        <input type="checkbox" ${chk} onchange="toggleVinculo('${tipo}','${field}','${escJs(id)}',this.checked)">
        ${esc(lbl)}</label>`;
    }).join('') || '<div style="color:var(--txt3);font-size:12.5px">Nenhuma opção cadastrada</div>';
  }
  el.innerHTML = `<div class="card" style="padding:1.25rem">
    <p style="font-size:13px;color:var(--txt3);margin-bottom:1.25rem;line-height:1.6">
      <i class="ti ti-info-circle" style="color:var(--accent)"></i>
      Configure quais <strong>Status</strong> e <strong>Locais</strong> ficam disponíveis ao selecionar <strong>Entrada</strong> ou <strong>Saída</strong>.<br>
      <span style="font-size:12px">Deixar tudo desmarcado = sem restrição.</span>
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--txt);margin-bottom:.875rem;padding-bottom:.5rem;border-bottom:2px solid #22c55e">📥 Entrada</div>
        <div style="font-size:12px;font-weight:600;color:var(--txt2);margin-bottom:.5rem">Status permitidos</div>
        ${checkboxes('entrada','statusIds',S.statusOpts,s=>s.name,s=>s.id)}
        <div style="font-size:12px;font-weight:600;color:var(--txt2);margin-top:1rem;margin-bottom:.5rem">Locais permitidos</div>
        ${checkboxes('entrada','localIds',S.locais,l=>l,(l,i)=>String(i))}
      </div>
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--txt);margin-bottom:.875rem;padding-bottom:.5rem;border-bottom:2px solid #f97316">📤 Saída</div>
        <div style="font-size:12px;font-weight:600;color:var(--txt2);margin-bottom:.5rem">Status permitidos</div>
        ${checkboxes('saida','statusIds',S.statusOpts,s=>s.name,s=>s.id)}
        <div style="font-size:12px;font-weight:600;color:var(--txt2);margin-top:1rem;margin-bottom:.5rem">Locais permitidos</div>
        ${checkboxes('saida','localIds',S.locais,l=>l,(l,i)=>String(i))}
      </div>
    </div>
  </div>`;
}
function toggleVinculo(tipo, field, id, checked) {
  if (!S.vinculos[tipo]) S.vinculos[tipo] = { statusIds:[], localIds:[] };
  const arr = S.vinculos[tipo][field] || [];
  S.vinculos[tipo][field] = checked ? [...arr.filter(x=>x!==id), id] : arr.filter(x=>x!==id);
  persistConfig();
}

// ─── AUDITORIA ───────────────────────────────────────────────
let _auditFiltro = '';
let _auditLogs   = [];

async function renderAuditoria() {
  const el = document.getElementById('audit-body');
  if (!el) return;
  el.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--txt3)">
    <div style="display:inline-block;width:22px;height:22px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite"></div>
    <div style="margin-top:.5rem;font-size:13px">Carregando auditoria...</div>
  </td></tr>`;
  try {
    _auditLogs = await DB.loadAuditoria(200);
    _renderAuditRows(_auditLogs);
  } catch(e) {
    el.innerHTML = `<tr><td colspan="5" style="color:var(--danger-txt);padding:1rem;font-size:13px">
      <strong>Erro ao carregar auditoria:</strong> ${esc(e.message)}<br>
      <span style="font-size:12px;color:var(--txt3)">Se a tabela não existir, rode api/sql/02_schema.sql no banco ESTOQUE_TI.</span>
    </td></tr>`;
  }
}

function _renderAuditRows(logs) {
  const el = document.getElementById('audit-body'); if (!el) return;
  const srch = _auditFiltro.toLowerCase();
  const filtered = srch
    ? logs.filter(r => (r.descricao||'').toLowerCase().includes(srch) || (r.usuario||'').toLowerCase().includes(srch))
    : logs;

  const iconMap = { INSERT:'ti-plus', UPDATE:'ti-edit', DELETE:'ti-trash' };
  const colorMap = { INSERT:'#059669', UPDATE:'#d97706', DELETE:'#dc2626' };
  const labelMap = { INSERT:'Cadastro', UPDATE:'Edição', DELETE:'Exclusão' };
  const tabelaMap = { patrimonio:'Patrimônio', movimentacao:'Movimentação', config:'Configuração', usuario:'Usuário' };

  el.innerHTML = filtered.length ? filtered.map(r => `
    <tr>
      <td style="white-space:nowrap;color:var(--txt3);font-size:12px">${_fmtDTAudit(r.criado_em)}</td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:20px;font-size:11.5px;font-weight:600;background:${colorMap[r.acao]}22;color:${colorMap[r.acao]}">
          <i class="ti ${iconMap[r.acao]||'ti-circle'}"></i> ${esc(labelMap[r.acao]||r.acao)}
        </span>
        <span style="font-size:11px;color:var(--txt3);margin-left:5px">${esc(tabelaMap[r.tabela]||r.tabela)}</span>
      </td>
      <td style="font-size:13px">${esc(r.descricao||'—')}</td>
      <td style="font-size:12px;color:var(--txt2)">${esc(r.usuario||'—')}</td>
      <td>
        ${r.dados_antes||r.dados_depois ? `<button class="btn btn-sm btn-ghost" onclick="showAuditDetail(${r.id})" style="font-size:11px">
          <i class="ti ti-eye"></i> Ver
        </button>` : '—'}
      </td>
    </tr>`).join('')
  : '<tr class="empty-row"><td colspan="5">Nenhum registro encontrado</td></tr>';

  // Guarda logs no estado para o modal de detalhe
  window._auditLogs = logs;
}

function _fmtDTAudit(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
  catch(e) { return ts; }
}

function filterAudit() {
  _auditFiltro = document.getElementById('audit-srch')?.value || '';
  if (window._auditLogs) _renderAuditRows(window._auditLogs);
}

function showAuditDetail(id) {
  const r = (window._auditLogs||[]).find(x => x.id === id); if (!r) return;
  // O JSON guarda o que foi digitado (marca, modelo...) — escapado como o resto.
  const fmt = obj => obj ? esc(JSON.stringify(obj, null, 2)) : 'N/A';
  const el = document.getElementById('audit-detail-modal');
  document.getElementById('audit-detail-body').innerHTML = `
    <div style="margin-bottom:1rem">
      <div style="font-size:12px;font-weight:600;color:var(--txt2);margin-bottom:4px">DESCRIÇÃO</div>
      <div style="font-size:14px">${esc(r.descricao||'—')}</div>
    </div>
    ${r.dados_antes ? `
    <div style="margin-bottom:1rem">
      <div style="font-size:12px;font-weight:600;color:#dc2626;margin-bottom:4px">ANTES</div>
      <pre style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:.75rem;font-size:11.5px;overflow-x:auto;color:var(--txt)">${fmt(r.dados_antes)}</pre>
    </div>` : ''}
    ${r.dados_depois ? `
    <div>
      <div style="font-size:12px;font-weight:600;color:#059669;margin-bottom:4px">DEPOIS</div>
      <pre style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:.75rem;font-size:11.5px;overflow-x:auto;color:var(--txt)">${fmt(r.dados_depois)}</pre>
    </div>` : ''}`;
  el.style.display = 'flex';
}

// ─── CONFIRMAÇÃO ─────────────────────────────────────────────
// Substitui o confirm() do navegador em ações destrutivas: a caixa do
// Windows não cabe o motivo, não deixa destacar o botão perigoso e não
// se parece com o resto do sistema.
//
// Devolve uma promessa que resolve true/false, então quem chama continua
// lendo como um if — só que com await.
let _confirmResolve = null;

function confirmar({ titulo, texto, botao = 'Confirmar' }) {
  return new Promise(resolve => {
    // Se já houver uma confirmação aberta, ela é respondida como "não"
    // antes de abrir a nova — senão a promessa anterior ficaria pendurada
    // para sempre e o clique seria engolido.
    if (_confirmResolve) { _confirmResolve(false); }
    _confirmResolve = resolve;
    document.getElementById('cf-titulo').textContent = titulo;
    document.getElementById('cf-texto').innerHTML    = texto;
    const ok = document.getElementById('cf-ok');
    ok.textContent = botao;
    ok.style.cssText = 'background:var(--danger-txt);border-color:var(--danger-txt);color:#fff';
    document.getElementById('confirm-modal').style.display = 'flex';
  });
}

function _fecharConfirm(valor) {
  document.getElementById('confirm-modal').style.display = 'none';
  const resolve = _confirmResolve;
  _confirmResolve = null;
  if (resolve) resolve(valor);
}

// ─── SENHAS ──────────────────────────────────────────────────
// Regra única, e escrita uma vez só: antes cada tela repetia o
// próprio "mínimo de N caracteres" e elas podiam divergir da API.
const SENHA_MIN = 4;

// Alterna entre esconder e mostrar a senha do campo indicado.
// Digitar senha às cegas é digitar errado — e quando é o cadastro de
// outra pessoa, o erro só aparece quando ela tenta entrar.
function toggleSenha(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  const estavaVisivel = el.type === 'text';
  el.type = estavaVisivel ? 'password' : 'text';
  btn.innerHTML = `<i class="ti ti-${estavaVisivel ? 'eye' : 'eye-off'}"></i>`;
  btn.setAttribute('aria-label', estavaVisivel ? 'Mostrar senha' : 'Ocultar senha');
  el.focus();
}

// Devolve a mensagem de erro, ou null se a dupla está válida.
function validarSenha(senha, confirmacao) {
  if (senha.length < SENHA_MIN) return `A senha precisa ter ao menos ${SENHA_MIN} caracteres.`;
  if (senha !== confirmacao)    return 'As senhas não coincidem.';
  return null;
}

// ─── USUÁRIOS ────────────────────────────────────────────────
const PAPEL_LABELS = { admin:'👑 Admin', editor:'✏️ Editor', leitor:'👁️ Leitor' };
const PAPEL_COLORS = { admin:'#7c3aed', editor:'#2563eb', leitor:'#059669' };

async function renderUsuarios() {
  const el = document.getElementById('usuarios-body');
  if (!el) return;
  el.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem">
    <div style="display:inline-block;width:22px;height:22px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite"></div>
  </td></tr>`;
  try {
    const users = await DB.loadUsers();
    _renderUserRows(users);
  } catch(e) {
    el.innerHTML = `<tr><td colspan="5" style="color:var(--danger-txt);padding:1rem">Erro: ${esc(e.message)}</td></tr>`;
  }
}

function _renderUserRows(users) {
  const el = document.getElementById('usuarios-body'); if (!el) return;
  // Compara pelo login, que é a identidade de verdade. Antes isto batia o
  // texto exibido no topbar — se dois usuários tivessem o mesmo nome de
  // exibição, o crachá "você" aparecia na linha errada.
  const meuLogin = Auth.getUser()?.login;

  el.innerHTML = users.map(u => {
    const isMe   = u.login === meuLogin;
    const rcolor = PAPEL_COLORS[u.papel] || '#888';
    const rlabel = PAPEL_LABELS[u.papel] || u.papel;
    return `<tr style="${!u.ativo?'opacity:.5':''}">
      <td>
        <div style="font-weight:600;font-size:13px">${esc(u.nome || '—')}</div>
        <div style="font-size:11.5px;color:var(--txt3)">${esc(u.login)}</div>
        ${isMe?`<span style="font-size:10px;background:#22c55e22;color:#16a34a;padding:1px 6px;border-radius:10px">você</span>`:''}
      </td>
      <td>
        <span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:${rcolor}22;color:${rcolor}">${esc(rlabel)}</span>
      </td>
      <td>
        <span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500;background:${u.ativo?'#dcfce7':'#fee2e2'};color:${u.ativo?'#166534':'#991b1b'}">
          ${u.ativo ? '✓ Ativo' : '✗ Inativo'}
        </span>
      </td>
      <td style="font-size:12px;color:var(--txt3)">${_fmtDTAudit(u.criado_em)}</td>
      <td>
        <div class="actions-cell" style="gap:6px">
          <button class="btn btn-sm" onclick="openEditUser(${u.id},'${escJs(u.nome||'')}','${escJs(u.papel)}')" title="Editar"><i class="ti ti-edit"></i></button>
          ${can('gerenciar_usuarios') ? `<button class="btn btn-sm" onclick="adminResetPassword(${u.id},'${escJs(u.login)}')" title="Redefinir senha" style="color:#d97706;border-color:#d97706"><i class="ti ti-key"></i></button>` : ''}
          <button class="btn btn-sm" onclick="toggleAtivo(${u.id},${!u.ativo})" title="${u.ativo?'Desativar (mantém a conta)':'Ativar'}"
            style="${u.ativo?'color:#d97706;border-color:#d97706':'color:#059669;border-color:#059669'}">
            <i class="ti ti-${u.ativo?'user-off':'user-check'}"></i>
          </button>
          <button class="btn btn-sm" onclick="excluirUsuario(${u.id},'${escJs(u.login)}')" title="Excluir definitivamente"
            style="color:var(--danger-txt);border-color:var(--danger-txt)${isMe?';opacity:.4;cursor:not-allowed':''}" ${isMe?'disabled':''}>
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr class="empty-row"><td colspan="5">Nenhum usuário</td></tr>';
}

function openEditUser(id, nome, papel) {
  document.getElementById('eu-id').value    = id;
  document.getElementById('eu-nome').value  = nome;
  document.getElementById('eu-papel').value = papel;
  document.getElementById('user-modal').style.display = 'flex';
}

async function saveEditUser() {
  const id    = document.getElementById('eu-id').value;
  const nome  = document.getElementById('eu-nome').value.trim();
  const papel = document.getElementById('eu-papel').value;
  showLoading('Salvando...');
  try {
    await DB.updateUser(id, nome, papel);
    showToast('✅ Usuário atualizado!');
    document.getElementById('user-modal').style.display = 'none';
    renderUsuarios();
  } catch(e) { showToast('Erro: ' + e.message, 'err'); }
  finally    { hideLoading(); }
}

async function toggleAtivo(id, ativo) {
  showLoading(ativo ? 'Ativando...' : 'Desativando...');
  try {
    await DB.toggleUserAtivo(id, ativo);
    showToast(ativo ? '✅ Usuário ativado!' : '✅ Usuário desativado!');
    renderUsuarios();
  } catch(e) { showToast('Erro: ' + e.message, 'err'); }
  finally    { hideLoading(); }
}

// Excluir é diferente de desativar, e a tela precisa dizer isso: desativar
// tranca a entrada e pode ser desfeito num clique; excluir some com a linha e
// libera o login para outra pessoa.
async function excluirUsuario(id, login) {
  const ok = await confirmar({
    titulo: 'Excluir usuário',
    texto: `Excluir <strong>${esc(login)}</strong> definitivamente?<br><br>
      O histórico não se perde — auditoria e cadastros continuam mostrando quem fez o quê.
      Mas o login fica livre para ser usado por outra pessoa.<br><br>
      Se a intenção é só tirar o acesso, <strong>desativar</strong> é reversível.`,
    botao: 'Excluir'
  });
  if (!ok) return;

  showLoading('Excluindo...');
  try {
    await DB.excluirUsuario(id);
    showToast(`✅ Usuário ${login} excluído.`);
    renderUsuarios();
  } catch(e) { showToast('Erro: ' + e.message, 'err'); }
  finally    { hideLoading(); }
}

async function openInviteUser() {
  ['inv-login','inv-nome','inv-senha','inv-senha2'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    if (el.type === 'text' && id.startsWith('inv-senha')) el.type = 'password';
  });
  document.getElementById('inv-papel').value = 'leitor';
  document.getElementById('inv-result').style.display = 'none';
  document.getElementById('invite-modal').style.display = 'flex';
}

async function doInviteUser() {
  const login  = document.getElementById('inv-login').value.trim();
  const nome   = document.getElementById('inv-nome').value.trim();
  const papel  = document.getElementById('inv-papel').value;
  const senha  = document.getElementById('inv-senha').value;
  const senha2 = document.getElementById('inv-senha2').value;

  if (!login) { showToast('Informe o usuário.','err'); return; }
  const erroSenha = validarSenha(senha, senha2);
  if (erroSenha) { showToast(erroSenha,'err'); return; }

  showLoading('Criando usuário...');
  try {
    const res = await DB.criarUsuario(login, papel, nome, senha);
    hideLoading();
    const r = document.getElementById('inv-result');
    r.style.display = 'block';
    r.innerHTML = `<div style="background:var(--success-bg);color:var(--success-txt);padding:1rem;border-radius:8px;font-size:13px">
      ✅ Usuário <strong>${esc(res.login)}</strong> criado com a senha que você definiu.
    </div>`;
    renderUsuarios();
  } catch(e) {
    hideLoading();
    showToast('Erro ao criar: ' + e.message, 'err');
  }
}

// ─── ALTERAR SENHA ───────────────────────────────────────────
function openChangePassword() {
  ['cp-current','cp-new','cp-confirm'].forEach(id => {
    const el = document.getElementById(id);
    el.value = ''; el.type = 'password';
  });
  document.getElementById('cp-err').style.display = 'none';
  document.getElementById('cp-ok').style.display  = 'none';
  document.getElementById('change-password-modal').style.display = 'flex';
}

async function doChangePassword() {
  const current = document.getElementById('cp-current').value;
  const nova    = document.getElementById('cp-new').value;
  const confirm = document.getElementById('cp-confirm').value;
  const err     = document.getElementById('cp-err');
  const ok      = document.getElementById('cp-ok');
  err.style.display = 'none'; ok.style.display = 'none';

  const erroSenha = validarSenha(nova, confirm);
  if (erroSenha) { err.textContent = erroSenha; err.style.display = 'block'; return; }

  showLoading('Alterando senha...');
  try {
    // A senha atual vai junto e é conferida no SERVIDOR. Antes a tela fazia um
    // login novo só para validar — o que, com o freio de tentativas da API,
    // travaria a conta de quem errasse a senha atual cinco vezes.
    await Auth.changePassword(current, nova);
    ok.textContent = '✅ Senha alterada com sucesso!';
    ok.style.display = 'block';
    setTimeout(() => {
      document.getElementById('change-password-modal').style.display = 'none';
    }, 1800);
  } catch(e) {
    err.textContent = e.message;
    err.style.display = 'block';
  } finally { hideLoading(); }
}

// Admin reseta senha de outro usuário
// Abre o modal. Era um prompt() do navegador: mostrava a senha em
// texto puro enquanto se digitava, não confirmava, e a caixa do
// Windows não tem nada a ver com o resto do sistema.
function adminResetPassword(userId, login) {
  document.getElementById('rp-id').value = userId;
  document.getElementById('rp-login').textContent = login;
  ['rp-senha','rp-senha2'].forEach(id => {
    const el = document.getElementById(id);
    el.value = ''; el.type = 'password';
  });
  document.getElementById('rp-err').style.display = 'none';
  document.getElementById('reset-password-modal').style.display = 'flex';
}

async function doAdminResetPassword() {
  const id     = document.getElementById('rp-id').value;
  const login  = document.getElementById('rp-login').textContent;
  const senha  = document.getElementById('rp-senha').value;
  const senha2 = document.getElementById('rp-senha2').value;
  const err    = document.getElementById('rp-err');
  err.style.display = 'none';

  const erroSenha = validarSenha(senha, senha2);
  if (erroSenha) { err.textContent = erroSenha; err.style.display = 'block'; return; }

  showLoading('Alterando senha...');
  try {
    await DB.adminResetPassword(id, senha);
    document.getElementById('reset-password-modal').style.display = 'none';
    showToast(`✅ Senha de ${login} alterada!`);
  } catch(e) {
    err.textContent = e.message; err.style.display = 'block';
  } finally { hideLoading(); }
}

// ═══════════════════════════════════════════════════════════════
//  ALMOXARIFADO — material de consumo (bobina, etiqueta, toner...)
//
//  Diferença para o patrimônio: aqui o que importa é QUANTIDADE, e ela vem
//  em LOTES. Cada entrada é um lote com a sua validade; cada saída diz de
//  qual lote saiu. A API já devolve saldo, lotes e histórico prontos — esta
//  tela não recalcula nada, só mostra.
// ═══════════════════════════════════════════════════════════════

// Número na tela: 12 e não "12.00"; 2,5 com vírgula, como se escreve aqui.
function fmtQtd(n) {
  const v = Number(n || 0);
  return (Math.round(v * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function getCatAlmox(id) { return S.catsAlmox.find(c => c.id === id) || { name: id || '—', color: '#888888' }; }

function catAlmoxPill(id) {
  if (!id) return '—';
  const c = getCatAlmox(id), cor = corSegura(c.color);
  return `<span class="cat-pill" style="background:${cor}22;color:${cor}">${esc(c.name)}</span>`;
}

// Dias até a validade. Negativo = já venceu.
function diasAte(data) {
  if (!data) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d = new Date(data + 'T12:00');
  if (isNaN(d)) return null;
  return Math.round((d - hoje) / 86400000);
}

// Etiqueta de validade: vencido (vermelho), 30 dias ou menos (âmbar), o resto
// verde. O prazo curto é o que interessa — material vencido no estoque é
// dinheiro perdido, e ninguém vai conferir data por data numa lista.
function validadePill(data) {
  if (!data) return '<span style="color:var(--txt3)">sem validade</span>';
  const d = diasAte(data);
  const txt = fmtDate(data);
  if (d == null) return esc(data);
  if (d < 0)   return `<span class="val-pill val-vencido" title="Venceu há ${-d} dia(s)">${esc(txt)}</span>`;
  if (d <= 30) return `<span class="val-pill val-perto" title="Vence em ${d} dia(s)">${esc(txt)}</span>`;
  return `<span class="val-pill val-ok">${esc(txt)}</span>`;
}

function saldoPill(saldo) {
  const cor = saldo > 0 ? '#059669' : '#dc2626';
  return `<strong style="color:${cor}">${esc(fmtQtd(saldo))}</strong>`;
}

// ─── LISTA ───────────────────────────────────────────────────
function populateFiltersAlmox() {
  const fc = document.getElementById('fcat-almox'); if (!fc) return;
  const v = fc.value;
  fc.innerHTML = '<option value="">Todas as categorias</option>' +
    S.catsAlmox.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  fc.value = v;
}

function renderAlmox() {
  const tb = document.getElementById('almox-tbody'); if (!tb) return;

  // Banco sem a migração 05: a aba explica o que fazer em vez de ficar vazia
  // sem motivo aparente.
  if (S.almoxErro) {
    document.getElementById('almox-head').innerHTML = '<th>Almoxarifado</th>';
    tb.innerHTML = `<tr><td style="padding:1rem;font-size:13px;color:var(--danger-txt)">
      <strong>Não consegui carregar o almoxarifado:</strong> ${esc(S.almoxErro)}<br>
      <span style="font-size:12px;color:var(--txt3)">Se a mensagem fala em objeto ou coluna que não existe, falta rodar
      <code>api/sql/05_almoxarifado.sql</code> no banco ESTOQUE_TI e reiniciar o serviço da API.</span>
    </td></tr>`;
    return;
  }

  const srch  = (document.getElementById('srch-almox').value || '').toLowerCase();
  const catF  = document.getElementById('fcat-almox').value;
  const sitF  = document.getElementById('fsaldo-almox').value;

  const filtrados = S.almox.filter(it => {
    if (srch && !(it.item || '').toLowerCase().includes(srch)
             && !(it.modelo || '').toLowerCase().includes(srch)
             && !(it.serie || '').toLowerCase().includes(srch)) return false;
    if (catF && it.categoria !== catF) return false;
    if (sitF === 'com' && !(it.saldo > 0)) return false;
    if (sitF === 'sem' && it.saldo > 0) return false;
    if (sitF === 'vencendo' || sitF === 'vencido') {
      // Só conta lote que ainda tem saldo: lote zerado que venceu não é
      // problema de ninguém.
      const dias = (it.lotes || []).filter(l => l.saldo > 0 && l.validade).map(l => diasAte(l.validade));
      if (!dias.length) return false;
      const menor = Math.min(...dias);
      if (sitF === 'vencido'  && !(menor < 0)) return false;
      if (sitF === 'vencendo' && !(menor >= 0 && menor <= 30)) return false;
    }
    return true;
  });

  const ordenados = ordenarLinhas(filtrados, 'almox');
  S.lastFilteredAlmox = ordenados;

  document.getElementById('almox-head').innerHTML = cabecalhoOrdenavel('almox');

  tb.innerHTML = ordenados.length ? ordenados.map(it => {
    const ultima = (it.historico || []).slice(-1)[0];
    const lotesAtivos = (it.lotes || []).filter(l => l.saldo > 0).length;
    return `<tr>
      <td><strong>${esc(it.item || '—')}</strong></td>
      <td>${catAlmoxPill(it.categoria)}</td>
      <td>${esc(it.modelo || '—')}</td>
      <td>${esc(it.serie || '—')}</td>
      <td>${saldoPill(it.saldo)}</td>
      <td>${validadePill(it.validadeProxima)}</td>
      <td><span class="badge b-gray">${lotesAtivos}</span></td>
      <td style="font-size:12px;color:var(--txt2)">${ultima
        ? esc((ultima.tipo === 'saida' ? '📤 −' : '📥 +') + fmtQtd(ultima.quantidade) + ' · ' + fmtDate(ultima.data_mov))
        : '—'}</td>
      <td>${acoesAlmox(it.id)}</td>
    </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="9">Nenhum item encontrado</td></tr>';
}

function acoesAlmox(id) {
  const edOk  = can('editar');
  const movOk = can('movimentar');
  const delOk = can('excluir');
  const dis   = (ok, tip) => !ok ? `disabled title="${esc(tip)}" style="opacity:.4;cursor:not-allowed"` : '';
  return `<div class="actions-cell">
    <button class="btn btn-sm" onclick="${edOk ? `editAlmox(${id})` : ''}" ${dis(edOk, 'Sem permissão para editar')} title="${edOk ? 'Editar' : 'Sem permissão'}"><i class="ti ti-edit"></i> <span class="btn-label">Editar</span></button>
    <button class="btn btn-sm btn-warn" onclick="${movOk ? `movimentarAlmox(${id})` : ''}" ${dis(movOk, 'Sem permissão para movimentar')} title="${movOk ? 'Entrada ou saída' : 'Sem permissão'}"><i class="ti ti-transfer"></i> <span class="btn-label">Movimentar</span></button>
    <button class="btn btn-sm" style="${delOk ? 'border-color:var(--danger-txt);color:var(--danger-txt)' : 'opacity:.4;cursor:not-allowed'}" onclick="${delOk ? `delAlmox(${id})` : ''}" ${dis(delOk, 'Sem permissão para excluir')} title="${delOk ? 'Excluir' : 'Sem permissão'}"><i class="ti ti-trash"></i> <span class="btn-label">Excluir</span></button>
  </div>`;
}

// ─── NAVEGAÇÃO ENTRE AS TELAS ────────────────────────────────
function novoAlmox() {
  if (!can('cadastrar')) { showToast('Sem permissão para cadastrar.', 'err'); return; }
  S.editAlmoxId = null; movModeAlmox = false; S.tipoCadastro = 'almoxarifado';
  nav('cadastro');
}
function editAlmox(id)       { S.editAlmoxId = id; movModeAlmox = false; S.tipoCadastro = 'almoxarifado'; abrirFormModal(); }
function movimentarAlmox(id) { S.editAlmoxId = id; movModeAlmox = true;  S.tipoCadastro = 'almoxarifado'; abrirFormModal(); }

// Seletor Patrimônio | Almoxarifado do topo do cadastro.
function trocarTipoCadastro(tipo) {
  S.tipoCadastro = tipo;
  S.editId = null; S.editAlmoxId = null;
  movMode = false; movModeAlmox = false;
  renderForm();
}

async function delAlmox(id) {
  if (!can('excluir')) { showToast('Sem permissão para excluir.', 'err'); return; }
  const it = S.almox.find(x => x.id === id) || {};
  const ok = await confirmar({
    titulo: 'Excluir item do almoxarifado',
    texto: `Excluir <strong>${esc(it.item || '')}</strong>?<br><br>
      Todo o histórico vai junto: os lotes, as entradas e as saídas.
      O saldo de ${esc(fmtQtd(it.saldo))} deixa de existir no sistema.<br><br>
      Isso não pode ser desfeito.`,
    botao: 'Excluir'
  });
  if (!ok) return;

  showLoading('Excluindo...');
  try {
    await DB.deleteAlmox(id);
    S.almox = S.almox.filter(x => x.id !== id);
    showToast('Item excluído.');
    renderAlmox();
  } catch (e) { showToast('Erro ao excluir: ' + e.message, 'err'); }
  finally    { hideLoading(); }
}

// ─── FORMULÁRIO ──────────────────────────────────────────────
let movModeAlmox = false;

// ─── "USADO EM" ──────────────────────────────────────────────
// Liga o material aos MODELOS de patrimônio em que ele é usado: a tinta Epson
// 664 é da impressora Epson M105. Guarda o modelo, não o patrimônio: a tinta
// serve para qualquer impressora daquele modelo, inclusive as que entrarem
// depois, e excluir um bem não deixa o vínculo apontando para o vazio.
//
// Só dá para escolher da lista — digitar livre encheria o cadastro de
// "M105", "m-105", "Epson M 105", e aí o vínculo não acha nada.
let usadoEmSel = [];   // modelos escolhidos no formulário aberto

// Modelos distintos já cadastrados em Patrimônios, em ordem alfabética.
function modelosDoPatrimonio() {
  const mapa = new Map();
  S.items.forEach(p => {
    const m = (p.modelo || '').trim();
    if (m && !mapa.has(m.toLowerCase())) mapa.set(m.toLowerCase(), m);
  });
  return [...mapa.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function campoUsadoEm() {
  return `<select class="finput" id="a_usado_em" onchange="addUsadoEm(this.value)">
      ${opcoesUsadoEm()}
    </select>
    <div class="fhint">Deixe em branco se não for usado em nenhum modelo</div>`;
}

// As opções são os modelos ainda não escolhidos. Um vínculo antigo cujo modelo
// saiu do patrimônio continua na lista, senão salvar o item o apagaria sem
// ninguém pedir.
function opcoesUsadoEm() {
  const modelos = modelosDoPatrimonio();
  const extras = usadoEmSel.filter(m => !modelos.some(x => x.toLowerCase() === m.toLowerCase()));
  const opcoes = [...modelos, ...extras]
    .filter(m => !usadoEmSel.some(x => x.toLowerCase() === m.toLowerCase()));
  return `<option value="">${opcoes.length ? 'Adicionar modelo...' : 'Nenhum modelo disponível'}</option>` +
    opcoes.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
}

// As etiquetas ficam FORA da grade, no rodapé do card: dentro dela, cada modelo
// escolhido aumentaria a linha e desalinharia os dois blocos.
function tagsUsadoEm() {
  return usadoEmSel.map((m, i) =>
    `<div class="tag">${esc(m)}<span class="tdel" onclick="delUsadoEm(${i})" title="Remover">×</span></div>`).join('');
}

function addUsadoEm(modelo) {
  if (!modelo) return;
  if (!usadoEmSel.some(m => m.toLowerCase() === modelo.toLowerCase())) usadoEmSel.push(modelo);
  atualizarUsadoEm();
}

function delUsadoEm(i) {
  usadoEmSel.splice(i, 1);
  atualizarUsadoEm();
}

// Redesenha só o campo, e não o formulário inteiro: um render completo perderia
// o que já estiver digitado nos outros campos.
function atualizarUsadoEm() {
  const tags = document.getElementById('usado-em-tags');
  if (tags) tags.innerHTML = tagsUsadoEm();
  const sel = document.getElementById('a_usado_em');
  if (sel) sel.innerHTML = opcoesUsadoEm();
}

function renderFormAlmox() {
  const it     = S.editAlmoxId != null ? (S.almox.find(x => x.id === S.editAlmoxId) || {}) : {};
  const isEdit = S.editAlmoxId != null;
  usadoEmSel = [...(it.usadoEm || [])];
  document.getElementById(alvoForm().titulo).textContent = movModeAlmox
    ? 'Entrada ou Saída'
    : (isEdit ? 'Editar Item' : 'Novo Item de Almoxarifado');

  let h = '<form onsubmit="saveAlmox(event)"><div class="form-two-col">';

  if (!movModeAlmox) {
    h += `<div class="scard">
      <div class="scard-title"><i class="ti ti-clipboard-list"></i> Dados do Item
      </div>
      <div class="form-grid">
        <div class="fg"><label class="flabel">Item<span class="req">*</span></label>
          <input class="finput" id="a_item" value="${esc(it.item || '')}" required placeholder="Ex: Bobina 80mm">
          <div class="fhint"></div></div>
        <div class="fg"><label class="flabel">Categoria<span class="req">*</span></label>
          <select class="finput" id="a_categoria">
            <option value="">Selecione...</option>
            ${S.catsAlmox.map(c => `<option value="${esc(c.id)}"${it.categoria === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <div class="fhint"></div></div>
        <div class="fg"><label class="flabel">Modelo<span class="req">*</span></label>
          <input class="finput" id="a_modelo" value="${esc(it.modelo || '')}" required placeholder="Ex: 80mm x 40m">
          <div class="fhint"></div></div>
        <div class="fg"><label class="flabel">N° de Série<span class="req">*</span></label>
          <input class="finput" id="f_serie" value="${esc(it.serie || '')}" required placeholder="Ex: SN-0001-XYZ"></div>
        <div class="fg full"><label class="flabel">Usado em</label>
          ${campoUsadoEm()}</div>
        <div class="fg full"><label class="flabel">Observações de cadastro</label>
          <textarea class="finput" id="a_obs" rows="3" style="resize:vertical" placeholder="Fornecedor, onde fica guardado, o que for útil lembrar...">${esc(it.obs || '')}</textarea></div>
      </div>
      <div class="tag-cloud" id="usado-em-tags" style="margin-top:.75rem">${tagsUsadoEm()}</div>
    </div>`;
  } else {
    h += `<div class="scard" style="background:var(--accent-bg);border-color:var(--accent)">
      <div style="font-size:13px;margin-bottom:.75rem;color:var(--accent-txt);font-weight:600">
        <i class="ti ti-info-circle"></i> Movimentando:<br>
        <strong>${esc(it.item || '')} ${it.modelo ? '— ' + esc(it.modelo) : ''}</strong>
        <div style="margin-top:.5rem;font-weight:500">Saldo atual: ${saldoPill(it.saldo)}</div>
      </div>
    </div>`;
  }

  // Editar mexe no CADASTRO do item; entrada e saída têm a tela própria
  // (Movimentar). Misturar os dois num formulário só fazia a edição de um nome
  // parecer que ia gravar uma movimentação junto.
  const mostraMov = movModeAlmox || !isEdit;

  // No cadastro é sempre ENTRADA: o item nasce com o primeiro lote. A escolha
  // entrada/saída só faz sentido depois, em cima de um item que já existe.
  // Quem vence primeiro no topo: é o que deve sair antes, e numa lista de dez
  // lotes ninguém vai comparar data por data.
  const lotesComSaldo = (it.lotes || []).filter(l => l.saldo > 0)
    .sort((a, b) => (a.validade || '9999-12-31').localeCompare(b.validade || '9999-12-31'));
  lotesDoItemAberto = lotesComSaldo;
  if (mostraMov) h += `<div class="${movModeAlmox ? 'scard' : 'mov-card'}">
    <div class="scard-title"><i class="ti ti-transfer"></i> Dados da Movimentação
    </div>
    <div class="form-grid">
      <div class="fg"><label class="flabel">Data de Movimentação</label>
        <input class="finput" type="date" id="a_data_mov" value="${esc(hojeCampo())}">
        <div class="fhint"></div></div>
      <div class="fg"><label class="flabel">Entrada ou Saída?</label>
        ${movModeAlmox
          ? `<select class="finput" id="a_tipo" onchange="onTipoAlmoxChange()">
               <option value="entrada">📥 Entrada</option>
               <option value="saida">📤 Saída</option>
             </select>`
          : `<input class="finput" value="📥 Entrada" disabled title="O item nasce com a primeira entrada">`}
        <div class="fhint"></div>
      </div>
      <div class="fg"><label class="flabel">Quantidade<span class="req">*</span></label>
        <input class="finput" id="a_qtd" type="text" inputmode="decimal" placeholder="Ex: 12" required>
        <div class="fhint"></div></div>
      <div class="fg"><label class="flabel">Usuário</label>
        <input class="finput" id="a_usuario" list="lista-pessoas" placeholder="Quem retirou ou recebeu">
        <div class="fhint"></div></div>
      <datalist id="lista-pessoas">${S.pessoas.map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
      <div class="fg" id="fg-validade" data-modo="novo">${campoValidade('')}</div>
      <div class="fg" id="fg-lote"${(movModeAlmox && lotesComSaldo.length) ? '' : ' style="display:none"'}>${movModeAlmox ? campoLote(false) : ''}</div>
      <div class="fg full"><label class="flabel">Observações da Movimentação</label>
        <textarea class="finput" id="a_obs_mov" rows="3" style="resize:vertical" placeholder="Nota fiscal, motivo da retirada..."></textarea></div>
    </div>
  </div>`;

  h += '</div>'; // fecha form-two-col

  if (isEdit) h += blocoLotes(it);

  h += `<div class="form-actions-row">
    <button type="button" class="btn btn-ghost" onclick="cancelEdit()">Cancelar</button>
    <button type="submit" class="btn btn-primary" id="save-btn"><i class="ti ti-device-floppy"></i> ${movModeAlmox ? 'Registrar Movimentação' : (isEdit ? 'Salvar Alterações' : 'Cadastrar')}</button>
  </div></form>`;

  document.getElementById(alvoForm().wrap).innerHTML = h;
  document.getElementById(alvoForm().alerta).style.display = 'none';
}

// Data de hoje no formato do <input type="date">.
function hojeCampo() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function rotuloLote(l) {
  const val = l.validade ? 'vence ' + fmtDate(l.validade) : 'sem validade';
  return `${fmtQtd(l.saldo)} disponível · ${val} · entrada de ${fmtDate(l.data_mov)}`;
}

// Saída pede o lote e não tem validade própria (a validade é do lote).
// Lotes com saldo do item aberto no formulário, para o campo Lote se remontar
// quando o tipo muda sem ter de redesenhar tudo.
let lotesDoItemAberto = [];

// O mesmo campo serve aos dois casos: na saída é de QUAL lote sai; na entrada é
// para SOMAR a um lote que já existe — compra nova, mesma validade, mesmo lote
// de verdade — em vez de abrir um cartão novo ao lado.
function campoLote(saida) {
  const lotes = lotesDoItemAberto;
  const primeira = saida
    ? (lotes.length ? '' : '<option value="">Nenhum lote com saldo</option>')
    : '<option value="">➕ Abrir um lote novo</option>';
  return `<label class="flabel">${saida ? 'De qual lote sai?<span class="req">*</span>' : 'Somar a um lote?'}</label>
    <select class="finput" id="a_lote" onchange="onLoteAlmoxChange()">
      ${primeira}${lotes.map(l => `<option value="${esc(l.id)}">${esc(rotuloLote(l))}</option>`).join('')}
    </select>
    <div class="fhint">${saida
      ? 'Os que vencem primeiro aparecem no topo'
      : 'Em branco abre um lote novo, com a validade que você informar'}</div>`;
}

function onTipoAlmoxChange() {
  const saida = (document.getElementById('a_tipo') || {}).value === 'saida';
  const lote  = document.getElementById('fg-lote');
  if (lote) {
    // Numa entrada sem nenhum lote aberto não há o que somar: o campo some.
    lote.innerHTML = campoLote(saida);
    lote.style.display = (saida || lotesDoItemAberto.length) ? '' : 'none';
  }
  onLoteAlmoxChange();
}

// A validade é do LOTE. Abrindo um lote novo, ela é um campo de data normal;
// somando a um lote que já existe, ela continua à vista — travada, com a data
// daquele lote — para quem registra conferir que é o lote certo.
function campoValidade(loteId) {
  const lote = lotesDoItemAberto.find(l => String(l.id) === String(loteId));
  if (!lote) {
    return `<label class="flabel">Data de Validade</label>
      <input class="finput" type="date" id="a_validade">
      <div class="fhint">Deixe em branco se o material não vence</div>`;
  }
  return `<label class="flabel">Data de Validade</label>
    <input class="finput" value="${esc(lote.validade ? fmtDate(lote.validade) : 'sem validade')}"
           disabled title="A validade é a do lote escolhido">
    <div class="fhint">Vem do lote escolhido</div>`;
}

function onLoteAlmoxChange() {
  const saida  = (document.getElementById('a_tipo') || {}).value === 'saida';
  const loteId = (document.getElementById('a_lote') || {}).value || '';
  const val = document.getElementById('fg-validade');
  if (!val) return;
  val.style.display = saida ? 'none' : '';
  const modo = saida ? val.dataset.modo : (loteId || 'novo');
  if (!saida && val.dataset.modo !== modo) {
    val.dataset.modo = modo;
    val.innerHTML = campoValidade(loteId);
  }
}

// Lotes e histórico do item aberto.
// Um cartão por lote; clicar nele abre as movimentações DAQUELE lote — a
// entrada que o criou e as saídas que saíram dele. Substituiu a lista de lotes
// + um histórico geral separado, que obrigava a cruzar os dois na mão.
// Lote zerado continua aqui, apagado e marcado: é o único lugar onde as saídas
// antigas ainda aparecem.
function blocoLotes(it) {
  const hist  = it.historico || [];
  const lotes = [...(it.lotes || [])].sort((a, b) => {
    const za = a.saldo > 0 ? 0 : 1, zb = b.saldo > 0 ? 0 : 1;
    if (za !== zb) return za - zb;                                  // zerado no fim
    return (a.validade || '9999-12-31').localeCompare(b.validade || '9999-12-31');
  });
  const comSaldo = lotes.filter(l => l.saldo > 0).length;

  // A entrada que abriu o lote tem o id dele; as entradas que somaram depois e
  // as saídas apontam para ele.
  const movsDoLote = l => hist.filter(m => m.id === l.id || m.lote_id === l.id);

  const linhaMov = m => {
    const entrada = m.tipo === 'entrada';
    return `<div class="hist-item">
      <div class="hist-meta">${esc(fmtDT(m.criado_em))} · ${entrada ? '📥 Entrada' : '📤 Saída'}</div>
      <div class="hist-detail">
        <span>Quantidade: <strong>${entrada ? '+' : '−'}${esc(fmtQtd(m.quantidade))}</strong>&nbsp;·&nbsp;</span>
        <span>Data: <strong>${esc(fmtDate(m.data_mov))}</strong></span>
        ${m.usuario ? `<span>&nbsp;·&nbsp;Usuário: <strong>${esc(m.usuario)}</strong></span>` : ''}
        ${m.obs_mov ? `<div style="margin-top:3px;color:var(--txt2)">📝 ${esc(m.obs_mov)}</div>` : ''}
      </div>
    </div>`;
  };

  const cartao = l => {
    const zerado = !(l.saldo > 0);
    const movs   = movsDoLote(l);
    return `<div class="lote-card${zerado ? ' zerado' : ''}" id="lote-${esc(l.id)}">
      <button type="button" class="lote-cab" onclick="abrirLote('${escJs(l.id)}')">
        <span class="lote-tit">📦 Lote de ${esc(fmtDate(l.data_mov))}</span>
        <span class="lote-info">Entrou ${esc(fmtQtd(l.quantidade))} · Resta <strong>${esc(fmtQtd(l.saldo))}</strong></span>
        <span class="lote-info">Validade: ${validadePill(l.validade)}</span>
        ${zerado ? '<span class="badge b-gray">zerado</span>' : ''}
        <span class="lote-info">${movs.length} mov.</span>
        <span class="lote-seta">▾</span>
      </button>
      <div class="lote-corpo">
        ${can('editar') ? `<div class="lote-acoes" id="lote-acoes-${esc(l.id)}">
          <button type="button" class="btn btn-sm" onclick="editarLote('${escJs(l.id)}')"><i class="ti ti-edit"></i> Editar lote</button>
        </div>` : ''}
        <div class="lote-editor" id="lote-editor-${esc(l.id)}"></div>
        ${movs.length ? movs.map(linhaMov).join('')
                      : '<div style="color:var(--txt3);font-size:12.5px">Sem movimentações neste lote.</div>'}
      </div>
    </div>`;
  };

  return `<div class="hist-card" id="bloco-lotes">
    <div class="hist-card-title"><i class="ti ti-package" style="color:var(--accent)"></i> Lotes e movimentações
      <span class="badge b-gray" style="margin-left:6px">${comSaldo} com saldo</span>
      <span style="margin-left:8px;font-size:12px;font-weight:500;color:var(--txt2)">Saldo total: ${saldoPill(it.saldo)}</span>
    </div>
    ${lotes.length ? lotes.map(cartao).join('')
                   : '<div style="color:var(--txt3);font-size:13px;padding:.5rem 0">Nenhum lote ainda. Registre uma entrada.</div>'}
  </div>`;
}

// Correção do cadastro do lote, dentro do próprio cartão. A QUANTIDADE não
// entra: o saldo é a soma das movimentações, então quantidade errada se corrige
// com uma entrada ou saída nova, nunca reescrevendo a que já existe.
function editarLote(loteId) {
  const it = S.almox.find(x => x.id === S.editAlmoxId) || {};
  const l  = (it.lotes || []).find(x => String(x.id) === String(loteId));
  if (!l) return;
  const acoes = document.getElementById('lote-acoes-' + loteId);
  if (acoes) acoes.style.display = 'none';

  // Enter aqui dentro salva o LOTE; sem isto ele enviaria o formulário do item,
  // que é quem envolve este bloco.
  document.getElementById('lote-editor-' + loteId).innerHTML = `
    <div onkeydown="if(event.key==='Enter'&&event.target.tagName!=='TEXTAREA'){event.preventDefault();salvarLote('${escJs(l.id)}')}">
      <div class="form-grid">
        <div class="fg"><label class="flabel">Data de Validade</label>
          <input class="finput" type="date" id="le_validade_${esc(l.id)}" value="${esc(l.validade || '')}">
          <div class="fhint">Deixe em branco se o material não vence</div></div>
        <div class="fg"><label class="flabel">Data da entrada</label>
          <input class="finput" type="date" id="le_data_${esc(l.id)}" value="${esc(l.data_mov || '')}">
          <div class="fhint">Quantidade (${esc(fmtQtd(l.quantidade))}) só muda com entrada ou saída</div></div>
        <div class="fg"><label class="flabel">Usuário</label>
          <input class="finput" id="le_usuario_${esc(l.id)}" list="lista-pessoas" value="${esc(l.usuario || '')}" placeholder="Quem recebeu">
          <div class="fhint"></div></div>
        <div class="fg full"><label class="flabel">Observações do lote</label>
          <textarea class="finput" id="le_obs_${esc(l.id)}" rows="2" style="resize:vertical" placeholder="Nota fiscal, fornecedor...">${esc(l.obs_mov || '')}</textarea></div>
      </div>
      <div class="lote-acoes">
        <button type="button" class="btn btn-sm btn-ghost" onclick="fecharEditorLote('${escJs(l.id)}')">Cancelar</button>
        <button type="button" class="btn btn-sm btn-primary" onclick="salvarLote('${escJs(l.id)}')"><i class="ti ti-device-floppy"></i> Salvar lote</button>
      </div>
    </div>`;
}

function fecharEditorLote(loteId) {
  const ed = document.getElementById('lote-editor-' + loteId);
  if (ed) ed.innerHTML = '';
  const acoes = document.getElementById('lote-acoes-' + loteId);
  if (acoes) acoes.style.display = '';
}

async function salvarLote(loteId) {
  const v = id => (document.getElementById(id) || {}).value || '';
  const dados = {
    validade: v('le_validade_' + loteId),
    data_mov: v('le_data_' + loteId),
    usuario:  v('le_usuario_' + loteId),
    obs_mov:  v('le_obs_' + loteId)
  };
  showLoading('Salvando...');
  try {
    await DB.editarLote(S.editAlmoxId, Number(loteId), dados);
    S.almox = await DB.loadAlmox();
    const it = S.almox.find(x => x.id === S.editAlmoxId) || {};
    // Só este bloco é redesenhado: redesenhar o formulário inteiro perderia o
    // que já estivesse digitado nos campos do item.
    lotesDoItemAberto = (it.lotes || []).filter(l => l.saldo > 0)
      .sort((a, b) => (a.validade || '9999-12-31').localeCompare(b.validade || '9999-12-31'));
    const bloco = document.getElementById('bloco-lotes');
    if (bloco) bloco.outerHTML = blocoLotes(it);
    abrirLote(loteId);
    showToast('✅ Lote atualizado!');
  } catch (e) {
    showToast('Erro ao salvar o lote: ' + e.message, 'err');
  } finally {
    hideLoading();
  }
}

// Abrir um lote fecha o que estava aberto. Mexe só em classe, sem redesenhar o
// formulário: redesenhar perderia o que já tivesse sido digitado nos campos.
function abrirLote(id) {
  const card  = document.getElementById('lote-' + id);
  const abrir = card && !card.classList.contains('aberto');
  document.querySelectorAll('.lote-card.aberto').forEach(el => el.classList.remove('aberto'));
  if (abrir) card.classList.add('aberto');
}

async function saveAlmox(e) {
  e.preventDefault();
  const btn = document.getElementById('save-btn');
  btn.disabled = true;

  const val = id => (document.getElementById(id) || {}).value || '';
  const mov = {
    tipo:       movModeAlmox ? val('a_tipo') : 'entrada',
    data_mov:   val('a_data_mov'),
    validade:   val('a_validade'),
    quantidade: val('a_qtd'),
    loteId:     val('a_lote'),
    usuario:    val('a_usuario'),
    obs_mov:    val('a_obs_mov')
  };

  showLoading('Salvando...');
  try {
    if (movModeAlmox) {
      if (!mov.quantidade) { showToast('Informe a quantidade.', 'err'); return; }
      if (mov.tipo === 'saida' && !mov.loteId) { showToast('Escolha de qual lote sai o material.', 'err'); return; }
      await DB.movimentarAlmox(S.editAlmoxId, mov);
      showToast(mov.tipo === 'saida' ? '✅ Saída registrada!' : '✅ Entrada registrada!');
      movModeAlmox = false; S.editAlmoxId = null;
    } else {
      const item = {
        item:      val('a_item').trim(),
        categoria: val('a_categoria'),
        modelo:    val('a_modelo').trim(),
        serie:     val('f_serie').trim(),
        obs:       val('a_obs').trim(),
        usadoEm:   [...usadoEmSel]
      };
      // Os mesmos obrigatórios que a API cobra (OBRIGATORIOS em
      // almoxarifadoRoutes.js). "Usado em" fica de fora: nem todo material é
      // usado em algum equipamento.
      if (!item.item)      { showToast('Preencha o Item.', 'err'); return; }
      if (!item.categoria) { showToast('Selecione uma categoria.', 'err'); return; }
      if (!item.modelo)    { showToast('Preencha o Modelo.', 'err'); return; }
      if (!item.serie)     { showToast('Preencha o N° de Série.', 'err'); return; }

      if (S.editAlmoxId != null) {
        // Só o cadastro do item: a edição não tem mais campos de movimentação
        // (entrada e saída se registram em Movimentar).
        await DB.updateAlmox(S.editAlmoxId, item);
        showToast('✅ Item atualizado!');
      } else {
        if (!mov.quantidade) { showToast('Informe a quantidade que está entrando.', 'err'); return; }
        await DB.createAlmox(item, mov);
        showToast('✅ Item cadastrado!');
      }
      S.editAlmoxId = null;
    }
    S.almox = await DB.loadAlmox();
    voltarDoForm('almoxarifado');
  } catch (ex) {
    showToast('Erro ao salvar: ' + ex.message, 'err');
    console.error(ex);
  } finally {
    hideLoading();
    btn.disabled = false;
  }
}

// ─── CATEGORIAS DO ALMOXARIFADO (aba Personalizar) ───────────
function renderCatsAlmox() {
  const el = document.getElementById('cat-almox-cloud'); if (!el) return;
  el.innerHTML = S.catsAlmox.map(c =>
    `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${corSegura(c.color)};display:inline-block;margin-right:3px"></span>${esc(c.name)}${acoesTag('catAlmox', c.id)}</div>`
  ).join('') || '<div style="color:var(--txt3);font-size:12.5px">Nenhuma categoria cadastrada</div>';
}

function addCatAlmox() {
  const n = document.getElementById('ncat-almox').value.trim();
  const col = document.getElementById('ncat-almox-color').value;
  if (!n) return;
  S.catsAlmox.push({ id: 'a' + Date.now(), name: n, color: col });
  persistConfig(); renderCatsAlmox(); populateFiltersAlmox();
  document.getElementById('ncat-almox').value = '';
}

function delCatAlmox(id) {
  // Quem pergunta é excluirOpcao (modal de confirmação, e recusa se estiver em
  // uso). Aqui só sobra a remoção em si.
  S.catsAlmox = S.catsAlmox.filter(c => c.id !== id);
  persistConfig(); renderCatsAlmox(); populateFiltersAlmox(); renderAlmox();
}

// ─── EXPORTAR ────────────────────────────────────────────────
function linhaAlmoxExport(it) {
  return {
    'Item': it.item || '', 'Categoria': getCatAlmox(it.categoria).name || '',
    'Modelo': it.modelo || '', 'N° Série': it.serie || '',
    'Saldo': Number(it.saldo || 0),
    'Validade mais próxima': it.validadeProxima ? fmtDate(it.validadeProxima) : '',
    'Lotes com saldo': (it.lotes || []).filter(l => l.saldo > 0).length,
    'Usado em': (it.usadoEm || []).join(' | '),
    'Observações': it.obs || ''
  };
}

function linhaLoteExport(it, l) {
  return {
    'Item': it.item || '', 'Categoria': getCatAlmox(it.categoria).name || '',
    'Lote (entrada em)': fmtDate(l.data_mov),
    'Quantidade que entrou': Number(l.quantidade || 0),
    'Saldo do lote': Number(l.saldo || 0),
    'Validade': l.validade ? fmtDate(l.validade) : '',
    'Situação': !l.validade ? 'sem validade'
      : (diasAte(l.validade) < 0 ? 'vencido' : (diasAte(l.validade) <= 30 ? 'vence em 30 dias' : 'ok')),
    'Usuário': l.usuario || '', 'Observações': l.obs_mov || ''
  };
}

function linhaAlmoxHistExport(it, m) {
  const lote = m.tipo === 'entrada' ? null : (it.lotes || []).find(l => l.id === m.lote_id);
  return {
    'Item': it.item || '', 'Categoria': getCatAlmox(it.categoria).name || '',
    'Data/Hora': m.criado_em ? new Date(m.criado_em).toLocaleString('pt-BR') : '',
    'Tipo': m.tipo === 'saida' ? 'Saída' : 'Entrada',
    'Data Movimentação': fmtDate(m.data_mov),
    'Quantidade': Number(m.quantidade || 0),
    'Validade': m.validade ? fmtDate(m.validade) : '',
    'Lote de origem': lote ? fmtDate(lote.data_mov) : '',
    'Usuário': m.usuario || '', 'Observações': m.obs_mov || ''
  };
}

// ─── IMPORTAÇÃO EM MASSA ─────────────────────────────────────
// Serve aos dois cadastros. O que muda entre eles é a planilha modelo, as
// colunas lidas e a rota da API; as REGRAS (campo obrigatório, repetido, valor
// que não existe) ficam só no servidor, e a tela mostra o que voltou.
let _importRows = [];              // linhas lidas da planilha (a API confere e grava)
let _importTipo = 'patrimonio';    // 'patrimonio' | 'almoxarifado'

const ehAlmoxImport = () => _importTipo === 'almoxarifado';

function trocarTipoImport(tipo) {
  _importTipo = tipo;
  renderImportacao();
}

function renderImportacao() {
  const almox = ehAlmoxImport();

  // O botão exporta o que o seletor estiver mostrando.
  document.getElementById('import-titulo').textContent =
    almox ? 'Exportar almoxarifado' : 'Exportar patrimônios';

  const podeImportar = can('cadastrar');
  document.querySelectorAll('#tipo-import, #page-importacao .import-card')
    .forEach(el => { el.style.display = podeImportar ? '' : 'none'; });
  document.querySelectorAll('#tipo-import .tipo-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.tipo === _importTipo));

  // Lista de valores aceitos, como referência visual.
  const el = document.getElementById('import-ref');
  if (el) {
    const linhas = almox
      ? [['Categorias válidas', S.catsAlmox.map(c => c.name).join(', ')],
         ['Obrigatórios', 'Item, Categoria, Modelo, N° Série e Quantidade'],
         ['Quantidade', 'número maior que zero (ex.: 12 ou 2,5)'],
         ['Validade', 'opcional, no formato AAAA-MM-DD (ex.: 2027-03-31)'],
         ['Usado em (opcional)', 'modelo do patrimônio; vários separados por | : ' + modelosDoPatrimonio().join(', ')]]
      : [['Categorias válidas', S.cats.map(c => c.name).join(', ')],
         ['Status válidos', S.statusOpts.map(s => s.name).join(', ')],
         ['Locais válidos', S.locais.join(', ')]];
    el.innerHTML = `<div class="import-ref-lista">
      ${linhas.map(([t, v]) => `<div><strong>${esc(t)}:</strong> ${esc(v) || '<em>nenhum</em>'}</div>`).join('')}
    </div>`;
  }

  // Trocar de tipo recomeça a importação: as colunas são outras.
  _importRows = [];
  const prev = document.getElementById('import-preview');
  if (prev) prev.innerHTML = '';
  const btn = document.getElementById('import-confirm-btn');
  if (btn) btn.style.display = 'none';
  const fileInput = document.getElementById('import-file');
  if (fileInput) fileInput.value = '';
}

// Baixa planilha modelo com cabeçalhos e uma linha de exemplo.
function downloadModelo() {
  const almox = ehAlmoxImport();

  const exemplo = almox ? {
    'Item': 'Bobina 80mm',
    'Categoria': S.catsAlmox[0]?.name || 'Bobina',
    'Modelo': '80mm x 40m',
    'N° Série': 'SN-BOB-0001',
    'Quantidade': 12,
    'Validade': '2027-03-31',
    'Usado em': modelosDoPatrimonio()[0] || '',
    'Usuário': '',
    'Observações': 'Compra de janeiro'
  } : {
    'Nº Patrimônio': '001',
    'Marca': 'Dell',
    'Modelo': 'Vostro 3500',
    'N° Série': 'SN-ABC-12345',
    'Categoria': S.cats[0]?.name || 'Notebook',
    'Status': S.statusOpts[0]?.name || 'Em uso',
    'Local Atual': S.locais[0] || 'TI',
    'Usuário Atual': 'Fulano de Tal'
  };

  const ws = XLSX.utils.json_to_sheet([exemplo]);
  ws['!cols'] = [{wch:22},{wch:22},{wch:18},{wch:18},{wch:14},{wch:16},{wch:20},{wch:26}];
  const hStyle = {font:{bold:true,color:{rgb:'FFFFFF'}},fill:{fgColor:{rgb:'1E3A8A'}},alignment:{horizontal:'center'}};
  ['A1','B1','C1','D1','E1','F1','G1','H1'].forEach(a => { if(ws[a]) ws[a].s = hStyle; });

  const ref = almox ? [
    { 'Campo': 'Item',       'Valores aceitos': 'Obrigatório — não pode repetir um item já cadastrado' },
    { 'Campo': 'Categoria',  'Valores aceitos': S.catsAlmox.map(c => c.name).join(' | ') || '(cadastre em Personalizar)' },
    { 'Campo': 'Modelo',     'Valores aceitos': 'Obrigatório — texto' },
    { 'Campo': 'N° Série',   'Valores aceitos': 'Obrigatório — não pode repetir' },
    { 'Campo': 'Quantidade', 'Valores aceitos': 'Obrigatório — número maior que zero (12 ou 2,5)' },
    { 'Campo': 'Validade',   'Valores aceitos': 'Opcional — AAAA-MM-DD (ex.: 2027-03-31)' },
    { 'Campo': 'Usado em',   'Valores aceitos': 'Opcional — modelo do patrimônio, vários separados por | : ' +
                                                (modelosDoPatrimonio().join(' | ') || '(nenhum patrimônio cadastrado)') },
    { 'Campo': 'Usuário',    'Valores aceitos': 'Opcional — quem recebeu' },
    { 'Campo': 'Observações','Valores aceitos': 'Opcional — texto' }
  ] : [
    { 'Campo': 'Categoria',  'Valores aceitos': S.cats.map(c => c.name).join(' | ') },
    { 'Campo': 'Status',     'Valores aceitos': S.statusOpts.map(s => s.name).join(' | ') },
    { 'Campo': 'Local Atual','Valores aceitos': S.locais.join(' | ') },
    { 'Campo': 'Nº Patrimônio', 'Valores aceitos': 'Obrigatório — texto ou número' },
    { 'Campo': 'Marca',      'Valores aceitos': 'Obrigatório — texto' },
    { 'Campo': 'Modelo',     'Valores aceitos': 'Obrigatório — texto' },
    { 'Campo': 'N° Série',   'Valores aceitos': 'Obrigatório — texto' },
    { 'Campo': 'Usuário Atual', 'Valores aceitos': 'Opcional — texto' }
  ];
  const wsRef = XLSX.utils.json_to_sheet(ref);
  wsRef['!cols'] = [{wch:18},{wch:60}];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, almox ? 'Almoxarifado' : 'Patrimonios');
  XLSX.utils.book_append_sheet(wb, wsRef, 'Instruções');
  XLSX.writeFile(wb, almox ? 'modelo_importacao_almoxarifado.xlsx' : 'modelo_importacao_patrimonios.xlsx');
}

// Lê o arquivo escolhido e manda CONFERIR na API (sem gravar nada).
function handleImportFile(input) {
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const brutas = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!brutas.length) { showToast('A planilha não tem nenhuma linha preenchida.', 'err'); return; }
      _importRows = brutas.map(ehAlmoxImport() ? _linhaAlmoxDaPlanilha : _linhaDaPlanilha);
    } catch(err) {
      showToast('Erro ao ler arquivo: ' + err.message, 'err');
      return;
    }
    showLoading('Conferindo a planilha...');
    try {
      const res = ehAlmoxImport()
        ? await DB.bulkCreateAlmox(_importRows, true)
        : await DB.bulkCreateItems(_importRows, true);
      _renderImportPreview(res);
    } catch(err) {
      _importRows = [];
      showToast('Erro ao conferir: ' + err.message, 'err');
    } finally { hideLoading(); }
  };
  reader.readAsArrayBuffer(file);
}

// Uma linha da planilha -> objeto que a API entende.
// __rowNum__ é a linha real no Excel (começando em 0): usar a posição no array
// erraria o número da linha sempre que houvesse uma linha em branco no meio.
function _colunaDe(r) {
  return (...nomes) => {
    for (const n of nomes) if (r[n] != null && r[n] !== '') return String(r[n]).trim();
    return '';
  };
}
function _linhaDoExcel(r, idx) {
  return Number.isInteger(r.__rowNum__) ? r.__rowNum__ + 1 : idx + 2;
}

function _linhaDaPlanilha(r, idx) {
  const col = _colunaDe(r);
  return {
    linha:         _linhaDoExcel(r, idx),
    patrimonio:    col('Nº Patrimônio', 'No Patrimônio', 'N° Patrimônio', 'Patrimônio'),
    nome:          col('Marca', 'Nome'),
    modelo:        col('Modelo'),
    serie:         col('N° Série', 'Nº Série', 'No Série', 'Série', 'Serie'),
    categoria:     col('Categoria'),
    status:        col('Status'),
    local_atual:   col('Local Atual', 'Local'),
    usuario_atual: col('Usuário Atual', 'Usuario Atual')
  };
}

function _linhaAlmoxDaPlanilha(r, idx) {
  const col = _colunaDe(r);
  return {
    linha:      _linhaDoExcel(r, idx),
    item:       col('Item', 'Material', 'Produto'),
    categoria:  col('Categoria'),
    modelo:     col('Modelo'),
    serie:      col('N° Série', 'Nº Série', 'No Série', 'Série', 'Serie'),
    quantidade: col('Quantidade', 'Qtd', 'Qtde'),
    // O Excel pode entregar a data como texto ou como número de série dele;
    // _dataDaPlanilha devolve sempre AAAA-MM-DD, que é o que a API espera.
    validade:   _dataDaPlanilha(r['Validade'] ?? r['Data de Validade']),
    data_mov:   _dataDaPlanilha(r['Data'] ?? r['Data de Movimentação']),
    usado_em:   col('Usado em', 'Usado Em', 'Usado no', 'Aplicação'),
    usuario:    col('Usuário', 'Usuario', 'Usuário Atual'),
    obs:        col('Observações', 'Observacoes', 'Obs')
  };
}

// Data vinda da planilha -> 'AAAA-MM-DD'. Aceita texto ISO, dd/mm/aaaa e o
// número de série de data do Excel (45000 = 2023-03-15).
function _dataDaPlanilha(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && XLSX.SSF) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s = String(v).trim();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return s.slice(0, 10);
}

function _renderImportPreview(res) {
  const almox = ehAlmoxImport();
  const erros = res.erros || [];
  const porLinha = new Map();
  erros.forEach(er => {
    if (!porLinha.has(er.linha)) porLinha.set(er.linha, []);
    porLinha.get(er.linha).push(er);
  });
  const linhasComErro = _importRows.filter(r => porLinha.has(r.linha)).length;
  const semProblema   = _importRows.length - linhasComErro;

  let h = `
    <div class="faixa-wrap" style="margin:1rem 0">
      <button type="button" class="faixa-seta esq" onclick="rolarFaixa(this,-1)" aria-label="Ver os anteriores">‹</button>
      <div class="faixa-pista miuda" onscroll="atualizarSetas(this)">
        <div class="stat" style="padding:.75rem 1rem">
          <div class="stat-label">Total de linhas</div><div class="stat-val">${_importRows.length}</div>
        </div>
        <div class="stat" style="padding:.75rem 1rem">
          <div class="stat-label">Sem problema</div><div class="stat-val" style="color:#059669">${semProblema}</div>
        </div>
        <div class="stat" style="padding:.75rem 1rem">
          <div class="stat-label">Com erro</div><div class="stat-val" style="color:#dc2626">${linhasComErro}</div>
        </div>
      </div>
      <button type="button" class="faixa-seta dir" onclick="rolarFaixa(this,1)" aria-label="Ver os próximos">›</button>
    </div>`;

  // Com erro, a lista de correções vem ANTES da tabela: é o que a pessoa
  // precisa ler, e numa planilha de 300 linhas ficaria escondida lá embaixo.
  if (erros.length) {
    const itens = erros.map(er => {
      const onde = (er.linha != null ? 'Linha ' + esc(er.linha) : 'Planilha') + (er.campo ? ' · ' + esc(er.campo) : '');
      return `<li style="margin-bottom:.45rem">
          <strong>${onde}:</strong> ${esc(er.motivo)}<br>
          <span style="color:var(--txt2)">👉 ${esc(er.correcao || '')}</span>
        </li>`;
    }).join('');
    h += `<div class="card" style="padding:1rem 1.25rem;margin-bottom:1rem;border-color:#dc2626;background:var(--danger-bg)">
      <div style="font-weight:700;color:var(--danger-txt);margin-bottom:.35rem">
        <i class="ti ti-alert-triangle"></i> Nada foi gravado — ${erros.length} ${erros.length === 1 ? 'problema encontrado' : 'problemas encontrados'}
      </div>
      <div style="font-size:12.5px;color:var(--txt2);margin-bottom:.75rem">
        A importação só grava quando a planilha inteira estiver certa. Corrija os itens abaixo no Excel, salve e escolha o arquivo de novo.
      </div>
      <ol style="margin:0;padding-left:1.25rem;font-size:13px;line-height:1.55;max-height:320px;overflow-y:auto">${itens}</ol>
    </div>`;
  }

  const cabecalho = almox
    ? '<th style="width:50px">Linha</th><th>Item</th><th>Categoria</th><th>Modelo</th><th>Série</th><th>Quantidade</th><th>Validade</th><th>Situação</th>'
    : '<th style="width:50px">Linha</th><th>Nº</th><th>Marca</th><th>Modelo</th><th>Série</th><th>Categoria</th><th>Status</th><th>Situação</th>';

  const linhasTabela = _importRows.map(r => {
    const es = porLinha.get(r.linha);
    const situacao = !es
      ? '<span style="color:#059669;font-weight:600">✓ OK</span>'
      : `<span style="color:#dc2626;font-size:11.5px" title="${esc(es.map(x => x.motivo).join('; '))}">✗ ${esc(es[0].motivo)}${es.length > 1 ? ' (+' + (es.length - 1) + ')' : ''}</span>`;
    const celulas = almox
      ? [r.item, r.categoria, r.modelo, r.serie, r.quantidade, r.validade]
      : [r.patrimonio, r.nome, r.modelo, r.serie, r.categoria, r.status];
    return `<tr style="${es ? 'background:var(--danger-bg)' : ''}">
        <td>${esc(r.linha)}</td>
        ${celulas.map(c => `<td>${esc(c || '')}</td>`).join('')}
        <td>${situacao}</td>
      </tr>`;
  }).join('');

  h += `<div class="card"><div class="table-wrap" style="max-height:340px;overflow-y:auto">
      <table><thead><tr>${cabecalho}</tr></thead><tbody>${linhasTabela}</tbody></table>
    </div></div>`;

  document.getElementById('import-preview').innerHTML = h;
  medirFaixas();

  const btn = document.getElementById('import-confirm-btn');
  if (!erros.length && _importRows.length) {
    btn.style.display = '';
    btn.textContent = `Importar ${_importRows.length} ${_importRows.length === 1 ? (almox ? 'item' : 'patrimônio') : (almox ? 'itens' : 'patrimônios')}`;
    btn.disabled = false;
  } else {
    btn.style.display = 'none';
    showToast('A planilha tem erros — veja a lista e corrija antes de importar.', 'err');
  }
}

async function confirmImport() {
  if (!can('cadastrar')) { showToast('Sem permissão para importar.','err'); return; }
  if (!_importRows.length) { showToast('Escolha a planilha primeiro.','err'); return; }
  const almox = ehAlmoxImport();
  if (!confirm(`Importar ${_importRows.length} ${almox ? 'item(ns) de almoxarifado' : 'patrimônio(s)'}? Esta ação criará os registros no banco.`)) return;

  showLoading(`Importando ${_importRows.length} itens...`);
  try {
    const res = almox
      ? await DB.bulkCreateAlmox(_importRows, false)
      : await DB.bulkCreateItems(_importRows, false);
    if (!res.gravado) {
      // Algo mudou entre a conferência e a gravação (outra pessoa cadastrou o
      // mesmo número, por exemplo). Nada entrou; mostra o motivo.
      _renderImportPreview(res);
      return;
    }
    showToast(`✅ ${res.sucesso} ${almox ? 'itens' : 'patrimônios'} importados com sucesso!`);
    _importRows = [];
    if (almox) {
      await recarregarAlmox();
      nav('almoxarifado');
    } else {
      S.items = await DB.loadItems();
      S.lastFiltered = [...S.items];
      nav('lista');
    }
  } catch(e) {
    showToast('Erro na importação: ' + e.message, 'err');
  } finally { hideLoading(); }
}

// ─── EXPORTAR EXCEL ──────────────────────────────────────────
function openExportModal(preSelecionar) {
  // A tela de Importar/Exportar manda qual opção já vem marcada, para o que
  // está escolhido ali (Patrimônio ou Almoxarifado) valer também na exportação.
  if (preSelecionar) {
    const op = document.querySelector(`input[name=exptype][value="${preSelecionar}"]`);
    if (op) op.checked = true;
  }
  document.getElementById('exp-modal').style.display = 'flex';
}

function exportarDaImportacao() {
  openExportModal(ehAlmoxImport() ? 'almox' : 'todos');
}
function closeExportModal(e) { if (e.target.id==='exp-modal') document.getElementById('exp-modal').style.display='none'; }
function buildRow(it) {
  const last = (it.historico||[]).slice(-1)[0] || {};
  return { 'Nº Patrimônio':it.patrimonio||'','Marca':it.nome||'','Modelo':it.modelo||'','N° Série':it.serie||'',
    'Categoria':(it.categoria||[]).map(id=>getCat(id).name).join(', '),
    'Status':(it.status||[]).map(id=>getStat(id).name).join(', '),
    'Quem Recebeu/Retirou':last.quem_recebeu_retirou||'',
    'Usuário Atual':it.usuario_atual||'','Local Atual':it.local_atual||'',
    'Qtd. Movimentações':(it.historico||[]).length };
}
function buildHistRow(it,hv) {
  return { 'Nº Patrimônio':it.patrimonio||'','Marca':it.nome||'','Modelo':it.modelo||'','N° Série':it.serie||'',
    'Data/Hora':hv.timestamp?new Date(hv.timestamp).toLocaleString('pt-BR'):'',
    'Tipo':hv.tipo||'','Data Movimentação':fmtDate(hv.data_mov),
    'Entrada/Saída':hv.quem_recebeu_retirou||'','Usuário Atual':hv.usuario_atual||'',
    'Local':hv.local||'','Status':hv.status?getStat(hv.status).name:'',
    'Observações':hv.obs_mov||'' };
}
function styleSheet(ws) {
  const hStyle = {font:{bold:true,color:{rgb:'FFFFFF'},sz:11},fill:{fgColor:{rgb:'1E3A8A'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}};
  const range = XLSX.utils.decode_range(ws['!ref']||'A1');
  for (let C=range.s.c;C<=range.e.c;C++){const a=XLSX.utils.encode_cell({r:0,c:C});if(ws[a])ws[a].s=hStyle;}
  ws['!rows']=[{hpx:22}];
}
function doExport() {
  const type = document.querySelector('input[name=exptype]:checked').value;
  const wb = XLSX.utils.book_new();
  const cols = [{wch:14},{wch:26},{wch:16},{wch:18},{wch:18},{wch:24},{wch:16},{wch:12}];
  // Almoxarifado: saldo por item, lote a lote, ou o histórico completo.
  if (type==='almox' || type==='almox-lotes' || type==='almox-historico') {
    const itens = S.lastFilteredAlmox && S.lastFilteredAlmox.length ? S.lastFilteredAlmox : S.almox;
    let rows = [], nome = 'Almoxarifado';
    if (type==='almox') {
      rows = itens.map(linhaAlmoxExport);
    } else if (type==='almox-lotes') {
      itens.forEach(it => (it.lotes||[]).forEach(l => rows.push(linhaLoteExport(it, l))));
      nome = 'Lotes';
    } else {
      itens.forEach(it => (it.historico||[]).forEach(m => rows.push(linhaAlmoxHistExport(it, m))));
      nome = 'Movimentações';
    }
    if(!rows.length){ showToast('Nada para exportar no almoxarifado.','err'); return; }
    const ws=XLSX.utils.json_to_sheet(rows);
    ws['!cols']=[{wch:26},{wch:18},{wch:18},{wch:16},{wch:14},{wch:16},{wch:16},{wch:26},{wch:26},{wch:26}];
    styleSheet(ws);XLSX.utils.book_append_sheet(wb,ws,nome);
    const hoje=new Date().toLocaleDateString('pt-BR').replace(/\//g,'-');
    XLSX.writeFile(wb,`almoxarifado_${hoje}.xlsx`);
    document.getElementById('exp-modal').style.display='none';
    return;
  }
  if (type==='historico') {
    const rows=[];S.items.forEach(it=>(it.historico||[]).forEach(hv=>rows.push(buildHistRow(it,hv))));
    if(!rows.length){alert('Nenhuma movimentação.');return;}
    const ws=XLSX.utils.json_to_sheet(rows);ws['!cols']=[{wch:14},{wch:26},{wch:16},{wch:18},{wch:14},{wch:18},{wch:24},{wch:16},{wch:28}];
    styleSheet(ws);XLSX.utils.book_append_sheet(wb,ws,'Histórico');
  } else if (type==='categorias') {
    S.cats.forEach(cat=>{const items=S.items.filter(it=>(it.categoria||[]).includes(cat.id));if(!items.length)return;
      const ws=XLSX.utils.json_to_sheet(items.map(buildRow));ws['!cols']=cols;styleSheet(ws);
      XLSX.utils.book_append_sheet(wb,ws,cat.name.substring(0,31));});
  } else {
    const data=(type==='filtrado'?S.lastFiltered:S.items).map(buildRow);
    if(!data.length){alert('Nenhum item.');return;}
    const ws=XLSX.utils.json_to_sheet(data);ws['!cols']=cols;styleSheet(ws);
    XLSX.utils.book_append_sheet(wb,ws,'Patrimônios');
  }
  const today=new Date().toLocaleDateString('pt-BR').replace(/\//g,'-');
  XLSX.writeFile(wb,`patrimonios_${today}.xlsx`);
  document.getElementById('exp-modal').style.display='none';
}

// ─── AMBIENTE ────────────────────────────────────────────────
// Mesmo desenho do Gerente Assist. GET /api/v1/ambiente (público) diz se o
// servidor está em SOMENTE LEITURA e qual commit ele está rodando.
//
//   Só leitura                       -> selo âmbar "DADOS REAIS · SÓ LEITURA" + versão
//   Servido pelo próprio Node, gravando (localhost / IP da rede)
//                                    -> selo vermelho "PRODUÇÃO · GRAVANDO" + versão
//   Endereço público (Vercel)        -> nada: é o uso normal
//
// O vermelho existe porque o notebook não tem banco de teste: `iniciar.bat`
// liga no mesmo ESTOQUE_TI da empresa, e sem aviso a tela local é igual à de
// produção.
let _ambiente = null;

async function carregarAmbiente() {
  try {
    const r = await fetch(API_URL + '/api/v1/ambiente');
    // API antiga (sem a rota) devolve 404: o selo simplesmente não aparece.
    _ambiente = r.ok ? await r.json() : null;
  } catch(e) { _ambiente = null; }
  marcarAmbiente();
}

function ambienteSoLeitura() { return !!(_ambiente && _ambiente.somenteLeitura); }

function marcarAmbiente() {
  let html = '';
  if (_ambiente) {
    const local = API_URL === '';   // tela servida pelo próprio Node, não pela Vercel
    const versao = `<span class="selo-versao" title="Commit que esta API está rodando. Compare com git log --oneline -1.">API ${esc(_ambiente.versao || 'sem versão')}</span>`;
    if (_ambiente.somenteLeitura) {
      html = '<span class="selo-leitura" title="Dados reais do ESTOQUE_TI. A gravação está travada no servidor: cadastrar, movimentar, importar e mexer em usuário não passa.">DADOS REAIS · SÓ LEITURA</span>' + versao;
    } else if (local) {
      html = '<span class="selo-producao" title="Este servidor grava no banco ESTOQUE_TI de verdade. Para testar sem risco, suba com api\\iniciar-leitura.bat.">PRODUÇÃO · GRAVANDO</span>' + versao;
    }
  }
  document.querySelectorAll('[data-selo-ambiente]').forEach(el => { el.innerHTML = html; });
}

// ─── INIT ────────────────────────────────────────────────────
// Aguarda DOM completo antes de qualquer acesso a elementos
window.addEventListener('DOMContentLoaded', () => {
  try {
    carregarAmbiente();   // em paralelo: não segura a tela de login
    appInit();
  } catch(e) {
    document.body.innerHTML = `<div style="padding:2rem;font-family:sans-serif;color:#dc2626">
      <h2>Erro ao iniciar</h2><pre style="background:#fee2e2;padding:1rem;border-radius:8px;font-size:13px">${esc(e.message)}\n${esc(e.stack||'')}</pre>
    </div>`;
  }
});