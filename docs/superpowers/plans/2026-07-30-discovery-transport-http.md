# Discovery Transport HTTP — `packages/discovery/transport-http/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to execute this plan. Do not implement from
> the design documents alone; the tasks below are the unit of work, in order.

**Goal:** build the third tier-3 adapter tree of the operator-daemon composition program —
`packages/discovery/transport-http/`, npm name `@jinn-network/record-discovery-transport-http`
— supplying every production plug the record-discovery serve/client pair leaves as an
injected port: a filesystem `BlobStore`, an HTTP handler over `serve`'s static layout, and
client-side `Transport` / `StreamTransport` / ping implementations, all under the §7.3 wire
profile (ETag head, immutable digest paths, declared `Accept-Ranges`, SSE tail with
`Last-Event-ID`).

**Architecture:** the package is an adapter shell with no protocol logic of its own —
`serve` writes the static layout into the filesystem blob store, the handler reads that same
layout back out over HTTP under a path grammar that admits exactly five shapes, and the
client transports fetch it back. The handler is a plain `(Request) => Promise<Response>`
function the operator API server mounts under one Hono route; it resolves every request
against the blob store's root and the layout grammar, so it can serve the public archive
subtree and nothing else. The subscribe tail is Server-Sent Events with `Last-Event-ID`
carrying a relay-local cursor, and the five-case cursor contract lands as typed terminal SSE
events followed by stream close.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 standalone project with `portal:`
resolutions; `node:fs/promises` for the blob store; the Node 22 global `fetch` (undici) plus
`Response.body` (`ReadableStream<Uint8Array>`) and a hand-rolled SSE frame parser for the
client transports; web `Request`/`Response`/`ReadableStream` for the handler; Hono (dev only)
for the mount-contract test; vitest; the `@jinn-network/record-discovery-testing` conformance
kit.

---

## Global constraints

Copied verbatim from
[`2026-07-30-operator-daemon-composition-program.md`](./2026-07-30-operator-daemon-composition-program.md)
§Global constraints:

- Branch target: `integration/evidence-v1` (stacked PR trains; the integration branch is
  not yet in `next`). Nothing here publishes to npm — #2293 runs in parallel.
- Kits and fixtures **before** implementations; a layer's kit green before dependents build.
- Guard trio (package inventory, source-boundary, packed-types + CI workflow) ships **with**
  each new tree, not after.
- Every task ends with typecheck + tests + relevant kit + guards run locally, outputs shown.
- Independent per-component review when a component completes, findings resolved before
  dependents build on it (program discipline, principles §13.2).
- American English throughout; no product names in tier-3 code.
- The spec's §6.1 placement notes and §10 bridge-era/drain/standing rules are binding
  cross-plan contracts (§6 below).

Plan-local constraints, binding on every task here:

- **Package name is settled** (program §5): `@jinn-network/record-discovery-transport-http`,
  directory `packages/discovery/transport-http`. Exported factory names are settled too and
  MUST NOT drift: `createFsBlobStore(rootDir)`, `createArchiveHttpHandler(opts)`,
  `createHttpTransport(baseUrl, fetchLike)`, `createSseStreamTransport(baseUrl, fetchLike)`.
- **Kits precede implementations.** Where
  `@jinn-network/record-discovery-testing` already ships a contract suite covering a surface
  (`runSubscribeConformance` for the five cursor cases, `runConsumerConformance` for the
  hostile-locator guards), this package drives that suite rather than restating the cases.
- **Guard trio ships with the tree** — Tasks 1–3, before any implementation code.
- **No daemon wiring here.** This package exports a handler and three transports; mounting
  them on the operator API server, choosing a bind host, and writing operator-facing
  exposure copy are stage 1 and stage 4 work (program §1).
- **Cross-plan contract 7 (archive exposure scoping)** is discharged *in the handler's
  contract*: the handler can only ever answer the five archive-layout shapes, and returns 404
  for everything else, so a host that mounts it cannot leak a sibling route through it. The
  bind decision itself stays host-owned.
- **Additive only against the discovery tree.** This plan does not edit `protocol`, `serve`,
  or `client` source. The replay-window advertisement rides the well-known document's
  additive-unknown-fields rule (design §15); see Finding F3.

---

## Findings (surfaced, not silently resolved)

Record these in the component-review thread when the tree completes. Each has a proposed
disposition that the tasks below implement; none is a silent resolution.

**F1 — the ambient-network guard bans exactly what this package exists to do.**
`.github/scripts/record-discovery-source-boundaries.test.mjs` asserts that *every* discovery
package's production source contains no `fetch` / `WebSocket` / `EventSource` /
`XMLHttpRequest` identifier. `transport-http` is the adapter that supplies those ports, so it
cannot satisfy that rule. *Proposed disposition (implemented in Task 2):* carve out
`transport-http` from the ban and replace it with a **tighter** rule — ambient network APIs
are permitted only in an explicit three-file allowlist inside `transport-http/src`, and a
positive assertion keeps every other discovery package (and every other file in this one)
under the original ban.

**F2 — §7.3 says `Cache-Control: immutable` on archive pages, but the newest page is
mutable in practice.** `serve`'s `writeArchivePages` re-partitions the whole entry list on
every append, so the last page's bytes change whenever the source appends. Marking it
`immutable` tells caches never to revalidate, which would freeze a consumer's cold-sync
entry point at whatever the tail looked like when it was first fetched. *Proposed
disposition (implemented in Task 6):* honor §7.3 for pages that are sealed — a page is
sealed once a successor page exists — and serve the newest page with `ETag` +
`Cache-Control: no-cache`. The handler takes an injected `isSealedPage` predicate so the
host (which owns the page list) decides, and defaults to "no page is sealed" (safe). If the
operator prefers §7.3 read literally, the change is one predicate.

**F3 — the replay-window advertisement has no typed home.** §7.3 requires each source to
advertise its bounded replay window in the well-known discovery document, but
`serve`'s `WellKnownSourceEntry` has no such field. Its zod schema is a `z.looseObject`, and
design §15 makes unknown fields additive, so the field validates today. *Proposed
disposition (implemented in Task 9):* `transport-http` owns the advertisement type and
decorates the document; promoting `replayWindow` into `serve`'s typed `WellKnownSourceEntry`
is a one-field follow-up to file if a second producer needs it.

**F4 — "ping" is grouped with the client-side plugs in spec §6.2, but the only ping port in
code is producer-side.** `serve`'s `PingTransport.announce(headUrl)` is the emitting side;
the consuming side's obligation (pull-rate debounce) is already implemented in `client`
(`createPullDebounce`). *Proposed disposition (implemented in Task 12):* implement the
producer-side `PingTransport` over HTTP and nothing else; receiving pings is a host loop, not
a transport.

**F5 — the handler serves `serve`'s layout, and `serve` never writes a tail.** The SSE tail
is not a static-layout object; it needs a live in-process feed. *Proposed disposition
(implemented in Tasks 7–8):* the handler takes an optional injected `ArchiveTailSource`
port; when absent the tail path answers 404, which is exactly right for a static mirror
(design §7's "hosting a source costs a static file host"). The host's projector loop feeds
`createInMemoryTailSource`.

---

## What this plan does NOT do

- **No daemon or API-server wiring.** The handler is exported; mounting it on
  `client/src/api/server.ts`, deciding the bind host, and the operator-app exposure surface
  are cutover stage 1 (blob store) and stage 4 (HTTP surface).
- **No public exposure decisions.** Localhost-vs-public bind, the separate-bind option, and
  the IP-disclosure copy are host-owned (spec §6.2, program contract 7).
- **No npm publish.** #2293 runs in parallel; `pack:smoke` and packed-types are build checks,
  not a release.
- **No protocol changes.** No new record kinds, no new identifiers, no edits to `protocol`,
  `serve`, or `client` source.

---

## Task 1 — Package scaffold and inventory guard

**Files**

- Create: `packages/discovery/transport-http/package.json`
- Create: `packages/discovery/transport-http/tsconfig.json`
- Create: `packages/discovery/transport-http/tsconfig.build.json`
- Create: `packages/discovery/transport-http/.yarnrc.yml`
- Create: `packages/discovery/transport-http/README.md`
- Create: `packages/discovery/transport-http/scripts/build.mjs`
- Create: `packages/discovery/transport-http/scripts/pack-smoke.mjs`
- Create: `packages/discovery/transport-http/src/index.ts`
- Modify: `.github/scripts/record-discovery-package-inventory.test.mjs`
- Test: `.github/scripts/record-discovery-package-inventory.test.mjs` (the guard itself is
  the test)

**Interfaces**

- Consumes: `@jinn-network/record-discovery-protocol` (values),
  `@jinn-network/record-discovery-serve` (types only),
  `@jinn-network/record-discovery-client` (types only).
- Produces: the package manifest under the settled name, and an `src/index.ts` that will
  re-export every public module as later tasks add them.

**Steps**

- [ ] Add the two new rows to the inventory guard — this fails first, because the package
      does not exist yet. In `.github/scripts/record-discovery-package-inventory.test.mjs`,
      append to `DISCOVERY_PACKAGES`:

      ```js
        ['transport-http', '@jinn-network/record-discovery-transport-http'],
      ```

      and append to `JINN_DEPENDENCY_GRAPH`:

      ```js
        // transport-http is the discovery tree's tier-3 adapter package: it
        // implements serve's BlobStore/PingTransport ports and client's
        // Transport/StreamTransport ports, so it is the one package that
        // legitimately depends on BOTH sides of the serve/client boundary.
        // Both edges are `import type` only -- no runtime import crosses them
        // (asserted by the source-boundaries guard) -- but they must be
        // production `dependencies` so the packed .d.ts files resolve for
        // downstream consumers. record-discovery-testing is the dev-only
        // conformance kit; trust-core is the same shadow devDependency +
        // portal resolution every protocol-consuming package in this tree
        // carries (client declares trust-core as a production dependency, so
        // yarn's per-project resolution for this standalone project needs a
        // matching top-level override even though transport-http's own source
        // never imports it).
        ['transport-http', { dependencies: ['@jinn-network/record-discovery-client', '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
      ```

- [ ] Run it and watch it fail:

      ```bash
      node --test .github/scripts/record-discovery-package-inventory.test.mjs
      ```

      Expected failure: `missing package manifest: .../packages/discovery/transport-http/package.json`.

- [ ] Create `packages/discovery/transport-http/package.json`:

      ```json
      {
        "name": "@jinn-network/record-discovery-transport-http",
        "version": "0.1.0",
        "description": "Production HTTP transports for the Jinn Record Discovery Protocol v1: filesystem blob store, static-layout archive handler with an SSE tail, and client-side fetch/SSE/ping transports.",
        "type": "module",
        "packageManager": "yarn@4.13.0",
        "engines": {
          "node": ">=22"
        },
        "license": "MIT",
        "repository": {
          "type": "git",
          "url": "https://github.com/Jinn-Network/mono.git",
          "directory": "packages/discovery/transport-http"
        },
        "main": "./dist/index.js",
        "types": "./dist/index.d.ts",
        "exports": {
          ".": {
            "import": "./dist/index.js",
            "types": "./dist/index.d.ts"
          }
        },
        "files": [
          "dist/",
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
          "@jinn-network/record-discovery-client": "0.1.0",
          "@jinn-network/record-discovery-protocol": "0.1.0",
          "@jinn-network/record-discovery-serve": "0.1.0"
        },
        "devDependencies": {
          "@jinn-network/record-discovery-testing": "0.1.0",
          "@jinn-network/trust-core": "0.1.0",
          "@types/node": "^22.0.0",
          "hono": "^4.12.10",
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

- [ ] Create `packages/discovery/transport-http/tsconfig.json` (identical to `serve`'s, which
      is the tree's convention):

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

- [ ] Create `packages/discovery/transport-http/tsconfig.build.json`:

      ```json
      {
        "extends": "./tsconfig.json",
        "exclude": ["src/**/*.test.ts"]
      }
      ```

- [ ] Create `packages/discovery/transport-http/.yarnrc.yml` with the same single line every
      other discovery package uses (copy `packages/discovery/serve/.yarnrc.yml` verbatim:
      `cat packages/discovery/serve/.yarnrc.yml > packages/discovery/transport-http/.yarnrc.yml`).

- [ ] Create `packages/discovery/transport-http/scripts/build.mjs` — byte-identical to
      `packages/discovery/serve/scripts/build.mjs`
      (`cp packages/discovery/serve/scripts/build.mjs packages/discovery/transport-http/scripts/build.mjs`);
      it is package-root-relative and needs no edits.

- [ ] Create `packages/discovery/transport-http/scripts/pack-smoke.mjs`, modeled on
      `serve`'s but packing the four portal ancestors this package needs:

      ```js
      import { spawn } from "node:child_process";
      import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { dirname, join } from "node:path";
      import { fileURLToPath } from "node:url";

      const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      // Cross-tree portal dependencies (§7.8): transport-http depends on
      // protocol + serve + client; protocol depends on trust-core and client
      // depends on trust-core too, so all four must be packed and file:-mapped
      // for the consumer graph to resolve end-to-end.
      const protocolRoot = join(packageRoot, "..", "protocol");
      const serveRoot = join(packageRoot, "..", "serve");
      const clientRoot = join(packageRoot, "..", "client");
      const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
      const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-record-discovery-transport-http-"));
      const archive = join(temporaryRoot, "record-discovery-transport-http.tgz");
      const protocolArchive = join(temporaryRoot, "record-discovery-protocol.tgz");
      const serveArchive = join(temporaryRoot, "record-discovery-serve.tgz");
      const clientArchive = join(temporaryRoot, "record-discovery-client.tgz");
      const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
      const consumer = join(temporaryRoot, "consumer");

      function run(command, args, options = {}) {
        return new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: "inherit", ...options });
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with ${code}`));
          });
        });
      }

      async function packPortal(root, out) {
        await run("corepack", ["yarn@4.13.0", "install", "--immutable"], { cwd: root });
        await run("corepack", ["yarn@4.13.0", "pack", "--out", out], { cwd: root });
      }

      try {
        await packPortal(trustCoreRoot, trustCoreArchive);
        await packPortal(protocolRoot, protocolArchive);
        await packPortal(serveRoot, serveArchive);
        await packPortal(clientRoot, clientArchive);
        await packPortal(packageRoot, archive);

        await mkdir(consumer);
        await writeFile(
          join(consumer, "package.json"),
          JSON.stringify({
            private: true,
            type: "module",
            dependencies: {
              "@jinn-network/trust-core": `file:${trustCoreArchive}`,
              "@jinn-network/record-discovery-protocol": `file:${protocolArchive}`,
              "@jinn-network/record-discovery-serve": `file:${serveArchive}`,
              "@jinn-network/record-discovery-client": `file:${clientArchive}`,
              "@jinn-network/record-discovery-transport-http": `file:${archive}`,
            },
          }),
        );
        await run(
          "npm",
          ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
          { cwd: consumer },
        );

        const installedRoot = join(
          consumer,
          "node_modules",
          "@jinn-network",
          "record-discovery-transport-http",
        );
        const smokeScript = join(consumer, "smoke.mjs");
        await writeFile(
          smokeScript,
          `
      import { readFile, readdir } from "node:fs/promises";
      import * as transportHttp from "@jinn-network/record-discovery-transport-http";

      if (typeof transportHttp.createFsBlobStore !== "function") throw new Error("createFsBlobStore missing");
      if (typeof transportHttp.createArchiveHttpHandler !== "function") throw new Error("createArchiveHttpHandler missing");
      if (typeof transportHttp.createHttpTransport !== "function") throw new Error("createHttpTransport missing");
      if (typeof transportHttp.createSseStreamTransport !== "function") throw new Error("createSseStreamTransport missing");
      const packageJson = JSON.parse(await readFile(${JSON.stringify(join("PLACEHOLDER", "package.json"))}, "utf8"));
      const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
      const expectedJinnDependencies = [
        "@jinn-network/record-discovery-client",
        "@jinn-network/record-discovery-protocol",
        "@jinn-network/record-discovery-serve",
      ];
      if (jinnDependencies.length !== expectedJinnDependencies.length
          || jinnDependencies.some((name) => !expectedJinnDependencies.includes(name))) {
        throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
      }
      const distFiles = await readdir(${JSON.stringify(join("PLACEHOLDER", "dist"))});
      if (distFiles.some((name) => name.includes(".test."))) throw new Error("test output leaked into dist");
      await readFile(${JSON.stringify(join("PLACEHOLDER", "README.md"))});
      console.log("Installed package imports, dependency boundary, and dist shape verified.");
      `.replaceAll(JSON.stringify("PLACEHOLDER"), () => "").replaceAll("PLACEHOLDER", installedRoot),
        );
        await run(process.execPath, [smokeScript], { cwd: temporaryRoot });
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      ```

      Note the three `JSON.stringify(join("PLACEHOLDER", …))` sites: replace them with
      `JSON.stringify(join(installedRoot, "package.json"))`,
      `JSON.stringify(join(installedRoot, "dist"))`, and
      `JSON.stringify(join(installedRoot, "README.md"))` respectively, exactly as `serve`'s
      script does, and drop the trailing `.replaceAll(...)` chain — it is written here only
      to keep this plan's fenced block from nesting template placeholders.

