# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# Installs the packaged Windows Aexus Code build (`..\VSCode-win32-x64` or `..\VSCode-win32-arm64`)
# into `%LOCALAPPDATA%\Programs\Aexus Code` cleanly in the background without launching any window,
# works safely across different Windows drive volumes (e.g. D:\ -> C:\), and removes duplicate build outputs.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$parentDir = Split-Path -Parent $repoRoot
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = if ($rawArch -eq 'ARM64') { 'arm64' } else { 'x64' }
$builtDir = Join-Path $parentDir "VSCode-win32-$arch"

if (-not (Test-Path -LiteralPath (Join-Path $builtDir 'Aexus Code.exe'))) {
	throw "Packaged build not found at $builtDir\Aexus Code.exe. Run 'pnpm run gulp vscode-win32-$arch' first."
}

$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$targetParent = Join-Path $localAppData 'Programs'
$targetDir = Join-Path $targetParent 'Aexus Code'
$legacyStagingDir = Join-Path $targetParent '.Aexus-Code-staging'

Get-Process 'Aexus Code' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
if (Test-Path -LiteralPath $legacyStagingDir) {
	Remove-Item -LiteralPath $legacyStagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Mirror packaged build directly into target directory (robocopy /MIR is the Windows equivalent of rsync -a --delete; exit codes 0-7 indicate success).
& robocopy $builtDir $targetDir /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /MT:8 /R:5 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) {
	throw "robocopy /MIR failed with exit code $LASTEXITCODE"
}

$exePath = Join-Path $targetDir 'Aexus Code.exe'
$adeCmd = Join-Path $targetDir 'bin\aexus-ade.cmd'
$adePs1 = Join-Path $targetDir 'bin\aexus-ade.ps1'
$adeSh = Join-Path $targetDir 'bin\aexus-ade'
$codeCmd = Join-Path $targetDir 'bin\aexus-code.cmd'
foreach ($required in @($exePath, $adeCmd, $adePs1, $adeSh, $codeCmd)) {
	if (-not (Test-Path -LiteralPath $required)) {
		throw "Verification failed: missing $required"
	}
}

Remove-Item -LiteralPath $builtDir -Recurse -Force -ErrorAction SilentlyContinue
$electronDevDir = Join-Path $repoRoot '.build\electron'
if (Test-Path -LiteralPath $electronDevDir) {
	Remove-Item -LiteralPath $electronDevDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed Aexus Code cleanly to $targetDir (single copy verified)."
