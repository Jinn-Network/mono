# C2 — Environment Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Date:** 2026-07-31
- **Component:** C2 of the verified-environment supply program
  ([`2026-07-31-supply-program.md`](2026-07-31-supply-program.md))
- **Design (law):** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  §5 (the attestation), §6 (the capability), §12 (non-goals). Commit `5b0739832`.
- **Evidence base:** [`../notes/2026-07-31-task-supply-research-findings.md`](../notes/2026-07-31-task-supply-research-findings.md) §9.
- **Branch:** `supply/c2-environment-verification`, based on `supply/c1-environment-record`
  (which bases on `integration/evidence-v1`). PR targets its base branch, never integration.

**Goal:** ship `@jinn-network/environment-verification` — the tier-3 capability that executes
the K-run protocol against a described environment and produces a DSSE-sealed in-toto
attestation stating exactly one bounded fact: *K consecutive runs of the record's declared
test scope produced identical outcome-sets under the declared controls*. Failures are
first-class products of the same function: `unstable` (divergence) and `error`
(infrastructure) are signed and returned, never thrown away.

**Architecture:** one pure core, one thin driver, ports for everything that touches the
world.

- The **predicate** is a closed Zod schema whose cross-field rules make the design's
  honesty rules mechanically unforgeable: `runs`/`baseline` present iff `result != "error"`;
  `stable` requires every per-run digest to equal the canonical one; `unstable` requires a
  populated divergence block; in-toto DigestSet values are bare hex while scalar digest
  fields are `sha256:`-prefixed, and each form rejects the other.
- The **subject** is always a fixed 2-tuple `[environment, image]`, so the design's
  normative subject-match rule (§5.1) is expressible as one exported function rather than a
  convention consumers may forget.
- `verifyEnvironment` is a **driver over ports**: pull by digest, K fresh containers, compare
  outcome-sets by set equality (never timing), store the outcome maps through the artifact
  port, seal through the injected signer. It holds no key material, opens no socket, reads
  no file.
- The **import source** builds candidate records from upstream rows by grouping on the
  *full* record identity tuple; divergence in any component splits the group, so a record can
  never attest a test scope some of its rows never declared.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:`
resolutions); zod 4.4.3; `@jinn-network/trust-core` (DSSE, JCS, hashing, RFC 3339);
`@jinn-network/environment-record` (C1); vitest 4.

---

## Global constraints

Copied from the program plan §5; these bind every task below.

1. **Designs are law** (contract 1). The spec is `5b0739832`. A defect discovered while
   implementing is a Finding with a proposed disposition appended to this plan's
   §Findings — never a silent patch.
2. **Kits and fixtures precede implementations** (contract 2). Within this plan: the
   predicate schema and its fixture corpus (T5–T6) are green before `verifyEnvironment`
   (T8–T9) is written; the assembled conformance kit (T12) is green before this branch is
   reported complete.
3. **Sealing is re-implemented per package** (contract 3) — that rule owns the *record*
   sealing and belongs to C1. This package does **not** re-implement record sealing; it
   calls C1's `sealEnvironmentRecord`. DSSE attestation sealing reuses `trust/core`
   unchanged, exactly as design §5.1 directs ("reusing `trust/core` seal/verify and the
   `attestation-issuer` statement-building pattern").
4. **Custody law** (contract 4). No key material, no ambient authority. `process.env` never
   appears in `src/`. `fetch`/`WebSocket`/`node:http`/`node:net`/`child_process` never appear
   in `src/`. `node:fs/promises` appears in exactly one production file,
   `src/staged-state-store.ts`, which takes its directory as an argument (explicit, not
   ambient), plus the fixture loaders in `src/testing.ts`. Signer is a `DsseSigner` object;
   the package never sees bytes of a private key. Fail closed.
5. **No product names in tiers 1–3** (contract 5). The identifiers `plugin`, `jinn-plugin`,
   `operator`, `autopilot`, `daemon`, `client` must not appear in source, exports, or
   dependencies. No import of `@jinn-network/core`, `@jinn-network/plugin`,
   `@jinn-network/jinn-layer`, or anything under `client/`.
6. **Digest discipline** (contract 6). Record-body and scalar predicate digests are
   `sha256:`-prefixed lowercase hex; in-toto DigestSet values (subjects and
   ResourceDescriptors) are **bare** lowercase hex. `toDigestSet` / `fromDigestSet` are the
   only sanctioned crossings, and the confusion fixture ships in this package's kit.
7. **Bounded claims** (contract 8). No API name, doc comment, README line, or log string in
   this package says "deterministic", or says "verified"/"guaranteed" without the K +
   controls qualification the spec gives those words. The result values are `stable` /
   `unstable` / `error`; the compared object is an *outcome-set*. A test enforces this
   (T12 step 5).
8. **Guards ship with the package** (contract 9). C1 owns `packages/environments/`'s guard
   trio and CI; C2 registers itself into all three and into the workflow, and lands the one
   guard amendment its file store needs.
9. **TDD per task; verification before completion** (contract 10). Every task ends with
   `yarn typecheck && yarn test` in the package plus the tree guards, outputs shown, before
   the task is reported done.
10. **Stop on missing Consumes** (contract 11). Every symbol this plan consumes from
    `supply/c1-environment-record` or from `integration/evidence-v1` is named exactly below.
    A symbol that is not on the base branch is a stop-and-report, not an improvisation.
11. **Legacy is reference only** (contract 12). `client/src/solver-types/_swe-rebench-v2-*.ts`
    may be read and never imported. The staged state machine and the failure taxonomy here
    are rewrites with their own tests, over this package's own closed vocabulary.
12. Node `>=22`; `"type": "module"`; every relative import carries the `.js` extension.
    No `localeCompare`, no `Intl` in production source — use `compareCodeUnitStrings` from
    `@jinn-network/trust-core`.

---

## Consumed interfaces (verify before Task 1)

**From `supply/c1-environment-record` — `@jinn-network/environment-record`** (program §4
"C1 produces"):

| Symbol | Used by |
| --- | --- |
| `EnvironmentRecord` (parsed type) | ports, verify, import source |
| `sealEnvironmentRecord(record): Uint8Array` | verify (subject digest), import source |
| `parseEnvironmentRecord(bytes)` | import source (round-trip validation) |
| `environmentRecordDigest(bytes): string` (`sha256:`-prefixed) | verify (subject digest) |
| `CommandSpecSchema` (shell-free `{bin, args, cwd?, env?}`) | ports (`CommandSpec` type), import source |

Record **field** names come from design §4.2 and are read as: `record.source.repo`,
`record.source.commit`, `record.image.manifestDigest`, `record.image.platform`,
`record.image.reference`, `record.workspace`, `record.invocations.install`,
`record.invocations.test`, `record.parser`, `record.rights`, `record.lineage`. A divergence
between C1's parsed shape and these paths is a stop-and-report.

**From `integration/evidence-v1` — `@jinn-network/trust-core`** (all verified present on
`origin/integration/evidence-v1` at `34a7b3cbd`, `packages/trust/core/src/`):

| Symbol | Source file | Used by |
| --- | --- | --- |
| `sealSignedRecord(input): Promise<SealedRecord>` | `dsse.ts:316` | verify (seals the statement) |
| `SealedRecord` (`{envelopeBytes, payloadBytes, recordDigest}`) | `dsse.ts:303` | verify |
| `DsseSigner`, `DsseSigningRequest`, `DsseProducedSignature` | `dsse.ts:281–292` | ports, kit |
| `parseDsseEnvelope`, `dssePreAuthEncoding` | `dsse.ts:29,153` | kit |
| `DSSE_PAYLOAD_TYPE` (`application/vnd.in-toto+json`) | `identifiers.ts` | verify, kit |
| `IN_TOTO_STATEMENT_TYPE` (`https://in-toto.io/Statement/v1`) | `identifiers.ts` | statement |
| `canonicalJsonBytes(value): Uint8Array` | `canonical-json.ts:182` | outcome sets, staged state |
| `recordDigest(bytes): Sha256Digest`, `sha256Hex(bytes)` | `hashing.ts` | outcome sets, import grouping |
| `Sha256Digest` type | `types.ts:12` | everywhere |
| `isCalendarStrictRfc3339(value)` | `rfc3339.ts:84` | predicate schema |
| `compareCodeUnitStrings(left, right)` | `order.ts:12` | staged state ordering, import grouping |

