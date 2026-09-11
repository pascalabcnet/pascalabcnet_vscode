@echo off
setlocal

powershell.exe -NoProfile -File "%~dp0build-server.ps1" %*
exit /b %errorlevel%
