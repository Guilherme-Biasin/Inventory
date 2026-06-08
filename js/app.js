
// ─── DEFAULTS ────────────────────────────────────────────────
const DEFAULTS = {
  cats: [
    {id:'c1',name:'Informática',color:'#2563eb'},
    {id:'c2',name:'Mobiliário',color:'#059669'},
    {id:'c3',name:'Eletrônicos',color:'#d97706'},
    {id:'c4',name:'Veículos',color:'#7c3aed'}
  ],
  pessoas: ['João Silva','Maria Oliveira','Carlos Santos','Ana Lima'],
  locais: ['Sala 101','Almoxarifado','TI','Recepção','Diretoria'],
  statusOpts: [
    {id:'s1',name:'Em uso',color:'#059669'},
    {id:'s2',name:'Disponível',color:'#2563eb'},
    {id:'s3',name:'Em manutenção',color:'#d97706'},
    {id:'s4',name:'Descartado',color:'#dc2626'}
  ]
};

// ─── ESTADO ──────────────────────────────────────────────────
let S = {};
const STORAGE_KEY = 'patricontrol_v4';

function getDefault() {
  return {
    items: [],
    cats: JSON.parse(JSON.stringify(DEFAULTS.cats)),
    pessoas: [...DEFAULTS.pessoas],
    locais: [...DEFAULTS.locais],
    statusOpts: JSON.parse(JSON.stringify(DEFAULTS.statusOpts)),
    nextId: 1,
    editId: null,
    dark: false,
    lastFiltered: []
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      items: S.items,
      cats: S.cats,
      pessoas: S.pessoas,
      locais: S.locais,
      statusOpts: S.statusOpts,
      nextId: S.nextId,
      dark: S.dark
    }));
  } catch(e) { console.error('Erro ao salvar:', e); }
}

function hydrate() {
  S = getDefault();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.items))       S.items       = saved.items;
      if (Array.isArray(saved.cats))        S.cats        = saved.cats;
      if (Array.isArray(saved.pessoas))     S.pessoas     = saved.pessoas;
      if (Array.isArray(saved.locais))      S.locais      = saved.locais;
      if (Array.isArray(saved.statusOpts))  S.statusOpts  = saved.statusOpts;
      if (typeof saved.nextId === 'number') S.nextId      = saved.nextId;
      if (typeof saved.dark   === 'boolean') S.dark       = saved.dark;
    }
  } catch(e) { console.error('Erro ao carregar:', e); S = getDefault(); }
  S.items.forEach(it => { if (!Array.isArray(it.historico)) it.historico = []; });
  S.lastFiltered = [...S.items];
}

hydrate();

// Dados de exemplo se vazio
if (!S.items.length) {
  S.items = [
    {id:0,patrimonio:'001',serie:'SN-001-ABC',nome:'Notebook Dell',categoria:['c1'],status:['s1'],local_atual:'TI',historico:[
      {timestamp:new Date('2024-01-10').toISOString(),tipo:'entrada',data_mov:'2024-01-10',quem_recebeu_retirou:'João Silva',local:'TI',obs_mov:'Entrada inicial'}
    ]},
    {id:1,patrimonio:'002',serie:'SN-002-XYZ',nome:'Cadeira Escritório',categoria:['c2'],status:['s1'],local_atual:'Sala 101',historico:[
      {timestamp:new Date('2024-02-05').toISOString(),tipo:'entrada',data_mov:'2024-02-05',quem_recebeu_retirou:'Maria Oliveira',local:'Sala 101',obs_mov:''}
    ]},
    {id:2,patrimonio:'003',serie:'SN-003-QWE',nome:'Monitor 24"',categoria:['c1'],status:['s3'],local_atual:'Almoxarifado',historico:[
      {timestamp:new Date('2024-03-01').toISOString(),tipo:'entrada',data_mov:'2024-03-01',quem_recebeu_retirou:'Carlos Santos',local:'TI',obs_mov:'Entrada'},
      {timestamp:new Date('2024-06-15').toISOString(),tipo:'movimentacao',data_mov:'2024-06-15',quem_recebeu_retirou:'Carlos Santos',local:'Almoxarifado',obs_mov:'Enviado para manutenção'}
    ]}
  ];
  S.nextId = 4;
  persist();
}

if (S.dark) document.documentElement.classList.add('dark');

// ─── MODO ESCURO ─────────────────────────────────────────────
function toggleDark() {
  S.dark = !S.dark;
  document.documentElement.classList.toggle('dark', S.dark);
  persist();
}

