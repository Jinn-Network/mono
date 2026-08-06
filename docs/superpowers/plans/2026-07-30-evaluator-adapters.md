# Evaluator Adapters Implementation Plan

> **Addendum 2026-08-05** (per
> [DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md)):
> this plan's finding 1 ("nobody executes the `deterministic-process` container")
> hands off container execution to "the stage-2 evaluator loop" — that hand-off
> re-homes onto the **one-swap train** (DR decision 6 finding 5): the
> container-executing `GraderReportSource` is a swap deliverable and blocks the swap's
> gate (DR decision 3a). Prior art is preserved at `docs/salvage/stage-2/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/task-execution/evaluator-adapters/` — a fresh, parse-only tier-3 package supplying the swe-rebench and prediction `EvaluatorAdapter` implementations, their parser identities, and the deployment facade the evaluation harness loads through its parser allowlist.

**Architecture:** Three ingestion parsers (benchmark-local JSON, JUnit XML, TAP14) reduce untrusted grader output into one internal `TestOutcomeReport`; a shared transitions reducer turns that into declared measurements; two `EvaluatorAdapter`s derive their verdict by evaluating the EvaluationSpec's *own* `verdictRule` over those measurements, so the harness's `checkVerdictConsistency` gate can never disagree with the adapter. Infrastructure aborts raise the harness's typed no-verdict path (`EvaluationOperationalError`) instead of producing a false `fail`. The package touches no network, no chain, no signer, and never defines verdict semantics — the sealed Result Evaluation stays harness-owned (design §7 ruling 5).

**Tech Stack:** TypeScript 5.9 / Node 22 / Yarn 4.13.0 with `portal:` resolution; vitest 4; `node --test` for the repo guards; zero third-party runtime dependencies.

## Global Constraints

- **Branch target:** `integration/evidence-v1`. Baseline head `8c7179f2c`; PRs #2306 / #2307 / #2308 are assumed merged. Stacked PR train, one train for this component. No agent self-merge.
- **Custody:** this tree consumes **no signers** and no key material. Signing stays in the harness (`makeSecretsSigner`). Custody law is trivially clean here and must stay that way — no `secrets/` access, no key loading, ever.
- **npm name:** `@jinn-network/task-execution-evaluator-adapters` (program §5). Nothing publishes in this program; #2293 runs in parallel.
- **Fresh rewrite, legacy as fixtures** (program §6 contract 12): no line of `client/src/harnesses/impls/**` is ported. Legacy behavior enters only as kit test cases.
- **Kits and fixtures before implementations** (program Global constraints): Task 2 lands the conformance kit and the whole fixture corpus before any parser exists.
- **Guard trio ships with the tree, not after** (program Global constraints): Task 1 extends the package-inventory, source-boundary, and packed-types guards and adds the CI job, against an empty `src/`.
- **Adapters parse ingestion formats; they never define verdict semantics** (design §7 ruling 5). The verdict record grammar is `@jinn-network/attestation-issuer`'s, invoked by the harness.
- **No network at the adapter edge.** Production source uses no `fetch` / `WebSocket` / `EventSource` / `XMLHttpRequest`, no `node:http(s)`, no `node:net`, no `node:child_process`. Enforced by a guard assertion in Task 1.
- **No product names in tier-3 code** (program Global constraints). "swe-rebench" and "prediction" are benchmark/work-kind names, not Jinn product names, and are permitted; "operator", "Autopilot", "Jinn client" are not.
- **American English** in identifiers, file names, and copy (CLAUDE.md Rule 5).
- **No locale-sensitive APIs** in production source (`localeCompare`, `toLocale*`, `Intl`) — the task-execution guard already asserts this tree-wide; use code-unit comparison.
- **Fractional quantities are decimal strings, never JSON numbers** (profiles Global Constraints / §7.14). Brier scores are computed with `BigInt` scaled-integer arithmetic, never `Number`/`toFixed`.
- **Every task ends with** `yarn typecheck && yarn test && yarn build` in the package plus `node --test .github/scripts/task-execution-package-inventory.test.mjs` and `node --test .github/scripts/task-execution-source-boundaries.test.mjs` from the repo root, outputs shown.
- **Repo path contains an apostrophe** (`life's-work`) — quote every shell path.

---

## File Structure

All paths are relative to the repo root.

| File | Responsibility |
| --- | --- |
| `packages/task-execution/evaluator-adapters/package.json` | Manifest: name, exports `.` + `./testing`, portal resolutions, scripts |
| `packages/task-execution/evaluator-adapters/tsconfig.json`, `tsconfig.build.json` | Compiler config (copied from the evaluation harness) |
| `packages/task-execution/evaluator-adapters/README.md` | What the package is and the one rule it obeys |
| `packages/task-execution/evaluator-adapters/scripts/pack-smoke.mjs` | Packed-consumer smoke |
| `packages/task-execution/evaluator-adapters/scripts/seal-parser-declarations.mjs` | Generates/checks the pinned parser-declaration digests |
| `src/report.ts` | `TestOutcomeReport`, `TransitionOutcome`, `reduceTransitions`, log capping |
| `src/material.ts` | `resolveReportMaterial` — locates report bytes in Results, then context |
| `src/parsers/pytest-json-report.ts` | Benchmark-local JSON (`report.json`) ingestion |
| `src/parsers/junit-xml.ts` | JUnit XML ingestion (bounded, non-validating, XXE-refusing) |
| `src/parsers/tap14.ts` | TAP14 ingestion |
| `src/declarations.ts` | Parser declaration documents + sealed identities + allowlist keys |
| `src/infrastructure.ts` | Infrastructure-abort signature table → `EvaluationOperationalError` |
| `src/swe-rebench.ts` | `createSweRebenchRegistration` |
| `src/prediction.ts` | `createPredictionRegistration` |
| `src/deployment.ts` | `createEvaluatorDeployment` — the host-facing facade |
| `src/index.ts` | Public surface |
| `src/testing.ts` | `./testing` conformance kit + fixture loader + spec builders |
| `fixtures/**` | Six fixture families (golden + adversarial) |
| `.github/scripts/task-execution-package-inventory.test.mjs` | Extended: 10th package + dependency graph |
| `.github/scripts/task-execution-source-boundaries.test.mjs` | Extended: import allowlist + no-network + locale coverage |
| `.github/scripts/task-execution-packed-types.test.mjs` | Extended: package + entrypoints |
| `.github/workflows/task-execution-ci.yml` | Extended: `evaluator-adapters` job + `verify` wiring |

---

## Design findings (raised, not silently patched)

These surfaced from reading the code against design §6.3 / §7 ruling 5. Each carries a proposed disposition that this plan implements. Report them with the component; do not treat them as licence to widen scope.

1. **Nobody executes the `deterministic-process` container.** The family block carries `image`, `testMaterial`, `transitions`, `timeout`, but the evaluation harness runtime (`runtime.ts`) spawns no process and design §2's evaluate row assigns no owner. §6.3 scopes this tree to *parsing*. **Proposed disposition (implemented here):** adapters are parse-only and resolve already-produced grader output from the subject Results, falling back to host-provisioned `evaluation-context.json`; when it is absent they raise `EvaluationOperationalError{reason:"subject-not-found", recoveryAdvice:"operator-action-required"}` rather than inventing a verdict. The execution owner is a stage-2 (evaluator loop) hand-off.
2. **`recorded-inconclusive` is unreachable through the runtime's declared-class path.** `runtime.ts` calls `checkVerdictConsistency` without `declaredUnscorableClass`, so an adapter may return `inconclusive` only when the spec's own `verdictRule` recomputes to `inconclusive`. **Proposed disposition (implemented here):** both adapters derive their verdict by calling `evaluateVerdictRule` on the spec's rule over their own measurements, and the prediction fixture spec expresses market-unresolved as an `inconclusiveWhen` node. No runtime change requested.
3. **The frozen grader-family taxonomy has no pure-parse family**, so a prediction EvaluationSpec must be authored as `deterministic-process` and fill a nominal `image` descriptor. **Proposed disposition (implemented here):** the prediction *spec builder* lives in `./testing` (fixture surface only, so production ships no nominal image), and it sets `image` to the scorer's own sealed declaration descriptor — an honest content commitment to the code that scores. A profiles-side family/optionality amendment is a follow-up for the owning design, not this plan.
4. **Undeclared measurements are rejected by the runtime** (`measurementMap` → `operational(...undeclared measurement...)`). **Proposed disposition (implemented here):** every adapter emits the intersection of what it computed with `specification.measurements`, tested directly.
5. **Legacy log capping mislabels characters as bytes** (`capLogTail`: `${log.length - MAX} bytes truncated`). **Proposed disposition (implemented here):** the fresh implementation says `characters`, and the fixture pins the corrected text as a deliberate divergence from legacy.

---

### Task 1: Package scaffold, guard trio, CI job

Creates a guarded, CI-gated, empty package. A reviewer can accept or reject this independently of any parser.

**Files:**
- Create: `packages/task-execution/evaluator-adapters/package.json`
- Create: `packages/task-execution/evaluator-adapters/tsconfig.json`
- Create: `packages/task-execution/evaluator-adapters/tsconfig.build.json`
- Create: `packages/task-execution/evaluator-adapters/README.md`
- Create: `packages/task-execution/evaluator-adapters/src/index.ts`
- Modify: `.github/scripts/task-execution-package-inventory.test.mjs`
- Modify: `.github/scripts/task-execution-source-boundaries.test.mjs`
- Modify: `.github/scripts/task-execution-packed-types.test.mjs`
- Modify: `.github/workflows/task-execution-ci.yml`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the package directory and manifest name `@jinn-network/task-execution-evaluator-adapters`; production imports restricted to `@jinn-network/task-execution-evaluation-harness` and `@jinn-network/task-execution-profiles`.

- [ ] **Step 1: Write the failing guard assertions**

In `.github/scripts/task-execution-package-inventory.test.mjs`, add the tenth entry to `TASK_EXECUTION_PACKAGES` (after the `evaluation-harness` row):

```js
  ['evaluation-harness', '@jinn-network/task-execution-evaluation-harness'],
  ['evaluator-adapters', '@jinn-network/task-execution-evaluator-adapters'],
];
```

Change the count assertion in `test('the task-execution package inventory is explicit and has one manifest', ...)`:

```js
  assert.equal(TASK_EXECUTION_PACKAGES.length, 10);
```

Add the dependency-graph entry at the end of `JINN_DEPENDENCY_GRAPH` (alphabetical order inside each section — `jinnDependencyNames` sorts, so the expectation must be sorted):

```js
  // evaluator-adapters (composition design §6.3): parse-only adapters. PRODUCTION imports are
  // the evaluation-harness contract surface plus profiles (EvaluationSpec + verdict rule
  // evaluation) and nothing else. The devDependencies are type-resolution gap-fills for the
  // harness's own public .d.ts surface (attestation-issuer, evidence-protocol, launchers,
  // supervisor, workspace) plus task-execution-protocol, which the integration test uses to
  // seal subject Task/Delivery bytes.
  ['evaluator-adapters', {
    dependencies: [
      '@jinn-network/task-execution-evaluation-harness',
      '@jinn-network/task-execution-profiles',
    ],
    devDependencies: [
      '@jinn-network/attestation-issuer', '@jinn-network/evidence-protocol',
      '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    optionalDependencies: [], peerDependencies: [],
  }],
```

- [ ] **Step 2: Run the inventory guard to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071" && node --test .github/scripts/task-execution-package-inventory.test.mjs`
Expected: FAIL with `missing package manifest: .../packages/task-execution/evaluator-adapters/package.json`

- [ ] **Step 3: Create the manifest**

`packages/task-execution/evaluator-adapters/package.json`:

```json
{
  "name": "@jinn-network/task-execution-evaluator-adapters",
  "version": "0.1.0",
  "description": "Concrete evaluator adapters and ingestion-format parsers for the Jinn Task Execution Protocol evaluation harness.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/task-execution/evaluator-adapters"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs"
  },
  "dependencies": {
    "@jinn-network/task-execution-evaluation-harness": "0.1.0",
    "@jinn-network/task-execution-profiles": "0.1.0"
  },
  "devDependencies": {
    "@jinn-network/attestation-issuer": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/task-execution-launchers": "0.1.0",
    "@jinn-network/task-execution-protocol": "0.1.0",
    "@jinn-network/task-execution-supervisor": "0.1.0",
    "@jinn-network/task-execution-workspace": "0.1.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/attestation-issuer": "portal:../../evidence/attestation-issuer",
    "@jinn-network/evidence-protocol": "portal:../../evidence/protocol",
    "@jinn-network/task-execution-evaluation-harness": "portal:../evaluation-harness",
    "@jinn-network/task-execution-launchers": "portal:../backend-local/launchers",
    "@jinn-network/task-execution-profiles": "portal:../profiles",
    "@jinn-network/task-execution-protocol": "portal:../protocol",
    "@jinn-network/task-execution-supervisor": "portal:../backend-local/supervisor",
    "@jinn-network/task-execution-workspace": "portal:../backend-local/workspace"
  }
}
```

Note: `prepack` is deliberately absent — `pack-smoke.mjs` builds explicitly, and the packed-types guard packs with `--ignore-scripts`. `./testing` is added to `exports` and `files` in Task 2.

- [ ] **Step 4: Create the compiler config, README, and an empty entrypoint**

