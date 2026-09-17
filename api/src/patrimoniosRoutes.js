// Patrimonios e movimentacoes — o coracao do sistema.

const { conexao, tipos } = require('./db');
const { auditar } = require('./auditoria');

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

// Texto vindo da tela: apara espacos e devolve NULL quando vazio, para o banco
// nao encher de strings em branco que depois aparecem como " " na lista.
function txt(v, max){
  if(v == null) return null;
  const s = String(v).trim();
  if(!s) return null;
  return max && s.length > max ? s.slice(0, max) : s;
}

// data_mov trafega como 'AAAA-MM-DD' do inicio ao fim: enviar como Date faria o
// driver converter fuso e uma movimentacao do dia 1 poderia virar dia 31 do mes
// anterior. O SQL Server converte esse formato para DATE sem ambiguidade.
function dataISO(v){
  const s = txt(v);
  if(!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Violacao de indice unico (2601/2627) vira uma frase que o usuario entende.
// "Cannot insert duplicate key row in object 'app.patrimonio'..." nao ajuda
// ninguem no meio de uma importacao de 300 linhas.
function traduzirErro(e, numeroPatrimonio){
  if(e && (e.number === 2601 || e.number === 2627)){
    return new Error(`ja existe um patrimonio com o numero "${numeroPatrimonio}"`);
  }
  return e;
}

// Data de hoje no relogio do servidor (mesmo fuso da empresa), como AAAA-MM-DD.
// toISOString() daria a data em UTC: depois das 21h ja seria "amanha".
function hojeISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function movEhVazia(mov){
  const m = mov || {};
  return !dataISO(m.data_mov) && !txt(m.quem_recebeu_retirou)
      && !txt(m.obs_mov) && !txt(m.local) && !txt(m.usuario_atual);
}

// Insere uma movimentacao usando a request recebida (que pode estar dentro de
// uma transacao) e atualiza local/usuario atuais do patrimonio.
async function inserirMovimentacao(pedido, sql, patrimonioId, tipo, mov, login){
  const m = mov || {};
  await pedido()
    .input('pid',   sql.Int,            patrimonioId)
    .input('tipo',  sql.VarChar(20),    tipo)
    .input('data',  sql.VarChar(10),    dataISO(m.data_mov))
    .input('quem',  sql.VarChar(20),    txt(m.quem_recebeu_retirou, 20))
    .input('usu',   sql.VarChar(120),   txt(m.usuario_atual, 120))
    .input('local', sql.VarChar(120),   txt(m.local, 120))
    .input('status',sql.VarChar(40),    txt(m.status, 40))
    .input('obs',   sql.NVarChar(1000), txt(m.obs_mov, 1000))
    .input('por',   sql.VarChar(50),    login || null)
    .query(`INSERT INTO app.movimentacao
              (patrimonio_id, tipo, data_mov, quem_recebeu_retirou, usuario_atual, [local], status, obs_mov, criado_por)
            VALUES (@pid, @tipo, @data, @quem, @usu, @local, @status, @obs, @por)`);
}

// ------------------------------------------------------------
// GET /api/v1/patrimonios  — lista completa com historico
// ------------------------------------------------------------
// Duas consultas e o agrupamento em JavaScript, em vez de um JOIN: com JOIN,
// os dados do patrimonio se repetiriam em cada linha do historico e a resposta
// cresceria varias vezes sem necessidade.
async function listar(){
  const p = await conexao();
  const [pats, movs] = await Promise.all([
    p.request().query(`
      SELECT id, patrimonio, nome, modelo, serie, categoria, status,
             local_atual, usuario_atual
      FROM app.patrimonio ORDER BY id`),
    p.request().query(`
      SELECT patrimonio_id, tipo, CONVERT(varchar(10), data_mov, 23) AS data_mov,
             quem_recebeu_retirou, usuario_atual, [local] AS [local], status, obs_mov, criado_em
      FROM app.movimentacao ORDER BY patrimonio_id, criado_em, id`)
  ]);

  // Um Map em vez de um filter() por patrimonio: o filter varre o historico
  // inteiro uma vez por item — com 500 bens e 5.000 movimentacoes seriam 2,5
  // milhoes de comparacoes a cada abertura da tela.
  const porItem = new Map();
  for(const m of movs.recordset){
    const arr = porItem.get(m.patrimonio_id) || [];
    arr.push({
      timestamp:            m.criado_em,
      tipo:                 m.tipo,
      data_mov:             m.data_mov,
      quem_recebeu_retirou: m.quem_recebeu_retirou,
      usuario_atual:        m.usuario_atual,
      local:                m.local,
      status:               m.status,
      obs_mov:              m.obs_mov
    });
    porItem.set(m.patrimonio_id, arr);
  }

  return pats.recordset.map(r => ({
    id:            r.id,
    patrimonio:    r.patrimonio,
    nome:          r.nome    || '',
    modelo:        r.modelo  || '',
    serie:         r.serie   || '',
    // A tela trabalha com array (heranca da versao que permitia varias
    // categorias por item). O banco guarda uma so.
    categoria:     r.categoria ? [r.categoria] : [],
    status:        r.status    ? [r.status]    : [],
    local_atual:   r.local_atual   || '',
    usuario_atual: r.usuario_atual || '',
    historico:     porItem.get(r.id) || []
  }));
}

// ------------------------------------------------------------
// GET /api/v1/carimbo — usado pela tela para saber se algo mudou
// ------------------------------------------------------------
// Substitui o "realtime" do Supabase, que o SQL Server nao tem. A tela pergunta
// de tempos em tempos e so recarrega a lista inteira quando este valor muda —
// a consulta abaixo custa quase nada perto de baixar todos os patrimonios.
// As contagens entram junto das datas porque uma EXCLUSAO nao mexe em nenhum
// "atualizado_em": sem elas, apagar um item passaria despercebido.
// O almoxarifado entra no mesmo carimbo: a tela dele usa a mesma conferencia.
// As tabelas so existem depois da migracao 05 — e uma API nova rodando contra um
// banco antigo nao pode deixar a tela inteira sem atualizar por causa disso.
// Por isso o servidor pergunta uma vez se elas existem e monta a consulta.
let _temAlmox = null;
async function temAlmoxarifado(p){
  if(_temAlmox !== null) return _temAlmox;
  try {
    const r = await p.request().query(`SELECT COUNT(*) AS n FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'app' AND t.name IN ('almoxarifado','almoxarifado_mov')`);
    _temAlmox = r.recordset[0].n === 2;
  } catch(e){ _temAlmox = false; }
  return _temAlmox;
}

async function carimbo(){
  const p = await conexao();
  const almox = await temAlmoxarifado(p);
  const r = await p.request().query(`
    SELECT (SELECT COUNT(*) FROM app.patrimonio)          AS qtd_pat,
           (SELECT MAX(atualizado_em) FROM app.patrimonio) AS max_pat,
           (SELECT COUNT(*) FROM app.movimentacao)         AS qtd_mov,
           (SELECT MAX(criado_em) FROM app.movimentacao)   AS max_mov` +
    (almox ? `,
           (SELECT COUNT(*) FROM app.almoxarifado)          AS qtd_alm,
           (SELECT MAX(atualizado_em) FROM app.almoxarifado) AS max_alm,
           (SELECT COUNT(*) FROM app.almoxarifado_mov)       AS qtd_alm_mov,
           (SELECT MAX(criado_em) FROM app.almoxarifado_mov) AS max_alm_mov` : ''));
  const c = r.recordset[0];
  return { carimbo: [c.qtd_pat, c.max_pat && c.max_pat.getTime(),
                     c.qtd_mov, c.max_mov && c.max_mov.getTime(),
                     c.qtd_alm, c.max_alm && c.max_alm.getTime(),
                     c.qtd_alm_mov, c.max_alm_mov && c.max_alm_mov.getTime()].join('|') };
}

// ------------------------------------------------------------
// POST /api/v1/patrimonios — cria patrimonio + 1a movimentacao
// ------------------------------------------------------------
async function criar(q, body, usuario){
  const item = (body && body.item) || {};
  const mov  = (body && body.mov)  || {};
  const numero = txt(item.patrimonio, 50);
  if(!numero) throw new Error('informe o numero do patrimonio');

  const p = await conexao(); const sql = tipos();

  // Transacao: o patrimonio e a primeira movimentacao entram juntos ou nao
  // entram. Sem ela, uma falha no meio deixava o bem cadastrado com historico
  // vazio — e a entrada dele desaparecia do relatorio.
  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  try {
    const ins = await pedido()
      .input('patrimonio', sql.VarChar(50),  numero)
      .input('nome',       sql.VarChar(120), txt(item.nome, 120))
      .input('modelo',     sql.VarChar(120), txt(item.modelo, 120))
      .input('serie',      sql.VarChar(120), txt(item.serie, 120))
      .input('categoria',  sql.VarChar(40),  txt(item.categoria && item.categoria[0], 40))
      .input('status',     sql.VarChar(40),  txt(item.status && item.status[0], 40))
      .input('local',      sql.VarChar(120), txt(mov.local, 120))
      .input('usu',        sql.VarChar(120), txt(mov.usuario_atual, 120))
      .input('por',        sql.VarChar(50),  usuario.login)
      .query(`INSERT INTO app.patrimonio
                (patrimonio, nome, modelo, serie, categoria, status, local_atual, usuario_atual, criado_por)
              OUTPUT INSERTED.id
              VALUES (@patrimonio, @nome, @modelo, @serie, @categoria, @status, @local, @usu, @por)`);
    const id = ins.recordset[0].id;

    // O status entra no historico junto: sem isto a primeira linha ficaria sem
    // estado e o relatorio nao saberia como o bem chegou.
    if(!movEhVazia(mov)){
      const entrada = Object.assign({}, mov, { status: (item.status && item.status[0]) || mov.status });
      await inserirMovimentacao(pedido, sql, id, 'entrada', entrada, usuario.login);
    }

    await tx.commit();

    await auditar(usuario, {
      tabela: 'patrimonio', registroId: id, acao: 'INSERT',
      descricao: `Cadastrou o patrimonio ${numero} — ${txt(item.nome) || ''} ${txt(item.modelo) || ''}`.trim(),
      depois: { patrimonio: numero, nome: item.nome, modelo: item.modelo, serie: item.serie }
    });
    return { id };
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    throw traduzirErro(e, numero);
  }
}

// ------------------------------------------------------------
// POST /api/v1/patrimonios/atualizar — dados fixos do bem
// ------------------------------------------------------------
async function atualizar(q, body, usuario){
  const id   = parseInt(body && body.id, 10);
  const item = (body && body.item) || {};
  if(!Number.isFinite(id)) throw new Error('id do patrimonio invalido');
  const numero = txt(item.patrimonio, 50);
  if(!numero) throw new Error('informe o numero do patrimonio');

  const p = await conexao(); const sql = tipos();

  // Le o estado anterior para a auditoria conseguir mostrar o "antes".
  const antesR = await p.request().input('id', sql.Int, id)
    .query('SELECT patrimonio, nome, modelo, serie, categoria, status FROM app.patrimonio WHERE id = @id');
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('patrimonio nao encontrado');

  try {
    await p.request()
      .input('id',         sql.Int,          id)
      .input('patrimonio', sql.VarChar(50),  numero)
      .input('nome',       sql.VarChar(120), txt(item.nome, 120))
      .input('modelo',     sql.VarChar(120), txt(item.modelo, 120))
      .input('serie',      sql.VarChar(120), txt(item.serie, 120))
      .input('categoria',  sql.VarChar(40),  txt(item.categoria && item.categoria[0], 40))
      .input('status',     sql.VarChar(40),  txt(item.status && item.status[0], 40))
      .query(`UPDATE app.patrimonio SET
                patrimonio = @patrimonio, nome = @nome, modelo = @modelo, serie = @serie,
                categoria = @categoria, status = @status, atualizado_em = SYSDATETIME()
              WHERE id = @id`);
  } catch(e){ throw traduzirErro(e, numero); }

  await auditar(usuario, {
    tabela: 'patrimonio', registroId: id, acao: 'UPDATE',
    descricao: `Editou o patrimonio ${numero}`,
    antes,
    depois: { patrimonio: numero, nome: item.nome, modelo: item.modelo, serie: item.serie,
              categoria: item.categoria && item.categoria[0], status: item.status && item.status[0] }
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/movimentacoes — registra movimentacao
// ------------------------------------------------------------
async function movimentar(q, body, usuario){
  const id  = parseInt(body && body.patrimonioId, 10);
  const mov = (body && body.mov) || {};
  if(!Number.isFinite(id)) throw new Error('id do patrimonio invalido');

  const p = await conexao(); const sql = tipos();
  const existe = await p.request().input('id', sql.Int, id)
    .query('SELECT patrimonio FROM app.patrimonio WHERE id = @id');
  if(!existe.recordset[0]) throw new Error('patrimonio nao encontrado');
  const numero = existe.recordset[0].patrimonio;

  const tx = new (tipos().Transaction)(p);
  await tx.begin();
  const pedido = () => new (tipos().Request)(tx);
  try {
    await inserirMovimentacao(pedido, sql, id, 'movimentacao', mov, usuario.login);

    // So sobrescreve o que veio preenchido: mandar NULL "limparia" o local
    // atual de um bem so porque a movimentacao nao mexeu nele.
    const local  = txt(mov.local, 120);
    const usu    = txt(mov.usuario_atual, 120);
    const status = txt(mov.status, 40);
    const sets = ['atualizado_em = SYSDATETIME()'];
    const req = pedido().input('id', sql.Int, id);
    if(local) { sets.push('local_atual = @local');   req.input('local',  sql.VarChar(120), local); }
    if(usu)   { sets.push('usuario_atual = @usu');   req.input('usu',    sql.VarChar(120), usu); }
    if(status){ sets.push('status = @status');       req.input('status', sql.VarChar(40),  status); }
    await req.query(`UPDATE app.patrimonio SET ${sets.join(', ')} WHERE id = @id`);

    await tx.commit();
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    throw e;
  }

  await auditar(usuario, {
    tabela: 'movimentacao', registroId: id, acao: 'INSERT',
    descricao: `Movimentou o patrimonio ${numero}` +
               (txt(mov.local) ? ` para ${txt(mov.local)}` : '') +
               (txt(mov.usuario_atual) ? ` (usuario: ${txt(mov.usuario_atual)})` : '') +
               (txt(mov.status) ? ` [status: ${txt(mov.status)}]` : ''),
    depois: mov
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/patrimonios/excluir
// ------------------------------------------------------------
async function excluir(q, body, usuario){
  const id = parseInt(body && body.id, 10);
  if(!Number.isFinite(id)) throw new Error('id do patrimonio invalido');

  const p = await conexao(); const sql = tipos();
  const antesR = await p.request().input('id', sql.Int, id)
    .query('SELECT patrimonio, nome, modelo, serie, categoria, status, local_atual, usuario_atual FROM app.patrimonio WHERE id = @id');
  const antes = antesR.recordset[0];
  if(!antes) throw new Error('patrimonio nao encontrado');

  // O historico vai junto por ON DELETE CASCADE (a tela avisa antes).
  await p.request().input('id', sql.Int, id).query('DELETE FROM app.patrimonio WHERE id = @id');

  await auditar(usuario, {
    tabela: 'patrimonio', registroId: id, acao: 'DELETE',
    descricao: `Excluiu o patrimonio ${antes.patrimonio} — ${antes.nome || ''} ${antes.modelo || ''}`.trim(),
    antes
  });
  return { ok: true };
}

// ------------------------------------------------------------
// POST /api/v1/patrimonios/importar — importacao em massa
// ------------------------------------------------------------
// TUDO OU NADA. Antes era linha a linha: a linha com erro era pulada e as
// outras entravam. Isso deixava a planilha "meio importada" — e se o bem
// entrava mas a movimentacao de entrada falhava, ele ficava SEM HISTORICO e
// ainda aparecia na lista de erros, como se nao tivesse sido gravado.
//
// Agora:
//   1) A planilha inteira e conferida ANTES de gravar qualquer coisa. Cada
//      problema volta com a linha, o que esta errado e como consertar.
//   2) Com um erro que seja, nada e gravado. A pessoa corrige a planilha e
//      importa de novo.
//   3) Sem erros, tudo entra numa transacao so: cada bem junto da sua
//      movimentacao de entrada. Se o banco recusar qualquer linha no meio,
//      a transacao inteira volta atras.
//
// { rows, simular: true } so confere e devolve o resultado, sem gravar. A tela
// usa isso para mostrar os erros assim que o arquivo e escolhido — as regras
// ficam num lugar so (aqui), e a tela nunca discorda da API.
//
// Cada linha chega com os NOMES da planilha (categoria "Notebook", status
// "Em uso"); a traducao para id e feita aqui, contra a configuracao do banco.
const MAX_IMPORT = 2000;

// Tamanhos maximos = tamanho das colunas em 02_schema.sql. Cortar calado (como
// no cadastro manual) numa importacao faria o numero de serie gravado ser
// diferente do da etiqueta sem ninguem perceber.
const CAMPOS_IMPORT = [
  { chave: 'patrimonio',    nome: 'Nº Patrimônio', max: 50,  obrigatorio: true },
  { chave: 'nome',          nome: 'Marca',         max: 120, obrigatorio: true },
  { chave: 'modelo',        nome: 'Modelo',        max: 120, obrigatorio: true },
  { chave: 'serie',         nome: 'N° Série',      max: 120, obrigatorio: true },
  { chave: 'categoria',     nome: 'Categoria',     max: 60,  obrigatorio: true },
  { chave: 'status',        nome: 'Status',        max: 60,  obrigatorio: true },
  { chave: 'local_atual',   nome: 'Local Atual',   max: 120 },
  { chave: 'usuario_atual', nome: 'Usuário Atual', max: 120 }
];

function jsonLista(v){ try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch(e){ return []; } }
const chaveTexto = s => String(s || '').trim().toLowerCase();

// Confere a planilha inteira. Devolve { linhas, erros }: "linhas" ja vem com
// categoria/status traduzidos para id e so e usada se "erros" estiver vazio.
async function conferirImportacao(p, rows){
  const cfgR = await p.request()
    .query("SELECT cats, status_opts, locais FROM app.config WHERE id = 'main'");
  const cfg = cfgR.recordset[0] || {};
  const cats    = jsonLista(cfg.cats);
  const stats   = jsonLista(cfg.status_opts);
  const locais  = jsonLista(cfg.locais);
  const catPorNome  = new Map(cats.map(c => [chaveTexto(c.name), c.id]));
  const statPorNome = new Map(stats.map(s => [chaveTexto(s.name), s.id]));
  const localPorNome = new Map(locais.map(l => [chaveTexto(l), l]));

  // Numeros que ja existem no sistema. Comparacao sem diferenciar maiuscula,
  // igual ao indice unico do banco (collation CI).
  const exR = await p.request().query('SELECT patrimonio FROM app.patrimonio');
  const existentes = new Set(exR.recordset.map(r => chaveTexto(r.patrimonio)));

  const erros = [];
  const linhas = [];
  const primeiraLinhaDoNumero = new Map();
  const lista = (arr, f) => arr.map(f).filter(Boolean).join(', ') || '(nenhum cadastrado)';

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

    if(v.patrimonio){
      const k = chaveTexto(v.patrimonio);
      if(primeiraLinhaDoNumero.has(k)){
        erro('Nº Patrimônio', `o número "${v.patrimonio}" se repete — já aparece na linha ${primeiraLinhaDoNumero.get(k)}`,
             'Cada bem precisa de um número único. Corrija uma das duas linhas ou apague a duplicada.');
      } else {
        primeiraLinhaDoNumero.set(k, linha);
        if(existentes.has(k)){
          erro('Nº Patrimônio', `o número "${v.patrimonio}" já está cadastrado no sistema`,
               'Se é o mesmo bem, apague a linha da planilha (ele já existe). Se é outro bem, use outro número.');
        }
      }
    }

    let catId = null, statId = null, local = null;
    if(v.categoria){
      catId = catPorNome.get(chaveTexto(v.categoria));
      if(!catId) erro('Categoria', `a categoria "${v.categoria}" não existe`,
        `Use exatamente um destes nomes: ${lista(cats, c => c.name)} — ou cadastre a categoria em Personalizar antes de importar.`);
    }
    if(v.status){
      statId = statPorNome.get(chaveTexto(v.status));
      if(!statId) erro('Status', `o status "${v.status}" não existe`,
        `Use exatamente um destes nomes: ${lista(stats, s => s.name)} — ou cadastre o status em Personalizar antes de importar.`);
    }
    if(v.local_atual){
      local = localPorNome.get(chaveTexto(v.local_atual));
      if(!local) erro('Local Atual', `o local "${v.local_atual}" não existe`,
        `Use exatamente um destes nomes: ${lista(locais, l => l)} — cadastre o local em Personalizar, ou deixe a coluna vazia.`);
    }

    const data = r.data_mov ? dataISO(r.data_mov) : null;
    if(r.data_mov && !data){
      erro('Data', `a data "${r.data_mov}" não é válida`, 'Use o formato AAAA-MM-DD, ou deixe em branco para usar a data de hoje.');
    }

    linhas.push({
      linha, patrimonio: v.patrimonio, nome: v.nome, modelo: v.modelo, serie: v.serie,
      categoria: catId, status: statId, local_atual: local, usuario_atual: v.usuario_atual || null,
      data_mov: data
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
        .input('patrimonio', sql.VarChar(50),  r.patrimonio)
        .input('nome',       sql.VarChar(120), txt(r.nome, 120))
        .input('modelo',     sql.VarChar(120), txt(r.modelo, 120))
        .input('serie',      sql.VarChar(120), txt(r.serie, 120))
        .input('categoria',  sql.VarChar(40),  r.categoria)
        .input('status',     sql.VarChar(40),  r.status)
        .input('local',      sql.VarChar(120), txt(r.local_atual, 120))
        .input('usu',        sql.VarChar(120), txt(r.usuario_atual, 120))
        .input('por',        sql.VarChar(50),  usuario.login)
        .query(`INSERT INTO app.patrimonio
                  (patrimonio, nome, modelo, serie, categoria, status, local_atual, usuario_atual, criado_por)
                OUTPUT INSERTED.id
                VALUES (@patrimonio, @nome, @modelo, @serie, @categoria, @status, @local, @usu, @por)`);
      const id = ins.recordset[0].id;

      // A entrada no historico vai na MESMA transacao: nao existe bem
      // importado sem a movimentacao que conta como ele chegou.
      await inserirMovimentacao(pedido, sql, id, 'entrada', {
        data_mov: r.data_mov || hojeISO(),
        quem_recebeu_retirou: 'Entrada',
        usuario_atual: r.usuario_atual,
        local: r.local_atual,
        status: r.status,
        obs_mov: 'Importacao em massa'
      }, usuario.login);
    }
    await tx.commit();
  } catch(e){
    try { await tx.rollback(); } catch(e2){ /* transacao ja abortada */ }
    // Algo que a conferencia nao tinha como prever (outra pessoa cadastrou o
    // mesmo numero neste meio tempo, banco caiu...). Nada ficou gravado.
    console.error('[importar] linha', atual && atual.linha, '-', e.message);
    return {
      gravado: false, total: rows.length, sucesso: 0,
      erros: [{
        linha: atual ? atual.linha : null,
        campo: null,
        motivo: traduzirErro(e, atual && atual.patrimonio).message,
        correcao: 'Nenhuma linha foi gravada. Corrija esta linha e importe a planilha inteira de novo.'
      }]
    };
  }

  await auditar(usuario, {
    tabela: 'patrimonio', registroId: null, acao: 'INSERT',
    descricao: `Importacao em massa: ${linhas.length} patrimonio(s) cadastrado(s)`,
    depois: { sucesso: linhas.length, numeros: linhas.map(r => r.patrimonio) }
  });
  return { gravado: true, total: rows.length, sucesso: linhas.length, erros: [] };
}

const patrimoniosRoutes = [
  { method: 'GET',  path: '/api/v1/patrimonios',           handler: listar },
  { method: 'GET',  path: '/api/v1/carimbo',               handler: carimbo },
  { method: 'POST', path: '/api/v1/patrimonios',           handler: criar,     permissao: 'cadastrar' },
  { method: 'POST', path: '/api/v1/patrimonios/atualizar', handler: atualizar, permissao: 'editar' },
  { method: 'POST', path: '/api/v1/patrimonios/excluir',   handler: excluir,   permissao: 'excluir' },
  { method: 'POST', path: '/api/v1/patrimonios/importar',  handler: importar,  permissao: 'cadastrar', simulavel: true },
  { method: 'POST', path: '/api/v1/movimentacoes',         handler: movimentar, permissao: 'movimentar' }
];

module.exports = { patrimoniosRoutes };
