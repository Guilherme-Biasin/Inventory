# Inventory Guemat — estoque de TI

Controle de patrimônio de TI: cadastro dos bens, histórico de movimentações,
importação por planilha, auditoria e leitura de código de barras pelo celular.

O sistema **saiu do Supabase** e agora roda inteiro na empresa: banco
`ESTOQUE_TI` no SQL Server do servidor, separado do banco `OFICIAL` do ERP.

- **Para instalar:** [api/sql/INSTALACAO.md](api/sql/INSTALACAO.md)
- **Roteiro do projeto (o que está feito e o que falta):** [ETAPAS.txt](ETAPAS.txt)
- **Regras de trabalho do agente (Claude Code):** [CLAUDE.md](CLAUDE.md)

---

## Produção

Mesmo desenho do Gerente Assist: a tela vem da Vercel, a API fica na VM.

| | Onde |
|---|---|
| Tela | **https://inventory.guematpro.com** (Vercel, publica no push) |
| API | **https://inventory-api.guematpro.com** (VM, túnel Cloudflare) |
| Máquina | VM do Gerente Assist, pasta `C:\guemat-estoque` |
| Serviço | `InventoryGuemat` (NSSM), porta 3002 |
| Banco | `ESTOQUE_TI` em `192.168.0.220` |

Quem decide o endereço da API é [frontend/js/config.js](frontend/js/config.js),
pelo domínio de onde a página veio — não há edição a cada deploy. É o único
lugar a mexer se os subdomínios mudarem.

O subdomínio é `inventory-api` e não `api.inventory` porque o certificado
gratuito da Cloudflare cobre `*.guematpro.com`, ou seja **um** nível de
subdomínio. Dois níveis ficariam sem HTTPS.

O HTTPS não é preferência: o leitor de código de barras usa a câmera, e o
navegador só a libera em `https://` (ou `localhost`). Por `http://ip:3002` o
leitor avisa o motivo e não abre.

### Variáveis do serviço na VM (obrigatórias)

Como a tela (Vercel) e a API (VM) estão em endereços diferentes, o serviço
`InventoryGuemat` precisa destas variáveis de ambiente:

| Variável | Valor | Sem ela |
|---|---|---|
| `ORIGENS_PERMITIDAS` | `https://inventory.guematpro.com,https://inventory-guemat-*.vercel.app` | O navegador bloqueia toda chamada da tela à API (CORS) e nada carrega |
| `ATRAS_DE_PROXY` | `1` | Todo mundo chega com o IP do túnel: 5 senhas erradas de **uma** pessoa bloqueiam o login de **todas** por 10 minutos |
| `SOMENTE_LEITURA` | *(não definir)* | — em produção a gravação fica ligada |

Para conferir ou definir (PowerShell como administrador, na VM):

```bash
C:\ferramentas\nssm.exe get InventoryGuemat AppEnvironmentExtra
```
```bash
C:\ferramentas\nssm.exe set InventoryGuemat AppEnvironmentExtra ORIGENS_PERMITIDAS=https://inventory.guematpro.com ATRAS_DE_PROXY=1
```

> O curinga `inventory-guemat-*.vercel.app` só vale se o projeto na Vercel tiver
> esse nome. Confira no painel da Vercel e ajuste o padrão.

### Para atualizar

```bash
git push origin main
```

Isso publica **a tela** na hora (Vercel). Mudança na **API** exige, além do
push, atualizar a VM:

```bash
cd C:\guemat-estoque && git pull
```
```bash
C:\ferramentas\nssm.exe restart InventoryGuemat
```

Como os dois lados sobem separados, dá para a tela estar numa versão e a API
noutra. Ao mexer nos dois no mesmo commit, atualize a VM logo depois do push.
Se o serviço não subir, o motivo está em `C:\guemat-estoque\api\log.txt`.

**"Atualizei e não mudou nada"?** Abra
`https://inventory-api.guematpro.com/api/v1/ambiente`: o campo `versao` é o
commit que a API está rodando. Compare com `git log --oneline -1`. Diferente =
o `git pull` não veio ou o serviço não reiniciou. Igual = o problema é outro
(migração SQL faltando, cache do navegador).

---

## Desenvolvimento (no notebook)

**Não existe banco de teste.** O `config/db.json` do notebook aponta para o
mesmo `ESTOQUE_TI` da produção. Por isso há dois jeitos de subir:

| Arquivo | Para quem | Grava no banco? | Selo na tela |
|---|---|---|---|
| `api\iniciar-leitura.bat` | **notebook** | **Não** — todo POST volta `423` | âmbar **DADOS REAIS · SÓ LEITURA** |
| `api\iniciar.bat` | servidor | Sim | vermelho **PRODUÇÃO · GRAVANDO** (só quando a tela vem do próprio Node) |

Os dois sobem em `http://localhost:3002/`. No modo só leitura tudo aparece
igual à produção e o login funciona; cadastrar, movimentar, excluir,
personalizar, mexer em usuário e trocar senha são recusados **pelo servidor**.
A importação ainda **confere** a planilha (mostra os erros), só não grava.

A trava fica no servidor de propósito: esconder botão não protege nada.
Na tela, o selo ao lado do nome do usuário mostra também a versão da API.

