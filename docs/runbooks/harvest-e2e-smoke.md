# Harvest end-to-end smoke (commit-echo)

Manual smoke for the daemon-resident harvest loop: local benchmark-repo clone → minted task → posted → gradeable.

## Automated orchestration proof (CI / local)

Before operator trial, run the chained integration test (real `git` fixture; mock Docker eval + IPFS):

```bash
cd client && yarn task-creator:harvest-e2e
```

This exercises: `runHarvestTick` → empirical F2P/P2P → `validatePoolInstances` admission → `uploadToIpfs` backfill → `loadMintedPoolTasks` → `RoutingTaskRowFetcher` → synthetic-claim + escrow eligibility inputs.

It does **not** pull eval images or hit a live IPFS gateway.

## Live operator proof (real Docker + IPFS)

After the orchestration test, run the live harvest verifier against a local clone
whose fix commit is aligned with a scorable benchmark instance (see
`client/scripts/harvest-e2e-live-verify.ts`):

```bash
# Example: probabl-ai/skore echo seeded from pool patches at
# ~/.jinn-client/harvest-repos/skore-e2e
cd client && yarn task-creator:harvest-e2e-live
```

Requires upstream `scripts/eval.py` to emit `passed_actual` / `failed_actual` on
report items (needed for empirical F2P/P2P derivation). Re-enable the evaluator
harness or pull latest upstream if empirical runs return `empirical-dead`.

Pass when the script prints `[harvest-e2e-live] PASS` and writes
`~/.jinn-client/swe-rebench-v2/harvest-e2e-live-result.json`.

## Session-echo borrowed-image live verify

Opt-in real-Docker check for `mineSessionEchoes` borrowing eval infra
(`image_name` / `install_config` / `test_patch`) from the first scorable
same-repo validated-pool instance (`findSourceInstanceForRepo`). Unit tests
mock `EvalRunner`; this script does not.

```bash
cd client && yarn task-creator:session-echo-live
```

Default mode `borrow-mismatch` seeds a session whose `acceptedDiff` is the gold
patch of a *different* same-repo scorable instance than the borrowed source.
Expected classification under the review hypothesis: `rejected:empirical-dead`.

Held-out / capability-slate denylist applies (`assertRepoAllowedForMint`).
`sympy/sympy` is held-out on current slates — mint refuses before Docker. Default
repo is `conan-io/conan` (mintable, ≥2 scorable instances on typical pools).
Override if needed:

```bash
JINN_SESSION_ECHO_LIVE_REPO=<owner/repo> yarn task-creator:session-echo-live
```

Pick any validated-pool repo with ≥2 scorable instances that is **not** on the
mint denylist.

Optional control:

```bash
JINN_SESSION_ECHO_LIVE_MODE=borrow-aligned yarn task-creator:session-echo-live
```

Keep the evaluator's default 20 GB free-disk floor. If the host is below it,
reclaim unused state before running; do not lower the floor merely to make this
verification fit. The floor exists because a single eval image has peaked at
about 12.6 GB of transient use.

### Prerequisites (same family as harvest live)

- Docker daemon (`docker info`)
- The Docker preflight is bounded to 20 seconds; an unresponsive daemon fails
  closed instead of leaving the verifier hung
- `jinn harnesses enable swe-rebench-v2-evaluator`. The verifier requires the
  current v2 enable contract: managed checkout path, pinned upstream metadata,
  current patch-bundle digest, and trusted-parser binding. A legacy or stale
  marker fails closed with the re-enable instruction before constructing the
  Python evaluator.
- Validated pool with ≥2 scorable instances for the target repo (default
  `conan-io/conan`) so mismatch can pick a donor gold patch
- Network for HF row fetch + eval image pull if missing
- arm64 hosts emulate `linux/amd64` images — expect multi-minute runs
- Disk: at least the default 20 GB free floor

### Pass / classify criteria

After preflight succeeds, the script writes
`~/.jinn-client/swe-rebench-v2/session-echo-live-result.json` and prints
`classification`. A Docker/precondition failure exits non-zero without
overwriting a prior result artifact; record that attempt as `infra-blocked` in
the findings:

| Classification | Meaning |
|---|---|
| `rejected:empirical-dead` | Hypothesis confirmed (default mismatch mode) |
| `admitted` under mismatch | **Red flag** — worse than hypothesized |
| `rejected:other` | Product/runner signal other than dead-mint — record `rejected[].reason` |
| `infra-blocked` | Docker/image/timeout/prereq — not product-red; still record findings |

Findings note: `docs/research/2026-07-22-session-echo-borrowed-image-findings.md`.

## Prerequisites

- `jinn harnesses enable swe-rebench-v2-evaluator` (upstream repo + Docker)
- Validated pool with at least one scorable instance for your target repo (`jinn solver-nets validate-pool swe-rebench-v2`)
- Local clone of a **public benchmark repo** that appears in the validated pool
- Docker running (`docker info`)

## Config

Add to `~/.jinn-client/config.json`:

```json
{
  "harvest": {
    "enabled": true,
    "intervalMs": 3600000,
    "limitPerRepo": 3,
    "publish": true,
    "repos": [
      {
        "path": "/path/to/your/clone",
        "repo": "owner/repo"
      }
    ],
    "sources": ["commits"]
  }
}
```

`sources` defaults to `["commits"]`. During Stage 2, configuring `"sessions"`
does not mine locally captured sessions: the loop reports
`sessions-source-parked-stage-2` and performs no session-source Docker, pool,
or publication work. `["commits", "sessions"]` still runs commit harvesting;
`["sessions"]` returns only the parked marker.

Or via env:

```bash
export JINN_HARVEST_ENABLED=1
export JINN_HARVEST_REPOS=/path/to/clone:owner/repo
export JINN_HARVEST_SOURCES=commits,sessions
```

## Run

```bash
cd client && yarn build && node dist/bin/jinn.js run
```

## Expected log lines

- `[main] harvest loop enabled: N repo(s), interval=...`
- `[harvest-loop] tick: discovered=... admitted=... rejected=...` (after a fix-shaped commit is found)
- `[harvest-loop] harvest_admitted` events in the operator store (dashboard activity)

## Verify grading path

1. Minted entries in `~/.jinn-client/swe-rebench-v2/minted-pool.json` carry `hf_dataset: "ipfs://..."` after publish.
2. Generator union posts tasks with `syntheticProvenance` and `syntheticEscrowInputs`.
3. Evaluator resolves rows via `RoutingTaskRowFetcher` (production harness `getFetcher()`).

## Pass criteria

- At least one commit-echo candidate admitted into `minted-pool.json`
- Published artifact CID back-filled on entries
- Generator posts a minted instance (check launcher tasks panel / `posted_tasks` store)
- Minter cannot claim own mint (`syntheticClaimBlocked` on engine path)
- Minted post delivery fee differs from flat mech rate when complexity inputs are present

Spec: `spec/2026-07-08-task-creator-v0.md` §5.2, §13.
