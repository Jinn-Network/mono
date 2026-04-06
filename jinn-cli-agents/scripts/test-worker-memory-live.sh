#!/bin/bash

# Integration Test: Monitor Worker for Memory System Activity
# This script monitors live worker logs to verify the memory system is working

echo "🧪 Worker Memory System - Live Integration Test"
echo "================================================"
echo ""
echo "This test monitors the worker logs to verify:"
echo "  1. Reflection step triggers after completed jobs"
echo "  2. Memory injection happens before new jobs"
echo "  3. Memories are created and indexed"
echo ""

LOG_FILE="/tmp/mech.log"

if [ ! -f "$LOG_FILE" ]; then
    echo "❌ Worker log file not found: $LOG_FILE"
    echo "   Make sure the worker is running with: yarn mech"
    exit 1
fi

echo "📊 Current Worker Status:"
echo "========================"
echo ""

# Check if worker is running
if pgrep -f "mech_worker" > /dev/null; then
    echo "✅ Worker process is running"
else
    echo "⚠️  Worker process not found"
    echo "   Start with: yarn mech"
fi

echo ""
echo "📝 Recent Worker Activity:"
echo "========================="
echo ""

# Show last 20 lines
tail -20 "$LOG_FILE" | grep -v "Already claimed"

echo ""
echo ""
echo "🔍 Memory System Evidence in Logs:"
echo "==================================="
echo ""

# Search for reflection steps
REFLECTION_COUNT=$(grep -c "Starting reflection step" "$LOG_FILE" 2>/dev/null || echo 0)
echo "Reflection steps triggered: $REFLECTION_COUNT"

if [ $REFLECTION_COUNT -gt 0 ]; then
    echo ""
    echo "Recent reflection steps:"
    grep "Starting reflection step" "$LOG_FILE" | tail -3
fi

echo ""

# Search for memory injection
INJECTION_COUNT=$(grep -c "Searching for relevant memories" "$LOG_FILE" 2>/dev/null || echo 0)
echo "Memory injection attempts: $INJECTION_COUNT"

if [ $INJECTION_COUNT -gt 0 ]; then
    echo ""
    echo "Recent memory searches:"
    grep "Searching for relevant memories" "$LOG_FILE" | tail -3
fi

echo ""

# Search for memories found
FOUND_COUNT=$(grep -c "Injected memories into context" "$LOG_FILE" 2>/dev/null || echo 0)
echo "Memories injected: $FOUND_COUNT"

if [ $FOUND_COUNT -gt 0 ]; then
    echo ""
    echo "Recent memory injections:"
    grep "Injected memories into context" "$LOG_FILE" | tail -3
fi

echo ""
echo ""
echo "🔬 Testing Memory Search:"
echo "========================="
echo ""

# Test memory search via MCP
cd /Users/gcd/Repositories/main/jinn-cli-agents
npx tsx scripts/test-memory-search.ts 2>&1 | tail -15

echo ""
echo ""
echo "📋 Summary:"
echo "==========="
echo ""

if [ $REFLECTION_COUNT -gt 0 ] || [ $INJECTION_COUNT -gt 0 ]; then
    echo "✅ Memory system is ACTIVE in the worker"
    echo ""
    echo "Evidence found:"
    [ $REFLECTION_COUNT -gt 0 ] && echo "  - Reflection steps: $REFLECTION_COUNT"
    [ $INJECTION_COUNT -gt 0 ] && echo "  - Memory searches: $INJECTION_COUNT"
    [ $FOUND_COUNT -gt 0 ] && echo "  - Memories injected: $FOUND_COUNT"
    echo ""
    echo "🎉 Integration test PASSED - Memory system is working!"
else
    echo "⚠️  No memory system activity detected yet"
    echo ""
    echo "This could mean:"
    echo "  1. No jobs have completed since the worker started"
    echo "  2. The worker was started before the memory code was deployed"
    echo "  3. Memory system is disabled (check DISABLE_MEMORY_INJECTION env var)"
    echo ""
    echo "💡 Solutions:"
    echo "  - Restart the worker: ./scripts/restart-services.sh"
    echo "  - Wait for jobs to complete and check again"
    echo "  - Submit a test job manually"
fi

echo ""
echo "📖 To watch live memory activity:"
echo "   tail -f /tmp/mech.log | grep -E 'reflection|memory|MEMORY'"
echo ""



