-- ============================================================
--  Inventory Guemat — 04: status na movimentacao
--
--  Rode SOMENTE se voce ja tinha rodado o 02_schema.sql ANTES desta
--  mudanca. Em instalacao nova nao precisa: o 02 ja cria a coluna.
--
--  Rodar sem necessidade nao faz mal — o script confere se a coluna
--  existe antes de criar.
--
--  POR QUE: ate aqui a tela "Registrar Movimentacao" nao deixava
--  mudar o status do bem. Um notebook que ia para manutencao
--  continuava marcado como "Em uso" ate alguem lembrar de abrir a
--  edicao e trocar a mao. Agora o status muda junto da movimentacao,
--  e a coluna abaixo guarda em que estado o bem ficou NAQUELE
--  momento — sem ela, o historico so mostraria o estado de hoje.
-- ============================================================

USE ESTOQUE_TI;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('app.movimentacao') AND name = 'status')
BEGIN
  ALTER TABLE app.movimentacao ADD status VARCHAR(40) NULL;
  PRINT 'Coluna app.movimentacao.status criada.';
END
ELSE
  PRINT 'Coluna app.movimentacao.status ja existia — nada foi alterado.';
GO
