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
const { almoxarifadoRoutes } = require(path.join(API, 'src/almoxarifadoRoutes'));
const { descartadosRoutes }  = require(path.join(API, 'src/descartadosRoutes'));
const { configRoutes }      = require(path.join(API, 'src/configRoutes'));
const { usuariosRoutes }    = require(path.join(API, 'src/usuariosRoutes'));
const { auditoriaRoutes }   = require(path.join(API, 'src/auditoria'));
const { authRoutes, sessaoValida, invalidarCacheAtivos } = require(path.join(API, 'src/authRoutes'));
const auth                  = require(path.join(API, 'src/auth'));

const todas = [...authRoutes, ...configRoutes, ...patrimoniosRoutes, ...almoxarifadoRoutes,
               ...descartadosRoutes, ...auditoriaRoutes, ...usuariosRoutes];
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

await teste('carimbo monta o resumo, com o almoxarifado junto', async () => {
  // A 1a resposta e da conferencia "as tabelas do almoxarifado existem?".
  respostas = [[{ n: 2 }],
               [{ qtd_pat: 3, max_pat: new Date('2026-03-01T00:00:00'), qtd_mov: 7, max_mov: null,
                  qtd_alm: 4, max_alm: new Date('2026-03-02T00:00:00'), qtd_alm_mov: 9, max_alm_mov: null }]];
  const r = await rota('GET', '/api/v1/carimbo').handler(qs(), null, ADMIN);
  if(!/^3\|\d+\|7\|\|4\|\d+\|9\|$/.test(r.carimbo)) throw new Error('carimbo estranho: ' + r.carimbo);
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

await teste('movimentar so sobrescreve local e status quando vem preenchidos', async () => {
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { local: 'Loja', obs_mov: 'levou' }
  }, ADMIN);
  const upd = consultas.find(c => c.sql.startsWith('UPDATE app.patrimonio'));
  if(!upd.sql.includes('local_atual = @local')) throw new Error('deveria atualizar o local');
  if(upd.sql.includes('status = @status')) throw new Error('nao deveria mexer no status');
});

await teste('usuario em branco limpa quem esta com o bem', async () => {
  // Campo vazio na edicao quer dizer "nao esta com ninguem". Manter o anterior
  // deixava o sistema mostrando alguem que ja devolveu o bem.
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { local: 'TI', usuario_atual: '' }
  }, ADMIN);
  const upd = consultas.find(c => c.sql.startsWith('UPDATE app.patrimonio'));
  if(!upd.sql.includes('usuario_atual = @usu')) throw new Error('deveria gravar o usuario');
  igual(upd.entradas.usu, null, 'usuario gravado');
});

await teste('movimentacao aceita o tipo "Movimentacao" alem de entrada e saida', async () => {
  respostas = [[{ patrimonio: '001' }], [], []];
  await rota('POST', '/api/v1/movimentacoes').handler(qs(), {
    patrimonioId: 1, mov: { local: 'TI', quem_recebeu_retirou: 'Movimentação' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.movimentacao'));
  igual(ins.entradas.quem, 'Movimentação', 'tipo escolhido na tela');
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

// Configuracao e numeros existentes que a conferencia da importacao le primeiro.
const CFG_IMPORT = [{
  cats: '[{"id":"c1","name":"Notebook","color":"#2563eb"}]',
  status_opts: '[{"id":"s1","name":"Em uso","color":"#059669"}]',
  locais: '["TI"]'
}];
const linhaOk = (linha, numero) => ({ linha, patrimonio: numero, nome: 'Dell', modelo: 'Vostro',
  serie: 'SN' + numero, categoria: 'notebook', status: 'Em uso', local_atual: 'ti' });

await teste('importar: planilha certa grava tudo numa transacao, com historico', async () => {
  respostas = [CFG_IMPORT, [{ patrimonio: '999' }], [{ id: 1 }], [], [{ id: 2 }], [], []];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [linhaOk(2, 'A'), linhaOk(3, 'B')]
  }, ADMIN);
  igual(r.gravado, true, 'gravado');
  igual(r.sucesso, 2, 'sucessos');
  const movs = consultas.filter(c => c.sql.startsWith('INSERT INTO app.movimentacao'));
  igual(movs.length, 2, 'uma entrada no historico por bem');
  const pat = consultas.find(c => c.sql.startsWith('INSERT INTO app.patrimonio'));
  igual([pat.entradas.categoria, pat.entradas.status, pat.entradas.local], ['c1', 's1', 'TI'], 'nomes traduzidos');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movs[0].entradas.data)) throw new Error('entrada sem data');
});

await teste('importar: com um erro que seja, nada e gravado', async () => {
  respostas = [CFG_IMPORT, []];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [linhaOk(2, 'A'), Object.assign(linhaOk(3, 'B'), { categoria: 'Tablet' })]
  }, ADMIN);
  igual(r.gravado, false, 'nao gravou');
  igual(r.erros.length, 1, 'um erro');
  igual(r.erros[0].linha, 3, 'linha');
  if (!r.erros[0].correcao.includes('Notebook')) throw new Error('correcao nao lista as categorias validas');
  if (consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('gravou mesmo com erro');
});

