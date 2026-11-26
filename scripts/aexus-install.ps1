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
$electronDevDir = Join-Path $repoRoot '.build\electron'

# Exact 45 canonical ade_* CLI command names (synced with src/vs/platform/ade/common/adeCliManifest.ts)
$ExpectedAdeCommands = @(
	'ade_whoami',
	'ade_sysprompt_path',
	'ade_sysprompt_update',
	'ade_create',
	'ade_destroy',
	'ade_edit',
	'ade_list',
	'ade_get',
	'ade_detail',
	'ade_history',
	'ade_host_list',
	'ade_engine_list',
	'ade_model_list',
	'ade_agent_list',
	'ade_agent_create',
	'ade_agent_edit',
	'ade_agent_move',
	'ade_agent_delete',
	'ade_dept_create',
	'ade_dept_edit',
	'ade_dept_delete',
	'ade_dept_member',
	'ade_dept_members',
	'ade_dept_info',
	'ade_wb_grant',
	'ade_wb_list',
	'ade_wb_my_perm',
	'ade_wb_members',
	'ade_wb_create',
	'ade_wb_config',
	'ade_wb_delete',
	'ade_wb_tags',
	'ade_wb_tag_manage',
	'ade_wb_post_msg',
	'ade_wb_upload_file',
	'ade_wb_items',
	'ade_wb_get_msg',
	'ade_wb_download',
	'ade_wb_edit_item',
	'ade_wb_delete_item',
	'ade_wb_manage_item',
	'ade_wb_note_send',
	'ade_wb_note_unread',
	'ade_wb_note_detail',
	'ade_wb_unread_all'
)

function Assert-AdeBinDirIntegrity {
	param(
		[Parameter(Mandatory = $true)][string]$AppRootDir,
		[Parameter(Mandatory = $true)][string]$StageLabel
	)

	$exePath = Join-Path $AppRootDir 'Aexus Code.exe'
	if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
		throw "Verification failed [$StageLabel]: missing executable at $exePath"
	}
	$binDir = Join-Path $AppRootDir 'bin'
	if (-not (Test-Path -LiteralPath $binDir -PathType Container)) {
		throw "Verification failed [$StageLabel]: missing bin directory at $binDir"
	}
	$adeRunner = Join-Path $binDir '_ade_runner'
	$codeCmd = Join-Path $binDir 'aexus-code.cmd'
	foreach ($required in @($adeRunner, $codeCmd)) {
		if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
			throw "Verification failed [$StageLabel]: missing $required"
		}
	}
	if ($ExpectedAdeCommands.Count -ne 45) {
		throw "Verification failed [$StageLabel]: expected manifest size 45, got $($ExpectedAdeCommands.Count)"
	}

	$expectedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
	foreach ($cmdName in $ExpectedAdeCommands) {
		[void]$expectedSet.Add($cmdName)
		$cmdLauncher = Join-Path $binDir "$cmdName.cmd"
		$posixLauncher = Join-Path $binDir $cmdName
		if (-not (Test-Path -LiteralPath $cmdLauncher -PathType Leaf)) {
			throw "Verification failed [$StageLabel]: missing standard Windows launcher $cmdLauncher"
		}
		if (-not (Test-Path -LiteralPath $posixLauncher -PathType Leaf)) {
			throw "Verification failed [$StageLabel]: missing standard POSIX launcher $posixLauncher"
		}
	}

	$allAdeEntries = @(Get-ChildItem -Path (Join-Path $binDir 'ade_*') -Force -ErrorAction SilentlyContinue)
	$cmdCount = 0
	$posixCount = 0
	foreach ($entry in $allAdeEntries) {
		if ($entry.PSIsContainer) {
			throw "Verification failed [$StageLabel]: unexpected directory '$($entry.Name)' inside $binDir"
		}
		if ($entry.Extension -eq '.cmd') {
			$stem = $entry.BaseName
			if (-not $expectedSet.Contains($stem)) {
				throw "Verification failed [$StageLabel]: unexpected unknown launcher '$($entry.Name)' in $binDir"
			}
			$cmdCount++
		} elseif ($entry.Extension -eq '') {
			if (-not $expectedSet.Contains($entry.Name)) {
				throw "Verification failed [$StageLabel]: unexpected unknown launcher '$($entry.Name)' in $binDir"
			}
			$posixCount++
		} else {
			throw "Verification failed [$StageLabel]: unexpected ade_* file '$($entry.Name)' in $binDir"
		}
	}
	if ($cmdCount -ne 45) {
		throw "Verification failed [$StageLabel]: expected exactly 45 ade_*.cmd launchers in $binDir, found $cmdCount"
	}
	if ($posixCount -ne 45) {
		throw "Verification failed [$StageLabel]: expected exactly 45 extensionless POSIX ade_* launchers in $binDir, found $posixCount"
	}

	foreach ($legacyPattern in @(('aexus-' + 'ade*'), ('aexus-' + 'secretary*'))) {
		$legacyFiles = @(Get-ChildItem -Path (Join-Path $binDir $legacyPattern) -Force -ErrorAction SilentlyContinue)
		if ($legacyFiles.Count -gt 0) {
			throw "Verification failed [$StageLabel]: forbidden legacy launcher(s) found in ${binDir}: $($legacyFiles.Name -join ', ')"
		}
	}
}