// ─── NAVEGAÇÃO ───────────────────────────────────────────────
function nav(p) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  const titles = {dashboard:'Dashboard',lista:'Patrimônios',cadastro:'Cadastro',config:'Personalizar'};
  document.getElementById('topbar-title').textContent = titles[p] || '';
  const navIdx = {dashboard:0,lista:1,cadastro:2,config:5};
  document.querySelectorAll('.nav-item')[navIdx[p]]?.classList.add('active');
  if (p === 'dashboard') renderDash();
  if (p === 'lista')     { populateFilters(); renderLista(); }
  if (p === 'cadastro')  renderForm();
  if (p === 'config')    renderConfig();
}

// ─── HELPERS ─────────────────────────────────────────────────
function getCat(id)  { return S.cats.find(c => c.id === id) || {name:id, color:'#888'}; }
function getStat(id) { return S.statusOpts.find(s => s.id === id) || {name:id, color:'#888'}; }
function fmtDate(d)  { if (!d) return '—'; try { return new Date(d+'T12:00').toLocaleDateString('pt-BR'); } catch(e) { return d; } }
function fmtDT(ts)   { if (!ts) return '—'; try { return new Date(ts).toLocaleString('pt-BR'); } catch(e) { return ts; } }
function catPills(arr)  { return (arr||[]).map(id => { const c=getCat(id);  return `<span class="cat-pill" style="background:${c.color}22;color:${c.color}">${c.name}</span>`; }).join('')||'—'; }
function statPills(arr) { return (arr||[]).map(id => { const s=getStat(id); return `<span class="cat-pill" style="background:${s.color}22;color:${s.color}">${s.name}</span>`; }).join('')||'—'; }

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
  fc.innerHTML  = '<option value="">Todas as categorias</option>' + S.cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  fs.innerHTML  = '<option value="">Todos os status</option>'     + S.statusOpts.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
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
        <td><div class="actions-cell">
          <button class="btn btn-sm" onclick="editItem(${it.id})" title="Editar dados fixos"><i class="ti ti-edit"></i></button>
          <button class="btn btn-sm btn-warn" onclick="novaMovimentacao(${it.id})" title="Registrar movimentação"><i class="ti ti-transfer"></i></button>
          <button class="btn btn-sm" style="border-color:var(--danger-txt);color:var(--danger-txt)" onclick="delItem(${it.id})" title="Excluir"><i class="ti ti-trash"></i></button>
        </div></td>
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

  let h = '<form onsubmit="saveItem(event)">';

  // ── BLOCO 1: Dados fixos (não aparece no modo movimentação)
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
          ${buildMs('f_categoria', S.cats.map(x=>({val:x.id,lbl:x.name})), Array.isArray(it.categoria)?it.categoria:[])}</div>

        <div class="fg"><label class="flabel">N° de Série<span class="req">*</span></label>
          <input class="finput" id="f_serie" value="${esc(it.serie||'')}" required placeholder="Ex: SN-0001-XYZ"></div>

        <div class="fg"><label class="flabel">Status<span class="req">*</span></label>
          ${buildMs('f_status', S.statusOpts.map(x=>({val:x.id,lbl:x.name})), Array.isArray(it.status)?it.status:[])}</div>

      </div>
    </div>`;
  }

  // ── BLOCO 2: Dados da movimentação (destaque amarelo)
  if (movMode) {
    const it2 = S.items.find(x => x.id === S.editId) || {};
    h += `<div class="scard" style="background:var(--accent-bg);border-color:var(--accent)">
      <div style="font-size:13px;margin-bottom:.75rem;color:var(--accent-txt);font-weight:600">
        <i class="ti ti-info-circle"></i> Movimentando: <strong>${esc(it2.patrimonio||'')} — ${esc(it2.nome||'')}</strong>
        &nbsp;${statPills(it2.status)}
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
        <select class="finput" id="f_quem_recebeu_retirou">
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
        <textarea class="finput" id="f_obs_mov" rows="3" style="resize:vertical" placeholder="Descreva esta movimentação..."></textarea></div>

    </div>
  </div>`;

  // ── BLOCO 3: Histórico
  if (isEdit || movMode) {
    const itH = S.items.find(x => x.id === S.editId) || {};
    const hist = itH.historico || [];
    h += `<div class="hist-card">
      <div class="hist-card-title"><i class="ti ti-history" style="color:var(--accent)"></i> Histórico de Movimentações
        <span class="badge b-gray" style="margin-left:6px">${hist.length}</span>
      </div>`;
    if (hist.length) {
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
    } else {
      h += '<div style="color:var(--txt3);font-size:13px;padding:.5rem 0">Nenhuma movimentação registrada ainda.</div>';
    }
    h += '</div>';
  }

  h += `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.5rem">
    <button type="button" class="btn btn-ghost" onclick="cancelEdit()">Cancelar</button>
    <button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy"></i> ${movMode?'Registrar Movimentação':(isEdit?'Salvar Alterações':'Cadastrar')}</button>
  </div></form>`;

  document.getElementById('form-wrap').innerHTML = h;
  Object.keys(msState).forEach(k => initMsDismiss(k));
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function novaMovimentacao(id) { S.editId = id; movMode = true; nav('cadastro'); }

function buildMs(id, opts, sel) {
  msState[id] = { opts, sel: [...sel] };
  return `<div style="position:relative" id="mswrap_${id}">
    <div class="ms-wrap" id="mstop_${id}" onclick="toggleMs('${id}')">
      <span id="mschips_${id}">${renderChips(id, opts, sel)}</span>
      <span class="ms-placeholder">Selecionar...</span>
    </div>
    <div class="ms-dropdown" id="msdrop_${id}">
      ${opts.map((o,i) => `<div class="ms-opt${sel.includes(o.val)?' sel':''}" id="msopt_${id}_${i}" onclick="toggleOpt('${id}','${o.val}')"><input type="checkbox" ${sel.includes(o.val)?'checked':''} onclick="event.stopPropagation()"> ${esc(o.lbl)}</div>`).join('')}
    </div>
  </div>`;
}
function renderChips(id, opts, sel) {
  return sel.map(v => { const o = opts.find(x => x.val===v); return o?`<span class="chip">${esc(o.lbl)}<span class="chip-x" onclick="rmChip(event,'${id}','${v}')">×</span></span>`:''; }).join('');
}
function toggleMs(id)  { const d = document.getElementById('msdrop_'+id); if(d) d.classList.toggle('open'); }
function initMsDismiss(id) {
  document.addEventListener('click', function(e) {
    const w = document.getElementById('mswrap_'+id);
    const d = document.getElementById('msdrop_'+id);
    if (w && !w.contains(e.target) && d) d.classList.remove('open');
  });
}
function toggleOpt(id, val) {
  const ms = msState[id]; if (!ms) return;
  const idx = ms.sel.indexOf(val);
  if (idx > -1) ms.sel.splice(idx,1); else ms.sel.push(val);
  refreshMs(id);
}
function rmChip(e, id, val) {
  e.stopPropagation();
  const ms = msState[id]; if (!ms) return;
  ms.sel = ms.sel.filter(v => v!==val);
  refreshMs(id);
}
function refreshMs(id) {
  const ms = msState[id];
  document.getElementById('mschips_'+id).innerHTML = renderChips(id, ms.opts, ms.sel);
  ms.opts.forEach((o,i) => {
    const el = document.getElementById(`msopt_${id}_${i}`); if (!el) return;
    const s = ms.sel.includes(o.val);
    el.classList.toggle('sel', s);
    const cb = el.querySelector('input'); if (cb) cb.checked = s;
  });
}

function saveItem(e) {
  e.preventDefault();

  const data_mov           = (document.getElementById('f_data_mov')||{}).value || '';
  const entrada_saida      = (document.getElementById('f_quem_recebeu_retirou')||{}).value || '';
  const local_atual        = (document.getElementById('f_local_atual')||{}).value || '';
  const usuario_atual      = (document.getElementById('f_usuario_atual')||{}).value || '';
  const obs_mov            = (document.getElementById('f_obs_mov')||{}).value || '';

  const reg = {
    timestamp: new Date().toISOString(),
    tipo: (S.editId == null) ? 'entrada' : 'movimentacao',
    data_mov,
    quem_recebeu_retirou: entrada_saida,
    usuario_atual,
    local: local_atual,
    obs_mov
  };

  if (movMode) {
    // Só registra a movimentação, atualiza local atual
    const it = S.items.find(x => x.id === S.editId); if (!it) return;
    if (!Array.isArray(it.historico)) it.historico = [];
    it.historico.push(reg);
    if (local_atual)   it.local_atual   = local_atual;
    if (usuario_atual) it.usuario_atual = usuario_atual;
    persist();
    movMode = false; S.editId = null;
    showAlert('ok', 'Movimentação registrada com sucesso!');
    setTimeout(() => nav('lista'), 800);
    return;
  }

  // Cadastro / edição de dados fixos
  const patrimonio = document.getElementById('f_patrimonio').value.trim();
  const nome       = document.getElementById('f_nome').value.trim();
  const serie      = document.getElementById('f_serie').value.trim();
  const categoria  = (msState['f_categoria']?.sel) || [];
  const status     = (msState['f_status']?.sel)    || [];

  if (!patrimonio || !nome || !serie) return;
  if (!categoria.length) { alert('Selecione ao menos uma categoria.'); return; }
  if (!status.length)    { alert('Selecione ao menos um status.'); return; }

  if (S.editId != null) {
    const idx = S.items.findIndex(x => x.id === S.editId);
    if (idx > -1) {
      const existing = S.items[idx];
      if (!Array.isArray(existing.historico)) existing.historico = [];
      // Registra movimentação junto com edição se preencheu campos de movimentação
      if (data_mov || quem_recebeu_ret || obs_mov || local_atual) existing.historico.push(reg);
      S.items[idx] = { ...existing, patrimonio, nome, serie, categoria, status, local_atual: local_atual || existing.local_atual, usuario_atual: usuario_atual || existing.usuario_atual };
    }
    S.editId = null;
  } else {
    const newItem = { id: S.nextId++, patrimonio, nome, serie, categoria, status, local_atual, usuario_atual, historico: [reg] };
    S.items.push(newItem);
  }

  persist();
  showAlert('ok', 'Patrimônio salvo com sucesso!');
  setTimeout(() => nav('lista'), 800);
}

function showAlert(type, msg) {
  const al = document.getElementById('form-alert');
  al.className = 'alert alert-' + type;
  al.innerHTML = `<i class="ti ti-check"></i> ${msg}`;
  al.style.display = 'flex';
  setTimeout(() => { al.style.display='none'; }, 3000);
}

function editItem(id)  { S.editId = id; movMode = false; nav('cadastro'); }
function delItem(id)   { if (!confirm('Excluir este patrimônio?')) return; S.items = S.items.filter(x => x.id!==id); persist(); renderLista(); }
function cancelEdit()  { S.editId = null; movMode = false; nav('lista'); }

// ─── CONFIG ──────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.stab-panel').forEach(p => p.style.display='none');
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).style.display='block';
  const map = {tc:0,tp:1,tl:2,ts:3};
  document.querySelectorAll('.stab')[map[id]]?.classList.add('active');
  renderConfig();
}
function renderConfig() { renderCats(); renderPessoas(); renderLocais(); renderStatOpts(); }

function renderCats() {
  const el = document.getElementById('cat-cloud'); if (!el) return;
  el.innerHTML = S.cats.map(c => `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${c.color};display:inline-block;margin-right:3px"></span>${esc(c.name)}<span class="tdel" onclick="delCat('${c.id}')">×</span></div>`).join('');
}
function addCat() {
  const n = document.getElementById('ncat').value.trim();
  const col = document.getElementById('ncat-color').value;
  if (!n) return;
  S.cats.push({id:'c'+Date.now(),name:n,color:col});
  persist(); renderCats(); document.getElementById('ncat').value='';
}
function delCat(id) { S.cats = S.cats.filter(c => c.id!==id); persist(); renderCats(); }

