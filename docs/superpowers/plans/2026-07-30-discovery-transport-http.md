# Discovery Transport HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** build `packages/discovery/transport-http/` — the production HTTP plugs for the
record-discovery serve/client pair (filesystem `BlobStore`, an archive HTTP handler over
`serve`'s static layout, and client-side `Transport` / `StreamTransport` / ping) implementing
the composition design's §7.3 wire profile, plus the conformance kit, guard trio, and CI
wiring.

**Architecture:** `serve` writes a static layout through an injected `BlobStore`; `client`
reads it through injected `Transport` / `StreamTransport` ports. Neither package may touch a
filesystem or a network — the discovery tree's guard bans ambient network APIs outright. This
package is the single leaf where those two edges meet: it supplies a real filesystem store, a
fetch-style `(Request) => Promise<Response>` handler that serves exactly that layout under
RFC 9110/9111 caching semantics plus an SSE tail, and the two client-side transports that
consume it. Every effect still arrives injected (`rootDir`, `fetchLike`) — the package
contains no ambient `fetch`, no `EventSource`, no signer, and no key material.

**Tech Stack:** TypeScript 5.9 / Node 22 / Yarn 4.13.0 standalone project with `portal:`
resolutions; vitest 4; `node:fs/promises`; Web `Request`/`Response`/`ReadableStream`; the
`@jinn-network/record-discovery-testing` conformance kit.

## Global Constraints

- **Branch target:** `integration/evidence-v1`. Baseline head `8c7179f2c`; PRs #2306 / #2307 /
  #2308 assumed merged. Stacked PR train, one train for this component plan. No agent
  self-merge.
- **Designs are law.** The owning protocol design is
  `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` (archive semantics:
  §7 serving plane, §8 query-plane detail codes, §9.1 CloudEvents wire, §9.3 cursor contract,
  §9.4 the open transport choice this package closes, §18 conformance). The composition design
  is `docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` §6.2, §7 ruling
  3, §12 follow-up 4. Discoveries are findings with proposed dispositions, never silent
  patches.
- **Kits and fixtures before implementations.** Tasks 2–3 (kit) land before Tasks 4–13 (impl).
- **Guard trio ships with the tree, not after** — package inventory, source boundaries,
  packed-types canaries, plus the CI job (Task 1).
- **npm name:** `@jinn-network/record-discovery-transport-http`, version `0.1.0`.
- **BINDING factory surfaces** (program §5, no renames): `createFsBlobStore(rootDir)`,
  `createArchiveHttpHandler(opts)` (fetch-style, mountable under a Hono route),
  `createHttpTransport(baseUrl, fetchLike)`, `createSseStreamTransport(baseUrl, fetchLike)`.
- **Read-plane only.** No signers, no keystore, no key-loading code, no key material anywhere
  in this package (trivially custody-law clean; state it in the README).
- **The discovery ambient-network guard applies to this package's production source.** The
  identifiers `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` must not appear as bare
  identifiers in any non-`.test.ts` file under `src/`. Consequences that are not optional:
  every network effect arrives as an injected `FetchLike`; the SSE client is a hand-written
  frame parser over a streamed response body, never `EventSource`; a `Transport`
  implementation's method name is written quoted (`"fetch"(url)`), exactly as
  `client/src/ports.ts` already does, because the guard is a textual scanner.
- **No locale-sensitive APIs** in production source (`localeCompare`, `toLocale*`, `Intl`) —
  the same guard bans them tree-wide. Use `compareCodeUnitStrings` from `protocol`.
- **American English** throughout; no product names in tier-3 code; no emoji anywhere.
- **Exposure scoping (program §6 contract 7)** is enforced in this package: the handler serves
  only the archive subtree route set and only for explicitly listed source names; everything
  else 404s. The opt-in non-localhost bind and the IP-disclosure copy are stage-4 host work,
  not this plan's.
- Every task ends with `yarn typecheck && yarn test` in the package directory plus the touched
  guards, outputs shown.

---

## Design findings (raised here, dispositions proposed; confirm before Task 8)

These are the places where implementing §7.3 forced a decision the designs did not fully pin.
Each is implemented as proposed below and recorded in the Task 15 addendum.

1. **Detail-code naming collision.** The composition design §7.3 names the terminal events
   `unknown-cursor` / `cursor-too-old`. The owning discovery design §8 pins the cursor detail
   codes as `cursor-unknown` and `cursor-too-old` ("cursor conditions (§9.3) are detail codes
   under `invalid-reference` (`cursor-unknown`, `cursor-too-old`)"). *Disposition:* the owning
   design wins — the wire uses `cursor-unknown`; `unknown-cursor` is a transposition. Recorded
   in the addendum.
2. **`classifyCursor` emits no detail code for the unknown case.**
   `client/src/subscribe.ts` returns `{ behavior: "typed-error-close" }` with `detailCode`
   undefined for both the unknown-or-future case and the beyond-window case, and the existing
   fixture `subscribe-cursor-unknown-or-future` expects exactly that. *Disposition:* the
   server maps `typed-error-close` with no detail code to the `cursor-unknown` wire event. No
   change to `client` (frozen surface); the mapping is a new kit fixture.
3. **`StreamTransport` cannot express a typed terminal event.** The frozen port is
   `connect(url, onMessage, onError)` — no cursor argument, no terminal channel.
   *Disposition:* terminal events surface through `onError` as an exported typed
   `CursorTerminalError` carrying `{ code: "invalid-reference", detailCode, coldSync }`,
   followed by `close()` and no reconnect. The subscribe cursor rides the `url` argument
   (`?cursor=`) and thereafter the SSE `id:` field / `Last-Event-ID` header. `client` is not
   modified.
4. **Terminal conditions are SSE events, not HTTP statuses.** §7.3 requires "typed terminal
   SSE events … followed by stream close," and the `StreamTransport` port never sees a status
   code. *Disposition:* the subscribe route answers `200 text/event-stream` in all five cursor
   cases and expresses `cursor-unknown` / `cursor-too-old` as terminal events, each naming the
   cold-sync path (`archiveRoot`, `headPath`) per §9.3's "never silent gap-skipping."
5. **The newest archive page is not immutable in practice.** §7 item 2 calls archive pages
   immutable and §7.3 says `Cache-Control: immutable` on archive pages, but
   `serve/src/archive.ts`'s `writeArchivePages` re-partitions from scratch on every call, so
   the newest page's bytes change until it fills to `CEILINGS.archivePageBytes`. Marking it
   `immutable` would poison caches. *Disposition:* `immutable` is served on *sealed* pages
   only. The handler takes an optional `currentPage(sourceName)` resolver; the current page
   gets `no-cache` + `ETag`, every other page gets `immutable`. With the resolver omitted the
   handler is safe-by-default: all pages get `no-cache` + `ETag`.
6. **`transport-http` is the one leaf where `serve` and `client` meet.** The source-boundary
   guard's existing rule forbids `serve → client` and `client → serve`. This package must
   implement port types from both. *Disposition:* widen the rule exactly as the guard already
   widened it for `facts/*` and `sources/*` leaves — name `transport-http` as the sanctioned
   serve+client meeting leaf, and add a new guard assertion that every import from
   `@jinn-network/record-discovery-client` in this package is `import type` (types only, no
   runtime edge). Enforced in Task 1.
7. **The well-known document's TypeScript interface is closed.**
   `serve/src/well-known.ts` validates with `z.looseObject` (extra keys pass) but
   `WellKnownSourceEntry` is a closed TS interface, so a host cannot add the advertised replay
   window without a cast. *Disposition:* this package exports
   `withSubscribeAdvertisement(document, advertisement)` returning a typed extension that
   `writeWellKnownDocument` still accepts. `serve` is not modified.
8. **`serve`'s `BlobStore` is put-only** — `packages/discovery/serve/src/ports.ts` declares
   `put(path, bytes, contentType)` and nothing else. There is no read side to hand the
   handler. *Disposition* (coordinator ruling, 2026-07-30): `createArchiveHttpHandler(opts)`
   takes `opts.rootDir` and serves the static layout directly from the filesystem; it never
   takes a `BlobStore`. `createFsBlobStore(rootDir)` remains the *write* side — the store the
   projector loop and the evidence driver hand to `serve` — and is unaffected. The read side
   is this package's internal `LayoutReader` over the same root.

**Cross-plan kit ownership** (coordinator ruling, 2026-07-30): `packages/discovery/testing/`
owns exactly ONE serving-plane conformance suite, `runServingPlaneConformance`. This plan
authors it (Tasks 2–3), because the program's kit-first constraint puts it before this
package's handler in phase 0; the stage-4 discovery-serving plan **extends** the same suite
with its live-surface cases rather than minting a parallel one. If the stage-4 train lands the
suite first, Tasks 2–3 extend the existing suite instead of creating it — either way there is
one suite, one vector kind, one under-test interface. This package owns only its own unit
tests.

---

## File structure

All paths relative to `packages/discovery/transport-http/` unless stated.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `README.md` | Standalone-project scaffold, mirroring `packages/discovery/serve/` exactly |
| `src/ports.ts` | `LayoutReader`, `FsBlobStore`, `BlobStat`, `ByteRange`, `FetchLike` — the shapes this package adds on top of `serve`'s put-only `BlobStore` |
| `src/fs-blob-store.ts` | `createFsBlobStore(rootDir)` (write side) and `createLayoutReader(rootDir)` (read side) — atomic writes, sidecar metadata, containment |
| `src/http-headers.ts` | The §7.3 wire profile primitives: ETag, cache-control classes, conditional GET, Range |
| `src/relay.ts` | `createBoundedReplayRelay` — relay-local cursors, bounded advertised window |
| `src/sse.ts` | Server-side SSE framing and terminal-event formatting |
| `src/sse-parse.ts` | Client-side SSE frame parser (no `EventSource`) |
| `src/archive-handler.ts` | `createArchiveHttpHandler(opts)` — routing, exposure scoping, static routes, the SSE subscribe route, the optional ping-receive route |
| `src/well-known.ts` | `withSubscribeAdvertisement` |
| `src/transport.ts` | `createHttpTransport(baseUrl, fetchLike)` |
| `src/stream-transport.ts` | `createSseStreamTransport(baseUrl, fetchLike)`, `CursorTerminalError` |
| `src/ping.ts` | `createHttpPingTransport(endpointUrl, fetchLike)` |
| `src/index.ts` | Public surface |
| `packages/discovery/testing/fixtures/vectors/serving-plane-*/vector.json` | 16 new golden vectors (Task 2) |
| `packages/discovery/testing/src/conformance.ts` | `ServingPlaneUnderTest` + `runServingPlaneConformance` (Task 3) |
| `.github/scripts/record-discovery-{package-inventory,source-boundaries,packed-types}.test.mjs` | Guard trio entries (Task 1) |
| `.github/workflows/record-discovery-ci.yml` | `transport-http` job (Task 1) |
| `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` | Dated addendum (Task 15) |

---

## Task 1: Package scaffold and the guard trio

**Files:**
- Create: `packages/discovery/transport-http/package.json`, `tsconfig.json`,
  `tsconfig.build.json`, `.yarnrc.yml`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`,
  `src/index.ts`, `src/index.test.ts`
- Modify: `.github/scripts/record-discovery-package-inventory.test.mjs`,
  `.github/scripts/record-discovery-source-boundaries.test.mjs`,
  `.github/scripts/record-discovery-packed-types.test.mjs`,
  `.github/workflows/record-discovery-ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: the package root every later task builds in; the guard entries every later task's
  source must satisfy.

- [ ] **Step 1: Write the failing guard entries**

Add to `.github/scripts/record-discovery-package-inventory.test.mjs`, at the end of
`DISCOVERY_PACKAGES`:

```js
  ['transport-http', '@jinn-network/record-discovery-transport-http'],
```

and to `JINN_DEPENDENCY_GRAPH`:

```js
  // transport-http is the one leaf where the serve edge and the client edge
  // meet (composition design §6.2): it implements serve's BlobStore/
  // PingTransport and client's Transport/StreamTransport. The client edge is
  // types-only, separately asserted by the source-boundaries guard. trust-core
  // is the usual shadow devDependency + portal resolution -- client's own npm
  // dependency on it needs a top-level override in this standalone project.
  ['transport-http', {
    dependencies: [
      '@jinn-network/record-discovery-client',
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/record-discovery-serve',
    ],
    devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'],
    optionalDependencies: [], peerDependencies: [],
  }],
```

Add to `.github/scripts/record-discovery-source-boundaries.test.mjs`: `'transport-http'` at
the end of `discoveryDirectories`, then this list and these two tests:

```js
// transport-http is the sanctioned serve+client meeting leaf (composition
// design §6.2, this plan's Finding 6): protocol + serve (production) and
// client (TYPES ONLY, separately asserted below) are allowed; no facts/*
// leaf, no source/* leaf, no TEP/Evidence record packages, no trust (it
// verifies nothing -- verification is client's job).
const TRANSPORT_HTTP_FORBIDDEN_PACKAGES = [
  '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/record-discovery-source-evidence-journal',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery',
];

test('record-discovery-transport-http production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'transport-http', 'src'), TRANSPORT_HTTP_FORBIDDEN_PACKAGES);
});

test('record-discovery-transport-http reaches record-discovery-client through type-only imports', () => {
  const source = join(packages, 'transport-http', 'src');
  if (!existsSync(source)) return;
  const offenders = files(source).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/^[^\n]*@jinn-network\/record-discovery-client[^\n]*$/gmu)]
      .filter((match) => !/\bimport\s+type\b|\bexport\s+type\b/u.test(match[0]))
      .map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  }).sort();
  assert.deepEqual(offenders, [],
    'transport-http may reference record-discovery-client only through `import type` / `export type`');
});
```

Add `['transport-http', '@jinn-network/record-discovery-transport-http']` to the `packages`
array and `'@jinn-network/record-discovery-transport-http'` to `codeEntrypoints` in
`.github/scripts/record-discovery-packed-types.test.mjs`.

- [ ] **Step 2: Run the guards to verify they fail**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071"
node --test .github/scripts/record-discovery-package-inventory.test.mjs
```
Expected: FAIL — `packages/discovery/transport-http/package.json` does not exist.

- [ ] **Step 3: Create the scaffold**

`packages/discovery/transport-http/package.json`:

```json
{
  "name": "@jinn-network/record-discovery-transport-http",
  "version": "0.1.0",
  "description": "Production HTTP transports for the Jinn Record Discovery Protocol v1: a filesystem blob store, an archive HTTP handler over the serving-plane static layout, and the client-side fetch and SSE transports.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/discovery/transport-http"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./fixtures/*": "./fixtures/*"
  },
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
    "@jinn-network/record-discovery-client": "0.1.0",
    "@jinn-network/record-discovery-protocol": "0.1.0",
    "@jinn-network/record-discovery-serve": "0.1.0"
  },
  "devDependencies": {
    "@jinn-network/record-discovery-testing": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/record-discovery-client": "portal:../client",
    "@jinn-network/record-discovery-protocol": "portal:../protocol",
    "@jinn-network/record-discovery-serve": "portal:../serve",
    "@jinn-network/record-discovery-testing": "portal:../testing",
    "@jinn-network/trust-core": "portal:../../trust/core"
  }
}
```

`.yarnrc.yml` is one line, `nodeLinker: node-modules`. `tsconfig.json` and
`tsconfig.build.json` are byte-identical copies of `packages/discovery/serve/`'s. Copy
`scripts/build.mjs` verbatim from `packages/discovery/serve/scripts/build.mjs`. Copy
`scripts/pack-smoke.mjs` from serve's and extend the portal set — this package packs four
portals, in dependency order:

```js
const protocolRoot = join(packageRoot, "..", "protocol");
const serveRoot = join(packageRoot, "..", "serve");
const clientRoot = join(packageRoot, "..", "client");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
// ... one `<name>Archive` per root, then:
await packPortal(trustCoreRoot, trustCoreArchive);
await packPortal(protocolRoot, protocolArchive);
await packPortal(serveRoot, serveArchive);
await packPortal(clientRoot, clientArchive);
await packPortal(packageRoot, archive);
```

with the consumer `package.json`'s `dependencies` mapping all five to their `file:` archives,
mirroring serve's own consumer block.

`src/index.ts`:

```ts
export * from "./ports.js";
```

`src/ports.ts` (the shapes Task 4 onward build on):

```ts
import type { BlobStore } from "@jinn-network/record-discovery-serve";

// `serve`'s BlobStore is put-only (serve publishes; it never serves), so this
// package supplies the read side separately rather than widening serve's port.
// The handler reads a filesystem root directly; the store is the write side the
// projector loop hands to serve.

/** A byte range with both bounds inclusive, as RFC 9110 defines them. */
export interface ByteRange {
  start: number;
  endInclusive: number;
}

export interface BlobStat {
  size: number;
  contentType: string;
  /** Strong entity tag over the exact stored bytes, quoted, e.g. `"sha256:ab…"`. */
  etag: string;
}

/** Read side of the serving-plane static layout, resolved against one filesystem root. */
export interface LayoutReader {
  stat(path: string): Promise<BlobStat | undefined>;
  read(path: string, range?: ByteRange): Promise<{ bytes: Uint8Array; stat: BlobStat } | undefined>;
}

/** Write side: `serve`'s put-only BlobStore, plus the root it writes under. */
export interface FsBlobStore extends BlobStore {
  readonly rootDir: string;
}

// Structurally satisfied by the platform's own fetch implementation, declared
// here rather than referenced by name: the discovery tree's source-boundary
// guard bans the bare `fetch` identifier in production source.
export interface FetchLikeResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}

export interface FetchLikeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;
```

`src/index.test.ts`:

```ts
import { expect, it } from "vitest";
import type { LayoutReader } from "./index.js";

it("exports the serving-plane read port", () => {
  const reader: Pick<LayoutReader, "stat"> = { stat: async () => undefined };
  expect(typeof reader.stat).toBe("function");
});
```

- [ ] **Step 4: Add the CI job**

In `.github/workflows/record-discovery-ci.yml`, add a `transport-http` job after `client`,
copying the `client` job verbatim and changing four things: `needs: [foundation, testing, serve, client]`;
two extra "Restore … distribution" steps (`record-discovery-serve-dist` →
`packages/discovery/serve/dist`, `record-discovery-client-dist` →
`packages/discovery/client/dist`) and their matching "Install … toolchain (packed-smoke
dependency)" `yarn install --immutable` steps for `packages/discovery/serve` and
`packages/discovery/client`; `working-directory: packages/discovery/transport-http`; and the
upload artifact name `record-discovery-transport-http-dist`.

- [ ] **Step 5: Verify green**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071/packages/discovery/transport-http"
yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../../.. && node --test .github/scripts/record-discovery-package-inventory.test.mjs \
  && node --test .github/scripts/record-discovery-source-boundaries.test.mjs
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/discovery/transport-http .github/scripts .github/workflows/record-discovery-ci.yml
git commit -m "chore(discovery): scaffold record-discovery-transport-http with the guard trio"
```

---

## Task 2: Conformance vectors for the §7.3 wire profile

**Files:**
- Create: `packages/discovery/testing/fixtures/vectors/serving-plane-*/vector.json` (16 directories)
- Test: `packages/discovery/testing/src/vectors.test.ts` (existing; it validates the whole corpus)

**Interfaces:**
- Consumes: the `Vector` shape from `packages/discovery/testing/src/vectors.ts` —
  `{ name, kind, description, input, expect }`, `kind` one of `VECTOR_KINDS`, and the loader's
  rule that each directory name equals its vector's `name`.
- Produces: 14 vectors of `kind: "serving-plane"` that Task 3's `runServingPlaneConformance` reads
  via `loadVectorsByKind("serving-plane")`.

- [ ] **Step 1: Add the vector kind and write one failing vector**

In `packages/discovery/testing/src/vectors.ts`, extend `VECTOR_KINDS`:

```ts
export const VECTOR_KINDS = [
  "source-chain",
  "item",
  "facts-consistency",
  "derivation-consistency",
  "query",
  "subscribe",
  "consumer",
  "serving-plane",
] as const;
```

Create `packages/discovery/testing/fixtures/vectors/serving-plane-head-conditional-get-304/vector.json`:

```json
{
  "name": "serving-plane-head-conditional-get-304",
  "kind": "serving-plane",
  "description": "Composition design §7.3: the Source Head is the only mutable serving-plane object, so it is the only one carrying an ETag; a conditional GET whose If-None-Match matches answers 304 with the ETag and no body.",
  "input": {
    "path": "/sources/feed/head",
    "ifNoneMatch": "\"sha256:0000000000000000000000000000000000000000000000000000000000000001\"",
    "storedEtag": "\"sha256:0000000000000000000000000000000000000000000000000000000000000001\""
  },
  "expect": { "status": 304, "hasBody": false, "cacheControl": "no-cache" }
}
```

- [ ] **Step 2: Run the corpus validator to verify it fails**

```bash
cd packages/discovery/testing && yarn vitest run src/vectors.test.ts
```
Expected: FAIL until `VECTOR_KINDS` carries `"serving-plane"` (revert the `vectors.ts` edit
momentarily to see it fail, then reapply — the failure message is
`Invalid enum value … 'serving-plane'`).

- [ ] **Step 3: Write the remaining thirteen vectors**

One directory each, same `kind: "serving-plane"` shape. Contents (name → description → input →
expect):

```
serving-plane-head-conditional-get-stale-200
  §7.3: a non-matching If-None-Match on the head answers 200 with the full body and the current ETag.
  input  { "path": "/sources/feed/head", "ifNoneMatch": "\"sha256:…dead\"", "storedEtag": "\"sha256:…0001\"" }
  expect { "status": 200, "hasBody": true, "cacheControl": "no-cache" }

serving-plane-digest-path-immutable
  §7.3: digest-addressed record paths are immutable and infinitely cacheable (design §7 item 1).
  input  { "path": "/records/0000000000000000000000000000000000000000000000000000000000000001" }
  expect { "status": 200, "cacheControl": "public, max-age=31536000, immutable", "acceptRanges": "bytes" }

serving-plane-sealed-archive-page-immutable
  §7.3 with this plan's Finding 5: a SEALED archive page (any page that is not the source's current one) is served immutable.
  input  { "path": "/sources/feed/entries/0000000000000000000000000001", "currentPage": "0000000000000000000000000002" }
  expect { "status": 200, "cacheControl": "public, max-age=31536000, immutable" }

serving-plane-current-archive-page-revalidated
  Finding 5: serve's writeArchivePages re-partitions from scratch, so the newest page's bytes change until it fills -- it is served no-cache with an ETag, never immutable.
  input  { "path": "/sources/feed/entries/0000000000000000000000000002", "currentPage": "0000000000000000000000000002" }
  expect { "status": 200, "cacheControl": "no-cache", "hasEtag": true }

serving-plane-blob-single-range
  §7.3: blobs declare Accept-Ranges: bytes and honor a single byte range with 206 + Content-Range.
  input  { "path": "/records/0000000000000000000000000000000000000000000000000000000000000001", "range": "bytes=2-5", "size": 10 }
  expect { "status": 206, "contentRange": "bytes 2-5/10", "acceptRanges": "bytes" }

serving-plane-blob-unsatisfiable-range
  RFC 9110 §14.4: an unsatisfiable single range answers 416 with Content-Range naming the full size.
  input  { "path": "/records/0000000000000000000000000000000000000000000000000000000000000001", "range": "bytes=99-120", "size": 10 }
  expect { "status": 416, "contentRange": "bytes */10" }

serving-plane-exposure-scoping-non-archive-path
  Composition design §6.2 / program §6 contract 7: only the archive subtree is public; any other path 404s even when a file exists behind it.
  input  { "path": "/v1/status" }
  expect { "status": 404, "contentType": "application/json", "errorCode": "invalid-reference" }

serving-plane-exposure-scoping-unlisted-source
  §6.2: a source name the handler was not configured to serve 404s -- exposure is an allowlist, not a directory listing.
  input  { "path": "/sources/not-configured/head", "sources": ["feed"] }
  expect { "status": 404, "contentType": "application/json", "errorCode": "invalid-reference" }

serving-plane-path-traversal-rejected
  §6.2: a traversal attempt, percent-encoded or literal, never escapes the serving root.
  input  { "path": "/records/..%2f..%2fetc%2fpasswd" }
  expect { "status": 404, "contentType": "application/json", "errorCode": "invalid-reference" }

serving-plane-sse-cursor-no-cursor
  §9.3 case 1 mapped onto SSE (§7.3): no cursor -> live tail from now, no replay frames before the first live event.
  input  { "cursor": null, "replayWindowSize": 10, "published": 4 }
  expect { "status": 200, "contentType": "text/event-stream", "replayedCount": 0, "terminal": null, "closed": false }

serving-plane-sse-cursor-within-window
  §9.3 case 3: a cursor inside the replay window -> replay from the position after it, then continue live.
  input  { "cursor": "relay-a:3", "replayWindowSize": 10, "published": 10, "cursorPosition": 3 }
  expect { "status": 200, "replayedCount": 6, "terminal": null, "closed": false }

serving-plane-sse-cursor-oldest
  §9.3 case 5: "oldest" -> start of window; the whole buffered window replays.
  input  { "cursor": "oldest", "replayWindowSize": 10, "published": 7 }
  expect { "status": 200, "replayedCount": 7, "terminal": null, "closed": false }

serving-plane-sse-cursor-unknown-terminal-event
  §9.3 case 2 mapped onto SSE (§7.3) with this plan's Findings 1/2/4: an unknown or future cursor answers a typed terminal event named `cursor-unknown` (discovery design §8's pinned detail code) and closes -- never guessing, never silently tailing.
  input  { "cursor": "relay-a:999999", "replayWindowSize": 10, "published": 10, "cursorPosition": null }
  expect { "status": 200, "replayedCount": 0, "terminal": { "event": "cursor-unknown", "code": "invalid-reference", "namesColdSyncPath": true }, "closed": true }

serving-plane-sse-cursor-too-old-terminal-event
  §9.3 case 4: a cursor older than the bounded window answers a typed terminal `cursor-too-old` event naming the cold-sync path (archive root + head), then closes -- never silent gap-skipping.
  input  { "cursor": "relay-a:1", "replayWindowSize": 10, "published": 14, "cursorPosition": -1 }
  expect { "status": 200, "replayedCount": 0, "terminal": { "event": "cursor-too-old", "code": "invalid-reference", "namesColdSyncPath": true }, "closed": true }
```

Plus the two advertisement vectors that close §9.3's "bounded and advertised" discipline:

```
serving-plane-sse-last-event-id-resume
  §7.3: SSE's Last-Event-ID carries the relay cursor across a reconnect -- a resumed stream replays exactly the events after the id the client last saw.
  input  { "lastEventId": "relay-a:5", "replayWindowSize": 10, "published": 10, "cursorPosition": 5 }
  expect { "status": 200, "replayedCount": 4, "terminal": null, "closed": false }

serving-plane-sse-replay-window-advertised
  §9.3 + §7.3: each source advertises its bounded replay window and declares its cursors relay-local in the well-known discovery document.
  input  { "sourceName": "feed", "replayWindowSize": 500, "relayId": "relay-a" }
  expect { "advertised": true, "windowSize": 500, "cursorScope": "relay-local" }
```

That is 16 directories total; the fourteen §7.3 wire cases plus the two advertisement cases.
Each directory name equals its vector's `name`. `published` is how many events the relay has
issued (cursors are zero-based ordinals, `relay-a:0` first), `replayWindowSize` is the bounded
window — so a vector with `published: 14, replayWindowSize: 10` has evicted ordinals 0–3, which
is what makes `relay-a:1` a `cursor-too-old` case.

- [ ] **Step 4: Run the corpus validator to verify it passes**

```bash
cd packages/discovery/testing && yarn typecheck && yarn vitest run src/vectors.test.ts
```
Expected: PASS, corpus count up by 16.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/testing
git commit -m "test(discovery): add the serving-plane wire-profile golden vectors"
```

---

## Task 3: `runServingPlaneConformance` in the shared kit

**Files:**
- Modify: `packages/discovery/testing/src/conformance.ts`
- Test: `packages/discovery/testing/src/protocol-conformance.test.ts` (existing; add a
  self-check)

**Interfaces:**
- Consumes: `loadVectorsByKind("serving-plane")` from Task 2.
- Produces:

```ts
export interface ServingPlaneRouteResult {
  status: number;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
  acceptRanges?: string;
  contentRange?: string;
  /** TEP error taxonomy code on a typed JSON error body (§8: discovery adds no parallel taxonomy). */
  errorCode?: string;
  hasBody: boolean;
}

export interface ServingPlaneSseResult {
  status: number;
  contentType: string;
  replayedCount: number;
  terminal?: { event: string; code: string; namesColdSyncPath: boolean };
  closed: boolean;
}

export interface ServingPlaneUnderTest {
  route(input: unknown): Promise<ServingPlaneRouteResult>;
  subscribe(input: unknown): Promise<ServingPlaneSseResult>;
  advertise(input: unknown): Promise<{ advertised: boolean; windowSize: number; cursorScope: string }>;
}

export function runServingPlaneConformance(surface: ServingPlaneUnderTest): void;
```

`ServingPlaneUnderTest` is declared locally in the kit — exactly like the existing
`ServeUnderTest`, `SubscribeClientUnderTest`, and `ClientUnderTest` — so `testing` still
imports nothing but `record-discovery-protocol` and its boundary list is untouched.

- [ ] **Step 1: Write the failing self-check**

Append to `packages/discovery/testing/src/protocol-conformance.test.ts`:

```ts
import { expect, it } from "vitest";
import {
  runServingPlaneConformance,
  type ServingPlaneAdvertisement,
  type ServingPlaneRouteResult,
  type ServingPlaneSseResult,
  type ServingPlaneUnderTest,
} from "./conformance.js";
import { loadVectorsByKind } from "./vectors.js";

// A self-check, not a real implementation: this echo answers each vector from
// the vector's own `expect` block. It proves the two things the kit cannot
// prove about itself otherwise -- that the suite drives EVERY serving-plane
// vector, and that the assertions it makes are exactly the ones the vectors
// declare. The real assertions run against the concrete handler in
// transport-http (that package's Task 14).

/** Returns the declared `expect` of the vector whose `input` is this exact object. */
function declaredExpectation(input: unknown): Record<string, unknown> {
  const vector = loadVectorsByKind("serving-plane")
    .find((candidate) => JSON.stringify(candidate.input) === JSON.stringify(input));
  if (vector === undefined) throw new Error("no serving-plane vector matches this input");
  const expected = { ...(vector.expect as Record<string, unknown>) };
  // Normalizations the echo owes the suite: `hasEtag: true` is asserted through
  // the `etag` field, `terminal: null` means "no terminal event", and every SSE
  // vector's content type is fixed by the profile rather than restated per
  // fixture.
  if (expected["hasEtag"] === true) expected["etag"] = '"sha256:echo"';
  if (expected["terminal"] === null) delete expected["terminal"];
  if ("replayedCount" in expected) expected["contentType"] = "text/event-stream";
  return expected;
}

const echo: ServingPlaneUnderTest = {
  route: async (input) => declaredExpectation(input) as unknown as ServingPlaneRouteResult,
  subscribe: async (input) => declaredExpectation(input) as unknown as ServingPlaneSseResult,
  advertise: async (input) => declaredExpectation(input) as unknown as ServingPlaneAdvertisement,
};

it("the serving-plane corpus is complete and every vector declares an outcome the suite reads", () => {
  const vectors = loadVectorsByKind("serving-plane");
  expect(vectors.length).toBeGreaterThanOrEqual(16);
  for (const vector of vectors) {
    const expected = vector.expect as Record<string, unknown>;
    expect("status" in expected || "advertised" in expected, vector.name).toBe(true);
  }
});

runServingPlaneConformance(echo);
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/discovery/testing && yarn vitest run src/protocol-conformance.test.ts
```
Expected: FAIL — `runServingPlaneConformance is not exported`.

- [ ] **Step 3: Implement the suite**

Append to `packages/discovery/testing/src/conformance.ts`:

```ts
// ---------------------------------------------------------------------------
// Transport plane (discovery §7/§9.3/§9.4 closed by the composition design's
// §7.3 wire profile: RFC 9110/9111 conditional GET and cache-control, declared
// byte ranges, SSE with Last-Event-ID). The under-test surface is declared
// locally, like every other *UnderTest in this file, so the kit keeps its
// single-dependency boundary.
// ---------------------------------------------------------------------------

export interface ServingPlaneRouteResult {
  status: number;
  contentType?: string;
  cacheControl?: string;
  etag?: string;
  acceptRanges?: string;
  contentRange?: string;
  /** TEP error taxonomy code on a typed JSON error body (§8: discovery adds no parallel taxonomy). */
  errorCode?: string;
  hasBody: boolean;
}

export interface ServingPlaneSseResult {
  status: number;
  contentType: string;
  replayedCount: number;
  terminal?: { event: string; code: string; namesColdSyncPath: boolean };
  closed: boolean;
}

export interface ServingPlaneAdvertisement {
  advertised: boolean;
  windowSize: number;
  cursorScope: string;
}

export interface ServingPlaneUnderTest {
  route(input: unknown): Promise<ServingPlaneRouteResult>;
  subscribe(input: unknown): Promise<ServingPlaneSseResult>;
  advertise(input: unknown): Promise<ServingPlaneAdvertisement>;
}

function isSseVector(expected: Record<string, unknown>): boolean {
  return "replayedCount" in expected;
}

function isAdvertisementVector(expected: Record<string, unknown>): boolean {
  return "advertised" in expected;
}

export function runServingPlaneConformance(surface: ServingPlaneUnderTest): void {
  describe("serving-plane conformance (§7/§9.3/§9.4 wire profile, §18 serving-plane vectors)", () => {
    for (const vector of loadVectorsByKind("serving-plane")) {
      const expected = vector.expect as Record<string, unknown>;

      if (isAdvertisementVector(expected)) {
        it(vector.name, async () => {
          const result = await surface.advertise(vector.input);
          expect(result.advertised).toBe(expected["advertised"]);
          expect(result.windowSize).toBe(expected["windowSize"]);
          expect(result.cursorScope).toBe(expected["cursorScope"]);
        });
        continue;
      }

      if (isSseVector(expected)) {
        it(vector.name, async () => {
          const result = await surface.subscribe(vector.input);
          expect(result.status).toBe(expected["status"]);
          expect(result.contentType).toBe("text/event-stream");
          expect(result.replayedCount).toBe(expected["replayedCount"]);
          expect(result.closed).toBe(expected["closed"]);
          const terminal = expected["terminal"] as ServingPlaneSseResult["terminal"] | null;
          if (terminal === null) {
            expect(result.terminal).toBeUndefined();
          } else {
            // §9.3: the terminal event is TYPED and NAMES the cold-sync path;
            // a bare close would be silent gap-skipping.
            expect(result.terminal?.event).toBe(terminal!.event);
            expect(result.terminal?.code).toBe(terminal!.code);
            expect(result.terminal?.namesColdSyncPath).toBe(true);
          }
        });
        continue;
      }

      it(vector.name, async () => {
        const result = await surface.route(vector.input);
        expect(result.status).toBe(expected["status"]);
        for (const field of ["contentType", "cacheControl", "acceptRanges", "contentRange", "errorCode"] as const) {
          if (expected[field] !== undefined) expect(result[field]).toBe(expected[field]);
        }
        if (expected["hasBody"] !== undefined) expect(result.hasBody).toBe(expected["hasBody"]);
        if (expected["hasEtag"] === true) expect(result.etag).toBeDefined();
      });
    }
  });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/discovery/testing && yarn typecheck && yarn test && yarn build && yarn pack:smoke
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/testing
git commit -m "test(discovery): export runServingPlaneConformance from the discovery kit"
```

---

## Task 4: `createFsBlobStore` and `createLayoutReader`

**Files:**
- Create: `packages/discovery/transport-http/src/fs-blob-store.ts`, `src/fs-blob-store.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `BlobStat`, `ByteRange`, `FsBlobStore`, `LayoutReader` from `./ports.js` (Task 1);
  `recordDigest(bytes): \`sha256:${string}\`` from `@jinn-network/record-discovery-protocol`.
- Produces:

```ts
export function resolveWithin(rootDir: string, servingPath: string): string | undefined;
export function createFsBlobStore(rootDir: string): FsBlobStore;
export function createLayoutReader(rootDir: string): LayoutReader;
```

- [ ] **Step 1: Write the failing test**

`src/fs-blob-store.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsBlobStore, createLayoutReader, resolveWithin } from "./fs-blob-store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "jinn-transport-http-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("resolveWithin", () => {
  it("rejects traversal, relative, and NUL-bearing serving paths", () => {
    expect(resolveWithin("/srv", "/records/../../etc/passwd")).toBeUndefined();
    expect(resolveWithin("/srv", "records/abc")).toBeUndefined();
    expect(resolveWithin("/srv", "/records/a\0b")).toBeUndefined();
    expect(resolveWithin("/srv", "/records/abc")).toBe("/srv/records/abc");
  });
});

describe("createFsBlobStore + createLayoutReader", () => {
  it("round-trips bytes, content type, size, and a strong digest ETag", async () => {
    const store = createFsBlobStore(root);
    const reader = createLayoutReader(root);
    await store.put("/sources/feed/head", bytes("head-v1"), "application/json");

    const stat = await reader.stat("/sources/feed/head");
    expect(stat?.size).toBe(7);
    expect(stat?.contentType).toBe("application/json");
    expect(stat?.etag).toMatch(/^"sha256:[a-f0-9]{64}"$/u);

    const read = await reader.read("/sources/feed/head");
    expect(new TextDecoder().decode(read!.bytes)).toBe("head-v1");
  });

  it("serves an inclusive byte range without reading past it", async () => {
    const store = createFsBlobStore(root);
    const reader = createLayoutReader(root);
    await store.put("/records/abc", bytes("0123456789"), "application/octet-stream");

    const read = await reader.read("/records/abc", { start: 2, endInclusive: 5 });
    expect(new TextDecoder().decode(read!.bytes)).toBe("2345");
    expect(read!.stat.size).toBe(10);
  });

  it("re-put replaces the bytes and the ETag", async () => {
    const store = createFsBlobStore(root);
    const reader = createLayoutReader(root);
    await store.put("/sources/feed/head", bytes("head-v1"), "application/json");
    const first = await reader.stat("/sources/feed/head");
    await store.put("/sources/feed/head", bytes("head-v2"), "application/json");
    const second = await reader.stat("/sources/feed/head");
    expect(second?.etag).not.toBe(first?.etag);
  });

  it("reports undefined for an unknown path and refuses to write outside the root", async () => {
    const reader = createLayoutReader(root);
    expect(await reader.stat("/records/missing")).toBeUndefined();
    expect(await reader.read("/records/missing")).toBeUndefined();
    await expect(createFsBlobStore(root).put("/records/../escape", bytes("x"), "application/json"))
      .rejects.toThrow(/escapes the serving root/u);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/fs-blob-store.test.ts
```
Expected: FAIL — `Failed to resolve import "./fs-blob-store.js"`.

- [ ] **Step 3: Implement**

`src/fs-blob-store.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { recordDigest } from "@jinn-network/record-discovery-protocol";

import type { BlobStat, ByteRange, FsBlobStore, LayoutReader } from "./ports.js";

// Serving-plane objects are bounded by protocol's CEILINGS (4 MiB per archive
// page, 1 MiB per entry), so reads load the whole object and slice in memory
// rather than opening a positional file handle -- simpler, and the ceiling is
// what makes it safe.

const METADATA_ROOT = ".meta";

/**
 * Resolves a serving-plane path (always absolute, always `/`-rooted, as
 * `protocol`'s path helpers produce) to an absolute filesystem path under
 * `rootDir`. Returns `undefined` for anything that is not a serving-plane path
 * or that escapes the root -- traversal, relative, or NUL-bearing.
 */
export function resolveWithin(rootDir: string, servingPath: string): string | undefined {
  if (servingPath.includes("\0")) return undefined;
  if (!servingPath.startsWith("/")) return undefined;
  const root = resolve(rootDir);
  const candidate = resolve(root, `.${servingPath}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  return candidate;
}

function metadataPathFor(root: string, dataPath: string): string {
  return join(root, METADATA_ROOT, `${relative(root, dataPath)}.json`);
}

async function writeAtomically(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

/**
 * The write side: a filesystem implementation of `serve`'s put-only
 * `BlobStore`. Writes are atomic (temp file + rename) so a consumer never
 * observes a half-written head, and each object carries a metadata sidecar
 * under `<root>/.meta/` holding its content type, size, and strong ETag. The
 * sidecar lives outside the served layout, so `<root>` stays a byte-exact,
 * mirror-copyable static tree.
 */
export function createFsBlobStore(rootDir: string): FsBlobStore {
  const root = resolve(rootDir);
  return {
    rootDir: root,
    async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
      const target = resolveWithin(root, path);
      if (target === undefined) throw new Error(`createFsBlobStore: path escapes the serving root: ${path}`);
      const stat: BlobStat = { size: bytes.length, contentType, etag: `"${recordDigest(bytes)}"` };
      await writeAtomically(target, bytes);
      await writeAtomically(metadataPathFor(root, target), new TextEncoder().encode(JSON.stringify(stat)));
    },
  };
}

/** The read side the archive handler serves from. */
export function createLayoutReader(rootDir: string): LayoutReader {
  const root = resolve(rootDir);

  async function statAt(path: string): Promise<BlobStat | undefined> {
    const target = resolveWithin(root, path);
    if (target === undefined) return undefined;
    try {
      return JSON.parse(await readFile(metadataPathFor(root, target), "utf8")) as BlobStat;
    } catch {
      return undefined;
    }
  }

  return {
    stat: statAt,
    async read(path: string, range?: ByteRange) {
      const stat = await statAt(path);
      const target = resolveWithin(root, path);
      if (stat === undefined || target === undefined) return undefined;
      let contents: Buffer;
      try {
        contents = await readFile(target);
      } catch {
        return undefined;
      }
      const view = new Uint8Array(contents);
      if (range === undefined) return { bytes: view, stat };
      return { bytes: view.slice(range.start, range.endInclusive + 1), stat };
    },
  };
}
```

Add `export * from "./fs-blob-store.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/fs-blob-store.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add the filesystem blob store and layout reader"
```

---

## Task 5: The §7.3 wire-profile header primitives

**Files:**
- Create: `packages/discovery/transport-http/src/http-headers.ts`, `src/http-headers.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `ByteRange` from `./ports.js`; `recordDigest` from `record-discovery-protocol`.
- Produces:

```ts
export type PathClass = "well-known" | "head" | "archive-page-current" | "archive-page-sealed" | "record";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL = "no-cache";
export function cacheControlFor(pathClass: PathClass): string;
export function etagFor(bytes: Uint8Array): string;
export function isNotModified(ifNoneMatch: string | null, etag: string): boolean;
export type RangeOutcome = { kind: "none" } | { kind: "single"; range: ByteRange } | { kind: "unsatisfiable" };
export function parseRangeHeader(header: string | null, size: number): RangeOutcome;
export function contentRangeFor(range: ByteRange, size: number): string;
export function unsatisfiableContentRange(size: number): string;
```

- [ ] **Step 1: Write the failing test**

`src/http-headers.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  cacheControlFor,
  contentRangeFor,
  etagFor,
  isNotModified,
  parseRangeHeader,
  unsatisfiableContentRange,
} from "./http-headers.js";

describe("cacheControlFor", () => {
  it("marks digest paths and sealed archive pages immutable, mutable objects revalidated", () => {
    expect(cacheControlFor("record")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor("archive-page-sealed")).toBe(IMMUTABLE_CACHE_CONTROL);
    // Finding 5: serve re-partitions the newest page on every write, so it is
    // NOT immutable until it seals.
    expect(cacheControlFor("archive-page-current")).toBe(REVALIDATE_CACHE_CONTROL);
    expect(cacheControlFor("head")).toBe(REVALIDATE_CACHE_CONTROL);
    expect(cacheControlFor("well-known")).toBe(REVALIDATE_CACHE_CONTROL);
  });
});

describe("etagFor / isNotModified", () => {
  it("derives a quoted strong ETag from the exact bytes", () => {
    const etag = etagFor(new TextEncoder().encode("head-v1"));
    expect(etag).toMatch(/^"sha256:[a-f0-9]{64}"$/u);
    expect(etagFor(new TextEncoder().encode("head-v2"))).not.toBe(etag);
  });

  it("matches a wildcard, an exact tag, a weak tag, and a list member", () => {
    const etag = '"sha256:aa"';
    expect(isNotModified(null, etag)).toBe(false);
    expect(isNotModified("*", etag)).toBe(true);
    expect(isNotModified('"sha256:aa"', etag)).toBe(true);
    expect(isNotModified('W/"sha256:aa"', etag)).toBe(true);
    expect(isNotModified('"sha256:bb", "sha256:aa"', etag)).toBe(true);
    expect(isNotModified('"sha256:bb"', etag)).toBe(false);
  });
});

describe("parseRangeHeader", () => {
  it("parses closed, open-ended, and suffix ranges against the object size", () => {
    expect(parseRangeHeader("bytes=2-5", 10)).toEqual({ kind: "single", range: { start: 2, endInclusive: 5 } });
    expect(parseRangeHeader("bytes=7-", 10)).toEqual({ kind: "single", range: { start: 7, endInclusive: 9 } });
    expect(parseRangeHeader("bytes=-3", 10)).toEqual({ kind: "single", range: { start: 7, endInclusive: 9 } });
    expect(parseRangeHeader("bytes=2-99", 10)).toEqual({ kind: "single", range: { start: 2, endInclusive: 9 } });
  });

  it("reports unsatisfiable ranges and ignores forms it does not support", () => {
    expect(parseRangeHeader("bytes=99-120", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=5-2", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
    // Multi-range and non-byte units are ignored, not errors: RFC 9110 lets a
    // server answer the full representation with 200.
    expect(parseRangeHeader("bytes=0-1,4-5", 10)).toEqual({ kind: "none" });
    expect(parseRangeHeader("items=0-1", 10)).toEqual({ kind: "none" });
    expect(parseRangeHeader(null, 10)).toEqual({ kind: "none" });
  });
});

describe("content range formatting", () => {
  it("formats satisfied and unsatisfiable ranges", () => {
    expect(contentRangeFor({ start: 2, endInclusive: 5 }, 10)).toBe("bytes 2-5/10");
    expect(unsatisfiableContentRange(10)).toBe("bytes */10");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/http-headers.test.ts
```
Expected: FAIL — `Failed to resolve import "./http-headers.js"`.

- [ ] **Step 3: Implement**

`src/http-headers.ts`:

```ts
import { recordDigest } from "@jinn-network/record-discovery-protocol";

import type { ByteRange } from "./ports.js";

// The §7.3 wire profile, composed from RFC 9110 (conditional requests, range
// requests) and RFC 9111 (cache-control): ETag/If-None-Match on the head (the
// one mutable serving-plane object, design §7 item 3); `immutable` on
// digest-addressed paths and sealed archive pages; declared byte ranges on
// blobs.

export type PathClass =
  | "well-known"
  | "head"
  | "archive-page-current"
  | "archive-page-sealed"
  | "record";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL = "no-cache";

export function cacheControlFor(pathClass: PathClass): string {
  switch (pathClass) {
    case "record":
    case "archive-page-sealed":
      return IMMUTABLE_CACHE_CONTROL;
    case "well-known":
    case "head":
    case "archive-page-current":
      return REVALIDATE_CACHE_CONTROL;
  }
}

/** A quoted strong entity tag over the exact stored bytes -- the same digest the layout addresses records by. */
export function etagFor(bytes: Uint8Array): string {
  return `"${recordDigest(bytes)}"`;
}

export function isNotModified(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const header = ifNoneMatch.trim();
  if (header === "*") return true;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return (value.startsWith("W/") ? value.slice(2) : value) === etag;
  });
}

export type RangeOutcome =
  | { kind: "none" }
  | { kind: "single"; range: ByteRange }
  | { kind: "unsatisfiable" };

/**
 * Parses a single-range `Range` header. Multi-range requests and non-`bytes`
 * units yield `none`: RFC 9110 permits answering with the full representation,
 * and the serving plane's objects are ceiling-bounded, so partial assembly buys
 * nothing.
 */
export function parseRangeHeader(header: string | null, size: number): RangeOutcome {
  if (header === null) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return { kind: "none" };
  const rawStart = match[1]!;
  const rawEnd = match[2]!;
  if (rawStart === "" && rawEnd === "") return { kind: "none" };
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "single", range: { start: Math.max(0, size - suffix), endInclusive: size - 1 } };
  }
  const start = Number(rawStart);
  if (start >= size) return { kind: "unsatisfiable" };
  const endInclusive = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (endInclusive < start) return { kind: "unsatisfiable" };
  return { kind: "single", range: { start, endInclusive } };
}

export function contentRangeFor(range: ByteRange, size: number): string {
  return `bytes ${String(range.start)}-${String(range.endInclusive)}/${String(size)}`;
}

export function unsatisfiableContentRange(size: number): string {
  return `bytes */${String(size)}`;
}
```

Add `export * from "./http-headers.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/http-headers.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add the RFC 9110/9111 wire-profile header primitives"
```

---

## Task 6: The bounded replay relay

**Files:**
- Create: `packages/discovery/transport-http/src/relay.ts`, `src/relay.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `AnnouncementEvent` from `@jinn-network/record-discovery-protocol`.
- Produces:

```ts
export interface RelayEvent { cursor: string; event: AnnouncementEvent; }
export interface ReplayWindowAdvertisement { relayId: string; windowSize: number; cursorScope: "relay-local"; }
export interface BoundedReplayRelay {
  readonly relayId: string;
  readonly windowSize: number;
  advertisement(): ReplayWindowAdvertisement;
  publish(event: AnnouncementEvent): string;
  positionOf(cursor: string): number | undefined;
  replayFrom(cursor: string | undefined): RelayEvent[];
  buffered(): RelayEvent[];
  subscribe(listener: (relayEvent: RelayEvent) => void): () => void;
}
export function createBoundedReplayRelay(options: { relayId: string; windowSize: number }): BoundedReplayRelay;
```

Cursor grammar is `<relayId>:<ordinal>`, ordinals zero-based and monotonic. `positionOf`
returns the offset into the buffered window, `-1` for an evicted cursor (`cursor-too-old`), and
`undefined` for a cursor this relay never issued or has not issued yet (`cursor-unknown`) —
matching `client`'s `classifyCursor(cursor, replayWindowSize, cursorPosition)` contract exactly.

- [ ] **Step 1: Write the failing test**

`src/relay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AnnouncementEvent } from "@jinn-network/record-discovery-protocol";
import { classifyCursor } from "@jinn-network/record-discovery-client";

import { createBoundedReplayRelay } from "./relay.js";

function event(id: string): AnnouncementEvent {
  return {
    specversion: "1.0", id, source: "did:key:zAgentSourceOne/feed",
    type: "network.jinn.record-discovery.announcement",
    subject: `sha256:${id.padStart(64, "0")}`,
    recordkind: "https://jinn.network/records/submission/1.0",
    sourceagent: "did:key:zAgentSourceOne", sourcename: "feed",
    entrydigest: `sha256:${id.padStart(64, "1")}`, announcementid: id,
    data: {} as AnnouncementEvent["data"],
  };
}

describe("createBoundedReplayRelay", () => {
  it("issues zero-based relay-local cursors and advertises its bounded window", () => {
    const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize: 10 });
    expect(relay.publish(event("1"))).toBe("relay-a:0");
    expect(relay.publish(event("2"))).toBe("relay-a:1");
    expect(relay.advertisement()).toEqual({ relayId: "relay-a", windowSize: 10, cursorScope: "relay-local" });
  });

  it("replays from the position AFTER the supplied cursor, and the whole window for `oldest`", () => {
    const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize: 10 });
    for (let index = 0; index < 10; index += 1) relay.publish(event(String(index)));
    expect(relay.replayFrom("relay-a:3")).toHaveLength(6);
    expect(relay.replayFrom("oldest")).toHaveLength(10);
    expect(relay.replayFrom(undefined)).toHaveLength(0);
  });

  it("evicts past the window and classifies the three cursor positions the way `client` expects", () => {
    const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize: 10 });
    for (let index = 0; index < 14; index += 1) relay.publish(event(String(index)));
    expect(relay.buffered()).toHaveLength(10);

    expect(relay.positionOf("relay-a:1")).toBe(-1);            // evicted
    expect(relay.positionOf("relay-a:999999")).toBeUndefined(); // never issued
    expect(relay.positionOf("relay-b:5")).toBeUndefined();      // another relay's numbering
    expect(relay.positionOf("relay-a:5")).toBe(1);              // buffered ordinals are 4..13

    expect(classifyCursor("relay-a:1", 10, relay.positionOf("relay-a:1"))).toEqual({
      behavior: "cursor-too-old", detailCode: "cursor-too-old",
    });
    expect(classifyCursor("relay-a:999999", 10, relay.positionOf("relay-a:999999"))).toEqual({
      behavior: "typed-error-close",
    });
    expect(classifyCursor("relay-a:5", 10, relay.positionOf("relay-a:5"))).toEqual({
      behavior: "replay-then-live",
    });
  });

  it("fans live events out to subscribers until they unsubscribe", () => {
    const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize: 3 });
    const seen: string[] = [];
    const stop = relay.subscribe((relayEvent) => seen.push(relayEvent.cursor));
    relay.publish(event("1"));
    stop();
    relay.publish(event("2"));
    expect(seen).toEqual(["relay-a:0"]);
  });
});
```

Note the `classifyCursor` import is a runtime import from `record-discovery-client` in a
**test** file — the type-only guard from Task 1 scans production source only, and this test is
exactly the cross-check that keeps the relay's position semantics welded to the frozen
classifier.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/relay.test.ts
```
Expected: FAIL — `Failed to resolve import "./relay.js"`.

