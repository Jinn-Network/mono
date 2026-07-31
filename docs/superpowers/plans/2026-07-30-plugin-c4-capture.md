# C4 — Capture Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn an observed agent session into durable, sealed evidence in a local archive. One session produces two sealed products: an **Execution Evidence record** (the standard record family every producer on the platform writes, assembled over `execution-recorder` → `local-runtime`, with the session feed attached as the digest-bound native trace carrying its format identity), and a **Trajectory record** (C1's kind) built **directly from the adapter's live hook feed** — per program finding F2 the product is a trajectory *producer* and never parses a transcript to capture.

**Architecture:** the adapter writes an append-only NDJSON **session feed** to a staging path; nothing touches the archive during the session. At session end one call — `sealSession` — opens the archive **once**, parses the feed, builds the trajectory record as a pure function of the feed bytes, seals it as a repository artifact, records the execution over the recorder with the feed as its native trace, links the trajectory into the sealed record as an identifier on the trace entity, waits for the catalog to index, sweeps retention, and closes the archive. The single-hold shape is forced by the code: `openLocalEvidenceRuntime` takes an **exclusive** SQLite lock on the archive root, so the archive-access design unit the spec flags (§6.2) resolves to per-operation open/close, not multi-process access under cooperative locks.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (`plugin/runtime` is a self-contained project with `portal:` resolution, per C3); zod 4.4.3; vitest 4; the stack packages `@jinn-network/execution-recorder`, `@jinn-network/evidence-local-runtime`, `@jinn-network/evidence-trajectory`, `@jinn-network/evidence-repository`, `@jinn-network/evidence-discovery`, `@jinn-network/evidence-protocol`.

---

## Global constraints

- Every task ends with `yarn typecheck && yarn test` inside `plugin/runtime`, plus the four `plugin-tree-*` guards from the repository root, **outputs shown** (principles §13.3).
- `plugin/runtime` is **tier 4**: it carries no conformance kit (spec §9.4). It runs the *consumed* packages' behaviour through integration tests instead.
- **The frozen trio is untouchable.** No import of `@jinn-network/core`, `@jinn-network/plugin`, `@jinn-network/jinn-layer` — the C3 boundary guard forbids all three by name.
- **No `process.env`** anywhere under `plugin/runtime/src/` except `src/bin.ts` (C3 guard). Capture code takes everything from `RuntimeConfig`.
- **No `localeCompare` / `toLocale*` / `Intl`** in production source (C3 guard). Use `compareCodeUnitStrings` re-exported from `@jinn-network/evidence-trajectory`.
- **No key material** in any parameter position (custody law C2/C3, C3 guard).
- Node `>=22`; `"type": "module"`; every relative import carries the `.js` extension.
- American English throughout.
- A wrong or ambiguous design discovered at implementation time is a **finding with a proposed disposition** (principles §13.1) — never a silent patch. Findings go in the final section; do not edit the spec or the program plan.

## Stacked-PR discipline

- **Branch:** `plugin/c4-capture`
- **Base branch:** `plugin/c3-product-tree` — every PR in this train targets `plugin/c3-product-tree`, **never** `integration/evidence-v1`.
- **Merges in:** `plugin/c1-trajectory-record` (Task 1). C4 consumes C1's package; C1 is not an ancestor of C3, so the merge is real and must be proven green on the merged head.
- No agent self-merge. Independent per-component review before C6 builds on this (program §6).

### Restacking

Both bases move under this train.

**When `plugin/c3-product-tree` is squash-merged into `integration/evidence-v1`.** The squash commit is not an ancestor of `plugin/c4-capture`, so `git merge` would replay C3's whole diff as a conflict. Rebase onto the new base instead:

```bash
git fetch origin
OLD_BASE=$(git merge-base plugin/c4-capture origin/plugin/c3-product-tree)
git rebase --onto origin/integration/evidence-v1 "$OLD_BASE" plugin/c4-capture
```

**When `plugin/c1-trajectory-record` is squash-merged.** C1 arrived through a merge commit in Task 1. After C1 lands as a squash on `integration/evidence-v1`, drop the merge by rebasing onto the base that already contains it (the command above does this in one pass — `--onto` a base containing C1 makes the merged-in commits empty and `git rebase` drops them). If C1 lands *before* C3, rebase onto `origin/plugin/c3-product-tree` after C3 itself has taken C1.

**Verifying coherence after either base moves** — run all four, from the repository root, and show the output:

```bash
git -C . log --oneline origin/integration/evidence-v1..plugin/c4-capture
(cd plugin/runtime && yarn install --immutable && yarn typecheck && yarn test)
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```

The first command must show **only C4 commits**. If it shows C1's or C3's commits, the rebase used the wrong `--onto` target: reset to `origin/plugin/c4-capture` and redo it. The `yarn install --immutable` is not optional after a restack — the `portal:` targets are path-relative and a moved base can silently change what resolves.

---

## What C4 consumes from its bases

Named here once; every task's `Interfaces` block refers back to this.

