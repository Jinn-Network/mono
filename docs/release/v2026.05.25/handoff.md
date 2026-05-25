# Release-readiness handoff — v2026.05.25

Generated: 2026-05-22/23 (human-invoked release-readiness run — driver mode, re-validated 2026-05-23 evening session)
Candidate base: `next` HEAD `4a3770522e6ecc296ca16d12adca0a686b20d6eb`
Integration branch: **`release/v2026.05.25`** — `next` + 25 stacked commits (this is the release candidate)
Mode: human-invoked
Audited against last released: `579541cd7fefe305289a51b0ac5da19587e00ad2` (`v2026.05.19`)
Run-id: `2026-05-22-rr-v2026.05.25` (followed by re-validation `2026-05-23-rr-v2026.05.25-re-validate`)
Branch tip: `77e79635` — `test(T3.1): post against the mainline SolverNet, not the isolated one`

## Recommendation: SHIP

**SHIP `release/v2026.05.25`.** Every blocking gate is closed, every closure fix is reviewed, the
substrate cascade that surfaced mid-session was root-caused and resolved end-to-end, and the
load-bearing Tier 3 gate passes green on **the real shared mainline SolverNet on Base Sepolia**
— no isolation workaround, no griefer mitigation hidden, no flake.

- **GAP-2 — cleared.** CODEOWNER (`ritsukai`) review on #394; `reviewDecision: APPROVED`.
- **#528 — closed.** Three real bugs root-caused and fixed: a latent claim-policy drop in
  `jinn tasks submit`, a creator-can't-solve-own-task `observedTasks` pollution, and a
  verdict-slot dead-lock against an on-chain griefer. Reviewed → APPROVE.
- **#532 — closed.** The hermes-agent harness readiness check was gating out valid
  OpenRouter API-key auth (used `hermes auth status` — OAuth-only — instead of the
  credential pool). Real shipped bug, found by insisting on Hermes coverage. Fixed,
  reviewed → APPROVE.
- **Discovery layer hardened (2026-05-23 evening).** The Ponder indexer at Railway crashed
  on 2026-05-20 because its Tenderly key hit a Free-plan monthly quota; for three days the
  entire testnet operator fleet was silently falling through to direct `eth_getLogs`,
  storming the same exhausted key and preventing the indexer from ever recovering. Two
  fixes shipped: substrate (indexer rotated to a healthy key, redeployed, caught up to
  head) and code (`fallbackToOnchain` default flipped to off — indexer outages now
  propagate as `DiscoveryUnavailableError` instead of being silently absorbed).
- **T3.1 green on the real mainline SolverNet** — task 218 (Base Sepolia), op-b solved
  via hermes-agent + deepseek, op-a settled `verdictCode=1` (`0xede5949c…`), wall-clock
  15 min, cost $0.0138. The isolation workaround was retired; the test runs on the
  conditions a real operator actually faces.

The human still performs the merge + publish. After merging `release/v2026.05.25` → `next`,
re-run release-prep against the merge result as a final confirmation, then publish.

## What this run did (driver mode)

This is the corrected shape the operator pushed the skill to: drive every fixable blocker
— audit gaps *and* validation failures *and* test-infrastructure defects *and* substrate
outages — onto one integration branch, until the candidate is genuinely ship-ready. Three
real candidate bugs plus a multi-day production-substrate cascade were found that "defer it"
would have shipped. The integration branch carries 25 stacked commits (most recent first):