await teste('importar: numero repetido na planilha e ja cadastrado viram erro explicado', async () => {
  respostas = [CFG_IMPORT, [{ patrimonio: 'x-1' }]];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [linhaOk(2, 'A'), linhaOk(5, 'a'), linhaOk(6, 'X-1')]
  }, ADMIN);
  igual(r.erros.map(e => e.linha), [5, 6], 'linhas');
  if (!r.erros[0].motivo.includes('linha 2')) throw new Error('nao disse onde esta a repeticao: ' + r.erros[0].motivo);
  if (!r.erros[1].motivo.includes('já está cadastrado')) throw new Error('nao acusou o existente: ' + r.erros[1].motivo);
});

await teste('importar: campo vazio e texto longo demais nao sao cortados calados', async () => {
  respostas = [CFG_IMPORT, []];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [Object.assign(linhaOk(2, 'A'), { modelo: '', serie: 'S'.repeat(121) })]
  }, ADMIN);
  igual(r.erros.map(e => e.campo), ['Modelo', 'N° Série'], 'campos');
});

await teste('importar: simular so confere, mesmo com a planilha certa', async () => {
  respostas = [CFG_IMPORT, []];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [linhaOk(2, 'A')], simular: true
  }, ADMIN);
  igual([r.gravado, r.erros.length], [false, 0], 'conferido sem gravar');
  if (consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('simulacao gravou');
});

