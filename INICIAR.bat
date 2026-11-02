@echo off
setlocal
call "%~dp0RUNTIME.bat"
if errorlevel 1 exit /b 1
"%OFFER_MACHINE_NODE%" "%~dp0src\app.mjs"
pause