- [ ] Create `packages/discovery/transport-http/src/index.ts` with the final public surface
      (modules land in later tasks; create the file now with only the lines whose modules
      exist, and append one line per task as instructed):

      ```ts
      // Public surface of @jinn-network/record-discovery-transport-http. The
      // package's `exports` map exposes only "." -- every downstream consumer
      // (the operator runtime's composition root at cutover stages 1 and 4)
      // can only reach these names through this file.

      export * from "./ports.js";
      ```

- [ ] Create `packages/discovery/transport-http/src/ports.ts` with the read-side port and the
      injected-primitive types the rest of the package consumes:

      ```ts
      import type { BlobStore } from "@jinn-network/record-discovery-serve";

      // Injected ports for the HTTP adapter tree. `serve` declares the WRITE
      // side of blob storage (`BlobStore.put`) because writing the static
      // layout is all a source producer does; serving that layout back needs a
      // read side, which is declared here rather than in `serve` (design §7
      // pins the layout's properties, not a read interface, and `serve` must
      // stay free of any serving-side concern).

      /** Reads bytes previously written at a serving-plane path. */
      export interface BlobReader {
        get(path: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
      }

      /** A blob store that both writes (serve's port) and reads (this package's handler). */
      export type ReadWriteBlobStore = BlobStore & BlobReader;

      /**
       * The subset of the Node 22 global `fetch` this package uses, declared as
       * a port so tests can inject a loopback function and so no module has to
       * reach for the global except the three allowlisted transport modules.
       */
      export type FetchLike = (
        url: string,
        init?: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
          signal?: AbortSignal;
        },
      ) => Promise<Response>;
      ```

- [ ] Re-run the guard and watch it pass:

      ```bash
      node --test .github/scripts/record-discovery-package-inventory.test.mjs
      ```

      Expected: `# pass 2`, `# fail 0`.

- [ ] Install and typecheck the new project:

      ```bash
      cd packages/discovery/transport-http && yarn install && yarn typecheck
      ```

      Expected: zero errors; a `yarn.lock` appears in the package directory.

- [ ] Commit:

      ```bash
      git add packages/discovery/transport-http .github/scripts/record-discovery-package-inventory.test.mjs
      git commit -m "chore(transport-http): scaffold the discovery HTTP transport package and its inventory guard"
      ```

---

## Task 2 — Source-boundary guard, with the ambient-network carve-out (Finding F1)

**Files**

- Modify: `.github/scripts/record-discovery-source-boundaries.test.mjs`
- Test: `.github/scripts/record-discovery-source-boundaries.test.mjs`

**Interfaces**

- Consumes: nothing (a static analyzer over `packages/discovery/*/src`).
- Produces: two new assertions —
  `record-discovery-transport-http production source stays within its architecture boundary`
  and
  `record discovery ambient network APIs appear only in transport-http's allowlisted transport modules`.

**Steps**

- [ ] Add the boundary list and the carve-out to the guard. In
      `.github/scripts/record-discovery-source-boundaries.test.mjs`, extend
      `discoveryDirectories` with `'transport-http'`, then add after the
      `SOURCE_EVIDENCE_JOURNAL_FORBIDDEN_PACKAGES` block:

      ```js
      // transport-http is the tier-3 HTTP adapter: it implements serve's
      // BlobStore/PingTransport ports and client's Transport/StreamTransport
      // ports, so it is the one discovery package allowed to reference BOTH
      // sides of the serve/client boundary -- by `import type` only, which is
      // why neither name appears below. Everything else stays forbidden: no
      // facts/* leaf, no sources/* leaf, no record-kind tree, no trust
      // package (trust-core is a shadow devDependency for yarn's per-project
      // resolution only; this package's source never imports it).
      const TRANSPORT_HTTP_FORBIDDEN_PACKAGES = [
        '@jinn-network/record-discovery-facts-evidence', '@jinn-network/record-discovery-facts-trust',
        '@jinn-network/record-discovery-facts-task-execution',
        '@jinn-network/record-discovery-facts-benchmarking',
        '@jinn-network/record-discovery-source-evidence-journal',
        '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-profiles',
        '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
        '@jinn-network/evidence-protocol', '@jinn-network/evidence-repository', '@jinn-network/evidence-discovery',
        '@jinn-network/marketplace-binding', '@jinn-network/marketplace-projector',
        '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-testing',
      ];

      // Finding F1 (plan docs/superpowers/plans/2026-07-30-discovery-transport-http.md):
      // the ambient-network ban below is what keeps every OTHER discovery
      // package injectable and testable without a network. transport-http is
      // the package that supplies those very ports, so the ban is replaced
      // there with a tighter allowlist: only these three modules may name an
      // ambient network API, and every other file in the tree (including every
      // other file in transport-http) stays under the original ban.
      const AMBIENT_NETWORK_ALLOWED_FILES = new Set([
        'packages/discovery/transport-http/src/fetch-transport.ts',
        'packages/discovery/transport-http/src/sse-transport.ts',
        'packages/discovery/transport-http/src/ping-transport.ts',
      ]);
      ```

- [ ] Replace the body of the existing
      `record discovery production source never uses ambient network APIs` test with the
      allowlist form, and add the boundary test:

      ```js
      test('record-discovery-transport-http production source stays within its architecture boundary', () => {
        assertBoundary(join(packages, 'transport-http', 'src'), TRANSPORT_HTTP_FORBIDDEN_PACKAGES);
      });

      test('record discovery ambient network APIs appear only in transport-http allowlisted transport modules', () => {
        const offenders = [];
        for (const directory of discoveryDirectories) {
          const source = join(packages, directory, 'src');
          if (!existsSync(source)) continue;
          const production = files(source).filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
          for (const finding of ambientNetworkUsesInFiles(production)) {
            const [file] = finding.split(' -> ');
            if (AMBIENT_NETWORK_ALLOWED_FILES.has(file)) continue;
            offenders.push(finding);
          }
        }
        assert.deepEqual(offenders, [],
          'only transport-http\'s allowlisted transport modules may use ambient network APIs '
            + '(fetch/WebSocket/EventSource/XMLHttpRequest); every other discovery module takes them as injected ports');
      });

      test('every ambient-network allowlist entry names a real transport-http module', () => {
        for (const allowed of AMBIENT_NETWORK_ALLOWED_FILES) {
          assert.ok(existsSync(join(root, allowed)),
            `stale ambient-network allowlist entry: ${allowed}`);
        }
      });
      ```

- [ ] Run it and watch the third test fail (the three transport modules do not exist yet):

      ```bash
      node --test .github/scripts/record-discovery-source-boundaries.test.mjs
      ```

      Expected failure:
      `stale ambient-network allowlist entry: packages/discovery/transport-http/src/fetch-transport.ts`.

- [ ] Create the three allowlisted modules as empty, typed placeholders so the guard's
      staleness assertion is honest from the first commit. Each gets its real content in a
      later task; each is created now with exactly this content:

      `packages/discovery/transport-http/src/fetch-transport.ts`:

      ```ts
      // The client-side `Transport` plug (Task 10). One of the three modules
      // the discovery source-boundaries guard allows to name an ambient
      // network API (Finding F1).
      export {};
      ```

      `packages/discovery/transport-http/src/sse-transport.ts`:

      ```ts
      // The client-side `StreamTransport` plug (Task 11). One of the three
      // modules the discovery source-boundaries guard allows to name an
      // ambient network API (Finding F1).
      export {};
      ```

      `packages/discovery/transport-http/src/ping-transport.ts`:

      ```ts
      // The producer-side `PingTransport` plug (Task 12). One of the three
      // modules the discovery source-boundaries guard allows to name an
      // ambient network API (Finding F1).
      export {};
      ```

- [ ] Re-run and watch it pass:

      ```bash
      node --test .github/scripts/record-discovery-source-boundaries.test.mjs
      ```

      Expected: `# fail 0`, with `record-discovery-transport-http production source stays
      within its architecture boundary` and both ambient-network tests reported as passing.

- [ ] Commit:

      ```bash
      git add .github/scripts/record-discovery-source-boundaries.test.mjs packages/discovery/transport-http/src
      git commit -m "chore(transport-http): guard the HTTP adapter boundary and allowlist its ambient-network modules"
      ```

---

## Task 3 — Packed-types canary and CI workflow job

**Files**

- Modify: `.github/scripts/record-discovery-packed-types.test.mjs`
- Modify: `.github/workflows/record-discovery-ci.yml`
- Test: `.github/scripts/record-discovery-packed-types.test.mjs` (executed by the workflow's
  `verify` job)

**Interfaces**

- Consumes: the packed tarballs of every discovery package.
- Produces: a compiled TypeScript consumer importing
  `@jinn-network/record-discovery-transport-http`'s public entrypoint, plus a
  `transport-http` CI job.

**Steps**

- [ ] Add the package to the packed-types canary. In
      `.github/scripts/record-discovery-packed-types.test.mjs`, append to `packages`:

      ```js
        ['transport-http', '@jinn-network/record-discovery-transport-http'],
      ```

      and append to `codeEntrypoints`:

      ```js
        '@jinn-network/record-discovery-transport-http',
      ```

- [ ] Run it and watch it fail (the package has no `dist/` yet):

      ```bash
      node .github/scripts/record-discovery-packed-types.test.mjs
      ```

      Expected failure: `npm pack` succeeds but `tsc` reports
      `Cannot find module '@jinn-network/record-discovery-transport-http'` (no `dist/index.d.ts`
      in the tarball).

- [ ] Build the package so the tarball carries `dist/`:

      ```bash
      cd packages/discovery/transport-http && yarn build
      ```

      Expected: `dist/index.js`, `dist/index.d.ts`, `dist/ports.js`, `dist/ports.d.ts`.

- [ ] Re-run the canary from the repository root and watch it pass:

      ```bash
      node .github/scripts/record-discovery-packed-types.test.mjs
      ```

      Expected final line:
      `Compiled a packed TypeScript consumer against 10 public code entrypoints across all 10 record discovery packages.`

- [ ] Add the CI job. In `.github/workflows/record-discovery-ci.yml`, insert a
      `transport-http` job after the `client` job:

      ```yaml
        transport-http:
          needs: [foundation, testing, serve, client]
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
            - name: Build cross-tree portal dependency from source (trust-core, §7.8)
              run: |
                (cd packages/trust/core && yarn install --immutable && yarn build)
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
            - name: Restore Record Discovery Serve distribution
              uses: actions/download-artifact@v4
              with:
                name: record-discovery-serve-dist
                path: packages/discovery/serve/dist
            - name: Restore Record Discovery Client distribution
              uses: actions/download-artifact@v4
              with:
                name: record-discovery-client-dist
                path: packages/discovery/client/dist
            - name: Install Record Discovery Protocol toolchain (packed-smoke dependency)
              working-directory: packages/discovery/protocol
              run: yarn install --immutable
            - name: Install Record Discovery Testing toolchain (packed-smoke dependency)
              working-directory: packages/discovery/testing
              run: yarn install --immutable
            - name: Install Record Discovery Serve toolchain (packed-smoke dependency)
              working-directory: packages/discovery/serve
              run: yarn install --immutable
            - name: Install Record Discovery Client toolchain (packed-smoke dependency)
              working-directory: packages/discovery/client
              run: yarn install --immutable
            - name: Verify Record Discovery Transport (HTTP)
              working-directory: packages/discovery/transport-http
              run: |
                yarn install --immutable
                yarn typecheck
                yarn test
                yarn build
                yarn pack:smoke
            - name: Upload Record Discovery Transport (HTTP) distribution
              uses: actions/upload-artifact@v4
              with:
                name: record-discovery-transport-http-dist
                path: packages/discovery/transport-http/dist
                if-no-files-found: error
                retention-days: 1
      ```

- [ ] Wire the new job into the `verify` gate in the same file: add `transport-http` to
      `verify.needs`, add
      `TRANSPORT_HTTP_RESULT: ${{ needs.transport-http.result }}` to the `env` block, add
      `"$TRANSPORT_HTTP_RESULT" \` to the `for result in` list, and add
      `[transport-http]=transport-http` to the `declare -A target=( … )` map in the
      `Place package distributions` step.

- [ ] Verify the workflow parses and the job graph is complete:

      ```bash
      node -e "const y=require('node:fs').readFileSync('.github/workflows/record-discovery-ci.yml','utf8'); for (const needle of ['transport-http:','TRANSPORT_HTTP_RESULT','record-discovery-transport-http-dist','[transport-http]=transport-http']) { if (!y.includes(needle)) throw new Error('missing: '+needle); } console.log('workflow wiring present');"
      ```

      Expected: `workflow wiring present`.

- [ ] Commit:

      ```bash
      git add .github/scripts/record-discovery-packed-types.test.mjs .github/workflows/record-discovery-ci.yml
      git commit -m "chore(transport-http): add the packed-types canary entry and the CI job"
      ```

---

## Task 4 — Filesystem blob store (`createFsBlobStore`)

**Files**

- Create: `packages/discovery/transport-http/src/fs-blob-store.ts`
- Create: `packages/discovery/transport-http/src/fs-blob-store.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `BlobStore` from `@jinn-network/record-discovery-serve` (type only);
  `BlobReader`, `ReadWriteBlobStore` from `./ports.js`; `recordPath`, `recordDigest` from
  `@jinn-network/record-discovery-protocol`; `node:fs/promises`, `node:path`, `node:crypto`.
- Produces:
  - `export class ContentAddressedConflictError extends Error` with
    `readonly path: string`.
  - `export class UnsafeBlobPathError extends Error` with `readonly path: string`.
  - `export function createFsBlobStore(rootDir: string): ReadWriteBlobStore`.

**Steps**

- [ ] Write the failing test at
      `packages/discovery/transport-http/src/fs-blob-store.test.ts`:

      ```ts
      import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { afterEach, beforeEach, describe, expect, it } from "vitest";
      import { recordDigest, recordPath, WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";
      import { writeRecord } from "@jinn-network/record-discovery-serve";

      import { ContentAddressedConflictError, UnsafeBlobPathError, createFsBlobStore } from "./fs-blob-store.js";

      const encoder = new TextEncoder();

      describe("createFsBlobStore", () => {
        let root: string;

        beforeEach(async () => {
          root = await mkdtemp(join(tmpdir(), "jinn-fs-blob-store-"));
        });

        afterEach(async () => {
          await rm(root, { recursive: true, force: true });
        });

        it("round-trips bytes and content type at a serving-plane path", async () => {
          const store = createFsBlobStore(root);
          const bytes = encoder.encode('{"protocol":"x"}');
          await store.put(WELL_KNOWN_PATH, bytes, "application/json");

          const read = await store.get(WELL_KNOWN_PATH);
          expect(read).toBeDefined();
          expect(new TextDecoder().decode(read!.bytes)).toBe('{"protocol":"x"}');
          expect(read!.contentType).toBe("application/json");
        });

        it("returns undefined for a path that was never written", async () => {
          const store = createFsBlobStore(root);
          expect(await store.get("/sources/feed/head")).toBeUndefined();
        });

        it("satisfies serve's BlobStore port -- writeRecord lands at the digest path", async () => {
          const store = createFsBlobStore(root);
          const bytes = encoder.encode("sealed-record-bytes");
          const { digest, path } = await writeRecord(store, bytes, "application/json");

          expect(digest).toBe(recordDigest(bytes));
          expect(path).toBe(recordPath(digest));
          const read = await store.get(path);
          expect(new TextDecoder().decode(read!.bytes)).toBe("sealed-record-bytes");
        });

        it("writes atomically -- no temporary file survives a completed put", async () => {
          const store = createFsBlobStore(root);
          await store.put("/sources/feed/entries/0000000000000001", encoder.encode("page"), "application/json");
          const entries = await readdir(join(root, "sources", "feed", "entries"));
          expect(entries).toEqual(["0000000000000001"]);
        });

        it("is idempotent at a digest path for identical bytes", async () => {
          const store = createFsBlobStore(root);
          const bytes = encoder.encode("same-bytes");
          const digest = recordDigest(bytes);
          await store.put(recordPath(digest), bytes, "application/json");
          await store.put(recordPath(digest), bytes, "application/json");
          const read = await store.get(recordPath(digest));
          expect(new TextDecoder().decode(read!.bytes)).toBe("same-bytes");
        });

        it("refuses to overwrite a digest path with different bytes", async () => {
          const store = createFsBlobStore(root);
          const digest = recordDigest(encoder.encode("original"));
          await store.put(recordPath(digest), encoder.encode("original"), "application/json");
          await expect(store.put(recordPath(digest), encoder.encode("tampered"), "application/json"))
            .rejects.toBeInstanceOf(ContentAddressedConflictError);
        });

        it("overwrites the mutable head in place", async () => {
          const store = createFsBlobStore(root);
          await store.put("/sources/feed/head", encoder.encode("head-1"), "application/json");
          await store.put("/sources/feed/head", encoder.encode("head-2"), "application/json");
          const read = await store.get("/sources/feed/head");
          expect(new TextDecoder().decode(read!.bytes)).toBe("head-2");
        });

        it("rejects paths that escape the root", async () => {
          const store = createFsBlobStore(root);
          await expect(store.put("/../escaped", encoder.encode("x"), "text/plain"))
            .rejects.toBeInstanceOf(UnsafeBlobPathError);
          await expect(store.get("/sources/../../escaped")).rejects.toBeInstanceOf(UnsafeBlobPathError);
        });

        it("defaults an unknown content type when the sidecar is absent", async () => {
          const store = createFsBlobStore(root);
          await writeFile(join(root, "orphan"), "bare");
          const read = await store.get("/orphan");
          expect(read!.contentType).toBe("application/octet-stream");
          expect(await readFile(join(root, "orphan"), "utf8")).toBe("bare");
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/fs-blob-store.test.ts
      ```

      Expected failure: `Failed to resolve import "./fs-blob-store.js"`.