`packages/task-execution/evaluator-adapters/tsconfig.json` (identical to the evaluation harness's):

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
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`packages/task-execution/evaluator-adapters/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/task-execution/evaluator-adapters/README.md`:

```markdown
# `@jinn-network/task-execution-evaluator-adapters`

Concrete evaluator adapters for the Jinn Task Execution Protocol evaluation harness: the
swe-rebench deterministic-process adapter and the binary-prediction-market adapter, plus the
ingestion-format parsers they share.

Parsers ingest at the adapter edge only. JUnit XML, TAP14, and benchmark-local JSON are read as
untrusted input and reduced to declared measurements; the verdict record itself stays in the
sealed-record grammar owned by the harness and Attestation Issuer. This package defines no
verdict semantics.

Each adapter derives its verdict by evaluating the EvaluationSpec's own `verdictRule` over the
measurements it computed, so the harness's verdict-consistency gate and the adapter can never
disagree. Measurements the spec does not declare are dropped before delivery.

The package performs no network access, holds no key material, and never reads the Attempt's
`secrets/` directory. An infrastructure abort raises `EvaluationOperationalError` — the typed
no-verdict path — instead of delivering a false `fail`.
```

`packages/task-execution/evaluator-adapters/src/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export {};
```

- [ ] **Step 5: Install and verify the inventory guard passes**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn install && yarn typecheck && yarn build
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071" && node --test .github/scripts/task-execution-package-inventory.test.mjs
```
Expected: install writes `yarn.lock`; typecheck and build clean; the inventory guard PASSES.

- [ ] **Step 6: Extend the source-boundary guard**

In `.github/scripts/task-execution-source-boundaries.test.mjs`:

Add the directory to the locale sweep list:

```js
const taskExecutionDirectories = [
  'protocol', 'backend', 'testing', 'profiles',
  'backend-local/supervisor', 'backend-local/workspace', 'backend-local/launchers', 'backend-local/assembly',
  'evaluation-harness', 'evaluator-adapters',
];
```

Append `'@jinn-network/task-execution-evaluator-adapters'` to each of these existing arrays: `TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_BACKEND`, `TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_PROFILES`, `SUPERVISOR_FORBIDDEN`, `WORKSPACE_FORBIDDEN`, `LAUNCHERS_FORBIDDEN`, `ASSEMBLY_FORBIDDEN`, and `EVALUATION_HARNESS_PRODUCTION_FORBIDDEN`. Also append it to `EVALUATION_HARNESS_TEST_FORBIDDEN` by changing its definition to:

```js
const EVALUATION_HARNESS_TEST_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES
    .filter((name) => !EVALUATION_HARNESS_TEST_ALLOWED_EVIDENCE.includes(name)),
  '@jinn-network/task-execution-evaluator-adapters',
];
```

Add the new tree's own lists after `EVALUATION_HARNESS_TEST_FORBIDDEN`:

```js
// evaluator-adapters (composition design §6.3): parse-only. PRODUCTION imports the evaluation
// harness contract surface and profiles only — never the backend, never the backend-local
// components, never evidence/trust/discovery, never a process spawn, never a socket. Its tests
// may additionally reach the Evidence Protocol validators and the protocol's sealing helpers to
// drive one real end-to-end harness run.
const EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-workspace',
  'node:child_process',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
];
const EVALUATOR_ADAPTERS_TEST_ALLOWED = [
  '@jinn-network/attestation-issuer',
  '@jinn-network/evidence-protocol',
];
const EVALUATOR_ADAPTERS_TEST_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES.filter((name) => !EVALUATOR_ADAPTERS_TEST_ALLOWED.includes(name)),
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-testing',
];
```

Inside `test('task-execution source boundaries remain one-way across the approved graph', ...)`, after the evaluation-harness assertions, add:

```js
  // evaluator-adapters: parse-only at the adapter edge. Production source additionally must not
  // reach the network — "parsers ingest, never fetch" (composition design §6.3/§7 ruling 5).
  const adaptersSrc = join(packages, 'evaluator-adapters', 'src');
  const adaptersTests = files(adaptersSrc)
    .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file));
  const adaptersProduction = files(adaptersSrc)
    .filter((file) => !adaptersTests.includes(file));
  assert.deepEqual(
    forbiddenImportsInFiles(adaptersProduction, EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN),
    [],
    'evaluator-adapters production source crosses its approved contract boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(adaptersTests, EVALUATOR_ADAPTERS_TEST_FORBIDDEN),
    [],
    'evaluator-adapters tests may import only the approved evidence validators',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles(adaptersProduction),
    [],
    'evaluator-adapters production source must never reach the network; grader output is '
      + 'ingested from provisioned material, never fetched',
  );
```

Add the new tree to the cross-tree consumption test's loop so nothing there imports backend-local components. In `test('cross-tree consumption: only assembly, the testing kit slice, and the evaluation harness may import backend-local components (program §7.18)', ...)` change the first loop:

```js
  for (const directory of ['protocol', 'backend', 'profiles', 'evaluator-adapters']) {
    assertBoundary(join(packages, directory, 'src'), BACKEND_LOCAL_COMPONENT_PACKAGES);
  }
```

- [ ] **Step 7: Run the source-boundary guard**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071" && node --test .github/scripts/task-execution-source-boundaries.test.mjs`
Expected: PASS (the empty `src/index.ts` imports nothing).

- [ ] **Step 8: Extend the packed-types guard**

In `.github/scripts/task-execution-packed-types.test.mjs`, add to `packages`:

```js
  [join(taskExecutionRoot, 'evaluator-adapters'), '@jinn-network/task-execution-evaluator-adapters'],
```

and to `codeEntrypoints`:

```js
  '@jinn-network/task-execution-evaluator-adapters',
```

- [ ] **Step 9: Add the CI job**

In `.github/workflows/task-execution-ci.yml`:

Add `evaluator-adapters` to the `workflow_dispatch` scope options list (between `evaluation-harness` and `full`).

Add a new job after `evaluation-harness`:

```yaml
  evaluator-adapters:
    needs: [foundation, backend, profiles, supervisor, workspace, launchers, backend-local, evaluation-harness]
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
      - name: Restore all Task Execution distributions
        uses: actions/download-artifact@v4
        with:
          pattern: task-execution-*-dist
          path: .task-execution-dist
      - name: Place Task Execution distributions
        run: |
          for package in protocol backend profiles; do
            mkdir -p "packages/task-execution/${package}/dist"
            cp -R ".task-execution-dist/task-execution-${package}-dist/." "packages/task-execution/${package}/dist/"
          done
          for package in supervisor workspace launchers; do
            mkdir -p "packages/task-execution/backend-local/${package}/dist"
            cp -R ".task-execution-dist/task-execution-${package}-dist/." "packages/task-execution/backend-local/${package}/dist/"
          done
          mkdir -p packages/task-execution/backend-local/assembly/dist
          cp -R ".task-execution-dist/task-execution-backend-local-dist/." packages/task-execution/backend-local/assembly/dist/
          mkdir -p packages/task-execution/evaluation-harness/dist
          cp -R ".task-execution-dist/task-execution-evaluation-harness-dist/." packages/task-execution/evaluation-harness/dist/
      - name: Install packed-smoke dependency toolchains
        run: |
          (cd packages/task-execution/protocol && yarn install --immutable)
          (cd packages/task-execution/profiles && yarn install --immutable)
          (cd packages/task-execution/backend-local/supervisor && yarn install --immutable)
          (cd packages/task-execution/backend-local/workspace && yarn install --immutable)
          (cd packages/task-execution/backend-local/launchers && yarn install --immutable)
          (cd packages/task-execution/evaluation-harness && yarn install --immutable)
      - name: Build evidence contract packages from source
        run: |
          (cd packages/evidence/protocol && yarn install --immutable && yarn build)
          (cd packages/evidence/attestation-issuer && yarn install --immutable && yarn build)
      - name: Verify Task Execution Evaluator Adapters
        working-directory: packages/task-execution/evaluator-adapters
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
      - name: Upload Task Execution Evaluator Adapters distribution
        uses: actions/upload-artifact@v4
        with:
          name: task-execution-evaluator-adapters-dist
          path: packages/task-execution/evaluator-adapters/dist
          if-no-files-found: error
          retention-days: 1
```

In the `verify` job: add `evaluator-adapters` to `needs`, add `EVALUATOR_ADAPTERS_RESULT: ${{ needs.evaluator-adapters.result }}` to `env`, add `"$EVALUATOR_ADAPTERS_RESULT" \` to the `for result in` list, and append to the "Place package distributions" step:

```bash
          mkdir -p packages/task-execution/evaluator-adapters/dist
          cp -R ".task-execution-dist/task-execution-evaluator-adapters-dist/." packages/task-execution/evaluator-adapters/dist/
```

- [ ] **Step 10: Create the pack-smoke script**

`packages/task-execution/evaluator-adapters/scripts/pack-smoke.mjs`:

```js
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const taskExecutionRoot = resolve(packageRoot, "..");
const evidenceRoot = resolve(taskExecutionRoot, "..", "evidence");

const packageInputs = [
  [join(evidenceRoot, "protocol"), "@jinn-network/evidence-protocol"],
  [join(evidenceRoot, "repository"), "@jinn-network/evidence-repository"],
  [join(evidenceRoot, "attestation-issuer"), "@jinn-network/attestation-issuer"],
  [join(taskExecutionRoot, "protocol"), "@jinn-network/task-execution-protocol"],
  [join(taskExecutionRoot, "backend"), "@jinn-network/task-execution-backend"],
  [join(taskExecutionRoot, "profiles"), "@jinn-network/task-execution-profiles"],
  [join(taskExecutionRoot, "backend-local", "supervisor"), "@jinn-network/task-execution-supervisor"],
  [join(taskExecutionRoot, "backend-local", "workspace"), "@jinn-network/task-execution-workspace"],
  [join(taskExecutionRoot, "backend-local", "launchers"), "@jinn-network/task-execution-launchers"],
  [join(taskExecutionRoot, "evaluation-harness"), "@jinn-network/task-execution-evaluation-harness"],
  [packageRoot, "@jinn-network/task-execution-evaluator-adapters"],
];

const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evaluator-adapters-"));
const archivesRoot = join(temporaryRoot, "archives");
const consumerRoot = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

try {
  await run("yarn", ["build"], { cwd: packageRoot });
  await mkdir(archivesRoot, { recursive: true });
  const archives = new Map();
  for (const [root, name] of packageInputs) {
    const archive = join(archivesRoot, `${name.slice("@jinn-network/".length)}.tgz`);
    await run("yarn", ["pack", "--out", archive], { cwd: root });
    archives.set(name, archive);
  }

  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...Object.fromEntries([...archives].map(([name, archive]) => [name, `file:${archive}`])),
        "@types/node": "^22.0.0",
        typescript: "5.9.3",
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerRoot });

  const installedRoot = join(
    consumerRoot, "node_modules", "@jinn-network", "task-execution-evaluator-adapters",
  );
  const smokeScript = join(consumerRoot, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
const adapters = await import("@jinn-network/task-execution-evaluator-adapters");
for (const name of [
  "createEvaluatorDeployment",
  "createSweRebenchRegistration",
  "createPredictionRegistration",
  "parserAllowlistEntries",
]) {
  if (typeof adapters[name] !== "function") {
    throw new Error("missing public export: " + name);
  }
}
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const actual = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expected = ${JSON.stringify([
      "@jinn-network/task-execution-evaluation-harness",
      "@jinn-network/task-execution-profiles",
    ])};
if (actual.join(",") !== expected.join(",")) {
  throw new Error("unexpected Jinn dependency boundary: " + actual.join(", "));
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) {
  throw new Error("test output leaked into dist");
}
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed evaluator-adapters surface and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumerRoot });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

The smoke script asserts exports that do not exist yet — it becomes green at Task 9. That is intentional: `pack:smoke` runs in CI only, and CI first runs it in the PR that lands Task 9's train head. If the PR train is split so that Task 1 lands alone, temporarily reduce the export list in the smoke script to `[]` and restore it in Task 9; note the restoration in Task 9's commit.

- [ ] **Step 11: Run all three guards**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071"
node --test .github/scripts/task-execution-package-inventory.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
node .github/scripts/task-execution-packed-types.test.mjs
```
Expected: all three PASS. The packed-types run ends with `Compiled a packed TypeScript consumer against 13 public code entrypoints across all task-execution packages.`

- [ ] **Step 12: Commit**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071"
git add packages/task-execution/evaluator-adapters .github/scripts .github/workflows/task-execution-ci.yml
git commit -m "feat(task-execution): scaffold evaluator-adapters with the guard trio and CI job"
```

---

### Task 2: Conformance kit and the full fixture corpus

Kit-first, per the program's Global constraints. Everything after this task is driven by fixtures that already exist.

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/testing.ts`
- Create: `packages/task-execution/evaluator-adapters/src/testing.test.ts`
- Create: `packages/task-execution/evaluator-adapters/fixtures/README.md`
- Create: `packages/task-execution/evaluator-adapters/fixtures/{pytest-json-report,junit-xml,tap14,swe-rebench-adapter,prediction-adapter,parser-declarations}/{golden,adversarial}/*.json`
- Modify: `packages/task-execution/evaluator-adapters/package.json` (add `./testing` export + `fixtures/` to `files`)
- Modify: `.github/scripts/task-execution-packed-types.test.mjs` (add the `./testing` entrypoint)

**Interfaces:**
- Consumes: the package scaffold from Task 1.
- Produces:
  - `FIXTURE_FAMILIES: string[]`
  - `interface FixtureCase { name: string; kind: "golden" | "adversarial"; input: unknown; expect: unknown }`
  - `loadFixtureFamily(family: string): Promise<FixtureCase[]>`
  - `buildSweRebenchEvaluationSpec(overrides?: { parserId?: string }): EvaluationSpec`
  - `buildPredictionEvaluationSpec(): EvaluationSpec`

- [ ] **Step 1: Write the failing kit test**

`packages/task-execution/evaluator-adapters/src/testing.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseEvaluationSpec, sealEvaluationSpec } from "@jinn-network/task-execution-profiles";
import {
  buildPredictionEvaluationSpec,
  buildSweRebenchEvaluationSpec,
  FIXTURE_FAMILIES,
  loadFixtureFamily,
} from "./testing.js";

describe("evaluator-adapters conformance kit", () => {
  it("loads every declared fixture family with at least one golden case", async () => {
    expect(FIXTURE_FAMILIES.length).toBeGreaterThan(0);
    for (const family of FIXTURE_FAMILIES) {
      const cases = await loadFixtureFamily(family);
      expect(cases.length, `${family} has no cases`).toBeGreaterThan(0);
      expect(
        cases.some((fixtureCase) => fixtureCase.kind === "golden"),
        `${family} has no golden case`,
      ).toBe(true);
      for (const fixtureCase of cases) {
        expect(typeof fixtureCase.name).toBe("string");
        expect(Object.hasOwn(fixtureCase, "input")).toBe(true);
        expect(Object.hasOwn(fixtureCase, "expect")).toBe(true);
      }
    }
  });

  it("builds spec fixtures that survive the profiles parser and seal deterministically", () => {
    for (const spec of [buildSweRebenchEvaluationSpec(), buildPredictionEvaluationSpec()]) {
      const sealed = sealEvaluationSpec(spec);
      expect(parseEvaluationSpec(sealed.bytes)).toBeDefined();
      expect(sealEvaluationSpec(spec).digest).toBe(sealed.digest);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test`
Expected: FAIL — `Cannot find module './testing.js'`

- [ ] **Step 3: Write the kit**

`packages/task-execution/evaluator-adapters/src/testing.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Conformance-kit backbone. Mirrors the profiles kit (`@jinn-network/task-execution-profiles/testing`):
// a pure fixture loader plus the spec builders the fixtures are written against. No vitest import —
// these are plain functions a consumer calls from any test framework.

import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";

/** Every fixture family this package ships under `fixtures/*`, sorted by UTF-16 code unit. */
export const FIXTURE_FAMILIES: string[] = [
  "junit-xml",
  "parser-declarations",
  "prediction-adapter",
  "pytest-json-report",
  "swe-rebench-adapter",
  "tap14",
];

