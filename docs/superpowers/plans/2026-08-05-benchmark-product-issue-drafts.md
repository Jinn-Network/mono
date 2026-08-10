# Standalone Benchmarking Product — Draft Issue Bodies (M0–M5)

Companion to `2026-08-05-standalone-benchmarking-product-program.md` §7. This
session has no issue-mutation authority; these drafts are triage-complete so an
authorized session can file them verbatim. One draft per work packet. Issue
Type = the work shape. All issues depend on the `integration/evidence-v1`
lineage (NOT `next`); the required base is stated per issue. Drafts frame
problems and acceptance; implementation choices live in the program plan and
the product design spec, cited rather than restated. M2–M5 drafts were appended
at their implementation boundaries. None has been filed by this local-only
session.

---

## Draft 1 — BP-00 · `design` · Product design spec for the standalone benchmarking product

**Context.** The Tier 2/3 benchmarking platform is implemented
(`@jinn-network/benchmarking-*`), and its design explicitly reserves the
product layer for Tier 4 (application design §2, §17.4; plan line "the
composing CLI is a tier-4 product (OUT)"). A separately branded product
charter (v0.2, 2026-08-05) fixes customer, scope, and posture. No catalog
authority document exists for a benchmarking product package.

**Impact.** Without a dated design spec there is no authority document for the
catalog entry, and product decisions live only in session context.

**Acceptance criteria (binary).**
- [ ] `docs/superpowers/specs/2026-08-05-benchmark-product-design.md` exists,
      header-complete per spec conventions, status `draft`.
- [ ] States the consumption contract (exact platform packages + verified
      exports; no deep imports; no record redefinition; no `core`/`sdk`).
- [ ] Defines the product state machine, audit journal, and two-surface
      (library+CLI / GUI) parity commitment.
- [ ] Carries the assurance-preset → platform-primitive mapping and the venue
      honesty tables.
- [ ] Proposes no tier 1–3 change, record kind, or protocol amendment.

**Dependencies / base.** `integration/evidence-v1` ≥ `ad33f1d0d`.

**Non-goals.** No implementation, no catalog edit, no branding decisions
beyond the placeholder posture.

---

## Draft 2 — BP-01 · `feat` · Register and scaffold `packages/benchmark-product/core`

**Context.** The product needs a Tier 4 tree registered in
`architecture/platform-packages.v1.json` with the standard guard trio and its
own CI gate before any domain code lands (guards ship with packages, not
after — platform architecture §3).

**Impact.** Without registration + guards, product code would sit outside the
executable architecture and could silently violate the tier boundary.

**Acceptance criteria (binary).**
- [ ] `packages/benchmark-product/core` builds: `yarn install --immutable &&
      yarn typecheck && yarn test && yarn build && yarn pack:smoke` all green.
- [ ] Catalog entry (tier 4, product, experimental, transitional-or-private,
      publishPolicy never) added; release-group `expectedPackageCount` bumped;
      gate `benchmark-product-ci` defined and workflow present.
- [ ] `node .github/scripts/generate-architecture.mjs --check` green;
      platform-catalog + architecture-control `node --test` suites green.
- [ ] `.github/scripts/benchmark-product-{package-inventory,source-boundaries,packed-types}.test.mjs`
      exist and pass; the source-boundary guard is allow-list style with
      positive controls (imports actually exercised).
- [ ] Nothing under tiers 1–3 references the new tree.

**Dependencies / base.** Draft 1 (spec is the authority document). Base:
integration head after BP-00.

**Non-goals.** No domain logic, no CLI verbs beyond a version stub, no web
app, no publishing.

---

## Draft 3 — BP-10 · `feat` · Product workspace, draft model, lifecycle, audit journal, authority v1

**Context.** The product owns mutable drafts and previews; the platform owns
sealed records (charter §11). Nothing implements a draft/lock/run product
state machine today (verified 2026-08-05: no lock/preview/assurance-preset
code in the repo).

**Impact.** This is the single state machine both surfaces (agent CLI, later
GUI) must share; without it every later packet has no spine.

**Acceptance criteria (binary).**
- [ ] File-based workspace with atomic writes; mutable draft documents
      (task-set ref, arms, evaluation choice, assurance preset, policy,
      budget) validated with typed errors.
- [ ] Lifecycle: draft → quoted → locked → running → closed → reported, with
      preview as a non-contaminating side path; illegal transitions rejected.
- [ ] Append-only JSONL audit journal; every consequential operation appends
      an attributed entry (principal, action, input digest, outcome).
- [ ] Authority v1: named principals (sponsor, delegated agent), per-operation
      approval policy enforced at the operations boundary; honest scope note
      that v1 is local-process policy, not hosted multi-tenant auth.
- [ ] TDD evidence: failing tests precede implementation in packet history.

**Dependencies / base.** Draft 2. **Non-goals.** No execution, no GUI, no
network, no SQLite.

---

## Draft 4 — BP-11 · `feat` · Task intake: bundled sample, SWE-bench-shaped import, arm definition

**Context.** The charter journey starts "sample or import" (§7). The platform
provides `importSweBench` / `defineBenchmark` / `importInspectEvals`
(`benchmarking-interop`) and sealed Task + EvaluationSpec machinery; the
product owns the intake journey.

**Acceptance criteria (binary).**
- [ ] From an empty workspace, a bundled sample produces a draft with a sealed
      Benchmark (≥ 2 items) and ≥ 2 arms without network access.
- [ ] SWE-bench-shaped rows import to a sealed Benchmark via public interop
      exports only.
- [ ] Arm definition accepts the profiles run-pinning vocabulary; an
      `inspect` operation shows the exact pinning per arm and the evaluation
      digest per task.
- [ ] Invalid intake (duplicate items, missing evaluation) fails with typed
      errors mapping to the platform's named checks.

**Dependencies / base.** Draft 3. **Non-goals.** No task authoring studio; no
Inspect-solver sealing beyond what interop supports; no marketplace posting.

---

## Draft 5 — BP-12 · `feat` · Official run path on the local venue: lock, launch, watch, assemble, account

**Context.** Lock = sealing the Run record (identity is pre-registration —
application design §7.2). The platform provides `planRun`, `quoteRun`,
`launchAndWatch`, `assembleMatrix`, `localAssemblyPorts`;
`policy-optimization/src/execute.ts` is the composition precedent.

**Acceptance criteria (binary).**
- [ ] Lock seals the Run and refuses further draft mutation of that run.
- [ ] A real 2-arm run executes end-to-end on the local execution backend
      (real launcher, no mocks presented as production behavior).
- [ ] The Matrix accounts every expected cell; results JSON surfaces all six
      outcome states, attrition, completeness, and per-cell digests.
- [ ] Interruption resumes (cell idempotency); the run never restarts silently.
- [ ] Venue honesty: the local run's guarantee limits (no pre-registration
      proof against the owner) appear in the machine-readable results.

