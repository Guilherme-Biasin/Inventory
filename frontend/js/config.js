// Configuracao do frontend: onde fica a API.
//
// Mesmo desenho do Gerente Assist (frontend/js/config.js), de proposito: os
// dois sistemas sao mantidos pela mesma pessoa e se parecerem economiza
// releitura.
//
// A tela roda em dois lugares diferentes e cada um precisa de um endereco:
//
//   1) Servida pelo proprio Node — "localhost:3002" no desenvolvimento, ou a
//      VM na rede interna. Aqui a API esta no MESMO endereco da pagina, entao
//      o caminho relativo ('') resolve sozinho e continua funcionando se o IP
//      mudar.
//
//   2) Servida pela Vercel — a tela vem do CDN e a API continua na VM, em
//      outro endereco. Sem apontar explicitamente, o navegador procuraria a
//      API dentro da propria Vercel e nada carregaria.
//
// TROCAR AQUI se os subdominios forem outros — e o unico lugar.
//
// Por que "inventory-api" e nao "api.inventory": o certificado gratuito da
// Cloudflare cobre *.guematpro.com, que e UM nivel de subdominio. Um endereco
// com dois niveis ficaria sem certificado e a tela nao carregaria por HTTPS.
const API_PUBLICA = 'https://inventory-api.guematpro.com';

const API_POR_HOST = {
  'inventory.guematpro.com':     API_PUBLICA,
  'www.inventory.guematpro.com': API_PUBLICA   // a Vercel costuma publicar os dois
};

function _descobrirApi(){
  const host = location.hostname;
  if(API_POR_HOST[host]) return API_POR_HOST[host];
  // Previews da Vercel nascem com endereco aleatorio (*.vercel.app) a cada
  // deploy — nao da para listar um por um.
  if(host.endsWith('.vercel.app')) return API_PUBLICA;
  return '';   // servida pelo proprio Node: mesma origem
}

const API_URL = _descobrirApi();
