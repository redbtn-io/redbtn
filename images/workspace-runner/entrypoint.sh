#!/usr/bin/env bash
set -euo pipefail

# 1. Validate mandatory environment variables
if [ -z "${REDBTN_INSTALL_ID:-}" ]; then
  echo "[workspace-runner] ERROR: REDBTN_INSTALL_ID is required" >&2
  exit 1
fi

if [ -z "${RREG_TOKEN:-}" ]; then
  echo "[workspace-runner] ERROR: RREG_TOKEN is required" >&2
  exit 1
fi

# 2. Seed install-id into config directory for zero-CLI-change discovery
CONFIG_DIR="${HOME}/.config/redbtn"
mkdir -p "${CONFIG_DIR}"
echo -n "${REDBTN_INSTALL_ID}" > "${CONFIG_DIR}/install-id"
chmod 600 "${CONFIG_DIR}/install-id"

# 3. If target branch is specified and git repo exists in /workspace, ensure branch checkout
if [ -n "${GIT_BRANCH:-}" ] && [ -d "/workspace/.git" ]; then
  cd /workspace
  echo "[workspace-runner] Switching git branch to ${GIT_BRANCH}..."
  if ! git rev-parse --verify "${GIT_BRANCH}" >/dev/null 2>&1; then
    git checkout -B "${GIT_BRANCH}" || true
  else
    git checkout "${GIT_BRANCH}" || true
  fi
fi

# 4. Connect to gateway via redbtn connect
export REDBTN_TOKEN="${RREG_TOKEN}"
export REDBTN_API_URL="${REDBTN_API_URL:-https://app.redbtn.io}"

echo "[workspace-runner] Starting redbtn connect for installId=${REDBTN_INSTALL_ID}..."
exec redbtn connect --allow-exec --api-url "${REDBTN_API_URL}"
