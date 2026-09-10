// Testes dos handlers da API — rode com:  npm test   (dentro de api/)
//
// Nao precisa de banco: o modulo src/db.js e trocado por um SQL Server falso
// que registra as consultas e devolve respostas prontas. Isso NAO valida o
// T-SQL (para isso e preciso rodar de verdade), mas valida tudo em volta dele:
// nomes de campo, transacao, traducao de erro, travas de permissao e o formato
// exato que a tela espera receber.

const path = require('path');
const API = path.resolve(__dirname, '..');
const mssql = require('mssql');

const consultas = [];
let respostas = [];   // fila de recordsets; vazio => []

function novaRequest(){
  const r = {
    _in: {},
    input(nome, tipo, valor){ this._in[nome] = valor; return this; },
    async query(sql){
      consultas.push({ sql: sql.replace(/\s+/g, ' ').trim(), entradas: { ...this._in } });
      const prox = respostas.length ? respostas.shift() : [];
      if(prox instanceof Error) throw prox;
      return { recordset: prox, rowsAffected: [prox.length] };
    }
  };
  return r;
}

const poolFalso = { request: novaRequest };

class TransactionFalsa {
  constructor(){ this.eventos = []; }
  async begin(){ this.eventos.push('begin'); }
  async commit(){ this.eventos.push('commit'); }
  async rollback(){ this.eventos.push('rollback'); }
}

const tiposFalsos = new Proxy({}, {
  get(_, prop){
    if(prop === 'Transaction') return TransactionFalsa;
    if(prop === 'Request') return function(){ return novaRequest(); };
    return mssql[prop];
  }
});

// Substitui o modulo db antes de qualquer rota carregar.
const dbPath = require.resolve(path.join(API, 'src/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    conexao: async () => poolFalso,
    tipos: () => tiposFalsos
  }
};

const { patrimoniosRoutes } = require(path.join(API, 'src/patrimoniosRoutes'));
const { configRoutes }      = require(path.join(API, 'src/configRoutes'));
const { usuariosRoutes }    = require(path.join(API, 'src/usuariosRoutes'));
const { auditoriaRoutes }   = require(path.join(API, 'src/auditoria'));
const { authRoutes }        = require(path.join(API, 'src/authRoutes'));
const auth                  = require(path.join(API, 'src/auth'));

const todas = [...authRoutes, ...configRoutes, ...patrimoniosRoutes, ...auditoriaRoutes, ...usuariosRoutes];
const rota = (metodo, caminho) => {
  const r = todas.find(x => x.method === metodo && x.path === caminho);
  if(!r) throw new Error('rota nao registrada: ' + metodo + ' ' + caminho);
  return r;
};

const ADMIN = { login: 'admin', papel: 'admin' };
const qs = (s) => new URL('http://x' + (s || '')).searchParams;

let ok = 0, falhas = 0;
async function teste(nome, fn){
  consultas.length = 0; respostas = [];
  try { await fn(); console.log('  OK   ' + nome); ok++; }
  catch(e){ console.log('  FALHA ' + nome + '\n        ' + e.message); falhas++; }
}
function igual(a, b, oque){
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if(x !== y) throw new Error(`${oque}: esperado ${y}, veio ${x}`);
}
async function lanca(fn, trecho){
  try { await fn(); } catch(e){
    if(!e.message.includes(trecho)) throw new Error(`erro errado: "${e.message}" (esperava conter "${trecho}")`);
    return;
  }
  throw new Error('deveria ter dado erro contendo: ' + trecho);
}

