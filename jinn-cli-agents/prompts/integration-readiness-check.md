# Integration Readiness Validation — integrate/jinn-382

You are an autonomous validation agent. The `integrate/jinn-382` branch is merged and ready for E2E testing. Your job is to run every validation gate until ALL pass. If a gate fails, diagnose the root cause, fix the code, commit, redeploy, and retry. Do NOT finish until every gate is PASS.

## Environment

- **Monorepo**: `/Users/adrianobradley/jinn-gemini-2` (this repo)
- **Standalone jinn-node**: `/Users/adrianobradley/jinn-nodes/jinn-node` (canary .operate profile)
- **Branch under test**: `integrate/jinn-382`
- **Canary worker**: `canary-worker-2` in Railway project `jinn-worker` (production env)
- **Canary gateway**: `x402-gateway-canary` in Railway project `jinn-shared` (production env)
- **Ponder**: sandbox-deployed, schema `jinn_shared_v7`

## Rules

1. **Never finish with failing gates.** Fix and retry until PASS.
2. **Commit fixes to the integration branch.** Descriptive commit messages.
3. **Track state** in `.tmp/integration-readiness/gate-status.json` (template below).
4. **Use the skills.** `/node-e2e-testing` for Tenderly, `/node-railway-mainnet-testing` for canary. Follow their instructions exactly.
5. **Fix code, not tests.** Never weaken a gate to pass.
6. **Log everything** to `.tmp/integration-readiness/`.

---

## Phase 1: Preflight

1. Checkout and pull `integrate/jinn-382`.
2. `yarn install` + `npx tsc --noEmit` in monorepo root and `jinn-node/`.
3. Initialize `gate-status.json` with all gates set to `PENDING`.

---

## Phase 2: Tenderly E2E (`/node-e2e-testing`)

Run the skill against the integration branch. Fresh VNet, 2 services, full worker pipeline.

**Worker gates:**

| Gate | What it proves |
|------|---------------|
| W1 | On-chain service resolver derives serviceId/multisig/marketplace at startup |
| W2 | VENTURE_FILTER restricts Ponder queries to matching ventureId |
| W3 | Poll query returns newest requests first (desc ordering) |
| W4 | WORKSTREAM_FILTER=none handled as "no filter" |
| W5 | Cross-mech delivery works after priority window expires |
| W6 | Delivery captures lightweight revert diagnostics (decoded revert reason, GS013 mech↔safe auth check) on transaction failure |
| W7 | Undelivered verification checks the mech performing delivery (own mech after timeout override, priority mech within window) |
| W8 | Epoch gate uses on-chain nonces as baseline (restart-proof) |
| W9 | Heartbeat submits 1 request/call, target 60/epoch, multisig from on-chain |
| W13 | dispatch_new_job routes through proxy-only dispatch-core (throws if AGENT_SIGNING_PROXY_URL unset), propagates ventureId |

**Credential gates:**

| Gate | What it proves |
|------|---------------|
| CR1 | Credential filter probes bridge with ERC-8128 signed request, caches result |
| CR2 | Worker skips jobs requiring credentials it doesn't have (tool→provider mapping enforced) |
| CR3 | Signing proxy is proxy-only: dispatch-core throws if AGENT_SIGNING_PROXY_URL unset |
| CR4 | Service rotation flushes signer caches (resetControlApiSigner + resetCachedAddress called on switch) |
| CR5 | Post-rotation credential bridge validation: Service B's signer identity accepted by bridge and Control API |

**Credential bridge post-rotation** (Phase 4): venture_query + blog_get_stats succeed with Service B's signer identity.

**Prior evidence**: All W and CR gates passed on credential branch E2E run.

**Gate criteria**: ALL Phase 0-5 checkpoints PASS.

On failure: diagnose → fix → commit → push → re-run failing phase.

---

## Phase 3: Railway Canary (`/node-railway-mainnet-testing`)

### 3a: Pre-smoke

Run `/node-railway-mainnet-testing pre-smoke` with:

```
--repo Jinn-Network/jinn-node
--branch integrate/jinn-382
--worker-project jinn-worker
--worker-env production
--worker-service canary-worker-2
--gateway-project jinn-shared
--gateway-env production
--gateway-service x402-gateway-canary
--workstream <canary workstream>
--operate-dir /Users/adrianobradley/jinn-nodes/jinn-node/.operate
--expected-delivery-rate 99
```

**Gates validated:**