export type FixtureKind = "golden" | "adversarial";

export interface FixtureCase {
  name: string;
  kind: FixtureKind;
  input: unknown;
  expect: unknown;
}

const FIXTURE_KINDS: readonly FixtureKind[] = ["golden", "adversarial"];

function fixtureUrl(family: string, kind: FixtureKind): URL {
  return new URL(`../fixtures/${family}/${kind}/`, import.meta.url);
}

/**
 * Loads one fixture family. Each `*.json` file is `{ input, expect }`; the case name is the file
 * stem and the kind is its directory. Ordering is by code unit so a run is reproducible.
 */
export async function loadFixtureFamily(family: string): Promise<FixtureCase[]> {
  if (!FIXTURE_FAMILIES.includes(family)) {
    throw new TypeError(`unknown fixture family: ${family}`);
  }
  const cases: FixtureCase[] = [];
  for (const kind of FIXTURE_KINDS) {
    const directory = fixtureUrl(family, kind);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const document = JSON.parse(
        await readFile(new URL(entry, directory), "utf8"),
      ) as { input: unknown; expect: unknown };
      cases.push({
        name: basename(entry, ".json"),
        kind,
        input: document.input,
        expect: document.expect,
      });
    }
  }
  return cases.sort((left, right) =>
    left.kind < right.kind ? -1
      : left.kind > right.kind ? 1
      : left.name < right.name ? -1
      : left.name > right.name ? 1
      : 0
  );
}

const SCORER_DIGEST_PLACEHOLDER = "a".repeat(64);

/**
 * The swe-rebench EvaluationSpec shape — byte-identical in structure to what
 * `sweRebenchRowToTaskAndSpec` produces in profiles, so an adapter that satisfies this fixture
 * satisfies a real mined row. `parserId` selects which ingestion format the row commits to.
 */
export function buildSweRebenchEvaluationSpec(
  overrides: { parserId?: string; parserDigest?: `sha256:${string}` } = {},
): EvaluationSpec {
  const parserId = overrides.parserId ?? "jinn.parser.pytest-json-report";
  const parserDigest = overrides.parserDigest ?? `sha256:${"b".repeat(64)}`;
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: parserId,
      digest: { sha256: parserDigest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "grader-image", digest: { sha256: SCORER_DIGEST_PLACEHOLDER } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [],
      parser: { id: parserId, version: "1.0.0", digest: parserDigest },
      transitions: {
        failToPass: ["test_pool.py::test_retry_releases_connection"],
        passToPass: ["test_pool.py::test_basic_get"],
      },
      timeout: 1800,
    },
    measurements: [{ name: "passed", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
    unscorable: [{ name: "environment-setup-failure", disposition: "retryable-infrastructure" }],
    evidenceConventions: { requiredRefs: [] },
  };
}

/**
 * The binary-prediction-market EvaluationSpec. Design finding 3: the frozen grader-family
 * taxonomy has no pure-parse family, so this fixture authors the scorer as a
 * `deterministic-process` whose `image` carries the scorer's own declaration digest — an honest
 * content commitment rather than a fabricated container reference. The builder lives in the kit,
 * not production, so nothing shipped depends on that nominal field.
 */
export function buildPredictionEvaluationSpec(): EvaluationSpec {
  const parserDigest = `sha256:${"c".repeat(64)}` as const;
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: "jinn.parser.prediction-market-v1",
      digest: { sha256: parserDigest.slice("sha256:".length) },
      accessClass: "public",
    },
    familyBlock: {
      image: { name: "jinn.parser.prediction-market-v1", digest: { sha256: parserDigest.slice("sha256:".length) } },
      platform: "any",
      workspace: {},
      testMaterial: [],
      parser: { id: "jinn.parser.prediction-market-v1", version: "1.0.0", digest: parserDigest },
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: [
      { name: "identityMatched", type: "boolean", required: true },
      { name: "withinWindow", type: "boolean", required: true },
      { name: "resolved", type: "boolean", required: true },
      { name: "solverBrier", type: "string", required: false },
      { name: "consensusBrier", type: "string", required: false },
      { name: "brierSpread", type: "string", direction: "lower-better", required: false },
    ],
    verdictRule: {
      all: [
        { threshold: { measurement: "identityMatched", op: "eq", value: true } },
        { threshold: { measurement: "withinWindow", op: "eq", value: true } },
        {
          inconclusiveWhen: { threshold: { measurement: "resolved", op: "eq", value: false } },
          class: "market-unresolved",
        },
        { threshold: { measurement: "brierSpread", op: "lt", value: "0" } },
      ],
    },
    unscorable: [{ name: "market-unresolved", disposition: "recorded-inconclusive" }],
    evidenceConventions: { requiredRefs: [] },
  };
}
```

- [ ] **Step 4: Write the fixture corpus**

`fixtures/README.md`:

```markdown
# Evaluator-adapter fixtures

Each `*.json` is one conformance case: `{ "input": …, "expect": … }`. The file stem is the case
name; the directory (`golden` / `adversarial`) is the case kind.

The `pytest-json-report`, `swe-rebench-adapter`, and `prediction-adapter` families carry the
behavior of the retired `client/src/harnesses/impls/**` evaluators as *test cases*, never as
ported code (composition program §6 contract 12). Where the fresh implementation deliberately
diverges from legacy, the case name says so and the file carries a `note` field.
```

**Family `pytest-json-report`** — `input` is `{ report, transitions, stdout }` where `report` is the upstream `report.json` document, `transitions` is `{ failToPass, passToPass }`, and `stdout` is the captured container output; `expect` is either `{ "outcome": { passed, failToPassPassed, passToPassBroken, noTestPassed } }` or `{ "operational": { reason } }`.

Write these eleven files (`golden/`):

- `resolved.json` — items `[{ instance_id: "i", from_fail_to_pass: ["test_pool.py::test_retry_releases_connection"], failed_from_pass_to_pass: [], passed_match: true, exit_code: 0 }]`; expect `outcome.passed === true`, `noTestPassed === false`.
- `rederived-pass-despite-upstream-mismatch.json` — `from_fail_to_pass: ["test_pool.py::test_retry_releases_connection"]`, `failed_from_pass_to_pass: []`, `passed_match: false`, `exit_code: 1`; expect `outcome.passed === true`. `note`: "upstream `passed_match` is an exact-set comparison and is deliberately ignored; SWE-bench `resolved` semantics are re-derived."
- `genuine-wrong-answer.json` — `from_fail_to_pass: []`, `failed_from_pass_to_pass: []`, `exit_code: 1`, stdout a plain pytest summary; expect `outcome.passed === false`, no operational failure.
- `partial-fail-to-pass.json` — two `failToPass` ids, one in `from_fail_to_pass`; expect `passed === false`.
- `broken-pass-to-pass.json` — all `failToPass` passing but `failed_from_pass_to_pass: ["test_pool.py::test_basic_get"]`; expect `passed === false`.
- `infrastructure-signature-with-a-real-pass.json` — stdout contains `Cannot connect to the Docker daemon`, but `from_fail_to_pass` is non-empty; expect `outcome.passed === true`. `note`: "the infrastructure gate requires that nothing expected passed; a partially-passing run is a real result."
- `missing-pass-to-pass-id-is-not-broken.json` — a `passToPass` id absent from both report lists; expect `passToPassBroken` empty. `note`: "only explicitly failed PASS_TO_PASS ids count as broken, matching legacy `failed_from_pass_to_pass` semantics."
- `empirical-mode.json` — `transitions` both empty; report carries `passed_actual: ["a","b"]`, `failed_actual: []`, `exit_code: 0`; expect `passed === true` and the passed set equal to `passed_actual`.
- `log-tail-capped.json` — `stdout` is a 1 100 000-character string of `"x"`; expect `{ "log": { "startsWith": "[... 51648 characters truncated ...]\n", "length": 1048576 } }`. Compute the exact numbers when writing the file by running the implementation once, then pin them.

And these six (`adversarial/`):

- `setup-error.json` — item `{ instance_id: "i", from_fail_to_pass: [], failed_from_pass_to_pass: ["test_pool.py::test_basic_get"], error: "Task i missing top-level image_name." }`; expect `{ operational: { reason: "eval_setup_error" } }`.
- `missing-exit-code.json` — item without `exit_code` and without `error`; expect `{ operational: { reason: "eval_report_malformed" } }`.
- `no-items.json` — `{ items: [] }`; expect `{ operational: { reason: "eval_report_malformed" } }`.
- `docker-unavailable.json` — `exit_code: 125`, every `passToPass` id in `failed_from_pass_to_pass`, stdout `Cannot connect to the Docker daemon at unix:///var/run/docker.sock.`; expect `{ operational: { reason: "docker_unavailable" } }`.
- `docker-credentials-error.json` — `exit_code: 1`, all PASS_TO_PASS broken, stdout `error getting credentials - err: exit status 1`; expect `{ operational: { reason: "docker_credentials_error" } }`. `note`: "the 2026-07-07 evaluator outage: this shape previously delivered a false `fail`."
- `patch-corrupt.json` — `exit_code: 1`, all PASS_TO_PASS broken, stdout `Checking patch src/foo.py...\nerror: corrupt patch at line 30`; expect `{ operational: { reason: "patch_corrupt" } }`.

**Family `junit-xml`** — `input` is `{ xml }`; `expect` is `{ report: { passed, failed, skipped } }` or `{ error: "invalid-report" }`.
- `golden/single-suite.json` — one `<testsuite>` with three `<testcase classname="test_pool" name="test_basic_get"/>`, one carrying `<failure/>`, one `<skipped/>`; expect ids `test_pool.py::test_basic_get`-style composition `classname::name`.
- `golden/nested-suites.json` — `<testsuites>` wrapping two `<testsuite>`; both contribute.
- `golden/error-counts-as-failed.json` — a `<testcase>` with `<error/>`.
- `golden/self-closing-and-empty-suite.json` — a suite with no cases; expect all three arrays empty.
- `adversarial/doctype-entity.json` — XML containing `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`; expect `{ error: "invalid-report" }`.
- `adversarial/unterminated-tag.json` — truncated XML; expect `{ error: "invalid-report" }`.

**Family `tap14`** — `input` is `{ text }`; same `expect` shape.
- `golden/plan-and-results.json` — `TAP version 14\n1..3\nok 1 - alpha\nnot ok 2 - beta\nok 3 - gamma # SKIP not applicable\n`; expect `passed: ["alpha","gamma"]`? No — SKIP goes to `skipped`, so `passed: ["alpha"]`, `failed: ["beta"]`, `skipped: ["gamma"]`.
- `golden/todo-directive.json` — `not ok 1 - delta # TODO known bug`; expect `skipped: ["delta"]`, nothing failed. `note`: "a TODO-directive failure is not a real failure per TAP14."
- `golden/no-description.json` — `ok 1` with no description; expect the id `1`.
- `adversarial/plan-count-mismatch.json` — `1..3` with two results; expect `{ error: "invalid-report" }`.
- `adversarial/missing-version.json` — no `TAP version 14` line; expect `{ error: "invalid-report" }`.

**Family `swe-rebench-adapter`** — `input` is `{ report, stdout }`, `expect` is `{ verdict, measurements }` or `{ operational: { reason, canonicalCode, recoveryAdvice } }`. Four cases: `golden/pass.json`, `golden/fail.json`, `adversarial/setup-error.json`, `adversarial/undeclared-measurements-dropped.json` (report also produces counts the spec does not declare; `expect.measurements` contains only `passed`).

**Family `prediction-adapter`** — `input` is `{ taskPayload, solution, outcome }`, `expect` is `{ verdict, measurements, limitations? }`. Six cases:
- `golden/beats-consensus.json` — solver `probabilityYes: "0.9"`, consensus `"0.6"`, outcome `YES`; expect `verdict: "pass"`, `solverBrier: "0.010000"`, `consensusBrier: "0.160000"`, `brierSpread: "-0.150000"`.
- `golden/loses-to-consensus.json` — solver `"0.2"`, consensus `"0.6"`, outcome `YES`; expect `verdict: "fail"`, `brierSpread: "0.480000"`.
- `golden/unresolved-market.json` — outcome `{ status: "unresolved" }`; expect `verdict: "inconclusive"`, `limitations: ["market-unresolved"]`, no Brier measurements.
- `adversarial/condition-id-case-differs.json` — outcome `conditionId` differs only in hexadecimal letter case; expect `identityMatched: true`. `note`: "conditionId matches case-insensitively; marketId matches exactly."
- `adversarial/market-id-differs.json` — expect `verdict: "fail"`, `identityMatched: false`.
- `adversarial/submitted-outside-window.json` — `submittedAt` one second after `window.endTs`; expect `verdict: "fail"`, `withinWindow: false`.

**Family `parser-declarations`** — one golden per parser: `input` is `{ id }`, `expect` is `{ allowlistKey }`. The four keys are generated by Task 3's script, not hand-written; create the four files with `expect: { "allowlistKey": "" }` now and let Task 3's `yarn generate:parsers` fill them.

- [ ] **Step 5: Add the `./testing` export and fixture packaging**

In `packages/task-execution/evaluator-adapters/package.json`, add to `exports`:

```json
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    },
    "./fixtures/*": "./fixtures/*"
```

and add `"fixtures/"` to `files` (after `"dist/"`).

In `.github/scripts/task-execution-packed-types.test.mjs`, add to `codeEntrypoints`:

```js
  '@jinn-network/task-execution-evaluator-adapters/testing',
```

- [ ] **Step 6: Run the kit test**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test && yarn typecheck && yarn build`
Expected: PASS. Then from the repo root: `node .github/scripts/task-execution-packed-types.test.mjs` — PASS with 14 entrypoints.

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/evaluator-adapters .github/scripts/task-execution-packed-types.test.mjs
git commit -m "test(task-execution): add the evaluator-adapters conformance kit and fixture corpus"
```

