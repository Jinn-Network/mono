# Cutover Stage 4 — Discovery Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the operator's local record-discovery archive as a public, scope-limited HTTP surface (SSE tail + ETag head), retire the peer-sync loop, the ERC-8004 SolverNet registry client, and the whole of `client/src/discovery/`, and surface evidence/indexing health in the operator app.

**Architecture:** Stages 1–3 already built the projector loop (which maintains the local archive) and the evidence driver (which publishes and announces into it). This stage adds only a *read* surface over that archive and deletes the readers it replaces. The archive is mounted twice from one route table: on the main operator API app (always, localhost) and — only when the operator opts in — on a **separate listener** whose Hono app contains the archive routes and nothing else. That separation, not per-route middleware, is how "only the archive subtree is public" is enforced and tested. Retirement is consumer-by-consumer: each of the ~19 production consumers of `client/src/discovery/` is re-pointed at a named replacement before the tree is deleted.

**Tech Stack:** TypeScript / Node 22 / Yarn workspaces with `portal:` resolution; Hono (`@hono/node-server`); vitest; `@jinn-network/record-discovery-{protocol,serve,client,testing}`; `@jinn-network/record-discovery-transport-http` (stage 0); `@jinn-network/marketplace-venue-base` (stage 0).

## Global Constraints

