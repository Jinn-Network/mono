# C1 — Trajectory Record Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship `@jinn-network/evidence-trajectory` — the sealed, tier-2 Trajectory record kind that gives agent execution traces a portable, verifiable structure, so a consumer can read *what happened inside* an execution without parsing a harness-specific transcript.

**Architecture:** the record is an OpenTelemetry-shaped span list under a Jinn-owned vocabulary profile, wrapped in the stack's sealed-record discipline (I-JSON → JCS-once → sha256 identity). Its defining property: **the record is a pure function of `(source native-trace digest, decoder identity, vocabulary profile)`** — no wall clock, no randomness, and every span id is *derived* from those inputs. Two producers decoding the same trace with the same decoder produce byte-identical records, and any consumer can recompute every identifier in the record from the record itself, so fabricated spans over a real trace digest fail validation.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:` resolution); zod 4.4.3; `@noble/hashes`; vitest 4.

## Global constraints

- Branch target: `integration/evidence-v1`; stacked PRs, no self-merge.
- Package is **tier 2**: records and meaning, no behavior. It must **name no product** — the identifiers `plugin`, `jinn-plugin`, `operator`, `autopilot` must not appear in source, exports, or dependencies. Harness/format names are permitted as *format identities* only.
- Node `>=22`; package `"type": "module"`; every relative import carries the `.js` extension.
- **No `localeCompare`, no `Intl`** in production source — the evidence tree canary at `.github/scripts/evidence-source-boundaries.test.mjs` fails the build. Use `compareCodeUnitStrings`.
- **Sealing is re-implemented locally**, per the stack's per-package sealing rule; cross-package equivalence is proven by fixtures, not by sharing code.
- No ambient network (`fetch`, `node:http`, …), no `node:fs` in production source. `node:fs/promises` is permitted **only** in the `./testing` entrypoint's fixture loaders.
- The root entrypoint (`src/index.ts`) must never re-export `testing.ts` or `testing-fixtures.ts`.
- Every task ends with `yarn typecheck && yarn test` in the package plus the guard scripts, outputs shown.

---

## File structure

All paths relative to `packages/evidence/trajectory/`.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `README.md` | package scaffold |
| `src/order.ts` | `compareCodeUnitStrings` — the locale-free ordering primitive |
| `src/canonical.ts` | I-JSON assertions + RFC 8785 JCS serializer |
| `src/hashing.ts` | `sha256Hex`, `documentDigest` |
| `src/sealing.ts` | `SealedRecord`, `sealRecord`, `sealWithSchema`, `parseExactWithSchema`, `InvalidDocumentError` |
| `src/extensions.ts` | `topLevelRecordSchema` — namespaced-extension-key discipline |
| `src/identifiers.ts` | protocol URI, record-kind URI, media type, vocabulary profile URI |
| `src/vocabulary.ts` | the pinned attribute-key vocabulary + its upstream citation |
| `src/identity.ts` | `deriveTraceId`, `deriveSpanId` — the deterministic identifier rules |
| `src/span.ts` | the OTLP-JSON span subset schema |
| `src/schema.ts` | `TrajectoryRecordSchema` + cross-field invariants; `parseTrajectory`, `sealTrajectory` |
| `src/fixtures.ts` | golden/adversarial fixture loaders |
| `src/index.ts` | public surface |
| `src/testing.ts` | `describeTrajectoryRecordConformance` (the kit) |
| `fixtures/trajectory/*` | golden `valid`/`minimal` + `.sha256` pins; `invalid-*.json` |
| `fixtures/equivalence/*` | key-permuted twins + expected digest |
| `fixtures/adversarial-v1/*` | adversarial corpus + `manifest.json` |
| `schemas/trajectory.schema.json` | published JSON Schema (generated) |
| `scripts/generate-schemas.mjs`, `scripts/pack-smoke.mjs` | schema generation/check; tarball smoke |

Repo files this plan also edits: `.github/scripts/evidence-package-inventory.test.mjs`, `.github/scripts/evidence-source-boundaries.test.mjs`, `.github/scripts/evidence-packed-types.test.mjs`, `.github/workflows/evidence-ci.yml`.

---

### Task 1: Scaffold the package and register it with the guard trio

**Files:**
- Create: `packages/evidence/trajectory/package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `README.md`, `src/index.ts`
- Modify: `.github/scripts/evidence-package-inventory.test.mjs:12-27` (roster), `:29-63` (graph), `:95` (count)
- Modify: `.github/scripts/evidence-source-boundaries.test.mjs:9-14` (directories)
- Modify: `.github/scripts/evidence-packed-types.test.mjs:13-28` (packages), `:30-58` (entrypoints)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the package directory `packages/evidence/trajectory` publishing `@jinn-network/evidence-trajectory` with exports `.` and `./testing`; every later task adds files under `src/`.

- [x] **Step 1: Register the package in the inventory guard so it fails**

In `.github/scripts/evidence-package-inventory.test.mjs`, add to the `EVIDENCE_PACKAGES` array (after the `contribution` entry, line 26):

```js
  ['trajectory', '@jinn-network/evidence-trajectory'],
```

Change the count assertion at line 95 from `14` to `15`, and its test name from `'the evidence package inventory is explicit and has fourteen manifests'` to `'... has fifteen manifests'`.

Add to `JINN_DEPENDENCY_GRAPH` (after the `contribution` entry):

```js
  ['trajectory', {
    dependencies: ['@jinn-network/evidence-protocol'],
    devDependencies: [],
    optionalDependencies: [],
    peerDependencies: [],
  }],
