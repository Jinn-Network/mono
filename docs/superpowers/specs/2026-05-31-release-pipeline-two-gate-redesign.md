---
version: 1.0
date: 2026-05-31
author: opus + adrianobradley
status: proposed
supersedes-mechanism-of: docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md (the three-tier ladder this replaces with a two-gate determinism split)
relates-to: docs/engineering/handbook.md §Cadence, docs/runbooks/hotfix.md, DR-2026-05-20 (holistic release-review gate), #341 (Ponder spawn helper), #531 (substrate doctor), #592 (RPC fallback chain)
---

# Release pipeline: the two-gate redesign

The output of a full audit of the release process (e2e tests, release skills,
CI gates, cadence). This spec is the canonical target architecture for how Jinn
validates and ships a release. It does not change the **cadence** primitives
(`next` integration branch, canary-on-push, Monday named cut, `promote-main`
fast-forward, hotfix sub-flow) ratified in the handbook §Cadence — it changes
**what validates a release and where that validation runs**, replacing the
Tier 1/2/3 ladder and the hand-typed evidence marker.

## 1. Problem — the gates test the environment, not the product

The current release process is painful in a specific, diagnosable way: it
regularly blocks a release for *days*, the blocks are almost never the product
being broken, and the process that's supposed to catch production issues mostly
catches issues with *itself*.

Root cause: **fidelity sits in four bad places at once.**

1. **On the blocking developer path.** The expensive, high-fidelity gates
   (Tier 2/3) try to *be* production — real testnet, real agent spend, real
   RPC, multi-operator substrate copies. The reliability of the gate is the
   product of every external dependency's reliability; chain six flaky
   externals and the gate fails most of the time for reasons unrelated to
   whether the code regressed.
2. **On the operator's laptop.** Gates run on a human's machine with a sourced
   `.env`, so they inherit failure modes production never has — the
   `JINN_PASSWORD`-poisoning class (an inherited password decrypts substrate
   operators' keystores wrong, surfaces as `exitCode 50`, gets misclassified as
   "daemon not reachable").
3. **Flaky in a way that's conflated with product failure.** The
   v2026.05.25 run's triage precedent — "every auto-classified flake was a real
   bug" — is the tell: the bugs were in the *gate scaffolding* (substrate
   provisioning, RPC saturation, port conflicts), not the protocol loop. You
   can't tell "Tenderly rate-limited" from "the daemon regressed" without days
   of investigation.
4. **Run twice.** `release-readiness` runs the tiers on the operator's machine,
   produces a hand-typed marker, then `npm-publish.yml` re-runs Tier 1 at the
   publish guard because nobody trusts the marker. The trust model is even
   backwards: CI re-runs the cheap deterministic gate but *trusts a hand-typed
   string* for the three expensive functional gates that actually matter
   (`release-client-prepare`, `donation-consumption`,
   `app-first-testnet-acceptance`).

Secondary findings from the audit:

- **T1.3 (indexer round-trip) is a permanent skip stub** (#341) — indexer
  schema drift is caught by no automated gate, despite the 2026-05-23 substrate
  incident being indexer-related.
- **`e2e:daemon-harness` exits 0 when a harness API key is absent** — the
  harness-integration path can be entirely un-exercised while reporting success.
- **The real e2e suite never runs in CI** (`vitest.config.ts` excludes
  `test/e2e/**`); only `yarn test` runs on PRs.
- **Tiers grew by accretion**, not from a model of the regression surface, so
  they're scattered and overlapping (three separate fresh bootstraps; four
  overlapping loop tests).

The fix is not to make the blocking gate *more* real — that's what's killing us.
It is to **separate "does the code work" from "does the environment work," and
only ever block a developer on the first.**

## 2. Principle

> **CI proves the code is correct. The environment suite proves it works in the
> real world. The cut verifies both and promotes — it never re-runs either.**

Two gates, split by **determinism**, not by fidelity-vs-not. Each test runs
exactly once, in the one place it can run honestly, and its result is bound to a
commit SHA as machine-written evidence.

## 3. The two gates

### 3.1 Hermetic gate (CI, per-PR, blocks merge to `next`)

Deterministic, zero external dependencies → it *cannot* flake for infra
reasons → a red is always a real code regression.

- Real daemon code + **real contracts** — ours (JinnRouterV3, TaskCoordinator,
  activity checker) *and* the real OLAS Mech Marketplace — on a **pinned Anvil
  state snapshot** (see §4).
