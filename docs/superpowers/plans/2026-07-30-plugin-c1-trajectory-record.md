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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./fixtures.js"`.

- [x] **Step 3: Write the fixture generator**

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

- [x] **Step 4: Generate the fixtures**

Run: `cd packages/evidence/trajectory && yarn generate:fixtures`
Expected: `fixtures written`; the `fixtures/` tree exists.

- [x] **Step 5: Write the loaders**

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

- [x] **Step 6: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS (all fixture tests green).

- [x] **Step 7: Commit**

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

- [x] **Step 1: Write the failing test**

`src/kit.test.ts`:

```ts
import { describeTrajectoryRecordConformance } from "./testing.js";

describeTrajectoryRecordConformance();
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `Failed to resolve import "./testing.js"`.

- [x] **Step 3: Write the kit**

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

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/evidence/trajectory && yarn test && yarn typecheck`
Expected: PASS — the conformance suite runs green in-package.

- [x] **Step 5: Commit**

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

- [x] **Step 1: Write the failing test**

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

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/evidence/trajectory && yarn test`
Expected: FAIL — `schemas/trajectory.schema.json` does not exist.

- [x] **Step 3: Write the generator**

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

- [x] **Step 4: Generate the schema and run the test**

Run: `cd packages/evidence/trajectory && yarn generate:schemas && yarn test && yarn typecheck`
Expected: `schema written`; PASS (4 new tests).

- [x] **Step 5: Commit**

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

- [x] **Step 1: Add the allowlist constants and the escape self-test**

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

- [x] **Step 2: Add the boundary block**

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

- [x] **Step 3: Run the boundary guard**

Run: `node --test .github/scripts/evidence-source-boundaries.test.mjs`
Expected: PASS.

- [x] **Step 4: Add the pack smoke script**

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

- [x] **Step 5: Run the pack smoke**

Run: `cd packages/evidence/trajectory && yarn build && yarn pack:smoke`
Expected: PASS — tarball carries dist, schemas, and fixtures; nothing leaks.

- [x] **Step 6: Wire CI**

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

- [x] **Step 7: Run the full local verification**

Run:

```bash
cd packages/evidence/trajectory && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn check:fixtures && yarn check:schemas && yarn pack:smoke
```

then from the repository root:

```bash
node --test .github/scripts/evidence-package-inventory.test.mjs && node --test .github/scripts/evidence-source-boundaries.test.mjs && node .github/scripts/evidence-packed-types.test.mjs
```

Expected: every command PASS.

- [x] **Step 8: Commit**

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
- **2026-07-31 — Task 12 testing-region `node:fs` vs `node:fs/promises` (design-neutral guard-pattern alignment).** Step 2's verbatim boundary block forbids `TRAJECTORY_FORBIDDEN_PACKAGES` (which includes `node:fs`) on testing files. The inventory helper treats `node:fs/promises` as matching the `node:fs` prefix, so the testing region that legitimately imports `node:fs/promises` (fixtures.ts, schema-parity.test.ts) would fail. **Approved disposition:** keep historical Step 2 text; apply the same Contribution/Retrieval pattern already in this file — filter `node:fs` out of the testing-region forbidden list and assert testing files never import bare `node:fs`. Production still forbids both `node:fs` and `node:fs/promises`. Landed in commit `aa12c877e`.
- **2026-07-31 — Task 12 pack-smoke consumer surface (mechanical adaptation beyond the three named substitutions).** Step 4 says copy derivation's `pack-smoke.mjs` with exactly three substitutions. A byte-faithful copy still asserts derivation exports; a passing trajectory smoke must assert trajectory public surface (`sealTrajectory`, `describeTrajectoryRecordConformance`, etc.). **Approved disposition:** keep the three named substitutions as the minimum; also retarget smoke consumers to trajectory exports. Not a design change. Landed in commit `aa12c877e`.
- **2026-07-31 — Task 12 host note (not a plan defect): npm 10.9.8 + vitest 4.1.8 peer install in pack-smoke.** On this operator host (Homebrew Node 22 / npm 10.9.8), installing `vitest@4.1.8` into the pack-smoke consumer fails unless `NPM_CONFIG_LEGACY_PEER_DEPS=true`. Derivation's script has the same shape and no baked-in flag. **Proposed disposition:** treat as host/CI toolchain note; do not encode into the package unless CI reproduces it. Mechanical verify on this host used the env var; CI uses `actions/setup-node` Node 22 independently.

---

## 2026-07-31 component-review correction (operator-ratified)

This section supersedes conflicting clauses in the plan body and in spec §7.2. Historical
rationale is preserved above; implementers follow this section.

### 1. Supersessions

| Prior claim | Disposition |
| --- | --- |
| Span IDs / derived identity as "anti-forgery" or "refuse fabricated spans" | **Removed.** IDs are deterministic reference/order identifiers; they catch naive reordering only. Security: digest + DSSE attestation + L4 replay. |
| `source.execution` on Trajectory `SourceSchema` | **Removed.** Execution relationship → derivation attestation + C4 Execution forward link. |
| Two-level verification (seal/signature vs replay) | **Superseded** by four layers L1–L4 (below). |
| F7 — skip record-layer DSSE; discovery announcements only | **Superseded** by typed Trajectory derivation attestation (not Trajectory JSON DSSE; not a fourth evidence family). |
| F9 / `TIMEBASE_EXTENSION_KEY` namespaced extension only | **Superseded** by required first-class `timebase` on Trajectory record and attestation predicate. Extension key deprecated. |
| `TraceIdInput` without `formatIri` | **Superseded** — `formatIri` is load-bearing for `deriveTraceId`. |
| `full` completeness allowing `skipped` | **Tightened** — `full` forbids `skipped` (absent or rejected). |
| Multi-algorithm digest support | **Restricted** — sha256 only for v1. |

### 2. Settled identifiers and types (C1 owns)

```ts
export const TRAJECTORY_PROTOCOL = "https://jinn.network/protocols/trajectory/1.0" as const;
export const TRAJECTORY_RECORD_KIND = "https://jinn.network/records/trajectory/1.0" as const;
export const TRAJECTORY_MEDIA_TYPE = "application/vnd.jinn.trajectory.v1+json" as const;
export const TRAJECTORY_VOCABULARY_PROFILE = "https://jinn.network/profiles/trajectory-vocabulary/1.0" as const;

export const TRAJECTORY_DERIVATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/trajectory-derivation/v1" as const;

export const TIMEBASES = ["source-epoch-ns", "synthetic-ordinal"] as const;
export type Timebase = (typeof TIMEBASES)[number];

interface TrajectoryRecord {
  protocol: typeof TRAJECTORY_PROTOCOL;
  source: {
    nativeTrace: DigestBearingDescriptor; // digest.sha256 required
    formatIri: string;
  };
  derivation: {
    decoderId: string;
    decoderVersion: string;
    vocabularyProfile: typeof TRAJECTORY_VOCABULARY_PROFILE;
  };
  timebase: Timebase; // REQUIRED
  traceId: string;
  spans: Span[];
  completeness: Completeness;
}

interface TraceIdInput {
  readonly sourceDigest: string;
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: string;
}
```

**Timebase semantics:** `source-epoch-ns` — `startTimeUnixNano` / `endTimeUnixNano` are Unix
epoch nanoseconds from the source (e.g. C4 hook feed). `synthetic-ordinal` — trace-relative
ordinal ticks, first tick `"0"`; no wall clock; used when source lacks timestamps (e.g. C2
`claude-code-stream-json`).

**Attestation surface:** see §Interface closure (2026-07-31) for full TypeScript definitions.

**Ownership:** C1 — record schema, timebase, identity, forward-link IRI, statement/predicate,
build/seal/verify (L1–L3), trust-core DSSE, conformance kit. C2 — pure handoff of
`BuildTrajectoryDerivationStatementInput` (no seal, no signer). C4 — build+seal with injected
signer, `derivedAt`, durable `derivation-links/` persistence.

### Interface closure (2026-07-31)

Supersedes incomplete attestation types in §2 above. C1 public surface — full definitions.

```ts
/** Repository digest form — capture/repository APIs and forward-link PropertyValue.value */
export type RepositorySha256Digest = `sha256:${string}`; // /^sha256:[0-9a-f]{64}$/

/** ResourceDescriptor / in-toto digest.sha256 form — bare 64 lowercase hex */
export type BareSha256Hex = string; // /^[0-9a-f]{64}$/

export function toBareSha256Hex(digest: RepositorySha256Digest): BareSha256Hex;
export function toRepositorySha256Digest(hex: BareSha256Hex): RepositorySha256Digest;
// Throws InvalidDocumentError (or dedicated typed error) on mismatch — never silently coerce.

export const TRAJECTORY_SUBJECT_NAME = "trajectory.json" as const;
export const TRAJECTORY_RECORD_IDENTIFIER_PROPERTY =
  "https://jinn.network/schemes/trajectory-record-sha256" as const;
// C1 owns this IRI. C4 imports from @jinn-network/evidence-trajectory.
// Forward-link PropertyValue.value MUST be RepositorySha256Digest of the Trajectory artifact.

export interface BuildTrajectoryDerivationStatementInput {
  readonly producerId: string; // non-empty
  readonly executionDigest: RepositorySha256Digest;
  readonly trajectoryDigest: RepositorySha256Digest;
  readonly nativeTraceDigest: RepositorySha256Digest;
  readonly formatIri: string; // absolute IRI
  readonly decoderId: string; // /^[a-z][a-z0-9-]*$/
  readonly decoderVersion: string; // non-empty
  readonly vocabularyProfile: typeof TRAJECTORY_VOCABULARY_PROFILE;
  readonly timebase: Timebase;
  /** Capture/finalization instant — calendar-strict RFC 3339. No ambient clock in C1. */
  readonly derivedAt: string;
}