| Gate | What it proves | Prior evidence |
|------|---------------|----------------|
| CANARY_DEPLOY | canary-worker-2 + x402-gateway-canary healthy on correct branch | PASS — Deployment 68447553 + 6784d894 both SUCCESS |
| CANARY_BASELINE | Claim/execute/deliver loop with successful delivery txs | PASS — request 0x3ba30f delivered via Safe tx 0x25e24e |
| CANARY_CRED_TRUSTED | Trusted operator processes credential-required jobs and delivers | PASS — request 0x52ab28 delivered via 0x7139d6 |
| CANARY_CRED_UNTRUSTED | Untrusted operator skips credential-required jobs (workerProviders=[]) | PASS — request 0x239221 skipped, no claim during untrusted phase |
| CANARY_FILTERING | Credential jobs skipped when unavailable; non-credential jobs still processed normally | PASS — non-credential request 0x3ba30f claimed/delivered under untrusted mode |
| CANARY_FAILCLOSED | Credential access control denies blocked operators: venture_only blocked operator absent from capabilities; infrastructure fail-closed validated on Tenderly (CR1-CR5) | PASS — venture_only_blocked_denies_even_with_global on mainnet |
| CANARY_SECURITY | No secret leakage in logs (token/private-key patterns); hasAgentPrivateKey only, no raw keys | PASS — ServiceConfigReader.ts verified |
| CANARY_DELIVERY_RATE | assert-delivery-rates.ts --expected 99 passes for both deployed mechs | PASS — all maxDeliveryRate == 99 |

**Gate criteria**: ALL pre-smoke phases (0-5) PASS.

### 3b: Smoke

After pre-smoke passes, run `/node-railway-mainnet-testing smoke` (30-minute window):

| Gate | What it proves |
|------|---------------|
| CANARY_SMOKE | No mech-resolution regressions, no repeated credential errors, healthy loop for 30 min |

---

## Phase 4: Ponder Validation

Direct checks — not covered by skills:

| Gate | Check | How |
|------|-------|-----|
| P1 | Requests store ventureId + templateId from IPFS metadata | Query sandbox Ponder: `requests(limit:5, orderDirection:"desc") { items { id ventureId templateId } }` — fields must be non-null for Jinn requests |
| P2 | Workstream lastStatus + latestStatusUpdate populated on delivery | Query a workstream with known deliveries — both fields non-null |
| P3 | Mech allowlist at startup, non-Jinn requests skipped | Check Ponder deploy logs for allowlist build + skip messages |
| P4 | IPFS gateway fallback includes ipfs.io, timeout 1.5s, no cloudflare-ipfs | `grep -r 'cloudflare-ipfs' ponder/` must return nothing; verify timeout in fetchRequestMetadata |
| P5 | Build ~97s, no jinn-node compilation | Check recent Ponder deploy log build time |
| P6 | PONDER_VIEWS_SCHEMA configurable via env | Verify env var exists in deploy/ponder/nixpacks.toml |
| P7 | Deploy trigger on correct branch | Check Railway Ponder service source branch setting |

---

## Phase 5: Feature Spot-Checks

Code-level verification for additive features:

| Gate | Check | How |
|------|-------|-----|
| W10 | ENABLE_VENTURE_WATCHER=1 triggers schedule checks | Grep for env var usage, verify conditional in worker loop |
| W11 | Venture watcher respects VENTURE_FILTER, uses claimVentureDispatch | Trace dispatch path in code |
| W12 | MAX_PARENT_DISPATCHES=5 prevents cascade storms | Verify constant + enforcement in autoDispatch |
| C1 | claimVentureDispatch mutation deduplicates (10-min TTL) | Verify mutation exists in control-api schema + resolver |
| E1 | All new MCP tools registered | Check tool index for: moltbook (10), telegram_get_updates, read_dispatch_schedule, update_dispatch_schedule, twitter tools |
| N1 | 5 new blueprints exist | Verify files in blueprints/ directory |
| N2 | VentureContextProvider compiles + injects invariants | `tsc --noEmit` covers this; verify import chain |
| N3 | serviceResolver resolves on-chain | Verify serviceResolver.ts exports + is called from worker startup |
| N4 | Random staked mech selection for dispatch | Verify getRandomStakedMech in stakingFilter.ts + ventureDispatch.ts |
| F1 | Venture page renders for UUIDs and workstream IDs | Verify route exists in frontend explorer |
| F2 | Schedule timeline renders past/current/future dots | Verify component exists and compiles |
| F3 | venture-queries.ts filters by ventureId | Verify Ponder query includes ventureId filter |
| F4 | subgraph.ts has try/catch for schema mismatches | Verify error handling wraps Ponder queries |
| F5 | staking/rpc.ts throws on missing RPC_URL | Verify no silent fallback to public RPC |