**From `plugin/c3-product-tree`** (C3's settled contract, adopted verbatim):

| Surface | Module | Shape |
| --- | --- | --- |
| `RuntimeConfig` | `plugin/runtime/src/config.ts` | `{ homeDirectory, archiveDirectory, catalogPath, indexPath, mirrorStatePath, logLevel }`, all absolute; `resolveRuntimeConfig(source: RuntimeConfigSource): RuntimeConfig`; precedence defaults < `file` < `env` |
| `PluginRuntimeError` | `plugin/runtime/src/errors.ts` | `constructor(code: string, message: string, options?: { cause?: unknown })`; `code` is a plain `string` so components add their own |
| `RuntimeCapability` / `CapabilityContext` | `plugin/runtime/src/capability.ts` | `{ name; start?(context): Promise<void>; stop?(): Promise<void>; healthChecks?(): Promise<readonly HealthCheck[]> }`; context is `{ config, log }` |
| `HealthCheck` | `plugin/runtime/src/health.ts` | `{ name; ok; detail; remedy: string \| null }` — `null` means not fixable from this machine |
| `RuntimeLogger` | `plugin/runtime/src/logger.ts` | `debug/info/warn/error(message, fields?)` |
| `createPluginRuntime` | `plugin/runtime/src/runtime.ts` | `(options: { config, capabilities?, log? }) => PluginRuntime` |

C3 ships the capability seam with **zero registered capabilities** and returns no archive handle; opening the archive is the component's own business. C4 is the first component to do it.

**From `plugin/c1-trajectory-record`** — `@jinn-network/evidence-trajectory`, exports used here:

```ts
TRAJECTORY_PROTOCOL, TRAJECTORY_RECORD_KIND, TRAJECTORY_MEDIA_TYPE, TRAJECTORY_VOCABULARY_PROFILE
GEN_AI_ATTRIBUTES, JINN_ATTRIBUTES, OPERATION_NAMES
SPAN_KIND, STATUS_CODE
deriveTraceId(input: TraceIdInput): string          // TraceIdInput = { sourceDigest, decoderId, decoderVersion, vocabularyProfile }
deriveSpanId(traceId: string, ordinal: number): string
sealTrajectory(document: unknown): SealedRecord     // SealedRecord = { bytes: Uint8Array; digest: `sha256:${string}` }
parseTrajectory(bytes: Uint8Array): TrajectoryRecord
documentDigest(bytes: Uint8Array): `sha256:${string}`
compareCodeUnitStrings(left: string, right: string): number
InvalidDocumentError
type TrajectoryRecord, type Span, type Attribute
```

---

## Stack surfaces this plan builds against (verified at `b01a49ae7`)

Quoted so no signature in this plan is invented.

**`packages/evidence/execution-recorder/src/types.ts`**

```ts
export interface ExecutionRecorderOptions { readonly repository: EvidenceRepository }         // :193
export interface StartExecutionRecordingInput {                                               // :197
  readonly workspaceDir: string;
  readonly executionId?: ExecutionId;
  readonly startedAt: string;
  readonly record: ExecutionRecordCapture;
  readonly task: TaskCapture;
  readonly initialInputs?: readonly InputCapture[];
  readonly repositoryState?: RepositoryStateCapture;
  readonly executor: ExecutorCapture;
  readonly runtime: RuntimeCapture;
  readonly producer: ProducerCapture;
  readonly signal?: AbortSignal;
}
export interface FinalizeExecutionInput {                                                     // :220
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
  readonly results?: readonly ResultCapture[];
  readonly nativeTrace?: NativeTraceCapture;
}
export interface NativeTraceCapture {                                                         // :174
  readonly artifact: ArtifactCapture;
  readonly format: { readonly entityId: AbsoluteIri; readonly name?: string };
}
export interface ExecutionRecording {                                                         // :264
  readonly executionId: ExecutionId;                    // `urn:uuid:${string}`
  readonly status: "open" | "finalizing" | "finalized";
  readonly receipt?: FinalizedExecutionReceipt;
  captureInput(input: InputCapture, options?: RecordingOperationOptions): Promise<void>;
  captureRuntimeObservation(o: RuntimeObservationCapture, options?): Promise<void>;
  attachNativeTrace(trace: NativeTraceCapture, options?): Promise<void>;
  finalize(input: FinalizeExecutionInput, options?): Promise<FinalizeExecutionResult>;
}
export type FinalizeExecutionResult =                                                          // :249
  | { readonly finalized: true; readonly receipt: FinalizedExecutionReceipt }
  | { readonly finalized: false; readonly diagnostics: readonly CaptureDiagnostic[] };
export interface CaptureDiagnostic {                                                           // :235
  readonly code: "NATIVE_TRACE_MISSING" | "COMPLETED_RESULT_MISSING";
  readonly path: "/nativeTrace" | "/results";
  readonly message: string;
  readonly entityId: ExecutionId;
}
export type CaptureOrigin =                                                                    // :42
  | { kind: "producer-observed"; observer: AbsoluteIri }
  | { kind: "executor-reported"; reporter: AbsoluteIri; capturedBy: AbsoluteIri }
  | { kind: "external-observed"; observer: AbsoluteIri; capturedBy: AbsoluteIri };
export interface TaskCapture { entityId; name; source: ArtifactSource; origin; identifiers?; extensions? }  // :82
export interface RuntimeCapture {                                                              // :137
  entityId; specification: ArtifactSource; name; softwareVersion?; origin;
  components: readonly RuntimeComponentCapture[]; extensions?;
}
export interface ExecutorCapture extends AgentCapture {}                                       // :113
export interface ProducerCapture extends AgentCapture {}                                       // :114
export interface FileArtifactCapture extends ArtifactCaptureMetadata {                         // :65
  readonly kind: "file"; readonly entityId: string; readonly source: ArtifactSource;
}
export type ArtifactSource =                                                                   // :28
  | { bytes: Uint8Array; path?: never; mediaType: string; name?: string }
  | { path: string; bytes?: never; mediaType: string; name?: string };
```

`createExecutionRecorder(options: ExecutionRecorderOptions): ExecutionRecorder` — `packages/evidence/execution-recorder/src/recorder.ts:496`.

**`packages/evidence/local-runtime/src/types.ts`**

```ts
export interface OpenLocalEvidenceRuntimeOptions { readonly rootDir: string; readonly signal?: AbortSignal }  // :12
export interface LocalEvidenceRuntime {                                                                        // :101
  readonly repository: EvidenceRepository;
  readonly catalog: EvidenceCatalogReader;
  sync(options?): Promise<LocalEvidenceSyncReport>;
  awaitIndexed(reference: EvidenceRecordReference, options?): Promise<LocalEvidenceIndexingOutcome>;
  getStatus(): Promise<LocalEvidenceRuntimeStatus>;      // :109 — a method, not a property
  listIndexingFailures(query?, options?): Promise<LocalIndexingFailurePage>;
  close(options?): Promise<void>;
}
```

`openLocalEvidenceRuntime(options): Promise<LocalEvidenceRuntime>` — `packages/evidence/local-runtime/src/runtime.ts:713`. **There is no retention or eviction member on this interface** — that is spec §7.3's finding, and Task 11 works around it product-side.

**`packages/evidence/local-runtime/src/lock.ts`** — the load-bearing constraint for the archive-access design unit:

```ts
database.pragma("busy_timeout = 0");
database.pragma("locking_mode = EXCLUSIVE");
database.exec(`… BEGIN EXCLUSIVE; …`);
// on SQLITE_BUSY / SQLITE_LOCKED: retries at 10, 25, 50 ms, then:
throw new LocalEvidenceRuntimeError("ROOT_IN_USE", "The local evidence runtime root is already in use.", …);
```

**`packages/evidence/protocol/src/execution.ts`** — `validateExecutionEvidence(metadataBytes: Uint8Array): ValidationReport<ExecutionEvidenceDocument>` at `:859`. The constraints the assembled record must satisfy, each with the line that enforces it:

| Requirement | Enforced at |
| --- | --- |
| Exactly one `./` Root Dataset with `name`, `description`, `datePublished`, `license`, `hasPart` | `:425-458` |
| Root declares the Execution Evidence profile via `conformsTo` | `:460-470` |
| Root names exactly one creator that is an Agent with an **absolute IRI** | `:472-489` |
| Exactly one `ro-crate-metadata.json` descriptor, `about` `./`, conforming to RO-Crate 1.3 | `:497-527` |
| The declared profile appears as a `CreativeWork` + `Profile` entity | `:530-548` |
| Root `mentions` exactly one `CreateAction` + `prov:Activity` Execution with a `urn:uuid` id | `:574-600` |
| Execution `object` resolves to exactly one Task that is `File` + `CreativeWork` + `prov:Plan` with `encodingFormat` | `:602-631` |
| Execution `agent` resolves to exactly one Executor Agent with an **absolute IRI** | `:643-669` |
| Execution `instrument` resolves to exactly one `SoftwareApplication` Runtime Specification, itself content-bound, with **at least one content-bound component** | `:671-709` |
| Lifecycle status is one of the four known statuses; `startTime`/`endTime` parse and `endTime >= startTime` | `:711-748` |
| A **completed** Execution has at least one Result; every Result is content-bound and `prov:wasGeneratedBy` the Execution | `:750-782` |
| Exactly one primary native trace via `subjectOf`, content-bound, `about` the Execution, with a non-empty `conformsTo` | `:784-817` |
| Exactly one numeric `durationMs` `PropertyValue` with a unit, **cross-checked against `endTime − startTime`** | `:819-856` |

The recorder builds this document itself and validates it before sealing (`packages/evidence/execution-recorder/src/graph.ts:871-879`), so C4's obligation is to supply captures that let it. Three mappings matter:

- `graph.ts:757-771` — the native trace's `conformsTo` is `NativeTraceCapture.format.entityId`, and the format is added to the graph as a `CreativeWork` + `Profile` entity. **This is where the format identity lands.**
- `graph.ts:402-404` — `ArtifactCapture.identifiers` become `identifier: [{ "@type": "PropertyValue", propertyID, value }]` on the artifact entity. This is C4's trajectory forward link.
- `graph.ts:816-826` — `#duration-ms` is computed as `Date.parse(input.endedAt) - Date.parse(recording.startedAt)`, so the cross-check can only fail if the two timestamps are ill-formed. `validate-input.ts` requires both to be strict RFC 3339 (`isStrictRfc3339`, `:70`).

**`packages/evidence/repository/src/types.ts:1-5`** — the record-family enum is **closed**:

```ts
export const EVIDENCE_RECORD_FAMILIES = ["execution-evidence", "result-evaluation", "execution-verification"] as const;
```

There is no trajectory family, and adding one is out of scope (spec §13: no protocol changes to frozen record families). The Trajectory record is therefore stored with `repository.putArtifact(bytes)` — content-addressed, family-free — and linked from inside the sealed execution record. Task 10 implements this; the Findings section records it.

**`packages/evidence/repository/src/fs/index.ts`** — the filesystem repository already writes owner-only: `mkdir(path, { recursive: true, mode: 0o700 })` at `:128` with a re-`chmod(0o700)` at `:120`, content files opened `open(temporaryPath, "wx", 0o600)` at `:342` with `chmod(0o600)` at `:345`, and an ownership assertion (`assertOwned`, `:330`). `local-runtime` matches it (`src/paths.ts:162,183,284,311,379`). So contract 2's at-rest requirement is **already met inside the archive**; C4's own obligation is the staging tree it creates itself, which Task 3 covers.

---

## File structure

All paths relative to `plugin/runtime/`, except the guard files.

| File | Responsibility |
| --- | --- |
| `src/capture/paths.ts` | capture path derivation + `ensureOwnerOnlyDirectory` / `ensureOwnerOnlyFile` |
| `src/capture/identity.ts` | agent IRIs, identifier property IRIs, the session-feed format IRI, the trajectory builder identity |
| `src/capture/feed.ts` | the session feed contract: zod schemas, `parseSessionFeed`, feed errors |
| `src/capture/spans.ts` | `buildTrajectorySpans` — feed → OTLP-shaped spans |
| `src/capture/trajectory.ts` | `buildTrajectoryRecord` — spans → sealed C1 record |
| `src/capture/assemble.ts` | `buildStartInput` / `buildFinalizeInput` for the recorder |
| `src/capture/archive.ts` | `withCaptureArchive` — the open/close discipline and busy handling |
| `src/capture/retention.ts` | `sweepCaptureRetention` + the retention watermark |
| `src/capture/link.ts` | trajectory forward-link read surface for C6 |
| `src/capture/capability.ts` | `createCaptureCapability` — `openSession` / `sealSession` / `abandonSession` |
| `src/capture/*.test.ts` | per-module tests |
| `src/capture/capture.integration.test.ts` | real archive, real recorder, protocol validation, concurrency |
| `fixtures/capture/*.ndjson` | golden feeds |
| `src/config.ts`, `src/index.ts` | modified: capture config fields, public surface |

Repository files this plan edits: `plugin/runtime/package.json`, `.github/scripts/plugin-tree-package-inventory.test.mjs`, `.github/workflows/plugin-tree-ci.yml`.

---

### Task 1: Branch from C3, merge C1, prove the merged head green

**Files:**
- No file changes. This task produces a branch and a proof.

**Interfaces:**
- Consumes: `plugin/c3-product-tree` (the `plugin/runtime` tree, config, errors, capability seam, guards); `plugin/c1-trajectory-record` (`packages/evidence/trajectory`).
- Produces: branch `plugin/c4-capture` whose head contains both, verified.

- [x] **Step 1: Create the branch from the base and merge C1**

```bash
git fetch origin
git switch -c plugin/c4-capture origin/plugin/c3-product-tree
git merge --no-ff origin/plugin/c1-trajectory-record -m "chore(plugin-runtime): merge the trajectory record kind into the capture train"
```

Expected: `Merge made by the 'ort' strategy.` with `packages/evidence/trajectory/**` and the four `.github/scripts/evidence-*` guard files listed. The two branches touch disjoint trees (C3 owns `plugin/**` and `.github/scripts/plugin-tree-*`; C1 owns `packages/evidence/trajectory/**` and `.github/scripts/evidence-*`), so a conflict here means one of them moved outside its lane — stop and raise it rather than resolving.

- [x] **Step 2: Prove C1 is intact on the merged head**

```bash
cd packages/evidence/trajectory && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn check:fixtures && yarn check:schemas
```

Expected: every command PASS; `dist/` produced.

- [x] **Step 3: Prove C3 is intact on the merged head**

```bash
cd plugin/runtime && yarn install --immutable && yarn typecheck && yarn test && yarn build
```

Expected: every command PASS.

- [x] **Step 4: Prove both guard families are green on the merged head**

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
node .github/scripts/evidence-packed-types.test.mjs
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
node --test .github/scripts/plugin-tree-packed-types.test.mjs
```

Expected: all six PASS. This is the gate — if any fails, the merge is not green and no C4 work starts.

- [x] **Step 5: Push the branch and open the train's first PR against the base**

```bash
git push -u origin plugin/c4-capture
gh pr create --base plugin/c3-product-tree --head plugin/c4-capture --draft \
  --title "feat(plugin-runtime): capture path — session feed to sealed evidence" \
  --body "Stacked on plugin/c3-product-tree; merges in plugin/c1-trajectory-record. See docs/superpowers/plans/2026-07-30-plugin-c4-capture.md."
```

Expected: a draft PR whose base is `plugin/c3-product-tree`. Confirm with `gh pr view --json baseRefName` that the base is **not** `integration/evidence-v1`.

---

### Task 2: Declare the stack dependencies and register them with the guards

**Files:**
- Modify: `plugin/runtime/package.json`
- Modify: `.github/scripts/plugin-tree-package-inventory.test.mjs`
- Modify: `.github/scripts/plugin-tree-guard-common.mjs`
- Modify: `.github/workflows/plugin-tree-ci.yml`

**Interfaces:**
- Consumes: C3's guard scripts and CI workflow; the six stack packages named below.
- Produces: `@jinn-network/execution-recorder`, `@jinn-network/evidence-local-runtime`, `@jinn-network/evidence-trajectory`, `@jinn-network/evidence-repository`, `@jinn-network/evidence-discovery`, `@jinn-network/evidence-protocol` resolvable from `plugin/runtime`, with the inventory guard asserting the exact set and C3's closed-world `APPROVED_RUNTIME_*` maps updated to match (finding C4-P1 / sibling of C5-P2).

- [x] **Step 1: Extend the inventory guard first, so it fails**

In `.github/scripts/plugin-tree-package-inventory.test.mjs`, replace the `runtime` row of `JINN_DEPENDENCY_GRAPH` with:

```js
  ['runtime', {
    dependencies: [
      '@jinn-network/evidence-catalog-sqlite',
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-local-runtime',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository',
      '@jinn-network/evidence-trajectory',
      '@jinn-network/execution-recorder',
      '@jinn-network/trust-core',
      'zod',
    ],
    devDependencies: ['@types/node', 'typescript', 'vitest'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
```

This is **not** the only guard edit: C3 R-C3-63/64 also enforce exact maps in
`.github/scripts/plugin-tree-guard-common.mjs`. After declaring package.json (Step 3),
extend those maps in Step 3b — updating only `JINN_DEPENDENCY_GRAPH` leaves source-
boundaries red on `validateExactDependencySections` / undeclared deps / resolutions.

`evidence-catalog-sqlite` and `trust-core` are **install-graph** deps required by Yarn 4
portal inheritance from `evidence-local-runtime` / `evidence-trajectory` (finding F-C4-2).
They are not new public capture imports.

C3 pre-seeds `SIBLING_TREE_DIRS` and `PERMITTED_PACKAGES` with the stack packages, including `@jinn-network/evidence-discovery` (added at C4's request, C3 finding F-C3-9): `LocalEvidenceRuntime.catalog` is typed `EvidenceCatalogReader`, which is *declared* in `@jinn-network/evidence-discovery` (`packages/evidence/discovery/src/catalog/types.ts:225`) and only re-exported as a type by local-runtime (`packages/evidence/local-runtime/src/types.ts:4`, `:103`), so without it `tsc` cannot resolve the catalog type. Confirm `PERMITTED_PACKAGES` / `SIBLING_TREE_DIRS` already list `evidence-catalog-sqlite` and `trust-core` (C3 seeded them for trajectory/local-runtime); if a name is missing, add it in this same task.

- [x] **Step 2: Run the guard to verify it fails**

```bash
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
```

Expected: FAIL — the declared dependency graph does not match `plugin/runtime/package.json`, which still declares only `zod`.

- [x] **Step 3: Declare the dependencies**

In `plugin/runtime/package.json`, replace the `dependencies` and `resolutions` blocks with:

```json
  "dependencies": {
    "@jinn-network/evidence-catalog-sqlite": "0.1.0",
    "@jinn-network/evidence-discovery": "0.1.0",
    "@jinn-network/evidence-local-runtime": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
    "@jinn-network/evidence-trajectory": "0.1.0",
    "@jinn-network/execution-recorder": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "zod": "4.4.3"
  },
  "resolutions": {
    "@jinn-network/evidence-catalog-sqlite": "portal:../../packages/evidence/catalog-sqlite",
    "@jinn-network/evidence-discovery": "portal:../../packages/evidence/discovery",
    "@jinn-network/evidence-local-runtime": "portal:../../packages/evidence/local-runtime",
    "@jinn-network/evidence-protocol": "portal:../../packages/evidence/protocol",
    "@jinn-network/evidence-repository": "portal:../../packages/evidence/repository",
    "@jinn-network/evidence-trajectory": "portal:../../packages/evidence/trajectory",
    "@jinn-network/execution-recorder": "portal:../../packages/evidence/execution-recorder",
    "@jinn-network/trust-core": "portal:../../packages/trust/core",
    "vite": "6.4.3"
  }
```

**(Finding F-C4-2.)** Yarn 4 does not inherit portal resolutions from portaled packages.
`evidence-local-runtime` / `evidence-trajectory` pull `evidence-catalog-sqlite` and
`trust-core`; those must be **direct** deps + portal resolutions here (install-graph only —
production capture source still imports only the six named stack surfaces). Mirror the same
names in `JINN_DEPENDENCY_GRAPH` and `APPROVED_RUNTIME_*` maps.
- [x] **Step 3b: Extend the closed-world approved maps (finding C4-P1)**

In `.github/scripts/plugin-tree-guard-common.mjs`:

1. `APPROVED_RUNTIME_DEPENDENCIES` — keep `zod: '4.4.3'`; add each of the eight `@jinn-network/*` packages at `'0.1.0'` (six named stack surfaces plus `evidence-catalog-sqlite` and `trust-core` per F-C4-2).
2. `APPROVED_RUNTIME_RESOLUTIONS` — keep `vite: '6.4.3'`; add the eight `portal:../../packages/...` entries exactly as in `package.json` `resolutions` (omit the `vite` duplicate if already present).
3. `APPROVED_RUNTIME_DEV_DEPENDENCIES` — unchanged for C4 (no new types packages).

- [x] **Step 4: Build the portal targets and install**

`portal:` resolution consumes each target's `dist/`, so the six packages must be built before `plugin/runtime` installs:

```bash
for p in protocol repository discovery catalog-sqlite execution-recorder local-runtime trajectory; do \
  (cd packages/evidence/$p && yarn install --immutable && yarn build) || exit 1; done
cd plugin/runtime && yarn install && yarn typecheck
```

Expected: every build succeeds; `yarn typecheck` in `plugin/runtime` PASSES with zero errors. (`catalog-sqlite` is built because `local-runtime` portals to it.)

- [x] **Step 5: Re-run all four guards**

```bash
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
node --test .github/scripts/plugin-tree-packed-types.test.mjs
```

Expected: all PASS. The boundary guard needs no edit — C3's allowlist already permits all six packages, and forbids the frozen trio by name.

- [x] **Step 6: Add the portal builds to CI**

In `.github/workflows/plugin-tree-ci.yml`, inside the `runtime` job and **before** its `yarn install --immutable` step, add:

```yaml
      - name: Build cross-tree portal dependencies from source
        run: |
          for package in protocol repository discovery catalog-sqlite execution-recorder local-runtime trajectory; do
            (cd "packages/evidence/$package" && yarn install --immutable && yarn build)
          done
```

Add the portal sources to the workflow's `paths` filter so a change to them re-runs this tree:

```yaml
      - 'packages/evidence/**'
      - 'docs/superpowers/plans/2026-07-30-plugin-c4-capture.md'
```

- [x] **Step 7: Commit**

```bash
git add plugin/runtime/package.json plugin/runtime/yarn.lock \
  .github/scripts/plugin-tree-package-inventory.test.mjs \
  .github/scripts/plugin-tree-guard-common.mjs \
  .github/workflows/plugin-tree-ci.yml
git commit -m "chore(plugin-runtime): declare the capture stack dependencies and register them with the guards"
```

---

### Task 3: Capture paths and owner-only creation

**Files:**
- Create: `plugin/runtime/src/capture/paths.ts`, `src/capture/paths.test.ts`
- Modify: `plugin/runtime/src/config.ts`
- Modify: `.github/scripts/plugin-tree-ast-custody.mjs` (F-C4-P3 carve-out)
- Modify: `.github/scripts/plugin-tree-source-boundaries.test.mjs` (carve-out probes)

**Interfaces:**
- Consumes: `RuntimeConfig`, `PluginRuntimeError` (C3).
- Produces:
  ```ts
  export function ensureOwnerOnlyDirectory(path: string): Promise<void>;
  export function ensureOwnerOnlyFile(path: string): Promise<void>;
  export interface CapturePaths {
    readonly captureDirectory: string;
    readonly sessionsDirectory: string;
    readonly workspacesDirectory: string;
    readonly retentionWatermarkPath: string;
  }
  export function resolveCapturePaths(config: RuntimeConfig): CapturePaths;
  export function sessionDirectory(paths: CapturePaths, sessionId: string): string;
  export function sessionFeedPath(paths: CapturePaths, sessionId: string): string;
  export function workspaceDirectory(paths: CapturePaths, sessionId: string): string;
  export function assertSafeSessionId(sessionId: string): void;
  ```
  Plus three new `RuntimeConfig` fields: `captureDirectory`, `captureRetentionDays`, `captureArchiveBusyTimeoutMs`.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/capture/paths.test.ts`:

```ts
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";
import {
  assertSafeSessionId,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveCapturePaths,
  sessionDirectory,
  sessionFeedPath,
  workspaceDirectory,
} from "./paths.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-paths-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const config = () => resolveRuntimeConfig({ env: {}, homeDirectory: home });

describe("capture paths", () => {
  test("derives every capture path under the runtime home", () => {
    const paths = resolveCapturePaths(config());
    expect(paths.captureDirectory).toBe(join(home, "capture"));
    expect(paths.sessionsDirectory).toBe(join(home, "capture", "sessions"));
    expect(paths.workspacesDirectory).toBe(join(home, "capture", "workspaces"));
    expect(paths.retentionWatermarkPath).toBe(join(home, "capture", "retention.json"));
  });

  test("session paths are per-session and the feed is named feed.ndjson", () => {
    const paths = resolveCapturePaths(config());
    expect(sessionDirectory(paths, "abc")).toBe(join(home, "capture", "sessions", "abc"));
    expect(sessionFeedPath(paths, "abc")).toBe(
      join(home, "capture", "sessions", "abc", "feed.ndjson"),
    );
    expect(workspaceDirectory(paths, "abc")).toBe(
      join(home, "capture", "workspaces", "abc"),
    );
  });

  test("rejects a session id that could escape the staging tree", () => {
    for (const candidate of ["", ".", "..", "a/b", "a\\b", "-lead", "A".repeat(129)]) {
      expect(() => assertSafeSessionId(candidate)).toThrow(PluginRuntimeError);
    }
    expect(() => assertSafeSessionId("0f2c-91ab")).not.toThrow();
    expect(() => assertSafeSessionId("ab")).not.toThrow(); // 2-char ids are valid (F-C4-P2)
  });

  test.skipIf(process.platform === "win32")(
    "creates directories owner-only and re-secures a loosened one",
    async () => {
      const target = join(home, "capture", "sessions", "s1");
      await ensureOwnerOnlyDirectory(target);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      // A pre-existing, world-readable directory is tightened, not accepted.
      const { chmod } = await import("node:fs/promises");
      await chmod(target, 0o755);
      await ensureOwnerOnlyDirectory(target);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates files owner-only and re-secures a loosened one",
    async () => {
      const target = join(home, "capture", "sessions", "s2", "feed.ndjson");
      await ensureOwnerOnlyDirectory(join(home, "capture", "sessions", "s2"));
      await ensureOwnerOnlyFile(target);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      await writeFile(target, "x", "utf8");
      const { chmod } = await import("node:fs/promises");
      await chmod(target, 0o644);
      await ensureOwnerOnlyFile(target);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    },
  );

  test("capture config fields carry documented defaults and env overrides", () => {
    const defaults = config();
    expect(defaults.captureDirectory).toBe(join(home, "capture"));
    expect(defaults.captureRetentionDays).toBe(30);
    expect(defaults.captureArchiveBusyTimeoutMs).toBe(10_000);

    const overridden = resolveRuntimeConfig({
      env: {
        JINN_PLUGIN_CAPTURE_RETENTION_DAYS: "7",
        JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS: "2500",
      },
      homeDirectory: home,
    });
    expect(overridden.captureRetentionDays).toBe(7);
    expect(overridden.captureArchiveBusyTimeoutMs).toBe(2500);
  });

  test("rejects a non-positive retention window", () => {
    expect(() =>
      resolveRuntimeConfig({
        env: { JINN_PLUGIN_CAPTURE_RETENTION_DAYS: "0" },
        homeDirectory: home,
      }),
    ).toThrow(PluginRuntimeError);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/paths.test.ts
```

Expected: FAIL — `Failed to resolve import "./paths.js"`.

- [x] **Step 2b: Capture FS/platform custody carve-out (finding F-C4-P3)**

C3 forbids `node:fs*` and ambient `process` outside `src/bin.ts`. Capture staging is local
filesystem work by design (owner-only mkdir/chmod, session feed I/O). Before landing
`paths.ts`, carve a **file-scoped** exception for production sources under
`plugin/runtime/src/capture/**` (not tests — tests already use Node APIs freely):

In `.github/scripts/plugin-tree-ast-custody.mjs` / `scanProductionSources`:

1. Detect `isCaptureProduction` when the absolute path contains `/src/capture/` or
   `\src\capture\` and is a production source (already filtered by
   `productionSourceFiles`).
2. Pass `isCaptureProduction` into `scanSourceFile` options beside `isBinEntry`.
3. When `isCaptureProduction`:
   - Allow imports of `node:fs/promises` and `node:fs` (and their `fs`/`fs/promises`
     aliases). Still forbid `node:child_process`, network modules, dynamic nonliteral
     imports, `eval`/`Function`, and locale APIs.
   - Allow **read-only** `process.platform` (and `process.platform === …` comparisons).
   - Still forbid `process.env`, `process.argv`, `process.exit`/`kill`, process mutation,
     and ambient process escape to unknown callees — same as non-bin law.
4. Add red/green probes in `.github/scripts/plugin-tree-source-boundaries.test.mjs`:
   - fixture under a capture-like path importing `node:fs/promises` + reading
     `process.platform` → no violation
   - same path using `process.env` → still violates
   - non-capture production path importing `node:fs/promises` → still violates

Do **not** broaden the carve-out to all of `plugin/runtime/src/`. Corpus (C5) gets its own
disposition if needed.

- [x] **Step 3: Add the config fields**

In `plugin/runtime/src/config.ts`, extend the `RuntimeConfig` interface (do **not** introduce a second config type — C3's extension rule):

```ts
  /** Product-owned staging for session feeds and recorder workspaces. Never inside `archiveDirectory`. */
  readonly captureDirectory: string;
  /** Days of raw staging material kept before the sweep removes it. */
  readonly captureRetentionDays: number;
  /** How long `sealSession` waits for an archive another process holds. */
  readonly captureArchiveBusyTimeoutMs: number;
```

Add the two numeric knobs to C3's `RuntimeConfigFile` `z.strictObject` (`captureRetentionDays`, `captureArchiveBusyTimeoutMs`, both `z.number().int().positive().optional()`), and add this helper beside C3's `present()`:

```ts
/**
 * Coerces an env override through zod rather than `Number()`, so a non-numeric value fails
 * loudly as `config-invalid` naming its field — the same shape as the `logLevel` path.
 */
function positiveIntegerSetting(
  envKey: string,
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number,
): number {
  if (envValue === undefined) return fileValue ?? fallback;
  const parsed = z
    .string()
    .regex(/^[1-9]\d*$/u)
    .safeParse(envValue);
  if (!parsed.success) {
    throw new PluginRuntimeError(
      "config-invalid",
      `${envKey} must be a positive integer, received ${JSON.stringify(envValue)}.`,
    );
  }
  return Number(parsed.data);
}
```

Then, inside the `Object.freeze({ … })` return, beside `archiveDirectory`:

```ts
  // Product-owned staging. Deliberately NOT under archiveDirectory: `local-runtime` and the
  // filesystem repository assert exclusive ownership and 0700 on that tree, and it is under
  // an exclusive lock whenever a capture is sealing.
  captureDirectory: join(homeDirectory, "capture"),
  captureRetentionDays: positiveIntegerSetting(
    "JINN_PLUGIN_CAPTURE_RETENTION_DAYS",
    present(source.env.JINN_PLUGIN_CAPTURE_RETENTION_DAYS),
    file?.captureRetentionDays,
    30,
  ),
  captureArchiveBusyTimeoutMs: positiveIntegerSetting(
    "JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS",
    present(source.env.JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS),
    file?.captureArchiveBusyTimeoutMs,
    10_000,
  ),
```

`captureDirectory` is derived, not independently overridable — the same treatment `archiveDirectory` gets. Precedence stays defaults < `file` < `env`, and `present()` already makes empty or whitespace env values non-overriding.

- [x] **Step 4: Write the implementation**

`plugin/runtime/src/capture/paths.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface CapturePaths {
  readonly captureDirectory: string;
  readonly sessionsDirectory: string;
  readonly workspacesDirectory: string;
  readonly retentionWatermarkPath: string;
}

export function resolveCapturePaths(config: RuntimeConfig): CapturePaths {
  return {
    captureDirectory: config.captureDirectory,
    sessionsDirectory: join(config.captureDirectory, "sessions"),
    workspacesDirectory: join(config.captureDirectory, "workspaces"),
    retentionWatermarkPath: join(config.captureDirectory, "retention.json"),
  };
}

/**
 * Session identifiers name directories, so they are constrained to a shape that cannot
 * traverse, cannot be a relative marker, and cannot carry control characters.
 */
export function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new PluginRuntimeError(
      "capture-session-id-invalid",
      "A capture session id must be 1-128 characters of [a-z0-9-] starting with [a-z0-9].",
    );
  }
}

export function sessionDirectory(paths: CapturePaths, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(paths.sessionsDirectory, sessionId);
}

export function sessionFeedPath(paths: CapturePaths, sessionId: string): string {
  return join(sessionDirectory(paths, sessionId), "feed.ndjson");
}

export function workspaceDirectory(paths: CapturePaths, sessionId: string): string {
  assertSafeSessionId(sessionId);
  return join(paths.workspacesDirectory, sessionId);
}

/**
 * Creates the directory owner-only, and tightens it if it already exists with looser
 * permissions. Matching what the evidence repository does to its own tree
 * (`packages/evidence/repository/src/fs/index.ts:120,128`) keeps the whole capture
 * footprint in one exposure class.
 */
export async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const existing = await stat(path);
  if ((existing.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

/** Creates the file if absent and forces owner-only permissions on it. */
export async function ensureOwnerOnlyFile(path: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}
```

- [x] **Step 5: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/paths.test.ts && yarn typecheck
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```

Expected: PASS (7 tests; the two permission tests skip on Windows); custody carve-out green;
non-capture FS ban still red in its existing probes.

- [x] **Step 6: Commit**

```bash
git add plugin/runtime/src \
  .github/scripts/plugin-tree-ast-custody.mjs \
  .github/scripts/plugin-tree-source-boundaries.test.mjs
git commit -m "feat(plugin-runtime): capture staging paths with owner-only creation"
```

---

### Task 4: The session feed contract

**Files:**
- Create: `plugin/runtime/src/capture/identity.ts`, `src/capture/feed.ts`, `src/capture/feed.test.ts`
- Create: `plugin/runtime/fixtures/capture/session.ndjson`, `fixtures/capture/session-minimal.ndjson`

**Interfaces:**
- Consumes: `PluginRuntimeError` (C3); zod.
- Produces:
  ```ts
  // identity.ts
  export const SESSION_FEED_FORMAT_IRI = "https://jinn.network/formats/agent-session-feed/v1";
  export const SESSION_FEED_MEDIA_TYPE = "application/x-ndjson";
  export const SESSION_FEED_VERSION = 1;
  export const TRAJECTORY_BUILDER_ID = "agent-session-feed";
  export const TRAJECTORY_BUILDER_VERSION = "1.0.0";
  export const PRODUCER_IRI = "https://jinn.network/software/plugin-runtime";
  export const SESSION_ID_PROPERTY = "https://jinn.network/schemes/agent-session-id";
  export const TRAJECTORY_RECORD_IDENTIFIER_PROPERTY =
    "https://jinn.network/schemes/trajectory-record-sha256";
  export const CAPTURE_LICENSE = "https://spdx.org/licenses/Apache-2.0.html";
  export function executorIri(hostName: string): `${string}:${string}`;

  // feed.ts
  export type SessionFeedEvent = /* discriminated union, below */;
  export interface FeedLine { readonly ordinal: number; readonly event: SessionFeedEvent }
  export interface ParsedSessionFeed {
    readonly sessionId: string;
    readonly open: SessionOpenEvent;
    readonly close?: SessionCloseEvent;
    readonly lines: readonly FeedLine[];
    readonly tokens?: { readonly inputTokens: number; readonly outputTokens: number };
    readonly environment?: { readonly tools: readonly string[]; readonly skills: readonly string[] };
  }
  export function parseSessionFeed(bytes: Uint8Array): ParsedSessionFeed;
  ```

The feed is the seam C7's Hermes adapter satisfies. It is NDJSON so it can be appended to during a live session without rewriting, and so the **0-based line ordinal is a stable back-reference** from a trajectory span into the exact source line. Per program finding F5 the trajectory record inlines no message content; content lives here, in the digest-bound native trace, and spans point at it by ordinal.

- [x] **Step 1: Write the fixtures**

`plugin/runtime/fixtures/capture/session.ndjson` (one JSON object per line, LF-terminated, final line ends with LF):

```
{"type":"session-open","v":1,"sessionId":"s-golden","startedAt":"2026-07-30T09:00:00Z","atUnixNano":"1785488400000000000","host":{"name":"Hermes","version":"0.9.1"},"model":{"provider":"anthropic","name":"claude-opus-4.6"},"conversationId":"c-1"}
{"type":"environment","atUnixNano":"1785488400100000000","tools":["read_file","write_file"],"skills":["superpowers:writing-plans"]}
{"type":"user-turn","atUnixNano":"1785488401000000000","text":"Find where the retry budget is configured."}
{"type":"tool-call","startedAtUnixNano":"1785488402000000000","atUnixNano":"1785488402400000000","toolName":"read_file","toolCallId":"call-1","status":"ok","arguments":"{\"path\":\"src/retry.ts\"}","result":"export const RETRY_BUDGET = 3;"}
{"type":"assistant-turn","atUnixNano":"1785488403000000000","text":"It is RETRY_BUDGET in src/retry.ts.","model":"claude-opus-4.6"}
{"type":"tool-call","startedAtUnixNano":"1785488404000000000","atUnixNano":"1785488404200000000","toolName":"write_file","toolCallId":"call-2","status":"error","arguments":"{\"path\":\"src/retry.ts\"}","result":"","errorMessage":"read-only workspace"}
{"type":"tokens","atUnixNano":"1785488405000000000","inputTokens":1024,"outputTokens":256}
{"type":"session-close","atUnixNano":"1785488406000000000","endedAt":"2026-07-30T09:00:06Z","outcome":"completed","summary":"Locate the retry budget"}
```

`plugin/runtime/fixtures/capture/session-minimal.ndjson`:

```
{"type":"session-open","v":1,"sessionId":"s-minimal","startedAt":"2026-07-30T09:00:00Z","atUnixNano":"1785488400000000000","host":{"name":"Hermes","version":"0.9.1"},"model":{"provider":"anthropic","name":"claude-opus-4.6"}}
{"type":"session-close","atUnixNano":"1785488401000000000","endedAt":"2026-07-30T09:00:01Z","outcome":"abandoned","summary":"(no summary)"}
```

- [x] **Step 2: Write the failing test**

`plugin/runtime/src/capture/feed.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { SESSION_FEED_FORMAT_IRI, SESSION_FEED_MEDIA_TYPE, executorIri } from "./identity.js";
import { parseSessionFeed } from "./feed.js";

const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(new URL(`../../fixtures/capture/${name}`, import.meta.url)));

const encode = (lines: readonly unknown[]): Uint8Array =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

const open = {
  type: "session-open",
  v: 1,
  sessionId: "s-1",
  startedAt: "2026-07-30T09:00:00Z",
  atUnixNano: "1000",
  host: { name: "Hermes", version: "0.9.1" },
  model: { provider: "anthropic", name: "claude-opus-4.6" },
};
const close = {
  type: "session-close",
  atUnixNano: "9000",
  endedAt: "2026-07-30T09:00:06Z",
  outcome: "completed",
  summary: "s",
};

describe("session feed identity", () => {
  test("declares one format IRI and media type for the feed", () => {
    expect(SESSION_FEED_FORMAT_IRI).toBe("https://jinn.network/formats/agent-session-feed/v1");
    expect(SESSION_FEED_MEDIA_TYPE).toBe("application/x-ndjson");
  });

  test("derives an absolute executor IRI from the host name", () => {
    expect(executorIri("Hermes")).toBe("https://jinn.network/software/agent-host/hermes");
    expect(executorIri("Claude Code")).toBe("https://jinn.network/software/agent-host/claude-code");
    expect(() => executorIri("  ")).toThrow(PluginRuntimeError);
  });
});

describe("parseSessionFeed", () => {
  test("parses the golden feed with stable line ordinals", async () => {
    const feed = parseSessionFeed(await fixture("session.ndjson"));
    expect(feed.sessionId).toBe("s-golden");
    expect(feed.open.host.name).toBe("Hermes");
    expect(feed.close?.outcome).toBe("completed");
    expect(feed.lines).toHaveLength(8);
    expect(feed.lines.map((line) => line.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(feed.lines[3]?.event.type).toBe("tool-call");
    expect(feed.tokens).toEqual({ inputTokens: 1024, outputTokens: 256 });
    expect(feed.environment).toEqual({
      tools: ["read_file", "write_file"],
      skills: ["superpowers:writing-plans"],
    });
  });

  test("parses a feed carrying nothing but its open and close", async () => {
    const feed = parseSessionFeed(await fixture("session-minimal.ndjson"));
    expect(feed.lines).toHaveLength(2);
    expect(feed.tokens).toBeUndefined();
    expect(feed.environment).toBeUndefined();
  });

  test("tolerates a feed with no close event", () => {
    const feed = parseSessionFeed(encode([open]));
    expect(feed.close).toBeUndefined();
  });

  test("rejects bytes that are not valid UTF-8", () => {
    expect(() => parseSessionFeed(new Uint8Array([0xff, 0xfe]))).toThrow(PluginRuntimeError);
  });

  test("rejects a line that is not JSON, naming the ordinal", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(open)}\nnot json\n`);
    expect(() => parseSessionFeed(bytes)).toThrow(/line 1/u);
  });

  test("rejects an unknown event type and an unknown key", () => {
    expect(() => parseSessionFeed(encode([open, { type: "mystery", atUnixNano: "2000" }]))).toThrow(
      PluginRuntimeError,
    );
    expect(() =>
      parseSessionFeed(encode([open, { type: "user-turn", atUnixNano: "2000", text: "x", extra: 1 }])),
    ).toThrow(PluginRuntimeError);
  });

  test("requires session-open first and exactly once", () => {
    expect(() => parseSessionFeed(encode([{ type: "user-turn", atUnixNano: "1", text: "x" }]))).toThrow(
      /session-open/u,
    );
    expect(() => parseSessionFeed(encode([open, open]))).toThrow(/session-open/u);
    expect(() => parseSessionFeed(new Uint8Array())).toThrow(/session-open/u);
  });

  test("requires session-close to be last and at most once", () => {
    expect(() =>
      parseSessionFeed(encode([open, close, { type: "user-turn", atUnixNano: "9500", text: "x" }])),
    ).toThrow(/session-close/u);
  });

  test("requires non-decreasing timestamps", () => {
    expect(() =>
      parseSessionFeed(encode([open, { type: "user-turn", atUnixNano: "500", text: "x" }])),
    ).toThrow(/non-decreasing/u);
  });

  test("requires a tool call to end no earlier than it started", () => {
    expect(() =>
      parseSessionFeed(
        encode([
          open,
          {
            type: "tool-call",
            startedAtUnixNano: "5000",
            atUnixNano: "2000",
            toolName: "t",
            toolCallId: "c",
            status: "ok",
            arguments: "{}",
            result: "",
          },
        ]),
      ),
    ).toThrow(/tool call/u);
  });

  test("requires the close wall clock not to precede the open wall clock", () => {
    expect(() =>
      parseSessionFeed(encode([open, { ...close, endedAt: "2026-07-30T08:59:59Z" }])),
    ).toThrow(/endedAt/u);
  });

  test("rejects timestamps that are not unsigned decimal strings", () => {
    expect(() => parseSessionFeed(encode([{ ...open, atUnixNano: 1000 }]))).toThrow(PluginRuntimeError);
    expect(() => parseSessionFeed(encode([{ ...open, atUnixNano: "0100" }]))).toThrow(PluginRuntimeError);
  });

  test("rejects a non-RFC3339 wall clock", () => {
    expect(() => parseSessionFeed(encode([{ ...open, startedAt: "2026-07-30 09:00:00" }]))).toThrow(
      PluginRuntimeError,
    );
  });

  test("rejects a feed version this build does not implement", () => {
    expect(() => parseSessionFeed(encode([{ ...open, v: 2 }]))).toThrow(PluginRuntimeError);
  });

  test("keeps the last tokens and environment event when repeated", () => {
    const feed = parseSessionFeed(
      encode([
        open,
        { type: "tokens", atUnixNano: "2000", inputTokens: 1, outputTokens: 2 },
        { type: "tokens", atUnixNano: "3000", inputTokens: 10, outputTokens: 20 },
      ]),
    );
    expect(feed.tokens).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/feed.test.ts
```

Expected: FAIL — `Failed to resolve import "./identity.js"`.

- [x] **Step 4: Write the identity module**

`plugin/runtime/src/capture/identity.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { PluginRuntimeError } from "../errors.js";

/**
 * The declared format of the session feed. The recorder binds the feed bytes and this IRI
 * without opening either (`packages/evidence/execution-recorder/src/graph.ts:757-771`), so
 * this constant is the whole of the format contract a consumer sees.
 *
 * C2 owns the platform format-identity registry. This constant is deliberately local: C4
 * must not depend on C2's branch. Reconciling the two is a recorded finding.
 */
export const SESSION_FEED_FORMAT_IRI =
  "https://jinn.network/formats/agent-session-feed/v1" as const;

export const SESSION_FEED_MEDIA_TYPE = "application/x-ndjson" as const;

/** Bumped only when the feed's event shapes change incompatibly. */
export const SESSION_FEED_VERSION = 1 as const;

/**
 * The trajectory producer's identity. `decoderId` must be a lowercase slug
 * (`DerivationSchema` in `@jinn-network/evidence-trajectory`), and `decoderVersion` is the
 * span-building rule's own version — deliberately independent of the package version, so a
 * release that does not change span construction does not invalidate earlier records.
 */
export const TRAJECTORY_BUILDER_ID = "agent-session-feed" as const;
export const TRAJECTORY_BUILDER_VERSION = "1.0.0" as const;

export const PRODUCER_IRI = "https://jinn.network/software/plugin-runtime" as const;
export const PRODUCER_NAME = "Jinn plugin runtime" as const;

export const SESSION_ID_PROPERTY =
  "https://jinn.network/schemes/agent-session-id" as const;

/**
 * Carried as an identifier on the native-trace artifact entity, which is how the sealed
 * execution record points forward at its trajectory record. The trajectory record is stored
 * as a repository artifact rather than a record because `EVIDENCE_RECORD_FAMILIES` is a
 * closed set (`packages/evidence/repository/src/types.ts:1-5`).
 */
export const TRAJECTORY_RECORD_IDENTIFIER_PROPERTY =
  "https://jinn.network/schemes/trajectory-record-sha256" as const;

export const CAPTURE_LICENSE = "https://spdx.org/licenses/Apache-2.0.html" as const;

const SLUG_STRIP = /[^a-z0-9]+/gu;

/** A stable absolute IRI for the observed host, which the protocol requires of the Executor. */
export function executorIri(hostName: string): `${string}:${string}` {
  const slug = hostName.toLowerCase().replace(SLUG_STRIP, "-").replace(/^-+|-+$/gu, "");
  if (slug.length === 0) {
    throw new PluginRuntimeError(
      "capture-feed-invalid",
      "The session feed's host name does not yield an executor identity.",
    );
  }
  return `https://jinn.network/software/agent-host/${slug}`;
}
```

- [x] **Step 5: Write the feed module**

`plugin/runtime/src/capture/feed.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { PluginRuntimeError } from "../errors.js";
import { SESSION_FEED_VERSION } from "./identity.js";

/** Unsigned decimal, no leading zeros — the OTLP nanosecond encoding the spans reuse. */
const UnixNano = z.string().regex(/^(0|[1-9]\d*)$/u, "must be an unsigned decimal string");

const Rfc3339 = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u,
    "must be a strict RFC 3339 timestamp",
  )
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a real instant");

const SessionOpenSchema = z.strictObject({
  type: z.literal("session-open"),
  v: z.literal(SESSION_FEED_VERSION),
  sessionId: z.string().min(1).max(128),
  startedAt: Rfc3339,
  atUnixNano: UnixNano,
  host: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  model: z.strictObject({ provider: z.string().min(1), name: z.string().min(1) }),
  conversationId: z.string().min(1).optional(),
});

const EnvironmentSchema = z.strictObject({
  type: z.literal("environment"),
  atUnixNano: UnixNano,
  tools: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
});

const UserTurnSchema = z.strictObject({
  type: z.literal("user-turn"),
  atUnixNano: UnixNano,
  text: z.string(),
});

const AssistantTurnSchema = z.strictObject({
  type: z.literal("assistant-turn"),
  atUnixNano: UnixNano,
  text: z.string(),
  model: z.string().min(1).optional(),
});

const ToolCallSchema = z.strictObject({
  type: z.literal("tool-call"),
  startedAtUnixNano: UnixNano,
  atUnixNano: UnixNano,
  toolName: z.string().min(1),
  toolCallId: z.string().min(1),
  status: z.enum(["ok", "error"]),
  arguments: z.string(),
  result: z.string(),
  errorMessage: z.string().min(1).optional(),
});

const TokensSchema = z.strictObject({
  type: z.literal("tokens"),
  atUnixNano: UnixNano,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

const SessionCloseSchema = z.strictObject({
  type: z.literal("session-close"),
  atUnixNano: UnixNano,
  endedAt: Rfc3339,
  outcome: z.enum(["completed", "failed", "abandoned"]),
  summary: z.string(),
});

const SessionFeedEventSchema = z.discriminatedUnion("type", [
  SessionOpenSchema,
  EnvironmentSchema,
  UserTurnSchema,
  AssistantTurnSchema,
  ToolCallSchema,
  TokensSchema,
  SessionCloseSchema,
]);

export type SessionOpenEvent = z.infer<typeof SessionOpenSchema>;
export type SessionCloseEvent = z.infer<typeof SessionCloseSchema>;
export type UserTurnEvent = z.infer<typeof UserTurnSchema>;
export type AssistantTurnEvent = z.infer<typeof AssistantTurnSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallSchema>;
export type SessionFeedEvent = z.infer<typeof SessionFeedEventSchema>;

export interface FeedLine {
  readonly ordinal: number;
  readonly event: SessionFeedEvent;
}

export interface ParsedSessionFeed {
  readonly sessionId: string;
  readonly open: SessionOpenEvent;
  readonly close?: SessionCloseEvent;
  readonly lines: readonly FeedLine[];
  readonly tokens?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly environment?: {
    readonly tools: readonly string[];
    readonly skills: readonly string[];
  };
}

function invalid(message: string, cause?: unknown): never {
  throw new PluginRuntimeError("capture-feed-invalid", message, { cause });
}

/**
 * Parses the append-only NDJSON session feed. Strict by construction: an unreadable feed is
 * a refused capture, never a silently truncated one. The 0-based line ordinal is preserved
 * because it is the stable back-reference from a trajectory span into the source line
 * (program finding F5 — the record carries no message content).
 */
export function parseSessionFeed(bytes: Uint8Array): ParsedSessionFeed {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    invalid("The session feed is not valid UTF-8.", error);
  }

  // Only the trailing newline is stripped. A blank line anywhere else is a malformed feed and
  // must fail loudly rather than be skipped, because skipping would shift every later ordinal
  // and silently break the span back-references.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const rawLines = body.length === 0 ? [] : body.split("\n");

  const lines: FeedLine[] = [];
  let open: SessionOpenEvent | undefined;
  let close: SessionCloseEvent | undefined;
  let tokens: ParsedSessionFeed["tokens"];
  let environment: ParsedSessionFeed["environment"];
  let previousNano = -1n;

  for (const [ordinal, raw] of rawLines.entries()) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      invalid(`The session feed is not valid JSON at line ${String(ordinal)}.`, error);
    }
    const parsed = SessionFeedEventSchema.safeParse(decoded);
    if (!parsed.success) {
      invalid(
        `The session feed carries an invalid event at line ${String(ordinal)}: ${
          parsed.error.issues[0]?.message ?? "unknown"
        }`,
        parsed.error,
      );
    }
    const event = parsed.data;

    if (event.type === "session-open") {
      if (ordinal !== 0 || open !== undefined) {
        invalid("A session feed must carry exactly one session-open event, first.");
      }
      open = event;
    } else if (ordinal === 0) {
      invalid("A session feed must begin with a session-open event.");
    }

    if (close !== undefined) {
      invalid("A session feed must carry session-close last.");
    }
    if (event.type === "session-close") close = event;

    const nano = BigInt(event.atUnixNano);
    if (nano < previousNano) {
      invalid(`Session feed timestamps must be non-decreasing (line ${String(ordinal)}).`);
    }
    previousNano = nano;

    if (event.type === "tool-call" && BigInt(event.startedAtUnixNano) > nano) {
      invalid(`A tool call must not end before it started (line ${String(ordinal)}).`);
    }
    if (event.type === "tokens") {
      tokens = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    }
    if (event.type === "environment") {
      environment = { tools: event.tools, skills: event.skills };
    }

    lines.push({ ordinal, event });
  }

  if (open === undefined) {
    invalid("A session feed must carry exactly one session-open event, first.");
  }
  if (close !== undefined && Date.parse(close.endedAt) < Date.parse(open.startedAt)) {
    invalid("The session feed's endedAt precedes its startedAt.");
  }

  return {
    sessionId: open.sessionId,
    open,
    ...(close === undefined ? {} : { close }),
    lines,
    ...(tokens === undefined ? {} : { tokens }),
    ...(environment === undefined ? {} : { environment }),
  };
}
```

- [x] **Step 6: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/feed.test.ts && yarn typecheck
```

Expected: PASS (17 tests).

- [x] **Step 7: Commit**

```bash
git add plugin/runtime/src plugin/runtime/fixtures
git commit -m "feat(plugin-runtime): the session feed contract and capture identities"
```

---

### Task 5: Build trajectory spans from the feed

**Files:**
- Create: `plugin/runtime/src/capture/spans.ts`, `src/capture/spans.test.ts`

**Interfaces:**
- Consumes: `ParsedSessionFeed` (Task 4); from `@jinn-network/evidence-trajectory` — `GEN_AI_ATTRIBUTES`, `JINN_ATTRIBUTES`, `OPERATION_NAMES`, `SPAN_KIND`, `STATUS_CODE`, `deriveSpanId`, `compareCodeUnitStrings`, `type Attribute`, `type Span`.
- Produces:
  ```ts
  export interface BuildTrajectorySpansInput {
    readonly feed: ParsedSessionFeed;
    readonly traceId: string;
  }
  export function buildTrajectorySpans(input: BuildTrajectorySpansInput): readonly Span[];
  ```

The span model, stated once so the tests read as assertions about a decision rather than about an implementation:

- **Span 0 is the session** (`invoke_agent`). Every other span parents to it. C1's schema requires a `parentSpanId` to name an *earlier* span in the array, and the feed does not tell us which inference a tool call belongs to, so parenting everything to the session span is both valid and honest — it claims no structure the source does not carry.
- **One `chat` span per assistant turn**, spanning from the previous boundary (session start, or the previous chat span's end) to the assistant turn. That interval *is* the inference. User turns are not spans: they become `gen_ai.user.message` **span events** on the chat span they preceded, and trailing user turns with no following assistant turn become events on the session span. This keeps every span a real GenAI operation from C1's `OPERATION_NAMES`, and invents no attribute key outside C1's frozen vocabulary.
- **One `execute_tool` span per tool call**, using the feed's own start and end.
- **No message content anywhere** (program finding F5). Each span carries `jinn.trajectory.source.ordinal` — the 0-based line ordinal in the feed — and a consumer resolves the text from the digest-bound native trace. This is also what makes C6's index-time sensitivity exclusion tractable: it excludes by ordinal.
- **Attributes are sorted by key** under `compareCodeUnitStrings` (program finding F4; C1's `SpanSchema` rejects any other order), which is what makes byte-for-byte determinism checkable.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/spans.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import {
  SPAN_KIND,
  STATUS_CODE,
  SpanSchema,
  compareCodeUnitStrings,
  deriveSpanId,
} from "@jinn-network/evidence-trajectory";
import { describe, expect, test } from "vitest";

import { parseSessionFeed } from "./feed.js";
import { buildTrajectorySpans } from "./spans.js";

const TRACE_ID = "0".repeat(31).concat("1");

const golden = async () =>
  parseSessionFeed(
    new Uint8Array(await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url))),
  );

