@echo off
setlocal
call "%~dp0RUNTIME.bat"
if errorlevel 1 exit /b 1
if not defined OFFER_MACHINE_NPM_CLI (
  echo npm nao encontrado. Instale Node.js 24 com npm e tente novamente.
  exit /b 1
)
"%OFFER_MACHINE_NODE%" "%OFFER_MACHINE_NPM_CLI%" --prefix "%~dp0." ci --include=optional
if errorlevel 1 exit /b 1
"%OFFER_MACHINE_NODE%" "%~dp0scripts\check-dependencies.mjs"
if errorlevel 1 exit /b 1
"%OFFER_MACHINE_NODE%" "%OFFER_MACHINE_NPM_CLI%" --prefix "%~dp0." run verify
if errorlevel 1 exit /b 1
if not exist "%~dp0.env" copy "%~dp0.env.example" "%~dp0.env" >nul
echo Instalacao concluida.
pause
