# C4 — Task Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Date:** 2026-07-31
- **Component:** C4 of the verified-environment supply program
  ([`2026-07-31-supply-program.md`](2026-07-31-supply-program.md)).
- **Design (law):**
  [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  (approved, commit `5b0739832`) — §7.2 (derivation), §7.3 (honesty surface), §3 (seam
  test), §12 (non-goals), D5/D12.
- **Package:** `@jinn-network/task-derivation` at `packages/task-supply/derivation`.
- **Branch:** `supply/c4-task-derivation`, based on `supply/c3-task-admission`
  (which bases on `supply/c1-environment-record`, which bases on
  `integration/evidence-v1`).

**Goal:** ship the strategy seam and its one v1 member — given a described execution
environment (a sealed environment record) plus upstream rows, produce **admitted, sealed
Task + EvaluationSpec pairs in a supply pool**, where every pair's inline environment
fields are copied *from* the record (so C3's inline-match rule passes by construction),
every pair carries `provenance.kind: "mined"` with a precisely-defined
`provenance.sourceCommitment`, and the gold patch that made admission possible **never
enters the pool**.

**Architecture.** Four rings, outward-facing only:

1. **Local primitives** (`order`, `canonical`, `digest`, `errors`) — a code-unit
   comparator, a small RFC 8785 JCS serializer for the bytes *this* package authors (the
   source-commitment pre-image and the pool's entry manifest), and digest helpers that
   keep the prefixed/bare distinction (program §5 contract 6) type-visible. Re-implemented
   locally per the house per-package rule, with equivalence tests against
   `@jinn-network/task-execution-protocol`'s serializer and digest.
2. **The candidate vocabulary** (`candidate`, `source-commitment`,
   `environment-extension`, `strategy`) — what a strategy yields, what an upstream
   identity commits to, and the exact namespaced EvaluationSpec key
   `network.jinn.environment.record`. Note what a `Candidate` deliberately does **not**
   carry: image, platform, parser. Those come from the environment record, and that
   omission is what makes the C3 match rule structurally unfailable rather than
   defensively re-checked.
3. **The sealed-pair builder** (`seal-pair`) — reuses profiles'
   `sweRebenchRowToTaskAndSpec` for the EvaluationSpec body (family block assembly,
   `accessClass: "public"` enforcement, measurements, verdict rule, unscorable
   dispositions), then overlays the record-authoritative platform and the namespaced
   environment-record key, seals the spec, and builds + seals the Task around the spec's
   digest.
4. **The run** (`pool`, `gold`, `run`) — `runDerivation` pipes candidates through an
   injected `AdmissionPort`, discards refusals into a typed summary, and writes survivors
   to a digest-addressed `SupplyPool`. Gold patch bytes go to a separate, local-only
   `GoldStore`; `PoolEntry` has no field that could carry them.

Custody law is honored by omission: C4 holds no signer, opens no socket, and its only
filesystem access lives behind the two store implementations. The adapter that binds C3's
`admitCandidate` + `sealReceipt` to the `AdmissionPort` interface belongs to the tier-4
composition, not here — C4 ships the interface and a test double.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:`
resolution for in-repo dependencies); zod 4.4.3; `@noble/hashes` 2.2.0; vitest 4.

## Global constraints (program §5)

- **Designs are law.** A defect found here is a dated Finding with a proposed disposition
  (see Findings below), never a silent patch.
- **Kits and fixtures precede implementations.** C1's and C3's kits are green on the base
  before C4's first implementation task lands.
- **Sealing re-implemented per package.** C4 re-implements only the canonicalization and
  digesting of bytes *it* authors. Task and EvaluationSpec bytes are produced by their
  owning packages' sealers (`sealTask`, `sealEvaluationSpec`) — you do not re-implement
  another kind's sealing to produce that kind's documents. Equivalence fixtures prove the
  local serializer agrees with protocol's.
- **Custody law.** No key material, no ambient authority (no ambient `fetch`, no ambient
  clock, no ambient randomness). Ports injected; fail closed.
- **No product names** in tiers 1–3. `swe-rebench` appears only as an *upstream format
  identity* (the precedent is profiles' own `documents/swe-rebench.ts`), never as a
  product. No source file imports `@jinn-network/core`, `@jinn-network/plugin`,
  `@jinn-network/jinn-layer`, `@jinn-network/sdk`, or anything under `client/`.
- **Digest discipline.** Record-body digests are `sha256:`-prefixed; DigestSet-shaped maps
  (`digest: {sha256: …}`) carry **bare** lowercase hex. The confusion fixture ships in
  this package's kit.
- **Bounded claims.** No API name, log line, error message, comment, or doc sentence in
  this package says "deterministic" (except the frozen family identity
  `deterministic-process`) or "verified" without the K/controls or trust-policy
  qualification the design gives those words. Task 12 ships a test that enforces this.
- **Non-goals are binding (§12).** No injection strategy. No statement generation. No echo
  mining. No pricing. No posting. Any step that starts building one of those is a defect —
  stop and report.
- **Stop on missing Consumes.** A symbol a task consumes that is not on the base branch is
  a stop-and-report, not an improvisation.
- **Legacy is reference only.** `client/src/solver-types/_swe-rebench-v2-minted-pool.ts`
  and its siblings are read for vocabulary; never imported.
- **TDD per task; verification before completion.** Every task ends with `yarn typecheck`
  and `yarn test` in the package plus the tree guards, outputs shown, before the task is
  reported done.

---

## Findings (2026-07-31, planning-time)

Filed per contract 1. None blocks implementation; each proposes a disposition to be taken
at the program-end integrated review.

**(a) §3.3's dependency diagram omits the derivation → profiles/protocol edge.**
The diagram draws `derivation ──► admission ──► environments/record` and annotates the
profiles arrow as "by-digest reference, not a package import in either direction". That
annotation is about `environments/record` ↔ `profiles`. But C4's pinned output *is* sealed
Task + EvaluationSpec pairs, which cannot be produced without `sealTask`
(`@jinn-network/task-execution-protocol`) and `sealEvaluationSpec` +
`sweRebenchRowToTaskAndSpec` (`@jinn-network/task-execution-profiles`).
*Disposition:* the edge is legal — tier-3 → tier-2, with the frozen direction intact and
profiles unmodified. Propose a one-line diagram amendment at the program review. C4
proceeds.

**(b) Program §4 pins `admitCandidate`'s signature but not its candidate or refusal-code
type names.** C4 must name C3's candidate type to compile.
*Disposition:* C4 assumes `AdmissionCandidate` and `AdmissionRefusalCode` and confines
both to a single adapter function (`toAdmissionCandidate`, Task 10). Task 10 Step 1
verifies the real exported names on the base branch and binds to them; absence of the
*concept* (not just the name) is a stop-and-report. Propose pinning both names as a
program-plan amendment.

**(c) `repository-work/1.0`'s payload schema declares `provenance` but not `rights`.**
D12 requires the SPDX expression recorded per task. The profile's `payloadSchema` is
`additionalProperties: true`, so `payload.rights.sourceLicense` validates today as an
undeclared-but-permitted field.
*Disposition:* ship it now under `payload.rights.sourceLicense` (mirroring the environment
record's own `rights.sourceLicense` vocabulary, §4.2); propose a finding to the profiles
spec — declare `rights: {sourceLicense: string}` in the `repository-work/1.0` payload
schema, additive, same class as F1.

**(d) The `swe-rebench` mapper's actual export shape is narrower than §7.2 assumes.**
Verified at `packages/task-execution/profiles/src/documents/swe-rebench.ts` on
`integration/evidence-v1`: `sweRebenchRowToTaskAndSpec(row: SweRebenchRow)` returns exactly
`{evaluationSpec, evaluationSpecDigest, taskPayload, taskInputs}` (lines 26–31, 47–91).
Three gaps against §7.2: it hardcodes `platform: "linux/amd64"` (line 51) and builds the
repository input from a GitHub URL template (line 85) — the environment record is
authoritative for both (`image.platform`, `source.repoUrl`, `source.commit`), and a record
may legitimately be `linux/arm64` or non-GitHub; and its `taskPayload` writes
`provenance: {kind: "mined"}` with **no** `sourceCommitment` and no `rights` (line 79).
It also carries no environment-record reference of any kind. So the mapper fits the
EvaluationSpec half and not the Task half.
*Disposition:* C4 reuses the mapper for the EvaluationSpec body (family-block assembly,
`accessClass: "public"` stamping, measurements, verdict rule, unscorable) and overrides
`platform` from the record; C4 builds the Task's `inputs` and `payload` itself — from
`source.repoUrl` + `source.commit`, plus `sourceCommitment` and `rights` — rather than
using `mapped.taskInputs` / `mapped.taskPayload`. A drift-guard test (Task 6) asserts the
locally built payload still agrees with the mapper's on the fields they share. All
deviations are documented at the call site. Propose (additive, non-blocking) that the
mapper accept `platform` as a parameter.

**(e) C2 and C4 each declare an upstream-row shape.** C2 groups rows into environment
records; C4 imports rows into candidates. C2 is not in C4's branch stack, so C4 cannot
consume its type.
*Disposition:* declare locally in both — the precedent is profiles' own
`LegacyJinnRepoTask` ("declared locally, never imported"). §3.2 already rejected a shared
row-fetching unit. Reconcile at the program review only if a third consumer appears.

**(f) §7.2 does not state whether the namespaced key's `digest.sha256` is bare hex or
`sha256:`-prefixed.** It writes `{"digest": {"sha256": "…"}}`.
*Disposition:* **bare lowercase hex**, matching every other `digest.sha256` in profiles
(`{ sha256: stripSha256Prefix(...) }`) and contract 6's DigestSet rule. C4 pins this,
exports the reader that enforces it, and ships the confusion fixture. Flag at the program
review so C3's match rule reads the key the same way.

**(g) NOTE — the family block's `workspace` stays `{}`.** The environment record carries
`workspace: "/testbed"` as a string; the block's `workspace` is an object. C4 does not
invent a mapping. *Disposition:* no change; the record is the join point, and F1's
first-class field is where this consolidates.

**(h) NOTE — statement-digest conventions are not shared across C3 and C4.** C4 defines
its own statement digest as an *input to* `sourceCommitment` (rule
`network.jinn.source-commitment/1`). C3's receipt has its own statement digest.
*Disposition:* no cross-package assertion in v1 (contract 6 governs digest *encoding*, not
a shared statement-hash rule); compare the two at the program-end integrated review.

---

## File structure

All paths relative to `packages/task-supply/derivation/` unless noted.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `vitest.config.ts`, `README.md` | package scaffold |
| `scripts/build.mjs`, `scripts/pack-smoke.mjs` | tsc build; tarball consumer smoke |
| `src/errors.ts` | `DerivationError` + its category union |
| `src/order.ts` | `compareCodeUnitStrings` |
| `src/canonical.ts` | local JCS serializer for bytes this package authors |
| `src/digest.ts` | `sha256Hex`, `documentDigest`, prefixed/bare guards, `digestsEqual` |
| `src/source-commitment.ts` | `statementDigest`, `computeSourceCommitment` (first writer of `provenance.sourceCommitment`) |
| `src/environment-extension.ts` | `ENVIRONMENT_RECORD_EXTENSION_KEY` + build/read |
| `src/candidate.ts` | `Candidate`, `CandidateTestMaterial`, `assertCandidate` |
| `src/strategy.ts` | `DerivationStrategy`, `DerivationEnvironment`, `loadDerivationEnvironment`, `DerivationLogger` |
| `src/seal-pair.ts` | `buildCandidateEvaluationSpec`, `buildSealedTask` |
| `src/strategies/import.ts` | `importStrategy`, `UpstreamRebenchRow`, license policy |
| `src/pool.ts` | `SupplyPool`, `PoolEntry`, `PoolEntrySummary`, manifest schema |
| `src/pool/filesystem.ts` | `createFilesystemSupplyPool` (atomic, digest-addressed) |
| `src/gold.ts` | `GoldStore`, `GoldRef` |
| `src/gold/filesystem.ts` | `createFilesystemGoldStore` (local-only) |
| `src/run.ts` | `AdmissionPort`, `DerivationDeps`, `runDerivation`, `PoolWriteSummary` |
| `src/index.ts` | public surface |
| `src/testing.ts` | `./testing` entrypoint — stub admission port, fixture loaders |
| `src/kit/*.test.ts` | the conformance kit (golden run, refusal path, gold-never-in-pool, namespaced key, bounded claims) |
| `fixtures/environment/*` | fixture environment record (source + sealed bytes) |
| `fixtures/rows/rows.json` | fixture upstream rows |
| `fixtures/golden/*` | byte-exact expected sealed pairs, entry manifests, pinned digests |

Repo files this plan also edits (all created by C3, which owns the `packages/task-supply/`
tree): `.github/scripts/task-supply-package-inventory.test.mjs`,
`.github/scripts/task-supply-source-boundaries.test.mjs`,
`.github/scripts/task-supply-packed-types.test.mjs`,
`.github/workflows/task-supply-ci.yml`.

---

### Task 1: Verify the base, scaffold the package, register it with the guard trio

**Files:**
- Create: `packages/task-supply/derivation/package.json`, `tsconfig.json`,
  `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `vitest.config.ts`,
  `scripts/build.mjs`, `src/index.ts`
- Modify: `.github/scripts/task-supply-package-inventory.test.mjs` (roster, dependency
  graph, manifest count), `.github/scripts/task-supply-source-boundaries.test.mjs`
  (directory list, filesystem carve-out), `.github/scripts/task-supply-packed-types.test.mjs`
  (packages + entrypoints), `.github/workflows/task-supply-ci.yml` (new `derivation` job)

**Interfaces:**
- Consumes — from `supply/c1-environment-record`: the package
  `@jinn-network/environment-record` at `packages/environments/record`.
  From `supply/c3-task-admission`: the package `@jinn-network/task-admission` at
  `packages/task-supply/admission`, the three guard scripts, and
  `.github/workflows/task-supply-ci.yml`.
  From `integration/evidence-v1`: `@jinn-network/task-execution-profiles`,
  `@jinn-network/task-execution-protocol`.
- Produces: the package directory `packages/task-supply/derivation` publishing
  `@jinn-network/task-derivation` with exports `.` and `./testing`.

- [ ] **Step 1: Verify every Consumes provider exists on the base branch**

```bash
git log --oneline -3
ls packages/environments/record/package.json packages/task-supply/admission/package.json
ls .github/scripts/task-supply-package-inventory.test.mjs \
   .github/scripts/task-supply-source-boundaries.test.mjs \
   .github/scripts/task-supply-packed-types.test.mjs \
   .github/workflows/task-supply-ci.yml
node -e "console.log(require('./packages/environments/record/package.json').name)"
node -e "console.log(require('./packages/task-supply/admission/package.json').name)"
```

Expected: the two `node -e` lines print `@jinn-network/environment-record` and
`@jinn-network/task-admission`; all four `.github` paths exist.
**Any missing path is a stop-and-report (program §5 contract 11) — do not scaffold the
tree yourself; C3 owns it.**

- [ ] **Step 2: Verify the exact C1 and C3 symbols this plan binds to**

```bash
grep -n "export" packages/environments/record/src/index.ts
grep -n "export" packages/task-supply/admission/src/index.ts
```

Expected from C1 (program §4): `EnvironmentRecord`, `parseEnvironmentRecord`,
`sealEnvironmentRecord`, `environmentRecordDigest`, `ENVIRONMENT_RECORD_KIND`,
`ENVIRONMENT_RECORD_MEDIA_TYPE`, `CommandSpecSchema`.
Expected from C3 (program §4): `admitCandidate`, `DifferentialAdmissionReceiptV3`,
`sealReceipt`, an `AdmissionResult` union, plus the candidate parameter type and the
refusal-code type (Finding (b): names assumed `AdmissionCandidate` and
`AdmissionRefusalCode`).

Record the two actual names in a scratch note; Task 10 binds to them. If either *concept*
is absent — no candidate parameter type at all, or no refusal code — stop and report.

- [ ] **Step 3: Register the package in the inventory guard so it fails first**

In `.github/scripts/task-supply-package-inventory.test.mjs`, add to the package roster
array (the `TASK_SUPPLY_PACKAGES`-shaped list C3 created), after the `admission` entry:

```js
  ['derivation', '@jinn-network/task-derivation'],
```

Add to `JINN_DEPENDENCY_GRAPH`, after the `admission` entry:

```js
  // derivation produces sealed Task + EvaluationSpec pairs, so it consumes the packages
  // that OWN those two kinds' sealing (protocol, profiles) alongside the record type (C1)
  // and the admission surface it pipes candidates through (C3). Planning Finding (a): the
  // design's §3.3 diagram omits this tier-3 -> tier-2 edge; the edge is legal and the
  // diagram amendment is proposed at the program review.
  ['derivation', {
    dependencies: [
      '@jinn-network/environment-record',
      '@jinn-network/task-admission',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
    ],
    devDependencies: [],
    optionalDependencies: [],
    peerDependencies: ['vitest'],
  }],
```

Bump the manifest-count assertion by one and update its test name to match. If the guard
carries an external-package roster (the `EXTERNAL_JINN_PACKAGES` shape), add
`['packages/task-execution/profiles', '@jinn-network/task-execution-profiles']` and
`['packages/task-execution/protocol', '@jinn-network/task-execution-protocol']` unless C3
already did.

- [ ] **Step 4: Register the package in the boundary and packed-types guards**

In `.github/scripts/task-supply-source-boundaries.test.mjs`, add `'derivation'` to the
directory list. The tree's production source is otherwise filesystem-free; derivation's
two store implementations are its only `node:fs/promises` consumers, so add the
file-scoped carve-out beside the directory list:

```js
// The supply pool and the gold store are this tree's only production filesystem consumers
// (program §4 pins a filesystem SupplyPool implementation with atomic writes). The carve-out
// is file-scoped on purpose: derivation's core (candidate building, sealing, runDerivation)
// stays I/O-free and unit-testable without a disk.
const FILESYSTEM_ALLOWED_SOURCES = [
  'derivation/src/pool/filesystem.ts',
  'derivation/src/gold/filesystem.ts',
];
```

and exempt those two paths from whichever `node:fs` assertion C3's guard runs. If C3's
guard carries no `node:fs` prohibition, skip the carve-out and say so in the commit body.
If the guard's shape cannot express a file-scoped exemption, stop and report rather than
weakening it to a directory-wide one.

In `.github/scripts/task-supply-packed-types.test.mjs`, add
`@jinn-network/task-derivation` to the packages list with entrypoints `.` and `./testing`.

- [ ] **Step 5: Run the guard and watch it fail**

```bash
node --test .github/scripts/task-supply-package-inventory.test.mjs
```

Expected: FAIL — `ENOENT` reading `packages/task-supply/derivation/package.json`.

- [ ] **Step 6: Create the package scaffold**

`packages/task-supply/derivation/package.json`:

```json
{
  "name": "@jinn-network/task-derivation",
  "version": "0.1.0",
  "description": "Derivation strategies turning a described execution environment plus strategy inputs into admitted, sealed Task and EvaluationSpec pairs in a supply pool.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/task-supply/derivation"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    },
    "./fixtures/*": "./fixtures/*"
  },
  "files": [
    "dist/",
    "fixtures/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "fixtures:update": "JINN_UPDATE_FIXTURES=1 vitest run src/kit/golden.test.ts",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/environment-record": "0.1.0",
    "@jinn-network/task-admission": "0.1.0",
    "@jinn-network/task-execution-profiles": "0.1.0",
    "@jinn-network/task-execution-protocol": "0.1.0",
    "@noble/hashes": "2.2.0",
    "zod": "4.4.3"
  },
  "peerDependencies": {
    "vitest": "4.1.8"
  },
  "peerDependenciesMeta": {
    "vitest": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/environment-record": "portal:../../environments/record",
    "@jinn-network/task-admission": "portal:../admission",
    "@jinn-network/task-execution-profiles": "portal:../../task-execution/profiles",
    "@jinn-network/task-execution-protocol": "portal:../../task-execution/protocol"
  }
}
```

`tsconfig.json` (mirrors `packages/task-execution/profiles/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

`.gitignore`:

```
dist/
node_modules/
.yarn/
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

`scripts/build.mjs` — copy `packages/task-execution/profiles/scripts/build.mjs` verbatim
(package-root-relative; no edits needed).

`src/index.ts` (placeholder surface, filled by later tasks):

```ts
export { DerivationError } from "./errors.js";
export type { DerivationErrorCategory } from "./errors.js";
```

`src/errors.ts` is created in Task 2 — for this task, create it with the two-line stub
below so the scaffold typechecks, and let Task 2's tests drive its final shape:

```ts
export type DerivationErrorCategory = "invalid-input";
export class DerivationError extends Error {
  constructor(readonly category: DerivationErrorCategory, message: string) {
    super(message);
    this.name = "DerivationError";
  }
}
```

- [ ] **Step 7: Add the `derivation` CI job**

In `.github/workflows/task-supply-ci.yml`, after C3's `admission` job:

```yaml
  derivation:
    needs: [architecture, admission]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Enable Yarn 4.13.0
        run: |
          corepack enable
          corepack prepare yarn@4.13.0 --activate
      - name: Build cross-tree dependencies from source
        run: |
          (cd packages/task-execution/protocol && yarn install --immutable && yarn build)
          (cd packages/task-execution/profiles && yarn install --immutable && yarn build)
          (cd packages/environments/record && yarn install --immutable && yarn build)
          (cd packages/task-supply/admission && yarn install --immutable && yarn build)
      - name: Verify Task Derivation
        working-directory: packages/task-supply/derivation
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
```

Add `derivation` to the workflow's terminal `verify` job `needs:` list and to its
result-checking loop.

- [ ] **Step 8: Install and verify**

```bash
cd packages/task-supply/derivation && yarn install && yarn typecheck
node --test .github/scripts/task-supply-package-inventory.test.mjs
node --test .github/scripts/task-supply-source-boundaries.test.mjs
```

Expected: typecheck reports zero errors; both guards pass.

- [ ] **Step 9: Commit**

```
chore(supply): scaffold @jinn-network/task-derivation and register the tree guards

Adds the C4 package skeleton under packages/task-supply/derivation and registers it with
C3's guard trio + CI, including a file-scoped node:fs carve-out for the two store
implementations the program pins (§4).

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 1
```

---

### Task 2: Local primitives — errors, ordering, canonical JSON, digests

**Files:**
- Create: `src/order.ts`, `src/canonical.ts`, `src/digest.ts`, `src/canonical.test.ts`,
  `src/digest.test.ts`
- Modify: `src/errors.ts` (replace Task 1's stub), `src/index.ts`

**Interfaces:**
- Consumes — `@noble/hashes` (`sha256`, `bytesToHex`); for the equivalence tests only,
  `serializeCanonicalJson` and `documentDigest` from
  `@jinn-network/task-execution-protocol` (branch `integration/evidence-v1`; both verified
  exported at `packages/task-execution/protocol/src/index.ts:9-10`).
- Produces: `DerivationError`, `DerivationErrorCategory`, `compareCodeUnitStrings`,
  `serializeCanonicalJson`, `canonicalJsonBytes`, `sha256Hex`, `documentDigest`,
  `Sha256Digest`, `assertPrefixedDigest`, `assertBareHex`, `toBareHex`, `digestsEqual`.

- [ ] **Step 1: Write the canonical-JSON tests first**

`src/canonical.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serializeCanonicalJson as protocolSerialize } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, serializeCanonicalJson } from "./canonical.js";
import { DerivationError } from "./errors.js";

describe("canonical JSON (local re-implementation)", () => {
  it("sorts object keys by UTF-16 code unit, not by locale", () => {
    expect(serializeCanonicalJson({ b: 1, a: 2, A: 3, "ä": 4, z: 5 }))
      .toBe('{"A":3,"a":2,"b":1,"z":5,"ä":4}');
  });

  it("agrees byte-for-byte with the protocol package's serializer", () => {
    const value = {
      rule: "network.jinn.source-commitment/1",
      nested: { list: [1, "two", true, null, { k: "v" }], empty: [] },
      unicode: "π — umlaut ü",
      dataset: "owner/dataset",
    };
    expect(canonicalJsonBytes(value)).toEqual(
      new TextEncoder().encode(protocolSerialize(value)),
    );
  });

  it("rejects a fractional number rather than rounding it", () => {
    expect(() => serializeCanonicalJson({ weight: 0.5 })).toThrow(DerivationError);
  });

  it("rejects an undefined property value rather than dropping the key", () => {
    expect(() => serializeCanonicalJson({ a: undefined } as never)).toThrow(DerivationError);
  });

  it("rejects an unpaired surrogate in a string", () => {
    expect(() => serializeCanonicalJson({ s: "\ud800" })).toThrow(DerivationError);
  });

  it("rejects an unpaired surrogate in a key", () => {
    expect(() => serializeCanonicalJson({ "\udc00": 1 })).toThrow(DerivationError);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/canonical.test.ts
```

Expected: FAIL — cannot resolve `./canonical.js`.

- [ ] **Step 3: Replace the errors stub with the real category union**

`src/errors.ts`:

```ts
/**
 * Failure categories this package raises. Every one is a *derivation-side* fault; an
 * admission refusal is not an error — it is a first-class outcome (design §7.2) and
 * appears only in the run summary.
 */
export type DerivationErrorCategory =
  | "invalid-input"
  | "invalid-extension"
  | "environment-mismatch"
  | "gold-mismatch"
  | "pool-conflict";

export class DerivationError extends Error {
  constructor(
    readonly category: DerivationErrorCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DerivationError";
  }
}
```

- [ ] **Step 4: Implement ordering and canonical JSON**

`src/order.ts`:

```ts
/**
 * UTF-16 code-unit comparison. Never `localeCompare`: canonical bytes must not depend on
 * the host locale or bundled ICU data.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length < right.length ? -1 : 1;
}
```

`src/canonical.ts`:

```ts
import { DerivationError } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

// RFC 8785 delegates string serialization to ECMA-262 JSON.stringify, which is only
// well-defined over Unicode scalar values — a lone surrogate can serialize differently
// across hosts, which would move a digest.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function assertScalarString(value: string, what: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new DerivationError(
      "invalid-input",
      `Canonical JSON ${what} must not contain unpaired UTF-16 surrogates.`,
    );
  }
}

/**
 * RFC 8785 JCS over the I-JSON subset this package authors: the source-commitment
 * pre-image and the pool's entry manifest. Sealed Task/EvaluationSpec bytes are NOT
 * produced here — their owning packages' sealers produce them (program §5 contract 3).
 */
export function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DerivationError(
        "invalid-input",
        `Canonical JSON numbers must be exact I-JSON safe integers; got ${value}. `
          + "Encode fractional values as decimal strings.",
      );
    }
    return String(value);
  }
  if (typeof value === "string") {
    assertScalarString(value, "strings");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeCanonicalJson(element)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new DerivationError("invalid-input", "Canonical JSON admits only JSON values.");
  }
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  return `{${keys
    .map((key) => {
      assertScalarString(key, "keys");
      return `${JSON.stringify(key)}:${serializeCanonicalJson(value[key]!)}`;
    })
    .join(",")}}`;
}

