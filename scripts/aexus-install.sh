#!/usr/bin/env bash
# Copyright (c) Aexus Code contributors. All rights reserved.
# Licensed under the MIT License. See LICENSE.txt in the project root for license information.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH_RAW="${AEXUS_ARCH:-$(uname -m)}"
case "$ARCH_RAW" in
	arm64|aarch64) ARCH="arm64" ;;
	x86_64|x64|amd64) ARCH="x64" ;;
	*)
		echo "Error: Unsupported macOS architecture '$ARCH_RAW'. Set AEXUS_ARCH=arm64 or AEXUS_ARCH=x64." >&2
		exit 1
		;;
esac

# Exact 45 canonical ade_* CLI command names (synced with src/vs/platform/ade/common/adeCliManifest.ts)
EXPECTED_ADE_COMMANDS=(
	ade_whoami
	ade_sysprompt_path
	ade_sysprompt_update
	ade_create
	ade_destroy
	ade_edit
	ade_list
	ade_get
	ade_detail
	ade_history
	ade_host_list
	ade_engine_list
	ade_model_list
	ade_agent_list
	ade_agent_create
	ade_agent_edit
	ade_agent_move
	ade_agent_delete
	ade_dept_create
	ade_dept_edit
	ade_dept_delete
	ade_dept_member
	ade_dept_members
	ade_dept_info
	ade_wb_grant
	ade_wb_list
	ade_wb_my_perm
	ade_wb_members
	ade_wb_create
	ade_wb_config
	ade_wb_delete
	ade_wb_tags
	ade_wb_tag_manage
	ade_wb_post_msg
	ade_wb_upload_file
	ade_wb_items
	ade_wb_get_msg
	ade_wb_download
	ade_wb_edit_item
	ade_wb_delete_item
	ade_wb_manage_item
	ade_wb_note_send
	ade_wb_note_unread
	ade_wb_note_detail
	ade_wb_unread_all
)

is_expected_ade_command() {
	local needle="$1"
	local item
	for item in "${EXPECTED_ADE_COMMANDS[@]}"; do
		if [ "$item" = "$needle" ]; then
			return 0
		fi
	done
	return 1
}

verify_ade_bin_dir() {
	local bin_dir="$1"
	local stage_label="$2"
	if [ ! -d "$bin_dir" ]; then
		echo "Error [$stage_label]: ADE CLI bin directory not found at '$bin_dir'." >&2
		exit 1
	fi
	if [ ! -f "$bin_dir/_ade_runner" ] || [ ! -x "$bin_dir/_ade_runner" ]; then
		echo "Error [$stage_label]: ADE CLI runner missing or not executable at '$bin_dir/_ade_runner'." >&2
		exit 1
	fi
	if [ "${#EXPECTED_ADE_COMMANDS[@]}" -ne 45 ]; then
		echo "Error [$stage_label]: Internal manifest error (expected 45 commands, got ${#EXPECTED_ADE_COMMANDS[@]})." >&2
		exit 1
	fi
	local cmd_name
	for cmd_name in "${EXPECTED_ADE_COMMANDS[@]}"; do
		if [ ! -f "$bin_dir/$cmd_name" ] || [ ! -x "$bin_dir/$cmd_name" ]; then
			echo "Error [$stage_label]: Missing or non-executable standard ADE launcher '$cmd_name' in '$bin_dir'." >&2
			exit 1
		fi
	done
	local ade_bin_count=0
	local ade_bin
	for ade_bin in "$bin_dir"/ade_*; do
		if [ ! -e "$ade_bin" ] && [ ! -L "$ade_bin" ]; then
			continue
		fi
		local base_name
		base_name="$(basename "$ade_bin")"
		if ! is_expected_ade_command "$base_name"; then
			echo "Error [$stage_label]: Unexpected unknown ade_* entry '$base_name' found in '$bin_dir'." >&2
			exit 1
		fi
		if [ ! -f "$ade_bin" ] || [ ! -x "$ade_bin" ]; then
			echo "Error [$stage_label]: ADE launcher '$base_name' is not an executable file in '$bin_dir'." >&2
			exit 1
		fi
		ade_bin_count=$((ade_bin_count + 1))
	done
	if [ "$ade_bin_count" -ne 45 ]; then
		echo "Error [$stage_label]: Expected exactly 45 executable ade_* launchers in '$bin_dir', found $ade_bin_count." >&2
		exit 1
	fi
	local legacy_ade_prefix="aexus-""ade"
	local legacy_sec_prefix="aexus-""secretary"
	local legacy_bin
	for legacy_bin in "$bin_dir/${legacy_ade_prefix}"* "$bin_dir/${legacy_sec_prefix}"*; do
		if [ -e "$legacy_bin" ] || [ -L "$legacy_bin" ]; then
			echo "Error [$stage_label]: Forbidden legacy launcher '$legacy_bin' found in '$bin_dir'." >&2
			exit 1
		fi
	done
}