---

### Task 3: Parser declarations and allowlist keys

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/declarations.ts`
- Create: `packages/task-execution/evaluator-adapters/src/declarations.test.ts`
- Create: `packages/task-execution/evaluator-adapters/scripts/seal-parser-declarations.mjs`
- Modify: `packages/task-execution/evaluator-adapters/package.json` (add `generate:parsers` / `check:parsers` scripts)
- Modify: `packages/task-execution/evaluator-adapters/fixtures/parser-declarations/golden/*.json`

**Interfaces:**
- Consumes: `loadFixtureFamily` from Task 2.
- Produces:
  - `type ParserFormat = "benchmark-json" | "junit-xml" | "tap14"`
  - `interface ParserDeclaration { readonly id: string; readonly version: string; readonly format: ParserFormat; readonly materialName: string }`
  - `PARSER_DECLARATIONS: readonly ParserDeclaration[]` — ids `jinn.parser.pytest-json-report`, `jinn.parser.junit-xml`, `jinn.parser.tap14`, `jinn.parser.prediction-market-v1`
  - `parserIdentity(id: string): ParserIdentity` (throws `TypeError` for an unknown id)
  - `parserDeclaration(id: string): ParserDeclaration`
  - `parserAllowlistEntries(): ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

`packages/task-execution/evaluator-adapters/src/declarations.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parserAllowlistKey } from "@jinn-network/task-execution-profiles";
import { loadFixtureFamily } from "./testing.js";
import {
  PARSER_DECLARATIONS,
  parserAllowlistEntries,
  parserIdentity,
} from "./declarations.js";

describe("parser declarations", () => {
  it("commits every parser to a sealed identity digest", () => {
    for (const declaration of PARSER_DECLARATIONS) {
      const identity = parserIdentity(declaration.id);
      expect(identity.id).toBe(declaration.id);
      expect(identity.version).toBe(declaration.version);
      expect(identity.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("produces an allowlist that is exactly the declared parser keys", () => {
    const entries = parserAllowlistEntries();
    expect(entries.size).toBe(PARSER_DECLARATIONS.length);
    for (const declaration of PARSER_DECLARATIONS) {
      expect(entries.has(parserAllowlistKey(parserIdentity(declaration.id)))).toBe(true);
    }
  });

  it("matches the pinned fixture keys", async () => {
    for (const fixtureCase of await loadFixtureFamily("parser-declarations")) {
      const { id } = fixtureCase.input as { id: string };
      const { allowlistKey } = fixtureCase.expect as { allowlistKey: string };
      expect(parserAllowlistKey(parserIdentity(id))).toBe(allowlistKey);
    }
  });

  it("rejects an unknown parser id rather than inventing an identity", () => {
    expect(() => parserIdentity("jinn.parser.unknown")).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/declarations.test.ts`
Expected: FAIL — `Cannot find module './declarations.js'`

- [ ] **Step 3: Write the declarations module**

`packages/task-execution/evaluator-adapters/src/declarations.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  parserAllowlistKey,
  sealDocument,
  type ParserIdentity,
} from "@jinn-network/task-execution-profiles";

/** Ingestion formats parsed at the adapter edge (composition design §7 ruling 5). */
export type ParserFormat = "benchmark-json" | "junit-xml" | "tap14";

export interface ParserDeclaration {
  /** Reverse-DNS parser id, exactly as it appears in a sealed EvaluationSpec's family block. */
  readonly id: string;
  readonly version: string;
  readonly format: ParserFormat;
  /** The material filename this parser reads from the provisioned Attempt input. */
  readonly materialName: string;
  /** Measurement names this parser can contribute; the adapter drops undeclared ones. */
  readonly measurements: readonly string[];
}

/**
 * The deployment's parser inventory, sorted by id (code unit). A parser's semantic commitment is
 * its digest, never inline source (profiles family-blocks.ts): the digest below is the sealed
 * digest of the declaration document itself, so changing a parser's format, material name, or
 * measurement contract changes its identity and takes it out of every existing allowlist.
 */
export const PARSER_DECLARATIONS: readonly ParserDeclaration[] = Object.freeze([
  Object.freeze({
    id: "jinn.parser.junit-xml",
    version: "1.0.0",
    format: "junit-xml",
    materialName: "junit.xml",
    measurements: Object.freeze(["passed"]),
  }),
  Object.freeze({
    id: "jinn.parser.prediction-market-v1",
    version: "1.0.0",
    format: "benchmark-json",
    materialName: "prediction-outcome.json",
    measurements: Object.freeze([
      "identityMatched",
      "withinWindow",
      "resolved",
      "solverBrier",
      "consensusBrier",
      "brierSpread",
    ]),
  }),
  Object.freeze({
    id: "jinn.parser.pytest-json-report",
    version: "1.0.0",
    format: "benchmark-json",
    materialName: "evaluation-report.json",
    measurements: Object.freeze(["passed"]),
  }),
  Object.freeze({
    id: "jinn.parser.tap14",
    version: "1.0.0",
    format: "tap14",
    materialName: "results.tap",
    measurements: Object.freeze(["passed"]),
  }),
] as const);

export const PARSER_DECLARATION_FORMAT_URI =
  "https://jinn.network/profiles/evaluator-parser-declaration/1.0" as const;

const byId = new Map(PARSER_DECLARATIONS.map((declaration) => [declaration.id, declaration]));

export function parserDeclaration(id: string): ParserDeclaration {
  const declaration = byId.get(id);
  if (declaration === undefined) {
    throw new TypeError(`unknown parser declaration: ${id}`);
  }
  return declaration;
}

/** The canonical declaration document whose sealed digest is the parser's identity digest. */
export function parserDeclarationDocument(id: string): Record<string, unknown> {
  const declaration = parserDeclaration(id);
  return {
    protocol: PARSER_DECLARATION_FORMAT_URI,
    id: declaration.id,
    version: declaration.version,
    format: declaration.format,
    materialName: declaration.materialName,
    measurements: [...declaration.measurements],
  };
}

export function parserIdentity(id: string): ParserIdentity {
  const declaration = parserDeclaration(id);
  return {
    id: declaration.id,
    version: declaration.version,
    digest: sealDocument(parserDeclarationDocument(id)).digest,
  };
}

/** The deployment allowlist the evaluation harness enforces for deterministic-process specs. */
export function parserAllowlistEntries(): ReadonlySet<string> {
  return new Set(
    PARSER_DECLARATIONS.map((declaration) => parserAllowlistKey(parserIdentity(declaration.id))),
  );
}
```

- [ ] **Step 4: Write the pin script and fill the fixtures**

`packages/task-execution/evaluator-adapters/scripts/seal-parser-declarations.mjs`:

```js
// Writes (or checks) the pinned parser allowlist keys in fixtures/parser-declarations/golden/.
// Run `yarn generate:parsers` after any declaration change; `yarn check:parsers` fails CI when
// the pinned keys drift from the code.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenRoot = join(packageRoot, "fixtures", "parser-declarations", "golden");
const { PARSER_DECLARATIONS, parserIdentity } = await import(
  join(packageRoot, "dist", "declarations.js")
);
const { parserAllowlistKey } = await import("@jinn-network/task-execution-profiles");

const check = process.argv.includes("--check");
let drift = 0;

for (const declaration of PARSER_DECLARATIONS) {
  const file = join(goldenRoot, `${declaration.id.replaceAll(".", "-")}.json`);
  const allowlistKey = parserAllowlistKey(parserIdentity(declaration.id));
  const document = { input: { id: declaration.id }, expect: { allowlistKey } };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (check) {
    const current = await readFile(file, "utf8");
    if (current !== serialized) {
      drift += 1;
      console.error(`pinned parser key drifted: ${declaration.id}`);
    }
  } else {
    await writeFile(file, serialized);
    console.log(`pinned ${declaration.id} -> ${allowlistKey}`);
  }
}

if (check && drift > 0) process.exit(1);
```

Add to `package.json` scripts:

```json
    "generate:parsers": "yarn build && node scripts/seal-parser-declarations.mjs",
    "check:parsers": "yarn build && node scripts/seal-parser-declarations.mjs --check",
```

Run `yarn generate:parsers` to fill the four fixture files (this replaces the empty `allowlistKey` stubs from Task 2).

- [ ] **Step 5: Run the tests**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters"
yarn test src/declarations.test.ts && yarn check:parsers && yarn typecheck
```
Expected: PASS on all three.

- [ ] **Step 6: Add `check:parsers` to CI**

In `.github/workflows/task-execution-ci.yml`, in the `evaluator-adapters` job's "Verify Task Execution Evaluator Adapters" step, insert `yarn check:parsers` between `yarn test` and `yarn build`.

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/evaluator-adapters .github/workflows/task-execution-ci.yml
git commit -m "feat(task-execution): pin evaluator parser declarations and the deployment allowlist"
```

---

### Task 4: The report model and the benchmark-local JSON parser

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/report.ts`
- Create: `packages/task-execution/evaluator-adapters/src/parsers/pytest-json-report.ts`
- Create: `packages/task-execution/evaluator-adapters/src/parsers/pytest-json-report.test.ts`

**Interfaces:**
- Consumes: `loadFixtureFamily` (Task 2).
- Produces:
  - `interface TestOutcomeReport { readonly passed: readonly string[]; readonly failed: readonly string[]; readonly skipped: readonly string[]; readonly exitCode?: number; readonly log: string; readonly setupError?: string }`
  - `interface Transitions { readonly failToPass: readonly string[]; readonly passToPass: readonly string[] }`
  - `interface TransitionOutcome { readonly passed: boolean; readonly failToPassPassed: readonly string[]; readonly passToPassBroken: readonly string[]; readonly noTestPassed: boolean }`
  - `reduceTransitions(report: TestOutcomeReport, transitions: Transitions): TransitionOutcome`
  - `capLogTail(log: string): string`, `MAX_LOG_CHARACTERS: number`
  - `class ReportParseError extends Error` with `readonly detail: string`
  - `parsePytestJsonReport(text: string, log: string): TestOutcomeReport`

- [ ] **Step 1: Write the failing test**

`packages/task-execution/evaluator-adapters/src/parsers/pytest-json-report.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { loadFixtureFamily } from "../testing.js";
import { reduceTransitions, type Transitions } from "../report.js";
import { parsePytestJsonReport } from "./pytest-json-report.js";

interface Input {
  readonly report: unknown;
  readonly transitions: Transitions;
  readonly stdout: string;
}

describe("pytest-json-report ingestion", () => {
  it("reduces every fixture case to its pinned transition outcome", async () => {
    for (const fixtureCase of await loadFixtureFamily("pytest-json-report")) {
      const input = fixtureCase.input as Input;
      const expected = fixtureCase.expect as {
        outcome?: { passed: boolean; noTestPassed: boolean; passToPassBroken?: string[] };
        operational?: { reason: string };
        log?: { startsWith: string; length: number };
      };
      if (expected.operational !== undefined) {
        expect(
          () => parsePytestJsonReport(JSON.stringify(input.report), input.stdout),
          fixtureCase.name,
        ).toThrowError(expected.operational.reason);
        continue;
      }
      const report = parsePytestJsonReport(JSON.stringify(input.report), input.stdout);
      if (expected.log !== undefined) {
        expect(report.log.startsWith(expected.log.startsWith), fixtureCase.name).toBe(true);
        expect(report.log.length, fixtureCase.name).toBe(expected.log.length);
        continue;
      }
      const outcome = reduceTransitions(report, input.transitions);
      expect(outcome.passed, fixtureCase.name).toBe(expected.outcome!.passed);
      expect(outcome.noTestPassed, fixtureCase.name).toBe(expected.outcome!.noTestPassed);
      if (expected.outcome!.passToPassBroken !== undefined) {
        expect([...outcome.passToPassBroken], fixtureCase.name)
          .toEqual(expected.outcome!.passToPassBroken);
      }
    }
  });

  it("refuses input that is not UTF-8 JSON", () => {
    expect(() => parsePytestJsonReport("{not json", "")).toThrowError("eval_report_malformed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/parsers/pytest-json-report.test.ts`
Expected: FAIL — `Cannot find module '../report.js'`

- [ ] **Step 3: Write the report model**

`packages/task-execution/evaluator-adapters/src/report.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/** One grader run, reduced from whatever ingestion format produced it. */
export interface TestOutcomeReport {
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  /** The grader process's exit code when the format carries one. */
  readonly exitCode?: number;
  /** Captured grader output, already capped. Never authoritative; used for classification. */
  readonly log: string;
  /** Set when the grader itself failed to start or configure — never a solver failure. */
  readonly setupError?: string;
}

export interface Transitions {
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
}

export interface TransitionOutcome {
  /** SWE-bench `resolved`: every FAIL_TO_PASS now passes and no PASS_TO_PASS broke. */
  readonly passed: boolean;
  readonly failToPassPassed: readonly string[];
  readonly passToPassBroken: readonly string[];
  /**
   * Nothing the spec expected was observed to pass. This is the gate on treating a non-zero
   * exit plus an infrastructure signature as an abort rather than a verdict: a partially
   * passing run is a real result no matter what the log says.
   */
  readonly noTestPassed: boolean;
}

/**
 * The transition reduction. A PASS_TO_PASS id is broken only when the report explicitly reports
 * it as failed — an id missing from the report entirely is not evidence of breakage, which is the
 * semantics the retired evaluator's `failed_from_pass_to_pass` list carried.
 */
export function reduceTransitions(
  report: TestOutcomeReport,
  transitions: Transitions,
): TransitionOutcome {
  const passedIds = new Set(report.passed);
  const failedIds = new Set(report.failed);
  const empirical = transitions.failToPass.length === 0 && transitions.passToPass.length === 0;
  const failToPassPassed = transitions.failToPass.filter((id) => passedIds.has(id));
  const passToPassBroken = transitions.passToPass.filter((id) => failedIds.has(id));
  const passed = empirical
    ? report.passed.length > 0 && report.failed.length === 0
    : failToPassPassed.length === transitions.failToPass.length && passToPassBroken.length === 0;
  const noTestPassed = empirical
    ? report.passed.length === 0
    : failToPassPassed.length === 0 && passToPassBroken.length >= transitions.passToPass.length;
  return { passed, failToPassPassed, passToPassBroken, noTestPassed };
}

/**
 * The retained grader-output tail. The tail is what matters — a test summary and the last
 * failures live there — and an unbounded log would be pinned verbatim as claim evidence.
 * The retired implementation labelled the discarded amount "bytes" while measuring UTF-16 code
 * units; this says characters, which is what it measures.
 */
export const MAX_LOG_CHARACTERS = 1024 * 1024;

export function capLogTail(log: string): string {
  if (log.length <= MAX_LOG_CHARACTERS) return log;
  const truncated = log.length - MAX_LOG_CHARACTERS;
  const notice = `[... ${truncated} characters truncated ...]\n`;
  return notice + log.slice(log.length - MAX_LOG_CHARACTERS + notice.length);
}

export class ReportParseError extends Error {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail: string, options?: ErrorOptions) {
    super(`${reason}: ${detail}`, options);
    this.name = "ReportParseError";
    this.reason = reason;
    this.detail = detail;
  }
}
```