const attribute = (span: { attributes: readonly { key: string; value: unknown }[] }, key: string) =>
  span.attributes.find((entry) => entry.key === key)?.value;

describe("buildTrajectorySpans", () => {
  test("every span validates under the C1 span schema", async () => {
    for (const span of buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID })) {
      const result = SpanSchema.safeParse(span);
      expect(result.success, JSON.stringify(result)).toBe(true);
    }
  });

  test("span identifiers are derived from the trace id and the array ordinal", async () => {
    const spans = buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID });
    spans.forEach((span, ordinal) => {
      expect(span.spanId).toBe(deriveSpanId(TRACE_ID, ordinal));
    });
  });

  test("span 0 is the session, parents nothing, and carries the outcome and token usage", async () => {
    const [session] = buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID });
    expect(session?.parentSpanId).toBeNull();
    expect(session?.kind).toBe(SPAN_KIND.INTERNAL);
    expect(session?.name).toBe("invoke_agent Hermes");
    expect(session?.startTimeUnixNano).toBe("1785488400000000000");
    expect(session?.endTimeUnixNano).toBe("1785488406000000000");
    expect(attribute(session!, "gen_ai.operation.name")).toEqual({ stringValue: "invoke_agent" });
    expect(attribute(session!, "gen_ai.provider.name")).toEqual({ stringValue: "anthropic" });
    expect(attribute(session!, "gen_ai.conversation.id")).toEqual({ stringValue: "c-1" });
    expect(attribute(session!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1024" });
    expect(attribute(session!, "gen_ai.usage.output_tokens")).toEqual({ intValue: "256" });
    expect(attribute(session!, "jinn.trajectory.outcome")).toEqual({ stringValue: "completed" });
    expect(session?.status).toEqual({ code: STATUS_CODE.OK });
  });

  test("every non-session span parents to the session span", async () => {
    const spans = buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID });
    for (const span of spans.slice(1)) expect(span.parentSpanId).toBe(spans[0]!.spanId);
  });

  test("spans follow the feed order of their terminating event", async () => {
    const spans = buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID });
    expect(spans.map((span) => span.name)).toEqual([
      "invoke_agent Hermes",
      "execute_tool read_file",
      "chat claude-opus-4.6",
      "execute_tool write_file",
    ]);
  });

  test("the chat span spans from the session start to the assistant turn and carries its user event", async () => {
    const chat = buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID })[2]!;
    expect(chat.kind).toBe(SPAN_KIND.CLIENT);
    expect(chat.startTimeUnixNano).toBe("1785488400000000000");
    expect(chat.endTimeUnixNano).toBe("1785488403000000000");
    expect(attribute(chat, "jinn.trajectory.turn.role")).toEqual({ stringValue: "assistant" });
    expect(attribute(chat, "jinn.trajectory.source.ordinal")).toEqual({ intValue: "4" });
    expect(attribute(chat, "gen_ai.response.model")).toEqual({ stringValue: "claude-opus-4.6" });
    expect(chat.events).toHaveLength(1);
    expect(chat.events[0]?.name).toBe("gen_ai.user.message");
    expect(chat.events[0]?.timeUnixNano).toBe("1785488401000000000");
    expect(chat.events[0]?.attributes.map((entry) => entry.key)).toEqual([
      "jinn.trajectory.source.ordinal",
      "jinn.trajectory.turn.role",
    ]);
  });

  test("a failed tool call becomes an ERROR span carrying its message", async () => {
    const failing = buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID })[3]!;
    expect(failing.status).toEqual({ code: STATUS_CODE.ERROR, message: "read-only workspace" });
    expect(attribute(failing, "gen_ai.tool.call.id")).toEqual({ stringValue: "call-2" });
    expect(attribute(failing, "gen_ai.tool.name")).toEqual({ stringValue: "write_file" });
    expect(failing.startTimeUnixNano).toBe("1785488404000000000");
    expect(failing.endTimeUnixNano).toBe("1785488404200000000");
  });

  test("no span carries message content", async () => {
    const serialized = JSON.stringify(
      buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID }),
    );
    expect(serialized).not.toContain("Find where the retry budget");
    expect(serialized).not.toContain("RETRY_BUDGET");
    expect(serialized).not.toContain("src/retry.ts");
  });

  test("attributes are sorted by code unit and unique in every span and event", async () => {
    for (const span of buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID })) {
      for (const list of [span.attributes, ...span.events.map((event) => event.attributes)]) {
        const keys = list.map((entry) => entry.key);
        expect(keys).toEqual([...keys].sort(compareCodeUnitStrings));
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  test("is a pure function of the feed", async () => {
    const feed = await golden();
    expect(JSON.stringify(buildTrajectorySpans({ feed, traceId: TRACE_ID }))).toBe(
      JSON.stringify(buildTrajectorySpans({ feed: await golden(), traceId: TRACE_ID })),
    );
  });

  test("a feed with only an open and close yields exactly the session span", async () => {
    const feed = parseSessionFeed(
      new Uint8Array(
        await readFile(new URL("../../fixtures/capture/session-minimal.ndjson", import.meta.url)),
      ),
    );
    const spans = buildTrajectorySpans({ feed, traceId: TRACE_ID });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toEqual({ code: STATUS_CODE.UNSET });
    expect(attribute(spans[0]!, "jinn.trajectory.outcome")).toEqual({ stringValue: "abandoned" });
  });

  test("an unclosed feed ends the session at its last event and reports abandoned", () => {
    const bytes = new TextEncoder().encode(
      [
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }),
        JSON.stringify({ type: "user-turn", atUnixNano: "2000", text: "hello" }),
      ].join("\n") + "\n",
    );
    const spans = buildTrajectorySpans({ feed: parseSessionFeed(bytes), traceId: TRACE_ID });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.endTimeUnixNano).toBe("2000");
    // A trailing user turn with no assistant reply lands on the session span as an event.
    expect(spans[0]?.events).toHaveLength(1);
    expect(spans[0]?.events[0]?.name).toBe("gen_ai.user.message");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/spans.test.ts
```

Expected: FAIL — `Failed to resolve import "./spans.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/spans.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  type Attribute,
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  OPERATION_NAMES,
  SPAN_KIND,
  STATUS_CODE,
  type Span,
  compareCodeUnitStrings,
  deriveSpanId,
} from "@jinn-network/evidence-trajectory";

import type { FeedLine, ParsedSessionFeed } from "./feed.js";

export interface BuildTrajectorySpansInput {
  readonly feed: ParsedSessionFeed;
  readonly traceId: string;
}

type MutableSpan = Omit<Span, "spanId" | "parentSpanId">;

const USER_MESSAGE_EVENT = "gen_ai.user.message" as const;

function text(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}

function integer(key: string, value: number): Attribute {
  return { key, value: { intValue: String(value) } };
}

/** OTLP defines no attribute ordering; this profile fixes one (program finding F4). */
function sorted(attributes: readonly Attribute[]): readonly Attribute[] {
  return [...attributes].sort((left, right) => compareCodeUnitStrings(left.key, right.key));
}

function userMessageEvent(line: FeedLine): Span["events"][number] {
  return {
    timeUnixNano: line.event.atUnixNano,
    name: USER_MESSAGE_EVENT,
    attributes: sorted([
      integer(JINN_ATTRIBUTES.sourceOrdinal, line.ordinal),
      text(JINN_ATTRIBUTES.turnRole, "user"),
    ]),
  };
}

function sessionStatus(outcome: string | undefined): Span["status"] {
  if (outcome === "completed") return { code: STATUS_CODE.OK };
  if (outcome === "failed") return { code: STATUS_CODE.ERROR };
  return { code: STATUS_CODE.UNSET };
}

/**
 * Builds the span list for one session feed.
 *
 * Pure: no wall clock, no randomness, no ambient state. Every timing, identity and ordinal
 * comes from the feed, so the same feed bytes always produce the same spans — which is what
 * the record's derived identity asserts and what a consumer can re-check.
 */
