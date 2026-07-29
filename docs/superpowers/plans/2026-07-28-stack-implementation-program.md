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
| [2026-07-28-local-execution-backend.md](./2026-07-28-local-execution-backend.md) | `@jinn-network/task-execution-backend-local`, the testing package's `./backend-local` kit slice, `@jinn-network/task-execution-evaluation-harness`, the F7 evidence-profile minor addition (first-adopter pass descoped 2026-07-28 — see §9) | TEP plan; profiles plan |
| Amended: [2026-07-27-execution-recorder-bridge.md](./2026-07-27-execution-recorder-bridge.md), [2026-07-27-evidence-retrieval.md](./2026-07-27-evidence-retrieval.md), [2026-07-27-evidence-contribution.md](./2026-07-27-evidence-contribution.md) (dated addenda) | The three evidence applications | Evidence substrate only |
| Superseded: [2026-07-27-evaluation-runner.md](./2026-07-27-evaluation-runner.md) | Not executed; evaluator-adapter core re-homed into the backend-local plan | — |

## 2. Streams, phases, critical path

Three streams run in parallel from approval; the critical path is
**TEP protocol → TEP kit → profiles → backend-local (§18 order) → evaluation harness**.

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
- **Phase 5 — close.** The overall program review, the full-program verification pass, and
  the merge proposal. (First-adopter adoption descoped 2026-07-28 — see §9.)

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
  designs).
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
| task-execution | `packages/task-execution/{protocol,backend,testing,profiles,evaluation-harness}` + `backend-local/{supervisor,workspace,launchers,assembly}` (four packages, design §15) | `@jinn-network/task-execution-*`; backend-local components: `@jinn-network/task-execution-{supervisor,workspace,launchers}` + `@jinn-network/task-execution-backend-local` (the assembly — it *is* the local backend) |
| trust | `packages/trust/{core,resolve,testing}` | `@jinn-network/trust-{core,resolve,testing}` |
| discovery | `packages/discovery/{protocol,serve,client,testing}`, `facts/{evidence,task-execution,trust}`, `sources/evidence-journal` | `@jinn-network/record-discovery-*` |

Confirmed by the operator at the program gate (2026-07-28):

1. `record-discovery-*` npm prefix — confirmed (disambiguates from the existing
   `@jinn-network/evidence-discovery`).
2. `backend-local` as ONE package with four guard-enforced sub-regions — confirmed at the
   gate, then **REVERSED by the operator later on 2026-07-28** (marketplace-binding design
   session input): the package split is MAINTAINED — four separately consumable packages per
   backend design §15 (`supervisor`, `workspace`, `launchers`, `assembly`), the supervisor
   deliberately the most dependency-free because it is the piece most worth reusing. The
   §5 never-touches columns are enforced by package-level dependency edges in the tree's
   inventory/boundaries guards (stronger than sub-region wiring). See ruling §7.18 for the
   consumption rule that motivated the split. Internal DAG ratified (coordinator,
   2026-07-28, backend plan Finding (e)): **[supervisor ∥ workspace] → launchers →
   assembly** — the frozen launcher signature couples `launchers` to `TaskView`/
   `WorkspacePaths` (homed in `workspace`, which may import profiles) and `AttemptIdentity`
   (homed in `supervisor`, which may not); no fifth shared-`contracts` package (extraction
   deferred until a consumer outside the tree needs those types).
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
5. **Testing-package edges (restated for the four-package split):** the
   `@jinn-network/task-execution-testing` `./backend-local` slice takes production deps on the
   backend-local component packages it drives (`launchers` for the fake launcher's contract,
   `supervisor`/`workspace` for the fixture families, `backend-local` [assembly] for the
   backend-level suite); each component package consumes the testing package as devDependency
   only. No production cycle (evidence `local-runtime` precedent).
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
    patched). Mirror finding from T17 (2026-07-28): `task-execution-protocol` exports **no
    DSSE/PAE primitive at all** — by design (§22's pure-function surface is sealing +
    digest; envelope wrapping belongs to consumers, e.g. trust-core's `dssePreAuthEncoding`,
    itself PAE-byte-proven against evidence-protocol in the T10 leg). The TEP leg therefore
    asserts canonical-byte + digest-algorithm agreement, and a fixture documents the absent
    PAE export so nobody later "fixes" it with a duplicate. Do not add a PAE helper to the
    protocol package.
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
18. **Backend consumption rule (operator, 2026-07-28, from the marketplace-binding design
    stream):** the backend is a **library**; every product embeds its own instance with its
    own state root — there is no shared "local execution backend application". Bindings and
    hosts consume an embedded backend **only through the assembly's standard
    `TaskExecutionBackend` interface** — the marketplace binding composes as a peer (venue
    verbs: discover/claim/deliver/settle) and hands sealed bytes to `submit`, waits for the
    Delivery, and never imports or reaches into `supervisor`/`workspace`/`launchers`
    internals. The component packages exist to be consumed **individually when building
    other backends/bindings** (the reuse case), never as a side door into a running
    backend. Guards encode: nothing outside `packages/task-execution/backend-local/` imports
    `supervisor`/`workspace`/`launchers` except `assembly`, the testing slice, and the
    evaluation harness's launcher surface.
19. **Deployment-profile conformance placement (extension review, 2026-07-28):** the TEP core
    kit (`describeTaskExecutionBackendContract`) stays profile-agnostic and unchanged — TEP
    §24 places binding-integration checks at Layer 3, outside the shipped kit. The §16.2
    marketplace-profile checks (signed docs, mandatory executionIds+evidenceRecords,
    executor-signed Deliveries, dispatch-binding, evaluationSpecification digest equality)
    are authored natively in `marketplace-testing`; any backend put under the core kit
    implements its `TestableBackend` seam explicitly.
20. **closeAt honor-or-reject symmetry (extension review adjudication):** a binding that
    cannot genuinely enforce `closeAt` rejects it with `unsupported-requirement` (TEP §8
    forbids weak/partial honoring). Today-mode marketplace therefore rejects; revised-mode
    (on-chain claim window) honors. No "declared-approximate" capability class in v1. Both
    bindings behave identically to backend-local C1.
