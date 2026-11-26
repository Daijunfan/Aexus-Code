#!/usr/bin/env bash
# Copyright (c) Aexus Code contributors. All rights reserved.
# Licensed under the MIT License. See LICENSE.txt in the project root for license information.
set -e
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

NVMRC="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
NVMRC_MAJOR="${NVMRC%%.*}"
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

TC_ROOT="${AEXUS_TOOLCHAIN:-$REPO_ROOT/.build/toolchain}"
if [ -d "$TC_ROOT/node-v${NVMRC}-${NODE_OS}-${NODE_ARCH}/bin" ]; then
	export PATH="$TC_ROOT/node-v${NVMRC}-${NODE_OS}-${NODE_ARCH}/bin:$PATH"
fi
if [ -d "$TC_ROOT/pnpm/node_modules/.bin" ]; then
	export PATH="$TC_ROOT/pnpm/node_modules/.bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
	echo "Error: 'node' was not found in PATH or $TC_ROOT." >&2
	echo "Install Node.js v${NVMRC} (see .nvmrc) via nvm/fnm/mise/Homebrew, or place it under $TC_ROOT/node-v${NVMRC}-${NODE_OS}-${NODE_ARCH}." >&2
	exit 1
fi

NODE_ACTIVE="$(node -v 2>/dev/null | sed 's/^v//')"
NODE_ACTIVE_MAJOR="${NODE_ACTIVE%%.*}"
if [ -n "$NODE_ACTIVE_MAJOR" ] && [ "$NODE_ACTIVE_MAJOR" != "$NVMRC_MAJOR" ]; then
	echo "Warning: Active Node.js is v${NODE_ACTIVE}, while .nvmrc targets v${NVMRC} (major v${NVMRC_MAJOR})." >&2
fi

if [ "${1:-}" = "pnpm" ] && ! command -v pnpm >/dev/null 2>&1; then
	echo "Error: 'pnpm' was not found in PATH or $TC_ROOT." >&2
	echo "Enable Corepack ('corepack enable && corepack prepare pnpm@12.16.0 --activate') or install pnpm@12.16.0." >&2
	exit 1
fi

export NODE_USE_ENV_PROXY=1
unset ELECTRON_RUN_AS_NODE VSCODE_NODE_COMPILE_CACHE_ROOT VSCODE_NODE_COMPILE_CACHE_KIND
unset GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_EXTRA_ARGS VSCODE_GIT_IPC_HANDLE
export GIT_TERMINAL_PROMPT=0

if [ "$#" -eq 0 ]; then
	echo "Usage: ./scripts/aexus-env.sh <command> [args...]" >&2
	exit 1
fi
exec "$@"