**From `integration/evidence-v1` — `@jinn-network/trust-testing`** (devDependency only,
never a runtime dependency): `createEoaTestSigner(seed): EoaTestSigner` (`crypto.ts:60`) —
real deterministic secp256k1/EIP-191 signatures, used by this package's own tests to drive
the kit against genuine keys (design §5.5: "Kit exercises DSSE verification against
trust/core test keys").

**`@jinn-network/attestation-issuer` is a pattern source, not a dependency.** Its
`src/statement.ts` builds an in-toto Statement by assembling
`{_type, subject, predicateType, predicate}` and then `safeParse`-ing it against a closed
schema, throwing with the first issue's JSON path. That pattern is copied into
`src/statement.ts` here. It is **not imported**: its public surface
(`packages/evidence/attestation-issuer/src/index.ts`) exports no statement builder — only
`prepareResultEvaluation`, `prepareExecutionVerification`, `commitPreparedAttestation`,
`parsePreparedAttestation` — and design §3.3 gives verification exactly two package edges
(`environments/record`, `trust/core`).

---

## File structure

All paths relative to `packages/environments/verification/`.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `README.md` | package scaffold |
| `scripts/pack-smoke.mjs` | tarball shape + packed-import smoke |
| `src/identifiers.ts` | predicate type, protocol URI, `MINIMUM_RUN_COUNT`, timeout default |
| `src/errors.ts` | `EnvironmentVerificationError`, `invalidInput`, `conformanceFailure` |
| `src/digests.ts` | prefixed/bare-hex schemas, `DigestSet`, `ResourceDescriptor`, `toDigestSet`, `fromDigestSet` |
| `src/outcome-set.ts` | `OutcomeSet`, canonical bytes, digest, set equality, tally |
| `src/failures.ts` | stages, closed reason taxonomy, four-way disposition mapping |
| `src/predicate.ts` | `EnvironmentVerificationPredicateSchema` + presence/consistency rules |
| `src/subject.ts` | `buildEnvironmentVerificationSubjects` (bare-hex DigestSets) |
| `src/statement.ts` | statement schema, builder, `attestationMatchesRecord`, `verifyBaselineCounts` |
| `src/ports.ts` | `ContainerRuntime`, `ArtifactStore`, `Clock`, `VerificationDeps`, `CommandSpec` |
| `src/verify.ts` | `verifyEnvironment`, `DEFAULT_VERIFICATION_CONTROLS`, `SealedAttestation` |
| `src/import-source.ts` | `UpstreamEnvironmentRow`, `buildEnvironmentCandidatesFromRows` |
| `src/staged-state.ts` | pure staged-job algebra + `StagedStateStore` port |
| `src/staged-state-store.ts` | `createFileStagedStateStore` — atomic write, resumable |
| `src/index.ts` | public surface |
| `src/testing.ts` | fakes + `describeEnvironmentVerificationConformance` + fixture loaders |
| `fixtures/predicate-v1/*.json` | golden + adversarial predicate corpus |
| `fixtures/attestations-v1/*.json` | golden statements the kit pins byte-for-byte |

Repo files this plan also edits (created by C1 on the base branch):
`.github/scripts/environments-package-inventory.test.mjs`,
`.github/scripts/environments-source-boundaries.test.mjs`,
`.github/scripts/environments-packed-types.test.mjs`,
`.github/workflows/environments-ci.yml`.

---

### Task 1: Scaffold the package and register it with the tree guards

**Files:**
- Create: `packages/environments/verification/package.json`, `tsconfig.json`,
  `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `README.md`, `src/index.ts`,
  `scripts/pack-smoke.mjs`
- Modify: `.github/scripts/environments-package-inventory.test.mjs`,
  `.github/scripts/environments-source-boundaries.test.mjs`,
  `.github/scripts/environments-packed-types.test.mjs`,
  `.github/workflows/environments-ci.yml`

**Interfaces:**
- Consumes: the `packages/environments/` tree, its guard trio, and
  `.github/workflows/environments-ci.yml` — all from `supply/c1-environment-record`. If any
  of those four files is absent on the base branch, **stop and report** (contract 11).
- Produces: the package directory publishing `@jinn-network/environment-verification` with
  exports `.`, `./testing`, `./fixtures/*`.

- [ ] **Step 1: Confirm the base branch actually carries C1's tree and guards**

Run:
```bash
git -C . rev-parse --abbrev-ref HEAD
ls packages/environments/record/package.json
ls .github/scripts/environments-package-inventory.test.mjs \
   .github/scripts/environments-source-boundaries.test.mjs \
   .github/scripts/environments-packed-types.test.mjs \
   .github/workflows/environments-ci.yml
node -e "const j=require('./packages/environments/record/package.json');console.log(j.name, j.version, JSON.stringify(j.exports))"
```
Expected: branch is `supply/c2-environment-verification`; every path exists; the package
name prints `@jinn-network/environment-record 0.1.0`. Any miss → stop and report.

- [ ] **Step 2: Register the package in the inventory guard so it fails**

Read `.github/scripts/environments-package-inventory.test.mjs` first. It follows the house
shape (see `.github/scripts/trust-package-inventory.test.mjs` for the reference): a roster
array of `[directory, packageName]` pairs, a dependency-graph map, and a count assertion.
Add the roster entry after the `record` entry:

```js
  ['verification', '@jinn-network/environment-verification'],
```

Add the graph entry after `record`'s:

```js
  ['verification', {
    dependencies: [
      '@jinn-network/environment-record',
      '@jinn-network/trust-core',
      'zod',
    ],
    devDependencies: [
      '@jinn-network/trust-testing',
      '@types/node',
      'typescript',
      'vitest',
    ],
    optionalDependencies: [],
    peerDependencies: ['vitest'],
  }],
```

Bump the manifest-count assertion by one and update its test name to match.

- [ ] **Step 3: Run the guard to verify it fails**

Run: `node --test .github/scripts/environments-package-inventory.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, open '.../packages/environments/verification/package.json'`.

- [ ] **Step 4: Create the package scaffold**

`packages/environments/verification/package.json`:

```json
{
  "name": "@jinn-network/environment-verification",
  "version": "0.1.0",
  "description": "K-run environment verification protocol and its in-toto verification attestation.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/environments/verification"
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
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/environment-record": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "zod": "4.4.3"
  },
  "peerDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependenciesMeta": {
    "vitest": {
      "optional": true
    }
  },
  "devDependencies": {
    "@jinn-network/trust-testing": "0.1.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/environment-record": "portal:../record",
    "@jinn-network/trust-core": "portal:../../trust/core",
    "@jinn-network/trust-testing": "portal:../../trust/testing"
  }
}
```

`tsconfig.json`:

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

`src/index.ts` (grows task by task; starts as the package's identity only):

```ts
// SPDX-License-Identifier: Apache-2.0

export {
  DEFAULT_TIMEOUT_SECONDS,
  ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
```

`README.md`:

```markdown
# @jinn-network/environment-verification

Executes the K-run verification protocol against a sealed environment record and produces
an in-toto Statement inside a DSSE envelope.

## What the attestation claims, exactly

`result: "stable"` means **K consecutive runs of the record's declared test scope produced
identical outcome-sets under the declared controls**, and nothing more. Flaky-test rerun
studies show detection is asymptotic in the number of reruns, so no finite K settles the
question; K and the controls are recorded as facts, and grading them is the consumer's
trust policy. `result: "unstable"` records observed divergence. `result: "error"` records
an infrastructure failure with its stage and taxonomy-coded reason. All three are signed,
published, and equally first-class.

The protocol exercises the **image** at `image.manifestDigest`. At reproducibility tier 0
it does not check that the image's workspace corresponds to `source.repo@source.commit`;
that binding is a declaration this protocol does not check (design §5.2).

## Ports

Everything that touches the world is injected: `containerRuntime` (pull by digest, run a
fresh container), `artifactStore` (`putArtifact`), `signer` (a `DsseSigner` object — this
package never sees key bytes), `clock`, and the host-declared `verifier` toolchain
identity. An `EvidenceRepository` adapts to `ArtifactStore` in three lines:

```ts
const artifactStore = {
  async putArtifact(bytes, options) {
    const receipt = await repository.putArtifact(bytes, options);
    return { digest: receipt.reference.digest, size: receipt.size };
  },
};
```

## Digest forms

Scalar digest fields are `sha256:<64 lowercase hex>`. in-toto DigestSet values — subjects
and ResourceDescriptors — are **bare** hex. `toDigestSet` / `fromDigestSet` are the only
sanctioned crossings; the schemas reject each other's form.
```

`scripts/pack-smoke.mjs`:

```js
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordRoot = join(packageRoot, "..", "record");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-environment-verification-"));
const recordArchive = join(temporaryRoot, "environment-record.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const verificationArchive = join(temporaryRoot, "environment-verification.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  for (const [root, archive] of [
    [recordRoot, recordArchive],
    [trustCoreRoot, trustCoreArchive],
    [packageRoot, verificationArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  const entries = (await output("tar", ["-tzf", verificationArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
    "package/fixtures/predicate-v1/stable.json",
    "package/fixtures/attestations-v1/stable.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed environment-verification is missing ${required}`);
    }
  }
  const leaked = entries.filter((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leaked.length > 0) throw new Error(`test files leaked into tarball: ${leaked.join(", ")}`);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/environment-record": `file:${recordArchive}`,
      "@jinn-network/trust-core": `file:${trustCoreArchive}`,
      "@jinn-network/environment-verification": `file:${verificationArchive}`,
      vitest: "4.1.8",
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
  await writeFile(join(consumer, "packed-imports.test.mjs"), `
import assert from "node:assert/strict";
import {
  ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  buildEnvironmentCandidatesFromRows,
  verifyEnvironment,
} from "@jinn-network/environment-verification";
import {
  createInMemoryArtifactStore,
  describeEnvironmentVerificationConformance,
} from "@jinn-network/environment-verification/testing";
import { test } from "vitest";

test("packed environment-verification exposes its distribution contract", () => {
  assert.equal(
    ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    "https://jinn.network/attestations/environment-verification/v1",
  );
  assert.equal(typeof verifyEnvironment, "function");
  assert.equal(typeof buildEnvironmentCandidatesFromRows, "function");
  assert.equal(typeof describeEnvironmentVerificationConformance, "function");
  assert.equal(typeof createInMemoryArtifactStore, "function");
});
`);
  const vitest = join(consumer, "node_modules", ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest");
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });
  console.log("Packed root/testing imports, fixtures, and archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

- [ ] **Step 5: Add the source-boundary and packed-types entries, including the one amendment**

In `.github/scripts/environments-source-boundaries.test.mjs`, add `'verification'` to the
tree's directory list, and add this package's allowlist beside `record`'s (mirroring the
per-package allowlist shape in `.github/scripts/trust-source-boundaries.test.mjs`):

```js
const VERIFICATION_ALLOWED_EXTERNALS = [
  '@jinn-network/environment-record',
  '@jinn-network/trust-core',
  'zod',
];
const VERIFICATION_ALLOWED_DEPENDENCIES = [
  '@jinn-network/environment-record',
  '@jinn-network/trust-core',
  'zod',
];
const VERIFICATION_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/trust-testing',
  '@types/node',
  'typescript',
  'vitest',
];
// Finding F-C2-5: the staged-state file store is this tree's only production
// filesystem surface. Its directory is an argument, not ambient authority --
// but the amendment is narrow on purpose, so a second fs import anywhere in
// the tree still fails the guard.
const FILESYSTEM_ALLOWED_SOURCES = [
  'verification/src/staged-state-store.ts',
  'verification/src/testing.ts',
];
```

Wire `FILESYSTEM_ALLOWED_SOURCES` into the guard's existing filesystem-import assertion so
that exactly those two paths may import `node:fs/promises`, and every other file in the
tree still fails on it. Leave the ambient-network, `process.env`, and locale-sensitive
assertions untouched — this package must pass all of them.

In `.github/scripts/environments-packed-types.test.mjs`, add the package and its two
entrypoints (`.` and `./testing`) alongside `record`'s entries.

In `.github/workflows/environments-ci.yml`, add `packages/environments/verification` to the
job matrix (or the package list, whichever shape C1 used) so `yarn typecheck`, `yarn test`,
and `yarn pack:smoke` run for it.

- [ ] **Step 6: Install, then run the guards and an empty test suite**

Run:
```bash
cd packages/environments/verification && corepack yarn@4.13.0 install
corepack yarn@4.13.0 typecheck
cd ../../.. && node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs
```
Expected: install resolves the three portals; `typecheck` exits 0; all three guards pass.

- [ ] **Step 7: Commit**

```bash
git add packages/environments/verification .github/scripts .github/workflows/environments-ci.yml
git commit -m "feat(environments): scaffold @jinn-network/environment-verification"
```

---

### Task 2: Identifiers, errors, and the digest-discipline primitives

**Files:**
- Create: `src/identifiers.ts`, `src/errors.ts`, `src/digests.ts`, `src/digests.test.ts`

**Interfaces:**
- Consumes: `Sha256Digest` from `@jinn-network/trust-core`.
- Produces: `ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`
  (`https://jinn.network/attestations/environment-verification/v1`),
  `ENVIRONMENT_VERIFICATION_PROTOCOL_URI`, `MINIMUM_RUN_COUNT = 5`,
  `DEFAULT_TIMEOUT_SECONDS = 1800`, `EnvironmentVerificationError`,
  `PrefixedSha256Schema`, `BareHexSha256Schema`, `DigestSetSchema`,
  `ResourceDescriptorSchema`, `toDigestSet(digest: Sha256Digest): DigestSet`,
  `fromDigestSet(digestSet: DigestSet): Sha256Digest`.

- [ ] **Step 1: Write the failing digest-discipline test**

`src/digests.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BareHexSha256Schema,
  DigestSetSchema,
  PrefixedSha256Schema,
  ResourceDescriptorSchema,
  fromDigestSet,
  toDigestSet,
} from "./digests.js";
import { EnvironmentVerificationError } from "./errors.js";

const HEX = "a".repeat(64);

describe("digest discipline (design §4.2 vs §5.1)", () => {
  it("accepts the prefixed form only for scalar digest fields", () => {
    expect(PrefixedSha256Schema.safeParse(`sha256:${HEX}`).success).toBe(true);
    expect(PrefixedSha256Schema.safeParse(HEX).success).toBe(false);
  });

  it("accepts the bare-hex form only for in-toto DigestSet values", () => {
    expect(BareHexSha256Schema.safeParse(HEX).success).toBe(true);
    expect(BareHexSha256Schema.safeParse(`sha256:${HEX}`).success).toBe(false);
  });

  it("rejects the confusion fixture: a prefixed value inside a DigestSet", () => {
    expect(DigestSetSchema.safeParse({ sha256: `sha256:${HEX}` }).success).toBe(false);
    expect(
      ResourceDescriptorSchema.safeParse({
        name: "outcomes",
        digest: { sha256: `sha256:${HEX}` },
      }).success,
    ).toBe(false);
  });

  it("rejects uppercase hex and extra DigestSet members", () => {
    expect(DigestSetSchema.safeParse({ sha256: "A".repeat(64) }).success).toBe(false);
    expect(DigestSetSchema.safeParse({ sha256: HEX, sha512: HEX }).success).toBe(false);
  });

  it("crosses the two forms in both directions and refuses malformed input", () => {
    expect(toDigestSet(`sha256:${HEX}`)).toEqual({ sha256: HEX });
    expect(fromDigestSet({ sha256: HEX })).toBe(`sha256:${HEX}`);
    expect(() => toDigestSet(HEX as `sha256:${string}`)).toThrow(EnvironmentVerificationError);
    expect(() => fromDigestSet({ sha256: `sha256:${HEX}` })).toThrow(EnvironmentVerificationError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/environments/verification && corepack yarn@4.13.0 vitest run src/digests.test.ts`
Expected: FAIL — `Failed to resolve import "./digests.js"`.

- [ ] **Step 3: Write the three modules**

`src/identifiers.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/** in-toto `predicateType` for this attestation (design §5.1). */
export const ENVIRONMENT_VERIFICATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/environment-verification/v1" as const;

/** The protocol the predicate's `protocol` field names (design §5.2, §5.3). */
export const ENVIRONMENT_VERIFICATION_PROTOCOL_URI =
  "https://jinn.network/environment-verification/protocol/1.0" as const;

/**
 * K for the v1 profile. Rerun studies put flaky-test detection on an
 * asymptote in the number of reruns (research note §9), so this is a declared
 * floor for a bounded observation -- never a convergence threshold.
 */
export const MINIMUM_RUN_COUNT = 5;

/** Per-run wall-clock ceiling in seconds for the v1 profile. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;
```

`src/errors.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export const ENVIRONMENT_VERIFICATION_ERROR_CODES = [
  "INVALID_INPUT",
  "CONFORMANCE_FAILURE",
] as const;

export type EnvironmentVerificationErrorCode =
  (typeof ENVIRONMENT_VERIFICATION_ERROR_CODES)[number];

export class EnvironmentVerificationError extends Error {
  override readonly name = "EnvironmentVerificationError";

  constructor(
    readonly code: EnvironmentVerificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Caller error: malformed input, or a profile rule the caller broke. */
export function invalidInput(message: string, cause?: unknown): never {
  throw new EnvironmentVerificationError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Port error: an injected dependency broke its documented contract. Never an
 * environment fact -- environment facts become attestations, not exceptions. */
export function conformanceFailure(message: string, cause?: unknown): never {
  throw new EnvironmentVerificationError(
    "CONFORMANCE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}
```

`src/digests.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";

const PREFIX = "sha256:";

/** Record-body and scalar predicate digest form (design §4.2). */
export const PrefixedSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex digits>");

/**
 * in-toto DigestSet value form: BARE lowercase hex. A `sha256:`-prefixed value
 * here is non-conformant with in-toto and is rejected (design §5.1).
 */
export const BareHexSha256Schema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "in-toto DigestSet values are bare lowercase hex, never sha256:-prefixed",
  );

export const DigestSetSchema = z.strictObject({ sha256: BareHexSha256Schema });
export type DigestSet = z.infer<typeof DigestSetSchema>;

export const ResourceDescriptorSchema = z.strictObject({
  name: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  digest: DigestSetSchema,
});
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;

/** The only sanctioned prefixed -> DigestSet crossing. */
export function toDigestSet(digest: Sha256Digest): DigestSet {
  if (!PrefixedSha256Schema.safeParse(digest).success) {
    invalidInput(`Not a sha256:-prefixed lowercase-hex digest: ${String(digest)}`);
  }
  return { sha256: digest.slice(PREFIX.length) };
}

/** The only sanctioned DigestSet -> prefixed crossing. */
export function fromDigestSet(digestSet: DigestSet): Sha256Digest {
  if (!DigestSetSchema.safeParse(digestSet).success) {
    invalidInput("Not a conformant in-toto sha256 DigestSet (bare lowercase hex only).");
  }
  return `${PREFIX}${digestSet.sha256}`;
}
```

- [ ] **Step 4: Run and pass**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 5 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): digest-discipline primitives for the verification attestation"
```

---

### Task 3: Outcome sets — canonical bytes, digest, set equality, tally

**Files:**
- Create: `src/outcome-set.ts`, `src/outcome-set.test.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `recordDigest`, `Sha256Digest` from
  `@jinn-network/trust-core`.
- Produces: `OUTCOME_STATUSES`, `OutcomeStatus`, `OutcomeSetSchema`, `OutcomeSet`,
  `canonicalOutcomeSetBytes(outcomes): Uint8Array`,
  `outcomeSetDigest(outcomes): Sha256Digest`,
  `outcomeSetsEqual(left, right): boolean`, `tallyOutcomeSet(outcomes): OutcomeTally`.

- [ ] **Step 1: Write the failing test**

`src/outcome-set.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicalOutcomeSetBytes,
  outcomeSetDigest,
  outcomeSetsEqual,
  tallyOutcomeSet,
  type OutcomeSet,
} from "./outcome-set.js";
import { EnvironmentVerificationError } from "./errors.js";

const OUTCOMES: OutcomeSet = {
  "tests/test_b.py::test_two": "fail",
  "tests/test_a.py::test_one": "pass",
  "tests/test_c.py::test_three": "skip",
};

describe("outcome sets", () => {
  it("canonicalizes independently of key insertion order", () => {
    const permuted: OutcomeSet = {
      "tests/test_c.py::test_three": "skip",
      "tests/test_a.py::test_one": "pass",
      "tests/test_b.py::test_two": "fail",
    };
    expect(canonicalOutcomeSetBytes(permuted)).toEqual(canonicalOutcomeSetBytes(OUTCOMES));
    expect(outcomeSetDigest(permuted)).toBe(outcomeSetDigest(OUTCOMES));
  });

  it("digests to the sha256:-prefixed form of its canonical bytes", () => {
    expect(outcomeSetDigest(OUTCOMES)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("compares by set equality over test-id -> status, never by timing", () => {
    expect(outcomeSetsEqual(OUTCOMES, { ...OUTCOMES })).toBe(true);
    expect(
      outcomeSetsEqual(OUTCOMES, { ...OUTCOMES, "tests/test_b.py::test_two": "pass" }),
    ).toBe(false);
    expect(outcomeSetsEqual(OUTCOMES, { ...OUTCOMES, "tests/test_d.py::test_four": "pass" }))
      .toBe(false);
  });

  it("tallies an expected-fail baseline without rejecting it", () => {
    expect(tallyOutcomeSet(OUTCOMES)).toEqual({ passing: 1, failing: 1, skipped: 1 });
  });

  it("refuses statuses outside pass|fail|skip and empty test ids", () => {
    expect(() => outcomeSetDigest({ "t": "errored" } as unknown as OutcomeSet))
      .toThrow(EnvironmentVerificationError);
    expect(() => outcomeSetDigest({ "": "pass" })).toThrow(EnvironmentVerificationError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/outcome-set.test.ts`
Expected: FAIL — `Failed to resolve import "./outcome-set.js"`.

- [ ] **Step 3: Implement**

`src/outcome-set.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";

export const OUTCOME_STATUSES = ["pass", "fail", "skip"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** One run's observed outcomes: test id -> status. The comparison unit of the
 * whole protocol (design §5.2: set equality over (test-id -> pass|fail|skip)). */
export const OutcomeSetSchema = z.record(z.string().min(1), z.enum(OUTCOME_STATUSES));
export type OutcomeSet = z.infer<typeof OutcomeSetSchema>;

export interface OutcomeTally {
  readonly passing: number;
  readonly failing: number;
  readonly skipped: number;
}

function assertOutcomeSet(outcomes: OutcomeSet): void {
  const parsed = OutcomeSetSchema.safeParse(outcomes);
  if (!parsed.success) {
    invalidInput("An outcome set maps non-empty test ids to pass|fail|skip.");
  }
}

/**
 * RFC 8785 canonical bytes of the outcome set -- both the bytes stored through
 * the artifact port and the bytes `outcomeSetDigest` hashes, so a consumer that
 * retrieves the artifact can recompute the digest in the predicate.
 */
export function canonicalOutcomeSetBytes(outcomes: OutcomeSet): Uint8Array {
  assertOutcomeSet(outcomes);
  return canonicalJsonBytes(outcomes);
}

export function outcomeSetDigest(outcomes: OutcomeSet): Sha256Digest {
  return recordDigest(canonicalOutcomeSetBytes(outcomes));
}

/** Set equality over (test id -> status). Wall time is recorded as observed
 * bounds and never enters this comparison (design §5.2). */
export function outcomeSetsEqual(left: OutcomeSet, right: OutcomeSet): boolean {
  return outcomeSetDigest(left) === outcomeSetDigest(right);
}

/** Counts for the baseline block. A baseline carrying failures is a *known*
 * baseline, not a rejected environment (design §5.2). */
export function tallyOutcomeSet(outcomes: OutcomeSet): OutcomeTally {
  assertOutcomeSet(outcomes);
  let passing = 0;
  let failing = 0;
  let skipped = 0;
  for (const status of Object.values(outcomes)) {
    if (status === "pass") passing += 1;
    else if (status === "fail") failing += 1;
    else skipped += 1;
  }
  return { passing, failing, skipped };
}
```

- [ ] **Step 4: Run and pass**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 10 tests pass (5 from T2, 5 here); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): outcome-set canonicalization, digest, and set equality"
```

---

### Task 4: The failure taxonomy and its four-way disposition

Legacy reference (read, never import):
`client/src/solver-types/_swe-rebench-v2-harvest-state.ts:175` classified failures by regex
over free-form reason text. This is a rewrite: a closed reason vocabulary and a total map
onto the four dispositions, so an unclassifiable reason cannot exist.

**Files:**
- Create: `src/failures.ts`, `src/failures.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FAILURE_STAGES`, `FailureStage`, `VERIFICATION_FAILURE_REASONS`,
  `VerificationFailureReason`, `FAILURE_DISPOSITIONS`, `FailureDisposition`,
  `classifyVerificationFailure(reason): FailureDisposition`,
  `stageForFailureReason(reason): FailureStage`.

- [ ] **Step 1: Write the failing test**

`src/failures.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  FAILURE_DISPOSITIONS,
  VERIFICATION_FAILURE_REASONS,
  classifyVerificationFailure,
  stageForFailureReason,
} from "./failures.js";

describe("failure taxonomy", () => {
  it("classifies every reason in the closed vocabulary", () => {
    for (const reason of VERIFICATION_FAILURE_REASONS) {
      expect(FAILURE_DISPOSITIONS).toContain(classifyVerificationFailure(reason));
    }
  });

  it("uses all four legacy dispositions", () => {
    const used = new Set(VERIFICATION_FAILURE_REASONS.map(classifyVerificationFailure));
    expect([...FAILURE_DISPOSITIONS].every((disposition) => used.has(disposition))).toBe(true);
  });

  it("maps divergence to quarantined and a wrong digest to terminal policy", () => {
    expect(classifyVerificationFailure("outcome-set-divergence")).toBe("quarantined");
    expect(classifyVerificationFailure("image-digest-mismatch")).toBe("terminal_policy");
    expect(classifyVerificationFailure("image-unresolvable")).toBe("failed_infrastructure");
    expect(classifyVerificationFailure("parser-produced-no-outcomes")).toBe("awaiting_input");
  });

  it("pins each reason to exactly one protocol stage", () => {
    expect(stageForFailureReason("image-unresolvable")).toBe("acquire");
    expect(stageForFailureReason("image-digest-mismatch")).toBe("acquire");
    expect(stageForFailureReason("install-command-failed")).toBe("install");
    expect(stageForFailureReason("run-command-failed")).toBe("run");
    expect(stageForFailureReason("runtime-timeout")).toBe("run");
    expect(stageForFailureReason("parser-produced-no-outcomes")).toBe("run");
    expect(stageForFailureReason("outcome-set-divergence")).toBe("compare");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/failures.test.ts`
Expected: FAIL — `Failed to resolve import "./failures.js"`.

- [ ] **Step 3: Implement**

`src/failures.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/** The protocol stages of design §5.3, in execution order. */
export const FAILURE_STAGES = ["acquire", "install", "run", "compare"] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

/**
 * The closed reason vocabulary the predicate's `failure.reason` draws from.
 * Free-form detail rides in `failure.detail`; the code is what consumers match.
 */
export const VERIFICATION_FAILURE_REASONS = [
  "image-unresolvable",
  "image-digest-mismatch",
  "install-command-failed",
  "run-command-failed",
  "runtime-timeout",
  "parser-produced-no-outcomes",
  "outcome-set-divergence",
] as const;
export type VerificationFailureReason = (typeof VERIFICATION_FAILURE_REASONS)[number];

/**
 * The four-way disposition the legacy harvest state machine used
 * (`client/src/solver-types/_swe-rebench-v2-harvest-state.ts`, reference only),
 * rewritten over this package's closed vocabulary. Design §6: `quarantined`
 * publishes an `unstable` attestation; `failed_infrastructure` retries, then
 * publishes an `error` attestation.
 */
export const FAILURE_DISPOSITIONS = [
  "terminal_policy",
  "awaiting_input",
  "quarantined",
  "failed_infrastructure",
] as const;
export type FailureDisposition = (typeof FAILURE_DISPOSITIONS)[number];

const DISPOSITION_BY_REASON: Readonly<
  Record<VerificationFailureReason, FailureDisposition>
> = Object.freeze({
  // Retryable: the registry, the network, or the host was having a bad day.
  "image-unresolvable": "failed_infrastructure",
  "install-command-failed": "failed_infrastructure",
  "run-command-failed": "failed_infrastructure",
  "runtime-timeout": "failed_infrastructure",
  // The record names a digest the registry resolves differently. Retrying the
  // same record can only reproduce it; the record itself must change.
  "image-digest-mismatch": "terminal_policy",
  // A record whose parser yields nothing needs a corrected record from whoever
  // declared it -- no amount of retrying supplies the missing input.
  "parser-produced-no-outcomes": "awaiting_input",
  // The environment ran and disagreed with itself: a published fact, not a bug.
  "outcome-set-divergence": "quarantined",
});

const STAGE_BY_REASON: Readonly<Record<VerificationFailureReason, FailureStage>> =
  Object.freeze({
    "image-unresolvable": "acquire",
    "image-digest-mismatch": "acquire",
    "install-command-failed": "install",
    "run-command-failed": "run",
    "runtime-timeout": "run",
    "parser-produced-no-outcomes": "run",
    "outcome-set-divergence": "compare",
  });

export function classifyVerificationFailure(
  reason: VerificationFailureReason,
): FailureDisposition {
  return DISPOSITION_BY_REASON[reason];
}

export function stageForFailureReason(reason: VerificationFailureReason): FailureStage {
  return STAGE_BY_REASON[reason];
}
```

- [ ] **Step 4: Run and pass**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 14 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): closed verification failure taxonomy with four-way disposition"
```

---

### Task 5: The predicate schema and its presence rules

This is the honesty core. Every rule below comes from design §5.2; encoding them as
cross-field schema rules is what makes an over-claiming attestation unrepresentable rather
than merely discouraged.

**Files:**
- Create: `src/predicate.ts`, `src/predicate.test.ts`

**Interfaces:**
- Consumes: `isCalendarStrictRfc3339` from `@jinn-network/trust-core`; `MINIMUM_RUN_COUNT`,
  `ENVIRONMENT_VERIFICATION_PROTOCOL_URI` (T2); `PrefixedSha256Schema`,
  `ResourceDescriptorSchema` (T2); `FAILURE_STAGES`, `VERIFICATION_FAILURE_REASONS` (T4).
- Produces: `VerificationControlsSchema`, `VerificationControls`, `RunsBlockSchema`,
  `BaselineBlockSchema`, `RuntimeBoundsSchema`, `VerifierIdentitySchema`,
  `VerifierIdentity`, `DivergenceSchema`, `FailureBlockSchema`, `VerificationWindowSchema`,
  `EnvironmentVerificationPredicateSchema`, `EnvironmentVerificationPredicate`,
  `parseEnvironmentVerificationPredicate(value): EnvironmentVerificationPredicate`.

- [ ] **Step 1: Write the failing presence-rule test**

`src/predicate.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EnvironmentVerificationPredicateSchema,
  type EnvironmentVerificationPredicate,
} from "./predicate.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

const CONTROLS = {
  network: "none",
  seeds: { PYTHONHASHSEED: "0" },
  order: "default",
  parallelism: 1,
  locale: "C.UTF-8",
  tz: "UTC",
} as const;

const VERIFIER = {
  id: "https://example.test/verifier",
  version: "0.1.0",
  digest: `sha256:${HEX_B}`,
} as const;

const WINDOW = {
  startedAt: "2026-07-31T09:00:00.000Z",
  endedAt: "2026-07-31T09:25:00.000Z",
} as const;

function stable(): EnvironmentVerificationPredicate {
  return {
    protocol: "https://jinn.network/environment-verification/protocol/1.0",
    result: "stable",
    window: WINDOW,
    runs: {
      count: 5,
      outcomeSetDigest: `sha256:${HEX_A}`,
      perRun: Array.from({ length: 5 }, () => ({
        outcomeSetDigest: `sha256:${HEX_A}`,
        wallSeconds: 292,
      })),
    },
    baseline: {
      passing: 412,
      failing: 3,
      skipped: 9,
      outcomes: { name: "outcomes", mediaType: "application/json", digest: { sha256: HEX_A } },
    },
    controls: CONTROLS,
    runtime: { minSeconds: 288, maxSeconds: 301, timeoutSeconds: 1800 },
    verifier: VERIFIER,
  } as EnvironmentVerificationPredicate;
}

describe("environment verification predicate", () => {
  it("accepts a well-formed stable predicate", () => {
    expect(EnvironmentVerificationPredicateSchema.safeParse(stable()).success).toBe(true);
  });

  it("refuses a stable result whose per-run digests diverge", () => {
    const predicate = stable();
    const perRun = [...predicate.runs!.perRun];
    perRun[2] = { outcomeSetDigest: `sha256:${HEX_B}`, wallSeconds: 300 };
    const result = EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      runs: { ...predicate.runs!, perRun },
    });
    expect(result.success).toBe(false);
  });

  it("refuses a stable result carrying a failure block", () => {
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...stable(),
      failure: { stage: "compare", reason: "outcome-set-divergence" },
    }).success).toBe(false);
  });

  it("requires runs and baseline exactly when result is not error", () => {
    const { runs: _runs, ...withoutRuns } = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse(withoutRuns).success).toBe(false);

    const errorPredicate = {
      protocol: "https://jinn.network/environment-verification/protocol/1.0",
      result: "error",
      window: WINDOW,
      controls: CONTROLS,
      runtime: { timeoutSeconds: 1800 },
      verifier: VERIFIER,
      failure: { stage: "acquire", reason: "image-unresolvable" },
    };
    expect(EnvironmentVerificationPredicateSchema.safeParse(errorPredicate).success).toBe(true);
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...errorPredicate,
      runs: stable().runs,
    }).success).toBe(false);
  });

  it("requires an unstable result to carry compare-stage divergence evidence", () => {
    const predicate = stable();
    const perRun = [...predicate.runs!.perRun];
    perRun[2] = { outcomeSetDigest: `sha256:${HEX_B}`, wallSeconds: 300 };
    const unstable = {
      ...predicate,
      result: "unstable" as const,
      runs: { ...predicate.runs!, perRun },
      failure: {
        stage: "compare" as const,
        reason: "outcome-set-divergence" as const,
        divergence: {
          referenceRunIndex: 0,
          referenceOutcomeSetDigest: `sha256:${HEX_A}`,
          divergentRuns: [{
            index: 2,
            outcomeSetDigest: `sha256:${HEX_B}`,
            outcomes: { name: "outcomes", digest: { sha256: HEX_B } },
          }],
        },
      },
    };
    expect(EnvironmentVerificationPredicateSchema.safeParse(unstable).success).toBe(true);
    const { divergence: _divergence, ...withoutDivergence } = unstable.failure;
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...unstable,
      failure: withoutDivergence,
    }).success).toBe(false);
  });

  it("refuses K below the profile minimum, omitted controls, and a bare-hex scalar", () => {
    const predicate = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      runs: { ...predicate.runs!, count: 4, perRun: predicate.runs!.perRun.slice(0, 4) },
    }).success).toBe(false);

    const { controls: _controls, ...withoutControls } = predicate;
    expect(EnvironmentVerificationPredicateSchema.safeParse(withoutControls).success).toBe(false);

    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      runs: { ...predicate.runs!, outcomeSetDigest: HEX_A },
    }).success).toBe(false);
  });

  it("binds the baseline descriptor to the canonical outcome-set digest", () => {
    const predicate = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      baseline: { ...predicate.baseline!, outcomes: { name: "outcomes", digest: { sha256: HEX_B } } },
    }).success).toBe(false);
  });

  it("refuses a window that ends before it starts and a non-UTC timestamp", () => {
    const predicate = stable();
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      window: { startedAt: WINDOW.endedAt, endedAt: WINDOW.startedAt },
    }).success).toBe(false);
    expect(EnvironmentVerificationPredicateSchema.safeParse({
      ...predicate,
      window: { startedAt: "2026-07-31T09:00:00+02:00", endedAt: WINDOW.endedAt },
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/predicate.test.ts`
Expected: FAIL — `Failed to resolve import "./predicate.js"`.

- [ ] **Step 3: Implement the schema**

`src/predicate.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { isCalendarStrictRfc3339 } from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema, ResourceDescriptorSchema } from "./digests.js";
import { invalidInput } from "./errors.js";
import { FAILURE_STAGES, VERIFICATION_FAILURE_REASONS } from "./failures.js";
import { ENVIRONMENT_VERIFICATION_PROTOCOL_URI, MINIMUM_RUN_COUNT } from "./identifiers.js";

const Rfc3339UtcSchema = z
  .string()
  .refine(isCalendarStrictRfc3339, "must be a calendar-strict RFC 3339 timestamp")
  .refine((value) => value.endsWith("Z"), "must be expressed in UTC with a trailing Z");

/**
 * When the runs happened. Inside the signed payload on purpose: a re-announced
 * old attestation cannot present itself as fresh (design §5.2).
 */
export const VerificationWindowSchema = z
  .strictObject({ startedAt: Rfc3339UtcSchema, endedAt: Rfc3339UtcSchema })
  .refine((window) => window.startedAt <= window.endedAt, {
    message: "window.endedAt must not precede window.startedAt",
    path: ["endedAt"],
  });
export type VerificationWindow = z.infer<typeof VerificationWindowSchema>;

/** The declared controls the K runs ran under. Required in every result --
 * including `error`, where they say what would have been applied. */
export const VerificationControlsSchema = z.strictObject({
  network: z.literal("none"),
  seeds: z.record(z.string().min(1), z.string()),
  order: z.enum(["declared", "fixed", "default"]),
  parallelism: z.number().int().positive(),
  locale: z.string().min(1),
  tz: z.string().min(1),
});
export type VerificationControls = z.infer<typeof VerificationControlsSchema>;

export const RunObservationSchema = z.strictObject({
  outcomeSetDigest: PrefixedSha256Schema,
  wallSeconds: z.number().nonnegative().finite(),
});
export type RunObservation = z.infer<typeof RunObservationSchema>;

export const RunsBlockSchema = z
  .strictObject({
    count: z.number().int().min(MINIMUM_RUN_COUNT),
    outcomeSetDigest: PrefixedSha256Schema,
    perRun: z.array(RunObservationSchema).min(MINIMUM_RUN_COUNT),
  })
  .refine((runs) => runs.count === runs.perRun.length, {
    message: "runs.count must equal runs.perRun.length",
    path: ["count"],
  });
export type RunsBlock = z.infer<typeof RunsBlockSchema>;

/**
 * Which tests fail at this commit. A baseline with failures is a *known*
 * baseline, not a rejected environment (design §5.2) -- imported per-instance
 * images carry the instance's bug and its failing tests by construction.
 */
export const BaselineBlockSchema = z.strictObject({
  passing: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  outcomes: ResourceDescriptorSchema,
});
export type BaselineBlock = z.infer<typeof BaselineBlockSchema>;

/** Observed bounds, never an equality claim; `timeoutSeconds` is the declared
 * ceiling and is present even when no run happened. */
export const RuntimeBoundsSchema = z
  .strictObject({
    minSeconds: z.number().nonnegative().finite().optional(),
    maxSeconds: z.number().nonnegative().finite().optional(),
    timeoutSeconds: z.number().positive().finite(),
  })
  .refine(
    (runtime) => runtime.minSeconds === undefined
      || runtime.maxSeconds === undefined
      || runtime.minSeconds <= runtime.maxSeconds,
    { message: "runtime.minSeconds must not exceed runtime.maxSeconds", path: ["minSeconds"] },
  )
  .refine(
    (runtime) => runtime.maxSeconds === undefined || runtime.maxSeconds <= runtime.timeoutSeconds,
    { message: "runtime.maxSeconds must not exceed runtime.timeoutSeconds", path: ["maxSeconds"] },
  );
export type RuntimeBounds = z.infer<typeof RuntimeBoundsSchema>;

/** Identity of the toolchain that ran the protocol. Host-declared -- a library
 * cannot truthfully digest its own build (see Findings F-C2-1). */
export const VerifierIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: PrefixedSha256Schema,
});
export type VerifierIdentity = z.infer<typeof VerifierIdentitySchema>;

