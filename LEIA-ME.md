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

O leitor aparece em dois lugares: no campo **N° de Série** do cadastro, para
não digitar o número, e ao lado da **busca** das listas de Patrimônios e
Almoxarifado — ali ele lê a etiqueta do bem e a lista já filtra para ele.

### Variáveis do serviço na VM (obrigatórias)

Como a tela (Vercel) e a API (VM) estão em endereços diferentes, o serviço
`InventoryGuemat` precisa destas variáveis de ambiente:

| Variável | Valor | Sem ela |
|---|---|---|
| `ORIGENS_PERMITIDAS` | `https://inventory.guematpro.com,https://inventory-guemat-*.vercel.app` | O navegador bloqueia toda chamada da tela à API (CORS) e nada carrega |
| `ATRAS_DE_PROXY` | `1` | Todo mundo chega com o IP do túnel: 5 senhas erradas de **uma** pessoa bloqueiam o login de **todas** por 10 minutos |
| `SOMENTE_LEITURA` | *(não definir)* | — em produção a gravação fica ligada |

Para conferir ou definir (Prompt de Comando **como administrador**, na VM):

```bash
C:\ferramentas\nssm.exe get InventoryGuemat AppEnvironmentExtra
```
```bash
C:\ferramentas\nssm.exe set InventoryGuemat AppEnvironmentExtra PORT=3002 ORIGENS_PERMITIDAS=https://inventory.guematpro.com ATRAS_DE_PROXY=1
```

O `set` **substitui a lista inteira**: sempre repita todas as variáveis, não só
a que mudou.

> O curinga `inventory-guemat-*.vercel.app` só vale se o projeto na Vercel tiver
> esse nome. Confira no painel da Vercel e ajuste o padrão.

### Para atualizar

```bash
git push origin main
```

Isso publica **a tela** na hora (Vercel). Mudança na **API** exige, além do
push, atualizar a VM. Prompt de Comando (cmd) **como administrador**, igual ao
Gerente Assist:

```bash
cd C:\guemat-estoque && git pull && nssm restart InventoryGuemat
```

O `nssm` curto funciona porque existe uma **cópia do `nssm.exe` dentro de
`C:\guemat-estoque`**: o cmd procura o programa primeiro na pasta atual, e o
`cd` do começo garante que você está nela. É o mesmo arranjo do GA
(`C:\guemat-assist\nssm.exe`). Sem a cópia, o `nssm` sozinho dá "não é
reconhecido como comando" — e o `git pull` passa, mas o serviço **não
reinicia** e continua rodando a versão velha.

- A cópia está no `.gitignore`: nunca vai para o GitHub e não atrapalha o pull.
- **Não apague o `C:\ferramentas\nssm.exe`.** O serviço `InventoryGuemat` foi
  instalado a partir dele; o Windows executa aquele arquivo para iniciar o
  serviço. A cópia na pasta do projeto é só para digitar o comando curto.
