// ═══════════════════════════════════════════════════════════════
//  app.js — Inventory Guemat  (Supabase edition)
// ═══════════════════════════════════════════════════════════════

// ── Estado global
let S = {
  items: [], cats: [], pessoas: [], locais: [],
  statusOpts: [], vinculos: { entrada:{statusIds:[],localIds:[]}, saida:{statusIds:[],localIds:[]} },
  editId: null, dark: false, lastFiltered: [],
  role: 'leitor'   // 'admin' | 'editor' | 'leitor'  — carregado após login
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
      document.getElementById('user-email').textContent = user.email;
      await loadAll();
    } else {
      showScreen('login');
    }
  });
}

function showScreen(which) {
  document.getElementById('screen-login').style.display = which === 'login' ? 'flex'  : 'none';
  document.getElementById('screen-app').style.display   = which === 'app'   ? 'block' : 'none';
}

async function loadAll() {
  showLoading('Carregando dados...');
  try {
    // Carrega perfil do usuário para obter o role
    const profile = await DB.getMyProfile();

    if (profile?._error) {
      console.error('Perfil com erro:', profile._error);
      showToast('⚠️ Erro ao carregar perfil: rode o SQL fix_rls_profiles no Supabase.', 'err');
    }

    S.role = profile?.role || 'leitor';
    console.log('Role carregado:', S.role); // debug — remover depois

    const [cfg, items] = await Promise.all([DB.loadConfig(), DB.loadItems()]);
    S.cats       = cfg.cats;
    S.pessoas    = cfg.pessoas;
    S.locais     = cfg.locais;
    S.statusOpts = cfg.statusOpts;
    S.vinculos   = cfg.vinculos;
    S.items      = items;
    S.lastFiltered = [...items];

    applyRoleUI();
    renderDash();

    DB.subscribeItems(async () => {
      const fresh = await DB.loadItems();
      S.items = fresh;
      S.lastFiltered = [...fresh];
      const page = document.querySelector('.page.active')?.id;
      if (page === 'page-dashboard') renderDash();
      if (page === 'page-lista')     renderLista();
    });
  } catch(e) {
    showToast('Erro ao carregar dados: ' + e.message, 'err');
    console.error(e);
  } finally {
    hideLoading();
  }
}

// Persiste apenas config (items salvos direto no banco via DB.*)
async function persistConfig() {
  try {
    await DB.saveConfig({
      cats: S.cats, pessoas: S.pessoas, locais: S.locais,
      statusOpts: S.statusOpts, vinculos: S.vinculos
    });
  } catch(e) { showToast('Erro ao salvar configuração: ' + e.message, 'err'); }
}