if (-not (Test-Path -LiteralPath (Join-Path $builtDir 'Aexus Code.exe'))) {
	throw "Packaged build not found at $builtDir\Aexus Code.exe. Run 'pnpm run gulp vscode-win32-$arch' first."
}

# Pre-flight source package integrity check BEFORE terminating running app processes or mirroring via robocopy /MIR
Assert-AdeBinDirIntegrity -AppRootDir $builtDir -StageLabel 'source pre-flight'

$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$targetParent = Join-Path $localAppData 'Programs'
$targetDir = Join-Path $targetParent 'Aexus Code'
$legacyStagingDir = Join-Path $targetParent '.Aexus-Code-staging'

$matchPrefixes = @($targetDir, $builtDir, $electronDevDir) | Where-Object { $_ } | ForEach-Object {
	$full = [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/')
	"$full\"
}

function Get-LockingAexusProcessIds {
	$ids = New-Object 'System.Collections.Generic.HashSet[int]'
	foreach ($cp in @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)) {
		$procId = [int]$cp.ProcessId
		if ($procId -le 0 -or $procId -eq $PID) {
			continue
		}
		$exePath = [string]$cp.ExecutablePath
		if ($exePath) {
			$normExe = $exePath.Replace('/', '\')
			foreach ($prefix in $matchPrefixes) {
				if ($normExe.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
					[void]$ids.Add($procId)
					break
				}
			}
		}
		$cimName = [string]$cp.Name
		if ($cimName -ieq 'Aexus Code.exe' -or $cimName -ieq 'aexus-code-tunnel.exe') {
			[void]$ids.Add($procId)
		}
	}
	foreach ($gp in @(Get-Process -ErrorAction SilentlyContinue)) {
		$procId = [int]$gp.Id
		if ($procId -le 0 -or $procId -eq $PID) {
			continue
		}
		$gpPath = $null
		try { $gpPath = [string]$gp.Path } catch { $gpPath = $null }
		if ($gpPath) {
			$normGp = $gpPath.Replace('/', '\')
			foreach ($prefix in $matchPrefixes) {
				if ($normGp.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
					[void]$ids.Add($procId)
					break
				}
			}
		}
		$gpName = [string]$gp.ProcessName
		if ($gpName -ieq 'Aexus Code' -or $gpName -ieq 'aexus-code-tunnel') {
			[void]$ids.Add($procId)
		}
	}
	return @($ids)
}

$lockingIds = Get-LockingAexusProcessIds
if ($lockingIds.Count -gt 0) {
	Stop-Process -Id $lockingIds -Force -ErrorAction SilentlyContinue
	$waitDeadline = (Get-Date).AddSeconds(10)
	while ((Get-Date) -lt $waitDeadline) {
		$remainingIds = Get-LockingAexusProcessIds
		if ($remainingIds.Count -eq 0) {
			break
		}
		Stop-Process -Id $remainingIds -Force -ErrorAction SilentlyContinue
		Start-Sleep -Milliseconds 250
	}
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
if (Test-Path -LiteralPath $legacyStagingDir) {
	Remove-Item -LiteralPath $legacyStagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Mirror packaged build directly into target directory (robocopy /MIR is the Windows equivalent of rsync -a --delete; exit codes 0-7 indicate success).
& robocopy $builtDir $targetDir /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /MT:8 /R:5 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) {
	throw "robocopy /MIR failed with exit code $LASTEXITCODE"
}

Assert-AdeBinDirIntegrity -AppRootDir $targetDir -StageLabel 'target post-install'

Remove-Item -LiteralPath $builtDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $electronDevDir) {
	Remove-Item -LiteralPath $electronDevDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed Aexus Code cleanly to $targetDir (single copy verified)."