const encoder = new TextEncoder();

export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return encoder.encode(serializeCanonicalJson(value));
}
```

A property whose value is `undefined` reaches the `typeof value !== "object"` branch and
throws — the key is never silently dropped.

- [ ] **Step 5: Write the digest tests**

`src/digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { documentDigest as protocolDigest } from "@jinn-network/task-execution-protocol";
import {
  assertBareHex,
  assertPrefixedDigest,
  digestsEqual,
  documentDigest,
  toBareHex,
} from "./digest.js";
import { DerivationError } from "./errors.js";

const HEX = "a".repeat(64);

describe("digest discipline (program §5 contract 6)", () => {
  it("agrees with the protocol package's documentDigest", () => {
    const bytes = new TextEncoder().encode("supply");
    expect(documentDigest(bytes)).toBe(protocolDigest(bytes));
  });

  it("requires the sha256: prefix on record-body digests", () => {
    expect(assertPrefixedDigest(`sha256:${HEX}`, "x")).toBe(`sha256:${HEX}`);
    expect(() => assertPrefixedDigest(HEX, "x")).toThrow(DerivationError);
    expect(() => assertPrefixedDigest(`sha256:${HEX.toUpperCase()}`, "x")).toThrow(DerivationError);
  });

  it("requires bare hex in DigestSet-shaped maps — the confusion fixture", () => {
    expect(assertBareHex(HEX, "x")).toBe(HEX);
    expect(() => assertBareHex(`sha256:${HEX}`, "x")).toThrow(DerivationError);
  });

  it("converts prefixed to bare and refuses already-bare input", () => {
    expect(toBareHex(`sha256:${HEX}`, "x")).toBe(HEX);
    expect(() => toBareHex(HEX, "x")).toThrow(DerivationError);
  });

  it("compares across encodings only where a foreign convention may differ", () => {
    expect(digestsEqual(`sha256:${HEX}`, HEX)).toBe(true);
    expect(digestsEqual(`sha256:${HEX}`, `sha256:${"b".repeat(64)}`)).toBe(false);
    expect(digestsEqual("not-a-digest", HEX)).toBe(false);
  });
});
```

- [ ] **Step 6: Implement digests**

`src/digest.ts`:

```ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DerivationError } from "./errors.js";

export type Sha256Digest = `sha256:${string}`;

const PREFIXED = /^sha256:[0-9a-f]{64}$/;
const BARE = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function documentDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${sha256Hex(bytes)}`;
}

/** Record-body form: `sha256:<64 lowercase hex>` (design §4.2). */
export function assertPrefixedDigest(value: string, field: string): Sha256Digest {
  if (!PREFIXED.test(value)) {
    throw new DerivationError(
      "invalid-input",
      `${field} must be a "sha256:"-prefixed lowercase-hex digest; got ${JSON.stringify(value)}.`,
    );
  }
  return value as Sha256Digest;
}

/** DigestSet form: bare lowercase hex (design §5.1; every `digest.sha256` in profiles). */
export function assertBareHex(value: string, field: string): string {
  if (!BARE.test(value)) {
    throw new DerivationError(
      "invalid-input",
      `${field} must be bare lowercase hex with no "sha256:" prefix; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function toBareHex(prefixed: string, field: string): string {
  return assertPrefixedDigest(prefixed, field).slice("sha256:".length);
}

/**
 * Encoding-tolerant equality, used at exactly one seam: comparing a digest this package
 * computed against one produced by a package whose encoding choice is not ours to dictate
 * (the admission receipt's gold-patch hash, run.ts). Everywhere else the strict guards
 * above apply.
 */
export function digestsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string | undefined => {
    if (PREFIXED.test(value)) return value.slice("sha256:".length);
    if (BARE.test(value)) return value;
    return undefined;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a !== undefined && a === b;
}
```

- [ ] **Step 7: Export from the public surface and verify**

`src/index.ts`:

```ts
export { DerivationError } from "./errors.js";
export type { DerivationErrorCategory } from "./errors.js";
export { compareCodeUnitStrings } from "./order.js";
export { canonicalJsonBytes, serializeCanonicalJson } from "./canonical.js";
export type { CanonicalJsonValue } from "./canonical.js";
export {
  assertBareHex,
  assertPrefixedDigest,
  digestsEqual,
  documentDigest,
  sha256Hex,
  toBareHex,
} from "./digest.js";
export type { Sha256Digest } from "./digest.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 11 tests pass across two files.

- [ ] **Step 8: Commit**

```
feat(supply): local canonicalization, ordering, and digest primitives for derivation

Re-implements JCS + digesting for the bytes this package authors, with equivalence tests
against @jinn-network/task-execution-protocol and the prefixed-vs-bare confusion fixture
(program §5 contracts 3 and 6).

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 2
```

---

### Task 3: `provenance.sourceCommitment` — this field's first writer

**Files:**
- Create: `src/source-commitment.ts`, `src/source-commitment.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes` (Task 2), `documentDigest` / `Sha256Digest` (Task 2),
  `DerivationError` (Task 2).
- Produces: `SOURCE_COMMITMENT_RULE`, `UpstreamIdentity`, `statementDigest`,
  `sourceCommitmentPreImage`, `computeSourceCommitment`.

**Why this task exists.** Design §7.2 makes the import strategy *"this field's first-ever
writer"* for `provenance.sourceCommitment`, and names it only as "the upstream lineage
digest". A first writer that leaves the rule implicit hands every later consumer a value
they cannot recompute. So the rule is pinned here, versioned inside its own pre-image, and
documented in the README (Task 12).

**The rule (v1, `network.jinn.source-commitment/1`).** The commitment is the sha256 of the
RFC 8785 canonical JSON of exactly five string fields:

```
{"dataset":…,"instanceId":…,"revision":…,"rule":"network.jinn.source-commitment/1","statementDigest":"sha256:…"}
```

written `sha256:<64 lowercase hex>`. Three properties this buys, each of which the legacy
colon-joined `lineageHash` (`client/src/solver-types/_swe-rebench-v2-hunk-echo.ts:29`,
read as reference only) did not have: the encoding is unambiguous (a `:` inside a dataset
name cannot forge a different tuple), the rule id is inside the hashed bytes (a future rule
cannot collide with this one), and the statement is committed too — so an upstream row
whose text is silently edited yields a different commitment rather than the same one.

- [ ] **Step 1: Write the tests first**

`src/source-commitment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { documentDigest } from "./digest.js";
import { DerivationError } from "./errors.js";
import {
  SOURCE_COMMITMENT_RULE,
  computeSourceCommitment,
  sourceCommitmentPreImage,
  statementDigest,
  type UpstreamIdentity,
} from "./source-commitment.js";

const UPSTREAM: UpstreamIdentity = {
  dataset: "nebius/SWE-rebench",
  revision: "refs/convert/parquet-2026-05-01",
  instanceId: "acme__widget-1234",
};
const STATEMENT = "Widget.resize() raises on zero width.\n\nSteps to reproduce: …\n";

describe("source commitment (design §7.2, first writer)", () => {
  it("pins the rule id inside the hashed bytes", () => {
    expect(SOURCE_COMMITMENT_RULE).toBe("network.jinn.source-commitment/1");
  });

  it("builds the exact canonical pre-image", () => {
    const expected =
      `{"dataset":"nebius/SWE-rebench",`
      + `"instanceId":"acme__widget-1234",`
      + `"revision":"refs/convert/parquet-2026-05-01",`
      + `"rule":"network.jinn.source-commitment/1",`
      + `"statementDigest":"${statementDigest(STATEMENT)}"}`;
    expect(sourceCommitmentPreImage(UPSTREAM, STATEMENT))
      .toEqual(new TextEncoder().encode(expected));
  });

  it("is the digest of that pre-image, and is stable across calls", () => {
    const commitment = computeSourceCommitment(UPSTREAM, STATEMENT);
    expect(commitment).toBe(documentDigest(sourceCommitmentPreImage(UPSTREAM, STATEMENT)));
    expect(commitment).toBe(computeSourceCommitment(UPSTREAM, STATEMENT));
    expect(commitment).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("moves when any one of the four inputs moves", () => {
    const base = computeSourceCommitment(UPSTREAM, STATEMENT);
    expect(computeSourceCommitment({ ...UPSTREAM, dataset: "other/dataset" }, STATEMENT))
      .not.toBe(base);
    expect(computeSourceCommitment({ ...UPSTREAM, revision: "refs/other" }, STATEMENT))
      .not.toBe(base);
    expect(computeSourceCommitment({ ...UPSTREAM, instanceId: "acme__widget-1235" }, STATEMENT))
      .not.toBe(base);
    expect(computeSourceCommitment(UPSTREAM, `${STATEMENT} `)).not.toBe(base);
  });

  it("refuses an empty identity component or an empty statement", () => {
    expect(() => computeSourceCommitment({ ...UPSTREAM, dataset: "" }, STATEMENT))
      .toThrow(DerivationError);
    expect(() => computeSourceCommitment({ ...UPSTREAM, revision: "" }, STATEMENT))
      .toThrow(DerivationError);
    expect(() => computeSourceCommitment({ ...UPSTREAM, instanceId: "" }, STATEMENT))
      .toThrow(DerivationError);
    expect(() => computeSourceCommitment(UPSTREAM, "")).toThrow(DerivationError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/source-commitment.test.ts
```

Expected: FAIL — cannot resolve `./source-commitment.js`.

- [ ] **Step 3: Implement**

`src/source-commitment.ts`:

```ts
import { canonicalJsonBytes } from "./canonical.js";
import { documentDigest, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";

/**
 * Version tag carried INSIDE the hashed pre-image, so a future rule cannot produce a
 * value that a v1 consumer would mistake for a v1 commitment.
 */
export const SOURCE_COMMITMENT_RULE = "network.jinn.source-commitment/1" as const;

/** The upstream item a candidate was imported from (design §7.2, payload lineage). */
export interface UpstreamIdentity {
  readonly dataset: string;
  readonly revision: string;
  readonly instanceId: string;
}

const encoder = new TextEncoder();

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new DerivationError("invalid-input", `${field} must be a non-empty string.`);
  }
  return value;
}

/** sha256 of the statement's UTF-8 bytes, verbatim — no trimming, no normalization. */
export function statementDigest(statement: string): Sha256Digest {
  return documentDigest(encoder.encode(requireNonEmpty(statement, "statement")));
}

/**
 * The exact bytes hashed by {@link computeSourceCommitment}. Exported so a third party can
 * recompute a commitment from published fields without reimplementing the rule.
 */
export function sourceCommitmentPreImage(
  upstream: UpstreamIdentity,
  statement: string,
): Uint8Array {
  return canonicalJsonBytes({
    dataset: requireNonEmpty(upstream.dataset, "upstream.dataset"),
    instanceId: requireNonEmpty(upstream.instanceId, "upstream.instanceId"),
    revision: requireNonEmpty(upstream.revision, "upstream.revision"),
    rule: SOURCE_COMMITMENT_RULE,
    statementDigest: statementDigest(statement),
  });
}

/**
 * `provenance.sourceCommitment` for an imported task (design §7.2). Commits to the
 * upstream item's identity AND to the exact statement text taken from it: an upstream row
 * edited in place produces a different commitment rather than silently reusing this one.
 */
export function computeSourceCommitment(
  upstream: UpstreamIdentity,
  statement: string,
): Sha256Digest {
  return documentDigest(sourceCommitmentPreImage(upstream, statement));
}
```

- [ ] **Step 4: Export and verify**

Add to `src/index.ts`:

```ts
export {
  SOURCE_COMMITMENT_RULE,
  computeSourceCommitment,
  sourceCommitmentPreImage,
  statementDigest,
} from "./source-commitment.js";
export type { UpstreamIdentity } from "./source-commitment.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 16 tests pass across three files.

- [ ] **Step 5: Commit**

```
feat(supply): define and implement provenance.sourceCommitment (design §7.2 first writer)

Pins the v1 rule — sha256 over the canonical JSON of {dataset, instanceId, revision, rule,
statementDigest} — with the rule id inside the hashed bytes and the statement committed, so
an edited upstream row cannot reuse an existing commitment.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 3
```

---

### Task 4: the namespaced environment-record extension key

**Files:**
- Create: `src/environment-extension.ts`, `src/environment-extension.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes — from `@jinn-network/task-execution-profiles` (branch
  `integration/evidence-v1`): `DeterministicProcessBlockSchema` and the
  `DeterministicProcessBlock` type (verified exported via
  `packages/task-execution/profiles/src/index.ts` → `evaluation-spec/family-blocks.js`).
  From Task 2: `assertBareHex`, `toBareHex`, `Sha256Digest`, `DerivationError`.
- Produces: `ENVIRONMENT_RECORD_EXTENSION_KEY` (the exact string
  `network.jinn.environment.record`, program §4), `EnvironmentRecordExtension`,
  `buildEnvironmentRecordExtension`, `readEnvironmentRecordExtension`.

