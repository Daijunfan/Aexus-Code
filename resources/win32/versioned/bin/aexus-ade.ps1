#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$binDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

function ConvertTo-Win32QuotedArg([string]$a) {
	if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
	$escaped = [regex]::Replace($a, '(\\*)"', '$1$1\"')
	$escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
	return '"' + $escaped + '"'
}

$exePath = Join-Path $binDir '..\@@NAME@@.exe'
$cliJs = Join-Path $binDir '..\@@VERSIONFOLDER@@\resources\app\extensions\aexus-agents\dist\adeCli.js'
$env:VSCODE_DEV = ''
$env:ELECTRON_RUN_AS_NODE = '1'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exePath
$allArgs = @([string]$cliJs) + @($args | ForEach-Object { [string]$_ })
$psi.Arguments = ($allArgs | ForEach-Object { ConvertTo-Win32QuotedArg $_ }) -join ' '
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.WaitForExit()
exit $proc.ExitCode
