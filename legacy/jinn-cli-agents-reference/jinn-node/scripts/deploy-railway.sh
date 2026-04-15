#!/bin/bash
# =============================================================================
# deploy-railway.sh — Deploy jinn-node to Railway (non-interactive)
# =============================================================================
# Handles the entire deployment pipeline: project/service setup, volume,
# environment variables, credential import, and deployment.
#
# Usage:
#   bash scripts/deploy-railway.sh --project <name> [options]
#   yarn deploy:railway -- --project <name> [options]
#
# Both --project and --service are "upsert": links if exists, creates if not.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JINN_NODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RAILWAY_TOML="$JINN_NODE_DIR/railway.toml"

# Defaults
PROJECT_NAME=""
SERVICE_NAME="jinn-worker"
SKIP_IMPORT=false
DRY_RUN=false
TOML_BACKED_UP=false

# =============================================================================
# Formatting
# =============================================================================
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "  ${BLUE}$1${NC}"; }
success() { echo -e "  ${GREEN}$1${NC}"; }
warn()    { echo -e "  ${YELLOW}$1${NC}"; }
error()   { echo -e "  ${RED}$1${NC}" >&2; }
step()    { echo -e "\n${BOLD}$1${NC}"; }

# Dry-run aware command executor
run() {
  if [[ "$DRY_RUN" == true ]]; then
    info "[dry-run] $*"
    return 0
  fi
  "$@"
}

# =============================================================================
# Usage
# =============================================================================
usage() {
  cat <<'USAGE'
Deploy jinn-node to Railway.

Usage:
  bash scripts/deploy-railway.sh --project <name> [options]
  yarn deploy:railway -- --project <name> [options]

Options:
  --project <name>     Railway project (creates if not found)
  --service <name>     Service name (creates if not found, default: jinn-worker)
  --skip-import        Skip .operate/.gemini SSH import (for re-deploys)
  --dry-run            Preview commands without executing
  --help, -h           Show this help

Examples:
  # First-time deploy
  bash scripts/deploy-railway.sh --project jinn-worker

  # Deploy with custom service name
  bash scripts/deploy-railway.sh --project jinn-shared --service canary-worker

  # Re-deploy (credentials already on volume)
  bash scripts/deploy-railway.sh --project jinn-worker --skip-import

  # Preview what would happen
  bash scripts/deploy-railway.sh --project jinn-worker --dry-run
USAGE
}

# =============================================================================
# Argument parsing
# =============================================================================
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project)   PROJECT_NAME="$2"; shift 2 ;;
      --service)   SERVICE_NAME="$2"; shift 2 ;;
      --skip-import) SKIP_IMPORT=true; shift ;;
      --dry-run)   DRY_RUN=true; shift ;;
      --help|-h)   usage; exit 0 ;;
      *)           error "Unknown option: $1"; usage; exit 1 ;;
    esac
  done
}

# =============================================================================
# Cleanup trap — restore railway.toml if modified
# =============================================================================
cleanup_toml() {
  if [[ "$TOML_BACKED_UP" == true && -f "${RAILWAY_TOML}.bak" ]]; then
    warn "Restoring railway.toml from backup (interrupted)..."
    cp "${RAILWAY_TOML}.bak" "$RAILWAY_TOML"
    rm -f "${RAILWAY_TOML}.bak"
    TOML_BACKED_UP=false
  fi
}
trap cleanup_toml EXIT

# =============================================================================
# Cross-platform helpers
# =============================================================================
is_macos() { [[ "$(uname)" == "Darwin" ]]; }

# Create a Railway service, handling the interactive variable prompt.
# Railway CLI's TUI crashes when stdin is piped but stdout is a TTY.
# Wrapping with `script` allocates a pseudo-TTY so the TUI initializes,
# then receives Escape from the pipe to dismiss the variable prompt.
add_railway_service() {
  local name="$1"
  info "Creating service: $name"

  if [[ "$DRY_RUN" == true ]]; then
    info "[dry-run] railway add --service $name"
    return 0
  fi

  if is_macos; then
    printf '\x1b' | script -q /dev/null railway add --service "$name" >/dev/null 2>&1
  else
    printf '\x1b' | script -qc "railway add --service '$name'" /dev/null >/dev/null 2>&1
  fi
}

