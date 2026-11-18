#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

if [ ! -L "$0" ]; then
	VSCODE_PATH="$(dirname "$0")/.."
else
	if command -v readlink >/dev/null; then
		VSCODE_PATH="$(dirname "$(readlink -f "$0")")/.."
	else
		VSCODE_PATH="$(dirname "$0")/.."
	fi
fi

ELECTRON="$VSCODE_PATH/@@APPNAME@@"
CLI="$VSCODE_PATH/resources/app/extensions/aexus-agents/dist/adeCli.js"
VSCODE_DEV= ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
exit $?
