# Local Execution Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** draft (pending program approval)

**Date:** 2026-07-28

**Implements:** `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` (the local execution backend, "the design" below). Consumes, without redefining: `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP), `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` (profiles), `docs/superpowers/specs/2026-07-26-evaluation-runner-design.md` §10/§11 (the surviving evaluator-adapter contract), and the merged evidence substrate on `integration/evidence-v1`.

**Depends on sibling 2026-07-28 plans** (must land before Milestone A begins — see Cross-plan dependencies):
- `docs/superpowers/plans/2026-07-28-task-execution-protocol.md` — provides `@jinn-network/task-execution-{protocol,backend,testing}`, the `packages/task-execution/` guard suite (`task-execution-*.test.mjs`), and `.github/workflows/task-execution-ci.yml`.
- `docs/superpowers/plans/2026-07-28-task-execution-profiles.md` — provides `@jinn-network/task-execution-profiles` (resolved profile documents carrying `requirementKeys` comparison classes as DATA, `evaluation-task/1.0` + `EvaluationSpec`, `repository-work/1.0`). The §5.1 comparison-class MERGE itself is protocol-owned (`mergeRequirements`, program §7.3), and workspace-kind selection is backend-local's own `ProvisionerContract.workspaceKind` — neither is a profiles export.

**Goal:** Build the reference binding of the Task Execution Protocol backend contract — a product-neutral supervisor/workspace/launchers/assembly stack that executes sealed Tasks on one machine under durable process custody with honest recovery — plus the residual evaluation harness. (Adoption by a first consumer is a separate pass — see Milestone E note.)

**Architecture:** One npm package `@jinn-network/task-execution-backend-local` with four guard-enforced sub-regions (`supervisor/`, `workspace/`, `launchers/`, `assembly/`) and subpath exports, following the evidence-discovery consolidation precedent (one package, one-way sub-region graph in the boundaries guard). A sibling package `@jinn-network/task-execution-evaluation-harness` runs evaluation-profile Tasks as ordinary Attempts, signing the Result Evaluation Statement with the already-implemented Attestation Issuer. The conformance kit is a `backend-local` slice of the existing `@jinn-network/task-execution-testing`, with a deterministic fake launcher as its backbone; it precedes the implementation. Evidence enters as contracts only (`EvidenceRepository`, `EvidenceCatalogReader`, the `execution-recorder` producer), with concrete bindings host-injected through an assembly-owned `awaitIndexed` port; the backend never imports `evidence-local-runtime` or discovery.

**Tech Stack:** TypeScript (NodeNext, strict), Node ≥22, Yarn 4.13.0 standalone projects with `portal:` resolutions, Vitest, `node:test` guard scripts. Sealing follows the stack discipline (I-JSON, JCS via the protocol package for TEP documents; per-package `order.ts` UTF-16 code-unit ordering for backend-internal canonical bytes). Process custody uses `setsid`/process groups, `(pid, start-time)` fingerprints, atomic outcome files (temp+fsync+rename+dir-fsync), and Linux cgroup binding where available.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design and the coordinator brief.

- **Package mechanics (evidence precedent).** Every new package is a STANDALONE yarn project: own `yarn.lock`, `"packageManager": "yarn@4.13.0"`, `"engines": {"node": ">=22"}`, `"type": "module"`, in-tree deps declared as normal `0.1.0` semver dependencies AND mirrored under `resolutions: { "<name>": "portal:<relative-path>" }`. No repo-root workspace. Match `packages/evidence/execution-recorder/package.json` field-for-field (scripts: `build`/`typecheck`/`test`/`pack:smoke`/`prepack`; `tsconfig.json` + `tsconfig.build.json`; `scripts/pack-smoke.mjs`).
- **Sealing / canonical bytes.** Sealing is re-implemented PER PACKAGE (never a shared runtime dep). Every package that produces sealed or canonical bytes MUST: copy `order.ts` verbatim (`compareCodeUnitStrings` — UTF-16 code-unit, never `localeCompare`), ship pinned-digest golden fixtures, include at least one object-key-sort-sensitive record in equivalence fixtures, and be covered by the tree's locale-ban guard. TEP sealed documents (Task/Submission/Delivery) are sealed via the protocol package's sealer; backend-internal canonical bytes (resolved LaunchPlan digest, sorted output manifests) use this package's own `order.ts` + canonical serializer.
- **Locale ban.** `localeCompare`, `toLocale*`, and `Intl` are banned in ALL production source under `packages/task-execution/` by the source-boundaries guard. Ordering that reaches canonical bytes or a reported ordering goes through `compareCodeUnitStrings`.
- **Kits precede implementations.** A conformance kit is green before dependents build on it. Within this plan the backend-local kit slice (fake launcher backbone) is Milestone A, before workspace/launchers/assembly.
- **Guard extension.** The `packages/task-execution/` guard suite (inventory + source-boundaries + packed-types + `task-execution-ci.yml`) is created by the TEP plan with the tree's first package. This plan EXTENDS it when registering each package: package counts are COMPUTED against the live guard file at land time (never hardcoded to a guessed total), sub-region wiring and subpath exports are added, packed-types entrypoints are added, and CI jobs are added. Guard edits land WITH the package task that needs them, not after.
- **Verification gate per unit.** Every task ends with: `yarn typecheck` (zero errors), `yarn test` (all pass), the relevant conformance kit run, and the tree guards (`node --test .github/scripts/task-execution-*.test.mjs`) — run locally, evidence-style, before the task is considered done.
- **capacity-exhausted is NOT added.** An up-but-full backend rides `backend-unavailable` with capacity detail (design §5/§20); do not add a dedicated TEP category. Recorded as a TEP follow-up in the program doc.
- **Reserved-URI pre-release checklist.** `https://jinn.network/task-profiles/evaluation-task/1.0` (and `repository-work/1.0`) are owned by the profiles plan and must resolve before EXTERNAL conformance claims. Internal work does not gate on publication; the program doc carries the pre-release checklist item.
- **Rule 3 (surgical).** Touch only what the task names. The one deliberate cross-plan write is the `backend-local` slice added to `@jinn-network/task-execution-testing` and the guard/CI extensions — both called out per task.

## Flag-gated decisions (confirm at the program gate)

These are the coordinator's flag-gated naming/placement calls this plan adopts; if the gate overturns one, the affected tasks change shape:

1. **backend-local = ONE package** `@jinn-network/task-execution-backend-local` with four guard-enforced sub-regions + subpath exports (`./supervisor ./workspace ./launchers`, root = assembly). Alternative was four packages per design §15's directory listing. This plan builds the one-package form.
2. **Evaluation harness** at `packages/task-execution/evaluation-harness` → `@jinn-network/task-execution-evaluation-harness`, sibling of backend-local. The design assigns no path (§10.4/§17).
3. **The testing `backend-local` slice depends on backend-local.** The fake launcher implements backend-local's launcher contract, and the fixtures drive backend-local's supervisor/workspace/assembly APIs, so the slice imports `@jinn-network/task-execution-backend-local`. This refines the brief's "testing → protocol + backend" line for the slice subpath (backend-local consumes `testing` as a devDependency only; no production cycle — mirrors the evidence tree's `local-runtime → execution-recorder` devDep). See Findings (a) + (c).
4. **Delivery sealing is owned by the protocol package** and consumed by the assembly (TEP sealed document, §13). backend-local re-implements only its own backend-internal canonical bytes. See Findings (b).

## Preflight

Before any task, assert the program base is an ancestor of the working head:

```bash
git merge-base --is-ancestor 3650ac65e HEAD && echo "preflight OK" || { echo "PREFLIGHT FAILED: rebase onto 3650ac65e"; exit 1; }
```

`3650ac65e` tracks `origin/integration/evidence-v1` and contains the evidence substrate (11 packages), the index-recorded head `f65880c4e`, and PR #2226 (UTF-16 code-unit ordering fix). All work targets `integration/evidence-v1`.

## Cross-plan dependencies (what must exist before Milestone A)

This plan is Phase 4 in the program DAG. It cannot start until:

- **`@jinn-network/task-execution-protocol`** exports the TEP contract surface (design §14): `TaskExecutionBackend`, `BackendCapabilities` (with the carried `runPinning` block, profiles amendment 1), `SubmissionUri`, `AttemptUri`, `DeliveryRef`, `ObservationSnapshot`, `ProtocolObservation`, `ObservationCursor`, `SubmissionAck`, `CancelAck`, `ReconciliationReport`, `PreflightRequest`, `PreflightReport`, `ResourceDescriptor` (Task.profile as ResourceDescriptor, amendment 2), the observation-type set (§10.2), derived Attempt states (§10.3), the error-category enum (§13: `invalid-document`, `unsupported-requirement`, `submission-conflict`, `backend-unavailable`, …), the TEP Delivery sealer / `recordDigest`, and — per program §7.3 (binding) — the §5.1 comparison-class merge as a pure protocol function `mergeRequirements(taskRequirements, submissionRequirements, keyClasses) → { ok: true, effective: EffectiveRequirements } | { ok: false, category: 'invalid-document', key }` plus the `EffectiveRequirements` and `ComparisonClass` types it produces/consumes. The merge is home to protocol, NOT profiles; it returns the effective merged map on success. `unsupported-requirement` is NEVER produced by this pure merge — it is raised by the backend capability check (C1) against `capabilities().runPinning` inventories.
- **`@jinn-network/task-execution-backend`** exports the `TaskExecutionError` class (error-category enum stays in protocol; the class wraps it — no duplicate enum).
- **`@jinn-network/task-execution-testing`** exists with the TEP core conformance kit (`describeTaskExecutionBackendContract` or equivalent), proven first against the TEP plan's in-memory fake backend.
- **`@jinn-network/task-execution-profiles`** exports `resolveProfile` + profile-document parsing (each resolved profile document carries its own `requirementKeys` — the per-key comparison classes `exact | ceiling | floor | constraint | addable`, supplied as DATA to protocol's `mergeRequirements`, not a merge evaluator), the `evaluation-task/1.0` derivation template (§9.1) + `EvaluationSpec` parsing, and the `repository-work/1.0` document. Profiles ships requirement-merge FIXTURES only; it exports no merge function (that is protocol's, above). Workspace-kind selection is NOT a profiles export — it is backend-local's own `ProvisionerContract.workspaceKind(view)` (§7.2), derived locally from the resolved profile document.
- **The `packages/task-execution/` guard suite + `task-execution-ci.yml`** exist (created by the TEP plan).
- **The evidence substrate** (implemented): `@jinn-network/evidence-repository` (`EvidenceRepository`), `@jinn-network/evidence-discovery` (`EvidenceCatalogReader`), `@jinn-network/execution-recorder` (`createExecutionRecorder({repository})` → `ExecutionRecorder{start,resume}` → `ExecutionRecording{captureInput,captureRuntimeObservation,attachNativeTrace,finalize}`), `@jinn-network/attestation-issuer` (`prepareResultEvaluation(input, signer: DsseSigner, opts)`), `@jinn-network/evidence-local-runtime` (`openLocalEvidenceRuntime()` → `{repository, catalog, awaitIndexed, …}` — consumed by the HOST wiring only, never imported by backend-local).

If a consumed symbol is renamed by a sibling plan at implementation, update the Consumes block of the affected task and re-run the guard.

