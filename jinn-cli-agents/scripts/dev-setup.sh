#!/bin/bash

# Development Environment Setup Script for Git Worktrees
# This script automates the setup of development environments for new git worktrees

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Check system requirements
check_prerequisites() {
    log_step "Checking system prerequisites..."
    
    if validate_system_dependencies; then
        log_success "All prerequisites are installed"
    else
        log_error "Please install the missing dependencies and try again."
        exit 1
    fi
}

# Initialize git submodules with robust error handling
init_submodules() {
    log_step "Initializing git submodules..."
    
    if [ -f .gitmodules ]; then
        # First attempt: try normal submodule update
        if git submodule update --init --recursive 2>/dev/null; then
            log_success "Git submodules initialized"
            return 0
        fi
        
        log_warning "Submodule initialization encountered issues - attempting recovery"
        
        # Get submodule paths from .gitmodules
        local submodule_paths=$(git config --file .gitmodules --get-regexp "submodule\..*\.path" | cut -d' ' -f2)
        
        if [ -z "$submodule_paths" ]; then
            log_error "No submodules defined in .gitmodules"
            return 1
        fi
        
        # Attempt to recover each submodule
        local recovery_needed=false
        for path in $submodule_paths; do
            log_info "Checking submodule: $path"
            
            # Check if the expected commit exists in the remote
            local expected_commit=$(git ls-tree HEAD "$path" | awk '{print $3}')
            if [ -n "$expected_commit" ]; then
                # Try to fetch the specific commit
                if ! (cd "$path" 2>/dev/null && git cat-file -e "$expected_commit" 2>/dev/null); then
                    log_warning "Expected commit $expected_commit not found in submodule $path"
                    recovery_needed=true
                fi
            fi
            
            # Try individual submodule update
            if ! git submodule update --init "$path" 2>/dev/null; then
                log_warning "Failed to update submodule $path, attempting recovery"
                recovery_needed=true
                
                # Clean up and re-initialize the problematic submodule
                if [ -d "$path" ]; then
                    log_info "Cleaning up submodule directory: $path"
                    rm -rf "$path"
                fi
                
                if [ -d ".git/modules/$path" ]; then
                    log_info "Cleaning up cached submodule data: $path"
                    rm -rf ".git/modules/$path"
                fi
                
                # Get submodule URL
                local submodule_url=$(git config --file .gitmodules --get "submodule.$path.url")
                if [ -n "$submodule_url" ]; then
                    log_info "Re-cloning submodule from: $submodule_url"
                    if git clone "$submodule_url" "$path"; then
                        # Update .git/config to register the submodule
                        git submodule init "$path" 2>/dev/null || true
                        log_success "Successfully recovered submodule: $path"
                    else
                        log_error "Failed to clone submodule: $path"
                        return 1
                    fi
                else
                    log_error "Could not find URL for submodule: $path"
                    return 1
                fi
            fi
        done
        
        if [ "$recovery_needed" = true ]; then
            log_info "Submodule recovery completed - updating to latest available commits"
            # Update submodules to their latest commits instead of pinned ones
            for path in $submodule_paths; do
                if [ -d "$path" ]; then
                    (cd "$path" && git checkout HEAD 2>/dev/null || git checkout main 2>/dev/null || git checkout master 2>/dev/null || true)
                fi
            done
        fi
        
        log_success "Git submodules initialized (with recovery)"
    else
        log_warning "No .gitmodules file found, skipping submodule initialization"
    fi
}