export const DivergenceSchema = z.strictObject({
  referenceRunIndex: z.number().int().nonnegative(),
  referenceOutcomeSetDigest: PrefixedSha256Schema,
  divergentRuns: z
    .array(z.strictObject({
      index: z.number().int().nonnegative(),
      outcomeSetDigest: PrefixedSha256Schema,
      outcomes: ResourceDescriptorSchema,
    }))
    .min(1),
});
export type Divergence = z.infer<typeof DivergenceSchema>;

export const FailureBlockSchema = z.strictObject({
  stage: z.enum(FAILURE_STAGES),
  reason: z.enum(VERIFICATION_FAILURE_REASONS),
  detail: z.string().min(1).optional(),
  divergence: DivergenceSchema.optional(),
});
export type FailureBlock = z.infer<typeof FailureBlockSchema>;

const PredicateShapeSchema = z.strictObject({
  protocol: z.literal(ENVIRONMENT_VERIFICATION_PROTOCOL_URI),
  result: z.enum(["stable", "unstable", "error"]),
  window: VerificationWindowSchema,
  runs: RunsBlockSchema.optional(),
  baseline: BaselineBlockSchema.optional(),
  controls: VerificationControlsSchema,
  runtime: RuntimeBoundsSchema,
  verifier: VerifierIdentitySchema,
  failure: FailureBlockSchema.optional(),
  evidence: z.array(ResourceDescriptorSchema).optional(),
});

export const EnvironmentVerificationPredicateSchema = PredicateShapeSchema.superRefine(
  (predicate, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };

    // Presence rule (design §5.2): runs and baseline are present iff the result
    // is not `error`. An `error` attestation carries window, failure, and any
    // partial evidence only.
    if (predicate.result === "error") {
      if (predicate.runs !== undefined) issue("an error result carries no runs", ["runs"]);
      if (predicate.baseline !== undefined) {
        issue("an error result carries no baseline", ["baseline"]);
      }
      if (predicate.runtime.minSeconds !== undefined || predicate.runtime.maxSeconds !== undefined) {
        issue("observed runtime bounds require at least one run", ["runtime", "minSeconds"]);
      }
      if (predicate.failure === undefined) {
        issue("an error result requires a failure block", ["failure"]);
      } else if (predicate.failure.stage === "compare") {
        issue("compare-stage failures are unstable results, not errors", ["failure", "stage"]);
      } else if (predicate.failure.divergence !== undefined) {
        issue("divergence evidence requires runs", ["failure", "divergence"]);
      }
    } else {
      if (predicate.runs === undefined) issue("a non-error result requires runs", ["runs"]);
      if (predicate.baseline === undefined) {
        issue("a non-error result requires a baseline", ["baseline"]);
      }
      if (predicate.runtime.minSeconds === undefined || predicate.runtime.maxSeconds === undefined) {
        issue("a non-error result requires observed runtime bounds", ["runtime", "minSeconds"]);
      }
      if (
        predicate.runs !== undefined
        && predicate.baseline !== undefined
        && predicate.baseline.outcomes.digest.sha256
          !== predicate.runs.outcomeSetDigest.slice("sha256:".length)
      ) {
        issue(
          "baseline.outcomes must reference the canonical outcome set named by runs.outcomeSetDigest",
          ["baseline", "outcomes"],
        );
      }
    }

    // `stable` means every run agreed. A `stable` result whose per-run digests
    // differ is exactly the adversarial fixture of design §5.5.
    if (predicate.result === "stable") {
      if (predicate.failure !== undefined) {
        issue("a stable result carries no failure block", ["failure"]);
      }
      predicate.runs?.perRun.forEach((run, index) => {
        if (run.outcomeSetDigest !== predicate.runs?.outcomeSetDigest) {
          issue(
            "a stable result requires every per-run outcome-set digest to equal the canonical one",
            ["runs", "perRun", index, "outcomeSetDigest"],
          );
        }
      });
    }

    // `unstable` exists only as observed divergence, and says so structurally.
    if (predicate.result === "unstable") {
      if (predicate.failure === undefined) {
        issue("an unstable result requires a failure block", ["failure"]);
      } else {
        if (predicate.failure.stage !== "compare") {
          issue("an unstable result is a compare-stage failure", ["failure", "stage"]);
        }
        if (predicate.failure.reason !== "outcome-set-divergence") {
          issue("an unstable result is outcome-set divergence", ["failure", "reason"]);
        }
        if (predicate.failure.divergence === undefined) {
          issue("an unstable result requires divergence evidence", ["failure", "divergence"]);
        }
      }
    }
  },
);

export type EnvironmentVerificationPredicate = z.infer<typeof PredicateShapeSchema>;

export function parseEnvironmentVerificationPredicate(
  value: unknown,
): EnvironmentVerificationPredicate {
  const result = EnvironmentVerificationPredicateSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid verification predicate at /${first.path.join("/")}: ${first.message}`
        : "Invalid verification predicate.",
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run and pass**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 22 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): verification predicate schema with the design's presence rules"
```

---

### Task 6: Subjects, the Statement, and the normative subject-match rule

**Files:**
- Create: `src/subject.ts`, `src/statement.ts`, `src/statement.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `IN_TOTO_STATEMENT_TYPE`, `Sha256Digest` from `@jinn-network/trust-core`;
  T2 and T5 exports.
- Produces: `buildEnvironmentVerificationSubjects(input): readonly [ResourceDescriptor, ResourceDescriptor]`,
  `EnvironmentVerificationStatementSchema`, `EnvironmentVerificationStatement`,
  `buildEnvironmentVerificationStatement(input): EnvironmentVerificationStatement`,
  `parseEnvironmentVerificationStatement(value): EnvironmentVerificationStatement`,
  `attestationMatchesRecord(statement, recordDigest): boolean`,
  `verifyBaselineCounts(predicate, outcomesBytes): boolean`.

- [ ] **Step 1: Write the failing test**

`src/statement.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalOutcomeSetBytes, type OutcomeSet } from "./outcome-set.js";
import { EnvironmentVerificationError } from "./errors.js";
import {
  attestationMatchesRecord,
  buildEnvironmentVerificationStatement,
  verifyBaselineCounts,
} from "./statement.js";
import { buildEnvironmentVerificationSubjects } from "./subject.js";
import type { EnvironmentVerificationPredicate } from "./predicate.js";

const RECORD_HEX = "1".repeat(64);
const IMAGE_HEX = "2".repeat(64);

const OUTCOMES: OutcomeSet = {
  "tests/test_a.py::test_one": "pass",
  "tests/test_b.py::test_two": "fail",
};

function predicateFor(outcomeSetDigest: `sha256:${string}`): EnvironmentVerificationPredicate {
  return {
    protocol: "https://jinn.network/environment-verification/protocol/1.0",
    result: "stable",
    window: { startedAt: "2026-07-31T09:00:00.000Z", endedAt: "2026-07-31T09:25:00.000Z" },
    runs: {
      count: 5,
      outcomeSetDigest,
      perRun: Array.from({ length: 5 }, () => ({ outcomeSetDigest, wallSeconds: 12 })),
    },
    baseline: {
      passing: 1,
      failing: 1,
      skipped: 0,
      outcomes: {
        name: "outcomes",
        mediaType: "application/json",
        digest: { sha256: outcomeSetDigest.slice("sha256:".length) },
      },
    },
    controls: {
      network: "none",
      seeds: { PYTHONHASHSEED: "0" },
      order: "default",
      parallelism: 1,
      locale: "C.UTF-8",
      tz: "UTC",
    },
    runtime: { minSeconds: 11, maxSeconds: 13, timeoutSeconds: 1800 },
    verifier: { id: "https://example.test/verifier", version: "0.1.0", digest: `sha256:${IMAGE_HEX}` },
  } as EnvironmentVerificationPredicate;
}

