# Design prompt — the task harvester: consent-gated commit-echo mining as the demand-side intake valve

**Date:** 2026-07-31

**Shape:** `design` — output is one specification (plus a dated amendment to the plugin
clean-slate design where the mint extension point is filled). No code, no package moves.

> **RETIRED 2026-07-31, the same day it was written — superseded by**
> [`2026-07-31-verified-environment-supply-design-prompt.md`](./2026-07-31-verified-environment-supply-design-prompt.md).
>
> The session ran from this charter, commissioned its research lanes, and worked Q1 and Q2 to
> settled answers. Those answers did not survive two operator-driven collapses of the product
> framing:
>
> 1. **Consent is not a feature for public repositories.** An open-source license already
>    grants derivation and redistribution. The consent ceremony designed in Q1 is load-bearing
>    only where the license is missing or unclear. With consent demoted from product core to
>    optional endorsement, the repo owner leaves the v1 loop — and with them the plugin attach
>    point this charter assumed.
> 2. **The residue — "a task-supply pipeline" — is what SWE-rebench already is**, and the Jinn
>    daemon already imports its rows. Commit-echo mining without rebench's curation layer
>    produces a candidate stream whose majority is flawed.
>
> Two operator observations then redirected the design: procedural injection needs only a
> working environment (so it multiplies *every* imported environment rather than waiting for a
> later stage), and environment reliability — rebench's real weakness — fixes evaluation for
> all tasks from a repository at once. Market research confirmed both: environments sell for
> $20k–$300k against $200–$2,000 per task, and nobody offers third-party-verifiable
> environment attestation.
>
> **Retained from this charter** (carried into the successor as settled): the capability is
> standalone tier-3, never daemon-embedded, its output sealed documents; the legacy
> harvest-loop is frozen reference, superseded at a gate. **Reopened:** consent's role,
> echo-only scope, the plugin as primary consumer, held-out material, statement derivation,
> license posture, and self-farming enforcement.
>
> The evidence this session produced survives in
> [`../notes/2026-07-31-task-supply-research-findings.md`](../notes/2026-07-31-task-supply-research-findings.md).
> This file is kept unedited below as the record of what was chartered and why it was wrong —
> the method surfaced the collapse before any code existed, which is the method working.

---

## 0. Read this first, before the objective

The platform has two intake valves and has designed only one. **Capture** brings the
supply side's data in: operators run work, the plugin records sessions as Execution
Evidence, the corpus grows. **Harvesting** is the demand-side twin: a repo owner consents
to having tasks mined from their pushed open-source work — fix commits become
SWE-bench-style instances (problem statement + gold patch + held-out regression test) —
and those tasks flow into the marketplace as verifiable demand. The privacy argument is
structural, not procedural: instead of publishing scrubbed transcripts (which, even
scrubbed, carry risk), the input is content the user already made public, and the only new
obligations are consent and license — both of which this session makes verifiable.

The stack already anticipated this product and left it an empty seat:

- The repository-work profile carries a `provenance` block with
  `kind: mined | synthetic | live`, and the profiles design's own worked example (§10.3)
  is commit-echo: "a row becomes a repository-work Task plus a per-instance
  `deterministic-process` EvaluationSpec." The old `merged-pr` source "dissolves" into
  mined provenance + a gold-test deterministic spec (§8).
- Held-out evaluation is first-class: per-artifact access classification (spec bytes
  public, test material private) resolved only via the evaluation Submission's
  `capabilityGrants` (profiles §7.1, TEP §7.5). The solver never sees the gold patch.
- TEP §7.4's requester-neutral tasks make harvested tasks reusable public goods: "a
  benchmark task attempted across networks is not owned by its first submitter."
- The benchmarking application declares task authoring a non-goal (§19). Nothing in the
  stack produces mined tasks; everything downstream already consumes them.

There is also a working reference implementation: `client/src/daemon/harvest-loop.ts` and
the swe-rebench-v2 minted-pool machinery — commit-echo extraction, staged validation
(discovered → recipe → image → environment → empirical → admission → ipfs → complete),
Docker-gated empirical validation, differential-admission receipts, and a provenance model
that already has the right bones (`sourceLineageHash` for echo-collapse, `blindedUntil`,
`sourceSolverSafe` blocking the echo source from claiming its own echo). It is
daemon-embedded, config-driven, and product-welded — the same disease the plugin trio had,
and it gets the same cure: **frozen as reference, superseded by a standalone capability,
never migrated wholesale.**

