@echo off
setlocal
call "%~dp0RUNTIME.bat"
if errorlevel 1 exit /b 1
if not defined OFFER_MACHINE_NPM_CLI (
  echo npm nao encontrado. Instale Node.js 24 com npm e tente novamente.
  exit /b 1
)
"%OFFER_MACHINE_NODE%" "%OFFER_MACHINE_NPM_CLI%" --prefix "%~dp0." run verify
if errorlevel 1 exit /b 1
pause
