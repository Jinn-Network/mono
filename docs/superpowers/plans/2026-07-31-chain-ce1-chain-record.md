# CE1 — Chain Environment Record Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship `@jinn-network/chain-environment-record` — the sealed, tier-2 package that defines **two** record kinds: `chain-environment/1.0` (the sandboxed chain world) and `crypto-environment/1.0` (the composite a task references) — with locally re-implemented sealing, the port **type** declarations `ChainMaterializer` / `ProbeExecutor` / `ScriptReplayer` (so CE3's four consumers depend on contracts without depending on CE3), golden + adversarial fixtures, a `./testing` conformance kit, two published JSON Schemas, a discovery facts leaf carrying both kinds, and registration in the **existing** `packages/environments/` guard trio and CI.

**Architecture:** one chain record = one `(runtime, source anchor, state materialization, fixtures, determinism controls, capability envelope, verification contract)` binding; one composite = one `(chainWorld, informationWorlds[], serviceRuntimes[], composition)` binding. Both are I-JSON documents canonicalized under RFC 8785 JCS **once**, with the sha256 of those exact bytes as identity, `sha256:`-prefixed in record bodies. The package is pure — zod + `@noble/hashes` only, no ports, no filesystem outside the fixture loaders in the testing region. Sealing is re-implemented in-package (the primitive files are materialized byte-for-byte from the merged sibling `packages/environments/record`, never imported from it) and equivalence is proven by test-only fixtures against three independent oracles: the SWE record package, the evidence tree's `recordDigest`, and the `canonicalize` reference implementation. The record **describes** a world; it never asserts the world works — every behavior claim lives in CE3's separately published attestations.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained per-package project, `portal:` resolution for cross-tree devDependencies); zod 4.4.3; `@noble/hashes` ^2.2.0; vitest ^4.1.8; ajv 8.17.1 + canonicalize ^2.0.0 (dev only).

---

## Global constraints

Copied verbatim from the program plan (`2026-07-31-chain-environment-program.md` §4) where they bind this component; the values are law, not defaults.

1. **Designs are law**; defects are findings with dispositions.
2. **Kits and fixtures precede implementations**; a layer's kit is green before dependents build.
3. **Sealing is re-implemented per package** with cross-package equivalence fixtures — never shared runtime sealing code.
4. **Custody law** — no key material, no ambient authority (incl. no ambient `fetch`, no ambient Docker), everything injected, fail closed.
5. **No product names in tiers 1–3**; never import the frozen trio or `client/`.
6. **Digest discipline:** record bodies `sha256:`-prefixed; in-toto DigestSet subjects bare hex; every producing package's kit carries the confusion fixture.
7. **Bounded claims** (design D11/E5/E15): no API, log line, or doc says "deterministic", "verified", or "authenticated against mainnet" without the qualification the design gives those words. `closed-reproducible` means exactly what §5.3 says.
8. **Fixture keys are freshly generated per record, never reused** (design §8); no test or fixture may reuse a key across records, and none may be a well-known dev mnemonic address that someone might fund.
9. **Register in the existing tree guards in the same PR** — inventory row + dependency graph, boundary sweep, packed-types entrypoints, CI job.
10. **TDD per task; verification before completion** — typecheck, tests, kit, guards run locally with output shown before any task is reported done.
11. **Stop on missing Consumes** — a symbol not on the base branch is a stop-and-report.
12. **Docker-dependent tests are opt-in and skip cleanly** without a daemon; the kits run against fakes.

Additional constraints specific to this component:

- Branch: `chain/ce1-chain-record`, based on `origin/integration/evidence-v1`. It is the base of `chain/ce3-chain-verification` and `chain/ce6-information-world`.
- **Pinned interface (program §3, "CE1 produces").** These exact names and signatures are the cross-component contract; renaming one is a program-plan amendment:
  - `ChainEnvironmentRecord`, `CryptoEnvironmentRecord`
  - `sealChainEnvironmentRecord(record: unknown): Uint8Array`
  - `sealCryptoEnvironmentRecord(record: unknown): Uint8Array`
  - `parseChainEnvironmentRecord(bytes: Uint8Array): ChainEnvironmentRecord`
  - `parseCryptoEnvironmentRecord(bytes: Uint8Array): CryptoEnvironmentRecord`
  - ``chainEnvironmentRecordDigest(bytes: Uint8Array): `sha256:${string}` ``
  - ``cryptoEnvironmentRecordDigest(bytes: Uint8Array): `sha256:${string}` ``
  - ``bareHexDigest(digest: `sha256:${string}`): string``
  - `CHAIN_ENVIRONMENT_KIND`, `CHAIN_ENVIRONMENT_MEDIA_TYPE`, `CRYPTO_ENVIRONMENT_KIND`, `CRYPTO_ENVIRONMENT_MEDIA_TYPE`
  - port **types** `ChainMaterializer`, `ProbeExecutor`, `ScriptReplayer`
  - fixtures + `./testing` kit; facts profiles (`chainEnvironmentFactsProfile`, `cryptoEnvironmentFactsProfile`)
- Node `>=22`; package `"type": "module"`; every relative import carries the `.js` extension.
- **No `localeCompare`, no `Intl`** anywhere in production source under `packages/environments/` — the tree's existing source-boundary canary fails the build. Use `compareCodeUnitStrings`.
- The root entrypoint (`src/index.ts`) must never re-export `testing.ts` or `fixtures.ts`.
- **`@jinn-network/environment-record` is a testing-region devDependency only.** The chain kind is a *sibling* of the SWE kind, never an extension of it; a production import would make it one. Task 16's guard enforces this.
- **This package declares no `CanonicalChainObservation*` type.** That schema is pinned to CE2 (program §3). CE1's `ProbeExecutor` is generic over the observation type so CE2/CE3 instantiate it without CE1 owning it.

## Package and file layout

All paths under `packages/environments/chain-record/` unless stated otherwise.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md` | package scaffold |
| `src/order.ts`, `src/json.ts`, `src/canonical.ts`, `src/sealing.ts`, `src/extensions.ts` | sealing primitives, materialized byte-for-byte from the sibling package |
| `src/hashing.ts` | `sha256Hex`, `sealedRecordDigest`, `chainEnvironmentRecordDigest`, `cryptoEnvironmentRecordDigest`, `bareHexDigest`, `prefixedDigest` |
| `src/identifiers.ts` | the two kind URIs, media types, schema `$id`s, `BLACKHOLE_EGRESS_POLICY_ID` |
| `src/primitives.ts` | `PrefixedSha256`, `BareSha256Hex`, `Bytes32`, `Address`, `Quantity`, `Caip2ChainId`, `Count`, `ResourceDescriptorSchema`, `DigestPinnedDescriptorSchema` |
| `src/runtime.ts` | `ChainRuntimeSchema` (family, exact version, digest-qualified image, binary, EVM semantics, launch config) |
| `src/anchor.ts` | `ChainSourceAnchorSchema`, `anchorAuthenticityBound` (E5) |
| `src/state.ts` | `ChainStateMaterializationSchema` + the E13 coverage arithmetic |
| `src/dev-addresses.ts` | `WELL_KNOWN_DEV_ADDRESSES`, `isWellKnownDevAddress` (contract 8) |
| `src/fixture-modules.ts` | `ChainFixturesSchema` — ordered digest-pinned modules + fixture accounts |
| `src/determinism.ts` | `DeterminismControlsSchema` — the full §4.3 knob list |
| `src/envelope.ts` | `CapabilityEnvelopeSchema` |
| `src/verification-contract.ts` | `VerificationContractSchema` (K ≥ 5, per-module probe coverage) |
| `src/chain-record.ts` | `ChainEnvironmentRecordSchema` + cross-block invariants; seal/parse |
| `src/composite.ts` | `CryptoEnvironmentRecordSchema` + routing/precedence invariants; seal/parse |
| `src/ports.ts` | `ChainMaterializer`, `ProbeExecutor<Observation>`, `ScriptReplayer` type declarations |
| `src/solution.ts` | `ChainSolutionScriptSchema`, `CHAIN_SOLUTION_MEDIA_TYPE` (the replayer's input type) |
| `src/index.ts` | public surface |
| `src/fixtures.ts` | fixture loaders (the only `node:fs/promises` user) |
| `src/testing.ts` | `describeChainEnvironmentRecordConformance` (the kit) |
| `fixtures/chain/*`, `fixtures/composite/*` | goldens + `.sha256` pins + `invalid-*.json` |
| `fixtures/equivalence/*` | key-permuted twins + expected digest |
| `fixtures/adversarial-v1/*` | adversarial corpus + `manifest.json` |
| `schemas/chain-environment.schema.json`, `schemas/crypto-environment.schema.json` | published JSON Schemas (generated) |
| `scripts/build.mjs`, `generate-fixtures.mjs`, `generate-schemas.mjs`, `pack-smoke.mjs` | build, fixture/schema generation + drift check, tarball smoke |

Sibling package: `packages/discovery/facts/chain-environments/` (Task 17).

Repo files this plan edits (never creates — the tree is open):

- Modify: `.github/scripts/environments-package-inventory.test.mjs`, `.github/scripts/environments-source-boundaries.test.mjs`, `.github/scripts/environments-packed-types.test.mjs`, `.github/workflows/environments-ci.yml`
- Modify: `.github/scripts/record-discovery-package-inventory.test.mjs`, `.github/scripts/record-discovery-source-boundaries.test.mjs`, `.github/scripts/record-discovery-packed-types.test.mjs`, `.github/workflows/record-discovery-ci.yml`

---

### Task 1: Branch, package scaffold, and inventory-guard registration

**Files:**
- Modify: `.github/scripts/environments-package-inventory.test.mjs`
- Create: `packages/environments/chain-record/package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md`, `scripts/build.mjs`, `src/index.ts`

**Interfaces:**
- Consumes, from `origin/integration/evidence-v1`: the existing tree `packages/environments/` with its guard trio (`environments-package-inventory.test.mjs`, `environments-source-boundaries.test.mjs`, `environments-packed-types.test.mjs`) and `.github/workflows/environments-ci.yml`. **Verify all four exist before starting**; a missing one is a stop-and-report (the tree is supposed to be open — do not re-scaffold it).
- Produces: the package directory `packages/environments/chain-record` publishing `@jinn-network/chain-environment-record` with exports `.`, `./testing`, `./schemas/*`, `./fixtures/*`.

- [ ] **Step 1: Create the branch and confirm the tree is already open**

```bash
git fetch origin
git checkout -b chain/ce1-chain-record origin/integration/evidence-v1
ls packages/environments
ls .github/scripts/environments-*.test.mjs .github/workflows/environments-ci.yml
```

Expected: `packages/environments` lists `record` and `verification`; all four guard/CI files exist; `packages/environments/chain-record` does **not** exist. Any deviation is a stop-and-report.

- [ ] **Step 2: Add the inventory row so the guard fails**

In `.github/scripts/environments-package-inventory.test.mjs`, extend `ENVIRONMENT_PACKAGES`:

```js
const ENVIRONMENT_PACKAGES = [
  ['record', '@jinn-network/environment-record'],
  ['verification', '@jinn-network/environment-verification'],
  ['chain-record', '@jinn-network/chain-environment-record'],
];
```

and add the graph entry to `JINN_DEPENDENCY_GRAPH`:

```js
  // `chain-record` is tier 2 and depends on NO Jinn package at runtime (design §3: zod +
  // noble-class primitives only). Two test-only devDependencies carry the cross-package
  // seal-equivalence legs (program §4 contract 3): `environment-record` is the SWE sibling
  // this package's primitives were materialized from, and `evidence-protocol` is the
  // evidence tree's own digest spelling. The chain kind is a SIBLING of the SWE kind, never
  // an extension of it, so a production import of either is a boundary failure.
  ['chain-record', {
    dependencies: [],
    devDependencies: ['@jinn-network/environment-record', '@jinn-network/evidence-protocol'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
```

and extend the export-map expectation in the third test:

```js
  const expectedExports = new Map([
    ['record', ['.', './fixtures/*', './schemas/*', './testing']],
    ['verification', ['.', './fixtures/*', './testing']],
    ['chain-record', ['.', './fixtures/*', './schemas/*', './testing']],
  ]);
```

- [ ] **Step 3: Run the guard and watch it fail**

```bash
node --test .github/scripts/environments-package-inventory.test.mjs
```

Expected failure: `missing package manifest: .../packages/environments/chain-record/package.json`.

- [ ] **Step 4: Write the package scaffold**

`packages/environments/chain-record/package.json`:

```json
{
  "name": "@jinn-network/chain-environment-record",
  "version": "0.1.0",
  "description": "The sealed chain-environment and crypto-environment record kinds: a sandboxed chain world, and the composite of worlds a task references.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/environments/chain-record"
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
    "@jinn-network/environment-record": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@types/node": "^22.0.0",
    "ajv": "8.17.1",
    "canonicalize": "^2.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/environment-record": "portal:../record",
    "@jinn-network/evidence-protocol": "portal:../../evidence/protocol"
  }
}
```

Copy the four config files from the sibling — they are identical and copying removes transcription risk:

```bash
mkdir -p packages/environments/chain-record/src packages/environments/chain-record/scripts
cp packages/environments/record/tsconfig.json          packages/environments/chain-record/tsconfig.json
cp packages/environments/record/tsconfig.build.json    packages/environments/chain-record/tsconfig.build.json
cp packages/environments/record/.yarnrc.yml            packages/environments/chain-record/.yarnrc.yml
cp packages/environments/record/vitest.config.ts       packages/environments/chain-record/vitest.config.ts
cp packages/environments/record/scripts/build.mjs      packages/environments/chain-record/scripts/build.mjs
```

`src/index.ts` (a placeholder-free stub the scaffold can compile; every later task extends it):

```ts
// Public surface of @jinn-network/chain-environment-record.
export {};
```

`README.md`:

```md
# @jinn-network/chain-environment-record

Two sealed record kinds:

- `https://jinn.network/records/chain-environment/1.0` — one sandboxed chain world: a pinned
  simulator runtime, an optional source anchor, a state materialization with its closure and
  fidelity classes, ordered digest-pinned fixtures, the determinism controls, the agent-facing
  capability envelope, and the verification contract.
- `https://jinn.network/records/crypto-environment/1.0` — the composite a task references: one
  chain world, zero or more information worlds, pinned service runtimes, and the composition
  block that binds origin routing, precedence, the miss policy, the endpoint allowlist, and the
  request budget.

Both are sealed once: I-JSON, RFC 8785 JCS applied exactly once, sha256 over those exact bytes
as identity, `sha256:`-prefixed in record bodies. Both are unsigned — attribution arrives through
signed discovery announcements and through attestations, never at the record layer.

These documents state what a world **is**. They make no claim that any world works, reproduces,
or corresponds to a public chain beyond the fidelity class they declare; those claims live in
separately published attestations and are bounded there.

The boundary of a sealed world is the committed slice. A `closed-state` instance has no fork
backend at all, so state outside that slice does not error — it reads as empty, the same way on
every run. What the slice bounds is fidelity, not repeatability: an execution path that wanders
outside it meets empty accounts. A record never says "Ethereum mainnet at block N" when it
contains a slice; it says exactly what the slice holds, and the coverage census says how much
of that is proven against the declared anchor root versus declared as fixture content.

This package has no Jinn runtime dependency and holds no ports. Sealing is re-implemented here
rather than imported; cross-package equivalence is proven by test-only fixtures.
```

- [ ] **Step 5: Install, build, and re-run the guard**

```bash
cd packages/environments/chain-record && yarn install && yarn typecheck && yarn build && cd -
node --test .github/scripts/environments-package-inventory.test.mjs
```

Expected: `yarn typecheck` exits 0, `dist/index.js` exists, and all three inventory tests pass.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/environments-package-inventory.test.mjs packages/environments/chain-record
git commit -m "feat(chain-record): scaffold the chain-environment record package and register it in the environments inventory guard"
```

---

### Task 2: Sealing primitives and cross-package equivalence

**Files:**
- Create: `packages/environments/chain-record/src/order.ts`, `src/json.ts`, `src/canonical.ts`, `src/sealing.ts`, `src/extensions.ts`, `src/hashing.ts`
- Create: `packages/environments/chain-record/src/canonical.test.ts`, `src/hashing.test.ts`, `src/equivalence.test.ts`

**Interfaces:**
- Consumes, from `origin/integration/evidence-v1`: `packages/environments/record/src/{order,json,canonical,sealing,extensions}.ts` as **source text to materialize**, and — test-only — `serializeCanonicalJson` from `@jinn-network/environment-record` and `recordDigest` from `@jinn-network/evidence-protocol`. **Verify both symbols are exported before writing `equivalence.test.ts`**; a missing one is a stop-and-report.
- Produces: `compareCodeUnitStrings`, `JsonValue`, `assertIJsonString`, `assertIJsonStrings`, `assertIJsonInteger`, `IJsonNumberError`, `IJsonStringError`, `UndefinedArrayElementError`, `serializeCanonicalJson`, `InvalidDocumentError`, `ValidationIssue`, `sealWithSchema`, `parseExactWithSchema`, `isNamespacedExtensionKey`, `topLevelRecordSchema`, `sha256Hex`, ``sealedRecordDigest(bytes): `sha256:${string}` ``, ``bareHexDigest(digest: `sha256:${string}`): string``, ``prefixedDigest(bare: string): `sha256:${string}` ``.

The five primitive files are materialized **byte-for-byte** from the merged sibling. That is not an import and not shared runtime code — it is the per-package re-implementation the house law requires, done in the one way that cannot drift by transcription error. `hashing.ts` is the only primitive this package writes fresh, because its exported names are kind-specific and it gains `prefixedDigest`.

- [ ] **Step 1: Write the failing equivalence test**

`src/equivalence.test.ts`:

```ts
// Cross-package seal-equivalence leg (program §4 contract 3). This package re-implements
// sealing locally and never imports shared runtime sealing code; equivalence is proven here,
// in a test file, against three independent oracles:
//   1. `@jinn-network/environment-record` — the SWE sibling whose primitives this package
//      materialized, so a future edit to either copy is caught immediately;
//   2. `@jinn-network/evidence-protocol`'s `recordDigest` — the evidence tree's digest spelling;
//   3. `canonicalize` — an independent RFC 8785 JCS implementation.
// The source-boundary guard forbids all three imports from production source.
import { serializeCanonicalJson as sweSerialize } from "@jinn-network/environment-record";
import { recordDigest as evidenceRecordDigest } from "@jinn-network/evidence-protocol";
import canonicalize from "canonicalize";
import { describe, expect, test } from "vitest";

import { serializeCanonicalJson } from "./canonical.js";
import { sealedRecordDigest } from "./hashing.js";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const shared = {
  kind: "https://jinn.network/records/chain-environment/1.0",
  runtime: {
    family: "anvil",
    version: "1.3.7",
    image: { manifestDigest: `sha256:${"a".repeat(64)}`, platform: "linux/amd64" },
  },
  determinismControls: { miningMode: "manual", initialBlockNumber: 21000000 },
};

const permuted = {
  determinismControls: {
    initialBlockNumber: shared.determinismControls.initialBlockNumber,
    miningMode: shared.determinismControls.miningMode,
  },
  runtime: {
    image: { platform: shared.runtime.image.platform, manifestDigest: shared.runtime.image.manifestDigest },
    version: shared.runtime.version,
    family: shared.runtime.family,
  },
  kind: shared.kind,
};

describe("cross-package seal equivalence", () => {
  test("our JCS bytes equal the RFC 8785 reference implementation's, whatever the key order", () => {
    expect(decode(serializeCanonicalJson(shared))).toBe(canonicalize(shared));
    expect(decode(serializeCanonicalJson(permuted))).toBe(canonicalize(shared));
  });

  test("our JCS bytes equal the SWE sibling's over identical input", () => {
    expect(decode(serializeCanonicalJson(shared))).toBe(decode(sweSerialize(shared)));
    expect(decode(serializeCanonicalJson(permuted))).toBe(decode(sweSerialize(shared)));
  });

  test("our digest spelling equals the evidence tree's over identical bytes", () => {
    const bytes = serializeCanonicalJson(shared);
    expect(sealedRecordDigest(bytes)).toBe(evidenceRecordDigest(bytes));
  });

  test("the digest is over the sealed bytes, not over a re-serialization", () => {
    const bytes = serializeCanonicalJson(shared);
    const pretty = new TextEncoder().encode(JSON.stringify(shared, null, 2));
    expect(sealedRecordDigest(pretty)).not.toBe(sealedRecordDigest(bytes));
  });
});
```

`src/hashing.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { bareHexDigest, prefixedDigest, sealedRecordDigest, sha256Hex } from "./hashing.js";

const bytes = new TextEncoder().encode('{"kind":"x"}');

describe("digest spellings", () => {
  test("a record-body digest is sha256:-prefixed lowercase hex", () => {
    expect(sealedRecordDigest(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("bareHexDigest yields the in-toto DigestSet spelling and round-trips", () => {
    const digest = sealedRecordDigest(bytes);
    const bare = bareHexDigest(digest);
    expect(bare).toMatch(/^[0-9a-f]{64}$/);
    expect(bare.startsWith("sha256:")).toBe(false);
    expect(prefixedDigest(bare)).toBe(digest);
  });

  test("bareHexDigest refuses an already-bare value rather than passing it through", () => {
    const bare = bareHexDigest(sealedRecordDigest(bytes));
    expect(() => bareHexDigest(bare as never)).toThrow();
  });

  test("prefixedDigest refuses an already-prefixed value rather than double-prefixing", () => {
    expect(() => prefixedDigest(sealedRecordDigest(bytes))).toThrow();
  });

  test("prefixedDigest refuses uppercase hex: canonical bytes admit one spelling", () => {
    expect(() => prefixedDigest("A".repeat(64))).toThrow();
  });
});
```

`src/canonical.test.ts` — materialize the sibling's canonicalizer test, which pins the JCS
edge cases (`__proto__`, unpaired surrogates, unsafe integers, undefined array elements):

```bash
git show origin/integration/evidence-v1:packages/environments/record/src/canonical.test.ts \
  > packages/environments/chain-record/src/canonical.test.ts
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/environments/chain-record && yarn test
```

Expected failure: `Failed to resolve import "./canonical.js"` / `"./hashing.js"` — the modules do not exist yet.

- [ ] **Step 3: Materialize the five primitives and write `hashing.ts`**

```bash
cd "$(git rev-parse --show-toplevel)"
for f in order json canonical sealing extensions; do
  git show "origin/integration/evidence-v1:packages/environments/record/src/$f.ts" \
    > "packages/environments/chain-record/src/$f.ts"
done
diff -u packages/environments/record/src/order.ts packages/environments/chain-record/src/order.ts && echo "order.ts identical"
```

Expected: `diff` reports no differences for each of the five.

`src/hashing.ts` (written fresh — kind-specific names plus the prefixed/bare inverse pair):

```ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { InvalidDocumentError } from "./sealing.js";

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * The identity of any sealed record in this package: sha256 over the exact sealed bytes,
 * written with the `sha256:` prefix every digest in a record *body* carries (§4.1).
 */
export function sealedRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}

/** The chain-environment record's identity (program §3 pinned name). */
export function chainEnvironmentRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return sealedRecordDigest(bytes);
}

/** The composite crypto-environment record's identity (program §3 pinned name). */
export function cryptoEnvironmentRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return sealedRecordDigest(bytes);
}

/**
 * The same digest as an in-toto DigestSet value: **bare lowercase hex, no prefix** (§5.3).
 * A prefixed value inside a DigestSet is non-conformant, and this is the one conversion
 * point — attestation subject builders call this rather than slicing strings by hand.
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

/**
 * The inverse conversion: a bare DigestSet value lifted into the record-body spelling. Needed
 * because in-toto ResourceDescriptors carry bare hex while every scalar digest field in a
 * record body carries the prefix; the facts leaf and the composite both cross that seam. It
 * refuses an already-prefixed input rather than double-prefixing, which is the failure this
 * pair exists to make impossible in both directions.
 */
export function prefixedDigest(bare: string): `sha256:${string}` {
  if (!BARE_SHA256.test(bare)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "expected 64 lowercase hexadecimal digits with no algorithm prefix",
    }]);
  }
  return `sha256:${bare}`;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/environments/chain-record && yarn install && yarn typecheck && yarn test
```

Expected: all of `canonical.test.ts`, `hashing.test.ts`, `equivalence.test.ts` pass; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record
git commit -m "feat(chain-record): re-implement the sealing primitives in-package and prove equivalence against three oracles"
```

---

### Task 3: Identifiers and shared record primitives

**Files:**
- Create: `packages/environments/chain-record/src/identifiers.ts`, `src/primitives.ts`
- Create: `packages/environments/chain-record/src/identifiers.test.ts`, `src/primitives.test.ts`

**Interfaces:**
- Consumes: `InvalidDocumentError` from `./sealing.js` (Task 2). Nothing cross-package.
- Produces: `CHAIN_ENVIRONMENT_KIND`, `CHAIN_ENVIRONMENT_MEDIA_TYPE`, `CHAIN_ENVIRONMENT_SCHEMA_ID`, `CRYPTO_ENVIRONMENT_KIND`, `CRYPTO_ENVIRONMENT_MEDIA_TYPE`, `CRYPTO_ENVIRONMENT_SCHEMA_ID`, `BLACKHOLE_EGRESS_POLICY_ID`; and the schemas `PrefixedSha256`, `BareSha256Hex`, `NonEmpty`, `Bytes32`, `Address`, `Quantity`, `Caip2ChainId`, `Rfc3339Utc`, `Count`, `ExactSemanticVersion`, `RecordKindUri`, `HttpOrigin`, `ResourceDescriptorSchema`, `DigestPinnedDescriptorSchema`.

- [ ] **Step 1: Write the failing tests**

`src/identifiers.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CHAIN_ENVIRONMENT_MEDIA_TYPE,
  CHAIN_ENVIRONMENT_SCHEMA_ID,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
  CRYPTO_ENVIRONMENT_SCHEMA_ID,
} from "./identifiers.js";

describe("pinned identifiers (design §4.1, §14)", () => {
  test("the kind URIs are exactly the design's strings", () => {
    expect(CHAIN_ENVIRONMENT_KIND).toBe("https://jinn.network/records/chain-environment/1.0");
    expect(CRYPTO_ENVIRONMENT_KIND).toBe("https://jinn.network/records/crypto-environment/1.0");
  });

  test("the media types are exactly the design's strings", () => {
    expect(CHAIN_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.chain-environment.v1+json");
    expect(CRYPTO_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.crypto-environment.v1+json");
  });

  test("schema ids hang off their kind URIs", () => {
    expect(CHAIN_ENVIRONMENT_SCHEMA_ID).toBe(`${CHAIN_ENVIRONMENT_KIND}/schema`);
    expect(CRYPTO_ENVIRONMENT_SCHEMA_ID).toBe(`${CRYPTO_ENVIRONMENT_KIND}/schema`);
  });

  // Mirrored here because this package declares no Jinn dependency and so cannot call
  // discovery's own `assertRecordKindUri`; the facts leaf does that for real (Task 17).
  test("both kinds satisfy discovery's record-kind URI grammar", () => {
    for (const kind of [CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND]) {
      expect(kind).toMatch(/^https:\/\/jinn\.network\/records\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d+\.\d+$/);
    }
  });

  test("the blackhole egress policy id is a stable versioned identifier", () => {
    expect(BLACKHOLE_EGRESS_POLICY_ID).toBe("jinn.egress.blackhole/1");
  });
});
```

`src/primitives.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  Address,
  Bytes32,
  Caip2ChainId,
  Count,
  DigestPinnedDescriptorSchema,
  ExactSemanticVersion,
  HttpOrigin,
  PrefixedSha256,
  Quantity,
  ResourceDescriptorSchema,
} from "./primitives.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("record-body primitives", () => {
  test("a record-body digest carries the sha256: prefix and nothing else", () => {
    expect(ok(PrefixedSha256, `sha256:${"a".repeat(64)}`)).toBe(true);
    expect(ok(PrefixedSha256, "a".repeat(64))).toBe(false);
    expect(ok(PrefixedSha256, `sha256:${"A".repeat(64)}`)).toBe(false);
  });

  test("32-byte words are 0x + 64 lowercase hex; mixed case is a second spelling of one value", () => {
    expect(ok(Bytes32, `0x${"b".repeat(64)}`)).toBe(true);
    expect(ok(Bytes32, `0x${"B".repeat(64)}`)).toBe(false);
    expect(ok(Bytes32, "b".repeat(64))).toBe(false);
  });

  test("addresses are lowercase; an EIP-55 checksummed spelling is refused", () => {
    expect(ok(Address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(true);
    expect(ok(Address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(false);
    expect(ok(Address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226")).toBe(false);
  });

  test("wei- and gas-denominated quantities are unsigned decimal STRINGS, not numbers", () => {
    expect(ok(Quantity, "1000000000000000000")).toBe(true);
    expect(ok(Quantity, "0")).toBe(true);
    expect(ok(Quantity, "01")).toBe(false);
    expect(ok(Quantity, "-1")).toBe(false);
    expect(ok(Quantity, 1_000_000)).toBe(false);
  });

  test("CAIP-2 chain ids parse; a bare decimal chain id does not", () => {
    expect(ok(Caip2ChainId, "eip155:1")).toBe(true);
    expect(ok(Caip2ChainId, "eip155:8453")).toBe(true);
    expect(ok(Caip2ChainId, "1")).toBe(false);
  });

  test("counts are non-negative safe integers", () => {
    expect(ok(Count, 0)).toBe(true);
    expect(ok(Count, 12)).toBe(true);
    expect(ok(Count, -1)).toBe(false);
    expect(ok(Count, 1.5)).toBe(false);
  });

  test("a runtime version is exact; ranges and `latest` are refused", () => {
    expect(ok(ExactSemanticVersion, "1.3.7")).toBe(true);
    expect(ok(ExactSemanticVersion, "1.3.7-nightly.20260701")).toBe(true);
    expect(ok(ExactSemanticVersion, "latest")).toBe(false);
    expect(ok(ExactSemanticVersion, "^1.3.7")).toBe(false);
    expect(ok(ExactSemanticVersion, "1.3")).toBe(false);
  });

  test("an origin is scheme + lowercase host + optional port, with no path", () => {
    expect(ok(HttpOrigin, "https://api.llama.fi")).toBe(true);
    expect(ok(HttpOrigin, "http://localhost:8080")).toBe(true);
    expect(ok(HttpOrigin, "https://API.Llama.fi")).toBe(false);
    expect(ok(HttpOrigin, "https://api.llama.fi/")).toBe(false);
    expect(ok(HttpOrigin, "https://api.llama.fi/v2/pools")).toBe(false);
  });
});

describe("ResourceDescriptor", () => {
  test("in-toto DigestSet values are BARE hex — the prefixed spelling is refused", () => {
    expect(ok(ResourceDescriptorSchema, { uri: "x", digest: { sha256: "a".repeat(64) } })).toBe(true);
    expect(ok(ResourceDescriptorSchema, { uri: "x", digest: { sha256: `sha256:${"a".repeat(64)}` } })).toBe(false);
  });

  test("a descriptor needs at least one of uri/digest", () => {
    expect(ok(ResourceDescriptorSchema, { name: "state" })).toBe(false);
  });

  test("unknown members round-trip: in-toto declares the descriptor extensible", () => {
    expect(ok(ResourceDescriptorSchema, { uri: "x", content: "ignored-by-us" })).toBe(true);
  });

  test("a digest-pinned reference requires digest.sha256 — a uri alone is a locator", () => {
    expect(ok(DigestPinnedDescriptorSchema, { uri: "https://example.test/state.tar" })).toBe(false);
    expect(ok(DigestPinnedDescriptorSchema, { digest: { sha256: "c".repeat(64) } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/environments/chain-record && yarn test src/identifiers.test.ts src/primitives.test.ts
```

Expected failure: `Failed to resolve import "./identifiers.js"` and `"./primitives.js"`.

- [ ] **Step 3: Write the implementation**

`src/identifiers.ts`:

```ts
/**
 * Record-kind URIs (§4.1). The grammar
 * `https://jinn.network/records/<segment>/<major>.<minor>` is discovery's; this package
 * declares no Jinn dependency, so the grammar is mirrored in `identifiers.test.ts` and
 * checked for real against discovery's own `assertRecordKindUri` in the facts leaf.
 */
export const CHAIN_ENVIRONMENT_KIND =
  "https://jinn.network/records/chain-environment/1.0" as const;

export const CRYPTO_ENVIRONMENT_KIND =
  "https://jinn.network/records/crypto-environment/1.0" as const;

/** Media types (§4.1, §14): vendor tree, one major per record version. */
export const CHAIN_ENVIRONMENT_MEDIA_TYPE =
  "application/vnd.jinn.chain-environment.v1+json" as const;

export const CRYPTO_ENVIRONMENT_MEDIA_TYPE =
  "application/vnd.jinn.crypto-environment.v1+json" as const;

/** `$id`s of the published JSON Schemas shipped at the `./schemas/*` subpath. */
export const CHAIN_ENVIRONMENT_SCHEMA_ID = `${CHAIN_ENVIRONMENT_KIND}/schema` as const;
export const CRYPTO_ENVIRONMENT_SCHEMA_ID = `${CRYPTO_ENVIRONMENT_KIND}/schema` as const;

/**
 * The egress policy a `closed-state` world declares: every outbound interface is dead at run
 * time (§4.2, §5.1 step 2). It is an identifier the record commits to, not an implementation —
 * enforcing it is the runner's job and probing it is the attestation layer's.
 */
export const BLACKHOLE_EGRESS_POLICY_ID = "jinn.egress.blackhole/1" as const;
```

`src/primitives.ts`:

```ts
import { z } from "zod";

/**
 * Every digest in a record *body* is `sha256:`-prefixed lowercase hex (§4.1). In-toto
 * DigestSet values, by contrast, are bare hex — see `BareSha256Hex` below and the
 * `bareHexDigest` / `prefixedDigest` pair in hashing.ts.
 */
export const PrefixedSha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "record-body digests are sha256:<64 lowercase hex> (§4.1)");

export const BareSha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "in-toto DigestSet values are 64 lowercase hexadecimal digits");

export const NonEmpty = z.string().min(1);

/**
 * A 32-byte EVM word — state root, block hash, genesis hash, `prevrandao`, or a
 * materializer's state commitment — as `0x` + 64 **lowercase** hex digits. Lowercase only:
 * two spellings of one word would seal to two different byte strings and therefore to two
 * different records.
 */
export const Bytes32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "expected 0x followed by 64 lowercase hexadecimal digits");

