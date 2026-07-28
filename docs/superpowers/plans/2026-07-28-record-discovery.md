# Record Discovery Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** draft (pending program approval)

**Date:** 2026-07-28

**Implements:** `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` (Record Discovery Protocol v1). Section references (`§N`) throughout point at that design.

**Depends on sibling 2026-07-28 plans:**
- `docs/superpowers/plans/2026-07-28-trust-layer.md` — `@jinn-network/trust-core` MUST exist and build before `discovery/protocol` (M1) can typecheck; `discovery/client` (M6) and `facts/trust` (M7) consume its key-binding resolution / freshness / scope surface. This is the *only* cross-protocol import at the discovery core (coordinator brief, reconciled layer map).
- `docs/superpowers/plans/2026-07-28-task-execution-profiles.md` — `@jinn-network/task-execution-profiles` MUST exist and build before `facts/task-execution` (M8) can be built (§12 leaf gating; coordinator brief Discovery-plan note; program §6.5 folds the task-execution tree into a single facts leaf). Its own dependency chain pulls in the TEP protocol package that defines Task / Submission / Delivery.

**Independent of** the in-flight evidence PR train and of the marketplace binding (design §19, §20 line 1052; coordinator brief). The evidence packages under `packages/evidence/` are consumed as **frozen contracts** (`@jinn-network/evidence-discovery`, `@jinn-network/evidence-repository`) with zero edits (§11).

**Goal:** Build the backend-neutral record distribution layer — announce / query / subscribe over the stack's sealed records — as the package tree `packages/discovery/*`, so any producer can publish a signed, hash-chained source of "these records exist / this work is open," any stranger can find and subscribe to them, and any untrusted carrier can serve them.

**Architecture:** A kind-agnostic protocol core (`protocol`) authors exactly two bespoke sealed objects — the Announcement Entry (§5.1) and the Source Head (§5.2) — plus the chain rules (§5.3), the two named verification procedures (§10.3 source-chain-verification, §10.4 item verification), the facts-profile contract (§12), the record-kind URI grammar (§12), and the CloudEvents envelope mappings (§9.1). Sealing (I-JSON, RFC 8785 JCS at seal, sha256-over-exact-bytes, DSSE pre-auth encoding) is **re-implemented per-package** per the stack's per-package sealing precedent, held byte-identical to `trust-core` by cross-package equivalence fixtures. Every package is an **I/O-free reference implementation**: all fetching, blob writing, signing, key resolution, clock reads, and substrate lookups arrive through injected ports, so ambient network APIs are banned everywhere (guard-enforced) exactly as in the evidence tree. `serve` is the published-source toolkit (layout writer, head maintenance, pager, pings). `client` is the consumer runtime (chain-walk sync, high-water-mark store, query + subscribe clients, verification driver). `facts/*` leaves hold the per-record-kind facts-profile documents **and** export the per-kind record-fact recompute functions that the protocol runner reaches through an injected `FactsRecompute` registry port (program §7.13). `sources/evidence-journal` is the deterministic wrapper that re-seals the frozen evidence journal + catalog into one published discovery chain (§11).

**Tech Stack:** TypeScript (NodeNext, strict), Zod 4.4.3 for schemas, `@noble/hashes` 2.2.0 for sha256, `canonicalize` 3.0.0 for RFC 8785 JCS, DSSE (re-implemented pre-auth encoding), Vitest 4.1.8, Node `node:test` for the `.github/scripts` guards. Yarn 4.13.0 per-package projects with `portal:` resolutions. No repo-root workspace.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the design and the coordinator brief; do not paraphrase them into code differently.

- **Package mechanics (evidence precedent, coordinator brief §Ground truth).** Each package under `packages/discovery/` is a **standalone yarn project**: own `yarn.lock`, `"packageManager": "yarn@4.13.0"`, `"type": "module"`, `"engines": { "node": ">=22" }`, `"license": "MIT"`, a `repository.directory` pointing at its own path, `main`/`types`/`exports` into `dist/`. In-tree and cross-tree Jinn deps are declared as normal semver `dependencies`/`devDependencies` **and** mirrored under `"resolutions": { "<name>": "portal:<relative-path>" }`. There is **no** repo-root workspace. Scaffold files per package: `package.json`, `tsconfig.json` (typecheck, includes `src/**/*` and tests, `moduleResolution: Bundler`), `tsconfig.build.json` (build, excludes tests, emits `dist/`), `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `README.md` — copy the shapes from `packages/evidence/protocol/`.
- **Sealing precedent (coordinator brief §Ground truth).** Every package that produces sealed/canonical bytes MUST: (a) ship its own `src/order.ts` exporting `compareCodeUnitStrings` copied verbatim from `packages/evidence/protocol/src/order.ts` (UTF-16 code-unit, **never** `localeCompare`); (b) ship its own canonical serializer (JCS via `canonicalize`) and digest helper; (c) ship pinned-digest golden fixtures; (d) include at least one **object-key-sort-sensitive** record in its cross-package equivalence fixtures; (e) be covered by the discovery tree's locale-ban guard.
- **UTF-16 ordering rule.** Any reported or serialized ordering (sorting announcements, facts fields, query pages, well-known source lists) uses `compareCodeUnitStrings`. `localeCompare`, `toLocale*`, and `Intl` are banned on all production source and guard-enforced.
- **Ambient-network ban.** `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, and their `globalThis`/`global` member forms are banned on all discovery production source; network and blob I/O arrive only through injected ports. Guard-enforced.
- **Media types** live in the `vnd.jinn.record-discovery.*` vendor tree, used as-is; IANA registration is a recorded non-blocking follow-up (design §15; coordinator brief mandate 4).
- **Scheme-IRI registration** for any `identifier` `propertyID` spellings is the one shared stack-wide follow-up (coordinator brief mandate 4) — do not register here.
- **Reserved URIs** (the discovery protocol version URI, record-kind URIs, location-profile URIs) must resolve before *external* conformance claims; internal work does not gate on publication. Record them on the master program doc's pre-release checklist (coordinator brief mandate 6); do not block tasks on it.
- **Rule 3 (surgical).** Implementers touch only files this plan names. The three guard scripts and the CI workflow are *this tree's own* new files (`record-discovery-*`); they are implementation-time work landed by the tasks below, never edits to the evidence guards.

## Pinned identifiers (design defers exact strings to "implementation"; pinned here, flagged for the program gate)

These are settled once, in `packages/discovery/protocol/src/identifiers.ts`, and imported everywhere. Every one is a naming decision the design left open (§7, §12, §15); the coordinator surfaces them at the program gate (see Findings). Nothing downstream may hardcode a copy — import from `identifiers.ts`.

```ts
// Protocol version URI, unversioned family root (§15)
export const RECORD_DISCOVERY_FAMILY = "https://jinn.network/record-discovery" as const;
export const RECORD_DISCOVERY_VERSION = "https://jinn.network/record-discovery/1.0" as const;

// Record-kind URIs (§12). Grammar: `${RECORDS_ROOT}/<segment>/<major>.<minor>`,
// segment matches SOURCE_NAME_GRAMMAR (below).
export const RECORDS_ROOT = "https://jinn.network/records" as const;
export const RECORD_KINDS = {
  task:                   "https://jinn.network/records/task/1.0",
  submission:             "https://jinn.network/records/submission/1.0",
  delivery:               "https://jinn.network/records/delivery/1.0",
  executionEvidence:      "https://jinn.network/records/execution-evidence/1.0",
  resultEvaluation:       "https://jinn.network/records/result-evaluation/1.0",
  executionVerification:  "https://jinn.network/records/execution-verification/1.0",
  keyBinding:             "https://jinn.network/records/key-binding/1.0",
  authorization:          "https://jinn.network/records/authorization/1.0",
  trustPolicy:            "https://jinn.network/records/trust-policy/1.0",
  profileDocument:        "https://jinn.network/records/profile-document/1.0",
  evaluationSpec:         "https://jinn.network/records/evaluation-spec/1.0",
  plugin:                 "https://jinn.network/records/plugin/1.0",
  checkpoint:             "https://jinn.network/records/checkpoint/1.0",
} as const;

// Trust-layer signing scope (§5.5, program §7.11). Conformant with trust-core's
// namespaced-scope grammar (`namespace:custom`); both trees cite this constant and the
// discovery kit carries a cross-tree assertion that the value parses under trust's
// `ScopeVocabulary` (see Findings — this replaces the earlier "scope-extension
// registration" framing).
export const DISCOVERY_SIGNING_SCOPE = "jinn:discovery-announcements" as const;

// Location profiles (§7).
export const LOCATION_PROFILE_HTTPS = "https://jinn.network/record-discovery/location/https/1.0" as const;
export const LOCATION_PROFILE_IPFS  = "https://jinn.network/record-discovery/location/ipfs/1.0" as const;

// Media types (§15).
export const MEDIA_ENTRY   = "application/vnd.jinn.record-discovery.entry.v1+json" as const;
export const MEDIA_HEAD    = "application/vnd.jinn.record-discovery.head.v1+json" as const;
export const MEDIA_FACTS_PROFILE = "application/vnd.jinn.record-discovery.facts-profile.v1+json" as const;
export const MEDIA_WELL_KNOWN    = "application/vnd.jinn.record-discovery.well-known.v1+json" as const;

// Grammar (§5.1). Source names and record-kind segments share this shape.
export const SOURCE_NAME_GRAMMAR = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

// Sequence discipline (§5.1).
export const SEQUENCE_WIDTH = 16;               // fixed-width decimal
export const GENESIS_SEQUENCE = "0000000000000001" as const;

// Serving paths (§7), derivable from identity alone, no query params.
export const WELL_KNOWN_PATH = "/.well-known/jinn-record-discovery" as const;
export const recordPath   = (digest: `sha256:${string}`) => `/records/${digest.slice("sha256:".length)}`;
export const headPath     = (sourceName: string) => `/sources/${sourceName}/head`;
export const archivePagePath = (sourceName: string, page: string) => `/sources/${sourceName}/entries/${page}`;

// Advisory ceilings (§5.1); HARD under the published-source profile.
export const CEILINGS = {
  entrySealedBytes: 1 << 20,   // 1 MiB
  itemsPerEntry: 512,
  factsCardBytes: 4 << 10,     // 4 KiB per item
  archivePageBytes: 4 << 20,   // 4 MiB
} as const;
```

## Package / file structure

```text
packages/discovery/
  protocol/                       @jinn-network/record-discovery-protocol
  testing/                        @jinn-network/record-discovery-testing        (conformance kit; built before serve/client/facts/wrapper)
  serve/                          @jinn-network/record-discovery-serve
  client/                         @jinn-network/record-discovery-client
  facts/                          (three leaves, one per record-kind tree — program §6.5)
    evidence/                     @jinn-network/record-discovery-facts-evidence
    trust/                        @jinn-network/record-discovery-facts-trust
    task-execution/               @jinn-network/record-discovery-facts-task-execution   (gated on task-execution-profiles; covers Task, Submission, Delivery, profile-document, evaluation-spec, plugin, checkpoint kinds)
  sources/
    evidence-journal/             @jinn-network/record-discovery-source-evidence-journal (gated on serve)
.github/scripts/
  record-discovery-package-inventory.test.mjs
  record-discovery-source-boundaries.test.mjs
  record-discovery-packed-types.test.mjs
.github/workflows/
  record-discovery-ci.yml
```

