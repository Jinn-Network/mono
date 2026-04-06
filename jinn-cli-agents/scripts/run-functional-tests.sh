#!/bin/bash

# Memory System Functional Test Suite
# Runs all tests in sequence as per the test plan

echo "🧪 Memory System Functional Test Suite"
echo "======================================="
echo ""

cd /Users/gcd/Repositories/main/jinn-cli-agents

# Test 1: Memory Search
echo "📝 Test 1: Memory Search (verifying search functionality)"
echo "-----------------------------------------------------------"
npx tsx scripts/test-memory-search.ts
TEST1_EXIT=$?
echo ""
echo "Test 1 Exit Code: $TEST1_EXIT"
echo ""
sleep 2

# Test 2: Memory Rating
echo "⭐ Test 2: Memory Rating (verifying rating via Control API)"
echo "-----------------------------------------------------------"
npx tsx scripts/test-memory-rating.ts
TEST2_EXIT=$?
echo ""
echo "Test 2 Exit Code: $TEST2_EXIT"
echo ""
sleep 2

# Test 3: Memory Creation
echo "💾 Test 3: Memory Creation (verifying reflection step)"
echo "-----------------------------------------------------------"
npx tsx scripts/test-memory-creation.ts
TEST3_EXIT=$?
echo ""
echo "Test 3 Exit Code: $TEST3_EXIT"
echo ""
sleep 2

# Test 4: Memory Injection
echo "💉 Test 4: Memory Injection (verifying context injection)"
echo "-----------------------------------------------------------"
npx tsx scripts/test-memory-injection.ts
TEST4_EXIT=$?
echo ""
echo "Test 4 Exit Code: $TEST4_EXIT"
echo ""
sleep 2

# Test 5: Negative Case
echo "❌ Test 5: Negative Case (no reflection on failure)"
echo "-----------------------------------------------------------"
npx tsx scripts/test-negative-case.ts
TEST5_EXIT=$?
echo ""
echo "Test 5 Exit Code: $TEST5_EXIT"
echo ""

# Summary
echo ""
echo "========================================="
echo "📊 Test Summary"
echo "========================================="
echo "Test 1 (Search):    $([ $TEST1_EXIT -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo "Test 2 (Rating):    $([ $TEST2_EXIT -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo "Test 3 (Creation):  $([ $TEST3_EXIT -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo "Test 4 (Injection): $([ $TEST4_EXIT -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo "Test 5 (Negative):  $([ $TEST5_EXIT -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo ""

# Calculate overall result
TOTAL_FAILURES=$((TEST1_EXIT + TEST2_EXIT + TEST3_EXIT + TEST4_EXIT + TEST5_EXIT))

if [ $TOTAL_FAILURES -eq 0 ]; then
    echo "🎉 All tests passed!"
    exit 0
else
    echo "⚠️  $TOTAL_FAILURES test(s) failed"
    exit 1
fi