- Branch target: `integration/evidence-v1`. Stacked PRs, one train. The stage ends in exactly **one deploy PR** carrying the drain-runbook checklist and the rollback statement; **operator-approved, no agent self-merge**.
- Depends on cutover stage 3 being complete and its testnet gate green. PRs #2306 / #2307 / #2308 are merged.
- The runtime consumes stack packages via in-repo `portal:` links. Nothing here publishes to npm (#2293 runs in parallel and is not a gate).
- Every task ends with `yarn typecheck` + `yarn test` + `yarn lint:no-late-mount` run locally, outputs shown.
- **Cross-plan contract 7 (binding):** public subtree only; opt-in non-localhost bind; IP-disclosure copy where the opt-in lives.
- **Cross-plan contract 6 (binding):** the evidence driver publishes only records already sealed for delivery/announcement — never capability-grant material or secret-forwards; idempotent by digest; announce-after-indexed.
- **Cross-plan contract 10 (binding):** every retiring flow drains before its swap; stragglers strand loudly, never silently.
- American English throughout. No emoji in any product, docs, or marketing surface. No helper-text cruft in the SPA (`CLAUDE.md` §Frontends — "Show, don't narrate").
- Softened-brutalist radii; `BRAND.md` voice; plain speech wherever the operator's IP exposure is on the line.
- Operator-app deltas land **with** their `client/OPERATOR-APP-SPEC.md` update in the same PR.

---

## Cross-Plan Interface Assumptions

This plan composes two stage-0 packages authored by sibling plans. The signatures below are what this plan depends on, derived from the program plan §5 factory-surface ruling. **If a shipped signature differs, adapt it inside `client/src/archive/handler.ts` (Task 2) only — no other task changes.** Record any adaptation as a finding in the deploy PR.

```ts
// @jinn-network/record-discovery-transport-http
export function createFsBlobStore(rootDir: string): BlobStore;              // BlobStore is serve's put-only port
export function createArchiveHttpHandler(opts: {
  rootDir: string;                       // the fs root createFsBlobStore writes into
  tail?: ArchiveTailFeed;                // omit to serve without an SSE tail
}): (request: Request) => Promise<Response>;
export function createHttpTransport(baseUrl: string, fetchLike: typeof fetch): Transport;
export function createSseStreamTransport(baseUrl: string, fetchLike: typeof fetch): StreamTransport;
```

`ArchiveTailFeed` is **host-owned** and defined in Task 2 — the operator runtime owns the append side (the evidence driver appends; the handler only reads).

Facts the implementation must respect, verified in the tree at `8c7179f2c`:

- `packages/discovery/serve/src/ports.ts` `BlobStore` is **`put`-only**. There is no read port anywhere in `serve`. The HTTP handler reads the filesystem root directly; that is why `createArchiveHttpHandler` takes `rootDir` and not a `BlobStore`.
- Serving paths are pinned in `packages/discovery/protocol/src/identifiers.ts`:
  `/.well-known/jinn-record-discovery`, `/sources/<name>/head`,
  `/sources/<name>/entries/<16-digit-seq>`, `/records/<64-hex>` (the `sha256:` prefix is **stripped** in the path).
- `packages/discovery/client/src/ports.ts` declares `Transport` with a **quoted** method name (`"fetch"`). It takes a URL only — no method, headers, or abort signal — and **no caller inspects `status`** (`client/src/sync.ts:73-76`). A 404 that returns an HTML body therefore surfaces as a JSON parse error deep inside `fetchHead`. Task 3 closes that by making unmatched archive subpaths return a JSON 404, never the SPA index.
- `SOURCE_NAME_GRAMMAR = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/`; `SEQUENCE_WIDTH = 16`.
- The `packages/discovery/**` ambient-network guard (`.github/scripts/record-discovery-source-boundaries.test.mjs`) does **not** cover `client/`. Host code may call the global `fetch`.

---

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `packages/discovery/testing/src/serving-plane.ts` | `runServingPlaneConformance` — the kit's first transport-shaped suite. |
| `client/src/archive/handler.ts` | Composes `createFsBlobStore` + `createArchiveHttpHandler`; owns `ArchiveTailFeed`. The single adaptation point for the transport-http surface. |
| `client/src/archive/tail.ts` | In-memory bounded `ArchiveTailFeed` with `Last-Event-ID` replay and the five-case cursor contract. |
| `client/src/archive/status.ts` | `ArchiveStatus` / `IndexingStatus` assembly for `/v1/status`. |
| `client/src/api/archive-routes.ts` | `addArchiveRoutes(app, opts)` — the one archive route table, mounted on both apps. |
| `client/src/api/public-archive-server.ts` | `startPublicArchiveServer(opts)` — the separate opt-in listener. |
| `client/src/plugins/publication-reader.ts` | Plugin publication / score / builder-artifact reads over venue-base's log source. |
| `client/src/dashboard/spa/src/pages/operator/ArchiveCard.tsx` | Archive exposure opt-in + IP-disclosure copy + indexing status. |
| `client/test/e2e/archive-second-daemon.ts` | The stage gate: one daemon serves, a second consumes. |

**Modified**

| Path | Change |
| --- | --- |
| `client/src/api/server.ts` | Mount `addArchiveRoutes`; add archive prefixes to the SPA-fallback 404 guard; return the public-listener handle. |
| `client/src/api/gather-status.ts` | Add `archive` + `indexing`; drop `DiscoveryAPI`. |
| `client/src/api/discovery-endpoint.ts` | Re-point three plugin routes; delete two SolverNet routes. |
| `client/src/config.ts` | Add `archive.*`; delete `discovery.*` and `peers`. |
| `client/src/main.ts` | Delete the DiscoveryAPI construction site + holder; wire the archive. |
| `client/src/daemon/daemon.ts` | Delete peer-sync start/stop/watchdog registration. |
| `client/OPERATOR-APP-SPEC.md` | New §2.15 Record Archive; §2.11 + §2.13 deltas. |
| `CLAUDE.md` | Config-table rows: remove `discovery.*` / `peers`, add `archive.*`. |

**Deleted**

`client/src/discovery/` (6 files, 4 655 lines) · `client/test/discovery/` (~19 files) · `client/src/daemon/peer-sync.ts` · `client/src/solvernets/registry-client.ts` · `client/src/solvernets/registry-client-erc8004.ts` · `client/src/solvernets/most-recent-wins.ts` · `client/src/erc8004/identity.ts`'s `resolveAgentIdForManifest` · `client/test/architecture/core-corpus-http-ownership.test.ts`.

---

### Task 1: Live-surface conformance suite in the discovery kit

The kit has six `run*Conformance` suites and **none of them is transport-shaped** — no suite accepts a URL, a `Transport`, or a server handle (verified: zero hits for `baseUrl|serverUrl|localhost|listen(` under `packages/discovery/testing/`). The stage gate "discovery kit green against the live surface" cannot be met without adding one. It belongs in the kit, not in `client/`, because it is the kit's job to define what a conforming serving plane is.

**Files:**
- Create: `packages/discovery/testing/src/serving-plane.ts`
- Modify: `packages/discovery/testing/src/index.ts`
- Test: `packages/discovery/testing/src/serving-plane.test.ts`

**Interfaces:**
- Consumes: `Transport`, `StreamTransport` shapes (structurally re-declared — the kit must not depend on `client`); `WELL_KNOWN_PATH`, `recordPath`, `headPath`, `archivePagePath` from `@jinn-network/record-discovery-protocol`.
- Produces:
  ```ts
  export interface ServingPlaneUnderTest {
    /** Absolute base URL the serving paths resolve against, no trailing slash. */
    baseUrl: string;
    /** Raw conditional-GET probe. The kit needs headers, which `Transport` cannot express. */
    request(path: string, headers?: Record<string, string>): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
    }>;
    /** Opens the SSE tail. `lastEventId` maps to the `Last-Event-ID` request header. */
    tail?(lastEventId: string | undefined): Promise<{
      events: AsyncIterable<{ id?: string; event?: string; data: string }>;
      close(): void;
    }>;
    /** Paths that MUST NOT be reachable on this plane. Empty array skips the scoping block. */
    forbiddenPaths?: readonly string[];
  }
  export function runServingPlaneConformance(plane: ServingPlaneUnderTest): void;
  ```

- [ ] **Step 1: Write the failing test**

`packages/discovery/testing/src/serving-plane.test.ts` — an in-memory fake serving plane that the suite must accept, plus a mutant that must fail.

```ts
import { describe, expect, it } from "vitest";
import { runServingPlaneConformance, type ServingPlaneUnderTest } from "./serving-plane.js";

// A minimal in-memory plane: one source "feed", one page, one record.
function makeFakePlane(overrides: Partial<Record<string, { status: number; headers: Record<string, string>; body: Uint8Array }>> = {}): ServingPlaneUnderTest {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const recordBytes = new TextEncoder().encode('{"kind":"test"}');
  const digestHex = "a".repeat(64); // the fake plane declares its own digest map
  const routes: Record<string, { status: number; headers: Record<string, string>; body: Uint8Array }> = {
    "/.well-known/jinn-record-discovery": {
      status: 200,
      headers: { "content-type": "application/vnd.jinn.record-discovery.well-known.v1+json" },
      body: enc({
        protocol: "https://jinn.network/record-discovery/1.0",
        sources: [{ agent: "did:web:example", name: "feed", headPath: "/sources/feed/head", archiveRoot: "/sources/feed/entries/0000000000000001" }],
      }),
    },
    "/sources/feed/head": {
      status: 200,
      headers: { "content-type": "application/vnd.jinn.record-discovery.head.v1+json", etag: '"seq-1"' },
      body: enc({ payloadType: "application/vnd.dsse+json", payload: "e30=", signatures: [] }),
    },
    "/sources/feed/entries/0000000000000001": {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable" },
      body: enc({ protocol: "https://jinn.network/record-discovery/1.0", source: "feed", page: "0000000000000001", prevArchive: null, entries: [] }),
    },
    [`/records/${digestHex}`]: {
      status: 200,
      headers: { "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes" },
      body: recordBytes,
    },
    ...overrides,
  };
  return {
    baseUrl: "http://plane.test",
    async request(path, headers) {
      const hit = routes[path];
      if (!hit) return { status: 404, headers: { "content-type": "application/json" }, body: enc({ error: "not_found" }) };
      if (path === "/sources/feed/head" && headers?.["if-none-match"] === '"seq-1"') {
        return { status: 304, headers: { etag: '"seq-1"' }, body: new Uint8Array() };
      }
      return hit;
    },
    forbiddenPaths: ["/v1/status"],
  };
}

describe("runServingPlaneConformance", () => {
  describe("accepts a conforming plane", () => {
    runServingPlaneConformance(makeFakePlane());
  });

  it("rejects a head that ignores If-None-Match", async () => {
    // The mutant always 200s. Assert directly rather than nesting a failing suite.
    const plane = makeFakePlane();
    const mutant: ServingPlaneUnderTest = {
      ...plane,
      request: async (p) => (p === "/sources/feed/head"
        ? { status: 200, headers: { etag: '"seq-1"' }, body: new Uint8Array([1]) }
        : plane.request(p)),
    };
    const conditional = await mutant.request("/sources/feed/head", { "if-none-match": '"seq-1"' });
    expect(conditional.status).not.toBe(304);
  });

  it("rejects a plane that serves a forbidden path", async () => {
    const plane = makeFakePlane({ "/v1/status": { status: 200, headers: {}, body: new Uint8Array() } });
    const forbidden = await plane.request("/v1/status");
    expect(forbidden.status).toBe(200); // documents the mutant; the suite's own block would fail on it
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/discovery/testing && yarn vitest run src/serving-plane.test.ts`
Expected: FAIL — `Cannot find module './serving-plane.js'`.

- [ ] **Step 3: Write the suite**

`packages/discovery/testing/src/serving-plane.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

export interface ServingPlaneResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ServingPlaneTailEvent {
  id?: string;
  event?: string;
  data: string;
}

export interface ServingPlaneUnderTest {
  baseUrl: string;
  request(path: string, headers?: Record<string, string>): Promise<ServingPlaneResponse>;
  tail?(lastEventId: string | undefined): Promise<{
    events: AsyncIterable<ServingPlaneTailEvent>;
    close(): void;
  }>;
  forbiddenPaths?: readonly string[];
}

const IMMUTABLE = /\bimmutable\b/;

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function runServingPlaneConformance(plane: ServingPlaneUnderTest): void {
  describe("serving plane — well-known document (§7)", () => {
    it("serves the well-known document with the profile media type", async () => {
      const res = await plane.request(WELL_KNOWN_PATH);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("record-discovery.well-known");
      const doc = decode(res.body) as { protocol: string; sources: Array<{ name: string; headPath: string; archiveRoot: string }> };
      expect(doc.protocol).toBe("https://jinn.network/record-discovery/1.0");
      expect(doc.sources.length).toBeGreaterThan(0);
    });
  });

  describe("serving plane — head is the only mutable object (§7.3)", () => {
    it("returns an ETag on the head", async () => {
      const doc = decode((await plane.request(WELL_KNOWN_PATH)).body) as { sources: Array<{ headPath: string }> };
      const res = await plane.request(doc.sources[0]!.headPath);
      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toBeTruthy();
    });

    it("answers a matching If-None-Match with 304 and an empty body", async () => {
      const doc = decode((await plane.request(WELL_KNOWN_PATH)).body) as { sources: Array<{ headPath: string }> };
      const first = await plane.request(doc.sources[0]!.headPath);
      const second = await plane.request(doc.sources[0]!.headPath, { "if-none-match": first.headers["etag"]! });
      expect(second.status).toBe(304);
      expect(second.body.byteLength).toBe(0);
    });
  });

  describe("serving plane — immutable objects (§7.3)", () => {
    it("marks archive pages immutable", async () => {
      const doc = decode((await plane.request(WELL_KNOWN_PATH)).body) as { sources: Array<{ archiveRoot: string }> };
      const res = await plane.request(doc.sources[0]!.archiveRoot);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"] ?? "").toMatch(IMMUTABLE);
    });
  });

  describe("serving plane — unknown paths fail typed, not as HTML (§7)", () => {
    it("returns a JSON 404 for an unknown archive page", async () => {
      const res = await plane.request("/sources/feed/entries/0000000000000099");
      expect(res.status).toBe(404);
      expect(res.headers["content-type"] ?? "").toContain("json");
    });

    it("returns a JSON 404 for an unknown record digest", async () => {
      const res = await plane.request(`/records/${"f".repeat(64)}`);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"] ?? "").toContain("json");
    });
  });

  if (plane.forbiddenPaths && plane.forbiddenPaths.length > 0) {
    describe("serving plane — exposure scoping", () => {
      for (const path of plane.forbiddenPaths) {
        it(`does not serve ${path}`, async () => {
          const res = await plane.request(path);
          expect(res.status).toBe(404);
        });
      }
    });
  }

  if (plane.tail) {
    describe("serving plane — SSE tail cursor contract (§7.3, five cases)", () => {
      it("opens a live tail with no Last-Event-ID", async () => {
        const sub = await plane.tail!(undefined);
        sub.close();
      });

      it("closes with a typed cursor-unknown event for a never-issued cursor", async () => {
        const sub = await plane.tail!("cursor-that-was-never-issued-or-is-in-the-future");
        const seen: ServingPlaneTailEvent[] = [];
        for await (const ev of sub.events) seen.push(ev);
        sub.close();
        expect(seen.at(-1)?.event).toBe("cursor-unknown");
      });

      it("closes with cursor-too-old and names the cold-sync path", async () => {
        const sub = await plane.tail!("0000000000000000");
        const seen: ServingPlaneTailEvent[] = [];
        for await (const ev of sub.events) seen.push(ev);
        sub.close();
        const terminal = seen.at(-1);
        expect(terminal?.event).toBe("cursor-too-old");
        // The `subscribe-cursor-older-than-window` vector carries `namesColdSyncPath: true`
        // but `runSubscribeConformance` never asserts it. This suite does.
        expect(JSON.parse(terminal!.data)).toHaveProperty("coldSyncPath");
      });
    });
  }
}
```

- [ ] **Step 4: Export the suite**

`packages/discovery/testing/src/index.ts` — append:

```ts
export * from "./serving-plane.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/discovery/testing && yarn vitest run && yarn tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/discovery/testing/src/serving-plane.ts packages/discovery/testing/src/serving-plane.test.ts packages/discovery/testing/src/index.ts
git commit -m "test(discovery): add runServingPlaneConformance live-surface suite"
```

---

### Task 2: Archive handler composition + the tail feed

The one place the operator runtime touches `record-discovery-transport-http`. If the shipped signature differs from the Cross-Plan Interface Assumptions, adapt here and nowhere else.

**Files:**
- Create: `client/src/archive/handler.ts`, `client/src/archive/tail.ts`
- Test: `client/test/archive/tail.test.ts`, `client/test/archive/handler.test.ts`

**Interfaces:**
- Consumes: `createFsBlobStore`, `createArchiveHttpHandler` (see Cross-Plan Interface Assumptions).
- Produces:
  ```ts
  // client/src/archive/tail.ts
  export interface TailSink {
    event(id: string, data: string): void;
    terminal(code: 'cursor-unknown' | 'cursor-too-old', detail: { coldSyncPath: string }): void;
  }
  export interface ArchiveTailFeed {
    readonly replayWindow: number;
    append(event: { id: string; data: string }): void;
    subscribe(lastEventId: string | undefined, sink: TailSink): { close(): void };
  }
  export function createArchiveTailFeed(opts: { replayWindow?: number; coldSyncPath: string }): ArchiveTailFeed;

  // client/src/archive/handler.ts
  export interface OperatorArchive {
    rootDir: string;
    sourceName: string;
    tail: ArchiveTailFeed;
    handler: (request: Request) => Promise<Response>;
  }
  export function createOperatorArchive(opts: {
    rootDir: string;
    sourceName: string;
    replayWindow?: number;
  }): OperatorArchive;
  ```

- [ ] **Step 1: Write the failing tail test**

`client/test/archive/tail.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createArchiveTailFeed, type TailSink } from '../../src/archive/tail.js';

function collectingSink() {
  const events: Array<{ id: string; data: string }> = [];
  const terminals: Array<{ code: string; detail: { coldSyncPath: string } }> = [];
  const sink: TailSink = {
    event: (id, data) => events.push({ id, data }),
    terminal: (code, detail) => terminals.push({ code, detail }),
  };
  return { sink, events, terminals };
}

const COLD = '/.well-known/jinn-record-discovery';

describe('createArchiveTailFeed', () => {
  it('delivers appends to a live subscriber with no cursor', () => {
    const feed = createArchiveTailFeed({ coldSyncPath: COLD });
    const { sink, events } = collectingSink();
    feed.subscribe(undefined, sink);
    feed.append({ id: '0000000000000001', data: '{"a":1}' });
    expect(events).toEqual([{ id: '0000000000000001', data: '{"a":1}' }]);
  });

  it('does not replay history to a live subscriber', () => {
    const feed = createArchiveTailFeed({ coldSyncPath: COLD });
    feed.append({ id: '0000000000000001', data: '{"a":1}' });
    const { sink, events } = collectingSink();
    feed.subscribe(undefined, sink);
    expect(events).toEqual([]);
  });

  it('replays from a known cursor, exclusive of the cursor itself', () => {
    const feed = createArchiveTailFeed({ coldSyncPath: COLD });
    feed.append({ id: '0000000000000001', data: 'a' });
    feed.append({ id: '0000000000000002', data: 'b' });
    const { sink, events } = collectingSink();
    feed.subscribe('0000000000000001', sink);
    expect(events).toEqual([{ id: '0000000000000002', data: 'b' }]);
  });

  it('terminates with cursor-unknown for a cursor never issued', () => {
    const feed = createArchiveTailFeed({ coldSyncPath: COLD });
    feed.append({ id: '0000000000000001', data: 'a' });
    const { sink, terminals } = collectingSink();
    feed.subscribe('not-a-cursor', sink);
    expect(terminals).toEqual([{ code: 'cursor-unknown', detail: { coldSyncPath: COLD } }]);
  });

  it('terminates with cursor-too-old once the cursor has fallen out of the window', () => {
    const feed = createArchiveTailFeed({ replayWindow: 2, coldSyncPath: COLD });
    feed.append({ id: '0000000000000001', data: 'a' });
    feed.append({ id: '0000000000000002', data: 'b' });
    feed.append({ id: '0000000000000003', data: 'c' });
    const { sink, terminals } = collectingSink();
    feed.subscribe('0000000000000001', sink);
    expect(terminals).toEqual([{ code: 'cursor-too-old', detail: { coldSyncPath: COLD } }]);
  });

  it('stops delivering after close', () => {
    const feed = createArchiveTailFeed({ coldSyncPath: COLD });
    const { sink, events } = collectingSink();
    const sub = feed.subscribe(undefined, sink);
    sub.close();
    feed.append({ id: '0000000000000001', data: 'a' });
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/archive/tail.test.ts`
Expected: FAIL — `Cannot find module '../../src/archive/tail.js'`.

- [ ] **Step 3: Implement the tail feed**

`client/src/archive/tail.ts`:

```ts
/**
 * Bounded, in-memory SSE tail feed for the record-discovery archive.
 *
 * The evidence driver appends; the HTTP handler subscribes. The five-case
 * cursor contract (record-discovery design §9.4, closed as SSE +
 * `Last-Event-ID` by the composition design §7.3) maps as:
 *
 *   no cursor                  -> live tail from now
 *   cursor "oldest"            -> start of the retained window
 *   cursor inside the window   -> replay then live
 *   cursor evicted from window -> terminal `cursor-too-old`
 *   cursor never issued        -> terminal `cursor-unknown`
 *
 * Both terminal events name the cold-sync path so a consumer can recover
 * without guessing.
 */
export interface TailSink {
  event(id: string, data: string): void;
  terminal(code: 'cursor-unknown' | 'cursor-too-old', detail: { coldSyncPath: string }): void;
}

export interface ArchiveTailFeed {
  readonly replayWindow: number;
  append(event: { id: string; data: string }): void;
  subscribe(lastEventId: string | undefined, sink: TailSink): { close(): void };
}

const DEFAULT_REPLAY_WINDOW = 1024;

export function createArchiveTailFeed(opts: {
  replayWindow?: number;
  coldSyncPath: string;
}): ArchiveTailFeed {
  const replayWindow = opts.replayWindow ?? DEFAULT_REPLAY_WINDOW;
  const window: Array<{ id: string; data: string }> = [];
  const issued = new Set<string>();
  const live = new Set<TailSink>();

  return {
    replayWindow,

    append(event) {
      issued.add(event.id);
      window.push(event);
      while (window.length > replayWindow) window.shift();
      for (const sink of live) sink.event(event.id, event.data);
    },

    subscribe(lastEventId, sink) {
      const detail = { coldSyncPath: opts.coldSyncPath };

      if (lastEventId !== undefined) {
        if (lastEventId === 'oldest') {
          for (const e of window) sink.event(e.id, e.data);
        } else if (!issued.has(lastEventId)) {
          sink.terminal('cursor-unknown', detail);
          return { close: () => {} };
        } else {
          const at = window.findIndex((e) => e.id === lastEventId);
          if (at === -1) {
            sink.terminal('cursor-too-old', detail);
            return { close: () => {} };
          }
          for (const e of window.slice(at + 1)) sink.event(e.id, e.data);
        }
      }

      live.add(sink);
      return {
        close: () => {
          live.delete(sink);
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run the tail tests**

Run: `cd client && yarn vitest run test/archive/tail.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing handler test**

`client/test/archive/handler.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOperatorArchive } from '../../src/archive/handler.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jinn-archive-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('createOperatorArchive', () => {
  it('rejects a source name that violates the protocol grammar', () => {
    expect(() => createOperatorArchive({ rootDir: root, sourceName: 'Not Valid' })).toThrow(
      /source name/i,
    );
  });

  it('exposes a fetch-style handler and a tail the driver can append to', async () => {
    const archive = createOperatorArchive({ rootDir: root, sourceName: 'marketplace' });
    expect(archive.sourceName).toBe('marketplace');
    expect(typeof archive.handler).toBe('function');
    archive.tail.append({ id: '0000000000000001', data: '{}' });
    const res = await archive.handler(new Request('http://local/records/' + 'f'.repeat(64)));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd client && yarn vitest run test/archive/handler.test.ts`
Expected: FAIL — `Cannot find module '../../src/archive/handler.js'`.

- [ ] **Step 7: Implement the composition module**

`client/src/archive/handler.ts`:

```ts
import { mkdirSync } from 'node:fs';
import {
  createFsBlobStore,
  createArchiveHttpHandler,
} from '@jinn-network/record-discovery-transport-http';
import { createArchiveTailFeed, type ArchiveTailFeed } from './tail.js';

/**
 * The one place the operator runtime binds to
 * `@jinn-network/record-discovery-transport-http`. If that package's factory
 * signature differs from what this module expects, adapt it HERE — every other
 * module in the stage-4 train depends on `OperatorArchive`, not on the package.
 */

/** Pinned in `@jinn-network/record-discovery-protocol` (`SOURCE_NAME_GRAMMAR`). */
const SOURCE_NAME_GRAMMAR = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const WELL_KNOWN_PATH = '/.well-known/jinn-record-discovery';

export interface OperatorArchive {
  rootDir: string;
  sourceName: string;
  tail: ArchiveTailFeed;
  handler: (request: Request) => Promise<Response>;
}

export function createOperatorArchive(opts: {
  rootDir: string;
  sourceName: string;
  replayWindow?: number;
}): OperatorArchive {
  if (!SOURCE_NAME_GRAMMAR.test(opts.sourceName)) {
    throw new Error(
      `invalid archive source name ${JSON.stringify(opts.sourceName)} — must match ${SOURCE_NAME_GRAMMAR}`,
    );
  }
  mkdirSync(opts.rootDir, { recursive: true });

  const tail = createArchiveTailFeed({
    replayWindow: opts.replayWindow,
    coldSyncPath: WELL_KNOWN_PATH,
  });

  // The fs blob store is the projector/evidence-driver WRITE side; the handler
  // reads the same root. `BlobStore` is put-only by design (serve/src/ports.ts).
  createFsBlobStore(opts.rootDir);

  const handler = createArchiveHttpHandler({ rootDir: opts.rootDir, tail });

  return { rootDir: opts.rootDir, sourceName: opts.sourceName, tail, handler };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/archive/ && yarn typecheck`
Expected: PASS (8 tests), zero type errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/archive client/test/archive
git commit -m "feat(archive): compose the transport-http handler and the SSE tail feed"
```

---

### Task 3: Mount the archive subtree on the operator API

Mounted at the protocol's absolute paths (they are derivable from identity alone and must not be prefixed — `record-discovery-client`'s `sync.ts` builds URLs as `servingRoot + headPath(name)`). The route helper is named `*-routes.ts` under `client/src/api/` so `yarn lint:no-late-mount` accepts it.

**Files:**
- Create: `client/src/api/archive-routes.ts`
- Modify: `client/src/api/server.ts` (route mount + SPA-fallback 404 guard)
- Test: `client/test/api/archive-routes.test.ts`

**Interfaces:**
- Consumes: `OperatorArchive` from `client/src/archive/handler.ts` (Task 2).
- Produces: `export function addArchiveRoutes(app: Hono, opts: { archive: OperatorArchive }): void` — registers `GET /.well-known/jinn-record-discovery`, `GET /sources/:name/head`, `GET /sources/:name/entries/:page`, `GET /records/:digest`, and a JSON-404 catch-all for `/sources/*` and `/records/*`.
- Produces: `ARCHIVE_PATH_PREFIXES: readonly string[] = ['/.well-known/', '/sources/', '/records/']` — consumed by `server.ts`'s SPA fallback.

- [ ] **Step 1: Write the failing test**

`client/test/api/archive-routes.test.ts`:

```ts
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addArchiveRoutes, ARCHIVE_PATH_PREFIXES } from '../../src/api/archive-routes.js';
import { createOperatorArchive } from '../../src/archive/handler.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jinn-archive-routes-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeApp() {
  const app = new Hono();
  const archive = createOperatorArchive({ rootDir: root, sourceName: 'marketplace' });
  addArchiveRoutes(app, { archive });
  return { app, archive };
}

describe('addArchiveRoutes', () => {
  it('routes the four protocol serving paths to the archive handler', async () => {
    const { app } = makeApp();
    for (const path of [
      '/.well-known/jinn-record-discovery',
      '/sources/marketplace/head',
      '/sources/marketplace/entries/0000000000000001',
      `/records/${'a'.repeat(64)}`,
    ]) {
      const res = await app.request(path);
      // An empty archive 404s; the point is that the route MATCHED (no HTML).
      expect(res.headers.get('content-type') ?? '').toContain('json');
    }
  });

  it('returns a JSON 404 — never HTML — for an unmatched archive subpath', async () => {
    const { app } = makeApp();
    const res = await app.request('/sources/marketplace/entries/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').toContain('json');
    await expect(res.json()).resolves.toHaveProperty('error');
  });

  it('publishes the prefixes the SPA fallback must exclude', () => {
    expect(ARCHIVE_PATH_PREFIXES).toEqual(['/.well-known/', '/sources/', '/records/']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/api/archive-routes.test.ts`
Expected: FAIL — `Cannot find module '../../src/api/archive-routes.js'`.

- [ ] **Step 3: Implement the route table**

`client/src/api/archive-routes.ts`:

```ts
import type { Hono } from 'hono';
import type { OperatorArchive } from '../archive/handler.js';

/**
 * Path prefixes owned by the record-discovery archive. `server.ts`'s SPA
 * fallback must 404 (JSON) on these rather than returning the SPA index:
 * `record-discovery-client`'s `Transport.fetch` does not inspect the response
 * status, so an HTML body surfaces as a JSON parse error deep inside
 * `fetchHead` instead of a legible 404.
 */
export const ARCHIVE_PATH_PREFIXES = ['/.well-known/', '/sources/', '/records/'] as const;

export function addArchiveRoutes(app: Hono, opts: { archive: OperatorArchive }): void {
  const serve = (c: { req: { raw: Request } }): Promise<Response> =>
    opts.archive.handler(c.req.raw);

  app.get('/.well-known/jinn-record-discovery', (c) => serve(c));
  app.get('/sources/:name/head', (c) => serve(c));
  app.get('/sources/:name/entries/:page', (c) => serve(c));
  app.get('/records/:digest', (c) => serve(c));

  // Typed 404 for anything else under an archive prefix.
  app.all('/sources/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/records/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));
}
```

- [ ] **Step 4: Mount on the operator API server**

`client/src/api/server.ts` — add the import beside the other route-helper imports:

```ts
import { addArchiveRoutes, ARCHIVE_PATH_PREFIXES } from './archive-routes.js';
```

Extend `ApiServerConfig` with:

```ts
  /**
   * The operator's record-discovery archive. When present, the archive subtree
   * is served on this app (localhost). Public exposure is a SEPARATE listener
   * — see `startPublicArchiveServer`. Never widen this app's bind host to
   * expose the archive.
   */
  archive?: OperatorArchive;
```

Register immediately after `addActivityEventsRoutes(app, { store })` (before any `*` fallback):

```ts
  if (config.archive) {
    addArchiveRoutes(app, { archive: config.archive });
  }
```

Extend the SPA fallback's exclusion list (`app.get('*', ...)`):

```ts
    if (
      path.startsWith('/v1') ||
      path.startsWith('/artifacts') ||
      path.startsWith('/auth') ||
      path.startsWith('/api') ||
      path.startsWith('/assets') ||
      ARCHIVE_PATH_PREFIXES.some((p) => path.startsWith(p))
    ) {
      return c.notFound();
    }
```

- [ ] **Step 5: Run tests + the late-mount guard**

Run: `cd client && yarn vitest run test/api/archive-routes.test.ts test/api/ && yarn lint:no-late-mount && yarn typecheck`
Expected: PASS; guard prints `✓ No late route mounts detected`.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/archive-routes.ts client/src/api/server.ts client/test/api/archive-routes.test.ts
git commit -m "feat(api): mount the record-discovery archive subtree on the operator API"
```

---

### Task 4: The opt-in public archive listener and its exposure scoping

The main operator API app carries public routes today — `GET /v1/status`, `GET /artifacts/search`, `GET /artifacts/:id/content`, `GET /`, `GET /assets/:filename`, `POST /api/stop-hook`, and the SPA fallback are reachable without auth, held safe only by the `127.0.0.1` bind. Widening *that* bind to publish the archive would expose all of them. Contract 7 is therefore satisfied structurally: a **second Hono app containing only `addArchiveRoutes` plus a catch-all 404**, on its own listener. The main API's bind host is never touched.

**Files:**
- Create: `client/src/api/public-archive-server.ts`
- Modify: `client/src/config.ts` (the `archive` block), `client/src/main.ts` (wiring)
- Test: `client/test/api/public-archive-server.test.ts`, `client/test/config/archive-config.test.ts`

**Interfaces:**
- Consumes: `addArchiveRoutes`, `ARCHIVE_PATH_PREFIXES` (Task 3); `OperatorArchive` (Task 2).
- Produces:
  ```ts
  export interface PublicArchiveServer { host: string; port: number; close(): Promise<void> }
  export function buildPublicArchiveApp(opts: { archive: OperatorArchive }): Hono;
  export function startPublicArchiveServer(opts: {
    archive: OperatorArchive; host: string; port: number;
  }): Promise<PublicArchiveServer>;
  ```
- Produces (config): `archive: { rootDir: string; sourceName: string; replayWindow: number; publicBind: { enabled: boolean; host: string; port: number } }`.

- [ ] **Step 1: Write the failing security test**

`client/test/api/public-archive-server.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPublicArchiveApp } from '../../src/api/public-archive-server.js';
import { createOperatorArchive } from '../../src/archive/handler.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jinn-public-archive-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/**
 * Every route the MAIN operator API serves without authentication. None of
 * them may be reachable on the public archive plane. Cross-plan contract 7.
 */
const FORBIDDEN = [
  '/',
  '/v1/status',
  '/assets/index.js',
  '/artifacts/search',
  '/artifacts/some-id/content',
  '/api/stop-hook',
  '/auth/handshake',
  '/v1/discovery/plugin-publications',
  '/v1/bootstrap',
  '/v1/operator/joined',
  '/api/admin/restart',
  '/some/deep/spa/route',
];

describe('public archive plane exposure scoping', () => {
  function app() {
    return buildPublicArchiveApp({
      archive: createOperatorArchive({ rootDir: root, sourceName: 'marketplace' }),
    });
  }

  for (const path of FORBIDDEN) {
    it(`does not serve ${path}`, async () => {
      const res = await app().request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').toContain('json');
      const text = await res.text();
      expect(text).not.toContain('<!doctype html');
      expect(text).not.toContain('<html');
    });
  }

  it('rejects non-GET methods on the archive paths', async () => {
    const res = await app().request('/sources/marketplace/head', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('matches the archive serving paths', async () => {
    const res = await app().request('/.well-known/jinn-record-discovery');
    expect(res.headers.get('content-type') ?? '').toContain('json');
  });
});
```

`client/test/config/archive-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('archive config', () => {
  it('defaults the public bind to disabled', () => {
    const cfg = loadConfig({ configPath: undefined, env: {} });
    expect(cfg.archive.publicBind.enabled).toBe(false);
  });

  it('reads the public bind from the config FILE, not only from env', () => {
    // Regression guard: `apiBindHost` shipped inert because main.ts read only
    // JINN_API_BIND_HOST and ignored the config field. Do not repeat it.
    const cfg = loadConfig({
      configObject: { archive: { publicBind: { enabled: true, host: '0.0.0.0', port: 7400 } } },
      env: {},
    });
    expect(cfg.archive.publicBind).toEqual({ enabled: true, host: '0.0.0.0', port: 7400 });
  });

  it('lets env override the config file', () => {
    const cfg = loadConfig({
      configObject: { archive: { publicBind: { enabled: true, host: '0.0.0.0', port: 7400 } } },
      env: { JINN_ARCHIVE_BIND_HOST: '127.0.0.1', JINN_ARCHIVE_PORT: '7500' },
    });
    expect(cfg.archive.publicBind.host).toBe('127.0.0.1');
    expect(cfg.archive.publicBind.port).toBe(7500);
  });
});
```

> Adapt `loadConfig`'s call shape to the loader's actual signature in `client/src/config.ts` — the assertions, not the invocation style, are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/api/public-archive-server.test.ts test/config/archive-config.test.ts`
Expected: FAIL — missing module; `cfg.archive` undefined.

- [ ] **Step 3: Add the config block**

`client/src/config.ts` — inside the config schema, beside `apiPort`:

```ts
  archive: z
    .object({
      /** Filesystem root the projector + evidence driver write the archive into. */
      rootDir: z.string().default(join(homedir(), '.jinn-client', 'discovery', 'archive')),
      /** Protocol source name. Must match SOURCE_NAME_GRAMMAR. */
      sourceName: z.string().default('marketplace'),
      /** Entries retained for `Last-Event-ID` replay on the SSE tail. */
      replayWindow: z.number().int().positive().default(1024),
      /**
       * Public exposure of the archive. Off by default. When enabled, the
       * archive is served on a SEPARATE listener carrying no other route.
       * Serving from a residential connection discloses the operator's IP to
       * every consumer — the operator app says so where the opt-in lives.
       */
      publicBind: z
        .object({
          enabled: z.boolean().default(false),
          host: z.string().default('0.0.0.0'),
          port: z.number().int().positive().default(7332),
        })
        .default({}),
    })
    .default({}),
```

Env merge, beside the other env overrides:

```ts
  if (env['JINN_ARCHIVE_DIR']) merged.archive = { ...merged.archive, rootDir: env['JINN_ARCHIVE_DIR'] };
  if (env['JINN_ARCHIVE_SOURCE_NAME']) merged.archive = { ...merged.archive, sourceName: env['JINN_ARCHIVE_SOURCE_NAME'] };
  if (env['JINN_ARCHIVE_BIND_HOST']) {
    merged.archive = {
      ...merged.archive,
      publicBind: { ...merged.archive?.publicBind, enabled: true, host: env['JINN_ARCHIVE_BIND_HOST'] },
    };
  }
  if (env['JINN_ARCHIVE_PORT']) {
    merged.archive = {
      ...merged.archive,
      publicBind: { ...merged.archive?.publicBind, port: Number(env['JINN_ARCHIVE_PORT']) },
    };
  }
```

- [ ] **Step 4: Implement the public listener**

`client/src/api/public-archive-server.ts`:

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server as HttpServer } from 'node:http';
import { addArchiveRoutes } from './archive-routes.js';
import type { OperatorArchive } from '../archive/handler.js';

/**
 * The public archive plane.
 *
 * Exposure scoping (cross-plan contract 7) is structural, not middleware-based:
 * this app carries `addArchiveRoutes` and a catch-all 404, and nothing else.
 * The operator API app — which serves `/v1/status`, `/artifacts/*`, the SPA and
 * its assets without authentication — keeps its own listener on 127.0.0.1 and
 * is never widened to publish the archive.
 */
export interface PublicArchiveServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export function buildPublicArchiveApp(opts: { archive: OperatorArchive }): Hono {
  const app = new Hono();
  addArchiveRoutes(app, { archive: opts.archive });
  app.all('*', (c) => {
    const method = c.req.method;
    const path = c.req.path;
    const isArchivePath =
      path === '/.well-known/jinn-record-discovery' ||
      path.startsWith('/sources/') ||
      path.startsWith('/records/');
    if (isArchivePath && method !== 'GET' && method !== 'HEAD') {
      return c.json({ error: 'method_not_allowed' }, 405);
    }
    return c.json({ error: 'not_found' }, 404);
  });
  return app;
}

export function startPublicArchiveServer(opts: {
  archive: OperatorArchive;
  host: string;
  port: number;
}): Promise<PublicArchiveServer> {
  const app = buildPublicArchiveApp({ archive: opts.archive });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      console.log(
        `[archive] Public archive plane listening on ${opts.host}:${actualPort} — this discloses your IP address to consumers`,
      );
      resolve({
        host: opts.host,
        port: actualPort,
        close: () => new Promise<void>((res) => (server as HttpServer).close(() => res())),
      });
    });
    server.on('error', reject);
  });
}
```

- [ ] **Step 5: Wire it in `main.ts`**

Beside the `startApiServer` call, after the archive is constructed:

```ts
  const archive = createOperatorArchive({
    rootDir: config.archive.rootDir,
    sourceName: config.archive.sourceName,
    replayWindow: config.archive.replayWindow,
  });

  // Read from CONFIG with env override already applied by the loader — never
  // re-read the env here. (`apiBindHost` shipped inert by doing exactly that.)
  let publicArchive: PublicArchiveServer | undefined;
  if (config.archive.publicBind.enabled) {
    publicArchive = await startPublicArchiveServer({
      archive,
      host: config.archive.publicBind.host,
      port: config.archive.publicBind.port,
    });
  }
