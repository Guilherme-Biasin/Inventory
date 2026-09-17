-- ============================================================
--  Inventory Guemat — 02: tabelas da aplicacao (schema app)
--  Rode no banco ESTOQUE_TI, depois do 01. Roda UMA vez.
--
--  Equivalencia com o Supabase que este sistema usava antes:
--    config          -> app.config
--    patrimonios     -> app.patrimonio
--    movimentacoes   -> app.movimentacao
--    auditoria       -> app.auditoria
--    user_profiles   -> app.usuario   (login curto, sem e-mail)
-- ============================================================

USE ESTOQUE_TI;
GO

-- ------------------------------------------------------------
-- CONFIG — linha unica ('main') com as listas que o usuario monta
-- na aba Personalizar. Sao listas curtas e sempre lidas/gravadas
-- inteiras, entao ficam como JSON em uma linha so, exatamente como
-- era no Supabase. Virar cinco tabelas nao traria nada aqui e
-- quebraria o vinculo por indice que a tela usa para os locais.
-- ------------------------------------------------------------
IF OBJECT_ID('app.config') IS NULL
CREATE TABLE app.config (
  id            VARCHAR(20)   NOT NULL CONSTRAINT pk_config PRIMARY KEY,
  cats          NVARCHAR(MAX) NULL,   -- [{id,name,color}] categorias de patrimonio
  cats_almox    NVARCHAR(MAX) NULL,   -- [{id,name,color}] categorias do almoxarifado
  pessoas       NVARCHAR(MAX) NULL,   -- ["Fulano", ...]
  locais        NVARCHAR(MAX) NULL,   -- ["TI", ...]
  status_opts   NVARCHAR(MAX) NULL,   -- [{id,name,color}]
  vinculos      NVARCHAR(MAX) NULL,   -- {entrada:{statusIds,localIds}, saida:{...}}
  atualizado_em DATETIME2(0)  NOT NULL CONSTRAINT df_config_atualizado DEFAULT SYSDATETIME()
);
GO

-- ------------------------------------------------------------
-- PATRIMONIO — o bem em si. "nome" e a MARCA (a tela chama de
-- Marca desde a versao com modelo); o nome da coluna ficou por
-- compatibilidade com o codigo que ja existia.
-- ------------------------------------------------------------
IF OBJECT_ID('app.patrimonio') IS NULL
CREATE TABLE app.patrimonio (
  id            INT IDENTITY(1,1) CONSTRAINT pk_patrimonio PRIMARY KEY,
  patrimonio    VARCHAR(50)   NOT NULL,   -- numero de patrimonio
  nome          VARCHAR(120)  NULL,       -- marca
  modelo        VARCHAR(120)  NULL,
  serie         VARCHAR(120)  NULL,
  categoria     VARCHAR(40)   NULL,       -- id de app.config.cats
  status        VARCHAR(40)   NULL,       -- id de app.config.status_opts
  local_atual   VARCHAR(120)  NULL,
  usuario_atual VARCHAR(120)  NULL,
  criado_em     DATETIME2(0)  NOT NULL CONSTRAINT df_pat_criado DEFAULT SYSDATETIME(),
  criado_por    VARCHAR(50)   NULL,
  atualizado_em DATETIME2(0)  NOT NULL CONSTRAINT df_pat_atualizado DEFAULT SYSDATETIME()
);
GO

-- Dois patrimonios com o mesmo numero e sempre erro de digitacao —
-- e o numero e justamente como a etiqueta e o leitor de codigo de
-- barras encontram o bem. O banco recusa a duplicata na hora; a
-- importacao em massa apenas pula a linha e mostra o motivo.
--
-- Se algum dia precisar mesmo repetir o numero, apague este indice:
--   DROP INDEX ux_patrimonio_numero ON app.patrimonio;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_patrimonio_numero' AND object_id = OBJECT_ID('app.patrimonio'))
  CREATE UNIQUE INDEX ux_patrimonio_numero ON app.patrimonio(patrimonio);
GO

-- Busca por numero de serie na tela de lista.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_patrimonio_serie' AND object_id = OBJECT_ID('app.patrimonio'))
  CREATE INDEX ix_patrimonio_serie ON app.patrimonio(serie);
GO

