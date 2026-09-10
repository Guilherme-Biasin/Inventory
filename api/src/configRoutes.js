// Configuracao da aba Personalizar: categorias, pessoas, locais, status e os
// vinculos Entrada/Saida. Tudo em uma linha unica ('main').

const { conexao, tipos } = require('./db');
const { auditar } = require('./auditoria');

// O banco guarda texto JSON. Se alguma coluna vier vazia ou corrompida, a tela
// precisa de uma lista vazia — nao de um erro: sem isto, um JSON quebrado em
// UMA lista deixaria o sistema inteiro sem abrir.
function json(v, padrao){
  if(v == null || v === '') return padrao;
  try { return JSON.parse(v); } catch(e){ return padrao; }
}

const VINCULOS_VAZIOS = {
  entrada: { statusIds: [], localIds: [] },
  saida:   { statusIds: [], localIds: [] }
};

// GET /api/v1/config
async function carregar(){
  const p = await conexao();
  const r = await p.request().query(`
    SELECT cats, pessoas, locais, status_opts, vinculos FROM app.config WHERE id = 'main'`);
  const c = r.recordset[0];
  if(!c){
    // A linha 'main' vem do 03_seed.sql. Sem ela nao da para gravar nada, e o
    // motivo real ("faltou rodar o seed") precisa chegar na tela — antes isso
    // aparecia como um erro generico de banco.
    const e = new Error("configuracao 'main' nao existe no banco — rode api/sql/03_seed.sql");
    e.status = 500; throw e;
  }
  return {
    cats:       json(c.cats,        []),
    pessoas:    json(c.pessoas,     []),
    locais:     json(c.locais,      []),
    statusOpts: json(c.status_opts, []),
    vinculos:   json(c.vinculos,    VINCULOS_VAZIOS)
  };
}

// Aceita so array de verdade. Um `undefined` vindo da tela viraria a string
// "undefined" no banco e a lista sumiria na proxima abertura.
function lista(v){ return JSON.stringify(Array.isArray(v) ? v : []); }

// POST /api/v1/config
async function salvar(q, body, usuario){
  const b = body || {};
  const p = await conexao(); const sql = tipos();

  // MERGE em vez de UPDATE puro: com UPDATE, se a linha 'main' nao existisse o
  // comando "funcionava" gravando zero linhas e o usuario perdia a configuracao
  // sem receber erro nenhum.
  await p.request()
    .input('cats',     sql.NVarChar(sql.MAX), lista(b.cats))
    .input('pessoas',  sql.NVarChar(sql.MAX), lista(b.pessoas))
    .input('locais',   sql.NVarChar(sql.MAX), lista(b.locais))
    .input('status',   sql.NVarChar(sql.MAX), lista(b.statusOpts))
    .input('vinculos', sql.NVarChar(sql.MAX), JSON.stringify(b.vinculos || VINCULOS_VAZIOS))
    .query(`
      MERGE app.config AS destino
      USING (SELECT 'main' AS id) AS origem ON destino.id = origem.id
      WHEN MATCHED THEN UPDATE SET
        cats = @cats, pessoas = @pessoas, locais = @locais,
        status_opts = @status, vinculos = @vinculos, atualizado_em = SYSDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (id, cats, pessoas, locais, status_opts, vinculos)
        VALUES ('main', @cats, @pessoas, @locais, @status, @vinculos);`);

  await auditar(usuario, {
    tabela: 'config', registroId: 'main', acao: 'UPDATE',
    descricao: 'Alterou a configuracao (categorias, pessoas, locais, status ou vinculos)',
    depois: {
      cats: (b.cats||[]).length, pessoas: (b.pessoas||[]).length,
      locais: (b.locais||[]).length, status: (b.statusOpts||[]).length
    }
  });
  return { ok: true };
}

const configRoutes = [
  { method: 'GET',  path: '/api/v1/config', handler: carregar },
  { method: 'POST', path: '/api/v1/config', handler: salvar, permissao: 'config' }
];

module.exports = { configRoutes };
