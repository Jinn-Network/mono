# SWE-rebench v2 — local dual-daemon E2E smoke

**Audience:** contributors manually proving the live solve → deliver → evaluate →
verdict loop on Base Sepolia before a release or after harness/daemon changes.

**Not this doc:** dashboard-only operator flows
([`swe-rebench-v2-public-testnet.md`](./swe-rebench-v2-public-testnet.md)),
launcher setup ([`launch-swe-rebench-v2.md`](./launch-swe-rebench-v2.md)), or
automated vitest e2e (`client/test/e2e/swe-rebench-v2.test.ts`,
`yarn e2e:daemon-harness`). This runbook is the **two-terminal, two-daemon**
recipe for a real LLM solver plus a real Docker evaluator on one machine.

## Why two daemons

The protocol blocks self-evaluation: the evaluator agent must differ from the
solver agent. A single daemon with `roles: ["solver", "evaluator"]` still uses
one on-chain mech, so restoration and evaluation for the same attempt collide.
Run **evaluator** and **solver** as separate processes with **separate fleet
services** (two agents / two mechs) under the same master wallet.

## Architecture

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│ Evaluator daemon            │     │ Solver daemon               │
│ ~/.jinn-client/             │     │ ~/.jinn-client-solver/      │
│ apiPort 7332                │     │ apiPort 7333                │
│ roles: [evaluator]          │     │ roles: [solver]             │
│ earning → service 72 (1st)  │     │ earning → service 73 only   │
│ swe-rebench-v2-evaluator    │     │ claude-code (or codex)      │
└──────────────┬──────────────┘     └──────────────┬──────────────┘
               │                                     │
               └────────── Base Sepolia testnet ─────┘
                    canonical SWE-rebench v2 SolverNet
```

Canonical SolverNet manifest CID (join both sides):

`bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi`

## Preconditions

1. **Built client** from this repo:
   ```bash
   cd client && yarn install && yarn build
   ```
2. **Funded testnet operator** — default `~/.jinn-client` bootstrap complete
   (master EOA + at least one operational service with ETH/OLAS on Base Sepolia).
3. **Evaluator deps:**
   ```bash
   jinn harnesses enable swe-rebench-v2-evaluator
   docker info    # must succeed
   python3 --version
   ```
4. **Solver LLM auth** (pick one harness):
   - `claude-code`: `claude auth status` → `loggedIn: true`
   - `codex`: Codex CLI installed and within usage limits
5. **Disk:** evaluator Docker runs need headroom; default floor is
   `JINN_EVAL_DISK_FLOOR_GB=20` (raise locally if prune warnings appear).
6. **Password file:** `~/.jinn-client/keystore-password` must **not** have a
   trailing newline (breaks decrypt). Use the helper below.

Shared password helper (use in both terminals):

```bash
export JINN_PASSWORD="$(python3 -c 'from pathlib import Path; print(Path.home().joinpath(".jinn-client/keystore-password").read_text().rstrip("\n"), end="")')"
```

## One-time setup

### 1. Join the canonical SolverNet (evaluator)

In `~/.jinn-client/config.json`, ensure `joinedSolverNets` includes the manifest
above with `roles: ["evaluator"]`, `apiPort: 7332`, and evaluator-appropriate
harness (daemon derives eval dispatch from the contract; config still lists
`claude-code-learner` or similar for metadata). If you normally use the
dashboard, joining via `/operator` is fine — verify the JSON on disk afterward.

### 2. Grow the fleet (second service for the solver)

From the primary config:

```bash
cd client
export JINN_PASSWORD=…   # or use helper above
node dist/bin/jinn.js fleet scale --to 2 --yes
```

Wait until `earning_state.json` lists two operational (or near-operational)
services. The evaluator daemon uses the **first** operational service in that
file (typically service 72). The new service (e.g. 73) is for the solver only.

`safe_binding_pending` on the new service is **non-fatal** for claiming tasks;
metadata publish may warn `Not authorized` until ERC-8004 Safe binding succeeds.

### 3. Solver state directory

Create an isolated solver home so the two daemons do not share SQLite or
in-flight engine state:

```bash
export SOLVER_HOME="$HOME/.jinn-client-solver"
mkdir -p "$SOLVER_HOME"/{earning,engine/work,engine/impl-state}

# Same master keystore as the primary operator (symlink is fine)
ln -sf "$HOME/.jinn-client/earning/master_keystore.json" "$SOLVER_HOME/earning/"

# earning_state.json: copy from ~/.jinn-client/earning/earning_state.json,
# then keep ONLY the second service object in "services" (the solver service).
# The daemon picks the first operational entry — with one entry, that is the solver.
```

### 4. Solver config file

Save as `$SOLVER_HOME/config.json` (adjust paths if you use a different
`SOLVER_HOME`):

```json
{
  "network": "testnet",
  "rpcUrl": "https://base-sepolia.publicnode.com",
  "claudeModel": "claude-haiku-4-5-20251001",
  "pollIntervalMs": 5000,
  "apiPort": 7333,
  "runtimeMode": "bare",
  "earningDir": "/Users/YOU/.jinn-client-solver/earning",
  "dbPath": "/Users/YOU/.jinn-client-solver/jinn.db",
  "engine": {
    "workingDirRoot": "/Users/YOU/.jinn-client-solver/engine/work",
    "implStateDirRoot": "/Users/YOU/.jinn-client-solver/engine/impl-state"
  },
  "tasks": [],
  "joinedSolverNets": {
    "bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi": {
      "manifestCid": "bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi",
      "roles": ["solver"],
      "name": "SWE-rebench v2",
      "contract": { "id": "swe-rebench-v2", "version": "v1" },
      "harness": "claude-code",
      "model": "claude-haiku-4-5-20251001",
      "plugins": ["bundled:swe-rebench-v2-runtime"],
      "disabledDefaultPlugins": []
    }
  },
  "harness": { "mode": "train" },
  "operator": {
    "publicEndpoint": "http://localhost:7333",
    "defaultPriceUsdc": "0",
    "perArtifactTypePrice": {},
    "donation": { "enabled": true }
  },
  "ethereumRpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
  "jinnClaimLoopEnabled": false,
  "checkpointIntervalMs": 0,
  "rewardClaimIntervalMs": 0,
  "evictionCheckIntervalMs": 0
}
```

Replace `/Users/YOU/…` with your home path. Swap `harness` / `model` for `codex`
if not using Claude.

## Smoke run

Start **evaluator first**, then **solver**. Use separate terminal tabs.

### Terminal A — evaluator

```bash
cd client
export JINN_PASSWORD=…
export JINN_AI_UNITS_CEILING_OVERRIDE=1000   # optional; raises local spend cap

