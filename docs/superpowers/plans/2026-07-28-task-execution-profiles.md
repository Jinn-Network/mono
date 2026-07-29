# Task Execution Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Status:** draft (pending program approval)

**Date:** 2026-07-28

**Implements:** `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md`
(the Task Profiles and Evaluation Specifications v1 design — "the design"). Section references
(`§N`) throughout point into that document.

**Depends on sibling 2026-07-28 plans (by filename):**
- `docs/superpowers/plans/2026-07-28-task-execution-protocol.md` — **hard dependency.** Creates
  `@jinn-network/task-execution-protocol` (the only package this lane imports), the three carried
  TEP amendments this lane assumes (design §5/§6.2/§13; see Global Constraints), the
  `@jinn-network/task-execution-testing` conformance kit whose golden/adversarial split this
  package's kit mirrors, **and the task-execution tree's guard clones**
  (`.github/scripts/task-execution-*.test.mjs` + `.github/workflows/task-execution-ci.yml`).
  This plan **registers** the profiles package into those guards; it does not clone them. Per the
  program DAG (Phase 2 S1 → Phase 3), the TEP protocol package, its testing kit, and the guards all
  land before this lane begins.

**Goal:** Ship `@jinn-network/task-execution-profiles` — the sealed EvaluationSpec format, the
sealed task-profile document mechanism (with hardened untrusted-schema loading, digest-keyed
validator caches, and structural `allOf` sub-profiles), the closed-vocabulary verdict rule +
verdict-consistency + unscorable taxonomy, the DSSE admission-receipt shape, the two v1 sealed
profile documents (`repository-work/1.0`, `evaluation-task/1.0` with its full-document derivation
template), and the §12 conformance kit + fixture families — importing `task-execution-protocol`
only.

**Architecture:** A pure, I/O-free schema-and-sealing package beside the TEP stack. It re-implements
canonicalization/sealing locally (per-package, never a shared runtime dep) so its sealed bytes are
byte-compatible with the TEP protocol sealer and with the Evidence Result Evaluation predicate —
compatibility held by **fixtures, not imports**. Two authoritative sealed documents ship as assets
with pinned digests; compiled JSON-Schema-2020-12 validators are digest-keyed caches over those
authoritative documents. The conformance kit (fixtures + a pure structural runner) lives in the
package and is exported for downstream consumers; the package itself never depends on the TEP
testing kit (fixture consumers depend on `profiles`, keeping the graph acyclic — design §12/§14).

**Tech Stack:** TypeScript 5.9, Node.js 22 ESM, Yarn 4.13.0 (standalone project — own `yarn.lock`,
`nodeLinker: node-modules`), Vitest 4, `@jinn-network/task-execution-protocol` (portal resolution),
`@noble/hashes`, `canonicalize` (RFC 8785 JCS), `zod` (document schemas), `ajv` (`ajv/dist/2020` —
JSON Schema 2020-12 payload validation), `safe-regex` (ReDoS static analysis for §6.4 hardening).

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the
design and the coordinator brief.

- **Imports `task-execution-protocol` ONLY.** No evidence package, no discovery, no trust, no
  marketplace, no other task-execution sibling. Claim inspection is structural JSON — no evidence
  import (design §12/§14). The source-boundaries guard encodes this.
- **Sealing is re-implemented in this package** (per-package order.ts + canonical serializer; never
  a shared runtime dep). Ship pinned-digest golden fixtures and at least one object-key-sort-
  sensitive record in cross-package equivalence fixtures; the tree's locale-ban guard covers all
  production source (coordinator brief, sealing precedent).
- **UTF-16 code-unit ordering everywhere sealed bytes are produced.** `localeCompare`,
  `toLocale*`, and `Intl` are banned in all production source; use `compareCodeUnitStrings`
  (`src/order.ts`). `canonicalize` (JCS) sorts object keys by code unit per RFC 8785 §3.2.3 —
  matching the comparator; use it for the JSON key sort and `compareCodeUnitStrings` for every
  array-of-string sort that reaches sealed bytes.
- **Media types (frozen, §6/§7/§9.2):** task-profile document =
  `application/vnd.jinn.task-execution.task-profile.v1+json`; EvaluationSpec =
  `application/vnd.jinn.task-execution.evaluation-spec.v1+json`; the evaluation-task verdict output
  DSSE envelope `payloadType` = `application/vnd.in-toto+json`.
- **Reserved profile-instance URIs (§8/§9), must resolve to the published document before EXTERNAL
  conformance claims — internal work does not gate on publication:**
  `https://jinn.network/task-profiles/repository-work/1.0`,
  `https://jinn.network/task-profiles/evaluation-task/1.0`. Recorded as a pre-release checklist item
  (coordinator brief mandate 6), not a task here.
- **URI namespace split (§3):** task-profile *instances* live under
  `https://jinn.network/task-profiles/…`; protocol/document-format URIs live under
  `https://jinn.network/profiles/…`. The `protocol` (format) field values proposed by this plan —
  `https://jinn.network/profiles/task-profile/1.0` (task-profile document format),
  `https://jinn.network/profiles/evaluation-spec/1.0` (EvaluationSpec format) — are program-gate
  confirmations (see Findings).
- **`semanticsVersion` initial value = `"4"`** — the current `EVAL_SEMANTICS_VERSION` code constant
  (`client/src/solver-types/_swe-rebench-v2-validated-pool.ts`), promoted into sealed bytes (§7.1).
- **Comparison classes (5, frozen, §5.1):** `exact` | `ceiling` | `floor` | `constraint` |
  `addable`. Unknown class or no-applicable-relation on byte-inequality = `invalid-document`.
- **Grader families (4, §7.1):** `deterministic-process` | `model-graded` | `human-review` |
  `composite`. `composite` bounds: depth ≤ 2, fan-out ≤ 32.
- **Sub-profile chain depth ≤ 8 (§6.3);** single parent; `payloadSchema` MUST be
  `allOf: [<digest-embedded parent>, <refinement>]`; parents extension-tolerant; family URI =
  unversioned URI of the root ancestor.
- **Unscorable dispositions (2, §7.4):** `retryable-infrastructure` (no verdict; Attempt terminates
  `failed {blame: infrastructure}`; never FAIL, never inconclusive) and `recorded-inconclusive`
  (verdict IS `inconclusive` with a named, spec-bounded limitation).
- **No secrets in sealed documents, ever (§7.1/§11).** Profiles, specs, and receipts carry digests
  and access classifications only; grants ride Submissions (TEP §7.5/§8, out of lane).
- **I-JSON integers only in sealed bytes (program §7.14 / TEP §6.1).** The seal path
  (`canonicalJsonBytes`, Task 1) rejects any number not exactly representable as an I-JSON integer —
  `canonicalize` (JCS) would otherwise silently serialize a fractional number into sealed bytes.
  Fractional quantities are carried as **string decimals** in the zod schemas, notably the
  composite-grader `weight` field (§7.2, Task 6) and any fractional model-graded parameter (Task 6).
- **Package mechanics (coordinator brief):** standalone yarn project; in-tree deps declared as
  normal semver `dependencies` + `resolutions: { "<name>": "portal:../<sibling>" }`; version
  `0.1.0`; American English (CLAUDE.md Rule 5).
- **Surgical (CLAUDE.md Rule 3 / brief mandate 8):** implement only this package + the guard
  *registration* edits this plan describes. Do not touch other packages or re-plan the TEP
  amendments.

---

## Preflight

Run once before Task 1. Do not proceed if any assertion fails.

- [ ] **P1: base ancestor.** `git merge-base --is-ancestor 3650ac65e HEAD` → exit 0. (The base
  contains the evidence substrate, the UTF-16 code-unit ordering fix, and the guard precedent.)
- [ ] **P2: TEP protocol package present** (hard dependency).
  `test -d packages/task-execution/protocol && node -e "process.exit(require('./packages/task-execution/protocol/package.json').name==='@jinn-network/task-execution-protocol'?0:1)"`
  → exit 0. If absent, the TEP protocol plan has not landed; stop and escalate.
- [ ] **P3: task-execution guards present** (created by the TEP protocol plan).
  `ls .github/scripts/task-execution-package-inventory.test.mjs .github/scripts/task-execution-source-boundaries.test.mjs .github/scripts/task-execution-packed-types.test.mjs .github/workflows/task-execution-ci.yml`
  → all exist. If absent, stop and escalate (this plan registers into them; it does not clone them).
- [ ] **P4: carried amendments present in committed TEP v1.** Confirm `Task.profile` is a
  ResourceDescriptor and the Submission requirements map / `runPinning` capability block exist in
  `@jinn-network/task-execution-protocol` (design §5/§6.2/§13). `grep -rn "runPinning\|profile.*ResourceDescriptor\|ResourceDescriptor.*profile" packages/task-execution/protocol/src | head`.
  If missing, this lane cannot be built as designed — escalate (Phase 0 blocking open-question 1).
- [ ] **P5: error-category enum exported by protocol** (program §7.3 — profiles imports the
  taxonomy, never redeclares it). Confirm `@jinn-network/task-execution-protocol` exports the
  error-category type/vocabulary (`TaskExecutionErrorCategory` + `TASK_EXECUTION_ERROR_CATEGORIES`).
  `grep -rn "TaskExecutionErrorCategory\|TASK_EXECUTION_ERROR_CATEGORIES" packages/task-execution/protocol/src | head`.
  If absent, `errors.ts` cannot bind to the shared enum — stop and escalate (do NOT mint a parallel
  taxonomy; TEP §13).
- [ ] **P6: pure `mergeRequirements` exported by protocol** (program §7.3 — the comparison-class
  merge is a pure protocol export the profiles kit executes, not a re-implemented or fixtures-only
  path). Confirm `@jinn-network/task-execution-protocol` exports `mergeRequirements` returning
  `{ ok: true, effective } | { ok: false, category: 'invalid-document', key }`.
  `grep -rn "mergeRequirements" packages/task-execution/protocol/src | head`. If absent, stop and
  escalate — Task 11 has **no** degraded fallback (its absence is escalate-and-stop, not a planned
  weaker path).

---

## File structure

New package `packages/task-execution/profiles/`:

