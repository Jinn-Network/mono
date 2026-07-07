# Jinn Harness Network v0 — Implementation Plan (human-gated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0 of `spec/2026-07-02-jinn-harness-network.md` — the harness-layer package,
Jinn-Hermes fork, skills.sh seed import, and distribution-signal surface — with a **human
verification surface at every step that needs one**.

**Architecture:** Wrap existing client machinery (corpus runtime, capture→scrub→anchor pipeline,
ERC-8004) into an embeddable `@jinn-network/harness-layer` package; the Hermes fork is upstream +
that package pre-wired. All new consumption/contribution flows run against **testnet**.

**Tech stack:** TypeScript (client workspace conventions), Zod schemas, vitest; Solidity untouched
in v0 (no contract work until v0.5).

## Global constraints

- Corpus is public; no enclosure; no take-rate (spec §2, PRINCIPLES.md).
- Scrub is mandatory and fail-closed at publish altitude — no scrub, no publish (spec §5).
- Capture is harness task traces only — never wider machine/dev activity (spec §5, §10).
- Layer-1 envelope schema freezes at Task 2 sign-off; changes after that are a spec amendment.
- Seeds carry `provenance: imported` and are excluded from the demand signal (spec §7).
- Every task lands as its own PR to `next` (handbook rule 10), reviewed by Oak (rule 4 — no agent
  self-merge). **Each PR description must include the task's "Human surface" section verbatim,
  with the exact commands/URLs the reviewer runs.**
- Thin-fork discipline: the fork carries the Jinn layer as an isolated patch surface (spec D2).

## Review protocol (how Oak reviews, step by step)

Each task below ends with a **Human surface** block: the exact thing Oak runs/opens/inspects, and
what "pass" looks like. A task is not done until its human surface has been exercised and
approved — automated tests passing is necessary, not sufficient. Two tasks (2 and 6) are
**approval gates**: work stops until Oak signs off, because they freeze formats or write publicly.

---

### Task 1: harness-layer package — consume path

**Files:**
- Create: `client/packages/harness-layer/` (workspace package `@jinn-network/harness-layer`)
  — `src/consume.ts`, `src/index.ts`, `package.json`, `tsconfig.json`
- Reuse: `client/src/corpus/` (`createCorpus()`, `query()`, `fetchManifest()`, `acquire()`),
  `client/src/discovery/factory.ts`
- Test: `client/packages/harness-layer/test/consume.test.ts`

**Interfaces:**
- Consumes: `createCorpus()` from `client/src/corpus/index.ts`; configured `DiscoveryAPI` from
  `client/src/discovery/factory.ts`.
- Produces: `createHarnessLayer(config): { corpus: { search(query), get(ref) } }` — the embedding
  surface Task 5 wires into the fork; plus a `jinn-layer` CLI entry (`corpus search <query>`).

**Steps:**
- [ ] Scaffold the workspace package; wire build into the client workspace (`yarn build` covers it).
- [ ] Write failing tests: `search()` returns typed results against a mocked DiscoveryAPI;
      `get()` round-trips an artifact ref; config resolves testnet defaults.
- [ ] Implement `consume.ts` as a thin wrapper over `createCorpus()` — no new query logic.
- [ ] Add the `jinn-layer corpus search` CLI subcommand (same pattern as existing
      `client/src/cli/commands/`).
- [ ] `yarn typecheck && yarn test` green; commit; PR.

**Automated verification:** package tests + typecheck in CI.

**Human surface — corpus in one command:**
Run: `yarn jinn-layer corpus search "prediction"` (repo checkout, testnet config).
**Pass:** real testnet corpus results print in the terminal — titles, refs, provenance fields —
and one `get <ref>` fetches an artifact. Nothing to trust; you watched it come off the indexer.

---

### Task 2: layer-1 trace envelope schema — APPROVAL GATE (freezes the corpus format)

**Files:**
- Create: `client/packages/harness-layer/src/envelope.ts` (Zod schema + types),
  `client/packages/harness-layer/docs/envelope-v0.md` (the human-readable schema doc)
- Reuse: span/capture shapes from `client/src/store/captures.ts` and `client/src/captures/publish.ts`
- Test: `client/packages/harness-layer/test/envelope.test.ts`