node dist/bin/jinn.js run --config "$HOME/.jinn-client/config.json" \
  2>&1 | tee "$HOME/.jinn-client/daemon-evaluator-smoke.log"
```

Confirm log lines: `Daemon started`, `Loaded SolverNet: SWE-rebench v2`, harness
registry includes `swe-rebench-v2-evaluator`. Dashboard:
`http://127.0.0.1:7332/`

### Terminal B — solver

`harness.mode: train` expects a learner orient artifact. For a one-off solve
smoke, skip learner phases:

```bash
cd client
export JINN_PASSWORD=…
export LEARNER_PHASE_RANGE=solve-only
export JINN_AI_UNITS_CEILING_OVERRIDE=1000

node dist/bin/jinn.js run --config "$HOME/.jinn-client-solver/config.json" \
  2>&1 | tee "$HOME/.jinn-client-solver/solver-smoke.log"
```

Dashboard: `http://127.0.0.1:7333/`

Stop the solver after **one** restoration reaches `COMPLETE` unless you intend to
burn more tasks and LLM quota.

## What success looks like

**Solver log** (one request id):

1. `PRE_SNAPSHOT -> RUNNING`
2. `RUNNING → POST_SNAPSHOT via impl=claude-code` (or your harness)
3. `PACKAGING → DELIVERING`
4. `DELIVERING → COMPLETE deliveryTx=0x… claimTx=0x…`

**Evaluator log** (different request id, same `instance_id`):

1. `observed task 0x…`
2. `PRE_SNAPSHOT -> RUNNING` under `swe-rebench-v2-evaluator`
3. `DELIVERING → COMPLETE`
4. `Processed evaluation delivery` / `role=verdict`

**SQLite spot-check:**

```bash
sqlite3 "$HOME/.jinn-client-solver/jinn.db" \
  "select request_id, state, impl_name from task_runs order by state_updated_at desc limit 3;"

sqlite3 "$HOME/.jinn-client/jinn.db" \
  "select request_id, state, impl_name from task_runs order by state_updated_at desc limit 3;"
```

**Verdict payload:** fetch the evaluator manifest CID from the log via
`https://gateway.autonolas.tech/ipfs/<cid>` — expect
`schemaVersion: swe-rebench-v2-verdict.v2`, `passedCount` / `totalCount`, and
`passed_match`. A real LLM patch may **FAIL** grading; that still counts as a
successful smoke if the verdict delivered on-chain.

## Stop daemons

```bash
pkill -f 'jinn.js run'    # or Ctrl-C in each terminal
ps -ax | grep 'jinn.js run'
```

## Troubleshooting

| Symptom | Likely fix |
|--------|------------|
| `invalid_literal` / missing `swe-rebench-v2-solution.v1` on package | Solver did not emit a typed patch; check workdir `.execute/solution-payload.json` and Claude stdout under `engine/work/<requestId>/` |
| `ai_units_cap_reached` | Export `JINN_AI_UNITS_CEILING_OVERRIDE=1000` (or higher) on both daemons |
| Codex `usage limit` | Wait for reset or switch solver harness to `claude-code` |
| Evaluator silent after `Daemon started` for 30+ min | Stale `RUNNING` recovery blocking loops — fixed in #1422 (`recoverInFlight` non-blocking); upgrade client or clear stuck row |
| Solver skips eval opportunities | Expected — solver config has `roles: ["solver"]` only |
| `another … task is already in flight` | One restoration at a time per solver DB; wait or clear stuck `WAITING`/`RUNNING` in solver `jinn.db` |
| Docker / disk errors on eval | `docker info`, free disk, `jinn harnesses enable swe-rebench-v2-evaluator` |
| Password decrypt fails | Trim newline from keystore-password file |

## Pipeline-only proof (no LLM)

To verify packaging and on-chain delivery without spending solver LLM quota,
use the stub harness and a reference patch fixture. Not a substitute for this
smoke — document evidence separately. See `client/test/e2e/` and
`JINN_TEST_MODE` / `JINN_HARNESS_STUB_*` env vars in harness tests.

## Evidence to keep

For a smoke note or PR comment, retain:

1. Restoration `requestId`, `deliveryTx`, `claimTx`, solution manifest CID
2. Evaluation `requestId`, `deliveryTx`, `claimTx`, verdict manifest CID
3. Verdict `passed_match`, `score`, `passedCount`/`totalCount`
4. Solver harness + model (`claude-haiku-4-5-20251001`, etc.)

## See also

- [`swe-rebench-v2-public-testnet.md`](./swe-rebench-v2-public-testnet.md) —
  release-shaped dashboard proof
- [`held-out-regression-benchmark.md`](./held-out-regression-benchmark.md) —
  evaluator disk + held-out slate
- [`testing.md`](./testing.md) — automated test tiers
