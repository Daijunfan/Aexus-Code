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
if pgrep -f '(^|/)Aexus Code\.app/Contents/MacOS/Aexus Code([[:space:]]|$)' >/dev/null; then
	echo "Please quit Aexus Code before installing." >&2
	exit 1
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
"$lsregister" -f "$target_app"
echo "Installed: $target_app"
