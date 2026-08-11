# P3a′ — `@jinn-network/task-execution-oci-grader` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new platform package that runs a digest-pinned OCI grader image with a host-authored, digest-frozen grader program bind-mounted read-only, exposing a `GraderReportSource` the benchmark-product venue can inject — so container grading needs no per-instance image builds and no registry.

**Architecture:** The package is a leaf. It implements the *shipped* `GraderReportSource` port from `@jinn-network/task-execution-evaluator-adapters` (the same port `containerGraderReportSource` implements) with a different strategy: pull the upstream SWE-rebench eval image by digest, bind-mount a frozen grader program plus the sealed row material read-only, run bounded and confined, and read back one canonical `{report, log}` document. The design is adapted from the merged, reviewed `packages/policy-optimization/src/host-local/{grader-oci,swe-rebench-grader-source}.ts` (PR #2556), with four deliberate changes: an injected process spawner so every test runs without Docker; typed `EvaluationOperationalError` refusals instead of `HostStateError`; local canonical-JSON/digest helpers instead of `@jinn-network/policy-identity`; and a new first-class `graderProgramDigest` export.

**Tech Stack:** TypeScript 5.9 (ES2022, NodeNext-free "Bundler" resolution per the family template), Node 22, Vitest 4, Yarn 4.13 portal resolutions, `npm pack --ignore-scripts` packed-types smoke.

## Global Constraints

- **Package name:** `@jinn-network/task-execution-oci-grader`. **Path:** `packages/task-execution/oci-grader`. Both exact — the operator is registering this exact name as an npm trusted publisher.
- **Version** `0.1.0`. **`"type": "module"`.** **`"packageManager": "yarn@4.13.0"`.** **`"engines": { "node": ">=22" }`.** **`"license": "Apache-2.0"`** (family default; `evaluator-adapters` uses it).
- **Runtime dependencies — exactly these three, no others:** `@jinn-network/task-execution-evaluation-harness`, `@jinn-network/task-execution-evaluator-adapters`, `@jinn-network/task-execution-profiles`, all `"0.1.0"`. Every one must be portal-resolved in `resolutions`.
- **Forbidden, guard-enforced:** `@jinn-network/evidence-*`, `@jinn-network/attestation-issuer`, `@jinn-network/trust-*`, `@jinn-network/marketplace-*`, `viem`, `better-sqlite3`, `kubo-rpc-client` (`.github/scripts/task-execution-source-boundaries.test.mjs:28-55`). Also do **not** add `@jinn-network/policy-identity` — implement canonical JSON and sha256 locally instead.
- **No ambient network:** `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` are guard-forbidden in this family. This package never reaches the network itself; only the container runtime does.
- **Every file starts with** `// SPDX-License-Identifier: Apache-2.0`.
- **No Docker in any test.** Every test in this package passes on a machine with no container runtime installed. This is P3 acceptance #1 and it is non-negotiable.
- **American English** in identifiers, paths, and copy (repo Coding Rule 5).
- **No emoji anywhere.**
- **Do NOT touch `client/`.** The existing `client/src/daemon/native-evaluator-container-runtime.ts`, `client/deployments/evaluator/swe-rebench-v2-deployment.mjs`, and its `moduleDigest` stay exactly as they are. Any diff under `client/` is a plan violation.
- **Do NOT modify `packages/policy-optimization/`.** Its migration onto this package is a follow-up issue filed at PR time, not this PR.
- **Do NOT add the benchmark-product edge in this PR.** The `benchmark-product-source-boundaries.test.mjs` allowlist has a positive control (`:249-259`) that FAILS an allow-listed package with no real import. The consumer import lands in P3b, so the allowlist entry lands in P3b with it.
- **Base branch:** `integration/evidence-v1`. **Branch:** `claude/demo1-p3a-oci-grader`. **PR title prefix:** `feat(task-execution):`.

---

## File Structure

**New package** — `packages/task-execution/oci-grader/`

| File | Responsibility |
|---|---|
| `package.json` | Manifest; the three-dependency boundary the inventory guard pins. |
| `tsconfig.json`, `tsconfig.build.json` | Copied verbatim from `packages/task-execution/evaluator-adapters/`. |
| `README.md` | Charter, the trust story (what is digest-pinned vs build-pinned), authority links. |
| `scripts/pack-smoke.mjs` | Packs this package + its portal chain, compiles a consumer against the packed types, asserts the dependency boundary. |
| `src/index.ts` | The public surface. Nothing else is exported. |
| `src/errors.ts` | `refuse` / `unavailable` / `deadlineExceeded` — typed `EvaluationOperationalError` constructors. |
| `src/canonical.ts` | `canonicalJsonBytes`, `sha256Hex` — the two helpers replacing `@jinn-network/policy-identity`. |
| `src/private-fs.ts` | `ensurePrivateDirectory`, `secureRead` — no-follow, 0700/0600 filesystem primitives. |
| `src/invocation.ts` | `buildPinnedOciInvocation` — the pure argv builder. The security surface. |
| `src/runner.ts` | `ensurePinnedOciImage`, `runPinnedOciGrader` — the bounded, spawner-injected runner. |
| `src/grader-program.ts` | `SWE_REBENCH_OCI_GRADER_PROGRAM` (frozen bytes) + `graderProgramDigest`. |
| `src/swe-rebench-source.ts` | `sweRebenchOciGraderReportSource` — the `GraderReportSource` implementation. |
| `src/*.test.ts` | Colocated Vitest suites, one per module above. |

**Modified — registration surface**

| File | Change |
|---|---|
| `.github/scripts/task-execution-package-inventory.test.mjs` | `TASK_EXECUTION_PACKAGES` entry; count `10` → `11` at `:177`; approved-dependency-graph entry. |
| `.github/scripts/task-execution-packed-types.test.mjs` | Pack-input entry + expected-specifier entry. |
| `.github/scripts/task-execution-source-boundaries.test.mjs` | `taskExecutionDirectories` entry; new `OCI_GRADER_PRODUCTION_FORBIDDEN` const; new assertion block. |
| `.github/workflows/task-execution-ci.yml` | New `oci-grader` job on the dist-artifact chain. |
| `architecture/platform-packages.v1.json` | One catalog record; `platform-v1.expectedPackageCount` `51` → `52` at `:136`. |
| `architecture/generated/platform-topology.v1.json`, `architecture/generated/platform-topology.md` | Regenerated, never hand-edited. |

---

## Task 1: Atomic package Add — scaffold, catalog, guards, CI

This is one task because the guards are mutually referential: a package directory with no catalog record fails `platform-catalog`, and a catalog record with no manifest fails `architecture-control`. They must land together. The deliverable is a package that builds, tests, and packs with a trivial export, fully registered.

**Files:**
- Create: `packages/task-execution/oci-grader/package.json`
- Create: `packages/task-execution/oci-grader/tsconfig.json`
- Create: `packages/task-execution/oci-grader/tsconfig.build.json`
- Create: `packages/task-execution/oci-grader/README.md`
- Create: `packages/task-execution/oci-grader/scripts/pack-smoke.mjs`
- Create: `packages/task-execution/oci-grader/src/index.ts`
- Create: `packages/task-execution/oci-grader/src/index.test.ts`
- Create: `packages/task-execution/oci-grader/yarn.lock` (generated by `yarn install`, committed)
- Modify: `.github/scripts/task-execution-package-inventory.test.mjs`
- Modify: `.github/scripts/task-execution-packed-types.test.mjs`
- Modify: `.github/scripts/task-execution-source-boundaries.test.mjs`
- Modify: `.github/workflows/task-execution-ci.yml`
- Modify: `architecture/platform-packages.v1.json`
- Modify: `architecture/generated/platform-topology.v1.json`
- Modify: `architecture/generated/platform-topology.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `PACKAGE_VERSION: string` from `src/index.ts` (placeholder public surface so the packed-types consumer has something to compile against before Task 2). Later tasks add real exports to this same file.

- [ ] **Step 1: Write the failing test**

Create `packages/task-execution/oci-grader/src/index.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./index.js";

describe("@jinn-network/task-execution-oci-grader", () => {
  it("declares its package version", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-execution/oci-grader && yarn vitest run src/index.test.ts`
Expected: FAIL — the package does not resolve / `src/index.ts` does not exist.

- [ ] **Step 3: Create the package manifest**

Create `packages/task-execution/oci-grader/package.json`:

```json
{
  "name": "@jinn-network/task-execution-oci-grader",
  "version": "0.1.0",
  "description": "Host-owned OCI grader runner for the Jinn evaluation harness: runs a digest-pinned grader image with a digest-frozen grader program bind-mounted read-only, and exposes it as a GraderReportSource.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/task-execution/oci-grader"
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
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/task-execution-evaluation-harness": "0.1.0",
    "@jinn-network/task-execution-evaluator-adapters": "0.1.0",
    "@jinn-network/task-execution-profiles": "0.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/task-execution-evaluation-harness": "portal:../evaluation-harness",
    "@jinn-network/task-execution-evaluator-adapters": "portal:../evaluator-adapters",
    "@jinn-network/task-execution-profiles": "portal:../profiles",
    "@jinn-network/task-execution-supervisor": "portal:../backend-local/supervisor"
  }
}
```

The `supervisor` portal is a **resolution without a dependency** — `evaluator-adapters` depends on it, so the portal graph needs it resolvable. This mirrors how `evaluator-adapters` itself portals its transitives.

- [ ] **Step 4: Create the tsconfigs**

Create `packages/task-execution/oci-grader/tsconfig.json`:

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

Create `packages/task-execution/oci-grader/tsconfig.build.json`:

```json
{ "extends": "./tsconfig.json", "exclude": ["src/**/*.test.ts"] }
```

- [ ] **Step 5: Create the placeholder public surface**

Create `packages/task-execution/oci-grader/src/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/** This package's version, kept in step with package.json by `index.test.ts`. */
export const PACKAGE_VERSION = "0.1.0";
```

- [ ] **Step 6: Install and run the test**

Run:
```bash
cd packages/task-execution/oci-grader && yarn install && yarn vitest run src/index.test.ts
```
Expected: PASS. `yarn install` writes `yarn.lock`; it is committed.

- [ ] **Step 7: Create the pack-smoke script**

Create `packages/task-execution/oci-grader/scripts/pack-smoke.mjs` by copying `packages/task-execution/evaluator-adapters/scripts/pack-smoke.mjs` and making exactly these edits:

1. In `packageInputs`, keep the evidence and task-execution entries the portal chain needs and **append** this package last, replacing the `evaluator-adapters`-last entry:

```js
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
  [join(taskExecutionRoot, "evaluator-adapters"), "@jinn-network/task-execution-evaluator-adapters"],
  [packageRoot, "@jinn-network/task-execution-oci-grader"],
];
```

2. Replace the generated `packed-types.ts` body with:

```ts
import { PACKAGE_VERSION } from "@jinn-network/task-execution-oci-grader";
declare const version: string;
void (version = PACKAGE_VERSION);
```

3. Replace the `installedRoot` / `smoke.mjs` section so it asserts **this** package's boundary:

```js
const installedRoot = join(
  consumerRoot,
  "node_modules",
  "@jinn-network",
  "task-execution-oci-grader",
);
```

and inside the generated smoke script, replace the expected-dependency array with:

```js
const expected = [
  "@jinn-network/task-execution-evaluation-harness",
  "@jinn-network/task-execution-evaluator-adapters",
  "@jinn-network/task-execution-profiles",
].sort();
```

and replace the harness-export assertions with:

```js
const pkg = await import("@jinn-network/task-execution-oci-grader");
if (typeof pkg.PACKAGE_VERSION !== "string") {
  throw new Error("root runtime exports are incomplete");
}
```

Keep the `dist` test-leak check and the `README.md` read verbatim.

- [ ] **Step 8: Run the pack smoke**

Run: `cd packages/task-execution/oci-grader && yarn pack:smoke`
Expected: prints its success line and exits 0.

- [ ] **Step 9: Write the README**

Create `packages/task-execution/oci-grader/README.md`:

```markdown
# @jinn-network/task-execution-oci-grader

Host-owned OCI grader execution for the Jinn evaluation harness.

`@jinn-network/task-execution-evaluator-adapters` defines the `GraderReportSource`
port and deliberately never shells out. This package is one host-owned
implementation of that port: it runs a **digest-pinned** grader image with a
**digest-frozen** grader program bind-mounted read-only, and returns the single
canonical `{ report, log }` document the swe-rebench adapter parses.

It is the sibling of the package's own `containerGraderReportSource`, not a
replacement for it. The two differ in where the grading logic lives:

- `containerGraderReportSource` expects the grading logic to be baked into a
  per-instance image, so the image digest pre-commits the logic.
- This package mounts a fixed, separately-digested grader program into the
  unmodified upstream task image, so no per-instance image build and no
  container registry are required.

## Trust story

**Digest-pinned, verifiable from the sealed EvaluationSpec:** the task image
(`familyBlock.image`, refused unless it is an exact `sha256:` reference); the
grading parameters (`familyBlock.testMaterial`, re-verified against their
declared digest and re-checked as exact canonical JSON before use); the solver
patch (a digest-declared Result subject); the timeout (`familyBlock.timeout`,
the only deadline authority on this path).

**Build-pinned, NOT pre-committed by the specification:** the grader program
itself. `graderProgramDigest` is exported so a caller can freeze and publish it
at method-lock time and record it on every verdict, which binds a published
result to a specific grader even though the specification did not commit to it
in advance. Callers that need the grader logic under the specification's own
digest should bake it into a per-instance image and use
`containerGraderReportSource` instead.

## Never touches

The network (no `fetch`; only the container runtime reaches a registry), host
credentials or signer material (refused by path inspection before any mount),
evidence or trust packages, verdict signing (the caller seals verdicts).

## Authority

- `docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md` (ratified)
- `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (approved)
- `log/decisions/2026-07-30-platform-boundary-and-topology.md` (ratified)
```

- [ ] **Step 10: Register in the inventory guard**

In `.github/scripts/task-execution-package-inventory.test.mjs`:

Append to `TASK_EXECUTION_PACKAGES` (after the `evaluator-adapters` entry at `:22`):

```js
  ['oci-grader', '@jinn-network/task-execution-oci-grader'],
```

Change the count assertion at `:177` from `10` to `11`:

```js
  assert.equal(TASK_EXECUTION_PACKAGES.length, 11);
```

Append to the approved-dependency-graph map (after the `evaluator-adapters` entry ending at `:136`):

```js
  // oci-grader: host-owned OCI grader execution. Production surface is the GraderReportSource
  // port (evaluator-adapters), the EvaluationSpec vocabulary (profiles), and the operational
  // error + exact-material types (evaluation-harness). Nothing else — no evidence, no trust,
  // no backend, no chain or network client.
  ['oci-grader', {
    dependencies: [
      '@jinn-network/task-execution-evaluation-harness',
      '@jinn-network/task-execution-evaluator-adapters',
      '@jinn-network/task-execution-profiles',
    ],
    devDependencies: [],
    optionalDependencies: [], peerDependencies: [],
  }],
```

- [ ] **Step 11: Register in the packed-types guard**

In `.github/scripts/task-execution-packed-types.test.mjs`, append to the pack-input list (after `:24`):

```js
  [join(taskExecutionRoot, 'oci-grader'), '@jinn-network/task-execution-oci-grader'],
```

and append to the expected-specifier list (after `:51`):

```js
  '@jinn-network/task-execution-oci-grader',
```

- [ ] **Step 12: Register in the source-boundaries guard**

In `.github/scripts/task-execution-source-boundaries.test.mjs`:

Append `'oci-grader'` to `taskExecutionDirectories` (`:9-13`), so the line reads:

```js
  'evaluation-harness', 'evaluator-adapters', 'oci-grader',
```

Add this const immediately after `EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN`'s block (which ends near `:296`):

```js
// oci-grader is a leaf: it consumes the GraderReportSource port, the EvaluationSpec vocabulary,
// and the harness's operational-error/exact-material types. It never reaches a backend, a
// workspace, a launcher, or any evidence/trust/discovery package, and never touches the network
// itself — only the container runtime it spawns does.
const OCI_GRADER_PRODUCTION_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-workspace',
];
```

Add this assertion block immediately after the `evaluator-adapters` assertions (which end near `:425`):

```js
  const ociGraderSrc = join(packages, 'oci-grader', 'src');
  const ociGraderTests = files(ociGraderSrc)
    .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file));
  const ociGraderProduction = files(ociGraderSrc)
    .filter((file) => !ociGraderTests.includes(file));
  assert.deepEqual(
    forbiddenImportsInFiles(ociGraderProduction, OCI_GRADER_PRODUCTION_FORBIDDEN),
    [],
    'oci-grader production source crosses its approved contract boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(ociGraderTests, OCI_GRADER_PRODUCTION_FORBIDDEN),
    [],
    'oci-grader tests may import only the approved contract surface',
  );
```

- [ ] **Step 13: Run the three guards**

Run:
```bash
cd "$(git rev-parse --show-toplevel)"
node --test .github/scripts/task-execution-package-inventory.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
```
Expected: both PASS. (The packed-types guard is slow; it runs in Step 17.)

If the inventory guard reports a stale `repository.directory`, the manifest's `repository.directory` must read exactly `packages/task-execution/oci-grader`.

- [ ] **Step 14: Add the catalog record**

In `architecture/platform-packages.v1.json`, insert this record into `packages` immediately after the `@jinn-network/task-execution-evaluator-adapters` record (which ends at `:3402`), preserving the file's two-space indentation:

```json
    {
      "name": "@jinn-network/task-execution-oci-grader",
      "path": "packages/task-execution/oci-grader",
      "domain": "task-execution",
      "role": "host-owned OCI grader execution",
      "tier": 3,
      "classification": "platform",
      "stability": "candidate",
      "authority": {
        "documents": [
          {
            "path": "docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md",
            "status": "ratified"
          },
          {
            "path": "docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md",
            "status": "approved"
          }
        ],
        "decisionRecord": {
          "path": "log/decisions/2026-07-30-platform-boundary-and-topology.md",
          "status": "ratified"
        }
      },
      "releaseGroup": "platform-v1",
      "publishPolicy": "canary-only",
      "ownerGroup": "architecture-control",
      "requiredGateIds": [
        "task-execution-ci"
      ],
      "boundaryPolicy": {
        "kind": "source-boundary",
        "path": ".github/scripts/task-execution-source-boundaries.test.mjs"
      },
      "publicSurface": {
        "schemas": [],
        "profiles": [],
        "fixtures": [],
        "conformance": []
      },
      "supersedes": [],
      "replacedBy": []
    },
```

Change `releaseGroups.platform-v1.expectedPackageCount` at `:136` from `51` to `52`.

- [ ] **Step 15: Regenerate the architecture artifacts**

Run:
```bash
cd "$(git rev-parse --show-toplevel)"
node .github/scripts/generate-architecture.mjs
node .github/scripts/generate-architecture.mjs --check
```
Expected: the generator rewrites `architecture/generated/platform-topology.v1.json` and `platform-topology.md`; `--check` then exits 0. Never hand-edit those two files — if `--check` fails, re-run the generator.

- [ ] **Step 16: Add the CI job**

In `.github/workflows/task-execution-ci.yml`, add an `oci-grader` job modelled exactly on the existing `evaluator-adapters` job. It must:
- `needs:` the jobs producing the distributions it restores — protocol, backend, profiles, supervisor, workspace, launchers, evaluation-harness, evaluator-adapters (match the `evaluator-adapters` job's own `needs` list, plus `evaluator-adapters` itself).
- Restore each of those `*-dist` artifacts with the same `actions/download-artifact` step names the sibling jobs use.
- Run, in `packages/task-execution/oci-grader`: `yarn install --immutable`, `yarn typecheck`, `yarn test`, `yarn build`, `yarn pack:smoke`.
- Not upload a distribution (nothing downstream in this workflow consumes it).

Also add `packages/task-execution/oci-grader/**` to the workflow's `paths:` filters (both `push` and `pull_request`), alongside the existing `packages/task-execution/**` entry if that entry is not already a covering wildcard — check before adding a redundant line.

- [ ] **Step 17: Run the packed-types guard and the full local chain**

Run:
```bash
cd "$(git rev-parse --show-toplevel)"
node --test .github/scripts/task-execution-packed-types.test.mjs
node --test .github/scripts/platform-catalog.test.mjs
node --test .github/scripts/architecture-control.test.mjs
```
Expected: all PASS.

- [ ] **Step 18: Commit**

```bash
git add packages/task-execution/oci-grader .github/scripts .github/workflows/task-execution-ci.yml architecture
git commit -m "feat(task-execution): register the oci-grader package with its guard trio and CI job"
```

---

## Task 2: The pure OCI invocation builder

**Files:**
- Create: `packages/task-execution/oci-grader/src/errors.ts`
- Create: `packages/task-execution/oci-grader/src/private-fs.ts`
- Create: `packages/task-execution/oci-grader/src/invocation.ts`
- Create: `packages/task-execution/oci-grader/src/invocation.test.ts`
- Modify: `packages/task-execution/oci-grader/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `refuse(detail: string): never`, `unavailable(detail: string, cause?: unknown): never`, `deadlineExceeded(detail: string, cause?: unknown): never` from `./errors.js`.
  - `ensurePrivateDirectory(path: string): string`, `secureRead(path: string): Uint8Array` from `./private-fs.js`.
  - `interface PinnedOciGraderInput { runtime: "docker" | "podman"; image: string; platform: "linux/amd64" | "linux/arm64"; inputs: readonly { source: string; targetName: string }[]; outputDirectory: string; command: readonly [string, ...string[]]; entrypoint?: string; timeoutMs: number; profileRequiresNetwork: boolean; allowedNetwork?: string }`
  - `interface PinnedOciInvocation { command: "docker" | "podman"; args: readonly string[]; containerName: string; statementPath: string }`
  - `function buildPinnedOciInvocation(input: PinnedOciGraderInput): PinnedOciInvocation`
  - `const PINNED_IMAGE: RegExp` (exported for the runner's reuse).

- [ ] **Step 1: Write the failing test**

Create `packages/task-execution/oci-grader/src/invocation.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPinnedOciInvocation, type PinnedOciGraderInput } from "./invocation.js";

const IMAGE = `example.registry/sweb.eval.x86_64.acme__widget-1@sha256:${"a".repeat(64)}`;

function scratch(): { root: string; inputFile: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), "jinn-oci-grader-"));
  const inputs = join(root, "inputs");
  const output = join(root, "output");
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const inputFile = join(inputs, "config.json");
  writeFileSync(inputFile, "{}", { mode: 0o600 });
  return { root, inputFile, output };
}