export interface TrajectoryDerivationPredicate {
  readonly derivedAt: string; // calendar-strict RFC 3339 (isCalendarStrictRfc3339 at build/verify)
  readonly producer: { readonly id: string };
  /** Stable binding to the sole subject entry; MUST equal TRAJECTORY_SUBJECT_NAME */
  readonly trajectorySubject: typeof TRAJECTORY_SUBJECT_NAME;
  readonly execution: {
    readonly name: "execution.json";
    readonly digest: { readonly sha256: BareSha256Hex };
    readonly mediaType?: string;
  };
  readonly nativeTrace: {
    readonly name: "native-trace.bin";
    readonly digest: { readonly sha256: BareSha256Hex };
  };
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: typeof TRAJECTORY_VOCABULARY_PROFILE;
  readonly timebase: Timebase;
  // NO trajectory digest field — subject is the sole source of truth for Trajectory identity
}

export interface TrajectoryDerivationStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE; // from @jinn-network/evidence-protocol
  readonly subject: readonly [
    {
      readonly name: typeof TRAJECTORY_SUBJECT_NAME;
      readonly digest: { readonly sha256: BareSha256Hex };
      readonly mediaType: typeof TRAJECTORY_MEDIA_TYPE;
    }
  ]; // exactly one subject
  readonly predicateType: typeof TRAJECTORY_DERIVATION_PREDICATE_TYPE;
  readonly predicate: TrajectoryDerivationPredicate;
}

export interface SealTrajectoryDerivationAttestationInput {
  readonly statement: TrajectoryDerivationStatement;
  readonly signer: DsseSigner; // from @jinn-network/trust-core
  readonly signal?: AbortSignal;
}

export interface SealedTrajectoryDerivationAttestation {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly statement: TrajectoryDerivationStatement;
  /** Digest of envelopeBytes as RepositorySha256Digest */
  readonly digest: RepositorySha256Digest;
}

/**
 * Injected L2 authority port — dependency inversion, NOT a substitute verification standard.
 * C5/C7 composition wires this to trust-layer signature + key-binding verification.
 * C1 tests use fakes. C1 MUST NOT claim L2 success unless verified: true.
 */
export interface TrajectoryDerivationAuthorityVerifierInput {
  readonly envelopeBytes: Uint8Array;
  readonly payloadType: typeof DSSE_PAYLOAD_TYPE;
  readonly payloadBytes: Uint8Array;
  readonly preAuthEncoding: Uint8Array;
  readonly producerId: string;
  readonly derivedAt: string;
  readonly signal?: AbortSignal;
}

export type TrajectoryDerivationAuthorityVerifierResult =
  | { readonly verified: true; readonly signerKeyIds: readonly string[]; readonly detail?: string }
  | { readonly verified: false; readonly signerKeyIds?: readonly string[]; readonly reason: string; readonly detail?: string };

export type TrajectoryDerivationAuthorityVerifier = (
  input: TrajectoryDerivationAuthorityVerifierInput,
) => Promise<TrajectoryDerivationAuthorityVerifierResult>;

export interface VerifyTrajectoryDerivationAttestationInput {
  readonly envelopeBytes: Uint8Array;
  readonly executionRecordBytes: Uint8Array;
  readonly trajectoryRecordBytes: Uint8Array;
  readonly verifyAuthority: TrajectoryDerivationAuthorityVerifier;
  readonly signal?: AbortSignal;
}

export type TrajectoryDerivationLayerOutcome =
  | { readonly status: "pass" }
  | { readonly status: "fail"; readonly code: string; readonly message: string }
  | { readonly status: "not-evaluated"; readonly reason: string };

export interface TrajectoryDerivationVerificationLayers {
  readonly l1: TrajectoryDerivationLayerOutcome;
  readonly l2: TrajectoryDerivationLayerOutcome;
  readonly l3: TrajectoryDerivationLayerOutcome;
  readonly l4: TrajectoryDerivationLayerOutcome;
}

export type TrajectoryDerivationVerificationResult =
  | {
      readonly ok: true;
      readonly statement: TrajectoryDerivationStatement;
      readonly envelopeDigest: RepositorySha256Digest;
      readonly layers: {
        readonly l1: { readonly status: "pass" };
        readonly l2: { readonly status: "pass" };
        readonly l3: { readonly status: "pass" };
        readonly l4: { readonly status: "not-evaluated"; readonly reason: "replay-required" };
      };
      readonly signerKeyIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failedLayer: 1 | 2 | 3;
      readonly statement?: TrajectoryDerivationStatement;
      readonly layers: TrajectoryDerivationVerificationLayers;
      readonly reason: string;
      readonly code: string;
    };