-- ------------------------------------------------------------
-- MOVIMENTACAO — o historico. ON DELETE CASCADE reproduz o
-- comportamento do Supabase: apagar o patrimonio leva o historico
-- junto (a tela avisa disso antes de excluir).
-- ------------------------------------------------------------
IF OBJECT_ID('app.movimentacao') IS NULL
CREATE TABLE app.movimentacao (
  id                   INT IDENTITY(1,1) CONSTRAINT pk_movimentacao PRIMARY KEY,
  patrimonio_id        INT           NOT NULL,
  tipo                 VARCHAR(20)   NOT NULL,   -- 'entrada' | 'movimentacao'
  data_mov             DATE          NULL,
  quem_recebeu_retirou VARCHAR(20)   NULL,       -- 'Entrada' | 'Saída'
  usuario_atual        VARCHAR(120)  NULL,
  [local]              VARCHAR(120)  NULL,
  status               VARCHAR(40)   NULL,       -- status do bem NESTE momento
  obs_mov              NVARCHAR(1000) NULL,
  criado_em            DATETIME2(0)  NOT NULL CONSTRAINT df_mov_criado DEFAULT SYSDATETIME(),
  criado_por           VARCHAR(50)   NULL,
  CONSTRAINT fk_mov_patrimonio FOREIGN KEY (patrimonio_id)
    REFERENCES app.patrimonio(id) ON DELETE CASCADE
);
GO

-- O historico e sempre lido por patrimonio e em ordem de criacao.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_mov_patrimonio' AND object_id = OBJECT_ID('app.movimentacao'))
  CREATE INDEX ix_mov_patrimonio ON app.movimentacao(patrimonio_id, criado_em);
GO

-- ------------------------------------------------------------
-- USUARIO — login proprio, no lugar do Supabase Auth.
-- A senha NUNCA e guardada em texto: a API grava o hash scrypt
-- com sal (mesmo esquema do Gerente Assist).
--
-- papel: 'admin' | 'editor' | 'leitor'
--   leitor -> so consulta e exporta
--   editor -> cadastra, edita, movimenta, importa, personaliza
--   admin  -> tudo, mais excluir patrimonio e gerenciar usuarios
-- ------------------------------------------------------------
IF OBJECT_ID('app.usuario') IS NULL
CREATE TABLE app.usuario (
  usuario_id INT IDENTITY(1,1) CONSTRAINT pk_usuario PRIMARY KEY,
  login      VARCHAR(50)  NOT NULL CONSTRAINT uq_usuario_login UNIQUE,
  senha_hash VARCHAR(255) NOT NULL,
  nome       VARCHAR(100) NULL,
  papel      VARCHAR(10)  NOT NULL CONSTRAINT df_usuario_papel DEFAULT 'leitor',
  ativo      BIT          NOT NULL CONSTRAINT df_usuario_ativo DEFAULT 1,
  criado_em  DATETIME2(0) NOT NULL CONSTRAINT df_usuario_criado DEFAULT SYSDATETIME(),
  CONSTRAINT ck_usuario_papel CHECK (papel IN ('admin','editor','leitor'))
);
GO

-- ------------------------------------------------------------
-- AUDITORIA — quem fez o que.
--
-- No Supabase isto era gatilho no banco. Aqui quem grava e a API,
-- de proposito: o gatilho nao sabe QUEM esta logado no aplicativo
-- (todas as conexoes chegam como estoque_rw), entao a coluna de
-- autor sairia sempre igual. A API sabe, porque o token traz o
-- login — e e ela que monta a descricao em portugues.
-- ------------------------------------------------------------
IF OBJECT_ID('app.auditoria') IS NULL
CREATE TABLE app.auditoria (
  id           BIGINT IDENTITY(1,1) CONSTRAINT pk_auditoria PRIMARY KEY,
  tabela       VARCHAR(40)   NOT NULL,   -- 'patrimonio' | 'movimentacao' | 'config' | 'usuario'
  registro_id  VARCHAR(40)   NULL,
  acao         VARCHAR(10)   NOT NULL,   -- 'INSERT' | 'UPDATE' | 'DELETE'
  descricao    NVARCHAR(400) NULL,
  dados_antes  NVARCHAR(MAX) NULL,
  dados_depois NVARCHAR(MAX) NULL,
  usuario      VARCHAR(50)   NULL,       -- login de quem fez
  criado_em    DATETIME2(0)  NOT NULL CONSTRAINT df_aud_criado DEFAULT SYSDATETIME()
);
GO