- [ ] Write `packages/discovery/transport-http/src/fs-blob-store.ts`:

      ```ts
      import { randomBytes } from "node:crypto";
      import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
      import { dirname, join, resolve, sep } from "node:path";

      import type { BlobStore } from "@jinn-network/record-discovery-serve";

      import type { BlobReader, ReadWriteBlobStore } from "./ports.js";

      // The filesystem BlobStore (spec §6.2). It is the production
      // implementation of BOTH halves of blob storage: `serve`'s write port
      // (BlobStore.put) and this package's read port (BlobReader.get), so a
      // single instance backs the source producer and the HTTP handler over
      // one directory tree. Design §7's serving-root grammar maps onto the
      // filesystem one-to-one: the path is the relative file path, digest
      // paths are immutable and content-addressed, the head is the one file
      // that is rewritten.
      //
      // Every write is temp-file-plus-rename, so a reader (this process's
      // handler, a static host, a mirror's rsync) never observes a partial
      // object. `rename(2)` within one filesystem is atomic; the temporary
      // file is created in the destination's own directory so the rename never
      // crosses a device boundary.

      const CONTENT_TYPE_SUFFIX = ".content-type";
      const DEFAULT_CONTENT_TYPE = "application/octet-stream";
      const DIGEST_PATH_PREFIX = "/records/";

      export class ContentAddressedConflictError extends Error {
        readonly path: string;

        constructor(path: string) {
          super(
            `Refusing to overwrite content-addressed path "${path}" with different bytes: `
              + "a digest path is immutable by construction (design §7 item 1).",
          );
          this.name = "ContentAddressedConflictError";
          this.path = path;
        }
      }

      export class UnsafeBlobPathError extends Error {
        readonly path: string;

        constructor(path: string) {
          super(`Blob path "${path}" resolves outside the store root.`);
          this.name = "UnsafeBlobPathError";
          this.path = path;
        }
      }

      function resolveWithinRoot(rootDir: string, path: string): string {
        const root = resolve(rootDir);
        const resolved = resolve(root, `.${path.startsWith("/") ? path : `/${path}`}`);
        if (resolved !== root && !resolved.startsWith(root + sep)) throw new UnsafeBlobPathError(path);
        return resolved;
      }

      async function readIfPresent(file: string): Promise<Uint8Array | undefined> {
        try {
          return new Uint8Array(await readFile(file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      }

      async function writeAtomically(file: string, bytes: Uint8Array): Promise<void> {
        await mkdir(dirname(file), { recursive: true });
        const temporary = join(dirname(file), `.tmp-${randomBytes(8).toString("hex")}`);
        try {
          await writeFile(temporary, bytes);
          await rename(temporary, file);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      }

      function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
          if (left[index] !== right[index]) return false;
        }
        return true;
      }

      /**
       * Builds the filesystem-backed serving root at `rootDir`. Content types
       * ride beside each object in a `<path>.content-type` sidecar, written
       * before the object itself so an object is never visible without its
       * declared type; the archive path grammar (`paths.ts`) never matches a
       * sidecar, so sidecars are unreachable over HTTP.
       */
      export function createFsBlobStore(rootDir: string): ReadWriteBlobStore {
        const store: BlobStore & BlobReader = {
          async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
            const file = resolveWithinRoot(rootDir, path);
            if (path.startsWith(DIGEST_PATH_PREFIX)) {
              const existing = await readIfPresent(file);
              if (existing !== undefined) {
                if (sameBytes(existing, bytes)) return;
                throw new ContentAddressedConflictError(path);
              }
            }
            await writeAtomically(`${file}${CONTENT_TYPE_SUFFIX}`, new TextEncoder().encode(contentType));
            await writeAtomically(file, bytes);
          },

          async get(path: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
            const file = resolveWithinRoot(rootDir, path);
            const bytes = await readIfPresent(file);
            if (bytes === undefined) return undefined;
            const declared = await readIfPresent(`${file}${CONTENT_TYPE_SUFFIX}`);
            const contentType = declared === undefined
              ? DEFAULT_CONTENT_TYPE
              : new TextDecoder().decode(declared);
            return { bytes, contentType };
          },
        };
        return store;
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/fs-blob-store.test.ts
      ```

      Expected: `Test Files  1 passed (1)`, `Tests  9 passed (9)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./fs-blob-store.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): filesystem blob store with atomic writes and content-addressed immutability"
      ```

---

## Task 5 — Archive path grammar (exposure scoping by construction)

**Files**

