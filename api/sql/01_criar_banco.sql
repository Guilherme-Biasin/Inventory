-- ============================================================
--  Inventory Guemat — 01: cria o BANCO e o usuario da aplicacao
--  Rode no SSMS conectado a instancia (WIN-999I84392IV), com um
--  login que seja sysadmin. Roda UMA vez.
--
--  Este banco e SEPARADO do OFICIAL (ERP) de proposito: o estoque
--  de TI nao compartilha tabelas, backup nem permissao com o ERP.
-- ============================================================

USE master;
GO

IF DB_ID('ESTOQUE_TI') IS NULL
BEGIN
  CREATE DATABASE ESTOQUE_TI;
  PRINT 'Banco ESTOQUE_TI criado.';
END
ELSE
  PRINT 'Banco ESTOQUE_TI ja existia — nada foi alterado.';
GO

-- ------------------------------------------------------------
-- LOGIN da aplicacao.
--
-- ANTES DE RODAR: troque a senha abaixo. Ela vai para dentro de
-- api/config/db.json e e a unica coisa que separa o banco de quem
-- estiver na rede — 'TROQUE_ESTA_SENHA' literal e o mesmo que
-- deixar aberto.
--
-- A senha precisa passar na politica do Windows (maiuscula,
-- minuscula, numero/simbolo, 8+ caracteres). Se der erro de
-- politica, escolha uma senha mais forte em vez de desligar a
-- verificacao.
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'estoque_rw')
BEGIN
  CREATE LOGIN estoque_rw WITH PASSWORD = 'TROQUE_ESTA_SENHA';
  PRINT 'Login estoque_rw criado.';
END
ELSE
  PRINT 'Login estoque_rw ja existia.';
GO

USE ESTOQUE_TI;
GO

IF SCHEMA_ID('app') IS NULL EXEC('CREATE SCHEMA app');
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'estoque_rw')
BEGIN
  CREATE USER estoque_rw FOR LOGIN estoque_rw WITH DEFAULT_SCHEMA = app;
  PRINT 'Usuario estoque_rw criado no banco ESTOQUE_TI.';
END
GO

-- Permissao SO no schema app. Sem db_owner: se a API for invadida,
-- o atacante nao consegue criar tabela, apagar o banco nem enxergar
-- qualquer outro schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::app TO estoque_rw;
GO

PRINT '01 concluido. Rode agora o 02_schema.sql.';
GO
