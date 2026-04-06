# Phase 4: Rotation Worker — Child Pickup + Credential Validation (Docker)

**Prerequisites**: Phase 3 PASS (parent executed, child dispatched via `dispatch_new_job`)
**Abort on failure**: Continue

Test forced rotation switching by picking up the child job dispatched in Phase 3, then run a second full-blueprint job to validate credential bridge tools work with the rotated service identity. Simulate activity on Service A so the rotator picks Service B. With `WORKER_MECH_FILTER_MODE=any`, Service B can claim jobs even though they target Service A's mech.

## Steps

### 1. Simulate activity for Service A

**Do this BEFORE running the worker.** This makes the rotator pick Service B.

From the monorepo root:
```bash
yarn test:e2e:vnet seed-activity $SERVICE_A_SAFE \
  --staking 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 \
  --value 1000
```

Expected: `Verified nonces: [ '1000', '1000' ]`

**Do NOT call checkpoint or advance time between activity seeding and the worker run.**

### 2. Run worker via Docker (picks up child from Phase 3)

The child job dispatched in Phase 3 is already on-chain. No new dispatch needed.

Stale telemetry files are cleaned automatically before the container starts.

```bash
yarn test:e2e:docker-run --cwd "$CLONE_DIR" --single \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --env X402_GATEWAY_URL=http://host.docker.internal:3001
```

`WORKER_MECH_FILTER_MODE=any` is set automatically, allowing Service B to pick up the child job even though it was dispatched to Service A's mech. Tool static config/secrets are fetched via the credential bridge at runtime; venture-scoped `JINN_JOB_*` config is already embedded in the dispatched payload.

### 3. Save child telemetry

```bash
mkdir -p /tmp/jinn-telemetry-rotation
cp /tmp/jinn-telemetry/telemetry-*.json /tmp/jinn-telemetry-rotation/
echo "TELEMETRY_DIR_ROTATION=/tmp/jinn-telemetry-rotation" >> .env.e2e
```

### 4. Dispatch full-blueprint job for credential validation

This is the regression gate: exercise credential bridge tools (`venture_query`, `blog_get_stats`) with Service B as the active signer identity. Uses the same blueprint and input config as Phase 3.

From the monorepo root:
```bash
yarn test:e2e:dispatch \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --cwd "$CLONE_DIR" \
  --input "$INPUT_CONFIG"
```

Fund Service B's agent EOA if needed:
```bash
yarn test:e2e:vnet fund $AGENT_EOA_2 --eth 0.05
```

### 5. Run worker again — credential bridge validation

Service B remains active (Service A's activity is still seeded). The `--log-suffix rotation-cred` flag separates Docker logs from the child run.

```bash
yarn test:e2e:docker-run --cwd "$CLONE_DIR" --single \
  --log-suffix rotation-cred \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --env X402_GATEWAY_URL=http://host.docker.internal:3001
```

After the worker completes, check for credential bridge errors:
```bash
grep -E 'CREDENTIAL_ERROR|INVALID_SIGNATURE|bad_signature' /tmp/jinn-e2e-logs/docker-rotation-cred.log
```

Any match near `venture_query` or `blog_get_stats` means the credential bridge failed with the rotated service identity — this is the exact regression this step catches.

### 6. Save credential telemetry

```bash
mkdir -p /tmp/jinn-telemetry-rotation-cred
cp /tmp/jinn-telemetry/telemetry-*.json /tmp/jinn-telemetry-rotation-cred/
echo "TELEMETRY_DIR_ROTATION_CRED=/tmp/jinn-telemetry-rotation-cred" >> .env.e2e
```

### 7. Fallback: dispatch fresh job if no child

If Phase 3's `dispatch_new_job` failed (DELEGATE-001 was FAIL), the child won't be on-chain for step 2. In that case, dispatch a fresh job from the monorepo root and re-run step 2:

```bash
yarn test:e2e:dispatch \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --cwd "$CLONE_DIR" \
  --input "$INPUT_CONFIG"
```

Then re-run step 2. Steps 4-6 (credential validation) proceed regardless of whether the child existed.

## Expected Output

- Storage manipulation: `Verified nonces: [ '1000', '1000' ]`
- Worker output (child run) should show:
  - `Multi-service rotation active` — confirms ServiceRotator has 2 services
  - `activeService` set to Service B's config ID (not A)
  - `reason` — should indicate Service A is eligible, B needs work
- Worker finds the child request (dispatched by parent in Phase 3) or the fallback dispatch
- Child agent claims and processes the job (simpler blueprint: web search + artifact only)
- Worker output (credential run) should show:
  - Service B still active (no rotation switch — A's activity is still seeded)
  - All 8 tools called, including `venture_query` and `blog_get_stats`
  - No `CREDENTIAL_ERROR` or `INVALID_SIGNATURE` in logs

## On Failure

- **tenderly_setStorageAt fails**: Capture RPC error. Ensure you're using the admin RPC URL (from VNet creation), not a public RPC.
- **Nonces don't verify to 1000**: Capture actual values. The storage slot calculation may be wrong for the contract version.
- **Worker picks Service A instead of B**: Capture full worker output. The rotator logic may have changed — document the `reason` field and which service was selected.
- **Worker finds 0 requests**: The child from Phase 3 may not have been indexed by Ponder yet. Check Ponder query output. If Phase 3's DELEGATE-001 failed, use the fallback dispatch (step 7).
- **Cross-mech pickup fails**: Check that `WORKER_MECH_FILTER_MODE=any` appears in the Docker command output. Without it, Service B won't find Service A's child request.
- **Credential tools fail with INVALID_SIGNATURE**: This is the rotation signer cache regression. Check that `signing-proxy.ts` resets `cachedAddress` in `startSigningProxy()` and that `mech_worker.ts` calls `resetControlApiSigner()` + `resetSigningProxyAddress()` after rotation. See blood-written rule #83.
- **venture_query or blog_get_stats show CREDENTIAL_ERROR**: Check ACL is seeded for Service B's agent EOA (`$AGENT_EOA_2`). Re-run `yarn test:e2e:vnet seed-acl "$CLONE_DIR"` if needed.

## CHECKPOINT: Phase 4 — Rotation Worker (Docker)

### Child Pickup (Cross-Mech Rotation)
- [PASS|FAIL] `tenderly_setStorageAt` made Service A appear eligible (nonces verified as `[1000, 1000]`)
- [PASS|FAIL] Worker initialized rotation with 2 services
- [PASS|FAIL] Worker picked Service B as active (not Service A)
- [PASS|FAIL] Worker found and claimed request (child from Phase 3 or fallback)
- [PASS|FAIL] Agent executed and produced output

### Post-Rotation Credential Validation
- [PASS|FAIL] Fresh full-blueprint job dispatched for credential validation
- [PASS|FAIL] Worker claimed and executed with Service B active
- [PASS|FAIL] `venture_query` succeeded (credential bridge post-rotation — CREDENTIAL_ERROR or INVALID_SIGNATURE is FAIL)
- [PASS|FAIL] `blog_get_stats` succeeded (credential bridge post-rotation — bridge error is FAIL)
- [PASS|FAIL] No credential tools show EXECUTION_ERROR or CREDENTIAL_ERROR in Docker logs
