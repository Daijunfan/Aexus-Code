#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

ROOT="$(dirname "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")")"
ELECTRON="$ROOT/@@NAME@@.exe"
REL_CLI="$ROOT/resources/app/extensions/aexus-agents/dist/adeCli.js"

if [ -n "$WSL_DISTRO_NAME" ] && [ -x "$(command -v wslpath)" ]; then
	export WSLENV="ELECTRON_RUN_AS_NODE/w:VSCODE_DEV/w:$WSLENV"
	CLI="$(wslpath -m "$REL_CLI")"
elif [ -x "$(command -v cygpath)" ]; then
	CLI="$(cygpath -m "$REL_CLI")"
else
	CLI="$REL_CLI"
fi

VSCODE_DEV= ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