```text
packages/task-execution/profiles/
  package.json                       standalone; deps: task-execution-protocol (portal), @noble/hashes,
                                     canonicalize, zod, ajv, safe-regex
  .yarnrc.yml                        nodeLinker: node-modules
  tsconfig.json, tsconfig.build.json, vitest.config.ts, yarn.lock, README.md
  scripts/
    build.mjs                        tsc -p tsconfig.build.json into dist/
    pack-smoke.mjs                   npm pack → install → import smoke incl. sealed-doc + /testing
    seal-documents.mjs               regenerates the two sealed profile docs + pinned digests (--write/--check)
  src/
    order.ts                         compareCodeUnitStrings (copied, code-unit)
    bytes.ts                         canonicalJsonBytes (canonicalize), decodeUtf8, sha256Hex,
                                     recordDigest, sealDocument, bytesEqual
    identifiers.ts                   media types, format URIs, instance URIs, predicate/statement types,
                                     scheme IRIs (unregistered), EVAL_SEMANTICS_VERSION
    errors.ts                        ProfilesError; code = subset of TEP's TaskExecutionErrorCategory
                                     (invalid-document, unsupported-profile, unsupported-requirement),
                                     imported from protocol — never redeclared (§7.3)
    evaluation-spec/
      schema.ts, seal.ts, family-blocks.ts, parser-registry.ts, composite.ts,
      verdict-rule.ts, verdict-consistency.ts, unscorable.ts, measurements.ts
    task-profile/
      schema.ts, seal.ts, payload-schema.ts (hardening), compiled-cache.ts, resolve.ts,
      sub-profile.ts (allOf + family URI)
    admission-receipt.ts
    result-evaluation.ts             structural mirror of the Evidence Result Evaluation Statement
                                     (no evidence import; byte-compat held by fixtures)
    documents/
      repository-work-1.0.ts         builder for the sealed repository-work document
      evaluation-task-1.0.ts         builder + deriveEvaluationTask(T, D)
    testing.ts                       kit: fixture loaders + pure structural runner (the ./testing entry)
    index.ts
    *.test.ts, fixtures.test.ts      per-module tests + pinned-digest & cross-package equivalence checks
  profiles/task-profiles/
    repository-work/1.0/profile.json + profile.sha256
    evaluation-task/1.0/profile.json + profile.sha256
  fixtures/                          §12 golden + adversarial families (see per-task fixtures)
```

Shared-file edits this plan describes (guard *registration*, executed by the implementer — brief
mandate 8 keeps them as implementation-time work IN the plan):
`.github/scripts/task-execution-package-inventory.test.mjs`,
`.github/scripts/task-execution-source-boundaries.test.mjs`,
`.github/scripts/task-execution-packed-types.test.mjs`,
`.github/workflows/task-execution-ci.yml`.

---

## Task 1: Package scaffold, guard registration, sealing primitives, cross-package equivalence

Lands the package into the task-execution tree with all guards green, and proves the local sealer is
byte-compatible with the TEP protocol sealer. Everything downstream builds on these primitives
(design §6 "sealed per TEP §6.1"; coordinator brief sealing precedent). Guard registration lands
**with this first package task**, not after (brief).

**Files:**
- Create: `packages/task-execution/profiles/package.json`, `.yarnrc.yml`, `tsconfig.json`,
  `tsconfig.build.json`, `vitest.config.ts`, `README.md`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`
- Create: `packages/task-execution/profiles/src/order.ts`, `src/bytes.ts`, `src/identifiers.ts`,
  `src/errors.ts`, `src/index.ts`
- Create: `packages/task-execution/profiles/src/bytes.test.ts`,
  `src/fixtures.test.ts` (equivalence leg only, extended in later tasks)
- Create: `packages/task-execution/profiles/fixtures/equivalence/key-order-sensitive.json`,
  `fixtures/equivalence/expected-digests.json`
- Modify (guard registration): `.github/scripts/task-execution-package-inventory.test.mjs`,
  `.github/scripts/task-execution-source-boundaries.test.mjs`,
  `.github/scripts/task-execution-packed-types.test.mjs`,
  `.github/workflows/task-execution-ci.yml`

**Interfaces:**
- Produces: `compareCodeUnitStrings(left: string, right: string): number`;
  `canonicalJsonBytes(value: unknown): Uint8Array`; `sha256Hex(bytes: Uint8Array): string`;
  `recordDigest(bytes: Uint8Array): \`sha256:${string}\``;
  `sealDocument(value: unknown): { bytes: Uint8Array; digest: \`sha256:${string}\` }`;
  `decodeUtf8(bytes: Uint8Array): string`; `bytesEqual(a: Uint8Array, b: Uint8Array): boolean`;
  identifier constants (below); `class ProfilesError extends Error` with
  `code` typed as an `Extract` subset of protocol's `TaskExecutionErrorCategory` — the three category
  strings (`invalid-document` | `unsupported-profile` | `unsupported-requirement`) are imported from
  protocol, never redeclared locally (§7.3).
- Consumes: from `@jinn-network/task-execution-protocol` — `ResourceDescriptor` type,
  `TaskExecutionErrorCategory` type (backing `ProfilesErrorCode`), and, in tests only, its
  canonical-bytes/seal helper if exported (see step 6 / Findings).

- [ ] **Step 1: Scaffold the standalone package.** Copy the evidence precedent verbatim and swap
  constants. `package.json` (mirrors `packages/evidence/derivation/package.json`):

```json
{
  "name": "@jinn-network/task-execution-profiles",
  "version": "0.1.0",
  "description": "Sealed task-profile documents and EvaluationSpec format for the Jinn Task Execution Protocol.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/task-execution/profiles"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./testing": { "import": "./dist/testing.js", "types": "./dist/testing.d.ts" },
    "./profiles/*": "./profiles/*",
    "./fixtures/*": "./fixtures/*"
  },
  "files": ["dist/", "profiles/", "fixtures/", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "check:documents": "yarn build && node scripts/seal-documents.mjs --check",
    "generate:documents": "yarn build && node scripts/seal-documents.mjs --write",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/task-execution-protocol": "0.1.0",
    "@noble/hashes": "2.2.0",
    "ajv": "8.17.1",
    "canonicalize": "3.0.0",
    "safe-regex": "2.1.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/safe-regex": "^1.1.6",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/task-execution-protocol": "portal:../protocol"
  }
}
```

  Copy `.yarnrc.yml` (`nodeLinker: node-modules`), `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `scripts/build.mjs`, `scripts/pack-smoke.mjs` from
  `packages/evidence/protocol/` verbatim, swapping only the temp-dir name in `pack-smoke.mjs`
  (`jinn-evidence-protocol-` → `jinn-task-execution-profiles-`) and the smoke assertions (rewritten
  in Task 15; a minimal root-import smoke is enough now). Declaring `ajv`/`safe-regex` now (before
  Task 9 uses them) keeps the guard's allowed-dependency inventory stable across tasks.

- [ ] **Step 2: Copy sealing primitives.** `src/order.ts` = verbatim copy of
  `packages/evidence/protocol/src/order.ts` (with the SPDX + rationale comment pointing at
  `.github/scripts/task-execution-source-boundaries.test.mjs`). `src/bytes.ts` mirrors
  `packages/evidence/derivation/src/bytes.ts` for `canonicalJsonBytes`, `decodeUtf8`, `bytesEqual`,
  plus `sha256Hex`/`recordDigest` from `packages/evidence/protocol/src/hashing.ts`, and adds:

```ts
import canonicalize from "canonicalize";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ProfilesError } from "./errors.js";

const encoder = new TextEncoder();

