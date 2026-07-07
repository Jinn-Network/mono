---
id: DR-2026-06-03
title: App-experience coverage — deterministic SPA flow tests (gating); real paired flow as a manual runbook (not an automated test)
date: 2026-06-03
verb: Steer
status: ratified
authors: opus (brainstorming session with ritsuKai2000)
issue: [#1014](https://github.com/Jinn-Network/mono/issues/1014)
relates-to: [#923](https://github.com/Jinn-Network/mono/issues/923) (two-gate consolidation) via PR [#960](https://github.com/Jinn-Network/mono/pull/960), `docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md` (the two-gate target this builds on), [#351](https://github.com/Jinn-Network/mono/issues/351) (operator-join count surface), [#773](https://github.com/Jinn-Network/mono/issues/773) (staking/launch decouple — the race T2.3 surfaced), `.claude/skills/testing-jinn-app` (the two-mode pattern this leans into)
sequenced-after: PR [#960](https://github.com/Jinn-Network/mono/pull/960) — MERGED 2026-06-03; the two-gate world this targets is live, so the CI wiring (hermetic-gate.yml + environment-suite.yml) ships in this same branch rather than a follow-up.
---

## Context

The two-gate consolidation (#923, PR #960) **deletes** T2.3
(`launcher-join-flow.e2e.test.ts`, plus the `two-substrate-ops` fixture and
the `release:tier-2:T2.3` script). T2.3 was a Playwright browser E2E driven
against a **live Anvil fork + two live daemons** — non-deterministic, neither
hermetic nor real-testnet. It flaked on multiple independent legs (launch
stall, cumulative-budget overrun, the op-a Onboarding re-gate), and the
variance made it un-gateable; the redesign spec already marked it
*"[delay] advisory until reliably driven."*

Removing it lost **no component coverage** — every leg is covered
deterministically (launcher-create step component tests, the launch
state-machine unit test, the discovery + `JoinFlow` + `StatusHeader` tests).
But it left a real gap: **the operator's actual app experience — SPA-driven,
end-to-end — is not gated.** The protocol loop is well-covered (hermetic gate
+ T2.1 cross-op donation + T2.2 producer/evaluator + T3.1 real loop); the
SPA/app-integration layer is not. PR #960's own `run-tier-2.ts` NOTE points at
this issue as the place to rebuild that coverage "in the right shape —
deterministic mocked-daemon Playwright flow tests (hermetic gate) + a
non-gating real paired app smoke."

This DR resolves the three open questions deferred from the #960 discussion
and fixes the two-mode shape before implementation.

### Constraints inherited from the two-gate world

- The strict **`hermetic-gate`** check-run (`hermetic-gate.yml`) is
  **vitest-only** today (`yarn test:hermetic`) — no browser, no Chromium.
- The publish guard queries **exactly two** SHA-bound contexts
  (`hermetic-gate` + `environment-suite`) and re-runs nothing (spec §7).
- `environment-suite.yml` (real testnet, gates the cut) already provisions a
  warm operator + secrets in a protected `testnet-gate` Environment.
- Acceptance criterion: **no live-fork browser E2E may re-enter any blocking
  gate** — that recreates the T2.3 flakiness this redesign exists to kill.

## Decision

Split app-experience coverage into two modes, keyed to determinism (the same
axis the two-gate redesign uses), leaning into the `testing-jinn-app` skill's
existing two-mode pattern.

### Mode 1 — Deterministic app-flow coverage (gating)

Two **focused per-journey** tests (not one monolithic 6-leg test — the
monolith is what made T2.3 unmaintainable):

| Journey | Test | Pattern | Status |
|---|---|---|---|
| create → launch | `solvernet-flow.e2e.test.ts` | real-daemon spawn + `page.route` mock | **exists — keep as-is** |
| discover → join → observe | `join.e2e.test.ts` | **pure mocked-daemon** (`mock-daemon-api.ts` `page.route`, no daemon spawn) | **net-new — build** |

**Why net-new join, not extend solvernet-flow.** `solvernet-flow` already
covers create→launch and uses a real daemon *because* it exercises real
draft-persistence endpoints (`POST/PATCH /v1/solvernets/drafts`). The **join**
leg has no such need: its value is catalog-discovery + the `JoinFlow` UI +
post-join state, all of which are daemon-API surfaces we mock deterministically.
A *real* daemon cannot do cross-operator catalog propagation without a real
chain/indexer — that propagation is exactly the T2.3 flake source. The
deterministic substitute is a fixture: op-b's catalog response *contains*
op-a's launched manifest.

**The join test** drives a single browser context (op-b's SPA) against three
mocked endpoints (verified against the live SPA source):

1. `GET /v1/solvernets/registry` → fixture containing op-a's launched
   SolverNet → navigate `/operator`, assert it appears in `RegistryCatalog`,
   click **Join**.
2. Routes to `/operator/join/:cid`; `GET /v1/harnesses/:name/readiness` →
   ready.
3. Fill + submit the join form → `POST /v1/operator/join/:cid` mocked success.
4. Assert the post-join UI reflects the joined SolverNet
   (`joinedSolverNets[<manifestCid>]`).

"Both observe each other" is modeled deterministically as *op-b's catalog
contains op-a's manifest* (a fixture) — not a real cross-daemon round-trip.

**Where it runs (resolves open Q2 "exactly where").** Folded into
`hermetic-gate.yml` as a scoped Playwright step:

- New `yarn e2e:app-flow` script running **only** `solvernet-flow` +
  `join.e2e` (the gating journeys) — deliberately **not** `yarn e2e:dashboard`,
  which drags in the quarantined "stale-failure" dashboard tests
  (`spa`, `spa-config`, `HarnessSection`).
- A Chromium-install step (`npx playwright install --with-deps chromium`) in
  the hermetic-gate job.

This keeps the publish guard's **exactly-two-context** contract (§7) intact —
app-flow determinism becomes part of the single `hermetic-gate` correctness
proof rather than a third queried context. By the redesign's own taxonomy
(deterministic → hermetic gate), mocked-daemon app-flow tests belong here; PR
#960's NOTE already names "(hermetic gate)" as their home. The cost (Chromium
+ ~1–2 min) is acceptable precisely because these are mocked-daemon tests — no
fork, no live daemon — so they are deterministic by construction and cannot
reintroduce T2.3-style flake.

**Alternatives rejected.** (a) A *separate* required Playwright check-run
distinct from `hermetic-gate` leaves a hole: it gates PRs but the publish
guard ignores it on the release SHA, so a Monday cut could publish with
app-flow red on that exact SHA. (b) Extending the publish guard to query a
third context breaks the spec §7 "exactly two" contract and needs the
publish-guard-change skill + waiver plumbing — overkill.

### Mode 2 — Real paired flow: a manual runbook, NOT an automated test

**Superseded 2026-06-04.** Mode 2 was first built as a `continue-on-error`
`real-paired-smoke` CI job (local-spawn of two warm operators, evaluator join,
neutral/no-check-run). It was validated end-to-end on real Base Sepolia
(local-spawn → on-chain launch → cross-op discovery → JoinFlow IPFS fetch →
evaluator join, including the secret→restore→per-operator-password path). **But
the automated job is dropped** — replaced by a manual runbook in the
`testing-jinn-app` skill (`references/scenario-multi-op-spa-flow.md`).

**Why dropped.** The exercise of trying to make it pass repeatedly *demonstrated*
the problem: against real testnet + a shared rate-limited RPC + IPFS + the
indexer, the flow's timing is irreducibly non-deterministic (launch confirmation
latency, IPFS metadata lag, cross-op propagation, RPC 429s under concurrent
boot). An automated test of it can only be flaky — and a flaky non-gating test is
near-worthless: a red can't be told apart from a real bug, so it gets ignored,
and an ignored test is pure cost (real gas, two warm operators, RPC load on
shared infra). That is the **exact un-gateable shape #960 deleted T2.3 to
escape**. Building another automated flaky browser test, even non-gating,
re-creates the problem the release reconciliation set out to kill.

**What replaces it.** The real-world *app* layer is checked by a **human-run spot
check** — the runbook captures the hard-won mechanics (spawn two daemons
sequentially to avoid RPC 429s; each daemon uses its own `keystore-password`;
match op-b's catalog card by **manifest CID** not the lagging name; **join as
Evaluator** since Solver gates on claude-code OAuth; budget 300s+ for launch
confirmation). The real-world *protocol* layer remains covered at the API level
by the environment-suite scenarios (T2.1/T2.2/T3.1). Nothing in the pipeline
depends on the paired flow being green.

This keeps the genuine deliverable — **Mode 1's deterministic gating coverage** —
and refuses to put a flaky real-world browser test back near a gate.

### Lane discipline (unchanged)

The protocol loop stays validated at the daemon/API level (T2.1 cross-op
donation, T2.2 producer/evaluator, T3.1 real loop). The app layer is validated
by **Mode 1 (deterministic, gating)**; the real paired flow is a **manual
runbook**, not an automated test. We do **not** weld a live browser onto the
protocol scenarios, and we do **not** put a flaky real-world browser test on
(or beside) a gate.

## Open questions resolved

1. **Real app smoke — human-run or CI-dispatched?** → **Human-run.** First
   answered "CI-dispatched, non-gating"; revised 2026-06-04 to a manual runbook
   after the real runs showed an automated version is irreducibly flaky and a
   flaky non-gating test carries cost without trustworthy signal (see Mode 2).
2. **Scope/granularity + where the deterministic flow tests run?** → **Two
   per-journey tests** (create→launch existing; discover→join→observe
   net-new), run in `hermetic-gate.yml` via a scoped `yarn e2e:app-flow`
   script.
3. **Audit `solvernet-flow.e2e.test.ts` — extend vs net-new?** →
   `solvernet-flow` already covers create→launch; **extend nothing there**,
   the join journey is the only real deterministic gap → **net-new
   `join.e2e.test.ts`**.

## Acceptance-criteria mapping (#1014)

- Deterministic gating coverage of create→launch→join →
  `solvernet-flow` (repaired) + net-new `join.e2e`, bundled as `yarn e2e:app-flow`
  and run in `hermetic-gate.yml`. ✓ (wiring shipped in this branch)
- Real paired (two-operator) app flow, never on a blocking gate → **manual
  runbook** in `testing-jinn-app` (`references/scenario-multi-op-spa-flow.md`),
  not an automated test. ✓ (the AC's "non-gating real paired smoke" is met by a
  human-run check; the automated CI job was built, validated on real testnet,
  then deliberately dropped — see Mode 2 for why a flaky automated version is the
  wrong shape.)
- No live-fork browser E2E reintroduced into any blocking gate → join is
  fully mocked; the paired flow is manual, not automated. ✓
- Design recorded → this DR. ✓

## Sequencing

This DR targeted the two-gate world; **PR #960 merged 2026-06-03**, so that world
is live and Mode 1's CI wiring ships in this same branch: a scoped Chromium +
`yarn e2e:app-flow` step in `hermetic-gate.yml`. Mode 2 is **not** wired into CI
— `environment-suite.yml` is left untouched; the real paired flow lives as a
manual runbook in the `testing-jinn-app` skill.

## Consequences

- `hermetic-gate.yml` gains its first browser step (scoped Chromium +
  `yarn e2e:app-flow`). It remains deterministic — mocked-daemon, no fork.
- `environment-suite.yml` is unchanged: no automated real paired smoke. The
  two-operator app flow is a human-run spot check
  (`testing-jinn-app/references/scenario-multi-op-spa-flow.md`).
- The quarantined stale dashboard E2Es (`spa`, `spa-config`, `HarnessSection`)
  are **out of scope** here — `e2e:app-flow` is deliberately narrow. Un-quarantining
  them (the `ci.yml` "swap to `yarn e2e:dashboard` when green" TODO) is separate.
