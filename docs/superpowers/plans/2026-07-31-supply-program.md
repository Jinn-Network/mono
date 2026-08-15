# Verified-Environment Supply — implementation program

- **Date:** 2026-07-31
- **Design (law):**
  [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  (approved, commit `5b0739832`). Discovering a design defect at planning or implementation
  time is a finding with a proposed disposition — never a silent patch.
- **Evidence base:**
  [`../notes/2026-07-31-task-supply-research-findings.md`](../notes/2026-07-31-task-supply-research-findings.md).
- **Component plans:** `2026-07-31-supply-c1…c6-*.md` in this directory, authored by
  parallel planning agents against this program plan.

## 1. Components

| # | Package | Tree | One job | Plan |
| --- | --- | --- | --- | --- |
| C1 | `@jinn-network/environment-record` | `packages/environments/record` | The environment record kind: schema, sealing (local re-implementation), identity, fixtures, conformance kit, discovery facts leaf. **Owns `packages/environments/` tree scaffolding + guard trio + CI.** | `…-c1-environment-record.md` |
| C2 | `@jinn-network/environment-verification` | `packages/environments/verification` | The K-run protocol → verification attestation (DSSE + predicate), incl. negative attestations and the rebench import source (row grouping by full identity) | `…-c2-environment-verification.md` |
| C3 | `@jinn-network/task-admission` | `packages/task-supply/admission` | Candidate + environment record → `DifferentialAdmissionReceipt/3`, incl. inline-match enforcement (blocker rule) and attestation-agnosticism. **Owns `packages/task-supply/` tree scaffolding + guard trio + CI.** | `…-c3-task-admission.md` |
| C4 | `@jinn-network/task-derivation` | `packages/task-supply/derivation` | Strategy seam + the import strategy: upstream row + verified env → admitted, sealed Task+EvaluationSpec pairs in the supply pool (its output store) | `…-c4-task-derivation.md` |
| C5 | `@jinn-network/task-posting` **+ binding-tree adapters** | `packages/task-supply/posting` + `packages/marketplace/binding` | D7 adapters (EOA broadcast port, durable intent store, recovery scan, `DEFAULT_POSTING_TERMS`) landed in the binding tree; then the policy-only posting application (explicit-post default, F7 work-client residual posture) | `…-c5-task-posting.md` |
| C6 | `@jinn-network/task-curation` | `packages/task-supply/curation` | The pass-rate projection: attribution-preserving contract + minimal projector (aggregate; benchmark-attempt bucketing note honored) | `…-c6-task-curation.md` |

No C0: tree scaffolding is owned by the first package in each tree (C1, C3), because a
scaffolding-only PR has nothing to test.

## 2. Phases and critical path

Kit-first ordering (spec §11): record kit → verification kit → admission kit → derivation
→ posting/curation.

- **Phase 1:** C1 (both trees' first stones: C1 opens `environments/`; C3 opens
  `task-supply/` in phase 2 but its scaffolding steps are independent of C1).
- **Phase 2 (parallel):** C2 and C3 — both consume only C1's exported types/digests.
  C5's *adapter half* (binding tree) is also phase-2-parallel: it depends on nothing in
  the new trees.
- **Phase 3:** C4 — consumes C1 types, C3's admission interface; C2 is a runtime
  supplier (verified records), not a compile-time dependency beyond C1 types.
- **Phase 4 (parallel):** C5's *application half* (needs C4's pool shape) and C6 (needs
  only discovery contracts — may start any time; sequenced here to keep reviewer load
  sane).

**Critical path:** C1 → C3 → C4 → C5-app. C2 rides beside it and gates only the
end-to-end supersession gate, not the stack.

## 3. PR-stack topology (stacked, never blocked on merging)

Integration target: `integration/evidence-v1` (operator decision, plugin program §7b:
stay on the integration branch as long as possible). Branch names
`supply/c<N>-<slug>`.

```
integration/evidence-v1
└── supply/c1-environment-record
    ├── supply/c2-environment-verification
    └── supply/c3-task-admission
        └── supply/c4-task-derivation
            └── supply/c5-task-posting        (application half)
└── supply/c5a-binding-adapters               (independent: binding tree only)
└── supply/c6-task-curation                   (independent: discovery contracts only)
```

Rules (identical to the plugin program):
- Every PR targets its **base branch**, never the integration branch directly (except
  c1, c5a, c6, whose base *is* integration).
- Restack after a base updates:
  `git rebase --onto <new-base> <old-base> <branch>`.
- Each plan's tasks declare **Consumes** entries naming the providing branch + exact
  symbol; a consumed symbol that does not exist on the base is a stop-and-report, not an
  improvisation.
- Multi-agent implementation uses separate worktrees (`git worktree add
  ../jinn-mono_worktrees/<name>`), `git -C` discipline, coordinator's worktree stays
  clean.

## 4. Pinned interfaces (the cross-component contract)

Component planners MUST use these exact names; changing one is a program-plan amendment,
not a local choice.