/**
 * An EVM address as `0x` + 40 lowercase hex digits. An EIP-55 checksummed spelling is refused
 * for the same reason `Bytes32` refuses mixed case: the sealed bytes admit exactly one
 * spelling of any value.
 */
export const Address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "addresses are 0x followed by 40 lowercase hexadecimal digits");

/**
 * An unsigned 256-bit quantity as a decimal string with no leading zeros. Wei and gas
 * quantities exceed `Number.MAX_SAFE_INTEGER` (one ether is 10^18 wei) and the sealed document
 * admits only exact I-JSON integers, so every such field is a string.
 */
export const Quantity = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "quantities are unsigned decimal strings with no leading zeros");

/** CAIP-2 chain identity, e.g. `eip155:1` (§10, adopted directly). */
export const Caip2ChainId = z
  .string()
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "expected a CAIP-2 chain id, e.g. eip155:1");

/** RFC 3339 timestamp in UTC, `Z`-terminated. */
export const Rfc3339Utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "expected an RFC 3339 UTC timestamp");

/** A non-negative exact I-JSON integer. */
export const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * An exact semantic version. `latest`, a range, and a two-part version are all refused: §4.3
 * requires the runtime version to be exact, and any change to it is a new record.
 */
export const ExactSemanticVersion = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "expected an exact semantic version; `latest` and ranges are refused (§4.3)",
  );

/** The house record-kind URI grammar, mirrored (this package has no discovery dependency). */
export const RecordKindUri = z
  .string()
  .regex(
    /^https:\/\/jinn\.network\/records\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d+\.\d+$/,
    "expected https://jinn.network/records/<segment>/<major>.<minor>",
  );

/**
 * An HTTP origin in canonical form: scheme, lowercase host, optional port — no path, no
 * trailing slash, no query. Routing collisions are decided by string equality on this value
 * (§4.4), so two spellings of one origin would silently defeat the precedence rule.
 */
export const HttpOrigin = z
  .string()
  .regex(
    /^https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/,
    "expected a canonical origin: scheme + lowercase host + optional port, no path",
  );

/**
 * in-toto v1 ResourceDescriptor shape, structurally mirrored (no cross-package import), and
 * open on purpose: in-toto declares this object extensible, so a bare member here is a
 * descriptor field this mirror does not name, not a smuggled core field. Every top-level
 * record key still obeys the namespacing rule.
 *
 * Note the digest spelling: DigestSet values are **bare** hex here, while scalar digest fields
 * elsewhere in a record body are `sha256:`-prefixed. That is the seam `bareHexDigest` and
 * `prefixedDigest` exist to cross, and the adversarial corpus pins both directions.
 */
export const ResourceDescriptorSchema = z
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

/**
 * A reference whose bytes are part of the world: `digest.sha256` is mandatory, because for
 * these references the digest is identity and the URI is only a locator (§4.1). Every
 * byte-bearing dependency of a chain record uses this, never the bare descriptor.
 */
export const DigestPinnedDescriptorSchema = ResourceDescriptorSchema.refine(
  (descriptor) => typeof descriptor.digest?.sha256 === "string",
  { message: "this reference is digest-pinned: digest.sha256 is required, a uri is not enough" },
);
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/identifiers.test.ts src/primitives.test.ts
```

Expected: both suites pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): pin the two kind identifiers and the shared record primitives"
```

---

### Task 4: The runtime block and the source anchor

**Files:**
- Create: `packages/environments/chain-record/src/runtime.ts`, `src/anchor.ts`
- Create: `packages/environments/chain-record/src/runtime.test.ts`, `src/anchor.test.ts`

**Interfaces:**
- Consumes: `PrefixedSha256`, `NonEmpty`, `Bytes32`, `Count`, `Caip2ChainId`, `ExactSemanticVersion`, `DigestPinnedDescriptorSchema` from `./primitives.js` (Task 3).
- Produces: `RUNTIME_FAMILIES`, `ChainRuntimeImageSchema`, `ChainRuntimeSchema`, `ChainRuntime`; `FINALITY_POLICIES`, `ChainSourceAnchorSchema`, `ChainSourceAnchor`, `AnchorAuthenticityBound`, `anchorAuthenticityBoundOf(anchor: ChainSourceAnchor | undefined): AnchorAuthenticityBound`.

- [ ] **Step 1: Write the failing tests**

`src/runtime.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { ChainRuntimeSchema } from "./runtime.js";

const MANIFEST = `sha256:${"1".repeat(64)}`;
const INDEX = `sha256:${"2".repeat(64)}`;

const runtime = () => ({
  family: "anvil",
  version: "1.3.7",
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `registry.example.test/chain/anvil@${MANIFEST}`,
    indexDigest: INDEX,
  },
  binary: { name: "anvil", digest: `sha256:${"3".repeat(64)}`, version: "1.3.7" },
  evm: {
    hardfork: "cancun",
    sandboxChainId: 1,
    nonDefaultSettings: { "disable-block-gas-limit": false, "memory-limit": "33554432" },
  },
  launch: {
    options: { "no-mining": true, "steps-tracing": false, "order": "fifo" },
    commandEvidence: "anvil --no-mining --order fifo",
  },
});

describe("runtime block (§4.3)", () => {
  test("accepts a fully pinned anvil runtime", () => {
    expect(ChainRuntimeSchema.safeParse(runtime()).success).toBe(true);
  });

  test("refuses a version that is not exact", () => {
    expect(ChainRuntimeSchema.safeParse({ ...runtime(), version: "latest" }).success).toBe(false);
    expect(ChainRuntimeSchema.safeParse({ ...runtime(), version: "^1.3.7" }).success).toBe(false);
  });

  test("refuses an unknown runtime family: `anvil` is the only v1 adapter", () => {
    expect(ChainRuntimeSchema.safeParse({ ...runtime(), family: "hardhat" }).success).toBe(false);
  });

  test("refuses an index digest presented as the platform manifest digest", () => {
    const document = runtime();
    document.image.indexDigest = document.image.manifestDigest;
    expect(ChainRuntimeSchema.safeParse(document).success).toBe(false);
  });

  test("refuses a bare-hex manifest digest: record bodies carry the sha256: prefix", () => {
    const document = runtime();
    document.image.manifestDigest = "1".repeat(64);
    delete (document.image as { reference?: string }).reference;
    expect(ChainRuntimeSchema.safeParse(document).success).toBe(false);
  });

  test("refuses a pull reference that does not pin this record's manifest digest", () => {
    const document = runtime();
    document.image.reference = "registry.example.test/chain/anvil:latest";
    expect(ChainRuntimeSchema.safeParse(document).success).toBe(false);
  });

  test("refuses an extra key: the launch configuration is closed, not extensible", () => {
    expect(
      ChainRuntimeSchema.safeParse({ ...runtime(), launchCommand: "anvil --fork-url ..." }).success,
    ).toBe(false);
  });

  test("the sandbox chain id is a runtime fact, and may be 1 without conferring authority", () => {
    const parsed = ChainRuntimeSchema.parse(runtime());
    expect(parsed.evm.sandboxChainId).toBe(1);
  });
});
```

`src/anchor.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { anchorAuthenticityBoundOf, ChainSourceAnchorSchema } from "./anchor.js";

const anchor = () => ({
  caip2ChainId: "eip155:1",
  nativeChainId: 1,
  genesisHash: `0x${"d".repeat(64)}`,
  blockNumber: 21_000_000,
  blockHash: `0x${"e".repeat(64)}`,
  stateRoot: `0x${"f".repeat(64)}`,
  timestamp: 1_735_689_600,
  finalityPolicy: "finalized",
});

describe("source anchor (§4.3)", () => {
  test("accepts a fully declared anchor", () => {
    expect(ChainSourceAnchorSchema.safeParse(anchor()).success).toBe(true);
  });

  test("refuses a CAIP-2 id that disagrees with the native chain id", () => {
    expect(
      ChainSourceAnchorSchema.safeParse({ ...anchor(), caip2ChainId: "eip155:8453" }).success,
    ).toBe(false);
  });

  test("accepts a confirmations-based finality policy", () => {
    expect(
      ChainSourceAnchorSchema.safeParse({ ...anchor(), finalityPolicy: "confirmations:64" }).success,
    ).toBe(true);
    expect(
      ChainSourceAnchorSchema.safeParse({ ...anchor(), finalityPolicy: "confirmations:0" }).success,
    ).toBe(false);
  });

  test("requires the block hash: it is what makes root-to-hash falsifiable from one header", () => {
    const document = anchor() as Record<string, unknown>;
    delete document.blockHash;
    expect(ChainSourceAnchorSchema.safeParse(document).success).toBe(false);
  });
});

// E5, in code. The anchor bound is a property a consumer can compute from the record alone;
// CE3 states the resulting case in the attestation rather than inferring it.
describe("the anchor-authenticity bound (E5)", () => {
  test("an anchor with no header proof binds the subset to a DECLARED root", () => {
    expect(anchorAuthenticityBoundOf(ChainSourceAnchorSchema.parse(anchor()))).toBe("declared");
  });

  test("an anchor committing a header-proof artifact is header-proven", () => {
    const withProof = ChainSourceAnchorSchema.parse({
      ...anchor(),
      headerProof: { name: "header-proof", digest: { sha256: "9".repeat(64) } },
    });
    expect(anchorAuthenticityBoundOf(withProof)).toBe("header-proven");
  });

  test("a record with no anchor claims no source correspondence at all", () => {
    expect(anchorAuthenticityBoundOf(undefined)).toBe("not-anchored");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/environments/chain-record && yarn test src/runtime.test.ts src/anchor.test.ts
```

Expected failure: `Failed to resolve import "./runtime.js"` and `"./anchor.js"`.

- [ ] **Step 3: Write the implementation**

`src/runtime.ts`:

```ts
import { z } from "zod";

import { ExactSemanticVersion, NonEmpty, PrefixedSha256 } from "./primitives.js";

/** v1 ships one runtime adapter (§10). A second family is a schema version bump. */
export const RUNTIME_FAMILIES = Object.freeze(["anvil"] as const);

/** Values a launch option or non-default EVM setting may take in a sealed document. */
const SettingValue = z.union([z.string(), z.boolean(), z.number().int()]);

/**
 * The image identity is the **platform-specific OCI manifest digest** — never the index
 * digest, never a config or layer digest. Behaviour is a per-platform fact, so one record
 * describes one platform.
 */
export const ChainRuntimeImageSchema = z
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
        message: "reference is advisory and MUST end with @<manifestDigest> (§4.3)",
      });
    }
    if (image.indexDigest !== undefined && image.indexDigest === image.manifestDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["indexDigest"],
        message:
          "indexDigest equals manifestDigest: an index digest is never its own platform "
          + "manifest digest, so one of the two is a confusion (§4.3)",
      });
    }
  });

/**
 * The pinned simulator (§4.3). Every field here is part of the world's identity: any change is
 * a new record. `evm.sandboxChainId` is the id the **sandbox** reports — deliberately named
 * apart from `sourceAnchor.nativeChainId`, because a sandbox reporting 1 for signature and
 * contract compatibility confers no mainnet authority (§4.3, §8).
 */
export const ChainRuntimeSchema = z.strictObject({
  family: z.enum(RUNTIME_FAMILIES),
  version: ExactSemanticVersion,
  image: ChainRuntimeImageSchema,
  binary: z.strictObject({
    name: NonEmpty,
    digest: PrefixedSha256,
    version: NonEmpty.optional(),
  }),
  evm: z.strictObject({
    hardfork: NonEmpty,
    sandboxChainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** Every compatibility setting that departs from the runtime's own defaults. */
    nonDefaultSettings: z.record(z.string(), SettingValue),
  }),
  launch: z.strictObject({
    /** The canonical semantic launch configuration — authoritative. */
    options: z.record(z.string(), SettingValue),
    /** A CLI string may ride as evidence; it is never the definition (§4.3). */
    commandEvidence: NonEmpty.optional(),
  }),
});

export type ChainRuntime = z.infer<typeof ChainRuntimeSchema>;
```

`src/anchor.ts`:

```ts
import { z } from "zod";

import { Bytes32, Caip2ChainId, Count, DigestPinnedDescriptorSchema } from "./primitives.js";

/** Finality observed at materialization time (§4.3). */
export const FINALITY_POLICIES = Object.freeze(["finalized", "safe", "latest"] as const);

/**
 * Where the state came from, when fidelity is not `local` (§4.3). Source-chain identity lives
 * here; sandbox execution identity lives in `runtime.evm.sandboxChainId`.
 */
export const ChainSourceAnchorSchema = z
  .strictObject({
    caip2ChainId: Caip2ChainId,
    nativeChainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    genesisHash: Bytes32,
    blockNumber: Count,
    /** Mandatory: root-to-hash is falsifiable from this single header without any extension. */
    blockHash: Bytes32,
    stateRoot: Bytes32,
    /** Unix seconds at the anchor block. */
    timestamp: Count,
    finalityPolicy: z.union([
      z.enum(FINALITY_POLICIES),
      z.string().regex(/^confirmations:[1-9][0-9]*$/, "expected confirmations:<positive integer>"),
    ]),
    /**
     * Optional artifact binding root to block hash to an accepted view of chain history. Its
     * presence is what moves the anchor bound from `declared` to `header-proven` (E5); the
     * record never carries a field asserting the conclusion.
     */
    headerProof: DigestPinnedDescriptorSchema.optional(),
  })
  .superRefine((anchor, ctx) => {
    const [namespace, reference] = anchor.caip2ChainId.split(":");
    if (namespace === "eip155" && reference !== String(anchor.nativeChainId)) {
      ctx.addIssue({
        code: "custom",
        path: ["nativeChainId"],
        message:
          "caip2ChainId and nativeChainId name two different chains; for eip155 the CAIP-2 "
          + "reference is the native chain id (§4.3)",
      });
    }
  });

export type ChainSourceAnchor = z.infer<typeof ChainSourceAnchorSchema>;

/**
 * How far the record's own contents carry the anchor claim (E5).
 *
 * - `not-anchored` — no correspondence to any public chain is claimed.
 * - `declared` — subset proofs bind the committed slice to the *declared* root; that the
 *   declared root is the canonical chain's root at that block is a declaration.
 * - `header-proven` — the record commits a header-proof artifact for that step.
 *
 * This function reads the record; it checks nothing. Whether the committed proofs actually
 * verify is a question for the attestation layer, which states the resulting case in its own
 * predicate rather than letting "anchored" stand in for it.
 */
export type AnchorAuthenticityBound = "not-anchored" | "declared" | "header-proven";

export function anchorAuthenticityBoundOf(
  anchor: ChainSourceAnchor | undefined,
): AnchorAuthenticityBound {
  if (anchor === undefined) return "not-anchored";
  return anchor.headerProof === undefined ? "declared" : "header-proven";
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/runtime.test.ts src/anchor.test.ts
```

Expected: both suites pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): add the runtime block and the source anchor with the E5 authenticity bound"
```

---

### Task 5: State materialization and the E13 coverage arithmetic

**Files:**
- Create: `packages/environments/chain-record/src/state.ts`
- Create: `packages/environments/chain-record/src/state.test.ts`

**Interfaces:**
- Consumes: `Bytes32`, `Count`, `NonEmpty`, `PrefixedSha256`, `DigestPinnedDescriptorSchema` from `./primitives.js` (Task 3).
- Produces: `CLOSURE_CLASSES`, `FIDELITY_CLASSES`, `CONSTRUCTION_METHODS`, `DURABLE_SUPPLY_CLOSURE_CLASS`, `StateEntryCountsSchema`, `StateArtifactSchema`, `SourceProofManifestSchema`, `FixtureCoverageSchema`, `ChainStateMaterializationSchema`, `ChainStateMaterialization`, `StateEntryCounts`.

E13 is the load-bearing rule here and it must be checkable from the **record alone**, not only from the artifact. The record therefore carries three entry censuses over the same three categories: what the artifact contains, what the source proofs cover, and what the fixtures declare as mutations. The schema requires the first to equal the sum of the other two. CE3 recomputes the artifact census from the artifact itself and fails `source-coverage-incomplete` on a mismatch; this schema catches the record that never even claimed full coverage, which is the cheaper half of the same check and the half a third party can run offline with no artifact at all.

- [ ] **Step 1: Write the failing tests**

`src/state.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { ChainStateMaterializationSchema } from "./state.js";

const ARTIFACT = { name: "state.json", digest: { sha256: "a".repeat(64) } };
const PROOFS = { name: "proofs.json", digest: { sha256: "b".repeat(64) } };
const MUTATIONS = { name: "mutations.json", digest: { sha256: "c".repeat(64) } };

/** closed-state + anchored-subset: the durable class the family exists to produce. */
const closedAnchored = () => ({
  closureClass: "closed-state",
  fidelityClass: "anchored-subset",
  constructionMethod: "archive-extraction",
  materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"d".repeat(64)}` },
  stateArtifact: {
    descriptor: ARTIFACT,
    format: { id: "jinn.chain-state-slice", version: "1" },
    entryCounts: { accounts: 12, storageSlots: 340, codeEntries: 7 },
  },
  sourceProofManifest: {
    proofFormat: "eip-1186",
    proofs: PROOFS,
    coverage: { accounts: 9, storageSlots: 331, codeEntries: 7 },
  },
  fixtureCoverage: {
    manifest: MUTATIONS,
    declared: { accounts: 3, storageSlots: 9, codeEntries: 0 },
    mutatedProofCoveredAccounts: 2,
  },
  mutatesSourceProtocolState: true,
  initialStateCommitment: `0x${"1".repeat(64)}`,
});

/** closed-state + local: nothing is claimed about any public chain. */
const closedLocal = () => ({
  closureClass: "closed-state",
  fidelityClass: "local",
  constructionMethod: "local-construction",
  materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"d".repeat(64)}` },
  stateArtifact: {
    descriptor: ARTIFACT,
    format: { id: "jinn.chain-state-slice", version: "1" },
    entryCounts: { accounts: 4, storageSlots: 10, codeEntries: 2 },
  },
  initialStateCommitment: `0x${"2".repeat(64)}`,
});

/** archive-dependent: the authoring/observation class, never durable supply. */
const archiveDependent = () => ({
  closureClass: "archive-dependent",
  fidelityClass: "anchored-subset",
  constructionMethod: "archive-extraction",
  materializer: { id: "anvil-fork", version: "0.4.1", digest: `sha256:${"d".repeat(64)}` },
  archive: {
    requiredCapabilities: ["eth_getProof", "eth_getStorageAt", "debug_traceTransaction"],
    providerLocators: ["https://archive.example.test"],
  },
  mutatesSourceProtocolState: false,
  initialStateCommitment: `0x${"3".repeat(64)}`,
});

const parse = (document: unknown) => ChainStateMaterializationSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("state materialization (§4.3)", () => {
  test("accepts the three shapes the design names", () => {
    expect(parse(closedAnchored()).success).toBe(true);
    expect(parse(closedLocal()).success).toBe(true);
    expect(parse(archiveDependent()).success).toBe(true);
  });

  test("a closed-state world must commit a state artifact", () => {
    const document = closedAnchored() as Record<string, unknown>;
    delete document.stateArtifact;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("stateArtifact");
  });

  test("a closed-state world declares no archive requirement", () => {
    const document = { ...closedAnchored(), archive: { requiredCapabilities: ["eth_getProof"] } };
    expect(parse(document).success).toBe(false);
  });

  test("an archive-dependent world must declare the capabilities it needs", () => {
    const document = archiveDependent() as Record<string, unknown>;
    delete document.archive;
    expect(parse(document).success).toBe(false);
  });

  test("a local world proves nothing against a source root", () => {
    const document = { ...closedLocal(), sourceProofManifest: closedAnchored().sourceProofManifest };
    expect(parse(document).success).toBe(false);
  });
});

// E13: every entry in the artifact is proof-covered or fixture-declared. The record-level
// half of the rule is arithmetic over three censuses; the artifact-level half is CE3's.
describe("artifact coverage (E13)", () => {
  test("accepts a record whose censuses add up exactly", () => {
    expect(parse(closedAnchored()).success).toBe(true);
  });

  test("refuses a record leaving storage slots neither proof-covered nor fixture-declared", () => {
    const document = closedAnchored();
    document.sourceProofManifest.coverage.storageSlots = 330; // one slot now uncovered
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("source-coverage-incomplete");
  });

  test("refuses double counting: the censuses may not exceed the artifact either", () => {
    const document = closedAnchored();
    document.fixtureCoverage.declared.accounts = 4; // 9 + 4 > 12
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("source-coverage-incomplete");
  });

  test("an anchored artifact with no proof manifest is coverage-incomplete, not merely sparse", () => {
    const document = closedAnchored() as Record<string, unknown>;
    delete document.sourceProofManifest;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("source-coverage-incomplete");
  });

  test("mutating proof-covered protocol accounts must be visible without reading fixtures", () => {
    const document = closedAnchored();
    document.mutatesSourceProtocolState = false; // but 2 proof-covered accounts are mutated
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("mutatesSourceProtocolState");
  });

  test("a non-local record must state the mutation flag one way or the other", () => {
    const document = closedAnchored() as Record<string, unknown>;
    delete document.mutatesSourceProtocolState;
    expect(parse(document).success).toBe(false);
  });

  test("coverage arithmetic is vacuous where there is no artifact to cover", () => {
    // The authoring class has no state artifact yet — that is what extraction produces.
    expect(parse(archiveDependent()).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/state.test.ts
```

Expected failure: `Failed to resolve import "./state.js"`.

- [ ] **Step 3: Write the implementation**

`src/state.ts`:

```ts
import { z } from "zod";

import { Bytes32, Count, DigestPinnedDescriptorSchema, NonEmpty, PrefixedSha256 } from "./primitives.js";

/** Axis A — materialization closure (§4.2). */
export const CLOSURE_CLASSES = Object.freeze(["closed-state", "archive-dependent"] as const);

/** Axis B — source-chain fidelity (§4.2). The two axes are independent, never one ladder. */
export const FIDELITY_CLASSES = Object.freeze(["local", "anchored-subset", "full-state"] as const);

export const CONSTRUCTION_METHODS = Object.freeze([
  "archive-extraction",
  "local-construction",
  "full-state-export",
] as const);

/**
 * The only closure class eligible for durable verified supply (§4.2). Named as a constant so
 * consumers filter on it rather than on a string literal they may spell differently — and so
 * that eligibility is one grep away from the rule that grants it.
 */
export const DURABLE_SUPPLY_CLOSURE_CLASS = "closed-state" as const;

/**
 * An entry census over the three categories E13 partitions: accounts, storage slots, and
 * deployed code entries. The same shape counts what the artifact holds, what the source proofs
 * cover, and what the fixtures declare, so the coverage rule is one subtraction rather than
 * three incomparable descriptions.
 */
export const StateEntryCountsSchema = z.strictObject({
  accounts: Count,
  storageSlots: Count,
  codeEntries: Count,
});

export type StateEntryCounts = z.infer<typeof StateEntryCountsSchema>;

const ENTRY_CATEGORIES = ["accounts", "storageSlots", "codeEntries"] as const;

export const StateArtifactSchema = z.strictObject({
  descriptor: DigestPinnedDescriptorSchema,
  format: z.strictObject({ id: NonEmpty, version: NonEmpty }),
  /** The census E13 coverage is computed against. */
  entryCounts: StateEntryCountsSchema,
});

export const SourceProofManifestSchema = z.strictObject({
  proofFormat: z.literal("eip-1186"),
  proofs: DigestPinnedDescriptorSchema,
  /** Entries the proofs bind to the *declared* anchor state root (E5 bounds what that means). */
  coverage: StateEntryCountsSchema,
});

export const FixtureCoverageSchema = z.strictObject({
  manifest: DigestPinnedDescriptorSchema,
  /** Entries the record declares as fixture mutations rather than as source state. */
  declared: StateEntryCountsSchema,
  /**
   * How many proof-covered accounts the fixtures mutate. Declared mutations of real protocol
   * state are legal — that is how scenarios are built — but E13 requires them to be *visible*
   * without reading every fixture module, and this count plus `mutatesSourceProtocolState` is
   * that visibility.
   */
  mutatedProofCoveredAccounts: Count,
});

/**
 * How the declared world comes into existence (§4.3), and the two independent classifications
 * that say how much it claims (§4.2).
 *
 * `initialStateCommitment` is the post-fixture, agent-visible world's commitment. It is
 * explicitly not `sourceAnchor.stateRoot`: a consumer comparing post-fixture state to the
 * source root and calling the difference an error would be wrong by specification. The record
 * level enforces that they differ (see `chain-record.ts`).
 */
export const ChainStateMaterializationSchema = z
  .strictObject({
    closureClass: z.enum(CLOSURE_CLASSES),
    fidelityClass: z.enum(FIDELITY_CLASSES),
    constructionMethod: z.enum(CONSTRUCTION_METHODS),
    materializer: z.strictObject({
      id: NonEmpty,
      version: NonEmpty,
      digest: PrefixedSha256,
    }),
    stateArtifact: StateArtifactSchema.optional(),
    sourceProofManifest: SourceProofManifestSchema.optional(),
    fixtureCoverage: FixtureCoverageSchema.optional(),
    archive: z
      .strictObject({
        requiredCapabilities: z.array(NonEmpty).min(1),
        /** Locators only. A provider is never identity and never part of the world. */
        providerLocators: z.array(NonEmpty).optional(),
      })
      .optional(),
    mutatesSourceProtocolState: z.boolean().optional(),
    initialStateCommitment: Bytes32,
  })
  .superRefine((state, ctx) => {
    const closed = state.closureClass === "closed-state";

    if (closed && state.stateArtifact === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["stateArtifact"],
        message:
          "stateArtifact is mandatory for closed-state: every byte needed to instantiate the "
          + "world is a digest-pinned artifact (§4.2)",
      });
    }
    if (closed && state.archive !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["archive"],
        message:
          "a closed-state world declares no archive requirement; upstream network access is "
          + "forbidden at run time (§4.2)",
      });
    }
    if (!closed && state.archive === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["archive"],
        message: "archive-dependent materialization must declare archive.requiredCapabilities (§4.3)",
      });
    }

    if (state.fidelityClass === "local") {
      if (state.sourceProofManifest !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceProofManifest"],
          message: "a local world claims no correspondence to a public chain and proves nothing against a source root (§4.2)",
        });
      }
      if (state.mutatesSourceProtocolState !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["mutatesSourceProtocolState"],
          message: "mutatesSourceProtocolState has no meaning for a local world: there is no source protocol state (§4.2)",
        });
      }
      return;
    }

    if (state.mutatesSourceProtocolState === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["mutatesSourceProtocolState"],
        message:
          "an anchored-subset or full-state record MUST state whether its fixtures mutate "
          + "proof-covered protocol state (E13)",
      });
    }

    if (
      state.fixtureCoverage !== undefined
      && state.fixtureCoverage.mutatedProofCoveredAccounts > 0
      && state.mutatesSourceProtocolState !== true
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mutatesSourceProtocolState"],
        message:
          "mutatesSourceProtocolState MUST be true when fixtureCoverage.mutatedProofCoveredAccounts "
          + "is above zero: diligence must not require reading every fixture module (E13)",
      });
    }

    // E13, record-level half: an artifact's entries are proof-covered or fixture-declared, and
    // nothing is counted twice. Vacuous with no artifact — the authoring class has none yet.
    const artifact = state.stateArtifact;
    if (artifact === undefined) return;

    if (state.sourceProofManifest === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceProofManifest"],
        message:
          "source-coverage-incomplete: an anchored-subset or full-state artifact needs a source "
          + "proof manifest, or its entries are neither proof-covered nor fixture-declared (E13)",
      });
      return;
    }
    if (state.fixtureCoverage === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fixtureCoverage"],
        message:
          "source-coverage-incomplete: declare fixtureCoverage (with zero counts if the fixtures "
          + "add no entries) so every artifact entry is accounted for (E13)",
      });
      return;
    }

    for (const category of ENTRY_CATEGORIES) {
      const covered = state.sourceProofManifest.coverage[category]
        + state.fixtureCoverage.declared[category];
      if (covered !== artifact.entryCounts[category]) {
        ctx.addIssue({
          code: "custom",
          path: ["stateArtifact", "entryCounts", category],
          message:
            `source-coverage-incomplete: the artifact declares ${artifact.entryCounts[category]} `
            + `${category} but proofs cover ${state.sourceProofManifest.coverage[category]} and `
            + `fixtures declare ${state.fixtureCoverage.declared[category]}; every entry must be `
            + "exactly one of the two (E13)",
        });
      }
    }
  });

export type ChainStateMaterialization = z.infer<typeof ChainStateMaterializationSchema>;
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/state.test.ts
```

Expected: all 13 cases pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): add state materialization with the E13 coverage arithmetic"
```

---

### Task 6: Fixture modules, fixture accounts, and the well-known-dev-address lint

**Files:**
- Create: `packages/environments/chain-record/src/dev-addresses.ts`, `src/fixture-modules.ts`
- Create: `packages/environments/chain-record/src/dev-addresses.test.ts`, `src/fixture-modules.test.ts`

**Interfaces:**
- Consumes: `Address`, `NonEmpty`, `Quantity`, `DigestPinnedDescriptorSchema` from `./primitives.js` (Task 3).
- Produces: `WELL_KNOWN_DEV_ADDRESSES`, `isWellKnownDevAddress(address: string): boolean`; `FIXTURE_MODULE_KINDS`, `FixtureModuleSchema`, `FixtureAccountSchema`, `ChainFixturesSchema`, `ChainFixtures`.

Program §4 contract 8 in code. Design §8 is explicit about why: because a sandbox may report chain id 1, every EIP-155 transaction in a published solution script is a structurally valid mainnet transaction from that fixture address, permanently. That is inert only while the address is worthless. A record naming a well-known dev-mnemonic address publishes scripts that become live the moment anyone funds it — a bait hazard for whoever funds it. So the address set is a **hard reject at the schema boundary**, not a warning.

- [ ] **Step 1: Write the failing tests**

`src/dev-addresses.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { isWellKnownDevAddress, WELL_KNOWN_DEV_ADDRESSES } from "./dev-addresses.js";

describe("well-known dev addresses (§8, program §4 contract 8)", () => {
  test("carries the standard ten-account dev set", () => {
    expect(WELL_KNOWN_DEV_ADDRESSES.length).toBeGreaterThanOrEqual(10);
    expect(WELL_KNOWN_DEV_ADDRESSES).toContain("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  test("every entry is stored in the record's own lowercase spelling", () => {
    for (const address of WELL_KNOWN_DEV_ADDRESSES) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  test("the set has no duplicates", () => {
    expect(new Set(WELL_KNOWN_DEV_ADDRESSES).size).toBe(WELL_KNOWN_DEV_ADDRESSES.length);
  });

  test("recognises a dev address whatever case the caller hands over", () => {
    expect(isWellKnownDevAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(true);
    expect(isWellKnownDevAddress("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(true);
  });

  test("a freshly generated address is not in the set", () => {
    expect(isWellKnownDevAddress(`0x${"7".repeat(40)}`)).toBe(false);
  });
});
```

`src/fixture-modules.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { ChainFixturesSchema } from "./fixture-modules.js";
import { WELL_KNOWN_DEV_ADDRESSES } from "./dev-addresses.js";

const module = (id: string, kind: string, hex: string) => ({
  id,
  kind,
  module: { name: id, digest: { sha256: hex.repeat(64) } },
});

const fixtures = () => ({
  modules: [
    module("accounts", "funded-accounts", "1"),
    module("addresses", "address-book", "2"),
    module("rates", "state-mutation", "3"),
  ],
  accounts: [
    { role: "agent", address: `0x${"a1".repeat(20)}`, nativeBalanceWei: "10000000000000000000" },
    { role: "counterparty", address: `0x${"b2".repeat(20)}`, nativeBalanceWei: "0" },
  ],
});

const parse = (document: unknown) => ChainFixturesSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("fixtures block (§4.3)", () => {
  test("accepts an ordered, digest-pinned module list with roled accounts", () => {
    expect(parse(fixtures()).success).toBe(true);
  });

  test("array order IS the application order and survives parsing", () => {
    expect(ChainFixturesSchema.parse(fixtures()).modules.map((m) => m.id))
      .toEqual(["accounts", "addresses", "rates"]);
  });

  test("refuses a module referenced by uri alone: fixtures are pinned by digest", () => {
    const document = fixtures();
    document.modules[0].module = { uri: "https://example.test/accounts.json" } as never;
    expect(parse(document).success).toBe(false);
  });

  test("refuses duplicate module ids: probe coverage is declared per module id", () => {
    const document = fixtures();
    document.modules[2].id = "accounts";
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("module id");
  });

  test("refuses duplicate account roles", () => {
    const document = fixtures();
    document.accounts[1].role = "agent";
    expect(parse(document).success).toBe(false);
  });

  test("refuses the same address under two roles: keys are fresh per record, never reused", () => {
    const document = fixtures();
    document.accounts[1].address = document.accounts[0].address;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("reused");
  });

  test("carries balances and roles, never key material", () => {
    const document = { ...fixtures() } as Record<string, unknown>;
    (document.accounts as Record<string, unknown>[])[0].privateKey = `0x${"9".repeat(64)}`;
    expect(parse(document).success).toBe(false);
  });

  test("an empty module list is legal: a world may be fully described by its artifact", () => {
    expect(parse({ ...fixtures(), modules: [] }).success).toBe(true);
  });
});

// Program §4 contract 8: a fixture address someone might fund turns every published solution
// script into a replayable mainnet transaction from it.
describe("the well-known dev-address lint (§8)", () => {
  test("refuses a fixture account at a well-known dev-mnemonic address", () => {
    const document = fixtures();
    document.accounts[0].address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("well-known");
  });

  test("refuses every address in the set, not only the first account", () => {
    for (const address of WELL_KNOWN_DEV_ADDRESSES) {
      const document = fixtures();
      document.accounts[1].address = address;
      expect(parse(document).success, address).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/environments/chain-record && yarn test src/dev-addresses.test.ts src/fixture-modules.test.ts
```

Expected failure: `Failed to resolve import "./dev-addresses.js"` and `"./fixture-modules.js"`.

- [ ] **Step 3: Write the implementation**

`src/dev-addresses.ts`:

```ts
/**
 * Addresses derived from the industry-standard development mnemonic
 * ("test test test test test test test test test test test junk", accounts #0–#9), which
 * every local EVM simulator prints on startup and whose private keys are public.
 *
 * A chain record MUST NOT name one as a fixture account. Design §8: because a sandbox may
 * report chain id 1 for contract and signature compatibility, every EIP-155 transaction in a
 * published solution script is a structurally valid mainnet transaction from that fixture
 * address, permanently. Fixture addresses are inert by *economics* — they hold nothing — not
 * by cryptography. An address whose key is already public and which someone may one day fund
 * turns the whole published corpus of scripts into replayable transactions from it. Keys are
 * therefore freshly generated per record and never a well-known one.
 *
 * The list is a floor, not a proof of exhaustiveness: it names the set anyone would reach for
 * by accident. Adding a newly popularised dev address here is a one-line edit.
 */
export const WELL_KNOWN_DEV_ADDRESSES: readonly string[] = Object.freeze([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
]);

const devAddresses = new Set(WELL_KNOWN_DEV_ADDRESSES);

/**
 * Case-insensitive so a caller holding an EIP-55 checksummed spelling still gets the right
 * answer. `Address` in a sealed record is lowercase-only, so inside this package the fold is
 * a no-op — it exists for the callers outside it.
 *
 * Folded with `toLowerCase`, never `toLocaleLowerCase`: the tree's source-boundary canary
 * bans locale-sensitive APIs, because an ordering or folding decision made against host ICU
 * data can change a record's digest between two hosts running identical code.
 */
export function isWellKnownDevAddress(address: string): boolean {
  return devAddresses.has(address.toLowerCase());
}
```

`src/fixture-modules.ts`:

```ts
import { z } from "zod";

import { isWellKnownDevAddress } from "./dev-addresses.js";
import { Address, DigestPinnedDescriptorSchema, NonEmpty, Quantity } from "./primitives.js";

/** The fixture-module categories §4.3 enumerates. */
export const FIXTURE_MODULE_KINDS = Object.freeze([
  "funded-accounts",
  "address-book",
  "deployment-transcript",
  "state-mutation",
  "token-metadata",
] as const);

export const FixtureModuleSchema = z.strictObject({
  id: NonEmpty,
  kind: z.enum(FIXTURE_MODULE_KINDS),
  module: DigestPinnedDescriptorSchema,
});

/**
 * A sandbox signer role and the address it drives. Strict on purpose: a `privateKey`,
 * `mnemonic`, or `seed` member is not a governed extension, it is key material in a portable
 * document, which custody law forbids outright. The block carries roles, addresses, and
 * balances; the keys exist only inside a running instance.
 */
export const FixtureAccountSchema = z.strictObject({
  role: NonEmpty,
  address: Address,
  nativeBalanceWei: Quantity,
});

/**
 * The ordered, digest-pinned fixture modules and the accounts they fund (§4.3). Array order is
 * application order and is part of the record.
 *
 * The post-fixture commitment is deliberately NOT restated here: it lives once, as
 * `stateMaterialization.initialStateCommitment`. See the findings section — the design
 * describes it in both blocks, and a sealed record carrying one value twice is a place for the
 * two copies to disagree.
 */
export const ChainFixturesSchema = z
  .strictObject({
    modules: z.array(FixtureModuleSchema),
    accounts: z.array(FixtureAccountSchema),
  })
  .superRefine((fixtures, ctx) => {
    const seenModuleIds = new Set<string>();
    fixtures.modules.forEach((module, index) => {
      if (seenModuleIds.has(module.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["modules", index, "id"],
          message: `duplicate module id "${module.id}": probe coverage is declared per module id (§4.3)`,
        });
      }
      seenModuleIds.add(module.id);
    });

    const seenRoles = new Set<string>();
    const seenAddresses = new Set<string>();
    fixtures.accounts.forEach((account, index) => {
      if (seenRoles.has(account.role)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "role"],
          message: `duplicate signer role "${account.role}"`,
        });
      }
      seenRoles.add(account.role);

      if (seenAddresses.has(account.address)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "address"],
          message:
            "address reused across roles: fixture keys are freshly generated per record and "
            + "never reused, so two roles never share one address (§8)",
        });
      }
      seenAddresses.add(account.address);

      if (isWellKnownDevAddress(account.address)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "address"],
          message:
            "this is a well-known development-mnemonic address whose private key is public. "
            + "Funding it would turn every published solution script into a replayable "
            + "transaction from it; fixture keys MUST be freshly generated per record (§8)",
        });
      }
    });
  });

export type ChainFixtures = z.infer<typeof ChainFixturesSchema>;
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/dev-addresses.test.ts src/fixture-modules.test.ts
```

Expected: both suites pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): add the fixtures block and reject well-known dev-mnemonic fixture addresses"
```

---

### Task 7: Determinism controls

**Files:**
- Create: `packages/environments/chain-record/src/determinism.ts`
- Create: `packages/environments/chain-record/src/determinism.test.ts`

**Interfaces:**
- Consumes: `Address`, `Bytes32`, `Count`, `Quantity` from `./primitives.js` (Task 3); `CLOSURE_CLASSES` type from `./state.js` (Task 5) is **not** imported — the closed-state coupling is asserted at record level, and this schema stays independently usable.
- Produces: `MINING_MODES`, `ORDERING_POLICIES`, `RESET_MECHANISMS`, `DeterminismControlsSchema`, `DeterminismControls`.

Every knob §4.3 names is a required member. There is no optionality here on purpose: an omitted knob is exactly the knob whose default silently changed between two runtime patch versions, and "everything affecting state or receipts MUST be fixed" is a presence rule before it is a value rule.

- [ ] **Step 1: Write the failing test**

`src/determinism.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { DeterminismControlsSchema } from "./determinism.js";

const controls = () => ({
  miningMode: "manual",
  orderingPolicy: "fifo",
  mempoolPolicy: "none",
  initialBlockNumber: 21_000_001,
  initialTimestamp: 1_735_689_612,
  blockTimeProgression: { mode: "fixed-increment", secondsPerBlock: 12 },
  baseFeePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  gasPricePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  blockGasLimit: "30000000",
  perTransactionGasCeiling: "15000000",
  coinbase: `0x${"c0".repeat(20)}`,
  prevrandao: `0x${"4".repeat(64)}`,
  replacementPolicy: "reject",
  noncePolicy: "strict",
  timeoutClock: "chain-time",
  timeWarp: { maxSecondsPerOperation: 86_400, maxAggregateSeconds: 2_592_000, maxBlocksPerOperation: 7200 },
  resetMechanism: "fresh-process",
});

const parse = (document: unknown) => DeterminismControlsSchema.safeParse(document);

describe("determinism controls (§4.3)", () => {
  test("accepts a fully fixed control set", () => {
    expect(parse(controls()).success).toBe(true);
  });

  test.each([
    "miningMode", "orderingPolicy", "mempoolPolicy", "initialBlockNumber", "initialTimestamp",
    "blockTimeProgression", "baseFeePolicy", "gasPricePolicy", "blockGasLimit",
    "perTransactionGasCeiling", "coinbase", "prevrandao", "replacementPolicy", "noncePolicy",
    "timeoutClock", "timeWarp", "resetMechanism",
  ])("requires %s: an omitted knob is the one whose default moved", (key) => {
    const document = controls() as Record<string, unknown>;
    delete document[key];
    expect(parse(document).success).toBe(false);
  });

  test("gas and fee ceilings are decimal strings, not numbers", () => {
    expect(parse({ ...controls(), blockGasLimit: 30_000_000 }).success).toBe(false);
  });

  test("time-warp bounds are mandatory: unbounded accrual is how balance predicates get gamed", () => {
    const document = controls() as Record<string, unknown>;
    document.timeWarp = { maxSecondsPerOperation: 86_400 };
    expect(parse(document).success).toBe(false);
  });

  test("a fixed-increment progression must say how many seconds per block", () => {
    const document = controls();
    document.blockTimeProgression = { mode: "fixed-increment" } as never;
    expect(parse(document).success).toBe(false);
  });

  test("a `none` progression must not also carry a per-block increment", () => {
    const document = controls();
    document.blockTimeProgression = { mode: "none", secondsPerBlock: 12 } as never;
    expect(parse(document).success).toBe(false);
  });

  test("a fixed base-fee policy must say what the fee is; a disabled one must not", () => {
    expect(parse({ ...controls(), baseFeePolicy: { mode: "fixed" } }).success).toBe(false);
    expect(
      parse({ ...controls(), baseFeePolicy: { mode: "disabled", weiPerGas: "7" } }).success,
    ).toBe(false);
    expect(parse({ ...controls(), baseFeePolicy: { mode: "disabled" } }).success).toBe(true);
  });

  test("interval mining is refused outright: block production would follow the wall clock", () => {
    expect(parse({ ...controls(), miningMode: "interval" }).success).toBe(false);
  });

  test("auto mining is accepted: a block per transaction is driven by the agent, not the clock", () => {
    expect(parse({ ...controls(), miningMode: "auto" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/determinism.test.ts
```

Expected failure: `Failed to resolve import "./determinism.js"`.

- [ ] **Step 3: Write the implementation**

`src/determinism.ts`:

```ts
import { z } from "zod";

import { Address, Bytes32, Count, Quantity } from "./primitives.js";

/**
 * `manual` mints a block only when an operation asks for one; `auto` mints one per
 * transaction. Both are driven by the agent and the sealed fixtures, which is what E8's paused
 * world means. Interval mining is absent from the vocabulary rather than merely discouraged:
 * it produces blocks on the host's wall clock, so two runs of one script would see different
 * block counts and different timestamps.
 */
export const MINING_MODES = Object.freeze(["manual", "auto"] as const);

export const ORDERING_POLICIES = Object.freeze(["fifo", "fees"] as const);
export const MEMPOOL_POLICIES = Object.freeze(["none", "queued"] as const);
export const REPLACEMENT_POLICIES = Object.freeze(["reject", "replace-by-fee"] as const);
export const NONCE_POLICIES = Object.freeze(["strict", "permissive"] as const);
export const TIMEOUT_CLOCKS = Object.freeze(["wall-clock", "chain-time"] as const);

/**
 * `fresh-process` launches a new process with a clean copy of the state artifact.
 * `snapshot-revert` rewinds inside one process — a testing convenience the record may declare,
 * but §5.1 step 8 forbids it as the reset mechanism of a closed-state world, because it cannot
 * catch startup, artifact-load, cache, or process-global drift. That coupling is enforced at
 * record level, not here, so this schema stays usable on its own.
 */
export const RESET_MECHANISMS = Object.freeze(["fresh-process", "snapshot-revert"] as const);

const BlockTimeProgressionSchema = z
  .strictObject({
    mode: z.enum(["fixed-increment", "none"]),
    secondsPerBlock: Count.optional(),
  })
  .superRefine((progression, ctx) => {
    if (progression.mode === "fixed-increment" && progression.secondsPerBlock === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["secondsPerBlock"],
        message: "a fixed-increment progression must declare secondsPerBlock",
      });
    }
    if (progression.mode === "none" && progression.secondsPerBlock !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["secondsPerBlock"],
        message: "a `none` progression advances no time and must not declare secondsPerBlock",
      });
    }
  });

const feePolicy = (disabledMode: "disabled" | "zero") =>
  z
    .strictObject({
      mode: z.enum(["fixed", disabledMode]),
      weiPerGas: Quantity.optional(),
    })
    .superRefine((policy, ctx) => {
      if (policy.mode === "fixed" && policy.weiPerGas === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["weiPerGas"],
          message: "a fixed fee policy must declare weiPerGas",
        });
      }
      if (policy.mode !== "fixed" && policy.weiPerGas !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["weiPerGas"],
          message: `a ${policy.mode} fee policy charges nothing and must not declare weiPerGas`,
        });
      }
    });

/**
 * Every outcome-affecting knob §4.3 enumerates, each one required. An omitted knob is exactly
 * the knob whose runtime default moved between two patch versions, so presence is the first
 * rule here and values are the second.
 *
 * The bounds in `timeWarp` are load-bearing beyond reproducibility: §6.2 names time advancement
 * as the most common way a balance-only success predicate is satisfied without the intended
 * action, since accrual, timelocks, and time-dependent oracles all move with it.
 */
export const DeterminismControlsSchema = z.strictObject({
  miningMode: z.enum(MINING_MODES),
  orderingPolicy: z.enum(ORDERING_POLICIES),
  mempoolPolicy: z.enum(MEMPOOL_POLICIES),
  initialBlockNumber: Count,
  /** Unix seconds of the initial block. */
  initialTimestamp: Count,
  blockTimeProgression: BlockTimeProgressionSchema,
  baseFeePolicy: feePolicy("disabled"),
  gasPricePolicy: feePolicy("zero"),
  blockGasLimit: Quantity,
  perTransactionGasCeiling: Quantity,
  coinbase: Address,
  prevrandao: Bytes32,
  replacementPolicy: z.enum(REPLACEMENT_POLICIES),
  noncePolicy: z.enum(NONCE_POLICIES),
  timeoutClock: z.enum(TIMEOUT_CLOCKS),
  timeWarp: z.strictObject({
    maxSecondsPerOperation: Count,
    maxAggregateSeconds: Count,
    maxBlocksPerOperation: Count,
  }),
  resetMechanism: z.enum(RESET_MECHANISMS),
});

export type DeterminismControls = z.infer<typeof DeterminismControlsSchema>;
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/determinism.test.ts
```

Expected: all cases pass (17 presence cases plus 8 value cases), typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): add the determinism controls block with every §4.3 knob required"
```

---

### Task 8: The capability envelope and the verification contract

**Files:**
- Create: `packages/environments/chain-record/src/envelope.ts`, `src/verification-contract.ts`
- Create: `packages/environments/chain-record/src/envelope.test.ts`, `src/verification-contract.test.ts`

**Interfaces:**
- Consumes: `Address`, `Count`, `NonEmpty`, `PrefixedSha256`, `Quantity`, `DigestPinnedDescriptorSchema` from `./primitives.js` (Task 3).
- Produces: `MINIMUM_VERIFICATION_RUNS` (`5`), `CapabilityEnvelopeSchema`, `CapabilityEnvelope`, `VerificationContractSchema`, `VerificationContract`.

- [ ] **Step 1: Write the failing tests**

`src/envelope.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { CapabilityEnvelopeSchema } from "./envelope.js";

const envelope = () => ({
  toolInterfaces: [
    { id: "jinn.chain-tools", version: "1.0", schema: { name: "tools", digest: { sha256: "1".repeat(64) } } },
  ],
  rpc: {
    readMethods: ["eth_call", "eth_getBalance", "eth_getBlockByNumber"],
    stateChangingMethods: ["eth_sendRawTransaction", "evm_mine"],
  },
  signerRoles: [
    { role: "agent", accounts: [`0x${"a1".repeat(20)}`] },
  ],
  permittedChainId: 1,
  limits: {
    maxTransactions: 25,
    maxAggregateNativeValueWei: "5000000000000000000",
    tokenSpendPolicies: [{ token: `0x${"d0".repeat(20)}`, maxSpendUnits: "1000000000" }],
    maxGasPerTransaction: "5000000",
    maxAggregateGas: "60000000",
    maxExecutionDurationMs: 600_000,
    maxBlockAdvance: 500,
    maxChainSecondsAdvance: 604_800,
  },
  egressPolicyId: "jinn.egress.blackhole/1",
});

const parse = (document: unknown) => CapabilityEnvelopeSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("capability envelope (§4.3)", () => {
  test("accepts a fully bounded envelope", () => {
    expect(parse(envelope()).success).toBe(true);
  });

  test("refuses a method that is both read and state-changing", () => {
    const document = envelope();
    document.rpc.readMethods.push("evm_mine");
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("both");
  });

  test("refuses duplicate methods inside one allowlist", () => {
    const document = envelope();
    document.rpc.readMethods.push("eth_call");
    expect(parse(document).success).toBe(false);
  });

  test("requires at least one read method: a world with no reads has no agent surface", () => {
    const document = envelope();
    document.rpc.readMethods = [];
    expect(parse(document).success).toBe(false);
  });

  test("refuses duplicate signer roles and an account bound to two roles", () => {
    const twoRoles = envelope();
    twoRoles.signerRoles = [
      { role: "agent", accounts: [`0x${"a1".repeat(20)}`] },
      { role: "rescuer", accounts: [`0x${"a1".repeat(20)}`] },
    ];
    expect(parse(twoRoles).success).toBe(false);

    const sameRole = envelope();
    sameRole.signerRoles = [
      { role: "agent", accounts: [`0x${"a1".repeat(20)}`] },
      { role: "agent", accounts: [`0x${"b2".repeat(20)}`] },
    ];
    expect(parse(sameRole).success).toBe(false);
  });

  test("carries roles and policy, never credentials", () => {
    const document = envelope() as Record<string, unknown>;
    (document.signerRoles as Record<string, unknown>[])[0].keystore = "0xdeadbeef";
    expect(parse(document).success).toBe(false);
  });

  test("every ceiling is required: an absent maximum is an unbounded capability", () => {
    for (const key of [
      "maxTransactions", "maxAggregateNativeValueWei", "tokenSpendPolicies", "maxGasPerTransaction",
      "maxAggregateGas", "maxExecutionDurationMs", "maxBlockAdvance", "maxChainSecondsAdvance",
    ]) {
      const document = envelope() as { limits: Record<string, unknown> };
      delete document.limits[key];
      expect(parse(document).success, key).toBe(false);
    }
  });

  test("an empty token-spend policy list is legal — it declares no token ceilings, explicitly", () => {
    const document = envelope();
    document.limits.tokenSpendPolicies = [];
    expect(parse(document).success).toBe(true);
  });

  test("requires an egress policy identifier", () => {
    const document = envelope() as Record<string, unknown>;
    delete document.egressPolicyId;
    expect(parse(document).success).toBe(false);
  });
});
```

`src/verification-contract.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { MINIMUM_VERIFICATION_RUNS, VerificationContractSchema } from "./verification-contract.js";

const contract = () => ({
  probeSuite: {
    descriptor: { name: "probes", digest: { sha256: "5".repeat(64) } },
    format: { id: "jinn.chain-probes", version: "1" },
  },
  observationSchema: { name: "observation.schema.json", digest: { sha256: "6".repeat(64) } },
  baselineObservationDigest: `sha256:${"7".repeat(64)}`,
  comparator: { id: "canonical-observation-eq", version: "1.0.0", digest: `sha256:${"8".repeat(64)}` },
  closureCheckRequired: true,
  resetRequirements: { freshInstancePerRun: true, minimumRuns: 5 },
  fixtureProbeCoverage: [
    { fixtureId: "accounts", probeIds: ["balances"] },
    { fixtureId: "rates", probeIds: ["rate-read", "rate-write"] },
  ],
  policyId: "jinn.chain-verification-policy/1",
});

const parse = (document: unknown) => VerificationContractSchema.safeParse(document);

describe("verification contract (§4.3, §5.1)", () => {
  test("accepts a contract at the K floor", () => {
    expect(parse(contract()).success).toBe(true);
  });

  test("K inherits the parent floor of five (E4)", () => {
    expect(MINIMUM_VERIFICATION_RUNS).toBe(5);
    expect(parse({ ...contract(), resetRequirements: { freshInstancePerRun: true, minimumRuns: 4 } }).success)
      .toBe(false);
    expect(parse({ ...contract(), resetRequirements: { freshInstancePerRun: true, minimumRuns: 9 } }).success)
      .toBe(true);
  });

  test("refuses a contract that would accept snapshot cycles as repetition", () => {
    expect(
      parse({ ...contract(), resetRequirements: { freshInstancePerRun: false, minimumRuns: 5 } }).success,
    ).toBe(false);
  });

  test("results never live in the record: an outcome field is refused", () => {
    expect(parse({ ...contract(), lastOutcome: "closed-reproducible" }).success).toBe(false);
  });

  test("refuses duplicate fixture ids in the probe-coverage declaration", () => {
    const document = contract();
    document.fixtureProbeCoverage.push({ fixtureId: "accounts", probeIds: ["again"] });
    expect(parse(document).success).toBe(false);
  });

  test("every declared fixture must name at least one probe", () => {
    const document = contract();
    document.fixtureProbeCoverage[0].probeIds = [];
    expect(parse(document).success).toBe(false);
  });

  test("the baseline observation digest is a record-body digest, not a bare DigestSet value", () => {
    expect(parse({ ...contract(), baselineObservationDigest: "7".repeat(64) }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/environments/chain-record && yarn test src/envelope.test.ts src/verification-contract.test.ts
```

Expected failure: `Failed to resolve import "./envelope.js"` and `"./verification-contract.js"`.

- [ ] **Step 3: Write the implementation**

`src/envelope.ts`:

```ts
import { z } from "zod";

import { Address, Count, DigestPinnedDescriptorSchema, NonEmpty, Quantity } from "./primitives.js";

/**
 * What the agent may do inside the instance (§4.3). Tasks may **tighten** this envelope and
 * never widen it; the tighten-only comparison itself belongs with the evaluation family, which
 * is where the tightenings are declared.
 *
 * `signerRoles` carries roles and addresses. There is no member for a key, a keystore, or a
 * mnemonic, and the object is strict, so adding one is `invalid-document` rather than a
 * governed extension: real credentials never appear in portable documents.
 */
export const CapabilityEnvelopeSchema = z
  .strictObject({
    toolInterfaces: z
      .array(
        z.strictObject({
          id: NonEmpty,
          version: NonEmpty,
          schema: DigestPinnedDescriptorSchema,
        }),
      )
      .min(1),
    rpc: z.strictObject({
      readMethods: z.array(NonEmpty).min(1, "a world with no readable RPC method has no agent surface"),
      stateChangingMethods: z.array(NonEmpty),
    }),
    signerRoles: z
      .array(
        z.strictObject({
          role: NonEmpty,
          accounts: z.array(Address).min(1),
        }),
      )
      .min(1),
    /** The chain id the agent is permitted to sign for; the record level pins it to the runtime's. */
    permittedChainId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    limits: z.strictObject({
      maxTransactions: Count,
      maxAggregateNativeValueWei: Quantity,
      /** May be empty — an explicit "no token ceilings", never an absent field. */
      tokenSpendPolicies: z.array(
        z.strictObject({ token: Address, maxSpendUnits: Quantity }),
      ),
      maxGasPerTransaction: Quantity,
      maxAggregateGas: Quantity,
      maxExecutionDurationMs: Count,
      maxBlockAdvance: Count,
      maxChainSecondsAdvance: Count,
    }),
    egressPolicyId: NonEmpty,
  })
  .superRefine((envelope, ctx) => {
    const read = new Set(envelope.rpc.readMethods);
    if (read.size !== envelope.rpc.readMethods.length) {
      ctx.addIssue({ code: "custom", path: ["rpc", "readMethods"], message: "duplicate RPC method in the read allowlist" });
    }
    const changing = new Set(envelope.rpc.stateChangingMethods);
    if (changing.size !== envelope.rpc.stateChangingMethods.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rpc", "stateChangingMethods"],
        message: "duplicate RPC method in the state-changing allowlist",
      });
    }
    for (const method of changing) {
      if (read.has(method)) {
        ctx.addIssue({
          code: "custom",
          path: ["rpc", "stateChangingMethods"],
          message:
            `"${method}" is listed as both read and state-changing; the isolation probes assert `
            + "the two classes behave differently, so a method cannot be in both (§5.1 step 6)",
        });
      }
    }

    const roles = new Set<string>();
    const accounts = new Set<string>();
    envelope.signerRoles.forEach((signer, index) => {
      if (roles.has(signer.role)) {
        ctx.addIssue({ code: "custom", path: ["signerRoles", index, "role"], message: `duplicate signer role "${signer.role}"` });
      }
      roles.add(signer.role);
      signer.accounts.forEach((account, accountIndex) => {
        if (accounts.has(account)) {
          ctx.addIssue({
            code: "custom",
            path: ["signerRoles", index, "accounts", accountIndex],
            message: "an account is exposed under two signer roles; signer scope is probed per role (§5.1 step 6)",
          });
        }
        accounts.add(account);
      });
    });
  });

export type CapabilityEnvelope = z.infer<typeof CapabilityEnvelopeSchema>;
```

`src/verification-contract.ts`:

```ts
import { z } from "zod";

import { DigestPinnedDescriptorSchema, NonEmpty, PrefixedSha256 } from "./primitives.js";

/**
 * K inherits the parent floor (E4). The record may ask for more repetitions; it may not ask
 * for fewer, and the schema is where that floor stops being advice.
 */
export const MINIMUM_VERIFICATION_RUNS = 5 as const;

/**
 * What a verifier is contracted to do with this world (§4.3). Results never live here — they
 * append as separately published attestations, so there is no outcome, status, or timestamp
 * member and the object is strict.
 */
export const VerificationContractSchema = z
  .strictObject({
    probeSuite: z.strictObject({
      descriptor: DigestPinnedDescriptorSchema,
      format: z.strictObject({ id: NonEmpty, version: NonEmpty }),
    }),
    observationSchema: DigestPinnedDescriptorSchema,
    /**
     * The digest of the canonical observation a conforming run is expected to reproduce. The
     * observation's own shape is owned by the evaluation family's canonical-observation schema,
     * not by this package; the record commits to the digest of the expected value.
     */
    baselineObservationDigest: PrefixedSha256,
    comparator: z.strictObject({ id: NonEmpty, version: NonEmpty, digest: PrefixedSha256 }),
    closureCheckRequired: z.boolean(),
    resetRequirements: z.strictObject({
      /**
       * Snapshot/revert cycles inside one process are a testing convenience, never repetition:
       * they cannot catch startup, artifact-load, cache, or process-global drift (§5.1 step 8).
       */
      freshInstancePerRun: z.literal(true),
      minimumRuns: z.number().int().min(MINIMUM_VERIFICATION_RUNS).max(Number.MAX_SAFE_INTEGER),
    }),
    /** Per-fixture-module smoke coverage: each module answers probes that exercise it (§5.1 step 6). */
    fixtureProbeCoverage: z.array(
      z.strictObject({
        fixtureId: NonEmpty,
        probeIds: z.array(NonEmpty).min(1, "a declared fixture must name at least one probe"),
      }),
    ),
    policyId: NonEmpty,
  })
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    contract.fixtureProbeCoverage.forEach((entry, index) => {
      if (seen.has(entry.fixtureId)) {
        ctx.addIssue({
          code: "custom",
          path: ["fixtureProbeCoverage", index, "fixtureId"],
          message: `duplicate probe-coverage declaration for fixture "${entry.fixtureId}"`,
        });
      }
      seen.add(entry.fixtureId);
    });
  });

export type VerificationContract = z.infer<typeof VerificationContractSchema>;
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/envelope.test.ts src/verification-contract.test.ts
```

Expected: both suites pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): add the capability envelope and the verification contract with the K>=5 floor"
```

---

### Task 9: The chain environment record

**Files:**
- Create: `packages/environments/chain-record/src/chain-record.ts`
- Create: `packages/environments/chain-record/src/chain-record.test.ts`

**Interfaces:**
- Consumes: `topLevelRecordSchema` from `./extensions.js`, `sealWithSchema` / `parseExactWithSchema` from `./sealing.js`, `CHAIN_ENVIRONMENT_KIND` / `BLACKHOLE_EGRESS_POLICY_ID` from `./identifiers.js`, `DigestPinnedDescriptorSchema` from `./primitives.js`, and the block schemas from `./runtime.js`, `./anchor.js`, `./state.js`, `./fixture-modules.js`, `./determinism.js`, `./envelope.js`, `./verification-contract.js` (Tasks 2–8).
- Produces: `ChainEnvironmentRecordSchema`, `ChainEnvironmentRecord`, `sealChainEnvironmentRecord(record: unknown): Uint8Array`, `parseChainEnvironmentRecord(bytes: Uint8Array): ChainEnvironmentRecord` — three of the program §3 pinned names — plus `requiresStateBackend(record: ChainEnvironmentRecord): boolean`, the shared rule the materializer and the extractor both key off (coordinator ruling CR3 / finding CE1-F10).

Seven cross-block invariants live here because each of them spans two blocks that are independently useful on their own.

- [ ] **Step 1: Write the failing test**

`src/chain-record.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { BLACKHOLE_EGRESS_POLICY_ID, CHAIN_ENVIRONMENT_KIND } from "./identifiers.js";
import { chainEnvironmentRecordDigest } from "./hashing.js";
import {
  ChainEnvironmentRecordSchema,
  parseChainEnvironmentRecord,
  requiresStateBackend,
  sealChainEnvironmentRecord,
} from "./chain-record.js";

const AGENT = `0x${"a1".repeat(20)}`;
const COUNTERPARTY = `0x${"b2".repeat(20)}`;

/** The reference world every case below mutates: closed-state, anchored-subset, K=5. */
const record = () => ({
  kind: CHAIN_ENVIRONMENT_KIND,
  runtime: {
    family: "anvil",
    version: "1.3.7",
    image: { manifestDigest: `sha256:${"1".repeat(64)}`, platform: "linux/amd64" },
    binary: { name: "anvil", digest: `sha256:${"2".repeat(64)}` },
    evm: { hardfork: "cancun", sandboxChainId: 1, nonDefaultSettings: {} },
    launch: { options: { "no-mining": true } },
  },
  sourceAnchor: {
    caip2ChainId: "eip155:1",
    nativeChainId: 1,
    genesisHash: `0x${"d".repeat(64)}`,
    blockNumber: 21_000_000,
    blockHash: `0x${"e".repeat(64)}`,
    stateRoot: `0x${"f".repeat(64)}`,
    timestamp: 1_735_689_600,
    finalityPolicy: "finalized",
  },
  stateMaterialization: {
    closureClass: "closed-state",
    fidelityClass: "anchored-subset",
    constructionMethod: "archive-extraction",
    materializer: { id: "anvil-state-loader", version: "0.4.1", digest: `sha256:${"3".repeat(64)}` },
    stateArtifact: {
      descriptor: { name: "state.json", digest: { sha256: "4".repeat(64) } },
      format: { id: "jinn.chain-state-slice", version: "1" },
      entryCounts: { accounts: 5, storageSlots: 20, codeEntries: 2 },
    },
    sourceProofManifest: {
      proofFormat: "eip-1186",
      proofs: { name: "proofs.json", digest: { sha256: "5".repeat(64) } },
      coverage: { accounts: 3, storageSlots: 18, codeEntries: 2 },
    },
    fixtureCoverage: {
      manifest: { name: "mutations.json", digest: { sha256: "6".repeat(64) } },
      declared: { accounts: 2, storageSlots: 2, codeEntries: 0 },
      mutatedProofCoveredAccounts: 0,
    },
    mutatesSourceProtocolState: false,
    initialStateCommitment: `0x${"7".repeat(64)}`,
  },
  fixtures: {
    modules: [
      { id: "accounts", kind: "funded-accounts", module: { name: "a", digest: { sha256: "8".repeat(64) } } },
    ],
    accounts: [
      { role: "agent", address: AGENT, nativeBalanceWei: "10000000000000000000" },
      { role: "counterparty", address: COUNTERPARTY, nativeBalanceWei: "0" },
    ],
  },
  determinismControls: {
    miningMode: "manual",
    orderingPolicy: "fifo",
    mempoolPolicy: "none",
    initialBlockNumber: 21_000_001,
    initialTimestamp: 1_735_689_612,
    blockTimeProgression: { mode: "fixed-increment", secondsPerBlock: 12 },
    baseFeePolicy: { mode: "fixed", weiPerGas: "1000000000" },
    gasPricePolicy: { mode: "fixed", weiPerGas: "1000000000" },
    blockGasLimit: "30000000",
    perTransactionGasCeiling: "15000000",
    coinbase: `0x${"c0".repeat(20)}`,
    prevrandao: `0x${"9".repeat(64)}`,
    replacementPolicy: "reject",
    noncePolicy: "strict",
    timeoutClock: "chain-time",
    timeWarp: { maxSecondsPerOperation: 86_400, maxAggregateSeconds: 2_592_000, maxBlocksPerOperation: 7200 },
    resetMechanism: "fresh-process",
  },
  capabilityEnvelope: {
    toolInterfaces: [
      { id: "jinn.chain-tools", version: "1.0", schema: { name: "t", digest: { sha256: "a".repeat(64) } } },
    ],
    rpc: { readMethods: ["eth_call"], stateChangingMethods: ["eth_sendRawTransaction"] },
    signerRoles: [{ role: "agent", accounts: [AGENT] }],
    permittedChainId: 1,
    limits: {
      maxTransactions: 25,
      maxAggregateNativeValueWei: "5000000000000000000",
      tokenSpendPolicies: [],
      maxGasPerTransaction: "5000000",
      maxAggregateGas: "60000000",
      maxExecutionDurationMs: 600_000,
      maxBlockAdvance: 500,
      maxChainSecondsAdvance: 604_800,
    },
    egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
  },
  verificationContract: {
    probeSuite: {
      descriptor: { name: "probes", digest: { sha256: "b".repeat(64) } },
      format: { id: "jinn.chain-probes", version: "1" },
    },
    observationSchema: { name: "obs", digest: { sha256: "c".repeat(64) } },
    baselineObservationDigest: `sha256:${"d".repeat(64)}`,
    comparator: { id: "canonical-observation-eq", version: "1.0.0", digest: `sha256:${"e".repeat(64)}` },
    closureCheckRequired: true,
    resetRequirements: { freshInstancePerRun: true, minimumRuns: 5 },
    fixtureProbeCoverage: [{ fixtureId: "accounts", probeIds: ["balances"] }],
    policyId: "jinn.chain-verification-policy/1",
  },
});

const parse = (document: unknown) => ChainEnvironmentRecordSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("chain environment record", () => {
  test("accepts the reference closed-state anchored-subset world", () => {
    expect(parse(record()).success).toBe(true);
  });

  test("pins the kind: another kind URI is a different record kind, not an extension", () => {
    expect(parse({ ...record(), kind: "https://jinn.network/records/environment/1.0" }).success).toBe(false);
  });

  test("carries no mutable status: staleness is derived from attestation history", () => {
    for (const key of ["status", "health", "expiresAt", "verified"]) {
      expect(parse({ ...record(), [key]: "x" }).success, key).toBe(false);
    }
  });

  test("accepts a namespaced extension key and refuses a bare one", () => {
    expect(parse({ ...record(), "network.jinn.note": "hello" }).success).toBe(true);
    expect(parse({ ...record(), note: "hello" }).success).toBe(false);
  });

  test("accepts an optional supersedes pointer for promotion lineage (E12)", () => {
    expect(
      parse({ ...record(), supersedes: { name: "prior", digest: { sha256: "f".repeat(64) } } }).success,
    ).toBe(true);
  });
});