**Dependencies / base.** Drafts 3, 4. **Non-goals.** No marketplace venue; no
report production; no cancellation UX (M2 depth).

---

## Draft 6 — BP-13 · `feat` · Report production, claim package, and the skeptic's verify

**Context.** `produceReport`/`verifyReport` (aggregate) and `verifyMatrix`
(run) exist as library functions; their composition is explicitly reserved for
Tier 4. The durable output is a distribution-ready claim package (charter §2).

**Acceptance criteria (binary).**
- [ ] A sealed, DSSE-signed Report is produced from the Matrix via the
      registered method registry; `disclosures` carried whole.
- [ ] A machine-readable claim package links report/matrix/run/benchmark
      digests, preserves scope + limitations, and never hides missing cells,
      conflicts, or adverse results.
- [ ] `verify` composes matrix re-derivation + report recompute + signature
      verification; exits nonzero naming the failed check on any tampering.
- [ ] Dissenting verdicts remain visible in report + claim package.

**Dependencies / base.** Draft 5. **Non-goals.** No HTML report surface (M4);
no badges/share assets (M4); no publication hosting.

---

## Draft 7 — BP-14 · `test` · Agent-surface CLI end-to-end walking skeleton

**Context.** Agent-native parity is a fixed decision: the CLI (with `--json`
everywhere) is the complete agent surface for M1; a cold agent must complete
sample → arms → evaluation → lock → run → results → report → verify without a
GUI.

**Acceptance criteria (binary).**
- [ ] One scripted e2e drives the full lifecycle through CLI verbs only, all
      outputs machine-readable, and passes in CI.
