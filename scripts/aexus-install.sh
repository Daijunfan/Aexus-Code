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

build_dir="$PWD/../VSCode-darwin-${ARCH}"
source_app="$build_dir/Aexus Code.app"
target_app="/Applications/Aexus Code.app"

if [ ! -x "$source_app/Contents/MacOS/Aexus Code" ]; then
	echo "Error: Packaged app not found at '$source_app'." >&2
	echo "Run './scripts/aexus-env.sh pnpm run gulp vscode-darwin-${ARCH}' first." >&2
	exit 1
fi

keychain_helper="$HOME/.local/share/aexus-code/keychain-access"
keychain_node="$HOME/.local/share/aexus-code/keychain-storage.node"
use_keychain_helper=0
if [ -x "$keychain_helper" ] && [ -f "$keychain_node" ]; then
	codesign --verify --strict "$keychain_helper"
	use_keychain_helper=1
else
	echo "Info: Optional local keychain helper not found at '$keychain_helper'; skipping Keychain ACL pre-authorization."
fi

app_process_pattern='/Applications/[A]exus Code\.app/Contents/'
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