**Interfaces:**
- Produces: `TraceEnvelopeV0` — task descriptor + freeform distribution tags, environment
  fingerprint (harness, model, tools), compressed steps, `outcome: { status, verifiabilityTier:
  'user-accepted' | 'tests-passed' | 'evaluator-verified' }`, cost, consent flags (spec §5).
  Tasks 3, 4, 6, 7 all consume this type.

**Steps:**
- [ ] Draft `envelope-v0.md`: every field, why it exists, what reads it (checker counts
      `verifiabilityTier`; signal reads distribution tags; layer-2 promotion reads outcome).
- [ ] Write failing tests: valid envelope parses; missing consent flag rejects; oversized steps
      reject; unknown fields reject (frozen schema = closed).
- [ ] Implement the Zod schema; generate three **realistic example envelopes** into
      `docs/envelope-v0.md` (a coding task, a research task, a failed task).
- [ ] Tests green; commit; PR.

**Automated verification:** schema tests in CI.

**Human surface — schema review (STOP until approved):**
Read `envelope-v0.md` end to end — the field table and the three example envelopes.
**Pass:** you can answer, for each field, "who reads this and what breaks if it's wrong," and the
examples look like something you'd be comfortable seeing published from your own machine. This is
the last cheap moment to change the corpus format; sign-off freezes it (spec Q1).

---

### Task 3: capture path — scrub preview and the privacy surface

**Files:**
- Create: `client/packages/harness-layer/src/capture.ts`,
  `client/packages/harness-layer/src/preview.ts`
- Reuse: `client/src/trajectory/scrub/build.ts` (pipeline assembly),
  `client/src/trajectory/scrub/emit-scrub.ts` (`scrubCaptureSpans()`)
- Test: `client/packages/harness-layer/test/capture.test.ts`, fixture at
  `client/packages/harness-layer/test/fixtures/seeded-secrets-task.json`

**Interfaces:**
- Consumes: `TraceEnvelopeV0` (Task 2); scrub pipeline from `client/src/trajectory/scrub/`.
- Produces: `capture(task, opts): PendingEnvelope` and `preview(pending): ScrubReport` — where
  `ScrubReport = { envelope: TraceEnvelopeV0, redactions: Array<{ field, stage, before?, after }> }`
  (before shown only locally, never persisted). Task 4 consumes `PendingEnvelope`.

**Steps:**
- [ ] Write failing tests: a fixture task **seeded with known secrets** (API key shapes, an email,
      a file path with a username) produces a `ScrubReport` in which every seeded secret is
      redacted; scrub-stage failure ⇒ `capture()` throws (fail-closed), never a silent pass.
- [ ] Implement `capture.ts` wrapping the existing pipeline; implement `preview.ts` producing the
      redaction diff report.
- [ ] Add CLI: `jinn-layer capture preview <task-file>` rendering the report (redactions
      highlighted, envelope as it would publish).
- [ ] Tests green; commit; PR.

**Automated verification:** seeded-secrets fixture test is the regression net; fail-closed test.

**Human surface — see exactly what would leave your machine:**
Run: `yarn jinn-layer capture preview test/fixtures/seeded-secrets-task.json`, then once more on a
**real task you ran yourself** that day.
**Pass:** every seeded secret shows as redacted in the fixture; on your real task, you read the
full outgoing envelope and would publish it. If anything in your real trace makes you hesitate,
that's a scrub gap — file it, task isn't done.

---

### Task 4: publish + anchor + contribution ledger

**Files:**
- Create: `client/packages/harness-layer/src/publish.ts`,
  `client/packages/harness-layer/src/ledger.ts`
- Reuse: `client/src/captures/publish.ts` (`publishCaptureEnvelope()` → `anchorEnvelope()`),
  `client/src/erc8004/identity.ts`
- Test: `client/packages/harness-layer/test/publish.test.ts`

**Interfaces:**
- Consumes: `PendingEnvelope` (Task 3); existing publish/anchor deps.
- Produces: `publish(pending): { envelopeRef, anchorTx }` and
  `ledger(): Array<{ ts, taskSummary, envelopeRef, anchorTx, verifiabilityTier }>` — Task 5 renders
  this in the fork; Task 7 aggregates over it.