21. **Derivation-annotation extensibility:** the discovery derivation annotation is
    unknown-field-tolerant (the design's unknown-fields-skip discipline);
    `blockHash`/`finalityTier`/`contractGeneration` are ratified as registered standard
    additions via a dated addendum on the record-discovery plan. Marketplace M4 hard-gates
    on verifying the implemented annotation schema actually tolerates them (checked at the
    Phase 3 merge).
22. **Local cell-dispatch Attempt identity (benchmarking):** local single-party dispatch uses
    the 2-arg `submit` — the backend mints the Attempt URI; the run orchestrator reads the
    minted URI back into the Matrix `attempt` field; resumption idempotency rides the stable
    Submission digest + idempotency key. `deriveAttemptUri` is a two-party concern and enters
    benchmarking only in its marketplace mode via the binding.
23. **Benchmarking Report plural subjects + pre-registration:** a v1 Report's disclosures are
    lossless and one-to-one with `subjects[]`: `disclosures.perSubject[]` has the same length
    and order, each entry names the corresponding Matrix's exact lowercase-hex sha256 digest
    and carries that Matrix's integrity-tier, pinning, independence, completeness, and
    attrition blocks verbatim. No sealed aggregate may merge repeated arm IDs, collapse
    outcomes, choose a shared floor, or deduplicate flags across subjects; any convenience
    aggregate is a separate derived view. `preregistered: true` is producer-derived and valid
    only when the exact method tuple (id, version, verdict rule, and all parameters) appears in
    every resolved subject Run's `analysisPlan[]`; an unresolved Run or any mismatch forbids
    `true` and makes verification of a claimed `true` fail closed.
24. **I-JSON Unicode scalar enforcement:** every stack canonical sealer recursively rejects an
    unpaired UTF-16 surrogate in any object key or string value before JCS serialization.
    Valid supplementary-plane scalar values (a well-formed surrogate pair in JavaScript) remain
    accepted. The ground-truth fix lands across every copied sealer with shared positive and
    negative equivalence fixtures; byte-equivalence alone is not conformance when every copy
    accepts the same illegal input.
25. **Conformance-kit dependency direction:** a conformance/testing package consumes the
    implementation packages it tests. An implementation package never imports its testing kit,
    including from its own test sources or through a dev-only portal; such an edge makes the
    standalone CI build graph cyclic and can pass locally only because of stale `dist`
    artifacts. Concrete-subject adapters and kit invocations live in the testing package or a
    later consumer.
26. **Benchmarking bootstrap replay procedure:** `noninferiority-iut@1` uses the registry-pinned
    procedure identifier `xorshift32-v1`: a nonzero unsigned 32-bit sealed seed; the xorshift32
    transitions `x ^= x << 13`, `x ^= x >>> 17`, `x ^= x << 5`, truncating to uint32 after
    each transition; one next-uint32 draw per sampled position; and
    `floor((draw / 2^32) * n)` as the with-replacement index into the UTF-16-code-unit-ordered
    paired-task vector. The sealed method parameters carry `seed` and `resamples`; zero or an
    out-of-range/non-integer seed fails validation. BCa jackknife acceleration is computed
    deterministically and consumes no PRNG draws. The procedure is statistical replay
    machinery, not a cryptographic primitive.
27. **`paired-mcnemar@1` replicate boundary:** exact McNemar v1 is the seed library's
    single-replicate (`Run.replicates === 1`) binary matched-task method. A subject Run with
    more than one replicate is a typed incompatible input for this method; the implementation
    never invents majority, any-pass, or overwrite-based replicate reduction. Multi-replicate
    analyses use `avg-at-k@1`, `pass-at-k@1`, or `noninferiority-iut@1` (which derives paired
    per-task rates/costs under its own declared contract). The kit carries both an exact
    single-replicate McNemar fixture and a multi-replicate fail-closed fixture; every excluded
    cell key remains reported deterministically.
28. **Revised marketplace lifecycle event ABI:** projector M4 freezes the revised-generation
    lifecycle-event contract that Solidity M7 must implement. `AttemptExpired` and
    `AttemptReleased` each carry `(uint256 indexed taskId, uint32 indexed attemptIndex,
    address indexed operator)`, exactly the attributable engagement fact required by design
    §5.2. `TaskClosed` carries `(uint256 indexed taskId, address indexed creator)`: the close
    fact names both the task and the authorized party, satisfying event completeness's
    indexed-party rule. Refund value is a distinct economic fact and therefore remains a
    separate `TaskBudgetRefunded` event rather than being folded into `TaskClosed`. M4 decodes
    these shapes only behind `generation: revised`; today mode never fabricates them. M7's
    compiled ABIs and lifecycle tests must prove exact agreement with the projector fixture.
29. **Revised marketplace common-event ABI:** revised projection never reuses V3 router event
    shapes. M4 freezes a separate V4 ABI for Task creation, solve/evaluation engagement,
    sha256 Delivery/Verdict claims, budget refund, and capacity top-up; marketplace plan
    Addendum 2026-07-29-f carries the exact Solidity signatures. Unix timestamps are absolute
    seconds in `uint64`; `closeAt == 0` means absent; every claim emits its concrete absolute
    attempt deadline. Release cooldown and the optional per-operator simultaneous-claim cap
    are contract-global configuration, not per-task fields. `AttemptsAdded` is a distinct
    capacity fact and re-opens discovery availability after exhaustion. The external Mech
    `Deliver` event remains an operational join in revised mode, but only the V4 router's
    sha256 anchor determines protocol Delivery/Verdict identity. Revised logs are decoded only
    against this V4 ABI plus the external Mech ABI and §7.28 lifecycle events—never by
    composing the V3 router ABI. M7 must implement the exact event contract and prove compiled
    ABI equality against the M4 fixtures.
30. **Marketplace reorg correction is Attempt-scoped in TEP:** the marketplace design §8
    projector-table phrase “corrective terminal per TEP fold rules” applies only where the
    reorg invalidates a previously projected **Attempt-scoped** chain fact. The projector appends
    an authoritative `attempt-terminal.v1 { state: "lost" }` on that same Attempt URI and source;
    a later authoritative terminal may supersede it under TEP §10.4 rule 6. It never fabricates
    `submission-rejected` or `submission-closed` for a reorged `TaskCreated`: TEP's frozen
    submission vocabulary has no reorg correction, `substrate-reorg` is not a §13 error category,
    and inventing either would corrupt their defined meanings. For pre-Attempt submission
    availability, the append-only signed discovery retraction (`reason: "reorged"`) is the
    correction; canonical query state excludes the orphaned derivation while the raw
    `submission-accepted` observation remains historical. M4 conformance must prove both halves:
    a Task-post reorg retracts discovery availability without a synthetic TEP rejection/close,
    and an Attempt-scoped reorg appends `lost` without rewriting prior observations.
31. **Marketplace projection is an incremental stateful reducer:** M4's
    `projectObservations(events)` is not licensed to keep Mech-delivery joins, Task capacity,
    deduplication, or observation sequence solely in call-local maps. The production composition
    consumes an explicit caller-owned projection state (persisted by the host or deterministically
    rebuilt from the canonical ordered log) and produces observations and announcements from the
    same state transition. The same event identity applied twice emits nothing twice; a full-log
    replay equals any ordered split-batch projection; Mech `Deliver`→router-claim joins and
    Task-capacity transitions must span batches; observation sequences do not reset at a batch
    boundary. `projectAnnouncements` must consume the exact observation result of that shared
    transition, never call a fresh stateless observation projection. Reorg handling may rebuild
    derived join/capacity/dedupe state from canonical logs, but signed observations and
    announcements are corrected only by append. M4.5 must carry split-batch, replay-idempotency,
    cross-batch join/capacity, and monotonic-sequence vectors.
32. **Marketplace terminal reorgs require canonical filtering before TEP fold:** §7.30's
    appended `lost` is directly fold-correct when no earlier authoritative terminal survives.
    It cannot by itself replace an already projected `delivered` / `rejected` / `failed`
    terminal: generic TEP §10.4 correctly treats terminal→`lost` as contradictory. Therefore every
    marketplace-produced Protocol Observation carries its exact §7.21 derivation annotation, and
    a reorg correction additionally names the retracted observation id and orphaned block hash.
    The marketplace current-state selector keeps the immutable raw history, removes ordinary
    observations whose derivation is proven orphaned, retains the explicit correction, and only
    then calls the unchanged generic TEP fold. Thus a reorged terminal yields canonical `lost`,
    and a later canonical terminal supersedes it under rule 6; an unfiltered historical fold may
    remain contradictory and must never be presented as canonical chain state. M4.5 must prove
    the raw-history, canonical-filtered, and later-correction cases. This does not add a generic
    chain rule to TEP.
33. **Local secret forwards materialize just-in-time before shim spawn:** the backend-local
    plan's opaque `secrets/*.handle` descriptor is not itself usable secret material. A
    host-injected `SecretForwardResolver` redeems declared handles only after durable
    `spawn-intended` and immediately before `spawnShim`, writing the launcher-declared target
    inside the Attempt's `secrets/` directory with no-follow/exclusive `0600` semantics. Raw
    values never enter journal, `meta/`, plan, logs, or process arguments; terminal cleanup wipes
    them even when harvest fails. A grant with no resolver fails before spawn rather than
    creating an unusable handle. This post-intent/pre-spawn boundary is the v1 realization of
    design §6.1's “at exec” requirement; the shim forwards the resulting path and the harness
    reads it only when needed.
34. **Evaluation pair-fixing is split at the backend boundary:** the evaluation harness must
    parse exact Task, Delivery, Result, and EvaluationSpec bytes; verify Delivery→Task,
    Delivery-output→Result, outcome/supersession rules, and byte equality with the profiles
    full-document `deriveEvaluationTask(T,D,results,spec)` template before calling an adapter.
    This proves internal pair consistency. Selecting which internally valid `(T,D)` is the
    settlement-authorized pair remains the dispatching venue/binding's responsibility (the
    marketplace named-check/dispatch-context layer); backend-local does not import settlement
    policy or invent a second expected-pair authority.
