# Trust and Identity Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** draft (pending program approval)

**Date:** 2026-07-28

**Implements:** `docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md` (the Jinn Trust and Identity Layer v1 design), §18 steps 1–2 only.

**Program dependencies (sibling 2026-07-28 plans):**
- None at compile time. Per the coordinator brief (Reconciled layer map) and design §4/§17, no protocol package imports trust and trust-core imports nothing Jinn. Trust-core + its kit run **in parallel** with the TEP stream (`2026-07-28-task-execution-protocol.md`) with no import edge in either direction.
- **Soft dependency (one gated leg only):** the cross-package sealing-equivalence leg against task-execution sealing (Task T17) activates **once `@jinn-network/task-execution-protocol` exists** (produced by `2026-07-28-task-execution-protocol.md`). The equivalence leg against `@jinn-network/evidence-protocol` (Task T10) has no dependency — evidence is already merged on this branch.

**Goal:** Ship the I/O-free identity/key-binding/authorization/trust-policy core (`@jinn-network/trust-core`), the RPC-dependent chain-fact resolvers (`@jinn-network/trust-resolve`), and the fixtures + conformance kit (`@jinn-network/trust-testing`) that hold sealing drift at zero — the substrate beneath the Evidence and Task Execution protocols.

**Architecture:** Three standalone yarn packages under `packages/trust/`, split by I/O exactly as design §17 mandates. `core` holds record schemas, sealing (re-implemented independently), validators, policy-chain verification, ceremony content-match, and the §7.5/§7.5a/§7.5b verification procedures written against **injected resolver/anchor interfaces it defines**. `resolve` implements those interfaces with chain reads (`ownerOf`, `getAgentWallet`-at-block, 1271 witness verification + archive re-execution, anchor lookups), promoting the existing `client/src/erc8004/publisher-safe-resolver.ts`. `testing` carries the §16 golden/adversarial fixture inventory, the conformance kit, and the cross-package sealing-equivalence fixtures against the evidence (now) and task-execution (gated) implementations. The dependency graph is acyclic: `resolve → core`, `testing → core + resolve`, `testing (devDep, equivalence oracle) → evidence-protocol`; nothing points back into `core`.

**Tech Stack:** TypeScript (NodeNext/strict), Zod 4 for schemas, `@noble/hashes` for SHA-256, `@noble/curves` for secp256k1 (EOA/1271/ReCap ceremony recovery — pure compute, lives in `core` per program ruling §7.9 / design §17), `viem` for chain reads (`resolve` only), Vitest for tests, Yarn 4.13.0 standalone projects with `portal:` resolutions, `node --test` guard scripts. No new runtime frameworks.

---

## Preflight

