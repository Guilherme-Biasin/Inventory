-- ============================================================
--  Inventory Guemat — 03: dados iniciais
--  Rode no banco ESTOQUE_TI, depois do 02. Roda UMA vez.
--
--  Cria a linha de configuracao e o PRIMEIRO administrador.
--  Tudo aqui e "se ainda nao existir": rodar de novo nao duplica
--  nem sobrescreve o que voce ja cadastrou.
-- ============================================================

USE ESTOQUE_TI;
GO

-- ------------------------------------------------------------
-- Linha unica de configuracao. A aplicacao SEMPRE le 'main' — sem
-- esta linha a tela abre com erro "Erro ao carregar dados".
-- As listas comecam com um conjunto minimo para o sistema ja abrir
-- utilizavel; tudo e editavel na aba Personalizar.
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM app.config WHERE id = 'main')
INSERT INTO app.config (id, cats, pessoas, locais, status_opts, vinculos) VALUES (
  'main',
  N'[{"id":"c1","name":"Notebook","color":"#2563eb"},
     {"id":"c2","name":"Desktop","color":"#7c3aed"},
     {"id":"c3","name":"Monitor","color":"#0891b2"},
     {"id":"c4","name":"Impressora","color":"#d97706"},
     {"id":"c5","name":"Celular","color":"#059669"},
     {"id":"c6","name":"Periférico","color":"#64748b"}]',
  N'[]',
  N'["TI","Almoxarifado","Manutenção"]',
  N'[{"id":"s1","name":"Em uso","color":"#059669"},
     {"id":"s2","name":"Em estoque","color":"#2563eb"},
     {"id":"s3","name":"Em manutenção","color":"#d97706"},
     {"id":"s4","name":"Baixado","color":"#dc2626"}]',
  N'{"entrada":{"statusIds":[],"localIds":[]},"saida":{"statusIds":[],"localIds":[]}}'
);
GO

-- ------------------------------------------------------------
-- PRIMEIRO ADMINISTRADOR
--
--   login: admin
--   senha: Trocar@123
--
-- TROQUE ESSA SENHA NO PRIMEIRO ACESSO (menu do usuario ->
-- Alterar senha). Ela esta escrita aqui em um arquivo versionado
-- no Git; enquanto nao for trocada, quem ler o repositorio entra
-- no sistema.
--
-- O valor abaixo e o hash scrypt (sal:hash) gerado pela mesma
-- funcao que a API usa — nao e a senha, e nao da para voltar dela
-- para a senha.
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM app.usuario WHERE login = 'admin')
INSERT INTO app.usuario (login, senha_hash, nome, papel, ativo) VALUES (
  'admin',
  '728198d7d758ffac85d262ba5e4a3eef:00f9528db074a6cf68b5db8216f4e7047846a472834bbd7b10835debf7e673f2',
  'Administrador',
  'admin',
  1
);
GO

SELECT 'config'    AS tabela, COUNT(*) AS linhas FROM app.config
UNION ALL SELECT 'usuario', COUNT(*) FROM app.usuario;
GO

PRINT '03 concluido. Banco pronto — agora configure api/config/db.json e suba a API.';
GO