35. **New evaluation claim evidence is stored before signing:** `claimEvidence.kind="content"`
    remains in the surviving Runner adapter contract, so the harness may not replace it with a
    locally computed descriptor. The evaluation deployment injects an evidence-repository writer
    contract; the runtime applies bounds, stores exact bytes first, and gives the Attestation
    Issuer only the repository-returned descriptor. Content with no writer or a failed store is
    an operational no-verdict failure. Existing descriptor evidence is digest-validated and
    passes through without re-storage.
36. **Linux custody may use a native helper beneath the Node shim contract:** design §6.1's
    behavioral contract—subreaper custody, cgroup binding where delegated, zombie-pinned group
    kill ordering, straggler reap, and real process-table fingerprinting—takes precedence over
    the phrase “self-contained Node script.” The supervisor package may ship a small auditable
    platform helper beneath the same public shim API. On Linux, subreaper and group-empty custody
    are mandatory; delegated cgroup binding is used when the host provides it and its absence is
    the already named residual. macOS retains the design's process-group residual. If required
    custody support is unavailable, preflight/capabilities fail closed rather than advertising
    cancellation or active deadlines that the assembly cannot enforce.
37. **The claim-evidence writer and bound are deployment contracts, not guessed constants:**
    the evaluation harness defines a narrow injected `EvidenceRepositoryWriter` whose
    `putClaimEvidence({ name, bytes, mediaType? }, { signal? })` stores the exact bytes through
    the deployment's ordinary Evidence Repository and returns the complete `ResourceDescriptor`.
    `EvaluationHarnessDeployment` also requires an explicit positive safe-integer
    `maxClaimEvidenceBytes`; content exceeding it fails before repository I/O. The harness
    validates the returned descriptor, requires its `name` and optional `mediaType` to equal the
    adapter claim, forbids returned inline `content`, and passes that returned descriptor
    unchanged to Attestation Issuer. It does not synthesize a descriptor from a locally computed
    digest or accept a write receipt alone. A missing/invalid limit, missing writer, malformed or
    contradictory descriptor, or failed store is an operational no-verdict failure. A host
    adapter over `EvidenceRepository.putArtifact` may form the descriptor from the repository's
    trusted write receipt; the harness itself neither imports a concrete repository nor invents
    a second artifact store.
38. **Secret forwards are explicit launch declarations with backend-owned materialization:**
    `LaunchPlan` gains `secretForwards?: Array<{ grantKey: string; target: string }>`; `target`
    is a unique portable basename under that Attempt's `secrets/`, never an absolute path,
    separator, `.`/`..`, symlink, or resolver-selected location. Every `env` value of the form
    `secrets/<target>` must have exactly one declaration; a file-reading harness may declare a
    forward without putting its path in `env`. The fsynced spawn intent may carry only
    `(grantKey,target)`, never a grant descriptor or resolved bytes. The host-injected
    `SecretForwardResolver.resolve({ attempt, grantKey, descriptor }, { signal? })` returns an
    owned `Uint8Array`; after the intent and immediately before shim spawn, backend-owned code
    snapshots it, writes the declared target with no-follow/exclusive `0600` semantics under the
    verified `0700` directory, and zeroes the transient buffers. Missing/duplicate grants,
    missing resolver, invalid targets, symlinks, existing targets, or resolution/write failure
    fail before spawn, append a never-executed failure, and run terminal cleanup. Preflight and
    capabilities fail closed when a selected launcher requires forwards but no resolver exists.
39. **Admission receipts remain in their normative data path and extend exact derivation:**
    the subject Submission carries one `ResourceDescriptor` named `admission-receipt` at
    annotation key `https://jinn.network/annotations/admission-receipt/1.0`. The marketplace
    binding extracts that exact descriptor and the profiles `deriveEvaluationTask` input gains
    optional `admissionReceipt`; when present, the descriptor is appended after the
    name-sorted subject artifacts in the derived Task's `inputs`. The generic no-receipt case
    retains its existing bytes and digest. Marketplace decision-grade evaluation requires the
    receipt. This resolves the profiles §7.6 requirement to carry the receipt into the
    evaluation Task; it must not be hidden in `profileParameters`, a capability grant, or an
    unrelated top-level Submission extension. The evaluation Submission does not duplicate the
    receipt: it binds the newly derived Task and carries only dispatch fields and the private
    material's `capabilityGrants`.
40. **The M5 evaluation-sealing helper has a closed caller surface:** it accepts the exact
    settlement-context subject Task, subject Submission, Delivery, Results, EvaluationSpec
    digest, an explicit `submissionFields` object (`submission`, `requester`,
    `idempotencyKey`, `nonce`, `deadline`, and the allowed optional TEP dispatch fields), the
    new evaluation Submission's `capabilityGrants`, `publicSpec`, and
    `sealerRole: "requester" | "evaluator"`. Protocol and task reference are produced, never
    caller-overridden. It returns
    `{ task: { document, bytes, digest }, submission: { document, bytes, digest } }`; “seal”
    means canonical TEP bytes, not a DSSE signature. The named-check input separately carries
    the requester-signed Submission envelope. Evaluator sealing is allowed only when
    `publicSpec === true` and `capabilityGrants` is empty; every private/grant-bearing case
    requires `sealerRole: "requester"`.
41. **Decision-grade Result Evaluation uses the Result Evaluation wire vocabulary:** after
    parsing a conforming Statement, `pass → Pass`, `fail → Fail`, and
    `inconclusive → Unresolved`. `Invalid` has no conforming Result Evaluation verdict value:
    operational failures are no-verdict paths, so an on-chain `Invalid` claim cannot match a
    decision-grade Statement. The broader today-mode venue decoder may continue recognizing
    legacy `INVALID`, but M5's named gate must not use that permissive mapping or manufacture a
    Statement verdict.
42. **Admission-receipt validity includes cryptographic identity and exact-byte binding:**
    after the profiles structural/subject check, the marketplace gate verifies the exact
    receipt envelope digest against the descriptor carried through §7.39 and calls
    `verifyEnvelopeBinding` with the DSSE signer key, structurally declared issuer Agent IRI,
    trusted receipt effective time, deployment policy purpose `admission-agent`, and namespaced
    trust scope `https://jinn.network/trust-scopes/admission-receipts/1.0`. The effective time
    is supplied by trusted anchored receipt metadata, never an untrusted free-form payload
    assertion. A missing signer/effective time, wrong digest, invalid signature, unbound issuer,
    scope/policy failure, or subject mismatch fails the named check.
