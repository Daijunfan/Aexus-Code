@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0aexus-env.ps1" %*
exit /b %ERRORLEVEL%