Note that `capLogTail` returns exactly `MAX_LOG_CHARACTERS` characters (notice included), which is what the `log-tail-capped` fixture pins.

- [ ] **Step 4: Write the benchmark-local JSON parser**

`packages/task-execution/evaluator-adapters/src/parsers/pytest-json-report.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { capLogTail, ReportParseError, type TestOutcomeReport } from "../report.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Ingests the benchmark-local JSON report a deterministic-process grader writes: a `{ items: [] }`
 * document whose item carries either a setup `error`, or an `exit_code` plus the transition
 * outcome lists. Untrusted input — every field is checked, nothing is executed.
 */
export function parsePytestJsonReport(text: string, log: string): TestOutcomeReport {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new ReportParseError("eval_report_malformed", "report is not valid UTF-8 JSON", { cause });
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ReportParseError("eval_report_malformed", "report must be an object");
  }
  const items = (document as { items?: unknown }).items;
  const item = Array.isArray(items) && items.length > 0 ? items[0] : undefined;
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new ReportParseError("eval_report_malformed", "report contains no item");
  }
  const record = item as Record<string, unknown>;

  const setupError = typeof record["error"] === "string" ? record["error"].trim() : "";
  if (setupError.length > 0) {
    throw new ReportParseError("eval_setup_error", setupError);
  }
  if (typeof record["exit_code"] !== "number") {
    throw new ReportParseError(
      "eval_report_malformed",
      "report item lacks a numeric exit_code",
    );
  }

  // `from_fail_to_pass` is the intersection of the run with the expected FAIL_TO_PASS set;
  // `passed_actual`/`failed_actual` are the full observed sets a transition-free (empirical) row
  // produces. Both feed the same passed/failed sets; the transition reducer decides what counts.
  const passed = [...stringArray(record["from_fail_to_pass"]), ...stringArray(record["passed_actual"])];
  const failed = [
    ...stringArray(record["failed_from_pass_to_pass"]),
    ...stringArray(record["failed_actual"]),
  ];

  return {
    passed: [...new Set(passed)],
    failed: [...new Set(failed)],
    skipped: [],
    exitCode: record["exit_code"],
    log: capLogTail(log),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/parsers/pytest-json-report.test.ts`
Expected: PASS. If `log-tail-capped.json`'s pinned numbers were guessed, correct the fixture from the observed values now and re-run.

Note: the `docker-unavailable`, `docker-credentials-error`, and `patch-corrupt` adversarial cases expect infrastructure reasons that this parser does not yet produce — they are satisfied by Task 5. Until then, mark them with `it.todo`-equivalent skipping by filtering on the reasons this parser owns (`eval_setup_error`, `eval_report_malformed`) inside the test's `operational` branch, and remove that filter in Task 5 Step 5.

- [ ] **Step 6: Commit**

```bash
git add packages/task-execution/evaluator-adapters/src packages/task-execution/evaluator-adapters/fixtures
git commit -m "feat(task-execution): add the evaluator report model and benchmark-local JSON parser"
```

---

### Task 5: Infrastructure-abort classification

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/infrastructure.ts`
- Create: `packages/task-execution/evaluator-adapters/src/infrastructure.test.ts`
- Modify: `packages/task-execution/evaluator-adapters/src/parsers/pytest-json-report.test.ts` (drop the Task 4 filter)

**Interfaces:**
- Consumes: `TestOutcomeReport`, `TransitionOutcome`, `ReportParseError` (Task 4).
- Produces:
  - `INFRASTRUCTURE_SIGNATURES: readonly { readonly pattern: RegExp; readonly reason: string }[]`
  - `classifyInfrastructureFailure(log: string): string | undefined`
  - `toOperationalError(reason: string, detail: string, cause?: unknown): EvaluationOperationalError`
  - `toOperationalErrorFromParse(failure: ReportParseError): EvaluationOperationalError` — re-homes a parse failure onto the same no-verdict path (consumed by Tasks 7 and 8)
  - `assertGradeable(report: TestOutcomeReport, outcome: TransitionOutcome): void` — throws when the run aborted rather than graded

- [ ] **Step 1: Write the failing test**

`packages/task-execution/evaluator-adapters/src/infrastructure.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";
import { classifyInfrastructureFailure, assertGradeable, toOperationalError } from "./infrastructure.js";
import type { TestOutcomeReport, TransitionOutcome } from "./report.js";

const graded: TransitionOutcome = {
  passed: false,
  failToPassPassed: [],
  passToPassBroken: ["b"],
  noTestPassed: true,
};

function report(log: string, exitCode: number): TestOutcomeReport {
  return { passed: [], failed: ["b"], skipped: [], exitCode, log };
}