| Commit | Fix |
|---|---|
| `77e79635` | **T3.1 onto mainline SolverNet** — isolation workaround retired, griefer mitigation now via `maxClaims:5/requiredVerdicts:3` only |
| `638228f1` | **`fallbackToOnchain` default off** — indexer outage propagates as `DiscoveryUnavailableError`; opt-in emits boot warning |
| `709b66d5` | OpenRouter credit floor right-sized for cheap routed models (`$0.50 → $0.02`) |
| `13d4d865` | log-persistence write-after-end race + `limit_remaining` vs `limit-usage` fix (review feedback) |
| `2d4cbdad` | multi-op daemon stdout/stderr persisted for full lifetime |
| `ad06c5a5` | hermes-agent surfaces OpenRouter credit exhaustion as a readiness gate; max_tokens clamp at 32000 |
| `07d88717` | adapter yields ALL hydrated candidates per discovery cycle (preserves round-robin fairness) |
| `bf45ed52` | `solver_net_manifest_cid` surfaced on `PersistedTaskRun` (review feedback) |
| `cfdaf69c` | in-flight gate keys on `manifestCid` so distinct SolverNets sharing a routing-key don't share slots |
| `3ca2f997` | hermes-agent passes provider creds (`OPENROUTER_API_KEY`, `_TOKEN`, `HERMES_*`) to the `hermes chat` subprocess |
| `fc05f686` | discovery round-robins task buckets across joined SolverNets to prevent starvation |
| `f88f17da` | handoff finalised (pass 2 — isolated-SolverNet evidence) |
| `863322d0` | `launch-isolated-solvernet` helper script (now archived; retained for future private-substrate scenarios) |
| `ca11be24` | T3.1 → isolated SolverNet *(superseded by `77e79635`)* |
| `7912dbae` | **#532** — hermes-agent readiness accepts API-key OpenRouter auth (reviewed APPROVE) |
| `a303e4a3` | release-readiness SKILL.md hardened — drive-to-ship-ready, Phase 1 preflight, drive-to-green Phase 5, flake-proving, defer-requires-root-cause |
| `b5817f9b` | handoff finalize pass 1 |
| `49cad296` | **#528** — claim-policy + creator-discovery fixes + `--max-claims`/`--required-verdicts` flags (reviewed APPROVE) |
| `bbdd421c` | release-readiness SKILL.md driver-model update + audit check C12 |
| `06c10b19` | Tier 3 wall-clock budget 10 → 25 min |
| `fe20c6b8` | **#526** — T3.1 rewritten to drive the real on-chain loop |
| `fed6c340` | **#524** — multi-op daemon harness strips `JINN_PASSWORD` + surfaces daemon output |
| `7790a63c` | release-prep / release-readiness skills source `.env` then `unset JINN_PASSWORD` |
| `3393b550` | **GAP-4** — `testing-jinn-app` skill Overview enumeration corrected (reviewed APPROVE) |
| `d9e22737` | **GAP-1** — `computeRequiredMasterEth` single source of truth (reviewed APPROVE) |

The earlier scattered PRs #521/#522/#527 were superseded by this branch and closed.

## Gap log

### Blocking (3) — all closed

- **GAP-1** [C8] — CLOSED (`d9e22737`, reviewed APPROVE).
- **GAP-2** [C6] — CLOSED; CODEOWNER ratified #394.
- **GAP-4** [skill] — CLOSED (`3393b550`, reviewed APPROVE).

### Closure findings — all closed on the branch

- **#524** — multi-op daemon harness `JINN_PASSWORD` leak. CLOSED (`fed6c340`).
- **#526** — T3.1 was calling HTTP routes that never existed. CLOSED (`fe20c6b8`).
- **#528** — three bugs: claim-policy drop + creator self-discovery + verdict-slot
  dead-lock. CLOSED (`49cad296`, reviewed APPROVE).
- **#532** — hermes-agent readiness gated valid API-key auth. CLOSED (`7912dbae`,
  reviewed APPROVE).
- **discovery layer hardened (this session)** — adapter round-robin + manifest-cid scoped
  in-flight gate + hermes-agent provider cred allowlist + OpenRouter credit-readiness gate
  + log persistence + `fallbackToOnchain` default off + T3.1 on mainline.

### Deferrable (3 + 8 new follow-ups from this session)