await teste('importar: falha do banco no meio desfaz tudo e explica', async () => {
  const dup = new Error('dup'); dup.number = 2627;
  respostas = [CFG_IMPORT, [], [{ id: 1 }], [], dup];
  const r = await rota('POST', '/api/v1/patrimonios/importar').handler(qs(), {
    rows: [linhaOk(2, 'A'), linhaOk(3, 'B')]
  }, ADMIN);
  igual([r.gravado, r.sucesso], [false, 0], 'nada gravado');
  igual(r.erros[0].linha, 3, 'linha que falhou');
  if (!r.erros[0].motivo.includes('ja existe')) throw new Error('motivo nao traduzido');
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

await teste('renomear local troca o texto no patrimonio e no historico', async () => {
  // O fake devolve rowsAffected = tamanho do recordset: 3 linhas + 2 linhas.
  respostas = [[{}, {}, {}], [{}, {}]];
  const r = await rota('POST', '/api/v1/config/renomear').handler(qs(), {
    tipo: 'local', de: 'Gerencia', para: 'Gerência'
  }, ADMIN);
  igual(r.alterados, 5, 'registros alterados');
  const ups = consultas.filter(c => c.sql.startsWith('UPDATE'));
  igual(ups.length, 2, 'patrimonio + movimentacao');
  if(!ups[0].sql.includes('app.patrimonio SET local_atual')) throw new Error('faltou o patrimonio');
  if(!ups[1].sql.includes('app.movimentacao SET [local]')) throw new Error('faltou a movimentacao');
  igual([ups[0].entradas.de, ups[0].entradas.para], ['Gerencia', 'Gerência'], 'de/para');
});

await teste('renomear pessoa alcanca o almoxarifado quando ele existe', async () => {
  respostas = [[{ n: 1 }], [{}], [{}], [{}]];   // 1a resposta: a tabela existe?
  await rota('POST', '/api/v1/config/renomear').handler(qs(), {
    tipo: 'pessoa', de: 'Ana', para: 'Ana Paula'
  }, ADMIN);
  const ups = consultas.filter(c => c.sql.startsWith('UPDATE'));
  igual(ups.length, 3, 'patrimonio + movimentacao + almoxarifado_mov');
  if(!ups[2].sql.includes('app.almoxarifado_mov SET usuario')) throw new Error('faltou o almoxarifado');
});

await teste('sem a migracao 05 a pessoa e renomeada so no patrimonio', async () => {
  respostas = [[{ n: 0 }], [{}], [{}]];
  await rota('POST', '/api/v1/config/renomear').handler(qs(), {
    tipo: 'pessoa', de: 'Ana', para: 'Ana Paula'
  }, ADMIN);
  igual(consultas.filter(c => c.sql.startsWith('UPDATE')).length, 2, 'so as duas tabelas do patrimonio');
});

await teste('renomear recusa tipo desconhecido, nome vazio e nao mexe no igual', async () => {
  await lanca(() => rota('POST', '/api/v1/config/renomear').handler(qs(), {
    tipo: 'categoria', de: 'a', para: 'b'
  }, ADMIN), 'local ou pessoa');
  await lanca(() => rota('POST', '/api/v1/config/renomear').handler(qs(), {
    tipo: 'local', de: '  ', para: 'TI'
  }, ADMIN), 'informe o nome atual e o novo');
  const r = await rota('POST', '/api/v1/config/renomear').handler(qs(), {
    tipo: 'local', de: 'TI', para: 'TI'
  }, ADMIN);
  igual(r.alterados, 0, 'nada a fazer');
  igual(consultas.length, 0, 'consultas disparadas');
});

console.log('\n— ALMOXARIFADO —');

// Configuracao e itens existentes que a conferencia da importacao le primeiro.
const CFG_ALMOX = [{ cats_almox: '[{"id":"a1","name":"Bobina","color":"#2563eb"}]' }];
const linhaAlmox = (linha, item) => ({ linha, item, categoria: 'bobina', modelo: '80mm',
  serie: 'S' + item, quantidade: '10', validade: '2027-03-31' });
// A conferencia da importacao le, nesta ordem: config, itens existentes e os
// modelos de patrimonio (para o "Usado em").
const MODELOS_PAT = [{ modelo: 'Epson M105' }];

await teste('listar monta saldo, lotes e validade mais proxima', async () => {
  respostas = [
    [{ n: 1 }],   // conferencia "a coluna usado_em existe?" (migracao 06)
    [{ id: 1, item: 'Bobina 80mm', categoria: 'a1', modelo: '80mm', serie: null, obs: null,
       usado_em: '["Epson M105"]' }],
    [{ id: 10, almox_id: 1, tipo: 'entrada', data_mov: '2026-01-10', validade: '2027-06-30',
       quantidade: '10', lote_id: null, usuario: null, obs_mov: null, criado_em: new Date('2026-01-10') },
     { id: 11, almox_id: 1, tipo: 'entrada', data_mov: '2026-02-10', validade: '2026-12-31',
       quantidade: '5', lote_id: null, usuario: null, obs_mov: null, criado_em: new Date('2026-02-10') },
     { id: 12, almox_id: 1, tipo: 'saida', data_mov: '2026-03-01', validade: null,
       quantidade: '4', lote_id: 10, usuario: 'Ana', obs_mov: null, criado_em: new Date('2026-03-01') }]
  ];
  const r = await rota('GET', '/api/v1/almoxarifado').handler(qs(), null, ADMIN);
  igual(r[0].saldo, 11, 'saldo do item (10 + 5 - 4)');
  igual(r[0].lotes.map(l => l.saldo), [6, 5], 'saldo de cada lote');
  igual(r[0].validadeProxima, '2026-12-31', 'lote que vence primeiro');
  igual(r[0].historico.length, 3, 'historico completo');
  igual(r[0].usadoEm, ['Epson M105'], 'modelos vinculados');
});

await teste('criar item abre transacao e ja grava a primeira entrada', async () => {
  respostas = [[{ id: 7 }], [{ id: 70 }]];
  const r = await rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: { item: ' Toner HP 26A ', categoria: 'a1', modelo: 'CF226A', serie: 'SN9', obs: 'caixa lacrada' },
    mov:  { quantidade: '3', validade: '2027-01-31', usuario: 'Ana' }
  }, ADMIN);
  igual(r.id, 7, 'id devolvido');
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado ('));
  igual(ins.entradas.item, 'Toner HP 26A', 'nome sem espacos');
  const mov = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado_mov'));
  igual([mov.entradas.tipo, mov.entradas.qtd, mov.entradas.val], ['entrada', 3, '2027-01-31'], 'lote de entrada');
});

const ITEM_OK = { item: 'Etiqueta 40x25', categoria: 'a1', modelo: 'rolo 1000un', serie: 'SN-ET-1' };

await teste('criar exige item, categoria, modelo e serie', async () => {
  await lanca(() => rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: { item: 'Etiqueta' }, mov: { quantidade: '5' }
  }, ADMIN), 'preencha Categoria, Modelo, N° de Série');
  igual(consultas.length, 0, 'consultas disparadas');
});

await teste('criar sem quantidade e recusado antes de tocar no banco', async () => {
  await lanca(() => rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: ITEM_OK, mov: {}
  }, ADMIN), 'informe a quantidade');
  igual(consultas.length, 0, 'consultas disparadas');
});