build_dir="$PWD/../VSCode-darwin-${ARCH}"
source_app="$build_dir/Aexus Code.app"
target_app="/Applications/Aexus Code.app"

if [ ! -x "$source_app/Contents/MacOS/Aexus Code" ]; then
	echo "Error: Packaged app not found at '$source_app'." >&2
	echo "Run './scripts/aexus-env.sh pnpm run gulp vscode-darwin-${ARCH}' first." >&2
	exit 1
fi

# Pre-flight source package integrity check BEFORE terminating running app processes or running rsync --delete
verify_ade_bin_dir "$source_app/Contents/Resources/app/bin" "source pre-flight"

keychain_helper="$HOME/.local/share/aexus-code/keychain-access"
keychain_node="$HOME/.local/share/aexus-code/keychain-storage.node"
use_keychain_helper=0
if [ -x "$keychain_helper" ] && [ -f "$keychain_node" ]; then
	codesign --verify --strict "$keychain_helper"
	use_keychain_helper=1
else
	echo "Info: Optional local keychain helper not found at '$keychain_helper'; skipping Keychain ACL pre-authorization."
fi

app_process_pattern='[A]exus Code\.app/Contents/'
if pgrep -f "$app_process_pattern" >/dev/null 2>&1; then
	pkill -TERM -f "$app_process_pattern" >/dev/null 2>&1 || true
	for _ in $(seq 1 15); do
		if ! pgrep -f "$app_process_pattern" >/dev/null 2>&1; then
			break
		fi
		sleep 0.2
	done
	if pgrep -f "$app_process_pattern" >/dev/null 2>&1; then
		pkill -KILL -f "$app_process_pattern" >/dev/null 2>&1 || true
		for _ in $(seq 1 10); do
			if ! pgrep -f "$app_process_pattern" >/dev/null 2>&1; then
				break
			fi
			sleep 0.2
		done
	fi
fi

signing_config="$HOME/.config/aexus-code/signing.json"
if [ -f "$signing_config" ] && [ -f "$PWD/scripts/aexus-sign.mts" ]; then
	echo "Signing '$source_app' using local signing config ($signing_config)..."
	./scripts/aexus-env.sh node scripts/aexus-sign.mts "$source_app"
else
	echo "Info: No local signing config at '$signing_config'; applying ad-hoc macOS signature."
	codesign --force --deep --sign - "$source_app"
fi

rsync -ac --delete "$source_app/" "$target_app/"
verify_ade_bin_dir "$target_app/Contents/Resources/app/bin" "target post-install"
codesign --verify --deep --strict "$target_app"

if [ "$use_keychain_helper" -eq 1 ]; then
	"$keychain_helper"
	"$keychain_helper" --check
fi

lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
for duplicate_app in "$source_app" "$PWD/.build/electron/Aexus Code.app"; do
	if [ -d "$duplicate_app" ]; then
		"$lsregister" -u "$duplicate_app" >/dev/null 2>&1 || true
		rm -rf "$duplicate_app"
	fi
done
rmdir "$build_dir" 2>/dev/null || true
"$lsregister" -f "$target_app"
echo "Installed ($ARCH): $target_app"