# Setup Python environment
setup_python_environment() {
    log_step "Setting up Python environment..."
    
    local python_env_dir="olas-operate-middleware"
    
    if [ ! -d "$python_env_dir" ]; then
        log_error "olas-operate-middleware directory not found"
        log_error "Make sure git submodules are properly initialized"
        exit 1
    fi
    
    cd "$python_env_dir"
    
    # Auto-detect Python version if pyenv is available but don't mutate submodule state
    if command_exists pyenv && [ -f .python-version ]; then
        local required_python_version=$(cat .python-version)
        log_info "Found .python-version file requiring Python $required_python_version"
        
        if pyenv versions --bare | grep -q "^${required_python_version}$"; then
            log_info "Using Python version $required_python_version"
            # Use pyenv exec instead of pyenv local to avoid writing .python-version
            export PYENV_VERSION="$required_python_version"
        else
            log_warning "Python $required_python_version not installed in pyenv"
            log_info "Using system default Python version"
        fi
    elif command_exists pyenv; then
        # Check if we have Python 3.11.x available for olas-operate-middleware
        if pyenv versions --bare | grep -q "^3\.11\."; then
            local python_version=$(pyenv versions --bare | grep "^3\.11\." | head -n1)
            log_info "Using Python version $python_version for olas-operate-middleware compatibility"
            # Use environment variable instead of pyenv local to avoid mutating submodule
            export PYENV_VERSION="$python_version"
        fi
    fi
    
    # Check if Poetry is available AND pyproject.toml exists
    if command_exists poetry && [ -f pyproject.toml ]; then
        log_info "Using Poetry for Python dependency management"
        poetry install
        log_success "Poetry dependencies installed"
    else
        log_info "Poetry not available or no pyproject.toml found, using venv fallback"
        
        # Create virtual environment if it doesn't exist
        if [ ! -d "venv" ]; then
            python3 -m venv venv
            log_success "Python virtual environment created"
        fi
        
        # Activate virtual environment
        source venv/bin/activate
        
        # Upgrade pip
        pip install --upgrade pip
        
        # Install requirements if they exist
        if [ -f requirements.txt ]; then
            pip install -r requirements.txt
            log_success "Python dependencies installed from requirements.txt"
        elif [ -f ../requirements-olas.txt ]; then
            pip install -r ../requirements-olas.txt
            log_success "Python dependencies installed from requirements-olas.txt"
        else
            log_warning "No requirements.txt found, installing essential dependencies"
            pip install psutil aea aea-ledger-ethereum autonomy web3 requests
            log_success "Essential Python dependencies installed"
        fi
    fi
    
    cd ..
}

# Install Node.js dependencies
install_node_dependencies() {
    log_step "Installing Node.js dependencies..."
    
    if [ -f package.json ]; then
        yarn install
        log_success "Node.js dependencies installed"
    else
        log_error "No package.json found in project root"
        exit 1
    fi
    
    # Install frontend dependencies if they exist
    if [ -d "frontend/explorer" ] && [ -f "frontend/explorer/package.json" ]; then
        log_info "Installing frontend dependencies..."
        cd frontend/explorer
        yarn install
        cd ../..
        log_success "Frontend dependencies installed"
    fi
    
    # Install ponder dependencies if they exist
    if [ -d "ponder" ] && [ -f "ponder/package.json" ]; then
        log_info "Installing ponder dependencies..."
        cd ponder
        yarn install
        cd ..
        log_success "Ponder dependencies installed"
    fi
}

# Setup environment files
setup_environment_files() {
    log_step "Setting up environment files..."
    
    # Check if .env already exists in current directory
    if [ -f .env ]; then
        log_success ".env file already exists"
        log_info "Using existing .env configuration"
        return
    fi
    
    # Try to find .env in main repository root (for worktree scenarios)
    local main_repo_root=""
    local git_root=""
    
    # First try to get the main repository root from git worktree
    if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
        # Check if we're in a worktree by looking for .git file (not directory)
        if [ -f "${git_root}/.git" ]; then
            # Parse the .git file to find the main repository
            local git_dir=$(cat "${git_root}/.git" | sed 's/gitdir: //')
            # Remove the worktrees path to get main repo (.git/worktrees/name -> main repo)
            main_repo_root=$(dirname $(dirname $(dirname "$git_dir")))
        else
            # We're in the main repository
            main_repo_root="$git_root"
        fi
        
        # Try the main repository root first
        if [ -n "$main_repo_root" ] && [ -f "${main_repo_root}/.env" ]; then
            local main_env_path="${main_repo_root}/.env"
            if [ "$main_env_path" != "$(pwd)/.env" ]; then
                cp "$main_env_path" .env
                log_success "Copied .env file from main repository root"
                log_info "Using .env configuration from: $main_env_path"
                return
            fi
        fi
        
        # Fallback to current git root
        local root_env_path="${git_root}/.env"
        if [ -f "$root_env_path" ] && [ "$root_env_path" != "$(pwd)/.env" ]; then
            cp "$root_env_path" .env
            log_success "Copied .env file from repository root"
            log_info "Using .env configuration from: $root_env_path"
            return
        fi
    fi
    
    # Fall back to template if no root .env exists
    if [ -f .env.template ]; then
        cp .env.template .env
        log_success "Created .env file from template"
        log_warning "Please edit .env file with your actual configuration values"
    else
        log_error "No .env.template file found"
        log_error "Cannot create environment configuration"
        exit 1
    fi
}