- [ ] At least one recorded run used a real launcher on the local backend;
      its artifacts are preserved as evidence.
- [ ] Every operation available in the library is reachable via a CLI verb
      (asserted by a coverage test), and no CLI verb bypasses the operations
      boundary.
- [ ] Typed error envelopes on every failure path exercised by the e2e.

**Dependencies / base.** Drafts 3–6. **Non-goals.** No GUI, no MCP, no
performance tuning.

---

## Draft 8 — BP-20 · Disclosed real-venue previews and honest quote presentation

**Context.** The walking skeleton can lock and run an official benchmark, but
the charter also requires forgiving pre-lock rehearsal and quote-before-
commitment. Rehearsal must never contaminate official records, and an estimate
must identify its actual source rather than present invented precision.

**Impact.** Without this depth, a sponsor cannot test configurations before
lock or understand execution volume, venue coverage, cap posture, and likely
runtime while preserving the official result's credibility.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-14. Required packet base:
`9ad21c6b1` on the current `integration/evidence-v1`-derived program lineage.

**Acceptance criteria (binary).**

- [ ] A preview runs a caller-bounded subset on the real local venue, is
      labeled rehearsal/not official evidence, and never seals a Run or
      advances lifecycle state.
- [ ] Previewed and unpreviewed compilation of the same draft produces
      byte-identical official Run bytes; preview artifacts are excluded from
      official state.
- [ ] Quote presents solve/evaluation cell volume, per-arm lines, coverage and
      refusals, hard-cap posture, and venue guarantees from the platform quote
      and real venue capabilities.
- [ ] Wall-time estimation is present only when real rehearsal timings exist
      and is labeled estimate-from-rehearsal.
- [ ] Rehearsal history reaches Report limitations and the claim package;
      CLI/library parity and the real-venue battery pass.

**Non-goals.** No official result from a preview, pricing invention,
marketplace implementation, or GUI.

---

## Draft 9 — BP-21 · Complete assurance presets, multi-evaluator execution, and dissent

**Context.** The charter makes evaluation assurance a differentiator. The
product initially runs only the direct-check shape; the remaining preset
mappings, evaluator identity resolution, multiple verdicts, and disagreement
accounting must become real local-venue behavior without claiming party
independence.

**Impact.** A label-only panel or strict-agreement option would misrepresent the
method, cost, and trust boundary, while discarded dissent would make published
claims materially incomplete.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-20. Required packet base:
`756bd7ac8` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Direct check, Separate evaluator, Evaluator panel, and Strict agreement
      resolve to the design-authority primitives and run on the real venue.
- [ ] Required verdict count and reduction rule are sealed before launch and
      enforced during dispatch and assembly.
- [ ] Evaluator identities resolve only after signature verification; distinct
      keys are described as agent-distinctness, never party independence.
- [ ] Panel dissent and strict-agreement conflict survive Matrix, results,
      Report, and claim surfaces with every verdict retained.
- [ ] Quote volume reflects required evaluation legs; tampered identity or rule
      facts fail closed; full battery and parity pass.

**Non-goals.** No claim that a majority is true, external custody proof, new
protocol term or record field, or marketplace evaluator supply.

---

## Draft 10 — BP-22 · Durable cancellation and infrastructure/task accounting

**Context.** The run path needs authority-gated cancellation that survives
process interruption and reaches the backend terminal boundary. It also needs
explicit separation of task failure, infrastructure failure, unscorable work,
expiry, and undispatched cancellation cells.

**Impact.** A best-effort stop or denominator collapse can lose work, double-
attribute actions, mis-score infrastructure faults as agent losses, and publish
an incompletely accounted run.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-21. Required packet base:
`bc0868d62` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] A real nonterminal local subprocess receives backend cancellation,
      terminalizes by signal, and produces a `cancelled` Matrix in which every
      expected cell is accounted.
- [ ] Cancellation is gated, typed, idempotent, durable before venue probing,
      and an interrupted cancel resumes through `cancel`.
- [ ] `collect` and `cancel` serialize across processes; stale/unknown/live
      owner cases and crash recovery are deterministic and fail closed.
- [ ] Subprocess kill, task error, infrastructure error, unscorable, expired,
      and undispatched cancellation paths stay distinct; only judged cells
      enter score denominators.
