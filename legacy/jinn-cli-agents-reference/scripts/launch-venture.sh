#!/bin/bash

##
# Venture Launch Script
#
# Launches an agentic venture by dispatching the first job with proper environment configuration.
#
# Usage:
#   ./scripts/launch-venture.sh --repo <path> --job-name "..." --objective "..." --context "..." --acceptance-criteria "..." [options]
#
# Options:
#   --repo <path>                    Path to venture repository (required)
#   --test                           Use .env.test instead of .env
#   --job-name <name>                Name of the first job (required)
#   --objective <text>               Job objective (required)
#   --context <text>                 Job context (required unless CONTEXT_FILE set)
#   --acceptance-criteria <text>     Acceptance criteria (required)
#   --deliverables <text>            Optional deliverables
#   --constraints <text>             Optional constraints
#   --enabled-tools <tool1,tool2>    Comma-separated list of enabled tools
#
# Example:
#   ./scripts/launch-venture.sh \
#     --repo ~/jinn-repos/jinn-marketing \
#     --job-name "Marketing CEO" \
#     --objective "Maximize awareness" \
#     --context "You are the CEO..." \
#     --acceptance-criteria "Success is measured by..."
##

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------

REPO_PATH=""
TEST_MODE=false
JOB_NAME=""
OBJECTIVE=""
CONTEXT=""
ACCEPTANCE_CRITERIA=""
DELIVERABLES=""
CONSTRAINTS=""
ENABLED_TOOLS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_PATH="$2"
      shift 2
      ;;
    --test)
      TEST_MODE=true
      shift
      ;;
    --job-name)
      JOB_NAME="$2"
      shift 2
      ;;
    --objective)
      OBJECTIVE="$2"
      shift 2
      ;;
    --context)
      CONTEXT="$2"
      shift 2
      ;;
    --acceptance-criteria)
      ACCEPTANCE_CRITERIA="$2"
      shift 2
      ;;
    --deliverables)
      DELIVERABLES="$2"
      shift 2
      ;;
    --constraints)
      CONSTRAINTS="$2"
      shift 2
      ;;
    --enabled-tools)
      ENABLED_TOOLS="$2"
      shift 2
      ;;
    *)
      log_error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------

if [[ -z "$REPO_PATH" ]]; then
  log_error "Missing required argument: --repo"
  exit 1
fi

if [[ -z "$JOB_NAME" || -z "$OBJECTIVE" || -z "$ACCEPTANCE_CRITERIA" ]]; then
  log_error "Missing required arguments: --job-name, --objective, --acceptance-criteria"
  exit 1
fi

if [[ -z "$CONTEXT" && -z "${CONTEXT_FILE:-}" ]]; then
  log_error "Missing context: provide --context or set CONTEXT_FILE environment variable"
  exit 1
fi

# Expand tilde in repo path
REPO_PATH="${REPO_PATH/#\~/$HOME}"

if [[ ! -d "$REPO_PATH" ]]; then
  log_error "Repository not found: $REPO_PATH"
  log_info "Clone the repository first, e.g.:"
  log_info "  git clone <remote-url> \"$REPO_PATH\""
  exit 1
fi

if [[ ! -d "$REPO_PATH/.git" ]]; then
  log_error "Not a git repository: $REPO_PATH"
  exit 1
fi

pushd "$REPO_PATH" >/dev/null
if ! git remote get-url origin >/dev/null 2>&1; then
  log_error "Git remote 'origin' not configured in $REPO_PATH"
  log_info "Configure it with:"
  log_info "  git remote add origin <remote-url>"
  popd >/dev/null
  exit 1
fi
REMOTE_URL="$(git remote get-url origin)"
popd >/dev/null

log_success "Repository validated: $REPO_PATH"
log_info "Remote URL: $REMOTE_URL"

# -----------------------------------------------------------------------------
# Environment setup
# -----------------------------------------------------------------------------

cd "$SCRIPT_DIR/.."

ENV_FILE=".env"
if [[ "$TEST_MODE" = true ]]; then
  ENV_FILE=".env.test"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  log_error "Environment file not found: $ENV_FILE"
  exit 1
fi

log_step "Loading environment from $ENV_FILE"
set -a
source "$ENV_FILE"
set +a

export CODE_METADATA_REPO_ROOT="$REPO_PATH"
log_success "CODE_METADATA_REPO_ROOT set to: $CODE_METADATA_REPO_ROOT"

# -----------------------------------------------------------------------------
# Ponder lifecycle
# -----------------------------------------------------------------------------

PONDER_PORT="${PONDER_PORT:-42069}"
if [[ "$TEST_MODE" = true ]]; then
  PONDER_PORT=42070
fi
export PONDER_PORT

PONDER_STARTED=false
PONDER_PID=""

cleanup() {
  if [[ "$PONDER_STARTED" = true && -n "$PONDER_PID" ]]; then
    kill "$PONDER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log_step "Checking Ponder on port $PONDER_PORT"
if ! lsof -i ":$PONDER_PORT" >/dev/null 2>&1; then
  log_info "Starting Ponder on port $PONDER_PORT..."
  PONDER_PORT=$PONDER_PORT yarn ponder:dev >/dev/null 2>&1 &
  PONDER_PID=$!
  PONDER_STARTED=true

  log_info "Waiting for Ponder to start..."
  PONDER_READY=false
  for _ in {1..30}; do
    if curl -s "http://localhost:$PONDER_PORT/graphql" >/dev/null 2>&1; then
      PONDER_READY=true
      log_success "Ponder is ready on port $PONDER_PORT"
      break
    fi
    sleep 1
  done

  if [[ "$PONDER_READY" = false ]]; then
    log_error "Ponder failed to start after 30 seconds"
    exit 1
  fi
else
  log_success "Ponder already running on port $PONDER_PORT"
fi

# -----------------------------------------------------------------------------
# Dispatch job
# -----------------------------------------------------------------------------

DISPATCH_CMD=("yarn" "tsx" "scripts/lib/launch-venture.ts"
  "--job-name" "$JOB_NAME"
  "--objective" "$OBJECTIVE"
  "--acceptance-criteria" "$ACCEPTANCE_CRITERIA")

if [[ -n "${CONTEXT_FILE:-}" ]]; then
  if [[ ! -f "$CONTEXT_FILE" ]]; then
    log_error "Context file not found: $CONTEXT_FILE"
    exit 1
  fi
  DISPATCH_CMD+=("--context-file" "$CONTEXT_FILE")
else
  DISPATCH_CMD+=("--context" "$CONTEXT")
fi

if [[ -n "$DELIVERABLES" ]]; then
  DISPATCH_CMD+=("--deliverables" "$DELIVERABLES")
fi

if [[ -n "$CONSTRAINTS" ]]; then
  DISPATCH_CMD+=("--constraints" "$CONSTRAINTS")
fi

if [[ -n "$ENABLED_TOOLS" ]]; then
  DISPATCH_CMD+=("--enabled-tools" "$ENABLED_TOOLS")
fi

log_step "Dispatching first job"
"${DISPATCH_CMD[@]}"

log_success "Venture launch complete!"
