// Registro de auditoria — quem fez o que, escrito pela API.
//
// POR QUE NAO E GATILHO NO BANCO (como era no Supabase): todas as conexoes
// chegam ao SQL Server como o mesmo usuario (estoque_rw), entao um gatilho
// gravaria sempre o mesmo autor. Quem sabe o login de verdade e a API, que
// acabou de validar o token — e so ela consegue escrever a descricao em
// portugues ("Excluiu patrimonio 001 — Dell Vostro").

const { conexao, tipos } = require('./db');

// Grava uma linha de auditoria.
//
// NUNCA deixa a excecao subir: auditoria e registro paralelo. Se a tabela
// estiver indisponivel, o cadastro que o usuario acabou de fazer nao pode ser
// desfeito por causa disso — o erro vai para o log do servidor.
async function auditar(usuario, ev){
  try {
    const p = await conexao(); const sql = tipos();
    await p.request()
      .input('tabela',  sql.VarChar(40),   ev.tabela)
      .input('reg',     sql.VarChar(40),   ev.registroId != null ? String(ev.registroId) : null)
      .input('acao',    sql.VarChar(10),   ev.acao)
      .input('desc',    sql.NVarChar(400), ev.descricao || null)
      .input('antes',   sql.NVarChar(sql.MAX), ev.antes  ? JSON.stringify(ev.antes)  : null)
      .input('depois',  sql.NVarChar(sql.MAX), ev.depois ? JSON.stringify(ev.depois) : null)
      .input('usuario', sql.VarChar(50),   (usuario && usuario.login) || null)
      .query(`INSERT INTO app.auditoria (tabela, registro_id, acao, descricao, dados_antes, dados_depois, usuario)
              VALUES (@tabela, @reg, @acao, @desc, @antes, @depois, @usuario)`);
  } catch(e){
    console.error('[auditoria] nao consegui registrar:', e.message);
  }
}

// A tela guarda dados_antes/dados_depois como objeto para mostrar formatado.
// No banco eles sao texto JSON; converter aqui evita que cada tela precise
// lembrar de fazer JSON.parse.
function converterLinha(r){
  const json = v => { try { return v ? JSON.parse(v) : null; } catch(e){ return v; } };
  return {
    id:           r.id,
    tabela:       r.tabela,
    registro_id:  r.registro_id,
    acao:         r.acao,
    descricao:    r.descricao,
    dados_antes:  json(r.dados_antes),
    dados_depois: json(r.dados_depois),
    usuario:      r.usuario,
    criado_em:    r.criado_em
  };
}

// GET /api/v1/auditoria?limite=200[&patrimonio=12]
async function listar(q){
  const limiteBruto = parseInt(q.get('limite'), 10);
  // Limite entre 1 e 1000: sem teto, um "?limite=999999999" puxaria a tabela
  // inteira e derrubaria a memoria do processo.
  const limite = Number.isFinite(limiteBruto) ? Math.min(Math.max(limiteBruto, 1), 1000) : 200;
  const patrimonio = q.get('patrimonio');

  const p = await conexao(); const sql = tipos();
  const req = p.request().input('limite', sql.Int, limite);
  let filtro = '';
  if(patrimonio){
    req.input('reg', sql.VarChar(40), String(patrimonio));
    filtro = `WHERE tabela = 'patrimonio' AND registro_id = @reg`;
  }
  const r = await req.query(`
    SELECT TOP (@limite) id, tabela, registro_id, acao, descricao,
           dados_antes, dados_depois, usuario, criado_em
    FROM app.auditoria ${filtro}
    ORDER BY criado_em DESC, id DESC`);
  return r.recordset.map(converterLinha);
}

const auditoriaRoutes = [
  { method: 'GET', path: '/api/v1/auditoria', handler: listar }
];

module.exports = { auditar, auditoriaRoutes };
