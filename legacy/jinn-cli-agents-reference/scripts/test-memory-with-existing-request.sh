#!/bin/bash

# Integration Test: Memory System with Existing Request
# 
# This script tests the memory system by replaying an existing on-chain request
# through the worker in single-shot mode.

echo "🧪 Memory System Integration Test (Existing Request)"
echo "====================================================="
echo ""

# Check if request ID was provided
if [ -z "$1" ]; then
    echo "❌ Error: No request ID provided"
    echo ""
    echo "Usage: $0 <request-id>"
    echo ""
    echo "Example:"
    echo "  $0 0x1234567890abcdef..."
    echo ""
    echo "To find a request ID:"
    echo "  1. Check Ponder GraphQL: http://localhost:42069"
    echo "  2. Query: { requests(limit: 10) { items { id delivered } } }"
    echo "  3. Pick a completed request ID"
    exit 1
fi

REQUEST_ID="$1"

echo "📋 Test Configuration:"
echo "  Request ID: $REQUEST_ID"
echo "  Worker Mode: Single-shot"
echo "  Memory System: Enabled (default)"
echo ""

# Check environment
echo "🔍 Checking environment..."
if [ ! -f ".env" ]; then
    echo "❌ .env file not found"
    echo "   Create from template: cp .env.template .env"
    exit 1
fi
echo "  ✅ .env file exists"

# Check if services are running
echo ""
echo "🔍 Checking services..."
if ! curl -s http://localhost:42069/graphql > /dev/null 2>&1; then
    echo "❌ Ponder not running on port 42069"
    echo "   Start with: yarn ponder"
    exit 1
fi
echo "  ✅ Ponder running"

if ! curl -s http://localhost:4001/graphql > /dev/null 2>&1; then
    echo "❌ Control API not running on port 4001"
    echo "   Start with: yarn control-api"
    exit 1
fi
echo "  ✅ Control API running"

echo ""
echo "🚀 Running worker with request: $REQUEST_ID"
echo "---------------------------------------------------"
echo ""

# Set up log file
LOG_FILE="/tmp/mech-test-$(date +%s).log"

# Run worker in single-shot mode with the specified request
cd /Users/gcd/Repositories/main/jinn-cli-agents
MECH_TARGET_REQUEST_ID="$REQUEST_ID" yarn dev --single > "$LOG_FILE" 2>&1

EXIT_CODE=$?

echo ""
echo "---------------------------------------------------"
echo "📊 Test Results"
echo "---------------------------------------------------"
echo ""

if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ Worker exited with error (code: $EXIT_CODE)"
    echo ""
    echo "Last 20 lines of log:"
    tail -20 "$LOG_FILE"
    exit 1
fi

echo "✅ Worker completed successfully"
echo ""

# Check for memory system activity
echo "🔍 Memory System Activity:"
echo ""

REFLECTION_COUNT=$(grep -c "Starting reflection step" "$LOG_FILE" 2>/dev/null || echo 0)
MEMORY_SEARCH_COUNT=$(grep -c "Searching for relevant memories" "$LOG_FILE" 2>/dev/null || echo 0)
MEMORY_INJECTED_COUNT=$(grep -c "Injected memories into context" "$LOG_FILE" 2>/dev/null || echo 0)

echo "  Reflection steps: $REFLECTION_COUNT"
echo "  Memory searches: $MEMORY_SEARCH_COUNT"
echo "  Memories injected: $MEMORY_INJECTED_COUNT"

echo ""

if [ $REFLECTION_COUNT -gt 0 ] || [ $MEMORY_SEARCH_COUNT -gt 0 ]; then
    echo "🎉 Memory system is ACTIVE!"
    
    if [ $REFLECTION_COUNT -gt 0 ]; then
        echo ""
        echo "📝 Reflection Evidence:"
        grep "Starting reflection step" "$LOG_FILE" || true
    fi
    
    if [ $MEMORY_SEARCH_COUNT -gt 0 ]; then
        echo ""
        echo "🔍 Memory Search Evidence:"
        grep "Searching for relevant memories" "$LOG_FILE" || true
        
        if [ $MEMORY_INJECTED_COUNT -gt 0 ]; then
            echo ""
            echo "💉 Memory Injection Evidence:"
            grep "Injected memories into context" "$LOG_FILE" || true
        fi
    fi
    
    echo ""
    echo "✅ INTEGRATION TEST PASSED"
else
    echo "⚠️  No memory system activity detected"
    echo ""
    echo "This could mean:"
    echo "  - Request was already completed (reflection only runs on new completions)"
    echo "  - No relevant memories exist yet for injection"
    echo "  - Memory system is disabled (check DISABLE_MEMORY_INJECTION)"
    
    echo ""
    echo "💡 To generate memory activity:"
    echo "  1. Submit a NEW on-chain request"
    echo "  2. Let worker complete it (generates reflection)"
    echo "  3. Submit ANOTHER similar request (triggers injection)"
fi

echo ""
echo "📖 Full log saved to: $LOG_FILE"
echo ""
echo "To search for memories created:"
echo "  yarn ts-node scripts/test-memory-search.ts"
echo ""

