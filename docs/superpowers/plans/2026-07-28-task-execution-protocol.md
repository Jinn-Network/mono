# Task Execution Protocol (TEP) core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-28
**Status:** draft (pending program approval)
**Shape:** `feat`
**Implements:** `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP v1), absorbing the three carried amendments recorded in `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` §5, §6.2, §13.
**Dependencies on sibling 2026-07-28 plans:** none — this is the critical-path root (coordinator brief, "Critical path: TEP protocol → TEP kit → …"). Downstream siblings that **extend the tree and its guard files** authored here: `2026-07-28-task-profiles-and-evaluation-specs.md` (Phase 3) and `2026-07-28-task-execution-backend-local.md` (Phase 4). Those plans register their own packages into the guard constant blocks this plan creates; they do not modify the three packages this plan ships.

**Goal:** Ship the pure, backend-neutral core of the Task Execution Protocol — three standalone yarn packages (`@jinn-network/task-execution-protocol`, `-backend`, `-testing`) plus the task-execution tree's architecture-guard clone — so any binding or application can request agentic work, represent Attempts, observe lifecycle, and deliver results against a frozen contract proven by a conformance kit.

**Architecture:** Follows the evidence-substrate precedent exactly (coordinator brief "Ground truth" + `evidence-substrate.json`). `protocol` is I/O-free (types, JSON Schemas, per-package sealing/canonicalization, observation fold, validators, deterministic Attempt-URI derivation; no Jinn deps; evidence references are structural `{family,digest}` fields). `backend` depends on `protocol` only (the operational interface + typed error class). `testing` depends on both and ships conformance-kit Layers 1–2 (golden + adversarial fixtures, the csi-sanity-style backend sanity suite, and an in-memory fake backend proven **first**). Each package is a **standalone yarn project** (own `yarn.lock`, `packageManager yarn@4.13.0`, `nodeLinker: node-modules`) with in-tree deps declared as normal semver + `resolutions: { "<name>": "portal:../<sibling>" }`. Sealing/canonical bytes are re-implemented per package (copy `order.ts`, ship pinned-digest golden fixtures, include a key-order-sensitive equivalence record), never a shared runtime dep. A three-script guard clone + one CI workflow encode the architecture as executable tests, landing **with the first package** and growing as each package registers itself.

**Tech Stack:** TypeScript 5.9 (NodeNext strict), Node 22, Yarn 4.13.0 (Corepack), Vitest 4, zod 4.4.3 (schema source of truth → JSON Schema 2020-12 via `z.toJSONSchema`), `@noble/hashes` (sha256 for digests, sha1 for UUIDv5), `node:test` for the `.mjs` guard scripts, GitHub Actions for the CI DAG. `canonicalize` (RFC 8785 JCS) is a **dev-only** correctness anchor in `protocol`, never a runtime dep.

## Global Constraints

_Every task's requirements implicitly include this section. Values copied verbatim from the design + coordinator brief._

- **Preflight invariant:** all work sits on top of `3650ac65e`. `git merge-base --is-ancestor 3650ac65e HEAD` MUST pass before any task (Preflight section below).
- **Standalone yarn projects.** Each package has its own `package.json` (`"packageManager": "yarn@4.13.0"`, `"type": "module"`, `"version": "0.1.0"`, `"engines": { "node": ">=22" }`, `"license": "MIT"`, `"repository.directory"` set), its own `.yarnrc.yml` (`nodeLinker: node-modules`), its own `yarn.lock`. No repo-root workspace (coordinator brief, "Package mechanics precedent").
- **Portal resolutions.** In-tree Jinn deps are declared as `"0.1.0"` semver **and** pinned in `"resolutions"` as `portal:../<sibling>` (evidence precedent; enforced by the inventory guard).
- **UTF-16 code-unit ordering, everywhere sealed bytes are produced.** Copy `src/order.ts` (`compareCodeUnitStrings`) into `protocol`; use it for every object-key sort that reaches canonical bytes. `localeCompare`, `toLocale*`, and `Intl` are **banned in all production source** under `packages/task-execution/` (locale-ban guard). `.test.ts` files and `.mjs` guard scripts are exempt (matching the evidence guard, which itself uses `localeCompare` in test-only sort code).
- **Seal once; verifiers hash exact received bytes.** All three sealed families (Task, Submission, Delivery) canonicalize once with RFC 8785 JCS under I-JSON at sealing; the sealer MUST reject any number not exactly representable as an I-JSON integer (fractional quantities are strings). No consumer ever re-canonicalizes; `documentDigest(bytes)` hashes the exact bytes (design §6.1).
- **Vendor-tree media types used as-is.** `application/vnd.jinn.task-execution.{task,submission,delivery,dispatch-context}.v1+json`. IANA registration is a **non-blocking follow-up** tracked once at the program level (coordinator mandate 4; design §7/§21.1/§28) — do not block on it.
- **Reserved profile URI** `https://jinn.network/profiles/task-execution/1.0` must resolve to the published human-readable profile **before any external conformance claim**; internal work does not gate on publication (coordinator mandate 6). Record as a pre-release checklist item, do not implement resolution here.
- **capacity-exhausted rides `backend-unavailable`.** The §13 taxonomy has exactly **16** categories; do NOT add a capacity/resource-exhausted category (coordinator mandate 5). Capacity is expressed only via the `submission-closed.v1` observation `reason: capacity` plus `backend-unavailable` detail.
- **Error-category ownership split (frozen):** the category **enum/vocabulary + validators live in `protocol`**; the `TaskExecutionError` **class lives in `backend`**. No duplicate source of the enum (coordinator "Known design-level items"; tep.json open-question on error-class ownership).
- **Freeze granularity (§22):** names and responsibilities of the public interfaces are frozen; field-level refinement is permitted at implementation. Where this plan marks a value "field-level refinement," the implementer may refine it but MUST pin the chosen value with a fixture.
- **Rule 3 (surgical).** Create only the files this plan names. The three guard scripts + CI workflow are created here; sibling plans edit them later at their own land time.
- **Verification gate per task:** `yarn typecheck` + `yarn test` in the touched package, the relevant guard script (`node --test …`), and (at milestone close) the packed-types guard — all green locally, evidence-style, before the task is done.

---

## Preflight

- [ ] **Assert the branch base.** Run:

```bash
git merge-base --is-ancestor 3650ac65e HEAD && echo "OK: 3650ac65e is an ancestor of HEAD"
```

Expected: prints `OK: …`. If it fails, stop — the worktree is not on `integration/evidence-v1`'s lineage and the evidence packages this plan reads as ground truth may be absent.

- [ ] **Confirm the tree is absent.** Run `ls packages/task-execution 2>&1` — expected `No such file or directory`. This plan creates it from scratch.

- [ ] **Confirm the evidence ground truth is present.** Run `ls packages/evidence/protocol/src/order.ts` — expected to exist (this is the `order.ts` you copy verbatim).

---

## Milestone 1 — Protocol package + guard clone

Delivers `@jinn-network/task-execution-protocol` and the three guard scripts + CI workflow (enumerating protocol only; later packages register themselves). Order within the milestone follows design §26 step 1 and the coordinator "kits/fixtures before implementations" rule: primitives → identity → schemas/validators → observations/fold → requirements-merge → fixtures → barrel/pack-smoke.

### Task 1.1: Protocol package scaffolding + guard clone (guards land with the first package)

**Files:**
- Create: `packages/task-execution/protocol/package.json`
- Create: `packages/task-execution/protocol/.yarnrc.yml`
- Create: `packages/task-execution/protocol/tsconfig.json`
- Create: `packages/task-execution/protocol/tsconfig.build.json`
- Create: `packages/task-execution/protocol/vitest.config.ts`
- Create: `packages/task-execution/protocol/scripts/build.mjs`
- Create: `packages/task-execution/protocol/src/index.ts` (temporary stub export)
- Create: `.github/scripts/task-execution-package-inventory.test.mjs`
- Create: `.github/scripts/task-execution-source-boundaries.test.mjs`
- Create: `.github/scripts/task-execution-packed-types.test.mjs`
- Create: `.github/workflows/task-execution-ci.yml`

**Interfaces:**
- Produces: the package directory + build toolchain that every later protocol task extends; the guard files that Tasks 2.x and 3.x (and sibling plans) edit to register new packages.

- [ ] **Step 1: Write `package.json`.** Mirror `packages/evidence/protocol/package.json` (coordinator brief mechanics). No runtime Jinn deps.

```json
{
  "name": "@jinn-network/task-execution-protocol",
  "version": "0.1.0",
  "description": "Pure, I/O-free reference implementation of the Jinn Task Execution Protocol v1.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/task-execution/protocol"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./schemas/*": "./schemas/*",
    "./fixtures/*": "./fixtures/*"
  },
  "files": ["dist/", "schemas/", "fixtures/", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "generate:schemas": "yarn build && node scripts/generate-schemas.mjs --write",
    "check:schemas": "yarn build && node scripts/generate-schemas.mjs --check",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": { "@noble/hashes": "^2.2.0", "zod": "4.4.3" },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "canonicalize": "^2.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: Write `.yarnrc.yml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `scripts/build.mjs`.** Copy each verbatim from `packages/evidence/protocol/` (they are package-generic): `.yarnrc.yml` = `nodeLinker: node-modules`; `tsconfig.json` = the evidence `target ES2022 / module ES2022 / moduleResolution Bundler / strict / declaration / outDir dist / rootDir src / lib ["ES2022","DOM"] / types ["node"]`; `tsconfig.build.json` = `{ "extends": "./tsconfig.json", "exclude": ["src/**/*.test.ts"] }`; `vitest.config.ts` = include `src/**/*.test.ts`; `scripts/build.mjs` = the evidence rm-dist + spawn-tsc script.

- [ ] **Step 3: Write the temporary `src/index.ts` stub** so typecheck/build succeed:

```ts
export const TASK_EXECUTION_PROTOCOL_URI =
  "https://jinn.network/profiles/task-execution/1.0";
```

- [ ] **Step 4: Clone the inventory guard** to `.github/scripts/task-execution-package-inventory.test.mjs`. Copy `.github/scripts/evidence-package-inventory.test.mjs` verbatim, then swap **only** the constant blocks: `packageRoot` → `join(root, 'packages', 'task-execution')`; `EVIDENCE_PACKAGES` → `TASK_EXECUTION_PACKAGES = [['protocol', '@jinn-network/task-execution-protocol']]`; `JINN_DEPENDENCY_GRAPH` → `new Map([['protocol', { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] }]])`; the count assertion `assert.equal(TASK_EXECUTION_PACKAGES.length, 1)`; the tree-scan regex → `/^@jinn-network\/task-execution-/` (no `execution-recorder`/`attestation-issuer` special-case — the task-execution tree has a uniform `task-execution-` prefix, an intentional divergence from the evidence tree noted in `evidence-substrate.json` finding). Drop the Derivation-specific optional-peer test (no analogue in this tree yet).