- Create: `packages/discovery/transport-http/src/paths.ts`
- Create: `packages/discovery/transport-http/src/paths.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `SOURCE_NAME_GRAMMAR`, `SEQUENCE_WIDTH`, `WELL_KNOWN_PATH`, `headPath`,
  `archivePagePath`, `recordPath` from `@jinn-network/record-discovery-protocol`.
- Produces:
  - `export type ArchiveRoute = { kind: "well-known"; path: string } | { kind: "record"; path: string } | { kind: "head"; sourceName: string; path: string } | { kind: "page"; sourceName: string; page: string; path: string } | { kind: "tail"; sourceName: string }`
  - `export function archiveTailPath(sourceName: string): string`
  - `export function parseArchivePath(pathname: string): ArchiveRoute | undefined`
  - `export function stripBasePath(pathname: string, basePath: string): string | undefined`

**Steps**

- [ ] Write the failing test at `packages/discovery/transport-http/src/paths.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";
      import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

      import { archiveTailPath, parseArchivePath, stripBasePath } from "./paths.js";

      const HEX64 = "a".repeat(64);

      describe("parseArchivePath", () => {
        it("admits the well-known discovery document", () => {
          expect(parseArchivePath(WELL_KNOWN_PATH)).toEqual({ kind: "well-known", path: WELL_KNOWN_PATH });
        });

        it("admits a digest path with a 64-hex name", () => {
          expect(parseArchivePath(`/records/${HEX64}`)).toEqual({ kind: "record", path: `/records/${HEX64}` });
        });

        it("admits a source head and an archive page", () => {
          expect(parseArchivePath("/sources/feed/head")).toEqual({
            kind: "head", sourceName: "feed", path: "/sources/feed/head",
          });
          expect(parseArchivePath("/sources/feed/entries/0000000000000042")).toEqual({
            kind: "page", sourceName: "feed", page: "0000000000000042", path: "/sources/feed/entries/0000000000000042",
          });
        });

        it("admits the tail endpoint", () => {
          expect(archiveTailPath("feed")).toBe("/sources/feed/tail");
          expect(parseArchivePath("/sources/feed/tail")).toEqual({ kind: "tail", sourceName: "feed" });
        });

        it("refuses everything outside the five shapes", () => {
          for (const pathname of [
            "/",
            "/v1/status",
            "/artifacts/search",
            "/records",
            `/records/${HEX64}/extra`,
            `/records/${"z".repeat(64)}`,
            `/records/${HEX64}.content-type`,
            "/sources/feed",
            "/sources/feed/head.content-type",
            "/sources/FEED/head",
            "/sources/-bad-/head",
            "/sources/feed/entries/42",
            "/sources/feed/entries/00000000000000042",
            "/sources/feed/entries/000000000000004a",
            "/sources/../../etc/passwd",
            "/sources/feed/../../v1/status",
            "//sources/feed/head",
          ]) {
            expect(parseArchivePath(pathname), pathname).toBeUndefined();
          }
        });
      });

      describe("stripBasePath", () => {
        it("returns the remainder for a path under the mount", () => {
          expect(stripBasePath("/archive/sources/feed/head", "/archive")).toBe("/sources/feed/head");
          expect(stripBasePath("/archive", "/archive")).toBe("/");
        });

        it("returns the path unchanged when the mount is the origin root", () => {
          expect(stripBasePath("/sources/feed/head", "")).toBe("/sources/feed/head");
        });

        it("returns undefined for a path outside the mount", () => {
          expect(stripBasePath("/v1/status", "/archive")).toBeUndefined();
          expect(stripBasePath("/archiver/sources/feed/head", "/archive")).toBeUndefined();
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/paths.test.ts
      ```

      Expected failure: `Failed to resolve import "./paths.js"`.

- [ ] Write `packages/discovery/transport-http/src/paths.ts`:

      ```ts
      import { SEQUENCE_WIDTH, SOURCE_NAME_GRAMMAR, WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

      // The archive path grammar, and the whole of this package's answer to
      // cross-plan contract 7 (archive exposure scoping): the handler routes
      // ONLY what `parseArchivePath` admits, and `parseArchivePath` admits
      // exactly five shapes -- the well-known document, a digest path, a
      // source head, an archive page, and the SSE tail. Everything else is
      // `undefined`, which the handler answers 404. A host that mounts the
      // handler therefore cannot leak a sibling route through it, whatever it
      // mounts alongside: the grammar is closed, not a denylist.
      //
      // The shapes mirror `record-discovery-protocol`'s own path helpers
      // (`recordPath`, `headPath`, `archivePagePath`, `WELL_KNOWN_PATH`) --
      // design §7's "derivable from the digest alone, one digest one path, no
      // query parameters required".

      const RECORD_PREFIX = "/records/";
      const SOURCES_PREFIX = "/sources/";
      const HEAD_SUFFIX = "/head";
      const ENTRIES_SEGMENT = "/entries/";
      const TAIL_SUFFIX = "/tail";

      const DIGEST_NAME = /^[0-9a-f]{64}$/;
      const PAGE_NAME = new RegExp(`^[0-9]{${SEQUENCE_WIDTH}}$`);

      export type ArchiveRoute =
        | { kind: "well-known"; path: string }
        | { kind: "record"; path: string }
        | { kind: "head"; sourceName: string; path: string }
        | { kind: "page"; sourceName: string; page: string; path: string }
        | { kind: "tail"; sourceName: string };

      /** The SSE tail endpoint for one source. Not a static-layout object -- see Finding F5. */
      export function archiveTailPath(sourceName: string): string {
        return `${SOURCES_PREFIX}${sourceName}${TAIL_SUFFIX}`;
      }

      /**
       * Removes `basePath` from `pathname`, returning the archive-relative
       * remainder, or `undefined` when `pathname` does not lie under the
       * mount. `basePath` is `""` when the handler is mounted at the origin
       * root.
       */
      export function stripBasePath(pathname: string, basePath: string): string | undefined {
        if (basePath === "") return pathname;
        if (pathname === basePath) return "/";
        if (!pathname.startsWith(`${basePath}/`)) return undefined;
        return pathname.slice(basePath.length);
      }

      /** Classifies an archive-relative path, or `undefined` when it is not one of the five admitted shapes. */
      export function parseArchivePath(pathname: string): ArchiveRoute | undefined {
        if (!pathname.startsWith("/")) return undefined;
        if (pathname.includes("//") || pathname.includes("\\")) return undefined;
        if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return undefined;

        if (pathname === WELL_KNOWN_PATH) return { kind: "well-known", path: pathname };

        if (pathname.startsWith(RECORD_PREFIX)) {
          const name = pathname.slice(RECORD_PREFIX.length);
          return DIGEST_NAME.test(name) ? { kind: "record", path: pathname } : undefined;
        }

        if (!pathname.startsWith(SOURCES_PREFIX)) return undefined;
        const remainder = pathname.slice(SOURCES_PREFIX.length);

        const headIndex = remainder.indexOf(HEAD_SUFFIX);
        if (headIndex > 0 && headIndex + HEAD_SUFFIX.length === remainder.length) {
          const sourceName = remainder.slice(0, headIndex);
          return SOURCE_NAME_GRAMMAR.test(sourceName)
            ? { kind: "head", sourceName, path: pathname }
            : undefined;
        }

        const tailIndex = remainder.indexOf(TAIL_SUFFIX);
        if (tailIndex > 0 && tailIndex + TAIL_SUFFIX.length === remainder.length) {
          const sourceName = remainder.slice(0, tailIndex);
          return SOURCE_NAME_GRAMMAR.test(sourceName) ? { kind: "tail", sourceName } : undefined;
        }

        const entriesIndex = remainder.indexOf(ENTRIES_SEGMENT);
        if (entriesIndex > 0) {
          const sourceName = remainder.slice(0, entriesIndex);
          const page = remainder.slice(entriesIndex + ENTRIES_SEGMENT.length);
          return SOURCE_NAME_GRAMMAR.test(sourceName) && PAGE_NAME.test(page)
            ? { kind: "page", sourceName, page, path: pathname }
            : undefined;
        }

        return undefined;
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/paths.test.ts
      ```

      Expected: `Tests  7 passed (7)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./paths.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): closed archive path grammar that scopes the public subtree by construction"
      ```

---

## Task 6 — Static archive handler (ETag head, immutable digest paths, Range)

**Files**

- Create: `packages/discovery/transport-http/src/handler.ts`
- Create: `packages/discovery/transport-http/src/handler.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `BlobReader`, `FetchLike` from `./ports.js`; `parseArchivePath`,
  `stripBasePath`, `ArchiveRoute` from `./paths.js`; `sha256Hex` from
  `@jinn-network/record-discovery-protocol`.
- Produces:
  - `export type ArchiveHttpHandler = (request: Request) => Promise<Response>`
  - `export interface ArchiveHttpHandlerOptions { reader: BlobReader; basePath?: string; tail?: ArchiveTailSource; isSealedPage?(sourceName: string, page: string): boolean }`
    (the `tail` field is declared here and wired in Task 8; import its type from `./tail.js`
    once Task 7 lands — until then declare the option as `tail?: never` is **not**
    acceptable; do Task 7 first if executing out of order.)
  - `export function createArchiveHttpHandler(options: ArchiveHttpHandlerOptions): ArchiveHttpHandler`
  - `export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"`
  - `export const REVALIDATE_CACHE_CONTROL = "no-cache"`
  - `export function computeEtag(bytes: Uint8Array): string`

**Steps**

- [ ] Write the failing test at `packages/discovery/transport-http/src/handler.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";
      import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

      import type { BlobReader } from "./ports.js";
      import { IMMUTABLE_CACHE_CONTROL, REVALIDATE_CACHE_CONTROL, computeEtag, createArchiveHttpHandler } from "./handler.js";

      const HEX64 = "b".repeat(64);
      const encoder = new TextEncoder();

      function readerOf(entries: Record<string, { bytes: Uint8Array; contentType: string }>): BlobReader {
        return { async get(path) { return entries[path]; } };
      }

      const HEAD_BYTES = encoder.encode('{"origin":"did:key:zA/feed","sequence":"0000000000000002"}');
      const PAGE_BYTES = encoder.encode('{"page":"0000000000000001"}');
      const RECORD_BYTES = encoder.encode("sealed-record-bytes");

      function fixtureHandler(options: { basePath?: string; sealed?: boolean } = {}) {
        return createArchiveHttpHandler({
          reader: readerOf({
            [WELL_KNOWN_PATH]: { bytes: encoder.encode('{"protocol":"x","sources":[]}'), contentType: "application/json" },
            "/sources/feed/head": { bytes: HEAD_BYTES, contentType: "application/json" },
            "/sources/feed/entries/0000000000000001": { bytes: PAGE_BYTES, contentType: "application/json" },
            [`/records/${HEX64}`]: { bytes: RECORD_BYTES, contentType: "application/json" },
          }),
          ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
          ...(options.sealed === undefined ? {} : { isSealedPage: () => options.sealed! }),
        });
      }

      describe("createArchiveHttpHandler", () => {
        it("serves the head with an ETag and a revalidating cache directive", async () => {
          const response = await fixtureHandler()(new Request("http://host/sources/feed/head"));
          expect(response.status).toBe(200);
          expect(response.headers.get("etag")).toBe(computeEtag(HEAD_BYTES));
          expect(response.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(HEAD_BYTES);
        });

        it("answers 304 when If-None-Match matches the head", async () => {
          const handler = fixtureHandler();
          const response = await handler(new Request("http://host/sources/feed/head", {
            headers: { "if-none-match": computeEtag(HEAD_BYTES) },
          }));
          expect(response.status).toBe(304);
          expect(response.headers.get("etag")).toBe(computeEtag(HEAD_BYTES));
          expect(await response.text()).toBe("");
        });

        it("answers 200 when If-None-Match is stale", async () => {
          const response = await fixtureHandler()(new Request("http://host/sources/feed/head", {
            headers: { "if-none-match": '"sha256-stale"' },
          }));
          expect(response.status).toBe(200);
        });

        it("marks digest paths immutable and declares byte ranges", async () => {
          const response = await fixtureHandler()(new Request(`http://host/records/${HEX64}`));
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
          expect(response.headers.get("accept-ranges")).toBe("bytes");
        });

        it("honors a single byte range on a digest path", async () => {
          const response = await fixtureHandler()(new Request(`http://host/records/${HEX64}`, {
            headers: { range: "bytes=0-5" },
          }));
          expect(response.status).toBe(206);
          expect(response.headers.get("content-range")).toBe(`bytes 0-5/${RECORD_BYTES.length}`);
          expect(await response.text()).toBe("sealed");
        });

        it("answers 416 for an unsatisfiable range", async () => {
          const response = await fixtureHandler()(new Request(`http://host/records/${HEX64}`, {
            headers: { range: "bytes=9000-9001" },
          }));
          expect(response.status).toBe(416);
          expect(response.headers.get("content-range")).toBe(`bytes */${RECORD_BYTES.length}`);
        });

        it("marks a sealed archive page immutable and a still-growing page revalidating (Finding F2)", async () => {
          const sealed = await fixtureHandler({ sealed: true })(new Request("http://host/sources/feed/entries/0000000000000001"));
          expect(sealed.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);

          const growing = await fixtureHandler()(new Request("http://host/sources/feed/entries/0000000000000001"));
          expect(growing.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
          expect(growing.headers.get("etag")).toBe(computeEtag(PAGE_BYTES));
        });

        it("serves nothing outside the archive subtree", async () => {
          const handler = fixtureHandler();
          for (const url of [
            "http://host/",
            "http://host/v1/status",
            "http://host/artifacts/search?tags=a",
            `http://host/records/${HEX64}.content-type`,
            "http://host/sources/feed/head.content-type",
            "http://host/sources/feed/entries/0000000000000001/../../../v1/status",
          ]) {
            const response = await handler(new Request(url));
            expect(response.status, url).toBe(404);
          }
        });

        it("answers 404 for an admitted path with no stored object", async () => {
          const response = await fixtureHandler()(new Request("http://host/sources/other/head"));
          expect(response.status).toBe(404);
        });

        it("strips the mount prefix and refuses paths outside it", async () => {
          const handler = fixtureHandler({ basePath: "/v1/archive" });
          expect((await handler(new Request("http://host/v1/archive/sources/feed/head"))).status).toBe(200);
          expect((await handler(new Request("http://host/sources/feed/head"))).status).toBe(404);
          expect((await handler(new Request("http://host/v1/archiver/sources/feed/head"))).status).toBe(404);
        });

        it("answers HEAD without a body and rejects other methods", async () => {
          const handler = fixtureHandler();
          const head = await handler(new Request("http://host/sources/feed/head", { method: "HEAD" }));
          expect(head.status).toBe(200);
          expect(await head.text()).toBe("");
          expect(head.headers.get("content-length")).toBe(String(HEAD_BYTES.length));

          const post = await handler(new Request("http://host/sources/feed/head", { method: "POST" }));
          expect(post.status).toBe(405);
          expect(post.headers.get("allow")).toBe("GET, HEAD");
        });

        it("answers 404 on the tail path when no tail source is injected", async () => {
          const response = await fixtureHandler()(new Request("http://host/sources/feed/tail"));
          expect(response.status).toBe(404);
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/handler.test.ts
      ```

      Expected failure: `Failed to resolve import "./handler.js"`.

- [ ] Write `packages/discovery/transport-http/src/handler.ts`. (Execute Task 7 first if
      building strictly in file order — `handler.ts` imports `ArchiveTailSource` from
      `./tail.js`; the tail *branch* body lands in Task 8, and until then the branch answers
      404 exactly as this test requires.)

      ```ts
      import { sha256Hex } from "@jinn-network/record-discovery-protocol";

      import type { BlobReader } from "./ports.js";
      import type { ArchiveTailSource } from "./tail.js";
      import type { ArchiveRoute } from "./paths.js";
      import { parseArchivePath, stripBasePath } from "./paths.js";

      // The HTTP handler over `serve`'s static layout (spec §6.2), under the
      // §7.3 wire profile:
      //   - ETag / If-None-Match conditional GET on the head, the only mutable
      //     object in the layout;
      //   - `Cache-Control: immutable` on digest paths and on SEALED archive
      //     pages (Finding F2: `serve`'s pager rewrites the newest page on
      //     every append, so that one page gets ETag + no-cache instead);
      //   - declared `Accept-Ranges: bytes` on blobs, with single-range GET
      //     actually honored -- a declared range that 200s the whole body is a
      //     lie to every mirror and CDN in the path.
      //
      // The handler is a plain fetch-style function so the host can mount it
      // under one Hono route (`app.all(base + "/*", (c) => handler(c.req.raw))`)
      // without this package depending on Hono. It routes ONLY what
      // `parseArchivePath` admits (see paths.ts) -- cross-plan contract 7.

      export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
      export const REVALIDATE_CACHE_CONTROL = "no-cache";

      export type ArchiveHttpHandler = (request: Request) => Promise<Response>;

      export interface ArchiveHttpHandlerOptions {
        /** The read side of the same store `serve` writes the layout into. */
        reader: BlobReader;
        /** Mount prefix stripped before grammar matching; "" (default) when mounted at the origin root. */
        basePath?: string;
        /** Live tail feed; absent means this deployment serves static files only and the tail path 404s. */
        tail?: ArchiveTailSource;
        /** Whether an archive page is sealed (a successor page exists) and may be marked immutable. Defaults to "no page is sealed". */
        isSealedPage?(sourceName: string, page: string): boolean;
      }

      /** Strong entity tag over the exact served bytes. */
      export function computeEtag(bytes: Uint8Array): string {
        return `"sha256-${sha256Hex(bytes)}"`;
      }

      function notFound(): Response {
        return new Response(null, { status: 404 });
      }

      function parseSingleRange(header: string, length: number): { start: number; end: number } | "unsatisfiable" | undefined {
        const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
        if (match === null) return undefined;
        const [, rawStart, rawEnd] = match;
        if (rawStart === "" && rawEnd === "") return undefined;
        if (rawStart === "") {
          const suffix = Number(rawEnd);
          if (suffix === 0) return "unsatisfiable";
          const start = Math.max(0, length - suffix);
          return { start, end: length - 1 };
        }
        const start = Number(rawStart);
        const end = rawEnd === "" ? length - 1 : Number(rawEnd);
        if (start > end || start >= length) return "unsatisfiable";
        return { start, end: Math.min(end, length - 1) };
      }

      function cachePolicy(route: ArchiveRoute, options: ArchiveHttpHandlerOptions): string {
        if (route.kind === "record") return IMMUTABLE_CACHE_CONTROL;
        if (route.kind === "page") {
          const sealed = options.isSealedPage?.(route.sourceName, route.page) ?? false;
          return sealed ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
        }
        return REVALIDATE_CACHE_CONTROL;
      }

      export function createArchiveHttpHandler(options: ArchiveHttpHandlerOptions): ArchiveHttpHandler {
        const basePath = options.basePath ?? "";

        return async function handle(request: Request): Promise<Response> {
          const url = new URL(request.url);
          const relative = stripBasePath(url.pathname, basePath);
          if (relative === undefined) return notFound();

          const route = parseArchivePath(relative);
          if (route === undefined) return notFound();

          if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
          }

          if (route.kind === "tail") {
            if (options.tail === undefined) return notFound();
            return openTailStream(request, route.sourceName, options.tail);
          }

          const object = await options.reader.get(route.path);
          if (object === undefined) return notFound();

          const etag = computeEtag(object.bytes);
          const headers = new Headers({
            "content-type": object.contentType,
            "cache-control": cachePolicy(route, options),
            etag,
          });
          if (route.kind === "record" || route.kind === "page") headers.set("accept-ranges", "bytes");

          const ifNoneMatch = request.headers.get("if-none-match");
          if (ifNoneMatch !== null && ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag)) {
            return new Response(null, { status: 304, headers });
          }

          const rangeHeader = request.headers.get("range");
          if (rangeHeader !== null && (route.kind === "record" || route.kind === "page")) {
            const range = parseSingleRange(rangeHeader, object.bytes.length);
            if (range === "unsatisfiable") {
              headers.set("content-range", `bytes */${object.bytes.length}`);
              return new Response(null, { status: 416, headers });
            }
            if (range !== undefined) {
              const slice = object.bytes.slice(range.start, range.end + 1);
              headers.set("content-range", `bytes ${range.start}-${range.end}/${object.bytes.length}`);
              headers.set("content-length", String(slice.length));
              return new Response(request.method === "HEAD" ? null : slice, { status: 206, headers });
            }
          }

          headers.set("content-length", String(object.bytes.length));
          return new Response(request.method === "HEAD" ? null : object.bytes, { status: 200, headers });
        };
      }

      // Wired in Task 8; declared here so the tail branch above compiles and
      // so the "no tail source injected" behavior is fixed from this task on.
      function openTailStream(_request: Request, _sourceName: string, _tail: ArchiveTailSource): Response {
        return notFound();
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/handler.test.ts
      ```

      Expected: `Tests  12 passed (12)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./handler.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): archive HTTP handler with conditional head, immutable digest paths, and honored byte ranges"
      ```

---

## Task 7 — Tail source port, in-memory replay window, and server-side cursor classification

**Files**

- Create: `packages/discovery/transport-http/src/tail.ts`
- Create: `packages/discovery/transport-http/src/tail.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `formatSequence` from `@jinn-network/record-discovery-protocol`;
  `runSubscribeConformance` and `SubscribeClientUnderTest` from
  `@jinn-network/record-discovery-testing` (test only).
- Produces:
  - `export type TailEventType = "announcement" | "observation"`
  - `export interface TailEvent { cursor: string; eventType: TailEventType; data: string }`
  - `export interface ReplayWindowState { capacity: number; size: number; oldestCursor?: string; newestCursor?: string }`
  - `export interface ArchiveTailSource { window(): ReplayWindowState; locate(cursor: string): number | undefined; replayFrom(offset: number): readonly TailEvent[]; subscribe(onEvent: (event: TailEvent) => void): () => void }`
  - `export interface TailPublisher { source: ArchiveTailSource; publish(eventType: TailEventType, data: string): TailEvent }`
  - `export function createInMemoryTailSource(capacity: number): TailPublisher`
  - `export type TailCursorBehavior = "live-tail-from-now" | "typed-error-close" | "replay-then-live" | "cursor-too-old" | "start-of-window"`
  - `export interface TailCursorDecision { behavior: TailCursorBehavior; detailCode?: string; replayFromOffset?: number }`
  - `export function classifyTailCursor(cursor: string | undefined, window: ReplayWindowState, cursorPosition: number | undefined): TailCursorDecision`

**Steps**

- [ ] Write the failing test at `packages/discovery/transport-http/src/tail.test.ts`. It
      drives the shared kit's `runSubscribeConformance` — the five-case cursor contract is
      the kit's, not restated here — plus the in-memory window's own behavior:

      ```ts
      import { describe, expect, it } from "vitest";
      import type { SubscribeClientUnderTest } from "@jinn-network/record-discovery-testing";
      import { runSubscribeConformance } from "@jinn-network/record-discovery-testing";

      import { classifyTailCursor, createInMemoryTailSource } from "./tail.js";

      // The server side of the §9.3 cursor contract answers the same five
      // cases as `client`'s consumer-side `classifyCursor`, so it is driven by
      // the same kit suite. The adapter turns the kit's
      // `(cursor, replayWindowSize, cursorPosition)` triple into this
      // package's `(cursor, window, cursorPosition)` shape.
      const underTest: SubscribeClientUnderTest = {
        async classifyCursor(cursor, replayWindowSize, cursorPosition) {
          return classifyTailCursor(
            cursor,
            { capacity: replayWindowSize, size: replayWindowSize },
            cursorPosition,
          );
        },
      };

      runSubscribeConformance(underTest);

      describe("createInMemoryTailSource", () => {
        it("assigns fixed-width relay-local cursors and advertises a bounded window", () => {
          const tail = createInMemoryTailSource(3);
          expect(tail.source.window()).toEqual({ capacity: 3, size: 0 });

          const first = tail.publish("announcement", '{"id":1}');
          expect(first.cursor).toBe("0000000000000001");
          tail.publish("announcement", '{"id":2}');

          expect(tail.source.window()).toEqual({
            capacity: 3, size: 2, oldestCursor: "0000000000000001", newestCursor: "0000000000000002",
          });
        });

        it("evicts oldest-first at capacity and reports evicted cursors as too old", () => {
          const tail = createInMemoryTailSource(2);
          for (let index = 0; index < 4; index += 1) tail.publish("announcement", `{"id":${index}}`);

          expect(tail.source.window()).toEqual({
            capacity: 2, size: 2, oldestCursor: "0000000000000003", newestCursor: "0000000000000004",
          });
          expect(tail.source.locate("0000000000000001")).toBe(-1);
          expect(tail.source.locate("0000000000000003")).toBe(0);
          expect(tail.source.locate("0000000000000004")).toBe(1);
        });

        it("reports a never-issued or future cursor as unknown", () => {
          const tail = createInMemoryTailSource(5);
          tail.publish("announcement", '{"id":1}');
          expect(tail.source.locate("0000000000000009")).toBeUndefined();
          expect(tail.source.locate("not-a-cursor")).toBeUndefined();
        });

        it("replays from an offset, oldest first", () => {
          const tail = createInMemoryTailSource(5);
          for (let index = 1; index <= 3; index += 1) tail.publish("announcement", `{"id":${index}}`);
          expect(tail.source.replayFrom(1).map((event) => event.data)).toEqual(['{"id":2}', '{"id":3}']);
        });

        it("delivers live events to subscribers until unsubscribed", () => {
          const tail = createInMemoryTailSource(5);
          const seen: string[] = [];
          const unsubscribe = tail.source.subscribe((event) => seen.push(event.data));
          tail.publish("announcement", '{"id":1}');
          unsubscribe();
          tail.publish("announcement", '{"id":2}');
          expect(seen).toEqual(['{"id":1}']);
        });
      });

      describe("classifyTailCursor", () => {
        it("resolves a live window position into a replay offset", () => {
          const decision = classifyTailCursor("0000000000000003", { capacity: 5, size: 5 }, 2);
          expect(decision).toEqual({ behavior: "replay-then-live", replayFromOffset: 3 });
        });

        it("resolves `oldest` to the start of the window", () => {
          expect(classifyTailCursor("oldest", { capacity: 5, size: 5 }, undefined))
            .toEqual({ behavior: "start-of-window", replayFromOffset: 0 });
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/tail.test.ts
      ```

      Expected failure: `Failed to resolve import "./tail.js"`.

- [ ] Write `packages/discovery/transport-http/src/tail.ts`:

      ```ts
      import { formatSequence } from "@jinn-network/record-discovery-protocol";

      // The tail feed behind the SSE endpoint (Finding F5): `serve` writes a
      // static layout and never writes a tail, so a live tail needs an
      // in-process feed the host drives. `ArchiveTailSource` is that port;
      // `createInMemoryTailSource` is the bounded, non-archival relay window
      // design §9.3 requires ("relays are non-archival by design; the replay
      // window is bounded and advertised").
      //
      // Cursors are RELAY-LOCAL and declared as such in the well-known
      // advertisement (advertise.ts): they are a per-process monotone counter
      // rendered in the protocol's fixed-width sequence grammar, never the
      // source chain's own sequence. Data-level ordering always comes from the
      // source chain (§9.3).

      export type TailEventType = "announcement" | "observation";

      export interface TailEvent {
        /** Relay-local cursor; becomes the SSE `id:` field and the client's `Last-Event-ID`. */
        cursor: string;
        eventType: TailEventType;
        /** The CloudEvents structured-JSON payload, already serialized (§9.1). */
        data: string;
      }

      export interface ReplayWindowState {
        capacity: number;
        size: number;
        oldestCursor?: string;
        newestCursor?: string;
      }

      export interface ArchiveTailSource {
        /** The bounded window this relay advertises (§9.3). */
        window(): ReplayWindowState;
        /**
         * The cursor's offset into the current window: `>= 0` when the cursor
         * is buffered, `-1` when it was issued but has since been evicted
         * (older than the window), and `undefined` when it was never issued or
         * lies in the future -- never guessed (§9.3).
         */
        locate(cursor: string): number | undefined;
        /** Buffered events from `offset` (inclusive) to the newest, oldest first. */
        replayFrom(offset: number): readonly TailEvent[];
        /** Subscribes to live events; the returned function unsubscribes. */
        subscribe(onEvent: (event: TailEvent) => void): () => void;
      }

      export interface TailPublisher {
        source: ArchiveTailSource;
        /** Appends one event, assigns the next relay-local cursor, and fans it out to live subscribers. */
        publish(eventType: TailEventType, data: string): TailEvent;
      }

      const CURSOR_GRAMMAR = /^[0-9]{16}$/;

      export function createInMemoryTailSource(capacity: number): TailPublisher {
        if (!Number.isInteger(capacity) || capacity < 1) {
          throw new Error(`createInMemoryTailSource: capacity must be a positive integer, got ${capacity}.`);
        }

        const buffer: TailEvent[] = [];
        const subscribers = new Set<(event: TailEvent) => void>();
        let issued = 0n;

        function cursorNumber(cursor: string): bigint | undefined {
          return CURSOR_GRAMMAR.test(cursor) ? BigInt(cursor) : undefined;
        }

        const source: ArchiveTailSource = {
          window(): ReplayWindowState {
            const oldest = buffer[0];
            const newest = buffer[buffer.length - 1];
            return {
              capacity,
              size: buffer.length,
              ...(oldest === undefined ? {} : { oldestCursor: oldest.cursor }),
              ...(newest === undefined ? {} : { newestCursor: newest.cursor }),
            };
          },

          locate(cursor: string): number | undefined {
            const n = cursorNumber(cursor);
            if (n === undefined) return undefined;
            if (n < 1n || n > issued) return undefined;
            const oldest = buffer[0];
            if (oldest === undefined) return -1;
            const oldestNumber = BigInt(oldest.cursor);
            if (n < oldestNumber) return -1;
            return Number(n - oldestNumber);
          },

          replayFrom(offset: number): readonly TailEvent[] {
            return buffer.slice(Math.max(0, offset));
          },

          subscribe(onEvent: (event: TailEvent) => void): () => void {
            subscribers.add(onEvent);
            return () => {
              subscribers.delete(onEvent);
            };
          },
        };

        return {
          source,
          publish(eventType: TailEventType, data: string): TailEvent {
            issued += 1n;
            const event: TailEvent = { cursor: formatSequence(issued), eventType, data };
            buffer.push(event);
            while (buffer.length > capacity) buffer.shift();
            for (const subscriber of subscribers) subscriber(event);
            return event;
          },
        };
      }

      export type TailCursorBehavior =
        | "live-tail-from-now"
        | "typed-error-close"
        | "replay-then-live"
        | "cursor-too-old"
        | "start-of-window";

      export interface TailCursorDecision {
        behavior: TailCursorBehavior;
        detailCode?: string;
        /** Where the replay begins, when the decision replays at all. */
        replayFromOffset?: number;
      }

      /**
       * The server half of the §9.3 five-case cursor contract, deliberately
       * identical in outcome to `client`'s consumer-side `classifyCursor` (the
       * shared kit's `runSubscribeConformance` drives both). `cursorPosition`
       * is the cursor's offset in the window per `ArchiveTailSource.locate`.
       * A replaying decision resumes AFTER the supplied cursor, per SSE
       * `Last-Event-ID` semantics.
       */
      export function classifyTailCursor(
        cursor: string | undefined,
        window: ReplayWindowState,
        cursorPosition: number | undefined,
      ): TailCursorDecision {
        if (cursor === undefined) return { behavior: "live-tail-from-now" };
        if (cursor === "oldest") return { behavior: "start-of-window", replayFromOffset: 0 };
        if (cursorPosition === undefined) return { behavior: "typed-error-close", detailCode: "cursor-unknown" };
        if (cursorPosition < 0) return { behavior: "cursor-too-old", detailCode: "cursor-too-old" };
        if (cursorPosition < window.capacity) {
          return { behavior: "replay-then-live", replayFromOffset: cursorPosition + 1 };
        }
        return { behavior: "typed-error-close", detailCode: "cursor-unknown" };
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/tail.test.ts
      ```

      Expected: the kit's `subscribe conformance (§9, §18 subscribe vectors)` describe block
      reporting the five cursor cases, plus `Tests  12 passed (12)` overall.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./tail.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): bounded relay tail window and server-side five-case cursor classification"
      ```

---

## Task 8 — SSE tail endpoint with `Last-Event-ID` resume and typed terminal events

**Files**

- Create: `packages/discovery/transport-http/src/sse.ts`
- Create: `packages/discovery/transport-http/src/sse.test.ts`
- Modify: `packages/discovery/transport-http/src/handler.ts`
- Modify: `packages/discovery/transport-http/src/handler.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `ArchiveTailSource`, `TailEvent`, `classifyTailCursor` from `./tail.js`;
  `headPath`, `archivePagePath` from `@jinn-network/record-discovery-protocol`.
- Produces:
  - `export const SSE_CONTENT_TYPE = "text/event-stream"`
  - `export const SSE_RETRY_MS = 3000`
  - `export type SseTerminalEventType = "unknown-cursor" | "cursor-too-old"`
  - `export interface SseColdSyncHint { head: string; archiveRoot: string }`
  - `export function formatSseFrame(frame: { id?: string; event?: string; data: string }): string`
  - `export function encodeSseFrames(...)` — not required; the module exposes only
    `formatSseFrame` and `openArchiveTailStream`.
  - `export function openArchiveTailStream(request: Request, sourceName: string, tail: ArchiveTailSource): Response`

**Steps**

- [ ] Write the failing test at `packages/discovery/transport-http/src/sse.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";

      import { createInMemoryTailSource } from "./tail.js";
      import { SSE_CONTENT_TYPE, formatSseFrame, openArchiveTailStream } from "./sse.js";

      async function drain(response: Response, limitFrames: number): Promise<string[]> {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        const frames: string[] = [];
        while (frames.length < limitFrames) {
          const { value, done } = await reader.read();
          if (value !== undefined) buffered += decoder.decode(value, { stream: true });
          let boundary = buffered.indexOf("\n\n");
          while (boundary !== -1) {
            frames.push(buffered.slice(0, boundary));
            buffered = buffered.slice(boundary + 2);
            boundary = buffered.indexOf("\n\n");
          }
          if (done) break;
        }
        await reader.cancel().catch(() => undefined);
        return frames;
      }

      describe("formatSseFrame", () => {
        it("emits id, event, and multi-line data in wire order", () => {
          expect(formatSseFrame({ id: "0000000000000001", event: "announcement", data: '{"a":1}' }))
            .toBe('id: 0000000000000001\nevent: announcement\ndata: {"a":1}\n\n');
        });

        it("splits an embedded newline into successive data lines", () => {
          expect(formatSseFrame({ event: "note", data: "one\ntwo" })).toBe("event: note\ndata: one\ndata: two\n\n");
        });
      });

      describe("openArchiveTailStream", () => {
        it("declares the SSE content type and a retry hint, then live-tails from now", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"before":true}');

          const response = openArchiveTailStream(new Request("http://host/sources/feed/tail"), "feed", tail.source);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(SSE_CONTENT_TYPE);
          expect(response.headers.get("cache-control")).toBe("no-cache");

          const framesPromise = drain(response, 2);
          tail.publish("announcement", '{"after":true}');
          const frames = await framesPromise;

          expect(frames[0]).toBe("retry: 3000");
          expect(frames[1]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"after":true}');
        });

        it("replays after Last-Event-ID, then continues live", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"n":1}');
          tail.publish("announcement", '{"n":2}');
          tail.publish("announcement", '{"n":3}');

          const response = openArchiveTailStream(
            new Request("http://host/sources/feed/tail", { headers: { "last-event-id": "0000000000000001" } }),
            "feed",
            tail.source,
          );
          const frames = await drain(response, 3);
          expect(frames[1]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"n":2}');
          expect(frames[2]).toBe('id: 0000000000000003\nevent: announcement\ndata: {"n":3}');
        });

        it("prefers Last-Event-ID over the ?cursor query parameter", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"n":1}');
          tail.publish("announcement", '{"n":2}');

          const response = openArchiveTailStream(
            new Request("http://host/sources/feed/tail?cursor=oldest", {
              headers: { "last-event-id": "0000000000000001" },
            }),
            "feed",
            tail.source,
          );
          const frames = await drain(response, 2);
          expect(frames[1]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"n":2}');
        });

        it("emits a typed unknown-cursor terminal event, then closes", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"n":1}');

          const response = openArchiveTailStream(
            new Request("http://host/sources/feed/tail?cursor=0000000000000099"),
            "feed",
            tail.source,
          );
          const frames = await drain(response, 5);
          expect(frames[1]!.startsWith("event: unknown-cursor\n")).toBe(true);
          expect(JSON.parse(frames[1]!.split("data: ")[1]!)).toEqual({ detailCode: "cursor-unknown" });
          expect(frames).toHaveLength(2);
        });

        it("emits a typed cursor-too-old terminal event naming the cold-sync path, then closes", async () => {
          const tail = createInMemoryTailSource(2);
          for (let index = 0; index < 4; index += 1) tail.publish("announcement", `{"n":${index}}`);

          const response = openArchiveTailStream(
            new Request("http://host/sources/feed/tail?cursor=0000000000000001"),
            "feed",
            tail.source,
          );
          const frames = await drain(response, 5);
          expect(frames[1]!.startsWith("event: cursor-too-old\n")).toBe(true);
          expect(JSON.parse(frames[1]!.split("data: ")[1]!)).toEqual({
            detailCode: "cursor-too-old",
            coldSync: { head: "/sources/feed/head", archiveRoot: "/sources/feed/entries/0000000000000001" },
          });
          expect(frames).toHaveLength(2);
        });

        it("starts at the window start for cursor=oldest", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"n":1}');
          tail.publish("announcement", '{"n":2}');

          const response = openArchiveTailStream(
            new Request("http://host/sources/feed/tail?cursor=oldest"),
            "feed",
            tail.source,
          );
          const frames = await drain(response, 3);
          expect(frames[1]).toBe('id: 0000000000000001\nevent: announcement\ndata: {"n":1}');
          expect(frames[2]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"n":2}');
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/sse.test.ts
      ```

      Expected failure: `Failed to resolve import "./sse.js"`.

- [ ] Write `packages/discovery/transport-http/src/sse.ts`:

      ```ts
      import { archivePagePath, headPath } from "@jinn-network/record-discovery-protocol";

      import type { ArchiveTailSource, TailEvent } from "./tail.js";
      import { classifyTailCursor } from "./tail.js";

      // The pull-tail, fixed by the operator-daemon composition design §7.3 as
      // SSE with `Last-Event-ID` carrying the relay cursor -- the boring
      // standard for a server-to-client append-only feed (auto-reconnect,
      // plain HTTP, stateless horizontal scale). WebSocket is justified only
      // by mid-stream client-to-server messages, and discovery's filters are
      // set at subscribe time.
      //
      // The §9.3 five-case cursor contract maps onto SSE as typed TERMINAL
      // events followed by stream close: `unknown-cursor` for the
      // never-issued/future case, `cursor-too-old` for the evicted case, the
      // latter naming the cold-sync path (head + newest archive page) so a
      // consumer never has to guess where to resume. No silent gap-skipping,
      // ever.

      export const SSE_CONTENT_TYPE = "text/event-stream";
      export const SSE_RETRY_MS = 3000;

      export type SseTerminalEventType = "unknown-cursor" | "cursor-too-old";

      export interface SseColdSyncHint {
        head: string;
        archiveRoot: string;
      }

      /** Serializes one SSE frame. Embedded newlines become successive `data:` lines, per the EventSource wire format. */
      export function formatSseFrame(frame: { id?: string; event?: string; data: string }): string {
        const lines: string[] = [];
        if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
        if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
        for (const line of frame.data.split("\n")) lines.push(`data: ${line}`);
        return `${lines.join("\n")}\n\n`;
      }

      function eventFrame(event: TailEvent): string {
        return formatSseFrame({ id: event.cursor, event: event.eventType, data: event.data });
      }

      function coldSyncHint(sourceName: string, tail: ArchiveTailSource): SseColdSyncHint {
        const window = tail.window();
        // The oldest cursor still buffered is the relay's own frontier; the
        // cold-sync entry point is the source's head plus its newest archive
        // page, which the consumer walks backward (design §5.3 rule 3).
        const page = window.oldestCursor ?? "0000000000000001";
        return { head: headPath(sourceName), archiveRoot: archivePagePath(sourceName, page) };
      }

      /**
       * Opens the SSE tail for one source. Resume position comes from the
       * `Last-Event-ID` request header when present (the standard resume
       * channel, honored on the very first request so an explicit resume never
       * needs a prior connection), falling back to the `?cursor=` query
       * parameter.
       */
      export function openArchiveTailStream(
        request: Request,
        sourceName: string,
        tail: ArchiveTailSource,
      ): Response {
        const lastEventId = request.headers.get("last-event-id");
        const queryCursor = new URL(request.url).searchParams.get("cursor");
        const cursor = lastEventId ?? queryCursor ?? undefined;

        const window = tail.window();
        const cursorPosition = cursor === undefined || cursor === "oldest" ? undefined : tail.locate(cursor);
        const decision = classifyTailCursor(cursor, window, cursorPosition);

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | undefined;

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`retry: ${SSE_RETRY_MS}\n\n`));

            if (decision.behavior === "typed-error-close") {
              controller.enqueue(encoder.encode(formatSseFrame({
                event: "unknown-cursor" satisfies SseTerminalEventType,
                data: JSON.stringify({ detailCode: decision.detailCode ?? "cursor-unknown" }),
              })));
              controller.close();
              return;
            }

            if (decision.behavior === "cursor-too-old") {
              controller.enqueue(encoder.encode(formatSseFrame({
                event: "cursor-too-old" satisfies SseTerminalEventType,
                data: JSON.stringify({
                  detailCode: "cursor-too-old",
                  coldSync: coldSyncHint(sourceName, tail),
                }),
              })));
              controller.close();
              return;
            }

            if (decision.replayFromOffset !== undefined) {
              for (const event of tail.replayFrom(decision.replayFromOffset)) {
                controller.enqueue(encoder.encode(eventFrame(event)));
              }
            }

            unsubscribe = tail.subscribe((event) => {
              try {
                controller.enqueue(encoder.encode(eventFrame(event)));
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

        return new Response(body, {
          status: 200,
          headers: {
            "content-type": SSE_CONTENT_TYPE,
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/sse.test.ts
      ```

      Expected: `Tests  9 passed (9)`.

- [ ] Wire it into the handler. In `packages/discovery/transport-http/src/handler.ts`,
      replace the placeholder function with a re-export of the real one:

      ```ts
      import { openArchiveTailStream } from "./sse.js";
      ```

      and delete the local `openTailStream` definition, changing the tail branch to:

      ```ts
          if (route.kind === "tail") {
            if (options.tail === undefined) return notFound();
            return openArchiveTailStream(request, route.sourceName, options.tail);
          }
      ```

- [ ] Add the handler-level tail test. Append to
      `packages/discovery/transport-http/src/handler.test.ts`:

      ```ts
      describe("createArchiveHttpHandler tail routing", () => {
        it("serves the SSE tail when a tail source is injected, and only under the mount", async () => {
          const { createInMemoryTailSource } = await import("./tail.js");
          const tail = createInMemoryTailSource(4);
          const handler = createArchiveHttpHandler({
            reader: readerOf({}),
            basePath: "/v1/archive",
            tail: tail.source,
          });

          const response = await handler(new Request("http://host/v1/archive/sources/feed/tail"));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("text/event-stream");
          await response.body!.cancel();

          expect((await handler(new Request("http://host/sources/feed/tail"))).status).toBe(404);
          expect((await handler(new Request("http://host/v1/archive/sources/FEED/tail"))).status).toBe(404);
        });
      });
      ```

- [ ] Run both suites and watch them pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/sse.test.ts src/handler.test.ts
      ```

      Expected: `Test Files  2 passed (2)`, `Tests  22 passed (22)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./sse.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): SSE tail with Last-Event-ID resume and typed terminal cursor events"
      ```

---

## Task 9 — Advertised replay window in the well-known discovery document (Finding F3)

**Files**

- Create: `packages/discovery/transport-http/src/advertise.ts`
- Create: `packages/discovery/transport-http/src/advertise.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `WellKnownDocument`, `WellKnownSourceEntry`, `parseWellKnownDocument` from
  `@jinn-network/record-discovery-serve`; `ReplayWindowState` from `./tail.js`;
  `archiveTailPath` from `./paths.js`.
- Produces:
  - `export interface ReplayWindowAdvertisement { tailPath: string; cursorScope: "relay-local"; capacity: number }`
  - `export type AdvertisedSourceEntry = WellKnownSourceEntry & { replayWindow: ReplayWindowAdvertisement }`
  - `export function advertiseReplayWindow(sourceName: string, window: ReplayWindowState): ReplayWindowAdvertisement`
  - `export function withReplayWindowAdvertisements(document: WellKnownDocument, windows: Record<string, ReplayWindowState>): WellKnownDocument`

**Steps**

- [ ] Write the failing test at `packages/discovery/transport-http/src/advertise.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";
      import { RECORD_DISCOVERY_VERSION } from "@jinn-network/record-discovery-protocol";
      import type { WellKnownDocument } from "@jinn-network/record-discovery-serve";
      import { parseWellKnownDocument } from "@jinn-network/record-discovery-serve";

      import { createInMemoryTailSource } from "./tail.js";
      import { advertiseReplayWindow, withReplayWindowAdvertisements } from "./advertise.js";

      const DOCUMENT: WellKnownDocument = {
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [
          { agent: "did:key:zA", name: "feed", headPath: "/sources/feed/head", archiveRoot: "/sources/feed/entries/0000000000000001" },
          { agent: "did:key:zA", name: "corpus", headPath: "/sources/corpus/head", archiveRoot: "/sources/corpus/entries/0000000000000001" },
        ],
      };

      describe("advertiseReplayWindow", () => {
        it("advertises the bounded window, its tail path, and the relay-local cursor scope", () => {
          const tail = createInMemoryTailSource(64);
          expect(advertiseReplayWindow("feed", tail.source.window())).toEqual({
            tailPath: "/sources/feed/tail",
            cursorScope: "relay-local",
            capacity: 64,
          });
        });
      });

      describe("withReplayWindowAdvertisements", () => {
        it("decorates only the named sources and leaves the rest untouched", () => {
          const tail = createInMemoryTailSource(16);
          const decorated = withReplayWindowAdvertisements(DOCUMENT, { feed: tail.source.window() });

          expect(decorated.sources[0]).toEqual({
            ...DOCUMENT.sources[0],
            replayWindow: { tailPath: "/sources/feed/tail", cursorScope: "relay-local", capacity: 16 },
          });
          expect(decorated.sources[1]).toEqual(DOCUMENT.sources[1]);
        });

        it("does not mutate the input document", () => {
          const tail = createInMemoryTailSource(16);
          withReplayWindowAdvertisements(DOCUMENT, { feed: tail.source.window() });
          expect(DOCUMENT.sources[0]).not.toHaveProperty("replayWindow");
        });

        it("still validates against serve's in-protocol well-known schema", () => {
          const tail = createInMemoryTailSource(16);
          const decorated = withReplayWindowAdvertisements(DOCUMENT, { feed: tail.source.window() });
          expect(() => parseWellKnownDocument(decorated)).not.toThrow();
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/advertise.test.ts
      ```

      Expected failure: `Failed to resolve import "./advertise.js"`.

- [ ] Write `packages/discovery/transport-http/src/advertise.ts`:

      ```ts
      import type { WellKnownDocument, WellKnownSourceEntry } from "@jinn-network/record-discovery-serve";

      import { archiveTailPath } from "./paths.js";
      import type { ReplayWindowState } from "./tail.js";

      // "Each source advertises its bounded replay window in the well-known
      // discovery document" (composition design §7.3, discovery §9.3's
      // non-archival relay rule). `serve`'s `WellKnownSourceEntry` has no
      // typed slot for this (Finding F3), and its zod schema is a
      // `z.looseObject`, so the field rides discovery §15's additive-unknown-
      // fields rule: producers that do not advertise a window are unchanged,
      // consumers that do not understand the field ignore it, and this package
      // owns the type until a second producer justifies promoting it into
      // `serve`.
      //
      // `cursorScope: "relay-local"` is the §9.3 declaration obligation made
      // machine-readable: a relay's cursor numbering is its own, never the
      // source chain's sequence.

      export interface ReplayWindowAdvertisement {
        /** Where the tail is served, relative to the serving root. */
        tailPath: string;
        /** §9.3: relay cursors are relay-local and MUST be declared as such. */
        cursorScope: "relay-local";
        /** The bounded window's capacity in events. */
        capacity: number;
      }

      export type AdvertisedSourceEntry = WellKnownSourceEntry & { replayWindow: ReplayWindowAdvertisement };

      export function advertiseReplayWindow(sourceName: string, window: ReplayWindowState): ReplayWindowAdvertisement {
        return {
          tailPath: archiveTailPath(sourceName),
          cursorScope: "relay-local",
          capacity: window.capacity,
        };
      }

      /**
       * Returns a copy of `document` in which every source named in `windows`
       * carries its `replayWindow` advertisement. Sources absent from `windows`
       * are copied through unchanged -- a static mirror serving the same
       * document offers no tail and advertises none.
       */
      export function withReplayWindowAdvertisements(
        document: WellKnownDocument,
        windows: Record<string, ReplayWindowState>,
      ): WellKnownDocument {
        return {
          ...document,
          sources: document.sources.map((source) => {
            const window = windows[source.name];
            if (window === undefined) return { ...source };
            const advertised: AdvertisedSourceEntry = {
              ...source,
              replayWindow: advertiseReplayWindow(source.name, window),
            };
            return advertised;
          }),
        };
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/advertise.test.ts
      ```

      Expected: `Tests  4 passed (4)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./advertise.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): advertise each source's bounded replay window in the well-known document"
      ```

---

## Task 10 — Client `Transport` over Node 22 `fetch`, with conditional requests

**Files**

- Modify: `packages/discovery/transport-http/src/fetch-transport.ts` (created as a
  placeholder in Task 2)
- Create: `packages/discovery/transport-http/src/fetch-transport.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `Transport`, `TransportResponse` from `@jinn-network/record-discovery-client`
  (types only); `FetchLike` from `./ports.js`; the Node 22 global `fetch` (undici).
- Produces:
  - `export class TransportHttpError extends Error` with `readonly status: number` and
    `readonly url: string`
  - `export class TransportOversizeError extends Error` with `readonly url: string`,
    `readonly declaredLength: number`, `readonly maxBytes: number`
  - `export interface HttpTransportOptions { maxBytes?: number; headers?: Record<string, string> }`
  - `export interface HttpTransport extends Transport { stats(): { requests: number; revalidations: number } }`
  - `export function createHttpTransport(baseUrl: string, fetchLike?: FetchLike, options?: HttpTransportOptions): HttpTransport`

**Steps**

- [ ] Write the failing test at
      `packages/discovery/transport-http/src/fetch-transport.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";
      import type { ClientUnderTest } from "@jinn-network/record-discovery-testing";
      import { runConsumerConformance } from "@jinn-network/record-discovery-testing";
      import { checkLocator } from "@jinn-network/record-discovery-client";

      import type { FetchLike } from "./ports.js";
      import { TransportHttpError, TransportOversizeError, createHttpTransport } from "./fetch-transport.js";

      const encoder = new TextEncoder();

      function stubFetch(handler: (url: string, init?: Parameters<FetchLike>[1]) => Response): {
        fetchLike: FetchLike;
        calls: Array<{ url: string; headers: Record<string, string> }>;
      } {
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        return {
          calls,
          async fetchLike(url, init) {
            calls.push({ url, headers: init?.headers ?? {} });
            return handler(url, init);
          },
        };
      }

      describe("createHttpTransport", () => {
        it("resolves relative paths against the base URL and returns bytes plus metadata", async () => {
          const stub = stubFetch(() => new Response(encoder.encode('{"ok":true}'), {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "11" },
          }));
          const transport = createHttpTransport("https://archive.example/v1/archive", stub.fetchLike);

          const response = await transport.fetch("/sources/feed/head");
          expect(stub.calls[0]!.url).toBe("https://archive.example/v1/archive/sources/feed/head");
          expect(response.status).toBe(200);
          expect(response.contentType).toBe("application/json");
          expect(response.declaredLength).toBe(11);
          expect(new TextDecoder().decode(response.bytes)).toBe('{"ok":true}');
        });

        it("passes an absolute URL through untouched", async () => {
          const stub = stubFetch(() => new Response(encoder.encode("x"), { status: 200 }));
          const transport = createHttpTransport("https://archive.example", stub.fetchLike);
          await transport.fetch("https://mirror.example/sources/feed/head");
          expect(stub.calls[0]!.url).toBe("https://mirror.example/sources/feed/head");
        });

        it("sends If-None-Match on a repeat request and serves the cached body on 304", async () => {
          let served = 0;
          const stub = stubFetch((_url, init) => {
            served += 1;
            if (init?.headers?.["if-none-match"] === '"sha256-abc"') {
              return new Response(null, { status: 304, headers: { etag: '"sha256-abc"' } });
            }
            return new Response(encoder.encode("head-bytes"), {
              status: 200,
              headers: { etag: '"sha256-abc"', "content-type": "application/json" },
            });
          });
          const transport = createHttpTransport("https://archive.example", stub.fetchLike);

          const first = await transport.fetch("/sources/feed/head");
          const second = await transport.fetch("/sources/feed/head");

          expect(served).toBe(2);
          expect(new TextDecoder().decode(second.bytes)).toBe("head-bytes");
          expect(second.status).toBe(200);
          expect(second.contentType).toBe("application/json");
          expect(first.bytes).toEqual(second.bytes);
          expect(transport.stats()).toEqual({ requests: 2, revalidations: 1 });
        });

        it("never caches a response without an ETag", async () => {
          const stub = stubFetch(() => new Response(encoder.encode("no-etag"), { status: 200 }));
          const transport = createHttpTransport("https://archive.example", stub.fetchLike);
          await transport.fetch("/sources/feed/head");
          await transport.fetch("/sources/feed/head");
          expect(stub.calls[1]!.headers["if-none-match"]).toBeUndefined();
        });

        it("throws a typed error on a non-2xx, non-304 status", async () => {
          const stub = stubFetch(() => new Response(null, { status: 503 }));
          const transport = createHttpTransport("https://archive.example", stub.fetchLike);
          await expect(transport.fetch("/sources/feed/head")).rejects.toBeInstanceOf(TransportHttpError);
        });

        it("refuses a body whose declared length exceeds the ceiling before reading it", async () => {
          const stub = stubFetch(() => new Response(encoder.encode("x"), {
            status: 200,
            headers: { "content-length": "999999999" },
          }));
          const transport = createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1024 });
          await expect(transport.fetch("/records/deadbeef")).rejects.toBeInstanceOf(TransportOversizeError);
        });

        it("refuses a body that exceeds the ceiling despite an absent declared length", async () => {
          const stub = stubFetch(() => new Response(encoder.encode("x".repeat(2048)), { status: 200 }));
          const transport = createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1024 });
          await expect(transport.fetch("/records/deadbeef")).rejects.toBeInstanceOf(TransportOversizeError);
        });
      });

      // The hostile-locator guards (§7/§14) are `client`'s, not this
      // package's -- but they are only real once a production Transport backs
      // them, so the kit's consumer suite runs here against `client`'s
      // `checkLocator` wired to this transport.
      const underTest: ClientUnderTest = {
        async checkLocator(location) {
          const stub = stubFetch(() => new Response(encoder.encode("x".repeat(4096)), {
            status: 200,
            headers: { "content-type": "text/html", "content-length": "4096" },
          }));
          return checkLocator(location as { profile: string; locator: string }, {
            transport: createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1 << 20 }),
            maxBytes: 1024,
          });
        },
      };

      runConsumerConformance(underTest);
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/fetch-transport.test.ts
      ```

      Expected failure:
      `The requested module './fetch-transport.js' does not provide an export named 'createHttpTransport'`.

- [ ] Replace `packages/discovery/transport-http/src/fetch-transport.ts` with:

      ```ts
      import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";

      import type { FetchLike } from "./ports.js";

      // The client-side `Transport` plug (spec §6.2). One of the three modules
      // the discovery source-boundaries guard allows to name an ambient
      // network API (Finding F1).
      //
      // The primitive is Node 22's global `fetch` -- undici, stable since Node
      // 18, no dependency, no polyfill -- injectable as `fetchLike` so tests
      // and hosts can supply a loopback. Conditional requests are §7.3's
      // ETag / If-None-Match profile made automatic: the transport remembers
      // each URL's entity tag, revalidates on the next request, and on 304
      // returns the cached bytes under status 200 so every existing `client`
      // consumer (`fetchHead`, `coldSync`, `returningSync`) parses a body
      // exactly as it does today. `stats()` exposes the revalidation count so
      // a host can see the profile working.

      const DEFAULT_MAX_BYTES = 8 << 20; // 8 MiB -- twice the §5.1 archive-page ceiling

      export class TransportHttpError extends Error {
        readonly status: number;
        readonly url: string;

        constructor(url: string, status: number) {
          super(`GET ${url} failed with HTTP ${status}.`);
          this.name = "TransportHttpError";
          this.url = url;
          this.status = status;
        }
      }

      export class TransportOversizeError extends Error {
        readonly url: string;
        readonly declaredLength: number;
        readonly maxBytes: number;

        constructor(url: string, declaredLength: number, maxBytes: number) {
          super(`GET ${url} returned ${declaredLength} bytes, over the ${maxBytes}-byte ceiling.`);
          this.name = "TransportOversizeError";
          this.url = url;
          this.declaredLength = declaredLength;
          this.maxBytes = maxBytes;
        }
      }

      export interface HttpTransportOptions {
        /** Hard ceiling on a single response body. Defaults to 8 MiB. */
        maxBytes?: number;
        /** Headers sent on every request (never includes credentials -- the archive subtree is public). */
        headers?: Record<string, string>;
      }

      export interface HttpTransport extends Transport {
        stats(): { requests: number; revalidations: number };
      }

      interface CacheEntry {
        etag: string;
        bytes: Uint8Array;
        contentType?: string;
      }

      function resolveUrl(baseUrl: string, url: string): string {
        if (/^https?:\/\//i.test(url)) return url;
        return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
      }

      export function createHttpTransport(
        baseUrl: string,
        fetchLike: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
        options: HttpTransportOptions = {},
      ): HttpTransport {
        const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        const cache = new Map<string, CacheEntry>();
        let requests = 0;
        let revalidations = 0;

        return {
          async "fetch"(url: string): Promise<TransportResponse> {
            const target = resolveUrl(baseUrl, url);
            const cached = cache.get(target);
            const headers: Record<string, string> = {
              ...(options.headers ?? {}),
              ...(cached === undefined ? {} : { "if-none-match": cached.etag }),
            };

            requests += 1;
            const response = await fetchLike(target, { method: "GET", headers });

            if (response.status === 304 && cached !== undefined) {
              revalidations += 1;
              return {
                status: 200,
                ...(cached.contentType === undefined ? {} : { contentType: cached.contentType }),
                declaredLength: cached.bytes.length,
                bytes: cached.bytes,
              };
            }

            if (response.status < 200 || response.status > 299) {
              throw new TransportHttpError(target, response.status);
            }

            const contentLength = response.headers.get("content-length");
            const declaredLength = contentLength === null ? undefined : Number(contentLength);
            if (declaredLength !== undefined && declaredLength > maxBytes) {
              throw new TransportOversizeError(target, declaredLength, maxBytes);
            }

            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > maxBytes) {
              throw new TransportOversizeError(target, bytes.length, maxBytes);
            }

            const contentType = response.headers.get("content-type") ?? undefined;
            const etag = response.headers.get("etag");
            if (etag !== null) {
              cache.set(target, {
                etag,
                bytes,
                ...(contentType === undefined ? {} : { contentType }),
              });
            }

            return {
              status: response.status,
              ...(contentType === undefined ? {} : { contentType }),
              ...(declaredLength === undefined ? { declaredLength: bytes.length } : { declaredLength }),
              bytes,
            };
          },

          stats() {
            return { requests, revalidations };
          },
        };
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/fetch-transport.test.ts
      ```

      Expected: `Tests  10 passed (10)` — seven transport tests plus the kit's three
      `consumer conformance` locator vectors.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./fetch-transport.js";
      ```

- [ ] Re-run the boundary guard so the ambient-network allowlist is exercised against real
      content:

      ```bash
      cd ../../.. && node --test .github/scripts/record-discovery-source-boundaries.test.mjs
      ```

      Expected: `# fail 0` (the `fetch` and `globalThis.fetch` occurrences are inside an
      allowlisted file).

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): client Transport over Node 22 fetch with automatic conditional requests"
      ```

---

## Task 11 — Client `StreamTransport` over SSE, with `Last-Event-ID` resume

**Files**

- Modify: `packages/discovery/transport-http/src/sse-transport.ts` (created as a placeholder
  in Task 2)
- Create: `packages/discovery/transport-http/src/sse-transport.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `StreamTransport`, `StreamSubscription` from
  `@jinn-network/record-discovery-client` (types only); `FetchLike` from `./ports.js`;
  `SseTerminalEventType`, `SseColdSyncHint` from `./sse.js`; the Node 22 global `fetch` and
  `Response.body` (`ReadableStream<Uint8Array>`).