(async () => {
console.log('\n— PATRIMONIOS —');

await teste('listar junta historico com o patrimonio certo', async () => {
  respostas = [
    [{ id: 1, patrimonio: '001', nome: 'Dell', modelo: 'Vostro', serie: 'SN1',
       categoria: 'c1', status: 's1', local_atual: 'TI', usuario_atual: 'Ana' },
     { id: 2, patrimonio: '002', nome: null, modelo: null, serie: null,
       categoria: null, status: null, local_atual: null, usuario_atual: null }],
    [{ patrimonio_id: 1, tipo: 'entrada', data_mov: '2026-01-05', quem_recebeu_retirou: 'Entrada',
       usuario_atual: 'Ana', local: 'TI', obs_mov: 'ok', criado_em: new Date('2026-01-05T10:00:00') },
     { patrimonio_id: 1, tipo: 'movimentacao', data_mov: '2026-02-01', quem_recebeu_retirou: 'Saída',
       usuario_atual: 'Bia', local: 'Loja', obs_mov: null, criado_em: new Date('2026-02-01T10:00:00') }]
  ];
  const r = await rota('GET', '/api/v1/patrimonios').handler(qs(), null, ADMIN);
  igual(r.length, 2, 'qtd de itens');
  igual(r[0].categoria, ['c1'], 'categoria vira array');
  igual(r[0].historico.length, 2, 'historico do item 1');
  igual(r[1].historico, [], 'item 2 sem historico');
  igual(r[1].nome, '', 'null vira string vazia');
  igual(r[0].historico[0].data_mov, '2026-01-05', 'data_mov como texto');
});

await teste('carimbo monta o resumo', async () => {
  respostas = [[{ qtd_pat: 3, max_pat: new Date('2026-03-01T00:00:00'), qtd_mov: 7, max_mov: null }]];
  const r = await rota('GET', '/api/v1/carimbo').handler(qs(), null, ADMIN);
  if(!/^3\|\d+\|7\|$/.test(r.carimbo)) throw new Error('carimbo estranho: ' + r.carimbo);
});

await teste('criar abre transacao, insere os dois e confirma', async () => {
  respostas = [[{ id: 42 }], []];
  const r = await rota('POST', '/api/v1/patrimonios').handler(qs(), {
    item: { patrimonio: ' 007 ', nome: 'Dell', modelo: 'X', serie: 'S', categoria: ['c1'], status: ['s1'] },
    mov:  { data_mov: '2026-05-01', quem_recebeu_retirou: 'Entrada', local: 'TI', usuario_atual: 'Ana', obs_mov: '' }
  }, ADMIN);
  igual(r.id, 42, 'id devolvido');
  const ins = consultas.filter(c => c.sql.startsWith('INSERT INTO app.patrimonio'));
  igual(ins.length, 1, 'um insert de patrimonio');
  igual(ins[0].entradas.patrimonio, '007', 'numero sem espacos');
  if(!consultas.some(c => c.sql.startsWith('INSERT INTO app.movimentacao'))) throw new Error('faltou a movimentacao');
});

await teste('criar sem dados de movimentacao nao grava historico vazio', async () => {
  respostas = [[{ id: 43 }]];
  await rota('POST', '/api/v1/patrimonios').handler(qs(), {
    item: { patrimonio: '008', nome: 'HP' }, mov: {}
  }, ADMIN);
  if(consultas.some(c => c.sql.startsWith('INSERT INTO app.movimentacao'))) throw new Error('gravou movimentacao vazia');
});

await teste('criar traduz numero repetido', async () => {
  const dup = new Error('Violation of UNIQUE KEY constraint'); dup.number = 2601;
  respostas = [dup];
  await lanca(() => rota('POST', '/api/v1/patrimonios').handler(qs(), {
    item: { patrimonio: '001' }, mov: {}
  }, ADMIN), 'ja existe um patrimonio com o numero "001"');
});

await teste('criar sem numero recusa antes de tocar no banco', async () => {
  await lanca(() => rota('POST', '/api/v1/patrimonios').handler(qs(), { item: {}, mov: {} }, ADMIN),
              'informe o numero do patrimonio');
  igual(consultas.length, 0, 'consultas disparadas');
});

await teste('movimentar so sobrescreve o que veio preenchido', async () => {
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { local: 'Loja', obs_mov: 'levou' }
  }, ADMIN);
  const upd = consultas.find(c => c.sql.startsWith('UPDATE app.patrimonio'));
  if(!upd.sql.includes('local_atual = @local')) throw new Error('deveria atualizar o local');
  if(upd.sql.includes('usuario_atual =')) throw new Error('nao deveria mexer no usuario atual');
});

await teste('movimentar em patrimonio inexistente avisa', async () => {
  respostas = [[]];
  await lanca(() => rota('POST', '/api/v1/movimentacoes').handler(qs(), { patrimonioId: 99, mov: {} }, ADMIN),
              'patrimonio nao encontrado');
});