## Package and file structure

```text
packages/task-execution/
  backend-local/                          @jinn-network/task-execution-backend-local
    package.json  tsconfig.json  tsconfig.build.json  yarn.lock  README.md
    scripts/pack-smoke.mjs
    fixtures/                             pinned-digest goldens (LaunchPlan digest, sealed Delivery, journal→observation)
    src/
      order.ts                           compareCodeUnitStrings (copied verbatim)  [root shared util]
      canonical-json.ts                  deterministic serializer for backend-internal canonical bytes  [root shared util]
      task-view.ts                       TaskView type (parsed Task ⊎ effective merged reqs ⊎ resolved profile)  [root shared util]
      index.ts                           root export = assembly public API
      supervisor/
        index.ts                         public surface (subpath ./supervisor)
        shim.ts  shim-script.ts          the attempt shim (self-contained Node script) §6.1
        journal.ts  journal-types.ts     append-only WAL-intent journal §6.2
        attempt-record.ts                durable per-attempt document §6.3
        reconciler.ts                    recovery classifier / §6.4 table
        cancellation.ts                  kill ladder §6.5
        deadline.ts                      deadline + heartbeat §6.6
      workspace/
        index.ts                         public surface (subpath ./workspace)
        contract.ts                      ProvisionerContract + directory contract types §7.1
        dir-provisioner.ts               plain-dir workspace kind §7.2
        worktree-provisioner.ts          detached git worktree at OID §7.2
        materialize.ts                   input materialization §7.3
        harvest.ts                       output collection §7.4
        grants.ts                        minimal local capabilityGrant → secrets/ resolution §7.2
      launchers/
        index.ts                         public surface (subpath ./launchers)
        contract.ts                      LauncherContract + LaunchPlan + capability declaration §8.1  [lands in Milestone A]
        result.ts                        result-envelope interpretation §8.2
        claude-code.ts  codex.ts  hermes.ts  cursor.ts   the four v1 launchers §8.3
      assembly/
        index.ts                         makeLocalTaskExecutionBackend + config types
        backend.ts                       TaskExecutionBackend verbs §9.1
        capacity.ts                      capacity gate + meta/backend.lock §5
        observation.ts                   observation projection §9.2
        capabilities.ts                  assembled capabilities() §9.3
        evidence-join.ts                 recorder join + EvidenceBindingPorts / awaitIndexed port §10.1
  evaluation-harness/                     @jinn-network/task-execution-evaluation-harness
    package.json  tsconfig.json  tsconfig.build.json  yarn.lock  README.md
    scripts/pack-smoke.mjs
    fixtures/
    src/
      index.ts                           evaluator-adapter contract + EvaluatorRegistration §10/§11
      adapter.ts                         evaluate(...) → CompletedEvaluation contract §11
      registration.ts                    EvaluatorRegistration + interruptionBehavior §10.3
      runtime.ts                         the harness executable body §10.4
      bin.ts                             the spawned harness entrypoint
      launcher.ts                        a LauncherContract impl planning the harness (subpath ./launcher)
      sign.ts                            attestation-issuer composition + secrets/ signer forward §10.4

packages/task-execution/testing/          @jinn-network/task-execution-testing  (TEP plan owns; THIS plan adds:)
    src/backend-local/                    the backend-local kit slice §16
      index.ts                           subpath ./backend-local
      fake-launcher.ts                   deterministic fake launcher (SimpleRunner reborn) §16
      supervisor-contract.ts             describeAttemptSupervisorContract(...)
      launcher-contract.ts               describeLauncherContract(...)
      workspace-contract.ts              describeWorkspaceContract(...)
      backend-contract.ts                describeLocalBackendContract(...) (runs the TEP core kit + local specifics)
    fixtures/backend-local/               golden journals, reconciliation-table rows, shim/workspace scenarios

.github/scripts/                          (TEP plan owns; THIS plan extends the constants:)
  task-execution-package-inventory.test.mjs
  task-execution-source-boundaries.test.mjs
  task-execution-packed-types.test.mjs
.github/workflows/task-execution-ci.yml   (TEP plan owns; THIS plan adds jobs)

packages/evidence/protocol/               (evidence substrate; THIS plan amends — F7:)
  profiles/execution-evidence/1.0/specification.md   normative Task/Execution identifier-PropertyValue text
  src/identifiers.ts                       TEP scheme propertyID IRI constants
  fixtures/                                one identifier-PropertyValue fixture

docs/superpowers/                          (doc-vs-doc reconciliation:)
  plans/2026-07-27-evaluation-runner.md               supersession banner
  specs/2026-07-26-evaluation-runner-design.md        status-header amendment
  specs/2026-07-27-evidence-application-layer-index.md index entry reconciliation
```

## Out of scope

Named here so no task drifts into them (design §15/§17/§18/§19, brief):

- **§18 step 5 — daemon execute-step adoption / the `TaskEngine` venue-execution carve.** Deferred; lands with the (unwritten) marketplace-binding design. This plan freezes only the boundary (design §11.2).
- **Marketplace binding**: chain/mech translation, IPFS envelope, on-chain verdict projection, settlement — none of it here (design §11.2/§16.2).
- **Container/VM isolation launcher classes** (the `isolation[]` capability made real) — the contract leaves room; no impl (design §19/§20).
- **Windows process custody** (job objects) and a compiled shim variant — v1 targets Linux (cgroup) + macOS with named residuals (design §20).
- **Transcript secret-scrubbing** — an honest residual; application/evidence-side, not a backend guarantee (design §12/§20).
- **Evaluator economics, challenge policy, evaluator identity verification, aggregation, corpus policy** — profiles/trust/knowledge layers (design §19; profiles §16).
- **Autopilot migration mechanics beyond §11.1's impact list** — the session CLI stays; attempt-workspace/coordinator-session/cleanup machinery is superseded structurally, but the full dispatcher rewrite is separate spec work (design §17).
- **Heartbeat-driven kill-on-stale policy** — v1 heartbeat staleness is observational only (design §6.6/§20).
- **Concrete evaluator adapters** (deterministic/model/human) — the harness ships the contract + runtime + one fake/fixture adapter for conformance; real adapters are their owners' (evaluation-runner design §27).

---

# Milestone A — supervisor + conformance kit (design §18 step 1)

Delivers, in kit-precedes-implementation order (design §16, coordinator brief "Kit slice FIRST"): the package skeleton and guard registration (A1); the three sub-region *contract* type modules (A2, so the kit is generic and the fake launcher can implement the launcher contract); the backend-local conformance kit slice (A3 — fake launcher backbone + the full §16 fixture families + the contract describe-functions, authored against the A2 contract types BEFORE any supervisor implementation exists); THEN the Attempt Supervisor built to satisfy that kit — the attempt shim (A4) and the journal/attempt-record/reconciler/cancellation/deadline internals (A5), with A5 assembling the full supervisor and running the kit's `describeAttemptSupervisorContract` red→green (the shim, journal, reconciler, cancellation, and deadline fixture families all authored in A3). Frozen interfaces exercised: §14 items 1–6.

## Task A1: Package skeleton + guard registration + shared sealing utilities

