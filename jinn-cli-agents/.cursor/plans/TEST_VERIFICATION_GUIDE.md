# Test Verification Guide for Backend Test Suite

**Audience:** Agent verifying the backend test implementation  
**Context:** 8 new/updated test files covering critical worker logic, status inference, RPC filtering, and Control API reliability  
**Goal:** Verify all tests pass, understand what's being tested, and confirm fixes address documented bugs

---

## Prerequisites

Before verifying, ensure you understand:

1. **The Three Critical Bugs Being Fixed:**
   - **Stale Hierarchy Bug:** Jobs cycle WAITING indefinitely (hierarchy snapshots stale)
   - **Double Execution:** Worker claims same job twice (Ponder lags behind chain)
   - **Stale Claim Blocking:** Jobs stuck IN_PROGRESS for hours (no age check)

2. **Project Context:**
   - Worker polls Ponder for undelivered requests
   - Worker claims requests via Control API (Supabase gateway)
   - Agent executes job with MCP tools
   - Worker delivers result to blockchain
   - Ponder indexes delivery events

3. **Test Framework:**
   - Unit tests: Vitest with mocked dependencies
   - Integration tests: Real Ponder + Control API + Supabase (with Tenderly VNet for blockchain)
   - Location: `tests-next/` directory (new test structure)

---

## Verification Steps

### Step 1: Environment Check

```bash
cd /Users/gcd/Repositories/main/jinn-cli-agents

# Verify Node.js and Yarn installed
node --version  # Should be v18+
yarn --version  # Should be 1.22+

# Install dependencies (if not already)
yarn install

# Check test commands available
yarn test:unit:next --help
yarn test:integration:next --help
```

**Expected:** Commands exist, no errors.

---

### Step 2: Run Phase 1 (P0) - Critical Tests

These are the highest priority. Must pass for deployment.

#### 2.1: Test `getAllChildrenForJobDefinition`

```bash
yarn test:unit:next -- tests-next/unit/worker/status/getAllChildrenForJobDefinition.test.ts
```

**What You're Verifying:**
- ✅ Aggregates children from multiple job runs correctly
- ✅ Deduplicates same child appearing across runs
- ✅ Detects "active children" (delivered but DELEGATING/WAITING)
- ✅ Handles query failures gracefully
- ✅ Logs comparison data for debugging

**Expected Output:**
```
PASS  tests-next/unit/worker/status/getAllChildrenForJobDefinition.test.ts
  ✓ basic functionality (X tests)
  ✓ deduplication (X tests)
  ✓ active children detection (X tests)
  ✓ error handling (X tests)
  ✓ logging (X tests)
  ✓ queryRequestsByJobDefinition (X tests)

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ Any test failures in "deduplication" suite → First occurrence logic broken
- ❌ Failures in "active children detection" → DELEGATING/WAITING detection broken
- ❌ Failures in "error handling" → Missing graceful fallback

**Key Test to Spot Check:**
```typescript
// Test: "detects delivered children with non-terminal status"
// This is THE critical test for the WAITING cycle fix
// Validates that children delivered with DELEGATING status count as "active"
```

---

#### 2.2: Test Updated `inferStatus`

```bash
yarn test:unit:next -- tests-next/unit/worker/status/inferStatus.test.ts
```

**What You're Verifying:**
- ✅ Existing tests still pass (no regressions)
- ✅ New suite: "job-level child status" passes
- ✅ Live query takes precedence over hierarchy
- ✅ Falls back to hierarchy when live query fails

**Expected Output:**
```
PASS  tests-next/unit/worker/status/inferStatus.test.ts
  ✓ FAILED status (X tests)
  ✓ DELEGATING status (X tests)
  ✓ WAITING status (X tests)
  ✓ COMPLETED status (X tests)
  ✓ status precedence (X tests)
  ✓ job-level child status (hierarchy with getAllChildrenForJobDefinition) (X tests) <- NEW

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ New suite doesn't exist → Update not applied correctly
- ❌ Tests in new suite fail → Mock setup for `getAllChildrenForJobDefinition` broken
- ❌ Old tests fail → Breaking change introduced

**Key Test to Spot Check:**
```typescript
// Test: "infers WAITING when children delivered but have DELEGATING status"
// This validates the activeChildren detection logic
// Should call getAllChildrenForJobDefinition and use activeChildren count
```

---

#### 2.3: Test RPC Filtering (`mech_worker`)

```bash
yarn test:unit:next -- tests-next/unit/worker/mech_worker.test.ts
```

**What You're Verifying:**
- ✅ Fail-safe behavior when RPC returns null
- ✅ Trusts empty on-chain set (filters ALL requests)
- ✅ Filters only matching requests when partial set
- ✅ Handles hex ID normalization