function baseInput(overrides: Partial<PinnedOciGraderInput> = {}): PinnedOciGraderInput {
  const { inputFile, output } = scratch();
  return {
    runtime: "docker",
    image: IMAGE,
    platform: "linux/amd64",
    inputs: [{ source: inputFile, targetName: "config.json" }],
    outputDirectory: output,
    command: ["/jinn/input/grader.py"],
    entrypoint: "python3",
    timeoutMs: 60_000,
    profileRequiresNetwork: false,
    ...overrides,
  };
}

describe("buildPinnedOciInvocation", () => {
  it("builds a shell-free, confined, network-none argv with the image last", () => {
    const invocation = buildPinnedOciInvocation(baseInput());

    expect(invocation.command).toBe("docker");
    expect(invocation.args[0]).toBe("run");
    expect(invocation.args).toContain("--rm");
    expect(invocation.args).toContain("--read-only");
    expect(invocation.args).toContain("no-new-privileges");
    expect(invocation.args.slice(invocation.args.indexOf("--network"))[1]).toBe("none");
    expect(invocation.args.slice(invocation.args.indexOf("--cap-drop"))[1]).toBe("ALL");
    expect(invocation.args.at(-1)).toBe("/jinn/input/grader.py");
    expect(invocation.args.at(-2)).toBe(IMAGE);
    expect(invocation.containerName).toMatch(/^jinn-oci-grader-[0-9a-f-]{36}$/u);
    expect(invocation.statementPath.endsWith("/verdict")).toBe(true);
  });

  it("mounts every declared input read-only under /jinn/input and the output writable", () => {
    const invocation = buildPinnedOciInvocation(baseInput());
    const mounts = invocation.args.filter((_, index) => invocation.args[index - 1] === "--mount");

    expect(mounts.some((mount) =>
      mount.endsWith(",dst=/jinn/input/config.json,readonly"))).toBe(true);
    expect(mounts.some((mount) =>
      mount.endsWith(",dst=/jinn/out") && !mount.includes("readonly"))).toBe(true);
  });

  it("refuses an image that is not pinned by sha256 digest", () => {
    expect(() => buildPinnedOciInvocation(baseInput({ image: "swerebench/sweb.eval:latest" })))
      .toThrow(/pinned by sha256 digest/u);
  });

  it("refuses an unsafe or duplicated mount target", () => {
    const { inputFile, output } = scratch();
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [
        { source: inputFile, targetName: "config.json" },
        { source: inputFile, targetName: "config.json" },
      ],
      outputDirectory: output,
    }))).toThrow(/unsafe or duplicated/u);
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [{ source: inputFile, targetName: "../escape" }],
      outputDirectory: output,
    }))).toThrow(/unsafe or duplicated/u);
  });

  it("refuses credential-shaped and symlinked inputs before anything is mounted", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-oci-grader-secret-"));
    const output = join(root, "output");
    mkdirSync(output, { mode: 0o700 });
    const secret = join(root, ".ssh");
    writeFileSync(secret, "key", { mode: 0o600 });
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [{ source: secret, targetName: "config.json" }],
      outputDirectory: output,
    }))).toThrow(/credential or signer material/u);

    const real = join(root, "real.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    const link = join(root, "link.json");
    symlinkSync(real, link);
    expect(() => buildPinnedOciInvocation(baseInput({
      inputs: [{ source: link, targetName: "config.json" }],
      outputDirectory: output,
    }))).toThrow(/symbolic link|credential or signer material/u);
  });

  it("refuses host networking and an unbounded timeout", () => {
    expect(() => buildPinnedOciInvocation(baseInput({
      profileRequiresNetwork: true, allowedNetwork: "host",
    }))).toThrow(/network is disabled/u);
    expect(() => buildPinnedOciInvocation(baseInput({ timeoutMs: 0 })))
      .toThrow(/positive bounded duration/u);
    expect(() => buildPinnedOciInvocation(baseInput({ timeoutMs: 3_600_001 })))
      .toThrow(/positive bounded duration/u);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-execution/oci-grader && yarn vitest run src/invocation.test.ts`
Expected: FAIL — `Cannot find module './invocation.js'`.

- [ ] **Step 3: Write the typed error constructors**

Create `packages/task-execution/oci-grader/src/errors.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { EvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";

/**
 * A refusal: the specification, or the material it points at, cannot be graded by this source and
 * retrying will not change that. `do-not-retry` keeps a malformed specification out of the retry
 * loop, which is what makes the ungradeable classification honest.
 */
export function refuse(detail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "FAILED_PRECONDITION",
    reason: "unsupported-specification",
    recoveryAdvice: "do-not-retry",
    safeDetail: `oci grader refusal: ${detail}`,
  });
}

/** The host or its container runtime could not serve this attempt. A fresh attempt may succeed. */
export function unavailable(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "UNAVAILABLE",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: `oci grader unavailable: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The specification's own timeout elapsed while the grader ran. */
export function deadlineExceeded(detail: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "DEADLINE_EXCEEDED",
    reason: "provider-unavailable",
    recoveryAdvice: "new-attempt-required",
    safeDetail: `oci grader deadline: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** A declared subject's bytes do not match the digest the specification sealed. */
export function refuseSubjectDigest(detail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "INVALID_ARGUMENT",
    reason: "subject-digest-mismatch",
    recoveryAdvice: "do-not-retry",
    safeDetail: `oci grader subject refusal: ${detail}`,
  });
}
```

- [ ] **Step 4: Write the private filesystem primitives**

Create `packages/task-execution/oci-grader/src/private-fs.ts`. Port `ensurePrivateDirectory` and `secureRead` from `packages/policy-optimization/src/host-local/state.ts:60-107`, with two changes: drop the `resolveRootAlias` call (this package takes absolute paths only), and raise the typed errors from `./errors.js` instead of `HostStateError`.

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync,
  mkdirSync, openSync, readFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { refuse, unavailable } from "./errors.js";

function refuseSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    refuse(`grader path "${path}" is a symbolic link`);
  }
}

/** Creates (or adopts) a 0700 directory, refusing any symlink in its lineage. */
export function ensurePrivateDirectory(path: string): string {
  if (!isAbsolute(path)) refuse("grader path must be absolute");
  const absolute = resolve(path);
  const lineage: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    lineage.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const directory of lineage) {
    if (existsSync(directory)) {
      refuseSymlink(directory);
      if (!lstatSync(directory).isDirectory()) {
        refuse("grader path crosses a non-directory");
      }
      continue;
    }
    mkdirSync(directory, { mode: 0o700 });
    refuseSymlink(directory);
  }
  if (!lstatSync(absolute).isDirectory()) refuse("grader path is not a directory");
  chmodSync(absolute, 0o700);
  return absolute;
}

/** Exact no-follow read of a regular file. */
export function secureRead(path: string): Uint8Array {
  const absolute = resolve(path);
  refuseSymlink(absolute);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) refuse("grader artifact is not a regular file");
    return new Uint8Array(readFileSync(descriptor));
  } catch (cause) {
    if (cause instanceof Error && cause.name === "EvaluationOperationalError") throw cause;
    unavailable("grader output could not be read", cause);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
```

