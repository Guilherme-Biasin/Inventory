@echo off
REM ====================================================================
REM  Sobe o Inventory Guemat (estoque de TI).
REM  Use SEMPRE este arquivo em vez de digitar o comando na mao: no
REM  PowerShell, "set PORT=3002" nao funciona igual ao prompt e o
REM  servidor acaba subindo na porta errada.
REM
REM  A porta 3001 e do Gerente Assist. Este sobe na 3002.
REM ====================================================================

cd /d "%~dp0"

if "%PORT%"=="" set PORT=3002

echo.
echo  Inventory Guemat
echo  banco : ESTOQUE_TI (SQL Server)
echo  porta : %PORT%
echo.

node server.js

REM Se cair aqui e porque o node encerrou. Mantem a janela aberta para
REM dar tempo de ler a mensagem de erro.
echo.
echo  === O servidor encerrou. Veja a mensagem acima. ===
pause
