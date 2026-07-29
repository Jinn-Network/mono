# Benchmarking Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-28
**Status:** draft (pending program-extension approval — code for the new components starts only on explicit operator "yes", program §9)
**Shape:** `feat`
**Implements:** `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` (v0.3), following its §18 internal sequence and §15 package shape exactly.
**Program:** `docs/superpowers/plans/2026-07-28-stack-implementation-program.md` — §6 naming, the §7 seventeen-plus binding rulings, and the §9 ledger (benchmarking added as a designed component; program extension appends the benchmarking phases in dependency order).
**Dependencies on sibling 2026-07-28 plans (consumed as real, not re-planned):**
- `2026-07-28-task-execution-protocol.md` — **PRESENT/green on this branch.** Exports consumed: `serializeCanonicalJson`, `documentDigest`, `compareCodeUnitStrings`, `sha256Hex`, `assertIJsonInteger`, `IJsonNumberError`, `ResourceDescriptor`, `EvidenceRecordReference`, `sealTask`/`sealSubmission`/`sealDelivery`, `mergeRequirements`, `EffectiveRequirements`, `ComparisonClass`, the Task/Submission/Delivery/observation schemas + validators, `foldObservations`, `AttemptDescriptor`, the run-pinning vocabulary (`harness`/`model`/`loadout`/`isolationPolicy`) in `common.ts`. **Attempt identity (program §7.22):** local single-party cell dispatch (M4 `run`) commits to the on-branch **2-arg `submit(taskBytes, submissionBytes)`** — the backend **mints** the Attempt URI, and the run reads it back from the `SubmissionAck`/`observe` surface (the materialized `AttemptDescriptor`, program §7.16) into the Matrix `attempt` field; resumption idempotency rides the stable Submission digest + `cellIdempotencyKey`, never a re-derived Attempt. The deterministic-Attempt-URI derivation exports (`deriveAttemptUri`, `TEP_ATTEMPT_NAMESPACE`, `isValidUrnUuid`) are a **two-party** concern owned by the marketplace binding (program §7.2 — the binding consumes the exported constant; it never re-derives its own) and enter benchmarking **only** in M7 marketplace mode, via the binding + `engagement` param — not imported by local `run`.
- `2026-07-28-task-execution-profiles.md` — **ABSENT on this branch (Phase 3, in flight).** Exports consumed (kit + run + interop + aggregate, NOT records): `EvaluationSpec`/`sealEvaluationSpec`/`parseEvaluationSpec`, `checkVerdictConsistency`, `evaluateVerdictRule`, `requiredMeasurementNames`, the `repository-work/1.0` builder `buildRepositoryWorkProfile`, `buildEvaluationTaskProfile`, the `provenance` block shape (`kind`, blindable `sourceCommitment`), the §7.7 spec-digest equality rule (named here `verdict-spec-match`).
- `2026-07-28-record-discovery.md` — **ABSENT on this branch (Phase 3, in flight).** Exports consumed by the facts leaf only: `record-discovery-protocol`'s `FactsProfileDocument`/`FactsProfileField`/`parseFactsProfile`, `sealJson`, `assertRecordKindUri`, the `FactsRecompute`/`RecordFactRecompute`/`ReferencedBytes` port shapes; `record-discovery-testing`'s facts-consistency conformance driver. The `benchrun`/`benchcell`/`bencharm` **Submission/Delivery** facts fields are **already recorded as Addendum 2026-07-28-b on the record-discovery plan and built by its M8 `facts/task-execution` leaf** — this plan REFERENCES them and does NOT re-plan them (§17.5). This plan owns only the `facts/benchmarking` leaf + the CloudEvents filter attributes on the four **benchmarking** record kinds.
- `2026-07-28-marketplace-binding.md` — **NOT YET DRAFTED** (only the design `2026-07-28-marketplace-binding-design.md` exists). The marketplace-mode milestone (M7, LAST) gates on that plan and on the marketplace binding + projector packages existing; it composes against the design's §11 frozen interfaces (the `TaskExecutionBackend` peer, venue verbs discover/claim/deliver/settle, projector derivation annotations, the anchored close boundary). See Findings F2.

**Goal:** Ship the backend-neutral benchmarking application — four sealed tier-2 record kinds (Benchmark, Run, Matrix, Report), a consumer-side aggregation library, a backend-neutral run orchestrator, importers/exporters, and a discovery facts leaf — so a skeptical third party can produce or verify "is configuration A better than B" answers from records alone, without trusting whoever produced them, on both the local backend and (last, and only there) the marketplace binding.

**Architecture:** Six standalone yarn packages under `packages/benchmarking/` plus one discovery leaf, mirroring the evidence/TEP/trust package mechanics exactly (standalone `yarn.lock`, `portal:` resolutions, per-package raw-JCS sealing with `order.ts`, a three-script guard clone + one CI workflow landing with the first package). `records` is the tier-2 sealed-record spine (imports `task-execution-protocol` only). `testing` is the conformance kit, authored **before** the tier-3 consumers per the stack's kit-before-implementation rule (exports `describe…Conformance()` drivers + the §16 golden fixtures; the method/assembly/export drivers are exercised by the packages that implement them). `aggregate` is the method registry + reference statistics (adopting the in-repo `paired.ts`/`wilson.ts`/`capability-stats.ts`) + Report production/verification (never imports `run`). `run` is the tier-3 orchestrator (plan → quote → dispatch → watch → assemble) over the injected `TaskExecutionBackend` contract, with every venue-conditional input arriving through injected ports so the package names no backend. `interop` holds importers (SWE-bench, Inspect Evals) and fixture-pinned exporters (Inspect EvalLog, Croissant, static bundle). `facts/benchmarking` registers into the **discovery** tree's guards and conforms to the record-discovery facts kit. `marketplace` (M7, last) is the sole place a marketplace import appears — it injects projector/chain-backed ports into `run` and composes the marketplace binding's `TaskExecutionBackend` peer. Aggregation stays consumer-side throughout: no `aggregationFunction` lives in any protocol layer (profiles finding — it has no protocol home), so the method registry is a tier-3 concern only.

**Tech Stack:** TypeScript 5.9 (NodeNext strict), Node 22, Yarn 4.13.0 (Corepack), Vitest 4, zod 4.4.3 (schema source of truth → JSON Schema 2020-12 via `z.toJSONSchema`), `@noble/hashes` (sha256 digests). `canonicalize` (RFC 8785 JCS) is a dev-only correctness anchor in `records`, never a runtime dep. DSSE signing of the Report record is delegated to `@jinn-network/trust-core` (program §7.15: `task-execution-protocol` exports no PAE primitive; trust-core owns `dssePreAuthEncoding`).

## Global Constraints

_Every task's requirements implicitly include this section. Values copied verbatim from the design + program._

- **Preflight invariant:** all work sits on top of `1200b5842`. `git merge-base --is-ancestor 1200b5842 HEAD` MUST pass before any task (Preflight). This is the integration head at which the benchmarking + marketplace designs were recorded on the program ledger (program §9).
- **Standalone yarn projects.** Each package has its own `package.json` (`"packageManager": "yarn@4.13.0"`, `"type": "module"`, `"version": "0.1.0"`, `"engines": { "node": ">=22" }`, `"license": "MIT"`, `"repository.directory"` set), its own `.yarnrc.yml` (`nodeLinker: node-modules`), its own `yarn.lock`. No repo-root workspace (evidence/TEP precedent).
- **Portal resolutions.** In-tree Jinn deps are declared as `"0.1.0"` semver **and** pinned in `"resolutions"` as `portal:../<sibling>` (or `portal:../../<tree>/<pkg>` cross-tree); enforced by the inventory guard.
- **Canonical sealed bytes, stack-wide (program §7.1).** Every sealed benchmarking record (Benchmark, Run, Matrix, Report) is the raw RFC 8785 JCS serialization under I-JSON — no indentation, no trailing newline. Seal once; verifiers hash the exact received bytes; the sealer rejects any number not an exact I-JSON integer (fractional quantities are strings). No consumer re-canonicalizes.
- **UTF-16 code-unit ordering everywhere sealed bytes are produced (program §7.1/§7.14).** Copy `order.ts` (`compareCodeUnitStrings`) into `records`; use it for every object-key sort reaching canonical bytes; build canonical output by **explicit sorted-key iteration**, never `JSON.stringify` over a rebuilt object (integer-like keys diverge). `localeCompare`/`toLocale*`/`Intl` banned in all production source under `packages/benchmarking/` and the `facts/benchmarking` leaf (locale-ban guard; `.test.ts`/`.mjs` exempt).
- **Cross-package/tree equivalence fixtures (program §7.1/§7.14).** Every sealed-bytes package ships pinned-digest golden fixtures, at least one object-key-order-sensitive record (two source key orderings → identical digest), and an integer-like-key fixture (`{"10":…,"2":…}` → code-unit order). `records` additionally carries a cross-tree equivalence leg asserting byte equality against `task-execution-protocol`'s `serializeCanonicalJson` for a shared logical input; the `facts/benchmarking` leaf seals via `record-discovery-protocol`'s `sealJson` (equivalence already proven in the discovery tree).
- **No raw control bytes in source.** The `cellKey` unit-separator and any control chars are written as escapes (`"\u001f"`), never literal control bytes.
- **Kits precede implementations (program §7.6, design §15).** `benchmarking/testing` (M2) is authored before `aggregate`/`run`/`interop`; its exported `describe…Conformance()` drivers and golden fixtures are the executable spec each implementation greens.
- **Per-package order.ts + raw-JCS sealing + equivalence fixtures wherever sealed bytes are produced** (program §7.1/§7.14). Applies to `records` (four record kinds). `aggregate` produces sealed Report bytes only by calling `records`' exported `sealReport` (no second serializer, program §7.4 Delivery-sealing precedent); its DSSE wrapping uses trust-core.
- **Tier discipline (design §2, §7.7, program §7.7/§7.18):** nothing in `records`/`aggregate`/`run`/`interop`/`facts` names a tier-4 product. `run` consumes the backend, profiles, and evidence **through injected ports / contract types only** — never a concrete backend, never a concrete evidence binding, never a marketplace import. The only place a marketplace import appears is the M7 `marketplace` package.
- **Aggregation is consumer-side (design tenet 4, §9; profiles finding).** The method registry + statistics live only in `aggregate` (tier 3). No protocol/profiles layer learns what a "benchmark" or an aggregation is. The Matrix record contains **no aggregate of any kind** (tenet 3).
- **Six-value outcome vocabulary is frozen (§8.2, §14.1):** `judged | unjudged | unscorable | expired | invalidated | excluded`. `closeAt` is required on every Run (§7.1, anti-optional-stopping). The Report `disclosures` block is required (§9.1).
- **Guard-count computation (program §7.6).** Every guard registration count is computed from the live guard file at land time; never hardcode. The benchmarking tree's guards + CI are created with `records` (the tree's first package) and extended by each later benchmarking package. The `facts/benchmarking` leaf registers into the **existing discovery** tree guards.
- **Cross-tree CI convention (program §7.8).** Each benchmarking package's CI builds its cross-tree portal deps from source before install (packed-types packs them as `file:` deps).
- **Rule 3 (surgical).** Create only the files this plan names. The benchmarking guard scripts + CI workflow are created in M1; later benchmarking tasks edit them; the facts leaf edits the four discovery guard artifacts.
- **Verification gate per task:** `yarn typecheck` + `yarn test` in the touched package, the relevant guard script (`node --test …`), and (at milestone close) the packed-types tree gate — all green locally, evidence-style, before the task is done.

## Pinned identifiers (design defers exact strings to "implementation"; pinned here, flagged for the program gate)

The design uses working titles for every URI, media type, and scope (§6.1, §7.1, §8.1, §9.1, §9.2, §12.1). They are pinned here so the tree can build; every one is surfaced to the program gate (Findings F1). Downstream code imports these constants from `records/src/identifiers.ts` (and the facts leaf from its own `identifiers.ts`), never hardcodes a copy.

| Constant | Pinned value | Design cite / flag |
| --- | --- | --- |
| `BENCHMARKING_PROTOCOL` | `"jinn.benchmarking/1.0"` | §6.1 literal. **Flag:** unlike TEP `protocol` (an https URL), the design freezes a bare token; surfaced for URL-vs-token reconciliation (Finding F1). |
| `BENCHMARK_MEDIA_TYPE` | `"application/vnd.jinn.benchmarking.benchmark.v1+json"` | §6 |
| `RUN_MEDIA_TYPE` | `"application/vnd.jinn.benchmarking.run.v1+json"` | §7 |
| `MATRIX_MEDIA_TYPE` | `"application/vnd.jinn.benchmarking.matrix.v1+json"` | §8 |
| `REPORT_MEDIA_TYPE` | `"application/vnd.jinn.benchmarking.report.v1+json"` | §9.1 |
| `BENCHMARK_RECORD_KIND` … `REPORT_RECORD_KIND` | `"https://jinn.network/records/{benchmark,benchmark-run,benchmark-matrix,benchmark-report}/1.0"` | §11 (facts leaf). **Pre-aligned at fix time** to the record-discovery record-kind grammar `${RECORDS_ROOT}/<segment>/<major>.<minor>` (`RECORDS_ROOT = "https://jinn.network/records"`, segment matches `SOURCE_NAME_GRAMMAR = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/`), verified against `2026-07-28-record-discovery.md` §Pinned-identifiers (its `RECORD_KINDS` map + `assertRecordKindUri`); the design's `jinn.benchmarking.record/*` working token was a bare non-conforming token (dotted segment, no `RECORDS_ROOT`). Segments namespaced under `benchmark`/`benchmark-*` to avoid collision in the shared root; none clashes with the existing discovery `RECORD_KINDS`. Still on the program-gate list; the implemented `assertRecordKindUri` is re-checked at the Phase 3 merge. **Flag F1.** |
| `ASSEMBLY_PROCEDURE` / `ASSEMBLY_PROCEDURE_VERSION` | `"jinn.benchmarking.assembly"` / `"1.0"` | §8.1 `assembly.procedure` |
| method URIs | `"jinn.benchmarking.method/{wilson,avg-at-k,pass-at-k,paired-mcnemar,noninferiority-iut,clean-subset,bradley-terry}"` + `@1` version | §9.2 working URIs |
| `BENCHMARKING_REPORTS_SCOPE` | `"jinn:benchmarking-reports"` | §9.1/§12.1. Mirrors program §7.11 `jinn:discovery-announcements` (namespaced-scope grammar `namespace:custom`); a cross-tree parse-assertion fixture asserts it parses under trust's `ScopeVocabulary`. **Flag F1/F2.** |
| trust-policy purposes (data, not a code gate) | `"benchmark-publisher"`, `"run-owner"` (+ existing `"evaluator-eligibility"`) | §6.3/§12.1 — opaque strings consumers weigh; no gate implemented here |

**IANA registration** of the `application/vnd.jinn.benchmarking.*` vendor tree is a non-blocking follow-up (program §8 lists the other three vendor trees; benchmarking postdates that list). Vendor-tree names are used as-is until then. The reserved protocol/record-kind URIs must resolve before any EXTERNAL conformance claim; internal work does not gate on publication.

---

## Preflight

- [ ] **Assert the branch base.** Run:

```bash
git merge-base --is-ancestor 1200b5842 HEAD && echo "OK: 1200b5842 is an ancestor of HEAD"
```