- **C1 produces:** `EnvironmentRecord` (parsed type), `sealEnvironmentRecord(record):
  Uint8Array`, `parseEnvironmentRecord(bytes)`, `environmentRecordDigest(bytes): string`
  (`sha256:`-prefixed), `ENVIRONMENT_RECORD_KIND`, `ENVIRONMENT_RECORD_MEDIA_TYPE`,
  `CommandSpecSchema` (shell-free `{bin, args, cwd?, env?}`), `bareHexDigest` (R2),
  fixtures + `./testing` kit, and the discovery facts-leaf package's
  `environmentFactsProfile`.
- **C2 produces:** `ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`
  (`https://jinn.network/attestations/environment-verification/v1`),
  `verifyEnvironment(deps, record): Promise<SealedAttestation>` where `deps` injects
  `{containerRuntime, artifactStore, signer, clock, verifier}` (R3: `verifier` = the
  host-declared toolchain identity), `buildEnvironmentCandidatesFromRows
  (rows): EnvironmentRecord[]` (full-identity grouping), attestation Zod schema with the
  presence rule (`runs`/`baseline` iff `result != "error"`), subject builder emitting
  **bare-hex** DigestSet values.
- **C3 produces:** `admitCandidate(deps, candidate, environmentRecordBytes):
  Promise<AdmissionResult>` (`{receipt} | {refusal: {code: "env-record-mismatch" | …}}`),
  `DifferentialAdmissionReceiptV3` schema (per-path 2×2 observations, `environment:
  {recordDigest}`, gold as digest only), `sealReceipt(receipt, signer)`. Admission never
  reads attestations.
- **C4 produces:** `DerivationStrategy` interface (`{id, derive(deps, env, inputs):
  AsyncIterable<Candidate>}`), `importStrategy` (rebench rows), `runDerivation(deps,
  strategy, env, inputs): Promise<PoolWriteSummary>` where `deps` carries an injected
  two-method `AdmissionPort` (R4: the adapter binding C3's `admitCandidate` +
  `sealReceipt` to it is owned by the tier-4 composition — C4 never holds a signer),
  `SupplyPool` interface (`put/list/get` over sealed pairs, digest-addressed; entries
  carry `receiptDigest`, R5), the namespaced EvaluationSpec key
  `network.jinn.environment.record` (exact string; dual-defined with C3, test-pinned, R1).
- **C5 produces:** in the binding tree — `createEoaBroadcastPort(publicClient,
  walletClient)`, `createFilePostingIntentStore(dir)`, `scanForOnChainMatch(publicClient,
  config)`, `DEFAULT_POSTING_TERMS` (with explicit `maxClaims`); in `task-posting` —
  `planPosting(pool, policy): PostingPlan` (pure), `executePosting(deps, plan)`
  (explicit-post; auto-post = policy flag), F7 residual posture documented in-package.
- **C6 produces:** `projectCuration(observations): CurationProjection` (pure), where each
  per-task row carries `{taskDigest, attempts, verdicts, passRate: {num, den}, window,
  inputRefs}` — never a bare rate; a `bucket` axis separating benchmark-pinned attempts.

## 5. Cross-plan contracts

1. **Designs are law** — spec `5b0739832`; defects are findings with dispositions.
2. **Kits and fixtures precede implementations**; a layer's kit is green before
   dependents build.
3. **Sealing is re-implemented per package** (C1) with cross-package equivalence fixtures
   against the evidence tree — never shared runtime sealing code.
4. **Custody law** — no key material, no ambient authority (incl. no ambient `fetch`),
   signer objects and ports injected, fail closed.
5. **No product names in tiers 1–3**; no unit imports `@jinn-network/core`, `plugin`,
   `jinn-layer`, or `client/`.
6. **Digest discipline:** record-body digests `sha256:`-prefixed; in-toto DigestSet
   subjects bare hex; the kit of every producing package includes the confusion fixture.
7. **Admission is attestation-agnostic** (spec §7.1) — attester policy in admission is a
   defect. Inline-match enforcement is mandatory with the adversarial fixture.
8. **Bounded claims:** no API, log line, or doc in any package may say "deterministic" or
   "verified" without the K/controls or trust-policy qualification the spec gives those
   words.
9. **Guards ship with the packages** (guard trio + CI per tree, C1/C3 own their trees).
10. **TDD per task; verification before completion** — typecheck, tests, kit, guards run
    locally with output shown before any task is reported done.
11. **Stop on missing Consumes** — a symbol a task consumes that isn't on the base branch
    is a stop-and-report.
12. **Legacy code is reference only** — read `client/src` freely, import never; ports of
    legacy logic (state machine, receipt semantics) are rewrites with their own tests.

## 6. Gates

- **Per-unit:** kit green + guards green + independent high-effort review against the
  spec (principles §13.2) before dependents merge onto it.
- **Program end:** one integrated review; then the **legacy supersession gate** (spec
  §11): C1+C2+C3+C4 kits green AND end-to-end reproduction of the legacy rebench import
  (env verified → admitted with receipts → sealed pairs in pool) on a representative
  upstream sample, outputs passing profiles conformance fixtures. Only then does the
  daemon program schedule harvest-loop refit; the echo half stays frozen regardless.