await teste('data_mov invalida vira NULL em vez de quebrar', async () => {
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { data_mov: '01/05/2026', local: 'TI' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.movimentacao'));
  igual(ins.entradas.data, null, 'data invalida');
});

await teste('excluir devolve o antes para a auditoria', async () => {
  respostas = [[{ patrimonio: '001', nome: 'Dell', modelo: 'X' }], []];
  await rota('POST', '/api/v1/patrimonios/excluir').handler(qs(), { id: 1 }, ADMIN);
  if(!consultas.some(c => c.sql.startsWith('DELETE FROM app.patrimonio'))) throw new Error('nao apagou');
});

await teste('importar conta acertos e erros por linha', async () => {
  const dup = new Error('dup'); dup.number = 2627;
  respostas = [[{ id: 1 }], [], dup, [{ id: 3 }], []];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [{ patrimonio: 'A' }, { patrimonio: 'B' }, { patrimonio: 'C' }]
  }, ADMIN);
  igual(r.sucesso, 2, 'sucessos');
  igual(r.erros.length, 1, 'erros');
  igual(r.erros[0].linha, 3, 'linha do erro');
  if(!r.erros[0].motivo.includes('ja existe')) throw new Error('motivo nao traduzido: ' + r.erros[0].motivo);
});

await teste('movimentacao grava o status e atualiza o do bem', async () => {
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { local: 'Manutencao', status: 's3' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.movimentacao'));
  igual(ins.entradas.status, 's3', 'status no historico');
  const upd = consultas.find(c => c.sql.startsWith('UPDATE app.patrimonio'));
  if(!upd.sql.includes('status = @status')) throw new Error('nao atualizou o status do bem');
});

await teste('movimentacao sem status nao mexe no status do bem', async () => {
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { local: 'TI' }
  }, ADMIN);
  const upd = consultas.find(c => c.sql.startsWith('UPDATE app.patrimonio'));
  if(upd.sql.includes('status = @status')) throw new Error('sobrescreveu o status sem pedirem');
});