describe("cross-block invariants", () => {
  test("an anchor is present exactly when fidelity is not local", () => {
    const anchored = record() as Record<string, unknown>;
    delete anchored.sourceAnchor;
    expect(parse(anchored).success).toBe(false);

    const local = record();
    local.stateMaterialization.fidelityClass = "local";
    local.stateMaterialization.constructionMethod = "local-construction";
    delete (local.stateMaterialization as Record<string, unknown>).sourceProofManifest;
    delete (local.stateMaterialization as Record<string, unknown>).fixtureCoverage;
    delete (local.stateMaterialization as Record<string, unknown>).mutatesSourceProtocolState;
    local.stateMaterialization.stateArtifact.entryCounts = { accounts: 5, storageSlots: 20, codeEntries: 2 };
    expect(parse(local).success).toBe(false); // still carries an anchor
    delete (local as Record<string, unknown>).sourceAnchor;
    expect(parse(local).success).toBe(true);
  });

  // The single most likely verifier bug the design calls out by name: comparing post-fixture
  // state to the source root and calling the difference an error.
  test("refuses the source state root presented as the initial state commitment", () => {
    const document = record();
    document.stateMaterialization.initialStateCommitment = document.sourceAnchor.stateRoot;
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("initialStateCommitment");
  });

  test("the permitted chain id is the sandbox's, and must agree with the runtime", () => {
    const document = record();
    document.capabilityEnvelope.permittedChainId = 8453;
    expect(parse(document).success).toBe(false);
  });

  test("every signer account must be a declared fixture account", () => {
    const document = record();
    document.capabilityEnvelope.signerRoles = [{ role: "agent", accounts: [`0x${"e9".repeat(20)}`] }];
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("fixture account");
  });

  test("every fixture module must declare its smoke probes, and no others may be declared", () => {
    const missing = record();
    missing.verificationContract.fixtureProbeCoverage = [];
    expect(parse(missing).success).toBe(false);

    const extra = record();
    extra.verificationContract.fixtureProbeCoverage.push({ fixtureId: "ghost", probeIds: ["p"] });
    expect(parse(extra).success).toBe(false);
  });

  test("a closed-state world declares the blackhole egress policy and requires the closure check", () => {
    const policy = record();
    policy.capabilityEnvelope.egressPolicyId = "jinn.egress.permissive/1";
    expect(parse(policy).success).toBe(false);

    const check = record();
    check.verificationContract.closureCheckRequired = false;
    expect(parse(check).success).toBe(false);
  });

  test("a closed-state world resets by fresh process, never by snapshot revert", () => {
    const document = record();
    document.determinismControls.resetMechanism = "snapshot-revert";
    expect(parse(document).success).toBe(false);
  });
});

describe("requiresStateBackend", () => {
  test("an archive-dependent record needs an injected backend; a closed-state one does not", () => {
    const closed = ChainEnvironmentRecordSchema.parse(record());
    expect(requiresStateBackend(closed)).toBe(false);

    const archive = record();
    archive.stateMaterialization.closureClass = "archive-dependent";
    delete (archive.stateMaterialization as Record<string, unknown>).stateArtifact;
    delete (archive.stateMaterialization as Record<string, unknown>).sourceProofManifest;
    delete (archive.stateMaterialization as Record<string, unknown>).fixtureCoverage;
    archive.stateMaterialization.archive = { requiredCapabilities: ["eth_getProof"] };
    archive.capabilityEnvelope.egressPolicyId = "jinn.egress.archive-only/1";
    archive.verificationContract.closureCheckRequired = false;
    expect(requiresStateBackend(ChainEnvironmentRecordSchema.parse(archive))).toBe(true);
  });
});

describe("sealing", () => {
  test("seals to bytes whose sha256 is the record's identity", () => {
    const sealed = sealChainEnvironmentRecord(record());
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(chainEnvironmentRecordDigest(sealed)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("sealing is idempotent through a parse", () => {
    const once = sealChainEnvironmentRecord(record());
    const twice = sealChainEnvironmentRecord(parseChainEnvironmentRecord(once));
    expect(chainEnvironmentRecordDigest(twice)).toBe(chainEnvironmentRecordDigest(once));
  });

  test("re-canonicalized bytes do not present as the same record", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(record(), null, 2));
    expect(() => parseChainEnvironmentRecord(pretty)).toThrow();
  });

  test("key order in the input does not reach the sealed bytes", () => {
    const forward = sealChainEnvironmentRecord(record());
    const reversed = Object.fromEntries(Object.entries(record()).reverse());
    expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(reversed)))
      .toBe(chainEnvironmentRecordDigest(forward));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/chain-record.test.ts
```

Expected failure: `Failed to resolve import "./chain-record.js"`.

- [ ] **Step 3: Write the implementation**

`src/chain-record.ts`:

```ts
import { z } from "zod";

import { ChainSourceAnchorSchema } from "./anchor.js";
import { CapabilityEnvelopeSchema } from "./envelope.js";
import { DeterminismControlsSchema } from "./determinism.js";
import { topLevelRecordSchema } from "./extensions.js";
import { ChainFixturesSchema } from "./fixture-modules.js";
import { BLACKHOLE_EGRESS_POLICY_ID, CHAIN_ENVIRONMENT_KIND } from "./identifiers.js";
import { DigestPinnedDescriptorSchema } from "./primitives.js";
import { ChainRuntimeSchema } from "./runtime.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";
import { ChainStateMaterializationSchema } from "./state.js";
import { VerificationContractSchema } from "./verification-contract.js";

/**
 * One record = one sandboxed chain world (§4.3). Sealed forever: no expiry, no status, no
 * outcome — staleness and assurance are derived by consumers from attestation history, never
 * stored here (§4.5). `supersedes` is a static backward pointer carrying promotion lineage
 * (E12); it is not status either.
 *
 * The document states what the world IS. It makes no claim that the world boots, reproduces,
 * or corresponds to a public chain beyond the fidelity class it declares; every such claim
 * lives in separately published attestations and is bounded there.
 */
export const ChainEnvironmentRecordSchema = topLevelRecordSchema({
  kind: z.literal(CHAIN_ENVIRONMENT_KIND),
  runtime: ChainRuntimeSchema,
  sourceAnchor: ChainSourceAnchorSchema.optional(),
  stateMaterialization: ChainStateMaterializationSchema,
  fixtures: ChainFixturesSchema,
  determinismControls: DeterminismControlsSchema,
  capabilityEnvelope: CapabilityEnvelopeSchema,
  verificationContract: VerificationContractSchema,
  supersedes: DigestPinnedDescriptorSchema.optional(),
}).superRefine((record, ctx) => {
  const state = record.stateMaterialization;
  const anchored = state.fidelityClass !== "local";

  // 1. An anchor is present exactly when the record claims correspondence to a source chain.
  if (anchored && record.sourceAnchor === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceAnchor"],
      message: `fidelityClass "${state.fidelityClass}" claims a source chain, so sourceAnchor is required (§4.3)`,
    });
  }
  if (!anchored && record.sourceAnchor !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceAnchor"],
      message: "a local world claims no source chain and must not carry a sourceAnchor (§4.2)",
    });
  }

  // 2. The post-fixture commitment is a different claim about a different world than the
  //    source root. Spelling them the same is either a confusion or the claim §4.3 forbids.
  if (record.sourceAnchor !== undefined
      && state.initialStateCommitment === record.sourceAnchor.stateRoot) {
    ctx.addIssue({
      code: "custom",
      path: ["stateMaterialization", "initialStateCommitment"],
      message:
        "initialStateCommitment equals sourceAnchor.stateRoot. It is the post-fixture, "
        + "agent-visible world's commitment, computed by the pinned materializer — explicitly "
        + "distinct from the source root (§4.3)",
    });
  }

  // 3. Sandbox execution identity is one value, declared once.
  if (record.capabilityEnvelope.permittedChainId !== record.runtime.evm.sandboxChainId) {
    ctx.addIssue({
      code: "custom",
      path: ["capabilityEnvelope", "permittedChainId"],
      message:
        "permittedChainId disagrees with runtime.evm.sandboxChainId; the agent may only sign "
        + "for the chain id the sandbox reports (§4.3)",
    });
  }

  // 4. Signers expose fixture accounts and nothing else (§5.1 step 6 probes this).
  const fixtureAddresses = new Set(record.fixtures.accounts.map((account) => account.address));
  record.capabilityEnvelope.signerRoles.forEach((signer, index) => {
    signer.accounts.forEach((account, accountIndex) => {
      if (!fixtureAddresses.has(account)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilityEnvelope", "signerRoles", index, "accounts", accountIndex],
          message: `${account} is not a declared fixture account; signers expose only fixture accounts (§5.1)`,
        });
      }
    });
  });

  // 5. Probe coverage is declared per fixture module, for every module and no others.
  const moduleIds = new Set(record.fixtures.modules.map((module) => module.id));
  const coveredIds = new Set(
    record.verificationContract.fixtureProbeCoverage.map((entry) => entry.fixtureId),
  );
  for (const id of moduleIds) {
    if (!coveredIds.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["verificationContract", "fixtureProbeCoverage"],
        message: `fixture module "${id}" declares no smoke probes; each module answers its own (§5.1 step 6)`,
      });
    }
  }
  for (const id of coveredIds) {
    if (!moduleIds.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["verificationContract", "fixtureProbeCoverage"],
        message: `probe coverage declared for "${id}", which is not a fixture module of this record`,
      });
    }
  }

  if (state.closureClass !== "closed-state") return;

  // 6. A closed-state world runs with every egress interface dead, and earns the class only
  //    through the closure check — never by existing (E3).
  if (record.capabilityEnvelope.egressPolicyId !== BLACKHOLE_EGRESS_POLICY_ID) {
    ctx.addIssue({
      code: "custom",
      path: ["capabilityEnvelope", "egressPolicyId"],
      message: `a closed-state world declares egressPolicyId "${BLACKHOLE_EGRESS_POLICY_ID}" (§4.2, §5.1 step 2)`,
    });
  }
  if (record.verificationContract.closureCheckRequired !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["verificationContract", "closureCheckRequired"],
      message: "a closed-state world requires the closure check; the class is earned, never asserted (E3)",
    });
  }

  // 7. Repetition means fresh processes (§5.1 step 8).
  if (record.determinismControls.resetMechanism !== "fresh-process") {
    ctx.addIssue({
      code: "custom",
      path: ["determinismControls", "resetMechanism"],
      message:
        "a closed-state world resets by launching a fresh process with a clean copy of the state "
        + "artifact; snapshot/revert inside one process cannot catch startup, artifact-load, "
        + "cache, or process-global drift (§5.1 step 8)",
    });
  }
});

export type ChainEnvironmentRecord = z.infer<typeof ChainEnvironmentRecordSchema>;

/**
 * Validate, then canonicalize once. The returned bytes are the record forever; its identity is
 * `chainEnvironmentRecordDigest(bytes)`.
 *
 * Throws `InvalidDocumentError` for a schema failure or a refused `__proto__` member, and
 * `IJsonNumberError` / `IJsonStringError` / `UndefinedArrayElementError` for a value no
 * canonical encoding admits. All four carry `category: "invalid-document"` — catch on that
 * rather than on `InvalidDocumentError` by class.
 */
export function sealChainEnvironmentRecord(record: unknown): Uint8Array {
  return sealWithSchema(ChainEnvironmentRecordSchema, record);
}

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseChainEnvironmentRecord(bytes: Uint8Array): ChainEnvironmentRecord {
  return parseExactWithSchema(ChainEnvironmentRecordSchema, bytes);
}

/**
 * Whether materializing this record requires the caller to supply a `ChainStateBackend`.
 *
 * True for exactly the `archive-dependent` class, whose historical state resolves at
 * materialization time rather than from a committed artifact. The rule lives here, in the
 * package both the materializer and the extractor already depend on, so neither re-derives it
 * from the closure class and neither drifts. A materializer handed such a record without a
 * backend fails closed; `archive.providerLocators` tells a *caller* where it may look and is
 * never an instruction to the runtime.
 */
export function requiresStateBackend(record: ChainEnvironmentRecord): boolean {
  return record.stateMaterialization.closureClass === "archive-dependent";
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/chain-record.test.ts
```

Expected: all cases pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): assemble the chain-environment record kind with its seven cross-block invariants"
```

---

### Task 10: The composite crypto environment record

**Files:**
- Create: `packages/environments/chain-record/src/composite.ts`
- Create: `packages/environments/chain-record/src/composite.test.ts`

**Interfaces:**
- Consumes: `topLevelRecordSchema`, `sealWithSchema`, `parseExactWithSchema`, `CHAIN_ENVIRONMENT_KIND`, `CRYPTO_ENVIRONMENT_KIND`, and `Count` / `NonEmpty` / `HttpOrigin` / `RecordKindUri` / `ExactSemanticVersion` / `DigestPinnedDescriptorSchema` from Tasks 2–3.
- Produces: `WorldReferenceSchema`, `InformationWorldReferenceSchema`, `ServiceRuntimeSchema`, `CompositionSchema`, `CryptoEnvironmentRecordSchema`, `CryptoEnvironmentRecord`, `sealCryptoEnvironmentRecord(record: unknown): Uint8Array`, `parseCryptoEnvironmentRecord(bytes: Uint8Array): CryptoEnvironmentRecord`.

The composite does **not** pin the information-world kind constant: program §3 assigns `INFORMATION_WORLD_KIND` to CE6, and two packages declaring one constant is a name collision waiting to drift. Instead every information-world reference declares a `kind` that must satisfy the record-kind URI grammar and must not be the chain kind — structural, honest, and it costs CE6 nothing to satisfy. Recorded as a finding.

- [ ] **Step 1: Write the failing test**

`src/composite.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";
import { cryptoEnvironmentRecordDigest } from "./hashing.js";
import {
  CryptoEnvironmentRecordSchema,
  parseCryptoEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "./composite.js";

const INFORMATION_KIND = "https://jinn.network/records/information-world/1.0";

const chainOnly = () => ({
  kind: CRYPTO_ENVIRONMENT_KIND,
  chainWorld: { kind: CHAIN_ENVIRONMENT_KIND, record: { name: "chain", digest: { sha256: "1".repeat(64) } } },
  informationWorlds: [],
  serviceRuntimes: [],
  composition: {
    originRouting: [],
    missPolicy: { mode: "declared-response", status: 404 },
    endpointAllowlist: [],
    requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
  },
});

const withWorlds = () => ({
  ...chainOnly(),
  informationWorlds: [
    { id: "llama", kind: INFORMATION_KIND, record: { name: "llama", digest: { sha256: "2".repeat(64) } } },
    { id: "docs", kind: INFORMATION_KIND, record: { name: "docs", digest: { sha256: "3".repeat(64) } } },
  ],
  serviceRuntimes: [
    {
      id: "replay",
      family: "http-replay",
      version: "0.2.0",
      image: { manifestDigest: `sha256:${"4".repeat(64)}`, platform: "linux/amd64" },
    },
  ],
  composition: {
    originRouting: [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://docs.example.test", worldId: "docs", precedence: 0 },
    ],
    missPolicy: { mode: "declared-response", status: 404 },
    endpointAllowlist: ["https://api.llama.fi", "https://docs.example.test"],
    requestBudget: { maxRequests: 200, maxResponseBytes: 8_388_608 },
  },
});

const parse = (document: unknown) => CryptoEnvironmentRecordSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("composite crypto environment record (§4.4)", () => {
  test("a chain-only world is a composite with an empty informationWorlds list", () => {
    expect(parse(chainOnly()).success).toBe(true);
  });

  test("accepts a composite carrying two information worlds and a pinned replay runtime", () => {
    expect(parse(withWorlds()).success).toBe(true);
  });

  test("chainWorld must be the chain kind, referenced by digest", () => {
    const wrongKind = chainOnly();
    wrongKind.chainWorld.kind = INFORMATION_KIND;
    expect(parse(wrongKind).success).toBe(false);

    const noDigest = chainOnly();
    wrongKind.chainWorld.kind = CHAIN_ENVIRONMENT_KIND;
    noDigest.chainWorld.record = { uri: "https://example.test/chain.json" } as never;
    expect(parse(noDigest).success).toBe(false);
  });

  test("an information world must not claim the chain kind", () => {
    const document = withWorlds();
    document.informationWorlds[0].kind = CHAIN_ENVIRONMENT_KIND;
    expect(parse(document).success).toBe(false);
  });

  test("world ids and service-runtime ids are unique", () => {
    const worlds = withWorlds();
    worlds.informationWorlds[1].id = "llama";
    expect(parse(worlds).success).toBe(false);

    const runtimes = withWorlds();
    runtimes.serviceRuntimes.push({ ...runtimes.serviceRuntimes[0] });
    expect(parse(runtimes).success).toBe(false);
  });

  test("a route must name a declared world", () => {
    const document = withWorlds();
    document.composition.originRouting[0].worldId = "absent";
    expect(parse(document).success).toBe(false);
  });

  test("a routed origin must be on the reachable-endpoint allowlist", () => {
    const document = withWorlds();
    document.composition.endpointAllowlist = ["https://docs.example.test"];
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("allowlist");
  });
});

// The reproducibility hazard §4.4 names: two corpora claiming one origin is not a merge.
describe("origin routing and precedence (§4.4, §5.1 step 6)", () => {
  test("accepts two worlds on one origin when precedence is declared and total", () => {
    const document = withWorlds();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://api.llama.fi", worldId: "docs", precedence: 1 },
    ];
    document.composition.endpointAllowlist = ["https://api.llama.fi"];
    expect(parse(document).success).toBe(true);
  });

  test("refuses two worlds claiming one origin at the same precedence", () => {
    const document = withWorlds();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://api.llama.fi", worldId: "docs", precedence: 0 },
    ];
    document.composition.endpointAllowlist = ["https://api.llama.fi"];
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("precedence");
  });

  test("refuses the same world routed twice for one origin", () => {
    const document = withWorlds();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 1 },
    ];
    document.composition.endpointAllowlist = ["https://api.llama.fi"];
    expect(parse(document).success).toBe(false);
  });
});

describe("the chain-only composite really has no information plane", () => {
  test("refuses routes with no information worlds", () => {
    const document = chainOnly();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
    ];
    expect(parse(document).success).toBe(false);
  });

  test("refuses a non-zero request budget with no information worlds", () => {
    const document = chainOnly();
    document.composition.requestBudget = { maxRequests: 10, maxResponseBytes: 1024 };
    expect(parse(document).success).toBe(false);
  });

  test("requires a positive request budget once worlds are composed", () => {
    const document = withWorlds();
    document.composition.requestBudget = { maxRequests: 0, maxResponseBytes: 0 };
    expect(parse(document).success).toBe(false);
  });
});

describe("sealing", () => {
  test("seals, re-parses, and re-seals to the same digest", () => {
    const once = sealCryptoEnvironmentRecord(withWorlds());
    const twice = sealCryptoEnvironmentRecord(parseCryptoEnvironmentRecord(once));
    expect(cryptoEnvironmentRecordDigest(twice)).toBe(cryptoEnvironmentRecordDigest(once));
  });

  test("a chain-only composite and a composed one are different records", () => {
    expect(cryptoEnvironmentRecordDigest(sealCryptoEnvironmentRecord(chainOnly())))
      .not.toBe(cryptoEnvironmentRecordDigest(sealCryptoEnvironmentRecord(withWorlds())));
  });

  test("re-canonicalized bytes do not present as the same record", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(chainOnly(), null, 2));
    expect(() => parseCryptoEnvironmentRecord(pretty)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/composite.test.ts
```

Expected failure: `Failed to resolve import "./composite.js"`.

- [ ] **Step 3: Write the implementation**

`src/composite.ts`:

```ts
import { z } from "zod";

import { topLevelRecordSchema } from "./extensions.js";
import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";
import {
  Count,
  DigestPinnedDescriptorSchema,
  ExactSemanticVersion,
  HttpOrigin,
  NonEmpty,
  PrefixedSha256,
  RecordKindUri,
} from "./primitives.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

/**
 * A component world, referenced by digest (E11: first-class from day one, never inlined, so
 * there is no inline-match problem to enforce here).
 *
 * The `kind` is checked against the record-kind URI grammar rather than against a pinned
 * information-world constant: that constant belongs to the information-world package, and two
 * packages declaring one identifier is a drift surface. What this record needs is structural —
 * a component of a stated kind, pinned by digest — and that is what it validates.
 */
export const WorldReferenceSchema = z.strictObject({
  kind: RecordKindUri,
  record: DigestPinnedDescriptorSchema,
});

/**
 * An information world plus the stable local handle the composition block and the evaluation
 * family's `sourceValue` / `sourceConsulted` predicates address it by.
 */
export const InformationWorldReferenceSchema = z.strictObject({
  id: NonEmpty,
  kind: RecordKindUri,
  record: DigestPinnedDescriptorSchema,
});

/**
 * A pinned reusable component (a replay service, a browser). Runtimes upgrade without
 * pretending chain state changed — which is exactly why they live in the composite and not in
 * the chain record (§4.4).
 */
export const ServiceRuntimeSchema = z.strictObject({
  id: NonEmpty,
  family: NonEmpty,
  version: ExactSemanticVersion,
  image: z.strictObject({
    manifestDigest: PrefixedSha256,
    platform: z
      .string()
      .regex(/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/, "platform is os/arch[/variant]"),
  }),
});

/**
 * What only exists once worlds are combined (§4.4): origin routing with explicit precedence,
 * the composite miss policy, the reachable-endpoint allowlist, and the request budget.
 *
 * The miss policy has one mode on purpose. An uncaptured request returns the declared
 * response; it never reaches upstream. That is the exact analogue of an out-of-slice chain
 * read returning empty, and a second mode would be the place a live fetch got in.
 */
export const CompositionSchema = z.strictObject({
  originRouting: z.array(
    z.strictObject({
      origin: HttpOrigin,
      worldId: NonEmpty,
      /** Lower wins. Two worlds may share an origin only with distinct precedence. */
      precedence: Count,
    }),
  ),
  missPolicy: z.strictObject({
    mode: z.literal("declared-response"),
    status: z.number().int().min(100).max(599),
    body: DigestPinnedDescriptorSchema.optional(),
  }),
  endpointAllowlist: z.array(HttpOrigin),
  requestBudget: z.strictObject({
    maxRequests: Count,
    maxResponseBytes: Count,
  }),
});

/**
 * The composite a task references (E14). A chain-only world is a composite with an empty
 * `informationWorlds` list, so the common v1 case pays one indirection and nothing else.
 *
 * Components are sealed and verified independently and their attestations are reusable; the
 * composite is verified as a whole because routing collisions and whole-world closure only
 * exist in combination. Neither attestation substitutes for the other, and neither lives here.
 */
export const CryptoEnvironmentRecordSchema = topLevelRecordSchema({
  kind: z.literal(CRYPTO_ENVIRONMENT_KIND),
  chainWorld: WorldReferenceSchema,
  informationWorlds: z.array(InformationWorldReferenceSchema),
  serviceRuntimes: z.array(ServiceRuntimeSchema),
  composition: CompositionSchema,
  supersedes: DigestPinnedDescriptorSchema.optional(),
}).superRefine((record, ctx) => {
  if (record.chainWorld.kind !== CHAIN_ENVIRONMENT_KIND) {
    ctx.addIssue({
      code: "custom",
      path: ["chainWorld", "kind"],
      message: `chainWorld must reference ${CHAIN_ENVIRONMENT_KIND} (§4.4)`,
    });
  }

  const worldIds = new Set<string>();
  record.informationWorlds.forEach((world, index) => {
    if (world.kind === CHAIN_ENVIRONMENT_KIND) {
      ctx.addIssue({
        code: "custom",
        path: ["informationWorlds", index, "kind"],
        message: "an information world is not a chain world; a composite has exactly one chain world (§4.4)",
      });
    }
    if (worldIds.has(world.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["informationWorlds", index, "id"],
        message: `duplicate information-world id "${world.id}"; routing and predicates address worlds by id`,
      });
    }
    worldIds.add(world.id);
  });

  const runtimeIds = new Set<string>();
  record.serviceRuntimes.forEach((runtime, index) => {
    if (runtimeIds.has(runtime.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["serviceRuntimes", index, "id"],
        message: `duplicate service-runtime id "${runtime.id}"`,
      });
    }
    runtimeIds.add(runtime.id);
  });

  const allowlist = new Set(record.composition.endpointAllowlist);
  if (allowlist.size !== record.composition.endpointAllowlist.length) {
    ctx.addIssue({
      code: "custom",
      path: ["composition", "endpointAllowlist"],
      message: "duplicate origin on the reachable-endpoint allowlist",
    });
  }

  /** origin -> precedence values already claimed, and the worlds that claimed them. */
  const claimed = new Map<string, { precedences: Set<number>; worlds: Set<string> }>();
  record.composition.originRouting.forEach((route, index) => {
    if (!worldIds.has(route.worldId)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "worldId"],
        message: `route names "${route.worldId}", which is not a declared information world`,
      });
    }
    if (!allowlist.has(route.origin)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "origin"],
        message: `${route.origin} is routed but absent from the reachable-endpoint allowlist (§4.4)`,
      });
    }
    const entry = claimed.get(route.origin) ?? { precedences: new Set<number>(), worlds: new Set<string>() };
    if (entry.precedences.has(route.precedence)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "precedence"],
        message:
          `two information worlds claim ${route.origin} at precedence ${route.precedence}. Two `
          + "corpora on one origin is a reproducibility hazard, not a merge: declare distinct "
          + "precedence so resolution is total (§4.4)",
      });
    }
    entry.precedences.add(route.precedence);
    if (entry.worlds.has(route.worldId)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "worldId"],
        message: `"${route.worldId}" is routed twice for ${route.origin}; one world serves an origin at one precedence`,
      });
    }
    entry.worlds.add(route.worldId);
    claimed.set(route.origin, entry);
  });

  // A chain-only composite must genuinely have no information plane, or the empty list is
  // decoration over a retrieval surface nothing describes.
  const budget = record.composition.requestBudget;
  if (record.informationWorlds.length === 0) {
    if (record.composition.originRouting.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting"],
        message: "a composite with no information worlds routes nothing (§4.4)",
      });
    }
    if (budget.maxRequests !== 0 || budget.maxResponseBytes !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "requestBudget"],
        message: "a composite with no information worlds has a zero request budget (§4.4)",
      });
    }
    return;
  }
  if (budget.maxRequests === 0 || budget.maxResponseBytes === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["composition", "requestBudget"],
      message: "composed information worlds need a positive request budget; retrieval is bounded like every other capability (§4.4)",
    });
  }
});

export type CryptoEnvironmentRecord = z.infer<typeof CryptoEnvironmentRecordSchema>;

/** Validate, then canonicalize once. Identity is `cryptoEnvironmentRecordDigest(bytes)`. */
export function sealCryptoEnvironmentRecord(record: unknown): Uint8Array {
  return sealWithSchema(CryptoEnvironmentRecordSchema, record);
}

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseCryptoEnvironmentRecord(bytes: Uint8Array): CryptoEnvironmentRecord {
  return parseExactWithSchema(CryptoEnvironmentRecordSchema, bytes);
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/composite.test.ts
```

Expected: all cases pass, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): add the composite crypto-environment kind with explicit origin precedence"
```

---

### Task 11: The solution script and the port type declarations

**Files:**
- Create: `packages/environments/chain-record/src/solution.ts`, `src/ports.ts`
- Create: `packages/environments/chain-record/src/solution.test.ts`, `src/ports.test.ts`

**Interfaces:**
- Consumes: `Address`, `Count`, `NonEmpty`, `PrefixedSha256`, `Quantity` from `./primitives.js`; `CapabilityEnvelope` from `./envelope.js`; `ChainEnvironmentRecord` from `./chain-record.js`; `sealWithSchema` / `parseExactWithSchema` from `./sealing.js`.
- Produces: `CHAIN_SOLUTION_MEDIA_TYPE`, `SOLUTION_OPERATION_KINDS`, `ChainSolutionScriptSchema`, `ChainSolutionScript`, `ChainSolutionOperation`, `sealChainSolutionScript`, `parseChainSolutionScript`; and the port **types** `ResolvedResources`, `NetworkPolicy`, `ChainStateBackend`, `RuntimeIdentityObservation`, `ArtifactEntryObservation`, `IsolationObservation`, `MaterializationCost`, `MaterializationReport`, `ChainInstance`, `VerifiedChainInstance`, `MaterializationRequest`, `ChainMaterializer`, `ProbeExecutor<Observation>`, `ProbeExecutionRequest`, `ProbeExecutionResult<Observation>`, `ScriptReplayer<Observation>`, `ReplayRequest`, `ReplayOutcome<Observation>`, `ReplayRefusal`.

The port shapes here are the ones settled by **coordinator ruling CR3** against the verification
component's finding F-CE3-12 and the extraction component's F-CE4-1. `ports.test.ts` is their
compile-time pin: it constructs every fact §5.1 steps 2–6 and 9 read, at the exact spelling each
is declared with, so a downstream component's stop-and-report clears by `yarn typecheck` rather
than by inspection.

Design §3 puts the runtime *surface* in CE3 and its *type declarations* here, so a solver's local runner, the admission observation port, the evaluation replayer, and the verifier all depend on the contract without depending on the capability. `ScriptReplayer` cannot be typed without the solution script, and §14 names `application/vnd.jinn.chain-solution.v1+json` in this family's naming pass, so the script's **shape** is declared here too. Its sealing helpers use the generic primitives; nothing about publication or grading lives in this package. Recorded as a finding, since program §3's CE1 list does not spell it out.

`ports.ts` declares types only — no runtime values, no implementations, no imports beyond types. That is what makes it safe for four consumers to depend on.

- [ ] **Step 1: Write the failing tests**

`src/solution.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  CHAIN_SOLUTION_MEDIA_TYPE,
  ChainSolutionScriptSchema,
  parseChainSolutionScript,
  sealChainSolutionScript,
} from "./solution.js";

const script = () => ({
  mediaType: CHAIN_SOLUTION_MEDIA_TYPE,
  environmentRecordDigest: `sha256:${"1".repeat(64)}`,
  operations: [
    { kind: "signedTransaction", rawTransaction: "0x02f8710182..." },
    { kind: "timeWarp", seconds: 3600 },
    { kind: "mine", blocks: 1 },
    { kind: "report", name: "supplyRateBps", value: "412" },
  ],
});

const parse = (document: unknown) => ChainSolutionScriptSchema.safeParse(document);

describe("chain solution script (§6.4, §14)", () => {
  test("pins the media type the design's naming pass settled", () => {
    expect(CHAIN_SOLUTION_MEDIA_TYPE).toBe("application/vnd.jinn.chain-solution.v1+json");
  });

  test("accepts an ordered script over the four permitted operations", () => {
    expect(parse(script()).success).toBe(true);
  });

  test("an empty operation list is legal — it is the do-nothing script admission executes", () => {
    expect(parse({ ...script(), operations: [] }).success).toBe(true);
  });

  test("refuses a fifth operation kind: the vocabulary is closed", () => {
    const document = script();
    document.operations.push({ kind: "shellCommand", command: "cast send" } as never);
    expect(parse(document).success).toBe(false);
  });

  test("refuses an unsigned transaction: the script carries raw signed bytes, never a request", () => {
    const document = script();
    document.operations[0] = { kind: "signedTransaction", to: `0x${"a1".repeat(20)}` } as never;
    expect(parse(document).success).toBe(false);
  });

  test("binds the environment it replays against, by digest", () => {
    const document = script() as Record<string, unknown>;
    delete document.environmentRecordDigest;
    expect(parse(document).success).toBe(false);
  });

  test("reported values are strings: a reported quantity is compared, never arithmetic'd here", () => {
    const document = script();
    document.operations[3] = { kind: "report", name: "supplyRateBps", value: 412 } as never;
    expect(parse(document).success).toBe(false);
  });

  test("seals and re-parses to identical bytes", () => {
    const once = sealChainSolutionScript(script());
    expect(new TextDecoder().decode(sealChainSolutionScript(parseChainSolutionScript(once))))
      .toBe(new TextDecoder().decode(once));
  });
});
```

`src/ports.test.ts`:

```ts
// The ports are TYPES. This suite compiles against them and asserts the module contributes no
// runtime surface — a value here would make four consumers depend on an implementation.
//
// It is also the **compile-time pin** for the widened shapes settled by coordinator ruling CR3.
// The verification capability's stop-and-report clears when this file typechecks: every fact
// §5.1 steps 2-6 and 9 read is constructed below, at the spelling it is declared with, so a
// silent narrowing of any member fails `yarn typecheck` here rather than in a downstream plan.
import { describe, expect, test } from "vitest";

import type {
  ArtifactEntryObservation,
  ChainInstance,
  ChainMaterializer,
  ChainStateBackend,
  IsolationObservation,
  MaterializationCost,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ProbeExecutor,
  ReplayOutcome,
  RuntimeIdentityObservation,
  ScriptReplayer,
  VerifiedChainInstance,
} from "./ports.js";
import * as ports from "./ports.js";

interface FakeObservation { readonly finalStateCommitment: string }

const BLACKHOLE: NetworkPolicy = {
  egress: "denied",
  dns: "absent",
  archiveRpc: "unreachable",
  forkBackend: "absent",
};

const runtimeIdentity: RuntimeIdentityObservation = {
  imageManifestDigest: `sha256:${"1".repeat(64)}`,
  platform: "linux/amd64",
  reportedVersion: "1.3.7",
  binaryDigest: `sha256:${"2".repeat(64)}`,
  evmConfigurationDigest: `sha256:${"3".repeat(64)}`,
  chainId: 1,
  appliedControls: { miningMode: "manual", prevrandao: `0x${"9".repeat(64)}` },
  unsupportedControls: [],
};

const artifactEntries: ArtifactEntryObservation = {
  accounts: [`0x${"a1".repeat(20)}`],
  codeEntries: [`0x${"d0".repeat(20)}`],
  storageSlots: [{ address: `0x${"d0".repeat(20)}`, slot: `0x${"0".repeat(64)}` }],
};

const isolation: IsolationObservation = {
  networkPolicy: BLACKHOLE,
  egressAttempts: [{ target: "https://archive.example.test", outcome: "refused" }],
  forbiddenProbes: [{ method: "anvil_reset", expectedClass: "method-not-found", observedClass: "method-not-found" }],
  exposedSignerAccounts: [`0x${"a1".repeat(20)}`],
  ceilingChecks: [{ name: "maxTransactions", enforced: true }],
};

const cost: MaterializationCost = { wallSeconds: 3.2, cpuSeconds: 2.1, maxMemoryBytes: 512_000_000 };

const report: MaterializationReport = {
  runtimeIdentity,
  artifactEntries,
  postFixtureCommitment: `0x${"7".repeat(64)}`,
  loadedResources: [`sha256:${"5".repeat(64)}`],
  isolation,
  cost,
};