**Expected Output:**
```
PASS  tests-next/unit/worker/mech_worker.test.ts
  ✓ Worker RPC Filtering (Double-Execution Guard) (X tests)
    ✓ getUndeliveredSet (X tests)
    ✓ filterUnclaimed - Integration Tests (X tests)
    ✓ edge cases (X tests)
    ✓ logging verification (X tests)

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ Tests in "filterUnclaimed" fail → Critical double-execution guard broken
- ⚠️ Many tests are placeholders (expect(true).toBe(true)) → This is expected, testing internal functions

**Key Concept to Understand:**
```typescript
// When RPC returns null (failure) → Trust Ponder (safe fallback)
// When RPC returns empty Set (success) → Trust chain (prevents double-exec)
// When RPC returns partial Set → Filter only matching
```

---

#### 2.4: Test Stale Job Reclaiming (Integration)

```bash
yarn test:integration:next -- tests-next/integration/control-api/validation-gateway.integration.test.ts
```

**⚠️ WARNING:** This test takes 60-240 seconds and requires:
- Tenderly VNet (mocked blockchain)
- Control API server
- Ponder indexer
- Supabase connection

**What You're Verifying:**
- ✅ Test 5: Control API allows re-claiming stale jobs (>5 minutes)
- ✅ Test 6: Control API blocks re-claiming fresh jobs (<5 minutes)
- ✅ Existing tests 1-4 still pass

**Expected Output:**
```
PASS  tests-next/integration/control-api/validation-gateway.integration.test.ts
  ✓ blocks claim when requestId not found in Ponder (XX ms)
  ✓ allows claim when requestId exists in Ponder (XX ms)
  ✓ handles idempotent claims (same request claimed twice) (XX ms)
  ✓ injects lineage fields (request_id, worker_address) (XX ms)
  ✓ allows re-claiming stale jobs (IN_PROGRESS >5 minutes) (XX ms) <- NEW
  ✓ blocks re-claiming fresh jobs (IN_PROGRESS <5 minutes) (XX ms) <- NEW

Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
```

**Red Flags:**
- ❌ Test 5 fails → Stale detection not working (check 5-minute threshold)
- ❌ Test 6 fails → Fresh job protection broken (check age calculation)
- ⚠️ Tests timeout → Network/service issue (check Tenderly, Ponder, Control API logs)

**Key Test to Spot Check (Test 5):**
```typescript
// 1. Manually insert claim with claimed_at = 5.5 minutes ago
// 2. Attempt claim with NEW worker
// 3. Assert: Claim succeeds, worker reassigned, fresh timestamp
```

---

### Step 3: Run Phase 2 (P1) - Reliability Tests

#### 3.1: Test Stale Claim Logic (Pure Function)

```bash
yarn test:unit:next -- tests-next/unit/control-api/staleClaimLogic.test.ts
```

**What You're Verifying:**
- ✅ Exactly 5 minutes (300,000ms) threshold
- ✅ COMPLETED jobs never stale
- ✅ IN_PROGRESS jobs stale after 5 minutes
- ✅ Boundary conditions (4:59 vs 5:01)

**Expected Output:**
```
PASS  tests-next/unit/control-api/staleClaimLogic.test.ts
  ✓ basic staleness detection (X tests)
  ✓ status-based staleness (X tests)
  ✓ edge cases (X tests)
  ✓ boundary testing (4:59 vs 5:01) (X tests)
  ✓ status variations (X tests)
  ✓ timestamp format handling (X tests)
  ✓ threshold configuration (X tests)
  ✓ clock skew scenarios (X tests)
  ✓ integration with Control API behavior (X tests)

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ "boundary testing" failures → Off-by-one error in threshold
- ❌ "threshold configuration" failures → Wrong threshold (not 300,000ms)
- ❌ "status-based staleness" failures → COMPLETED jobs being marked stale

**Key Tests to Spot Check:**
```typescript
// Test: "considers exactly 5:00 as fresh"
// Test: "considers 5:00.001 as stale"
// These validate the exact boundary behavior
```

---

#### 3.2: Test Control API Client

```bash
yarn test:unit:next -- tests-next/unit/worker/control_api_client.test.ts
```

**What You're Verifying:**
- ✅ Sets correct headers (X-Worker-Address, Idempotency-Key)
- ✅ Detects "already claimed" errors gracefully
- ✅ Retries 3 times with exponential backoff
- ✅ Uses 10-second timeout