**Credential spot-checks (code inspection):**

| Gate | Check | How |
|------|-------|-----|
| CR9 | tool-credential-requirements.ts maps 8 providers | Code inspection: telegram, twitter, umami, openai, civitai, supabase, fireflies, railway |
| CR10 | credentialFilter.ts reprobes with requestId after job claim | Code inspection: venture-scoped credential refresh |
| CR11 | GitHub operator capability validated via API call | Code inspection: GITHUB_TOKEN → /user endpoint |
| CR12 | ERC-8128 nonce store prevents replay | Code inspection: InMemoryNonceStore in control-api server.ts |

---

## Gate Status Tracking

Initialize `.tmp/integration-readiness/gate-status.json`:

```json
{
  "branch": "integrate/jinn-382",
  "lastUpdated": "",
  "attempt": 1,
  "gates": {
    "P1": { "status": "PENDING", "detail": "" },
    "P2": { "status": "PENDING", "detail": "" },
    "P3": { "status": "PENDING", "detail": "" },
    "P4": { "status": "PENDING", "detail": "" },
    "P5": { "status": "PENDING", "detail": "" },
    "P6": { "status": "PENDING", "detail": "" },
    "P7": { "status": "PENDING", "detail": "" },
    "W1": { "status": "PENDING", "detail": "" },
    "W2": { "status": "PENDING", "detail": "" },
    "W3": { "status": "PENDING", "detail": "" },
    "W4": { "status": "PENDING", "detail": "" },
    "W5": { "status": "PENDING", "detail": "" },
    "W6": { "status": "PENDING", "detail": "" },
    "W7": { "status": "PENDING", "detail": "" },
    "W8": { "status": "PENDING", "detail": "" },
    "W9": { "status": "PENDING", "detail": "" },
    "W10": { "status": "PENDING", "detail": "" },
    "W11": { "status": "PENDING", "detail": "" },
    "W12": { "status": "PENDING", "detail": "" },
    "W13": { "status": "PENDING", "detail": "" },
    "C1": { "status": "PENDING", "detail": "" },
    "E1": { "status": "PENDING", "detail": "" },
    "F1": { "status": "PENDING", "detail": "" },
    "F2": { "status": "PENDING", "detail": "" },
    "F3": { "status": "PENDING", "detail": "" },
    "F4": { "status": "PENDING", "detail": "" },
    "F5": { "status": "PENDING", "detail": "" },
    "N1": { "status": "PENDING", "detail": "" },
    "N2": { "status": "PENDING", "detail": "" },
    "N3": { "status": "PENDING", "detail": "" },
    "N4": { "status": "PENDING", "detail": "" },
    "CR1": { "status": "PENDING", "detail": "" },
    "CR2": { "status": "PENDING", "detail": "" },
    "CR3": { "status": "PENDING", "detail": "" },
    "CR4": { "status": "PENDING", "detail": "" },
    "CR5": { "status": "PENDING", "detail": "" },
    "CR9": { "status": "PENDING", "detail": "" },
    "CR10": { "status": "PENDING", "detail": "" },
    "CR11": { "status": "PENDING", "detail": "" },
    "CR12": { "status": "PENDING", "detail": "" },
    "CANARY_DEPLOY": { "status": "PENDING", "detail": "" },
    "CANARY_BASELINE": { "status": "PENDING", "detail": "" },
    "CANARY_CRED_TRUSTED": { "status": "PENDING", "detail": "" },
    "CANARY_CRED_UNTRUSTED": { "status": "PENDING", "detail": "" },
    "CANARY_FILTERING": { "status": "PENDING", "detail": "" },
    "CANARY_FAILCLOSED": { "status": "PENDING", "detail": "" },
    "CANARY_SECURITY": { "status": "PENDING", "detail": "" },
    "CANARY_DELIVERY_RATE": { "status": "PENDING", "detail": "" },
    "CANARY_SMOKE": { "status": "PENDING", "detail": "" }
  }
}
```

## Completion Criteria

You are DONE only when:
1. Every gate in `gate-status.json` shows `"status": "PASS"`
2. E2E skill final report: all phases PASS
3. Railway canary pre-smoke: all phases PASS
4. Railway canary smoke: PASS
5. All fixes committed and pushed to `integrate/jinn-382`

Produce a final summary:
- Total attempts needed
- Fixes applied (commit SHAs + descriptions)
- Gate-by-gate results table
- Caveats or known limitations
- Deploy sequence readiness confirmation