- [ ] **Step 5: Write the invocation builder**

Create `packages/task-execution/oci-grader/src/invocation.ts`. Port `buildPinnedOciInvocation`, `assertNoSymlinksOrSecrets`, `PINNED_IMAGE`, `SAFE_TARGET`, and `SECRET_SEGMENT` from `packages/policy-optimization/src/host-local/grader-oci.ts:20-23, 46-66, 75-143`, with these changes: raise `refuse` from `./errors.js` instead of `HostStateError`; rename the container prefix from `jinn-optimize-grader-` to `jinn-oci-grader-`; import `ensurePrivateDirectory` from `./private-fs.js`.

```ts
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { refuse } from "./errors.js";
import { ensurePrivateDirectory } from "./private-fs.js";

/** A grader image is identified by its digest, never a mutable tag. */
export const PINNED_IMAGE = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u;
const SAFE_TARGET = /^\/jinn\/(?:input\/[a-z0-9][a-z0-9._-]*|out)$/u;
const SECRET_SEGMENT = /^(?:\.aws|\.config|\.docker|\.gnupg|\.ssh|credentials?|keys?|secrets?)$/iu;
const MAX_TIMEOUT_MS = 3_600_000;

export interface PinnedOciGraderInput {
  readonly runtime: "docker" | "podman";
  readonly image: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly inputs: readonly { readonly source: string; readonly targetName: string }[];
  readonly outputDirectory: string;
  readonly command: readonly [string, ...string[]];
  /** Overrides an image's deployment entrypoint with a reviewed executable inside the image. */
  readonly entrypoint?: string;
  readonly timeoutMs: number;
  readonly profileRequiresNetwork: boolean;
  /** Must be an explicit isolated runtime network, never `host`. */
  readonly allowedNetwork?: string;
}

export interface PinnedOciInvocation {
  readonly command: "docker" | "podman";
  readonly args: readonly string[];
  readonly containerName: string;
  readonly statementPath: string;
}

function assertNoSymlinksOrSecrets(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) refuse("grader input contains a symbolic link");
  if (SECRET_SEGMENT.test(basename(path))) {
    refuse("credential or signer material cannot enter the grader sandbox");
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) assertNoSymlinksOrSecrets(join(path, entry));
}

/** Pure command builder so the security posture is reviewable and testable without a daemon. */
export function buildPinnedOciInvocation(input: PinnedOciGraderInput): PinnedOciInvocation {
  if (!PINNED_IMAGE.test(input.image)) refuse("grader image must be pinned by sha256 digest");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) {
    refuse("grader timeout must be a positive bounded duration");
  }
  if (input.command.length === 0 || input.command.some((part) => part.length === 0)) {
    refuse("grader command is empty");
  }
  if (input.entrypoint !== undefined
    && (input.entrypoint.length === 0 || /[ \r\n]/u.test(input.entrypoint))) {
    refuse("grader entrypoint is invalid");
  }
  const network = input.profileRequiresNetwork ? input.allowedNetwork : "none";
  if (network === undefined || network === "" || network === "host") {
    refuse("network is disabled unless the profile explicitly requires an isolated network");
  }
  const output = ensurePrivateDirectory(input.outputDirectory);
  assertNoSymlinksOrSecrets(output);
  const mounts: string[] = [];
  const targets = new Set<string>();
  for (const item of input.inputs) {
    const target = `/jinn/input/${item.targetName}`;
    if (!SAFE_TARGET.test(target) || targets.has(target)) {
      refuse("grader input target is unsafe or duplicated");
    }
    assertNoSymlinksOrSecrets(item.source);
    const source = realpathSync(item.source);
    targets.add(target);
    mounts.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
  }
  const containerName = `jinn-oci-grader-${randomUUID()}`;
  const args = [
    "run", "--rm", "--pull", "never", "--name", containerName,
    "--platform", input.platform,
    "--network", network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "4g",
    "--cpus", "2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m",
    "--env", "HOME=/tmp/jinn-grader-home",
    ...mounts,
    "--mount", `type=bind,src=${output},dst=/jinn/out`,
    ...(input.entrypoint === undefined ? [] : ["--entrypoint", input.entrypoint]),
    input.image,
    ...input.command,
  ];
  return { command: input.runtime, args, containerName, statementPath: join(output, "verdict") };
}
```

