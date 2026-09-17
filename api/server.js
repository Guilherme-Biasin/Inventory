// API do Inventory Guemat + servidor do frontend estatico.
// HTTP nativo do Node — a unica dependencia do projeto e o driver 'mssql'.
//
//   node server.js            (porta 3002)
//   set PORT=3005 & node server.js
//
// Estrutura: cada dominio exporta um array de rotas; o registro central abaixo
// junta todos e aplica autenticacao e permissao no MESMO lugar, para nenhuma
// rota nova nascer sem protecao por esquecimento.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const zlib = require('zlib');

const { authRoutes, sessaoValida } = require('./src/authRoutes');
const { configRoutes }       = require('./src/configRoutes');
const { patrimoniosRoutes }  = require('./src/patrimoniosRoutes');
const { almoxarifadoRoutes } = require('./src/almoxarifadoRoutes');
const { usuariosRoutes }     = require('./src/usuariosRoutes');
const { auditoriaRoutes }    = require('./src/auditoria');
const auth = require('./src/auth');

const PORT = process.env.PORT || 3002;

// SOMENTE LEITURA — para o notebook abrir o sistema com os DADOS REAIS sem
// risco. O banco que o desenvolvimento enxerga e o mesmo ESTOQUE_TI da
// producao: cadastrar um patrimonio "so para testar" entraria no inventario
// de verdade. Com esta trava tudo aparece, e nenhum POST passa — nem criar
// usuario, nem trocar senha. (O login passa: ele e publico.)
// A trava fica AQUI, no servidor, e nao so escondendo botao na tela.
// Mesmo desenho do Gerente Assist. Suba com api\iniciar-leitura.bat.
const SOMENTE_LEITURA = process.env.SOMENTE_LEITURA === '1';

// QUAL COMMIT ESTE PROCESSO ESTA RODANDO. Lido do .git na partida, e nao a cada
// chamada: o codigo em memoria e o da partida, entao reler depois mentiria
// exatamente na hora que importa (depois de um `git pull` sem restart).
//
// "Atualizei e nao mudou nada" tem tres causas iguais por fora — o pull nao
// veio, o servico nao reiniciou, ou a migracao SQL falta. Com o commit a vista,
// da para descartar as duas primeiras sem adivinhar.
const VERSAO = (() => {
  try {
    const git = path.resolve(__dirname, '..', '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref:') ? head.slice(4).trim() : null;
    let sha = head;
    if(ref){
      const solto = path.join(git, ref);
      if(fs.existsSync(solto)) sha = fs.readFileSync(solto, 'utf8').trim();
      else {
        // Depois de um `git gc` a ref vai para packed-refs e o arquivo solto some.
        const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
        const linha = packed.split('\n').find(l => l.endsWith(' ' + ref));
        sha = linha ? linha.split(' ')[0] : '';
      }
    }
    return sha ? sha.slice(0, 7) : null;
  } catch(e){
    // Instalacao sem .git (copiada por zip) continua funcionando, so nao diz a
    // versao — e melhor do que o servidor inteiro nao subir por causa disto.
    return null;
  }
})();

// Frontend servido a partir da pasta /frontend (irma de /api).
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const ARQUIVO_INICIAL = 'index.html';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2'
};

// ---------- PERMISSOES ----------
// A mesma tabela que a tela usa para esconder botao, aplicada no SERVIDOR.
// Esconder o botao nao protege nada: ate a versao anterior, qualquer pessoa
// logada como leitor podia apagar patrimonio chamando o banco direto pelo
// console do navegador. Aqui a resposta e 403 e nada acontece.
const PODE = {
  leitor: [],
  editor: ['cadastrar', 'editar', 'movimentar', 'config'],
  admin:  ['cadastrar', 'editar', 'movimentar', 'config', 'excluir', 'gerenciar_usuarios']
};

function podeAcessar(usuario, permissao){
  if(!permissao) return true;
  return (PODE[usuario.papel] || []).includes(permissao);
}

// ---------- CORS ----------
// Sem ORIGENS_PERMITIDAS nenhuma origem externa e liberada. Isso basta quando a
// tela e servida por este mesmo processo (localhost:3002 — mesma origem nao usa
// CORS). EM PRODUCAO A TELA VEM DA VERCEL, em outro endereco, e o servico na VM
// PRECISA da variavel, senao o navegador bloqueia toda chamada:
//   ORIGENS_PERMITIDAS=https://inventory.guematpro.com
// Ver LEIA-ME.md, "Variaveis do servico na VM".
const ORIGENS = (process.env.ORIGENS_PERMITIDAS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(p => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, m => m === '*' ? ' ' : '\\' + m)
                              .split(' ').join('[^.]*') + '$'));

