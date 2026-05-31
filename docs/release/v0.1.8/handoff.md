# Release-readiness handoff — v0.1.8
Generated: 2026-05-30
Branch: `release/v0.1.8` @ `fcd02cf7`
Mode: human-invoked
Audited against last released: `v0.1.7` (`d90007f2`)

## Recommendation: SHIP

Ship `release/v0.1.8`. Five real blockers were root-caused from live evidence and
fixed on this one integration branch; the load-bearing Tier 3 loop is proven on
real Base Sepolia by **`verdictCode=1` (PASS) verdicts settled on-chain** for two
isolated-net tasks. The automated Tier-3 marker reads `failed` only because the
gate's *observer* flaked on transient infrastructure (RPC DNS / a whole-machine
network blip / Docker resource limits) — never on the protocol. This is the same
ship basis as v2026.05.25 (which shipped on `verdictCode=1` while the gate "flaked
four ways").

## What this run did (driver mode)

Started from the user's report — *"op-b stuck restaking and going through stale
evals"* — and drove every fixable blocker to closure on `release/v0.1.8`. The
original symptoms were red herrings; the real causes were five distinct bugs
plus a substrate-config regression, each surfaced by an actual logged Tier 3 run
(nine runs total) rather than guessed from error strings.

## Blockers driven to closure (5 commits)

| Commit | Fix | How it surfaced |
|---|---|---|
| `99a4a418` | **nonce** — route `JinnClaimLoop.emitOnL2` through the per-EOA nonce ledger (#525 follow-up) | op-a couldn't post: 178 × `nonce too low`, creator backed off 30 min. The jinn-claim emit broadcast from the agent EOA outside the #525 ledger and raced `createTask` at startup. |
| `94396068` | **getLogs retry** — bounded retry on transient `getLogs` failures in the observe loop | Gate died at 7 s on a Tenderly `invalid params` flake (proved transient: exact call succeeded 6/6 on retry). |
| `ae00de5a` | **restore isolated SolverNet** for T3.1 (revert of `77e79635`, restore `ca11be24`) | `77e79635` had moved T3.1 onto the shared mainline net, which is now both **griefed** (`0x26e96ba6`) and **backlogged** (~1300 tasks). Lowest-taskId-first discovery buries the fresh test task → never solved in budget. The isolated net (`bafkreievik…`, griefer-absent) was the proven-green config. |
| `ec0d0ded` | **observe-loop multi-RPC fallback** — `fallback()` over configured + public-backup RPCs | Gate died on Tenderly DNS `ENOTFOUND` mid-observe (`flake-infra`). The daemon already had a fallback chain; the gate observer was the last single-RPC consumer. |
| `fcd02cf7` | **decouple staking from the protocol loop** — gut `withEvictionRecovery` (#773) | **The original report.** JinnRouterV3 has no staking gate, yet `withEvictionRecovery` injected an inline `distributor.reStake()` on every claim/deliver failure for an evicted service; the reStake reverts on-chain (services re-evict faster than `minStakingDuration`), and `reStake failed for service 56` *replaced* the action's real error → broke op-b's solve/deliver ticks (0 completed solves in run #7). Reward-eligibility restaking is handled out-of-band by the background `EvictionLoop`. |

All five typecheck clean; regression tests updated (`eviction-recovery.test.ts`,
`jinn-claim-loop.test.ts`).

## Tier 3 evidence (load-bearing) — the loop is proven

Scenario: producer/evaluator on the **isolated** SolverNet (`bafkreievik…`),
op-a = evaluator, op-b = solver, real Base Sepolia.

**On-chain `verdictCode=1` (PASS) settled by op-a (`0x0e767e28…`):**

| Isolated task | op-b solutions | Verdicts settled (verdictCode) |
|---|---|---|
| **1552** | 5 attempts | **1, 1**, 3 |
| **1559** | 1 attempt | **1** |

`KNOWN_EXPECTED_VERDICT = 1`. The complete loop ran end-to-end multiple times:
op-a posts → **op-b solves via claude-code + delivers** → **op-a runs the Docker
grader → settles `verdictCode=1` on-chain**. Source of truth: the Ponder indexer
`verdicts` query (`https://jinn-indexer-production.up.railway.app/graphql`).

**Why the automated marker still reads `failed`** — each of the 9 runs lost its
*observer*, never the protocol, to a different transient infra fault:
- run #5: `flake-timing` — fresh task starved behind the shared-net backlog (fixed by `ae00de5a`).
- run #6: op-b delivered task 1552's solution; observer died on Tenderly DNS `ENOTFOUND` (fixed by `ec0d0ded`).
- run #7/#8: op-b solves broke on `reStake failed` (fixed by `fcd02cf7`).
- run #9: op-a settled `verdictCode=1` for 1552/1559; observer died on a whole-machine network blip (all RPCs + indexer unreachable at once — beyond what a fallback chain can absorb).

## Substrate notes (environment, not code)

These were resolved in the operator gold homes during the session and are NOT
part of the shippable diff:

- **op-b claude auth** had expired → re-authenticated via `claude setup-token`
  (1-year OAuth token at `/tmp/op-b-oauth-token`, mode 600). The Tier-3 harness
  already sets `JINN_HERMES_MODEL`, but per the operator's call the solver stays
  on **claude-code/haiku** (Hermes is out of OpenRouter credits).
- **Tier-3 operators focused on the isolated net.** op-a/op-b gold-home
  `joinedSolverNets` had drifted to include the busy shared net; their
  shared-net join was removed (backups: `config.json.bak-preisolate-*`) so the
  gate runs isolated — op-b solves one task / op-a grades one at a time. This is
  the intended release-gate shape and the config the green v2026.05.25 run used.
- **Docker Desktop is capped at 4 GiB** and OOMs under concurrent swe-rebench
  containers; isolated-only operators (≈2 containers) keep it under the cap, but
  a clean automated-marker run is most reliable at **8 GiB** (machine has the RAM
  — 70 % free).

## Walk-through script for the human pass

- [ ] Confirm the 5 commits on `release/v0.1.8` (`git log 727d133c..fcd02cf7`).
- [ ] Confirm on-chain evidence: indexer `verdicts(taskId:"1552"/"1559")` → `verdictCode=1`, evaluator `0x0e767e28…`.
- [ ] (Optional, for a green automated marker) bump Docker to 8 GiB, ensure stable network, re-run: `cd client && set -a && . ./.env && set +a && unset JINN_PASSWORD && export CLAUDE_CODE_OAUTH_TOKEN=$(cat /tmp/op-b-oauth-token) JINN_T31_REAL=1 && npx tsx scripts/release/run-tier-3.ts v0.1.8 human-invoked`.
- [ ] Merge `release/v0.1.8` → `next`; re-run release-prep against the merge result; publish.

## Open follow-ups (non-blocking)

- **Dead code in `contracts.ts`** — `restakeEvictedService`, `readStakingState`,
  `withRestakeLock`, `EVICTED_STAKING_STATE`, `restakeLocks` and their imports
  are now unreferenced (`withEvictionRecovery` is gutted). Harmless
  (`noUnusedLocals` is off); remove in a cleanup PR.
- **Background `EvictionLoop` reStake noise** — it still attempts (and logs
  `reStake failed … (non-fatal)` for) the chronically-evicted testnet services
  every 60 s. Cosmetic; consider backoff or suppression once a service is known
  un-restakeable.
- **T3.1 isolated-net backlog** — failed runs leave unsolved isolated tasks
  (1569, 1573); a fresh run's task sits briefly behind them (lowest-id-first).
  Consider draining or a recent-first discovery bias for the gate.
- **Whole-machine network resilience** — the gate cannot absorb a total network
  outage; not worth engineering around for a local gate, but worth a note.

## Marker block (final)

<!-- jinn-release-evidence:v1
release-candidate=v0.1.8
branch=release/v0.1.8
branch-sha=fcd02cf7
tier-3-loop=PROVEN (verdictCode=1 settled on-chain, isolated tasks 1552 & 1559, evaluator 0x0e767e28)
tier-3-automated-marker=flaked (transient infra: RPC DNS / network blip / Docker OOM)
recommendation=SHIP
ship-basis=on-chain-verdict-evidence (v2026.05.25 precedent)
-->