# Poll until the Railway service reaches Running state.
poll_until_running() {
  local timeout="${1:-180}"
  local elapsed=0
  local interval=10

  while (( elapsed < timeout )); do
    local status
    status=$(railway service status 2>&1 || true)
    if echo "$status" | grep -qi "running\|success"; then
      success "Container running (${elapsed}s)"
      return 0
    fi
    sleep "$interval"
    (( elapsed += interval ))
    info "Waiting for container... (${elapsed}s / ${timeout}s)"
  done

  error "Container did not reach Running state within ${timeout}s"
  error "Check: railway deployment list"
  exit 1
}

# =============================================================================
# Step 1: Preconditions
# =============================================================================
check_preconditions() {
  step "Checking preconditions"

  # .operate directory (required for import)
  if [[ "$SKIP_IMPORT" == false && ! -d "$JINN_NODE_DIR/.operate" ]]; then
    error ".operate/ not found in $JINN_NODE_DIR"
    error "Run local setup first (yarn setup), then re-run this script."
    exit 1
  fi

  # .env file
  if [[ ! -f "$JINN_NODE_DIR/.env" ]]; then
    error ".env not found in $JINN_NODE_DIR"
    error "Copy .env.example to .env and fill in required values."
    exit 1
  fi

  # Railway CLI version (>= 4.16.0)
  local version
  version=$(railway --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
  if [[ -z "$version" ]]; then
    error "Railway CLI not found. Install: npm install -g @railway/cli"
    exit 1
  fi
  local major minor
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)
  if (( major < 4 || (major == 4 && minor < 16) )); then
    error "Railway CLI $version too old (minimum: 4.16.0)"
    error "Update: npm install -g @railway/cli@latest"
    exit 1
  fi
  success "Railway CLI $version"

  # Auth check
  local whoami
  whoami=$(railway whoami 2>/dev/null || true)
  if [[ -z "$whoami" ]]; then
    error "Not logged in to Railway. Run: railway login"
    exit 1
  fi
  success "Authenticated as $whoami"

  # railway.toml must exist
  if [[ ! -f "$RAILWAY_TOML" ]]; then
    error "railway.toml not found at $RAILWAY_TOML"
    exit 1
  fi
  success "railway.toml found"
}

# =============================================================================
# Step 2: Link or create project + service
# =============================================================================
ensure_project_linked() {
  step "Linking Railway project + service"

  # Check current link status
  local status_output
  status_output=$(railway status 2>&1 || true)

  local linked_project linked_service
  linked_project=$(echo "$status_output" | sed -n 's/.*Project: //p' || true)
  linked_service=$(echo "$status_output" | sed -n 's/.*Service: //p' || true)

  # Already linked to the right project and service?
  if [[ -n "$linked_project" && -n "$linked_service" ]]; then
    if [[ -z "$PROJECT_NAME" || "$linked_project" == "$PROJECT_NAME" ]]; then
      if [[ "$linked_service" == "$SERVICE_NAME" ]]; then
        success "Already linked: $linked_project / $linked_service"
        return 0
      fi
    fi
  fi

  # --project is required if not already linked
  if [[ -z "$PROJECT_NAME" ]]; then
    if [[ -n "$linked_project" ]]; then
      PROJECT_NAME="$linked_project"
      info "Using currently linked project: $PROJECT_NAME"
    else
      error "--project <name> is required (no project currently linked)"
      exit 1
    fi
  fi

  # Try linking to existing project + service
  info "Linking to project: $PROJECT_NAME, service: $SERVICE_NAME"
  if run railway link -p "$PROJECT_NAME" -s "$SERVICE_NAME" -e production 2>/dev/null; then
    # railway link can return 0 even when the service doesn't exist (links project only).
    # Verify the service is actually linked before proceeding.
    local verify_status verify_service
    verify_status=$(railway status 2>&1 || true)
    verify_service=$(echo "$verify_status" | sed -n 's/.*Service: //p' || true)
    if [[ -n "$verify_service" && "$verify_service" != "None" ]]; then
      success "Linked to existing project + service"
      return 0
    fi
    info "Project linked but service '$SERVICE_NAME' not found — will create it"
  fi

  # Project might exist but service doesn't — link project, then create service
  if run railway link -p "$PROJECT_NAME" -e production 2>/dev/null; then
    info "Project found, but service '$SERVICE_NAME' does not exist"
    add_railway_service "$SERVICE_NAME"
    run railway service link "$SERVICE_NAME"
    success "Created and linked service: $SERVICE_NAME"
    return 0
  fi

  # Project doesn't exist — create it
  info "Project '$PROJECT_NAME' not found, creating..."
  warn "railway init may prompt for workspace selection if you belong to multiple teams."
  run railway init
  add_railway_service "$SERVICE_NAME"
  run railway service link "$SERVICE_NAME"
  success "Created project and service: $SERVICE_NAME"
}