Before starting any task, assert the branch base contains the index-recorded head and the UTF-16 ordering fix (PR #2226):

```bash
git merge-base --is-ancestor 3650ac65e HEAD && echo "base OK" || { echo "REBASE: 3650ac65e is not an ancestor of HEAD"; exit 1; }
```

Expected: `base OK`. If it fails, stop and reconcile with `integration/evidence-v1` before writing any package — the trust guards clone the post-#2226 evidence guards, and the sealing spine depends on the code-unit ordering rule landed at that commit. All work targets `integration/evidence-v1`.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design, the coordinator brief, and the evidence precedent.

- **Package mechanics (evidence precedent, replicate exactly):** each package is a STANDALONE yarn project — own `yarn.lock`, `packageManager: "yarn@4.13.0"`, `engines.node: ">=22"`, `type: "module"`. In-tree Jinn deps are declared as normal semver dependencies **plus** `resolutions: { "<name>": "portal:../<sibling>" }` (cross-tree portals use the full relative path, e.g. `portal:../../evidence/protocol`). No repo-root workspace. All packages `version: "0.1.0"`.
- **No I/O in `trust-core`.** `core` depends on **nothing Jinn** (design §17). Its only runtime externals are `@noble/hashes`, `zod`, and `@noble/curves` — the evidence floor (`@noble/hashes` + `zod`) plus `@noble/curves` for the I/O-free EOA/1271/ReCap ceremony signature recovery that program ruling §7.9 places in `core`. The `trust-source-boundaries` guard **allowlists exactly these three externals** (§7.9) and bans `node:fs`, `node:net`, `node:http*`, ambient network APIs, `viem`, and every `@jinn-network/*` package from `core` production source.
- **UTF-16 code-unit ordering everywhere sealed bytes are produced.** Any string that reaches canonical bytes or a reported ordering MUST be ordered by `compareCodeUnitStrings` (UTF-16 code-unit), **never** `localeCompare` / `toLocale*` / `Intl`. `core` ships its own `src/order.ts`; `resolve` and `testing` reuse `core`'s exported comparator (they already depend on `core`). This rule is **not in the design text** — see the Dated Addendum below; it is carried in from the coordinator brief / evidence PR #2226.
- **Sealing is re-implemented, not shared at runtime** (design §17; evidence precedent). `core` re-implements TEP §6.1 sealing + DSSE handling independently. Cross-implementation agreement is held by **fixtures**, not code reuse: pinned-digest goldens per record family + cross-package equivalence fixtures (with at least one object-key-sort-sensitive record).
- **Media types (vendor-tree names used as-is):** `application/vnd.jinn.trust.key-binding.v1+json` (§7.1), `application/vnd.jinn.trust.policy.v1+json` (§9). Authorization statements are in-toto Statements over `application/vnd.in-toto+json` (`DSSE_PAYLOAD_TYPE`). The revocation-companion media type is **unspecified in the design** — working title `application/vnd.jinn.trust.revocation.v1+json` (flagged in findings). IANA registration is a recorded non-blocking follow-up (brief mandate 4).
- **Scheme-IRI registration** (`identifier` `propertyID` IRIs for did:pkh / did:key / CAIP-19 / GitHub spellings) is ONE shared follow-up across TEP §28 / profiles §17 / trust §20 — tracked once by the program doc, **not implemented here**.
- **Guards land WITH the first package of the tree** (Task T1), never after. Guard work is copy-the-evidence-file-and-swap-the-constant-blocks (there is no shared guard library). Each subsequent package task EXTENDS the four guard constant blocks; **guard package counts are COMPUTED from the enumerated list, never hardcoded** as a bare integer beyond the `assert.equal(TRUST_PACKAGES.length, N)` line, which is updated as packages land.
- **Rule 3 (surgical):** touch only files under `packages/trust/**` and the four new `.github/scripts/trust-*.test.mjs` + `.github/workflows/trust-ci.yml`. **Never edit the evidence guards or any shared file.** The locale-ban coverage for `packages/trust/` is delivered by the trust guard CLONE, not by editing `evidence-source-boundaries.test.mjs`.
- **Verification gate per unit:** `yarn typecheck`, `yarn test`, `yarn build`, `yarn pack:smoke` in the package, plus the relevant tree guards (`node --test .github/scripts/trust-package-inventory.test.mjs`, `node --test .github/scripts/trust-source-boundaries.test.mjs`) and, at the tree's end, `node .github/scripts/trust-packed-types.test.mjs`. Run locally, evidence-style.

---

## Dated Addendum (2026-07-28) — carried constraints not in the design text

The design (2026-07-27) is **silent** on two items the coordinator brief makes binding. They are implemented here and recorded as a dated addendum so the divergence from the design letter is visible:

1. **UTF-16 code-unit canonical string ordering.** Evidence PR #2226 (merged `9614fe7bc`, 2026-07-27) established a per-package `order.ts` (`compareCodeUnitStrings`) and banned `localeCompare` / `toLocale*` / `Intl` in all evidence production source via `.github/scripts/evidence-source-boundaries.test.mjs` (scoped to `packages/evidence/` only). The trust design's sealing text ("sealed per TEP §6.1", §7.1/§16/§17) does not mention it. **This plan gives `trust-core` its own `src/order.ts`, routes every ordering through it, and the trust source-boundaries guard clone applies the locale ban to `packages/trust/` production source.** At least one object-key-sort-sensitive record is included in the cross-package equivalence fixtures (Task T10) so a canonicalization divergence is caught.
   - *Divergence from the trust.json open-question wording:* that disposition said "extend `evidence-source-boundaries.test.mjs` … to `packages/trust/`." Per the brief's clone-per-tree precedent and Rule 3, the coverage is delivered by the **`trust-source-boundaries.test.mjs` clone** instead of editing the evidence guard. Same effect, correct file.
2. **Revocation-companion record shape as its own sealed family.** The brief and the Phase-0 inventory enumerate **four** record families (key-binding, revocation companion, authorization Statement, trust-policy). The design §2.1 counts "exactly two record families (key-binding, authorization) plus the trust-policy document" and calls revocation a "companion record" (§7.4b). This plan implements schema + sealing + validators for the revocation companion as a first-class sealed shape (Task T5), consistent with the brief; the framing difference is noted in findings.
3. **Evidence sealing-equivalence leg scoped to algorithm identity, not canonical bytes.** Design §17 asks for "sealing-equivalence fixtures against the task-execution **and evidence** implementations." Program ruling §7.15 (confirmed against ground truth: `@jinn-network/evidence-protocol` exports only `sha256Hex`, `recordDigest`, `dssePreAuthEncoding` — all serialization-agnostic — and **no** canonical-JSON serializer; the evidence canonical layout lives in the separate `attestation-issuer` package in the indented form §7.1 rejects) makes canonical-byte equivalence against evidence **unachievable by construction**. This plan therefore asserts, against evidence, only DSSE PAE byte-equality and `recordDigest` algorithm agreement over shared bytes (Task T10); the genuine canonical-byte equivalence runs against `task-execution-protocol` (Task T17, both raw JCS per §7.1). The design §17 evidence-leg expectation is adjusted here as a surfaced finding, not silently patched.

---

## File Structure

New tree `packages/trust/` — three packages plus the guard clone. Files that change together live together; each package is one clear responsibility.

```text
packages/trust/
  core/                         @jinn-network/trust-core  (no I/O; deps: @noble/hashes, zod)
    package.json  tsconfig.json  tsconfig.build.json  README.md
    scripts/pack-smoke.mjs
    src/
      order.ts                  compareCodeUnitStrings (UTF-16 code-unit)
      canonical-json.ts         deterministic sorted-key serializer -> canonical bytes
      hashing.ts                sha256Hex, recordDigest -> `sha256:${hex}`
      dsse.ts                   dssePreAuthEncoding, DSSE envelope seal/parse, DSSE_PAYLOAD_TYPE
      identifiers.ts            media-type + protocol-format URIs, policy-purpose ids
      spellings.ts              canonical identity spellings (did:pkh, did:key, CAIP-19, OIDC, github) + validators (§5)
      key-binding.ts            KeyBinding schema + validator + seal (§7.1)
      revocation.ts             Revocation companion schema + validator + seal (§7.4b)
      authorization.ts          Authorization Statement schema + attenuation checks (§8.1)
      policy.ts                 TrustPolicy schema + policy-chain verification (§9)
      ceremony.ts               ceremony content-match + EOA/ReCap I/O-free verification (§7.2)
      interfaces.ts             injected resolver/anchor interface TYPES (implemented by resolve)
      verify.ts                 §7.5 steps 1/4/5 + §7.5a join + §7.5b requester; consent/revocation rules (§7.4)
      errors.ts  types.ts  index.ts
      *.test.ts                 colocated unit tests (fixture-first)
    fixtures/
      sealing-v1/               pinned-digest goldens: key-binding, revocation, policy, authorization + expected-digests.json
      ceremony-v1/              EOA SIWE, ReCap message goldens
  resolve/                      @jinn-network/trust-resolve  (RPC; deps: @jinn-network/trust-core, viem)
    package.json  tsconfig.json  tsconfig.build.json  README.md
    scripts/pack-smoke.mjs
    src/
      chain-facts.ts            ownerOf, getAgentWallet-at-block (promotes publisher-safe-resolver)
      witness.ts                1271 witness verification + archive re-execution (§7.2a)
      anchors.ts                anchor lookups + at-time ordering (§7.3)
      binding-resolver.ts       composes chain-facts+anchors into core's BindingResolver/AnchorResolver
      abis.ts                   getAgentWallet + ownerOf + isValidSignature ABIs (copied constants)
      errors.ts  types.ts  index.ts
      *.test.ts                 hermetic-injection tests (no live RPC)
  testing/                      @jinn-network/trust-testing  (kit + fixtures)
    package.json  tsconfig.json  tsconfig.build.json  README.md
    scripts/pack-smoke.mjs
    src/
      sealing-equivalence.ts    cross-impl equivalence vs evidence-protocol (+ gated: task-execution-protocol)
      fakes.ts                  in-memory BindingResolver/AnchorResolver/WitnessVerifier for the kit
      conformance.ts            describeTrustVerificationContract(...) battery (§16)
      walkthroughs.ts           §13 walkthroughs as executable integration fixtures
      index.ts
      *.test.ts
    fixtures/
      binding-v1/ revocation-v1/ authorization-v1/ policy-v1/   schema goldens
      ceremony-v1/              EOA SIWE, Safe 1271 + witness, SignMessageLib, OIDC (anchored JWKS), agentId composition
      resolution-v1/            at-time ordering, effective-start, conflict, unanchored-non-resolution
      consent-v1/  revocation-v1/  join-v1/  requester-v1/
      adversarial-v1/           the full §16 adversarial set
      equivalence-v1/           shared payload bytes + trust-core self-digests (T10) + TEP oracle digest (T17); key-order-sensitive record included
.github/scripts/
  trust-package-inventory.test.mjs      clone of evidence-package-inventory.test.mjs
  trust-source-boundaries.test.mjs      clone of evidence-source-boundaries.test.mjs
  trust-packed-types.test.mjs           clone of evidence-packed-types.test.mjs
.github/workflows/
  trust-ci.yml                          clone of evidence-ci.yml (job DAG mirrors the graph)
```

---

## Milestone 1 — Trust tree bootstrap + `trust-core` sealing spine

Guards land with the first package. Sealing + goldens are the "kit precedes implementation" spine (the pinned-digest fixtures are the executable spec that `core` must reproduce).

### Task T1: Trust tree guard clone + `trust-core` package skeleton

**Files:**
- Create: `packages/trust/core/package.json`, `packages/trust/core/tsconfig.json`, `packages/trust/core/tsconfig.build.json`, `packages/trust/core/README.md`, `packages/trust/core/scripts/pack-smoke.mjs`, `packages/trust/core/src/index.ts`
- Create: `.github/scripts/trust-package-inventory.test.mjs`, `.github/scripts/trust-source-boundaries.test.mjs`, `.github/scripts/trust-packed-types.test.mjs`, `.github/workflows/trust-ci.yml`

**Interfaces:**
- Produces: the standalone `@jinn-network/trust-core` project shell and the four trust-tree guards, enumerating `core` only (extended by later tasks).

- [ ] **Step 1: Write `packages/trust/core/package.json`** (model verbatim on `packages/evidence/protocol/package.json`; no Jinn deps).

```json
{
  "name": "@jinn-network/trust-core",
  "version": "0.1.0",
  "description": "I/O-free identity, key-binding, authorization, and trust-policy core for Jinn.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "https://github.com/Jinn-Network/mono.git", "directory": "packages/trust/core" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./fixtures/*": "./fixtures/*"
  },
  "files": ["dist/", "fixtures/", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": { "@noble/hashes": "^2.2.0", "@noble/curves": "^2.0.0", "zod": "4.4.3" },
  "devDependencies": { "@types/node": "^22.0.0", "typescript": "^5.9.3", "vitest": "^4.1.8" }
}
```

- [ ] **Step 2: Copy `tsconfig.json`, `tsconfig.build.json`, `scripts/pack-smoke.mjs` from `packages/evidence/attestation-issuer/`.** `tsconfig.json`/`tsconfig.build.json` are byte-identical to attestation-issuer's (they carry no package-specific content). Adapt `scripts/pack-smoke.mjs`: `trust-core` has no Jinn deps, so delete the protocol/repository archive+install lines; it only packs `trust-core` itself and compiles a one-line consumer `import * as trust from "@jinn-network/trust-core";`. Set the tmp-dir prefix to `jinn-trust-core-`.

- [ ] **Step 3: Write `src/index.ts`** as an empty re-export barrel (grows per task): `export {};`

- [ ] **Step 4: Clone `trust-package-inventory.test.mjs`** from `.github/scripts/evidence-package-inventory.test.mjs`. Swap ONLY the constant blocks:
  - `packageRoot = join(root, 'packages', 'trust')`
  - `TRUST_PACKAGES = [['core', '@jinn-network/trust-core']]`
  - `JINN_DEPENDENCY_GRAPH = new Map([['core', { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] }]])`
  - Replace the tree-scan regex `/^@jinn-network\/evidence-/` + the two special-case names with `/^@jinn-network\/trust-/` (no special-case names — all three trust packages carry the `trust-` prefix).
  - `assert.equal(TRUST_PACKAGES.length, 1)` for now.
  - Delete the derivation-vitest-peer test (evidence-specific); keep the manifest-count, name, `repository.directory`, dependency-graph, and portal-resolution tests.

- [ ] **Step 5: Clone `trust-source-boundaries.test.mjs`** from `.github/scripts/evidence-source-boundaries.test.mjs`. Keep the generic scanner helpers (`specifiers`, `forbiddenImports`, `forbiddenImportsInFiles`, `files`, `inside`, the ambient-network regexes, the **locale-sensitive regexes and `localeSensitiveUsesInFiles`**) verbatim. Swap the constant blocks:
  - `packages = join(root, 'packages', 'trust')`
  - `trustDirectories = ['core']` (extended per task)
  - Replace the evidence per-package forbidden/allowed inventories with a **`CORE_ALLOWED_EXTERNALS` allowlist** of exactly `['@noble/hashes', '@noble/curves', 'zod']` (program ruling §7.9's "allowlists exactly these"). The `core` production-source test collects every bare (non-relative, non-`node:builtin`-shaped) import specifier, strips its subpath, and asserts membership in `CORE_ALLOWED_EXTERNALS` — so `node:fs`/`node:net`/`node:http*`/`node:dgram`/`node:child_process`/`node:tls`/`node:dns`, `viem`, and every `@jinn-network/*` name (core imports nothing Jinn) all fail the allowlist rather than being enumerated in a ban list. Also set `CORE_ALLOWED_DEPENDENCIES = ['@noble/hashes', '@noble/curves', 'zod']` (empty allowed-dev beyond the toolchain) so the manifest cannot declare anything outside the three. Keep the ambient-network ban and the "production source never orders or formats with the host locale" test, iterating `trustDirectories`.
  - Keep the self-test fixtures (the import-scanner and locale-scanner `mkdtemp` tests) verbatim — they prove the scanner, independent of tree.

- [ ] **Step 6: Clone `trust-packed-types.test.mjs`** from `.github/scripts/evidence-packed-types.test.mjs`. Swap:
  - `evidenceRoot` → `trustRoot = join(root, 'packages', 'trust')`
  - `packages = [['core', '@jinn-network/trust-core']]`
  - `codeEntrypoints = ['@jinn-network/trust-core']`
  - Drop the `@types/better-sqlite3` consumer dep (not needed).

- [ ] **Step 7: Clone `trust-ci.yml`** from `.github/workflows/evidence-ci.yml`. Reduce to the trust job DAG: `architecture` (runs the inventory + source-boundaries guards), `foundation` (`trust-core`: install/typecheck/test/build/pack:smoke, upload `packages/trust/core/dist`), and `verify` (`needs: [architecture, foundation]`, runs `node .github/scripts/trust-packed-types.test.mjs`). `resolve` and `testing` jobs are added by their tasks. Set path triggers: `packages/trust/**`, `.github/scripts/trust-*.test.mjs`, `.github/workflows/trust-ci.yml`, `docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md`.

- [ ] **Step 8: Run the guards + build.** Expected: inventory + boundaries pass; `yarn install && yarn typecheck && yarn build && yarn pack:smoke` in `packages/trust/core` pass (empty barrel compiles).

Run:
```bash
node --test .github/scripts/trust-package-inventory.test.mjs
node --test .github/scripts/trust-source-boundaries.test.mjs
(cd packages/trust/core && yarn install && yarn typecheck && yarn build && yarn pack:smoke)
```
Expected: PASS.

- [ ] **Step 9: Commit.**
```bash
git add packages/trust/core .github/scripts/trust-*.test.mjs .github/workflows/trust-ci.yml
git commit -m "feat(trust): scaffold trust-core package and clone tree guards"
```

### Task T2: `trust-core` sealing primitives + pinned-digest goldens (§7.1 sealing, §6.1 re-impl)

**Files:**
- Create: `packages/trust/core/src/order.ts`, `canonical-json.ts`, `hashing.ts`, `dsse.ts`, `identifiers.ts`, `errors.ts`, `types.ts`
- Create: `packages/trust/core/src/order.test.ts`, `canonical-json.test.ts`, `dsse.test.ts`
- Create: `packages/trust/core/fixtures/sealing-v1/expected-digests.json`
- Modify: `packages/trust/core/src/index.ts`

**Interfaces:**
- Produces: `compareCodeUnitStrings(left,right):number`; `canonicalJsonBytes(value:unknown):Uint8Array` (sorted keys, deterministic); `sha256Hex(bytes):string`, `recordDigest(bytes):\`sha256:${string}\``; `dssePreAuthEncoding(payloadType:string,payloadBytes:Uint8Array):Uint8Array`, `sealDsseEnvelope(...)`, `parseDsseEnvelope(bytes)`; `DSSE_PAYLOAD_TYPE`, media-type + protocol-format URIs. These are the sealing spine every later `core` task consumes.

- [ ] **Step 1: Write `src/order.ts`** — copy verbatim from `packages/evidence/attestation-issuer/src/order.ts` (the `compareCodeUnitStrings` body and the banned-`localeCompare` doc comment).

- [ ] **Step 2: Write the failing test `src/order.test.ts`.**
```ts
import { describe, expect, test } from "vitest";
import { compareCodeUnitStrings } from "./order.js";
describe("compareCodeUnitStrings", () => {
  test("orders by UTF-16 code unit, not host collation", () => {
    // 'Z' (0x5A) precedes 'a' (0x61) by code unit; many locales sort 'a' first.
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(["b", "A", "Z", "a"].sort(compareCodeUnitStrings)).toEqual(["A", "Z", "a", "b"]);
  });
});
```
Run: `(cd packages/trust/core && yarn test order)` — expect FAIL until `order.ts` compiles (it already exists from Step 1, so this passes immediately; keep it as the drift guard).

- [ ] **Step 3: Write `src/canonical-json.ts`** — emit **raw RFC 8785 JCS under I-JSON** per program ruling §7.1 (the stack-wide sealed-bytes rule): compact separators (**no** space after `,` or `:`), **no indentation, no trailing newline**, ES Number-to-string formatting. Borrow ONLY two things from `packages/evidence/attestation-issuer/src/deterministic-json.ts`: the `cloneJsonValue` prototype-safety pass (copy verbatim) and the code-unit key sort. Do **not** reproduce that file's `2`-space indent + trailing-newline layout — attestation-issuer's indented form is an evidence-internal precedent, **not** the sealing rule (§7.1 names it explicitly as not-the-rule). Sort keys via `Object.keys(value).sort(compareCodeUnitStrings)` and emit each object by **explicit sorted-key iteration** (build the `{...}` string key-by-key from the sorted array) — **never** rely on `JSON.stringify` insertion order, since integer-like string keys (`"10"`, `"2"`) iterate numerically under JS object semantics and would diverge from JCS's code-unit order (program ruling §7.14). Export `canonicalJsonBytes(value): Uint8Array`. Import `compareCodeUnitStrings` from `./order.js`.

- [ ] **Step 4: Write `src/hashing.ts`** — copy verbatim from `packages/evidence/protocol/src/hashing.ts` (`sha256Hex`, `recordDigest`).

- [ ] **Step 5: Write `src/dsse.ts`** — port `dssePreAuthEncoding` verbatim from `packages/evidence/protocol/src/claims.ts` (the `concatenate`/`ascii`/`dssePreAuthEncoding` helpers). Add `sealDsseEnvelope({ payloadBytes, signatures })` producing `canonicalJsonBytes({ payloadType, payload: base64(payloadBytes), signatures })` and `parseDsseEnvelope(bytes)` with strict base64 decode (port `decodeBase64Strict` from `claims.ts`). Export `DSSE_PAYLOAD_TYPE` from `identifiers.ts`.

- [ ] **Step 6: Write `src/identifiers.ts`** with the trust URIs:
```ts
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const TRUST_KEY_BINDING_MEDIA_TYPE = "application/vnd.jinn.trust.key-binding.v1+json" as const;
export const TRUST_POLICY_MEDIA_TYPE = "application/vnd.jinn.trust.policy.v1+json" as const;
// Working title — revocation-companion media type is unspecified in the design (findings).
export const TRUST_REVOCATION_MEDIA_TYPE = "application/vnd.jinn.trust.revocation.v1+json" as const;
export const TRUST_KEY_BINDING_FORMAT = "https://jinn.network/trust/key-binding/v1" as const;
export const TRUST_POLICY_FORMAT = "https://jinn.network/trust/policy/v1" as const;
export const AUTHORIZATION_PREDICATE_TYPE = "https://jinn.network/trust/authorization/v1" as const;
```

- [ ] **Step 7: Write `src/errors.ts`** — a `TrustCoreError extends Error` with a `code` string discriminant (model on `packages/evidence/attestation-issuer/src/errors.ts`), and `invalidInput(message,cause?)` / `conformanceFailure(message)` helpers used by validators.

- [ ] **Step 8: Write `src/types.ts`** — a `JsonValue` type (copy from attestation-issuer) and shared branded types (`Sha256Digest = \`sha256:${string}\``).

- [ ] **Step 9: Write the failing test `src/dsse.test.ts` + `canonical-json.test.ts`.** Assert: `dssePreAuthEncoding("application/vnd.in-toto+json", bytes)` begins with `DSSEv1 `; `canonicalJsonBytes({ b: 1, a: 2 })` equals `canonicalJsonBytes({ a: 2, b: 1 })` (key-order independence); **the integer-like-key reference case (§7.14): `canonicalJsonBytes({ "10": 0, "2": 0 })` serializes with `"2"` before `"10"` (code-unit order — `'1' (0x31) < '2' (0x32)`), proving the serializer iterates the sorted key array explicitly and does NOT inherit JS object numeric-key iteration order**; the raw-JCS shape is exact — `new TextDecoder().decode(canonicalJsonBytes({ b: 1, a: 2 }))` equals `` `{"a":2,"b":1}` `` (no spaces, no indent, no trailing newline); a round-trip `parseDsseEnvelope(sealDsseEnvelope(...))` returns the same payload/signatures. Run: expect PASS once Steps 3/5 land.

- [ ] **Step 10: Create the pinned-digest goldens.** Write `fixtures/sealing-v1/expected-digests.json` as `{}` initially; add a test `src/sealing-fixtures.test.ts` that canonicalizes each of four representative structured records (a key-binding-shaped object, a revocation-shaped object, a policy-shaped object, and an authorization-statement-shaped object — literal fixtures inline in the test) and asserts `recordDigest(canonicalJsonBytes(x))` equals the pinned value. Run once with the digests empty (test FAILS and prints the actual digests), paste the four `sha256:...` values into `expected-digests.json`, re-run (PASS). This is the standard golden workflow — the pinned digest becomes the drift guard.

- [ ] **Step 11: Update `src/index.ts`** to re-export `order`, `canonical-json`, `hashing`, `dsse`, `identifiers`, `errors`, `types`.

- [ ] **Step 12: Verification gate.**
```bash
(cd packages/trust/core && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node --test .github/scripts/trust-source-boundaries.test.mjs
```
Expected: PASS (locale ban green — no `localeCompare` in core source).

- [ ] **Step 13: Commit.**
```bash
git add packages/trust/core
git commit -m "feat(trust-core): sealing primitives, canonical bytes, DSSE, pinned-digest goldens"
```

---

## Milestone 2 — `trust-core` record families

Each family is fixture-first: write the schema golden, write the failing validator/seal test, implement, pass.

### Task T3: Identity spellings (§5)

**Files:**
- Create: `packages/trust/core/src/spellings.ts`, `spellings.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `compareCodeUnitStrings`, `TrustCoreError`.
- Produces: canonical-spelling constructors + validators for `did:pkh:eip155:<chainId>:0x<EIP-55>` (with a `contractAccount` flag, §3.1), `did:key`, CAIP-19 (`eip155:<chainId>/erc721:0x<registry>/<agentId>`), OIDC workflow subject, `https://github.com/<login>` + numeric id. `AgentIri` (opaque `urn:uuid:`/persistent IRI, §5), `VoucherIdentity` union, `RelationshipVocabulary = "controls"|"operates"|"signs-for"`, `ScopeVocabulary = "deliveries"|"verdicts"|"observations"|"authorizations"|"bindings"` (+namespaced-extension acceptance).

- [ ] **Step 1: Write failing `spellings.test.ts`.** Assert: a lowercase EVM address is rejected unless EIP-55 checksummed (design §3.1 "mandatory EIP-55 checksum"); a valid `did:pkh:eip155:8453:0x<checksummed>` parses and round-trips; CAIP-19 requires the `erc721:` asset-namespace and a positive decimal `agentId`; the relationship/scope vocabularies reject unknown members but accept `namespace:custom` scope extensions.

- [ ] **Step 2: Implement `src/spellings.ts`** with Zod schemas: `DidPkhSchema` (regex + EIP-55 checksum verification via `@noble/hashes` keccak — port the checksum routine; do NOT import `viem`), `DidKeySchema`, `Caip19AgentSchema`, `OidcSubjectSchema`, `GithubHumanSchema`, and the closed `relationship`/`scope` enums with a `.or()` for `^[a-z][a-z0-9-]*:[A-Za-z0-9-]+$` namespaced scope extensions. Order any reported member lists through `compareCodeUnitStrings`.

- [ ] **Step 3: Run test → PASS. Update `index.ts`. Gate + commit.**
```bash
(cd packages/trust/core && yarn typecheck && yarn test spellings)
git add packages/trust/core && git commit -m "feat(trust-core): canonical identity spellings and vocabularies (§5)"
```

### Task T4: Key-binding record (§7.1)

**Files:**
- Create: `packages/trust/core/src/key-binding.ts`, `key-binding.test.ts`
- Create: `packages/trust/core/fixtures/sealing-v1/key-binding.json` (golden)
- Modify: `src/index.ts`, `fixtures/sealing-v1/expected-digests.json`

**Interfaces:**
- Consumes: spellings, sealing spine, `sealDsseEnvelope`.
- Produces: `KeyBindingSchema` (Zod) over the §7.1 field table; `validateKeyBinding(bytes): { conforms: boolean; diagnostics }`; `sealKeyBinding(binding, signer): Promise<{ envelopeBytes, recordDigest }>`. Field set (design §7.1): `protocol`, `agent`, `key {publicKey, keyid, algorithm, didKey}`, `voucher`, `relationship`, `scope[]`, `validFrom`, `expiresAt?`, `ceremony`, `strength` (**ceremony-derived, never producer-asserted**), `supersedes?`, `consent?`, `anchors[]`, namespaced extensions.

- [ ] **Step 1: Write failing `key-binding.test.ts`.** Assert: (a) a valid binding parses and `validateKeyBinding` reports `conforms:true`; (b) `strength` set to `strong` on a `github-human` ceremony is a conformance FAILURE (strength is ceremony-derived — the validator recomputes it from `ceremony.type` and rejects a mismatch, §7.1/§7.2 table); (c) `scope: ["bindings"]` is accepted; an unknown scope member fails; (d) `sealKeyBinding` produces bytes whose `recordDigest` matches `fixtures/sealing-v1/key-binding.json`'s pinned digest.

- [ ] **Step 2: Write the golden** `fixtures/sealing-v1/key-binding.json` (a canonical EOA-vouched binding with deliberately unsorted input keys in the seal call). Leave its digest empty in `expected-digests.json`.

- [ ] **Step 3: Implement `src/key-binding.ts`.** `KeyBindingSchema` with the field table; `deriveStrength(ceremonyType)` mapping `eoa|safe|agentId|oidc-machine → strong`, `github-human → weak` (§7.2 table); validator recomputes and rejects producer-asserted mismatches. `sealKeyBinding` canonicalizes via `canonicalJsonBytes`, wraps in a DSSE envelope signed by the injected working-key `signer` (the `DsseSigner` port — copy the `DsseSigner` type from `packages/evidence/attestation-issuer/src/types.ts`), and returns `{ envelopeBytes, recordDigest }`. **The envelope signature proves possession only; binding authority is the ceremony** — the validator MUST NOT accept a binding on envelope signature alone (that acceptance is the negative fixture in Task T13).

- [ ] **Step 4: Run test (fails on empty digest), paste the printed digest into `expected-digests.json`, re-run → PASS. Update `index.ts`. Gate + commit.**

### Task T5: Revocation companion record (§7.4b)

**Files:**
- Create: `packages/trust/core/src/revocation.ts`, `revocation.test.ts`
- Create: `packages/trust/core/fixtures/sealing-v1/revocation.json`
- Modify: `src/index.ts`, `expected-digests.json`

**Interfaces:**
- Produces: `RevocationSchema` (`target` = digest of the revoked binding, `revokedBy` voucher/working-key, `anchors[]`, `effectiveFrom`); `validateRevocation`, `sealRevocation`. Rule content (§7.4b): valid only when signed by the binding's voucher account (fresh ceremony) OR a currently-valid working key of the same Agent with `scope: bindings`; **never retroactive** (effect starts at its own anchor time). The *signer-authority* check is a resolution-time rule enforced in Task T8's `verify.ts`; the schema here pins the record shape + the non-retroactivity field semantics.

- [ ] **Step 1: Write failing `revocation.test.ts`** — schema validation positive/negative + pinned-digest seal round-trip.
- [ ] **Step 2: Golden + empty digest. Step 3: implement. Step 4: pin digest, PASS, index, gate, commit.**

### Task T6: Authorization statement + attenuation (§8.1)

**Files:**
- Create: `packages/trust/core/src/authorization.ts`, `authorization.test.ts`
- Create: `packages/trust/core/fixtures/sealing-v1/authorization.json`
- Modify: `src/index.ts`, `expected-digests.json`

**Interfaces:**
- Produces: `AuthorizationStatementSchema` (in-toto Statement; fields per §8.1: `issuer`, `audience?`, `subjects[]` digest-bound, `capabilities[]` capability-strings paired with subjects, `expiry`, `nonce`, `proofs[]` digest refs to parents, `revocation?`); `checkAttenuation(child, parent): { valid: boolean; reason? }` — **exact-string set inclusion**: the child's capability set MUST be a subset of the parent's; **no wildcards, no qualification arrays** (§8.1); `sealAuthorization(statement, signer)`. Grant records (§8.3) reuse this schema (audience = backend/executor class; subjects include the named input digest and SHOULD include the Submission digest).

- [ ] **Step 1: Write failing `authorization.test.ts`.** Assert: (a) valid statement round-trips + pinned digest; (b) `checkAttenuation` returns `valid:false` when the child adds a capability not in the parent (widening); (c) a `*` wildcard capability string is treated as a literal string (no wildcard semantics) and therefore fails subset unless the parent literally holds `*`; (d) a qualification-array-shaped capability fails schema (deliberate simplification of ReCap's `att`).
- [ ] **Step 2: Golden + empty digest. Step 3: implement `checkAttenuation` via `Set` subset with `compareCodeUnitStrings`-ordered diagnostics. Step 4: pin, PASS, index, gate, commit.**

### Task T7: Trust-policy document + policy-chain verification (§9)

**Files:**
- Create: `packages/trust/core/src/policy.ts`, `policy.test.ts`
- Create: `packages/trust/core/fixtures/sealing-v1/policy.json`, `packages/trust/core/fixtures/policy-chain-v1/` (a 3-version chain golden + a rollback/expired/competing-genesis set)
- Modify: `src/index.ts`, `expected-digests.json`

**Interfaces:**
- Consumes: sealing spine, spellings, DSSE verify.
- Produces: `TrustPolicySchema` (`application/vnd.jinn.trust.policy.v1+json`; per-**purpose** entries naming acceptable Agent IRIs + required binding `strength`; `version`, `predecessor?` hash-link, `signerSet` = working keys, `refreshBy`, `creditRegime?` optional block); the **9 registered policy purposes** (`adoption-authority`, `admission-agent`, `verifier-agent`, `witness-verifier`, `parser-registry`, `receipt-author`, `plugin-signer`, `dispatcher-author`, `evaluator-eligibility`) exported as `POLICY_PURPOSES`; `verifyPolicyChain(versions, { genesisAnchor, now, dsseVerifier }): { newest: TrustPolicy; ok: boolean; reason? }`.
- **Critical rule (§9):** version N+1 MUST be signed by thresholds of **both** the old and new signer sets (working keys listed in the previous version — the one sanctioned exception to "entries name IRIs"); `refreshBy` freshness enforced; **anti-rollback** (never accept a version lower than one already seen); chain verification **terminates at the genesis ceremony and NEVER invokes §7.5 step 5 on its own signers** (Task T8's `verify.ts` must expose this exclusion; `policy.ts` uses only DSSE-offline + signer-set membership, no binding resolution).

- [ ] **Step 1: Write failing `policy.test.ts`.** Cases: (a) a valid 3-version chain verifies; (b) version N+1 missing the OLD signer-set threshold is rejected; (c) an expired `refreshBy` version is rejected; (d) a lower version than one already seen is rejected (anti-rollback); (e) competing genesis versions are surfaced as a policy conflict; (f) `verifyPolicyChain` never calls the binding resolver (assert by passing a resolver that throws if called).
- [ ] **Step 2: Goldens (valid chain + adversarial set). Step 3: implement `policy.ts` + `POLICY_PURPOSES`. Step 4: pin the policy golden digest, PASS, index, gate, commit.**

---

## Milestone 3 — Ceremonies, injected interfaces, and the §7.5 procedure

### Task T8: Ceremony content-match + EOA/ReCap I/O-free verification (§7.2)

**Files:**
- Create: `packages/trust/core/src/ceremony.ts`, `ceremony.test.ts`
- Create: `packages/trust/core/fixtures/ceremony-v1/eoa-siwe.json`, `recap.json`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `verifyEoaCeremony(ceremony, binding): CeremonyResult` — offline EIP-191 recover via `@noble/hashes` keccak + `@noble/curves` secp256k1, **in `core`** (program ruling §7.9 / design §17: EOA/1271/ReCap ceremony signature recovery is pure compute, so it lives in `core`; `@noble/curves` is a committed `core` dependency from Task T1 Step 1 and one of the three externals the guard allowlists). `matchCeremonyContent(ceremony, record): { matches: boolean; mismatch? }` — the **mandatory field-for-field content match** (§7.2): SIWE `resources` Agent IRI equals `record.agent`; `resources` `did:key` equals `record.key.didKey`; for ReCap ceremonies (§8.1) the transcribed capabilities equal the statement's. A mismatch means the ceremony binds nothing.
- **This is the lifted-ceremony defense** — content match plus validity windows, NOT SIWE nonce tracking (offline verification has no relying-party nonce store, §7.2).

- [ ] **Step 1: Write failing `ceremony.test.ts`.** Assert: a genuine EOA SIWE ceremony whose `resources` name IRI-X and key-K **fails** to bind a record claiming IRI-Y (lifted-ceremony content mismatch); a matching ceremony passes; a ReCap ceremony whose transcribed capabilities differ from the statement fails.
- [ ] **Step 2: Golden ceremonies. Step 3: implement `matchCeremonyContent` + in-`core` `verifyEoaCeremony`/`verifyReCapCeremony` signature recovery (`@noble/curves` secp256k1). Step 4: PASS, index, gate, commit.**

### Task T9: Injected resolver/anchor interfaces (§17 I/O split) + §7.5 / §7.5a / §7.5b procedures + consent/revocation rules (§7.4)

**Files:**
- Create: `packages/trust/core/src/interfaces.ts`, `verify.ts`, `verify.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces (the interface types `resolve` implements): `BindingResolver { resolveBinding(pair: { key; agent }, atTime): Promise<ResolvedBinding | null> }` (anchor-ordered per §7.3, unanchored non-resolution under anchor-requiring profiles); `AnchorResolver { lookupAnchor(digest): Promise<AnchorObservation | null> }` (append-only, tamper-evident, consistent observable order); `WitnessVerifier { verify1271Witness(witness): Promise<WitnessResult> }`; `ChainFactResolver { ownerOf(caip19): Promise<Address>; getAgentWalletAtBlock(agentId, block): Promise<Address> }`.
- Produces (the procedures, §7.5 steps 1/4/5 + §7.5a + §7.5b, I/O-free — steps 2/3 delegate to injected interfaces): `verifyEnvelopeBinding({ envelopeBytes, key, agent, family, atTime }, { bindingResolver, witnessVerifier, policy }): Promise<VerificationOutcome>`; `settlementJoinCheck(...)` (§7.5a — verdict DSSE key ↔ settling Safe, both legs same Agent IRI, `relationship ∈ {controls, signs-for}`, no partial credit); `authenticateRequester(submissionEnvelope, { bindingResolver, policy })` (§7.5b — `scope: authorizations` or `signs-for`). Consent chain (§7.4a) and revocation (§7.4b) authority rules enforced here.
- **Step 5 exclusion:** expose `verifyEnvelopeBinding` with a `{ applyPolicy: boolean }` option so policy-chain verification (Task T7) can run the procedure WITHOUT step 5 (never recurse into policy on its own signers, §9).

- [ ] **Step 1: Write `src/interfaces.ts`** — the four interface types above, plus `ResolvedBinding`, `AnchorObservation`, `WitnessResult`, `VerificationOutcome` result shapes. No implementations.

- [ ] **Step 2: Write failing `verify.test.ts`** using an **in-module fake** `BindingResolver`/`AnchorResolver`/`WitnessVerifier` (small inline fakes; the reusable ones ship from `trust-testing` in Task T11). Cases: (a) valid envelope + resolved binding at effective time + ceremony match + window/scope/consent/no-revocation → `ok:true`; (b) envelope family not in the binding's `scope` → fail at step 4; (c) a subsequent (non-genesis) binding with neither an incumbent `controls` voucher nor a `bindings`-scoped consent countersignature → rejected (§7.4a); (d) an anchored revocation before the evidence time → fail; a revocation AFTER the evidence time → the evidence still attributes (non-retroactivity, §7.4b); (e) §7.5a: divergent times or a missing leg fail the join; (f) §7.5b: a Submission whose key resolves to a different requester IRI fails.

- [ ] **Step 3: Implement `src/verify.ts`** — the three procedures calling the injected interfaces for steps 2/3, applying the §7.4 consent/revocation rules and the §7.3 effective-time rule (`effectiveStart = max(validFrom, anchorTime)`; earlier-anchored wins conflicts). Import ceremony content-match from `ceremony.ts` for step 3's offline leg.

- [ ] **Step 4: Run → PASS. Update `index.ts` (export `interfaces`, `verify`, `ceremony`, `policy`, all record modules, `POLICY_PURPOSES`).**

- [ ] **Step 5: Full `trust-core` gate + packed-types entry check.**
```bash
(cd packages/trust/core && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node --test .github/scripts/trust-package-inventory.test.mjs
node --test .github/scripts/trust-source-boundaries.test.mjs
node .github/scripts/trust-packed-types.test.mjs
```
Expected: PASS (packed-types compiles a consumer against `@jinn-network/trust-core`).

- [ ] **Step 6: Commit.**
```bash
git add packages/trust/core
git commit -m "feat(trust-core): injected interfaces + §7.5/§7.5a/§7.5b procedures, consent/revocation rules"
```

---

## Milestone 4 — `trust-testing` first leg: sealing algorithm-equivalence vs evidence

The kit's sealing-equivalence portion co-develops with `core` (needs `core` + `evidence-protocol` only, **not** `resolve`), landing before `resolve` per the brief's "testing fixtures/kit + core → resolve" sequencing. **Scope (program ruling §7.15):** against `evidence-protocol` this leg asserts DSSE PAE byte-equality and `recordDigest` algorithm agreement over shared bytes only — `evidence-protocol` exports no canonical serializer, so canonical-byte equivalence is not assertable here and is deferred to the `task-execution-protocol` leg (Task T17), which §7.1 makes byte-identical. The design §17 "sealing-equivalence fixtures against the … evidence implementations" expectation is adjusted accordingly and surfaced in the Dated Addendum.

### Task T10: `trust-testing` skeleton + guard extension + sealing-equivalence vs `evidence-protocol`

**Files:**
- Create: `packages/trust/testing/package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `scripts/pack-smoke.mjs`, `src/index.ts`, `src/sealing-equivalence.ts`, `src/sealing-equivalence.test.ts`
- Create: `packages/trust/testing/fixtures/equivalence-v1/` (shared payload bytes for the evidence algorithm-identity leg + `trust-core` self-consistency digests; the object-key-sort-sensitive record is included here for the T17 canonical-byte leg)
- Modify: `.github/scripts/trust-package-inventory.test.mjs`, `trust-source-boundaries.test.mjs`, `trust-packed-types.test.mjs`, `.github/workflows/trust-ci.yml`

**Interfaces:**
- Consumes: `@jinn-network/trust-core` (its `canonicalJsonBytes`, `dssePreAuthEncoding`, `recordDigest`), `@jinn-network/evidence-protocol` (its exported `dssePreAuthEncoding`, `recordDigest`, `sha256Hex` — the **algorithm oracle**). Note `evidence-protocol` exports **no canonical-JSON serializer** (only these serialization-agnostic primitives, which operate on already-serialized bytes; the evidence sealer that adds a canonical layout lives in the *separate* `attestation-issuer` package and uses the indented form §7.1 explicitly rejects). So the evidence leg can only assert **algorithm identity over shared bytes**, never canonical-byte equivalence — program ruling §7.15.
- Produces: `assertSealingEquivalence(sharedPayloadBytes)` — asserts `trust-core` and `evidence-protocol` produce byte-identical **DSSE PAE** and byte-identical **`recordDigest`** for the *same already-serialized* input bytes (both are digest/PAE algorithm-identity checks). The real cross-implementation **canonical-byte** equivalence (does trust-core's JCS serializer produce the same bytes as another impl?) is asserted only against `task-execution-protocol` in Task T17 (§7.1 makes both raw JCS). Within T10 the key-order-sensitive record is pinned against `trust-core`'s **own** output as a self-consistency drift guard — not against an evidence digest, which does not exist for canonical JSON.

- [ ] **Step 1: Write `packages/trust/testing/package.json`** — model on `packages/evidence/attestation-issuer/package.json`. Declare **only the deps that exist at land time** (`trust-resolve` does not exist until Task T11, so it is NOT declared here — its dep, portal, and inventory-graph edge are added in Task T14 where the resolver-dependent kit code first imports it). Deps: `@jinn-network/trust-core` `0.1.0`. devDeps: `@jinn-network/evidence-protocol` `0.1.0` (equivalence oracle), `@types/node`, `typescript`, `vitest`. peerDeps: `vitest` optional. `resolutions`: `"@jinn-network/trust-core": "portal:../core"`, `"@jinn-network/evidence-protocol": "portal:../../evidence/protocol"`. exports: `.` + `./fixtures/*`.

- [ ] **Step 2: Copy `tsconfig*.json` + adapt `scripts/pack-smoke.mjs`** (packs core + evidence-protocol as portal archives into a consumer, prefix `jinn-trust-testing-`; the `resolve` archive is added to pack-smoke in Task T14 when the resolve dep lands).

- [ ] **Step 3: Extend the three guards + CI for the `testing` package (2nd package).**
  - `trust-package-inventory.test.mjs`: add `['testing', '@jinn-network/trust-testing']` to `TRUST_PACKAGES`; add its `JINN_DEPENDENCY_GRAPH` entry with **only the deps that exist now** (`dependencies: ['@jinn-network/trust-core']`, `devDependencies: ['@jinn-network/evidence-protocol']`; the `@jinn-network/trust-resolve` dependency edge is added in Task T14). **Extend `expectedPortal` / the portal-resolution assertion to permit a cross-tree portal for `@jinn-network/evidence-protocol`** (compute the relative path from `packages/trust/testing` to `packages/evidence/protocol`). Bump `assert.equal(TRUST_PACKAGES.length, 2)` (`[core, testing]`).
  - `trust-source-boundaries.test.mjs`: add `'testing'` to `trustDirectories` (locale ban now covers testing source too). `testing` is a kit — it needs no forbidden-package inventory beyond the locale + ambient-network bans.
  - `trust-packed-types.test.mjs`: add `['testing', '@jinn-network/trust-testing']` to `packages` and `'@jinn-network/trust-testing'` to `codeEntrypoints`; add `@jinn-network/evidence-protocol` to the consumer deps so the portal chain resolves.
  - `trust-ci.yml`: add a `testing` job `needs: [foundation, resolve]` — **but `resolve` does not exist yet at T10**. Land the `testing` job now with `needs: [foundation]` and update it to `needs: [foundation, resolve]` in Task T14 (the resolve-dependent kit code). Add `testing` to the `verify` job's `needs`. **Cross-tree portal build (program ruling §7.8):** `@jinn-network/evidence-protocol` is consumed via a cross-tree portal (`portal:../../evidence/protocol`), which resolves to evidence-protocol's built `dist/`, so the `testing` job MUST build it **from source before installing** the testing package — add a step `(cd packages/evidence/protocol && corepack yarn install --immutable && corepack yarn build)` ahead of the testing package's `yarn install`. (Task T14 adds the analogous `trust-resolve` build step; Task T17 adds `task-execution-protocol`.)

- [ ] **Step 4: Write the equivalence fixtures.** `fixtures/equivalence-v1/shared-payload-bytes.json` = a set of raw already-serialized payloads (with their payload types) fed identically to both impls' PAE/digest primitives. `fixtures/equivalence-v1/key-order-sensitive.json` = a nested object with keys in NON-sorted order (carried forward for the T17 canonical-byte leg against `task-execution-protocol`, and used in T10 only as a `trust-core` self-consistency drift guard). `fixtures/equivalence-v1/trust-core-digests.json` = `trust-core`'s **own** pinned digest for the key-order-sensitive record's canonical form (filled after Step 6 first run) — **not** an evidence digest, since evidence-protocol exports no canonical serializer (§7.15).

- [ ] **Step 5: Write failing `src/sealing-equivalence.test.ts`.** Assert only what is true against evidence-protocol's actual exports (§7.15): (a) `trustCore.dssePreAuthEncoding(t, b)` byte-equals `evidenceProtocol.dssePreAuthEncoding(t, b)` over shared payload bytes (PAE algorithm identity); (b) `trustCore.recordDigest(bytes)` equals `evidenceProtocol.recordDigest(bytes)` over shared bytes (digest algorithm identity). **Do NOT** assert that any pinned digest is "the digest evidence-protocol produces for the canonical form" — evidence has no canonical serializer. Separately, `trustCore.recordDigest(trustCore.canonicalJsonBytes(keyOrderSensitiveInput))` equals the pinned `trust-core-digests.json` value (a `trust-core`-only key-sort drift guard). The genuine cross-impl canonical-byte equivalence is asserted in Task T17 against `task-execution-protocol`.

- [ ] **Step 6: Implement `src/sealing-equivalence.ts` + `index.ts`.** Run the test (the trust-core self-digest empty → prints actual), pin it into `trust-core-digests.json`, re-run → PASS.

- [ ] **Step 7: Verification gate.** Build the cross-tree portal dependency (`evidence-protocol`) from source before installing `testing`, per program ruling §7.8 — the portal resolves to its `dist/`.
```bash
node --test .github/scripts/trust-package-inventory.test.mjs
node --test .github/scripts/trust-source-boundaries.test.mjs
(cd packages/evidence/protocol && yarn install && yarn build)   # cross-tree portal dep built from source (§7.8)
(cd packages/trust/testing && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
```
Expected: PASS.

- [ ] **Step 8: Commit.**
```bash
git add packages/trust/testing .github/scripts/trust-*.test.mjs .github/workflows/trust-ci.yml
git commit -m "feat(trust-testing): sealing-equivalence fixtures vs evidence-protocol"
```

---

## Milestone 5 — `trust-resolve`

Implements the interfaces `core` defines. Promotes `client/src/erc8004/publisher-safe-resolver.ts`. Hermetic-injection tests only (no live RPC).

### Task T11: `trust-resolve` skeleton + guard extension + chain-fact resolvers (promote publisher-safe-resolver)

**Files:**
- Create: `packages/trust/resolve/package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `scripts/pack-smoke.mjs`, `src/index.ts`, `src/abis.ts`, `src/chain-facts.ts`, `src/errors.ts`, `src/types.ts`, `src/chain-facts.test.ts`
- Modify: `.github/scripts/trust-package-inventory.test.mjs`, `trust-source-boundaries.test.mjs`, `trust-packed-types.test.mjs`, `.github/workflows/trust-ci.yml`

**Interfaces:**
- Consumes: `@jinn-network/trust-core` (`ChainFactResolver`, `BindingResolver`, `AnchorResolver`, `WitnessVerifier` interface types; `compareCodeUnitStrings` for any ordering).
- Produces: `createChainFactResolver(options): ChainFactResolver` implementing `ownerOf(caip19)` (ERC-721 `ownerOf`) and `getAgentWalletAtBlock(agentId, block)` — the promoted `publisher-safe-resolver` logic, generalized (multi-provider fallback, per-provider chain-id validation, immutable caching, all preserved).

- [ ] **Step 1: Write `packages/trust/resolve/package.json`.** Deps: `@jinn-network/trust-core` `0.1.0`, `viem` (pin to the version `client` uses — read `client/package.json` for the exact spec). devDeps: `@types/node`, `typescript`, `vitest`. `resolutions`: `"@jinn-network/trust-core": "portal:../core"`. exports: `.`.

- [ ] **Step 2: Copy `tsconfig*.json` + adapt `scripts/pack-smoke.mjs`** (packs core + resolve; prefix `jinn-trust-resolve-`).

- [ ] **Step 3: Extend the three guards + CI for `resolve` (3rd package).**
  - inventory: add `['resolve', '@jinn-network/trust-resolve']`; `JINN_DEPENDENCY_GRAPH` entry `dependencies: ['@jinn-network/trust-core']`; bump `assert.equal(TRUST_PACKAGES.length, 3)`.
  - source-boundaries: add `'resolve'` to `trustDirectories`. Add a `RESOLVE_ALLOWED_DEPENDENCIES` block (`@jinn-network/trust-core`, `viem`) and forbid every other `@jinn-network/*` and the sibling trust packages from `resolve` production source (resolve must not import `testing`). The locale ban applies. **Resolve MAY use `viem` and node network I/O** — do NOT copy the evidence ambient-network ban into `resolve`'s inventory; resolve is the RPC package. (Keep the ambient-network self-test fixture, but do not assert the ban over `resolve` production source.)
  - packed-types: add `['resolve', '@jinn-network/trust-resolve']` + `'@jinn-network/trust-resolve'` to `codeEntrypoints`.
  - `trust-ci.yml`: add a `resolve` job `needs: [foundation]` (restore core dist, install, typecheck/test/build/pack:smoke, upload `resolve/dist`); add `resolve` to `verify.needs`; update the `testing` job to `needs: [foundation, resolve]`.

- [ ] **Step 4: Write `src/abis.ts`** — copy `IDENTITY_REGISTRY_GET_AGENT_WALLET_ABI` from `client/src/erc8004/abis.ts`; add a standard ERC-721 `ownerOf(uint256) view returns (address)` ABI and an `isValidSignature(bytes32,bytes) view returns (bytes4)` (EIP-1271) ABI for Task T12.

- [ ] **Step 5: Write failing `src/chain-facts.test.ts`** using the structural `RegistryReadClient` injection seam from the promoted resolver (hermetic — no live RPC): a fake client returns a checksummed wallet at a block; assert `getAgentWalletAtBlock` returns it, rejects on chain-id mismatch, rejects zero-address; `ownerOf` returns the token owner.

- [ ] **Step 6: Implement `src/chain-facts.ts`** by promoting `client/src/erc8004/publisher-safe-resolver.ts` (copy its `RegistryReadClient` interface, multi-provider fallback, chain-id caching, `getAddress`/`zeroAddress` guards). Refactor its bespoke registry-address lookup: instead of `getIdentityRegistryAddress` (client-internal), accept the registry address via `options.identityRegistry` per chain (the caller/deployment profile supplies it — resolve must not import client contract-address tables). Expose `createChainFactResolver` returning the `ChainFactResolver` shape from `trust-core`.

- [ ] **Step 7: Run → PASS. Index. Gate (inventory/boundaries/package build). Commit.**
```bash
node --test .github/scripts/trust-package-inventory.test.mjs
node --test .github/scripts/trust-source-boundaries.test.mjs
(cd packages/trust/resolve && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
git add packages/trust/resolve .github/scripts/trust-*.test.mjs .github/workflows/trust-ci.yml
git commit -m "feat(trust-resolve): promote publisher-safe-resolver as ChainFactResolver"
```

### Task T12: 1271 witness verification + archive re-execution (§7.2a)

**Files:**
- Create: `packages/trust/resolve/src/witness.ts`, `witness.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `WitnessVerifier` interface type; `abis.ts` (`isValidSignature`); DSSE verify from `trust-core`.
- Produces: `createWitnessVerifier(options): WitnessVerifier` — verifies the **DSSE-signed witness statement** `{chainId, blockNumber, blockHash, isValidSignature result, verifier}` (§7.2a) and, when the witness author is not policy-accepted, offers the **archive re-execution fallback**: an `eth_call` of `isValidSignature` at the witnessed block (requires an archive node — named cost). Witness-author policy acceptability is decided by the CALLER via `trust-core`'s `verifier-agent`/`witness-verifier` policy purposes; `resolve` provides both the signed-witness check and the archive re-execution.

- [ ] **Step 1: Write failing `witness.test.ts`** (hermetic): a valid signed witness verifies; a fabricated/unsigned witness fails; the archive re-execution path calls the injected archive client with the witnessed block and returns the `isValidSignature` magic value.
- [ ] **Step 2: Implement `src/witness.ts`. Step 3: PASS, index, gate, commit.**

### Task T13: Anchor lookups + at-time resolution ordering (§7.3) + `BindingResolver` composition

**Files:**
- Create: `packages/trust/resolve/src/anchors.ts`, `binding-resolver.ts`, `anchors.test.ts`, `binding-resolver.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `chain-facts.ts`, `witness.ts`, `AnchorResolver`/`BindingResolver` interface types, `compareCodeUnitStrings` (from `trust-core`, for any reported ordering).
- Produces: `createAnchorResolver(options): AnchorResolver` — append-only anchor lookups with a **consistent observable order** for all consumers; `createBindingResolver({ chainFacts, anchors, witness }): BindingResolver` — resolves `(key, agent)` at a time, applying `effectiveStart = max(validFrom, anchorTime)` (§7.3), unanchored-non-resolution under anchor-requiring profiles, earlier-anchored-wins conflict resolution, and the agentId composition leg (§7.2: an agentId binding resolves only alongside a valid account ceremony to the same IRI covering the same time).

- [ ] **Step 1: Write failing tests** (hermetic, injected fake anchor store): effective-start = `max(validFrom, anchorTime)`; an unanchored binding does not resolve under an anchor-requiring profile; two conflicting bindings over the same `(key,agent)` resolve to the earlier-anchored one and surface the conflict; an agentId binding without the account leg resolves to nothing.
- [ ] **Step 2: Implement `anchors.ts` + `binding-resolver.ts`. Step 3: PASS, index.**
- [ ] **Step 4: Full `resolve` gate + packed-types.**
```bash
(cd packages/trust/resolve && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node .github/scripts/trust-packed-types.test.mjs
```
Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add packages/trust/resolve && git commit -m "feat(trust-resolve): anchor lookups + at-time binding resolution (§7.3)"
```

---

## Milestone 6 — `trust-testing` second leg: conformance kit + adversarial battery + walkthroughs

Now that `core` + `resolve` both exist, the kit's resolver-dependent portions land.

### Task T14: Reusable fakes + conformance battery (§16 schema + ceremony + resolution + consent + revocation)

**Files:**
- Create: `packages/trust/testing/src/fakes.ts`, `conformance.ts`, `conformance.test.ts`
- Create: `packages/trust/testing/fixtures/{binding-v1,revocation-v1,authorization-v1,policy-v1,ceremony-v1,resolution-v1,consent-v1}/` goldens
- Modify: `packages/trust/testing/package.json` (add the `@jinn-network/trust-resolve` dependency + same-tree portal — deferred here from T10 because `resolve` only exists after T11), `packages/trust/testing/scripts/pack-smoke.mjs` (add the `resolve` portal archive)
- Modify: `packages/trust/testing/src/index.ts`; `.github/scripts/trust-package-inventory.test.mjs` (add the testing→`@jinn-network/trust-resolve` dependency-graph edge), `.github/workflows/trust-ci.yml`; `trust-packed-types.test.mjs` `codeEntrypoints` (add `@jinn-network/trust-testing` subpaths if any exported)

**Interfaces:**
- Consumes: `trust-core` (validators, `verify`, `policy`), `trust-resolve` (real resolvers, optional) — the kit uses `fakes.ts` in-memory `BindingResolver`/`AnchorResolver`/`WitnessVerifier` so the battery runs without RPC; a downstream consumer can pass `trust-resolve`'s real implementations to the same `describeTrustVerificationContract`.
- Produces: `createFakeResolvers()`; `describeTrustVerificationContract(createContext)` — the §16 battery: schema validation (binding/revocation/authorization/policy); ceremony goldens (EOA SIWE, Safe 1271 + signed witness, `SignMessageLib` approval, OIDC machine binding with anchored JWKS, agentId composition); at-time resolution (anchor ordering, `max(validFrom,anchorTime)`, conflict resolution, unanchored non-resolution); consent chains (genesis / self-extension / cross-account / missing-consent rejection); revocation (authorized / unauthorized rejection / non-retroactivity).

- [ ] **Step 1: Wire the `trust-resolve` dependency (deferred from T10 — `resolve` now exists).** Add `"@jinn-network/trust-resolve": "0.1.0"` to `testing/package.json` `dependencies` with `resolutions: { "@jinn-network/trust-resolve": "portal:../resolve" }` (same-tree portal); add the `resolve` portal archive to `scripts/pack-smoke.mjs`; add `@jinn-network/trust-resolve` to the testing entry's `JINN_DEPENDENCY_GRAPH.dependencies` in `trust-package-inventory.test.mjs` (no `TRUST_PACKAGES.length` change — resolve was enumerated in T11). Run the inventory guard → PASS.
- [ ] **Step 2: Write `src/fakes.ts`** — in-memory implementations of the three `trust-core` interfaces backed by fixture maps (model the beforeEach/afterEach context pattern on `packages/evidence/discovery/src/catalog/testing.ts` `describeEvidenceCatalogContract`).
- [ ] **Step 3: Author the §16 goldens** (schema + ceremony + resolution + consent + revocation), each a static fixture file.
- [ ] **Step 4: Write `conformance.ts`** exposing `describeTrustVerificationContract` running the battery against an injected context; `conformance.test.ts` runs it against `createFakeResolvers()`.
- [ ] **Step 5: Update the `testing` CI job to `needs: [foundation, resolve]`** (if not already done in T11 Step 3), and add its cross-tree/portal build steps (§7.8): restore the `resolve` dist artifact (same-tree) and build `evidence-protocol` from source before the testing install. Gate + commit. The local gate builds both portal deps from source first:
```bash
(cd packages/evidence/protocol && yarn install && yarn build)   # cross-tree portal dep (§7.8)
(cd packages/trust/resolve && yarn install && yarn build)       # same-tree portal dep
(cd packages/trust/testing && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node --test .github/scripts/trust-package-inventory.test.mjs
git add packages/trust/testing .github/scripts/trust-package-inventory.test.mjs .github/workflows/trust-ci.yml && git commit -m "feat(trust-testing): conformance battery + reusable fakes (§16)"
```

### Task T15: Adversarial set + §7.5a join + §7.5b requester (§16 adversarial)

**Files:**
- Create: `packages/trust/testing/src/adversarial.test.ts`
- Create: `packages/trust/testing/fixtures/{join-v1,requester-v1,adversarial-v1}/` goldens
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `describeTrustVerificationContract` context, `trust-core` `verify` (`settlementJoinCheck`, `authenticateRequester`).
- Produces: the full §16 adversarial battery as executable fixtures: lifted-ceremony content mismatch; hostile attachment; agentId claim without composition; unsigned/fabricated witness; back-dated `validFrom`; **binding accepted on envelope signature alone MUST FAIL**; scope violations; attenuation widening; grant issuer-mismatch; leaked-document replay; audience-authentication failure; policy rollback / expired policy / missing dual-threshold / competing genesis. Plus §7.5a join positive+negative and §7.5b requester positive+negative.

- [ ] **Step 1: Write `adversarial.test.ts`** enumerating each bullet as a named case (positive control + the adversarial negative). Each MUST fail closed with the specific reason code.
- [ ] **Step 2: Author the adversarial goldens. Step 3: run → PASS. Gate + commit.**

### Task T16: §13 walkthroughs as executable integration fixtures + final tree gate

**Files:**
- Create: `packages/trust/testing/src/walkthroughs.ts`, `walkthroughs.test.ts`
- Create: `packages/trust/testing/fixtures/walkthrough-v1/` goldens
- Modify: `src/index.ts`

**Interfaces:**
- Produces: the four §13 walkthroughs as end-to-end integration fixtures: (1) **Old verdict after key rotation** — 2026 verdict audited in 2028, binding resolved at the envelope's effective time, §7.5a join lands on the same IRI, verdict stands; (2) **Open-fleet adoption settlement** — the Statement twin resolves the signing key's binding to the launcher IRI + fresh policy chain, no GitHub login consulted, revocation not consulted (irrevocable-until-expiry); (3) **Confidential input, leaked documents** — `authenticateRequester` fails closed with `access-denied`; (4) **Two-Safe evaluator distinctness** — both Safes' declarations resolve to one Agent IRI → `distinctEvaluator` unsatisfied; a fresh unbound IRI rejected by `evaluator-eligibility`.
- **Note:** walkthrough (2) exercises the adoption-authorization **Statement twin resolution only** — the EIP-712 enforcement struct and its schema/bijection live in the marketplace tree (§8.2, out of scope). The fixture stubs the launcher-IRI binding + policy chain that a marketplace consumer would supply.

- [ ] **Step 1: Write `walkthroughs.test.ts`** driving each walkthrough through `trust-core` + `fakes.ts`.
- [ ] **Step 2: Author the walkthrough goldens. Step 3: run → PASS.**
- [ ] **Step 4: Full tree gate.**
```bash
node --test .github/scripts/trust-package-inventory.test.mjs
node --test .github/scripts/trust-source-boundaries.test.mjs
(cd packages/trust/core && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
(cd packages/trust/resolve && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
(cd packages/trust/testing && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node .github/scripts/trust-packed-types.test.mjs
```
Expected: ALL PASS. The trust tree is green end-to-end.
- [ ] **Step 5: Commit.**
```bash
git add packages/trust/testing && git commit -m "feat(trust-testing): §13 walkthroughs as executable integration fixtures"
```

---

## Milestone 7 — Gated: task-execution sealing-equivalence leg

### Task T17 (GATED on `@jinn-network/task-execution-protocol` existing): equivalence vs task-execution sealing

**Precondition:** `@jinn-network/task-execution-protocol` (from `2026-07-28-task-execution-protocol.md`) is merged onto `integration/evidence-v1` and exports its TEP §6.1 sealing primitives (`dssePreAuthEncoding`, `recordDigest`, and/or a canonical serializer). **Do NOT start this task until that package exists** — the coordinator sequences it after S1 protocol lands (brief Program sequencing skeleton).

**Files:**
- Modify: `packages/trust/testing/package.json` (add `@jinn-network/task-execution-protocol` devDep + portal resolution `portal:../../task-execution/protocol`), `src/sealing-equivalence.ts`, `src/sealing-equivalence.test.ts`, `fixtures/equivalence-v1/`
- Modify: `.github/scripts/trust-package-inventory.test.mjs` (permit the new cross-tree devDep portal), `trust-packed-types.test.mjs` (add the consumer dep), `.github/workflows/trust-ci.yml` (add the build-`task-execution-protocol`-from-source step to the `testing` job, per §7.8)

**Interfaces:**
- Produces: the second equivalence leg — `trust-core` sealing produces byte-identical PAE + digest to `task-execution-protocol`'s for shared inputs, including the key-order-sensitive record.
- **Critical reconciliation point (see findings):** the convention is **already fixed** by program ruling §7.1 — both `trust-core` and `task-execution-protocol` emit raw RFC 8785 JCS (no indent, no trailing newline), and TEP is the authoritative definition of the shared sealed-bytes rule that trust records inherit ("sealed per TEP §6.1", design §7.1). This fixture therefore **verifies** byte-identity, it does not negotiate a convention. `trust-core` is the side bound to raw JCS. If the fixture fails, one side has a bug against the fixed §7.1 rule — surface the divergence to the coordinator immediately; do not silently retune either side or treat the whitespace/indent/newline choice as still open.

- [ ] **Step 1: Add the devDep + portal + guard permissions, and the trust-ci build step.** Add `@jinn-network/task-execution-protocol` devDep + `portal:../../task-execution/protocol`; permit the new cross-tree devDep portal in the inventory guard; add the consumer dep in packed-types; add a `testing`-job step `(cd packages/task-execution/protocol && corepack yarn install --immutable && corepack yarn build)` **before** the testing install (§7.8 — the cross-tree portal resolves to TEP's built `dist/`), mirrored in the local gate.
- [ ] **Step 2: Write failing equivalence test vs `task-execution-protocol`.** This is the genuine cross-impl **canonical-byte** equivalence leg (§7.1 makes both raw JCS): assert `trustCore.canonicalJsonBytes(x)` byte-equals `tep.canonicalJsonBytes(x)` (or TEP's exported canonical serializer) for shared inputs including the key-order-sensitive record, plus PAE + `recordDigest` agreement.
- [ ] **Step 3: Verify (do not negotiate) the bytes per §7.1; pin the oracle digest; PASS.** Any failure is a bug against the fixed §7.1 convention — surface to the coordinator (see the reconciliation note above), do not retune either side.
- [ ] **Step 4: Gate + commit.** Build `task-execution-protocol` from source before install:
```bash
(cd packages/task-execution/protocol && yarn install && yarn build)   # cross-tree portal dep (§7.8)
(cd packages/evidence/protocol && yarn install && yarn build)
(cd packages/trust/resolve && yarn install && yarn build)
(cd packages/trust/testing && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node --test .github/scripts/trust-package-inventory.test.mjs
```

---

## Out-of-scope (recorded with pointers)

Everything below is named in the design/brief and explicitly NOT built by this plan. Each carries a pointer to where it lives.

- **§18 step 3 — Identity establishment** (Agent IRI minting + genesis bindings in operator bootstrap; where #1401 closes). Host migration into `client/src/earning/bootstrap.ts`; consumes `trust-core` + `trust-resolve`. Future work.
- **§18 step 4 — First trust-policy documents** replacing `receiptAuthors`, official-profile policy, dispatcher author allowlists, plugin trusted-signer lists (R9 demotion). Host migration; consumes `trust-core`. Future work.
- **§18 step 5 — DSSE convergence with binding references** (replace self-asserted envelope `participant` fields). Couples with the TEP marketplace-binding lane. Future work.
- **§18 step 6 / §8.2 — Open-fleet adoption authorization object** (EIP-712 enforcement struct + in-toto Statement twin + bijection fixtures). **Lives in the marketplace tree** — its tuple carries application identifiers (`taskId`, `attemptIndex`, `requestId`, `resultingHead`); trust supplies identity + signature semantics only. `trust-core`'s authorization schema (Task T6) is the substrate it reuses.
- **§8.2 / §18 step 6 / §20 — Solidity Router/TaskCoordinator adoption-authorization policy hook.** Separately-designed future marketplace contract change. **Carried constraint (record in the program doc):** the future contract MUST use an on-chain expected-signer slot **settable only by the launcher Safe**, so working-key rotation = a Safe tx updating the slot — the contract must not re-import the #1401 shape (design §8.2/§20).
- **§18 step 7 — Grant resolution in backends** (the 5-step obligation §8.3). The backend-local plan implements the minimum it needs locally (workspace provisioner resolving `capabilityGrants` into `secrets/` for the evaluation harness signer, per the coordinator brief); the general backend resolution obligation + R18 caller-authentication (ERC-8128 generalized) is future work consuming `trust-core`.
- **§18 step 8 — Verifier / admission-agent / witness-verifier policy integration** (B.2 staging). Future consumers of the `POLICY_PURPOSES` this plan registers.
- **Carried TEP §20 wording amendment** (§8.1/§15/§20): identity-level delegation ("key K may sign for O") is the binding `scope` (§7.1), NOT an in-toto authorization statement. The program doc lands this amendment against the TEP spec — **not a code change here**.

## Addendum 2026-07-29-a — scope extension grammar (program §7.45)

Design §7.1's `scope` vocabulary permits namespaced extensions. That phrase now carries the
stack's TEP §21.3 grammar: reverse-DNS names or absolute URIs. `ScopeSchema` keeps
`deliveries`, `verdicts`, `observations`, `authorizations`, and `bindings`, while also accepting
valid extension names such as
`https://jinn.network/trust-scopes/admission-receipts/1.0` and the existing `jinn:...`
absolute-URI form. Relative/bare strings, malformed URI authority/scheme, whitespace/control
characters, and malformed reverse-DNS labels remain invalid. A real KeyBinding
seal/parse/verify fixture carries the admission-receipt scope so downstream receipt verification
cannot be proven only against an impossible hand-built resolver value.
- **Scheme-IRI registration** (did:pkh / did:key / CAIP-19 / GitHub `identifier` `propertyID` IRIs) — ONE shared follow-up across TEP §28 / profiles §17 / trust §20; program doc tracks it once.
- **Media-type IANA registration** for `application/vnd.jinn.trust.*` — recorded non-blocking follow-up (brief mandate 4). Vendor-tree names used as-is now.
- Non-goals per design §19: reputation scoring, Sybil/challenge/evaluator economics (Phase B.2), accreditation ecosystems, DID resolution infrastructure, VC issuance, key-custody/HSM guidance.

---

## Self-review notes

- **Spec coverage:** §5 (T3), §7.1 (T4), §7.2/§7.2a (T8, T12), §7.3 (T13), §7.4 (T5, T9), §7.5/§7.5a/§7.5b (T9), §8.1 (T6), §8.3 grant schema (T6, resolution is out-of-scope), §9 (T7), §16 fixtures (T4–T16), §17 package split (T1–T16), §18 steps 1–2 (all). §8.2 / §18 3–8 explicitly out-of-scope with pointers.
- **Sealing precedent:** raw RFC 8785 JCS (no indent/newline, §7.1) with explicit sorted-key iteration + integer-like-key reference case (§7.14) in `canonical-json.ts` (T2); per-package `order.ts` (T2); pinned-digest goldens per family (T2, T4–T7); key-order-sensitive **canonical-byte** cross-impl equivalence vs `task-execution-protocol` (T17); against `evidence-protocol` only DSSE PAE + `recordDigest` algorithm agreement (T10, §7.15). Locale ban delivered by the guard clone (T1).
- **Guard clone lands with the first package** (T1) and is extended, not re-cloned, per package (T10 Step 3, T11 Step 3). Counts computed; `TRUST_PACKAGES.length` assertion bumped as packages land.
- **Acyclic graph:** `resolve → core`, `testing → core + resolve (+ devDep evidence-protocol / gated task-execution-protocol)`. Nothing imports back into `core`; `core` imports nothing Jinn. Guards encode this.