**Files:**
- Create: `packages/task-execution/backend-local/package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `scripts/pack-smoke.mjs`
- Create: `packages/task-execution/backend-local/src/order.ts`, `src/canonical-json.ts`, `src/index.ts` (temporary re-export stub)
- Modify: `.github/scripts/task-execution-package-inventory.test.mjs` (add the package + its dependency-graph entry + portal resolutions; recompute the count)
- Modify: `.github/scripts/task-execution-source-boundaries.test.mjs` (add `backend-local` to the tree directory list; stub sub-region wiring filled in A2/B/C)
- Modify: `.github/scripts/task-execution-packed-types.test.mjs` (add `@jinn-network/task-execution-backend-local` + `./supervisor ./workspace ./launchers` entrypoints)
- Modify: `.github/workflows/task-execution-ci.yml` (add a `backend-local` job downstream of protocol/backend/profiles/testing)
- Test: `packages/task-execution/backend-local/src/canonical-json.test.ts`, `src/order.test.ts`

**Interfaces:**
- Consumes: nothing yet (skeleton). Reads the live guard constants to compute the new package count.
- Produces: `compareCodeUnitStrings(left, right): -1|0|1` (verbatim copy of `packages/evidence/execution-recorder/src/order.ts`); `serializeCanonical(value: unknown): string` (JCS-style deterministic JSON using `compareCodeUnitStrings` for object-key order); the package name `@jinn-network/task-execution-backend-local`.

- [ ] **Step 1: Write the failing `order.ts` + `canonical-json.ts` tests**

```ts
// src/order.test.ts
import { describe, it, expect } from "vitest";
import { compareCodeUnitStrings } from "./order.js";
describe("compareCodeUnitStrings", () => {
  it("orders by UTF-16 code unit, not host collation", () => {
    // 'Z' (0x5A) precedes 'a' (0x61) under code units; a locale collator would flip this.
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
  });
});
```

```ts
// src/canonical-json.test.ts
import { describe, it, expect } from "vitest";
import { serializeCanonical } from "./canonical-json.js";
describe("serializeCanonical", () => {
  it("sorts object keys by code unit regardless of insertion order", () => {
    expect(serializeCanonical({ b: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"b":1}');
  });
  it("is byte-identical across two structurally equal objects", () => {
    expect(serializeCanonical({ a: [3, 2], c: 1 })).toBe(serializeCanonical({ c: 1, a: [3, 2] }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail** — `cd packages/task-execution/backend-local && yarn test` → FAIL (module not found).
- [ ] **Step 3: Create the standalone-project scaffolding.** Copy `packages/evidence/execution-recorder/{package.json,tsconfig.json,tsconfig.build.json,scripts/pack-smoke.mjs}` and rewrite: name `@jinn-network/task-execution-backend-local`; `repository.directory` `packages/task-execution/backend-local`; `exports` map with `.` → `./dist/index.js`, `./supervisor`, `./workspace`, `./launchers` (each → `./dist/<region>/index.js` + types); `dependencies` = `@jinn-network/task-execution-protocol`, `@jinn-network/task-execution-backend`, `@jinn-network/task-execution-profiles`, `@jinn-network/evidence-repository`, `@jinn-network/evidence-discovery`, `@jinn-network/execution-recorder` (all `0.1.0`); `devDependencies` add `@jinn-network/task-execution-testing`; `resolutions` mirroring all of them as `portal:` relative paths; keep `tsconfig` NodeNext-compatible (match evidence: `moduleResolution: Bundler` for local build, but the packed-types guard compiles under NodeNext strict — verify the public entrypoints are NodeNext-clean). Rewrite `scripts/pack-smoke.mjs` to pack this package + its portal deps into a synthetic consumer.
- [ ] **Step 4: Copy `order.ts` verbatim** from `packages/evidence/execution-recorder/src/order.ts` (comment block included — it documents the locale ban). Implement `canonical-json.ts` using `compareCodeUnitStrings` for key order (no `localeCompare`). `src/index.ts` re-exports nothing yet (stub `export {};`).
- [ ] **Step 5: Extend the three guards + CI.** In the inventory guard: append `['backend-local', '@jinn-network/task-execution-backend-local']` to the tree package list, add its `JINN_DEPENDENCY_GRAPH` entry (dependencies = the six jinn deps above; devDependencies = `['@jinn-network/task-execution-testing']`), and change the count assertion to the guard's current total + 1 (read the file; do not hardcode a guessed number). In the boundaries guard: add `'backend-local'` to the tree directory array. In packed-types: add the four entrypoints. In `task-execution-ci.yml`: add a `backend-local` job (needs: [protocol, backend, profiles, testing]) running `yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke`, and add it to the final `verify` gate list.
- [ ] **Step 6: Verify** — `yarn typecheck && yarn test` (green) and `node --test .github/scripts/task-execution-package-inventory.test.mjs .github/scripts/task-execution-source-boundaries.test.mjs` (green). Locale-ban guard passes (order.ts is the only comparator).
- [ ] **Step 7: Commit** — `git add packages/task-execution/backend-local .github/scripts/task-execution-*.test.mjs .github/workflows/task-execution-ci.yml && git commit -m "feat(backend-local): package skeleton, sealing utils, guard registration"`

## Task A2: Launcher / provisioner / supervisor contract type modules

Establish the sub-region CONTRACTS (pure types + interfaces, no implementations) so the kit is generic over them and the fake launcher (A3) can implement the launcher contract before the concrete launchers (Milestone B). This satisfies design §18 ("supervisor + conformance kit" precedes launchers) and tenet 5 ("product-neutral components with their own contracts").

**Files:**
- Create: `src/task-view.ts`, `src/launchers/contract.ts`, `src/launchers/index.ts`, `src/workspace/contract.ts`, `src/workspace/index.ts`, `src/supervisor/index.ts` (surface stub)
- Modify: `.github/scripts/task-execution-source-boundaries.test.mjs` (declare the one-way sub-region graph and subpath exports)
- Test: `src/launchers/contract.test.ts` (type-shape assertions via a conforming stub)

**Interfaces:**
- Consumes: `Task`, `Submission`, `ResourceDescriptor`, `AttemptUri`, `EffectiveRequirements`, `ComparisonClass` (protocol — the merge and its result/class types are protocol-owned per program §7.3); `ResolvedProfileDocument` + its `requirementKeys` (profiles).
- Produces (frozen at design §14.7/§14.8 granularity):
  - `TaskView = { task: ParsedTask; effectiveRequirements: EffectiveRequirements; profile: ResolvedProfileDocument }` — the launcher's only input alongside workspace paths and attempt identity; the launcher never re-reads raw sealed bytes (§8.1). `effectiveRequirements` is the protocol-exported `EffectiveRequirements` map; its VALUE is produced by the assembly running protocol's `mergeRequirements(Task ⊎ Submission, keyClasses)` at submit (C1) and folding the returned `effective` map into the view — A2 only defines the type reference (imported from protocol), never re-declares it. `profile.workspaceKind` is not a field; workspace kind is derived by `ProvisionerContract.workspaceKind(view)` (below) from `profile`.
  - `LaunchPlan = { argv: string[]; env: Record<string,string>; cwd: string; validExitCodes: number[]; blameExitCodes?: BlameRule[]; resultContract: ResultContract; interruptionBehavior: "repeatable"|"recoverable"|"nonrepeatable" }`. `env` carries secret forwards as REFERENCES into `secrets/` (handles), never resolved values (§8.1). `BlameRule = { match: { exitCode?: number; signal?: string }; blame: "task"|"infrastructure"; reasonCode: string }` (ordered first-match).
  - `LauncherContract = { id: string; capabilities(): LauncherCapabilities; probe?(): Promise<ProbeResult>; plan(view: TaskView, paths: WorkspacePaths, attempt: AttemptIdentity): LaunchPlan }` — a pure function; never spawns, retries, holds state, or touches secrets beyond declared forwards (§8.4).
  - `LauncherCapabilities` (static two-channel declaration §8.1): `{ taskProfiles: string[]; inputMediaTypes: string[]; outputMediaTypes: string[]; structuredOutput: boolean; resume: boolean; interruptionBehaviorDefault: ...; runPinning: RunPinningSupport }`.
  - `WorkspacePaths = { root; input; work; out; logs; harnessState; secrets; tmp; meta }` and `ProvisionerContract = { workspaceKind(view: TaskView): WorkspaceKind; setup(view, paths, grants): Promise<void>; executionEnv(plan: LaunchPlan): Record<string,string>; harvest(paths, declaredOutputs): Promise<HarvestResult> }` (§7).
  - `AttemptIdentity = { attemptUri: AttemptUri; nonce: string; attemptNumber: number }`.

- [ ] **Step 1: Write a failing conformance-shape test.** A stub launcher implementing `LauncherContract` that returns a fixed `LaunchPlan`; assert `plan(...)` is a pure function (same inputs → deep-equal plan) and that `env` values matching `secrets/` handles are references, not resolved values.
- [ ] **Step 2: Run it → FAIL** (types absent).
- [ ] **Step 3: Author the type modules.** Define `TaskView`, `LaunchPlan`, `LauncherContract`, `LauncherCapabilities`, `WorkspacePaths`, `ProvisionerContract`, `WorkspaceKind`, `AttemptIdentity`, `BlameRule`, `ResultContract`. `EffectiveRequirements` and `ComparisonClass` are IMPORTED from `@jinn-network/task-execution-protocol` and referenced by `TaskView` — never redefined locally (program §7.3). `src/launchers/index.ts` and `src/workspace/index.ts` re-export the contract types (no implementations yet). Cite §14.7 (workspace contract) and §14.8 (TaskView/LaunchPlan) in doc comments.
- [ ] **Step 4: Wire the sub-region boundary graph** in the source-boundaries guard, mirroring the evidence-discovery `catalog/indexer/journal` one-way test. Assertions: `supervisor` may import only the root shared utils (`../order`, `../canonical-json`, `../task-view`) + `@jinn-network/task-execution-{protocol,backend}`; it may NOT import `../workspace`, `../launchers`, `../assembly`, `@jinn-network/task-execution-profiles`, any `@jinn-network/evidence-*`, `@jinn-network/execution-recorder`, `node:child_process`, or any git module. `workspace` may import root utils + protocol + profiles + git; not supervisor/launchers/assembly/evidence. `launchers` may import root utils + protocol + profiles; not supervisor/workspace/assembly/evidence/`node:child_process`. `assembly` may import all three sub-regions + protocol/backend/profiles/evidence-repository/evidence-discovery/execution-recorder; NOT `@jinn-network/evidence-local-runtime`, NOT any `record-discovery-*`, NOT any application tree. Assert `Object.keys(manifest('backend-local').exports).sort()` deep-equals `['.', './launchers', './supervisor', './workspace']`.
- [ ] **Step 5: Verify** — `yarn typecheck && yarn test`; guards green.
- [ ] **Step 6: Commit** — `feat(backend-local): sub-region contracts + one-way boundary graph`.

## Task A3: Backend-local conformance kit slice (fake launcher backbone) — design §16

The kit precedes the implementation. This task authors the fake launcher + the full §16 fixture families + the contract describe-functions against the A2 contract TYPES, BEFORE the shim (A4) and the journal/reconciler/cancellation/deadline internals (A5) are written — satisfying design §16 ("the kit precedes the implementation") and the coordinator brief's "Kit slice FIRST". It lives as the `backend-local` slice of the existing `@jinn-network/task-execution-testing`. This task WRITES INTO a package the TEP plan owns (see Findings (c) — an append-only cross-plan write). The supervisor is provable against these fixtures the moment it lands: A4 lands the shim (its atomicity/fingerprint/signal-survival tests mirror the kit's shim-contract fixture family), and A5 assembles the full supervisor and runs the kit's `describeAttemptSupervisorContract` over it — turning the whole supervisor conformance (shim, journal, reconciler, cancellation, deadline fixture families) green via the `reconciler.conformance.test.ts` that instantiates the real supervisor, authored in A5 where the supervisor surface first exists. The launcher/workspace/backend-level describe-functions are stubbed here against the contracts (A2) and exercised fully in Milestones B/C.

**Files (in the TEP-owned testing package):**
- Create: `packages/task-execution/testing/src/backend-local/index.ts` (subpath surface), `fake-launcher.ts`, `supervisor-contract.ts`, `launcher-contract.ts`, `workspace-contract.ts`, `backend-contract.ts`
- Create: `packages/task-execution/testing/fixtures/backend-local/` — the golden fixtures (below)
- Modify: `packages/task-execution/testing/package.json` (add `./backend-local` export; add `@jinn-network/task-execution-backend-local` as a dependency + portal resolution — the slice imports its contracts and drives its APIs)
- Modify: `.github/scripts/task-execution-*.test.mjs` (register the testing package's new `./backend-local` subpath in packed-types + inventory dependency-graph edge testing→backend-local; add the slice to the boundaries graph as a region above backend-local)
- Test: the kit ships its own self-tests in the testing package (fixtures parse; the fake launcher satisfies `describeLauncherContract`). The backend-local-side supervisor conformance test (`reconciler.conformance.test.ts`) that drives the REAL supervisor is authored in A5, where the supervisor surface first exists.

**Interfaces:**
- Consumes: `LauncherContract`, `LaunchPlan`, `ProvisionerContract`, the supervisor surface STUB, `TaskView` (backend-local A2 — the contract types plus the A2 `src/supervisor/index.ts` surface stub; the real supervisor internals land in A4/A5); the TEP core kit (`describeTaskExecutionBackendContract`) from the testing package root; `TaskExecutionBackend` (protocol).
- Produces:
  - `makeFakeLauncher(script: FakeLaunchScript): LauncherContract` — a contract-conforming launcher whose plans script exit codes, envelopes, output writes, and timing per fixture (SimpleRunner's role reborn as a contract fixture, §16). `FakeLaunchScript = { plan: LaunchPlan; onRun: (paths) => { writeOutputs?; stdout?; envelope?; exitCode; termSignal?; delayMs? } }`.
  - `describeAttemptSupervisorContract(makeSupervisor)`, `describeLauncherContract(launcher)`, `describeWorkspaceContract(makeProvisioner)`, `describeLocalBackendContract(makeBackend)` — vitest describe-functions generic over the contracts. Each takes its subject as a FACTORY parameter, so the kit compiles against the A2 contract types with no supervisor/workspace/backend implementation in existence yet.
  - The `@jinn-network/task-execution-testing/backend-local` subpath.

- [ ] **Step 1: Author the fixtures (§16, full list).**
  - **Golden journals**: valid; torn-tail; contradictory terminals; duplicate nonces; dangling intents; `seq` resumption after a torn tail; rebuild re-emitting identical `(source,id)` observation pairs; the submission-scoped segment surviving restart (a rejected Submission stays rejected).
  - **The reconciliation table as fixtures**: every §6.4 row with scripted process reality — engaged-no-intent → `rejected`; orphaned-under-dead-shim → kill ladder + `lost`; harvesting-resume re-collecting outputs a partial harvest missed; recording-resume from the checkpoint; nonce-mismatched outcome ignored; `lost`-correction without a `contradictory` flag; matching / matching-late / contradictory / terminal-with-survivors.
  - **Shim contract**: outcome-file atomicity (kill -9 between temp and rename); fingerprint vs PID reuse; group-kill with zombie-pinning; subreaper adoption; signal-survival (shim ignores the cancel TERM and still records a raced-ahead success); env-tag present from fork (pre-exec window probe).
  - **Launcher contract**: plan determinism (byte-identical plan from identical inputs — the reference-only secret env makes this possible); hermeticity (a plan varying with ambient env fails); statelessness; result interpretation (success-envelope + out-of-range exit → `failed`; limit-exhaustion → `partial` + `resume-with-session`; within-range exit with no envelope → `fulfilled`; structured output alongside the envelope).
  - **Workspace**: per-directory retention; `secrets/` + `tmp/` wiped at terminal; `input/` immutability-violation detection; `rejected` never-executed guarantee; symlink-in-`out/` escaping the tree → rejected + integrity violation; per-attempt quota breach; spawn-time env discipline (no secret-shaped ambient keys; no setup-phase credentials in the harness env); and a journal/attempt-record grep proving no `secrets/` byte-content ever lands in `meta/`.
  - **Backend-level**: the TEP conformance kit run against this binding; two-instances-one-root → second fails `backend-unavailable`; `attempts` outside `1..1` → `unsupported-requirement`.
  - **Cancellation races**: cancel-vs-finish (recorded outcome stands); cancel-on-terminal idempotency; harvest-after-cancel and harvest-after-expiry; un-killable group member → bounded poll → terminal with residual-PIDs annotation; cancel during provisioning → `rejected`.
  - **Evidence join**: capture `always` failure → `failed[infrastructure]`; receipt fields present in the Delivery; dispatch-context artifact present in the recorder's captured inputs; seal-once checkpoint reuse across a scripted crash, incl. the torn-checkpoint re-read variant.
  - Pin the fixtures whose bytes are digest-stable (journal→observation projections, sealed-Delivery goldens) with sha256 in an `expected-digests.json`, including at least one object-key-sort-sensitive record (a journal event or LaunchPlan whose keys are out of source order sealing to the pinned digest) — the cross-package equivalence leg.
- [ ] **Step 2: Implement `makeFakeLauncher` + the describe-functions** generic over the A2 contracts (`makeSupervisor`/`makeProvisioner`/`makeBackend`/`launcher` are factory parameters — the kit compiles against the contract types with no supervisor/workspace/backend implementation in existence yet). `describeAttemptSupervisorContract` encodes the shim/journal/reconciler fixtures as assertions over the supervisor surface types; `describeLauncherContract`/`describeWorkspaceContract`/`describeLocalBackendContract` land as skeletons asserting the fixtures parse + the fake launcher conforms. All four gain teeth as their subjects land: A4/A5 for the supervisor, B/C for launchers/workspace/backend.
- [ ] **Step 3: Run the kit's own self-tests** (in the testing package) → the fixtures parse and `makeFakeLauncher` satisfies `describeLauncherContract`'s determinism/hermeticity/statelessness assertions → PASS. The supervisor-driving conformance is NOT run here (no supervisor exists yet); it is authored + turned green in A5.
- [ ] **Step 4: Extend the guards** for the testing→backend-local edge and the new subpath (register `@jinn-network/task-execution-backend-local` in the testing package's inventory dependency-graph entry; add `@jinn-network/task-execution-testing/backend-local` to packed-types; place the slice above backend-local in the one-way boundary graph). Confirm no PRODUCTION cycle (backend-local's dependency on testing is devDependencies-only; the slice's dependency on backend-local is production — see Findings (a)).
- [ ] **Step 5: Verify** — testing package `yarn typecheck && yarn test` (the kit compiles against the A2 contracts; fixtures parse; the fake launcher conforms); guards green.
- [ ] **Step 6: Commit** — `feat(testing): backend-local conformance kit slice + fake launcher backbone (kit precedes the supervisor)`.

## Task A4: The attempt shim (§6.1)

The only new process the design introduces. A self-contained Node script, env-tagged from fork, signal-surviving sole outcome recorder. Frozen interface §14.2.

**Files:**
- Create: `src/supervisor/shim.ts` (spawn-side helper: builds the shim argv/env, `JINN_ATTEMPT_*` tagging), `src/supervisor/shim-script.ts` (the self-contained script body executed as the shim process)
- Test: `src/supervisor/shim.test.ts` (unit: env-tag, fingerprint, atomic outcome write), `src/supervisor/shim.integration.test.ts` (spawns the real shim script under `node`)

**Interfaces:**
- Consumes: `AttemptIdentity`, `WorkspacePaths`, `LaunchPlan` (A2).
- Produces:
  - `writeShimFingerprint(metaDir, { pid, startTime, nonce })` → atomic `meta/shim.json`.
  - `readOutcome(metaDir): OutcomeFile | null` where `OutcomeFile = { attemptId, nonce, exitCode, termSignal, startedAt, finishedAt }` (§6.1 step 6).
  - The shim behavioral contract (documented + tested): (1) `setsid` session/pgroup leader; on Linux `PR_SET_CHILD_SUBREAPER` + delegated cgroup where available; (2) traps SIGTERM/SIGINT/SIGHUP and IGNORES them (survives to record the outcome; relays cancellation to the harness subtree, never itself); (3) writes `(pid, start-time)` fingerprint + nonce to `meta/shim.json` before exec; (4) execs the harness with the same attempt identity, resolving `secrets/` forwards AT EXEC and never writing them to `meta/`; (5) touches `meta/heartbeat` with a monotonic timestamp; (6) on harness exit writes `meta/outcome.json` via temp+fsync+rename+dir-fsync (failed fsync is poison), then reaps stragglers, zombie-pinned group-kill (does not reap the leader until after the group signal so the PGID cannot recycle under the kill), and exits.

- [ ] **Step 1: Write the failing atomicity + fingerprint tests.**

```ts
// src/supervisor/shim.test.ts (excerpt)
it("writes outcome.json atomically: a crash between temp and rename leaves no partial file", async () => {
  // inject a rename that throws after the temp file is fsynced; assert meta/outcome.json is absent, temp is cleaned or ignored, and readOutcome() returns null (never a partial parse)
});
it("fingerprint binds (pid, start-time); a recycled PID with a different start-time reads as not-alive", () => {
  const fp = { pid: 4242, startTime: 111, nonce: "n1" };
  expect(fingerprintAlive(fp, { pid: 4242, startTime: 999 })).toBe(false);
});
it("readOutcome rejects an outcome whose nonce mismatches the attempt", () => { /* returns null */ });
```

```ts
// src/supervisor/shim.integration.test.ts (excerpt)
it("survives SIGTERM aimed at the group and still records a raced-ahead exit 0", async () => {
  // spawn the shim script running a child that exits 0 immediately; send SIGTERM to the pgroup;
  // assert meta/outcome.json records exitCode 0 (the natural exit that raced the kill), termSignal null
});
it("carries JINN_ATTEMPT_* from fork, present in the pre-exec window", async () => {
  // the child prints its env; assert JINN_ATTEMPT_ID/NONCE are set before the harness exec
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `shim.ts`** (fingerprint read/write, `fingerprintAlive`, atomic `readOutcome`, `buildShimSpawn(...)` producing argv/env with `JINN_ATTEMPT_*` set on the shim itself) and `shim-script.ts` (the process body: `setsid`, signal traps that ignore, fingerprint write, secret resolution at exec, heartbeat loop, `waitpid`, atomic outcome write, zombie-pinned group-kill). Use `node:child_process` + `node:fs` (`fsyncSync`, `renameSync`, dir fsync). Linux cgroup + subreaper behind capability probes; on macOS/cgroup-less, named-residual path (§12) — group-kill still runs, escape is detectable-not-always-killable.
- [ ] **Step 4: Run → PASS** (these atomicity/fingerprint/signal-survival tests are the shim-contract behaviors the A3 kit encodes as its shim-contract fixture family; the kit's `describeAttemptSupervisorContract` exercises them against the whole supervisor once A5 assembles it).
- [ ] **Step 5: Verify** — typecheck + guards (supervisor imports only root utils + protocol/backend + `node:` builtins; the guard must permit `node:child_process`/`node:fs` for the supervisor while still forbidding cross-sub-region + evidence + profiles; refine the guard's supervisor allowlist to node builtins).
- [ ] **Step 6: Commit** — `feat(backend-local): attempt shim with atomic outcome custody`.

## Task A5: The journal, attempt record, reconciler, cancellation, deadline (§6.2–§6.6)

The remaining supervisor internals — the task that assembles the full supervisor and turns the A3 kit's supervisor conformance green. Frozen interfaces §14.3–§14.6.

**Files:**
- Create: `src/supervisor/journal-types.ts`, `src/supervisor/journal.ts`, `src/supervisor/attempt-record.ts`, `src/supervisor/reconciler.ts`, `src/supervisor/cancellation.ts`, `src/supervisor/deadline.ts`
- Modify: `src/supervisor/index.ts` (export the supervisor surface: `openAttemptJournal`, `foldAttemptRecord`, `reconcileAttempt`, `runCancellationLadder`, `armDeadline`, and the event/record types)
- Test: one `*.test.ts` per file + `src/supervisor/reconciler.test.ts` driven by the §6.4 table fixtures (built in A3, the kit slice) + `src/supervisor/reconciler.conformance.test.ts` = `describeAttemptSupervisorContract(makeRealSupervisor)` driving the real supervisor over every §6.4 row (the supervisor conformance goes green here — this test is authored now, where the supervisor surface first exists)

**Interfaces:**
- Consumes: shim primitives (A4), `order`/`canonical-json` (A1), the A3 kit slice (`describeAttemptSupervisorContract` + the §16 supervisor fixture families), protocol observation/state/error types.
- Produces:
  - `JournalEvent = { attemptId; seq; type; time; displayMessage?; details: Record<string,unknown>; failsAttempt?: boolean }` (§6.2); `seq` is a durable per-attempt monotonic counter derived from `max(seq)+1` over intact records after a torn tail — never an in-memory counter.
  - `openAttemptJournal(metaDir)` → `{ append(intent), fsyncedAppend, read(): JournalEvent[], durableSeq() }` with: intent-before-action (`spawn-intended` carrying the serialized `LaunchPlan` is appended AND fsynced before fork/exec; `spawned` with the shim fingerprint after); **a journal event's fsynced append strictly precedes emission of its projected observation**; per-nonce terminal uniqueness enforced at append (a second terminal for one nonce is rejected + flagged, with the sanctioned `lost`-correction exception); a submission-scoped log segment keyed by Submission URI holding `submission-accepted|-rejected|-closed`.
  - `foldAttemptRecord(events, harvest?)` → the durable per-attempt document with the §6.3 field set: identity/lineage (attempt URI, nonce, task digest, submission URI, attempt number, `supersededBy`/`priorAttempt`), phase timestamps (created/prepare-started/exec-started/exec-finished/harvested/recorded — prep + harvest never bill the execution deadline), outcome (exit code AND signal, decoded envelope, `blame` verdict `{blame,reasonCode,message,matchedRule}`, optional `recoveryAdvice: retry-safe|resume-with-session|do-not-retry`, `interruptionBehavior` in force), outputs manifest (`{path,sizeBytes,sha256,mediaType?}` per artifact incl. stdout/stderr/teed transcript), executor identity (harness name/version, capability strings, session ID, shim fingerprint, workspace path, resolved LaunchPlan digest), cheap resource usage.
  - `reconcileAttempt(fold, reality)` → the §6.4 classification (`matching | matching-late | absent-never-executed → rejected | absent → lost | orphaned → kill-ladder+lost | stale/foreign (nonce mismatch) → ignore | harvesting-resume | recording-resume | contradictory | corrected`). Never blind-respawns.
  - `runCancellationLadder(attempt, { graceMs=10000, killPollCeilingMs=30000 })` (§6.5): idempotent, non-outcome; `cancel-requested` → tell the shim to cancel → shim signals the harness subtree (SIGTERM → grace → SIGKILL → poll bounded by ceiling); shim spared (survives, records true `outcome.json`); harvest still runs; terminal `cancelled` unless the recorded outcome says otherwise; ceiling elapsed with subtree non-empty → `failed[infrastructure]` + "residual live processes" annotation with surviving PIDs (never a hang); records + workspace kept.
  - `armDeadline(execStartedAtMonotonic, maxAttemptDurationMs)` + heartbeat (§6.6): with `deadlineEnforcement: active`, arm from the Submission deadline (execution phase only), re-arm relative durations after restart from `exec-started` on a monotonic clock; on expiry run the cancellation ladder with terminal `expired` (clock-skew grace first); heartbeat staleness (interval 15s, stale after 3 missed) emits a degradation observation only (killing is application policy via cancel).

- [ ] **Step 1: Write failing tests** for: torn-tail `seq` resumption (`durableSeq()` = `max(intact seq)+1`); append-before-emit ordering (a scripted crash after fsync-before-emit never leaves a consumer holding a `(source,id)` the rebuild won't re-emit); per-nonce terminal uniqueness (second terminal rejected+flagged; `lost`→corrective terminal accepted without flag); attempt-record fold field completeness; cancellation ladder idempotency + un-killable-ceiling → residual-PIDs terminal; deadline monotonic re-arm across a backward wall-clock jump.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** each module. Journal storage = JSONL with torn-tail tolerance (the contract is the event shape + append-before-emit + pure fold, not the engine; §6.2). Reconciler is a pure function of `(fold, reality)`. Cancellation + deadline drive the shim (A4) and journal (this task).
- [ ] **Step 4: Run → PASS** on the inline unit tests, THEN author + run `reconciler.conformance.test.ts` = `describeAttemptSupervisorContract(makeRealSupervisor)` over every §6.4 row from the A3 kit fixtures → GREEN. This is the moment the kit-authored supervisor conformance (shim + journal + reconciler + cancellation + deadline fixture families) turns red→green against the real supervisor.
- [ ] **Step 5: Verify** — typecheck + guards + locale-ban.
- [ ] **Step 6: Commit** — `feat(backend-local): journal, attempt record, reconciler, cancellation, deadline`.

**Milestone A gate:** the supervisor is complete and green against the kit's shim/journal/reconciliation/cancellation fixtures; the fake launcher conforms; guards + CI recognize backend-local and the testing slice.

---

# Milestone B — workspace + launchers (design §18 step 2; claude-code first)

Delivers: the Workspace Provisioner (directory contract, two-phase provisioning, input materialization, harvest, minimal local grant resolution) and the four v1 launchers, claude-code first. Frozen interfaces §14.7–§14.9. The kit's launcher-contract and workspace-contract describe-functions gain full teeth here.

## Task B1: Workspace Provisioner — directory contract + two-phase provisioning + grants (§7.1–§7.3)

**Files:**
- Create: `src/workspace/dir-provisioner.ts`, `src/workspace/worktree-provisioner.ts`, `src/workspace/materialize.ts`, `src/workspace/grants.ts`
- Modify: `src/workspace/index.ts` (export `makeDirProvisioner`, `makeWorktreeProvisioner`, `selectProvisioner`, `resolveGrantsToSecrets`)
- Test: `src/workspace/*.test.ts`; drive `describeWorkspaceContract` from the kit slice

**Interfaces:**
- Consumes: `ProvisionerContract`, `WorkspacePaths`, `TaskView` (A2); profiles workspace-kind selection + `capabilityGrants` types; protocol `ResourceDescriptor` + sealed Task bytes; `node:fs`, `node:child_process` (git), `node:crypto` (re-hash).
- Produces:
  - `selectProvisioner(view): ProvisionerContract` — plain-dir by default; detached git worktree at an exact OID for repository/session profiles (provisioner implementations selected by profile, §7.2).
  - Directory contract (§7.1): `input/` (read-only after provisioning: sealed Task bytes verbatim + dispatch-context artifact + resolved inputs), `work/`, `out/`, `logs/`, `harness-state/` (CLAUDE_CONFIG_DIR/CODEX_HOME), `secrets/` (0700), `tmp/`, `meta/`. Env-var indirection only (`JINN_ATTEMPT_*` + attempt identity; concrete paths never promised). Retention per-directory (`meta/`/`logs/`/`out/`/`harness-state/` survive; `secrets/`/`tmp/` wiped at terminal; `work/` GC'd under TTL + disk-floor). Per-attempt cumulative disk quota enforced during execution; `meta/` placed (reserve/distinct device) so a sibling's fill cannot false-`lost` an outcome write.
  - Two-phase provisioning (§7.2): setup phase (network + credentials) resolves declared input descriptors by digest with re-hash-on-fetch (`content-corruption` on mismatch), materializes the workspace kind, writes `secrets/`; the execution phase receives only the launcher's allowlisted env (setup credentials never ride into the harness env beyond declared forwards). Provisioning failure is terminal `rejected` (never-executed guarantee); the line is `exec-started`.
  - Input materialization (§7.3): sealed Task bytes handed verbatim (TEP §16.1 — the bytes are the Evidence Task artifact, no projection); dispatch-context artifact written into `input/` and registered in the evidence capture input set (assembly join, Milestone C); `input/` read-only after setup; a mutation detected at harvest is an integrity violation recorded on the attempt record.
  - `resolveGrantsToSecrets(grants, paths.secrets)` — the MINIMAL local capabilityGrant resolution: resolve declared grants into `secrets/` handle files (enough for the evaluation harness's signer forward; the same seam serves adopter token forwards in the future adoption pass). Full trust §8.3 obligations stay out (see Out of scope + Findings (d)).

- [ ] **Step 1: Write failing tests** — directory set created with correct modes (`secrets/` 0700); setup re-hash-on-fetch rejects a digest mismatch as `content-corruption`; sealed Task bytes land byte-verbatim in `input/`; `input/` immutability violation detected; worktree provisioner checks out the exact 40-hex OID (detached); provisioning failure → terminal `rejected`; grant resolution writes only reference handles (no secret bytes leak to `meta/`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Git worktree via `git worktree add --detach <oid>` (host-configured local mirror/reference-repo is provisioner config, not Task content). Re-hash uses `node:crypto` sha256. `resolveGrantsToSecrets` writes handle files (opaque references), never resolved values.
- [ ] **Step 4: Run → PASS** and run `describeWorkspaceContract` from the kit slice over both provisioners.
- [ ] **Step 5: Verify** — typecheck + guards (workspace may use git + node:fs but not supervisor/launchers/assembly/evidence).
- [ ] **Step 6: Commit** — `feat(backend-local): workspace provisioner, two-phase provisioning, grant resolution`.

## Task B2: Harvest (§7.4)

**Files:** Create `src/workspace/harvest.ts`; Modify `src/workspace/index.ts`; Test `src/workspace/harvest.test.ts`.

**Interfaces:**
- Produces: `harvest(paths, declaredOutputs)` → `HarvestResult = { manifest: OutputArtifact[]; omissions: string[]; integrityViolations: IntegrityViolation[] }`. Supervisor-invoked, always-run (after success/failure/cancel/expiry), gated on a **verified-empty harness group on every path**. Collection from `out/` only; a missing declared output is a recorded omission, not a failure. Every entry resolved with `O_NOFOLLOW`/realpath; any symlink whose target escapes `out/` is rejected + recorded as an integrity violation (closes `out/creds → ../secrets/token`). Everything collected digested at collection (sha256, sorted by path via `compareCodeUnitStrings`); stdout/stderr + teed transcript digested as first-class artifacts. Recovery re-runs harvest idempotently (with the process gone `out/` is frozen → deterministic re-collection).

- [ ] **Step 1: Write failing tests** — symlink escaping `out/` rejected + integrity violation (not dereferenced); missing declared output → omission not failure; verified-empty-group gate blocks harvest while a background child is alive; re-harvest after process-gone is byte-deterministic and never drops an output a partial harvest missed; manifest sorted by code-unit path order.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** using `openSync` with `O_NOFOLLOW`, `realpathSync`, and a containment check against the `out/` realpath. **Step 4: Run → PASS.** **Step 5: Verify** (guards). **Step 6: Commit** — `feat(backend-local): symlink-guarded verified-empty harvest`.

## Task B3: Launcher — claude-code (design §8.3, first) + result interpretation (§8.2)

**Files:** Create `src/launchers/claude-code.ts`, `src/launchers/result.ts`; Modify `src/launchers/index.ts`; Test `src/launchers/claude-code.test.ts`, `src/launchers/result.test.ts`; drive `describeLauncherContract` from the kit.

**Interfaces:**
- Consumes: `LauncherContract`, `LaunchPlan`, `TaskView`, `WorkspacePaths`, `AttemptIdentity` (A2).
- Produces:
  - `claudeCodeLauncher: LauncherContract` — generalizes the daemon's `ClaudeCodeHarnessAdapter` and Autopilot's coordinator spawn into one launcher (what made the coordinator spawn special was application authority, which stays in Autopilot). Obligations (§8.1): hermetic invocation always (`--bare`-class flags; context via flags + provisioned files; harness state pointed at `harness-state/` via CLAUDE_CONFIG_DIR); environment discipline (allowlist base + attempt identity + workspace indirection; secrets only as declared reference-forwards from `secrets/`; secret-shaped ambient keys stripped categorically); run-pinning enforcement (`enforced` posture — pinned harness/model/loadout runs or `submit` rejects; loadouts materialized + digest-verified in setup, fail-closed); two-channel capability declaration (static `capabilities()` + dynamic `probe()`). `env` carries secret references, never values → plan determinism holds.
  - `interpretResult(plan, exit, envelope?)` (§8.2): exit code + termination signal AUTHORITATIVE for fail/not-fail — an exit outside `validExitCodes` or death-by-signal is `failed` (blame per `blameExitCodes`) and can NEVER be overridden to `delivered` by a printed envelope. The envelope may only refine WITHIN the not-failed class. claude-code mapping: `success` → `delivered` (outcome `fulfilled`); `is_error`/`error_during_execution` → `failed[task]`; limit exhaustion (`error_max_turns`, `error_max_budget_usd`) → `delivered` outcome `partial` + `recoveryAdvice: resume-with-session`; a `fulfilled` run with empty `out/` is still `delivered` with an empty outputs manifest. Structured output (profile output schema) passed via `--json-schema`/`--output-schema`; the validated object collected as a first-class artifact alongside the envelope, never instead. Correlation annotations (harness name/version, capability strings from `system/init`, session ID) enter the attempt record.

- [ ] **Step 1: Write failing tests** — plan determinism (byte-identical plan from identical inputs); hermeticity (plan varying with ambient env fails); success-envelope + out-of-range exit → `failed` (envelope cannot override); limit-exhaustion → `partial` + `resume-with-session`; within-range exit + no envelope → `fulfilled`; secret env entries are references not values; structured-output artifact collected alongside the envelope.
- [ ] **Step 2: Run → FAIL. Step 3: Implement** `claude-code.ts` (pure `plan(...)`) + `result.ts` (`interpretResult`). **Step 4: Run → PASS**; drive `describeLauncherContract` over claude-code. **Step 5: Verify** (guards: launchers import no `node:child_process`, no spawning). **Step 6: Commit** — `feat(backend-local): claude-code launcher + result interpretation`.

## Task B4: Launchers — codex, hermes, cursor (design §8.3)

**Files:** Create `src/launchers/codex.ts`, `src/launchers/hermes.ts`, `src/launchers/cursor.ts`; Modify `src/launchers/index.ts`; Test one `*.test.ts` each; drive `describeLauncherContract` over all four.

**Interfaces:**
- Produces three more `LauncherContract`s, each a pure `plan(...)`:
  - `codexLauncher` — `codex exec --json` + `--output-schema` schema flags; hermeticity flags; `validExitCodes`/`blameExitCodes` per Codex CLI semantics.
  - `hermesLauncher` — the hermes-agent invocation; env carries `OPENROUTER_API_KEY` as a `secrets/` reference-forward (never a value).
  - `cursorLauncher` — `cursor-agent` headless (parity with Autopilot's existing runtime selection).
  Each declares static capabilities (supported task profiles, media types, structured-output/resume support, `interruptionBehavior` defaults, `runPinning` support) and a `probe()` for binary/auth/version readiness. Adding a launcher is implementing the contract — never a backend or protocol change (§8.3).

- [ ] **Step 1: Write failing determinism + hermeticity + result-interpretation tests** for each launcher (repeat the B3 assertions per harness with the harness-specific flags — repeated in full, not "similar to B3"). **Step 2: Run → FAIL. Step 3: Implement** the three launchers. **Step 4: Run → PASS**; `describeLauncherContract` green over all four. **Step 5: Verify** (guards). **Step 6: Commit** — `feat(backend-local): codex, hermes, cursor launchers`.

**Milestone B gate:** the workspace provisioner (both kinds), harvest, grant resolution, and all four launchers pass the kit's workspace-contract and launcher-contract describe-functions.

---

# Milestone C — assembly + TEP kit green (design §18 step 3)

Delivers: the `TaskExecutionBackend` implementation wiring supervisor + workspace + launchers, the capacity gate + single-writer lock, observation projection, assembled `capabilities()`, the evidence join + host-injection port. The reference implementation becomes the TEP conformance kit's first real consumer (§16). Frozen interfaces §14.1, §14.10, §14.11.

## Task C1: Backend verbs + capacity gate + single-writer lock (§9.1, §5)

**Files:** Create `src/assembly/backend.ts`, `src/assembly/capacity.ts`, `src/assembly/index.ts`; Modify `src/index.ts` (root export = `makeLocalTaskExecutionBackend`); Test `src/assembly/backend.test.ts`, `src/assembly/capacity.test.ts`.

**Interfaces:**
- Consumes: the supervisor surface (A4/A5), the provisioner + harvest (B1/B2), the launcher registry (B3/B4), protocol's `mergeRequirements` (§5.1 comparison-class merge → `EffectiveRequirements`) + `ComparisonClass`, profiles' `resolveProfile` + resolved-profile resolution (each carrying its `requirementKeys` classes), protocol's `TaskExecutionBackend`/`SubmissionAck`/`ObservationSnapshot`/`DeliveryRef`/error categories + Delivery sealer, `@jinn-network/task-execution-backend`'s `TaskExecutionError`.
- Produces:
  - `makeLocalTaskExecutionBackend(config): TaskExecutionBackend` implementing §9.1: `submit(taskBytes, submissionBytes)` (validate + seal-check both; byte-exact idempotency per TEP §12.2 — same key + identical bytes → existing ack, same key + different bytes → `submission-conflict`; **run the comparison-class merge** — resolve the Task's profile (`resolveProfile`), assemble `keyClasses` = the fixed core-key comparison classes ⊎ the resolved profile document's `requirementKeys` classes, then call protocol's `mergeRequirements(taskRequirements, submissionRequirements, keyClasses)`; `{ ok: false, category: 'invalid-document', key }` → typed `invalid-document` (journaled to the submission-scoped segment); `{ ok: true, effective }` → the `effective` `EffectiveRequirements` map is folded into the `TaskView` this backend hands the provisioner/launcher; **then honor-or-reject every Submission requirement** against `capabilities()` before any Attempt exists — a mandatory requirement / a pinning key absent from `capabilities().runPinning` inventories / an `attempts` bound outside `{maxTotal:1..1, maxConcurrent:1..1}` / an `evaluationRequirements` block with no interpreting deployment profile / an unhonorable `closeAt` → typed `unsupported-requirement`/`submission-rejected` journaled to the submission-scoped segment (this capability check — never the pure merge — is the sole producer of `unsupported-requirement`, program §7.3); on acceptance: `submission-accepted` → mint Attempt URI (`urn:uuid` at engagement, journaled) → `attempt-engaged` (pins this backend as the authoritative observation source, carries the dispatch-context descriptor) → provisioner setup → launcher plan → journal spawn-intent → shim spawn). `observe`, `watch`, `cancel`, `recover`, `deliveries`, `fetchDelivery`, `preflight` per §9.1.
  - The capacity gate (§5): counts live attempts from the journal fold against configured concurrency; rejects `submit` over the ceiling as typed `backend-unavailable` with capacity detail (never queues; capacity-exhausted NOT added — Global Constraints).
  - The single-writer lock (§5): on startup take an exclusive advisory lock on `meta/backend.lock` (flock, held for process lifetime) across all `submit`/`recover`; a second instance finding the lock held fails `submit`/`recover` with `backend-unavailable` ("state root locked by a live instance").
  - The seal-once Delivery checkpoint (§9.1): Delivery bytes assembled once from the attempt record (via protocol's Delivery sealer), checkpointed with the §6.1 atomic-publish discipline, reused verbatim on any recovery — never re-assembled; a torn checkpoint recovered by re-read; durably written before `delivery-recorded`.

- [ ] **Step 1: Write failing tests** — idempotency (same key+bytes → same ack; same key+different bytes → `submission-conflict`); merge (`mergeRequirements` over keyClasses = core ⊎ resolved-profile `requirementKeys`: a class-violating requirement → `{ ok: false, category: 'invalid-document', key }` surfaced as typed `invalid-document`, NOT `unsupported-requirement`; a valid merge → the returned `effective` `EffectiveRequirements` map is the one folded into the `TaskView` handed to the launcher); honor-or-reject (a pinning key absent from `capabilities().runPinning` → `unsupported-requirement`; `attempts: {maxTotal:2}` → `unsupported-requirement`; unknown mandatory requirement → `unsupported-requirement`, journaled to the submission segment — all from the capability check, never the merge); capacity ceiling → `backend-unavailable`; two instances on one root → second `submit`/`recover` → `backend-unavailable`; seal-once (a scripted crash after checkpoint → recover re-reads the exact bytes, digest unchanged; a torn checkpoint → re-read not re-assemble).
- [ ] **Step 2: Run → FAIL. Step 3: Implement** `backend.ts` + `capacity.ts` (flock via `fs`/`flock`; concurrency from the journal fold). Merge effective requirements through protocol's `mergeRequirements` (keyClasses = the fixed core-key classes ⊎ the resolved profile's `requirementKeys`); fold the returned `effective` map into the `TaskView`; `invalid-document` originates in the merge, `unsupported-requirement` in the capability check against `capabilities().runPinning` (never the merge). **Step 4: Run → PASS.** **Step 5: Verify** (guards: assembly imports the three sub-regions + protocol/backend/profiles; NOT evidence-local-runtime/discovery/apps). **Step 6: Commit** — `feat(backend-local): backend verbs, capacity gate, single-writer lock, seal-once delivery`.

## Task C2: Observation projection + assembled capabilities() (§9.2, §9.3)

**Files:** Create `src/assembly/observation.ts`, `src/assembly/capabilities.ts`; Modify `src/assembly/index.ts`; Test `src/assembly/observation.test.ts`, `src/assembly/capabilities.test.ts`.

**Interfaces:**
- Produces:
  - `projectObservations(events): ProtocolObservation[]` (§9.2): deterministic projection of journal events onto TEP observation types (`submission-accepted`, `attempt-engaged`, `attempt-started`, `progress`, `cancel-requested`/`-acknowledged`, `execution-observed`, `delivery-recorded`, `attempt-terminal` with blame + reason). Backend-internal phases ride as `progress` payload detail. Rebuilds re-emit identical `(source, id)` pairs.
  - `assembleCapabilities(config, launchers, provisioner, recorderAvailability, trustKeyConfig): BackendCapabilities` (§9.3): task profiles = launcher declarations ∩ provisioner workspace kinds; media types + artifact ceilings from provisioner config; `cancel`/`watch`/`preflight` true; `confidentialInputs: true`; `fetchArtifact: true`; `evidenceCapture` from recorder availability; `signedObservations`/`signedDeliveries` from trust-layer key config (unsigned in a local trust domain); `deadlineEnforcement: active`; `attempts` = `{maxTotal:1..1, maxConcurrent:1..1}`; a `runPinning` block declaring the enforced comparison classes (profiles requires this) + the harness inventory from registered launchers, `enforced` posture. Dynamic readiness lives in `preflight`, not `capabilities()`.

- [ ] **Step 1: Write failing tests** — rebuild re-emits identical `(source,id)` pairs (pin against the kit's golden journal→observation fixtures); `capabilities()` is assembled (task profiles = launcher ∩ provisioner; `attempts` = 1..1; `runPinning` block present with `enforced`; `evidenceCapture` reflects injected recorder availability). **Step 2: Run → FAIL. Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Verify.** **Step 6: Commit** — `feat(backend-local): observation projection + assembled capabilities`.

## Task C3: Evidence join + host-injection port (§10.1–§10.2)

**Files:** Create `src/assembly/evidence-join.ts`; Modify `src/assembly/index.ts`, `src/assembly/backend.ts` (wire the join into submit/harvest/deliver); Test `src/assembly/evidence-join.test.ts`; drive the kit's evidence-join fixtures.

**Interfaces:**
- Consumes: `EvidenceRepository` (evidence-repository, TYPE — injected), `EvidenceCatalogReader` (evidence-discovery, TYPE — injected), `createExecutionRecorder`/`ExecutionRecorder`/`ExecutionRecording` (execution-recorder — the I/O-free producer, constructed over the injected repository). NEVER imports `@jinn-network/evidence-local-runtime`.
- Produces:
  - `EvidenceBindingPorts = { repository: EvidenceRepository; catalog: EvidenceCatalogReader; awaitIndexed(ref): Promise<IndexingOutcome> }` — the injection seam the host wires; `awaitIndexed` is a narrow assembly-owned port the host implements over the `evidence-local-runtime` composition's `awaitIndexed`, so the assembly types against contracts + the port, never the composition package (§10.1, §15).
  - The join wiring (§10.1 table): Evidence Task artifact = sealed Task bytes in `input/` (same sha256); recorder captured inputs = the `input/` set incl. the dispatch-context artifact; Runtime Spec/Observation = the journaled LaunchPlan (planned) + shim/journal facts (ran); Evidence Results = harvest manifest digests; finalization receipt `{family, digest}` + Execution ID → the Delivery's `evidenceRecords`/`executionIds`, supervisor emits `execution-observed` with the Execution `urn:uuid`.
  - Capture posture (§10.2): `evidenceCapture: none | available | always`; under `always` a capture failure is `failed[infrastructure]`; the recorder `finalize` receipt MUST precede `delivered` (its `{family,digest}` + Execution ID go into the Delivery); catalog INDEXING does NOT gate `delivered` — the assembly awaits the receipt, not the projection.
  - A reference host-wiring example (in a test or `README`) showing the host constructing `EvidenceBindingPorts` from `openLocalEvidenceRuntime()` — demonstrating the seam without the assembly importing the composition.

- [ ] **Step 1: Write failing tests** — capture `always` failure → `failed[infrastructure]`; receipt fields present in the Delivery (`evidenceRecords`/`executionIds`); dispatch-context artifact in the recorder's captured inputs; `delivered` set only after the finalize receipt (not after catalog indexing); a guard-level assertion that `evidence-join.ts` imports no `@jinn-network/evidence-local-runtime`. **Step 2: Run → FAIL. Step 3: Implement** — construct the recorder over the injected repository; wire the join at submit (captureInput), during run (captureRuntimeObservation), at harvest (results), at finalize (receipt → Delivery). **Step 4: Run → PASS**; the kit's evidence-join fixtures green. **Step 5: Verify** — the boundaries guard forbids `evidence-local-runtime` in `assembly`. **Step 6: Commit** — `feat(backend-local): evidence recorder join + host-injection awaitIndexed port`.

## Task C4: TEP kit green — the reference implementation as the TEP kit's first real consumer (§16)

**Files:** Create `src/assembly/backend.tep-conformance.test.ts`; Modify the kit slice `backend-contract.ts` (finalize `describeLocalBackendContract`); Test = the TEP core conformance kit run against `makeLocalTaskExecutionBackend`.

**Interfaces:**
- Consumes: the TEP core kit `describeTaskExecutionBackendContract` (testing package root); `makeLocalTaskExecutionBackend` (C1–C3); the fake launcher + an in-memory injected repository/catalog for the harness-free path.
- Produces: `describeLocalBackendContract(makeBackend)` — runs the TEP core kit + the local specifics (two-instances-one-root → `backend-unavailable`; `attempts` outside 1..1 → `unsupported-requirement`; cancellation races; the seal-once + evidence-join behaviors).

- [ ] **Step 1: Assemble a fully-injected local backend** in the test (fake launcher, in-memory `EvidenceRepository`/`EvidenceCatalogReader`, a stub `awaitIndexed`) and run `describeTaskExecutionBackendContract` against it. **Step 2: Run → observe failures**, fix assembly gaps until **green** (this is the §16 gate: the reference impl is the TEP kit's first real consumer). **Step 3: Run the local-specifics** (`describeLocalBackendContract`) → green. **Step 4: Verify** — full `yarn test` in backend-local + the testing package; all guards; `yarn build && yarn pack:smoke`. **Step 5: Commit** — `test(backend-local): TEP conformance kit green against the reference backend`.

**Milestone C gate (design §18 step 3):** assembly lands with the TEP conformance kit passing green; `capabilities()` assembled; evidence join wired through the injection port; single-writer + capacity + seal-once proven.

---

# Milestone D — evaluation harness (design §10.3–§10.4, §17)

Delivers: the residual evaluation-harness package. An evaluation is an evaluation-profile Task executed as an ordinary Attempt through this backend; its Delivery output is the evaluator-signed Result Evaluation Statement (profiles §9). The evaluator-adapter contract + registrations from the Evaluation Runner design (§10/§11) compose as-is; the provisioner replaces the material resolver; the already-implemented Attestation Issuer signs; recovery/cancellation/idempotency/receipts are inherited from the backend. The evidence-profile minor addition (F7) lands FIRST, before the crosswalk-stamp/verification integration.

## Task D1: Evidence profile minor addition — Task/Execution identifier-PropertyValue (F7)

Sanctioned by TEP §18/§28. The identifier-PropertyValue pattern exists generically in the evidence protocol, but normative Task/Execution-entity language + TEP scheme `propertyID` IRIs are absent. This amends the evidence-protocol package and MUST precede D3's crosswalk-stamp/verification.

**Files:**
- Modify: `packages/evidence/protocol/profiles/execution-evidence/1.0/specification.md` (normative Task/Execution identifier-PropertyValue text)
- Modify: `packages/evidence/protocol/src/identifiers.ts` (TEP scheme `propertyID` IRI constants for the Task digest + profile URI stamped into Evidence Task/Execution entities)
- Create: one fixture under `packages/evidence/protocol/fixtures/` exercising the identifier-PropertyValue on a Task/Execution entity
- Test: extend the evidence-protocol Zod/schema-drift test that `yarn check:profile` runs

**Interfaces:**
- Consumes: the existing evidence-protocol `identifiers` module + the packaged normative profile.
- Produces: exported IRI constants (the `propertyID` spellings for `did:pkh`/`did:key`/`CAIP-19`/GitHub + the TEP task-digest/profile-URI schemes) and the normative text making Task/Execution identifier-PropertyValue entities well-formed. Scheme-IRI registration itself is the ONE shared program follow-up (TEP §28 / profiles §17 / trust §20) — this task ships the constants + normative language, not the external registration.

- [ ] **Step 1: Write the failing fixture + schema-drift assertion** — a Task/Execution entity carrying the identifier PropertyValue with the new `propertyID` IRI; assert the reference validator accepts it and `yarn check:profile` stays green (Zod ↔ schema parity). **Step 2: Run → FAIL. Step 3: Add** the normative text to `specification.md` + the IRI constants to `identifiers.ts` + the fixture. **Step 4: Run → PASS**; `yarn check:profile` green. **Step 5: Verify** — the evidence guards (`node --test .github/scripts/evidence-package-inventory.test.mjs .github/scripts/evidence-source-boundaries.test.mjs`) stay green; evidence-protocol `yarn typecheck && yarn test && yarn build`. **Step 6: Commit** — `feat(evidence-protocol): normative Task/Execution identifier-PropertyValue + TEP scheme IRIs`.

## Task D2: Evaluation-harness package + evaluator-adapter contract + registrations (§10/§11)

**Files:**
- Create: the standalone package `packages/task-execution/evaluation-harness/{package.json,tsconfig.json,tsconfig.build.json,README.md,scripts/pack-smoke.mjs,yarn.lock}`
- Create: `src/index.ts`, `src/adapter.ts`, `src/registration.ts`
- Modify: the task-execution guards (register `@jinn-network/task-execution-evaluation-harness` in inventory + boundaries + packed-types; add a CI job) — recompute the count against the live guard
- Test: `src/adapter.test.ts`, `src/registration.test.ts`

**Interfaces:**
- Consumes: `@jinn-network/evidence-protocol` (ResourceDescriptor, Result Evaluation shapes), `@jinn-network/task-execution-profiles` (evaluation-task/1.0, EvaluationSpec, the §9.1 derivation template).
- Produces (composed as-is from the Evaluation Runner design §10/§11):
  - `evaluate(task, results, specification, context, attempt, deadlineSignal): Promise<CompletedEvaluation>` — the evaluator-adapter contract (Runner §11). `CompletedEvaluation = { detailedOutcome; verdict: "pass"|"fail"|"inconclusive"; evaluatedAt; measurements?; explanation?; limitations?; claimEvidence?; evaluatorExecution?; authenticatedEvaluatorContext? }`. An operational interruption is NOT a `CompletedEvaluation` (typed failure path, no verdict).
  - `EvaluatorRegistration = { registrationId; adapter; evaluationMethod; specificationCompatibility; evaluatorIdentity; signer; outcomeValidator; interruptionBehavior }` (Runner §10) with `interruptionBehavior: repeatable | recoverable | nonrepeatable` (§10.3, adopted stack-wide by this backend).
  These types are DEFINED FRESH here (no `@jinn-network/evaluation-runner` package is built — the Runner impl plan is superseded; see D5).

- [ ] **Step 1: Write failing contract tests** — a stub adapter's `evaluate(...)` returns a `CompletedEvaluation`; an operational interruption follows the typed-failure path and never becomes a verdict; `interruptionBehavior` is declared per registration; untrusted adapter output cannot override subjects/method/specification/signer. **Step 2: Run → FAIL. Step 3: Scaffold** the standalone package (match Global Constraints; deps = evidence-protocol, task-execution-profiles, attestation-issuer, task-execution-backend-local [for `./launchers` in D4]; devDeps as needed) and implement `adapter.ts` + `registration.ts`. Extend the guards. **Step 4: Run → PASS.** **Step 5: Verify** — typecheck + guards. **Step 6: Commit** — `feat(evaluation-harness): package + evaluator-adapter contract + registrations`.

## Task D3: Harness runtime + Attestation Issuer signing + secrets/ signer forward (§10.4)

**Files:** Create `src/runtime.ts`, `src/bin.ts`, `src/sign.ts`; Modify `src/index.ts`; Test `src/runtime.test.ts`, `src/sign.test.ts`.

**Interfaces:**
- Consumes: the provisioner-verified `input/` materials (Task, Results, spec, context, grader bundle, admission receipt, `capabilityGrants`-resolved `secrets/`); `prepareResultEvaluation(input, signer: DsseSigner, opts)` (attestation-issuer); the profiles `evaluation-task/1.0` derivation + EvaluationSpec parsing; `WorkspacePaths` (backend-local `./workspace` types).
- Produces:
  - `runEvaluationHarness(paths): Promise<number>` — reads pre-verified materials from `input/` (the provisioner replaces the Runner's material resolver — materials are already digest-verified, §10.4); selects + runs the registered evaluator adapter (`evaluate(...) → CompletedEvaluation`); composes `prepareResultEvaluation` with the CompletedEvaluation mapped to the Result Evaluation predicate (`evaluatedAt`, `evaluator.id`, `evaluationSpecification` = the spec digest [checked], `evaluationMethod` [evaluator-authored], subjects, `verdict`, `measurements` covering the spec's required list, `limitations`, `evidence`); **parser resolution is allowlist-bound** — any parser / verdict rule the EvaluationSpec names is resolved ONLY from the deployment's parser allowlist by `id`, and the harness runtime NEVER executes spec-supplied parser code (the parser/verdict rule is a closed declarative vocabulary — no executable code, no external references — so a spec-embedded parser is an injection surface that is refused, never run; program §7.10, profiles §7.3). Where a concrete deterministic/model adapter owns parsing, the harness delegates to that allowlisted adapter (concrete adapters are out of scope here, so enforcement partly lives in the adapter — but the guarantee is stated and tested where the harness runtime consumes the parser). The adapter emits the FULL spec-required measurements set (every measurement the spec requires) so verdict-consistency is computable (program §7.10). The DSSE envelope is signed by the **evaluator Agent's key**, which arrives as a `secrets/` reference-forward resolved from a `capabilityGrant` (a deliberate change from the Runner's host-controlled signer isolation, now that signing happens inside the executor); writes the signed DSSE Statement (byte-identical to the evaluation Delivery payload profiles §9 requires) to `out/verdict`; returns an exit code the launcher interprets. The crosswalk-stamp (`evaluationSpecification` digest = the subject Task's sealed `evaluation` descriptor digest, profiles §7.7) + verification is applied here — hence D1 precedes it.
  - `bin.ts` — the spawned entrypoint calling `runEvaluationHarness(pathsFromEnv())`.
  - `makeSecretsSigner(secretsDir, handle): DsseSigner` — a `DsseSigner` (attestation-issuer's injected port) that reads the evaluator Agent key from the `secrets/` handle at sign time; the harness never receives raw key bytes beyond the resolved forward.

- [ ] **Step 1: Write failing tests** — `runEvaluationHarness` reads verified `input/` materials, runs a stub adapter, and writes a signed DSSE Statement to `out/verdict` whose `evaluationSpecification` digest equals the subject Task's sealed `evaluation` descriptor digest (crosswalk stamp); a parser referenced by an `id` outside the deployment allowlist is REJECTED (never executed), and a spec that embeds parser code is refused rather than evaluated (program §7.10 / profiles §7.3); the adapter emits every spec-required measurement (a missing one fails verdict-consistency); an operational adapter failure produces no verdict + a failing exit (unscorable → `retryable-infrastructure` maps to `failed[infrastructure]`, never a FAIL); the signer reads the key from `secrets/` (no key bytes in `meta/`/logs). **Step 2: Run → FAIL. Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Verify.** **Step 6: Commit** — `feat(evaluation-harness): runtime, issuer signing, secrets signer forward`.

## Task D4: The evaluation launcher + backend integration (§10.3)

**Files:** Create `src/launcher.ts`; Modify `package.json` (add `./launcher` subpath), `src/index.ts`; Test `src/launcher.integration.test.ts` (runs an evaluation-profile Task through the assembled backend + the fake evidence bindings).

**Interfaces:**
- Consumes: `LauncherContract`/`LaunchPlan`/`TaskView` (`@jinn-network/task-execution-backend-local/launchers`); `makeLocalTaskExecutionBackend` (backend-local, dev/integration only).
- Produces: `evaluationLauncher: LauncherContract` — plans spawning `bin.ts` in `work/` for `evaluation-task/1.0` profile Tasks (hermetic; harness state in `harness-state/`; the evaluator Agent key forwarded as a `secrets/` reference). The host wires this launcher into the assembly's launcher registry at composition time — backend-local never imports the harness (product-neutral). Recovery/cancellation/idempotency/receipts are inherited from the backend (§10.4): an evaluation is an ordinary Attempt.

- [ ] **Step 1: Write a failing integration test** — submit an `evaluation-task/1.0` Task + Submission to a local backend whose launcher registry includes `evaluationLauncher`; assert the Attempt runs the harness, the Delivery payload is the signed Result Evaluation Statement, and a mid-run crash + `recover()` reconciles it as an ordinary Attempt (no separate evaluation process model). **Step 2: Run → FAIL. Step 3: Implement** `launcher.ts`. **Step 4: Run → PASS.** **Step 5: Verify** — guards (the harness→backend-local edge is `./launchers` types + a dev/integration edge; no cycle: backend-local does not import the harness). **Step 6: Commit** — `feat(evaluation-harness): evaluation launcher + backend integration`.

**Milestone D gate:** an evaluation-profile Task runs end-to-end through the backend as an ordinary Attempt, delivering the evaluator-signed Statement; the crosswalk stamp holds against the D1 evidence amendment.

---

# Milestone E — first-adopter pass (DESCOPED from this program) + doc reconciliation (already landed)

> **Descope note, 2026-07-28 (operator decision at the program gate):** Autopilot adoption
> (design §18 step 4, §11.1) is REMOVED from this program. This pass builds the full
> foundation only; proving the backend with a first adopter is its own later pass, and
> Autopilot itself now lives in a separate repository. The design is unchanged — §18 step 4
> stands as the next step for whoever runs the adoption pass (consuming these packages from
> npm rather than in-repo portals). The former Task E1 content (delegation of
> `SessionExecutionBackend` to `makeLocalTaskExecutionBackend`, retirement of
> `isPidAlive`/`markAttemptExited`/`processState`, the dead-PID `recover`-returns-`completed`
> bug closure, typed `patch` results) is preserved in design §11.1/§17 and in this plan's
> git history for that pass to pick up. This program's backend deliverable therefore ends at
> the Milestone D gate (assembly + TEP kit green + evaluation harness), which design §16
> already makes self-proving: the reference implementation is the TEP conformance kit's
> first real consumer.
>
> **Former Task E2 (Evaluation Runner doc-vs-doc reconciliation) already landed** at program
> Phase 1 (commit 89c6e0788: supersession banner on the runner plan, status-header amendment
> on the runner design with the exact §10.4 lists, application-layer index reconciliation).
> Remaining step here is verification only.

- [ ] **Verify (doc reconciliation):** confirm `docs/superpowers/plans/2026-07-27-evaluation-runner.md` carries the supersession banner, `docs/superpowers/specs/2026-07-26-evaluation-runner-design.md` carries the status-header amendment (exact §10.4 composed-as-is / superseded lists), and the application-layer index points the harness at `packages/task-execution/evaluation-harness`; no stale "build the runner package" instruction remains.

**Milestone E gate (as descoped):** the doc reconciliation is verified present. §18 step 4 (first-adopter pass) and step 5 (daemon carve, marketplace-binding design) are both OUT of this program.

---

## Findings (cross-plan coordination surfaced during planning)

Resolves the "See Findings" pointers above. These are coordination decisions, not tasks; each is already reflected in the task that carries it.

- **(a) testing → backend-local production dep vs backend-local → testing devDep-only (program §7.5).** The `@jinn-network/task-execution-testing` package's `./backend-local` slice is a real consumer of backend-local: its fake launcher implements backend-local's `LauncherContract`, and its describe-functions drive backend-local's supervisor/workspace/assembly APIs. So the slice declares `@jinn-network/task-execution-backend-local` as a normal `0.1.0` PRODUCTION dependency + `portal:` resolution (added in the Milestone A kit-slice task, `packages/task-execution/testing/package.json`). backend-local, in turn, consumes the testing package only as a **devDependency** (to run the kit in its own tests). This is the exact evidence-tree precedent — `@jinn-network/evidence-local-runtime → @jinn-network/execution-recorder` as a devDep — and it means the arrows point one way at production scope: there is NO production cycle. The inventory guard's dependency-graph entry records testing → backend-local as a production edge and backend-local → testing as devDependencies-only; the boundaries guard places the slice as a region ABOVE backend-local in the one-way graph.
- **(b) Protocol-owned Delivery sealer (program §7.4).** The sealed Delivery is a TEP document (§13), so the assembly (C1) seals it via the protocol package's exported Delivery sealer — never a backend-local re-implementation. backend-local re-implements canonical bytes (`order.ts` + `canonical-json.ts`, A1) ONLY for its own backend-internal state (resolved LaunchPlan digest, sorted output manifests, journal→observation projections). There is exactly one Delivery sealer in the tree, and it lives in protocol; the equivalence fixtures assert the backend-internal serializer agrees with the tree's UTF-16 code-unit ordering rule, not that it re-derives Delivery bytes.
- **(c) Cross-plan write choreography for the testing package's `./backend-local` slice.** Program §1 assigns the `./backend-local` kit slice to THIS plan even though the `@jinn-network/task-execution-testing` package is owned and created by the TEP plan (which lands the package + the TEP core kit, proven first against the TEP in-memory fake backend). This plan's writes into that package are **append-only**: the Milestone A kit-slice task CREATES new files under `src/backend-local/` + `fixtures/backend-local/`, ADDS the `./backend-local` export + the backend-local production dep to `package.json`, and ADDS the testing → backend-local edge / new subpath to the guard constants — it never mutates TEP-owned kit files. C4 later finalizes `describeLocalBackendContract` in that same slice (the reference impl becomes the TEP core kit's first real consumer). Guard counts are computed against the live guard file at land time, never hardcoded. Rule 3 holds: the slice + guard/CI extensions are the plan's only deliberate cross-plan write, called out per task.
- **(d) Minimal local grant-resolution boundary vs full trust §8.3.** B1's `resolveGrantsToSecrets` implements the MINIMAL local capabilityGrant resolution only: it resolves declared grants into opaque `secrets/` handle files (reference-forwards, never resolved values) — precisely enough for the evaluation harness's evaluator-key signer forward (D3/D4); the same seam serves an adopter's attempt-scoped token forwards in the future adoption pass (Milestone E descope note). The FULL trust §8.3 backend grant-resolution obligations — policy documents replacing allowlists, DSSE convergence, verifier-policy integration — are OUT (program §9 out-of-scope; trust §18 steps 3–8). The boundary this plan freezes: grants resolve to handles under `secrets/` (0700, wiped at terminal), and no grant machinery beyond that handle indirection ships here.

## Program-gate notes (for the coordinator, not tasks)

- **capacity-exhausted** (§5/§20): the TEP follow-up on whether an up-but-full backend earns a dedicated category is recorded in the program doc; v1 rides `backend-unavailable`.
- **Scheme-IRI registration** (D1): the external registration of the `propertyID` IRIs is the ONE shared program follow-up across TEP §28 / profiles §17 / trust §20 — the program doc tracks it once; D1 ships only the constants + normative text.
- **Reserved-URI pre-release checklist**: `evaluation-task/1.0` (+ `repository-work/1.0`) must resolve before external conformance claims — a program-doc pre-release item owned by the profiles plan.
- **Autopilot session sub-profile** (profiles §6.3, deferred): the future adoption pass uses the base `repository-work/1.0` + Submission run-pinning; the stricter session sub-profile is that pass's adapter work.

## Self-review checklist (run before handing off)

1. **Spec coverage** — every design § maps to a task: §5 (C1 lock+capacity), §6.1 (A4), §6.2–§6.6 (A5), §7 (B1/B2), §8 (A2 contract, B3/B4 launchers, B3 result), §9 (C1/C2), §10.1–§10.2 (C3), §10.3–§10.4 (D2–D4), §11.1 (E1), §11.2 (Out of scope), §14 frozen interfaces (cited per task), §15 packages (A1/A2 structure), §16 conformance (A3 + C4), §17 (E1/E2), §18 steps 1–4 (A/B/C/D/E), §18 step 5 (Out of scope), §19/§20 (Out of scope / program-gate notes). F7 evidence amendment → D1.
2. **Placeholder scan** — no "TBD"/"add validation"/"similar to Task N": B4 repeats B3's assertion families in full per harness; each task carries concrete test code or a precise assertion list.
3. **Type consistency** — `LaunchPlan`/`TaskView`/`LauncherContract`/`ProvisionerContract`/`EvidenceBindingPorts`/`CompletedEvaluation`/`EvaluatorRegistration` are defined once (A2/C3/D2) and consumed by name thereafter; `compareCodeUnitStrings`/`serializeCanonical` defined in A1; `mergeRequirements`/`EffectiveRequirements`/`ComparisonClass` are CONSUMED from `@jinn-network/task-execution-protocol` (program §7.3) and never redefined locally — `TaskView.effectiveRequirements` references the protocol type, and C1 runs the merge.