# =============================================================================
# Step 3: Persistent volume
# =============================================================================
ensure_volume() {
  step "Ensuring persistent volume"

  local volume_output
  volume_output=$(railway volume list 2>&1 || true)

  # Check if a volume is attached to THIS service at /home/jinn
  # Volume list output format: "Attached to: <service-name>" followed by "Mount path: /home/jinn"
  # We need to match the current SERVICE_NAME, not just any volume in the project.
  if echo "$volume_output" | grep -A2 "Attached to: $SERVICE_NAME" | grep -q "/home/jinn"; then
    success "Volume already mounted at /home/jinn on $SERVICE_NAME"
    return 0
  fi

  run railway volume add --mount-path /home/jinn
  success "Volume created at /home/jinn"
}

# =============================================================================
# Step 4: Push environment variables from .env
# =============================================================================
push_env_vars() {
  step "Pushing environment variables"

  local args=()
  local count=0

  while IFS= read -r line; do
    # Skip comments and blank lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// /}" ]] && continue
    [[ ! "$line" =~ = ]] && continue

    local key="${line%%=*}"
    local value="${line#*=}"

    # Strip surrounding quotes
    value="${value#\"}" ; value="${value%\"}"
    value="${value#\'}" ; value="${value%\'}"

    # Skip empty values
    [[ -z "$value" ]] && continue

    args+=("--set" "${key}=${value}")
    count=$((count + 1))
  done < "$JINN_NODE_DIR/.env"

  if (( count == 0 )); then
    warn "No non-empty variables found in .env"
    return 0
  fi

  info "Setting $count variables (batched, --skip-deploys)..."
  if [[ "$DRY_RUN" == true ]]; then
    # List variable names only — never print secrets
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// /}" ]] && continue
      [[ ! "$line" =~ = ]] && continue
      local k="${line%%=*}"
      local v="${line#*=}"
      [[ -z "$v" ]] && continue
      info "  [dry-run] --set ${k}=***"
    done < "$JINN_NODE_DIR/.env"
  else
    railway variables "${args[@]}" --skip-deploys
  fi
  success "$count variables pushed"
}

