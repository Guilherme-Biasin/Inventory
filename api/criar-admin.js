// Cria (ou redefine a senha de) um ADMINISTRADOR direto pela linha de comando.
//
//   node criar-admin.js <login> <senha> ["Nome"]
//   node criar-admin.js alex MinhaSenhaForte "Alex Guedes"
//
// Para que serve: se ninguem mais conseguir entrar como admin — senha
// esquecida, unico administrador desativado por engano — este script devolve o
// acesso sem precisar mexer em tabela no SSMS. Ele reativa a conta e garante o
// papel 'admin'.
//
// Exige api/config/db.json preenchido (mesma conexao que a API usa).

const { conexao, tipos } = require('./src/db');
const auth = require('./src/auth');

(async () => {
  const [login, senha, nome] = process.argv.slice(2);
  if(!login || !senha){
    console.error('Uso: node criar-admin.js <login> <senha> ["Nome"]');
    process.exit(1);
  }
  if(senha.length < 4){
    console.error('A senha precisa ter ao menos 4 caracteres.');
    process.exit(1);
  }
  const alvo = String(login).trim().toLowerCase();
  if(!/^[a-z0-9._-]{3,50}$/.test(alvo)){
    console.error('Login invalido — use de 3 a 50 caracteres entre letras, numeros, ponto, hifen e underline.');
    process.exit(1);
  }

  const p = await conexao(); const sql = tipos();
  await p.request()
    .input('u', sql.VarChar(50),  alvo)
    .input('h', sql.VarChar(255), auth.hashSenha(senha))
    .input('n', sql.VarChar(100), nome || alvo)
    .query(`IF EXISTS (SELECT 1 FROM app.usuario WHERE login = @u)
              UPDATE app.usuario SET senha_hash = @h, nome = @n, papel = 'admin', ativo = 1 WHERE login = @u;
            ELSE
              INSERT INTO app.usuario (login, senha_hash, nome, papel, ativo)
              VALUES (@u, @h, @n, 'admin', 1);`);

  console.log(`Administrador "${alvo}" criado/atualizado com sucesso.`);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
