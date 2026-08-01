# C1 — Environment Record Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship `@jinn-network/environment-record` — the sealed, tier-2 environment description record kind, its conformance kit and fixtures, the `packages/environments/` tree scaffolding (guard trio + CI), and the discovery facts leaf `@jinn-network/record-discovery-facts-environments` — so that "this execution environment" becomes a portable, digest-identified, third-party-checkable document.

**Architecture:** one record = one environment = one `(source, image, platform, invocations, parser)` binding, sealed as an I-JSON document under RFC 8785 JCS once, with the sha256 of those exact bytes as its identity. The package is pure: zod + `@noble/hashes` only, no filesystem or network outside the fixture loaders in the testing region, and sealing is re-implemented locally with cross-package equivalence proven by test-only fixtures against the evidence tree's digest and an independent RFC 8785 reference implementation. The record is sealed but **unsigned** — attribution arrives through DSSE-signed discovery announcements (the facts leaf) and through C2's verification attestations, never at the record layer.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained per-package project, `portal:` resolution for cross-tree devDependencies); zod 4.4.3; `@noble/hashes` ^2.2.0; vitest ^4.1.8; ajv 8.17.1 + canonicalize ^2.0.0 (dev only).

---

## Global constraints

Copied verbatim from the program plan (`2026-07-31-supply-program.md` §5) where they bind this component; the values are law, not defaults.

1. **Designs are law** — spec `5b0739832` (`docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md`). Discovering a design defect at planning or implementation time is a **finding with a proposed disposition — never a silent patch**. This plan's findings are in the closing section.
2. **Kits and fixtures precede implementations**; a layer's kit is green before dependents build. C2 and C3 do not start until this package's kit and the tree guards are green.
3. **Sealing is re-implemented per package (C1)** with cross-package equivalence fixtures against the evidence tree — **never shared runtime sealing code**. No production file in this package may import a Jinn package. The equivalence leg lives in `*.test.ts` files only.
4. **Custody law** — no key material, no ambient authority (incl. no ambient `fetch`), signer objects and ports injected, fail closed. This package holds no ports at all: it is pure. `node:fs/promises` is permitted **only** in `src/fixtures.ts` (the testing region); the facts leaf's `node:fs` use is limited to loading its own bundled profile JSON at module init, matching the `facts/benchmarking` precedent.
5. **No product names in tiers 1–3**; no unit imports `@jinn-network/core`, `plugin`, `jinn-layer`, or `client/`.
6. **Digest discipline:** record-body digests `sha256:`-prefixed; in-toto DigestSet subjects bare hex; **the kit of every producing package includes the confusion fixture**.
7. *(C3's rule — not binding here.)*
8. **Bounded claims:** no API, log line, or doc in any package may say "deterministic" or "verified" without the K/controls or trust-policy qualification the spec gives those words. This package's README, JSDoc, and JSON Schema `$comment` text are subject to this rule; a grep gate enforces it in Task 13.
9. **Guards ship with the packages** (guard trio + CI per tree). **C1 owns `packages/environments/`.** The guard trio and the CI workflow land in this PR, not later.
10. **TDD per task; verification before completion** — typecheck, tests, kit, guards run locally with output shown before any task is reported done.
11. **Stop on missing Consumes** — a symbol a task consumes that isn't on the base branch is a stop-and-report.
12. **Legacy code is reference only** — read `client/src` freely, import never.

Additional constraints specific to this component:

- Branch: `supply/c1-environment-record`, based on `integration/evidence-v1`. It is the base of `supply/c2-environment-verification` and `supply/c3-task-admission`.
- **Pinned interface (program §4, C1 produces).** These exact names and signatures are the cross-component contract:
  - `EnvironmentRecord` (parsed type)
  - `sealEnvironmentRecord(record): Uint8Array`
  - `parseEnvironmentRecord(bytes)`
  - `environmentRecordDigest(bytes): string` (`sha256:`-prefixed)
  - `ENVIRONMENT_RECORD_KIND`
  - `ENVIRONMENT_RECORD_MEDIA_TYPE`
  - `CommandSpecSchema` (shell-free `{bin, args, cwd?, env?}`)
  - fixtures + `./testing` kit
  - the discovery facts-leaf package's `environmentFactsProfile`
- Node `>=22`; package `"type": "module"`; every relative import carries the `.js` extension.
- **No `localeCompare`, no `Intl`** anywhere in production source under `packages/environments/` — the tree's own source-boundary canary (Task 11) fails the build. Use `compareCodeUnitStrings`.
- The root entrypoint (`src/index.ts`) must never re-export `testing.ts` or `fixtures.ts`.

## Package and file layout

All paths under `packages/environments/record/` unless stated otherwise.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md` | package scaffold |
| `src/order.ts` | `compareCodeUnitStrings` — the locale-free ordering primitive |
| `src/json.ts` | I-JSON assertions, `JsonValue`, the I-JSON error classes |
| `src/canonical.ts` | RFC 8785 JCS serializer over the I-JSON subset |
| `src/hashing.ts` | `sha256Hex`, `environmentRecordDigest`, `bareHexDigest` |
| `src/sealing.ts` | `InvalidDocumentError`, `sealWithSchema`, `parseExactWithSchema` |
| `src/identifiers.ts` | `ENVIRONMENT_RECORD_KIND`, `ENVIRONMENT_RECORD_MEDIA_TYPE`, schema `$id` |
| `src/extensions.ts` | `topLevelRecordSchema` — namespaced-extension-key discipline |
| `src/command.ts` | `CommandSpecSchema` — the shell-free command shape |
| `src/schema.ts` | `EnvironmentRecordSchema` + cross-field invariants; `parseEnvironmentRecord`, `sealEnvironmentRecord` |
| `src/fixtures.ts` | fixture loaders (the only `node:fs/promises` user) |
| `src/index.ts` | public surface |
| `src/testing.ts` | `describeEnvironmentRecordConformance` (the kit) |
| `fixtures/environment/*` | golden `imported`/`tier-1`/`extension` + `.sha256` pins; `invalid-*.json` |
| `fixtures/equivalence/*` | key-permuted twins + expected digest |
| `fixtures/adversarial-v1/*` | adversarial corpus + `manifest.json` |
| `schemas/environment.schema.json` | published JSON Schema (generated) |
| `scripts/build.mjs`, `generate-fixtures.mjs`, `generate-schemas.mjs`, `pack-smoke.mjs` | build, fixture/schema generation + drift check, tarball smoke |

Sibling package: `packages/discovery/facts/environments/` (Task 13).

Repo files this plan creates or edits:

- Create: `.github/scripts/environments-package-inventory.test.mjs`, `.github/scripts/environments-source-boundaries.test.mjs`, `.github/scripts/environments-packed-types.test.mjs`, `.github/workflows/environments-ci.yml`
- Modify: `.gitignore`, `.github/scripts/record-discovery-package-inventory.test.mjs`, `.github/scripts/record-discovery-source-boundaries.test.mjs`, `.github/scripts/record-discovery-packed-types.test.mjs`, `.github/workflows/record-discovery-ci.yml`

---

### Task 1: Branch, tree scaffolding, and the package-inventory guard

**Files:**
- Create: `.github/scripts/environments-package-inventory.test.mjs`
- Create: `packages/environments/record/package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md`, `scripts/build.mjs`, `src/index.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task). The only cross-tree symbol this package will ever touch is `recordDigest` from `@jinn-network/evidence-protocol` on `integration/evidence-v1` (Task 3, test-only) — verify it exists before Task 3 begins.
- Produces: the tree `packages/environments/`, the package directory `packages/environments/record` publishing `@jinn-network/environment-record` with exports `.`, `./testing`, `./schemas/*`, `./fixtures/*`.

- [ ] **Step 1: Create the branch**

```bash
git fetch origin
git checkout -b supply/c1-environment-record origin/integration/evidence-v1
git log --oneline -1
```

Expected: HEAD is `origin/integration/evidence-v1`'s tip. Confirm `packages/environments` does **not** exist (`ls packages/` shows no `environments`) — if it does, stop and report.

- [ ] **Step 2: Write the inventory guard so it fails**

`.github/scripts/environments-package-inventory.test.mjs`:

```js
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'environments');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const ENVIRONMENT_PACKAGES = [
  ['record', '@jinn-network/environment-record'],
];

// Cross-tree Jinn dependencies live outside packages/environments; map name -> absolute dir
// (benchmarking-package-inventory.test.mjs precedent).
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
]);

const JINN_DEPENDENCY_GRAPH = new Map([
  // `record` is tier 2 and depends on NO Jinn package at runtime (design §3.3: zod +
  // noble-class primitives only). evidence-protocol is a *test-only* devDependency: the
  // cross-package seal-equivalence fixtures (program §5 contract 3) compare this package's
  // locally re-implemented digest against the evidence tree's `recordDigest`. Production
  // source never imports it; the source-boundary guard enforces that separately.
  ['record', {
    dependencies: [],
    devDependencies: ['@jinn-network/evidence-protocol'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function packageManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return [];
    const child = join(directory, entry.name);
    const packageJson = join(child, 'package.json');
    return [
      ...(existsSync(packageJson) ? [packageJson] : []),
      ...packageManifests(child),
    ];
  });
}

function jinnDependencyNames(manifest, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith('@jinn-network/')).sort();
}

function expectedPortal(directory, dependencyName) {
  const inTree = ENVIRONMENT_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the environments package inventory is explicit and has one manifest per package', () => {
  assert.equal(ENVIRONMENT_PACKAGES.length, JINN_DEPENDENCY_GRAPH.size);
  for (const [directory, expectedName] of ENVIRONMENT_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/environments/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages', 'environments'))
    .map((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return [relative(packageRoot, dirname(packageJson)), name];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(
    actual,
    [...ENVIRONMENT_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
});

test('environments package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of ENVIRONMENT_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS.flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions).filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, declared, `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of declared) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});

test('every environments package declares Vitest as an exact optional peer where it ships a kit', () => {
  const manifest = readPackage('record');
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.', './fixtures/*', './schemas/*', './testing',
  ]);
  assert.equal(manifest.peerDependencies?.vitest, '^4.1.8');
  assert.deepEqual(manifest.peerDependenciesMeta, { vitest: { optional: true } });
});
```

- [ ] **Step 3: Run the guard to verify it fails**

Run: `node --test .github/scripts/environments-package-inventory.test.mjs`
Expected: FAIL — `ENOENT`/`missing package manifest: …/packages/environments/record/package.json`.

- [ ] **Step 4: Create the package scaffold**

`packages/environments/record/package.json`:

```json
{
  "name": "@jinn-network/environment-record",
  "version": "0.1.0",
  "description": "The sealed environment description record kind: one record = one (source, image, platform, invocations, parser) binding.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/environments/record"
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
    "./schemas/*": "./schemas/*",
    "./fixtures/*": "./fixtures/*"
  },
  "files": [
    "dist/",
    "schemas/",
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
    "generate:fixtures": "yarn build && node scripts/generate-fixtures.mjs --write",
    "check:fixtures": "yarn build && node scripts/generate-fixtures.mjs --check",
    "generate:schemas": "yarn build && node scripts/generate-schemas.mjs --write",
    "check:schemas": "yarn build && node scripts/generate-schemas.mjs --check",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@noble/hashes": "^2.2.0",
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
    "@jinn-network/evidence-protocol": "0.1.0",
    "@types/node": "^22.0.0",
    "ajv": "8.17.1",
    "canonicalize": "^2.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-protocol": "portal:../../evidence/protocol"
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

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

`scripts/build.mjs`:

```js
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

await rm(dist, { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`TypeScript build exited with ${code}`));
  });
});
```

`src/index.ts` (placeholder, replaced in Task 8):

```ts
export {};
```

`README.md`:

```markdown
# @jinn-network/environment-record

The sealed environment description record kind.

One record describes exactly one environment: one `(source, image, platform, invocations,
parser)` binding. The document is I-JSON, canonicalized once under RFC 8785 JCS, and the
sha256 of those exact bytes is the record's identity, written `sha256:<64 lowercase hex>`.
Sealed once, forever — there is no expiry field and no status field, and nothing in this
package ever rewrites a sealed record.

The record is sealed but **unsigned**. It carries no claim about whether the environment
works: that claim belongs to separately published verification attestations, which bind to
this record by digest, and which state bounded observations ("K consecutive runs of the
declared test scope produced identical outcome-sets under the declared controls") rather
than grades. A producer MAY additionally wrap the record in a DSSE envelope; consumers MUST
NOT require it.

`invocations.test` is the declared scope: two records over the same image with different
test scopes are different environments by identity, which is the point.

Digest discipline: every digest in the record body carries the `sha256:` prefix. In-toto
DigestSet subject values, by contrast, are bare hex — `bareHexDigest` converts, and the
conformance kit carries the confusion fixture.

See `../../../docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md` §4.
```

- [ ] **Step 5: Add the tree to `.gitignore`**

In `.gitignore`, immediately after the `packages/benchmarking/*` block (the three lines ending `packages/benchmarking/*/.yarn/install-state.gz`), add:

```
packages/environments/*/dist/
packages/environments/*/.yarn/cache/
packages/environments/*/.yarn/install-state.gz
```

- [ ] **Step 6: Install and re-run the inventory guard**

Run:

```bash
(cd packages/evidence/protocol && yarn install --immutable && yarn build)
(cd packages/environments/record && yarn install)
node --test .github/scripts/environments-package-inventory.test.mjs
```

Expected: all three inventory tests PASS.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .github/scripts/environments-package-inventory.test.mjs packages/environments
git commit -m "feat(environment-record): open the environments tree and scaffold the record package"
```

---

### Task 2: Locale-free ordering, I-JSON assertions, and canonical JSON

**Files:**
- Create: `packages/environments/record/src/order.ts`, `src/json.ts`, `src/canonical.ts`, `src/canonical.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `compareCodeUnitStrings(left: string, right: string): number`; `type JsonValue`; `assertIJsonString(value: string): void`; `assertIJsonStrings(value: unknown): void`; `assertIJsonInteger(value: number): void`; `serializeCanonicalJson(value: JsonValue): Uint8Array`; error classes `IJsonNumberError`, `IJsonStringError`, `UndefinedArrayElementError`.

- [ ] **Step 1: Write the failing test**

`src/canonical.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";

import { compareCodeUnitStrings } from "./order.js";
import { IJsonNumberError, IJsonStringError, UndefinedArrayElementError } from "./json.js";
import { serializeCanonicalJson } from "./canonical.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonical JSON", () => {
  test("orders object keys by UTF-16 code unit, not by locale", () => {
    expect(decode(serializeCanonicalJson({ b: 1, a: 2, "ä": 3, Z: 4 }))).toBe(
      '{"Z":4,"a":2,"b":1,"ä":3}',
    );
  });

  test("key-permuted twins serialize to identical bytes", () => {
    const one = serializeCanonicalJson({ alpha: [1, 2], beta: { x: true, y: null } });
    const two = serializeCanonicalJson({ beta: { y: null, x: true }, alpha: [1, 2] });
    expect(decode(one)).toBe(decode(two));
  });

  test("integer-like keys sort by code unit, not numerically", () => {
    expect(decode(serializeCanonicalJson({ "10": 1, "2": 2 }))).toBe('{"10":1,"2":2}');
  });

  test("agrees byte-for-byte with the RFC 8785 reference implementation", () => {
    const value = {
      kind: "https://jinn.network/records/environment/1.0",
      image: { platform: "linux/amd64", manifestDigest: `sha256:${"a".repeat(64)}` },
      invocations: { test: [{ bin: "pytest", args: ["-q"] }] },
    };
    expect(decode(serializeCanonicalJson(value))).toBe(canonicalize(value));
  });

  test("skips undefined object members but rejects undefined array elements", () => {
    expect(decode(serializeCanonicalJson({ a: 1, b: undefined } as never))).toBe('{"a":1}');
    expect(() => serializeCanonicalJson({ a: [1, undefined] } as never)).toThrow(
      UndefinedArrayElementError,
    );
  });

  test("rejects non-I-JSON numbers", () => {
    expect(() => serializeCanonicalJson({ a: Number.NaN })).toThrow(IJsonNumberError);
    expect(() => serializeCanonicalJson({ a: 1.5 })).toThrow(IJsonNumberError);
    expect(() => serializeCanonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      IJsonNumberError,
    );
  });

  test("rejects lone surrogates in values and in keys", () => {
    expect(() => serializeCanonicalJson({ a: "\ud800" })).toThrow(IJsonStringError);
    expect(() => serializeCanonicalJson({ "\udc00": 1 })).toThrow(IJsonStringError);
  });

  test("compareCodeUnitStrings is a total order without locale sensitivity", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./order.js"`.

- [ ] **Step 3: Write the implementation**

`src/order.ts`:

```ts
/**
 * Deterministic UTF-16 code-unit ordering.
 *
 * `String.prototype.localeCompare` depends on the host locale and the bundled ICU data, so
 * it must never decide the order of anything that reaches canonical bytes. It is banned in
 * production source under `packages/environments/`; see
 * `.github/scripts/environments-source-boundaries.test.mjs`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
```

`src/json.ts`:

```ts
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

export class IJsonStringError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly value: string) {
    super("string contains an unpaired UTF-16 surrogate and is not an I-JSON scalar sequence");
    this.name = "IJsonStringError";
  }
}

/**
 * Thrown when canonicalization reaches an array element that is `undefined`. JCS has no
 * "undefined" token: an object member whose value is `undefined` is omitted (mirroring
 * `JSON.stringify`), but an array has no key to omit by, so the only non-corrupting move is
 * to reject.
 */
export class UndefinedArrayElementError extends Error {
  readonly category = "invalid-document" as const;
  constructor() {
    super("array elements must not be undefined; JCS has no undefined token");
    this.name = "UndefinedArrayElementError";
  }
}

/** I-JSON strings carry Unicode scalar values, never isolated UTF-16 surrogate code units. */
export function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new IJsonStringError(value);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new IJsonStringError(value);
    }
  }
}