```

**Build/seal behavior:**
- `buildTrajectoryDerivationStatement` — validates inputs (`derivedAt` via
  `isCalendarStrictRfc3339` from trust-core); converts repository digests → bare hex in
  ResourceDescriptors; returns statement with exactly one subject.
- `sealTrajectoryDerivationAttestation` — canonicalize statement → `payloadBytes`;
  `dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes)` → injected `DsseSigner` →
  `sealDsseEnvelope`; envelope digest = sha256 of envelope bytes as `RepositorySha256Digest`.
- **Throw** on invalid caller input to build/seal; **return** `{ ok: false }` for verification
  failures of supplied bytes. Malformed envelope → L1 fail; authority callback **not called**.

**L3 checks (`verifyTrajectoryDerivationAttestation`):**
1. `sha256(executionRecordBytes)` as repository digest equals attested execution digest
2. `sha256(trajectoryRecordBytes)` equals sole subject digest
3. `parseTrajectory(trajectoryRecordBytes)` matches statement: nativeTrace, formatIri, decoder,
   vocabulary, timebase
4. Execution Evidence: native-trace File entity whose bare hex equals attested native trace has
   **exactly one** `identifier` with `propertyID === TRAJECTORY_RECORD_IDENTIFIER_PROPERTY` and
   `value === trajectoryDigest` (repository form)
5. Named L3 failure codes: `l3-execution-digest-mismatch`, `l3-trajectory-digest-mismatch`,
   `l3-source-mismatch`, `l3-forward-link-missing`, `l3-forward-link-duplicate`,
   `l3-forward-link-mismatch`

**DSSE / guard obligations:**
- `JINN_DEPENDENCY_GRAPH['trajectory'].dependencies` =
  `['@jinn-network/evidence-protocol', '@jinn-network/trust-core']`
- `package.json` resolutions: `portal:../protocol`; trust-core `portal:../../trust/core`
- Inventory `expectedPortal` amended for `@jinn-network/trust-core` → `portal:../../trust/core`
- `TRAJECTORY_ALLOWED_DEPENDENCIES` includes `@jinn-network/trust-core`
- `TRAJECTORY_FORBIDDEN_PACKAGES` includes `@jinn-network/attestation-issuer`
- CI/packed-types: download/build trust-core dist for portal smoke

**F8 disposition:** Whole-artifact sealed digest supersedes per-span hash chain for **byte
integrity**. Ordinal span/trace IDs remain **ordering/reference only** (not anti-forgery). DSSE
derivation attestation provides **attribution**. L4 replay provides **factual verification**.

### 3. Implementation checklist

- [x] Remove `source.execution` from `SourceSchema`; update fixtures/generator/tests.
- [x] Add required `timebase: Timebase` to `TrajectoryRecordSchema`; export `TIMEBASES`, `Timebase`.
- [x] Add `formatIri` to `TraceIdInput` and `deriveTraceId` framing inputs.
- [x] Completeness: `full` rejects `skipped`; `partial` requires `skipped >= 1`; `empty` requires `spans.length === 0`.
- [x] Closed vocabulary guard on span attributes; reject `message.content`, `tool.args`, `tool.result`, `gen_ai.system`, arbitrary keys.
- [x] `serializeCanonicalJson` fail-closed: throw typed errors (`UnsupportedCanonicalValueError` or extend existing) for top-level undefined, bigint, function, symbol, Date, Map, Set, class instances, non-plain values; extension slots cannot silently coerce to `{}`.
- [x] Digest claims sha256-only for v1.
- [x] Export `TRAJECTORY_SUBJECT_NAME`, `TRAJECTORY_RECORD_IDENTIFIER_PROPERTY`,
  `RepositorySha256Digest`, `BareSha256Hex`, `toBareSha256Hex`, `toRepositorySha256Digest`.
- [x] Add `@jinn-network/trust-core` dependency + guard allowlist; forbid attestation-issuer.
- [x] Amend inventory `expectedPortal` for trust-core `portal:../../trust/core`.
- [x] Full attestation API per §Interface closure (2026-07-31); `derivedAt` required.
- [x] `verifyTrajectoryDerivationAttestation` with `verifyAuthority` port; L3 forward-link checks.
- [x] Kit: malformed envelope → L1 fail, authority not called; L2/L3/L4 cases per acceptance table.
- [x] `VOCABULARY_UPSTREAM.commit` via `git ls-remote <repo> refs/heads/main` at implementation; reject all-zero; evidence in PR — commit `c739977ae690961f36e435504e5c1febaef1f7f3` (snapshot 2026-07-31).
- [x] Fixture path containment: resolved URL must stay under fixture root (resist percent-encoded traversal).
- [x] Pack smoke: invoke packed conformance kit with all kit-loaded fixtures; `TRAJECTORY_RESULT` CI variable name; no legacy-peer-deps behavior encoding.
- [x] Namespaced-key discipline at nested extension points; namespaced extension seal→parse→compare test.
- [x] Remove anti-forgery language from Task 5 / README / kit comments.

### 4. Red→green acceptance tests

| Test | Expectation |
| --- | --- |
| `serializeCanonicalJson` rejects undefined (top-level member skip ok; array element not), bigint, function, symbol, Date, Map, Set, class instance | Each throws typed error |
| `TrajectoryRecordSchema` rejects `source.execution` if present | invalid |
| `TrajectoryRecordSchema` requires `timebase` | invalid without |
| `deriveTraceId` changes when `formatIri` changes | different traceId |
| `full` + `skipped: 1` | rejected |
| `partial` without `skipped` | rejected |
| `empty` + spans | rejected |
| Span with `message.content` attribute | rejected |
| Malformed envelope → verify | L1 fail; `verifyAuthority` **not called** |
| Authority returns `verified: false` | L2 fail |
| Bad Execution digest vs bytes | L3 fail (`l3-execution-digest-mismatch`) |
| Missing / duplicate / wrong forward link | L3 fail (named codes) |
| Wrong source/format/decoder/timebase vs Trajectory bytes | L3 fail (`l3-source-mismatch`) |
| Signed-but-unfaithful spans | L1–L3 pass; L4 `not-evaluated` |
| Non-calendar-strict `derivedAt` in build input | throws typed error |
| Namespaced extension round-trip | seal→parse→compare equal |
| `trajectoryFixtureUrl("..%2F..")` or traversal | throws |
| Pack smoke runs `describeTrajectoryRecordConformance` from packed tarball | PASS |

### 5. Findings disposition table

| ID | Finding | Kind | Disposition |
| --- | --- | --- | --- |
| Critical | Anti-forgery overclaim | Corrected claim | Remove language; kit documents honest outcomes; DSSE attributes; replay refutes at L4 |
| Critical | Closed attribute vocabulary | Implementation | Guard admits only `GEN_AI_ATTRIBUTES` + `JINN_ATTRIBUTES`; adversarial reject list in schema/kit |
| Critical | Remove `source.execution` | Implementation | Schema change; relationship via attestation + C4 forward link |
| Critical | Required declared timebase | Implementation | First-class `timebase` before C2/C4 depend; C4 hook uses `source-epoch-ns`, C2 stream uses `synthetic-ordinal` |
| Critical | F1 `VOCABULARY_UPSTREAM.commit` | Implementation | `git ls-remote` at implementation; reject `000…0`; PR evidence; no guessed SHA in docs |
| Important | Four-layer verification | Implementation + claim | Kit distinguishes L1–L4; verify API L2+L3 only |
| Important | Canonical serializer fail-closed | Implementation | Typed errors per rejected type; red→green tests |
| Important | Adversarial/kit coverage | Implementation | Review attacks; extension round-trip test |
| Important | Trace identity includes `formatIri` | Implementation | `TraceIdInput` + docs state identity fields |
| Minor | Completeness refinements | Implementation | full/partial/empty rules above |
| Minor | Fixture path containment | Implementation | `trajectoryFixtureUrl` rejects traversal |
| Minor | Pack smoke invokes kit + fixtures | Implementation | No copy/paste derivation names; tautological negatives removed |
| Minor | Namespaced-key discipline | Implementation | Nested extension points |
| Minor | sha256-only digests | Implementation + claim | v1 restriction documented |
| Minor | CI variable `TRAJECTORY_RESULT` | Implementation | Rename from prior name if present |
| Minor | Host npm `edgesOut` crash | Note only | Infrastructure/toolchain; do not encode legacy-peer-deps in package |
| F7 | Record-level DSSE skipped | Superseded | Trajectory derivation attestation (this correction) |
| F8 | Hash chain superseded | Corrected claim | Whole-artifact digest for byte integrity; IDs ordering-only; DSSE attribution; L4 factual verification |
| F9 | Timebase extension | Superseded | First-class `timebase` field |

---

## 2026-07-31 independent rereview findings resolution

Append-only. Does not amend the operator-ratified dated law above. These are
implementation / test / public-artifact defects against that law. Historical
checkboxes and prior amendments remain authoritative for earlier waves.

| ID | Severity | Finding | Disposition | Red→green test | Final evidence |
| --- | --- | --- | --- | --- | --- |
| C1-R1 | Critical | L1 used structural `parseDsseEnvelope`; undeclared top-level envelope members passed L1, invoked authority, and could succeed | Use trust-core `parseExactDsseEnvelope` (exact produced-envelope / round-trip bytes contract). L1 rejects undeclared envelope/signature members, duplicate JSON keys, non-canonical bytes/order/whitespace, malformed payload/base64, and any bytes not exactly the canonical producer envelope. Authority callback **not called** on any L1 failure. Do not invent a second DSSE parser. | Unknown top-level field; unknown signature field; duplicate key; non-canonical member ordering/whitespace; malformed encoding — each L1 fail, authority not called | `9bfd9785d` — `derivation.ts` uses `parseExactDsseEnvelope`; `derivation.test.ts` C1-R1 (4 tests); kit L1 envelope mutation; `yarn test` 130 passed |
| C1-R2 | Critical | L3 forward-link counted only already-correct links and could aggregate candidates across multiple matching File entities | Identify native-trace File entity/entities by attested sha256 + expected execution-record shape; require **exactly one** matching entity. On that entity collect **all** identifiers with `propertyID === TRAJECTORY_RECORD_IDENTIFIER_PROPERTY` regardless of value; require cardinality exactly one and value equals repository-form Trajectory subject digest. Wrong type, malformed value, missing, duplicate-correct, correct+wrong, duplicate entity, unrelated-entity-only each fail with deterministic L3 codes. Never aggregate across entities. | Each adversarial case named in disposition | `9bfd9785d` — `verifyForwardLink()` in `derivation.ts`; `derivation.test.ts` C1-R2 (7 tests) + missing forward link; kit duplicate forward link |
| C1-R3 | Critical | L2 used truthiness (`verified: "false"` could pass); AbortError became ordinary `l2-authority-error` | Runtime-validate callback result as exact closed contract (plain non-proxy object; `verified` boolean; `signerKeyIds` exact string array; optional reason/diagnostics exact types; no accessors/unknown members). Malformed result = L2 fail, never success. Success path: `verified === true` only; `signerKeyIds` semantically compatible with exact parsed envelope key IDs (no invented IDs). Check cancellation before/after await; aborted signal or recognized abort/cancellation rethrows C1 typed cancellation; ordinary throws remain L2 fail report. | Malformed string/number/object/array/accessor/proxy outputs; forged signer IDs; callback false; normal throw; pre-abort; during-abort; AbortError | `9bfd9785d` — `validateAuthorityResult()` + `TrajectoryDerivationCancelledError`; `derivation.test.ts` C1-R3 (13 tests); kit malformed/false authority |
| C1-R4 | Important | Canonicalization via `Object.entries`/property reads executed getters; proxy traps escaped as untyped errors | Descriptor-based, cycle-aware preflight before schema parsing **and** before canonical serialization/sealing. Reject accessor descriptors without invoking; reject symbol keys, proxies, class/non-plain prototypes, cycles, unsupported values at every depth. Wrap reflective trap failures in typed canonicalization/invalid-document taxonomy. `util.types.isProxy` allowed (no I/O). Getter counter remains zero in tests. | Top-level/nested getter, setter, proxy ownKeys/getPrototypeOf/getOwnPropertyDescriptor trap, cycle, extension-slot | `9bfd9785d` — `preflight.ts` + `canonical.ts`/`sealing.ts` hooks; `preflight.test.ts` (7 tests); getter counter zero |
| C1-R5 | Important | Nested undeclared keys (e.g. `source.nativeTrace.bad`) passed via `z.looseObject`; limited direct canonical guard | Every core/nested schema object rejects arbitrary undeclared keys. Extension surfaces admit only explicit absolute-IRI/namespaced extension keys under law; recursively validate JsonValue. No unconstrained loose object. Adversarial cases at nativeTrace, source, derivation, completeness, span, event/link/status/attribute descriptor, attestation subject/predicate/producer/descriptors as applicable. Legitimate namespaced extension survives seal→parse→compare. | Nested undeclared-key adversarial suite + legitimate extension round-trip | `9bfd9785d` — `closedObjectSchema`/`JsonExtensionValueSchema`; `schema.ts` closed nested surfaces; `nested-native-trace-key` fixture; `schema.test.ts`; kit extension round-trip |
| C1-R6 | Important | Published JSON Schema allowed any nonempty attribute key and understated runtime-only checks | Regenerate public schema to structurally constrain closed attribute vocabulary (reject `message.content`, `tool.args`, `tool.result`, `gen_ai.system`, arbitrary keys); encode expressible completeness/sha256/timebase/`source.execution`/nested-key restrictions; accurately enumerate unavoidable runtime refinements (no false "three checks only"). AJV-vs-runtime parity for closed-vocabulary + completeness adversarial cases + namespaced extensions. Update pins. | AJV parity suite for vocabulary/completeness/extension cases; regenerated schema pins | `9bfd9785d` — `generate-schemas.mjs` attribute enum + completeness `allOf` + closed nested keys; `schema-parity.test.ts` (6 tests); `yarn generate:schemas --write` |
| C1-R7 | Important | Shipped kit covered only manifest/malformed JSON/happy attestation; "signed-but-unfaithful" kept faithful digest and asserted L3 failure | Expand shipped kit/fixtures: tail truncation, append, span-content substitution, whole-list fabrication, unsigned/unbound, malformed authority result, callback false, exact-envelope mutations, all L3 mismatch/cardinality/entity-confusion, nested-extension failures, legitimate extension round-trip. Construct true signed-but-unfaithful: mutate Trajectory, reseal bytes/digest, update sole subject + Execution forward link, sign exact statement → L1–L3 pass, L4 `not-evaluated`/`replay-required`. Pack smoke imports and runs expanded packed kit and every loaded fixture; no tautologies/skips. | Expanded kit matrix + corrected unfaithful construction; pack smoke all fixtures | `9bfd9785d` — `testing.ts` expanded kit (24 tests, was 15); signed-but-unfaithful L1–L3 pass; `yarn pack:smoke` 24 passed |
| C1-R8 | Minor | F1 all-zero commit rejection not explicit in tests | Add test `VOCABULARY_UPSTREAM.commit !== "0".repeat(40)` in addition to regex/actual pin. Keep pinned upstream SHA/date unless intentionally refreshed via evidenced `git ls-remote`. | Explicit all-zero inequality assertion | `9bfd9785d` — `vocabulary.test.ts` all-zero inequality; pin unchanged (`c739977…`, snapshot 2026-07-31) |

### Implementation checklist (independent rereview)

- [x] C1-R1 — `parseExactDsseEnvelope` + L1 exact-envelope regressions; authority not called on L1 fail — `9bfd9785d`
- [x] C1-R2 — unambiguous single-entity forward-link cardinality + adversarial L3 suite — `9bfd9785d`
- [x] C1-R3 — closed authority-result validation, strict `verified === true`, typed cancellation, forged key-ID rejection — `9bfd9785d`
- [x] C1-R4 — descriptor preflight before parse and seal; getter counter zero; typed trap wrapping — `9bfd9785d`
- [x] C1-R5 — closed nested schemas + namespaced extension discipline + seal→parse→compare — `9bfd9785d`
- [x] C1-R6 — regenerate JSON Schema + AJV parity for vocabulary/completeness/extensions — `9bfd9785d`
- [x] C1-R7 — expand shipped kit/fixtures + correct signed-but-unfaithful + pack smoke coverage — `9bfd9785d`
- [x] C1-R8 — explicit all-zero `VOCABULARY_UPSTREAM.commit` rejection test — `9bfd9785d`

### Acceptance

All eight rows above move from pending to commit SHA + command evidence only after red→green
verification on this branch. L4 remains external/`not-evaluated` from the verify API.

---

## 2026-07-31 C1-R9 — Evidence CI npm peer-cycle toolchain pin

Append-only. Shared Evidence CI **workflow infrastructure** required to make the
component gate executable. **Not** a C1 package defect; C1 package source /
peer ranges / Vite pins / pack-smoke scripts are unchanged.

| Field | Record |
| --- | --- |
| ID | C1-R9 |
| Severity | Shared CI / toolchain (blocks foundation pack-smoke) |
| Symptom | Evidence Repository `pack:smoke` consumer install fails in npm Arborist: `Cannot read properties of null (reading 'edgesOut')` after repository tests and package creation already passed |
| Attempts | Three exact-head attempts on `245149614` (and prior identical foundation path) failed with the same error under Node `22.23.1` + npm `10.9.8` |
| Runtime observed | Node `22.23.1`, npm `10.9.8` (actions/setup-node floating `22` currently resolves here) |
| Cause | Registry graph drift (Vite `8.2.0` peer graph) exposing an npm peer-cycle bug in Arborist on npm 10.9.8; a prior successful run used the same Node/npm before the registry graph drifted |
| Upstream fix | npm `11.19.0` contains the Arborist guard/fix (npm/cli PR #9808) |
| Disposition | Pin Evidence CI `actions/setup-node` to exact Node `22.23.1`; install and assert exact npm `11.19.0` (PATH/`GITHUB_PATH`) before every job/step path that runs package `pack:smoke` consumer install. Prefer one named reusable step. Keep Yarn 4.13.0 / corepack unchanged. **Forbidden:** `legacy-peer-deps`, package peer-range changes, Vite freeze, weakening immutable installs, skipping pack-smoke, modifying package scripts |
| Rollback | Revert the workflow pin only if npm ≥11.19.0 is the proven root of a new regression **and** npm 10.9.8 + current registry graph is re-proven green without forbidden workarounds; do not silently reintroduce floating Node 22 or npm 10.9.8 while pack-smoke remains on the vulnerable Arborist path |
| Architecture gate | Workflow architecture test fails if setup-node floats, if a pack-smoke job lacks the preceding npm 11.19.0 install/assert step, or if `legacy-peer-deps` appears in Evidence CI |
| Final evidence | `4290a826e` — eleven `setup-node` pins at `22.23.1`; nine jobs with `Install npm 11.19.0 for pack-smoke` before `pack:smoke`; `.github/scripts/evidence-ci-workflow.test.mjs` (4 tests); guards 18/18; isolated temp-prefix npm `11.19.0` assert OK; no `packages/**` changes |

### Implementation checklist (C1-R9)

- [x] Append this disposition (docs) — `3d480e708`
- [x] Pin every relevant Evidence CI `setup-node` to `22.23.1`
- [x] Named npm `11.19.0` install/assert step before every pack-smoke path (foundation, components, derivation, bridge, retrieval, trajectory, contribution, catalog-sqlite, local-runtime)
- [x] Architecture test covers float / missing npm pin / forbidden legacy-peer-deps
- [x] Local validation of architecture test + isolated npm 11.19.0 prefix install/assert

---

## 2026-07-31 final rereview findings resolution

Append-only after C1-R1–R9. Ratified architecture/law unchanged. These are
implementation / test / public-artifact / CI-script defects with demonstrated
counterexamples. Historical checkboxes remain authoritative for earlier waves.

| ID | Severity | Demonstrated counterexample | Minimal disposition | Red→green test | Final evidence |
| --- | --- | --- | --- | --- | --- |
| C1-R10 | Critical | Exact DSSE envelope with pretty-printed/noncanonical but schema-valid statement payload accepted; authority invoked; verify succeeds | After `parseExactDsseEnvelope` + strict closed statement validation, canonicalize validated statement via standard producer path and byte-compare to decoded `payloadBytes` before authority. Mismatch → L1 fail, authority uncalled. Close statement/predicate/descriptor schemas so unknown fields cannot normalize away. No new DSSE format; no signature verify before L1. | Pretty-print whitespace; reordered members; alternate escaping/number forms if schema admits numbers; duplicate keys; schema-valid noncanonical payload in exact envelope — each L1 fail, authority not called | [x] `2a428bff4` — `yarn test` derivation-conformance R10; `l1-payload-noncanonical`; authority mock uncalled |
| C1-R11 | Critical | Authority-result validation via `Object.keys` misses non-enumerable own members/accessors; hidden undeclared members accepted; getters execute | Before any field read: reject Proxy; `Reflect.ownKeys` + own descriptors under typed-error normalization. Exact ordinary plain object; only declared string keys; all own fields enumerable data descriptors; no symbols/accessors/non-enumerable/prototype tricks/cycles/hostile nested arrays. Nested `signerKeyIds`/reason/diagnostics via descriptor.values. Malformed → L2 fail; getter counter zero. | Non-enumerable accessor/field; symbol; proxy traps; sparse/augmented/accessor/cyclic arrays; malformed descriptors; nested hostile results | [x] `2a428bff4` — `authority-validation.ts`; derivation-conformance R11 adversarial suite; getter counter zero |
| C1-R12 | Important | Preflight incomplete for arrays: array accessors execute; cyclic arrays raw RangeError; Proxy trap raw error; attestation statement getter executes during sealing | Proxy-check every object including arrays before other reflection; normalize reflective failures to typed C1 errors. One WeakSet for all traversable object/array cycles. Descriptor-walk arrays (length + canonical index data descriptors only); recurse via descriptor.value. Preflight before Zod/property read in build/seal/verify for caller JSON; do not preflight signer/AbortSignal. Getter-zero tests for statement/build input, hostile arrays, cycles, Proxy traps. | Statement/build getters; hostile arrays top/nested/extension; cyclic array/object; Proxy traps; raw-error normalization | [x] `2a428bff4` — `preflight.ts` rewrite + build/seal wiring; `preflight.test.ts` hostile-array/getter-zero |
| C1-R13 | Important | Runtime accepts `source.nativeTrace["network.jinn.note"]`; AJV rejects; top-level extension values unconstrained; `$comment` mislabels encoded completeness as runtime-only | Generated schema: deterministic `patternProperties`/`propertyNames` + recursive JsonValue at every runtime extension surface; core undeclared keys reject; top-level/nested extension values same recursive constraint (not `{}`). `$comment` lists only genuinely runtime-only refinements. AJV/runtime parity for valid extensions, arbitrary keys, invalid non-JSON, completeness. Regenerate pins. | Valid nested/top-level extensions pass+preserve; arbitrary key fails; undefined/non-JSON typed runtime failure; completeness parity | [x] `2a428bff4` — `generate-schemas.mjs` `$defs.JsonExtensionValue`; regenerated schema; `schema-parity.test.ts` nested nativeTrace AJV pass |
| C1-R14 | Important | Packed kit covers only one envelope mutation, one malformed/false authority, one duplicate-link; omits most R1/R2/R3/R4 matrix | Port full public `testing` attack matrix: exact-envelope variants; all L3 link/entity/source mismatches; authority false/throw/malformed/hidden/proxy/cancel; hostile JSON getter-zero; retain correct signed-but-unfaithful L1–L3 pass / L4 replay-required. Pack smoke loads every fixture and runs expanded matrix. Minimal driver extension only if needed. No tautologies/private imports/skips. | Expanded packed kit matrix covering R1–R4/R10–R13 public cases; pack smoke all fixtures | [x] `2a428bff4` — `derivation-conformance.ts` exported via `testing`; pack smoke 55 tests (was 24) |
| C1-R15 | Important | Aggregate `verify` fails hermetically: `evidence-packed-types.test.mjs` runs `corepack yarn build` in trust-core without install; local preinstalled state masked it | Run `corepack yarn install --immutable` in `packages/trust/core` before build in packed-types script (match other deps). Guard ordering in script test if present. Validate via temp clone/worktree or temporary move of ignored install state with guaranteed restore. No trust-core source/lockfile edits. Keep Node/npm R9 pins. | Clean/simulated-clean trust-core install state → packed-types succeeds; ordering assertion | [x] `2a428bff4` — install-before-build + ordering self-check; clean-checkout proof (node_modules moved, packed-types green, restored) |
| C1-R16 | Important | Workflow test compares step-name position while matching commands anywhere; count ≥9; mutant moving install after pack:smoke can pass | Semantic job/step parse (focused indentation-aware for this YAML). Exact expected pack-smoke job IDs. Ordered steps: named npm step must contain install + GITHUB_PATH + version assert and precede every `pack:smoke` step. Exact 11 setup-node jobs at 22.23.1. Mutation tests for name-before-but-command-after, omitted job, extra ungoverned pack-smoke job, missing PATH/assert, floating Node, legacy workaround. | Mutation suite fails on each listed mutant; green on current workflow | [x] `2a428bff4` — semantic `evidence-ci-workflow.test.mjs`; 9 job IDs; 8 mutation tests; 27/27 evidence guards |
| C1-R17 | Minor | `trajectoryFixtureUrl("..\\..\\outside")` escapes; POSIX treats backslashes literally before URL normalization | Reject raw backslashes and case-insensitive percent-encoded slash/backslash/separator forms (incl. double-encoded where bounded decoding reveals separator/traversal) before URL resolution. After resolution: file URL → filesystem path; separator-aware containment under canonical fixture root. Reject absolute URLs, drive-style, raw/encoded `..`, query/hash if outside contract. Valid nested names still work. | Raw `\\`, `%5c`, `%2f`, mixed case, double encoding, final-path escape; valid nested still OK | [x] `2a428bff4` — `fixtures.ts` separator-aware containment; expanded `fixtures.test.ts` |

### Implementation checklist (final rereview)

- [x] C1-R10 — statement payload canonical-byte equality before authority (`2a428bff4`)
- [x] C1-R11 — descriptor-safe authority-result closure; getter counter zero (`2a428bff4`)
- [x] C1-R12 — preflight arrays/proxies + attestation JSON inputs (`2a428bff4`)
- [x] C1-R13 — published JSON Schema extension parity + honest `$comment` (`2a428bff4`)
- [x] C1-R14 — public conformance kit full attack matrix + pack smoke (`2a428bff4`)
- [x] C1-R15 — hermetic trust-core install before packed-types build (`2a428bff4`)
- [x] C1-R16 — semantic Evidence CI architecture guard + mutation tests (`2a428bff4`)
- [x] C1-R17 — backslash/encoded-separator fixture containment (`2a428bff4`)

### Acceptance

All eight rows move from pending to commit SHA + command evidence only after
red→green verification. L4 remains external/`not-evaluated`. Preserve R9 Node
22.23.1 / npm 11.19.0 pins; no workaround weakening.

---

## 2026-07-31 exact-head rereview findings resolution

Append-only after C1-R1–R17. Ratified architecture/law unchanged. These are
implementation / public-kit / CI-guard defects with demonstrated probes.
Preserve R9 Node 22.23.1 / npm 11.19.0, R15 hermetic packed-types, R16
semantics, L4 external. No workaround weakening.

| ID | Severity | Demonstrated probe | Minimal disposition | Red→green test | Final evidence |
| --- | --- | --- | --- | --- | --- |
| C1-R18 | Important | `seal`/`verify` read statement/signer/signal/envelope/authority from caller top-level input before descriptor-safe preflight; accessor probes execute (seal×2, verify×1); seal can throw raw; verify can misclassify as malformed envelope | Strict descriptor snapshot/validation of each public port input **before any property read**: reject Proxy first; `Reflect.ownKeys` + own descriptors under typed-error normalization; exact declared own string keys; enumerable data descriptors only. Extract exclusively from descriptor `.value` into inert snapshot. Allow expected non-JSON ports by exact field (`DsseSigner`/authority verifier functions, `AbortSignal`, `Uint8Array`) — never JSON-preflight those. JSON-preflight extracted authority-bearing statement/record members before Zod/canonical. Invalid seal → typed invalid-input throw; invalid verify port → ratified typed invalid-input (not L1 envelope unless envelope bytes invalid). Cancellation intact. | Top-level getters/setters on every field; unknown/hidden/symbol; proxy traps; wrong function/signal/byte type; getter count zero; valid frozen/null-prototype if law allows | [x] `776e0ee0e` — `port-snapshot.ts` + build/seal/verify wiring; getter-zero tests; verify invalid port throws not L1 |
| C1-R19 | Important | Preflight skips absent array descriptors / ignores extra own keys → sparse becomes `[]`, augmented loses property; authority-validation accepts sparse/augmented `signerKeyIds` | For every JSON/authority array: descriptor-inspect all own keys once; allowed = non-enumerable writable `length` (Array invariant) + dense enumerable data indices `0..length-1`. Reject holes, extra string keys, noncanonical numeric keys, symbols, accessors, non-enumerable indices, augmented properties. No `value.length`/element reads before descriptor validation. Same helper for canonical preflight and authority arrays. Typed errors; no silent normalization. | Sparse begin/middle/end; `length > own indices`; augmented string/symbol; accessor index; non-enumerable index; cyclic nested; authority sparse/augmented | [x] `776e0ee0e` — `dense-array.ts`; preflight + authority-validation; `dense-array.test.ts` |
| C1-R20 | Important | Fractional namespaced extension: Zod accepts, sealing rejects, JSON Schema rejects; extension integer lacks I-JSON safe bounds; empty/multi-variant OTLP AnyValue: runtime rejects, JSON Schema accepts | Align to `canonical.ts` I-JSON safe-integer law (`Number.isInteger && Number.isSafeInteger`). `JsonExtensionValueSchema`: finite safe integers only recursively; fractional/unsafe fail before sealing. Generated extension JSON Schema: integer min `-9007199254740991` max `9007199254740991`. AnyValue: exactly one of string/bool/int/double via `oneOf`/required/closed branches + existing regexes. Runtime+AJV parity for min/max safe, unsafe ±, fractional, empty AnyValue, every single/pair/multi variant, unknown field. Regenerate pins; honest `$comment`. | Extension number + AnyValue parity matrix | [x] `776e0ee0e` — safe-integer schema + AnyValue `oneOf`; regenerated pin; `schema-parity.test.ts` |
| C1-R21 | Important | Packed kit omits alternate escaping, canonical unknown statement fields, sparse/augmented nested arrays, top-level seal/verify accessor probes — R18–R20 can pass pack smoke | Extend public driver/kit for R18/R19/R20: alternate escaping + unknown statement fields fail correct layer, authority uncalled; hostile seal/verify ports getter-zero + typed refusal; sparse/augmented arrays fail; schema/runtime parity for extension numbers/AnyValue where public. Retain R1–R17 matrix + signed-but-unfaithful L1–L3 pass/L4 replay-required. Pack smoke: packed public/testing only, every fixture, no skips/tautologies/private imports. | Expanded packed kit covering R18–R20 probes | [x] `776e0ee0e` — derivation-conformance R18–R20 block; pack smoke 60 tests (was 55) |
| C1-R22 | Important | Workflow guard only records steps with `name:`; unnamed `- run: yarn pack:smoke` before npm pin is invisible and accepted | Semantic parser: ordered step for every YAML sequence item under `steps` (named or anonymous); attach all `run`/`uses`/`with`. Every step whose run invokes `pack:smoke` (anonymous/multiline) must follow complete npm pin step. Exact expected job-set; extra pack-smoke job rejected. Mutation tests: anonymous one-line `- run`, anonymous block `- run: \|`, named omitted, anonymous pre-pin insertion — each fails. No broad YAML framework/undeclared dep. | Mutation suite for anonymous/named pack-smoke pre-pin cases | [x] `776e0ee0e` — anonymous `parseSteps`; 4 mutation tests; evidence guards 31/31 |
| C1-R23 | Minor | `trajectoryFixtureUrl("https://example.com/outside")` treated as relative `https:/...` under fixtures | Before decoding/resolution: reject RFC3986 scheme prefix (case-insensitive), scheme-relative `//`/`\\`, `file:` and drive-style. Retain R17 separator/traversal rejection; reject query/hash and NUL/control. Final `fileURLToPath` containment authoritative. | http/HTTPS/file/data/custom schemes; `//host`; backslash authority; drive forms; encoded scheme/authority if decoding reveals; valid nested OK | [x] `776e0ee0e` — `fixtures.ts` scheme/authority rejection; expanded `fixtures.test.ts` |

### Implementation checklist (exact-head rereview)

- [x] C1-R18 — descriptor-safe seal/verify port-object boundary before any property read (`776e0ee0e`)
- [x] C1-R19 — dense unaugmented arrays at every JSON/authority closure boundary (`776e0ee0e`)
- [x] C1-R20 — runtime + published schema share exact I-JSON number / AnyValue law (`776e0ee0e`)
- [x] C1-R21 — exported packed kit includes R18–R20 demonstrated matrix (`776e0ee0e`)
- [x] C1-R22 — workflow guard parses anonymous run steps + mutation tests (`776e0ee0e`)
- [x] C1-R23 — reject URI/authority-shaped fixture paths before normalization (`776e0ee0e`)

### Acceptance

All six rows move from pending to commit SHA + command evidence only after
red→green verification. L4 remains external/`not-evaluated`.

---

## 2026-07-31 second exact-head whole-component review resolution

Append-only after C1-R18–R23. Ratified law unchanged. Probe-first: reproduce
each review probe red before implementation; green exact probe + full suite.
Preserve R9 Node/npm pins, R15 hermetic packed-types, no `legacy-peer-deps`,
L4 external. Do not check off without exact adversarial case in source tests
and packed public kit where required.

| ID | Severity | Exact review probe | Violated law | Fixed disposition | Red evidence | Green evidence |
| --- | --- | --- | --- | --- | --- | --- |
| C1-R24 | Critical | BOM-prefixed canonical Trajectory bytes validate via `parseExactWithSchema` string compare after `TextDecoder` strips UTF-8 BOM; digests differ | Exact canonical-byte identity: accepted bytes must equal sealed/canonical producer bytes | After fatal UTF-8 decode + JSON parse + hardened schema + canonical reserialization, compare **recanonicalized Uint8Array to original input bytes** (length + byte-for-byte). Never decoded-string equality. BOM fails. Audit Trajectory/Execution-as-consumed/statement payload/DSSE exact parsers. Typed errors. Tests + packed kit: canonical pass; BOM fail; alternate escape fail; whitespace/key-order fail; invalid UTF-8 fail; digest of rejected bytes never identity; authority uncalled pre-L2 | RED `sealing.test.ts` BOM/`\u0061`/pretty-print probes before `bytesEqual` fix | GREEN `sealing.ts` `bytesEqual(recanonicalized, bytes)`; `sealing.test.ts` + `testing.ts` BOM/UTF-8/escape; L1 authority-not-called unchanged |
| C1-R25 | Critical | Conforming Execution (`validateExecutionEvidence(...).conforms === true`) with primary + decoy File accepted when attestation names decoy digest | L3 must bind attested nativeTrace to the **primary Execution's** unique native-trace relation, never any matching File | Validate Execution via protocol `validateExecutionEvidence`; resolve exactly one primary Execution entity then its unique `subjectOf` native-trace per protocol; require admitted File shape + digest === attested `nativeTraceDigest`. Never scan all Files by digest. Reject missing/duplicate/ambiguous/wrong-type/dangling/decoy/contradictory relations. Forward-linked: exactly one C1 link on **that** resolved entity. Sealed-parent (R26): same digest binding, no parent forward-link requirement. Tests + kit: golden, decoy digests, duplicate primary/subjectOf, wrong link, link-only-on-decoy, exact correct. Reviewer decoy probe must fail L3 | RED decoy probe passed under old File-by-digest scan | GREEN `execution-linkage.ts`; decoy attestation → `l3-source-mismatch`; golden-base fixture |
| C1-R26 | Important | Statement/API has no `linkageMode`; verify always requires forward link | Approved closed modes: `forward-linked` (C4) vs `sealed-parent` (C2) | Required closed `linkageMode: "forward-linked" \| "sealed-parent"` on signed predicate/identity + TS/Zod/JSON Schema/build/seal/verify/fixtures/README/driver/pins. No default/inference. Mode tamper-evident at L1/L2. Both modes: exact Execution/Trajectory bytes, primary/native-trace resolution + digests, subject binding, L2, shared L3. `forward-linked`: exactly one correct C1 link on resolved native trace. `sealed-parent`: require **no** C1-owned Trajectory link on sealed parent (reject contradictory present link); no parent mutation. Wrong/unknown/missing/swap/mode mismatch fail precise layer. Golden fixture each mode; already-sealed golden Execution succeeds sealed-parent. Document C2/C4 ownership | RED missing `linkageMode` → 80× build failures | GREEN `LINKAGE_MODES` on predicate/build/port; sealed-parent golden; README table |
| C1-R27 | Important | Preflight Proxy `getPrototypeOf` trap; fake `AbortSignal.aborted` getter; proxied Uint8Array raw Error; proxied authority-thrown escapes raw | Hostile reflection/cancellation must be trap-zero and typed | `isProxy` before instanceof/getPrototypeOf/property reads/typed-array/Error classification. Trap-safe type checks; proxied value rejected with no further traps. Genuine native AbortSignal only; use built-in `AbortSignal.prototype.aborted` against verified signal (never caller `.aborted`). Port snapshots descriptor-only. Normalize authority-thrown `unknown` without instanceof/name/message until proxy-safe. Genuine abort → typed cancel; else typed authority failure. No raw/wrong L1. Tests: trap counters zero; fake signal getter zero; proxy Uint8Array typed invalid-input; proxied throw typed L2; genuine abort typed cancel | RED `readErrorName`/`readAbortSignalAborted` own-descriptor paths invoked traps | GREEN `isAbortLikeError` proxy-gated; prototype-only `readAbortSignalAborted`; `hostile-reflection.test.ts` + conformance trap-counter probes |
| C1-R28 | Important | Exported `TrajectoryRecordSchema.safeParse` invokes namespaced extension getter and accepts | Public exported validators are the runtime contract | Audit every public Zod schema accepting record/statement/span/extension; harden facades from `z.unknown()` with descriptor/proxy/array/cycle/string/number preflight **before** private structural schemas. No `.superRefine` after object schema. Preserve declared output types. Prefer hardening all exported public validators. Tests + kit: getter/setter/proxy/symbol/non-enumerable/sparse/augmented/cyclic → zero trap + fail; reviewer exact `TrajectoryRecordSchema.safeParse` getter probe fails without invoking getter | RED getter probe invoked getter | GREEN `schema.ts` preflight facade; `schema.test.ts` + packed getter probe |
| C1-R29 | Important | Packed kit R21 fakes: “alternate escaping” is pretty-print; no seal-port accessor; no unknown statement + authority non-call; no packed R20 matrix | Packed kit must genuinely cover R1–R28 attack law | Real `\uXXXX` alternate escape noncanonical JSON; packed seal+verify top-level accessors getter-zero; unknown statement field + valid DSSE + authority non-call; BOM; invalid UTF-8; nested sparse/augmented; decoy native-trace/subjectOf; both linkage modes + contradictions; exported-schema getter/proxy; packed AJV/runtime R20 matrix from packed public schema only. Pack smoke: packed public/testing only, every fixture, no source/private/skips/tautologies. Manifest/count assertion for named required cases. Preserve prior vectors + signed-but-unfaithful L1–L3/L4 | RED pack smoke 60; no manifest count | GREEN pack smoke **69**; adversarial manifest **8** assert; execution golden in tarball |
| C1-R30 | Important | Global eleven `setup-node` count; remove from Trajectory + duplicate in Architecture passes | Per-job setup-node binding | For **each** required job: exactly one `actions/setup-node` at required Node version. Reject missing/duplicate/moved/wrong-version/extra. Preserve exact job set + npm pin/order. Mutations: reviewer Trajectory-remove/Architecture-duplicate; move across jobs; duplicate same job; wrong version; anonymous pack-smoke before pin — all fail. No global count authority | RED trajectory-remove + architecture-duplicate passed global count | GREEN per-job binding (11 jobs); trajectory-remove/architecture-duplicate/wrong-version mutations fail; guards **34/34** |

### Implementation checklist (second exact-head whole-component)

- [x] C1-R24 — byte identity rejects UTF-8 BOM and every non-exact representation (source + packed kit)
- [x] C1-R25 — L3 resolves primary Execution native trace only; decoy File probe fails
- [x] C1-R26 — closed attested `linkageMode` forward-linked \| sealed-parent + both-mode goldens/APIs
- [x] C1-R27 — trap-zero Proxy/AbortSignal/Uint8Array/thrown-value paths; typed errors
- [x] C1-R28 — exported public Zod validators preflight before Zod object reads
- [x] C1-R29 — packed kit genuine R1–R28 matrix + manifest/count assertion
- [x] C1-R30 — CI guard per-job setup-node binding + reviewer bypass mutation

### Acceptance

All seven rows move from pending to commit SHA + red/green probe evidence only after
red→green verification. L4 remains external/`not-evaluated`.

---

## 2026-07-31 third exact-head whole-component review resolution

Append-only after C1-R24–R30. Ratified law unchanged. Exact-probe-first: reproduce
each reviewer probe RED before implementation; green exact probe + packed-public
counterpart where required + full suite. Preserve two linkage modes, R24 byte
exactness, R25 primary/native resolution, R27 trap safety, R9 toolchain pins,
R15 hermetic packed-types, L4 external, no `legacy-peer-deps`. No check-off from
broad tests alone.

| ID | Severity | Exact probe | Violated law | Minimal disposition | Red evidence | Green evidence |
| --- | --- | --- | --- | --- | --- | --- |
| C1-R31 | Important | `preflightCanonicalInput` uses `instanceof Uint8Array` before proxy rejection; throwing `getPrototypeOf` proxy escapes raw | Proxy rejection before every object operation | Immediately after primitive/null classification and before any `instanceof`/`Array.isArray`/prototype/typed-array/descriptor/coercion/constructor access: trap-free `isProxy` reject. Centralize ordering on every recursive path. Audit preflight, port snapshots, schema facades, authority results, callback throws, exact-byte inputs. Source + packed probes with throwing trap counters; raw sentinel never escapes; expected trap counts zero | [x] `preflight.test.ts` getPrototypeOf-trap RED→GREEN; `third-review-probes` `preflight-getPrototypeOf-trap-before-instanceof` packed | [x] same probe in packed kit |
| C1-R32 | Important | Public `SpanSchema`, `JsonExtensionValueSchema`, `AttributeSchema`, `SpanEventSchema`, `SpanStatusSchema`, `topLevelRecordSchema` execute hostile getters/proxy traps | Every exported structured Zod schema preflight-first | Enumerate every schema/validator from public + testing entrypoints. Private raw structural schemas + public hardened facades from `z.unknown()` with full preflight before Zod object/array reads. Internal composition uses raw schemas only after containing facade preflighted whole tree. Factories return hardened facades or become private and removed from exports consistently. Preserve types/ergonomics/parity. Source + packed probes for every exported schema/factory; trap/getter counts zero | [x] `schema-facade.ts` + core/facade split; `span-schema-proxy-trap-zero`, `json-extension-schema-proxy-trap-zero` | [x] packed kit probes |
| C1-R33 | Important | Pre-aborted genuine signal still invokes signer; signer-thrown genuine `DOMException("AbortError")` escapes instead of `TrajectoryDerivationCancelledError` | Seal cancellation matches verify cancellation | Trap-safe signal validation; assert cancellation immediately before seal work that can call signer, immediately before signer, and immediately after signer settles via intrinsic aborted read. Guarded signer catch: genuine non-proxy AbortError and/or now-aborted genuine signal → `TrajectoryDerivationCancelledError`; other throws → typed signer/seal failure. Pre-abort: signer uncalled. Tests/packed: pre-abort call count 0; signer AbortError; fake/proxy/subclass signal; async late abort; ordinary hostile throw non-cancel | [x] `seal-pre-abort-signer-uncalled`, `seal-signer-abort-error-cancellation` | [x] packed kit |
| C1-R34 | Important | Signer mutates payload/PAE → envelope fails L1; authority mutates envelope while verify returns ok with pre-mutation digest | External callbacks get defensive copies; private snapshots authoritative | Snapshot every byte input at port into private owned Uint8Arrays; never expose those instances to callbacks. Signer: retain private payload/PAE; pass fresh copies; after callback do not re-read copies; validate signer output descriptor-safely. Authority: parse/verify/digest only private snapshots; pass fresh copies; L3/L4 private only. No caller-array mutation; callback mutation cannot alter caller arrays/internal state/digest/outcome. Tests/packed: signer mutates both copies; returned envelope payload remains canonical private; authority mutates all callback bytes; caller envelope byte-identical; digest matches private input | [x] `signer-mutates-callback-bytes-envelope-canonical`, `authority-mutates-callback-bytes-digest-unchanged` | [x] packed kit |
| C1-R35 | Important | Singleton-array `subjectOf` passes `validateExecutionEvidence` but C1 requires scalar `refId` only | Resolve protocol-valid scalar or array `subjectOf` uniquely | Consume protocol admitted relation type; collect refs from scalar and array forms; validate every element; require exactly one unique native-trace target. Reject empty/duplicate/multi/malformed/dangling/wrong-type/contradictory. No silent ambiguous dedupe unless protocol defines it. Source + packed: scalar pass, singleton-array pass, empty/multi/duplicate/malformed fail; reviewer singleton probe passes; decoy protections remain | [x] `subjectOf-singleton-array-passes`, empty/multi fail probes | [x] packed kit |
| C1-R36 | Important | Forward-link collector checks only `propertyID`; missing `@type` or `@type:"Thing"` can pass | Complete admitted `PropertyValue` shape for C1 links | For every identifier with C1-owned `propertyID`, validate complete closed PropertyValue shape before cardinality/value: exact `@type`, `propertyID`, value format, allowed keys. Malformed C1-owned candidate is L3 error even if another valid link exists. Non-C1 identifiers never satisfy C1 cardinality. Source + packed: missing/wrong type, wrong value, extra core field, valid exact, valid+malformed duplicate, link-only-on-decoy | [x] `forward-link-missing-propertyvalue-type-fails`, `forward-link-wrong-type-thing-fails`, `forward-link-valid-plus-malformed-fails`; malformed value → `l3-forward-link-malformed` | [x] packed kit |
| C1-R37 | Important | Only `trajectory.schema.json` generated; no derivation-statement JSON Schema for linkageMode/predicate | Publish and pack signed derivation-statement JSON Schema | Deterministic draft-2020-12 `trajectory-derivation-statement.schema.json` for decoded DSSE/in-toto statement payload (required linkageMode, subject/digest, predicate type, Execution/nativeTrace/Trajectory binding, derivedAt/timebase, closed nested/extension law). Export under `schemas/*`, files list, pin/check script, README. No envelope-signature trust claim. Runtime-vs-AJV parity for valid forward/sealed + invalid modes/fields. Packed consumer loads schema and validates both golden modes; pin drift fails | [x] `generate-schemas.mjs` dual emit; `derivation-statement-schema-ajv-*` probes | [x] packed tarball includes schema + AJV probes |
| C1-R38 | Important | Runtime + JSON Schema accept timestamp `18446744073709551616` and intValue `9223372036854775808` | Exact OTLP uint64/int64 decimal bounds | Shared refinements: uint64 `0..18446744073709551615`, int64 `-9223372036854775808..9223372036854775807`, preserve leading-zero/canonical sign law (`-0` per ratified rule). Apply uint64 to every ns timestamp/duration; int64 to AnyValue `intValue`. Generated schema encodes same bounds with portable draft-2020-12 string constraints. Exhaustive boundary parity runtime+AJV+packed | [x] `otlp-bounds.ts`; uint64/int64 boundary probes incl. `-0` | [x] packed kit |
| C1-R39 | Important | Pack smoke count 70 not enforceable; only 8 fixture-manifest entries asserted; removing a case can pass | Exact immutable case-ID manifest | Export frozen ordered `TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS` covering every required public case R1–R38 + baseline successes. Runner results keyed by IDs; reject duplicate/missing/extra/unexecuted; each exactly once. Pack smoke imports manifest from packed testing export; asserts exact IDs + count independently; pin expected digest/count so deleting both impl and manifest cannot pass. Mutation/self-tests for delete/rename/duplicate/skip. Add R31–R38 attacks to public kit. Preserve fixture-manifest separately. No private/source imports/skips | [x] `conformance-case-manifest.ts` (65 IDs) + runner; pack smoke pins count/IDs | [x] packed testing export assert (92 vitest cases) |
| C1-R40 | Important | Guard counts only correctly configured setup; accepts setup after pack, extra unconfigured setup-node, missing Trajectory checkout | Exact checkout → setup-node → npm pin → pack order per job | For each required job: parse all ordered steps; count **all** checkout and setup-node uses regardless of config. Exactly one checkout then exactly one setup-node at pinned Node, in that order. Pack-smoke jobs: npm pin after setup and before every pack. Reject missing/duplicate/moved/wrong-version/unconfigured, checkout after setup, setup after npm/pack, extra setup, anonymous bypasses, job swaps. Mutations: three reviewer bypasses verbatim + move/duplicate/wrong-version across job classes | [x] checkout/setup order guard + 3 new bypass mutations (19 guard tests) | [x] n/a (workflow guard) |

### Implementation checklist (third exact-head whole-component)

- [x] C1-R31 — preflight/proxy rejection before every object operation (source + packed)
- [x] C1-R32 — every exported structured Zod schema/factory hardened preflight-first
- [x] C1-R33 — seal cancellation matches verify (pre/during/after signer; typed AbortError)
- [x] C1-R34 — defensive byte copies to callbacks; private snapshots authoritative
- [x] C1-R35 — protocol-valid scalar or singleton-array `subjectOf` uniquely resolved
- [x] C1-R36 — complete PropertyValue shape for C1-owned forward links
- [x] C1-R37 — publish/pack derivation-statement JSON Schema + AJV parity
- [x] C1-R38 — OTLP uint64/int64 decimal bounds runtime + schema + packed parity
- [x] C1-R39 — frozen exact ordered conformance case-ID manifest + pack smoke pin
- [x] C1-R40 — CI guard exact checkout→setup-node→npm→pack order per job

### Acceptance

All ten rows move from pending to commit SHA + exact red/green probe evidence only after
red→green verification. L4 remains external/`not-evaluated`.

## 2026-07-31 fourth exact-head whole-component review resolution

Append-only after C1-R31–R40. Ratified law unchanged. Exact-probe-first: reproduce
each reviewer probe RED before implementation; green exact probe + packed-public
counterpart where required + full suite. Preserve two linkage modes, R24–R40 law,
R9 toolchain pins, R15 hermetic packed-types, L4 external, no `legacy-peer-deps`.
No check-off from broad tests alone. After green: restack onto latest
`origin/integration/evidence-v1`, rerun gates, force-with-lease push.

**Independent pack-smoke pin encoding (R41):** SHA-256 (hex lowercase) over the
UTF-8 bytes of `TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS` joined by U+000A (`\n`)
with **no** trailing newline after the last ID. Neither count nor digest may be
imported/generated from the package manifest at pack-smoke authoring time.
Baseline at reviewed head `207b7c4db` (65 IDs): digest
`320d1114185798d6c23e00a6cb40f2dea0ecf082cb1811a53ba17e1e20e0a898`. This wave adds 13
required public case IDs (78 total); updated independent pin digest
`d80aec258fec3a3f3b2c20d28d8273e44ab5b364c329eb06eeea3fb006a1b712`.

| ID | Severity | Exact probe | Violated law | Minimal disposition | Red evidence | Green evidence |
| --- | --- | --- | --- | --- | --- | --- |
| C1-R41 | Important | Pack smoke derives expected IDs/count from packed manifest; deleting a case and its manifest entry still passes | Independent immutable pack pin | Hard-code literal expected count and ordered-manifest SHA-256 digest in `scripts/pack-smoke.mjs` (encoding above). Check packed export frozen/unique/ordered exact count+digest; runner IDs equal exactly once. Mutation tests: delete case+entry, rename both, duplicate, reorder, skip, extra — independent pin fails even when export+runner change together. Fixture manifest remains separate | [x] `pack-smoke.mjs` imported `dist/conformance-case-manifest.js` for expected count/IDs; deletion mutation would pass | [x] `scripts/pack-smoke.mjs`: count `78`, digest `d80aec258fec3a3f3b2c20d28d8273e44ab5b364c329eb06eeea3fb006a1b712`, `runManifestPinMutationSelfTests()`; `yarn pack:smoke` verifies packed export + testing kit `105` vitest cases |
| C1-R42 | Important | Installed AJV accepts `intValue` `9223372036854775808` in span/event attributes; inline AnyValue unbounded; `$defs.AnyValue` uses wrong signed bounds | One exact signed int64 AnyValue law everywhere | One generator source for int64 decimal `-9223372036854775808..9223372036854775807` matching runtime; every AnyValue site `$ref` `$defs.AnyValue` (or same helper). Generator assertion: every `intValue` node equals/refs exact law. Runtime/AJV/packed at every emitted location: min/max pass, max+1/min-1 fail, long/leading-zero/sign/`-0` per law; regenerate pin; tarball AJV reviewer probes fail | [x] AJV accepted `9223372036854775808`; `$defs.AnyValue.intValue` used uint64-scale pattern | [x] `otlp-bounds.ts` `int64DecimalJsonSchemaNode()` + `generate-schemas.mjs` `assertIntValueLaw`; probes `ajv-packed-int64-overflow-fails`, `ajv-packed-int64-min-boundary-pass`, `otlp-int64-*`; `yarn check:schemas` |
| C1-R43 | Important | Statement JSON Schema accepts empty/two-item subjects; runtime validators accept non-RFC3339 `derivedAt` that build/seal/verify later reject | Exact subject cardinality + calendar-strict RFC3339 at earliest public boundary | Runtime + published schema: `subject` `minItems:1` `maxItems:1` exact shape. Calendar-strict RFC3339 for `derivedAt` (syntax/timezone/calendar/leap/fraction; reject Date.parse rollover). Schema `format: "date-time"` + syntax constraints; packed AJV with standards-compliant format validator. Parity both modes: empty/1/2 subjects; leap/non-leap/timezone/whitespace. Exported statement validators reject invalid `derivedAt` on safeParse | [x] empty/two-subject AJV pass; `TrajectoryDerivationStatementSchema.safeParse` accepted non-leap Feb 29 | [x] `trajectory-derivation-statement.schema.json` subject min/max + `derivedAt` format; Zod refine on predicate; probes `statement-schema-*`; packed AJV with calendar-strict format hook |
| C1-R44 | Important | Nested revoked proxy raw TypeError in preflight; revoked build input raw; `deriveTraceId` hostile getter; `sha256Hex` proxied typed-array prototype trap | Close remaining public proxy/trap boundaries | R31 ordering everywhere incl. revoked proxies → typed invalid-input. Port-snapshot reject proxy before Reflect/Object. Harden identity helpers (exact own enumerable data descriptors). Harden hashing: proxy-first genuine byte-view, private owned copy before crypto. Enumerate remaining public utility exports. Source + packed probes; trap counters zero; no raw sentinel | [x] revoked proxy → raw TypeError; hostile getter invoked during `deriveTraceId` | [x] `preflight.ts`, `port-snapshot.ts`, `identity.ts`, `hashing.ts`; probes `preflight-revoked-proxy-typed-invalid`, `build-port-revoked-proxy-typed-invalid`, `deriveTraceId-hostile-getter-trap-zero`, `sha256Hex-prototype-trap-rejects` |
| C1-R45 | Important | Signer throwing `Symbol` escapes raw; authority aborts signal then throws ordinary error → `l2-authority-error` not typed cancellation | Fully typed seal/verify callback failures and cancellation | Signer total catch: intrinsic aborted first; genuine AbortError; else documented typed seal/signing error — never raw/coerce hostile. Verify authority catch: if genuine signal now aborted → `TrajectoryDerivationCancelledError` regardless of ordinary throw; then AbortError; then typed L2. Symbol/bigint/proxy/accessor/toString/valueOf never escape. Source + packed kit matrix | [x] `Symbol()` throw escaped signer; aborted signal + ordinary throw → `l2-authority-error` | [x] `TrajectoryDerivationSigningError`; authority catch checks aborted before normalize; probes `seal-signer-throws-symbol-typed-signing-error`, `authority-abort-signal-then-ordinary-throw-cancellation` |
| C1-R46 | Important | Bare setup-node + `node-version` moved into later decoy step is accepted | Bind setup-node config to its own parsed step | Semantic parser: each step owns `uses`/`with`/`run`; indentation terminates step-local `with`. Exactly one checkout then one setup-node whose **own** `with.node-version` equals pin. Decy/job-level/wrong-indent/duplicate-with/setup-without-with fail. Preserve R40 order checks. Exact reviewer mutation fails; workflow remains green | [x] regex spanned steps; decoy `node-version` satisfied guard | [x] `parseStepFields` + `setupNodeVersionForStep`; mutations bare-setup/decoy/job-level/wrong-indent/setup-without-with; `node --test .github/scripts/evidence-ci-workflow.test.mjs` `23/23` |

### Implementation checklist (fourth exact-head whole-component)

- [x] C1-R41 — independent pack-smoke count+digest pin + mutation self-tests
- [x] C1-R42 — one AnyValue int64 law everywhere (generator + runtime + AJV + packed)
- [x] C1-R43 — subject cardinality 1 + calendar-strict RFC3339 derivedAt parity
- [x] C1-R44 — close remaining public proxy/trap boundaries (preflight/port/identity/hash)
- [x] C1-R45 — typed seal/verify callback failures and abort-priority cancellation
- [x] C1-R46 — CI guard binds node-version to the setup-node step's own `with`
- [x] Restack onto latest `origin/integration/evidence-v1`; post-rebase gates; force-with-lease — onto `9f4925037` from merge-base `34a7b3cbd`; old head `48e53c873` → new head (post-rebase) recorded at push; 58/58 no conflicts; post-rebase trajectory 306 + pack 105 + guards 41

### Acceptance

All six rows move from pending to commit SHA + exact red/green probe evidence only after
red→green verification. Restack + exact-head Evidence CI confirmation required before
handoff. L4 remains external/`not-evaluated`.

## 2026-07-31 fifth exact-head whole-component review resolution

Append-only after C1-R41–R46. Ratified law unchanged. Exact-probe-first: reproduce
each reviewer probe RED before implementation; green exact probe + packed-public
counterpart where required + full suite. Preserve two linkage modes, R24–R46 law,
R9 toolchain pins, R15 hermetic packed-types, L4 external, no `legacy-peer-deps`.
No check-off from broad tests alone. Base at review: `9f4925037` (fetch before push;
restack only if advanced).

| ID | Severity | Exact probe | Violated law | Minimal disposition | Red evidence | Green evidence |
| --- | --- | --- | --- | --- | --- | --- |
| C1-R47 | Critical | `{verified:true, signerKeyIds:[]}` passes; sealed-parent returns L2/L3 pass with vacuous attribution | L2 requires ≥1 verified signer bound to an envelope signature | `verified:true` requires dense nonempty unique nonempty string `signerKeyIds` under descriptor-safe closure; ≥1 envelope signature; every reported verified signer ID must match an actual validated envelope signature key ID per trust-core law (no duplicate-ID ambiguity). Preserve ratified rule on extra unverified envelope signatures; never vacuous attribution. `verified:false` follows existing reason/signers law. Source+packed: zero IDs, no signatures, empty/duplicate/unknown IDs, one/multiple valid matches, mixed actual/unknown. Reviewer sealed-parent probe fails L2 before L3; authority called once where appropriate | [ ] | [ ] |
| C1-R48 | Important | Signer return may contain proxy/accessor signature values; trust-core access leaks raw Symbol/sentinel | Descriptor-snapshot signer output before trust-core consumes it | Treat signer return as hostile unknown. Proxy-first; exact standard dense unaugmented array; own data descriptors only. Each signature exact admitted plain object with exact own enumerable data fields; key ID primitive string; genuine signature byte/string per `DsseSigner` contract. Copy signature bytes via R51 intrinsic hardened copy before owned inert structure to trust-core. Malformed/trapping → `TrajectoryDerivationSigningError` (never raw/L1); cancellation priority per R45. Source+packed: array proxy/revoked/sparse/augmented; signature proxy/getters; keyid/sig getter; malformed; post-return mutation; valid unchanged | [ ] | [ ] |
| C1-R49 | Important | `Array.isArray` precedes proxy rejection in identity, nested port statement, authority result; revoked inputs leak/misclassify | Proxy-first ordering on all remaining array/member paths | Audit every `Array.isArray`/`instanceof`/Object/Reflect/prototype/typed-array in public/untrusted paths; primitive/null then `isProxy` before all such ops recursively. `deriveTraceId` revoked → typed invalid; seal revoked statement typed invalid-input/signing; revoked authority result = malformed authority output (not generic callback error). Nested port members snapshot before shape ops. Source+packed revoked + throwing-trap probes; trap counts zero | [ ] | [ ] |
| C1-R50 | Important | Digest format helpers `RegExp.test` coerces hostile inputs; `Symbol.toPrimitive` escapes | Primitive strings before regex | Every digest/ID/prefix/hex format helper accepts `unknown`; `typeof value === "string"` before regex/string methods; else typed `InvalidDocumentError`/document validation. No String/valueOf/toPrimitive/getter/coercion. Source+packed: object, String wrapper, Symbol, bigint, proxy, hostile `Symbol.toPrimitive`, valid canonical string | [ ] | [ ] |
| C1-R51 | Important | `defensiveCopy` calls caller `.slice`; augmented Uint8Array getter leaks; SAB views can tear digests | Intrinsic byte snapshots; reject augmented/SAB views | Hardened byte snapshot: proxy-first; exact genuine ordinary `Uint8Array`; reject subclasses/exotic/augmented props; buffer/offset/length via safe intrinsic getters; reject `SharedArrayBuffer`-backed views at identity/hash/sign/verify boundaries; copy via intrinsic that cannot consult caller `.slice`/iterator/species/constructor. Uniform use in hashing, ports, signer/authority bytes, fixtures/public byte utilities. Tests: shadowed slice, augmented, subclass, proxy/revoked, SAB concurrent mutation, post-call ArrayBuffer mutation, ordinary bytes | [ ] | [ ] |
| C1-R52 | Important | Fresh consumer installing only tarball fails importing `/testing` — undeclared `ajv` import in fourth-review probes; pack smoke installs AJV manually | Exported `/testing` runtime graph must declare AJV or not import it | Prefer minimal law-preserving choice: declare exact compatible `ajv` as regular dependency if exported runtime imports it; OR move AJV-only code out of testing runtime graph without weakening R29/R42/R43 public parity. No undeclared import. Manifest/lock/tier guards consistent; no legacy-peer-deps. Fresh isolated consumer installs **only** trajectory tarball (ordinary resolution), no explicit AJV install, imports root + `/testing`, runs public kit/AJV parity. Pack smoke removes AJV crutch; tarball manifest inspected | [ ] | [ ] |
| C1-R53 | Important | Duplicate `uses:` on setup or duplicate `run:` on npm-pin step passes | Workflow parser rejects duplicate YAML mapping keys | Track raw mapping keys per job/step (incl. nested `with`) with indentation scope; reject duplicates before semantic validation. Reject duplicate `uses`/`run`/`name`/`with`/`working-directory`/`node-version`/job keys. Exact mutations + valid multiline run. Preserve checkout→step-local setup→npm→pack law | [ ] | [ ] |
| C1-R54 | Important | Authority-abort case pre-aborts signal so callback never runs — tautological pre-abort retest | Callback executes then abort+throw | Packed case: signal starts live; authority increments count, aborts genuine controller inside callback, throws ordinary non-AbortError; verify throws typed cancellation (intrinsic post-callback/catch priority). Callback exactly once; ordinary error not surfaced/L2 not returned. Keep separate pre-abort callback-zero case. Prefer same case ID; update pin count/digest only if ID set changes. Mutation/probe shows old impl fails | [ ] | [ ] |
| C1-R55 | Minor | Packed archive contains stale `dist/conformance-case-ids.{js,d.ts}` — build does not clean | Clean dist before every build/prepack; reject orphan output | Cross-platform checked script removes `dist` before tsc. Pack smoke seeds orphan, runs pack/prepack, asserts absent; inspect packed dist vs compiler output. Repeated clean checkout/build/pack same file list. Do not delete schemas/fixtures outside dist | [ ] | [ ] |
| C1-R56 | Minor | README links missing `docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` | README must not link missing design | Replace with existing checked-in refs: C1 component plan + canonical evidence architecture/execution-evidence design present at this head. Every relative link resolves from repo root. Do not add/copy shared design doc in C1 scope | [ ] | [ ] |

### Implementation checklist (fifth exact-head whole-component)

- [ ] C1-R47 — L2 nonempty verified signer IDs bound to envelope signatures (Critical)
- [ ] C1-R48 — descriptor-snapshot hostile signer return before trust-core
- [ ] C1-R49 — proxy-first on remaining array/member paths (identity/port/authority)
- [ ] C1-R50 — digest/format helpers require primitive string before regex
- [ ] C1-R51 — intrinsic byte snapshots; reject augmented/SAB views
- [ ] C1-R52 — `/testing` declares AJV or removes undeclared import; tarball-only consumer
- [ ] C1-R53 — CI workflow parser rejects duplicate YAML mapping keys
- [ ] C1-R54 — authority-abort case executes callback then abort+ordinary throw
- [ ] C1-R55 — clean dist before build/prepack; pack smoke rejects orphans
- [ ] C1-R56 — README links only existing checked-in design/plan docs

### Acceptance

All ten rows move from pending to commit SHA + exact red/green probe evidence only after
red→green verification. L4 remains external/`not-evaluated`.
