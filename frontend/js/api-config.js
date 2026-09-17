// ═══════════════════════════════════════════════════════════════
//  api-config.js — conexao com a API do Inventory Guemat
//
//  Substitui o antigo supabase-config.js. A tela (app.js) continua
//  chamando os mesmos objetos Auth e DB; o que mudou foi o que
//  existe atras deles: agora e a API em Node falando com o SQL
//  Server ESTOQUE_TI, no servidor da empresa.
// ═══════════════════════════════════════════════════════════════

// O endereco da API vem de js/config.js, carregado ANTES deste arquivo: vazio
// quando o proprio Node serve a tela, ou o endereco publico quando ela vem da
// Vercel. Ver o porque naquele arquivo.

const CHAVE_TOKEN = 'ig_token';

// ═══════════════════════════════════════════════════════════════
//  Transporte
// ═══════════════════════════════════════════════════════════════

function _cabecalhos(extra){
  const h = extra || {};
  const t = localStorage.getItem(CHAVE_TOKEN);
  if(t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

// Um 401 significa token expirado (12h) ou usuario desativado. Em vez de
// deixar a tela mostrando dados velhos com todo botao dando erro, derruba a
// sessao e volta para o login.
function _sessaoCaiu(){
  localStorage.removeItem(CHAVE_TOKEN);
  Auth._usuario = null;
  Auth._avisar(null);
}

async function _resposta(resp, caminho){
  if(resp.status === 401){ _sessaoCaiu(); throw new Error('sessao expirada — entre novamente'); }
  if(!resp.ok){
    // O motivo vem no corpo ({erro:"..."}). Sem le-lo, a tela dizia so
    // "API 400" e o usuario nao sabia se faltou preencher um campo ou se o
    // banco estava fora do ar.
    let msg = 'API ' + resp.status;
    try { const j = await resp.json(); if(j && j.erro) msg = j.erro; } catch(e){}
    throw new Error(msg + (caminho ? ' (' + caminho + ')' : ''));
  }
  return resp.json();
}

async function _get(caminho){
  let resp;
  try { resp = await fetch(API_URL + '/api/v1' + caminho, { headers: _cabecalhos() }); }
  catch(e){ throw new Error('sem conexao com o servidor do estoque'); }
  return _resposta(resp, caminho);
}

async function _post(caminho, corpo){
  let resp;
  try {
    resp = await fetch(API_URL + '/api/v1' + caminho, {
      method: 'POST',
      headers: _cabecalhos({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(corpo || {})
    });
  } catch(e){ throw new Error('sem conexao com o servidor do estoque'); }
  return _resposta(resp, caminho);
}

// ═══════════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════════
const Auth = {
  _usuario: null,
  _ouvintes: [],

  _avisar(u){ this._ouvintes.forEach(fn => { try { fn(u); } catch(e){ console.error(e); } }); },

  // Login com usuario curto + senha (nao e mais e-mail).
  async login(login, senha){
    const r = await _post('/login', { login, senha });
    localStorage.setItem(CHAVE_TOKEN, r.token);
    this._usuario = r.usuario;
    this._avisar(r.usuario);
    return r.usuario;
  },

  async logout(){
    localStorage.removeItem(CHAVE_TOKEN);
    this._usuario = null;
    this._avisar(null);
  },

  // Usuario logado (do cache; ja veio do login ou da conferencia inicial).
  getUser(){ return this._usuario; },

  // Registra o observador E dispara a conferencia inicial: se ha token
  // guardado, pergunta ao servidor se ele ainda vale antes de mostrar a tela.
  onAuthChange(callback){
    this._ouvintes.push(callback);
    (async () => {
      const t = localStorage.getItem(CHAVE_TOKEN);
      if(!t) return callback(null);
      try {
        this._usuario = await _get('/eu');
        callback(this._usuario);
      } catch(e){
        // Em caso de 401 o proprio _get ja derrubou a sessao e avisou os
        // ouvintes; chamar de novo aqui mandaria o mesmo aviso duas vezes.
        // O teste abaixo cobre o outro caso: falha de rede, em que o token
        // continua guardado e ninguem foi avisado.
        if(localStorage.getItem(CHAVE_TOKEN)){
          localStorage.removeItem(CHAVE_TOKEN);
          callback(null);
        }
      }
    })();
  },

  // Troca a propria senha. A senha ATUAL vai junto e e conferida no servidor.
  async changePassword(atual, nova){
    await _post('/senha', { atual, nova });
  }
};

// ═══════════════════════════════════════════════════════════════
//  DB
// ═══════════════════════════════════════════════════════════════
const DB = {

  // ── CONFIG ───────────────────────────────────────────────────
  loadConfig(){ return _get('/config'); },

  saveConfig(cfg){ return _post('/config', cfg); },

  // ── PATRIMONIOS ──────────────────────────────────────────────
  loadItems(){ return _get('/patrimonios'); },

  async createItem(item, mov){
    const r = await _post('/patrimonios', { item, mov });
    return r.id;
  },

  updateItem(id, item){ return _post('/patrimonios/atualizar', { id, item }); },

  registrarMovimentacao(patrimonioId, mov){
    return _post('/movimentacoes', { patrimonioId, mov });
  },

  deleteItem(id){ return _post('/patrimonios/excluir', { id }); },

  // Manda a planilha inteira em UMA chamada. Tudo ou nada: com qualquer erro
  // nada e gravado, e a API devolve
  //   { gravado:false, erros:[{linha, campo, motivo, correcao}] }.
  // simular=true so confere (nunca grava) — usado para a previa.
  bulkCreateItems(rows, simular){ return _post('/patrimonios/importar', { rows, simular: !!simular }); },

  // ── ALMOXARIFADO ─────────────────────────────────────────────
  // Material de consumo. Cada item traz saldo, lotes (cada entrada com a sua
  // validade e quanto resta dela) e o historico completo — a tela nao precisa
  // recalcular nada.
  loadAlmox(){ return _get('/almoxarifado'); },

  async createAlmox(item, mov){
    const r = await _post('/almoxarifado', { item, mov });
    return r.id;
  },

  updateAlmox(id, item){ return _post('/almoxarifado/atualizar', { id, item }); },

  // mov.tipo = 'entrada' | 'saida'. Na saida vai tambem mov.loteId: quem
  // registra escolhe de qual lote sai o material.
  movimentarAlmox(almoxId, mov){ return _post('/almoxarifado/movimentacoes', { almoxId, mov }); },

  deleteAlmox(id){ return _post('/almoxarifado/excluir', { id }); },

  // Mesmas regras da importacao de patrimonio: tudo ou nada, e simular=true
  // so confere.
  bulkCreateAlmox(rows, simular){ return _post('/almoxarifado/importar', { rows, simular: !!simular }); },

  // ── ATUALIZACAO AUTOMATICA ───────────────────────────────────
  // O SQL Server nao tem o "realtime" do Supabase. Em vez de abrir um canal, a
  // tela pergunta a cada INTERVALO se alguma coisa mudou: a rota /carimbo
  // devolve um resumo curto (contagens + ultima alteracao) e a lista completa
  // so e baixada quando esse resumo muda.
  //
  // Enquanto a aba esta em segundo plano nao pergunta nada — dez telas abertas
  // a noite inteira nao vao bater no banco a cada 20 segundos a toa.
  _poll: null,

  subscribeItems(callback, intervaloMs){
    // Encerra um observador anterior. loadAll() roda a cada login, e sem isto
    // cada entrada deixava mais um temporizador ativo consultando em paralelo.
    this.unsubscribeItems();

    const intervalo = intervaloMs || 20000;
    let ultimo = null;
    let ocupado = false;

    const conferir = async () => {
      if(ocupado || document.hidden) return;
      ocupado = true;
      try {
        const r = await _get('/carimbo');
        if(ultimo !== null && r.carimbo !== ultimo) callback();
        ultimo = r.carimbo;
      } catch(e){
        // Falha de rede aqui e silenciosa de proposito: e uma conferencia de
        // fundo, e um toast de erro a cada 20s durante uma queda de rede
        // atrapalharia mais do que ajudaria.
      } finally { ocupado = false; }
    };

    conferir();                                  // marca o ponto de partida
    this._poll = setInterval(conferir, intervalo);
    // Ao voltar para a aba, confere na hora em vez de esperar o proximo ciclo.
    this._onVisivel = () => { if(!document.hidden) conferir(); };
    document.addEventListener('visibilitychange', this._onVisivel);
    return { stop: () => this.unsubscribeItems() };
  },

  unsubscribeItems(){
    if(this._poll){ clearInterval(this._poll); this._poll = null; }
    if(this._onVisivel){ document.removeEventListener('visibilitychange', this._onVisivel); this._onVisivel = null; }
  },

  // ── AUDITORIA ────────────────────────────────────────────────
  loadAuditoria(limite = 200){ return _get('/auditoria?limite=' + encodeURIComponent(limite)); },

  // ── USUARIOS ─────────────────────────────────────────────────
  getMyProfile(){ return _get('/eu'); },

  loadUsers(){ return _get('/usuarios'); },

  // Nome e papel vao juntos em uma chamada so: separados, o papel podia ser
  // gravado e o nome falhar, deixando a tela mostrando um estado que nao
  // existe no banco.
  updateUser(id, nome, papel){ return _post('/usuarios/atualizar', { id, nome, papel }); },

  toggleUserAtivo(id, ativo){ return _post('/usuarios/ativo', { id, ativo }); },

  // Apaga a linha do usuario. O historico sobrevive: auditoria e criado_por
  // guardam o login como texto, nao como ligacao para a tabela de usuarios.
  excluirUsuario(id){ return _post('/usuarios/excluir', { id }); },

  // A senha e definida por quem cadastra, no proprio formulario. Ela viaja
  // uma vez e o servidor guarda so o hash — nunca o texto.
  criarUsuario(login, papel, nome, senha){ return _post('/usuarios', { login, papel, nome, senha }); },

  adminResetPassword(id, nova){ return _post('/usuarios/senha', { id, nova }); }
};
