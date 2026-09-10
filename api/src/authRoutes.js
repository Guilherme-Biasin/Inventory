// Login, perfil do usuario logado e troca da propria senha.

const { conexao, tipos } = require('./db');
const auth = require('./auth');

// ---------- Freio contra tentativa de senha em sequencia ----------
// Sem isto da para testar senha indefinidamente. Fica em memoria de proposito:
// reiniciar o servico limpa os bloqueios (nao vira problema operacional) e nao
// gera escrita no banco a cada erro de digitacao.
// A chave inclui o IP para que alguem errando a senha de outra maquina nao
// tranque o acesso de quem esta legitimamente entrando.
const MAX_ERROS   = 5;
const BLOQUEIO_MS = 10 * 60 * 1000;   // 10 minutos
const JANELA_MS   = 15 * 60 * 1000;   // erros mais antigos que isso nao contam
const tentativas  = new Map();

function chave(login, ip){ return String(login).toLowerCase() + '|' + (ip || '?'); }

function bloqueioRestante(login, ip){
  const t = tentativas.get(chave(login, ip));
  if(!t || !t.ate) return 0;
  const falta = t.ate - Date.now();
  return falta > 0 ? falta : 0;
}

function registrarErro(login, ip){
  const k = chave(login, ip);
  const agora = Date.now();
  const t = tentativas.get(k) || { erros: 0, ultimo: 0, ate: 0 };
  if(agora - t.ultimo > JANELA_MS) t.erros = 0;   // esfriou: recomeca a contagem
  t.erros++; t.ultimo = agora;
  if(t.erros >= MAX_ERROS){ t.ate = agora + BLOQUEIO_MS; t.erros = 0; }
  tentativas.set(k, t);
}

function limparTentativas(login, ip){ tentativas.delete(chave(login, ip)); }

// Limpeza periodica para o Map nao crescer sem fim. unref() para nao segurar o
// processo aberto quando nao houver mais nada acontecendo.
setInterval(() => {
  const agora = Date.now();
  tentativas.forEach((t, k) => {
    if((!t.ate || t.ate < agora) && agora - t.ultimo > JANELA_MS) tentativas.delete(k);
  });
}, 30 * 60 * 1000).unref();

// ---------- POST /api/v1/login  { login, senha } ----------
async function login(q, body, _usuario, ctx){
  if(!body || !body.login) throw new Error('informe login e senha');
  const ip = (ctx && ctx.ip) || '?';

  const restante = bloqueioRestante(body.login, ip);
  if(restante > 0){
    const min = Math.ceil(restante / 60000);
    const e = new Error(`muitas tentativas — tente novamente em ${min} min`);
    e.status = 429; throw e;
  }

  const p = await conexao(); const sql = tipos();
  const r = await p.request()
    .input('u', sql.VarChar(50), String(body.login).trim())
    .query('SELECT usuario_id, login, senha_hash, nome, papel, ativo FROM app.usuario WHERE login = @u');
  const u = r.recordset[0];

  // Mesma mensagem para "nao existe", "inativo" e "senha errada": dizer qual
  // dos tres foi entrega a lista de logins validos para quem esta tentando.
  if(!u || !u.ativo || !auth.verificarSenha(body.senha || '', u.senha_hash)){
    registrarErro(body.login, ip);
    const e = new Error('login ou senha invalidos'); e.status = 401; throw e;
  }
  limparTentativas(body.login, ip);

  return {
    token: auth.gerarToken(u.login, u.papel),
    usuario: { id: u.usuario_id, login: u.login, nome: u.nome || u.login, papel: u.papel }
  };
}

