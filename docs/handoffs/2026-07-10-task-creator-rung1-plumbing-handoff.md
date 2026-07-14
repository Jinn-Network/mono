# Handoff — Task Creator rung 1 plumbing proof (commit-echo harvest)

**Date:** 2026-07-10  
**Branch:** `feat/task-creator-v0` (PR [#1485](https://github.com/Jinn-Network/mono/pull/1485))  
**Spec:** `spec/2026-07-08-task-creator-v0.md` §5.2 (D4 plumbing proof)  
**Status:** Rung 1 **plumbing verified** on operator hardware. The subsequent
G0b public-repository substrate and differential-admission interfaces are
implemented, but the first real Jinn empirical receipt has not yet been
produced. Do not represent fixture, Anvil, or parser-contract coverage as a
Jinn source-derived or public-testnet success.

---

## Differential-admission update (2026-07-12)

The public-repository coding adapter now has a hardened differential-admission
contract: each target path needs two stable broken and two stable fixed runs,
with a non-empty F2P set and receipt/environment/parser bindings. This is a
trust-boundary implementation update, not proof that the real Jinn change has
been empirically graded.

### Reviewed real Jinn source

| Field | Value |
|---|---|
| Repository | `Jinn-Network/mono` |
| Base commit | `ae8093a8848e70e581f46d66dcdb56789c0808a3` |
| Fix commit | `ef9608876511b4dff000cda1537ff7c1a227677d` |
| Instance ID | `Jinn-Network__mono__echo-ef9608876511` |
| Targeted regression paths | `client/test/daemon/daemon-recovery-nonblocking.test.ts`; `client/test/harnesses/engine/recovery.test.ts` |

`5b76bade…` is the historical documentation-only merge commit. It remains
useful only as a Vitest JSON parser-contract fixture and must not be used for
Jinn empirical evidence, admission, minting, or a network-proof claim.

### Actual proof status

No signed evaluator environment specification, real receipt, receipt hash, or
receipt CID exists for the reviewed source. The fresh archive-export Docker
integration passed on 2026-07-13, so archive export/import plumbing is no
longer the observed local blocker; it is still only test coverage and did not
create a signed Jinn image or any proof artifact.

The current operator recheck found these immediate proof prerequisites missing:
the expected `$HOME/secure/jinn-environment-publish.json` configuration file
(which must name the IPFS registry and external signer), and
`JINN_TASK_CREATOR_JINN_APPROVED_ATTESTERS`. With no publication config, there
is no external signer command to validate or invoke. A Docker GHCR credential
configuration is present, but that alone cannot publish, sign, or verify this
proof. Therefore publication, receipt generation, offline verification, and
the operational receipt-bound Anvil command were not attempted.

Separately, `JINN_TASK_CREATOR_IPFS_GATEWAY_URL` is unset. It is a later
mint/network-preflight and network-wrapper prerequisite, not a blocker for
environment publication, receipt generation, offline verification, or the
local receipt-bound Anvil lifecycle. There is no real source-derived F2P/P2P
evidence and no Jinn public-testnet success.

The local receipt command deliberately requires a structurally valid,
EIP-191-signed environment specification available at a local path and a
writable output location:

```sh
cd client
yarn task-creator:jinn-differential-e2e \
  --environment-spec /secure/jinn-signed-environment.json \
  --approved-attester '0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222' \
  --output /secure/jinn-differential-receipt.json

# Docker-free: after a real receipt was generated, re-derive and verify every
# source, patch, environment, parser, semantic, and command binding.
yarn task-creator:jinn-differential-e2e \
  --verify /secure/jinn-differential-receipt.json \
  --environment-spec /secure/jinn-signed-environment.json \
  --approved-attester '0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222' \
  --expected-receipt-hash "$JINN_TASK_CREATOR_EXPECTED_RECEIPT_HASH"
```

It is not meaningful to run this command, or receipt verification, until a
real signed environment specification exists; `--verify` additionally requires
a real generated receipt and its independently known canonical SHA-256 hash.
Both modes also require an externally approved `operatorSafe:signer` pair via
`--approved-attester`. It is an explicit proof-policy input, not inferred from
the self-signed environment artifact: the command verifies that the signed
environment uses the exact `resolveJinnMonoRecipeV1(baseCommit)` provider,
recipe hash, and test-command template before it accepts that pair. No default
attester is trusted, so a missing approval fails closed.
The later network/factory wrapper additionally requires the operator's IPFS
gateway and preserves the approved pair plus signed-environment binding in its
secret-free handoff document. It re-fetches and applies the same canonical
Jinn policy immediately before it starts the external runner.
Set `JINN_TASK_CREATOR_EXPECTED_RECEIPT_HASH` to that exact
`sha256:<64-lowercase-hex>` value before invoking the command.
The generation mode creates the receipt at the supplied output path after its
eight Docker runs; `--verify` is Docker-free and does not publish. It rejects
`--output` and `--ipfs-registry` so a verification invocation cannot generate
or publish. `--ipfs-registry` is an explicit optional publication step for
generation only. Environment and receipt publication, with matching CIDs and
hashes, are later mint/network prerequisites. Test fixtures with
`bafy-test-only-*` CIDs or mock signatures are contract coverage only and are
not substitutes.

Only after generation and the offline verification above both succeed, run the
receipt-bound lifecycle command using the exact public values returned by
generation. This writes local lifecycle evidence; it is **not a second
empirical Docker result**. The Docker differential-admission receipt remains
the empirical result.

```sh
yarn task-creator:jinn-differential-anvil-e2e \
  --environment-spec /secure/jinn-signed-environment.json \
  --environment-cid '<environmentCid returned by publication>' \
  --receipt /secure/jinn-differential-receipt.json \
  --receipt-cid '<receiptCid returned by generation>' \
  --expected-receipt-hash '<receiptHash returned by generation>' \
  --approved-attester '<operatorSafe>:<signer>' \
  --evidence-output /secure/jinn-receipt-bound-anvil-evidence.json
```

Do not substitute a fixture CID, mock signature, or placeholder SHA. The command
first verifies the canonical signed environment, receipt bytes, environment
CID, receipt CID, receipt SHA-256, approved attester, recipe, and source
bindings; only then does it start Anvil and write its evidence.

### Fresh local verification

These commands were run with Node 24. Operators should provide Node 24 through
their project-supported runtime manager or a system `PATH`; the developer-local
runtime cache used for this verification is not an operational prerequisite:

| Command | Result |
|---|---|
| `cd client && yarn typecheck` | exit 0 |
| `cd client && yarn vitest run test/task-creator/environment/{adapters,contracts,github,publication,publish-cli}.test.ts test/task-creator/jinn-differential-proof.test.ts` | exit 0 — 6 files, 69 tests passed |
| `cd client && yarn task-creator:harvest-e2e` | exit 0 — 1 test passed |
| `cd client && yarn task-creator:public-repo-e2e` | exit 0 — 18 tests passed |
| `cd client && yarn task-creator:public-repo-anvil-e2e` | exit 0 — 1 file, 13 tests passed |
| `cd client && JINN_TEST_DOCKER_ARCHIVE_EXPORT=1 yarn vitest run test/task-creator/environment/archive-export.integration.test.ts` | exit 0 — 1 file, 1 test passed |
| `cd client && yarn test --no-file-parallelism --maxWorkers=1` | exit 0 — 709 files / 6,147 tests passed; 7 files / 24 tests skipped; 526.07s |

The package's default `test` script is `yarn build:sdk && vitest run`.
Vitest 4.1.8 exposes `--no-file-parallelism` and `--maxWorkers`; the serialized
command above disables file concurrency and limits workers to one, avoiding the
known concurrent Hardhat `compile-cache.json.tmp` rename race. This green run
is not evidence of a Docker image, signed environment, real receipt, or public
testnet grade. There is no documentation-test harness in this repository; the
package command and this receipt prerequisite were manually reviewed.

### Public-testnet operational gate (manual; not run)

The runbook requires a valid local Docker receipt and a green Anvil lifecycle
before an operator explicitly opts in to public testnet. This is an operational
gate, not a programmatic guarantee. The later mint/network operation requires
all of the following:

1. a digest-qualified, Linux/amd64 image and its published, EIP-191-signed
   environment specification;
2. the exact canonical receipt file, its matching SHA-256 hash, and its
   published IPFS CID;
3. configured RPC, registry/IPFS, and funding credentials; and
4. three distinct configured operator identities: minter, solver, and
   evaluator.

The external network runner must record the task, environment, receipt,
artifact, deliveries, verdict, and corpus references. Missing any item is a
blocker, not a partial success.

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
  "repos": [{ "path": "/path/to/clone", "repo": "owner/repo" }],
  "sources": ["commits"]
}
```

`sources` (Task 9) selects which harvest sources the loop mines each tick — defaults to `["commits"]`; add `"sessions"` to also drain locally-captured task-creator sessions (needs `mineableTraces.consent: "retain_local"`). Env: `JINN_HARVEST_SOURCES` (comma-separated).

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
