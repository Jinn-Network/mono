# Handoff — Task Creator rung 1 plumbing proof (commit-echo harvest)

**Date:** 2026-07-10  
**Branch:** `feat/task-creator-v0` (PR [#1485](https://github.com/Jinn-Network/mono/pull/1485))  
**Spec:** `spec/2026-07-08-task-creator-v0.md` §5.2 (D4 plumbing proof)  
**Status:** Rung 1 **plumbing verified** on operator hardware. Not yet useful at scale.

---

## What shipped

End-to-end commit-echo harvest loop wired into the production daemon:

| Layer | What |
|---|---|
| **Miner** | `createGitCommitEchoDeps` — real `git` subprocess adapter (`_swe-rebench-v2-commit-echo-git.ts`) |
| **Orchestration** | `buildCommitEchoMintCandidate` → empirical F2P/P2P → `admitBuiltMintCandidates` (`_swe-rebench-v2-harvest.ts`) |
| **State** | `harvest-state.json` per-repo cursor + rejected cache |
| **Daemon** | `HarvestLoop` in `daemon/harvest-loop.ts`; config `harvest.*` + env `JINN_HARVEST_*` |
| **Mint path** | IPFS artifact publish + `hf_dataset` backfill on admitted rows |
| **Grading** | `RoutingTaskRowFetcher` resolves minted rows from `ipfs://` artifacts |
| **Economics** | `syntheticClaimBlocked` (#1493), complexity-weighted escrow on minted posts (#1494) |

### Verification evidence

| Check | Command / artifact |
|---|---|
| Orchestration (mock Docker/IPFS) | `yarn task-creator:harvest-e2e` |
| Live (real Docker + IPFS) | `yarn task-creator:harvest-e2e-live` → `~/.jinn-client/swe-rebench-v2/harvest-e2e-live-result.json` |
| Daemon boots harvest loop | `[main] harvest loop enabled: N repo(s)` in daemon log |
| Admitted instance (live) | `probabl-ai__skore__echo-561ff586b4dd` |
| Published CID (live) | `bafkreie6w7poxvvl5ytznssaoqpnqyjmwzskcsytkglbetc6tibtxboec4` |

### Bugs fixed during verification

1. **Empirical F2P dead** — `PythonEvalRunner` returned only `from_fail_to_pass` / `failed_from_pass_to_pass` intersections. With empty expected sets (empirical mode), both were always empty. Fixed: use `passed_actual` / `failed_actual` from the upstream report when present (`eval-runner.ts`). **Requires upstream `eval.py` `build_report_item` to emit those fields** — patch applied locally at enable time; harness `onEnable` clone should carry this forward (see follow-on #1).
2. **Root commit crash** — `isFixShapedCommit` threw on root commits when harvest cursor was empty. Fixed: return `false` for commits with no parent.

---

## What this rung actually does (honest)

- Mines **fix-shaped commits** from **operator-configured local git clones**.
- Maps each candidate to a **scorable SWE-rebench benchmark instance** in the same repo (for Docker image + `install_config`).
- Derives F2P/P2P empirically (double Docker run), admits through gold + discrimination, publishes minted-row artifact to IPFS.
- Does **not** clone repos for you — `harvest.repos[].path` must point at an existing checkout you keep updated (`git fetch`).
- Does **not** post on-chain — generator union + launched SolverNet with `generatorEnabled: true` is a separate operator step (not verified in the live run; config was evaluator-only).

The live e2e used a **synthetic fix commit** (pool gold+test patches replayed at `base_commit`) to prove the pipeline. Real operation scans **new upstream commits** after the harvest cursor — same repos, new instance IDs, not duplicate HF rows.

---

## Hard limits today (why it's not useful yet)

| Limit | Code / behavior |
|---|---|
| **Benchmark repos only** | `findSourceInstanceForRepo` requires a scorable instance in `validated-pool.json` for the same `owner/repo`. No pool row → harvest rejects with `no admitted source instance for repo`. |
| **Pre-built Docker images only** | Empirical + admission reuse `image_name` from the source HF row. No image build for unknown repos. |
| **Operator brings clones** | No daemon-managed mirror, no `git clone` / `git fetch` in harvest loop. |
| **Full-suite test_cmd** | Source row `test_cmd` runs entire pytest suite per empirical run (~4–20+ min/instance on arm64). No targeted test scoping from commit diff. |
| **Public lookup contamination** | Gold is a public GitHub commit (spec §5.2 known limitation). Plumbing proof only. |

---

## Follow-on: expand to any public repo

**Goal:** Mint gradeable tasks from fix commits on **any public GitHub repo**, not only repos already in the SWE-rebench validated pool.

This is aligned with spec **D5** (v0 publishes public-repo tasks only) and §5.6 destination framing — but requires new infrastructure the plumbing proof deliberately skipped.

### Work packages (suggested sequencing)

#### 1. Upstream eval harness — ship `passed_actual` / `failed_actual`

- **Why:** Empirical F2P/P2P depends on it; local operator patch is not durable.
- **Where:** `SWE-rebench/SWE-rebench-V2` `scripts/eval.py` `build_report_item`, or pin + patch in `SweRebenchV2EvaluatorHarness.onEnable`.
- **AC:** `yarn task-creator:harvest-e2e-live` passes on fresh `jinn harnesses enable swe-rebench-v2-evaluator` without manual upstream edits.

#### 2. On-demand eval image for `repo @ base_commit`

- **Why:** Removes dependency on pre-existing benchmark instances / `swerebench/sweb.eval.*` images.
- **Options (pick in design spike):**
  - Extend SWE-rebench image builder for arbitrary public repos at a pinned commit.
  - Lightweight “generic python repo” image + `install_config` inferred from repo (pyproject/setup.py).
  - Reuse swe-smith env-construction machinery pointed at commit-echo targets (spec §5.3 note — machinery yes, dataset no).
- **AC:** Admit a minted instance for a public repo **not** in `validated-pool.json` with a freshly built image + pinned digest.

#### 3. Remove `findSourceInstanceForRepo` gate (replace with bootstrap path)

- **Why:** Harvest currently cannot see repos outside the benchmark pool.
- **Shape:** When no scorable source exists:
  - Build/bootstrap image (WP2).
  - Infer or default `install_config` + `log_parser` from repo language.
  - Run empirical + admission without an HF source row.
- **Keep:** Public-repo gate (`assertPublicRepoForPublish`), repo denylist, held-out repo key check (spec §11).

#### 4. Operator ergonomics — repo mirrors (optional but high leverage)

- **Why:** Harvest config today is raw filesystem paths; operators won't maintain these by hand at scale.
- **Shape:** `harvest.repos[]` accepts `{ repo: "owner/name" }` without `path`; daemon or sidecar maintains `~/.jinn-client/harvest-repos/<slug>/` with periodic `git fetch`.
- **Not in scope for plumbing proof** — explicit follow-on `feat`.

#### 5. Targeted empirical eval (performance)

- **Why:** Full-suite `test_cmd` from benchmark rows makes harvest unusably slow.
- **Shape:** Scope `test_cmd` to files touched in fix commit + `test_patch` (from git diff heuristic or `test_patch` split).
- **AC:** Empirical derivation for a typical fix completes in <5 min on arm64.

#### 6. Generator posting + on-chain loop

- **Why:** Plumbing proof stops at `minted-pool.json` + IPFS; tasks don't reach the marketplace without a launched generator SolverNet.
- **AC:** Harvest-admitted minted instance appears in launcher / `posted_tasks` with `syntheticProvenance` + weighted escrow; evaluator grades a solver delivery.

### Suggested GitHub issues

| Issue | Shape | Priority |
|---|---|---|
| Upstream eval `passed_actual` in harness enable | `fix` or `chore` | P1 — blocks all empirical mining |
| Arbitrary public-repo image bootstrap | `spike` → `feat` | P1 — core expansion |
| Harvest bootstrap path (no source instance) | `feat` | P1 — depends on spike |
| Daemon-managed harvest repo mirrors | `feat` | P2 |
| Targeted empirical test_cmd | `feat` | P2 |
| Harvest → generator on-chain e2e | `test` / `feat` | P2 |

### Non-goals for the expansion PR

- Private-repo publication (D5 deferred — image disclosure controls).
- jinn-mono self-mining (`jinn-repo-extract.ts` is a separate pool shape).
- Hunk-subset echo / trace mining (rung 2 — spec §5.3).
- Lookup tripwire / distillation lineage (already stubbed; enforcement is rung-1 yield work).

---

## Operator quick reference

```json
"harvest": {
  "enabled": true,
  "intervalMs": 3600000,
  "limitPerRepo": 3,
  "publish": true,
  "repos": [{ "path": "/path/to/clone", "repo": "owner/repo" }]
}
```

```bash
cd client
yarn task-creator:harvest-e2e          # CI-safe orchestration proof
yarn task-creator:harvest-e2e-live       # real Docker + IPFS (needs clone + validated pool source)
yarn build && node dist/bin/jinn.js run  # daemon with harvest.enabled in config
```

Runbook: `docs/runbooks/harvest-e2e-smoke.md`

---

## Files touched (this handoff tranche)

- `client/src/daemon/harvest-loop.ts`
- `client/src/solver-types/_swe-rebench-v2-commit-echo-git.ts`
- `client/src/solver-types/_swe-rebench-v2-harvest.ts`
- `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts`
- `client/scripts/harvest-e2e-live-verify.ts`
- `client/test/solver-types/task-creator-harvest-e2e.test.ts`
- `docs/runbooks/harvest-e2e-smoke.md`
