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

`sources` defaults to `["commits"]`; set `["commits", "sessions"]` (or `["sessions"]` alone) to also mine locally-captured task-creator sessions from the mineable-trace store (needs `mineableTraces.consent: "retain_local"`).

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