- [ ] **Step 5: Clone the source-boundaries guard** to `.github/scripts/task-execution-source-boundaries.test.mjs`. Copy `.github/scripts/evidence-source-boundaries.test.mjs` verbatim (the generic scanner helpers — `specifiers`, `forbiddenImports`, `forbiddenImportsInFiles`, ambient-network + locale-sensitive regexes, `files`, `inside`, `assertBoundary` — transfer unchanged), then replace the evidence-specific constants and the one-way-graph test body with:
  - `packages` → `join(root, 'packages', 'task-execution')`; `evidenceDirectories` → `taskExecutionDirectories = ['protocol']`.
  - Keep `APPLICATION_AND_LEGACY_ROOTS` (unchanged — same repo).
  - A `TASK_EXECUTION_FOREIGN_PACKAGES` list the whole tree is forbidden to import: every `@jinn-network/evidence-*`, `@jinn-network/execution-recorder`, `@jinn-network/attestation-issuer`, `@jinn-network/trust-*`, `@jinn-network/record-discovery-*`, `viem`, `better-sqlite3`, `kubo-rpc-client` (the coordinator import graph: "TEP protocol imports nothing … evidence refs are structural"). Note in a comment that `backend-local` (a sibling package, not in this tree yet) will carve out `@jinn-network/execution-recorder` **binding-layer only** when it registers.
  - Delete the IPFS/Derivation/Publication fixture tests. Keep the two generic scanner self-tests (`the import scanner catches static, export, dynamic, require, and local-path escapes` and `locale-sensitive API detection catches member calls, optional chaining, and Intl`) verbatim.
  - Replace `evidence source boundaries remain one-way across the approved graph` with a `task-execution source boundaries remain one-way across the approved graph` test that, for the current single package, asserts `assertBoundary(join(packages, 'protocol', 'src'), ['@jinn-network/'])` (protocol imports nothing Jinn) and `assertBoundary(join(packages, 'protocol', 'src'), TASK_EXECUTION_FOREIGN_PACKAGES)`.
  - Keep `Evidence production source never orders or formats with the host locale` renamed to `Task-execution production source never orders or formats with the host locale`, iterating `taskExecutionDirectories`.

- [ ] **Step 6: Clone the packed-types guard** to `.github/scripts/task-execution-packed-types.test.mjs`. Copy `.github/scripts/evidence-packed-types.test.mjs` verbatim, swap `evidenceRoot` → `packages/task-execution`; `packages` → `[['protocol', '@jinn-network/task-execution-protocol']]`; `codeEntrypoints` → `['@jinn-network/task-execution-protocol']`; drop the `@types/better-sqlite3` consumer dep; update the final log line to say "task-execution packages."

- [ ] **Step 7: Clone the CI workflow** to `.github/workflows/task-execution-ci.yml`. Copy `.github/workflows/evidence-ci.yml`'s shape, reduced to the current graph: `name: Task Execution CI`; `paths` triggers `packages/task-execution/**`, `.github/scripts/task-execution-*.test.mjs`, `.github/workflows/task-execution-ci.yml`, and this design doc `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md`; an `architecture` job running both `node --test` guard scripts; a `foundation` job that (in `packages/task-execution/protocol`) runs `yarn install --immutable && yarn check:schemas && yarn typecheck && yarn test && yarn build && yarn pack:smoke` and uploads `dist`; a `verify` job (`needs: [architecture, foundation]`, `if: always()`) that asserts both succeeded, then downloads dist and runs `node .github/scripts/task-execution-packed-types.test.mjs`. Backend and testing jobs are added by Tasks 2.1 and 3.1.

- [ ] **Step 8: Run the guards.**

```bash
node --test .github/scripts/task-execution-package-inventory.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
```

Expected: both pass (the inventory sees exactly one package; the boundary self-tests pass; protocol's stub imports nothing).

- [ ] **Step 9: Typecheck + build the skeleton.**

```bash
cd packages/task-execution/protocol && yarn install && yarn typecheck && yarn build
```

Expected: zero errors; `dist/index.js` emitted.

- [ ] **Step 10: Commit.**

```bash
git add packages/task-execution/protocol .github/scripts/task-execution-*.test.mjs .github/workflows/task-execution-ci.yml
git commit -m "feat(task-execution): scaffold protocol package + tree guard clone"
```

### Task 1.2: Ordering + hashing + JCS canonicalization + sealing primitives

**Files:**
- Create: `packages/task-execution/protocol/src/order.ts`
- Create: `packages/task-execution/protocol/src/order.test.ts`
- Create: `packages/task-execution/protocol/src/hashing.ts`
- Create: `packages/task-execution/protocol/src/hashing.test.ts`
- Create: `packages/task-execution/protocol/src/json.ts` (JsonValue type + I-JSON integer guard)
- Create: `packages/task-execution/protocol/src/canonical.ts`
- Create: `packages/task-execution/protocol/src/canonical.test.ts`

**Interfaces:**
- Produces: `compareCodeUnitStrings(l,r): number`; `sha256Hex(bytes): string`; `documentDigest(bytes): \`sha256:${string}\``; `type JsonValue`; `assertIJsonInteger(n): void` (throws `IJsonNumberError`); `serializeCanonicalJson(value: JsonValue): Uint8Array` (RFC 8785 JCS restricted to the I-JSON-integer subset; keys sorted by `compareCodeUnitStrings`).

- [ ] **Step 1: Copy `order.ts` verbatim** from `packages/evidence/protocol/src/order.ts` (the `compareCodeUnitStrings` body + the SPDX + doc comment; update the comment's guard path to `.github/scripts/task-execution-source-boundaries.test.mjs`).

- [ ] **Step 2: Write the failing `order.test.ts`.**

```ts
import { describe, expect, test } from "vitest";
import { compareCodeUnitStrings } from "./order.js";

describe("compareCodeUnitStrings", () => {
  test("orders by UTF-16 code unit, not host collation", () => {
    // 'Z' (U+005A) precedes 'a' (U+0061) by code unit; many locales invert this.
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });
});
```

- [ ] **Step 3: Run — expect PASS** (`order.ts` already copied). `cd packages/task-execution/protocol && yarn test order`.

- [ ] **Step 4: Write `hashing.ts`.** Copy the evidence pattern:

```ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function documentDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}
```

- [ ] **Step 5: Write `json.ts`.** The I-JSON integer guard is the economically load-bearing seal rule (§6.1).

```ts
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

export class IJsonNumberError extends Error {
  constructor(readonly value: number) {
    super(`number is not an exact I-JSON integer: ${value}`);
    this.name = "IJsonNumberError";
  }
}

/** Sealed families admit only exact I-JSON integers; fractional quantities are strings (§6.1). */
export function assertIJsonInteger(value: number): void {
  if (!Number.isSafeInteger(value)) throw new IJsonNumberError(value);
}
```

- [ ] **Step 6: Write the failing `canonical.test.ts`.** Cover: (a) key-order insensitivity (two source orderings → identical bytes), (b) code-unit key sort (`Z` before `a`), (c) **integer-like-key case** (`{"10":…,"2":…}` — code-unit order, **not** numeric; the program §7.14 mandated fixture that catches insertion-order/`JSON.stringify` divergence), (d) I-JSON rejection of a fractional number, (e) byte-for-byte agreement with the RFC 8785 reference `canonicalize` for an integer-only object **and** for the integer-like-key object.

```ts
import { describe, expect, test } from "vitest";
import canonicalize from "canonicalize";
import { serializeCanonicalJson } from "./canonical.js";
import { IJsonNumberError } from "./json.js";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("serializeCanonicalJson", () => {
  test("is insensitive to source key order", () => {
    const a = serializeCanonicalJson({ b: 1, a: 2 });
    const b = serializeCanonicalJson({ a: 2, b: 1 });
    expect(decode(a)).toBe(decode(b));
  });
  test("sorts keys by UTF-16 code unit", () => {
    expect(decode(serializeCanonicalJson({ a: 1, Z: 2 }))).toBe('{"Z":2,"a":1}');
  });
  test("orders integer-like keys by code unit, not numerically (§7.14)", () => {
    // '1' (0x31) precedes '2' (0x32) → "10" sorts before "2" by code unit.
    // A naive JSON.stringify over a rebuilt object would emit numeric order ("2","10") — wrong per JCS.
    expect(decode(serializeCanonicalJson({ "10": 1, "2": 2 }))).toBe('{"10":1,"2":2}');
    expect(decode(serializeCanonicalJson({ "10": 1, "2": 2 }))).toBe(canonicalize({ "10": 1, "2": 2 }));
  });
  test("rejects non-I-JSON-integer numbers at sealing", () => {
    expect(() => serializeCanonicalJson({ q: 1.5 })).toThrow(IJsonNumberError);
  });
  test("matches the RFC 8785 reference for the integer-only subset", () => {
    const value = { z: [3, 2, 1], a: { d: 1, c: 2 } };
    expect(decode(serializeCanonicalJson(value))).toBe(canonicalize(value));
  });
});
```

- [ ] **Step 7: Run — expect FAIL** (`serializeCanonicalJson` not defined).

- [ ] **Step 8: Write `canonical.ts`.** JCS restricted to the I-JSON-integer subset. **Build the output string via explicit sorted-key iteration — never `JSON.stringify` over a rebuilt object** (program §7.14): JS iterates integer-like string keys in numeric order regardless of insertion order, so `JSON.stringify(order(value))` would emit `{"2":…,"10":…}` where JCS demands code-unit order `{"10":…,"2":…}`. The serializer walks each value, sorts object keys with `compareCodeUnitStrings`, and emits `key:value` members by iterating the sorted key array itself. `JSON.stringify` is used only for leaf **string** escaping (keys and string values), which matches JCS minimal escaping over the I-JSON subset. A safe-integer guard fires on every number. (For that subset the output is byte-identical to RFC 8785 JCS, proven by Step 6e including the integer-like-key case.)

```ts
import { compareCodeUnitStrings } from "./order.js";
import { assertIJsonInteger, type JsonValue } from "./json.js";

const encoder = new TextEncoder();

/** Emit RFC 8785 JCS by explicit sorted-key iteration — insertion order is never trusted (§7.14). */
function serialize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { assertIJsonInteger(value); return String(value); }
  if (typeof value === "string") return JSON.stringify(value); // JCS string escaping (I-JSON subset)
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodeUnitStrings); // sorted array drives emission
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`).join(",")}}`;
}

/** RFC 8785 JCS over the I-JSON-integer subset; those bytes are the document forever (§6.1). */
export function serializeCanonicalJson(value: JsonValue): Uint8Array {
  return encoder.encode(serialize(value));
}
```