- [ ] **Step 3: Implement**

`src/relay.ts`:

```ts
import type { AnnouncementEvent } from "@jinn-network/record-discovery-protocol";

// The subscribe plane's relay side (design §9.3): relays are non-archival by
// design, so the replay window is bounded and advertised, and its cursors are
// relay-local and declared as such -- data-level ordering always comes from
// source-chain sequence, never from this numbering. Cold history lives in
// archive pages, which is exactly what the `cursor-too-old` terminal event
// points a consumer back to.

export interface RelayEvent {
  cursor: string;
  event: AnnouncementEvent;
}

export interface ReplayWindowAdvertisement {
  relayId: string;
  windowSize: number;
  cursorScope: "relay-local";
}

export interface BoundedReplayRelay {
  readonly relayId: string;
  readonly windowSize: number;
  advertisement(): ReplayWindowAdvertisement;
  /** Buffers `event`, evicting past the window, and returns its relay-local cursor. */
  publish(event: AnnouncementEvent): string;
  /** Offset into the buffered window; `-1` when evicted; `undefined` when never issued or not yet issued. */
  positionOf(cursor: string): number | undefined;
  /** Events strictly after `cursor`; the whole window for `"oldest"`; none for `undefined` (live tail). */
  replayFrom(cursor: string | undefined): RelayEvent[];
  buffered(): RelayEvent[];
  subscribe(listener: (relayEvent: RelayEvent) => void): () => void;
}

function parseOrdinal(relayId: string, cursor: string): number | undefined {
  const prefix = `${relayId}:`;
  if (!cursor.startsWith(prefix)) return undefined;
  const raw = cursor.slice(prefix.length);
  if (!/^[0-9]+$/u.test(raw)) return undefined;
  return Number(raw);
}

export function createBoundedReplayRelay(options: { relayId: string; windowSize: number }): BoundedReplayRelay {
  const { relayId, windowSize } = options;
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("createBoundedReplayRelay: windowSize must be a positive integer");
  }

  const buffer: RelayEvent[] = [];
  const listeners = new Set<(relayEvent: RelayEvent) => void>();
  let issued = 0;

  return {
    relayId,
    windowSize,
    advertisement: () => ({ relayId, windowSize, cursorScope: "relay-local" }),

    publish(event: AnnouncementEvent): string {
      const relayEvent: RelayEvent = { cursor: `${relayId}:${String(issued)}`, event };
      issued += 1;
      buffer.push(relayEvent);
      while (buffer.length > windowSize) buffer.shift();
      for (const listener of listeners) listener(relayEvent);
      return relayEvent.cursor;
    },

    positionOf(cursor: string): number | undefined {
      const ordinal = parseOrdinal(relayId, cursor);
      // Unknown-or-future is never guessed (§9.3 case 2): a cursor from another
      // relay's numbering, a malformed one, or one past what this relay has
      // issued all report `undefined`.
      if (ordinal === undefined || ordinal < 0 || ordinal >= issued) return undefined;
      const index = buffer.findIndex((entry) => entry.cursor === cursor);
      return index === -1 ? -1 : index;
    },

    replayFrom(cursor: string | undefined): RelayEvent[] {
      if (cursor === undefined) return [];
      if (cursor === "oldest") return [...buffer];
      const index = buffer.findIndex((entry) => entry.cursor === cursor);
      return index === -1 ? [] : buffer.slice(index + 1);
    },

    buffered: () => [...buffer],

    subscribe(listener: (relayEvent: RelayEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

Add `export * from "./relay.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/relay.test.ts
cd ../../.. && node --test .github/scripts/record-discovery-source-boundaries.test.mjs
```
Expected: PASS, 4 tests; the boundary guard stays green (the `client` import lives in a test).

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add the bounded relay-local replay window"
```

