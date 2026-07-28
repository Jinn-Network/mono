# Stack Implementation Program

- **Date:** 2026-07-28
- **Status:** Draft — pending program approval (the single gate before implementation starts)
- **Role:** Master program document for implementing the designed-but-unbuilt Jinn protocol
  stack on `integration/evidence-v1`. Owns sequencing, the PR/commit-train structure, review and
  verification gates, the model policy, cross-plan contracts, and the follow-ups registry. The
  per-component plans own their task breakdowns; this document does not restate them.
- **Session branch:** `claude/stack-implementation`, cut from `origin/integration/evidence-v1`
  at `3650ac65e` (contains the index-recorded head `f65880c4e` and PR #2226).

## 1. Component plans

| Plan | Scope | Depends on |
| --- | --- | --- |
| [2026-07-28-task-execution-protocol.md](./2026-07-28-task-execution-protocol.md) | `@jinn-network/task-execution-{protocol,backend,testing}` + task-execution tree guards; absorbs the three carried profiles amendments (profiles §13) | — |
| [2026-07-28-trust-layer.md](./2026-07-28-trust-layer.md) | `@jinn-network/trust-{core,resolve,testing}` + trust tree guards (trust design §18 steps 1–2) | TEP protocol (equivalence leg only, gated task) |
| [2026-07-28-task-execution-profiles.md](./2026-07-28-task-execution-profiles.md) | `@jinn-network/task-execution-profiles` + the two sealed profile documents | TEP plan |
| [2026-07-28-record-discovery.md](./2026-07-28-record-discovery.md) | `@jinn-network/record-discovery-{protocol,serve,client,testing}`, `facts/*` leaves, `sources/evidence-journal` wrapper + discovery tree guards | Trust plan; profiles plan (facts leaves for its kinds only) |
| [2026-07-28-local-execution-backend.md](./2026-07-28-local-execution-backend.md) | `@jinn-network/task-execution-backend-local`, the testing package's `./backend-local` kit slice, `@jinn-network/task-execution-evaluation-harness`, the F7 evidence-profile minor addition, Autopilot adoption (backend §11.1 scope) | TEP plan; profiles plan |
| Amended: [2026-07-27-execution-recorder-bridge.md](./2026-07-27-execution-recorder-bridge.md), [2026-07-27-evidence-retrieval.md](./2026-07-27-evidence-retrieval.md), [2026-07-27-evidence-contribution.md](./2026-07-27-evidence-contribution.md) (dated addenda) | The three evidence applications | Evidence substrate only |
| Superseded: [2026-07-27-evaluation-runner.md](./2026-07-27-evaluation-runner.md) | Not executed; evaluator-adapter core re-homed into the backend-local plan | — |

## 2. Streams, phases, critical path

Three streams run in parallel from approval; the critical path is
**TEP protocol → TEP kit → profiles → backend-local (§18 order) → evaluation harness →
Autopilot adoption**.

- **Phase 2 — foundations (three parallel streams).**
  S1 TEP core: protocol (+ carried amendments) → backend contract → testing kit, the in-memory
  fake backend proven first (TEP §26). S2 Trust: guard clone + core sealing spine + fixtures →
  record families → procedures → evidence-equivalence leg → resolve. S3 Applications:
  bridge → retrieval → contribution, in that pinned land order (each computes guard counts from
  the live guard file at land time; adjacent-line guard conflicts are ordinary textual
  conflicts).
- **Phase 3 — semantic + distribution layers.** Profiles (after the TEP kit is green) in
  parallel with discovery protocol + kit (after trust-core) → serve + client →
  facts/evidence + facts/trust; facts leaves for the profiles-defined kinds land after the
  profiles package; the evidence-journal published-source wrapper lands after serve
  (serve-gated only, design §20 stage 3). Trust's gated task-execution sealing-equivalence leg
  runs as soon as S1's protocol package exists.
- **Phase 4 — the backend.** backend-local per its design §18 steps 1–3 (kit slice +
  supervisor → workspace + launchers, claude-code first → assembly + TEP kit green), then the
  F7 evidence-profile minor addition, then the evaluation harness.
- **Phase 5 — adoption and close.** Autopilot adoption (backend §11.1/§17 impact scope only),
  the overall program review, the full-program verification pass, and the merge proposal.

Each phase ends with: all tests/kits/guards green on the session branch, the completed
components' per-design reviews done and findings resolved, and a phase report.

## 3. Commit/PR-train structure

- Implementation units are built in **isolated worktrees** (one per component unit), merged into
  `claude/stack-implementation` only after the unit's verification gate passes and — for a
  completed component — its per-design review findings are resolved.
- The session branch carries a **conventional-commit train**: one or a few commits per
  component (`feat(task-execution): protocol package + tree guards`, …), pushed after each
  merge so phase reports can cite commit ranges.
- **Nothing merges to `integration/evidence-v1` without explicit operator approval.** The final
  deliverable is a single PR `claude/stack-implementation` → `integration/evidence-v1`
  (mirroring the index §5 pattern of a single promotion PR onward to `next`). If the operator
  prefers per-phase PRs to `integration/evidence-v1`, the train splits at the same component
  boundaries — decidable at any phase report without rework.

## 4. Review and verification gates

- **Per unit (automated, every merge to the session branch):** `yarn build`, typecheck, tests,
  the relevant conformance kit, the tree's guard scripts, packed-types — run locally,
  evidence-style. No model reviews at this granularity.
- **Per design (model review):** when a component's implementation is complete, one independent
  Opus review (high effort) checks the whole component against its design document — design
  conformance, correctness, an adversarial pass over its frozen interfaces. Findings are fixed
  before dependents build on the component. Reviewed sets: TEP core; trust; profiles;
  discovery; backend-local + harness; the three applications (one review each against their
  designs); Autopilot adoption.
- **Overall program review (end):** one Opus high-effort review across the integrated whole —
  cross-component integration, dependency-rule conformance, everything per-design reviews
  cannot see.
- **Operator gates:** program approval before any code; phase-boundary reports; final merge
  approval. Findings against designs are always surfaced with proposed dispositions, never
  silently patched (small clarifications land as dated addenda in plan documents).
- The five stack designs carry status "written review pending"; the per-design implementation
  reviews serve as that written review, and anything they surface is escalated.

## 5. Model policy

Coordinator: Fable (all conclusions, synthesis, sequencing, presentations). Opus: reading and
inventory lanes, plan drafting, plan reviews, per-design and program code reviews (high effort
for reviews). Sonnet: all code implementation. Haiku: mechanical work only (file checks, greps,
guard-list edits, table cross-checks).

## 6. Naming decisions

Settled here (the working titles in the designs are superseded by this table):

| Tree | Directory | npm names |
| --- | --- | --- |
| task-execution | `packages/task-execution/{protocol,backend,testing,profiles,backend-local,evaluation-harness}` | `@jinn-network/task-execution-*` |
| trust | `packages/trust/{core,resolve,testing}` | `@jinn-network/trust-{core,resolve,testing}` |
| discovery | `packages/discovery/{protocol,serve,client,testing}`, `facts/{evidence,task-execution,trust}`, `sources/evidence-journal` | `@jinn-network/record-discovery-*` |

Confirmed by the operator at the program gate (2026-07-28):

1. `record-discovery-*` npm prefix — confirmed (disambiguates from the existing
   `@jinn-network/evidence-discovery`).
2. `backend-local` as ONE package with four guard-enforced sub-regions
   (supervisor/workspace/launchers/assembly) + subpath exports — confirmed.
3. Evaluation harness at `packages/task-execution/evaluation-harness` — confirmed.
4. Published-source wrapper at `packages/discovery/sources/evidence-journal`, with program
   rule 1's wording widened to "leaf packages under `packages/discovery/` (`facts/*`,
   `sources/*`) are the only places a discovery edge and a record-kind edge meet" — confirmed.
