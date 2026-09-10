// Autenticacao — mesmo esquema do Gerente Assist, sem dependencia externa.
// - Senha: hash scrypt com sal (nunca guarda senha em texto).
// - Token: assinado com HMAC (sem sessao no servidor), valido por 12h.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Segredo que assina os tokens. Gerado e gravado em config/auth.secret na
// primeira execucao. Se este arquivo for apagado, todos os tokens em circulacao
// deixam de valer e todo mundo precisa entrar de novo — e so isso.
let _secret = null;
function getSecret(){
  if(_secret) return _secret;
  const p = path.join(__dirname, '..', 'config', 'auth.secret');
  if(fs.existsSync(p)){ _secret = fs.readFileSync(p, 'utf8').trim(); return _secret; }
  _secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(p, _secret);
  return _secret;
}

function hashSenha(senha){
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(senha), salt, 32).toString('hex');
  return salt + ':' + h;
}

function verificarSenha(senha, guardado){
  if(!guardado || guardado.indexOf(':') < 0) return false;
  const [salt, h] = guardado.split(':');
  const hh = crypto.scryptSync(String(senha), salt, 32).toString('hex');
  // timingSafeEqual em vez de === : a comparacao normal para no primeiro byte
  // diferente, e o tempo dela vaza quantos bytes o palpite acertou.
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hh, 'hex')); }
  catch(e){ return false; }
}

// O token carrega o PAPEL. Como e assinado por HMAC, o navegador nao consegue
// trocar 'leitor' por 'admin' — por isso o servidor pode confiar no que leu
// dali sem consultar o banco a cada chamada.
function gerarToken(login, papel){
  const payload = Buffer.from(JSON.stringify({
    login,
    papel: papel || 'leitor',
    exp: Date.now() + 12*3600*1000
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

// Retorna { login, papel } se valido; senao null.
function verificarToken(token){
  if(!token) return null;
  const [payload, sig] = String(token).split('.');
  if(!payload || !sig) return null;
  const esperado = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  if(sig.length !== esperado.length) return null;
  if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if(!p.exp || p.exp < Date.now()) return null;
    return { login: p.login, papel: p.papel || 'leitor' };
  } catch(e){ return null; }
}

module.exports = { hashSenha, verificarSenha, gerarToken, verificarToken };