- [ ] **Step 9: Run — expect PASS.** `yarn test canonical order hashing`.

- [ ] **Step 10: Run the locale-ban guard** to confirm nothing in `src/` trips it: `node --test .github/scripts/task-execution-source-boundaries.test.mjs` (from repo root). Expected PASS.

- [ ] **Step 11: Commit.** `git commit -m "feat(task-execution): sealing primitives (order, hashing, JCS canonicalization)"`

### Task 1.3: ResourceDescriptor, EvidenceRecordReference, and identity helpers

**Files:**
- Create: `packages/task-execution/protocol/src/descriptors.ts`
- Create: `packages/task-execution/protocol/src/descriptors.test.ts`
- Create: `packages/task-execution/protocol/src/identifiers.ts`
- Create: `packages/task-execution/protocol/src/identifiers.test.ts`

**Interfaces:**
- Consumes: `documentDigest` (Task 1.2), `compareCodeUnitStrings`.
- Produces: `type ResourceDescriptor` (in-toto v1: `name?`, `uri?`, `digest?`, `mediaType?`, `downloadLocation?`, `annotations?`, `content?`; ≥1 of uri/digest/content — §6.4); `type EvidenceRecordReference = { family: EvidenceRecordFamily; digest: \`sha256:${string}\` }` with `EvidenceRecordFamily = "execution-evidence" | "result-evaluation" | "execution-verification"`; `isValidUrnUuid(uri): boolean`; `TEP_ATTEMPT_NAMESPACE` (the exported UUIDv5 namespace constant — program §7.2: owned and exported by this package, consumed by the marketplace binding, never re-derived); `deriveAttemptUri(bindingName: string, correlationTuple: readonly (string | number)[]): \`urn:uuid:${string}\`` (RFC 9562 UUIDv5, §9.2).

- [ ] **Step 1: Write `descriptors.ts`.** Types + a structural validator `resourceDescriptorHasLocator(d): boolean` enforcing "at least one of uri/digest/content." Digest is identity; CIDs/URLs/git ids are locator hints only (§6.4). `EvidenceRecordReference` is the **structural** evidence seam — no import of any evidence package.

- [ ] **Step 2: Write the failing `identifiers.test.ts`** pinning the deterministic Attempt URI for the marketplace tuple (§9.2/§16.2). The pinned value anchors cross-party agreement; the marketplace binding (sibling plan) MUST reproduce it.

```ts
import { describe, expect, test } from "vitest";
import { deriveAttemptUri, isValidUrnUuid } from "./identifiers.js";

describe("deriveAttemptUri", () => {
  test("is a deterministic UUIDv5 urn (RFC 9562 §5.5)", () => {
    // marketplace tuple: (chain id, coordinator address, taskId, attemptIndex) — §16.2
    const uri = deriveAttemptUri("jinn:marketplace", [8453, "0xffa7…181b", "task-1", 0]);
    expect(isValidUrnUuid(uri)).toBe(true);
    // pins byte-stable derivation; recompute once via the implementation and freeze the literal here.
    expect(deriveAttemptUri("jinn:marketplace", [8453, "0xffa7…181b", "task-1", 0])).toBe(uri);
    // version nibble is 5, variant nibble is 8|9|a|b
    expect(uri[23]).toBe("5"); // 'urn:uuid:xxxxxxxx-xxxx-5xxx-…'
  });
  test("distinct tuples derive distinct URIs", () => {
    expect(deriveAttemptUri("jinn:marketplace", [8453, "0xc", "t", 0]))
      .not.toBe(deriveAttemptUri("jinn:marketplace", [8453, "0xc", "t", 1]));
  });
  test("variable-length parts cannot collide across a split boundary (§7.2)", () => {
    // With an empty-delimiter join these two would produce the identical name "abc";
    // the unit-separator delimiter keeps them distinct.
    expect(deriveAttemptUri("b", ["ab", "c"]))
      .not.toBe(deriveAttemptUri("b", ["a", "bc"]));
  });
});
```

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Write `identifiers.ts`.** UUIDv5 = SHA-1 of `namespace-bytes ‖ name-bytes`, with the version/variant nibbles set per RFC 9562 §5.5. **Export** the fixed TEP Attempt namespace UUID constant `TEP_ATTEMPT_NAMESPACE` (program §7.2: this package owns and exports it; the marketplace binding consumes the exported constant and never re-derives its own). The **name-construction rule is frozen**: `bindingName` then each stringified tuple part, joined with the ASCII **unit separator `U+001F`** — a control char that occurs in neither reverse-DNS binding names nor the marketplace correlation tuple, so variable-length parts can never collide across a split boundary (`['ab','c']` and `['a','bc']` derive distinct names — the Step 2 collision fixture). This delimiter is the frozen rule, not a field-level refinement. **Field-level refinement (§22):** only the exact namespace UUID literal is refinable — compute it once, pin it by the Task 1.2/1.3 fixtures, and record it in the addendum (Task 4.2) so the marketplace binding matches byte-for-byte.

```ts
import { sha1 } from "@noble/hashes/legacy.js"; // @noble/hashes v2 exposes sha1 here; verify at install
import { compareCodeUnitStrings } from "./order.js";

// Fixed TEP Attempt-URI namespace (a v5 URN-namespace UUID over "jinn.network/task-execution/attempt").
// EXPORTED (program §7.2): the marketplace binding consumes this constant; it never re-derives its own.
// Compute the literal once and freeze it; pin it with the identifiers fixture.
export const TEP_ATTEMPT_NAMESPACE =
  "6f9619ff-8b86-d011-b42d-00cf4fc964ff"; // PLACEHOLDER value to be replaced with the computed namespace UUID and frozen

// Frozen name-construction delimiter (program §7.2): the ASCII unit separator, a control char
// that cannot appear in the parts, so variable-length parts never concatenate ambiguously.
const NAME_UNIT_SEPARATOR = "\u001f";

const UUID_RE =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidUrnUuid(uri: string): boolean {
  return UUID_RE.test(uri);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function formatUuid(b: Uint8Array): string {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function deriveAttemptUri(
  bindingName: string,
  correlationTuple: readonly (string | number)[],
): `urn:uuid:${string}` {
  // Frozen deterministic name (§7.2): bindingName + tuple parts, unit-separator-delimited so
  // variable-length parts never concatenate ambiguously.
  const name = [bindingName, ...correlationTuple.map(String)].join(NAME_UNIT_SEPARATOR);
  const input = new Uint8Array([...uuidBytes(TEP_ATTEMPT_NAMESPACE), ...new TextEncoder().encode(name)]);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  return `urn:uuid:${formatUuid(hash)}`;
}

// compareCodeUnitStrings re-exported for callers assembling deterministic tuples.
export { compareCodeUnitStrings };
```

- [ ] **Step 5: Run the implementation once to compute the real namespace/pinned URI**, replace the `PLACEHOLDER`, and freeze the literal in the test. Re-run — expect PASS. Run `descriptors.test.ts` too.

- [ ] **Step 6: Commit.** `git commit -m "feat(task-execution): descriptors, evidence refs, deterministic attempt-URI derivation"`

### Task 1.4: Family schemas (zod) + validators + generated JSON Schemas

**Files:**
- Create: `packages/task-execution/protocol/src/schemas/common.ts` (ResourceDescriptor, digest, urn:uuid, RFC 3339, requirement maps)
- Create: `packages/task-execution/protocol/src/schemas/task.ts`
- Create: `packages/task-execution/protocol/src/schemas/submission.ts`
- Create: `packages/task-execution/protocol/src/schemas/delivery.ts`
- Create: `packages/task-execution/protocol/src/schemas/dispatch-context.ts`
- Create: `packages/task-execution/protocol/src/schemas/observation.ts`
- Create: `packages/task-execution/protocol/src/validators.ts`
- Create: `packages/task-execution/protocol/src/validators.test.ts`
- Create: `packages/task-execution/protocol/scripts/generate-schemas.mjs`
- Create (generated): `packages/task-execution/protocol/schemas/*.schema.json`

**Interfaces:**
- Consumes: descriptor/identity types (Task 1.3).
- Produces: `TaskSpecification`, `SubmissionRecord`, `DeliveryRecord`, `DispatchContext`, `ProtocolObservation` types (zod-inferred); `validateTask/validateSubmission/validateDelivery/validateDispatchContext/validateObservation(doc: unknown): { conforms: boolean; errors: ReadonlyArray<{ path: string; message: string }> }`. Every family's **field list is fixed by the design tables** cited below — enumerate them completely, no omissions.

- [ ] **Step 1: Write `schemas/common.ts`.** Reusable zod pieces: `Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)`; `UrnUuid = z.string().regex(UUID_RE)`; `Rfc3339 = z.string().datetime({ offset: true })`; `ResourceDescriptorSchema` (in-toto v1 shape from §6.4, refined so ≥1 of uri/digest/content is present); `EvidenceRecordReferenceSchema` (`family` enum + `digest`); `RequirementsMap` and `PreferencesMap` (record of namespaced-or-core key → JSON value); the **core requirement vocabulary** enum for keys `maxAttemptDurationMs` (relative ms), token/cost budgets, isolation class, network policy, `evidenceCapture`, tool/model constraints, `effort` (tiers `low|medium|high|xhigh|max`) per §7.2; and — **carried amendment 1** — the Submission-level **run-pinning keys** `harness` (id + version|digest), `model` (constraint|pin), `loadout` (ResourceDescriptor + typed kind: `jinn.skill.v1`|opaque), `isolationPolicy` (a policy id within the `isolation` class family) per profiles §5. Extensions use namespaced keys (§21.3); the schemas are open to unknown namespaced properties.

- [ ] **Step 2: Write `schemas/task.ts`** — `TaskSpecificationSchema`, fields exactly per §7.1 **with carried amendment 2** (`profile` is a ResourceDescriptor, not a bare URI):