43. **Verdict effective-time cross-check is ordered, not exact-equality:** the signed Result
    Evaluation's RFC 3339 `evaluatedAt` is its envelope effective time; the claim block's
    canonical timestamp is the settlement claim time. Both must parse, and claim time must be
    greater than or equal to effective time. Exact instant equality is neither required nor
    normally possible; no arbitrary global tolerance is invented. The settlement join still
    resolves the verdict key at effective time and the settling actor at both effective and
    claim time, so later revocation or a future-dated verdict fails closed.
44. **The marketplace, not the evaluator, fixes the named-check pair:** gate input carries the
    exact settlement-authorized subject Task/Delivery/Result descriptors and bytes, the subject
    Submission with §7.39's receipt descriptor, the EvaluationSpec, and the actual evaluation
    Task bytes. The gate re-runs the full profiles derivation over that supplied settlement
    context and requires byte equality before any adapter/verdict credit. It accepts no
    evaluator-selected alternate pair and adds no second host assertion; backend §7.34 remains
    responsible only for internal consistency of the pair it was dispatched.
45. **Trust scope extensions use the stack extension-name grammar:** the trust design's
    “namespaced extensions” means TEP §21.3 reverse-DNS or absolute-URI names, not only the
    implementation's narrower `namespace:token` regex. `ScopeSchema` therefore keeps the five
    closed vocabulary values and also accepts syntactically valid reverse-DNS names and absolute
    URIs, including §7.42's
    `https://jinn.network/trust-scopes/admission-receipts/1.0`. It rejects relative/bare names,
    malformed schemes/authorities, whitespace or control characters, and reverse-DNS labels
    with empty/leading-hyphen/trailing-hyphen components. Existing `jinn:...` absolute-URI scope
    values remain valid. The trust-core sealing/validation fixture must use the admission scope
    in a real KeyBinding so M5 cannot pass through an impossible fake resolver state.
46. **Benchmark eligibility refines, but does not re-digest, Task profiles:** the generic
    `repository-work/1.0` profile remains authoritative with its existing optional
    `payload.provenance { kind, sourceCommitment? }` surface and pinned bytes. A Task referenced
    by a Benchmark is a stricter consumer-side subset: once its exact bytes are available,
    `benchmark-judgeability` requires `payload.provenance.timestamp` as a valid RFC 3339 string
    and exactly one source-family claim:
    (a) a non-empty `source` string, or
    (b) `sourceCommitment` in lowercase `sha256:<64 hex>` form. A commitment is an opaque,
    author-claimed, stable grouping token: within a Benchmark, equal source families must use
    equal commitments and unequal asserted families must use unequal commitments; it need not
    disclose the source and sealing does not attest the claim. The pinned clustering key is the
    tagged pair `("source", source)` or `("sourceCommitment", sourceCommitment)`, never an
    author-supplied Report parameter and never an untagged concatenation. All clustering methods,
    including `noninferiority-iut@1`, resolve every participating Task and disclose the basis and
    cluster count in their results. Missing, ambiguous, malformed, unavailable, digest-mismatched,
    or noncanonical provenance fails closed (or remains `unevaluated` before scheduled reveal)
    at Benchmark judgeability, rather than first failing during Report computation. Optional
    quality/canary provenance fields remain sealed author claims with no additional v1 core
    semantics. This reconciles benchmarking design §6.1/§9.2 with profiles design §8 without
    altering the generic profile document or its digest.
47. **`noninferiority-iut@1` uses a deterministic source-cluster bootstrap:** for its quality
    BCa leg, exact paired Tasks are grouped by §7.46's tagged source-family key. Cluster keys and
    members are UTF-16 code-unit ordered. With `C` clusters, each resample draws exactly `C`
    cluster indices with replacement from the xorshift32-v1 stream (one uint32 transition per
    cluster position), concatenates every member of each drawn cluster in member order, and
    computes the task-weighted mean quality difference over that expanded sample. Thus the draw
    count is exactly `resamples * C`; no second within-cluster draw occurs. The observed estimate
    remains the task-weighted mean over all paired Tasks. BCa acceleration uses deterministic
    leave-one-whole-cluster-out jackknife estimates and consumes no PRNG draws. Fewer than two
    source clusters makes the quality leg `INCONCLUSIVE`; it must not fall back to task-level
    resampling. Results disclose `basis`, `count`, tagged cluster membership, bootstrap unit
    `"source-cluster"`, and draw count. The separately specified both-solve cost leg remains the
    one-sided paired-task Wilcoxon from design §9.2. This supersedes §7.26's task-position
    resampling only for this method's quality bootstrap; seed validation and xorshift transition
    semantics are unchanged.
48. **Backend restart recovery reconstructs contracts from durable identity, never host memory:**
    the assembly's provisioner injection returns
    `{ id, contract: ProvisionerContract }`, where `id` is a stable non-empty implementation
    identifier. `spawn-intended` durably carries that id and the complete canonical LaunchPlan
    (including blame rules and secret references, never secret values). The backend also writes
    its exact dispatch-context bytes under backend-owned `meta/` before provisioner setup; the
    already-persisted sealed Task and Submission bytes remain authoritative. Recovery re-reads
    and seal-validates those exact bytes, re-resolves the digest-pinned profile, re-runs the pure
    requirements merge, reconstructs the same `LocalProvisionerInput`, and calls the injected
    selection once. Its returned id must byte-equal the journaled id or recovery fails loud as
    `contradictory`/backend unavailable; the returned contract may then perform idempotent
    harvest. The provisioner selector is therefore required to be deterministic and
    registry-backed for identical input, and provisioner contracts may not depend on lost
    per-process state for `harvest`. Recovery parses the journaled LaunchPlan and never calls a
    launcher or re-plans.

    Evidence capture resumes its existing
    `meta/evidence-recording` through the execution-recorder's public `resume` operation; it
    never calls `start` again and never mints a replacement Execution ID. Required capture
    (`always`) fails terminally if that durable recording is missing/corrupt; best-effort capture
    records the degradation and continues. Late matching outcomes, harvesting, and recording
    all flow through one idempotent completion routine using this reconstructed context.
    Delivery remains the seal-once checkpoint: if present, recovery only re-records its exact
    bytes. This is the reconstruction seam implied by backend design §6.4/§7.4/§8.1 and does not
    persist executable code or a provisioner object.
49. **Marketplace verdict announcements are verified before projection:** the announcement
    projector gains a host-injected, required-on-`VerdictDeliveryClaimed`
    `verifyVerdictObservation(event, material)` port. It receives the exact decoded chain event
    and the exact evaluation Delivery material already selected for announcement, and returns
    `{ gate: VerdictObservationGate, statementVerdict? }`, where the optional value is only
    `"pass" | "fail" | "inconclusive"`. The projector independently compares the event's
    `verdictCode` to §7.41's strict `decisionGradeVerdictCode(statementVerdict)`: it never
    accepts a host-returned copy of the on-chain code. A missing port, non-decision-grade gate,
    missing/unmappable Statement verdict, or code mismatch suppresses both the evaluation
    Delivery announcement and the verdict-caused Submission withdrawal. The result exposes a
    typed `verdict-observation-refused` entry carrying derivation, on-chain code, optional
    Statement verdict, and exact failures; it does not silently drop the divergence.

    On success, the available evaluation Delivery announcement's signed `facts` includes
    `https://jinn.network/facts/marketplace-verdict-correspondence/1.0` with exactly
    `{ onChainVerdictCode, statementVerdict }`. The material is resolved once and the same bytes
    feed both verification and record publication. Non-verdict flows are unchanged. Existing M4
    fixtures inject a conforming verifier; tests prove absent/failed/mismatched verification
    causes zero record writes and no withdrawal. This realizes marketplace design §6.4's
    off-chain decision-grade gate without moving trust resolution or Statement parsing into the
    chain decoder.
