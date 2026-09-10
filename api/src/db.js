// Conexao com o SQL Server (banco ESTOQUE_TI).
//
// Um pool so: diferente do Gerente Assist, aqui nao existe "leitura das views
// do ERP" — este banco e inteiro da aplicacao, entao um unico usuario com
// SELECT/INSERT/UPDATE/DELETE no schema app da conta.

const fs = require('fs');
const path = require('path');

let sql = null;
let pool = null;

function lerConfig(){
  const p = path.join(__dirname, '..', 'config', 'db.json');
  if(!fs.existsSync(p)){
    throw new Error('config/db.json nao encontrado. Copie config/db.example.json para config/db.json e preencha a senha.');
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if(!cfg.requestTimeout) cfg.requestTimeout = 30000;

  // DATETIME2 no SQL Server nao guarda fuso: a hora gravada e a hora do relogio
  // da empresa. Sem useUTC:false o driver assume que aquilo era UTC e o Brasil
  // (UTC-3) passa a exibir tudo 3 horas atrasado — uma movimentacao registrada
  // as 00:30 apareceria as 21:30 do dia ANTERIOR no historico.
  cfg.options = Object.assign({ useUTC: false }, cfg.options);
  return cfg;
}

function tipos(){
  if(!sql) sql = require('mssql');
  return sql;
}

// Devolve a promessa do pool. Se a primeira conexao falhar, zera a variavel
// para a proxima chamada tentar de novo — senao o processo ficaria preso a uma
// promessa rejeitada para sempre e so um restart resolveria.
function conexao(){
  if(!pool){
    if(!sql) sql = require('mssql');
    pool = new sql.ConnectionPool(lerConfig()).connect()
      .catch(e => { pool = null; throw e; });
  }
  return pool;
}

module.exports = { conexao, tipos };
