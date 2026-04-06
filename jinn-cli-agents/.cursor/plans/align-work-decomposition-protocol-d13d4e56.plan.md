<!-- d13d4e56-2565-4ed4-bcc4-5a42aea455c2 e4bb57d8-2069-46e0-9bef-8868b96e218e -->
# Merge Strategy: Preserve JINN-216 Critical Fixes

## Overview
Merge origin/main while preserving critical changes from JINN-216:
- env/operate-profile.ts integration (centralizes service config reading)
- Ponder port consistency fixes (42070)
- WebSocket conditional connection fix
- Safe delivery configuration updates

## Conflict Resolution Strategy

### 1. .env.template
**Action:** Keep both sets of changes
- Preserve HEAD deprecation comments for MECH_ADDRESS/MECH_SAFE_ADDRESS/MECH_PRIVATE_KEY
- Add origin/main's SINGLE_JOB_MODE and USE_TSX_MCP variables
- Keep both sections intact, merge manually

### 2. gemini-agent/mcp/tools/finalize_job.ts
**Action:** Keep origin/main version BUT update worker address logic
- Origin/main has `getWorkerAddress()` that reads from MECH_ADDRESS/MECH_WORKER_ADDRESS env vars
- Need to update this to use `getMechAddress()` from env/operate-profile.ts instead
- Import: `import { getMechAddress } from '../../../env/operate-profile.js';`
- Update getWorkerAddress():
  ```typescript
  function getWorkerAddress(): string {
    const addr = getMechAddress();
    if (!addr) throw new Error('Service mech address not found in .operate config or environment');
    return addr;
  }
  ```

### 3. packages/mech-client-ts/src/marketplace_interact.ts
**Action:** Keep HEAD version (with WebSocket conditional connection)
- HEAD has critical fix: `const ws = postOnly ? null : await createWebSocketConnection(...)`
- This prevents WebSocket 405 errors when posting jobs
- Also includes `ws?.close()` null-safe calls
- Origin/main doesn't have this fix - would break job posting

### 4. ponder/package.json
**Action:** Hybrid approach
- Keep HEAD's `"dev": "ponder dev --port 42070"` (explicit port for consistency)
- Add origin/main's predev script enhancement: `node scripts/set-start-block.js`
- Add origin/main's resolutions for vite/esbuild
- Final dev script: `"dev": "ponder dev --port 42070"`
- Final predev: `"predev": "node scripts/set-start-block.js && node -e \"try{require('better-sqlite3')...\" || npm rebuild better-sqlite3"`

### 5. ponder/ponder.config.ts
**Action:** Keep HEAD version BUT add origin/main's review mode features
- HEAD has critical: `getMechAddress()` from operate-profile.ts for dynamic mech address
- Origin/main has: hardcoded mech address + review mode (PONDER_END_BLOCK support)
- Keep HEAD's dynamic config, add review mode logging:
  ```typescript
  if (process.env.PONDER_REVIEW_MODE === '1') {
    console.log('[Ponder Config] 🔍 REVIEW MODE ACTIVE');
    console.log(`[Ponder Config]   Start Block: ${startBlock}`);
    console.log(`[Ponder Config]   End Block: ${endBlock || 'none'}`);
  }
  ```

### 6. worker/control_api_client.ts
**Action:** Keep HEAD version
- HEAD uses `getMechAddress()` from operate-profile.ts
- Origin/main requires workerAddress parameter (breaking change)
- HEAD's approach is more robust - centralized config

### 7. worker/mech_worker.ts
**Action:** Keep HEAD version BUT add origin/main's imports if missing
- HEAD has: 
  - `getMechAddress()`, `getServiceSafeAddress()`, `getServicePrivateKey()` from operate-profile
  - GraphQL query filtering by mech address
  - Oldest-first request ordering (FIFO)
- Origin/main has:
  - Different delivery imports (post_deliver.js vs deliver.js)
  - marketplaceInteract import
- Keep HEAD's logic, verify imports are correct

## Post-Merge Validation

After resolving conflicts:
1. Verify env/operate-profile.ts is still present and unchanged
2. Verify Ponder uses getMechAddress() in ponder.config.ts
3. Verify worker uses getServiceSafeAddress() and getServicePrivateKey()
4. Test: `yarn build` succeeds
5. Test: Ponder starts on port 42070
6. Test: Worker can post and process jobs
7. Test: WebSocket doesn't fail with 405 error in postOnly mode

## Critical Files to NOT Lose
- env/operate-profile.ts (new file, must be preserved)
- packages/mech-client-ts/src/marketplace_interact.ts WebSocket fix
- ponder explicit port configuration
- worker Safe delivery configuration

### To-dos

- [ ] Create env/operate-profile.ts with getMechAddress(), getServiceSafeAddress(), getServicePrivateKey()
- [ ] Update ponder/ponder.config.ts to use env/operate-profile.ts and delete ponder/read-operate-config.ts
- [ ] Update dispatch_new_job.ts and dispatch_existing_job.ts to use getMechAddress() instead of hardcoded address
- [ ] Update worker/mech_worker.ts to use getMechAddress() from central utility
- [ ] Delete post_marketplace_job.ts, post-chief-orchestrator.ts, and remove exports from index.ts
- [ ] Revert GEMINI.md work decomposition sections to match commits 1f45e3e and 5e139f9
- [ ] Update chief-orchestrator-prompt.md to use dispatch_new_job with structured fields
- [ ] Remove post_marketplace_job references from AGENT_README.md and SETUP.md
- [ ] Verify yarn build succeeds and MCP server starts without errors