---

## Task 7: Server-side SSE framing and terminal events

**Files:**
- Create: `packages/discovery/transport-http/src/sse.ts`, `src/sse.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `RelayEvent` from `./relay.js`.
- Produces:

```ts
export const SSE_MEDIA_TYPE = "text/event-stream";
export const ANNOUNCEMENT_SSE_EVENT = "announcement";
export type CursorDetailCode = "cursor-unknown" | "cursor-too-old";
export interface ColdSyncPath { archiveRoot: string; headPath: string; }
export interface SseFields { id?: string; event?: string; data: string; retry?: number; }
export function formatSseEvent(fields: SseFields): string;
export function formatAnnouncementEvent(relayEvent: RelayEvent): string;
export function formatTerminalEvent(detailCode: CursorDetailCode, coldSync: ColdSyncPath): string;
```

- [ ] **Step 1: Write the failing test**

`src/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatAnnouncementEvent, formatSseEvent, formatTerminalEvent } from "./sse.js";

describe("formatSseEvent", () => {
  it("emits id, event, retry, and one data line per payload line, terminated by a blank line", () => {
    expect(formatSseEvent({ id: "relay-a:0", event: "announcement", data: '{"a":1}' }))
      .toBe('id: relay-a:0\nevent: announcement\ndata: {"a":1}\n\n');
    expect(formatSseEvent({ data: "one\ntwo", retry: 3000 }))
      .toBe("retry: 3000\ndata: one\ndata: two\n\n");
  });
});

