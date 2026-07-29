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