- [ ] Results, Report, claim, verification, parity, guards, and full real-venue
      battery pass.

**Non-goals.** No product-side orchestration fork, distributed consensus,
hiding cancellation as deletion, or GUI implementation.

---

## Draft 11 — BP-30 · Register the private web shell and app specification

**Context.** The product needs a human surface, but operations wiring must not
land before the web package, four-axis app specification, brand isolation,
architecture membership, guards, and CI are established.

**Impact.** An unregistered frontend or one that silently adopts Jinn product
identity would violate executable architecture and the separate-brand charter.

**Issue Type.** `design`.

**Dependencies / base.** Depends on BP-22 for integration order. The packet was
created early from `bc0868d62`, then integrated only after BP-22 with a staged
conflict review; preserve both facts when filing.

**Acceptance criteria (binary).**

- [ ] Private Next.js App Router + shadcn/ui package exists with a complete
      four-axis app spec beside its source.
- [ ] Cold landing page explains the category without Jinn lexicon, sigils,
      palette, hero attribution, or an invented final brand.
- [ ] Install, lint, typecheck, unit test, and optimized build pass under Node
      22.
- [ ] Catalog, CI, package inventory, source boundary, architecture generation,
      and explicit packed-entrypoint exclusion cover the web member.
- [ ] No operations control, core dependency, record handling, or local
      semantics lands in this packet.

**Non-goals.** No operations wiring, real run, GUI parity, API route, hosted
deployment, or public package entrypoint.

---

## Draft 12 — BP-31 · Wire setup, intake, preview, quote, lock, and GUI parity

**Context.** The web shell must become a server-side client of the same core
operations library used by agents. Setup through lock is the first human flow,
and every rendered action needs a generated parity row.

**Impact.** Direct file reads, browser-side core imports, or web-owned validation
would create a second product implementation and break surface equivalence.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-30. Required packet base:
`a605e0bbc` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Web has exactly one production Jinn dependency: the public core entry,
      imported only in server-only modules.
- [ ] Routes and actions cover workspace, draft, sample/import, arms, sponsor
      grant/revoke, real preview, quote, and gated lock without direct workspace
      reads or duplicated semantics.
- [ ] Product context requires an absolute server-selected workspace and
      principal; secrets and unexpected runtime details do not reach browser.
- [ ] Every GUI action maps bidirectionally to the generated matrix; future run
      and result actions remain explicit named deferrals.
- [ ] A production browser flow reaches a locked two-arm sample at desktop and
      390 px; package, pack, guard, and architecture batteries pass.

**Non-goals.** No run monitor, results/Report view, publish surface, HTTP API,
or second operations layer.

---

## Draft 13 — BP-32 · Durable real-run monitoring and cancellation in the GUI

**Context.** A locked browser draft needs launch, status, resume, cancellation,
and collect while the exact core operation promise can outlive a Server Action
response. Refresh must read durable truth, not an in-memory promise.

**Impact.** Losing a response-bound driver or exposing raw backend diagnostics
would make the human surface less reliable and less safe than the agent surface.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-31. Required packet base:
`0009676d0` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Launch, resume, status, cancel, and collect GUI actions call public core
      operations in process; no CLI child, route handler, or web driver appears.
- [ ] Durable driver generations distinguish accepted ownership from a
      contender, retain late readiness/shutdown failures, and survive refresh.
- [ ] A real delayed local subprocess walks active → requested/draining →
      terminal cancelled, accounting every expected cell.
- [ ] Browser projections retain typed recovery categories while redacting
      paths, arbitrary diagnostics, and test-control values.
- [ ] Desktop/390 px production paths, parity, packages, guards, packed
      consumer, and architecture controls pass.

**Non-goals.** No browser-owned orchestration truth, API route, arbitrary delay
product setting, or results/Report implementation.

---

## Draft 14 — BP-33 · Semantic results, Report, claim, and verification GUI

**Context.** M3 is incomplete until a human can inspect the exact sealed Matrix,
Report, claim, dissent, failures, and named verification checks through core.
Raw JSON alone is not an adequate human surface.

