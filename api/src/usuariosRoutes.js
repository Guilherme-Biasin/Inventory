// Gerenciamento de usuarios — todas as rotas exigem papel 'admin'.

const { conexao, tipos } = require('./db');
const auth = require('./auth');
const { auditar } = require('./auditoria');
const { invalidarCacheAtivos } = require('./authRoutes');

const PAPEIS = ['admin', 'editor', 'leitor'];

// Tamanho minimo da senha. Vale para criacao e para redefinicao, e e o mesmo
// numero que a tela cobra (SENHA_MIN em frontend/js/app.js) — se um dia mudar,
// mude nos dois. Nao ha exigencia de maiuscula, numero ou simbolo: e um
// sistema interno, e regra complicada demais empurra a senha para o post-it.
const SENHA_MIN = 4;

// O login vira parte de URL, etiqueta e auditoria. Restringir o formato evita
// espaco no meio, acentos que o teclado do celular troca e maiuscula/minuscula
// virando dois usuarios diferentes.
function normalizarLogin(v){
  const s = String(v || '').trim().toLowerCase();
  if(!/^[a-z0-9._-]{3,50}$/.test(s)){
    throw new Error('login invalido — use de 3 a 50 caracteres entre letras, numeros, ponto, hifen e underline');
  }
  return s;
}

function validarPapel(v){
  const s = String(v || '').trim();
  if(!PAPEIS.includes(s)) throw new Error("papel invalido — use 'admin', 'editor' ou 'leitor'");
  return s;
}

// GET /api/v1/usuarios
async function listar(){
  const p = await conexao();
  const r = await p.request().query(`
    SELECT usuario_id AS id, login, nome, papel, ativo, criado_em
    FROM app.usuario ORDER BY criado_em, usuario_id`);
  // ativo vem como 0/1 do SQL Server; a tela testa com if(u.ativo), entao
  // converter aqui evita que "0" (que e verdadeiro como string) engane a tela.
  return r.recordset.map(u => ({ ...u, ativo: !!u.ativo }));
}

// POST /api/v1/usuarios  { login, nome, papel, senha }
// A senha vem do formulario de cadastro. Antes a API sorteava uma provisoria e
// o admin tinha que criar o usuario e so depois trocar a senha — dois passos
// para uma coisa so.
async function criar(q, body, usuario){
  const login = normalizarLogin(body && body.login);
  const papel = validarPapel(body && body.papel);
  const nome  = String((body && body.nome) || '').trim().slice(0, 100) || null;

  const senha = String((body && body.senha) || '');
  if(senha.length < SENHA_MIN) throw new Error(`a senha precisa ter ao menos ${SENHA_MIN} caracteres`);

  const p = await conexao(); const sql = tipos();
  try {
    const r = await p.request()
      .input('login', sql.VarChar(50),  login)
      .input('hash',  sql.VarChar(255), auth.hashSenha(senha))
      .input('nome',  sql.VarChar(100), nome)
      .input('papel', sql.VarChar(10),  papel)
      .query(`INSERT INTO app.usuario (login, senha_hash, nome, papel, ativo)
              OUTPUT INSERTED.usuario_id AS id
              VALUES (@login, @hash, @nome, @papel, 1)`);
    invalidarCacheAtivos();

    await auditar(usuario, {
      tabela: 'usuario', registroId: r.recordset[0].id, acao: 'INSERT',
      descricao: `Criou o usuario "${login}" com papel ${papel}`,
      depois: { login, nome, papel }
    });
    return { id: r.recordset[0].id, login };
  } catch(e){
    if(e && (e.number === 2601 || e.number === 2627)) throw new Error(`o login "${login}" ja existe`);
    throw e;
  }
}

// Le o usuario alvo e recusa a operacao se ela deixaria o sistema sem admin.
// Sem esta trava, o unico administrador conseguia se rebaixar ou se desativar e
// ninguem mais entrava na aba Usuarios para desfazer — so mexendo no banco.
async function alvoValidado(p, sql, id, usuarioLogado){
  const r = await p.request().input('id', sql.Int, id)
    .query('SELECT usuario_id AS id, login, nome, papel, ativo FROM app.usuario WHERE usuario_id = @id');
  const alvo = r.recordset[0];
  if(!alvo) throw new Error('usuario nao encontrado');
  alvo.ativo = !!alvo.ativo;
  alvo.souEu = String(alvo.login).toLowerCase() === String(usuarioLogado.login).toLowerCase();
  return alvo;
}

