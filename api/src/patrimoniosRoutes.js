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
async function carimbo(){
  const p = await conexao();
  const r = await p.request().query(`
    SELECT (SELECT COUNT(*) FROM app.patrimonio)          AS qtd_pat,
           (SELECT MAX(atualizado_em) FROM app.patrimonio) AS max_pat,
           (SELECT COUNT(*) FROM app.movimentacao)         AS qtd_mov,
           (SELECT MAX(criado_em) FROM app.movimentacao)   AS max_mov`);
  const c = r.recordset[0];
  return { carimbo: [c.qtd_pat, c.max_pat && c.max_pat.getTime(),
                     c.qtd_mov, c.max_mov && c.max_mov.getTime()].join('|') };
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
// Linha a linha de proposito: se uma falhar (numero repetido, por exemplo), as
// outras entram e a tela lista exatamente qual linha da planilha deu problema.
// Um INSERT unico faria as 300 linhas caírem por causa de uma.
const MAX_IMPORT = 2000;

async function importar(q, body, usuario){
  const rows = (body && body.rows) || [];
  if(!Array.isArray(rows) || !rows.length) throw new Error('nenhuma linha para importar');
  if(rows.length > MAX_IMPORT) throw new Error(`limite de ${MAX_IMPORT} linhas por importacao`);

  const p = await conexao(); const sql = tipos();
  let sucesso = 0;
  const erros = [];

  for(let i = 0; i < rows.length; i++){
    const r = rows[i] || {};
    const numero = txt(r.patrimonio, 50);
    try {
      if(!numero) throw new Error('numero do patrimonio vazio');
      const ins = await p.request()
        .input('patrimonio', sql.VarChar(50),  numero)
        .input('nome',       sql.VarChar(120), txt(r.nome, 120))
        .input('modelo',     sql.VarChar(120), txt(r.modelo, 120))
        .input('serie',      sql.VarChar(120), txt(r.serie, 120))
        .input('categoria',  sql.VarChar(40),  txt(r.categoria, 40))
        .input('status',     sql.VarChar(40),  txt(r.status, 40))
        .input('local',      sql.VarChar(120), txt(r.local_atual, 120))
        .input('usu',        sql.VarChar(120), txt(r.usuario_atual, 120))
        .input('por',        sql.VarChar(50),  usuario.login)
        .query(`INSERT INTO app.patrimonio
                  (patrimonio, nome, modelo, serie, categoria, status, local_atual, usuario_atual, criado_por)
                OUTPUT INSERTED.id
                VALUES (@patrimonio, @nome, @modelo, @serie, @categoria, @status, @local, @usu, @por)`);
      const id = ins.recordset[0].id;

      await inserirMovimentacao(() => p.request(), sql, id, 'entrada', {
        data_mov: r.data_mov,
        quem_recebeu_retirou: 'Entrada',
        usuario_atual: r.usuario_atual,
        local: r.local_atual,
        status: r.status,
        obs_mov: 'Importacao em massa'
      }, usuario.login);

      sucesso++;
    } catch(e){
      erros.push({ linha: i + 2, motivo: traduzirErro(e, numero).message });  // +2: linha 1 e o cabecalho
    }
  }

  await auditar(usuario, {
    tabela: 'patrimonio', registroId: null, acao: 'INSERT',
    descricao: `Importacao em massa: ${sucesso} cadastrado(s), ${erros.length} com erro`,
    depois: { sucesso, erros: erros.length }
  });
  return { sucesso, erros };
}

const patrimoniosRoutes = [
  { method: 'GET',  path: '/api/v1/patrimonios',           handler: listar },
  { method: 'GET',  path: '/api/v1/carimbo',               handler: carimbo },
  { method: 'POST', path: '/api/v1/patrimonios',           handler: criar,     permissao: 'cadastrar' },
  { method: 'POST', path: '/api/v1/patrimonios/atualizar', handler: atualizar, permissao: 'editar' },
  { method: 'POST', path: '/api/v1/patrimonios/excluir',   handler: excluir,   permissao: 'excluir' },
  { method: 'POST', path: '/api/v1/patrimonios/importar',  handler: importar,  permissao: 'cadastrar' },
  { method: 'POST', path: '/api/v1/movimentacoes',         handler: movimentar, permissao: 'movimentar' }
];

module.exports = { patrimoniosRoutes };