/** Recursively enforces the I-JSON scalar rule over parsed values and member names. */
export function assertIJsonStrings(value: unknown): void {
  if (typeof value === "string") {
    assertIJsonString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) assertIJsonStrings(element);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, member] of Object.entries(value)) {
      assertIJsonString(key);
      assertIJsonStrings(member);
    }
  }
}

/** Sealed records admit only exact I-JSON integers; fractional quantities are decimal strings. */
export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}
```

`src/canonical.ts`:

```ts
import { compareCodeUnitStrings } from "./order.js";
import {
  assertIJsonInteger,
  assertIJsonString,
  UndefinedArrayElementError,
  type JsonValue,
} from "./json.js";

const encoder = new TextEncoder();

/** Emit RFC 8785 JCS by explicit sorted-key iteration — insertion order is never trusted. */
function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    assertIJsonInteger(value);
    return String(value);
  }
  if (typeof value === "string") {
    assertIJsonString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => {
      if (element === undefined) throw new UndefinedArrayElementError();
      return serialize(element);
    }).join(",")}]`;
  }
  // Zod's loose object schemas retain a known-optional key that is present-but-undefined in
  // the input. Skip those members, mirroring `JSON.stringify`: two documents differing only
  // by an omitted vs. explicit-undefined optional field must seal to identical bytes.
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(compareCodeUnitStrings);
  return `{${keys.map((key) => {
    assertIJsonString(key);
    return `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`;
  }).join(",")}}`;
}

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the record forever (§4.1). */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(value));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): locale-free ordering, I-JSON assertions, and RFC 8785 canonical JSON"
```

---

### Task 3: Digest primitives, sealing, and cross-package equivalence

**Files:**
- Create: `packages/environments/record/src/hashing.ts`, `src/sealing.ts`, `src/sealing.test.ts`, `src/equivalence.test.ts`

**Interfaces:**
- Consumes: `serializeCanonicalJson`, `assertIJsonStrings`, `JsonValue` (Task 2). Test-only: `recordDigest` from `@jinn-network/evidence-protocol` — **verify it exists on the base branch before writing the test** (`grep -n "export function recordDigest" packages/evidence/protocol/src/hashing.ts`); a missing symbol is a stop-and-report.
- Produces: `sha256Hex(bytes: Uint8Array): string`; ``environmentRecordDigest(bytes: Uint8Array): `sha256:${string}` ``; ``bareHexDigest(digest: `sha256:${string}`): string ``; `interface ValidationIssue { path: string; message: string }`; `class InvalidDocumentError`; `sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): Uint8Array`; `parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T`.

> `sealWithSchema` returns **bytes only**, not a `{bytes, digest}` pair. This deviates from the house `SealedRecord` shape deliberately: the program plan pins `sealEnvironmentRecord(record): Uint8Array`, and a caller that wants the identity calls `environmentRecordDigest(bytes)`. One shape, one place. Recorded in Findings.

- [ ] **Step 1: Write the failing tests**

`src/sealing.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { bareHexDigest, environmentRecordDigest, sha256Hex } from "./hashing.js";
import { InvalidDocumentError, parseExactWithSchema, sealWithSchema } from "./sealing.js";

const Example = z.strictObject({ alpha: z.number(), beta: z.string() });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("digest primitives", () => {
  test("sha256Hex is lowercase hex of the digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("environmentRecordDigest carries the sha256: prefix the record body uses", () => {
    expect(environmentRecordDigest(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("bareHexDigest strips the prefix for in-toto DigestSet subject values", () => {
    const digest = environmentRecordDigest(new Uint8Array());
    expect(bareHexDigest(digest)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(bareHexDigest(digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(bareHexDigest(digest).startsWith("sha256:")).toBe(false);
  });

  test("bareHexDigest rejects a value that is not a prefixed sha256 digest", () => {
    expect(() => bareHexDigest("a".repeat(64) as never)).toThrow(InvalidDocumentError);
    expect(() => bareHexDigest("sha256:NOTHEX" as never)).toThrow(InvalidDocumentError);
  });
});

describe("sealing", () => {
  test("key-permuted documents seal to identical bytes and one digest", () => {
    const a = sealWithSchema(Example, { alpha: 1, beta: "two" });
    const b = sealWithSchema(Example, { beta: "two", alpha: 1 });
    expect(decode(a)).toBe(decode(b));
    expect(environmentRecordDigest(a)).toBe(environmentRecordDigest(b));
  });

  test("sealWithSchema rejects an invalid document with issue paths", () => {
    try {
      sealWithSchema(Example, { alpha: "not a number", beta: "two" });
      throw new Error("expected InvalidDocumentError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDocumentError);
      expect((error as InvalidDocumentError).errors[0]?.path).toBe("alpha");
    }
  });

  test("parseExactWithSchema round-trips sealed bytes", () => {
    const bytes = sealWithSchema(Example, { alpha: 1, beta: "two" });
    expect(parseExactWithSchema(Example, bytes)).toEqual({ alpha: 1, beta: "two" });
  });

  test("parseExactWithSchema rejects re-canonicalized (pretty-printed) bytes", () => {
    const pretty = new TextEncoder().encode(JSON.stringify({ alpha: 1, beta: "two" }, null, 2));
    expect(() => parseExactWithSchema(Example, pretty)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects key-reordered bytes", () => {
    const reordered = new TextEncoder().encode('{"beta":"two","alpha":1}');
    expect(() => parseExactWithSchema(Example, reordered)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects invalid UTF-8", () => {
    expect(() => parseExactWithSchema(Example, new Uint8Array([0xff, 0xfe]))).toThrow(
      InvalidDocumentError,
    );
  });
});
```

`src/equivalence.test.ts`:

```ts
// Cross-package seal-equivalence leg (program §5 contract 3). This package re-implements
// sealing locally and never imports shared runtime sealing code; equivalence with the
// evidence tree is proven here, in a test file, against two independent oracles:
//   1. `@jinn-network/evidence-protocol`'s `recordDigest` — the evidence tree's own digest
//      spelling over identical bytes;
//   2. `canonicalize` — an independent RFC 8785 JCS implementation.
// The source-boundary guard forbids either import from production source.
import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { recordDigest as evidenceRecordDigest } from "@jinn-network/evidence-protocol";

import { serializeCanonicalJson } from "./canonical.js";
import { environmentRecordDigest } from "./hashing.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const shared = {
  kind: "https://jinn.network/records/environment/1.0",
  source: {
    repo: "owner/name",
    repoUrl: "https://github.com/owner/name",
    commit: "0".repeat(40),
  },
  image: {
    manifestDigest: `sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
  },
  workspace: "/testbed",
  invocations: { test: [{ bin: "pytest", args: ["-q"] }] },
};