- Use o **cmd**, não o PowerShell: o PowerShell do Windows não aceita `&&`, e
  também não roda programa da pasta atual sem `.\` na frente.

Como os dois lados sobem separados, dá para a tela estar numa versão e a API
noutra. Ao mexer nos dois no mesmo commit, atualize a VM logo depois do push.
Se o serviço não subir, o motivo está em `C:\guemat-estoque\api\log.txt`.

A tela não fica velha por cache: o servidor manda o navegador **conferir** cada
arquivo antes de reaproveitar (`Cache-Control: no-cache` + `ETag`). Quando nada
mudou, a resposta é um `304` sem conteúdo, então conferir custa quase nada. Isso
evita o caso em que o `app.js` novo convive com o `style.css` velho e a tela
parece quebrada com o código certo.

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
│   │   ├── almoxarifadoRoutes.js almoxarifado: itens, lotes, saldo, importação
│   │   ├── usuariosRoutes.js    aba Usuários
│   │   └── auditoria.js         registro e consulta da auditoria
│   ├── criar-admin.js           cria o 1º admin / resgata o acesso de admin
│   ├── iniciar.bat              servidor — GRAVA no banco
│   └── iniciar-leitura.bat      notebook — só leitura
└── frontend/                  as telas
    ├── index.html
    ├── img/                     ícone "G" da Guemat (versão clara e escura)
    ├── css/style.css
    └── js/
        ├── config.js            endereço da API conforme o domínio
        ├── api-config.js        conversa com a API
        ├── seletor.js           lista suspensa e calendário próprios
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

## Personalizar: editar e excluir opções

Toda opção (categoria, categoria do almoxarifado, pessoa, local, status) tem
**✎ editar** e **× excluir**. Antes só havia o ×, e corrigir um nome obrigava a
excluir e criar de novo — o que troca o id da opção e deixa os patrimônios que
a usavam apontando para o vazio.

**Renomear categoria, categoria do almoxarifado ou status** é simples: o
registro guarda o **id**, então tudo que já existe passa a mostrar o nome (e a
cor) novos sozinho.

**Renomear local ou pessoa mexe nos registros.** Esses dois são guardados como
**texto** dentro do patrimônio e das movimentações, então a API troca o nome
antigo pelo novo em `app.patrimonio`, `app.movimentacao` e
`app.almoxarifado_mov` — tudo numa transação, com o total de linhas alteradas
na auditoria. Sem isso, a lista teria o nome novo e o histórico o antigo.

**Excluir é recusado enquanto a opção estiver em uso.** A tela diz quantos
registros usam e pede para trocá-los antes; estando livre, ainda pede
confirmação. "Em uso" é o que aponta para ela **hoje** — histórico não conta,
senão um local antigo nunca mais poderia ser excluído.

---

## Regras do bloco "Dados da Movimentação"

- **Local Atual é obrigatório** no cadastro, na edição e no Movimentar. Bem sem
  lugar é bem que ninguém acha depois.
- **Usuário Atual em branco limpa o campo.** Deixar vazio quer dizer "não está
  com ninguém"; antes o sistema mantinha o último nome e seguia mostrando quem
  já tinha devolvido o bem. Local e Status continuam só sendo sobrescritos
  quando vêm preenchidos (o Status tem a opção "manter o atual").
- **Data de Movimentação e o tipo andam juntos**: preencher um exige o outro,
  e deixar os dois em branco é permitido (a edição não registra movimentação
  nenhuma). No cadastro novo a regra não vale, porque ali o tipo já é sempre
  **Entrada**.

---

## Vínculos de Entrada, Saída e Movimentação

O campo chama-se **"Entrada, saída ou movimentação?"** e tem três opções:
entrada (o bem chegou), saída (o bem saiu) e **movimentação** (mudou de lugar
ou de pessoa sem entrar nem sair).

Em **Personalizar → Vínculos** dá para dizer quais Status e quais Locais ficam
disponíveis em cada uma das três. Deixar tudo desmarcado = sem restrição.

O filtro vale **onde a pessoa escolhe o tipo na hora**: Movimentar e a
edição do patrimônio. O **cadastro de um patrimônio novo mostra sempre a lista
inteira** de locais e status. Por um tempo ele também filtrava (o cadastro é
sempre uma entrada, então parecia coerente), e o efeito foi um vínculo marcado
meses antes esconder quase todos os locais na hora de cadastrar, sem que quem
estava cadastrando tivesse como saber por quê.

---

## Almoxarifado (material de consumo)

Aba própria, ao lado de Patrimônios, para o que é consumido: bobina, etiqueta,
saco plástico, tinta, toner. A diferença para o patrimônio é o que se controla:

| | Patrimônio | Almoxarifado |
|---|---|---|
| Unidade | o bem, um a um | **quantidade** |
| Campos | Nº, Marca, Modelo, Série, Categoria, Status | **Item**, Categoria, Modelo, Série, Usado em, Observações |
| Movimentação | para onde foi e com quem | **entrada** (soma) ou **saída** (desconta) |
| Data | de movimentação | de movimentação e **de validade** |

**O estoque é por lote.** Cada entrada é um lote, com a sua validade e a sua
quantidade — dois toners iguais comprados em meses diferentes vencem em datas
diferentes. Na saída, quem registra **escolhe de qual lote sai**; os que vencem
primeiro aparecem no topo da lista. O saldo do item é a soma do que resta em
cada lote, e a lista mostra a validade mais próxima a vencer, em verde, âmbar
(30 dias ou menos) ou vermelho (vencido).

**Uma compra nova pode entrar num lote que já existe.** Quando é o mesmo lote de
verdade — mesma validade —, a entrada tem um campo *Somar a um lote?*: em branco
abre um lote novo, escolhendo um dos abertos a quantidade soma nele e a validade
continua sendo a do lote. Na tela o lote é um cartão só, que abre mostrando
todas as movimentações dele (as entradas que somaram e as saídas que saíram).

**Lote cadastrado errado se corrige no próprio lote.** Abrindo o lote dentro de
Editar item há um botão *Editar lote*, que altera validade, data da entrada,
usuário e observações. A **quantidade fica de fora**: o saldo é a soma das
movimentações, então quantidade errada se acerta com uma entrada ou saída nova,
nunca reescrevendo a que já existe. A correção vai para a auditoria com o antes
e o depois.

O servidor recusa saída maior do que o lote tem e diz quanto existe: **saldo
não fica negativo**. O saldo nunca é gravado em coluna — é sempre somado das
movimentações, para não existirem duas versões da mesma verdade.

Nem o nome do item nem o número de série se repetem. Quem tenta cadastrar de
novo um material que já existe é orientado a registrar uma **entrada** no item
existente, que é o que faz o saldo somar em vez de duplicar.

**Item, Categoria, Modelo e N° de Série são obrigatórios**, na tela e na
planilha de importação. Item e série também não podem repetir.

**"Usado em"** liga o material aos equipamentos: a tinta Epson 664 é usada na
impressora Epson M105. O campo é opcional (nem todo material tem equipamento) e
só deixa **escolher da lista** dos modelos já cadastrados em Patrimônios — dá
para marcar vários, e eles aparecem como etiquetas. O vínculo é pelo **modelo**,
não pelo bem: a tinta serve para qualquer M105, inclusive uma que entre depois,
e excluir uma impressora não deixa o vínculo apontando para o vazio. Na
planilha, a coluna aceita vários modelos separados por `|`. Precisa da migração
`api/sql/06_almox_usado_em.sql`.

As categorias do almoxarifado são uma lista separada, em **Personalizar ›
Categorias do almoxarifado**. Exportar, Importar, Auditoria, permissões e o
leitor de código de barras funcionam igual aos do patrimônio.

Precisa da migração `api/sql/05_almoxarifado.sql`. Sem ela, a aba abre
explicando o que falta e o resto do sistema continua funcionando.

---

## Zerar os dados antes de começar a valer

Depois dos testes, `api/sql/zerar_dados.sql` deixa o banco limpo para a
produção começar do zero. Ele apaga **patrimônios, movimentações, almoxarifado,
lotes e a auditoria**, e faz a numeração recomeçar do 1. Continuam de pé os
**usuários** (logins e senhas) e a **configuração** — categorias, categorias do
almoxarifado, pessoas, locais, status e os vínculos Entrada/Saída.

É a única coisa do projeto que apaga dado, então ele tem uma trava: só apaga
depois que você troca `@CONFIRMO` de `0` para `1` dentro do arquivo. Com `0`,
rodar o script apenas mostra a contagem do que existe hoje. Tudo acontece numa
transação: se qualquer passo falhar, nada é apagado.

**Não tem volta.** Se quiser poder voltar atrás, faça um backup do banco antes.
Depois de rodar, reinicie o serviço da API.

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
