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

// Os tres tipos de movimentacao que a tela oferece. 'movimentacao' entrou em
// 24/09/2026: antes so existiam entrada e saida, e trocar um bem de lugar sem
// que ele tivesse entrado ou saido nao tinha como ser marcado.
const VINCULOS_VAZIOS = {
  entrada:      { statusIds: [], localIds: [] },
  saida:        { statusIds: [], localIds: [] },
  movimentacao: { statusIds: [], localIds: [] }
};

// A coluna cats_almox (categorias do almoxarifado) vem da migracao
// 05_almoxarifado.sql. A API pode subir antes de a migracao ser rodada — e nesse
// caso o SELECT com a coluna derrubaria a tela INTEIRA, nao so o almoxarifado.
// Aqui o servidor pergunta uma vez ao banco e segue sem ela enquanto nao vier.
let _temAlmox = null;
async function temColunaAlmox(p){
  if(_temAlmox !== null) return _temAlmox;
  try {
    const r = await p.request().query(`SELECT COUNT(*) AS n FROM sys.columns
      WHERE object_id = OBJECT_ID('app.config') AND name = 'cats_almox'`);
    _temAlmox = r.recordset[0].n === 1;
  } catch(e){ _temAlmox = false; }
  return _temAlmox;
}

// GET /api/v1/config
async function carregar(){
  const p = await conexao();
  const almox = await temColunaAlmox(p);
  const r = await p.request().query(`
    SELECT cats, ${almox ? 'cats_almox' : 'NULL AS cats_almox'}, pessoas, locais, status_opts, vinculos
    FROM app.config WHERE id = 'main'`);
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
    catsAlmox:  json(c.cats_almox,  []),
    pessoas:    json(c.pessoas,     []),
    locais:     json(c.locais,      []),
    statusOpts: json(c.status_opts, []),
    vinculos:   json(c.vinculos,    VINCULOS_VAZIOS)
  };
}

// Categorias e status: so {id, name, color}, com cor #rgb/#rrggbb. A cor entra
// dentro de style="..." na tela; aceitar qualquer texto ali abria espaco para
// injetar CSS na pagina de todos. Campo extra que vier da tela e descartado.
const COR = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
function opcoes(v){
  if(!Array.isArray(v)) return JSON.stringify([]);
  return JSON.stringify(v
    .filter(o => o && o.id != null && String(o.name || '').trim())
    .map(o => ({
      id:    String(o.id).slice(0, 40),
      name:  String(o.name).trim().slice(0, 60),
      color: COR.test(String(o.color || '')) ? o.color : '#888888'
    })));
}

// Pessoas e locais: lista de textos. Nada e removido da lista: os vinculos
// Entrada/Saida apontam para os locais pela POSICAO, e tirar um item do meio
// deslocaria todos os seguintes.
function textos(v){
  if(!Array.isArray(v)) return JSON.stringify([]);
  return JSON.stringify(v.map(s => String(s == null ? '' : s).trim().slice(0, 120)));
}

