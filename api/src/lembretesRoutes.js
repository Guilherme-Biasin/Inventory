// Lembretes — recados com data, de todos para todos.
//
// Tabela app.lembrete (migracao 08). Guarda titulo (o que aparece no dia do
// calendario), observacoes (o detalhe), um bem relacionado como TEXTO e o
// estado concluido/pendente. Vinculo por texto de proposito: excluir o
// patrimonio nao pode deixar o lembrete apontando para o vazio.

const { conexao, tipos } = require('./db');
const { auditar } = require('./auditoria');

function txt(v, max){
  if(v == null) return null;
  const s = String(v).trim();
  if(!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

// data trafega como 'AAAA-MM-DD' do inicio ao fim (mandar Date faria o driver
// converter fuso e mudar o dia do lembrete).
function dataISO(v){
  const s = txt(v);
  if(!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// A tabela so existe depois da migracao 08. Sem ela a aba explica o que fazer
// em vez de derrubar a tela.
let _temTabela = null;
async function temTabela(p){
  if(_temTabela !== null) return _temTabela;
  try {
    const r = await p.request().query(`SELECT COUNT(*) AS n FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'app' AND t.name = 'lembrete'`);
    _temTabela = r.recordset[0].n === 1;
  } catch(e){ _temTabela = false; }
  return _temTabela;
}

function semTabela(){
  const e = new Error('a tabela de lembretes ainda nao existe neste banco — rode api/sql/08_lembretes.sql');
  e.status = 500;
  return e;
}

function exigirCampos(item){
  const data   = dataISO(item && item.data_lembrete);
  const titulo = txt(item && item.titulo, 160);
  if(!data)   throw new Error('escolha a data do lembrete');
  if(!titulo) throw new Error('escreva do que se trata o lembrete');
  return { data, titulo };
}

// ------------------------------------------------------------
// GET /api/v1/lembretes
// ------------------------------------------------------------
async function listar(){
  const p = await conexao();
  if(!(await temTabela(p))) throw semTabela();
  const r = await p.request().query(`
    SELECT id, CONVERT(varchar(10), data_lembrete, 23) AS data_lembrete,
           titulo, observacoes, referencia, concluido,
           concluido_em, concluido_por, criado_por, criado_em
    FROM app.lembrete ORDER BY data_lembrete, id`);
  return r.recordset.map(x => ({
    id:            x.id,
    data_lembrete: x.data_lembrete,
    titulo:        x.titulo,
    observacoes:   x.observacoes || '',
    referencia:    x.referencia  || '',
    concluido:     !!x.concluido,
    concluido_em:  x.concluido_em,
    concluido_por: x.concluido_por || '',
    criado_por:    x.criado_por || ''
  }));
}

// ------------------------------------------------------------
// POST /api/v1/lembretes
// ------------------------------------------------------------
async function criar(q, body, usuario){
  const item = (body && body.item) || {};
  const { data, titulo } = exigirCampos(item);

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  const r = await p.request()
    .input('data',   sql.VarChar(10),    data)
    .input('titulo', sql.VarChar(160),   titulo)
    .input('obs',    sql.NVarChar(1000), txt(item.observacoes, 1000))
    .input('ref',    sql.VarChar(160),   txt(item.referencia, 160))
    .input('por',    sql.VarChar(50),    usuario.login)
    .query(`INSERT INTO app.lembrete (data_lembrete, titulo, observacoes, referencia, criado_por)
            OUTPUT INSERTED.id
            VALUES (@data, @titulo, @obs, @ref, @por)`);
  const id = r.recordset[0].id;

  await auditar(usuario, {
    tabela: 'lembrete', registroId: id, acao: 'INSERT',
    descricao: `Criou o lembrete "${titulo}" para ${data}`, depois: item
  });
  return { id };
}

// ------------------------------------------------------------
// POST /api/v1/lembretes/atualizar
// ------------------------------------------------------------
async function atualizar(q, body, usuario){
  const id   = parseInt(body && body.id, 10);
  const item = (body && body.item) || {};
  if(!Number.isFinite(id)) throw new Error('id invalido');
  const { data, titulo } = exigirCampos(item);

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  const antesR = await p.request().input('id', sql.Int, id)
    .query(`SELECT CONVERT(varchar(10), data_lembrete, 23) AS data_lembrete,
                   titulo, observacoes, referencia, concluido
            FROM app.lembrete WHERE id = @id`);
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('lembrete nao encontrado');

  await p.request()
    .input('id',     sql.Int,            id)
    .input('data',   sql.VarChar(10),    data)
    .input('titulo', sql.VarChar(160),   titulo)
    .input('obs',    sql.NVarChar(1000), txt(item.observacoes, 1000))
    .input('ref',    sql.VarChar(160),   txt(item.referencia, 160))
    .query(`UPDATE app.lembrete SET
              data_lembrete = @data, titulo = @titulo, observacoes = @obs,
              referencia = @ref, atualizado_em = SYSDATETIME()
            WHERE id = @id`);

  await auditar(usuario, {
    tabela: 'lembrete', registroId: id, acao: 'UPDATE',
    descricao: `Editou o lembrete "${titulo}"`, antes, depois: item
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/lembretes/concluir — marca ou desmarca
// ------------------------------------------------------------
async function concluir(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id invalido');
  const feito = !!(body && body.concluido);

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  const antesR = await p.request().input('id', sql.Int, id)
    .query('SELECT titulo, concluido FROM app.lembrete WHERE id = @id');
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('lembrete nao encontrado');

  await p.request()
    .input('id',    sql.Int,         id)
    .input('feito', sql.Bit,         feito ? 1 : 0)
    .input('por',   sql.VarChar(50), feito ? usuario.login : null)
    .query(`UPDATE app.lembrete SET
              concluido = @feito,
              concluido_em = CASE WHEN @feito = 1 THEN SYSDATETIME() ELSE NULL END,
              concluido_por = @por,
              atualizado_em = SYSDATETIME()
            WHERE id = @id`);

  await auditar(usuario, {
    tabela: 'lembrete', registroId: id, acao: 'UPDATE',
    descricao: `${feito ? 'Concluiu' : 'Reabriu'} o lembrete "${antes.titulo}"`,
    antes: { concluido: !!antes.concluido }, depois: { concluido: feito }
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/lembretes/excluir
// ------------------------------------------------------------
async function excluir(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id invalido');

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  const antesR = await p.request().input('id', sql.Int, id)
    .query(`SELECT CONVERT(varchar(10), data_lembrete, 23) AS data_lembrete,
                   titulo, observacoes, referencia FROM app.lembrete WHERE id = @id`);
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('lembrete nao encontrado');

  await p.request().input('id', sql.Int, id)
    .query('DELETE FROM app.lembrete WHERE id = @id');

  await auditar(usuario, {
    tabela: 'lembrete', registroId: id, acao: 'DELETE',
    descricao: `Excluiu o lembrete "${antes.titulo}"`, antes
  });
  return { ok: true };
}

const lembretesRoutes = [
  { method: 'GET',  path: '/api/v1/lembretes',           handler: listar },
  { method: 'POST', path: '/api/v1/lembretes',           handler: criar,     permissao: 'cadastrar' },
  { method: 'POST', path: '/api/v1/lembretes/atualizar', handler: atualizar, permissao: 'editar' },
  { method: 'POST', path: '/api/v1/lembretes/concluir',  handler: concluir,  permissao: 'editar' },
  { method: 'POST', path: '/api/v1/lembretes/excluir',   handler: excluir,   permissao: 'excluir' }
];

module.exports = { lembretesRoutes };