- Produces:
  - `export class SseTerminalError extends Error` with
    `readonly terminal: SseTerminalEventType` and `readonly coldSync?: SseColdSyncHint`
  - `export interface SseStreamTransportOptions { reconnectDelayMs?: number; maxReconnects?: number }`
  - `export function createSseStreamTransport(baseUrl: string, fetchLike?: FetchLike, options?: SseStreamTransportOptions): StreamTransport`

**Steps**

- [ ] Write the failing test at
      `packages/discovery/transport-http/src/sse-transport.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";

      import type { FetchLike } from "./ports.js";
      import { createInMemoryTailSource } from "./tail.js";
      import { openArchiveTailStream } from "./sse.js";
      import { SseTerminalError, createSseStreamTransport } from "./sse-transport.js";

      function waitFor(predicate: () => boolean, label: string): Promise<void> {
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + 2000;
          const tick = () => {
            if (predicate()) { resolve(); return; }
            if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${label}`)); return; }
            setTimeout(tick, 5);
          };
          tick();
        });
      }

      /** Serves the real SSE endpoint over an in-process fetch, so the parser is tested against the real writer. */
      function loopback(tailSource: ReturnType<typeof createInMemoryTailSource>): {
        fetchLike: FetchLike;
        lastEventIds: Array<string | undefined>;
      } {
        const lastEventIds: Array<string | undefined> = [];
        return {
          lastEventIds,
          async fetchLike(url, init) {
            lastEventIds.push(init?.headers?.["last-event-id"]);
            const request = new Request(url, {
              headers: init?.headers ?? {},
              ...(init?.signal === undefined ? {} : { signal: init.signal }),
            });
            return openArchiveTailStream(request, "feed", tailSource.source);
          },
        };
      }

      describe("createSseStreamTransport", () => {
        it("delivers each event's data payload to onMessage", async () => {
          const tail = createInMemoryTailSource(10);
          const transport = createSseStreamTransport("https://archive.example", loopback(tail).fetchLike);
          const seen: string[] = [];

          const subscription = transport.connect("/sources/feed/tail", (raw) => seen.push(raw), () => undefined);
          await waitFor(() => seen.length === 0, "the stream to open");
          tail.publish("announcement", '{"n":1}');
          tail.publish("observation", '{"n":2}');
          await waitFor(() => seen.length === 2, "two delivered events");
          subscription.close();

          expect(seen).toEqual(['{"n":1}', '{"n":2}']);
        });

        it("resumes with Last-Event-ID after a disconnect", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"n":1}');
          const link = loopback(tail);
          const transport = createSseStreamTransport("https://archive.example", link.fetchLike, { reconnectDelayMs: 1 });
          const seen: string[] = [];

          const subscription = transport.connect("/sources/feed/tail?cursor=oldest", (raw) => seen.push(raw), () => undefined);
          await waitFor(() => seen.length === 1, "the replayed event");

          // The in-process stream ends when the tail source's buffer is
          // consumed and the underlying ReadableStream is closed by the peer;
          // publish after the reconnect to prove the resume carried the cursor.
          await waitFor(() => link.lastEventIds.length >= 2, "a reconnect");
          expect(link.lastEventIds[0]).toBeUndefined();
          expect(link.lastEventIds[1]).toBe("0000000000000001");
          subscription.close();
        });

        it("reports a typed terminal event to onError and does not reconnect", async () => {
          const tail = createInMemoryTailSource(2);
          for (let index = 0; index < 4; index += 1) tail.publish("announcement", `{"n":${index}}`);
          const link = loopback(tail);
          const transport = createSseStreamTransport("https://archive.example", link.fetchLike, { reconnectDelayMs: 1 });
          const errors: unknown[] = [];

          const subscription = transport.connect(
            "/sources/feed/tail?cursor=0000000000000001",
            () => undefined,
            (error) => errors.push(error),
          );
          await waitFor(() => errors.length === 1, "the terminal error");
          subscription.close();

          const [error] = errors;
          expect(error).toBeInstanceOf(SseTerminalError);
          expect((error as SseTerminalError).terminal).toBe("cursor-too-old");
          expect((error as SseTerminalError).coldSync).toEqual({
            head: "/sources/feed/head",
            archiveRoot: "/sources/feed/entries/0000000000000003",
          });
          expect(link.lastEventIds).toHaveLength(1);
        });

        it("reports an unknown cursor as a typed terminal error", async () => {
          const tail = createInMemoryTailSource(10);
          tail.publish("announcement", '{"n":1}');
          const transport = createSseStreamTransport("https://archive.example", loopback(tail).fetchLike, { reconnectDelayMs: 1 });
          const errors: unknown[] = [];

          const subscription = transport.connect(
            "/sources/feed/tail?cursor=0000000000000099",
            () => undefined,
            (error) => errors.push(error),
          );
          await waitFor(() => errors.length === 1, "the terminal error");
          subscription.close();

          expect((errors[0] as SseTerminalError).terminal).toBe("unknown-cursor");
        });

        it("stops delivering after close()", async () => {
          const tail = createInMemoryTailSource(10);
          const transport = createSseStreamTransport("https://archive.example", loopback(tail).fetchLike);
          const seen: string[] = [];

          const subscription = transport.connect("/sources/feed/tail", (raw) => seen.push(raw), () => undefined);
          tail.publish("announcement", '{"n":1}');
          await waitFor(() => seen.length === 1, "the first event");
          subscription.close();
          tail.publish("announcement", '{"n":2}');
          await new Promise((resolve) => setTimeout(resolve, 20));

          expect(seen).toEqual(['{"n":1}']);
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/sse-transport.test.ts
      ```

      Expected failure:
      `The requested module './sse-transport.js' does not provide an export named 'createSseStreamTransport'`.

- [ ] Replace `packages/discovery/transport-http/src/sse-transport.ts` with:

      ```ts
      import type { StreamSubscription, StreamTransport } from "@jinn-network/record-discovery-client";

      import type { FetchLike } from "./ports.js";
      import type { SseColdSyncHint, SseTerminalEventType } from "./sse.js";

      // The client-side `StreamTransport` plug (spec §6.2). One of the three
      // modules the discovery source-boundaries guard allows to name an
      // ambient network API (Finding F1).
      //
      // The primitives are exactly two, both Node 22 built-ins: the global
      // `fetch` (undici) and the web `ReadableStream<Uint8Array>` on
      // `Response.body`, read through a `TextDecoder`. The global
      // `EventSource` is deliberately NOT used: it cannot set the
      // `Last-Event-ID` request header on the FIRST connection, and an
      // explicit resume from a stored cursor -- the whole point of §7.3's
      // profile -- is exactly a first-connection resume. Framing is the
      // EventSource wire format regardless, so a browser consumer of the same
      // endpoint is unaffected.
      //
      // Terminal events (`unknown-cursor`, `cursor-too-old`) surface as a
      // typed `SseTerminalError` on the error channel and STOP the transport:
      // reconnecting on them would loop forever against a cursor the relay has
      // already refused, and §9.3 forbids silent gap-skipping. The consumer's
      // recovery is the cold-sync path the terminal event names.

      const DEFAULT_RECONNECT_DELAY_MS = 3000;
      const TERMINAL_EVENTS: readonly SseTerminalEventType[] = ["unknown-cursor", "cursor-too-old"];

      export class SseTerminalError extends Error {
        readonly terminal: SseTerminalEventType;
        readonly coldSync?: SseColdSyncHint;

        constructor(terminal: SseTerminalEventType, coldSync?: SseColdSyncHint) {
          super(
            `The relay closed the tail with "${terminal}". `
              + "Recover through the cold-sync path (head + archive pages), never by guessing a cursor.",
          );
          this.name = "SseTerminalError";
          this.terminal = terminal;
          if (coldSync !== undefined) this.coldSync = coldSync;
        }
      }

      export interface SseStreamTransportOptions {
        /** Delay before re-opening a stream that ended without a terminal event. Defaults to 3000 ms. */
        reconnectDelayMs?: number;
        /** Cap on consecutive reconnects; `undefined` (default) reconnects indefinitely. */
        maxReconnects?: number;
      }

      interface ParsedFrame {
        id?: string;
        event?: string;
        data: string;
      }

      /** Parses one complete SSE frame (the text between two blank lines). Comment-only frames yield `undefined`. */
      function parseFrame(block: string): ParsedFrame | undefined {
        let id: string | undefined;
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line === "" || line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          const field = separator === -1 ? line : line.slice(0, separator);
          const rawValue = separator === -1 ? "" : line.slice(separator + 1);
          const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
          if (field === "id") id = value;
          else if (field === "event") event = value;
          else if (field === "data") dataLines.push(value);
        }
        if (id === undefined && event === undefined && dataLines.length === 0) return undefined;
        return {
          ...(id === undefined ? {} : { id }),
          ...(event === undefined ? {} : { event }),
          data: dataLines.join("\n"),
        };
      }

      function resolveUrl(baseUrl: string, url: string): string {
        if (/^https?:\/\//i.test(url)) return url;
        return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
      }

      function isTerminal(event: string | undefined): event is SseTerminalEventType {
        return event !== undefined && (TERMINAL_EVENTS as readonly string[]).includes(event);
      }

      export function createSseStreamTransport(
        baseUrl: string,
        fetchLike: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
        options: SseStreamTransportOptions = {},
      ): StreamTransport {
        const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

        return {
          connect(
            url: string,
            onMessage: (raw: string) => void,
            onError: (error: unknown) => void,
          ): StreamSubscription {
            const target = resolveUrl(baseUrl, url);
            const controller = new AbortController();
            let lastEventId: string | undefined;
            let stopped = false;
            let reconnects = 0;

            async function readOnce(): Promise<"ended" | "terminal"> {
              const headers: Record<string, string> = {
                accept: "text/event-stream",
                ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
              };
              const response = await fetchLike(target, { method: "GET", headers, signal: controller.signal });
              if (response.body === null) return "ended";

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffered = "";
              try {
                for (;;) {
                  const { value, done } = await reader.read();
                  if (value !== undefined) buffered += decoder.decode(value, { stream: true });
                  let boundary = buffered.indexOf("\n\n");
                  while (boundary !== -1) {
                    const frame = parseFrame(buffered.slice(0, boundary));
                    buffered = buffered.slice(boundary + 2);
                    boundary = buffered.indexOf("\n\n");
                    if (frame === undefined) continue;
                    if (frame.id !== undefined) lastEventId = frame.id;
                    if (isTerminal(frame.event)) {
                      let coldSync: SseColdSyncHint | undefined;
                      try {
                        coldSync = (JSON.parse(frame.data) as { coldSync?: SseColdSyncHint }).coldSync;
                      } catch {
                        coldSync = undefined;
                      }
                      onError(new SseTerminalError(frame.event, coldSync));
                      return "terminal";
                    }
                    if (frame.data !== "") onMessage(frame.data);
                  }
                  if (done) return "ended";
                }
              } finally {
                await reader.cancel().catch(() => undefined);
              }
            }

            void (async () => {
              while (!stopped) {
                let outcome: "ended" | "terminal";
                try {
                  outcome = await readOnce();
                } catch (error) {
                  if (stopped) return;
                  onError(error);
                  outcome = "ended";
                }
                if (outcome === "terminal" || stopped) return;
                reconnects += 1;
                if (options.maxReconnects !== undefined && reconnects > options.maxReconnects) return;
                await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
              }
            })();

            return {
              close(): void {
                stopped = true;
                controller.abort();
              },
            };
          },
        };
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/sse-transport.test.ts
      ```

      Expected: `Tests  5 passed (5)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./sse-transport.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): SSE StreamTransport with Last-Event-ID resume and typed terminal handling"
      ```

---

## Task 12 — Producer-side HTTP ping transport (Finding F4)

**Files**

- Modify: `packages/discovery/transport-http/src/ping-transport.ts` (created as a placeholder
  in Task 2)
- Create: `packages/discovery/transport-http/src/ping-transport.test.ts`
- Modify: `packages/discovery/transport-http/src/index.ts`

**Interfaces**

- Consumes: `PingTransport` from `@jinn-network/record-discovery-serve` (type only);
  `FetchLike` from `./ports.js`.
- Produces:
  - `export class PingDeliveryError extends Error` with `readonly endpointUrl: string` and
    `readonly status: number`
  - `export function createHttpPingTransport(endpointUrl: string, fetchLike?: FetchLike): PingTransport`

**Steps**

- [ ] Write the failing test at
      `packages/discovery/transport-http/src/ping-transport.test.ts`:

      ```ts
      import { describe, expect, it } from "vitest";
      import { createFixedWindowDebounce, emitPing } from "@jinn-network/record-discovery-serve";

      import type { FetchLike } from "./ports.js";
      import { PingDeliveryError, createHttpPingTransport } from "./ping-transport.js";

      function stub(status: number): { fetchLike: FetchLike; bodies: string[] } {
        const bodies: string[] = [];
        return {
          bodies,
          async fetchLike(_url, init) {
            bodies.push(init?.body ?? "");
            return new Response(null, { status });
          },
        };
      }

      describe("createHttpPingTransport", () => {
        it("POSTs the moved head URL as JSON", async () => {
          const stubbed = stub(202);
          const transport = createHttpPingTransport("https://relay.example/ping", stubbed.fetchLike);
          await transport.announce("https://archive.example/sources/feed/head");
          expect(JSON.parse(stubbed.bodies[0]!)).toEqual({ headUrl: "https://archive.example/sources/feed/head" });
        });

        it("throws a typed error on a non-2xx status", async () => {
          const transport = createHttpPingTransport("https://relay.example/ping", stub(500).fetchLike);
          await expect(transport.announce("https://archive.example/sources/feed/head"))
            .rejects.toBeInstanceOf(PingDeliveryError);
        });

        it("plugs into serve's producer-side debounce", async () => {
          const stubbed = stub(202);
          const transport = createHttpPingTransport("https://relay.example/ping", stubbed.fetchLike);
          const debounce = createFixedWindowDebounce(60_000);
          const headUrl = "https://archive.example/sources/feed/head";

          expect(await emitPing(transport, headUrl, debounce, new Date("2026-07-30T12:00:00Z"))).toBe(true);
          expect(await emitPing(transport, headUrl, debounce, new Date("2026-07-30T12:00:30Z"))).toBe(false);
          expect(stubbed.bodies).toHaveLength(1);
        });
      });
      ```

- [ ] Run it and watch it fail:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/ping-transport.test.ts
      ```

      Expected failure:
      `The requested module './ping-transport.js' does not provide an export named 'createHttpPingTransport'`.

- [ ] Replace `packages/discovery/transport-http/src/ping-transport.ts` with:

      ```ts
      import type { PingTransport } from "@jinn-network/record-discovery-serve";

      import type { FetchLike } from "./ports.js";

      // The producer-side `PingTransport` plug (design §7 item 4). One of the
      // three modules the discovery source-boundaries guard allows to name an
      // ambient network API (Finding F1).
      //
      // Finding F4: the composition spec §6.2 groups "ping" with the
      // client-side plugs, but the only ping PORT in the stack is producer-
      // side (`serve`'s `PingTransport.announce(headUrl)`); the consumer's
      // obligation -- debouncing pull-on-ping so a flood costs at most the
      // consumer's own configured pull rate -- already ships in `client`
      // (`createPullDebounce`). So this module implements the emitting half
      // and nothing else; receiving pings is a host loop, not a transport.
      //
      // Pings are unauthenticated hints and carry no trust either way (§7 item
      // 4): a lost ping costs latency, never correctness.

      export class PingDeliveryError extends Error {
        readonly endpointUrl: string;
        readonly status: number;

        constructor(endpointUrl: string, status: number) {
          super(`Announcement ping to ${endpointUrl} failed with HTTP ${status}.`);
          this.name = "PingDeliveryError";
          this.endpointUrl = endpointUrl;
          this.status = status;
        }
      }

      export function createHttpPingTransport(
        endpointUrl: string,
        fetchLike: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
      ): PingTransport {
        return {
          async announce(headUrl: string): Promise<void> {
            const response = await fetchLike(endpointUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ headUrl }),
            });
            if (response.status < 200 || response.status > 299) {
              throw new PingDeliveryError(endpointUrl, response.status);
            }
          },
        };
      }
      ```

- [ ] Run it and watch it pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/ping-transport.test.ts
      ```

      Expected: `Tests  3 passed (3)`.

- [ ] Append to `packages/discovery/transport-http/src/index.ts`:

      ```ts
      export * from "./ping-transport.js";
      ```

- [ ] Typecheck and commit:

      ```bash
      cd packages/discovery/transport-http && yarn typecheck
      git add packages/discovery/transport-http/src
      git commit -m "feat(transport-http): producer-side HTTP announcement ping transport"
      ```

---

## Task 13 — Loopback integration: serve's writer → handler → client transports

**Files**

- Create: `packages/discovery/transport-http/src/loopback.integration.test.ts`
- Create: `packages/discovery/transport-http/src/mount.integration.test.ts`

**Interfaces**

- Consumes: `writeRecord`, `writeArchivePages`, `maintainHead`, `signHead`,
  `writeWellKnownDocument`, `SignedEntry`, `DsseSigner` from
  `@jinn-network/record-discovery-serve`; `fetchHead`, `coldSync`, `returningSync`,
  `subscribe`, `SourceEndpoint` from `@jinn-network/record-discovery-client`;
  `createFsBlobStore`, `createArchiveHttpHandler`, `createHttpTransport`,
  `createSseStreamTransport`, `createInMemoryTailSource`,
  `withReplayWindowAdvertisements` from this package; `Hono` (dev dependency).
- Produces: no new exports — these are the tree's integration gate.

**Steps**

- [ ] Write the failing loopback test at
      `packages/discovery/transport-http/src/loopback.integration.test.ts`:

      ```ts
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { afterEach, beforeEach, describe, expect, it } from "vitest";
      import {
        GENESIS_SEQUENCE,
        MEDIA_ENTRY,
        RECORD_DISCOVERY_VERSION,
        archivePagePath,
        dssePreAuthEncoding,
        formatOrigin,
        formatSequence,
        headPath,
        sealJson,
        sha256Hex,
      } from "@jinn-network/record-discovery-protocol";
      import type { AnnouncementEntry, SourceHead } from "@jinn-network/record-discovery-protocol";
      import type { DsseSigner, SignedEntry } from "@jinn-network/record-discovery-serve";
      import {
        maintainHead,
        signHead,
        writeArchivePages,
        writeRecord,
        writeWellKnownDocument,
      } from "@jinn-network/record-discovery-serve";
      import type { SourceEndpoint } from "@jinn-network/record-discovery-client";
      import { coldSync, fetchHead, returningSync, subscribe } from "@jinn-network/record-discovery-client";

      import type { FetchLike } from "./ports.js";
      import { createFsBlobStore } from "./fs-blob-store.js";
      import { createArchiveHttpHandler } from "./handler.js";
      import { createHttpTransport } from "./fetch-transport.js";
      import { createSseStreamTransport, SseTerminalError } from "./sse-transport.js";
      import { createInMemoryTailSource } from "./tail.js";
      import { withReplayWindowAdvertisements } from "./advertise.js";

      const AGENT = "did:key:zLoopbackAgent";
      const SOURCE = "feed";
      const KEYID = "loopback-key";
      const BASE = "https://archive.test";

      const signer: DsseSigner = {
        async sign(pae: Uint8Array) {
          return [{ keyid: KEYID, sig: new TextEncoder().encode(`${sha256Hex(pae)}:${KEYID}`) }];
        },
      };

      function entryAt(sequence: bigint, previous: string | null): AnnouncementEntry {
        return {
          protocol: RECORD_DISCOVERY_VERSION,
          source: { agent: AGENT, name: SOURCE },
          sequence: formatSequence(sequence),
          previous,
          timestamp: "2026-07-30T12:00:00Z",
          announcements: [
            {
              announcementId: `announcement-${sequence}`,
              action: "available",
              record: { kind: "https://jinn.network/records/submission/1.0", digest: `sha256:${"c".repeat(64)}` },
            },
          ],
        } as AnnouncementEntry;
      }

      async function signEntry(entry: AnnouncementEntry): Promise<SignedEntry> {
        const { bytes } = sealJson(entry);
        const signatures = await signer.sign(dssePreAuthEncoding(MEDIA_ENTRY, bytes));
        return {
          entry,
          signature: {
            payloadType: MEDIA_ENTRY,
            payload: Buffer.from(bytes).toString("base64"),
            signatures: signatures.map((signature) => ({
              keyid: signature.keyid!,
              sig: Buffer.from(signature.sig).toString("base64"),
            })),
          },
        };
      }

      function waitFor(predicate: () => boolean, label: string): Promise<void> {
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + 2000;
          const tick = () => {
            if (predicate()) { resolve(); return; }
            if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${label}`)); return; }
            setTimeout(tick, 5);
          };
          tick();
        });
      }

      describe("loopback: serve writes the layout, the handler serves it, the client reads it back", () => {
        let root: string;

        beforeEach(async () => {
          root = await mkdtemp(join(tmpdir(), "jinn-transport-http-loopback-"));
        });

        afterEach(async () => {
          await rm(root, { recursive: true, force: true });
        });

        it("round-trips an archive end to end and honors every §7.3 clause", async () => {
          const store = createFsBlobStore(root);
          const tail = createInMemoryTailSource(2);

          // --- producer side: serve's own writers, unmodified -------------
          const entries: SignedEntry[] = [
            await signEntry(entryAt(1n, null)),
            await signEntry(entryAt(2n, sealJson(entryAt(1n, null)).digest)),
          ];
          const { pages } = await writeArchivePages(store, SOURCE, entries);
          for (const signed of entries) await writeRecord(store, sealJson(signed.entry).bytes, MEDIA_ENTRY);

          const newestPage = pages[pages.length - 1]!;
          const genesisHead: SourceHead = {
            protocol: RECORD_DISCOVERY_VERSION,
            origin: formatOrigin(AGENT, SOURCE),
            sequence: GENESIS_SEQUENCE,
            entry: sealJson(entries[0]!.entry).digest,
            issuedAt: "2026-07-30T11:59:00.000Z",
            refreshBy: "2026-07-30T23:59:00.000Z",
          } as SourceHead;
          await maintainHead(store, signer, { now: () => new Date("2026-07-30T12:00:00Z") }, { agent: AGENT, name: SOURCE }, genesisHead);
          await writeWellKnownDocument(store, withReplayWindowAdvertisements(
            {
              protocol: RECORD_DISCOVERY_VERSION,
              sources: [{
                agent: AGENT,
                name: SOURCE,
                headPath: headPath(SOURCE),
                archiveRoot: archivePagePath(SOURCE, newestPage),
              }],
            },
            { [SOURCE]: tail.source.window() },
          ));

          // --- transport: the handler over one in-process fetch -----------
          const handler = createArchiveHttpHandler({
            reader: store,
            tail: tail.source,
            isSealedPage: (_source, page) => page !== newestPage,
          });
          const fetchLike: FetchLike = async (url, init) => handler(new Request(url, {
            method: init?.method ?? "GET",
            headers: init?.headers ?? {},
            ...(init?.signal === undefined ? {} : { signal: init.signal }),
          }));

          const transport = createHttpTransport(BASE, fetchLike);
          const endpoint: SourceEndpoint = {
            agent: AGENT,
            name: SOURCE,
            servingRoot: BASE,
            archiveRootUrl: `${BASE}${archivePagePath(SOURCE, newestPage)}`,
          };

          // --- consumer side: client's own readers, unmodified ------------
          const head = await fetchHead(endpoint, transport);
          expect(head.head.origin).toBe(formatOrigin(AGENT, SOURCE));
          expect(head.signature).toBeDefined();

          const cold: string[] = [];
          for await (const synced of coldSync(endpoint, { transport })) cold.push(synced.entry.sequence);
          expect(cold).toEqual(["0000000000000001", "0000000000000002"]);

          const returning: string[] = [];
          for await (const synced of returningSync(endpoint, { sequence: "0000000000000001", entry: sealJson(entries[0]!.entry).digest }, { transport })) {
            returning.push(synced.entry.sequence);
          }
          expect(returning).toEqual(["0000000000000002"]);

          // The head is revalidated, not re-downloaded, on the second read.
          await fetchHead(endpoint, transport);
          expect(transport.stats().revalidations).toBeGreaterThanOrEqual(1);

          // --- subscribe, disconnect, resume ------------------------------
          const streamTransport = createSseStreamTransport(BASE, fetchLike, { reconnectDelayMs: 1 });
          const delivered: unknown[] = [];
          const first = subscribe({
            streamTransport,
            url: `${BASE}/sources/${SOURCE}/tail`,
            onAnnouncement: (event) => delivered.push(event),
            onObservation: (raw) => delivered.push(raw),
          });
          tail.publish("observation", JSON.stringify({ specversion: "1.0", type: "observation", id: "o1" }));
          await waitFor(() => delivered.length === 1, "the first delivered event");
          first.close();

          tail.publish("observation", JSON.stringify({ specversion: "1.0", type: "observation", id: "o2" }));

          const resumed: unknown[] = [];
          const second = subscribe({
            streamTransport,
            url: `${BASE}/sources/${SOURCE}/tail?cursor=0000000000000001`,
            onAnnouncement: (event) => resumed.push(event),
            onObservation: (raw) => resumed.push(raw),
          });
          await waitFor(() => resumed.length === 1, "the resumed event");
          second.close();
          expect((resumed[0] as { id: string }).id).toBe("o2");

          // --- cursor-too-old drives the cold-sync path -------------------
          tail.publish("observation", JSON.stringify({ id: "o3" }));
          tail.publish("observation", JSON.stringify({ id: "o4" }));

          const errors: unknown[] = [];
          const third = subscribe({
            streamTransport,
            url: `${BASE}/sources/${SOURCE}/tail?cursor=0000000000000001`,
            onAnnouncement: () => undefined,
            onObservation: () => undefined,
            onError: (error) => errors.push(error),
          });
          await waitFor(() => errors.length === 1, "the cursor-too-old terminal event");
          third.close();

          const terminal = errors[0] as SseTerminalError;
          expect(terminal.terminal).toBe("cursor-too-old");
          expect(terminal.coldSync?.head).toBe(headPath(SOURCE));

          // The named cold-sync path is fetchable and re-walks the chain.
          const recovered: string[] = [];
          for await (const synced of coldSync(endpoint, { transport })) recovered.push(synced.entry.sequence);
          expect(recovered).toEqual(["0000000000000001", "0000000000000002"]);
        });
      });
      ```

- [ ] Run it and watch it fail before the implementation gaps are closed:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/loopback.integration.test.ts
      ```

      Expected on the first run: a failure inside the test itself (fixture wiring), not a
      missing export — every module it imports exists by now. Fix only the test until it
      passes; if a production module genuinely needs a change, that change is a finding, not
      a silent edit.

- [ ] Write the mount-contract test at
      `packages/discovery/transport-http/src/mount.integration.test.ts`, proving the handler
      mounts on a real Hono app under one route and cannot reach a sibling:

      ```ts
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { Hono } from "hono";
      import { afterEach, beforeEach, describe, expect, it } from "vitest";
      import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

      import { createFsBlobStore } from "./fs-blob-store.js";
      import { createArchiveHttpHandler } from "./handler.js";

      // The mount contract the operator API server consumes at cutover stage 4
      // (wiring itself is stage 4's job, not this plan's): the handler is a
      // plain `(Request) => Promise<Response>`, so one Hono route carries the
      // whole public archive subtree, and every other route on the same app
      // stays on the authenticated surface. Cross-plan contract 7 is a
      // property of the handler, not of the mount: even mounted at `/*` it
      // answers nothing outside the archive grammar.
      describe("archive handler mounted on a Hono app", () => {
        let root: string;

        beforeEach(async () => {
          root = await mkdtemp(join(tmpdir(), "jinn-transport-http-mount-"));
        });

        afterEach(async () => {
          await rm(root, { recursive: true, force: true });
        });

        it("serves the archive subtree and leaks no sibling route", async () => {
          const store = createFsBlobStore(root);
          await store.put(WELL_KNOWN_PATH, new TextEncoder().encode('{"protocol":"x","sources":[]}'), "application/json");

          const handler = createArchiveHttpHandler({ reader: store, basePath: "/v1/archive" });
          const app = new Hono();
          app.get("/v1/status", (c) => c.json({ secret: "operator-only" }));
          app.all("/v1/archive", (c) => handler(c.req.raw));
          app.all("/v1/archive/*", (c) => handler(c.req.raw));

          const served = await app.request(`http://host/v1/archive${WELL_KNOWN_PATH}`);
          expect(served.status).toBe(200);
          expect(await served.json()).toEqual({ protocol: "x", sources: [] });

          for (const path of [
            "/v1/archive/v1/status",
            "/v1/archive/../v1/status",
            "/v1/archive/",
            "/v1/archive/sources",
          ]) {
            const response = await app.request(`http://host${path}`);
            expect([404, 301, 308], path).toContain(response.status);
            if (response.status === 200) throw new Error(`archive mount leaked ${path}`);
          }

          // The sibling route still works for the host itself.
          const status = await app.request("http://host/v1/status");
          expect(status.status).toBe(200);
        });
      });
      ```

- [ ] Run both integration suites and watch them pass:

      ```bash
      cd packages/discovery/transport-http && yarn vitest run src/loopback.integration.test.ts src/mount.integration.test.ts
      ```

      Expected: `Test Files  2 passed (2)`.

- [ ] Commit:

      ```bash
      git add packages/discovery/transport-http/src
      git commit -m "test(transport-http): loopback archive round-trip and Hono mount-contract integration"
      ```

---

## Task 14 — File the discovery-design §9.4 dated addendum

**Files**

- Modify: `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`
- Test: none (a documentation edit; verified by the grep below)

**Interfaces**

- Consumes: nothing.
- Produces: the dated addendum note the program's §7 follow-ups registry assigns to this
  train ("the discovery §9.4 dated addendum (SSE — file with stage 0's transport-http
  train)"), discharging composition design §12 item 4 under the designs-are-law rule.

**Steps**

- [ ] In `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`, locate
      §9.4 "Delivery modes" and append this paragraph immediately after the section's
      existing final paragraph (the one ending "aligned with TEP's `watch` semantics."),
      verbatim:

      ```markdown
      **Addendum 2026-07-30 — the pull-tail's one normative HTTP profile is fixed.** This
      section left the pull-tail transport open ("long-poll / WebSocket / SSE — one normative
      HTTP profile fixed at implementation"). The operator-daemon composition design
      ([`2026-07-30-operator-daemon-composition-design.md`](./2026-07-30-operator-daemon-composition-design.md))
      §7.3 ruling 3 closes it: the pull-tail is **Server-Sent Events with `Last-Event-ID`
      carrying the relay cursor** — the boring standard for a server-to-client append-only
      feed (auto-reconnect, plain HTTP, stateless horizontal scale); WebSocket is justified
      only by mid-stream client-to-server messages, and this protocol's filters are set at
      subscribe time. The §9.3 five-case cursor contract maps onto SSE as typed terminal
      events (`unknown-cursor` and `cursor-too-old`, the latter naming the cold-sync path)
      followed by stream close, and each source advertises its bounded replay window in the
      well-known discovery document (§7 item 3). The same ruling fixes the rest of the
      archive wire profile — `ETag`/`If-None-Match` conditional GET on the head,
      `Cache-Control: immutable` on digest paths and archive pages, declared
      `Accept-Ranges: bytes` on blobs — and explicitly rejects TUF's role machinery and OCI's
      registry API for this layer. Implemented by
      `packages/discovery/transport-http/` per
      [`../plans/2026-07-30-discovery-transport-http.md`](../plans/2026-07-30-discovery-transport-http.md).
      Nothing else in this design changes; §9.4's optional push mode and its WebSub-style
      challenge-echo handshake are untouched.
      ```

- [ ] Verify the note landed in §9.4 and nowhere else:

      ```bash
      grep -n "Addendum 2026-07-30" docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md
      awk '/^### 9.4 Delivery modes/,/^### 9.5/' docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md | grep -c "Last-Event-ID"
      ```

      Expected: exactly one `Addendum 2026-07-30` line, and the `awk` slice reporting `2`
      (the addendum names `Last-Event-ID` twice).

- [ ] Commit:

      ```bash
      git add docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md
      git commit -m "docs(discovery): record the §9.4 pull-tail closure as SSE with Last-Event-ID"
      ```

---

## Task 15 — Full-tree verification and completion checklist

**Files**

- Modify: `packages/discovery/transport-http/README.md`
- Test: the whole discovery tree

**Interfaces**

- Consumes: everything above.
- Produces: a README describing the package's surface and the component-completion evidence.

**Steps**

- [ ] Write `packages/discovery/transport-http/README.md`, covering: the package's role (the
      discovery tree's production HTTP adapter), the four exported factories with their
      signatures, the §7.3 wire profile it implements clause by clause, the mount contract
      (`app.all(base + "/*", (c) => handler(c.req.raw))`), the exposure-scoping property
      (closed path grammar), and an explicit statement that bind-host and public-exposure
      decisions belong to the host. No installation instructions beyond `yarn install` —
      this package is not published yet (#2293).

- [ ] Run the package's own full gate:

      ```bash
      cd packages/discovery/transport-http && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
      ```

      Expected: zero typecheck errors; every suite green; `dist/` emitted with no `.test.`
      files; the pack smoke printing
      `Installed package imports, dependency boundary, and dist shape verified.`

- [ ] Run the guard trio from the repository root:

      ```bash
      node --test .github/scripts/record-discovery-package-inventory.test.mjs
      node --test .github/scripts/record-discovery-source-boundaries.test.mjs
      node .github/scripts/record-discovery-packed-types.test.mjs
      ```

      Expected: `# fail 0` on both `node --test` runs, and
      `Compiled a packed TypeScript consumer against 10 public code entrypoints across all 10 record discovery packages.`

- [ ] Re-run the three sibling packages this tree types against, to prove nothing regressed:

      ```bash
      (cd packages/discovery/protocol && yarn test)
      (cd packages/discovery/serve && yarn test)
      (cd packages/discovery/client && yarn test)
      ```

      Expected: all three green.

- [ ] Walk the completion checklist and confirm each row against the tasks above. Every row
      must be checkable by pointing at a task and a passing test:

      | Spec clause | Requirement | Discharged by |
      | --- | --- | --- |
      | §6.2 | Filesystem `BlobStore` | Task 4 (`createFsBlobStore`; atomic temp+rename, digest-path immutability, root confinement) |
      | §6.2 | HTTP handler over `serve`'s static layout | Tasks 5–6 (`parseArchivePath` + `createArchiveHttpHandler`) |
      | §6.2 | Host-mounted, one process, no second listener by default | Task 13 mount test (one Hono route; no listener created by this package) |
      | §6.2 / contract 7 | Public-subtree-only exposure scoping | Task 5 (closed grammar) + Task 6 (404 default) + Task 13 (no-sibling-leak assertion) |
      | §6.2 | Opt-in separate bind available | **Host-owned** — this package binds nothing; the handler works behind either listener |
      | §6.2 | Client `Transport` | Task 10 (`createHttpTransport`) |
      | §6.2 | Client `StreamTransport` | Task 11 (`createSseStreamTransport`) |
      | §6.2 | Ping | Task 12 (`createHttpPingTransport`; Finding F4 records the producer-side scoping) |
      | §7.3 | `ETag`/`If-None-Match` conditional GET on the head | Task 6 (handler 304 path) + Task 10 (transport revalidation) |
      | §7.3 | `Cache-Control: immutable` on digest paths | Task 6 |
      | §7.3 | `Cache-Control: immutable` on archive pages | Task 6, sealed pages only — **Finding F2**, disposition recorded |
      | §7.3 | Declared `Accept-Ranges: bytes` on blobs | Task 6 (declared *and* honored, incl. 416) |
      | §7.3 | SSE with `Last-Event-ID` carrying the relay cursor | Tasks 7–8 (server) + Task 11 (client) |
      | §7.3 / §9.3 | Five-case cursor contract as typed terminal events, then close | Task 7 (`runSubscribeConformance`) + Task 8 (`unknown-cursor`, `cursor-too-old`) |
      | §7.3 | `cursor-too-old` names the cold-sync path | Task 8 (`coldSync` payload) + Task 13 (recovery walk) |
      | §7.3 | Each source advertises its bounded replay window in the well-known document | Task 9 — **Finding F3**, disposition recorded |
      | §7.3 | TUF roles and the OCI registry API rejected | No such code exists in this tree; the addendum (Task 14) records the rejection |
      | Program §5 | Exported factory names | Tasks 4, 6, 10, 11 (names asserted by `pack:smoke`) |
      | Program §6 guard rule | Guard trio ships with the tree | Tasks 1–3 |
      | Program §7 | Discovery §9.4 dated addendum filed with this train | Task 14 |

- [ ] Commit:

      ```bash
      git add packages/discovery/transport-http/README.md
      git commit -m "docs(transport-http): document the archive transport surface and mount contract"
      ```

- [ ] Request the independent per-component review the program's global constraints require,
      carrying Findings F1–F5 and their proposed dispositions into the review thread. Do not
      let dependent work (cutover stages 1 and 4) build on this tree before the review's
      findings are resolved.

## Coordinator amendments (2026-07-30, binding on execution)

All five findings ratified as proposed: F1 (three-file `fetch` allowlist with staleness
assertion, blanket ban intact elsewhere); F2 (`immutable` on sealed pages via the injected
`isSealedPage` predicate, ETag + `no-cache` on the newest page — the composition spec §7.3
carries the dated refinement); F3 (replay-window field typed here, promotion into `serve` as
a follow-up); F4 (producer-side ping only); F5 (optional `ArchiveTailSource`, 404 absent).
The dual `serve`+`client` production dependency is accepted with the inventory-guard
justification comment.