// POST /api/v1/config
async function salvar(q, body, usuario){
  const b = body || {};
  const p = await conexao(); const sql = tipos();
  const almox = await temColunaAlmox(p);

  // MERGE em vez de UPDATE puro: com UPDATE, se a linha 'main' nao existisse o
  // comando "funcionava" gravando zero linhas e o usuario perdia a configuracao
  // sem receber erro nenhum.
  const req = p.request()
    .input('cats',     sql.NVarChar(sql.MAX), opcoes(b.cats))
    .input('pessoas',  sql.NVarChar(sql.MAX), textos(b.pessoas))
    .input('locais',   sql.NVarChar(sql.MAX), textos(b.locais))
    .input('status',   sql.NVarChar(sql.MAX), opcoes(b.statusOpts))
    .input('vinculos', sql.NVarChar(sql.MAX), JSON.stringify(b.vinculos || VINCULOS_VAZIOS));
  if(almox) req.input('almox', sql.NVarChar(sql.MAX), opcoes(b.catsAlmox));

  await req.query(`
      MERGE app.config AS destino
      USING (SELECT 'main' AS id) AS origem ON destino.id = origem.id
      WHEN MATCHED THEN UPDATE SET
        cats = @cats, pessoas = @pessoas, locais = @locais,
        status_opts = @status, vinculos = @vinculos${almox ? ', cats_almox = @almox' : ''},
        atualizado_em = SYSDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (id, cats, pessoas, locais, status_opts, vinculos${almox ? ', cats_almox' : ''})
        VALUES ('main', @cats, @pessoas, @locais, @status, @vinculos${almox ? ', @almox' : ''});`);

  await auditar(usuario, {
    tabela: 'config', registroId: 'main', acao: 'UPDATE',
    descricao: 'Alterou a configuracao (categorias, pessoas, locais, status ou vinculos)',
    depois: {
      cats: (b.cats||[]).length, catsAlmox: (b.catsAlmox||[]).length,
      pessoas: (b.pessoas||[]).length,
      locais: (b.locais||[]).length, status: (b.statusOpts||[]).length
    }
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/config/renomear — troca o nome de um local ou pessoa
// ------------------------------------------------------------
// Local e pessoa sao guardados como TEXTO no patrimonio e nas movimentacoes
// (categoria e status vao por id, e por isso nao precisam disto). Sem esta
// troca, renomear a opcao deixaria todo o historico com o nome antigo e a
// lista com o novo — duas versoes da mesma coisa.
const ALVOS = {
  local:  [['app.patrimonio', 'local_atual'], ['app.movimentacao', '[local]']],
  pessoa: [['app.patrimonio', 'usuario_atual'], ['app.movimentacao', 'usuario_atual'],
           ['app.almoxarifado_mov', 'usuario']]
};

function texto(v){ const s = String(v == null ? '' : v).trim(); return s.slice(0, 120); }

async function temAlmoxMov(p){
  try {
    const r = await p.request().query(`SELECT COUNT(*) AS n FROM sys.tables
      WHERE name = 'almoxarifado_mov' AND schema_id = SCHEMA_ID('app')`);
    return r.recordset[0].n === 1;
  } catch(e){ return false; }
}

async function renomear(q, body, usuario){
  const tipo = String((body && body.tipo) || '').toLowerCase();
  const de   = texto(body && body.de);
  const para = texto(body && body.para);
  if(!ALVOS[tipo])   throw new Error('so da para renomear local ou pessoa');
  if(!de || !para)   throw new Error('informe o nome atual e o novo');
  if(de === para)    return { ok: true, alterados: 0 };

  const p = await conexao(); const sql = tipos();
  // Sem a migracao 05 a tabela do almoxarifado nao existe: renomear a pessoa
  // continua valendo para o patrimonio em vez de a tela inteira falhar.
  const temAlmox = tipo === 'pessoa' ? await temAlmoxMov(p) : true;
  const alvos = ALVOS[tipo].filter(([t]) => temAlmox || t !== 'app.almoxarifado_mov');

  // Tudo ou nada: metade dos registros com o nome novo e a outra metade com o
  // velho seria pior do que nao ter renomeado.
  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  let alterados = 0;
  try {
    for(const [tabela, coluna] of alvos){
      const r = await pedido()
        .input('de',   sql.VarChar(120), de)
        .input('para', sql.VarChar(120), para)
        .query(`UPDATE ${tabela} SET ${coluna} = @para WHERE ${coluna} = @de`);
      alterados += (r.rowsAffected && r.rowsAffected[0]) || 0;
    }
    await tx.commit();
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    throw e;
  }

  await auditar(usuario, {
    tabela: tipo === 'local' ? 'patrimonio' : 'movimentacao', registroId: null, acao: 'UPDATE',
    descricao: `Renomeou o ${tipo} "${de}" para "${para}" em ${alterados} registro(s)`,
    antes: { [tipo]: de }, depois: { [tipo]: para, alterados }
  });
  return { ok: true, alterados };
}

const configRoutes = [
  { method: 'GET',  path: '/api/v1/config', handler: carregar },
  { method: 'POST', path: '/api/v1/config', handler: salvar, permissao: 'config' },
  { method: 'POST', path: '/api/v1/config/renomear', handler: renomear, permissao: 'config' }
];

module.exports = { configRoutes };