Two failure modes to guard against:

1. **Designing the consent record as an afterthought.** Consent is the product's whole
   legitimacy story and the only place it touches the foundation. A consent mechanism
   that third parties cannot verify without trusting the harvester reduces the product to
   "we promise." Sealed is forever: consent must demonstrably precede sealing, and
   revocation can delist from discovery but never unseal — the record design must be
   honest about that asymmetry.
2. **Re-deriving what the stack owns.** Task sealing, EvaluationSpec authoring, held-out
   access, submission, escrow, and provenance carriage all have owners. The mining
   capability composes them. Where a stack surface cannot serve the harvester's need, that
   is a finding with a proposed disposition against the owning spec — never a fork.

## 1. Objective

Answer three questions, in order. Do not start a question until the previous answer is
approved.

**Q1 — The consent + source-license record (tier 2).** Design the DSSE assertion record
kind by which a repo owner consents to mining. Its shape (subjects: repository identity,
ref/commit scope, license, expiry/scope-of-use); how the signing identity is bound to
actual repo control (the spoofing problem: anyone can sign a statement *about* a repo —
what proves the signer controls it?); how source license is expressed and how it travels
with derived task content; the revocation record and its exact semantics (stops future
mining, delists from discovery, never unseals); and how each harvested task references the
consent assertion by digest from its provenance block. Run the standards audit (§3 of the
principles): DSSE + in-toto attestation framing, SPDX license expressions, GitHub artifact
attestations / sigstore identity binding, domain- and repo-control proof comparables —
compose before inventing.

**Q2 — The mining capability (tier 3).** The standalone package whose one job is
*consenting repository → sealed Task + EvaluationSpec pairs*. Its boundary (output is
sealed documents; submission is explicitly not its job); its input contract (repository
access, a verified consent assertion, mining policy); what carries over from the legacy
pipeline and what does not (the staged validation state machine, Docker-gated empirical
validation, differential admission, the failure taxonomy); how it populates
`provenance.kind: mined` with lineage (`sourceCommitment`, echo-collapse support, the
self-echo exclusion generalized beyond `sourceSolverSafe`); dedup semantics across
independent harvesters (digest identity handles exact duplicates — decide whether near-dup
lineage is in scope); whether the gold patch rides as a private access-classified artifact
or stays out of the published record entirely; and its conformance fixtures (kits precede
implementations). Custody law applies: the capability takes signer objects and repository
access it never owns.

**Q3 — The product composition (tier 4) and the requester on-ramp.** How the plugin
product composes the capability at its parked mint extension point (the reconciliation
design's scope note: "No outbound publication, mint lane, or consent surface in this scope
— extension points"): the consent flow in the user's session (who supplies the signer, per
custody law), when mining runs (in-session vs a batch verb — empirical validation is
Docker-heavy), and how minted pairs reach the marketplace. This question owns the
requester on-ramp reconciliation: the marketplace binding's `postTask` /
`makeMarketplaceBackend().submit` path exists but the production `SafeBroadcastPort`
wiring (chain client + Safe + intent store) is a type awaiting M2.4/M2.5, and the promised
SDK/CLI requester surface is unbuilt — the harvester is that surface's first real
customer. Decide what this session designs versus what it files as findings against the
binding program. Also: fee economics (echo tasks escrow real delivery fees at post time —
who funds, at what default `PostingTerms`); the daemon as secondary consumer (operator
batch-mining under operator identity, versus the plugin's repo-owner identity — the
requester of record follows the consent signer); and the legacy harvest-loop's
supersession gates (frozen as reference now; refit or retired only when the capability
demonstrably covers swe-rebench-v2 minting — not pre-emptively).

## 2. What is settled — treat as law

- **Three decisions from the 2026-07-31 chartering discussion** (operator-approved,
  recorded in this prompt as their canonical in-repo statement):
  1. Repo-owner consent + source license is a **tier-2 DSSE assertion record kind**, using
     the trust layer's assertions-about-records envelope (TEP §21.2), referenced by digest
     from each harvested task's provenance block. Consent precedes sealing; revocation
     delists, never unseals.
  2. **V1 mints echo tasks only** (`provenance.kind: mined`). Live-work forwarding (open
     issues → real marketplace demand) is a named future extension point, not designed
     here — it is a second product with a different risk profile (result application, open
     evaluation, pricing UX).
  3. **Mining is a standalone tier-3 package**, never daemon-embedded. Its job ends at
     sealed Task + EvaluationSpec pairs; submission stays with the backend contract /
     marketplace binding; products compose the two. **The plugin product is the primary
     consumer** (filling its mint extension point); the daemon is an optional secondary;
     the legacy harvest-loop is frozen reference, superseded at a gate.