// Program §7.14 / TEP §6.1: every sealer REJECTS numbers not exactly representable as I-JSON
// integers. `canonicalize` (JCS) would otherwise happily serialize a fractional number into sealed
// bytes; evidence enforces this at its schema layer, so profiles enforces it here at the seal path.
// Fractional quantities are string decimals in the zod schemas (e.g. composite-grader `weight`).
function assertIJsonNumbers(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ProfilesError(
        "invalid-document",
        `Sealed numbers must be I-JSON integers; got ${value}. Encode fractional values as strings.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertIJsonNumbers(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) assertIJsonNumbers(nested);
  }
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  assertIJsonNumbers(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    throw new ProfilesError("invalid-document", "Value cannot be serialized as canonical JSON.");
  }
  return encoder.encode(encoded);
}

export function sha256Hex(bytes: Uint8Array): string { return bytesToHex(sha256(bytes)); }
export function recordDigest(bytes: Uint8Array): `sha256:${string}` { return `sha256:${sha256Hex(bytes)}`; }

export function sealDocument(value: unknown): { bytes: Uint8Array; digest: `sha256:${string}` } {
  const bytes = canonicalJsonBytes(value);
  return { bytes, digest: recordDigest(bytes) };
}
```

  `src/errors.ts` — the category strings are **not** redeclared here; `ProfilesErrorCode` is an
  `Extract` subset of TEP's stable error-category taxonomy imported from the protocol package (TEP
  §13: bindings never invent parallel taxonomies; program §7.3: the error-category enum lives in
  `protocol`, no duplicate enum). `Extract` keeps the binding live — if protocol renames a category
  the subset stops compiling rather than silently drifting. Profiles keeps its own `Error` class: it
  is not the backend, so it must never throw `TaskExecutionError`.

```ts
import type { TaskExecutionErrorCategory } from "@jinn-network/task-execution-protocol";

// The three categories profiles produces, drawn from TEP's vocabulary (never redeclared here).
export type ProfilesErrorCode = Extract<
  TaskExecutionErrorCategory,
  "invalid-document" | "unsupported-profile" | "unsupported-requirement"
>;

export class ProfilesError extends Error {
  constructor(readonly code: ProfilesErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProfilesError";
  }
}
```

  `src/identifiers.ts` (§3/§6/§7/§9.2 + `EVAL_SEMANTICS_VERSION` grounding):

```ts
// Document-format ("protocol") URIs — program-gate confirmations (see plan Findings).
export const TASK_PROFILE_FORMAT_URI = "https://jinn.network/profiles/task-profile/1.0" as const;
export const EVALUATION_SPEC_FORMAT_URI = "https://jinn.network/profiles/evaluation-spec/1.0" as const;
// Media types (frozen).
export const TASK_PROFILE_MEDIA_TYPE = "application/vnd.jinn.task-execution.task-profile.v1+json" as const;
export const EVALUATION_SPEC_MEDIA_TYPE = "application/vnd.jinn.task-execution.evaluation-spec.v1+json" as const;
export const VERDICT_DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
// Reserved profile-instance URIs (§8/§9).
export const REPOSITORY_WORK_PROFILE_URI = "https://jinn.network/task-profiles/repository-work/1.0" as const;
export const EVALUATION_TASK_PROFILE_URI = "https://jinn.network/task-profiles/evaluation-task/1.0" as const;
// Evidence contract types the verdict output mirrors structurally (byte-compat via fixtures).
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const RESULT_EVALUATION_PREDICATE_TYPE = "https://jinn.network/attestations/result-evaluation/v1" as const;
// semanticsVersion seed — promoted from EVAL_SEMANTICS_VERSION (§7.1).
export const EVAL_SEMANTICS_VERSION = "4" as const;
// Scheme IRIs for identifier propertyID values — UNREGISTERED; shared follow-up with TEP §28 (§17).
export const PROFILE_URI_SCHEME_IRI = "https://jinn.network/schemes/task-profile-uri" as const;
export const TASK_DIGEST_SCHEME_IRI = "https://jinn.network/schemes/task-digest" as const;
```

  `src/index.ts` re-exports `./order.js`, `./bytes.js`, `./errors.js`, `./identifiers.js`.

- [ ] **Step 3: Register the profiles package in the task-execution guards (edits).** Read each live
  guard file first and swap/append constants; **compute counts against the live file — never
  hardcode a guessed total** (brief; evidence-applications precedent).
  - `task-execution-package-inventory.test.mjs`: append
    `['profiles', '@jinn-network/task-execution-profiles']` to the tree's package array; add the
    dependency-graph entry
    `['profiles', { dependencies: ['@jinn-network/task-execution-protocol'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }]`;
    change the count assertion to `<live count> + 1`.
  - `task-execution-source-boundaries.test.mjs`: append `'profiles'` to the tree directories array
    (this alone brings profiles under the blanket locale-ban and no-cross-tree checks); add a
    profiles boundary block — allowed Jinn dependency: `@jinn-network/task-execution-protocol` only;
    forbidden roots: every sibling task-execution package except `protocol`, plus
    `packages/evidence/*`, `packages/discovery/*`, `packages/trust/*`, and any marketplace root;
    allowed-dependency inventory =
    `['@jinn-network/task-execution-protocol', '@noble/hashes', 'ajv', 'canonicalize', 'safe-regex', 'zod']`
    (sorted, code-unit); allowed-dev inventory = `['@types/node', '@types/safe-regex', 'typescript', 'vitest']`.
  - `task-execution-packed-types.test.mjs`: append
    `['profiles', '@jinn-network/task-execution-profiles']` to `packages`; append two code
    entrypoints `@jinn-network/task-execution-profiles` and
    `@jinn-network/task-execution-profiles/testing`.
  - `task-execution-ci.yml`: add a `profiles` job (`needs:` the TEP protocol dist job) that restores
    the protocol dist, `yarn install --immutable`, `yarn typecheck`, `yarn test`, `yarn build`,
    `yarn check:documents`, `yarn pack:smoke`, and uploads the profiles dist; add `profiles` to the
    final `verify` job's gate list + dist placement so `task-execution-packed-types.test.mjs` runs
    with profiles present.

- [ ] **Step 4: Write the failing equivalence + primitive tests.**
  `fixtures/equivalence/key-order-sensitive.json` = an object whose keys are authored **out of
  sorted order** and include nested objects + a string array, e.g.
  `{ "zeta": 1, "alpha": { "y": true, "x": [ "b", "a" ] }, "mu": "µ" }`.
  `fixtures/equivalence/expected-digests.json` = `{ "key-order-sensitive.json": "sha256:<PINNED>" }`
  (fill the pinned value in step 5 after first green run). `src/bytes.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, sealDocument, compareCodeUnitStrings } from "./index.js";

it("orders by UTF-16 code unit, not locale", () => {
  expect(compareCodeUnitStrings("Z", "a")).toBe(-1); // 'Z'(0x5A) < 'a'(0x61)
});

describe("cross-package sealing equivalence", () => {
  it("reproduces the pinned digest for the key-order-sensitive record", async () => {
    const value = JSON.parse(
      await readFile(new URL("../fixtures/equivalence/key-order-sensitive.json", import.meta.url), "utf8"));
    const expected = JSON.parse(
      await readFile(new URL("../fixtures/equivalence/expected-digests.json", import.meta.url), "utf8"));
    expect(sealDocument(value).digest).toBe(expected["key-order-sensitive.json"]);
    // canonical bytes must be independent of authored key order.
    const shuffled = { alpha: value.alpha, mu: value.mu, zeta: value.zeta };
    expect(canonicalJsonBytes(shuffled)).toEqual(canonicalJsonBytes(value));
  });
});
```

- [ ] **Step 5: Install, implement, pin the digest.**
  `cd packages/task-execution/profiles && yarn install`. Run
  `yarn vitest run src/bytes.test.ts` — the equivalence test fails on the placeholder digest. Print
  the real digest (`node -e "…sealDocument(record).digest"`), write it into
  `expected-digests.json`, re-run → PASS.

- [ ] **Step 6: Confirm TEP-sealer byte-compatibility.** Extend `src/fixtures.test.ts` with a leg
  that asserts equivalence with the TEP protocol sealer. If
  `@jinn-network/task-execution-protocol` exports a canonical-bytes/seal helper, import it (test-only
  — protocol is an allowed dependency) and assert
  `protocolCanonicalBytes(value) === canonicalJsonBytes(value)` for the key-order-sensitive record.
  If it does not export one, keep the pinned-digest fixture as the equivalence carrier and add a
  code comment: `// Cross-tree parity: this digest MUST equal the identically-named fixture in`
  `// 2026-07-28-task-execution-protocol's sealing goldens; reconciled at the program gate.`
  (See Findings — this is a flagged cross-lane coordination point.)

- [ ] **Step 7: Verification gate.**
  ```bash
  cd packages/task-execution/profiles && yarn typecheck && yarn test && yarn build && yarn pack:smoke
  cd - && node --test .github/scripts/task-execution-package-inventory.test.mjs \
    && node --test .github/scripts/task-execution-source-boundaries.test.mjs
  ```
  Expected: all pass; the inventory guard reports the incremented package count including `profiles`.

- [ ] **Step 8: Commit.**
  `git add packages/task-execution/profiles .github/scripts/task-execution-*.test.mjs .github/workflows/task-execution-ci.yml`
  `git commit -m "feat(task-execution-profiles): scaffold package, register guards, seal primitives"`

---

## Task 2: Conformance-kit backbone (`src/testing.ts`)

The kit must precede the implementations it tests (brief mandate 1; design §12). This task ships the
pure structural runner + fixture loader that every later task registers checks and fixtures against.
It imports only Node builtins + this package's own modules + `task-execution-protocol` — never the
TEP testing kit (`profiles` never depends on `testing`; design §12/§14).

**Files:**
- Create: `packages/task-execution/profiles/src/testing.ts`, `src/testing.test.ts`
- Create: `packages/task-execution/profiles/fixtures/README.md` (the golden/adversarial split
  convention, mirroring the TEP kit's split)
- Modify: `packages/task-execution/profiles/src/index.ts` is unchanged; `testing.ts` is a separate
  subpath entry (already declared in `exports`).

**Interfaces:**
- Produces:
  `type FixtureCase = { name: string; kind: "golden" | "adversarial"; input: unknown; expect: unknown }`;
  `loadFixtureFamily(familyDir: string): Promise<FixtureCase[]>` (reads
  `fixtures/<family>/{golden,adversarial}/*.json`, each `{ input, expect }`);
  `runStructuralCheck<T>(cases: FixtureCase[], check: (input: unknown) => T): { case: string; kind: string; ok: boolean; detail?: string }[]`
  — a golden case passes when `check` deep-equals `expect`; an adversarial case passes when
  `check`'s outcome deep-equals `expect` (typically `{ ok: false, code: "invalid-document" }`). No
  vitest import — pure functions consumers call from any framework.
- Consumes: `sealDocument`, `canonicalJsonBytes` from `./bytes.js`.

- [ ] **Step 1: Write the failing test.** `src/testing.test.ts` writes two tiny inline fixtures
  (one golden, one adversarial) to a temp dir, then asserts `loadFixtureFamily` returns both tagged
  correctly and `runStructuralCheck` reports the golden pass + adversarial pass for an identity
  check whose adversarial `expect` is a thrown-error projection.
- [ ] **Step 2: Run → FAIL** (`loadFixtureFamily` not defined).
  `yarn vitest run src/testing.test.ts`.
- [ ] **Step 3: Implement** `src/testing.ts` per the Interfaces block. `runStructuralCheck` wraps
  `check` in try/catch and, on `ProfilesError`, projects `{ ok: false, code: err.code }` so
  adversarial `expect` can assert the rejection code without leaking messages.
- [ ] **Step 4: Run → PASS.** `yarn vitest run src/testing.test.ts`.
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): conformance-kit backbone + fixture-family loader"`

---

## Task 3: EvaluationSpec schema, sealing, pinned-digest golden

Sealed I-JSON, sha256, `application/vnd.jinn.task-execution.evaluation-spec.v1+json`; the Task's
sealed `evaluation` descriptor points at it by digest; sealed BEFORE the referencing Task (§7). This
is §15 step 1 (the EvaluationSpec cluster) and the shared foundation the profile documents build on.

**Files:**
- Create: `src/evaluation-spec/schema.ts`, `src/evaluation-spec/seal.ts`,
  `src/evaluation-spec/schema.test.ts`
- Create: `fixtures/evaluation-spec/golden/*.json`, `fixtures/evaluation-spec/adversarial/*.json`
- Modify: `src/index.ts` (export `./evaluation-spec/schema.js`, `./evaluation-spec/seal.js`)

**Interfaces:**
- Produces: `EvaluationSpecSchema` (zod `looseObject` — namespaced extensions allowed per TEP
  §21.3); `type EvaluationSpec`; `parseEvaluationSpec(bytes: Uint8Array): EvaluationSpec` (throws
  `ProfilesError('invalid-document')`); `sealEvaluationSpec(spec: EvaluationSpec): { bytes; digest }`.
  Top-level shape (§7.1): `protocol` (`EVALUATION_SPEC_FORMAT_URI`), `semanticsVersion`, `family`
  (grader-family enum), `grader` (ResourceDescriptor or array; MAY be private via
  `accessClass: "public" | "private"`), family-block (`family` discriminant → typed params, filled
  in Task 6), `measurements[]` (`{ name; type: "number"|"boolean"|"string"; unit?; direction?:
  "higher-better"|"lower-better"|"none"; required: boolean }`), `verdictRule` (Task 4 type),
  `unscorable` (Task 5 type), `evidenceConventions` (`{ requiredRefs: string[] }`), namespaced
  extensions.
- Consumes: `sealDocument`, `decodeUtf8`, `ProfilesError`, `EVALUATION_SPEC_FORMAT_URI`,
  `EVAL_SEMANTICS_VERSION`; `ResourceDescriptor` (type) from `task-execution-protocol`.

- [ ] **Step 1: Write the failing test.** `src/evaluation-spec/schema.test.ts` loads
  `fixtures/evaluation-spec/golden/deterministic-minimal.json` (a valid spec: `family:
  "deterministic-process"`, one required measurement `passed:boolean`, a trivial verdictRule
  placeholder, `unscorable: []`), asserts `parseEvaluationSpec(sealEvaluationSpec(golden).bytes)`
  round-trips deep-equal, and asserts `sealEvaluationSpec(golden).digest` equals the pinned digest in
  the fixture's sibling `deterministic-minimal.sha256`. Add an adversarial fixture
  `wrong-protocol.json` (bad `protocol` URI) expecting `{ ok: false, code: "invalid-document" }`.
- [ ] **Step 2: Run → FAIL** (`EvaluationSpecSchema` not defined). `yarn vitest run src/evaluation-spec/schema.test.ts`.
- [ ] **Step 3: Implement** `schema.ts` (zod `looseObject`; `protocol` a `z.literal(EVALUATION_SPEC_FORMAT_URI)`;
  `family` `z.enum(["deterministic-process","model-graded","human-review","composite"])`;
  measurements/grader/evidenceConventions as above; `verdictRule`/`unscorable`/family-block typed as
  `z.unknown()` placeholders refined in Tasks 4–6) and `seal.ts` (`parseEvaluationSpec`,
  `sealEvaluationSpec`). Pin the digest into `deterministic-minimal.sha256` after the first run.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): EvaluationSpec schema + sealing + golden digest"`

