#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$binDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

function ConvertTo-Win32QuotedArg([string]$a) {
	if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
	$escaped = [regex]::Replace($a, '(\\*)"', '$1$1\"')
	$escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
	return '"' + $escaped + '"'
}

function Invoke-NativeRuntime([string]$exe, [string]$scriptPath, [object[]]$forwardArgs, [bool]$asElectronNode) {
	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = $exe
	$allArgs = @([string]$scriptPath) + @($forwardArgs | ForEach-Object { [string]$_ })
	$psi.Arguments = ($allArgs | ForEach-Object { ConvertTo-Win32QuotedArg $_ }) -join ' '
	$psi.UseShellExecute = $false
	if ($asElectronNode) {
		$env:VSCODE_DEV = ''
		$env:ELECTRON_RUN_AS_NODE = '1'
	} else {
		Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
	}
	$proc = [System.Diagnostics.Process]::Start($psi)
	$proc.WaitForExit()
	exit $proc.ExitCode
}

$cliCandidates = @(
	(Join-Path $binDir '..\dist\adeCli.js'),
	(Join-Path $binDir '..\resources\app\extensions\aexus-agents\dist\adeCli.js'),
	(Join-Path $binDir '..\extensions\aexus-agents\dist\adeCli.js')
)
$cliJs = $cliCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $cliJs) {
	[Console]::Error.WriteLine('aexus-ade: unable to locate dist/adeCli.js.')
	exit 1
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd -and $nodeCmd.Source) {
	Invoke-NativeRuntime $nodeCmd.Source $cliJs $args $false
}

$runtimeCandidates = @()
if ($env:VSCODE_EXEC_PATH) { $runtimeCandidates += $env:VSCODE_EXEC_PATH }
$runtimeCandidates += @(
	(Join-Path $binDir '..\Aexus Code.exe'),
	(Join-Path $binDir '..\..\..\..\..\Aexus Code.exe'),
	(Join-Path $binDir '..\..\..\..\..\..\Aexus Code.exe'),
	(Join-Path $env:LOCALAPPDATA 'Programs\Aexus Code\Aexus Code.exe'),
	(Join-Path $env:ProgramFiles 'Aexus Code\Aexus Code.exe'),
	(Join-Path $binDir '..\..\..\.build\electron\Aexus Code.exe'),
	(Join-Path $binDir '..\..\..\.build\electron\Code - OSS.exe')
)

foreach ($rt in $runtimeCandidates) {
	if ($rt -and (Test-Path -LiteralPath $rt)) {
		Invoke-NativeRuntime $rt $cliJs $args $true
	}
}

[Console]::Error.WriteLine('aexus-ade: unable to locate node or Aexus Code runtime.')
exit 1
