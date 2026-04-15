#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

REMOTE_NAME="jinn-node"
REMOTE_URL="https://github.com/Jinn-Network/jinn-node.git"
PREFIX="jinn-node"
BRANCH="main"

usage() {
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  setup   Add jinn-node remote (idempotent) and fetch"
    echo "  push    Push monorepo jinn-node/ to standalone repo"
    echo "  pull    Pull standalone repo into monorepo jinn-node/"
    echo "  status  Show sync status between monorepo and standalone"
    echo ""
    echo "Run from the monorepo root. Working tree must be clean for push/pull."
}

ensure_repo_root() {
    cd "$REPO_ROOT"
    if [ ! -d ".git" ] && [ ! -f ".git" ]; then
        log_error "Not a git repository: $REPO_ROOT"
        exit 1
    fi
}

ensure_clean_tree() {
    if [ -n "$(git status --porcelain)" ]; then
        log_error "Working tree has uncommitted changes. Commit or stash first."
        exit 1
    fi
}

cmd_setup() {
    ensure_repo_root
    log_step "Setting up jinn-node subtree remote..."

    local current_url
    current_url=$(git remote get-url "$REMOTE_NAME" 2>/dev/null || echo "")

    if [ -z "$current_url" ]; then
        git remote add "$REMOTE_NAME" "$REMOTE_URL"
        log_success "Added remote '$REMOTE_NAME' -> $REMOTE_URL"
    elif [ "$current_url" != "$REMOTE_URL" ]; then
        git remote set-url "$REMOTE_NAME" "$REMOTE_URL"
        log_warning "Updated remote '$REMOTE_NAME' URL: $current_url -> $REMOTE_URL"
    else
        log_info "Remote '$REMOTE_NAME' already configured correctly"
    fi

    log_info "Fetching $REMOTE_NAME..."
    git fetch "$REMOTE_NAME"
    log_success "Setup complete"
}

cmd_push() {
    ensure_repo_root
    cmd_setup
    ensure_clean_tree

    log_step "Pushing jinn-node/ to standalone repo..."
    log_info "This may take a moment (subtree split replays history)"

    git subtree push --prefix="$PREFIX" "$REMOTE_NAME" "$BRANCH"
    log_success "Pushed jinn-node/ to $REMOTE_NAME/$BRANCH"
}

cmd_pull() {
    ensure_repo_root
    cmd_setup
    ensure_clean_tree

    log_step "Pulling standalone repo into jinn-node/..."

    git subtree pull --prefix="$PREFIX" "$REMOTE_NAME" "$BRANCH" \
        -m "chore: sync jinn-node from standalone repo"
    log_success "Pulled $REMOTE_NAME/$BRANCH into jinn-node/"
}

cmd_status() {
    ensure_repo_root
    cmd_setup

    log_step "Checking jinn-node subtree sync status..."

    # Monorepo commits to jinn-node/ not yet in standalone
    local unpushed
    unpushed=$(git log --oneline "$REMOTE_NAME/$BRANCH"..HEAD -- "$PREFIX/" 2>/dev/null || echo "")

    if [ -n "$unpushed" ]; then
        local count
        count=$(echo "$unpushed" | wc -l | tr -d ' ')
        log_warning "Monorepo has $count commit(s) to jinn-node/ not yet pushed:"
        echo "$unpushed" | while read -r line; do
            echo "  $line"
        done
        echo ""
        log_info "Run 'yarn subtree:push' to sync"
    else
        log_success "No unpushed monorepo changes to jinn-node/"
    fi

    # Show latest standalone commits
    echo ""
    log_info "Latest standalone commits ($REMOTE_NAME/$BRANCH):"
    git log --oneline -5 "$REMOTE_NAME/$BRANCH" 2>/dev/null | while read -r line; do
        echo "  $line"
    done
}

# --- Main dispatch ---
case "${1:-help}" in
    setup)  cmd_setup ;;
    push)   cmd_push ;;
    pull)   cmd_pull ;;
    status) cmd_status ;;
    help|--help|-h) usage ;;
    *) log_error "Unknown command: $1"; usage; exit 1 ;;
esac
