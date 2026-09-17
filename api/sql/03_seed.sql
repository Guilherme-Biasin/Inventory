-- ============================================================
--  Inventory Guemat — 03: dados iniciais
--  Rode no banco ESTOQUE_TI, depois do 02. Roda UMA vez.
--
--  Cria a linha de configuracao. O primeiro administrador NAO
--  nasce aqui: ele e criado com api/criar-admin.js (ver abaixo).
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
INSERT INTO app.config (id, cats, cats_almox, pessoas, locais, status_opts, vinculos) VALUES (
  'main',
  N'[{"id":"c1","name":"Notebook","color":"#2563eb"},
     {"id":"c2","name":"Desktop","color":"#7c3aed"},
     {"id":"c3","name":"Monitor","color":"#0891b2"},
     {"id":"c4","name":"Impressora","color":"#d97706"},
     {"id":"c5","name":"Celular","color":"#059669"},
     {"id":"c6","name":"Periférico","color":"#64748b"}]',
  -- categorias do ALMOXARIFADO (material de consumo)
  N'[{"id":"a1","name":"Bobina","color":"#2563eb"},
     {"id":"a2","name":"Etiqueta","color":"#7c3aed"},
     {"id":"a3","name":"Saco plástico","color":"#0891b2"},
     {"id":"a4","name":"Tinta de impressora","color":"#d97706"},
     {"id":"a5","name":"Toner","color":"#059669"},
     {"id":"a6","name":"Material de escritório","color":"#64748b"}]',
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
-- PRIMEIRO ADMINISTRADOR: NAO e criado aqui, de proposito.
--
-- Este arquivo esta no Git. Qualquer usuario e senha escritos aqui
-- (mesmo como hash) virariam um acesso conhecido por quem ler o
-- repositorio. O primeiro admin e criado na linha de comando, com
-- a senha digitada na hora e sem ficar gravada em lugar nenhum:
--
--   cd api
--   node criar-admin.js <login> "<Nome>"
--
-- Ver api/sql/INSTALACAO.md, passo 4.
-- ------------------------------------------------------------

SELECT 'config'    AS tabela, COUNT(*) AS linhas FROM app.config
UNION ALL SELECT 'usuario', COUNT(*) FROM app.usuario;   -- 0 em instalacao nova: o admin vem do criar-admin.js
GO

PRINT '03 concluido. Agora configure api/config/db.json e crie o primeiro admin com node criar-admin.js.';
GO
