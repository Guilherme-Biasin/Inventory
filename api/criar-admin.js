// Cria (ou redefine a senha de) um ADMINISTRADOR direto pela linha de comando.
//
//   node criar-admin.js <login> ["Nome"]
//
// A senha NAO vai na linha de comando: o script pergunta, sem mostrar o que se
// digita, e pede duas vezes. Passada como argumento, ela ficaria gravada no
// historico do PowerShell/prompt da maquina.
//
// Para que serve:
//   - INSTALACAO NOVA: e assim que nasce o primeiro admin. O 03_seed.sql nao
//     cria usuario nenhum, porque tudo que esta no Git e publico para quem
//     ler o repositorio.
//   - RESGATE: se ninguem mais conseguir entrar como admin — senha esquecida,
//     unico administrador desativado por engano — este script devolve o acesso
//     sem mexer em tabela no SSMS. Ele reativa a conta e garante o papel admin.
//
// Exige api/config/db.json preenchido (mesma conexao que a API usa).

const readline = require('readline');
const { conexao, tipos } = require('./src/db');
const auth = require('./src/auth');

const SENHA_MIN = 4;   // mesmo minimo da API (usuariosRoutes.js)

// Le uma linha do terminal sem ecoar os caracteres.
function perguntarOculto(pergunta){
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let mudo = false;
    rl._writeToOutput = texto => { if(!mudo) rl.output.write(texto); };
    rl.question(pergunta, resposta => {
      rl.output.write('\n');
      rl.close();
      resolve(resposta);
    });
    mudo = true;
  });
}

(async () => {
  const [login, nome] = process.argv.slice(2);
  if(!login){
    console.error('Uso: node criar-admin.js <login> ["Nome"]');
    process.exit(1);
  }
  const alvo = String(login).trim().toLowerCase();
  if(!/^[a-z0-9._-]{3,50}$/.test(alvo)){
    console.error('Login invalido — use de 3 a 50 caracteres entre letras, numeros, ponto, hifen e underline.');
    process.exit(1);
  }

  const senha  = await perguntarOculto(`Senha para "${alvo}": `);
  if(senha.length < SENHA_MIN){
    console.error(`A senha precisa ter ao menos ${SENHA_MIN} caracteres.`);
    process.exit(1);
  }
  const senha2 = await perguntarOculto('Repita a senha: ');
  if(senha !== senha2){
    console.error('As senhas nao coincidem. Nada foi gravado.');
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
