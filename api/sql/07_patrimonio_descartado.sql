-- ============================================================
--  Inventory Guemat - 07: patrimonios descartados
--
--  Rode no banco ESTOQUE_TI. Em instalacao nova o 02_schema.sql ja
--  cria a tabela; rodar de novo nao faz mal.
--
--  POR QUE UMA TABELA SEPARADA: existem bens antigos ja descartados
--  (50562, 50563, 50564...) que precisam continuar documentados. Se
--  entrassem em app.patrimonio, aqueles numeros ficariam ocupados
--  para sempre - e o indice unico ux_patrimonio_numero impediria a
--  numeracao nova de chegar neles um dia.
--
--  A tabela e ILHADA de proposito: nao tem relacao com app.patrimonio
--  nem com app.movimentacao, nada se move de uma para a outra e ela
--  nao entra em nenhuma conta do sistema. E um arquivo morto - serve
--  para consultar o que existiu.
--
--  O numero e unico DENTRO dela (dois registros do mesmo bem antigo
--  sao erro de digitacao), mas o mesmo numero pode existir nas duas
--  tabelas ao mesmo tempo: sao mundos diferentes.
-- ============================================================

USE ESTOQUE_TI;
GO

IF OBJECT_ID('app.patrimonio_descartado') IS NULL
BEGIN
  CREATE TABLE app.patrimonio_descartado (
    id            INT IDENTITY(1,1) CONSTRAINT pk_pat_descartado PRIMARY KEY,
    patrimonio    VARCHAR(50)    NOT NULL,   -- numero antigo, como estava na etiqueta
    nome          VARCHAR(120)   NULL,       -- marca
    modelo        VARCHAR(120)   NULL,
    serie         VARCHAR(120)   NULL,
    categoria     VARCHAR(40)    NULL,       -- id de app.config.cats (opcional)
    data_descarte DATE           NULL,
    motivo        NVARCHAR(500)  NULL,       -- quebrado, doado, vendido, sucata...
    criado_em     DATETIME2(0)   NOT NULL CONSTRAINT df_desc_criado DEFAULT SYSDATETIME(),
    criado_por    VARCHAR(50)    NULL,
    atualizado_em DATETIME2(0)   NOT NULL CONSTRAINT df_desc_atualizado DEFAULT SYSDATETIME()
  );
  PRINT 'Tabela app.patrimonio_descartado criada.';
END
ELSE
  PRINT 'Tabela app.patrimonio_descartado ja existia - nada foi alterado.';
GO

-- Unico DENTRO desta tabela. Nao conversa com ux_patrimonio_numero:
-- o mesmo numero pode estar nas duas, que e justamente o motivo de
-- ela existir.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'ux_descartado_numero' AND object_id = OBJECT_ID('app.patrimonio_descartado'))
  CREATE UNIQUE INDEX ux_descartado_numero ON app.patrimonio_descartado(patrimonio);
GO

PRINT '07 concluido. Reinicie o servico da API.';
GO
