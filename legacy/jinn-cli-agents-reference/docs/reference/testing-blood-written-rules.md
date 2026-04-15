---
title: Testing Blood Written Rules
purpose: reference
scope: [worker, gemini-agent, tests]
last_verified: 2026-02-02
related_code:
  - tests-next/
keywords: [testing, blood-written-rules, pitfalls, fixtures, mocks, jest]
when_to_read: "When writing tests or debugging test failures"
---

# Testing Blood Written Rules

Common pitfalls when writing and running tests for Jinn.

---

## Git Fixtures

### Git Fixtures Must Have Main Branch
**Issue:** Test git fixtures need `main` branch with initial commit for `dispatch_new_job` to create job branches
**Solution:** `tests-next/helpers/git-fixture.ts` verifies and creates `main` branch after clone if missing
**Error Message:** `code_metadata.ts` now provides explicit instructions when base branch doesn't exist
**Prevention:** Ensure test git templates have commits on `main` branch

### Git Clone from Local Path Needs --no-hardlinks
**Issue:** `git clone` from local directory creates hardlinks by default, which can cause empty clones with no commits
**Solution:** Use `git clone --no-hardlinks` when cloning from local template directories
**Prevention:** Always use `--no-hardlinks` flag for local repository clones in tests

---

## Mocking

### Mocking pg.Client Requires EventEmitter
**Issue:** `pg.Client` extends `EventEmitter`, code registers error listeners via `client.on('error', ...)`
**Solution:** Test mocks must extend `EventEmitter` from `node:events`
**Prevention:** When mocking third-party libraries, check full interface including inherited classes

---

## Output Formats

### Blueprint Format Changed to JSON
**Issue:** Tests expecting old GEMINI.md markdown format fail when `buildPrompt()` returns JSON
**Solution:** Parse JSON output and check structure fields: `parsed.context`, `parsed.assertions`, etc.
**Prevention:** When changing output formats, search for all test assertions using old format

---

## Ponder in Tests

### Ponder Startup Requires Valid RPC URL
**Issue:** Ponder config calls `getStartBlock()` which makes RPC call during initialization. Invalid/unreachable RPC causes 30s timeout before Ponder starts
**Symptom:** Tests with `rpcUrl: 'http://127.0.0.1:8545'` hang for 30s during `withProcessHarness` before any test code runs
**Solution:** Always use real RPC (Tenderly VNet) or set `PONDER_START_BLOCK` env var to skip RPC call
**Prevention:** Use `withTenderlyVNet` for all tests that need Ponder, even if not dispatching transactions

### Tenderly VNet Connection Timeouts (FIXED)
**Issue:** Integration tests fail with `ConnectTimeoutError` when connecting to Tenderly VNet endpoints
**Root Cause:** Transient network issues when calling Tenderly API (createVnet, fundAddress, deleteVnet). Default `fetch()` has no retry logic
**Error:** `ConnectTimeoutError: Connect Timeout Error (attempted address: virtual.base.eu.rpc.tenderly.co:443, timeout: 10000ms)`
**Solution:** Added `fetchWithRetry()` helper in `scripts/lib/tenderly.ts` with exponential backoff (3 retries, 1s/2s/4s delays)
**Prevention:** External API calls in test infrastructure must have retry logic for network reliability

### Tenderly VNet Factory Pattern Indexing (FIXED)
**Issue:** Integration tests timeout waiting for Ponder to index `Deliver` events after successful dispatch to Tenderly VNets
**Root Causes:**
1. Factory pattern scanning from wrong block - VNets fork from block ~40M but don't contain historical blocks
2. Child start block evaluated at module-load time, before test env vars were set
3. MechMarketplace still scanning from block 0

**Solution:**
1. Bypass factory pattern in test mode: When `FACTORY_START_BLOCK=0`, set `address: undefined` on `OlasMech`
2. Lazy evaluation of child start block: Use `getChildStartBlock()` directly instead of cached constant
3. MechMarketplace conditional start: Use `getChildStartBlock()` for marketplace too when `FACTORY_START_BLOCK=0`

**Prevention:**
1. Never evaluate env vars at module-load time - use lazy evaluation (function calls) in config objects
2. When bypassing factory pattern in tests, ensure ALL contracts using factory start block also use test start block
3. Factory pattern + chain forks = incompatible - either use `address: undefined` or seed factory events

---

## Agent Tests

### Gemini CLI Hangs in Test Environments (FIXED)
**Issue 1:** System tests timeout after 300 seconds during agent execution phase. Gemini CLI subprocess spawns successfully but produces zero stdout/stderr.
**Root Cause:** Gemini CLI v0.11.2 hangs during initialization when spawned with `cwd` pointing to ephemeral/temporary directories.

**Issue 2:** Agent creates files in `gemini-agent/` directory instead of repository root when using stable `cwd`.
**Root Cause:** Native tools resolve relative paths based on CLI's `cwd`.

**Solution:**
1. Use `gemini-agent/` as `cwd` in test environments (prevents hang)
2. Expose workspace path via `JINN_WORKSPACE_DIR` env var
3. Added `SYS-TOOLS-002` system blueprint assertion requiring absolute paths using `metadata.workspacePath`

**Prevention:**
1. Never spawn external CLIs with `cwd` pointing to temporary test fixtures
2. Always instruct agents to use absolute paths for file operations when workspace differs from cwd
3. Expose workspace path in blueprint metadata for agent consumption

---

*Keep this file updated with new testing blood written rules as they're discovered.*