**Expected Output:**
```
PASS  tests-next/unit/worker/control_api_client.test.ts
  ✓ Control API Client (X tests)
    ✓ claimRequest (X tests)
    ✓ error message parsing (X tests)
    ✓ request construction (X tests)
    ✓ timeout configuration (X tests)

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ "retries on network failure" fails → Retry logic broken
- ❌ "uses exponential backoff" fails → Backoff calculation wrong
- ❌ "handles 'already claimed' error" fails → Detection regex broken

**Key Test to Spot Check:**
```typescript
// Test: "retries up to 3 attempts"
// Should see 4 calls total (initial + 3 retries)
expect(postJson).toHaveBeenCalledTimes(4);
```

---

### Step 4: Run Phase 3 (P2) - Extended Tests

#### 4.1: Test Dependencies

```bash
yarn test:unit:next -- tests-next/unit/worker/dependencies.test.ts
```

**What You're Verifying:**
- ✅ UUID identifiers returned as-is (no query)
- ✅ Job names resolved via Ponder (workstream context)
- ✅ Job complete = at least one delivered request
- ✅ All dependencies checked in parallel

**Expected Output:**
```
PASS  tests-next/unit/worker/dependencies.test.ts
  ✓ Dependency Resolution (X tests)
    ✓ resolveJobDefinitionId (X tests)
    ✓ isJobDefinitionComplete (X tests)
    ✓ checkDependenciesMet (X tests)
    ✓ filterByDependencies integration (X tests)

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ "returns UUID identifiers as-is" fails → UUID regex broken
- ❌ "returns false if any dependency incomplete" fails → Logic inverted
- ❌ "checks multiple dependencies in parallel" fails → Not using Promise.all

---

#### 4.2: Test Query Requests by Job Definition

```bash
yarn test:unit:next -- tests-next/unit/worker/status/queryRequestsByJobDefinition.test.ts
```

**What You're Verifying:**
- ✅ Returns all requests ordered by blockTimestamp
- ✅ Limits to 100 requests
- ✅ Retries 3 times on failure
- ✅ Returns empty array on error (no throw)

**Expected Output:**
```
PASS  tests-next/unit/worker/status/queryRequestsByJobDefinition.test.ts
  ✓ queryRequestsByJobDefinition (X tests)
    ✓ successful queries (X tests)
    ✓ retry logic (X tests)
    ✓ edge cases (X tests)
    ✓ result ordering (X tests)
    ✓ pagination limits (X tests)
    ✓ GraphQL query structure (X tests)
    ✓ context tracking (X tests)

Test Suites: 1 passed, 1 total
Tests:       XX passed, XX total
```

**Red Flags:**
- ❌ "orders results by blockTimestamp ascending" fails → Wrong sort order
- ❌ "returns empty array after max retries" fails → Throwing instead of returning []
- ❌ "respects 100 request limit" fails → Query doesn't include limit

---

### Step 5: Run Full Suite

```bash
# Run all new/updated tests together
yarn test:unit:next -- tests-next/unit/worker/status/getAllChildrenForJobDefinition.test.ts tests-next/unit/worker/status/inferStatus.test.ts tests-next/unit/worker/mech_worker.test.ts tests-next/unit/control-api/staleClaimLogic.test.ts tests-next/unit/worker/control_api_client.test.ts tests-next/unit/worker/dependencies.test.ts tests-next/unit/worker/status/queryRequestsByJobDefinition.test.ts

# Run full test suite (all tests in tests-next/)
yarn test:next
```

**Expected Summary:**
```
Test Suites: X passed, X total
Tests:       X passed, X total
Snapshots:   0 total
Time:        Xs
```

**Success Criteria:**
- ✅ All test suites pass
- ✅ No skipped tests (unless intentional)
- ✅ No test timeouts
- ✅ Time < 60s for unit tests, < 300s for integration tests

---

### Step 6: Coverage Check (Optional)

```bash
yarn test:coverage
```

**What to Look For:**
- `worker/status/childJobs.ts` - Coverage should increase (especially `getAllChildrenForJobDefinition`)
- `worker/status/inferStatus.ts` - Coverage should increase (new job-level logic)
- `worker/mech_worker.ts` - Coverage for `filterUnclaimed` improved
- `control-api/server.ts` - Coverage for `claimRequest` stale detection

**Target:** >80% coverage for tested modules

---

## Understanding the Tests

### Critical Test Concepts

#### 1. Mock-Heavy Unit Tests

Most unit tests heavily mock dependencies:
```typescript
vi.mock('../../../../http/client.js', () => ({
  graphQLRequest: vi.fn()
}));
```

**Why:** Isolates function logic, makes tests fast and deterministic.

**Implication:** Tests verify behavior given mocked inputs, not actual integration.

#### 2. Fake Timers for Retry Logic

Tests use `vi.useFakeTimers()` to control time:
```typescript
vi.useFakeTimers();
const promise = someFunction();
await vi.advanceTimersByTimeAsync(500); // Fast-forward 500ms
await promise;
vi.useRealTimers();
```

**Why:** Tests retry logic without actually waiting seconds.

**Implication:** If tests flake, check timer advancement logic.

#### 3. Integration Tests Use Real Services