describe("subjects and statement", () => {
  it("emits bare-hex DigestSet values in a fixed [environment, image] order", () => {
    expect(buildEnvironmentVerificationSubjects({
      recordDigest: `sha256:${RECORD_HEX}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
    })).toEqual([
      { name: "environment", digest: { sha256: RECORD_HEX } },
      { name: "image", digest: { sha256: IMAGE_HEX } },
    ]);
  });

  it("refuses a prefixed DigestSet value at the subject boundary", () => {
    expect(() => buildEnvironmentVerificationSubjects({
      recordDigest: RECORD_HEX as `sha256:${string}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
    })).toThrow(EnvironmentVerificationError);
  });

  it("builds a schema-valid in-toto Statement", () => {
    const digest = `sha256:${"3".repeat(64)}` as const;
    const statement = buildEnvironmentVerificationStatement({
      recordDigest: `sha256:${RECORD_HEX}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
      predicate: predicateFor(digest),
    });
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType)
      .toBe("https://jinn.network/attestations/environment-verification/v1");
    expect(statement.subject).toHaveLength(2);
  });

  it("matches on the environment subject only, never any-subject", () => {
    const digest = `sha256:${"3".repeat(64)}` as const;
    const statement = buildEnvironmentVerificationStatement({
      recordDigest: `sha256:${RECORD_HEX}`,
      imageManifestDigest: `sha256:${IMAGE_HEX}`,
      predicate: predicateFor(digest),
    });
    expect(attestationMatchesRecord(statement, `sha256:${RECORD_HEX}`)).toBe(true);
    // The image subject matches, the environment subject does not: a narrow-scope
    // attestation must NOT extend to a different record (design §5.1).
    expect(attestationMatchesRecord(statement, `sha256:${IMAGE_HEX}`)).toBe(false);
  });

  it("catches re-signed payloads whose baseline counts were altered", () => {
    const bytes = canonicalOutcomeSetBytes(OUTCOMES);
    const digest = `sha256:${"3".repeat(64)}` as const;
    const honest = predicateFor(digest);
    expect(verifyBaselineCounts(honest, bytes)).toBe(false); // digest does not name these bytes

    const bound = predicateFor(
      `sha256:${Buffer.from([]).toString("hex")}` as `sha256:${string}`,
    );
    expect(typeof verifyBaselineCounts(bound, bytes)).toBe("boolean");
  });
});
```

Note: the last test is refined in Step 4 once real digests are available; write it as shown
first so the module boundary is exercised, then tighten it.

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/statement.test.ts`
Expected: FAIL — `Failed to resolve import "./statement.js"`.

- [ ] **Step 3: Implement**

`src/subject.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";

import { toDigestSet, type ResourceDescriptor } from "./digests.js";

export interface EnvironmentVerificationSubjectInput {
  /** Identity of the sealed environment record (`sha256:`-prefixed). */
  readonly recordDigest: Sha256Digest;
  /** Platform-specific OCI *manifest* digest (`sha256:`-prefixed). */
  readonly imageManifestDigest: Sha256Digest;
}

/**
 * The attestation's two subjects, in fixed order: the environment record first,
 * the image second. Values are bare hex, per in-toto -- `toDigestSet` refuses a
 * prefixed value, which is the adversarial fixture of design §5.1.
 *
 * The image subject exists for discovery inversion only ("find attestations
 * about image sha256:X"). Claims about an *environment* match the environment
 * subject; see `attestationMatchesRecord`.
 */
export function buildEnvironmentVerificationSubjects(
  input: EnvironmentVerificationSubjectInput,
): readonly [ResourceDescriptor, ResourceDescriptor] {
  return [
    { name: "environment", digest: toDigestSet(input.recordDigest) },
    { name: "image", digest: toDigestSet(input.imageManifestDigest) },
  ];
}
```

`src/statement.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { IN_TOTO_STATEMENT_TYPE, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { DigestSetSchema, fromDigestSet } from "./digests.js";
import { invalidInput } from "./errors.js";
import { ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "./identifiers.js";
import {
  EnvironmentVerificationPredicateSchema,
  type EnvironmentVerificationPredicate,
} from "./predicate.js";
import { canonicalOutcomeSetBytes, tallyOutcomeSet, OutcomeSetSchema } from "./outcome-set.js";
import { recordDigest } from "@jinn-network/trust-core";
import {
  buildEnvironmentVerificationSubjects,
  type EnvironmentVerificationSubjectInput,
} from "./subject.js";

export const EnvironmentVerificationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([
    z.strictObject({ name: z.literal("environment"), digest: DigestSetSchema }),
    z.strictObject({ name: z.literal("image"), digest: DigestSetSchema }),
  ]),
  predicateType: z.literal(ENVIRONMENT_VERIFICATION_PREDICATE_TYPE),
  predicate: EnvironmentVerificationPredicateSchema,
});
export type EnvironmentVerificationStatement = z.infer<
  typeof EnvironmentVerificationStatementSchema
>;

export interface BuildEnvironmentVerificationStatementInput
  extends EnvironmentVerificationSubjectInput {
  readonly predicate: EnvironmentVerificationPredicate;
}

/**
 * Assembles and validates the in-toto Statement. Follows the
 * `attestation-issuer` pattern (`packages/evidence/attestation-issuer/src/
 * statement.ts`): assemble, `safeParse` against a closed schema, throw with the
 * first issue's JSON path. That package is a pattern source, not a dependency --
 * it exports no statement builder, and design §3.3 gives verification only two
 * package edges.
 */
export function buildEnvironmentVerificationStatement(
  input: BuildEnvironmentVerificationStatementInput,
): EnvironmentVerificationStatement {
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: buildEnvironmentVerificationSubjects(input),
    predicateType: ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    predicate: input.predicate,
  };
  return parseEnvironmentVerificationStatement(statement);
}

export function parseEnvironmentVerificationStatement(
  value: unknown,
): EnvironmentVerificationStatement {
  const result = EnvironmentVerificationStatementSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid verification statement at /${first.path.join("/")}: ${first.message}`
        : "Invalid verification statement.",
    );
  }
  return result.data;
}

/**
 * The normative subject-match rule (design §5.1). A consumer evaluating a claim
 * about an *environment* MUST match the environment-record subject. Any-subject
 * matching would silently extend a narrow-scope attestation to a broad-scope
 * record, since two records may share one image.
 */
export function attestationMatchesRecord(
  statement: EnvironmentVerificationStatement,
  recordDigestValue: Sha256Digest,
): boolean {
  return fromDigestSet(statement.subject[0].digest) === recordDigestValue;
}

/**
 * Re-derives the baseline counts from the retrieved outcome-map artifact and
 * checks both the digest binding and the tally. This is what catches a re-signed
 * payload whose baseline counts were altered (design §5.5) -- the counts are
 * inline in the predicate, so only the artifact settles them.
 */
export function verifyBaselineCounts(
  predicate: EnvironmentVerificationPredicate,
  outcomesBytes: Uint8Array,
): boolean {
  if (predicate.baseline === undefined) return false;
  const expectedDigest = recordDigest(outcomesBytes);
  if (fromDigestSet(predicate.baseline.outcomes.digest) !== expectedDigest) return false;

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outcomesBytes));
  } catch {
    return false;
  }
  const parsed = OutcomeSetSchema.safeParse(decoded);
  if (!parsed.success) return false;
  // Canonical-bytes check: the stored artifact must be the canonical encoding,
  // not a re-spelled equivalent.
  const canonical = canonicalOutcomeSetBytes(parsed.data);
  if (canonical.length !== outcomesBytes.length
    || !canonical.every((byte, index) => byte === outcomesBytes[index])) {
    return false;
  }
  const tally = tallyOutcomeSet(parsed.data);
  return tally.passing === predicate.baseline.passing
    && tally.failing === predicate.baseline.failing
    && tally.skipped === predicate.baseline.skipped;
}
```

- [ ] **Step 4: Tighten the baseline-counts test with real digests**

Replace the last `it(...)` block in `src/statement.test.ts` with:

```ts
  it("catches re-signed payloads whose baseline counts were altered", () => {
    const bytes = canonicalOutcomeSetBytes(OUTCOMES);
    const digest = outcomeSetDigest(OUTCOMES);
    const honest = predicateFor(digest);
    expect(verifyBaselineCounts(honest, bytes)).toBe(true);

    const tampered = {
      ...honest,
      baseline: { ...honest.baseline!, passing: 999 },
    } as EnvironmentVerificationPredicate;
    expect(verifyBaselineCounts(tampered, bytes)).toBe(false);

    const wrongArtifact = canonicalOutcomeSetBytes({ "tests/test_a.py::test_one": "pass" });
    expect(verifyBaselineCounts(honest, wrongArtifact)).toBe(false);
  });
```

and add `outcomeSetDigest` to the `./outcome-set.js` import at the top of the file.

- [ ] **Step 5: Export the new surface and run**

Extend `src/index.ts`:

```ts
export {
  BareHexSha256Schema,
  DigestSetSchema,
  PrefixedSha256Schema,
  ResourceDescriptorSchema,
  fromDigestSet,
  toDigestSet,
  type DigestSet,
  type ResourceDescriptor,
} from "./digests.js";
export {
  ENVIRONMENT_VERIFICATION_ERROR_CODES,
  EnvironmentVerificationError,
  type EnvironmentVerificationErrorCode,
} from "./errors.js";
export {
  FAILURE_DISPOSITIONS,
  FAILURE_STAGES,
  VERIFICATION_FAILURE_REASONS,
  classifyVerificationFailure,
  stageForFailureReason,
  type FailureDisposition,
  type FailureStage,
  type VerificationFailureReason,
} from "./failures.js";
export {
  OUTCOME_STATUSES,
  OutcomeSetSchema,
  canonicalOutcomeSetBytes,
  outcomeSetDigest,
  outcomeSetsEqual,
  tallyOutcomeSet,
  type OutcomeSet,
  type OutcomeStatus,
  type OutcomeTally,
} from "./outcome-set.js";
export {
  EnvironmentVerificationPredicateSchema,
  parseEnvironmentVerificationPredicate,
  type EnvironmentVerificationPredicate,
  type VerificationControls,
  type VerifierIdentity,
} from "./predicate.js";
export {
  EnvironmentVerificationStatementSchema,
  attestationMatchesRecord,
  buildEnvironmentVerificationStatement,
  parseEnvironmentVerificationStatement,
  verifyBaselineCounts,
  type EnvironmentVerificationStatement,
} from "./statement.js";
export { buildEnvironmentVerificationSubjects } from "./subject.js";
```

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 27 tests pass; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): in-toto subjects, statement builder, and the subject-match rule"
```

---

### Task 7: Ports — container runtime, artifact store, clock

**Files:**
- Create: `src/ports.ts`, `src/ports.test.ts`

**Interfaces:**
- Consumes: `CommandSpecSchema`, `EnvironmentRecord` from
  `@jinn-network/environment-record` (branch `supply/c1-environment-record`);
  `DsseSigner`, `Sha256Digest` from `@jinn-network/trust-core`.
- Produces: `CommandSpec`, `EnvironmentParserIdentity`, `Clock`, `ArtifactPutReceipt`,
  `ArtifactStore`, `ImagePullRequest`, `ImagePullResult`, `ContainerRunRequest`,
  `ContainerRunResult`, `ContainerRuntime`, `VerificationDeps`.

- [ ] **Step 1: Write the failing structural test**

`src/ports.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ContainerRuntime, VerificationDeps } from "./ports.js";

describe("ports", () => {
  it("types a container runtime with pull-by-digest and a fresh-container run", async () => {
    const runtime: ContainerRuntime = {
      async pullByDigest(request) {
        return { resolvedManifestDigest: request.manifestDigest };
      },
      async runContainer() {
        return {
          containerId: "container-0",
          installExitCodes: [],
          testExitCodes: [1],
          outcomes: { "tests/test_a.py::test_one": "fail" },
          wallSeconds: 4,
          timedOut: false,
        };
      },
    };
    const pull = await runtime.pullByDigest({
      manifestDigest: `sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
    });
    expect(pull.resolvedManifestDigest).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("keeps the injected dependency set to ports plus the declared verifier", () => {
    const keys: (keyof VerificationDeps)[] = [
      "containerRuntime",
      "artifactStore",
      "signer",
      "clock",
      "verifier",
    ];
    expect(keys).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/ports.test.ts`
Expected: FAIL — `Failed to resolve import "./ports.js"`.

- [ ] **Step 3: Implement**

`src/ports.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { CommandSpecSchema, type EnvironmentRecord } from "@jinn-network/environment-record";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import type { z } from "zod";

import type { OutcomeSet } from "./outcome-set.js";
import type { VerifierIdentity } from "./predicate.js";

/** The record's shell-free command shape (C1's `CommandSpecSchema`). */
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

/** The record's pinned parser identity, carried into every run request so the
 * runtime resolves the same parser the record names. */
export type EnvironmentParserIdentity = EnvironmentRecord["parser"];

/** Injected time. No production module calls `Date.now()`. */
export interface Clock {
  now(): Date;
}

export interface ArtifactPutReceipt {
  readonly digest: Sha256Digest;
  readonly size: number;
}

/**
 * Digest-addressed artifact sink. An `EvidenceRepository` adapts in three lines
 * (see README); this package declares the narrowest surface it uses so it takes
 * no dependency on the evidence tree.
 */
export interface ArtifactStore {
  putArtifact(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ArtifactPutReceipt>;
}

export interface ImagePullRequest {
  /** Authoritative. `reference` is advisory (design §5.3 step 1). */
  readonly manifestDigest: Sha256Digest;
  readonly platform: string;
  readonly reference?: string;
  readonly signal?: AbortSignal;
}

export interface ImagePullResult {
  /** What the registry actually resolved. The caller compares it to the
   * requested digest and refuses a mismatch (`error/acquire`). */
  readonly resolvedManifestDigest: Sha256Digest;
}

export interface ContainerRunRequest {
  readonly manifestDigest: Sha256Digest;
  readonly platform: string;
  readonly workspace: string;
  /** Run first, inside this run's own container (see Findings F-C2-2). */
  readonly installCommands: readonly CommandSpec[];
  /** The record's declared verification scope. */
  readonly testCommands: readonly CommandSpec[];
  /** The record's pinned parser. Implementations acquire it by digest and MUST
   * fail closed on mismatch; the parser is what fixes the outcome vocabulary. */
  readonly parser: EnvironmentParserIdentity;
  /** Declared controls, already flattened to environment variables. */
  readonly env: Readonly<Record<string, string>>;
  readonly network: "none";
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface ContainerRunResult {
  /**
   * Identifies the container this run executed in. Every run gets a FRESH
   * container from the same image (design §5.3 step 3); the caller records
   * these ids so a host -- and this package's kit -- can check that rule
   * instead of trusting it.
   */
  readonly containerId: string;
  readonly installExitCodes: readonly number[];
  readonly testExitCodes: readonly number[];
  /** Parsed outcomes of the test commands, merged by test id. */
  readonly outcomes: OutcomeSet;
  readonly wallSeconds: number;
  readonly timedOut: boolean;
  /** Optional raw log bytes, stored as `evidence` when present. */
  readonly log?: Uint8Array;
}

export interface ContainerRuntime {
  pullByDigest(request: ImagePullRequest): Promise<ImagePullResult>;
  /** Creates a fresh container from the image, runs install then test commands
   * in it, parses the test output, and discards the container. */
  runContainer(request: ContainerRunRequest): Promise<ContainerRunResult>;
}

export interface VerificationDeps {
  readonly containerRuntime: ContainerRuntime;
  readonly artifactStore: ArtifactStore;
  /** Signer object. This package never holds, reads, or derives key material. */
  readonly signer: DsseSigner;
  readonly clock: Clock;
  /** Host-declared identity of the running toolchain (Findings F-C2-1). */
  readonly verifier: VerifierIdentity;
}
```

- [ ] **Step 4: Run and pass**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 29 tests pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): injected ports for the verification capability"
```

---

### Task 8: `verifyEnvironment` — the stable path (design §5.3 steps 1–6)

**Files:**
- Create: `src/verify.ts`, `src/verify.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `EnvironmentRecord`, `sealEnvironmentRecord`, `environmentRecordDigest` from
  `@jinn-network/environment-record` (branch `supply/c1-environment-record`);
  `sealSignedRecord`, `DSSE_PAYLOAD_TYPE`, `recordDigest`, `Sha256Digest` from
  `@jinn-network/trust-core`; T2–T7 exports.
- Produces (program §4 pinned name):
  `verifyEnvironment(deps: VerificationDeps, record: EnvironmentRecord, options?: VerifyEnvironmentOptions): Promise<SealedAttestation>`,
  plus `DEFAULT_VERIFICATION_CONTROLS`, `SealedAttestation`, `VerifyEnvironmentOptions`.

- [ ] **Step 1: Write the failing stable-path test**

`src/verify.test.ts` (the fakes here are local to the test; T12 promotes them to `./testing`):

```ts
// SPDX-License-Identifier: Apache-2.0

import { parseDsseEnvelope, recordDigest } from "@jinn-network/trust-core";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import type { ArtifactStore, Clock, ContainerRuntime } from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { verifyEnvironment, type VerificationDepsForTest } from "./verify.js";

export const IMAGE_DIGEST = `sha256:${"c".repeat(64)}` as Sha256Digest;

const OUTCOMES: OutcomeSet = {
  "tests/test_a.py::test_one": "pass",
  "tests/test_b.py::test_two": "fail",
};

const VERIFIER: VerifierIdentity = {
  id: "https://example.test/verifier",
  version: "0.1.0",
  digest: `sha256:${"d".repeat(64)}`,
};

function stubRecord() {
  return {
    kind: "https://jinn.network/records/environment/1.0",
    source: {
      repo: "owner/name",
      repoUrl: "https://github.com/owner/name",
      commit: "0".repeat(40),
    },
    image: {
      manifestDigest: IMAGE_DIGEST,
      platform: "linux/amd64",
      reference: `registry.test/owner/name@${IMAGE_DIGEST}`,
    },
    workspace: "/testbed",
    invocations: {
      test: [{ bin: "pytest", args: ["-q", "tests"] }],
    },
    parser: {
      id: "pytest",
      version: "1.0.0",
      digest: `sha256:${"e".repeat(64)}`,
      uri: "https://example.test/parsers/pytest-1.0.0.tar.gz",
    },
    build: { reproducibilityTier: 0 },
    rights: { sourceLicense: "MIT", basis: "upstream-permissive-filter" },
  };
}

function scriptedRuntime(outcomesPerRun: readonly OutcomeSet[]): ContainerRuntime & {
  readonly containerIds: string[];
} {
  const containerIds: string[] = [];
  let index = 0;
  return {
    containerIds,
    async pullByDigest(request) {
      return { resolvedManifestDigest: request.manifestDigest };
    },
    async runContainer() {
      const containerId = `container-${index}`;
      containerIds.push(containerId);
      const outcomes = outcomesPerRun[index] ?? outcomesPerRun[outcomesPerRun.length - 1]!;
      index += 1;
      return {
        containerId,
        installExitCodes: [],
        testExitCodes: [1],
        outcomes,
        wallSeconds: 10 + index,
        timedOut: false,
      };
    },
  };
}

function memoryStore(): ArtifactStore & { readonly bytes: Map<string, Uint8Array> } {
  const bytes = new Map<string, Uint8Array>();
  return {
    bytes,
    async putArtifact(input) {
      const digest = recordDigest(input);
      bytes.set(digest, input);
      return { digest, size: input.length };
    },
  };
}

function fixedClock(): Clock {
  const instants = [
    new Date("2026-07-31T09:00:00.000Z"),
    new Date("2026-07-31T09:25:00.000Z"),
  ];
  let index = 0;
  return { now: () => instants[Math.min(index++, instants.length - 1)]! };
}

/** Deterministic, non-cryptographic stand-in. Real keys arrive in T12 via
 * trust-testing's `createEoaTestSigner`. */
const signer: DsseSigner = async (request) => [{
  keyid: "test-key",
  signature: new Uint8Array(new TextEncoder().encode(recordDigest(request.preAuthEncoding))),
}];

describe("verifyEnvironment — stable path", () => {
  it("runs K fresh containers and seals a stable attestation", async () => {
    const runtime = scriptedRuntime([OUTCOMES]);
    const artifactStore = memoryStore();
    const attestation = await verifyEnvironment(
      { containerRuntime: runtime, artifactStore, signer, clock: fixedClock(), verifier: VERIFIER },
      stubRecord() as never,
    );

    const { predicate } = attestation.statement;
    expect(predicate.result).toBe("stable");
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.runs?.outcomeSetDigest).toBe(outcomeSetDigest(OUTCOMES));
    expect(predicate.baseline).toEqual({
      passing: 1,
      failing: 1,
      skipped: 0,
      outcomes: {
        name: "outcomes",
        mediaType: "application/json",
        digest: { sha256: outcomeSetDigest(OUTCOMES).slice("sha256:".length) },
      },
    });
    expect(predicate.window).toEqual({
      startedAt: "2026-07-31T09:00:00.000Z",
      endedAt: "2026-07-31T09:25:00.000Z",
    });
    expect(predicate.failure).toBeUndefined();

    // Fresh container per run, one pull.
    expect(new Set(runtime.containerIds).size).toBe(5);
    // The outcome map is stored, byte-for-byte canonical.
    expect(artifactStore.bytes.get(outcomeSetDigest(OUTCOMES)))
      .toEqual(canonicalOutcomeSetBytes(OUTCOMES));

    const envelope = parseDsseEnvelope(attestation.envelopeBytes);
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
  });

  it("refuses K below the profile minimum before touching any port", async () => {
    const runtime = scriptedRuntime([OUTCOMES]);
    await expect(verifyEnvironment(
      {
        containerRuntime: runtime,
        artifactStore: memoryStore(),
        signer,
        clock: fixedClock(),
        verifier: VERIFIER,
      },
      stubRecord() as never,
      { runCount: 4 },
    )).rejects.toThrow(/at least 5 runs/u);
    expect(runtime.containerIds).toHaveLength(0);
  });

  it("fails closed when the artifact store returns a digest it did not compute", async () => {
    const lying: ArtifactStore = {
      async putArtifact(bytes) {
        return { digest: `sha256:${"f".repeat(64)}`, size: bytes.length };
      },
    };
    await expect(verifyEnvironment(
      {
        containerRuntime: scriptedRuntime([OUTCOMES]),
        artifactStore: lying,
        signer,
        clock: fixedClock(),
        verifier: VERIFIER,
      },
      stubRecord() as never,
    )).rejects.toThrow(/Artifact store returned/u);
  });
});
```

The `stubRecord() as never` casts exist only until Step 4 replaces them with a record built
through C1's own constructors; keep them for the red phase.

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/verify.test.ts`
Expected: FAIL — `Failed to resolve import "./verify.js"`.

- [ ] **Step 3: Implement the driver**

`src/verify.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  sealEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import {
  DSSE_PAYLOAD_TYPE,
  recordDigest,
  sealSignedRecord,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { PrefixedSha256Schema, toDigestSet, type ResourceDescriptor } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import { stageForFailureReason, type VerificationFailureReason } from "./failures.js";
import { DEFAULT_TIMEOUT_SECONDS, MINIMUM_RUN_COUNT } from "./identifiers.js";
import {
  canonicalOutcomeSetBytes,
  outcomeSetDigest,
  outcomeSetsEqual,
  tallyOutcomeSet,
  type OutcomeSet,
} from "./outcome-set.js";
import type { ArtifactStore, ContainerRunResult, VerificationDeps } from "./ports.js";
import type {
  EnvironmentVerificationPredicate,
  RunObservation,
  VerificationControls,
} from "./predicate.js";
import { ENVIRONMENT_VERIFICATION_PROTOCOL_URI } from "./identifiers.js";
import {
  buildEnvironmentVerificationStatement,
  type EnvironmentVerificationStatement,
} from "./statement.js";

export type { VerificationDeps } from "./ports.js";

/**
 * The v1 profile's controls. Truthful by construction: `verifyEnvironment`
 * applies exactly these to every run request rather than merely declaring them.
 */
export const DEFAULT_VERIFICATION_CONTROLS: VerificationControls = Object.freeze({
  network: "none",
  seeds: Object.freeze({ PYTHONHASHSEED: "0" }),
  order: "default",
  parallelism: 1,
  locale: "C.UTF-8",
  tz: "UTC",
}) as VerificationControls;

export interface VerifyEnvironmentOptions {
  /** K. Defaults to, and may never be below, `MINIMUM_RUN_COUNT`. */
  readonly runCount?: number;
  readonly controls?: VerificationControls;
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface SealedAttestation {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Identity of the sealed envelope. */
  readonly attestationDigest: Sha256Digest;
  readonly statement: EnvironmentVerificationStatement;
  /**
   * Container ids of the K runs, in run order. Not part of the signed payload:
   * a host-side check that each run got a fresh container.
   */
  readonly containerIds: readonly string[];
}

interface RunRecord {
  readonly outcomes: OutcomeSet;
  readonly digest: Sha256Digest;
  readonly observation: RunObservation;
  readonly containerId: string;
}

type Observation =
  | { readonly kind: "runs"; readonly runs: readonly RunRecord[] }
  | {
    readonly kind: "error";
    readonly reason: VerificationFailureReason;
    readonly detail?: string;
    readonly containerIds: readonly string[];
  };

function toRfc3339Utc(instant: Date): string {
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) invalidInput("The injected clock returned an invalid Date.");
  return new Date(milliseconds).toISOString();
}

function controlsToEnv(controls: VerificationControls): Record<string, string> {
  return {
    ...controls.seeds,
    LC_ALL: controls.locale,
    LANG: controls.locale,
    TZ: controls.tz,
  };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function storeOutcomes(
  artifactStore: ArtifactStore,
  outcomes: OutcomeSet,
  signal: AbortSignal | undefined,
): Promise<ResourceDescriptor> {
  const bytes = canonicalOutcomeSetBytes(outcomes);
  const expected = recordDigest(bytes);
  const receipt = await artifactStore.putArtifact(
    bytes,
    signal === undefined ? undefined : { signal },
  );
  if (receipt.digest !== expected) {
    conformanceFailure(
      `Artifact store returned ${receipt.digest} for bytes digesting to ${expected}.`,
    );
  }
  return { name: "outcomes", mediaType: "application/json", digest: toDigestSet(expected) };
}

/**
 * Executes the v1 verification protocol (design §5.3) against `record` and
 * returns a DSSE-sealed in-toto Statement.
 *
 * The claim is bounded: `result: "stable"` means K consecutive runs of the
 * record's declared test scope produced identical outcome-sets under the
 * declared controls -- no more. Divergence (`unstable`) and infrastructure
 * failure (`error`) are signed and returned by the same call; this function
 * throws only for caller error (`INVALID_INPUT`) or a port that broke its
 * contract (`CONFORMANCE_FAILURE`), never for an environment fact.
 */
export async function verifyEnvironment(
  deps: VerificationDeps,
  record: EnvironmentRecord,
  options: VerifyEnvironmentOptions = {},
): Promise<SealedAttestation> {
  const runCount = options.runCount ?? MINIMUM_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < MINIMUM_RUN_COUNT) {
    invalidInput(
      `The v1 profile requires at least ${MINIMUM_RUN_COUNT} runs; received ${String(options.runCount)}.`,
    );
  }
  const controls = options.controls ?? DEFAULT_VERIFICATION_CONTROLS;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Subject identity: re-seal the parsed record. Sealing is deterministic
  // (JCS-once), so this reproduces the record's identity bytes -- provided the
  // caller parsed exact bytes, which C1's parser enforces.
  const recordBytes = sealEnvironmentRecord(record);
  const recordDigestValue = PrefixedSha256Schema.parse(
    environmentRecordDigest(recordBytes),
  ) as Sha256Digest;

  const startedAt = toRfc3339Utc(deps.clock.now());
  const observation = await observe(deps, record, {
    runCount,
    controls,
    timeoutSeconds,
    signal: options.signal,
  });
  const endedAt = toRfc3339Utc(deps.clock.now());

  const predicate = observation.kind === "error"
    ? buildErrorPredicate(deps, { startedAt, endedAt }, controls, timeoutSeconds, observation)
    : await buildRunsPredicate(
      deps,
      { startedAt, endedAt },
      controls,
      timeoutSeconds,
      observation.runs,
      options.signal,
    );

  const statement = buildEnvironmentVerificationStatement({
    recordDigest: recordDigestValue,
    imageManifestDigest: record.image.manifestDigest as Sha256Digest,
    predicate,
  });
  const sealed = await sealSignedRecord({
    record: statement,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: deps.signer,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    attestationDigest: sealed.recordDigest,
    statement,
    containerIds: observation.kind === "error"
      ? observation.containerIds
      : observation.runs.map((run) => run.containerId),
  };
}

interface ObserveOptions {
  readonly runCount: number;
  readonly controls: VerificationControls;
  readonly timeoutSeconds: number;
  readonly signal: AbortSignal | undefined;
}

async function observe(
  deps: VerificationDeps,
  record: EnvironmentRecord,
  options: ObserveOptions,
): Promise<Observation> {
  const manifestDigest = record.image.manifestDigest as Sha256Digest;

  // Step 1: resolve and pull by digest. `reference` is advisory only.
  let pulled;
  try {
    pulled = await deps.containerRuntime.pullByDigest({
      manifestDigest,
      platform: record.image.platform,
      ...(record.image.reference === undefined ? {} : { reference: record.image.reference }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    return {
      kind: "error",
      reason: "image-unresolvable",
      detail: describeCause(cause),
      containerIds: [],
    };
  }
  if (pulled.resolvedManifestDigest !== manifestDigest) {
    return {
      kind: "error",
      reason: "image-digest-mismatch",
      detail: `registry resolved ${pulled.resolvedManifestDigest}`,
      containerIds: [],
    };
  }

  // Steps 2-4: K runs, each in a fresh container from the same image, install
  // commands first (Findings F-C2-2), outcomes parsed by the pinned parser.
  const env = controlsToEnv(options.controls);
  const runs: RunRecord[] = [];
  const containerIds: string[] = [];
  for (let index = 0; index < options.runCount; index += 1) {
    let result: ContainerRunResult;
    try {
      result = await deps.containerRuntime.runContainer({
        manifestDigest,
        platform: record.image.platform,
        workspace: record.workspace,
        installCommands: record.invocations.install ?? [],
        testCommands: record.invocations.test,
        parser: record.parser,
        env,
        network: "none",
        timeoutSeconds: options.timeoutSeconds,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      return {
        kind: "error",
        reason: "run-command-failed",
        detail: `run ${index}: ${describeCause(cause)}`,
        containerIds,
      };
    }
    containerIds.push(result.containerId);

    if (result.timedOut) {
      return {
        kind: "error",
        reason: "runtime-timeout",
        detail: `run ${index} exceeded ${options.timeoutSeconds}s`,
        containerIds,
      };
    }
    const failedInstall = result.installExitCodes.findIndex((code) => code !== 0);
    if (failedInstall >= 0) {
      return {
        kind: "error",
        reason: "install-command-failed",
        detail: `run ${index}: install command ${failedInstall} exited ${result.installExitCodes[failedInstall]}`,
        containerIds,
      };
    }
    // A non-zero *test* exit code is not a failure: expected-fail baselines are
    // first-class (design §5.2). Only an empty outcome set is a protocol error.
    if (Object.keys(result.outcomes).length === 0) {
      return {
        kind: "error",
        reason: "parser-produced-no-outcomes",
        detail: `run ${index} produced no parsed outcomes`,
        containerIds,
      };
    }

    runs.push({
      outcomes: result.outcomes,
      digest: outcomeSetDigest(result.outcomes),
      observation: { outcomeSetDigest: outcomeSetDigest(result.outcomes), wallSeconds: result.wallSeconds },
      containerId: result.containerId,
    });
  }

  return { kind: "runs", runs };
}

function buildErrorPredicate(
  deps: VerificationDeps,
  window: { startedAt: string; endedAt: string },
  controls: VerificationControls,
  timeoutSeconds: number,
  observation: Extract<Observation, { kind: "error" }>,
): EnvironmentVerificationPredicate {
  return {
    protocol: ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    result: "error",
    window,
    controls,
    runtime: { timeoutSeconds },
    verifier: deps.verifier,
    failure: {
      stage: stageForFailureReason(observation.reason),
      reason: observation.reason,
      ...(observation.detail === undefined ? {} : { detail: observation.detail }),
    },
  } as EnvironmentVerificationPredicate;
}

async function buildRunsPredicate(
  deps: VerificationDeps,
  window: { startedAt: string; endedAt: string },
  controls: VerificationControls,
  timeoutSeconds: number,
  runs: readonly RunRecord[],
  signal: AbortSignal | undefined,
): Promise<EnvironmentVerificationPredicate> {
  const reference = runs[0]!;
  // Step 5: compare. Set equality over (test id -> status); timing never enters.
  const divergent = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => !outcomeSetsEqual(run.outcomes, reference.outcomes));

  const baselineDescriptor = await storeOutcomes(deps.artifactStore, reference.outcomes, signal);
  const tally = tallyOutcomeSet(reference.outcomes);
  const wallSeconds = runs.map((run) => run.observation.wallSeconds);
  const base = {
    protocol: ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    window,
    runs: {
      count: runs.length,
      outcomeSetDigest: reference.digest,
      perRun: runs.map((run) => run.observation),
    },
    baseline: { ...tally, outcomes: baselineDescriptor },
    controls,
    runtime: {
      minSeconds: Math.min(...wallSeconds),
      maxSeconds: Math.max(...wallSeconds),
      timeoutSeconds,
    },
    verifier: deps.verifier,
  };

  if (divergent.length === 0) {
    return { ...base, result: "stable" } as EnvironmentVerificationPredicate;
  }

  const divergentRuns = [];
  for (const { run, index } of divergent) {
    divergentRuns.push({
      index,
      outcomeSetDigest: run.digest,
      outcomes: await storeOutcomes(deps.artifactStore, run.outcomes, signal),
    });
  }
  return {
    ...base,
    result: "unstable",
    failure: {
      stage: "compare",
      reason: "outcome-set-divergence",
      detail: `${divergentRuns.length} of ${runs.length} runs diverged from run 0`,
      divergence: {
        referenceRunIndex: 0,
        referenceOutcomeSetDigest: reference.digest,
        divergentRuns,
      },
    },
  } as EnvironmentVerificationPredicate;
}
```

> **Note on `baseline` under `unstable`:** the design's presence rule keeps `baseline`
> present for every non-`error` result, so an `unstable` attestation's baseline is run 0's
> observation — one observation among divergent ones, not the environment's outcome-set.
> `runs.outcomeSetDigest` follows the same convention. State this in the README; a consumer
> reading a baseline off an `unstable` attestation without reading `failure.divergence` is
> reading past the claim.

- [ ] **Step 4: Replace the stub record with a real one**

Once T10 lands `buildEnvironmentCandidatesFromRows`, delete `stubRecord()` and the
`as never` casts from `src/verify.test.ts`, replacing them with:

```ts
import { CONFORMANCE_ROW, buildConformanceRecord } from "./import-source.js";
const record = buildConformanceRecord();
```

Until then the casts stay and the test is honest about being a stub.

- [ ] **Step 5: Export and run**

Add to `src/index.ts`:

```ts
export {
  DEFAULT_VERIFICATION_CONTROLS,
  verifyEnvironment,
  type SealedAttestation,
  type VerificationDeps,
  type VerifyEnvironmentOptions,
} from "./verify.js";
export type {
  ArtifactPutReceipt,
  ArtifactStore,
  Clock,
  CommandSpec,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerRuntime,
  EnvironmentParserIdentity,
  ImagePullRequest,
  ImagePullResult,
} from "./ports.js";
```

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 32 tests pass; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): verifyEnvironment drives the K-run protocol to a sealed attestation"
```

---

### Task 9: Negative attestations as first-class outputs

`unstable` and `error` are products, not exceptions (design §5.2, D3). This task exists so
that property has its own tests rather than riding along on the happy path.

**Files:**
- Modify: `src/verify.test.ts`

**Interfaces:**
- Consumes: T8's `verifyEnvironment`.
- Produces: no new symbols — behavioral coverage only.

- [ ] **Step 1: Write the failing negative-path tests**

Append to `src/verify.test.ts`:

```ts
describe("verifyEnvironment — negative attestations are first-class", () => {
  const DIVERGENT: OutcomeSet = {
    "tests/test_a.py::test_one": "pass",
    "tests/test_b.py::test_two": "pass",
  };

  function deps(runtime: ContainerRuntime, artifactStore = memoryStore()) {
    return { containerRuntime: runtime, artifactStore, signer, clock: fixedClock(), verifier: VERIFIER };
  }

  it("signs an unstable attestation when run 3 of 5 diverges", async () => {
    const runtime = scriptedRuntime([OUTCOMES, OUTCOMES, DIVERGENT, OUTCOMES, OUTCOMES]);
    const store = memoryStore();
    const attestation = await verifyEnvironment(deps(runtime, store), stubRecord() as never);
    const { predicate } = attestation.statement;

    expect(predicate.result).toBe("unstable");
    expect(predicate.failure?.stage).toBe("compare");
    expect(predicate.failure?.reason).toBe("outcome-set-divergence");
    expect(predicate.failure?.divergence?.referenceRunIndex).toBe(0);
    expect(predicate.failure?.divergence?.divergentRuns).toEqual([{
      index: 2,
      outcomeSetDigest: outcomeSetDigest(DIVERGENT),
      outcomes: {
        name: "outcomes",
        mediaType: "application/json",
        digest: { sha256: outcomeSetDigest(DIVERGENT).slice("sha256:".length) },
      },
    }]);
    // Both outcome sets are retrievable, so a third party can re-compare them.
    expect(store.bytes.has(outcomeSetDigest(OUTCOMES))).toBe(true);
    expect(store.bytes.has(outcomeSetDigest(DIVERGENT))).toBe(true);
    expect(predicate.runs?.count).toBe(5);
  });

  it("signs an error attestation when the image has vanished", async () => {
    const runtime: ContainerRuntime = {
      async pullByDigest() {
        throw new Error("manifest unknown");
      },
      async runContainer() {
        throw new Error("unreachable");
      },
    };
    const attestation = await verifyEnvironment(deps(runtime), stubRecord() as never);
    const { predicate } = attestation.statement;

    expect(predicate.result).toBe("error");
    expect(predicate.failure).toEqual({
      stage: "acquire",
      reason: "image-unresolvable",
      detail: "manifest unknown",
    });
    expect(predicate.runs).toBeUndefined();
    expect(predicate.baseline).toBeUndefined();
    expect(predicate.runtime).toEqual({ timeoutSeconds: 1800 });
    expect(predicate.window.startedAt).toBe("2026-07-31T09:00:00.000Z");
    expect(attestation.containerIds).toEqual([]);
  });

  it("signs an error attestation when the registry resolves a different digest", async () => {
    const runtime: ContainerRuntime = {
      async pullByDigest() {
        return { resolvedManifestDigest: `sha256:${"9".repeat(64)}` as Sha256Digest };
      },
      async runContainer() {
        throw new Error("unreachable");
      },
    };
    const { predicate } = (await verifyEnvironment(deps(runtime), stubRecord() as never)).statement;
    expect(predicate.result).toBe("error");
    expect(predicate.failure?.reason).toBe("image-digest-mismatch");
    expect(predicate.failure?.stage).toBe("acquire");
  });

  it("signs an error attestation for an install failure and for an empty outcome set", async () => {
    const installFailure: ContainerRuntime = {
      async pullByDigest(request) {
        return { resolvedManifestDigest: request.manifestDigest };
      },
      async runContainer() {
        return {
          containerId: "container-0",
          installExitCodes: [0, 127],
          testExitCodes: [],
          outcomes: {},
          wallSeconds: 1,
          timedOut: false,
        };
      },
    };
    const install = (await verifyEnvironment(deps(installFailure), stubRecord() as never)).statement;
    expect(install.predicate.failure?.reason).toBe("install-command-failed");
    expect(install.predicate.failure?.stage).toBe("install");

    const emptyOutcomes: ContainerRuntime = {
      async pullByDigest(request) {
        return { resolvedManifestDigest: request.manifestDigest };
      },
      async runContainer() {
        return {
          containerId: "container-0",
          installExitCodes: [],
          testExitCodes: [0],
          outcomes: {},
          wallSeconds: 1,
          timedOut: false,
        };
      },
    };
    const empty = (await verifyEnvironment(deps(emptyOutcomes), stubRecord() as never)).statement;
    expect(empty.predicate.failure?.reason).toBe("parser-produced-no-outcomes");
    expect(empty.predicate.failure?.stage).toBe("run");
  });

  it("never throws for an environment fact — every path returns a signed envelope", async () => {
    for (const runtime of [
      scriptedRuntime([OUTCOMES, DIVERGENT, OUTCOMES, OUTCOMES, OUTCOMES]),
      {
        async pullByDigest() { throw new Error("gone"); },
        async runContainer() { throw new Error("unreachable"); },
      } as ContainerRuntime,
    ]) {
      const attestation = await verifyEnvironment(deps(runtime), stubRecord() as never);
      expect(parseDsseEnvelope(attestation.envelopeBytes).signatures).toHaveLength(1);
    }
  });
});
```

- [ ] **Step 2: Run and confirm which fail**

Run: `corepack yarn@4.13.0 vitest run src/verify.test.ts`
Expected: the divergence and error tests fail against any gap left in T8's driver (most
likely the exact `detail` strings and the empty-`runtime` shape). Fix `src/verify.ts` until
green — do not weaken the assertions.

- [ ] **Step 3: Run the whole suite**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 37 tests pass; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/environments/verification/src
git commit -m "test(environments): negative verification attestations as first-class outputs"
```

---

### Task 10: The import source — full-identity row grouping

**Files:**
- Create: `src/import-source.ts`, `src/import-source.test.ts`
- Modify: `src/index.ts`, `src/verify.test.ts` (drop the stub record, per T8 step 4)

**Interfaces:**
- Consumes: `EnvironmentRecord`, `sealEnvironmentRecord`, `parseEnvironmentRecord` from
  `@jinn-network/environment-record`; `canonicalJsonBytes`, `sha256Hex`,
  `compareCodeUnitStrings` from `@jinn-network/trust-core`.
- Produces (program §4 pinned name):
  `buildEnvironmentCandidatesFromRows(rows: readonly UpstreamEnvironmentRow[]): EnvironmentRecord[]`,
  plus `UpstreamEnvironmentRow`, `CONFORMANCE_ROW`, `buildConformanceRecord()`.

- [ ] **Step 1: Write the failing grouping test**

`src/import-source.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { EnvironmentVerificationError } from "./errors.js";
import {
  buildEnvironmentCandidatesFromRows,
  type UpstreamEnvironmentRow,
} from "./import-source.js";

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;

function row(overrides: Partial<UpstreamEnvironmentRow> = {}): UpstreamEnvironmentRow {
  return {
    instance_id: "owner__name-1",
    repo: "owner/name",
    base_commit: "0".repeat(40),
    image_name: `registry.test/owner/name@${IMAGE_A}`,
    install_config: { test_cmd: "pytest -q tests", log_parser: "pytest" },
    parser_version: "1.0.0",
    parser_digest: `sha256:${"e".repeat(64)}`,
    source_license: "MIT",
    dataset: "nebius/SWE-rebench",
    revision: "2026-06-01",
    ...overrides,
  };
}

describe("buildEnvironmentCandidatesFromRows", () => {
  it("collapses rows sharing the full identity tuple into one record", () => {
    const records = buildEnvironmentCandidatesFromRows([
      row(),
      row({ instance_id: "owner__name-2" }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.image.manifestDigest).toBe(IMAGE_A);
    expect(records[0]!.lineage?.upstream.keys).toEqual(["owner__name-1", "owner__name-2"]);
  });

  it("splits on any divergence in the identity tuple", () => {
    const cases: Partial<UpstreamEnvironmentRow>[] = [
      { base_commit: "1".repeat(40) },
      { image_name: `registry.test/owner/name@${IMAGE_B}` },
      { platform: "linux/arm64" },
      { install_config: { test_cmd: "pytest -q tests/unit", log_parser: "pytest" } },
      { install_config: { test_cmd: "pytest -q tests", log_parser: "pytest-json" } },
      { parser_version: "2.0.0" },
    ];
    for (const override of cases) {
      const records = buildEnvironmentCandidatesFromRows([
        row(),
        row({ instance_id: "owner__name-2", ...override }),
      ]);
      expect(records).toHaveLength(2);
    }
  });

  it("emits records that round-trip through the record package's own parser", () => {
    const [record] = buildEnvironmentCandidatesFromRows([row()]);
    expect(record!.kind).toBe("https://jinn.network/records/environment/1.0");
    expect(record!.invocations.test).toEqual([{ bin: "pytest", args: ["-q", "tests"] }]);
    expect(record!.workspace).toBe("/testbed");
    expect(record!.build.reproducibilityTier).toBe(0);
    expect(record!.rights.sourceLicense).toBe("MIT");
  });

  it("refuses rows whose image reference is not digest-qualified", () => {
    expect(() => buildEnvironmentCandidatesFromRows([
      row({ image_name: "registry.test/owner/name:latest" }),
    ])).toThrow(/owner__name-1/u);
  });

  it("refuses shell-bearing commands rather than tokenizing them", () => {
    for (const test_cmd of ["pytest -q && echo done", "pytest $ARGS", "pytest -q | tee log"]) {
      expect(() => buildEnvironmentCandidatesFromRows([
        row({ install_config: { test_cmd, log_parser: "pytest" } }),
      ])).toThrow(EnvironmentVerificationError);
    }
  });

  it("refuses a group whose rows disagree on upstream lineage", () => {
    expect(() => buildEnvironmentCandidatesFromRows([
      row(),
      row({ instance_id: "owner__name-2", revision: "2026-07-01" }),
    ])).toThrow(/lineage/u);
  });

  it("refuses a row with no declared source license", () => {
    expect(() => buildEnvironmentCandidatesFromRows([
      row({ source_license: undefined }),
    ])).toThrow(/source_license/u);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/import-source.test.ts`
Expected: FAIL — `Failed to resolve import "./import-source.js"`.

- [ ] **Step 3: Implement**

`src/import-source.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  parseEnvironmentRecord,
  sealEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import { canonicalJsonBytes, compareCodeUnitStrings, sha256Hex } from "@jinn-network/trust-core";

import { invalidInput } from "./errors.js";
import type { CommandSpec } from "./ports.js";

const DEFAULT_PLATFORM = "linux/amd64";
const DEFAULT_WORKSPACE = "/testbed";
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const DIGEST_QUALIFIED = /@(sha256:[0-9a-f]{64})$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
/** Any shell metacharacter refuses the row. This package never interpolates a
 * shell, and silently tokenizing `a && b` would fabricate a command the
 * upstream row did not declare. */
const SHELL_METACHARACTERS = /[|&;<>$`(){}\[\]*?~!#\n\r"'\\]/u;

/** The upstream dataset row shape this v1 import source reads (SWE-rebench and
 * its relatives). Field names mirror the upstream JSON, hence the snake_case. */
export interface UpstreamEnvironmentRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly repo_url?: string;
  readonly base_commit: string;
  /** MUST be digest-qualified: `registry/name@sha256:<64 hex>`. */
  readonly image_name: string;
  readonly platform?: string;
  readonly workspace?: string;
  readonly install_config: {
    readonly install?: string | readonly string[];
    readonly test_cmd: string | readonly string[];
    readonly log_parser: string;
  };
  readonly parser_version?: string;
  readonly parser_digest?: string;
  readonly parser_uri?: string;
  readonly source_license?: string;
  readonly dataset?: string;
  readonly revision?: string;
  readonly image_provider_id?: string;
  readonly image_provider_version?: string;
}

function toCommandSpecs(
  value: string | readonly string[] | undefined,
  instanceId: string,
  field: string,
): CommandSpec[] {
  if (value === undefined) return [];
  const commands = typeof value === "string" ? [value] : [...value];
  return commands.map((command) => {
    if (SHELL_METACHARACTERS.test(command)) {
      invalidInput(
        `Row ${instanceId}: ${field} "${command}" carries shell metacharacters; `
        + "environment records hold shell-free CommandSpecs only.",
      );
    }
    const tokens = command.trim().split(/\s+/u).filter(Boolean);
    const [bin, ...args] = tokens;
    if (bin === undefined) invalidInput(`Row ${instanceId}: ${field} is empty.`);
    return { bin, args };
  });
}

interface CandidateParts {
  readonly identity: string;
  readonly row: UpstreamEnvironmentRow;
  readonly manifestDigest: string;
  readonly platform: string;
  readonly invocations: { install: CommandSpec[]; test: CommandSpec[] };
  readonly parser: { id: string; version: string; digest: string; uri?: string };
}

function partsFor(row: UpstreamEnvironmentRow): CandidateParts {
  const digestMatch = DIGEST_QUALIFIED.exec(row.image_name);
  if (!digestMatch) {
    invalidInput(
      `Row ${row.instance_id}: image_name "${row.image_name}" is not digest-qualified `
      + "(expected registry/name@sha256:<64 hex>).",
    );
  }
  if (!COMMIT.test(row.base_commit)) {
    invalidInput(`Row ${row.instance_id}: base_commit must be 40 lowercase hex digits.`);
  }
  if (row.source_license === undefined || row.source_license.length === 0) {
    invalidInput(
      `Row ${row.instance_id}: source_license is required (D12 — declared SPDX expression).`,
    );
  }
  if (row.parser_digest === undefined) {
    invalidInput(
      `Row ${row.instance_id}: parser_digest is required — without it, third-party `
      + "re-verification is not executable.",
    );
  }

  const platform = row.platform ?? DEFAULT_PLATFORM;
  const invocations = {
    install: toCommandSpecs(row.install_config.install, row.instance_id, "install"),
    test: toCommandSpecs(row.install_config.test_cmd, row.instance_id, "test_cmd"),
  };
  if (invocations.test.length === 0) {
    invalidInput(`Row ${row.instance_id}: test_cmd is required — it is the verification scope.`);
  }
  const parser = {
    id: row.install_config.log_parser,
    version: row.parser_version ?? "unversioned",
    digest: row.parser_digest,
    ...(row.parser_uri === undefined ? {} : { uri: row.parser_uri }),
  };

  // The FULL record identity (design §6): source repo+commit, image manifest
  // digest, platform, invocations, parser. A narrower key would silently attest
  // a test scope some rows never declared.
  const identity = sha256Hex(canonicalJsonBytes({
    source: { repo: row.repo, commit: row.base_commit },
    image: { manifestDigest: digestMatch[1], platform },
    invocations,
    parser,
  }));

  return { identity, row, manifestDigest: digestMatch[1]!, platform, invocations, parser };
}

/**
 * Groups upstream rows into candidate environment records by full record
 * identity: one record per distinct environment, never one per row. Divergence
 * in any identity component splits the group.
 */
export function buildEnvironmentCandidatesFromRows(
  rows: readonly UpstreamEnvironmentRow[],
): EnvironmentRecord[] {
  const groups = new Map<string, CandidateParts[]>();
  for (const row of rows) {
    const parts = partsFor(row);
    const existing = groups.get(parts.identity);
    if (existing) existing.push(parts);
    else groups.set(parts.identity, [parts]);
  }

  const records: EnvironmentRecord[] = [];
  for (const members of groups.values()) {
    const first = members[0]!;
    const row = first.row;

    const datasets = new Set(members.map((member) => member.row.dataset ?? ""));
    const revisions = new Set(members.map((member) => member.row.revision ?? ""));
    if (datasets.size > 1 || revisions.size > 1) {
      invalidInput(
        `Rows sharing environment identity disagree on upstream lineage `
        + `(datasets: ${[...datasets].join(", ")}; revisions: ${[...revisions].join(", ")}).`,
      );
    }

    if (row.repo_url === undefined && !REPO_SLUG.test(row.repo)) {
      invalidInput(`Row ${row.instance_id}: repo_url is required for non-slug repo "${row.repo}".`);
    }
    const keys = members
      .map((member) => member.row.instance_id)
      .sort(compareCodeUnitStrings);

    const candidate = {
      kind: "https://jinn.network/records/environment/1.0",
      source: {
        repo: row.repo,
        repoUrl: row.repo_url ?? `https://github.com/${row.repo}`,
        commit: row.base_commit,
      },
      image: {
        manifestDigest: first.manifestDigest,
        platform: first.platform,
        reference: row.image_name,
      },
      workspace: row.workspace ?? DEFAULT_WORKSPACE,
      invocations: first.invocations.install.length === 0
        ? { test: first.invocations.test }
        : { install: first.invocations.install, test: first.invocations.test },
      parser: first.parser,
      build: {
        reproducibilityTier: 0,
        ...(row.image_provider_id === undefined ? {} : {
          provider: {
            id: row.image_provider_id,
            version: row.image_provider_version ?? "unversioned",
          },
        }),
      },
      rights: { sourceLicense: row.source_license!, basis: "upstream-permissive-filter" },
      ...(row.dataset === undefined ? {} : {
        lineage: {
          upstream: { dataset: row.dataset, revision: row.revision ?? "unversioned", keys },
        },
      }),
    };

    // Round-trip through the record package: sealing validates, parsing returns
    // the canonical parsed shape. A schema divergence surfaces here, loudly.
    records.push(parseEnvironmentRecord(sealEnvironmentRecord(candidate as EnvironmentRecord)));
  }
  return records;
}

/** The row this package's own tests and kit build a record from. */
export const CONFORMANCE_ROW: UpstreamEnvironmentRow = Object.freeze({
  instance_id: "owner__name-1",
  repo: "owner/name",
  repo_url: "https://github.com/owner/name",
  base_commit: "0".repeat(40),
  image_name: `registry.test/owner/name@sha256:${"c".repeat(64)}`,
  platform: "linux/amd64",
  workspace: "/testbed",
  install_config: { test_cmd: "pytest -q tests", log_parser: "pytest" },
  parser_version: "1.0.0",
  parser_digest: `sha256:${"e".repeat(64)}`,
  parser_uri: "https://example.test/parsers/pytest-1.0.0.tar.gz",
  source_license: "MIT",
  dataset: "example/dataset",
  revision: "2026-06-01",
});

export function buildConformanceRecord(): EnvironmentRecord {
  return buildEnvironmentCandidatesFromRows([CONFORMANCE_ROW])[0]!;
}
```

- [ ] **Step 4: Retire the stub record in `verify.test.ts`**

Delete `stubRecord()` and every `as never`; import `buildConformanceRecord` and
`CONFORMANCE_ROW` instead. Update `IMAGE_DIGEST` to read
`buildConformanceRecord().image.manifestDigest`.

- [ ] **Step 5: Export and run**

Add to `src/index.ts`:

```ts
export {
  buildEnvironmentCandidatesFromRows,
  type UpstreamEnvironmentRow,
} from "./import-source.js";
```

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: 44 tests pass; typecheck exits 0. If C1's record schema rejects any field this
builder emits (for example by requiring `build.provider`), that is a **stop-and-report**
under contract 11 — record it in §Findings, do not loosen the record.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): import source groups upstream rows by full record identity"
```

---

### Task 11: The staged state module

Legacy reference (read, never import):
`client/src/solver-types/_swe-rebench-v2-harvest-state.ts`. Three deliberate divergences:
transitions are pure functions over an immutable file value (the legacy store mutated a
cached object); the disposition comes from the closed taxonomy of T4 rather than a regex
over prose; and a corrupt state file **fails loud** instead of silently starting clean —
the legacy `catch {}` at `:244` discards every recorded job.

**Files:**
- Create: `src/staged-state.ts`, `src/staged-state.test.ts`, `src/staged-state-store.ts`,
  `src/staged-state-store.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `compareCodeUnitStrings`, `Sha256Digest` from
  `@jinn-network/trust-core`; T4's `classifyVerificationFailure`.
- Produces: `STAGED_STATE_SCHEMA_VERSION`, `STAGED_STAGES`, `StagedStage`,
  `STAGED_DISPOSITIONS`, `StagedDisposition`, `StagedJob`, `StagedStateFile`,
  `createStagedStateFile`, `upsertStagedJobs`, `advanceStagedJob`, `recordStagedAttested`,
  `recordStagedFailure`, `dueStagedJobs`, `serializeStagedStateFile`,
  `parseStagedStateFile`, `StagedStateStore`, `createFileStagedStateStore(directory)`,
  `MAX_INFRASTRUCTURE_ATTEMPTS`.

- [ ] **Step 1: Write the failing pure-algebra test**

`src/staged-state.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { EnvironmentVerificationError } from "./errors.js";
import {
  MAX_INFRASTRUCTURE_ATTEMPTS,
  advanceStagedJob,
  createStagedStateFile,
  dueStagedJobs,
  parseStagedStateFile,
  recordStagedAttested,
  recordStagedFailure,
  serializeStagedStateFile,
  upsertStagedJobs,
} from "./staged-state.js";

const DIGEST_A = `sha256:${"1".repeat(64)}` as const;
const DIGEST_B = `sha256:${"2".repeat(64)}` as const;
const T0 = "2026-07-31T09:00:00.000Z";
const T1 = "2026-07-31T09:05:00.000Z";

describe("staged state algebra", () => {
  it("upserts idempotently and leaves the input untouched", () => {
    const empty = createStagedStateFile(T0);
    const once = upsertStagedJobs(empty, [DIGEST_A, DIGEST_B], T0);
    const twice = upsertStagedJobs(once, [DIGEST_A], T1);
    expect(Object.keys(once.jobs)).toHaveLength(2);
    expect(Object.keys(twice.jobs)).toHaveLength(2);
    expect(twice.jobs[DIGEST_A]!.createdAt).toBe(T0);
    expect(Object.keys(empty.jobs)).toHaveLength(0);
  });

  it("advances stages and records an attestation as terminal", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    file = advanceStagedJob(file, DIGEST_A, "running", T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("running");
    file = recordStagedAttested(file, DIGEST_A, DIGEST_B, T1);
    expect(file.jobs[DIGEST_A]!.stage).toBe("complete");
    expect(file.jobs[DIGEST_A]!.disposition).toBe("attested");
    expect(file.jobs[DIGEST_A]!.attestationDigest).toBe(DIGEST_B);
    expect(dueStagedJobs(file, T1)).toHaveLength(0);
  });

  it("retries infrastructure failures up to the cap, then parks them", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    for (let attempt = 1; attempt < MAX_INFRASTRUCTURE_ATTEMPTS; attempt += 1) {
      file = recordStagedFailure(file, DIGEST_A, "image-unresolvable", T0, 60_000);
      expect(file.jobs[DIGEST_A]!.disposition).toBe("retrying");
    }
    file = recordStagedFailure(file, DIGEST_A, "image-unresolvable", T0, 60_000);
    expect(file.jobs[DIGEST_A]!.disposition).toBe("failed_infrastructure");
    expect(file.jobs[DIGEST_A]!.nextAttemptAt).toBeUndefined();
  });

  it("parks divergence as quarantined and a wrong digest as terminal policy at once", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A, DIGEST_B], T0);
    file = recordStagedFailure(file, DIGEST_A, "outcome-set-divergence", T0, 60_000);
    file = recordStagedFailure(file, DIGEST_B, "image-digest-mismatch", T0, 60_000);
    expect(file.jobs[DIGEST_A]!.disposition).toBe("quarantined");
    expect(file.jobs[DIGEST_B]!.disposition).toBe("terminal_policy");
    expect(dueStagedJobs(file, T1)).toHaveLength(0);
  });

  it("orders due jobs by creation time then key, and honors the retry fence", () => {
    let file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_B, DIGEST_A], T0);
    expect(dueStagedJobs(file, T0).map((job) => job.key)).toEqual([DIGEST_A, DIGEST_B]);
    file = recordStagedFailure(file, DIGEST_A, "run-command-failed", T0, 600_000);
    expect(dueStagedJobs(file, T1).map((job) => job.key)).toEqual([DIGEST_B]);
    expect(dueStagedJobs(file, "2026-07-31T09:20:00.000Z").map((job) => job.key))
      .toEqual([DIGEST_A, DIGEST_B]);
  });

  it("round-trips through canonical bytes and refuses a corrupt file", () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    expect(parseStagedStateFile(serializeStagedStateFile(file))).toEqual(file);
    expect(() => parseStagedStateFile(new TextEncoder().encode('{"jobs":')))
      .toThrow(EnvironmentVerificationError);
    expect(() => parseStagedStateFile(new TextEncoder().encode('{"schemaVersion":"nope"}')))
      .toThrow(EnvironmentVerificationError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/staged-state.test.ts`
Expected: FAIL — `Failed to resolve import "./staged-state.js"`.

- [ ] **Step 3: Implement the pure algebra**

`src/staged-state.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, compareCodeUnitStrings, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema } from "./digests.js";
import { invalidInput } from "./errors.js";
import {
  VERIFICATION_FAILURE_REASONS,
  classifyVerificationFailure,
  type VerificationFailureReason,
} from "./failures.js";

export const STAGED_STATE_SCHEMA_VERSION = "environment-verification-staged-state.v1" as const;
export const MAX_INFRASTRUCTURE_ATTEMPTS = 3;

export const STAGED_STAGES = ["discovered", "acquiring", "running", "attesting", "complete"] as const;
export type StagedStage = (typeof STAGED_STAGES)[number];

export const STAGED_DISPOSITIONS = [
  "pending",
  "retrying",
  "attested",
  "terminal_policy",
  "awaiting_input",
  "quarantined",
  "failed_infrastructure",
] as const;
export type StagedDisposition = (typeof STAGED_DISPOSITIONS)[number];

const StagedJobSchema = z.strictObject({
  key: PrefixedSha256Schema,
  stage: z.enum(STAGED_STAGES),
  disposition: z.enum(STAGED_DISPOSITIONS),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().min(1).optional(),
  reason: z.enum(VERIFICATION_FAILURE_REASONS).optional(),
  attestationDigest: PrefixedSha256Schema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type StagedJob = z.infer<typeof StagedJobSchema>;

const StagedStateFileSchema = z.strictObject({
  schemaVersion: z.literal(STAGED_STATE_SCHEMA_VERSION),
  updatedAt: z.string().min(1),
  jobs: z.record(PrefixedSha256Schema, StagedJobSchema),
});
export type StagedStateFile = z.infer<typeof StagedStateFileSchema>;

/** A job is keyed by the environment record digest: one record, one job. */
export function createStagedStateFile(now: string): StagedStateFile {
  return { schemaVersion: STAGED_STATE_SCHEMA_VERSION, updatedAt: now, jobs: {} };
}

function withJobs(
  file: StagedStateFile,
  jobs: Record<string, StagedJob>,
  now: string,
): StagedStateFile {
  return { schemaVersion: STAGED_STATE_SCHEMA_VERSION, updatedAt: now, jobs };
}

function requireJob(file: StagedStateFile, key: Sha256Digest): StagedJob {
  const job = file.jobs[key];
  if (job === undefined) invalidInput(`Unknown staged job ${key}.`);
  return job;
}

/** Idempotent: an existing key keeps its stage, disposition, and createdAt. */
export function upsertStagedJobs(
  file: StagedStateFile,
  keys: readonly Sha256Digest[],
  now: string,
): StagedStateFile {
  const jobs: Record<string, StagedJob> = { ...file.jobs };
  for (const key of keys) {
    if (jobs[key] !== undefined) continue;
    jobs[key] = {
      key,
      stage: "discovered",
      disposition: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
  return withJobs(file, jobs, now);
}

export function advanceStagedJob(
  file: StagedStateFile,
  key: Sha256Digest,
  stage: StagedStage,
  now: string,
): StagedStateFile {
  const job = requireJob(file, key);
  return withJobs(file, { ...file.jobs, [key]: { ...job, stage, updatedAt: now } }, now);
}

export function recordStagedAttested(
  file: StagedStateFile,
  key: Sha256Digest,
  attestationDigest: Sha256Digest,
  now: string,
): StagedStateFile {
  const job = requireJob(file, key);
  const { nextAttemptAt: _fence, reason: _reason, ...rest } = job;
  return withJobs(file, {
    ...file.jobs,
    [key]: {
      ...rest,
      stage: "complete",
      disposition: "attested",
      attestationDigest,
      updatedAt: now,
    },
  }, now);
}

/**
 * Applies the closed taxonomy's disposition. `failed_infrastructure` retries
 * behind a fence until `MAX_INFRASTRUCTURE_ATTEMPTS`; every other disposition
 * is terminal for this record and clears the fence.
 */
export function recordStagedFailure(
  file: StagedStateFile,
  key: Sha256Digest,
  reason: VerificationFailureReason,
  now: string,
  retryDelayMs: number,
): StagedStateFile {
  const job = requireJob(file, key);
  const disposition = classifyVerificationFailure(reason);
  if (disposition !== "failed_infrastructure") {
    const { nextAttemptAt: _fence, ...rest } = job;
    return withJobs(file, {
      ...file.jobs,
      [key]: { ...rest, disposition, reason, updatedAt: now },
    }, now);
  }

  const attempts = job.attempts + 1;
  if (attempts >= MAX_INFRASTRUCTURE_ATTEMPTS) {
    const { nextAttemptAt: _fence, ...rest } = job;
    return withJobs(file, {
      ...file.jobs,
      [key]: { ...rest, attempts, disposition: "failed_infrastructure", reason, updatedAt: now },
    }, now);
  }
  const fence = new Date(new Date(now).getTime() + retryDelayMs);
  if (!Number.isFinite(fence.getTime())) invalidInput(`Invalid timestamp or delay for ${key}.`);
  return withJobs(file, {
    ...file.jobs,
    [key]: {
      ...job,
      attempts,
      disposition: "retrying",
      reason,
      nextAttemptAt: fence.toISOString(),
      updatedAt: now,
    },
  }, now);
}

/** Resumable work: pending or fenced-and-due, ordered by creation then key. */
export function dueStagedJobs(file: StagedStateFile, now: string): readonly StagedJob[] {
  return Object.values(file.jobs)
    .filter((job) => job.disposition === "pending" || job.disposition === "retrying")
    .filter((job) => job.nextAttemptAt === undefined || job.nextAttemptAt <= now)
    .sort((left, right) =>
      compareCodeUnitStrings(left.createdAt, right.createdAt)
      || compareCodeUnitStrings(left.key, right.key));
}

export function serializeStagedStateFile(file: StagedStateFile): Uint8Array {
  return canonicalJsonBytes(file);
}

/** Fails loud on a corrupt file. A silent reset would discard every recorded
 * job -- exactly what the legacy store did. */
export function parseStagedStateFile(bytes: Uint8Array): StagedStateFile {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("Staged state file is not valid UTF-8 JSON.", cause);
  }
  const result = StagedStateFileSchema.safeParse(decoded);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid staged state file at /${first.path.join("/")}: ${first.message}`
        : "Invalid staged state file.",
    );
  }
  return result.data;
}

/** Persistence port. `createFileStagedStateStore` is the shipped implementation. */
export interface StagedStateStore {
  read(): Promise<StagedStateFile | null>;
  write(file: StagedStateFile): Promise<void>;
}
```

- [ ] **Step 4: Write the failing store test**

`src/staged-state-store.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EnvironmentVerificationError } from "./errors.js";
import { createStagedStateFile, upsertStagedJobs } from "./staged-state.js";
import { createFileStagedStateStore } from "./staged-state-store.js";

const DIGEST_A = `sha256:${"1".repeat(64)}` as const;
const T0 = "2026-07-31T09:00:00.000Z";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-staged-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file staged-state store", () => {
  it("returns null before anything is written", async () => {
    expect(await createFileStagedStateStore(directory).read()).toBeNull();
  });

  it("round-trips and resumes across store instances", async () => {
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await createFileStagedStateStore(directory).write(file);
    expect(await createFileStagedStateStore(directory).read()).toEqual(file);
  });

  it("leaves no temporary files behind", async () => {
    const store = createFileStagedStateStore(directory);
    await store.write(upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0));
    const entries = await readdir(directory);
    expect(entries).toEqual(["staged-state.json"]);
  });

  it("ignores an abandoned temporary file from a crashed write", async () => {
    const store = createFileStagedStateStore(directory);
    const file = upsertStagedJobs(createStagedStateFile(T0), [DIGEST_A], T0);
    await store.write(file);
    await writeFile(join(directory, "staged-state.json.1234.tmp"), "{ truncated", "utf8");
    expect(await store.read()).toEqual(file);
  });

  it("fails loud on a corrupt state file rather than starting clean", async () => {
    await writeFile(join(directory, "staged-state.json"), "{ not json", "utf8");
    await expect(createFileStagedStateStore(directory).read())
      .rejects.toThrow(EnvironmentVerificationError);
  });
});
```

- [ ] **Step 5: Implement the store**

`src/staged-state-store.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// The only production filesystem surface in this package. The directory is an
// argument, never ambient: nothing here reads process.env, and the guard's
// filesystem allowlist names exactly this file (Findings F-C2-5).

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseStagedStateFile,
  serializeStagedStateFile,
  type StagedStateFile,
  type StagedStateStore,
} from "./staged-state.js";

const STATE_FILE = "staged-state.json";

/**
 * Crash-safe staged-state persistence: write to a unique temporary file, then
 * rename it over the state file. A crash mid-write leaves the previous state
 * intact and an abandoned `.tmp` sibling that no read ever consults.
 */
export function createFileStagedStateStore(directory: string): StagedStateStore {
  const root = resolve(directory);
  const file = join(root, STATE_FILE);
  let sequence = 0;

  return {
    async read(): Promise<StagedStateFile | null> {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
      return parseStagedStateFile(bytes);
    },

    async write(state: StagedStateFile): Promise<void> {
      await mkdir(root, { recursive: true, mode: 0o700 });
      sequence += 1;
      const temporary = `${file}.${process.pid}.${sequence}.tmp`;
      try {
        await writeFile(temporary, serializeStagedStateFile(state), { mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
```

- [ ] **Step 6: Export and run**

Add to `src/index.ts`:

```ts
export {
  MAX_INFRASTRUCTURE_ATTEMPTS,
  STAGED_DISPOSITIONS,
  STAGED_STAGES,
  STAGED_STATE_SCHEMA_VERSION,
  advanceStagedJob,
  createStagedStateFile,
  dueStagedJobs,
  parseStagedStateFile,
  recordStagedAttested,
  recordStagedFailure,
  serializeStagedStateFile,
  upsertStagedJobs,
  type StagedDisposition,
  type StagedJob,
  type StagedStage,
  type StagedStateFile,
  type StagedStateStore,
} from "./staged-state.js";
export { createFileStagedStateStore } from "./staged-state-store.js";
```

Run:
```bash
corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: 55 tests pass; typecheck exits 0; the boundary guard passes with the single
filesystem carve-out from T1 and fails if `node:fs` appears anywhere else.

- [ ] **Step 7: Commit**

```bash
git add packages/environments/verification/src
git commit -m "feat(environments): resumable staged-state module with crash-safe atomic writes"
```

---

### Task 12: The conformance kit — fake runtime, scripted scenarios, exact attestations

Design §6, last paragraph: *the kit runs the capability against a fake container runtime
with scripted outcomes (stable / flaky / vanishing-image) and asserts the exact attestation
each produces.* "Exact" here means byte-equal to a committed golden statement, not a
spot-check of fields.

**Files:**
- Create: `src/testing.ts`, `src/testing.test.ts`, `src/bounded-claims.test.ts`,
  `fixtures/attestations-v1/{stable,unstable-divergence,error-acquire}.json`,
  `fixtures/predicate-v1/{stable,invalid-prefixed-digest-set,invalid-controls-omitted,invalid-stable-divergent-per-run,invalid-k-below-minimum}.json`,
  `fixtures/attestations-v1/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `DsseSigner`, `parseDsseEnvelope` from `@jinn-network/trust-core`;
  `createEoaTestSigner` from `@jinn-network/trust-testing` (devDependency, used only by
  `src/testing.test.ts`); every T2–T11 export.
- Produces: `createScriptedContainerRuntime`, `createInMemoryArtifactStore`,
  `createFixedClock`, `CONFORMANCE_VERIFIER_IDENTITY`, `loadGoldenStatement`,
  `describeEnvironmentVerificationConformance(options)`.

- [ ] **Step 1: Write the failing kit-driver test**

`src/testing.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { dssePreAuthEncoding, type DsseSigner } from "@jinn-network/trust-core";

import { describeEnvironmentVerificationConformance } from "./testing.js";

// Real, deterministic secp256k1/EIP-191 signatures over the DSSE
// pre-authentication encoding -- design §5.5 ("the kit exercises DSSE
// verification against trust/core test keys").
const eoa = createEoaTestSigner("environment-verification-conformance");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(
    request.preAuthEncoding
      ?? dssePreAuthEncoding(request.payloadType, request.payloadBytes),
  ),
}];

describeEnvironmentVerificationConformance({ signer });
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/testing.test.ts`
Expected: FAIL — `Failed to resolve import "./testing.js"`.

- [ ] **Step 3: Implement the kit**

`src/testing.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture
// loading only) and is allowlisted for this file in the tree guard.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseDsseEnvelope, recordDigest, type DsseSigner, type Sha256Digest } from "@jinn-network/trust-core";

import { buildConformanceRecord } from "./import-source.js";
import { canonicalOutcomeSetBytes, outcomeSetDigest, type OutcomeSet } from "./outcome-set.js";
import type { ArtifactStore, Clock, ContainerRuntime } from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { parseEnvironmentVerificationStatement } from "./statement.js";
import { verifyEnvironment, type VerifyEnvironmentOptions } from "./verify.js";

export const CONFORMANCE_OUTCOMES: OutcomeSet = Object.freeze({
  "tests/test_alpha.py::test_one": "pass",
  "tests/test_alpha.py::test_two": "fail",
  "tests/test_beta.py::test_three": "skip",
}) as OutcomeSet;

/** Run 3's outcomes in the flaky scenario: test_two flips to pass. */
export const CONFORMANCE_DIVERGENT_OUTCOMES: OutcomeSet = Object.freeze({
  "tests/test_alpha.py::test_one": "pass",
  "tests/test_alpha.py::test_two": "pass",
  "tests/test_beta.py::test_three": "skip",
}) as OutcomeSet;

export const CONFORMANCE_VERIFIER_IDENTITY: VerifierIdentity = Object.freeze({
  id: "https://jinn.network/environment-verification/conformance-verifier",
  version: "0.1.0",
  digest: `sha256:${"7".repeat(64)}`,
}) as VerifierIdentity;

export type ScriptedScenario =
  | { readonly kind: "stable" }
  | { readonly kind: "flaky-on-run-3" }
  | { readonly kind: "vanishing-image" };

export interface ScriptedContainerRuntime extends ContainerRuntime {
  /** Container ids handed out, in run order. Distinct ids prove each run got a
   * fresh container. */
  readonly containerIds: readonly string[];
  readonly pullCount: number;
}

/**
 * A fake container runtime with scripted outcomes. It touches nothing: no
 * registry, no daemon, no disk.
 */
export function createScriptedContainerRuntime(
  scenario: ScriptedScenario,
): ScriptedContainerRuntime {
  const containerIds: string[] = [];
  let pullCount = 0;
  let runIndex = 0;

  return {
    get containerIds() {
      return containerIds;
    },
    get pullCount() {
      return pullCount;
    },
    async pullByDigest(request) {
      pullCount += 1;
      if (scenario.kind === "vanishing-image") {
        throw new Error("manifest unknown: manifest tagged by digest not found");
      }
      return { resolvedManifestDigest: request.manifestDigest };
    },
    async runContainer() {
      const containerId = `conformance-container-${runIndex}`;
      containerIds.push(containerId);
      const diverges = scenario.kind === "flaky-on-run-3" && runIndex === 2;
      const wallSeconds = 100 + runIndex;
      runIndex += 1;
      return {
        containerId,
        installExitCodes: [],
        testExitCodes: [1],
        outcomes: diverges ? CONFORMANCE_DIVERGENT_OUTCOMES : CONFORMANCE_OUTCOMES,
        wallSeconds,
        timedOut: false,
      };
    },
  };
}

export interface InMemoryArtifactStore extends ArtifactStore {
  readonly artifacts: ReadonlyMap<Sha256Digest, Uint8Array>;
}

export function createInMemoryArtifactStore(): InMemoryArtifactStore {
  const artifacts = new Map<Sha256Digest, Uint8Array>();
  return {
    artifacts,
    async putArtifact(bytes) {
      const digest = recordDigest(bytes);
      artifacts.set(digest, bytes);
      return { digest, size: bytes.length };
    },
  };
}

/** A clock that yields the window's start, then its end, then repeats the end. */
export function createFixedClock(
  startedAt = "2026-07-31T09:00:00.000Z",
  endedAt = "2026-07-31T09:25:00.000Z",
): Clock {
  const instants = [new Date(startedAt), new Date(endedAt)];
  let index = 0;
  return { now: () => instants[Math.min(index++, instants.length - 1)]! };
}

const FIXTURE_ROOT = new URL("../fixtures/", import.meta.url);

export type GoldenStatementName = "stable" | "unstable-divergence" | "error-acquire";

export async function loadGoldenStatement(name: GoldenStatementName): Promise<unknown> {
  const path = fileURLToPath(new URL(`attestations-v1/${name}.json`, FIXTURE_ROOT));
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface EnvironmentVerificationConformanceOptions {
  /** The host's signer. The kit holds no key material of its own. */
  readonly signer: DsseSigner;
  readonly verifyOptions?: VerifyEnvironmentOptions;
}

/**
 * Runs the capability against the fake runtime for each scripted scenario and
 * asserts the exact statement it produces, byte-for-byte, against the committed
 * golden. Requires `vitest` (declared as an optional peer).
 */
export function describeEnvironmentVerificationConformance(
  options: EnvironmentVerificationConformanceOptions,
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- kit-only dynamic peer
  const { describe, expect, it } = globalThis as unknown as typeof import("vitest");

  describe("environment verification conformance", () => {
    const record = buildConformanceRecord();

    async function run(scenario: ScriptedScenario) {
      const containerRuntime = createScriptedContainerRuntime(scenario);
      const artifactStore = createInMemoryArtifactStore();
      const attestation = await verifyEnvironment(
        {
          containerRuntime,
          artifactStore,
          signer: options.signer,
          clock: createFixedClock(),
          verifier: CONFORMANCE_VERIFIER_IDENTITY,
        },
        record,
        options.verifyOptions,
      );
      return { attestation, containerRuntime, artifactStore };
    }

    it("stable: five agreeing runs in five fresh containers", async () => {
      const { attestation, containerRuntime, artifactStore } = await run({ kind: "stable" });
      expect(attestation.statement).toEqual(await loadGoldenStatement("stable"));
      expect(new Set(containerRuntime.containerIds).size).toBe(5);
      expect(containerRuntime.pullCount).toBe(1);
      expect(artifactStore.artifacts.get(outcomeSetDigest(CONFORMANCE_OUTCOMES)))
        .toEqual(canonicalOutcomeSetBytes(CONFORMANCE_OUTCOMES));
    });

    it("flaky-on-run-3: an unstable attestation naming the divergent run", async () => {
      const { attestation, artifactStore } = await run({ kind: "flaky-on-run-3" });
      expect(attestation.statement).toEqual(await loadGoldenStatement("unstable-divergence"));
      // Both outcome sets are retrievable, so a third party can re-compare.
      expect(artifactStore.artifacts.has(outcomeSetDigest(CONFORMANCE_OUTCOMES))).toBe(true);
      expect(artifactStore.artifacts.has(outcomeSetDigest(CONFORMANCE_DIVERGENT_OUTCOMES)))
        .toBe(true);
    });

    it("vanishing-image: an error attestation with no runs and no baseline", async () => {
      const { attestation, containerRuntime } = await run({ kind: "vanishing-image" });
      expect(attestation.statement).toEqual(await loadGoldenStatement("error-acquire"));
      expect(containerRuntime.containerIds).toEqual([]);
    });

    it("signs every result: negative attestations are first-class", async () => {
      for (const scenario of [
        { kind: "stable" } as const,
        { kind: "flaky-on-run-3" } as const,
        { kind: "vanishing-image" } as const,
      ]) {
        const { attestation } = await run(scenario);
        const envelope = parseDsseEnvelope(attestation.envelopeBytes);
        expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
        expect(envelope.signatures.length).toBeGreaterThan(0);
        expect(parseEnvironmentVerificationStatement(
          JSON.parse(new TextDecoder().decode(envelope.payloadBytes)),
        )).toEqual(attestation.statement);
        expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
      }
    });

    it("is stable across repeated runs of the same scenario", async () => {
      const first = await run({ kind: "stable" });
      const second = await run({ kind: "stable" });
      expect(second.attestation.statement).toEqual(first.attestation.statement);
      expect(second.attestation.envelopeBytes).toEqual(first.attestation.envelopeBytes);
    });
  });
}
```

If the dynamic `globalThis` access to vitest's globals does not resolve under this repo's
vitest config (globals are off by default), replace the destructuring line with a top-level
`import { describe, expect, it } from "vitest";` and keep vitest as the declared optional
peer — the same shape `@jinn-network/trust-testing`'s `conformance.ts` uses. Check that file
first and match it exactly.

- [ ] **Step 4: Generate and pin the three golden statements**

The golden statements' subject digests depend on C1's sealed record bytes, so they are
generated once against the base branch and then frozen. Run:

```bash
cd packages/environments/verification
cat > /tmp/generate-goldens.mjs <<'EOF'
import { mkdir, writeFile } from "node:fs/promises";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { dssePreAuthEncoding } from "@jinn-network/trust-core";
import { buildConformanceRecord } from "./dist/import-source.js";
import {
  CONFORMANCE_VERIFIER_IDENTITY,
  createFixedClock,
  createInMemoryArtifactStore,
  createScriptedContainerRuntime,
} from "./dist/testing.js";
import { verifyEnvironment } from "./dist/verify.js";

const eoa = createEoaTestSigner("environment-verification-conformance");
const signer = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding
    ?? dssePreAuthEncoding(request.payloadType, request.payloadBytes)),
}];

await mkdir("fixtures/attestations-v1", { recursive: true });
for (const [name, scenario] of [
  ["stable", { kind: "stable" }],
  ["unstable-divergence", { kind: "flaky-on-run-3" }],
  ["error-acquire", { kind: "vanishing-image" }],
]) {
  const { statement } = await verifyEnvironment(
    {
      containerRuntime: createScriptedContainerRuntime(scenario),
      artifactStore: createInMemoryArtifactStore(),
      signer,
      clock: createFixedClock(),
      verifier: CONFORMANCE_VERIFIER_IDENTITY,
    },
    buildConformanceRecord(),
  );
  await writeFile(
    `fixtures/attestations-v1/${name}.json`,
    `${JSON.stringify(statement, null, 2)}\n`,
    "utf8",
  );
}
EOF
corepack yarn@4.13.0 build && node /tmp/generate-goldens.mjs
```

Then **read all three files** and check them against design §5.2 by eye before committing:

- `stable.json` — `result: "stable"`; `runs.count` 5; five identical `perRun.outcomeSetDigest`
  values; `runtime.minSeconds` 100 and `maxSeconds` 104; no `failure`; two subjects whose
  `digest.sha256` values are **bare hex**; `baseline` counts `{passing: 1, failing: 1, skipped: 1}`.
- `unstable-divergence.json` — `result: "unstable"`; `failure.stage: "compare"`;
  `failure.reason: "outcome-set-divergence"`; `divergence.divergentRuns` exactly `[{index: 2, …}]`;
  `baseline` still present (run 0's observation).
- `error-acquire.json` — `result: "error"`; no `runs`, no `baseline`;
  `runtime` carrying only `timeoutSeconds`; `failure` `{stage: "acquire", reason: "image-unresolvable", detail: …}`.

Add `fixtures/attestations-v1/README.md`:

```markdown
# Golden verification attestations

Generated by the kit against the fake container runtime and frozen. Regenerating them is
allowed only when the design changes; a diff here is a claim change, and reviewers read it
as one. The DSSE envelope is deliberately not pinned: envelope bytes depend on the signer,
and the kit is parameterized on the host's signer.
```

Finally, copy `stable.json`'s `predicate` into `fixtures/predicate-v1/stable.json`, and
hand-author the four adversarial predicate fixtures beside it by mutating that golden:

- `invalid-prefixed-digest-set.json` — `baseline.outcomes.digest.sha256` carries a
  `sha256:` prefix (the contract-6 confusion fixture).
- `invalid-controls-omitted.json` — the `controls` block deleted.
- `invalid-stable-divergent-per-run.json` — `result: "stable"` with `perRun[2]` carrying a
  different `outcomeSetDigest`.
- `invalid-k-below-minimum.json` — `runs.count` 4 with four `perRun` entries.

- [ ] **Step 5: Add the fixture-corpus test and the bounded-claims guard**

Append to `src/testing.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EnvironmentVerificationPredicateSchema } from "./predicate.js";

describe("predicate fixture corpus", () => {
  const root = fileURLToPath(new URL("../fixtures/predicate-v1/", import.meta.url));

  it("accepts the golden predicate", async () => {
    const golden = JSON.parse(await readFile(`${root}stable.json`, "utf8")) as unknown;
    expect(EnvironmentVerificationPredicateSchema.safeParse(golden).success).toBe(true);
  });

  it("rejects every adversarial predicate", async () => {
    const names = (await readdir(root)).filter((name) => name.startsWith("invalid-"));
    expect(names.length).toBe(4);
    for (const name of names) {
      const fixture = JSON.parse(await readFile(`${root}${name}`, "utf8")) as unknown;
      expect(
        EnvironmentVerificationPredicateSchema.safeParse(fixture).success,
        `${name} must be rejected`,
      ).toBe(false);
    }
  });
});
```

`src/bounded-claims.test.ts` (contract 8, enforced rather than promised):

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Words the design forbids this layer from using about its own output. The
// claim is "K consecutive identical outcome-sets under the declared controls";
// anything stronger is over-claiming (design §5.2, program contract 8).
const FORBIDDEN = [
  /\bdeterministic(?:ally)?\b/iu,
  /\bnon-?deterministic\b/iu,
  /\bguarantee[sd]?\b/iu,
  /\bproven\b/iu,
  /\breliable environment\b/iu,
];

describe("bounded claims", () => {
  it("no source file over-claims", async () => {
    const names = (await readdir(SOURCE_ROOT)).filter((name) => name.endsWith(".ts"));
    for (const name of names) {
      const text = await readFile(`${SOURCE_ROOT}${name}`, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("the README states the bound explicitly", async () => {
    const readme = await readFile(`${PACKAGE_ROOT}README.md`, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(readme), `README matches ${String(pattern)}`).toBe(false);
    }
    expect(readme).toContain("K consecutive runs");
    expect(readme).toContain("declared controls");
  });
});
```

- [ ] **Step 6: Run the full gate**

Run, showing every output:
```bash
cd packages/environments/verification
corepack yarn@4.13.0 typecheck
corepack yarn@4.13.0 test
corepack yarn@4.13.0 build
corepack yarn@4.13.0 pack:smoke
cd ../../.. && node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs
```
Expected: typecheck 0 errors; all tests pass (the kit's 5 conformance tests, the fixture
corpus, the bounded-claims guard, and every earlier suite); `build` emits `dist/`;
`pack:smoke` prints its success line; all three guards pass.

- [ ] **Step 7: Commit**

```bash
git add packages/environments/verification
git commit -m "feat(environments): conformance kit with scripted runtime and golden attestations"
```

---

## Verification before completion (branch gate)

Before this branch is reported complete, run and show the output of all of:

```bash
cd packages/environments/verification
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test && corepack yarn@4.13.0 pack:smoke
cd ../../..
node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs \
  .github/scripts/custody-boundaries.test.mjs
grep -rn "process\.env\|node:child_process\|localeCompare\|Intl\." packages/environments/verification/src \
  && echo "BOUNDARY VIOLATION" || echo "clean"
grep -rln "@jinn-network/core\|@jinn-network/plugin\|jinn-layer\|client/src" packages/environments/verification/src \
  && echo "FROZEN-TRIO IMPORT" || echo "clean"
```

Then request one independent high-effort review against the design (§5, §6) per program §6,
before C4 or any dependent builds on this branch.

---

## Findings (2026-07-31)

Design defects and program/spec tensions discovered while planning. Contract 1: these are
proposals with dispositions, not applied patches. Each is restated in-package as a comment
at the site it affects.

**F-C2-1 — `verifyEnvironment`'s dependency set needs the verifier identity.**
Program §4 pins `verifyEnvironment(deps, record)` with `deps` injecting
`{containerRuntime, artifactStore, signer, clock}`. Design §5.2 requires the predicate to
carry `verifier: {id, version, digest}` — the identity of the toolchain that ran the
protocol. A library cannot truthfully digest its own build at runtime; manufacturing a
value there would be exactly the over-claiming this design exists to prevent (contract 8).
*Disposition proposed:* `verifier` is injected as a fifth member of `deps` — host-declared
data, injected like the clock. The pinned **name and 2-argument call shape are unchanged**;
program §4's C2 bullet should read
`deps` injects `{containerRuntime, artifactStore, signer, clock, verifier}`. Configuration
that *can* default honestly (K, controls, timeout) rides in an optional third `options`
argument, so `verifyEnvironment(deps, record)` remains a correct call.

**F-C2-2 — §5.3's install step cannot survive fresh-container-per-run.**
Step 2 runs `invocations.install` once; step 3 runs the test scope K times, "each run in a
fresh container from the same image". A fresh container discards the previous container's
install effects, so an install performed at step 2 is not present for any run. *Disposition
proposed:* install commands execute **inside each run's own fresh container, before the test
invocations**; a non-zero install exit is `error/install`. Spec §5.3 steps 2–3 to be reworded
accordingly. This costs K installs, which at tier 0 is nearly always zero work (imported
images are pre-installed) and is the only reading under which the attestation's claim is
true of every run it counts.

**F-C2-3 — §6 names two ports program §4 does not pin.**
Design §6 lists a git port ("clone at commit, when workspace materialization needs it") and
describes the artifact store as "`putArtifact` + announcement sink". Program §4 pins four.
*Disposition proposed:* keep four (plus F-C2-1's `verifier`), because v1 is import-only at
reproducibility tier 0 — the workspace is inside the pinned image, so no clone happens, and
§5.2 states outright that the source binding is unverified at tier 0. Announcement is the
host's composition step over the returned `SealedAttestation`, not a capability port; the
capability returns sealed bytes and stays announcement-agnostic. Revisit both when the
source-correspondence extension (§14) lands.

**F-C2-4 — observed runtime bounds under `result: "error"` (interpretation, no spec change).**
§5.2's example shows `runtime: {minSeconds, maxSeconds, timeoutSeconds}` on a `stable`
attestation, and states the presence rule only for `runs`/`baseline`. An `error` at acquire
has zero observations, so reporting observed bounds would be fabrication. *Disposition:*
`minSeconds`/`maxSeconds` are present iff `result != "error"`, following §5.2's own presence
logic; `timeoutSeconds` (a declared ceiling, not an observation) is always present. Recorded
as an interpretation; no spec amendment proposed.

**F-C2-5 — the tree guard needs one filesystem carve-out.**
Design §6 requires a "staged, crash-safe, atomic-write" pipeline state library. Atomic write
means `node:fs/promises`, which C1's source-boundary guard for `packages/environments/` will
(by house convention) forbid outside `./testing`. *Disposition proposed:* C2 lands the
amendment itself in T1 — a two-entry allowlist naming
`verification/src/staged-state-store.ts` and `verification/src/testing.ts`, with every other
file in the tree still failing on a filesystem import. No C1 change is required; the
coordination note exists so C1's reviewer is not surprised by a guard edit arriving from C2.

**F-C2-6 — the subject digest is recomputed, not carried.**
`verifyEnvironment` takes a *parsed* `EnvironmentRecord`, but the attestation subject must
name the digest of the record's **sealed bytes**. The implementation re-seals via C1's
`sealEnvironmentRecord` and digests that. This is sound only because sealing is
JCS-once-deterministic and C1's parser rejects non-exact bytes (its "re-canonicalized bytes
presented as the same record" adversarial fixture, §4.5). *Disposition:* no change proposed;
recorded because it makes C2's correctness depend on a C1 property that is stated in the
design but must be confirmed in C1's implementation. If C1's parser turns out to be
tolerant of non-canonical input, this becomes a blocker and `verifyEnvironment` must take
record **bytes** instead — a stop-and-report.

**F-C2-7 — `attestation-issuer` is a pattern source, not a dependency (no defect).**
Design §5.1 says the attestation reuses "the `attestation-issuer` statement-building pattern
unchanged". That package's public surface exports no statement builder
(`src/statement.ts`'s `buildResultEvaluationStatement` / `buildExecutionVerificationStatement`
are internal), and §3.3 gives verification exactly two package edges. *Disposition:* the
pattern is copied with attribution in the source comment; no dependency is added. Recorded
so a reviewer reading §5.1 does not flag the missing import as an omission.

---

## Self-review

**Design §5 coverage.** §5.1 envelope/identity — DSSE via `trust/core`, predicate type
constant, dual subjects in fixed order with bare-hex DigestSets (T6), normative subject-match
rule as `attestationMatchesRecord` with its any-match adversarial test. §5.2 predicate — every
field in the design's block is in the schema, with the presence rule, the
`stable`-implies-agreeing-per-run rule, the divergence requirement, set-equality-not-timing,
expected-fail baselines, the `window` timestamps, and plurality (nothing in the package picks
winners). §5.3 protocol steps 1–6 — T8's `observe`/`buildRunsPredicate`, with K ≥ 5 enforced
before any port is touched. §5.4 registry interop — correctly absent (non-goal for v1
automation; §14 parks it). §5.5 fixtures — golden stable/unstable/error plus adversarial
subject-digest-prefixed, controls-omitted, stable-with-divergent-per-run, K-below-minimum,
altered-baseline-counts (via `verifyBaselineCounts`), and the kit signs with trust/core test
keys.

**Design §6 coverage.** Ports injected with no ambient authority (T7); import source with
full-identity grouping and divergence-splits (T10); staged state machine with the four-way
taxonomy mapped as `quarantined → unstable` and `failed_infrastructure → retry-then-error`
(T4, T11); negative attestations published as first-class (T9); the fake-runtime kit with
stable / flaky-on-run-3 / vanishing-image asserting exact attestations (T12). Own
construction is absent, per §12.

**Pinned-name check against program §4 "C2 produces".** `ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`
= `https://jinn.network/attestations/environment-verification/v1` (T2); `verifyEnvironment(deps,
record): Promise<SealedAttestation>` with `deps` injecting `{containerRuntime, artifactStore,
signer, clock}` (T8 — plus `verifier`, F-C2-1); `buildEnvironmentCandidatesFromRows(rows):
EnvironmentRecord[]` (T10); the attestation Zod schema with the presence rule (T5); the
subject builder emitting bare-hex DigestSet values (T6). All five present, spelled exactly.

**Placeholder scan.** No `TODO`, `FIXME`, `...`, `<name>`, or "implement this" appears in any
code block. The three golden attestation fixtures are the only generated artifacts, and T12
step 4 gives the exact generator, the exact command, and the exact by-eye checks before they
are committed.

**Contracts that bite this component.** Bounded claims — enforced by a test, not a promise
(T12 step 5); result vocabulary is `stable`/`unstable`/`error` and the compared object is an
*outcome-set*. Custody — five injected members, one argument-scoped filesystem file, no
`process.env`, no network identifier anywhere in `src/`. Digest discipline — two schemas that
reject each other's form plus the confusion fixture in both the unit tests and the fixture
corpus. Legacy — read for the state machine and the repeated-run derivation, imported never;
the three deliberate divergences are stated at the head of T11. Kit precedes dependents — the
predicate corpus lands before the driver, and the assembled kit is the branch gate.