**Why the key passes `withNamespacedExtras`.** The family-block schemas wrap
`z.looseObject(shape)` in a `superRefine` that rejects any unknown key which is neither
reverse-DNS nor an absolute URI
(`packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts:12-44`). The
reverse-DNS pattern is `^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$`;
`network.jinn.environment.record` is four alphabetic segments, so it matches. This task
proves it rather than assuming it.

- [ ] **Step 1: Write the tests first**

`src/environment-extension.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DeterministicProcessBlockSchema } from "@jinn-network/task-execution-profiles";
import {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
  readEnvironmentRecordExtension,
} from "./environment-extension.js";
import { DerivationError } from "./errors.js";

const HEX = "c".repeat(64);
const RECORD_DIGEST = `sha256:${HEX}` as const;

function blockWith(extras: Record<string, unknown>): Record<string, unknown> {
  return {
    image: {
      name: "environment-image",
      uri: "registry.example/repo@sha256:" + "d".repeat(64),
      digest: { sha256: "d".repeat(64) },
    },
    platform: "linux/amd64",
    workspace: {},
    testMaterial: [
      { name: "test-patch", mediaType: "text/x-diff", content: "ZGlmZg==", accessClass: "public" },
    ],
    parser: { id: "pytest", version: "1", digest: `sha256:${"e".repeat(64)}` },
    transitions: { failToPass: ["t::a"], passToPass: ["t::b"] },
    timeout: 900,
    ...extras,
  };
}

describe("environment-record extension key (design §7.2)", () => {
  it("is the exact string the program pins", () => {
    expect(ENVIRONMENT_RECORD_EXTENSION_KEY).toBe("network.jinn.environment.record");
  });

  it("passes the family block's namespaced-extras rule", () => {
    const block = blockWith({
      [ENVIRONMENT_RECORD_EXTENSION_KEY]: buildEnvironmentRecordExtension(RECORD_DIGEST),
    });
    expect(DeterministicProcessBlockSchema.safeParse(block).success).toBe(true);
  });

  it("shows why the namespaced form is required: a bare key is rejected", () => {
    const block = blockWith({ environmentRecord: { digest: { sha256: HEX } } });
    const result = DeterministicProcessBlockSchema.safeParse(block);
    expect(result.success).toBe(false);
  });

  it("carries bare hex, never a prefixed digest — the confusion fixture", () => {
    expect(buildEnvironmentRecordExtension(RECORD_DIGEST)).toEqual({ digest: { sha256: HEX } });
    expect(() => buildEnvironmentRecordExtension(HEX)).toThrow(DerivationError);
  });

  it("round-trips back to the prefixed record digest", () => {
    const block = blockWith({
      [ENVIRONMENT_RECORD_EXTENSION_KEY]: buildEnvironmentRecordExtension(RECORD_DIGEST),
    });
    expect(readEnvironmentRecordExtension(block)).toBe(RECORD_DIGEST);
  });

  it("refuses to read a prefixed value smuggled into the DigestSet", () => {
    const block = blockWith({
      [ENVIRONMENT_RECORD_EXTENSION_KEY]: { digest: { sha256: RECORD_DIGEST } },
    });
    expect(() => readEnvironmentRecordExtension(block)).toThrow(DerivationError);
  });

  it("refuses a block that carries no extension at all", () => {
    expect(() => readEnvironmentRecordExtension(blockWith({}))).toThrow(DerivationError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/environment-extension.test.ts
```

Expected: FAIL — cannot resolve `./environment-extension.js`.

- [ ] **Step 3: Implement**

`src/environment-extension.ts`:

```ts
import { assertBareHex, toBareHex, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";

/**
 * The namespaced EvaluationSpec extension key that references the environment record
 * (design §7.2, exact string). Reverse-DNS by construction, so the family block's
 * `withNamespacedExtras` rule (TEP §21.3) admits it; a first-class field is proposed as
 * F1 and would supersede this carrier.
 */
export const ENVIRONMENT_RECORD_EXTENSION_KEY = "network.jinn.environment.record" as const;

/**
 * DigestSet-shaped, so `sha256` carries BARE lowercase hex like every other `digest.sha256`
 * in the stack — planning Finding (f) records that §7.2 leaves the encoding unstated and
 * pins it here.
 */
export interface EnvironmentRecordExtension {
  readonly digest: { readonly sha256: string };
}

export function buildEnvironmentRecordExtension(
  environmentRecordDigest: string,
): EnvironmentRecordExtension {
  return {
    digest: {
      sha256: toBareHex(environmentRecordDigest, `${ENVIRONMENT_RECORD_EXTENSION_KEY} source digest`),
    },
  };
}

/** Reads the extension back out of a family block, in the record-body prefixed form. */
export function readEnvironmentRecordExtension(
  familyBlock: Record<string, unknown>,
): Sha256Digest {
  const raw = familyBlock[ENVIRONMENT_RECORD_EXTENSION_KEY];
  if (raw === undefined) {
    throw new DerivationError(
      "invalid-extension",
      `family block carries no "${ENVIRONMENT_RECORD_EXTENSION_KEY}".`,
    );
  }
  const sha256 = (raw as { digest?: { sha256?: unknown } } | null)?.digest?.sha256;
  if (typeof sha256 !== "string") {
    throw new DerivationError(
      "invalid-extension",
      `"${ENVIRONMENT_RECORD_EXTENSION_KEY}" must carry {digest: {sha256: string}}.`,
    );
  }
  return `sha256:${assertBareHex(sha256, `${ENVIRONMENT_RECORD_EXTENSION_KEY}.digest.sha256`)}`;
}
```

- [ ] **Step 4: Export and verify**

Add to `src/index.ts`:

```ts
export {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
  readEnvironmentRecordExtension,
} from "./environment-extension.js";
export type { EnvironmentRecordExtension } from "./environment-extension.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 23 tests pass across four files.

- [ ] **Step 5: Commit**

```
feat(supply): pin the network.jinn.environment.record extension key

Adds the namespaced EvaluationSpec carrier for the environment record digest, proven to
pass profiles' withNamespacedExtras rule, with the bare-hex confusion fixture and the
bare-key negative that shows why the namespaced form is required.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 4
```

---

### Task 5: the candidate vocabulary and the strategy seam

**Files:**
- Create: `src/candidate.ts`, `src/candidate.test.ts`, `src/strategy.ts`,
  `src/strategy.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes — from `@jinn-network/environment-record` (branch
  `supply/c1-environment-record`): `EnvironmentRecord`, `parseEnvironmentRecord`,
  `environmentRecordDigest`. From Task 2/3: `Sha256Digest`, `documentDigest`,
  `DerivationError`, `UpstreamIdentity`.
- Produces: `Candidate`, `CandidateTestMaterial`, `CandidateProvenance`,
  `assertCandidate`, `SPDX_EXPRESSION_PATTERN`, `DerivationStrategy`,
  `DerivationEnvironment`, `loadDerivationEnvironment`, `StrategyDeps`,
  `DerivationLogger`.

**The load-bearing omission.** A `Candidate` carries statement, test material,
transitions, timeout, gold bytes, provenance inputs, and license — and deliberately **not**
image, platform, or parser. Those three are exactly the fields C3's inline-match rule
compares (§7.1), and they are read from the environment record at sealing time (Task 6).
A strategy therefore *cannot* propose a pair whose inline fields disagree with the record:
the disagreement has no place to live. This is why the match rule passes by construction
rather than by a defensive re-check.

- [ ] **Step 1: Write the candidate tests first**

`src/candidate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertCandidate, type Candidate } from "./candidate.js";
import { DerivationError } from "./errors.js";
import { documentDigest } from "./digest.js";

const GOLD = new TextEncoder().encode("--- a/x\n+++ b/x\n");
const MATERIAL_BYTES = new TextEncoder().encode("--- a/t\n+++ b/t\n");

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "acme__widget-1234",
    statement: "Widget.resize() raises on zero width.\n",
    language: "python",
    testMaterial: [
      {
        name: "test-patch",
        mediaType: "text/x-diff",
        content: Buffer.from(MATERIAL_BYTES).toString("base64"),
        digest: documentDigest(MATERIAL_BYTES),
      },
    ],
    transitions: { failToPass: ["tests/test_widget.py::test_zero"], passToPass: [] },
    timeout: 900,
    goldPatch: GOLD,
    provenance: {
      kind: "mined",
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: "acme__widget-1234",
      },
    },
    rights: { sourceLicense: "Apache-2.0" },
    ...overrides,
  };
}

describe("candidate validation", () => {
  it("accepts a well-formed imported candidate", () => {
    expect(() => assertCandidate(candidate())).not.toThrow();
  });

  it("requires a non-empty statement", () => {
    expect(() => assertCandidate(candidate({ statement: "" }))).toThrow(DerivationError);
  });

  it("requires at least one fail-to-pass transition — a suite that cannot discriminate is not a task", () => {
    expect(() => assertCandidate(candidate({ transitions: { failToPass: [], passToPass: [] } })))
      .toThrow(DerivationError);
  });

  it("requires gold patch bytes", () => {
    expect(() => assertCandidate(candidate({ goldPatch: new Uint8Array() })))
      .toThrow(DerivationError);
  });

  it("requires at least one test-material descriptor whose digest matches its content", () => {
    expect(() => assertCandidate(candidate({ testMaterial: [] }))).toThrow(DerivationError);
    const wrong = candidate();
    expect(() =>
      assertCandidate({
        ...wrong,
        testMaterial: [{ ...wrong.testMaterial[0]!, digest: `sha256:${"0".repeat(64)}` }],
      }),
    ).toThrow(DerivationError);
  });

  it("requires a positive integer timeout", () => {
    expect(() => assertCandidate(candidate({ timeout: 0 }))).toThrow(DerivationError);
    expect(() => assertCandidate(candidate({ timeout: 90.5 }))).toThrow(DerivationError);
  });

  it("requires a declared SPDX expression (D12) and rejects free text", () => {
    expect(() => assertCandidate(candidate({ rights: { sourceLicense: "" } })))
      .toThrow(DerivationError);
    expect(() => assertCandidate(candidate({ rights: { sourceLicense: "see LICENSE file" } })))
      .toThrow(DerivationError);
    expect(() => assertCandidate(candidate({ rights: { sourceLicense: "Apache-2.0 WITH LLVM-exception" } })))
      .not.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/candidate.test.ts
```

Expected: FAIL — cannot resolve `./candidate.js`.

- [ ] **Step 3: Implement the candidate vocabulary**

`src/candidate.ts`:

```ts
import { documentDigest, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";
import type { UpstreamIdentity } from "./source-commitment.js";

/** v1 has one strategy, and it imports (design §7.2 / §12: no synthetic strategies). */
export type ProvenanceKind = "mined";

/**
 * Evaluation material carried inline as base64 content plus its digest. `accessClass` is
 * not a field here because it is not a choice: D5 admits no private material in v1, and
 * the sealed spec's descriptors are stamped `"public"` explicitly at build time (Task 6).
 */
export interface CandidateTestMaterial {
  readonly name: string;
  readonly mediaType: string;
  /** base64 of the material bytes. */
  readonly content: string;
  readonly digest: Sha256Digest;
}

export interface CandidateProvenance {
  readonly kind: ProvenanceKind;
  readonly upstream: UpstreamIdentity;
}

/**
 * What a strategy yields.
 *
 * Deliberately absent: `image`, `platform`, `parser`. Those come from the environment
 * record at sealing time, which is what makes C3's inline-match rule (§7.1) pass by
 * construction — a candidate has nowhere to put a disagreeing value.
 *
 * `goldPatch` is LOCAL-ONLY material: it reaches admission and the gold store, and never
 * the supply pool (`PoolEntry` has no field that could hold it).
 *
 * `statement` is upstream-authored, attacker-influencable text (design §7.3). Nothing in
 * this package sanitizes it, and no receipt minted downstream says anything about its
 * content safety.
 */
export interface Candidate {
  readonly id: string;
  readonly statement: string;
  readonly language: string;
  readonly testMaterial: readonly CandidateTestMaterial[];
  readonly transitions: {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  };
  readonly timeout: number;
  readonly goldPatch: Uint8Array;
  readonly provenance: CandidateProvenance;
  readonly rights: { readonly sourceLicense: string };
}

/**
 * A conservative SPDX *expression* shape: licence ids joined by AND/OR/WITH, optionally
 * parenthesized. Declared, never detected (design §4.2's honesty note) — this checks that
 * the producer supplied an expression, not that the expression is true of the source.
 */
export const SPDX_EXPRESSION_PATTERN =
  /^[A-Za-z0-9.+()-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+()-]+)*$/;

const encoder = new TextEncoder();

export function assertCandidate(candidate: Candidate): void {
  const fail = (message: string): never => {
    throw new DerivationError("invalid-input", `candidate ${candidate.id}: ${message}`);
  };

  if (candidate.id.length === 0) fail("id must be non-empty.");
  if (candidate.statement.length === 0) fail("statement must be non-empty.");
  if (candidate.language.length === 0) fail("language must be non-empty.");
  if (candidate.transitions.failToPass.length === 0) {
    fail("at least one fail-to-pass transition is required — a suite that cannot discriminate is not a task.");
  }
  if (!Number.isSafeInteger(candidate.timeout) || candidate.timeout <= 0) {
    fail(`timeout must be a positive integer; got ${candidate.timeout}.`);
  }
  if (candidate.goldPatch.byteLength === 0) fail("goldPatch must be non-empty.");
  if (candidate.testMaterial.length === 0) fail("at least one test-material descriptor is required.");
  for (const material of candidate.testMaterial) {
    if (material.name.length === 0) fail("test material name must be non-empty.");
    if (material.mediaType.length === 0) fail("test material mediaType must be non-empty.");
    const bytes = Uint8Array.from(Buffer.from(material.content, "base64"));
    if (documentDigest(bytes) !== material.digest) {
      fail(`test material "${material.name}" digest does not match its content.`);
    }
  }
  if (!SPDX_EXPRESSION_PATTERN.test(candidate.rights.sourceLicense)) {
    fail(
      `rights.sourceLicense must be an SPDX expression (D12); got `
        + `${JSON.stringify(candidate.rights.sourceLicense)}.`,
    );
  }
  if (encoder.encode(candidate.statement).byteLength === 0) fail("statement must encode to bytes.");
}
```

- [ ] **Step 4: Write the strategy-seam tests**

`src/strategy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { environmentRecordDigest, sealEnvironmentRecord } from "@jinn-network/environment-record";
import { loadDerivationEnvironment } from "./strategy.js";
import { buildFixtureEnvironmentRecordBody } from "./testing-support.js";

describe("derivation environment", () => {
  it("parses and digests the record from its bytes, so the three cannot desync", () => {
    const bytes = sealEnvironmentRecord(buildFixtureEnvironmentRecordBody());
    const env = loadDerivationEnvironment(bytes);
    expect(env.recordBytes).toEqual(bytes);
    expect(env.recordDigest).toBe(environmentRecordDigest(bytes));
    expect(env.record.image.platform).toBe("linux/amd64");
  });
});
```

`src/testing-support.ts` (internal, not part of the `./testing` entrypoint yet — Task 11
promotes what belongs there) builds one in-memory record body matching design §4.2:

```ts
import type { EnvironmentRecord } from "@jinn-network/environment-record";

const IMAGE_MANIFEST = `sha256:${"1".repeat(64)}`;
const PARSER_DIGEST = `sha256:${"2".repeat(64)}`;

/**
 * One fixture environment (design §4.2). Kept in code rather than JSON so a C1 schema
 * change breaks this at typecheck instead of at fixture-parse time.
 */
export function buildFixtureEnvironmentRecordBody(): EnvironmentRecord {
  return {
    kind: "https://jinn.network/records/environment/1.0",
    source: {
      repo: "acme/widget",
      repoUrl: "https://github.com/acme/widget",
      commit: "3".repeat(40),
    },
    image: {
      manifestDigest: IMAGE_MANIFEST,
      platform: "linux/amd64",
      reference: `registry.example/acme/widget@${IMAGE_MANIFEST}`,
    },
    workspace: "/testbed",
    invocations: {
      test: [{ bin: "python", args: ["-m", "pytest", "-q"], cwd: "/testbed" }],
    },
    parser: {
      id: "pytest",
      version: "1",
      digest: PARSER_DIGEST,
      uri: "https://example.invalid/parsers/pytest",
    },
    build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
    rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
    lineage: {
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        keys: ["acme__widget-1234"],
      },
    },
  } satisfies EnvironmentRecord;
}
```

If C1's `EnvironmentRecord` requires a field this body omits (or forbids one it carries),
adjust the body to C1's schema — that is binding to the real symbol, not improvisation.
If C1 exposes its own fixture builder with an equivalent shape, prefer it and delete this
helper.

- [ ] **Step 5: Implement the strategy seam**

`src/strategy.ts`:

```ts
import {
  environmentRecordDigest,
  parseEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import type { Candidate } from "./candidate.js";
import type { Sha256Digest } from "./digest.js";

/**
 * A described environment, in the three forms derivation needs, derived from one source of
 * truth (the bytes) so they cannot drift apart. "Described" is the honest word: whether the
 * environment has been *attested*, and under whose trust policy, is the consumer's join
 * (design §7.1) and no concern of this package.
 */
export interface DerivationEnvironment {
  readonly recordBytes: Uint8Array;
  readonly record: EnvironmentRecord;
  readonly recordDigest: Sha256Digest;
}

export function loadDerivationEnvironment(recordBytes: Uint8Array): DerivationEnvironment {
  return {
    recordBytes,
    record: parseEnvironmentRecord(recordBytes),
    recordDigest: environmentRecordDigest(recordBytes) as Sha256Digest,
  };
}

/** Structured observation sink. Injected — this package never writes to a console itself. */
export interface DerivationLogger {
  candidateSkipped(event: { readonly candidateId: string; readonly reason: string }): void;
  candidateRefused(event: { readonly candidateId: string; readonly code: string }): void;
  pairWritten(event: { readonly candidateId: string; readonly taskDigest: Sha256Digest }): void;
}

export interface StrategyDeps {
  readonly logger?: DerivationLogger;
}

/**
 * The strategy seam (design §7.2): *(described environment + strategy inputs) → candidate
 * tasks*. v1 ships exactly one member, the import strategy. Injection, statement
 * generation, echo mining and emergent-bug harvesting are named extensions (§14) and are
 * NOT to be built behind this interface without a design amendment (§12).
 */
export interface DerivationStrategy<TInputs> {
  readonly id: string;
  derive(deps: StrategyDeps, env: DerivationEnvironment, inputs: TInputs): AsyncIterable<Candidate>;
}
```

- [ ] **Step 6: Export and verify**

Add to `src/index.ts`:

```ts
export { SPDX_EXPRESSION_PATTERN, assertCandidate } from "./candidate.js";
export type {
  Candidate,
  CandidateProvenance,
  CandidateTestMaterial,
  ProvenanceKind,
} from "./candidate.js";
export { loadDerivationEnvironment } from "./strategy.js";
export type {
  DerivationEnvironment,
  DerivationLogger,
  DerivationStrategy,
  StrategyDeps,
} from "./strategy.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 31 tests pass across six files.

- [ ] **Step 7: Commit**

```
feat(supply): candidate vocabulary and the derivation strategy seam

