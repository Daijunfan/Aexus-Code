#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -e
cd "$(dirname "$0")/.."

NVMRC="$(tr -d '[:space:]' < .nvmrc)"
OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"
case "$OS_RAW" in
	Darwin*) NODE_OS="darwin" ;;
	*)       NODE_OS="linux" ;;
esac
case "$ARCH_RAW" in
	arm64|aarch64) NODE_ARCH="arm64" ;;
	*)             NODE_ARCH="x64" ;;
esac

TC_ROOT="${AEXUS_TOOLCHAIN:-$PWD/.build/toolchain}"
if [ -d "$TC_ROOT/node-v${NVMRC}-${NODE_OS}-${NODE_ARCH}/bin" ]; then
	export PATH="$TC_ROOT/node-v${NVMRC}-${NODE_OS}-${NODE_ARCH}/bin:$PATH"
fi
if [ -d "$TC_ROOT/pnpm/node_modules/.bin" ]; then
	export PATH="$TC_ROOT/pnpm/node_modules/.bin:$PATH"
fi

export NODE_USE_ENV_PROXY=1
unset ELECTRON_RUN_AS_NODE VSCODE_NODE_COMPILE_CACHE_ROOT VSCODE_NODE_COMPILE_CACHE_KIND
unset GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_EXTRA_ARGS VSCODE_GIT_IPC_HANDLE
export GIT_TERMINAL_PROMPT=0
exec "$@"
