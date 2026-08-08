@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-vsix.ps1" %*
exit /b %errorlevel%
