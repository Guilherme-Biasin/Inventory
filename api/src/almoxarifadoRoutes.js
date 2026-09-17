// Almoxarifado — material de consumo (bobina, etiqueta, toner, tinta...).
//
// DIFERENCA PARA O PATRIMONIO: aqui o que importa e QUANTIDADE, e ela vem em
// LOTES. Cada ENTRADA e um lote, com a sua validade; cada SAIDA diz de qual
// lote saiu (quem registra escolhe na tela). Por isso:
//
//   saldo do lote = quantidade da entrada - saidas apontando para ela
//   saldo do item = soma do saldo dos lotes
//
// O saldo nunca e gravado em coluna: e sempre somado das movimentacoes. Guardar
// o total em campo seria manter duas versoes da verdade, e a segunda envelhece
// no primeiro erro (uma saida que falhou no meio, um acerto feito no banco).

const { conexao, tipos } = require('./db');
const { auditar } = require('./auditoria');

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function txt(v, max){
  if(v == null) return null;
  const s = String(v).trim();
  if(!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

function dataISO(v){
  const s = txt(v);
  if(!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Data de hoje no relogio do servidor, como AAAA-MM-DD.
function hojeISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Quantidade digitada na tela ou vinda de planilha. Aceita virgula decimal
// ("2,5"), porque e assim que o Excel em portugues entrega. Devolve null quando
// nao e um numero positivo — quem chama decide a mensagem.
function qtd(v){
  if(v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if(!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;   // 2 casas, como a coluna DECIMAL(12,2)
}

function jsonLista(v){ try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch(e){ return []; } }

// A coluna usado_em vem da migracao 06. A API pode subir antes de ela ser
// rodada: neste caso o almoxarifado funciona inteiro, so sem o vinculo com os
// modelos de patrimonio — melhor do que a aba parar de abrir.
let _temUsadoEm = null;
async function temUsadoEm(p){
  if(_temUsadoEm !== null) return _temUsadoEm;
  try {
    const r = await p.request().query(`SELECT COUNT(*) AS n FROM sys.columns
      WHERE object_id = OBJECT_ID('app.almoxarifado') AND name = 'usado_em'`);
    _temUsadoEm = r.recordset[0].n === 1;
  } catch(e){ _temUsadoEm = false; }
  return _temUsadoEm;
}

// Campos que o cadastro exige. Item e serie tambem sao chave unica; categoria e
// modelo entraram na lista a pedido do gerente — sem eles o material nao se
// distingue de outro parecido na hora de pedir reposicao.
const OBRIGATORIOS = [
  { chave: 'item',      nome: 'Item' },
  { chave: 'categoria', nome: 'Categoria' },
  { chave: 'modelo',    nome: 'Modelo' },
  { chave: 'serie',     nome: 'N° de Série' }
];

function exigirCampos(item){
  const falta = OBRIGATORIOS.filter(c => !txt(item[c.chave]));
  if(falta.length){
    throw new Error(`preencha ${falta.map(c => c.nome).join(', ')}`);
  }
}

// "Usado em": modelos de PATRIMONIO em que este material e usado. A tela so
// deixa escolher da lista, e o servidor confere de novo — quem chama a API
// direto nao inventa modelo que nao existe, senao o vinculo nao serviria para
// achar nada.
//
// O que ja estava gravado passa mesmo que o modelo tenha sumido do patrimonio
// (o ultimo equipamento daquele modelo foi excluido): recusar ali travaria
// qualquer edicao do item por causa de um vinculo antigo.
// Devolve um mapa "modelo em minusculas" -> "modelo como esta cadastrado".
// Guardar a grafia do patrimonio, e nao a que veio da chamada, evita o mesmo
// modelo aparecer como "Epson M105" num item e "epson m105" em outro — a lista
// de vinculos so serve se der para agrupar por ela.
async function modelosValidos(p, jaGravados){
  const r = await p.request()
    .query("SELECT DISTINCT modelo FROM app.patrimonio WHERE modelo IS NOT NULL AND LTRIM(RTRIM(modelo)) <> ''");
  const mapa = new Map(r.recordset.map(x => {
    const m = String(x.modelo).trim();
    return [m.toLowerCase(), m];
  }));
  (jaGravados || []).forEach(m => {
    const s = String(m).trim();
    if(s && !mapa.has(s.toLowerCase())) mapa.set(s.toLowerCase(), s);
  });
  return mapa;
}

async function limparUsadoEm(p, valor, jaGravados){
  if(valor == null) return null;
  if(!Array.isArray(valor)) throw new Error('"usado em" precisa ser uma lista de modelos');
  const limpos = valor.map(v => txt(v, 120)).filter(Boolean);

  // Sem a migracao 06 a coluna nao existe: cadastro sem vinculo continua
  // passando, e so quem escolheu um modelo recebe o aviso do que falta.
  if(!(await temUsadoEm(p))){
    if(!limpos.length) return null;
    throw Object.assign(new Error('o campo "usado em" ainda nao foi instalado neste banco — rode api/sql/06_almox_usado_em.sql'), { status: 500 });
  }
  if(!limpos.length) return JSON.stringify([]);

  const validos = await modelosValidos(p, jaGravados);
  const desconhecidos = limpos.filter(m => !validos.has(m.toLowerCase()));
  if(desconhecidos.length){
    throw new Error(`modelo nao encontrado no patrimonio: ${desconhecidos.join(', ')} — escolha um modelo ja cadastrado`);
  }
  // Sem repetidos, na ordem em que foram escolhidos e com a grafia do cadastro.
  const vistos = new Set();
  const finais = [];
  limpos.forEach(m => {
    const k = m.toLowerCase();
    if(vistos.has(k)) return;
    vistos.add(k);
    finais.push(validos.get(k));
  });
  return JSON.stringify(finais);
}

// Violacao de indice unico vira frase que o usuario entende. As duas chaves
// unicas do almoxarifado sao o item e o numero de serie.
function traduzirErro(e, item, serie){
  if(e && (e.number === 2601 || e.number === 2627)){
    const msg = String(e.message || '');
    if(msg.includes('ux_almox_serie')) return new Error(`ja existe um item com o numero de serie "${serie}"`);
    return new Error(`ja existe um item de almoxarifado chamado "${item}"`);
  }
  return e;
}

// Monta lotes e saldo de UM item a partir das movimentacoes dele.
// As saidas sem lote_id (nao deveriam existir) ainda assim abatem o saldo do
// item: e melhor um saldo certo com um lote desconhecido do que um saldo que
// ignora material que ja saiu.
function resumir(movs){
  const lotes = [];
  const porId = new Map();
  let saldo = 0;

  for(const m of movs){
    if(m.tipo === 'entrada'){
      const lote = {
        id: m.id, data_mov: m.data_mov, validade: m.validade,
        quantidade: m.quantidade, saldo: m.quantidade,
        usuario: m.usuario, obs_mov: m.obs_mov, criado_em: m.criado_em
      };
      lotes.push(lote);
      porId.set(m.id, lote);
      saldo += m.quantidade;
    } else {
      saldo -= m.quantidade;
      const lote = porId.get(m.lote_id);
      if(lote) lote.saldo = Math.round((lote.saldo - m.quantidade) * 100) / 100;
    }
  }

  // Vence primeiro na frente, e lote sem validade por ultimo — e nessa ordem
  // que a tela mostra e que se decide o que usar antes.
  const comSaldo = lotes.filter(l => l.saldo > 0);
  comSaldo.sort((a, b) => (a.validade || '9999-12-31').localeCompare(b.validade || '9999-12-31'));

  return {
    saldo: Math.round(saldo * 100) / 100,
    lotes,
    validadeProxima: (comSaldo.find(l => l.validade) || {}).validade || null
  };
}

// ------------------------------------------------------------
// GET /api/v1/almoxarifado — lista com lotes e historico
// ------------------------------------------------------------
async function listar(){
  const p = await conexao();
  const usado = await temUsadoEm(p);
  const [itens, movs] = await Promise.all([
    p.request().query(`
      SELECT id, item, categoria, modelo, serie, obs,
             ${usado ? 'usado_em' : 'NULL AS usado_em'}
      FROM app.almoxarifado ORDER BY item`),
    p.request().query(`
      SELECT id, almox_id, tipo, CONVERT(varchar(10), data_mov, 23) AS data_mov,
             CONVERT(varchar(10), validade, 23) AS validade,
             quantidade, lote_id, usuario, obs_mov, criado_em
      FROM app.almoxarifado_mov ORDER BY almox_id, criado_em, id`)
  ]);

  const porItem = new Map();
  for(const m of movs.recordset){
    const arr = porItem.get(m.almox_id) || [];
    arr.push({
      id: m.id, tipo: m.tipo, data_mov: m.data_mov, validade: m.validade,
      // DECIMAL volta como string em alguns drivers; a tela soma e compara.
      quantidade: Number(m.quantidade), lote_id: m.lote_id,
      usuario: m.usuario, obs_mov: m.obs_mov, criado_em: m.criado_em
    });
    porItem.set(m.almox_id, arr);
  }

  return itens.recordset.map(r => {
    const historico = porItem.get(r.id) || [];
    const resumo = resumir(historico);
    return {
      id: r.id,
      item:      r.item,
      categoria: r.categoria || '',
      modelo:    r.modelo || '',
      serie:     r.serie || '',
      obs:       r.obs || '',
      usadoEm:   jsonLista(r.usado_em),
      saldo:     resumo.saldo,
      validadeProxima: resumo.validadeProxima,
      lotes:     resumo.lotes,
      historico
    };
  });
}

// ------------------------------------------------------------
// Saldo de um lote, dentro da transacao
// ------------------------------------------------------------
// UPDLOCK + HOLDLOCK: duas saidas do mesmo lote ao mesmo tempo poderiam ler o
// mesmo saldo e as duas passarem, deixando o lote negativo. Com o lock a
// segunda espera a primeira terminar e ve o saldo ja atualizado.
async function saldoDoLote(pedido, sql, almoxId, loteId){
  const r = await pedido()
    .input('lote', sql.Int, loteId)
    .input('item', sql.Int, almoxId)
    .query(`
      SELECT (SELECT quantidade FROM app.almoxarifado_mov WITH (UPDLOCK, HOLDLOCK)
               WHERE id = @lote AND almox_id = @item AND tipo = 'entrada') AS entrada,
             (SELECT ISNULL(SUM(quantidade), 0) FROM app.almoxarifado_mov WITH (UPDLOCK, HOLDLOCK)
               WHERE lote_id = @lote AND tipo = 'saida') AS saidas`);
  const l = r.recordset[0];
  if(l.entrada == null) return null;                      // lote de outro item, ou inexistente
  return Math.round((Number(l.entrada) - Number(l.saidas)) * 100) / 100;
}

// Insere uma movimentacao (entrada ou saida) validando o lote quando e saida.
async function inserirMov(pedido, sql, almoxId, mov, login){
  const m = mov || {};
  const tipo = String(m.tipo || '').toLowerCase() === 'saida' ? 'saida' : 'entrada';
  const quantidade = qtd(m.quantidade);
  if(quantidade == null) throw new Error('informe uma quantidade maior que zero');

  let loteId = null;
  if(tipo === 'saida'){
    loteId = parseInt(m.loteId, 10);
    if(!Number.isFinite(loteId)) throw new Error('escolha de qual lote sai o material');
    const saldo = await saldoDoLote(pedido, sql, almoxId, loteId);
    if(saldo == null) throw new Error('lote nao encontrado neste item');
    if(quantidade > saldo){
      throw new Error(`o lote escolhido tem apenas ${saldo} em estoque — ajuste a quantidade ou escolha outro lote`);
    }
  }

  const r = await pedido()
    .input('item',  sql.Int,            almoxId)
    .input('tipo',  sql.VarChar(10),    tipo)
    .input('data',  sql.VarChar(10),    dataISO(m.data_mov) || hojeISO())
    // Validade e do LOTE: numa saida ela nao existe (o lote ja tem a dele).
    .input('val',   sql.VarChar(10),    tipo === 'entrada' ? dataISO(m.validade) : null)
    .input('qtd',   sql.Decimal(12, 2), quantidade)
    .input('lote',  sql.Int,            loteId)
    .input('usu',   sql.VarChar(120),   txt(m.usuario, 120))
    .input('obs',   sql.NVarChar(1000), txt(m.obs_mov, 1000))
    .input('por',   sql.VarChar(50),    login || null)
    .query(`INSERT INTO app.almoxarifado_mov
              (almox_id, tipo, data_mov, validade, quantidade, lote_id, usuario, obs_mov, criado_por)
            OUTPUT INSERTED.id
            VALUES (@item, @tipo, @data, @val, @qtd, @lote, @usu, @obs, @por)`);

  return { id: r.recordset[0].id, tipo, quantidade };
}

// ------------------------------------------------------------
// POST /api/v1/almoxarifado — cria o item com a primeira entrada
// ------------------------------------------------------------
async function criar(q, body, usuario){
  const item = (body && body.item) || {};
  const mov  = (body && body.mov)  || {};
  exigirCampos(item);
  const nome = txt(item.item, 120);
  // Cadastrar sem quantidade criaria um item com saldo zero e sem lote — e o
  // primeiro "cade o estoque?" viria logo depois.
  if(qtd(mov.quantidade) == null) throw new Error('informe a quantidade que esta entrando');

  const p = await conexao(); const sql = tipos();
  const serie = txt(item.serie, 120);
  const usadoEm = await limparUsadoEm(p, item.usadoEm, []);
  const temUsado = await temUsadoEm(p);

  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  try {
    const ins = await pedido()
      .input('item',      sql.VarChar(120),   nome)
      .input('categoria', sql.VarChar(40),    txt(item.categoria, 40))
      .input('modelo',    sql.VarChar(120),   txt(item.modelo, 120))
      .input('serie',     sql.VarChar(120),   serie)
      .input('obs',       sql.NVarChar(1000), txt(item.obs, 1000))
      .input('usado',     sql.NVarChar(sql.MAX), usadoEm)
      .input('por',       sql.VarChar(50),    usuario.login)
      .query(`INSERT INTO app.almoxarifado (item, categoria, modelo, serie, obs${temUsado ? ', usado_em' : ''}, criado_por)
              OUTPUT INSERTED.id
              VALUES (@item, @categoria, @modelo, @serie, @obs${temUsado ? ', @usado' : ''}, @por)`);
    const id = ins.recordset[0].id;

    await inserirMov(pedido, sql, id, Object.assign({}, mov, { tipo: 'entrada' }), usuario.login);
    await tx.commit();

    await auditar(usuario, {
      tabela: 'almoxarifado', registroId: id, acao: 'INSERT',
      descricao: `Cadastrou o item de almoxarifado ${nome} com ${qtd(mov.quantidade)} de entrada`,
      depois: { item: nome, modelo: item.modelo, serie: item.serie, quantidade: qtd(mov.quantidade) }
    });
    return { id };
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    throw traduzirErro(e, nome, serie);
  }
}

// ------------------------------------------------------------
// POST /api/v1/almoxarifado/atualizar — dados fixos do item
// ------------------------------------------------------------
async function atualizar(q, body, usuario){
  const id   = parseInt(body && body.id, 10);
  const item = (body && body.item) || {};
  if(!Number.isFinite(id)) throw new Error('id do item invalido');
  exigirCampos(item);
  const nome = txt(item.item, 120);

  const p = await conexao(); const sql = tipos();
  const antesR = await p.request().input('id', sql.Int, id)
    .query(`SELECT item, categoria, modelo, serie, obs,
                   ${await temUsadoEm(p) ? 'usado_em' : 'NULL AS usado_em'}
            FROM app.almoxarifado WHERE id = @id`);
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('item nao encontrado');

  const serie = txt(item.serie, 120);
  const usadoEm = await limparUsadoEm(p, item.usadoEm, jsonLista(antes.usado_em));
  const temUsado = await temUsadoEm(p);
  try {
    await p.request()
      .input('id',        sql.Int,            id)
      .input('item',      sql.VarChar(120),   nome)
      .input('categoria', sql.VarChar(40),    txt(item.categoria, 40))
      .input('modelo',    sql.VarChar(120),   txt(item.modelo, 120))
      .input('serie',     sql.VarChar(120),   serie)
      .input('obs',       sql.NVarChar(1000), txt(item.obs, 1000))
      .input('usado',     sql.NVarChar(sql.MAX), usadoEm)
      .query(`UPDATE app.almoxarifado SET
                item = @item, categoria = @categoria, modelo = @modelo,
                serie = @serie, obs = @obs${temUsado ? ', usado_em = @usado' : ''}, atualizado_em = SYSDATETIME()
              WHERE id = @id`);
  } catch(e){ throw traduzirErro(e, nome, serie); }

  await auditar(usuario, {
    tabela: 'almoxarifado', registroId: id, acao: 'UPDATE',
    descricao: `Editou o item de almoxarifado ${nome}`,
    antes,
    depois: { item: nome, categoria: item.categoria, modelo: item.modelo, serie: item.serie }
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/almoxarifado/movimentacoes — entrada ou saida
// ------------------------------------------------------------
async function movimentar(q, body, usuario){
  const id  = parseInt(body && body.almoxId, 10);
  const mov = (body && body.mov) || {};
  if(!Number.isFinite(id)) throw new Error('id do item invalido');

  const p = await conexao(); const sql = tipos();
  const existe = await p.request().input('id', sql.Int, id)
    .query('SELECT item FROM app.almoxarifado WHERE id = @id');
  if(!existe.recordset[0]) throw new Error('item nao encontrado');
  const nome = existe.recordset[0].item;

  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  let registrada;
  try {
    registrada = await inserirMov(pedido, sql, id, mov, usuario.login);
    await pedido().input('id', sql.Int, id)
      .query('UPDATE app.almoxarifado SET atualizado_em = SYSDATETIME() WHERE id = @id');
    await tx.commit();
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    throw e;
  }

  await auditar(usuario, {
    tabela: 'almoxarifado_mov', registroId: id, acao: 'INSERT',
    descricao: `${registrada.tipo === 'saida' ? 'Saida' : 'Entrada'} de ${registrada.quantidade} ` +
               `no item ${nome}` + (txt(mov.usuario) ? ` (usuario: ${txt(mov.usuario)})` : ''),
    depois: mov
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/almoxarifado/excluir
// ------------------------------------------------------------
async function excluir(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id do item invalido');

  const p = await conexao(); const sql = tipos();
  const antesR = await p.request().input('id', sql.Int, id)
    .query('SELECT item, categoria, modelo, serie, obs FROM app.almoxarifado WHERE id = @id');
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('item nao encontrado');

  // O historico (lotes e saidas) vai junto por ON DELETE CASCADE — a tela avisa.
  await p.request().input('id', sql.Int, id).query('DELETE FROM app.almoxarifado WHERE id = @id');

  await auditar(usuario, {
    tabela: 'almoxarifado', registroId: id, acao: 'DELETE',
    descricao: `Excluiu o item de almoxarifado ${antes.item}`,
    antes
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/almoxarifado/importar — importacao em massa
// ------------------------------------------------------------
// Mesmas regras do patrimonio: confere a planilha inteira antes, devolve
// linha + motivo + como corrigir, e com um erro que seja NADA e gravado.
// { simular: true } so confere.
const MAX_IMPORT = 2000;

// Os mesmos obrigatorios da tela: a regra e uma so, em todo lugar.
const CAMPOS_IMPORT = [
  { chave: 'item',      nome: 'Item',       max: 120, obrigatorio: true },
  { chave: 'categoria', nome: 'Categoria',  max: 60,  obrigatorio: true },
  { chave: 'modelo',    nome: 'Modelo',     max: 120, obrigatorio: true },
  { chave: 'serie',     nome: 'N° Série',   max: 120, obrigatorio: true },
  { chave: 'obs',       nome: 'Observações', max: 1000 },
  { chave: 'usuario',   nome: 'Usuário',    max: 120 }
];

const chaveTexto = s => String(s || '').trim().toLowerCase();

async function conferirImportacao(p, rows){
  let cats = [];
  try {
    const cfgR = await p.request().query("SELECT cats_almox FROM app.config WHERE id = 'main'");
    cats = jsonLista((cfgR.recordset[0] || {}).cats_almox);
  } catch(e){
    // Banco sem a migracao 05: o motivo real precisa chegar na tela.
    const err = new Error('o almoxarifado ainda nao foi instalado neste banco — rode api/sql/05_almoxarifado.sql');
    err.status = 500; throw err;
  }
  const catPorNome = new Map(cats.map(c => [chaveTexto(c.name), c.id]));

  const exR = await p.request().query('SELECT item, serie FROM app.almoxarifado');
  const itensExistentes = new Set(exR.recordset.map(r => chaveTexto(r.item)));
  const seriesExistentes = new Set(exR.recordset.filter(r => r.serie).map(r => chaveTexto(r.serie)));

  // "Usado em" na planilha: modelos separados por | ou ;. Conferidos contra os
  // modelos de patrimonio, como na tela.
  const comUsadoEm = await temUsadoEm(p);
  const modelosPat = comUsadoEm ? await modelosValidos(p, []) : new Map();

  const erros = [];
  const linhas = [];
  const primeiroItem = new Map();
  const primeiraSerie = new Map();
  const lista = arr => arr.map(c => c.name).filter(Boolean).join(', ') || '(nenhuma cadastrada)';

  rows.forEach((bruta, i) => {
    const r = bruta || {};
    const linha = Number.isInteger(r.linha) ? r.linha : i + 2;   // linha 1 e o cabecalho
    const erro = (campo, motivo, correcao) => erros.push({ linha, campo, motivo, correcao });
    const v = {};

    CAMPOS_IMPORT.forEach(c => {
      const s = r[c.chave] == null ? '' : String(r[c.chave]).trim();
      v[c.chave] = s;
      if(!s && c.obrigatorio){
        erro(c.nome, `${c.nome} está vazio`, `Preencha a coluna "${c.nome}" nesta linha.`);
      } else if(s.length > c.max){
        erro(c.nome, `${c.nome} tem ${s.length} caracteres (máximo ${c.max})`,
             `Abrevie o texto da coluna "${c.nome}" para até ${c.max} caracteres.`);
      }
    });

    if(v.item){
      const k = chaveTexto(v.item);
      if(primeiroItem.has(k)){
        erro('Item', `o item "${v.item}" se repete — já aparece na linha ${primeiroItem.get(k)}`,
             'Cada item entra uma vez só. Se são compras diferentes do mesmo material, cadastre uma vez e registre a outra como nova entrada (lote).');
      } else {
        primeiroItem.set(k, linha);
        if(itensExistentes.has(k)){
          erro('Item', `o item "${v.item}" já está cadastrado`,
               'Apague a linha e registre uma entrada nova no item que já existe — assim o saldo soma em vez de duplicar.');
        }
      }
    }

    if(v.serie){
      const k = chaveTexto(v.serie);
      if(primeiraSerie.has(k)){
        erro('N° Série', `o número de série "${v.serie}" se repete — já aparece na linha ${primeiraSerie.get(k)}`,
             'Número de série não se repete. Corrija uma das duas linhas ou deixe a coluna vazia.');
      } else {
        primeiraSerie.set(k, linha);
        if(seriesExistentes.has(k)){
          erro('N° Série', `o número de série "${v.serie}" já está cadastrado`,
               'Use outro número de série ou deixe a coluna vazia.');
        }
      }
    }

    let catId = null;
    if(v.categoria){
      catId = catPorNome.get(chaveTexto(v.categoria));
      if(!catId) erro('Categoria', `a categoria "${v.categoria}" não existe`,
        `Use exatamente um destes nomes: ${lista(cats)} — ou cadastre a categoria em Personalizar › Categorias do almoxarifado antes de importar.`);
    }

    const quantidade = qtd(r.quantidade);
    if(quantidade == null){
      erro('Quantidade', r.quantidade ? `a quantidade "${r.quantidade}" não é um número maior que zero` : 'Quantidade está vazia',
           'Preencha a coluna "Quantidade" com um número maior que zero (ex.: 12).');
    }

    const validade = r.validade ? dataISO(r.validade) : null;
    if(r.validade && !validade){
      erro('Validade', `a validade "${r.validade}" não é uma data válida`,
           'Use o formato AAAA-MM-DD (ex.: 2027-03-31), ou deixe em branco se o material não vence.');
    }

    const data = r.data_mov ? dataISO(r.data_mov) : null;
    if(r.data_mov && !data){
      erro('Data', `a data "${r.data_mov}" não é válida`,
           'Use o formato AAAA-MM-DD, ou deixe em branco para usar a data de hoje.');
    }

    const usadoEm = String(r.usado_em == null ? '' : r.usado_em)
      .split(/[|;]/).map(x => x.trim()).filter(Boolean);
    const semModelo = comUsadoEm ? usadoEm.filter(m => !modelosPat.has(m.toLowerCase())) : [];
    if(semModelo.length){
      erro('Usado em', `modelo não cadastrado no patrimônio: ${semModelo.join(', ')}`,
           'Escreva exatamente o Modelo como está no cadastro do patrimônio, separando vários por "|". Ou deixe a coluna vazia.');
    }

    linhas.push({
      linha, item: v.item, categoria: catId, modelo: v.modelo, serie: v.serie || null,
      obs: v.obs, quantidade, validade, data_mov: data, usuario: v.usuario,
      // Grafia do cadastro, como na tela; repetido na mesma linha entra uma vez.
      usadoEm: JSON.stringify([...new Set(usadoEm.map(m => m.toLowerCase()))]
        .map(k => modelosPat.get(k)).filter(Boolean))
    });
  });

  return { linhas, erros };
}

async function importar(q, body, usuario){
  const rows = (body && body.rows) || [];
  if(!Array.isArray(rows) || !rows.length) throw new Error('nenhuma linha para importar');
  if(rows.length > MAX_IMPORT){
    throw new Error(`a planilha tem ${rows.length} linhas e o limite é ${MAX_IMPORT} por importação — divida em arquivos menores`);
  }

  const p = await conexao(); const sql = tipos();
  const { linhas, erros } = await conferirImportacao(p, rows);
  const temUsado = await temUsadoEm(p);

  if(erros.length || (body && body.simular)){
    return { gravado: false, total: rows.length, sucesso: 0, erros };
  }

  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  let atual = null;
  try {
    for(const r of linhas){
      atual = r;
      const ins = await pedido()
        .input('item',      sql.VarChar(120),   r.item)
        .input('categoria', sql.VarChar(40),    r.categoria)
        .input('modelo',    sql.VarChar(120),   txt(r.modelo, 120))
        .input('serie',     sql.VarChar(120),   txt(r.serie, 120))
        .input('obs',       sql.NVarChar(1000), txt(r.obs, 1000))
        .input('usado',     sql.NVarChar(sql.MAX), r.usadoEm)
        .input('por',       sql.VarChar(50),    usuario.login)
        .query(`INSERT INTO app.almoxarifado (item, categoria, modelo, serie, obs${temUsado ? ', usado_em' : ''}, criado_por)
                OUTPUT INSERTED.id
                VALUES (@item, @categoria, @modelo, @serie, @obs${temUsado ? ', @usado' : ''}, @por)`);

      // O lote de entrada entra na MESMA transacao: nao existe item importado
      // sem a entrada que explica o saldo dele.
      await inserirMov(pedido, sql, ins.recordset[0].id, {
        tipo: 'entrada', data_mov: r.data_mov, validade: r.validade,
        quantidade: r.quantidade, usuario: r.usuario, obs_mov: 'Importacao em massa'
      }, usuario.login);
    }
    await tx.commit();
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    console.error('[almox importar] linha', atual && atual.linha, '-', e.message);
    return {
      gravado: false, total: rows.length, sucesso: 0,
      erros: [{
        linha: atual ? atual.linha : null, campo: null,
        motivo: traduzirErro(e, atual && atual.item, atual && atual.serie).message,
        correcao: 'Nenhuma linha foi gravada. Corrija esta linha e importe a planilha inteira de novo.'
      }]
    };
  }

  await auditar(usuario, {
    tabela: 'almoxarifado', registroId: null, acao: 'INSERT',
    descricao: `Importacao em massa no almoxarifado: ${linhas.length} item(ns) cadastrado(s)`,
    depois: { sucesso: linhas.length, itens: linhas.map(r => r.item) }
  });
  return { gravado: true, total: rows.length, sucesso: linhas.length, erros: [] };
}

const almoxarifadoRoutes = [
  { method: 'GET',  path: '/api/v1/almoxarifado',                handler: listar },
  { method: 'POST', path: '/api/v1/almoxarifado',                handler: criar,      permissao: 'cadastrar' },
  { method: 'POST', path: '/api/v1/almoxarifado/atualizar',      handler: atualizar,  permissao: 'editar' },
  { method: 'POST', path: '/api/v1/almoxarifado/excluir',        handler: excluir,    permissao: 'excluir' },
  { method: 'POST', path: '/api/v1/almoxarifado/importar',       handler: importar,   permissao: 'cadastrar', simulavel: true },
  { method: 'POST', path: '/api/v1/almoxarifado/movimentacoes',  handler: movimentar, permissao: 'movimentar' }
];

module.exports = { almoxarifadoRoutes };