function renderPessoas() {
  const el = document.getElementById('pess-cloud'); if (!el) return;
  el.innerHTML = S.pessoas.map(p => `<div class="tag">${esc(p)}<span class="tdel" onclick="delPessById(${S.pessoas.indexOf(p)})">×</span></div>`).join('');
}
function addPess() {
  const v = document.getElementById('npess').value.trim();
  if (!v || S.pessoas.includes(v)) return;
  S.pessoas.push(v); persist(); renderPessoas(); document.getElementById('npess').value='';
}
function delPessById(idx) { S.pessoas.splice(idx,1); persist(); renderPessoas(); }

function renderLocais() {
  const el = document.getElementById('loc-cloud'); if (!el) return;
  el.innerHTML = S.locais.map((l,i) => `<div class="tag">${esc(l)}<span class="tdel" onclick="delLocalById(${i})">×</span></div>`).join('');
}
function addLoc() {
  const v = document.getElementById('nloc').value.trim();
  if (!v || S.locais.includes(v)) return;
  S.locais.push(v); persist(); renderLocais(); document.getElementById('nloc').value='';
}
function delLocalById(idx) { S.locais.splice(idx,1); persist(); renderLocais(); }

function renderStatOpts() {
  const el = document.getElementById('stat-cloud'); if (!el) return;
  el.innerHTML = S.statusOpts.map(s => `<div class="tag"><span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;margin-right:3px"></span>${esc(s.name)}<span class="tdel" onclick="delStat('${s.id}')">×</span></div>`).join('');
}
function addStat() {
  const n = document.getElementById('nstat').value.trim();
  const col = document.getElementById('nstat-color').value;
  if (!n) return;
  S.statusOpts.push({id:'s'+Date.now(),name:n,color:col});
  persist(); renderStatOpts(); document.getElementById('nstat').value='';
}
function delStat(id) { S.statusOpts = S.statusOpts.filter(s => s.id!==id); persist(); renderStatOpts(); }

