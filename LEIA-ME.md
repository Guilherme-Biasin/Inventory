# Inventory Guemat — estoque de TI

Controle de patrimônio de TI: cadastro dos bens, histórico de movimentações,
importação por planilha, auditoria e leitura de código de barras pelo celular.

O sistema **saiu do Supabase** e agora roda inteiro na empresa: banco
`ESTOQUE_TI` no SQL Server do servidor, separado do banco `OFICIAL` do ERP.

**Para instalar, siga [api/sql/INSTALACAO.md](api/sql/INSTALACAO.md).**

---

## Produção

| | Onde |
|---|---|
| Endereço | **https://inventory.guematpro.com** |
| Tela e API | mesma origem — o Node entrega as duas |
| Máquina | VM do Gerente Assist, pasta `C:\guemat-estoque` |
| Serviço | `InventoryGuemat` (NSSM), porta 3002 |
| HTTPS | túnel Cloudflare → `localhost:3002` |
| Banco | `ESTOQUE_TI` em `192.168.0.220` |

A Vercel **não** participa mais: até a migração ela publicava a tela estática que
falava direto com o Supabase. Hoje a tela precisa da API na mesma origem, então
o domínio aponta para o túnel e o projeto da Vercel foi desligado.

O HTTPS não é preferência: o leitor de código de barras usa a câmera, e o
navegador só libera a câmera em `https://` (ou `localhost`). Por `http://ip:3002`
o leitor avisa o motivo e não abre.

**Para atualizar** — o `git push` sozinho não muda nada em produção, porque as
telas são servidas pelo próprio Node. Vale inclusive para mudança só de CSS:

```bash
git push origin main                      # no notebook
```
```bash
cd C:\guemat-estoque && git pull          # na VM
```
```bash
C:\ferramentas\nssm.exe restart InventoryGuemat
```

Se o serviço não subir, o motivo está em `C:\guemat-estoque\api\log.txt`.

---

## Como está organizado

```
versao 1.0/
├── api/                      ← servidor Node (também entrega as telas)
│   ├── server.js               registro das rotas, login, permissões, gzip
│   ├── config/
│   │   ├── db.example.json     modelo — copie para db.json e preencha
│   │   └── db.json             SENHA DO BANCO (fora do Git)
│   ├── sql/                    scripts para rodar no SSMS, na ordem 01→02→03
│   ├── testes/                 npm test — roda sem precisar de banco
│   ├── src/
│   │   ├── db.js               conexão com o SQL Server
│   │   ├── auth.js             hash de senha e token
│   │   ├── authRoutes.js       login, /eu, trocar senha
│   │   ├── configRoutes.js     aba Personalizar
│   │   ├── patrimoniosRoutes.js  patrimônios, movimentações, importação
│   │   ├── usuariosRoutes.js   aba Usuários
│   │   └── auditoria.js        registro e consulta da auditoria
│   ├── criar-admin.js          resgate: recria o admin pela linha de comando
│   └── iniciar.bat             sobe o servidor na porta 3002
└── frontend/                 ← as telas
    ├── index.html
    ├── css/style.css
    └── js/
        ├── api-config.js       conversa com a API (era supabase-config.js)
        ├── app.js              a aplicação
        └── mobile-scanner.js   leitor de código de barras
```

O Node entrega o `frontend/` e a API na **mesma porta (3002)**, então não há
CORS para configurar. A porta **3001 é do Gerente Assist** — não use.

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

---

## O que mudou em relação à versão do Supabase

| Antes (Supabase) | Agora |
|---|---|
| Banco na nuvem, projeto do Supabase | SQL Server `ESTOQUE_TI`, no servidor da empresa |
| Login por e-mail (Supabase Auth) | Login curto (`admin`, `alex.guedes`) na tabela `app.usuario` |
| Regras de acesso só na tela | Papel conferido no servidor a cada chamada |
| Auditoria por gatilho no banco | Auditoria escrita pela API, com o autor certo e descrição em português |
| Atualização em tempo real (realtime) | Consulta leve a cada 20s; recarrega só quando algo muda |
| Movimentar não mudava o status do bem | A tela de movimentação tem campo **Status**, e o histórico guarda o estado de cada movimentação |
| Navegador falava direto com o banco | Navegador fala só com a API; a senha do banco não sai do servidor |

O primeiro acesso é `admin` / `Trocar@123`. **Troque no primeiro login** — essa
senha está no `03_seed.sql`, que está no Git.