50. **RFC 3339 consumers validate the civil timestamp, not only its parseability:** every
    benchmarking boundary that accepts an authority-bearing timestamp uses one shared
    calendar-strict validator. A matching lexical shape plus a finite `Date.parse` result is
    insufficient because host runtimes may normalize impossible dates (for example,
    `2026-02-30T00:00:00Z`) instead of rejecting them. Validation must independently prove the
    represented year/month/day against the proleptic-Gregorian calendar and prove the time and
    offset components are within the RFC 3339 grammar before any ordering or effective-time
    comparison. The original string remains the sealed value; validation never normalizes or
    rewrites it. Benchmark judgeability, resolved provenance, method parameters, clean-subset
    anchors, and Report verification consume this same predicate and carry an impossible-date
    negative vector. The generic repository-work profile and its digest remain unchanged.
51. **Mandatory statistical conformance distinguishes cluster BCa from iid resampling:** the
    benchmarking M1–M3 standard gate includes an independently calculated,
    nonconstant/nonzero-acceleration `noninferiority-iut@1` oracle whose source clusters are
    non-singleton and unequal. It pins the exact full quality result, not only bootstrap
    disclosure metadata. A paired discriminator holds the Task observations, seed, draw count,
    and method parameters fixed while changing only their tagged source-cluster grouping, and
    asserts the exact resulting lower bound in both cases. The aggregate unit oracle also pins
    whole-cluster jackknife acceleration and the selected adjusted quantile/index. Singleton-only
    fixtures, zero/one extremes, or assertions limited to `basis`/`unit`/draw count are vacuous:
    they cannot reject task-level iid sampling or an individual-Task jackknife. The runtime
    algorithm remains §7.47; this ruling strengthens the executable conformance contract rather
    than changing the statistic.
52. **Marketplace posting ownership is atomic before wallet authority is exercised:** a
    `lookup` followed by an unconditional intent `persist` is not an at-most-once protocol.
    `PostingIntentStore` exposes a linearizable claim operation over the exact
    `(creatorSafe, taskCidDigest, submissionDigest)` key. Its result is exactly one of:
    caller-owned pending intent with an unguessable owner token, an already-pending intent owned
    elsewhere, or the prior resolved outcome. Only the owner may resolve the intent. Concurrent
    contenders never both reach the wallet port; losers return the resolved outcome or a typed
    broadcast-uncertain result without uploading/broadcasting again. After slow preparation, the
    owner performs a final token/freshness fence immediately before invoking the wallet write,
    with no intervening await or external effect. A crash after the durable claim remains the
    existing recovery-scan case and is never repaired by blind rebroadcast. The in-memory
    reference store and every durable host adapter must implement the same atomic contract, with
    a barrier-driven simultaneous-contender conformance vector.
53. **Marketplace evaluator distinctness compares resolved Agent identities:** address
    inequality remains the cheap on-chain preliminary filter, never the decision-grade security
    boundary. The verdict gate receives settlement-authorized solver identity context:
    `{ address, claimedAgent, declarationKey, effectiveTime }`, alongside the evaluator's
    existing verdict-key/settlement-declaration context. It resolves both declaration legs with
    the trust `BindingResolver` at their authority-bearing times, fails closed if either is
    unavailable/invalid, and requires the resolved solver Agent IRI to differ from the evaluator
    Agent IRI returned by the successful §7.5a settlement join. Two distinct addresses or Safes
    bound to one Agent therefore fail `evaluator-distinctness`; invented/unbound claimed IRIs
    fail resolution. Exact named-check fixtures cover same-address, two-address/same-Agent,
    distinct-bound-Agent, and unresolved-leg cases.
54. **The completed marketplace requester backend exposes its M0–M5 behavior, not the earlier
    M2 snapshot:** today-mode accepts the supported one-verdict evaluation rail and rejects only
    unsupported evaluation requirements such as `minVerdicts > 1`. A requester-sealed private
    evaluation Submission may carry `capabilityGrants`; the chain binding transports those exact
    sealed references for the evaluator and never redeems or drops them, so absence of a local
    grant resolver is not a rejection reason. An end-to-end `deriveAndSealEvaluationSubmission`
    → requester `submit` vector proves that path. The standard backend also wires its completed
    lifecycle: `capabilities().cancel` is true exactly when the injected lifecycle port exists,
    and the standard Attempt-only `cancel` is terminal-aware/idempotent, maps to the requester
    signal, and never authors or revokes a work outcome. Idempotency is durable in the injected
    lifecycle operation and keyed by Attempt; a backend restart cannot signal twice. The
    operator-facing `releaseAttempt` remains a separate authorized venue action taken by a
    compliant operator after observing the request, never a chain effect of the requester
    `cancel` call. Submission close remains the existing explicit `closeSubmission(taskId)`
    binding extension and routes through the generation seam; it is not smuggled into TEP's
    Attempt-only `cancel` signature. Unimplemented optional standard verbs remain advertised
    false.
55. **Marketplace §16.2 evidence checks start from a Delivery-bound exact record:** native
    conformance receives the exact canonical Delivery bytes, selects its named Execution
    Evidence reference, resolves exact record bytes, hashes those bytes, and requires equality
    with the selected reference before parsing any fields. The resolved record must itself pass
    its family's canonical/schema validation. Only that digest-bound record may prove the
    per-Attempt dispatch-context captured input and the Evidence
    `evaluationSpecification`/Task descriptor equality. A caller-supplied parsed object detached
    from the Delivery reference has no authority. Mandatory swapped-record, digest-mismatch,
    noncanonical-record, missing-reference, wrong-dispatch, and wrong-evaluation-spec vectors
    assert the full named-check outcomes.
56. **Evaluation-harness exact subject admission preserves its profiles-only protocol seam:**
    the harness production package continues to have no direct
    `@jinn-network/task-execution-protocol` edge, as frozen by the backend package graph and
    source-boundary guard. `task-execution-profiles` instead exports one evaluation-specific
    exact-subject verifier. Given exact Task bytes, Delivery bytes, and Result materials, it uses
    the protocol package's authoritative fatal decode/schema/sealers to require canonical byte
    equality, Task↔Delivery digest binding, unique output names, declared-output/media-type
    agreement, and exact Result digest/cardinality agreement, then returns only the
    evaluation-facing validated subject view. It does not select the settlement-authorized pair
    and imports no marketplace policy. The harness invokes this verifier before derivation,
    adapter execution, or signing; it never duplicates a TEP sealer or trusts “preverified” host
    claims without its own check. Profiles owns focused hostile-byte/pair tests and the harness
    owns the adapter-never-called integration vectors. The direct protocol import and manifest
    dev-only mismatch are removed; the original source-boundary rule remains unchanged.

57. **Benchmarking authority-time ordering preserves arbitrary RFC 3339 precision:** validation
    and comparison are separate operations. After §7.50's shared calendar-strict validation,
    every benchmarking cutoff, provenance, anchor, and effective-time ordering uses one shared
    exact-instant comparator. It applies the declared numeric offset and compares the complete
    fractional second at arbitrary precision; it never projects through epoch milliseconds,
    `Date.parse`, or another lossy host representation. Decimal tails compare by numeric value
    (`.1 == .10`) while the original authority-bearing string remains unchanged. Equal instants
    expressed under different offsets compare equal. Leap-second validation and ordering remain
    calendar-strict. Mandatory vectors distinguish `.0001Z` from `.0002Z` in both clean-subset
    cutoff and announcement-anchor paths, and pin an equal-instant offset pair.