Expected: prints `OK: …`. If it fails, stop — the worktree is not on the integration head at which the benchmarking design was recorded, and the TEP packages this plan reads as ground truth may be absent or older.

- [ ] **Confirm the TEP contract ground truth is present (records/kit/run hard gate).** Run:

```bash
test -f packages/task-execution/protocol/package.json \
  && test -f packages/task-execution/backend/package.json \
  && test -f packages/task-execution/testing/package.json \
  && echo "OK: TEP protocol + backend + testing present"
```

Expected: prints `OK`. These are Phase-2 packages, merged and green on this branch.

- [ ] **Confirm the benchmarking tree is absent.** Run `ls packages/benchmarking 2>&1` — expected `No such file or directory`. This plan creates it from scratch.

- [ ] **Record the deferred cross-tree gates (asserted at their milestones, not here):**
  - `@jinn-network/task-execution-profiles` — required by M2 (kit fixtures), M4 (run: `verdict-spec-match`/`verdict-consistency`), M5 (interop: `repository-work/1.0`). Absent on this branch; each milestone asserts it before starting.
  - `packages/discovery/{protocol,testing}` — required by M6 (facts leaf). Absent; M6 asserts it.
  - the marketplace-binding plan + `packages/marketplace/{binding,projector,pipeline}` — required by M7. Not yet drafted / absent; M7 asserts it (Finding F2).

- [ ] **Confirm the sealing ground-truth file exists to copy.** Run `ls packages/task-execution/protocol/src/order.ts` — expected to exist (the `order.ts` you copy verbatim into `records`).

---

## Milestone map and internal gates (design §18)

| Milestone | Package | Gate (asserted at milestone start) | Design |
| --- | --- | --- | --- |
| M1 | `benchmarking/records` + tree guard clone | TEP protocol (present) | §6–§9 records; §14.1–.6 |
| M2 | `benchmarking/testing` (kit) | TEP protocol + **profiles** + TEP testing | §16 |
| M3 | `benchmarking/aggregate` | records (M1) + kit (M2) + trust-core (DSSE) | §9.1–.3, §14.7 |
| M4 | `benchmarking/run` | **TEP backend contract** (present) + records + kit + profiles | §7.3–.4, §8.2–.4, §10.1, §14.4 |
| M5 | `benchmarking/interop` | records + **profiles** | §6.5, §10.1–.2, §14.9 |
| M6 | `discovery/facts/benchmarking` | records + **discovery** protocol+testing | §11, §14.8 |
| M7 (**LAST**) | `benchmarking/marketplace` | **marketplace-binding plan** + `packages/marketplace/*` + M4 run | §13, §7.2 leg (b), §18.3 |
| M8 | tree verification + declared-impact addendum | all above | §17 |

Each milestone ends with: package `typecheck`/`test`/`build`/`pack:smoke` + the tree guards green; and (M8) the tree packed-types gate green.

---

## M1 — `benchmarking/records` + benchmarking tree guard clone

Delivers `@jinn-network/benchmarking-records` (design §6–§9 record schemas + sealing + record-level checks) and the three benchmarking-tree guard scripts + CI workflow (enumerating `records` only; later packages register themselves). Tier 2; imports `task-execution-protocol` only (Finding F3). Order within the milestone: scaffold+guards → sealing primitives → the four record schemas + record-level checks → cellKey/expected-cell-set + Submission extension → fixtures/barrel/pack-smoke.

### Task 1.1: Records package scaffolding + benchmarking guard clone

**Files:**
- Create: `packages/benchmarking/records/{package.json,.yarnrc.yml,tsconfig.json,tsconfig.build.json,vitest.config.ts,scripts/build.mjs,scripts/pack-smoke.mjs,src/index.ts (stub)}`
- Create: `.github/scripts/benchmarking-package-inventory.test.mjs`
- Create: `.github/scripts/benchmarking-source-boundaries.test.mjs`
- Create: `.github/scripts/benchmarking-packed-types.test.mjs`
- Create: `.github/workflows/benchmarking-ci.yml`

**Interfaces:**
- Produces: the package directory + build toolchain every later records task extends; the guard files Tasks in M2–M5 (and the `marketplace` package) edit to register new benchmarking packages.

- [ ] **Step 1: Write `package.json`.** Mirror `packages/task-execution/protocol/package.json`. Name `@jinn-network/benchmarking-records`; `dependencies: { "@jinn-network/task-execution-protocol": "0.1.0", "@noble/hashes": "^2.2.0", "zod": "4.4.3" }`; `resolutions: { "@jinn-network/task-execution-protocol": "portal:../../task-execution/protocol" }`; `devDependencies` include `canonicalize`, `typescript`, `vitest`, `@types/node`; `exports` root + `./schemas/*` + `./fixtures/*`; scripts `build`/`typecheck`/`test`/`generate:schemas`/`check:schemas`/`pack:smoke`/`prepack` as the TEP protocol package.

- [ ] **Step 2: Copy the toolchain files** (`.yarnrc.yml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`) verbatim from `packages/task-execution/protocol/` (package-generic).

- [ ] **Step 3: Write the temporary `src/index.ts` stub** so typecheck/build succeed:

```ts
export const BENCHMARKING_PROTOCOL = "jinn.benchmarking/1.0";
```

- [ ] **Step 4: Clone the inventory guard** to `.github/scripts/benchmarking-package-inventory.test.mjs`. Copy `.github/scripts/task-execution-package-inventory.test.mjs` verbatim, swap only the constant blocks: `packageRoot` → `join(root, 'packages', 'benchmarking')`; `TASK_EXECUTION_PACKAGES` → `BENCHMARKING_PACKAGES = [['records', '@jinn-network/benchmarking-records']]`; the dependency graph → `new Map([['records', { dependencies: ['@jinn-network/task-execution-protocol'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }]])`; the count assertion `assert.equal(BENCHMARKING_PACKAGES.length, 1)`; the tree-scan regex → `/^@jinn-network\/benchmarking-/`. The graph asserts the **cross-tree** edge `records → task-execution-protocol` is portal-pinned (the inventory guard already validates `resolutions` portals; confirm it tolerates the `../../task-execution/protocol` path).

- [ ] **Step 5: Clone the source-boundaries guard** to `.github/scripts/benchmarking-source-boundaries.test.mjs`. Copy `.github/scripts/task-execution-source-boundaries.test.mjs` verbatim (generic scanner helpers transfer unchanged), then replace:
  - `packages` → `join(root, 'packages', 'benchmarking')`; the directories list → `benchmarkingDirectories = ['records']`.
  - `BENCHMARKING_FOREIGN_PACKAGES` the whole tree is forbidden to import: every `@jinn-network/evidence-*`, `@jinn-network/execution-recorder`, `@jinn-network/attestation-issuer`, `@jinn-network/record-discovery-*`, and — critically — **every marketplace package** (`@jinn-network/marketplace-*` and any `packages/marketplace/` specifier), plus `viem`, `better-sqlite3`, `kubo-rpc-client`. Add a comment: `records`/`aggregate`/`run`/`interop` NEVER import a marketplace package; only the M7 `marketplace` package carves out those imports when it registers.
  - The one-way-graph test asserts, for `records`: `assertBoundary(join(packages, 'records', 'src'), BENCHMARKING_FOREIGN_PACKAGES)` and that `records` imports **no** `@jinn-network/task-execution-*` except `task-execution-protocol` (forbid `-backend`, `-testing`, `-profiles` from `records/src` — records is tier 2, protocol layer only).
  - Keep the two generic scanner self-tests verbatim; keep the locale-order test renamed to `Benchmarking production source never orders or formats with the host locale`, iterating `benchmarkingDirectories`.

- [ ] **Step 6: Clone the packed-types guard** to `.github/scripts/benchmarking-packed-types.test.mjs`. Copy `.github/scripts/task-execution-packed-types.test.mjs`, swap `evidenceRoot`/`packageRoot` → `packages/benchmarking`; `packages` → `[['records', '@jinn-network/benchmarking-records']]`; `codeEntrypoints` → `['@jinn-network/benchmarking-records']`; add the **cross-tree `file:` dep**: the packed consumer must also pack `@jinn-network/task-execution-protocol` (built from source) so `records`' type surface resolves under NodeNext. Update the final log line to "benchmarking packages."

- [ ] **Step 7: Clone the CI workflow** to `.github/workflows/benchmarking-ci.yml`. Copy `.github/workflows/task-execution-ci.yml`'s shape, reduced to the current graph: `name: Benchmarking CI`; `paths` triggers `packages/benchmarking/**`, `.github/scripts/benchmarking-*.test.mjs`, `.github/workflows/benchmarking-ci.yml`, and the design doc; an `architecture` job running both `node --test` guard scripts; a `records` foundation job that **first builds the cross-tree dep** (`cd packages/task-execution/protocol && yarn install --immutable && yarn build`), then in `packages/benchmarking/records` runs `yarn install --immutable && yarn check:schemas && yarn typecheck && yarn test && yarn build && yarn pack:smoke` and uploads `dist`; a `verify` job (`needs: [architecture, records]`, `if: always()`) that asserts both succeeded, restores dists, and runs `node .github/scripts/benchmarking-packed-types.test.mjs`. Later packages add their own jobs.

- [ ] **Step 8: Run the guards + build the skeleton.**

```bash
node --test .github/scripts/benchmarking-package-inventory.test.mjs
node --test .github/scripts/benchmarking-source-boundaries.test.mjs
(cd packages/task-execution/protocol && yarn install && yarn build)
(cd packages/benchmarking/records && yarn install && yarn typecheck && yarn build)
```

Expected: guards pass (one package); skeleton builds.

- [ ] **Step 9: Commit.** `git commit -m "feat(benchmarking): scaffold records package + tree guard clone"`

### Task 1.2: Sealing primitives + pinned identifiers + cross-tree equivalence leg

**Files:**
- Create: `packages/benchmarking/records/src/order.ts` (+ `order.test.ts`)
- Create: `packages/benchmarking/records/src/canonical.ts` (+ `canonical.test.ts`)
- Create: `packages/benchmarking/records/src/hashing.ts`
- Create: `packages/benchmarking/records/src/json.ts` (re-export `JsonValue`/`assertIJsonInteger`/`IJsonNumberError`)
- Create: `packages/benchmarking/records/src/identifiers.ts` (+ `identifiers.test.ts`) — the Pinned-identifiers table constants
- Create: `packages/benchmarking/records/src/sealing.ts` (+ `sealing.test.ts`) — generic `sealRecord` used by every kind
- Create: `packages/benchmarking/records/src/equivalence.test.ts` — cross-tree byte-equality vs `task-execution-protocol`

**Interfaces:**
- Consumes: `serializeCanonicalJson`, `documentDigest`, `compareCodeUnitStrings`, `assertIJsonInteger`, `IJsonNumberError` from `@jinn-network/task-execution-protocol` (imported, but re-implemented locally for the sealed spine per the per-package sealing rule — see Step 1).
- Produces: `compareCodeUnitStrings`; `sha256Hex(bytes)`; `documentDigest(bytes): \`sha256:${string}\``; `serializeCanonicalJson(value): Uint8Array` (raw JCS, I-JSON integers, explicit sorted-key iteration); `sealRecord(value): { bytes: Uint8Array; digest: \`sha256:${string}\` }`; all Pinned-identifiers constants.

- [ ] **Step 1: Copy the sealing spine** — `order.ts`, `hashing.ts`, `json.ts`, `canonical.ts` verbatim from `packages/task-execution/protocol/src/` (program §7.1: sealing is re-implemented per package, never a shared runtime dep; the cross-tree equivalence fixture proves byte-identity). Update the `order.ts` doc-comment guard path to `.github/scripts/benchmarking-source-boundaries.test.mjs`.