Note the one deliberate ordering change from the source: `assertNoSymlinksOrSecrets(item.source)` runs **before** `realpathSync`, so a symlinked input is refused as a symlink rather than silently resolved. The test in Step 1 pins this.

- [ ] **Step 6: Export from the public surface**

In `packages/task-execution/oci-grader/src/index.ts`, append:

```ts
export {
  buildPinnedOciInvocation,
  PINNED_IMAGE,
  type PinnedOciGraderInput,
  type PinnedOciInvocation,
} from "./invocation.js";
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/task-execution/oci-grader && yarn vitest run && yarn typecheck`
Expected: all PASS, zero type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/task-execution/oci-grader/src
git commit -m "feat(task-execution): pure pinned-OCI invocation builder with typed refusals"
```

---

## Task 3: The bounded, spawner-injected runner

The source spawns `docker` directly, which makes its runner untestable without a daemon. This task adds an injected spawner — the pattern already proven in `client/test/daemon/native-evaluator-container-runtime.test.ts` — so the whole runner is covered with no Docker present.

**Files:**
- Create: `packages/task-execution/oci-grader/src/runner.ts`
- Create: `packages/task-execution/oci-grader/src/runner.test.ts`
- Modify: `packages/task-execution/oci-grader/src/index.ts`

**Interfaces:**
- Consumes: `buildPinnedOciInvocation`, `PINNED_IMAGE`, `PinnedOciGraderInput` from `./invocation.js`; `secureRead` from `./private-fs.js`; `refuse`, `unavailable`, `deadlineExceeded` from `./errors.js`.
- Produces:
  - `interface GraderChildProcess { readonly pid?: number; on(event: "exit", listener: (code: number | null) => void): unknown; on(event: "error", listener: (error: Error) => void): unknown; kill(signal: NodeJS.Signals): boolean }`
  - `type GraderProcessSpawner = (command: string, args: readonly string[]) => GraderChildProcess`
  - `interface PinnedOciRunnerOptions { readonly spawn?: GraderProcessSpawner; readonly dockerPath?: string }`
  - `function ensurePinnedOciImage(input: { runtime: "docker" | "podman"; image: string; platform: "linux/amd64" | "linux/arm64"; timeoutMs: number }, options?: PinnedOciRunnerOptions): Promise<void>`
  - `function runPinnedOciGrader(input: PinnedOciGraderInput, options?: PinnedOciRunnerOptions): Promise<Uint8Array>`

- [ ] **Step 1: Write the failing test**

Create `packages/task-execution/oci-grader/src/runner.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePinnedOciImage,
  runPinnedOciGrader,
  type GraderChildProcess,
  type GraderProcessSpawner,
} from "./runner.js";
import type { PinnedOciGraderInput } from "./invocation.js";

