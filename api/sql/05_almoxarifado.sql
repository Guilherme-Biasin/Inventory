-- ============================================================
--  Inventory Guemat - 05: ALMOXARIFADO (materiais de consumo)
--
--  Rode no banco ESTOQUE_TI, depois do 04. Em instalacao nova o
--  02_schema.sql ja cria tudo isto; rodar de novo nao faz mal,
--  cada bloco confere antes se ja existe.
--
--  POR QUE UMA ESTRUTURA SEPARADA DO PATRIMONIO:
--  patrimonio e bem unico (um notebook, uma impressora) e anda de
--  um lugar para outro. Almoxarifado e material de consumo
--  (bobina, etiqueta, saco plastico, tinta, toner): tem QUANTIDADE,
--  entra em LOTES e cada lote tem a sua validade. Misturar os dois
--  na mesma tabela encheria o patrimonio de colunas vazias.
-- ============================================================

USE ESTOQUE_TI;
GO

-- ------------------------------------------------------------
-- ITEM do almoxarifado. O saldo NAO fica aqui: e sempre somado
-- das movimentacoes (entradas - saidas). Guardar o saldo em
-- coluna significa ter duas versoes da verdade, e uma delas
-- envelhece no primeiro erro.
-- ------------------------------------------------------------
IF OBJECT_ID('app.almoxarifado') IS NULL
CREATE TABLE app.almoxarifado (
  id            INT IDENTITY(1,1) CONSTRAINT pk_almoxarifado PRIMARY KEY,
  item          VARCHAR(120)   NOT NULL,   -- "Bobina 80mm", "Toner HP 26A"
  categoria     VARCHAR(40)    NULL,       -- id de app.config.cats_almox
  modelo        VARCHAR(120)   NULL,
  serie         VARCHAR(120)   NULL,
  obs           NVARCHAR(1000) NULL,       -- observacoes de cadastro
  criado_em     DATETIME2(0)   NOT NULL CONSTRAINT df_almox_criado DEFAULT SYSDATETIME(),
  criado_por    VARCHAR(50)    NULL,
  atualizado_em DATETIME2(0)   NOT NULL CONSTRAINT df_almox_atualizado DEFAULT SYSDATETIME()
);
GO

-- Item repetido e sempre cadastro duplicado: o saldo passaria a
-- existir em dois lugares e nenhum dos dois estaria certo.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_almox_item' AND object_id = OBJECT_ID('app.almoxarifado'))
  CREATE UNIQUE INDEX ux_almox_item ON app.almoxarifado(item);
GO

-- Numero de serie tambem nao se repete - mas so quando preenchido.
-- O indice FILTRADO deixa varios itens sem serie conviverem; um
-- indice unico comum recusaria o segundo NULL.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_almox_serie' AND object_id = OBJECT_ID('app.almoxarifado'))
  CREATE UNIQUE INDEX ux_almox_serie ON app.almoxarifado(serie) WHERE serie IS NOT NULL;
GO

-- ------------------------------------------------------------
-- MOVIMENTACAO. Cada ENTRADA e um LOTE: tem quantidade e validade
-- propria (dois toners iguais comprados em meses diferentes vencem
-- em datas diferentes). Cada SAIDA aponta, em lote_id, de qual
-- entrada saiu - quem registra escolhe o lote na tela.
--
-- lote_id NAO tem chave estrangeira de proposito: ela apontaria
-- para esta mesma tabela e entraria em conflito com o ON DELETE
-- CASCADE vindo de app.almoxarifado (o SQL Server nao garante
-- apagar as saidas antes das entradas). A ligacao e conferida pela
-- API, que so aceita lote do mesmo item.
-- ------------------------------------------------------------
IF OBJECT_ID('app.almoxarifado_mov') IS NULL
CREATE TABLE app.almoxarifado_mov (
  id          INT IDENTITY(1,1) CONSTRAINT pk_almox_mov PRIMARY KEY,
  almox_id    INT            NOT NULL,
  tipo        VARCHAR(10)    NOT NULL,   -- 'entrada' | 'saida'
  data_mov    DATE           NULL,
  validade    DATE           NULL,       -- so faz sentido na entrada (lote)
  quantidade  DECIMAL(12,2)  NOT NULL,
  lote_id     INT            NULL,       -- saida: id da entrada de onde saiu
  usuario     VARCHAR(120)   NULL,       -- quem levou / quem recebeu
  obs_mov     NVARCHAR(1000) NULL,
  criado_em   DATETIME2(0)   NOT NULL CONSTRAINT df_almox_mov_criado DEFAULT SYSDATETIME(),
  criado_por  VARCHAR(50)    NULL,
  CONSTRAINT fk_almox_mov_item FOREIGN KEY (almox_id)
    REFERENCES app.almoxarifado(id) ON DELETE CASCADE,
  CONSTRAINT ck_almox_mov_tipo CHECK (tipo IN ('entrada','saida')),
  -- Quantidade zero ou negativa nao e movimentacao: e erro de
  -- digitacao que viraria saldo errado para sempre.
  CONSTRAINT ck_almox_mov_qtd CHECK (quantidade > 0)
);
GO

-- O historico e sempre lido por item, em ordem de criacao.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_almox_mov_item' AND object_id = OBJECT_ID('app.almoxarifado_mov'))
  CREATE INDEX ix_almox_mov_item ON app.almoxarifado_mov(almox_id, criado_em);
GO

-- Saldo de um lote = quantidade da entrada - saidas com este lote_id.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_almox_mov_lote' AND object_id = OBJECT_ID('app.almoxarifado_mov'))
  CREATE INDEX ix_almox_mov_lote ON app.almoxarifado_mov(lote_id);
GO

-- ------------------------------------------------------------
-- CATEGORIAS DO ALMOXARIFADO: lista propria, separada da dos
-- patrimonios. "Bobina" e "Toner" nao tem nada que fazer no filtro
-- de patrimonio, e "Notebook" nao e material de consumo.
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('app.config') AND name = 'cats_almox')
BEGIN
  ALTER TABLE app.config ADD cats_almox NVARCHAR(MAX) NULL;
  PRINT 'Coluna app.config.cats_almox criada.';
END
ELSE
  PRINT 'Coluna app.config.cats_almox ja existia.';
GO

-- Lista inicial, so se ainda estiver vazia. Tudo editavel depois na
-- aba Personalizar.
UPDATE app.config
   SET cats_almox = N'[{"id":"a1","name":"Bobina","color":"#2563eb"},
     {"id":"a2","name":"Etiqueta","color":"#7c3aed"},
     {"id":"a3","name":"Saco plastico","color":"#0891b2"},
     {"id":"a4","name":"Tinta de impressora","color":"#d97706"},
     {"id":"a5","name":"Toner","color":"#059669"},
     {"id":"a6","name":"Material de escritorio","color":"#64748b"}]'
 WHERE id = 'main' AND (cats_almox IS NULL OR cats_almox = '' OR cats_almox = '[]');
GO

PRINT '05 concluido. Almoxarifado pronto - reinicie o servico da API.';
GO