function origemPermitida(origem){
  return !!origem && ORIGENS.some(re => re.test(origem));
}

// ---------- IP de quem chamou ----------
// Usado pelo freio de tentativas de login. Atras de um tunel/proxy o IP da
// conexao e sempre o do proxy — todo mundo viraria "a mesma pessoa" e 5 erros
// de um deixariam a empresa inteira travada. Os cabecalhos so sao aceitos com
// ATRAS_DE_PROXY=1, porque quem fala direto com o servidor pode forja-los e
// escapar do freio trocando o valor a cada tentativa.
const ATRAS_DE_PROXY = process.env.ATRAS_DE_PROXY === '1';

function ipDoCliente(req){
  if(ATRAS_DE_PROXY){
    const cf = req.headers['cf-connecting-ip'];
    if(cf) return String(cf).trim();
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if(xff) return xff;
  }
  return (req.socket && req.socket.remoteAddress) || '?';
}

// Qual ambiente e este. Publica de proposito: a tela precisa saber ANTES do
// login, para avisar quando nada do que se fizer ali vai ser gravado.
const ambienteRoute = {
  method: 'GET', path: '/api/v1/ambiente', publico: true,
  handler: async () => ({ modo: 'sqlserver', somenteLeitura: SOMENTE_LEITURA, versao: VERSAO })
};

const rotas = [
  ambienteRoute,
  ...authRoutes,
  ...configRoutes,
  ...patrimoniosRoutes,
  ...almoxarifadoRoutes,
  ...auditoriaRoutes,
  ...usuariosRoutes
];

// Le o corpo JSON de uma requisicao.
function lerBody(req){
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if(s.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch(e){ reject(new Error('JSON invalido no corpo')); } });
    req.on('error', reject);
  });
}

// ---------- COMPRESSAO ----------
// A lista de patrimonios com historico e um JSON que repete as mesmas chaves
// centenas de vezes — comprime muito bem. Abaixo de ~1400 bytes o cabecalho do
// gzip custa mais do que economiza, e imagens/fontes ja vem comprimidas.
const MIN_GZIP = 1400;
const NAO_COMPRIME = /^(image\/(png|jpe?g|gif|webp|avif)|font\/|application\/zip|application\/pdf)/i;

function aceitaGzip(req){
  return /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
}

function varyMais(res, valor){
  const atual = res.getHeader('Vary');
  if(!atual) return res.setHeader('Vary', valor);
  const partes = String(atual).split(',').map(x => x.trim());
  if(!partes.includes(valor)) res.setHeader('Vary', partes.concat(valor).join(', '));
}

// Assincrono de proposito: gzipSync travaria o laco de eventos no meio da fila
// de chamadas.
function enviar(req, res, status, corpo, tipo){
  const buf = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf-8');
  const cabecalhos = tipo ? { 'Content-Type': tipo } : {};
  const semGzip = () => {
    res.writeHead(status, Object.assign({ 'Content-Length': buf.length }, cabecalhos));
    res.end(buf);
  };
  const tipoFinal = tipo || res.getHeader('Content-Type') || '';
  if(buf.length < MIN_GZIP || !aceitaGzip(req) || NAO_COMPRIME.test(String(tipoFinal))) return semGzip();

  varyMais(res, 'Accept-Encoding');
  zlib.gzip(buf, (err, comprimido) => {
    // Falhou o gzip? Manda cru. Nenhuma resposta pode se perder por causa de
    // uma otimizacao de transporte.
    if(err || !comprimido || comprimido.length >= buf.length) return semGzip();
    res.writeHead(status, Object.assign({
      'Content-Encoding': 'gzip', 'Content-Length': comprimido.length }, cabecalhos));
    res.end(comprimido);
  });
}