- **The platform architecture** (DR-2026-07-30,
  [`../specs/2026-07-30-jinn-platform-architecture.md`](../specs/2026-07-30-jinn-platform-architecture.md)):
  the tier law — nothing in tiers 1–3 names a product; guard trio and conformance kits per
  the executable-architecture rule.
- **The stack designs own their concerns**:
  [`../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md`](../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md)
  (repository-work profile, `provenance` block, EvaluationSpec families, access
  classification, §10.3 commit-echo mapping),
  [`../specs/2026-07-27-task-execution-protocol-and-stack-design.md`](../specs/2026-07-27-task-execution-protocol-and-stack-design.md)
  (sealing, requester-neutral tasks §7.4, confidential inputs via `capabilityGrants`
  §7.5, backend contract `submit`),
  [`../specs/2026-07-28-marketplace-binding-design.md`](../specs/2026-07-28-marketplace-binding-design.md)
  (posting §6.1, `PostingTerms`, requester protections §5.3),
  [`../specs/2026-07-27-trust-and-identity-layer-design.md`](../specs/2026-07-27-trust-and-identity-layer-design.md)
  (assertion envelope, identity binding),
  [`../specs/2026-07-28-benchmarking-application-design.md`](../specs/2026-07-28-benchmarking-application-design.md)
  (task authoring is its non-goal; Benchmark records reference already-sealed Tasks).
- **The plugin clean-slate design and program**
  ([`../specs/2026-07-30-plugin-stack-reconciliation-design.md`](../specs/2026-07-30-plugin-stack-reconciliation-design.md),
  [`../plans/2026-07-30-plugin-clean-slate-program.md`](../plans/2026-07-30-plugin-clean-slate-program.md)):
  the plugin product's v1 scope (capture + retrieval), its host seam, its parked mint
  extension point, and the program's fifteen cross-plan contracts. This session fills the
  mint slot by dated amendment; it does not reopen the plugin design.
- **The custody law** (consumption-boundary design,
  `2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`): no key material
  in packages, no ambient authority acquisition, signer-object-only APIs, fail-closed
  verification, trusted-publisher provenance.
- **Sealed once, forever** (principles §5): consent must precede sealing; nothing
  unseals. The evidence-contribution design
  ([`../specs/2026-07-26-evidence-contribution-design.md`](../specs/2026-07-26-evidence-contribution-design.md))
  owns *operator* consent to contribute their own evidence — its "implied license is not
  consent" posture is precedent, but repo-owner mining consent is a distinct, new record.
- **The collected principles**
  ([`../specs/2026-07-30-stack-design-principles.md`](../specs/2026-07-30-stack-design-principles.md)):
  §3 standards audit, §9 kits-first, §12 session method, §13.1 designs-are-law findings
  discipline.

## 3. What is explicitly unsettled — bring a conclusion, not a summary

- The repo-control proof: what binds the DSSE signer to actual authority over the mined
  repository (a committed file in the repo? a signed tag? a platform attestation? DNS for
  self-hosted remotes?) — and what the verification story is for a third party holding
  only the sealed task and the consent assertion.
- License handling policy: which source licenses are minable at all, whether license terms
  constrain the derived task's own license, and where a license-incompatibility rejection
  lives in the pipeline (the audit should say whether SPDX expressions suffice).
- Adversarial mining: a *consenting but malicious* repo owner minting poisoned or gamed
  tasks (trivial tests, self-echo farming, adversarial problem statements). What
  differential admission must catch, what trust-layer standing the assertion carries, and
  what stays an application-policy concern for task consumers.
- The gold patch's disposition: private access-classified artifact on the record (useful
  for later attested evaluation and distillation) versus held entirely off-record (today's
  posture by omission).
- Fee economics for echo tasks: posting escrows real OLAS delivery fees — whether v1
  defaults to miner-funded, subsidy-funded, or mints-without-posting into a local pool
  with posting as a separate decision.
- The requester on-ramp split: which of the SDK/CLI surface and `SafeBroadcastPort`
  production wiring this session designs, and which it files as findings against the
  marketplace binding program (M2.4/M2.5).