- **Local Ponder** spawned against the snapshot chain → a real indexer
  round-trip (closes the T1.3 stub, #341).
- The **deterministic** `prediction-v1-baseline` harness. This gate tests the
  *loop*, not the *agent* — bootstrap → claim → execute → deliver → settle →
  activity-counter → indexer round-trip.
- Adversarial marketplace conditions **provoked on real bytecode** (§5), not
  faked in a mock.
- Deterministic RPC-fallback test (mock returning 429/5xx) exercises the
  `fallback()` chain (#592) without a real provider.

This gate also owns **bootstrap-from-scratch** correctness (the 11-step
`FleetBootstrapper` flow), which is the flakiest, most RPC-hungry thing in the
current tiers. Moving it here, on a snapshot, removes the setup storm that
causes most multi-day blocks.

### 3.2 Environment suite (CI, real testnet, gates the cut)

The load-bearing, high-fidelity test — the actual production code against the
real world. Runs in a **dedicated CI workflow** (`environment-suite.yml`), not
on a laptop (Option B, §9), so its verdict is as trustworthy as the hermetic
one and the laptop-state failure class disappears.

- Real daemon, **real `claude-code` harness via subscription auth**
  (`CLAUDE_CODE_OAUTH_TOKEN`, §8), real testnet, real indexer round-trip,
  against a **warm pre-staked operator** (§11) — never re-bootstraps.
- Consolidates today's `yarn e2e` real phases + Tier 2 (cross-op donation,
  producer/evaluator) + Tier 3 (real testnet) into one suite.
- Posts an `environment-suite` check-run bound to the candidate SHA.

The env suite asserts **loop completion + protocol-valid envelope + settlement +
activity-counter**. Agent answer-quality is hard-asserted only where the task
has known ground truth (e.g. a resolved prediction market); otherwise it is a
soft signal, never a hard gate. A flaky LLM must never block a release.

## 4. Snapshot, not fork

The hermetic gate uses a committed Anvil `--dump-state` snapshot, **not**
`--fork-url`, because a fork reintroduces exactly the flakiness we are removing:

1. **It puts the network back on the blocking path.** Cold-cache forks issue
   live `eth_getCode`/`eth_getStorageAt` calls — the per-PR gate would depend on
   Base RPC being up and un-throttled (the `jinn-mono-lrey` saturation problem).
   `--load-state` is local disk I/O.
2. **It breaks determinism.** Lazily-fetched slot sets, provider timeouts, and
   `latest` semantics vary run-to-run; determinism is what makes "red = product
   bug" true.
3. **It needs a secret in PR CI.** Forking wants a real RPC URL; PRs from forks
   don't get secrets, and we will not hand RPC quota to arbitrary PR authors. A
   snapshot is a committed file.
4. **It rots silently.** A fork at block N depends on the provider still serving
   archive state at N; providers prune. A committed snapshot passes identically
   in a year.
5. **Latency + variance.** Load-state is sub-second and constant.

The snapshot is **built by forking Base once**: fork at a pinned block locally →
deploy the V3 stack → seed the OLAS whale, Safe factory, registries, a funded
operator EOA → `anvil --dump-state` → commit the JSON as a versioned fixture.
Forking is a build step for the fixture, not a runtime dependency. Time-dependent
contract behavior (staking checkpoints) is handled hermetically with a controlled
clock (`evm_increaseTime` + mine) — *better* than a fork, which can't control the
clock — while real checkpoint *timing on the live contract* stays in the env
suite. The snapshot is refreshed deliberately whenever our contracts change; its
staleness relative to the real chain is a *feature* for a deterministic gate, and
real-chain drift is covered by the env suite. OLAS on-chain contracts are
effectively fixed, so bootstrap-from-snapshot is faithful.

## 5. Fidelity strategy — provoke real state, don't fake behavior

A mock that is subtly wrong is *worse* than no test: it ships a green that means
nothing. So we minimize the fiction.

The real `claimDelivery` path (`client/src/adapters/mech/contracts.ts`,
`adapter.ts`) handles a rich set of conditions — `AlreadyDelivered` /
`JobAlreadyDelivered` / `RequestAlreadyDelivered`, the "not yet delivered, retry"
window, transient-retry-then-throw, idempotent re-delivery, deadline-expired
refusal, multi-verdict slot claiming, evidence/verdict guards. The current
`MockTaskMarketplace` is pure happy-path; **none of these branches are exercised
end-to-end** — and most can't be reliably produced on a single-operator real
testnet either (no contention; deliveries land before you poll; you don't blow
the deadline on purpose).

So we drive the **real contracts** (already in the snapshot) into each state
rather than hand-coding fake reverts:

| Condition | Provoked on real bytecode |
|---|---|
| `AlreadyDelivered` | deliver once, then claim again → the real revert fires |
| "not yet delivered" retry window | don't send the deliver tx yet → real `getRequestStatus` |
| deadline expired | `evm_increaseTime` past the real deadline → the contract's own check |
| claim contention | a second EOA actually claims first → real contention path |
| idempotent re-delivery | crash-replay the real deliver tx → real idempotency branch |

Residual shims (the off-chain mech compute; the IPFS gateway) are I/O
boundaries, not behavioral logic. They are guarded two ways:

1. **ABI/selector conformance, pinned in CI** — assert the real deployed
   marketplace's function/event/error selectors against a pinned fixture;
   catches "OLAS upgraded the interface" drift immediately.
2. **Consumer-contract pairing** — any shim gets a paired test running the same
   assertions against the real thing (on a fork, in the env suite) and the
   shim; divergence fails loudly.

Preference order: **real bytecode driven into state → ABI conformance →
consumer-contract pairing → hand-written behavioral mock (last resort, always
pinned to reality).**

## 6. Coverage map

Tags: **[consolidate]** merged with overlapping scenarios; **[move]** same test,
new home; **[new]** doesn't exist yet; **[delay]** kept but advisory/deferred;
**[retire]** dropped or folded.

### Home 1 — Hermetic gate (deterministic, blocks PR→`next`)

| Capability | From today | Action |
|---|---|---|
| Bootstrap 11-step from scratch | `staking.ts` + Tier-1 `T1.1` + daemon-harness setup | **[consolidate]** one bootstrap on the snapshot |
| Loop plumbing (claim→…→activity-counter) | `daemon-harness-cycle.ts` + `validate.ts` phases 6,10 | **[consolidate]** one hermetic loop, deterministic harness |
| Indexer round-trip | Tier-1 `T1.3` (stub, #341) | **[new]** local Ponder vs snapshot |
| Contract lifecycle | `validate.ts` phase 6 | **[move]** into the loop |
| RPC fallback *logic* | implicit | **[new]** deterministic 429/5xx mock |
| Freeze-fence; train-vs-frozen | `validate.ts` phases 4,5 | **[move]** already deterministic |
| Schema smoke; local task-first | `validate.ts` phases 1,2 | **[move]** fold into `yarn test` |
| SPA route smoke + funding-sequence | Tier-1 `T1.4` + `funding-sequence.e2e` | **[consolidate]** Playwright vs mocked daemon |
| Harness readiness contract | Tier-1 `T1.2` | **[move]** deterministic |
| swe-rebench-v2 schema/registration/settlement wiring | `validate.ts` phases 9,10 | **[consolidate]** deterministic parts on the snapshot |

### Home 2 — Environment suite (real world, gates the cut)

| Capability | From today | Action |
|---|---|---|
| Real-harness loop (`claude-code`, subscription) | `daemon-harness` real path + Tier-2 `T2.2` + Tier-3 `T3.1` | **[consolidate]** one real loop on the warm operator |
| Cross-operator donation handshake | Tier-2 `T2.1` | **[move]** real testnet, two warm operators |
| Multi-op SPA flow (#351) | Tier-2 `T2.3` | **[delay]** advisory until reliably driven |
| swe-rebench-v2 real eval (Docker/HF) | `validate.ts` phases 7,8 | **[move]** + **[delay]** nightly/advisory (Docker weight) |
| Real RPC provider behavior under real 429s | implicit in fork phases | **[move]** here, not the gate |
| App-first testnet acceptance; donation consumption | hand-typed marker entries today | **[move]** become *real* checks that generate the verdict |

### Retire / decide

| Item | Action |
|---|---|
| `spa.e2e`, `spa-config.e2e`, `solvernet-flow.e2e` (stale) | **[retire or fix]** — no more "known stale" gating |
| Tier 1/2/3 taxonomy | **[retire]** → "deterministic→CI / real-world→suite" |
| `release-prep` mechanical execution | **[retire]** the run-role; execution is CI's |
| Hand-typed evidence marker | **[retire]** → machine-generated from verdicts |

## 7. Evidence flow — verify, don't re-run

Verdicts are **GitHub check-runs bound to the commit SHA** — the native
primitive branch protection already reasons about, machine-written and
tamper-evident:

- `hermetic-gate` — produced by CI per-PR/push, naturally on the SHA.
- `environment-suite` — posted by `environment-suite.yml` on the SHA it ran.

A rebase changes the SHA, so a stale verdict simply doesn't apply — correct,
automatic invalidation.

The publish guard (`npm-publish.yml` on `release: published`) is rewritten to:

1. Resolve the release SHA + validate tag/semver (keep).
2. **Query the SHA for both check contexts** (`hermetic-gate=success` AND
   `environment-suite=success`, bound to *this* SHA).
3. Green both → publish `@latest`; `promote-main` fast-forwards. Otherwise
   refuse, naming the missing/stale verdict.
4. **Execute no tests.** ~4 minutes of re-running becomes a sub-second query.

The marker is no longer typed by anyone; it is the projection of two check-runs
onto a SHA.

## 8. Cadence

The env suite cadence matches the **cut cadence + the drift rate**, not the
calendar. The cut is weekly; the env suite's unique coverage (real harness /
chain / indexer drift) is low-frequency and externally driven; the hermetic gate
already catches code regressions per-PR. So:

- **On-demand at readiness** (Friday/Saturday for the Monday cut) — the
  **authoritative** run, `workflow_dispatch`'d by `release-readiness` on the
  *exact candidate SHA*. This is the gate.
- **One pre-flight run, Thursday 07:00 UTC**, on `next` HEAD,
  **skip-if-unchanged** — early warning so readiness isn't the first real-world
  signal, with a fix runway before the cut. (Thursday, not Saturday, to avoid
  colliding with the readiness run.)
- **No daily run.** Add a second mid-week run only if drift is observed slipping
  through between runs.

Tying the env suite to the weekly rhythm runs the real suite ~1–2× per week,
which keeps it comfortably inside Claude subscription limits and minimizes warm-
operator wear.

**Subscription, not API key.** The `claude-code` harness spawns the `claude`
CLI, which authenticates from the environment. The env suite uses
**`CLAUDE_CODE_OAUTH_TOKEN`** (from `claude setup-token` against a Pro/Max
subscription) — flat-rate, not per-token. Discipline: set *only* the OAuth token
and **ensure `ANTHROPIC_API_KEY` is unset** (an API key can take precedence and
silently fall back to per-token billing). Consequences, all favourable: the gate
runs the harness operators actually run; the low-volume cadence fits subscription
caps; an expired/revoked token classifies as `infra-blocked` (§10), not a
product red.

## 9. Option B — execution locus and secrets

The env suite runs in a **dedicated CI workflow with testnet secrets**, not on a
laptop. This is what makes its verdict trustworthy (a controlled box, not an
operator who *could* post an unearned green) and eliminates the laptop-state bug
class entirely.

`environment-suite.yml` shape:

1. **Pre-flight**: check out the candidate SHA; restore the warm operator's
   `~/.jinn-client/` state from secrets; run the health check (substrate doctor,
   #531) and top-up. Unhealthy/under-funded → `infra-blocked`, stop.
2. **Run** the consolidated suite.
3. **Post** the `environment-suite` check-run on the SHA + verdict JSON artifact.
4. **`concurrency:`** group serializes runs — the warm operator is a singleton.

Secrets, scoped to a protected `testnet-gate` GitHub Actions Environment:

- `JINN_WARM_OPERATOR_STATE` (+ `_B_STATE` for cross-op) — base64 of the
  operator's earning state (encrypted keystore + `earning_state.json` + Safe /
  service / staking IDs).
- `JINN_PASSWORD` — decrypts the keystore.
- `BASE_SEPOLIA_RPC_URL` — paid primary + public fallback chain (#592).
- `CLAUDE_CODE_OAUTH_TOKEN` — subscription harness auth.
- `JINN_DISCOVERY_URL` (+ token if the testnet Ponder is access-controlled).
- `JINN_FUNDER_PRIVATE_KEY` — testnet EOA the top-up step refills from.
- GitHub: the default `GITHUB_TOKEN` with `permissions: { checks: write,
  statuses: write, contents: read }` — not a stored secret.

**Security posture (enforced, not assumed):**

1. **Testnet, dedicated, throwaway** operator — pseudonymous, refillable, not a
   daily driver; low blast radius, rotatable.
2. **Secrets scoped to the protected `testnet-gate` Environment**, not repo-wide.
3. **Never runs on PRs from forks** — triggers are schedule / dispatch / `next` /
   `release/*` only. Non-negotiable: an untrusted PR must never execute a job
   that can read the keystore.

## 10. Failure-loop semantics — three outcomes

Trust in "red = real" depends on cleanly separating:

- **product-red** → blocks; drive to fix on the `release/<v>` branch.
- **infra-blocked** (warm operator unhealthy, OAuth token expired, RPC 429 after
  retry, agent-transport error) → *not* a regression; reported distinctly,
  retried once, and if persistent blocks the cut as an **infra** problem to fix
  in the harness — never silently classified as a product pass *or* fail. This is
  the distinction that turns "blocked for days, was it the product?" into "the
  dashboard says infra, go fix the operator."
- **agent-answer-quality** → hard-asserted only where ground truth exists;
  otherwise soft. A flaky LLM never blocks.

`release-readiness` retains the discipline that a flake classification is a
*hypothesis* to be proven by isolated retry + root-cause against ground truth
(the v2026.05.25 lesson), never an assumption.

## 11. Warm operator — a named, owned responsibility

A dedicated, persistent, pre-staked testnet operator owned by the release infra
(keystore in the `testnet-gate` secrets). Health-checked before each run (#531);
auto-topped-up; reused so the env suite never bootstraps from scratch (bootstrap
correctness lives in the hermetic gate).

**This is shared infrastructure with a lifecycle, and it must have an owner.**
Someone owns keeping the warm operator healthy, funded, and its
`CLAUDE_CODE_OAUTH_TOKEN` fresh. Lapses surface as `infra-blocked` (loud), not as
mystery reds — but if nobody owns it, it rots and the gate is unavailable
precisely when the cut needs it.

## 12. What the skills become

- **`release-readiness`** → orchestration + judgment + verdict-reading. It
  resolves the candidate SHA, runs the **canon audit** (C1–C12 against the
  window diff — the irreplaceable reasoning part, kept), triggers the env
  workflow on the candidate SHA, drives any red gate through the
  debug-classify-fix loop on a `release/<v>` branch, then synthesizes a
  recommendation. **SHIP** iff both verdicts are green-for-candidate-SHA + audit
  clean + closure reviewed. It never runs tests on a laptop; the marker is
  generated from verdict artifacts.
- **`release-prep`** → its mechanical run-role retires (execution is CI's). Its
  substrate helpers are repurposed into warm-operator lifecycle tooling.
- The **Tier ladder** retires in favor of the determinism split.

## 13. Migration plan

Each step ships value alone:

1. **Pinned snapshot + hermetic loop in PR CI** → a real code gate per PR.
2. **Local Ponder spawn helper** (#341) → closes the indexer gap.
3. **Verdict store (SHA-bound check-runs) + guard rewrite to verify-not-rerun**
   → *kills the double-run on its own*, before the harder env work.
4. **Env suite + execution locus (Option B) + warm operator** → the reliable
   real gate.
5. **Slim `release-readiness`; retire `release-prep` runner, the Tier ladder,
   the hand-typed marker.**

Step 3 delivers the "do it twice" fix independently — relief comes early.

## 14. What this does not solve / risks

- **Snapshot staleness vs. live contract behavior** is covered by the env suite,
  not the hermetic gate — by design. A live-OLAS regression that only manifests
  against current chain state is caught at env-suite cadence (≥ weekly), not
  per-PR. Accepted: OLAS contracts are effectively fixed.
- **Marketplace interface drift** (OLAS upgrades the Mech ABI) is caught by ABI
  conformance (signature) + the periodic env loop (behavior), not by the
  hermetic happy path.
- **Warm-operator ownership** is the load-bearing operational dependency
  (§11). Unowned, it rots.
- **Subscription rate limits / token expiry** bound the env cadence; per-push is
  explicitly out of scope for the env suite.
- **The canon audit (C1–C12) remains human/agent judgment** — not mechanized by
  this spec.

## 15. Relationship to handbook §Cadence

Unchanged: `next` integration branch, canary-on-push, Monday named cut,
`promote-main` fast-forward, hotfix sub-flow, the holistic release-review PR
(DR-2026-05-20). Changed: the **publish guard** verifies two SHA-bound check-runs
instead of re-running Tier 1 and parsing a hand-typed marker; the **validation
substance** is the two-gate determinism split, not the Tier ladder. The handbook
§Cadence and `docs/runbooks/hotfix.md` evidence-marker references update to the
check-run model when this lands (tracked in the migration's step 3/5). The
hotfix sub-flow still cuts a named release on `main` HEAD; its evidence becomes
the same two check-runs bound to the hotfix SHA.