```

Pass `archive` into `startApiServer({ ..., archive })` and close `publicArchive` in the shutdown path beside the API server close.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/api/public-archive-server.test.ts test/config/ && yarn typecheck && yarn lint:no-late-mount`
Expected: PASS (15 tests in the scoping suite), zero type errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/api/public-archive-server.ts client/src/config.ts client/src/main.ts client/test/api/public-archive-server.test.ts client/test/config/archive-config.test.ts
git commit -m "feat(archive): opt-in public archive listener with structural exposure scoping"
```

---

### Task 5: Run the discovery kit against the live mount

The Task-1 suite, driven against the real Hono app in-process. This is half of the stage gate; Task 6 is the other half.

**Files:**
- Test: `client/test/archive/serving-plane-conformance.test.ts`
- Modify: `client/package.json` (add `@jinn-network/record-discovery-testing` as a devDependency via `portal:`)

**Interfaces:**
- Consumes: `runServingPlaneConformance`, `ServingPlaneUnderTest` (Task 1); `buildPublicArchiveApp` (Task 4); `createOperatorArchive` (Task 2).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the conformance driver**

`client/test/archive/serving-plane-conformance.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';
import {
  runServingPlaneConformance,
  type ServingPlaneUnderTest,
} from '@jinn-network/record-discovery-testing';
import { buildPublicArchiveApp } from '../../src/api/public-archive-server.js';
import { createOperatorArchive } from '../../src/archive/handler.js';
import { seedArchiveFixture } from './_seed-archive.js';

