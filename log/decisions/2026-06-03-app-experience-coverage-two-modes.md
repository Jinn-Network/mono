---
id: DR-2026-06-03
title: App-experience coverage — deterministic SPA flow tests (gating) + non-gating real paired smoke
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

### Mode 2 — Real paired smoke (non-gating)

A `continue-on-error` job in `environment-suite.yml` that drives the **two
warm operators' real testnet SPAs** through create → launch → join, posts a
**neutral** result (never failing), and uploads screenshots + Playwright trace
as artifacts for per-cut visibility.

- **Resolves open Q1 (human-run vs CI-dispatched): CI-dispatched, non-gating.**
  "Visible on every cut" is a stated goal; only a CI leg on the candidate SHA
  that `release-readiness` already dispatches delivers that automatically.
- Reuses the warm-operator + `testnet-gate` secrets already provisioned in
  `environment-suite.yml` — no new secret wiring.
- The T2.3-flake concern is fully defused by **classification**: the job's
  outcome never feeds the gating verdict, so flake cannot block. A
  browser-on-real-world run is legitimate *only* when non-gating.
- It runs against **real testnet** (the warm operators' live dashboards), not
  an Anvil fork — so it is not a resurrection of T2.3, and **no live-fork
  browser E2E enters any blocking gate** (acceptance criterion satisfied).
- Shares selectors / page objects with the deterministic `join.e2e` test where
  possible, so there is one maintenance surface across the two modes.

### Lane discipline (unchanged)

The protocol loop stays validated at the daemon/API level (T2.1 cross-op
donation, T2.2 producer/evaluator, T3.1 real loop). The app layer is validated
by Mode 1 (gating) + Mode 2 (non-gating). We do **not** weld a live browser
onto the protocol scenarios.

## Open questions resolved

1. **Real app smoke — human-run or CI-dispatched?** → **CI-dispatched,
   non-gating**, a neutral `continue-on-error` job in `environment-suite.yml`,
   visible per cut.
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
- Non-gating real paired smoke (real SPA + real testnet), classified so it
  never blocks → `continue-on-error` job in `environment-suite.yml` that posts no
  check-run. ✓ (job shipped; **stays a no-op skip until a human provisions the two
  hosted-dashboard URLs `JINN_SMOKE_OP_A_URL` / `JINN_SMOKE_OP_B_URL` in the
  `testnet-gate` Environment** — the test self-skips when they are absent)
- No live-fork browser E2E reintroduced into any blocking gate → join is
  fully mocked; the smoke is real-testnet **and** non-gating. ✓
- Design recorded → this DR. ✓

## Sequencing

This DR targeted the two-gate world; **PR #960 merged 2026-06-03**, so that world
is live and the CI wiring ships in this same branch (not a follow-up): Mode 1 adds
a scoped Chromium + `yarn e2e:app-flow` step to `hermetic-gate.yml`; Mode 2 adds a
non-gating `real-paired-smoke` job to `environment-suite.yml`. One human prereq
remains before Mode 2 produces signal: provision `JINN_SMOKE_OP_A_URL` /
`JINN_SMOKE_OP_B_URL` (two externally-hosted operator dashboards) in the
`testnet-gate` Environment. Until then the smoke job runs and self-skips — green,
no-op, no blocking effect.

## Consequences

- `hermetic-gate.yml` gains its first browser step (scoped Chromium +
  `yarn e2e:app-flow`). It remains deterministic — mocked-daemon, no fork.
- `environment-suite.yml` gains a non-gating browser job whose flake is
  contained by neutral classification.
- The quarantined stale dashboard E2Es (`spa`, `spa-config`, `HarnessSection`)
  are **out of scope** here — `e2e:app-flow` is deliberately narrow. Un-quarantining
  them (the `ci.yml` "swap to `yarn e2e:dashboard` when green" TODO) is separate.
