# Policy Optimization Implementation Program

> **For agentic workers:** this is a PROGRAM plan, not a task plan. Each unit (C1–C9) is
> executed in its own session: the unit executor reads this charter plus the owning design
> sections, **invokes `superpowers:writing-plans` to produce the unit's task-level plan**
> (bite-sized TDD steps), then executes it via `superpowers:subagent-driven-development`.
> Kits are authored before implementations, always. Designs are law: a design conflict is a
> finding with a proposed disposition, never a silent patch.

**Goal:** implement the two 2026-08-03 designs — the policy identity/outcomes substrate and
the Policy Optimization product — through one end-to-end campaign on the local backend.

**Authority:**
[`2026-08-03-policy-identity-and-outcomes-design.md`](../specs/2026-08-03-policy-identity-and-outcomes-design.md)
("substrate") and
[`2026-08-03-policy-optimization-product-design.md`](../specs/2026-08-03-policy-optimization-product-design.md)
("product"), both committed 62a5fe6dd with review dispositions in their Appendix A.

**Base gating (operator-approved):** the program plan lands now (docs-only). **Phase
execution is gated on PR #2363 merging to `integration/evidence-v1`**, with one exception:
C1 and C2 (new pure packages, near-zero contact surface) MAY start immediately in isolated
worktrees. Everything touching `client/`, `packages/task-execution/`, or
`packages/benchmarking/` waits for the base.

**Tech stack:** TypeScript, Node 22, yarn workspaces, vitest; sealing per stack discipline
(I-JSON, RFC 8785 JCS, sha256, DSSE); guard trio + purity guards per package.

## Global constraints

- Kits and fixtures precede the implementations they test; a layer's kit is green before
  dependents build on it (principles §9). Fixtures derive from spec text, never from
  product runs.
- Dependents build against **kits**, not implementations: C2 starts against C1's frozen
  fixtures; only a frozen-interface change blocks downstream.
- Every package ships with package-inventory, source-boundary (allowlist), and packed-types
  guards **in the same PR**; pure packages add the source-scanning purity guard
  (`task-curation` precedent).
- Catalog edits ride the PR that creates each package: new `experimental-policy` release
  group (tier 3, publication disabled) for C1/C2; product entry (tier 4,
  `transitional-or-private`) for C7; **plus** the allowed-dependency-groups amendment so
  product→substrate imports pass the catalog gate (substrate §10, product §2).
- Verification before completion, every unit: typecheck, tests, the unit's kit, the guards
  — run locally, outputs shown (§13.3).
- American English throughout; no emoji; match surrounding style.
- Every PR: `Closes #N`; target the program integration branch; agent PR review parity
  rules apply (no self-merge).

## 1. Component charters

### C1 — `@jinn-network/policy-identity` (substrate §§4–5, §8)

- **Files:** create `packages/policy/identity/` (package + kit fixtures under
  `packages/policy/identity/fixtures/`); catalog + guards in same PR.
- **Produces (frozen interface):**
  - `deriveExecutionTuple(task: SealedTaskDoc, submission: SealedSubmissionDoc, profile: ResolvedTaskProfile): ExecutionPolicyTuple`
    — the substrate §4.1 total function (profile pin-check → effective-requirements merge →
    closed key rule → byte-exact copy → canonicalize). *(3-arg per addendum F1.)*
  - `canonicalTupleBytes(tuple)` / `tupleDigest(tuple): string` (`sha256:<hex>`).
  - `expressAsRunPinning(tuple): RequirementEntries` (§4.1 expression rule).
  - `sealCandidateManifest(manifest): {bytes, digest}` /
    `validateCandidateManifest(input): ValidationResult` (§5.1–§5.3; typed
    `parents[]: {kind: "candidate"|"tuple", digest}`; rejects unrecognized non-namespaced
    top-level fields).
  - Types: `ExecutionPolicyTuple`, `CandidateManifest`, `PolicyParentRef`.
  - Format tokens: `network.jinn.policy.execution-tuple/1.0`,
    `network.jinn.policy.candidate/1.0`.