Dependency edges (frozen; guard-enforced). `→` = imports/consumes:
`protocol → trust-core (types only)`; `testing → protocol`; `serve → protocol` (+ `testing` dev); `client → protocol, trust-core` (+ `testing` dev) — **not** a guard-enforced `facts/*` package edge: `client` reaches the facts leaves only through the types-only `FactsProfileRegistry` + `FactsRecompute` registry ports, which the host assembles and injects at runtime (Task 18; program §7.13); `facts/evidence → protocol, evidence-discovery` (root + `/indexer` subpath), `evidence-repository`; `facts/trust → protocol, trust-core`; `facts/task-execution → protocol, task-execution-profiles`; `sources/evidence-journal → protocol, serve, evidence-discovery, evidence-repository`. No discovery package imports TEP or Evidence *record* packages except through the `facts/*` and `sources/*` leaves — those are the only places a discovery edge meets a record-kind edge (design §12, §17; coordinator brief widened rule wording: "leaf packages under `packages/discovery/` (`facts/*`, `sources/*`) are the only places the two edges meet").

## Preflight (run once before Task 1)

- [ ] Assert the branch base: `git merge-base --is-ancestor 3650ac65e HEAD` (exit 0). This guarantees the evidence packages, the evidence guard precedent, and the UTF-16 code-unit ordering fix (PR #2226) are present.
- [ ] Assert `@jinn-network/trust-core` exists and builds: `test -f packages/trust/core/package.json`, then `(cd packages/trust/core && yarn install --immutable && yarn build)`. If absent, the trust-layer plan has not landed — **stop**; M1 is blocked (see Findings, cross-plan gating).
- [ ] Note (do not block): `packages/task-execution/profiles` is required only at M8. Assert its presence at the top of M8.

## Milestone map and internal gates

- **M1 — protocol foundation + guard clone** (blocked on trust-core). Scaffold, guards seeded, sealing, the two sealed shapes, RecordRef/AnnouncedItem, grammars, fixtures.
- **M2 — protocol contracts.** Facts-profile contract (§12), CloudEvents envelope mappings (§9.1), chain-rule types, the query-plane frozen interfaces (§8 — `DiscoveryQueryService`/`Page`/`QueryCapabilities`/`FactsFilter`/`PageRequest`, owned here per program §7.12), verification-procedure **port interfaces + typed outcomes** including the `FactsRecompute` registry port (program §7.13) (skeletons).
- **M3 — conformance kit (`testing`), built FIRST.** The full §18 golden-vector set + reusable harness + named-check drivers; red against M2 skeletons.
- **M4 — protocol verification procedures.** `source-chain-verification` (§10.3), item verification (§10.4), chain rules (§5.3); green the M3 kit.
- **M5 — `serve`.** Layout writer, archive pager, head maintenance + well-known doc, pings, location profiles; green the kit's source conformance.
- **M6 — `client`.** Chain-walk sync, high-water-mark store, query client, subscribe client, verification driver; green the kit's query/subscribe/consumer conformance.
- **M7 — `facts/evidence` + `facts/trust`** (not gated on the profiles plan).
- **M8 — `facts/task-execution`** (single task-execution-tree leaf per program §6.5; gated on task-execution-profiles) **+ `sources/evidence-journal` wrapper** (gated on M5 only).

Internal gate: M2 kit-green requires M4; M5/M6 each require M3 green; M7/M8 require M4 + their record-kind trees.

Each package task's verification gate, unless stated otherwise: build any cross-tree Jinn deps first (`(cd <dep> && yarn install --immutable && yarn build)`), then in the package `yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke`, then from the repo root run the three discovery guards (`node --test .github/scripts/record-discovery-package-inventory.test.mjs .github/scripts/record-discovery-source-boundaries.test.mjs` and `node .github/scripts/record-discovery-packed-types.test.mjs`). A task that adds a new package MUST first extend the three guard constant blocks + the CI matrix for that package (its own steps say so), or the guards fail.

---

## M1 — `discovery/protocol` foundation + guard clone

### Task 1: Scaffold `discovery/protocol` and clone the three tree guards + CI

**Files:**
- Create: `packages/discovery/protocol/package.json`, `tsconfig.json`, `tsconfig.build.json`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `README.md`, `src/index.ts` (empty re-export stub)
- Create: `.github/scripts/record-discovery-package-inventory.test.mjs`
- Create: `.github/scripts/record-discovery-source-boundaries.test.mjs`
- Create: `.github/scripts/record-discovery-packed-types.test.mjs`
- Create: `.github/workflows/record-discovery-ci.yml`

**Interfaces:**
- Produces: the guard trio + CI, seeded with the *only-then-existing* package set `{protocol}`; each later package task appends itself to all four.

**`package.json`** (copy the `packages/evidence/protocol/package.json` shape; the load-bearing differences):

```jsonc
{
  "name": "@jinn-network/record-discovery-protocol",
  "version": "0.1.0",
  "description": "I/O-free reference implementation of the Jinn Record Discovery Protocol v1.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/Jinn-Network/mono.git", "directory": "packages/discovery/protocol" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }, "./fixtures/*": "./fixtures/*" },
  "files": ["dist/", "fixtures/", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/trust-core": "0.1.0",
    "@noble/hashes": "^2.2.0",
    "canonicalize": "3.0.0",
    "zod": "4.4.3"
  },
  "devDependencies": { "@types/node": "^22.0.0", "typescript": "^5.9.3", "vitest": "^4.1.8" },
  "resolutions": { "@jinn-network/trust-core": "portal:../../trust/core" }
}
```

- [ ] **Step 1: Write the guard clones by copy-and-swap.** For each of the three `.github/scripts/evidence-<name>.test.mjs`, copy to `.github/scripts/record-discovery-<name>.test.mjs` and swap **only** the constant blocks below. Do not re-derive the scanner logic.

  **`record-discovery-package-inventory.test.mjs`** — swap `packageRoot` to `join(root, 'packages', 'discovery')`; replace `EVIDENCE_PACKAGES` with `DISCOVERY_PACKAGES` seeded to the current set and its count; replace the `JINN_DEPENDENCY_GRAPH` map; and **replace `expectedPortal`** so it resolves cross-tree targets. Seed for Task 1:

  ```js
  const DISCOVERY_PACKAGES = [
    ['protocol', '@jinn-network/record-discovery-protocol'],
  ];
  // Cross-tree Jinn dependencies live outside packages/discovery; map name -> absolute dir.
  const SIBLING_TREE_DIRS = new Map([
    ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
    ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
    ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
    ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ]);
  const JINN_DEPENDENCY_GRAPH = new Map([
    ['protocol', { dependencies: ['@jinn-network/trust-core'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ]);
  function expectedPortal(directory, dependencyName) {
    const inTree = DISCOVERY_PACKAGES.find(([, name]) => name === dependencyName);
    const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
    assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
    return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
  }
  ```
  Update the count assertion: `assert.equal(DISCOVERY_PACKAGES.length, 1);` and the inventory regex to `/^@jinn-network\/record-discovery-/`. Remove the evidence-specific Derivation-peer test.

  **`record-discovery-source-boundaries.test.mjs`** — keep the scanner functions (`files`, `specifiers`, `forbiddenImportsInFiles`, `assertBoundary`, `ambientNetworkUsesInFiles`, `localeSensitiveUsesInFiles`, `AMBIENT_NETWORK_APIS`, `LOCALE_SENSITIVE_APIS`) verbatim. Replace the evidence directory list + per-package inventories with:

  ```js
  const packages = join(root, 'packages', 'discovery');
  const discoveryDirectories = ['protocol'];   // grows per package task
  const APPLICATION_AND_LEGACY_ROOTS = [
    join(root, 'apps'), join(root, 'client'),
    ...['autopilot', 'core', 'indexer', 'indexer-enrichment', 'layer', 'plugin', 'sdk']
      .map((d) => join(root, 'packages', d)),
  ];
  // protocol is kind-agnostic: may import trust-core, nothing else Jinn; no TEP/Evidence record packages.
  const PROTOCOL_FORBIDDEN_PACKAGES = [
    '@jinn-network/record-discovery-serve', '@jinn-network/record-discovery-client',
    '@jinn-network/record-discovery-testing',
    '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
    '@jinn-network/evidence-discovery', '@jinn-network/task-execution-protocol',
    '@jinn-network/task-execution-profiles',
  ];
  ```
  Retain the two canary tests ("the import scanner catches …", "locale-sensitive API detection catches …") verbatim — they are self-contained fixtures. Add one boundary test asserting: `assertBoundary(join(packages, 'protocol', 'src'), PROTOCOL_FORBIDDEN_PACKAGES)`, plus `ambientNetworkUsesInFiles(production) === []` and `localeSensitiveUsesInFiles(production) === []` over `protocol/src` production files.

  **`record-discovery-packed-types.test.mjs`** — swap `evidenceRoot`; replace `packages` + `codeEntrypoints` seeded to `[['protocol','@jinn-network/record-discovery-protocol']]` and `['@jinn-network/record-discovery-protocol']`. **Add cross-tree deps to the synthetic consumer**: also `npm pack` each of `packages/trust/core` (M1), `packages/evidence/discovery` + `packages/evidence/repository` (M7), `packages/task-execution/profiles` (M8) that any *then-present* discovery package references, and add them as `file:` deps so NodeNext resolves the imports. Keep the packed TypeScript-consumer compile verbatim.

  **`record-discovery-ci.yml`** — copy `evidence-ci.yml`; rename to `Record Discovery CI`; `paths:` filter on `packages/discovery/**`, `.github/scripts/record-discovery-*.test.mjs`, `.github/workflows/record-discovery-ci.yml`, and this design doc. `architecture` job runs inventory + boundaries. `foundation` job: build the cross-tree deps first (`(cd packages/trust/core && yarn install --immutable && yarn build)`), then `protocol` (`yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke`) and upload its dist. Later jobs (added per package) restore dists and build. `verify` job runs the packed-types guard. Every component job that has a cross-tree Jinn dep MUST build that dep from source before `yarn install`.

- [ ] **Step 2: Write the scaffold.** Copy `tsconfig.json`, `tsconfig.build.json`, `scripts/build.mjs`, `scripts/pack-smoke.mjs` from `packages/evidence/protocol/`, adjusting only the package name in `pack-smoke.mjs`'s temp-dir label. `src/index.ts` = `export {};` for now.

- [ ] **Step 3: Run the guards to verify they pass on the seeded set.**

  Run: `node --test .github/scripts/record-discovery-package-inventory.test.mjs .github/scripts/record-discovery-source-boundaries.test.mjs`
  Expected: PASS (protocol manifest matches; boundaries trivially clean on the empty stub).

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/discovery/protocol .github/scripts/record-discovery-*.test.mjs .github/workflows/record-discovery-ci.yml
  git commit -m "feat(discovery): scaffold record-discovery-protocol and clone tree guards"
  ```

### Task 2: Sealing primitives (`order.ts`, canonical serializer, digest, DSSE PAE)

**Files:**
- Create: `packages/discovery/protocol/src/order.ts`, `src/hashing.ts`, `src/sealing.ts`, `src/dsse.ts`
- Test: `packages/discovery/protocol/src/sealing.test.ts`, `src/dsse.test.ts`

**Interfaces:**
- Produces: `compareCodeUnitStrings(a,b): number`; `sha256Hex(bytes): string`; `recordDigest(bytes): \`sha256:${string}\``; `sealJson(value: unknown): { bytes: Uint8Array; digest: \`sha256:${string}\` }` (JCS canonical bytes + digest, §15); `dssePreAuthEncoding(payloadType: string, payloadBytes: Uint8Array): Uint8Array`.

- [ ] **Step 1: Copy `order.ts` verbatim** from `packages/evidence/protocol/src/order.ts` (adjust only the comment's guard-path reference to `record-discovery-source-boundaries.test.mjs`).

- [ ] **Step 2: Copy `hashing.ts` verbatim** from `packages/evidence/protocol/src/hashing.ts` (`sha256Hex`, `recordDigest`).

- [ ] **Step 3: Write the failing sealing test.**

  ```ts
  import { describe, it, expect } from "vitest";
  import { sealJson } from "./sealing.js";
  describe("sealJson", () => {
    it("is key-order-insensitive (JCS) and pins the digest", () => {
      const a = sealJson({ b: 1, a: 2 });
      const b = sealJson({ a: 2, b: 1 });
      expect(a.digest).toBe(b.digest);
      expect(new TextDecoder().decode(a.bytes)).toBe('{"a":2,"b":1}');
      expect(a.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
    it("rejects non-canonicalizable values", () => {
      expect(() => sealJson(() => 0)).toThrow();
    });
  });
  ```

  Run: `yarn vitest run src/sealing.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `sealing.ts`.**

  ```ts
  import canonicalize from "canonicalize";
  import { recordDigest } from "./hashing.js";
  const encoder = new TextEncoder();
  export function sealJson(value: unknown): { bytes: Uint8Array; digest: `sha256:${string}` } {
    const encoded = canonicalize(value);
    if (encoded === undefined) throw new Error("Value cannot be serialized as canonical JSON.");
    const bytes = encoder.encode(encoded);
    return { bytes, digest: recordDigest(bytes) };
  }
  ```

- [ ] **Step 5: Implement `dsse.ts`** — copy `dssePreAuthEncoding` and its `concatenate`/`ascii` helpers verbatim from `packages/evidence/protocol/src/claims.ts` (lines around 427). Add a test asserting the PAE byte layout for a known `(payloadType, payloadBytes)` pair, mirroring `evidence/protocol/src/claims.test.ts`.

- [ ] **Step 6: Run tests, then commit.**

  Run: `yarn vitest run src/sealing.test.ts src/dsse.test.ts` → PASS.
  ```bash
  git add packages/discovery/protocol/src
  git commit -m "feat(discovery): re-implement per-package sealing, digest, and DSSE PAE"
  ```

### Task 3: Identifiers, grammars, and record-kind URI validation

**Files:**
- Create: `packages/discovery/protocol/src/identifiers.ts` (the full **Pinned identifiers** block above), `src/grammar.ts`
- Test: `packages/discovery/protocol/src/grammar.test.ts`

**Interfaces:**
- Produces: `isSourceName(s): boolean`; `assertRecordKindUri(s): void` (throws on non-conforming); `formatOrigin(agent: string, name: string): string` and `splitOrigin(origin: string): { agent: string; name: string }` (last-`/` rule, §5.2); `formatSequence(n: bigint): string` (16-digit) and `nextSequence(prev: string): string` (increment-by-one, gap-free).

- [ ] **Step 1: Write failing grammar tests** covering: source names accept `a`, `a-b`, 64-char max, reject uppercase / leading-hyphen / 65-char; `splitOrigin` on `urn:uuid:1234/feed` → `{ agent: "urn:uuid:1234", name: "feed" }` and on `https://ex.org/a/b/feed` → `{ agent: "https://ex.org/a/b", name: "feed" }` (last `/` separates); `formatSequence(1n) === "0000000000000001"`; `nextSequence("0000000000000001") === "0000000000000002"`; `assertRecordKindUri("https://jinn.network/records/task/1.0")` passes and a malformed one throws.

  Run → FAIL.

- [ ] **Step 2: Implement `identifiers.ts`** (paste the Pinned identifiers block) and `grammar.ts` (the validators/formatters). `splitOrigin` uses `origin.lastIndexOf("/")`. `assertRecordKindUri` checks the `${RECORDS_ROOT}/<segment>/<major>.<minor>` shape with `SOURCE_NAME_GRAMMAR` on the segment.

- [ ] **Step 3: Run tests → PASS. Commit** (`feat(discovery): pin identifiers, grammars, and sequence discipline`).

### Task 4: The two sealed shapes — Announcement Entry (§5.1) + Source Head (§5.2) + RecordRef/AnnouncedItem (§8)

**Files:**
- Create: `packages/discovery/protocol/src/entry.ts` (types + Zod), `src/head.ts` (types + Zod), `src/item.ts` (RecordRef, PublishedLocation, AnnouncedItem, SourceIdentity, SourceCursor)
- Test: `src/entry.test.ts`, `src/head.test.ts`
- Create fixtures: `packages/discovery/protocol/fixtures/golden-entries/*.json`, `fixtures/golden-heads/*.json`, `fixtures/expected-digests.json`
- Create: `packages/discovery/protocol/src/fixtures.test.ts`

**Interfaces:**
- Produces (frozen field sets, §16.2/§16.3):

  ```ts
  export interface RecordRef { kind: string; digest: `sha256:${string}`; mediaType?: string; }
  export interface PublishedLocation { profile: string; locator: string; }
  export interface AvailableAnnouncement {
    announcementId: string; action: "available";
    record: RecordRef; locations?: PublishedLocation[]; facts?: unknown;
  }
  export interface WithdrawnAnnouncement {
    announcementId: string; action: "withdrawn";
    retracts: string; reason: "delisted" | "superseded" | "reorged" | "error";
  }
  export type Announcement = AvailableAnnouncement | WithdrawnAnnouncement;
  export interface AnnouncementEntry {
    protocol: string; source: { agent: string; name: string };
    sequence: string; previous: `sha256:${string}` | null; timestamp: string;
    announcements: Announcement[];   // non-empty
  }
  export interface SourceHead {
    protocol: string; origin: string; sequence: string;
    entry: `sha256:${string}`; issuedAt: string; refreshBy: string;
  }
  export interface SourceIdentity { agent: string; name: string; }
  export type SourceCursor = { sequence: string; entry: `sha256:${string}` };
  export interface AnnouncedItem {
    record: RecordRef; facts?: unknown; locations?: PublishedLocation[];
    provenance: { source: SourceIdentity; entry: `sha256:${string}`; announcementId: string; derivation?: unknown };
  }
  ```

- [ ] **Step 1: Write failing structural tests.** `entry.test.ts`: an entry with a duplicate `announcementId` across its `announcements[]` is rejected by `parseAnnouncementEntry`; a `withdrawn` item missing `reason` is rejected; a genesis entry MUST have `sequence === GENESIS_SEQUENCE` **and** `previous === null`, and any non-genesis entry with `previous === null` is rejected; `announcements[]` empty is rejected. `head.test.ts`: `origin` must equal `formatOrigin(source.agent, source.name)`; `sequence` 16-digit.

  Run → FAIL.

- [ ] **Step 2: Implement `entry.ts`/`head.ts`/`item.ts`** with Zod schemas enforcing the field sets, the sequence/genesis coupling, `announcements[]` non-empty, per-entry `announcementId` uniqueness (source-wide uniqueness is a *chain*-level rule, enforced in M4). Export `parseAnnouncementEntry(json): AnnouncementEntry` and `parseSourceHead(json): SourceHead`. Note: withdrawal reason vocabulary and same-source-retraction *targeting* is validated at chain level (M4), not here — a lone entry cannot see the retracted `available`.

- [ ] **Step 3: Author golden fixtures + `fixtures.test.ts`.** Include: a genesis entry, a two-item available+withdrawn entry, a head; and record their sealed digests in `expected-digests.json`. `fixtures.test.ts` re-seals each fixture with `sealJson` and asserts the digest matches `expected-digests.json` (pinned-digest golden, mirroring `evidence/protocol/src/fixtures.test.ts`). Include **at least one object-key-shuffled** copy of the same entry asserting an identical digest (JCS key-order insensitivity).

- [ ] **Step 4: Run `yarn test` → PASS. Commit** (`feat(discovery): freeze Announcement Entry and Source Head sealed shapes`).

### Task 5: Cross-package sealing-equivalence fixtures vs `trust-core`

**Files:**
- Create: `packages/discovery/protocol/src/equivalence.test.ts`, `fixtures/equivalence/*.json`

**Interfaces:**
- Consumes: `@jinn-network/trust-core`'s sealing/digest export (the trust plan freezes its name; use its public seal-and-digest function). Produces: proof that discovery's `sealJson` is byte-identical to trust-core's for the same logical inputs.

- [ ] **Step 1: Write the equivalence test.** For each fixture object (including one whose keys are deliberately out of order and one deeply nested), assert `sealJson(obj).digest === trustCoreSeal(obj).digest` and the bytes are equal. This is the mechanical drift guard that keeps a future shared-sealing extraction trivial (design §17; Phase-0 open question 2 disposition: defer extraction, ship the fixtures).

- [ ] **Step 2:** Run → PASS. Add the guard's locale/ambient checks pass over the new source. **Commit** (`test(discovery): pin sealing equivalence with trust-core`).

  **Verification gate (M1 complete):** the full package gate (typecheck/test/build/pack:smoke) + all three discovery guards green.

---

## M2 — `discovery/protocol` contracts (facts profile, CloudEvents, verification skeletons)

### Task 6: Facts-profile contract (§12)

**Files:**
- Create: `packages/discovery/protocol/src/facts-profile.ts`
- Test: `src/facts-profile.test.ts`
- Update: `src/index.ts` (re-export)

**Interfaces:**
- Produces (the contract owned by the protocol package; the *documents* live in `facts/*`):

  ```ts
  export type FactClass = "record" | "substrate";
  export type FactScalarType = "string" | "number" | "boolean";
  export interface FactsProfileField {
    name: string;
    class: FactClass;
    referenceBearing?: boolean;                // §8 referrers inversion
    cloudEvents?: { attribute: string; scalar: FactScalarType };  // §9.1 liftable field
  }
  export interface FactsProfileDocument {
    protocol: string;                          // RECORD_DISCOVERY_VERSION
    kind: string;                              // a record-kind URI (assertRecordKindUri)
    profile: string;                           // this profile's own URI (versioned)
    fields: FactsProfileField[];
  }
  export function parseFactsProfile(json: unknown): FactsProfileDocument;
  export function referenceBearingFields(p: FactsProfileDocument): string[];
  export function cloudEventsFields(p: FactsProfileDocument): FactsProfileField[];
  ```

- [ ] **Step 1: Failing tests.** A profile with a `substrate`-class field is legal; `parseFactsProfile` rejects a `cloudEvents.attribute` that violates CloudEvents attribute-naming rules (lowercase alphanumeric, ≤ 20 chars — encode the CE 1.0 rule); `referenceBearingFields` returns only the flagged fields; two profiles differing only in key order seal to the same digest (`sealJson`). Run → FAIL.

- [ ] **Step 2: Implement `facts-profile.ts`** (Zod + helpers). CloudEvents attribute-name validation regex `^[a-z0-9]{1,20}$` per CE 1.0.

- [ ] **Step 3:** Run → PASS. **Commit** (`feat(discovery): own the facts-profile contract`).

### Task 7: CloudEvents envelope mappings for the subscribe plane (§9.1)

**Files:**
- Create: `packages/discovery/protocol/src/cloudevents.ts`
- Test: `src/cloudevents.test.ts`

**Interfaces:**
- Produces:

  ```ts
  // Announcement-stream event mapping (§9.1): subject = record digest; extension
  // attributes for record kind, source identity, entry digest, plus the facts-card
  // filter fields named liftable by the kind's facts profile.
  export interface AnnouncementEvent {
    specversion: "1.0"; id: string; source: string; type: string;
    subject: string;                           // record digest
    time?: string;
    // extension attributes (CE names, lowercase):
    recordkind: string; sourceagent: string; sourcename: string; entrydigest: string;
    announcementid: string;
    [factExtension: string]: unknown;          // lifted facts fields
    data: AnnouncedItem;
  }
  export function toAnnouncementEvent(
    item: AnnouncedItem, profile: FactsProfileDocument | undefined,
  ): AnnouncementEvent;
  export function announcementDedupeKey(e: AnnouncementEvent): string;   // `${sourceagent} ${sourcename} ${entrydigest} ${announcementid}` (§9.1)
  ```

- [ ] **Step 1: Failing tests.** `toAnnouncementEvent` sets `subject` to the record digest, lifts exactly the `cloudEvents`-flagged facts fields into extension attributes with the declared names, and never lifts substrate facts it wasn't told to; `announcementDedupeKey` is `(source identity, entry digest, announcementId)`. Observation-stream pass-through is *not* modeled here (relays pass TEP observations unaltered, §9.1 — the client just forwards them; a comment records this). Run → FAIL.

- [ ] **Step 2: Implement.** **Step 3:** PASS. **Commit** (`feat(discovery): CloudEvents announcement-stream mapping`).

### Task 8: Verification-procedure port interfaces + typed outcomes (skeletons)

**Files:**
- Create: `packages/discovery/protocol/src/verify/ports.ts`, `src/verify/outcomes.ts`, `src/verify/source-chain.ts` (skeleton), `src/verify/item.ts` (skeleton), `src/query.ts` (§8 frozen query-plane interfaces, owned by protocol per program §7.12)
- Test: `src/query.test.ts`
- Update: `src/index.ts`

**Interfaces:**
- Produces the injected ports (I/O stays out of the package), the frozen typed outcomes (§16.11), and the §8 query-plane frozen interfaces (§16.9). These are the interfaces the M3 kit drives and M4/M6 implement. Per program §7.12 the query interfaces live **here**, not in `client`, so the M3 kit can reference them before the client exists (kit-before-implementation).

  ```ts
  // ports.ts — everything the procedures need from the outside world, injected.
  export interface RecordFetcher { fetch(digest: `sha256:${string}`): Promise<Uint8Array>; }   // re-hash is the procedure's job
  export interface EntryFetcher { fetch(digest: `sha256:${string}`): Promise<Uint8Array>; }
  export interface KeyResolver {                                   // wraps trust-core key-binding resolution (§10.1, §10.3)
    // returns the scoped keys valid for `agent` at `at`, under DISCOVERY_SIGNING_SCOPE
    resolve(agent: string, at: Date): Promise<ResolvedKey[]>;
    // for entry corroboration: was `keyid` ever bound to `agent` under the scope (§10.3 step 5)?
    everBound(agent: string, keyid: string): Promise<boolean>;
  }
  export interface SignatureVerifier { verify(pae: Uint8Array, sig: Uint8Array, key: ResolvedKey): Promise<boolean>; }
  export interface FreshnessPolicy { isFresh(refreshBy: string, now: Date): boolean; }         // trust-layer freshness (§5.2)
  export interface HighWaterMarkStore {
    get(source: SourceIdentity): Promise<SourceCursor | undefined>;
    put(source: SourceIdentity, cursor: SourceCursor): Promise<void>;
  }
  export interface SubstrateChecker {                              // projection derivation-consistency (§6.2)
    check(derivation: unknown, item: AnnouncedItem): Promise<"present" | "fabricated" | "reorged-away">;
  }

  // FactsRecompute — the seam that lets the kind-agnostic protocol runner recompute a kind's
  // record facts without importing the record-kind trees (program §7.13, §5.4). The per-kind
  // recompute fns are IMPERATIVE (they parse record bytes), live in the facts/* leaves, and are
  // injected by the host keyed by record-kind URI. FactsProfileDocument stays purely declarative
  // (field labeling); this port supplies the bytes→values extraction the declarative card lacks.
  export type RecordFactValue = string | number | boolean | undefined; // undefined = uncomputable
  export interface ReferencedBytes {                                    // referenced-record bytes, if available
    fetch(digest: `sha256:${string}`): Promise<Uint8Array | undefined>; // undefined ⇒ indeterminate fact
  }
  export type RecordFactRecompute =
    (bytes: Uint8Array, refs: ReferencedBytes) => Promise<Record<string, RecordFactValue>>;
  export interface FactsRecompute {                                     // host-assembled registry
    get(kind: string): RecordFactRecompute | undefined;                 // the leaf's recompute fn for `kind`
  }
  ```

  ```ts
  // outcomes.ts
  export type SourceChainOutcome =
    | { status: "ok"; head: SourceHead; advanced: SourceCursor }
    | { status: "stale" }
    | { status: "forked"; evidence: { a: SourceHead | AnnouncementEntry; b: SourceHead | AnnouncementEntry } }
    | { status: "broken-chain"; at: string }              // sequence or entry digest
    | { status: "unauthorized-signer" };
  export type FactsConsistency = "consistent" | "inconsistent" | "indeterminate";
  export type ItemOutcome =
    | { status: "content-corruption" }
    | { status: "verified"; facts: FactsConsistency; derivation?: "present" | "fabricated" | "reorged-away" }
    | { status: "unauthorized-provenance" };              // §10.4 step 3 failure
  ```

- [ ] **Step 1:** Write `ports.ts` (including the `FactsRecompute` registry port) + `outcomes.ts` + `query.ts` (the §8 frozen query-plane interfaces) and re-export `query.ts` from `src/index.ts`. Write `source-chain.ts` and `item.ts` exporting the signatures with a `throw new Error("not implemented")` body:

  ```ts
  export async function verifySourceChain(opts: {
    head: SourceHead; headSignature: DsseEnvelope; entries: AsyncIterable<{ entry: AnnouncementEntry; signature: DsseEnvelope }>;
    ports: { keys: KeyResolver; sigs: SignatureVerifier; fresh: FreshnessPolicy; hwm: HighWaterMarkStore; now: Date; firstAdoption: boolean; };
  }): Promise<SourceChainOutcome> { throw new Error("not implemented"); }
  export async function verifyItem(opts: {
    item: AnnouncedItem; profile?: FactsProfileDocument; decisionGrade: boolean;
    ports: { records: RecordFetcher; entries: EntryFetcher; keys: KeyResolver; sigs: SignatureVerifier; factsRecompute: FactsRecompute; substrate?: SubstrateChecker; verifiedChain: (c: SourceCursor) => Promise<boolean>; };
  }): Promise<ItemOutcome> { throw new Error("not implemented"); }
  ```

  `query.ts` — the §8 frozen query-plane interfaces (`DiscoveryQueryService`, `Page<T>`,
  `QueryCapabilities`, `FactsFilter`, `PageRequest`) are authored here and re-exported from
  `src/index.ts`; their full field sets are pinned in Task 21, which is where `client`
  **implements** (not redefines) `DiscoveryQueryService`. `query.test.ts` asserts a hand-built
  page/capabilities object type-checks against the frozen shapes. Owning them in `protocol`
  (program §7.12) is what lets the M3 kit's `runQueryConformance(svc: DiscoveryQueryService)`
  resolve the type before `client` exists.

- [ ] **Step 2:** `yarn typecheck` → PASS (skeletons compile). **Commit** (`feat(discovery): verification ports and typed outcomes (skeletons)`).

  **Verification gate (M2 complete):** typecheck/test/build/pack:smoke + guards green. (`test`/`facts-profile`/`cloudevents` unit tests pass; verification procedures remain unimplemented — that is intentional, greened by M4 through the kit.)

---

## M3 — `discovery/testing` conformance kit (built FIRST, §18)

The kit is a standalone package that depends only on `protocol` and packages the full §18 golden-vector set plus a reusable harness. It is written **before** `serve`/`client`/`facts`/`wrapper` and is red against the M2 skeletons until M4 lands; that red-then-green is the point (CSI discipline, §17/§18/tenet §4.7).

### Task 9: Scaffold `discovery/testing` + append to guards

**Files:**
- Create: `packages/discovery/testing/{package.json,tsconfig.json,tsconfig.build.json,scripts/build.mjs,scripts/pack-smoke.mjs,README.md,src/index.ts}`
- Modify: the three `.github/scripts/record-discovery-*.test.mjs` + `record-discovery-ci.yml` (append `testing`).

**Interfaces:** produces the kit package; `package.json` deps: `@jinn-network/record-discovery-protocol` (dependency + portal `../protocol`), `zod`, `vitest`; no cross-tree deps.

- [ ] **Step 1: Append `testing` to all four guard artifacts.** Inventory: add `['testing','@jinn-network/record-discovery-testing']`, count → 2, graph entry `{ dependencies: ['@jinn-network/record-discovery-protocol'], … }`. Boundaries: add `'testing'` to `discoveryDirectories`, add a `TESTING_FORBIDDEN_PACKAGES` inventory (may import only `record-discovery-protocol`; no serve/client/facts; no TEP/Evidence). Packed-types: add the entrypoint + package. CI: add `testing` to a build job after `protocol`.
- [ ] **Step 2: Scaffold** (copy shapes; `exports` include `.` and `./fixtures/*`). `src/index.ts` = `export {};` stub.
- [ ] **Step 3:** Guards green on the 2-package set. **Commit** (`feat(discovery): scaffold record-discovery-testing kit`).

### Task 10: Golden vectors — the full §18 enumerated set

**Files:**
- Create: `packages/discovery/testing/fixtures/vectors/*.json` (one directory per case)
- Create: `packages/discovery/testing/src/vectors.ts` (typed loader) + `src/vectors.test.ts` (asserts every case parses and self-describes its expected outcome)

**Interfaces:**
- Produces `loadVectors(): Vector[]` where `Vector = { name: string; kind: "source-chain" | "item" | "facts-consistency" | "derivation-consistency" | "query" | "subscribe" | "consumer"; input: unknown; expect: unknown }`.

- [ ] **Step 1: Author every §18 vector.** Enumerate exactly (each a fixture + an `expect`):
  - **Chains:** a valid chain; a **forked** chain (second signed child of an entry) and a fork at a shared `previous`; broken linkage (`previous` mismatch); a **sequence gap** and a **sequence duplicate** (must reject → `broken-chain`); a **duplicate `announcementId`** across entries (must reject → `broken-chain`); a **stale head** (`refreshBy` expired → `stale`); a **rolled-back head** (goes backward vs high-water mark); an **`issuedAt` regression** across two heads; a **competing head signed by a rotated-out key** (→ `unauthorized-signer`); an entry with a **bad facts card** (→ item `facts:inconsistent`); a facts card **requiring unavailable referenced bytes** (→ `facts:indeterminate`, decision-grade fails closed); **genesis edge cases** (pinned first `sequence`, `previous:null` uniqueness, and a non-genesis `previous:null` → reject); **withdrawal of a foreign announcement** (retracts an id not from this source → reject), **withdrawal-of-withdrawal** (reject), **missing reason code** (reject); **re-announce after withdrawal** under a new id (accept); **unknown record kinds** and **unknown facts fields** (skip, not error); **oversized entry** and **oversized archive page** (reject under published-source profile → `broken-chain` onward); an envelope **signed under the wrong trust-layer scope** (→ `unauthorized-signer`); a **substrate fact in an author-source announcement** (reject).
  - **Source conformance:** published (signed) + unpublished profiles; correction-by-append with `reorged`; head freshness + `issuedAt` monotonicity maintenance; `refreshBy` within profile bound (≤ 24h ahead, §5.2).
  - **Query:** provenance present on every item; a **fabricated-provenance** item (query cites a source it never synced → caught by §10.4 step 3); `complete` honesty (empty vs truncated); cursor determinism with digest tie-break; a service that **originates** (must be rejected by the consumer conformance).
  - **Subscribe:** the five cursor cases (no cursor / unknown-or-future / within-window / older-than-window `cursor-too-old` / oldest); declared replay window; relay-local cursor declaration; the announcement dedupe key; observation pass-through unaltered; a **per-item-drop censoring relay** fixture (an entry delivered with one item removed → caught by the entry-granular spot-check).
  - **Consumer:** ping-flood debounce (pull rate stays capped); hostile-locator guards (oversize, wrong content-type, private-address); head-vs-delivered relay divergence (downgrade the relay); cold-start mirror disagreement (take the highest valid `(sequence, issuedAt)`); withdrawal of a retrospective-kind item (do **not** prune the decision store); `reorged` withdrawal (must trigger recompute).
  - **Named checks in isolation:** `source-chain-verification` producing each of `stale` / `forked` / `broken-chain` / `unauthorized-signer`; `facts-consistency` producing all three outcomes; `derivation-consistency` producing present / fabricated / reorged-away.
- [ ] **Step 2:** `vectors.test.ts` asserts each fixture loads, parses under `protocol` schemas where applicable, and carries a well-formed `expect`. Run → PASS (data-only; no procedure invoked yet).
- [ ] **Step 3: Commit** (`feat(discovery): full §18 golden-vector corpus`).

### Task 11: Reusable conformance harness + named-check drivers

**Files:**
- Create: `packages/discovery/testing/src/harness.ts` (drivers), `src/fakes.ts` (in-memory ports: `RecordFetcher`, `EntryFetcher`, `KeyResolver`, `SignatureVerifier`, `FreshnessPolicy`, `HighWaterMarkStore`, `SubstrateChecker`, and a `FactsRecompute` registry whose per-kind fns recompute the vectors' record facts from bytes), `src/conformance.ts` (the exported suites), `src/index.ts` (re-exports)
- Create: `packages/discovery/testing/src/protocol-conformance.test.ts` (runs the harness against `protocol`'s reference procedures)

**Interfaces:**
- Produces:
  ```ts
  export function makeInMemoryPorts(seed?: Partial<Seed>): TestPorts;   // deterministic fakes
  export function runSourceChainConformance(verify: typeof verifySourceChain): void;   // vitest describe over the chain + named-check vectors
  export function runItemConformance(verify: typeof verifyItem): void;
  export function runSourceConformance(serve: ServeUnderTest): void;    // used by M5
  export function runQueryConformance(svc: DiscoveryQueryService): void; // used by M6
  export function runSubscribeConformance(sub: SubscribeClientUnderTest): void; // M6
  export function runConsumerConformance(client: ClientUnderTest): void;         // M6
  ```
  `DiscoveryQueryService` (and the other §8 query shapes), `verifySourceChain`, `verifyItem`, and every port type (`FactsRecompute` included) are **imported from `@jinn-network/record-discovery-protocol`** — the kit declares no shapes of its own (program §7.12 puts the query interfaces in protocol so the kit resolves them before `serve`/`client` exist). `makeInMemoryPorts` returns a `FactsRecompute` registry alongside the other fakes so `runItemConformance` can inject it into `verifyItem`.
- Consumes: `protocol`'s `verifySourceChain` / `verifyItem` (still skeletons — the harness expects real outcomes, so `protocol-conformance.test.ts` is RED here and greens in M4).

- [ ] **Step 1:** Implement `fakes.ts` — the in-memory ports MUST be deterministic (fixed clock, in-memory key registry keyed by `(agent, keyid, validity window, scope)`, `SignatureVerifier` that checks a fixture "signature" equals `sha256(pae)+keyid`, an entry/record store keyed by digest, and a `FactsRecompute` registry whose per-kind fns recompute each vector's record facts from the record bytes — returning `undefined` for a fact whose referenced bytes the fake withholds, to drive the `indeterminate` outcome). No ambient network, no locale.
- [ ] **Step 2:** Implement `harness.ts` + `conformance.ts` so each exported `run*Conformance` maps its vectors to `expect(...).toEqual(...)` over the injected implementation.
- [ ] **Step 3:** `protocol-conformance.test.ts`: `runSourceChainConformance(verifySourceChain); runItemConformance(verifyItem);`. Run → **RED** (skeletons throw). This red is expected and documents the M4 target. Record it in the commit message.
- [ ] **Step 4: Commit** (`feat(discovery): conformance harness + fakes (red until protocol procedures land)`).

  **Verification gate (M3 complete):** the `testing` package **builds and typechecks**; `vectors.test.ts` passes; `protocol-conformance.test.ts` is the single intentional red, referenced from M4. Guards green.

---

## M4 — `discovery/protocol` verification procedures (green the kit)

### Task 12: Chain rules (§5.3) + `verifySourceChain` (§10.3)

**Files:**
- Modify: `packages/discovery/protocol/src/verify/source-chain.ts`, add `src/verify/chain-rules.ts`
- Test: driven by `packages/discovery/testing`'s `runSourceChainConformance` — add `packages/discovery/protocol/src/verify/source-chain.test.ts` that imports the harness and the fakes and runs it against `verifySourceChain`.

**Interfaces:**
- Consumes ports from Task 8; the `testing` harness + vectors + fakes (dev dependency `@jinn-network/record-discovery-testing`, portal `../../testing`). Produces the seven-step §10.3 procedure with typed outcomes.

- [ ] **Step 1: Add `@jinn-network/record-discovery-testing` as a devDependency + portal** to `protocol/package.json`; update the inventory guard's graph entry for `protocol` (`devDependencies: ['@jinn-network/record-discovery-testing']`) and re-run it.
- [ ] **Step 2: Write `source-chain.test.ts`** = `runSourceChainConformance(verifySourceChain)`. Run → FAIL (still throwing).
- [ ] **Step 3: Implement `chain-rules.ts` + `verifySourceChain`** exactly in the §10.3 order:
  1. resolve working keys via `KeyResolver` under `DISCOVERY_SIGNING_SCOPE`;
  2. verify head DSSE signature against a key **currently valid at `now`** (`KeyResolver.resolve(agent, now)`); a rotated-out/expired/revoked signer → `unauthorized-signer`;
  3. verify `FreshnessPolicy.isFresh(head.refreshBy, now)` (else `stale`) and `issuedAt` monotonicity vs the previously seen head;
  4. walk `previous` from `head.entry` to the high-water mark (or genesis on `firstAdoption`), verifying linkage;
  5. verify entry signatures as **corroboration**: an entry sig verifies against a key `everBound(agent, keyid)` (any time — rotation never orphans history); missing entry sig under published profile → `broken-chain`; a key never bound → `unauthorized-signer`;
  6. check sequence contiguity (increment-by-one, gap-free, §5.1) and fork absence (any second signed child, or two heads at one sequence with different entry digests → `forked` with both branches as evidence); a source-wide duplicate `announcementId` → `broken-chain`;
  7. `HighWaterMarkStore.put` the advanced cursor; return `ok`.
  Enforce the published-profile hard ceilings (`CEILINGS`) → oversized entry/page yields `broken-chain` from that entry onward.
- [ ] **Step 4:** Run → the source-chain + named-check vectors PASS. **Commit** (`feat(discovery): implement source-chain-verification`).

### Task 13: Facts-consistency + item verification (§10.4, §5.4) + derivation-consistency (§6.2)

**Files:**
- Modify: `packages/discovery/protocol/src/verify/item.ts`, add `src/verify/facts-consistency.ts`
- Test: `src/verify/item.test.ts` = `runItemConformance(verifyItem)`

**Interfaces:** produces the five-step §10.4 procedure and the `facts-consistency` runner.

- [ ] **Step 1: Write `item.test.ts`** driving `runItemConformance`. Run → FAIL.
- [ ] **Step 2: Implement `facts-consistency.ts`.** Recompute each **record fact** by looking up the kind's imperative recompute fn via the injected registry (`ports.factsRecompute.get(item.record.kind)`) and calling it with the fetched record **bytes** and a `ReferencedBytes` fetcher (backed by `ports.records`), then compare the recomputed values field-by-field against the announced facts card. The `FactsProfileDocument` supplies only the *declarative* field labeling (record vs substrate class, reference-bearing, CloudEvents-liftable, §12); the leaf-exported fn supplies the *imperative* bytes→values extraction the declarative card cannot express — e.g. a Submission card's Task-derived fields drawn from the referenced Task, or an evidence record's DSSE/in-toto fields (§5.4, program §7.13, resolving the facts-recompute-seam blocker). A `undefined` recompute value (referenced bytes unavailable or capability-gated) yields `indeterminate`. Outcomes: `consistent` / `inconsistent` / `indeterminate`. Access-classified kinds derive record facts from **public bytes only** (never require gated content). A kind with no registered recompute fn is `indeterminate` (never silently `consistent`). Reject a **substrate fact carried by an author source** (§5.4 rule 2 — this is an *author-source* invariant, surfaced here and asserted by the M3 substrate-fact vector).
- [ ] **Step 3: Implement `verifyItem`** in order: (1) fetch record bytes, re-hash → `content-corruption` on mismatch; (2) `facts-consistency`, decision-grade fails closed on anything but `consistent`; (3) **verify cited provenance** — fetch the cited entry, verify its signature, confirm its `announcements[]` carries this `announcementId` for this record, and confirm the entry lies on the source's verified chain (`ports.verifiedChain(cursor)`) at/below the high-water mark → else `unauthorized-provenance` (§10.4 step 3, REQUIRED before decision-grade use); (4) for projected items, `SubstrateChecker.check` (`derivation-consistency`, REQUIRED for decision-grade, optional spot-check otherwise); (5) hand off to the record's own protocol for content verification (out of discovery's scope — return `verified`).
- [ ] **Step 4:** Run → item + facts-consistency + derivation-consistency vectors PASS; re-run `protocol-conformance.test.ts` in the `testing` package → now fully GREEN. **Commit** (`feat(discovery): implement item verification and facts/derivation consistency`).

  **Verification gate (M4 complete):** `protocol` full gate green; `testing`'s `protocol-conformance.test.ts` green; all three guards green.

---

## M5 — `discovery/serve` (§7)

### Task 14: Scaffold `serve` + append to guards + define serve ports

**Files:**
- Create: `packages/discovery/serve/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts,src/ports.ts}`
- Modify: the four guard artifacts (append `serve`).

**Interfaces:**
- `package.json`: dependency `@jinn-network/record-discovery-protocol` (portal `../protocol`); devDependency `@jinn-network/record-discovery-testing` (portal `../testing`); `zod`.
- `ports.ts` (injected I/O — no ambient fs/network in the package):
  ```ts
  export interface BlobStore { put(path: string, bytes: Uint8Array, contentType: string): Promise<void>; }
  export interface Clock { now(): Date; }
  export interface DsseSigner { sign(pae: Uint8Array): Promise<{ keyid?: string; sig: Uint8Array }[]>; }
  export interface PingTransport { announce(headUrl: string): Promise<void>; }   // optional; §7.4
  ```

- [ ] **Step 1:** Append `serve` (count → 4 after M3, adjust to actual) to inventory (graph: deps `record-discovery-protocol`, dev `record-discovery-testing`), boundaries (`SERVE_FORBIDDEN_PACKAGES` = client/facts/*, TEP/Evidence records; ambient-network + locale bans over `serve/src`), packed-types, CI (component job). **Step 2:** scaffold. **Step 3:** guards green. **Commit** (`feat(discovery): scaffold record-discovery-serve`).

### Task 15: Layout writer — records-by-digest + archive pager (§7.1, §7.2)

**Files:**
- Create: `packages/discovery/serve/src/layout.ts`, `src/archive.ts`
- Test: `src/layout.test.ts`, `src/archive.test.ts`

**Interfaces:**
- Produces: `writeRecord(store, bytes): Promise<{ digest; path }>` (writes to `recordPath(digest)`, immutable, re-hash-verified on read by consumers); `writeArchivePages(store, sourceName, entries): Promise<{ pages: string[] }>` — RFC 5005-shaped immutable pages in sequence order, each ≤ `CEILINGS.archivePageBytes`, each linking its predecessor page (`prev-archive` relation, RFC 8288), newest-first walkable.

- [ ] **Step 1: Failing tests.** A record written at `recordPath` round-trips by digest; an archive that would exceed 4 MiB splits into ≥ 2 pages with correct `prev-archive` links; entries are ordered by `sequence` using `compareCodeUnitStrings` on the fixed-width strings; page bodies are sealed I-JSON. Run → FAIL.
- [ ] **Step 2: Implement.** **Step 3:** PASS. **Commit** (`feat(discovery): serve layout writer and archive pager`).

### Task 16: Head maintenance + well-known discovery document (§7.3, §5.2, §5.5)

**Files:**
- Create: `packages/discovery/serve/src/head.ts`, `src/well-known.ts`
- Test: `src/head.test.ts`, `src/well-known.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WellKnownDocument {                 // in-protocol schema (§7.3)
    protocol: string;
    sources: Array<{
      agent: string; name: string; headPath: string; archiveRoot: string;
      confirmationDepth?: number; substrate?: string;  // projection metadata
    }>;
  }
  export function signHead(head: SourceHead, signer: DsseSigner): Promise<DsseEnvelope>;   // DSSE, MEDIA_HEAD payloadType
  export function refreshHead(prev: SourceHead, clock: Clock, refreshWithinMs: number): SourceHead; // strictly increasing issuedAt; refreshBy ≤ 24h ahead (§5.2)
  export function maintainHead(store: BlobStore, ...): Promise<void>;  // re-sign + write at headPath even when nothing announced
  ```

- [ ] **Step 1: Failing tests.** `refreshHead` strictly increases `issuedAt` and keeps `refreshBy` within the published-profile bound (≤ 24h); a head whose `origin !== formatOrigin(agent,name)` is rejected; the well-known document validates against its in-protocol Zod schema and is served at `WELL_KNOWN_PATH`; `signHead` produces a DSSE envelope over the sealed head bytes with the head payload type. Run → FAIL.
- [ ] **Step 2: Implement.** **Step 3:** run the kit's **`runSourceConformance`** against the serve implementation (published + unpublished profiles; correction-by-append with `reorged`; freshness + `issuedAt` monotonicity; `refreshBy` bound) → PASS. **Commit** (`feat(discovery): serve head maintenance and well-known document`).

### Task 17: Pings + location profiles (§7.4, §7)

**Files:**
- Create: `packages/discovery/serve/src/ping.ts`, `src/locations.ts`
- Test: `src/ping.test.ts`, `src/locations.test.ts`

**Interfaces:**
- Produces: `emitPing(transport, headUrl)` (unauthenticated hint; debounced by an injected debounce policy); `formatLocation(profile, locator): PublishedLocation` and validators for `LOCATION_PROFILE_HTTPS` (an https URL) and `LOCATION_PROFILE_IPFS` (a CID string), locator grammars pinned in `locations.ts`.

- [ ] **Step 1: Failing tests.** A ping is emitted at most once per debounce window; a location with an unknown profile is rejected; https/ipfs locators validate. Run → FAIL. **Step 2:** implement. **Step 3:** PASS. **Commit** (`feat(discovery): serve pings and location profiles`).

  **Verification gate (M5 complete):** serve full gate + `runSourceConformance` green; guards green.

---

## M6 — `discovery/client` (§5.3, §8, §9, §10)

### Task 18: Scaffold `client` + append to guards + client ports

**Files:**
- Create: `packages/discovery/client/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts,src/ports.ts}`
- Modify: the four guard artifacts (append `client`).

**Interfaces:**
- `package.json`: dependencies `@jinn-network/record-discovery-protocol` (portal `../protocol`), `@jinn-network/trust-core` (portal `../../trust/core`); devDependency `@jinn-network/record-discovery-testing` (portal `../testing`). It declares **no** `facts/*` package dependency (see note).
- `ports.ts`: injected `Transport` (an async `fetch`-shaped port — **no ambient `fetch`**), `StreamTransport` (long-poll/WS/SSE via injected callbacks), `HighWaterMarkStore` (persistent), `Clock`, plus the two types-only facts ports below.

  **Note (facts dependency ordering):** `client` consumes `facts/*` at runtime for facts-consistency, but the facts leaves land in M7/M8 and importing them as package dependencies would both cycle the build order and cross the guard boundary. So `client` reaches the leaves through **two types-only registry ports** defined in `client/src/ports.ts`: the declarative `FactsProfileRegistry` (`get(kind): FactsProfileDocument | undefined`) and the imperative `FactsRecompute` registry from `protocol` (`get(kind): RecordFactRecompute | undefined`, program §7.13). The concrete registries wiring the real leaf documents + recompute fns are assembled and injected **by the host**, not imported at the package boundary. This keeps `client` buildable at M6 with `facts/*` absent and is recorded as an assembly concern (see Findings). The inventory-guard graph entry for `client` therefore lists exactly `record-discovery-protocol` + `trust-core` as its runtime deps (matching the line-126 edge table); `client → facts/*` is a **host-assembled runtime injection, not a guard-enforced package edge**, so no `facts/*` dependency is ever added to `client/package.json` within this plan's scope.

- [ ] **Step 1:** append `client` to the four guard artifacts (graph: deps `record-discovery-protocol`, `trust-core`; dev `record-discovery-testing`; boundaries `CLIENT_FORBIDDEN_PACKAGES` = serve, TEP/Evidence record packages; ambient-network + locale bans; CI component job builds trust-core first). **Step 2:** scaffold. **Step 3:** guards green. **Commit** (`feat(discovery): scaffold record-discovery-client`).

### Task 19: Chain-walk sync + high-water-mark store (§5.3, §5.2)

**Files:**
- Create: `packages/discovery/client/src/sync.ts`, `src/high-water-mark.ts`
- Test: `src/sync.test.ts`

**Interfaces:**
- Produces: `coldSync(source, ports): AsyncIterable<{ entry; signature }>` (fetch head → walk `previous`/archive pages toward genesis, O(pages)); `returningSync(source, hwm, ports)` (head → high-water mark); an in-memory + injectable-persistent `HighWaterMarkStore`. Linkage depth is non-discretionary (§5.3 rule 5): to-genesis on first adoption before any decision-grade use; head→HWM for returning consumers; shallow mode is offered but flagged non-decision-grade.

- [ ] **Step 1: Failing tests** driven by the kit's chain vectors + a cold-start mirror-disagreement fixture (take the highest valid `(sequence, issuedAt)`, §5.2/§13.3). Run → FAIL. **Step 2:** implement (archive-page batching for cold start). **Step 3:** PASS. **Commit** (`feat(discovery): client chain-walk sync and high-water-mark store`).

### Task 20: Verification driver (wires trust-core key-binding resolution, §10.1/§10.3/§10.4)

**Files:**
- Create: `packages/discovery/client/src/verify-driver.ts`, `src/trust-adapter.ts`
- Test: `src/verify-driver.test.ts`

**Interfaces:**
- Produces: `trust-adapter.ts` implementing the `protocol` `KeyResolver` / `SignatureVerifier` / `FreshnessPolicy` ports on top of `@jinn-network/trust-core` (key-binding resolution under `DISCOVERY_SIGNING_SCOPE`, DSSE verification, freshness). `verify-driver.ts` composes `verifySourceChain` + `verifyItem` with the synced chain, threading the host-injected `FactsProfileRegistry` and `FactsRecompute` registries (Task 18 note; program §7.13) into `verifyItem`'s ports, and exposing `verifyForDecision(item)` (decision-grade path: chain verified, provenance verified, derivation-consistency mandatory) and `verifyForFilter(item)` (shallow-ok, §13.1).

- [ ] **Step 1:** Failing tests — the driver rejects a rotated-out-key head (`unauthorized-signer`) and a fabricated-provenance item (`unauthorized-provenance`), and requires `derivation-consistency` for a projected decision-grade item, using the kit vectors against the trust adapter. Run → FAIL. **Step 2:** implement (exact trust-core function names are settled by the trust plan; adapt to its frozen surface — see Findings). **Step 3:** PASS. **Commit** (`feat(discovery): client verification driver over trust-core`).

### Task 21: Query client (§8) + subscribe client (§9)

**Files:**
- Create: `packages/discovery/client/src/query.ts`, `src/subscribe.ts`
- Test: `src/query.test.ts`, `src/subscribe.test.ts`

**Interfaces:**
- Produces the `DiscoveryQueryService` **implementation** (§8) and the subscribe client (§9). The §8 interfaces are **owned by `@jinn-network/record-discovery-protocol`** (authored in `protocol/src/query.ts`, Task 8, program §7.12); `client` imports them and implements `DiscoveryQueryService` — it does **not** redefine them. Frozen protocol-owned shapes (imported, shown here as the pinned field sets):
  ```ts
  // import type { DiscoveryQueryService, Page, QueryCapabilities, FactsFilter, PageRequest }
  //   from "@jinn-network/record-discovery-protocol";
  interface QueryCapabilities { kinds: string[]; sources: SourceIdentity[]; freshness: Array<{ source: SourceIdentity; position: SourceCursor }>; }
  interface FactsFilter { [field: string]: unknown; }
  interface PageRequest { limit?: number; cursor?: string; }
  interface Page<T> { items: T[]; nextCursor?: string; complete: boolean; freshness: Array<{ source: SourceIdentity; position: SourceCursor }>; }
  interface DiscoveryQueryService {
    capabilities(): Promise<QueryCapabilities>;
    getRecord(digest: `sha256:${string}`): Promise<Uint8Array>;
    referrers(subject: `sha256:${string}`, filter?: { kind?: string }, page?: PageRequest): Promise<Page<AnnouncedItem>>;
    search(kind: string, facts: FactsFilter, page?: PageRequest): Promise<Page<AnnouncedItem>>;
  }
  // client authors: export class DiscoveryQueryClient implements DiscoveryQueryService { … }
  ```
  Query rules enforced client-side (§8): every item MUST carry provenance (else drop — the client never trusts an un-provenanced item); `complete` vs truncated is surfaced honestly; **no ranking**. Cursor conditions are detail codes under the TEP `invalid-reference` taxonomy (`cursor-unknown`, `cursor-too-old`). Subscribe: the five-case cursor contract (§9.3), relay-local cursors declared as such, dedupe via `announcementDedupeKey`, and the **two normative relay cross-checks** (§9.5) — periodic independent head-vs-delivered comparison, and entry-granular spot-checks that re-fetch full entries and re-apply filters locally (catches per-item-drop censoring). Pull-tail is the normative HTTP profile; optional push with the WebSub challenge-echo handshake.

- [ ] **Step 1:** Failing tests via the kit's `runQueryConformance` + `runSubscribeConformance` + `runConsumerConformance` (provenance-on-every-item, fabricated-provenance detection, `complete` honesty, cursor determinism with digest tie-break, the five cursor cases, dedupe key, observation pass-through, per-item-drop detection, ping-flood debounce, hostile-locator guards, head-vs-delivered downgrade, retrospective-withdrawal no-prune, `reorged` recompute). Run → FAIL.
- [ ] **Step 2:** implement query + subscribe clients + the relay cross-checks + the retrospective-withdrawal / `reorged` consumer obligations (§5.1). **Step 3:** run all three consumer/query/subscribe suites → PASS. **Commit** (`feat(discovery): client query and subscribe planes with relay cross-checks`).

  **Verification gate (M6 complete):** client full gate + `runQueryConformance`/`runSubscribeConformance`/`runConsumerConformance` green (trust-core built first); guards green.

---

## M7 — `facts/evidence` + `facts/trust` (not gated on the profiles plan)

Each facts leaf ships (a) the sealed, digest-pinned facts-profile **documents** for its record-kind tree (JSON + a `*.test.ts` pinning each document's sealed digest), and (b) the record-fact **recompute functions** the facts-consistency runner calls, derived from that tree's frozen bytes. Each labels every field record-fact vs substrate-fact, names reference-bearing fields, and declares CloudEvents attribute name + scalar type per liftable field (§12).

### Task 22: Scaffold `facts/evidence` + append to guards + the evidence facts profiles

**Files:**
- Create: `packages/discovery/facts/evidence/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts}`
- Create: `packages/discovery/facts/evidence/profiles/{execution-evidence,result-evaluation,execution-verification}.1.0.json` + `src/profiles.ts` + `src/profiles.test.ts` (pinned digests)
- Create: `packages/discovery/facts/evidence/src/recompute.ts` + `src/recompute.test.ts`
- Modify: the four guard artifacts (append `facts/evidence`).

**Interfaces:**
- `package.json`: dependencies `@jinn-network/record-discovery-protocol` (portal `../../protocol`), `@jinn-network/evidence-discovery` (portal `../../../evidence/discovery`; both the root export **and** the `/indexer` subpath), `@jinn-network/evidence-repository` (portal `../../../evidence/repository`).
- **Recompute derives from the record's BYTES, never from a supplied projection** (§5.4, program §7.13, resolving finding 3). The leaf's exported recompute fn calls `validateAndProjectEvidenceRecord(reference, bytes)` on the `@jinn-network/evidence-discovery/indexer` subpath — that function parses the sealed record bytes into the projection internally, so a lying source cannot publish a matching projection to spoof facts-consistency. `CatalogRecordProjection` is imported from `@jinn-network/evidence-discovery` **as the field-shape reference only** (the projection fields are "already frozen in the catalog contracts", §12; **imported, not re-declared** — Phase-0 disposition), not as a recompute input. `EVIDENCE_RECORD_FAMILIES` from `@jinn-network/evidence-repository` supplies the family → record-kind-URI map (`execution-evidence`→`RECORD_KINDS.executionEvidence`, etc.).

- [ ] **Step 1:** append `facts/evidence` to the four guard artifacts. **Note:** the inventory guard's `packageManifests` recursion already descends into `facts/`; the boundaries guard must add `facts/evidence` with a `FACTS_EVIDENCE_FORBIDDEN_PACKAGES` inventory (may import protocol + evidence-discovery — root **and** its `@jinn-network/evidence-discovery/indexer` subpath — + evidence-repository; **not** serve/client/TEP/trust); the boundaries allowlist must accept the `/indexer` subpath specifier, not just the bare package name; ambient-network + locale bans over its src; the packed-types guard must also pack `evidence-discovery` + `evidence-repository` (and their transitive `evidence-protocol`) as `file:` deps so both the root and `/indexer` subpath imports resolve under NodeNext; the CI job builds those evidence deps before installing. **Step 2:** scaffold.
- [ ] **Step 3:** Author the three facts-profile documents (declarative field labeling for record facts recomputable from record bytes; no substrate facts — author/retrospective evidence kinds, §5.4) and pin their sealed digests in `profiles.test.ts`. **Step 4:** implement and export `recompute.ts` — the per-kind recompute fns call `validateAndProjectEvidenceRecord` (evidence-discovery `/indexer` subpath) on the record **bytes** and map the resulting projection fields → record-fact values; add `recompute.test.ts` using evidence fixtures (including a spoofed-projection negative: a record whose bytes do not validate to the announced facts → `inconsistent`). **Step 5:** package gate + `runItemConformance`-style facts-consistency for evidence kinds via the kit (the leaf's recompute fns supplied through the kit's `FactsRecompute` registry). **Commit** (`feat(discovery): evidence facts profiles`).

### Task 23: Scaffold `facts/trust` + append to guards + the trust facts profiles

**Files:**
- Create: `packages/discovery/facts/trust/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts}`
- Create: `packages/discovery/facts/trust/profiles/{key-binding,authorization,trust-policy}.1.0.json` + `src/profiles.ts` + `src/profiles.test.ts` + `src/recompute.ts` + tests
- Modify: the four guard artifacts (append `facts/trust`).

**Interfaces:**
- `package.json`: dependencies `@jinn-network/record-discovery-protocol` (portal `../../protocol`), `@jinn-network/trust-core` (portal `../../../trust/core`).
- Record facts recomputed from the trust records' **bytes** (key-binding statement / authorization / trust-policy), the same bytes-in framing as the other leaves (program §7.13); `src/recompute.ts` **exports** the per-kind recompute fns that the host wires into the `FactsRecompute` registry. Field labeling per §5.4; reference-bearing fields named (e.g. a key binding's Agent IRI).

- [ ] **Step 1:** append `facts/trust` to guards (boundaries: protocol + trust-core only; packed-types packs trust-core). **Step 2:** scaffold. **Step 3:** author + pin the three profiles; implement + export recompute against trust-core record schemas parsed from bytes (exact schema names settled by the trust plan — adapt; see Findings, trust-core frozen-surface adaptation). **Step 4:** gate + kit facts-consistency for trust kinds (recompute fns supplied through the kit's `FactsRecompute` registry). **Commit** (`feat(discovery): trust facts profiles`).

  **Verification gate (M7 complete):** both facts leaves' full gates green (evidence + trust deps built first); guards green.

---

## M8 — `facts/task-execution` (gated on task-execution-profiles) + `sources/evidence-journal` wrapper (gated on M5)

**Gate assertion (run at M8 start):** `test -f packages/task-execution/profiles/package.json && (cd packages/task-execution/profiles && yarn install --immutable && yarn build)`. If absent, the M8 `facts/task-execution` leaf is blocked; the wrapper (Task 25) is **not** blocked on profiles and may proceed independently.

### Task 24: `facts/task-execution` — the single task-execution-tree facts leaf (§12, §5.4)

Per program §6.5 the task-execution tree has **one** facts leaf: `facts/task-execution` covers all seven kinds bound by `@jinn-network/task-execution-profiles` — Task, Submission, Delivery, profile-document, evaluation-spec, plugin, and checkpoint — with a single package, a single record-kind-tree dependency, and a single guard registration. The former `facts/profiles` split is folded in (one leaf per record-kind tree, discovery design §17); the tree therefore ships exactly **three** facts leaves total — evidence, task-execution, trust.

**Files:**
- Create: `packages/discovery/facts/task-execution/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts}`
- Create: `packages/discovery/facts/task-execution/profiles/{task,submission,delivery,profile-document,evaluation-spec,plugin,checkpoint}.1.0.json` + `src/profiles.ts` + tests + `src/recompute.ts` + tests
- Modify: the four guard artifacts (append `facts/task-execution`).

**Interfaces:**
- `package.json`: dependencies `@jinn-network/record-discovery-protocol` (portal `../../protocol`), `@jinn-network/task-execution-profiles` (portal `../../../task-execution/profiles`) — the single record-kind-tree dependency for all seven kinds.
- The **Submission** card is the operator-filter carrier the profiles design named (§5.4, §12): **record facts** = Task digest + task profile URI (drawn from the referenced Task) + requester IRI + deadline (from the Submission bytes); **substrate facts** = terms (escrow terms, claim window — projection-only, marketplace profile, §6.3). Reference-bearing field: the Submission's Task digest (so `referrers` inverts Task → Submissions). The **Delivery** card: Task digest, deterministic Attempt URI, outcome. Because it carries substrate facts, the Submission profile's substrate fields MUST be marked `substrate` (author sources reject them; only the marketplace projection may carry them).
- The **profile-document / evaluation-spec / plugin / checkpoint** cards (§12 last row): record facts recomputed from each kind's defining bytes (profile documents, evaluation specifications, plugin + checkpoint artifacts); no substrate facts.
- All record facts recompute **from record bytes** (program §7.13); `src/recompute.ts` **exports** the per-kind recompute fns the host wires into the `FactsRecompute` registry.

- [ ] **Step 1:** append `facts/task-execution` to guards (boundaries: protocol + task-execution-profiles; packed-types packs task-execution-profiles + its transitive TEP protocol; CI builds them first). **Step 2:** scaffold. **Step 3:** author + pin the seven profiles; the Submission profile labels record vs substrate fields precisely; implement + export recompute from the referenced TEP / profiles-design bytes (field names per the profiles design + TEP protocol — cite the profiles design's discovery-visible-facts list). **Step 4:** gate + kit facts-consistency (including the `indeterminate` case when the referenced Task bytes are unavailable, §5.4; recompute fns supplied through the kit's `FactsRecompute` registry). **Commit** (`feat(discovery): task-execution facts profiles`).

### Task 25: `sources/evidence-journal` — the evidence published-source wrapper (§11)

**Files:**
- Create: `packages/discovery/sources/evidence-journal/{package.json,tsconfig*.json,scripts/*,README.md,src/index.ts}`
- Create: `src/project.ts` (the pinned projection), `src/reconcile.ts` (journal + catalog → one chain), `src/publish.ts` (re-seal + head + serve)
- Test: `src/project.test.ts`, `src/reconcile.test.ts` + fixtures `fixtures/pinned-projection/*.json`
- Modify: the four guard artifacts (append `sources/evidence-journal`).

**Interfaces:**
- `package.json`: dependencies `@jinn-network/record-discovery-protocol` (portal `../../protocol`), `@jinn-network/record-discovery-serve` (portal `../../serve`), `@jinn-network/evidence-discovery` (portal `../../../evidence/discovery`), `@jinn-network/evidence-repository` (portal `../../../evidence/repository`).
- Consumes the frozen contracts (verified at HEAD): `AnnouncementJournalEntryV1 { version, revision, predecessorDigest?, announcement(available-only) }` (`packages/evidence/discovery/src/journal/types.ts`) and `EvidenceRecordAnnouncementSource.read({after})` yielding `AnnouncementBatch` whose `announcements` is the `available | withdrawn` union (`packages/evidence/discovery/src/catalog/types.ts`) — the withdrawal shape is `RecordLocationWithdrawal { sourceId, announcementId, retractsAnnouncementId }`. **Zero edits to these frozen contracts.**
- Produces a deterministic projection that **transforms** journal entries into the discovery Announcement Entry shape and maintains its **own** re-sealed chain, head, and DSSE signatures (it does NOT sign journal bytes as-is). Reconciliation subtlety (Phase-0 finding, confirmed against code): the **available** chain comes from the append-only journal (`AnnouncementJournalEntryV1`), the **withdrawals** come from the catalog's `EvidenceRecordAnnouncementSource` (the union carries both) — the wrapper merges both surfaces into one projected chain.

- [ ] **Step 1: Append `sources/evidence-journal` to the four guard artifacts.** The inventory guard's `packageManifests` recursion already descends into `sources/`. Boundaries: `SOURCE_EVIDENCE_JOURNAL_FORBIDDEN_PACKAGES` = client/facts/*/TEP/trust; **allowed**: protocol, serve, evidence-discovery, evidence-repository; ambient-network + locale bans; packed-types packs serve + evidence-discovery + evidence-repository; CI builds those first. **This is the rule-wording widening** the coordinator recorded: `sources/*` joins `facts/*` as a place a discovery edge meets a record-kind edge — the boundaries guard must permit `sources/evidence-journal → evidence-discovery` (see Findings).
- [ ] **Step 2: Write failing projection tests** pinning §11's map:
  - journal `revision` → fixed-width `sequence` **affinely**: the first projected entry is `GENESIS_SEQUENCE` and increments by one; the wrapper records its **offset once**, at wrap time (`offset = firstJournalRevision - 1`), persisted so re-runs are deterministic;
  - the single `announcement` → a one-item `announcements[]`; `predecessorDigest` → `previous` **over the RE-SEALED projected chain** (not the journal's own digest);
  - `reference{family,digest}` → `record{ kind: familyToKind(family), digest }`, `publishedLocation` → `locations[]`;
  - evidence **withdrawals** (from the catalog union) → `action:"withdrawn"` with `reason:"delisted"` (the layer has no substrate; it never emits `reorged`), `retracts` = the catalog's `retractsAnnouncementId`;
  - determinism: the same journal + catalog inputs always produce byte-identical re-sealed entries (pinned-digest fixtures).
  Run → FAIL.
- [ ] **Step 3: Implement `project.ts` + `reconcile.ts` + `publish.ts`.** `reconcile.ts` walks `journal.read` for the available chain and `catalog EvidenceRecordAnnouncementSource.read` for withdrawals, orders by journal revision using `compareCodeUnitStrings` on the projected fixed-width sequence, and emits a merged, re-sealed chain; `publish.ts` writes via `record-discovery-serve` (layout writer + head maintenance + DSSE signing through an injected signer). The unpublished journal stays the system of record (§17). The wrapper does **not** emit facts cards in v1 (§11 maps no facts card; evidence facts cards via `facts/evidence` are a later enhancement — see Out-of-scope).
- [ ] **Step 4:** Run the projection tests + the kit's `runSourceConformance` against the wrapper's published output → PASS. **Commit** (`feat(discovery): evidence published-source wrapper`).

  **Verification gate (M8 complete):** both M8 packages' full gates green (task-execution-profiles + serve + evidence deps built first); guards green on the final 8-package set (protocol, testing, serve, client, facts/evidence, facts/trust, facts/task-execution, sources/evidence-journal).

---

## Findings

This is the plan's consolidated cross-lane risk / coordination register: every "see Findings" pointer above resolves to one entry here. Program-doc §7 rulings (`docs/superpowers/plans/2026-07-28-stack-implementation-program.md`) are binding; where a ruling settles an item it is cited and the item is closed.

- **F1 — Pinned-identifier program-gate flags** (resolves the §Pinned-identifiers pointer). Every string in `protocol/src/identifiers.ts` — the protocol version/family URIs, the record-kind URIs, the location-profile URIs, the media types, and `DISCOVERY_SIGNING_SCOPE` — is a naming decision the design left to implementation (§7, §12, §15). They are pinned here so the tree can build and surfaced to the program gate for confirmation (program §6 "flagged for confirmation" table + §8 reserved-URI checklist). Downstream code never hardcodes a copy; it imports from `identifiers.ts`. Non-blocking for internal work; gating only for EXTERNAL conformance claims, where the reserved URIs must resolve first (program §8).
- **F2 — `DISCOVERY_SIGNING_SCOPE` cross-lane registration dependency** (resolves the identifiers-block pointer; §5.5). **RESOLVED by program §7.11.** The announce-plane scope is the fixed string `jinn:discovery-announcements`, deliberately conformant with trust-core's namespaced-scope grammar (`namespace:custom`) — an ordinary opaque namespaced scope, NOT a closed-set entry requiring a trust-core change. The design §5.5 "registered through the trust layer's scope-extension mechanism" framing is superseded: no trust-core code change gates discovery signing. The coordination artifact is a fixture, not a gate — the discovery testing kit carries a **cross-tree parse-assertion fixture** that `DISCOVERY_SIGNING_SCOPE` parses under trust's `ScopeVocabulary`, and both trees cite the one constant. If that assertion ever fails (trust later tightens its grammar), that failure is the signal to re-open; on the current grammar the item is closed.
- **F3 — Facts-consistency recompute seam** (resolves the review blocker; §5.4, §10.4). **RESOLVED by program §7.13.** Facts-profile documents stay declarative; the per-kind, imperative record-fact recompute fns live in the `facts/*` leaves and reach the protocol runner through the injected `FactsRecompute` registry port (Task 8), threaded through `verifyItem` and the M3 harness and injected by the host. Record facts recompute from record **bytes**, never from a supplied projection; the evidence leaf does so via `validateAndProjectEvidenceRecord` on the `@jinn-network/evidence-discovery/indexer` subpath (Task 22), with `CatalogRecordProjection` as the field-shape reference only. This closes the "no seam to inject leaf recompute fns" blocker and the "recompute from a projection defeats facts-consistency" trust hole.
- **F4 — `FactsProfileRegistry` + `FactsRecompute` host-assembly disposition** (resolves the Task 18 pointer). `client` consumes the facts leaves at runtime but declares no `facts/*` package dependency: it reaches them through the two types-only registry ports (Task 18 note), and the concrete registries (real leaf documents + recompute fns) are assembled and injected by the **host**. Building that host-assembly package is **out of this plan's scope** — it lands with the daemon-consumption swap (§19 / Out-of-scope). Within this plan `client` is buildable at M6 with `facts/*` absent, and `client → facts/*` is a host-assembled runtime injection, not a guard-enforced package edge (consistent with the line-126 edge table and the `client` inventory-guard graph entry, which lists exactly `record-discovery-protocol` + `trust-core`).
- **F5 — trust-core frozen-surface adaptation** (resolves the Task 20 + Task 23 pointers). The exact trust-core export names (seal-and-digest fn, key-binding resolver, DSSE verifier, freshness policy, record schemas) are settled by `2026-07-28-trust-layer.md`, not here. The discovery client's `trust-adapter.ts` (Task 20) and `facts/trust`'s recompute (Task 23) adapt to that frozen surface: this plan names the trust-core functions only by role, and binds the concrete symbols at implementation time against the built `@jinn-network/trust-core`. This is a **sequencing coordination**, not an open design question — the Preflight gates M1 on trust-core existing and building (F6), and program §7.1 / §7.9 fix the sealing-byte and dependency-floor contracts the adapter relies on.
- **F6 — Cross-plan gating: trust-core must build before M1** (resolves the Preflight pointer). `discovery/protocol` (M1) cannot typecheck until `@jinn-network/trust-core` exists and builds — the only cross-protocol import at the discovery core. The Preflight asserts this concretely (`test -f packages/trust/core/package.json` + build); if absent, **stop** — M1 is blocked on the trust-layer plan. `@jinn-network/task-execution-profiles` is the analogous M8 gate (asserted at M8 start); the evidence packages are consumed as already-landed frozen contracts (Preflight branch-base assertion on `3650ac65e`).
- **F7 — `sources/*` boundary rule-widening rationale** (resolves the wrapper Task 25 pointer). The original program rule 1 named only `facts/*` as the place a discovery edge meets a record-kind edge. Program §6 (confirmation item 4) widens the wording to "leaf packages under `packages/discovery/` (`facts/*`, `sources/*`) are the only places a discovery edge and a record-kind edge meet," so `sources/evidence-journal → evidence-discovery` / `evidence-repository` is a sanctioned leaf edge, not a boundary violation. The evidence-tree-home alternative is rejected: evidence packages never import discovery. The wrapper's boundaries-guard inventory (`SOURCE_EVIDENCE_JOURNAL_FORBIDDEN_PACKAGES`) encodes exactly this — allow protocol / serve / evidence-*, forbid client / facts/* / TEP / trust.
- **F8 — Query-plane frozen-interface ownership** (recorded; program §7.12). `DiscoveryQueryService`, `Page`, `QueryCapabilities`, `FactsFilter`, and `PageRequest` (§8 / §16.9) are owned by `record-discovery-protocol` (Task 8) so the M3 kit can reference them before `client` exists; `client` (Task 21) imports and implements them. Kit-before-implementation is preserved.
- **F9 — Facts-leaf granularity fold** (recorded; program §6.5). Adjudicated by review to **three** leaves: `facts/profiles` folds into `facts/task-execution` (one leaf per record-kind tree, discovery design §17 — both bound the same `task-execution-profiles` tree). The single `facts/task-execution` leaf covers Task, Submission, Delivery, profile-document, evaluation-spec, plugin, and checkpoint kinds (Task 24).

---

## Out of scope (deferred; do not implement here)

Per the design (§17, §20, §21) and the coordinator brief:

- **Marketplace projector (projector #1)** — an application of the protocol living in the **marketplace tree** beside the binding, not under `packages/discovery/`; deferred on the marketplace-binding design (§6.3, §17, §20 stage 3).
- **Query-plane service** implementation (the aggregator/cache over followed chains, §8/§20 stage 4) — built *over* the projector; deferred. `client` implements the query *client* interface only.
- **Subscribe relay / subscribe-plane service** (§9/§20 stage 5) — `client` implements the subscribe *client* + relay cross-checks only; the relay/plane service is deferred.
- **Daemon consumption swap** (§19, §20 stage 6) — re-homing the client's `DiscoveryAPI`, engine-watcher, on-chain floor, the four fail-closed empties, `joinedSolverNets` → sources + filters. Migration mechanics are a **separate spec** (§19).
- **Transparency-log / witness profile, reader privacy, observation-archive record kind, IPFS/filesystem serving profiles, C2SP signed-note head projection, facts-profile registry governance** (§22 follow-ups; the last is the §22 registry-governance item).
- **Evidence facts cards on the wrapper** — the v1 wrapper is the mechanical §11 field-map (no facts card); enriching wrapper output with `facts/evidence` cards is a follow-up.
- **Extracting a shared sealing package** — deferred per §17; the equivalence fixtures (Task 5) keep a later extraction mechanical.

## Self-review

- **Spec coverage.** §5.1 Announcement Entry → Task 4; §5.2 Source Head → Task 4/Task 16; §5.3 chain rules → Task 12; §5.4 facts cards → Task 6/Task 13 + facts leaves + the `FactsRecompute` seam (Task 8); §5.5 signing posture → identifiers + Task 12/16; §6 source classes / derivation → Task 8/13/20; §7 serving plane → M5; §8 query interfaces → Task 8 (owned in `protocol`, program §7.12) + Task 21 (client implementation); §9 subscribe + §9.1 CloudEvents → Task 7 + Task 21; §10.1/§10.3/§10.4 → Tasks 8/12/13/20; §11 crosswalk/wrapper → Task 25; §12 record kinds + facts-profile contract + URI grammar → Tasks 3/6 + the three facts leaves M7/M8 (evidence, task-execution, trust); §16 frozen interfaces → the frozen field sets in Tasks 4/6/8/21; §18 conformance → M3. Deferred sections (§19 migration, §20 stages 3–6, §21, §22) are in Out-of-scope.
- **Placeholder scan.** Frozen field sets, identifiers, grammars, guard constant blocks, and verification-step orderings are fully specified; procedure bodies that are long (chain walk, layout writer, wrapper reconcile) are specified by exact behavior + the kit vectors that gate them rather than transcribed line-by-line — deliberate, because the kit is the executable spec (CSI). No "TBD"/"handle edge cases"/"similar to" placeholders remain.
- **Type consistency.** `AnnouncedItem`, `SourceHead`, `AnnouncementEntry`, `SourceCursor`, `FactsProfileDocument`, the port interfaces (including `FactsRecompute`), the §8 query interfaces (`DiscoveryQueryService`/`Page`/`QueryCapabilities`/`FactsFilter`/`PageRequest`), and the typed outcomes are each defined **once** — all in `protocol` (Tasks 4/6/8) — and imported/referenced by name thereafter; `client` (Task 21) imports and implements `DiscoveryQueryService` rather than redefining it.

## Addendum 2026-07-28-b — benchmarking facts-profile fields (companion amendment)

The approved benchmarking-application design
(`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §11, §17.5) declares an
ADDITIVE amendment to the **Submission and Delivery facts profiles**: optional namespaced
fields `benchrun` / `benchcell` / `bencharm`, declared as CloudEvents filter attributes. The
`facts/task-execution` leaf (M8) MUST author the Submission and Delivery facts-profile
documents with these optional fields and their attribute lifts **from day one** — absent on
non-benchmarking records, opaque to the core, never reopened later. A fourth leaf
`discovery/facts/benchmarking` is OUT of this plan (owned by the benchmarking-application
plan).
