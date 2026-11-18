@echo off
setlocal

title Aexus Code Dev

set ELECTRON_RUN_AS_NODE=
set VSCODE_NODE_COMPILE_CACHE_ROOT=
set VSCODE_NODE_COMPILE_CACHE_KIND=
set GIT_ASKPASS=
set SSH_ASKPASS=
set VSCODE_GIT_ASKPASS_NODE=
set VSCODE_GIT_ASKPASS_MAIN=
set VSCODE_GIT_ASKPASS_EXTRA_ARGS=
set VSCODE_GIT_IPC_HANDLE=
set GIT_TERMINAL_PROMPT=0

pushd %~dp0\..

:: Get electron, compile, built-in extensions
if "%VSCODE_SKIP_PRELAUNCH%"=="" (
	node build/lib/preLaunch.ts || (
		echo Failed to prepare VS Code for launch ^(build/lib/preLaunch.ts^). 1>&2
		goto :failed
	)
)
goto :prelaunch_complete

:failed
popd
endlocal
exit /b 1

:prelaunch_complete

set "NAMESHORT="
for /f "tokens=2 delims=:," %%a in ('findstr /R /C:"\"nameShort\":.*" product.json') do if not defined NAMESHORT set "NAMESHORT=%%~a"
set NAMESHORT=%NAMESHORT: "=%
set NAMESHORT=%NAMESHORT:"=%.exe
set CODE=".build\electron\%NAMESHORT%"

:: Manage built-in extensions
if "%~1"=="--builtin" goto builtin

:: Configuration
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

set DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests"
for %%A in (%*) do (
	if "%%~A"=="--extensionTestsPath" (
		set DISABLE_TEST_EXTENSION=""
	)
)

:: Launch Code
%CODE% . %DISABLE_TEST_EXTENSION% %*
goto end

:builtin
%CODE% build/builtin

:end

popd

endlocal