// ---------- GET /api/v1/eu ----------
// A tela chama isto ao abrir com um token guardado: confirma que a sessao ainda
// vale e devolve o papel ATUAL (o do token pode ter 12h e estar desatualizado
// se o admin rebaixou o usuario nesse meio tempo).
async function eu(q, body, usuario){
  const p = await conexao(); const sql = tipos();
  const r = await p.request()
    .input('u', sql.VarChar(50), usuario.login)
    .query('SELECT usuario_id, login, nome, papel, ativo FROM app.usuario WHERE login = @u');
  const u = r.recordset[0];
  if(!u || !u.ativo){ const e = new Error('sessao encerrada'); e.status = 401; throw e; }
  return { id: u.usuario_id, login: u.login, nome: u.nome || u.login, papel: u.papel };
}

// ---------- POST /api/v1/senha  { atual, nova } ----------
async function trocarSenha(q, body, usuario){
  const atual = (body && body.atual) || '';
  const nova  = (body && body.nova)  || '';
  if(nova.length < 6) throw new Error('a nova senha precisa ter ao menos 6 caracteres');

  const p = await conexao(); const sql = tipos();
  const r = await p.request()
    .input('u', sql.VarChar(50), usuario.login)
    .query('SELECT senha_hash FROM app.usuario WHERE login = @u');
  const u = r.recordset[0];
  if(!u) throw new Error('usuario nao encontrado');

  // Exigir a senha atual impede que um notebook deixado aberto e destravado
  // vire uma conta sequestrada em dois cliques.
  if(!auth.verificarSenha(atual, u.senha_hash)){
    const e = new Error('senha atual incorreta'); e.status = 401; throw e;
  }

  await p.request()
    .input('u', sql.VarChar(50), usuario.login)
    .input('h', sql.VarChar(255), auth.hashSenha(nova))
    .query('UPDATE app.usuario SET senha_hash = @h WHERE login = @u');
  return { ok: true };
}

// publico: true => nao exige token
const authRoutes = [
  { method: 'POST', path: '/api/v1/login', handler: login, publico: true },
  { method: 'GET',  path: '/api/v1/eu',    handler: eu },
  { method: 'POST', path: '/api/v1/senha', handler: trocarSenha }
];

// ---------- Revogacao de sessao ----------
// O token e assinado e vale 12h, entao desativar um usuario nao derrubaria a
// sessao dele sozinho. A lista de logins ATIVOS fica em cache por 30s:
// desativou na aba Usuarios, o acesso cai em ate meio minuto, sem custo de uma
// consulta ao banco por requisicao.
const CACHE_MS = 30 * 1000;
let _ativos = null, _ativosEm = 0, _buscando = null;

async function loginsAtivos(){
  const agora = Date.now();
  if(_ativos && agora - _ativosEm < CACHE_MS) return _ativos;
  if(_buscando) return _buscando;                 // evita consultas em paralelo
  _buscando = (async () => {
    try {
      const p = await conexao();
      const r = await p.request().query('SELECT login FROM app.usuario WHERE ativo = 1');
      _ativos = new Set(r.recordset.map(x => String(x.login).toLowerCase()));
      _ativosEm = Date.now();
    } catch(e){
      // Banco fora do ar: mantem o cache anterior em vez de expulsar todo mundo.
      console.error('[auth] nao consegui atualizar a lista de ativos:', e.message);
    } finally { _buscando = null; }
    return _ativos;
  })();
  return _buscando;
}

// Chamado quando o admin desativa/cria usuario: a proxima requisicao ja enxerga
// a mudanca, sem esperar os 30s do cache.
function invalidarCacheAtivos(){ _ativos = null; _ativosEm = 0; }

// true = a sessao ainda vale. Se nunca conseguimos carregar a lista, deixa
// passar (o token assinado ja e uma garantia) para nao derrubar o sistema
// inteiro por um problema momentaneo de banco.
async function sessaoValida(usuario){
  if(!usuario || !usuario.login) return false;
  const ativos = await loginsAtivos();
  if(!ativos) return true;
  return ativos.has(String(usuario.login).toLowerCase());
}

module.exports = { authRoutes, sessaoValida, invalidarCacheAtivos };
