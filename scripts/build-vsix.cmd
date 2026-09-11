@echo off
setlocal

powershell.exe -NoProfile -File "%~dp0build-vsix.ps1" %*
exit /b %errorlevel%