58. **Benchmarking Report admission requires the one exact trust DSSE encoding:** structural
    `parseDsseEnvelope` success is insufficient. Trust-core owns an authoritative exact DSSE
    envelope parser/round-trip which validates the closed envelope and signature-member shapes,
    fatal UTF-8 JSON, strict base64, and the existing non-empty-signature rule, reconstructs the
    envelope with `sealDsseEnvelope` from the decoded payload and signatures in their received
    order, and requires byte equality with the received bytes. Benchmarking `verifyReport`
    invokes that exact parser before trust resolution or method replay. Pretty-printed or
    reordered JSON, trailing data, duplicate or extra members, non-producer base64 spellings, and
    any other byte-distinct representation fail `report-envelope` even when the unchanged
    payload/signature would pass PAE verification. The conformance verifier proves this with a
    PAE/signature-semantic test double, never raw-envelope identity.
59. **Marketplace revised-mode announcements bind the exact resolved material to the chain
    anchor before any effect:** for revised `TaskCreated`,
    `documentDigest(material.bytes)` must equal the event's `submissionDigest`; for revised
    `SolutionDeliveryClaimed` and `VerdictDeliveryClaimed`, it must equal `deliveryDigest` and
    `evaluationDeliveryDigest`, respectively. The projector performs this comparison before
    facts recomputation, verdict verification, record publication, archive/head writes, or
    announcement signing. A mismatch produces a typed refusal carrying the material role,
    expected digest, actual digest, and exact chain derivation, with zero downstream writes.
    Today-mode solution material still must satisfy its existing Mech-request correspondence
    join and must byte-hash to the delivery-recorded protocol digest selected by that join;
    no Submission digest anchor is invented for the deployed today-mode `TaskCreated` event.
60. **Marketplace capacity projection separates live occupancy from monotonic Attempt
    identity and append-only availability:** state records `maxTotal`, the exact set/map of live
    Attempt indices, the monotonic highest/seen Attempt identity, and whether availability is
    currently open or closed as distinct facts. A revised claim adds its exact live index and
    can emit capacity close/withdrawal only on an open→closed transition. The matching
    `AttemptReleased` or `AttemptExpired` removes that exact live index; when this changes
    closed→open, the projector appends a fresh signed `available` Submission announcement. It
    does not rewrite an earlier announcement, reopen or rewrite the immutable TEP
    `submission-closed` observation, or reuse an Attempt identity. `AttemptsAdded` likewise
    reannounces only on closed→open. Duplicate lifecycle facts are idempotent; unknown,
    contradictory, or identity-regressing facts fail closed with a typed refusal. Today-mode
    retains the deployed contracts' monotonic claim-count behavior and fabricates no
    release/reopen fact the chain cannot supply.
61. **Marketplace verdict and projection failures use only the frozen TEP §13 category
    vocabulary:** chain/material digest divergence maps to `content-corruption`; a missing
    Delivery, request-id, or required reference join maps to `invalid-reference`; an invalid or
    unmappable verdict code maps to `protocol-violation`; Result Evaluation `Invalid` is rejected
    with `protocol-violation`; `Unresolved` fails with `result-unavailable`; normal `Fail`
    rejects with no error category (a detail may say `verdict-fail`); and `Pass` delivers with no
    error category. Projector/binding implementation may retain richer internal refusal kinds,
    but no Protocol Observation serializes `verdict-fail`, `verdict-invalid`,
    `verdict-unresolved`, `verdict-code-invalid`, `digest-divergence`, or
    `delivery-join-missing` as a TEP category.
62. **Marketplace native §16.2 conformance includes a non-vacuous signed-Task family:** the
    kit seals canonical Task bytes, wraps those exact bytes in DSSE, and verifies the signature
    and claimed creator/requester authority with the real trust verification primitive and
    resolver seam used by the marketplace profile. The positive vector asserts the exact Task
    payload recovered from the envelope and the successful authority result. Hostile vectors
    cover payload substitution/noncanonical Task bytes and a signer lacking authority for the
    claimed Agent; a test double that merely reports a valid key without binding the received
    PAE/envelope bytes is not conforming. This family is additional to, not a substitute for,
    the existing signed-Submission and executor-signed-Delivery vectors.
63. **Trust authority-time ordering is calendar-strict and exact:** trust-core owns a
    standalone RFC 3339 validator/comparator suitable for its foundation package. It applies the
    numeric offset, preserves arbitrary fractional precision, handles valid leap seconds, and
    never orders authority times by lexical string comparison, `Date.parse`, or epoch
    milliseconds. `verifyEnvelopeBinding` uses it for binding `effectiveStart`, `expiresAt`, and
    anchored revocation `effectiveTime` comparisons; malformed authority times fail closed
    before ceremony/policy success can authorize the envelope. Offset-equivalent instants compare
    equal, and hostile vectors prove that an earlier revocation written with a lexically later
    offset spelling rejects. Trust and benchmarking keep independent package-local
    implementations and prove shared exact vectors, preserving the frozen dependency direction.
64. **The trust DSSE producer cannot emit an envelope its exact parser rejects:**
    `sealDsseEnvelope` rejects every zero-length produced signature before serialization, in
    addition to its existing key-id and signature encoding checks. Producer→exact-parser
    round-trip is mandatory for every accepted signature sequence and preserves received
    signature order. The Report verifier carries one producer-created positive round-trip and
    one empty-signature producer refusal; callers cannot use the lower-level producer to bypass
    §7.58's non-empty-signature admission.
65. **Benchmark record timestamp schemas use the shared civil-time authority directly:**
    Benchmark reveal `notBefore`, Run `closeAt`, Matrix close-boundary time, and every equivalent
    M1–M3 record field are validated by the calendar-strict RFC 3339 predicate itself. They are
    not first filtered through a host/Zod datetime validator whose narrower grammar rejects a
    valid leap second. Mandatory schema vectors accept `2016-12-31T23:59:60Z`, reject an invalid
    leap second/date/offset, and retain the original sealed spelling.
66. **Benchmark judgeability distinguishes unavailable material from proven pre-reveal
    material:** an `immediate` Benchmark whose Task bytes cannot be resolved fails closed and
    identifies every unavailable digest. `scheduled` may return
    `committed-not-revealed` only when an explicit trusted comparison time is strictly before its
    valid `notBefore`; `after-run` may do so only with explicit trusted evidence that the
    applicable Run is not closed. At or after reveal, missing bytes fail closed. An absent
    resolver or absent/invalid reveal context never proves pre-reveal state and therefore never
    yields `unevaluated`. Resolved bytes continue through digest, canonical Task, evaluation
    descriptor, and provenance checks unchanged.
67. **`noninferiority-iut@1` is version-robust exactly through its shared-Task pairing:**
    its registry metadata declares `versionRobust: true`. Cross-Benchmark comparison is legal
    only over the exact shared Task digests the method actually pairs, and the result discloses
    those pairings and all exclusions under the existing §7.47 method contract. A conformance
    vector with two distinct Benchmark digests and identical shared eligible Task pairings must
    pass; a comparison with no valid shared pairing remains inconclusive/fails under the method,
    never by bypassing comparability.
68. **Benchmark cell-dispatch helpers admit only exact Run identities:** before constructing
    `submission.annotations.run` or a cell idempotency key, both helpers validate `runDigest` as
    lowercase `sha256:<64 hex>`. Malformed, shortened, uppercase, or bare digests throw before
    returning any derived value. The emitted annotation retains the exact validated digest; the
    idempotency delimiter and cell/dispatch rules are otherwise unchanged.
69. **Package-tree inventory cardinality is derived from the live inventory declaration:**
    no benchmarking guard asserts a hand-maintained literal package count. The declared graph,
    discovered manifests, and registered package rows remain exact-equality checked, so adding or
    removing a row changes the effective count without a second numeric edit. This is the
    benchmarking application of §7.6 and must be covered by a guard self-test, not merely a
    source comment.