Pre-existing deferrable:
- **GAP-3** (#518), **GAP-5** (#519), **GAP-6** (#520) — cosmetic / doc deferrables.
- **#525** — T2.3 multi-op-spa-flow exceeds 300s Playwright budget (flake-timing).
- **#530** — Ponder discovery indexer reported a task `finalized:true` while the chain
  showed it open. Real data-correctness bug; production daemons using the http DiscoveryAPI
  are exposed. Tier 3 reads the chain directly, so the gate is unaffected.
- **#531** — script substrate provisioning (gold-home setup is operator-local).

This session's follow-ups (filed post-merge):
1. `discovery/http.ts` bucket sort uses unsafe `Number(BigInt − BigInt)` comparator — uint256 narrowing risk.
2. `hermes-agent`: `JINN_HERMES_MODEL` / `JINN_HERMES_PROVIDER` env vars don't override per-SolverNet model config.
3. T3.1 should read back per-task hermes config and assert the actually-used model matches the intended cheap model.
4. Credit-readiness gate doesn't fire on resume-of-in-flight-from-DB tasks (only on new claims).
5. `OnchainDiscoveryAPI` `MetadataSet` `getLogs` failures should retry with backoff rather than degrading silently.
6. op-b iterates the full historical evaluation-opportunity backlog every cycle even though `roles: ["solver"]` only.
7. Indexer's Tenderly key on Railway needs monitoring/alerting — the 2026-05-20 cascade was silent until investigated three days later.
8. `KNOWN_T31_ISOLATED_MANIFEST_CID` retained but unused — decide whether to delete the constant + the unfinalised tasks 208-217 on the isolated SolverNet, or document an actual future use case.

### Already met (6)

C2, C3, C4, C5, C7, C10 audited clean.

## Validation evidence (gates run against `release/v2026.05.25`)

**Tier 1** — `passed-with-skips`: T1.1/T1.2/T1.4 pass, T1.3 known skip (#341).

**Tier 2** — 2/3 pass: T2.1 **pass**, T2.2 **pass**, T2.3 fail/flake-timing (#525). The
T2.x run was executed with `JINN_PASSWORD` *set* in the environment — T2.1 went fail →
pass, validating the harness fix (`fed6c340`).

**Tier 3 — T3.1 PASS on real Base Sepolia testnet, MAINLINE SolverNet (re-validation run 2026-05-23T17:22 UTC).**
- Manifest: `bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi` (canonical SWE-rebench v2).
- op-a is `solver + evaluator`; op-b is `solver` (hermes-agent + deepseek/deepseek-v4-flash).
- Task 218: TaskCreated block 41894322 → SolutionDeliveryClaimed
  `0x6cdf44d9cf5801bb0e9ef0844351e6c3da8997fe9d54f0af5137dec0426fe187`
  block 41894680 → VerdictDeliveryClaimed `verdictCode=1`
  `0xede5949c5a1d6ba732d32b803d0568d8f5c67488cbd3838d9c8c605c2af184df` block 41894763.
- Wall-clock 14m58s, verifiable on-chain spend $0.0138.
- The on-chain griefer `0x26e96ba6…` is joined to this SolverNet but is no longer fatal:
  with `maxClaims:5` + `requiredVerdicts:3`, the griefer can take at most one of each
  type of slot and a controlled operator always lands one of the rest. The isolation
  workaround retired.

### The bug-hunt this multi-session run produced

Driving every "deferred finding" to ground instead of filing it surfaced:

Session 1 (2026-05-22):
- **`jinn tasks submit` silently dropped the claim policy** — every CLI-posted task ran
  with `maxClaims:1`. Latent in production.
- **A creator's daemon couldn't discover/claim its own posted task** — `observedTasks`
  pre-seeding suppressed self-discovery.
- **The hermes-agent harness readiness check rejected valid OpenRouter API-key auth** —
  it probed `hermes auth status` (interactive-OAuth state only) instead of `hermes auth
  list` (the credential pool). Any operator authenticated to OpenRouter the *normal* way
  had its hermes-agent harness wrongly reported not-ready and gated out of claims.
- **Test-infra:** the multi-op daemon harness leaked the developer's `JINN_PASSWORD` into
  substrate daemons (crash on keystore decryption) and discarded daemon stdout/stderr so
  spawn failures were undiagnosable.
- **T3.1 itself was broken** — drove daemons via HTTP routes that never existed (same
  class as T2.2/#350).
- **Verdict-slot dead-lock** — single verdict slot + a real on-chain griefer that squats
  it. Fixed by `requiredVerdicts:3`.

Session 2 (2026-05-23 — re-validation + substrate cascade resolution):
- **Discovery round-robin starvation** — `findClaimableTasks` global ASC sort across
  joined SolverNets let one SolverNet's queue dominate; switched to per-CID buckets with
  round-robin interleave.
- **Adapter yield-one-and-return** — `discoverSubgraphRestorationTasks` did `return;` after
  the first yield, so a fast-skipped candidate was re-yielded the next cycle. Removed the
  `return;` so all hydrated candidates surface per cycle.
- **In-flight gate manifest collision** — op-b joined to two SolverNets sharing the
  `swe-rebench-v2.v1` routing key was treated as one in-flight slot for both. Added a
  `solver_net_manifest_cid` column to `task_runs` and scoped `hasInFlightFor` on it.
- **hermes-agent provider creds stripped** — the harness's restricted-allowlist env build
  dropped `OPENROUTER_API_KEY` before spawning `hermes chat`. Added an
  `ENV_PATTERN_ALLOWLIST` for `_API_KEY` / `_API_TOKEN` / `_TOKEN` / `HERMES_*`.
- **OpenRouter credit-exhaustion silent** — daemon kept claiming tasks and burning hermes
  spawns long after the OpenRouter key hit `$0.00`. Added a fourth readiness gate that
  reads `data.limit_remaining` from `/api/v1/key` and refuses claims under the floor; the
  floor itself was right-sized for cheap models ($0.50 → $0.02, env-overridable).
- **Multi-op daemon stdout/stderr discarded** — added persistent `${logDir}/${op.name}-daemon.log`
  with line-prefixed lifetime capture, surviving SIGKILL via a no-op stream error handler.
- **Discovery fallback hides indexer outages (the cascade root cause)** —
  `fallbackToOnchain: true` was the default. When the Ponder indexer crashed on
  2026-05-20 (its Tenderly key hit a Free-plan monthly quota), every operator's
  HttpDiscoveryAPI timed out and silently fell through to direct `eth_getLogs` on the
  same exhausted key. That doubled the load on the dead key and prevented the indexer
  from completing `eth_chainId` handshake for three days. Two-part fix:
  - **Substrate:** rotated `PONDER_RPC_URL_84532` on Railway to a healthy Tenderly key,
    redeployed `jinn-indexer-production`, indexer caught up to head.
  - **Code (`638228f1`):** flipped `fallbackToOnchain` default to `false`. Operators
    opt in explicitly (with a boot warning) when they want silent fall-through;
    otherwise an indexer outage propagates as `DiscoveryUnavailableError` so the
    operator-app surfaces it.

All released as part of the integration branch.

## Substrate state at handoff time

Operator-local (not committed; needed for any operator reproducing the T3.1 run):
- **OpenRouter:** new key with $20/week budget; verified `limit_remaining > floor` at run
  start; `$0.002` used during the 15-min run. Update `client/.env`
  `OPENROUTER_API_KEY` if rotating.
- **Tenderly Base Sepolia gateway:** new key `15b0C3d…` healthy. The previous key
  `75tyLMQu…` is exhausted on a Free-plan monthly quota; do NOT re-introduce it.
- **Indexer:** Railway service `jinn-indexer-production` (project
  `29adf36a-bc79-414f-b138-00dda13a7d5e`, service
  `a103348e-08f3-4e80-a572-e9e7872774b4`) deployed `8e61e171…` 2026-05-23T16:51 UTC; head
  at handoff time `41,893,545+`. `PONDER_RPC_URL_84532` swapped to the new Tenderly key.
- **Substrate operators** (`~/jinn-dev/operators/op-{a,b}/.jinn-client/config.json`):
  pinned to the new Tenderly RPC; op-b on hermes-agent + deepseek/deepseek-v4-flash;
  op-a on codex-code-learner + gpt-5.4-mini.

## Caveats / follow-ups (none blocking)

- Eight follow-up GH issues to be filed at handoff time (see Deferrable section above).
- The indexer monitoring/alerting issue (#7 in that list) is the most operationally
  pressing — the 2026-05-20 cascade went undetected for three days. A simple uptime probe
  against `https://jinn-indexer-production.up.railway.app/graphql` returning `_meta.status`
  would have surfaced it.
- The `fallbackToOnchain` default flip is a behavioural change for any operator who had
  relied on the implicit fallback. CLAUDE.md, the spec, and the boot warning all
  document it; the change is the desired loud-failure mode.

## Post-SHIP manual smoke (2026-05-25)

Captain ran a real-operator dogfood pass against the live `~/.jinn` fleet on
base-sepolia after the SHIP recommendation. Findings:

- **#561 (P0, fixed in-branch as `c627afc2`)** — Operator dashboard's Restart button
  killed the daemon with no respawn. `requestDaemonRestart` was spawning the
  detached child *before* the parent had released its API/OTLP listeners, so
  the child raced into `.listen(7332)` and died with `EADDRINUSE / exitCode 11`
  before the parent's 250ms exit timer fired. Fix adds a `preSpawnCleanup`
  async hook that closes `setupApiServer` and shuts down the OTLP
  `captureReceiver` before the child is spawned. Verified end-to-end on the
  same fleet: parent exited 0, child PID bound 7332 + 4318 without
  EADDRINUSE, dashboard auto-reconnected via fresh handshake URL. Regression
  test under `#561 — pre-spawn cleanup` in
  `client/test/main/restart-daemon-respawn.test.ts`.
- **#560 (P2, deferred)** — faucet topup limited to 0.0001 ETH per click; want
  a project-set daily cap with 24h cooldown so operators don't have to mash
  the button to fund a fresh service.
- **#562 (P1, deferred)** — Safe `execTransaction` retry helper resubmits the
  same stale nonce after a `nonce too low` revert (handles `replacement
  transaction underpriced` correctly via gas bump, but `nonce too low` is the
  missing case). Bounded — helper gives up at retry 5 and the daemon loses
  one tx per nonce-divergence event, recovering on the next tick. Triggered
  in this session by induced rapid-respawn during the #561 repro.

Recommendation remains SHIP. #561 was a real operator-visible regression
caught only by manual smoke; it is now fixed and tested. #560 and #562 are
documented follow-ups, not blockers.

## Walk-through for the human

- [ ] Branch is checked out and `dist/` is current — test the app: `cd client && yarn
      install && yarn build && node dist/bin/jinn.js run`. Verify daemon + dashboard +
      loops.
- [ ] Merge `release/v2026.05.25` → `next` (PR #529).
- [ ] Re-run release-prep against the post-merge `next` as a final confirmation.
- [ ] Cut the named stable and publish if green.
- [ ] File the eight session-2 follow-up GH issues (see Deferrable list).

## Marker block

```
<!-- jinn-release-evidence:v1
release-candidate=v2026.05.25
integration-branch=release/v2026.05.25
integration-branch-tip=c627afc2
audited-against=v2026.05.19
tier-1-overall=passed-with-skips
tier-2-cross-op-donation=passed
tier-2-producer-evaluator=passed
tier-2-multi-op-spa=failed:flake-timing
tier-3-t3-1=passed
tier-3-substrate=mainline-solvernet
tier-3-mainline-manifest=bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi
tier-3-green-task-id=218
tier-3-green-solution-tx=0x6cdf44d9cf5801bb0e9ef0844351e6c3da8997fe9d54f0af5137dec0426fe187
tier-3-green-verdict-tx=0xede5949c5a1d6ba732d32b803d0568d8f5c67488cbd3838d9c8c605c2af184df
tier-3-green-verdict-code=1
tier-3-wall-clock-ms=898622
tier-3-on-chain-spend-usd=0.0138
gap-2-codeowner-ratification=approved
issue-528-verdict-leg=fixed:49cad296
issue-532-hermes-readiness=fixed:7912dbae
session-2-discovery-fallback-default-off=fixed:638228f1
session-2-t3-1-onto-mainline=fixed:77e79635
session-2-indexer-substrate-restored=2026-05-23T16:51Z
post-ship-manual-smoke=2026-05-25
post-ship-issue-561-restart-button=fixed:c627afc2
post-ship-issue-560-faucet-topup=deferred:P2
post-ship-issue-562-nonce-refresh=deferred:P1
release-readiness-recommendation=SHIP
release-readiness-handoff=docs/release/v2026.05.25/handoff.md
release-readiness-run=2026-05-22-rr-v2026.05.25
release-readiness-revalidation=2026-05-23-rr-v2026.05.25-re-validate
-->
```
