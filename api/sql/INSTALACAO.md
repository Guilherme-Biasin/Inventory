# Instalação — Inventory Guemat no servidor

Passo a passo para tirar o sistema do Supabase e colocá-lo no SQL Server da
empresa, em um banco **só dele** (`ESTOQUE_TI`), separado do `OFICIAL` do ERP.

Faça na ordem. Cada etapa diz como conferir se deu certo antes de seguir.

---

## 1. Criar o banco (SSMS)

Abra o SSMS conectado à instância `WIN-999I84392IV` (`192.168.0.220`) com um
login **sysadmin** e rode, **nesta ordem**:

| Arquivo | O que faz |
|---|---|
| `01_criar_banco.sql` | Cria o banco `ESTOQUE_TI`, o schema `app` e o login `estoque_rw` |
| `02_schema.sql` | Cria as tabelas (patrimônio, movimentação, config, usuário, auditoria) |
| `03_seed.sql` | Cria a configuração inicial e o primeiro administrador |

Os `04_...` em diante são **migrações**: mudanças em um banco que já existe.
Em instalação nova o `02` já vem com tudo, e rodá-los não faz diferença — cada
um confere antes se a mudança já está aplicada. Se você já tinha rodado o `02`
em algum momento, rode todos os `04+` na ordem.

| Migração | Quando precisa |
|---|---|
| `04_migracao_status_mov.sql` | Se o `02` foi rodado antes de a tela de movimentação ganhar o campo Status |

> **Antes de rodar o 01**: troque `TROQUE_ESTA_SENHA` pela senha real do
> `estoque_rw`. É essa senha que vai para o `db.json` do passo 3.

**Conferindo:** o `03` termina imprimindo a contagem de linhas. Deve mostrar
`config = 1` e `usuario = 1`.

Os três scripts podem ser rodados de novo sem estragar nada — tudo é
"se ainda não existir".

---

## 2. Copiar a pasta para o servidor

Copie a pasta inteira do projeto (`versao 1.0`) para o servidor, por exemplo
`C:\apps\inventory-guemat`. Estrutura esperada:

```
inventory-guemat/
├── api/        ← o servidor Node
└── frontend/   ← as telas (servidas pelo próprio Node)
```

Precisa do **Node.js 18 ou mais novo** instalado no servidor
(`node -v` para conferir). Dentro de `api/`:

```
npm install
```

> O `npm install` mostra avisos `EBADENGINE` citando pacotes `@azure/...` que
> pedem Node 22. Pode ignorar: são as dependências de login com Azure AD, que
> este sistema não usa — a conexão é por usuário e senha do SQL Server.

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
guarda a senha do banco.

---

## 4. Subir o servidor

Dê dois cliques em `api/iniciar.bat`, ou:

```
cd api
node server.js
```

Sobe em **http://localhost:3002/** — a porta 3001 é do Gerente Assist, não use.

Abra o endereço no navegador e entre com:

- **usuário:** `admin`
- **senha:** `Trocar@123`

**Troque essa senha no primeiro acesso** (clique no seu nome no topo →
*Alterar senha*). Ela está escrita no `03_seed.sql`, que está no Git.

---

## 5. Deixar rodando sempre

O `iniciar.bat` só mantém o sistema no ar enquanto a janela estiver aberta. Para
subir junto com o servidor, registre como serviço do Windows — o mesmo caminho
que o Gerente Assist já usa nessa máquina (NSSM ou Agendador de Tarefas com
"Executar estando o usuário conectado ou não").

---

## Problemas comuns

**"config/db.json nao encontrado"**
Faltou o passo 3.

**"Login failed for user 'estoque_rw'"**
A senha do `db.json` não bate com a do `CREATE LOGIN`. Para redefinir:
`ALTER LOGIN estoque_rw WITH PASSWORD = 'nova';`

**"Failed to connect to WIN-999I84392IV:1433"**
O SQL Server não está aceitando TCP/IP. No *SQL Server Configuration Manager*:
Protocolos → TCP/IP habilitado, porta 1433, e reinicie o serviço. Confira também
o firewall da máquina.

**"configuracao 'main' nao existe no banco"**
Faltou rodar o `03_seed.sql`.

**Ninguém consegue entrar como admin**
Com o `db.json` já configurado, na pasta `api/`:

```
node criar-admin.js admin NovaSenhaForte "Administrador"
```

Isso recria/reativa a conta como administrador.

**"muitas tentativas — tente novamente em X min"**
Proteção contra chute de senha: 5 erros do mesmo usuário e IP bloqueiam por
10 minutos. Reiniciar o servidor limpa o bloqueio na hora.
