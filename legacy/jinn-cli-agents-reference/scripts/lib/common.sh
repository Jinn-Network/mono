#!/bin/bash

# Common utilities for setup and QA scripts
# Shared functions to reduce duplication across shell scripts

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_step() {
    echo -e "\n${BLUE}🔧 $1${NC}"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Validate required dependencies
validate_system_dependencies() {
    local missing_deps=()
    
    if ! command_exists node; then
        missing_deps+=("node")
    fi
    
    if ! command_exists yarn; then
        missing_deps+=("yarn")
    fi
    
    if ! command_exists python3; then
        missing_deps+=("python3")
    fi
    
    if ! command_exists git; then
        missing_deps+=("git")
    fi
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        log_error "Missing required dependencies: ${missing_deps[*]}"
        return 1
    fi
    
    return 0
}

# Check if environment variable is set and non-empty
is_env_var_set() {
    local var_name="$1"
    local file_path="${2:-.env}"

    if [ ! -f "$file_path" ]; then
        return 1
    fi

    if ! grep -q "${var_name}=" "$file_path"; then
        return 1
    fi

    local value=$(grep "${var_name}=" "$file_path" | cut -d= -f2)
    [ -n "$value" ]
}

# Validate repository path exists and has .git directory
validate_repo_path() {
    local repo_path="$1"

    # Expand tilde
    repo_path="${repo_path/#\~/$HOME}"

    if [ ! -d "$repo_path" ]; then
        log_error "Repository not found: $repo_path"
        return 1
    fi

    if [ ! -d "$repo_path/.git" ]; then
        log_error "Not a git repository: $repo_path"
        return 1
    fi

    return 0
}

# Load environment file (.env or .env.test)
load_env_file() {
    local env_file="${1:-.env}"

    if [ ! -f "$env_file" ]; then
        log_error "Environment file not found: $env_file"
        return 1
    fi

    log_info "Loading environment from $env_file"
    set -a  # automatically export all variables
    source "$env_file"
    set +a

    return 0
}

# Export CODE_METADATA_REPO_ROOT environment variable
export_repo_root() {
    local repo_path="$1"

    # Expand tilde
    repo_path="${repo_path/#\~/$HOME}"

    export CODE_METADATA_REPO_ROOT="$repo_path"
    log_info "CODE_METADATA_REPO_ROOT set to: $CODE_METADATA_REPO_ROOT"
}