**Steps:**
- [ ] Write failing tests: publish routes through scrub (cannot bypass — `publish(raw)` is not
      constructible); anchor result recorded; ledger lists published envelopes with tx hashes;
      per-task veto (`opts.veto`) means no publish and a ledger entry marked `vetoed (local only)`.
- [ ] Implement against the existing pipeline (testnet direct-anchor for v0; the batch relayer is
      v0.5 with earning).
- [ ] CLI: `jinn-layer ledger` renders the table with explorer URLs.
- [ ] Tests green; commit; PR.

**Automated verification:** no-bypass test, veto test, anchor-recorded test.

**Human surface — the receipt:**
Publish one real (previewed, Task-3-approved) envelope on testnet, run `yarn jinn-layer ledger`,
click the anchor tx link.
**Pass:** the testnet explorer shows the anchor tx; the envelope ref resolves via
`jinn-layer corpus get <ref>`; the round trip contribute→anchored→discoverable is closed with
your own contribution.

---

### Task 5: Jinn-Hermes fork — first-run consent + integration

**Files:**
- Create: fork repo (e.g. `Jinn-Network/hermes`) with the Jinn layer isolated in one integration
  surface (single directory / patch series — thin-fork discipline, spec D2)
- Reuse: `@jinn-network/harness-layer` (Tasks 1–4); integration reference:
  `client/src/harnesses/impls/hermes-agent/` (how Hermes is spawned/adapted today)
- Test: fork-side integration test (consent declined ⇒ zero capture calls; accepted ⇒ capture on
  task completion)

**Interfaces:**
- Consumes: `createHarnessLayer()`, `capture()/preview()/publish()`, `ledger()`.
- Produces: the installable fork — first-run consent flow (contribute? default-on shown clearly,
  with preview offer; run a node? — stub pointing at v0.5), in-session corpus consumption, ledger
  command.

**Steps:**
- [ ] Fork upstream; carve the integration surface; document the upstream-merge procedure in the
      fork's `JINN.md`.