- **Consumes:** `task-execution-protocol` requirement types + `mergeRequirements`
  semantics; evidence-retrieval envelope shapes **mirrored, never imported** (substrate §2).
- **Kit fixtures (authored first, adversarial charter):** substrate §8 list in full —
  canonicalization (key-order invariance, omitted-core-axis rejection + null/absent
  non-collision, extension-key digest sensitivity, constraint-shaped value), **two-deriver
  derivation-equivalence** (incl. declared-but-unset profile key, excluded foreign key,
  enrichment ban), manifest (valid minimal / multi-parent both kinds / extension-bearing;
  invalids per constraint; sealed-bytes round-trip; DSSE in-toto Statement verify with
  wrong-subject and wrong-predicateType negatives).
- **Acceptance:** kit green from two structurally different derivation code paths (the kit
  ships a naive reference deriver; the package's deriver must byte-match it on every
  fixture); purity guard green; no product name anywhere.
- **Review tier: DEEP** (design-conformance + adversarial on the frozen surface).
  Model: Opus, high effort. Kit author is a separate agent from implementer.

### C2 — `@jinn-network/policy-outcomes` (substrate §6, §8)

- **Files:** create `packages/policy/outcomes/`; catalog + guards + purity guard in same PR.
- **Produces:** `projectPolicyOutcomes(observations): PolicyOutcomesProjection`;
  `foldPolicyOutcomes(previous, observations)` (idempotent, conflict-refusing);
  `serializePolicyOutcomesProjection` (format token
  `network.jinn.policy.outcomes-projection/1.0`); types `PolicyOutcomeObservation`
  (neutral, mirrors `CurationObservation` + `tuple` + `perAxisStatus`), `PolicyOutcomesRow`
  (keyed `(tupleDigest, bucket)`, integer ratios, per-axis
  `{match, mismatch, unverifiable}` counters, `inputRefs` complete).
- **Consumes:** C1 kit's `ExecutionPolicyTuple` type + `tupleDigest`.
- **Template:** mirror `packages/task-supply/curation` file-for-file in discipline (pure;
  no clock/network/fs/randomness; fail-closed conflicting redelivery; no thresholds).
- **Kit fixtures:** miniature fold (two tuples × two buckets), idempotent redelivery no-op,
  conflicting redelivery refusal, per-axis counter arithmetic, manipulation
  (cohort-filtered re-derivation), **re-announcement** (same verdict record via second
  source must not inflate — asserts the §6.3 adapter dedupe contract at the boundary).
- **Acceptance:** kit + purity guard green; row/fold semantics byte-stable across two runs.
- **Review tier: GATES-ONLY** (kit + guards + coordinator diff skim; no model review).
  Model: Sonnet, medium effort.

### C3 — #2118: `learner-public.v1` digest migration (substrate §4.2)

- **Files:** modify `client/src/harnesses/freeze.ts` (`hashImplStateDir` gains a named
  profile parameter; `learner-public.v1` = path-sorted per-file sha256 → outer sha256,
  excludes `.git/`, `secrets/`, `transcripts/`, `operator-requests/`, unknown top-level
  paths fail closed), `client/src/harnesses/impls/learner/harness.ts:47`
  (`freezeStateHashIgnore` → profile), `client/src/daemon/freeze-fence.ts`, the delivery
  `codeDigest` call site, and `client/src/main.ts:627` (status surface joins the profile).
- **Produces:** one digest scheme across fence, delivery, status; a **migration note**
  (docs/runbooks or CHANGELOG entry) recording the digest break — pre-migration on-chain
  codeDigests are a non-joining legacy population.
- **Acceptance:** regression tests pin the profile's exclusions and fail-closed rule; a
  fixture tree's digest matches C1's fork-healing fixture byte-for-byte; existing freeze
  tests updated intentionally (each change listed in the PR body, none silent).
