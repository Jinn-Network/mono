#!/bin/bash

# QA Automation Script for JINN-179: Middleware Setup & Wallet Management Integration
# This script automates the validation of OLAS middleware setup and integration

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Test results tracking
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
WARNINGS=0

# Override log_warning to increment counter
log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
    WARNINGS=$((WARNINGS + 1))
}

log_test_start() {
    echo -e "\n${BLUE}🧪 Test: $1${NC}"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

log_test_pass() {
    log_success "PASS: $1"
    PASSED_TESTS=$((PASSED_TESTS + 1))
}

log_test_fail() {
    log_error "FAIL: $1"
    FAILED_TESTS=$((FAILED_TESTS + 1))
}

# command_exists is now provided by common.sh

# Test environment setup
test_environment_setup() {
    log_test_start "Environment Setup Validation"
    
    local issues=()
    
    # Use common validation function
    if ! validate_system_dependencies; then
        issues+=("System dependencies not installed")
    fi
    
    # Check project structure
    if [ ! -f package.json ]; then
        issues+=("package.json not found in project root")
    fi
    
    if [ ! -f .env.template ]; then
        issues+=(".env.template not found")
    fi
    
    if [ ${#issues[@]} -eq 0 ]; then
        log_test_pass "Environment setup is valid"
    else
        log_test_fail "Environment issues: ${issues[*]}"
        for issue in "${issues[@]}"; do
            log_error "  - $issue"
        done
    fi
}

# Test git submodule initialization
test_git_submodules() {
    log_test_start "Git Submodule Initialization"
    
    if [ ! -f .gitmodules ]; then
        log_warning "No .gitmodules file found - skipping submodule test"
        return
    fi
    
    # Check if olas-operate-middleware submodule is initialized
    if [ ! -d "olas-operate-middleware" ]; then
        log_test_fail "olas-operate-middleware directory not found"
        return
    fi
    
    # Check if submodule has content
    if [ ! -f "olas-operate-middleware/operate/cli.py" ] && [ ! -f "olas-operate-middleware/pyproject.toml" ]; then
        log_test_fail "olas-operate-middleware submodule appears empty - needs initialization"
        log_info "Run: git submodule update --init --recursive"
        return
    fi
    
    log_test_pass "Git submodules are properly initialized"
}

# Test Python environment and dependencies
test_python_environment() {
    log_test_start "Python Environment Validation"
    
    local python_issues=()
    
    # Check if middleware directory exists
    if [ ! -d "olas-operate-middleware" ]; then
        log_test_fail "olas-operate-middleware directory not found"
        return
    fi
    
    cd olas-operate-middleware
    
    # Check for Poetry setup
    if command_exists poetry && [ -f pyproject.toml ]; then
        log_info "Checking Poetry environment..."
        
        if poetry env info >/dev/null 2>&1; then
            log_info "Poetry virtual environment exists"
            
            # Try to check if dependencies are installed
            if poetry run python -c "import autonomy, aea" >/dev/null 2>&1; then
                log_info "Core AEA/Autonomy dependencies are installed"
            else
                python_issues+=("Core AEA/Autonomy dependencies not installed via Poetry")
            fi
        else
            python_issues+=("Poetry virtual environment not set up")
        fi
    else
        log_info "Poetry not found or no pyproject.toml, checking venv fallback..."
        
        # Check for venv setup
        if [ -d venv ]; then
            log_info "Python venv directory exists"
            
            # Try to activate and test dependencies
            if source venv/bin/activate && python -c "import autonomy, aea" >/dev/null 2>&1; then
                log_info "Core AEA/Autonomy dependencies are installed in venv"
            else
                python_issues+=("Core AEA/Autonomy dependencies not installed in venv")
            fi
        else
            python_issues+=("No Poetry or venv Python environment found")
        fi
    fi
    
    cd ..
    
    if [ ${#python_issues[@]} -eq 0 ]; then
        log_test_pass "Python environment is properly configured"
    else
        log_test_fail "Python environment issues found"
        for issue in "${python_issues[@]}"; do
            log_error "  - $issue"
        done
        log_info "Run: yarn setup:python to fix Python environment"
    fi
}

# Test Node.js dependencies
test_node_dependencies() {
    log_test_start "Node.js Dependencies Validation"
    
    if [ ! -d node_modules ]; then
        log_test_fail "node_modules directory not found - run 'yarn install'"
        return
    fi
    
    # Check if key dependencies are installed
    local missing_deps=()
    
    if [ ! -d "node_modules/@modelcontextprotocol" ]; then
        missing_deps+=("@modelcontextprotocol/sdk")
    fi
    
    if [ ! -d "node_modules/ethers" ]; then
        missing_deps+=("ethers")
    fi
    
    if [ ! -d "node_modules/dotenv" ]; then
        missing_deps+=("dotenv")
    fi
    
    if [ ${#missing_deps[@]} -eq 0 ]; then
        log_test_pass "Node.js dependencies are installed"
    else
        log_test_fail "Missing Node.js dependencies: ${missing_deps[*]}"
        log_info "Run: yarn install"
    fi
}

# Test environment configuration
test_environment_configuration() {
    log_test_start "Environment Configuration Validation"
    
    if [ ! -f .env ]; then
        log_test_fail ".env file not found - copy from .env.template"
        return
    fi
    
    # Check for critical environment variables
    local missing_vars=()
    
    if ! is_env_var_set "SUPABASE_URL"; then
        missing_vars+=("SUPABASE_URL")
    fi
    
    if ! is_env_var_set "SUPABASE_SERVICE_ROLE_KEY"; then
        missing_vars+=("SUPABASE_SERVICE_ROLE_KEY")
    fi
    
    # Check for Tenderly configuration (optional but recommended for E2E tests)
    local tenderly_configured=true
    if ! is_env_var_set "TENDERLY_ACCESS_KEY"; then
        tenderly_configured=false
    fi
    
    if [ ${#missing_vars[@]} -eq 0 ]; then
        log_test_pass "Critical environment variables are configured"
        
        if [ "$tenderly_configured" = false ]; then
            log_warning "Tenderly configuration missing - E2E tests may not work"
            log_info "Configure TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG for full E2E testing"
        fi
    else
        log_test_fail "Missing environment variables: ${missing_vars[*]}"
        log_info "Edit .env file with your actual configuration values"
    fi
}

# Test OLAS Operate Wrapper functionality
test_olas_operate_wrapper() {
    log_test_start "OLAS Operate Wrapper Functionality"
    
    if [ ! -f "worker/OlasOperateWrapper.ts" ]; then
        log_test_fail "OlasOperateWrapper.ts not found"
        return
    fi
    
    # Try to run the wrapper validation test
    log_info "Running OlasOperateWrapper integration test..."
    
    if yarn test worker/OlasOperateWrapper.test.ts >/dev/null 2>&1; then
        log_test_pass "OlasOperateWrapper tests pass"
    else
        log_test_fail "OlasOperateWrapper tests fail"
        log_info "Run: yarn test worker/OlasOperateWrapper.test.ts for details"
    fi
}

# Test E2E service staking capability
test_e2e_service_staking() {
    log_test_start "E2E Service Staking Test Capability"
    
    if [ ! -f "scripts/e2e-service-stake-test.ts" ]; then
        log_test_fail "E2E service staking test script not found"
        return
    fi
    
    # Check if Tenderly is configured for E2E testing
    if [ -f .env ]; then
        if is_env_var_set "TENDERLY_ACCESS_KEY"; then
            log_info "Tenderly configuration detected - E2E tests should work"
            log_test_pass "E2E testing capability is configured"
        else
            log_warning "Tenderly not configured - E2E tests will not work"
            log_info "Configure Tenderly environment variables for E2E testing"
        fi
    else
        log_test_fail "No .env file found for E2E test configuration"
    fi
}

# Test package.json scripts
test_package_scripts() {
    log_test_start "Package.json Scripts Validation"
    
    local missing_scripts=()
    
    if ! grep -q '"setup:dev"' package.json; then
        missing_scripts+=("setup:dev")
    fi
    
    if ! grep -q '"setup:python"' package.json; then
        missing_scripts+=("setup:python")
    fi
    
    if ! grep -q '"qa:jinn-179"' package.json; then
        missing_scripts+=("qa:jinn-179")
    fi
    
    if [ ${#missing_scripts[@]} -eq 0 ]; then
        log_test_pass "Required package.json scripts are present"
    else
        log_test_fail "Missing package.json scripts: ${missing_scripts[*]}"
    fi
}

# Test wallet manager removal (JINN-179 requirement)
test_wallet_manager_removal() {
    log_test_start "Wallet Manager Package Removal"
    
    if [ -d "packages/wallet-manager" ]; then
        log_test_fail "packages/wallet-manager directory still exists - should be removed per JINN-179"
        return
    fi
    
    # Check for any remaining imports
    if grep -r "packages/wallet-manager" . --exclude-dir=node_modules --exclude-dir=.git >/dev/null 2>&1; then
        log_test_fail "Found references to packages/wallet-manager in codebase"
        log_info "Search and remove all references: grep -r 'packages/wallet-manager' ."
        return
    fi
    
    log_test_pass "packages/wallet-manager successfully removed"
}

# Print test summary
print_test_summary() {
    echo ""
    log_info "QA Test Summary for JINN-179"
    echo "================================"
    echo -e "${BLUE}Total Tests: $TOTAL_TESTS${NC}"
    echo -e "${GREEN}Passed: $PASSED_TESTS${NC}"
    echo -e "${RED}Failed: $FAILED_TESTS${NC}"
    echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
    
    local success_rate=0
    if [ $TOTAL_TESTS -gt 0 ]; then
        success_rate=$((PASSED_TESTS * 100 / TOTAL_TESTS))
    fi
    
    echo -e "${BLUE}Success Rate: ${success_rate}%${NC}"
    
    if [ $FAILED_TESTS -eq 0 ]; then
        echo ""
        log_success "🎉 All QA tests passed! JINN-179 implementation is ready."
        
        if [ $WARNINGS -gt 0 ]; then
            log_warning "Note: $WARNINGS warnings were found. Consider addressing them for optimal setup."
        fi
        
        echo ""
        log_info "Next steps:"
        log_info "  1. Run E2E tests: yarn test:e2e"
        log_info "  2. Start development: yarn dev"
        log_info "  3. Test OLAS service staking: yarn test:onchain:e2e"
        
        return 0
    else
        echo ""
        log_error "❌ $FAILED_TESTS test(s) failed. Please address the issues above."
        
        echo ""
        log_info "Common fixes:"
        log_info "  - Run setup: yarn setup:dev"
        log_info "  - Install Python deps: yarn setup:python"
        log_info "  - Configure .env file with your values"
        log_info "  - Initialize submodules: git submodule update --init --recursive"
        
        return 1
    fi
}

# Main execution
main() {
    echo "🚀 Starting QA Automation for JINN-179"
    echo "======================================="
    echo "Validating Middleware Setup & Wallet Management Integration"
    echo ""
    
    test_environment_setup
    test_git_submodules
    test_python_environment
    test_node_dependencies
    test_environment_configuration
    test_olas_operate_wrapper
    test_e2e_service_staking
    test_package_scripts
    test_wallet_manager_removal
    
    print_test_summary
}

# Parse command line arguments
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "QA Automation Script for JINN-179: Middleware Setup & Wallet Management Integration"
            echo ""
            echo "Options:"
            echo "  -v, --verbose      Enable verbose output"
            echo "  -h, --help         Show this help message"
            echo ""
            echo "This script validates:"
            echo "  - Environment setup and dependencies"
            echo "  - Git submodule initialization"
            echo "  - Python environment configuration"
            echo "  - OLAS Operate Wrapper functionality"
            echo "  - E2E testing capability"
            echo "  - Wallet manager package removal"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Run main function
main
