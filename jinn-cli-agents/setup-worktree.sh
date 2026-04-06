#!/usr/bin/env bash
set -e  # Exit on any error

echo "🚀 Setting up worktree for worker testing..."
echo ""
echo "This is a streamlined setup script for running the worker in any worktree."
echo "For full development setup with test fixtures, use: ./conductor-setup.sh"
echo ""

# =============================================================================
# Color codes and logging functions
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

MAIN_REPO_ROOT=""
WORKTREE_GITDIR=""
WORKTREE_NAME=""
REPO_CONTEXT=""

error() {
    echo -e "${RED}❌ ERROR: $1${NC}"
    exit 1
}

success() {
    echo -e "${GREEN}✓ $1${NC}"
}

warning() {
    echo -e "${YELLOW}⚠ WARNING: $1${NC}"
}

info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

step() {
    echo ""
    echo -e "${BLUE}🔧 $1${NC}"
}

detect_repo_context() {
    if [ -n "$MAIN_REPO_ROOT" ]; then
        return
    fi

    if [ -f .git ]; then
        WORKTREE_GITDIR=$(sed 's/gitdir:[[:space:]]*//;q' .git | tr -d '\r')
        if [ -z "$WORKTREE_GITDIR" ] || [ ! -d "$WORKTREE_GITDIR" ]; then
            error "Worktree gitdir not found: $WORKTREE_GITDIR"
        fi
        MAIN_REPO_ROOT=$(dirname "$(dirname "$(dirname "$WORKTREE_GITDIR")")")
        WORKTREE_NAME=$(basename "$WORKTREE_GITDIR")
        REPO_CONTEXT="worktree"
    elif [ -d .git ]; then
        MAIN_REPO_ROOT="$(pwd)"
        WORKTREE_GITDIR="$MAIN_REPO_ROOT/.git"
        WORKTREE_NAME=""
        REPO_CONTEXT="main"
    else
        error "Not in a git repository"
    fi
}

# =============================================================================
# 1. Prerequisites validation
# =============================================================================

check_prerequisites() {
    step "Checking prerequisites..."

    local missing=()

    # Check Node.js version
    if ! command -v node &> /dev/null; then
        missing+=("node v22+")
    else
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -lt 22 ]; then
            error "Node.js version must be v22.x or higher (current: $(node -v))"
        fi
        success "Node.js version OK ($(node -v))"
    fi

    # Check other dependencies (skip python3 and poetry)
    for cmd in yarn git; do
        if ! command -v $cmd &> /dev/null; then
            missing+=("$cmd")
        else
            success "$cmd found ($(command -v $cmd))"
        fi
    done

    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}"
    fi

    success "All prerequisites installed"
}

# =============================================================================
# 2. Worktree detection & environment setup
# =============================================================================

copy_env_files_for_dir() {
    local rel_dir="$1"  # e.g. "." or "frontend/explorer"
    local src_dir="$MAIN_REPO_ROOT/$rel_dir"
    local dst_dir="./$rel_dir"
    local label="$rel_dir"
    [ "$rel_dir" = "." ] && label="root"

    # Find all .env* files in the source directory (non-recursive, skip templates/examples)
    local found=0
    for src_file in "$src_dir"/.env*; do
        [ -f "$src_file" ] || continue
        local basename=$(basename "$src_file")

        # Skip templates and examples — they're checked into git already
        case "$basename" in
            *.template|*.example) continue ;;
        esac

        local dst_file="$dst_dir/$basename"

        if [ -f "$dst_file" ]; then
            success "$label/$basename already exists"
        else
            mkdir -p "$dst_dir"
            cp "$src_file" "$dst_file"
            success "Copied $label/$basename"
        fi
        found=$((found + 1))
    done

}

setup_environment_files() {
    step "Setting up environment files..."

    detect_repo_context

    if [ "$REPO_CONTEXT" = "worktree" ]; then
        info "Detected git worktree setup"
        info "Main repo root: $MAIN_REPO_ROOT"
    else
        info "Already in main repository"
    fi

    # Copy root .env files (required)
    if [ ! -f "$MAIN_REPO_ROOT/.env" ]; then
        error ".env file not found at $MAIN_REPO_ROOT/.env"
    fi
    copy_env_files_for_dir "."

    # Copy .env files from subdirectories that may have their own configs
    local env_dirs=(
        "frontend/app"
        "frontend/explorer"
        "frontend/website"
        "jinn-node"
        "ponder"
        "control-api"
        "gemini-agent"
    )

    for dir in "${env_dirs[@]}"; do
        if ls "$MAIN_REPO_ROOT/$dir"/.env* 1>/dev/null 2>&1; then
            copy_env_files_for_dir "$dir"
        fi
    done

    # jinn-node needs root .env vars (RPC_URL, CHAIN_ID, etc.) — copy root .env
    # into jinn-node/ if it doesn't already have one
    if [ ! -f "./jinn-node/.env" ]; then
        cp "./.env" "./jinn-node/.env"
        success "Copied root .env to jinn-node/.env"
    fi
}

# =============================================================================
# 3. Operate profile setup (CRITICAL)
# =============================================================================

