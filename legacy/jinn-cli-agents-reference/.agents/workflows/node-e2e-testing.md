---
description: How to run the jinn-node end-to-end test pipeline
---

# jinn-node E2E Testing Workflow

End-to-end testing of jinn-node uses Tenderly Virtual TestNets (VNets) to fork Base mainnet, a local service stack (Ponder, Control API, x402 Gateway), and a fresh clone of the jinn-node repo.

## Prerequisites

Before starting, ensure the following are configured in `.env.test`:

| Variable | Purpose |
|---|---|
| `TENDERLY_ACCESS_KEY` | Tenderly API key for VNet creation |
| `TENDERLY_ACCOUNT_SLUG` | Tenderly account slug |
| `TENDERLY_PROJECT_SLUG` | Tenderly project slug |
| `GITHUB_TOKEN` | GitHub PAT with repo read access (for cloning jinn-node) |
| `UMAMI_HOST` | Umami analytics host URL |
| `UMAMI_USERNAME` | Umami admin username |
| `UMAMI_PASSWORD` | Umami admin password |

Also ensure:
- **Node 22** via nvm (`nvm use 22`)
- **Docker** running (required for Postgres credential ACL database)
- **Sufficient disk space** (~2 GB for clone + node_modules + Docker images)

---

## Quick Start (One-Command Bootstrap)

The fastest path — runs Phase 0 (infrastructure) and Phase 1 (clone) in a single command:

// turbo
```bash
yarn test:e2e:bootstrap --branch main
```

This will:
1. Clean up stale VNets
2. Create a fresh Tenderly VNet (Base fork)
3. Start local stack (Ponder :42069, Control API :4001, Gateway :3001)
4. Wait for all health checks
5. Clone jinn-node at the specified branch, install deps, configure `.env`

After bootstrap, follow the **"Next Steps"** printed in the output (fund, setup, seed-acl, docker build).

---

## Manual Step-by-Step

Use this when you need more control over each phase.

### Phase 0: Infrastructure

#### Step 1 — Clean up stale VNets
// turbo
```bash
yarn test:e2e:vnet cleanup
```

#### Step 2 — Create a fresh VNet
// turbo
```bash
yarn test:e2e:vnet create
```
This writes `RPC_URL`, `VNET_ID`, and `CHAIN_ID` to `.env.e2e`.

#### Step 3 — Start the local stack
```bash
yarn test:e2e:stack
```
Starts Ponder, Control API, and Gateway. Starts a Docker Postgres container for credential ACL tables. Press Ctrl+C to stop.

#### Step 4 — Verify VNet status
// turbo
```bash
yarn test:e2e:vnet status
```

---

### Phase 1: Clone & Setup

#### Step 5 — Clone jinn-node
// turbo
```bash
yarn test:e2e:clone --branch main
```
Creates a temp clone in `/tmp/jinn-e2e-*`, installs deps, configures `.env`.

#### Step 6 — Run operator setup
```bash
cd "$CLONE_DIR" && yarn setup
```
(Use the `CLONE_DIR` path printed by the clone step.)

#### Step 7 — Fund addresses
Fund the operator/agent/Safe addresses printed by `yarn setup`:
// turbo
```bash
yarn test:e2e:vnet fund <address> --eth 0.5 --olas 100
```

#### Step 8 — Re-run setup
```bash
cd "$CLONE_DIR" && yarn setup
```
This registers the funded service on-chain.

#### Step 9 — Seed credential ACL
// turbo
```bash
yarn test:e2e:vnet seed-acl "$CLONE_DIR"
```

#### Step 10 — Build Docker image
```bash
docker build -f jinn-node/Dockerfile jinn-node/ -t jinn-node:e2e
```

---

### Phase 2: Run Tests

#### Option A — Run the full E2E suite
// turbo
```bash
yarn test:e2e
```
Runs both the legacy test rig and the Vitest E2E project.

#### Option B — Run just the Vitest E2E tests
// turbo
```bash
yarn test:e2e:vitest
```

#### Option C — Run the worker E2E test
// turbo
```bash
npx tsx scripts/test-worker-e2e.ts
```
Spawns the actual worker process (`yarn mech`) and validates startup, staking loop, and log output.

#### Option D — Credential permission matrix
// turbo
```bash
yarn test:e2e:permissions --cwd "$CLONE_DIR" --venture
```

#### Option E — Dispatch a workstream job
// turbo
```bash
yarn test:e2e:dispatch --workstream <workstream-id>
```

---

### Phase 3: VNet Manipulation

These are useful during test execution for time-warping, checkpointing, and activity seeding.

#### Time warp (advance blockchain time)
// turbo
```bash
yarn test:e2e:vnet time-warp 259200   # 72 hours
```

#### Mine blocks
// turbo
```bash
yarn test:e2e:vnet mine 10
```

#### Call staking checkpoint
// turbo
```bash
yarn test:e2e:vnet checkpoint --staking <staking-address> --key <private-key>
```

#### Seed activity (nonce + request count)
// turbo
```bash
yarn test:e2e:vnet seed-activity <multisig> --staking <staking-address> --value 1000
```

---

### Phase 4: Preflight & Cleanup

#### Hard preflight gate
Validates everything is healthy before a test run:
// turbo
```bash
yarn test:e2e:vnet preflight --cwd "$CLONE_DIR"
```
Checks: Node 22 + nvm, Ponder healthy, Control API healthy, Gateway healthy, GitHub token valid, ACL seeded.

#### Full cleanup
// turbo
```bash
yarn test:e2e:vnet cleanup --max-age-hours 0
```

---

## Key Files

| File | Purpose |
|---|---|
| `scripts/test/e2e-bootstrap.ts` | One-command bootstrap (Phase 0 + Phase 1) |
| `scripts/test/e2e-harness.ts` | VNet lifecycle CLI (create, fund, mine, checkpoint, etc.) |
| `scripts/test/start-e2e-stack.ts` | Local stack manager (Ponder, Control API, Gateway, Postgres) |
| `scripts/test/setup-clone.ts` | Clone jinn-node at a branch, install deps |
| `scripts/test/docker-run.ts` | Docker run helper for E2E |
| `scripts/test/credential-permission-matrix.ts` | Credential permission matrix test |
| `scripts/test/dispatch-workstream-job.ts` | Dispatch a workstream job for testing |
| `scripts/test/parse-telemetry.ts` | Parse telemetry output from test runs |
| `scripts/test-worker-e2e.ts` | Worker E2E test (spawns actual worker process) |
| `scripts/lib/tenderly.ts` | Tenderly client library |
| `scripts/lib/e2e-test-utils.ts` | Shared E2E test utilities |
| `.env.test` | Test environment variables (Tenderly creds, etc.) |
| `.env.e2e` | Generated by VNet create — contains RPC_URL, VNET_ID |
| `.env.e2e.acl.json` | Credential ACL grants for agent EOAs |

## Troubleshooting

- **"Quota exhausted"**: Run `yarn test:e2e:vnet create` to get a fresh VNet.
- **Ponder won't start**: Run `rm -rf ponder/.ponder` to clear stale cache, then retry.
- **Port already in use**: The stack script auto-kills processes on :42069, :4001, :3001, but you can manually kill with `lsof -ti :42069 | xargs kill`.
- **Docker not running**: Start Docker Desktop. Postgres is required for venture permission tests only.
- **Node version mismatch**: Run `nvm use 22`.