```

In the "testing entrypoints declare Vitest as an exact optional peer" test (line 138), extend the directory array to `['derivation', 'retrieval', 'trajectory']`.

- [x] **Step 2: Run the guard to verify it fails**

Run: `node --test .github/scripts/evidence-package-inventory.test.mjs`
Expected: FAIL — cannot read `packages/evidence/trajectory/package.json` (ENOENT).

- [x] **Step 3: Create the package scaffold**

`packages/evidence/trajectory/package.json`:

```json
{
  "name": "@jinn-network/evidence-trajectory",
  "version": "0.1.0",
  "description": "Sealed Trajectory record kind — portable, verifiable agent execution spans.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/evidence/trajectory"
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
    "access": "public",
    "provenance": true
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "generate:schemas": "yarn build && node scripts/generate-schemas.mjs --write",
    "check:schemas": "yarn build && node scripts/generate-schemas.mjs --check",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/evidence-protocol": "0.1.0",
    "@noble/hashes": "2.2.0",
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
    "@types/node": "^22.0.0",
    "ajv": "8.17.1",
    "canonicalize": "3.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/evidence-protocol": "portal:../protocol",
    "vite": "6.4.3"
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
*.tgz
```

`src/index.ts` (placeholder, replaced in Task 8):

```ts
// SPDX-License-Identifier: Apache-2.0

export {};
```

`README.md`:

```markdown
# @jinn-network/evidence-trajectory

The sealed Trajectory record kind: a portable, verifiable structure for what happened
inside an agent execution.

A Trajectory record is a list of OpenTelemetry-shaped spans under a Jinn-owned vocabulary
profile, derived from a digest-bound native trace by a named decoder. The record is a pure
function of its inputs — no wall clock, no randomness — so the same trace decoded by the
same decoder version always produces the same bytes and the same digest.

Every identifier in the record is derived from the record's own declared inputs, so a
consumer can recompute them and detect fabricated spans without holding the source bytes.

See `../../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §7.2.
```

- [x] **Step 4: Install and re-run the inventory guard**

Run: `cd packages/evidence/trajectory && yarn install && cd - && node --test .github/scripts/evidence-package-inventory.test.mjs`
Expected: PASS (15 manifests; dependency graph and portal resolutions match).

- [x] **Step 5: Register in the remaining two guards**

In `.github/scripts/evidence-source-boundaries.test.mjs`, add `'trajectory'` to the `evidenceDirectories` array (lines 9–14).

In `.github/scripts/evidence-packed-types.test.mjs`, add to `packages`:

```js
  ['trajectory', '@jinn-network/evidence-trajectory'],
```

and to `codeEntrypoints`:

```js
  '@jinn-network/evidence-trajectory',
  '@jinn-network/evidence-trajectory/testing',
```

- [x] **Step 6: Verify typecheck and the boundary guard pass**

Run: `cd packages/evidence/trajectory && yarn typecheck && cd - && node --test .github/scripts/evidence-source-boundaries.test.mjs`
Expected: both PASS. (The package has no forbidden imports yet; its dedicated boundary block lands in Task 12.)

- [x] **Step 7: Commit**

```bash
git add packages/evidence/trajectory .github/scripts/evidence-package-inventory.test.mjs .github/scripts/evidence-source-boundaries.test.mjs .github/scripts/evidence-packed-types.test.mjs
git commit -m "feat(evidence-trajectory): scaffold the trajectory record package and register its guards"
```

---

### Task 2: Locale-free ordering and canonical JSON

**Files:**
- Create: `packages/evidence/trajectory/src/order.ts`, `src/canonical.ts`, `src/canonical.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `compareCodeUnitStrings(left: string, right: string): number`; `serializeCanonicalJson(value: JsonValue): Uint8Array`; `type JsonValue`; error classes `NonIJsonNumberError`, `NonIJsonStringError`, `UndefinedArrayElementError`.

- [x] **Step 1: Write the failing test**

`src/canonical.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { compareCodeUnitStrings } from "./order.js";
import {
  NonIJsonNumberError,
  NonIJsonStringError,
  UndefinedArrayElementError,
  serializeCanonicalJson,
} from "./canonical.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("canonical JSON", () => {
  test("orders object keys by UTF-16 code unit, not by locale", () => {
    const bytes = serializeCanonicalJson({ b: 1, a: 2, "ä": 3, Z: 4 });
    expect(text(bytes)).toBe('{"Z":4,"a":2,"b":1,"ä":3}');
  });

  test("key-permuted twins serialize to identical bytes", () => {
    const one = serializeCanonicalJson({ alpha: [1, 2], beta: { x: true, y: null } });
    const two = serializeCanonicalJson({ beta: { y: null, x: true }, alpha: [1, 2] });
    expect(text(one)).toBe(text(two));
  });

  test("skips undefined members but rejects undefined array elements", () => {
    expect(text(serializeCanonicalJson({ a: 1, b: undefined }))).toBe('{"a":1}');
    expect(() => serializeCanonicalJson({ a: [1, undefined] })).toThrow(
      UndefinedArrayElementError,
    );
  });

  test("rejects non-I-JSON numbers", () => {
    expect(() => serializeCanonicalJson({ a: Number.NaN })).toThrow(NonIJsonNumberError);
    expect(() => serializeCanonicalJson({ a: 1.5 })).toThrow(NonIJsonNumberError);
    expect(() => serializeCanonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      NonIJsonNumberError,
    );
  });

  test("rejects lone surrogates", () => {
    expect(() => serializeCanonicalJson({ a: "\ud800" })).toThrow(NonIJsonStringError);
  });

  test("compareCodeUnitStrings is a total order without locale sensitivity", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./order.js"`.

- [x] **Step 3: Write the implementation**

`src/order.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * Compares by UTF-16 code unit. `localeCompare` and `Intl` are banned in production source
 * under `packages/evidence/`; see `.github/scripts/evidence-source-boundaries.test.mjs`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
```

`src/canonical.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "./order.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export class NonIJsonNumberError extends Error {
  readonly category = "non-ijson-number" as const;
  constructor(readonly value: number) {
    super(`number ${String(value)} is not an I-JSON safe integer`);
    this.name = "NonIJsonNumberError";
  }
}

export class NonIJsonStringError extends Error {
  readonly category = "non-ijson-string" as const;
  constructor(readonly value: string) {
    super("string contains an unpaired surrogate");
    this.name = "NonIJsonStringError";
  }
}

export class UndefinedArrayElementError extends Error {
  readonly category = "undefined-array-element" as const;
  constructor() {
    super("array elements must not be undefined");
    this.name = "UndefinedArrayElementError";
  }
}

function assertIJsonNumber(value: number): void {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new NonIJsonNumberError(value);
  }
}

function assertIJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new NonIJsonStringError(value);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new NonIJsonStringError(value);
    }
  }
}

function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    assertIJsonNumber(value);
    return String(value);
  }
  if (typeof value === "string") {
    assertIJsonString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((element) => {
      if (element === undefined) throw new UndefinedArrayElementError();
      return serialize(element as JsonValue);
    });
    return `[${parts.join(",")}]`;
  }
  const source = value as { readonly [key: string]: JsonValue | undefined };
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort(compareCodeUnitStrings);
  const members = keys.map((key) => {
    assertIJsonString(key);
    return `${JSON.stringify(key)}:${serialize(source[key] as JsonValue)}`;
  });
  return `{${members.join(",")}}`;
}

const encoder = new TextEncoder();

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the document forever. */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(value));
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): locale-free ordering and RFC 8785 canonical JSON"
```

---

### Task 3: Digest and sealing primitives

**Files:**
- Create: `packages/evidence/trajectory/src/hashing.ts`, `src/sealing.ts`, `src/sealing.test.ts`

**Interfaces:**
- Consumes: `serializeCanonicalJson`, `JsonValue` (Task 2).
- Produces: `sha256Hex(bytes: Uint8Array): string`; `documentDigest(bytes: Uint8Array): \`sha256:${string}\``; `interface SealedRecord { bytes: Uint8Array; digest: \`sha256:${string}\` }`; `sealRecord(value: JsonValue): SealedRecord`; `sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): SealedRecord`; `parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T`; `class InvalidDocumentError`; `interface ValidationIssue { path: string; message: string }`.

- [x] **Step 1: Write the failing test**

`src/sealing.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { documentDigest, sha256Hex } from "./hashing.js";
import {
  InvalidDocumentError,
  parseExactWithSchema,
  sealRecord,
  sealWithSchema,
} from "./sealing.js";

const Example = z.strictObject({ alpha: z.number(), beta: z.string() });

describe("sealing", () => {
  test("sha256Hex is lowercase hex of the digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("documentDigest prefixes the algorithm", () => {
    expect(documentDigest(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("key-permuted documents seal to one digest", () => {
    const a = sealRecord({ alpha: 1, beta: "two" });
    const b = sealRecord({ beta: "two", alpha: 1 });
    expect(a.digest).toBe(b.digest);
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
    const sealed = sealWithSchema(Example, { alpha: 1, beta: "two" });
    expect(parseExactWithSchema(Example, sealed.bytes)).toEqual({ alpha: 1, beta: "two" });
  });

  test("parseExactWithSchema rejects non-canonical bytes", () => {
    const nonCanonical = new TextEncoder().encode('{"beta":"two","alpha":1}');
    expect(() => parseExactWithSchema(Example, nonCanonical)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects invalid UTF-8", () => {
    expect(() => parseExactWithSchema(Example, new Uint8Array([0xff, 0xfe]))).toThrow(
      InvalidDocumentError,
    );
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./hashing.js"`.

- [x] **Step 3: Write the implementation**

`src/hashing.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function documentDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}
```

`src/sealing.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";

import { type JsonValue, serializeCanonicalJson } from "./canonical.js";
import { documentDigest } from "./hashing.js";

export interface SealedRecord {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class InvalidDocumentError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("document failed validation at sealing");
    this.name = "InvalidDocumentError";
  }
}

/** Canonicalize once; the resulting bytes are the record forever. */
export function sealRecord(value: JsonValue): SealedRecord {
  const bytes = serializeCanonicalJson(value);
  return { bytes, digest: documentDigest(bytes) };
}

function issues(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/** Validate against `schema`, then seal. Throws `InvalidDocumentError` on failure. */
export function sealWithSchema<T>(schema: z.ZodType<T>, document: unknown): SealedRecord {
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new InvalidDocumentError(issues(parsed.error));
  return sealRecord(parsed.data as JsonValue);
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding —
 * no consumer re-canonicalizes to check a digest.
 */
export function parseExactWithSchema<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid UTF-8" }]);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new InvalidDocumentError([{ path: "", message: "bytes are not valid JSON" }]);
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new InvalidDocumentError(issues(parsed.error));

  const recanonicalized = serializeCanonicalJson(parsed.data as JsonValue);
  if (new TextDecoder().decode(recanonicalized) !== text) {
    throw new InvalidDocumentError([
      { path: "", message: "bytes are not the canonical encoding of this document" },
    ]);
  }
  return parsed.data;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (7 new tests).

- [x] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): digest and exact-bytes sealing primitives"
```

---

### Task 4: Identifiers and the pinned vocabulary profile

**Files:**
- Create: `packages/evidence/trajectory/src/identifiers.ts`, `src/vocabulary.ts`, `src/vocabulary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TRAJECTORY_PROTOCOL`, `TRAJECTORY_RECORD_KIND`, `TRAJECTORY_MEDIA_TYPE`, `TRAJECTORY_VOCABULARY_PROFILE` (all `as const` strings); `GEN_AI_ATTRIBUTES` and `JINN_ATTRIBUTES` (frozen key maps); `OPERATION_NAMES`; `VOCABULARY_UPSTREAM` (the citation record).

This task implements program finding **F1**: the upstream GenAI semantic conventions carry no release, no tag, and no schema URL, and every attribute is `stability: development`, so there is no upstream version to pin. Jinn therefore owns a versioned vocabulary profile that *cites* an upstream snapshot.

- [x] **Step 1: Write the failing test**

`src/vocabulary.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_RECORD_KIND,
  TRAJECTORY_VOCABULARY_PROFILE,
} from "./identifiers.js";
import { GEN_AI_ATTRIBUTES, JINN_ATTRIBUTES, OPERATION_NAMES, VOCABULARY_UPSTREAM } from "./vocabulary.js";

describe("identifiers", () => {
  test("the record kind follows the platform URI grammar", () => {
    expect(TRAJECTORY_RECORD_KIND).toMatch(
      /^https:\/\/jinn\.network\/records\/[a-z][a-z0-9-]*\/\d+\.\d+$/,
    );
  });

  test("the media type follows the vendor-tree grammar", () => {
    expect(TRAJECTORY_MEDIA_TYPE).toBe("application/vnd.jinn.trajectory.v1+json");
  });

  test("protocol and vocabulary profile are absolute Jinn URIs", () => {
    expect(TRAJECTORY_PROTOCOL).toBe("https://jinn.network/protocols/trajectory/1.0");
    expect(TRAJECTORY_VOCABULARY_PROFILE).toBe(
      "https://jinn.network/profiles/trajectory-vocabulary/1.0",
    );
  });
});

describe("vocabulary", () => {
  test("carries the renamed provider key, not the retired one", () => {
    expect(GEN_AI_ATTRIBUTES.providerName).toBe("gen_ai.provider.name");
    expect(Object.values(GEN_AI_ATTRIBUTES)).not.toContain("gen_ai.system");
  });

  test("uses the current token-usage keys", () => {
    expect(GEN_AI_ATTRIBUTES.inputTokens).toBe("gen_ai.usage.input_tokens");
    expect(GEN_AI_ATTRIBUTES.outputTokens).toBe("gen_ai.usage.output_tokens");
  });

  test("Jinn extension keys are namespaced", () => {
    for (const key of Object.values(JINN_ATTRIBUTES)) {
      expect(key.startsWith("jinn.")).toBe(true);
    }
  });

  test("operation names include the three this profile emits", () => {
    expect(OPERATION_NAMES.chat).toBe("chat");
    expect(OPERATION_NAMES.executeTool).toBe("execute_tool");
    expect(OPERATION_NAMES.invokeAgent).toBe("invoke_agent");
  });

  test("the upstream citation pins a commit and a snapshot date", () => {
    expect(VOCABULARY_UPSTREAM.repository).toBe(
      "https://github.com/open-telemetry/semantic-conventions-genai",
    );
    expect(VOCABULARY_UPSTREAM.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(VOCABULARY_UPSTREAM.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VOCABULARY_UPSTREAM.upstreamStability).toBe("development");
  });

  test("attribute maps are frozen", () => {
    expect(Object.isFrozen(GEN_AI_ATTRIBUTES)).toBe(true);
    expect(Object.isFrozen(JINN_ATTRIBUTES)).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./identifiers.js"`.

- [x] **Step 3: Write the implementation**

`src/identifiers.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * Record-kind URIs follow the platform grammar `https://jinn.network/records/<segment>/<major>.<minor>`.
 * Media types follow `application/vnd.jinn.<segment>.v<major>+json`.
 */
export const TRAJECTORY_PROTOCOL =
  "https://jinn.network/protocols/trajectory/1.0" as const;

export const TRAJECTORY_RECORD_KIND =
  "https://jinn.network/records/trajectory/1.0" as const;

export const TRAJECTORY_MEDIA_TYPE =
  "application/vnd.jinn.trajectory.v1+json" as const;

/**
 * The vocabulary profile is Jinn-owned and versioned here. Upstream GenAI semantic
 * conventions publish no release, tag, or schema URL, so there is no upstream version to
 * pin; `VOCABULARY_UPSTREAM` records the snapshot this profile was derived from.
 */
export const TRAJECTORY_VOCABULARY_PROFILE =
  "https://jinn.network/profiles/trajectory-vocabulary/1.0" as const;
```

`src/vocabulary.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * The attribute vocabulary this profile admits.
 *
 * Derived from the OpenTelemetry GenAI semantic conventions, which moved out of
 * `open-telemetry/semantic-conventions` at core release v1.42.0 into a dedicated
 * repository that has published no release, no tag, and no schema URL, and whose
 * attributes are all at `stability: development`. There is therefore nothing upstream to
 * pin, and this profile — not upstream — is the interpretation contract consumers rely on.
 * Upstream is tracked, not depended upon.
 */
export const VOCABULARY_UPSTREAM = Object.freeze({
  repository: "https://github.com/open-telemetry/semantic-conventions-genai",
  /** Replace with the exact `main` commit read when this profile is next revised. */
  commit: "0000000000000000000000000000000000000000",
  snapshotDate: "2026-07-30",
  upstreamStability: "development",
} as const);

/**
 * Upstream keys admitted by this profile. `gen_ai.system` was renamed
 * `gen_ai.provider.name` upstream and is deliberately absent.
 */
export const GEN_AI_ATTRIBUTES = Object.freeze({
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
} as const);

/**
 * Jinn extensions. Message content is never inlined: a span points at the region of the
 * digest-bound source it was derived from, and consumers resolve content there.
 */
export const JINN_ATTRIBUTES = Object.freeze({
  turnRole: "jinn.trajectory.turn.role",
  sourceOrdinal: "jinn.trajectory.source.ordinal",
  outcome: "jinn.trajectory.outcome",
} as const);

/** `gen_ai.operation.name` values this profile emits. */
export const OPERATION_NAMES = Object.freeze({
  chat: "chat",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
} as const);

export type GenAiAttributeKey = (typeof GEN_AI_ATTRIBUTES)[keyof typeof GEN_AI_ATTRIBUTES];
export type JinnAttributeKey = (typeof JINN_ATTRIBUTES)[keyof typeof JINN_ATTRIBUTES];
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (9 new tests).

- [x] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): record identifiers and the Jinn-owned vocabulary profile"
```

---

### Task 5: Deterministic identifier derivation

**Files:**
- Create: `packages/evidence/trajectory/src/identity.ts`, `src/identity.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` (Task 3).
- Produces: `deriveTraceId(input: TraceIdInput): string` (32 lowercase hex); `deriveSpanId(traceId: string, ordinal: number): string` (16 lowercase hex); `interface TraceIdInput { sourceDigest: string; decoderId: string; decoderVersion: string; vocabularyProfile: string }`.

This is the record's anti-forgery mechanism: identifiers are a function of the declared inputs, so a consumer recomputes them from the record alone.

- [x] **Step 1: Write the failing test**

`src/identity.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { deriveSpanId, deriveTraceId } from "./identity.js";

const input = {
  sourceDigest: "sha256:".concat("a".repeat(64)),
  decoderId: "claude-code-stream-json",
  decoderVersion: "1.0.0",
  vocabularyProfile: "https://jinn.network/profiles/trajectory-vocabulary/1.0",
};

describe("identity derivation", () => {
  test("trace id is 32 lowercase hex characters", () => {
    expect(deriveTraceId(input)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("trace id is stable across calls", () => {
    expect(deriveTraceId(input)).toBe(deriveTraceId({ ...input }));
  });

  test("every input field changes the trace id", () => {
    const base = deriveTraceId(input);
    expect(deriveTraceId({ ...input, sourceDigest: `sha256:${"b".repeat(64)}` })).not.toBe(base);
    expect(deriveTraceId({ ...input, decoderId: "other" })).not.toBe(base);
    expect(deriveTraceId({ ...input, decoderVersion: "1.0.1" })).not.toBe(base);
    expect(deriveTraceId({ ...input, vocabularyProfile: "https://example.test/v2" })).not.toBe(base);
  });

  test("field boundaries are unambiguous", () => {
    const a = deriveTraceId({ ...input, decoderId: "ab", decoderVersion: "c" });
    const b = deriveTraceId({ ...input, decoderId: "a", decoderVersion: "bc" });
    expect(a).not.toBe(b);
  });

  test("span id is 16 lowercase hex and ordinal-sensitive", () => {
    const traceId = deriveTraceId(input);
    expect(deriveSpanId(traceId, 0)).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveSpanId(traceId, 0)).not.toBe(deriveSpanId(traceId, 1));
    expect(deriveSpanId(traceId, 7)).toBe(deriveSpanId(traceId, 7));
  });

  test("span ids do not collide across traces", () => {
    const other = deriveTraceId({ ...input, decoderId: "other" });
    expect(deriveSpanId(deriveTraceId(input), 0)).not.toBe(deriveSpanId(other, 0));
  });

  test("rejects a negative or non-integer ordinal", () => {
    const traceId = deriveTraceId(input);
    expect(() => deriveSpanId(traceId, -1)).toThrow(RangeError);
    expect(() => deriveSpanId(traceId, 1.5)).toThrow(RangeError);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./identity.js"`.

- [x] **Step 3: Write the implementation**

`src/identity.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "./hashing.js";

export interface TraceIdInput {
  readonly sourceDigest: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: string;
}

const encoder = new TextEncoder();

/**
 * Length-prefixed framing so that concatenation is injective: no two distinct field
 * tuples share a preimage.
 */
function frame(parts: readonly string[]): Uint8Array {
  return encoder.encode(parts.map((part) => `${part.length}:${part}`).join(""));
}

/**
 * The trace identifier is a pure function of the declared derivation inputs, so a
 * consumer can recompute it from the record alone.
 */
export function deriveTraceId(input: TraceIdInput): string {
  return sha256Hex(
    frame([
      "jinn.trajectory.trace",
      input.sourceDigest,
      input.decoderId,
      input.decoderVersion,
      input.vocabularyProfile,
    ]),
  ).slice(0, 32);
}

/** The span identifier is a pure function of its trace and its ordinal position. */
export function deriveSpanId(traceId: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError("span ordinal must be a non-negative integer");
  }
  return sha256Hex(frame(["jinn.trajectory.span", traceId, String(ordinal)])).slice(0, 16);
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (7 new tests).

- [x] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): deterministic trace and span identifier derivation"
```

---

### Task 6: The span schema

**Files:**
- Create: `packages/evidence/trajectory/src/span.ts`, `src/span.test.ts`

**Interfaces:**
- Consumes: `compareCodeUnitStrings` (Task 2).
- Produces: `SpanSchema`, `AttributeSchema`, `AnyValueSchema`, `SpanEventSchema`, `SpanStatusSchema`; types `Span`, `Attribute`, `AnyValue`; constants `SPAN_KIND` and `STATUS_CODE`.

The OTLP JSON encoding is followed exactly: hex ids, integer enum values, decimal-string 64-bit fields, attributes as an ordered key/value list. Because OTLP defines no canonical ordering, this profile fixes one — **attributes sorted by key** — which is what makes decoder determinism checkable (program finding F4).

- [x] **Step 1: Write the failing test**

`src/span.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { SPAN_KIND, STATUS_CODE, SpanSchema } from "./span.js";

const span = {
  spanId: "0123456789abcdef",
  parentSpanId: null,
  name: "chat anthropic/claude-opus-4.6",
  kind: SPAN_KIND.CLIENT,
  startTimeUnixNano: "1544712660300000000",
  endTimeUnixNano: "1544712661300000000",
  attributes: [
    { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
  ],
  events: [],
  status: { code: STATUS_CODE.OK },
};

describe("span schema", () => {
  test("accepts a well-formed span", () => {
    expect(SpanSchema.safeParse(span).success).toBe(true);
  });

  test("rejects attributes that are not sorted by key", () => {
    const result = SpanSchema.safeParse({
      ...span,
      attributes: [
        { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
        { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("sorted");
  });

  test("rejects duplicate attribute keys", () => {
    const result = SpanSchema.safeParse({
      ...span,
      attributes: [
        { key: "gen_ai.provider.name", value: { stringValue: "a" } },
        { key: "gen_ai.provider.name", value: { stringValue: "b" } },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects uppercase or short identifiers", () => {
    expect(SpanSchema.safeParse({ ...span, spanId: "0123456789ABCDEF" }).success).toBe(false);
    expect(SpanSchema.safeParse({ ...span, spanId: "0123" }).success).toBe(false);
  });

  test("rejects non-decimal-string timestamps", () => {
    expect(SpanSchema.safeParse({ ...span, startTimeUnixNano: 1544712660300000000 }).success).toBe(
      false,
    );
    expect(SpanSchema.safeParse({ ...span, startTimeUnixNano: "12.5" }).success).toBe(false);
  });

  test("rejects an end time before the start time", () => {
    expect(
      SpanSchema.safeParse({
        ...span,
        startTimeUnixNano: "20",
        endTimeUnixNano: "10",
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown span kind or status code", () => {
    expect(SpanSchema.safeParse({ ...span, kind: 9 }).success).toBe(false);
    expect(SpanSchema.safeParse({ ...span, status: { code: 7 } }).success).toBe(false);
  });

  test("accepts exactly one AnyValue variant and rejects two", () => {
    expect(
      SpanSchema.safeParse({
        ...span,
        attributes: [{ key: "a", value: { stringValue: "x", intValue: "1" } }],
      }).success,
    ).toBe(false);
    expect(
      SpanSchema.safeParse({ ...span, attributes: [{ key: "a", value: {} }] }).success,
    ).toBe(false);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./span.js"`.

- [x] **Step 3: Write the implementation**

`src/span.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { compareCodeUnitStrings } from "./order.js";

/** OTLP `SpanKind` enum values; OTLP JSON encodes enums as integers. */
export const SPAN_KIND = Object.freeze({
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const);

/** OTLP `StatusCode` enum values. */
export const STATUS_CODE = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const);

const DecimalUnsigned = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be an unsigned decimal string");

const HexId = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex digits`);

/**
 * The OTLP AnyValue subset this profile admits. Exactly one variant must be present;
 * `bytesValue` is excluded because a trajectory span never carries opaque payloads.
 */
export const AnyValueSchema = z
  .strictObject({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.string().regex(/^-?(0|[1-9]\d*)$/).optional(),
    doubleValue: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  })
  .refine((value) => Object.values(value).filter((entry) => entry !== undefined).length === 1, {
    message: "an AnyValue must carry exactly one variant",
  });

export const AttributeSchema = z.strictObject({
  key: z.string().min(1),
  value: AnyValueSchema,
});

const sortedUniqueByKey = (attributes: readonly { key: string }[]): boolean => {
  for (let index = 1; index < attributes.length; index += 1) {
    const previous = attributes[index - 1]!.key;
    const current = attributes[index]!.key;
    if (compareCodeUnitStrings(previous, current) >= 0) return false;
  }
  return true;
};

const AttributeListSchema = z
  .array(AttributeSchema)
  .refine(sortedUniqueByKey, {
    message: "attributes must be sorted by key and unique (OTLP defines no ordering; this profile fixes one)",
  });

export const SpanEventSchema = z.strictObject({
  timeUnixNano: DecimalUnsigned,
  name: z.string().min(1),
  attributes: AttributeListSchema,
});

export const SpanStatusSchema = z.strictObject({
  code: z.union([
    z.literal(STATUS_CODE.UNSET),
    z.literal(STATUS_CODE.OK),
    z.literal(STATUS_CODE.ERROR),
  ]),
  message: z.string().optional(),
});

export const SpanSchema = z
  .strictObject({
    spanId: HexId(16),
    parentSpanId: HexId(16).nullable(),
    name: z.string().min(1),
    kind: z.union([
      z.literal(SPAN_KIND.INTERNAL),
      z.literal(SPAN_KIND.SERVER),
      z.literal(SPAN_KIND.CLIENT),
      z.literal(SPAN_KIND.PRODUCER),
      z.literal(SPAN_KIND.CONSUMER),
    ]),
    startTimeUnixNano: DecimalUnsigned,
    endTimeUnixNano: DecimalUnsigned,
    attributes: AttributeListSchema,
    events: z.array(SpanEventSchema),
    status: SpanStatusSchema,
  })
  .refine((span) => BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano), {
    message: "endTimeUnixNano must not precede startTimeUnixNano",
    path: ["endTimeUnixNano"],
  });

export type AnyValue = z.infer<typeof AnyValueSchema>;
export type Attribute = z.infer<typeof AttributeSchema>;
export type SpanEvent = z.infer<typeof SpanEventSchema>;
export type SpanStatus = z.infer<typeof SpanStatusSchema>;
export type Span = z.infer<typeof SpanSchema>;
```

> Note: `traceId` is deliberately **not** a per-span field. It is declared once on the record (Task 7), which removes a whole class of inconsistency and shrinks the record.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (8 new tests).

- [x] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): OTLP-shaped span schema with a fixed attribute ordering"
```

---

### Task 7: The trajectory record schema

**Files:**
- Create: `packages/evidence/trajectory/src/extensions.ts`, `src/schema.ts`, `src/schema.test.ts`

**Interfaces:**
- Consumes: `topLevelRecordSchema` (this task), `SpanSchema`/`SPAN_KIND`/`STATUS_CODE` (Task 6), `deriveTraceId`/`deriveSpanId` (Task 5), identifiers (Task 4), sealing (Task 3).
- Produces: `TrajectoryRecordSchema`; `type TrajectoryRecord`; `parseTrajectory(bytes: Uint8Array): TrajectoryRecord`; `sealTrajectory(document: unknown): SealedRecord`; `topLevelRecordSchema<Shape>(shape)`.

- [x] **Step 1: Write the failing test**

`src/schema.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { deriveSpanId, deriveTraceId } from "./identity.js";
import { TRAJECTORY_PROTOCOL, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { SPAN_KIND, STATUS_CODE } from "./span.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };

const traceId = deriveTraceId({
  sourceDigest: SOURCE_DIGEST,
  vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  ...DECODER,
});

const record = () => ({
  protocol: TRAJECTORY_PROTOCOL,
  source: {
    nativeTrace: {
      name: "stdout.jsonl",
      mediaType: "application/x-ndjson",
      digest: { sha256: "a".repeat(64) },
    },
    formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
  },
  derivation: {
    ...DECODER,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  },
  traceId,
  spans: [
    {
      spanId: deriveSpanId(traceId, 0),
      parentSpanId: null,
      name: "chat anthropic/claude-opus-4.6",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
      attributes: [{ key: "gen_ai.provider.name", value: { stringValue: "anthropic" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    },
  ],
  completeness: { decoded: "full" },
});

describe("trajectory record schema", () => {
  test("accepts a well-formed record", () => {
    expect(TrajectoryRecordSchema.safeParse(record()).success).toBe(true);
  });

  test("rejects a forged trace id", () => {
    const result = TrajectoryRecordSchema.safeParse({ ...record(), traceId: "f".repeat(32) });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("traceId");
  });

  test("rejects a forged span id", () => {
    const forged = record();
    forged.spans[0]!.spanId = "f".repeat(16);
    const result = TrajectoryRecordSchema.safeParse(forged);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("spanId");
  });

  test("rejects a span whose parent is not an earlier span in this record", () => {
    const orphan = record();
    orphan.spans[0]!.parentSpanId = "0".repeat(16);
    expect(TrajectoryRecordSchema.safeParse(orphan).success).toBe(false);
  });

  test("rejects a source digest that disagrees with the derivation inputs", () => {
    const mismatched = record();
    mismatched.source.nativeTrace.digest.sha256 = "b".repeat(64);
    expect(TrajectoryRecordSchema.safeParse(mismatched).success).toBe(false);
  });

  test("rejects a non-namespaced extension key", () => {
    expect(TrajectoryRecordSchema.safeParse({ ...record(), extra: 1 }).success).toBe(false);
  });

  test("accepts a namespaced extension key", () => {
    expect(
      TrajectoryRecordSchema.safeParse({ ...record(), "network.jinn.note": "kept" }).success,
    ).toBe(true);
  });

  test("rejects an unknown protocol literal", () => {
    expect(
      TrajectoryRecordSchema.safeParse({ ...record(), protocol: "https://example.test/x" })
        .success,
    ).toBe(false);
  });

  test("seals and re-parses to the same digest", () => {
    const sealed = sealTrajectory(record());
    expect(parseTrajectory(sealed.bytes).traceId).toBe(traceId);
    expect(sealTrajectory(record()).digest).toBe(sealed.digest);
  });

  test("sealing an invalid record throws InvalidDocumentError", () => {
    expect(() => sealTrajectory({ ...record(), traceId: "f".repeat(32) })).toThrow(
      InvalidDocumentError,
    );
  });

  test("an empty span list is permitted and marked", () => {
    const empty = { ...record(), spans: [], completeness: { decoded: "empty" } };
    expect(TrajectoryRecordSchema.safeParse(empty).success).toBe(true);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./schema.js"`.

- [x] **Step 3: Write the extension-key discipline**

`src/extensions.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const ABSOLUTE_URI_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || ABSOLUTE_URI_KEY_PATTERN.test(key);
}

/**
 * Keeps top-level records open only to namespaced extension names: unknown keys survive
 * round-trips, but they can never shadow core fields.
 */
export function topLevelRecordSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  const knownKeys = new Set(Object.keys(shape));
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (knownKeys.has(key) || isNamespacedExtensionKey(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `Extension key "${key}" must be namespaced (reverse-DNS or absolute URI).`,
      });
    }
  });
}
```

- [x] **Step 4: Write the record schema**

`src/schema.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { topLevelRecordSchema } from "./extensions.js";
import { TRAJECTORY_PROTOCOL, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { type SealedRecord, parseExactWithSchema, sealWithSchema } from "./sealing.js";
import { SpanSchema } from "./span.js";

const LowercaseSha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 must be exactly 64 lowercase hexadecimal digits");

const AbsoluteIri = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u, "must be an absolute IRI");

/** A digest-bound reference: acquisition hints may vary, identity may not. */
const DigestBearingDescriptorSchema = z.looseObject({
  name: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  digest: z.looseObject({ sha256: LowercaseSha256Hex }),
});

const SourceSchema = z.strictObject({
  /** The exact bytes this trajectory was derived from. */
  nativeTrace: DigestBearingDescriptorSchema,
  /** What format those bytes are in — the decoder selection key. */
  formatIri: AbsoluteIri,
  /** The execution evidence record this trace belongs to, when one exists. */
  execution: DigestBearingDescriptorSchema.optional(),
});

const DerivationSchema = z.strictObject({
  decoderId: z.string().regex(/^[a-z][a-z0-9-]*$/, "decoder id must be a lowercase slug"),
  decoderVersion: z.string().min(1),
  vocabularyProfile: z.literal(TRAJECTORY_VOCABULARY_PROFILE),
});

const CompletenessSchema = z.strictObject({
  decoded: z.enum(["full", "partial", "empty"]),
  /** Source records the decoder could not interpret, when `decoded` is `partial`. */
  skipped: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).optional(),
});

export const TrajectoryRecordSchema = topLevelRecordSchema({
  protocol: z.literal(TRAJECTORY_PROTOCOL),
  source: SourceSchema,
  derivation: DerivationSchema,
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spans: z.array(SpanSchema),
  completeness: CompletenessSchema,
}).superRefine((record, ctx) => {
  const expectedTraceId = deriveTraceId({
    sourceDigest: `sha256:${record.source.nativeTrace.digest.sha256}`,
    decoderId: record.derivation.decoderId,
    decoderVersion: record.derivation.decoderVersion,
    vocabularyProfile: record.derivation.vocabularyProfile,
  });

  if (record.traceId !== expectedTraceId) {
    ctx.addIssue({
      code: "custom",
      path: ["traceId"],
      message:
        "traceId must equal the value derived from source.nativeTrace.digest and derivation",
    });
    return;
  }

  const seen = new Set<string>();
  record.spans.forEach((span, ordinal) => {
    const expectedSpanId = deriveSpanId(record.traceId, ordinal);
    if (span.spanId !== expectedSpanId) {
      ctx.addIssue({
        code: "custom",
        path: ["spans", ordinal, "spanId"],
        message: `spanId must equal the value derived from traceId and ordinal ${String(ordinal)}`,
      });
    }
    if (span.parentSpanId !== null && !seen.has(span.parentSpanId)) {
      ctx.addIssue({
        code: "custom",
        path: ["spans", ordinal, "parentSpanId"],
        message: "parentSpanId must reference an earlier span in this record",
      });
    }
    seen.add(span.spanId);
  });

  if (record.completeness.decoded === "empty" && record.spans.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "decoded"],
      message: "an empty decode must carry no spans",
    });
  }
  if (record.completeness.decoded === "partial" && record.completeness.skipped === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "skipped"],
      message: "a partial decode must report how many source records were skipped",
    });
  }
});

export type TrajectoryRecord = z.infer<typeof TrajectoryRecordSchema>;

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseTrajectory(bytes: Uint8Array): TrajectoryRecord {
  return parseExactWithSchema(TrajectoryRecordSchema, bytes);
}

/** Validate, then seal a trajectory document. Throws `InvalidDocumentError` on failure. */
export function sealTrajectory(document: unknown): SealedRecord {
  return sealWithSchema(TrajectoryRecordSchema, document);
}
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (11 new tests).

- [x] **Step 6: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): the sealed trajectory record schema and its derived-identity invariants"
```

---

### Task 8: The public surface

**Files:**
- Create: `packages/evidence/trajectory/src/index.test.ts`
- Modify: `packages/evidence/trajectory/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: the package's public API — the surface every later component and the C2 decoder import.

- [x] **Step 1: Write the failing test**

`src/index.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import * as api from "./index.js";

describe("public surface", () => {
  test("exports the identifiers, sealing primitives, and record API", () => {
    for (const name of [
      "TRAJECTORY_PROTOCOL",
      "TRAJECTORY_RECORD_KIND",
      "TRAJECTORY_MEDIA_TYPE",
      "TRAJECTORY_VOCABULARY_PROFILE",
      "GEN_AI_ATTRIBUTES",
      "JINN_ATTRIBUTES",
      "OPERATION_NAMES",
      "VOCABULARY_UPSTREAM",
      "SPAN_KIND",
      "STATUS_CODE",
      "SpanSchema",
      "TrajectoryRecordSchema",
      "parseTrajectory",
      "sealTrajectory",
      "deriveTraceId",
      "deriveSpanId",
      "sealRecord",
      "InvalidDocumentError",
      "serializeCanonicalJson",
      "documentDigest",
      "compareCodeUnitStrings",
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  test("does not leak the testing kit through the root entrypoint", () => {
    expect(api).not.toHaveProperty("describeTrajectoryRecordConformance");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — the placeholder `index.ts` exports nothing.

- [x] **Step 3: Write the implementation**

`src/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Pinned identifiers
export {
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_RECORD_KIND,
  TRAJECTORY_VOCABULARY_PROFILE,
} from "./identifiers.js";
export {
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  OPERATION_NAMES,
  VOCABULARY_UPSTREAM,
} from "./vocabulary.js";
export type { GenAiAttributeKey, JinnAttributeKey } from "./vocabulary.js";

// Sealing primitives
export { compareCodeUnitStrings } from "./order.js";
export {
  NonIJsonNumberError,
  NonIJsonStringError,
  UndefinedArrayElementError,
  serializeCanonicalJson,
} from "./canonical.js";
export type { JsonValue } from "./canonical.js";
export { documentDigest, sha256Hex } from "./hashing.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealRecord,
  sealWithSchema,
} from "./sealing.js";
export type { SealedRecord, ValidationIssue } from "./sealing.js";

// Derived identity
export { deriveSpanId, deriveTraceId } from "./identity.js";
export type { TraceIdInput } from "./identity.js";

// Record kind
export { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";
export {
  AnyValueSchema,
  AttributeSchema,
  SPAN_KIND,
  STATUS_CODE,
  SpanEventSchema,
  SpanSchema,
  SpanStatusSchema,
} from "./span.js";
export type { AnyValue, Attribute, Span, SpanEvent, SpanStatus } from "./span.js";
export { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";
export type { TrajectoryRecord } from "./schema.js";
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck && yarn build`
Expected: PASS; `dist/` produced.

- [x] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): the package public surface"
```

---

### Task 9: Golden and adversarial fixtures

**Files:**
- Create: `packages/evidence/trajectory/scripts/generate-fixtures.mjs`
- Create: `fixtures/trajectory/{valid.json,valid.sha256,minimal.json,minimal.sha256}`, `fixtures/trajectory/invalid-{forged-span-id,forged-trace-id,unsorted-attributes,unknown-extension-key}.json`
- Create: `fixtures/equivalence/{input-a.json,input-b.json,expected-digest.json}`
- Create: `fixtures/adversarial-v1/manifest.json` and one directory per case
- Create: `src/fixtures.ts`, `src/fixtures.test.ts`

**Interfaces:**
- Consumes: `sealTrajectory`, `parseTrajectory`, `deriveTraceId`, `deriveSpanId`.
- Produces: `loadGoldenBytes(name)`, `loadGoldenJson(name)`, `loadGoldenDigest(name)`, `loadInvalidJson(name)`, `loadEquivalenceInput(variant)`, `loadEquivalenceExpectedDigest()`, `loadAdversarialManifest()`, `readAdversarialJson(id, filename)`; `type GoldenName = "valid" | "minimal"`; `interface AdversarialManifest`.

> Fixture-provenance rule (platform architecture §5): fixtures are derived from this specification and the in-tree generator — **never captured from a product run**.

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
  readAdversarialJson,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

describe("fixtures", () => {
  test.each(["valid", "minimal"] as const)("golden %s parses and re-seals to its pin", async (name) => {
    const bytes = await loadGoldenBytes(name);
    const digest = await loadGoldenDigest(name);
    expect(documentDigest(bytes)).toBe(digest);
    expect(parseTrajectory(bytes).protocol).toBeDefined();
    expect(sealTrajectory(await loadGoldenJson(name)).digest).toBe(digest);
  });

  test.each([
    "forged-span-id",
    "forged-trace-id",
    "unsorted-attributes",
    "unknown-extension-key",
  ] as const)("invalid fixture %s is rejected", async (name) => {
    expect(TrajectoryRecordSchema.safeParse(await loadInvalidJson(name)).success).toBe(false);
  });

  test("key-permuted equivalence twins seal to one pinned digest", async () => {
    const expected = await loadEquivalenceExpectedDigest();
    expect(sealTrajectory(await loadEquivalenceInput("a")).digest).toBe(expected);
    expect(sealTrajectory(await loadEquivalenceInput("b")).digest).toBe(expected);
  });

  test("every adversarial case is present and behaves as its manifest declares", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(4);
    for (const entry of manifest.fixtures) {
      const document = await readAdversarialJson(entry.id, "document.json");
      const result = TrajectoryRecordSchema.safeParse(document);
      expect(result.success).toBe(entry.expectedDisposition === "accepted");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./fixtures.js"`.

- [ ] **Step 3: Write the fixture generator**

`scripts/generate-fixtures.mjs`:

```js
// SPDX-License-Identifier: Apache-2.0
// Generates the golden, equivalence, and adversarial fixture corpora from the schema.
// Fixtures are derived from the specification and this generator, never captured from a
// product run. Run with `--write`; run with `--check` in CI to detect drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixtures = join(root, "fixtures");

const {
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveSpanId,
  deriveTraceId,
  documentDigest,
  sealTrajectory,
} = await import(join(root, "dist", "index.js"));

const SOURCE_SHA = "a".repeat(64);
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };
const traceId = deriveTraceId({
  sourceDigest: `sha256:${SOURCE_SHA}`,
  vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  ...DECODER,
});

const base = () => ({
  protocol: TRAJECTORY_PROTOCOL,
  source: {
    nativeTrace: {
      name: "stdout.jsonl",
      mediaType: "application/x-ndjson",
      digest: { sha256: SOURCE_SHA },
    },
    formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
  },
  derivation: { ...DECODER, vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE },
  traceId,
  spans: [],
  completeness: { decoded: "empty" },
});

const span = (ordinal, overrides = {}) => ({
  spanId: deriveSpanId(traceId, ordinal),
  parentSpanId: null,
  name: "chat anthropic/claude-opus-4.6",
  kind: 3,
  startTimeUnixNano: String(1000 + ordinal * 1000),
  endTimeUnixNano: String(2000 + ordinal * 1000),
  attributes: [
    { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: "1024" } },
  ],
  events: [],
  status: { code: 1 },
  ...overrides,
});

const valid = () => ({
  ...base(),
  spans: [
    span(0),
    span(1, {
      name: "execute_tool read_file",
      kind: 1,
      parentSpanId: deriveSpanId(traceId, 0),
      attributes: [
        { key: "gen_ai.tool.call.id", value: { stringValue: "call_1" } },
        { key: "gen_ai.tool.name", value: { stringValue: "read_file" } },
      ],
    }),
  ],
  completeness: { decoded: "full" },
});

const minimal = () => base();

const invalid = {
  "forged-trace-id": () => ({ ...valid(), traceId: "f".repeat(32) }),
  "forged-span-id": () => {
    const document = valid();
    document.spans[0].spanId = "f".repeat(16);
    return document;
  },
  "unsorted-attributes": () => {
    const document = valid();
    document.spans[0].attributes = [...document.spans[0].attributes].reverse();
    return document;
  },
  "unknown-extension-key": () => ({ ...valid(), note: "not namespaced" }),
};

const adversarial = {
  "partial-without-skipped": {
    description: "A partial decode that does not report how many source records were skipped.",
    expectedDisposition: "invalid-document",
    document: () => ({ ...valid(), completeness: { decoded: "partial" } }),
  },
  "empty-with-spans": {
    description: "An empty decode that nevertheless carries spans.",
    expectedDisposition: "invalid-document",
    document: () => ({ ...valid(), completeness: { decoded: "empty" } }),
  },
  "grafted-parent": {
    description: "A span whose parent identifier belongs to no earlier span in this record.",
    expectedDisposition: "invalid-document",
    document: () => {
      const document = valid();
      document.spans[1].parentSpanId = "0".repeat(16);
      return document;
    },
  },
  "substituted-source-digest": {
    description:
      "Spans copied verbatim onto a different source digest — the derived identifiers no longer agree.",
    expectedDisposition: "invalid-document",
    document: () => {
      const document = valid();
      document.source.nativeTrace.digest.sha256 = "b".repeat(64);
      return document;
    },
  },
  "namespaced-extension-preserved": {
    description: "An unknown but namespaced extension key, which must survive round-trips.",
    expectedDisposition: "accepted",
    document: () => ({ ...valid(), "network.jinn.note": "kept" }),
  },
};

const write = process.argv.includes("--write");
const failures = [];

async function emit(relativePath, contents) {
  const target = join(fixtures, relativePath);
  const text = typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`;
  if (write) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) failures.push(relativePath);
}

for (const [name, build] of [["valid", valid], ["minimal", minimal]]) {
  const document = build();
  await emit(`trajectory/${name}.json`, document);
  await emit(`trajectory/${name}.sha256`, `${sealTrajectory(document).digest}\n`);
}

for (const [name, build] of Object.entries(invalid)) {
  await emit(`trajectory/invalid-${name}.json`, build());
}

const permuted = (value) =>
  Array.isArray(value)
    ? value.map(permuted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, permuted(v)]))
      : value;

await emit("equivalence/input-a.json", valid());
await emit("equivalence/input-b.json", permuted(valid()));
await emit("equivalence/expected-digest.json", { digest: sealTrajectory(valid()).digest });

const manifest = { fixtures: [] };
for (const [id, entry] of Object.entries(adversarial)) {
  await emit(`adversarial-v1/${id}/document.json`, entry.document());
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

Add to `package.json` scripts:

```json
    "generate:fixtures": "yarn build && node scripts/generate-fixtures.mjs --write",
    "check:fixtures": "yarn build && node scripts/generate-fixtures.mjs",
```

- [ ] **Step 4: Generate the fixtures**

Run: `cd packages/evidence/trajectory && yarn generate:fixtures`
Expected: `fixtures written`; the `fixtures/` tree exists.

- [ ] **Step 5: Write the loaders**

`src/fixtures.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

export type GoldenName = "valid" | "minimal";

export interface AdversarialManifestEntry {
  readonly id: string;
  readonly description: string;
  readonly expectedDisposition: string;
}

export interface AdversarialManifest {
  readonly fixtures: readonly AdversarialManifestEntry[];
}

/** Resolves a path inside the fixture corpus shipped by this package. */
export function trajectoryFixtureUrl(relativePath: string): URL {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("trajectory fixture paths must stay inside fixtures/");
  }
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(trajectoryFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(trajectoryFixtureUrl(relativePath), "utf8"));
}

export async function loadGoldenBytes(name: GoldenName): Promise<Uint8Array> {
  return bytes(`trajectory/${name}.json`);
}

export async function loadGoldenJson(name: GoldenName): Promise<unknown> {
  return json(`trajectory/${name}.json`);
}

export async function loadGoldenDigest(name: GoldenName): Promise<`sha256:${string}`> {
  const text = await readFile(trajectoryFixtureUrl(`trajectory/${name}.sha256`), "utf8");
  return text.trim() as `sha256:${string}`;
}

export async function loadInvalidJson(name: string): Promise<unknown> {
  return json(`trajectory/invalid-${name}.json`);
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

export async function readAdversarialJson(id: string, filename: string): Promise<unknown> {
  return json(`adversarial-v1/${id}/${filename}`);
}
```

> `src/fixtures.ts` uses `node:fs/promises`, which the evidence boundary guard permits only outside production source. Task 12's boundary block therefore classifies `fixtures.ts` with the testing region, and `index.ts` does **not** re-export it.

**Golden fixture, for reference** — `fixtures/trajectory/valid.json` as generated:

```json
{
  "protocol": "https://jinn.network/protocols/trajectory/1.0",
  "source": {
    "nativeTrace": {
      "name": "stdout.jsonl",
      "mediaType": "application/x-ndjson",
      "digest": { "sha256": "aaaaaaaa…aaaa" }
    },
    "formatIri": "https://jinn.network/formats/claude-code-stream-json/v1"
  },
  "derivation": {
    "decoderId": "claude-code-stream-json",
    "decoderVersion": "1.0.0",
    "vocabularyProfile": "https://jinn.network/profiles/trajectory-vocabulary/1.0"
  },
  "traceId": "<derived>",
  "spans": [ … two spans … ],
  "completeness": { "decoded": "full" }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (all fixture tests green).

- [ ] **Step 7: Commit**

```bash
git add packages/evidence/trajectory
git commit -m "feat(evidence-trajectory): golden, equivalence, and adversarial fixture corpora"
```

---

### Task 10: The conformance kit

**Files:**
- Create: `packages/evidence/trajectory/src/testing.ts`, `src/kit.test.ts`

**Interfaces:**
- Consumes: fixtures (Task 9), schema (Task 7), sealing (Task 3).
- Produces: `describeTrajectoryRecordConformance(): void` — the suite any producer or third-party implementation runs to prove it reproduces this record surface.

- [ ] **Step 1: Write the failing test**

`src/kit.test.ts`:

```ts
import { describeTrajectoryRecordConformance } from "./testing.js";

describeTrajectoryRecordConformance();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./testing.js"`.

- [ ] **Step 3: Write the kit**

`src/testing.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  type GoldenName,
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  readAdversarialJson,
} from "./fixtures.js";
import { documentDigest } from "./hashing.js";
import { deriveSpanId, deriveTraceId } from "./identity.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

const GOLDEN: readonly GoldenName[] = ["valid", "minimal"];

/**
 * Record conformance for the Trajectory kind: schema validation, producer-side re-seal,
 * consumer-side digest verification without re-canonicalization, derived-identity
 * recomputation, and the adversarial corpus.
 *
 * Any implementation that produces or consumes Trajectory records runs this driver to
 * prove it reproduces the frozen record surface.
 */
export function describeTrajectoryRecordConformance(): void {
  describe("Trajectory record conformance", () => {
    describe.each(GOLDEN)("golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(TrajectoryRecordSchema.safeParse(await loadGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const pinnedBytes = await loadGoldenBytes(name);
        const pinnedDigest = await loadGoldenDigest(name);
        const resealed = sealTrajectory(await loadGoldenJson(name));
        expect(new TextDecoder().decode(resealed.bytes)).toBe(
          new TextDecoder().decode(pinnedBytes),
        );
        expect(resealed.digest).toBe(pinnedDigest);
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(documentDigest(await loadGoldenBytes(name))).toBe(await loadGoldenDigest(name));
      });

      test("every identifier recomputes from the record's own declared inputs", async () => {
        const record = parseTrajectory(await loadGoldenBytes(name));
        expect(record.traceId).toBe(
          deriveTraceId({
            sourceDigest: `sha256:${record.source.nativeTrace.digest.sha256}`,
            decoderId: record.derivation.decoderId,
            decoderVersion: record.derivation.decoderVersion,
            vocabularyProfile: record.derivation.vocabularyProfile,
          }),
        );
        record.spans.forEach((span, ordinal) => {
          expect(span.spanId).toBe(deriveSpanId(record.traceId, ordinal));
        });
      });

      test("sealing is idempotent", async () => {
        const once = sealTrajectory(await loadGoldenJson(name));
        const twice = sealTrajectory(parseTrajectory(once.bytes));
        expect(twice.digest).toBe(once.digest);
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      expect(sealTrajectory(await loadEquivalenceInput("a")).digest).toBe(expected);
      expect(sealTrajectory(await loadEquivalenceInput("b")).digest).toBe(expected);
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const record = await loadGoldenJson("valid");
      const nonCanonical = new TextEncoder().encode(JSON.stringify(record, null, 2));
      expect(() => parseTrajectory(nonCanonical)).toThrow();
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(4);
      for (const entry of manifest.fixtures) {
        const document = await readAdversarialJson(entry.id, "document.json");
        const accepted = TrajectoryRecordSchema.safeParse(document).success;
        expect(accepted, `${entry.id}: ${entry.description}`).toBe(
          entry.expectedDisposition === "accepted",
        );
      }
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS — the conformance suite runs green in-package.

- [ ] **Step 5: Commit**

```bash
git add packages/evidence/trajectory/src
git commit -m "feat(evidence-trajectory): the record conformance kit"
```

---

### Task 11: Published JSON Schema

**Files:**
- Create: `packages/evidence/trajectory/scripts/generate-schemas.mjs`, `schemas/trajectory.schema.json`, `src/schema-parity.test.ts`

**Interfaces:**
- Consumes: `TrajectoryRecordSchema`.
- Produces: `schemas/trajectory.schema.json`, published at the `./schemas/*` subpath — the artifact that makes "a third party can verify without running Jinn code" mechanical rather than aspirational.

- [ ] **Step 1: Write the failing test**

`src/schema-parity.test.ts`:

```ts
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadGoldenJson, loadInvalidJson } from "./fixtures.js";
import { TRAJECTORY_RECORD_KIND } from "./identifiers.js";

const published = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
  );

describe("published JSON Schema", () => {
  test("declares the record kind as its identifier", async () => {
    expect((await published()).$id).toBe(`${TRAJECTORY_RECORD_KIND}/schema`);
  });

  test("accepts the golden fixtures under a standalone validator", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    expect(validate(await loadGoldenJson("valid"))).toBe(true);
    expect(validate(await loadGoldenJson("minimal"))).toBe(true);
  });

  test("rejects structurally invalid fixtures under the standalone validator", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    expect(validate(await loadInvalidJson("unknown-extension-key"))).toBe(false);
  });

  test("documents the runtime-only checks it cannot express", async () => {
    expect(String((await published()).$comment)).toContain("derived");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `schemas/trajectory.schema.json` does not exist.

- [ ] **Step 3: Write the generator**

`scripts/generate-schemas.mjs`:

```js
// SPDX-License-Identifier: Apache-2.0
// Emits the published JSON Schema. `--write` regenerates; the default checks for drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { TRAJECTORY_RECORD_KIND, TrajectoryRecordSchema } = await import(
  join(root, "dist", "index.js")
);

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

const schema = z.toJSONSchema(TrajectoryRecordSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
});

schema.$id = `${TRAJECTORY_RECORD_KIND}/schema`;
schema.title = "Jinn Trajectory record";
schema.propertyNames = {
  anyOf: [{ enum: Object.keys(schema.properties ?? {}) }, { pattern: NAMESPACED }],
};
schema.$comment = [
  "Structural validation only. Three checks are runtime-only and are not expressible here:",
  "traceId must equal the value derived from source.nativeTrace.digest and derivation;",
  "each spanId must equal the value derived from traceId and its ordinal;",
  "attributes must be sorted by key and unique.",
].join(" ");

const target = join(root, "schemas", "trajectory.schema.json");
const text = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes("--write")) {
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

Run: `cd packages/evidence/trajectory && yarn generate:schemas && yarn test && yarn typecheck`
Expected: `schema written`; PASS (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/evidence/trajectory
git commit -m "feat(evidence-trajectory): publish the record JSON Schema with a standalone-validator parity check"
```

---

### Task 12: Boundary block, packed-types smoke, and CI

**Files:**
- Create: `packages/evidence/trajectory/scripts/pack-smoke.mjs`
- Modify: `.github/scripts/evidence-source-boundaries.test.mjs` (allowlists, escape self-test, boundary block)
- Modify: `.github/workflows/evidence-ci.yml` (job, `verify` needs/env/loop, dist placement list)

**Interfaces:**
- Consumes: the finished package.
- Produces: green guards and CI for `@jinn-network/evidence-trajectory`; the package is now safe for C2 and C4 to depend on.

- [ ] **Step 1: Add the allowlist constants and the escape self-test**

In `.github/scripts/evidence-source-boundaries.test.mjs`, after the contribution constants block (line 292), add:

```js
// Trajectory is a tier-2 record kind: schemas, sealing, and derived identity. It composes
// Protocol only, never a repository binding, discovery, a runtime, or any product tree,
// and performs no I/O outside its fixture loaders in the testing region.
const TRAJECTORY_ALLOWED_DEPENDENCIES = [
  '@jinn-network/evidence-protocol',
  '@noble/hashes',
  'zod',
];
const TRAJECTORY_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  'ajv',
  'canonicalize',
  'typescript',
  'vitest',
];
const TRAJECTORY_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const TRAJECTORY_FORBIDDEN_PACKAGES = [
  '@jinn-network/attestation-issuer',
  '@jinn-network/autopilot',
  '@jinn-network/client',
  '@jinn-network/core',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/indexer',
  '@jinn-network/jinn-layer',
  '@jinn-network/marketplace',
  '@jinn-network/plugin',
  '@jinn-network/sdk',
  'better-sqlite3',
  'node:child_process',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'viem',
];
```

Then add the escape self-test beside the contribution one (after line 761):

```js
test('Trajectory boundary checks catch package, I/O, and ambient-network escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-trajectory-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/plugin";',
      'export * from "@jinn-network/core";',
      'await import("@jinn-network/jinn-layer");',
      'require("@jinn-network/evidence-local-runtime");',
      'import "node:fs";',
      'fetch;',
    ].join('\n'));
    assert.equal(
      forbiddenImports(source, TRAJECTORY_FORBIDDEN_PACKAGES).length,
      5,
    );
    assert.equal(ambientNetworkUsesInFiles(files(source)).length, 1);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Add the boundary block**

Inside `test('evidence source boundaries remain one-way across the approved graph', …)`, after the contribution block (line 1324), add:

```js
  const trajectory = join(packages, 'trajectory');
  const trajectorySource = join(trajectory, 'src');
  const trajectoryTestingEntry = join(trajectorySource, 'testing.ts');
  const trajectoryFixtureLoaders = join(trajectorySource, 'fixtures.ts');
  const trajectoryTestRegex = /\.test\.[cm]?[jt]sx?$/u;
  const trajectorySourceFiles = files(trajectorySource);
  const trajectoryTestingFiles = trajectorySourceFiles.filter((file) =>
    file === trajectoryTestingEntry
      || file === trajectoryFixtureLoaders
      || trajectoryTestRegex.test(file));
  const trajectoryProductionFiles = trajectorySourceFiles.filter((file) =>
    !trajectoryTestingFiles.includes(file));
  const trajectoryManifest = manifest('trajectory');
  const trajectoryForeignRoots = evidenceDirectories
    .filter((directory) => !['trajectory', 'protocol'].includes(directory))
    .map((directory) => join(packages, directory));

  assert.deepEqual(
    forbiddenImportsInFiles(
      trajectoryProductionFiles,
      [...TRAJECTORY_FORBIDDEN_PACKAGES, 'vitest', 'node:fs/promises'],
      [...trajectoryForeignRoots, ...trajectoryTestingFiles],
    ),
    [],
    'Trajectory production source must not import forbidden packages, vitest, filesystem APIs, or the testing region',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(trajectoryTestingFiles, TRAJECTORY_FORBIDDEN_PACKAGES, trajectoryForeignRoots),
    [],
    'Trajectory testing files must not cross into foreign package roots',
  );
  assert.deepEqual(
    ambientNetworkUsesInFiles(trajectorySourceFiles),
    [],
    'Trajectory source must not use ambient network APIs',
  );
  assert.deepEqual(Object.keys(trajectoryManifest.exports).sort(), [
    '.', './fixtures/*', './schemas/*', './testing',
  ]);
  assert.deepEqual(trajectoryManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(trajectoryManifest.exports['./testing'], {
    import: './dist/testing.js',
    types: './dist/testing.d.ts',
  });
  assert.deepEqual(
    Object.keys(trajectoryManifest.dependencies ?? {}).sort(),
    TRAJECTORY_ALLOWED_DEPENDENCIES,
  );
  assert.deepEqual(
    Object.keys(trajectoryManifest.devDependencies ?? {}).sort(),
    TRAJECTORY_ALLOWED_DEV_DEPENDENCIES,
  );
  assert.deepEqual(
    Object.keys(trajectoryManifest.peerDependencies ?? {}).sort(),
    TRAJECTORY_ALLOWED_PEER_DEPENDENCIES,
  );
  assert.deepEqual(trajectoryManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  for (const directory of evidenceDirectories.filter((entry) => entry !== 'trajectory')) {
    assertBoundary(
      join(packages, directory, 'src'),
      ['@jinn-network/evidence-trajectory'],
      [trajectory],
    );
  }
  assert.deepEqual(
    forbiddenImportsInFiles(
      [join(trajectorySource, 'index.ts')],
      [],
      [trajectoryTestingEntry, trajectoryFixtureLoaders],
    ),
    [],
    'the Trajectory root entrypoint must not export testing.ts or fixtures.ts',
  );
```

- [ ] **Step 3: Run the boundary guard**

Run: `node --test .github/scripts/evidence-source-boundaries.test.mjs`
Expected: PASS.

- [ ] **Step 4: Add the pack smoke script**

Copy `packages/evidence/derivation/scripts/pack-smoke.mjs` to `packages/evidence/trajectory/scripts/pack-smoke.mjs` verbatim, then make exactly three substitutions: replace every occurrence of `@jinn-network/evidence-derivation` with `@jinn-network/evidence-trajectory`; replace `evidence-derivation` in the temp-directory prefix with `evidence-trajectory`; and replace the `REQUIRED_ENTRIES` array with:

```js
const REQUIRED_ENTRIES = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/testing.js',
  'package/dist/testing.d.ts',
  'package/schemas/trajectory.schema.json',
  'package/fixtures/trajectory/valid.json',
  'package/fixtures/trajectory/valid.sha256',
  'package/fixtures/adversarial-v1/manifest.json',
  'package/README.md',
  'package/package.json',
];
```

keeping the derivation script's other assertions unchanged: no `*.test.*`, `.map`, or `/src/` entries leak; a root-only consumer installs without `vitest` present; `peerDependencies`/`peerDependenciesMeta` survive packing; the packed `./testing` kit runs under real vitest and `tsc`.

- [ ] **Step 5: Run the pack smoke**

Run: `cd packages/evidence/trajectory && yarn build && yarn pack:smoke`
Expected: PASS — tarball carries dist, schemas, and fixtures; nothing leaks.

- [ ] **Step 6: Wire CI**

In `.github/workflows/evidence-ci.yml`:

Add the design and plan documents to the `push` path filter (lines 11–16):

```yaml
      - 'docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md'
      - 'docs/superpowers/plans/2026-07-30-plugin-c1-trajectory-record.md'
```

Add the job, modeled on `retrieval` (lines 271–318) but with `protocol` as its only portal dependency:

```yaml
  trajectory:
    name: Evidence Trajectory
    needs: [foundation]
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
      - name: Restore Evidence Protocol distribution
        uses: actions/download-artifact@v4
        with:
          name: evidence-protocol-dist
          path: packages/evidence/protocol/dist
      - name: Install packed-smoke dependency toolchains
        run: (cd packages/evidence/protocol && yarn install --immutable)
      - name: Verify Evidence Trajectory
        working-directory: packages/evidence/trajectory
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn check:fixtures
          yarn check:schemas
          yarn pack:smoke
      - name: Upload Evidence Trajectory distribution
        uses: actions/upload-artifact@v4
        with:
          name: evidence-trajectory-dist
          path: packages/evidence/trajectory/dist
          if-no-files-found: error
          retention-days: 1
```

In the `verify` job: add `trajectory` to `needs`; add `TRAJECTORY: ${{ needs.trajectory.result }}` to the env block and `$TRAJECTORY` to the result loop; add `trajectory` to the dist-placement list at line 527.

- [ ] **Step 7: Run the full local verification**

Run:

```bash
cd packages/evidence/trajectory && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn check:fixtures && yarn check:schemas && yarn pack:smoke
```

then from the repository root:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs && node --test .github/scripts/evidence-source-boundaries.test.mjs && node .github/scripts/evidence-packed-types.test.mjs
```

Expected: every command PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/evidence/trajectory .github
git commit -m "feat(evidence-trajectory): boundary block, packed-types smoke, and CI"
```

---

## Component review gate

Before C2 or C4 build on this package, one independent high-effort review checks it against the design (spec §7.2 and the program's cross-plan contract 3), covering: derived-identity coverage against forgery; whether the fixed attribute ordering is sufficient for decoder determinism; extension-key round-tripping; the honesty of the two-level verification statement; and the vocabulary profile's upstream citation. Findings are resolved before dependents build.

## Findings this plan carries into the component review

- **F7 (new here) — record-level DSSE signing is not implemented, deliberately.** Spec §7.2 says the record "is DSSE-signed by its producer". This package seals the record and stops there: identity is the digest, and attributability arrives through the discovery layer, whose announcements are already DSSE-signed and carry record references. Adding a second signing scheme at the record layer would duplicate that machinery for no gain the threat model names — forged spans are already refused by the derived-identity invariants, which do not depend on a signature. **Proposed disposition:** amend §7.2 to state that Trajectory records are sealed and attributed through signed announcements, with direct DSSE envelopes available via the trust layer if a future consumer requires them. Raise at the component review; do not silently patch the spec.
- **F8 (new here) — the per-span integrity hash chain is superseded, not dropped.** Spec §7.2 carries forward "the integrity hash chain … as `jinn.*` extensions" from the frozen `core` schema, where each span embedded `jinn.prevSpanHash` so a reader could detect reordering or excision inside an unsealed span array. This package achieves the same property more simply: the whole record is sealed (its bytes *are* its identity), and every span identifier is derived from `(traceId, ordinal)`, so removing, reordering, or inserting a span breaks the derivation check without any chain field. A chain would add a second, weaker integrity mechanism over material that is already immutable. **Proposed disposition:** amend §7.2 to record derived identity as the mechanism and the chain as superseded. Raise at the component review.
- **Redaction-receipt hooks are an extension point, not v1 scope.** Spec §7.2 lists them alongside the chain. Under the approved scope nothing leaves the machine, so redaction has no v1 consumer; when the outbound lane un-parks, receipts attach at the publication boundary through `evidence/derivation`, and the namespaced-extension discipline already admits them without a schema change.
- **F1 (from the program plan) is implemented here** as the Jinn-owned vocabulary profile with an upstream citation; `VOCABULARY_UPSTREAM.commit` must be filled with the real `main` commit read at implementation time, not left as the zero placeholder.

### Implementation amendments

- **2026-07-31 — Task 2 typecheck vs adversarial fixture (design-neutral test-fixture typing defect).** Commit `ea4432484` implemented Task 2's locale-free ordering and canonical JSON, but changed `"typecheck"` from `tsc --noEmit -p tsconfig.json` to `tsc --noEmit -p tsconfig.build.json` so the package typecheck would pass. That escape is **rejected**: full `tsc --noEmit -p tsconfig.json` remains the typecheck (tests included). The contradiction is intentional and local to the test: Task 2 Step 1 supplies the runtime-invalid value `{ a: [1, undefined] }`, while `JsonValue` intentionally excludes undefined array elements, so under `tsconfig.json` the call fails with `src/canonical.test.ts(27,41): TS2345`. Production types and production implementation do **not** change. **Approved disposition:** keep the historical Step 1 text; in the test only, cross the type boundary with an explicit unknown bridge — `import type { JsonValue } from "./canonical.js";` and `const invalid = { a: [1, undefined] } as unknown as JsonValue;` — then assert `serializeCanonicalJson(invalid)` throws `UndefinedArrayElementError`. Restore `"typecheck": "tsc --noEmit -p tsconfig.json"`. Re-dispatch Task 2 to apply only that repair.
- **2026-07-31 — Task 6 Zod 4 object-refine vs `BigInt` on invalid decimal strings (design-neutral Zod interop shim).** The plan's verbatim `SpanSchema` refine calls `BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)` unconditionally. Under Zod 4, object-level refinements can run on raw input even when field validators would reject values such as `"12.5"`, so `safeParse` throws `SyntaxError: Cannot convert 12.5 to a BigInt` and the plan test "rejects non-decimal-string timestamps" cannot pass. Design intent is unchanged: invalid decimal strings remain field errors; time-order is checked only when both fields are valid unsigned decimal strings. **Approved disposition:** keep the historical Step 3 text; in implementation only, guard the refine — `DecimalUnsigned.safeParse` both times first, return `true` if either fails (field validators own the error), otherwise compare with `BigInt`. No schema shape or ordering rule changes. Landed in commit `3a08658ca`.
- **2026-07-31 — Task 7 orphan-parent fixture typing (design-neutral test-fixture typing defect).** The plan's verbatim orphan-parent test assigns `orphan.spans[0]!.parentSpanId = "0".repeat(16)` after `record()` inferred `parentSpanId` as the literal `null`, which fails full `tsc --noEmit -p tsconfig.json`. Runtime intent is unchanged. **Approved disposition:** keep historical Step 1 text; in the test only, assign through a narrow unknown bridge such as `(orphan.spans[0] as unknown as { parentSpanId: string | null }).parentSpanId = "0".repeat(16)`. Production schema unchanged. Landed in commit `a36b55670`.
- **2026-07-31 — Task 9 golden fixture encoding (plan generator vs digest-pin tests).** Task 9 Step 3's `emit()` writes all JSON via `JSON.stringify(..., null, 2)`, but Step 1's golden tests require `documentDigest(loadGoldenBytes(name))` to equal the `.sha256` pin and `parseTrajectory` to accept those bytes — which is only true when the golden files are the **canonical sealed bytes**, not pretty-printed JSON. **Approved disposition:** keep historical Step 3 text; in the generator only, emit `trajectory/{valid,minimal}.json` as `new TextDecoder().decode(sealTrajectory(document).bytes)` (and pin `.sha256` from the same seal). Invalid, equivalence, and adversarial documents may remain pretty-printed because tests only `safeParse` them as objects. Landed in commit `400ccb5f1`.