async function outrosAdminsAtivos(p, sql, id){
  const r = await p.request().input('id', sql.Int, id)
    .query("SELECT COUNT(*) AS n FROM app.usuario WHERE papel = 'admin' AND ativo = 1 AND usuario_id <> @id");
  return r.recordset[0].n;
}

// POST /api/v1/usuarios/atualizar  { id, nome, papel }
async function atualizar(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id de usuario invalido');
  const papel = validarPapel(body && body.papel);
  const nome  = String((body && body.nome) || '').trim().slice(0, 100) || null;

  const p = await conexao(); const sql = tipos();
  const alvo = await alvoValidado(p, sql, id, usuario);

  if(alvo.papel === 'admin' && papel !== 'admin' && !(await outrosAdminsAtivos(p, sql, id))){
    throw new Error('este e o unico administrador ativo — promova outro antes de mudar o papel dele');
  }

  await p.request()
    .input('id',    sql.Int,         id)
    .input('nome',  sql.VarChar(100), nome)
    .input('papel', sql.VarChar(10),  papel)
    .query('UPDATE app.usuario SET nome = @nome, papel = @papel WHERE usuario_id = @id');

  await auditar(usuario, {
    tabela: 'usuario', registroId: id, acao: 'UPDATE',
    descricao: `Alterou o usuario "${alvo.login}": papel ${alvo.papel} -> ${papel}`,
    antes: { nome: alvo.nome, papel: alvo.papel },
    depois: { nome, papel }
  });
  return { ok: true };
}

// POST /api/v1/usuarios/ativo  { id, ativo }
async function ativar(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id de usuario invalido');
  const ativo = !!(body && body.ativo);

  const p = await conexao(); const sql = tipos();
  const alvo = await alvoValidado(p, sql, id, usuario);

  if(!ativo && alvo.souEu) throw new Error('voce nao pode desativar a propria conta');
  if(!ativo && alvo.papel === 'admin' && !(await outrosAdminsAtivos(p, sql, id))){
    throw new Error('este e o unico administrador ativo — promova outro antes de desativa-lo');
  }

  await p.request()
    .input('id',    sql.Int, id)
    .input('ativo', sql.Bit, ativo)
    .query('UPDATE app.usuario SET ativo = @ativo WHERE usuario_id = @id');
  invalidarCacheAtivos();

  await auditar(usuario, {
    tabela: 'usuario', registroId: id, acao: 'UPDATE',
    descricao: `${ativo ? 'Ativou' : 'Desativou'} o usuario "${alvo.login}"`,
    antes: { ativo: alvo.ativo }, depois: { ativo }
  });
  return { ok: true };
}

// POST /api/v1/usuarios/senha  { id, nova }  — admin redefine a senha de outro
async function redefinirSenha(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id de usuario invalido');
  const nova = String((body && body.nova) || '');
  if(nova.length < SENHA_MIN) throw new Error(`a senha precisa ter ao menos ${SENHA_MIN} caracteres`);

  const p = await conexao(); const sql = tipos();
  const alvo = await alvoValidado(p, sql, id, usuario);

  await p.request()
    .input('id',   sql.Int, id)
    .input('hash', sql.VarChar(255), auth.hashSenha(nova))
    .query('UPDATE app.usuario SET senha_hash = @hash WHERE usuario_id = @id');

  // A senha em si NAO entra na auditoria — nem em dados_depois.
  await auditar(usuario, {
    tabela: 'usuario', registroId: id, acao: 'UPDATE',
    descricao: `Redefiniu a senha do usuario "${alvo.login}"`
  });
  return { ok: true };
}

// soAdmin: true => o servidor recusa mesmo que a tela mostre o botao
const usuariosRoutes = [
  { method: 'GET',  path: '/api/v1/usuarios',            handler: listar,          soAdmin: true },
  { method: 'POST', path: '/api/v1/usuarios',            handler: criar,           soAdmin: true },
  { method: 'POST', path: '/api/v1/usuarios/atualizar',  handler: atualizar,       soAdmin: true },
  { method: 'POST', path: '/api/v1/usuarios/ativo',      handler: ativar,          soAdmin: true },
  { method: 'POST', path: '/api/v1/usuarios/senha',      handler: redefinirSenha,  soAdmin: true }
];

module.exports = { usuariosRoutes };
