-- ============================================================
--  Inventory Guemat - 06: "Usado em" no almoxarifado
--
--  Rode no banco ESTOQUE_TI, depois do 05. Em instalacao nova o
--  02_schema.sql ja cria a coluna; rodar de novo nao faz mal.
--
--  POR QUE: a tinta Epson 664 e usada na impressora Epson M105. Sem
--  esse vinculo, quem precisa trocar a tinta de uma impressora tem
--  que saber de cabeca qual cartucho ela usa - e quem compra nao tem
--  como conferir se ainda faz sentido manter aquele material em
--  estoque depois que o equipamento saiu de uso.
--
--  GUARDA O MODELO (texto), e nao o id do patrimonio, de proposito:
--    - a tinta serve para QUALQUER impressora daquele modelo; entrou
--      uma M105 nova, o vinculo ja vale para ela;
--    - excluir um patrimonio nao deixa o vinculo apontando para o
--      vazio.
--  Sao poucos modelos por item e a lista e sempre lida inteira, entao
--  fica como JSON numa coluna so - mesma decisao das listas de
--  app.config.
-- ============================================================

USE ESTOQUE_TI;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('app.almoxarifado') AND name = 'usado_em')
BEGIN
  ALTER TABLE app.almoxarifado ADD usado_em NVARCHAR(MAX) NULL;   -- ["Epson M105", ...]
  PRINT 'Coluna app.almoxarifado.usado_em criada.';
END
ELSE
  PRINT 'Coluna app.almoxarifado.usado_em ja existia - nada foi alterado.';
GO

PRINT '06 concluido. Reinicie o servico da API.';
GO
