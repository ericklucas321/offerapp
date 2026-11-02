@echo off
rem This helper inherits the caller's setlocal scope.
set "OFFER_MACHINE_NODE="
set "OFFER_MACHINE_NPM_CLI="
for /f "delims=" %%P in ('where node.exe 2^>nul') do if not defined OFFER_MACHINE_NODE call :probe "%%P"
if not defined OFFER_MACHINE_NODE call :probe "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined OFFER_MACHINE_NODE (
  echo Node.js 24 ou superior nao encontrado. Instale essa versao e tente novamente.
  exit /b 1
)
for %%P in ("%OFFER_MACHINE_NODE%") do set "PATH=%%~dpP;%PATH%"
for /f "delims=" %%P in ('where npm.cmd 2^>nul') do if not defined OFFER_MACHINE_NPM_CLI call :npmcli "%%P"
exit /b 0
:probe
if not exist "%~1" exit /b 0
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>&1
if not errorlevel 1 set "OFFER_MACHINE_NODE=%~1"
exit /b 0

:npmcli
if exist "%~dp1node_modules\npm\bin\npm-cli.js" set "OFFER_MACHINE_NPM_CLI=%~dp1node_modules\npm\bin\npm-cli.js"
exit /b 0
