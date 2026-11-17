#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
set -e
cd "$(dirname "$0")/.."
export PATH="$PWD/.build/toolchain/node-v$(cat .nvmrc)-darwin-arm64/bin:$PWD/.build/toolchain/pnpm/node_modules/.bin:$PATH"
export NODE_USE_ENV_PROXY=1
unset ELECTRON_RUN_AS_NODE VSCODE_NODE_COMPILE_CACHE_ROOT VSCODE_NODE_COMPILE_CACHE_KIND
unset GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_EXTRA_ARGS VSCODE_GIT_IPC_HANDLE
export GIT_TERMINAL_PROMPT=0
exec "$@"