const IMAGE = `example.registry/sweb.eval.x86_64.acme__widget-1@sha256:${"b".repeat(64)}`;

class FakeChild extends EventEmitter implements GraderChildProcess {
  killed: NodeJS.Signals | undefined;
  kill(signal: NodeJS.Signals): boolean {
    this.killed = signal;
    return true;
  }
  exit(code: number | null): void {
    queueMicrotask(() => this.emit("exit", code));
  }
  fail(error: Error): void {
    queueMicrotask(() => this.emit("error", error));
  }
}

function recordingSpawner(children: FakeChild[]): {
  spawn: GraderProcessSpawner;
  calls: { command: string; args: readonly string[] }[];
} {
  const calls: { command: string; args: readonly string[] }[] = [];
  let index = 0;
  return {
    calls,
    spawn: (command, args) => {
      calls.push({ command, args });
      const child = children[index++];
      if (child === undefined) throw new Error("spawner ran out of pre-seeded children");
      return child;
    },
  };
}

function scratchInput(): PinnedOciGraderInput {
  const root = mkdtempSync(join(tmpdir(), "jinn-oci-runner-"));
  const inputs = join(root, "inputs");
  const output = join(root, "output");
  mkdirSync(inputs, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const config = join(inputs, "config.json");
  writeFileSync(config, "{}", { mode: 0o600 });
  return {
    runtime: "docker",
    image: IMAGE,
    platform: "linux/amd64",
    inputs: [{ source: config, targetName: "config.json" }],
    outputDirectory: output,
    command: ["/jinn/input/grader.py"],
    entrypoint: "python3",
    timeoutMs: 5_000,
    profileRequiresNetwork: false,
  };
}

describe("ensurePinnedOciImage", () => {
  it("skips the pull when the digest is already present locally", async () => {
    const inspect = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect]);
    const promise = ensurePinnedOciImage(
      { runtime: "docker", image: IMAGE, platform: "linux/amd64", timeoutMs: 60_000 },
      { spawn },
    );
    inspect.exit(0);
    await promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["image", "inspect", IMAGE]);
  });

  it("pulls by digest then positively re-inspects when absent", async () => {
    const missing = new FakeChild();
    const pull = new FakeChild();
    const verify = new FakeChild();
    const { spawn, calls } = recordingSpawner([missing, pull, verify]);
    const promise = ensurePinnedOciImage(
      { runtime: "docker", image: IMAGE, platform: "linux/amd64", timeoutMs: 60_000 },
      { spawn },
    );
    missing.exit(1);
    await Promise.resolve();
    pull.exit(0);
    await Promise.resolve();
    verify.exit(0);
    await promise;

    expect(calls.map((call) => call.args[0])).toEqual(["image", "pull", "image"]);
    expect(calls[1]!.args).toEqual(["pull", "--platform", "linux/amd64", IMAGE]);
  });

  it("refuses an unpinned image before spawning anything", async () => {
    const { spawn, calls } = recordingSpawner([]);
    await expect(ensurePinnedOciImage(
      { runtime: "docker", image: "swerebench/sweb.eval:latest", platform: "linux/amd64", timeoutMs: 60_000 },
      { spawn },
    )).rejects.toThrow(/pinned by sha256 digest/u);
    expect(calls).toHaveLength(0);
  });
});