const instance: ChainInstance = {
  instanceId: "run-1",
  rpcEndpoint: "http://127.0.0.1:8545",
  report,
  stop: async () => {},
};

/** A solver's local runner: the floor, and nothing it does not need. */
const localRunnerInstance: ChainInstance = {
  instanceId: "local-1",
  rpcEndpoint: "http://127.0.0.1:8546",
  stop: async () => {},
};

/** A plain-JSON-RPC backend: no `eth_getProof`, so no storage root, and absence is expressible. */
const stateBackend: ChainStateBackend = {
  getAccount: async (address) =>
    address === `0x${"00".repeat(20)}`
      ? undefined
      : { nonce: "0", balanceWei: "0", codeHash: `0x${"0".repeat(64)}` },
  getCode: async () => "0x",
  getStorageAt: async () => `0x${"0".repeat(64)}`,
  getBlockHeader: async () => ({ hash: `0x${"e".repeat(64)}`, stateRoot: `0x${"f".repeat(64)}`, timestamp: 1_735_689_600 }),
};

const materializer: ChainMaterializer = {
  materialize: async () => instance,
  reset: async () => `0x${"7".repeat(64)}`,
};

const executor: ProbeExecutor<FakeObservation> = {
  execute: async () => ({
    observation: { finalStateCommitment: `0x${"1".repeat(64)}` },
    observationDigest: `sha256:${"2".repeat(64)}`,
  }),
};

const replayer: ScriptReplayer<FakeObservation> = {
  replay: async (): Promise<ReplayOutcome<FakeObservation>> => ({
    status: "replayed",
    observation: { finalStateCommitment: `0x${"3".repeat(64)}` },
    observationDigest: `sha256:${"4".repeat(64)}`,
    reportedValues: { supplyRateBps: "412" },
  }),
};