describe("infrastructure classification", () => {
  it("names each known abort signature", () => {
    expect(classifyInfrastructureFailure("Cannot connect to the Docker daemon at unix:///x"))
      .toBe("docker_unavailable");
    expect(classifyInfrastructureFailure("error getting credentials - err: exit status 1"))
      .toBe("docker_credentials_error");
    expect(classifyInfrastructureFailure("error: corrupt patch at line 30")).toBe("patch_corrupt");
    expect(classifyInfrastructureFailure("Fatal Python error: Illegal instruction"))
      .toBe("image_arch_mismatch");
    expect(classifyInfrastructureFailure("2 failed, 3 passed in 4.2s")).toBeUndefined();
  });

  it("aborts a zero-passed non-zero-exit run that carries an abort signature", () => {
    expect(() => assertGradeable(report("Cannot connect to the Docker daemon", 125), graded))
      .toThrowError(EvaluationOperationalError);
  });

  it("does not abort when the run produced a real result", () => {
    const passing: TransitionOutcome = {
      passed: true,
      failToPassPassed: ["a"],
      passToPassBroken: [],
      noTestPassed: false,
    };
    expect(() => assertGradeable(report("Cannot connect to the Docker daemon", 1), passing))
      .not.toThrow();
    expect(() => assertGradeable(report("2 failed, 3 passed in 4.2s", 1), graded)).not.toThrow();
    expect(() => assertGradeable(report("Cannot connect to the Docker daemon", 0), graded))
      .not.toThrow();
  });

  it("maps a reason to the harness's typed no-verdict path", () => {
    const failure = toOperationalError("eval_setup_error", "missing image_name");
    expect(failure).toBeInstanceOf(EvaluationOperationalError);
    expect(failure.reason).toBe("provider-unavailable");
    expect(failure.recoveryAdvice).toBe("new-attempt-required");
    expect(failure.safeDetail).toContain("eval_setup_error");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/infrastructure.test.ts`
Expected: FAIL — `Cannot find module './infrastructure.js'`

- [ ] **Step 3: Write the classifier**

`packages/task-execution/evaluator-adapters/src/infrastructure.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { EvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";
import { ReportParseError, type TestOutcomeReport, type TransitionOutcome } from "./report.js";

/**
 * Grader-output signatures that mean the run aborted before it could grade anything — the
 * operator's environment is the problem, not the solver's work. Every entry is a scenario the
 * retired evaluator learned in production; they enter here as a classification table, never as
 * ported code (composition program §6 contract 12).
 */
export const INFRASTRUCTURE_SIGNATURES: readonly {
  readonly pattern: RegExp;
  readonly reason: string;
}[] = Object.freeze([
  { pattern: /Cannot connect to the Docker daemon/iu, reason: "docker_unavailable" },
  { pattern: /input\/output error/iu, reason: "docker_storage_io_error" },
  { pattern: /No such image|manifest unknown|pull access denied/iu, reason: "image_pull_failed" },
  // A hung or killed credential helper aborts the run before the container starts, while the
  // grader still writes a zero-passed report. Without this entry that shape delivers a false
  // `fail` — the 2026-07-07 evaluator outage.
  { pattern: /error getting credentials/iu, reason: "docker_credentials_error" },
  { pattern: /^docker: (?:error|Error response from daemon)/imu, reason: "container_run_failed" },
  { pattern: /error: corrupt patch at line|patch fragment without header/iu, reason: "patch_corrupt" },
  { pattern: /patch does not apply|error: patch failed:/iu, reason: "patch_does_not_apply" },
  { pattern: /Applied patch to .+ with conflicts|^U \S/mu, reason: "patch_merge_conflict" },
  { pattern: /fatal: not a git repository/iu, reason: "workdir_not_git_repo" },
  { pattern: /: command not found/iu, reason: "test_command_not_found" },
  { pattern: /Failed building editable|Failed to build installable wheels/iu, reason: "install_build_failed" },
  { pattern: /No virtual environment found/iu, reason: "virtualenv_missing" },
  { pattern: /A virtual environment already exists at \S+\.venv\b/iu, reason: "virtualenv_collision" },
  { pattern: /exec format error|the requested image's platform .* does not match/iu, reason: "image_arch_mismatch" },
  { pattern: /Fatal Python error:\s*Illegal instruction|Illegal instruction(?:\s+\(core dumped\))?/iu, reason: "image_arch_mismatch" },
  { pattern: /No module named pytest\b/iu, reason: "test_runner_missing" },
  { pattern: /RequestsDependencyWarning/iu, reason: "dependency_version_mismatch" },
  { pattern: /ImportError while loading conftest/iu, reason: "test_config_import_error" },
]);

export function classifyInfrastructureFailure(log: string): string | undefined {
  for (const { pattern, reason } of INFRASTRUCTURE_SIGNATURES) {
    if (pattern.test(log)) return reason;
  }
  return undefined;
}

/**
 * Every abort reason lands on the same typed no-verdict path. `provider-unavailable` is the
 * harness's reason for "the evaluation machinery could not produce a conclusion"; the operator
 * sees the specific reason in `safeDetail`. The Attempt terminates
 * `failed {blame: infrastructure}` — never FAIL, never inconclusive (profiles unscorable.ts).
 */
export function toOperationalError(
  reason: string,
  detail: string,
  cause?: unknown,
): EvaluationOperationalError {
  return new EvaluationOperationalError({
    canonicalCode: "UNAVAILABLE",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: `${reason}: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Re-homes a parse failure onto the same path. */
export function toOperationalErrorFromParse(failure: ReportParseError): EvaluationOperationalError {
  return toOperationalError(failure.reason, failure.detail, failure);
}

/**
 * Aborts when the run never graded: a non-zero grader exit, nothing the spec expected observed to
 * pass, and a known abort signature in the output. All three conditions are required — a
 * partially passing run is a real result whatever the log says, and a clean exit is a real result
 * even when the log mentions a transient warning.
 */
export function assertGradeable(
  report: TestOutcomeReport,
  outcome: TransitionOutcome,
): void {
  if (report.exitCode === undefined || report.exitCode === 0) return;
  if (!outcome.noTestPassed) return;
  const reason = classifyInfrastructureFailure(report.log);
  if (reason === undefined) return;
  throw toOperationalError(reason, report.log.slice(-800));
}
```

- [ ] **Step 4: Run the classifier tests**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/infrastructure.test.ts`
Expected: PASS

- [ ] **Step 5: Remove the Task 4 fixture filter**

In `src/parsers/pytest-json-report.test.ts`, replace the `operational` branch so that infrastructure reasons are routed through `assertGradeable`:

```ts
      if (expected.operational !== undefined) {
        let thrown: unknown;
        try {
          const parsed = parsePytestJsonReport(JSON.stringify(input.report), input.stdout);
          assertGradeable(parsed, reduceTransitions(parsed, input.transitions));
        } catch (cause) {
          thrown = cause;
        }
        expect(thrown, fixtureCase.name).toBeDefined();
        expect(String((thrown as Error).message), fixtureCase.name)
          .toContain(expected.operational.reason);
        continue;
      }
```

Add the imports `assertGradeable` from `../infrastructure.js` and `reduceTransitions` from `../report.js`.

- [ ] **Step 6: Run the full suite**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test && yarn typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/evaluator-adapters/src
git commit -m "feat(task-execution): classify grader infrastructure aborts onto the no-verdict path"
```

---

### Task 6: JUnit XML and TAP14 parsers

Both are declared ingestion formats (design §6.3 / §7 ruling 5) and are the non-pytest path for graders whose node-id semantics the JSON report does not carry.

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/parsers/junit-xml.ts`
- Create: `packages/task-execution/evaluator-adapters/src/parsers/junit-xml.test.ts`
- Create: `packages/task-execution/evaluator-adapters/src/parsers/tap14.ts`
- Create: `packages/task-execution/evaluator-adapters/src/parsers/tap14.test.ts`
- Create: `packages/task-execution/evaluator-adapters/src/parsers/index.ts`

**Interfaces:**
- Consumes: `TestOutcomeReport`, `ReportParseError`, `capLogTail` (Task 4); `ParserFormat` (Task 3).
- Produces:
  - `parseJunitXml(text: string, log: string): TestOutcomeReport`
  - `parseTap14(text: string, log: string): TestOutcomeReport`
  - `parseByFormat(format: ParserFormat, text: string, log: string): TestOutcomeReport` (from `src/parsers/index.ts`)

- [ ] **Step 1: Write the failing tests**

`packages/task-execution/evaluator-adapters/src/parsers/junit-xml.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { loadFixtureFamily } from "../testing.js";
import { parseJunitXml } from "./junit-xml.js";

describe("JUnit XML ingestion", () => {
  it("reduces every fixture case to its pinned report", async () => {
    for (const fixtureCase of await loadFixtureFamily("junit-xml")) {
      const { xml } = fixtureCase.input as { xml: string };
      const expected = fixtureCase.expect as {
        report?: { passed: string[]; failed: string[]; skipped: string[] };
        error?: string;
      };
      if (expected.error !== undefined) {
        expect(() => parseJunitXml(xml, ""), fixtureCase.name).toThrowError("invalid-report");
        continue;
      }
      const report = parseJunitXml(xml, "");
      expect([...report.passed], fixtureCase.name).toEqual(expected.report!.passed);
      expect([...report.failed], fixtureCase.name).toEqual(expected.report!.failed);
      expect([...report.skipped], fixtureCase.name).toEqual(expected.report!.skipped);
    }
  });
});
```

`packages/task-execution/evaluator-adapters/src/parsers/tap14.test.ts` — identical shape against family `tap14` and `parseTap14`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/parsers/junit-xml.test.ts src/parsers/tap14.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write the JUnit XML parser**

`packages/task-execution/evaluator-adapters/src/parsers/junit-xml.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { capLogTail, ReportParseError, type TestOutcomeReport } from "../report.js";

const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/giu;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/gu;
const OUTCOME_CHILD = /<(failure|error|skipped)\b/iu;
const UNSAFE_PROLOG = /<!(?:DOCTYPE|ENTITY)\b/iu;
const PROCESSING_OR_COMMENT = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->/gu;

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
});

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/gu, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? match;
  });
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  for (const match of source.matchAll(ATTRIBUTE)) {
    found[match[1]!] = decodeEntities(match[2]!);
  }
  return found;
}

/**
 * A bounded, non-validating scanner over `<testcase>` elements. It never resolves external
 * entities — a document carrying a DOCTYPE or ENTITY declaration is refused outright rather than
 * parsed, because a grader report is untrusted input and entity expansion is the standard XML
 * attack surface. Anything beyond `testcase` and its direct outcome children is ignored.
 */
export function parseJunitXml(text: string, log: string): TestOutcomeReport {
  if (UNSAFE_PROLOG.test(text)) {
    throw new ReportParseError("invalid-report", "JUnit XML declares a DOCTYPE or ENTITY");
  }
  const stripped = text.replace(PROCESSING_OR_COMMENT, "");
  if (!/<testsuites?\b/iu.test(stripped)) {
    throw new ReportParseError("invalid-report", "JUnit XML has no testsuite element");
  }
  const openTags = (stripped.match(/<testsuite\b/giu) ?? []).length;
  const closeTags = (stripped.match(/<\/testsuite\s*>/giu) ?? []).length
    + (stripped.match(/<testsuite\b[^>]*\/>/giu) ?? []).length;
  if (openTags !== closeTags) {
    throw new ReportParseError("invalid-report", "JUnit XML testsuite elements are unbalanced");
  }

  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  TESTCASE.lastIndex = 0;
  for (const match of stripped.matchAll(TESTCASE)) {
    const found = attributes(match[1] ?? "");
    const name = found["name"];
    if (name === undefined || name.length === 0) {
      throw new ReportParseError("invalid-report", "JUnit testcase has no name");
    }
    const className = found["classname"];
    const id = className === undefined || className.length === 0 ? name : `${className}::${name}`;
    const body = match[3] ?? "";
    const outcome = OUTCOME_CHILD.exec(body)?.[1]?.toLowerCase();
    if (outcome === "skipped") skipped.push(id);
    else if (outcome === "failure" || outcome === "error") failed.push(id);
    else passed.push(id);
  }

  return { passed, failed, skipped, log: capLogTail(log) };
}
```

- [ ] **Step 4: Write the TAP14 parser**

`packages/task-execution/evaluator-adapters/src/parsers/tap14.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { capLogTail, ReportParseError, type TestOutcomeReport } from "../report.js";

const VERSION = /^TAP version 14\s*$/u;
const PLAN = /^1\.\.(\d+)\s*(?:#.*)?$/u;
const RESULT = /^(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?([^#]*?)\s*(?:#\s*(\S+)(?:\s+(.*))?)?\s*$/u;

/**
 * Ingests TAP version 14. Only top-level results are read: subtests, YAML diagnostic blocks, and
 * bail-out lines are ignored for outcome purposes, and a declared plan must match the number of
 * results seen. A `SKIP` or `TODO` directive is not a failure — TODO in particular marks a known
 * incomplete test, so counting it as failed would penalize a correct solver.
 */
export function parseTap14(text: string, log: string): TestOutcomeReport {
  const lines = text.split(/\r?\n/u);
  if (!lines.some((line) => VERSION.test(line))) {
    throw new ReportParseError("invalid-report", "TAP stream has no version 14 header");
  }
  let planned: number | undefined;
  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let seen = 0;

  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("#")) continue;
    const plan = PLAN.exec(line);
    if (plan !== null) {
      planned = Number.parseInt(plan[1]!, 10);
      continue;
    }
    const result = RESULT.exec(line);
    if (result === null) continue;
    seen += 1;
    const ok = result[1] === "ok";
    const number = result[2] ?? String(seen);
    const description = (result[3] ?? "").trim();
    const directive = result[4]?.toUpperCase();
    const id = description.length > 0 ? description : number;
    if (directive === "SKIP" || directive === "TODO") skipped.push(id);
    else if (ok) passed.push(id);
    else failed.push(id);
  }

  if (planned !== undefined && planned !== seen) {
    throw new ReportParseError(
      "invalid-report",
      `TAP plan declared ${planned} tests but ${seen} results were seen`,
    );
  }
  return { passed, failed, skipped, log: capLogTail(log) };
}
```

- [ ] **Step 5: Write the format dispatcher**

`packages/task-execution/evaluator-adapters/src/parsers/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { ParserFormat } from "../declarations.js";
import type { TestOutcomeReport } from "../report.js";
import { parseJunitXml } from "./junit-xml.js";
import { parsePytestJsonReport } from "./pytest-json-report.js";
import { parseTap14 } from "./tap14.js";

export { parseJunitXml, parsePytestJsonReport, parseTap14 };

/** Dispatches on the format the parser declaration commits to — never on the material's content. */
export function parseByFormat(
  format: ParserFormat,
  text: string,
  log: string,
): TestOutcomeReport {
  switch (format) {
    case "benchmark-json": return parsePytestJsonReport(text, log);
    case "junit-xml": return parseJunitXml(text, log);
    case "tap14": return parseTap14(text, log);
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test && yarn typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/evaluator-adapters/src
git commit -m "feat(task-execution): add JUnit XML and TAP14 ingestion parsers"
```

---

### Task 7: The swe-rebench evaluator adapter

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/material.ts`
- Create: `packages/task-execution/evaluator-adapters/src/swe-rebench.ts`
- Create: `packages/task-execution/evaluator-adapters/src/swe-rebench.test.ts`

**Interfaces:**
- Consumes: `parseByFormat` (Task 6), `assertGradeable` / `toOperationalErrorFromParse` (Task 5), `reduceTransitions` (Task 4), `parserDeclaration` (Task 3), `buildSweRebenchEvaluationSpec` / `loadFixtureFamily` (Task 2).
- Produces:
  - `resolveReportMaterial(input: { results: readonly ExactEvaluationMaterial[]; context: EvaluationContext; materialName: string }): { readonly text: string }` — throws `EvaluationOperationalError` with reason `subject-not-found` when absent
  - `deliverMeasurements(spec: EvaluationSpec, computed: Record<string, EvaluationMeasurementValue>): EvaluationMeasurement[]` — the declared intersection
  - `createSweRebenchRegistration(options: { readonly signerHandle?: string; readonly evaluatorId?: string }): EvaluatorRegistration`

- [ ] **Step 1: Write the failing test**

`packages/task-execution/evaluator-adapters/src/swe-rebench.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";
import { buildSweRebenchEvaluationSpec, loadFixtureFamily } from "./testing.js";
import { parserIdentity } from "./declarations.js";
import { createSweRebenchRegistration } from "./swe-rebench.js";

const encoder = new TextEncoder();

function material(name: string, text: string) {
  const bytes = encoder.encode(text);
  return { descriptor: { name, digest: { sha256: "0".repeat(64) } }, bytes };
}

const attempt = { attemptUri: "jinn:attempt:test", nonce: "n", attemptNumber: 1 } as const;

describe("swe-rebench evaluator adapter", () => {
  const registration = createSweRebenchRegistration({});
  const identity = parserIdentity("jinn.parser.pytest-json-report");
  const spec = buildSweRebenchEvaluationSpec({ parserDigest: identity.digest });

  it("accepts only the deterministic-process specs whose parser it declares", () => {
    expect(registration.specificationCompatibility(spec)).toBe(true);
    const foreign = buildSweRebenchEvaluationSpec({
      parserId: "jinn.parser.somebody-elses",
      parserDigest: `sha256:${"f".repeat(64)}`,
    });
    expect(registration.specificationCompatibility(foreign)).toBe(false);
  });

  it("reproduces every pinned adapter fixture", async () => {
    for (const fixtureCase of await loadFixtureFamily("swe-rebench-adapter")) {
      const input = fixtureCase.input as { report: unknown; stdout: string };
      const expected = fixtureCase.expect as {
        verdict?: "pass" | "fail";
        measurements?: Record<string, unknown>;
        operational?: { reason: string };
      };
      const results = [
        material("evaluation-report.json", JSON.stringify(input.report)),
        material("solution.patch", "diff --git a/x b/x\n"),
      ];
      const context = { "jinn.evaluation.log": input.stdout };
      const run = registration.adapter.evaluate(
        material("task.sealed", "{}"),
        results,
        spec,
        context,
        attempt,
        new AbortController().signal,
      );
      if (expected.operational !== undefined) {
        await expect(run, fixtureCase.name).rejects.toBeInstanceOf(EvaluationOperationalError);
        continue;
      }
      const completed = await run;
      expect(completed.verdict, fixtureCase.name).toBe(expected.verdict);
      const delivered = Object.fromEntries(
        (completed.measurements ?? []).map((entry) => [entry.name, entry.value]),
      );
      expect(delivered, fixtureCase.name).toEqual(expected.measurements);
    }
  });

  it("aborts rather than guessing when the grader report was never provisioned", async () => {
    await expect(registration.adapter.evaluate(
      material("task.sealed", "{}"),
      [material("solution.patch", "diff --git a/x b/x\n")],
      spec,
      {},
      attempt,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(EvaluationOperationalError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/swe-rebench.test.ts`
Expected: FAIL — `Cannot find module './swe-rebench.js'`

- [ ] **Step 3: Write the material resolver**

`packages/task-execution/evaluator-adapters/src/material.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { EvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";
import type {
  EvaluationMeasurement,
  EvaluationMeasurementValue,
  ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";

const decoder = new TextDecoder("utf-8", { fatal: true });

export type EvaluationContext = Readonly<Record<string, unknown>>;

/** Host-provisioned grader output, read from `evaluation-context.json` when it is not a Result. */
const CONTEXT_MATERIAL_KEY = "jinn.evaluation.material" as const;
export const CONTEXT_LOG_KEY = "jinn.evaluation.log" as const;

function notFound(materialName: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "FAILED_PRECONDITION",
    reason: "subject-not-found",
    recoveryAdvice: "operator-action-required",
    safeDetail:
      `grader material ${materialName} was not provisioned; this adapter parses provisioned `
      + "output and never produces it",
  });
}

/**
 * Locates the grader's output. Preference order is digest-verified Result material first, then
 * the host-provisioned evaluation context — the operator-local channel for output produced
 * outside the Attempt. Composition design finding 1: no owner in the composition design executes
 * the deterministic-process container, so an adapter that cannot find its material aborts loudly
 * rather than inventing a verdict.
 */
export function resolveReportMaterial(input: {
  readonly results: readonly ExactEvaluationMaterial[];
  readonly context: EvaluationContext;
  readonly materialName: string;
}): { readonly text: string } {
  const result = input.results.find(
    (candidate) => candidate.descriptor.name === input.materialName,
  );
  if (result !== undefined) {
    try {
      return { text: decoder.decode(result.bytes) };
    } catch (cause) {
      throw new EvaluationOperationalError({
        canonicalCode: "FAILED_PRECONDITION",
        reason: "invalid-evaluator-output",
        recoveryAdvice: "do-not-retry",
        safeDetail: `grader material ${input.materialName} is not valid UTF-8`,
        cause,
      });
    }
  }
  const provisioned = input.context[CONTEXT_MATERIAL_KEY];
  if (typeof provisioned === "object" && provisioned !== null && !Array.isArray(provisioned)) {
    const entry = (provisioned as Record<string, unknown>)[input.materialName];
    if (typeof entry === "string") return { text: entry };
  }
  return notFound(input.materialName);
}

export function contextLog(context: EvaluationContext): string {
  const log = context[CONTEXT_LOG_KEY];
  return typeof log === "string" ? log : "";
}

/**
 * The declared intersection. The harness rejects any measurement the spec does not declare, so an
 * adapter must never deliver its full computed set; it delivers exactly what the spec asked for,
 * in the spec's declaration order.
 */
export function deliverMeasurements(
  spec: EvaluationSpec,
  computed: Readonly<Record<string, EvaluationMeasurementValue>>,
): EvaluationMeasurement[] {
  return spec.measurements
    .filter((declaration) => Object.hasOwn(computed, declaration.name))
    .map((declaration) => ({
      name: declaration.name,
      value: computed[declaration.name]!,
      ...(declaration.unit === undefined ? {} : { unit: declaration.unit }),
    }));
}
```

- [ ] **Step 4: Write the adapter**

`packages/task-execution/evaluator-adapters/src/swe-rebench.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  defineEvaluatorRegistration,
  type CompletedEvaluation,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  evaluateVerdictRule,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type MeasurementMap,
  type VerdictRule,
} from "@jinn-network/task-execution-profiles";
import { parserDeclaration, parserIdentity } from "./declarations.js";
import {
  assertGradeable,
  toOperationalError,
  toOperationalErrorFromParse,
} from "./infrastructure.js";
import { contextLog, deliverMeasurements, resolveReportMaterial } from "./material.js";
import { parseByFormat } from "./parsers/index.js";
import { reduceTransitions, ReportParseError } from "./report.js";

/** The parser identities this registration can serve — the transition-scored ingestion formats. */
const SUPPORTED_PARSER_IDS = Object.freeze([
  "jinn.parser.pytest-json-report",
  "jinn.parser.junit-xml",
  "jinn.parser.tap14",
] as const);

export const SWE_REBENCH_REGISTRATION_ID = "jinn.evaluator.transition-scored.v1" as const;

function deterministicBlock(spec: EvaluationSpec): DeterministicProcessBlock | undefined {
  return spec.family === "deterministic-process"
    ? spec.familyBlock as DeterministicProcessBlock
    : undefined;
}

/**
 * The transition-scored adapter: it reads the grader's provisioned output through the ingestion
 * format its EvaluationSpec's parser identity commits to, reduces it against the spec's declared
 * transitions, and lets the spec's own verdict rule decide. The rule is authoritative, so the
 * harness's verdict-consistency gate and this adapter cannot disagree.
 */
export function createSweRebenchRegistration(options: {
  readonly signerHandle?: string;
  readonly evaluatorId?: string;
} = {}): EvaluatorRegistration {
  const methodIdentity = parserIdentity("jinn.parser.pytest-json-report");
  return defineEvaluatorRegistration({
    registrationId: SWE_REBENCH_REGISTRATION_ID,
    evaluatorIdentity: { id: options.evaluatorId ?? SWE_REBENCH_REGISTRATION_ID },
    signer: { handle: options.signerHandle ?? "evaluator-signing-key" },
    interruptionBehavior: "repeatable",
    evaluationMethod: {
      name: SWE_REBENCH_REGISTRATION_ID,
      digest: { sha256: methodIdentity.digest.slice("sha256:".length) },
    },
    specificationCompatibility(specification) {
      const block = deterministicBlock(specification);
      if (block === undefined) return false;
      const declaredId = block.parser.id;
      if (!SUPPORTED_PARSER_IDS.includes(declaredId as (typeof SUPPORTED_PARSER_IDS)[number])) {
        return false;
      }
      // The spec must commit to the exact parser this deployment ships, not merely its name.
      return block.parser.digest === parserIdentity(declaredId).digest
        && block.parser.version === parserIdentity(declaredId).version;
    },
    outcomeValidator(evaluation) {
      return evaluation;
    },
    adapter: {
      async evaluate(_task, results, specification, context, _attempt, _deadlineSignal) {
        const block = deterministicBlock(specification);
        if (block === undefined) {
          throw toOperationalError("unsupported_specification", "spec is not deterministic-process");
        }
        const declaration = parserDeclaration(block.parser.id);
        const log = contextLog(context);
        const { text } = resolveReportMaterial({
          results,
          context,
          materialName: declaration.materialName,
        });

        let report;
        try {
          report = parseByFormat(declaration.format, text, log);
        } catch (cause) {
          if (cause instanceof ReportParseError) throw toOperationalErrorFromParse(cause);
          throw cause;
        }

        const outcome = reduceTransitions(report, block.transitions);
        assertGradeable(report, outcome);

        const computed = { passed: outcome.passed };
        const measurements = deliverMeasurements(specification, computed);
        const map: MeasurementMap = Object.fromEntries(
          measurements.map((entry) => [entry.name, entry.value as string | number | boolean]),
        );
        const decided = evaluateVerdictRule(specification.verdictRule as VerdictRule, map);

        const completed: CompletedEvaluation = {
          detailedOutcome: {
            failToPassPassed: [...outcome.failToPassPassed],
            passToPassBroken: [...outcome.passToPassBroken],
            graderExitCode: report.exitCode ?? null,
          },
          verdict: decided.verdict,
          evaluatedAt: new Date().toISOString(),
          measurements,
          explanation: outcome.passed
            ? "Every expected failing test now passes and no expected passing test broke."
            : "The expected transition set was not satisfied.",
          ...(decided.inconclusiveClass === undefined
            ? {}
            : { limitations: [decided.inconclusiveClass] }),
          claimEvidence: report.log.length === 0
            ? []
            : [{
                kind: "content",
                name: "grader-log.txt",
                bytes: new TextEncoder().encode(report.log),
                mediaType: "text/plain; charset=utf-8",
              }],
        };
        return completed;
      },
    },
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/swe-rebench.test.ts && yarn typecheck`
Expected: PASS. If `buildSweRebenchEvaluationSpec`'s default `parserDigest` no longer matches a real declaration, update the kit builder's default to call `parserIdentity("jinn.parser.pytest-json-report").digest` — the kit may import `./declarations.js`, both are production modules of this package.

- [ ] **Step 6: Commit**

```bash
git add packages/task-execution/evaluator-adapters/src
git commit -m "feat(task-execution): add the transition-scored swe-rebench evaluator adapter"
```

---

### Task 8: The prediction-market evaluator adapter

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/decimal.ts`
- Create: `packages/task-execution/evaluator-adapters/src/decimal.test.ts`
- Create: `packages/task-execution/evaluator-adapters/src/prediction.ts`
- Create: `packages/task-execution/evaluator-adapters/src/prediction.test.ts`

**Interfaces:**
- Consumes: `resolveReportMaterial` / `deliverMeasurements` (Task 7), `parserDeclaration` (Task 3), `buildPredictionEvaluationSpec` / `loadFixtureFamily` (Task 2).
- Produces:
  - `brierLoss(probability: string, outcomeIsYes: boolean): string` — exact, six fractional digits, half-up
  - `subtractDecimals(left: string, right: string): string` — exact, six fractional digits
  - `createPredictionRegistration(options: { readonly signerHandle?: string; readonly evaluatorId?: string }): EvaluatorRegistration`
  - `PREDICTION_REGISTRATION_ID = "jinn.evaluator.binary-prediction-market.v1"`

- [ ] **Step 1: Write the failing decimal test**

`packages/task-execution/evaluator-adapters/src/decimal.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { brierLoss, subtractDecimals } from "./decimal.js";

describe("exact decimal scoring", () => {
  it("computes the Brier loss without float arithmetic", () => {
    expect(brierLoss("0.9", true)).toBe("0.010000");
    expect(brierLoss("0.6", true)).toBe("0.160000");
    expect(brierLoss("0.2", true)).toBe("0.640000");
    expect(brierLoss("0.5", false)).toBe("0.250000");
    expect(brierLoss("1", true)).toBe("0.000000");
    expect(brierLoss("0", true)).toBe("1.000000");
  });

  it("rounds half-up at the sixth fractional digit", () => {
    // 0.1234565^2 exceeds six digits and must round, not truncate.
    expect(brierLoss("0.8765435", true)).toBe("0.015242");
  });

  it("subtracts exactly and keeps the sign", () => {
    expect(subtractDecimals("0.010000", "0.160000")).toBe("-0.150000");
    expect(subtractDecimals("0.640000", "0.160000")).toBe("0.480000");
    expect(subtractDecimals("0.160000", "0.160000")).toBe("0.000000");
  });

  it("rejects anything that is not a decimal string", () => {
    expect(() => brierLoss("1e-3", true)).toThrow(TypeError);
    expect(() => brierLoss("", true)).toThrow(TypeError);
  });
});
```

The `0.8765435` expectation must be computed, not guessed: `(0.8765435 - 1)^2 = 0.0152418...`. Run the implementation once and pin the observed six-digit value; correct the test literal if it differs.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/decimal.test.ts`
Expected: FAIL — `Cannot find module './decimal.js'`

- [ ] **Step 3: Write the decimal module**

`packages/task-execution/evaluator-adapters/src/decimal.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * Exact decimal arithmetic over `BigInt` scaled integers. Fractional quantities in a sealed
 * document are decimal strings, never JSON numbers, and a float round-trip would make a score
 * host-dependent — so nothing here ever touches `Number`, `parseFloat`, or `toFixed`.
 */

const DECIMAL = /^-?\d+(?:\.\d+)?$/u;

/** Delivered scores carry exactly this many fractional digits. */
export const SCORE_SCALE = 6;

function scaled(value: string, scale: number): bigint {
  if (!DECIMAL.test(value)) {
    throw new TypeError(`not a decimal string: ${JSON.stringify(value)}`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > scale) {
    throw new TypeError(`decimal ${value} exceeds scale ${scale}`);
  }
  const digits = whole! + fraction.padEnd(scale, "0");
  return BigInt(negative ? `-${digits}` : digits);
}

function render(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function fractionDigits(value: string): number {
  const index = value.indexOf(".");
  return index === -1 ? 0 : value.length - index - 1;
}

/** Rounds a value scaled at `from` down to `SCORE_SCALE`, half away from zero. */
function roundToScoreScale(value: bigint, from: number): bigint {
  if (from <= SCORE_SCALE) return value * 10n ** BigInt(SCORE_SCALE - from);
  const divisor = 10n ** BigInt(from - SCORE_SCALE);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * The Brier loss of one probability against a binary outcome: `(p - target)^2`, where `target` is
 * 1 for YES and 0 for NO. Lower is better.
 */
export function brierLoss(probability: string, outcomeIsYes: boolean): string {
  const scale = Math.max(fractionDigits(probability), 1);
  const p = scaled(probability, scale);
  const target = outcomeIsYes ? 10n ** BigInt(scale) : 0n;
  const difference = p - target;
  return render(roundToScoreScale(difference * difference, scale * 2), SCORE_SCALE);
}

/** Exact difference of two `SCORE_SCALE` decimals. */
export function subtractDecimals(left: string, right: string): string {
  return render(scaled(left, SCORE_SCALE) - scaled(right, SCORE_SCALE), SCORE_SCALE);
}
```

- [ ] **Step 4: Run the decimal test, then write the failing adapter test**

Run the decimal test (expect PASS after pinning the rounding literal), then create `packages/task-execution/evaluator-adapters/src/prediction.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildPredictionEvaluationSpec, loadFixtureFamily } from "./testing.js";
import { createPredictionRegistration } from "./prediction.js";

const encoder = new TextEncoder();

function material(name: string, text: string) {
  const bytes = encoder.encode(text);
  return { descriptor: { name, digest: { sha256: "0".repeat(64) } }, bytes };
}

const attempt = { attemptUri: "jinn:attempt:test", nonce: "n", attemptNumber: 1 } as const;

describe("binary prediction-market evaluator adapter", () => {
  const registration = createPredictionRegistration({});
  const spec = buildPredictionEvaluationSpec();

  it("reproduces every pinned adapter fixture", async () => {
    for (const fixtureCase of await loadFixtureFamily("prediction-adapter")) {
      const input = fixtureCase.input as {
        taskPayload: unknown;
        solution: unknown;
        outcome: unknown;
      };
      const expected = fixtureCase.expect as {
        verdict: "pass" | "fail" | "inconclusive";
        measurements: Record<string, unknown>;
        limitations?: string[];
      };
      const completed = await registration.adapter.evaluate(
        material("task.sealed", JSON.stringify({ payload: input.taskPayload })),
        [
          material("prediction.json", JSON.stringify(input.solution)),
          material("prediction-outcome.json", JSON.stringify(input.outcome)),
        ],
        spec,
        {},
        attempt,
        new AbortController().signal,
      );
      expect(completed.verdict, fixtureCase.name).toBe(expected.verdict);
      const delivered = Object.fromEntries(
        (completed.measurements ?? []).map((entry) => [entry.name, entry.value]),
      );
      expect(delivered, fixtureCase.name).toEqual(expected.measurements);
      if (expected.limitations !== undefined) {
        expect([...(completed.limitations ?? [])], fixtureCase.name).toEqual(expected.limitations);
      }
    }
  });

  it("only claims specs that commit to its own parser identity", () => {
    expect(registration.specificationCompatibility(spec)).toBe(true);
  });
});
```

- [ ] **Step 5: Write the prediction adapter**

`packages/task-execution/evaluator-adapters/src/prediction.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  defineEvaluatorRegistration,
  EvaluationOperationalError,
  type CompletedEvaluation,
  type EvaluationMeasurementValue,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  evaluateVerdictRule,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type MeasurementMap,
  type VerdictRule,
} from "@jinn-network/task-execution-profiles";
import { brierLoss, subtractDecimals } from "./decimal.js";
import { parserDeclaration, parserIdentity } from "./declarations.js";
import { deliverMeasurements, resolveReportMaterial } from "./material.js";

export const PREDICTION_PARSER_ID = "jinn.parser.prediction-market-v1" as const;
export const PREDICTION_REGISTRATION_ID = "jinn.evaluator.binary-prediction-market.v1" as const;

interface TaskPayload {
  readonly window: { readonly startTs: number; readonly endTs: number };
  readonly market: { readonly marketId: string; readonly conditionId: string };
  readonly consensusProbabilityYes: string;
}

interface Solution {
  readonly probabilityYes: string;
  readonly submittedAt: string;
}

interface Outcome {
  readonly status: "resolved" | "unresolved" | "invalid";
  readonly outcome?: "YES" | "NO";
  readonly marketId: string;
  readonly conditionId: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "FAILED_PRECONDITION",
    reason: "invalid-evaluator-output",
    recoveryAdvice: "do-not-retry",
    safeDetail: detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function json(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    invalid(`${label} is not valid JSON`, cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

/** ASCII-only lowercase; the guard forbids locale-sensitive case mapping in this tree. */
function lowerAscii(value: string): string {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32));
}

/**
 * Scores one binary prediction against a provisioned market outcome. The adapter reads only
 * provisioned material — the sealed Task for the window and market identity, the solver's Result
 * for the claimed probability, and the outcome document for the resolution. It never contacts a
 * venue; a resolution snapshot is ingested, not fetched.
 */
export function createPredictionRegistration(options: {
  readonly signerHandle?: string;
  readonly evaluatorId?: string;
} = {}): EvaluatorRegistration {
  const identity = parserIdentity(PREDICTION_PARSER_ID);
  const declaration = parserDeclaration(PREDICTION_PARSER_ID);
  return defineEvaluatorRegistration({
    registrationId: PREDICTION_REGISTRATION_ID,
    evaluatorIdentity: { id: options.evaluatorId ?? PREDICTION_REGISTRATION_ID },
    signer: { handle: options.signerHandle ?? "evaluator-signing-key" },
    interruptionBehavior: "repeatable",
    evaluationMethod: {
      name: PREDICTION_REGISTRATION_ID,
      digest: { sha256: identity.digest.slice("sha256:".length) },
    },
    specificationCompatibility(specification: EvaluationSpec) {
      if (specification.family !== "deterministic-process") return false;
      const block = specification.familyBlock as DeterministicProcessBlock;
      return block.parser.id === PREDICTION_PARSER_ID
        && block.parser.version === identity.version
        && block.parser.digest === identity.digest;
    },
    outcomeValidator(evaluation) {
      return evaluation;
    },
    adapter: {
      async evaluate(task, results, specification, context, _attempt, _deadlineSignal) {
        const taskDocument = json(decoder.decode(task.bytes), "subject Task");
        const payload = taskDocument["payload"] as TaskPayload | undefined;
        if (payload === undefined) invalid("subject Task carries no payload");

        const solution = json(
          resolveReportMaterial({ results, context, materialName: "prediction.json" }).text,
          "prediction Result",
        ) as unknown as Solution;
        const outcome = json(
          resolveReportMaterial({ results, context, materialName: declaration.materialName }).text,
          "market outcome",
        ) as unknown as Outcome;

        const identityMatched = outcome.marketId === payload.market.marketId
          && lowerAscii(outcome.conditionId) === lowerAscii(payload.market.conditionId);
        const submittedAt = Date.parse(solution.submittedAt);
        const withinWindow = Number.isFinite(submittedAt)
          && submittedAt >= payload.window.startTs
          && submittedAt <= payload.window.endTs;
        const resolved = outcome.status === "resolved" && outcome.outcome !== undefined;

        const computed: Record<string, EvaluationMeasurementValue> = {
          identityMatched,
          withinWindow,
          resolved,
        };
        if (resolved && identityMatched && withinWindow) {
          const outcomeIsYes = outcome.outcome === "YES";
          const solverBrier = brierLoss(solution.probabilityYes, outcomeIsYes);
          const consensusBrier = brierLoss(payload.consensusProbabilityYes, outcomeIsYes);
          computed["solverBrier"] = solverBrier;
          computed["consensusBrier"] = consensusBrier;
          computed["brierSpread"] = subtractDecimals(solverBrier, consensusBrier);
        }

        const measurements = deliverMeasurements(specification, computed);
        const map: MeasurementMap = Object.fromEntries(
          measurements.map((entry) => [entry.name, entry.value as string | number | boolean]),
        );
        const decided = evaluateVerdictRule(specification.verdictRule as VerdictRule, map);

        const completed: CompletedEvaluation = {
          detailedOutcome: {
            marketStatus: outcome.status,
            claimedProbabilityYes: solution.probabilityYes,
            consensusProbabilityYes: payload.consensusProbabilityYes,
          },
          verdict: decided.verdict,
          evaluatedAt: new Date().toISOString(),
          measurements,
          explanation: resolved
            ? "The market resolved and the claimed probability was scored against consensus."
            : "The market has not resolved.",
          ...(decided.inconclusiveClass === undefined
            ? {}
            : { limitations: [decided.inconclusiveClass] }),
        };
        return completed;
      },
    },
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test && yarn typecheck`
Expected: PASS. Adjust the prediction fixture files if the exact six-digit values differ from what was written in Task 2; the implementation output is authoritative, and the fixture's `note` should record the value.

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/evaluator-adapters/src packages/task-execution/evaluator-adapters/fixtures
git commit -m "feat(task-execution): add the binary prediction-market evaluator adapter"
```

---

### Task 9: Deployment facade and the end-to-end harness run

Closes the tree: the host-facing surface plus one real `runEvaluationHarness` execution proving the adapters seal a valid Result Evaluation through the harness they were written for.

**Files:**
- Create: `packages/task-execution/evaluator-adapters/src/deployment.ts`
- Create: `packages/task-execution/evaluator-adapters/src/deployment.integration.test.ts`
- Modify: `packages/task-execution/evaluator-adapters/src/index.ts`
- Modify: `packages/task-execution/evaluator-adapters/README.md` (add the host-composition paragraph)
- Modify: `packages/task-execution/evaluator-adapters/scripts/pack-smoke.mjs` (restore the export list if it was reduced in Task 1)

**Interfaces:**
- Consumes: `createSweRebenchRegistration` (Task 7), `createPredictionRegistration` (Task 8), `parserAllowlistEntries` (Task 3).
- Produces — **the cross-plan surface the stage-2 cutover plan composes against**:
  - `createEvaluatorDeployment(options: { readonly evidenceWriter: EvidenceRepositoryWriter; readonly maxClaimEvidenceBytes?: number; readonly signerHandle?: string; readonly evaluatorId?: string }): EvaluationHarnessDeployment`
  - Default `maxClaimEvidenceBytes` is `4 * 1024 * 1024`.
  - The returned object satisfies `EvaluationHarnessDeployment` exactly: `{ registrations, parserAllowlist, evidenceWriter, maxClaimEvidenceBytes }`.
  - The **host** authors the tiny ESM module the spawned harness loads through `JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE` (it must export `evaluationHarnessDeployment`), because only the host owns the evidence writer. This package ships no such module.
  - `src/index.ts` re-exports: `createEvaluatorDeployment`, `createSweRebenchRegistration`, `createPredictionRegistration`, `SWE_REBENCH_REGISTRATION_ID`, `PREDICTION_REGISTRATION_ID`, `PARSER_DECLARATIONS`, `parserDeclaration`, `parserIdentity`, `parserAllowlistEntries`, `INFRASTRUCTURE_SIGNATURES`, `classifyInfrastructureFailure`, and the `report.ts` types.

- [ ] **Step 1: Write the failing integration test**

`packages/task-execution/evaluator-adapters/src/deployment.integration.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResultEvaluation } from "@jinn-network/evidence-protocol";
import { runEvaluationHarness } from "@jinn-network/task-execution-evaluation-harness";
import {
  deriveEvaluationTask,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import { sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";
import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, it } from "vitest";
import { createEvaluatorDeployment } from "./deployment.js";
import { parserIdentity } from "./declarations.js";
import { buildSweRebenchEvaluationSpec } from "./testing.js";

const encoder = new TextEncoder();
const roots: string[] = [];
const sha256 = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evaluator deployment through the real harness", () => {
  it("seals a signed Result Evaluation for a passing swe-rebench run", async () => {
    const root = await mkdtemp(join(tmpdir(), "jinn-evaluator-adapters-e2e-"));
    roots.push(root);
    const paths: WorkspacePaths = {
      root,
      input: join(root, "input"),
      work: join(root, "work"),
      out: join(root, "out"),
      logs: join(root, "logs"),
      harnessState: join(root, "harness-state"),
      secrets: join(root, "secrets"),
      tmp: join(root, "tmp"),
      meta: join(root, "meta"),
    };
    await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));

    // Follow packages/task-execution/evaluation-harness/src/runtime.test.ts `makeFixture` for the
    // exact provisioning shape: task.sealed, dispatch-context.json, evaluation-spec.json, and the
    // subject Task / Delivery / Result files, each named and digested by the evaluation Task.
    const spec = buildSweRebenchEvaluationSpec({
      parserDigest: parserIdentity("jinn.parser.pytest-json-report").digest,
    });
    const sealedSpec = sealEvaluationSpec(spec);
    await writeFile(join(paths.input, "evaluation-spec.json"), sealedSpec.bytes);

    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(
      join(paths.secrets, "evaluator-signing-key"),
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { mode: 0o600 },
    );

    const report = {
      items: [{
        instance_id: "i",
        from_fail_to_pass: ["test_pool.py::test_retry_releases_connection"],
        failed_from_pass_to_pass: [],
        exit_code: 0,
      }],
    };
    const reportBytes = encoder.encode(JSON.stringify(report));
    await writeFile(join(paths.input, "evaluation-report.json"), reportBytes);

    // Build the subject Task/Delivery/Result set and the derived evaluation Task exactly as the
    // harness's own runtime test does, then:
    const deployment = createEvaluatorDeployment({
      evidenceWriter: {
        async putClaimEvidence(evidence) {
          return { name: evidence.name, digest: { sha256: sha256(evidence.bytes).slice(7) } };
        },
      },
    });

    const exitCode = await runEvaluationHarness(paths, deployment);
    expect(exitCode).toBe(0);

    const verdict = JSON.parse(await readFile(join(paths.out, "verdict"), "utf8")) as unknown;
    expect(validateResultEvaluation(verdict)).toBeDefined();
    void deriveEvaluationTask;
    void sealDelivery;
    void sealTask;
  });
});
```

Provision the subject Task, subject Delivery, subject Results, `task.sealed`, and `dispatch-context.json` by copying the exact construction from `packages/task-execution/evaluation-harness/src/runtime.test.ts` (`makeFixture`) — read that file first and mirror it; do not invent a shape. The evaluation-report material is provided as one of the subject Results so `verifyEvaluationSubject` covers it.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters" && yarn test src/deployment.integration.test.ts`
Expected: FAIL — `Cannot find module './deployment.js'`

- [ ] **Step 3: Write the deployment facade**

`packages/task-execution/evaluator-adapters/src/deployment.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  validateEvaluatorRegistrationSet,
  type EvaluationHarnessDeployment,
  type EvidenceRepositoryWriter,
} from "@jinn-network/task-execution-evaluation-harness";
import { parserAllowlistEntries } from "./declarations.js";
import { createPredictionRegistration } from "./prediction.js";
import { createSweRebenchRegistration } from "./swe-rebench.js";

/** Claim-evidence bound: a capped grader log plus headroom, well under any repository limit. */
export const DEFAULT_MAX_CLAIM_EVIDENCE_BYTES = 4 * 1024 * 1024;

export interface EvaluatorDeploymentOptions {
  /** Host-owned evidence repository writer; this package never opens a repository itself. */
  readonly evidenceWriter: EvidenceRepositoryWriter;
  readonly maxClaimEvidenceBytes?: number;
  /** Logical grant handle resolved beneath the Attempt's `secrets/` at signing time. */
  readonly signerHandle?: string;
  readonly evaluatorId?: string;
}

/**
 * The host-facing composition surface: every adapter this package ships, plus the parser
 * allowlist the harness enforces for deterministic-process specs. The host injects the evidence
 * writer and authors the small ESM module the spawned harness loads through
 * `JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE` — this package ships no such module because only
 * the host owns a repository.
 */
export function createEvaluatorDeployment(
  options: EvaluatorDeploymentOptions,
): EvaluationHarnessDeployment {
  const registrations = validateEvaluatorRegistrationSet([
    createSweRebenchRegistration({
      ...(options.signerHandle === undefined ? {} : { signerHandle: options.signerHandle }),
      ...(options.evaluatorId === undefined ? {} : { evaluatorId: options.evaluatorId }),
    }),
    createPredictionRegistration({
      ...(options.signerHandle === undefined ? {} : { signerHandle: options.signerHandle }),
      ...(options.evaluatorId === undefined ? {} : { evaluatorId: options.evaluatorId }),
    }),
  ]);
  return Object.freeze({
    registrations,
    parserAllowlist: parserAllowlistEntries(),
    evidenceWriter: options.evidenceWriter,
    maxClaimEvidenceBytes: options.maxClaimEvidenceBytes ?? DEFAULT_MAX_CLAIM_EVIDENCE_BYTES,
  });
}
```

- [ ] **Step 4: Write the public surface**

`packages/task-execution/evaluator-adapters/src/index.ts` (replacing the Task 1 stub):

```ts
// SPDX-License-Identifier: Apache-2.0

export {
  PARSER_DECLARATION_FORMAT_URI,
  PARSER_DECLARATIONS,
  parserAllowlistEntries,
  parserDeclaration,
  parserDeclarationDocument,
  parserIdentity,
  type ParserDeclaration,
  type ParserFormat,
} from "./declarations.js";
export {
  createEvaluatorDeployment,
  DEFAULT_MAX_CLAIM_EVIDENCE_BYTES,
  type EvaluatorDeploymentOptions,
} from "./deployment.js";
export {
  assertGradeable,
  classifyInfrastructureFailure,
  INFRASTRUCTURE_SIGNATURES,
  toOperationalError,
} from "./infrastructure.js";
export { parseByFormat, parseJunitXml, parsePytestJsonReport, parseTap14 } from "./parsers/index.js";
export {
  createPredictionRegistration,
  PREDICTION_PARSER_ID,
  PREDICTION_REGISTRATION_ID,
} from "./prediction.js";
export {
  capLogTail,
  MAX_LOG_CHARACTERS,
  reduceTransitions,
  ReportParseError,
  type TestOutcomeReport,
  type Transitions,
  type TransitionOutcome,
} from "./report.js";
export { createSweRebenchRegistration, SWE_REBENCH_REGISTRATION_ID } from "./swe-rebench.js";
```

- [ ] **Step 5: Append the host-composition paragraph to the README**

```markdown
## Host composition

```ts
import { createEvaluatorDeployment } from "@jinn-network/task-execution-evaluator-adapters";

export const evaluationHarnessDeployment = createEvaluatorDeployment({
  evidenceWriter,                 // host-owned; this package never opens a repository
  signerHandle: "evaluator-signing-key",
});
```

The host writes that module and points the evaluation launcher at it through
`JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE`. The registrations are host-authored by construction:
no Task, EvaluationSpec, or launcher option can introduce one.
```

- [ ] **Step 6: Run the whole verification set**

Run:
```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/task-execution/evaluator-adapters"
yarn typecheck && yarn test && yarn check:parsers && yarn build && yarn pack:smoke
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071"
node --test .github/scripts/task-execution-package-inventory.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
node .github/scripts/task-execution-packed-types.test.mjs
```
Expected: every command PASSES, `pack:smoke` prints `Installed evaluator-adapters surface and dependency boundary verified.`

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/evaluator-adapters
git commit -m "feat(task-execution): compose the evaluator deployment and verify it end to end"
```

- [ ] **Step 8: Request the independent component review**

Per program §4 (stage 0: "independent review per new tree before dependents build on it"), open the PR train against `integration/evidence-v1` and request review with `superpowers:requesting-code-review`. The review brief must include the five design findings above so the reviewer checks the dispositions, not just the code.

---

## Hand-offs recorded (do not action here)

1. **Container execution owner** (finding 1) → stage 2 (`2026-07-30-cutover-stage-2-evaluator-flow.md`). The evaluator loop must provision the grader output the adapters parse, or the composition needs a process-runner deliverable it does not currently have.
2. **Prediction spec authoring** → stage 3 (`2026-07-30-cutover-stage-3-posting-flow.md`). `buildPredictionEvaluationSpec` is a fixture builder; the posting loop needs a production spec author.
3. **Grader-family taxonomy** (finding 3) → the profiles/TEP owning design: `deterministic-process` is the only home a pure-parse evaluation has, and its required `image` field has no meaning there.
4. **Stage-2 composition surface:** `createEvaluatorDeployment({ evidenceWriter, maxClaimEvidenceBytes?, signerHandle?, evaluatorId? })` returning `EvaluationHarnessDeployment`. The host writes the deployment module; this package ships none.