await teste('entrada do cadastro herda o status do patrimonio', async () => {
  respostas = [[{ id: 50 }], []];
  await rota('POST', '/api/v1/patrimonios').handler(qs(), {
    item: { patrimonio: '010', nome: 'Dell', status: ['s1'] },
    mov:  { data_mov: '2026-05-01', local: 'TI' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.movimentacao'));
  igual(ins.entradas.status, 's1', 'status da entrada inicial');
});

await teste('listar devolve o status de cada movimentacao', async () => {
  respostas = [
    [{ id: 1, patrimonio: '001', nome: 'D', modelo: null, serie: null,
       categoria: 'c1', status: 's3', local_atual: null, usuario_atual: null }],
    [{ patrimonio_id: 1, tipo: 'movimentacao', data_mov: null, quem_recebeu_retirou: 'Saida',
       usuario_atual: null, local: 'Manutencao', status: 's3', obs_mov: null, criado_em: new Date() }]
  ];
  const r = await rota('GET', '/api/v1/patrimonios').handler(qs(), null, ADMIN);
  igual(r[0].historico[0].status, 's3', 'status no historico');
});

console.log('\n— CONFIG —');

await teste('config devolve listas mesmo com JSON corrompido', async () => {
  respostas = [[{ cats: '[{"id":"c1"}]', pessoas: null, locais: 'nao e json',
                  status_opts: '[]', vinculos: null }]];
  const r = await rota('GET', '/api/v1/config').handler(qs(), null, ADMIN);
  igual(r.cats.length, 1, 'cats');
  igual(r.pessoas, [], 'pessoas nulo');
  igual(r.locais, [], 'locais corrompido');
  igual(r.vinculos.entrada.statusIds, [], 'vinculos padrao');
});

await teste('config sem a linha main explica o motivo', async () => {
  respostas = [[]];
  await lanca(() => rota('GET', '/api/v1/config').handler(qs(), null, ADMIN), '03_seed.sql');
});

await teste('salvar config usa MERGE e nao perde lista undefined', async () => {
  respostas = [[], []];
  await rota('POST', '/api/v1/config').handler(qs(), { cats: [{ id: 'c1' }] }, ADMIN);
  const m = consultas.find(c => c.sql.startsWith('MERGE app.config'));
  igual(m.entradas.pessoas, '[]', 'lista ausente vira []');
});

console.log('\n— USUARIOS —');

await teste('criar usuario normaliza o login e guarda a senha em hash', async () => {
  respostas = [[{ id: 5 }], []];
  const r = await rota('POST', '/api/v1/usuarios').handler(qs(),
    { login: '  Alex.Guedes ', papel: 'editor', senha: '1234' }, ADMIN);
  igual(r.login, 'alex.guedes', 'login normalizado');
  if('senhaProvisoria' in r) throw new Error('nao deveria mais sortear senha');
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.usuario'));
  if(ins.entradas.hash === '1234') throw new Error('gravou a senha em texto puro');
  if(!auth.verificarSenha('1234', ins.entradas.hash)) throw new Error('hash nao confere com a senha');
});

await teste('criar usuario sem senha e recusado', async () => {
  await lanca(() => rota('POST', '/api/v1/usuarios').handler(qs(),
    { login: 'ana', papel: 'leitor' }, ADMIN), 'ao menos 4 caracteres');
  igual(consultas.length, 0, 'consultas disparadas');
});

await teste('senha de 4 caracteres e aceita — qualquer caractere serve', async () => {
  respostas = [[{ id: 6 }], []];
  const r = await rota('POST', '/api/v1/usuarios').handler(qs(),
    { login: 'bia', papel: 'leitor', senha: 'ab c' }, ADMIN);
  igual(r.login, 'bia', 'criado');
});

await teste('login com espaco ou acento e recusado', async () => {
  await lanca(() => rota('POST', '/api/v1/usuarios').handler(qs(), { login: 'joão silva', papel: 'leitor' }, ADMIN),
              'login invalido');
});

await teste('papel fora da lista e recusado', async () => {
  await lanca(() => rota('POST', '/api/v1/usuarios').handler(qs(), { login: 'ana', papel: 'chefe' }, ADMIN),
              'papel invalido');
});

await teste('login repetido avisa em portugues', async () => {
  const dup = new Error('dup'); dup.number = 2627;
  respostas = [dup];
  await lanca(() => rota('POST', '/api/v1/usuarios').handler(qs(), { login: 'admin', papel: 'admin', senha: '1234' }, ADMIN),
              'ja existe');
});

await teste('ninguem desativa a propria conta', async () => {
  respostas = [[{ id: 1, login: 'admin', nome: 'A', papel: 'admin', ativo: 1 }]];
  await lanca(() => rota('POST', '/api/v1/usuarios/ativo').handler(qs(), { id: 1, ativo: false }, ADMIN),
              'nao pode desativar a propria conta');
});

await teste('o ultimo admin nao pode ser rebaixado', async () => {
  respostas = [[{ id: 2, login: 'outro', nome: 'O', papel: 'admin', ativo: 1 }], [{ n: 0 }]];
  await lanca(() => rota('POST', '/api/v1/usuarios/atualizar').handler(qs(), { id: 2, papel: 'leitor' }, ADMIN),
              'unico administrador ativo');
});

await teste('com outro admin ativo, o rebaixamento passa', async () => {
  respostas = [[{ id: 2, login: 'outro', nome: 'O', papel: 'admin', ativo: 1 }], [{ n: 1 }], [], []];
  const r = await rota('POST', '/api/v1/usuarios/atualizar').handler(qs(), { id: 2, nome: 'O', papel: 'leitor' }, ADMIN);
  igual(r.ok, true, 'resultado');
});

await teste('listar usuarios converte ativo 0/1 em booleano', async () => {
  respostas = [[{ id: 1, login: 'a', nome: 'A', papel: 'admin', ativo: 1, criado_em: new Date() },
                { id: 2, login: 'b', nome: 'B', papel: 'leitor', ativo: 0, criado_em: new Date() }]];
  const r = await rota('GET', '/api/v1/usuarios').handler(qs(), null, ADMIN);
  igual(r[0].ativo, true, 'ativo'); igual(r[1].ativo, false, 'inativo');
});

await teste('senha curta e recusada na redefinicao', async () => {
  await lanca(() => rota('POST', '/api/v1/usuarios/senha').handler(qs(), { id: 2, nova: '123' }, ADMIN),
              'ao menos 4 caracteres');
});

console.log('\n— LOGIN / SENHA —');

await teste('login certo devolve token e papel', async () => {
  const hash = auth.hashSenha('Trocar@123');
  respostas = [[{ usuario_id: 1, login: 'admin', senha_hash: hash, nome: 'Adm', papel: 'admin', ativo: true }]];
  const r = await rota('POST', '/api/v1/login').handler(qs(), { login: 'admin', senha: 'Trocar@123' }, null, { ip: '1.1.1.1' });
  igual(r.usuario.papel, 'admin', 'papel');
  igual(auth.verificarToken(r.token).login, 'admin', 'token valido');
});

await teste('senha errada devolve 401 sem dizer o motivo exato', async () => {
  const hash = auth.hashSenha('certa');
  respostas = [[{ usuario_id: 1, login: 'admin', senha_hash: hash, nome: 'A', papel: 'admin', ativo: true }]];
  try {
    await rota('POST', '/api/v1/login').handler(qs(), { login: 'admin', senha: 'errada' }, null, { ip: '2.2.2.2' });
    throw new Error('deveria falhar');
  } catch(e){
    igual(e.status, 401, 'status');
    if(e.message.includes('senha errada')) throw new Error('mensagem vaza detalhe');
  }
});

await teste('usuario inativo nao entra', async () => {
  const hash = auth.hashSenha('x123456');
  respostas = [[{ usuario_id: 1, login: 'ex', senha_hash: hash, nome: 'X', papel: 'leitor', ativo: false }]];
  await lanca(() => rota('POST', '/api/v1/login').handler(qs(), { login: 'ex', senha: 'x123456' }, null, { ip: '3.3.3.3' }),
              'login ou senha invalidos');
});

await teste('freio bloqueia depois de 5 erros do mesmo IP', async () => {
  const hash = auth.hashSenha('certa');
  for(let i = 0; i < 5; i++){
    respostas = [[{ usuario_id: 1, login: 'freio', senha_hash: hash, nome: 'A', papel: 'admin', ativo: true }]];
    try { await rota('POST', '/api/v1/login').handler(qs(), { login: 'freio', senha: 'errada' }, null, { ip: '9.9.9.9' }); } catch(e){}
  }
  respostas = [[{ usuario_id: 1, login: 'freio', senha_hash: hash, nome: 'A', papel: 'admin', ativo: true }]];
  try {
    await rota('POST', '/api/v1/login').handler(qs(), { login: 'freio', senha: 'certa' }, null, { ip: '9.9.9.9' });
    throw new Error('deveria estar bloqueado');
  } catch(e){ igual(e.status, 429, 'status do bloqueio'); }
});

await teste('trocar senha exige a atual correta', async () => {
  respostas = [[{ senha_hash: auth.hashSenha('atual123') }]];
  await lanca(() => rota('POST', '/api/v1/senha').handler(qs(), { atual: 'errada', nova: 'nova123' }, ADMIN),
              'senha atual incorreta');
});

await teste('trocar senha grava o hash novo', async () => {
  respostas = [[{ senha_hash: auth.hashSenha('atual123') }], []];
  const r = await rota('POST', '/api/v1/senha').handler(qs(), { atual: 'atual123', nova: 'novaSenha' }, ADMIN);
  igual(r.ok, true, 'ok');
  const upd = consultas.find(c => c.sql.includes('UPDATE app.usuario SET senha_hash'));
  if(upd.entradas.h === auth.hashSenha('novaSenha')) throw new Error('hash sem sal — dois hashes iguais');
  if(!auth.verificarSenha('novaSenha', upd.entradas.h)) throw new Error('hash gravado nao confere');
});

console.log('\n— AUDITORIA —');

await teste('limite e travado entre 1 e 1000', async () => {
  respostas = [[]];
  await rota('GET', '/api/v1/auditoria').handler(qs('?limite=999999999'), null, ADMIN);
  igual(consultas[0].entradas.limite, 1000, 'teto');
});

await teste('limite invalido cai no padrao 200', async () => {
  respostas = [[]];
  await rota('GET', '/api/v1/auditoria').handler(qs('?limite=abc'), null, ADMIN);
  igual(consultas[0].entradas.limite, 200, 'padrao');
});

await teste('dados_antes/depois voltam como objeto', async () => {
  respostas = [[{ id: 1, tabela: 'patrimonio', registro_id: '1', acao: 'UPDATE', descricao: 'x',
                  dados_antes: '{"nome":"Dell"}', dados_depois: null, usuario: 'admin', criado_em: new Date() }]];
  const r = await rota('GET', '/api/v1/auditoria').handler(qs(), null, ADMIN);
  igual(r[0].dados_antes.nome, 'Dell', 'json convertido');
  igual(r[0].dados_depois, null, 'nulo continua nulo');
});

await teste('auditoria nao derruba a operacao quando falha', async () => {
  respostas = [[{ patrimonio: '001', nome: 'D', modelo: 'X' }], [], new Error('tabela fora do ar')];
  const r = await rota('POST', '/api/v1/patrimonios/excluir').handler(qs(), { id: 1 }, ADMIN);
  igual(r.ok, true, 'exclusao concluida mesmo assim');
});

console.log(`\n${ok} passaram, ${falhas} falharam\n`);
process.exit(falhas ? 1 : 0);
})();