```ts
import { z } from "zod";
import { ResourceDescriptorSchema, RequirementsMap, PreferencesMap } from "./common.js";

export const TaskOutputSlotSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  required: z.boolean(),
  schema: z.unknown().optional(), // embedded or digest-referenced JSON Schema 2020-12
});

export const TaskSpecificationSchema = z.object({
  protocol: z.string().url(),                         // TEP profile URI (§7.1)
  profile: ResourceDescriptorSchema,                 // carried amendment 2: URI + digest (profiles §6.2)
  instructions: z.string(),
  payload: z.unknown().optional(),                   // profile-typed body
  inputs: z.array(ResourceDescriptorSchema).optional(),
  outputs: z.array(TaskOutputSlotSchema),
  requirements: RequirementsMap.optional(),          // work-intrinsic only (profiles §5)
  preferences: PreferencesMap.optional(),
  evaluation: ResourceDescriptorSchema.optional(),   // digest of the EvaluationSpec (§7.3)
  supersedes: ResourceDescriptorSchema.optional(),   // predecessor Task digest (§6.5)
  author: z.string().optional(),                     // self-declared IRI (§7.4)
}).loose(); // open to namespaced extensions (§21.3)

export type TaskSpecification = z.infer<typeof TaskSpecificationSchema>;
```

Add a `.superRefine` asserting the sealed Task carries **none** of the forbidden mutable fields (`deadline`, `claimPolicy`, `attempts`, `nonce`, `price`, `reward`, `credentials`, `capabilityGrants`) — §7.1 "deliberately contains no …"; presence is `invalid-document`.

- [ ] **Step 3: Write `schemas/submission.ts`** — `SubmissionRecordSchema`, fields exactly per §8: `protocol`, `submission` (UrnUuid), `task` (ResourceDescriptor), `requester` (IRI), `idempotencyKey` (string), `nonce` (string), `deadline` (Rfc3339), `closeAt?` (Rfc3339), `attempts?` (`{ maxTotal?, maxConcurrent? }`), `evaluationRequirements?`, `capabilityGrants?` (record of input name → capability reference), **`requirements?`** the Submission-level run-pinning map (carried amendment 1; shares the `common.ts` vocabulary), `profileParameters?` (namespaced, opaque), correlation annotations (namespaced — **carried amendment 3**: the widened definition admits application context, e.g. `runId`/`cellKey`, as namespaced extensions per profiles §5.3/§13), and `.loose()` for extensions.

- [ ] **Step 4: Write `schemas/delivery.ts`** — `DeliveryRecordSchema`, fields exactly per §11.2: `protocol`, `attempt` (UrnUuid), `task` (Sha256Digest), `outputs` (array of `{ name } & ResourceDescriptor`), `outcome` (`z.enum(["fulfilled","partial","escalation"])` with an `escalationReason` required when `escalation`), `executionIds?` (array UrnUuid), `evidenceRecords?` (array EvidenceRecordReference), `summary?` (bounded string), `supersedes?` (Sha256Digest of an earlier Delivery of the **same** Attempt), `createdAt` (Rfc3339), `.loose()`.

- [ ] **Step 5: Write `schemas/dispatch-context.ts`** — `DispatchContextSchema` per §9.3: `{ taskDigest: Sha256Digest, submission: UrnUuid, nonce: string, attempt: UrnUuid }`, `.loose()`. Media type `application/vnd.jinn.task-execution.dispatch-context.v1+json`.

- [ ] **Step 6: Write `schemas/observation.ts`** — the CloudEvents v1.0 JSON envelope + typed payloads per §10.1/§10.2. `ProtocolObservationSchema`: `{ specversion: z.literal("1.0"), id, source, subject, type: <the 11 event-type literals>, time: Rfc3339, datacontenttype: z.literal("application/json"), dataschema: z.string().optional(), sequence: z.string().regex(/^\d{16}$/), taskdigest: Sha256Digest.optional(), traceparent: z.string().optional(), data: <discriminated union of the 11 payloads> }`. Define the 11 event-type constants (Task 1.5 also imports them). Enforce §10.2 payload bounds only structurally here (free-text ≤ 4 KiB, payload ≤ 64 KiB are advisory ceilings surfaced in the adversarial kit, not hard schema limits — §20).

- [ ] **Step 7: Write the failing `validators.test.ts`.** For each family: a valid fixture passes; a representative violation fails with a stable `path`. Include: Task with a forbidden `deadline` field → fails; Delivery `escalation` without `escalationReason` → fails; observation `sequence` of 15 digits → fails.

- [ ] **Step 8: Run — expect FAIL.**

- [ ] **Step 9: Write `validators.ts`** — `validate<Family>(doc): { conforms, errors }` wrapping `schema.safeParse` and mapping zod issues to `{ path, message }`. Consumer-side rule: validators operate on the **parsed** view and never re-serialize; digest checks are the caller's job over exact received bytes (§6.1).

- [ ] **Step 10: Run — expect PASS.**

- [ ] **Step 11: Write `scripts/generate-schemas.mjs`** mirroring evidence's `generate-profile.mjs`: import the built schemas, emit JSON Schema 2020-12 via `z.toJSONSchema(schema, { target: "draft-2020-12" })` to `schemas/<family>.schema.json`; `--check` mode diffs and exits non-zero on drift. Run `yarn generate:schemas` to write them; commit the generated files.

- [ ] **Step 12: Verify + commit.** `yarn typecheck && yarn test && yarn check:schemas`; then `git commit -m "feat(task-execution): family schemas, validators, generated JSON Schemas"`.

### Task 1.5: Error-category vocabulary, event vocabulary, Attempt state machine

**Files:**
- Create: `packages/task-execution/protocol/src/errors.ts`
- Create: `packages/task-execution/protocol/src/errors.test.ts`
- Create: `packages/task-execution/protocol/src/events.ts`
- Create: `packages/task-execution/protocol/src/events.test.ts`
- Create: `packages/task-execution/protocol/src/states.ts`
- Create: `packages/task-execution/protocol/src/states.test.ts`

**Interfaces:**
- Produces: `TASK_EXECUTION_ERROR_CATEGORIES` (the 16-tuple), `type TaskExecutionErrorCategory`, `isRetryable(category): boolean`, `ERROR_RETRYABLE` table; the event-type constants + `SUBMISSION_EVENT_TYPES` / `ATTEMPT_EVENT_TYPES` / `formatSequence(n: bigint): string` (16-digit zero-pad) / `MAX_SEQUENCE`; `ATTEMPT_STATES`, `TERMINAL_STATES`, `type AttemptState`, `type FailureBlame = "task" | "infrastructure"`. **No error class here** — the class lives in `backend` (Global Constraints).

- [ ] **Step 1: Write `errors.ts`.** The 16 categories exactly per §13, in a frozen tuple, with the retryable table. Note the retryable flags are field-level refinements (§22) pinned by this task's fixture.

```ts
export const TASK_EXECUTION_ERROR_CATEGORIES = [
  "invalid-document", "unsupported-profile", "unsupported-requirement",
  "unsupported-capability", "invalid-reference", "content-corruption",
  "access-denied", "submission-conflict", "attempt-not-found",
  "dependency-unavailable", "backend-unavailable", "operation-aborted",
  "deadline-exceeded", "transport-failure", "result-unavailable",
  "protocol-violation",
] as const;

export type TaskExecutionErrorCategory =
  (typeof TASK_EXECUTION_ERROR_CATEGORIES)[number];

// retryable defaults (§13 says each category carries a machine-readable flag;
// the flags themselves are a field-level refinement — pinned by errors.test.ts).
export const ERROR_RETRYABLE: Record<TaskExecutionErrorCategory, boolean> = {
  "invalid-document": false, "unsupported-profile": false,
  "unsupported-requirement": false, "unsupported-capability": false,
  "invalid-reference": false, "content-corruption": false,
  "access-denied": false, "submission-conflict": false,
  "attempt-not-found": false, "dependency-unavailable": true,
  "backend-unavailable": true, "operation-aborted": true,
  "deadline-exceeded": true, "transport-failure": true,
  "result-unavailable": false, "protocol-violation": false,
};

export function isRetryable(category: TaskExecutionErrorCategory): boolean {
  return ERROR_RETRYABLE[category];
}
```

- [ ] **Step 2: Write `errors.test.ts`** asserting exactly 16 categories, that the set matches §13 verbatim, and that **no** `capacity`/`resource-exhausted` category exists (coordinator mandate 5). Run — expect PASS.

- [ ] **Step 3: Write `events.ts`.** The reverse-DNS prefix `network.jinn.task-execution.`; the 3 submission-scoped + 8 attempt-scoped `.v1` type constants (§10.2); `formatSequence(n: bigint): string` = `n.toString().padStart(16, "0")` with a guard that `n <= MAX_SEQUENCE` (16 nines) and `n >= 0n`; `MAX_SEQUENCE = 9999999999999999n`.

- [ ] **Step 4: Write `events.test.ts`** — the 11 type strings exactly; `formatSequence(0n) === "0000000000000000"`; `formatSequence(42n)` lexicographically less than `formatSequence(100n)` (the boundary property §10.1); `formatSequence(MAX_SEQUENCE + 1n)` throws. Run — expect PASS.

- [ ] **Step 5: Write `states.ts`** + `states.test.ts`. `ATTEMPT_STATES = ["pending","running","delivered","failed","rejected","cancelled","expired","lost"]`; `TERMINAL_STATES` = all except `pending`,`running`; `FailureBlame = "task" | "infrastructure"` (the TES `EXECUTOR_ERROR`/`SYSTEM_ERROR` split, §10.3). Test asserts the 8 states and the terminal partition. Run — expect PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(task-execution): error-category vocabulary, event vocabulary, attempt state machine"`

### Task 1.6: The observation fold (`foldObservations`)

**Files:**
- Create: `packages/task-execution/protocol/src/fold.ts`
- Create: `packages/task-execution/protocol/src/fold.test.ts`

**Interfaces:**
- Consumes: `ProtocolObservation` (Task 1.4), event constants + `AttemptState`/`FailureBlame` (Task 1.5).
- Produces:
  - `type DerivedAttemptState = { state: AttemptState; terminal: boolean; contradictory: boolean; cancelRequested: boolean; blame?: FailureBlame; executor?: string; effectiveDeadline?: string; executionIds: readonly string[]; deliveries: readonly { digest: \`sha256:${string}\` }[] }`.
  - `foldObservations(observations: readonly ProtocolObservation[], opts?: { now?: string; effectiveDeadline?: string }): DerivedAttemptState` — implements §10.4 exactly. **Program §7.16 (field-level refinement of the frozen §22 name):** the optional second parameter is the clock/deadline seam. **Without `opts`** the fold is a pure log fold — no provisional `expired` is ever derived (a clockless projection). **With `opts` carrying `now` + `effectiveDeadline`**, when no authoritative `attempt-terminal` exists and `now` is past `effectiveDeadline`, the fold derives provisional `expired` per §10.4 rule 5 (superseded by any later authoritative terminal **without** `contradictory`). The expired/lost supersede-without-contradictory logic is identical either way.
  - `type AttemptDescriptor` — the §9/§22 projection **materialized as `observe()`'s surface** (Task 2.x), carrying: `attempt` (Attempt URI), `task` (the one Task digest, §9.1), `submission` (the one Submission URI, §9.1), `annotations?` (correlation annotations, §6.4), and `derived: DerivedAttemptState` (which itself carries the executor IRI, effective deadline, and the `executionIds`/`deliveries` edges). Defined here so the frozen §22 name is a real export; its reference fields (`task`/`submission`/`annotations`) are supplied at materialization by the consumer that holds the Submission + dispatch context (the pure log fold does not carry them). This is the canonical projection the backend `observe` (Task 2.x) rests on.