- [ ] Wire consume: corpus search available to the agent in-session (via the layer's MCP surface).
- [ ] Wire capture: on task completion, envelope built → scrubbed → (consented) published; per-task
      veto flag plumbed to the UI.
- [ ] Integration tests green; commit; PR (fork repo).
- [ ] **Thin-fork proof:** merge the latest upstream Hermes commit on top; record conflicts (target:
      none outside the integration surface) in the PR.

**Automated verification:** consent-gating test; thin-fork merge recorded in CI or PR notes.

**Human surface — dogfood install (the v0 moment):**
Fresh-install the fork on your machine (not the repo checkout). Go through first-run consent. Run
a real task of yours end to end.
**Pass:** (a) consent flow says plainly what will be captured and shows a preview before the first
publish; (b) the task visibly uses corpus context; (c) your contribution appears in `ledger` with
an anchor link; (d) the upstream-merge proof shows the fork is a patch, not a divergence. If the
consent flow would make you uneasy on someone else's machine, it fails.

---

### Task 6: skills.sh seed import — APPROVAL GATE (writes publicly)

**Files:**
- Create: `client/packages/harness-layer/src/seed-import/` (`fetch.ts`, `licence.ts`,
  `report.ts`, `import.ts`)
- Reuse: publish path (Task 4); layer-2 SKILL.md-compatible format (spec §5)
- Test: `client/packages/harness-layer/test/seed-import.test.ts`

**Interfaces:**
- Consumes: skills.sh registry listing; `publish()` (Task 4).
- Produces: `plan(): ImportReport` (no writes) and `execute(report): ImportResult` — where
  `ImportReport = Array<{ skill, source, licence, verdict: 'import' | 'skip', reason }>`.

**Steps:**
- [ ] Write failing tests: licence checker maps known licences correctly (MIT/Apache-2.0 ⇒ import
      with attribution; no licence / incompatible ⇒ skip with reason); every imported entry carries
      `provenance: imported` + attribution metadata; `plan()` performs zero writes.
- [ ] Implement fetch → licence-check → report; `execute()` publishes only `verdict: 'import'`
      rows through the Task-4 path.
- [ ] CLI: `jinn-layer seed plan` (prints the report) and `jinn-layer seed execute <report-file>`.
- [ ] Tests green; commit; PR.

**Automated verification:** licence-mapping tests; zero-write plan test; provenance-tag test.

**Human surface — approve the import list (STOP until approved):**
Run `yarn jinn-layer seed plan` and read the full report table: every skill, its licence, verdict,
reason.
**Pass:** you approve the exact list (edit verdicts if needed) **before** `seed execute` runs.
After execution: `jinn-layer corpus search` returns seeded skills showing `provenance: imported`
and attribution. Nothing lands on chain that you didn't see on the list.

---

### Task 7: distribution signal surface

**Files:**
- Create: `client/packages/harness-layer/src/signal.ts`; dashboard view (operator-app surface —
  follows `client/OPERATOR-APP-SPEC.md` conventions; spec update in the same PR per CLAUDE.md
  frontend rules)
- Reuse: discovery aggregates (`getTaskPostCounts()`-style surface in `client/src/discovery/types.ts`)
- Test: `client/packages/harness-layer/test/signal.test.ts`

**Interfaces:**
- Consumes: published envelopes (Task 4) with distribution tags (Task 2).
- Produces: `signal(): Array<{ cluster, envelopeCount, contributorCount, topTags }>` — sorted by
  volume, **seeds excluded**; rendered as a dashboard view.

**Steps:**
- [ ] Write failing tests: clustering groups tagged fixtures sensibly; `provenance: imported`
      entries are excluded from all counts; empty corpus renders an explicit empty state.
- [ ] Implement aggregation + the dashboard view (shadcn primitives only).
- [ ] Tests green; commit; PR (includes OPERATOR-APP-SPEC.md addition for the new view).

**Automated verification:** seed-exclusion test is the critical one.

**Human surface — where is usage concentrating:**
Open the dashboard signal view after a week of dogfood use (you + Ritsu + David V).
**Pass:** the view answers "which distributions are people actually running" at a glance; toggling
a debug filter proves seeded entries are not counted; the top cluster matches your intuition of
what you've actually been running. This view is what v0.5 deepening decisions will read — if it
doesn't convince you, it won't justify emissions.

---

### Task 8: v0 gate review (written, human)

**Files:**
- Create: `docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-gate.md`

**Steps:**
- [ ] Write the gate review against spec §8: external daily users (single digits fine),
      contributions flowing and visible on-chain, signal showing concentration. Each criterion:
      met/not-met + evidence link (ledger entries, anchor txs, signal screenshot).
- [ ] Decision recorded: proceed to v0.5 (earn) / iterate v0 / stop.

**Human surface:** the gate doc itself — Oak writes or co-writes it; it is the checkpoint record.

---

### Spike S1 (parallel, anytime): stOLAS slashing pass-through

**Shape:** `spike` — output is a finding note, no code merges.
- [ ] From our previous stOLAS deployment + contract reading: how does a slash on an underlying
      service hit the pool? Is an operator co-bond slice supported natively, or does Tier-3(a) need
      a thin wrapper?
- **Human surface:** one-page finding note with contract references; Oak reads and stamps it.
  **Blocks v0.5 mechanics, not v0.**

### Spike S2 (parallel, anytime): Ethereum-mainnet Mech Marketplace

**Shape:** `spike`.
- [ ] Verify whether the Mech Marketplace is live on Ethereum mainnet (ours is Base); if yes,
      sketch the recurring epoch-execution job; if no, Chainlink backstop stands (spec §6.2 v1b).
- **Human surface:** finding note with addresses/links; Oak stamps. **Gates only the v1b dogfood
  experiment.**

---

## Task order and review cadence

```
Task 1 (consume)     ──┐
Task 2 (schema) GATE ──┼─→ Task 3 (scrub preview) → Task 4 (publish+ledger) → Task 5 (fork, dogfood)
                       │                                                        ↓
Spikes S1, S2 (parallel, any time)                    Task 6 (seeds) GATE → Task 7 (signal) → Task 8 (gate)
```

One PR per task, reviewed by Oak; Tasks 2 and 6 stop the line until approved. Every PR description
carries its Human surface block so the review is a checklist, not archaeology.