const root = mkdtempSync(join(tmpdir(), 'jinn-archive-conf-'));
const archive = createOperatorArchive({ rootDir: root, sourceName: 'marketplace', replayWindow: 2 });
// Writes one head, one archive page, and three records through the same
// `record-discovery-serve` writers the evidence driver uses.
await seedArchiveFixture(archive);
const app = buildPublicArchiveApp({ archive });

const plane: ServingPlaneUnderTest = {
  baseUrl: 'http://plane.local',
  async request(path, headers) {
    const res = await app.request(`http://plane.local${path}`, { headers });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { out[k] = v; });
    return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
  },
  async tail(lastEventId) {
    const res = await app.request('http://plane.local/sources/marketplace/tail', {
      headers: lastEventId === undefined ? {} : { 'last-event-id': lastEventId },
    });
    return { events: parseSse(res.body!), close: () => { void res.body?.cancel(); } };
  },
  forbiddenPaths: ['/v1/status', '/artifacts/search', '/', '/assets/index.js', '/api/stop-hook'],
};

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<{ id?: string; event?: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame: { id?: string; event?: string; data: string } = { data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data += line.slice(5).trim();
      }
      yield frame;
    }
  }
}

describe('operator archive — record-discovery serving-plane conformance', () => {
  runServingPlaneConformance(plane);
});

rmSync(root, { recursive: true, force: true });
```

- [ ] **Step 2: Write the seed helper**

`client/test/archive/_seed-archive.ts` — drives `record-discovery-serve`'s writers so the fixture is produced the same way the evidence driver produces the real thing:

```ts
import {
  writeRecord,
  writeArchivePages,
  maintainHead,
  writeWellKnownDocument,
  type SignedEntry,
} from '@jinn-network/record-discovery-serve';
import { createFsBlobStore } from '@jinn-network/record-discovery-transport-http';
import type { OperatorArchive } from '../../src/archive/handler.js';

export async function seedArchiveFixture(archive: OperatorArchive): Promise<void> {
  const store = createFsBlobStore(archive.rootDir);
  const entries: SignedEntry[] = [];
  for (const payload of ['{"n":1}', '{"n":2}', '{"n":3}']) {
    const { digest } = await writeRecord(store, new TextEncoder().encode(payload), 'application/json');
    entries.push({
      entry: {
        protocol: 'https://jinn.network/record-discovery/1.0',
        source: archive.sourceName,
        sequence: String(entries.length + 1).padStart(16, '0'),
        items: [{ digest, kind: 'test' }],
      } as SignedEntry['entry'],
    });
  }
  await writeArchivePages(store, archive.sourceName, entries);
  await maintainHead(
    store,
    undefined, // unpublished profile: bare SourceHead, no DSSE signer needed for the wire-profile suite
    { now: () => new Date('2026-07-30T00:00:00Z') },
    { agent: 'did:web:operator.test', name: archive.sourceName },
    {
      protocol: 'https://jinn.network/record-discovery/1.0',
      origin: `did:web:operator.test/${archive.sourceName}`,
      sequence: '0000000000000003',
      entry: entries.at(-1)!.entry.items[0]!.digest,
      issuedAt: '2026-07-30T00:00:00Z',
      refreshBy: '2026-07-30T12:00:00Z',
    },
  );
  await writeWellKnownDocument(store, {
    protocol: 'https://jinn.network/record-discovery/1.0',
    sources: [{
      agent: 'did:web:operator.test',
      name: archive.sourceName,
      headPath: `/sources/${archive.sourceName}/head`,
      archiveRoot: `/sources/${archive.sourceName}/entries/0000000000000001`,
    }],
  });
  for (const e of entries) archive.tail.append({ id: e.entry.sequence, data: JSON.stringify(e.entry) });
}
```

> If `SignedEntry`'s `entry` shape differs from the sketch above, take the shape from `packages/discovery/protocol/src/` — the fixture must be a real `AnnouncementEntry`, not a cast.

- [ ] **Step 3: Add the kit as a devDependency**

`client/package.json` — under `devDependencies`:

```json
"@jinn-network/record-discovery-testing": "portal:../packages/discovery/testing"
```

Run: `cd client && yarn install`

- [ ] **Step 4: Run the conformance suite**

Run: `cd client && yarn vitest run test/archive/serving-plane-conformance.test.ts`
Expected: PASS — well-known, ETag/304, immutable pages, typed 404s, five forbidden paths, three cursor cases.

- [ ] **Step 5: Commit**

```bash
git add client/test/archive/serving-plane-conformance.test.ts client/test/archive/_seed-archive.ts client/package.json ../yarn.lock
git commit -m "test(archive): run the discovery serving-plane kit against the live mount"
```

---

### Task 6: Second-daemon consumption e2e — the stage gate

"Archive consumable by a second daemon." One process serves; a second, holding no shared state beyond the URL, cold-syncs, verifies, retrieves records by digest, resumes from its high-water mark, and receives a live tail event.

**Files:**
- Create: `client/test/e2e/archive-second-daemon.ts`
- Create: `client/test/archive/second-daemon.test.ts` (the CI-runnable in-process half)
- Modify: `client/package.json` (`e2e:archive-second-daemon` script)

**Interfaces:**
- Consumes: `startPublicArchiveServer` (Task 4); `seedArchiveFixture` (Task 5); `createHttpTransport`, `createSseStreamTransport` from `@jinn-network/record-discovery-transport-http`; `fetchHead`, `coldSync`, `returningSync`, `createInMemoryHighWaterMarkStore`, `subscribe` from `@jinn-network/record-discovery-client`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing consumption test**

`client/test/archive/second-daemon.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHttpTransport,
  createSseStreamTransport,
} from '@jinn-network/record-discovery-transport-http';
import { fetchHead, coldSync, returningSync, subscribe } from '@jinn-network/record-discovery-client';
import { createOperatorArchive, type OperatorArchive } from '../../src/archive/handler.js';
import { startPublicArchiveServer, type PublicArchiveServer } from '../../src/api/public-archive-server.js';
import { seedArchiveFixture, appendOneRecord } from './_seed-archive.js';

let root: string;
let archive: OperatorArchive;
let server: PublicArchiveServer;
let servingRoot: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jinn-daemon-a-'));
  archive = createOperatorArchive({ rootDir: root, sourceName: 'marketplace' });
  await seedArchiveFixture(archive);
  server = await startPublicArchiveServer({ archive, host: '127.0.0.1', port: 0 });
  servingRoot = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

