#!/bin/bash
# Worker initialization script
# Run before worker starts to configure environment from Railway env vars

set -e

# =============================================================================
# HOME Directory Alignment
# =============================================================================
# Railpack/Nixpacks containers run as root (HOME=/root) but the Railway volume
# mounts at /home/jinn. Align HOME so that homedir(), ~/.gemini, ~/.operate etc.
# resolve to the volume mount where credentials and state live.
if [ -n "$RAILWAY_VOLUME_MOUNT_PATH" ] && [ "$HOME" != "$RAILWAY_VOLUME_MOUNT_PATH" ]; then
  export HOME="$RAILWAY_VOLUME_MOUNT_PATH"
  echo "[init] Set HOME=$HOME (aligned with volume mount)"
fi

# =============================================================================
# Git Identity Configuration
# =============================================================================
# Git requires user.name and user.email for commits. Configure from env vars.
# This persists to ~/.gitconfig on the volume.

if command -v git >/dev/null 2>&1; then
  if [ -n "$GIT_AUTHOR_NAME" ]; then
    git config --global user.name "$GIT_AUTHOR_NAME"
    echo "[init] Set git user.name to: $GIT_AUTHOR_NAME"
  fi

  if [ -n "$GIT_AUTHOR_EMAIL" ]; then
    git config --global user.email "$GIT_AUTHOR_EMAIL"
    echo "[init] Set git user.email to: $GIT_AUTHOR_EMAIL"
  fi

  # =============================================================================
  # SSH Known Hosts (GitHub)
  # =============================================================================
  if [ ! -f ~/.ssh/known_hosts ] || ! grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null; then
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null
    echo "[init] Added github.com to known_hosts"
  fi

  # =============================================================================
  # Git Credentials (HTTPS with GitHub Token)
  # =============================================================================
  if [ -n "$GITHUB_TOKEN" ]; then
    git config --global credential.helper store

    CRED_LINE="https://${GITHUB_TOKEN}:x-oauth-basic@github.com"
    CRED_FILE="$HOME/.git-credentials"

    if [ -f "$CRED_FILE" ]; then
      if ! grep -q "github.com" "$CRED_FILE" 2>/dev/null; then
        echo "$CRED_LINE" >> "$CRED_FILE"
        echo "[init] Added GitHub credentials to .git-credentials"
      fi
    else
      echo "$CRED_LINE" > "$CRED_FILE"
      chmod 600 "$CRED_FILE"
      echo "[init] Created .git-credentials with GitHub token"
    fi
  fi
else
  echo "[init] git not found — skipping git/ssh configuration"
fi

# =============================================================================
# Workspace Directory
# =============================================================================
# Ensure workspace directory exists if configured

if [ -n "$JINN_WORKSPACE_DIR" ]; then
  mkdir -p "$JINN_WORKSPACE_DIR"
  echo "[init] Ensured workspace dir exists: $JINN_WORKSPACE_DIR"
fi

# =============================================================================
# Gemini CLI Directory
# =============================================================================
# Ensure ~/.gemini exists for OAuth credential storage

mkdir -p ~/.gemini

# If GEMINI_API_KEY is set, always configure Gemini CLI for API key auth.
# Force-overwrite settings.json to prevent stale OAuth config on the volume
# from triggering the interactive OAuth prompt in non-interactive containers.
if [ -n "$GEMINI_API_KEY" ]; then
  cat > ~/.gemini/settings.json << 'SETTINGS'
{
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  }
}
SETTINGS
  # Also remove stale OAuth credentials that may override API key auth
  rm -f ~/.gemini/oauth_creds.json ~/.gemini/google_accounts.json
  echo "[init] Configured Gemini CLI for API key auth (forced)"
fi

echo "[init] Ensured ~/.gemini exists"

# =============================================================================
# Multi-Service Config Hydration
# =============================================================================
# Populate .operate/services/ from OPERATE_SERVICE_*_CONFIG env vars.
# Each service needs two env vars (base64-encoded):
#   OPERATE_SERVICE_<id>_CONFIG  → config.json
#   OPERATE_SERVICE_<id>_KEYS    → keys.json
# where <id> uses underscores (e.g., sc_b3aaf73c for sc-b3aaf73c-...).
# The full directory name is resolved from config.json's service_config_id field.

MIDDLEWARE_DIR="${MIDDLEWARE_PATH:-$(dirname "${OPERATE_PROFILE_DIR:-/home/jinn/.operate}")}"
SERVICES_DIR="${MIDDLEWARE_DIR}/.operate/services"

hydrated=0
for var in $(env | grep '^OPERATE_SERVICE_.*_CONFIG=' | sed 's/=.*//'); do
  prefix="${var%_CONFIG}"
  config_b64="${!var}"
  keys_var="${prefix}_KEYS"
  keys_b64="${!keys_var}"

  if [ -z "$config_b64" ]; then continue; fi

  # Extract the full service_config_id from the JSON (use node since python3 may not be in runtime image)
  sc_id=$(echo "$config_b64" | base64 -d | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).service_config_id))" 2>/dev/null || true)
  if [ -z "$sc_id" ]; then
    echo "[init] WARN: Could not extract service_config_id from $var"
    continue
  fi

  target_dir="${SERVICES_DIR}/${sc_id}"
  if ! mkdir -p "$target_dir" 2>/dev/null; then
    echo "[init] WARN: Cannot create $target_dir (permission denied?) — skipping hydration for $sc_id"
    continue
  fi

  echo "$config_b64" | base64 -d > "${target_dir}/config.json"
  echo "[init] Wrote ${target_dir}/config.json"

  if [ -n "$keys_b64" ]; then
    echo "$keys_b64" | base64 -d > "${target_dir}/keys.json"
    echo "[init] Wrote ${target_dir}/keys.json"
  fi

  hydrated=$((hydrated + 1))
done

if [ "$hydrated" -gt 0 ]; then
  echo "[init] Hydrated $hydrated service config(s) into $SERVICES_DIR"
fi

echo "[init] Worker initialization complete"
# trigger rebuild