describe("port declarations", () => {
  test("the module exports no runtime value: consumers depend on contracts, not capability", () => {
    expect(Object.keys(ports)).toEqual([]);
  });

  test("a materializer hands back a stoppable instance with a runner-local endpoint", async () => {
    const request: MaterializationRequest = {
      record: {} as never,
      resources: { byDigest: new Map() },
      instanceId: "run-1",
      networkPolicy: BLACKHOLE,
    };
    const handle = await materializer.materialize(request);
    expect(handle.rpcEndpoint.startsWith("http://127.0.0.1")).toBe(true);
    expect(handle.instanceId).toBe(request.instanceId);
    await handle.stop();
  });

  // Coordinator ruling CR3: every fact §5.1 steps 2-6 and 9 read is on the report, at the
  // spelling the record uses, so the comparison in step 5 needs no conversion.
  test("the report carries every fact the verification protocol reads", () => {
    expect(report.runtimeIdentity.unsupportedControls).toEqual([]);
    expect(report.artifactEntries.accounts.length
      + report.artifactEntries.codeEntries.length
      + report.artifactEntries.storageSlots.length).toBe(3);
    expect(report.postFixtureCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.loadedResources[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.isolation.networkPolicy.egress).toBe("denied");
    expect(report.isolation.egressAttempts[0]?.outcome).toBe("refused");
    expect(report.cost.wallSeconds).toBeGreaterThan(0);
  });

  test("reset returns the post-reset commitment, in the record's own spelling", async () => {
    expect(await materializer.reset(instance)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a verifying handle narrows the floor rather than forking it", () => {
    const verified: VerifiedChainInstance = { ...instance, report };
    expect(verified.report.postFixtureCommitment).toBe(report.postFixtureCommitment);
    // The floor is what a solver's local runner pays for: no report, no isolation evidence.
    expect(localRunnerInstance.report).toBeUndefined();
  });

  test("a state backend is a caller-supplied capability, never a locator the runtime dials", async () => {
    const request: MaterializationRequest = {
      record: {} as never,
      resources: { byDigest: new Map() },
      instanceId: "archive-1",
      networkPolicy: { ...BLACKHOLE, archiveRpc: "unreachable", forkBackend: "present" },
      stateBackend,
    };
    expect(await request.stateBackend?.getCode(`0x${"d0".repeat(20)}`, 21_000_000)).toBe("0x");
  });

  // A backend serving plain reads has no storage root to give, and an absent account is an
  // answer rather than a failure — the same answer a sealed world gives outside its slice.
  test("a plain-JSON-RPC backend needs no eth_getProof and can report absence", async () => {
    const present = await stateBackend.getAccount(`0x${"d0".repeat(20)}`, 21_000_000);
    expect(present?.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(present?.storageRoot).toBeUndefined();
    expect(await stateBackend.getAccount(`0x${"00".repeat(20)}`, 21_000_000)).toBeUndefined();
  });

  test("a probe executor returns the observation and the digest the verifier compares", async () => {
    const result = await executor.execute({ instance, probeSuite: new Uint8Array([1]) });
    expect(result.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.observation.finalStateCommitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("a replay either replays or refuses; an envelope violation is not a judgement call", async () => {
    const replayed = await replayer.replay({
      instance,
      script: { mediaType: "application/vnd.jinn.chain-solution.v1+json", environmentRecordDigest: `sha256:${"5".repeat(64)}`, operations: [] },
      envelope: {} as never,
    });
    expect(replayed.status).toBe("replayed");

    const refused: ReplayOutcome<FakeObservation> = {
      status: "refused",
      refusal: { reason: "envelope-exceeded", detail: "transaction 26 exceeds maxTransactions=25" },
    };
    expect(refused.status).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/environments/chain-record && yarn test src/solution.test.ts src/ports.test.ts
```

Expected failure: `Failed to resolve import "./solution.js"` and `"./ports.js"`.

- [ ] **Step 3: Write the implementation**

`src/solution.ts`:

```ts
import { z } from "zod";

import { Count, NonEmpty, PrefixedSha256 } from "./primitives.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

/** §14's naming pass. The script is the deliverable; the trajectory is evidence beside it. */
export const CHAIN_SOLUTION_MEDIA_TYPE = "application/vnd.jinn.chain-solution.v1+json" as const;

export const SOLUTION_OPERATION_KINDS = Object.freeze([
  "signedTransaction",
  "timeWarp",
  "mine",
  "report",
] as const);

/**
 * The closed operation vocabulary (§6.4). A transaction arrives as raw **signed** bytes, not as
 * a request the replayer would have to sign — the replayer holds no keys, and a script that
 * asked it to sign would be asking for ambient authority.
 */
const SolutionOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("signedTransaction"),
    rawTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-prefixed raw transaction bytes"),
  }),
  z.strictObject({ kind: z.literal("timeWarp"), seconds: Count }),
  z.strictObject({ kind: z.literal("mine"), blocks: Count }),
  /** A value the agent asserts, graded against ground truth computed from the frozen state. */
  z.strictObject({ kind: z.literal("report"), name: NonEmpty, value: z.string() }),
]);

export type ChainSolutionOperation = z.infer<typeof SolutionOperationSchema>;

/**
 * An ordered, deterministic script, bound by digest to the environment it replays against.
 *
 * Bounded claim, stated once and meant literally: replaying this script on a fresh instance of
 * that environment is what the verdict grades. Nothing here binds the script to the trajectory
 * that produced it — that correspondence is a declared trust step (§6.4), and a harness
 * attestation closing it is parked as an extension.
 *
 * An empty operation list is the do-nothing script admission executes to prove the task demands
 * action, so emptiness is legal and load-bearing.
 */
export const ChainSolutionScriptSchema = z.strictObject({
  mediaType: z.literal(CHAIN_SOLUTION_MEDIA_TYPE),
  environmentRecordDigest: PrefixedSha256,
  operations: z.array(SolutionOperationSchema),
});

export type ChainSolutionScript = z.infer<typeof ChainSolutionScriptSchema>;

export function sealChainSolutionScript(script: unknown): Uint8Array {
  return sealWithSchema(ChainSolutionScriptSchema, script);
}

export function parseChainSolutionScript(bytes: Uint8Array): ChainSolutionScript {
  return parseExactWithSchema(ChainSolutionScriptSchema, bytes);
}
```

`src/ports.ts`:

```ts
// Type declarations ONLY. Design §3 makes the runtime surface public but homes its contracts
// here, so four consumers — the verifier, the admission observation port, the evaluation
// replayer, and a solver's own local runner — can depend on the contract without depending on
// the capability that implements it. A runtime value in this module would defeat that, and
// `ports.test.ts` asserts the module's runtime export set is empty.

import type { ChainEnvironmentRecord } from "./chain-record.js";
import type { CapabilityEnvelope } from "./envelope.js";
import type { ChainSolutionScript } from "./solution.js";

/**
 * Every byte a materialization needs, already resolved and digest-verified by the caller,
 * keyed by the record-body digest spelling. Resolution is the caller's business precisely
 * because it is the step that touches the network: a materializer that fetched its own inputs
 * would hold ambient authority, and no closure claim over it would mean anything.
 */
export interface ResolvedResources {
  readonly byDigest: ReadonlyMap<`sha256:${string}`, Uint8Array>;
}

/**
 * The execution context's network stance, travelling **with** the materialization request
 * rather than being asserted about it afterwards (§5.1 step 2). An attestation that named a
 * control the run was never given would be describing a different run.
 */
export interface NetworkPolicy {
  readonly egress: "denied";
  readonly dns: "absent";
  readonly archiveRpc: "unreachable";
  /** A sealed instance has no fork backend at all; §4.2's boundary rule depends on which. */
  readonly forkBackend: "absent" | "present";
}

/**
 * What the runtime turned out to be, as opposed to what the record asked for (§5.1 step 3). A
 * version string alone is insufficient, which is why every identity field is here — and
 * `unsupportedControls` is the point of the block: a determinism control the pinned runtime
 * cannot actually apply must surface as a named fact, never be silently dropped (§10).
 */
export interface RuntimeIdentityObservation {
  readonly imageManifestDigest: `sha256:${string}`;
  readonly platform: string;
  readonly reportedVersion: string;
  readonly binaryDigest: `sha256:${string}`;
  readonly evmConfigurationDigest: `sha256:${string}`;
  readonly chainId: number;
  readonly appliedControls: Readonly<Record<string, string>>;
  readonly unsupportedControls: readonly string[];
}

/**
 * The identities the materializer **actually loaded into the instance** — read back from the
 * materialized world, never copied from the artifact it was given. That direction is the whole
 * value of the block: a report derived from its own input cannot validate that input, and a
 * census transcribed from the artifact would agree with the artifact by construction while
 * saying nothing about the world that booted.
 *
 * E13's coverage set is computed over exactly these, so the member names match
 * `StateEntryCounts` one-for-one — `accounts.length` against `entryCounts.accounts`, and so on.
 * Two vocabularies for one partition is how an off-by-one mapping gets written and never
 * noticed. Read the other way, the equality is a loader-versus-producer cross-check: a mismatch
 * means the two disagree about the slice, and no census computed over the artifact is then true
 * of the instance.
 */
export interface ArtifactEntryObservation {
  readonly accounts: readonly string[];
  readonly codeEntries: readonly string[];
  readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
}

/** §5.1 step 6, and the isolation-evidence block of the §5.3 attestation. */
export interface IsolationObservation {
  readonly networkPolicy: NetworkPolicy;
  readonly egressAttempts: readonly {
    readonly target: string;
    readonly outcome: "refused" | "succeeded";
    readonly detail?: string;
  }[];
  readonly forbiddenProbes: readonly {
    readonly method: string;
    readonly expectedClass: string;
    readonly observedClass: string;
  }[];
  readonly exposedSignerAccounts: readonly string[];
  readonly ceilingChecks: readonly { readonly name: string; readonly enforced: boolean }[];
}

/** Cost observations (§5.3). Measurements, never gates. */
export interface MaterializationCost {
  readonly wallSeconds: number;
  readonly cpuSeconds?: number;
  readonly maxMemoryBytes?: number;
  readonly diskBytes?: number;
  readonly rpcCalls?: number;
  readonly rpcBytes?: number;
}

/**
 * Everything a materialization observed that the verification protocol reads and the
 * attestation predicate carries. It is data, not behaviour, which is why it can live in a
 * tier-2 package: this declares the shape of the facts, and asserts none of them.
 */
export interface MaterializationReport {
  readonly runtimeIdentity: RuntimeIdentityObservation;
  readonly artifactEntries: ArtifactEntryObservation;
  /**
   * The commitment of the post-fixture, agent-visible world this instance actually came up
   * with — spelled the way the record spells it (`0x` + 64 lowercase hex), because §5.1 step 5
   * compares it directly against `stateMaterialization.initialStateCommitment` and a comparison
   * across two spellings is a conversion nobody specified.
   */
  readonly postFixtureCommitment: `0x${string}`;
  /** Every resource actually loaded, so "no uncommitted resource loaded" is checkable (§5.1 step 9). */
  readonly loadedResources: readonly `sha256:${string}`[];
  readonly isolation: IsolationObservation;
  readonly cost: MaterializationCost;
}

/**
 * A live instance, and the **structural floor** every consumer may rely on. Run-local identity,
 * destroyed after; never promoted, never a record (§4.5).
 *
 * `report` is optional for one reason, and it is the reason the runtime surface is public at
 * all: a solver's local runner materializes a world to drive its agent against and wants none
 * of the verification machinery. Requiring it to produce isolation evidence and cost
 * observations would make the decisive consumer in the seam argument pay for a capability it
 * never uses. A verifying implementation always populates it, and narrows the handle to say so
 * — `ChainInstance & { report: MaterializationReport }` — which keeps ONE declaration of the
 * shape rather than two. A materializer that returns no report cannot be verified, and that is
 * an infrastructure failure the verifier names rather than a claim it can make anyway.
 */
export interface ChainInstance {
  /** Echoes `MaterializationRequest.instanceId`; a verifier asserts the two agree. */
  readonly instanceId: string;
  /** A runner-local endpoint. Under the blackhole policy it is the only reachable interface. */
  readonly rpcEndpoint: string;
  readonly report?: MaterializationReport;
  readonly stop: () => Promise<void>;
}

/**
 * Read-only chain state supplied by the caller, for the materialization classes that resolve
 * historical state at run time rather than from a committed artifact.
 *
 * It is injected for two reasons that both matter. Custody first: a materializer that dialled
 * `archive.providerLocators` itself would hold ambient network authority, and every closure
 * claim about the surrounding process would be worth less. Second, and the reason the shape is
 * this narrow: a caller that owns the backend owns the record of what execution actually
 * reached for — which accounts, which slots, which code. A lazily-fetching fork hides that
 * behind its own cache, and a state extractor left guessing at it is back to trusting a dump,
 * which §7's widen-and-re-verify loop exists precisely to avoid.
 *
 * Locators in a record are locators: they tell a caller where it *may* look. They are not an
 * instruction to the materializer, and nothing in this contract reads them.
 */
export interface ChainStateBackend {
  /**
   * `undefined` means the account is absent at that block — which is a legitimate answer, not a
   * failure. A sealed world answers the same way for anything outside its committed slice
   * (§4.2's boundary rule), so absence has to be expressible here or the two would disagree.
   *
   * `storageRoot` is **optional** because no plain JSON-RPC method carries it: `eth_getBalance`,
   * `eth_getTransactionCount`, and `eth_getCode` do not, and only `eth_getProof` does. Requiring
   * it would put a proof-sized call behind every distinct account a fork touches, and would fail
   * outright against archives that do not implement `eth_getProof`. A backend that already holds
   * proof data may pass it through; a backend serving plain reads omits it. `codeHash` stays
   * mandatory: it is keccak over the code bytes, and the fork backends that consume this resolve
   * accounts as nonce/balance/code-hash anyway.
   */
  getAccount(address: string, blockNumber: number): Promise<{
    readonly nonce: string;
    readonly balanceWei: string;
    readonly codeHash: string;
    readonly storageRoot?: string;
  } | undefined>;
  getCode(address: string, blockNumber: number): Promise<string | undefined>;
  getStorageAt(address: string, slot: string, blockNumber: number): Promise<string | undefined>;
  getBlockHeader(blockNumber: number): Promise<{
    readonly hash: string;
    readonly stateRoot: string;
    readonly timestamp: number;
  } | undefined>;
}

export interface MaterializationRequest {
  readonly record: ChainEnvironmentRecord;
  readonly resources: ResolvedResources;
  /**
   * Assigned by the **caller**, not the runtime (§5.1 step 8). K distinct ids are the verifier's
   * claim about having launched K fresh processes; a runtime that named its own instances would
   * be asserting its own freshness, which is the one party whose word cannot settle it.
   */
  readonly instanceId: string;
  /** Travels with the request (§5.1 step 2), so the attestation describes the run that happened. */
  readonly networkPolicy: NetworkPolicy;
  /**
   * Required whenever `requiresStateBackend(record)` is true — that is, for every
   * `archive-dependent` record. **Normative:** a materializer handed such a record without a
   * backend fails closed; it never falls back to a locator from the record. A `closed-state`
   * record needs no backend at all, and passing one does not make it archive-dependent.
   */
  readonly stateBackend?: ChainStateBackend;
  readonly signal?: AbortSignal;
}

/**
 * A handle a verifying materializer returns: the floor, narrowed to say the report is present.
 * Declared here rather than in the capability so the family carries ONE shape for one instance
 * — a second, wider interface elsewhere is exactly the drift that homing these types in the
 * record package prevents.
 */
export type VerifiedChainInstance = ChainInstance & {
  readonly report: MaterializationReport;
};

/**
 * Brings a described world into existence, and rewinds one to its baseline.
 *
 * `reset` returns the post-reset commitment because `reset-divergence` is decided against it
 * and nothing else can produce it; `stop` disposes an instance and is not a reset. A runner
 * with no rewind mechanism implements `reset` by materializing afresh, which is what a
 * `closed-state` record's `fresh-process` reset mechanism means anyway.
 */
export interface ChainMaterializer {
  materialize(request: MaterializationRequest): Promise<ChainInstance>;
  reset(instance: ChainInstance, signal?: AbortSignal): Promise<`0x${string}`>;
}

export interface ProbeExecutionRequest {
  readonly instance: ChainInstance;
  readonly probeSuite: Uint8Array;
  readonly signal?: AbortSignal;
}

/**
 * The digest is over the **canonical observation**, never over backend JSON (§5.1 step 7).
 * `Observation` is a parameter rather than a named type because the canonical chain observation
 * schema belongs to the evaluation family, not to this package.
 */
export interface ProbeExecutionResult<Observation> {
  readonly observation: Observation;
  readonly observationDigest: `sha256:${string}`;
}

export interface ProbeExecutor<Observation = unknown> {
  execute(request: ProbeExecutionRequest): Promise<ProbeExecutionResult<Observation>>;
}

export interface ReplayRequest {
  readonly instance: ChainInstance;
  readonly script: ChainSolutionScript;
  /** The effective envelope: the record's, as tightened by the task. */
  readonly envelope: CapabilityEnvelope;
  readonly signal?: AbortSignal;
}

/** A script exceeding the envelope is refused, not graded (§6.4, §8). */
export interface ReplayRefusal {
  readonly reason:
    | "envelope-exceeded"
    | "operation-not-permitted"
    | "signer-not-in-scope"
    | "environment-mismatch";
  readonly detail: string;
}

export type ReplayOutcome<Observation = unknown> =
  | {
      readonly status: "replayed";
      readonly observation: Observation;
      readonly observationDigest: `sha256:${string}`;
      /** Values the script reported, by name, for the read-and-report predicate shape. */
      readonly reportedValues: Readonly<Record<string, string>>;
    }
  | { readonly status: "refused"; readonly refusal: ReplayRefusal };

export interface ScriptReplayer<Observation = unknown> {
  replay(request: ReplayRequest): Promise<ReplayOutcome<Observation>>;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test src/solution.test.ts src/ports.test.ts
```

Expected: both suites pass; `Object.keys(ports)` is `[]`, confirming the module compiles away entirely.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): declare the solution-script shape and the materializer/probe/replayer port types"
```

---

### Task 12: The public surface

**Files:**
- Create: `packages/environments/chain-record/src/index.test.ts`
- Modify: `packages/environments/chain-record/src/index.ts`

**Interfaces:**
- Consumes: every module written in Tasks 2–11.
- Produces: the package's root entrypoint, carrying every program §3 pinned name.

- [ ] **Step 1: Write the failing test**

`src/index.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import * as api from "./index.js";

/** Program §3, "CE1 produces". Renaming any of these is a program-plan amendment. */
const PINNED = [
  "CHAIN_ENVIRONMENT_KIND",
  "CHAIN_ENVIRONMENT_MEDIA_TYPE",
  "CRYPTO_ENVIRONMENT_KIND",
  "CRYPTO_ENVIRONMENT_MEDIA_TYPE",
  "sealChainEnvironmentRecord",
  "parseChainEnvironmentRecord",
  "chainEnvironmentRecordDigest",
  "sealCryptoEnvironmentRecord",
  "parseCryptoEnvironmentRecord",
  "cryptoEnvironmentRecordDigest",
  "bareHexDigest",
] as const;

describe("public surface", () => {
  test("exports every pinned name from the program plan", () => {
    for (const name of PINNED) expect(api, name).toHaveProperty(name);
  });

  test("exports the block schemas consumers validate against", () => {
    for (const name of [
      "ChainEnvironmentRecordSchema", "CryptoEnvironmentRecordSchema", "ChainRuntimeSchema",
      "ChainSourceAnchorSchema", "ChainStateMaterializationSchema", "ChainFixturesSchema",
      "DeterminismControlsSchema", "CapabilityEnvelopeSchema", "VerificationContractSchema",
      "CompositionSchema", "WorldReferenceSchema", "InformationWorldReferenceSchema",
      "ServiceRuntimeSchema", "ChainSolutionScriptSchema", "ResourceDescriptorSchema",
      "DigestPinnedDescriptorSchema",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  test("exports the closed vocabularies and the pinned constants", () => {
    for (const name of [
      "RUNTIME_FAMILIES", "CLOSURE_CLASSES", "FIDELITY_CLASSES", "CONSTRUCTION_METHODS",
      "DURABLE_SUPPLY_CLOSURE_CLASS", "FIXTURE_MODULE_KINDS", "MINING_MODES", "RESET_MECHANISMS",
      "FINALITY_POLICIES", "SOLUTION_OPERATION_KINDS", "MINIMUM_VERIFICATION_RUNS",
      "BLACKHOLE_EGRESS_POLICY_ID", "CHAIN_SOLUTION_MEDIA_TYPE", "WELL_KNOWN_DEV_ADDRESSES",
      "CHAIN_ENVIRONMENT_SCHEMA_ID", "CRYPTO_ENVIRONMENT_SCHEMA_ID",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  test("exports the sealing primitives and the digest-conversion pair", () => {
    for (const name of [
      "serializeCanonicalJson", "compareCodeUnitStrings", "sha256Hex", "sealedRecordDigest",
      "prefixedDigest", "InvalidDocumentError", "sealWithSchema", "parseExactWithSchema",
      "isNamespacedExtensionKey", "topLevelRecordSchema", "anchorAuthenticityBoundOf",
      "isWellKnownDevAddress", "sealChainSolutionScript", "parseChainSolutionScript",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  test("the two seal functions return bytes whose digests differ by kind", () => {
    // Minimal-but-real: a chain-only composite needs nothing but its own block.
    const composite = api.sealCryptoEnvironmentRecord({
      kind: api.CRYPTO_ENVIRONMENT_KIND,
      chainWorld: {
        kind: api.CHAIN_ENVIRONMENT_KIND,
        record: { name: "chain", digest: { sha256: "1".repeat(64) } },
      },
      informationWorlds: [],
      serviceRuntimes: [],
      composition: {
        originRouting: [],
        missPolicy: { mode: "declared-response", status: 404 },
        endpointAllowlist: [],
        requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
      },
    });
    expect(composite).toBeInstanceOf(Uint8Array);
    expect(api.cryptoEnvironmentRecordDigest(composite)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("does not leak the testing kit or the fixture loaders through the root entrypoint", () => {
    expect(api).not.toHaveProperty("describeChainEnvironmentRecordConformance");
    expect(api).not.toHaveProperty("loadChainGoldenBytes");
  });

  test("the ports module contributes types only, so no port value appears on the surface", () => {
    for (const name of ["ChainMaterializer", "ProbeExecutor", "ScriptReplayer"]) {
      expect(api, name).not.toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/index.test.ts
```

Expected failure: `expected {} to have property "CHAIN_ENVIRONMENT_KIND"` — `index.ts` is still the stub.

- [ ] **Step 3: Write the implementation**

`src/index.ts`:

```ts
// Public surface of @jinn-network/chain-environment-record.
//
// Two sealed record kinds, the primitives that seal them, and the port TYPE declarations four
// consumers need without taking a dependency on the capability that implements them.

// Pinned identifiers (§4.1, §14)
export {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CHAIN_ENVIRONMENT_MEDIA_TYPE,
  CHAIN_ENVIRONMENT_SCHEMA_ID,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
  CRYPTO_ENVIRONMENT_SCHEMA_ID,
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
export {
  bareHexDigest,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  prefixedDigest,
  sealedRecordDigest,
  sha256Hex,
} from "./hashing.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealWithSchema,
} from "./sealing.js";
export type { ValidationIssue } from "./sealing.js";

// Extension discipline
export { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

// Shared record primitives
export {
  Address,
  BareSha256Hex,
  Bytes32,
  Caip2ChainId,
  Count,
  DigestPinnedDescriptorSchema,
  ExactSemanticVersion,
  HttpOrigin,
  NonEmpty,
  PrefixedSha256,
  Quantity,
  RecordKindUri,
  ResourceDescriptorSchema,
  Rfc3339Utc,
} from "./primitives.js";

// Chain record blocks
export { ChainRuntimeImageSchema, ChainRuntimeSchema, RUNTIME_FAMILIES } from "./runtime.js";
export type { ChainRuntime } from "./runtime.js";
export {
  anchorAuthenticityBoundOf,
  ChainSourceAnchorSchema,
  FINALITY_POLICIES,
} from "./anchor.js";
export type { AnchorAuthenticityBound, ChainSourceAnchor } from "./anchor.js";
export {
  ChainStateMaterializationSchema,
  CLOSURE_CLASSES,
  CONSTRUCTION_METHODS,
  DURABLE_SUPPLY_CLOSURE_CLASS,
  FIDELITY_CLASSES,
  FixtureCoverageSchema,
  SourceProofManifestSchema,
  StateArtifactSchema,
  StateEntryCountsSchema,
} from "./state.js";
export type { ChainStateMaterialization, StateEntryCounts } from "./state.js";
export { isWellKnownDevAddress, WELL_KNOWN_DEV_ADDRESSES } from "./dev-addresses.js";
export {
  ChainFixturesSchema,
  FIXTURE_MODULE_KINDS,
  FixtureAccountSchema,
  FixtureModuleSchema,
} from "./fixture-modules.js";
export type { ChainFixtures } from "./fixture-modules.js";
export {
  DeterminismControlsSchema,
  MEMPOOL_POLICIES,
  MINING_MODES,
  NONCE_POLICIES,
  ORDERING_POLICIES,
  REPLACEMENT_POLICIES,
  RESET_MECHANISMS,
  TIMEOUT_CLOCKS,
} from "./determinism.js";
export type { DeterminismControls } from "./determinism.js";
export { CapabilityEnvelopeSchema } from "./envelope.js";
export type { CapabilityEnvelope } from "./envelope.js";
export { MINIMUM_VERIFICATION_RUNS, VerificationContractSchema } from "./verification-contract.js";
export type { VerificationContract } from "./verification-contract.js";

// The two record kinds
export {
  ChainEnvironmentRecordSchema,
  parseChainEnvironmentRecord,
  requiresStateBackend,
  sealChainEnvironmentRecord,
} from "./chain-record.js";
export type { ChainEnvironmentRecord } from "./chain-record.js";
export {
  CompositionSchema,
  CryptoEnvironmentRecordSchema,
  InformationWorldReferenceSchema,
  parseCryptoEnvironmentRecord,
  sealCryptoEnvironmentRecord,
  ServiceRuntimeSchema,
  WorldReferenceSchema,
} from "./composite.js";
export type { CryptoEnvironmentRecord } from "./composite.js";

// The solution script the replayer consumes
export {
  CHAIN_SOLUTION_MEDIA_TYPE,
  ChainSolutionScriptSchema,
  parseChainSolutionScript,
  sealChainSolutionScript,
  SOLUTION_OPERATION_KINDS,
} from "./solution.js";
export type { ChainSolutionOperation, ChainSolutionScript } from "./solution.js";

// Port contracts (types only — the implementations are the verification capability's)
export type {
  ArtifactEntryObservation,
  ChainInstance,
  ChainMaterializer,
  ChainStateBackend,
  IsolationObservation,
  MaterializationCost,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ProbeExecutionRequest,
  ProbeExecutionResult,
  ProbeExecutor,
  ReplayOutcome,
  ReplayRefusal,
  ReplayRequest,
  ResolvedResources,
  RuntimeIdentityObservation,
  ScriptReplayer,
  VerifiedChainInstance,
} from "./ports.js";
```

- [ ] **Step 4: Run the whole suite and watch it pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test && yarn build
```

Expected: every suite green; `dist/index.d.ts` exists and declares the pinned names.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): export the pinned public surface for both record kinds"
```

---

### Task 13: Golden, equivalence, and adversarial fixtures

**Files:**
- Create: `packages/environments/chain-record/scripts/generate-fixtures.mjs`
- Create: `packages/environments/chain-record/src/fixtures.ts`, `src/fixtures.test.ts`
- Create (generated): `fixtures/chain/*`, `fixtures/composite/*`, `fixtures/equivalence/*`, `fixtures/adversarial-v1/*`

**Interfaces:**
- Consumes: the built `dist/index.js` (Task 12) — the generator imports the package's own compiled surface, so a fixture can never encode a shape the schema refuses.
- Produces: fixture loaders `loadChainGoldenJson` / `loadChainGoldenBytes` / `loadChainGoldenDigest`, `loadCompositeGoldenJson` / `loadCompositeGoldenBytes` / `loadCompositeGoldenDigest`, `loadInvalidJson`, `loadEquivalenceInput`, `loadEquivalenceExpectedDigest`, `loadAdversarialManifest`, `readAdversarialJson`, `readAdversarialBytes`, `loadPublishedSchema`, `chainFixtureUrl`; and the corpora themselves.

Golden names — these are the handles CE3, CE4 and CE5 build tests against, so they are part of the contract:
`chain/closed-anchored-subset`, `chain/closed-local`, `chain/archive-dependent`;
`composite/chain-only`, `composite/composed`, `composite/extension`.

The adversarial corpus carries the nine cases the design's review findings named. Every fixture key in it is freshly generated for that fixture and is not a well-known dev address — except the one case whose whole point is to be one, which the manifest declares `invalid-document`.

- [ ] **Step 1: Write the failing test**

`src/fixtures.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  ChainEnvironmentRecordSchema,
  CryptoEnvironmentRecordSchema,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "./index.js";
import {
  loadAdversarialManifest,
  loadChainGoldenBytes,
  loadChainGoldenDigest,
  loadChainGoldenJson,
  loadCompositeGoldenBytes,
  loadCompositeGoldenDigest,
  loadCompositeGoldenJson,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { isWellKnownDevAddress } from "./dev-addresses.js";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const CHAIN_GOLDEN = ["closed-anchored-subset", "closed-local", "archive-dependent"] as const;
const COMPOSITE_GOLDEN = ["chain-only", "composed", "extension"] as const;

describe.each(CHAIN_GOLDEN)("chain golden: %s", (name) => {
  test("parses under the record schema", async () => {
    expect(ChainEnvironmentRecordSchema.safeParse(await loadChainGoldenJson(name)).success).toBe(true);
  });

  test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
    const resealed = sealChainEnvironmentRecord(await loadChainGoldenJson(name));
    expect(decode(resealed)).toBe(decode(await loadChainGoldenBytes(name)));
    expect(chainEnvironmentRecordDigest(resealed)).toBe(await loadChainGoldenDigest(name));
  });

  test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
    expect(chainEnvironmentRecordDigest(await loadChainGoldenBytes(name)))
      .toBe(await loadChainGoldenDigest(name));
  });

  test("no fixture account is a well-known dev-mnemonic address", async () => {
    const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
    for (const account of record.fixtures.accounts) {
      expect(isWellKnownDevAddress(account.address), account.address).toBe(false);
    }
  });
});

describe.each(COMPOSITE_GOLDEN)("composite golden: %s", (name) => {
  test("parses under the composite schema", async () => {
    expect(CryptoEnvironmentRecordSchema.safeParse(await loadCompositeGoldenJson(name)).success).toBe(true);
  });

  test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
    const resealed = sealCryptoEnvironmentRecord(await loadCompositeGoldenJson(name));
    expect(decode(resealed)).toBe(decode(await loadCompositeGoldenBytes(name)));
    expect(cryptoEnvironmentRecordDigest(resealed)).toBe(await loadCompositeGoldenDigest(name));
  });
});

// Program §4 contract 8, corpus-wide: keys are fresh per record, so no address may appear in
// two golden records. This is the check that catches copy-paste between fixtures.
test("no fixture address is reused across the golden chain records", async () => {
  const seen = new Map<string, string>();
  for (const name of CHAIN_GOLDEN) {
    const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
    for (const account of record.fixtures.accounts) {
      expect(seen.has(account.address), `${account.address} reused: ${seen.get(account.address)} and ${name}`)
        .toBe(false);
      seen.set(account.address, name);
    }
  }
  expect(seen.size).toBeGreaterThan(0);
});

test("key-permuted inputs seal to one pinned digest", async () => {
  const expected = await loadEquivalenceExpectedDigest();
  expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(await loadEquivalenceInput("a"))))
    .toBe(expected);
  expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(await loadEquivalenceInput("b"))))
    .toBe(expected);
});

describe("the adversarial corpus", () => {
  test("declares the nine cases the design's review findings named", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.fixtures.map((entry) => entry.id).sort()).toEqual([
      "anchor-root-as-initial-commitment",
      "artifact-entry-uncovered",
      "bare-extension-key",
      "digest-confusion-bare-hex",
      "index-digest-as-manifest",
      "namespaced-extension-preserved",
      "origin-precedence-undeclared",
      "recanonicalized-bytes",
      "well-known-fixture-address",
    ]);
  });

  test("every entry behaves exactly as its manifest declares", async () => {
    const manifest = await loadAdversarialManifest();
    for (const entry of manifest.fixtures) {
      const schema = entry.recordKind === "crypto-environment"
        ? CryptoEnvironmentRecordSchema
        : ChainEnvironmentRecordSchema;
      if (entry.expectedDisposition === "invalid-bytes") {
        const bytes = await readAdversarialBytes(entry.id);
        expect(() => parseChainEnvironmentRecord(bytes), `${entry.id}: ${entry.description}`).toThrow();
        continue;
      }
      const accepted = schema.safeParse(await readAdversarialJson(entry.id)).success;
      expect(accepted, `${entry.id}: ${entry.description}`)
        .toBe(entry.expectedDisposition === "accepted");
    }
  });

  test("every entry carries a description saying what the attack is", async () => {
    const manifest = await loadAdversarialManifest();
    for (const entry of manifest.fixtures) {
      expect(entry.description.length, entry.id).toBeGreaterThan(40);
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/fixtures.test.ts
```

Expected failure: `Failed to resolve import "./fixtures.js"`.

- [ ] **Step 3: Write the fixture loaders**

`src/fixtures.ts`:

```ts
// The only production-adjacent file permitted to touch the filesystem. It belongs to the
// testing region: `index.ts` never re-exports it, and the source-boundary guard classifies it
// with `testing.ts` and the `*.test.ts` files.
import { readFile } from "node:fs/promises";

export type ChainGoldenName = "closed-anchored-subset" | "closed-local" | "archive-dependent";
export type CompositeGoldenName = "chain-only" | "composed" | "extension";

export interface AdversarialManifestEntry {
  readonly id: string;
  readonly description: string;
  readonly recordKind: "chain-environment" | "crypto-environment";
  readonly expectedDisposition: "accepted" | "invalid-document" | "invalid-bytes";
}

export interface AdversarialManifest {
  readonly fixtures: readonly AdversarialManifestEntry[];
}

/** Resolves a path inside the fixture corpus shipped by this package. */
export function chainFixtureUrl(relativePath: string): URL {
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error("chain fixture paths must stay inside fixtures/");
  }
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function bytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(chainFixtureUrl(relativePath)));
}

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(chainFixtureUrl(relativePath), "utf8"));
}

async function digest(relativePath: string): Promise<`sha256:${string}`> {
  return (await readFile(chainFixtureUrl(relativePath), "utf8")).trim() as `sha256:${string}`;
}

/**
 * A published JSON Schema, read from this package's own `schemas/` directory. It lives here so
 * that exactly ONE file in the package touches the filesystem — the source-boundary guard
 * asserts that literally — and it only ever opens artifacts this package itself ships.
 */
export async function loadPublishedSchema(
  name: "chain-environment" | "crypto-environment",
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export const loadChainGoldenJson = (name: ChainGoldenName) => json(`chain/${name}.json`);
export const loadChainGoldenBytes = (name: ChainGoldenName) => bytes(`chain/${name}.json`);
export const loadChainGoldenDigest = (name: ChainGoldenName) => digest(`chain/${name}.sha256`);

export const loadCompositeGoldenJson = (name: CompositeGoldenName) => json(`composite/${name}.json`);
export const loadCompositeGoldenBytes = (name: CompositeGoldenName) => bytes(`composite/${name}.json`);
export const loadCompositeGoldenDigest = (name: CompositeGoldenName) => digest(`composite/${name}.sha256`);

/** Structurally invalid documents kept beside the goldens for the schema-parity suite. */
export const loadInvalidJson = (name: string) => json(`invalid/${name}.json`);

export const loadEquivalenceInput = (variant: "a" | "b") => json(`equivalence/input-${variant}.json`);

export async function loadEquivalenceExpectedDigest(): Promise<`sha256:${string}`> {
  const parsed = (await json("equivalence/expected-digest.json")) as { digest: string };
  return parsed.digest as `sha256:${string}`;
}

export async function loadAdversarialManifest(): Promise<AdversarialManifest> {
  return (await json("adversarial-v1/manifest.json")) as AdversarialManifest;
}

export const readAdversarialJson = (id: string) => json(`adversarial-v1/${id}/document.json`);
export const readAdversarialBytes = (id: string) => bytes(`adversarial-v1/${id}/document.bytes`);
```

- [ ] **Step 4: Write the fixture generator**

`scripts/generate-fixtures.mjs`:

```js
// Generates the golden, equivalence, invalid, and adversarial corpora from the package's own
// compiled schema. Fixtures are derived from the specification and this generator, never
// captured from a product run. `--write` regenerates; `--check` (the default) detects drift.
//
// Every fixture address below was generated for this corpus and appears in exactly one record.
// The `well-known-fixture-address` case is the sole deliberate exception, and it is declared
// `invalid-document`: it exists to prove the lint fires.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixturesRoot = join(root, "fixtures");

const {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} = await import(join(root, "dist", "index.js"));

const INFORMATION_KIND = "https://jinn.network/records/information-world/1.0";
const prefixed = (hex) => `sha256:${hex.repeat(64)}`;
const bare = (hex) => hex.repeat(64);
const word = (hex) => `0x${hex.repeat(64)}`;
const address = (hex) => `0x${hex.repeat(20)}`;

const runtime = () => ({
  family: "anvil",
  version: "1.3.7",
  image: {
    manifestDigest: prefixed("1"),
    platform: "linux/amd64",
    reference: `registry.example.test/chain/anvil@${prefixed("1")}`,
    indexDigest: prefixed("2"),
  },
  binary: { name: "anvil", digest: prefixed("3"), version: "1.3.7" },
  evm: { hardfork: "cancun", sandboxChainId: 1, nonDefaultSettings: { "disable-code-size-limit": false } },
  launch: { options: { "no-mining": true, order: "fifo" }, commandEvidence: "anvil --no-mining --order fifo" },
});

const anchor = () => ({
  caip2ChainId: "eip155:1",
  nativeChainId: 1,
  genesisHash: word("d"),
  blockNumber: 21000000,
  blockHash: word("e"),
  stateRoot: word("f"),
  timestamp: 1735689600,
  finalityPolicy: "finalized",
});

const controls = () => ({
  miningMode: "manual",
  orderingPolicy: "fifo",
  mempoolPolicy: "none",
  initialBlockNumber: 21000001,
  initialTimestamp: 1735689612,
  blockTimeProgression: { mode: "fixed-increment", secondsPerBlock: 12 },
  baseFeePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  gasPricePolicy: { mode: "fixed", weiPerGas: "1000000000" },
  blockGasLimit: "30000000",
  perTransactionGasCeiling: "15000000",
  coinbase: address("c0"),
  prevrandao: word("9"),
  replacementPolicy: "reject",
  noncePolicy: "strict",
  timeoutClock: "chain-time",
  timeWarp: { maxSecondsPerOperation: 86400, maxAggregateSeconds: 2592000, maxBlocksPerOperation: 7200 },
  resetMechanism: "fresh-process",
});

const envelope = (agent) => ({
  toolInterfaces: [{ id: "jinn.chain-tools", version: "1.0", schema: { name: "tools", digest: { sha256: bare("a") } } }],
  rpc: {
    readMethods: ["eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_getTransactionReceipt"],
    stateChangingMethods: ["eth_sendRawTransaction", "evm_mine", "evm_increaseTime"],
  },
  signerRoles: [{ role: "agent", accounts: [agent] }],
  permittedChainId: 1,
  limits: {
    maxTransactions: 25,
    maxAggregateNativeValueWei: "5000000000000000000",
    tokenSpendPolicies: [{ token: address("d0"), maxSpendUnits: "1000000000" }],
    maxGasPerTransaction: "5000000",
    maxAggregateGas: "60000000",
    maxExecutionDurationMs: 600000,
    maxBlockAdvance: 500,
    maxChainSecondsAdvance: 604800,
  },
  egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
});

const verificationContract = (fixtureIds) => ({
  probeSuite: { descriptor: { name: "probes", digest: { sha256: bare("b") } }, format: { id: "jinn.chain-probes", version: "1" } },
  observationSchema: { name: "observation.schema.json", digest: { sha256: bare("c") } },
  baselineObservationDigest: prefixed("d"),
  comparator: { id: "canonical-observation-eq", version: "1.0.0", digest: prefixed("e") },
  closureCheckRequired: true,
  resetRequirements: { freshInstancePerRun: true, minimumRuns: 5 },
  fixtureProbeCoverage: fixtureIds.map((fixtureId) => ({ fixtureId, probeIds: [`${fixtureId}-smoke`] })),
  policyId: "jinn.chain-verification-policy/1",
});

/** closed-state + anchored-subset: the durable class, with a declared protocol-state mutation. */
const closedAnchoredSubset = () => ({
  kind: CHAIN_ENVIRONMENT_KIND,
  runtime: runtime(),
  sourceAnchor: anchor(),
  stateMaterialization: {
    closureClass: "closed-state",
    fidelityClass: "anchored-subset",
    constructionMethod: "archive-extraction",
    materializer: { id: "anvil-state-loader", version: "0.4.1", digest: prefixed("4") },
    stateArtifact: {
      descriptor: { name: "state.json", mediaType: "application/json", digest: { sha256: bare("5") } },
      format: { id: "jinn.chain-state-slice", version: "1" },
      entryCounts: { accounts: 12, storageSlots: 340, codeEntries: 7 },
    },
    sourceProofManifest: {
      proofFormat: "eip-1186",
      proofs: { name: "proofs.json", digest: { sha256: bare("6") } },
      coverage: { accounts: 9, storageSlots: 331, codeEntries: 7 },
    },
    fixtureCoverage: {
      manifest: { name: "mutations.json", digest: { sha256: bare("7") } },
      declared: { accounts: 3, storageSlots: 9, codeEntries: 0 },
      mutatedProofCoveredAccounts: 2,
    },
    mutatesSourceProtocolState: true,
    initialStateCommitment: word("8"),
  },
  fixtures: {
    modules: [
      { id: "accounts", kind: "funded-accounts", module: { name: "accounts", digest: { sha256: bare("1") } } },
      { id: "addresses", kind: "address-book", module: { name: "addresses", digest: { sha256: bare("2") } } },
      { id: "rates", kind: "state-mutation", module: { name: "rates", digest: { sha256: bare("3") } } },
    ],
    accounts: [
      { role: "agent", address: address("a1"), nativeBalanceWei: "10000000000000000000" },
      { role: "counterparty", address: address("a2"), nativeBalanceWei: "0" },
    ],
  },
  determinismControls: controls(),
  capabilityEnvelope: envelope(address("a1")),
  verificationContract: verificationContract(["accounts", "addresses", "rates"]),
});

/** closed-state + local: no correspondence to any public chain is claimed. */
const closedLocal = () => {
  const record = closedAnchoredSubset();
  delete record.sourceAnchor;
  record.stateMaterialization = {
    closureClass: "closed-state",
    fidelityClass: "local",
    constructionMethod: "local-construction",
    materializer: { id: "anvil-state-loader", version: "0.4.1", digest: prefixed("4") },
    stateArtifact: {
      descriptor: { name: "state.json", digest: { sha256: bare("9") } },
      format: { id: "jinn.chain-state-slice", version: "1" },
      entryCounts: { accounts: 4, storageSlots: 12, codeEntries: 2 },
    },
    initialStateCommitment: word("a"),
  };
  record.fixtures.accounts = [
    { role: "agent", address: address("b1"), nativeBalanceWei: "10000000000000000000" },
    { role: "counterparty", address: address("b2"), nativeBalanceWei: "0" },
  ];
  record.capabilityEnvelope = envelope(address("b1"));
  return record;
};

/** archive-dependent: the authoring/observation class, never durable supply. */
const archiveDependent = () => {
  const record = closedAnchoredSubset();
  record.stateMaterialization = {
    closureClass: "archive-dependent",
    fidelityClass: "anchored-subset",
    constructionMethod: "archive-extraction",
    materializer: { id: "anvil-fork", version: "0.4.1", digest: prefixed("4") },
    archive: {
      requiredCapabilities: ["eth_getProof", "eth_getStorageAt", "eth_getCode"],
      providerLocators: ["https://archive.example.test"],
    },
    mutatesSourceProtocolState: false,
    initialStateCommitment: word("b"),
  };
  record.determinismControls = { ...controls(), resetMechanism: "snapshot-revert" };
  record.verificationContract = { ...verificationContract(["accounts", "addresses", "rates"]), closureCheckRequired: false };
  record.capabilityEnvelope = { ...envelope(address("c1")), egressPolicyId: "jinn.egress.archive-only/1" };
  record.fixtures.accounts = [
    { role: "agent", address: address("c1"), nativeBalanceWei: "10000000000000000000" },
    { role: "counterparty", address: address("c2"), nativeBalanceWei: "0" },
  ];
  return record;
};

const chainOnlyComposite = () => ({
  kind: CRYPTO_ENVIRONMENT_KIND,
  chainWorld: { kind: CHAIN_ENVIRONMENT_KIND, record: { name: "chain", digest: { sha256: bare("1") } } },
  informationWorlds: [],
  serviceRuntimes: [],
  composition: {
    originRouting: [],
    missPolicy: { mode: "declared-response", status: 404 },
    endpointAllowlist: [],
    requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
  },
});

/** Two worlds, one shared origin, precedence declared and total. */
const composedComposite = () => ({
  ...chainOnlyComposite(),
  informationWorlds: [
    { id: "yields", kind: INFORMATION_KIND, record: { name: "yields", digest: { sha256: bare("2") } } },
    { id: "docs", kind: INFORMATION_KIND, record: { name: "docs", digest: { sha256: bare("3") } } },
  ],
  serviceRuntimes: [
    { id: "replay", family: "http-replay", version: "0.2.0", image: { manifestDigest: prefixed("4"), platform: "linux/amd64" } },
  ],
  composition: {
    originRouting: [
      { origin: "https://api.example.test", worldId: "yields", precedence: 0 },
      { origin: "https://api.example.test", worldId: "docs", precedence: 1 },
      { origin: "https://docs.example.test", worldId: "docs", precedence: 0 },
    ],
    missPolicy: { mode: "declared-response", status: 404, body: { name: "miss", digest: { sha256: bare("5") } } },
    endpointAllowlist: ["https://api.example.test", "https://docs.example.test"],
    requestBudget: { maxRequests: 200, maxResponseBytes: 8388608 },
  },
});

const extensionComposite = () => ({
  ...composedComposite(),
  "network.jinn.note": "an extension key a future consumer added",
  "https://example.test/ext/provenance": { collector: "example" },
});

const invalid = {
  "index-digest-as-manifest": () => {
    const document = closedAnchoredSubset();
    document.runtime.image.indexDigest = document.runtime.image.manifestDigest;
    return document;
  },
  "artifact-entry-uncovered": () => {
    const document = closedAnchoredSubset();
    document.stateMaterialization.sourceProofManifest.coverage.storageSlots = 330;
    return document;
  },
  "anchor-root-as-initial-commitment": () => {
    const document = closedAnchoredSubset();
    document.stateMaterialization.initialStateCommitment = document.sourceAnchor.stateRoot;
    return document;
  },
  "bare-extension-key": () => ({ ...closedAnchoredSubset(), note: "not namespaced" }),
  "digest-confusion-bare-hex": () => {
    const document = closedAnchoredSubset();
    document.runtime.image.manifestDigest = bare("1");
    delete document.runtime.image.reference;
    return document;
  },
  "digest-confusion-prefixed-descriptor": () => {
    const document = closedAnchoredSubset();
    document.stateMaterialization.stateArtifact.descriptor.digest.sha256 = prefixed("5");
    return document;
  },
  "well-known-fixture-address": () => {
    const document = closedAnchoredSubset();
    document.fixtures.accounts[0].address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    document.capabilityEnvelope.signerRoles[0].accounts = ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"];
    return document;
  },
  "checksummed-address": () => {
    const document = closedAnchoredSubset();
    document.fixtures.accounts[1].address = "0xA2a2A2a2a2A2a2a2A2a2a2A2a2A2a2A2a2A2a2A2";
    return document;
  },
  "origin-precedence-undeclared": () => {
    const document = composedComposite();
    document.composition.originRouting = [
      { origin: "https://api.example.test", worldId: "yields", precedence: 0 },
      { origin: "https://api.example.test", worldId: "docs", precedence: 0 },
    ];
    return document;
  },
  "snapshot-reset-closed-state": () => {
    const document = closedAnchoredSubset();
    document.determinismControls.resetMechanism = "snapshot-revert";
    return document;
  },
};

const adversarial = {
  "index-digest-as-manifest": {
    recordKind: "chain-environment",
    description:
      "The multi-arch index digest presented as the platform manifest digest. Runtime behaviour "
      + "is a per-platform fact, so an index-level record would be a claim by aggregation.",
    expectedDisposition: "invalid-document",
    document: invalid["index-digest-as-manifest"],
  },
  "artifact-entry-uncovered": {
    recordKind: "chain-environment",
    description:
      "One storage entry in the state artifact is neither proof-covered nor fixture-declared. "
      + "This is the forged-slice gap E13 closes: real protocol code proven against the true "
      + "root, with one tampered slot riding along unaccounted for.",
    expectedDisposition: "invalid-document",
    document: invalid["artifact-entry-uncovered"],
  },
  "anchor-root-as-initial-commitment": {
    recordKind: "chain-environment",
    description:
      "The source anchor's state root presented as the post-fixture initial state commitment. "
      + "They are two claims about two different worlds, and a verifier told they are one would "
      + "read every legitimately fixtured world as a mismatch.",
    expectedDisposition: "invalid-document",
    document: invalid["anchor-root-as-initial-commitment"],
  },
  "origin-precedence-undeclared": {
    recordKind: "crypto-environment",
    description:
      "Two information worlds claiming one origin with no declared precedence between them. "
      + "Resolution would then depend on iteration order, which is a reproducibility hazard "
      + "rather than a merge.",
    expectedDisposition: "invalid-document",
    document: invalid["origin-precedence-undeclared"],
  },
  "bare-extension-key": {
    recordKind: "chain-environment",
    description:
      "An un-namespaced extension key at the top level, indistinguishable from a core field a "
      + "future version might add and therefore from a smuggled one.",
    expectedDisposition: "invalid-document",
    document: invalid["bare-extension-key"],
  },
  "digest-confusion-bare-hex": {
    recordKind: "chain-environment",
    description:
      "Digest confusion, subject spelling in a body position: a bare-hex in-toto DigestSet value "
      + "used where the record body requires the sha256:-prefixed spelling.",
    expectedDisposition: "invalid-document",
    document: invalid["digest-confusion-bare-hex"],
  },
  "well-known-fixture-address": {
    recordKind: "chain-environment",
    description:
      "A fixture account at a well-known development-mnemonic address whose private key is "
      + "public. Publishing scripts from it makes every one of them a replayable transaction "
      + "the moment anyone funds the address.",
    expectedDisposition: "invalid-document",
    document: invalid["well-known-fixture-address"],
  },
  "namespaced-extension-preserved": {
    recordKind: "crypto-environment",
    description:
      "A composite carrying namespaced extension keys, which must reach the sealed bytes and "
      + "re-parse unchanged rather than being dropped or refused.",
    expectedDisposition: "accepted",
    document: extensionComposite,
  },
  "recanonicalized-bytes": {
    recordKind: "chain-environment",
    description:
      "The golden chain record re-serialized with pretty-printing: a valid document whose bytes "
      + "are not the record's bytes, so it must not present as the same record.",
    expectedDisposition: "invalid-bytes",
    bytes: () => `${JSON.stringify(closedAnchoredSubset(), null, 2)}\n`,
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

/** The pinned bytes are the sealed bytes — emitted verbatim, never pretty-printed. */
async function emitGolden(directory, name, build, seal, digest) {
  const sealed = seal(build());
  await emit(`${directory}/${name}.json`, new TextDecoder().decode(sealed));
  await emit(`${directory}/${name}.sha256`, `${digest(sealed)}\n`);
}

await emitGolden("chain", "closed-anchored-subset", closedAnchoredSubset, sealChainEnvironmentRecord, chainEnvironmentRecordDigest);
await emitGolden("chain", "closed-local", closedLocal, sealChainEnvironmentRecord, chainEnvironmentRecordDigest);
await emitGolden("chain", "archive-dependent", archiveDependent, sealChainEnvironmentRecord, chainEnvironmentRecordDigest);
await emitGolden("composite", "chain-only", chainOnlyComposite, sealCryptoEnvironmentRecord, cryptoEnvironmentRecordDigest);
await emitGolden("composite", "composed", composedComposite, sealCryptoEnvironmentRecord, cryptoEnvironmentRecordDigest);
await emitGolden("composite", "extension", extensionComposite, sealCryptoEnvironmentRecord, cryptoEnvironmentRecordDigest);

for (const [name, build] of Object.entries(invalid)) {
  await emit(`invalid/${name}.json`, build());
}

const permuted = (value) =>
  Array.isArray(value)
    ? value.map(permuted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, permuted(member)]))
      : value;

await emit("equivalence/input-a.json", closedAnchoredSubset());
await emit("equivalence/input-b.json", permuted(closedAnchoredSubset()));
await emit("equivalence/expected-digest.json", {
  digest: chainEnvironmentRecordDigest(sealChainEnvironmentRecord(closedAnchoredSubset())),
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
    recordKind: entry.recordKind,
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

- [ ] **Step 5: Generate the corpora and run the test**

```bash
cd packages/environments/chain-record && yarn generate:fixtures && yarn test src/fixtures.test.ts && yarn check:fixtures
```

Expected: the generator prints `fixtures written`; the suite passes; `check:fixtures` prints `fixtures up to date`.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/chain-record
git commit -m "feat(chain-record): generate the golden, equivalence, and nine-case adversarial corpora"
```

---

### Task 14: The conformance kit

**Files:**
- Create: `packages/environments/chain-record/src/testing.ts`, `src/kit.test.ts`

**Interfaces:**
- Consumes: the loaders from `./fixtures.js` (Task 13), the schemas and seal/parse/digest functions from Tasks 9–12, `bareHexDigest` / `prefixedDigest` from `./hashing.js`.
- Produces: `describeChainEnvironmentRecordConformance()` — the driver any implementation producing or consuming these two kinds runs to prove it reproduces the frozen record surface. Shipped at the `./testing` subpath with `vitest` as an **optional** peer.

- [ ] **Step 1: Write the failing test**

`src/kit.test.ts`:

```ts
import { describeChainEnvironmentRecordConformance } from "./testing.js";

describeChainEnvironmentRecordConformance();
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/kit.test.ts
```

Expected failure: `Failed to resolve import "./testing.js"`.

- [ ] **Step 3: Write the kit**

`src/testing.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  type ChainGoldenName,
  type CompositeGoldenName,
  loadAdversarialManifest,
  loadChainGoldenBytes,
  loadChainGoldenDigest,
  loadChainGoldenJson,
  loadCompositeGoldenBytes,
  loadCompositeGoldenDigest,
  loadCompositeGoldenJson,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { anchorAuthenticityBoundOf } from "./anchor.js";
import { ChainEnvironmentRecordSchema, parseChainEnvironmentRecord, sealChainEnvironmentRecord } from "./chain-record.js";
import { CryptoEnvironmentRecordSchema, parseCryptoEnvironmentRecord, sealCryptoEnvironmentRecord } from "./composite.js";
import { isWellKnownDevAddress } from "./dev-addresses.js";
import {
  bareHexDigest,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  prefixedDigest,
} from "./hashing.js";
import {
  CHAIN_ENVIRONMENT_KIND,
  CHAIN_ENVIRONMENT_MEDIA_TYPE,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
} from "./identifiers.js";
import { DURABLE_SUPPLY_CLOSURE_CLASS } from "./state.js";

const CHAIN_GOLDEN: readonly ChainGoldenName[] = ["closed-anchored-subset", "closed-local", "archive-dependent"];
const COMPOSITE_GOLDEN: readonly CompositeGoldenName[] = ["chain-only", "composed", "extension"];

/** Field names a sealed record must not carry: assurance is derived, never stored (§4.5). */
const ABSENT_MUTABLE_STATUS_KEYS = ["status", "health", "expiresAt", "verified", "outcome"];

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Record conformance for the chain-environment and crypto-environment kinds: identifier
 * pinning, schema validation, producer-side re-seal, consumer-side digest checking without
 * re-canonicalization, extension round-tripping, the two-axis assurance surface, the E5 anchor
 * bound, the E13 coverage arithmetic, the composite's routing rules, the digest-confusion
 * boundary in both directions, the fresh-key rule, and the adversarial corpus.
 *
 * Any implementation that produces or consumes these records runs this driver to prove it
 * reproduces the frozen record surface. It asserts what the records ARE; it asserts nothing
 * about whether any world boots or reproduces — those claims live in separately published
 * verification attestations and are bounded there.
 */
export function describeChainEnvironmentRecordConformance(): void {
  describe("Chain environment record conformance", () => {
    test("the pinned identifiers are exactly the design's strings", () => {
      expect(CHAIN_ENVIRONMENT_KIND).toBe("https://jinn.network/records/chain-environment/1.0");
      expect(CHAIN_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.chain-environment.v1+json");
      expect(CRYPTO_ENVIRONMENT_KIND).toBe("https://jinn.network/records/crypto-environment/1.0");
      expect(CRYPTO_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.crypto-environment.v1+json");
    });

    describe.each(CHAIN_GOLDEN)("chain golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(ChainEnvironmentRecordSchema.safeParse(await loadChainGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const resealed = sealChainEnvironmentRecord(await loadChainGoldenJson(name));
        expect(decode(resealed)).toBe(decode(await loadChainGoldenBytes(name)));
        expect(chainEnvironmentRecordDigest(resealed)).toBe(await loadChainGoldenDigest(name));
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(chainEnvironmentRecordDigest(await loadChainGoldenBytes(name)))
          .toBe(await loadChainGoldenDigest(name));
      });

      test("sealing is idempotent through a parse", async () => {
        const once = sealChainEnvironmentRecord(await loadChainGoldenJson(name));
        const twice = sealChainEnvironmentRecord(parseChainEnvironmentRecord(once));
        expect(chainEnvironmentRecordDigest(twice)).toBe(chainEnvironmentRecordDigest(once));
      });

      test("the record declares both assurance axes and carries no mutable status", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        expect(["closed-state", "archive-dependent"]).toContain(record.stateMaterialization.closureClass);
        expect(["local", "anchored-subset", "full-state"]).toContain(record.stateMaterialization.fidelityClass);
        for (const key of ABSENT_MUTABLE_STATUS_KEYS) {
          expect(Object.hasOwn(record, key), `${key} must not exist on a sealed record`).toBe(false);
        }
      });

      test("every determinism knob is fixed, and time advancement is bounded", async () => {
        const { determinismControls } = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        expect(determinismControls.miningMode).not.toBe("interval");
        expect(determinismControls.timeWarp.maxAggregateSeconds).toBeGreaterThanOrEqual(0);
        expect(Object.hasOwn(determinismControls, "prevrandao")).toBe(true);
        expect(Object.hasOwn(determinismControls, "coinbase")).toBe(true);
      });

      test("the capability envelope carries roles and ceilings, never credentials", async () => {
        const { capabilityEnvelope, fixtures } = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        const fixtureAddresses = new Set(fixtures.accounts.map((account) => account.address));
        for (const signer of capabilityEnvelope.signerRoles) {
          expect(Object.hasOwn(signer, "privateKey")).toBe(false);
          for (const account of signer.accounts) expect(fixtureAddresses.has(account)).toBe(true);
        }
        for (const account of fixtures.accounts) {
          expect(Object.hasOwn(account, "privateKey")).toBe(false);
          expect(Object.hasOwn(account, "mnemonic")).toBe(false);
        }
      });

      // Program §4 contract 8: an address someone might fund turns published scripts live.
      test("no fixture account is a well-known development-mnemonic address", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        for (const account of record.fixtures.accounts) {
          expect(isWellKnownDevAddress(account.address), account.address).toBe(false);
        }
      });

      test("the anchor bound is computable from the record alone (E5)", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        const bound = anchorAuthenticityBoundOf(record.sourceAnchor);
        if (record.stateMaterialization.fidelityClass === "local") {
          expect(bound).toBe("not-anchored");
        } else {
          expect(["declared", "header-proven"]).toContain(bound);
        }
      });

      test("a durable-supply record is closed-state and requires the closure check", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        if (record.stateMaterialization.closureClass !== DURABLE_SUPPLY_CLOSURE_CLASS) return;
        expect(record.verificationContract.closureCheckRequired).toBe(true);
        expect(record.verificationContract.resetRequirements.minimumRuns).toBeGreaterThanOrEqual(5);
        expect(record.determinismControls.resetMechanism).toBe("fresh-process");
        expect(record.stateMaterialization.stateArtifact).toBeDefined();
      });

      // E13, restated as an assertion a third party can run over any record they are handed.
      test("every artifact entry is proof-covered or fixture-declared", async () => {
        const { stateMaterialization } = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        const artifact = stateMaterialization.stateArtifact;
        if (artifact === undefined || stateMaterialization.fidelityClass === "local") return;
        const proofs = stateMaterialization.sourceProofManifest;
        const fixtures = stateMaterialization.fixtureCoverage;
        expect(proofs).toBeDefined();
        expect(fixtures).toBeDefined();
        for (const category of ["accounts", "storageSlots", "codeEntries"] as const) {
          expect(proofs!.coverage[category] + fixtures!.declared[category])
            .toBe(artifact.entryCounts[category]);
        }
      });
    });

    describe.each(COMPOSITE_GOLDEN)("composite golden fixture: %s", (name) => {
      test("parses under the composite schema", async () => {
        expect(CryptoEnvironmentRecordSchema.safeParse(await loadCompositeGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const resealed = sealCryptoEnvironmentRecord(await loadCompositeGoldenJson(name));
        expect(decode(resealed)).toBe(decode(await loadCompositeGoldenBytes(name)));
        expect(cryptoEnvironmentRecordDigest(resealed)).toBe(await loadCompositeGoldenDigest(name));
      });

      test("references its chain world by digest and inlines no world content (E11)", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        expect(record.chainWorld.kind).toBe(CHAIN_ENVIRONMENT_KIND);
        expect(record.chainWorld.record.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
        for (const world of record.informationWorlds) {
          expect(world.record.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
      });

      test("no origin is claimed by two worlds without declared precedence", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        const byOrigin = new Map<string, Set<number>>();
        for (const route of record.composition.originRouting) {
          const seen = byOrigin.get(route.origin) ?? new Set<number>();
          expect(seen.has(route.precedence), `${route.origin} precedence ${route.precedence}`).toBe(false);
          seen.add(route.precedence);
          byOrigin.set(route.origin, seen);
        }
      });

      test("a miss returns the declared response; there is no live-fetch mode", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        expect(record.composition.missPolicy.mode).toBe("declared-response");
      });

      test("retrieval is bounded, and a chain-only composite has no information plane", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        if (record.informationWorlds.length === 0) {
          expect(record.composition.requestBudget.maxRequests).toBe(0);
          expect(record.composition.originRouting).toEqual([]);
        } else {
          expect(record.composition.requestBudget.maxRequests).toBeGreaterThan(0);
        }
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      for (const variant of ["a", "b"] as const) {
        expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(await loadEquivalenceInput(variant))))
          .toBe(expected);
      }
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const pretty = new TextEncoder().encode(
        JSON.stringify(await loadChainGoldenJson("closed-anchored-subset"), null, 2),
      );
      expect(() => parseChainEnvironmentRecord(pretty)).toThrow();
    });

    test("namespaced extension keys survive sealing and re-parsing", async () => {
      const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes("extension"));
      expect((record as Record<string, unknown>)["network.jinn.note"]).toBeDefined();
      const resealed = sealCryptoEnvironmentRecord(record);
      expect(decode(resealed)).toBe(decode(await loadCompositeGoldenBytes("extension")));
    });

    // Digest confusion, both directions (program §4 contract 6). Record-body digests are
    // `sha256:`-prefixed; in-toto DigestSet subject values are bare hex. Mixing them is the
    // single most likely wiring error at the record/attestation boundary.
    describe("digest confusion", () => {
      test("the record identity is sha256:-prefixed", async () => {
        expect(chainEnvironmentRecordDigest(await loadChainGoldenBytes("closed-anchored-subset")))
          .toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      test("bareHexDigest yields the DigestSet spelling and prefixedDigest inverts it", async () => {
        const digest = chainEnvironmentRecordDigest(await loadChainGoldenBytes("closed-anchored-subset"));
        const bare = bareHexDigest(digest);
        expect(bare).toMatch(/^[0-9a-f]{64}$/);
        expect(bare.startsWith("sha256:")).toBe(false);
        expect(prefixedDigest(bare)).toBe(digest);
      });

      test("each conversion refuses input already in its output spelling", async () => {
        const digest = chainEnvironmentRecordDigest(await loadChainGoldenBytes("closed-local"));
        expect(() => bareHexDigest(bareHexDigest(digest) as never)).toThrow();
        expect(() => prefixedDigest(digest)).toThrow();
      });

      test("a bare-hex digest in a record-body position is refused", async () => {
        expect(ChainEnvironmentRecordSchema.safeParse(await readAdversarialJson("digest-confusion-bare-hex")).success)
          .toBe(false);
      });
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(9);
      for (const entry of manifest.fixtures) {
        if (entry.expectedDisposition === "invalid-bytes") {
          const bytes = await readAdversarialBytes(entry.id);
          expect(() => parseChainEnvironmentRecord(bytes), `${entry.id}: ${entry.description}`).toThrow();
          continue;
        }
        const schema = entry.recordKind === "crypto-environment"
          ? CryptoEnvironmentRecordSchema
          : ChainEnvironmentRecordSchema;
        const accepted = schema.safeParse(await readAdversarialJson(entry.id)).success;
        expect(accepted, `${entry.id}: ${entry.description}`)
          .toBe(entry.expectedDisposition === "accepted");
      }
    });
  });
}
```

- [ ] **Step 4: Run the kit and watch it pass**

```bash
cd packages/environments/chain-record && yarn typecheck && yarn test
```

Expected: the kit driver runs green under `src/kit.test.ts`; the whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record/src
git commit -m "feat(chain-record): ship the ./testing conformance kit for both record kinds"
```

---

### Task 15: The published JSON Schemas and the parity suite

**Files:**
- Create: `packages/environments/chain-record/scripts/generate-schemas.mjs`
- Create: `packages/environments/chain-record/src/schema-parity.test.ts`
- Create (generated): `schemas/chain-environment.schema.json`, `schemas/crypto-environment.schema.json`

**Interfaces:**
- Consumes: the built `dist/index.js` (Task 12); `loadPublishedSchema` and `loadInvalidJson` from `./fixtures.js` (Task 13); `ajv` (dev only).
- Produces: two published JSON Schemas at the `./schemas/*` subpath, each carrying its kind's `$id`, its namespaced-extension `propertyNames` rule, and a `$comment` naming every cross-field check JSON Schema cannot express.

`z.toJSONSchema` drops `.superRefine()` predicates — which is where nearly every invariant in this package lives. Rather than re-emit each one (many are genuinely inexpressible: the E13 arithmetic, the precedence rule, the anchor coupling), the generator restores the one family that **is** structurally expressible — the namespaced top-level key rule — and documents the rest in `$comment`. The parity suite then pins exactly where the two surfaces agree and where a third party must run the runtime schema to reach the same verdict. Saying so is the honest move; silently shipping a looser schema is not.

- [ ] **Step 1: Write the failing parity test**

`src/schema-parity.test.ts`:

```ts
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  loadChainGoldenJson,
  loadCompositeGoldenJson,
  loadInvalidJson,
  loadPublishedSchema,
} from "./fixtures.js";
import { CHAIN_ENVIRONMENT_SCHEMA_ID, CRYPTO_ENVIRONMENT_SCHEMA_ID } from "./identifiers.js";
import { ChainEnvironmentRecordSchema } from "./chain-record.js";
import { CryptoEnvironmentRecordSchema } from "./composite.js";

const validator = async (name: "chain-environment" | "crypto-environment") =>
  new Ajv2020({ strict: false }).compile(await loadPublishedSchema(name));

describe("published JSON Schemas", () => {
  test("each declares its own kind's schema id", async () => {
    expect((await loadPublishedSchema("chain-environment")).$id).toBe(CHAIN_ENVIRONMENT_SCHEMA_ID);
    expect((await loadPublishedSchema("crypto-environment")).$id).toBe(CRYPTO_ENVIRONMENT_SCHEMA_ID);
  });

  test("accepts every chain golden under a standalone validator", async () => {
    const validate = await validator("chain-environment");
    for (const name of ["closed-anchored-subset", "closed-local", "archive-dependent"] as const) {
      expect(validate(await loadChainGoldenJson(name)), name).toBe(true);
    }
  });

  test("accepts every composite golden under a standalone validator", async () => {
    const validate = await validator("crypto-environment");
    for (const name of ["chain-only", "composed", "extension"] as const) {
      expect(validate(await loadCompositeGoldenJson(name)), name).toBe(true);
    }
  });

  test("rejects the structurally-expressible invalid fixtures on both surfaces", async () => {
    const validate = await validator("chain-environment");
    for (const name of ["bare-extension-key", "digest-confusion-bare-hex", "checksummed-address"]) {
      const document = await loadInvalidJson(name);
      expect(validate(document), `${name}: published schema`).toBe(false);
      expect(ChainEnvironmentRecordSchema.safeParse(document).success, `${name}: runtime`).toBe(false);
    }
  });

  test("a prefixed digest inside a ResourceDescriptor is refused on both surfaces", async () => {
    const document = await loadInvalidJson("digest-confusion-prefixed-descriptor");
    expect((await validator("chain-environment"))(document), "published schema").toBe(false);
    expect(ChainEnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(false);
  });

  describe("the top-level extension rule agrees on both surfaces", () => {
    const withKey = async (key: string) => ({
      ...(await loadChainGoldenJson("closed-local")) as Record<string, unknown>,
      [key]: "x",
    });

    test.each(["note", "network.jinn.x y", "http://example.test/ext a"])(
      "refuses the top-level key %j on both surfaces",
      async (key) => {
        const document = await withKey(key);
        expect((await validator("chain-environment"))(document), "published schema").toBe(false);
        expect(ChainEnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(false);
      },
    );

    test.each(["network.jinn.note", "http://example.test/ext"])(
      "accepts the top-level key %j on both surfaces",
      async (key) => {
        const document = await withKey(key);
        expect((await validator("chain-environment"))(document), "published schema").toBe(true);
        expect(ChainEnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(true);
      },
    );
  });

  // Where the two surfaces DIVERGE, on purpose, and the schema says so rather than pretending.
  test("documents every runtime-only check it cannot express", async () => {
    const chainComment = String((await loadPublishedSchema("chain-environment")).$comment);
    for (const phrase of [
      "source-coverage-incomplete",
      "initialStateCommitment",
      "sourceAnchor",
      "permittedChainId",
      "fixtureProbeCoverage",
      "well-known",
      "canonical",
    ]) {
      expect(chainComment, phrase).toContain(phrase);
    }
    const compositeComment = String((await loadPublishedSchema("crypto-environment")).$comment);
    for (const phrase of ["precedence", "endpointAllowlist", "requestBudget", "canonical"]) {
      expect(compositeComment, phrase).toContain(phrase);
    }
  });

  test("the cross-field cases the published schema cannot catch are still caught at runtime", async () => {
    for (const name of ["artifact-entry-uncovered", "anchor-root-as-initial-commitment", "well-known-fixture-address"]) {
      const document = await loadInvalidJson(name);
      expect((await validator("chain-environment"))(document), `${name}: structurally valid`).toBe(true);
      expect(ChainEnvironmentRecordSchema.safeParse(document).success, `${name}: runtime`).toBe(false);
    }
    const routing = await loadInvalidJson("origin-precedence-undeclared");
    expect((await validator("crypto-environment"))(routing)).toBe(true);
    expect(CryptoEnvironmentRecordSchema.safeParse(routing).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/environments/chain-record && yarn test src/schema-parity.test.ts
```

Expected failure: `ENOENT: no such file or directory, open '.../schemas/chain-environment.schema.json'`.

- [ ] **Step 3: Write the generator**

`scripts/generate-schemas.mjs`:

```js
// Emits the two published JSON Schemas. `--write` regenerates; `--check` detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const mode = process.argv.includes("--write") ? "--write" : "--check";

const {
  CHAIN_ENVIRONMENT_SCHEMA_ID,
  CRYPTO_ENVIRONMENT_SCHEMA_ID,
  ChainEnvironmentRecordSchema,
  CryptoEnvironmentRecordSchema,
} = await import(join(root, "dist", "index.js"));

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

/**
 * `z.toJSONSchema` drops `.superRefine()` predicates. Most of this package's invariants are
 * cross-field and genuinely inexpressible in JSON Schema; the top-level namespacing rule is
 * not, and it is restored here so a third party validating with the published document reaches
 * the same verdict on the case most likely to matter — an un-namespaced key beside a core one.
 * Everything else is named in `$comment` rather than silently omitted.
 */
function emit(schema, { $id, title, description, comment }) {
  const document = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  document.$id = $id;
  document.title = title;
  document.description = description;
  document.propertyNames = {
    anyOf: [{ enum: Object.keys(document.properties ?? {}) }, { pattern: NAMESPACED }],
  };
  document.$comment = comment.join(" ");
  return document;
}

const chain = emit(ChainEnvironmentRecordSchema, {
  $id: CHAIN_ENVIRONMENT_SCHEMA_ID,
  title: "Jinn chain environment record",
  description:
    "A sealed description of one sandboxed chain world: a pinned simulator runtime, an optional "
    + "source anchor, a state materialization with its closure and fidelity classes, ordered "
    + "digest-pinned fixtures, the determinism controls, the agent-facing capability envelope, "
    + "and the verification contract. The document states what the world is; it makes no claim "
    + "that the world boots or reproduces, and it does not assert correspondence to a public "
    + "chain beyond the fidelity class it declares. Those claims live in separately published "
    + "attestations and are bounded there.",
  comment: [
    "Structural validation only. These checks are cross-field and are enforced at runtime, not here:",
    "sourceAnchor is present exactly when fidelityClass is not `local`;",
    "stateMaterialization.initialStateCommitment MUST differ from sourceAnchor.stateRoot;",
    "for a non-local artifact, sourceProofManifest.coverage plus fixtureCoverage.declared must equal",
    "stateArtifact.entryCounts in every category, or the record is source-coverage-incomplete;",
    "mutatesSourceProtocolState must be true when fixtures mutate proof-covered accounts;",
    "capabilityEnvelope.permittedChainId must equal runtime.evm.sandboxChainId;",
    "every signer account must be a declared fixture account, and no fixture account may be a",
    "well-known development-mnemonic address;",
    "verificationContract.fixtureProbeCoverage must name every fixture module and no others;",
    "a closed-state record requires the blackhole egress policy, closureCheckRequired, a state",
    "artifact, no archive declaration, and a fresh-process reset;",
    "runtime.image.reference must end with @<manifestDigest> and indexDigest must differ from it;",
    "and the record's bytes must be the exact RFC 8785 canonical encoding of the document.",
  ],
});

const composite = emit(CryptoEnvironmentRecordSchema, {
  $id: CRYPTO_ENVIRONMENT_SCHEMA_ID,
  title: "Jinn crypto environment record",
  description:
    "A sealed composite of worlds: one chain world, zero or more information worlds, pinned "
    + "service runtimes, and the composition block binding origin routing, precedence, the miss "
    + "policy, the reachable-endpoint allowlist, and the request budget. A task references this "
    + "record; components are sealed and attested independently.",
  comment: [
    "Structural validation only. These checks are cross-field and are enforced at runtime, not here:",
    "chainWorld.kind must be the chain-environment kind and no information world may claim it;",
    "information-world ids and service-runtime ids must be unique;",
    "every route must name a declared world and an origin on the endpointAllowlist;",
    "two worlds may share an origin only at distinct precedence, and one world routes an origin once;",
    "a composite with no information worlds routes nothing and carries a zero requestBudget, while",
    "a composed one requires a positive requestBudget;",
    "and the record's bytes must be the exact RFC 8785 canonical encoding of the document.",
  ],
});

const targets = [
  [join(root, "schemas", "chain-environment.schema.json"), chain],
  [join(root, "schemas", "crypto-environment.schema.json"), composite],
];

let drifted = false;
for (const [target, document] of targets) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (mode === "--write") {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    continue;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) {
    console.error(`published schema is out of date: ${target}`);
    drifted = true;
  }
}

if (drifted) {
  console.error("run `yarn generate:schemas`");
  process.exit(1);
}
console.log(mode === "--write" ? "schemas written" : "schemas up to date");
```

- [ ] **Step 4: Generate, run the parity suite, and check for drift**

```bash
cd packages/environments/chain-record && yarn generate:schemas && yarn test src/schema-parity.test.ts && yarn check:schemas
```

Expected: `schemas written`; the parity suite passes, including the divergence test that proves the four cross-field attacks are caught at runtime and only at runtime; `schemas up to date`.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-record
git commit -m "feat(chain-record): publish both JSON Schemas and pin where they agree with the runtime schema"
```

---

### Task 16: Source boundaries, packed types, pack smoke, and CI

**Files:**
- Create: `packages/environments/chain-record/scripts/pack-smoke.mjs`
- Modify: `.github/scripts/environments-source-boundaries.test.mjs`, `.github/scripts/environments-packed-types.test.mjs`, `.github/workflows/environments-ci.yml`

**Interfaces:**
- Consumes, from `origin/integration/evidence-v1`: the three environments guards and the CI workflow, all registered for `record` and `verification` only.
- Produces: `chain-record` registered in the boundary sweep (with its own testing-region allowance and its own foreign list), in the packed-types entrypoint set, and as a CI job wired into the `verify` gate.

- [ ] **Step 1: Extend the boundary guard so it fails**

In `.github/scripts/environments-source-boundaries.test.mjs`:

```js
const environmentDirectories = ['record', 'verification', 'chain-record'];
```

Add the per-package allowances beside the existing `RECORD_ALLOWED_*` constants:

```js
// `packages/environments/chain-record` is tier 2 with the same purity rules as `record`: zod +
// noble-class primitives only, no ports, no I/O outside the fixture loaders. Two Jinn packages
// are admitted into the TESTING REGION only, for the seal-equivalence legs (program §4
// contract 3): `evidence-protocol` for the evidence tree's digest spelling, and
// `environment-record` for the SWE sibling this package's primitives were materialized from.
// The chain kind is a SIBLING of the SWE kind, never an extension of it, so a production
// import of `environment-record` is a boundary failure and the guard below says so by name.
const CHAIN_RECORD_ALLOWED_DEPENDENCIES = ['@noble/hashes', 'zod'];
const CHAIN_RECORD_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/environment-record', '@jinn-network/evidence-protocol',
  '@types/node', 'ajv', 'canonicalize', 'typescript', 'vitest',
];
const CHAIN_RECORD_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
```

Add the test (place it after the existing `environments source boundaries remain one-way…` test):

```js
test('chain-environment-record stays pure and keeps the SWE kind out of production source', () => {
  const chainRecord = join(packages, 'chain-record');
  const source = join(chainRecord, 'src');
  const testingEntry = join(source, 'testing.ts');
  const fixtureLoaders = join(source, 'fixtures.ts');
  const testRegex = /\.test\.[cm]?[jt]sx?$/u;

  const allFiles = files(source);
  const testingFiles = allFiles.filter((file) =>
    file === testingEntry || file === fixtureLoaders || testRegex.test(file));
  const productionFiles = allFiles.filter((file) => !testingFiles.includes(file));

  // Production source: no Jinn package at all -- including the in-tree SWE record package,
  // which is named explicitly because it is NOT covered by ENVIRONMENTS_FOREIGN_PACKAGES.
  assert.deepEqual(
    forbiddenImportsInFiles(
      productionFiles,
      [...ENVIRONMENTS_FOREIGN_PACKAGES, '@jinn-network/environment-record',
        '@jinn-network/environment-verification', ...NODE_IO_MODULES, 'vitest'],
      [...FORBIDDEN_ROOTS, join(packages, 'record'), join(packages, 'verification')],
    ),
    [],
    'chain-environment-record production source must not import any Jinn package, vitest, or I/O module',
  );
  assert.deepEqual(
    forbiddenImportsInFiles([join(source, 'index.ts')], [], [testingEntry, fixtureLoaders]),
    [],
    'the root entrypoint must not re-export testing.ts or fixtures.ts',
  );

  // Testing region: evidence-protocol and environment-record are admitted for seal equivalence;
  // nothing else Jinn, and no other tree by relative path.
  assert.deepEqual(
    forbiddenImportsInFiles(
      testingFiles,
      ENVIRONMENTS_FOREIGN_PACKAGES.filter((entry) => entry !== '@jinn-network/evidence-*'),
      FORBIDDEN_ROOTS,
    ),
    [],
    'chain-environment-record testing files must not cross into foreign package roots',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(testingFiles, ['@jinn-network/environment-verification']),
    [],
    'the verification capability is never a dependency of a record package, in any region',
  );

  // `node:fs/promises` is permitted in exactly one file.
  const fsUsers = forbiddenImportsInFiles(allFiles, ['node:fs', 'node:fs/promises'])
    .filter((finding) => !finding.startsWith(relative(root, fixtureLoaders)));
  assert.deepEqual(fsUsers, [],
    'only src/fixtures.ts may touch the filesystem, and only to read this package\'s own corpus');

  // `src/ports.ts` declares TYPES only. A value export there would make four consumers depend
  // on an implementation, which is the whole reason the port types live in this package.
  const portsSource = readFileSync(join(source, 'ports.ts'), 'utf8');
  assert.match(portsSource, /^import type /mu,
    'ports.ts must import types only');
  assert.deepEqual(
    [...portsSource.matchAll(/^export\s+(?!type\b|interface\b)/gmu)].map((match) => match[0]),
    [],
    'ports.ts must export only types and interfaces; a runtime value there breaks the contract-only seam',
  );

  // Manifest shape.
  const manifest = JSON.parse(readFileSync(join(chainRecord, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(),
    ['.', './fixtures/*', './schemas/*', './testing']);
  assert.deepEqual(manifest.exports['.'],
    { import: './dist/index.js', types: './dist/index.d.ts' });
  assert.deepEqual(manifest.exports['./testing'],
    { import: './dist/testing.js', types: './dist/testing.d.ts' });
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), CHAIN_RECORD_ALLOWED_DEPENDENCIES);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), CHAIN_RECORD_ALLOWED_DEV_DEPENDENCIES);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), CHAIN_RECORD_ALLOWED_PEER_DEPENDENCIES);
  assert.deepEqual(manifest.peerDependenciesMeta, { vitest: { optional: true } });
});
```

Extend the bounded-claims sweep (the existing `environments source and docs make no unqualified determinism or verification claim` test) so it scans this package too — append to its `candidates` array:

```js
    ...files(join(packages, 'chain-record', 'src')).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file)),
    join(packages, 'chain-record', 'README.md'),
    join(packages, 'chain-record', 'schemas', 'chain-environment.schema.json'),
    join(packages, 'chain-record', 'schemas', 'crypto-environment.schema.json'),
```

- [ ] **Step 2: Run the boundary guard**

```bash
node --test .github/scripts/environments-source-boundaries.test.mjs
```

Expected on the first run: failures naming any bounded-claim slip, any stray import, and the ambient-network / locale canaries now sweeping `chain-record`. Fix each finding in the package source — a `deterministic` or `verified` that is not already bounded by `never`, `bounded`, `attestation`, `MUST NOT`, `no claim`, or an attached negation must be reworded, not exempted.

Expected after fixes: all tests pass.

- [ ] **Step 3: Register the packed-types canary**

In `.github/scripts/environments-packed-types.test.mjs`:

```js
const packages = [
  ['record', '@jinn-network/environment-record'],
  ['verification', '@jinn-network/environment-verification'],
  ['chain-record', '@jinn-network/chain-environment-record'],
];

const codeEntrypoints = [
  '@jinn-network/environment-record',
  '@jinn-network/environment-record/testing',
  '@jinn-network/environment-verification',
  '@jinn-network/environment-verification/testing',
  '@jinn-network/chain-environment-record',
  '@jinn-network/chain-environment-record/testing',
];
```

`CROSS_TREE_PACKAGES` needs no change: `chain-environment-record` has no Jinn runtime dependency, so nothing extra has to be packed for its type surface to resolve.

- [ ] **Step 4: Write the pack smoke**

`scripts/pack-smoke.mjs` — start from the sibling's and change what the tarball must carry:

```bash
git show origin/integration/evidence-v1:packages/environments/record/scripts/pack-smoke.mjs \
  > packages/environments/chain-record/scripts/pack-smoke.mjs
```

Then apply exactly these edits to the copy:

1. Replace the temp-dir prefix and archive name:
   `mkdtemp(join(tmpdir(), "jinn-chain-environment-record-"))` and `join(temporaryRoot, "chain-environment-record.tgz")`.
2. Replace `REQUIRED_ENTRIES` with:

```js
const REQUIRED_ENTRIES = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/testing.js',
  'package/dist/testing.d.ts',
  'package/dist/ports.d.ts',
  'package/schemas/chain-environment.schema.json',
  'package/schemas/crypto-environment.schema.json',
  'package/fixtures/chain/closed-anchored-subset.json',
  'package/fixtures/chain/closed-anchored-subset.sha256',
  'package/fixtures/composite/chain-only.json',
  'package/fixtures/adversarial-v1/manifest.json',
  'package/README.md',
  'package/package.json',
];
```

3. Replace both occurrences of the package name in the consumer manifest and the smoke script with `@jinn-network/chain-environment-record`.
4. Replace the smoke script body with:

```js
    smokeScript,
    `
import { readFile, readdir } from "node:fs/promises";
import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  chainEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";

if (CHAIN_ENVIRONMENT_KIND !== "https://jinn.network/records/chain-environment/1.0"
    || CRYPTO_ENVIRONMENT_KIND !== "https://jinn.network/records/crypto-environment/1.0") {
  throw new Error("root import failed");
}
for (const schema of ["chain-environment", "crypto-environment"]) {
  await readFile(new URL(import.meta.resolve(\`@jinn-network/chain-environment-record/schemas/\${schema}.schema.json\`)));
}
const golden = await readFile(new URL(import.meta.resolve("@jinn-network/chain-environment-record/fixtures/chain/closed-anchored-subset.json")));
const bytes = new Uint8Array(golden.buffer, golden.byteOffset, golden.byteLength);
parseChainEnvironmentRecord(bytes);
const pinned = (await readFile(new URL(import.meta.resolve("@jinn-network/chain-environment-record/fixtures/chain/closed-anchored-subset.sha256")), "utf8")).trim();
if (chainEnvironmentRecordDigest(bytes) !== pinned) {
  throw new Error("packed golden fixture does not match its pinned digest");
}
const composite = await readFile(new URL(import.meta.resolve("@jinn-network/chain-environment-record/fixtures/composite/chain-only.json")));
parseCryptoEnvironmentRecord(new Uint8Array(composite.buffer, composite.byteOffset, composite.byteLength));
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
if (Object.keys(packageJson.dependencies ?? {}).some((name) => name.startsWith('@jinn-network/'))) {
  throw new Error('the chain record package must ship with zero Jinn runtime dependencies');
}
if (packageJson.peerDependencies?.vitest !== '^4.1.8'
    || packageJson.peerDependenciesMeta?.vitest?.optional !== true) {
  throw new Error('the ./testing kit must declare vitest as an exact optional peer');
}
const distFiles = await readdir(${JSON.stringify(join(installedRoot, "dist"))});
if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed package imports, schemas, fixtures, and dependency boundary verified.");
`,
```

- [ ] **Step 5: Run the pack smoke and the packed-types canary**

```bash
cd packages/environments/chain-record && yarn build && yarn pack:smoke && cd -
(cd packages/environments/record && yarn install --immutable && yarn build)
(cd packages/trust/core && yarn install --immutable && yarn build)
(cd packages/environments/verification && yarn install --immutable && yarn build)
node .github/scripts/environments-packed-types.test.mjs
node --test .github/scripts/environments-package-inventory.test.mjs
```

Expected: the smoke prints `Installed package imports, schemas, fixtures, and dependency boundary verified.`; the packed-types canary prints `Compiled a packed TypeScript consumer against 6 public code entrypoints across all 3 environments packages.`; the inventory guard passes.

- [ ] **Step 6: Wire the CI job**

In `.github/workflows/environments-ci.yml`, add the plan to the path filter:

```yaml
      - "docs/superpowers/plans/2026-07-31-chain-ce1-chain-record.md"
      - "docs/superpowers/specs/2026-07-31-chain-environment-family-design.md"
```

Add the job after `record:` (it needs the SWE record package built, for the seal-equivalence leg):

```yaml
  chain-record:
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
      - name: Build the seal-equivalence oracles from source (test-only)
        run: |
          (cd packages/evidence/protocol && yarn install --immutable && yarn build)
          (cd packages/environments/record && yarn install --immutable && yarn build)
      - name: Verify Chain Environment Record
        working-directory: packages/environments/chain-record
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn check:fixtures
          yarn check:schemas
          yarn pack:smoke
      - name: Upload Chain Environment Record distribution
        uses: actions/upload-artifact@v4
        with:
          name: environments-chain-record-dist
          path: packages/environments/chain-record/dist
          if-no-files-found: error
          retention-days: 1
```

In the `verify:` job, add `chain-record` to `needs`, add its result to the env block and the loop, and place its distribution:

```yaml
    needs: [architecture, record, verification, chain-record]
```

```yaml
          CHAIN_RECORD_RESULT: ${{ needs.chain-record.result }}
```

```yaml
            "$CHAIN_RECORD_RESULT"; do
```

```yaml
          mkdir -p packages/environments/chain-record/dist
          cp -R .environments-dist/environments-chain-record-dist/. packages/environments/chain-record/dist/
```

- [ ] **Step 7: Verify the workflow parses and commit**

```bash
node -e "const y=require('node:fs').readFileSync('.github/workflows/environments-ci.yml','utf8'); if(!y.includes('chain-record:')||!y.includes('CHAIN_RECORD_RESULT')) { throw new Error('CI wiring incomplete'); } console.log('workflow wiring present');"
node --test .github/scripts/environments-package-inventory.test.mjs .github/scripts/environments-source-boundaries.test.mjs
git add .github packages/environments/chain-record
git commit -m "chore(chain-record): register the package in the environments guard trio and CI"
```

---

### Task 17: The discovery facts leaf for both kinds

**Files:**
- Create: `packages/discovery/facts/chain-environments/package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`
- Create: `packages/discovery/facts/chain-environments/profiles/chain-environment.1.0.json`, `profiles/crypto-environment.1.0.json`
- Create: `packages/discovery/facts/chain-environments/src/identifiers.ts`, `src/profiles.ts`, `src/recompute.ts`, `src/index.ts`, `src/profiles.test.ts`, `src/recompute.test.ts`, `src/facts-conformance.test.ts`
- Modify: `.github/scripts/record-discovery-package-inventory.test.mjs`, `.github/scripts/record-discovery-source-boundaries.test.mjs`, `.github/scripts/record-discovery-packed-types.test.mjs`, `.github/workflows/record-discovery-ci.yml`

**Interfaces:**
- Consumes, from `origin/integration/evidence-v1` (`@jinn-network/record-discovery-protocol`): `parseFactsProfile`, `assertRecordKindUri`, `recordDigest`, `referenceBearingFields`, `cloudEventsFields`, `RECORD_DISCOVERY_VERSION`, `GENESIS_SEQUENCE`, `verifyItem`, and the types `FactsProfileDocument`, `FactsRecompute`, `RecordFactRecompute`, `RecordFactValue`, `AnnouncedItem`, `AnnouncementEntry`, `ItemOutcome`, `RecordFetcher`. From `@jinn-network/record-discovery-testing`: `digestOf`, `makeInMemoryPorts`. From `@jinn-network/chain-environment-record` (branch `chain/ce1-chain-record`, Task 12): `CHAIN_ENVIRONMENT_KIND`, `CRYPTO_ENVIRONMENT_KIND`, `parseChainEnvironmentRecord`, `parseCryptoEnvironmentRecord`, `sealChainEnvironmentRecord`, `sealCryptoEnvironmentRecord`, `prefixedDigest`. **Verify each symbol exists before writing the tests**; a missing one is a stop-and-report.
- Produces: `chainEnvironmentFactsProfile`, `cryptoEnvironmentFactsProfile`, `chainEnvironmentRecompute`, `cryptoEnvironmentRecompute`, `CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE`, and re-exports of both kind constants validated against discovery's own grammar.

Per the discovery design §12, a per-kind facts profile is a small **leaf package** carrying both edges — `discovery/protocol` and the kind's defining tree — so that discovery never imports a record-defining package and no record package imports discovery. This leaf follows `packages/discovery/facts/environments` exactly, and carries two profiles because both kinds come from one tree.

Facts cards. CF4 requires the state-artifact digest to be reference-bearing so `referrers` inverts it; the composite's chain-world digest is reference-bearing for the same reason, and it is the one that makes "which composites use this chain world" answerable.

`chain-environment.1.0`:

| Field | Class | Reference-bearing | CloudEvents attribute |
| --- | --- | --- | --- |
| `chainEnvironmentRecordDigest` | record | — | — |
| `runtime.family` | record | — | `family` |
| `runtime.version` | record | — | `rtversion` |
| `runtime.image.manifestDigest` | record | **yes** | `image` |
| `stateMaterialization.closureClass` | record | — | `closure` |
| `stateMaterialization.fidelityClass` | record | — | `fidelity` |
| `stateMaterialization.stateArtifactDigest` | record | **yes** (CF4) | `artifact` |

`crypto-environment.1.0`:

| Field | Class | Reference-bearing | CloudEvents attribute |
| --- | --- | --- | --- |
| `cryptoEnvironmentRecordDigest` | record | — | — |
| `chainWorld.digest` | record | **yes** | `chainworld` |
| `informationWorldCount` | record | — | `worlds` |
| `composition.requestBudget.maxRequests` | record | — | `maxrequests` |

`stateMaterialization.stateArtifactDigest` is the only field of either card that is not always present: an `archive-dependent` record has no artifact yet. The recompute omits it in that case, and `recompute.test.ts` pins the behaviour explicitly. **If `verifyItem` treats a card that omits an omitted-by-recompute field as `inconsistent`, stop and report** — that is a discovery-layer finding about optional facts, not something to work around by emitting a placeholder value, which would put a false digest on the wire.

- [ ] **Step 1: Write the failing tests**

`src/profiles.test.ts`:

```ts
import {
  assertRecordKindUri,
  cloudEventsFields,
  referenceBearingFields,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";
import { chainEnvironmentFactsProfile, cryptoEnvironmentFactsProfile } from "./profiles.js";

describe("chain-environment facts profile (CF4)", () => {
  it("binds a record kind discovery's own grammar accepts", () => {
    expect(() => assertRecordKindUri(CHAIN_ENVIRONMENT_KIND)).not.toThrow();
    expect(chainEnvironmentFactsProfile.kind).toBe(CHAIN_ENVIRONMENT_KIND);
    expect(chainEnvironmentFactsProfile.profile).toBe(`${CHAIN_ENVIRONMENT_KIND}/facts/1.0`);
  });

  it("names exactly the fields the leaf declares", () => {
    expect(chainEnvironmentFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "chainEnvironmentRecordDigest",
      "runtime.family",
      "runtime.image.manifestDigest",
      "runtime.version",
      "stateMaterialization.closureClass",
      "stateMaterialization.fidelityClass",
      "stateMaterialization.stateArtifactDigest",
    ]);
  });

  it("declares every field a record fact — a chain environment record has no substrate facts", () => {
    for (const field of chainEnvironmentFactsProfile.fields) expect(field.class).toBe("record");
  });

  it("declares the image and the state artifact reference-bearing so referrers inverts them", () => {
    expect(referenceBearingFields(chainEnvironmentFactsProfile).sort()).toEqual([
      "runtime.image.manifestDigest",
      "stateMaterialization.stateArtifactDigest",
    ]);
  });

  it("lifts the filterable fields into CloudEvents attributes", () => {
    expect(
      cloudEventsFields(chainEnvironmentFactsProfile).map((field) => [field.name, field.cloudEvents?.attribute]),
    ).toEqual([
      ["runtime.family", "family"],
      ["runtime.version", "rtversion"],
      ["runtime.image.manifestDigest", "image"],
      ["stateMaterialization.closureClass", "closure"],
      ["stateMaterialization.fidelityClass", "fidelity"],
      ["stateMaterialization.stateArtifactDigest", "artifact"],
    ]);
  });
});

describe("crypto-environment facts profile", () => {
  it("binds the composite kind", () => {
    expect(() => assertRecordKindUri(CRYPTO_ENVIRONMENT_KIND)).not.toThrow();
    expect(cryptoEnvironmentFactsProfile.kind).toBe(CRYPTO_ENVIRONMENT_KIND);
    expect(cryptoEnvironmentFactsProfile.profile).toBe(`${CRYPTO_ENVIRONMENT_KIND}/facts/1.0`);
  });

  it("names exactly the fields the leaf declares", () => {
    expect(cryptoEnvironmentFactsProfile.fields.map((field) => field.name).sort()).toEqual([
      "chainWorld.digest",
      "composition.requestBudget.maxRequests",
      "cryptoEnvironmentRecordDigest",
      "informationWorldCount",
    ]);
  });

  it("declares the chain-world digest reference-bearing: it is a record-to-record edge", () => {
    expect(referenceBearingFields(cryptoEnvironmentFactsProfile)).toEqual(["chainWorld.digest"]);
  });
});
```

`src/recompute.test.ts`:

```ts
import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
  prefixedDigest,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE,
  chainEnvironmentRecompute,
  cryptoEnvironmentRecompute,
} from "./recompute.js";

const noReferences = { fetch: async () => undefined };

/** The record packages' own goldens are the inputs, so the leaf can never drift from the kind. */
const goldenJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(import.meta.resolve(`@jinn-network/chain-environment-record/fixtures/${path}`)),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("chain-environment record-fact recompute", () => {
  it("recomputes every fact from the record's own sealed bytes", async () => {
    const document = await goldenJson("chain/closed-anchored-subset.json");
    const bytes = sealChainEnvironmentRecord(document);
    const state = document.stateMaterialization as {
      stateArtifact: { descriptor: { digest: { sha256: string } } };
      closureClass: string;
      fidelityClass: string;
    };
    const runtime = document.runtime as { family: string; version: string; image: { manifestDigest: string } };
    expect(await chainEnvironmentRecompute(bytes, noReferences)).toEqual({
      chainEnvironmentRecordDigest: recordDigest(bytes),
      "runtime.family": runtime.family,
      "runtime.version": runtime.version,
      "runtime.image.manifestDigest": runtime.image.manifestDigest,
      "stateMaterialization.closureClass": state.closureClass,
      "stateMaterialization.fidelityClass": state.fidelityClass,
      "stateMaterialization.stateArtifactDigest": prefixedDigest(state.stateArtifact.descriptor.digest.sha256),
    });
  });

  it("omits the artifact fact for a record that has no state artifact yet", async () => {
    const bytes = sealChainEnvironmentRecord(await goldenJson("chain/archive-dependent.json"));
    const facts = await chainEnvironmentRecompute(bytes, noReferences);
    expect(Object.hasOwn(facts, "stateMaterialization.stateArtifactDigest")).toBe(false);
    expect(facts["stateMaterialization.closureClass"]).toBe("archive-dependent");
  });

  it("emits the artifact digest in the record-body spelling, not the DigestSet spelling", async () => {
    const bytes = sealChainEnvironmentRecord(await goldenJson("chain/closed-local.json"));
    const facts = await chainEnvironmentRecompute(bytes, noReferences);
    expect(String(facts["stateMaterialization.stateArtifactDigest"])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("emits no facts for bytes that are not a chain environment record", async () => {
    expect(await chainEnvironmentRecompute(new TextEncoder().encode('{"a":1}'), noReferences)).toEqual({});
  });

  it("emits no facts for re-canonicalized bytes", async () => {
    const document = await goldenJson("chain/closed-local.json");
    const pretty = new TextEncoder().encode(JSON.stringify(document, null, 2));
    expect(await chainEnvironmentRecompute(pretty, noReferences)).toEqual({});
  });
});

describe("crypto-environment record-fact recompute", () => {
  it("recomputes the composite card, counting composed worlds", async () => {
    const document = await goldenJson("composite/composed.json");
    const bytes = sealCryptoEnvironmentRecord(document);
    const chainWorld = document.chainWorld as { record: { digest: { sha256: string } } };
    expect(await cryptoEnvironmentRecompute(bytes, noReferences)).toEqual({
      cryptoEnvironmentRecordDigest: recordDigest(bytes),
      "chainWorld.digest": prefixedDigest(chainWorld.record.digest.sha256),
      informationWorldCount: 2,
      "composition.requestBudget.maxRequests": 200,
    });
  });

  it("reports a chain-only composite as carrying no information plane", async () => {
    const bytes = sealCryptoEnvironmentRecord(await goldenJson("composite/chain-only.json"));
    const facts = await cryptoEnvironmentRecompute(bytes, noReferences);
    expect(facts.informationWorldCount).toBe(0);
    expect(facts["composition.requestBudget.maxRequests"]).toBe(0);
  });
});

describe("the registry", () => {
  it("registers both kinds and nothing else", () => {
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(CHAIN_ENVIRONMENT_KIND)).toBe(chainEnvironmentRecompute);
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get(CRYPTO_ENVIRONMENT_KIND)).toBe(cryptoEnvironmentRecompute);
    expect(CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE.get("https://jinn.network/records/environment/1.0")).toBeUndefined();
  });
});
```

`src/facts-conformance.test.ts`:

```ts
// Leaf facts-conformance at the public verifyItem / facts-consistency boundary, mirroring
// `packages/discovery/facts/environments/src/facts-conformance.test.ts`: the kit's `digestOf`
// and `makeInMemoryPorts` supply the AnnouncementEntry chain and the unused keys/sigs stubs,
// while this leaf's own recompute and a byte-exact RecordFetcher are injected at verifyItem.
import {
  CHAIN_ENVIRONMENT_KIND,
  prefixedDigest,
  sealChainEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
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
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { chainEnvironmentFactsProfile } from "./profiles.js";
import { CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE } from "./recompute.js";

const SOURCE = { agent: "did:key:zChainEnvironmentFactsConformance", name: "facts" };

const goldenJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(import.meta.resolve(`@jinn-network/chain-environment-record/fixtures/${path}`)),
      "utf8",
    ),
  ) as Record<string, unknown>;

async function verify(
  documentPath: string,
  facts: Record<string, unknown>,
): Promise<ItemOutcome> {
  const bytes = sealChainEnvironmentRecord(await goldenJson(documentPath));
  const digest = recordDigest(bytes);
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-31T12:00:00Z",
    announcements: [
      { announcementId: "ann-chain", action: "available", record: { kind: CHAIN_ENVIRONMENT_KIND, digest } },
    ],
  };
  const entryDigest = digestOf(entry);
  const kitPorts = makeInMemoryPorts({ entries: { [entryDigest]: entry } });

  const records: RecordFetcher = {
    async fetch(requested) {
      if (requested === digest) return bytes;
      throw new Error(`no record seeded for ${requested}`);
    },
  };

  const item: AnnouncedItem = {
    record: { kind: CHAIN_ENVIRONMENT_KIND, digest },
    facts,
    provenance: { source: SOURCE, entry: entryDigest, announcementId: "ann-chain" },
  };

  return verifyItem({
    item,
    profile: chainEnvironmentFactsProfile,
    decisionGrade: false,
    ports: {
      records,
      entries: kitPorts.entries,
      keys: kitPorts.keys,
      sigs: kitPorts.sigs,
      factsRecompute: CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE,
      verifiedChain: async () => true,
    },
  });
}

async function truthfulCard(path: string): Promise<Record<string, unknown>> {
  const document = await goldenJson(path);
  const bytes = sealChainEnvironmentRecord(document);
  const runtime = document.runtime as { family: string; version: string; image: { manifestDigest: string } };
  const state = document.stateMaterialization as {
    closureClass: string;
    fidelityClass: string;
    stateArtifact?: { descriptor: { digest: { sha256: string } } };
  };
  const card: Record<string, unknown> = {
    chainEnvironmentRecordDigest: recordDigest(bytes),
    "runtime.family": runtime.family,
    "runtime.version": runtime.version,
    "runtime.image.manifestDigest": runtime.image.manifestDigest,
    "stateMaterialization.closureClass": state.closureClass,
    "stateMaterialization.fidelityClass": state.fidelityClass,
  };
  if (state.stateArtifact !== undefined) {
    card["stateMaterialization.stateArtifactDigest"] = prefixedDigest(state.stateArtifact.descriptor.digest.sha256);
  }
  return card;
}

describe("facts/chain-environments leaf conformance via verifyItem", () => {
  it("consistent: a truthful card matches the recomputed facts", async () => {
    expect(await verify("chain/closed-anchored-subset.json", await truthfulCard("chain/closed-anchored-subset.json")))
      .toEqual({ status: "verified", facts: "consistent" });
  });

  // The optional-field case. A failure here is a discovery-layer finding about optional facts,
  // not a licence to emit a placeholder digest.
  it("consistent: a record with no state artifact announces a card that omits the artifact fact", async () => {
    expect(await verify("chain/archive-dependent.json", await truthfulCard("chain/archive-dependent.json")))
      .toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a card overstating the closure class", async () => {
    const card = await truthfulCard("chain/archive-dependent.json");
    card["stateMaterialization.closureClass"] = "closed-state";
    expect(await verify("chain/archive-dependent.json", card))
      .toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card overstating the fidelity class", async () => {
    const card = await truthfulCard("chain/closed-local.json");
    card["stateMaterialization.fidelityClass"] = "full-state";
    expect(await verify("chain/closed-local.json", card))
      .toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card claiming a different runtime image", async () => {
    const card = await truthfulCard("chain/closed-anchored-subset.json");
    card["runtime.image.manifestDigest"] = `sha256:${"9".repeat(64)}`;
    expect(await verify("chain/closed-anchored-subset.json", card))
      .toEqual({ status: "verified", facts: "inconsistent" });
  });
});
```

- [ ] **Step 2: Write the leaf scaffold and run the tests to watch them fail**

Copy the sibling leaf's config files and build script, then write the manifest:

```bash
mkdir -p packages/discovery/facts/chain-environments/{src,scripts,profiles}
for f in tsconfig.json tsconfig.build.json .yarnrc.yml vitest.config.ts scripts/build.mjs; do
  cp "packages/discovery/facts/environments/$f" "packages/discovery/facts/chain-environments/$f"
done
cp packages/discovery/facts/environments/scripts/pack-smoke.mjs packages/discovery/facts/chain-environments/scripts/pack-smoke.mjs
```

In the copied `scripts/pack-smoke.mjs`, replace every occurrence of
`@jinn-network/record-discovery-facts-environments` with
`@jinn-network/record-discovery-facts-chain-environments`, every occurrence of
`@jinn-network/environment-record` with `@jinn-network/chain-environment-record`, and the
profile asset path `profiles/environment.1.0.json` with the two paths
`profiles/chain-environment.1.0.json` and `profiles/crypto-environment.1.0.json`.

`packages/discovery/facts/chain-environments/package.json`:

```json
{
  "name": "@jinn-network/record-discovery-facts-chain-environments",
  "version": "0.1.0",
  "description": "Facts-profile documents and record-fact recompute for the Jinn chain-environment and crypto-environment record kinds.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/discovery/facts/chain-environments"
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
    "@jinn-network/chain-environment-record": "0.1.0",
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
    "@jinn-network/chain-environment-record": "portal:../../../environments/chain-record",
    "@jinn-network/record-discovery-protocol": "portal:../../protocol",
    "@jinn-network/record-discovery-testing": "portal:../../testing",
    "@jinn-network/trust-core": "portal:../../../trust/core"
  }
}
```

`README.md`:

```md
# @jinn-network/record-discovery-facts-chain-environments

Facts profiles and record-fact recompute for two record kinds:
`chain-environment/1.0` and `crypto-environment/1.0`.

A leaf carries both edges — the discovery protocol and the tree that defines the kinds — so
discovery never imports a record-defining package and no record package imports discovery.

Facts are recomputed from a record's own sealed bytes. A card attached to re-serialized bytes
recomputes to nothing and reads as inconsistent.
```

```bash
cd packages/discovery/facts/chain-environments && yarn install && yarn test
```

Expected failure: `Failed to resolve import "./identifiers.js"`.

- [ ] **Step 3: Write the profiles and the implementation**

`profiles/chain-environment.1.0.json`:

```json
{
  "protocol": "https://jinn.network/record-discovery/1.0",
  "kind": "https://jinn.network/records/chain-environment/1.0",
  "profile": "https://jinn.network/records/chain-environment/1.0/facts/1.0",
  "fields": [
    { "name": "chainEnvironmentRecordDigest", "class": "record" },
    { "name": "runtime.family", "class": "record", "cloudEvents": { "attribute": "family", "scalar": "string" } },
    { "name": "runtime.version", "class": "record", "cloudEvents": { "attribute": "rtversion", "scalar": "string" } },
    { "name": "runtime.image.manifestDigest", "class": "record", "referenceBearing": true, "cloudEvents": { "attribute": "image", "scalar": "string" } },
    { "name": "stateMaterialization.closureClass", "class": "record", "cloudEvents": { "attribute": "closure", "scalar": "string" } },
    { "name": "stateMaterialization.fidelityClass", "class": "record", "cloudEvents": { "attribute": "fidelity", "scalar": "string" } },
    { "name": "stateMaterialization.stateArtifactDigest", "class": "record", "referenceBearing": true, "cloudEvents": { "attribute": "artifact", "scalar": "string" } }
  ]
}
```

`profiles/crypto-environment.1.0.json`:

```json
{
  "protocol": "https://jinn.network/record-discovery/1.0",
  "kind": "https://jinn.network/records/crypto-environment/1.0",
  "profile": "https://jinn.network/records/crypto-environment/1.0/facts/1.0",
  "fields": [
    { "name": "cryptoEnvironmentRecordDigest", "class": "record" },
    { "name": "chainWorld.digest", "class": "record", "referenceBearing": true, "cloudEvents": { "attribute": "chainworld", "scalar": "string" } },
    { "name": "informationWorldCount", "class": "record", "cloudEvents": { "attribute": "worlds", "scalar": "number" } },
    { "name": "composition.requestBudget.maxRequests", "class": "record", "cloudEvents": { "attribute": "maxrequests", "scalar": "number" } }
  ]
}
```

`src/identifiers.ts`:

```ts
import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
} from "@jinn-network/chain-environment-record";
import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";

// Validate the record package's own constants against discovery's authoritative record-kind
// grammar. The record package is tier 2 with zero Jinn dependencies, so it cannot perform this
// check itself; the leaf carries both edges and is the right place for it. The leaf never
// hardcodes a second copy of either string.
assertRecordKindUri(CHAIN_ENVIRONMENT_KIND);
assertRecordKindUri(CRYPTO_ENVIRONMENT_KIND);

export { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND };
```

`src/profiles.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFactsProfile } from "@jinn-network/record-discovery-protocol";
import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// Declarative field labeling only, loaded from the bundled `profiles/*.json` and parsed (and
// record-kind-URI-validated) through protocol's owned contract.

const profilesRoot = new URL("../profiles/", import.meta.url);

function loadProfile(filename: string): FactsProfileDocument {
  return parseFactsProfile(
    JSON.parse(readFileSync(fileURLToPath(new URL(filename, profilesRoot)), "utf8")),
  );
}

export const chainEnvironmentFactsProfile: FactsProfileDocument =
  loadProfile("chain-environment.1.0.json");

export const cryptoEnvironmentFactsProfile: FactsProfileDocument =
  loadProfile("crypto-environment.1.0.json");
```

`src/recompute.ts`:

```ts
import {
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  prefixedDigest,
} from "@jinn-network/chain-environment-record";
import { recordDigest } from "@jinn-network/record-discovery-protocol";
import type {
  FactsRecompute,
  RecordFactRecompute,
  RecordFactValue,
} from "@jinn-network/record-discovery-protocol";

import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";

/**
 * Recomputes the chain-environment card from the record's own sealed BYTES — never from a
 * supplied projection. `parseChainEnvironmentRecord` requires the exact canonical encoding, so
 * a card attached to re-serialized bytes recomputes to nothing and reads as inconsistent.
 *
 * Two fields are declared *reference-bearing* so discovery's `referrers` relation inverts them:
 * the runtime image (an OCI manifest, not an announceable record) and the state artifact (CF4).
 * Neither is a record, so there are no referenced bytes to retrieve and re-hash; both are
 * emitted directly. Reference-bearing labels an indexing relation and does not by itself imply
 * a retrievable record.
 *
 * The artifact digest is lifted from the in-toto DigestSet's bare-hex spelling into the
 * record-body `sha256:` spelling every other digest fact carries, so one card never mixes two
 * spellings of one kind of value. An `archive-dependent` record has no artifact yet, and the
 * fact is then absent rather than empty.
 */
export const chainEnvironmentRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseChainEnvironmentRecord(bytes);
    const facts: Record<string, RecordFactValue> = {
      chainEnvironmentRecordDigest: recordDigest(bytes),
      "runtime.family": record.runtime.family,
      "runtime.version": record.runtime.version,
      "runtime.image.manifestDigest": record.runtime.image.manifestDigest,
      "stateMaterialization.closureClass": record.stateMaterialization.closureClass,
      "stateMaterialization.fidelityClass": record.stateMaterialization.fidelityClass,
    };
    const artifactDigest = record.stateMaterialization.stateArtifact?.descriptor.digest?.sha256;
    if (artifactDigest !== undefined) {
      facts["stateMaterialization.stateArtifactDigest"] = prefixedDigest(artifactDigest);
    }
    return facts;
  } catch {
    return {};
  }
};

/**
 * The composite card. `chainWorld.digest` is a genuine record-to-record edge — the one that
 * makes "which composites use this chain world" answerable — and is emitted in the record-body
 * spelling for the same reason as above. `informationWorldCount` is the cheapest honest signal
 * of whether a composite has an information plane at all.
 */
export const cryptoEnvironmentRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const record = parseCryptoEnvironmentRecord(bytes);
    const chainWorldDigest = record.chainWorld.record.digest?.sha256;
    if (chainWorldDigest === undefined) return {};
    const facts: Record<string, RecordFactValue> = {
      cryptoEnvironmentRecordDigest: recordDigest(bytes),
      "chainWorld.digest": prefixedDigest(chainWorldDigest),
      informationWorldCount: record.informationWorlds.length,
      "composition.requestBudget.maxRequests": record.composition.requestBudget.maxRequests,
    };
    return facts;
  } catch {
    return {};
  }
};

/**
 * The leaf's `FactsRecompute` registry entry: the host assembles the tree-wide registry by
 * merging each leaf's export. Unknown kinds return `undefined`, preserving discovery's
 * unknown-kind skip behaviour — which is what lets a new record kind deploy with no protocol
 * change at all.
 */
export const CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    if (kind === CHAIN_ENVIRONMENT_KIND) return chainEnvironmentRecompute;
    if (kind === CRYPTO_ENVIRONMENT_KIND) return cryptoEnvironmentRecompute;
    return undefined;
  },
};
```

`src/index.ts`:

```ts
// Public surface of @jinn-network/record-discovery-facts-chain-environments.