describe("formatAnnouncementEvent", () => {
  it("carries the relay-local cursor in the SSE id field so Last-Event-ID resumes it", () => {
    const frame = formatAnnouncementEvent({
      cursor: "relay-a:7",
      event: { specversion: "1.0", id: "ann-7" } as never,
    });
    expect(frame.startsWith("id: relay-a:7\nevent: announcement\n")).toBe(true);
    expect(frame).toContain('"id":"ann-7"');
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

describe("formatTerminalEvent", () => {
  const coldSync = { archiveRoot: "https://host/sources/feed/entries/0000000000000002", headPath: "https://host/sources/feed/head" };

  it("names the cursor detail code as the event type and the cold-sync path in the payload", () => {
    const frame = formatTerminalEvent("cursor-too-old", coldSync);
    expect(frame).toContain("event: cursor-too-old");
    const data = JSON.parse(frame.split("data: ")[1]!.trim()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid-reference");
    expect(data["detailCode"]).toBe("cursor-too-old");
    expect(data["coldSync"]).toEqual(coldSync);
  });

  it("uses the discovery design's pinned `cursor-unknown` spelling, not `unknown-cursor`", () => {
    expect(formatTerminalEvent("cursor-unknown", coldSync)).toContain("event: cursor-unknown");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/sse.test.ts
```
Expected: FAIL — `Failed to resolve import "./sse.js"`.

- [ ] **Step 3: Implement**

`src/sse.ts`:

```ts
import type { RelayEvent } from "./relay.js";

// Server-Sent Events framing (WHATWG HTML §9.2). The composition design §7.3
// fixes SSE as the normative pull-tail profile the discovery design §9.4 left
// open: auto-reconnect and cursor resumption are in the format itself
// (`Last-Event-ID`), it is plain HTTP, and our filters are set at subscribe
// time so nothing needs a client-to-server channel mid-stream.

export const SSE_MEDIA_TYPE = "text/event-stream";
export const ANNOUNCEMENT_SSE_EVENT = "announcement";

/**
 * The two typed terminal conditions of the §9.3 cursor contract. The spelling
 * is the discovery design §8's pinned detail-code vocabulary
 * (`cursor-unknown`, `cursor-too-old`), which is authoritative over the
 * composition design §7.3's transposed `unknown-cursor`.
 */
export type CursorDetailCode = "cursor-unknown" | "cursor-too-old";

/** Where a consumer goes when the stream cannot serve it: archive pages and the head (§9.3). */
export interface ColdSyncPath {
  archiveRoot: string;
  headPath: string;
}

export interface SseFields {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

export function formatSseEvent(fields: SseFields): string {
  const lines: string[] = [];
  if (fields.id !== undefined) lines.push(`id: ${fields.id}`);
  if (fields.event !== undefined) lines.push(`event: ${fields.event}`);
  if (fields.retry !== undefined) lines.push(`retry: ${String(fields.retry)}`);
  for (const line of fields.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** One announcement frame; the relay-local cursor rides the `id` field so a reconnect's `Last-Event-ID` resumes exactly after it. */
export function formatAnnouncementEvent(relayEvent: RelayEvent): string {
  return formatSseEvent({
    id: relayEvent.cursor,
    event: ANNOUNCEMENT_SSE_EVENT,
    data: JSON.stringify(relayEvent.event),
  });
}

/**
 * A typed terminal event: the stream says why it cannot serve the requested
 * cursor and names the cold-sync path, then the caller closes. §9.3 forbids
 * both guessing and silent gap-skipping, so a bare close is not conformant.
 * The payload's `code` reuses the TEP error taxonomy (`invalid-reference`) --
 * discovery adds no parallel operational taxonomy (design §8).
 */
export function formatTerminalEvent(detailCode: CursorDetailCode, coldSync: ColdSyncPath): string {
  return formatSseEvent({
    event: detailCode,
    data: JSON.stringify({ code: "invalid-reference", detailCode, coldSync }),
  });
}
```

Add `export * from "./sse.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/sse.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add SSE framing and the typed cursor terminal events"
```

---

## Task 8: The archive HTTP handler — static routes and exposure scoping

**Files:**
- Create: `packages/discovery/transport-http/src/archive-handler.ts`, `src/archive-handler.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `createLayoutReader` (Task 4); `cacheControlFor`, `etagFor`, `isNotModified`,
  `parseRangeHeader`, `contentRangeFor`, `unsatisfiableContentRange`,
  `REVALIDATE_CACHE_CONTROL`, `PathClass` (Task 5); `BoundedReplayRelay` (Task 6);
  `WELL_KNOWN_PATH`, `headPath`, `archivePagePath`, `recordPath`, `SOURCE_NAME_GRAMMAR`,
  `SEQUENCE_WIDTH` from `@jinn-network/record-discovery-protocol`.
- Produces:

```ts
export interface ArchiveHttpHandlerOptions {
  /** Filesystem root of the serving-plane static layout (serve's BlobStore is put-only; the handler reads the tree). */
  rootDir: string;
  /** Source names this handler serves. Anything else 404s -- exposure is an allowlist, never a directory listing. */
  sources: readonly string[];
  /** Per-source relay backing the SSE tail. A source with no relay 404s on its subscribe route. */
  relays?: Readonly<Record<string, BoundedReplayRelay>>;
  /** The newest, still-growing archive page per source. Omitted ⇒ every page is served revalidated (safe default). */
  currentPage?: (sourceName: string) => Promise<string | undefined>;
  /** Absolute base URL this archive is reachable at; used to name the cold-sync path in terminal SSE events. */
  publicBaseUrl: string;
  /** Optional ping sink. Omitted ⇒ the ping route 404s. */
  onPing?: (headUrl: string) => void | Promise<void>;
  /** Path prefix the handler is mounted under, stripped before routing. Default "". */
  basePath?: string;
  /** SSE reconnect hint in milliseconds. Default 3000. */
  reconnectDelayMs?: number;
}

export type ArchiveHttpHandler = (request: Request) => Promise<Response>;
export function createArchiveHttpHandler(options: ArchiveHttpHandlerOptions): ArchiveHttpHandler;
```

- [ ] **Step 1: Write the failing test**

`src/archive-handler.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createArchiveHttpHandler } from "./archive-handler.js";
import { createFsBlobStore } from "./fs-blob-store.js";
import { IMMUTABLE_CACHE_CONTROL, REVALIDATE_CACHE_CONTROL } from "./http-headers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "jinn-archive-handler-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = "a".repeat(64);

async function seed(): Promise<void> {
  const store = createFsBlobStore(root);
  await store.put("/sources/feed/head", bytes('{"sequence":"0000000000000002"}'), "application/vnd.jinn.record-discovery.head.v1+json");
  await store.put("/sources/feed/entries/0000000000000001", bytes('{"page":"1"}'), "application/json");
  await store.put("/sources/feed/entries/0000000000000002", bytes('{"page":"2"}'), "application/json");
  await store.put(`/records/${digest}`, bytes("0123456789"), "application/octet-stream");
}

function handler(overrides: Partial<Parameters<typeof createArchiveHttpHandler>[0]> = {}) {
  return createArchiveHttpHandler({
    rootDir: root,
    sources: ["feed"],
    publicBaseUrl: "https://host",
    currentPage: async () => "0000000000000002",
    ...overrides,
  });
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://host${path}`, { method: "GET", headers });

describe("static routes", () => {
  it("answers the head with a strong ETag and no-cache, and 304s a matching conditional GET", async () => {
    await seed();
    const first = await handler()(get("/sources/feed/head"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"sha256:[a-f0-9]{64}"$/u);

    const second = await handler()(get("/sources/feed/head", { "if-none-match": etag }));
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe("");

    const stale = await handler()(get("/sources/feed/head", { "if-none-match": '"sha256:dead"' }));
    expect(stale.status).toBe(200);
  });

  it("serves digest paths immutable with declared byte ranges", async () => {
    await seed();
    const full = await handler()(get(`/records/${digest}`));
    expect(full.status).toBe(200);
    expect(full.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(full.headers.get("accept-ranges")).toBe("bytes");

    const partial = await handler()(get(`/records/${digest}`, { range: "bytes=2-5" }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");

    const unsatisfiable = await handler()(get(`/records/${digest}`, { range: "bytes=99-120" }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
  });

  it("serves sealed archive pages immutable and the current page revalidated", async () => {
    await seed();
    const sealed = await handler()(get("/sources/feed/entries/0000000000000001"));
    expect(sealed.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);

    const current = await handler()(get("/sources/feed/entries/0000000000000002"));
    expect(current.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
    expect(current.headers.get("etag")).toBeTruthy();

    // Safe default: with no currentPage resolver nothing is claimed immutable.
    const conservative = await handler({ currentPage: undefined })(get("/sources/feed/entries/0000000000000001"));
    expect(conservative.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
  });
});

describe("exposure scoping", () => {
  it("404s every path outside the archive route set with a typed JSON body", async () => {
    await seed();
    for (const path of ["/v1/status", "/", "/sources/feed", "/sources/feed/head/extra", "/.meta/sources/feed/head.json"]) {
      const response = await handler()(get(path));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe("application/json");
      expect(((await response.json()) as { code: string }).code, path).toBe("invalid-reference");
    }
  });

  it("404s a source name that is not on the allowlist, even when its files exist", async () => {
    await seed();
    const response = await handler({ sources: ["other"] })(get("/sources/feed/head"));
    expect(response.status).toBe(404);
  });

  it("404s traversal attempts, encoded or literal, without touching the filesystem", async () => {
    await seed();
    for (const path of ["/records/..%2f..%2fetc%2fpasswd", "/records/../../etc/passwd", "/sources/..%2ffeed/head"]) {
      expect((await handler()(get(path))).status, path).toBe(404);
    }
  });

  it("405s a write method on a read route and honors basePath stripping", async () => {
    await seed();
    const written = await handler()(new Request("https://host/sources/feed/head", { method: "PUT" }));
    expect(written.status).toBe(405);

    const mounted = handler({ basePath: "/discovery" });
    expect((await mounted(get("/discovery/sources/feed/head"))).status).toBe(200);
    expect((await mounted(get("/sources/feed/head"))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/archive-handler.test.ts
```
Expected: FAIL — `Failed to resolve import "./archive-handler.js"`.

- [ ] **Step 3: Implement the routing and static serving**

`src/archive-handler.ts`:

```ts
import {
  SEQUENCE_WIDTH,
  SOURCE_NAME_GRAMMAR,
  WELL_KNOWN_PATH,
  archivePagePath,
  headPath,
  recordPath,
} from "@jinn-network/record-discovery-protocol";

import { createLayoutReader } from "./fs-blob-store.js";
import type { PathClass } from "./http-headers.js";
import {
  REVALIDATE_CACHE_CONTROL,
  cacheControlFor,
  contentRangeFor,
  isNotModified,
  parseRangeHeader,
  unsatisfiableContentRange,
} from "./http-headers.js";
import type { LayoutReader } from "./ports.js";
import type { BoundedReplayRelay } from "./relay.js";

// The serving-plane HTTP surface (design §7; composition design §6.2/§7.3).
// Exposure is scoped by construction: this handler recognizes exactly the
// serving-plane route grammar for exactly the source names it was configured
// with, and answers a typed 404 for everything else. It never joins request
// text onto a filesystem path -- each route re-derives its serving path from
// `protocol`'s own path helpers after the segments pass their grammars, which
// is what makes percent-encoded traversal a non-event rather than a defended
// case.

const DIGEST_HEX = /^[a-f0-9]{64}$/u;
const PAGE_GRAMMAR = new RegExp(`^[0-9]{${String(SEQUENCE_WIDTH)}}$`, "u");
const READ_METHODS = new Set(["GET", "HEAD"]);

export interface ArchiveHttpHandlerOptions {
  rootDir: string;
  sources: readonly string[];
  relays?: Readonly<Record<string, BoundedReplayRelay>>;
  currentPage?: (sourceName: string) => Promise<string | undefined>;
  publicBaseUrl: string;
  onPing?: (headUrl: string) => void | Promise<void>;
  basePath?: string;
  reconnectDelayMs?: number;
}

export type ArchiveHttpHandler = (request: Request) => Promise<Response>;

function typedError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const notFound = (message: string): Response => typedError(404, "invalid-reference", message);

async function serveObject(
  reader: LayoutReader,
  servingPath: string,
  pathClass: PathClass,
  request: Request,
): Promise<Response> {
  const stat = await reader.stat(servingPath);
  if (stat === undefined) return notFound("No such serving-plane object.");

  const cacheControl = cacheControlFor(pathClass);
  const revalidated = cacheControl === REVALIDATE_CACHE_CONTROL;
  const headers: Record<string, string> = {
    "content-type": stat.contentType,
    "cache-control": cacheControl,
    "accept-ranges": "bytes",
  };
  // The head is the only mutable serving-plane object (§7 item 3), and the
  // current archive page is mutable in practice (serve re-partitions it) --
  // those are exactly the objects worth an entity tag. Immutable objects need
  // no revalidation at all.
  if (revalidated) headers["etag"] = stat.etag;

  if (revalidated && isNotModified(request.headers.get("if-none-match"), stat.etag)) {
    return new Response(null, { status: 304, headers });
  }

  const outcome = parseRangeHeader(request.headers.get("range"), stat.size);
  if (outcome.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": unsatisfiableContentRange(stat.size) },
    });
  }

  const range = outcome.kind === "single" ? outcome.range : undefined;
  const read = await reader.read(servingPath, range);
  if (read === undefined) return notFound("No such serving-plane object.");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  if (range === undefined) return new Response(read.bytes, { status: 200, headers });
  return new Response(read.bytes, {
    status: 206,
    headers: { ...headers, "content-range": contentRangeFor(range, stat.size) },
  });
}

export function createArchiveHttpHandler(options: ArchiveHttpHandlerOptions): ArchiveHttpHandler {
  const reader = createLayoutReader(options.rootDir);
  const served = new Set(options.sources);
  const basePath = options.basePath ?? "";

  async function pageClass(sourceName: string, page: string): Promise<PathClass> {
    if (options.currentPage === undefined) return "archive-page-current";
    return (await options.currentPage(sourceName)) === page ? "archive-page-current" : "archive-page-sealed";
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (basePath !== "" && !url.pathname.startsWith(basePath)) return notFound("Outside the archive mount.");
    const pathname = basePath === "" ? url.pathname : url.pathname.slice(basePath.length);

    // A percent sign never appears in a legal serving-plane path, so refusing
    // it up front removes decode-then-compare as a class of bug.
    if (pathname.includes("%")) return notFound("Not a serving-plane path.");
    const segments = pathname.split("/");

    if (pathname === WELL_KNOWN_PATH) {
      if (!READ_METHODS.has(request.method)) return typedError(405, "invalid-reference", "Read-only surface.");
      return serveObject(reader, WELL_KNOWN_PATH, "well-known", request);
    }

    if (segments.length === 3 && segments[1] === "records" && DIGEST_HEX.test(segments[2]!)) {
      if (!READ_METHODS.has(request.method)) return typedError(405, "invalid-reference", "Read-only surface.");
      return serveObject(reader, recordPath(`sha256:${segments[2]!}`), "record", request);
    }

    if (segments.length >= 4 && segments[1] === "sources" && SOURCE_NAME_GRAMMAR.test(segments[2]!)) {
      const sourceName = segments[2]!;
      if (!served.has(sourceName)) return notFound("Source not served here.");

      if (segments.length === 4 && segments[3] === "head") {
        if (!READ_METHODS.has(request.method)) return typedError(405, "invalid-reference", "Read-only surface.");
        return serveObject(reader, headPath(sourceName), "head", request);
      }
      if (segments.length === 5 && segments[3] === "entries" && PAGE_GRAMMAR.test(segments[4]!)) {
        if (!READ_METHODS.has(request.method)) return typedError(405, "invalid-reference", "Read-only surface.");
        const page = segments[4]!;
        return serveObject(reader, archivePagePath(sourceName, page), await pageClass(sourceName, page), request);
      }
      if (segments.length === 4 && segments[3] === "subscribe") {
        return subscribeRoute(options, sourceName, request);
      }
      if (segments.length === 4 && segments[3] === "ping") {
        return pingRoute(options, request);
      }
    }

    return notFound("Not a serving-plane path.");
  };
}
```

`subscribeRoute` and `pingRoute` land in Tasks 9 and 13. For this task, stub them at the
bottom of the file so the static routes compile and their own tests pass:

```ts
async function subscribeRoute(
  _options: ArchiveHttpHandlerOptions,
  _sourceName: string,
  _request: Request,
): Promise<Response> {
  return notFound("Subscribe is not wired yet (Task 9).");
}

async function pingRoute(_options: ArchiveHttpHandlerOptions, _request: Request): Promise<Response> {
  return notFound("Ping is not wired yet (Task 13).");
}
```

Add `export * from "./archive-handler.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/archive-handler.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): serve the archive layout over HTTP with scoped exposure"
```

---

## Task 9: The SSE subscribe route — the five cursor cases on the wire

**Files:**
- Modify: `packages/discovery/transport-http/src/archive-handler.ts` (replace the
  `subscribeRoute` stub), `src/archive-handler.test.ts` (add the subscribe describe block)

**Interfaces:**
- Consumes: `classifyCursor` from `@jinn-network/record-discovery-client` — **types only is not
  possible here**, so this is the one place the handler needs the classifier's *behavior*.
  Reimplementing it would fork the frozen five-case contract, so instead the handler takes the
  classification as data: `createArchiveHttpHandler` maps `relay.positionOf(cursor)` through
  the same rules, expressed once in `classifyRelayCursor` below and cross-checked against
  `classifyCursor` in Task 6's relay test. Also consumes `formatAnnouncementEvent`,
  `formatTerminalEvent`, `formatSseEvent`, `SSE_MEDIA_TYPE`, `CursorDetailCode` (Task 7) and
  `BoundedReplayRelay` (Task 6).
- Produces:

```ts
export type RelayCursorPlan =
  | { kind: "stream"; replay: RelayEvent[] }
  | { kind: "terminal"; detailCode: CursorDetailCode };
export function classifyRelayCursor(relay: BoundedReplayRelay, cursor: string | undefined): RelayCursorPlan;
```

- [ ] **Step 1: Write the failing test**

Append to `src/archive-handler.test.ts`:

```ts
import { createBoundedReplayRelay } from "./relay.js";
import type { AnnouncementEvent } from "@jinn-network/record-discovery-protocol";

function announcement(id: string): AnnouncementEvent {
  return {
    specversion: "1.0", id, source: "did:key:zAgentSourceOne/feed",
    type: "network.jinn.record-discovery.announcement", subject: `sha256:${id.padStart(64, "0")}`,
    recordkind: "https://jinn.network/records/submission/1.0",
    sourceagent: "did:key:zAgentSourceOne", sourcename: "feed",
    entrydigest: `sha256:${id.padStart(64, "1")}`, announcementid: id,
    data: {} as AnnouncementEvent["data"],
  };
}

/** Reads the whole SSE body a terminated stream produced, then splits it into frames. */
async function frames(response: Response): Promise<string[]> {
  const text = await response.text();
  return text.split("\n\n").filter((frame) => frame.trim() !== "");
}

const countAnnouncements = (all: string[]): number =>
  all.filter((frame) => frame.includes("event: announcement")).length;

function seededRelay(published: number, windowSize: number) {
  const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize });
  for (let index = 0; index < published; index += 1) relay.publish(announcement(String(index)));
  return relay;
}

describe("the SSE subscribe route maps the five cursor cases (§9.3) onto the wire", () => {
  it("no cursor: live tail from now, nothing replayed", async () => {
    await seed();
    const relay = seededRelay(4, 10);
    const response = await handler({ relays: { feed: relay } })(get("/sources/feed/subscribe"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    response.body!.cancel();
  });

  it("cursor within the window: replays from the position after it", async () => {
    await seed();
    const relay = seededRelay(10, 10);
    const response = await handler({ relays: { feed: relay } })(get("/sources/feed/subscribe?cursor=relay-a:3"));
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(countAnnouncements(chunk.split("\n\n"))).toBe(6);
  });

  it("oldest: replays the whole bounded window", async () => {
    await seed();
    const relay = seededRelay(7, 10);
    const response = await handler({ relays: { feed: relay } })(get("/sources/feed/subscribe?cursor=oldest"));
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(countAnnouncements(chunk.split("\n\n"))).toBe(7);
  });

  it("unknown or future cursor: one typed `cursor-unknown` terminal event naming the cold-sync path, then close", async () => {
    await seed();
    const relay = seededRelay(10, 10);
    const response = await handler({ relays: { feed: relay } })(get("/sources/feed/subscribe?cursor=relay-a:999999"));
    const all = await frames(response);
    expect(countAnnouncements(all)).toBe(0);
    const terminal = all.find((frame) => frame.includes("event: cursor-unknown"))!;
    const data = JSON.parse(terminal.split("data: ")[1]!) as { code: string; coldSync: { archiveRoot: string; headPath: string } };
    expect(data.code).toBe("invalid-reference");
    expect(data.coldSync.headPath).toBe("https://host/sources/feed/head");
    expect(data.coldSync.archiveRoot).toBe("https://host/sources/feed/entries");
  });

  it("cursor older than the window: one typed `cursor-too-old` terminal event, then close", async () => {
    await seed();
    const relay = seededRelay(14, 10);
    const response = await handler({ relays: { feed: relay } })(get("/sources/feed/subscribe?cursor=relay-a:1"));
    const all = await frames(response);
    expect(countAnnouncements(all)).toBe(0);
    expect(all.some((frame) => frame.includes("event: cursor-too-old"))).toBe(true);
  });

  it("Last-Event-ID wins over ?cursor= and resumes strictly after it", async () => {
    await seed();
    const relay = seededRelay(10, 10);
    const response = await handler({ relays: { feed: relay } })(
      get("/sources/feed/subscribe?cursor=oldest", { "last-event-id": "relay-a:5" }),
    );
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(countAnnouncements(chunk.split("\n\n"))).toBe(4);
  });

  it("streams live events published after the subscription opens, and 404s a source with no relay", async () => {
    await seed();
    const relay = seededRelay(0, 10);
    const response = await handler({ relays: { feed: relay } })(get("/sources/feed/subscribe"));
    const reader = response.body!.getReader();
    relay.publish(announcement("live-1"));
    const chunk = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(chunk).toContain("id: relay-a:0");

    expect((await handler()(get("/sources/feed/subscribe"))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/archive-handler.test.ts -t "cursor"
```
Expected: FAIL — the stub answers 404 with `Subscribe is not wired yet`.

- [ ] **Step 3: Implement `classifyRelayCursor` and the route**

Replace the `subscribeRoute` stub in `src/archive-handler.ts`, and add these imports at the
top of the file:

```ts
import type { CursorDetailCode } from "./sse.js";
import { SSE_MEDIA_TYPE, formatAnnouncementEvent, formatSseEvent, formatTerminalEvent } from "./sse.js";
import type { RelayEvent } from "./relay.js";
```

```ts
export type RelayCursorPlan =
  | { kind: "stream"; replay: RelayEvent[] }
  | { kind: "terminal"; detailCode: CursorDetailCode };

/**
 * The §9.3 five-case cursor contract, resolved against one relay's bounded
 * window. This is the server-side twin of `client`'s `classifyCursor`; the
 * relay test asserts the two agree case for case, so the contract has exactly
 * one meaning across the wire.
 *
 *   no cursor          -> stream, nothing replayed (live tail from now)
 *   "oldest"           -> stream, the whole window (start of window)
 *   inside the window  -> stream, replayed from after the cursor
 *   evicted            -> terminal `cursor-too-old`, naming the cold-sync path
 *   never issued/future-> terminal `cursor-unknown`; never guessed
 */
export function classifyRelayCursor(relay: BoundedReplayRelay, cursor: string | undefined): RelayCursorPlan {
  if (cursor === undefined) return { kind: "stream", replay: [] };
  if (cursor === "oldest") return { kind: "stream", replay: relay.replayFrom("oldest") };
  const position = relay.positionOf(cursor);
  if (position === undefined) return { kind: "terminal", detailCode: "cursor-unknown" };
  if (position < 0) return { kind: "terminal", detailCode: "cursor-too-old" };
  return { kind: "stream", replay: relay.replayFrom(cursor) };
}

async function subscribeRoute(
  options: ArchiveHttpHandlerOptions,
  sourceName: string,
  request: Request,
): Promise<Response> {
  if (!READ_METHODS.has(request.method)) return typedError(405, "invalid-reference", "Read-only surface.");
  const relay = options.relays?.[sourceName];
  if (relay === undefined) return notFound("This source serves no subscribe tail.");

  const url = new URL(request.url);
  // SSE reconnect semantics: the browser-standard Last-Event-ID header is
  // authoritative over the initial query parameter (§7.3 -- the relay cursor
  // rides Last-Event-ID).
  const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? undefined;
  const plan = classifyRelayCursor(relay, cursor);

  const base = options.publicBaseUrl.replace(/\/+$/u, "");
  const coldSync = {
    archiveRoot: `${base}/sources/${sourceName}/entries`,
    headPath: `${base}/sources/${sourceName}/head`,
  };

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (plan.kind === "terminal") {
        controller.enqueue(encoder.encode(formatTerminalEvent(plan.detailCode, coldSync)));
        controller.close();
        return;
      }
      // An SSE comment declaring the cursor scope on the wire (§9.3: relay
      // cursors are relay-local and MUST be declared as such), plus the
      // reconnect hint. Comments are ignored by conformant parsers.
      const advertisement = relay.advertisement();
      controller.enqueue(encoder.encode(
        `: relay ${advertisement.relayId} cursor-scope ${advertisement.cursorScope} replay-window ${String(advertisement.windowSize)}\n\n`,
      ));
      controller.enqueue(encoder.encode(formatSseEvent({ event: "open", data: JSON.stringify(advertisement), retry: options.reconnectDelayMs ?? 3000 })));
      for (const relayEvent of plan.replay) controller.enqueue(encoder.encode(formatAnnouncementEvent(relayEvent)));
      unsubscribe = relay.subscribe((relayEvent) => {
        try {
          controller.enqueue(encoder.encode(formatAnnouncementEvent(relayEvent)));
        } catch {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": SSE_MEDIA_TYPE, "cache-control": "no-store" },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/archive-handler.test.ts
```
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): map the five-case cursor contract onto the SSE tail"
```

---

## Task 10: Advertising the bounded replay window in the well-known document

**Files:**
- Create: `packages/discovery/transport-http/src/well-known.ts`, `src/well-known.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `WellKnownDocument`, `WellKnownSourceEntry`, `parseWellKnownDocument` from
  `@jinn-network/record-discovery-serve`; `ReplayWindowAdvertisement` (Task 6).
- Produces:

```ts
export interface SubscribeAdvertisement {
  sourceName: string;
  /** Serving-plane path of the SSE tail, relative to the serving root. */
  subscribePath: string;
  replayWindow: ReplayWindowAdvertisement;
}
export type AdvertisedWellKnownDocument = Omit<WellKnownDocument, "sources"> & {
  sources: Array<WellKnownSourceEntry & { subscribe?: SubscribeAdvertisement }>;
};
export function withSubscribeAdvertisement(
  document: WellKnownDocument,
  advertisements: readonly SubscribeAdvertisement[],
): AdvertisedWellKnownDocument;
```

- [ ] **Step 1: Write the failing test**

`src/well-known.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWellKnownDocument } from "@jinn-network/record-discovery-serve";
import { RECORD_DISCOVERY_VERSION } from "@jinn-network/record-discovery-protocol";

import { withSubscribeAdvertisement } from "./well-known.js";

const document = {
  protocol: RECORD_DISCOVERY_VERSION,
  sources: [
    { agent: "did:key:zAgentSourceOne", name: "feed", headPath: "/sources/feed/head", archiveRoot: "/sources/feed/entries" },
    { agent: "did:key:zAgentSourceOne", name: "other", headPath: "/sources/other/head", archiveRoot: "/sources/other/entries" },
  ],
};

describe("withSubscribeAdvertisement", () => {
  it("attaches the bounded, relay-local replay window to the named source only", () => {
    const advertised = withSubscribeAdvertisement(document, [{
      sourceName: "feed",
      subscribePath: "/sources/feed/subscribe",
      replayWindow: { relayId: "relay-a", windowSize: 500, cursorScope: "relay-local" },
    }]);

    expect(advertised.sources[0]!.subscribe).toEqual({
      sourceName: "feed",
      subscribePath: "/sources/feed/subscribe",
      replayWindow: { relayId: "relay-a", windowSize: 500, cursorScope: "relay-local" },
    });
    expect(advertised.sources[1]!.subscribe).toBeUndefined();
  });

  it("stays valid under the protocol's own well-known schema, so serve can still write it", () => {
    const advertised = withSubscribeAdvertisement(document, [{
      sourceName: "feed",
      subscribePath: "/sources/feed/subscribe",
      replayWindow: { relayId: "relay-a", windowSize: 500, cursorScope: "relay-local" },
    }]);
    expect(() => parseWellKnownDocument(advertised)).not.toThrow();
  });

  it("rejects an advertisement for a source the document does not list", () => {
    expect(() => withSubscribeAdvertisement(document, [{
      sourceName: "absent",
      subscribePath: "/sources/absent/subscribe",
      replayWindow: { relayId: "relay-a", windowSize: 500, cursorScope: "relay-local" },
    }])).toThrow(/does not list the source "absent"/u);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/well-known.test.ts
```
Expected: FAIL — `Failed to resolve import "./well-known.js"`.

- [ ] **Step 3: Implement**

`src/well-known.ts`:

```ts
import type { WellKnownDocument, WellKnownSourceEntry } from "@jinn-network/record-discovery-serve";

import type { ReplayWindowAdvertisement } from "./relay.js";

// §9.3 requires every source to advertise its bounded replay window and to
// declare its cursors relay-local; §7 item 3 makes the well-known discovery
// document the place a host introduces its sources. The document's schema is
// `z.looseObject`, so this extra field validates unchanged -- but its
// TypeScript interface is closed, which is why the additive shape is minted
// here rather than by widening `serve`.

export interface SubscribeAdvertisement {
  sourceName: string;
  subscribePath: string;
  replayWindow: ReplayWindowAdvertisement;
}

export type AdvertisedWellKnownDocument = Omit<WellKnownDocument, "sources"> & {
  sources: Array<WellKnownSourceEntry & { subscribe?: SubscribeAdvertisement }>;
};

export function withSubscribeAdvertisement(
  document: WellKnownDocument,
  advertisements: readonly SubscribeAdvertisement[],
): AdvertisedWellKnownDocument {
  const listed = new Set(document.sources.map((source) => source.name));
  for (const advertisement of advertisements) {
    if (!listed.has(advertisement.sourceName)) {
      throw new Error(
        `withSubscribeAdvertisement: the document does not list the source "${advertisement.sourceName}".`,
      );
    }
  }

  const byName = new Map(advertisements.map((advertisement) => [advertisement.sourceName, advertisement]));
  return {
    ...document,
    sources: document.sources.map((source) => {
      const advertisement = byName.get(source.name);
      return advertisement === undefined ? { ...source } : { ...source, subscribe: advertisement };
    }),
  };
}
```

Add `export * from "./well-known.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/well-known.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): advertise the bounded replay window in the well-known document"
```

---

## Task 11: `createHttpTransport`

**Files:**
- Create: `packages/discovery/transport-http/src/transport.ts`, `src/transport.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 1); `Transport` and `TransportResponse` from
  `@jinn-network/record-discovery-client`, **imported with `import type` only** (Task 1 guard).
- Produces:

```ts
export function createHttpTransport(baseUrl: string, fetchLike: FetchLike): Transport;
```

Resolves relative URLs against `baseUrl`, surfaces the server-declared `Content-Length` as
`declaredLength` so the hostile-locator guards can reject before transferring, and passes the
status through unaltered — a typed 404 from the archive handler reaches `client` as
`status: 404` with the JSON body intact, never as a thrown error.

- [ ] **Step 1: Write the failing test**

`src/transport.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createHttpTransport } from "./transport.js";
import type { FetchLike } from "./ports.js";

function stubFetch(entries: Record<string, { status: number; contentType?: string; contentLength?: string; body: string }>): {
  fetchLike: FetchLike;
  calls: Array<{ url: string; headers?: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ url, ...(init?.headers === undefined ? {} : { headers: init.headers }) });
    const entry = entries[url] ?? { status: 404, contentType: "application/json", body: '{"code":"invalid-reference"}' };
    return {
      status: entry.status,
      headers: {
        get: (name: string) => {
          const lower = name.toLowerCase();
          if (lower === "content-type") return entry.contentType ?? null;
          if (lower === "content-length") return entry.contentLength ?? null;
          return null;
        },
      },
      arrayBuffer: async () => new TextEncoder().encode(entry.body).buffer as ArrayBuffer,
    };
  };
  return { fetchLike, calls };
}

describe("createHttpTransport", () => {
  it("resolves relative serving-plane paths against the base URL and returns exact bytes", async () => {
    const { fetchLike, calls } = stubFetch({
      "https://host/sources/feed/head": { status: 200, contentType: "application/json", body: '{"sequence":"1"}' },
    });
    const transport = createHttpTransport("https://host", fetchLike);

    const response = await transport.fetch("/sources/feed/head");
    expect(calls[0]!.url).toBe("https://host/sources/feed/head");
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(new TextDecoder().decode(response.bytes)).toBe('{"sequence":"1"}');
  });

  it("passes absolute URLs through untouched", async () => {
    const { fetchLike, calls } = stubFetch({
      "https://mirror.example/sources/feed/head": { status: 200, body: "{}" },
    });
    await createHttpTransport("https://host", fetchLike).fetch("https://mirror.example/sources/feed/head");
    expect(calls[0]!.url).toBe("https://mirror.example/sources/feed/head");
  });

  it("surfaces the declared Content-Length so oversize guards can reject before trusting a body", async () => {
    const { fetchLike } = stubFetch({
      "https://host/records/abc": { status: 200, contentType: "application/octet-stream", contentLength: "1048577", body: "x" },
    });
    const response = await createHttpTransport("https://host", fetchLike).fetch("/records/abc");
    expect(response.declaredLength).toBe(1048577);
  });

  it("returns a typed 404 as a status, never as a throw", async () => {
    const { fetchLike } = stubFetch({});
    const response = await createHttpTransport("https://host", fetchLike).fetch("/sources/absent/head");
    expect(response.status).toBe(404);
    expect(JSON.parse(new TextDecoder().decode(response.bytes))).toEqual({ code: "invalid-reference" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/discovery/transport-http && yarn vitest run src/transport.test.ts
```
Expected: FAIL — `Failed to resolve import "./transport.js"`.

- [ ] **Step 3: Implement**

`src/transport.ts`:

```ts
import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";

// `client`'s `Transport` port over an injected fetch-shaped function. The
// method name is quoted for the same reason `client/src/ports.ts` quotes it:
// the discovery tree's ambient-network guard is a textual scanner and cannot
// tell a port-method declaration from a call to the banned global.
//
// Status codes pass through unaltered. The archive handler answers a typed
// JSON body on 404, and `client` decides what a status means -- a transport
// that threw would destroy that distinction.

export function createHttpTransport(baseUrl: string, fetchLike: FetchLike): Transport {
  return {
    async "fetch"(url: string): Promise<TransportResponse> {
      const resolved = new URL(url, baseUrl).toString();
      const response = await fetchLike(resolved);
      const contentType = response.headers.get("content-type");
      const contentLength = response.headers.get("content-length");
      const declaredLength = contentLength === null ? Number.NaN : Number(contentLength);
      return {
        status: response.status,
        ...(contentType === null ? {} : { contentType }),
        ...(Number.isFinite(declaredLength) ? { declaredLength } : {}),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}
```

Add `export * from "./transport.js";` to `src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/transport.test.ts
cd ../../.. && node --test .github/scripts/record-discovery-source-boundaries.test.mjs
```
Expected: PASS; the type-only-client guard stays green (`import type` on the client edge).

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add the HTTP Transport over an injected fetch"
```

---

## Task 12: The SSE frame parser and `createSseStreamTransport`

**Files:**
- Create: `packages/discovery/transport-http/src/sse-parse.ts`, `src/sse-parse.test.ts`,
  `src/stream-transport.ts`, `src/stream-transport.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 1); `SSE_MEDIA_TYPE`, `ANNOUNCEMENT_SSE_EVENT`,
  `CursorDetailCode`, `ColdSyncPath` (Task 7); `StreamTransport`, `StreamSubscription` from
  `@jinn-network/record-discovery-client` (`import type` only).
- Produces:

```ts
export interface SseFrame { id?: string; event?: string; data: string; retry?: number; }
export interface SseFrameParser { push(chunk: string): SseFrame[]; }
export function createSseFrameParser(): SseFrameParser;

export class CursorTerminalError extends Error {
  readonly code: "invalid-reference";
  readonly detailCode: CursorDetailCode;
  readonly coldSync: ColdSyncPath;
  constructor(detailCode: CursorDetailCode, coldSync: ColdSyncPath);
}

export interface SseStreamTransportOptions {
  reconnectDelayMs?: number;
  /** Injected scheduler so tests drive reconnects deterministically. Returns a canceller. */
  scheduleReconnect?: (run: () => void, delayMs: number) => () => void;
}

export function createSseStreamTransport(
  baseUrl: string,
  fetchLike: FetchLike,
  options?: SseStreamTransportOptions,
): StreamTransport;
```

- [ ] **Step 1: Write the failing parser test**

`src/sse-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createSseFrameParser } from "./sse-parse.js";

describe("createSseFrameParser", () => {
  it("emits a frame per blank-line-terminated block, joining multi-line data with newlines", () => {
    const parser = createSseFrameParser();
    expect(parser.push("id: relay-a:0\nevent: announcement\ndata: {\"a\":1}\n\n")).toEqual([
      { id: "relay-a:0", event: "announcement", data: '{"a":1}' },
    ]);
    expect(parser.push("data: one\ndata: two\n\n")).toEqual([{ data: "one\ntwo" }]);
  });

  it("buffers across chunk boundaries and ignores comments and unknown fields", () => {
    const parser = createSseFrameParser();
    expect(parser.push(": a comment\n\nevent: announce")).toEqual([]);
    expect(parser.push("ment\ndata: x\nunknown: y\n\n")).toEqual([{ event: "announcement", data: "x" }]);
  });

  it("parses retry and tolerates the optional space after the colon", () => {
    const parser = createSseFrameParser();
    expect(parser.push("retry: 3000\ndata:x\n\n")).toEqual([{ data: "x", retry: 3000 }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement the parser**

```bash
cd packages/discovery/transport-http && yarn vitest run src/sse-parse.test.ts
```
Expected: FAIL — `Failed to resolve import "./sse-parse.js"`.

`src/sse-parse.ts`:

```ts
// Client-side SSE parsing (WHATWG HTML §9.2 event-stream interpretation).
// Hand-written rather than delegated to `EventSource` for two reasons: the
// discovery tree's guard bans the ambient API outright, and `EventSource`
// cannot send the request headers the archive surface needs (`Last-Event-ID`
// on an explicit reconnect, `Accept`).

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

export interface SseFrameParser {
  push(chunk: string): SseFrame[];
}

export function createSseFrameParser(): SseFrameParser {
  let buffered = "";

  function interpret(block: string): SseFrame | undefined {
    const data: string[] = [];
    let id: string | undefined;
    let event: string | undefined;
    let retry: number | undefined;

    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "retry" && /^[0-9]+$/u.test(value)) retry = Number(value);
    }

    if (data.length === 0 && id === undefined && event === undefined && retry === undefined) return undefined;
    return {
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      ...(retry === undefined ? {} : { retry }),
      data: data.join("\n"),
    };
  }

  return {
    push(chunk: string): SseFrame[] {
      buffered += chunk.replace(/\r\n|\r/gu, "\n");
      const blocks = buffered.split("\n\n");
      buffered = blocks.pop() ?? "";
      return blocks.map(interpret).filter((frame): frame is SseFrame => frame !== undefined);
    },
  };
}
```

Run again: PASS, 3 tests.

- [ ] **Step 3: Write the failing stream-transport test**

`src/stream-transport.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CursorTerminalError, createSseStreamTransport } from "./stream-transport.js";
import type { FetchLike } from "./ports.js";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function stub(chunksPerCall: readonly (readonly string[])[]): {
  fetchLike: FetchLike;
  seen: Array<Record<string, string> | undefined>;
} {
  const seen: Array<Record<string, string> | undefined> = [];
  let call = 0;
  const fetchLike: FetchLike = async (_url, init) => {
    seen.push(init?.headers);
    const chunks = chunksPerCall[Math.min(call, chunksPerCall.length - 1)]!;
    call += 1;
    return {
      status: 200,
      headers: { get: () => "text/event-stream" },
      arrayBuffer: async () => new ArrayBuffer(0),
      body: streamOf(chunks),
    };
  };
  return { fetchLike, seen };
}

const announcement = (id: string, payload: string): string =>
  `id: ${id}\nevent: announcement\ndata: ${payload}\n\n`;

describe("createSseStreamTransport", () => {
  it("delivers announcement payloads to onMessage and skips the open frame", async () => {
    const { fetchLike } = stub([[
      ': relay relay-a cursor-scope relay-local replay-window 10\n\n',
      'event: open\ndata: {"relayId":"relay-a"}\n\n',
      announcement("relay-a:0", '{"announcementid":"ann-1"}'),
    ]]);
    const messages: string[] = [];
    createSseStreamTransport("https://host", fetchLike, { scheduleReconnect: () => () => {} })
      .connect("/sources/feed/subscribe", (raw) => messages.push(raw), () => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toEqual(['{"announcementid":"ann-1"}']);
  });

  it("surfaces a typed terminal event through onError and does not reconnect", async () => {
    const coldSync = { archiveRoot: "https://host/sources/feed/entries", headPath: "https://host/sources/feed/head" };
    const { fetchLike, seen } = stub([[
      `event: cursor-too-old\ndata: ${JSON.stringify({ code: "invalid-reference", detailCode: "cursor-too-old", coldSync })}\n\n`,
    ]]);
    const errors: unknown[] = [];
    let reconnects = 0;
    createSseStreamTransport("https://host", fetchLike, {
      scheduleReconnect: (run) => { reconnects += 1; run(); return () => {}; },
    }).connect("/sources/feed/subscribe?cursor=relay-a:1", () => {}, (error) => errors.push(error));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toHaveLength(1);
    const error = errors[0] as CursorTerminalError;
    expect(error).toBeInstanceOf(CursorTerminalError);
    expect(error.code).toBe("invalid-reference");
    expect(error.detailCode).toBe("cursor-too-old");
    expect(error.coldSync).toEqual(coldSync);
    expect(reconnects).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("reconnects after a clean end of stream and carries the last event id", async () => {
    const { fetchLike, seen } = stub([
      [announcement("relay-a:4", '{"a":1}')],
      [announcement("relay-a:5", '{"a":2}')],
    ]);
    let scheduled: (() => void) | undefined;
    const subscription = createSseStreamTransport("https://host", fetchLike, {
      scheduleReconnect: (run) => { scheduled = run; return () => { scheduled = undefined; }; },
    }).connect("/sources/feed/subscribe", () => {}, () => {});

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen[0]?.["last-event-id"]).toBeUndefined();
    scheduled?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen[1]?.["last-event-id"]).toBe("relay-a:4");
    subscription.close();
  });

  it("close() stops delivery and prevents any further reconnect", async () => {
    const { fetchLike } = stub([[announcement("relay-a:0", '{"a":1}')]]);
    let scheduled: (() => void) | undefined;
    const subscription = createSseStreamTransport("https://host", fetchLike, {
      scheduleReconnect: (run) => { scheduled = run; return () => { scheduled = undefined; }; },
    }).connect("/sources/feed/subscribe", () => {}, () => {});
    subscription.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduled).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run to verify it fails, then implement**

```bash
cd packages/discovery/transport-http && yarn vitest run src/stream-transport.test.ts
```
Expected: FAIL — `Failed to resolve import "./stream-transport.js"`.

`src/stream-transport.ts`:

```ts
import type { StreamSubscription, StreamTransport } from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";
import { createSseFrameParser } from "./sse-parse.js";
import type { ColdSyncPath, CursorDetailCode } from "./sse.js";
import { ANNOUNCEMENT_SSE_EVENT, SSE_MEDIA_TYPE } from "./sse.js";

// `client`'s `StreamTransport` port over SSE -- the normative pull-tail
// profile (composition design §7.3, closing discovery §9.4).
//
// The frozen port has no channel for a typed terminal condition, so the two
// cursor terminals arrive through `onError` as this typed error and the
// subscription then stays closed. That is the honest mapping: §9.3 forbids
// guessing and forbids silent gap-skipping, and a caller that receives a
// CursorTerminalError knows exactly which cold-sync path to walk instead.

const TERMINAL_EVENTS = new Set<string>(["cursor-unknown", "cursor-too-old"]);

export class CursorTerminalError extends Error {
  /** The TEP error taxonomy category; discovery adds no parallel taxonomy (design §8). */
  readonly code = "invalid-reference" as const;
  readonly detailCode: CursorDetailCode;
  readonly coldSync: ColdSyncPath;

  constructor(detailCode: CursorDetailCode, coldSync: ColdSyncPath) {
    super(`record-discovery subscribe: ${detailCode}; cold-sync from ${coldSync.archiveRoot}`);
    this.name = "CursorTerminalError";
    this.detailCode = detailCode;
    this.coldSync = coldSync;
  }
}

export interface SseStreamTransportOptions {
  reconnectDelayMs?: number;
  scheduleReconnect?: (run: () => void, delayMs: number) => () => void;
}

function parseColdSync(data: string): ColdSyncPath {
  try {
    const parsed = JSON.parse(data) as { coldSync?: ColdSyncPath };
    return parsed.coldSync ?? { archiveRoot: "", headPath: "" };
  } catch {
    return { archiveRoot: "", headPath: "" };
  }
}

export function createSseStreamTransport(
  baseUrl: string,
  fetchLike: FetchLike,
  options: SseStreamTransportOptions = {},
): StreamTransport {
  const defaultDelayMs = options.reconnectDelayMs ?? 3000;
  const schedule =
    options.scheduleReconnect ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => {
        clearTimeout(timer);
      };
    });

  return {
    connect(
      url: string,
      onMessage: (raw: string) => void,
      onError: (error: unknown) => void,
    ): StreamSubscription {
      const resolved = new URL(url, baseUrl).toString();
      let closed = false;
      let lastEventId: string | undefined;
      let delayMs = defaultDelayMs;
      let cancelReconnect: (() => void) | undefined;
      let abort: AbortController | undefined;

      const reopenLater = (): void => {
        if (closed) return;
        cancelReconnect = schedule(() => {
          cancelReconnect = undefined;
          open();
        }, delayMs);
      };

      function open(): void {
        if (closed) return;
        abort = new AbortController();
        void (async (): Promise<void> => {
          try {
            const response = await fetchLike(resolved, {
              headers: {
                accept: SSE_MEDIA_TYPE,
                ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
              },
              signal: abort!.signal,
            });
            const body = response.body;
            if (response.status !== 200 || body === undefined || body === null) {
              throw new Error(`record-discovery subscribe: unexpected status ${String(response.status)}`);
            }

            const parser = createSseFrameParser();
            const decoder = new TextDecoder();
            const reader = body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done || closed) break;
              for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
                if (frame.retry !== undefined) delayMs = frame.retry;
                if (frame.id !== undefined) lastEventId = frame.id;
                if (frame.event !== undefined && TERMINAL_EVENTS.has(frame.event)) {
                  closed = true;
                  await reader.cancel();
                  onError(new CursorTerminalError(frame.event as CursorDetailCode, parseColdSync(frame.data)));
                  return;
                }
                // Announcement frames carry the announce-plane CloudEvent;
                // unnamed frames are observation pass-through (§9.1: a relay
                // adds nothing). Everything else -- the `open` advertisement --
                // is transport bookkeeping and never reaches the consumer.
                if (frame.event === ANNOUNCEMENT_SSE_EVENT || frame.event === undefined) onMessage(frame.data);
              }
            }
            reopenLater();
          } catch (error) {
            if (closed) return;
            onError(error);
            reopenLater();
          }
        })();
      }

      open();

      return {
        close(): void {
          closed = true;
          cancelReconnect?.();
          cancelReconnect = undefined;
          abort?.abort();
        },
      };
    },
  };
}
```

Add `export * from "./sse-parse.js";` and `export * from "./stream-transport.js";` to
`src/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn vitest run src/sse-parse.test.ts src/stream-transport.test.ts
cd ../../.. && node --test .github/scripts/record-discovery-source-boundaries.test.mjs
```
Expected: PASS, 7 tests; the ambient-network and type-only-client guards stay green.

- [ ] **Step 6: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add the SSE StreamTransport with typed cursor terminals"
```

---

## Task 13: Announcement pings, both directions

**Files:**
- Create: `packages/discovery/transport-http/src/ping.ts`, `src/ping.test.ts`
- Modify: `packages/discovery/transport-http/src/archive-handler.ts` (replace the `pingRoute`
  stub), `src/archive-handler.test.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 1); `PingTransport` from `@jinn-network/record-discovery-serve`.
- Produces:

```ts
export function createHttpPingTransport(endpointUrl: string, fetchLike: FetchLike): PingTransport;
export const MAX_PING_BODY_BYTES = 4096;
```

- [ ] **Step 1: Write the failing tests**

`src/ping.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createHttpPingTransport } from "./ping.js";
import type { FetchLike } from "./ports.js";

describe("createHttpPingTransport", () => {
  it("POSTs the head URL as JSON to the configured endpoint", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, ...(init?.method === undefined ? {} : { method: init.method }), ...(init?.body === undefined ? {} : { body: init.body }) });
      return { status: 204, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    };

    await createHttpPingTransport("https://peer/sources/feed/ping", fetchLike)
      .announce("https://host/sources/feed/head");

    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ headUrl: "https://host/sources/feed/head" });
  });

  it("does not throw when the peer rejects the ping -- a ping carries no trust either way", async () => {
    const fetchLike: FetchLike = async () => ({ status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(createHttpPingTransport("https://peer/sources/feed/ping", fetchLike)
      .announce("https://host/sources/feed/head")).resolves.toBeUndefined();
  });
});
```

Append to `src/archive-handler.test.ts`:

```ts
describe("the ping route", () => {
  it("accepts an unauthenticated head-moved hint and hands it to the sink", async () => {
    await seed();
    const received: string[] = [];
    const response = await handler({ onPing: (headUrl) => { received.push(headUrl); } })(
      new Request("https://host/sources/feed/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headUrl: "https://peer/sources/feed/head" }),
      }),
    );
    expect(response.status).toBe(204);
    expect(received).toEqual(["https://peer/sources/feed/head"]);
  });

  it("404s when no sink is configured, 405s a GET, and rejects a malformed or oversized body", async () => {
    await seed();
    expect((await handler()(new Request("https://host/sources/feed/ping", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await handler({ onPing: () => {} })(get("/sources/feed/ping"))).status).toBe(405);

    const sink = handler({ onPing: () => {} });
    expect((await sink(new Request("https://host/sources/feed/ping", { method: "POST", body: "not json" }))).status).toBe(400);
    expect((await sink(new Request("https://host/sources/feed/ping", {
      method: "POST", body: JSON.stringify({ headUrl: "x".repeat(5000) }),
    }))).status).toBe(413);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/discovery/transport-http && yarn vitest run src/ping.test.ts src/archive-handler.test.ts -t "ping"
```
Expected: FAIL — no `./ping.js`; the `pingRoute` stub 404s everything.

- [ ] **Step 3: Implement**

`src/ping.ts`:

```ts
import type { PingTransport } from "@jinn-network/record-discovery-serve";

import type { FetchLike } from "./ports.js";

// Announcement pings (design §7 item 4): optional, unauthenticated "head
// moved" hints. All trust lives in the pulled, verified chain, so a ping that
// fails to deliver costs latency and nothing else -- which is why this never
// throws on a rejecting peer. Debouncing is the caller's job on both sides
// (`serve`'s `emitPing`, `client`'s `createPullDebounce`).

export const MAX_PING_BODY_BYTES = 4096;

export function createHttpPingTransport(endpointUrl: string, fetchLike: FetchLike): PingTransport {
  return {
    async announce(headUrl: string): Promise<void> {
      try {
        await fetchLike(endpointUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ headUrl }),
        });
      } catch {
        // Deliberately swallowed: see the module note.
      }
    },
  };
}
```

Replace the `pingRoute` stub in `src/archive-handler.ts` (and import `MAX_PING_BODY_BYTES`
from `./ping.js`):

```ts
async function pingRoute(options: ArchiveHttpHandlerOptions, request: Request): Promise<Response> {
  const onPing = options.onPing;
  if (onPing === undefined) return notFound("This archive accepts no pings.");
  if (request.method !== "POST") return typedError(405, "invalid-reference", "Pings are POSTed.");

  const body = await request.text();
  if (body.length > MAX_PING_BODY_BYTES) {
    return typedError(413, "invalid-reference", "Ping body exceeds the accepted ceiling.");
  }
  let headUrl: unknown;
  try {
    headUrl = (JSON.parse(body) as { headUrl?: unknown }).headUrl;
  } catch {
    return typedError(400, "invalid-reference", "Ping body is not JSON.");
  }
  if (typeof headUrl !== "string" || headUrl === "") {
    return typedError(400, "invalid-reference", "Ping body carries no headUrl.");
  }

  await onPing(headUrl);
  return new Response(null, { status: 204 });
}
```

Add `export * from "./ping.js";` to `src/index.ts`.

- [ ] **Step 4: Run to verify they pass**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn test
```
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "feat(discovery): add HTTP announcement pings in both directions"
```

---

## Task 14: Conformance wiring, the loopback round trip, and the README

**Files:**
- Create: `packages/discovery/transport-http/src/serving-plane-conformance.test.ts`,
  `src/loopback.test.ts`, `README.md`
- Test: the whole package suite

**Interfaces:**
- Consumes: `runServingPlaneConformance`, `ServingPlaneUnderTest` from
  `@jinn-network/record-discovery-testing` (Task 3); every factory from Tasks 4–13.
- Produces: nothing new — this is the task that proves the pieces are one surface.

- [ ] **Step 1: Write the conformance adapter**

`src/serving-plane-conformance.test.ts` builds a `ServingPlaneUnderTest` over the real
handler. Each vector's `input` names what to construct; the adapter constructs it and answers
from a real `Request`/`Response` round trip:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnnouncementEvent } from "@jinn-network/record-discovery-protocol";
import type { ServingPlaneUnderTest } from "@jinn-network/record-discovery-testing";
import { runServingPlaneConformance } from "@jinn-network/record-discovery-testing";

import { createArchiveHttpHandler } from "./archive-handler.js";
import { createFsBlobStore } from "./fs-blob-store.js";
import { createBoundedReplayRelay } from "./relay.js";
import { withSubscribeAdvertisement } from "./well-known.js";

const DIGEST = "0000000000000000000000000000000000000000000000000000000000000001";

function announcement(id: string): AnnouncementEvent {
  return {
    specversion: "1.0", id, source: "did:key:zAgentSourceOne/feed",
    type: "network.jinn.record-discovery.announcement", subject: `sha256:${DIGEST}`,
    recordkind: "https://jinn.network/records/submission/1.0",
    sourceagent: "did:key:zAgentSourceOne", sourcename: "feed",
    entrydigest: `sha256:${DIGEST}`, announcementid: id,
    data: {} as AnnouncementEvent["data"],
  };
}

const surface: ServingPlaneUnderTest = {
  async route(rawInput) {
    const input = rawInput as {
      path: string; ifNoneMatch?: string; storedEtag?: string; range?: string;
      size?: number; currentPage?: string; sources?: string[];
    };
    const root = await mkdtemp(join(tmpdir(), "jinn-serving-plane-"));
    try {
      const store = createFsBlobStore(root);
      const body = new TextEncoder().encode("0".repeat(input.size ?? 10));
      await store.put("/sources/feed/head", body, "application/vnd.jinn.record-discovery.head.v1+json");
      await store.put(`/records/${DIGEST}`, body, "application/octet-stream");
      await store.put("/sources/feed/entries/0000000000000001", body, "application/json");
      await store.put("/sources/feed/entries/0000000000000002", body, "application/json");

      const handler = createArchiveHttpHandler({
        rootDir: root,
        sources: input.sources ?? ["feed"],
        publicBaseUrl: "https://host",
        ...(input.currentPage === undefined ? {} : { currentPage: async () => input.currentPage }),
      });

      // The vector's If-None-Match is expressed relative to the stored ETag:
      // "matching" means the tag the store actually computed, "stale" means
      // anything else. Re-deriving it here keeps the fixture independent of
      // the digest of whatever filler bytes this adapter chose.
      const probe = await handler(new Request(`https://host${input.path}`));
      const storedEtag = probe.headers.get("etag");
      const ifNoneMatch =
        input.ifNoneMatch === undefined ? undefined
        : input.ifNoneMatch === input.storedEtag ? (storedEtag ?? input.ifNoneMatch)
        : input.ifNoneMatch;

      const response = await handler(new Request(`https://host${input.path}`, {
        headers: {
          ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }),
          ...(input.range === undefined ? {} : { range: input.range }),
        },
      }));
      const text = await response.text();
      const contentType = response.headers.get("content-type");
      const errorCode = contentType === "application/json" && text !== ""
        ? (JSON.parse(text) as { code?: string }).code
        : undefined;

      return {
        status: response.status,
        ...(contentType === null ? {} : { contentType }),
        ...(response.headers.get("cache-control") === null ? {} : { cacheControl: response.headers.get("cache-control")! }),
        ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag")! }),
        ...(response.headers.get("accept-ranges") === null ? {} : { acceptRanges: response.headers.get("accept-ranges")! }),
        ...(response.headers.get("content-range") === null ? {} : { contentRange: response.headers.get("content-range")! }),
        ...(errorCode === undefined ? {} : { errorCode }),
        hasBody: text !== "",
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async subscribe(rawInput) {
    const input = rawInput as {
      cursor?: string | null; lastEventId?: string; replayWindowSize: number; published: number;
    };
    const root = await mkdtemp(join(tmpdir(), "jinn-serving-plane-sse-"));
    try {
      const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize: input.replayWindowSize });
      for (let index = 0; index < input.published; index += 1) relay.publish(announcement(String(index)));

      const handler = createArchiveHttpHandler({
        rootDir: root, sources: ["feed"], publicBaseUrl: "https://host", relays: { feed: relay },
      });
      const query = input.cursor === undefined || input.cursor === null ? "" : `?cursor=${input.cursor}`;
      const response = await handler(new Request(`https://host/sources/feed/subscribe${query}`, {
        headers: input.lastEventId === undefined ? {} : { "last-event-id": input.lastEventId },
      }));

      const reader = response.body!.getReader();
      const first = await reader.read();
      await reader.cancel();
      const frames = new TextDecoder().decode(first.value ?? new Uint8Array()).split("\n\n");
      const terminalFrame = frames.find((frame) => /event: cursor-(unknown|too-old)/u.test(frame));
      const terminal = terminalFrame === undefined ? undefined : (() => {
        const data = JSON.parse(terminalFrame.split("data: ")[1]!) as { code: string; coldSync: { archiveRoot: string; headPath: string } };
        return {
          event: /event: (cursor-[a-z-]+)/u.exec(terminalFrame)![1]!,
          code: data.code,
          namesColdSyncPath: data.coldSync.archiveRoot !== "" && data.coldSync.headPath !== "",
        };
      })();

      return {
        status: response.status,
        contentType: response.headers.get("content-type")!,
        replayedCount: frames.filter((frame) => frame.includes("event: announcement")).length,
        ...(terminal === undefined ? {} : { terminal }),
        closed: terminal !== undefined,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },

  async advertise(rawInput) {
    const input = rawInput as { sourceName: string; replayWindowSize: number; relayId: string };
    const advertised = withSubscribeAdvertisement(
      {
        protocol: "https://jinn.network/record-discovery/1.0",
        sources: [{
          agent: "did:key:zAgentSourceOne", name: input.sourceName,
          headPath: `/sources/${input.sourceName}/head`, archiveRoot: `/sources/${input.sourceName}/entries`,
        }],
      },
      [{
        sourceName: input.sourceName,
        subscribePath: `/sources/${input.sourceName}/subscribe`,
        replayWindow: { relayId: input.relayId, windowSize: input.replayWindowSize, cursorScope: "relay-local" },
      }],
    );
    const entry = advertised.sources[0]!.subscribe!;
    return {
      advertised: true,
      windowSize: entry.replayWindow.windowSize,
      cursorScope: entry.replayWindow.cursorScope,
    };
  },
};

runServingPlaneConformance(surface);
```

- [ ] **Step 2: Run the conformance suite**

```bash
cd packages/discovery/transport-http && yarn vitest run src/serving-plane-conformance.test.ts
```
Expected: PASS, 16 vectors. Any failure here is a real disagreement between the wire profile
and the fixtures — fix the implementation, not the fixture, unless the fixture is
demonstrably wrong about the design, in which case raise it as a finding.

- [ ] **Step 3: Write the loopback round trip**

`src/loopback.test.ts` wires the client transports to the handler through an in-process
`FetchLike`, proving the two halves are one protocol:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fetchHead } from "@jinn-network/record-discovery-client";

import { createArchiveHttpHandler, type ArchiveHttpHandler } from "./archive-handler.js";
import { createFsBlobStore } from "./fs-blob-store.js";
import { createBoundedReplayRelay } from "./relay.js";
import { createHttpTransport } from "./transport.js";
import { createSseStreamTransport } from "./stream-transport.js";
import type { FetchLike } from "./ports.js";

/** An in-process fetch bound straight to the handler -- no listener, no ports, no flake. */
const loopbackFetch = (handler: ArchiveHttpHandler): FetchLike => async (url, init) => {
  const response = await handler(new Request(url, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.body === undefined ? {} : { body: init.body }),
  }));
  return {
    status: response.status,
    headers: response.headers,
    arrayBuffer: () => response.arrayBuffer(),
    body: response.body,
  };
};

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "jinn-loopback-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("client fetches a served head and tails live announcements over SSE", async () => {
  const head = {
    protocol: "https://jinn.network/record-discovery/1.0",
    origin: "did:key:zAgentSourceOne/feed",
    sequence: "0000000000000001",
    entry: `sha256:${"a".repeat(64)}`,
    issuedAt: "2026-07-30T00:00:00.000Z",
    refreshBy: "2026-07-30T12:00:00.000Z",
  };
  await createFsBlobStore(root).put(
    "/sources/feed/head",
    new TextEncoder().encode(JSON.stringify(head)),
    "application/vnd.jinn.record-discovery.head.v1+json",
  );

  const relay = createBoundedReplayRelay({ relayId: "relay-a", windowSize: 10 });
  const handler = createArchiveHttpHandler({
    rootDir: root, sources: ["feed"], publicBaseUrl: "https://host", relays: { feed: relay },
  });
  const fetchLike = loopbackFetch(handler);

  const synced = await fetchHead(
    { agent: "did:key:zAgentSourceOne", name: "feed", servingRoot: "https://host", archiveRootUrl: "https://host/sources/feed/entries/0000000000000001" },
    createHttpTransport("https://host", fetchLike),
  );
  expect(synced.head.sequence).toBe("0000000000000001");

  const received: string[] = [];
  const subscription = createSseStreamTransport("https://host", fetchLike, { scheduleReconnect: () => () => {} })
    .connect("/sources/feed/subscribe", (raw) => received.push(raw), () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  relay.publish({
    specversion: "1.0", id: "ann-1", source: "did:key:zAgentSourceOne/feed",
    type: "network.jinn.record-discovery.announcement", subject: `sha256:${"b".repeat(64)}`,
    recordkind: "https://jinn.network/records/submission/1.0",
    sourceagent: "did:key:zAgentSourceOne", sourcename: "feed",
    entrydigest: `sha256:${"c".repeat(64)}`, announcementid: "ann-1",
    data: {} as never,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  subscription.close();

  expect(received).toHaveLength(1);
  expect(JSON.parse(received[0]!)).toMatchObject({ announcementid: "ann-1" });
});
```

- [ ] **Step 4: Write the README**

`README.md` follows `packages/discovery/serve/README.md`'s shape and must state, in prose:
what the package is (the HTTP transports for the serve/client pair, closing discovery §9.4 per
the composition design §7.3); that it holds no keys, no signer, and no key-loading code; the
four exported factories with a one-line usage each; the Hono mount snippet, which is the whole
integration surface the host needs —

```ts
// In the operator runtime (stage 4 wires this; the package only has to fit).
const archive = createArchiveHttpHandler({
  rootDir: archiveRoot, sources: ["marketplace"], publicBaseUrl,
  relays: { marketplace: relay }, basePath: "/discovery",
});
app.all("/discovery/*", (c) => archive(c.req.raw));
```

— plus the exposure note: only the archive route set is public, source names are an allowlist,
and serving an archive from a residential operator discloses that operator's IP, which is why
the static layout exists for a mirror or static host to serve instead. Close with the
development block (`yarn install --immutable`, `typecheck`, `test`, `build`, `pack:smoke`) and
a pointer to this plan.

- [ ] **Step 5: Run everything**

```bash
cd packages/discovery/transport-http && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../../.. \
  && node --test .github/scripts/record-discovery-package-inventory.test.mjs \
  && node --test .github/scripts/record-discovery-source-boundaries.test.mjs \
  && node --test .github/scripts/record-discovery-packed-types.test.mjs
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/discovery/transport-http
git commit -m "test(discovery): run the serving-plane kit and a loopback round trip"
```

---

## Task 15: The discovery-design dated addendum

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`

**Interfaces:**
- Consumes: the findings recorded at the top of this plan.
- Produces: the design record that closes §9.4, satisfying the composition design's §12
  follow-up 4 and the program's follow-ups registry (§7).

- [ ] **Step 1: Append the addendum**

Insert a new section immediately before `## Appendix: sources`:

```markdown
## Addendum — 2026-07-30: the normative pull-tail HTTP profile

Recorded per the operator-daemon composition program's designs-are-law rule; closes the one
choice §9.4 left open ("one normative HTTP profile fixed at implementation"). Ruled in
`docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` §7 ruling 3 and
implemented in `packages/discovery/transport-http/`
(`docs/superpowers/plans/2026-07-30-discovery-transport-http.md`).

1. **The pull-tail is Server-Sent Events with `Last-Event-ID`.** SSE is the boring standard
   for a server-to-client append-only feed: auto-reconnect and cursor resumption are in the
   format, it is plain HTTP, and it scales statelessly. WebSocket is justified only by
   mid-stream client-to-server messages, and §9.2's filters are set at subscribe time.
2. **The §9.3 cursor contract maps onto SSE as typed terminal events.** No cursor, `oldest`,
   and an in-window cursor all open a `200 text/event-stream` and stream. An unknown-or-future
   cursor emits one `cursor-unknown` event; a cursor older than the bounded window emits one
   `cursor-too-old` event. Both payloads carry `{code: "invalid-reference", detailCode,
   coldSync: {archiveRoot, headPath}}` — naming the cold-sync path, as §9.3 requires — and the
   stream then closes. Terminal conditions are events rather than HTTP statuses because a
   reconnecting consumer's transport port sees frames, not statuses.
3. **Detail-code spelling.** §8's `cursor-unknown` / `cursor-too-old` are authoritative. The
   composition design §7.3's `unknown-cursor` is a transposition of the same code.
4. **The replay window is advertised in the well-known document.** Each source entry may carry
   `subscribe: {sourceName, subscribePath, replayWindow: {relayId, windowSize, cursorScope:
   "relay-local"}}` — an additive field the §7 item 3 schema already admits, satisfying
   §9.3's "bounded and advertised" and "relay cursors declared relay-local" disciplines. The
   transport additionally declares the scope on the wire as an opening SSE comment.
5. **Caching profile for the serving plane (RFC 9110/9111).** `ETag` + `If-None-Match` on the
   Source Head, the one mutable object; `Cache-Control: public, max-age=31536000, immutable`
   on digest-addressed record paths; `Accept-Ranges: bytes` declared on every served object,
   with single-range `206`/`416` handling.
6. **Refinement to §7 item 2's page immutability.** An archive page is immutable only once
   *sealed*. A published source's newest page is re-partitioned as entries accumulate until it
   reaches the §5.1 page ceiling, so it is served `no-cache` with an `ETag`; every earlier page
   is served `immutable`. An implementation that cannot distinguish the two serves all pages
   revalidated. This narrows the caching directive, not the protocol: pages remain
   content-stable once sealed, and cold sync's backward walk is unaffected.
```

- [ ] **Step 2: Verify nothing else in the design moved**

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/marketplace-consumption-boundary-ca5071"
git diff --stat docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md
```
Expected: one file, insertions only, zero deletions. The design's numbered sections are
unchanged — the addendum is additive, per the designs-are-law rule.

- [ ] **Step 3: Run the discovery CI guards one final time**

```bash
node --test .github/scripts/record-discovery-package-inventory.test.mjs \
  && node --test .github/scripts/record-discovery-source-boundaries.test.mjs \
  && node --test .github/scripts/record-discovery-packed-types.test.mjs
(cd packages/discovery/testing && yarn test) && (cd packages/discovery/transport-http && yarn test)
```
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md
git commit -m "docs(discovery): record the SSE pull-tail addendum closing design §9.4"
```

---

## Completion checklist

- [ ] All 15 tasks committed on the `transport-http` train into `integration/evidence-v1`.
- [ ] `packages/discovery/transport-http`: `yarn typecheck`, `yarn test`, `yarn build`,
      `yarn pack:smoke` green, outputs shown.
- [ ] `packages/discovery/testing`: `yarn typecheck`, `yarn test`, `yarn build`,
      `yarn pack:smoke` green (the kit gained a vector kind, 16 vectors, and one suite).
- [ ] Guard trio green: package inventory, source boundaries (including the ambient-network
      scan over the new production source and the type-only-client rule), packed-types.
- [ ] `record-discovery-ci.yml` runs the `transport-http` job.
- [ ] The addendum landed and the program's follow-up 4 can be marked done.
- [ ] Findings 1–8 and the kit-ownership note confirmed by the coordinator, or their
      dispositions revised and the affected tasks re-run.
