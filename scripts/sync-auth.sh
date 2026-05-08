#!/usr/bin/env bash
# scp local auth.json to a remote machine that runs the MCP server / CLI.
# Configured via env vars (read from .env if present):
#   POINTSYEAH_SYNC_TARGET   required, e.g. user@host:/path/to/auth.json
#   POINTSYEAH_AUTH_PATH     optional, defaults to ./auth.json
set -euo pipefail
[ -f .env ] && set -a && source .env && set +a
: "${POINTSYEAH_SYNC_TARGET:?Set POINTSYEAH_SYNC_TARGET in .env (e.g. user@host:/path/to/auth.json)}"
: "${POINTSYEAH_AUTH_PATH:=./auth.json}"
scp "$POINTSYEAH_AUTH_PATH" "$POINTSYEAH_SYNC_TARGET"
echo "synced $POINTSYEAH_AUTH_PATH → $POINTSYEAH_SYNC_TARGET"