await teste('usado em: modelo que nao existe no patrimonio e recusado', async () => {
  respostas = [[{ modelo: 'Epson M105' }]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: Object.assign({}, ITEM_OK, { usadoEm: ['Epson M105', 'Impressora Inventada'] }),
    mov: { quantidade: '5' }
  }, ADMIN), 'modelo nao encontrado no patrimonio: Impressora Inventada');
  if (consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('gravou mesmo assim');
});

await teste('usado em: modelo cadastrado e gravado como lista, sem repetidos', async () => {
  respostas = [[{ modelo: 'Epson M105' }], [{ id: 9 }], [{ id: 90 }]];
  await rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: Object.assign({}, ITEM_OK, { usadoEm: ['Epson M105', 'epson m105 '] }),
    mov: { quantidade: '5' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado ('));
  igual(JSON.parse(ins.entradas.usado), ['Epson M105'], 'lista gravada');
  if (!ins.sql.includes('usado_em')) throw new Error('coluna usado_em fora do INSERT');
});

await teste('usado em: vinculo antigo continua valendo se o modelo sumiu do patrimonio', async () => {
  respostas = [[{ item: 'Bobina', categoria: 'a1', modelo: '80mm', serie: 'S1', obs: null,
                  usado_em: '["Epson M105"]' }],
               [{ modelo: 'Dell Vostro' }], [], []];
  const r = await rota('POST', '/api/v1/almoxarifado/atualizar').handler(qs(), {
    id: 1, item: Object.assign({}, ITEM_OK, { usadoEm: ['Epson M105'] })
  }, ADMIN);
  igual(r.ok, true, 'edicao passou');
});

await teste('item repetido e serie repetida viram frases diferentes', async () => {
  const dupItem = new Error("Violation of UNIQUE KEY constraint 'ux_almox_item'"); dupItem.number = 2601;
  respostas = [dupItem];
  await lanca(() => rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: Object.assign({}, ITEM_OK, { item: 'Bobina 80mm' }), mov: { quantidade: '1' }
  }, ADMIN), 'ja existe um item de almoxarifado chamado "Bobina 80mm"');

  const dupSerie = new Error("Violation of UNIQUE KEY constraint 'ux_almox_serie'"); dupSerie.number = 2601;
  respostas = [dupSerie];
  await lanca(() => rota('POST', '/api/v1/almoxarifado').handler(qs(), {
    item: Object.assign({}, ITEM_OK, { item: 'Outro', serie: 'SN1' }), mov: { quantidade: '1' }
  }, ADMIN), 'numero de serie "SN1"');
});

await teste('saida abate do lote escolhido', async () => {
  respostas = [[{ item: 'Bobina 80mm' }], [{ existe: 1, entrada: '10', saidas: '4' }], [{ id: 99 }], []];
  await rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'saida', quantidade: '6', loteId: 10, usuario: 'Ana' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado_mov'));
  igual([ins.entradas.tipo, ins.entradas.qtd, ins.entradas.lote], ['saida', 6, 10], 'saida no lote 10');
  igual(ins.entradas.val, null, 'saida nao carrega validade');
});

await teste('saida maior que o lote e recusada dizendo quanto tem', async () => {
  respostas = [[{ item: 'Bobina 80mm' }], [{ existe: 1, entrada: '10', saidas: '4' }]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'saida', quantidade: '7', loteId: 10 }
  }, ADMIN), 'apenas 6 em estoque');
  if(consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('gravou a saida mesmo assim');
});

await teste('saida sem lote e saida em lote de outro item sao recusadas', async () => {
  respostas = [[{ item: 'Bobina' }]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'saida', quantidade: '1' }
  }, ADMIN), 'escolha de qual lote');

  respostas = [[{ item: 'Bobina' }], [{ existe: 0, entrada: '0', saidas: '0' }]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'saida', quantidade: '1', loteId: 555 }
  }, ADMIN), 'lote nao encontrado');
});

await teste('entrada com lote soma nele em vez de abrir outro', async () => {
  respostas = [[{ item: 'Bobina 80mm' }], [{ existe: 1, entrada: '10', saidas: '4' }], [{ id: 98 }], []];
  await rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'entrada', quantidade: '5', loteId: 10, validade: '2030-01-01' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado_mov'));
  igual([ins.entradas.tipo, ins.entradas.qtd, ins.entradas.lote], ['entrada', 5, 10], 'entrada somada no lote 10');
  // A validade e do lote: a linha nova nao repete, senao as duas divergiriam.
  igual(ins.entradas.val, null, 'entrada somada nao carrega validade propria');

  respostas = [[{ item: 'Bobina' }], [{ existe: 0, entrada: '0', saidas: '0' }]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'entrada', quantidade: '1', loteId: 555 }
  }, ADMIN), 'lote nao encontrado');
});

