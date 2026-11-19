# Copyright (c) Aexus Code contributors. All rights reserved.
# Licensed under the MIT License. See LICENSE.txt in the project root for license information.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$nvmrc = (Get-Content -Raw (Join-Path $repoRoot '.nvmrc')).Trim()
$nvmrcMajor = ($nvmrc -split '\.')[0]
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = if ($rawArch -eq 'ARM64') { 'arm64' } else { 'x64' }

$toolchainRoots = @(
	(Join-Path $repoRoot '.build\toolchain')
)
if ($env:AEXUS_TOOLCHAIN) {
	$toolchainRoots += $env:AEXUS_TOOLCHAIN
}

$prepend = @()
foreach ($tcRoot in $toolchainRoots) {
	foreach ($sub in @("node-v$nvmrc-win-$arch", 'pnpm\node_modules\.bin')) {
		$candidate = Join-Path $tcRoot $sub
		if (Test-Path -LiteralPath $candidate) { $prepend += $candidate }
	}
}
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath $cargoBin) { $prepend += $cargoBin }

$pf86 = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { 'C:\Program Files (x86)' }
$kitsBin = Join-Path $pf86 'Windows Kits\10\bin'
if (Test-Path -LiteralPath $kitsBin) {
	$latestKit = Get-ChildItem -LiteralPath $kitsBin -Directory -ErrorAction SilentlyContinue |
		Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
		Sort-Object Name -Descending |
		Select-Object -First 1
	if ($latestKit) {
		$kitArchBin = Join-Path $latestKit.FullName $arch
		if (Test-Path -LiteralPath $kitArchBin) { $prepend += $kitArchBin }
	}
}

if ($prepend.Count -gt 0) {
	$env:Path = ($prepend -join ';') + ';' + $env:Path
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
	[Console]::Error.WriteLine("Error: 'node' was not found in PATH or $($toolchainRoots -join ', ').")
	[Console]::Error.WriteLine("Install Node.js v$nvmrc (see .nvmrc) via nvm-windows/fnm/mise/winget, or place it under .build\toolchain\node-v$nvmrc-win-$arch.")
	exit 1
}

$nodeActiveRaw = & $nodeCmd.Source -v 2>$null
$nodeActive = if ($nodeActiveRaw) { ("$nodeActiveRaw").Trim().TrimStart('v') } else { '' }
$nodeActiveMajor = ($nodeActive -split '\.')[0]
if ($nodeActiveMajor -and $nodeActiveMajor -ne $nvmrcMajor) {
	[Console]::Error.WriteLine("Warning: Active Node.js is v$nodeActive, while .nvmrc targets v$nvmrc (major v$nvmrcMajor).")
}

if ($args.Count -gt 0 -and $args[0] -eq 'pnpm' -and -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
	[Console]::Error.WriteLine("Error: 'pnpm' was not found in PATH or $($toolchainRoots -join ', ').")
	[Console]::Error.WriteLine("Enable Corepack ('corepack enable && corepack prepare pnpm@12.16.0 --activate') or install pnpm@12.16.0.")
	exit 1
}

# Preserve active Aexus ADE control socket/named-pipe metadata when present in env
if ($env:AEXUS_ADE_CONTROL_FILE -and (Test-Path -LiteralPath $env:AEXUS_ADE_CONTROL_FILE)) {
	try {
		$meta = Get-Content -Raw -LiteralPath $env:AEXUS_ADE_CONTROL_FILE | ConvertFrom-Json
		if ($meta.socketPath -and (([string]$meta.socketPath).StartsWith('\\.\pipe\') -or (Test-Path -LiteralPath $meta.socketPath))) {
			$env:AEXUS_ADE_SOCKET = [string]$meta.socketPath
		}
	} catch {
		# Ignore malformed or stale control metadata; CLI resolves fallback paths directly
	}
}

$env:NODE_USE_ENV_PROXY = '1'
$env:GIT_TERMINAL_PROMPT = '0'
foreach ($v in @(
	'ELECTRON_RUN_AS_NODE',
	'VSCODE_NODE_COMPILE_CACHE_ROOT',
	'VSCODE_NODE_COMPILE_CACHE_KIND',
	'GIT_ASKPASS',
	'SSH_ASKPASS',
	'VSCODE_GIT_ASKPASS_NODE',
	'VSCODE_GIT_ASKPASS_MAIN',
	'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
	'VSCODE_GIT_IPC_HANDLE'
)) {
	Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
}

if ($args.Count -gt 0) {
	$cmd = $args[0]
	$rest = @($args | Select-Object -Skip 1)
	& $cmd @rest
	exit $LASTEXITCODE
}