- [ ] **Step 1: Write the failing `fold.test.ts`.** One test per §10.4 rule, using minimal hand-built observation arrays:
  - terminal absorbing: a `progress.v1` after `attempt-terminal{delivered}` does not un-terminate;
  - dedupe on (`source`,`id`): a replayed `attempt-started` counts once;
  - out-of-order non-terminal resolved by `sequence`;
  - contradictory terminals: two distinct `attempt-terminal` (both `delivered` vs `failed`) → state = first-in-sequence, `contradictory: true`;
  - **clockless fold has no provisional `expired`:** a log with no terminal, folded **without `opts`**, is `pending`/`running` (never `expired`);
  - **provisional `expired` (opts-driven, §7.16 / §10.4 rule 5):** a log with no terminal, folded with `opts = { now, effectiveDeadline }` where `now` is past `effectiveDeadline` → `state: "expired"`; and the same-shaped log that additionally ends in an authoritative `attempt-terminal{delivered}` → `state: "delivered"` **without** `contradictory` (the genuine terminal supersedes provisional expired, whether or not `opts` is supplied);
  - `lost` quasi-terminal: `attempt-terminal{lost}` superseded by a later `attempt-terminal{delivered}` **without** `contradictory`; any other terminal→terminal stays `contradictory`;
  - `cancel-requested` is a flag, not a state: a `cancel-requested` then `attempt-terminal{delivered}` → `state: "delivered", cancelRequested: true`;
  - `execution-observed` accumulates `executionIds`; `delivery-recorded` accumulates `deliveries`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `fold.ts`.** Pure fold over the log: dedupe on (`source`,`id`); sort by `sequence`; walk once. Track the first authoritative terminal by sequence; on a second terminal apply the §10.4 rules 4–6 (contradictory unless the prior terminal was `expired` (provisional) or `lost` (quasi-terminal)). Non-terminal states set `pending`/`running` up to the first terminal. `cancel-requested`/`cancel-acknowledged` set flags. **Provisional `expired` is derived only when `opts` supplies both `now` and `effectiveDeadline`** (program §7.16): if the walk found no authoritative `attempt-terminal` and `now` is past `effectiveDeadline`, set `state: "expired"` provisionally (superseded by any authoritative terminal, so this only surfaces when the log truly has none). **Without `opts` the fold never yields `expired`** — it is a pure log fold. Keep the whole function order-insensitive up to the terminal per rule 3.

- [ ] **Step 4: Run — expect PASS.** Re-run the full `protocol` suite: `yarn test`.

- [ ] **Step 5: Commit.** `git commit -m "feat(task-execution): observation fold implementing the §10.4 state derivation"`

### Task 1.7: Sealing entry points + requirements/run-pinning merge (carried amendment 1)

**Files:**
- Create: `packages/task-execution/protocol/src/sealing.ts`
- Create: `packages/task-execution/protocol/src/sealing.test.ts`
- Create: `packages/task-execution/protocol/src/requirements.ts`
- Create: `packages/task-execution/protocol/src/requirements.test.ts`