**Impact.** Recomputed web statistics, omitted adverse facts, or stale
verification status could contradict agent output and overstate a claim.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-32. Required packet base:
`5ba7d3afe` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Results semantically renders Matrix completeness, attrition, asymmetry,
      every cell/verdict/dissent/failure/axis fact, and venue limits from
      `runResults` without recalculation.
- [ ] Report and Claim facts remain source-distinct and reload-durable; Report
      arm results/conflicts and verdict validity membership are visible.
- [ ] `runVerify` exposes named checks and exact digests; not-run, success, and
      typed failure states cannot be confused.
- [ ] Generated GUI parity has no deferred operation row beyond explicit
      non-operation exclusions.
- [ ] Full real lifecycle passes in optimized desktop and 390 px browsers
      without Flight serialization errors or document overflow.

**Non-goals.** No new statistic, record reader, claim reconciliation, publish
control, EvalLog viewer, or hosting.

---

## Draft 15 — BP-40 · Immutable deletion-portable public bundle and verifier

**Context.** The charter's durable outcome must outlive the mutable product
workspace. Report and claim operations exist, but no allowlisted public closure,
immutable local materializer, or standalone verifier proves the evidence after
source deletion.

**Impact.** A presentation-only export would leave readers dependent on the
product and unable to authenticate record closure, trust roots, method, claim,
or missing and cancelled evidence.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on completed M3/BP-33. Required packet base:
`307737877` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Gated `publish` emits one immutable, no-overwrite, digest-addressed local
      bundle from a reported draft only after workspace verification passes.
- [ ] Manifest allowlists exact records, evidence graph, Report/claim bytes,
      public trust, assembly facts, optional cancellation, and five reserved
      assets while excluding drafts, grants, journals, scratch, paths, secrets,
      and private keys.
- [ ] Standalone library/CLI verification uses only one authenticated bundle
      snapshot and returns six named checks after source-workspace deletion.
- [ ] Graph, coordinate, trust-key, manifest, path, tamper, substitution,
      symlink/hardlink/special-file, missing/extra, and partial-lineage
      adversaries fail closed.
- [ ] Complete and drained-cancelled real local runs publish and reverify;
      library/CLI/GUI parity, packages, guards, and architecture battery pass.

**Non-goals.** No upload, hosting, deploy, package publication, private-key
export, new record format, or winner selection.

---

## Draft 16 — BP-41 · Distribution-ready static Report and claim assets

**Context.** BP-40 reserves five presentation paths, but market-ready output
requires accessible, hostile-content-safe static bytes that preserve exact
Matrix, Report, Claim, and dissent facts without blending or new conclusions.

**Impact.** An attractive but incomplete badge, card, or report could broaden a
claim, hide adverse facts, or become unverifiable after copy.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-40. Required packet base:
`080f4d8e2` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] One deterministic projection builds `index.html`, `badge.svg`,
      `social-card.svg`, `README.md`, and `share.txt`; materializer and verifier
      byte-compare the same outputs.
- [ ] Full HTML/README label Matrix, Report, Claim, and verification-assembly
      sources separately and preserve completeness, attrition, conflict,
      method, disclosures, limitations, trust, dissent, and raw record links.
- [ ] Compact assets lead with no-winner, adverse outcome, scope, full Report
      identity, exact accessible arm ids, and limitations/verification paths
      without clipping at extreme valid identifier lengths.
- [ ] Destination escaping, no active/remote content, semantic accessibility,
      print, desktop, and 390 px containment pass.
- [ ] Copied complete/cancelled bundles verify after source deletion, and
      independent tampering of each asset fails.

**Non-goals.** No new file role/version, interactive app, hosting, winner,
certification, or reconciliation of inconsistent stored facts.

---

## Draft 17 — BP-50 · Production accessibility and security hardening

**Context.** The private human surface and public bundle have functional
coverage, but M5 requires production-build accessibility, response policy,
confidentiality regression, safe error projection, filesystem ownership, and a
documented local threat boundary.

**Impact.** Unit-only accessibility or config-only headers can miss real browser
violations, leak paths or keys, permit capabilities, or make temporary cleanup
unsafe under crash and concurrency.

**Issue Type.** `feat`.

**Dependencies / base.** Depends on BP-41/M4. Required packet base:
`c9f1e942d` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Product-owned optimized Chromium gate audits every route and material
      lifecycle/error state at desktop and 390 px with zero axe violations and
      no waiver filter.
