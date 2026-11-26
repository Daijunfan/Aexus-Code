@echo off
setlocal
set "ADE_INVOKED_CMD=ade_model_list"
set "CLI_JS=%~dp0..\dist\adeCli.js"
if not exist "%CLI_JS%" set "CLI_JS=%~dp0..\extensions\aexus-agents\dist\adeCli.js"
if not exist "%CLI_JS%" set "CLI_JS=%~dp0..\resources\app\extensions\aexus-agents\dist\adeCli.js"
if not exist "%CLI_JS%" for /d %%D in ("%~dp0..\*") do if exist "%%~fD\resources\app\extensions\aexus-agents\dist\adeCli.js" set "CLI_JS=%%~fD\resources\app\extensions\aexus-agents\dist\adeCli.js"
if defined ADE_NODE_BIN goto :run_ade_node
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :run_path_node
set "ELECTRON_EXE=%~dp0..\Aexus Code.exe"
if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\..\..\..\..\Aexus Code.exe"
if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\..\..\..\..\..\Aexus Code.exe"
if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\..\..\.build\electron\Aexus Code.exe"
if exist "%ELECTRON_EXE%" goto :run_electron
goto :run_path_node
:run_ade_node
set "ADE_NODE_CLEAN=%ADE_NODE_BIN:"=%"
"%ADE_NODE_CLEAN%" "%CLI_JS%" %*
exit /b %ERRORLEVEL%
:run_electron
set "ELECTRON_RUN_AS_NODE=1"
"%ELECTRON_EXE%" "%CLI_JS%" %*
exit /b %ERRORLEVEL%
:run_path_node
node "%CLI_JS%" %*
exit /b %ERRORLEVEL%
