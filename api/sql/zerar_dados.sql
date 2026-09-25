-- ============================================================
--  Inventory Guemat - ZERAR OS DADOS antes de comecar a valer
--
--  ATENCAO: ESTE SCRIPT APAGA DADOS. NAO TEM VOLTA.
--
--  NAO e uma migracao: nao rode junto com os 01..06 numerados, e nao
--  o rode "por seguranca". Ele serve para UMA situacao - terminar os
--  testes e comecar a producao com o inventario limpo.
--
--  O QUE APAGA:
--    app.auditoria         (o log de quem fez o que)
--    app.patrimonio        + app.movimentacao (o historico vai junto)
--    app.almoxarifado      + app.almoxarifado_mov (lotes e saidas)
--
--  O QUE FICA DE PE:
--    app.usuario  - os logins e senhas continuam valendo
--    app.config   - categorias, categorias do almoxarifado, pessoas,
--                   locais, status e os vinculos Entrada/Saida
--
--  COMO RODAR:
--    1. Abra no SSMS conectado ao SRV do ESTOQUE_TI.
--    2. Confira a contagem que ele imprime ANTES de apagar.
--    3. Troque o @CONFIRMO de 0 para 1 e rode o arquivo INTEIRO.
--       Com 0 ele so mostra o que existe hoje e nao apaga nada.
--    4. Reinicie o servico da API (a tela recarrega sozinha em ate 20s,
--       mas quem estiver com a lista aberta vai ver o que ja sumiu).
-- ============================================================

USE ESTOQUE_TI;

DECLARE @CONFIRMO BIT = 0;   -- <<<<<< TROQUE PARA 1 PARA APAGAR DE VERDADE

-- ------------------------------------------------------------
-- O QUE EXISTE HOJE
-- ------------------------------------------------------------
SELECT 'ANTES' AS momento,
       (SELECT COUNT(*) FROM app.patrimonio)       AS patrimonios,
       (SELECT COUNT(*) FROM app.movimentacao)     AS movimentacoes,
       (SELECT COUNT(*) FROM app.almoxarifado)     AS itens_almox,
       (SELECT COUNT(*) FROM app.almoxarifado_mov) AS mov_almox,
       (SELECT COUNT(*) FROM app.auditoria)        AS auditoria,
       (SELECT COUNT(*) FROM app.usuario)          AS usuarios_que_ficam;

IF @CONFIRMO <> 1
BEGIN
  PRINT '';
  PRINT '>>> NADA FOI APAGADO. <<<';
  PRINT 'Confira os numeros acima. Se for isso mesmo, troque o @CONFIRMO';
  PRINT 'de 0 para 1, no alto do arquivo, e rode de novo.';
END
ELSE
BEGIN
  -- Tudo ou nada: se qualquer passo falhar, nada e apagado. Meio banco
  -- limpo seria pior do que nenhum.
  BEGIN TRY
    BEGIN TRANSACTION;

      -- Filhos primeiro. As duas tabelas tem ON DELETE CASCADE, entao
      -- apagar o pai ja levaria o historico junto; o DELETE explicito
      -- deixa claro o que esta saindo e nao depende da cascata.
      DELETE FROM app.almoxarifado_mov;
      DELETE FROM app.almoxarifado;
      DELETE FROM app.movimentacao;
      DELETE FROM app.patrimonio;

      -- Arquivo morto dos bens antigos (migracao 07). O IF deixa o script
      -- rodar tambem em banco que ainda nao recebeu essa migracao.
      IF OBJECT_ID('app.patrimonio_descartado') IS NOT NULL
      BEGIN
        DELETE FROM app.patrimonio_descartado;
        DBCC CHECKIDENT ('app.patrimonio_descartado', RESEED, 0) WITH NO_INFOMSGS;
      END

      -- A auditoria vai por ultimo: se algo acima falhar, o registro do
      -- que aconteceu ate aqui ainda existe para consultar.
      DELETE FROM app.auditoria;

      -- Numeracao volta a comecar do 1. Sem isto o primeiro patrimonio
      -- da producao nasceria com o id 87, que nao significa nada para
      -- quem le a auditoria depois.
      DBCC CHECKIDENT ('app.patrimonio',       RESEED, 0) WITH NO_INFOMSGS;
      DBCC CHECKIDENT ('app.movimentacao',     RESEED, 0) WITH NO_INFOMSGS;
      DBCC CHECKIDENT ('app.almoxarifado',     RESEED, 0) WITH NO_INFOMSGS;
      DBCC CHECKIDENT ('app.almoxarifado_mov', RESEED, 0) WITH NO_INFOMSGS;
      DBCC CHECKIDENT ('app.auditoria',        RESEED, 0) WITH NO_INFOMSGS;

    COMMIT TRANSACTION;
    PRINT 'Dados zerados. Usuarios e configuracao foram preservados.';
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT 'ERRO - NADA foi apagado:';
    PRINT ERROR_MESSAGE();
  END CATCH
END
GO

-- ------------------------------------------------------------
-- COMO FICOU
-- ------------------------------------------------------------
SELECT 'DEPOIS' AS momento,
       (SELECT COUNT(*) FROM app.patrimonio)       AS patrimonios,
       (SELECT COUNT(*) FROM app.movimentacao)     AS movimentacoes,
       (SELECT COUNT(*) FROM app.almoxarifado)     AS itens_almox,
       (SELECT COUNT(*) FROM app.almoxarifado_mov) AS mov_almox,
       (SELECT COUNT(*) FROM app.auditoria)        AS auditoria,
       (SELECT COUNT(*) FROM app.usuario)          AS usuarios,
       (SELECT COUNT(*) FROM app.config)           AS config;
GO