A Candidate carries statement, material, transitions, timeout, gold bytes, provenance and
licence — and deliberately no image/platform/parser, so a strategy cannot propose a pair
that disagrees with its environment record.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 5
```

---

### Task 6: the sealed-pair builder — inline fields copied FROM the record

**Files:**
- Create: `src/seal-pair.ts`, `src/seal-pair.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes — from `@jinn-network/task-execution-profiles` (branch
  `integration/evidence-v1`, all verified exported via
  `packages/task-execution/profiles/src/index.ts`): `sweRebenchRowToTaskAndSpec`,
  `SweRebenchRow`, `sealEvaluationSpec`, `parseEvaluationSpec`, `EvaluationSpec`,
  `DeterministicProcessBlock`, `buildRepositoryWorkProfile`, `sealTaskProfile`,
  `REPOSITORY_WORK_PROFILE_URI`. From `@jinn-network/task-execution-protocol`:
  `sealTask`, `TASK_EXECUTION_PROTOCOL_URI`. From Tasks 2–5:
  `toBareHex`, `assertPrefixedDigest`, `documentDigest`, `computeSourceCommitment`,
  `ENVIRONMENT_RECORD_EXTENSION_KEY`, `buildEnvironmentRecordExtension`,
  `readEnvironmentRecordExtension`, `Candidate`, `DerivationEnvironment`.
- Produces: `SealedEvaluationSpec`, `SealedTask`, `buildCandidateEvaluationSpec`,
  `buildSealedTask`.

