#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -e
cd "$(dirname "$0")/.."
source_app="$PWD/../VSCode-darwin-arm64/Aexus Code.app"
target_app="/Applications/Aexus Code.app"
test -x "$source_app/Contents/MacOS/Aexus Code"
test -x "$HOME/.local/share/aexus-code/keychain-access"
test -f "$HOME/.local/share/aexus-code/keychain-storage.node"
codesign --verify --strict "$HOME/.local/share/aexus-code/keychain-access"
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
./scripts/aexus-env.sh node scripts/aexus-sign.mts
rsync -ac --delete "$source_app/" "$target_app/"
codesign --verify --deep --strict "$target_app"
"$HOME/.local/share/aexus-code/keychain-access"
"$HOME/.local/share/aexus-code/keychain-access" --check
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
for duplicate_app in "$source_app" "$PWD/.build/electron/Aexus Code.app"; do
	if [ -d "$duplicate_app" ]; then
		"$lsregister" -u "$duplicate_app" >/dev/null 2>&1 || true
		rm -rf "$duplicate_app"
	fi
done
rmdir "$PWD/../VSCode-darwin-arm64" 2>/dev/null || true
"$lsregister" -f "$target_app"
echo "Installed: $target_app"