setup_operate_profile() {
    step "Setting up operate profile (required for worker)..."

    detect_repo_context

    local operate_source=""
    local operate_target="olas-operate-middleware/.operate"

    if [ "$REPO_CONTEXT" = "worktree" ]; then
        operate_source="$MAIN_REPO_ROOT/olas-operate-middleware/.operate"
    else
        operate_source="olas-operate-middleware/.operate"
    fi

    # Check if source exists
    if [ ! -d "$operate_source" ]; then
        error ".operate directory not found at $operate_source. Run the main repo setup first to configure service credentials."
    fi

    # Create target directory
    mkdir -p "$(dirname "$operate_target")"

    # Copy operate profile to worktree
    if [ "$REPO_CONTEXT" = "worktree" ]; then
        info "Copying .operate from main repo to worktree..."
        # Use cp -a to preserve permissions and timestamps
        if cp -a "$operate_source"/. "$operate_target"/ 2>/dev/null; then
            :
        else
            cp -R "$operate_source"/. "$operate_target"/
        fi
        success "Operate profile copied to $operate_target"
    else
        success "Operate profile already at $operate_target (main repo)"
    fi

    # Verify critical files exist
    if [ ! -d "$operate_target/services" ]; then
        error "Operate profile missing services directory"
    fi

    if [ ! -d "$operate_target/keys" ]; then
        error "Operate profile missing keys directory"
    fi

    success "Operate profile validated (services and keys present)"
}

# =============================================================================
# 4. Infrastructure checks
# =============================================================================

check_infrastructure() {
    step "Checking infrastructure (Ponder and Control API)..."

    local ponder_running=false
    local control_api_running=false

    # Check Ponder
    if curl -s --max-time 2 http://localhost:42069/health > /dev/null 2>&1; then
        ponder_running=true
        success "Ponder is running at http://localhost:42069"
    else
        warning "Ponder not detected at http://localhost:42069 (worker will need it to query requests)"
    fi

    # Check Control API
    if curl -s --max-time 2 -X POST http://localhost:4001/graphql \
        -H "Content-Type: application/json" \
        -d '{"query":"{ __typename }"}' > /dev/null 2>&1; then
        control_api_running=true
        success "Control API is running at http://localhost:4001/graphql"
    else
        info "Control API not running - attempting to start..."

        # Try to start Control API in background
        nohup yarn dev:control-api > /tmp/control-api.log 2>&1 &
        local control_pid=$!

        # Wait up to 30 seconds for Control API to become available
        local max_wait=30
        local waited=0
        while [ $waited -lt $max_wait ]; do
            if curl -s --max-time 2 -X POST http://localhost:4001/graphql \
                -H "Content-Type: application/json" \
                -d '{"query":"{ __typename }"}' > /dev/null 2>&1; then
                control_api_running=true
                success "Control API started successfully (PID: $control_pid)"
                break
            fi
            sleep 2
            waited=$((waited + 2))
        done

        if [ "$control_api_running" = false ]; then
            warning "Failed to auto-start Control API. Start it manually with: yarn dev:control-api"
        fi
    fi
}

# =============================================================================
# 5. Install dependencies & build
# =============================================================================

install_node_dependencies() {
    step "Installing Node.js dependencies..."

    # Check if node_modules exists and is recent
    if [ -d node_modules ] && [ -f package.json ]; then
        if [ node_modules/.bin/tsc -nt package.json ]; then
            info "Dependencies appear up-to-date, skipping install..."
        else
            info "Installing dependencies..."
            yarn install --silent
            success "Dependencies installed"
        fi
    else
        info "Installing dependencies..."
        yarn install --silent
        success "Dependencies installed"
    fi

    # Build project
    info "Building project..."
    yarn build > /dev/null 2>&1
    success "Project built successfully"
}

# =============================================================================
# 6. Validation & completion
# =============================================================================

validate_setup() {
    step "Validating setup..."

    local errors=()
    local warnings=()

    # Check critical build artifacts
    if [ ! -f "node_modules/@jinn-network/mech-client-ts/dist/marketplace_interact.js" ]; then
        errors+=("@jinn-network/mech-client-ts not properly installed")
    else
        success "@jinn-network/mech-client-ts package installed"
    fi

    # Check environment files
    if [ ! -f ".env" ]; then
        errors+=(".env file missing")
    else
        success ".env file present"
    fi

    # Check operate profile
    if [ ! -d "olas-operate-middleware/.operate" ]; then
        errors+=("Operate profile missing at olas-operate-middleware/.operate")
    else
        success "Operate profile present"
    fi

    if [ ! -d "olas-operate-middleware/.operate/services" ]; then
        errors+=("Operate services directory missing")
    else
        success "Operate services directory present"
    fi

    # Report warnings
    if [ ${#warnings[@]} -gt 0 ]; then
        echo ""
        warning "Setup warnings (non-blocking):"
        for w in "${warnings[@]}"; do
            echo "  ⚠  $w"
        done
    fi

    # Report errors (blocking)
    if [ ${#errors[@]} -gt 0 ]; then
        echo ""
        error "Setup validation failed:"
        for e in "${errors[@]}"; do
            echo "  ❌ $e"
        done
        return 1
    fi

    success "Setup validation passed"
}

# =============================================================================
# 7. Print completion message
# =============================================================================

print_completion() {
    echo ""
    echo "========================================="
    success "🎉 Worktree setup complete!"
    echo "========================================="
    echo ""
    echo "Environment:"
    echo "  ✓ .env configured"
    echo "  ✓ Operate profile copied (mech credentials)"
    echo "  ✓ Dependencies installed and built"
    echo ""
    echo "Next steps:"
    echo "  • Start the worker:"
    echo "    yarn mech"
    echo ""
    echo "  • Or run in single-job mode for testing:"
    echo "    yarn mech --single"
    echo ""
    echo "  • Make sure Ponder is running:"
    echo "    yarn dev:ponder"
    echo ""
    echo "Note: This setup skips test fixtures for speed."
    echo "      For full test suite support, use: ./conductor-setup.sh"
    echo ""
}

# =============================================================================
# Main execution
# =============================================================================

main() {
    check_prerequisites
    setup_environment_files
    setup_operate_profile
    check_infrastructure
    install_node_dependencies

    if validate_setup; then
        print_completion
    else
        echo ""
        error "Setup validation failed. Fix errors above and re-run."
    fi
}

main