await teste('listar: entrada somada engorda o lote, nao cria outro', async () => {
  // A conferencia da coluna usado_em ja rodou antes: o resultado fica em cache.
  respostas = [
    [{ id: 1, item: 'Etiqueta', categoria: 'a1', modelo: '80mm', serie: null, obs: null, usado_em: null }],
    [{ id: 10, almox_id: 1, tipo: 'entrada', data_mov: '2026-01-10', validade: '2026-12-31',
       quantidade: '10', lote_id: null, usuario: null, obs_mov: null, criado_em: new Date('2026-01-10') },
     { id: 11, almox_id: 1, tipo: 'entrada', data_mov: '2026-02-10', validade: null,
       quantidade: '4', lote_id: 10, usuario: null, obs_mov: null, criado_em: new Date('2026-02-10') },
     { id: 12, almox_id: 1, tipo: 'saida', data_mov: '2026-03-01', validade: null,
       quantidade: '6', lote_id: 10, usuario: 'Ana', obs_mov: null, criado_em: new Date('2026-03-01') }]
  ];
  const r = await rota('GET', '/api/v1/almoxarifado').handler(qs(), null, ADMIN);
  igual(r[0].lotes.length, 1, 'um lote so');
  igual([r[0].lotes[0].quantidade, r[0].lotes[0].saldo], [14, 8], 'entrou 14, resta 8');
  igual(r[0].lotes[0].validade, '2026-12-31', 'validade continua a do lote');
  igual(r[0].saldo, 8, 'saldo do item');
});

await teste('corrigir lote grava so o cadastro dele, nunca a quantidade', async () => {
  respostas = [[{ data_mov: '2026-01-10', validade: '2026-12-31', usuario: 'Ana',
                  obs_mov: 'NF 1', item: 'Etiqueta' }], [], []];
  await rota('POST', '/api/v1/almoxarifado/lotes').handler(qs(), {
    almoxId: 1, loteId: 10,
    dados: { validade: '2027-06-30', data_mov: '2026-01-11', usuario: 'Bia',
             obs_mov: 'NF 2', quantidade: '999' }
  }, ADMIN);
  const upd = consultas.find(c => c.sql.startsWith('UPDATE app.almoxarifado_mov'));
  igual([upd.entradas.val, upd.entradas.data, upd.entradas.usu, upd.entradas.obs],
        ['2027-06-30', '2026-01-11', 'Bia', 'NF 2'], 'campos corrigidos');
  if(upd.sql.includes('quantidade')) throw new Error('nao pode mexer na quantidade');
  // So a entrada que ABRIU o lote: a que somou nele depois nao tem validade propria.
  if(!upd.sql.includes('lote_id IS NULL')) throw new Error('faltou travar no lote de origem');
});

await teste('corrigir lote inexistente ou de outro item e recusado', async () => {
  respostas = [[]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado/lotes').handler(qs(), {
    almoxId: 1, loteId: 555, dados: { validade: '2027-01-01' }
  }, ADMIN), 'lote nao encontrado');
  if(consultas.some(c => c.sql.startsWith('UPDATE'))) throw new Error('atualizou mesmo assim');
});

await teste('quantidade zero, negativa ou com virgula', async () => {
  respostas = [[{ item: 'Bobina' }]];
  await lanca(() => rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'entrada', quantidade: '0' }
  }, ADMIN), 'quantidade maior que zero');

  respostas = [[{ item: 'Bobina' }], [{ id: 5 }], []];
  await rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'entrada', quantidade: '2,5' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado_mov'));
  igual(ins.entradas.qtd, 2.5, 'virgula decimal do Excel');
});

await teste('entrada sem data usa a data de hoje', async () => {
  respostas = [[{ item: 'Bobina' }], [{ id: 6 }], []];
  await rota('POST', '/api/v1/almoxarifado/movimentacoes').handler(qs(), {
    almoxId: 1, mov: { tipo: 'entrada', quantidade: '1' }
  }, ADMIN);
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado_mov'));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(ins.entradas.data)) throw new Error('data vazia: ' + ins.entradas.data);
});

await teste('importar: planilha certa grava item + lote numa transacao', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT, [{ id: 1 }], [{ id: 11 }], [{ id: 2 }], [{ id: 22 }], []];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [linhaAlmox(2, 'Bobina 80mm'), linhaAlmox(3, 'Bobina 57mm')]
  }, ADMIN);
  igual([r.gravado, r.sucesso], [true, 2], 'gravou os dois');
  igual(consultas.filter(c => c.sql.startsWith('INSERT INTO app.almoxarifado_mov')).length, 2, 'um lote por item');
});