70. **Benchmark Cartesian cardinality is exact and bounded before enumeration:** the records
    package computes `|items| × |arms| × replicates` with `BigInt`. `expectedCellCount` converts
    to `number` only after proving the result is a safe integer; otherwise it throws a typed
    range error carrying the exact decimal cardinality. `expectedCellSet` invokes the same exact
    preflight before its first allocation or loop and additionally refuses a package-exported
    implementation ceiling of **1,000,000 materialized cells**. The exact count helper remains
    usable above that materialization ceiling when its result is safe, so future quote/planning
    code can report size without allocating the set. A schema-valid
    `replicates = Number.MAX_SAFE_INTEGER` vector with at least three Cartesian positions must
    fail before rounded conversion or iteration, and a `1,000,001`-cell vector must return an
    exact count but refuse materialization. This operational ceiling does not make the sealed Run
    invalid; it is the explicit bound of this array-returning helper.
71. **Per-arm methods retain every Matrix arm even when it has zero decisive cells:**
    `wilson@1`, `avg-at-k@1`, and `pass-at-k@1` seed their result arm set from all arm identities
    present in the exact subject Matrix cells, in UTF-16 code-unit order, before verdict
    reduction. A fully attrited arm therefore remains explicit: Wilson reports its existing
    zero-scorable result (`n: 0`, zero estimate/interval), while avg/pass report an empty
    `perTask`, zero mean, and every subject Task digest in `missingTaskDigests`; pass-at-k records
    no invented incompatibility for a Task with no decisive observation. Conflicted and other
    exclusions retain their existing disclosures. A two-arm fixture with one fully
    expired/excluded arm pins the complete result for all three methods.
72. **Marketplace projection state is a persistent value owned by its caller:** every reducer
    transition clones every nested mutable structure it may change, including live Attempt
    occupancy, seen Attempt identities, and pending correspondence state. No accepted, refused,
    replayed, or reorg event may mutate the supplied prior state, and the returned state shares
    no mutable object with it. Byte snapshots before and after claim, release, expiry, top-up,
    refusal, and replay transitions prove both nonmutation and isolation.
73. **A revised Task's creation anchor survives every availability epoch:** the accepted
    revised-mode `TaskCreated` transition retains the exact creation `submissionDigest` and the
    creation derivation/log identity in Task state. Before any release-, expiry-, or
    `AttemptsAdded`-driven reopening can emit facts, write a record, sign, archive, or advance a
    head, the projector resolves the Submission once and requires
    `documentDigest(resolvedBytes)` to equal that retained digest. A mismatch returns typed
    `announcement-material-refused` detail naming role `submission`, expected and actual digest,
    the current reopening derivation, and the original anchor derivation, with zero downstream
    effects. Today mode never fabricates an unavailable anchor or a reopening path. A later
    signed availability announcement may have a new announcement id and entry sequence, but it
    retains the same record digest and facts identity.
74. **Signed Task admission is one executable native conformance boundary:** the marketplace
    testing package exports one reusable check that accepts exact DSSE-envelope bytes, the
    expected claimed requester/creator/key/time context, and the real resolver/policy
    dependencies. It parses the envelope, requires the exact Task media type, performs fatal
    UTF-8, JSON, schema, and I-JSON validation, re-seals the Task and requires byte equality, and
    then verifies the signature's actual PAE-bound bytes and requester authority with
    `verifyEnvelopeBinding`. It returns a closed typed result whose successful form includes the
    exact recovered Task bytes and document. Canonical success, trailing-whitespace or
    reordered payload, substituted payload, wrong media type, and unauthorized signer all run
    through this same function; comparing byte arrays outside the admission boundary or using a
    verifier double that ignores the received envelope is vacuous and nonconforming.
75. **Marketplace lifecycle refusals are executable conformance, not dormant branches:** the
    native kit pins exact-log replay as idempotent and pins distinct-log duplicate, reused or
    regressing Attempt identity, unknown-task claim/release/expiry, non-live release/expiry, and
    contradictory top-up to their exact typed refusal results. A refused event is not appended
    to the transition's accepted-event collection and causes no observation, announcement,
    record, signing, archive, or head effect; only the processed-log identity needed to make the
    same log replay idempotent may change. Capacity, Attempt identity, sequence, and other
    protocol state remain byte-identical. Each vector asserts the complete transition output,
    not merely the refusal name.
76. **Benchmark Task provenance is admitted only from one exact canonical Task boundary:** the
    records package owns and exports the resolver used by both `benchmark-judgeability` and the
    aggregate package. It verifies the expected digest, fatal UTF-8 and JSON, the exact
    `TaskSpecificationSchema`, canonical re-seal byte equality, the required evaluation
    descriptor digest, and calendar-strict provenance time before returning a tagged source
    family. Exactly one of the two provenance claim keys may be present as an own property:
    non-empty `source` or lowercase `sha256:<64 hex>` `sourceCommitment`. A present malformed
    second claim is not treated as absent; zero claims, two claims, an invalid present claim, a
    canonical non-Task object, and any unavailable, mismatched, or noncanonical Task all fail
    closed with the existing typed boundary outcome. Report methods never reimplement or weaken
    this admission.
77. **Benchmark completeness uses exact decimal arithmetic end to end:** the records package
    parses decimal strings into package-local coefficient-and-scale values using `BigInt`, never
    `Number`, and preserves the sealed spelling. Run and Matrix floors are in the exact interval
    `(0, 1]`; an arbitrarily small positive decimal remains positive, while any value
    mathematically above one is rejected even if IEEE-754 would round it to one. Matrix and
    aggregate completeness compare `judged / (expected - excluded) >= floor` by integer
    cross-products, and `clean-subset@1` consumes the same exact helper. Boundary vectors include
    a positive value below binary-number range and a value immediately above one.
78. **The noninferiority cost leg ranks exact same-unit decimal differences:** every included
    both-solve pair is converted to a scaled `BigInt` difference without binary floating-point
    conversion; absolute-difference ordering and ties for the one-sided paired Wilcoxon use
    exact values. All included pairs must share one cost unit across the complete comparison.
    A within-pair unit mismatch or a second included unit returns a typed method incompatibility,
    never an exclusion that silently enters a mixed-unit rank test. Vectors above `2^53`, with
    long fractional scales, prove the exact verdict, and a mixed-unit vector proves the closed
    outcome.
79. **Run-level Submission baseline keys and arm pinning keys are disjoint:** for every arm, the
    key intersection of `policy.submissionBaseline` and `arm.pinning` must be empty. Any
    intersection is a Run schema error at the exact arm/key path, regardless of whether the two
    values happen to be byte-equal. The full cell requirements remain the unambiguous union of
    those disjoint maps, and runtime plus exported-schema parity fixtures pin a conflicting
    `model` key.
80. **Report independence disclosure is derived under the exact Run policy:** disclosure
    production and verification resolve each Matrix's digest-bound canonical Run before
    counting. `independence` counts only cells whose outcome is `judged`, whose exact Run declares
    `policy.independence: "disclosed"`, and whose failed named checks include
    `evaluator-independence`. Non-judged cells never count; a gating Run cannot manufacture the
    disclosed-policy count. Missing, mismatched, malformed, or noncanonical Run bytes fail
    disclosure production and verification closed. Expired and gating-policy hostile vectors
    assert the complete disclosures.