export * from "./identifiers.js";
export * from "./profiles.js";
export * from "./recompute.js";
```

- [ ] **Step 4: Run the leaf's suite**

```bash
(cd packages/environments/chain-record && yarn build)
(cd packages/discovery/protocol && yarn install --immutable && yarn build)
(cd packages/discovery/testing && yarn install --immutable && yarn build)
cd packages/discovery/facts/chain-environments && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
```

Expected: all three suites pass, including the optional-artifact conformance case.

- [ ] **Step 5: Register the leaf in the record-discovery guards**

`.github/scripts/record-discovery-package-inventory.test.mjs`:

```js
  ['facts/chain-environments', '@jinn-network/record-discovery-facts-chain-environments'],
```

added to `DISCOVERY_PACKAGES`;

```js
  ['@jinn-network/chain-environment-record', join(root, 'packages', 'environments', 'chain-record')],
```

added to `SIBLING_TREE_DIRS`; and to `JINN_DEPENDENCY_GRAPH`:

```js
  // facts/chain-environments carries the one sanctioned edge between the discovery tree and the
  // chain-environment record-kind tree (discovery design §12; chain design §3): protocol +
  // chain-environment-record. `record-discovery-testing` is a test-only devDependency for the
  // conformance driver, and `trust-core` is the usual shadow entry — protocol's own transitive
  // dependency needs a matching top-level override in every standalone per-package project.
  // chain-environment-record has NO Jinn dependency of its own, so no second shadow is needed.
  ['facts/chain-environments', { dependencies: ['@jinn-network/chain-environment-record', '@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
```

`.github/scripts/record-discovery-source-boundaries.test.mjs`: add `'facts/chain-environments'` to `discoveryDirectories`; add `'@jinn-network/record-discovery-facts-chain-environments'` to **every** existing per-package forbidden list (each leaf forbids every other leaf); add the new leaf's own forbidden list and boundary test beside the `facts/environments` pair:

```js
// facts/chain-environments carries the one sanctioned edge between the discovery tree and the
// chain-environment record-kind tree (discovery design §12): protocol + chain-environment-record
// are allowed; no serve/client, no other facts/* leaf, no TEP, no evidence, no benchmarking, and
// not the SWE environment-record package either — the chain kinds are siblings of it, not
// extensions of it.
const FACTS_CHAIN_ENVIRONMENTS_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence',
  '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/record-discovery-source-evidence-journal',
  '@jinn-network/environment-record',
  '@jinn-network/environment-verification',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/evidence-protocol',
  '@jinn-network/benchmarking-records',
  '@jinn-network/trust-core',
];

test('record-discovery-facts-chain-environments production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'facts', 'chain-environments', 'src'), FACTS_CHAIN_ENVIRONMENTS_FORBIDDEN_PACKAGES);
});
```

`.github/scripts/record-discovery-packed-types.test.mjs`: add the package row, add
`'@jinn-network/record-discovery-facts-chain-environments'` to the entrypoint list, and add
`['@jinn-network/chain-environment-record', join(root, 'packages', 'environments', 'chain-record')]`
to the cross-tree packing map.

- [ ] **Step 6: Wire the record-discovery CI job**

In `.github/workflows/record-discovery-ci.yml`, add a `facts-chain-environments:` job — copy the
`facts-environments:` job verbatim and change: the job name; the portal build line to
`(cd packages/environments/chain-record && yarn install --immutable && yarn build)`; the
`working-directory` to `packages/discovery/facts/chain-environments`; the step name to
`Verify Record Discovery Facts (Chain Environments)`; and the artifact name/path to
`record-discovery-facts-chain-environments-dist` / `packages/discovery/facts/chain-environments/dist`.

Then in the `verify:` job: add `facts-chain-environments` to `needs`, add
`FACTS_CHAIN_ENVIRONMENTS_RESULT: ${{ needs.facts-chain-environments.result }}` to the env block
and `"$FACTS_CHAIN_ENVIRONMENTS_RESULT"` to the result loop, add
`[facts-chain-environments]=facts/chain-environments` to the `target` map, and add
`(cd packages/environments/chain-record && yarn install --immutable && yarn build)` to the
cross-tree portal build step.

- [ ] **Step 7: Run the three record-discovery guards and commit**

```bash
node --test .github/scripts/record-discovery-package-inventory.test.mjs .github/scripts/record-discovery-source-boundaries.test.mjs
node .github/scripts/record-discovery-packed-types.test.mjs
git add .github packages/discovery/facts/chain-environments
git commit -m "feat(chain-record): add the chain-environments discovery facts leaf for both kinds"
```

Expected: the inventory and boundary guards pass; the packed-types canary compiles a consumer against every discovery entrypoint including the new leaf.

---

### Task 18: Component verification

**Files:** none created; this task runs everything and shows output.

**Interfaces:**
- Consumes: every artifact produced by Tasks 1–17.
- Produces: the evidence the component review gate requires.

- [ ] **Step 1: Full local verification, output shown**

```bash
cd "$(git rev-parse --show-toplevel)"
(cd packages/evidence/protocol && yarn install --immutable && yarn build)
(cd packages/trust/core && yarn install --immutable && yarn build)
(cd packages/environments/record && yarn install --immutable && yarn build)
(cd packages/environments/chain-record && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn check:fixtures && yarn check:schemas && yarn pack:smoke)
(cd packages/discovery/protocol && yarn install --immutable && yarn build)
(cd packages/discovery/testing && yarn install --immutable && yarn build)
(cd packages/discovery/facts/chain-environments && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
node --test .github/scripts/environments-package-inventory.test.mjs \
              .github/scripts/environments-source-boundaries.test.mjs \
              .github/scripts/record-discovery-package-inventory.test.mjs \
              .github/scripts/record-discovery-source-boundaries.test.mjs
node .github/scripts/environments-packed-types.test.mjs
node .github/scripts/record-discovery-packed-types.test.mjs
```

Expected: every command exits 0. Paste the tail of each into the task report — a claim of green without the output is not verification.

- [ ] **Step 2: Assert the pinned interface by name**

```bash
node -e "
const api = await import('./packages/environments/chain-record/dist/index.js');
const pinned = ['ChainEnvironmentRecordSchema','CryptoEnvironmentRecordSchema',
 'sealChainEnvironmentRecord','sealCryptoEnvironmentRecord','parseChainEnvironmentRecord',
 'parseCryptoEnvironmentRecord','chainEnvironmentRecordDigest','cryptoEnvironmentRecordDigest',
 'bareHexDigest','CHAIN_ENVIRONMENT_KIND','CHAIN_ENVIRONMENT_MEDIA_TYPE','CRYPTO_ENVIRONMENT_KIND',
 'CRYPTO_ENVIRONMENT_MEDIA_TYPE'];
const missing = pinned.filter((name) => !(name in api));
if (missing.length) throw new Error('missing pinned exports: ' + missing.join(', '));
console.log('all ' + pinned.length + ' pinned exports present');
" --input-type=module
grep -c 'ChainMaterializer\|ProbeExecutor\|ScriptReplayer' packages/environments/chain-record/dist/index.d.ts
```

Expected: `all 13 pinned exports present`, and the port types appear in the emitted declarations.

- [ ] **Step 3: Sweep for placeholder and unbounded-claim language**

```bash
grep -rnE 'TODO|FIXME|TBD|placeholder' packages/environments/chain-record/src packages/discovery/facts/chain-environments/src && echo "FOUND — fix before reporting done" || echo "no placeholders"
grep -rniE '\b(deterministic|verified|guaranteed|reliable)\b' packages/environments/chain-record/README.md packages/environments/chain-record/schemas/*.json
```

Expected: `no placeholders`; every claim-word hit in the second sweep is already bounded (the boundary guard in Task 16 is the gate, this is the eyeball pass).

- [ ] **Step 4: Confirm the corpus obeys contract 8 across every fixture**

```bash
node -e "
import { readdir, readFile } from 'node:fs/promises';
const { WELL_KNOWN_DEV_ADDRESSES } = await import('./packages/environments/chain-record/dist/index.js');
const roots = ['fixtures/chain','fixtures/composite','fixtures/adversarial-v1'];
const hits = [];
for (const root of roots) {
  const dir = 'packages/environments/chain-record/' + root;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = entry.parentPath + '/' + entry.name;
    const text = (await readFile(path, 'utf8')).toLowerCase();
    for (const address of WELL_KNOWN_DEV_ADDRESSES) {
      if (text.includes(address)) hits.push(path + ' -> ' + address);
    }
  }
}
const expected = ['adversarial-v1/well-known-fixture-address/document.json'];
const unexpected = hits.filter((hit) => !expected.some((path) => hit.includes(path)));
if (unexpected.length) throw new Error('dev address outside the deliberate fixture:\n' + unexpected.join('\n'));
console.log('contract 8 clean: ' + hits.length + ' hit(s), all in the deliberate lint fixture');
" --input-type=module
```

Expected: `contract 8 clean: 1 hit(s), all in the deliberate lint fixture`.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin chain/ce1-chain-record
gh pr create --base integration/evidence-v1 --title "feat(chain-record): the chain-environment and crypto-environment record kinds" --body "$(cat <<'EOF'
CE1 of the chain environment family program. Ships `@jinn-network/chain-environment-record`:
the `chain-environment/1.0` and `crypto-environment/1.0` kinds, locally re-implemented sealing
with three-oracle equivalence, the materializer/probe/replayer port types, golden + nine-case
adversarial fixtures, the `./testing` kit, two published JSON Schemas, and the
`facts/chain-environments` discovery leaf — registered in both existing guard trios and both CI
workflows.

Design: `docs/superpowers/specs/2026-07-31-chain-environment-family-design.md`
Plan: `docs/superpowers/plans/2026-07-31-chain-ce1-chain-record.md`

Findings carried into review are in the plan's closing section.
EOF
)"
```

---

## Component review gate

Per program §5, before CE3 or CE6 branch off this one: kit + guards green (Task 18's output), then **one independent high-effort review against the design**. The review's checklist is the design's own §4:

- §4.1 — three kinds named, two implemented here, media types and sealing rules exactly as written; unsigned; `supersedes` present and static.
- §4.2 — both axes independent; `closed-state` eligibility rules; E13 coverage enforced *and* `mutatesSourceProtocolState` visible; E5's bound computable from the record; the boundary rule stated honestly in the README (a slice is a slice, and out-of-slice reads are empty, not errors).
- §4.3 — every named block field present, including every determinism knob and every envelope ceiling.
- §4.4 — the composite's four members; precedence explicit and probed; miss policy fail-closed; allowlist and budget enforced; the chain-only case really empty.
- §4.5 — nothing mutable anywhere in either record.
- Program §3 — every pinned name exported with the pinned signature.
- Program §4 contracts 3, 4, 6, 8, 9 — equivalence legs present; purity guarded; digest confusion fixtured both ways; the dev-address lint hard-rejects; both guard trios and both CI workflows updated in this PR.

## Findings this plan carries into the component review

Dated 2026-07-31. Each is a **finding with a proposed disposition**, not a silent patch. The plan implements the non-conflicting interpretation named in each disposition.

**CE1-F1 — The post-fixture commitment is described in two blocks.** Design §4.3 puts
`initialStateCommitment` in the state-materialization block ("the post-fixture, agent-visible
world's commitment") and also has the fixtures block "closing with the post-fixture commitment."
Those are one value. A sealed record carrying it twice creates a surface for the two copies to
disagree, and nothing in the design says which copy wins.
*Disposition:* one field, `stateMaterialization.initialStateCommitment`. The fixtures block
closes by reference, not by copy. If the design intended two distinct commitments — say, one
before and one after fixture application — that is a design amendment, and the second field
needs a name and a stated relationship to the first.

**CE1-F9 — SETTLED by coordinator ruling CR3: the port types widened to carry the
verification protocol's facts.** The verification component's F-CE3-12 and the extraction
component's F-CE4-1 both landed against the first draft of `ports.ts`, which declared a
three-member `ChainInstance` and a `{record, resources, signal?}` request. Neither carried the
facts §5.1 steps 2–6 and 9 read, and neither had a seam for injected chain state.
*Disposition (adopted):* CE1 widens rather than letting a consumer declare a parallel interface,
because program §3 homes these types here precisely to stop the family carrying two shapes for
one instance. `MaterializationRequest` gains a **caller-assigned** `instanceId` (K distinct ids
are the verifier's claim, not the runtime's), a `networkPolicy` that travels with the request,
and an optional `stateBackend`. `ChainInstance` gains `report: MaterializationReport` carrying
runtime identity with `unsupportedControls`, the artifact entry index, the post-fixture
commitment, loaded resources, isolation evidence, and cost. `ChainMaterializer` gains `reset`.
Three corrections were made to the proposed shape while adopting it: (1) `postFixtureCommitment`
and `reset`'s return are `` `0x${string}` ``, not `` `sha256:${string}` `` — §5.1 step 5 compares
them directly against `stateMaterialization.initialStateCommitment`, which the record spells as
`0x` + 64 lowercase hex, and a comparison across two spellings is a conversion nobody specified;
(2) `artifactEntries` uses `accounts` / `codeEntries` / `storageSlots`, matching
`StateEntryCounts` member-for-member, because E13's coverage is computed against that census and
two vocabularies for one partition is how an off-by-one mapping gets written and never noticed;
(3) `report` is **optional** on the floor handle and `VerifiedChainInstance` — declared here, so
still one shape — narrows it, because the solver's own local runner is the decisive consumer in
§3's seam argument and requiring it to produce isolation evidence and cost observations would
make it pay for the capability it exists to avoid. A materializer that returns no report cannot
be verified; that is an infrastructure failure the verifier names, not a claim it makes anyway.

**CE1-F10 — Archive-dependent materialization takes an injected state backend, and the record's
locators are not an instruction.** Design §4.3 lets an `archive-dependent` record carry
`archive.providerLocators`, and the first draft gave the materializer no way to receive state
except by dialling one. That breaks custody law (a tier-3 runtime holding ambient network
authority) and, worse for the authoring loop, hides behind a fork's own cache the record of
which accounts and slots execution actually reached for — which is exactly the ground truth §7's
widen-and-re-verify loop needs, and its absence is what "trusting a dump" means.
*Disposition:* `MaterializationRequest.stateBackend?: ChainStateBackend`
(`getAccount` / `getCode` / `getStorageAt` / `getBlockHeader`), plus the exported predicate
`requiresStateBackend(record)` so the materializer and the extractor key off one rule instead of
each re-deriving it from the closure class. **Normative:** a materializer handed an
archive-dependent record without a backend fails closed and never reads a locator. Enforcement
is the capability's; this package owns the contract and the predicate.

**CE1-F12 — `ChainStateBackend.getAccount.storageRoot` is optional, per the extraction
component's F-CE4-10.** As first declared it was mandatory, which is unimplementable from plain
JSON-RPC: `eth_getBalance`, `eth_getTransactionCount`, and `eth_getCode` do not carry an
account's storage root, and only `eth_getProof` does. Mandating it would put a proof-sized call
behind every distinct account a fork touches, and would fail outright against archives with no
`eth_getProof` — turning what should be a plain balance read into an `archive-proof-unsupported`
error. The consuming side does not want it either: a revm/Anvil fork backend resolves accounts
as nonce/balance/code-hash and has nowhere to put a storage root.
*Disposition:* `storageRoot?: string`. A backend that already holds proof data passes it
through; one serving plain reads omits it. `codeHash` stays mandatory — it is keccak over the
code bytes, which both sides already compute. `ports.test.ts` pins the relaxed shape with a
plain-JSON-RPC fake that omits the field, so a future re-tightening fails typecheck here.

**CE1-F11 — The golden state-artifact format id now matches the producer's.** The goldens
originally wrote `{id: "anvil-state", version: "1"}`, while the extraction component pins a
deliberately runtime-neutral `jinn.chain-state-slice/1` so a third party can re-verify an
anchored-subset record without Anvil internals (design §5.4).
*Disposition:* the goldens adopt the producer's id. A fixture encoding a format nobody emits
would have put a translation step between the corpus and every consumer of it.

**CE1-F2 — The solution-script shape has no owner in program §3.** Design §6.4 defines the
script and §14 names its media type in this family's naming pass, but the program's
component list assigns it to nobody. `ScriptReplayer` — which program §3 *does* pin to CE1 —
cannot be typed without it, and leaving it unowned invites CE3 and CE5 to each declare one.
*Disposition:* CE1 owns `ChainSolutionScriptSchema`, `CHAIN_SOLUTION_MEDIA_TYPE`, and the
operation vocabulary, as the shape only. Nothing about publication, admission, or grading lands
here. Proposed as a program-plan clarification rather than an amendment, since §3's CE1 entry
already ends with the port type declarations this is required by.
**SETTLED** — confirmed by the coordinator on the same logic as ruling CR2: CE1 owns the
schema and shape, the verification capability owns the replayer; execution lives where the
RPC call is.

**CE1-F3 — The composite cannot name the information-world kind without colliding with CE6.**
Design §4.4 has the composite reference `information-world/1.0` components, while program §3
pins `INFORMATION_WORLD_KIND` to CE6. Two packages declaring one constant is a drift surface,
and CE1 must not depend on CE6 (the dependency runs the other way and CE6 is sequenced last).
*Disposition:* the composite validates that each information-world reference declares a `kind`
satisfying the record-kind URI grammar and that it is not the chain kind, plus a mandatory
digest. CE6's constant satisfies this without CE1 importing it. If the program wants the literal
pinned at the composite, the constant should move to CE1 and CE6 should re-export it — a
program-plan amendment either way.
**SETTLED** — confirmed by the coordinator: the grammar-plus-digest check stands. Importing
CE6's constant would invert the dependency, since CE6 bases on this branch.

**CE1-F4 — The canonical observation type is CE2's, so the ports must be generic.** Program §3
pins `CanonicalChainObservationSchema` to CE2 while pinning `ProbeExecutor` and `ScriptReplayer`
to CE1. A non-generic port would force CE1 to declare an observation type CE2 owns.
*Disposition:* `ProbeExecutor<Observation = unknown>` and `ScriptReplayer<Observation = unknown>`.
CE2 and CE3 instantiate them. No CE1 file mentions a canonical observation shape.

**CE1-F5 — E13's record-level half is arithmetic the design does not spell out.** §4.2 states
the rule over *artifact entries*, which the record does not contain, and §5.1 step 4 assigns the
check to verification. A record could therefore be sealed having never claimed full coverage,
and the failure would surface only once someone downloaded the artifact.
*Disposition:* the record carries three censuses of one shape — `stateArtifact.entryCounts`,
`sourceProofManifest.coverage`, `fixtureCoverage.declared` — and the schema requires exact
equality per category, failing with `source-coverage-incomplete` in the message. This is the
cheap, offline half of the same rule; CE3 still recomputes the artifact census and owns the
authoritative check. The field grammar is proposed, per §4.3's "settled at implementation."

**CE1-F6 — Interval mining is removed from the vocabulary rather than merely constrained.**
§4.3 lists mining mode as a knob to fix, without ruling any value out. Interval mining produces
blocks on the host wall clock, so two runs of one script see different block counts.
*Disposition:* `MINING_MODES` is `["manual", "auto"]`. If a future runtime needs interval
mining for a non-closed class, it re-enters as a value plus the closed-state exclusion, not as
a silent widening.

**CE1-F7 — Optional facts are untested territory in the discovery layer.**
`stateMaterialization.stateArtifactDigest` is reference-bearing per CF4 but absent from
`archive-dependent` records, and the merged facts leaves all emit every profile field
unconditionally. Whether `verifyItem` reads a card that omits an omitted-by-recompute field as
`consistent` is unproven.
*Disposition:* Task 17's conformance suite asserts `consistent` for exactly that case. **If it
fails, stop and report** — the correct fixes are a discovery-layer change or dropping the field
from the profile, never emitting a placeholder digest, which would put a value on the wire that
identifies nothing.

**CE1-F8 — The five sealing primitives are materialized from the sibling rather than retyped.**
Program §4 contract 3 says sealing is "re-implemented per package … never shared runtime sealing
code." A byte-for-byte copy is a separate implementation by that rule — nothing is shared at
runtime, the guard still bans the import, and the equivalence fixtures still prove agreement —
and it removes the transcription risk that would otherwise be the most likely way two packages'
canonical bytes silently diverge.
*Disposition:* proceed. Recorded so a reviewer sees the choice was deliberate rather than
assuming an import was smuggled in.
**SETTLED** — confirmed by the coordinator: the house rule is re-implementation per package
with equivalence fixtures; it never required retyping by hand, and the three-oracle
equivalence is the right proof.

