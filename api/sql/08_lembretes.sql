-- ============================================================
--  Inventory Guemat - 08: lembretes
--
--  Rode no banco ESTOQUE_TI. Em instalacao nova o 02_schema.sql ja
--  cria a tabela; rodar de novo nao faz mal.
--
--  POR QUE: "trocar o toner da impressora 000012 em marco", "conferir
--  a garantia dos notebooks novos". Hoje isso vive num papel na mesa
--  de quem lembrou - e some junto com o papel.
--
--  Os lembretes sao DE TODOS: quem abre a aba ve os mesmos. O registro
--  guarda quem criou e quem concluiu, que e o que a auditoria precisa.
--
--  O vinculo com um bem e TEXTO ("000012 - Dell Vostro 3520"), e nao
--  um id: excluir o patrimonio nao pode deixar o lembrete apontando
--  para o vazio, e o lembrete continua fazendo sentido depois que o
--  bem sai do inventario.
-- ============================================================

USE ESTOQUE_TI;
GO

IF OBJECT_ID('app.lembrete') IS NULL
BEGIN
  CREATE TABLE app.lembrete (
    id            INT IDENTITY(1,1) CONSTRAINT pk_lembrete PRIMARY KEY,
    data_lembrete DATE            NOT NULL,   -- o dia que ele aparece no calendario
    titulo        VARCHAR(160)    NOT NULL,   -- frase curta; e o que cabe no dia do calendario
    observacoes   NVARCHAR(1000)  NULL,       -- o detalhe
    referencia    VARCHAR(160)    NULL,       -- bem relacionado, como texto (opcional)
    concluido     BIT             NOT NULL CONSTRAINT df_lembrete_concluido DEFAULT 0,
    concluido_em  DATETIME2(0)    NULL,
    concluido_por VARCHAR(50)     NULL,
    criado_em     DATETIME2(0)    NOT NULL CONSTRAINT df_lembrete_criado DEFAULT SYSDATETIME(),
    criado_por    VARCHAR(50)     NULL,
    atualizado_em DATETIME2(0)    NOT NULL CONSTRAINT df_lembrete_atualizado DEFAULT SYSDATETIME()
  );
  PRINT 'Tabela app.lembrete criada.';
END
ELSE
  PRINT 'Tabela app.lembrete ja existia - nada foi alterado.';
GO

-- A tela sempre pergunta por periodo (o mes aberto no calendario) e
-- separa pendente de concluido.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'ix_lembrete_data' AND object_id = OBJECT_ID('app.lembrete'))
  CREATE INDEX ix_lembrete_data ON app.lembrete(data_lembrete, concluido);
GO

PRINT '08 concluido. Reinicie o servico da API.';
GO