# =============================================================================
# Step 5: Import .operate and .gemini via SSH
# =============================================================================
import_credentials() {
  if [[ "$SKIP_IMPORT" == true ]]; then
    step "Importing credentials — skipped (--skip-import)"
    return 0
  fi

  step "Importing credentials via SSH"

  # Back up railway.toml so we can restore it on failure
  cp "$RAILWAY_TOML" "${RAILWAY_TOML}.bak"
  TOML_BACKED_UP=true

  # Write a minimal railway.toml for the idle container.
  # CRITICAL: No healthcheckPath — tail -f /dev/null doesn't serve HTTP,
  # so any healthcheck would fail and prevent the container from reaching Running.
  info "Writing idle railway.toml (no healthcheck)..."
  cat > "$RAILWAY_TOML" <<'IDLE_TOML'
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "tail -f /dev/null"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
IDLE_TOML

  info "Deploying idle container..."
  run railway up --detach

  info "Waiting for container to start..."
  if [[ "$DRY_RUN" == false ]]; then
    poll_until_running 360
  fi

  info "Creating target directories..."
  run railway ssh -- 'mkdir -p /home/jinn/.operate /home/jinn/.gemini'

  # Railway SSH uses WebSocket and does NOT forward stdin pipes.
  # We tar .operate/ excluding only deployment/ dirs (Python venvs, ~179MB each,
  # recreated at runtime). Service configs (config.json, keys.json) are preserved.
  # The result is base64-encoded and passed as a command argument.
  info "Importing .operate/ to volume (excluding deployment venvs)..."
  if [[ "$DRY_RUN" == false ]]; then
    local payload
    payload=$(cd "$JINN_NODE_DIR" && tar czf - --exclude='services/*/deployment' .operate | base64)
    railway ssh -- "echo '$payload' | base64 -d | tar xzf - -C /home/jinn"
    success ".operate imported (keys, wallets, service configs)"
  else
    info "[dry-run] base64-encode .operate (excl deployment venvs) → railway ssh decode+extract"
    success ".operate imported"
  fi

  # Import .gemini settings if present (OAuth tokens, settings.json).
  # Exclude bulky dirs that get recreated at runtime:
  #   antigravity (~1.1G), antigravity-browser-profile (~344M), tmp, extensions (~60M)
  local gemini_excludes=(--exclude='antigravity' --exclude='antigravity-browser-profile' --exclude='tmp' --exclude='extensions')
  if [[ -d "$HOME/.gemini" ]]; then
    local gemini_payload_size
    gemini_payload_size=$(tar czf - -C "$HOME" "${gemini_excludes[@]}" .gemini 2>/dev/null | wc -c)
    if (( gemini_payload_size < 1500000 )); then  # < 1.5MB tar → ~2MB base64 (fits ARG_MAX)
      info "Importing .gemini/ settings to volume..."
      if [[ "$DRY_RUN" == false ]]; then
        local gemini_payload
        gemini_payload=$(tar czf - -C "$HOME" "${gemini_excludes[@]}" .gemini | base64)
        railway ssh -- "echo '$gemini_payload' | base64 -d | tar xzf - -C /home/jinn"
        success ".gemini imported (OAuth tokens, settings)"
      else
        info "[dry-run] base64-encode .gemini (excl bulky dirs) → railway ssh decode+extract"
        success ".gemini imported"
      fi
    else
      warn ".gemini/ too large for SSH import ($(( gemini_payload_size / 1024 / 1024 ))MB). Skipping."
      info "Set GEMINI_API_KEY env var instead, or reduce ~/.gemini/ size."
    fi
  else
    info "No ~/.gemini found locally, skipping"
  fi

  info "Fixing volume ownership..."
  run railway ssh -- 'chown -R jinn:jinn /home/jinn'

  info "Verifying import..."
  run railway ssh -- 'ls -la /home/jinn/.operate /home/jinn/.gemini'

  # Restore railway.toml from backup
  info "Restoring railway.toml..."
  cp "${RAILWAY_TOML}.bak" "$RAILWAY_TOML"
  rm -f "${RAILWAY_TOML}.bak"
  TOML_BACKED_UP=false
  success "Credentials imported, railway.toml restored"
}

# =============================================================================
# Step 6: Deploy worker
# =============================================================================
deploy_worker() {
  step "Deploying worker"
  run railway up --detach
  success "Deployment initiated"
}

# =============================================================================
# Step 7: Verify
# =============================================================================
verify_deployment() {
  step "Verifying deployment"

  if [[ "$DRY_RUN" == true ]]; then
    info "[dry-run] railway deployment list + railway logs"
    return 0
  fi

  info "Recent deployments:"
  railway deployment list 2>&1 | head -10 || true

  sleep 5

  info "Recent logs (last 50 lines):"
  railway logs --lines 50 2>&1 || warn "Could not fetch logs (deployment may still be starting)"
}

# =============================================================================
# Summary
# =============================================================================
print_summary() {
  step "Done"
  echo ""

  local status_out current_project current_service
  status_out=$(railway status 2>&1 || true)
  current_project=$(echo "$status_out" | sed -n 's/.*Project: //p')
  current_service=$(echo "$status_out" | sed -n 's/.*Service: //p')
  current_project="${current_project:-$PROJECT_NAME}"
  current_service="${current_service:-$SERVICE_NAME}"

  info "Project:  $current_project"
  info "Service:  $current_service"
  info "Volume:   /home/jinn"
  if [[ "$SKIP_IMPORT" == true ]]; then
    info "Import:   skipped (--skip-import)"
  else
    info "Import:   completed"
  fi

  echo ""
  info "Next steps:"
  info "  Monitor logs:   railway logs --lines 200"
  info "  Check health:   railway service status"
  info "  Re-deploy:      yarn deploy:railway -- --project $current_project --skip-import"
  echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
  echo ""
  echo -e "${BOLD}  jinn-node Railway Deploy${NC}"
  echo ""

  parse_args "$@"
  check_preconditions
  ensure_project_linked
  ensure_volume
  push_env_vars
  import_credentials
  deploy_worker
  verify_deployment
  print_summary
}

main "$@"
