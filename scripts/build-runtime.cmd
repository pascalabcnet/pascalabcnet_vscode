@echo off
setlocal

powershell.exe -NoProfile -File "%~dp0build-runtime.ps1" %*
exit /b %errorlevel%