await teste('importar: erro em uma linha nao grava nada', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [linhaAlmox(2, 'Bobina 80mm'), Object.assign(linhaAlmox(3, 'X'), { quantidade: '0' })]
  }, ADMIN);
  igual([r.gravado, r.erros.length, r.erros[0].campo], [false, 1, 'Quantidade'], 'erro de quantidade');
  if(consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('gravou mesmo com erro');
});

await teste('importar: item repetido manda registrar entrada no que existe', async () => {
  respostas = [CFG_ALMOX, [{ item: 'Bobina 80mm', serie: null }], MODELOS_PAT];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [linhaAlmox(2, 'Bobina 80mm')]
  }, ADMIN);
  if(!r.erros[0].correcao.includes('entrada')) throw new Error('correcao nao orienta: ' + r.erros[0].correcao);
});

await teste('importar: validade invalida e categoria inexistente sao explicadas', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [Object.assign(linhaAlmox(2, 'Item A'), { validade: '31/03/2027', categoria: 'Papel' })]
  }, ADMIN);
  igual(r.erros.map(e => e.campo).sort(), ['Categoria', 'Validade'], 'campos');
  if(!r.erros.find(e => e.campo === 'Categoria').correcao.includes('Bobina')) throw new Error('nao listou as categorias validas');
});

await teste('importar: modelo e serie vazios na planilha viram erro', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [Object.assign(linhaAlmox(2, 'Item A'), { modelo: '', serie: '' })]
  }, ADMIN);
  igual(r.erros.map(e => e.campo), ['Modelo', 'N° Série'], 'campos cobrados');
});

await teste('importar: "Usado em" aceita varios modelos separados por |', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT, [{ id: 1 }], [{ id: 11 }], []];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [Object.assign(linhaAlmox(2, 'Tinta 664'), { usado_em: 'Epson M105 | Epson M105' })]
  }, ADMIN);
  igual(r.gravado, true, 'gravou');
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.almoxarifado ('));
  igual(JSON.parse(ins.entradas.usado), ['Epson M105'], 'modelo da planilha, sem repetir');
});

await teste('importar: "Usado em" com modelo inexistente explica o que fazer', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [Object.assign(linhaAlmox(2, 'Tinta 664'), { usado_em: 'Impressora Inventada' })]
  }, ADMIN);
  igual(r.erros[0].campo, 'Usado em', 'campo');
  if (!r.erros[0].correcao.includes('Modelo')) throw new Error('correcao vaga: ' + r.erros[0].correcao);
});