**Reuse decision (recorded, per the prompt's "REUSE if its exports fit").**
`sweRebenchRowToTaskAndSpec` exports `{evaluationSpec, evaluationSpecDigest, taskPayload,
taskInputs}` (`packages/task-execution/profiles/src/documents/swe-rebench.ts:26-31`).

- **Reused as-is** for the EvaluationSpec body: it assembles the deterministic-process
  family block, stamps `accessClass: "public"` on every test-material descriptor and on the
  grader (D5's explicitness, already enforced there rather than trusted to the caller),
  and fixes the measurement / verdict-rule / unscorable vocabulary. Re-deriving any of that
  here would fork a frozen document shape.
- **Overlaid** afterwards: `platform` (the mapper hardcodes `"linux/amd64"`; the record is
  authoritative) and the namespaced environment-record key.
- **Not used:** `taskInputs` (GitHub-URL template vs the record's `source.repoUrl`) and
  `taskPayload` (does not write `sourceCommitment` or `rights`). Both are Finding (d);
  Step 1's drift-guard test keeps the locally built payload aligned with the mapper's on
  the fields they share.

The aligned row handed to the mapper takes `image` and `parser` **from the environment
record**, so the mapper's own outputs are already record-consistent and the overlay is
limited to the one field it hardcodes.

- [ ] **Step 1: Write the tests first**

`src/seal-pair.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseEvaluationSpec,
  sealEvaluationSpec,
  sweRebenchRowToTaskAndSpec,
} from "@jinn-network/task-execution-profiles";
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { readEnvironmentRecordExtension } from "./environment-extension.js";
import { buildCandidateEvaluationSpec, buildSealedTask } from "./seal-pair.js";
import { computeSourceCommitment } from "./source-commitment.js";
import { loadDerivationEnvironment } from "./strategy.js";
import { buildFixtureCandidate, buildFixtureEnvironmentRecordBody } from "./testing-support.js";

function environment(overrides: Record<string, unknown> = {}) {
  const body = { ...buildFixtureEnvironmentRecordBody(), ...overrides };
  return loadDerivationEnvironment(sealEnvironmentRecord(body as never));
}

const decoder = new TextDecoder();

describe("sealed pair", () => {
  it("copies image, platform and parser FROM the record, so C3's match rule passes by construction", () => {
    const env = environment();
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    const block = spec.document.familyBlock as Record<string, never>;

    expect((block["image"] as { uri: string }).uri).toBe(env.record.image.reference);
    expect((block["image"] as { digest: { sha256: string } }).digest.sha256)
      .toBe(env.record.image.manifestDigest.slice("sha256:".length));
    expect(block["platform"]).toBe(env.record.image.platform);
    expect(block["parser"]).toEqual({
      id: env.record.parser.id,
      version: env.record.parser.version,
      digest: env.record.parser.digest,
    });
  });

  it("overrides the mapper's hardcoded platform for a non-amd64 record", () => {
    const base = buildFixtureEnvironmentRecordBody();
    const env = environment({ image: { ...base.image, platform: "linux/arm64" } });
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    expect((spec.document.familyBlock as Record<string, unknown>)["platform"]).toBe("linux/arm64");
  });

  it("drops the record parser's advisory uri — ParserIdentitySchema is strict", () => {
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), environment());
    expect((spec.document.familyBlock as Record<string, Record<string, unknown>>)["parser"])
      .not.toHaveProperty("uri");
  });

  it("stamps every test-material descriptor and the grader public (D5)", () => {
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), environment());
    const block = spec.document.familyBlock as { testMaterial: { accessClass?: string }[] };
    for (const material of block.testMaterial) expect(material.accessClass).toBe("public");
    expect((spec.document.grader as { accessClass?: string }).accessClass).toBe("public");
  });

  it("carries the namespaced environment-record key, and the sealed bytes still validate", () => {
    const env = environment();
    const spec = buildCandidateEvaluationSpec(buildFixtureCandidate(), env);
    expect(readEnvironmentRecordExtension(spec.document.familyBlock as Record<string, unknown>))
      .toBe(env.recordDigest);
    const reparsed = parseEvaluationSpec(spec.bytes);
    expect(sealEvaluationSpec(reparsed).bytes).toEqual(spec.bytes);
    expect(spec.digest).toBe(sealEvaluationSpec(spec.document).digest);
  });

  it("uses the statement verbatim as the Task's instructions, whitespace included", () => {
    const candidate = buildFixtureCandidate({ statement: "Trailing space and CRLF.  \r\n" });
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    const document = JSON.parse(decoder.decode(task.bytes)) as { instructions: string };
    expect(document.instructions).toBe("Trailing space and CRLF.  \r\n");
  });

  it("writes provenance.kind mined, the source commitment, and the SPDX licence", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    const document = JSON.parse(decoder.decode(task.bytes)) as {
      payload: {
        instance_id: string;
        provenance: { kind: string; sourceCommitment: string };
        rights: { sourceLicense: string };
      };
      inputs: { name: string; uri: string; annotations: { ref: string } }[];
      evaluation: { digest: { sha256: string } };
    };

    expect(document.payload.provenance.kind).toBe("mined");
    expect(document.payload.provenance.sourceCommitment)
      .toBe(computeSourceCommitment(candidate.provenance.upstream, candidate.statement));
    expect(document.payload.instance_id).toBe(candidate.provenance.upstream.instanceId);
    expect(document.payload.rights.sourceLicense).toBe("Apache-2.0");
    expect(document.inputs[0]).toEqual({
      name: "repository-state",
      uri: env.record.source.repoUrl,
      annotations: { ref: env.record.source.commit },
    });
    expect(document.evaluation.digest.sha256).toBe(spec.digest.slice("sha256:".length));
  });

  it("keeps the locally built payload aligned with the profiles mapper (Finding (d) drift guard)", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const task = buildSealedTask(
      candidate,
      env,
      buildCandidateEvaluationSpec(candidate, env).digest,
    );
    const document = JSON.parse(decoder.decode(task.bytes)) as { payload: Record<string, unknown> };
    const mapped = sweRebenchRowToTaskAndSpec({
      instance_id: candidate.provenance.upstream.instanceId,
      repo: env.record.source.repo,
      base_commit: env.record.source.commit,
      problem_statement: candidate.statement,
      language: candidate.language,
      image: { uri: env.record.image.reference },
      testMaterial: [{ name: "t", content: "" , digest: { sha256: "0".repeat(64) } }],
      parser: {
        id: env.record.parser.id,
        version: env.record.parser.version,
        digest: env.record.parser.digest,
      },
      transitions: { failToPass: ["a"], passToPass: [] },
      timeout: 900,
    }).taskPayload as Record<string, unknown>;

    expect(document.payload["instance_id"]).toBe(mapped["instance_id"]);
    expect(document.payload["language"]).toBe(mapped["language"]);
    expect((document.payload["provenance"] as { kind: string }).kind)
      .toBe((mapped["provenance"] as { kind: string }).kind);
  });

  it("re-seals to identical bytes, so the namespaced key survives a round trip (F4 locally)", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    expect(sealTask(JSON.parse(decoder.decode(task.bytes)))).toEqual(task.bytes);
  });

  it("puts no gold patch bytes in either sealed document", () => {
    const candidate = buildFixtureCandidate();
    const env = environment();
    const spec = buildCandidateEvaluationSpec(candidate, env);
    const task = buildSealedTask(candidate, env, spec.digest);
    const gold = decoder.decode(candidate.goldPatch);
    expect(decoder.decode(task.bytes)).not.toContain(gold);
    expect(decoder.decode(spec.bytes)).not.toContain(gold);
  });
});
```

Add `buildFixtureCandidate(overrides?: Partial<Candidate>): Candidate` to
`src/testing-support.ts`, reusing the candidate factory written inline in Task 5's
`candidate.test.ts` (move it there and have that test import it — one factory, one place).

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/seal-pair.test.ts
```

Expected: FAIL — cannot resolve `./seal-pair.js`.

- [ ] **Step 3: Implement**

`src/seal-pair.ts`:

```ts
import {
  REPOSITORY_WORK_PROFILE_URI,
  buildRepositoryWorkProfile,
  sealEvaluationSpec,
  sealTaskProfile,
  sweRebenchRowToTaskAndSpec,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type SweRebenchRow,
} from "@jinn-network/task-execution-profiles";
import { TASK_EXECUTION_PROTOCOL_URI, sealTask } from "@jinn-network/task-execution-protocol";
import type { Candidate } from "./candidate.js";
import { assertPrefixedDigest, documentDigest, toBareHex, type Sha256Digest } from "./digest.js";
import {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
} from "./environment-extension.js";
import { DerivationError } from "./errors.js";
import { computeSourceCommitment } from "./source-commitment.js";
import type { DerivationEnvironment } from "./strategy.js";

export interface SealedEvaluationSpec {
  readonly document: EvaluationSpec;
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

export interface SealedTask {
  readonly bytes: Uint8Array;
  readonly digest: Sha256Digest;
}

/**
 * The row handed to the profiles mapper, with `image` and `parser` taken from the
 * environment record rather than from upstream. Because the record is the only source for
 * those fields, the pair that comes out cannot disagree with the record it cites
 * (design §7.1's inline-match rule holds by construction, not by a later check).
 */
function recordAlignedRow(candidate: Candidate, env: DerivationEnvironment): SweRebenchRow {
  const { record } = env;
  return {
    instance_id: candidate.provenance.upstream.instanceId,
    repo: record.source.repo,
    base_commit: record.source.commit,
    problem_statement: candidate.statement,
    language: candidate.language,
    image: {
      name: "environment-image",
      // §4.2 requires `reference` to end with `@<manifestDigest>`; both forms are written
      // so a consumer reading either the locator or the DigestSet resolves the same image.
      uri: record.image.reference,
      digest: { sha256: toBareHex(record.image.manifestDigest, "record image.manifestDigest") },
    },
    testMaterial: candidate.testMaterial.map((material) => ({
      name: material.name,
      mediaType: material.mediaType,
      content: material.content,
      digest: { sha256: toBareHex(material.digest, `test material "${material.name}" digest`) },
    })),
    // ParserIdentitySchema is strict (no extra keys): the record's advisory `uri`
    // acquisition hint is deliberately dropped here — the digest is what binds.
    parser: {
      id: record.parser.id,
      version: record.parser.version,
      digest: assertPrefixedDigest(record.parser.digest, "record parser.digest"),
    },
    transitions: {
      failToPass: [...candidate.transitions.failToPass],
      passToPass: [...candidate.transitions.passToPass],
    },
    timeout: candidate.timeout,
  };
}

/**
 * Builds and seals the candidate's EvaluationSpec. Reuses the profiles mapper for the
 * family-block body (including its `accessClass: "public"` stamping, D5), then overlays
 * the record's platform — the mapper hardcodes `linux/amd64`, planning Finding (d) — and
 * the namespaced environment-record key (§7.2).
 */
export function buildCandidateEvaluationSpec(
  candidate: Candidate,
  env: DerivationEnvironment,
): SealedEvaluationSpec {
  const mapped = sweRebenchRowToTaskAndSpec(recordAlignedRow(candidate, env));
  const baseBlock = mapped.evaluationSpec.familyBlock as DeterministicProcessBlock;

  const familyBlock = {
    ...baseBlock,
    platform: env.record.image.platform,
    [ENVIRONMENT_RECORD_EXTENSION_KEY]: buildEnvironmentRecordExtension(env.recordDigest),
  };

  const document: EvaluationSpec = { ...mapped.evaluationSpec, familyBlock };
  const { bytes, digest } = sealEvaluationSpec(document);
  return { document, bytes, digest };
}

/**
 * Builds and seals the Task around an already-sealed EvaluationSpec digest (the spec is
 * sealed strictly first; the Task only ever references it by digest, design §7).
 *
 * `inputs` and `payload` are built here rather than taken from the mapper: the record is
 * authoritative for the repository locator, and the payload carries two fields the mapper
 * does not write — `provenance.sourceCommitment` (§7.2) and `rights.sourceLicense` (D12,
 * planning Finding (c)).
 */
export function buildSealedTask(
  candidate: Candidate,
  env: DerivationEnvironment,
  evaluationSpecDigest: string,
): SealedTask {
  const profile = buildRepositoryWorkProfile();
  const profileDigest = sealTaskProfile(profile).digest;

  const outputs = profile.outputConventions.slots.map((slot) => {
    if (slot.mediaType === undefined) {
      throw new DerivationError(
        "invalid-input",
        `repository-work output slot "${slot.name}" declares no mediaType.`,
      );
    }
    return { name: slot.name, mediaType: slot.mediaType, required: slot.required };
  });

  const task = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: REPOSITORY_WORK_PROFILE_URI,
      digest: { sha256: toBareHex(profileDigest, "repository-work profile digest") },
    },
    instructions: candidate.statement,
    payload: {
      instance_id: candidate.provenance.upstream.instanceId,
      language: candidate.language,
      provenance: {
        kind: candidate.provenance.kind,
        sourceCommitment: computeSourceCommitment(candidate.provenance.upstream, candidate.statement),
      },
      rights: { sourceLicense: candidate.rights.sourceLicense },
    },
    inputs: [
      {
        name: "repository-state",
        uri: env.record.source.repoUrl,
        annotations: { ref: env.record.source.commit },
      },
    ],
    outputs,
    evaluation: {
      digest: { sha256: toBareHex(evaluationSpecDigest, "evaluation spec digest") },
    },
  };

  const bytes = sealTask(task);
  return { bytes, digest: documentDigest(bytes) };
}
```

- [ ] **Step 4: Export and verify**

Add to `src/index.ts`:

```ts
export { buildCandidateEvaluationSpec, buildSealedTask } from "./seal-pair.js";
export type { SealedEvaluationSpec, SealedTask } from "./seal-pair.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 41 tests pass across seven files.

- [ ] **Step 5: Commit**

```
feat(supply): seal Task + EvaluationSpec pairs with inline fields copied from the record

Reuses profiles' swe-rebench mapper for the family-block body and overlays the record's
platform plus the network.jinn.environment.record key. Image, platform and parser have one
source — the environment record — so C3's inline-match rule cannot fail on a pair this
builder produced.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 6
```

---

### Task 7: the import strategy

**Files:**
- Create: `src/strategies/import.ts`, `src/strategies/import.test.ts`
- Modify: `src/index.ts`, `src/testing-support.ts`

**Interfaces:**
- Consumes: `Candidate`, `assertCandidate`, `SPDX_EXPRESSION_PATTERN` (Task 5),
  `DerivationStrategy`, `DerivationEnvironment`, `StrategyDeps` (Task 5),
  `documentDigest` (Task 2), `DerivationError` (Task 2).
- Produces: `IMPORT_STRATEGY_ID`, `UpstreamRebenchRow`, `ImportStrategyInputs`,
  `PERMISSIVE_LICENSE_ALLOWLIST`, `assessRow`, `importStrategy`.

**Scope discipline (§12).** This strategy transcribes. It does not generate, mutate,
paraphrase, translate, or summarize a statement; there is no model call anywhere in this
file. The statement is the upstream issue text byte-for-byte. A step that adds generation
is a defect — stop and report.

**Row shape.** `UpstreamRebenchRow` is declared locally (planning Finding (e)), following
profiles' own `LegacyJinnRepoTask` precedent — read `client/src/harnesses/impls/
swe-rebench-v2-evaluator/index.ts:14-22` for the upstream field names, import nothing.
Row *fetching* is out of scope: the caller materializes rows (contract 4 — no ambient
network in this package).

- [ ] **Step 1: Write the tests first**

`src/strategies/import.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { assertCandidate } from "../candidate.js";
import { loadDerivationEnvironment } from "../strategy.js";
import {
  IMPORT_STRATEGY_ID,
  PERMISSIVE_LICENSE_ALLOWLIST,
  importStrategy,
  type ImportStrategyInputs,
  type UpstreamRebenchRow,
} from "./import.js";
import { buildFixtureEnvironmentRecordBody, buildFixtureRow } from "../testing-support.js";

const env = loadDerivationEnvironment(
  sealEnvironmentRecord(buildFixtureEnvironmentRecordBody() as never),
);

function inputs(rows: UpstreamRebenchRow[]): ImportStrategyInputs {
  return {
    rows,
    upstream: { dataset: "nebius/SWE-rebench", revision: "refs/convert/parquet-2026-05-01" },
    defaultTimeoutSeconds: 900,
    licensePolicy: { allow: PERMISSIVE_LICENSE_ALLOWLIST },
  };
}

async function collect(strategyInputs: ImportStrategyInputs, skipped: string[] = []) {
  const out = [];
  for await (const candidate of importStrategy.derive(
    { logger: { candidateSkipped: (e) => skipped.push(`${e.candidateId}:${e.reason}`), candidateRefused: () => {}, pairWritten: () => {} } },
    env,
    strategyInputs,
  )) {
    out.push(candidate);
  }
  return out;
}

describe("import strategy (design §7.2, v1's only member)", () => {
  it("declares a format-identity id, not a product name", () => {
    expect(IMPORT_STRATEGY_ID).toBe("import.swe-rebench.v1");
  });

  it("carries the statement verbatim and produces a valid candidate", async () => {
    const row = buildFixtureRow({ problem_statement: "  leading and trailing  \n\n" });
    const [candidate] = await collect(inputs([row]));
    expect(candidate!.statement).toBe("  leading and trailing  \n\n");
    expect(candidate!.provenance).toEqual({
      kind: "mined",
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: row.instance_id,
      },
    });
    expect(() => assertCandidate(candidate!)).not.toThrow();
  });

  it("carries the gold patch as bytes and the test patch as digest-matched material", async () => {
    const row = buildFixtureRow();
    const [candidate] = await collect(inputs([row]));
    expect(new TextDecoder().decode(candidate!.goldPatch)).toBe(row.patch);
    expect(Buffer.from(candidate!.testMaterial[0]!.content, "base64").toString("utf8"))
      .toBe(row.test_patch);
  });

  it("skips a row whose repo or commit is not this record's environment", async () => {
    const skipped: string[] = [];
    const rows = [
      buildFixtureRow({ instance_id: "other__repo-1", repo: "other/repo" }),
      buildFixtureRow({ instance_id: "acme__widget-9", base_commit: "9".repeat(40) }),
    ];
    expect(await collect(inputs(rows), skipped)).toHaveLength(0);
    expect(skipped).toEqual([
      "other__repo-1:environment-row-mismatch",
      "acme__widget-9:environment-row-mismatch",
    ]);
  });

  it("filters on the caller's licence allowlist and never invents a default (D12)", async () => {
    const skipped: string[] = [];
    const rows = [
      buildFixtureRow({ instance_id: "acme__widget-a", license: "GPL-3.0-only" }),
      buildFixtureRow({ instance_id: "acme__widget-b", license: undefined }),
      buildFixtureRow({ instance_id: "acme__widget-c", license: "MIT" }),
    ];
    const kept = await collect(inputs(rows), skipped);
    expect(kept.map((candidate) => candidate.id)).toEqual(["acme__widget-c"]);
    expect(skipped).toEqual([
      "acme__widget-a:license-not-permitted",
      "acme__widget-b:license-undeclared",
    ]);
  });

  it("accepts a fallback licence only when the caller supplies one explicitly", async () => {
    const rows = [buildFixtureRow({ instance_id: "acme__widget-d", license: undefined })];
    const kept = await collect({ ...inputs(rows), fallbackLicense: "Apache-2.0" });
    expect(kept[0]!.rights.sourceLicense).toBe("Apache-2.0");
  });

  it("skips rows that cannot become a task: no statement, no gold, no fail-to-pass", async () => {
    const skipped: string[] = [];
    const rows = [
      buildFixtureRow({ instance_id: "acme__widget-e", problem_statement: "" }),
      buildFixtureRow({ instance_id: "acme__widget-f", patch: "" }),
      buildFixtureRow({ instance_id: "acme__widget-g", FAIL_TO_PASS: [] }),
      buildFixtureRow({ instance_id: "acme__widget-h", test_patch: "" }),
    ];
    expect(await collect(inputs(rows), skipped)).toHaveLength(0);
    expect(skipped).toEqual([
      "acme__widget-e:statement-empty",
      "acme__widget-f:gold-missing",
      "acme__widget-g:no-fail-to-pass",
      "acme__widget-h:test-material-missing",
    ]);
  });

  it("prefers the row's timeout and falls back to the caller's explicit default", async () => {
    const [withRowTimeout] = await collect(inputs([buildFixtureRow({ timeout: 1800 })]));
    expect(withRowTimeout!.timeout).toBe(1800);
    const [withDefault] = await collect(inputs([buildFixtureRow({ timeout: undefined })]));
    expect(withDefault!.timeout).toBe(900);
  });

  it("accepts an async row source as well as a sync one", async () => {
    async function* rows() {
      yield buildFixtureRow();
    }
    const out = [];
    for await (const candidate of importStrategy.derive({}, env, {
      ...inputs([]),
      rows: rows(),
    })) {
      out.push(candidate);
    }
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/strategies/import.test.ts
```

Expected: FAIL — cannot resolve `./import.js`.

- [ ] **Step 3: Add the row fixture builder**

In `src/testing-support.ts`:

```ts
import type { UpstreamRebenchRow } from "./strategies/import.js";

export function buildFixtureRow(
  overrides: Partial<UpstreamRebenchRow> = {},
): UpstreamRebenchRow {
  return {
    instance_id: "acme__widget-1234",
    repo: "acme/widget",
    base_commit: "3".repeat(40),
    problem_statement: "Widget.resize() raises on zero width.\n",
    language: "python",
    patch: "--- a/widget.py\n+++ b/widget.py\n@@\n-raise\n+return 0\n",
    test_patch: "--- a/tests/test_widget.py\n+++ b/tests/test_widget.py\n@@\n+def test_zero(): ...\n",
    FAIL_TO_PASS: ["tests/test_widget.py::test_zero"],
    PASS_TO_PASS: ["tests/test_widget.py::test_basic"],
    license: "Apache-2.0",
    timeout: 900,
    ...overrides,
  };
}
```

- [ ] **Step 4: Implement the strategy**

`src/strategies/import.ts`:

```ts
import type { Candidate, CandidateTestMaterial } from "../candidate.js";
import { documentDigest } from "../digest.js";
import type { DerivationEnvironment, DerivationStrategy, StrategyDeps } from "../strategy.js";

/**
 * A format identity, not a product name (program §5 contract 5): the precedent is profiles'
 * own `documents/swe-rebench.ts`.
 */
export const IMPORT_STRATEGY_ID = "import.swe-rebench.v1" as const;

/**
 * The upstream row fields this strategy reads. Declared locally, never imported: the legacy
 * shape lives in `client/`, which is reference-only (program §5 contract 12), and C2 declares
 * its own for grouping (planning Finding (e)).
 */
export interface UpstreamRebenchRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
  readonly problem_statement: string;
  readonly language: string;
  /** The gold patch. LOCAL-ONLY downstream: it never reaches the supply pool. */
  readonly patch: string;
  readonly test_patch: string;
  readonly FAIL_TO_PASS: readonly string[];
  readonly PASS_TO_PASS: readonly string[];
  /** Upstream-declared SPDX expression, if the dataset carries one. */
  readonly license?: string;
  readonly timeout?: number;
}

export interface ImportStrategyInputs {
  /** Rows the caller has already materialized — this package opens no network (contract 4). */
  readonly rows: AsyncIterable<UpstreamRebenchRow> | Iterable<UpstreamRebenchRow>;
  readonly upstream: { readonly dataset: string; readonly revision: string };
  /** Explicit: a timeout the operator did not choose is a hidden policy. */
  readonly defaultTimeoutSeconds: number;
  /** Explicit: D12's permissive filter is the operator's policy, never a built-in default. */
  readonly licensePolicy: { readonly allow: readonly string[] };
  /** Applied only to rows that declare no licence, and only when the caller sets it. */
  readonly fallbackLicense?: string;
}

/**
 * A commonly-used permissive set, offered for callers to pass explicitly. It is NOT a
 * default: `licensePolicy` is required, so no row is ever admitted under a policy the
 * operator did not state (D12).
 */
export const PERMISSIVE_LICENSE_ALLOWLIST = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "PSF-2.0",
  "Python-2.0",
  "Unlicense",
] as const;

export type RowRejection =
  | "environment-row-mismatch"
  | "statement-empty"
  | "gold-missing"
  | "test-material-missing"
  | "no-fail-to-pass"
  | "invalid-timeout"
  | "license-undeclared"
  | "license-not-permitted";

const encoder = new TextEncoder();

/**
 * Pure row assessment: either the licence to record, or the reason this row is not a
 * candidate for this environment. Exported so an operator can audit a batch before running
 * anything.
 */
export function assessRow(
  row: UpstreamRebenchRow,
  env: DerivationEnvironment,
  inputs: ImportStrategyInputs,
): { readonly ok: true; readonly sourceLicense: string; readonly timeout: number }
  | { readonly ok: false; readonly reason: RowRejection } {
  // The record describes ONE (repo, commit) tree; a row from another tree would be graded
  // against ground it was never written for.
  if (row.repo !== env.record.source.repo || row.base_commit !== env.record.source.commit) {
    return { ok: false, reason: "environment-row-mismatch" };
  }
  if (row.problem_statement.length === 0) return { ok: false, reason: "statement-empty" };
  if (row.patch.length === 0) return { ok: false, reason: "gold-missing" };
  if (row.test_patch.length === 0) return { ok: false, reason: "test-material-missing" };
  if (row.FAIL_TO_PASS.length === 0) return { ok: false, reason: "no-fail-to-pass" };

  const timeout = row.timeout ?? inputs.defaultTimeoutSeconds;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return { ok: false, reason: "invalid-timeout" };

  const declared = row.license ?? inputs.fallbackLicense;
  if (declared === undefined || declared.length === 0) {
    return { ok: false, reason: "license-undeclared" };
  }
  if (!inputs.licensePolicy.allow.includes(declared)) {
    return { ok: false, reason: "license-not-permitted" };
  }

  return { ok: true, sourceLicense: declared, timeout };
}

function testMaterialFrom(row: UpstreamRebenchRow): CandidateTestMaterial[] {
  const bytes = encoder.encode(row.test_patch);
  return [
    {
      name: "test-patch",
      mediaType: "text/x-diff",
      content: Buffer.from(bytes).toString("base64"),
      digest: documentDigest(bytes),
    },
  ];
}

/**
 * v1's only strategy (D4): an upstream row whose environment is described by `env` becomes
 * a candidate whose statement is that row's issue text, verbatim. Nothing here generates,
 * mutates or paraphrases text — statement generation is a named extension (§14), explicitly
 * cut from v1 (§12).
 */
export const importStrategy: DerivationStrategy<ImportStrategyInputs> = {
  id: IMPORT_STRATEGY_ID,
  async *derive(deps: StrategyDeps, env: DerivationEnvironment, inputs: ImportStrategyInputs) {
    for await (const row of inputs.rows as AsyncIterable<UpstreamRebenchRow>) {
      const assessment = assessRow(row, env, inputs);
      if (!assessment.ok) {
        deps.logger?.candidateSkipped({ candidateId: row.instance_id, reason: assessment.reason });
        continue;
      }

      const candidate: Candidate = {
        id: row.instance_id,
        statement: row.problem_statement,
        language: row.language,
        testMaterial: testMaterialFrom(row),
        transitions: {
          failToPass: [...row.FAIL_TO_PASS],
          passToPass: [...row.PASS_TO_PASS],
        },
        timeout: assessment.timeout,
        goldPatch: encoder.encode(row.patch),
        provenance: {
          kind: "mined",
          upstream: {
            dataset: inputs.upstream.dataset,
            revision: inputs.upstream.revision,
            instanceId: row.instance_id,
          },
        },
        rights: { sourceLicense: assessment.sourceLicense },
      };

      yield candidate;
    }
  },
};
```

`for await` accepts a sync iterable as well as an async one, so the single loop serves both
`rows` forms; the cast names that.

- [ ] **Step 5: Export and verify**

Add to `src/index.ts`:

```ts
export {
  IMPORT_STRATEGY_ID,
  PERMISSIVE_LICENSE_ALLOWLIST,
  assessRow,
  importStrategy,
} from "./strategies/import.js";
export type {
  ImportStrategyInputs,
  RowRejection,
  UpstreamRebenchRow,
} from "./strategies/import.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 50 tests pass across eight files.

- [ ] **Step 6: Commit**

```
feat(supply): the import strategy — upstream rows become candidates, verbatim

Statement is the row's issue text byte-for-byte, provenance.kind is mined, the SPDX licence
is filtered against a caller-supplied allowlist (D12, no built-in default), and the gold
patch rides as local-only bytes. No generation anywhere (§12).

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 7
```

---

### Task 8: the supply pool — digest-addressed, atomic, gold-free by type

**Files:**
- Create: `src/pool.ts`, `src/pool.test.ts`, `src/pool/filesystem.ts`,
  `src/pool/filesystem.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `compareCodeUnitStrings`, `documentDigest`,
  `assertPrefixedDigest`, `toBareHex`, `Sha256Digest`, `DerivationError` (Tasks 2),
  `ProvenanceKind` (Task 5), `UpstreamIdentity` (Task 3); `zod`; `node:fs/promises`
  (filesystem implementation only — the carve-out registered in Task 1).
- Produces: `SupplyPool`, `PoolEntry`, `PoolEntrySummary`, `PoolEntryProvenance`,
  `POOL_ENTRY_SCHEMA_VERSION`, `poolEntryManifestBytes`, `parsePoolEntryManifest`,
  `createFilesystemSupplyPool`.

**Two design commitments worth stating.** (1) **No timestamps, no status.** An entry
records what it is, never when it was written or whether it is "active" — §12 forbids
mutable status, and a clock in the manifest would make byte-exact fixtures untestable and
add an ambient dependency for nothing. Write time is the filesystem's business. (2) **Gold
cannot be stored here even by accident**: `PoolEntry` has no field that could hold it, and
`put` writes exactly the three files the manifest names.

- [ ] **Step 1: Write the contract tests first**

`src/pool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DerivationError } from "./errors.js";
import {
  POOL_ENTRY_SCHEMA_VERSION,
  assertEntryDigests,
  parsePoolEntryManifest,
  poolEntryManifestBytes,
} from "./pool.js";
import { buildFixturePoolEntry } from "./testing-support.js";

describe("pool entry manifest", () => {
  it("round-trips through canonical bytes", () => {
    const entry = buildFixturePoolEntry();
    const bytes = poolEntryManifestBytes(entry);
    expect(parsePoolEntryManifest(bytes)).toEqual({
      taskDigest: entry.taskDigest,
      evaluationSpecDigest: entry.evaluationSpecDigest,
      receiptDigest: entry.receiptDigest,
      environmentRecordDigest: entry.environmentRecordDigest,
      strategyId: entry.strategyId,
      provenance: entry.provenance,
      rights: entry.rights,
    });
  });

  it("records no timestamp and no status field (§12)", () => {
    const manifest = JSON.parse(new TextDecoder().decode(poolEntryManifestBytes(buildFixturePoolEntry())));
    expect(Object.keys(manifest).sort()).toEqual([
      "environmentRecordDigest",
      "evaluationSpecDigest",
      "provenance",
      "receiptDigest",
      "rights",
      "schemaVersion",
      "strategyId",
      "taskDigest",
    ]);
    expect(manifest.schemaVersion).toBe(POOL_ENTRY_SCHEMA_VERSION);
  });

  it("refuses an entry whose declared digest does not address its bytes", () => {
    const entry = buildFixturePoolEntry();
    expect(() => assertEntryDigests({ ...entry, taskDigest: `sha256:${"0".repeat(64)}` }))
      .toThrow(DerivationError);
    expect(() => assertEntryDigests({ ...entry, evaluationSpecDigest: `sha256:${"0".repeat(64)}` }))
      .toThrow(DerivationError);
  });
});
```

`src/pool/filesystem.test.ts`:

```ts
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DerivationError } from "../errors.js";
import { createFilesystemSupplyPool } from "./filesystem.js";
import { buildFixturePoolEntry } from "../testing-support.js";

async function pool() {
  const dir = await mkdtemp(join(tmpdir(), "jinn-supply-pool-"));
  let counter = 0;
  return { dir, pool: createFilesystemSupplyPool({ dir, uniqueSuffix: () => `${(counter += 1)}` }) };
}

describe("filesystem supply pool", () => {
  it("round-trips an entry byte-for-byte, addressed by task digest", async () => {
    const { pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    const summary = await store.put(entry);
    expect(summary.taskDigest).toBe(entry.taskDigest);

    const read = await store.get(entry.taskDigest);
    expect(read!.taskBytes).toEqual(entry.taskBytes);
    expect(read!.evaluationSpecBytes).toEqual(entry.evaluationSpecBytes);
    expect(read!.provenance).toEqual(entry.provenance);
  });

  it("accepts the digest in bare-hex form too", async () => {
    const { pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    expect(await store.get(entry.taskDigest.slice("sha256:".length))).toBeDefined();
  });

  it("is idempotent: re-putting identical content leaves one entry", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    await store.put(entry);
    expect(await readdir(join(dir, "entries"))).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses to overwrite a different body at the same address", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    const hex = entry.taskDigest.slice("sha256:".length);
    await writeFile(join(dir, "entries", hex, "task.sealed.json"), "{}");
    await expect(store.put(entry)).rejects.toThrow(DerivationError);
  });

  it("leaves nothing behind when a put is rejected before writing", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await expect(store.put({ ...entry, taskDigest: `sha256:${"0".repeat(64)}` }))
      .rejects.toThrow(DerivationError);
    expect(await readdir(join(dir, "entries")).catch(() => [])).toHaveLength(0);
  });

  it("stages under a scratch directory and cleans it up", async () => {
    const { dir, pool: store } = await pool();
    await store.put(buildFixturePoolEntry());
    expect(await readdir(join(dir, ".staging"))).toHaveLength(0);
  });

  it("lists deterministically, ordered by task digest", async () => {
    const { pool: store } = await pool();
    const a = buildFixturePoolEntry({ statement: "alpha" });
    const b = buildFixturePoolEntry({ statement: "beta" });
    await store.put(b);
    await store.put(a);
    const digests = (await store.list()).map((summary) => summary.taskDigest);
    expect(digests).toEqual([...digests].sort());
  });

  it("returns undefined for an unknown digest rather than throwing", async () => {
    const { pool: store } = await pool();
    expect(await store.get(`sha256:${"f".repeat(64)}`)).toBeUndefined();
  });

  it("writes exactly three files per entry — nowhere for gold to live", async () => {
    const { dir, pool: store } = await pool();
    const entry = buildFixturePoolEntry();
    await store.put(entry);
    const hex = entry.taskDigest.slice("sha256:".length);
    expect((await readdir(join(dir, "entries", hex))).sort())
      .toEqual(["entry.json", "evaluation-spec.sealed.json", "task.sealed.json"]);
    const manifest = await readFile(join(dir, "entries", hex, "entry.json"), "utf8");
    expect(manifest).not.toContain("gold");
  });
});
```

`buildFixturePoolEntry(overrides?: {statement?: string}): PoolEntry` goes in
`src/testing-support.ts` and is built by running Task 6's `buildCandidateEvaluationSpec` +
`buildSealedTask` over the fixture candidate and environment, with a fixed placeholder
receipt digest (`sha256:` + `"7".repeat(64)`) — the pool does not care where a receipt
digest came from.

- [ ] **Step 2: Run both suites and watch them fail**

```bash
cd packages/task-supply/derivation && yarn test src/pool.test.ts src/pool/filesystem.test.ts
```

Expected: FAIL — cannot resolve `./pool.js` / `./filesystem.js`.

- [ ] **Step 3: Implement the pool contract**

`src/pool.ts`:

```ts
import { z } from "zod";
import { canonicalJsonBytes } from "./canonical.js";
import type { ProvenanceKind } from "./candidate.js";
import { assertPrefixedDigest, documentDigest, type Sha256Digest } from "./digest.js";
import { DerivationError } from "./errors.js";
import type { UpstreamIdentity } from "./source-commitment.js";

export const POOL_ENTRY_SCHEMA_VERSION = 1 as const;

export interface PoolEntryProvenance {
  readonly kind: ProvenanceKind;
  readonly sourceCommitment: Sha256Digest;
  readonly upstream: UpstreamIdentity;
}

/**
 * What the pool records about a pair. Deliberately absent: any timestamp, any status flag
 * (§12 — all such state is derived projection), and any field that could carry gold
 * material.
 */
export interface PoolEntrySummary {
  readonly taskDigest: Sha256Digest;
  readonly evaluationSpecDigest: Sha256Digest;
  /** The admission receipt this pair earned; the receipt bytes live in the evidence store. */
  readonly receiptDigest: Sha256Digest;
  readonly environmentRecordDigest: Sha256Digest;
  readonly strategyId: string;
  readonly provenance: PoolEntryProvenance;
  readonly rights: { readonly sourceLicense: string };
}

export interface PoolEntry extends PoolEntrySummary {
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
}

/**
 * The derivation unit's output store (design §3.2: the pool is this unit's store, not a
 * standalone unit). Digest-addressed: an entry's address is its Task digest.
 */
export interface SupplyPool {
  put(entry: PoolEntry): Promise<PoolEntrySummary>;
  get(taskDigest: string): Promise<PoolEntry | undefined>;
  list(): Promise<readonly PoolEntrySummary[]>;
}

const PrefixedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const PoolEntryManifestSchema = z.strictObject({
  schemaVersion: z.literal(POOL_ENTRY_SCHEMA_VERSION),
  taskDigest: PrefixedDigest,
  evaluationSpecDigest: PrefixedDigest,
  receiptDigest: PrefixedDigest,
  environmentRecordDigest: PrefixedDigest,
  strategyId: z.string().min(1),
  provenance: z.strictObject({
    kind: z.literal("mined"),
    sourceCommitment: PrefixedDigest,
    upstream: z.strictObject({
      dataset: z.string().min(1),
      revision: z.string().min(1),
      instanceId: z.string().min(1),
    }),
  }),
  rights: z.strictObject({ sourceLicense: z.string().min(1) }),
});

export function poolEntryManifestBytes(summary: PoolEntrySummary): Uint8Array {
  return canonicalJsonBytes({
    schemaVersion: POOL_ENTRY_SCHEMA_VERSION,
    taskDigest: summary.taskDigest,
    evaluationSpecDigest: summary.evaluationSpecDigest,
    receiptDigest: summary.receiptDigest,
    environmentRecordDigest: summary.environmentRecordDigest,
    strategyId: summary.strategyId,
    provenance: {
      kind: summary.provenance.kind,
      sourceCommitment: summary.provenance.sourceCommitment,
      upstream: {
        dataset: summary.provenance.upstream.dataset,
        revision: summary.provenance.upstream.revision,
        instanceId: summary.provenance.upstream.instanceId,
      },
    },
    rights: { sourceLicense: summary.rights.sourceLicense },
  });
}

export function parsePoolEntryManifest(bytes: Uint8Array): PoolEntrySummary {
  const parsed = PoolEntryManifestSchema.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (!parsed.success) {
    throw new DerivationError(
      "invalid-input",
      `pool entry manifest is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const { schemaVersion: _schemaVersion, ...summary } = parsed.data;
  return summary as PoolEntrySummary;
}

/** The pool is digest-addressed only if the address is checked against the bytes. */
export function assertEntryDigests(entry: PoolEntry): void {
  const task = documentDigest(entry.taskBytes);
  if (task !== assertPrefixedDigest(entry.taskDigest, "entry.taskDigest")) {
    throw new DerivationError(
      "pool-conflict",
      `entry taskDigest ${entry.taskDigest} does not address its bytes (${task}).`,
    );
  }
  const spec = documentDigest(entry.evaluationSpecBytes);
  if (spec !== assertPrefixedDigest(entry.evaluationSpecDigest, "entry.evaluationSpecDigest")) {
    throw new DerivationError(
      "pool-conflict",
      `entry evaluationSpecDigest ${entry.evaluationSpecDigest} does not address its bytes (${spec}).`,
    );
  }
}
```

- [ ] **Step 4: Implement the filesystem pool**

`src/pool/filesystem.ts`:

```ts
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnitStrings } from "../order.js";
import { assertBareHex, type Sha256Digest } from "../digest.js";
import { DerivationError } from "../errors.js";
import {
  assertEntryDigests,
  parsePoolEntryManifest,
  poolEntryManifestBytes,
  type PoolEntry,
  type PoolEntrySummary,
  type SupplyPool,
} from "../pool.js";

const TASK_FILE = "task.sealed.json";
const SPEC_FILE = "evaluation-spec.sealed.json";
const MANIFEST_FILE = "entry.json";

export interface FilesystemSupplyPoolOptions {
  readonly dir: string;
  /**
   * Distinguishes concurrent staging directories. Required rather than defaulted: ambient
   * randomness is authority this package does not take (program §5 contract 4). Production
   * callers pass `() => randomUUID()`.
   */
  readonly uniqueSuffix: () => string;
}

function addressOf(taskDigest: string): string {
  return assertBareHex(
    taskDigest.startsWith("sha256:") ? taskDigest.slice("sha256:".length) : taskDigest,
    "task digest",
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Sealed pairs on disk, digest-addressed. Writes are atomic per entry: the three files are
 * staged in a scratch directory and the *directory* is renamed into place, so a reader
 * never observes a half-written entry.
 */
export function createFilesystemSupplyPool(options: FilesystemSupplyPoolOptions): SupplyPool {
  const entriesRoot = join(options.dir, "entries");
  const stagingRoot = join(options.dir, ".staging");

  async function readEntryAt(address: string): Promise<PoolEntry | undefined> {
    const directory = join(entriesRoot, address);
    const manifestBytes = await readIfPresent(join(directory, MANIFEST_FILE));
    if (manifestBytes === undefined) return undefined;
    const summary = parsePoolEntryManifest(manifestBytes);
    const taskBytes = await readIfPresent(join(directory, TASK_FILE));
    const evaluationSpecBytes = await readIfPresent(join(directory, SPEC_FILE));
    if (taskBytes === undefined || evaluationSpecBytes === undefined) {
      throw new DerivationError("pool-conflict", `pool entry ${address} is missing sealed bytes.`);
    }
    const entry: PoolEntry = { ...summary, taskBytes, evaluationSpecBytes };
    assertEntryDigests(entry);
    return entry;
  }

  return {
    async put(entry: PoolEntry): Promise<PoolEntrySummary> {
      assertEntryDigests(entry);
      const address = addressOf(entry.taskDigest);
      const manifestBytes = poolEntryManifestBytes(entry);

      const staging = join(stagingRoot, `${address}.${options.uniqueSuffix()}`);
      await mkdir(entriesRoot, { recursive: true });
      await mkdir(staging, { recursive: true });
      try {
        await writeFile(join(staging, TASK_FILE), entry.taskBytes);
        await writeFile(join(staging, SPEC_FILE), entry.evaluationSpecBytes);
        await writeFile(join(staging, MANIFEST_FILE), manifestBytes);
        await rename(staging, join(entriesRoot, address));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        // Address already taken: identical content is idempotent, different content is a
        // conflict. A sealed pair is never rewritten (principles §5/§7).
        await rm(staging, { recursive: true, force: true });
        const existing = await readIfPresent(join(entriesRoot, address, TASK_FILE));
        const existingManifest = await readIfPresent(join(entriesRoot, address, MANIFEST_FILE));
        const identical =
          existing !== undefined
          && existingManifest !== undefined
          && bytesEqual(existing, entry.taskBytes)
          && bytesEqual(existingManifest, manifestBytes);
        if (!identical) {
          throw new DerivationError(
            "pool-conflict",
            `pool already holds a different body at ${entry.taskDigest}.`,
          );
        }
      }

      const { taskBytes: _taskBytes, evaluationSpecBytes: _specBytes, ...summary } = entry;
      return summary;
    },

    async get(taskDigest: string): Promise<PoolEntry | undefined> {
      return readEntryAt(addressOf(taskDigest));
    },

    async list(): Promise<readonly PoolEntrySummary[]> {
      let addresses: string[];
      try {
        addresses = await readdir(entriesRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const summaries: PoolEntrySummary[] = [];
      for (const address of addresses.sort(compareCodeUnitStrings)) {
        const manifestBytes = await readIfPresent(join(entriesRoot, address, MANIFEST_FILE));
        if (manifestBytes !== undefined) summaries.push(parsePoolEntryManifest(manifestBytes));
      }
      return summaries.sort((left, right) =>
        compareCodeUnitStrings(left.taskDigest, right.taskDigest));
    },
  };
}
```

The unused-destructure names are prefixed with `_` to satisfy `strict`; if the repo's lint
rejects that form, use an explicit field-by-field summary construction instead.

- [ ] **Step 5: Export and verify**

Add to `src/index.ts`:

```ts
export {
  POOL_ENTRY_SCHEMA_VERSION,
  PoolEntryManifestSchema,
  assertEntryDigests,
  parsePoolEntryManifest,
  poolEntryManifestBytes,
} from "./pool.js";
export type {
  PoolEntry,
  PoolEntryProvenance,
  PoolEntrySummary,
  SupplyPool,
} from "./pool.js";
export { createFilesystemSupplyPool } from "./pool/filesystem.js";
export type { FilesystemSupplyPoolOptions } from "./pool/filesystem.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
node --test .github/scripts/task-supply-source-boundaries.test.mjs
```

Expected: typecheck reports zero errors; 62 tests pass across ten files; the boundary guard
passes with the file-scoped `node:fs` carve-out.

- [ ] **Step 6: Commit**

```
feat(supply): the digest-addressed supply pool with atomic filesystem writes

Entries carry sealed Task + EvaluationSpec bytes, the receipt digest, and a provenance
summary — no timestamp, no status field (§12), and no field that could hold gold material.
Directory-rename staging makes a half-written entry unobservable.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 8
```

---

### Task 9: the gold store — local-only, separate, keyed by the receipt's hash

**Files:**
- Create: `src/gold.ts`, `src/gold/filesystem.ts`, `src/gold/filesystem.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `documentDigest`, `assertBareHex`, `Sha256Digest`, `DerivationError` (Task 2);
  `node:fs/promises` (carve-out registered in Task 1).
- Produces: `GoldStore`, `GoldRef`, `createFilesystemGoldStore`.

**Why it is a separate store, not a pool field.** Admission needs the gold patch to prove
the suite resolves and discriminates; the receipt then records only `goldPatchHash`
(§7.1, "gold present as digest only"). Nothing downstream of admission needs the bytes, so
the bytes stay behind on the machine that ran admission, in a store the pool has no
reference to. The pool's type carries no gold field (Task 8) and the gold store's directory
is disjoint — two independent reasons the bytes cannot travel with a published pair.

- [ ] **Step 1: Write the tests first**

`src/gold/filesystem.test.ts`:

```ts
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentDigest } from "../digest.js";
import { DerivationError } from "../errors.js";
import { GOLD_STORE_MARKER_FILE, createFilesystemGoldStore } from "./filesystem.js";

const GOLD = new TextEncoder().encode("--- a/widget.py\n+++ b/widget.py\n@@\n-raise\n+return 0\n");

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "jinn-gold-"));
  let counter = 0;
  return { dir, store: createFilesystemGoldStore({ dir, uniqueSuffix: () => `${(counter += 1)}` }) };
}