81. **Checked-in Benchmark JSON Schemas are enforceable wire contracts, not loose Zod
    projections:** schema generation post-processes refinements that Draft 2020-12 can represent
    and its drift gate validates the generated schemas against the repository's valid/invalid
    wire fixtures. In particular, all four record schemas permit only known or namespaced
    top-level properties; Run and Matrix express the exact `(0,1]` floor grammar; calendar-time
    fields reject invalid civil dates while retaining the valid leap-second contract; and
    unnamespaced Matrix aggregates are rejected. Runtime-only cross-field checks that Draft
    2020-12 cannot express carry an explicit `$comment` naming the required runtime check rather
    than being implied by an unconstrained schema. The parity gate proves leap-second acceptance,
    invalid-date rejection, above-one floor rejection, tiny-positive floor acceptance, and the
    unnamespaced aggregate refusal with a Draft 2020-12 validator configured for asserted
    formats.
82. **`noninferiority-iut@1` has a versioned v1 resampling ceiling:** the aggregate package
    exports `MAX_NONINFERIORITY_RESAMPLES_V1 = 100_000`. The method parameter schema declares
    that maximum, every direct bootstrap helper rejects a non-integer, non-positive, or
    above-maximum value before allocation or iteration, and Report production/verification
    returns its typed parameter incompatibility before compute. The default remains 10,000 and
    xorshift/cluster draw semantics below the ceiling are unchanged. Maximum and maximum-plus-one
    vectors pin the resource contract.
83. **The paired-exclusion conformance case reaches the behavior it claims to test:** the
    `R = 1` pairing fixture contains judged pairs plus missing, conflicted, and one-sided cells,
    and asserts the exact full excluded remainder, cell-key ordering, and tagged clustering
    basis. The `R > 1` incompatibility remains a separate vector. No early incompatibility may
    satisfy the exclusion test, and every declared expected result in the fixture must be
    consumed by an assertion.
84. **A zero eligible-cell denominator never proves completeness:** when
    `expected - excluded == 0`, the completeness floor is not met and a non-cancelled Matrix must
    declare `runOutcome: "partial"`. An explicitly owner-cancelled run remains `cancelled`; a
    zero-denominator Matrix may never be `complete`. Records, aggregate helpers, minimal
    fixtures, Report disclosures, and exported schema examples use this conservative outcome and
    never substitute a synthetic ratio of one.

## 8. Follow-ups registry (recorded once; none block v1)

- IANA registration for the `vnd.jinn.task-execution.*`, `vnd.jinn.trust.*`,
  `vnd.jinn.record-discovery.*`, and `vnd.jinn.benchmarking.*` vendor trees (TEP §28; trust
  §20; discovery §22; benchmarking design — postdates the original list). Vendor-tree names
  used as-is until then.
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
- Plugin / checkpoint artifact record kinds have NO defining-bytes schema anywhere in the
  implemented task-execution tree (discovered at the facts leaf, 2026-07-28): the discovery
  §12 table names them and `RECORD_KINDS.plugin/checkpoint` are pinned, but the leaf
  registers them structurally with zero declared fields (honest, not fabricated). The
  defining schemas arrive with future plugin/checkpoint work; the leaf then gains their
  fields.
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

**Ledger update (2026-07-28, operator addendum at integration head `f5602b60b`/`1200b5842`):**
the marketplace binding and the benchmarking application are now DESIGNED
(`2026-07-28-marketplace-binding-design.md` — chain-venue TEP binding over the deployed
TaskCoordinator + JinnRouterV3 + Mech substrate, two-generation seam, projector #1, plus a
specified contract revision as declared impact; `2026-07-28-benchmarking-application-design.md`
v0.3 — four tier-2 record kinds + one tier-3 application). Their component plans are being
drafted under rule 5 discipline; the program extension (appended phases in dependency order:
benchmarking records + kit after TEP/profiles sealing → marketplace binding after TEP kit +
trust + discovery serve/client green → benchmarking run orchestration after the backend
contract is green → benchmarking marketplace mode last) is presented at the next phase
boundary; **code for the new components starts only on explicit operator approval.**
Companion amendments recorded 2026-07-28 as dated addenda: benchmarking facts-profile fields
(`benchrun`/`benchcell`/`bencharm`) on the record-discovery plan (M8 builds them in from day
one); the two-party engagement entry (caller-supplied deterministic Attempt URI, ruling §7.2
constants) on the local-execution-backend plan (Milestone C includes it from day one).
Absorbed: the #2038 issue tree was swept 2026-07-28 — #2040/#2041/#2043/#2045 closed as
re-homed (capabilities already in this program's work items), #2047–#2054 superseded by the
benchmarking design, #2044/PR #2219 continues on `next`. Closed issues are not scope; the
specs are.

Remaining pending design session (recorded, not planned, not implemented): the
migration-mechanics / operator-daemon-composition session — the daemon TaskEngine carve,
the daemon consumption swap, and operator-daemon composition wait on it. The discovery
query-plane service and subscribe relay remain out unless the marketplace-binding design
explicitly pulls them in (the plan draft reports either way). Also still out: tier-4
products (marketplace
benchmarking service, skill factory, leaderboards, plugin composition); any on-chain
deployment (the contract-revision code and its kit are marketplace-plan scope; deploys are a
human-gated runbook item, never program work);
**the first-adopter pass** (operator decision 2026-07-28: this program builds the full
foundation only; adoption/proving — backend design §18 step 4, §11.1 — is its own later
pass, and Autopilot now lives in a separate repository, so that pass consumes these packages
from npm rather than in-repo portals); all migration-mechanics specs for daemon/Autopilot
cutovers; trust §18 steps 3–8 host rollouts (bootstrap identity establishment, policy
documents replacing allowlists, DSSE convergence, full backend grant-resolution obligations,
verifier-policy integration).

## 10. Program extension (2026-07-28) — APPROVED by the operator (2026-07-28)

Per the operator addendum (integration head `1200b5842`), two reviewed component plans extend
the program: [2026-07-28-marketplace-binding.md](./2026-07-28-marketplace-binding.md) and
[2026-07-28-benchmarking-application.md](./2026-07-28-benchmarking-application.md) (both
fix-then-approve reviewed; all findings applied under rulings §7.19–§7.22). Appended phases,
in the operator's dependency order — **no extension code before explicit approval**:

- **Phase 5 — extension wave 1** (gates: TEP protocol + profiles + trust + discovery
  serve/client green — i.e. the Phase 3 boundary): benchmarking records + aggregate + kit
  (its plan M1–M3) ∥ marketplace binding M0–M5 (scaffold/seam, Attempt-URI agreement,
  posting + requester-facing backend + native §16.2 conformance, claim/deliver/settle,
  projector #1, evaluation legs).
- **Phase 6 — extension wave 2** (gates: Phase 4 backend-local assembly + the TEP engagement
  widening green): marketplace pipeline (M6, embedding the local backend per §7.18);
  benchmarking run orchestration (M4–M5, local mode per §7.22); the contract-revision code +
  Hardhat kit (M7; Hardhat-3 prerequisite checked; **deploys are human-gated runbook items,
  never program work**); benchmarking facts leaf (M6) into the discovery tree.
- **Phase 7 — extension wave 3**: benchmarking marketplace mode (its M7, sole
  marketplace-importing package) over the binding.
- **Phase 8 — close** (renumbers the original Phase 5): overall program review across the
  EXTENDED whole, full-program verification, single merge proposal to
  `integration/evidence-v1`.

Gate confirmations (operator, 2026-07-28): extension approved in full (all three waves);
`@jinn-network/marketplace-*` npm prefix confirmed; benchmarking protocol identifier is the
**https URL form** `https://jinn.network/protocols/benchmarking/1.0` (operator ruling — the
design's bare token `jinn.benchmarking/1.0` is superseded on this point; recorded as a dated
addendum on the benchmarking plan); record-kind URIs as pre-aligned.