- **Review tier: DEEP** (smallest diff, shipped-behavior change). Model: Opus, high.
  **Human touchpoint: the migration note requires operator sign-off before merge.**
- Deferred explicitly: #2119/#2120 (checkpoint publish/install) — cross-operator only.

### C4 — local-venue assembly ports + pinning bridge (product §11 items 1–2; substrate §7)

- **Files:** create `packages/benchmarking/local/` implementing the `benchmarking-run`
  port contract for the local backend: `localAssemblyPorts` (`InputScope`,
  `CloseBoundaryResolver`, `TrustResolver`, `AdmissionEvidencePort`,
  `PinningObservationPort`).
- **The bridge (the program's highest-leverage unit):** `PinningObservationPort` reads the
  local backend's admission-gate results (`verifyRunPinning`,
  `packages/task-execution/backend-local/assembly/src/pinning.ts`) and Evidence Runtime
  Observations (joined in `assembly/src/evidence-join.ts`) → per-axis
  `match | mismatch | unverifiable` per substrate §7's producer contract (benchmarking
  §8.1/§12.1 owns Matrix semantics; constraint values corroborate by satisfaction;
  `unverifiable` never silently upgraded).
- **Acceptance:** a miniature local Run assembles a Matrix whose loadout/harness/model
  axes report `match` on honest cells and `mismatch` on a deliberately-swapped fixture
  cell; isolation reports its vacuous match honestly; benchmarking-testing kit passes
  against the port bundle.
- **Review tier: DEEP** (frozen port semantics). Model: Opus, high.

### C5 — launcher inventory + harness-state materialization (product §11 item 3; substrate §4.2)

- **Files:** modify `packages/task-execution/backend-local/launchers/src/*` (add
  `{key: "loadout", inventory: [..., "jinn.harness-state.v1"]}` to claude-code/codex/
  hermes/cursor declarations), `packages/task-execution/backend-local/workspace/src/loadout.ts`
  + `materialize.ts` (kind-aware materialization; **fail-closed on any profile-ignored
  root present in the package** — `.git/`, `secrets/`, `transcripts/`,
  `operator-requests/`).
- **Consumes:** C3's profile constant.
- **Acceptance:** materialization round-trip digest-verifies against C3; the
  smuggled-`.git/hooks` fixture package is rejected at materialization on the provisioner
  path (not only checkpoint-install).
- **Review tier: GATES-ONLY.** Model: Sonnet, medium.

### C6 — learner candidate mode (product §10)

- **Files:** modify `client/plugins/learner/skills/learn/SKILL.md` §8–§9,
  `promoter-prompt.md`, `consolidator-prompt.md` (write to a provisioned candidate
  workspace; emit a `CandidateManifest` via C1 with `promotion_record`s mapped to
  `declaredChanges`; active `implStateDir` untouched mid-run);
  `client/src/harnesses/impls/learner/harness.ts` (`supports()` stops defaulting to every
  SolverType — explicit per-profile routing; candidate-mode wiring; compatibility flag for
  legacy inline mode with deprecation note).
- **Acceptance:** given parent A + a frozen evidence bundle, the plugin emits candidate B
  (sealed manifest, `parents: [A]`, A byte-identical after the run); freeze-fence tests
  still green; legacy mode still works behind the flag; grep-level check that no prompt
  file instructs mid-run mutation of the active directory.
- **Review tier: STANDARD** (one design-conformance review, no adversarial pass — prompt
  regressions are behavioral, so the review focuses on the prompts against product §10).
  Model: Opus, high (prompt engineering is the risk).

### C7 — `packages/policy-optimization` product (product §§5–9, §11)

Split into four sub-units, each with its own task plan and PR, in order:

- **C7a campaign document + journal:** seal/validate the campaign doc (format token
  `network.jinn.policy-optimization.campaign/1.0`; `frozenAxes` byte-share check across
  seeds at sealing; committed-and-unrevealed promotion Benchmark required for
  `DRAFT→EXPLORING`); append-only journal (the §5.2 event list) with restart recovery.
- **C7b wave engine:** compose `benchmarking-run` (plan → quote → launch → watch →
  assemble) over C4's ports; arms via C1's `expressAsRunPinning` + campaign `frozenAxes`;
  dev-wave allocator (journal every pruning decision with consumed rows/Reports);
  promotion run (preregistered analysis plan, flat sampling, single-shot; reveal at
  `CONFIRMING`).
- **C7c admission + proposers:** admission per product §7.3 (manifest validation via C1,
  digest-correct materialization, frozen-axes/mutation-surface check, held-out lexical
  scan via the existing `excludeHeldOutSlate`/disjointness modules, payload-class
  code-execution consent for hook/tool/harness payloads, `tupleDigest` population keying
  with first-admitted attribution); `PolicyProposer` interface; the **deliberately-dumb
  reference proposer** (deterministic skill ablation/recombination over the parent
  loadout).
- **C7d archive + CLI:** derived archive (typed-parent lineage graph, evaluated history,
  frontier set; adoption state separate and labeled non-derivable); CLI verbs
  `jinn optimize campaign create|run|status`, `jinn optimize candidate inspect`,
  `jinn optimize policy adopt|rollback` (adopt/rollback over the existing freeze-fence +
  L1 revert machinery).
- **Acceptance (whole C7):** the replaceability falsifier — C7c admits candidates from
  both the reference proposer and C6 **without campaign-engine modification**; no
  benchmarking/aggregation logic reimplemented anywhere (source-boundary guard enforces:
  statistics only via `benchmarking-aggregate` registry).
- **Review tier: STANDARD per sub-unit** (design-conformance, one round). Model: Opus,
  high. Integration findings against tier-3 packages are filed as findings with proposed
  dispositions (F-C5-8 precedent), never patched in place.

### C8 — the two observation adapters (product §8.2; substrate §6.3)

- **Files:** inside `packages/policy-optimization` (product-internal until a second
  consumer): the curation adapter (the seven joins documented in
  `packages/task-supply/curation/README.md` "Adapter boundary", fail-closed conflict
  policy) and the policy-outcomes adapter (same joins + tuple derivation via C1 +
  per-axis status from available fidelity evidence + **dedupe by underlying verdict
  record digest** across sources).