-- A tela abre a auditoria pelos mais recentes; sem este indice a
-- consulta varre a tabela inteira e fica lenta com o tempo.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_auditoria_criado' AND object_id = OBJECT_ID('app.auditoria'))
  CREATE INDEX ix_auditoria_criado ON app.auditoria(criado_em DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_auditoria_registro' AND object_id = OBJECT_ID('app.auditoria'))
  CREATE INDEX ix_auditoria_registro ON app.auditoria(tabela, registro_id);
GO

-- ------------------------------------------------------------
-- ALMOXARIFADO (materiais de consumo) — bobina, etiqueta, saco
-- plastico, tinta, toner. Separado do patrimonio porque aqui o que
-- importa e QUANTIDADE e VALIDADE, nao o bem individual: cada
-- entrada e um LOTE com a sua validade, e cada saida diz de qual
-- lote saiu.
--
-- O detalhe de cada decisao esta em 05_almoxarifado.sql, que aplica
-- o mesmo em bancos que ja existiam.
-- ------------------------------------------------------------
IF OBJECT_ID('app.almoxarifado') IS NULL
CREATE TABLE app.almoxarifado (
  id            INT IDENTITY(1,1) CONSTRAINT pk_almoxarifado PRIMARY KEY,
  item          VARCHAR(120)   NOT NULL,
  categoria     VARCHAR(40)    NULL,       -- id de app.config.cats_almox
  modelo        VARCHAR(120)   NULL,
  serie         VARCHAR(120)   NULL,
  obs           NVARCHAR(1000) NULL,       -- observacoes de cadastro
  criado_em     DATETIME2(0)   NOT NULL CONSTRAINT df_almox_criado DEFAULT SYSDATETIME(),
  criado_por    VARCHAR(50)    NULL,
  atualizado_em DATETIME2(0)   NOT NULL CONSTRAINT df_almox_atualizado DEFAULT SYSDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_almox_item' AND object_id = OBJECT_ID('app.almoxarifado'))
  CREATE UNIQUE INDEX ux_almox_item ON app.almoxarifado(item);
GO

-- Filtrado: varios itens podem ficar sem serie, mas serie preenchida
-- nao se repete.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_almox_serie' AND object_id = OBJECT_ID('app.almoxarifado'))
  CREATE UNIQUE INDEX ux_almox_serie ON app.almoxarifado(serie) WHERE serie IS NOT NULL;
GO

IF OBJECT_ID('app.almoxarifado_mov') IS NULL
CREATE TABLE app.almoxarifado_mov (
  id          INT IDENTITY(1,1) CONSTRAINT pk_almox_mov PRIMARY KEY,
  almox_id    INT            NOT NULL,
  tipo        VARCHAR(10)    NOT NULL,   -- 'entrada' | 'saida'
  data_mov    DATE           NULL,
  validade    DATE           NULL,       -- so na entrada (lote)
  quantidade  DECIMAL(12,2)  NOT NULL,
  lote_id     INT            NULL,       -- saida: id da entrada de onde saiu
  usuario     VARCHAR(120)   NULL,
  obs_mov     NVARCHAR(1000) NULL,
  criado_em   DATETIME2(0)   NOT NULL CONSTRAINT df_almox_mov_criado DEFAULT SYSDATETIME(),
  criado_por  VARCHAR(50)    NULL,
  CONSTRAINT fk_almox_mov_item FOREIGN KEY (almox_id)
    REFERENCES app.almoxarifado(id) ON DELETE CASCADE,
  CONSTRAINT ck_almox_mov_tipo CHECK (tipo IN ('entrada','saida')),
  CONSTRAINT ck_almox_mov_qtd CHECK (quantidade > 0)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_almox_mov_item' AND object_id = OBJECT_ID('app.almoxarifado_mov'))
  CREATE INDEX ix_almox_mov_item ON app.almoxarifado_mov(almox_id, criado_em);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_almox_mov_lote' AND object_id = OBJECT_ID('app.almoxarifado_mov'))
  CREATE INDEX ix_almox_mov_lote ON app.almoxarifado_mov(lote_id);
GO

PRINT '02 concluido. Rode agora o 03_seed.sql.';
GO
