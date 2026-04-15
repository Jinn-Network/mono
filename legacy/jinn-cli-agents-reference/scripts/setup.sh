#!/bin/bash

# Setup script for Gemini CLI Jinn
# This script automates the initial setup process

set -e  # Exit on any error

echo "🚀 Setting up Gemini CLI Jinn repository..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_error "This script must be run from the root of the gemini_cli_jinn repository"
    exit 1
fi

# Step 1: Install dependencies
print_status "Installing dependencies..."
yarn install

# Step 2: Create environment file if it doesn't exist
if [ ! -f ".env" ]; then
    print_status "Creating .env file from template..."
    if [ -f "env.template" ]; then
        cp env.template .env
        print_success "Created .env file from template"
        print_warning "Please edit .env file with your actual configuration values"
    else
        print_error "env.template not found. Please create .env file manually"
    fi
else
    print_status ".env file already exists"
fi

# Step 3: Create Gemini settings if needed
if [ ! -f ".gemini/settings.json" ]; then
    print_status "Creating Gemini settings..."
    mkdir -p .gemini
    if [ -f "gemini-agent/settings.template.json" ]; then
        cp gemini-agent/settings.template.json .gemini/settings.json
        print_success "Created .gemini/settings.json from template"
    else
        print_warning "gemini-agent/settings.template.json not found. Please create .gemini/settings.json manually"
    fi
else
    print_status ".gemini/settings.json already exists"
fi

# Step 4: Build the project
print_status "Building the project..."
yarn build

# Step 5: Build the MCP package
print_status "Building MCP package..."
yarn workspace @jinn/metacog-mcp build

# Step 6: Set up git hooks
print_status "Setting up git hooks..."
if [ -f "codespec/scripts/setup-git-hooks.sh" ]; then
    ./codespec/scripts/setup-git-hooks.sh
    print_success "Installed pre-commit hook"
else
    print_warning "setup-git-hooks.sh not found. Git hooks not installed"
fi

# Step 7: Verify sensitive files are ignored
print_status "Verifying .gitignore configuration..."
if git check-ignore .env > /dev/null 2>&1; then
    print_success ".env file is properly ignored"
else
    print_error ".env file is NOT ignored by git!"
fi

if git check-ignore .gemini/settings.json > /dev/null 2>&1; then
    print_success ".gemini/settings.json is properly ignored"
else
    print_error ".gemini/settings.json is NOT ignored by git!"
fi

# Step 8: Create logs directory
print_status "Creating logs directory..."
mkdir -p logs

# Step 9: Final verification
print_status "Running final verification..."

# Check if required environment variables are documented
if [ -f ".env" ]; then
    if grep -q "SUPABASE_URL" .env && grep -q "SUPABASE_SERVICE_ROLE_KEY" .env; then
        if grep -q "your-project-ref" .env || grep -q "your-supabase-service-role-key" .env; then
            print_warning "Please update .env file with your actual Supabase credentials"
        else
            print_success "Environment variables appear to be configured"
        fi
    else
        print_error "Required environment variables are missing from .env file"
    fi
fi

# Check if build was successful
if [ -f "dist/worker.js" ]; then
    print_success "Main project built successfully"
else
    print_error "Main project build failed"
fi

if [ -f "packages/metacog-mcp/dist/server.js" ]; then
    print_success "MCP package built successfully"
else
    print_error "MCP package build failed"
fi

echo ""
print_success "Setup completed!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your Supabase credentials"
echo "2. Authenticate with Gemini CLI: gemini auth login"
echo "3. Set up your Supabase database and run migrations"
echo "4. Start development: yarn dev"
echo ""
echo "For detailed instructions, see SETUP.md" 