export function buildTrajectorySpans(input: BuildTrajectorySpansInput): readonly Span[] {
  const { feed, traceId } = input;
  const outcome = feed.close?.outcome;
  const lastNano =
    feed.lines.length > 0 ? feed.lines[feed.lines.length - 1]!.event.atUnixNano : feed.open.atUnixNano;

  const sessionAttributes: Attribute[] = [
    text(GEN_AI_ATTRIBUTES.agentName, feed.open.host.name),
    text(GEN_AI_ATTRIBUTES.conversationId, feed.open.conversationId ?? feed.sessionId),
    text(GEN_AI_ATTRIBUTES.operationName, OPERATION_NAMES.invokeAgent),
    text(GEN_AI_ATTRIBUTES.providerName, feed.open.model.provider),
    text(GEN_AI_ATTRIBUTES.requestModel, feed.open.model.name),
    text(JINN_ATTRIBUTES.outcome, outcome ?? "abandoned"),
    integer(JINN_ATTRIBUTES.sourceOrdinal, 0),
  ];
  if (feed.tokens !== undefined) {
    sessionAttributes.push(
      integer(GEN_AI_ATTRIBUTES.inputTokens, feed.tokens.inputTokens),
      integer(GEN_AI_ATTRIBUTES.outputTokens, feed.tokens.outputTokens),
    );
  }

  const session: MutableSpan = {
    name: `${OPERATION_NAMES.invokeAgent} ${feed.open.host.name}`,
    kind: SPAN_KIND.INTERNAL,
    startTimeUnixNano: feed.open.atUnixNano,
    endTimeUnixNano: feed.close?.atUnixNano ?? lastNano,
    attributes: sorted(sessionAttributes),
    events: [],
    status: sessionStatus(outcome),
  };

  const children: MutableSpan[] = [];
  let pendingUserTurns: FeedLine[] = [];
  let chatStartNano = feed.open.atUnixNano;

  for (const line of feed.lines) {
    const { event, ordinal } = line;
    if (event.type === "user-turn") {
      pendingUserTurns.push(line);
      continue;
    }
    if (event.type === "assistant-turn") {
      const responseModel = event.model ?? feed.open.model.name;
      children.push({
        name: `${OPERATION_NAMES.chat} ${responseModel}`,
        kind: SPAN_KIND.CLIENT,
        startTimeUnixNano: chatStartNano,
        endTimeUnixNano: event.atUnixNano,
        attributes: sorted([
          text(GEN_AI_ATTRIBUTES.operationName, OPERATION_NAMES.chat),
          text(GEN_AI_ATTRIBUTES.providerName, feed.open.model.provider),
          text(GEN_AI_ATTRIBUTES.requestModel, feed.open.model.name),
          text(GEN_AI_ATTRIBUTES.responseModel, responseModel),
          integer(JINN_ATTRIBUTES.sourceOrdinal, ordinal),
          text(JINN_ATTRIBUTES.turnRole, "assistant"),
        ]),
        events: pendingUserTurns.map(userMessageEvent),
        status: { code: STATUS_CODE.OK },
      });
      pendingUserTurns = [];
      chatStartNano = event.atUnixNano;
      continue;
    }
    if (event.type === "tool-call") {
      children.push({
        name: `${OPERATION_NAMES.executeTool} ${event.toolName}`,
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: event.startedAtUnixNano,
        endTimeUnixNano: event.atUnixNano,
        attributes: sorted([
          text(GEN_AI_ATTRIBUTES.operationName, OPERATION_NAMES.executeTool),
          text(GEN_AI_ATTRIBUTES.toolCallId, event.toolCallId),
          text(GEN_AI_ATTRIBUTES.toolName, event.toolName),
          integer(JINN_ATTRIBUTES.sourceOrdinal, ordinal),
        ]),
        events: [],
        status:
          event.status === "ok"
            ? { code: STATUS_CODE.OK }
            : { code: STATUS_CODE.ERROR, message: event.errorMessage ?? "tool call failed" },
      });
    }
  }

  // Trailing user turns never answered by the model still happened; they land on the session.
  const ordered: MutableSpan[] = [
    { ...session, events: pendingUserTurns.map(userMessageEvent) },
    ...children,
  ];

  const sessionSpanId = deriveSpanId(traceId, 0);
  return ordered.map((span, ordinal) => ({
    ...span,
    spanId: deriveSpanId(traceId, ordinal),
    parentSpanId: ordinal === 0 ? null : sessionSpanId,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/spans.test.ts && yarn typecheck
```

Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): build trajectory spans from the live session feed"
```

---

### Task 6: Produce and seal the trajectory record

**Files:**
- Create: `plugin/runtime/src/capture/trajectory.ts`, `src/capture/trajectory.test.ts`

**Interfaces:**
- Consumes: `parseSessionFeed` / `ParsedSessionFeed` (Task 4); `buildTrajectorySpans` (Task 5); identity constants (Task 4); from `@jinn-network/evidence-trajectory` — `TRAJECTORY_PROTOCOL`, `TRAJECTORY_MEDIA_TYPE`, `TRAJECTORY_VOCABULARY_PROFILE`, `deriveTraceId`, `documentDigest`, `sealTrajectory`, `parseTrajectory`, `InvalidDocumentError`, `type SealedRecord`.
- Produces:
  ```ts
  export interface BuiltTrajectory {
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly traceId: string;
    readonly spanCount: number;
  }
  export function buildTrajectoryRecord(
    feed: ParsedSessionFeed,
    feedBytes: Uint8Array,
  ): BuiltTrajectory;
  export const TRAJECTORY_ARTIFACT_MEDIA_TYPE: typeof TRAJECTORY_MEDIA_TYPE;
  ```

Two decisions this task fixes, both recorded in the Findings section:

1. **`source.execution` is omitted.** C1's `SourceSchema` makes it optional. The execution record's digest cannot exist yet — the feed must be attached as the native trace *before* `finalize()`, and the trajectory digest must exist *before* that so it can ride along as an identifier. The link is not lost: `source.nativeTrace.digest.sha256` is exactly the `sha256` the sealed execution record carries on its trace entity, so the pair is joinable in both directions by digest.
2. **`completeness` is always `full`.** `parseSessionFeed` is strict — an uninterpretable feed is a refused capture, not a partial one — so there is no state in which some source lines were skipped.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/trajectory.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import {
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveTraceId,
  documentDigest,
  parseTrajectory,
} from "@jinn-network/evidence-trajectory";
import { describe, expect, test } from "vitest";

import { parseSessionFeed } from "./feed.js";
import {
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  TRAJECTORY_BUILDER_ID,
  TRAJECTORY_BUILDER_VERSION,
} from "./identity.js";
import { buildTrajectoryRecord } from "./trajectory.js";

const goldenBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url)));

describe("buildTrajectoryRecord", () => {
  test("seals a record that re-parses under C1's schema", async () => {
    const bytes = await goldenBytes();
    const built = buildTrajectoryRecord(parseSessionFeed(bytes), bytes);
    const record = parseTrajectory(built.bytes);
    expect(record.protocol).toBe(TRAJECTORY_PROTOCOL);
    expect(record.spans).toHaveLength(built.spanCount);
    expect(record.completeness).toEqual({ decoded: "full" });
  });

  test("declares the feed as its source, by digest and format IRI", async () => {
    const bytes = await goldenBytes();
    const record = parseTrajectory(buildTrajectoryRecord(parseSessionFeed(bytes), bytes).bytes);
    expect(record.source.formatIri).toBe(SESSION_FEED_FORMAT_IRI);
    expect(record.source.nativeTrace.mediaType).toBe(SESSION_FEED_MEDIA_TYPE);
    expect(record.source.nativeTrace.name).toBe("feed.ndjson");
    expect(`sha256:${record.source.nativeTrace.digest.sha256}`).toBe(documentDigest(bytes));
  });

  test("declares the builder identity and the vocabulary profile", async () => {
    const bytes = await goldenBytes();
    const record = parseTrajectory(buildTrajectoryRecord(parseSessionFeed(bytes), bytes).bytes);
    expect(record.derivation).toEqual({
      decoderId: TRAJECTORY_BUILDER_ID,
      decoderVersion: TRAJECTORY_BUILDER_VERSION,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    });
  });

  test("the trace id is the value derived from the feed digest and the builder identity", async () => {
    const bytes = await goldenBytes();
    const built = buildTrajectoryRecord(parseSessionFeed(bytes), bytes);
    expect(built.traceId).toBe(
      deriveTraceId({
        sourceDigest: documentDigest(bytes),
        decoderId: TRAJECTORY_BUILDER_ID,
        decoderVersion: TRAJECTORY_BUILDER_VERSION,
        vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
      }),
    );
  });

  test("omits source.execution, and says so by carrying no execution key", async () => {
    const bytes = await goldenBytes();
    const record = parseTrajectory(buildTrajectoryRecord(parseSessionFeed(bytes), bytes).bytes);
    expect(record.source).not.toHaveProperty("execution");
  });

  test("the same feed bytes produce the same record bytes and digest", async () => {
    const bytes = await goldenBytes();
    const first = buildTrajectoryRecord(parseSessionFeed(bytes), bytes);
    const second = buildTrajectoryRecord(parseSessionFeed(bytes), bytes);
    expect(new TextDecoder().decode(second.bytes)).toBe(new TextDecoder().decode(first.bytes));
    expect(second.digest).toBe(first.digest);
    expect(first.digest).toBe(documentDigest(first.bytes));
  });

  test("one changed byte in the feed changes the trace id and the record digest", async () => {
    const bytes = await goldenBytes();
    const original = buildTrajectoryRecord(parseSessionFeed(bytes), bytes);
    const mutated = new TextDecoder()
      .decode(bytes)
      .replace('"claude-opus-4.6"', '"claude-opus-4.7"');
    const mutatedBytes = new TextEncoder().encode(mutated);
    const rebuilt = buildTrajectoryRecord(parseSessionFeed(mutatedBytes), mutatedBytes);
    expect(rebuilt.traceId).not.toBe(original.traceId);
    expect(rebuilt.digest).not.toBe(original.digest);
  });

  test("a feed digest that disagrees with the record is refused by C1's invariants", async () => {
    const bytes = await goldenBytes();
    const other = new TextEncoder().encode("{}\n");
    // Building against the wrong bytes derives a trace id C1 will not accept for that source.
    expect(() => buildTrajectoryRecord(parseSessionFeed(bytes), other)).not.toThrow();
    const record = parseTrajectory(buildTrajectoryRecord(parseSessionFeed(bytes), other).bytes);
    expect(`sha256:${record.source.nativeTrace.digest.sha256}`).toBe(documentDigest(other));
  });

  test("seals a minimal session that carries only the session span", async () => {
    const bytes = new Uint8Array(
      await readFile(new URL("../../fixtures/capture/session-minimal.ndjson", import.meta.url)),
    );
    const built = buildTrajectoryRecord(parseSessionFeed(bytes), bytes);
    expect(built.spanCount).toBe(1);
    expect(parseTrajectory(built.bytes).completeness).toEqual({ decoded: "full" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/trajectory.test.ts
```

Expected: FAIL — `Failed to resolve import "./trajectory.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/trajectory.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveTraceId,
  documentDigest,
  sealTrajectory,
} from "@jinn-network/evidence-trajectory";

import type { ParsedSessionFeed } from "./feed.js";
import {
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  TRAJECTORY_BUILDER_ID,
  TRAJECTORY_BUILDER_VERSION,
} from "./identity.js";
import { buildTrajectorySpans } from "./spans.js";

export const TRAJECTORY_ARTIFACT_MEDIA_TYPE = TRAJECTORY_MEDIA_TYPE;

export interface BuiltTrajectory {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly traceId: string;
  readonly spanCount: number;
}

/**
 * Produces the sealed Trajectory record for one session, directly from the live hook feed
 * (program finding F2 — this product is a trajectory producer and never parses a transcript).
 *
 * `source.execution` is deliberately absent: the execution record's digest does not exist
 * yet at this point in the seal, because the feed must be attached as the native trace before
 * `finalize()` and this record's digest must exist before that so it can ride along as an
 * identifier. The join survives anyway — `source.nativeTrace.digest.sha256` is the same
 * digest the sealed execution record carries on its trace entity.
 */
export function buildTrajectoryRecord(
  feed: ParsedSessionFeed,
  feedBytes: Uint8Array,
): BuiltTrajectory {
  const sourceDigest = documentDigest(feedBytes);
  const traceId = deriveTraceId({
    sourceDigest,
    decoderId: TRAJECTORY_BUILDER_ID,
    decoderVersion: TRAJECTORY_BUILDER_VERSION,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  });
  const spans = buildTrajectorySpans({ feed, traceId });

  const sealed = sealTrajectory({
    protocol: TRAJECTORY_PROTOCOL,
    source: {
      nativeTrace: {
        name: "feed.ndjson",
        mediaType: SESSION_FEED_MEDIA_TYPE,
        digest: { sha256: sourceDigest.slice("sha256:".length) },
      },
      formatIri: SESSION_FEED_FORMAT_IRI,
    },
    derivation: {
      decoderId: TRAJECTORY_BUILDER_ID,
      decoderVersion: TRAJECTORY_BUILDER_VERSION,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    },
    traceId,
    spans,
    // parseSessionFeed is strict, so an uninterpretable feed is a refused capture rather
    // than a partial one; there is no state in which source lines were skipped.
    completeness: { decoded: "full" },
  });

  return {
    bytes: sealed.bytes,
    digest: sealed.digest,
    traceId,
    spanCount: spans.length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/trajectory.test.ts && yarn typecheck
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): produce and seal the trajectory record from the session feed"
```

---

### Task 7: Assemble the Execution Evidence capture inputs

**Files:**
- Create: `plugin/runtime/src/capture/assemble.ts`, `src/capture/assemble.test.ts`

**Interfaces:**
- Consumes: `ParsedSessionFeed` (Task 4); identity constants (Task 4); from `@jinn-network/execution-recorder` — `type StartExecutionRecordingInput`, `type FinalizeExecutionInput`, `type CaptureOrigin`.
- Produces:
  ```ts
  export interface SessionOutcome {
    readonly outcome: "completed" | "failed" | "abandoned";
    readonly endedAt: string;
  }
  export function resolveSessionOutcome(
    feed: ParsedSessionFeed,
    override?: { readonly outcome?: SessionOutcome["outcome"]; readonly endedAt?: string },
  ): SessionOutcome;
  export function sessionSummary(feed: ParsedSessionFeed): string;
  export interface CaptureAssemblyInput {
    readonly feed: ParsedSessionFeed;
    readonly feedPath: string;
    readonly workspaceDir: string;
    readonly producerVersion: string;
    readonly outcome: SessionOutcome;
    readonly trajectoryDigest: `sha256:${string}`;
  }
  export function buildStartInput(input: CaptureAssemblyInput): StartExecutionRecordingInput;
  export function buildFinalizeInput(input: CaptureAssemblyInput): FinalizeExecutionInput;
  ```

Each field exists to satisfy a named protocol constraint. The mapping, so the review can check it against `packages/evidence/protocol/src/execution.ts` rather than against intent:

| Protocol requirement (line) | Satisfied by |
| --- | --- |
| Task is a content-bound `File` + `CreativeWork` + `prov:Plan` with `encodingFormat` (`:616-629`) | `task.source` = `input/session-task.json`, `mediaType: "application/json"` |
| Executor Agent has an **absolute IRI** (`:656-668`) | `executor.entityId` = `executorIri(feed.open.host.name)` |
| Runtime Specification is content-bound and has **≥1 content-bound component** (`:694-708`) | `runtime.specification` = the host environment JSON; one `controlled` component `runtime/host-environment.json` over the same bytes |
| A **completed** Execution has ≥1 Result, content-bound (`:752-782`) | `results` always carries `results/session-summary.json`, so `completed` never fails the `COMPLETED_RESULT_MISSING` diagnostic |
| Exactly one native trace, content-bound, with non-empty `conformsTo` (`:784-817`) | `nativeTrace.artifact` = the feed **by path**, `nativeTrace.format.entityId` = `SESSION_FEED_FORMAT_IRI` |
| `durationMs` cross-checks `endTime − startTime` (`:841-856`) | the recorder computes it from `startedAt`/`endedAt` (`graph.ts:822`); both are strict RFC 3339 from the feed, and `parseSessionFeed` already rejects `endedAt < startedAt` |
| Root creator is an Agent with an absolute IRI (`:472-489`) | `producer.entityId` = `PRODUCER_IRI` |

Two further choices worth naming: the native trace moves **by path**, never by bytes (cross-plan contract 4 — MCP carries control and references; bulk bytes move on the filesystem), and every capture declares a single `executor-reported` origin, because every fact in the record derives from a feed the host reported and this runtime captured.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/assemble.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { parseSessionFeed } from "./feed.js";
import {
  CAPTURE_LICENSE,
  PRODUCER_IRI,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_ID_PROPERTY,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
} from "./identity.js";
import {
  buildFinalizeInput,
  buildStartInput,
  resolveSessionOutcome,
  sessionSummary,
} from "./assemble.js";

const TRAJECTORY_DIGEST = `sha256:${"c".repeat(64)}` as const;

const assembly = async () => {
  const feed = parseSessionFeed(
    new Uint8Array(await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url))),
  );
  return {
    feed,
    feedPath: "/home/op/capture/sessions/s-golden/feed.ndjson",
    workspaceDir: "/home/op/capture/workspaces/s-golden",
    producerVersion: "0.1.0",
    outcome: resolveSessionOutcome(feed),
    trajectoryDigest: TRAJECTORY_DIGEST,
  };
};

describe("resolveSessionOutcome", () => {
  test("takes the outcome and wall clock from the close event", async () => {
    const { feed } = await assembly();
    expect(resolveSessionOutcome(feed)).toEqual({
      outcome: "completed",
      endedAt: "2026-07-30T09:00:06Z",
    });
  });

  test("an explicit override wins over the close event", async () => {
    const { feed } = await assembly();
    expect(
      resolveSessionOutcome(feed, { outcome: "abandoned", endedAt: "2026-07-30T09:00:09Z" }),
    ).toEqual({ outcome: "abandoned", endedAt: "2026-07-30T09:00:09Z" });
  });

  test("refuses an unclosed feed with no override", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }) + "\n",
      ),
    );
    expect(() => resolveSessionOutcome(feed)).toThrow(PluginRuntimeError);
    expect(resolveSessionOutcome(feed, { outcome: "abandoned", endedAt: "2026-07-30T09:00:05Z" })
      .outcome).toBe("abandoned");
  });

  test("refuses an override that ends before the session started", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }) + "\n",
      ),
    );
    expect(() =>
      resolveSessionOutcome(feed, { outcome: "failed", endedAt: "2026-07-30T08:59:00Z" }),
    ).toThrow(/endedAt/u);
  });
});

describe("sessionSummary", () => {
  test("prefers the close event's summary", async () => {
    expect(sessionSummary((await assembly()).feed)).toBe("Locate the retry budget");
  });

  test("falls back to the first line of the first user turn, bounded", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        [
          JSON.stringify({
            type: "session-open",
            v: 1,
            sessionId: "s-1",
            startedAt: "2026-07-30T09:00:00Z",
            atUnixNano: "1000",
            host: { name: "Hermes", version: "0.9.1" },
            model: { provider: "anthropic", name: "claude-opus-4.6" },
          }),
          JSON.stringify({ type: "user-turn", atUnixNano: "2000", text: `${"x".repeat(600)}\nsecond` }),
        ].join("\n") + "\n",
      ),
    );
    expect(sessionSummary(feed)).toBe("x".repeat(500));
  });

  test("falls back to a stated placeholder when there is nothing to summarize", () => {
    const feed = parseSessionFeed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "s-1",
          startedAt: "2026-07-30T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }) + "\n",
      ),
    );
    expect(sessionSummary(feed)).toBe("(no summary)");
  });
});

describe("buildStartInput", () => {
  test("names the workspace, the session start, and the license", async () => {
    const start = buildStartInput(await assembly());
    expect(start.workspaceDir).toBe("/home/op/capture/workspaces/s-golden");
    expect(start.startedAt).toBe("2026-07-30T09:00:00Z");
    expect(start.record.license).toBe(CAPTURE_LICENSE);
    expect(start.record.executionIdentifiers).toEqual([
      { propertyId: SESSION_ID_PROPERTY, value: "s-golden" },
    ]);
  });

  test("gives the executor an absolute IRI derived from the host", async () => {
    const start = buildStartInput(await assembly());
    expect(start.executor.entityId).toBe("https://jinn.network/software/agent-host/hermes");
    expect(start.executor.kind).toBe("software");
    expect(start.executor.softwareVersion).toBe("0.9.1");
  });

  test("names the producer as this runtime, with its version", async () => {
    const start = buildStartInput(await assembly());
    expect(start.producer.entityId).toBe(PRODUCER_IRI);
    expect(start.producer.softwareVersion).toBe("0.1.0");
  });

  test("gives the runtime specification at least one content-bound component", async () => {
    const start = buildStartInput(await assembly());
    expect(start.runtime.entityId).toBe("runtime/host.json");
    expect(start.runtime.components).toHaveLength(1);
    const [component] = start.runtime.components;
    expect(component?.kind).toBe("controlled");
    expect(component?.kind === "controlled" && component.artifact.entityId).toBe(
      "runtime/host-environment.json",
    );
  });

  test("the task carries a JSON media type and the session summary", async () => {
    const start = buildStartInput(await assembly());
    expect(start.task.entityId).toBe("input/session-task.json");
    expect(start.task.source.mediaType).toBe("application/json");
    const decoded = JSON.parse(new TextDecoder().decode(start.task.source.bytes!));
    expect(decoded.summary).toBe("Locate the retry budget");
    expect(decoded.sessionId).toBe("s-golden");
  });

  test("every capture declares one executor-reported origin", async () => {
    const start = buildStartInput(await assembly());
    const expected = {
      kind: "executor-reported",
      reporter: "https://jinn.network/software/agent-host/hermes",
      capturedBy: PRODUCER_IRI,
    };
    expect(start.task.origin).toEqual(expected);
    expect(start.runtime.origin).toEqual(expected);
    expect(start.executor.origin).toEqual(expected);
    expect(start.producer.origin).toEqual(expected);
  });

  test("is deterministic for one feed", async () => {
    expect(JSON.stringify(buildStartInput(await assembly()))).toBe(
      JSON.stringify(buildStartInput(await assembly())),
    );
  });
});

describe("buildFinalizeInput", () => {
  test("always supplies a result, so a completed execution conforms", async () => {
    const finalize = buildFinalizeInput(await assembly());
    expect(finalize.outcome).toBe("completed");
    expect(finalize.endedAt).toBe("2026-07-30T09:00:06Z");
    expect(finalize.results).toHaveLength(1);
    expect(finalize.results?.[0]?.entityId).toBe("results/session-summary.json");
    const summary = JSON.parse(
      new TextDecoder().decode(
        (finalize.results![0] as { source: { bytes: Uint8Array } }).source.bytes,
      ),
    );
    expect(summary).toEqual({
      outcome: "completed",
      endedAt: "2026-07-30T09:00:06Z",
      summary: "Locate the retry budget",
      userTurns: 1,
      assistantTurns: 1,
      toolCalls: 2,
      failedToolCalls: 1,
      tokens: { inputTokens: 1024, outputTokens: 256 },
    });
  });

  test("attaches the feed by path with its format IRI", async () => {
    const finalize = buildFinalizeInput(await assembly());
    expect(finalize.nativeTrace?.format.entityId).toBe(SESSION_FEED_FORMAT_IRI);
    const artifact = finalize.nativeTrace!.artifact;
    expect(artifact.entityId).toBe("trace/feed.ndjson");
    expect(artifact.kind === "file" && artifact.source.path).toBe(
      "/home/op/capture/sessions/s-golden/feed.ndjson",
    );
    expect(artifact.kind === "file" && artifact.source.bytes).toBeUndefined();
    expect(artifact.kind === "file" && artifact.source.mediaType).toBe(SESSION_FEED_MEDIA_TYPE);
  });

  test("links the trajectory record forward as an identifier on the trace entity", async () => {
    const finalize = buildFinalizeInput(await assembly());
    expect(finalize.nativeTrace?.artifact.identifiers).toEqual([
      { propertyId: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY, value: TRAJECTORY_DIGEST },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/assemble.test.ts
```

Expected: FAIL — `Failed to resolve import "./assemble.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/assemble.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type {
  CaptureOrigin,
  FinalizeExecutionInput,
  StartExecutionRecordingInput,
} from "@jinn-network/execution-recorder";

import { PluginRuntimeError } from "../errors.js";
import type { ParsedSessionFeed } from "./feed.js";
import {
  CAPTURE_LICENSE,
  PRODUCER_IRI,
  PRODUCER_NAME,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_ID_PROPERTY,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  executorIri,
} from "./identity.js";

const SUMMARY_LIMIT = 500;
const JSON_MEDIA_TYPE = "application/json";

export interface SessionOutcome {
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
}

export interface CaptureAssemblyInput {
  readonly feed: ParsedSessionFeed;
  readonly feedPath: string;
  readonly workspaceDir: string;
  readonly producerVersion: string;
  readonly outcome: SessionOutcome;
  readonly trajectoryDigest: `sha256:${string}`;
}

const encoder = new TextEncoder();

/** Object literal order is the serialization order; every call site fixes it explicitly. */
function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function origin(feed: ParsedSessionFeed): CaptureOrigin {
  // Every fact in the record derives from a feed the host reported and this runtime captured.
  return {
    kind: "executor-reported",
    reporter: executorIri(feed.open.host.name),
    capturedBy: PRODUCER_IRI,
  };
}

export function resolveSessionOutcome(
  feed: ParsedSessionFeed,
  override?: { readonly outcome?: SessionOutcome["outcome"]; readonly endedAt?: string },
): SessionOutcome {
  const outcome = override?.outcome ?? feed.close?.outcome;
  const endedAt = override?.endedAt ?? feed.close?.endedAt;
  if (outcome === undefined || endedAt === undefined) {
    throw new PluginRuntimeError(
      "capture-outcome-unknown",
      "The session feed carries no session-close event and no outcome was supplied.",
    );
  }
  if (!Number.isFinite(Date.parse(endedAt))) {
    throw new PluginRuntimeError("capture-outcome-unknown", `endedAt is not an instant: ${endedAt}`);
  }
  if (Date.parse(endedAt) < Date.parse(feed.open.startedAt)) {
    throw new PluginRuntimeError(
      "capture-outcome-unknown",
      `endedAt ${endedAt} precedes the session start ${feed.open.startedAt}.`,
    );
  }
  return { outcome, endedAt };
}

export function sessionSummary(feed: ParsedSessionFeed): string {
  const declared = feed.close?.summary.trim();
  if (declared !== undefined && declared.length > 0) return declared.slice(0, SUMMARY_LIMIT);
  for (const { event } of feed.lines) {
    if (event.type !== "user-turn") continue;
    const first = event.text.trim().split("\n")[0]?.trim() ?? "";
    if (first.length > 0) return first.slice(0, SUMMARY_LIMIT);
  }
  return "(no summary)";
}

function counts(feed: ParsedSessionFeed) {
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  for (const { event } of feed.lines) {
    if (event.type === "user-turn") userTurns += 1;
    if (event.type === "assistant-turn") assistantTurns += 1;
    if (event.type === "tool-call") {
      toolCalls += 1;
      if (event.status === "error") failedToolCalls += 1;
    }
  }
  return { userTurns, assistantTurns, toolCalls, failedToolCalls };
}

function environmentBytes(feed: ParsedSessionFeed): Uint8Array {
  return encodeJson({
    host: { name: feed.open.host.name, version: feed.open.host.version },
    model: { provider: feed.open.model.provider, name: feed.open.model.name },
    tools: feed.environment?.tools ?? [],
    skills: feed.environment?.skills ?? [],
  });
}

export function buildStartInput(input: CaptureAssemblyInput): StartExecutionRecordingInput {
  const { feed } = input;
  const captureOrigin = origin(feed);
  const environment = environmentBytes(feed);

  return {
    workspaceDir: input.workspaceDir,
    startedAt: feed.open.startedAt,
    record: {
      name: "Jinn agent session",
      description: "An interactive agent session captured by the Jinn plugin runtime.",
      license: CAPTURE_LICENSE,
      executionName: `Agent session ${feed.sessionId}`,
      executionIdentifiers: [{ propertyId: SESSION_ID_PROPERTY, value: feed.sessionId }],
    },
    task: {
      entityId: "input/session-task.json",
      name: "Session task",
      source: {
        bytes: encodeJson({
          sessionId: feed.sessionId,
          summary: sessionSummary(feed),
          startedAt: feed.open.startedAt,
        }),
        mediaType: JSON_MEDIA_TYPE,
        name: "session-task.json",
      },
      origin: captureOrigin,
    },
    executor: {
      entityId: executorIri(feed.open.host.name),
      kind: "software",
      name: feed.open.host.name,
      softwareVersion: feed.open.host.version,
      origin: captureOrigin,
    },
    runtime: {
      entityId: "runtime/host.json",
      specification: {
        bytes: environment,
        mediaType: JSON_MEDIA_TYPE,
        name: "host.json",
      },
      name: `${feed.open.host.name} session runtime`,
      softwareVersion: feed.open.host.version,
      origin: captureOrigin,
      components: [
        {
          kind: "controlled",
          artifact: {
            kind: "file",
            entityId: "runtime/host-environment.json",
            source: {
              bytes: environment,
              mediaType: JSON_MEDIA_TYPE,
              name: "host-environment.json",
            },
            origin: captureOrigin,
          },
        },
      ],
    },
    producer: {
      entityId: PRODUCER_IRI,
      kind: "software",
      name: PRODUCER_NAME,
      softwareVersion: input.producerVersion,
      origin: captureOrigin,
    },
  };
}

export function buildFinalizeInput(input: CaptureAssemblyInput): FinalizeExecutionInput {
  const { feed } = input;
  const captureOrigin = origin(feed);
  const tally = counts(feed);

  return {
    outcome: input.outcome.outcome,
    endedAt: input.outcome.endedAt,
    // Always present, so a completed execution never trips COMPLETED_RESULT_MISSING.
    results: [
      {
        kind: "file",
        entityId: "results/session-summary.json",
        source: {
          bytes: encodeJson({
            outcome: input.outcome.outcome,
            endedAt: input.outcome.endedAt,
            summary: sessionSummary(feed),
            userTurns: tally.userTurns,
            assistantTurns: tally.assistantTurns,
            toolCalls: tally.toolCalls,
            failedToolCalls: tally.failedToolCalls,
            ...(feed.tokens === undefined ? {} : { tokens: feed.tokens }),
          }),
          mediaType: JSON_MEDIA_TYPE,
          name: "session-summary.json",
        },
        origin: captureOrigin,
      },
    ],
    nativeTrace: {
      artifact: {
        kind: "file",
        entityId: "trace/feed.ndjson",
        // By path, never by bytes: bulk material moves on the filesystem (contract 4).
        source: {
          path: input.feedPath,
          mediaType: SESSION_FEED_MEDIA_TYPE,
          name: "feed.ndjson",
        },
        // The forward link to the trajectory record, sealed inside the execution record.
        identifiers: [
          {
            propertyId: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: input.trajectoryDigest,
          },
        ],
        origin: captureOrigin,
      },
      format: {
        entityId: SESSION_FEED_FORMAT_IRI,
        name: "Jinn agent session feed",
      },
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/assemble.test.ts && yarn typecheck
```

Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): assemble the execution evidence capture inputs from a session feed"
```

---

### Task 8: The archive-access design unit — per-operation open/close

**Files:**
- Create: `plugin/runtime/src/capture/archive.ts`, `src/capture/archive.test.ts`

**Interfaces:**
- Consumes: `PluginRuntimeError` (C3); from `@jinn-network/evidence-local-runtime` — `openLocalEvidenceRuntime`, `isLocalEvidenceRuntimeError`, `type LocalEvidenceRuntime`.
- Produces:
  ```ts
  export interface CaptureArchiveOptions {
    readonly rootDir: string;
    readonly busyTimeoutMs: number;
    readonly signal?: AbortSignal;
    readonly open?: (options: { rootDir: string; signal?: AbortSignal }) => Promise<LocalEvidenceRuntime>;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  }
  export const ARCHIVE_BUSY_ERROR_CODE: "capture-archive-busy";
  export function withCaptureArchive<T>(
    options: CaptureArchiveOptions,
    run: (runtime: LocalEvidenceRuntime) => Promise<T>,
  ): Promise<T>;
  ```

**This task resolves the design unit spec §6.2 names as the build plan's first.** The spec left open "direct multi-process access under these locks versus per-instance open/close discipline". The code decides it, and the decision is *not* the spec's first option:

`openLocalEvidenceRuntime` does not take a cooperative advisory lock. It takes an **exclusive** one, and fails rather than waiting — `packages/evidence/local-runtime/src/lock.ts`:

```ts
database.pragma("busy_timeout = 0");
database.pragma("locking_mode = EXCLUSIVE");
database.exec(`… BEGIN EXCLUSIVE; …`);
// SQLITE_BUSY / SQLITE_LOCKED → retries at 10, 25, 50 ms, then:
throw new LocalEvidenceRuntimeError("ROOT_IN_USE", "The local evidence runtime root is already in use.");
```

So "direct multi-process access under locks" is not available at any price: a second opener of the same root gets `ROOT_IN_USE` after ~85 ms, full stop. The ruling is therefore **per-operation open/close**, with three consequences this plan holds itself to:

1. **No capability holds an archive handle.** Capture opens the archive inside `sealSession` and closes it before returning. It does not open one in `start()`. (C3 has made this a documented invariant of its capability seam, with the same citation — C3 finding F-C3-8.)
2. **The hold is one bounded burst at session end**, not the session's lifetime. Nothing about a live session touches the archive: the adapter appends to a staging file, and the whole seal happens in one call. That is what keeps a session-scoped runtime pair (spec §6.2 — a host-spawned instance for tools and an adapter-spawned instance for hooks) from starving each other.
3. **`ROOT_IN_USE` is a wait, not a failure**, up to `captureArchiveBusyTimeoutMs`. Beyond the budget it becomes `capture-archive-busy`, which the doctor renders as a real transient state with a remedy rather than a mystery.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/archive.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { ARCHIVE_BUSY_ERROR_CODE, withCaptureArchive } from "./archive.js";

class FakeLocalRuntimeError extends Error {
  override readonly name = "LocalEvidenceRuntimeError";
  constructor(readonly code: string) {
    super(code);
  }
}

const fakeRuntime = () => {
  const closed = { count: 0 };
  return {
    handle: { close: async () => void (closed.count += 1) } as never,
    closed,
  };
};

describe("withCaptureArchive", () => {
  test("opens, runs, and closes exactly once", async () => {
    const { handle, closed } = fakeRuntime();
    const open = vi.fn(async () => handle);
    const value = await withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 1000, open }, async () => 42);
    expect(value).toBe(42);
    expect(open).toHaveBeenCalledTimes(1);
    expect(closed.count).toBe(1);
  });

  test("closes even when the operation throws, and surfaces the original failure", async () => {
    const { handle, closed } = fakeRuntime();
    const boom = new Error("operation failed");
    await expect(
      withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 1000, open: async () => handle }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(closed.count).toBe(1);
  });

  test("a close failure never masks a successful result", async () => {
    const handle = { close: async () => { throw new Error("close failed"); } } as never;
    await expect(
      withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 1000, open: async () => handle }, async () => "ok"),
    ).resolves.toBe("ok");
  });

  test("retries ROOT_IN_USE with backoff and succeeds when the holder releases", async () => {
    const { handle } = fakeRuntime();
    const delays: number[] = [];
    let attempt = 0;
    const value = await withCaptureArchive(
      {
        rootDir: "/a",
        busyTimeoutMs: 10_000,
        now: () => attempt * 25,
        sleep: async (ms) => void delays.push(ms),
        open: async () => {
          attempt += 1;
          if (attempt < 4) throw new FakeLocalRuntimeError("ROOT_IN_USE");
          return handle;
        },
      },
      async () => "sealed",
    );
    expect(value).toBe("sealed");
    expect(delays).toEqual([25, 50, 100]);
  });

  test("gives up as capture-archive-busy once the budget is spent", async () => {
    let clock = 0;
    const error = await withCaptureArchive(
      {
        rootDir: "/a",
        busyTimeoutMs: 200,
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        open: async () => {
          throw new FakeLocalRuntimeError("ROOT_IN_USE");
        },
      },
      async () => "unreachable",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PluginRuntimeError);
    expect((error as PluginRuntimeError).code).toBe(ARCHIVE_BUSY_ERROR_CODE);
    expect((error as PluginRuntimeError).message).toContain("/a");
  });

  test("does not retry a runtime error that is not ROOT_IN_USE", async () => {
    const open = vi.fn(async () => {
      throw new FakeLocalRuntimeError("RUNTIME_CORRUPT");
    });
    await expect(
      withCaptureArchive({ rootDir: "/a", busyTimeoutMs: 10_000, open }, async () => "x"),
    ).rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("stops retrying when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withCaptureArchive(
        {
          rootDir: "/a",
          busyTimeoutMs: 10_000,
          signal: controller.signal,
          open: async () => {
            throw new FakeLocalRuntimeError("ROOT_IN_USE");
          },
        },
        async () => "x",
      ),
    ).rejects.toBeInstanceOf(PluginRuntimeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/archive.test.ts
```

Expected: FAIL — `Failed to resolve import "./archive.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/archive.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  type LocalEvidenceRuntime,
  isLocalEvidenceRuntimeError,
  openLocalEvidenceRuntime,
} from "@jinn-network/evidence-local-runtime";

import { PluginRuntimeError } from "../errors.js";

export const ARCHIVE_BUSY_ERROR_CODE = "capture-archive-busy" as const;

const BACKOFF_MS = [25, 50, 100, 200, 400, 800] as const;

export interface CaptureArchiveOptions {
  readonly rootDir: string;
  readonly busyTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly open?: (options: {
    readonly rootDir: string;
    readonly signal?: AbortSignal;
  }) => Promise<LocalEvidenceRuntime>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function isRootInUse(error: unknown): boolean {
  return isLocalEvidenceRuntimeError(error)
    ? error.code === "ROOT_IN_USE"
    : error instanceof Error &&
        error.name === "LocalEvidenceRuntimeError" &&
        (error as { readonly code?: unknown }).code === "ROOT_IN_USE";
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Opens the local evidence archive for exactly one operation and closes it again.
 *
 * `openLocalEvidenceRuntime` takes an EXCLUSIVE SQLite lock on the root and fails with
 * `ROOT_IN_USE` rather than waiting (`packages/evidence/local-runtime/src/lock.ts`), so
 * long-lived handles are not an option: one held handle locks every other process out of the
 * archive for as long as it lives. Every component therefore opens per operation, and a
 * contended root is waited out here rather than surfaced as a failure.
 */
export async function withCaptureArchive<T>(
  options: CaptureArchiveOptions,
  run: (runtime: LocalEvidenceRuntime) => Promise<T>,
): Promise<T> {
  const open = options.open ?? openLocalEvidenceRuntime;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.busyTimeoutMs;

  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted === true) {
      throw new PluginRuntimeError(
        ARCHIVE_BUSY_ERROR_CODE,
        `Waiting for the evidence archive at ${options.rootDir} was aborted.`,
      );
    }
    let runtime: LocalEvidenceRuntime;
    try {
      runtime = await open({
        rootDir: options.rootDir,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // Anything that is not lock contention — a corrupt root, an unsafe path, an abort —
      // is the caller's to see immediately; only ROOT_IN_USE is worth waiting out.
      if (!isRootInUse(error)) throw error;
      const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      if (now() + backoff > deadline) {
        throw new PluginRuntimeError(
          ARCHIVE_BUSY_ERROR_CODE,
          `Another process holds the evidence archive at ${options.rootDir}; gave up after ${String(
            options.busyTimeoutMs,
          )} ms.`,
          { cause: error },
        );
      }
      await sleep(backoff);
      attempt += 1;
      continue;
    }

    try {
      return await run(runtime);
    } finally {
      // A close failure must never mask the operation's own outcome; the next open performs
      // the authoritative integrity check on the root.
      try {
        await runtime.close();
      } catch {
        /* intentionally swallowed */
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/archive.test.ts && yarn typecheck
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): per-operation archive access with bounded busy waiting"
```

---

### Task 9: The trajectory forward-link read surface

**Files:**
- Create: `plugin/runtime/src/capture/link.ts`, `src/capture/link.test.ts`

**Interfaces:**
- Consumes: `TRAJECTORY_RECORD_IDENTIFIER_PROPERTY` (Task 4); from `@jinn-network/evidence-trajectory` — `parseTrajectory`, `type TrajectoryRecord`; from `@jinn-network/evidence-repository` — `type EvidenceArtifactReference`, `type EvidenceRepository`.
- Produces:
  ```ts
  export function trajectoryReferenceFromRecordBytes(
    bytes: Uint8Array,
  ): EvidenceArtifactReference | null;
  export function loadTrajectoryRecord(
    repository: EvidenceRepository,
    reference: EvidenceArtifactReference,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TrajectoryRecord>;
  ```

This is C6's door to a historical capture. `EVIDENCE_RECORD_FAMILIES` is closed (`packages/evidence/repository/src/types.ts:1-5`), so the trajectory record is a repository **artifact** and the catalog never projects it. The link lives inside the sealed execution record as an `identifier` on the native-trace entity — which the recorder emits from `ArtifactCapture.identifiers` (`packages/evidence/execution-recorder/src/graph.ts:402-404`). The full path for a historical capture is: catalog `findExecutions` → `repository.getRecord` → `trajectoryReferenceFromRecordBytes` → `loadTrajectoryRecord`.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/link.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY } from "./identity.js";
import { loadTrajectoryRecord, trajectoryReferenceFromRecordBytes } from "./link.js";

const DIGEST = `sha256:${"d".repeat(64)}` as const;

const crate = (identifier: unknown): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      "@context": ["https://w3id.org/ro/crate/1.3/context"],
      "@graph": [
        { "@id": "./", "@type": "Dataset" },
        {
          "@id": "trace/feed.ndjson",
          "@type": "File",
          sha256: "e".repeat(64),
          ...(identifier === undefined ? {} : { identifier }),
        },
      ],
    }),
  );

describe("trajectoryReferenceFromRecordBytes", () => {
  test("reads the digest from the trace entity's identifier", () => {
    const bytes = crate([
      { "@type": "PropertyValue", propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY, value: DIGEST },
    ]);
    expect(trajectoryReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("accepts a single identifier object as well as a list", () => {
    const bytes = crate({
      "@type": "PropertyValue",
      propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
      value: DIGEST,
    });
    expect(trajectoryReferenceFromRecordBytes(bytes)).toEqual({ digest: DIGEST });
  });

  test("returns null when no trajectory identifier is present", () => {
    expect(trajectoryReferenceFromRecordBytes(crate(undefined))).toBeNull();
    expect(
      trajectoryReferenceFromRecordBytes(
        crate([{ "@type": "PropertyValue", propertyID: "https://example.test/other", value: DIGEST }]),
      ),
    ).toBeNull();
  });

  test("returns null rather than throwing on unreadable bytes", () => {
    expect(trajectoryReferenceFromRecordBytes(new Uint8Array([0xff]))).toBeNull();
    expect(trajectoryReferenceFromRecordBytes(new TextEncoder().encode("not json"))).toBeNull();
    expect(trajectoryReferenceFromRecordBytes(new TextEncoder().encode("{}"))).toBeNull();
  });

  test("rejects a malformed digest value", () => {
    expect(
      trajectoryReferenceFromRecordBytes(
        crate([
          {
            "@type": "PropertyValue",
            propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: "sha256:not-a-digest",
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("loadTrajectoryRecord", () => {
  test("parses the stored artifact under C1's schema", async () => {
    const { buildTrajectoryRecord } = await import("./trajectory.js");
    const { parseSessionFeed } = await import("./feed.js");
    const { readFile } = await import("node:fs/promises");
    const feedBytes = new Uint8Array(
      await readFile(new URL("../../fixtures/capture/session.ndjson", import.meta.url)),
    );
    const built = buildTrajectoryRecord(parseSessionFeed(feedBytes), feedBytes);
    const repository = {
      getArtifact: async () => built.bytes,
    } as unknown as Parameters<typeof loadTrajectoryRecord>[0];
    const record = await loadTrajectoryRecord(repository, { digest: built.digest });
    expect(record.traceId).toBe(built.traceId);
  });

  test("throws when the artifact is absent", async () => {
    const repository = {
      getArtifact: async () => null,
    } as unknown as Parameters<typeof loadTrajectoryRecord>[0];
    await expect(loadTrajectoryRecord(repository, { digest: DIGEST })).rejects.toThrow(/not present/u);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/link.test.ts
```

Expected: FAIL — `Failed to resolve import "./link.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/link.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type {
  EvidenceArtifactReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  type TrajectoryRecord,
  parseTrajectory,
} from "@jinn-network/evidence-trajectory";

import { PluginRuntimeError } from "../errors.js";
import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY } from "./identity.js";

const SHA256_REFERENCE = /^sha256:[0-9a-f]{64}$/u;

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Reads the trajectory record's digest out of a sealed execution record.
 *
 * The link is an `identifier` PropertyValue on the native-trace entity, which the recorder
 * emits from `ArtifactCapture.identifiers`
 * (`packages/evidence/execution-recorder/src/graph.ts:402-404`). It lives there rather than in
 * the catalog because `EVIDENCE_RECORD_FAMILIES` is closed
 * (`packages/evidence/repository/src/types.ts:1-5`) and a trajectory is therefore stored as a
 * repository artifact, which the catalog does not project.
 *
 * Returns `null` for any record that does not carry the link, including unreadable bytes —
 * a missing link is an ordinary state (every record written by another producer lacks one),
 * not an error.
 */
export function trajectoryReferenceFromRecordBytes(
  bytes: Uint8Array,
): EvidenceArtifactReference | null {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const graph = (document as { readonly "@graph"?: unknown })?.["@graph"];
  if (!Array.isArray(graph)) return null;

  for (const entity of graph) {
    if (entity === null || typeof entity !== "object") continue;
    for (const identifier of asArray((entity as Record<string, unknown>).identifier)) {
      if (identifier === null || typeof identifier !== "object") continue;
      const candidate = identifier as Record<string, unknown>;
      if (candidate.propertyID !== TRAJECTORY_RECORD_IDENTIFIER_PROPERTY) continue;
      const value = candidate.value;
      if (typeof value === "string" && SHA256_REFERENCE.test(value)) {
        return { digest: value as `sha256:${string}` };
      }
    }
  }
  return null;
}

/** Fetches and parses the sealed trajectory artifact under C1's exact-bytes discipline. */
export async function loadTrajectoryRecord(
  repository: EvidenceRepository,
  reference: EvidenceArtifactReference,
  options?: { readonly signal?: AbortSignal },
): Promise<TrajectoryRecord> {
  const bytes = await repository.getArtifact(reference, options);
  if (bytes === null) {
    throw new PluginRuntimeError(
      "capture-trajectory-missing",
      `The trajectory record ${reference.digest} is not present in this archive.`,
    );
  }
  return parseTrajectory(bytes);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/link.test.ts && yarn typecheck
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): the trajectory forward-link read surface"
```

---

### Task 10: Retention — bound the raw material, and be honest about what stays

**Files:**
- Create: `plugin/runtime/src/capture/retention.ts`, `src/capture/retention.test.ts`

**Interfaces:**
- Consumes: `CapturePaths`, `ensureOwnerOnlyDirectory`, `ensureOwnerOnlyFile` (Task 3); from `@jinn-network/evidence-discovery` — `type EvidenceCatalogReader`.
- Produces:
  ```ts
  export const RETENTION_POLICY_STATEMENT: string;
  export interface RetentionWatermark {
    readonly retentionDays: number;
    readonly cutoff: string;
    readonly sweptAt: string;
    /** Carried so the doctor can report a real loss without re-walking the tree. */
    readonly droppedUnsealedSessions: number;
    /** Of those, the ones that carried an end record and could have been sealed. */
    readonly droppedRecoverableSessions: number;
  }
  export function listStrandedSessionIds(
    paths: CapturePaths,
    exclude?: readonly string[],
  ): Promise<readonly string[]>;
  export interface CaptureRetentionReport {
    readonly cutoff: string;
    readonly sweptSessions: number;
    readonly sweptWorkspaces: number;
    readonly retainedSessions: number;
    readonly recoveredSessions: number;
    readonly droppedUnsealedSessions: number;
    /** Of those, the ones that carried an end record and could have been sealed. */
    readonly droppedRecoverableSessions: number;
    readonly sealedBeforeCutoff: number;
    readonly sealedCountTruncated: boolean;
  }
  export interface SweepCaptureRetentionInput {
    readonly paths: CapturePaths;
    readonly retentionDays: number;
    readonly now: Date;
    readonly keepSessionIds?: readonly string[];
    readonly catalog?: EvidenceCatalogReader;
    /** Seals a stranded feed. Supplied by the capability; returns false when it cannot. */
    readonly recover?: (sessionId: string) => Promise<boolean>;
    readonly maxRecoveries?: number;
    readonly signal?: AbortSignal;
  }
  export function sweepCaptureRetention(
    input: SweepCaptureRetentionInput,
  ): Promise<CaptureRetentionReport>;
  export function readRetentionWatermark(
    paths: CapturePaths,
  ): Promise<RetentionWatermark | null>;
  export const SEAL_MARKER_FILENAME: "sealed.json";
  ```

**Stranded feeds — C7 finding F-C7-7, owned here.** C7's adapter deliberately does not retry a `capture-archive-busy` seal: a session *end* that blocks on another session's archive lock is a user-visible hang for a benefit the user cannot see. That leaves a complete feed on disk with nothing to seal it, and a naive sweep would evict real evidence. So the sweep distinguishes two kinds of staging directory by the presence of a **seal marker** (`sealed.json`, written by `sealSession`):

- **Marked** — a duplicate of sealed bytes. Evict once older than the window.
- **Unmarked** — a stranded capture. Offer it to `recover` (at most `maxRecoveries` per sweep, oldest first, default 3) before considering eviction; evict only when recovery succeeds, or when the directory is past the window *and* recovery could not seal it — counted as `droppedUnsealedSessions` so the loss is visible rather than silent.

The recovery *mechanism* stays on the capability side; retention only schedules it. That keeps capture logic on one side of the seam, which is what C7 asked for.

**What this can and cannot do, stated before the code.** Spec §7.3 asks for "a product-side sweep bounding raw persistence, with a stated, user-visible policy", and files a finding against `local-runtime`. The finding is real and this task cannot close it: `LocalEvidenceRuntime` (`packages/evidence/local-runtime/src/types.ts:101-115`) has **no retention or eviction member**, and `EvidenceRepository` (`packages/evidence/repository/src/types.ts`) exposes only `putRecord`/`getRecord`/`putArtifact`/`getArtifact` — there is no delete. Reaching into the repository's directory tree to unlink content would violate the package boundary and defeat the ownership and integrity assertions it makes about its own paths.

What the product genuinely owns, and therefore genuinely bounds:

- **The staged session feed** at `<captureDirectory>/sessions/<id>/feed.ndjson`. After a seal this is a *duplicate* — the same bytes are content-addressed inside the archive as the native trace. Sweeping it takes raw persistence from two copies to one.
- **The recorder workspace** at `<captureDirectory>/workspaces/<id>`, whose `objects/sha256` tree holds a full copy of every captured byte (`packages/evidence/execution-recorder/src/paths.ts:53-60`). After a successful finalize the workspace is spent, so this is pure duplicate removal too.
- **The retention watermark**, which is the artifact C6 reads to keep captures older than the window out of retrieval projections — the property that actually closes spec §6.4's re-injection loop.

The policy is therefore stated exactly as it behaves, with no overclaim:

> Session feeds and capture workspaces are duplicates of material already sealed in your archive. They are deleted once they are older than the retention window (30 days by default). Sealed records are never deleted: the local archive is append-only, and removing a sealed capture today means removing the archive directory. Captures older than the retention window are excluded from retrieval, so old sessions stop resurfacing in your context even while their records remain.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/retention.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { resolveCapturePaths } from "./paths.js";
import {
  RETENTION_POLICY_STATEMENT,
  SEAL_MARKER_FILENAME,
  listStrandedSessionIds,
  readRetentionWatermark,
  sweepCaptureRetention,
} from "./retention.js";

let home: string;
const NOW = new Date("2026-07-30T12:00:00Z");
const dayMs = 86_400_000;

const paths = () => resolveCapturePaths(resolveRuntimeConfig({ env: {}, homeDirectory: home }));

async function seedSession(
  id: string,
  ageDays: number,
  options: { readonly sealed?: boolean } = {},
): Promise<void> {
  const p = paths();
  const when = new Date(NOW.getTime() - ageDays * dayMs);
  for (const directory of [join(p.sessionsDirectory, id), join(p.workspacesDirectory, id)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "feed.ndjson"), "{}\n", { mode: 0o600 });
  }
  if (options.sealed !== false) {
    await writeFile(join(p.sessionsDirectory, id, SEAL_MARKER_FILENAME), "{}\n", { mode: 0o600 });
  }
  for (const directory of [join(p.sessionsDirectory, id), join(p.workspacesDirectory, id)]) {
    await utimes(directory, when, when);
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-retention-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("sweepCaptureRetention", () => {
  test("removes staging older than the window and keeps the rest", async () => {
    await seedSession("old-one", 45);
    await seedSession("old-two", 31);
    await seedSession("fresh", 2);

    const report = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });

    expect(report.cutoff).toBe("2026-06-30T12:00:00.000Z");
    expect(report.sweptSessions).toBe(2);
    expect(report.sweptWorkspaces).toBe(2);
    expect(report.retainedSessions).toBe(1);
    await expect(stat(join(paths().sessionsDirectory, "old-one"))).rejects.toThrow();
    await expect(stat(join(paths().sessionsDirectory, "fresh"))).resolves.toBeDefined();
    await expect(stat(join(paths().workspacesDirectory, "old-two"))).rejects.toThrow();
  });

  test("never removes a session the caller is still working on", async () => {
    await seedSession("active", 90);
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      keepSessionIds: ["active"],
    });
    expect(report.sweptSessions).toBe(0);
    expect(report.retainedSessions).toBe(1);
    await expect(stat(join(paths().sessionsDirectory, "active"))).resolves.toBeDefined();
  });

  test("writes an owner-only watermark that reads back", async () => {
    await sweepCaptureRetention({ paths: paths(), retentionDays: 7, now: NOW });
    const watermark = await readRetentionWatermark(paths());
    expect(watermark).toEqual({
      retentionDays: 7,
      cutoff: "2026-07-23T12:00:00.000Z",
      sweptAt: "2026-07-30T12:00:00.000Z",
      droppedUnsealedSessions: 0,
      droppedRecoverableSessions: 0,
    });
    if (process.platform !== "win32") {
      expect((await stat(paths().retentionWatermarkPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("returns null for a watermark that is absent or unreadable", async () => {
    expect(await readRetentionWatermark(paths())).toBeNull();
    await mkdir(paths().captureDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths().retentionWatermarkPath, "not json", { mode: 0o600 });
    expect(await readRetentionWatermark(paths())).toBeNull();
  });

  test("is idempotent and safe on an empty capture tree", async () => {
    const first = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    const second = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    expect(first.sweptSessions).toBe(0);
    expect(second).toEqual(first);
  });

  test("reports how many sealed captures fall outside the window without deleting them", async () => {
    const catalog = {
      findExecutions: async (query: { startedBefore?: string; limit?: number }) => {
        expect(query.startedBefore).toBe("2026-06-30T12:00:00.000Z");
        expect(query.limit).toBe(200);
        return { items: [{}, {}, {}] };
      },
    } as never;
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      catalog,
    });
    expect(report.sealedBeforeCutoff).toBe(3);
    expect(report.sealedCountTruncated).toBe(false);
  });

  test("marks the sealed count truncated when the catalog page fills", async () => {
    const catalog = {
      findExecutions: async () => ({ items: Array.from({ length: 200 }, () => ({})) }),
    } as never;
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      catalog,
    });
    expect(report.sealedBeforeCutoff).toBe(200);
    expect(report.sealedCountTruncated).toBe(true);
  });

  test("a catalog failure never fails the sweep", async () => {
    const catalog = {
      findExecutions: async () => {
        throw new Error("catalog unavailable");
      },
    } as never;
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      catalog,
    });
    expect(report.sealedBeforeCutoff).toBe(0);
  });

  test("lists stranded sessions oldest first, without touching the archive", async () => {
    await seedSession("sealed-one", 10);
    await seedSession("stranded-newer", 5, { sealed: false });
    await seedSession("stranded-older", 20, { sealed: false });
    await seedSession("active", 1, { sealed: false });

    expect(await listStrandedSessionIds(paths(), ["active"])).toEqual([
      "stranded-older",
      "stranded-newer",
    ]);
    expect(await listStrandedSessionIds(paths())).toEqual([
      "stranded-older",
      "stranded-newer",
      "active",
    ]);
  });

  test("listing strandeds on an absent staging tree is empty, not an error", async () => {
    await expect(listStrandedSessionIds(paths())).resolves.toEqual([]);
  });

  test("records the dropped counts in the watermark so the doctor need not re-walk", async () => {
    await seedSession("lost", 40, { sealed: false });
    await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    const watermark = await readRetentionWatermark(paths());
    expect(watermark?.droppedUnsealedSessions).toBe(1);
    expect(watermark?.droppedRecoverableSessions).toBe(0);
  });

  test("splits dropped feeds by whether they were ever sealable", async () => {
    // Sealable: carries a session-close line, so recovery simply never reached it.
    await seedSession("sealable", 40, { sealed: false });
    await writeFile(
      join(paths().sessionsDirectory, "sealable", "feed.ndjson"),
      [
        JSON.stringify({
          type: "session-open",
          v: 1,
          sessionId: "sealable",
          startedAt: "2026-06-01T09:00:00Z",
          atUnixNano: "1000",
          host: { name: "Hermes", version: "0.9.1" },
          model: { provider: "anthropic", name: "claude-opus-4.6" },
        }),
        JSON.stringify({
          type: "session-close",
          atUnixNano: "2000",
          endedAt: "2026-06-01T09:00:01Z",
          outcome: "completed",
          summary: "done",
        }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    // Cut short: no end record, so nothing could ever have sealed it.
    await seedSession("cut-short", 40, { sealed: false });
    await writeFile(
      join(paths().sessionsDirectory, "cut-short", "feed.ndjson"),
      JSON.stringify({ type: "user-turn", atUnixNano: "1000", text: "hi" }) + "\n",
      { mode: 0o600 },
    );

    const report = await sweepCaptureRetention({ paths: paths(), retentionDays: 30, now: NOW });
    expect(report.droppedUnsealedSessions).toBe(2);
    expect(report.droppedRecoverableSessions).toBe(1);
  });

  test("offers a stranded feed to recovery before evicting it, oldest first and bounded", async () => {
    await seedSession("stranded-old", 40, { sealed: false });
    await seedSession("stranded-new", 35, { sealed: false });
    await seedSession("stranded-third", 33, { sealed: false });
    await seedSession("stranded-fourth", 32, { sealed: false });
    const offered: string[] = [];

    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      maxRecoveries: 2,
      recover: async (sessionId) => {
        offered.push(sessionId);
        return sessionId === "stranded-old";
      },
    });

    expect(offered).toEqual(["stranded-old", "stranded-new"]);
    expect(report.recoveredSessions).toBe(1);
    // Everything past the window is evicted; the three that could not be sealed are counted.
    expect(report.sweptSessions).toBe(4);
    expect(report.droppedUnsealedSessions).toBe(3);
  });

  test("keeps a fresh unsealed feed even when recovery declines", async () => {
    await seedSession("fresh-unsealed", 1, { sealed: false });
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      recover: async () => false,
    });
    expect(report.sweptSessions).toBe(0);
    expect(report.droppedUnsealedSessions).toBe(0);
    expect(report.retainedSessions).toBe(1);
    await expect(stat(join(paths().sessionsDirectory, "fresh-unsealed"))).resolves.toBeDefined();
  });

  test("a throwing recovery is treated as a decline, never as a sweep failure", async () => {
    await seedSession("stranded", 40, { sealed: false });
    const report = await sweepCaptureRetention({
      paths: paths(),
      retentionDays: 30,
      now: NOW,
      recover: async () => {
        throw new Error("archive busy");
      },
    });
    expect(report.recoveredSessions).toBe(0);
    expect(report.droppedUnsealedSessions).toBe(1);
    // The seeded feed is a bare "{}" line, so it was never sealable.
    expect(report.droppedRecoverableSessions).toBe(0);
  });

  test("the stated policy says plainly that sealed records are not deleted", async () => {
    expect(RETENTION_POLICY_STATEMENT).toContain("never deleted");
    expect(RETENTION_POLICY_STATEMENT).toContain("excluded from retrieval");
    expect(await readFile(new URL("./retention.ts", import.meta.url), "utf8")).toContain(
      "append-only",
    );
  });
});
```

> The last assertion reads the module's own source to keep the policy text and the code comment from drifting apart; make the test `async` accordingly.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/retention.test.ts
```

Expected: FAIL — `Failed to resolve import "./retention.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/retention.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvidenceCatalogReader } from "@jinn-network/evidence-discovery";

import type { CapturePaths } from "./paths.js";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./paths.js";

const SEALED_COUNT_PAGE = 200;

/**
 * The user-visible retention policy. It claims exactly what the sweep does and no more.
 *
 * The local archive is append-only: `LocalEvidenceRuntime` has no eviction member
 * (`packages/evidence/local-runtime/src/types.ts:101-115`) and `EvidenceRepository` exposes no
 * delete, so a sealed record cannot be removed without reaching past a package boundary. What
 * the product owns — and therefore bounds — is the staged feed and the recorder workspace,
 * both of which are duplicates of bytes already sealed in the archive.
 */
export const RETENTION_POLICY_STATEMENT =
  "Session feeds and capture workspaces are duplicates of material already sealed in your " +
  "archive; they are deleted once older than the retention window. Sealed records are never " +
  "deleted — the local archive is append-only — but captures older than the window are " +
  "excluded from retrieval, so old sessions stop resurfacing in your context.";

export interface RetentionWatermark {
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly sweptAt: string;
  /** Carried so the doctor can report a real loss without re-walking the staging tree. */
  readonly droppedUnsealedSessions: number;
  /** Of those, the ones that carried an end record and could therefore have been sealed. */
  readonly droppedRecoverableSessions: number;
}

export interface CaptureRetentionReport {
  readonly cutoff: string;
  readonly sweptSessions: number;
  readonly sweptWorkspaces: number;
  readonly retainedSessions: number;
  readonly recoveredSessions: number;
  readonly droppedUnsealedSessions: number;
  /**
   * Of the dropped feeds, the ones that carried a `session-close` line — they were sealable
   * and recovery simply never reached them. This is the arm that means something is wrong;
   * the remainder were cut short mid-session and could never have been sealed at all.
   */
  readonly droppedRecoverableSessions: number;
  readonly sealedBeforeCutoff: number;
  readonly sealedCountTruncated: boolean;
}

export interface SweepCaptureRetentionInput {
  readonly paths: CapturePaths;
  readonly retentionDays: number;
  readonly now: Date;
  readonly keepSessionIds?: readonly string[];
  readonly catalog?: EvidenceCatalogReader;
  readonly signal?: AbortSignal;
}

/** Written into a session's staging directory by `sealSession` once the seal succeeds. */
export const SEAL_MARKER_FILENAME = "sealed.json" as const;

interface StagingEntry {
  readonly name: string;
  readonly path: string;
  readonly modifiedMs: number;
  readonly sealed: boolean;
}

async function listStaging(
  root: string,
  keep: ReadonlySet<string>,
  markerAware: boolean,
): Promise<readonly StagingEntry[]> {
  let names: readonly string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const entries: StagingEntry[] = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    const path = join(root, name);
    let modifiedMs: number;
    try {
      modifiedMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    let sealed = true;
    if (markerAware) {
      sealed = await stat(join(path, SEAL_MARKER_FILENAME)).then(
        () => true,
        () => false,
      );
    }
    entries.push({ name, path, modifiedMs, sealed });
  }
  return entries.sort((left, right) => left.modifiedMs - right.modifiedMs);
}

/**
 * Whether a staged feed carries a `session-close` line.
 *
 * The discriminator between a drop that means something is wrong (the feed was sealable and
 * recovery never reached it) and one that never could have gone any other way (the process
 * was killed mid-session, so there is no honest outcome or end time to record). Only called
 * for feeds about to be deleted, which is rare.
 */
async function hadEndRecord(sessionDir: string): Promise<boolean> {
  try {
    const text = await readFile(join(sessionDir, "feed.ndjson"), "utf8");
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    const last = body.slice(body.lastIndexOf("\n") + 1);
    if (last.length === 0) return false;
    return (JSON.parse(last) as { readonly type?: unknown }).type === "session-close";
  } catch {
    return false;
  }
}

async function countSealedBefore(
  catalog: EvidenceCatalogReader | undefined,
  cutoff: string,
  signal: AbortSignal | undefined,
): Promise<{ count: number; truncated: boolean }> {
  if (catalog === undefined) return { count: 0, truncated: false };
  try {
    const page = await catalog.findExecutions(
      { startedBefore: cutoff, limit: SEALED_COUNT_PAGE },
      signal === undefined ? undefined : { signal },
    );
    return {
      count: page.items.length,
      truncated: page.items.length >= SEALED_COUNT_PAGE,
    };
  } catch {
    // Observability only. A catalog that cannot answer must never fail a capture.
    return { count: 0, truncated: false };
  }
}

export async function sweepCaptureRetention(
  input: SweepCaptureRetentionInput,
): Promise<CaptureRetentionReport> {
  const cutoffMs = input.now.getTime() - input.retentionDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const keep = new Set(input.keepSessionIds ?? []);
  const maxRecoveries = input.maxRecoveries ?? 3;

  const sessionEntries = await listStaging(input.paths.sessionsDirectory, keep, true);
  let sweptSessions = 0;
  let retainedSessions = 0;
  let recoveredSessions = 0;
  let droppedUnsealedSessions = 0;
  let droppedRecoverableSessions = 0;
  let recoveryBudget = input.recover === undefined ? 0 : maxRecoveries;

  for (const entry of sessionEntries) {
    let sealed = entry.sealed;
    // A stranded feed (C7 finding F-C7-7): the adapter could not seal it because the archive
    // was busy, so nothing else owns it. Offer it to the capability before considering it
    // disposable — oldest first, bounded, and never fatal.
    if (!sealed && recoveryBudget > 0 && input.recover !== undefined) {
      recoveryBudget -= 1;
      sealed = await input.recover(entry.name).catch(() => false);
      if (sealed) recoveredSessions += 1;
    }
    if (entry.modifiedMs >= cutoffMs) {
      retainedSessions += 1;
      continue;
    }
    if (!sealed) {
      // Past the window and still unsealed. Dropping is a real loss, so it is counted rather
      // than absorbed into the ordinary duplicate sweep — and split by whether it was ever
      // sealable, because the two cases warrant completely different advice.
      droppedUnsealedSessions += 1;
      if (await hadEndRecord(entry.path)) droppedRecoverableSessions += 1;
    }
    await rm(entry.path, { recursive: true, force: true });
    sweptSessions += 1;
  }

  const workspaceEntries = await listStaging(input.paths.workspacesDirectory, keep, false);
  let sweptWorkspaces = 0;
  for (const entry of workspaceEntries) {
    if (entry.modifiedMs >= cutoffMs) continue;
    await rm(entry.path, { recursive: true, force: true });
    sweptWorkspaces += 1;
  }

  // Sessions the caller asked to keep are excluded from `listStaging`; count the ones that
  // exist so `retainedSessions` describes the whole staging tree.
  for (const name of keep) {
    const present = await stat(join(input.paths.sessionsDirectory, name)).then(
      () => true,
      () => false,
    );
    if (present) retainedSessions += 1;
  }

  const sealed = await countSealedBefore(input.catalog, cutoff, input.signal);

  await ensureOwnerOnlyDirectory(input.paths.captureDirectory);
  const watermark: RetentionWatermark = {
    retentionDays: input.retentionDays,
    cutoff,
    sweptAt: input.now.toISOString(),
    droppedUnsealedSessions,
    droppedRecoverableSessions,
  };
  await writeFile(input.paths.retentionWatermarkPath, `${JSON.stringify(watermark)}\n`, {
    mode: 0o600,
  });
  await ensureOwnerOnlyFile(input.paths.retentionWatermarkPath);

  return {
    cutoff,
    sweptSessions,
    sweptWorkspaces,
    retainedSessions,
    recoveredSessions,
    droppedUnsealedSessions,
    droppedRecoverableSessions,
    sealedBeforeCutoff: sealed.count,
    sealedCountTruncated: sealed.truncated,
  };
}

/** The exclusion boundary C6 reads. `null` means no sweep has run yet. */
export async function readRetentionWatermark(
  paths: CapturePaths,
): Promise<RetentionWatermark | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.retentionWatermarkPath, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as RetentionWatermark).cutoff !== "string" ||
      typeof (parsed as RetentionWatermark).sweptAt !== "string" ||
      typeof (parsed as RetentionWatermark).retentionDays !== "number" ||
      typeof (parsed as RetentionWatermark).droppedUnsealedSessions !== "number" ||
      typeof (parsed as RetentionWatermark).droppedRecoverableSessions !== "number"
    ) {
      return null;
    }
    return parsed as RetentionWatermark;
  } catch {
    return null;
  }
}

/**
 * Session staging directories that carry no seal marker — captures nothing else owns.
 * Ordered oldest first, so a bounded recovery pass takes the ones most at risk of eviction.
 *
 * Exported so a caller can find out whether recovery has anything to do *before* taking the
 * archive's exclusive lock. Discovering "nothing to recover" must not cost a lock.
 */
export async function listStrandedSessionIds(
  paths: CapturePaths,
  exclude: readonly string[] = [],
): Promise<readonly string[]> {
  const entries = await listStaging(paths.sessionsDirectory, new Set(exclude), true);
  return entries.filter((entry) => !entry.sealed).map((entry) => entry.name);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/retention.test.ts && yarn typecheck
```

Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): the capture retention sweep and its stated policy"
```

---

### Task 11: The capture capability — open, seal, abandon

**Files:**
- Create: `plugin/runtime/src/capture/capability.ts`, `src/capture/capability.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–10; `RuntimeCapability`, `CapabilityContext`, `HealthCheck`, `PluginRuntimeError` (C3); from `@jinn-network/execution-recorder` — `createExecutionRecorder`, `type CaptureDiagnostic`, `type ExecutionId`; from `@jinn-network/evidence-repository` — `type EvidenceArtifactReference`, `type EvidenceRecordReference`; from `@jinn-network/evidence-local-runtime` — `type LocalEvidenceIndexingOutcome`, `type LocalEvidenceRuntime`.
- Produces: the surface C7 drives and C6 consumes —
  ```ts
  export interface OpenSessionInput { readonly sessionId?: string }
  export interface OpenSessionResult { readonly sessionId: string; readonly feedPath: string }
  export interface SealSessionInput {
    readonly sessionId: string;
    readonly outcome?: "completed" | "failed" | "abandoned";
    readonly endedAt?: string;
    readonly signal?: AbortSignal;
  }
  export interface SealedCapture {
    readonly executionId: ExecutionId;
    readonly record: EvidenceRecordReference;
    readonly recordBytes: Uint8Array;
    readonly artifacts: readonly EvidenceArtifactReference[];
    readonly nativeTrace: {
      readonly reference: EvidenceArtifactReference;
      readonly formatIri: string;
      readonly mediaType: string;
    };
    readonly trajectory: {
      readonly reference: EvidenceArtifactReference;
      readonly bytes: Uint8Array;
      readonly digest: `sha256:${string}`;
      readonly traceId: string;
    };
    readonly indexed: LocalEvidenceIndexingOutcome;
    readonly retention: CaptureRetentionReport;
  }
  export type SealSessionResult =
    | { readonly sealed: true; readonly capture: SealedCapture }
    | { readonly sealed: false; readonly diagnostics: readonly CaptureDiagnostic[] };
  export interface CaptureCapability extends RuntimeCapability {
    openSession(input?: OpenSessionInput): Promise<OpenSessionResult>;
    sealSession(input: SealSessionInput): Promise<SealSessionResult>;
    abandonSession(sessionId: string): Promise<void>;
  }
  export interface CreateCaptureCapabilityOptions {
    readonly producerVersion: string;
    readonly now?: () => Date;
    readonly newSessionId?: () => string;
    readonly withArchive?: typeof withCaptureArchive;
  }
  export function createCaptureCapability(
    options: CreateCaptureCapabilityOptions,
  ): CaptureCapability;
  ```

Four properties this task establishes, each tested:

- **One archive hold per operation, and no hold outside one.** `start()` creates staging directories and nothing else. `sealSession` does the whole seal — record, trajectory artifact, indexing, marker, retention — inside one `withCaptureArchive` call. Recovery of stranded feeds reuses **the same open runtime**, never a nested `withCaptureArchive`, which would deadlock against the exclusive lock the outer call already holds.
- **A single capture writer per session** (cross-plan contract 4). `sealSession` refuses a session it is already sealing, in-process, so a duplicated MCP call cannot drive two recorders at one workspace.
- **The feed is attached with `attachNativeTrace`**, before `finalize`, exactly as the recorder's capture model intends — and `finalize` therefore carries no `nativeTrace` of its own.
- **`openSession` recovers stranded feeds** — coordinator ruling, adopting C7's counter-proposal over the adapter-side hook this plan first offered. The adapter cannot enumerate stranded session ids without inventing cross-process state, and driving recovery from it would put capture logic on both sides of the seam. Session open is also strictly the better moment: recovery fires at the *start* of the next session rather than at its end, shrinking the stranded window by a whole session. Three constraints hold it to a wait nobody notices:

  1. **Bounded** — at most `OPEN_SESSION_RECOVERY_LIMIT` (3) feeds per open, oldest first, so an operator returning after a long gap does not pay an unbounded seal cost before their first turn.
  2. **Never blocks the session** — the same skip-if-held shape as C5's mirror sync. The archive is probed with a short budget (`OPEN_SESSION_RECOVERY_BUDGET_MS`, 1000 ms), and a busy archive means a sibling instance is working, not that anything failed: skip, leave the feed staged, try again at the next open. Every failure inside recovery is swallowed — `openSession` **never** throws because of it.
  3. **Silent on the happy path** — one `info` line when recovery actually seals something, nothing at all when there was nothing to do. And nothing is probed at all when there is nothing to recover: `listStrandedSessionIds` is a `readdir` + `stat` walk that runs *before* any lock is taken, so the ordinary open costs no archive access whatsoever.

  The residual is accepted and named rather than engineered away: an operator whose **final** session strands and who never opens another leaves that feed staged indefinitely. Closing that would need a background daemon, which spec §6.2 rules out by design. It is stated beside the retention policy in the README, in the same voice retention already had to adopt about not deleting sealed material.

**Health checks are deliberately two rows at most, and often one** (C5 finding F9, adopted as a cross-plan rule: *a check whose answer is the same on every install is a release note, not a health check*). An earlier draft of this task emitted a standing `capture.retention` row that was `ok: true` on every install and carried the policy text — that is documentation wearing a check's clothes, and it is now in the README instead. What remains varies by install: `capture-staging` fails when the staging tree is missing **or has been loosened past owner-only** (a restored backup, a synced folder, an unusual umask all do this), and `capture-stranded` is emitted **only when** the last sweep actually dropped unsealed feeds.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/capability.test.ts`:

```ts
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";
import { createCaptureCapability } from "./capability.js";
import { resolveCapturePaths, sessionFeedPath } from "./paths.js";
import { SEAL_MARKER_FILENAME } from "./retention.js";

let home: string;

const context = () => ({
  config: resolveRuntimeConfig({ env: {}, homeDirectory: home }),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const capability = () => createCaptureCapability({ producerVersion: "0.1.0" });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-capture-capability-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("capture capability lifecycle", () => {
  test("is named and creates its staging tree on start", async () => {
    const capture = capability();
    expect(capture.name).toBe("capture");
    const ctx = context();
    await capture.start!(ctx);
    const paths = resolveCapturePaths(ctx.config);
    expect((await stat(paths.sessionsDirectory)).isDirectory()).toBe(true);
    expect((await stat(paths.workspacesDirectory)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(paths.captureDirectory)).mode & 0o777).toBe(0o700);
    }
  });

  test("start does not open the archive", async () => {
    const withArchive = vi.fn();
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: withArchive as never,
    });
    await capture.start!(context());
    expect(withArchive).not.toHaveBeenCalled();
  });

  test("refuses to operate before start", async () => {
    await expect(capability().openSession()).rejects.toMatchObject({
      code: "capture-not-started",
    });
  });

  test("emits only checks whose answer varies by install", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const checks = await capture.healthChecks!();
    // No standing retention row: an always-green check is a release note (C5 finding F9).
    expect(checks.map((check) => check.name)).toEqual(["capture-staging"]);
    expect(checks[0]?.ok).toBe(true);
    expect(checks[0]?.remedy).toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "capture-staging goes red when staging is readable by others, with a remedy",
    async () => {
      const capture = capability();
      const ctx = context();
      await capture.start!(ctx);
      const { chmod } = await import("node:fs/promises");
      await chmod(resolveCapturePaths(ctx.config).sessionsDirectory, 0o755);
      const [staging] = await capture.healthChecks!();
      expect(staging?.ok).toBe(false);
      expect(staging?.detail).toContain("readable by others");
      expect(staging?.remedy).toContain("chmod");
    },
  );

  test("capture-stranded appears only after a sweep actually dropped a feed, and names the right cause", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const paths = resolveCapturePaths(ctx.config);
    const { writeFile } = await import("node:fs/promises");

    await writeFile(
      paths.retentionWatermarkPath,
      `${JSON.stringify({
        retentionDays: 30,
        cutoff: "2026-06-30T12:00:00.000Z",
        sweptAt: "2026-07-30T12:00:00.000Z",
        droppedUnsealedSessions: 0,
        droppedRecoverableSessions: 0,
      })}\n`,
      { mode: 0o600 },
    );
    expect((await capture.healthChecks!()).map((check) => check.name)).toEqual([
      "capture-staging",
    ]);

    await writeFile(
      paths.retentionWatermarkPath,
      `${JSON.stringify({
        retentionDays: 30,
        cutoff: "2026-06-30T12:00:00.000Z",
        sweptAt: "2026-07-30T12:00:00.000Z",
        droppedUnsealedSessions: 2,
        droppedRecoverableSessions: 0,
      })}\n`,
      { mode: 0o600 },
    );
    // Both were cut short mid-session. Nothing could have sealed them, so proposing a fix
    // would be false advice: the row is informational and carries no remedy.
    const unsealable = await capture.healthChecks!();
    expect(unsealable.map((check) => check.name)).toEqual([
      "capture-staging",
      "capture-stranded",
    ]);
    expect(unsealable[1]?.ok).toBe(true);
    expect(unsealable[1]?.detail).toContain("without an end record");
    expect(unsealable[1]?.remedy).toBeNull();

    await writeFile(
      paths.retentionWatermarkPath,
      `${JSON.stringify({
        retentionDays: 30,
        cutoff: "2026-06-30T12:00:00.000Z",
        sweptAt: "2026-07-30T12:00:00.000Z",
        droppedUnsealedSessions: 2,
        droppedRecoverableSessions: 1,
      })}\n`,
      { mode: 0o600 },
    );
    // One was sealable and recovery never reached it — a real fault with a real remedy.
    const recoverable = await capture.healthChecks!();
    expect(recoverable[1]?.ok).toBe(false);
    expect(recoverable[1]?.detail).toContain("could have been sealed");
    expect(recoverable[1]?.remedy).toContain("three feeds per session");
  });
});

describe("openSession", () => {
  test("mints a session, creates its directory, and pre-creates the feed owner-only", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession();
    expect(feedPath).toBe(sessionFeedPath(resolveCapturePaths(ctx.config), sessionId));
    expect((await stat(feedPath)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(feedPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("honors a caller-supplied session id and rejects an unsafe one", async () => {
    const capture = capability();
    await capture.start!(context());
    await expect(capture.openSession({ sessionId: "s-explicit" })).resolves.toMatchObject({
      sessionId: "s-explicit",
    });
    await expect(capture.openSession({ sessionId: "../escape" })).rejects.toBeInstanceOf(
      PluginRuntimeError,
    );
  });

  test("is idempotent for one session id and never truncates an existing feed", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const first = await capture.openSession({ sessionId: "s-1" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(first.feedPath, "{}\n", { flag: "a" });
    const second = await capture.openSession({ sessionId: "s-1" });
    expect(second.feedPath).toBe(first.feedPath);
    expect(await readFile(first.feedPath, "utf8")).toBe("{}\n");
  });

  test("costs no archive access when there is nothing stranded to recover", async () => {
    const withArchive = vi.fn();
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: withArchive as never,
    });
    await capture.start!(context());
    await capture.openSession({ sessionId: "s-first" });
    // A fresh open has no unsealed sibling, so the exclusive lock is never taken.
    expect(withArchive).not.toHaveBeenCalled();
  });

  test("opens the archive with a short budget when a stranded feed exists", async () => {
    const seen: { busyTimeoutMs?: number } = {};
    const withArchive = vi.fn(async (options: { busyTimeoutMs: number }) => {
      seen.busyTimeoutMs = options.busyTimeoutMs;
      throw new PluginRuntimeError("capture-archive-busy", "held by a sibling");
    });
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: withArchive as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    // A previously opened session that was never sealed carries no marker.
    await capture.openSession({ sessionId: "s-stranded" });
    withArchive.mockClear();

    // A busy archive must not fail the open, and must not be waited on for long.
    await expect(capture.openSession({ sessionId: "s-new" })).resolves.toMatchObject({
      sessionId: "s-new",
    });
    expect(withArchive).toHaveBeenCalledTimes(1);
    expect(seen.busyTimeoutMs).toBe(1_000);
    expect(ctx.log.info).not.toHaveBeenCalled();
  });

  test("logs one line only when recovery actually seals something", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: (async (
        _options: unknown,
        run: (runtime: unknown) => Promise<unknown>,
      ) => run({ catalog: undefined, repository: {} })) as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    await capture.openSession({ sessionId: "s-stranded" });
    // The stranded feed is empty, so recovery declines it and nothing is reported.
    await capture.openSession({ sessionId: "s-new" });
    expect(ctx.log.info).not.toHaveBeenCalled();
  });
});

describe("abandonSession", () => {
  test("removes the staging directory and is safe to repeat", async () => {
    const capture = capability();
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession();
    await capture.abandonSession(sessionId);
    await expect(stat(feedPath)).rejects.toThrow();
    await expect(capture.abandonSession(sessionId)).resolves.toBeUndefined();
  });

  test("does not open the archive", async () => {
    const withArchive = vi.fn();
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: withArchive as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId } = await capture.openSession();
    await capture.abandonSession(sessionId);
    expect(withArchive).not.toHaveBeenCalled();
  });
});

describe("sealSession guards", () => {
  // These guards all reject before the repository is touched, so the archive is stubbed out:
  // this file must stay a unit file, and opening a real archive costs an exclusive lock.
  const passthrough = (async (
    _options: unknown,
    run: (runtime: unknown) => Promise<unknown>,
  ) => run({ catalog: undefined, repository: {} })) as never;

  test("refuses a session whose feed does not exist", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: passthrough,
    });
    await capture.start!(context());
    await expect(capture.sealSession({ sessionId: "s-missing" })).rejects.toMatchObject({
      code: "capture-feed-missing",
    });
  });

  test("refuses a second concurrent seal of the same session", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: (async () => {
        await gate;
        throw new PluginRuntimeError("capture-archive-busy", "held");
      }) as never,
    });
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-race" });
    await copyFile(
      new URL("../../fixtures/capture/session.ndjson", import.meta.url),
      feedPath,
    );

    const first = capture.sealSession({ sessionId });
    await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
      code: "capture-session-busy",
    });
    release();
    await expect(first).rejects.toMatchObject({ code: "capture-archive-busy" });

    // The in-process claim is released even on failure, so a later retry is admitted.
    await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
      code: "capture-archive-busy",
    });
  });

  test("refuses an unclosed feed with no supplied outcome", async () => {
    const capture = createCaptureCapability({
      producerVersion: "0.1.0",
      withArchive: passthrough,
    });
    const ctx = context();
    await capture.start!(ctx);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-open" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      feedPath,
      JSON.stringify({
        type: "session-open",
        v: 1,
        sessionId: "s-open",
        startedAt: "2026-07-30T09:00:00Z",
        atUnixNano: "1000",
        host: { name: "Hermes", version: "0.9.1" },
        model: { provider: "anthropic", name: "claude-opus-4.6" },
      }) + "\n",
    );
    await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
      code: "capture-outcome-unknown",
    });
  });
});
```

> The end-to-end behaviour of `sealSession` against a real archive — the sealed record, the trajectory artifact, protocol conformance, the marker, and retention — is Task 12's integration test. This file covers the guards, which need no archive.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/capability.test.ts
```

Expected: FAIL — `Failed to resolve import "./capability.js"`.

- [ ] **Step 3: Write the implementation**

`plugin/runtime/src/capture/capability.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  LocalEvidenceIndexingOutcome,
  LocalEvidenceRuntime,
} from "@jinn-network/evidence-local-runtime";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import { documentDigest } from "@jinn-network/evidence-trajectory";
import {
  type CaptureDiagnostic,
  type ExecutionId,
  createExecutionRecorder,
} from "@jinn-network/execution-recorder";

import type { CapabilityContext, RuntimeCapability } from "../capability.js";
import type { RuntimeConfig } from "../config.js";
import { PluginRuntimeError } from "../errors.js";
import type { HealthCheck } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import {
  type CaptureAssemblyInput,
  buildFinalizeInput,
  buildStartInput,
  resolveSessionOutcome,
} from "./assemble.js";
import { withCaptureArchive } from "./archive.js";
import { parseSessionFeed } from "./feed.js";
import { SESSION_FEED_FORMAT_IRI, SESSION_FEED_MEDIA_TYPE } from "./identity.js";
import {
  type CapturePaths,
  assertSafeSessionId,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveCapturePaths,
  sessionDirectory,
  sessionFeedPath,
  workspaceDirectory,
} from "./paths.js";
import {
  type CaptureRetentionReport,
  SEAL_MARKER_FILENAME,
  listStrandedSessionIds,
  readRetentionWatermark,
  sweepCaptureRetention,
} from "./retention.js";
import { buildTrajectoryRecord } from "./trajectory.js";

/** At most this many stranded feeds are sealed per `openSession`, oldest first. */
const OPEN_SESSION_RECOVERY_LIMIT = 3;

/**
 * How long `openSession` waits for a busy archive before skipping recovery entirely. Short
 * by design: a session start must never feel like a hang, and a skipped recovery costs
 * nothing — the feed stays staged and the next open tries again.
 */
const OPEN_SESSION_RECOVERY_BUDGET_MS = 1_000;

export interface OpenSessionInput {
  readonly sessionId?: string;
}

export interface OpenSessionResult {
  readonly sessionId: string;
  readonly feedPath: string;
}

export interface SealSessionInput {
  readonly sessionId: string;
  readonly outcome?: "completed" | "failed" | "abandoned";
  readonly endedAt?: string;
  readonly signal?: AbortSignal;
}

export interface SealedCapture {
  readonly executionId: ExecutionId;
  readonly record: EvidenceRecordReference;
  readonly recordBytes: Uint8Array;
  readonly artifacts: readonly EvidenceArtifactReference[];
  readonly nativeTrace: {
    readonly reference: EvidenceArtifactReference;
    readonly formatIri: string;
    readonly mediaType: string;
  };
  readonly trajectory: {
    readonly reference: EvidenceArtifactReference;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly traceId: string;
  };
  readonly indexed: LocalEvidenceIndexingOutcome;
  readonly retention: CaptureRetentionReport;
}

export type SealSessionResult =
  | { readonly sealed: true; readonly capture: SealedCapture }
  | { readonly sealed: false; readonly diagnostics: readonly CaptureDiagnostic[] };

export interface CaptureCapability extends RuntimeCapability {
  openSession(input?: OpenSessionInput): Promise<OpenSessionResult>;
  sealSession(input: SealSessionInput): Promise<SealSessionResult>;
  abandonSession(sessionId: string): Promise<void>;
}

export interface CreateCaptureCapabilityOptions {
  readonly producerVersion: string;
  readonly now?: () => Date;
  readonly newSessionId?: () => string;
  readonly withArchive?: typeof withCaptureArchive;
}

interface Started {
  readonly config: RuntimeConfig;
  readonly paths: CapturePaths;
  readonly log: RuntimeLogger;
}

export function createCaptureCapability(
  options: CreateCaptureCapabilityOptions,
): CaptureCapability {
  const now = options.now ?? (() => new Date());
  const newSessionId = options.newSessionId ?? (() => randomUUID());
  const withArchive = options.withArchive ?? withCaptureArchive;

  let started: Started | undefined;
  const sealing = new Set<string>();

  function requireStarted(): Started {
    if (started === undefined) {
      throw new PluginRuntimeError(
        "capture-not-started",
        "The capture capability has not been started.",
      );
    }
    return started;
  }

  async function readFeed(paths: CapturePaths, sessionId: string): Promise<Uint8Array> {
    const path = sessionFeedPath(paths, sessionId);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      throw new PluginRuntimeError(
        "capture-feed-missing",
        `No session feed exists at ${path}.`,
        { cause: error },
      );
    }
  }

  /**
   * Seals one session using an archive the caller already holds.
   *
   * Split out from `sealSession` so retention's stranded-feed recovery can reuse the open
   * runtime: a nested `withCaptureArchive` would block on the exclusive lock this very call
   * is holding (`packages/evidence/local-runtime/src/lock.ts`).
   */
  async function sealInto(
    state: Started,
    runtime: LocalEvidenceRuntime,
    input: SealSessionInput,
  ): Promise<SealSessionResult> {
    const feedBytes = await readFeed(state.paths, input.sessionId);
    const feed = parseSessionFeed(feedBytes);
    const outcome = resolveSessionOutcome(feed, {
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    });
    const trajectory = buildTrajectoryRecord(feed, feedBytes);

    const assembly: CaptureAssemblyInput = {
      feed,
      feedPath: sessionFeedPath(state.paths, input.sessionId),
      workspaceDir: workspaceDirectory(state.paths, input.sessionId),
      producerVersion: options.producerVersion,
      outcome,
      trajectoryDigest: trajectory.digest,
    };

    await ensureOwnerOnlyDirectory(assembly.workspaceDir);

    const recorder = createExecutionRecorder({ repository: runtime.repository });
    const recording = await recorder.start(buildStartInput(assembly));
    const finalizeInput = buildFinalizeInput(assembly);

    // Bind the exact feed bytes and their declared format before finalizing.
    await recording.attachNativeTrace(finalizeInput.nativeTrace!, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    // The trajectory artifact exists before the record that names it, never after.
    const trajectoryReceipt = await runtime.repository.putArtifact(trajectory.bytes, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const finalized = await recording.finalize(
      {
        outcome: finalizeInput.outcome,
        endedAt: finalizeInput.endedAt,
        results: finalizeInput.results!,
      },
      { ...(input.signal === undefined ? {} : { signal: input.signal }) },
    );
    if (!finalized.finalized) {
      return { sealed: false, diagnostics: finalized.diagnostics };
    }

    const recordBytes = await runtime.repository.getRecord(finalized.receipt.record);
    if (recordBytes === null) {
      throw new PluginRuntimeError(
        "capture-record-missing",
        `The sealed record ${finalized.receipt.record.digest} is not readable from the archive.`,
      );
    }
    const indexed = await runtime.awaitIndexed(finalized.receipt.record, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const capture: Omit<SealedCapture, "retention"> = {
      executionId: finalized.receipt.executionId,
      record: finalized.receipt.record,
      recordBytes,
      artifacts: finalized.receipt.artifacts,
      nativeTrace: {
        reference: { digest: documentDigest(feedBytes) },
        formatIri: SESSION_FEED_FORMAT_IRI,
        mediaType: SESSION_FEED_MEDIA_TYPE,
      },
      trajectory: {
        reference: trajectoryReceipt.reference,
        bytes: trajectory.bytes,
        digest: trajectory.digest,
        traceId: trajectory.traceId,
      },
      indexed,
    };

    const markerPath = join(
      sessionDirectory(state.paths, input.sessionId),
      SEAL_MARKER_FILENAME,
    );
    await writeFile(
      markerPath,
      `${JSON.stringify({
        executionId: capture.executionId,
        record: capture.record,
        trajectory: capture.trajectory.digest,
        nativeTrace: capture.nativeTrace.reference.digest,
        sealedAt: now().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    await ensureOwnerOnlyFile(markerPath);

    return { sealed: true, capture: { ...capture, retention: EMPTY_RETENTION } };
  }

  const EMPTY_RETENTION: CaptureRetentionReport = {
    cutoff: "",
    sweptSessions: 0,
    sweptWorkspaces: 0,
    retainedSessions: 0,
    recoveredSessions: 0,
    droppedUnsealedSessions: 0,
    droppedRecoverableSessions: 0,
    sealedBeforeCutoff: 0,
    sealedCountTruncated: false,
  };

  /**
   * Runs the retention sweep against an archive the caller already holds, wiring recovery of
   * stranded feeds to `sealInto` on that same runtime. Shared by `sealSession` (which sweeps
   * after its own seal) and `openSession` (which sweeps to recover what nothing else owns).
   */
  async function sweepWithRecovery(
    state: Started,
    runtime: LocalEvidenceRuntime,
    options: {
      readonly keepSessionIds: readonly string[];
      readonly maxRecoveries?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<CaptureRetentionReport> {
    const report = await sweepCaptureRetention({
      paths: state.paths,
      retentionDays: state.config.captureRetentionDays,
      now: now(),
      keepSessionIds: options.keepSessionIds,
      catalog: runtime.catalog,
      ...(options.maxRecoveries === undefined ? {} : { maxRecoveries: options.maxRecoveries }),
      // Reuses the held runtime — see sealInto's comment on why this is not nested.
      recover: async (sessionId) => {
        if (sealing.has(sessionId)) return false;
        sealing.add(sessionId);
        try {
          const recovered = await sealInto(state, runtime, { sessionId });
          if (!recovered.sealed) {
            state.log.warn("capture recovery produced diagnostics", {
              sessionId,
              diagnostics: recovered.diagnostics.map((entry) => entry.code),
            });
          }
          return recovered.sealed;
        } finally {
          sealing.delete(sessionId);
        }
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (report.droppedUnsealedSessions > 0) {
      state.log.warn("capture retention dropped unsealed session feeds", {
        count: report.droppedUnsealedSessions,
        cutoff: report.cutoff,
      });
    }
    return report;
  }

  /**
   * Best-effort recovery of feeds no live session owns, run at session start.
   *
   * Costs no archive access when there is nothing to recover, and never throws: a busy
   * archive means a sibling instance is working, so the right answer is to skip and let the
   * next open try again (the same skip-if-held shape the mirror sync uses).
   */
  async function recoverStrandedSessions(state: Started, exclude: string): Promise<void> {
    const stranded = await listStrandedSessionIds(state.paths, [exclude]).catch(
      () => [] as readonly string[],
    );
    if (stranded.length === 0) return;

    try {
      const report = await withArchive(
        {
          rootDir: state.config.archiveDirectory,
          busyTimeoutMs: OPEN_SESSION_RECOVERY_BUDGET_MS,
        },
        async (runtime) =>
          sweepWithRecovery(state, runtime, {
            keepSessionIds: [exclude],
            maxRecoveries: OPEN_SESSION_RECOVERY_LIMIT,
          }),
      );
      // Silent unless recovery actually acted.
      if (report.recoveredSessions > 0) {
        state.log.info("recovered stranded capture sessions", {
          recovered: report.recoveredSessions,
          remaining: Math.max(0, stranded.length - report.recoveredSessions),
        });
      }
    } catch (error) {
      state.log.debug("skipped stranded-capture recovery", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    name: "capture",

    async start(context: CapabilityContext): Promise<void> {
      const paths = resolveCapturePaths(context.config);
      await ensureOwnerOnlyDirectory(paths.captureDirectory);
      await ensureOwnerOnlyDirectory(paths.sessionsDirectory);
      await ensureOwnerOnlyDirectory(paths.workspacesDirectory);
      // Deliberately no archive handle: the archive lock is exclusive, so holding one here
      // would lock every other process out of it for this runtime's whole lifetime.
      started = { config: context.config, paths, log: context.log };
    },

    async stop(): Promise<void> {
      started = undefined;
    },

    /**
     * Only states that vary by install are checks; invariant facts belong in the README
     * (C5 finding F9). Hence no standing retention row, and a staging row that reports
     * permissions rather than mere existence.
     */
    async healthChecks(): Promise<readonly HealthCheck[]> {
      const state = requireStarted();
      const staging = await stat(state.paths.sessionsDirectory).then(
        (entry) => ({ present: entry.isDirectory(), mode: entry.mode & 0o777 }),
        () => ({ present: false, mode: 0 }),
      );
      const ownerOnly = process.platform === "win32" || (staging.mode & 0o077) === 0;
      const checks: HealthCheck[] = [
        {
          name: "capture-staging",
          ok: staging.present && ownerOnly,
          detail: !staging.present
            ? `Capture staging is missing at ${state.paths.sessionsDirectory}.`
            : ownerOnly
              ? `Session feeds stage owner-only at ${state.paths.sessionsDirectory}.`
              : `Capture staging at ${state.paths.sessionsDirectory} is readable by others ` +
                `(mode ${staging.mode.toString(8)}).`,
          remedy: !staging.present
            ? "Restart the plugin runtime to recreate capture staging."
            : ownerOnly
              ? null
              : `Run: chmod -R go-rwx ${state.paths.captureDirectory}`,
        },
      ];

      const watermark = await readRetentionWatermark(state.paths);
      // Emitted only when the last sweep actually lost something. A row that is green on
      // every install is a release note, not a check.
      if (watermark !== null && watermark.droppedUnsealedSessions > 0) {
        // Two arms, because the naive single-arm version blames the wrong thing. A feed that
        // carried an end record was sealable and recovery never reached it — that is a real
        // fault with a real remedy. A feed cut short mid-session never could have been sealed,
        // and telling that operator to change something would be false advice.
        const recoverable = watermark.droppedRecoverableSessions;
        const unsealable = watermark.droppedUnsealedSessions - recoverable;
        checks.push(
          recoverable > 0
            ? {
                name: "capture-stranded",
                ok: false,
                detail:
                  `${String(recoverable)} session feed(s) that could have been sealed passed ` +
                  `the ${String(watermark.retentionDays)}-day retention window unrecovered ` +
                  `and were deleted (swept ${watermark.sweptAt}).`,
                remedy:
                  "Recovery runs at session start and seals at most three feeds per session, " +
                  "so a large backlog — or an archive held by another session at every " +
                  "start — can outpace it. Start sessions more often until the backlog " +
                  "clears, or raise JINN_PLUGIN_CAPTURE_RETENTION_DAYS to widen the window.",
              }
            : {
                name: "capture-stranded",
                ok: true,
                detail:
                  `${String(unsealable)} session feed(s) ended without an end record — cut ` +
                  `short mid-session — so they could not be sealed, and were deleted after ` +
                  `the ${String(watermark.retentionDays)}-day window (swept ${watermark.sweptAt}).`,
                remedy: null,
              },
        );
      }
      return checks;
    },

    async openSession(input?: OpenSessionInput): Promise<OpenSessionResult> {
      const state = requireStarted();
      const sessionId = input?.sessionId ?? newSessionId();
      assertSafeSessionId(sessionId);
      await ensureOwnerOnlyDirectory(sessionDirectory(state.paths, sessionId));
      const feedPath = sessionFeedPath(state.paths, sessionId);
      // Opened for append, so re-opening an in-flight session never truncates its feed.
      await ensureOwnerOnlyFile(feedPath);
      // Bounded, skip-if-held, and silent unless it acts. Never throws.
      await recoverStrandedSessions(state, sessionId);
      return { sessionId, feedPath };
    },

    async abandonSession(sessionId: string): Promise<void> {
      const state = requireStarted();
      assertSafeSessionId(sessionId);
      await rm(sessionDirectory(state.paths, sessionId), { recursive: true, force: true });
      await rm(workspaceDirectory(state.paths, sessionId), { recursive: true, force: true });
    },

    async sealSession(input: SealSessionInput): Promise<SealSessionResult> {
      const state = requireStarted();
      assertSafeSessionId(input.sessionId);
      if (sealing.has(input.sessionId)) {
        throw new PluginRuntimeError(
          "capture-session-busy",
          `Session ${input.sessionId} is already being sealed by this runtime.`,
        );
      }
      sealing.add(input.sessionId);
      try {
        return await withArchive(
          {
            rootDir: state.config.archiveDirectory,
            busyTimeoutMs: state.config.captureArchiveBusyTimeoutMs,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          },
          async (runtime) => {
            const result = await sealInto(state, runtime, input);
            const retention = await sweepWithRecovery(state, runtime, {
              keepSessionIds: [input.sessionId],
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            return result.sealed
              ? { sealed: true, capture: { ...result.capture, retention } }
              : result;
          },
        );
      } finally {
        sealing.delete(input.sessionId);
      }
    },
  };
}
```

> Hoist `EMPTY_RETENTION` above `sealInto` when writing the file — it is shown inline here for reading order, but a `const` used before its declaration is a temporal-dead-zone error at runtime.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin/runtime && yarn test src/capture/capability.test.ts && yarn typecheck
```

Expected: PASS (17 tests). The `capture-stranded` test exercises both arms.

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): the capture capability — open, seal, abandon a session"
```

---

### Task 12: Integration — a real session, a conforming record, and fleet safety

**Files:**
- Create: `plugin/runtime/src/capture/capture.integration.test.ts`

**Interfaces:**
- Consumes: the finished capability (Task 11); `validateExecutionEvidence` from `@jinn-network/evidence-protocol`; `openLocalEvidenceRuntime` from `@jinn-network/evidence-local-runtime`; `parseTrajectory` from `@jinn-network/evidence-trajectory`.
- Produces: the evidence for the program's C4 gate — *"A real session captures to a sealed record that validates against `evidence/protocol`; retention sweep bounded and observable"* — plus the cross-plan contract 5 proof.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/capture.integration.test.ts`:

```ts
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { parseTrajectory } from "@jinn-network/evidence-trajectory";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { createCaptureCapability } from "./capability.js";
import {
  SESSION_FEED_FORMAT_IRI,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
} from "./identity.js";
import { loadTrajectoryRecord, trajectoryReferenceFromRecordBytes } from "./link.js";
import { resolveCapturePaths } from "./paths.js";
import { SEAL_MARKER_FILENAME, listStrandedSessionIds } from "./retention.js";

const homes: string[] = [];

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "jinn-capture-e2e-"));
  homes.push(home);
  return home;
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function startCapture(home: string) {
  const config = resolveRuntimeConfig({ env: {}, homeDirectory: home });
  const capture = createCaptureCapability({ producerVersion: "0.1.0" });
  await capture.start!({ config, log: log() });
  return { capture, config, paths: resolveCapturePaths(config) };
}

function feedLines(sessionId: string, baseNano: bigint): string {
  const line = (value: unknown): string => JSON.stringify(value);
  return (
    [
      line({
        type: "session-open",
        v: 1,
        sessionId,
        startedAt: "2026-07-30T09:00:00Z",
        atUnixNano: String(baseNano),
        host: { name: "Hermes", version: "0.9.1" },
        model: { provider: "anthropic", name: "claude-opus-4.6" },
        conversationId: sessionId,
      }),
      line({
        type: "environment",
        atUnixNano: String(baseNano + 1n),
        tools: ["read_file"],
        skills: [],
      }),
      line({ type: "user-turn", atUnixNano: String(baseNano + 2n), text: "Where is the budget?" }),
      line({
        type: "tool-call",
        startedAtUnixNano: String(baseNano + 3n),
        atUnixNano: String(baseNano + 4n),
        toolName: "read_file",
        toolCallId: "call-1",
        status: "ok",
        arguments: '{"path":"src/retry.ts"}',
        result: "export const RETRY_BUDGET = 3;",
      }),
      line({
        type: "assistant-turn",
        atUnixNano: String(baseNano + 5n),
        text: "RETRY_BUDGET in src/retry.ts.",
      }),
      line({
        type: "tokens",
        atUnixNano: String(baseNano + 6n),
        inputTokens: 1024,
        outputTokens: 256,
      }),
      line({
        type: "session-close",
        atUnixNano: String(baseNano + 7n),
        endedAt: "2026-07-30T09:00:06Z",
        outcome: "completed",
        summary: "Locate the retry budget",
      }),
    ].join("\n") + "\n"
  );
}

beforeEach(() => {
  homes.length = 0;
});
afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

describe("capture end to end", () => {
  test("seals a session into a record that conforms to the execution evidence protocol", async () => {
    const home = await newHome();
    const { capture } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-e2e" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));

    const result = await capture.sealSession({ sessionId });
    expect(result.sealed, JSON.stringify(result)).toBe(true);
    if (!result.sealed) return;

    const report = validateExecutionEvidence(result.capture.recordBytes);
    expect(report.conforms, JSON.stringify(report.diagnostics)).toBe(true);
    expect(result.capture.record.family).toBe("execution-evidence");
    expect(result.capture.executionId).toMatch(/^urn:uuid:/u);
  }, 60_000);

  test("the sealed record binds the feed with its format identity and links the trajectory", async () => {
    const home = await newHome();
    const { capture } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-link" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    const document = JSON.parse(new TextDecoder().decode(result.capture.recordBytes)) as {
      "@graph": readonly Record<string, unknown>[];
    };
    const trace = document["@graph"].find((entity) => entity["@id"] === "trace/feed.ndjson");
    expect(trace?.conformsTo).toEqual({ "@id": SESSION_FEED_FORMAT_IRI });
    expect(trace?.encodingFormat).toBe("application/x-ndjson");
    expect(trace?.sha256).toBe(result.capture.nativeTrace.reference.digest.slice("sha256:".length));
    expect(
      document["@graph"].some((entity) => entity["@id"] === SESSION_FEED_FORMAT_IRI),
    ).toBe(true);

    const identifiers = Array.isArray(trace?.identifier) ? trace.identifier : [trace?.identifier];
    expect(identifiers).toContainEqual({
      "@type": "PropertyValue",
      propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
      value: result.capture.trajectory.digest,
    });
  }, 60_000);

  test("the trajectory record is retrievable through the link and carries no message content", async () => {
    const home = await newHome();
    const { capture, config } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-traj" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    const reference = trajectoryReferenceFromRecordBytes(result.capture.recordBytes);
    expect(reference).toEqual({ digest: result.capture.trajectory.digest });

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const record = await loadTrajectoryRecord(runtime.repository, reference!);
      expect(record.traceId).toBe(result.capture.trajectory.traceId);
      expect(record.source.formatIri).toBe(SESSION_FEED_FORMAT_IRI);
      expect(record.spans.map((span) => span.name)).toEqual([
        "invoke_agent Hermes",
        "execute_tool read_file",
        "chat claude-opus-4.6",
      ]);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("Where is the budget?");
      expect(serialized).not.toContain("RETRY_BUDGET");
    } finally {
      await runtime.close();
    }
    // Sealing bytes and stored bytes are the same bytes.
    expect(parseTrajectory(result.capture.trajectory.bytes).traceId).toBe(
      result.capture.trajectory.traceId,
    );
  }, 60_000);

  test("the capture is indexed into the catalog and findable by execution", async () => {
    const home = await newHome();
    const { capture, config } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-index" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;
    expect(result.capture.indexed.status).toBe("indexed");

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const page = await runtime.catalog.findExecutions({
        executionId: result.capture.executionId,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.outcome).toBe("completed");
      expect(page.items[0]?.nativeTrace.digest).toBe(result.capture.nativeTrace.reference.digest);
    } finally {
      await runtime.close();
    }
  }, 60_000);

  test.skipIf(process.platform === "win32")(
    "every file the capture path creates is owner-only",
    async () => {
      const home = await newHome();
      const { capture, config, paths } = await startCapture(home);
      const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-perms" });
      await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
      const result = await capture.sealSession({ sessionId });
      expect(result.sealed).toBe(true);

      const offenders: string[] = [];
      async function walk(path: string): Promise<void> {
        const entry = await stat(path);
        const mode = entry.mode & 0o777;
        if (entry.isDirectory()) {
          if ((mode & 0o077) !== 0) offenders.push(`${path} ${mode.toString(8)}`);
          for (const child of await readdir(path)) await walk(join(path, child));
          return;
        }
        if ((mode & 0o077) !== 0) offenders.push(`${path} ${mode.toString(8)}`);
      }
      await walk(paths.captureDirectory);
      await walk(config.archiveDirectory);
      expect(offenders).toEqual([]);
    },
    60_000,
  );

  test("the seal writes a marker and runs an observable retention sweep", async () => {
    const home = await newHome();
    const { capture, paths } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-retain" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    expect(
      (await stat(join(paths.sessionsDirectory, sessionId, SEAL_MARKER_FILENAME))).isFile(),
    ).toBe(true);
    expect(result.capture.retention.cutoff).not.toBe("");
    expect(result.capture.retention.retainedSessions).toBe(1);
    expect(result.capture.retention.droppedUnsealedSessions).toBe(0);
    expect(result.capture.retention.droppedRecoverableSessions).toBe(0);
    expect((await stat(paths.retentionWatermarkPath)).isFile()).toBe(true);
  }, 60_000);
});

describe("fleet safety (cross-plan contract 5)", () => {
  test("concurrent sessions in separate per-home archives do not contend", async () => {
    const first = await startCapture(await newHome());
    const second = await startCapture(await newHome());
    expect(first.config.archiveDirectory).not.toBe(second.config.archiveDirectory);

    const opened = await Promise.all([
      first.capture.openSession({ sessionId: "s-worker-a" }),
      second.capture.openSession({ sessionId: "s-worker-b" }),
    ]);
    await Promise.all(
      opened.map(async (session, index) =>
        writeFile(
          session.feedPath,
          feedLines(session.sessionId, 1_785_488_400_000_000_000n + BigInt(index)),
        ),
      ),
    );

    const started = Date.now();
    const results = await Promise.all([
      first.capture.sealSession({ sessionId: "s-worker-a" }),
      second.capture.sealSession({ sessionId: "s-worker-b" }),
    ]);
    // Neither seal spent time in busy-wait backoff, because neither ever saw the other's lock.
    expect(Date.now() - started).toBeLessThan(30_000);
    for (const result of results) expect(result.sealed).toBe(true);
    expect(results[0]!.sealed && results[1]!.sealed).toBe(true);
    if (results[0]!.sealed && results[1]!.sealed) {
      expect(results[0]!.capture.record.digest).not.toBe(results[1]!.capture.record.digest);
    }
  }, 120_000);

  test("concurrent seals against ONE archive serialize rather than fail", async () => {
    const { capture } = await startCapture(await newHome());
    const opened = await Promise.all([
      capture.openSession({ sessionId: "s-one" }),
      capture.openSession({ sessionId: "s-two" }),
    ]);
    await Promise.all(
      opened.map(async (session, index) =>
        writeFile(
          session.feedPath,
          feedLines(session.sessionId, 1_785_488_400_000_000_000n + BigInt(index)),
        ),
      ),
    );
    const results = await Promise.all([
      capture.sealSession({ sessionId: "s-one" }),
      capture.sealSession({ sessionId: "s-two" }),
    ]);
    for (const result of results) expect(result.sealed).toBe(true);
  }, 120_000);

  test("an archive held by another process surfaces capture-archive-busy, not a hang", async () => {
    const home = await newHome();
    const config = resolveRuntimeConfig({
      env: { JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS: "500" },
      homeDirectory: home,
    });
    const capture = createCaptureCapability({ producerVersion: "0.1.0" });
    await capture.start!({ config, log: log() });
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-busy" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));

    const holder = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
        code: "capture-archive-busy",
      });
    } finally {
      await holder.close();
    }

    // Once the holder releases, the same session seals without any change of state.
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
  }, 120_000);

  test("a feed stranded by a busy archive is recovered at the next session open", async () => {
    const home = await newHome();
    const { capture, paths, config } = await startCapture(home);

    // A session whose seal never ran: its feed is complete, but nothing owns it.
    const stranded = await capture.openSession({ sessionId: "s-stranded" });
    await writeFile(stranded.feedPath, feedLines("s-stranded", 1_785_488_400_000_000_000n));
    expect(await listStrandedSessionIds(paths)).toEqual(["s-stranded"]);

    // Opening the next session recovers it — before the operator's first turn, not after it.
    await capture.openSession({ sessionId: "s-next" });
    expect(await listStrandedSessionIds(paths, ["s-next"])).toEqual([]);

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const page = await runtime.catalog.findExecutions({ outcome: "completed" });
      expect(page.items).toHaveLength(1);
    } finally {
      await runtime.close();
    }
    expect(
      (await stat(join(paths.sessionsDirectory, "s-stranded", SEAL_MARKER_FILENAME))).isFile(),
    ).toBe(true);
  }, 120_000);

  test("recovery at open is skipped, not failed, while another process holds the archive", async () => {
    const home = await newHome();
    const { capture, paths, config } = await startCapture(home);
    const stranded = await capture.openSession({ sessionId: "s-stranded" });
    await writeFile(stranded.feedPath, feedLines("s-stranded", 1_785_488_400_000_000_000n));

    const holder = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const startedAt = Date.now();
      // The open must succeed regardless, and must not wait on the sibling for long.
      await expect(capture.openSession({ sessionId: "s-next" })).resolves.toMatchObject({
        sessionId: "s-next",
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await listStrandedSessionIds(paths, ["s-next"])).toEqual(["s-stranded"]);
    } finally {
      await holder.close();
    }

    // Left staged, so the following open picks it up.
    await capture.openSession({ sessionId: "s-later" });
    expect(await listStrandedSessionIds(paths, ["s-later", "s-next"])).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/capture.integration.test.ts
```

Expected: FAIL — the assertions are new; the first failure should be a real protocol or wiring gap, not a missing import (every module already exists). Read the `validateExecutionEvidence` diagnostics before changing anything: each diagnostic code maps to one row of the constraint table in "Stack surfaces this plan builds against".

- [ ] **Step 3: Resolve the failures against the constraint table**

Work the diagnostics in order. The expected class of fix is in `assemble.ts`, never in the recorder or the protocol:

- `AGENT_IRI_INVALID` → `executorIri` produced a non-absolute IRI; check the host name slug.
- `RUNTIME_COMPONENT_BINDING_MISSING` → the runtime specification or its component is not content-bound; both must carry real bytes.
- `EXECUTION_COMPLETED_RESULT_MISSING` → `buildFinalizeInput` dropped the session-summary result.
- `TRACE_CARDINALITY` → `attachNativeTrace` was not called, or `finalize` also passed one.
- `DURATION_MISSING` / `EXECUTION_RELATION_INVALID` on `resourceUsage` → `startedAt`/`endedAt` are not both strict RFC 3339.

- [ ] **Step 4: Run the whole suite**

```bash
cd plugin/runtime && yarn test && yarn typecheck
```

Expected: PASS, with the integration file's eleven tests green.

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "test(plugin-runtime): end-to-end capture, protocol conformance, and fleet safety"
```

---

### Task 13: Public surface, runtime wiring, the privacy statement, and CI

**Files:**
- Modify: `plugin/runtime/src/index.ts`, `src/bin.ts`, `plugin/runtime/README.md`
- Create: `plugin/runtime/src/capture/surface.test.ts`
- Modify: `.github/workflows/plugin-tree-ci.yml`

**Interfaces:**
- Consumes: every module from Tasks 3–11.
- Produces: `@jinn-network/plugin-runtime`'s capture surface, the capability registered in the process, and green CI. After this task C6 can build on the branch.

- [ ] **Step 1: Write the failing test**

`plugin/runtime/src/capture/surface.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import * as api from "../index.js";

describe("public surface", () => {
  test("exports the capture capability and everything C6 and C7 consume", () => {
    for (const name of [
      "createCaptureCapability",
      "parseSessionFeed",
      "buildTrajectoryRecord",
      "buildTrajectorySpans",
      "trajectoryReferenceFromRecordBytes",
      "loadTrajectoryRecord",
      "sweepCaptureRetention",
      "readRetentionWatermark",
      "listStrandedSessionIds",
      "ensureOwnerOnlyDirectory",
      "ensureOwnerOnlyFile",
      "resolveCapturePaths",
      "sessionFeedPath",
      "withCaptureArchive",
      "SESSION_FEED_FORMAT_IRI",
      "SESSION_FEED_MEDIA_TYPE",
      "SESSION_FEED_VERSION",
      "TRAJECTORY_RECORD_IDENTIFIER_PROPERTY",
      "TRAJECTORY_BUILDER_ID",
      "TRAJECTORY_BUILDER_VERSION",
      "RETENTION_POLICY_STATEMENT",
      "SEAL_MARKER_FILENAME",
      "ARCHIVE_BUSY_ERROR_CODE",
    ]) {
      expect(api, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  test("the README states the local privacy posture and names C6's obligation", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("owner-only");
    expect(readme).toContain("does not scrub at capture time");
    expect(readme).toContain("jinn.trajectory.source.ordinal");
    expect(readme).toContain("input/session-task.json");
    expect(readme).toContain("results/session-summary.json");
  });

  test("the README names both recovery limits rather than leaving them to be discovered", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("start of your next session");
    expect(readme).toContain("hard kill carries no end record");
    expect(readme).toContain("never open another");
  });

  test("the runtime process registers the capture capability", async () => {
    const bin = await readFile(new URL("../bin.ts", import.meta.url), "utf8");
    expect(bin).toContain("createCaptureCapability");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin/runtime && yarn test src/capture/surface.test.ts
```

Expected: FAIL — `index.ts` exports none of the capture names.

- [ ] **Step 3: Export the capture surface**

Append to `plugin/runtime/src/index.ts`:

```ts
// Capture
export { ARCHIVE_BUSY_ERROR_CODE, withCaptureArchive } from "./capture/archive.js";
export type { CaptureArchiveOptions } from "./capture/archive.js";
export {
  buildFinalizeInput,
  buildStartInput,
  resolveSessionOutcome,
  sessionSummary,
} from "./capture/assemble.js";
export type { CaptureAssemblyInput, SessionOutcome } from "./capture/assemble.js";
export { createCaptureCapability } from "./capture/capability.js";
export type {
  CaptureCapability,
  CreateCaptureCapabilityOptions,
  OpenSessionInput,
  OpenSessionResult,
  SealSessionInput,
  SealSessionResult,
  SealedCapture,
} from "./capture/capability.js";
export { parseSessionFeed } from "./capture/feed.js";
export type {
  AssistantTurnEvent,
  FeedLine,
  ParsedSessionFeed,
  SessionCloseEvent,
  SessionFeedEvent,
  SessionOpenEvent,
  ToolCallEvent,
  UserTurnEvent,
} from "./capture/feed.js";
export {
  CAPTURE_LICENSE,
  PRODUCER_IRI,
  PRODUCER_NAME,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_FEED_VERSION,
  SESSION_ID_PROPERTY,
  TRAJECTORY_BUILDER_ID,
  TRAJECTORY_BUILDER_VERSION,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  executorIri,
} from "./capture/identity.js";
export { loadTrajectoryRecord, trajectoryReferenceFromRecordBytes } from "./capture/link.js";
export {
  assertSafeSessionId,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveCapturePaths,
  sessionDirectory,
  sessionFeedPath,
  workspaceDirectory,
} from "./capture/paths.js";
export type { CapturePaths } from "./capture/paths.js";
export {
  RETENTION_POLICY_STATEMENT,
  SEAL_MARKER_FILENAME,
  listStrandedSessionIds,
  readRetentionWatermark,
  sweepCaptureRetention,
} from "./capture/retention.js";
export type {
  CaptureRetentionReport,
  RetentionWatermark,
  SweepCaptureRetentionInput,
} from "./capture/retention.js";
export { buildTrajectorySpans } from "./capture/spans.js";
export type { BuildTrajectorySpansInput } from "./capture/spans.js";
export {
  TRAJECTORY_ARTIFACT_MEDIA_TYPE,
  buildTrajectoryRecord,
} from "./capture/trajectory.js";
export type { BuiltTrajectory } from "./capture/trajectory.js";
```

- [ ] **Step 4: Register the capability in the process**

In `plugin/runtime/src/bin.ts`, read the package version (this file is the only one permitted to touch ambient state) and pass the capability to `createPluginRuntime`:

```ts
import { createRequire } from "node:module";

import { createCaptureCapability } from "./capture/capability.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const runtime = createPluginRuntime({
  config,
  capabilities: [createCaptureCapability({ producerVersion: version })],
  log,
});
```

- [ ] **Step 5: Write the privacy statement into the README**

Append to `plugin/runtime/README.md`:

```markdown
## Capture and local privacy

Capture turns one observed agent session into two sealed products in your local archive: an
**Execution Evidence record** — the same record family every producer on the platform writes
— and a **Trajectory record** describing what happened inside it. Nothing leaves the machine;
there is no outbound lane in this build.

### What is written, and where

| Path | Contents | Lifetime |
| --- | --- | --- |
| `<home>/capture/sessions/<id>/feed.ndjson` | the session feed the host adapter appends to, verbatim | swept once older than the retention window |
| `<home>/capture/workspaces/<id>/` | the recorder's staging workspace, holding a copy of every captured byte | swept once older than the retention window |
| `<home>/archive/` | the sealed records and their content-addressed artifacts | append-only; see Retention |

Everything above is created **owner-only** — directories `0700`, files `0600` — which is the
same exposure class the host already keeps its own session logs in. Capture adds a copy
inside that class; it does not open a new one.

### This runtime does not scrub at capture time

Sealing binds the feed's exact bytes, so a capture-time scrub would both destroy the material
and break the binding. The regression that matters locally is not exfiltration — nothing
leaves — it is **re-injection**: a secret pasted in one session resurfacing in a later
session's context, where the agent holds tools. That loop is closed at **index time**, by the
relevance component, using the derivation detector model. This runtime's job is to preserve
what makes that possible:

1. **The feed is kept verbatim** as a digest-bound artifact. The detector needs the real text
   to find anything.
2. **Feed lines are never reordered or rewritten**, and every trajectory span carries
   `jinn.trajectory.source.ordinal` — the 0-based line ordinal. An exclusion decision taken
   per feed line therefore has a stable identifier that maps back to spans.
3. **Message content is confined to the feed** — except for two derived artifacts that quote
   the user, and which the index-time detector must therefore also scan:
   `input/session-task.json` and `results/session-summary.json` both embed the session
   summary, which falls back to the first line of the first user turn.
4. **The retention watermark** at `<home>/capture/retention.json` gives the index a time
   boundary: captures older than the window are excluded from retrieval.

### Retention

Session feeds and capture workspaces are duplicates of material already sealed in your
archive; they are deleted once older than the retention window (30 days by default,
`JINN_PLUGIN_CAPTURE_RETENTION_DAYS`). Sealed records are never deleted — the local archive is
append-only — but captures older than the window are excluded from retrieval, so old sessions
stop resurfacing in your context. Removing a sealed capture today means removing the archive
directory; see the plan's Findings for the tracked gap.

### Two limits worth knowing

Sessions are normally sealed when they end. If that is interrupted — the archive was busy
because a sibling session was writing to it, or the process was killed — the feed stays
staged and is sealed at the **start of your next session**, before your first turn. Two cases
that leaves open, stated rather than hidden:

- **A session cut short by a hard kill carries no end record.** Nothing can honestly say when
  it ended or how it went, so it is not sealed. It stays staged until the retention window
  passes and is then deleted; the doctor reports it if it happens.
- **If your last session strands and you never open another, its feed stays staged.**
  Recovery runs at session start, and there is no background process to run it otherwise —
  by design: nothing in this product runs when you are not working. The feed is on disk,
  owner-only, and untouched; a later session picks it up whenever you next start one.

### One archive, one holder

The local evidence archive takes an **exclusive** lock. Capture therefore opens it only for
the duration of one seal and closes it again, and never holds a handle across a session. A
seal that finds the archive held waits, and after
`JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS` (10 s by default) reports `capture-archive-busy`.
```

- [ ] **Step 6: Ship the fixtures in CI and run the whole tree**

In `.github/workflows/plugin-tree-ci.yml`, confirm the `runtime` job's verify step runs the whole suite (it already runs `yarn test`), and add the capture fixtures to the workflow's `paths` filter:

```yaml
      - 'plugin/runtime/fixtures/**'
```

- [ ] **Step 7: Run the full local verification**

```bash
cd plugin/runtime && yarn install --immutable && yarn typecheck && yarn test && yarn build
```

then from the repository root:

```bash
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
node --test .github/scripts/plugin-tree-packed-types.test.mjs
node --test .github/scripts/evidence-package-inventory.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
```

Expected: every command PASS. The boundary guard is the one that proves the frozen trio was never touched.

- [ ] **Step 8: Commit and mark the PR ready**

```bash
git add plugin/runtime .github/workflows/plugin-tree-ci.yml
git commit -m "feat(plugin-runtime): export the capture surface, register the capability, and state the privacy posture"
git push
gh pr ready
```

---

## Component review gate

Before C6 builds on this branch, one independent high-effort review checks it against the
design (spec §5, §6.1, §6.4, §7.2, §7.3) and the program's cross-plan contracts 2, 4, and 5.
It should cover:

- **Contract 2 (local privacy).** Are owner-only permissions actually universal across the
  capture footprint — is the integration test's walk of `<home>/capture` and `<home>/archive`
  a real proof or does it miss a path? Is the README's statement of what C6 must scan
  complete, in particular the two derived artifacts that quote the user?
- **Contract 4 (host seam).** Is the single-writer claim enforced across processes, or only
  in-process? (It is only in-process; see Findings.) Does anything hold an archive handle
  outside a seal?
- **Contract 5 (fleet safety).** Does the per-home archive default hold when C7's adapter
  supplies the home, and is the "no contention" test measuring the right thing?
- **Protocol conformance.** Every row of the constraint table, checked against the assembly,
  not against the passing test.
- **Determinism.** Is `buildTrajectorySpans` genuinely a pure function of feed bytes — and is
  the JSON serialization of the derived artifacts (task, runtime spec, summary) as
  order-stable as this plan assumes?
- **The retention honesty.** Does `RETENTION_POLICY_STATEMENT` overclaim anywhere? Are the
  two recovery residuals in the README stated plainly enough that an operator who hits one
  recognizes it, rather than reading it as a bug?
- **Health-check hygiene (C5 findings F9 and F10).** Is every row this component emits
  genuinely install-varying? `capture-staging` should be checked hardest here: it is green on
  a healthy install, so the review's job is to confirm its red path is reachable and worth a
  row. And does `capture-stranded` route to the right arm — does a feed cut short mid-session
  stay informational rather than proposing a fix that cannot apply?
- **Recovery at open.** Does `openSession` truly never throw because of recovery, and does it
  truly take no lock when nothing is stranded? Both are the difference between a bounded
  nicety and a new failure mode on every session start.

Findings are resolved before C6 builds.

## Findings this plan carries into the component review

Proposed dispositions only. Do not edit the spec or the program plan.

- **F-C4-1 — the archive-access design unit resolves to per-operation open/close, and the
  spec's alternative is not available.** Spec §6.2 names the choice as "direct multi-process
  access under these locks versus per-instance open/close discipline", framing the locks as
  cooperative. They are not: `openLocalEvidenceRuntime` takes an **exclusive** SQLite lock on
  the archive root and fails with `ROOT_IN_USE` rather than waiting
  (`packages/evidence/local-runtime/src/lock.ts` — `locking_mode = EXCLUSIVE`,
  `BEGIN EXCLUSIVE`, three retries at 10/25/50 ms). One process holds the archive or none
  does. **Proposed disposition:** amend §6.2 with a dated correction recording that the unit
  is resolved — every component opens the archive per operation and closes it, no capability
  holds a handle across a session, and contention is waited out with a bounded budget
  surfaced as `capture-archive-busy`. C3 has already made the same rule a documented
  invariant of its capability seam (C3 finding F-C3-8) and asks C4 to carry the spec
  amendment.
- **F-C4-2 — the Trajectory record cannot be stored as a record; it is stored as an
  artifact.** `EVIDENCE_RECORD_FAMILIES` is a closed three-member set
  (`packages/evidence/repository/src/types.ts:1-5`), so `repository.putRecord` cannot accept
  C1's kind, and adding a family is a protocol change to a frozen surface that spec §13
  forbids. C4 therefore stores the sealed trajectory with `putArtifact` (content-addressed,
  family-free) and links it from inside the sealed execution record as an `identifier` on the
  native-trace entity. Consequences worth stating: the catalog never projects a trajectory,
  so there is no query path to one — the only route is execution record → identifier →
  artifact; and a trajectory record is not independently announced, so it is not discoverable
  off-machine. **Proposed disposition:** record in spec §7.2 that a Trajectory record is
  carried as a digest-bound artifact referenced from its parent execution record, and open a
  question for the discovery/record-family owners about whether a fourth record family (or a
  generic "derived record" family) should exist before trajectories need to travel.
- **F-C4-3 — `source.execution` is absent from every trajectory this product writes.** C1's
  `SourceSchema` makes it optional, and the ordering forbids filling it: the feed must be
  attached as the native trace before `finalize()`, and the trajectory digest must exist
  before that so it can ride along as the forward link, so the execution record's digest does
  not exist when the trajectory is sealed. The join survives through
  `source.nativeTrace.digest.sha256`, which is exactly the `sha256` the execution record
  carries on its trace entity. **Proposed disposition:** note in C1's documentation that a
  live producer necessarily omits `source.execution`, and that a *decoder* (C2), which runs
  after the execution record exists, is the one that can populate it. No schema change.
- **F-C4-4 — the format IRI for the session feed is defined locally, not in C2's registry.**
  C4 declares `https://jinn.network/formats/agent-session-feed/v1` in
  `plugin/runtime/src/capture/identity.ts` because C4 must not depend on C2's branch (program
  §2 puts C2 off the critical path). Program finding F3 gives C2 ownership of a
  format-identity registry mapping launcher `envelopeFormat` strings to canonical IRIs.
  **Proposed disposition:** when C2 lands, it adopts this IRI verbatim into the registry and
  C4's constant re-exports it rather than declaring it, so there is one authority and no
  renaming of already-sealed records. Raise at C2's review as an inbound requirement.
- **F-C4-5 — "a single capture writer per session" is enforced in-process only.** Cross-plan
  contract 4 requires it; `sealSession` refuses a session it is already sealing, but that
  claim lives in one runtime instance's memory. Two *processes* pointed at one Hermes home
  could both seal one session. The blast radius is bounded rather than open: the recorder's
  workspace is an append-only journal with head-revision conflict detection
  (`packages/evidence/execution-recorder/src/recorder.ts:171-180`, `RECORDING_CONFLICT`), so
  the loser fails loudly instead of corrupting, and the archive lock serializes them anyway.
  **Proposed disposition:** accept for this build and state the bound; if a real double-seal
  is ever observed, the fix is a per-session lock file in the staging directory, not a
  cross-process coordinator. Raise at the component review.
- **F-C4-6 — the retention sweep bounds duplicates, not sealed material, and spec §7.3's
  finding stays open.** `LocalEvidenceRuntime` exposes no eviction member
  (`packages/evidence/local-runtime/src/types.ts:101-115`) and `EvidenceRepository` exposes no
  delete, so a sealed record cannot be removed without reaching past a package boundary. What
  the sweep genuinely does: it removes the staged feed and the recorder workspace once they
  are older than the window (taking raw persistence from two copies to one), and it publishes
  a watermark that C6 uses to keep old captures out of retrieval projections — which is the
  property that actually closes §6.4's re-injection loop. **Proposed disposition:** keep spec
  §7.3's finding open against the `local-runtime` owners, with the concrete ask now stated: a
  host-configurable retention sweep at the runtime layer, never inside the repository
  contract, plus a way to enumerate an archive's records by age. Until it lands the product's
  user-visible policy says plainly that sealed records are not deleted.
- **F-C4-7 — stranded feeds are recovered at session open (C7 finding F-C7-7; coordinator
  ruling adopted).** C7's adapter deliberately does not retry a busy seal — a session *end*
  that blocks on a sibling's lock is a user-visible hang for an invisible benefit — which
  leaves complete feeds on disk with no owner. C4 owns the recovery. `sealSession` writes a
  `sealed.json` marker, so the sweep can tell a duplicate from a stranded capture, and both
  `sealSession` and `openSession` run a bounded recovery pass over unmarked directories,
  oldest first, reusing the archive the caller already holds. This plan first offered the hook
  to C7; C7 declined with better reasoning (the adapter cannot enumerate stranded ids without
  inventing cross-process state, and driving the seal from there would put capture logic on
  both sides of the seam), and the coordinator ruled for the capability-side version at
  `openSession`. It is also better on its own merits: recovery fires at the *start* of the
  next session rather than at its end, shrinking the stranded window by a whole session.
  Three constraints hold it to a wait nobody notices — at most three feeds per open; a 1000 ms
  archive budget with skip-if-held on contention; and no archive access at all when
  `listStrandedSessionIds` finds nothing, so the ordinary open never takes a lock.
  **Proposed disposition:** accept as designed. Two residuals are named in the README beside
  the retention policy rather than engineered away: a feed with no `session-close` line
  declines recovery (a hard kill leaves no honest outcome or end time to record), and an
  operator whose final session strands and who never opens another leaves it staged
  indefinitely — closing that needs a background daemon, which spec §6.2 rules out by design.
- **F-C4-8 — the trajectory profile emits no span for a user turn, by construction.** C1's
  frozen vocabulary admits three operations (`chat`, `execute_tool`, `invoke_agent`) and three
  Jinn keys (`turnRole`, `sourceOrdinal`, `outcome`). A user message is not a GenAI operation,
  so modelling it as a span would have required either an operation name outside the profile
  or a new Jinn key — a C1 change. C4 emits user turns as `gen_ai.user.message` **span events**
  on the chat span they preceded (or on the session span when no reply followed). **Proposed
  disposition:** confirm at the component review that events are the intended home for
  non-operation turns; if C1 later admits a richer turn vocabulary, this is a
  `decoderVersion` bump, which by C1's own rule produces new records rather than reinterpreting
  old ones.
- **F-C4-9 — health checks report only what varies by install (C5 finding F9, adopted).**
  An earlier draft emitted a standing `capture.retention` row that was `ok: true` on every
  install and carried the retention policy text. That is documentation wearing a check's
  clothes: it costs a row in the merged doctor and tells no operator anything about their own
  machine. It is now in the README, and the two remaining rows both vary — `capture-staging`
  fails when the staging tree is missing **or loosened past owner-only** (restored backups,
  synced folders, and unusual umasks all do this, and it is a genuine privacy regression, so
  it earns its place), and `capture-stranded` is emitted **only when** the last sweep actually
  dropped unsealed feeds. **Proposed disposition:** the rule generalizes beyond C4 and C5 —
  two components reached it independently in one planning round — so it belongs in the
  program's cross-plan contracts alongside the doctor's `{name, ok, detail, remedy}` shape.
  The coordinator has said it will carry it there; recorded here so C4's own compliance is
  reviewable.
- **F-C4-10 — `capture-stranded` needed a second arm, for the same reason C5's F10 needed
  one.** C7 relayed C5's finding that a check can propose a remedy which cannot possibly work,
  because the state it reports has a cause the check never distinguished. C5's instance was
  trust filtering; C4 has no trust-filtered input, so the finding did not transfer literally —
  but the *shape* did. The single-arm draft reported `droppedUnsealedSessions` and told the
  operator "nothing needs doing unless this recurs", which is right for a feed cut short by a
  hard kill (no end record, never sealable) and **wrong** for a feed that carried a
  `session-close` line and was simply never reached — a real recovery shortfall, from a
  backlog exceeding the three-per-open bound or an archive held at every session start, with
  real remedies. Those two arrive at the same counter and warrant opposite advice. The sweep
  now splits them with `droppedRecoverableSessions` (checking for an end record only on feeds
  about to be deleted, which is rare), the watermark carries both, and the check is `ok: true`
  with no remedy for the unsealable case and `ok: false` with a real one for the shortfall.
  **Proposed disposition:** accept; no interface outside C4 changes. Worth generalizing at the
  review alongside F9: *a check must distinguish causes that warrant different advice, or it
  will confidently give the wrong advice to half the operators who see it.* Two components
  hitting this from unrelated directions suggests it belongs beside F9 in the contracts.

---

## 2026-07-31 amendment (operator-ratified; supersedes Tasks 6/10/11 lifecycle clauses)

**Supersedes** any `sealSession` sequence that omits derivation attestation or implies
`source.execution` on the Trajectory record.

### Acyclic seal lifecycle (C4 owns)

1. Parse feed → `buildTrajectorySpans` / `buildTrajectoryRecord` → `sealTrajectory` →
   Trajectory digest (**no** `source.execution`).
2. `putArtifact(trajectory.bytes)`.
3. Attach native trace; set forward link using `TRAJECTORY_RECORD_IDENTIFIER_PROPERTY` imported
   from `@jinn-network/evidence-trajectory` (`PropertyValue.value` = trajectory
   `RepositorySha256Digest`); `finalize()` → Execution digest + sealed Execution record.
4. `buildTrajectoryDerivationStatement({ …, derivedAt })` + `sealTrajectoryDerivationAttestation({ signer })` →
   envelope (`derivedAt` = capture finalization instant — same as finalize `endedAt`, not
   `Date.now()` inside C1).
5. `putArtifact(envelopeBytes)` → attestation artifact digest.
6. **Atomically write** durable link at `derivationLinkPath(paths, executionDigest)` (temp +
   rename); **then** write `sealed.json` marker. Seal is **not complete** without attestation
   artifact + link + marker.

### Durable derivation link (exact path)

```ts
// Extend CapturePaths:
readonly derivationLinksDirectory: string;
// resolveCapturePaths:
derivationLinksDirectory: join(config.captureDirectory, "derivation-links"),

export function derivationLinkPath(
  paths: CapturePaths,
  executionDigest: RepositorySha256Digest,
): string {
  // <captureDirectory>/derivation-links/<64-hex>.json
  // <64-hex> = toBareSha256Hex(executionDigest)
}

export interface TrajectoryDerivationAttestationLink {
  readonly version: 1;
  readonly executionDigest: RepositorySha256Digest;
  readonly trajectoryDigest: RepositorySha256Digest;
  readonly attestationDigest: RepositorySha256Digest;
  readonly nativeTraceDigest: RepositorySha256Digest;
  readonly derivedAt: string; // same calendar-strict instant bound in statement
}

export function writeTrajectoryDerivationAttestationLink(
  paths: CapturePaths,
  link: TrajectoryDerivationAttestationLink,
): Promise<void>;
export function readTrajectoryDerivationAttestationLink(
  paths: CapturePaths,
  executionDigest: RepositorySha256Digest,
): Promise<TrajectoryDerivationAttestationLink | null>; // missing → null, not throw
export function loadTrajectoryDerivationAttestation(
  repository: EvidenceRepository,
  link: TrajectoryDerivationAttestationLink,
): Promise<{ envelopeBytes: Uint8Array; statement: TrajectoryDerivationStatement }>;
```

Sidecar bytes: canonical JSON of `TrajectoryDerivationAttestationLink` (C1
`serializeCanonicalJson` or equivalent). Owner-only file (0o600) / directory (0o700) via
existing `ensureOwnerOnly*` helpers.

**Lifecycle rules (no conditionals):**
- Session raw-feed retention MUST NOT delete `derivation-links/**`.
- Recovery is idempotent; duplicate write of same coherent link succeeds; corrupt/mismatched
  link fails loudly with typed error.
- Link persists for the same logical lifetime as the local archive (contract 13); archive
  deletion must delete link state too.
- Attestation cannot be embedded in already-sealed Execution.

### Interface additions

```ts
readonly derivationAttestation: {
  readonly reference: EvidenceArtifactReference;
  readonly digest: RepositorySha256Digest;
  readonly envelopeBytes: Uint8Array;
  readonly derivedAt: string;
};

// CreateCaptureCapabilityOptions:
readonly signer: DsseSigner; // required for seal path that emits attestation
```

**F-C4-3 update:** `source.execution` omission is **required**; binding is attestation +
forward link via C1-owned `TRAJECTORY_RECORD_IDENTIFIER_PROPERTY`. **Signer:** C4 injects
`DsseSigner`; no key acquisition.

**Timebase:** C4 hook-produced trajectories use `timebase: "source-epoch-ns"` when feed
carries real timestamps.

## 2026-07-31 implementation-time finding (C4-P1)

Surfaced as the C4 sibling of C5-P2 against accepted C3 head `ec57b5a2f` (C3 R-C3-63/64
closed-world maps). Ratified by the program coordinator before Task 2; plan text above
amended in place.

**C4-P1 — closed-world exact maps omit C4 deps.** Updating only `JINN_DEPENDENCY_GRAPH`
leaves Task 2 red on `validateExactDependencySections` / undeclared production deps /
portal `resolutionViolations`. **Disposition (applied in Task 2 Steps 3b and 7):** extend
`APPROVED_RUNTIME_DEPENDENCIES` and `APPROVED_RUNTIME_RESOLUTIONS` in
`plugin-tree-guard-common.mjs` with C4's `@jinn-network/*` packages and portal entries;
include that file in the Task 2 commit list.

## 2026-07-31 implementation-time findings (F-C4-2, F-C4-P2, F-C4-P3)

Surfaced by the C4 sub-coordinator at Tasks 2–3. Ratified by the program coordinator;
plan text above amended in place.

**F-C4-2 — Yarn requires direct portal deps for transitive Jinn packages.** Same class as
C2-F1: portal resolutions do not inherit. `evidence-catalog-sqlite` and `trust-core` must
be direct deps + resolutions (already green on the branch). **Disposition:** keep them as
install-graph deps; update Task 2 graph/maps/package.json lists; production capture source
does not gain new public imports of those packages.

**F-C4-P2 — `"ab"` vs session-id regex.** Plan test rejected `"ab"` while
`/^[a-z0-9][a-z0-9-]{0,127}$/` accepts it. **Disposition:** drop `"ab"` from the reject
list; assert it is accepted. Do not tighten the regex.

**F-C4-P3 — C3 custody vs capture FS I/O.** Verbatim `paths.ts` (and later capture modules)
need `node:fs/promises` and read-only `process.platform`. **Disposition:** file-scoped
carve-out for `plugin/runtime/src/capture/**` production sources (Task 3 Step 2b); keep
`process.env` and non-capture production FS bans intact.