- [ ] Keyboard-only real local lifecycle, skip/focus/live-region/heading/control
      behavior, reduced motion, 200% reflow, and containment pass.
- [ ] Real HTML/Flight responses enforce no-store, CSP, frame denial, nosniff,
      no-referrer, and an exact version-pinned empty Permissions Policy.
- [ ] Build/runtime/credential sentinels, absolute paths, and actual private-key
      bytes are absent from browser, chunk, and copied-bundle surfaces;
      unexpected diagnostics are typed and redacted.
- [ ] UUID owner-marked browser workspaces fail closed under collision/tamper,
      copied bundle verifies after deletion, threat model is complete, and
      deployment status remains none.

**Non-goals.** No hosted auth, tenant isolation, TLS deployment claim,
confidential execution, generic sanitizer, or authorization to deploy.

---

## Draft 18 — BP-51 · Product documentation, cold quickstart, and extraction evidence

**Context.** The implemented product lacks a durable user/contributor entry
point, the core README is stale, the web and public bundle have no focused
guides, extraction readiness has not been dry-run, and M2–M5 owning issue
drafts are absent.

**Impact.** Users can invent incorrect commands or trust claims, contributors
can misread deployment/publication status, and extraction discussion lacks
mechanical evidence.

**Issue Type.** `docs`.

**Dependencies / base.** Depends on BP-50. Required packet base:
`b235db6f5` on the current program lineage.

**Acceptance criteria (binary).**

- [ ] Product, core, web, and `benchmark-product-public-bundle/1` guides cover
      prerequisites, complete surfaces, errors/exits/streams, authority, trust, privacy,
      limitations, local-only publication, and deployment none.
- [ ] A built-CLI package quickstart uses the real local venue from an empty
      workspace through publish, copies outside source, deletes source, and
      requires all six standalone checks with unique fail-closed ownership.
- [ ] Product-local consistency/link tests derive operation, error, gate, and
      bundle facts from implementation authorities and fail on drift.
- [ ] A dated dry run evaluates all eight extraction gates, records exact
      PASS/BLOCKED verdicts, and says no move is authorized without a future DR.
- [ ] This file contains triage-complete BP-20 through BP-52 bodies; no GitHub
      issue or Project field is mutated.

**Non-goals.** No canonical-doc edit, publish, deployment, repository creation,
remote issue mutation, API change, or extraction authorization.

---

## Draft 19 — BP-52 · Final cross-cutting verification and implementation report

**Context.** Packet-local reviews prove individual changes, but program closure
requires one fresh non-author review across the integrated product, a complete
real agent and browser journey, hostile portable-bundle checks, clean-tree
evidence, and a report mapping every charter claim to evidence.

**Impact.** Without integrated review, cross-packet interactions and stale
claims can survive green packet batteries, leaving the local branch unfit for
human merge-readiness assessment.

**Issue Type.** `test`.

**Dependencies / base.** Depends on BP-51. Required base is the future BP-51
integration plus ledger commit on the current program lineage; pin its exact SHA
when the issue is filed.

**Acceptance criteria (binary).**

- [ ] A fresh independent non-author reviewer audits the complete M0–M5 diff
      against charter, design, packet contracts, boundaries, trust claims,
      accessibility, security, and docs; blockers are corrected and re-reviewed.
- [ ] Node 22 full core/web/local-backend, pack/types, parity, family guards,
      architecture generator/check/workflow, docs/link, and production browser
      batteries pass fail-fast at the integrated head.
- [ ] Real CLI and optimized browser flows publish complete and cancelled
      bundles; copies verify after source deletion; complete, partial,
      conflicted, adverse, and cancelled presentation stays honest.
- [ ] Manifest, Matrix, Report, claim, public-key, evidence, cancellation, and
      static-asset tampering fails; secret/path/external-request sweeps are clean.
- [ ] Final report records baseline/resumption mechanics, final state,
      four-perspective outcome, milestone/acceptance/packet tables, architecture,
      verification/review evidence, blockers, drift, and merge caveats.
- [ ] Session branch is clean and completed packet worktrees are removed; no
      remote side effect occurred.

**Non-goals.** No push, PR, issue filing, merge, publish, deployment, canonical-
doc change, base refresh, or claim that local completion equals remote merge
readiness.