`validation-gateway.integration.test.ts` is TRUE integration:
- Real Tenderly VNet (mocked blockchain)
- Real Ponder indexer
- Real Control API server
- Real Supabase database

**Why:** Validates full request flow end-to-end.

**Implication:** Tests are slower, require services running, may flake on network issues.

---

## Common Issues and Solutions

### Issue 1: Tests Fail with "Cannot find module"

**Symptom:**
```
Error: Cannot find module '../../../../worker/status/childJobs.js'
```

**Solution:**
```bash
# Rebuild TypeScript
yarn build

# Or run tests with ts-node
yarn test:unit:next
```

---

### Issue 2: Integration Tests Timeout

**Symptom:**
```
Timeout - Async callback was not invoked within the 60000 ms timeout
```

**Solution:**
```bash
# Check services are running
# Ponder should be at http://localhost:42069/graphql
# Control API should be at http://localhost:4001/graphql

# Increase timeout if needed (in test file):
it('test name', async () => { ... }, 240000); // 240s
```

---

### Issue 3: Fake Timer Tests Hang

**Symptom:**
Test never completes, process hangs.

**Solution:**
Check for missing `await vi.runAllTimersAsync()` or `vi.useRealTimers()`.

---

### Issue 4: "Already claimed" Detection Fails

**Symptom:**
```
Expected: { alreadyClaimed: true }
Received: { alreadyClaimed: false }
```

**Solution:**
Check error message contains "already claimed" (case-insensitive).
Update regex in `control_api_client.ts` if needed:
```typescript
if (msg.toLowerCase().includes('already claimed')) { ... }
```

---

## Validation Checklist

Use this checklist to confirm verification:

### Phase 1 (P0) - MUST PASS
- [ ] `getAllChildrenForJobDefinition.test.ts` - All tests pass
- [ ] `inferStatus.test.ts` - New suite exists and passes
- [ ] `mech_worker.test.ts` - All tests pass (placeholders acceptable)
- [ ] `validation-gateway.integration.test.ts` - Test 5 & 6 pass

### Phase 2 (P1) - SHOULD PASS
- [ ] `staleClaimLogic.test.ts` - All boundary tests pass
- [ ] `control_api_client.test.ts` - Retry logic tests pass

### Phase 3 (P2) - SHOULD PASS
- [ ] `dependencies.test.ts` - All tests pass
- [ ] `queryRequestsByJobDefinition.test.ts` - All tests pass

### Overall
- [ ] Full suite runs without errors: `yarn test:next`
- [ ] No linter errors: No output from linter
- [ ] Coverage increases for tested modules (optional)

---

## What to Report Back

After verification, report:

1. **Test Results:**
   - Which phases passed/failed
   - Any specific test failures with error messages
   - Total test count and pass rate

2. **Issues Found:**
   - Bugs in test logic
   - Missing test coverage
   - Integration test flakiness

3. **Recommendations:**
   - Additional tests needed
   - Refactoring suggestions
   - Documentation improvements

4. **Sign-Off:**
   - [ ] All P0 tests pass (required for deployment)
   - [ ] All P1 tests pass (strongly recommended)
   - [ ] All P2 tests pass (nice to have)
   - [ ] Implementation matches specification
   - [ ] Ready for merge

---

## Quick Reference

### Test File Locations
```
tests-next/
├── unit/
│   ├── control-api/
│   │   └── staleClaimLogic.test.ts (NEW)
│   └── worker/
│       ├── control_api_client.test.ts (NEW)
│       ├── dependencies.test.ts (NEW)
│       ├── mech_worker.test.ts (NEW)
│       └── status/
│           ├── getAllChildrenForJobDefinition.test.ts (NEW)
│           ├── inferStatus.test.ts (UPDATED)
│           └── queryRequestsByJobDefinition.test.ts (NEW)
└── integration/
    └── control-api/
        └── validation-gateway.integration.test.ts (UPDATED)
```

### Source Code Locations
```
worker/
├── status/
│   ├── childJobs.ts - getAllChildrenForJobDefinition, queryRequestsByJobDefinition
│   └── inferStatus.ts - Job status inference with live query
├── mech_worker.ts - RPC filtering, dependency checking
└── control_api_client.ts - Client retry logic

control-api/
└── server.ts - Stale claim detection (claimRequest mutation)
```

### Documentation References
- `AGENT_README_TEST.md` - Blood-Written Rules #12, #13, #14
- `.cursor/plans/comprehensive-backend-test-suite-gap-analysis-d1e95ca2.plan.md` - Original plan
- `.cursor/plans/TEST_IMPLEMENTATION_SUMMARY.md` - Implementation summary

---

**Verification Guide Version:** 1.0  
**Last Updated:** 2025-12-03  
**Status:** Ready for verification