async function servirApi(req, res, parsed){
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const rota = rotas.find(r => r.method === req.method && r.path === parsed.pathname);
  if(!rota){
    res.writeHead(404);
    return res.end(JSON.stringify({ erro: 'rota nao encontrada', path: parsed.pathname }));
  }

  let usuario = null;
  if(!rota.publico){
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const u = auth.verificarToken(token);
    if(!u){
      res.writeHead(401);
      return res.end(JSON.stringify({ erro: 'nao autenticado' }));
    }
    // Desativar o usuario na aba Usuarios derruba a sessao dele (ate 30s).
    if(!(await sessaoValida(u))){
      res.writeHead(401);
      return res.end(JSON.stringify({ erro: 'sessao encerrada — entre novamente' }));
    }
    if(rota.soAdmin && u.papel !== 'admin'){
      res.writeHead(403);
      return res.end(JSON.stringify({ erro: 'apenas administradores' }));
    }
    if(!podeAcessar(u, rota.permissao)){
      res.writeHead(403);
      return res.end(JSON.stringify({ erro: 'sem permissao para esta acao' }));
    }
    usuario = u;
  }

  try {
    const body = (req.method === 'POST' || req.method === 'PUT') ? await lerBody(req) : null;

    // Trava de SOMENTE LEITURA. Depois de ler o corpo porque a importacao tem
    // o modo { simular: true }, que so confere a planilha e nao grava nada —
    // esse pode passar.
    const soConfere = rota.simulavel && body && body.simular === true;
    if(SOMENTE_LEITURA && req.method === 'POST' && !rota.publico && !soConfere){
      res.writeHead(423);
      return res.end(JSON.stringify({ erro: 'servidor em SOMENTE LEITURA — nada foi gravado. ' +
        'Este modo existe para conferir os dados reais sem escrever no banco de producao.' }));
    }

    const dados = await rota.handler(parsed.searchParams, body, usuario, { ip: ipDoCliente(req) });
    enviar(req, res, 200, JSON.stringify(dados));
  } catch(e){
    // O MOTIVO vai no corpo. Sem isto a tela mostraria so "API 400" e ninguem
    // saberia se faltou preencher um campo ou se o banco esta fora do ar.
    if(!e.status) console.error('[api]', req.method, parsed.pathname, '-', e.message);
    res.writeHead(e.status || 400);
    res.end(JSON.stringify({ erro: e.message }));
  }
}

function servirEstatico(req, res, parsed){
  let rel;
  // decodeURIComponent explode com % solto ("GET /%"). Sem este try o erro subia
  // como uncaughtException e MATAVA o processo — qualquer robo de varredura
  // derrubaria o sistema.
  try { rel = decodeURIComponent(parsed.pathname); }
  catch(e){
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('endereco invalido');
  }
  if(rel === '/') rel = '/' + ARQUIVO_INICIAL;
  const arquivo = path.join(FRONTEND_DIR, rel);

  // Impede sair da pasta do frontend (path traversal). O separador no fim e
  // necessario: sem ele uma pasta VIZINHA de nome parecido (frontend-old)
  // passaria no teste.
  if(arquivo !== FRONTEND_DIR && !arquivo.startsWith(FRONTEND_DIR + path.sep)){
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('acesso negado');
  }

  fs.readFile(arquivo, (err, buf) => {
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('arquivo nao encontrado');
    }
    enviar(req, res, 200, buf, MIME[path.extname(arquivo).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const origem = req.headers.origin;
  if(origemPermitida(origem)){
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    // Com a tela na Vercel e a API aqui, cada POST dispara ANTES uma pergunta
    // de permissao (preflight). Sem este cabecalho o navegador repergunta a
    // cada poucos segundos, e cada pergunta e mais uma volta pelo tunel
    // (~280ms) — dobrando o custo de salvar. Um dia de validade.
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }

  // Host/URL malformados tambem lancam aqui. Uma requisicao torta nunca pode
  // derrubar o processo.
  let parsed;
  try { parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch(e){
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('requisicao invalida');
  }

  try {
    if(parsed.pathname.startsWith('/api/')) servirApi(req, res, parsed);
    else servirEstatico(req, res, parsed);
  } catch(e){
    console.error('[http] falha ao tratar', req.method, req.url, '-', e.message);
    if(!res.headersSent){
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('erro interno');
    } else { res.end(); }
  }
});

// Rede de seguranca: uma falha inesperada em UMA requisicao nao pode tirar o
// sistema do ar para a empresa inteira.
process.on('uncaughtException', e => console.error('[erro nao tratado]', e));
process.on('unhandledRejection', e => console.error('[promessa rejeitada]', e));

server.on('error', e => {
  if(e.code !== 'EADDRINUSE') throw e;
  console.error(`
  ==========================================================
   A porta ${PORT} ja esta em uso.

   Quase sempre e outro Inventory Guemat ja rodando — de uma
   janela anterior que ficou aberta, ou do servico do servidor.
   (A porta 3001 e do Gerente Assist; nao use.)

   Para ver quem esta usando (PowerShell):
     Get-NetTCPConnection -LocalPort ${PORT} -State Listen

   Ou suba em outra porta:
     set PORT=3005
  ==========================================================
`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Inventory Guemat rodando em http://localhost:${PORT}/`);
  console.log(`API em http://localhost:${PORT}/api/v1`);
  console.log(`Versao (commit): ${VERSAO || 'desconhecida'}`);
  if(SOMENTE_LEITURA) console.log('*** SOMENTE LEITURA: nenhuma gravacao passa ***');
  rotas.forEach(r => console.log(`  ${r.method.padEnd(4)} ${r.path}`));
});