/** Daemon B holds nothing but the URL. */
function daemonB() {
  const transport = createHttpTransport(servingRoot, fetch);
  return {
    transport,
    endpoint: {
      agent: 'did:web:operator.test',
      name: 'marketplace',
      servingRoot,
      archiveRootUrl: `${servingRoot}/sources/marketplace/entries/0000000000000001`,
    },
  };
}

describe('second-daemon archive consumption', () => {
  it('fetches the head from the serving root alone', async () => {
    const { transport, endpoint } = daemonB();
    const synced = await fetchHead(endpoint, transport);
    expect(synced.head.origin).toContain('marketplace');
    expect(synced.head.sequence).toMatch(/^[0-9]{16}$/);
  });

  it('cold-syncs every announced entry', async () => {
    const { transport, endpoint } = daemonB();
    const seen: string[] = [];
    for await (const e of coldSync(endpoint, { transport })) seen.push(e.entry.sequence);
    expect(seen).toEqual(['0000000000000001', '0000000000000002', '0000000000000003']);
  });

  it('retrieves each announced record by digest and the bytes re-hash', async () => {
    const { transport, endpoint } = daemonB();
    const { createHash } = await import('node:crypto');
    for await (const e of coldSync(endpoint, { transport })) {
      for (const item of e.entry.items) {
        const hex = item.digest.slice('sha256:'.length);
        const res = await transport['fetch'](`${servingRoot}/records/${hex}`);
        expect(res.status).toBe(200);
        expect(createHash('sha256').update(res.bytes).digest('hex')).toBe(hex);
      }
    }
  });

  it('resumes from a high-water mark and yields only new entries', async () => {
    await appendOneRecord(archive, '{"n":4}');
    const { transport, endpoint } = daemonB();
    const seen: string[] = [];
    for await (const e of returningSync(endpoint, { sequence: '0000000000000003' } as never, { transport })) {
      seen.push(e.entry.sequence);
    }
    expect(seen).toEqual(['0000000000000004']);
  });

  it('receives a live tail event for an entry appended after subscribe', async () => {
    const streamTransport = createSseStreamTransport(servingRoot, fetch);
    const received: unknown[] = [];
    const sub = subscribe({
      streamTransport,
      url: `${servingRoot}/sources/marketplace/tail`,
      onAnnouncement: (ev) => received.push(ev),
      onObservation: () => {},
    });
    await new Promise((r) => setTimeout(r, 100));
    await appendOneRecord(archive, '{"n":5}');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 5_000 });
    sub.close();
  });

  it('serves the archive and nothing else on the public plane', async () => {
    for (const path of ['/v1/status', '/artifacts/search', '/', '/assets/index.js', '/api/stop-hook']) {
      const res = await fetch(`${servingRoot}${path}`);
      expect(res.status).toBe(404);
    }
  });
});
```

Add `appendOneRecord(archive, payload)` to `client/test/archive/_seed-archive.ts` — writes one record, repaginates via `writeArchivePages`, re-signs the head via `maintainHead`, and calls `archive.tail.append`. (`writeArchivePages` is a whole-corpus repaginator, not an append primitive — pass the full accumulated entry list.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/archive/second-daemon.test.ts`
Expected: FAIL — `appendOneRecord` is not exported.

- [ ] **Step 3: Implement `appendOneRecord` and make the suite pass**

Extend `_seed-archive.ts` to track the accumulated `SignedEntry[]` on a module-level `WeakMap<OperatorArchive, SignedEntry[]>` so `appendOneRecord` can repaginate the full set.

Run: `cd client && yarn vitest run test/archive/second-daemon.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Write the operator-run e2e script**

`client/test/e2e/archive-second-daemon.ts` — the same six assertions, but daemon A's archive is produced by the **real evidence driver** rather than the seed helper, so the gate exercises the production write path:

```ts
/**
 * Stage-4 gate: archive consumable by a second daemon (`yarn e2e:archive-second-daemon`).
 *
 * Daemon A boots the production runtime against an Anvil fork (reusing
 * `_daemon-harness-helpers.ts`'s fixture + bootstrap), runs one loop iteration
 * so the projector and evidence driver populate the archive, and exposes the
 * public archive plane on 127.0.0.1:0. Daemon B is a fresh process-local
 * consumer holding only the serving URL.
 */
import { setupAnvilFixture, bootstrapStakedOperator, deployMinimalV3Stack, startMockIpfsServer, startDaemon } from './_daemon-harness-helpers.js';
// ... boot A, wait for >=1 announced entry in the archive, then run the same
// six assertions as test/archive/second-daemon.test.ts against the live plane,
// finishing with runServingPlaneConformance over the same surface.
```

Implement it by importing the shared assertion body from `client/test/archive/second-daemon-assertions.ts` (extract it from the vitest file in this step so the two entry points cannot drift).

- [ ] **Step 5: Add the script**

`client/package.json`:

```json
"e2e:archive-second-daemon": "tsx test/e2e/archive-second-daemon.ts"
```

- [ ] **Step 6: Run the gate**

Run: `cd client && yarn e2e:archive-second-daemon`
Expected: every assertion prints `ok`; the process exits 0. Record the output in the deploy PR.

- [ ] **Step 7: Commit**

```bash
git add client/test/e2e/archive-second-daemon.ts client/test/archive/ client/package.json
git commit -m "test(archive): second-daemon consumption gate"
```

---

### Task 7: Evidence and indexing status on `/v1/status`

The evidence driver (stage 1) drives local-runtime `sync`, publication/announcement, and `awaitIndexed`. Its failures are unowned today. Contract 6's "announce-after-indexed" makes an indexing stall an announcement stall — the operator must see it.

**Files:**
- Create: `client/src/archive/status.ts`
- Modify: `client/src/api/gather-status.ts`, `client/src/daemon/evidence-driver.ts` (stage 1's module)
- Test: `client/test/archive/status.test.ts`, `client/test/api/gather-status-archive.test.ts`

**Interfaces:**
- Consumes: `OperatorArchive` (Task 2); the stage-1 evidence driver's failure record.
- Produces:
  ```ts
  export interface ArchiveStatus {
    sourceName: string;
    sequence: string | null;           // 16-digit head sequence; null before the first head
    entries: number;
    lastPublishedAt: string | null;    // ISO-8601
    publicBind: { host: string; port: number } | null;
    servingUrl: string | null;
  }
  export interface IndexingStatus {
    pendingRecords: number;
    lastIndexedAt: string | null;
    lastError: { code: IndexingErrorCode; message: string; at: string } | null;
  }
  export type IndexingErrorCode = 'index_failed' | 'publish_failed' | 'announce_failed';
  export function buildArchiveStatus(input: { archive: OperatorArchive; publicBind: { host: string; port: number } | null }): ArchiveStatus;
  export function buildIndexingStatus(input: { driver: EvidenceDriverHealth }): IndexingStatus;
  ```
  `/v1/status` gains top-level `archive: ArchiveStatus | null` and `indexing: IndexingStatus | null`.

- [ ] **Step 1: Write the failing test**

`client/test/archive/status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildIndexingStatus, buildArchiveStatus } from '../../src/archive/status.js';

describe('buildIndexingStatus', () => {
  it('reports a clean driver as no error', () => {
    const s = buildIndexingStatus({
      driver: { pending: 0, lastIndexedAt: '2026-07-30T00:00:00Z', lastError: null },
    });
    expect(s).toEqual({ pendingRecords: 0, lastIndexedAt: '2026-07-30T00:00:00Z', lastError: null });
  });

  it('surfaces an announce failure with its code', () => {
    const s = buildIndexingStatus({
      driver: {
        pending: 3,
        lastIndexedAt: '2026-07-30T00:00:00Z',
        lastError: { code: 'announce_failed', message: 'head re-sign rejected', at: '2026-07-30T00:05:00Z' },
      },
    });
    expect(s.pendingRecords).toBe(3);
    expect(s.lastError?.code).toBe('announce_failed');
  });
});