describe("filesystem gold store", () => {
  it("keys by the content digest and round-trips the bytes", async () => {
    const { store: gold } = await store();
    const ref = await gold.put(GOLD);
    expect(ref.goldPatchHash).toBe(documentDigest(GOLD));
    expect(await gold.get(ref.goldPatchHash)).toEqual(GOLD);
  });

  it("accepts a bare-hex key, so a receipt using either encoding resolves", async () => {
    const { store: gold } = await store();
    const ref = await gold.put(GOLD);
    expect(await gold.get(ref.goldPatchHash.slice("sha256:".length))).toEqual(GOLD);
  });

  it("returns undefined for an unknown hash and rejects a malformed one", async () => {
    const { store: gold } = await store();
    expect(await gold.get(`sha256:${"0".repeat(64)}`)).toBeUndefined();
    await expect(gold.get("not-a-digest")).rejects.toThrow(DerivationError);
  });

  it("is idempotent", async () => {
    const { dir, store: gold } = await store();
    await gold.put(GOLD);
    await gold.put(GOLD);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".patch"));
    expect(files).toHaveLength(1);
  });

  it("writes owner-only files and a do-not-publish marker", async () => {
    const { dir, store: gold } = await store();
    const ref = await gold.put(GOLD);
    const mode = (await stat(join(dir, `${ref.goldPatchHash.slice("sha256:".length)}.patch`))).mode;
    expect(mode & 0o077).toBe(0);
    expect(await readdir(dir)).toContain(GOLD_STORE_MARKER_FILE);
  });

  it("refuses empty bytes", async () => {
    const { store: gold } = await store();
    await expect(gold.put(new Uint8Array())).rejects.toThrow(DerivationError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/gold/filesystem.test.ts
```

Expected: FAIL — cannot resolve `./filesystem.js`.

- [ ] **Step 3: Implement**

`src/gold.ts`:

```ts
import type { Sha256Digest } from "./digest.js";

export interface GoldRef {
  /** The digest an admission receipt records as `goldPatchHash` (design §7.1). */
  readonly goldPatchHash: Sha256Digest;
}

/**
 * Local-only storage for gold patches. These bytes are the answers to admitted tasks: they
 * are what admission needs to prove a suite resolves and discriminates, and they are the
 * one thing a solver must not receive. Nothing in this package writes them anywhere else,
 * and the supply pool has no field that could carry them.
 */
export interface GoldStore {
  put(goldPatch: Uint8Array): Promise<GoldRef>;
  get(goldPatchHash: string): Promise<Uint8Array | undefined>;
}
```

`src/gold/filesystem.ts`:

```ts
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertBareHex, documentDigest } from "../digest.js";
import { DerivationError } from "../errors.js";
import type { GoldRef, GoldStore } from "../gold.js";

export const GOLD_STORE_MARKER_FILE = "DO-NOT-PUBLISH";

const MARKER_TEXT =
  "Local-only gold-patch store.\n"
  + "These files are the answers to admitted tasks. Do not publish, sync, or serve this\n"
  + "directory. The supply pool deliberately contains none of these bytes.\n";

export interface FilesystemGoldStoreOptions {
  readonly dir: string;
  /** See the pool's option of the same name: injected, never ambient. */
  readonly uniqueSuffix: () => string;
}

function addressOf(goldPatchHash: string): string {
  return assertBareHex(
    goldPatchHash.startsWith("sha256:") ? goldPatchHash.slice("sha256:".length) : goldPatchHash,
    "goldPatchHash",
  );
}

export function createFilesystemGoldStore(options: FilesystemGoldStoreOptions): GoldStore {
  return {
    async put(goldPatch: Uint8Array): Promise<GoldRef> {
      if (goldPatch.byteLength === 0) {
        throw new DerivationError("invalid-input", "gold patch must be non-empty.");
      }
      const goldPatchHash = documentDigest(goldPatch);
      const address = goldPatchHash.slice("sha256:".length);

      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      await writeFile(join(options.dir, GOLD_STORE_MARKER_FILE), MARKER_TEXT, { mode: 0o600 });

      const staging = join(options.dir, `.${address}.${options.uniqueSuffix()}`);
      try {
        await writeFile(staging, goldPatch, { mode: 0o600 });
        await chmod(staging, 0o600);
        await rename(staging, join(options.dir, `${address}.patch`));
      } catch (error) {
        await rm(staging, { force: true });
        throw error;
      }
      return { goldPatchHash };
    },

    async get(goldPatchHash: string): Promise<Uint8Array | undefined> {
      const address = addressOf(goldPatchHash);
      try {
        return new Uint8Array(await readFile(join(options.dir, `${address}.patch`)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
```

`rename` over an existing target replaces it atomically, which keeps `put` idempotent for
identical content (the address *is* the content digest, so the target can only ever hold
the same bytes).

- [ ] **Step 4: Export and verify**

Add to `src/index.ts`:

```ts
export type { GoldRef, GoldStore } from "./gold.js";
export { GOLD_STORE_MARKER_FILE, createFilesystemGoldStore } from "./gold/filesystem.js";
export type { FilesystemGoldStoreOptions } from "./gold/filesystem.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 68 tests pass across eleven files.

- [ ] **Step 5: Commit**

```
feat(supply): local-only gold store, disjoint from the supply pool

Gold patches are keyed by the digest a receipt records as goldPatchHash, written owner-only
beside a do-not-publish marker, in a directory the pool holds no reference to.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 9
```

---

### Task 10: `runDerivation` — admit, discard refusals, seal, write

**Files:**
- Create: `src/run.ts`, `src/run.test.ts`
- Modify: `src/index.ts`, `src/testing-support.ts`

**Interfaces:**
- Consumes — from `@jinn-network/task-admission` (branch `supply/c3-task-admission`),
  **type-only**: `admitCandidate`'s candidate parameter type (assumed `AdmissionCandidate`),
  `AdmissionResult`, `DifferentialAdmissionReceiptV3`, the refusal-code type (assumed
  `AdmissionRefusalCode`). From Tasks 3–9: `Candidate`, `assertCandidate`,
  `DerivationStrategy`, `DerivationEnvironment`, `DerivationLogger`,
  `buildCandidateEvaluationSpec`, `buildSealedTask`, `SupplyPool`, `GoldStore`,
  `computeSourceCommitment`, `digestsEqual`, `DerivationError`.
- Produces: `AdmissionPort`, `DerivationDeps`, `PoolWriteSummary`, `WrittenPair`,
  `RefusedCandidate`, `FailedCandidate`, `runDerivation`.

**Custody boundary.** C4 does **not** call `admitCandidate` and does **not** call
`sealReceipt` — both need injected deps and a signer. It defines a two-method
`AdmissionPort` and consumes it. The adapter that binds C3's functions to this port belongs
to the tier-4 composition (§3.1, §12: the composition is described, not packaged here). C4
therefore holds no key material and its runtime dependency on C3 is types only.

**Error policy.** A `DerivationError` for one candidate becomes a `failed` row and the run
continues. Anything else — a container runtime that died, a disk that filled — propagates
and aborts the run. Fail closed: a run that silently marks 500 candidates "failed" because
a port is down is worse than a run that stops.

- [ ] **Step 1: Bind to C3's real type names**

```bash
grep -rn "AdmissionCandidate\|AdmissionResult\|AdmissionRefusalCode\|goldPatchHash" \
  packages/task-supply/admission/src/index.ts packages/task-supply/admission/src/*.ts | head -40
```

Write down: (i) the exported name of `admitCandidate`'s candidate parameter type, (ii) its
field names for statement / evaluation spec / gold patch, (iii) the refusal union's code
type name, (iv) the receipt's gold-hash field name and whether it is `sha256:`-prefixed.
`toAdmissionCandidate` below is the **only** place these appear — adjust names there and
nowhere else. If the candidate parameter type does not exist as an exported symbol at all,
stop and report (contract 11).

- [ ] **Step 2: Write the run tests first**

`src/run.test.ts`:

```ts
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDerivation } from "./run.js";
import { createFilesystemSupplyPool } from "./pool/filesystem.js";
import { createFilesystemGoldStore } from "./gold/filesystem.js";
import { computeSourceCommitment } from "./source-commitment.js";
import {
  buildFixtureEnvironment,
  buildFixtureRow,
  createStubAdmissionPort,
  fixtureImportInputs,
} from "./testing-support.js";
import { importStrategy } from "./strategies/import.js";

async function harness(admission = createStubAdmissionPort()) {
  const root = await mkdtemp(join(tmpdir(), "jinn-run-"));
  let counter = 0;
  const uniqueSuffix = () => `${(counter += 1)}`;
  return {
    root,
    admission,
    deps: {
      admission,
      pool: createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix }),
      goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
    },
  };
}

const env = buildFixtureEnvironment();

describe("runDerivation", () => {
  it("writes admitted pairs and reports them in the summary", async () => {
    const { deps } = await harness();
    const rows = [buildFixtureRow(), buildFixtureRow({ instance_id: "acme__widget-2", problem_statement: "Second issue.\n" })];
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs(rows));

    expect(summary.strategyId).toBe(importStrategy.id);
    expect(summary.environmentRecordDigest).toBe(env.recordDigest);
    expect(summary.written).toHaveLength(2);
    expect(summary.refused).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);
    expect(await deps.pool.list()).toHaveLength(2);
  });

  it("discards refusals with a typed summary and writes nothing for them", async () => {
    const admission = createStubAdmissionPort({
      refuse: { "acme__widget-2": "env-record-mismatch" },
    });
    const { deps } = await harness(admission);
    const rows = [buildFixtureRow(), buildFixtureRow({ instance_id: "acme__widget-2", problem_statement: "Second issue.\n" })];
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs(rows));

    expect(summary.written).toHaveLength(1);
    expect(summary.refused).toEqual([
      { candidateId: "acme__widget-2", code: "env-record-mismatch" },
    ]);
    expect(await deps.pool.list()).toHaveLength(1);
  });

  it("hands admission a candidate whose spec cites this environment record", async () => {
    const admission = createStubAdmissionPort();
    const { deps } = await harness(admission);
    await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(admission.seen).toHaveLength(1);
    expect(admission.seen[0]!.environmentRecordBytes).toEqual(env.recordBytes);
  });

  it("records the receipt digest the admission port published", async () => {
    const { deps, admission } = await harness();
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(summary.written[0]!.receiptDigest).toBe(admission.published[0]);
    const entry = await deps.pool.get(summary.written[0]!.taskDigest);
    expect(entry!.receiptDigest).toBe(admission.published[0]);
  });

  it("carries the provenance summary into the entry", async () => {
    const { deps } = await harness();
    const row = buildFixtureRow();
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([row]));
    const entry = await deps.pool.get(summary.written[0]!.taskDigest);
    expect(entry!.provenance).toEqual({
      kind: "mined",
      sourceCommitment: computeSourceCommitment(
        {
          dataset: "nebius/SWE-rebench",
          revision: "refs/convert/parquet-2026-05-01",
          instanceId: row.instance_id,
        },
        row.problem_statement,
      ),
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: row.instance_id,
      },
    });
    expect(entry!.rights.sourceLicense).toBe("Apache-2.0");
  });

  it("stores gold in the gold store and nowhere in the pool", async () => {
    const { root, deps } = await harness();
    const row = buildFixtureRow();
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([row]));
    expect(summary.written).toHaveLength(1);

    const goldFiles = (await readdir(join(root, "gold"))).filter((name) => name.endsWith(".patch"));
    expect(goldFiles).toHaveLength(1);

    const poolRoot = join(root, "pool", "entries");
    for (const address of await readdir(poolRoot)) {
      for (const file of await readdir(join(poolRoot, address))) {
        const text = await readFile(join(poolRoot, address, file), "utf8");
        expect(text).not.toContain(row.patch);
        expect(text).not.toContain("+return 0");
      }
    }
  });

  it("fails the pair, loudly and locally, when the receipt's gold hash disagrees", async () => {
    const admission = createStubAdmissionPort({ goldHashOverride: `sha256:${"0".repeat(64)}` });
    const { deps } = await harness(admission);
    const summary = await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(summary.written).toHaveLength(0);
    expect(summary.failed[0]!.reason).toBe("gold-mismatch");
    expect(await deps.pool.list()).toHaveLength(0);
  });

  it("propagates a port failure instead of marking every candidate failed", async () => {
    const admission = createStubAdmissionPort({ throwOn: "acme__widget-1234" });
    const { deps } = await harness(admission);
    await expect(runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()])))
      .rejects.toThrow(/admission port unavailable/);
  });

  it("is idempotent across reruns", async () => {
    const { deps } = await harness();
    const inputs = fixtureImportInputs([buildFixtureRow()]);
    await runDerivation(deps, importStrategy, env, inputs);
    const second = await runDerivation(deps, importStrategy, env, fixtureImportInputs([buildFixtureRow()]));
    expect(second.failed).toHaveLength(0);
    expect(await deps.pool.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Add the stub admission port and run helpers**

In `src/testing-support.ts` — a hand-written double, not a mock framework:

```ts
import type { AdmissionPort } from "./run.js";

export interface StubAdmissionOptions {
  readonly refuse?: Record<string, string>;
  readonly goldHashOverride?: string;
  readonly throwOn?: string;
}

export interface StubAdmissionPort extends AdmissionPort {
  readonly seen: { candidate: unknown; environmentRecordBytes: Uint8Array }[];
  readonly published: string[];
}

/**
 * A scripted admission double. It performs no runs and proves nothing — it exists so this
 * package's own behaviour (refusal handling, gold routing, pool writes) is testable without
 * a container runtime. C3's kit is what tests admission.
 */
export function createStubAdmissionPort(options: StubAdmissionOptions = {}): StubAdmissionPort {
  const seen: { candidate: unknown; environmentRecordBytes: Uint8Array }[] = [];
  const published: string[] = [];
  let counter = 0;

  return {
    seen,
    published,
    async admit(candidate, environmentRecordBytes) {
      const id = (candidate as { statement: string }).statement;
      seen.push({ candidate, environmentRecordBytes });
      const instanceId = (candidate as { instanceId?: string }).instanceId ?? "";
      if (options.throwOn !== undefined && instanceId === options.throwOn) {
        throw new Error("admission port unavailable");
      }
      const refusal = options.refuse?.[instanceId];
      if (refusal !== undefined) return { refusal: { code: refusal } } as never;
      return {
        receipt: {
          goldPatchHash:
            options.goldHashOverride
            ?? (candidate as { goldPatchHash: string }).goldPatchHash,
          statement: id,
        },
      } as never;
    },
    async publishReceipt() {
      counter += 1;
      const digest = `sha256:${String(counter).padStart(64, "0")}` as const;
      published.push(digest);
      return { digest };
    },
  };
}
```

The stub reads `instanceId` and `goldPatchHash` off the admission candidate, so
`toAdmissionCandidate` must carry both (they are the two fields C4 needs echoed back).
Adjust to C3's real field names alongside Step 1's binding.

Also add `buildFixtureEnvironment()` (the sealed + loaded fixture environment) and
`fixtureImportInputs(rows)` (the `ImportStrategyInputs` used across suites) to
`src/testing-support.ts`.

- [ ] **Step 4: Run and watch it fail**

```bash
cd packages/task-supply/derivation && yarn test src/run.test.ts
```

Expected: FAIL — cannot resolve `./run.js`.

- [ ] **Step 5: Implement**

`src/run.ts`:

```ts
import type {
  AdmissionCandidate,
  AdmissionResult,
  DifferentialAdmissionReceiptV3,
} from "@jinn-network/task-admission";
import type { Candidate } from "./candidate.js";
import { assertCandidate } from "./candidate.js";
import { digestsEqual, type Sha256Digest } from "./digest.js";
import { DerivationError, type DerivationErrorCategory } from "./errors.js";
import type { GoldRef, GoldStore } from "./gold.js";
import type { SupplyPool } from "./pool.js";
import { buildCandidateEvaluationSpec, buildSealedTask, type SealedEvaluationSpec } from "./seal-pair.js";
import { computeSourceCommitment } from "./source-commitment.js";
import type { DerivationEnvironment, DerivationLogger, DerivationStrategy } from "./strategy.js";

/**
 * The admission surface, as a port. C4 never calls `admitCandidate` or `sealReceipt`
 * directly: both take injected deps and a signer, and binding them is the composing
 * application's job (design §3.1). This package therefore holds no key material.
 */
export interface AdmissionPort {
  admit(
    candidate: AdmissionCandidate,
    environmentRecordBytes: Uint8Array,
  ): Promise<AdmissionResult>;
  /** Seals the receipt and persists it, returning the digest the pool entry cites. */
  publishReceipt(receipt: DifferentialAdmissionReceiptV3): Promise<{ readonly digest: Sha256Digest }>;
}

export interface DerivationDeps {
  readonly admission: AdmissionPort;
  readonly pool: SupplyPool;
  readonly goldStore: GoldStore;
  readonly logger?: DerivationLogger;
}

export interface WrittenPair {
  readonly candidateId: string;
  readonly taskDigest: Sha256Digest;
  readonly evaluationSpecDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}

/** An admission refusal: a first-class outcome, summarized and discarded (design §7.2). */
export interface RefusedCandidate {
  readonly candidateId: string;
  readonly code: string;
}

export interface FailedCandidate {
  readonly candidateId: string;
  readonly reason: DerivationErrorCategory;
  readonly message: string;
}

export interface PoolWriteSummary {
  readonly strategyId: string;
  readonly environmentRecordDigest: Sha256Digest;
  readonly written: readonly WrittenPair[];
  readonly refused: readonly RefusedCandidate[];
  readonly failed: readonly FailedCandidate[];
}

/**
 * The single place C3's candidate shape appears (planning Finding (b)). The EvaluationSpec
 * handed over is the sealed one, so the inline image/platform/parser admission compares
 * against the record are the record's own values (Task 6).
 */
function toAdmissionCandidate(
  candidate: Candidate,
  spec: SealedEvaluationSpec,
  gold: GoldRef,
): AdmissionCandidate {
  return {
    instanceId: candidate.id,
    statement: candidate.statement,
    evaluationSpec: spec.document,
    evaluationSpecDigest: spec.digest,
    goldPatch: candidate.goldPatch,
    goldPatchHash: gold.goldPatchHash,
    transitions: {
      failToPass: [...candidate.transitions.failToPass],
      passToPass: [...candidate.transitions.passToPass],
    },
  } as AdmissionCandidate;
}

/**
 * Pipes a strategy's candidates through admission and writes the survivors to the pool as
 * sealed pairs.
 *
 * A `DerivationError` on one candidate becomes a `failed` row and the run continues;
 * anything else propagates, so a port outage aborts loudly instead of producing a summary
 * full of spurious failures.
 */
export async function runDerivation<TInputs>(
  deps: DerivationDeps,
  strategy: DerivationStrategy<TInputs>,
  env: DerivationEnvironment,
  inputs: TInputs,
): Promise<PoolWriteSummary> {
  const written: WrittenPair[] = [];
  const refused: RefusedCandidate[] = [];
  const failed: FailedCandidate[] = [];

  for await (const candidate of strategy.derive({ logger: deps.logger }, env, inputs)) {
    try {
      assertCandidate(candidate);

      const spec = buildCandidateEvaluationSpec(candidate, env);
      const gold = await deps.goldStore.put(candidate.goldPatch);
      const result = await deps.admission.admit(
        toAdmissionCandidate(candidate, spec, gold),
        env.recordBytes,
      );

      if ("refusal" in result) {
        const code = String((result as { refusal: { code: unknown } }).refusal.code);
        refused.push({ candidateId: candidate.id, code });
        deps.logger?.candidateRefused({ candidateId: candidate.id, code });
        continue;
      }

      const receipt = (result as { receipt: DifferentialAdmissionReceiptV3 }).receipt;
      const receiptGoldHash = String((receipt as unknown as { goldPatchHash: string }).goldPatchHash);
      if (!digestsEqual(receiptGoldHash, gold.goldPatchHash)) {
        // The receipt and the stored gold must describe the same bytes; if they do not,
        // one of the two is about something else and the pair does not get written.
        throw new DerivationError(
          "gold-mismatch",
          `receipt goldPatchHash ${receiptGoldHash} does not match the stored gold ${gold.goldPatchHash}.`,
        );
      }

      const { digest: receiptDigest } = await deps.admission.publishReceipt(receipt);
      const task = buildSealedTask(candidate, env, spec.digest);

      await deps.pool.put({
        taskDigest: task.digest,
        taskBytes: task.bytes,
        evaluationSpecDigest: spec.digest,
        evaluationSpecBytes: spec.bytes,
        receiptDigest,
        environmentRecordDigest: env.recordDigest,
        strategyId: strategy.id,
        provenance: {
          kind: candidate.provenance.kind,
          sourceCommitment: computeSourceCommitment(
            candidate.provenance.upstream,
            candidate.statement,
          ),
          upstream: candidate.provenance.upstream,
        },
        rights: { sourceLicense: candidate.rights.sourceLicense },
      });

      written.push({
        candidateId: candidate.id,
        taskDigest: task.digest,
        evaluationSpecDigest: spec.digest,
        receiptDigest,
      });
      deps.logger?.pairWritten({ candidateId: candidate.id, taskDigest: task.digest });
    } catch (error) {
      if (!(error instanceof DerivationError)) throw error;
      failed.push({
        candidateId: candidate.id,
        reason: error.category,
        message: error.message,
      });
    }
  }

  return {
    strategyId: strategy.id,
    environmentRecordDigest: env.recordDigest,
    written,
    refused,
    failed,
  };
}
```

- [ ] **Step 6: Export and verify**

Add to `src/index.ts`:

```ts
export { runDerivation } from "./run.js";
export type {
  AdmissionPort,
  DerivationDeps,
  FailedCandidate,
  PoolWriteSummary,
  RefusedCandidate,
  WrittenPair,
} from "./run.js";
```

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; 77 tests pass across twelve files.

- [ ] **Step 7: Commit**

```
feat(supply): runDerivation — admit, discard refusals, seal survivors, write the pool

Pipes a strategy's candidates through an injected AdmissionPort, summarizes refusals
without writing them, cross-checks the receipt's gold hash against the stored bytes, and
writes sealed pairs. C4 calls neither admitCandidate nor sealReceipt: it holds no key
material, and the adapter is the composing application's.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 10
```

---

### Task 11: the conformance kit — golden run, refusal path, gold-never-in-pool

**Files:**
- Create: `src/testing.ts`, `src/kit/golden.test.ts`, `src/kit/refusal.test.ts`,
  `src/kit/gold-never-in-pool.test.ts`, `src/kit/store-conformance.test.ts`,
  `fixtures/rows/rows.json`
- Generated and committed: `fixtures/environment/record.sealed.json`,
  `fixtures/golden/summary.json`,
  `fixtures/golden/entries/<taskHex>/{task.sealed.json,evaluation-spec.sealed.json,entry.json}`
- Modify: `package.json` (already carries `fixtures:update`)

**Interfaces:**
- Consumes: everything built in Tasks 2–10; `vitest` (optional peer) inside
  `src/testing.ts`; `node:fs/promises` in test files only.
- Produces: the `./testing` entrypoint —`createStubAdmissionPort`,
  `loadFixtureEnvironmentBytes`, `loadFixtureRows`, `describeSupplyPoolConformance`,
  `describeGoldStoreConformance`.

**Fixture-generation discipline.** The expected sealed bytes are *pins produced by a run*,
not values invented in this plan: `yarn fixtures:update` writes them, the run is committed
alongside the code, and every later run compares. A digest that moves without a
corresponding design change is a failure, not a fixture refresh.

- [ ] **Step 1: Write the fixture rows**

`fixtures/rows/rows.json` — three rows against the fixture environment
(`acme/widget@3333…`): two permissively licensed, one GPL so the licence filter has
something to reject. Field names are `UpstreamRebenchRow`'s; `patch` is the gold patch and
appears in this file only, never in an expected-output fixture.

```json
[
  {
    "instance_id": "acme__widget-1234",
    "repo": "acme/widget",
    "base_commit": "3333333333333333333333333333333333333333",
    "problem_statement": "Widget.resize() raises on zero width.\n\nExpected: returns 0.\n",
    "language": "python",
    "patch": "--- a/widget.py\n+++ b/widget.py\n@@\n-    raise ValueError\n+    return 0\n",
    "test_patch": "--- a/tests/test_widget.py\n+++ b/tests/test_widget.py\n@@\n+def test_zero():\n+    assert resize(0) == 0\n",
    "FAIL_TO_PASS": ["tests/test_widget.py::test_zero"],
    "PASS_TO_PASS": ["tests/test_widget.py::test_basic"],
    "license": "Apache-2.0",
    "timeout": 900
  },
  {
    "instance_id": "acme__widget-1235",
    "repo": "acme/widget",
    "base_commit": "3333333333333333333333333333333333333333",
    "problem_statement": "Widget.rotate() drops the alpha channel.\n",
    "language": "python",
    "patch": "--- a/widget.py\n+++ b/widget.py\n@@\n-    return rgb\n+    return rgba\n",
    "test_patch": "--- a/tests/test_rotate.py\n+++ b/tests/test_rotate.py\n@@\n+def test_alpha():\n+    assert rotate(img).mode == \"RGBA\"\n",
    "FAIL_TO_PASS": ["tests/test_rotate.py::test_alpha"],
    "PASS_TO_PASS": [],
    "license": "MIT",
    "timeout": 1200
  },
  {
    "instance_id": "acme__widget-1236",
    "repo": "acme/widget",
    "base_commit": "3333333333333333333333333333333333333333",
    "problem_statement": "Widget.crop() is off by one.\n",
    "language": "python",
    "patch": "--- a/widget.py\n+++ b/widget.py\n@@\n-    end - 1\n+    end\n",
    "test_patch": "--- a/tests/test_crop.py\n+++ b/tests/test_crop.py\n@@\n+def test_crop(): ...\n",
    "FAIL_TO_PASS": ["tests/test_crop.py::test_crop"],
    "PASS_TO_PASS": [],
    "license": "GPL-3.0-only",
    "timeout": 900
  }
]
```

- [ ] **Step 2: Write the `./testing` entrypoint**

`src/testing.ts` — promotes the doubles and loaders out of `testing-support.ts`, and adds
the two store-conformance kits a third-party implementation runs against:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { documentDigest } from "./digest.js";
import type { GoldStore } from "./gold.js";
import type { PoolEntry, SupplyPool } from "./pool.js";
import type { UpstreamRebenchRow } from "./strategies/import.js";

export { createStubAdmissionPort } from "./testing-support.js";
export type { StubAdmissionOptions, StubAdmissionPort } from "./testing-support.js";

export async function loadFixtureEnvironmentBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL("../fixtures/environment/record.sealed.json", import.meta.url)),
  );
}

export async function loadFixtureRows(): Promise<UpstreamRebenchRow[]> {
  return JSON.parse(
    await readFile(new URL("../fixtures/rows/rows.json", import.meta.url), "utf8"),
  ) as UpstreamRebenchRow[];
}

export interface SupplyPoolConformanceOptions {
  readonly name: string;
  createPool(): Promise<{ pool: SupplyPool; dispose?: () => Promise<void> }>;
  buildEntry(): PoolEntry;
}

/** The contract any SupplyPool implementation must satisfy, not just the filesystem one. */
export function describeSupplyPoolConformance(options: SupplyPoolConformanceOptions): void {
  describe(`SupplyPool conformance: ${options.name}`, () => {
    it("round-trips an entry addressed by its task digest", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await pool.put(entry);
        const read = await pool.get(entry.taskDigest);
        expect(read!.taskBytes).toEqual(entry.taskBytes);
        expect(read!.evaluationSpecBytes).toEqual(entry.evaluationSpecBytes);
      } finally {
        await dispose?.();
      }
    });

    it("is idempotent and lists deterministically", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await pool.put(entry);
        await pool.put(entry);
        const listed = await pool.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]!.taskDigest).toBe(entry.taskDigest);
      } finally {
        await dispose?.();
      }
    });

    it("rejects an entry whose digest does not address its bytes", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await expect(pool.put({ ...entry, taskDigest: `sha256:${"0".repeat(64)}` }))
          .rejects.toThrow();
      } finally {
        await dispose?.();
      }
    });

    it("exposes no route by which gold material could be stored", async () => {
      const { pool, dispose } = await options.createPool();
      try {
        const entry = options.buildEntry();
        await pool.put(entry);
        const read = await pool.get(entry.taskDigest);
        expect(Object.keys(read!).filter((key) => /gold/i.test(key))).toEqual([]);
      } finally {
        await dispose?.();
      }
    });
  });
}

export interface GoldStoreConformanceOptions {
  readonly name: string;
  createStore(): Promise<{ store: GoldStore; dispose?: () => Promise<void> }>;
}

export function describeGoldStoreConformance(options: GoldStoreConformanceOptions): void {
  describe(`GoldStore conformance: ${options.name}`, () => {
    it("keys by content digest and round-trips", async () => {
      const { store, dispose } = await options.createStore();
      try {
        const bytes = new TextEncoder().encode("--- a/x\n+++ b/x\n");
        const ref = await store.put(bytes);
        expect(ref.goldPatchHash).toBe(documentDigest(bytes));
        expect(await store.get(ref.goldPatchHash)).toEqual(bytes);
      } finally {
        await dispose?.();
      }
    });

    it("returns undefined for an unknown hash", async () => {
      const { store, dispose } = await options.createStore();
      try {
        expect(await store.get(`sha256:${"0".repeat(64)}`)).toBeUndefined();
      } finally {
        await dispose?.();
      }
    });
  });
}
```

`src/index.ts` must never re-export `./testing.ts` or `./testing-support.ts`.

- [ ] **Step 3: Write the golden run test**

`src/kit/golden.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { runDerivation } from "../run.js";
import { importStrategy, PERMISSIVE_LICENSE_ALLOWLIST } from "../strategies/import.js";
import { loadDerivationEnvironment } from "../strategy.js";
import {
  buildFixtureEnvironmentRecordBody,
  createStubAdmissionPort,
} from "../testing-support.js";
import { loadFixtureRows } from "../testing.js";

const UPDATE = process.env["JINN_UPDATE_FIXTURES"] === "1";
const fixtures = (path: string) => new URL(`../../fixtures/${path}`, import.meta.url);

async function expectBytes(path: string, actual: Uint8Array): Promise<void> {
  const url = fixtures(path);
  if (UPDATE) {
    await mkdir(new URL(".", url), { recursive: true });
    await writeFile(url, actual);
    return;
  }
  expect(new Uint8Array(await readFile(url))).toEqual(actual);
}

describe("golden derivation run", () => {
  it("produces byte-exact sealed pairs, entry manifests, and summary", async () => {
    const recordBytes = sealEnvironmentRecord(buildFixtureEnvironmentRecordBody() as never);
    await expectBytes("environment/record.sealed.json", recordBytes);

    const env = loadDerivationEnvironment(recordBytes);
    const root = await mkdtemp(join(tmpdir(), "jinn-golden-"));
    let counter = 0;
    const uniqueSuffix = () => `${(counter += 1)}`;
    const pool = createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix });

    const skipped: string[] = [];
    const summary = await runDerivation(
      {
        admission: createStubAdmissionPort(),
        pool,
        goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
        logger: {
          candidateSkipped: (event) => skipped.push(`${event.candidateId}:${event.reason}`),
          candidateRefused: () => {},
          pairWritten: () => {},
        },
      },
      importStrategy,
      env,
      {
        rows: await loadFixtureRows(),
        upstream: { dataset: "nebius/SWE-rebench", revision: "refs/convert/parquet-2026-05-01" },
        defaultTimeoutSeconds: 900,
        licensePolicy: { allow: PERMISSIVE_LICENSE_ALLOWLIST },
      },
    );

    // The GPL row never becomes a candidate (D12's permissive filter).
    expect(skipped).toEqual(["acme__widget-1236:license-not-permitted"]);
    expect(summary.written).toHaveLength(2);
    expect(summary.refused).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);

    for (const pair of summary.written) {
      const address = pair.taskDigest.slice("sha256:".length);
      const entryDir = join(root, "pool", "entries", address);
      for (const file of (await readdir(entryDir)).sort()) {
        await expectBytes(
          `golden/entries/${address}/${file}`,
          new Uint8Array(await readFile(join(entryDir, file))),
        );
      }
    }

    await expectBytes(
      "golden/summary.json",
      new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`),
    );
  });
});
```

The stub's receipt digests are a deterministic counter (Task 10), so the summary and entry
manifests are reproducible.

- [ ] **Step 4: Generate and inspect the fixtures**

```bash
cd packages/task-supply/derivation && yarn fixtures:update
git status --short packages/task-supply/derivation/fixtures
git diff --stat -- packages/task-supply/derivation/fixtures
```

Expected: `fixtures/environment/record.sealed.json`, `fixtures/golden/summary.json`, and
two `fixtures/golden/entries/<64-hex>/` directories each holding `entry.json`,
`evaluation-spec.sealed.json`, `task.sealed.json`.

**Inspect before committing** — the fixtures are the pin, so read them once:

```bash
python3 -m json.tool packages/task-supply/derivation/fixtures/golden/entries/*/entry.json | head -40
grep -c "network.jinn.environment.record" packages/task-supply/derivation/fixtures/golden/entries/*/evaluation-spec.sealed.json
grep -o '"instructions":"[^"]\{0,40\}' packages/task-supply/derivation/fixtures/golden/entries/*/task.sealed.json
```

Expected: each `entry.json` carries `provenance.kind: "mined"`, a `sourceCommitment`, the
`rights.sourceLicense` from its row, and no timestamp; each sealed spec contains the
namespaced key exactly once; each task's `instructions` is its row's statement.

Then re-run without the flag to prove the comparison path works:

```bash
yarn test src/kit/golden.test.ts
```

Expected: PASS, comparing against the committed bytes.

- [ ] **Step 5: Write the refusal-path and gold-never-in-pool tests**

`src/kit/refusal.test.ts`:

```ts
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { runDerivation } from "../run.js";
import { importStrategy } from "../strategies/import.js";
import {
  buildFixtureEnvironment,
  createStubAdmissionPort,
  fixtureImportInputs,
} from "../testing-support.js";
import { loadFixtureRows } from "../testing.js";

describe("refusal path", () => {
  it("keeps a refused candidate out of the pool entirely", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-refusal-"));
    let counter = 0;
    const uniqueSuffix = () => `${(counter += 1)}`;
    const pool = createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix });

    const summary = await runDerivation(
      {
        admission: createStubAdmissionPort({
          refuse: { "acme__widget-1235": "env-record-mismatch" },
        }),
        pool,
        goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
      },
      importStrategy,
      buildFixtureEnvironment(),
      fixtureImportInputs(await loadFixtureRows()),
    );

    expect(summary.refused).toEqual([
      { candidateId: "acme__widget-1235", code: "env-record-mismatch" },
    ]);
    expect(summary.written.map((pair) => pair.candidateId)).toEqual(["acme__widget-1234"]);
    expect(await readdir(join(root, "pool", "entries"))).toHaveLength(1);
    // A refusal is an outcome, not an error: the run reports it and moves on.
    expect(summary.failed).toHaveLength(0);
  });
});
```

`src/kit/gold-never-in-pool.test.ts`:

```ts
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { runDerivation } from "../run.js";
import { importStrategy } from "../strategies/import.js";
import {
  buildFixtureEnvironment,
  createStubAdmissionPort,
  fixtureImportInputs,
} from "../testing-support.js";
import { loadFixtureRows } from "../testing.js";

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if ((await stat(path)).isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

describe("gold never enters the pool", () => {
  it("leaves no gold byte sequence anywhere under the pool directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-gold-scan-"));
    let counter = 0;
    const uniqueSuffix = () => `${(counter += 1)}`;
    const rows = await loadFixtureRows();

    const summary = await runDerivation(
      {
        admission: createStubAdmissionPort(),
        pool: createFilesystemSupplyPool({ dir: join(root, "pool"), uniqueSuffix }),
        goldStore: createFilesystemGoldStore({ dir: join(root, "gold"), uniqueSuffix }),
      },
      importStrategy,
      buildFixtureEnvironment(),
      fixtureImportInputs(rows),
    );
    expect(summary.written.length).toBeGreaterThan(0);

    const poolFiles = await walk(join(root, "pool"));
    expect(poolFiles.length).toBeGreaterThan(0);
    for (const path of poolFiles) {
      const text = await readFile(path, "utf8");
      for (const row of rows) {
        expect(text, `gold leaked into ${relative(root, path)}`).not.toContain(row.patch);
        for (const line of row.patch.split("\n").filter((l) => l.startsWith("+") && l.length > 3)) {
          expect(text, `gold line leaked into ${relative(root, path)}`).not.toContain(line);
        }
      }
    }

    // …and the bytes really are retrievable from the store that is supposed to hold them.
    const goldFiles = await walk(join(root, "gold"));
    expect(goldFiles.filter((path) => path.endsWith(".patch"))).toHaveLength(
      summary.written.length,
    );
  });
});
```

`src/kit/store-conformance.test.ts` runs the two exported kits against the filesystem
implementations:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemGoldStore } from "../gold/filesystem.js";
import { createFilesystemSupplyPool } from "../pool/filesystem.js";
import { buildFixturePoolEntry } from "../testing-support.js";
import { describeGoldStoreConformance, describeSupplyPoolConformance } from "../testing.js";

let counter = 0;
const uniqueSuffix = () => `${(counter += 1)}`;

describeSupplyPoolConformance({
  name: "filesystem",
  async createPool() {
    const dir = await mkdtemp(join(tmpdir(), "jinn-pool-kit-"));
    return {
      pool: createFilesystemSupplyPool({ dir, uniqueSuffix }),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  },
  buildEntry: () => buildFixturePoolEntry(),
});

describeGoldStoreConformance({
  name: "filesystem",
  async createStore() {
    const dir = await mkdtemp(join(tmpdir(), "jinn-gold-kit-"));
    return {
      store: createFilesystemGoldStore({ dir, uniqueSuffix }),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  },
});
```

- [ ] **Step 6: Verify the whole kit**

```bash
cd packages/task-supply/derivation && yarn typecheck && yarn test
```

Expected: typecheck reports zero errors; every suite passes, including the four kit files.

- [ ] **Step 7: Commit**

```
test(supply): the derivation conformance kit — golden run, refusal path, gold scan

Byte-exact expected sealed pairs and entry manifests from a fixture environment record and
fixture rows; a refusal fixture proving a refused candidate reaches no store; a recursive
scan proving no gold byte sequence appears anywhere under the pool; and reusable
SupplyPool/GoldStore conformance kits on ./testing.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 11
```

---

### Task 12: README, bounded-claims guard, pack smoke, and the PR

**Files:**
- Create: `README.md`, `scripts/pack-smoke.mjs`, `src/kit/bounded-claims.test.ts`
- Modify: `src/index.ts` (final surface review)

**Interfaces:**
- Consumes: everything above.
- Produces: the package's documented public surface and the PR onto
  `supply/c3-task-admission`.

- [ ] **Step 1: Write the bounded-claims guard first (program §5 contract 8)**

`src/kit/bounded-claims.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url).pathname;

// "deterministic-process" is a frozen family identity, not a claim.
const UNBOUNDED_DETERMINISM = /\bdeterministic\b(?!-process)/gi;
const UNBOUNDED_VERIFIED = /\bverified\b/gi;

// A README sentence may use the words only alongside what bounds them.
const QUALIFIERS = [
  "attestation",
  "attestations",
  "attested",
  "trust policy",
  "under controls",
  "consecutive",
  "bounded",
  "never claims",
  "does not",
];

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("bounded claims", () => {
  it("uses neither word unqualified anywhere in source", async () => {
    for (const path of await sourceFiles(join(packageRoot, "src"))) {
      const text = await readFile(path, "utf8");
      expect(text.match(UNBOUNDED_DETERMINISM), `${path} claims determinism`).toBeNull();
      expect(text.match(UNBOUNDED_VERIFIED), `${path} claims verification`).toBeNull();
    }
  });

  it("qualifies every use in the README", async () => {
    const readme = await readFile(join(packageRoot, "README.md"), "utf8");
    for (const line of readme.split("\n")) {
      const uses = UNBOUNDED_DETERMINISM.test(line) || UNBOUNDED_VERIFIED.test(line);
      UNBOUNDED_DETERMINISM.lastIndex = 0;
      UNBOUNDED_VERIFIED.lastIndex = 0;
      if (!uses) continue;
      expect(
        QUALIFIERS.some((qualifier) => line.toLowerCase().includes(qualifier)),
        `unqualified claim: ${line}`,
      ).toBe(true);
    }
  });
});
```

Run it, see it fail on the missing README, then write the README to satisfy it — and where
it flags source text, fix the *text*, never the guard.

- [ ] **Step 2: Write the README**

`packages/task-supply/derivation/README.md` must contain, at minimum, these sections. The
content-safety and honesty paragraphs are normative (design §7.3), not decoration.

```markdown
# @jinn-network/task-derivation

Strategies that turn a **described execution environment** plus strategy inputs into
admitted, sealed Task + EvaluationSpec pairs in a supply pool.

## What this package does, and what it does not claim

It derives candidates, pipes them through an injected admission port, and writes the
survivors to a digest-addressed pool. It asserts nothing about whether the environment
behaves as described: that is what environment attestations are for, and whether they are
sufficient is the consumer's trust-policy join — never a property this package's output
claims. An admission receipt says the grader discriminated on the machine that ran it,
under the controls that run declared, and nothing more.

## Untrusted input (normative — design §7.3)

An imported statement is **upstream-authored text**. Public datasets and upstream pull
requests are attacker-influencable in principle, and the statement is delivered into every
solver's context — a prompt-injection channel. Consumers MUST treat task text as untrusted
data. Test material is upstream-authored code executed in containers; solve-time and
evaluation-time sandboxing belong to the executor's and evaluator's designs and are not
granted by any receipt this pipeline mints. Admission proves grading properties; it does
not and cannot prove content safety.

What consumers may rely on: `provenance.kind` labelling (filterable), admission receipts,
environment attestations, and pass-rate curation.

## No secrecy (D5)

For public repositories every v1 task's answer is discoverable — an imported answer sits in
the repository's history one `git log` away. This package builds no secrecy mechanism and
makes no secrecy claim. All test material is `accessClass: "public"`, set explicitly. There
is no grant infrastructure anywhere in the stack.

## Gold patches never enter the pool

The gold patch is what admission needs and what a solver must not receive. It goes to a
separate, local-only `GoldStore`, keyed by the digest the receipt records as
`goldPatchHash`. `PoolEntry` has no field that could carry it. Do not publish, sync, or
serve the gold directory; the store writes a `DO-NOT-PUBLISH` marker into it.

## `provenance.sourceCommitment` (this field's first writer)

Rule `network.jinn.source-commitment/1`. The commitment is
`sha256:<hex>` over the RFC 8785 canonical JSON of exactly five strings:

    {"dataset":…,"instanceId":…,"revision":…,"rule":"network.jinn.source-commitment/1","statementDigest":"sha256:…"}

where `statementDigest` is sha256 over the statement's UTF-8 bytes, verbatim. Canonical
JSON rather than a delimiter-joined string so a separator inside a dataset name cannot
forge a different tuple; the rule id inside the hashed bytes so a future rule cannot
collide with this one; the statement inside it so an upstream row edited in place yields a
different commitment. Recompute it with `sourceCommitmentPreImage` — the pre-image is
exported for exactly that reason.

## The environment-record reference

The sealed EvaluationSpec's deterministic-process block carries
`"network.jinn.environment.record": {"digest": {"sha256": "<bare hex>"}}`. Bare hex, like
every other DigestSet in the stack. `image`, `platform` and `parser` stay inline **copied
from the record**, so admission's inline-match rule holds by construction. A first-class
field is proposed upstream; this key is the interim carrier.

## Licence (D12)

Each task records `payload.rights.sourceLicense` as an SPDX expression, inherited from the
row and filtered against a licence allowlist the caller supplies explicitly. Declared, not
detected: this package checks that a producer supplied an expression, never that the
expression is true of the source.

## Not in v1

No injection strategies, no statement generation, no echo mining, no emergent-bug
harvesting (all named extensions). No posting — production ends at the pool. No pricing. No
row fetching: callers materialize rows; this package opens no socket and holds no key.

## Usage
```

followed by a short worked example wiring `importStrategy`, `createFilesystemSupplyPool`,
`createFilesystemGoldStore` and a caller-supplied `AdmissionPort` into `runDerivation`.

- [ ] **Step 3: Add the pack smoke script**

`scripts/pack-smoke.mjs` — adapt `packages/task-execution/profiles/scripts/pack-smoke.mjs`:
pack `task-execution-protocol`, `task-execution-profiles`, `environment-record`,
`task-admission` and this package into a scratch npm consumer, install with
`--ignore-scripts`, and compile a consumer module that imports both `.` and `./testing`.

- [ ] **Step 4: Review the public surface**

Read `src/index.ts` end to end against program §4's pinned C4 names and confirm each is
exported with the pinned spelling: `DerivationStrategy`, `importStrategy`, `runDerivation`,
`SupplyPool`, `ENVIRONMENT_RECORD_EXTENSION_KEY` (value
`network.jinn.environment.record`). Confirm `src/index.ts` re-exports nothing from
`testing.ts` or `testing-support.ts`:

```bash
grep -n "testing" packages/task-supply/derivation/src/index.ts
```

Expected: no output.

- [ ] **Step 5: Full verification, outputs shown**

```bash
cd packages/task-supply/derivation
yarn typecheck
yarn test
yarn build
yarn pack:smoke
cd ../../..
node --test .github/scripts/task-supply-package-inventory.test.mjs
node --test .github/scripts/task-supply-source-boundaries.test.mjs
node --test .github/scripts/task-supply-packed-types.test.mjs
git status --short
```

Expected: typecheck zero errors; all suites pass; build emits `dist/index.js`,
`dist/index.d.ts`, `dist/testing.js`, `dist/testing.d.ts`; pack smoke compiles the consumer;
all three guards pass; `git status` shows only intended files (no `dist/`, no `node_modules/`).

Also confirm C3's and C1's own kits are still green on this branch before opening the PR:

```bash
(cd packages/environments/record && yarn install --immutable && yarn test)
(cd packages/task-supply/admission && yarn install --immutable && yarn test)
```

- [ ] **Step 6: Commit and open the PR**

```
docs(supply): README, bounded-claims guard, and pack smoke for task-derivation

Documents the untrusted-input and no-secrecy paragraphs (design §7.3), the
source-commitment rule this package is the first writer of, and the gold-never-in-pool
discipline — with a test that fails on any unqualified determinism or verification claim in
source or README.

Refs: docs/superpowers/plans/2026-07-31-supply-c4-task-derivation.md Task 12
```

```bash
git push -u origin supply/c4-task-derivation
gh pr create --base supply/c3-task-admission --title "feat(supply): C4 — task derivation" --body "..."
```

The PR body states: the pinned §4 surface it produces; the four Findings (a)–(f) with their
proposed dispositions; that the pair's inline environment fields are copied from the record
so C3's match rule passes by construction; and that the gold-never-in-pool property is
enforced by type shape, by directory separation, and by a recursive byte scan.

---

## Self-review

**Design §7.2 coverage.** Every sentence of §7.2 maps to a task:

| §7.2 requirement | Where |
| --- | --- |
| Strategy maps *(environment + inputs) → candidates* | Task 5 (`DerivationStrategy`, `DerivationEnvironment`) |
| Unit runs candidates through admission | Task 10 (`runDerivation`, `AdmissionPort`) |
| Seals survivors, writes pairs to the pool | Tasks 6, 8, 10 |
| Import strategy is v1's only member (D4) | Task 7 (`importStrategy`, `IMPORT_STRATEGY_ID`) |
| Statement = the row's original issue text, no generation | Task 7 (verbatim, tested with whitespace); Task 6 (`instructions`) |
| Test material, transitions, timeout from the row | Task 7 |
| `provenance.kind: "mined"` | Tasks 6, 7 |
| `provenance.sourceCommitment`, this field's first writer | Task 3 (rule defined + documented), Task 6 (written), Task 12 (published in README) |
| Upstream instance id in payload lineage | Task 6 (`payload.instance_id`) |
| Admission re-proves gold-resolves + discriminates | Task 10 (candidate carries gold; port runs it) |
| Namespaced key `network.jinn.environment.record`, exact string | Task 4 |
| Image/platform/parser stay inline, duplicated from the record | Task 6 |
| Inline == record so the duplication cannot diverge | Task 6 (copied from the record; `Candidate` cannot carry them — Task 5) |
| All test material `accessClass: "public"`, explicitly (D5) | Task 6 (mapper stamps; asserted) |
| Licence per D12 | Tasks 5 (SPDX shape), 7 (allowlist filter), 6 (`payload.rights`) |
| Cut from v1: injection, generation, echo, emergent-bug | Global constraints + Task 7's scope note + README |

§7.3's two normative paragraphs land in Task 12's README with a test (Task 12 Step 1)
that fails on any unqualified claim. §3's seam test is honored: the pool is this unit's
store (§3.2), not a separate package; row fetching stays inside the strategy's caller.
§12's non-goals are restated as binding constraints and none of the twelve tasks builds one.

**Placeholder scan.** No `TODO`, no `FIXME`, no `<your value here>`, no invented digest
constants. Three values are deliberately *generated rather than stated*: the golden sealed
bytes, entry manifests, and summary (Task 11 Step 4, written by `yarn fixtures:update`,
inspected, then committed as pins). Every literal digest that appears in a test is either a
repeated-character sentinel (`"a".repeat(64)`) or computed in-test from real bytes.

**Signature consistency with program §4.** `DerivationStrategy` is
`{id, derive(deps, env, inputs): AsyncIterable<Candidate>}` — Task 5, exact. `importStrategy`
— Task 7. `runDerivation(deps, strategy, env, inputs): Promise<PoolWriteSummary>` — Task 10,
exact parameter order. `SupplyPool` with `put`/`list`/`get` over sealed pairs,
digest-addressed — Task 8. `ENVIRONMENT_RECORD_EXTENSION_KEY === "network.jinn.environment.record"`
— Task 4, asserted by test. Consumed C1 names (`EnvironmentRecord`,
`parseEnvironmentRecord`, `environmentRecordDigest`, `sealEnvironmentRecord`) and C3 names
(`admitCandidate`'s result/receipt types, `DifferentialAdmissionReceiptV3`) match §4; the
two names §4 leaves unpinned are Finding (b), bound in Task 10 Step 1 and confined to one
function.

**Contract check.** Contract 11: Task 1 Steps 1–2 and Task 10 Step 1 are explicit
stop-and-report gates. Contract 5: no product names; nothing imports `client/`, `core`,
`plugin`, `jinn-layer`, or `sdk` — `swe-rebench` appears only as a format identity, matching
profiles' own precedent. Contract 8: enforced by test, not by intention. Contract 4: no
ambient network, no ambient clock, no ambient randomness (`uniqueSuffix` is a required
injected port); no signer anywhere, since C4 defines the admission port rather than calling
`admitCandidate`/`sealReceipt`. Contract 6: strict prefixed/bare guards plus the confusion
fixture in two places (Task 2, Task 4).
