// Patrimonios DESCARTADOS — arquivo morto dos bens antigos.
//
// Tabela ilhada (app.patrimonio_descartado, migracao 07): nao se relaciona com
// app.patrimonio nem com o historico, nada se move de uma para a outra e ela
// nao entra em nenhuma conta do sistema. Existe para que numeros ja
// descartados (50562, 50563...) continuem documentados sem ocupar a numeracao
// nova — o indice unico daqui e proprio, entao o mesmo numero pode existir nas
// duas tabelas ao mesmo tempo.

const { conexao, tipos } = require('./db');
const { auditar } = require('./auditoria');

function txt(v, max){
  if(v == null) return null;
  const s = String(v).trim();
  if(!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

// data trafega como 'AAAA-MM-DD' do inicio ao fim (mesma decisao do patrimonio:
// mandar Date faria o driver converter fuso e mudar o dia).
function dataISO(v){
  const s = txt(v);
  if(!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// A tabela so existe depois da migracao 07. A API pode subir antes dela: neste
// caso a aba explica o que fazer em vez de derrubar a tela inteira.
let _temTabela = null;
async function temTabela(p){
  if(_temTabela !== null) return _temTabela;
  try {
    const r = await p.request().query(`SELECT COUNT(*) AS n FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'app' AND t.name = 'patrimonio_descartado'`);
    _temTabela = r.recordset[0].n === 1;
  } catch(e){ _temTabela = false; }
  return _temTabela;
}

function semTabela(){
  const e = new Error('a tabela de descartados ainda nao existe neste banco — rode api/sql/07_patrimonio_descartado.sql');
  e.status = 500;
  return e;
}

// Violacao de indice unico vira frase que o usuario entende.
function traduzirErro(e, numero){
  if(e && (e.number === 2601 || e.number === 2627)){
    return new Error(`ja existe um descartado com o numero "${numero}"`);
  }
  return e;
}

function exigirNumero(item){
  const n = txt(item && item.patrimonio, 50);
  if(!n) throw new Error('informe o numero do patrimonio');
  return n;
}

// ------------------------------------------------------------
// GET /api/v1/descartados
// ------------------------------------------------------------
async function listar(){
  const p = await conexao();
  if(!(await temTabela(p))) throw semTabela();
  const r = await p.request().query(`
    SELECT id, patrimonio, nome, modelo, serie, categoria,
           CONVERT(varchar(10), data_descarte, 23) AS data_descarte,
           motivo, criado_em
    FROM app.patrimonio_descartado ORDER BY id`);
  return r.recordset.map(x => ({
    id:            x.id,
    patrimonio:    x.patrimonio,
    nome:          x.nome   || '',
    modelo:        x.modelo || '',
    serie:         x.serie  || '',
    // A tela trabalha com array, como no patrimonio, para reusar os mesmos
    // pills de categoria.
    categoria:     x.categoria ? [x.categoria] : [],
    data_descarte: x.data_descarte || '',
    motivo:        x.motivo || ''
  }));
}

// ------------------------------------------------------------
// POST /api/v1/descartados
// ------------------------------------------------------------
async function criar(q, body, usuario){
  const item = (body && body.item) || {};
  const numero = exigirNumero(item);

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  let id;
  try {
    const r = await p.request()
      .input('patrimonio', sql.VarChar(50),   numero)
      .input('nome',       sql.VarChar(120),  txt(item.nome, 120))
      .input('modelo',     sql.VarChar(120),  txt(item.modelo, 120))
      .input('serie',      sql.VarChar(120),  txt(item.serie, 120))
      .input('categoria',  sql.VarChar(40),   txt(item.categoria && item.categoria[0], 40))
      .input('data',       sql.VarChar(10),   dataISO(item.data_descarte))
      .input('motivo',     sql.NVarChar(500), txt(item.motivo, 500))
      .input('por',        sql.VarChar(50),   usuario.login)
      .query(`INSERT INTO app.patrimonio_descartado
                (patrimonio, nome, modelo, serie, categoria, data_descarte, motivo, criado_por)
              OUTPUT INSERTED.id
              VALUES (@patrimonio, @nome, @modelo, @serie, @categoria, @data, @motivo, @por)`);
    id = r.recordset[0].id;
  } catch(e){ throw traduzirErro(e, numero); }

  await auditar(usuario, {
    tabela: 'patrimonio_descartado', registroId: id, acao: 'INSERT',
    descricao: `Cadastrou o descartado ${numero}`,
    depois: item
  });
  return { id };
}

// ------------------------------------------------------------
// POST /api/v1/descartados/atualizar
// ------------------------------------------------------------
async function atualizar(q, body, usuario){
  const id   = parseInt(body && body.id, 10);
  const item = (body && body.item) || {};
  if(!Number.isFinite(id)) throw new Error('id invalido');
  const numero = exigirNumero(item);

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  const antesR = await p.request().input('id', sql.Int, id)
    .query(`SELECT patrimonio, nome, modelo, serie, categoria,
                   CONVERT(varchar(10), data_descarte, 23) AS data_descarte, motivo
            FROM app.patrimonio_descartado WHERE id = @id`);
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('descartado nao encontrado');

  try {
    await p.request()
      .input('id',         sql.Int,           id)
      .input('patrimonio', sql.VarChar(50),   numero)
      .input('nome',       sql.VarChar(120),  txt(item.nome, 120))
      .input('modelo',     sql.VarChar(120),  txt(item.modelo, 120))
      .input('serie',      sql.VarChar(120),  txt(item.serie, 120))
      .input('categoria',  sql.VarChar(40),   txt(item.categoria && item.categoria[0], 40))
      .input('data',       sql.VarChar(10),   dataISO(item.data_descarte))
      .input('motivo',     sql.NVarChar(500), txt(item.motivo, 500))
      .query(`UPDATE app.patrimonio_descartado SET
                patrimonio = @patrimonio, nome = @nome, modelo = @modelo,
                serie = @serie, categoria = @categoria, data_descarte = @data,
                motivo = @motivo, atualizado_em = SYSDATETIME()
              WHERE id = @id`);
  } catch(e){ throw traduzirErro(e, numero); }

  await auditar(usuario, {
    tabela: 'patrimonio_descartado', registroId: id, acao: 'UPDATE',
    descricao: `Editou o descartado ${numero}`, antes, depois: item
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/descartados/excluir
// ------------------------------------------------------------
async function excluir(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id invalido');

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();
  const antesR = await p.request().input('id', sql.Int, id)
    .query('SELECT patrimonio, nome, modelo, serie FROM app.patrimonio_descartado WHERE id = @id');
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('descartado nao encontrado');

  await p.request().input('id', sql.Int, id)
    .query('DELETE FROM app.patrimonio_descartado WHERE id = @id');

  await auditar(usuario, {
    tabela: 'patrimonio_descartado', registroId: id, acao: 'DELETE',
    descricao: `Excluiu o descartado ${antes.patrimonio}`, antes
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/descartados/importar — tudo ou nada
// ------------------------------------------------------------
// Mesmas regras da importacao de patrimonio: a planilha inteira e conferida
// antes, cada erro volta com linha, campo, motivo e como corrigir, e so grava
// se nao houver nenhum. Com simular=true apenas confere.
async function conferirImportacao(p, rows){
  const erros = [];
  const jaVistos = new Map();

  const existentes = await p.request()
    .query('SELECT patrimonio FROM app.patrimonio_descartado');
  const noBanco = new Set(existentes.recordset.map(r => String(r.patrimonio).toLowerCase()));

  rows.forEach((r, i) => {
    const linha = (r && r.linha) || (i + 2);
    const numero = txt(r && r.patrimonio, 50);
    if(!numero){
      erros.push({ linha, campo: 'Nº Patrimônio', motivo: 'esta em branco',
        correcao: 'Preencha o numero do patrimonio antigo.' });
      return;
    }
    const chave = numero.toLowerCase();
    if(noBanco.has(chave)){
      erros.push({ linha, campo: 'Nº Patrimônio', motivo: `"${numero}" ja esta cadastrado nos descartados`,
        correcao: 'Apague a linha, ou corrija o numero se for outro bem.' });
    }
    if(jaVistos.has(chave)){
      erros.push({ linha, campo: 'Nº Patrimônio', motivo: `"${numero}" aparece tambem na linha ${jaVistos.get(chave)}`,
        correcao: 'Deixe uma linha so para cada numero.' });
    } else {
      jaVistos.set(chave, linha);
    }
    if(r.data_descarte && !dataISO(r.data_descarte)){
      erros.push({ linha, campo: 'Data do Descarte', motivo: 'data invalida',
        correcao: 'Use o formato AAAA-MM-DD (ex.: 2024-03-15) ou deixe em branco.' });
    }
  });
  return erros;
}

async function importar(q, body, usuario){
  const rows = (body && body.rows) || [];
  const simular = !!(body && body.simular);
  if(!Array.isArray(rows) || !rows.length) throw new Error('nenhuma linha recebida');

  const p = await conexao(); const sql = tipos();
  if(!(await temTabela(p))) throw semTabela();

  const erros = await conferirImportacao(p, rows);
  if(erros.length || simular) return { gravado: false, erros, linhas: rows.length };

  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  try {
    for(const r of rows){
      await pedido()
        .input('patrimonio', sql.VarChar(50),   txt(r.patrimonio, 50))
        .input('nome',       sql.VarChar(120),  txt(r.nome, 120))
        .input('modelo',     sql.VarChar(120),  txt(r.modelo, 120))
        .input('serie',      sql.VarChar(120),  txt(r.serie, 120))
        .input('categoria',  sql.VarChar(40),   txt(r.categoria, 40))
        .input('data',       sql.VarChar(10),   dataISO(r.data_descarte))
        .input('motivo',     sql.NVarChar(500), txt(r.motivo, 500))
        .input('por',        sql.VarChar(50),   usuario.login)
        .query(`INSERT INTO app.patrimonio_descartado
                  (patrimonio, nome, modelo, serie, categoria, data_descarte, motivo, criado_por)
                VALUES (@patrimonio, @nome, @modelo, @serie, @categoria, @data, @motivo, @por)`);
    }
    await tx.commit();
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    throw e;
  }

  await auditar(usuario, {
    tabela: 'patrimonio_descartado', registroId: null, acao: 'INSERT',
    descricao: `Importou ${rows.length} patrimonio(s) descartado(s)`,
    depois: { linhas: rows.length }
  });
  return { gravado: true, erros: [], linhas: rows.length };
}

const descartadosRoutes = [
  { method: 'GET',  path: '/api/v1/descartados',           handler: listar },
  { method: 'POST', path: '/api/v1/descartados',           handler: criar,     permissao: 'cadastrar' },
  { method: 'POST', path: '/api/v1/descartados/atualizar', handler: atualizar, permissao: 'editar' },
  { method: 'POST', path: '/api/v1/descartados/excluir',   handler: excluir,   permissao: 'excluir' },
  { method: 'POST', path: '/api/v1/descartados/importar',  handler: importar,  permissao: 'cadastrar', simulavel: true }
];

module.exports = { descartadosRoutes };