- [ ] **Step 2: Write `identifiers.ts`** with every constant from the Pinned-identifiers table (media types, protocol, record-kind URIs, method URIs, assembly procedure id/version, `BENCHMARKING_REPORTS_SCOPE`, the two trust-policy purpose strings). Add `identifiers.test.ts` asserting each media type matches `/^application\/vnd\.jinn\.benchmarking\.[a-z]+\.v1\+json$/` and each record-kind URI is **grammar-conformant to the record-discovery record-kind shape** — a local mirror-regex `/^https:\/\/jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/\d+\.\d+$/` (M1 cannot import discovery's `assertRecordKindUri`: discovery is absent on this branch and `records` is protocol-only, F3). The tokens were **pre-aligned to that grammar at fix time**, verified against `2026-07-28-record-discovery.md` §Pinned-identifiers, so M1 freezes grammar-conformant identifiers; the authoritative `assertRecordKindUri` check against the built discovery grammar is re-applied in the facts leaf (M6) at the Phase 3 merge.

- [ ] **Step 3: Write the failing `canonical.test.ts` + `equivalence.test.ts`.** `canonical.test.ts` reproduces the program §7.14 fixtures: key-order insensitivity, code-unit key sort (`Z` before `a`), the integer-like-key case (`{"10":1,"2":2}` → `{"10":1,"2":2}`, matching `canonicalize`), I-JSON rejection of a fractional number, byte agreement with `canonicalize` for an integer-only object. `equivalence.test.ts` seals one logical object with `records`' `serializeCanonicalJson` and with `task-execution-protocol`'s `serializeCanonicalJson` and asserts **byte-identical** output, including one object-key-order-sensitive record (program §7.1: the equivalence leg between trees sharing the raw-JCS rule).

- [ ] **Step 4: Run — expect PASS** (spine copied). If the code-unit iteration was accidentally replaced by `JSON.stringify`-over-rebuilt-object, the integer-like-key case fails — fix by explicit sorted-key emission (program §7.14).

- [ ] **Step 5: Write `sealing.ts`** — `sealRecord(value)` = `{ bytes: serializeCanonicalJson(value), digest: documentDigest(bytes) }`. Write `sealing.test.ts`: sealing an object with two source key orderings yields identical digest; sealing an object with a fractional number throws `IJsonNumberError`.

- [ ] **Step 6: Run — expect PASS.** Run the locale-ban guard (`node --test .github/scripts/benchmarking-source-boundaries.test.mjs`) — expect PASS.

- [ ] **Step 7: Commit.** `git commit -m "feat(benchmarking): sealing spine, pinned identifiers, cross-tree equivalence leg"`

### Task 1.3: The Benchmark record (§6) + its record-level checks

**Files:**
- Create: `packages/benchmarking/records/src/benchmark/schema.ts` (+ `.test.ts`)
- Create: `packages/benchmarking/records/src/benchmark/checks.ts` (+ `.test.ts`) — `benchmark-item-distinctness`, `benchmark-judgeability`, `benchmark-comparability`, versioning classifier
- Create: `packages/benchmarking/records/src/benchmark/reveal.ts` (+ `.test.ts`) — `reveal-consistency` + reveal-coverage
- Create: `packages/benchmarking/records/fixtures/benchmark/{valid,minimal,invalid-*}.json`

**Interfaces:**
- Consumes: `ResourceDescriptor` (type + `resourceDescriptorHasLocator`) from protocol; `sealRecord`, identifiers.
- Produces:
  - `BenchmarkRecordSchema` (zod `.loose()`) + `type BenchmarkRecord`; `parseBenchmark(bytes)` / `sealBenchmark(rec): { bytes; digest }`. Fields exactly per §6.1: `protocol` (`BENCHMARKING_PROTOCOL`), `name`, `description`, `author?` (Agent IRI), `version` (SemVer string), `supersedes?` (ResourceDescriptor), `items[]` (each `{ task: ResourceDescriptor }` with `digest` required), `reveal` (`{ policy: "immediate"|"scheduled"|"after-run"; notBefore?: RFC3339 }`), `license?`, `citation?`.
  - `checkItemDistinctness(rec): { ok: true } | { ok: false; duplicate: string }` — item Task digests distinct (§6.1, named `benchmark-item-distinctness`).
  - `checkJudgeability(rec): { ok: true } | { ok: false; unevaluated: string[] } | { status: "unevaluated"; reason: "committed-not-revealed" }` — every referenced Task carries a sealed `evaluation` descriptor. §6.1: for a **committed** benchmark this is third-party-executable only at reveal — before reveal a verifier that lacks the Task bytes reports `status: "unevaluated"` (not passed, not failed). The check takes an optional `taskBytesResolver` port; absent bytes on a scheduled/after-run reveal → `unevaluated`.
  - `classifyVersionBump(prev: BenchmarkRecord, next: BenchmarkRecord): "patch" | "minor" | "major"` — §6.2 (metadata-only=patch; items added only=minor; items removed/changed or any referenced Task's evaluation changed=major).
  - `checkComparability(subjects: { benchmarkDigest: string }[], opts?: { versionRobust?: boolean }): { ok: true } | { ok: false; digests: string[] }` — §6.2/§12.1 `benchmark-comparability`: all subjects resolve to one Benchmark digest unless the method declares itself version-robust (pairs on shared Task digests). Homed here because it is about Benchmark identity; invoked by `aggregate`'s `report-recompute` (M3).

- [ ] **Step 1: Write the failing `schema.test.ts` + `checks.test.ts` + `reveal.test.ts`.**
  - schema: `fixtures/benchmark/valid.json` (2 items, each Task descriptor carrying `digest` + an `evaluation` descriptor stub inside the referenced Task — but the referenced Task lives elsewhere; here the item only holds the Task descriptor) round-trips `parseBenchmark(sealBenchmark(valid).bytes)` deep-equal and the sealed digest matches a pinned `valid.sha256`. `invalid-duplicate-item.json` (two items, same Task digest) → `checkItemDistinctness` `{ ok:false }`. `invalid-bad-version.json` (`version: "1"`) → schema rejects (SemVer regex).
  - checks: `classifyVersionBump` over three fixture pairs (patch/minor/major). `checkComparability` over one-digest (ok) and two-digest (fail unless `versionRobust`).
  - reveal: covered in Task 1.6 (needs Task bytes) — here only assert `checkJudgeability` returns `unevaluated` for a committed benchmark when `taskBytesResolver` yields nothing.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `schema.ts` + `checks.ts` + `reveal.ts`** (the `reveal-consistency` body is finished in Task 1.6 with the reveal fixtures; here ship the signature `checkRevealConsistency(rec, revealed: Map<string, Uint8Array>): { ok: true; coverage: { revealed: number; committed: number } } | { ok: false; mismatched: string[]; coverage: {…} }` — byte verification against committed digests **plus** reveal-coverage reporting, §6.4). Pin `valid.sha256` after first run.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "feat(benchmarking): Benchmark record + distinctness/judgeability/comparability/reveal checks"`

### Task 1.4: The Run record (§7), cellKey grammar, Submission extension block, expected-cell-set

**Files:**
- Create: `packages/benchmarking/records/src/run/schema.ts` (+ `.test.ts`)
- Create: `packages/benchmarking/records/src/run/cells.ts` (+ `.test.ts`) — cellKey grammar, expected-cell-set, Submission extension block, idempotency key
- Create: `packages/benchmarking/records/fixtures/run/{valid,minimal,invalid-missing-closeAt,invalid-dup-arm}.json`

**Interfaces:**
- Consumes: `ResourceDescriptor`, the run-pinning vocabulary keys from protocol `common.ts` (a Run arm's `pinning` is a Submission requirements map — reuse, invent no new vocabulary, §7.1); `sealRecord`; `compareCodeUnitStrings`.
- Produces:
  - `RunRecordSchema` (`.loose()`) + `type RunRecord`; `parseRun`/`sealRun`. Fields exactly per §7.1: `protocol`, `benchmark` (ResourceDescriptor), `owner` (Agent IRI, **required**), `arms[]` (`{ armId: /^[A-Za-z0-9_-]{1,64}$/; pinning: RequirementsMap; execution?: { allowlist: string[] } }`, arms pairwise-distinct in pinning), `replicates` (int ≥ 1), `policy` (`{ completenessFloor: (0,1]; cellWindow: durationMs; replacement: { allowed: boolean; maxPerCell?: int }; independence: "gating"|"disclosed"; evaluation: { minVerdicts?: int; distinctEvaluator?: boolean }; submissionBaseline: RequirementsMap; participantExclusions?: string[] }`), `analysisPlan?[]` (`{ method: URI; version; parameters }`), `budget?` (binding-conditional; `{ perCell: { solve; evaluate }; hardCap; unit }` decimal strings), `venue?` (`{ kind: "self-run"|"open-competition"; note? }`), `closeAt` (**required** RFC3339), namespaced extensions. A `.superRefine` enforces: `closeAt` present; arms pairwise-distinct pinning; `completenessFloor` in (0,1]. Missing `closeAt` → `invalid-document` (the §16 rejection fixture).
  - `cellKey(taskDigest, armId, replicate): string` = `` `${taskDigestHexLower}/${armId}/${replicate}` `` — `replicate` 1-based, minimal decimal, no padding; `armId` grammar excludes `/`; task digest in canonical lowercase-hex (§7.3). `parseCellKey(key)` inverse.
  - `expectedCellSet(bench: BenchmarkRecord, run: RunRecord): CellCoord[]` — the full cartesian product `items × arms × replicates`, ordered lexicographically by `cellKey` via `compareCodeUnitStrings`; `expectedCellCount = |items| × |arms| × replicates`.
  - `submissionExtensionBlock(runDigest, cellKey, armId, replicate, dispatch): { run; cellKey; armId; replicate; dispatch }` — the namespaced extension block dispatched cells carry (§7.3); the block namespace key is `"jinn.benchmarking/cell"` (a §21.3-style namespaced Submission extension). `cellIdempotencyKey(runDigest, cellKey, dispatch): string` derived from `(runDigest, cellKey, dispatch)` (§7.3 — crash-safe resumption never re-posts; a replacement is a visibly new dispatch).

- [ ] **Step 1: Write the failing tests.** schema: `valid.json` round-trips + pinned digest; `invalid-missing-closeAt.json` → `parseRun` `invalid-document`; `invalid-dup-arm.json` (two arms, identical pinning) → refine failure. cells: `cellKey(<digest>, "armA", 1)` shape; `expectedCellSet` over a 3-item/2-arm/2-replicate pair returns 12 coords, lexicographically ordered; two variable-length parts cannot collide (armId charset excludes `/`); `cellIdempotencyKey` distinct across dispatch indices.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `schema.ts` + `cells.ts`.** Pin `run/valid.sha256`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "feat(benchmarking): Run record + cellKey grammar + expected-cell-set + Submission extension block"`

### Task 1.5: The Matrix record (§8) + outcome vocabulary + the Report record (§9.1)

**Files:**
- Create: `packages/benchmarking/records/src/matrix/schema.ts` (+ `.test.ts`) — cells, attrition, completeness, assembly stamp, outcome enum
- Create: `packages/benchmarking/records/src/report/schema.ts` (+ `.test.ts`) — subjects, method, disclosures, DSSE-payload sealing
- Create: `packages/benchmarking/records/fixtures/matrix/{valid,minimal,invalid-*}.json`, `fixtures/report/{valid,minimal,invalid-missing-disclosures}.json`

**Interfaces:**
- Consumes: `ResourceDescriptor`, `EvidenceRecordReference`, digest/URI types from protocol; `sealRecord`.
- Produces:
  - `OUTCOME_VOCABULARY = ["judged","unjudged","unscorable","expired","invalidated","excluded"] as const` (frozen, §8.2/§14.1); `type Outcome`.
  - `MatrixRecordSchema` (`.loose()`) + `type MatrixRecord`; `parseMatrix`/`sealMatrix`. Fields exactly per §8.1: `protocol`, `run` (ResourceDescriptor), `closeBoundary` (`{ at: RFC3339; anchor?: { chain; blockNumber; blockHash } }`), `cells[]` (each: `cellKey`, `taskDigest`, `armId`, `replicate`, `dispatches` (int), `accounted?` (int), `submission?` (digest), `attempt?` (URI), `delivery?` (digest), `verdicts[]` (digests, sorted), `validVerdicts[]` (⊆ verdicts, sorted), `outcome` (Outcome), `verification` (`{ harness; model; loadout; isolation }` each `"match"|"mismatch"|"unverifiable"` + `checksFailed[]`), `integrityTier` (`"re-derivable"|"attested-only"`), `solver?` / `evaluator?` (IRI or `"unresolved"`), `cost?` (`{ value; unit; source: "reported"|"settled" }`), `latencyMs?`), `exclusions[]` (`{ cellKey; reason }`), `attrition` (`{ perArm: Record<armId, { expected; judged; unjudged; unscorable; expired; invalidated; excluded; replacements }>; asymmetryFlags[] }`), `completeness` (`{ expected; judged; floor; runOutcome: "complete"|"partial"|"cancelled" }`), `assembly` (`{ procedure; version }`), namespaced extensions. A `.superRefine` asserts the Matrix carries **no aggregate field** at top level beyond the enumerated ones (tenet 3) and that `cells[]` has exactly one entry per expected cell (checked structurally here; full re-derivation is `matrix-rederivation` in M4).
  - `ReportRecordSchema` (`.loose()`) + `type ReportRecord`; `parseReport`/`sealReport(rec): { bytes; digest }` — the **raw-JCS record bytes** (the DSSE payload; the envelope is added by `aggregate` via trust-core, program §7.15). Fields per §9.1: `protocol`, `subjects[]` (Matrix ResourceDescriptors), `method` (`{ id; version; parameters }`), `preregistered?` (boolean), `results` (JSON — the method's declared output shape, opaque to the schema), `disclosures` (**required**: `{ integrityTiers; pinning; independence; completeness; attrition }`), `limitations?[]`, `author` (Agent IRI), namespaced extensions. A `.superRefine` requires `disclosures` present (§9.1 — a report that hides attrition is malformed).

- [ ] **Step 1: Write the failing tests.** matrix: `valid.json` round-trips + pinned digest; `invalid-missing-cells.json` (an expected cell absent) → structural fail; a cell with an `outcome` outside the six-value enum → schema reject. report: `valid.json` round-trips + pinned digest; `invalid-missing-disclosures.json` → refine failure.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `matrix/schema.ts` + `report/schema.ts`.** Pin the golden digests.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "feat(benchmarking): Matrix + Report records, frozen outcome vocabulary"`

### Task 1.6: Golden + reveal + equivalence fixtures, barrel, pack-smoke, schema drift gate

**Files:**
- Create: `packages/benchmarking/records/fixtures/reveal/{committed,revealed-full,revealed-partial,tampered-item}.json` + `expected-coverage.json`
- Create: `packages/benchmarking/records/fixtures/equivalence/` (two key-permuted Benchmark inputs + `expected-digest.json`)
- Create: `packages/benchmarking/records/src/fixtures.ts` (+ `fixtures.test.ts`) — loaders
- Create: `packages/benchmarking/records/scripts/generate-schemas.mjs` + generated `schemas/*.schema.json`
- Create: `packages/benchmarking/records/src/index.ts` (final barrel — replaces the Task 1.1 stub)
- Create: `packages/benchmarking/records/README.md`

**Interfaces:**
- Consumes: everything in M1.
- Produces: the `@jinn-network/benchmarking-records` public surface (barrel) + `./schemas/*` + `./fixtures/*` asset exports the kit and pack-smoke consume.

- [ ] **Step 1: Write the reveal fixtures + finish `reveal-consistency`.** `committed.json` (a Benchmark with `reveal.policy: "scheduled"`); `revealed-full` (all committed Task bytes, each hashing to its committed digest); `revealed-partial` (a favorable subset — coverage 40/100); `tampered-item` (one revealed byte-blob whose digest ≠ committed). `reveal.test.ts` asserts: full → `{ ok:true, coverage:{revealed:N,committed:N} }`; partial → `{ ok:true, coverage:{revealed:40,committed:100} }` (flagged, never silently accepted); tampered → `{ ok:false, mismatched:[…] }`. Finish `checkRevealConsistency` in `benchmark/reveal.ts`.

- [ ] **Step 2: Write the equivalence record** — two JSON files with the same Benchmark content, keys in different source order, + `expected-digest.json`. `fixtures.test.ts` seals both and asserts identical digests (the mandated key-order-sensitive cross-package equivalence record).

- [ ] **Step 3: Write `fixtures.ts` + `fixtures.test.ts`.** Loaders read from `new URL("../fixtures/…", import.meta.url)`; the test validates every golden document against its family schema and asserts the pinned digests match freshly computed ones (producer check) and that `documentDigest` over stored exact bytes equals the pinned digest **without** re-sealing (consumer check, §6.1).

- [ ] **Step 4: Write `generate-schemas.mjs`** (mirror the TEP protocol generator): emit JSON Schema 2020-12 via `z.toJSONSchema(schema, { target: "draft-2020-12" })` for Benchmark/Run/Matrix/Report to `schemas/*.schema.json`; `--check` diffs and exits non-zero on drift. Run `yarn generate:schemas`; commit generated files.

- [ ] **Step 5: Write the final barrel `src/index.ts`** re-exporting: identifiers; order/hashing/canonical/json/sealing; the four record schemas + parse/seal fns; `OUTCOME_VOCABULARY`; the Benchmark checks (`checkItemDistinctness`, `checkJudgeability`, `classifyVersionBump`, `checkComparability`, `checkRevealConsistency`); the cells module (`cellKey`, `parseCellKey`, `expectedCellSet`, `expectedCellCount`, `submissionExtensionBlock`, `cellIdempotencyKey`); fixtures loaders. This is the frozen tier-2 surface (records + pure checks; §14.1–.6).

- [ ] **Step 6: Write `pack-smoke.mjs`** (mirror TEP protocol): `yarn pack` → install tarball into a temp consumer → import the root (assert `BENCHMARKING_PROTOCOL`), resolve a `./schemas/*` and a `./fixtures/*` asset, run `parseBenchmark` over a golden fixture, assert the **only** `@jinn-network/*` runtime dep is `task-execution-protocol`, and no `.test.` files leaked into `dist`.

- [ ] **Step 7: Write `README.md`** (what the package is, the four kinds + media types, the seal-once rule, the tier-2/protocol-only dependency posture, a pointer to design §6–§9 + the M8 addendum).

- [ ] **Step 8: Full verification gate.**

```bash
cd packages/benchmarking/records
yarn typecheck && yarn test && yarn check:schemas && yarn build && yarn pack:smoke
cd - && node --test .github/scripts/benchmarking-package-inventory.test.mjs \
        && node --test .github/scripts/benchmarking-source-boundaries.test.mjs
```

Expected: all green.

- [ ] **Step 9: Commit.** `git commit -m "feat(benchmarking): reveal + equivalence fixtures, barrel, pack-smoke, schema drift gate"`

---

## M2 — `benchmarking/testing` conformance kit (authored before the tier-3 consumers)

Delivers `@jinn-network/benchmarking-testing` (design §16). Ships the golden fixtures and the exported `describe…Conformance()` drivers the tier-3 packages green. Per the stack's kit-before-implementation rule, this milestone lands **before** `aggregate`/`run`/`interop`; the method/assembly/export drivers exist here and are exercised by M3/M4/M5 (mirroring how the TEP testing kit's `describeTaskExecutionBackendContract` is run by a later plan). Registers itself in the benchmarking guards.

**Gate assertion (run at M2 start):**

```bash
test -f packages/task-execution/profiles/package.json \
  && (cd packages/task-execution/profiles && yarn install --immutable && yarn build) \
  && echo "OK: task-execution-profiles present + builds"
```

If absent, **stop** — the miniature-run fixtures need real Tasks + EvaluationSpecs + verdicts (profiles). This is the "records + kit gate on TEP protocol + profiles sealing" gate (design §18.2).

### Task 2.1: Testing package scaffolding + guard registration

**Files:**
- Create: `packages/benchmarking/testing/{package.json,.yarnrc.yml,tsconfig.json,tsconfig.build.json,vitest.config.ts,scripts/build.mjs,scripts/pack-smoke.mjs,src/index.ts (stub)}`
- Modify: the three benchmarking guard scripts + CI workflow (register `testing`).

- [ ] **Step 1: Write `package.json`** — name `@jinn-network/benchmarking-testing`; `dependencies: { "@jinn-network/benchmarking-records": "0.1.0", "@jinn-network/task-execution-protocol": "0.1.0", "@jinn-network/task-execution-profiles": "0.1.0" }` with matching `portal:` resolutions; `devDependencies` add `@jinn-network/task-execution-testing` (portal `../../task-execution/testing`) — the in-memory fake backend the run-orchestration fixtures drive; `peerDependencies: { "vitest": "^4.1.8" }` + `peerDependenciesMeta.vitest.optional = true` (the `describe…` drivers run under the consumer's vitest, evidence `repository/testing` precedent). Exports `"."` + `"./fixtures/*"`.

- [ ] **Step 2: Write `src/index.ts` stub + toolchain files.**

- [ ] **Step 3: Register `testing` in all three guards + CI** — inventory count → computed-from-live-file (2); graph entry `testing → [benchmarking-records, task-execution-protocol, task-execution-profiles]` deps + `vitest` peer (with the optional-peer assertion, evidence precedent); boundaries `benchmarkingDirectories` gains `'testing'` (may import records + task-execution-protocol/profiles + task-execution-testing as dev, nothing foreign/marketplace); packed-types adds the package + entrypoint + packs the cross-tree deps (records, task-execution-protocol, task-execution-profiles) from source; CI adds a `testing` job depending on `[records]` (build cross-tree deps + records, install, typecheck/test/build/pack:smoke) and to `verify` needs.

- [ ] **Step 4: Run the guards** — expect PASS with 2 packages. Build the skeleton (cross-tree deps built first).

- [ ] **Step 5: Commit.** `git commit -m "feat(benchmarking): scaffold testing kit + register in guards"`

### Task 2.2: Record-conformance driver + the §16 record fixture set

**Files:**
- Create: `packages/benchmarking/testing/src/record-conformance.ts` (exported `describeRecordConformance()`) + `record-conformance.test.ts`
- Create: `packages/benchmarking/testing/fixtures/records/` — sealed fixtures of all four kinds (valid + minimal + invalid-per-constraint variants, **including the missing-`closeAt` rejection**, §16) + the committed-benchmark reveal fixture (positive + tampered-item + partial-reveal coverage report)

**Interfaces:**
- Consumes: `benchmarking-records` (parse/seal/checks/reveal), `benchmarking-records/fixtures/*`.
- Produces: `describeRecordConformance(): void` — a vitest `describe` block asserting §16 Layer-1 rules over the shipped fixtures (schema validation of all four kinds; producer-side re-seal reproduces pinned bytes/digest and is valid JCS under I-JSON; consumer-side `documentDigest` over stored bytes equals the pinned digest without re-canonicalization; `benchmark-item-distinctness`; `benchmark-judgeability` reports `unevaluated` for a committed benchmark; `reveal-consistency` positive + tampered negative + partial-reveal coverage; missing-`closeAt` rejection). Consumable by bindings/products.

- [ ] **Step 1: Author the record fixture set** (reuse `benchmarking-records/fixtures/*` where possible; add the invalid-per-constraint variants §16 enumerates). Write the failing `record-conformance.test.ts` = `describeRecordConformance()`.

- [ ] **Step 2: Run — expect FAIL** (`describeRecordConformance` not defined).

- [ ] **Step 3: Implement `record-conformance.ts`.**

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "feat(benchmarking): record-conformance driver + §16 record fixtures"`

### Task 2.3: The miniature run — byte-exact expected Matrix + assembly/ordering drivers

**Files:**
- Create: `packages/benchmarking/testing/fixtures/miniature-run/` — a full 3-item × 2-arm × 2-replicate run: the sealed Benchmark, the sealed Run, the cell Submissions (with the `jinn.benchmarking/cell` extension blocks), Deliveries, verdicts, evidence stubs, and the **byte-exact expected Matrix** (`expected-matrix.json` + `expected-matrix.sha256`), exercising every outcome (`judged`, `unjudged`, `unscorable`, `expired`, `invalidated`, `excluded`), a replacement lineage, a multi-verdict cell, and an asymmetry flag (§16).
- Create: `packages/benchmarking/testing/fixtures/ordering/` — an announcement-chain + anchor transcript exercising all three legs of `preregistration-precedes-dispatch` (anchored positive, anchored violation, and the local append-order-only case labeled as such, §16).
- Create: `packages/benchmarking/testing/src/assembly-conformance.ts` (exported `describeAssemblyConformance(assemble)`) + `src/ordering-conformance.ts` (exported `describeOrderingConformance(legs)`) + a compile-smoke test `src/drivers.smoke.test.ts`.
- Create: `packages/benchmarking/testing/scripts/generate-miniature-run.mjs` — deterministically regenerates the miniature-run bytes from source objects (using `benchmarking-records` + `task-execution-profiles` builders), so digests are reproducible (mirror the TEP `generate-golden-fixture.mjs`).

**Interfaces:**
- Produces:
  - `describeAssemblyConformance(assemble: AssembleMatrixFn): void` — drives an injected `assembleMatrix` against the miniature run: `assemble(bench, run, injectedScope)` MUST produce the byte-exact `expected-matrix.json`; the driver asserts every outcome path and the `matrix-rederivation` byte equality. **RED until M4** (no `assembleMatrix` exists yet) — exercised by `run`'s test suite, not here (only the compile-smoke references the type).
  - `describeOrderingConformance(legs: OrderingLegs): void` — drives `preregistration-precedes-dispatch` structural leg (a) + chain leg (c) against the ordering transcript; leg (b) anchored is asserted by the marketplace package (M7). The structural leg (a) is green here against `benchmarking-records` (`submissionExtensionBlock` carries the Run digest); the local append-order-only case is asserted labeled-non-decision-grade.
  - `type AssembleMatrixFn` / `type OrderingLegs` — the injected-shape types the tier-3 packages implement.

- [ ] **Step 1: Write `generate-miniature-run.mjs`** and run it to materialize `fixtures/miniature-run/` (the expected Matrix is authored by the generator's reference assembly, then pinned — M4's `assembleMatrix` must reproduce it byte-for-byte). Author the ordering transcript.

- [ ] **Step 2: Write `assembly-conformance.ts` + `ordering-conformance.ts` + the compile-smoke test.** The smoke test type-checks a hand-built `AssembleMatrixFn`/`OrderingLegs` against the frozen shapes and runs `describeOrderingConformance` structural leg (a) + local-case (green against records); it does **not** run `describeAssemblyConformance` (deferred to M4).

- [ ] **Step 3: Run — expect PASS** (record + ordering-structural green; assembly driver compiles but is not invoked here).

- [ ] **Step 4: Commit.** `git commit -m "feat(benchmarking): miniature-run + ordering fixtures, assembly/ordering conformance drivers"`

### Task 2.4: Method + export conformance drivers + kit barrel

**Files:**
- Create: `packages/benchmarking/testing/fixtures/methods/` — for each §9.2 method, an input matrix + parameters + exact expected `results` (the `report-recompute` fixture), including the pairing-exclusion, `verdictRule` conflict, and clustering cases; a `benchmark-comparability` violation fixture (a marginal method over cross-version matrices).
- Create: `packages/benchmarking/testing/fixtures/exports/` — the EvalLog and Croissant projections of the miniature run (fixture-pinned, §16/§14.9).
- Create: `packages/benchmarking/testing/src/method-conformance.ts` (exported `describeMethodRegistryConformance(registry)`) + `src/export-conformance.ts` (exported `describeExportConformance(exporters)`).
- Create: `packages/benchmarking/testing/src/index.ts` (final barrel) + `README.md`.

**Interfaces:**
- Produces:
  - `describeMethodRegistryConformance(registry: MethodRegistry): void` — for each method fixture, `registry.get(id, version)` computes the exact expected `results` from the input matrix + parameters (the `report-recompute` contract); asserts the `verdictRule` reduction, the pinned clustering key, the §9.3 exclusion discipline, and the `benchmark-comparability` violation. **RED until M3** (exercised by `aggregate`).
  - `describeExportConformance(exporters: Exporters): void` — asserts the EvalLog + Croissant projections of the miniature run are byte-exact against the pinned fixtures. **RED until M5** (exercised by `interop`).
  - `type MethodRegistry` / `type Exporters` — the injected shapes the implementers satisfy.
  - Barrel re-exports all five drivers + fixture loaders.

- [ ] **Step 1: Author the method + export fixtures.** Write `method-conformance.ts` + `export-conformance.ts` + the final barrel + README (how a product runs each `describe…` block; the kit-precedes-implementation rule).

- [ ] **Step 2: Verification gate.**

```bash
cd packages/benchmarking/testing && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd - && node --test .github/scripts/benchmarking-package-inventory.test.mjs \
        && node --test .github/scripts/benchmarking-source-boundaries.test.mjs
```

Expected: all green (2 packages; record + ordering-structural drivers green; method/assembly/export drivers compile and await their implementers).

- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): method + export conformance drivers, kit barrel"`

---

## M3 — `benchmarking/aggregate` (the method registry + Report production/verification)

Delivers `@jinn-network/benchmarking-aggregate` (design §9). Consumer-side aggregation only (tenet 4; the profiles finding: `aggregationFunction` has no protocol home). Consumes matrices + records; **never imports `run`**. Adopts the in-repo statistics (`client/src/eval/{paired,wilson,capability-stats}.ts`, `packages/core/src/paired.ts`) as the reference library seed (§9.2 — adoption, not invention; copied into this standalone package, not a runtime dep). Report DSSE signing delegates to `trust-core` (program §7.15).

**Gate assertion (M3 start):** `test -f packages/benchmarking/records/package.json && test -f packages/benchmarking/testing/package.json && test -f packages/trust/core/package.json` — records + kit + trust-core present.

### Task 3.1: Package scaffold + guard registration + the verdictRule reduction + exclusion discipline

**Files:**
- Create: `packages/benchmarking/aggregate/{package.json,toolchain,src/index.ts stub}`
- Create: `packages/benchmarking/aggregate/src/verdict-rule.ts` (+ `.test.ts`) — the contract-wide `verdictRule` reduction (§9.2)
- Create: `packages/benchmarking/aggregate/src/exclusion.ts` (+ `.test.ts`) — §9.3 exclusion discipline
- Modify: the three benchmarking guard scripts + CI.

**Interfaces:**
- `package.json` deps: `@jinn-network/benchmarking-records` (portal `../records`), `@jinn-network/trust-core` (portal `../../trust/core`); dev `@jinn-network/benchmarking-testing` (portal `../testing`). Boundaries: may import records + trust-core, nothing foreign/marketplace, and **not** `run`.
- Produces:
  - `type VerdictRuleName = "sole" | "unanimous" | "any-pass" | "majority"`; `reduceValidVerdicts(validVerdictOutcomes: VerdictOutcome[], rule: VerdictRuleName): { value: "pass"|"fail" } | { conflicted: true }` — §9.2: `sole` (exactly one valid verdict, else conflicted), `unanimous` (all agree, else conflicted; the **default**), `any-pass`, `majority`. Conflicted cells are dropped-with-report (their counts + cellKeys always appear in `results`).
  - `selectScorableCells(matrix): { scored: CellRef[]; excluded: ExcludedReport }` — §9.3: only `judged` cells enter any score; `unjudged`/`unscorable`/`expired`/`invalidated`/`excluded`/`conflicted` never enter a denominator; paired methods pair only tasks judged in **both** arms, reporting the excluded remainder (count + cellKeys).

- [ ] **Step 1: Register `aggregate` in the three guards + CI** (count from live file → 3; graph `aggregate → [records, trust-core]`; CI builds records + trust-core first). Scaffold.
- [ ] **Step 2: Write failing tests for `reduceValidVerdicts` (one per rule + a conflict case) and `selectScorableCells` (exclusion discipline over a mixed-outcome matrix).** Run — expect FAIL.
- [ ] **Step 3: Implement `verdict-rule.ts` + `exclusion.ts`.** Run — expect PASS.
- [ ] **Step 4: Commit.** `git commit -m "feat(benchmarking): aggregate scaffold + verdictRule reduction + exclusion discipline"`

### Task 3.2: The reference statistics library (adopting the in-repo seed)

**Files:**
- Create: `packages/benchmarking/aggregate/src/stats/{wilson,paired-mcnemar,pass-at-k,noninferiority,clustering}.ts` (+ `.test.ts` each)
- Create: `packages/benchmarking/aggregate/src/clean-subset.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `client/src/eval/wilson.ts`, `client/src/eval/paired.ts` / `packages/core/src/paired.ts`, `client/src/eval/capability-stats.ts` as the porting source (copy the pure math into this standalone package; no runtime dep on `client`/`core`).
- Produces the pure statistical primitives each method uses: Wilson score interval; exact McNemar with **clustered** standard errors (Miller 2024 correction); Chen 2021 unbiased pass@k + avg@k; the non-inferiority intersection-union (BCa bootstrap quality lower bound + relative-regression cap AND one-sided Wilcoxon cost, α); the clustering key pinned to task provenance source (§9.2 — **not** a report-time parameter). `clean-subset.ts` restricts to items whose provenance time predicate passes a declared cutoff, then delegates, carrying the **basis** in parameters (`self-declared` vs `announcement-anchored`, §9.2 — the self-declared residual is named in `results`, not solved).

- [ ] **Step 1: Write failing tests** porting the in-repo test vectors (Wilson interval values, McNemar exact p, pass@k unbiased estimator, the non-inferiority PASS/FAIL/INCONCLUSIVE cases) + a clustering test proving report-author cannot re-key clusters (the key is derived from task provenance, not a parameter). Run — expect FAIL.
- [ ] **Step 2: Implement the stats modules** by porting + adapting the seed. Run — expect PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): reference statistics library (adopted from capability-eval seed)"`

### Task 3.3: The method registry + Report production/verification

**Files:**
- Create: `packages/benchmarking/aggregate/src/registry.ts` (+ `.test.ts`) — the URI+version method registry
- Create: `packages/benchmarking/aggregate/src/report.ts` (+ `.test.ts`) — `produceReport` + `verifyReport` (`report-recompute` + `benchmark-comparability`)
- Create: `packages/benchmarking/aggregate/src/index.ts` (final barrel) + `README.md`
- Create: `packages/benchmarking/aggregate/src/method-conformance.test.ts` — runs the kit's `describeMethodRegistryConformance(registry)`

**Interfaces:**
- Produces:
  - `MethodRegistry` (the kit's injected shape): `get(id, version): Method | undefined`; the seven §9.2 methods registered (`wilson@1`, `avg-at-k@1`, `pass-at-k@1`, `paired-mcnemar@1`, `noninferiority-iut@1`, `clean-subset@1`; `bradley-terry@1` registered but not in the v1 reference set). Each `Method` declares its inputs (matrix fields + referenced records), exclusion discipline, parameters, and output shape, and computes `results` from a matrix + the contract-wide `verdictRule`.
  - `produceReport(input: { subjects: MatrixRecord[]; method; parameters; disclosures?; author; preregistered? }, signer: DsseSigner): { record: ReportRecord; bytes; envelope }` — computes `results` via the registry, carries the consumed matrices' `disclosures` block whole (integrityTiers, pinning, independence, completeness, attrition — §9.1/§9.3), seals via `records`' `sealReport`, and DSSE-signs under `BENCHMARKING_REPORTS_SCOPE` via the injected `DsseSigner` (trust-core PAE; the attestation mechanism is host-injected, not a distinct identity — program §7.10 posture).
  - `verifyReport(record: ReportRecord, subjects: MatrixRecord[], referencedVerdicts): { ok: true } | { ok: false; check: "report-recompute"|"benchmark-comparability"|"disclosures-faithfulness"; detail }` — the `report-recompute` named check: `results` reproduce from matrix + referenced verdict records + method id + parameters; enforces `benchmark-comparability` (via `records`' `checkComparability`) and disclosures faithfulness (§9.1/§12.1).

- [ ] **Step 1: Write the failing `registry.test.ts` + `report.test.ts` + `method-conformance.test.ts`** — the last runs `describeMethodRegistryConformance(registry)` from the kit (the RED-until-M3 driver greens here). `report.test.ts` asserts a produced Report round-trips through `verifyReport` and that a `benchmark-comparability` violation (cross-version subjects, non-version-robust method) fails.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `registry.ts` + `report.ts` + the barrel.** Wire the `DsseSigner` port to trust-core's DSSE primitive (Finding F4: exact trust-core symbol bound at implementation against the built package).
- [ ] **Step 4: Run — expect PASS.** The kit's method-registry driver is now green.
- [ ] **Step 5: Verification gate + commit.** `yarn typecheck && yarn test && yarn build && yarn pack:smoke`; guards; `git commit -m "feat(benchmarking): method registry + Report production/verification"`

---

## M4 — `benchmarking/run` (the backend-neutral run orchestrator)

Delivers `@jinn-network/benchmarking-run` (design §7.3–.4, §8.2–.4, §10.1). Tier 3; consumes the `TaskExecutionBackend` **contract** and every venue-conditional input through **injected ports** — it names no backend, imports no concrete evidence binding, and imports no marketplace package (assignment point 5; program §7.7/§7.18). Local venue only in this milestone; the marketplace venue is M7.

**Gate assertion (M4 start):**

```bash
test -f packages/task-execution/backend/package.json \
  && test -f packages/task-execution/profiles/package.json \
  && test -f packages/benchmarking/records/package.json \
  && test -f packages/benchmarking/testing/package.json \
  && echo "OK: backend contract + profiles + records + kit present"
```

Backend contract is present on this branch (run orchestration gates on the TEP backend contract, design §18.2).

### Task 4.1: Package scaffold + guard registration + injected ports

**Files:**
- Create: `packages/benchmarking/run/{package.json,toolchain,src/index.ts stub}`
- Create: `packages/benchmarking/run/src/ports.ts` (+ `ports.test.ts`) — the injected-port interfaces
- Modify: the three benchmarking guard scripts + CI.

**Interfaces:**
- `package.json` deps: `@jinn-network/benchmarking-records` (portal `../records`), `@jinn-network/task-execution-backend` (portal `../../task-execution/backend`), `@jinn-network/task-execution-protocol` (portal `../../task-execution/protocol`), `@jinn-network/task-execution-profiles` (portal `../../task-execution/profiles`); dev `@jinn-network/benchmarking-testing` + `@jinn-network/task-execution-testing`. Boundaries: may import those; **forbidden** any marketplace package, any concrete evidence binding (`evidence-local-runtime`, `catalog-sqlite`, `repository-*`), and `benchmarking/aggregate` (run never aggregates — tenet 3/4).
- Produces the venue-conditional injected ports (design §8.3, §13; backend-neutral by construction):
  - `InputScope` — `submissionsForRun(runDigest): AsyncIterable<InScopeCell>` yielding, per accounted cell, the sealed Submission bytes + its dispatch lineage + Deliveries + verdicts + observation log, **within the declared input scope at the close boundary** (§8.3 — never "known to" any party).
  - `TrustResolver` — `resolveAgent(evidence, at: Date): Promise<string | "unresolved">` (trust §7.5 steps 1–4 at effective time, key bindings anchored at/before the close boundary; fail-closed on unresolved, §8.1/§8.3). Defined here as a minimal port; the host injects a trust-core-backed impl (Finding F4).
  - `CloseBoundaryResolver` — `resolve(run: RunRecord): Promise<{ at: string; anchor?: { chain; blockNumber; blockHash } }>` (local: just `at`; marketplace: `at` + first `finalized` block at/after `closeAt`, injected by M7).
  - `PinningObservationPort` — `observe(delivery, arm): Promise<{ harness; model; loadout; isolation }>` each `"match"|"mismatch"|"unverifiable"` from the evidence Runtime Observation / #2041 attestation (§8.1; before #2040/#2041 land, marketplace returns `unverifiable` — §18.3).
  - `AdmissionEvidencePort` — `tierFor(taskDigest, evaluationSpecDigest): Promise<"re-derivable" | "attested-only">` (§8.4; conservative `attested-only` when no admission receipt).
  - `CostSource` — `costFor(cell): Promise<{ value; unit; source: "reported"|"settled" } | undefined>` and `latencyFor(cell)` (§8.3 optional-field sourcing is pinned by the assembly procedure version).

- [ ] **Step 1: Register `run` in the three guards + CI** (count → 4; graph `run → [records, task-execution-backend, task-execution-protocol, task-execution-profiles]`; CI builds those cross-tree deps first). Scaffold.
- [ ] **Step 2: Write `ports.ts` + a `ports.test.ts`** that type-checks a hand-built stub of each port. Run — expect PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): run scaffold + backend-neutral injected ports"`

### Task 4.2: Plan + Quote (side-effect-free)

**Files:**
- Create: `packages/benchmarking/run/src/plan.ts` (+ `.test.ts`), `src/quote.ts` (+ `.test.ts`)

**Interfaces:**
- Produces:
  - `planRun(input: BenchmarkPlanInput): { record: RunRecord; bytes; digest }` (§10.1 op 2) — a small declarative input (benchmark digest, arms, replicates, policy, analysisPlan, budget) → the sealed Run record; execution venue is a dispatch choice, not a different toolchain.
  - `quoteRun(bench: BenchmarkRecord, run: RunRecord, caps: BackendCapabilities): QuoteReport` (§10.1 op 3) — **side-effect-free** validate + price: expected cell count (`expectedCellCount`), per-cell fees × cells, hard-cap check, estimated duration; on local, time/disk estimates. Validates each arm's `pinning ∪ submissionBaseline` against the backend's `runPinning` inventory (an `unsupported-requirement` here is surfaced as a quote error, not a throw). **Nothing signs, posts, or spends.**

- [ ] **Step 1: Write failing tests** — `planRun` produces a Run whose digest is stable and whose `closeAt` is required; `quoteRun` computes the correct expected-cell count over the miniature-run benchmark, flags a hard-cap breach, and flags an unsupported pinning key against a capabilities stub. Run — expect FAIL.
- [ ] **Step 2: Implement.** Run — expect PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): plan (Run record) + side-effect-free quote"`

### Task 4.3: Launch & watch (crash-safe cell dispatch over the injected backend)

**Files:**
- Create: `packages/benchmarking/run/src/launch.ts` (+ `.test.ts`), `src/status.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `TaskExecutionBackend` (2-arg `submit`/`observe`/`deliveries`/`recover`/`cancel`), `sealSubmission`, `submissionExtensionBlock`, `cellIdempotencyKey`, `AttemptDescriptor`, `expectedCellSet`. **Attempt identity (program §7.22):** local single-party cell dispatch commits to the on-branch **2-arg `submit(taskBytes, submissionBytes)`** — the backend **mints** the Attempt URI, which the run reads back from the `SubmissionAck`/`observe` surface (the materialized `AttemptDescriptor`, program §7.16) into the Matrix `attempt` field. Resumption idempotency rides the stable Submission digest + `cellIdempotencyKey`, never a re-derived Attempt. **No `deriveAttemptUri` in local mode** — deterministic caller-supplied Attempt URIs are a two-party concern that enters benchmarking only in M7 marketplace mode, via the binding + `engagement` param.
- Produces:
  - `launchAndWatch(bench, run, backend, opts): AsyncIterable<CellStatusEvent>` (§10.1 op 4) — dispatches each expected cell as an ordinary TEP Submission of the item's Task via the backend's **2-arg `submit`** (the backend mints the cell's Attempt URI, captured from the `SubmissionAck`/`observe` surface for the later Matrix `attempt` field — never re-derived), with the full requirements map equal to `arm.pinning ∪ policy.submissionBaseline` (the `cell-correspondence` invariant, byte-level map equality after JCS), `deadline` from `cellWindow` clipped to `closeAt`, the `jinn.benchmarking/cell` extension block, and the `cellIdempotencyKey` — so crash-safe resumption never re-posts a cell and a replacement is a visibly new `dispatch`. Emits live per-cell status (`dispatch`/`claimed`/`delivered`/`judged`); infra failures shown as infra (`unscorable` ≠ fail). `cancel` drains to a boundary and still assembles a matrix (`runOutcome: cancelled`).
  - `resumeRun(...)` — re-derives outstanding cells from the backend's `recover`/`observe` (idempotency keys make resumption re-enter the same cells).
  - Replacement dispatch (§7.4): an `expired`/`unscorable`/exclusion-hit cell is re-dispatched with `dispatch` incremented, up to `maxPerCell`, never past `closeAt`; `judged`/`unjudged`/`invalidated` are never replaced.

- [ ] **Step 1: Write the failing `launch.test.ts`** driving `launchAndWatch` against `createInMemoryBackend()` (from `task-execution-testing`): asserts `cell-correspondence` (a tightened/loosened map is rejected before dispatch), the backend-minted Attempt URI is captured from the `SubmissionAck`/`observe` surface (not re-derived), idempotent re-post on resume (same Submission digest + `cellIdempotencyKey`), replacement increments `dispatch`, and cancel yields a drainable boundary. Run — expect FAIL.
- [ ] **Step 2: Implement `launch.ts` + `status.ts`.** Run — expect PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): crash-safe launch & watch over the injected backend"`

### Task 4.4: Deterministic assembly — outcome derivation, named checks, the Matrix

**Files:**
- Create: `packages/benchmarking/run/src/assemble.ts` (+ `.test.ts`) — `assembleMatrix` (§8.3), outcome derivation (§8.2)
- Create: `packages/benchmarking/run/src/checks.ts` (+ `.test.ts`) — `cell-correspondence`, `preregistration-precedes-dispatch` legs (a)+(c), `pinning-observation`, `verdict-spec-match`, `evaluator-independence`
- Create: `packages/benchmarking/run/src/verify.ts` (+ `.test.ts`) — `verifyMatrix` (re-derive + compare + signatures)
- Create: `packages/benchmarking/run/src/index.ts` (final barrel) + `README.md`
- Create: `packages/benchmarking/run/src/assembly-conformance.test.ts` — runs the kit's `describeAssemblyConformance(assembleMatrix)`

**Interfaces:**
- Consumes: the injected ports; `checkVerdictConsistency`/`evaluateVerdictRule` + the §7.7 spec-digest rule from `task-execution-profiles`; `records`' outcome vocabulary, cells module, checks.
- Produces:
  - `assembleMatrix(bench, run, ports, procedure): Promise<{ record: MatrixRecord; bytes; digest }>` — the deterministic §8.3 assembly: enumerate expected cells from the cartesian product; **exactly one cell entry per expected cell** ordered lexicographically by `cellKey`; all digest arrays sorted; optional absent fields omitted; input scope from `ports.inputScope`; each cell's `attempt` field is the backend-minted Attempt URI **read** from the in-scope Submission/observation records (never re-derived — reading rather than regenerating the URI is what preserves `matrix-rederivation` byte-determinism, program §7.22); trust resolution from `ports.trust` (steps 1–4, effective time); optional-field sourcing from `ports.cost` pinned by `procedure` version. Byte-identical for any party with the same inputs (`matrix-rederivation`).
  - Outcome derivation (§8.2, deterministic, per accounted dispatch, at the close boundary): exclusion-hit → `excluded`; any `mismatch` axis → `invalidated`; ≥1 valid verdict → `judged`; all terminal could-not-grade → `unscorable`; delivery-but-no-valid-verdict → `unjudged`; deadline passed without delivery → `expired`; never-dispatched → `expired` with `dispatches: 0`. A **valid verdict** passes `verdict-spec-match` (its `evaluationSpecification` digest equals the Task's sealed `evaluation` digest, profiles §7.7), the profiles evaluation checks (`checkVerdictConsistency`), and — under `policy.independence: gating` — `evaluator-independence` (evaluator resolves agent-distinct from solver via `ports.trust`, fail-closed on `unresolved`); under `disclosed`, the independence failure is recorded in `checksFailed` instead of gating.
  - `verifyMatrix(matrix, bench, run, ports): Promise<{ ok: true } | { ok: false; check; detail }>` (§10.1 op 6, the tier-3 slice) — re-derives the matrix byte-for-byte (`matrix-rederivation`), verifies signatures and trust joins via the ports; exits with the specific named check that failed. (The cross-package `bench verify` product that also recomputes Reports is tier-4, OUT — it composes `verifyMatrix` + `aggregate.verifyReport`.)

- [ ] **Step 1: Write the failing `assemble.test.ts` + `checks.test.ts` + `assembly-conformance.test.ts`.** The conformance test runs `describeAssemblyConformance(assembleMatrix)` against the kit's miniature run — the RED-until-M4 driver greens here, proving byte-exact `expected-matrix.json` with every outcome, the replacement lineage, the multi-verdict cell (reduced later by `verdictRule` in aggregate), and the asymmetry flag. `checks.test.ts` covers each named check positive + negative (including a `gating` independence failure that suppresses `judged`, and a `disclosed` failure that records `checksFailed` but keeps `judged`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `assemble.ts` + `checks.ts` + `verify.ts` + the barrel.** Trust resolution + evidence observations arrive only through ports (no concrete binding import). Integrity tier per cell from `ports.admission` (§8.4). Attrition + asymmetry flags computed per §8.1; completeness floor test `judged / (expected − excluded) ≥ floor`.
- [ ] **Step 4: Run — expect PASS.** The kit's assembly driver is green.
- [ ] **Step 5: Verification gate + commit.** `yarn typecheck && yarn test && yarn build && yarn pack:smoke`; guards; `git commit -m "feat(benchmarking): deterministic matrix assembly + outcome derivation + named checks"`

---

## M5 — `benchmarking/interop` (importers + fixture-pinned exporters)

Delivers `@jinn-network/benchmarking-interop` (design §6.5, §10.1 op 1, §10.2, §14.9). Imports `records` + `task-execution-profiles` + `task-execution-protocol`; **does not import `run`** (dependency direction `records ← interop`). Exporters consume matrices/reports; importers produce sealed Tasks + Benchmark records.

**Gate assertion (M5 start):** `test -f packages/benchmarking/records/package.json && test -f packages/task-execution/profiles/package.json`.

### Task 5.1: Scaffold + guard registration + SWE-bench importer

**Files:**
- Create: `packages/benchmarking/interop/{package.json,toolchain,src/index.ts stub}`
- Create: `packages/benchmarking/interop/src/import/swebench.ts` (+ `.test.ts`) + `fixtures/swebench/*.json`
- Modify: the three benchmarking guard scripts + CI.

**Interfaces:**
- `package.json` deps: `@jinn-network/benchmarking-records`, `@jinn-network/task-execution-profiles`, `@jinn-network/task-execution-protocol` (portals). Boundaries: those + nothing foreign/marketplace/`run`.
- Produces: `importSweBench(rows: SweBenchRow[], opts): { tasks: SealedTask[]; benchmark: BenchmarkRecord }` (§10.1 op 1) — SWE-bench-shaped rows → sealed Tasks under `repository-work/1.0` (reuse `buildRepositoryWorkProfile` + `sealEvaluationSpec` + `sealTask` from profiles; the `instance_id`/`base_commit`/`FAIL_TO_PASS`/`PASS_TO_PASS` fields already fit the `repository-work/1.0` lineage) + a Benchmark record over their digests. Content addressing kills ruler drift (§10.1). Also `defineBenchmark(items)` for hand-authored sets (`bench define`).

- [ ] **Step 1: Register `interop` in the guards + CI** (count → 5). Scaffold. Write the failing `swebench.test.ts` (a fixture row → a sealed Task whose digest is stable + a Benchmark whose `items` reference it; `checkJudgeability` passes because each Task carries an `evaluation` descriptor). Run — expect FAIL.
- [ ] **Step 2: Implement `import/swebench.ts`.** Run — expect PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): interop scaffold + SWE-bench importer"`

### Task 5.2: Inspect Evals importer + Croissant export

**Files:**
- Create: `packages/benchmarking/interop/src/import/inspect.ts` (+ `.test.ts`), `src/export/croissant.ts` (+ `.test.ts`) + fixtures

**Interfaces:**
- Produces:
  - `importInspectEvals(task: InspectEvalTask, opts): { tasks; benchmark }` (§10.2 seam 1) — Inspect Evals tasks that are **data-expressible** (dataset + declarative scoring) → sealed Tasks + Benchmark. Arbitrary Python solvers/scorers cannot be sealed as verifiable data — such tasks pin "Inspect task X at version/digest Y" and carry `attested-only` integrity unless admission evidence shows re-derivability (§10.2 caveat honored).
  - `exportCroissant(bench: BenchmarkRecord, revealed: Map<string, Uint8Array>): CroissantDocument` (§6.5) — a deterministic one-way projection into MLCommons Croissant JSON-LD (dataset metadata; one FileObject per item with `sha256`; `version` mapped through). Fixture-pinned; no reverse path (posture identical to the marketplace binding's ERC-8004 export — the sealed record is authoritative).

- [ ] **Step 1: Write failing tests** (Inspect data-expressible round-trip + the non-data-expressible `attested-only` case; Croissant projection byte-exact against a pinned fixture). Run — expect FAIL.
- [ ] **Step 2: Implement.** Run — expect PASS.
- [ ] **Step 3: Commit.** `git commit -m "feat(benchmarking): Inspect Evals importer + Croissant export"`

### Task 5.3: EvalLog + static-bundle export + the kit export-conformance

**Files:**
- Create: `packages/benchmarking/interop/src/export/evallog.ts` (+ `.test.ts`), `src/export/static-bundle.ts` (+ `.test.ts`)
- Create: `packages/benchmarking/interop/src/index.ts` (final barrel) + `README.md`
- Create: `packages/benchmarking/interop/src/export-conformance.test.ts` — runs the kit's `describeExportConformance(exporters)`

**Interfaces:**
- Produces:
  - `exportEvalLog(matrix: MatrixRecord, evidence: EvidenceResolver): EvalLog` (§10.1 op 5, §10.2 seam 3) — an Inspect-compatible EvalLog so `inspect view` renders our runs (epoch-as-repetition, scorer/metric split per the §4 standards audit). Evidence transcripts arrive through an injected `EvidenceResolver` port (contracts only — no concrete binding).
  - `exportStaticBundle(matrix, reports?): StaticBundle` — a self-contained static bundle (private by default, §10.1 op 5).
  - The `Exporters` shape (the kit's injected type): `{ evalLog; croissant; staticBundle }`.
  - `export-conformance.test.ts` runs `describeExportConformance(exporters)` — the RED-until-M5 driver greens here (EvalLog + Croissant byte-exact against the kit fixtures).

- [ ] **Step 1: Write the failing tests + the export-conformance test.** Run — expect FAIL.
- [ ] **Step 2: Implement the two exporters + the barrel.** Run — expect PASS. The kit's export driver is green.
- [ ] **Step 3: Verification gate + commit.** `yarn typecheck && yarn test && yarn build && yarn pack:smoke`; guards; `git commit -m "feat(benchmarking): EvalLog + static-bundle export, kit export-conformance green"`

---

## M6 — `discovery/facts/benchmarking` (the facts leaf for the four benchmarking kinds)

Delivers `@jinn-network/record-discovery-facts-benchmarking` (program §6 naming; design §11, §14.8). The benchmarking record kinds are their **own record-kind tree** (`benchmarking-records`), so per the leaf-per-record-kind-tree rule they get their own discovery facts leaf (design §15; the discovery plan's Addendum 2026-07-28-b explicitly homes this fourth leaf here, not in the discovery plan). It registers into the **existing discovery** tree guards and conforms to the record-discovery facts kit. This leaf owns the CloudEvents filter attributes on the **benchmarking** record kinds; the `benchrun`/`benchcell`/`bencharm` attributes on the Submission/Delivery kinds are owned by the discovery M8 `facts/task-execution` leaf and are only REFERENCED here.

**Gate assertion (M6 start):**

```bash
test -f packages/discovery/protocol/package.json \
  && test -f packages/discovery/testing/package.json \
  && (cd packages/discovery/protocol && yarn install --immutable && yarn build) \
  && echo "OK: discovery protocol + testing present + build"
```

If absent, **stop** — the facts leaf needs the discovery facts-profile contract, `sealJson`, `assertRecordKindUri`, the `FactsRecompute` port, and the facts-consistency conformance driver (discovery is Phase 3, in flight; Finding F5).

### Task 6.1: Scaffold the leaf + append to the four discovery guard artifacts

**Files:**
- Create: `packages/discovery/facts/benchmarking/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts}`
- Create: `packages/discovery/facts/benchmarking/src/identifiers.ts` — the four record-kind URIs (validated against discovery's `assertRecordKindUri`)
- Modify: `.github/scripts/record-discovery-package-inventory.test.mjs`, `.github/scripts/record-discovery-source-boundaries.test.mjs`, `.github/scripts/record-discovery-packed-types.test.mjs`, `.github/workflows/record-discovery-ci.yml` (the four discovery guard artifacts, created by the record-discovery plan under the `record-discovery-*` prefix; append `facts/benchmarking`).

**Interfaces:**
- `package.json` deps: `@jinn-network/record-discovery-protocol` (portal `../../protocol`), `@jinn-network/benchmarking-records` (portal `../../../benchmarking/records`) — the single record-kind-tree dependency for all four benchmarking kinds. dev `@jinn-network/record-discovery-testing` (portal `../../testing`).

- [ ] **Step 1: Append `facts/benchmarking` to the four discovery guard artifacts.** The inventory guard's `packageManifests` recursion already descends into `facts/`; add the graph entry `facts/benchmarking → [record-discovery-protocol, benchmarking-records]` (count computed from the live discovery inventory file at land time). The boundaries guard adds `FACTS_BENCHMARKING_FORBIDDEN_PACKAGES` — **allowed**: `record-discovery-protocol` + `benchmarking-records`; **forbidden**: serve/client/other facts leaves/TEP/trust/evidence/marketplace (this is the sanctioned leaf edge — `facts/*` is where a discovery edge meets a record-kind edge, program §6 confirmation item 4). Add ambient-network + locale bans over its `src`. The packed-types guard packs `record-discovery-protocol` + `benchmarking-records` (+ transitive `task-execution-protocol`) as `file:` deps; the CI job builds those first.

- [ ] **Step 2: Scaffold** the leaf + `identifiers.ts` (the four record-kind URIs, each passed through `assertRecordKindUri` in a `identifiers.test.ts`). Build the skeleton.

- [ ] **Step 3: Run the discovery guards** (`node --test .github/scripts/record-discovery-package-inventory.test.mjs .github/scripts/record-discovery-source-boundaries.test.mjs`) — expect PASS with `facts/benchmarking` appended. Commit. `git commit -m "feat(discovery): scaffold facts/benchmarking leaf + register in guards"`

### Task 6.2: The four facts-profile documents + CloudEvents filter attributes + recompute fns

**Files:**
- Create: `packages/discovery/facts/benchmarking/profiles/{benchmark,run,matrix,report}.1.0.json` + `src/profiles.ts` + `src/profiles.test.ts` (pinned digests)
- Create: `packages/discovery/facts/benchmarking/src/recompute.ts` + `src/recompute.test.ts`
- Create: `packages/discovery/facts/benchmarking/src/facts-conformance.test.ts` — runs the discovery kit's facts-consistency conformance for the four kinds

**Interfaces:**
- Produces the four sealed, digest-pinned facts-profile documents (§11), each labeling every field record-fact vs substrate-fact, naming reference-bearing fields, and declaring CloudEvents attribute name + scalar per liftable field (discovery §12 `FactsProfileField`):
  - **benchmark** — record facts: benchmark digest (identity), owner/author IRI, `version`. No substrate facts (author-published record). CloudEvents-liftable: the benchmark version + author (attribute names ≤ 20 chars, `^[a-z0-9]{1,20}$`).
  - **run** — record facts: run digest, `owner` IRI, the referenced **benchmark** digest (**reference-bearing** so `referrers()` inverts Benchmark → Runs). CloudEvents-liftable: owner + benchmark reference.
  - **matrix** — record facts: matrix digest, the referenced **run** digest (reference-bearing so `referrers()` inverts Run → Matrix), `completeness.runOutcome`. CloudEvents-liftable: run reference + runOutcome.
  - **report** — record facts: the referenced **matrix** digests (reference-bearing so `referrers()` inverts Matrix → Reports), `method.id`+`version`, `author` IRI, `preregistered`. CloudEvents-liftable: method id + author.
- `src/recompute.ts` **exports** the per-kind `RecordFactRecompute` fns (bytes → values) the host wires into the discovery `FactsRecompute` registry — recomputing each kind's record facts **from record bytes** (program §7.13; a lying source cannot publish a matching projection to spoof facts-consistency). Reference-bearing fields resolve via the `ReferencedBytes` port; `undefined` (unavailable referenced bytes) → `indeterminate`.

- [ ] **Step 1: Author the four facts-profile documents + pin their sealed digests in `profiles.test.ts`** (seal via `record-discovery-protocol`'s `sealJson`; `parseFactsProfile` accepts them; `cloudEventsFields`/`referenceBearingFields` return the declared sets; a `cloudEvents.attribute` violating `^[a-z0-9]{1,20}$` is rejected). Write the failing `recompute.test.ts` (each kind's recompute over `benchmarking-records` fixture bytes yields the expected facts; a spoofed record whose bytes do not validate → `inconsistent`; unavailable referenced bytes → `indeterminate`) and `facts-conformance.test.ts` (the discovery kit's facts-consistency driver over the four kinds, recompute fns supplied through the kit's `FactsRecompute` registry).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `profiles.ts` + `recompute.ts` + the barrel.**

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Verification gate + commit.** package `typecheck`/`test`/`build`/`pack:smoke` (cross-tree deps built first) + the four discovery guards green; `git commit -m "feat(discovery): benchmarking facts profiles + recompute + CloudEvents attributes"`

---

## M7 — `benchmarking/marketplace` (the marketplace venue — LAST, gated on the marketplace-binding plan)

Delivers `@jinn-network/benchmarking-marketplace` (design §13, §7.2 leg (b), §18.3). This is the **only** benchmarking package that imports a marketplace package. It injects marketplace-backed implementations of the M4 `run` ports (anchored close boundary, projector-derived input scope, `settled` cost source) and composes the marketplace binding's `TaskExecutionBackend` peer into `launchAndWatch` (per program §7.18: the binding is consumed only through the standard `TaskExecutionBackend` interface — hand sealed bytes to `submit`, wait for the Delivery; never reach into binding internals). It comes last because it gates on the marketplace-binding **plan** and its packages, which are not yet drafted/landed (Finding F2).

**Gate assertion (M7 start):**

```bash
test -f docs/superpowers/plans/2026-07-28-marketplace-binding.md \
  && test -f packages/marketplace/binding/package.json \
  && test -f packages/marketplace/projector/package.json \
  && echo "OK: marketplace-binding plan + binding + projector present"
```

If absent, **stop** — M7 is blocked on the marketplace-binding plan and its implementation (design §18.2 "marketplace mode needs the marketplace binding implementation"). The exact marketplace package/export names are settled by that plan; this milestone binds them at implementation time against the built packages (compose against the design's §11 frozen interfaces).

### Task 7.1: Scaffold + guard registration + marketplace-backed ports

**Files:**
- Create: `packages/benchmarking/marketplace/{package.json,toolchain,src/index.ts stub}`
- Create: `packages/benchmarking/marketplace/src/close-boundary.ts` (+ `.test.ts`), `src/input-scope.ts` (+ `.test.ts`), `src/cost.ts` (+ `.test.ts`)
- Modify: the three benchmarking guard scripts + CI (register `marketplace`; this is the only benchmarking package whose boundary inventory **carves out** the marketplace imports).

**Interfaces:**
- `package.json` deps: `@jinn-network/benchmarking-run` (portal `../run`), `@jinn-network/benchmarking-records` (portal `../records`), the marketplace binding + projector packages (portals; exact names per the marketplace plan), `@jinn-network/task-execution-backend` (contract). Boundaries: this package's `BENCHMARKING_MARKETPLACE_ALLOWED` list adds the marketplace binding + projector (the sanctioned carve-out); everything else in the tree still forbids marketplace imports.
- Produces the marketplace-backed port implementations for `run` (design §13 normative rows):
  - `marketplaceCloseBoundary(...)`: `CloseBoundaryResolver` resolving `closeAt` → the first `finalized` block at/after it (anchor **required** on anchored backends, §8.1) — this is the missing leg (b) of `preregistration-precedes-dispatch` (anchored ordering: Run announcement observed at/before the earliest cell post; §7.2 leg (b)).
  - `projectorInputScope(...)`: `InputScope` deriving in-scope records from the projector's chain events at `finalized` up to the close anchor, with the marketplace binding's projector derivation annotations (§8.3).
  - `settledCostSource(...)`: `CostSource` sourcing `cost` from escrow settlement events where available, else `reported` (§8.3/§13).
  - The `attested` pinning posture: `PinningObservationPort` that reports `unverifiable` axes honestly until #2040/#2041 land (design §18.3), so a marketplace Report cannot silently score unverified configurations.

- [ ] **Step 1: Register `marketplace` in the guards + CI** (count → 6; the boundary carve-out for the marketplace packages; CI builds run + records + the marketplace packages first). Scaffold.
- [ ] **Step 2: Write failing tests** for the three ports (close-boundary anchor resolution against a fork/fixture; projector-derived input scope over a projector fixture; settled-cost sourcing). Run — expect FAIL.
- [ ] **Step 3: Implement the three ports** against the marketplace binding/projector public surfaces (§11 frozen interfaces). Run — expect PASS.
- [ ] **Step 4: Commit.** `git commit -m "feat(benchmarking): marketplace-backed run ports (close boundary, input scope, settled cost)"`

### Task 7.2: Marketplace venue composition + the anchored ordering leg (b) + kit conformance

**Files:**
- Create: `packages/benchmarking/marketplace/src/venue.ts` (+ `.test.ts`) — composes the binding's `TaskExecutionBackend` peer into `launchAndWatch` + `assembleMatrix`
- Create: `packages/benchmarking/marketplace/src/ordering-leg-b.test.ts` — runs the kit's `describeOrderingConformance` anchored leg (b)
- Create: `packages/benchmarking/marketplace/src/index.ts` (final barrel) + `README.md`

**Interfaces:**
- Produces:
  - `runOnMarketplace(bench, run, binding: TaskExecutionBackend, projector, opts)` — composes `benchmarking-run`'s `launchAndWatch` (dispatching cell Submissions to the binding's `submit`, waiting for Deliveries) + `assembleMatrix` (with the marketplace-backed ports), venue `open-competition`, `independence: gating` required (§7.1), `budget` required, close boundary anchored. The binding is consumed **only** through the `TaskExecutionBackend` interface (program §7.18). **This is the sole benchmarking mode where a deterministic third-party Attempt URI is in play** (program §7.22): it enters via the binding's `submit` `engagement` param — the binding derives it with the TEP `deriveAttemptUri` export (program §7.2; the binding never re-derives its own), and benchmarking hands sealed bytes + the engagement entry across the standard interface without deriving or re-deriving any Attempt URI itself.
  - The anchored ordering leg (b) of `preregistration-precedes-dispatch` (§7.2 leg (b)) — asserted via the kit's `describeOrderingConformance` anchored positive + anchored-violation transcript.

- [ ] **Step 1: Write the failing `venue.test.ts` + `ordering-leg-b.test.ts`** driving the composition against the marketplace binding's kit/fixtures (the TEP kit runs against the binding per marketplace design §13). Run — expect FAIL.
- [ ] **Step 2: Implement `venue.ts` + the barrel.** Run — expect PASS.
- [ ] **Step 3: Verification gate + commit.** package gate + guards; `git commit -m "feat(benchmarking): marketplace venue composition + anchored pre-registration leg (b)"`

---

## M8 — Tree verification + declared-impact addendum

### Task 8.1: Packed-types tree gate + full CI dry run

**Files:** none created; verification only.

- [ ] **Step 1: Build every benchmarking package + run the packed-types tree gate.**

```bash
for p in records testing aggregate run interop marketplace; do
  (cd packages/benchmarking/$p && yarn install --immutable && yarn build) || exit 1
done
node .github/scripts/benchmarking-packed-types.test.mjs
```

Expected: the packed consumer compiles against all six benchmarking public entrypoints (proves the `exports` maps resolve for external NodeNext-strict consumers). If M7 is deferred (marketplace plan absent), run over the five landed packages and note the deferral.

- [ ] **Step 2: Run the discovery packed-types gate** (`node .github/scripts/record-discovery-packed-types.test.mjs`) including `facts/benchmarking` (if discovery + M6 landed). Lint both CI workflows (`benchmarking-ci.yml`, `record-discovery-ci.yml`) for the final job DAGs.

- [ ] **Step 3: Run every package's suite + both guard trees once more** — all green.

- [ ] **Step 4: Commit** any incidental fixups; otherwise skip.

### Task 8.2: Declared-impact addendum (supersession, re-homed issues, companion-amendment reference)

**Files:**
- Create: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`

**Interfaces:**
- Produces the dated record (Status: informational; not a design change) of what the shipped `@jinn-network/benchmarking-*` packages + the `facts/benchmarking` leaf implement, and the declared-impact dispositions (design §17).

- [ ] **Step 1: Write the addendum.** Record:
  1. The six benchmarking packages + the facts leaf, the frozen surfaces they implement (design §14.1–.10), and the pinned identifiers (flagged to the program gate, Findings F1).
  2. **Companion amendment is NOT re-planned here (§17.5, assignment point 3):** the additive `benchrun`/`benchcell`/`bencharm` fields on the Submission/Delivery facts profiles are built by the record-discovery plan's M8 `facts/task-execution` leaf (recorded there as Addendum 2026-07-28-b); this plan only references them and owns the CloudEvents filter attributes on the four benchmarking record kinds.
  3. **SDK supersession (§17.2):** `packages/sdk/src/benchmarking.ts` (`BenchmarkRunV1`, `ConfigV1`, `CellV1`, `BenchMatrixV1`, `BenchPreregistrationV1` — merged #2046) is superseded by the §6–§9 records; it stays until these land, then retires. No consumer migration owed (nothing ships on those shapes).
  4. **#2038 disposition (§17.2, unchanged by implementation):** #2039/#2042 carry forward; #2044/PR #2219 continues on `next`; #2040/#2041/#2043/#2045 re-homed into the stack program (not re-opened here); #2047–#2054 re-derived from this spec at implementation planning (design §18.4 — a future issue-tree pass, not this plan).
  5. **Capability-eval v0 (§17.3):** not superseded; promoted — its statistics seeded `aggregate` (M3.2), its held-out slate becomes a committed Benchmark. Nothing forces migration.
  6. Deferred/non-blocking follow-ups with pointers: IANA registration of `vnd.jinn.benchmarking.*`; the reserved protocol/record-kind URI publication gate; the run-pinning enforcement legs (#2040/#2041) that turn marketplace `unverifiable` axes into `match|mismatch` (design §18.3); `bradley-terry@1` activation (§9.2); the tier-4 products (marketplace benchmarking service, capability-eval gate, skill factory, leaderboards — design §17.4, §19, all OUT).

- [ ] **Step 2: Add a one-line pointer** to this addendum from each package README.

- [ ] **Step 3: Commit.** `git commit -m "docs(benchmarking): implementation addendum (supersession, re-homed issues, companion-amendment reference)"`

---

## Out of scope

Explicitly **not** in this plan (tier-4 products, deferred design work, or other plans' scope):

- **Tier-4 products (design §2, §17.4, §19):** the marketplace benchmarking *service*, the capability-eval *gate*, the **skill factory**, and any **leaderboard** site or record beyond the Report. This plan builds tiers 2–3 only. A candidate skill is an arm and its benchmark report is a Report, but the factory itself is a separate future product design.
- **The `benchrun`/`benchcell`/`bencharm` Submission/Delivery facts fields** — owned by the record-discovery plan's M8 `facts/task-execution` leaf (Addendum 2026-07-28-b); referenced here, never re-planned (§17.5, assignment point 3).
- **A `bench` CLI / any binary product** — the §10.1 verbs (`import`/`plan`/`quote`/`launch`/`report`/`verify`) are exposed as library functions across `records`/`run`/`aggregate`/`interop`; the composing CLI is a tier-4 product (OUT). `bench verify`'s cross-package composition (`verifyMatrix` + `aggregate.verifyReport`) is likewise tier-4.
- **A log viewer / task-authoring framework** — Inspect's territory (§10.2, §19); we import/execute-with/export, no viewer, no authoring framework.
- **A group-verdict evaluation record** — comparisons stay consumer-side over per-cell verdicts; profiles keeps evaluation strictly per Task/Result pair (§19).
- **A confidential-execution tier** — private-until-reveal on open backends waits on a confidential-execution design; §6.4 states the honest limit (§19).
- **Dynamic pricing** — flat per-cell fees only (§19).
- **The run-pinning enforcement legs (#2040/#2041)** — re-homed into the stack program (local backend Workspace Provisioner + evidence Runtime Observation); before they land, marketplace cells report `unverifiable` axes honestly (design §18.3). Not built here.
- **The re-derived #2047–#2054 issue tree** — a future implementation-planning pass (§18.4), not this session.
- **Any on-chain deployment / the marketplace contract revision** — the contract revision is the marketplace plan's declared impact; deploys are a human-gated runbook item, never program work.

## Self-review

- **Spec coverage.** §6 Benchmark → M1.3/M1.6; §6.5 Croissant → M5.2; §7 Run + cellKey + Submission extension → M1.4; §7.2 legs (a)+(c) → M2.3/M4.4, leg (b) → M7.2; §8 Matrix + outcome derivation + deterministic assembly + integrity tiers → M1.5/M4.4; §9 Report + method registry + exclusion discipline → M1.5/M3; §9.2 methods → M3.2/M3.3; §10.1 six operations → import (M5.1), plan/quote (M4.2), launch&watch (M4.3), report (M3.3), verify (M4.4 tier-3 slice); §10.2 Inspect seams → M5.2/M5.3; §11 discovery facts leaf + CloudEvents attributes → M6; §12.1 named checks → records (M1.3/M1.4) + run (M4.4) + aggregate (M3.3); §13 backend profiles → M4 (local) + M7 (marketplace); §14 frozen interfaces → all pinned by fixtures; §16 conformance kit → M2; §17 declared impact → M8.2; §18 sequencing → the milestone map + per-milestone gates.
- **Placeholder scan.** Frozen field sets, record schemas, cellKey grammar, outcome vocabulary, named checks, method URIs, and guard constant blocks are fully specified. Long procedures (deterministic assembly, the statistics library) are specified by exact behavior + the kit fixtures that gate them (the kit is the executable spec), matching the sibling plans' altitude. No "TBD"/"handle edge cases"/"similar to" placeholders.
- **Type consistency.** `BenchmarkRecord`/`RunRecord`/`MatrixRecord`/`ReportRecord`, `Outcome`/`OUTCOME_VOCABULARY`, `cellKey`/`expectedCellSet`/`submissionExtensionBlock`/`cellIdempotencyKey`, `checkComparability`/`checkRevealConsistency`/`checkJudgeability`, `MethodRegistry`/`produceReport`/`verifyReport`, `assembleMatrix`/`verifyMatrix`, the injected ports (`InputScope`/`TrustResolver`/`CloseBoundaryResolver`/`PinningObservationPort`/`AdmissionEvidencePort`/`CostSource`), and the kit drivers (`describeRecordConformance`/`describeMethodRegistryConformance`/`describeAssemblyConformance`/`describeExportConformance`/`describeOrderingConformance`) are each defined once and referenced by name thereafter.

## Findings (surface to the coordinator; do not silently resolve)

- **F1 — Pinned-identifier program-gate flags.** Every URI, media type, record-kind URI, method URI, assembly-procedure id, and the `jinn:benchmarking-reports` scope is pinned in this plan (the design uses working titles, §6.1/§7.1/§8.1/§9.1/§9.2/§12.1). Surfaced for the program gate (mirroring discovery F1). Sub-flag: the design freezes `protocol: "jinn.benchmarking/1.0"` as a bare token, unlike TEP's https-URL `protocol` — reconcile URL-vs-token at the gate. Sub-flag: the four **record-kind URIs** were **pre-aligned at fix time** from the design's non-conforming `jinn.benchmarking.record/*` working token to the record-discovery grammar `${RECORDS_ROOT}/<segment>/<major>.<minor>` — `https://jinn.network/records/{benchmark,benchmark-run,benchmark-matrix,benchmark-report}/1.0`, verified against `2026-07-28-record-discovery.md` §Pinned-identifiers (`RECORD_KINDS` + `SOURCE_NAME_GRAMMAR` + `assertRecordKindUri`) so M1 freezes grammar-conformant identifiers; the shape stays on the program-gate list and the implemented `assertRecordKindUri` is re-checked at the Phase 3 merge (M6). IANA registration of `vnd.jinn.benchmarking.*` is a follow-up (program §8 lists the other three trees but not benchmarking, which postdates that list).
- **F2 — Marketplace-mode gates on an un-drafted plan.** The marketplace-binding **plan** does not yet exist (only `2026-07-28-marketplace-binding-design.md`), and `packages/marketplace/*` is absent. M7 is written to gate hard on both and composes against the design's §11 frozen interfaces + program §7.18 (consume the binding only through `TaskExecutionBackend`). If the marketplace plan chooses different package/export names, M7 binds at implementation time. This is a sequencing coordination, not an open design question — M7 is the last milestone by construction.
- **F3 — `records` depends on `task-execution-protocol` ONLY.** Design §15 says records "imports protocol layers only." I read that as `task-execution-protocol` only (the Benchmark/Run/Matrix/Report schemas need protocol's sealing + ResourceDescriptor + run-pinning vocabulary, not profiles). Profiles enters at the kit (M2), run (M4 `verdict-spec-match`), interop (M5), and aggregate is profiles-free. If the coordinator intends records to hard-depend on `task-execution-profiles`, flag it — I kept records minimal so M1 can start on the present TEP protocol without waiting on profiles.
- **F4 — Trust-core frozen-surface adaptation.** The Report DSSE signer (M3.3) and the `TrustResolver`/`evaluator-independence` port impls (M4/host) adapt to trust-core's frozen exports (`dssePreAuthEncoding`, key-binding resolution, DSSE verification), settled by `2026-07-28-trust-layer.md`. Named by role here; bound to concrete symbols at implementation against the built `@jinn-network/trust-core` (mirrors discovery F5). Program §7.15 fixes that TEP protocol exports no PAE — the Report envelope uses trust-core, not a duplicated primitive.
- **F5 — Facts leaf gates on discovery (Phase 3, in flight).** M6 needs `packages/discovery/{protocol,testing}`, absent on this branch. The leaf conforms to the record-discovery facts kit and registers into the discovery tree guards (not the benchmarking guards) — the four-guard append + `FactsRecompute` seam per program §7.13 / discovery F3. The `benchmarking-records` import into a discovery leaf is the sanctioned `facts/*` leaf edge (program §6 confirmation item 4).
- **F6 — A sixth benchmarking package (`marketplace`) beyond design §15's list.** Design §15 lists records/run/aggregate/interop/facts/testing (working titles). To honor "no marketplace imports outside the final marketplace-mode milestone" (assignment point 5) while keeping `run` backend-neutral, the marketplace venue is its own package (`benchmarking/marketplace`), the sole marketplace-importing package. This is an additive structural refinement of §15, not a semantic change (the design already separates local vs marketplace backend profiles, §13). Flag for confirmation.

## Open items (deferred; design §18/§20 follow-ups, not blocking v1)

- The re-derived #2047–#2054 issue tree happens at implementation planning, not in this plan (§18.4).
- `bradley-terry@1` activation if pairwise-judged benchmarks appear (§9.2/§20).
- Named subsets/weights on Benchmark records (§6.6/§20) if demand appears.
- Re-derivable-tier grading requirement for replaced cells — a product-policy candidate (§12.3/§20).
- Matrix-validation-as-a-task (a marketplace task that independently recomputes a matrix) — a trust product candidate, not v1 (§20).
- Repo-wide applications-vs-products taxonomy docs pass (§2/§20) — a follow-up owned by the program docs lane, not this plan.

## Addendum 2026-07-28-b — bench-field wire placement (cross-plan coordination)

The implemented `facts/task-execution` leaf reads the Addendum-2026-07-28-b benchmarking
fields from `submission.annotations.{run, cellKey, armId}` (grounded in TEP's
correlation-annotation doc-comment) and, for the Delivery, from top-level loose extension
fields `run`/`cellKey`/`armId` — a documented ASSUMPTION, since no spec pins the exact JSON
path. This plan's M1 (record schemas) and M4 (run orchestration/dispatch) MUST either emit
exactly those keys or pin different ones — in which case the leaf's recompute gets the
one-line correction, at that moment, as a coordinated pair of edits. Confirmed at the
program-extension gate.

## Addendum 2026-07-28-c — protocol identifier (operator ruling at the extension gate)

The `protocol` field of all four benchmarking record kinds is the https URL form
**`https://jinn.network/protocols/benchmarking/1.0`** — consistent with the TEP / profiles /
discovery convention. The design's literal bare token `jinn.benchmarking/1.0` is superseded on
this point (operator ruling, 2026-07-28, program §10 gate). All schemas, sealed goldens, and
pinned digests use the URL form from day one.

## Addendum 2026-07-29-d — independent M1–M3 design-review rulings

The first independent M1–M3 design review rejected the implementation and surfaced one
frozen-interface ambiguity plus one under-specified deterministic-method detail. The following
rules are binding on the repair and supersede any singular/collapsed reading of M3.3:

1. **Plural Report disclosures are lossless.** `subjects[]` remains plural.
   `disclosures.perSubject[]` has exactly the same length and order. Each entry contains
   `subjectSha256` (the corresponding subject descriptor's exact lowercase-hex sha256) and
   carries that Matrix's `integrityTiers`, `pinning`, `independence`, `completeness`, and
   `attrition` blocks verbatim. Production and verification reject missing, duplicate,
   reordered, mismatched, or rewritten entries. V1 defines no authoritative cross-subject
   disclosure aggregate; consumers may derive convenience views outside the sealed Report.
2. **Pre-registration across plural subjects is universal.** Producers derive
   `preregistered`; callers do not assert it. `true` means the exact method tuple — id,
   version, contract-wide `verdictRule`, and the complete parameters object — occurs in every
   resolved subject Run's `analysisPlan[]`. Missing/unresolvable Runs or any byte-distinct tuple
   yield false/absence; a Report claiming true in those cases fails verification.
3. **Reference methods are replay-deterministic.** No method accepts an unsealed RNG or
   author-supplied derived observations. Every result is derived from exact subject bytes,
   exact referenced-record bytes, and the sealed method tuple. A bootstrap method's parameters
   declare its seed and resample count; its registry spec declares the exact PRNG/resampling
   procedure, and independent fixtures pin the result. `noninferiority-iut@1` derives paired
   quality and both-solve costs from Matrix cells, implements actual BCa including jackknife
   acceleration, reports excluded pairs, and returns PASS/FAIL/INCONCLUSIVE through the
   specified intersection-union rule.
4. **Report verification starts from received bytes.** It consumes the exact Report DSSE
   envelope bytes and exact subject Matrix bytes, verifies payload/media type/signature
   offline, resolves signer-to-`author` binding at the effective time under
   `jinn:benchmarking-reports`, and hashes subject bytes without re-sealing parsed objects.
   Missing, malformed, revoked, wrong-scope, wrong-author, substituted, or noncanonical inputs
   fail closed with a named check.
5. **The kit remains prior to its consumers.** M2 lands the complete miniature-run,
   assembly/ordering, method, comparability, clustering, exclusion, and export fixture corpus
   plus real injected drivers. Future implementation drivers may compile without invocation,
   but their byte-exact oracles and mandatory cases are not deferred to M4/M5.

## Addendum 2026-07-29-e — deterministic bootstrap and McNemar replicate boundary

The repaired M2 kit exposed two method details that the design named but did not spell down to
replay bytes. Program rulings §7.26–§7.27 are binding:

1. `noninferiority-iut@1` declares `xorshift32-v1` exactly as program §7.26 specifies. Its
   sealed parameters contain a nonzero uint32 `seed` and positive integer `resamples`; the
   paired-task vector is code-unit ordered; sampling consumes exactly one uint32 draw per
   position. Actual BCa jackknife acceleration is deterministic and consumes no PRNG draw.
2. `paired-mcnemar@1` is valid only for resolved subjects whose `Run.replicates === 1`.
   Multiple replicates fail closed as an incompatible method input. V1 does not silently reduce
   replicates by majority, any-pass, last-write, or another unsealed choice; the registered
   multi-replicate methods own those analyses. M2 fixture-pins one exact R=1 computation, one
   R>1 refusal, provenance clustering, and the complete excluded-cell remainder.

The review's remaining findings are direct design/plan violations, not new choices: enforce
digest-bearing record references; validate Task/evaluation judgeability and ordered Benchmark
versioning; require open-competition independence gating; fail closed on missing verdicts and
unresolved Benchmark identity; keep arm identity in repetition estimators; require the pinned
provenance cluster; bind clean-subset basis to its acquisition procedure; keep
`bradley-terry@1` registered/non-reference/unavailable until genuine pairwise inputs exist; and
apply program §7.24's I-JSON Unicode-scalar rule.

## Addendum 2026-07-29-f — benchmark-eligible provenance refinement

The second independent M1–M3 review found that benchmarking design §6.1/§9.2 requires a source
family and creation time that the authoritative `repository-work/1.0` document does not require.
Program ruling §7.46 resolves the interface conflict without changing that generic profile or its
pinned digest:

1. Any Task referenced by a Benchmark is a stricter consumer-side subset. Once exact Task bytes
   are available, `benchmark-judgeability` requires a valid RFC 3339
   `payload.provenance.timestamp` and exactly one of a non-empty `payload.provenance.source` or a
   lowercase `sha256:<64 hex>` `payload.provenance.sourceCommitment`.
2. A commitment is an opaque, stable, author-claimed source-family grouping token. Its tagged
   value, or the tagged plaintext source, is the only clustering key. A Report author cannot
   provide or rewrite it.
3. All clustering methods resolve the exact participating Task bytes and disclose clustering
   basis and count. This includes `noninferiority-iut@1`; declaring the rule without applying it
   is nonconforming.
4. Provenance failure is a judgeability failure (or `unevaluated` before reveal), not a late
   statistical surprise. Benchmarking fixtures use a real published Task profile plus this
   refinement rather than profileless payload inventions.

The same review's SemVer finding is a direct §6.2 defect: the cross-record transition check must
bind predecessor bytes, require strictly increasing SemVer precedence (build metadata alone does
not increase precedence), and require the first changed core component — or a same-core
prerelease precedence increase — to agree with the classified patch/minor/major content change.
Downgrades, equal precedence, and wrong bump classes fail closed.

## Addendum 2026-07-29-g — non-inferiority cluster bootstrap

Program ruling §7.47 closes the replay ambiguity exposed by the second review. The
`noninferiority-iut@1` quality BCa leg resamples whole provenance-source clusters, not individual
Tasks: sort tagged cluster keys and member Task digests by UTF-16 code units; draw exactly `C`
clusters with replacement per resample using one xorshift32-v1 draw per cluster position; expand
all members of each sampled cluster; compute the task-weighted mean; and derive acceleration by
deleting one whole cluster at a time without consuming PRNG draws. Fewer than two clusters is
`INCONCLUSIVE`, never an iid fallback. Exact cluster membership/basis/count, bootstrap unit, and
draw count are disclosed. The cost leg stays the separately frozen paired-task Wilcoxon.

This supersedes Addendum e's task-position sampling only for this quality bootstrap; the same
nonzero uint32 seed and xorshift transition rules remain binding.

## Addendum 2026-07-29-h — strict civil time and non-vacuous cluster conformance

The fifth independent M1–M3 review found two direct conformance defects. Program rulings
§7.50–§7.51 are binding on the final repair:

1. All benchmarking consumers share one calendar-strict RFC 3339 validator. A host
   `Date.parse` success is not validation because some runtimes normalize impossible dates.
   Judgeability, resolved provenance, registry parameters, clean-subset anchoring, and Report
   effective-time verification reject impossible civil dates such as February 30 without
   normalizing the sealed string. The generic repository-work profile and digest do not change.
2. The mandatory `noninferiority-iut@1` gate pins an independently calculated,
   nonconstant/nonzero-acceleration whole-source-cluster BCa oracle with unequal non-singleton
   clusters and asserts its complete quality result. A second exact vector changes only tagged
   source grouping while holding observations, seed, resamples, and method parameters fixed; its
   numeric lower bound must differ exactly. Metadata-only and singleton-cluster fixtures do not
   satisfy M2 conformance because they cannot distinguish §7.47 from iid task resampling.

These repairs do not reopen the statistic or the published profile. They make the already-frozen
validation and resampling rules executable under the standard package commands.

## Addendum 2026-07-29-i — exact authority-time ordering and Report envelope bytes

The sixth independent M1–M3 review reproduced two semantic defects even though all package and
guard commands were green. Program rulings §7.57–§7.58 are binding on the next repair:

1. The shared calendar-strict RFC 3339 boundary gains one exact-instant comparator. It applies
   offsets and preserves every fractional digit; epoch-millisecond projection is forbidden for
   authority ordering. Clean-subset cutoff and announcement-anchor comparisons must distinguish
   `.0001Z` from `.0002Z`, while equal instants written under different offsets compare equal.
   Validation and comparison retain the original sealed strings.
2. `verifyReport` starts with trust-core's authoritative exact DSSE-envelope parser/round-trip.
   The received closed-shape envelope must byte-equal the output of the existing canonical
   producer reconstructed from its decoded payload and ordered signatures. Pretty/reordered,
   trailing, duplicate-member, extra-member, and non-producer-base64 variants fail
   `report-envelope` before trust verification. Tests use signature semantics over DSSE PAE so a
   raw-envelope-equality double cannot make the vectors pass vacuously.

M4 remains blocked until this repair passes the records, aggregate, testing, trust-core, guard,
pack, and workflow-definition gates and a fresh independent reader returns GREEN.

## Addendum 2026-07-29-j — trust time, reveal state, and final M1–M3 repairs

The seventh fresh M1–M3 review returned RED on seven reproduced defects while every existing
package and guard command remained green. Program rulings §7.63–§7.69 freeze the repair:

1. trust-core replaces lexical binding-window and revocation ordering with its own
   calendar-strict, arbitrary-precision exact-instant comparator, including offset-equivalent and
   lexically misleading revocation vectors;
2. the trust DSSE producer rejects empty signatures and proves producer→exact-parser round-trip;
3. record schemas use the shared civil RFC 3339 predicate directly so valid leap seconds are not
   rejected by a narrower host/Zod prefilter;
4. missing immediate-reveal Task material fails closed, and scheduled/after-run `unevaluated`
   requires explicit trusted evidence that reveal has not occurred;
5. `noninferiority-iut@1` declares its designed shared-Task version robustness and proves one
   genuine cross-Benchmark pairing;
6. both cell-dispatch helpers validate the exact lowercase sha256 Run identity before deriving
   annotations or idempotency keys; and
7. the benchmarking inventory removes its hardcoded count and derives cardinality from the live
   declaration as required by the program guard rule.

The repair is test-first and runs the complete records, aggregate, testing, trust-core, profiles,
inventory, boundary, packed-type, pack, and workflow-definition gates. M4 remains blocked until a
new independent whole-design review of the exact repaired head returns GREEN.

## Addendum 2026-07-29-k — exact Cartesian bounds and fully attrited arms

The eighth fresh M1–M3 review found two remaining semantic gaps after independently clearing every
§7.63–§7.69 repair. Program rulings §7.70–§7.71 are binding:

1. Cartesian cardinality is computed with `BigInt` and must be proven safe before conversion.
   The array-returning `expectedCellSet` shares that preflight and has an explicit one-million-cell
   materialization ceiling; the count helper remains exact and usable for larger safe counts.
   A valid maximum-safe replicate count can no longer round or begin an effectively unbounded
   loop.
2. Wilson, avg-at-k, and pass-at-k seed results from every arm represented by the subject Matrix,
   not only arms with decisive cells. A fully attrited arm remains visible with the methods'
   existing zero-scorable/empty-per-task shapes and complete missing-Task disclosure.

The repair adds the exact overflow and materialization-bound vectors plus one sealed two-arm
fully-attrited fixture exercised by all three methods. Records, aggregate, testing, trust,
profiles, schema/profile pins, package gates, guards, packs, and workflows run again. M4 remains
blocked until another fresh whole-design review returns GREEN.

## Addendum 2026-07-29-l — exact provenance, decimals, schemas, and bounded verification

The ninth fresh M1–M3 whole-design review rejected an otherwise-green head. Program rulings
§7.76–§7.84 freeze the repair:

1. one records-owned exact canonical Task/provenance resolver drives judgeability and every
   aggregate clustering/cutoff consumer; a malformed present claim and a canonical non-Task fail
   closed;
2. completeness floors and comparisons use exact scaled-integer arithmetic, while the
   noninferiority cost leg ranks exact decimal differences under one common unit;
3. every arm's pinning keys are disjoint from the Run submission baseline;
4. Report independence disclosure resolves the exact Run and counts only judged cells under its
   disclosed policy;
5. generated Draft 2020-12 schemas enforce the representable runtime wire rules and carry an
   executable fixture-parity gate;
6. `noninferiority-iut@1` exports and enforces the v1 maximum of 100,000 resamples before work;
7. the paired-exclusion vector reaches and asserts its complete `R = 1` remainder rather than
   passing through the separate replicate incompatibility; and
8. a zero eligible-cell denominator is partial unless the Run is explicitly cancelled, never
   synthetically complete.

The repair is test-first. Hostile vectors include valid source plus malformed commitment,
canonical non-Task bytes, decimal underflow/above-one and values above `2^53`, mixed cost units,
baseline/pinning collision, expired and gating independence cells, invalid civil time,
leap-second schema acceptance, unnamespaced aggregate, maximum-plus-one resamples, and the exact
pairing remainder. The full records, aggregate, testing, trust/profile consumer, schema/profile
pin, guard, packed-type, and workflow gates run again.

The same review's two non-blocking hygiene notes are included in this repair: the ambient-network
scanner receives a self-test and is applied to benchmarking production source, and the aggregate
README points to the real testing-package conformance entrypoint. M4–M7 remain blocked until
another fresh whole-design review accepts M1–M3.