- Whether the mining capability's Docker-gated empirical validation is one package or a
  boundary worth splitting (environment binding already has machinery in the minted-pool
  lineage; check what the local backend's environment surfaces now own).
- Naming, per principles §13.5: "task harvester" is a working title settled in one pass.

## 4. The reconciliation that matters most

**The harvester is the platform's first external requester.** Every prior task creator is
in-house daemon machinery. This product exercises the whole demand-side story an outside
party would: author against the profile, seal, hold out evaluation material, prove
consent, submit through the binding, escrow fees — using only published surfaces. Every
place that story breaks is a dev-x finding against the owning stack program, surfaced with
a disposition; the session's success is measured as much by the findings list as by the
spec. The pairing with capture completes the flywheel: harvested tasks generate
marketplace attempts, attempts generate captured evidence, the corpus grows — one product
in the user's session, two valves.

## 5. Session gates and triggers

- **Gate to open:** the stack packages the capability composes are consumable
  (task-execution protocol/profiles and the marketplace binding's posting surface exist on
  the integration branch now; published canaries per #2293 are needed only by
  implementation, not by this design).
- **Trigger:** operator judgment. Natural forcing functions: the plugin program reaching
  the point where the mint extension slot needs its contract; or the requester on-ramp
  work (M2.4/M2.5) wanting its first real consumer's requirements.
- **This session must not gate:** the plugin clean-slate program (the mint slot is an
  extension point precisely so v1 ships without it), the daemon cutover, or the
  marketplace binding program.

## 6. Method

Per principles §12. Suggested research lanes:

1. **Consent + identity standards audit** — DSSE/in-toto attestation shapes, sigstore and
   GitHub artifact attestations for identity-to-repo binding, SPDX license expressions,
   revocation comparables (Rekor-style transparency, CRL-style lists) — the Q1 raw
   material.
2. **Legacy capability inventory** — `harvest-loop.ts`, the swe-rebench-v2 minted-pool
   and commit-echo modules, field-by-field: what the staged pipeline does, what the
   validation gates prove, what the provenance model carries; classify each element
   carry-over / re-derive / drop.
3. **Requester on-ramp probe** — code-level walk of `packages/marketplace/binding`
   (`posting.ts`, `backend.ts`): exactly what a production caller must wire, what exists,
   what M2.4/M2.5 owes; the Q3 findings raw material.
4. **Profiles/EvaluationSpec mapping verification** — re-verify the chartering
   discussion's finding against code and spec text: the commit-echo → repository-work +
   deterministic-process mapping, access-classification mechanics, and any gap between
   the profile's `provenance` block and what mining needs to record.
5. **Adversarial review lane** at the end, per the house two-review rule — with the
   poisoning, consent-spoofing, license-laundering, and self-echo cases called out
   explicitly.

One material question at a time; section-by-section approval; one specification; two
fresh reviews before presenting; commit only on explicit approval.

## 7. Scope discipline — what this session does not own

- Live-work forwarding (`provenance.kind: live`) — named as an extension point, designed
  never.
- The marketplace binding program's execution (M2.4/M2.5 wiring, contract revisions,
  deploys) — findings and requirements go to it; work does not happen here.
- The plugin clean-slate program's v1 scope — this session fills the mint extension point
  by dated amendment and changes nothing else.
- Protocol or profile changes — findings with dispositions to the owning specs
  (the profiles spec owns the `provenance` block; TEP owns sealing and grants).
- Benchmarking composition — Benchmark records consume sealed Tasks; how benchmarks are
  assembled from harvested pools stays in the benchmarking application's territory.
- Executing any supersession of the legacy harvest-loop — this session sets the gates;
  the daemon's programs execute them.

## 8. Success criteria

1. One specification under `docs/superpowers/specs/`, sections approved one at a time.
2. The consent + source-license assertion record kind fully specified: shape, identity
   binding, license carriage, revocation semantics, verification story — with the
   standards audit on the record.
3. The mining capability's boundary and surface: inputs, outputs, validation pipeline,
   provenance population, dedup/lineage semantics, conformance-fixture plan — composing
   stack surfaces with zero re-derivation of owned concerns.
4. The product composition: the plugin mint-slot contract (dated amendment to the
   clean-slate design), the consent flow's custody story, submission wiring, fee-economics
   decision, and the daemon-as-secondary-consumer story.
5. A findings list against the requester on-ramp (marketplace binding program) — the
   first-external-requester dev-x audit, each finding with a proposed disposition.
6. Supersession gates for the legacy harvest-loop, named but not executed.
7. A follow-ups list with owners, including the live-work extension's parking record.