---

## Task 4: Verdict-rule closed vocabulary + evaluator

`verdictRule` is a declarative structure in a closed vocabulary over declared measurement names —
threshold comparisons, boolean combinators, explicit inconclusive-predicates. No executable code, no
external refs, reads nothing outside delivered measurements (§7.3).

**Files:**
- Create: `src/evaluation-spec/verdict-rule.ts`, `src/evaluation-spec/verdict-rule.test.ts`
- Create: `fixtures/verdict-rule/golden/*.json`, `fixtures/verdict-rule/adversarial/*.json`
- Modify: `src/evaluation-spec/schema.ts` (replace the `verdictRule` placeholder with
  `VerdictRuleSchema`), `src/index.ts`

**Interfaces:**
- Produces: `VerdictRuleSchema` + `type VerdictRule` (recursive closed vocabulary:
  `{ threshold: { measurement: string; op: "eq"|"ne"|"lt"|"lte"|"gt"|"gte"; value: JsonScalar } }`
  | `{ all: VerdictRule[] }` | `{ any: VerdictRule[] }` | `{ not: VerdictRule }` |
  `{ inconclusiveWhen: VerdictRule; class: string }` | `{ pass: true }` | `{ fail: true }`);
  `type MeasurementMap = Record<string, string | number | boolean>`;
  `type VerdictOutcome = { verdict: "pass" | "fail" | "inconclusive"; inconclusiveClass?: string }`;
  `evaluateVerdictRule(rule: VerdictRule, measurements: MeasurementMap): VerdictOutcome`
  (references to measurements absent from the map → `ProfilesError('invalid-document')`; the rule may
  reference only declared measurement names — cross-checked against the spec in Task 5's coverage
  check).
- Consumes: `ProfilesError`.

- [ ] **Step 1: Write the failing test.** Goldens: `threshold-pass.json` (rule
  `{threshold:{measurement:"passed",op:"eq",value:true}}` + measurements `{passed:true}` → expect
  `{verdict:"pass"}`); `all-combinator.json`; `inconclusive-predicate.json` (rule
  `{inconclusiveWhen:{threshold:{measurement:"coverage",op:"lt",value:0}},class:"window-open"}` →
  `{verdict:"inconclusive",inconclusiveClass:"window-open"}`). Adversarial: `missing-measurement.json`
  (rule references an undelivered measurement → `{ok:false,code:"invalid-document"}`);
  `unknown-op.json` (schema rejects). Assert via `runStructuralCheck`.
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/evaluation-spec/verdict-rule.test.ts`.
- [ ] **Step 3: Implement** `verdict-rule.ts` (recursive zod union; pure evaluator with `not` /
  `all` / `any` / `threshold` / `inconclusiveWhen` semantics; `inconclusiveWhen` precedence:
  evaluate the predicate first, if true return inconclusive with its `class`, else fall through to
  the enclosing pass/fail resolution). Wire `VerdictRuleSchema` into `EvaluationSpecSchema`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): closed-vocabulary verdict rule + evaluator"`

---

## Task 5: Unscorable taxonomy, verdict-consistency, measurements coverage

The named verdict-consistency check (required by the marketplace deployment profile before verdict
settlement): delivered verdict MUST equal `verdictRule(measurements)`; `inconclusive` legal only
under a declared inconclusive-predicate or a declared `recorded-inconclusive` class (§7.3/§7.4). The
unscorable taxonomy has exactly two dispositions (§7.4).

**Files:**
- Create: `src/evaluation-spec/unscorable.ts`, `src/evaluation-spec/verdict-consistency.ts`,
  `src/evaluation-spec/measurements.ts`, and their `.test.ts`
- Create: `fixtures/unscorable/{golden,adversarial}/*.json`,
  `fixtures/verdict-consistency/{golden,adversarial}/*.json`,
  `fixtures/measurements-coverage/{golden,adversarial}/*.json`
- Modify: `src/evaluation-spec/schema.ts` (replace `unscorable` placeholder with `UnscorableSchema`),
  `src/index.ts`

**Interfaces:**
- Produces:
  `UnscorableSchema` + `type UnscorableClass = { name: string; disposition: "retryable-infrastructure" | "recorded-inconclusive" }`
  (an EvaluationSpec's `unscorable` is `UnscorableClass[]`; the declared list bounds the
  `recorded-inconclusive` vocabulary, §7.4);
  `requiredMeasurementNames(spec: EvaluationSpec): string[]`;
  `checkMeasurementCoverage(spec: EvaluationSpec, delivered: MeasurementMap): { ok: true } | { ok: false; missing: string[] }`;
  `checkVerdictConsistency(input: { spec: EvaluationSpec; delivered: VerdictOutcome; measurements: MeasurementMap; declaredUnscorableClass?: string }): { ok: true } | { ok: false; code: "invalid-document"; reason: string }`
  — recomputes `evaluateVerdictRule`, compares to the delivered verdict; an `inconclusive` delivery
  is legal only when the recomputed outcome is `inconclusive` OR `declaredUnscorableClass` names a
  `recorded-inconclusive` class in `spec.unscorable`; a delivery that laundered `fail` into
  `inconclusive` fails.
- Consumes: `evaluateVerdictRule`, `EvaluationSpec`, `ProfilesError`.

- [ ] **Step 1: Write the failing test.** verdict-consistency goldens: `consistent-pass.json`
  (delivered pass, rule says pass → ok). Adversarials: `laundered-inconclusive.json` (rule says
  fail, delivered inconclusive, no declared class → `{ok:false,code:"invalid-document"}`);
  `undeclared-limitation.json` (delivered inconclusive with a class not in `spec.unscorable` → fail).
  unscorable goldens: `retryable-infra.json` asserts disposition classification (never FAIL/never
  inconclusive) and `recorded-inconclusive.json` (verdict IS inconclusive). measurements-coverage
  adversarial: `missing-required.json` → `{ok:false, missing:["passed"]}`.
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/evaluation-spec/verdict-consistency.test.ts src/evaluation-spec/unscorable.test.ts src/evaluation-spec/measurements.test.ts`.
- [ ] **Step 3: Implement** the three modules; wire `UnscorableSchema` into `EvaluationSpecSchema`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): unscorable taxonomy + verdict-consistency + coverage"`

---

## Task 6: Grader family blocks + parser-registry convention + composite bounds

Typed per-family parameters (§7.2): `deterministic-process` (the sealed `TaskEnvironmentSpec.v1`
content incl. parser `{id, version, digest}`), `model-graded`, `human-review`, and `composite`
(bounds depth ≤ 2, fan-out ≤ 32, propagation §7.1). The parser digest is the semantic commitment;
the trusted parser registry is a deployment-side execution allowlist, never a document-validity
condition, and task/spec-supplied parser code is never executed (§7.2/§11).

**Files:**
- Create: `src/evaluation-spec/family-blocks.ts`, `src/evaluation-spec/parser-registry.ts`,
  `src/evaluation-spec/composite.ts`, and their `.test.ts`
- Create: `fixtures/family-blocks/{golden,adversarial}/*.json`,
  `fixtures/composite/{golden,adversarial}/*.json`
- Modify: `src/evaluation-spec/schema.ts` (discriminate the family block on `family`), `src/index.ts`