Testes (não precisam de banco):

```bash
cd api && npm test
```

---

## Como está organizado

```
guemat-estoque/
├── LEIA-ME.md                 este arquivo
├── ETAPAS.txt                 roteiro: o que está feito e o que falta
├── CLAUDE.md                  regras de trabalho do agente
├── api/                       servidor Node (também entrega as telas)
│   ├── server.js                registro das rotas, login, permissões, CORS,
│   │                            gzip, trava de SOMENTE_LEITURA, /ambiente
│   ├── config/
│   │   ├── db.example.json      modelo — copie para db.json e preencha
│   │   ├── db.json              SENHA DO BANCO (fora do Git)
│   │   └── auth.secret          chave dos tokens, gerada sozinha (fora do Git)
│   ├── sql/                     scripts para rodar no SSMS, na ordem 01→02→03→04…
│   ├── testes/                  npm test — roda sem banco
│   ├── src/
│   │   ├── db.js                conexão com o SQL Server
│   │   ├── auth.js              hash de senha e token
│   │   ├── authRoutes.js        login, /eu, trocar senha, sessão e papel atual
│   │   ├── configRoutes.js      aba Personalizar
│   │   ├── patrimoniosRoutes.js patrimônios, movimentações, importação
│   │   ├── usuariosRoutes.js    aba Usuários
│   │   └── auditoria.js         registro e consulta da auditoria
│   ├── criar-admin.js           cria o 1º admin / resgata o acesso de admin
│   ├── iniciar.bat              servidor — GRAVA no banco
│   └── iniciar-leitura.bat      notebook — só leitura
└── frontend/                  as telas
    ├── index.html
    ├── css/style.css
    └── js/
        ├── config.js            endereço da API conforme o domínio
        ├── api-config.js        conversa com a API
        ├── app.js               a aplicação
        └── mobile-scanner.js    leitor de código de barras
```

A porta **3001 é do Gerente Assist** — não use.

---

## Papéis de acesso

| Papel | Pode |
|---|---|
| **leitor** | consultar e exportar |
| **editor** | tudo do leitor + cadastrar, editar, movimentar, importar, personalizar |
| **admin** | tudo do editor + excluir patrimônio e gerenciar usuários |

A regra é aplicada **no servidor**, não só escondendo botão. Um leitor que
tentar excluir um patrimônio pelo console do navegador recebe `403` e nada
acontece.

**O papel que vale é o do banco, não o do token.** O token de login dura 12h,
mas a cada chamada o servidor confere o papel atual do usuário (lista em cache
de 30s). Mudou o papel ou desativou pela aba Usuários: vale **na próxima
chamada** da pessoa. Mudou direto no banco pelo SSMS: vale em até 30 segundos.

---

## Importação por planilha

**Tudo ou nada.** Ao escolher o arquivo, a API confere a planilha inteira e a
tela lista cada problema com a **linha**, **o que está errado** e **como
corrigir** (campo vazio, número repetido na planilha, número que já existe no
sistema, categoria/status/local que não existe, texto maior que a coluna).

Com um erro que seja, **nada é gravado** e o botão Importar não aparece: corrija
no Excel e escolha o arquivo de novo. Sem erros, todos os bens entram numa
transação só, **cada um com a sua movimentação de entrada no histórico** — se
o banco recusar qualquer linha no meio, nada fica gravado.

---

## Segurança — regras que não podem ser quebradas

- **Todo texto que vem do banco ou da planilha passa por `esc()`** antes de
  entrar em `innerHTML` (e por `escJs()` dentro de `onclick`). Sem isso, um
  editor que cadastrasse `<img src=x onerror=...>` como marca rodava código no
  navegador de quem abrisse a lista — um admin, por exemplo. Cores de
  categoria/status só entram como `#hex` (`corSegura()` na tela, validação em
  `configRoutes.js` no servidor).
- **Nenhum usuário ou senha no repositório** — nem como exemplo, nem como hash.
  O primeiro admin nasce com `node criar-admin.js`, que pede a senha sem
  mostrar e não a deixa no histórico do terminal.
- **Senhas fora do Git.** `config/db.json`, `config/auth.secret` e qualquer
  `senhas.txt` estão no `.gitignore`. O lugar certo para senha é um gerenciador
  de senhas (Bitwarden, KeePassXC), não um arquivo de texto.

---

## O que mudou em relação à versão do Supabase

| Antes (Supabase) | Agora |
|---|---|
| Banco na nuvem, projeto do Supabase | SQL Server `ESTOQUE_TI`, no servidor da empresa |
| Login por e-mail (Supabase Auth) | Login curto na tabela `app.usuario` |
| Regras de acesso só na tela | Papel conferido no servidor a cada chamada |
| Auditoria por gatilho no banco | Auditoria escrita pela API, com o autor certo e descrição em português |
| Atualização em tempo real (realtime) | Consulta leve a cada 20s; recarrega só quando algo muda |
| Movimentar não mudava o status do bem | A tela de movimentação tem campo **Status**, e o histórico guarda o estado de cada movimentação |
| Navegador falava direto com o banco | Navegador fala só com a API; a senha do banco não sai do servidor |