// ─── EXPORTAR EXCEL ──────────────────────────────────────────
function openExportModal()   { document.getElementById('exp-modal').style.display='flex'; }
function closeExportModal(e) { if (e.target.id==='exp-modal') document.getElementById('exp-modal').style.display='none'; }

function buildRow(it) {
  const last = (it.historico||[]).slice(-1)[0] || {};
  return {
    'Nº Patrimônio': it.patrimonio||'',
    'Nome':          it.nome||'',
    'N° Série':      it.serie||'',
    'Categoria':     (it.categoria||[]).map(id=>getCat(id).name).join(', '),
    'Status':        (it.status||[]).map(id=>getStat(id).name).join(', '),
    'Quem Recebeu/Retirou': last.quem_recebeu_retirou||'',
    'Usuário Atual':        it.usuario_atual||'',
    'Local Atual':          it.local_atual||'',
    'Qtd. Movimentações': (it.historico||[]).length
  };
}
function buildHistRow(it, hv) {
  return {
    'Nº Patrimônio': it.patrimonio||'',
    'Nome':          it.nome||'',
    'N° Série':      it.serie||'',
    'Data/Hora':     hv.timestamp ? new Date(hv.timestamp).toLocaleString('pt-BR') : '',
    'Tipo':          hv.tipo||'',
    'Data Movimentação': fmtDate(hv.data_mov),
    'Entrada/Saída':        hv.quem_recebeu_retirou||'',
    'Usuário Atual':        hv.usuario_atual||'',
    'Local':                hv.local||'',
    'Observações':   hv.obs_mov||''
  };
}
function styleSheet(ws) {
  const hStyle = {font:{bold:true,color:{rgb:'FFFFFF'},sz:11},fill:{fgColor:{rgb:'1E3A8A'}},alignment:{horizontal:'center',vertical:'center',wrapText:true}};
  const range = XLSX.utils.decode_range(ws['!ref']||'A1');
  for (let C=range.s.c; C<=range.e.c; C++) { const a=XLSX.utils.encode_cell({r:0,c:C}); if(ws[a]) ws[a].s=hStyle; }
  ws['!rows'] = [{hpx:22}];
}
function doExport() {
  const type = document.querySelector('input[name=exptype]:checked').value;
  const wb = XLSX.utils.book_new();
  const cols = [{wch:14},{wch:26},{wch:16},{wch:18},{wch:18},{wch:24},{wch:16},{wch:12}];

  if (type === 'historico') {
    const rows = [];
    S.items.forEach(it => (it.historico||[]).forEach(hv => rows.push(buildHistRow(it,hv))));
    if (!rows.length) { alert('Nenhuma movimentação registrada.'); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{wch:14},{wch:26},{wch:16},{wch:18},{wch:14},{wch:18},{wch:24},{wch:16},{wch:28}];
    styleSheet(ws); XLSX.utils.book_append_sheet(wb, ws, 'Histórico');
  } else if (type === 'categorias') {
    S.cats.forEach(cat => {
      const items = S.items.filter(it => (it.categoria||[]).includes(cat.id));
      if (!items.length) return;
      const ws = XLSX.utils.json_to_sheet(items.map(buildRow));
      ws['!cols'] = cols; styleSheet(ws);
      XLSX.utils.book_append_sheet(wb, ws, cat.name.substring(0,31));
    });
  } else {
    const data = (type==='filtrado' ? S.lastFiltered : S.items).map(buildRow);
    if (!data.length) { alert('Nenhum item para exportar.'); return; }
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = cols; styleSheet(ws);
    XLSX.utils.book_append_sheet(wb, ws, 'Patrimônios');
  }
  const today = new Date().toLocaleDateString('pt-BR').replace(/\//g,'-');
  XLSX.writeFile(wb, `patrimonios_${today}.xlsx`);
  document.getElementById('exp-modal').style.display='none';
}

// ─── INIT ────────────────────────────────────────────────────
renderDash();