**Interfaces:**
- Produces: `DeterministicProcessBlockSchema` (`{ image: ResourceDescriptor; platform: string;
  workspace: {...}; testMaterial: ResourceDescriptor[] (access-classified); parser: { id: string;
  version: string; digest: \`sha256:${string}\` }; transitions: { failToPass: string[]; passToPass:
  string[] }; timeout: number; setupPolicy?: {...} }` — `timeout` is an I-JSON integer, e.g. seconds);
  `ModelGradedBlockSchema` (`{ rubric: ResourceDescriptor; judgeModel: { provider: string;
  modelId: string; advertisedVersion?: string; parameters?: Record<string, JsonScalar> }`;
  judgeOutputSchema: ResourceDescriptor; structuralGates: {...} }` — no invented digests; Evidence
  opaque-component rules; **fractional** judge parameters, e.g. `temperature`, are string decimals,
  never JSON numbers, per the I-JSON seal rule — Global Constraints / §7.14);
  `HumanReviewBlockSchema` (`{ reviewForm: ResourceDescriptor; reviewerQualifications: {...}
  (instrument declaration, not selection); attestationShape: {...} }`); `CompositeBlockSchema`
  (`{ subSpecs: { spec: ResourceDescriptor; weight: string }[] }` — `weight` is a **string decimal**,
  NOT a JSON number: sealed bytes admit only I-JSON integers, so fractional weights are string-encoded
  (program §7.14 / TEP §6.1); comparisons/normalization parse the decimal, never the wire type);
  `type ParserIdentity = { id: string; version: string; digest: \`sha256:${string}\` }`;
  `parserAllowlistKey(p: ParserIdentity): string` (deployment allowlist lookup key — the registry is
  advisory, never a document-validity gate);
  `checkCompositeBounds(block: CompositeBlock, resolveDepth: (ref) => number): { ok: true } | { ok: false; code: "invalid-document"; reason: string }`
  (depth ≤ 2, fan-out ≤ 32; digest references preclude cycles).
- Consumes: `ResourceDescriptor` (type), `ProfilesError`.

- [ ] **Step 1: Write the failing test.** Goldens per family (a valid deterministic block with a
  parser identity; a model-graded block; a human-review block; a composite with two weighted
  sub-specs). Adversarials: `parser-with-code.json` (a block that tries to inline parser source →
  rejected: only `{id,version,digest}` is representable); `composite-depth-3.json` (→
  `{ok:false,code:"invalid-document"}`); `composite-fanout-33.json` (→ reject);
  `judge-invented-digest.json` (model-graded with a fabricated model digest → reject);
  `composite-numeric-weight.json` (a `subSpecs[].weight` authored as a JSON number → schema rejects,
  `{ok:false,code:"invalid-document"}` — weight is a string decimal, §7.14). Assert the registry is
  advisory: `parserAllowlistKey` is a pure function that never executes anything.
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/evaluation-spec/family-blocks.test.ts src/evaluation-spec/parser-registry.test.ts src/evaluation-spec/composite.test.ts`.
- [ ] **Step 3: Implement** the three modules; make `EvaluationSpecSchema` discriminate the family
  block on `family` and require the matching block. Composite propagation: expose
  `compositePropagation(subOutcomes)` implementing "any sub-spec `retryable-infrastructure` → whole
  is infrastructure; inconclusive handled by the composite's own verdictRule".
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): grader family blocks + parser registry + composite bounds"`

---

## Task 7: Admission-receipt shape (signed Statement)

An admission receipt is a DSSE-signed in-toto Statement (§7.6): subjects = the sealed Task digest and
the EvaluationSpec digest; issuer = the admission agent IRI; predicate = admission evidence. The
signed shape is a v1 requirement (replaces the deferred "Admission receipt schema v2"; only predicate
details unify later). Signature *validity* is a structural precondition here; cryptographic
verification is the consuming binding's job (out of lane) — this package supplies the shape + the
structural subject/issuer checks.

**Files:**
- Create: `src/admission-receipt.ts`, `src/admission-receipt.test.ts`
- Create: `fixtures/admission-receipt/{golden,adversarial}/*.json`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `AdmissionReceiptStatementSchema` (in-toto Statement: `_type`, `subject`
  (ResourceDescriptor[] with the two named+digested subjects), `predicateType`, `predicate`);
  `DsseEnvelopeSchema` mirror (`{ payloadType; payload; signatures: {keyid?; sig}[] (≥1) }`);
  `checkAdmissionReceipt(input: { envelope: unknown; expectedTaskDigest: string; expectedEvaluationSpecDigest: string }): { ok: true; issuer: string } | { ok: false; code: "invalid-document"; reason: string }`
  — structural checks: envelope has ≥1 signature (unsigned → fail), the decoded Statement's subject
  digests equal the two expected digests (subject-mismatch → fail), issuer IRI present. Reused/forged
  detection at the fixture level is subject-mismatch/absent-signature.
- Consumes: `sha256`/`recordDigest`, `ProfilesError`, `IN_TOTO_STATEMENT_TYPE`.

- [ ] **Step 1: Write the failing test.** Golden `valid-signed.json` (envelope with one signature,
  subjects = task+spec digests) → `{ok:true, issuer:"…"}`. Adversarials: `unsigned.json` (no
  signatures → fail), `wrong-subject.json` (spec digest mismatch → fail), `reused.json` (subjects for
  a different task pair → subject-mismatch fail).
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/admission-receipt.test.ts`.
- [ ] **Step 3: Implement** `admission-receipt.ts`. Decode `payload` (base64 → JSON) inside a
  try/catch that projects `ProfilesError('invalid-document')`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): DSSE admission-receipt shape + structural checks"`

---

## Task 8: Task-profile document schema, sealing, pinned-digest golden

A task profile is a sealed I-JSON document, `application/vnd.jinn.task-execution.task-profile.v1+json`
(§6). This is §15 step 2 (profile mechanism), base schema only; hardening (Task 9) and sub-profiles
(Task 10) refine it.

**Files:**
- Create: `src/task-profile/schema.ts`, `src/task-profile/seal.ts`, `src/task-profile/schema.test.ts`
- Create: `fixtures/task-profile/{golden,adversarial}/*.json`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `TaskProfileDocumentSchema` (zod `looseObject`, §6.1 fields): `protocol`
  (`z.literal(TASK_PROFILE_FORMAT_URI)`), `profile` (versioned instance URI string), `description`,
  `payloadSchema` (`z.record(z.string(), z.unknown())` — a JSON Schema 2020-12 object, validated as a
  schema in Task 9), `inputConventions` (`{ slots: { name; required; descriptorMustCarry: string[] }[] }`),
  `outputConventions` (`{ slots: { name; required; mediaType?; schema?: ResourceDescriptor }[] }`),
  `evaluationFamilies` (`string[]` — WHITELIST only, §6.1; the evaluation-task derivation is fixed by
  `evaluation-task/1.0`, never profile-overridable), `requirementKeys`
  (`{ key: string; comparisonClass: "exact"|"ceiling"|"floor"|"constraint"|"addable" }[]` — each
  MUST declare a class, §5.1), `extends?` (`{ uri: string; digest: \`sha256:${string}\` }`),
  namespaced extensions; `type TaskProfileDocument`;
  `parseTaskProfile(bytes): TaskProfileDocument`; `sealTaskProfile(doc): { bytes; digest }`.
- Consumes: `sealDocument`, `decodeUtf8`, `ProfilesError`, `TASK_PROFILE_FORMAT_URI`,
  `ResourceDescriptor` (type).

- [ ] **Step 1: Write the failing test.** Golden `minimal-profile.json` (one payload key, one input
  slot, one output slot, `evaluationFamilies: ["deterministic-process"]`, one `requirementKey` with a
  declared class) → round-trips + matches a pinned `minimal-profile.sha256`. Adversarials:
  `requirement-key-no-class.json` (a `requirementKeys[]` entry missing `comparisonClass` →
  `{ok:false,code:"invalid-document"}`), `wrong-format-uri.json`.
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/task-profile/schema.test.ts`.
- [ ] **Step 3: Implement** `schema.ts` + `seal.ts`; pin the golden digest.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): task-profile document schema + sealing + golden"`

---

## Task 9: Schema hardening, digest-keyed validator cache, resolution rule

The profile document is the runtime validation authority; compiled SDK validators are digest-keyed
caches with a per-digest drift check (§6.4). Because anyone may publish a profile, `payloadSchema` is
untrusted validator input: no external `$ref`, no network retrieval, bounded size + nesting depth,
and a two-part regex posture (§6.4, program §7.17): an **admission-time** static pre-filter
(`safe-regex` + a pattern-length bound) plus an **injectable regExp engine** at compile time. The
default engine is native `RegExp`; the residual — a pattern that passes the static pre-filter can
still backtrack against a crafted payload at validation time — is documented, not eliminated, because
`safe-regex` is a static star-height check, not a runtime bound. The marketplace deployment profile
mandates injecting a linear-time engine (RE2), which closes the residual while keeping the reference
package pure-JS and portable. Resolution: backend support = (URI, resolvable digest); a backend
holding a different digest for the same URI MUST NOT validate against its cache — resolve the pinned
digest or reject `unsupported-profile`, naming the unresolvable digest (§6.2).

**Files:**
- Create: `src/task-profile/payload-schema.ts`, `src/task-profile/compiled-cache.ts`,
  `src/task-profile/resolve.ts`, and their `.test.ts`
- Create: `fixtures/schema-hardening/adversarial/*.json` (remote-`$ref`, ReDoS pattern, depth bomb,
  oversized), `fixtures/schema-hardening/golden/*.json`, `fixtures/resolution/{golden,adversarial}/*.json`
- Modify: `src/index.ts`

**Interfaces:**
- Produces:
  `PROFILE_SCHEMA_MAX_BYTES = 262144`, `PROFILE_SCHEMA_MAX_DEPTH = 32`,
  `PROFILE_SCHEMA_MAX_PATTERN_LENGTH = 1024` (profile-format constants — program-gate confirmable);
  `type RegExpEngine = { new (pattern: string, flags?: string): { test(s: string): boolean } }` — an
  ajv-compatible `RegExp`-shaped constructor; the default is the native `RegExp`, RE2 is the
  linear-time drop-in the marketplace profile injects (program §7.17);
  `assertSafeSchema(schema: unknown, bytes: Uint8Array): void` (admission-time static pre-filter;
  throws `ProfilesError('invalid-document')` on: any `$ref` not a local `#…` fragment;
  `bytes.byteLength > PROFILE_SCHEMA_MAX_BYTES`; nesting depth `> PROFILE_SCHEMA_MAX_DEPTH`; any
  `pattern`/`patternProperties`/`propertyNames.pattern` string longer than
  `PROFILE_SCHEMA_MAX_PATTERN_LENGTH` **or** that `safe-regex` rejects — a static star-height check,
  NOT a runtime bound: a passing pattern can still backtrack at payload-validation time, hence the
  injectable engine below);
  `compilePayloadValidator(schema: unknown, bytes: Uint8Array, opts?: { regExp?: RegExpEngine }): (payload: unknown) => { ok: boolean; errors?: string[] }`
  (runs `assertSafeSchema` first, then compiles with
  `new Ajv2020({ strict: true, loadSchema: undefined, code: { regExp: opts?.regExp ?? RegExp } })` —
  no `loadSchema` means an unresolved `$ref` throws, guaranteeing no network fetch; `code.regExp` is
  ajv's documented seam for substituting the pattern engine, so injecting RE2 gives linear-time
  payload validation with no other code change; the source-boundaries guard's ambient-network ban is
  the backstop);
  `class PayloadValidatorCache` keyed by profile digest — `get(digest, doc): Validator` compiles once
  per digest; `checkDrift(uri, digest, cachedDoc): void` throws `unsupported-profile` when the cached
  document's digest ≠ the pinned digest for the same URI;
  `resolveProfile(descriptor: ResourceDescriptor, store: { get(digest): TaskProfileDocument | undefined }): TaskProfileDocument`
  (throws `unsupported-profile` naming the unresolvable digest when the store lacks the pinned
  digest — never validates against a differently-digested cache for the same URI).
- Consumes: `Ajv2020` from `ajv/dist/2020.js`, `safeRegex` from `safe-regex`, `TaskProfileDocument`,
  `ProfilesError`, `recordDigest`.

- [ ] **Step 1: Write the failing test.** Hardening adversarials: `remote-ref.json`
  (`{ "$ref": "https://evil/schema" }` → `invalid-document`), `redos-pattern.json`
  (`{ "pattern": "(a+)+$" }` → `invalid-document`), `overlong-pattern.json` (a `pattern` string longer
  than `PROFILE_SCHEMA_MAX_PATTERN_LENGTH` → `invalid-document`), `depth-bomb.json` (nested > 32 →
  `invalid-document`), `oversized.json` (> 262144 bytes → `invalid-document`). Golden: a valid
  self-contained schema compiles and validates a conforming payload; a non-conforming payload returns
  `{ok:false}`; the injectable engine seam is exercised — `compilePayloadValidator(schema, bytes,
  { regExp })` with an instrumented `RegExp`-shaped constructor asserts the injected engine is the one
  ajv uses for `pattern` evaluation (proving RE2 can be dropped in), while the default path uses native
  `RegExp`. Resolution: `unknown-digest.json` — a descriptor whose digest is not in the store →
  `unsupported-profile` naming the digest; drift: a cache holding a different digest for the same URI
  → `unsupported-profile` (never silently validates).
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/task-profile/payload-schema.test.ts src/task-profile/compiled-cache.test.ts src/task-profile/resolve.test.ts`.
- [ ] **Step 3: Implement** the three modules per the Interfaces block.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`, plus a targeted guard run to
  confirm no ambient-network API leaked in:
  `node --test .github/scripts/task-execution-source-boundaries.test.mjs`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): schema hardening + digest-keyed validator cache + resolution"`

