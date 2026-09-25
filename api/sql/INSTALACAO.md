# Instalação — Inventory Guemat no servidor

Passo a passo para instalar o sistema no SQL Server da empresa, em um banco
**só dele** (`ESTOQUE_TI`), separado do `OFICIAL` do ERP, com a API rodando
como serviço na VM (mesmo esquema do Gerente Assist).

Faça na ordem. Cada etapa diz como conferir se deu certo antes de seguir.

---

## 1. Criar o banco (SSMS)

Abra o SSMS conectado à instância `WIN-999I84392IV` (`192.168.0.220`) com um
login **sysadmin** e rode, **nesta ordem**:

| Arquivo | O que faz |
|---|---|
| `01_criar_banco.sql` | Cria o banco `ESTOQUE_TI`, o schema `app` e o login `estoque_rw` |
| `02_schema.sql` | Cria as tabelas (patrimônio, movimentação, config, usuário, auditoria) |
| `03_seed.sql` | Cria a configuração inicial (categorias, status e locais de partida) |

Os `04_...` em diante são **migrações**: mudanças em um banco que já existe.
Em instalação nova o `02` já vem com tudo, e rodá-los não faz diferença — cada
um confere antes se a mudança já está aplicada. Se você já tinha rodado o `02`
em algum momento, rode todos os `04+` na ordem.

| Migração | Quando precisa |
|---|---|
| `04_migracao_status_mov.sql` | Se o `02` foi rodado antes de a tela de movimentação ganhar o campo Status |
| `05_almoxarifado.sql` | Cria a aba **Almoxarifado**: tabelas de item e movimentação (lotes) e a lista de categorias própria. Sem ela a aba abre explicando que falta rodar isto — o resto do sistema continua funcionando |
| `06_almox_usado_em.sql` | Acrescenta o campo **Usado em** (modelos de patrimônio em que o material é usado) |
| `07_patrimonio_descartado.sql` | Cria `app.patrimonio_descartado`: arquivo morto dos bens antigos, com índice único **próprio** (o mesmo número pode existir nas duas tabelas) |
| `08_lembretes.sql` | Cria `app.lembrete`: recados com data, de todos, com conclusão e vínculo opcional a um bem (texto) |

O `zerar_dados.sql` **não é migração** e não entra nessa ordem. Ele existe para
uma situação só: terminar os testes e começar a produção com o inventário
limpo. Apaga patrimônios, movimentações, almoxarifado, lotes e a auditoria, e
preserva os usuários e a configuração (categorias, locais, status). Só apaga
depois que você troca `@CONFIRMO` de `0` para `1` dentro do arquivo; com `0`
ele apenas mostra o que existe hoje.

> **Antes de rodar o 01**: troque o texto `TROQUE_ESTA_SENHA` pela senha real
> do `estoque_rw`. É essa senha que vai para o `db.json` do passo 3. Não salve
> o `01` com a senha real dentro — ele está no Git.

**Conferindo:** o `03` termina imprimindo a contagem de linhas. Deve mostrar
`config = 1` e `usuario = 0` — o usuário é criado no passo 4, de propósito
(nenhum usuário ou senha fica escrito em arquivo do repositório).

Os três scripts podem ser rodados de novo sem estragar nada — tudo é
"se ainda não existir".

---

## 2. Trazer o código para o servidor

Na VM, com o Git instalado:

```bash
cd C:\
```
```bash
git clone <endereço do repositório> guemat-estoque
```

Estrutura esperada em `C:\guemat-estoque`:

```
guemat-estoque/
├── api/        ← o servidor Node
└── frontend/   ← as telas (também servidas pelo próprio Node)
```

Precisa do **Node.js 18 ou mais novo** (`node -v` para conferir). Dentro de
`api/`:

```bash
npm install
```

> O `npm install` mostra avisos `EBADENGINE` citando pacotes `@azure/...` que
> pedem Node 22. Pode ignorar: são as dependências de login com Azure AD, que
> este sistema não usa — a conexão é por usuário e senha do SQL Server.

Usar `git clone` (e não copiar a pasta) é o que permite atualizar depois com
`git pull`, e faz a rota `/api/v1/ambiente` informar a versão em execução.

---

## 3. Configurar a conexão

Dentro de `api/config/`, copie `db.example.json` para `db.json` e preencha a
senha que você definiu no passo 1:

```json
{
  "server": "WIN-999I84392IV",
  "database": "ESTOQUE_TI",
  "user": "estoque_rw",
  "password": "a senha que você definiu",
  "port": 1433,
  "options": { "encrypt": false, "trustServerCertificate": true },
  "pool": { "max": 10, "min": 0, "idleTimeoutMillis": 30000 }
}
```

`db.json` **não vai para o Git** (está no `.gitignore`) — é o arquivo que
guarda a senha do banco. O `auth.secret`, ao lado dele, é gerado sozinho na
primeira vez que o servidor sobe.

---

## 4. Criar o primeiro administrador

Dentro de `api/`:

```bash
node criar-admin.js <login> "<Nome>"
```

O script pede a senha duas vezes, **sem mostrar o que se digita**. A senha não
vai na linha de comando para não ficar no histórico do PowerShell.

O login aceita letras minúsculas, números, ponto, hífen e underline (3 a 50
caracteres). Guarde a senha num gerenciador de senhas — não em arquivo `.txt`.

---

## 5. Subir e testar

Dê dois cliques em `api/iniciar.bat`. Sobe em **http://localhost:3002/** — a
porta 3001 é do Gerente Assist, não use.

Abra o endereço no navegador e entre com o admin criado no passo 4. O selo
vermelho **PRODUÇÃO · GRAVANDO** ao lado do nome confirma que este servidor
grava no banco.

---

## 6. Deixar rodando como serviço (NSSM)

O `iniciar.bat` só mantém o sistema no ar enquanto a janela estiver aberta.
Na VM ele roda como o serviço `InventoryGuemat`, pelo NSSM (o mesmo do
Gerente Assist). Prompt de Comando (cmd) **como administrador** — confira que a
barra de título começa com "Administrador:"; sem isso todo comando do NSSM
responde `Acesso negado`.

O serviço é instalado a partir de `C:\ferramentas\nssm.exe`, que fica fixo: o
Windows executa esse arquivo toda vez que o serviço inicia, então ele **não pode
ser apagado nem movido** depois.

```bash
C:\ferramentas\nssm.exe install InventoryGuemat "C:\Program Files\nodejs\node.exe" server.js
```
```bash
C:\ferramentas\nssm.exe set InventoryGuemat AppDirectory C:\guemat-estoque\api
```
```bash
C:\ferramentas\nssm.exe set InventoryGuemat AppEnvironmentExtra PORT=3002 ORIGENS_PERMITIDAS=https://inventory.guematpro.com ATRAS_DE_PROXY=1
```
```bash
C:\ferramentas\nssm.exe set InventoryGuemat AppStdout C:\guemat-estoque\api\log.txt
```
```bash
C:\ferramentas\nssm.exe set InventoryGuemat AppStderr C:\guemat-estoque\api\log.txt
```
```bash
C:\ferramentas\nssm.exe start InventoryGuemat
```

Por último, uma cópia do `nssm.exe` dentro da pasta do projeto, para a
atualização do dia a dia usar o comando curto
(`cd C:\guemat-estoque && git pull && nssm restart InventoryGuemat`, ver
LEIA-ME). A cópia está no `.gitignore`.

```bash
copy C:\ferramentas\nssm.exe C:\guemat-estoque\
```

O que cada variável faz está no [LEIA-ME](../../LEIA-ME.md#variáveis-do-serviço-na-vm-obrigatórias).
Resumo: sem `ORIGENS_PERMITIDAS` a tela da Vercel não consegue falar com a API;
sem `ATRAS_DE_PROXY=1` uma pessoa errando a senha trava o login de todas.

**Nunca** defina `SOMENTE_LEITURA` no serviço — esse modo é para o notebook.

**Conferindo:** `https://inventory-api.guematpro.com/api/v1/ambiente` deve
responder `somenteLeitura: false` e a `versao` igual ao `git log --oneline -1`.

---

## Problemas comuns

**"config/db.json nao encontrado"**
Faltou o passo 3.

**"Login failed for user 'estoque_rw'"**
A senha do `db.json` não bate com a do `CREATE LOGIN`. Para redefinir, no SSMS:
`ALTER LOGIN estoque_rw WITH PASSWORD = '<nova senha>';` e atualize o `db.json`.

**"Failed to connect to WIN-999I84392IV:1433"**
O SQL Server não está aceitando TCP/IP. No *SQL Server Configuration Manager*:
Protocolos → TCP/IP habilitado, porta 1433, e reinicie o serviço. Confira também
o firewall da máquina.

**"configuracao 'main' nao existe no banco"**
Faltou rodar o `03_seed.sql`.

**Ninguém consegue entrar como admin**
Com o `db.json` já configurado, na pasta `api/`:

```bash
node criar-admin.js <login> "<Nome>"
```

Se o login já existe, o script troca a senha, reativa a conta e garante o
papel de administrador. Se não existe, cria.

**"muitas tentativas — tente novamente em X min"**
Proteção contra chute de senha: 5 erros do mesmo usuário e IP bloqueiam por
10 minutos. Reiniciar o serviço limpa o bloqueio na hora. Se acontece com
todo mundo ao mesmo tempo, falta `ATRAS_DE_PROXY=1` no serviço (passo 6).

**A tela da Vercel abre mas não carrega nada (erro de CORS no console)**
Falta ou está errado o `ORIGENS_PERMITIDAS` do serviço (passo 6).

**"servidor em SOMENTE LEITURA — nada foi gravado"**
O servidor subiu pelo `iniciar-leitura.bat` (ou com `SOMENTE_LEITURA=1`). Em
produção, remova a variável do serviço e reinicie.