describe("cross-package seal equivalence", () => {
  test("our JCS bytes equal the RFC 8785 reference implementation's, whatever the key order", () => {
    const permuted = {
      invocations: shared.invocations,
      workspace: shared.workspace,
      image: { platform: shared.image.platform, manifestDigest: shared.image.manifestDigest },
      source: { commit: shared.source.commit, repoUrl: shared.source.repoUrl, repo: shared.source.repo },
      kind: shared.kind,
    };
    expect(decode(serializeCanonicalJson(shared))).toBe(canonicalize(shared));
    expect(decode(serializeCanonicalJson(permuted))).toBe(canonicalize(shared));
  });

  test("our digest spelling equals the evidence tree's over identical bytes", () => {
    const bytes = serializeCanonicalJson(shared);
    expect(environmentRecordDigest(bytes)).toBe(evidenceRecordDigest(bytes));
  });

  test("the digest is over the sealed bytes, not over a re-serialization", () => {
    const bytes = serializeCanonicalJson(shared);
    const pretty = new TextEncoder().encode(JSON.stringify(shared, null, 2));
    expect(environmentRecordDigest(pretty)).not.toBe(environmentRecordDigest(bytes));
    expect(evidenceRecordDigest(pretty)).not.toBe(evidenceRecordDigest(bytes));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./hashing.js"`.

- [ ] **Step 3: Write the implementation**

`src/hashing.ts`:

```ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { InvalidDocumentError } from "./sealing.js";

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * The record's identity: sha256 over the exact sealed bytes, written with the `sha256:`
 * prefix every digest in a record *body* carries (§4.2).
 */
export function environmentRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}

/**
 * The same digest as an in-toto DigestSet value: **bare lowercase hex, no prefix** (§5.1).
 * A prefixed value inside a DigestSet is non-conformant, and this is the one conversion
 * point — attestation subject builders call this rather than slicing strings by hand. The
 * conformance kit carries the confusion fixture for both directions.
 */
export function bareHexDigest(digest: `sha256:${string}`): string {
  if (!PREFIXED_SHA256.test(digest)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "expected a sha256:-prefixed lowercase-hex digest",
    }]);
  }
  return digest.slice("sha256:".length);
}
```

`src/sealing.ts`:

```ts
import type { z } from "zod";

import { serializeCanonicalJson } from "./canonical.js";
import { assertIJsonStrings, type JsonValue } from "./json.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Thrown when a document fails schema validation at sealing time, or when bytes handed to
 * `parseExactWithSchema` are not the one exact canonical encoding. Re-implemented locally
 * per the per-package sealing rule — the same plain `{ category: "invalid-document",
 * errors }` shape the rest of the stack carries, without importing it.
 */
export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed validation at the sealing boundary");
    this.name = "InvalidDocumentError";
  }
}

function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Validate against `schema`, then canonicalize **once**. The returned bytes are the record
 * forever; its identity is `environmentRecordDigest` over them.
 */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): Uint8Array {
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new InvalidDocumentError(validationIssues(parsed.error));
  return serializeCanonicalJson(parsed.data as JsonValue);
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding — a
 * consumer never re-canonicalizes to check a digest, because re-canonicalizing would let
 * two distinct byte strings present as the same record.
 */
export function parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid UTF-8 JSON" }]);
  }
  assertIJsonStrings(json);

  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidDocumentError(validationIssues(parsed.error));

  if (!bytesEqual(serializeCanonicalJson(parsed.data as JsonValue), bytes)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "bytes are not the exact canonical JSON encoding of this record",
    }]);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/environments/record && yarn test && yarn typecheck`
Expected: PASS (13 new tests, including the three equivalence legs).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): digest primitives, exact-bytes sealing, and cross-package equivalence"
```

---

### Task 4: Identifiers and the namespaced-extension discipline

**Files:**
- Create: `packages/environments/record/src/identifiers.ts`, `src/extensions.ts`, `src/identifiers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ENVIRONMENT_RECORD_KIND` (`"https://jinn.network/records/environment/1.0"`), `ENVIRONMENT_RECORD_MEDIA_TYPE` (`"application/vnd.jinn.environment.v1+json"`), `ENVIRONMENT_RECORD_SCHEMA_ID`; `isNamespacedExtensionKey(key: string): boolean`; `topLevelRecordSchema<Shape>(shape: Shape)`.

- [ ] **Step 1: Write the failing test**

`src/identifiers.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ENVIRONMENT_RECORD_KIND,
  ENVIRONMENT_RECORD_MEDIA_TYPE,
  ENVIRONMENT_RECORD_SCHEMA_ID,
} from "./identifiers.js";
import { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

describe("identifiers", () => {
  test("the record kind is the exact string the design pins", () => {
    expect(ENVIRONMENT_RECORD_KIND).toBe("https://jinn.network/records/environment/1.0");
  });

  test("the record kind conforms to the discovery record-kind URI grammar", () => {
    // Mirror of `assertRecordKindUri`: `https://jinn.network/records/<segment>/<major>.<minor>`
    // with segment matching the discovery source-name grammar. This package cannot import
    // discovery (tier-2, zero Jinn dependencies); the authoritative check runs in the facts
    // leaf, which calls `assertRecordKindUri` on this constant.
    expect(ENVIRONMENT_RECORD_KIND).toMatch(
      /^https:\/\/jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/\d+\.\d+$/,
    );
  });

  test("the media type is the exact vendor-tree string the design pins", () => {
    expect(ENVIRONMENT_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.environment.v1+json");
  });

  test("the published schema id is derived from the record kind", () => {
    expect(ENVIRONMENT_RECORD_SCHEMA_ID).toBe(`${ENVIRONMENT_RECORD_KIND}/schema`);
  });
});

describe("namespaced extension keys", () => {
  test("accepts reverse-DNS and absolute-URI names", () => {
    expect(isNamespacedExtensionKey("network.jinn.note")).toBe(true);
    expect(isNamespacedExtensionKey("com.example.thing")).toBe(true);
    expect(isNamespacedExtensionKey("https://example.test/ext")).toBe(true);
  });

  test("rejects bare names", () => {
    expect(isNamespacedExtensionKey("note")).toBe(false);
    expect(isNamespacedExtensionKey("_private")).toBe(false);
    expect(isNamespacedExtensionKey("")).toBe(false);
  });

  test("topLevelRecordSchema admits namespaced extras and refuses bare ones", () => {
    const schema = topLevelRecordSchema({ known: z.string() });
    expect(schema.safeParse({ known: "a", "network.jinn.note": "kept" }).success).toBe(true);
    expect(schema.safeParse({ known: "a", note: "bare" }).success).toBe(false);
  });

  test("namespaced extras survive the parse round-trip rather than being stripped", () => {
    const schema = topLevelRecordSchema({ known: z.string() });
    const parsed = schema.parse({ known: "a", "network.jinn.note": "kept" });
    expect((parsed as Record<string, unknown>)["network.jinn.note"]).toBe("kept");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./identifiers.js"`.

- [ ] **Step 3: Write the implementation**

`src/identifiers.ts`:

```ts
/**
 * Record-kind URI (§4.1). The grammar
 * `https://jinn.network/records/<segment>/<major>.<minor>` is discovery's, and this
 * constant is validated against discovery's own `assertRecordKindUri` in the facts leaf —
 * this package declares no Jinn dependency, so it mirrors the grammar in a test instead.
 */
export const ENVIRONMENT_RECORD_KIND =
  "https://jinn.network/records/environment/1.0" as const;

/** Media type (§4.1), vendor tree, one major per record version. */
export const ENVIRONMENT_RECORD_MEDIA_TYPE =
  "application/vnd.jinn.environment.v1+json" as const;

/** `$id` of the published JSON Schema shipped at the `./schemas/*` subpath. */
export const ENVIRONMENT_RECORD_SCHEMA_ID =
  `${ENVIRONMENT_RECORD_KIND}/schema` as const;
```

`src/extensions.ts`:

```ts
import { z } from "zod";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

/** Extension names are reverse-DNS or absolute URIs (TEP §21.3); a bare key is neither. */
export function isNamespacedExtensionKey(key: string): boolean {
  if (REVERSE_DNS_KEY_PATTERN.test(key)) return true;
  try {
    return new URL(key).protocol.length > 1;
  } catch {
    return false;
  }
}

/**
 * Keeps a record open only to namespaced extension names: unknown namespaced keys survive
 * round-trips (they reach the sealed bytes and re-parse unchanged), but they can never
 * shadow a core field, and a bare key is `invalid-document` rather than silently accepted.
 */
export function topLevelRecordSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  const knownKeys = new Set(Object.keys(shape));
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (knownKeys.has(key) || isNamespacedExtensionKey(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Extension key "${key}" must be namespaced (reverse-DNS or absolute URI, TEP §21.3).`,
      });
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck`
Expected: PASS (9 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): pinned identifiers and the namespaced-extension discipline"
```

---

### Task 5: The shell-free CommandSpec

**Files:**
- Create: `packages/environments/record/src/command.ts`, `src/command.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CommandSpecSchema` (the pinned name); `type CommandSpec = { bin: string; args: string[]; cwd?: string; env?: Record<string, string> }`; `SHELL_INTERPRETERS`, `SHELL_METACHARACTERS` (frozen, exported for the kit's error messages).

> `CommandSpec` is the legacy shell-free shape carried over (§4.2): `{bin, args[], cwd?, env?}` — **no shell interpolation, ever**. The legacy in-repo shape (`client/src/task-creator/environment/contracts.ts:47`) spells the fourth field `environment`; the program plan §4 pins `env`, and this package follows the program plan. Recorded in Findings so C4's import strategy renames rather than guesses.

- [ ] **Step 1: Write the failing test**

`src/command.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { CommandSpecSchema } from "./command.js";

const ok = { bin: "python", args: ["-m", "pytest", "-q"] };

describe("CommandSpecSchema", () => {
  test("accepts a minimal shell-free command", () => {
    expect(CommandSpecSchema.safeParse(ok).success).toBe(true);
  });

  test("accepts cwd and env", () => {
    expect(
      CommandSpecSchema.safeParse({ ...ok, cwd: "/testbed", env: { PYTHONHASHSEED: "0" } })
        .success,
    ).toBe(true);
  });

  test("accepts an empty argument list", () => {
    expect(CommandSpecSchema.safeParse({ bin: "make", args: [] }).success).toBe(true);
  });

  test("rejects a shell interpreter as bin", () => {
    for (const bin of ["sh", "bash", "zsh", "dash", "/bin/sh", "/usr/bin/env bash", "cmd", "powershell", "pwsh"]) {
      const result = CommandSpecSchema.safeParse({ bin, args: ["-c", "pytest -q"] });
      expect(result.success, `${bin} must be refused`).toBe(false);
    }
  });

  test("rejects shell metacharacters anywhere in bin, args, or cwd", () => {
    expect(CommandSpecSchema.safeParse({ bin: "pytest;rm -rf /", args: [] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["-q && curl x"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["$(id)"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["`id`"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: ["a|b"] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: [], cwd: "/a>b" }).success).toBe(false);
  });

  test("rejects an env value carrying a shell metacharacter", () => {
    expect(
      CommandSpecSchema.safeParse({ ...ok, env: { HOOK: "$(curl evil.test)" } }).success,
    ).toBe(false);
  });

  test("rejects a non-conforming environment variable name", () => {
    expect(CommandSpecSchema.safeParse({ ...ok, env: { "bad name": "1" } }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ ...ok, env: { "1BAD": "1" } }).success).toBe(false);
  });

  test("rejects an empty bin and empty-string args", () => {
    expect(CommandSpecSchema.safeParse({ bin: "", args: [] }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ bin: "pytest", args: [""] }).success).toBe(false);
  });

  test("is strict: no extra keys, namespaced or not", () => {
    expect(CommandSpecSchema.safeParse({ ...ok, shell: true }).success).toBe(false);
    expect(CommandSpecSchema.safeParse({ ...ok, "network.jinn.note": "x" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./command.js"`.

- [ ] **Step 3: Write the implementation**

`src/command.ts`:

```ts
import { z } from "zod";

/**
 * Basenames this schema refuses as `bin`. A record that names a shell and passes a script
 * in `args` has reintroduced shell interpolation through the back door, which §4.2 forbids
 * outright.
 */
export const SHELL_INTERPRETERS = Object.freeze([
  "sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "env",
] as const);

/**
 * Characters that only mean anything to a shell. This is a **structural guard on the
 * document**, not a sandbox: it refuses records whose commands are written as shell text.
 * It makes no claim about what the command does when a runner executes it — containment is
 * the runner's concern, owned by its own design.
 */
export const SHELL_METACHARACTERS = Object.freeze([
  ";", "&", "|", "<", ">", "$", "`", "\\", "\"", "'", "\n", "\r", "(", ")", "{", "}", "*", "?", "~", "!", "#",
] as const);

const metacharacter = new Set<string>(SHELL_METACHARACTERS);

function hasShellMetacharacter(value: string): boolean {
  for (const character of value) {
    if (metacharacter.has(character)) return true;
  }
  return false;
}

function basename(bin: string): string {
  const parts = bin.split("/");
  return parts[parts.length - 1] ?? bin;
}

const shellFreeString = (label: string) =>
  z.string().min(1).refine((value) => !hasShellMetacharacter(value), {
    message: `${label} must not contain shell metacharacters; commands are shell-free (§4.2)`,
  });

const EnvironmentVariableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names are POSIX names");

/**
 * The shell-free command shape (§4.2): `{bin, args[], cwd?, env?}`. Strict — an extra key
 * (`shell`, `script`, or a namespaced one) is not a governed extension here, it is an
 * attempt to smuggle an execution mode into a sealed document.
 */
export const CommandSpecSchema = z.strictObject({
  bin: shellFreeString("bin").refine(
    (value) => !(SHELL_INTERPRETERS as readonly string[]).includes(basename(value)),
    { message: "bin must not be a shell interpreter; commands are shell-free (§4.2)" },
  ),
  args: z.array(shellFreeString("arg")),
  cwd: shellFreeString("cwd").optional(),
  env: z.record(EnvironmentVariableName, shellFreeString("env value")).optional(),
});

export type CommandSpec = z.infer<typeof CommandSpecSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck`
Expected: PASS (9 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): the shell-free CommandSpec"
```

---

### Task 6: The environment record schema

**Files:**
- Create: `packages/environments/record/src/schema.ts`, `src/schema.test.ts`

**Interfaces:**
- Consumes: `topLevelRecordSchema` (Task 4), `CommandSpecSchema` (Task 5), `sealWithSchema`/`parseExactWithSchema`/`InvalidDocumentError` (Task 3), `ENVIRONMENT_RECORD_KIND` (Task 4).
- Produces: `EnvironmentRecordSchema`; `type EnvironmentRecord`; `sealEnvironmentRecord(record: unknown): Uint8Array`; `parseEnvironmentRecord(bytes: Uint8Array): EnvironmentRecord`; the sub-schemas `EnvironmentSourceSchema`, `EnvironmentImageSchema`, `EnvironmentInvocationsSchema`, `EnvironmentParserSchema`, `EnvironmentBuildSchema`, `EnvironmentRightsSchema`, `EnvironmentLineageSchema`; `REPRODUCIBILITY_TIERS`.

Field-by-field against §4.2. Two cross-field invariants carry the adversarial fixtures:

- **`image.reference` MUST end with `@${image.manifestDigest}`.** An advisory pull hint that resolves to different bytes than the record's identity is a lie the schema can catch.
- **`image.indexDigest`, when present, MUST differ from `image.manifestDigest`.** An index digest is never its own platform manifest digest, so equality is a detectable index-passed-as-manifest confusion. The general case (a manifest digest field holding some *other* index's digest) is not structurally detectable and is a verification-time observation — recorded in Findings.

- [ ] **Step 1: Write the failing test**

`src/schema.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { environmentRecordDigest } from "./hashing.js";
import {
  EnvironmentRecordSchema,
  parseEnvironmentRecord,
  sealEnvironmentRecord,
} from "./schema.js";

const MANIFEST = `sha256:${"a".repeat(64)}`;
const INDEX = `sha256:${"b".repeat(64)}`;
const PARSER = `sha256:${"c".repeat(64)}`;

const record = () => ({
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "owner/name",
    repoUrl: "https://github.com/owner/name",
    commit: "0".repeat(40),
  },
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `registry.test/owner/name@${MANIFEST}`,
    indexDigest: INDEX,
  },
  workspace: "/testbed",
  invocations: {
    test: [{ bin: "python", args: ["-m", "pytest", "-q"] }],
  },
  parser: {
    id: "pytest-text",
    version: "1.0.0",
    digest: PARSER,
    uri: "https://example.test/parsers/pytest-text-1.0.0.tar.gz",
  },
  build: { reproducibilityTier: 0, provider: { id: "swe-rebench", version: "2" } },
  rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
  lineage: {
    upstream: { dataset: "nebius/SWE-rebench", revision: "main", keys: ["owner__name-1234"] },
  },
});

describe("environment record schema", () => {
  test("accepts a well-formed imported record", () => {
    expect(EnvironmentRecordSchema.safeParse(record()).success).toBe(true);
  });

  test("accepts a minimal record: no reference, no indexDigest, no lineage, no install", () => {
    const minimal = {
      kind: ENVIRONMENT_RECORD_KIND,
      source: record().source,
      image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
      workspace: "/testbed",
      invocations: { test: [{ bin: "make", args: ["test"] }] },
      parser: { id: "pytest-text", version: "1.0.0", digest: PARSER },
      build: { reproducibilityTier: 0 },
      rights: { sourceLicense: "MIT" },
    };
    expect(EnvironmentRecordSchema.safeParse(minimal).success).toBe(true);
  });

  test("rejects an unknown kind literal", () => {
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), kind: "https://example.test/x/1.0" })
        .success,
    ).toBe(false);
  });

  test("rejects bare-hex digests in the record body", () => {
    const bare = record();
    bare.image.manifestDigest = "a".repeat(64);
    const result = EnvironmentRecordSchema.safeParse(bare);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("sha256:");
  });

  test("rejects an uppercase-hex or short digest", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        image: { ...record().image, manifestDigest: `sha256:${"A".repeat(64)}` },
      }).success,
    ).toBe(false);
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        image: { ...record().image, manifestDigest: "sha256:abcd" },
      }).success,
    ).toBe(false);
  });

  test("rejects a reference that does not end with @manifestDigest", () => {
    const drifted = record();
    drifted.image.reference = `registry.test/owner/name@${INDEX}`;
    const result = EnvironmentRecordSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("reference");
  });

  test("rejects a tag-only reference", () => {
    const tagged = record();
    tagged.image.reference = "registry.test/owner/name:latest";
    expect(EnvironmentRecordSchema.safeParse(tagged).success).toBe(false);
  });

  test("rejects an indexDigest equal to the manifestDigest", () => {
    const confused = record();
    confused.image.indexDigest = MANIFEST;
    const result = EnvironmentRecordSchema.safeParse(confused);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("indexDigest");
  });

  test("rejects an empty test invocation list — the declared scope cannot be empty", () => {
    const scopeless = record();
    scopeless.invocations.test = [];
    expect(EnvironmentRecordSchema.safeParse(scopeless).success).toBe(false);
  });

  test("rejects a shell-bearing invocation", () => {
    const shelly = record();
    shelly.invocations.test = [{ bin: "bash", args: ["-c", "pytest -q"] }];
    expect(EnvironmentRecordSchema.safeParse(shelly).success).toBe(false);
  });

  test("rejects a relative workspace", () => {
    expect(EnvironmentRecordSchema.safeParse({ ...record(), workspace: "testbed" }).success)
      .toBe(false);
  });

  test("rejects a platform that is not os/arch", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        image: { ...record().image, platform: "amd64" },
      }).success,
    ).toBe(false);
  });

  test("rejects a non-40-hex commit", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        source: { ...record().source, commit: "abc" },
      }).success,
    ).toBe(false);
  });

  test("requires build.recipe and build.dependencyPinning at reproducibility tier >= 1", () => {
    const tierOne = { ...record(), build: { reproducibilityTier: 1 } };
    const result = EnvironmentRecordSchema.safeParse(tierOne);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("recipe");

    const complete = {
      ...record(),
      build: {
        reproducibilityTier: 1,
        recipe: { name: "Dockerfile", digest: { sha256: "d".repeat(64) } },
        dependencyPinning: { mechanism: "pip-by-date", asOf: "2026-01-01T00:00:00Z" },
      },
    };
    expect(EnvironmentRecordSchema.safeParse(complete).success).toBe(true);
  });

  test("rejects a reproducibility tier outside 0..2", () => {
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), build: { reproducibilityTier: 3 } })
        .success,
    ).toBe(false);
  });

  test("rejects a parser without a digest, and accepts one without a uri", () => {
    const { uri: _uri, ...withoutUri } = record().parser;
    expect(EnvironmentRecordSchema.safeParse({ ...record(), parser: withoutUri }).success)
      .toBe(true);
    const { digest: _digest, ...withoutDigest } = record().parser;
    expect(EnvironmentRecordSchema.safeParse({ ...record(), parser: withoutDigest }).success)
      .toBe(false);
  });

  test("rejects inline parser source — a parser commits by digest, never by code", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        parser: { ...record().parser, code: "print('hi')" },
      }).success,
    ).toBe(false);
  });

  test("accepts rights without basis and rejects an empty sourceLicense", () => {
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), rights: { sourceLicense: "MIT" } })
        .success,
    ).toBe(true);
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), rights: { sourceLicense: "" } }).success,
    ).toBe(false);
  });

  test("rejects a bare extension key and accepts a namespaced one", () => {
    expect(EnvironmentRecordSchema.safeParse({ ...record(), note: 1 }).success).toBe(false);
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), "network.jinn.note": "kept" }).success,
    ).toBe(true);
  });

  test("there is no status, health, or expiry field to set", () => {
    for (const key of ["status", "health", "expiresAt", "verified"]) {
      expect(
        EnvironmentRecordSchema.safeParse({ ...record(), [key]: "x" }).success,
        `${key} must not be accepted as a core field`,
      ).toBe(false);
    }
  });
});

describe("seal and parse", () => {
  test("sealEnvironmentRecord returns bytes; identity comes from environmentRecordDigest", () => {
    const bytes = sealEnvironmentRecord(record());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(environmentRecordDigest(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("sealing is deterministic and key-order independent", () => {
    const forward = sealEnvironmentRecord(record());
    const reversed = Object.fromEntries(Object.entries(record()).reverse());
    expect(environmentRecordDigest(sealEnvironmentRecord(reversed))).toBe(
      environmentRecordDigest(forward),
    );
  });

  test("parseEnvironmentRecord round-trips sealed bytes and preserves namespaced extras", () => {
    const bytes = sealEnvironmentRecord({ ...record(), "network.jinn.note": "kept" });
    const parsed = parseEnvironmentRecord(bytes);
    expect(parsed.kind).toBe(ENVIRONMENT_RECORD_KIND);
    expect((parsed as Record<string, unknown>)["network.jinn.note"]).toBe("kept");
  });

  test("parseEnvironmentRecord refuses re-canonicalized bytes", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(record(), null, 2));
    expect(() => parseEnvironmentRecord(pretty)).toThrow(InvalidDocumentError);
  });

  test("sealing an invalid record throws InvalidDocumentError", () => {
    expect(() => sealEnvironmentRecord({ ...record(), kind: "nope" })).toThrow(
      InvalidDocumentError,
    );
  });

  test("sealing is idempotent through a parse", () => {
    const once = sealEnvironmentRecord(record());
    const twice = sealEnvironmentRecord(parseEnvironmentRecord(once));
    expect(environmentRecordDigest(twice)).toBe(environmentRecordDigest(once));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./schema.js"`.

- [ ] **Step 3: Write the implementation**

`src/schema.ts`:

```ts
import { z } from "zod";

import { CommandSpecSchema } from "./command.js";
import { topLevelRecordSchema } from "./extensions.js";
import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

/**
 * Every digest in the record *body* is `sha256:`-prefixed lowercase hex (§4.2). In-toto
 * DigestSet subjects, by contrast, are bare hex — see `bareHexDigest` in hashing.ts.
 */
const PrefixedSha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "record-body digests are sha256:<64 lowercase hex> (§4.2)");

const BareSha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hexadecimal digits");

const NonEmpty = z.string().min(1);

export const EnvironmentSourceSchema = z.strictObject({
  /** Display slug, e.g. `owner/name`. */
  repo: z.string().regex(/^[^\s/]+\/[^\s/]+$/, "repo is a display slug of the form owner/name"),
  repoUrl: z.url(),
  /** The exact tree the environment is declared to contain. */
  commit: z.string().regex(/^[0-9a-f]{40}$/, "commit is a 40-character lowercase hex sha"),
});

/**
 * The image identity is the **platform-specific OCI manifest digest** — never the index
 * digest, never a config or layer digest. Behavior claims are per-platform facts, so one
 * record describes one platform (§4.2).
 */
export const EnvironmentImageSchema = z
  .strictObject({
    manifestDigest: PrefixedSha256,
    platform: z
      .string()
      .regex(/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/, "platform is os/arch[/variant]"),
    /** Advisory pull hint. Identity is `manifestDigest`; this may only agree with it. */
    reference: NonEmpty.optional(),
    /** Optional provenance: the multi-arch index this platform manifest came from. */
    indexDigest: PrefixedSha256.optional(),
  })
  .superRefine((image, ctx) => {
    if (image.reference !== undefined && !image.reference.endsWith(`@${image.manifestDigest}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "reference is advisory and MUST end with @<manifestDigest> (§4.2)",
      });
    }
    if (image.indexDigest !== undefined && image.indexDigest === image.manifestDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["indexDigest"],
        message:
          "indexDigest equals manifestDigest: an index digest is never its own platform "
          + "manifest digest, so one of the two is a confusion (§4.2)",
      });
    }
  });

export const EnvironmentInvocationsSchema = z.strictObject({
  /** Optional — empty when the image is pre-installed (§4.2). */
  install: z.array(CommandSpecSchema).optional(),
  /**
   * Required. This is the **declared verification scope**: an attestation about this
   * environment claims exactly as far as these commands reach and no further. Two records
   * over one image with different scopes are different environments by identity.
   */
  test: z.array(CommandSpecSchema).min(1, "invocations.test is the declared scope and cannot be empty"),
});

/**
 * A parser commits by digest, never by inline source — strict, so a `code`/`source` key is
 * refused rather than accepted as an extension. `uri` is an advisory acquisition hint:
 * without one, a third party cannot execute re-verification even though the digest still
 * tells them whether they have the right parser (§4.2, adversarial review #8).
 */
export const EnvironmentParserSchema = z.strictObject({
  id: NonEmpty,
  version: NonEmpty,
  digest: PrefixedSha256,
  uri: NonEmpty.optional(),
});

/** in-toto v1 ResourceDescriptor shape, structurally mirrored (no cross-package import). */
const ResourceDescriptorSchema = z
  .looseObject({
    name: NonEmpty.optional(),
    uri: NonEmpty.optional(),
    digest: z.record(z.string(), BareSha256Hex).optional(),
    mediaType: NonEmpty.optional(),
    downloadLocation: NonEmpty.optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (descriptor) =>
      descriptor.uri !== undefined
      || (descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0),
    { message: "a ResourceDescriptor requires at least one of uri/digest" },
  );

export const REPRODUCIBILITY_TIERS = Object.freeze({
  pinnedImage: 0,
  rebuildable: 1,
  bitReproducible: 2,
} as const);

export const EnvironmentBuildSchema = z
  .strictObject({
    /** 0 pinned-image | 1 rebuildable | 2 bit-reproducible (§4.2). */
    reproducibilityTier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    recipe: ResourceDescriptorSchema.optional(),
    /** Declaration of the time-travel mechanism used to pin dependencies. */
    dependencyPinning: z.looseObject({ mechanism: NonEmpty }).optional(),
    provider: z.strictObject({ id: NonEmpty, version: NonEmpty }).optional(),
  })
  .superRefine((build, ctx) => {
    if (build.reproducibilityTier === 0) return;
    if (build.recipe === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["recipe"],
        message: "build.recipe is required at reproducibilityTier >= 1 (§4.2)",
      });
    }
    if (build.dependencyPinning === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencyPinning"],
        message: "build.dependencyPinning is required at reproducibilityTier >= 1 (§4.2)",
      });
    }
  });

/**
 * `sourceLicense` is the owner's **declared** upstream SPDX expression, not a detected one
 * — the record states what the producer asserts and does not claim to have verified it.
 * `basis` is an optional open vocabulary: a producer's provenance note, never pipeline
 * policy (v1 producers write `upstream-permissive-filter`).
 */
export const EnvironmentRightsSchema = z.strictObject({
  sourceLicense: NonEmpty,
  basis: NonEmpty.optional(),
});

/** Present for imported environments; absent for environments described from scratch. */
export const EnvironmentLineageSchema = z.strictObject({
  upstream: z.strictObject({
    dataset: NonEmpty,
    revision: NonEmpty,
    keys: z.array(NonEmpty).min(1),
  }),
});

/**
 * One record = one environment = one `(source, image, platform, invocations, parser)`
 * binding (§4.2). Sealed forever: there is no expiry field and no status field, because
 * staleness is a derived signal consumers compute from attestation history, never a
 * mutation of the record (§4.3).
 */
export const EnvironmentRecordSchema = topLevelRecordSchema({
  kind: z.literal(ENVIRONMENT_RECORD_KIND),
  source: EnvironmentSourceSchema,
  image: EnvironmentImageSchema,
  workspace: z.string().regex(/^\/[^\s]*$/, "workspace is an absolute path inside the image"),
  invocations: EnvironmentInvocationsSchema,
  parser: EnvironmentParserSchema,
  build: EnvironmentBuildSchema,
  rights: EnvironmentRightsSchema,
  lineage: EnvironmentLineageSchema.optional(),
});

export type EnvironmentRecord = z.infer<typeof EnvironmentRecordSchema>;

/**
 * Validate, then canonicalize once. The returned bytes are the record forever; its identity
 * is `environmentRecordDigest(bytes)`.
 */
export function sealEnvironmentRecord(record: unknown): Uint8Array {
  return sealWithSchema(EnvironmentRecordSchema, record);
}

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseEnvironmentRecord(bytes: Uint8Array): EnvironmentRecord {
  return parseExactWithSchema(EnvironmentRecordSchema, bytes);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck`
Expected: PASS (26 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): the sealed environment record schema and its cross-field invariants"
```

---

### Task 7: The public surface

**Files:**
- Create: `packages/environments/record/src/index.test.ts`
- Modify: `packages/environments/record/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces: the package's public API — the exact surface C2 (`environment-verification`), C3 (`task-admission`), C4 (`task-derivation`), and the facts leaf import. Every pinned name in program plan §4 is exported from here.

- [ ] **Step 1: Write the failing test**

`src/index.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import * as api from "./index.js";

/** The program plan §4 pinned interface. Renaming any of these is a program-plan amendment. */
const PINNED = [
  "ENVIRONMENT_RECORD_KIND",
  "ENVIRONMENT_RECORD_MEDIA_TYPE",
  "CommandSpecSchema",
  "sealEnvironmentRecord",
  "parseEnvironmentRecord",
  "environmentRecordDigest",
] as const;

describe("public surface", () => {
  test("exports every pinned name from the program plan", () => {
    for (const name of PINNED) expect(api).toHaveProperty(name);
  });

  test("exports the schema, sealing primitives, and digest-conversion helper", () => {
    for (const name of [
      "ENVIRONMENT_RECORD_SCHEMA_ID",
      "EnvironmentRecordSchema",
      "EnvironmentSourceSchema",
      "EnvironmentImageSchema",
      "EnvironmentInvocationsSchema",
      "EnvironmentParserSchema",
      "EnvironmentBuildSchema",
      "EnvironmentRightsSchema",
      "EnvironmentLineageSchema",
      "REPRODUCIBILITY_TIERS",
      "SHELL_INTERPRETERS",
      "SHELL_METACHARACTERS",
      "InvalidDocumentError",
      "serializeCanonicalJson",
      "compareCodeUnitStrings",
      "sha256Hex",
      "bareHexDigest",
      "isNamespacedExtensionKey",
      "topLevelRecordSchema",
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  test("sealEnvironmentRecord returns bytes, matching the pinned signature", () => {
    const sealed = api.sealEnvironmentRecord({
      kind: api.ENVIRONMENT_RECORD_KIND,
      source: { repo: "o/n", repoUrl: "https://github.com/o/n", commit: "0".repeat(40) },
      image: { manifestDigest: `sha256:${"a".repeat(64)}`, platform: "linux/amd64" },
      workspace: "/testbed",
      invocations: { test: [{ bin: "make", args: ["test"] }] },
      parser: { id: "p", version: "1", digest: `sha256:${"c".repeat(64)}` },
      build: { reproducibilityTier: 0 },
      rights: { sourceLicense: "MIT" },
    });
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(api.environmentRecordDigest(sealed)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("does not leak the testing kit or the fixture loaders through the root entrypoint", () => {
    expect(api).not.toHaveProperty("describeEnvironmentRecordConformance");
    expect(api).not.toHaveProperty("loadGoldenBytes");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — the placeholder `index.ts` exports nothing.

- [ ] **Step 3: Write the implementation**

`src/index.ts`:

```ts
// Pinned identifiers (§4.1)
export {
  ENVIRONMENT_RECORD_KIND,
  ENVIRONMENT_RECORD_MEDIA_TYPE,
  ENVIRONMENT_RECORD_SCHEMA_ID,
} from "./identifiers.js";

// Sealing primitives — re-implemented in this package; equivalence is proven by fixtures.
export { compareCodeUnitStrings } from "./order.js";
export {
  assertIJsonInteger,
  assertIJsonString,
  assertIJsonStrings,
  IJsonNumberError,
  IJsonStringError,
  UndefinedArrayElementError,
} from "./json.js";
export type { JsonValue } from "./json.js";
export { serializeCanonicalJson } from "./canonical.js";
export { bareHexDigest, environmentRecordDigest, sha256Hex } from "./hashing.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealWithSchema,
} from "./sealing.js";
export type { ValidationIssue } from "./sealing.js";

// Extension discipline
export { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

// Command shape
export { CommandSpecSchema, SHELL_INTERPRETERS, SHELL_METACHARACTERS } from "./command.js";
export type { CommandSpec } from "./command.js";

// Record kind
export {
  EnvironmentBuildSchema,
  EnvironmentImageSchema,
  EnvironmentInvocationsSchema,
  EnvironmentLineageSchema,
  EnvironmentParserSchema,
  EnvironmentRecordSchema,
  EnvironmentRightsSchema,
  EnvironmentSourceSchema,
  parseEnvironmentRecord,
  REPRODUCIBILITY_TIERS,
  sealEnvironmentRecord,
} from "./schema.js";
export type { EnvironmentRecord } from "./schema.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck && yarn build`
Expected: PASS (4 new tests); `dist/` produced.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): the package public surface"
```

---

### Task 8: Golden, equivalence, and adversarial fixtures

**Files:**
- Create: `packages/environments/record/scripts/generate-fixtures.mjs`
- Create (generated): `fixtures/environment/{imported.json,imported.sha256,tier-1.json,tier-1.sha256,extension.json,extension.sha256}`, `fixtures/environment/invalid-{index-digest-as-manifest,reference-not-ending-in-digest,shell-command,bare-extension-key,bare-hex-manifest-digest}.json`
- Create (generated): `fixtures/equivalence/{input-a.json,input-b.json,expected-digest.json}`
- Create (generated): `fixtures/adversarial-v1/manifest.json` and one directory per case
- Create: `packages/environments/record/src/fixtures.ts`, `src/fixtures.test.ts`
- Modify: `packages/environments/record/package.json` (already carries `generate:fixtures` / `check:fixtures`)

**Interfaces:**
- Consumes: `sealEnvironmentRecord`, `environmentRecordDigest`, `ENVIRONMENT_RECORD_KIND` (Tasks 3–7).
- Produces: `loadGoldenBytes(name)`, `loadGoldenJson(name)`, `loadGoldenDigest(name)`, `loadInvalidJson(name)`, `loadEquivalenceInput(variant)`, `loadEquivalenceExpectedDigest()`, `loadAdversarialManifest()`, `readAdversarialJson(id)`, `readAdversarialBytes(id)`; `type GoldenName = "imported" | "tier-1" | "extension"`; `interface AdversarialManifest`.

> **Fixture-provenance rule:** fixtures are derived from this specification and the in-tree generator — **never captured from a product run**. The `imported` golden's shape mirrors a SWE-rebench row's metadata, but every value in it is synthetic.

Spec §4.5 enumerates the corpus this task must produce, exactly:

| Class | Fixture | Expected |
| --- | --- | --- |
| Golden | `imported` — a sealed rebench-imported environment record | accepted |
| Golden | `tier-1` — recipe + dependency pinning | accepted |
| Golden | `extension` — a namespaced-extension record | accepted |
| Adversarial | `index-digest-as-manifest` | `invalid-document` |
| Adversarial | `reference-not-ending-in-digest` | `invalid-document` |
| Adversarial | `shell-command` | `invalid-document` |
| Adversarial | `bare-extension-key` | `invalid-document` |
| Adversarial | `recanonicalized-bytes` | `invalid-bytes` (parses as JSON, refused as bytes) |
| Adversarial | `bare-hex-manifest-digest` — the digest-confusion fixture (program §5 contract 6) | `invalid-document` |
| Cross-package | `equivalence/*` — key-permuted twins + pinned digest | one digest |

- [ ] **Step 1: Write the failing test**

`src/fixtures.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadInvalidJson,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { environmentRecordDigest } from "./hashing.js";
import {
  EnvironmentRecordSchema,
  parseEnvironmentRecord,
  sealEnvironmentRecord,
} from "./schema.js";

const GOLDEN = ["imported", "tier-1", "extension"] as const;
const INVALID = [
  "index-digest-as-manifest",
  "reference-not-ending-in-digest",
  "shell-command",
  "bare-extension-key",
  "bare-hex-manifest-digest",
] as const;

describe("fixtures", () => {
  test.each(GOLDEN)("golden %s parses and re-seals to its pinned digest", async (name) => {
    const bytes = await loadGoldenBytes(name);
    const digest = await loadGoldenDigest(name);
    expect(environmentRecordDigest(bytes)).toBe(digest);
    expect(parseEnvironmentRecord(bytes).kind).toBeDefined();
    expect(environmentRecordDigest(sealEnvironmentRecord(await loadGoldenJson(name)))).toBe(digest);
  });

  test.each(INVALID)("invalid fixture %s is rejected", async (name) => {
    expect(EnvironmentRecordSchema.safeParse(await loadInvalidJson(name)).success).toBe(false);
  });

  test("key-permuted equivalence twins seal to one pinned digest", async () => {
    const expected = await loadEquivalenceExpectedDigest();
    expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("a")))).toBe(expected);
    expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("b")))).toBe(expected);
  });

  test("the adversarial corpus is complete and behaves as its manifest declares", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.fixtures.map((entry) => entry.id).sort()).toEqual([
      "bare-extension-key",
      "bare-hex-manifest-digest",
      "index-digest-as-manifest",
      "namespaced-extension-preserved",
      "recanonicalized-bytes",
      "reference-not-ending-in-digest",
      "shell-command",
    ]);
    for (const entry of manifest.fixtures) {
      if (entry.expectedDisposition === "invalid-bytes") {
        const bytes = await readAdversarialBytes(entry.id);
        expect(EnvironmentRecordSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes))).success)
          .toBe(true);
        expect(() => parseEnvironmentRecord(bytes), entry.description).toThrow();
        continue;
      }
      const accepted = EnvironmentRecordSchema.safeParse(await readAdversarialJson(entry.id)).success;
      expect(accepted, `${entry.id}: ${entry.description}`).toBe(
        entry.expectedDisposition === "accepted",
      );
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./fixtures.js"`.

- [ ] **Step 3: Write the fixture generator**

`scripts/generate-fixtures.mjs`:

```js
// Generates the golden, equivalence, and adversarial fixture corpora from the schema.
// Fixtures are derived from the specification and this generator, never captured from a
// product run. `--write` regenerates; `--check` (the default) detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixturesRoot = join(root, "fixtures");

const { ENVIRONMENT_RECORD_KIND, environmentRecordDigest, sealEnvironmentRecord } = await import(
  join(root, "dist", "index.js")
);

const MANIFEST = `sha256:${"1".repeat(64)}`;
const INDEX = `sha256:${"2".repeat(64)}`;
const PARSER = `sha256:${"3".repeat(64)}`;
const RECIPE = "4".repeat(64);

/** A synthetic SWE-rebench-shaped import: tier 0, lineage present, pre-installed image. */
const imported = () => ({
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "example-org/example-lib",
    repoUrl: "https://github.com/example-org/example-lib",
    commit: "0".repeat(39) + "1",
  },
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `registry.example.test/swe/example-lib@${MANIFEST}`,
    indexDigest: INDEX,
  },
  workspace: "/testbed",
  invocations: {
    test: [{ bin: "python", args: ["-m", "pytest", "-q", "tests/test_core.py"], cwd: "/testbed" }],
  },
  parser: {
    id: "pytest-text",
    version: "1.0.0",
    digest: PARSER,
    uri: "https://example.test/parsers/pytest-text-1.0.0.tar.gz",
  },
  build: { reproducibilityTier: 0, provider: { id: "swe-rebench", version: "2" } },
  rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
  lineage: {
    upstream: {
      dataset: "example/upstream-dataset",
      revision: "0".repeat(40),
      keys: ["example-org__example-lib-4242"],
    },
  },
});

/** Tier 1: rebuildable, so recipe + dependencyPinning are mandatory. */
const tierOne = () => ({
  ...imported(),
  image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
  invocations: {
    install: [{ bin: "pip", args: ["install", "-e", "."], cwd: "/testbed" }],
    test: [{ bin: "python", args: ["-m", "pytest", "-q"], cwd: "/testbed" }],
  },
  build: {
    reproducibilityTier: 1,
    recipe: {
      name: "Dockerfile",
      mediaType: "text/x-dockerfile",
      digest: { sha256: RECIPE },
    },
    dependencyPinning: { mechanism: "pip-by-date", asOf: "2026-01-01T00:00:00Z" },
    provider: { id: "example-builder", version: "0.3.0" },
  },
  lineage: undefined,
});

/** A record carrying an unknown but namespaced extension key, which must survive sealing. */
const extension = () => ({
  ...imported(),
  "network.jinn.note": "an extension key a future consumer added",
  "https://example.test/ext/provenance": { collector: "example" },
});

const invalid = {
  "index-digest-as-manifest": () => {
    const document = imported();
    document.image.indexDigest = document.image.manifestDigest;
    return document;
  },
  "reference-not-ending-in-digest": () => {
    const document = imported();
    document.image.reference = "registry.example.test/swe/example-lib:latest";
    return document;
  },
  "shell-command": () => {
    const document = imported();
    document.invocations.test = [{ bin: "bash", args: ["-c", "pytest -q && echo done"] }];
    return document;
  },
  "bare-extension-key": () => ({ ...imported(), note: "not namespaced" }),
  "bare-hex-manifest-digest": () => {
    const document = imported();
    document.image.manifestDigest = "1".repeat(64);
    delete document.image.reference;
    return document;
  },
};

const adversarial = {
  "index-digest-as-manifest": {
    description:
      "The multi-arch index digest presented as the platform manifest digest. Behaviour claims "
      + "are per-platform facts; an index-level record would be a lie by aggregation.",
    expectedDisposition: "invalid-document",
    document: invalid["index-digest-as-manifest"],
  },
  "reference-not-ending-in-digest": {
    description:
      "An advisory pull reference that does not pin the record's own manifest digest, so it can "
      + "resolve to different bytes than the record identifies.",
    expectedDisposition: "invalid-document",
    document: invalid["reference-not-ending-in-digest"],
  },
  "shell-command": {
    description: "An invocation that reintroduces shell interpolation by naming a shell as bin.",
    expectedDisposition: "invalid-document",
    document: invalid["shell-command"],
  },
  "bare-extension-key": {
    description: "An un-namespaced extension key, indistinguishable from a smuggled core field.",
    expectedDisposition: "invalid-document",
    document: invalid["bare-extension-key"],
  },
  "bare-hex-manifest-digest": {
    description:
      "Digest confusion: an in-toto DigestSet subject spelling (bare hex) used in the record "
      + "body, where every digest is sha256:-prefixed.",
    expectedDisposition: "invalid-document",
    document: invalid["bare-hex-manifest-digest"],
  },
  "namespaced-extension-preserved": {
    description: "A namespaced extension key, which must survive sealing and re-parsing.",
    expectedDisposition: "accepted",
    document: extension,
  },
  "recanonicalized-bytes": {
    description:
      "The golden record re-serialized with pretty-printing: a valid document whose bytes are "
      + "not the record's bytes, so it must not present as the same record.",
    expectedDisposition: "invalid-bytes",
    bytes: () => `${JSON.stringify(imported(), null, 2)}\n`,
  },
};

const write = process.argv.includes("--write");
const failures = [];

async function emit(relativePath, contents) {
  const target = join(fixturesRoot, relativePath);
  const text = typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  if (write) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) failures.push(relativePath);
}

/** The pinned bytes are the sealed bytes — emitted verbatim, not pretty-printed. */
async function emitGolden(name, build) {
  const document = build();
  const sealed = sealEnvironmentRecord(document);
  await emit(`environment/${name}.json`, new TextDecoder().decode(sealed));
  await emit(`environment/${name}.sha256`, `${environmentRecordDigest(sealed)}\n`);
}

await emitGolden("imported", imported);
await emitGolden("tier-1", tierOne);
await emitGolden("extension", extension);

for (const [name, build] of Object.entries(invalid)) {
  await emit(`environment/invalid-${name}.json`, build());
}

const permuted = (value) =>
  Array.isArray(value)
    ? value.map(permuted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, permuted(member)]))
      : value;

await emit("equivalence/input-a.json", imported());
await emit("equivalence/input-b.json", permuted(imported()));
await emit("equivalence/expected-digest.json", {
  digest: environmentRecordDigest(sealEnvironmentRecord(imported())),
});

const manifest = { fixtures: [] };
for (const [id, entry] of Object.entries(adversarial)) {
  if (entry.expectedDisposition === "invalid-bytes") {
    await emit(`adversarial-v1/${id}/document.bytes`, entry.bytes());
  } else {
    await emit(`adversarial-v1/${id}/document.json`, entry.document());
  }
  manifest.fixtures.push({
    id,
    description: entry.description,
    expectedDisposition: entry.expectedDisposition,
  });
}
await emit("adversarial-v1/manifest.json", manifest);

if (!write && failures.length > 0) {
  console.error(`fixture drift in:\n${failures.map((path) => `  ${path}`).join("\n")}`);
  process.exit(1);
}
console.log(write ? "fixtures written" : "fixtures up to date");
```

> `tierOne()` sets `lineage: undefined`. The canonical serializer skips `undefined` object members (Task 2), so the sealed tier-1 record carries no `lineage` key — the same bytes a document that simply omitted it would produce. The `check:fixtures` drift run proves this holds.

- [ ] **Step 4: Generate the fixtures**

Run: `cd packages/environments/record && yarn generate:fixtures`
Expected: `fixtures written`; `fixtures/environment/`, `fixtures/equivalence/`, and `fixtures/adversarial-v1/` exist.

- [ ] **Step 5: Write the loaders**

`src/fixtures.ts`:

```ts
// The only production-adjacent file permitted to touch the filesystem. It belongs to the
// testing region: `index.ts` never re-exports it, and the source-boundary guard classifies
// it with `testing.ts` and the `*.test.ts` files.
import { readFile } from "node:fs/promises";

export type GoldenName = "imported" | "tier-1" | "extension";

export interface AdversarialManifestEntry {
  readonly id: string;
  readonly description: string;
  readonly expectedDisposition: "accepted" | "invalid-document" | "invalid-bytes";
}

export interface AdversarialManifest {
  readonly fixtures: readonly AdversarialManifestEntry[];
}

/** Resolves a path inside the fixture corpus shipped by this package. */
export function environmentFixtureUrl(relativePath: string): URL {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("environment fixture paths must stay inside fixtures/");
  }
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(environmentFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(environmentFixtureUrl(relativePath), "utf8"));
}

export async function loadGoldenBytes(name: GoldenName): Promise<Uint8Array> {
  return bytes(`environment/${name}.json`);
}

export async function loadGoldenJson(name: GoldenName): Promise<unknown> {
  return json(`environment/${name}.json`);
}

export async function loadGoldenDigest(name: GoldenName): Promise<`sha256:${string}`> {
  const text = await readFile(environmentFixtureUrl(`environment/${name}.sha256`), "utf8");
  return text.trim() as `sha256:${string}`;
}

export async function loadInvalidJson(name: string): Promise<unknown> {
  return json(`environment/invalid-${name}.json`);
}

export async function loadEquivalenceInput(variant: "a" | "b"): Promise<unknown> {
  return json(`equivalence/input-${variant}.json`);
}

export async function loadEquivalenceExpectedDigest(): Promise<`sha256:${string}`> {
  const parsed = (await json("equivalence/expected-digest.json")) as { digest: string };
  return parsed.digest as `sha256:${string}`;
}

export async function loadAdversarialManifest(): Promise<AdversarialManifest> {
  return (await json("adversarial-v1/manifest.json")) as AdversarialManifest;
}

export async function readAdversarialJson(id: string): Promise<unknown> {
  return json(`adversarial-v1/${id}/document.json`);
}

export async function readAdversarialBytes(id: string): Promise<Uint8Array> {
  return bytes(`adversarial-v1/${id}/document.bytes`);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck && yarn check:fixtures`
Expected: PASS (11 fixture tests); `fixtures up to date`.

- [ ] **Step 7: Commit**

```bash
git add packages/environments/record
git commit -m "feat(environment-record): golden, equivalence, and adversarial fixture corpora"
```

---

### Task 9: The conformance kit

**Files:**
- Create: `packages/environments/record/src/testing.ts`, `src/kit.test.ts`

**Interfaces:**
- Consumes: fixtures (Task 8), schema (Task 6), sealing and digest primitives (Task 3).
- Produces: `describeEnvironmentRecordConformance(): void` — the suite any producer, consumer, or third-party implementation runs to prove it reproduces this record surface. Exported from the `./testing` subpath, never from the root.

The kit is the gate every dependent waits on (program §5 contract 2 and §6). It carries the **digest-confusion fixture** in both directions (contract 6), which is what C2's subject builder is checked against.

- [ ] **Step 1: Write the failing test**

`src/kit.test.ts`:

```ts
import { describeEnvironmentRecordConformance } from "./testing.js";

describeEnvironmentRecordConformance();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `Failed to resolve import "./testing.js"`.

- [ ] **Step 3: Write the kit**

`src/testing.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  type GoldenName,
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { bareHexDigest, environmentRecordDigest } from "./hashing.js";
import { ENVIRONMENT_RECORD_KIND, ENVIRONMENT_RECORD_MEDIA_TYPE } from "./identifiers.js";
import {
  EnvironmentRecordSchema,
  parseEnvironmentRecord,
  sealEnvironmentRecord,
} from "./schema.js";

const GOLDEN: readonly GoldenName[] = ["imported", "tier-1", "extension"];
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Record conformance for the environment kind: identifier pinning, schema validation,
 * producer-side re-seal, consumer-side digest verification without re-canonicalization,
 * extension round-tripping, the digest-confusion boundary, and the adversarial corpus.
 *
 * Any implementation that produces or consumes environment records runs this driver to
 * prove it reproduces the frozen record surface. It asserts what the record *is*; it
 * asserts nothing about whether any environment works — that claim lives in separately
 * published verification attestations and is bounded there.
 */
export function describeEnvironmentRecordConformance(): void {
  describe("Environment record conformance", () => {
    test("the pinned identifiers are exactly the design's strings", () => {
      expect(ENVIRONMENT_RECORD_KIND).toBe("https://jinn.network/records/environment/1.0");
      expect(ENVIRONMENT_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.environment.v1+json");
    });

    describe.each(GOLDEN)("golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(EnvironmentRecordSchema.safeParse(await loadGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const pinnedBytes = await loadGoldenBytes(name);
        const pinnedDigest = await loadGoldenDigest(name);
        const resealed = sealEnvironmentRecord(await loadGoldenJson(name));
        expect(decode(resealed)).toBe(decode(pinnedBytes));
        expect(environmentRecordDigest(resealed)).toBe(pinnedDigest);
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(environmentRecordDigest(await loadGoldenBytes(name))).toBe(
          await loadGoldenDigest(name),
        );
      });

      test("sealing is idempotent through a parse", async () => {
        const once = sealEnvironmentRecord(await loadGoldenJson(name));
        const twice = sealEnvironmentRecord(parseEnvironmentRecord(once));
        expect(environmentRecordDigest(twice)).toBe(environmentRecordDigest(once));
      });

      test("the record declares a test scope and no mutable status", async () => {
        const record = parseEnvironmentRecord(await loadGoldenBytes(name));
        expect(record.invocations.test.length).toBeGreaterThan(0);
        for (const key of ["status", "health", "expiresAt", "verified"]) {
          expect(Object.hasOwn(record, key), `${key} must not exist on a sealed record`).toBe(false);
        }
      });

      test("every command in the record is shell-free", async () => {
        const record = parseEnvironmentRecord(await loadGoldenBytes(name));
        for (const command of [...(record.invocations.install ?? []), ...record.invocations.test]) {
          expect(Object.hasOwn(command, "shell")).toBe(false);
          expect(command.bin).not.toMatch(/^(\/.*\/)?(ba|z|da|k|c|tc|fi)?sh$/);
          expect(command.args.some((arg) => arg === "-c")).toBe(false);
        }
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("a")))).toBe(expected);
      expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("b")))).toBe(expected);
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const pretty = new TextEncoder().encode(
        JSON.stringify(await loadGoldenJson("imported"), null, 2),
      );
      expect(() => parseEnvironmentRecord(pretty)).toThrow();
    });

    test("namespaced extension keys survive sealing and re-parsing", async () => {
      const record = parseEnvironmentRecord(await loadGoldenBytes("extension"));
      expect((record as Record<string, unknown>)["network.jinn.note"]).toBeDefined();
      const resealed = sealEnvironmentRecord(record);
      expect(decode(resealed)).toBe(decode(await loadGoldenBytes("extension")));
    });

    // Digest confusion, both directions (program §5 contract 6). Record-body digests are
    // `sha256:`-prefixed; in-toto DigestSet subject values are bare hex. Mixing them is the
    // single most likely wiring error at the record/attestation boundary.
    describe("digest confusion", () => {
      test("the record identity is sha256:-prefixed", async () => {
        expect(environmentRecordDigest(await loadGoldenBytes("imported"))).toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
      });

      test("bareHexDigest yields the DigestSet spelling: bare hex, no prefix", async () => {
        const digest = environmentRecordDigest(await loadGoldenBytes("imported"));
        const bare = bareHexDigest(digest);
        expect(bare).toMatch(/^[0-9a-f]{64}$/);
        expect(bare.startsWith("sha256:")).toBe(false);
        expect(`sha256:${bare}`).toBe(digest);
      });

      test("bareHexDigest refuses an already-bare value rather than passing it through", async () => {
        const bare = bareHexDigest(environmentRecordDigest(await loadGoldenBytes("imported")));
        expect(() => bareHexDigest(bare as never)).toThrow();
      });

      test("a bare-hex digest inside the record body is refused", async () => {
        expect(
          EnvironmentRecordSchema.safeParse(await readAdversarialJson("bare-hex-manifest-digest"))
            .success,
        ).toBe(false);
      });
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(7);
      for (const entry of manifest.fixtures) {
        if (entry.expectedDisposition === "invalid-bytes") {
          const bytes = await readAdversarialBytes(entry.id);
          expect(() => parseEnvironmentRecord(bytes), `${entry.id}: ${entry.description}`).toThrow();
          continue;
        }
        const accepted = EnvironmentRecordSchema.safeParse(await readAdversarialJson(entry.id)).success;
        expect(accepted, `${entry.id}: ${entry.description}`).toBe(
          entry.expectedDisposition === "accepted",
        );
      }
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/environments/record && yarn test && yarn typecheck`
Expected: PASS — the conformance suite runs green in-package.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record/src
git commit -m "feat(environment-record): the record conformance kit"
```

---

### Task 10: The published JSON Schema

**Files:**
- Create: `packages/environments/record/scripts/generate-schemas.mjs`, `schemas/environment.schema.json` (generated), `src/schema-parity.test.ts`

**Interfaces:**
- Consumes: `EnvironmentRecordSchema`, `ENVIRONMENT_RECORD_SCHEMA_ID`, fixture loaders.
- Produces: `schemas/environment.schema.json`, published at the `./schemas/*` subpath — the artifact that makes "a third party can validate an environment record without running Jinn code" mechanical rather than aspirational (spec §3.1: "including non-Jinn tools reading the published schema").

- [ ] **Step 1: Write the failing test**

`src/schema-parity.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadGoldenJson, loadInvalidJson } from "./fixtures.js";
import { ENVIRONMENT_RECORD_SCHEMA_ID } from "./identifiers.js";

const published = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL("../schemas/environment.schema.json", import.meta.url), "utf8"));

const validator = async () => new Ajv2020({ strict: false }).compile(await published());

describe("published JSON Schema", () => {
  test("declares the record kind as its identifier", async () => {
    expect((await published()).$id).toBe(ENVIRONMENT_RECORD_SCHEMA_ID);
  });

  test("accepts every golden fixture under a standalone validator", async () => {
    const validate = await validator();
    for (const name of ["imported", "tier-1", "extension"] as const) {
      expect(validate(await loadGoldenJson(name)), name).toBe(true);
    }
  });

  test("rejects the structurally-expressible invalid fixtures", async () => {
    const validate = await validator();
    expect(validate(await loadInvalidJson("bare-extension-key"))).toBe(false);
    expect(validate(await loadInvalidJson("bare-hex-manifest-digest"))).toBe(false);
    expect(validate(await loadInvalidJson("shell-command"))).toBe(false);
  });

  test("documents the runtime-only checks it cannot express", async () => {
    const comment = String((await published()).$comment);
    expect(comment).toContain("reference");
    expect(comment).toContain("indexDigest");
    expect(comment).toContain("canonical");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/environments/record && yarn test`
Expected: FAIL — `schemas/environment.schema.json` does not exist.

- [ ] **Step 3: Write the generator**

`scripts/generate-schemas.mjs`:

```js
// Emits the published JSON Schema. `--write` regenerates; `--check` detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const mode = process.argv.includes("--write") ? "--write" : "--check";

const { ENVIRONMENT_RECORD_SCHEMA_ID, EnvironmentRecordSchema } = await import(
  join(root, "dist", "index.js")
);

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

const schema = z.toJSONSchema(EnvironmentRecordSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
});

schema.$id = ENVIRONMENT_RECORD_SCHEMA_ID;
schema.title = "Jinn environment record";
schema.description =
  "A sealed description of one execution environment: one (source, image, platform, "
  + "invocations, parser) binding. The document asserts what the environment is, never that "
  + "it works — behaviour claims live in separately published verification attestations.";
schema.propertyNames = {
  anyOf: [{ enum: Object.keys(schema.properties ?? {}) }, { pattern: NAMESPACED }],
};
schema.$comment = [
  "Structural validation only. Four checks are runtime-only and are not expressible here:",
  "image.reference must end with @<manifestDigest>;",
  "image.indexDigest, when present, must differ from image.manifestDigest;",
  "build.recipe and build.dependencyPinning are required at reproducibilityTier >= 1;",
  "and the record's bytes must be the exact RFC 8785 canonical encoding of the document.",
].join(" ");

const target = join(root, "schemas", "environment.schema.json");
const text = `${JSON.stringify(schema, null, 2)}\n`;

if (mode === "--write") {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  console.log("schema written");
} else {
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) {
    console.error("published schema is out of date; run `yarn generate:schemas`");
    process.exit(1);
  }
  console.log("schema up to date");
}
```

- [ ] **Step 4: Generate the schema and run the test**

Run: `cd packages/environments/record && yarn generate:schemas && yarn test && yarn typecheck`
Expected: `schema written`; PASS (4 new tests).

> If `z.toJSONSchema` emits `additionalProperties: false` on a nested `strictObject` that must stay open for descriptor hints, post-process it in the generator the way `packages/benchmarking/records/scripts/generate-schemas.mjs` does with `preserveDescriptorHints` — do not weaken the zod schema to make the JSON Schema convenient.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/record
git commit -m "feat(environment-record): publish the record JSON Schema with a standalone-validator parity check"
```

---

### Task 11: The source-boundary guard

**Files:**
- Create: `.github/scripts/environments-source-boundaries.test.mjs`

**Interfaces:**
- Consumes: the finished package.
- Produces: the second leg of the tree's guard trio — the canary that enforces custody law (no ambient network, no filesystem in production source), the frozen-trio ban, the locale ban, and the testing-region split.

The file is a **derivation of `.github/scripts/benchmarking-source-boundaries.test.mjs`**, which already carries every scanner this tree needs. Copy it, then make exactly the substitutions below. Do not re-derive the scanners: their regexes and their self-tests are hard-won, and a fresh implementation would silently lose cases (comment-bearing dynamic imports, computed browser members, template-literal specifiers).

- [ ] **Step 1: Copy the benchmarking guard and rename its tree**

```bash
cp .github/scripts/benchmarking-source-boundaries.test.mjs \
   .github/scripts/environments-source-boundaries.test.mjs
```

Then, in the new file:
- Replace `join(root, 'packages', 'benchmarking')` with `join(root, 'packages', 'environments')`.
- Replace the `benchmarkingDirectories` constant name with `environmentDirectories` (every use), and its value with `['record']`.
- Replace every `jinn-benchmarking-` temp-directory prefix with `jinn-environments-`.
- Replace every occurrence of the word `benchmarking` in assertion messages and comments with `environments`, and every `records/src/order.ts` pointer with `record/src/order.ts`.
- Delete the two marketplace-specific self-tests (`'the marketplace-family wildcard bans any future @jinn-network/marketplace-* package'` and `'marketplace may import binding and projector; other benchmarking packages may not'`) and the `MARKETPLACE_ALLOWED` / `MARKETPLACE_FORBIDDEN_EXTRA` constants: this tree has no marketplace carve-out.
- Keep verbatim: `AMBIENT_NETWORK_APIS`, `ambientNetworkIdentifier`, `ambientNetworkGlobal`, `executableSource`, `LOCALE_SENSITIVE_APIS`, `localeSensitiveMember`, `localeSensitiveIntl`, `localeSensitiveUsesInFiles`, `ambientNetworkUsesInFiles`, `files`, `specifiers`, `inside`, `sourceModuleStem`, `insideForbiddenRoot`, `packageSpecifierMatches`, `forbiddenImportsInFiles`, `forbiddenImports`, `assertBoundary`, and the self-test `'the import scanner catches static, export, dynamic, require, and local-path escapes'` (retitle its temp prefix only).

- [ ] **Step 2: Replace the tree-specific constants**

Replace the whole block of benchmarking-specific constants (`BENCHMARKING_FOREIGN_PACKAGES`, `FORBIDDEN_ROOTS`, and the five `TASK_EXECUTION_SIBLINGS_*` / `*_FORBIDDEN_EXTRA` arrays) with:

```js
// `packages/environments/record` is tier 2: records and meaning, no behaviour. It declares
// ZERO Jinn runtime dependencies (design §3.3: zod + noble-class primitives only), so every
// Jinn package family is forbidden from production source. `@jinn-network/evidence-protocol`
// is a test-only devDependency for the seal-equivalence fixtures (program §5 contract 3) and
// appears in the testing-region allowance below, never in production source.
const ENVIRONMENTS_FOREIGN_PACKAGES = [
  '@jinn-network/autopilot',
  '@jinn-network/benchmarking-*',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-*',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/indexer',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace-*',
  '@jinn-network/plugin',
  '@jinn-network/record-discovery-*',
  '@jinn-network/sdk',
  '@jinn-network/task-execution-*',
  '@jinn-network/trust-*',
];

// A relative-path escape into another tree is caught the same way a package-name ban is —
// `import "../../evidence/protocol/src/index.js"` would otherwise slip past.
const FORBIDDEN_ROOTS = [
  join(root, 'apps'),
  join(root, 'client'),
  ...['autopilot', 'benchmarking', 'core', 'discovery', 'evidence', 'indexer',
    'indexer-enrichment', 'layer', 'marketplace', 'plugin', 'sdk', 'task-execution', 'trust']
    .map((directory) => join(root, 'packages', directory)),
];

// Custody law (program §5 contract 4): the record package is pure. No process spawning, no
// sockets, no database, and no filesystem — with one exception, `src/fixtures.ts`, which
// loads the package's own bundled fixture corpus and belongs to the testing region.
const NODE_IO_MODULES = [
  'node:child_process', 'node:dgram', 'node:dns', 'node:fs', 'node:fs/promises',
  'node:http', 'node:http2', 'node:https', 'node:net', 'node:tls', 'node:worker_threads',
];

const RECORD_ALLOWED_DEPENDENCIES = ['@noble/hashes', 'zod'];
const RECORD_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/evidence-protocol', '@types/node', 'ajv', 'canonicalize', 'typescript', 'vitest',
];
const RECORD_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
```

- [ ] **Step 3: Replace the boundary test body**

Replace the whole `test('benchmarking source boundaries remain one-way across the approved graph', …)` body with:

```js
test('environments source boundaries remain one-way across the approved graph', () => {
  const record = join(packages, 'record');
  const recordSource = join(record, 'src');
  const testingEntry = join(recordSource, 'testing.ts');
  const fixtureLoaders = join(recordSource, 'fixtures.ts');
  const testRegex = /\.test\.[cm]?[jt]sx?$/u;

  const allFiles = files(recordSource);
  const testingFiles = allFiles.filter((file) =>
    file === testingEntry || file === fixtureLoaders || testRegex.test(file));
  const productionFiles = allFiles.filter((file) => !testingFiles.includes(file));

  // Production source: no Jinn package at all, no foreign tree by relative path, no vitest,
  // no I/O module, and no reach into the testing region.
  assert.deepEqual(
    forbiddenImportsInFiles(
      productionFiles,
      [...ENVIRONMENTS_FOREIGN_PACKAGES, ...NODE_IO_MODULES, 'vitest'],
      FORBIDDEN_ROOTS,
    ),
    [],
    'environment-record production source must not import Jinn packages, vitest, or I/O modules',
  );
  assert.deepEqual(
    forbiddenImportsInFiles([join(recordSource, 'index.ts')], [], [testingEntry, fixtureLoaders]),
    [],
    'the root entrypoint must not re-export testing.ts or fixtures.ts',
  );

  // Testing region: the seal-equivalence fixtures may import evidence-protocol and
  // canonicalize; nothing else Jinn, and no other tree by relative path.
  assert.deepEqual(
    forbiddenImportsInFiles(
      testingFiles,
      ENVIRONMENTS_FOREIGN_PACKAGES.filter((entry) => entry !== '@jinn-network/evidence-*'),
      FORBIDDEN_ROOTS,
    ),
    [],
    'environment-record testing files must not cross into foreign package roots',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(testingFiles, ['@jinn-network/evidence-discovery',
      '@jinn-network/evidence-repository', '@jinn-network/evidence-derivation',
      '@jinn-network/evidence-local-runtime', '@jinn-network/evidence-publication']),
    [],
    'only evidence-protocol is admitted into the testing region, for seal equivalence',
  );

  // `node:fs/promises` is permitted in exactly one file.
  const fsUsers = forbiddenImportsInFiles(allFiles, ['node:fs', 'node:fs/promises'])
    .filter((finding) => !finding.startsWith(relative(root, fixtureLoaders)));
  assert.deepEqual(fsUsers, [],
    'only src/fixtures.ts may touch the filesystem, and only to read this package\'s own corpus');

  // Manifest shape.
  const manifest = JSON.parse(readFileSync(join(record, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(),
    ['.', './fixtures/*', './schemas/*', './testing']);
  assert.deepEqual(manifest.exports['.'],
    { import: './dist/index.js', types: './dist/index.d.ts' });
  assert.deepEqual(manifest.exports['./testing'],
    { import: './dist/testing.js', types: './dist/testing.d.ts' });
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), RECORD_ALLOWED_DEPENDENCIES);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), RECORD_ALLOWED_DEV_DEPENDENCIES);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), RECORD_ALLOWED_PEER_DEPENDENCIES);
  assert.deepEqual(manifest.peerDependenciesMeta, { vitest: { optional: true } });
});
```

Ensure `readFileSync` and `relative` are in the file's `node:fs` / `node:path` import lists (the benchmarking original already imports both).

- [ ] **Step 4: Add the bounded-claims canary**

Append this test at the end of the file. It implements program §5 contract 8 mechanically rather than by reviewer vigilance:

```js
// Program §5 contract 8: no API, log line, or doc in this package may say "deterministic" or
// "verified" without the K/controls or trust-policy qualification the design gives those
// words. This package makes NEITHER claim — it describes an environment, it does not assess
// one — so the honest gate here is: the words do not appear as unqualified assertions in
// production source or in the README.
const BOUNDED_CLAIM_WORDS = /\b(deterministic|deterministically|verified|guaranteed|reliable)\b/iu;

test('environments source and docs make no unqualified determinism or verification claim', () => {
  const record = join(packages, 'record');
  const candidates = [
    ...files(join(record, 'src')).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file)),
    join(record, 'README.md'),
  ].filter((file) => existsSync(file));

  const findings = candidates.flatMap((file) => readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (!BOUNDED_CLAIM_WORDS.test(line)) return [];
      // A line is clean when it explicitly bounds the claim: it names the attestation layer
      // that owns it, or negates the claim outright.
      const bounded = /attestation|MUST NOT require|never|not\b|bounded|K consecutive|no claim/iu
        .test(line);
      return bounded ? [] : [`${relative(root, file)}:${index + 1} -> ${line.trim()}`];
    }));

  assert.deepEqual(findings, [],
    'unqualified determinism/verification language: the record asserts what an environment IS, '
    + 'never that it works. Bound the claim or move it to the attestation layer.');
});
```

- [ ] **Step 5: Run the guard**

Run: `node --test .github/scripts/environments-source-boundaries.test.mjs`
Expected: PASS — every self-test plus the boundary, locale, ambient-network, and bounded-claims assertions.

If the bounded-claims canary fires on `README.md` or a JSDoc block written in earlier tasks, **fix the prose, not the canary** — that is the contract working.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/environments-source-boundaries.test.mjs
git commit -m "feat(environment-record): source-boundary, custody, locale, and bounded-claims guards for the environments tree"
```

---

### Task 12: Packed-types canary, pack smoke, and the environments CI workflow

**Files:**
- Create: `.github/scripts/environments-packed-types.test.mjs`, `.github/workflows/environments-ci.yml`
- Create: `packages/environments/record/scripts/pack-smoke.mjs`

**Interfaces:**
- Consumes: the finished package and the two guards from Tasks 1 and 11.
- Produces: the third guard-trio leg and the tree's CI. After this task the tree is safe for C2 and C3 to branch from.

- [ ] **Step 1: Write the pack smoke**

Copy `packages/benchmarking/records/scripts/pack-smoke.mjs` to `packages/environments/record/scripts/pack-smoke.mjs`, then make exactly these changes:

- Replace every `@jinn-network/benchmarking-records` with `@jinn-network/environment-record`, and the temp-directory prefix `jinn-benchmarking-records-` with `jinn-environment-record-`.
- Delete the cross-tree portal packing (this package has **no** Jinn runtime dependency, so the consumer graph needs no `file:` portals — the benchmarking script packs `task-execution-protocol`; there is no equivalent here).
- Set the required-entry list to:

```js
const REQUIRED_ENTRIES = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/testing.js',
  'package/dist/testing.d.ts',
  'package/schemas/environment.schema.json',
  'package/fixtures/environment/imported.json',
  'package/fixtures/environment/imported.sha256',
  'package/fixtures/adversarial-v1/manifest.json',
  'package/README.md',
  'package/package.json',
];
```

- Keep the benchmarking script's other assertions unchanged: no `*.test.*`, `.map`, or `/src/` entries leak into the tarball; the installed package declares **no** `@jinn-network/*` dependency; a root-only consumer installs and imports without `vitest` present.
- Add one assertion, since this package ships a kit behind an optional peer:

```js
if (Object.keys(packageJson.dependencies ?? {}).some((name) => name.startsWith('@jinn-network/'))) {
  throw new Error('the record package must ship with zero Jinn runtime dependencies');
}
if (packageJson.peerDependencies?.vitest !== '^4.1.8'
    || packageJson.peerDependenciesMeta?.vitest?.optional !== true) {
  throw new Error('the ./testing kit must declare vitest as an exact optional peer');
}
```

Run: `cd packages/environments/record && yarn build && yarn pack:smoke`
Expected: PASS — tarball carries dist, schemas, and fixtures; nothing leaks; zero Jinn coupling.

- [ ] **Step 2: Write the packed-types canary**

Copy `.github/scripts/benchmarking-packed-types.test.mjs` to `.github/scripts/environments-packed-types.test.mjs`, then:

- Replace `join(root, 'packages', 'benchmarking')` with `join(root, 'packages', 'environments')` and the temp prefix `jinn-benchmarking-packed-types-` with `jinn-environments-packed-types-`.
- Replace the `packages` roster with:

```js
const packages = [
  ['record', '@jinn-network/environment-record'],
];
```

- Replace the `codeEntrypoints` list with:

```js
const codeEntrypoints = [
  '@jinn-network/environment-record',
  '@jinn-network/environment-record/testing',
];
```

- Replace the `CROSS_TREE_PACKAGES` list with `const CROSS_TREE_PACKAGES = [];` — the record package has no Jinn runtime dependency, so the consumer project needs no packed portals. Keep the loop that consumes the list (an empty list is a no-op).
- Keep the consumer-project generation, the `tsc --noEmit` compile of a file that `import`s each entrypoint under `"moduleResolution": "NodeNext"`, and the assertion that every entrypoint resolves types.

The `./testing` entrypoint's consumer file must install `vitest` (the optional peer) before compiling; the benchmarking script has no kit entrypoint, so add to the consumer's `devDependencies`:

```js
  vitest: '^4.1.8',
```

Run: `node .github/scripts/environments-packed-types.test.mjs`
Expected: PASS — both entrypoints resolve types from the packed tarball.

- [ ] **Step 3: Write the CI workflow**

`.github/workflows/environments-ci.yml`:

```yaml
name: Environments CI

on:
  pull_request:
  push:
    branches: [next]
    paths:
      - "packages/environments/**"
      - ".github/scripts/environments-*.test.mjs"
      - ".github/workflows/environments-ci.yml"
      - "docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md"
      - "docs/superpowers/plans/2026-07-31-supply-c1-environment-record.md"

permissions:
  contents: read

env:
  ENVIRONMENTS_ROOT: packages/environments

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Verify package inventory and dependency graph
        run: node --test .github/scripts/environments-package-inventory.test.mjs
      - name: Verify source boundaries and canaries
        run: node --test .github/scripts/environments-source-boundaries.test.mjs

  record:
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
      - name: Build the seal-equivalence oracle from source (evidence-protocol, test-only)
        run: |
          (cd packages/evidence/protocol && yarn install --immutable && yarn build)
      - name: Verify Environment Record
        working-directory: packages/environments/record
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn check:fixtures
          yarn check:schemas
          yarn pack:smoke
      - name: Upload Environment Record distribution
        uses: actions/upload-artifact@v4
        with:
          name: environments-record-dist
          path: packages/environments/record/dist
          if-no-files-found: error
          retention-days: 1

  verify:
    needs: [architecture, record]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Require every Environments CI stage to succeed
        env:
          ARCHITECTURE_RESULT: ${{ needs.architecture.result }}
          RECORD_RESULT: ${{ needs.record.result }}
        run: |
          for result in \
            "$ARCHITECTURE_RESULT" \
            "$RECORD_RESULT"; do
            test "$result" = "success"
          done
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Enable Yarn 4.13.0
        run: |
          corepack enable
          corepack prepare yarn@4.13.0 --activate
      - name: Restore all package distributions
        uses: actions/download-artifact@v4
        with:
          pattern: environments-*-dist
          path: .environments-dist
      - name: Place package distributions
        run: |
          mkdir -p packages/environments/record/dist
          cp -R .environments-dist/environments-record-dist/. packages/environments/record/dist/
      - name: Compile packed public entrypoint consumers
        run: node .github/scripts/environments-packed-types.test.mjs
```

- [ ] **Step 4: Run the whole guard trio locally**

```bash
node --test .github/scripts/environments-package-inventory.test.mjs
node --test .github/scripts/environments-source-boundaries.test.mjs
node .github/scripts/environments-packed-types.test.mjs
```

Expected: all three PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/environments-packed-types.test.mjs .github/workflows/environments-ci.yml packages/environments/record/scripts/pack-smoke.mjs
git commit -m "feat(environment-record): packed-types canary, pack smoke, and the environments CI workflow"
```

---

### Task 13: The discovery facts leaf

**Files:**
- Create: `packages/discovery/facts/environments/package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`
- Create: `packages/discovery/facts/environments/profiles/environment.1.0.json`
- Create: `packages/discovery/facts/environments/src/identifiers.ts`, `src/profiles.ts`, `src/recompute.ts`, `src/index.ts`, `src/profiles.test.ts`, `src/recompute.test.ts`, `src/facts-conformance.test.ts`

**Interfaces:**
- Consumes, from `integration/evidence-v1` (`@jinn-network/record-discovery-protocol`): `parseFactsProfile`, `assertRecordKindUri`, `recordDigest`, `RECORD_DISCOVERY_VERSION`, `GENESIS_SEQUENCE`, `verifyItem`, and the types `FactsProfileDocument`, `FactsRecompute`, `RecordFactRecompute`, `RecordFactValue`, `ReferencedBytes`, `AnnouncedItem`, `AnnouncementEntry`, `ItemOutcome`, `RecordFetcher`. From `@jinn-network/record-discovery-testing`: `digestOf`, `makeInMemoryPorts`. From `@jinn-network/environment-record` (branch `supply/c1-environment-record`, Task 7): `ENVIRONMENT_RECORD_KIND`, `parseEnvironmentRecord`, `sealEnvironmentRecord`, `environmentRecordDigest`. **Verify each symbol exists before writing the tests**; a missing one is a stop-and-report.
- Produces: `environmentFactsProfile` (the pinned name), `environmentRecompute`, `ENVIRONMENTS_FACTS_RECOMPUTE`, and a re-export of `ENVIRONMENT_RECORD_KIND` validated against discovery's own grammar.

Per the discovery design §12, a per-kind facts profile is a small **leaf package** carrying both edges — `discovery/protocol` and the kind's defining tree — so that discovery never imports a record-defining package and no record package imports discovery. This leaf follows `packages/discovery/facts/benchmarking` exactly.

Facts card, per spec §4.4 — the field names are the design's dotted paths verbatim, so a reader of the profile document and a reader of §4.4 see the same names:

| Field | Class | Reference-bearing | CloudEvents attribute |
| --- | --- | --- | --- |
| `environmentRecordDigest` | record | — | — |
| `source.repo` | record | — | `repo` |
| `source.commit` | record | — | `commit` |
| `image.manifestDigest` | record | **yes** | `image` |
| `image.platform` | record | — | `platform` |
| `build.reproducibilityTier` | record | — | `tier` |

- [ ] **Step 1: Write the failing tests**

`src/profiles.test.ts`:

```ts
import { assertRecordKindUri, referenceBearingFields, cloudEventsFields } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { environmentFactsProfile } from "./profiles.js";

describe("environment facts profile (design §4.4)", () => {
  it("binds the record kind discovery's own grammar accepts", () => {
    expect(() => assertRecordKindUri(ENVIRONMENT_RECORD_KIND)).not.toThrow();
    expect(environmentFactsProfile.kind).toBe(ENVIRONMENT_RECORD_KIND);
    expect(environmentFactsProfile.profile).toBe(`${ENVIRONMENT_RECORD_KIND}/facts/1.0`);
  });

  it("names exactly the fields the design requires", () => {
    expect(environmentFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "build.reproducibilityTier",
      "environmentRecordDigest",
      "image.manifestDigest",
      "image.platform",
      "source.commit",
      "source.repo",
    ]);
  });

  it("declares every field a record fact — an environment record has no substrate facts", () => {
    for (const field of environmentFactsProfile.fields) expect(field.class).toBe("record");
  });

  it("declares image.manifestDigest reference-bearing so referrers inverts it", () => {
    expect(referenceBearingFields(environmentFactsProfile)).toEqual(["image.manifestDigest"]);
  });

  it("lifts the filterable fields into CloudEvents attributes", () => {
    expect(
      cloudEventsFields(environmentFactsProfile).map((field) => [field.name, field.cloudEvents?.attribute]),
    ).toEqual([
      ["source.repo", "repo"],
      ["source.commit", "commit"],
      ["image.manifestDigest", "image"],
      ["image.platform", "platform"],
      ["build.reproducibilityTier", "tier"],
    ]);
  });
});
```

`src/recompute.test.ts`:

```ts
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import { ENVIRONMENT_RECORD_KIND, sealEnvironmentRecord } from "@jinn-network/environment-record";
import { describe, expect, it } from "vitest";

import { ENVIRONMENTS_FACTS_RECOMPUTE, environmentRecompute } from "./recompute.js";

const MANIFEST = `sha256:${"1".repeat(64)}`;

const document = {
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "example-org/example-lib",
    repoUrl: "https://github.com/example-org/example-lib",
    commit: "0".repeat(39) + "1",
  },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
  workspace: "/testbed",
  invocations: { test: [{ bin: "make", args: ["test"] }] },
  parser: { id: "pytest-text", version: "1.0.0", digest: `sha256:${"3".repeat(64)}` },
  build: { reproducibilityTier: 0 },
  rights: { sourceLicense: "Apache-2.0" },
};

const noReferences = { fetch: async () => undefined };

describe("environment record-fact recompute", () => {
  it("recomputes every fact from the record's own sealed bytes", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(await environmentRecompute(bytes, noReferences)).toEqual({
      environmentRecordDigest: recordDigest(bytes),
      "source.repo": "example-org/example-lib",
      "source.commit": "0".repeat(39) + "1",
      "image.manifestDigest": MANIFEST,
      "image.platform": "linux/amd64",
      "build.reproducibilityTier": 0,
    });
  });

  it("emits no facts for bytes that are not an environment record", async () => {
    expect(await environmentRecompute(new TextEncoder().encode('{"a":1}'), noReferences)).toEqual({});
  });

  it("emits no facts for re-canonicalized bytes", async () => {
    const pretty = new TextEncoder().encode(JSON.stringify(document, null, 2));
    expect(await environmentRecompute(pretty, noReferences)).toEqual({});
  });

  it("registers under the environment record kind and nothing else", () => {
    expect(ENVIRONMENTS_FACTS_RECOMPUTE.get(ENVIRONMENT_RECORD_KIND)).toBe(environmentRecompute);
    expect(ENVIRONMENTS_FACTS_RECOMPUTE.get("https://jinn.network/records/benchmark/1.0")).toBeUndefined();
  });
});
```

`src/facts-conformance.test.ts`:

```ts
// Leaf facts-conformance at the public verifyItem / facts-consistency boundary, mirroring
// `packages/discovery/facts/benchmarking/src/facts-conformance.test.ts`: kit `digestOf` +
// `makeInMemoryPorts` supply the AnnouncementEntry chain and the unused keys/sigs stubs,
// while this leaf's own recompute and a byte-exact RecordFetcher are injected at verifyItem.
import { ENVIRONMENT_RECORD_KIND, sealEnvironmentRecord } from "@jinn-network/environment-record";
import {
  GENESIS_SEQUENCE,
  RECORD_DISCOVERY_VERSION,
  recordDigest,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  ItemOutcome,
  RecordFetcher,
} from "@jinn-network/record-discovery-protocol";
import { digestOf, makeInMemoryPorts } from "@jinn-network/record-discovery-testing";
import { describe, expect, it } from "vitest";

import { environmentFactsProfile } from "./profiles.js";
import { ENVIRONMENTS_FACTS_RECOMPUTE } from "./recompute.js";

const SOURCE = { agent: "did:key:zEnvironmentFactsConformance", name: "facts" };
const MANIFEST = `sha256:${"1".repeat(64)}`;

const document = {
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "example-org/example-lib",
    repoUrl: "https://github.com/example-org/example-lib",
    commit: "0".repeat(39) + "1",
  },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
  workspace: "/testbed",
  invocations: { test: [{ bin: "make", args: ["test"] }] },
  parser: { id: "pytest-text", version: "1.0.0", digest: `sha256:${"3".repeat(64)}` },
  build: { reproducibilityTier: 0 },
  rights: { sourceLicense: "Apache-2.0" },
};

async function verify(facts: Record<string, unknown>): Promise<ItemOutcome> {
  const bytes = sealEnvironmentRecord(document);
  const digest = recordDigest(bytes);
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-31T12:00:00Z",
    announcements: [
      { announcementId: "ann-environment", action: "available", record: { kind: ENVIRONMENT_RECORD_KIND, digest } },
    ],
  };
  const entryDigest = digestOf(entry);
  const kitPorts = makeInMemoryPorts({ entries: { [entryDigest]: entry } });

  const records: RecordFetcher = {
    async "fetch"(requested) {
      if (requested === digest) return bytes;
      throw new Error(`no record seeded for ${requested}`);
    },
  };

  const item: AnnouncedItem = {
    record: { kind: ENVIRONMENT_RECORD_KIND, digest },
    facts,
    provenance: { source: SOURCE, entry: entryDigest, announcementId: "ann-environment" },
  };

  return verifyItem({
    item,
    profile: environmentFactsProfile,
    decisionGrade: false,
    ports: {
      records,
      entries: kitPorts.entries,
      keys: kitPorts.keys,
      sigs: kitPorts.sigs,
      factsRecompute: ENVIRONMENTS_FACTS_RECOMPUTE,
      verifiedChain: async () => true,
    },
  });
}

describe("facts/environments leaf conformance via verifyItem", () => {
  it("consistent: a truthful card matches the recomputed facts", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(
      await verify({
        environmentRecordDigest: recordDigest(bytes),
        "source.repo": "example-org/example-lib",
        "source.commit": "0".repeat(39) + "1",
        "image.manifestDigest": MANIFEST,
        "image.platform": "linux/amd64",
        "build.reproducibilityTier": 0,
      }),
    ).toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a card claiming a different image", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(
      await verify({
        environmentRecordDigest: recordDigest(bytes),
        "source.repo": "example-org/example-lib",
        "source.commit": "0".repeat(39) + "1",
        "image.manifestDigest": `sha256:${"9".repeat(64)}`,
        "image.platform": "linux/amd64",
        "build.reproducibilityTier": 0,
      }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card overstating the reproducibility tier", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(
      await verify({
        environmentRecordDigest: recordDigest(bytes),
        "source.repo": "example-org/example-lib",
        "source.commit": "0".repeat(39) + "1",
        "image.manifestDigest": MANIFEST,
        "image.platform": "linux/amd64",
        "build.reproducibilityTier": 2,
      }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/discovery/facts/environments && yarn test`
Expected: FAIL — the package does not exist yet (no `package.json`).

- [ ] **Step 3: Create the leaf scaffold**

`packages/discovery/facts/environments/package.json`:

```json
{
  "name": "@jinn-network/record-discovery-facts-environments",
  "version": "0.1.0",
  "description": "Facts-profile document and record-fact recompute for the Jinn environment record kind.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/discovery/facts/environments"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./profiles/*": "./profiles/*"
  },
  "files": [
    "dist/",
    "profiles/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/environment-record": "0.1.0",
    "@jinn-network/record-discovery-protocol": "0.1.0"
  },
  "devDependencies": {
    "@jinn-network/record-discovery-testing": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/environment-record": "portal:../../../environments/record",
    "@jinn-network/record-discovery-protocol": "portal:../../protocol",
    "@jinn-network/record-discovery-testing": "portal:../../testing",
    "@jinn-network/trust-core": "portal:../../../trust/core"
  }
}
```

> `@jinn-network/trust-core` is a **shadow** devDependency + portal resolution: this leaf never imports it, but `record-discovery-protocol` declares it as an npm dependency, and yarn's per-project resolution for a standalone project requires a matching top-level override. Every protocol-consuming leaf in the tree carries the same entry (see the inventory guard's comments for `testing`, `serve`, `client`, `facts/*`).

`tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, and `scripts/build.mjs`: copy verbatim from `packages/discovery/facts/benchmarking/` (they contain no package-specific content).

`README.md`:

```markdown
# @jinn-network/record-discovery-facts-environments

The record-discovery facts profile for the environment record kind, plus the recompute
function a consumer runs to re-derive that card from the record's own sealed bytes.

The card carries `source.repo`, `source.commit`, `image.manifestDigest`, `image.platform`,
and `build.reproducibilityTier`, alongside the record's own digest. `image.manifestDigest`
is declared reference-bearing so discovery's `referrers` relation inverts it: "find the
environment records about image `sha256:X`" is a first-class query.

Announcements confer no validity. A card is a filter-before-fetch hint; every decision-grade
use requires the fetched, digest-checked record.
```

- [ ] **Step 4: Write the profile document and the source**

`profiles/environment.1.0.json`:

```json
{
  "protocol": "https://jinn.network/record-discovery/1.0",
  "kind": "https://jinn.network/records/environment/1.0",
  "profile": "https://jinn.network/records/environment/1.0/facts/1.0",
  "fields": [
    { "name": "environmentRecordDigest", "class": "record" },
    { "name": "source.repo", "class": "record", "cloudEvents": { "attribute": "repo", "scalar": "string" } },
    { "name": "source.commit", "class": "record", "cloudEvents": { "attribute": "commit", "scalar": "string" } },
    { "name": "image.manifestDigest", "class": "record", "referenceBearing": true, "cloudEvents": { "attribute": "image", "scalar": "string" } },
    { "name": "image.platform", "class": "record", "cloudEvents": { "attribute": "platform", "scalar": "string" } },
    { "name": "build.reproducibilityTier", "class": "record", "cloudEvents": { "attribute": "tier", "scalar": "number" } }
  ]
}
```

`src/identifiers.ts`:

```ts
import { ENVIRONMENT_RECORD_KIND } from "@jinn-network/environment-record";
import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";

// Validate the record package's own constant against discovery's authoritative record-kind
// grammar. The record package is tier 2 with zero Jinn dependencies, so it cannot perform
// this check itself; the leaf carries both edges and is the right place for it. The leaf
// never hardcodes a second copy of the string.
assertRecordKindUri(ENVIRONMENT_RECORD_KIND);

export { ENVIRONMENT_RECORD_KIND };
```

`src/profiles.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// Declarative field labeling only, loaded from the bundled `profiles/*.json` and parsed
// (and record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  return parseFactsProfile(
    JSON.parse(readFileSync(fileURLToPath(new URL(filename, profilesRoot)), "utf8")),
  );
}

export const environmentFactsProfile: FactsProfileDocument = loadProfile("environment.1.0.json");
```

`src/recompute.ts`:

```ts
import { parseEnvironmentRecord } from "@jinn-network/environment-record";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
} from "@jinn-network/record-discovery-protocol";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";

/**
 * Recomputes the environment card from the record's own sealed BYTES — never from a supplied
 * projection. `parseEnvironmentRecord` requires the exact canonical encoding, so a card
 * attached to re-serialized bytes recomputes to nothing and reads as inconsistent.
 *
 * Every field here is native: it is read out of this record's own bytes. `image.manifestDigest`
 * is declared *reference-bearing* in the profile so discovery's `referrers` relation inverts
 * it — but an OCI image is not an announceable record, so there are no referenced bytes to
 * fetch, re-hash, and parse. The fail-closed `ReferencedBytes` path that record-to-record
 * digests use (see `facts/benchmarking`) therefore does not apply, and the field is emitted
 * directly. Reference-bearing labels an indexing relation; it does not by itself imply a
 * fetchable record.
 */
export const environmentRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseEnvironmentRecord(bytes);
    const facts: Record<string, RecordFactValue> = {
      environmentRecordDigest: recordDigest(bytes),
      "source.repo": record.source.repo,
      "source.commit": record.source.commit,
      "image.manifestDigest": record.image.manifestDigest,
      "image.platform": record.image.platform,
      "build.reproducibilityTier": record.build.reproducibilityTier,
    };
    return facts;
  } catch {
    return {};
  }
};

/**
 * The leaf's `FactsRecompute` registry entry: the host assembles the tree-wide registry by
 * merging each leaf's export. Unknown kinds return `undefined`, preserving discovery's
 * unknown-kind skip behaviour.
 */
export const ENVIRONMENTS_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    return kind === ENVIRONMENT_RECORD_KIND ? environmentRecompute : undefined;
  },
};
```

`src/index.ts`:

```ts
// Public surface of @jinn-network/record-discovery-facts-environments.

export * from "./identifiers.js";
export * from "./profiles.js";
export * from "./recompute.js";
```

- [ ] **Step 5: Write the pack smoke**

Copy `packages/discovery/facts/benchmarking/scripts/pack-smoke.mjs` to `packages/discovery/facts/environments/scripts/pack-smoke.mjs`, then substitute:
- every `record-discovery-facts-benchmarking` → `record-discovery-facts-environments`;
- the `benchmarkingRecordsRoot` / `benchmarkingRecordsArchive` pair → `environmentRecordRoot` = `join(packageRoot, "..", "..", "..", "environments", "record")` and `environmentRecordArchive`, packed under the dependency name `@jinn-network/environment-record`;
- delete the `taskExecutionProtocolRoot` / `taskExecutionProtocolArchive` pair and its `packPortal` call — `@jinn-network/environment-record` has no Jinn dependency of its own;
- set `expectedJinnDependencies` to `["@jinn-network/environment-record", "@jinn-network/record-discovery-protocol"]`.

- [ ] **Step 6: Install, build the portals, and run the tests**

```bash
(cd packages/trust/core && yarn install --immutable && yarn build)
(cd packages/discovery/protocol && yarn install --immutable && yarn build)
(cd packages/discovery/testing && yarn install --immutable && yarn build)
(cd packages/environments/record && yarn install --immutable && yarn build)
cd packages/discovery/facts/environments && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
```

Expected: PASS (12 leaf tests); pack smoke green with exactly two Jinn dependencies.

- [ ] **Step 7: Commit**

```bash
git add packages/discovery/facts/environments
git commit -m "feat(record-discovery-facts-environments): the environment kind's discovery facts leaf"
```

---

### Task 14: Register the leaf with the record-discovery guards and CI, then verify the whole component

**Files:**
- Modify: `.github/scripts/record-discovery-package-inventory.test.mjs`, `.github/scripts/record-discovery-source-boundaries.test.mjs`, `.github/scripts/record-discovery-packed-types.test.mjs`, `.github/workflows/record-discovery-ci.yml`

**Interfaces:**
- Consumes: the leaf from Task 13.
- Produces: green guards and CI for both packages; the component is ready for its review gate, and C2/C3 may branch.

The leaf lives in the record-discovery tree, so it registers with **that** tree's guard trio — this is contract 9 (guards ship with the packages) applied across a tree boundary, not a second owner.

- [ ] **Step 1: Register in the inventory guard so it fails**

In `.github/scripts/record-discovery-package-inventory.test.mjs`:

Add to `DISCOVERY_PACKAGES`, after the `facts/benchmarking` entry:

```js
  ['facts/environments', '@jinn-network/record-discovery-facts-environments'],
```

Add to `SIBLING_TREE_DIRS`:

```js
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
```

Add to `JINN_DEPENDENCY_GRAPH`, after the `facts/benchmarking` entry:

```js
  // facts/environments carries the one sanctioned edge between the discovery tree and the
  // environments record-kind tree (discovery design §12; supply design §3.3): protocol +
  // environment-record. It takes record-discovery-testing as a devDependency (the
  // facts-consistency conformance driver) plus the same shadow trust-core portal resolution
  // every protocol-consuming leaf needs for yarn's per-project resolution of protocol's
  // transitive trust-core dependency. environment-record has no Jinn dependency of its own,
  // so unlike facts/benchmarking this leaf needs no second shadow entry.
  ['facts/environments', { dependencies: ['@jinn-network/environment-record', '@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
```

Run: `node --test .github/scripts/record-discovery-package-inventory.test.mjs`
Expected: PASS (the package already exists from Task 13; if it FAILs, the manifest and the graph disagree — fix the manifest, not the graph).

- [ ] **Step 2: Register in the source-boundary guard**

In `.github/scripts/record-discovery-source-boundaries.test.mjs`:

Add `'facts/environments'` to the `discoveryDirectories` array.

Add the leaf's forbidden list beside the other `FACTS_*_FORBIDDEN_PACKAGES` blocks:

```js
// facts/environments carries the one sanctioned edge between the discovery tree and the
// environments record-kind tree (discovery design §12): protocol + environment-record are
// allowed; no serve/client, no other facts/* leaf, no TEP, no evidence, no benchmarking.
const FACTS_ENVIRONMENTS_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/benchmarking-records',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
];
```

Add the matching `assertBoundary` call inside the tree's one-way boundary test, alongside the other leaves:

```js
  assertBoundary(join(packages, 'facts', 'environments', 'src'), FACTS_ENVIRONMENTS_FORBIDDEN_PACKAGES);
```

Add every other leaf's ban on this one: extend each existing `FACTS_*_FORBIDDEN_PACKAGES`, `CLIENT_FORBIDDEN_PACKAGES`, `SERVE_FORBIDDEN_PACKAGES`, and `TESTING_FORBIDDEN_PACKAGES` array with:

```js
  '@jinn-network/record-discovery-facts-environments',
```

and extend `PROTOCOL_FORBIDDEN_PACKAGES` and `TESTING_FORBIDDEN_PACKAGES` with `'@jinn-network/environment-record'` — protocol and the kit stay kind-agnostic.

Run: `node --test .github/scripts/record-discovery-source-boundaries.test.mjs`
Expected: PASS.

- [ ] **Step 3: Register in the packed-types canary**

In `.github/scripts/record-discovery-packed-types.test.mjs`:

Add to `packages`:

```js
  ['facts/environments', '@jinn-network/record-discovery-facts-environments'],
```

Add to `codeEntrypoints`:

```js
  '@jinn-network/record-discovery-facts-environments',
```

Add to `CROSS_TREE_PACKAGES`:

```js
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
```

Run: `node .github/scripts/record-discovery-packed-types.test.mjs`
Expected: PASS.

- [ ] **Step 4: Wire the leaf into record-discovery CI**

In `.github/workflows/record-discovery-ci.yml`:

Add the design and plan documents to the `push` path filter:

```yaml
      - 'docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md'
      - 'docs/superpowers/plans/2026-07-31-supply-c1-environment-record.md'
```

Add the job, modelled on `facts-benchmarking` (lines 317–365) with `environment-record` as its only record-kind-tree portal:

```yaml
  facts-environments:
    needs: [foundation, testing]
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
      - name: Build cross-tree portal dependencies from source (trust-core, environment-record)
        run: |
          (cd packages/trust/core && yarn install --immutable && yarn build)
          (cd packages/environments/record && yarn install --immutable && yarn build)
      - name: Restore Record Discovery Protocol distribution
        uses: actions/download-artifact@v4
        with:
          name: record-discovery-protocol-dist
          path: packages/discovery/protocol/dist
      - name: Restore Record Discovery Testing distribution
        uses: actions/download-artifact@v4
        with:
          name: record-discovery-testing-dist
          path: packages/discovery/testing/dist
      - name: Install Record Discovery Protocol toolchain (packed-smoke dependency)
        working-directory: packages/discovery/protocol
        run: yarn install --immutable
      - name: Install Record Discovery Testing toolchain (packed-smoke dependency)
        working-directory: packages/discovery/testing
        run: yarn install --immutable
      - name: Verify Record Discovery Facts (Environments)
        working-directory: packages/discovery/facts/environments
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
      - name: Upload Record Discovery Facts (Environments) distribution
        uses: actions/upload-artifact@v4
        with:
          name: record-discovery-facts-environments-dist
          path: packages/discovery/facts/environments/dist
          if-no-files-found: error
          retention-days: 1
```

In the `verify` job:
- add `facts-environments` to `needs`;
- add `FACTS_ENVIRONMENTS_RESULT: ${{ needs.facts-environments.result }}` to the env block and `"$FACTS_ENVIRONMENTS_RESULT" \` to the result loop;
- add `[facts-environments]=facts/environments` to the `declare -A target` map in "Place package distributions";
- add `(cd packages/environments/record && yarn install --immutable && yarn build)` to the verify job's "Build cross-tree portal dependencies from source" step.

- [ ] **Step 5: Run the complete local verification**

From the repository root:

```bash
# Cross-tree portals both packages need
(cd packages/evidence/protocol && yarn install --immutable && yarn build)
(cd packages/trust/core && yarn install --immutable && yarn build)
(cd packages/discovery/protocol && yarn install --immutable && yarn build)
(cd packages/discovery/testing && yarn install --immutable && yarn build)

# The record package
(cd packages/environments/record && yarn install --immutable && yarn typecheck && yarn test \
  && yarn build && yarn check:fixtures && yarn check:schemas && yarn pack:smoke)

# The facts leaf
(cd packages/discovery/facts/environments && yarn install --immutable && yarn typecheck \
  && yarn test && yarn build && yarn pack:smoke)

# Both guard trios
node --test .github/scripts/environments-package-inventory.test.mjs
node --test .github/scripts/environments-source-boundaries.test.mjs
node .github/scripts/environments-packed-types.test.mjs
node --test .github/scripts/record-discovery-package-inventory.test.mjs
node --test .github/scripts/record-discovery-source-boundaries.test.mjs
node .github/scripts/record-discovery-packed-types.test.mjs
```

Expected: every command PASS, with the output shown in the completion report (program §5 contract 10 — no completion claim without the evidence).

- [ ] **Step 6: Confirm the pinned interface one last time**

```bash
grep -n "ENVIRONMENT_RECORD_KIND\|ENVIRONMENT_RECORD_MEDIA_TYPE\|CommandSpecSchema\|sealEnvironmentRecord\|parseEnvironmentRecord\|environmentRecordDigest" packages/environments/record/src/index.ts
grep -n "environmentFactsProfile" packages/discovery/facts/environments/src/profiles.ts
```

Expected: all six record-package names exported from `src/index.ts`, and `environmentFactsProfile` exported from the leaf. Any missing or renamed symbol is a program-plan amendment, not a local fix — stop and report.

- [ ] **Step 7: Commit and open the stacked PR**

```bash
git add .github
git commit -m "feat(record-discovery-facts-environments): register the leaf with the discovery guards and CI"
git push -u origin supply/c1-environment-record
gh pr create --base integration/evidence-v1 --head supply/c1-environment-record \
  --title "feat(environment-record): the environment record kind, its kit, and the environments tree" \
  --body "Component C1 of the verified-environment supply program. Plan: docs/superpowers/plans/2026-07-31-supply-c1-environment-record.md. Design: docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md §4."
```

---

## Component review gate

Before C2 or C3 branch from this package, one independent high-effort review checks it against the design (spec §4, §10, §11 and the program's cross-plan contracts), covering:

- **§4.2 field coverage** — every field in the design's JSONC block is present with the design's semantics, and nothing extra is invented.
- **The image-identity rules** — whether the two structural invariants (`reference` suffix, `indexDigest ≠ manifestDigest`) are the strongest checks available at the record layer, and whether Finding F1 below states the residue honestly.
- **Shell-freedom** — whether the interpreter and metacharacter bans are a real barrier or a false comfort, and whether the JSDoc bounds the claim correctly (it is a document guard, not a sandbox).
- **Sealing equivalence** — whether the two oracles (evidence-protocol digest, RFC 8785 reference implementation) actually prove what contract 3 asks for, and whether any runtime path could reach shared sealing code.
- **Digest confusion** — whether the kit's four-way confusion block is sufficient for C2's subject builder to be checked against.
- **Bounded claims** — whether the canary in Task 11 catches the language it should, and whether the README and JSDoc survive an adversarial read for overclaiming.
- **The facts leaf** — whether declaring a non-fetchable field reference-bearing is sound, and whether the dotted field names are the right call against the benchmarking leaf's camelCase precedent.

Findings are resolved before dependents build.

## Findings this plan carries into the component review

Per program §5 contract 1: a design defect discovered at planning time is a finding with a proposed disposition, never a silent patch. Each of these is planned in its **non-conflicting interpretation**; none of them changes the spec unilaterally.

**F1 — "index digest passed as manifest digest" is not fully detectable at the record layer.**
Spec §4.5 lists it as an adversarial fixture the record kind must reject. An OCI index digest and a platform manifest digest are both 32-byte SHA-256 values with no structural difference, so a record whose `manifestDigest` holds *some other* index's digest is indistinguishable from a correct record until something resolves it against a registry. This plan enforces the two checks that *are* structural — `image.indexDigest`, when present, MUST differ from `image.manifestDigest`, and `image.reference` MUST end with `@<manifestDigest>` — and the `index-digest-as-manifest` fixture exercises the first. *Proposed disposition:* amend §4.5 to name the fixture as covering the self-referential confusion case, and record the general case as a verification-time observation belonging to C2's protocol step 1 (`error/acquire` when the pulled artifact is an index rather than a platform manifest). Raise at the component review; do not patch the spec here.

**F2 — the pinned `sealEnvironmentRecord(record): Uint8Array` diverges from the house `SealedRecord` shape.**
Every other sealed-record package in the stack (`benchmarking/records`, the trajectory-record plan) returns `{bytes, digest}`. The program plan §4 pins bytes only. This plan honours the pinned signature exactly and makes `environmentRecordDigest(bytes)` the single way to obtain identity — which is arguably the better shape (one digest function, no chance of a caller trusting a stale `digest` field beside mutated bytes). *Proposed disposition:* keep the pinned signature; note the deliberate divergence in the program plan's §4 so C2/C3/C4 planners do not "fix" it back. No spec change needed.

**F3 — `bareHexDigest` is an addition beyond the pinned export list.**
Program §4 pins C2 to a "subject builder emitting **bare-hex** DigestSet values", and contract 6 requires the confusion fixture in every producing package's kit. Both need one conversion primitive, and the record package is where the record digest is minted. This plan exports `bareHexDigest(digest: \`sha256:${string}\`): string`, which refuses an already-bare input rather than passing it through. *Proposed disposition:* record it in the program plan §4 under C1 produces, so C2 consumes a named symbol rather than slicing strings. Additive; no pinned name changes.

**F4 — `CommandSpec`'s fourth field is `env` here and `environment` in the legacy shape.**
The legacy in-repo `CommandSpecSchema` (`client/src/task-creator/environment/contracts.ts:47`) spells it `environment`; program §4 pins `env`. This plan follows the program plan. C4's import strategy, which reads legacy-shaped rows, must rename rather than pass through. *Proposed disposition:* no change — flagged so C4's planner treats it as a mapping step, not a copy.

**F5 — shell-freedom is enforced structurally, and the claim must stay bounded.**
`CommandSpecSchema` refuses shell-interpreter basenames and shell metacharacters. That makes "no shell interpolation, ever" (§4.2) a checkable document property. It is **not** containment: a record can still name a binary that does anything at all, and solve-time and evaluation-time sandboxing remain the executor's and evaluator's concerns (§7.3). The JSDoc says so explicitly and the bounded-claims canary guards the language. *Proposed disposition:* none — recorded so a reviewer does not read the schema as a safety guarantee.

**F6 — the facts leaf declares a reference-bearing field with no fetchable referent.**
Spec §4.4 requires `image.manifestDigest` to be reference-bearing so `referrers` inverts it. Discovery's fail-closed recompute pattern (`facts/benchmarking`) assumes a reference-bearing digest points at another *announceable record* whose bytes can be fetched, re-hashed, and parsed. An OCI image is not such a record. This plan emits the field as a native fact from the record's own bytes and documents why the fail-closed path does not apply. *Proposed disposition:* record in the discovery design §12 that `referenceBearing` labels an indexing relation and does not by itself imply a fetchable record; raise at the component review so the discovery owner rules rather than this plan assuming. Planned behaviour is the non-conflicting reading — the field is recomputed truthfully either way.

**F7 — the facts card uses the design's dotted field names, against the tree's camelCase precedent.**
`facts/benchmarking` uses flat camelCase card keys (`benchmarkDigest`); spec §4.4 names dotted paths (`source.repo`, `image.manifestDigest`). This plan uses the dotted names verbatim so the profile document and the design read identically, and because they are unambiguous about which record field each fact came from. *Proposed disposition:* reviewer's call at the component gate; changing it is a one-line edit to the profile JSON plus its recompute keys, with no consumer on the branch yet.

**F8 — spec §4.1 says storage is via the evidence repository's `putArtifact`; this package stores nothing.**
`putArtifact(bytes)` (`packages/evidence/repository/src/types.ts:53`) is digest-addressed and family-less, so an environment record rides it without touching the closed `EVIDENCE_RECORD_FAMILIES` (`types.ts:1-5`) — exactly as §4.1 intends. But calling it is a *host* concern: this package is pure and holds no ports (contract 4), so the `putArtifact` call belongs to C2's verification capability and to the tier-4 composition, not here. *Proposed disposition:* none — recorded so the component review does not read the absence of a store as a missed requirement, and so C2's plan owns the call.
