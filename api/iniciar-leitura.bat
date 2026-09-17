@echo off
REM ====================================================================
REM  DESENVOLVIMENTO COM DADOS REAIS - le o banco ESTOQUE_TI de producao,
REM  mas NAO GRAVA NADA.
REM
REM  Use este no notebook. Tudo aparece igual a producao; o que muda e
REM  que nenhum POST passa:
REM
REM    - cadastrar / editar / movimentar / excluir patrimonio -> bloqueado
REM    - importar planilha                 -> so CONFERE, nao grava
REM    - Personalizar (categorias, locais) -> bloqueado
REM    - criar/editar usuario, trocar senha -> bloqueado
REM
REM  A trava fica no SERVIDOR (SOMENTE_LEITURA=1), nao na tela: esconder
REM  botao nao protege nada.
REM
REM  Precisa do config\db.json, igual a producao. O login funciona.
REM
REM  O iniciar.bat (sem sufixo) GRAVA no banco de producao - ele e para
REM  o servidor, nao para o notebook.
REM ====================================================================

cd /d "%~dp0"

set SOMENTE_LEITURA=1
if "%PORT%"=="" set PORT=3002

echo.
echo  Inventory Guemat - DADOS REAIS, SOMENTE LEITURA
echo  banco    : ESTOQUE_TI (producao)
echo  gravacao : BLOQUEADA
echo  porta    : %PORT%
echo.

node server.js

echo.
echo  === O servidor encerrou. Veja a mensagem acima. ===
pause