- **Work-client adoption (F7):** at work-client mint, C5-app swaps its posting core; the
  residual is recorded in-package until then.

## 7. Operator decisions carried

Import-only v1 on both axes (D2, D4); negative attestations published (D3); no private
material (D5); production/posting split (D6); adapters in the binding tree (D7); curation
spec-now-build-minimal (D8); compose-don't-monolith (D9); Opus-authored component plans,
stacked-PR discipline (this session).

## 8. Consolidation record (2026-07-31, post-planning)

Six component plans were authored by parallel Opus agents and consolidated. ~30 findings
were filed across them; the cross-plan ones are ruled here. Rulings amend §4 where noted.

| # | Ruling | Effect |
| --- | --- | --- |
| R1 | **Extension key is dual-defined, test-pinned.** C3 (`ENVIRONMENT_RECORD_SPEC_KEY`) and C4 (`ENVIRONMENT_RECORD_EXTENSION_KEY`) each define `"network.jinn.environment.record"` locally with a test asserting the literal — the house re-implement-plus-fixture pattern. Changing the string is a program-plan amendment touching both. (C3 F-C3-3, C4 Task 4) | §4 note |
| R2 | **C1's pin gains `bareHexDigest`** (`sha256:`-prefixed → bare hex for DigestSet subjects); C2's subject builder consumes it. Seal signature stays bytes-only (`sealEnvironmentRecord(record): Uint8Array`) — divergence from the `SealedRecord` house shape is accepted and documented in C1's plan. (C1 F2/F3) | §4 amended |
| R3 | **C2's `deps` gains `verifier`** (host-declared toolchain identity — a library cannot truthfully digest its own build); 2-arg `verifyEnvironment` shape unchanged. (C2 F-C2-1) | §4 amended |
| R4 | **C4 consumes C3 through an injected `AdmissionPort`** (two methods), with the adapter binding `admitCandidate` + `sealReceipt` owned by the tier-4 composition — C4 never holds a signer. Branch still bases on `supply/c3-task-admission` and consumes C3's types. (C4 finding b) | §4 amended |
| R5 | **Cross-plan stop-and-reports defused by inspection:** C4's `PoolEntry` carries `receiptDigest` (C5 F-C5-4 satisfied); C1's `parseEnvironmentRecord` rejects non-canonical bytes with fixtures (C2 F-C2-6 satisfied). | none |
| R6 | **Receipt envelope compatibility (C3 F-C3-1) accepted:** the existing marketplace admission-receipt contract requires a DSSE-wrapped in-toto Statement with the sealed Task + EvaluationSpec digests as subjects; the §7.1 receipt is minted as the *predicate*, subjects derived so they cannot diverge. Dated addendum added to the design §7.1. | spec addendum |
| R7 | **Install-per-run (C2 F-C2-2) accepted:** §5.3's install-then-K-runs ordering cannot survive fresh-container-per-run; install executes inside each run's container (no-op for pre-installed import images). Dated addendum added to the design §5.3. | spec addendum |
| R8 | **Index-digest detectability (C1 F1) accepted:** the record layer enforces two structural proxies; the general index-as-manifest case is a C2 verification-time observation (`error/acquire`). Dated addendum added to the design §4.5. | spec addendum |
| R9 | **Outward finding F8 → discovery owner:** the environment facts leaf declares `image.manifestDigest` reference-bearing, but an OCI image is not a fetchable record, so discovery's fail-closed recompute path cannot apply to that edge; a discovery §12 ruling is requested (C1 F6). Not blocking — the leaf ships with the reference declared and the recompute exemption documented. | filed |

| R10 | **(post-execution, 2026-07-31/08-01)** C5b's stop-and-report F-C5-8 is a C5-plan defect, not a C4 defect: `receiptDigest` is the program-pinned name (R5), and `evaluationSpecPublic` is unnecessary in v1 (D5 makes every task public-spec; posting hardcodes that path). Disposition: C5's Task B5 identity assertion is amended to pin the join (`PoolEntrySummary` + `SupplyPool.get()`), C4 unchanged. The compile-time tripwire test C5b shipped already enforces the boundary; replacing it with the amended assertion is a small follow-up on `supply/c5-task-posting`. | plan amendment |

Also verified at consolidation: all six plans UTF-8, zero NUL bytes, balanced fences,
placeholder-scan clean; every §4 pinned name grep-confirmed in its producing plan;
per-plan findings (C2×7, C1×8, C3×4, C4×8, C5×6, C6×8) each carry dispositions in place.

## 9. Follow-ups (not in any component plan)

- F1–F7 filings live in the spec §13; F2/F7 coordination with the consumption-boundary
  program happens at its merge, not here.
- Extensions (spec §14) are out of scope for every plan; a plan that needs one has found
  a defect (contract 1).
- Product composition (the tier-4 pipeline deployment) is deferred to a thin ops note
  once C5-app lands.