await teste('importar: simular nao grava', async () => {
  respostas = [CFG_ALMOX, [], MODELOS_PAT];
  const r = await rota('POST', '/api/v1/almoxarifado/importar').handler(qs(), {
    rows: [linhaAlmox(2, 'Item A')], simular: true
  }, ADMIN);
  igual([r.gravado, r.erros.length], [false, 0], 'conferido sem gravar');
  if(consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('simulacao gravou');
});

await teste('excluir item leva o historico junto (cascade)', async () => {
  respostas = [[{ item: 'Bobina 80mm', categoria: 'a1', modelo: null, serie: null, obs: null }], []];
  const r = await rota('POST', '/api/v1/almoxarifado/excluir').handler(qs(), { id: 1 }, ADMIN);
  igual(r.ok, true, 'excluiu');
  if(!consultas.some(c => c.sql.startsWith('DELETE FROM app.almoxarifado'))) throw new Error('nao apagou');
});

await teste('rotas do almoxarifado exigem as mesmas permissoes do patrimonio', async () => {
  const perm = (m, p) => rota(m, p).permissao;
  igual(perm('POST', '/api/v1/almoxarifado'), 'cadastrar', 'criar');
  igual(perm('POST', '/api/v1/almoxarifado/atualizar'), 'editar', 'atualizar');
  igual(perm('POST', '/api/v1/almoxarifado/movimentacoes'), 'movimentar', 'movimentar');
  igual(perm('POST', '/api/v1/almoxarifado/excluir'), 'excluir', 'excluir');
  igual(perm('POST', '/api/v1/almoxarifado/importar'), 'cadastrar', 'importar');
});

console.log('\n— CONFIG —');

await teste('config devolve listas mesmo com JSON corrompido', async () => {
  // A 1a resposta e da conferencia "a coluna cats_almox existe?" (migracao 05).
  respostas = [[{ n: 1 }],
               [{ cats: '[{"id":"c1"}]', cats_almox: 'quebrado', pessoas: null, locais: 'nao e json',
                  status_opts: '[]', vinculos: null }]];
  const r = await rota('GET', '/api/v1/config').handler(qs(), null, ADMIN);
  igual(r.cats.length, 1, 'cats');
  igual(r.catsAlmox, [], 'categorias do almoxarifado corrompidas');
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

await teste('config recusa cor que nao e #hex (CSS injetado)', async () => {
  respostas = [[], []];
  await rota('POST', '/api/v1/config').handler(qs(), {
    cats: [{ id: 'c1', name: 'Notebook', color: 'red;background:url(//x)', extra: 'fora' }],
    statusOpts: [{ id: 's1', name: 'Em uso', color: '#059669' }],
    pessoas: [], locais: ['TI'], vinculos: null
  }, ADMIN);
  const e = consultas[0].entradas;
  igual(JSON.parse(e.cats), [{ id: 'c1', name: 'Notebook', color: '#888888' }], 'cor trocada e campo extra fora');
  igual(JSON.parse(e.status)[0].color, '#059669', 'cor valida mantida');
});

console.log('\n— USUARIOS —');

await teste('criar usuario normaliza o login e guarda a senha em hash', async () => {
  respostas = [[{ id: 5 }], []];
  const r = await rota('POST', '/api/v1/usuarios').handler(qs(),
    { login: '  Fulano.Tal ', papel: 'editor', senha: '1234' }, ADMIN);
  igual(r.login, 'fulano.tal', 'login normalizado');
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

await teste('excluir usuario apaga a linha e guarda o antes', async () => {
  respostas = [[{ id: 4, login: 'bia', nome: 'Bia', papel: 'leitor', ativo: 1 }], [], []];
  const r = await rota('POST', '/api/v1/usuarios/excluir').handler(qs(), { id: 4 }, ADMIN);
  igual(r.ok, true, 'resultado');
  const del = consultas.find(c => c.sql.startsWith('DELETE FROM app.usuario'));
  if(!del) throw new Error('nao apagou');
  const aud = consultas.find(c => c.sql.startsWith('INSERT INTO app.auditoria'));
  if(!aud.entradas.antes.includes('bia')) throw new Error('auditoria sem o antes');
});

await teste('ninguem exclui a propria conta', async () => {
  respostas = [[{ id: 1, login: 'admin', nome: 'A', papel: 'admin', ativo: 1 }]];
  await lanca(() => rota('POST', '/api/v1/usuarios/excluir').handler(qs(), { id: 1 }, ADMIN),
              'nao pode excluir a propria conta');
});

await teste('o unico admin ativo nao pode ser excluido', async () => {
  respostas = [[{ id: 2, login: 'outro', nome: 'O', papel: 'admin', ativo: 1 }], [{ n: 0 }]];
  await lanca(() => rota('POST', '/api/v1/usuarios/excluir').handler(qs(), { id: 2 }, ADMIN),
              'unico administrador ativo');
});

await teste('excluir usuario inexistente avisa', async () => {
  respostas = [[]];
  await lanca(() => rota('POST', '/api/v1/usuarios/excluir').handler(qs(), { id: 99 }, ADMIN),
              'usuario nao encontrado');
});

console.log('\n— LOGIN / SENHA —');

await teste('sessao usa o papel ATUAL do banco, nao o do token', async () => {
  invalidarCacheAtivos();
  respostas = [[{ login: 'Chefe', papel: 'leitor' }]];
  const u = { login: 'chefe', papel: 'admin' };          // token antigo dizia admin
  igual(await sessaoValida(u), true, 'sessao valida');
  igual(u.papel, 'leitor', 'rebaixado vale na hora');
});

await teste('sessao de usuario desativado ou excluido cai', async () => {
  invalidarCacheAtivos();
  respostas = [[{ login: 'outro', papel: 'admin' }]];
  igual(await sessaoValida({ login: 'chefe', papel: 'admin' }), false, 'fora da lista');
});

await teste('alterar papel zera o cache de sessoes', async () => {
  invalidarCacheAtivos();
  respostas = [[{ login: 'bia', papel: 'editor' }]];
  await sessaoValida({ login: 'bia', papel: 'editor' });            // enche o cache
  respostas = [[{ id: 4, login: 'bia', nome: 'Bia', papel: 'editor', ativo: 1 }], [], []];
  await rota('POST', '/api/v1/usuarios/atualizar').handler(qs(), { id: 4, nome: 'Bia', papel: 'leitor' }, ADMIN);
  respostas = [[{ login: 'bia', papel: 'leitor' }]];
  const u = { login: 'bia', papel: 'editor' };
  await sessaoValida(u);
  igual(u.papel, 'leitor', 'papel novo sem esperar 30s');
});

await teste('login certo devolve token e papel', async () => {
  const hash = auth.hashSenha('SenhaDeTeste1');
  respostas = [[{ usuario_id: 1, login: 'admin', senha_hash: hash, nome: 'Adm', papel: 'admin', ativo: true }]];
  const r = await rota('POST', '/api/v1/login').handler(qs(), { login: 'admin', senha: 'SenhaDeTeste1' }, null, { ip: '1.1.1.1' });
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

console.log('\n— DESCARTADOS —');

// A 1a resposta de cada teste e a conferencia "a tabela existe?" (migracao 07),
// que fica em cache depois da primeira vez.
await teste('listar descartados devolve o formato que a tela espera', async () => {
  respostas = [[{ n: 1 }],
    [{ id: 1, patrimonio: '50562', nome: 'Dell', modelo: 'Optiplex', serie: 'SN1',
       categoria: 'c1', data_descarte: '2024-03-15', motivo: 'Sucata', criado_em: new Date() },
     { id: 2, patrimonio: '50563', nome: null, modelo: null, serie: null,
       categoria: null, data_descarte: null, motivo: null, criado_em: new Date() }]];
  const r = await rota('GET', '/api/v1/descartados').handler(qs(), null, ADMIN);
  igual(r.length, 2, 'qtd');
  igual(r[0].categoria, ['c1'], 'categoria vira array');
  igual([r[1].nome, r[1].motivo, r[1].data_descarte], ['', '', ''], 'null vira texto vazio');
});

await teste('criar descartado grava e traduz numero repetido', async () => {
  respostas = [[{ id: 9 }]];
  const r = await rota('POST', '/api/v1/descartados').handler(qs(), {
    item: { patrimonio: ' 50562 ', nome: 'Dell', categoria: ['c1'],
            data_descarte: '2024-03-15', motivo: 'Sucata' }
  }, ADMIN);
  igual(r.id, 9, 'id devolvido');
  const ins = consultas.find(c => c.sql.startsWith('INSERT INTO app.patrimonio_descartado'));
  igual([ins.entradas.patrimonio, ins.entradas.data, ins.entradas.motivo],
        ['50562', '2024-03-15', 'Sucata'], 'campos gravados');

  const dup = new Error('Violation of UNIQUE KEY constraint'); dup.number = 2601;
  respostas = [dup];
  await lanca(() => rota('POST', '/api/v1/descartados').handler(qs(), {
    item: { patrimonio: '50562' }
  }, ADMIN), 'ja existe um descartado com o numero "50562"');
});

await teste('descartado sem numero e recusado antes do banco', async () => {
  await lanca(() => rota('POST', '/api/v1/descartados').handler(qs(), { item: {} }, ADMIN),
              'informe o numero do patrimonio');
  igual(consultas.length, 0, 'consultas disparadas');
});

await teste('importar descartados: confere tudo antes e nao grava com erro', async () => {
  // Conferencia: o que ja existe no banco + as linhas repetidas na planilha.
  respostas = [[{ patrimonio: '50562' }]];
  const r = await rota('POST', '/api/v1/descartados/importar').handler(qs(), {
    rows: [{ linha: 2, patrimonio: '50562' },
           { linha: 3, patrimonio: '50570', data_descarte: '15/03/2024' },
           { linha: 4, patrimonio: '' },
           { linha: 5, patrimonio: '50570' }]
  }, ADMIN);
  igual(r.gravado, false, 'nao gravou');
  const campos = r.erros.map(e => e.linha + ':' + e.campo);
  igual(campos, ['2:Nº Patrimônio', '3:Data do Descarte', '4:Nº Patrimônio', '5:Nº Patrimônio'], 'erros por linha');
  if(consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('gravou mesmo com erro');
});

await teste('importar descartados sem erro grava tudo numa transacao', async () => {
  respostas = [[], [], []];
  const r = await rota('POST', '/api/v1/descartados/importar').handler(qs(), {
    rows: [{ linha: 2, patrimonio: '50562', nome: 'Dell' },
           { linha: 3, patrimonio: '50563', motivo: 'Doado' }]
  }, ADMIN);
  igual(r.gravado, true, 'gravou');
  igual(consultas.filter(c => c.sql.startsWith('INSERT INTO app.patrimonio_descartado')).length, 2, 'um insert por linha');
});

await teste('simular importacao nunca grava', async () => {
  respostas = [[]];
  const r = await rota('POST', '/api/v1/descartados/importar').handler(qs(), {
    rows: [{ linha: 2, patrimonio: '50599' }], simular: true
  }, ADMIN);
  igual([r.gravado, r.erros.length], [false, 0], 'conferiu sem erro e sem gravar');
  if(consultas.some(c => c.sql.startsWith('INSERT'))) throw new Error('gravou na simulacao');
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