// ─── LOGIN ────────────────────────────────────────────────────
async function doLogin(e) {
  e.preventDefault();
  const email = document.getElementById('l-email').value.trim();
  const pass  = document.getElementById('l-pass').value;
  const btn   = document.getElementById('l-btn');
  const err   = document.getElementById('l-err');
  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  try {
    await Auth.login(email, pass);
    // onAuthChange cuida do resto
  } catch(ex) {
    err.textContent = 'Email ou senha incorretos.';
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

// ─── NAVEGAÇÃO ───────────────────────────────────────────────
function nav(p) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  const titles = {dashboard:'Dashboard',lista:'Patrimônios',cadastro:'Cadastro',config:'Personalizar',auditoria:'Auditoria',usuarios:'Usuários'};
  document.getElementById('topbar-title').textContent = titles[p] || '';
  const navIdx = {dashboard:0,lista:1,cadastro:2,config:5,auditoria:4,usuarios:6};
  document.querySelectorAll('.nav-item')[navIdx[p]]?.classList.add('active');
  if (p === 'dashboard') renderDash();
  if (p === 'lista')     { populateFilters(); renderLista(); }
  if (p === 'cadastro')  {
    if (!can('cadastrar')) { showToast('Sem permissão para cadastrar.','err'); return; }
    S.editId = null; movMode = false; renderForm();
  }
  if (p === 'config')    {
    if (!can('config')) { showToast('Sem permissão para configurações.','err'); return; }
    renderConfig();
  }
  if (p === 'auditoria') renderAuditoria();
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
function catPills(arr)  { return (arr||[]).map(id => { const c=getCat(id);  return `<span class="cat-pill" style="background:${c.color}22;color:${c.color}">${c.name}</span>`; }).join('')||'—'; }
function statPills(arr) { return (arr||[]).map(id => { const s=getStat(id); return `<span class="cat-pill" style="background:${s.color}22;color:${s.color}">${s.name}</span>`; }).join('')||'—'; }
function esc(str) { return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── PERMISSÕES ──────────────────────────────────────────────
const ROLES = { admin:3, editor:2, leitor:1 };
function can(action) {
  const r = ROLES[S.role] || 1;
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

function applyRoleUI() {
  // Badge de role no topbar
  const badge = document.getElementById('role-badge');
  const labels = { admin:'👑 Admin', editor:'✏️ Editor', leitor:'👁️ Leitor' };
  const colors = { admin:'#7c3aed', editor:'#2563eb', leitor:'#059669' };
  if (badge) {
    badge.textContent = labels[S.role] || S.role;
    badge.style.color = colors[S.role] || '#888';
  }

  // Mostra/oculta aba de Usuários na sidebar
  const navUsuarios = document.getElementById('nav-usuarios');
  if (navUsuarios) navUsuarios.style.display = can('gerenciar_usuarios') ? '' : 'none';

  // Botão "Novo Patrimônio" no topbar
  const btnNovo = document.getElementById('btn-novo-topbar');
  if (btnNovo) {
    btnNovo.disabled = !can('cadastrar');
    btnNovo.title    = can('cadastrar') ? '' : 'Sem permissão para cadastrar';
  }

  // Exportar — sempre visível para todos
}

// Aplica disabled em botões de ação de um item conforme role
function actionButtons(id) {
  const edOk  = can('editar');
  const movOk = can('movimentar');
  const delOk = can('excluir');
  const dis   = (ok, tip) => !ok ? `disabled title="${tip}" style="opacity:.4;cursor:not-allowed"` : '';
  return `<div class="actions-cell">
    <button class="btn btn-sm" onclick="${edOk?`editItem(${id})`:''}" ${dis(edOk,'Sem permissão para editar')} title="${edOk?'Editar':'Sem permissão'}"><i class="ti ti-edit"></i></button>
    <button class="btn btn-sm btn-warn" onclick="${movOk?`novaMovimentacao(${id})`:''}" ${dis(movOk,'Sem permissão para movimentar')} title="${movOk?'Movimentar':'Sem permissão'}"><i class="ti ti-transfer"></i></button>
    <button class="btn btn-sm" style="${delOk?'border-color:var(--danger-txt);color:var(--danger-txt)':'opacity:.4;cursor:not-allowed'}" onclick="${delOk?`delItem(${id})`:''}" ${dis(delOk,'Sem permissão para excluir')} title="${delOk?'Excluir':'Sem permissão'}"><i class="ti ti-trash"></i></button>
  </div>`;
}

// ─── DASHBOARD ───────────────────────────────────────────────
function renderDash() {
  const total    = S.items.length;
  const totalMov = S.items.reduce((a,it) => a + (it.historico||[]).length, 0);
  document.getElementById('stats-row').innerHTML = `
    <div class="stat"><div class="stat-label">Total Patrimônios</div><div class="stat-val">${total}</div><div class="stat-sub">itens cadastrados</div></div>
    <div class="stat"><div class="stat-label">Categorias</div><div class="stat-val">${S.cats.length}</div><div class="stat-sub">tipos cadastrados</div></div>
    <div class="stat"><div class="stat-label">Movimentações</div><div class="stat-val" style="color:#d97706">${totalMov}</div><div class="stat-sub">registros no histórico</div></div>
    <div class="stat"><div class="stat-label">Pessoas</div><div class="stat-val" style="color:#7c3aed">${S.pessoas.length}</div><div class="stat-sub">cadastradas</div></div>`;
  const recent = [...S.items].slice(-5).reverse();
  document.getElementById('dash-tbody').innerHTML = recent.length
    ? recent.map(i => `<tr>
        <td><strong>${i.patrimonio||'—'}</strong></td>
        <td>${i.nome||'—'}</td>
        <td>${i.serie||'—'}</td>
        <td>${catPills(i.categoria)}</td>
        <td>${statPills(i.status)}</td>
      </tr>`).join('')
    : '<tr class="empty-row"><td colspan="5">Nenhum patrimônio cadastrado</td></tr>';
}

// ─── LISTA ───────────────────────────────────────────────────
function populateFilters() {
  const fc = document.getElementById('fcat'), fs = document.getElementById('fstat');
  const vc = fc.value, vs = fs.value;
  fc.innerHTML = '<option value="">Todas as categorias</option>' + S.cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  fs.innerHTML = '<option value="">Todos os status</option>'     + S.statusOpts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  fc.value = vc; fs.value = vs;
}
function renderLista() {
  const srch  = (document.getElementById('srch').value||'').toLowerCase();
  const catF  = document.getElementById('fcat').value;
  const statF = document.getElementById('fstat').value;
  const filtered = S.items.filter(i => {
    if (srch  && !(i.patrimonio||'').toLowerCase().includes(srch)
              && !(i.nome||'').toLowerCase().includes(srch)
              && !(i.serie||'').toLowerCase().includes(srch)) return false;
    if (catF  && !(i.categoria||[]).includes(catF))  return false;
    if (statF && !(i.status||[]).includes(statF))    return false;
    return true;
  });
  S.lastFiltered = filtered;
  document.getElementById('lista-head').innerHTML =
    '<th>Nº</th><th>Nome</th><th>N° Série</th><th>Categoria</th><th>Status</th><th>Local Atual</th><th>Usuário Atual</th><th>Movim.</th><th>Ações</th>';
  document.getElementById('lista-tbody').innerHTML = filtered.length
    ? filtered.map(it => `<tr>
        <td><strong>${it.patrimonio||'—'}</strong></td>
        <td>${it.nome||'—'}</td>
        <td>${it.serie||'—'}</td>
        <td>${catPills(it.categoria)}</td>
        <td>${statPills(it.status)}</td>
        <td>${it.local_atual||'—'}</td>
        <td>${it.usuario_atual||'—'}</td>
        <td><span class="badge b-gray">${(it.historico||[]).length}</span></td>
        <td>${actionButtons(it.id)}</td>
      </tr>`).join('')
    : '<tr class="empty-row"><td colspan="9">Nenhum resultado encontrado</td></tr>';
}

// ─── FORMULÁRIO ──────────────────────────────────────────────
let msState = {};
let movMode = false;

function renderForm() {
  msState = {};
  const it     = S.editId != null ? (S.items.find(x => x.id === S.editId) || {}) : {};
  const isEdit = S.editId != null;
  document.getElementById('form-title').textContent = movMode
    ? 'Registrar Movimentação'
    : (isEdit ? 'Editar Patrimônio' : 'Novo Patrimônio');

  let h = '<form onsubmit="saveItem(event)"><div class="form-two-col">';

  if (!movMode) {
    h += `<div class="scard">
      <div class="scard-title"><i class="ti ti-clipboard-list"></i> Dados do Patrimônio
        <span style="font-size:11px;font-weight:400;color:var(--txt3)">— preenchidos no cadastro, editáveis</span>
      </div>
      <div class="form-grid">
        <div class="fg"><label class="flabel">Nº Patrimônio<span class="req">*</span></label>
          <input class="finput" id="f_patrimonio" value="${esc(it.patrimonio||'')}" required placeholder="Ex: 001"></div>
        <div class="fg"><label class="flabel">Nome do Item<span class="req">*</span></label>
          <input class="finput" id="f_nome" value="${esc(it.nome||'')}" required placeholder="Nome do item"></div>
        <div class="fg"><label class="flabel">Categoria<span class="req">*</span></label>
          <select class="finput" id="f_categoria">
            <option value="">Selecione...</option>
            ${S.cats.map(x=>`<option value="${esc(x.id)}"${Array.isArray(it.categoria)&&it.categoria[0]===x.id?' selected':''}>${esc(x.name)}</option>`).join('')}
          </select></div>
        <div class="fg"><label class="flabel">N° de Série<span class="req">*</span></label>
          <input class="finput" id="f_serie" value="${esc(it.serie||'')}" required placeholder="Ex: SN-0001-XYZ"></div>
        <div class="fg full"><label class="flabel">Status<span class="req">*</span></label>
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
        <i class="ti ti-info-circle"></i> Movimentando:<br><strong>${esc(it2.patrimonio||'')} — ${esc(it2.nome||'')}</strong>
        <div style="margin-top:.5rem">${statPills(it2.status)}</div>
      </div>
    </div>`;
  }

  h += `<div class="${movMode?'scard':'mov-card'}">
    <div class="scard-title"><i class="ti ti-transfer"></i> Dados da Movimentação
      <span style="font-size:11px;font-weight:400;color:var(--txt3)">— registrados a cada movimentação</span>
    </div>
    <div class="form-grid">
      <div class="fg"><label class="flabel">Data de Movimentação</label>
        <input class="finput" type="date" id="f_data_mov"></div>
      <div class="fg"><label class="flabel">Entrada ou Saída?</label>
        <select class="finput" id="f_quem_recebeu_retirou" onchange="onEntradaSaidaChange()">
          <option value="">Selecione...</option>
          <option value="Entrada">📥 Entrada</option>
          <option value="Saída">📤 Saída</option>
        </select></div>
      <div class="fg"><label class="flabel">Usuário Atual</label>
        <input class="finput" id="f_usuario_atual" placeholder="Nome do usuário atual" value="${(!movMode && it.usuario_atual) ? esc(it.usuario_atual) : ''}"></div>
      <div class="fg"><label class="flabel">Local Atual</label>
        <select class="finput" id="f_local_atual"><option value="">Selecione...</option>
          ${S.locais.map(l=>`<option${(!movMode && it.local_atual===l)?' selected':''}>${esc(l)}</option>`).join('')}
        </select></div>
      <div class="fg full"><label class="flabel">Observações da Movimentação</label>
        <textarea class="finput" id="f_obs_mov" rows="4" style="resize:vertical" placeholder="Descreva esta movimentação..."></textarea></div>
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
            ${hv.local ? `<span>Local: <strong>${esc(hv.local)}</strong></span>` : ''}
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

  document.getElementById('form-wrap').innerHTML = h;
  document.getElementById('form-alert').style.display = 'none';
}

function onEntradaSaidaChange() {
  const tipo = (document.getElementById('f_quem_recebeu_retirou')||{}).value || '';
  const v    = S.vinculos || {};
  const cfg  = tipo === 'Entrada' ? v.entrada : tipo === 'Saída' ? v.saida : null;

  const statSel = document.getElementById('f_status');
  if (statSel) {
    const allowedStat = cfg?.statusIds?.length ? cfg.statusIds : null;
    const prevVal = statSel.value;
    statSel.innerHTML = '<option value="">Selecione...</option>' +
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

function editItem(id)          { S.editId = id; movMode = false; nav('cadastro'); }
function novaMovimentacao(id)  { S.editId = id; movMode = true;  nav('cadastro'); }
function cancelEdit()          { S.editId = null; movMode = false; nav('lista'); }

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
  const quem_recebeu_retirou = document.getElementById('f_quem_recebeu_retirou')?.value || '';
  const local               = document.getElementById('f_local_atual')?.value || '';
  const usuario_atual       = document.getElementById('f_usuario_atual')?.value || '';
  const obs_mov             = document.getElementById('f_obs_mov')?.value || '';
  const mov = { data_mov, quem_recebeu_retirou, local, usuario_atual, obs_mov };

  showLoading('Salvando...');
  try {
    if (movMode) {
      await DB.registrarMovimentacao(S.editId, mov);
      showToast('✅ Movimentação registrada!');
      movMode = false; S.editId = null;
    } else {
      const patrimonio = document.getElementById('f_patrimonio').value.trim();
      const nome       = document.getElementById('f_nome').value.trim();
      const serie      = document.getElementById('f_serie').value.trim();
      const catVal     = document.getElementById('f_categoria').value;
      const statVal    = document.getElementById('f_status').value;

      if (!patrimonio || !nome || !serie) { showToast('Preencha os campos obrigatórios.','err'); return; }
      if (!catVal)  { showToast('Selecione uma categoria.','err'); return; }
      if (!statVal) { showToast('Selecione um status.','err'); return; }

      const item = { patrimonio, nome, serie, categoria:[catVal], status:[statVal] };

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
    nav('lista');
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
  const map = {tc:0,tp:1,tl:2,ts:3,tv:4};
  document.querySelectorAll('.stab')[map[id]]?.classList.add('active');
  renderConfig();
}
function renderConfig() { renderCats(); renderPessoas(); renderLocais(); renderStatOpts(); renderVinculos(); }

function renderCats() {
  const el = document.getElementById('cat-cloud'); if (!el) return;
  el.innerHTML = S.cats.map(c => `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${c.color};display:inline-block;margin-right:3px"></span>${esc(c.name)}<span class="tdel" onclick="delCat('${c.id}')">×</span></div>`).join('');
}
function addCat() {
  const n = document.getElementById('ncat').value.trim();
  const col = document.getElementById('ncat-color').value;
  if (!n) return;
  S.cats.push({id:'c'+Date.now(), name:n, color:col});
  persistConfig(); renderCats(); document.getElementById('ncat').value = '';
}
function delCat(id) { S.cats = S.cats.filter(c => c.id!==id); persistConfig(); renderCats(); }

function renderPessoas() {
  const el = document.getElementById('pess-cloud'); if (!el) return;
  el.innerHTML = S.pessoas.map((p,i) => `<div class="tag">${esc(p)}<span class="tdel" onclick="delPess(${i})">×</span></div>`).join('');
}
function addPess() {
  const v = document.getElementById('npess').value.trim();
  if (!v || S.pessoas.includes(v)) return;
  S.pessoas.push(v); persistConfig(); renderPessoas(); document.getElementById('npess').value = '';
}
function delPess(i) { S.pessoas.splice(i,1); persistConfig(); renderPessoas(); }

function renderLocais() {
  const el = document.getElementById('loc-cloud'); if (!el) return;
  el.innerHTML = S.locais.map((l,i) => `<div class="tag">${esc(l)}<span class="tdel" onclick="delLocal(${i})">×</span></div>`).join('');
}
function addLoc() {
  const v = document.getElementById('nloc').value.trim();
  if (!v || S.locais.includes(v)) return;
  S.locais.push(v); persistConfig(); renderLocais(); document.getElementById('nloc').value = '';
}
function delLocal(i) { S.locais.splice(i,1); persistConfig(); renderLocais(); }

function renderStatOpts() {
  const el = document.getElementById('stat-cloud'); if (!el) return;
  el.innerHTML = S.statusOpts.map(s => `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;margin-right:3px"></span>${esc(s.name)}<span class="tdel" onclick="delStat('${s.id}')">×</span></div>`).join('');
}
function addStat() {
  const n = document.getElementById('nstat').value.trim();
  const col = document.getElementById('nstat-color').value;
  if (!n) return;
  S.statusOpts.push({id:'s'+Date.now(), name:n, color:col});
  persistConfig(); renderStatOpts(); document.getElementById('nstat').value = '';
}
function delStat(id) { S.statusOpts = S.statusOpts.filter(s => s.id!==id); persistConfig(); renderStatOpts(); }

function renderVinculos() {
  const el = document.getElementById('tv'); if (!el || el.style.display==='none') return;
  const v = S.vinculos;
  function checkboxes(tipo, field, items, labelFn, idFn) {
    const sel = (v[tipo]?.[field]) || [];
    return items.map((item,i) => {
      const id = idFn(item,i); const lbl = labelFn(item); const chk = sel.includes(id)?'checked':'';
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:13px">
        <input type="checkbox" ${chk} onchange="toggleVinculo('${tipo}','${field}','${id}',this.checked)"
          style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer"> ${esc(lbl)}</label>`;
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
      <span style="font-size:12px;color:var(--txt3)">Verifique se rodou o setup_auditoria.sql no Supabase.</span>
    </td></tr>`;
  }
}

function _renderAuditRows(logs) {
  const el = document.getElementById('audit-body'); if (!el) return;
  const srch = _auditFiltro.toLowerCase();
  const filtered = srch
    ? logs.filter(r => (r.descricao||'').toLowerCase().includes(srch) || (r.user_email||'').toLowerCase().includes(srch))
    : logs;

  const iconMap = { INSERT:'ti-plus', UPDATE:'ti-edit', DELETE:'ti-trash' };
  const colorMap = { INSERT:'#059669', UPDATE:'#d97706', DELETE:'#dc2626' };
  const labelMap = { INSERT:'Cadastro', UPDATE:'Edição', DELETE:'Exclusão' };
  const tabelaMap = { patrimonios:'Patrimônio', movimentacoes:'Movimentação', config:'Configuração' };

  el.innerHTML = filtered.length ? filtered.map(r => `
    <tr>
      <td style="white-space:nowrap;color:var(--txt3);font-size:12px">${_fmtDTAudit(r.created_at)}</td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:20px;font-size:11.5px;font-weight:600;background:${colorMap[r.acao]}22;color:${colorMap[r.acao]}">
          <i class="ti ${iconMap[r.acao]||'ti-circle'}"></i> ${labelMap[r.acao]||r.acao}
        </span>
        <span style="font-size:11px;color:var(--txt3);margin-left:5px">${tabelaMap[r.tabela]||r.tabela}</span>
      </td>
      <td style="font-size:13px">${esc(r.descricao||'—')}</td>
      <td style="font-size:12px;color:var(--txt2)">${esc(r.user_email||'—')}</td>
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
  const fmt = obj => obj ? JSON.stringify(obj, null, 2) : 'N/A';
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

// ─── USUÁRIOS ────────────────────────────────────────────────
const ROLE_LABELS = { admin:'👑 Admin', editor:'✏️ Editor', leitor:'👁️ Leitor' };
const ROLE_COLORS = { admin:'#7c3aed', editor:'#2563eb', leitor:'#059669' };

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
  const myId = users.find(u => u.email === document.getElementById('user-email')?.textContent)?.id;

  el.innerHTML = users.map(u => {
    const isMe   = u.id === myId;
    const rcolor = ROLE_COLORS[u.role] || '#888';
    const rlabel = ROLE_LABELS[u.role] || u.role;
    return `<tr style="${!u.ativo?'opacity:.5':''}">
      <td>
        <div style="font-weight:600;font-size:13px">${esc(u.nome || '—')}</div>
        <div style="font-size:11.5px;color:var(--txt3)">${esc(u.email)}</div>
        ${isMe?`<span style="font-size:10px;background:#22c55e22;color:#16a34a;padding:1px 6px;border-radius:10px">você</span>`:''}
      </td>
      <td>
        <span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;background:${rcolor}22;color:${rcolor}">${rlabel}</span>
      </td>
      <td>
        <span style="padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500;background:${u.ativo?'#dcfce7':'#fee2e2'};color:${u.ativo?'#166534':'#991b1b'}">
          ${u.ativo ? '✓ Ativo' : '✗ Inativo'}
        </span>
      </td>
      <td style="font-size:12px;color:var(--txt3)">${_fmtDTAudit(u.created_at)}</td>
      <td>
        <div class="actions-cell" style="gap:6px">
          <button class="btn btn-sm" onclick="openEditUser('${u.id}','${esc(u.nome||'')}','${u.role}')" title="Editar"><i class="ti ti-edit"></i></button>
          <button class="btn btn-sm" onclick="toggleAtivo('${u.id}',${!u.ativo})" title="${u.ativo?'Desativar':'Ativar'}"
            style="${u.ativo?'color:var(--danger-txt);border-color:var(--danger-txt)':'color:#059669;border-color:#059669'}">
            <i class="ti ti-${u.ativo?'user-off':'user-check'}"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr class="empty-row"><td colspan="5">Nenhum usuário</td></tr>';
}

function openEditUser(id, nome, role) {
  document.getElementById('eu-id').value   = id;
  document.getElementById('eu-nome').value = nome;
  document.getElementById('eu-role').value = role;
  document.getElementById('user-modal').style.display = 'flex';
}

async function saveEditUser() {
  const id   = document.getElementById('eu-id').value;
  const nome = document.getElementById('eu-nome').value.trim();
  const role = document.getElementById('eu-role').value;
  showLoading('Salvando...');
  try {
    await DB.updateUserRole(id, role);
    if (nome) await DB.updateUserNome(id, nome);
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

async function openInviteUser() {
  document.getElementById('inv-email').value = '';
  document.getElementById('inv-nome').value  = '';
  document.getElementById('inv-role').value  = 'leitor';
  document.getElementById('inv-result').style.display = 'none';
  document.getElementById('invite-modal').style.display = 'flex';
}

async function doInviteUser() {
  const email = document.getElementById('inv-email').value.trim();
  const nome  = document.getElementById('inv-nome').value.trim();
  const role  = document.getElementById('inv-role').value;
  if (!email) { showToast('Informe o e-mail.','err'); return; }
  showLoading('Criando usuário...');
  try {
    const res = await DB.inviteUser(email, role, nome);
    hideLoading();
    // Mostra senha temporária
    const r = document.getElementById('inv-result');
    r.style.display = 'block';
    r.innerHTML = `<div style="background:var(--success-bg);color:var(--success-txt);padding:1rem;border-radius:8px;font-size:13px">
      ✅ Usuário criado!<br>
      <strong>E-mail:</strong> ${esc(email)}<br>
      <strong>Senha temporária:</strong> <code style="background:rgba(0,0,0,.15);padding:2px 6px;border-radius:4px">${res.tempPass}</code><br>
      <small>Passe essas credenciais ao usuário para o primeiro acesso.</small>
    </div>`;
    renderUsuarios();
  } catch(e) {
    hideLoading();
    showToast('Erro ao criar: ' + e.message, 'err');
  }
}

// ─── EXPORTAR EXCEL ──────────────────────────────────────────
function openExportModal()   { document.getElementById('exp-modal').style.display='flex'; }
function closeExportModal(e) { if (e.target.id==='exp-modal') document.getElementById('exp-modal').style.display='none'; }
function buildRow(it) {
  const last = (it.historico||[]).slice(-1)[0] || {};
  return { 'Nº Patrimônio':it.patrimonio||'','Nome':it.nome||'','N° Série':it.serie||'',
    'Categoria':(it.categoria||[]).map(id=>getCat(id).name).join(', '),
    'Status':(it.status||[]).map(id=>getStat(id).name).join(', '),
    'Quem Recebeu/Retirou':last.quem_recebeu_retirou||'',
    'Usuário Atual':it.usuario_atual||'','Local Atual':it.local_atual||'',
    'Qtd. Movimentações':(it.historico||[]).length };
}
function buildHistRow(it,hv) {
  return { 'Nº Patrimônio':it.patrimonio||'','Nome':it.nome||'','N° Série':it.serie||'',
    'Data/Hora':hv.timestamp?new Date(hv.timestamp).toLocaleString('pt-BR'):'',
    'Tipo':hv.tipo||'','Data Movimentação':fmtDate(hv.data_mov),
    'Entrada/Saída':hv.quem_recebeu_retirou||'','Usuário Atual':hv.usuario_atual||'',
    'Local':hv.local||'','Observações':hv.obs_mov||'' };
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

// ─── INIT ────────────────────────────────────────────────────
// Aguarda DOM completo antes de qualquer acesso a elementos
window.addEventListener('DOMContentLoaded', () => {
  try {
    appInit();
  } catch(e) {
    document.body.innerHTML = `<div style="padding:2rem;font-family:sans-serif;color:#dc2626">
      <h2>Erro ao iniciar</h2><pre style="background:#fee2e2;padding:1rem;border-radius:8px;font-size:13px">${e.message}\n${e.stack||''}</pre>
    </div>`;
  }
});