describe('buildArchiveStatus', () => {
  it('reports servingUrl as null when the archive is not publicly bound', () => {
    const s = buildArchiveStatus({
      archive: { rootDir: '/tmp/x', sourceName: 'marketplace', tail: { replayWindow: 8, append() {}, subscribe: () => ({ close() {} }) }, handler: async () => new Response() },
      publicBind: null,
    });
    expect(s.servingUrl).toBeNull();
    expect(s.publicBind).toBeNull();
  });

  it('derives servingUrl from the public bind', () => {
    const s = buildArchiveStatus({
      archive: { rootDir: '/tmp/x', sourceName: 'marketplace', tail: { replayWindow: 8, append() {}, subscribe: () => ({ close() {} }) }, handler: async () => new Response() },
      publicBind: { host: '0.0.0.0', port: 7332 },
    });
    expect(s.servingUrl).toBe('http://0.0.0.0:7332');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/archive/status.test.ts`
Expected: FAIL — `Cannot find module '../../src/archive/status.js'`.

- [ ] **Step 3: Implement the status builders**

`client/src/archive/status.ts` — read the head sequence and entry count off the archive root (`/sources/<name>/head` and the newest page); return `null` fields rather than throwing when the archive has not been written yet.

- [ ] **Step 4: Expose the driver's health**

`client/src/daemon/evidence-driver.ts` — add:

```ts
export interface EvidenceDriverHealth {
  pending: number;
  lastIndexedAt: string | null;
  lastError: { code: 'index_failed' | 'publish_failed' | 'announce_failed'; message: string; at: string } | null;
}
```

and a `health(): EvidenceDriverHealth` accessor. Every `catch` on the sync / publish / announce legs records `lastError` with its code and clears it on the next success. Publication remains idempotent by digest and announcement still happens only after indexing (contract 6) — this task only observes.

- [ ] **Step 5: Thread into `/v1/status`**

`client/src/api/gather-status.ts` — add `archive?: OperatorArchive`, `publicBind?: { host: string; port: number } | null`, and `evidenceDriver?: { health(): EvidenceDriverHealth }` to `StatusGatherConfig`; emit `archive` and `indexing` (both `null` when the input is absent).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/archive/status.test.ts test/api/gather-status-archive.test.ts test/api/gather-status.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/archive/status.ts client/src/api/gather-status.ts client/src/daemon/evidence-driver.ts client/test/archive/status.test.ts client/test/api/gather-status-archive.test.ts
git commit -m "feat(status): surface archive and evidence-indexing health on /v1/status"
```

---

### Task 8: Operator app — archive exposure opt-in and indexing status (with the spec delta)

Deltas only; no redesign. The IP-disclosure copy lives exactly where the opt-in lives, in plain speech (`BRAND.md`: drop the metaphor when safety is on the line). No caption text that restates a rendered value (`CLAUDE.md` §Frontends).

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator/ArchiveCard.tsx`, `ArchiveCard.test.tsx`
- Modify: `client/src/dashboard/spa/src/pages/operator/NetworkTab.tsx`, `client/src/dashboard/spa/src/api/types.ts`, `client/src/dashboard/spa/src/notifications/taxonomy.ts`, `client/src/dashboard/spa/src/notifications/derive.ts`, `client/OPERATOR-APP-SPEC.md`

**Interfaces:**
- Consumes: `ArchiveStatus`, `IndexingStatus` from `/v1/status` (Task 7).
- Produces: notification kind `indexing_degraded` (severity `warning`), appended to `CANONICAL_KINDS`.

- [ ] **Step 1: Write the failing component test**

`client/src/dashboard/spa/src/pages/operator/ArchiveCard.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArchiveCard } from './ArchiveCard.js';

const offline = { sourceName: 'marketplace', sequence: '0000000000000004', entries: 4, lastPublishedAt: '2026-07-30T00:00:00Z', publicBind: null, servingUrl: null };
const clean = { pendingRecords: 0, lastIndexedAt: '2026-07-30T00:00:00Z', lastError: null };

describe('ArchiveCard', () => {
  it('states the IP disclosure where the opt-in lives', () => {
    render(<ArchiveCard archive={offline} indexing={clean} />);
    expect(screen.getByText(/your IP address/i)).toBeInTheDocument();
    expect(screen.getByText(/mirror/i)).toBeInTheDocument();
  });

  it('shows the serving URL once the archive is publicly bound', () => {
    render(<ArchiveCard archive={{ ...offline, publicBind: { host: '0.0.0.0', port: 7332 }, servingUrl: 'http://0.0.0.0:7332' }} indexing={clean} />);
    expect(screen.getByText('http://0.0.0.0:7332')).toBeInTheDocument();
  });

  it('raises an indexing state message when the driver has a last error', () => {
    render(<ArchiveCard archive={offline} indexing={{ pendingRecords: 3, lastIndexedAt: null, lastError: { code: 'announce_failed', message: 'head re-sign rejected', at: '2026-07-30T00:05:00Z' } }} />);
    expect(screen.getByText(/records are waiting to be announced/i)).toBeInTheDocument();
  });

  it('renders an explicit zero-state, never a blank panel', () => {
    render(<ArchiveCard archive={{ ...offline, sequence: null, entries: 0, lastPublishedAt: null }} indexing={clean} />);
    expect(screen.getByText(/no records published yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client/src/dashboard/spa && yarn vitest run src/pages/operator/ArchiveCard.test.tsx`
Expected: FAIL — `Cannot find module './ArchiveCard.js'`.

- [ ] **Step 3: Implement the card**

`ArchiveCard.tsx`, composed from existing shadcn primitives already in the SPA (`Card`, `Badge`, `Switch`, `Alert`). Copy, verbatim:

- Heading: `Record archive`
- Values rendered as label + value: source name, head sequence, entries, last published.
- Zero state: `No records published yet. The evidence driver publishes here as work completes.`
- Opt-in control label: `Serve this archive publicly`
- Disclosure paragraph, directly under the control:
  `Serving publicly means anyone who fetches your archive learns your IP address. If you are on a home connection and would rather not disclose it, publish the archive files to a mirror or a static host instead — the archive is plain files and needs no Jinn software to serve.`
- Restart note: `Restart required to apply.`
- Indexing message (`lastError` non-null): `${pendingRecords} records are waiting to be announced. Last error: ${message}` — severity warning; no action (the driver retries).

No emoji, no gradients, `--radius-3` on the card.

- [ ] **Step 4: Mount in the Network tab and add the notification kind**

`NetworkTab.tsx` — render `<ArchiveCard archive={status.archive} indexing={status.indexing} />` beneath the RPC section.
`notifications/taxonomy.ts` — append `'indexing_degraded'` to `CANONICAL_KINDS`.
`notifications/derive.ts` — derive it from a non-null `indexing.lastError`, severity `warning`, `jumpTo: '/operator/network'`.
`api/types.ts` — add `archive?: ArchiveStatus | null; indexing?: IndexingStatus | null` to the status response type.

- [ ] **Step 5: Write the OPERATOR-APP-SPEC delta**

`client/OPERATOR-APP-SPEC.md`:

- New `### 2.15 Record Archive` after §2.14, on the four axes:
  - **Static** — source name; head sequence; entry count; last published; public serving URL (or "not served publicly").
  - **Streams** — none. The archive's own entries are protocol data, not an operator event stream.
  - **Actions** — *serve publicly* (`idle → saving → saved (restart pending)`, terminal `failed`); *stop serving publicly* (same lifecycle). Both restart-required (§3.2).
  - **State messages** — `indexing_degraded` (warning; records pending announcement, driver retries, no operator action); `archive empty` (info; explicit zero-state copy, never a blank panel); `serving publicly` (info; names the IP disclosure and the mirror alternative).
- §2.11 Settings: delete the `peer list` Static entry; replace the *task posts* State entry's `DiscoveryAPI.getTaskPostCounts` source with the projector's observation store (Task 11), and delete the closing paragraph about `discovery.fallbackToOnchain` (the read-API layer no longer exists).
- §2.13: delete the **Peers** optional component (peer-sync retires in Task 9).
- §2.10 Notifications: add `indexing_degraded`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client/src/dashboard/spa && yarn vitest run && cd ../../../.. && yarn --cwd client vitest run test/dashboard/`
Expected: PASS. Grep case-insensitively for any other test asserting the removed Settings peer-list copy: `grep -rin "peer list" client/src client/test`.

- [ ] **Step 7: Commit**

```bash
git add client/src/dashboard/spa/src client/OPERATOR-APP-SPEC.md
git commit -m "feat(operator-app): archive exposure opt-in, indexing status, spec delta"
```

---

### Task 9: Retire peer-sync

Once the operator serves a signed discovery archive, envelope gossip is subsumed (design §4). Drain first (contract 10): the loop stops accepting new work and any in-flight `acquireContent` completes before the swap.

**Files:**
- Delete: `client/src/daemon/peer-sync.ts`
- Modify: `client/src/daemon/daemon.ts`, `client/src/config.ts`, `client/src/main.ts`, `client/scripts/check-no-late-route-mount.mjs`, `client/ARCHITECTURE.md`, `docs/implementation-status-draft.md`, `CLAUDE.md`
- Test: `client/test/daemon/daemon-loops.test.ts` (existing)

**Interfaces:**
- Consumes: nothing.
- Produces: `peers` disappears from `JinnConfig`; `'peer-sync'` disappears from the watchdog's started-loop set.

- [ ] **Step 1: Write the failing test**

Add to `client/test/daemon/daemon-loops.test.ts`:

```ts
it('never starts a peer-sync loop', async () => {
  const daemon = makeTestDaemon({ /* existing helper */ });
  await daemon.start();
  expect(daemon.startedLoops()).not.toContain('peer-sync');
  await daemon.stop();
});
```

And a config test in `client/test/config/archive-config.test.ts`:

```ts
it('no longer carries a peers key', () => {
  const cfg = loadConfig({ configObject: { peers: ['http://x'] }, env: {} }) as Record<string, unknown>;
  expect(cfg['peers']).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/daemon/daemon-loops.test.ts test/config/archive-config.test.ts`
Expected: FAIL — `peer-sync` present; `peers` still parsed.

- [ ] **Step 3: Delete the loop and its wiring**

- `rm client/src/daemon/peer-sync.ts`
- `client/src/daemon/daemon.ts`: remove the `PeerSync` import, the `peers?: string[]` field on `DaemonConfig`, the `private peerSync?` field, the start block (which also re-read `JINN_PEERS` directly — a duplicated env path), the `started.add('peer-sync')` registration, and `this.peerSync?.stop()`.
- `client/src/config.ts`: remove the `peers` schema field and the `JINN_PEERS` env merge.
- `client/src/main.ts`: remove `peers:` from the `Daemon` constructor call.

Keep the `artifacts` and `network_artifacts` tables and `GET /artifacts/*` — the artifact-serving surface is pre-existing operator content and is explicitly not retired here (`spec/2026-04-30-phase-a-umbrella.md`). Only the *sync loop* goes.

- [ ] **Step 4: Clean the stale references**

- `client/scripts/check-no-late-route-mount.mjs:22`: delete the `client/src/api/peers.ts (peer-sync subsystem; calls app.use)` allowlist comment — the file has not existed since the daemon/api cycle break, and `PeerSync` never called `app.use`.
- `client/ARCHITECTURE.md:165,280` and `docs/implementation-status-draft.md:126`: delete the `api/peers.ts (PeerSync)` entries.
- `CLAUDE.md`: delete the `peers` / `JINN_PEERS` config-table row and the `peer-sync` loop from the seven-loop list.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn vitest run && yarn typecheck && yarn lint:no-late-mount`
Expected: PASS; zero references — verify with `grep -rn "PeerSync\|peer-sync\|JINN_PEERS" client/src client/scripts CLAUDE.md`.

- [ ] **Step 6: Commit**

```bash
git add -A client/src client/scripts client/ARCHITECTURE.md docs/implementation-status-draft.md CLAUDE.md
git commit -m "refactor(daemon): retire the peer-sync loop, subsumed by the signed archive"
```

---

### Task 10: Carve the plugin-publication read path out of `discovery/`

Design §9 retires the SolverNet registry client at this stage but explicitly **preserves** the plugin content commands (publish / read / feedback / block / revoke) — their disposition belongs to the plugin session. Their read path currently lives inside `client/src/discovery/{http,onchain}.ts` (`listPluginPublications`, `getPluginScores`, `listBuilderArtifacts`), which this stage deletes. Without this carve-out, deleting `discovery/` breaks the Build page and three CLI verbs. **Finding, disposition: carve out (Task 10), do not defer.**

**Files:**
- Create: `client/src/plugins/publication-reader.ts`
- Modify: `client/src/api/discovery-endpoint.ts`, `client/src/cli/commands/solver-plugins.ts`, `client/src/cli/commands/solver-plugins-read.ts`, `client/src/cli/commands/solver-plugins-feedback.ts`
- Test: `client/test/plugins/publication-reader.test.ts`

**Interfaces:**
- Consumes: venue-base's log source (`createBaseVenue(...).logSource`) — the single chain reader from stage 1; `PLUGIN_METADATA_KEY_PREFIX`, `PLUGIN_PAYLOAD_TUPLE`, `REVOCATION_PAYLOAD_TUPLE` from `client/src/erc8004/`.
- Produces:
  ```ts
  export interface PluginPublicationReader {
    listPluginPublications(q: { limit?: number; publisher?: string }): Promise<PluginPublication[]>;
    listBuilderArtifacts(q: { builder: string; limit?: number }): Promise<PublishedArtifact[]>;
    getPluginScores(q: { pluginIds: string[] }): Promise<PluginScoreHistoryRow[]>;
  }
  export function createPluginPublicationReader(deps: { logSource: VenueLogSource; identityRegistry: Address }): PluginPublicationReader;
  ```
  `PluginPublication`, `PublishedArtifact`, `PluginScoreHistoryRow` move from `client/src/discovery/types.ts` to `client/src/plugins/types.ts` unchanged.

- [ ] **Step 1: Move the row types**

`git mv`-equivalent: copy `PluginPublication`, `PublishedArtifact`, `PluginScoreHistoryRow` and their zod parsers verbatim from `client/src/discovery/types.ts` into a new `client/src/plugins/types.ts`. No shape changes.

- [ ] **Step 2: Write the failing test**

`client/test/plugins/publication-reader.test.ts` — port the existing `MetadataSet` decoding cases from `client/test/discovery/onchain.test.ts` and `http.plugin-publications.test.ts` as fixtures against a fake `logSource` (contract 12: legacy behavior enters as fixtures, never as ported code paths):

```ts
import { describe, expect, it } from 'vitest';
import { createPluginPublicationReader } from '../../src/plugins/publication-reader.js';

const fakeLogSource = {
  async getLogs() {
    return [/* one MetadataSet log under key `plugin:<id>`, taken verbatim from
                the existing onchain.test.ts fixture */];
  },
};

describe('createPluginPublicationReader', () => {
  it('decodes a plugin publication from a MetadataSet log', async () => {
    const reader = createPluginPublicationReader({ logSource: fakeLogSource as never, identityRegistry: '0x00' as never });
    const rows = await reader.listPluginPublications({ limit: 10 });
    expect(rows[0]?.pluginId).toBe(/* the fixture's id */);
  });

  it('drops a publication that a later revocation supersedes', async () => {
    /* the revocation fixture from the existing suite */
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd client && yarn vitest run test/plugins/publication-reader.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the reader over venue-base's log source**

Read `MetadataSet` events under the `plugin:` key prefix through `logSource.getLogs(...)` — the projector's chunked, cursor-backed reader — instead of a second `eth_getLogs` stack. This is the single-broadcaster rule's read-side twin: one chain reader in the process.

- [ ] **Step 5: Re-point the routes and CLI verbs**

`client/src/api/discovery-endpoint.ts`: replace the `DiscoveryAPI` dependency with `PluginPublicationReader` for the three plugin routes. **Delete** `GET /v1/discovery/solvernet-operator-count` (retires with the registry client, Task 12). Leave `GET /v1/discovery/task-post-counts` for Task 11. Keep the `503`-on-unavailable behavior with a reader-local error type replacing `DiscoveryUnavailableError`.

`solver-plugins.ts`: replace `deps.discoveryApiFactory` with `deps.pluginReaderFactory`. `solver-plugins-read.ts` / `-feedback.ts`: import row types from `../../plugins/types.js`; map the reader's error type to the existing CLI error code `discovery_unavailable` (unchanged operator-visible taxonomy).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/plugins/ test/api/discovery-endpoint.test.ts test/cli/commands/solver-plugins-*.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/plugins client/src/api/discovery-endpoint.ts client/src/cli/commands client/test/plugins
git commit -m "refactor(plugins): read publications through the venue log source, not discovery"
```

---

### Task 11: Re-point task-post counts, verdict tallies, and code-digest rewards

Three read surfaces whose only supplier is `client/src/discovery/`, each with an operator-visible consumer that must not regress.

**Files:**
- Create: `client/src/archive/reads.ts`
- Modify: `client/src/api/discovery-endpoint.ts`, `client/src/api/gather-status.ts`, `client/src/api/task-runs-build.ts`, `client/src/learner/verification-gate.ts`, `client/src/mcp/get-codedigest-reward.ts`, `client/src/cli/commands/codedigest-revert-check.ts`, `client/src/api/launcher-tasks.ts`
- Test: `client/test/archive/reads.test.ts`, plus the existing suites for each consumer

**Interfaces:**
- Consumes: the projector's observation store (stage 1) and the local archive's facts index.
- Produces:
  ```ts
  export interface ArchiveReads {
    /** Windowed on-chain task-post counts, from the projector's observations. */
    getTaskPostCounts(q?: { manifestDigests?: string[] }): Promise<TaskPostCounts>;
    /** Verdict tallies per task, from sealed verdict records in the archive. */
    getVerdictTallies(q: { taskIds: string[] }): Promise<VerdictTallyResult>;
    /** Reward rows per code digest, from sealed verdict facts. */
    getCodeDigestRewards(q: { codeDigests: string[]; window?: number }): Promise<CodeDigestRewardRow[]>;
  }
  export class ArchiveReadUnavailableError extends Error { readonly code: 'archive_unavailable' | 'projector_behind' }
  export function createArchiveReads(deps: { observations: ObservationStore; archive: OperatorArchive }): ArchiveReads;
  ```
  `TaskPostCounts`, `VerdictTallyResult`, `CodeDigestRewardRow`, `TaskOnchainStatus`, `TaskStatusSnapshot` move from `client/src/discovery/types.ts` to `client/src/archive/types.ts` **unchanged** — they are the response shapes the SPA already mirrors (`spa/src/api/types.ts:289,951,976`), and changing them here would be a spec change this stage does not own.

- [ ] **Step 1: Write the failing test**

`client/test/archive/reads.test.ts` — port the assertions from `client/test/discovery/{onchain,http}-task-post-counts.test.ts`, `*-verdict-tallies.test.ts`, and `*.codedigest-rewards.test.ts` as fixtures over a fake observation store:

```ts
import { describe, expect, it } from 'vitest';
import { createArchiveReads, ArchiveReadUnavailableError } from '../../src/archive/reads.js';

describe('getTaskPostCounts', () => {
  it('nests the windows: 1h subset of 6h subset of 24h', async () => {
    const reads = createArchiveReads({ observations: fakeObservations(), archive: fakeArchive() });
    const counts = await reads.getTaskPostCounts();
    expect(counts.h1).toBeLessThanOrEqual(counts.h6);
    expect(counts.h6).toBeLessThanOrEqual(counts.h24);
  });

  it('throws ArchiveReadUnavailableError when the projector cursor is behind the finalized head', async () => {
    const reads = createArchiveReads({ observations: behindObservations(), archive: fakeArchive() });
    await expect(reads.getTaskPostCounts()).rejects.toBeInstanceOf(ArchiveReadUnavailableError);
  });
});

describe('getCodeDigestRewards', () => {
  it('returns one row per requested digest that has a sealed verdict', async () => { /* ported fixture */ });
});
```

Plus, in `client/test/learner/verification-gate.test.ts`, keep the existing guarantee under the new error type:

```ts
it('returns insufficient — never throws — when the archive read is unavailable', async () => {
  const reads = { getCodeDigestRewards: async () => { throw new ArchiveReadUnavailableError('down'); } };
  await expect(classifyCodeDigest(reads as never, '0xabc')).resolves.toMatchObject({ status: 'insufficient' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/archive/reads.test.ts test/learner/verification-gate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `ArchiveReads`**

`getTaskPostCounts` reads the projector's `TaskCreated` observations (the projector already decodes exactly these events — this is a read of data the process holds, not a new chain scan) and keeps the documented block-window approximation and the nesting invariant. `getVerdictTallies` and `getCodeDigestRewards` read sealed verdict records from the archive's facts index.

- [ ] **Step 4: Re-point every consumer**

| Consumer | Change |
| --- | --- |
| `api/discovery-endpoint.ts` `GET /v1/discovery/task-post-counts` | `ArchiveReads.getTaskPostCounts`; `ArchiveReadUnavailableError` → 503 |
| `api/gather-status.ts` | `ArchiveReads.getVerdictTallies`; keep the degrade-to-`null` behavior |
| `api/task-runs-build.ts`, `api/launcher-tasks.ts` | import row types from `../archive/types.js` |
| `learner/verification-gate.ts` | `ArchiveReads.getCodeDigestRewards`; `ArchiveReadUnavailableError` → `insufficient`, never throw |
| `mcp/get-codedigest-reward.ts` | same, preserving the `{ ok, error, rows }` result shape |
| `cli/commands/codedigest-revert-check.ts` | build `ArchiveReads` instead of `createDiscoveryAPI` |

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/archive test/api test/learner test/mcp test/cli && yarn typecheck`
Expected: PASS. The SPA's Settings task-post panel and the Launcher per-row post counts must render identically — confirm with `yarn --cwd client/src/dashboard/spa vitest run`.

- [ ] **Step 6: Commit**

```bash
git add client/src/archive client/src/api client/src/learner client/src/mcp client/src/cli client/test
git commit -m "refactor(reads): serve post counts, tallies and rewards from the archive and projector"
```

---

### Task 12: Retire the ERC-8004 SolverNet registry client

Design §9's retirement table: *Registry client (ERC-8004 manifest publish/discover/resolve) → stage 4 → replaced by signed discovery announcements from the projector.* Drain first (contract 10): the registry refresh loop stops accepting new refreshes and any in-flight lifecycle transition reaches a terminal state before the swap.

**Files:**
- Delete: `client/src/solvernets/registry-client.ts`, `client/src/solvernets/registry-client-erc8004.ts`, `client/src/solvernets/most-recent-wins.ts`, and their tests
- Modify: `client/src/solvernets/daemon-init.ts`, `client/src/solvernets/launch-state-machine.ts`, `client/src/solvernets/lifecycle-transitions.ts`, `client/src/api/solvernets-endpoints.ts`, `client/src/api/server.ts`, `client/src/dashboard/spa/src/pages/operator/RegistryTab.tsx`, `client/src/dashboard/spa/src/pages/operator/OperatorSubNav.tsx`, `client/OPERATOR-APP-SPEC.md`

**Interfaces:**
- Consumes: the projector's signed announcements (stage 1) as the sole source of "which SolverNets exist".
- Produces: `SolverNetRegistryClient`, `IdentityRegistryBackedSolverNetRegistryClient`, `SubgraphClient`, `MetadataPublisher`, `SolverNetManifestSummary`, `SolverNetLifecycleStatus`, `resolveMostRecentWins` all cease to exist.

- [ ] **Step 1: Verify the launcher-side publish path is already gone**

Stage 3 retired lifecycle publishing and launched-record generators. Confirm before deleting:

Run: `cd client && grep -rn "publishManifest\|publishLifecycleTransition\|SOLVERNET_MANIFEST_KEY_PREFIX" src/`
Expected: hits only inside the three files this task deletes. **If any live caller remains, stop — stage 3 is incomplete and this task must not proceed.**

- [ ] **Step 2: Write the failing test**

`client/test/solvernets/registry-retired.test.ts`:

```ts
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SolverNet registry client retirement', () => {
  it('no registry-client module remains', () => {
    const files = readdirSync(new URL('../../src/solvernets/', import.meta.url));
    expect(files).not.toContain('registry-client.ts');
    expect(files).not.toContain('registry-client-erc8004.ts');
    expect(files).not.toContain('most-recent-wins.ts');
  });
});
```

Plus an API test asserting `GET /v1/solvernets/registry` and `GET /v1/solvernets/registry/:cid` now 404.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/solvernets/registry-retired.test.ts`
Expected: FAIL — the modules are present; the routes still 200.

- [ ] **Step 4: Delete the client and its surfaces**

- `rm` the three modules and their tests.
- `daemon-init.ts`: delete the registry construction and the refresh loop (including the `DiscoveryUnavailableCode` capture for operator surfacing).
- `launch-state-machine.ts` / `lifecycle-transitions.ts`: delete the registry-publish legs; the posting config (stage 3) owns launch now.
- `solvernets-endpoints.ts`: delete `GET /v1/solvernets/registry` and `GET /v1/solvernets/registry/:cid`; `server.ts`: delete the matching `app.use` 503-guard entries.
- SPA: delete `RegistryTab.tsx` + its test; remove the Registry entry from `OperatorSubNav`; redirect `/operator/registry` → `/operator/memberships` (which stage 1 renamed to Claim policy & wiring).
- `OPERATOR-APP-SPEC.md`: delete `### 2.5 SolverNet Registry`; add one line under §2.4 noting the projector's signed announcements as the replacement source.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn vitest run && yarn --cwd src/dashboard/spa vitest run && yarn typecheck && yarn lint:no-late-mount`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A client/src client/test client/OPERATOR-APP-SPEC.md
git commit -m "refactor(solvernets): retire the ERC-8004 registry client for signed announcements"
```

---

### Task 13: Re-point the residual `client/src/discovery/` consumers

Everything not covered by Tasks 10–12. Each is a pass-through or a bridge-era leg, not a re-implementation.

**Files:**
- Modify: `client/src/corpus/types.ts` and the corpus's query construction; `client/src/erc8004/identity.ts`; `client/src/erc8004/index.ts`; `client/src/cli/commands/tasks-observe-autopilot.ts`; `client/src/autopilot/marketplace-delivery-observer.ts`; `client/src/mcp/server.ts`
- Delete: `client/test/architecture/core-corpus-http-ownership.test.ts`
- Test: existing suites for each consumer

**Interfaces:**
- Consumes: `ArchiveReads` (Task 11); the stage-3 requester module's delivery-wait/adoption surface.
- Produces: zero remaining importers of `client/src/discovery/`.

- [ ] **Step 1: Delete the corpus's discovery pass-through**

`client/src/discovery/http.ts`'s `queryEnvelopes` merely delegates to `@jinn-network/core`'s `createHttpCorpusDiscovery` — the architecture test `core-corpus-http-ownership.test.ts` asserts exactly that by reading the file as source text. Have the corpus construct `createHttpCorpusDiscovery` from `@jinn-network/core` directly, drop `CorpusConfig.discovery`, and delete the source-text architecture test (its subject file is gone; it couples by text, not by import, so nothing else catches its staleness).

Run: `cd client && yarn vitest run test/corpus/`
Expected: PASS — corpus behavior unchanged.

- [ ] **Step 2: Delete `resolveAgentIdForManifest`**

Its sole caller is `main.ts`'s reputation-feedback resolver, which hangs off the legacy mech engine retired at stage 2. Verify, then delete the function, `ResolveAgentIdArgs`, `ResolvedAgent`, and their `erc8004/index.ts` re-exports and test.

Run: `cd client && grep -rn "resolveAgentIdForManifest" src/ test/`
Expected after deletion: no hits. **If `main.ts` still calls it, stop — stage 2 is incomplete.**

- [ ] **Step 3: Re-point the autopilot delivery observer**

`marketplace-delivery-observer.ts` depends on `Pick<DiscoveryAPI, 'getAutopilotDeliveryCandidates'>`; `tasks-observe-autopilot.ts` builds a `createHttpDiscoveryAPI` for it. Replace both with the stage-3 requester module's delivery-wait surface (`src/requester/`), which already owns "post, await the delivery, adopt". Keep `AutopilotDeliveryCandidateLookup` as the observer's injected port so the standalone `Jinn-Network/autopilot` consumer's CLI contract (`jinn tasks observe-autopilot-delivery`) is byte-identical.

Run: `cd client && yarn vitest run test/autopilot/ test/cli/`
Expected: PASS; the CLI's stdout shape unchanged.

- [ ] **Step 4: Drop the MCP subprocess's DiscoveryAPI**

`client/src/mcp/server.ts` builds a `createHttpDiscoveryAPI` from `JINN_DISCOVERY_URL` / `JINN_DISCOVERY_MODE` for its corpus + reward tools. Replace with `ArchiveReads` over the operator's local archive root (forwarded via the existing env allowlist as `JINN_ARCHIVE_DIR`); delete both `JINN_DISCOVERY_*` reads.

- [ ] **Step 5: Verify zero importers remain**

Run: `cd client && grep -rn "from '.*discovery/\(types\|http\|onchain\|with-fallback\|factory\|index\)\.js'" src/ test/ scripts/`
Expected: no hits. Note `client/scripts/e2e-capture-validate.ts` is the repo's only barrel importer — re-point it at `ArchiveReads` or delete the discovery leg of that script.

- [ ] **Step 6: Run the full suite**

Run: `cd client && yarn vitest run && yarn typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A client/src client/test client/scripts
git commit -m "refactor(discovery): re-point every residual discovery consumer"
```

---

### Task 14: Delete `client/src/discovery/` and its config surface

**Files:**
- Delete: `client/src/discovery/` (6 files), `client/test/discovery/` (~19 files)
- Modify: `client/src/config.ts`, `client/src/main.ts`, `CLAUDE.md`, `packages/indexer/README.md`, `packages/indexer/deploy/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `discovery.mode`, `discovery.url`, `discovery.fallbackToOnchain`, `JINN_DISCOVERY_MODE`, `JINN_DISCOVERY_URL`, `JINN_DISCOVERY_FALLBACK`, `DEFAULT_TESTNET_DISCOVERY_URL`, `DiscoveryAPI`, `DiscoveryUnavailableError` all cease to exist.

- [ ] **Step 1: Write the failing test**

`client/test/architecture/discovery-retired.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('client/src/discovery retirement', () => {
  it('the tree is gone', () => {
    expect(existsSync(new URL('../../src/discovery/', import.meta.url))).toBe(false);
  });

  it('the discovery config block no longer parses', () => {
    const cfg = loadConfig({ configObject: { discovery: { mode: 'http', url: 'http://x' } }, env: {} }) as Record<string, unknown>;
    expect(cfg['discovery']).toBeUndefined();
  });

  it('JINN_DISCOVERY_* env vars are inert', () => {
    const cfg = loadConfig({ configObject: {}, env: { JINN_DISCOVERY_MODE: 'http', JINN_DISCOVERY_URL: 'http://x' } }) as Record<string, unknown>;
    expect(cfg['discovery']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/architecture/discovery-retired.test.ts`
Expected: FAIL — directory present; config still parses.

- [ ] **Step 3: Delete**

```bash
git rm -r client/src/discovery client/test/discovery
```

`client/src/config.ts`: delete the `discovery` schema block, its three env merges, and `DEFAULT_TESTNET_DISCOVERY_URL`.
`client/src/main.ts`: delete `sharedDiscoveryApi`, `discoveryApiHolder`, `buildOnchainFloor`, the dynamic `createDiscoveryAPI` import, and every fan-out (`taskDiscovery.discoveryApi`, the registry client, the launched-record dispatcher, `corpusFactory`, `startApiServer`'s `discovery` holder, the Tasks-chip read).

- [ ] **Step 4: Update the docs**

`CLAUDE.md`: delete the `discovery.mode` / `discovery.url` / `discovery.fallbackToOnchain` config-table rows, the "Discovery defaults differ by network" paragraph, and the `fallbackToOnchain` paragraph. Replace with one paragraph: the operator serves and consumes a signed record-discovery archive; the projector is the only chain reader; `archive.*` are the new keys. Keep the RPC-fallback-chain section intact — it is the transport layer beneath, unaffected.
`packages/indexer/README.md` (lines 11, 127, 196, 210) and `packages/indexer/deploy/README.md:75`: replace the "daemon reads through `client/src/discovery/http.ts`" statements with a pointer to the archive, and note that the Ponder process's remaining role becomes hosted archive + query plane (marketplace-surfaces §7 step 2 — see Follow-ups).

- [ ] **Step 5: Run everything**

Run: `cd client && yarn typecheck && yarn test && yarn lint:no-late-mount`
Expected: PASS, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add -A client CLAUDE.md packages/indexer
git commit -m "refactor(discovery): delete client/src/discovery and its config surface"
```

---

### Task 15: Stage gate, drain runbook, deploy PR

**Files:**
- Create: `docs/runbooks/cutover-stage-4-drain.md`
- Modify: `client/ARCHITECTURE.md` (loop list)

**Interfaces:**
- Consumes: everything above.
- Produces: the deploy PR that hard-swaps stage 4.

- [ ] **Step 1: Write the drain runbook**

`docs/runbooks/cutover-stage-4-drain.md`, as a checklist the operator runs before the deploy:

1. **Peer-sync drain** — set `peers: []` in the running operator's config and restart. Confirm no `peer-sync` heartbeat advances for one full 60 s interval (`loop_watchdog_stale` must not fire for it after removal). In-flight `acquireContent` calls are single-shot and complete within one request timeout.
2. **Registry-client drain** — confirm no SolverNet lifecycle transition is in flight: `GET /v1/solvernets/launched` shows every owned record in a terminal lifecycle state. Any record mid-transition must reach terminal (or be recorded as a straggler in the PR) before the deploy.
3. **Projector catch-up** — confirm the projector's durable cursor has reached the finalized chain head (`/v1/status` → `archive.sequence` advancing; no `projector_behind`). Contract 3.
4. **Evidence-driver quiesce** — `/v1/status` → `indexing.pendingRecords === 0` and `indexing.lastError === null`. Any pending record is announced after the swap by the same idempotent driver (contract 6); a non-null `lastError` blocks the deploy.
5. **Gate evidence** — attach the `yarn e2e:archive-second-daemon` output and the `runServingPlaneConformance` run.
6. **Rollback** — revert the deploy PR / pin the previous canary image. The archive on disk is unaffected (it is append-only files); the reverted daemon simply stops serving it. Announcements already emitted stay valid; nothing is rewritten. Stranded items surface through the §4 state message.

- [ ] **Step 2: Update the loop list**

`client/ARCHITECTURE.md`: remove peer-sync from the loop enumeration; note the archive plane as a read surface, not a loop. `CLAUDE.md`'s architecture paragraph: same edit.

- [ ] **Step 3: Run the full gate**

```bash
cd client && yarn typecheck && yarn test && yarn lint:no-late-mount
yarn e2e:archive-second-daemon
cd ../packages/discovery/testing && yarn vitest run
```
Expected: all green. Paste the outputs into the PR body.

- [ ] **Step 4: Open the deploy PR**

Target `integration/evidence-v1`. Title: `feat(cutover): stage 4 — discovery serving`. Body carries the drain checklist from Step 1 (checked), the rollback statement, the gate outputs, and the findings section from this plan's Self-Review. **Operator-approved; no agent self-merge.**

- [ ] **Step 5: Record the hand-off trigger**

In the PR body, under Follow-ups:

> **Hand-off — marketplace-surfaces #2296 step 2 is now unblocked.** The physical explorer separation (explorer as a tier-4 product tree; the Ponder process's remaining role becoming hosted archive + query plane; the Railway deployment re-point) is gated on this stage and is **not** in this plan's scope. Trigger: this deploy PR merged and its gate green. Owner: the marketplace-surfaces session, per `docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md` §7.

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/cutover-stage-4-drain.md client/ARCHITECTURE.md CLAUDE.md
git commit -m "docs(cutover): stage 4 drain runbook and loop-list delta"
```

---

## Self-Review

**Spec coverage.** Design §10 stage-4 row: archive mounted on the operator API (Task 3), SSE tail + ETag head (Tasks 2, 5), peer-sync retired (Task 9), registry client retired (Task 12), `client/src/discovery/` retired (Tasks 10–14), gate = second-daemon consumption (Task 6) + kit green against the live surface (Tasks 1, 5). §6.2 exposure scoping and IP disclosure: Tasks 4 and 8. §9 operator-app delta (evidence driver surfaces indexing failures): Tasks 7, 8. §4 evidence-driver row: Task 7. Contracts 6, 7, 10: Tasks 7, 4, 15 respectively.

**Findings, with proposed dispositions.**

1. **The kit has no transport-shaped suite.** All six `run*Conformance` adapters are in-process object literals; none accepts a URL, transport, or server handle. The stage gate is unmeetable without one. *Disposition: this plan adds `runServingPlaneConformance` to `packages/discovery/testing/` (Task 1) — a tier-3 addition from a cutover-stage plan, justified because stage 4 is the first stage with a live surface to conform against. Coordinate with the transport-http plan so it does not add a second, differently-shaped suite.*
2. **`BlobStore` is `put`-only.** `packages/discovery/serve/src/ports.ts` declares no read side anywhere. *Disposition: `createArchiveHttpHandler` reads the filesystem root directly and takes `rootDir`, not a `BlobStore` (Cross-Plan Interface Assumptions). Flagged to the transport-http plan.*
3. **Design §6.2 says "one process, no second listener by default" but also offers "a separate bind."** Read literally as one listener, public exposure would also expose `/v1/status`, `/artifacts/search`, `/artifacts/:id/content`, `/`, `/assets/*`, `/api/stop-hook` and the SPA fallback, which are unauthenticated today and held safe only by the `127.0.0.1` bind — contradicting contract 7. *Disposition: read "by default" as governing, and make the separate listener the **only** public path (Task 4). Structural scoping, not middleware. Recorded for operator ratification in the deploy PR.*
4. **The plugin content read path dies with `discovery/`, but §9 preserves the plugin content commands.** *Disposition: carve `listPluginPublications` / `getPluginScores` / `listBuilderArtifacts` into a host module over venue-base's log source (Task 10). Deferring to the plugin session would break the Build page and three CLI verbs between stage 4 and that session.*
5. **`Transport.fetch` ignores response status** (`client/src/sync.ts:73-76`), so an HTML 404 becomes a JSON parse error deep in `fetchHead`. *Disposition: archive prefixes are excluded from the SPA fallback and return typed JSON 404s (Task 3); the kit asserts it (Task 1).*
6. **`namesColdSyncPath: true` in the `cursor-too-old` vector is asserted by nothing** — `runSubscribeConformance` reads only `behavior` and `detailCode`. *Disposition: the new live-surface suite asserts the terminal event carries `coldSyncPath` (Task 1).*
7. **`apiBindHost` shipped inert** — `main.ts:502` reads only `JINN_API_BIND_HOST` and ignores the zod config field. *Disposition: the archive bind is read from config with env override applied by the loader, with a regression test naming the precedent (Task 4).*
8. **`POST /api/stop-hook` has no auth on the main API** and `leaderboard-api.ts` is dead code. Both pre-date this stage. *Disposition: out of scope; the public plane cannot reach either (Task 4 asserts stop-hook 404s there). File as separate issues.*
9. **peer-sync signs `acquireContent` with ERC-8128 but no server verifies it** (`GET /artifacts/:id/content` is unauthenticated). *Disposition: moot — the loop retires in Task 9. Noted so the deletion is not mistaken for removing a live control.*
10. **`writeArchivePages` is a whole-corpus repaginator, not an append primitive**, and `client`'s `WireArchivePage` duplicates `serve`'s `ArchivePage` with nothing catching drift. *Disposition: the seed helper accumulates the full entry set and repaginates (Tasks 5–6); the second-daemon e2e is the only thing in the repo that would catch the drift, which is an argument for keeping it in the gate.*

**Placeholder scan.** No TBD / "add error handling" / "similar to Task N" / test-less steps. Two steps deliberately end in a stop condition rather than code (Task 12 Step 1, Task 13 Step 2) — both verify a prior stage's completion before a destructive delete, and both state the exact command and the exact failure action.

**Type consistency.** `OperatorArchive` (Task 2) is consumed by name in Tasks 3, 4, 5, 6, 7. `ArchiveTailFeed` / `TailSink` (Task 2) are consumed in Tasks 2, 5, 7. `ARCHIVE_PATH_PREFIXES` (Task 3) is consumed in Task 3's `server.ts` edit. `ArchiveStatus` / `IndexingStatus` / `IndexingErrorCode` (Task 7) are consumed in Task 8. `ArchiveReads` / `ArchiveReadUnavailableError` (Task 11) are consumed in Tasks 11 and 13. `PluginPublicationReader` (Task 10) is consumed in Task 10's route and CLI edits. Row types move to exactly one home each: plugin rows → `client/src/plugins/types.ts` (Task 10); task/verdict/reward rows → `client/src/archive/types.ts` (Task 11); no type is declared in two places.

---

> **Reconciliation addendum (2026-07-30, coordinator):**
> 1. **Task 1 executes as EXTEND, not create.** `runServingPlaneConformance` is born in the
>    transport-http plan (phase 0, kit-first — 16 fixtures, same name, same
>    `ServingPlaneUnderTest` contract). By the time this stage runs, the suite exists. Treat
>    Task 1's implementation block as the contract baseline: verify the existing suite
>    matches it, and add only what is new here (the live-operator-surface checks). One
>    suite, two contributing plans, transport-http owns the file.
> 2. **Detail-code spelling normalized to `cursor-unknown`** (the discovery design's pinned
>    form) throughout this plan; the composition design's `unknown-cursor` was a
>    transposition.
> 3. **Added scope from the stage-3 plan's finding 4:** retire the remaining `jinn
>    solver-nets` subverbs (join / list / doctor) in this stage's train, alongside the
>    registry client they front — command-level test removals included. (Stage 3 retires
>    only the launcher-side subverbs.)
