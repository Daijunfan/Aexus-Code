@echo off
setlocal
set "BIN_DIR=%~dp0"
set "CLI_JS=%BIN_DIR%..\dist\adeCli.js"
if exist "%CLI_JS%" goto :find_runtime
if exist "%BIN_DIR%..\resources\app\extensions\aexus-agents\dist\adeCli.js" (
	set "CLI_JS=%BIN_DIR%..\resources\app\extensions\aexus-agents\dist\adeCli.js"
	goto :find_runtime
)
if exist "%BIN_DIR%..\extensions\aexus-agents\dist\adeCli.js" (
	set "CLI_JS=%BIN_DIR%..\extensions\aexus-agents\dist\adeCli.js"
	goto :find_runtime
)

:find_runtime
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :run_node

if defined VSCODE_EXEC_PATH (
	if exist "%VSCODE_EXEC_PATH%" (
		set "AEXUS_RT=%VSCODE_EXEC_PATH%"
		goto :run_electron
	)
)

for %%C in (
	"%BIN_DIR%..\Aexus Code.exe"
	"%BIN_DIR%..\..\..\..\..\Aexus Code.exe"
	"%BIN_DIR%..\..\..\..\..\..\Aexus Code.exe"
	"%LOCALAPPDATA%\Programs\Aexus Code\Aexus Code.exe"
	"%ProgramFiles%\Aexus Code\Aexus Code.exe"
	"%BIN_DIR%..\..\..\.build\electron\Aexus Code.exe"
	"%BIN_DIR%..\..\..\.build\electron\Code - OSS.exe"
) do (
	if exist "%%~C" (
		set "AEXUS_RT=%%~C"
		goto :run_electron
	)
)

for %%N in (
	"%ProgramFiles%\nodejs\node.exe"
	"%USERPROFILE%\.local\node-current\node.exe"
) do (
	if exist "%%~N" (
		set "AEXUS_NODE=%%~N"
		goto :run_explicit_node
	)
)

echo aexus-ade: unable to locate node or Aexus Code runtime. 1>&2
exit /b 1

:run_node
set ELECTRON_RUN_AS_NODE=
node "%CLI_JS%" %*
exit /b %ERRORLEVEL%

:run_explicit_node
set ELECTRON_RUN_AS_NODE=
"%AEXUS_NODE%" "%CLI_JS%" %*
exit /b %ERRORLEVEL%

:run_electron
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%AEXUS_RT%" "%CLI_JS%" %*
exit /b %ERRORLEVEL%