describe("runPinnedOciGrader", () => {
  it("returns the exact bytes the container left at the statement path", async () => {
    const input = scratchInput();
    const inspect = new FakeChild();
    const run = new FakeChild();
    const { spawn } = recordingSpawner([inspect, run]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.exit(0);
    await Promise.resolve();
    writeFileSync(join(input.outputDirectory, "verdict"), '{"log":"ok","report":{}}', { mode: 0o600 });
    run.exit(0);

    expect(new TextDecoder().decode(await promise)).toBe('{"log":"ok","report":{}}');
  });

  it("reports a nonzero grader exit as unavailable, not as a graded outcome", async () => {
    const input = scratchInput();
    const inspect = new FakeChild();
    const run = new FakeChild();
    const { spawn } = recordingSpawner([inspect, run]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.exit(0);
    await Promise.resolve();
    run.exit(3);

    await expect(promise).rejects.toThrow(/grader failed/u);
  });

  it("kills and force-removes a container that outruns its bound, then reports the deadline", async () => {
    const input = { ...scratchInput(), timeoutMs: 20 };
    const inspect = new FakeChild();
    const run = new FakeChild();
    const remover = new FakeChild();
    const { spawn, calls } = recordingSpawner([inspect, run, remover]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    remover.exit(0);

    await expect(promise).rejects.toThrow(/bounded time/u);
    expect(run.killed).toBe("SIGKILL");
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["rm", "-f"]);
  });

  it("reports a runtime that cannot be spawned as unavailable", async () => {
    const input = scratchInput();
    const inspect = new FakeChild();
    const { spawn } = recordingSpawner([inspect]);
    const promise = runPinnedOciGrader(input, { spawn });
    inspect.fail(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));

    await expect(promise).rejects.toThrow(/runtime is unavailable/u);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-execution/oci-grader && yarn vitest run src/runner.test.ts`
Expected: FAIL — `Cannot find module './runner.js'`.

- [ ] **Step 3: Write the runner**

Create `packages/task-execution/oci-grader/src/runner.ts`. Port `runtimeExecutable`, `boundedRuntimeExit`, `ensurePinnedOciImage`, and `runPinnedOciGrader` from `packages/policy-optimization/src/host-local/grader-oci.ts:25-43, 145-257`, with these changes: every spawn goes through the injected `GraderProcessSpawner`; refusals use `./errors.js`; the isolated-network creation path is preserved verbatim.

```ts
// SPDX-License-Identifier: Apache-2.0

import { spawn as nodeSpawn } from "node:child_process";
import { constants, accessSync, realpathSync } from "node:fs";
import { deadlineExceeded, refuse, unavailable } from "./errors.js";
import { buildPinnedOciInvocation, PINNED_IMAGE, type PinnedOciGraderInput } from "./invocation.js";
import { secureRead } from "./private-fs.js";

/** The minimal live-child surface this runner drives; `ChildProcess` satisfies it structurally. */
export interface GraderChildProcess {
  readonly pid?: number;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

/** Injected process launcher. Default spawns the real runtime CLI, shell-free. */
export type GraderProcessSpawner = (
  command: string,
  args: readonly string[],
) => GraderChildProcess;

export interface PinnedOciRunnerOptions {
  readonly spawn?: GraderProcessSpawner;
  /** Absolute path to the runtime CLI when it is not on the daemon's inherited PATH. */
  readonly dockerPath?: string;
}

const RUNTIME_CANDIDATES: Readonly<Record<"docker" | "podman", readonly string[]>> = {
  docker: [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ],
  podman: ["/usr/local/bin/podman", "/opt/homebrew/bin/podman", "/usr/bin/podman"],
};

function runtimeExecutable(runtime: "docker" | "podman", override?: string): string {
  if (override !== undefined) return override;
  for (const candidate of RUNTIME_CANDIDATES[runtime]) {
    try {
      const exact = realpathSync(candidate);
      accessSync(exact, constants.X_OK);
      return exact;
    } catch {
      // Try the next host-owned installation root; never consult task material.
    }
  }
  return runtime;
}

function defaultSpawn(command: string, args: readonly string[]): GraderChildProcess {
  return nodeSpawn(command, [...args], {
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  }) as GraderChildProcess;
}

async function boundedExit(input: {
  readonly runtime: "docker" | "podman";
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly options: PinnedOciRunnerOptions;
}): Promise<{ readonly code: number | null; readonly timedOut: boolean }> {
  const spawn = input.options.spawn ?? defaultSpawn;
  const executable = input.options.spawn === undefined
    ? runtimeExecutable(input.runtime, input.options.dockerPath)
    : input.runtime;
  let child: GraderChildProcess;
  try {
    child = spawn(executable, input.args);
  } catch (cause) {
    unavailable("grader runtime is unavailable", cause);
  }
  return new Promise<{ code: number | null; timedOut: boolean }>((resolveExit, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    timer.unref?.();
    child.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.on("exit", (code) => { clearTimeout(timer); resolveExit({ code, timedOut }); });
  }).catch((cause: unknown) => unavailable("grader runtime is unavailable", cause));
}

/** Fetches only an exact digest and positively re-inspects it before any grading may begin. */
export async function ensurePinnedOciImage(
  input: {
    readonly runtime: "docker" | "podman";
    readonly image: string;
    readonly platform: "linux/amd64" | "linux/arm64";
    readonly timeoutMs: number;
  },
  options: PinnedOciRunnerOptions = {},
): Promise<void> {
  if (!PINNED_IMAGE.test(input.image)) refuse("grader image must be pinned by sha256 digest");
  const timeoutMs = Math.min(3_600_000, Math.max(60_000, input.timeoutMs));
  const inspect = () => boundedExit({
    runtime: input.runtime,
    args: ["image", "inspect", input.image],
    timeoutMs: Math.min(30_000, timeoutMs),
    options,
  });
  const existing = await inspect();
  if (!existing.timedOut && existing.code === 0) return;
  const pulled = await boundedExit({
    runtime: input.runtime,
    args: ["pull", "--platform", input.platform, input.image],
    timeoutMs,
    options,
  });
  if (pulled.timedOut || pulled.code !== 0) unavailable("pinned grader image is unavailable");
  const verified = await inspect();
  if (verified.timedOut || verified.code !== 0) {
    unavailable("pinned grader image could not be verified locally");
  }
}

/** Runs one bounded grader and returns only the exact bytes it left on the output mount. */
export async function runPinnedOciGrader(
  input: PinnedOciGraderInput,
  options: PinnedOciRunnerOptions = {},
): Promise<Uint8Array> {
  await ensurePinnedOciImage(input, options);
  let ownedNetwork: string | undefined;
  if (input.profileRequiresNetwork && input.allowedNetwork === undefined) {
    ownedNetwork = `jinn-oci-grader-network-${crypto.randomUUID()}`;
    const created = await boundedExit({
      runtime: input.runtime,
      args: ["network", "create", "--driver", "bridge", ownedNetwork],
      timeoutMs: Math.min(30_000, input.timeoutMs),
      options,
    });
    if (created.timedOut || created.code !== 0) {
      unavailable("isolated grader network could not be created");
    }
  }
  try {
    const invocation = buildPinnedOciInvocation({
      ...input,
      ...(ownedNetwork === undefined ? {} : { allowedNetwork: ownedNetwork }),
    });
    const exit = await boundedExit({
      runtime: invocation.command,
      args: invocation.args,
      timeoutMs: input.timeoutMs,
      options,
    });
    if (exit.timedOut) {
      await boundedExit({
        runtime: input.runtime,
        args: ["rm", "-f", invocation.containerName],
        timeoutMs: Math.min(30_000, input.timeoutMs),
        options,
      });
      deadlineExceeded("grader exceeded its bounded time");
    }
    if (exit.code !== 0) unavailable("grader failed");
    return secureRead(invocation.statementPath);
  } finally {
    if (ownedNetwork !== undefined) {
      const removed = await boundedExit({
        runtime: input.runtime,
        args: ["network", "rm", ownedNetwork],
        timeoutMs: Math.min(30_000, input.timeoutMs),
        options,
      });
      if (removed.timedOut || removed.code !== 0) {
        unavailable("isolated grader network could not be removed");
      }
    }
  }
}
```

- [ ] **Step 4: Export from the public surface**

In `packages/task-execution/oci-grader/src/index.ts`, append:

```ts
export {
  ensurePinnedOciImage,
  runPinnedOciGrader,
  type GraderChildProcess,
  type GraderProcessSpawner,
  type PinnedOciRunnerOptions,
} from "./runner.js";
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/task-execution/oci-grader && yarn vitest run && yarn typecheck`
Expected: all PASS, zero type errors. Confirm the suite passes with no container runtime on PATH.

- [ ] **Step 6: Commit**

```bash
git add packages/task-execution/oci-grader/src
git commit -m "feat(task-execution): bounded pinned-OCI runner with an injected spawner"
```

---

## Task 4: The frozen grader program and its first-class digest

This task carries the operator-ratified credibility upgrade: the grader program is a stable canonical artifact whose digest is exportable, freezable, and publishable at method-lock time, before any official cell runs.

**Files:**
- Create: `packages/task-execution/oci-grader/src/canonical.ts`
- Create: `packages/task-execution/oci-grader/src/grader-program.ts`
- Create: `packages/task-execution/oci-grader/src/grader-program.test.ts`
- Modify: `packages/task-execution/oci-grader/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `canonicalJsonBytes(value: unknown): Uint8Array`, `sha256Hex(bytes: Uint8Array): string` from `./canonical.js`.
  - `SWE_REBENCH_OCI_GRADER_PROGRAM: string`, `SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES: Uint8Array`, `graderProgramDigest(): \`sha256:${string}\`` from `./grader-program.js`.

- [ ] **Step 1: Write the failing test**

Create `packages/task-execution/oci-grader/src/grader-program.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  graderProgramDigest,
  SWE_REBENCH_OCI_GRADER_PROGRAM,
  SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES,
} from "./grader-program.js";

describe("the frozen swe-rebench grader program", () => {
  it("is a python program that writes its report to the output mount", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM.startsWith("#!/usr/bin/env python3")).toBe(true);
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM).toContain('OUT = pathlib.Path("/jinn/out")');
  });

  it("exposes its exact UTF-8 bytes", () => {
    expect(SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES).toEqual(
      new TextEncoder().encode(SWE_REBENCH_OCI_GRADER_PROGRAM),
    );
  });

  it("digests exactly those bytes, prefixed, and is stable across calls", () => {
    const expected = `sha256:${createHash("sha256")
      .update(SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES)
      .digest("hex")}`;

    expect(graderProgramDigest()).toBe(expected);
    expect(graderProgramDigest()).toBe(graderProgramDigest());
    expect(graderProgramDigest()).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("is frozen: the digest matches the value published at method lock", () => {
    // LOCK FREEZE. This literal is the grader program's published identity. Changing the program
    // changes the science: any edit MUST be a deliberate, reviewed change that re-publishes the
    // digest in the locked method document before the next official cell runs. Never "just
    // update the expected value" to make this test green.
    expect(graderProgramDigest()).toBe("sha256:<FILL FROM STEP 5>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-execution/oci-grader && yarn vitest run src/grader-program.test.ts`
Expected: FAIL — `Cannot find module './grader-program.js'`.

- [ ] **Step 3: Write the canonical helpers**

Create `packages/task-execution/oci-grader/src/canonical.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { refuse } from "./errors.js";

/**
 * Canonical JSON: sorted object keys, no insignificant whitespace, UTF-8 bytes. This is the same
 * spelling the sealed row material uses, so a re-serialization can be compared byte-for-byte
 * against the bytes whose digest the specification committed to.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  refuse("canonical JSON cannot encode this value");
}

/** Lowercase hex sha256 of exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
```

Key sorting uses code-unit comparison to match the repo's `compareCodeUnitStrings` convention, not `localeCompare`.

- [ ] **Step 4: Write the frozen grader program module**

Create `packages/task-execution/oci-grader/src/grader-program.ts`.

The program body is a **byte-exact copy** of `SWE_REBENCH_OCI_GRADER_PROGRAM` from `packages/policy-optimization/src/host-local/swe-rebench-grader-source.ts:39` through the closing backtick of that `String.raw` template (read the exact range before copying; do not retype it, and do not reflow, reindent, or "clean up" a single character — the digest is the artifact).

```ts
// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "./canonical.js";

/**
 * The reviewed program mounted read-only into the already-pinned task image. It copies the
 * image's repository into the grader-only output mount, applies only the exact solver and public
 * test patches, runs the source row's commands with network disabled by the outer host, and emits
 * one canonical unsigned raw report. No host path, credential, or signer material enters it.
 *
 * FROZEN ARTIFACT. This program is the grading logic, and it is NOT pre-committed by the
 * EvaluationSpec — it is pinned by `graderProgramDigest()` instead. That digest is published in
 * the locked method document before any official cell runs, and recorded on every verdict. Any
 * edit to these bytes is a change to the measuring instrument: it requires a deliberate review,
 * a new published digest, and an updated lock-freeze expectation in `grader-program.test.ts`.
 */
export const SWE_REBENCH_OCI_GRADER_PROGRAM = String.raw`#!/usr/bin/env python3
...COPY BYTE-EXACT FROM THE SOURCE RANGE ABOVE...
`;

/** The program's exact UTF-8 bytes — what the digest covers and what the mount receives. */
export const SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES: Uint8Array =
  new TextEncoder().encode(SWE_REBENCH_OCI_GRADER_PROGRAM);

const DIGEST = `sha256:${sha256Hex(SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES)}` as const;

/**
 * The grader program's published identity. Freeze this at method lock, print it in the report,
 * and record it on every verdict so a published result binds to a specific grader.
 */
export function graderProgramDigest(): `sha256:${string}` {
  return DIGEST;
}
```

- [ ] **Step 5: Fill the lock-freeze expectation**

Run:
```bash
cd packages/task-execution/oci-grader
node --input-type=module -e "
import { graderProgramDigest } from './src/grader-program.ts';
" 2>/dev/null || npx tsx -e "
import { graderProgramDigest } from './src/grader-program.js';
console.log(graderProgramDigest());
"
```

If neither runs cleanly, get the value from the failing assertion instead: run the test once and read the `received` value Vitest prints. Paste that exact value into the `<FILL FROM STEP 5>` placeholder in `grader-program.test.ts`. **Report this digest in the PR body** — the operator publishes it at lock.

- [ ] **Step 6: Export from the public surface**

In `packages/task-execution/oci-grader/src/index.ts`, append:

```ts
export { canonicalJsonBytes, sha256Hex } from "./canonical.js";
export {
  graderProgramDigest,
  SWE_REBENCH_OCI_GRADER_PROGRAM,
  SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES,
} from "./grader-program.js";
```

- [ ] **Step 7: Run the tests**

Run: `cd packages/task-execution/oci-grader && yarn vitest run && yarn typecheck`
Expected: all PASS including the lock-freeze assertion.

- [ ] **Step 8: Commit**

```bash
git add packages/task-execution/oci-grader/src
git commit -m "feat(task-execution): freeze the swe-rebench grader program and export its digest"
```

---

## Task 5: The `GraderReportSource` implementation

**Files:**
- Create: `packages/task-execution/oci-grader/src/swe-rebench-source.ts`
- Create: `packages/task-execution/oci-grader/src/swe-rebench-source.test.ts`
- Modify: `packages/task-execution/oci-grader/src/index.ts`

**Interfaces:**
- Consumes: `runPinnedOciGrader`, `PinnedOciRunnerOptions` from `./runner.js`; `SWE_REBENCH_OCI_GRADER_PROGRAM`, `graderProgramDigest` from `./grader-program.js`; `canonicalJsonBytes`, `sha256Hex` from `./canonical.js`; `refuse`, `refuseSubjectDigest` from `./errors.js`.
- Produces:
  - `const SWE_REBENCH_PUBLIC_NETWORK_EXTENSION: "network.jinn.oci-grader.requires-public-network"`
  - `function exactSweRebenchTestCommands(input: { logParser: string; commands: readonly string[] }): string[]`
  - `function pinnedSweRebenchImage(specification: EvaluationSpec): { image: string; platform: "linux/amd64" | "linux/arm64"; timeoutMs: number }`
  - `interface SweRebenchOciGraderSourceOptions { runtime?: "docker" | "podman"; attemptWorkRoot?: () => string; runner?: PinnedOciRunnerOptions }`
  - `function sweRebenchOciGraderReportSource(options?: SweRebenchOciGraderSourceOptions): GraderReportSource`

Note the extension key is **renamed** from policy-optimization's `network.jinn.policy-optimization.requires-public-network` to `network.jinn.oci-grader.requires-public-network`, because this package is not policy-optimization. P3b's specs must use the new key.

- [ ] **Step 1: Write the failing test**

Create `packages/task-execution/oci-grader/src/swe-rebench-source.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes, sha256Hex } from "./canonical.js";
import {
  exactSweRebenchTestCommands,
  pinnedSweRebenchImage,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
  sweRebenchOciGraderReportSource,
} from "./swe-rebench-source.js";

const IMAGE_DIGEST = "c".repeat(64);
const IMAGE = `example.registry/sweb.eval.x86_64.acme__widget-1@sha256:${IMAGE_DIGEST}`;

const ROW = {
  FAIL_TO_PASS: ["tests/test_a.py::test_a"],
  PASS_TO_PASS: ["tests/test_b.py::test_b"],
  base_commit: "0".repeat(40),
  image_name: "swerebench/sweb.eval.x86_64.acme__widget-1",
  install_config: { install: ["pip install -e ."], log_parser: "parse_log_pytest", test_cmd: ["pytest -rA"] },
  instance_id: "acme__widget-1",
  repo: "acme/widget",
  test_patch: "diff --git a/tests/test_a.py b/tests/test_a.py\n",
};

function specification(overrides: Record<string, unknown> = {}) {
  const material = canonicalJsonBytes(ROW);
  return {
    family: "deterministic-process" as const,
    familyBlock: {
      image: { name: "swe-rebench-grader-image", uri: `docker://${IMAGE}`, digest: { sha256: IMAGE_DIGEST } },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [{
        name: "swe-rebench-evaluation-row",
        content: Buffer.from(material).toString("base64"),
        digest: { sha256: sha256Hex(material) },
        mediaType: "application/json",
      }],
      transitions: { failToPass: ROW.FAIL_TO_PASS, passToPass: ROW.PASS_TO_PASS },
      timeout: 1800,
      ...overrides,
    },
  } as never;
}

function request(spec = specification()) {
  const work = mkdtempSync(join(tmpdir(), "jinn-oci-src-"));
  return {
    work,
    request: {
      specification: spec,
      task: { bytes: new Uint8Array(), descriptor: { name: "task", digest: { sha256: "d".repeat(64) } } },
      results: [{
        bytes: new TextEncoder().encode("diff --git a/x b/x\n"),
        descriptor: { name: "result.patch", digest: { sha256: "e".repeat(64) } },
      }],
      attempt: { attemptUri: "urn:jinn:attempt:1", attemptNumber: 1 },
      deadlineSignal: new AbortController().signal,
    } as never,
  };
}

describe("pinnedSweRebenchImage", () => {
  it("accepts an exact docker:// sha256 reference and converts the timeout to milliseconds", () => {
    expect(pinnedSweRebenchImage(specification())).toEqual({
      image: IMAGE, platform: "linux/amd64", timeoutMs: 1_800_000,
    });
  });

  it("refuses a mutable tag", () => {
    expect(() => pinnedSweRebenchImage(specification({
      image: { uri: "docker://swerebench/sweb.eval:latest" },
    }))).toThrow(/exact docker sha256 reference/u);
  });
});

describe("exactSweRebenchTestCommands", () => {
  it("passes the benchmark's own commands through unchanged", () => {
    expect(exactSweRebenchTestCommands({ logParser: "parse_log_pytest", commands: ["pytest -rA"] }))
      .toEqual(["pytest -rA"]);
  });

  it("refuses an unsupported log parser and an empty command", () => {
    expect(() => exactSweRebenchTestCommands({ logParser: "parse_log_other", commands: ["x"] }))
      .toThrow(/unsupported sealed log parser/u);
    expect(() => exactSweRebenchTestCommands({ logParser: "parse_log_pytest", commands: [] }))
      .toThrow(/empty or invalid/u);
  });
});

describe("sweRebenchOciGraderReportSource", () => {
  it("runs the pinned image with network none and returns the canonical report and log", async () => {
    const { work, request: input } = request();
    const runner = vi.fn(async (invocation: { outputDirectory: string }) => {
      writeFileSync(join(invocation.outputDirectory, "verdict"),
        canonicalJsonBytes({ log: "1 passed", report: { instance_id: "acme__widget-1" } }));
      return canonicalJsonBytes({ log: "1 passed", report: { instance_id: "acme__widget-1" } });
    });
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: runner,
    } as never);

    const report = await source.read(input);

    expect(report.log).toBe("1 passed");
    expect(report.report).toEqual({ instance_id: "acme__widget-1" });
    const call = runner.mock.calls[0]![0] as { image: string; profileRequiresNetwork: boolean; entrypoint: string };
    expect(call.image).toBe(IMAGE);
    expect(call.profileRequiresNetwork).toBe(false);
    expect(call.entrypoint).toBe("python3");
  });

  it("mounts the frozen grader program, the config, the patch and the test patch", async () => {
    const { work, request: input } = request();
    const runner = vi.fn(async () => canonicalJsonBytes({ log: "", report: {} }));
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work, runPinnedOciGraderForTesting: runner,
    } as never);

    await source.read(input);

    const call = runner.mock.calls[0]![0] as { inputs: { targetName: string }[] };
    expect(call.inputs.map((entry) => entry.targetName).sort())
      .toEqual(["config.json", "grader.py", "patch.diff", "test-patch.diff"]);
  });

  it("refuses row material whose bytes do not match its declared digest", async () => {
    const spec = specification();
    (spec as never as { familyBlock: { testMaterial: { digest: { sha256: string } }[] } })
      .familyBlock.testMaterial[0]!.digest.sha256 = "f".repeat(64);
    const { work, request: input } = request(spec);
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/row material digest/u);
  });

  it("refuses a specification carrying no row material", async () => {
    const { work, request: input } = request(specification({ testMaterial: [] }));
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/no exact public row material/u);
  });

  it("refuses grader output that is not exact canonical JSON", async () => {
    const { work, request: input } = request();
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => new TextEncoder().encode('{ "report": {}, "log": "" }'),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/not exact canonical data/u);
  });

  it("refuses more or fewer than exactly one solver patch Result", async () => {
    const { work, request: input } = request();
    (input as never as { results: unknown[] }).results = [];
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/exactly one solver patch Result/u);
  });

  it("keeps the public-network extension opt-in and refuses a non-true value", async () => {
    const { work, request: input } = request(
      specification({ [SWE_REBENCH_PUBLIC_NETWORK_EXTENSION]: "yes" }),
    );
    const source = sweRebenchOciGraderReportSource({
      attemptWorkRoot: () => work,
      runPinnedOciGraderForTesting: async () => canonicalJsonBytes({ log: "", report: {} }),
    } as never);

    await expect(source.read(input)).rejects.toThrow(/public-network extension is not true/u);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-execution/oci-grader && yarn vitest run src/swe-rebench-source.test.ts`
Expected: FAIL — `Cannot find module './swe-rebench-source.js'`.

- [ ] **Step 3: Write the grader source**

Create `packages/task-execution/oci-grader/src/swe-rebench-source.ts`. Port `rowMaterial`, `decodeCanonicalBase64`, `stringArray`, `exactSweRebenchTestCommands`, `profileRequiresPublicNetwork`, `patchResult`, `pinnedSweRebenchImage`, `exactRawReport`, and `liveSweRebenchGraderReportSource` from `packages/policy-optimization/src/host-local/swe-rebench-grader-source.ts:230-452`, with these changes:

1. Drop `LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN` and `LOCAL_SWE_REBENCH_EVALUATION_METHOD` entirely — the caller supplies its own method descriptor.
2. Replace `@jinn-network/policy-identity`'s `canonicalJsonBytes` / `prefixedDigest` with `./canonical.js`'s `canonicalJsonBytes` / `sha256Hex` (note `prefixedDigest(x)` becomes `` `sha256:${sha256Hex(x)}` ``).
3. Replace `fail(...)` with `refuse(...)` from `./errors.js`, except the row-material digest mismatch, which uses `refuseSubjectDigest(...)`.
4. Rename the exported function to `sweRebenchOciGraderReportSource` and the options interface to `SweRebenchOciGraderSourceOptions`.
5. Rename the network extension constant value to `network.jinn.oci-grader.requires-public-network`.
6. Import `SWE_REBENCH_OCI_GRADER_PROGRAM` from `./grader-program.js` rather than declaring it inline.
7. Add a `runPinnedOciGraderForTesting?: typeof runPinnedOciGrader` option, defaulting to the real `runPinnedOciGrader`, so the source is testable with no Docker. Thread `options.runner` into the real call.
8. Thread the runner options through: `runner: options.runner`.

The `read` body keeps the source's exact structure — `mkdtempSync` under the attempt work root, four `writeFileSync` calls with `flag: "wx"` and modes `0o600`/`0o500`, the `runPinnedOciGrader` call, `deadlineSignal.throwIfAborted()`, and the `finally { rmSync(root, { recursive: true, force: true }) }`.

- [ ] **Step 4: Export from the public surface**

In `packages/task-execution/oci-grader/src/index.ts`, append:

```ts
export {
  exactSweRebenchTestCommands,
  pinnedSweRebenchImage,
  SWE_REBENCH_PUBLIC_NETWORK_EXTENSION,
  sweRebenchOciGraderReportSource,
  type SweRebenchOciGraderSourceOptions,
} from "./swe-rebench-source.js";
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/task-execution/oci-grader && yarn vitest run && yarn typecheck`
Expected: all PASS, zero type errors, no Docker required.

- [ ] **Step 6: Commit**

```bash
git add packages/task-execution/oci-grader/src
git commit -m "feat(task-execution): swe-rebench GraderReportSource over the pinned-OCI runner"
```

---

## Task 6: Public-surface freeze and the full local chain

**Files:**
- Modify: `packages/task-execution/oci-grader/src/index.ts`
- Create: `packages/task-execution/oci-grader/src/public-surface.test.ts`
- Modify: `packages/task-execution/oci-grader/scripts/pack-smoke.mjs`
- Modify: `packages/task-execution/oci-grader/README.md`

**Interfaces:**
- Consumes: every export produced by Tasks 2-5.
- Produces: nothing new; this task pins what is already there.

- [ ] **Step 1: Write the failing test**

Create `packages/task-execution/oci-grader/src/public-surface.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as surface from "./index.js";

describe("public surface", () => {
  it("exports exactly the frozen set, in sorted order", () => {
    expect(Object.keys(surface).sort()).toEqual([
      "PACKAGE_VERSION",
      "PINNED_IMAGE",
      "SWE_REBENCH_OCI_GRADER_PROGRAM",
      "SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES",
      "SWE_REBENCH_PUBLIC_NETWORK_EXTENSION",
      "buildPinnedOciInvocation",
      "canonicalJsonBytes",
      "ensurePinnedOciImage",
      "exactSweRebenchTestCommands",
      "graderProgramDigest",
      "pinnedSweRebenchImage",
      "runPinnedOciGrader",
      "sha256Hex",
      "sweRebenchOciGraderReportSource",
    ]);
  });

  it("produces a GraderReportSource-shaped object", () => {
    const source = surface.sweRebenchOciGraderReportSource();
    expect(typeof source.read).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd packages/task-execution/oci-grader && yarn vitest run src/public-surface.test.ts`
Expected: FAIL if any export drifted from the list. If it passes immediately, that is fine — the test is a freeze, not a driver.

- [ ] **Step 3: Reconcile the surface**

If the test failed, fix `src/index.ts` so the exported names match the list exactly. Do not widen the list to accommodate an accidental export — remove the accidental export instead.

- [ ] **Step 4: Strengthen the pack-smoke consumer**

In `packages/task-execution/oci-grader/scripts/pack-smoke.mjs`, replace the generated `packed-types.ts` body from Task 1 with one that compiles against the real surface:

```ts
import {
  buildPinnedOciInvocation,
  graderProgramDigest,
  runPinnedOciGrader,
  sweRebenchOciGraderReportSource,
  type PinnedOciGraderInput,
  type PinnedOciInvocation,
} from "@jinn-network/task-execution-oci-grader";

declare const input: PinnedOciGraderInput;
declare const invocation: PinnedOciInvocation;
const digest: `sha256:${string}` = graderProgramDigest();
void input;
void invocation;
void digest;
void buildPinnedOciInvocation;
void runPinnedOciGrader;
void sweRebenchOciGraderReportSource;
```

and replace the runtime export check with:

```js
const pkg = await import("@jinn-network/task-execution-oci-grader");
if (
  typeof pkg.buildPinnedOciInvocation !== "function" ||
  typeof pkg.sweRebenchOciGraderReportSource !== "function" ||
  !/^sha256:[a-f0-9]{64}$/.test(pkg.graderProgramDigest())
) {
  throw new Error("root runtime exports are incomplete");
}
```

- [ ] **Step 5: Record the frozen digest in the README**

Append to `packages/task-execution/oci-grader/README.md`:

```markdown
## Published grader program digest

    <PASTE THE VALUE FROM TASK 4 STEP 5>

Frozen at method lock. `src/grader-program.test.ts` fails if these bytes move.
```

- [ ] **Step 6: Run the full local chain**

Run, from the repo root:

```bash
cd packages/task-execution/oci-grader && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd "$(git rev-parse --show-toplevel)"
node --test .github/scripts/task-execution-package-inventory.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
node --test .github/scripts/task-execution-packed-types.test.mjs
node --test .github/scripts/platform-catalog.test.mjs
node --test .github/scripts/architecture-control.test.mjs
node .github/scripts/generate-architecture.mjs --check
```

Expected: every command exits 0. Capture this transcript — it is the PR body's local full-chain verification.

Then confirm nothing outside the intended surface moved:

```bash
git status --short
git diff --stat origin/integration/evidence-v1 -- client packages/policy-optimization packages/benchmark-product
```
Expected: the second command prints nothing. Any output is a Global Constraints violation.

- [ ] **Step 7: Commit**

```bash
git add packages/task-execution/oci-grader
git commit -m "test(task-execution): freeze the oci-grader public surface and packed-types consumer"
```

---

## Self-Review

**Spec coverage.** Ruling requirements → tasks: new task-execution package (T1); pull-and-mount adapted from #2556 (T2, T3, T5); no registry / no per-instance builds (implicit — nothing in the plan builds or pushes an image); `graderProgramDigest` freezable and publishable at lock, recorded per verdict (T4, plus the digest surfaces to P3b through the public export in T6); client untouched (Global Constraints + T6 Step 6 assertion); no-Docker tests (T2, T3, T5 all spawner- or runner-injected); typed ungradeable path preserved (T2 `errors.ts`, exercised in T5); catalog/guards/CI/topology (T1). Ratified residual risks: the digest pull before `--pull never` is `ensurePinnedOciImage` (T3); `profileRequiresNetwork` staying false is asserted in T5's first and last tests; the policy-optimization migration issue and the venue-side pull step are P3b/PR-time items, correctly out of this plan.

**Placeholder scan.** Two intentional fill-ins remain, both with an explicit procedure that produces the value: the lock-freeze digest (T4 Step 5 computes it; T6 Step 5 records it) and the byte-exact Python program copy (T4 Step 4 names the exact source range and forbids reflowing). Neither is a "TODO" — each is a value that can only be produced by running the preceding step. Everything else carries real code.

**Type consistency.** `PinnedOciGraderInput` / `PinnedOciInvocation` are defined once in T2 and consumed unchanged in T3, T5, T6. `refuse` / `unavailable` / `deadlineExceeded` / `refuseSubjectDigest` are defined in T2 and used in T3 and T5. `canonicalJsonBytes` / `sha256Hex` are defined in T4 and used in T5 — T4 must therefore land before T5, which the ordering respects. One fixed inconsistency: T4's test imports `canonical.js` indirectly via `grader-program.js`, so `canonical.ts` is created in T4 even though `errors.ts` (its import) comes from T2 — the dependency runs backwards in file-creation order but forwards in task order, which is correct.

## Out of scope for this plan (P3b)

The benchmark-product-core dependency edge, the `CORE_ALLOWED_JINN_PACKAGES` allowlist entry, the `benchmark-product-ci.yml` portal build-order insertion, the venue's generated deployment module, the venue-side `ensurePinnedOciImage` call, and the per-verdict recording of `graderProgramDigest()` all land in P3b, stacked on this branch.