- **Acceptance:** golden joins over recorded announcement fixtures; the re-announcement
  fixture passes end-to-end (C2's boundary assertion satisfied by this adapter);
  discharges the Phase C §2.5 tier-4 curation-adapter obligation.
- **Review tier: GATES-ONLY.** Model: Sonnet, medium.

### C9 — end-to-end campaign + program review

- **Files:** `packages/policy-optimization/scripts/e2e-campaign.ts` (or vitest e2e):
  mini swe-rebench-shaped Benchmark (3–5 tasks) + committed promotion Benchmark → seed →
  C6 candidate + reference candidate → dev wave → promotion run → signed Report →
  recommendation → `adopt` → `rollback`.
- **Acceptance:** the full loop, local backend only, with per-axis `match` on the loadout
  axis in the promotion Matrix; adopt/rollback round-trip leaves the operator on the
  original policy byte-identically.
- **Then:** one overall program review across the integrated whole (§13.2), and the
  **operator tests as the user** — runs the e2e campaign by hand; journey friction found
  here feeds the queued onboarding/journey design session.
- Model: Opus, high.

## 2. Phases, parallelism, critical path

```
Phase 1 (C1 ∥ C2 ∥ C3)      C1, C2 may pre-start before base gate; C3 waits for base
Phase 2 (C4 ∥ C5)           C4 needs base; C5 needs C3
Phase 3 (C6)                needs C1 kit, C3, C5
Phase 4 (C7a→C7b→C7c→C7d ∥ C8)   C7 needs C1–C6; C8 needs C2 + base
Phase 5 (C9)                needs everything
```

Critical path: **C3 → C5 → C6 → C7 → C9** (the digest migration unblocks more than any
other unit; schedule it first after the base lands). C4 is off the critical path but gates
C7b — start it in parallel with C5.

## 3. Worktree, PR, and merge mechanics

- One worktree per implementation agent (`git worktree add ../jinn-mono_worktrees/<unit>`);
  agents receive `git -C <worktree>` discipline in their prompts; the coordinator verifies
  its own tree is clean after every dispatch.
- One PR per unit (four for C7), stacked on the program integration lineage
  (`integration/evidence-v1` once #2363 lands). PR title prefix `feat(policy):` /
  `refactor(learner):` per shape; `Closes #N` always.
- **Before any merge:** run the touched suites on a clean target-branch worktree (green CI
  on a stale base is not evidence); classify CI red against the base's known-failure
  baseline by check *name* ("N pre-existing, 0 mine" is mergeable; "CI is red" is not
  information).
- Coordinator merges; no agent self-merge.

## 4. Review protocol (the speed contract)

Encoded here because the previous program's per-unit reviews did not converge. Five rules,
binding on every review dispatch:

1. **Adversarial energy goes to kit authoring, not code review.** The kit author's prompt
   carries the full adversarial charter (attack the input space, convert every attack to a
   fixture). Code reviewers do not hunt the input space.
2. **No fixture, no blocker.** A reviewer claiming an input-space defect must express it as
   a proposed fixture (input → expected). Adoptable → added to the kit and fixed. Not
   expressible → coordinator judges whether it is real. Prose-only edge cases do not gate.
3. **Severity contract; only blockers gate.** Blocker = breaks a frozen interface,
   contradicts the owning design, fails the kit, or security/data-loss. Majors → filed as
   follow-up issues, PR merges anyway. Nits → batch-applied or dropped. **One round:**
   review → implementer fixes blockers → a scoped verify pass confirms only those fixes →
   merge. No fresh full review of fixed code.
4. **Tiered depth:** DEEP (design-conformance + adversarial on frozen surfaces) for C1,
   C3, C4 only. STANDARD (one design-conformance review) for C6, C7a–d. GATES-ONLY (kit +
   guards + typecheck + coordinator diff skim, no model review) for C2, C5, C8.
5. **Designs are law in review.** A reviewer disagreeing with a spec decision files a
   *design finding* routed to the coordinator (and the operator if material); it is never
   a change request against the implementer.

## 5. Model and effort policy

| Role | Model | Effort |
| --- | --- | --- |
| Coordinator | top available (Fable/Opus) | high |
| Kit authors (C1, C4) | Opus | high |
| Implementers C1, C3, C4, C6, C7, C9 | Opus | high |
| Implementers C2, C5, C8 | Sonnet | medium (C5 low acceptable) |
| DEEP/STANDARD reviewers | ≥ implementer's model | high |
| Verify-fix passes | same reviewer agent, continued | — |

Haiku: not used in this program.

## 6. Human touchpoints (exactly three)

1. This program plan's approval (done — this document).
2. **C3's migration note** — the digest break changes every operator's forward identity;
   operator sign-off before merge.
3. **C9** — the operator runs the e2e campaign as the first real user; friction findings
   feed the queued journey design session.

## 7. Coordinator rulings (binding on implementation)

- **R1:** C2 builds against C1's kit fixtures, not its implementation; a frozen-interface
  change in C1 after C2 starts is a program event (coordinator re-plans), not a quiet
  rebase.
- **R2:** path-granular mutation surfaces (beyond axis-level `mutationSurface`) are a
  **declared product extension**: C7c implements axis-level per the spec; the per-file
  diff check (parent tree vs candidate tree against declared mutable paths) is designed in
  C7c's task plan as an additive check, not improvised later.
- **R3:** statistics land only in the `benchmarking-aggregate` method registry; any C7
  need for a new estimator becomes a registry method with a reference implementation
  first. The product's source-boundary guard blacklists private statistics.
- **R4:** the solve-time MCP retrieval surface over `evidence-retrieval` is **out of this
  program** (operator-composition territory); retrieval-bearing loadout arms are legal but
  unexercised until it exists.
- **R5:** proposer-side evidence access is exclusion-filtered at the query layer
  (`excludeHeldOutSlate` on instance + repo, lexical scan on outputs); C7c wires the
  filter into bundle assembly — a passthrough is a blocker by definition.
- **R6:** isolation remains vacuous; nothing in this program claims otherwise, and no unit
  builds a sandbox.

## 8. Out of scope (pending sessions / triggers)

- Onboarding/journey layer (capture flow, benchmark bootstrapping, objective presets,
  continuous mode) — queued design session, fed by C9 findings.
- Marketplace campaign execution, economics, anchored-venue checks — deferred per product
  §11–§12.
- #2119/#2120 checkpoint publish/install — cross-operator distribution.
- Harbor / Environments Hub / RFT seams — declared, unscheduled.
- Second-domain policy adapter — the generalization test, after v0.

## 9. Addendum 2026-08-03 — execution findings and dispositions

**C1 kit findings (10; kit landed on `claude/policy-c1-kit`, 165 tests, mutation-checked):**

- **F1 (material, spec amended in-place):** `deriveExecutionTuple` takes a third
  `profile: ResolvedTaskProfile` parameter, pin-checked against the Task — substrate §4.1
  amended; C1's charter interface updated accordingly.
- **F2:** core-axis comparison classes unpinned across venues; behaviorally inert today
  (only `model` has constraint membership). Disposition: the C1 implementation pins one
  map; the kit's tripwire test fails the day another core key gains membership.
- **F3:** local backend declares `isolation` + `isolationPolicy` as distinct keys; the
  substrate's naming pin stands (`isolationPolicy` in tuples/rows). Carried to C4/C5.
- **F4/F5:** expression-rule wording and the reserved-member (`formatToken`) collision —
  spec amended in-place, kit fails closed.
- **F6/F7/F8:** manifest field optionality, nested-extension limits (a score inside
  `declaredChanges` is consumer-MUST-ignore, not validation-catchable), duplicate
  `parents[]` refused — kit's fail-closed choices ratified as the v0 contract.
- **F9:** `learner-public.v1` emits bare hex; `loadout.digest` carries `sha256:` — the
  conversion point is C5's, named here so it cannot be improvised.
- **F10:** explicit-`undefined` members follow the `benchmarking-records` canonicalization
  precedent, with a guard that an `undefined` core axis is still rejected.

**C3 DEEP review (1 blocker, 3 majors, 3 nits, 1 design finding — all dispositioned):**

- Blocker (locale-dependent `localeCompare` sort) fixed in-window: UTF-16 code-unit sort,
  digest-neutral for the reference fixture; two locale fixtures added.
- Design finding (LF-join combining-format forgery): coordinator ruling — fail closed on
  control characters in path components now (digest-neutral, closes the demonstrated
  collision); any re-encoding is a future profile version.
- Majors (note absolutes, hermes status-surface remainder) fixed as note wording in the
  same commit; nit fixtures (policy.json-as-directory, top-level `secrets` file,
  codex profile-resolution parity) added.

## 10. Issue tree (filed at execution start, not before the base gate clears)

One epic (`feat`, this program) with children per unit: C1, C2, C3 (`refactor`), C4, C5,
C6 (`refactor`), C7a–d, C8, C9 (`test`). Issue bodies frame problem + acceptance criteria
(link the design section); no solutions in bodies. Blocked-on/Effort/Priority set per the
Project fields; Effort follows §5's table.