# Verify setup
verify_setup() {
    log_step "Verifying setup..."
    
    local warnings=()
    local errors=()
    
    # Check if .env file exists and has required variables (warnings only)
    if [ -f .env ]; then
        # Check for critical environment variables (non-blocking)
        if ! is_env_var_set "SUPABASE_URL"; then
            warnings+=("SUPABASE_URL not configured in .env")
        fi
        if ! is_env_var_set "SUPABASE_SERVICE_ROLE_KEY"; then
            warnings+=("SUPABASE_SERVICE_ROLE_KEY not configured in .env")
        fi
    else
        errors+=(".env file not found")
    fi
    
    # Check if node_modules exists (blocking error)
    if [ ! -d node_modules ]; then
        errors+=("Node.js dependencies not installed")
    fi
    
    # Check if Python environment is set up (blocking error)
    if [ -d "olas-operate-middleware" ]; then
        if [ ! -d "olas-operate-middleware/venv" ] && ! command_exists poetry; then
            errors+=("Python environment not properly set up")
        fi
    fi
    
    # Report warnings (non-blocking)
    if [ ${#warnings[@]} -gt 0 ]; then
        log_warning "Setup warnings (please address for full functionality):"
        for warning in "${warnings[@]}"; do
            log_warning "  - $warning"
        done
    fi
    
    # Report errors (blocking)
    if [ ${#errors[@]} -gt 0 ]; then
        log_error "Setup verification failed:"
        for error in "${errors[@]}"; do
            log_error "  - $error"
        done
        return 1
    fi
    
    if [ ${#warnings[@]} -eq 0 ]; then
        log_success "Setup verification passed"
    else
        log_success "Setup completed with warnings (see above)"
    fi
    return 0
}

# Print setup completion message
print_completion_message() {
    echo ""
    log_success "Development environment setup completed!"
    echo ""
    log_info "Next steps:"
    log_info "  1. Edit .env file with your actual configuration values"
    log_info "  2. Run 'yarn test' to verify everything works"
    log_info "  3. Run 'yarn dev' to start the development server"
    echo ""
    log_info "For more information, see SETUP.md"
}

# Main setup function
main() {
    echo "🚀 Starting development environment setup for Git Worktrees"
    echo "========================================================="
    
    check_prerequisites
    init_submodules
    setup_python_environment
    install_node_dependencies
    setup_environment_files
    
    if verify_setup; then
        print_completion_message
    else
        log_error "Setup failed with critical errors. Please address the issues above."
        exit 1
    fi
}

# Parse command line arguments
PYTHON_ONLY=false
SKIP_VERIFICATION=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --python-only)
            PYTHON_ONLY=true
            shift
            ;;
        --skip-verification)
            SKIP_VERIFICATION=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --python-only      Only set up Python environment"
            echo "  --skip-verification Skip setup verification"
            echo "  -h, --help         Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Run setup based on options
if [ "$PYTHON_ONLY" = true ]; then
    log_info "Running Python-only setup"
    check_prerequisites
    init_submodules
    setup_python_environment
    log_success "Python environment setup completed"
else
    main
fi