---

## Task 10: Sub-profiles — structural `allOf`, family URI, substitutability

A profile may `extends` exactly one parent (chains allowed, digest-pinned, depth ≤ 8). A
sub-profile's `payloadSchema` MUST be `allOf: [<parent payloadSchema, embedded by digest-verified
copy>, <refinement>]`; parents MUST be extension-tolerant; a sub-profile may add obligations and
narrow ranges but never remove a parent obligation. Family URI = unversioned URI of the root ancestor
of the `extends` chain (§6.3). Corpus/pairing/operator filters join on the family URI.

**Files:**
- Create: `src/task-profile/sub-profile.ts`, `src/task-profile/sub-profile.test.ts`
- Create: `fixtures/sub-profile/{golden,adversarial}/*.json` (substitutability pairs + violations +
  family-URI chain-walk cases)
- Modify: `src/task-profile/schema.ts` (validate `extends` shape), `src/index.ts`

**Interfaces:**
- Produces:
  `SUB_PROFILE_MAX_DEPTH = 8`;
  `checkAllOfConstruction(sub: TaskProfileDocument, parentDoc: TaskProfileDocument): { ok: true } | { ok: false; code: "invalid-document"; reason: string }`
  (asserts `sub.payloadSchema.allOf[0]` is a byte-equal, digest-verified copy of `parentDoc.payloadSchema`
  and that `parentDoc.payloadSchema` is extension-tolerant — `additionalProperties` not `false`; a
  "sub-profile" that widens or omits the parent branch fails to be one);
  `resolveFamilyUri(chain: { uri: string; digest: string; extends?: { uri: string; digest: string } }[]): string`
  (walks `extends` to the root, digest-verified, depth-bounded ≤ 8 — over-depth throws
  `invalid-document`; strips the trailing version segment of the root URI);
  `type ExtendsChainStep = { uri: string; digest: \`sha256:${string}\` }`.
- Consumes: `bytesEqual`, `canonicalJsonBytes`, `recordDigest`, `TaskProfileDocument`, `ProfilesError`.

- [ ] **Step 1: Write the failing test.** Goldens: `valid-subprofile.json` +
  `valid-parent.json` (child `payloadSchema` is `allOf:[<parent copy>, <refinement adding a required
  key>]`; `checkAllOfConstruction` → ok; a child-conforming payload also validates against the parent
  by construction). `family-chain.json` (3-deep chain → `resolveFamilyUri` returns the unversioned
  root). Adversarials: `widening-subprofile.json` (`allOf[0]` differs from the parent → reject);
  `closed-parent.json` (parent `additionalProperties:false` → reject: not extension-tolerant);
  `chain-depth-9.json` (→ `invalid-document`).
- [ ] **Step 2: Run → FAIL.** `yarn vitest run src/task-profile/sub-profile.test.ts`.
- [ ] **Step 3: Implement** `sub-profile.ts`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): allOf sub-profiles + family-URI chain walk"`

---

## Task 11: Requirement-merge fixtures per comparison class

The comparison-class merge (§5.1) is carried TEP amendment 1 — implemented in the TEP protocol plan,
not re-planned here. Program §7.3 pins it as a single **pure** protocol export, `mergeRequirements`,
that the profiles kit **executes** (no re-implementation, no fixtures-only fallback). This task ships
the profiles kit's **requirement-merge fixture family** (per class, incl. same-key conflicts; design
§12) and runs it through the exported `mergeRequirements`. Preflight P6 already asserts the export
exists; its absence is **escalate-and-stop**, never a degraded path.

The pinning-key inventory rejection is a **different code path** and is NOT executed here: per §7.3,
`unsupported-requirement` (a pinning key absent from a backend's capability inventory) is produced by
the **backend capability check**, never by the pure `mergeRequirements`. So the pinning-inventory
fixture is shipped as **data for that backend path** (consumed by the TEP backend kit / marketplace
binding, out of lane) — this kit asserts its well-formedness, it does not run a merge that returns
`unsupported-requirement`.

**Files:**
- Create: `src/requirement-merge.test.ts`
- Create: `fixtures/requirement-merge/{golden,adversarial}/*.json` (one golden + one conflict per
  class: `exact`, `ceiling`, `floor`, `constraint`, `addable`; plus `pinning-inventory-reject.json`
  — **labeled backend-capability-path data**: a Submission pinning key the backend inventory does not
  declare → `unsupported-requirement`, produced by the backend capability check, NOT by
  `mergeRequirements`; this kit only checks the fixture is well-formed)
- Modify: `src/testing.ts` (export `loadRequirementMergeFamily` helper if useful), `src/index.ts`
  (no new production module — merge lives in `task-execution-protocol`)

**Interfaces:**
- Consumes: `mergeRequirements(taskRequirements, submissionRequirements, keyClasses): { ok: true; effective } | { ok: false; category: "invalid-document"; key }`
  from `@jinn-network/task-execution-protocol` (program §7.3 — a pure export; `keyClasses` is the
  fixed core-key classes plus the resolved profile's `requirementKeys` classes, assembled by the
  caller). `unsupported-requirement` is **not** in this function's return set — it is a backend
  capability-check outcome.
- Produces: fixture assets under `fixtures/requirement-merge/` (consumed by the TEP backend kit + the
  marketplace binding, both out of lane), including the backend-path pinning-inventory data fixture.

- [ ] **Step 1: Write the failing test.** For each class, a golden pair (task + submission +
  per-key class) → expected `{ok:true, effective}` and a conflict pair → expected
  `{ok:false, category:"invalid-document", key}`, run through the imported `mergeRequirements`.
  Separately, assert `pinning-inventory-reject.json` is well-formed backend-path data (its declared
  key + expected `unsupported-requirement` outcome) **without** feeding it to `mergeRequirements` —
  that outcome belongs to the backend capability check, not this pure merge.
- [ ] **Step 2: Run → FAIL** (`mergeRequirements` import unresolved or fixtures absent). Its absence
  is a Preflight-P6 escalate-and-stop, not a signal to ship a weaker path.
- [ ] **Step 3: Implement** the fixtures; wire the test to the exported `mergeRequirements`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "test(task-execution-profiles): requirement-merge fixtures per comparison class"`

---

## Task 12: `repository-work/1.0` sealed document + jinn-repo migration fixtures

The `jinn-repo.v1` successor (§8), slimmed to what is task-semantic. Sealed asset under
`profiles/task-profiles/repository-work/1.0/`, pinned digest, regenerated by `seal-documents.mjs`.
The old `source` union dissolves into `provenance` + EvaluationSpec choice; the Autopilot session
variant is a deferred stricter sub-profile (OUT of lane).

**Files:**
- Create: `src/documents/repository-work-1.0.ts`, `src/documents/repository-work-1.0.test.ts`
- Create: `scripts/seal-documents.mjs`
- Create: `profiles/task-profiles/repository-work/1.0/profile.json`,
  `profiles/task-profiles/repository-work/1.0/profile.sha256`
- Create: `fixtures/migration/jinn-repo-to-repository-work/{golden}/*.json`
- Modify: `src/index.ts`, `src/fixtures.test.ts` (assert the sealed asset matches the builder output +
  pinned digest)

**Interfaces:**
- Produces: `buildRepositoryWorkProfile(): TaskProfileDocument` — `profile:
  REPOSITORY_WORK_PROFILE_URI`; payload keys `instance_id?`, `language`, `interface?`, `provenance? {
  kind: "mined"|"synthetic"|"live"; sourceCommitment? }` (no test material, no dispatch state, no
  effort); input slot `repository-state` (required: repo URL + 40-hex ref + optional tree digest) +
  optional knowledge-packet inputs; output slots `patch` (required, unified diff, UTF-8,
  profile-bounded size), `summary?` (markdown), `evidence?` (structured); `evaluationFamilies:
  ["deterministic-process", "model-graded"]`; `requirementKeys` include `effort` as a `floor` (§13).
  `migrateJinnRepoTask(legacy): { payload; inputs }` — maps `problem_statement → instructions`,
  `repo`/`base_commit → repository-state`, `source` union → `provenance`, `effort → floor requirement`.
- Consumes: `sealTaskProfile`, identifiers, `TaskProfileDocument`.

- [ ] **Step 1: Write the failing test.** `repository-work-1.0.test.ts`: `buildRepositoryWorkProfile()`
  seals to the pinned digest; `parseTaskProfile` round-trips; the payload/input/output shape matches
  §8. Migration golden: a `merged-pr` legacy jinn-repo task migrates to `provenance: {kind:"mined"}` +
  a `repository-state` input; a `live-issue` legacy task → `provenance:{kind:"live"}` + `effort`
  preserved as a floor requirement.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the builder + `migrateJinnRepoTask` + `scripts/seal-documents.mjs`
  (`--write` seals `buildRepositoryWorkProfile()` to `profile.json` + `profile.sha256`; `--check`
  fails on drift, mirroring evidence's `generate-profile.mjs`). Generate the sealed asset with
  `yarn generate:documents`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test && yarn check:documents`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): repository-work/1.0 sealed document + jinn-repo migration"`

---

## Task 13: `evaluation-task/1.0` sealed document + derivation template + verdict output

The one generic thin profile for evaluation-as-work (§9). It fixes the ENTIRE evaluation Task document
as a deterministic template over `(T, D)` so independent derivers produce identical sealed
bytes/digest, and its delivered `verdict` output **is** the DSSE-signed Result Evaluation Statement —
no separate claim-issuance step (§9.2). The verdict output shape is byte-compatible with the Evidence
Result Evaluation predicate, held by fixtures (no evidence import).

**Files:**
- Create: `src/documents/evaluation-task-1.0.ts`, `src/result-evaluation.ts`, and their `.test.ts`
- Create: `profiles/task-profiles/evaluation-task/1.0/profile.json` + `profile.sha256`
- Create: `fixtures/evaluation-task-derivation/{golden,adversarial}/*.json`
- Create: `fixtures/result-evaluation/golden/evidence-statement.json` — a **byte-copy** of
  `packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/statement.json`
  (with a provenance header naming the source path + the base commit). This is the **byte-pin
  carrier**: it ties `ResultEvaluationStatementShape` to the *real* Evidence predicate bytes rather
  than to the plan's own mirror. (Copying the asset — not the evidence package — keeps the no-evidence-
  import boundary intact; §12/§14.)
- Modify: `scripts/seal-documents.mjs` (seal both documents), `src/index.ts`, `src/fixtures.test.ts`

**Interfaces:**
- Produces: `buildEvaluationTaskProfile(): TaskProfileDocument` (`profile: EVALUATION_TASK_PROFILE_URI`;
  fixed input/output conventions; single required output slot `verdict` with media type
  `VERDICT_DSSE_PAYLOAD_TYPE`);
  `deriveEvaluationTask(input: { subjectTask: { name: string; digest: string }; subjectDelivery: { name: string; digest: string }; subjectResults: { name: string; digest: string }[]; evaluationSpecDigest: string }): { document: unknown; bytes: Uint8Array; digest: \`sha256:${string}\` }`
  — payload `{ subjectTask, subjectDelivery, subjectResults (SORTED BY NAME via
  compareCodeUnitStrings), evaluationSpec: evaluationSpecDigest }`; fixed `instructions` text; digests
  only; schema-fixed field order → identical bytes across derivers.
  `ResultEvaluationStatementShape` — a structural mirror transcribed **field-for-field** from
  `packages/evidence/protocol/src/schemas.ts` (`ResultEvaluationStatementSchema` /
  `EvaluationPredicateSchema` / `ResourceDescriptorSchema` / `Sha256DigestSchema`); no evidence
  import — byte-compat is held by the `evidence-statement.json` byte-pin fixture. Getting any of these
  shapes wrong emits a Statement that is NOT a valid Evidence record, so transcribe them exactly:
  - `_type`: literal `IN_TOTO_STATEMENT_TYPE`;
  - `subject`: `ResourceDescriptor[]` (min 1), each
    `{ name: string; digest: { sha256: <64-lowercase-hex> }; uri?; content?; mediaType?; downloadLocation?; annotations? }`
    — **`digest` is an OBJECT `{ sha256: hex }`, NOT a bare `sha256:…` string** (this is the one place
    the mirror diverges from the plan's `sha256:${string}` digest strings);
  - `predicateType`: literal `RESULT_EVALUATION_PREDICATE_TYPE`;
  - `predicate`: `{ evaluatedAt: <ISO datetime>; evaluator: { id: string }; evaluationMethod?:
    ResourceDescriptor; evaluationSpecification?: ResourceDescriptor; taskSubject: string;
    resultSubjects: string[] (min 1); verdict: "pass"|"fail"|"inconclusive"; measurements?:
    { name: string; value: JsonScalar; unit?: string }[]; evidence?: ResourceDescriptor[];
    explanation?: string; limitations?: string[]; supersedes?: ResourceDescriptor[];
    disputes?: ResourceDescriptor[] }`.
  Shape traps (encode as type-level pins + adversarial fixtures):
  - `evaluationSpecification` and `evaluationMethod` are **ResourceDescriptor OBJECTS**
    (`{ name, digest: { sha256 } }`), NOT bare spec-digest strings — the design §9.2 shorthand
    "= the spec digest" names the referent, not the wire shape;
  - `taskSubject` / `resultSubjects` are subject-**NAME** strings (e.g. `"execution/task/task.md"`),
    NOT digests;
  - the predicate `measurements` carry DELIVERED values `{ name, value, unit? }` — a DIFFERENT shape
    from an EvaluationSpec's DECLARED measurements `{ name, type, unit?, direction, required }`
    (Task 3); the mirror carries the delivered shape.
  Plus `buildVerdictEnvelope(statement, signatures): DsseEnvelope`.
- Consumes: `compareCodeUnitStrings`, `sealDocument`, `canonicalJsonBytes`, `decodeUtf8`,
  `sealTaskProfile`, identifiers, `EvaluationSpec`, `requiredMeasurementNames`.

- [ ] **Step 1: Write the failing test.** Derivation goldens: `derive-TD.json` — a fixed `(T,D)` pair
  → expected full-document bytes + pinned digest; a second deriver with `subjectResults` authored in a
  different order produces the SAME digest (name-sort determinism). Adversarials (§12):
  `superseded-delivery.json` (a superseded D substituted → different derived digest, detectable
  byte-for-byte); `competitor-delivery.json` (a different Attempt's delivery → different digest);
  `wrong-spec-digest.json`; `evaluator-modified-template.json` (mutated `instructions` → different
  digest). Result-evaluation: a golden verdict envelope's decoded Statement structurally matches
  `ResultEvaluationStatementShape` and its `measurements` cover the spec's required list; the `subject`
  equals the original `subjectTask` + `subjectResults`.
  **Byte-pin (blocker fix — coordinator Task-13 byte-pin mandate):** parse
  `fixtures/result-evaluation/golden/evidence-statement.json` with `ResultEvaluationStatementShape`,
  assert it validates, round-trip it (`canonicalJsonBytes` → `decodeUtf8` → `JSON.parse`) and
  **deep-equal the original object**, and spot-assert the exact shapes — every `subject[].digest` is
  `{ sha256: <64-hex> }`, both `predicate.evaluationSpecification`/`evaluationMethod` parse as
  ResourceDescriptors (objects with `{ name, digest }`), and `predicate.taskSubject` is a name string.
  This checks the mirror against real Evidence bytes, not against itself. (JCS re-sorts object keys, so
  field order is moot — the risk this pins is purely field shapes/types.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `evaluation-task-1.0.ts` (builder + `deriveEvaluationTask`),
  `result-evaluation.ts`; seal the second document via `seal-documents.mjs`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test && yarn check:documents`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): evaluation-task/1.0 derivation template + verdict output"`

---

## Task 14: swe-rebench golden (row → Task + EvaluationSpec pair, digest-stable)

`swe-rebench-v2.v1` needs no successor profile: a row becomes a `repository-work` Task plus a
per-instance `deterministic-process` EvaluationSpec (§10.3/§13). The golden proves the format on the
hardest deterministic case and pins both digests.

**Files:**
- Create: `src/swe-rebench-golden.test.ts`, `src/documents/swe-rebench.ts` (row → pair mapper)
- Create: `fixtures/swe-rebench-golden/golden/row.json`, `.../expected.json` (pinned Task digest +
  EvaluationSpec digest), plus the sealed Task + spec bytes for inspection
- Modify: `src/index.ts`

**Interfaces:**
- Produces:
  `sweRebenchRowToTaskAndSpec(row: { instance_id: string; repo: string; base_commit: string; problem_statement: string; language: string; image: ResourceDescriptor; testMaterial: ResourceDescriptor[]; parser: ParserIdentity; transitions: { failToPass: string[]; passToPass: string[] }; timeout: number }): { evaluationSpec: EvaluationSpec; evaluationSpecDigest: string; taskPayload: unknown; taskInputs: unknown }`
  — the EvaluationSpec is `family: "deterministic-process"` carrying the `TaskEnvironmentSpec.v1`
  content; the Task references it by the sealed `evaluationSpecDigest` (spec sealed BEFORE the Task,
  §7); `hf_dataset`/`hf_split` become locator hints, not sealed content.
- Consumes: `buildRepositoryWorkProfile`, `sealEvaluationSpec`, `migrateJinnRepoTask` shape, identifiers.

- [ ] **Step 1: Write the failing test.** `swe-rebench-golden.test.ts` loads `row.json`, maps it,
  seals the spec then the Task, and asserts both digests equal the pinned `expected.json`; asserts
  test material carries `accessClass` (public for swe-rebench upstream rows, §10.3) and the spec is
  sealed strictly before the Task references it.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `swe-rebench.ts`; pin both digests.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verification gate.** `yarn typecheck && yarn test`.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): swe-rebench golden row → Task + EvaluationSpec pair"`

---

## Task 15: Kit assembly, `./testing` export, README, pack-smoke, full gate

Finalize the conformance kit's public surface (fixture manifest + structural checks re-exported from
`./testing`), rewrite the pack-smoke to exercise sealed assets + the `/testing` entrypoint, write the
README, and run the whole tree gate. This is the point where the kit — precedes any out-of-lane
consumer — is fully green.

**Files:**
- Modify: `src/testing.ts` (re-export the structural checks + a `FIXTURE_FAMILIES` manifest listing
  every `fixtures/*` family), `scripts/pack-smoke.mjs`, `README.md`
- Create: `packages/task-execution/profiles/README.md`
- Modify: `src/index.ts` (final export surface audit)

**Interfaces:**
- Produces: `./testing` re-exports `runStructuralCheck`, `loadFixtureFamily`, `checkVerdictConsistency`,
  `checkMeasurementCoverage`, `checkAllOfConstruction`, `resolveFamilyUri`, `checkAdmissionReceipt`,
  `deriveEvaluationTask`, and `FIXTURE_FAMILIES: string[]`.

- [ ] **Step 1: Write the failing pack-smoke.** Rewrite `scripts/pack-smoke.mjs` (from the Task 1
  copy) to: pack, install into a synthetic consumer, and assert — root import of `sealDocument` +
  identifiers works; `import.meta.resolve` reaches
  `@jinn-network/task-execution-profiles/profiles/task-profiles/repository-work/1.0/profile.json`
  and `.../evaluation-task/1.0/profile.json` and each matches its `profile.sha256`;
  `@jinn-network/task-execution-profiles/testing` imports and `FIXTURE_FAMILIES` is non-empty; the
  installed package declares no `@jinn-network/` dependency other than `task-execution-protocol`;
  no `.test.` files leak into `dist/`.
- [ ] **Step 2: Run → FAIL** (pack-smoke assertions unmet until `testing.ts` re-exports + README exist).
- [ ] **Step 3: Implement** the `./testing` re-export surface + `FIXTURE_FAMILIES`, write the README
  (package purpose, the two sealed documents + their reserved URIs, the pre-release "URIs must resolve
  before external conformance claims" note, the kit-consumer pointer).
- [ ] **Step 4: Run → PASS.** `yarn pack:smoke`.
- [ ] **Step 5: Full verification gate.**
  ```bash
  cd packages/task-execution/profiles \
    && yarn typecheck && yarn test && yarn build && yarn check:documents && yarn pack:smoke
  cd - \
    && node --test .github/scripts/task-execution-package-inventory.test.mjs \
    && node --test .github/scripts/task-execution-source-boundaries.test.mjs \
    && node .github/scripts/task-execution-packed-types.test.mjs
  ```
  Expected: all pass; packed-types compiles a consumer against the two new profiles entrypoints.
- [ ] **Step 6: Commit.**
  `git commit -am "feat(task-execution-profiles): finalize conformance kit, README, pack-smoke"`

---

## Self-review

**Spec coverage** (design §-by-§ → task): §4 SolverNet map = declared-impact only (Out-of-scope);
§5 run pinning / comparison classes = TEP amendment 1 (Out-of-scope; profiles fixtures T11); §6.1
profile schema = T8; §6.2 resolution = T9; §6.3 sub-profiles/family URI = T10; §6.4 hardening + cache
authority = T9; §6.5 no registry = T8 (`evaluationFamilies` whitelist; no registry object); §7.1
EvaluationSpec shape = T3; §7.2 family blocks + parser registry = T6; §7.3 verdict rule = T4 +
verdict-consistency T5; §7.4 unscorable = T5; §7.5 integrity measured-not-declared = admission-receipt
predicate (T7) + Out-of-scope note (measured tier is receipt-driven, not asserted here); §7.6
admission receipt = T7; §7.7 Evidence crosswalk = T13 (`result-evaluation.ts`); §8 repository-work =
T12; §9 evaluation-task + derivation = T13; §10 data flows = fixtures across T12–T14; §11 security =
T7/T9/T10/T13 adversarial fixtures; §12 kit = T2 + per-task fixtures + T15; §13 migration = T12/T14;
§14 package = T1; §15 order = task order; §16 non-goals = Out-of-scope; §17 follow-ups = Open items.

**Placeholder scan:** every code step shows the actual schema/function/fixture shape and exact
commands; pinned digests are filled from the first green run (explicit in T1/T3/T8/T12–T14); no
"add validation"/"TBD"/"similar to Task N".

**Type consistency:** `sealDocument`/`canonicalJsonBytes`/`recordDigest` (T1) reused verbatim in
T3/T8/T12/T13/T14; `EvaluationSpec` (T3) refined by `VerdictRuleSchema` (T4), `UnscorableSchema` (T5),
family blocks (T6) — same symbol, additive; `TaskProfileDocument` (T8) consumed by T9/T10/T12/T13;
`VerdictOutcome`/`MeasurementMap` (T4) reused in T5/T13; `ParserIdentity` (T6) reused in T14;
`ProfilesError` codes (`invalid-document`/`unsupported-profile`/`unsupported-requirement`) consistent
across T2/T3/T7/T9/T11.

---

## Out of scope

Named explicitly so nothing is silently assumed in-lane:

- **Carried TEP amendments 1, 2, 3** (Submission requirements map / `runPinning` capability block;
  `Task.profile` as ResourceDescriptor; correlation-annotation widening) — implemented in
  `2026-07-28-task-execution-protocol.md` (design §5/§6.2/§13; brief). Referenced, not re-planned.
  The comparison-class merge is TEP's pure `mergeRequirements` export (program §7.3); this lane only
  ships requirement-merge fixtures and executes that export (T11).
- **Autopilot session sub-profile of `repository-work`** — deferred to the Autopilot adapter work
  (design §2.5/§8/§17). Not delivered here.
- **SolverNet retirement mechanics** — operator task-filter config, generator re-homing, read-only
  legacy manifests (§15 step 7). Declared-impact notes only; no implementation tasks (Phase 0
  finding: SolverNet policy is operator config, and is NOT in the profiles package — record protocols
  never import discovery).
- **Marketplace-binding adoption** (§15 step 5): posting with profile descriptors and the
  binding-side named checks (derivation slot-equality / pair-fixing, receipt cryptographic
  verification, verdict-consistency at settlement). This package supplies the primitives
  (`deriveEvaluationTask`, `checkAdmissionReceipt`, `checkVerdictConsistency`); wiring them into a
  binding is out of lane.
- **The thin local evaluation harness** that consumes `evaluation-task/1.0` (backend-local lane) —
  and the local sealer identity (§9.1, Phase 0 non-blocking open-question 5).
- **Evaluator economics / quorum / challenge policy** (Phase B.2); **trust-layer** evaluator identity
  & qualification verification; **profile registry / discovery service**; **aggregation semantics**
  (consumer-side, TEP §10.5); **corpus admission policy**; **prediction & session-derived successor
  profiles**; **the benchmarking system** (a consumer of this layer).
- **Reserved-URI publication/hosting** and the resolve-before-external-claims tooling (§17;
  pre-release checklist, brief mandate 6); **scheme-IRI registration** (shared follow-up, TEP §28).

---

## Findings (surface to the coordinator; do not silently resolve)

1. **§15 order vs Phase-0 dependency edge.** §15 (authoritative internal order, per brief) puts the
   EvaluationSpec cluster BEFORE the profile mechanism; the Phase 0 JSON edge lists EvaluationSpec as
   `depends_on task-profile document schema`. This plan follows §15 — the true shared foundation is
   the sealing primitives + family enum (T1/T3), and neither document imports the other's schema.
   Confirm §15 governs.
2. **Comparison-class merge evaluator home — RESOLVED (program §7.3).** The merge is a single **pure**
   protocol export, `mergeRequirements(taskRequirements, submissionRequirements, keyClasses) →
   { ok: true, effective } | { ok: false, category: 'invalid-document', key }`, which the profiles kit
   executes (T11); Preflight P6 asserts the export and its absence is escalate-and-stop. There is no
   fixtures-only fallback. `unsupported-requirement` is produced by the **backend capability check**,
   never by this pure merge — so T11's pinning-inventory fixture is backend-path data, not a merge
   input.
3. **Cross-tree sealer byte-compatibility carrier.** T1/T6 need TEP protocol to either export a
   canonical-bytes/seal helper (strongest: direct byte-equality in a test) OR agree a shared
   pinned-digest equivalence fixture reconciled at the program gate. The design says compatibility is
   "held by fixtures, not imports"; confirm which carrier and that `canonicalize` (RFC 8785 JCS) is
   the shared canonicalization on both sides.
4. **Format-URI literals.** The `protocol` (document-format) field values are unspecified strings in
   the design; this plan proposes `https://jinn.network/profiles/task-profile/1.0` and
   `https://jinn.network/profiles/evaluation-spec/1.0` (§3 namespace split). Program-gate confirmation.
5. **`semanticsVersion` initial value.** Set to `"4"` from the current
   `EVAL_SEMANTICS_VERSION`; promoting it into sealed bytes freezes it — any later change is a
   semantics bump that re-digests every per-instance spec. Confirm the seed value.
6. **Verdict signer identity (Phase 0 blocking open-question 2).** §9.2 says the verdict DSSE
   Statement is signed by the "evaluator Agent's key"; the backend framing calls the signer an
   "attestation-issuer." This lane defines only the shape + structural checks; the signing identity is
   the backend/evaluation-runner adapter's contract. If those are distinct keys, the §7.6/§9.2
   independence property must be re-checked (cross-lane).
7. **Adapter output contract (Phase 0 blocking open-questions 3 & 4).** `checkVerdictConsistency`
   (T5) and the parser-allowlist convention (T6) assume the consuming evaluation adapter emits the
   FULL measurements set (covering every required measurement) and resolves parsers from a deployment
   allowlist without executing spec-supplied code. Confirm against the evaluation-runner adapter
   contract (cross-lane; out of this lane's control but load-bearing for these checks to mean
   anything).
8. **Coupling-without-import drift risk — carried by a byte-pin fixture (Phase 0 finding).** The
   evaluation-task verdict output (`result-evaluation.ts`, T13) must stay byte-compatible with the
   Evidence Result Evaluation predicate with no compile-time link (design §12/§14 forbid even the
   evidence *contract* import). T13 now transcribes the predicate/subject shapes field-for-field from
   `packages/evidence/protocol/src/schemas.ts` and pins them with a **byte-copy of the real evidence
   golden** (`fixtures/result-evaluation/golden/evidence-statement.json`) that `result-evaluation.ts`
   parses / round-trips / deep-equals — so the mirror is checked against real Evidence bytes, not
   itself. Residual: if the evidence predicate shape changes upstream, the copied fixture must be
   re-synced (a manual cross-tree step; there is intentionally no import). This plan follows the
   design's fixture-only choice — confirm.
9. **Guard ownership.** This plan REGISTERS profiles into the task-execution guards created by
   `2026-07-28-task-execution-protocol.md` (append + recompute count; T1 step 3). If, for sequencing
   reasons, profiles were ever to land before those guards exist, T1's registration edits must become
   a full clone (per the evidence precedent) — but the program DAG places protocol + testing before
   profiles, so registration is correct.

## Open items (deferred; design §17 follow-ups)

- ReDoS-hardening posture (settled for v1 per program §7.17; residual recorded here). The default is
  native `RegExp` guarded by an **admission-time** static pre-filter (`safe-regex` +
  `PROFILE_SCHEMA_MAX_PATTERN_LENGTH`) — a star-height check, NOT a runtime bound: a pattern that
  passes can still backtrack against a crafted payload at validation time. `compilePayloadValidator`
  therefore accepts an **injectable `regExp` engine** (ajv's `code.regExp` seam); the marketplace
  deployment profile mandates injecting RE2 (linear-time), which closes the residual. Revisit if
  `safe-regex` proves too permissive/strict, or to make the pattern-length bound program-confirmed.
- Reserved-URI publication tooling + the resolve-before-external-claims check as reusable tooling
  (§17).
- Scheme-IRI registration for the `identifier` `propertyID` values (`PROFILE_URI_SCHEME_IRI`,
  `TASK_DIGEST_SCHEME_IRI`) — one shared follow-up across TEP §28 / profiles §17 / trust §20 (brief
  mandate 4).
- Admission-receipt predicate schema unification (v2) — only the signed-Statement envelope is
  normative in v1 (§7.6).
- Parser-registry + admission-agent governance (who may add parsers / run admission agents) —
  deployment policy (§17).
- `PROFILE_SCHEMA_MAX_BYTES` / `PROFILE_SCHEMA_MAX_DEPTH` / `PROFILE_SCHEMA_MAX_PATTERN_LENGTH`
  concrete constants (proposed 262144 / 32 / 1024) — profile-format constants, program-gate
  confirmable.

## Addendum 2026-07-29-b — admission-receipt derivation crosswalk (program §7.39)

Profiles §7.6 requires the subject Submission's admission-receipt reference to be carried into
the evaluation Task as an input descriptor, while §9.1 originally described the Task as derived
from the settlement `(Task, Delivery)` pair alone. The implementation crosswalk is now explicit:
`deriveEvaluationTask` gains optional `admissionReceipt`, a `ResourceDescriptor` named
`admission-receipt`, and appends it after the name-sorted subject-artifact descriptors in
`inputs`. Its reference comes from the subject Submission annotation
`https://jinn.network/annotations/admission-receipt/1.0`. The no-receipt generic derivation keeps
its existing exact bytes/digest; the marketplace decision-grade profile requires the receipt and
byte-compares the receipt-bearing derivation against the settlement-fixed context. No receipt is
hidden in profile parameters or capability grants.