**Interfaces:**
- Consumes: `serializeCanonicalJson`, `documentDigest`, family validators.
- Produces: `sealTask(document: unknown): Uint8Array`, `sealSubmission(document: unknown): Uint8Array`, `sealDelivery(document: unknown): Uint8Array` (validate → I-JSON enforce → JCS → exact bytes; §22); `type ComparisonClass = "exact" | "ceiling" | "floor" | "constraint" | "addable"`; `type EffectiveRequirements` (the merged effective requirement map — a **protocol export**; backend-local's TaskView consumes it, program §7.3); `mergeRequirements(taskRequirements, submissionRequirements, keyClasses): { ok: true; effective: EffectiveRequirements } | { ok: false; category: "invalid-document"; key: string }` — the tighten-only merge of profiles §5.1 (program §7.3, the exact pinned signature), evaluated by a backend at `submit` over both byte documents; on success it returns the effective merged map. `keyClasses` = the fixed core-key classes plus the resolved profile document's `requirementKeys` classes, **assembled by the caller**. **`unsupported-requirement` is never produced here** — a pinning key absent from a backend's capability inventory is the product of the **backend capability check** (§5.2), not of this pure merge (program §7.3).

- [ ] **Step 1: Write the failing `sealing.test.ts`.** (a) `sealTask` on a valid Task returns bytes whose `documentDigest` is stable across two source key orderings (equivalence); (b) `sealTask` on a Task with a fractional `payload` number throws `IJsonNumberError`; (c) `sealSubmission`/`sealDelivery` reject their respective invalid documents with an `invalid-document`-flavored error; (d) **seal-once**: parsing sealed bytes back to an object and re-sealing yields identical bytes (idempotent canonical form) — and the plan's consumer rule that a "loaded" document keeps original bytes is exercised by comparing `documentDigest(originalBytes)` to a freshly re-sealed digest and asserting equality only because the input was already canonical.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `sealing.ts`.** Each `seal<Family>` runs `validate<Family>` (throw a typed `invalid-document` error carrying the zod issues on failure), then `serializeCanonicalJson` (which enforces I-JSON integers). Export the thrown error shape as a plain object carrying `{ category: "invalid-document", errors }` — the `backend` package will wrap it in `TaskExecutionError`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Write the failing `requirements.test.ts`** driving `mergeRequirements`. One case per comparison class (profiles §5.1 table); each passing case asserts both `ok: true` **and** the returned `effective` map (the tightened value that wins): `exact` (byte-equal → `effective` = that value; else `invalid-document`); `ceiling` (Submission ≤ Task numeric → `effective` = Submission's tighter value); `floor` (`effort` tier: Submission ≥ Task, using the `low<medium<high<xhigh<max` order → `effective` = Submission's higher tier); `constraint` (Task `model:{provider:"anthropic"}` admits Submission `model:{id:"claude-…"}` → `effective` = the Submission pin; a pin outside → `invalid-document`); `addable` (key absent in Task → Submission sets freely → `effective` carries it). Plus: a key present in both whose class has no applicable relation, or an unknown class, is `{ ok: false; category: "invalid-document"; key }` on byte-inequality (the conservative default). Add one assertion that a Submission pinning key **not** in a backend inventory is **not** flagged by `mergeRequirements` (that check belongs to the backend capability path, §7.3).

- [ ] **Step 6: Run — expect FAIL.**

- [ ] **Step 7: Write `requirements.ts`.** Implement `mergeRequirements` returning `{ ok: true; effective }` on success (the effective merged map = the tightened value per key) and `{ ok: false; category: "invalid-document"; key }` on the first violating key. Implement `exact`/`ceiling`/`floor`/`addable` generically; `constraint` via a small per-key membership registry (`model` supplied; unknown constraint keys fall through to the conservative default). `effort` tier order is a fixed constant. Profile-added keys supply their own class (§5.1); an undeclared class is the conservative default. This pure merge never consults a backend capability inventory (no `unsupported-requirement` here — §7.3).

- [ ] **Step 8: Run — expect PASS.**

- [ ] **Step 9: Commit.** `git commit -m "feat(task-execution): sealing entry points + tighten-only run-pinning merge (carried amendment 1)"`

### Task 1.8: Golden + adversarial fixtures, barrel export, pack-smoke, schema drift gate

**Files:**
- Create: `packages/task-execution/protocol/fixtures/golden-task-execution-v1/` (the golden **local + marketplace scenario pair over one Task digest**, §24) — sealed Task bytes, two Submissions (local + marketplace), observation logs, Deliveries, plus a `conformance-report.json` pinning every digest and an `equivalence/` record with two key-permuted Task inputs that seal to the same digest (the mandated key-order-sensitive cross-package equivalence record).
- Create: `packages/task-execution/protocol/fixtures/adversarial-v1/` (the §24 adversarial minimum set — enumerated in Task 3.3; the protocol package **ships the fixture bytes**, the testing kit drives them).
- Create: `packages/task-execution/protocol/src/fixtures.ts` (loaders resolving `fixtures/*` from the package root) + `src/fixtures.test.ts`.
- Create: `packages/task-execution/protocol/src/index.ts` (final barrel — replaces the Task 1.1 stub).
- Create: `packages/task-execution/protocol/scripts/pack-smoke.mjs`
- Create: `packages/task-execution/protocol/README.md`
- Create: `packages/task-execution/protocol/scripts/generate-golden-fixture.mjs` (regenerates the golden pair deterministically from source objects, so digests are reproducible — mirrors evidence's `generate-golden-fixture.mjs`).

**Interfaces:**
- Consumes: everything in Milestone 1.
- Produces: `@jinn-network/task-execution-protocol` public surface (barrel) + the `./fixtures/*` and `./schemas/*` asset exports the testing kit and pack-smoke consume.

- [ ] **Step 1: Write `generate-golden-fixture.mjs`** that constructs one Task, seals it, derives one local Submission (random-UUID Attempt, §9.2 single-party) and one marketplace Submission (deterministic UUIDv5 Attempt over the §16.2 tuple), builds a valid observation log for each ending in `attempt-terminal{delivered}`, seals a Delivery for each, and writes all bytes + a `conformance-report.json` recording each `sha256:` digest and the shared Task digest. Run it to materialize `fixtures/golden-task-execution-v1/`.

- [ ] **Step 2: Write the equivalence record** under `fixtures/golden-task-execution-v1/equivalence/`: two JSON files with the **same** Task content but keys in different source order, plus the expected shared `sha256:` in `expected-digest.json`. A test (`fixtures.test.ts`) seals both and asserts identical digests — the key-order-sensitive cross-package equivalence record mandated for every sealed-bytes package.

- [ ] **Step 3: Write the adversarial fixture bytes** for the §24 minimum set (the testing kit's Task 3.3 enumerates the assertions; here you author only the **byte artifacts**): malformed document, digest-mismatch pair, illegal terminal-transition observation log, replayed + out-of-order log, a `sequence` pair straddling the 16-digit boundary, contradictory-terminal log, expired-then-late-terminal log, lost-then-corrected log, forged cross-Attempt `supersedes` Delivery, cross-requester / same-key-different-bytes Submission pair, dispatch-context-grafting crate stub, leaked-Task-resubmission Submission, extension-override record, oversized inline-content + payload-bound-violation records.

- [ ] **Step 4: Write `src/fixtures.ts` + `fixtures.test.ts`.** Loaders read from `new URL("../fixtures/…", import.meta.url)`; the test validates every golden document against its family validator and asserts the pinned digests in `conformance-report.json` match freshly computed ones (producer-side check). Add the consumer-side check: `documentDigest` over the stored exact bytes equals the pinned digest **without** re-sealing (§6.1/§24).

- [ ] **Step 5: Write the final `src/index.ts` barrel** re-exporting: `TASK_EXECUTION_PROTOCOL_URI`; order/hashing/canonical/json; descriptors + identifiers **including the exported `TEP_ATTEMPT_NAMESPACE` constant** (program §7.2 — the marketplace binding consumes it) and `deriveAttemptUri`/`isValidUrnUuid`/`compareCodeUnitStrings`; all schema types + validators; error + event + state vocabularies; `foldObservations` + `DerivedAttemptState` + `AttemptDescriptor`; sealing + the requirements merge (`mergeRequirements` + `EffectiveRequirements` + `ComparisonClass`); fixtures loaders. This is the frozen §22 public surface (records + pure functions).

- [ ] **Step 6: Write `pack-smoke.mjs`** mirroring evidence's: `yarn pack` → install the tarball into a temp consumer → a smoke script that imports the root (asserts `TASK_EXECUTION_PROTOCOL_URI`), resolves a `./schemas/*` and a `./fixtures/*` asset, runs a validator over a golden fixture, asserts **zero** `@jinn-network/*` runtime dependencies, and asserts no `.test.` files leaked into `dist`.

- [ ] **Step 7: Write `README.md`** (short: what the package is, the frozen surface, the seal-once rule, a pointer to the design doc and the carried-amendment addendum from Task 4.2).

- [ ] **Step 8: Full verification gate.**

```bash
cd packages/task-execution/protocol
yarn typecheck && yarn test && yarn check:schemas && yarn build && yarn pack:smoke
cd - && node --test .github/scripts/task-execution-package-inventory.test.mjs \
        && node --test .github/scripts/task-execution-source-boundaries.test.mjs
```

Expected: all green.

- [ ] **Step 9: Commit.** `git commit -m "feat(task-execution): golden + adversarial fixtures, barrel export, pack-smoke"`

---

## Milestone 2 — Backend contract package

Delivers `@jinn-network/task-execution-backend` (design §14/§15/§22). Depends on `protocol` only. Registers itself in the guards.

### Task 2.1: Backend package scaffolding + guard registration

**Files:**
- Create: `packages/task-execution/backend/{package.json,.yarnrc.yml,tsconfig.json,tsconfig.build.json,vitest.config.ts,scripts/build.mjs,scripts/pack-smoke.mjs,src/index.ts (stub)}`
- Modify: `.github/scripts/task-execution-package-inventory.test.mjs`
- Modify: `.github/scripts/task-execution-source-boundaries.test.mjs`
- Modify: `.github/scripts/task-execution-packed-types.test.mjs`
- Modify: `.github/workflows/task-execution-ci.yml`

**Interfaces:**
- Produces: the backend package skeleton; the guard state advances to **2** packages.

- [ ] **Step 1: Write `package.json`** — name `@jinn-network/task-execution-backend`, `dependencies: { "@jinn-network/task-execution-protocol": "0.1.0" }`, `resolutions: { "@jinn-network/task-execution-protocol": "portal:../protocol" }`, exports root only, scripts as protocol's minus schema generation (`build` = `tsc -p tsconfig.build.json`, `typecheck`, `test`, `pack:smoke`, `prepack`). Copy the other toolchain files verbatim from protocol.

- [ ] **Step 2: Write `src/index.ts` stub** (`export {};`) so the skeleton builds.

- [ ] **Step 3: Register `backend` in the inventory guard.** Add `['backend', '@jinn-network/task-execution-backend']` to `TASK_EXECUTION_PACKAGES`; add its graph entry `['backend', { dependencies: ['@jinn-network/task-execution-protocol'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }]`; bump the count assertion to `2`.

- [ ] **Step 4: Register `backend` in the source-boundaries guard.** Add `'backend'` to `taskExecutionDirectories`; extend the one-way-graph test: `assertBoundary(join(packages, 'backend', 'src'), [...TASK_EXECUTION_FOREIGN_PACKAGES])` and assert `backend` imports **no** task-execution package except protocol (forbid `@jinn-network/task-execution-testing` and any future sibling from `backend/src`).

- [ ] **Step 5: Register `backend` in packed-types + CI.** Add `['backend', '@jinn-network/task-execution-backend']` to `packages` and `'@jinn-network/task-execution-backend'` to `codeEntrypoints`; add a `backend` CI job depending on `foundation` (restores protocol dist, installs, typecheck/test/build/pack:smoke) and add it to the `verify` needs list.

- [ ] **Step 6: Run the guards** (`node --test` both scripts) — expect PASS with 2 packages. Build the skeleton (`yarn install && yarn typecheck && yarn build`).

- [ ] **Step 7: Commit.** `git commit -m "feat(task-execution): scaffold backend package + register in guards"`

### Task 2.2: Capability model + supporting types + TaskExecutionError + the backend interface

**Files:**
- Create: `packages/task-execution/backend/src/capabilities.ts`
- Create: `packages/task-execution/backend/src/capabilities.test.ts`
- Create: `packages/task-execution/backend/src/types.ts`
- Create: `packages/task-execution/backend/src/errors.ts`
- Create: `packages/task-execution/backend/src/errors.test.ts`
- Create: `packages/task-execution/backend/src/backend.ts`
- Create: `packages/task-execution/backend/src/index.ts` (final barrel)
- Create: `packages/task-execution/backend/README.md`

**Interfaces:**
- Consumes: from `protocol` — `ProtocolObservation`, `ResourceDescriptor`, `TaskExecutionErrorCategory`, `isRetryable`, `AttemptState`, `DerivedAttemptState`, `AttemptDescriptor`, digest/URI types.
- Produces: `BackendCapabilities` (§15 + carried amendment 1 `runPinning` block); `SubmissionAck`, `ObservationSnapshot`, `ObservationCursor`, `ReconciliationReport`, `CancelAck`, `DeliveryRef`, `PreflightRequest`, `PreflightReport`, `SubmissionUri`, `AttemptUri`; `class TaskExecutionError`; `interface TaskExecutionBackend`.

- [ ] **Step 1: Write `capabilities.ts`** — `BackendCapabilities` per §15: `taskProfiles: string[]`, `inputMediaTypes`/`outputMediaTypes: string[]`, `maxArtifactBytes?: number`, `cancel`/`watch`/`preflight`/`fetchArtifact`/`confidentialInputs`/`signedObservations`/`signedDeliveries: boolean`, `evidenceCapture: "none" | "available" | "always"`, `deadlineEnforcement: boolean`, `isolation: string[]`, `attempts: { maxTotal?: [number, number]; maxConcurrent?: [number, number] }`, and — **carried amendment 1 (profiles §5.2)** — `runPinning: { keys: RunPinningKeySupport[] }` where each entry declares a supported pinning key, its inventory, and its enforcement posture `"enforced" | "attested"`. A pinning key the backend does not declare → `unsupported-requirement` at `submit` (rule stated in the doc comment; enforced by bindings).

- [ ] **Step 2: Write `capabilities.test.ts`** asserting the `runPinning` posture enum and a representative capability record type-checks. Run — expect PASS.

- [ ] **Step 3: Write `types.ts`** — the supporting types, exact per §14/§22:
  - `type SubmissionUri = \`urn:uuid:${string}\``; `type AttemptUri = \`urn:uuid:${string}\``;
  - `SubmissionAck = { submission: SubmissionUri; accepted: true } | { accepted: false; error: TaskExecutionError }` (or an accepted ack carrying the sealed-Submission digest — refine field-level; pin with a kit fixture);
  - `ObservationSnapshot = { descriptor: AttemptDescriptor; cursor: ObservationCursor; observations: readonly ProtocolObservation[] }` (the `observe` return — the **materialized `AttemptDescriptor`** (program §7.16 / §9 / §22) surfaced alongside the log position and raw log; the derived state is reachable at `descriptor.derived`, and the descriptor also carries the one Task digest, the one Submission URI, and correlation annotations so a caller learns which Task/Submission the Attempt belongs to without re-scanning the observations, §14);
  - `ObservationCursor = { sequence: string }` (opaque resumable position);
  - `ReconciliationReport = { classification: "matching" | "absent" | "contradictory"; detail?: string }` (§12.2/§14);
  - `CancelAck = { requested: boolean; terminalState?: AttemptState }` (terminal-state-aware, idempotent, §12.1);
  - `DeliveryRef = { attempt: AttemptUri; digest: \`sha256:${string}\`; locators?: ResourceDescriptor }`;
  - `PreflightRequest`/`PreflightReport` (the fail-closed dry run, §14) — `PreflightReport = { ready: boolean; detail?: string; error?: TaskExecutionError }`.

- [ ] **Step 4: Write `errors.ts`** — the class, consuming the enum from `protocol` (no duplicate enum):

```ts
import {
  isRetryable,
  type TaskExecutionErrorCategory,
} from "@jinn-network/task-execution-protocol";

export class TaskExecutionError extends Error {
  readonly category: TaskExecutionErrorCategory;
  readonly retryable: boolean;
  readonly detail?: string;
  /** namespaced native annotations (binding-native identifiers ride here, §6.4/§13). */
  readonly annotations?: Readonly<Record<string, unknown>>;

  constructor(
    category: TaskExecutionErrorCategory,
    options?: { message?: string; detail?: string; retryable?: boolean; annotations?: Record<string, unknown> },
  ) {
    super(options?.message ?? category);
    this.name = "TaskExecutionError";
    this.category = category;
    this.retryable = options?.retryable ?? isRetryable(category);
    this.detail = options?.detail;
    this.annotations = options?.annotations;
  }
}
```

- [ ] **Step 5: Write `errors.test.ts`** — constructing a `backend-unavailable` error defaults `retryable: true`; an `invalid-document` error defaults `false`; an explicit `retryable` override wins; annotations round-trip. Run — expect PASS.

- [ ] **Step 6: Write `backend.ts`** — the `TaskExecutionBackend` interface **exactly** per §14 (signatures verbatim from the design's TypeScript block; `recover` mandatory; `preflight`/`watch`/`cancel`/`fetchArtifact` optional). Add the doc comments carrying the §14 semantic contracts (submit takes exact bytes, observe never infers success from liveness, recover returns the reconciliation classification, the four never-expose prohibitions). Document that `observe` **materializes the `AttemptDescriptor`** it returns (program §7.16): it folds the observation log (passing `{ now, effectiveDeadline }` so provisional `expired` derives when due) and fills the descriptor's reference fields — the one Task digest, the one Submission URI, and correlation annotations — from the Submission + dispatch context the backend already holds, never from a re-scan by the caller.

- [ ] **Step 7: Write the final `index.ts` barrel** re-exporting capabilities, types, `TaskExecutionError`, and the interface. Write `README.md` (frozen contract surface + the four prohibitions + pointer to §14).

- [ ] **Step 8: Verification gate.**

```bash
cd packages/task-execution/backend && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd - && node --test .github/scripts/task-execution-package-inventory.test.mjs \
        && node --test .github/scripts/task-execution-source-boundaries.test.mjs
```

Expected: all green.

- [ ] **Step 9: Commit.** `git commit -m "feat(task-execution): backend contract — capabilities, types, error class, interface"`

---

## Milestone 3 — Conformance testing kit (Layers 1–2)

Delivers `@jinn-network/task-execution-testing`. Depends on `protocol` + `backend`. Ships the §24 Layer-1 (protocol conformance over golden + adversarial fixtures) and Layer-2 (backend contract sanity suite) content, plus the in-memory fake backend — **proven first** (design §26, coordinator brief). Registers itself in the guards.

### Task 3.1: Testing package scaffolding + guard registration

**Files:**
- Create: `packages/task-execution/testing/{package.json,.yarnrc.yml,tsconfig.json,tsconfig.build.json,vitest.config.ts,scripts/build.mjs,scripts/pack-smoke.mjs,src/index.ts (stub)}`
- Modify: the three guard scripts + CI workflow (register `testing`).

- [ ] **Step 1: Write `package.json`** — name `@jinn-network/task-execution-testing`, `dependencies: { "@jinn-network/task-execution-protocol": "0.1.0", "@jinn-network/task-execution-backend": "0.1.0" }`, matching `resolutions` portals (`portal:../protocol`, `portal:../backend`), `peerDependencies: { "vitest": "^4.1.8" }` + `peerDependenciesMeta.vitest.optional = true` (the kit's `describe…Contract` is invoked under the consumer's vitest — same pattern as evidence `repository/testing`). Exports `"."` and `"./fixtures/*"`.

- [ ] **Step 2: Write `src/index.ts` stub** and the toolchain files.

- [ ] **Step 3: Register `testing` in all three guards + CI** — inventory count `3`, graph entry `testing → [protocol, backend]` (with the exact `dependencies`/`peerDependencies` split: protocol+backend in `dependencies`, `vitest` in `peerDependencies`); boundaries `taskExecutionDirectories` gains `'testing'` (it may import protocol + backend, nothing foreign); packed-types adds the package + `'@jinn-network/task-execution-testing'` entrypoint; CI adds a `testing` job depending on `[foundation, backend]` (restore protocol+backend dist, install, typecheck/test/build/pack:smoke) and add to `verify` needs. Mirror the evidence inventory guard's **optional-peer test** for this package (assert `peerDependencies == { vitest: "^4.1.8" }` and `peerDependenciesMeta.vitest.optional == true`).

- [ ] **Step 4: Run the guards** — expect PASS with 3 packages. Build the skeleton.

- [ ] **Step 5: Commit.** `git commit -m "feat(task-execution): scaffold testing kit + register in guards"`

### Task 3.2: In-memory fake backend (proven first)

**Files:**
- Create: `packages/task-execution/testing/src/fake-backend.ts`
- Create: `packages/task-execution/testing/src/fake-backend.test.ts`

**Interfaces:**
- Consumes: `TaskExecutionBackend` + supporting types (`backend`), sealing/fold/validators (`protocol`).
- Produces: `class InMemoryTaskExecutionBackend implements TaskExecutionBackend` + `createInMemoryBackend(options?)`. This is the reference the Layer-2 sanity suite (Task 3.4) is proven against **before** any real binding exists.

- [ ] **Step 1: Write the failing `fake-backend.test.ts`** for the core happy path: `submit(taskBytes, submissionBytes)` accepts and mints an Attempt (random UUID — single-party, §9.2); `observe(attempt)` returns a snapshot whose `descriptor.derived.state` is `pending`, then — after an internal `complete()` test helper drives observations — `delivered`, and whose `descriptor.task`/`descriptor.submission` name the submitted Task digest + Submission URI; `recover(ref)` returns `matching`; `deliveries` + `fetchDelivery` return the sealed Delivery bytes; a duplicate byte-identical `submit` returns the same ack (idempotent, §12.2); a same-key/different-bytes `submit` throws `submission-conflict`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `fake-backend.ts`.** Durable-in-memory maps keyed by `(requester, backend, idempotencyKey)` for Submissions and by Attempt URI for observation logs + Deliveries. `submit` validates both byte documents (via protocol validators), enforces byte-exact idempotency, emits `submission-accepted` + `attempt-engaged` (+ dispatch-context descriptor), and stores the log. `observe` returns an `ObservationSnapshot` whose `descriptor` is the **materialized `AttemptDescriptor`** — `foldObservations(log, { now, effectiveDeadline })` for the derived state, with the Task digest / Submission URI / correlation annotations filled from the stored Submission + dispatch context — plus the cursor and the raw log. `recover` reconciles the in-memory record (always `matching` here; the suite injects `absent`/`contradictory` via test seams). `cancel` emits `cancel-requested`/`cancel-acknowledged` and is terminal-state-aware. All state is re-derivable from the stored durable maps (no load-bearing ephemeral state) so `recover` is honest. Expose test-only helpers (`drive(attempt, observations)`, `simulateReconciliation(outcome)`) behind a clearly-named surface so Task 3.4 can exercise all three reconciliation outcomes and cancel races.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "feat(task-execution): in-memory fake backend (kit reference, proven first)"`

### Task 3.3: Layer-1 protocol conformance suite over golden + adversarial fixtures

**Files:**
- Create: `packages/task-execution/testing/src/protocol-conformance.ts` (exported `describeProtocolConformance()` + standalone fixtures the kit ships)
- Create: `packages/task-execution/testing/src/protocol-conformance.test.ts` (runs it in-package)
- Create: `packages/task-execution/testing/fixtures/` (re-exported/copied golden + adversarial assets, or thin loaders over `@jinn-network/task-execution-protocol/fixtures/*`)

**Interfaces:**
- Consumes: protocol validators, sealing, fold, `documentDigest`; the golden + adversarial fixture bytes from Task 1.8.
- Produces: `describeProtocolConformance()` — a vitest `describe` block asserting the §24 Layer-1 rules over the shipped fixtures; consumable by bindings.

- [ ] **Step 1: Write the failing `protocol-conformance.test.ts`** driving `describeProtocolConformance()`. Assertions (§24 Layer 1), one test each:
  - schema validation of all five families over the golden pair;
  - **producer-side** seal check: re-sealing each golden document reproduces its pinned bytes/digest and the output is valid JCS under I-JSON;
  - **consumer-side** check: `documentDigest` over stored exact bytes equals the pinned digest without re-canonicalization;
  - reference + cardinality rules (a Delivery's `task` equals the golden Task digest; an Attempt names exactly one Task + one Submission);
  - extension preservation (a namespaced extension survives seal→bytes because sealed docs travel as bytes);
  - observation ordering + fold correctness over the golden logs;
  - Delivery binding (output descriptor sha256 matches the artifact);
  - the adversarial minimum set — each fixture asserted to the outcome §24 mandates: malformed → `invalid-document`; digest mismatch → `content-corruption`; illegal/unsanctioned terminal transition → `protocol-violation` (or `contradictory` via the fold); replayed + out-of-order → deduped/ordered correctly; `sequence` at the 16-digit boundary → orders correctly; contradictory terminals → `contradictory` flag; derived-`expired` vs late genuine terminal → superseded, no `contradictory`; `lost`-then-corrected → superseded, no `contradictory`; forged cross-Attempt `supersedes` → `invalid-document`; cross-requester + same-key/different-bytes idempotency → distinct scopes / `submission-conflict`; **dispatch-context grafting** → documented as **not** caught by structure alone (assert the protocol layer does not flag it) with a pointer to the Layer-3 `dispatch-binding` check; **capability-grant misuse (leaked-Task resubmission)** → the leaked Task bytes carry no grants (structural assertion; resolution failure is Layer 3); extension-override → `invalid-document` where detectable (§21.3); oversized inline content + payload-bound violations → rejected against the advisory ceilings.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `protocol-conformance.ts`** implementing the describe block. For the two honestly-Layer-3 cases (dispatch-context grafting, leaked-Task grant misuse), encode the boundary explicitly per §24 ("must be caught by the dispatch-binding check, not by structure alone") — the kit documents what the protocol layer does and does not catch, rather than faking a catch.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.** `git commit -m "feat(task-execution): Layer-1 protocol conformance over golden + adversarial fixtures"`

### Task 3.4: Layer-2 backend contract sanity suite, proven against the fake

**Files:**
- Create: `packages/task-execution/testing/src/backend-contract.ts` (exported `describeTaskExecutionBackendContract(makeBackend)`)
- Create: `packages/task-execution/testing/src/backend-contract.test.ts` (runs it against `InMemoryTaskExecutionBackend`)
- Create: `packages/task-execution/testing/src/index.ts` (final barrel: fake backend, `describeProtocolConformance`, `describeTaskExecutionBackendContract`, fixture loaders)
- Create: `packages/task-execution/testing/README.md`

**Interfaces:**
- Consumes: the fake backend (Task 3.2), the backend contract types, protocol sealing/fixtures.
- Produces: `describeTaskExecutionBackendContract(makeBackend: () => TaskExecutionBackend): void` — the csi-sanity-style suite any implementation runs (§24 Layer 2). Bindings in sibling plans import and run it.

- [ ] **Step 1: Write the failing `backend-contract.test.ts`** = `describeTaskExecutionBackendContract(() => createInMemoryBackend())`. The suite (§24 Layer 2) asserts:
  - byte-exact idempotent submit — same-key/same-bytes returns the same ack; same-key/different-bytes → `submission-conflict`;
  - honest `observe` — distinguishes `running`, terminal, and unknown; never infers success from liveness;
  - `recover` after restart with all three reconciliation outcomes (`matching`/`absent`/`contradictory`), fail-loud on `contradictory`;
  - cancel races including cancel-after-terminal (idempotent terminal-aware `CancelAck`);
  - unsupported requirement/parameter rejection at `submit` (`unsupported-requirement` naming the field);
  - failure-category mapping (a backend failure surfaces as a `TaskExecutionError` with a §13 category, distinct from an Attempt terminal `failed`);
  - result retrieval on terminal attempts (`deliveries` + `fetchDelivery` return exact bytes; `result-unavailable` is loud);
  - concurrent Attempts within declared `attempts` bounds.

- [ ] **Step 2: Run — expect FAIL** (`describeTaskExecutionBackendContract` not defined).

- [ ] **Step 3: Write `backend-contract.ts`.** The parameterized suite. Use only the public `TaskExecutionBackend` surface plus a minimal, documented `TestableBackend` seam (the `drive`/`simulateReconciliation` helpers) so real bindings can satisfy it. Keep every string-sort inside the suite code-unit (import `compareCodeUnitStrings` if any ordering is asserted) so the locale guard stays green.

- [ ] **Step 4: Run — expect PASS.** This is the milestone's load-bearing proof: the sanity suite is green against the in-memory fake **before** any real binding exists (§26).

- [ ] **Step 5: Write the final `index.ts` barrel + `README.md`** (how a binding runs both `describe…` blocks; the kit-precedes-bindings rule).

- [ ] **Step 6: Verification gate.**

```bash
cd packages/task-execution/testing && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd - && node --test .github/scripts/task-execution-package-inventory.test.mjs \
        && node --test .github/scripts/task-execution-source-boundaries.test.mjs
```

Expected: all green (3 packages registered; kit green against the fake).

- [ ] **Step 7: Commit.** `git commit -m "feat(task-execution): Layer-2 backend contract sanity suite proven against the fake"`

---

## Milestone 4 — Tree verification + carried-amendment addendum

### Task 4.1: Packed-types tree gate + full CI dry run

**Files:** none created; verification only.

- [ ] **Step 1: Run the packed-types guard over all three packages.**

```bash
(cd packages/task-execution/protocol && yarn build)
(cd packages/task-execution/backend && yarn build)
(cd packages/task-execution/testing && yarn build)
node .github/scripts/task-execution-packed-types.test.mjs
```

Expected: "Compiled a packed TypeScript consumer against 3 public code entrypoints across all task-execution packages." (or the exact count/wording set in Task 1.1 Step 6). This proves the `exports` maps resolve for external NodeNext-strict consumers (§19.10 third-party claim, at the type level).

- [ ] **Step 2: Lint the CI workflow** for the final job DAG (`architecture`, `foundation`, `backend`, `testing`, `verify`) — visually confirm `verify.needs` lists all upstream jobs and `if: always()` gates on their `result == success`.

- [ ] **Step 3: Run the whole suite once more** across the three packages (`yarn test` in each) + both `node --test` guards — all green.

- [ ] **Step 4: Commit** (if any incidental fixups were needed). Otherwise skip.

### Task 4.2: Carried-amendment addendum note

**Files:**
- Create: `docs/superpowers/specs/2026-07-28-tep-v1-implementation-addendum.md`

**Interfaces:**
- Produces: the dated record that TEP v1 **as implemented** absorbs the three carried amendments (coordinator brief: "records them as a dated addendum note").

- [ ] **Step 1: Write the addendum.** A short dated note (Status: informational; not a design change) stating that the shipped `@jinn-network/task-execution-*` packages implement TEP v1 **plus** the three carried amendments from `2026-07-27-task-profiles-and-evaluation-specs-design.md` §13:
  1. the Submission-level requirements map / run-pinning keys + the `BackendCapabilities.runPinning` block + enforcement postures (profiles §5; implemented in `protocol/src/schemas/common.ts` + `submission.ts` + `requirements.ts` and `backend/src/capabilities.ts`);
  2. `Task.profile` as a ResourceDescriptor (URI + digest) + the §6.2 resolution rule (implemented in `protocol/src/schemas/task.ts`; the resolution rule is a backend-`submit` obligation carried by the contract);
  3. the editorial widening of §6.4 "correlation annotations" to admit namespaced-extension application context (implemented as `.loose()` + the widened comment in `submission.ts`).
  Record the deferred/non-blocking follow-ups this plan did **not** implement, with pointers: IANA media-type registration (§28); the reserved-profile-URI publication gate (§7; pre-release checklist); the scheme-IRI/propertyID registration shared with profiles/trust (one program-level follow-up); the `capacity-exhausted` disposition (rides `backend-unavailable`; §13/coordinator mandate 5); the marketplace binding, Autopilot adapter, carrier profiles, and evaluation/verification integration (§16.2/§17/§21.2/§26 steps 5–7 — sibling and later plans). Also record: the **exported `TEP_ATTEMPT_NAMESPACE` constant and the frozen unit-separator (`U+001F`) name-construction rule** for `deriveAttemptUri` (program §7.2 — the marketplace binding consumes the exported constant and reproduces the delimiter byte-for-byte; only the namespace UUID literal was a field-level refinement, pinned by fixture); the error-category `retryable` defaults (pinned by fixture); and that `mergeRequirements` returns the `EffectiveRequirements` map while `unsupported-requirement` stays a backend-capability-check product (program §7.3), `foldObservations` gained the `{ now?, effectiveDeadline? }` clock/deadline seam and `observe()` surfaces the materialized `AttemptDescriptor` (program §7.16), and the canonical serializer builds output by explicit sorted-key iteration with the integer-like-key case pinned in the reference test (program §7.14).

- [ ] **Step 2: Add a pointer** to this addendum from each package `README.md` (already done in Tasks 1.8/2.2/3.4 if written to reference it; otherwise add the one-line link now — README edits are in-scope files this plan created).

- [ ] **Step 3: Commit.** `git commit -m "docs(task-execution): TEP v1 implementation addendum (carried amendments + follow-ups)"`

---

## Out of scope

Explicitly **not** in this plan (owned by sibling/later plans or recorded follow-ups):

- **`@jinn-network/task-execution-backend-local`** — the local binding + kit reference implementation (design §16.1/§23). Sibling plan `2026-07-28-task-execution-backend-local.md` (Phase 4); it consumes the testing kit shipped here, imports `evidence/execution-recorder` at the binding layer only, and registers itself into the guard files this plan creates.
- **`@jinn-network/task-execution-profiles`** — task-profile document mechanism + EvaluationSpec (profiles design). Sibling plan (Phase 3); registers itself into the guards; depends on `protocol` only.
- **Jinn marketplace binding** (§16.2/§23) — lives in the marketplace application tree, not `packages/task-execution/`; drags chain/Mech/IPFS/Safe machinery. Out (coordinator "Out of scope: marketplace binding").
- **Autopilot backend adapter** (§17/§25/§26 step 6) — application-tree migration; out.
- **Carrier profiles** (HTTP service shape / queue / on-chain transports, §21.2/§28) — future packages; no v1 work gated on them.
- **Evaluation + verification integration** (§26 step 7): evaluation-profile Tasks, the `evaluationSpecification`-digest crosswalk check, the `dispatch-binding` verification check, verification-backed Attempt↔evidence binding — later work (backend-local + profiles + evidence-profile minor addition).
- **The Evidence-profile minor addition** (identifier PropertyValue extended to Task/Execution + TEP scheme propertyID IRIs, §18/§28) — a cross-lane evidence amendment scheduled in the backend-local plan **before** the crosswalk-stamp/verification integration stage; not implemented here.
- **IANA media-type registration** and **reserved-profile-URI publication** — recorded non-blocking follow-ups (Global Constraints; §7/§21.1/§28).
- **capacity-exhausted as a distinct error category** — do NOT add; rides `backend-unavailable` (coordinator mandate 5).
- **Extraction of a shared guard helper library** — the precedent is copy-file-and-swap-constants; defer helper extraction until a second tree exists (evidence-substrate open question, non-blocking).

## Self-review checklist (run before handoff)

- [ ] Every design section that defines a frozen §22 surface has a task: records (Task 1.4), sealing/fold/attempt-URI/validators/requirements-merge (Tasks 1.2/1.3/1.6/1.7), error categories + events + states (Task 1.5), backend contract + capabilities + error class (Task 2.2), kit Layers 1–2 + fake (Milestone 3).
- [ ] All three carried amendments are implemented (Tasks 1.4/1.7/2.2) and recorded (Task 4.2).
- [ ] Guard clone lands with the first package (Task 1.1) and each package registers itself (Tasks 2.1/3.1).
- [ ] Every sealed-bytes deliverable ships `order.ts`, pinned-digest golden fixtures, a key-order-sensitive equivalence record, and is covered by the locale-ban guard (Tasks 1.2/1.8).
- [ ] No placeholder steps; the one intentional `PLACEHOLDER` (attempt-URI namespace) is computed and frozen in Task 1.3 Step 5.
- [ ] Type names are consistent across tasks (`DerivedAttemptState`, `AttemptDescriptor`, `TaskExecutionError`, `TaskExecutionBackend`, `BackendCapabilities`, `mergeRequirements`, `EffectiveRequirements`, `TEP_ATTEMPT_NAMESPACE`, `foldObservations`, `deriveAttemptUri`, `serializeCanonicalJson`, `documentDigest`).

## Addendum 2026-07-28-b — two-party engagement entry on `submit` (authorized widening)

The marketplace-binding design's companion amendment (operator addendum 2026-07-28;
anticipated by TEP §9.2) is realized as an **optional third parameter** on the frozen
backend contract: `submit(taskBytes, submissionBytes, engagement?: TwoPartyEngagement)` with
`TwoPartyEngagement = { attemptUri, dispatchContext }` — the caller-supplied deterministic
Attempt URI computed via the protocol exports `deriveAttemptUri` + `TEP_ATTEMPT_NAMESPACE`
(program §7.2). Rationale (marketplace plan finding F1): a Submission-document field is
impossible (the URI depends on `attemptIndex`, known only at claim time, after the requester
seals the Submission); a separate `engage()` verb violates ruling §7.18. Coordinator
disposition: authorized as a design-sanctioned amendment, implemented as a small work item at
the START of Phase 4 (before backend-local Milestone C freezes): widen the interface +
`SubmissionAck`/conformance coverage in `task-execution-backend` and the testing kit
(supplied-URI adoption, format validation, absent-in-single-party semantics unchanged; the
in-memory fake honors it). Two-party mode additionally scopes the `attempts` honor-or-reject
to the single caller-identified attempt (the chain enforces `maxClaims`) — marketplace plan
finding F4.