5. Facts-leaf granularity — **adjudicated by review**: three leaves. `facts/profiles` folds
   into `facts/task-execution` (one leaf per record-kind tree, discovery design §17; both
   bound the same `task-execution-profiles` tree). The single leaf covers Task, Submission,
   Delivery, profile-document, evaluation-spec, plugin, and checkpoint kinds.

## 7. Cross-plan contracts (coordinator rulings; binding on implementation)

1. **Canonical sealed bytes, stack-wide:** the sealed bytes of every sealed document family in
   the new trees (TEP Task/Submission/Delivery, trust records, discovery entries/heads,
   profiles documents) are the raw RFC 8785 JCS serialization under I-JSON — no indentation,
   no trailing newline. Cross-package/tree equivalence fixtures assert byte equality and must
   include at least one object-key-order-sensitive record (UTF-16 code-unit order, per-package
   `order.ts`, locale-API ban in every tree's guards). Evidence-internal serializers with other
   layouts (e.g. attestation-issuer's indented form) are evidence-internal precedents, not the
   sealing rule.
2. **`deriveAttemptUri`:** the UUIDv5 namespace constant and the name-construction rule are
   owned and exported by `@jinn-network/task-execution-protocol`, pinned by kit fixture. The
   future marketplace binding consumes the exported constant; it never re-derives its own.
3. **Requirement-merge evaluator (pinned exactly, post-review):** one symbol, home
   `@jinn-network/task-execution-protocol`:
   `mergeRequirements(taskRequirements, submissionRequirements, keyClasses) →
   { ok: true, effective: EffectiveRequirements } | { ok: false, category: 'invalid-document',
   key }` — it returns the effective merged map on success (`EffectiveRequirements` is also a
   protocol export; backend-local's TaskView consumes it). `keyClasses` = fixed core-key
   classes plus the resolved profile document's `requirementKeys` classes, assembled by the
   caller. `unsupported-requirement` (a pinning key absent from a backend's capability
   inventory) is produced by the **backend capability check**, never by this pure merge —
   profiles' pinning-inventory fixtures are data for that backend path. The profiles kit
   executes `mergeRequirements` for the comparison-class fixtures. The error-category enum
   lives in protocol, the `TaskExecutionError` class in backend (no duplicate enum).
4. **Delivery sealing in the backend:** assembly consumes the protocol package's exported
   Delivery sealer for the sealed Delivery (a TEP document, same tree); backend-local
   re-implements canonical bytes only for backend-internal state.
5. **Testing-package edges:** `@jinn-network/task-execution-testing`'s `./backend-local` slice
   depends on `backend-local` (production dep of the slice); `backend-local` consumes the
   testing package as devDependency only. No production cycle (evidence `local-runtime`
   precedent).
6. **Guard-suite ownership:** each tree's guard scripts + CI workflow are created by the plan
   that lands the tree's first package (TEP plan for task-execution; trust plan for trust;
   discovery plan for discovery) and extended by every later package registration. Counts are
   always computed from the live guard file, never hardcoded.
7. **Evidence-contract surface for the backend:** contract types (`EvidenceRepository`,
   `EvidenceCatalogReader`) plus the I/O-free injected-port producer packages
   (`execution-recorder`, `attestation-issuer`). Concrete bindings (fs, sqlite,
   `evidence-local-runtime`) are host-injected via the assembly-owned `awaitIndexed` port.
8. **Cross-tree CI convention:** a tree's CI builds its cross-tree portal dependencies from
   source before install (packed-types packs them as `file:` deps). Revisit only if a shared
   build orchestration lands.
9. **trust-core dependency floor:** `@noble/hashes` + `zod` + `@noble/curves` (EOA/ceremony
   signature recovery is pure compute; trust design §17 places it in core). The trust tree's
   boundary guard allowlists exactly these.
10. **Evaluator-verdict signer:** per backend §10.4/profiles §9.2, the verdict DSSE Statement
    is signed by the **evaluator Agent's key**, delivered to the harness as a `secrets/`
    reference-forward resolved from a capabilityGrant; the attestation-issuer package is the
    signing *mechanism* (injected `DsseSigner`), not a distinct signer identity. The harness
    adapter must emit the full measurements set (every spec-required measurement) so
    verdict-consistency is computable, and parsers resolve only from the deployment allowlist
    (spec-supplied parser code is never executed).
11. **Discovery signing scope spelling:** the discovery announce-plane scope is
    `jinn:discovery-announcements` — conformant with trust-core's namespaced-scope grammar
    (`namespace:custom`). Both trees cite this constant; the discovery kit carries a
    cross-tree assertion that the value parses under trust's `ScopeVocabulary`.
12. **Query-plane frozen interfaces:** `DiscoveryQueryService`, `Page`, `QueryCapabilities`,
    `FactsFilter`, `PageRequest` (discovery design §8/§16.9) are defined in
    `record-discovery-protocol`; `record-discovery-client` imports and implements them. The
    testing kit references them from protocol, preserving kit-before-implementation.
13. **Facts-consistency recompute seam:** facts-profile documents are declarative; the
    per-kind record-fact **recompute functions** are exported by the `facts/*` leaves and
    reach the protocol package's kind-agnostic verification runner through a
    `FactsRecompute`/registry port threaded through `verifyItem` and injected by the host.
    Record facts are always recomputed **from record bytes** (never from a supplied
    projection); the evidence leaf does so via `validateAndProjectEvidenceRecord` on the
    `@jinn-network/evidence-discovery/indexer` subpath, using `CatalogRecordProjection` only
    as the field-shape reference.
14. **Canonical-serializer construction + I-JSON numbers:** every new-tree canonical
    serializer builds its output via explicit sorted-key iteration (never relying on JS
    object insertion order — integer-like string keys iterate numerically and would diverge
    from JCS), with an integer-like-key fixture (`{"10":…, "2":…}`) in every tree's reference
    tests; and every sealer rejects numbers that are not exactly representable I-JSON
    integers — fractional quantities are strings (TEP §6.1), including the composite-grader
    `weight` field in profiles documents.
15. **Cross-tree equivalence legs, scoped honestly:** canonical-byte equivalence fixtures run
    between the trees that share the raw-JCS rule (trust ↔ task-execution ↔ discovery ↔
    profiles). Against the evidence tree the equivalence legs assert DSSE PAE byte-equality
    and digest-algorithm agreement only — `evidence-protocol` exports no canonical
    serializer, and attestation-issuer's indented layout is evidence-internal (adjusts trust
    design §17's evidence-leg expectation; recorded as a surfaced finding, not silently
    patched).
16. **`foldObservations` signature:** the frozen name gains an optional second parameter
    `{ now?, effectiveDeadline? }` (field-level refinement per TEP §22): without it the fold
    is a pure log fold (no provisional `expired`); with it, provisional `expired` is derived
    in-fold per §10.4 rule 5. `observe()` surfaces the materialized `AttemptDescriptor`
    (§9/§22) carrying the Task digest, Submission URI, executor IRI, effective deadline,
    correlation annotations, and the executionIds/deliveries edges alongside derived state.
17. **Regex hardening posture (profiles §6.4):** the profiles validator accepts an injectable
    `regExp` engine at compilation; the default is native `RegExp` guarded by the safe-regex
    static check plus a pattern-length bound, with the residual (a pattern passing the static
    check can still backtrack) documented; the marketplace deployment profile mandates
    injecting a linear-time engine (RE2). Keeps the reference package pure-JS and portable.

## 8. Follow-ups registry (recorded once; none block v1)

- IANA registration for the `vnd.jinn.task-execution.*`, `vnd.jinn.trust.*`,
  `vnd.jinn.record-discovery.*` vendor trees (TEP §28; trust §20; discovery §22). Vendor-tree
  names used as-is until then.
- Scheme-IRI (`identifier` propertyID) registration for did:pkh / did:key / CAIP-19 / GitHub
  spellings + the TEP scheme IRIs — one shared follow-up across TEP §28 / profiles §17 /
  trust §20.
- `capacity-exhausted`: v1 rides `backend-unavailable` + capacity detail; whether TEP §13 gains
  a dedicated category is the recorded follow-up (backend §20).
- Reserved URIs must resolve before any EXTERNAL conformance claim:
  `https://jinn.network/profiles/task-execution/1.0`,
  `https://jinn.network/task-profiles/repository-work/1.0`,
  `https://jinn.network/task-profiles/evaluation-task/1.0` (+ the profiles/evaluation-spec
  format URIs). Pre-release checklist; does not gate internal work.
- Stale-doc corrections: evidence architecture doc §3/§4 status table (11 packages, all
  implemented); 2026-07-23 protocol design's pre-consolidation paths; application-layer index
  residual "four capabilities" phrasing and the §7 "re-audited" claim (partially corrected by
  the 2026-07-28 amendments; a broadening pass is a docs follow-up).
- Carried constraint for the future marketplace-contract design: the adoption-authorization
  Solidity hook uses an on-chain expected-signer slot settable only by the launcher Safe
  (trust §8.2/§20), so working-key rotation never re-imports the #1401 shape.
- TEP §20 delegated-authority wording amendment (identity-level delegation is binding `scope`,
  not an in-toto statement) — carried by the trust design; lands with a TEP doc touch-up.

## 9. Out of scope — pending design sessions

Recorded, not planned, not implemented here: the marketplace binding (chain/mech translation,
projector #1, the query-plane service, subscribe relay, daemon TaskEngine carve, trust §18
steps 5–6, the open-fleet adoption-authorization object); the benchmarking application;
migration-mechanics specs for daemon/Autopilot cutovers beyond what backend §11.1 explicitly
covers; trust §18 steps 3–8 host rollouts (bootstrap identity establishment, policy documents
replacing allowlists, DSSE convergence, full backend grant-resolution obligations,
verifier-policy integration).
