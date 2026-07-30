# `@jinn-network/record-discovery-transport-http`

Production HTTP adapter tree for the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §7, and the
operator-daemon composition design's §7.3 wire profile). `record-discovery-serve` and
`record-discovery-client` declare every effectful surface as an injected port and perform no
filesystem, network, or clock I/O themselves; this package is the tier-3 tree that supplies
the HTTP-shaped implementations of those ports — a filesystem `BlobStore`, an HTTP handler
that serves `serve`'s static layout back out, and the client-side `Transport` /
`StreamTransport` / ping transports that read it. It contains no protocol logic of its own:
`serve` writes, this package serves and fetches.

## Exported factories

The package name and these four factory names are pinned by the operator-daemon composition
program (§5) and must not drift. All four are re-exported from `src/index.ts`, which is the
package's only public entrypoint.

### `createFsBlobStore(rootDir: string): ReadWriteBlobStore`

The filesystem-backed serving root (`src/fs-blob-store.ts`). It implements both halves of
blob storage over one directory tree: `serve`'s write port (`BlobStore.put`) and this
package's read port (`BlobReader.get`), so a single instance backs both the source producer
and the HTTP handler. Every write is temp-file-plus-`rename`, so a reader never observes a
partial object. A digest-path write (`/records/...`) that would change existing bytes throws
`ContentAddressedConflictError` rather than overwriting; a path that resolves outside
`rootDir` throws `UnsafeBlobPathError`. Content types ride beside each object in a
`<path>.content-type` sidecar, written before the object itself, and the path grammar the
handler serves never matches a sidecar, so sidecars are unreachable over HTTP.

### `createArchiveHttpHandler(options: ArchiveHttpHandlerOptions): ArchiveHttpHandler`

The HTTP handler over `serve`'s static layout (`src/handler.ts`), a plain
`(request: Request) => Promise<Response>` function:

```ts
interface ArchiveHttpHandlerOptions {
  reader: BlobReader;
  basePath?: string; // stripped before grammar matching; "" (default) at the origin root
  tail?: ArchiveTailSource; // absent -> the tail path 404s (Finding F5)
  isSealedPage?(sourceName: string, page: string): boolean; // default: no page is sealed
}
```

### `createHttpTransport(baseUrl: string, fetchLike?: FetchLike, options?: HttpTransportOptions): HttpTransport`

The client-side `Transport` plug (`src/fetch-transport.ts`), implementing
`@jinn-network/record-discovery-client`'s `Transport` interface. `fetchLike` defaults to the
global `fetch`. The transport remembers each URL's `ETag` and sends `If-None-Match` on the
next request; a `304` returns the cached bytes under status `200`, so every existing `client`
consumer (`fetchHead`, `coldSync`, `returningSync`) parses a body exactly as it does on a
fresh `200`. `HttpTransport.stats()` exposes `{ requests, revalidations }`. A declared or
actual body over `options.maxBytes` (default 8 MiB) throws `TransportOversizeError`; a
non-2xx status throws `TransportHttpError`.

### `createSseStreamTransport(baseUrl: string, fetchLike?: FetchLike, options?: SseStreamTransportOptions): StreamTransport`

The client-side `StreamTransport` plug (`src/sse-transport.ts`), implementing
`@jinn-network/record-discovery-client`'s `StreamTransport` interface over the same two Node
22 built-ins the handler uses: `fetch` and `Response.body` as a `ReadableStream<Uint8Array>`.
It deliberately does not use the global `EventSource`, which cannot set `Last-Event-ID` on
the first connection — and a first-connection resume from a stored cursor is the point of the
§7.3 profile. A terminal SSE event (`unknown-cursor`, `cursor-too-old`) surfaces as a typed
`SseTerminalError` on the error channel and stops the transport; it does not reconnect,
because reconnecting against a cursor the relay has already refused would loop forever. A
stream that ends without a terminal event reconnects after `options.reconnectDelayMs`
(default 3000 ms), up to `options.maxReconnects` (default: unbounded).

A fourth factory, `createHttpPingTransport(endpointUrl, fetchLike?)`, is also exported
(`src/ping-transport.ts`) but is not one of the four pinned names: it implements `serve`'s
producer-side `PingTransport.announce(headUrl)` port. See Finding F4 below.

## The §7.3 wire profile

The handler and transports together implement every clause of the composition design's §7.3
wire profile:

- **`ETag` / `If-None-Match` conditional GET on the head.** The head is the one object in the
  layout that is rewritten, so it is the one object where conditional GET matters most. The
  handler answers `304` when the request's `If-None-Match` matches the current `ETag`; the
  transport sends `If-None-Match` automatically once it has seen a response's `ETag`.
- **`Cache-Control: immutable` on digest paths.** Every `/records/<digest>` response carries
  `public, max-age=31536000, immutable` — correct without qualification, because a digest
  path's bytes cannot change without changing its digest.
- **`Cache-Control: immutable` on archive pages, refined by Finding F2.** §7.3 read literally
  would mark every archive page immutable, but `serve`'s pager re-partitions the whole entry
  list on every append, so the newest page's bytes change whenever the source appends.
  Marking it immutable would freeze a consumer's cold-sync entry point at whatever the tail
  looked like on first fetch. The handler instead takes an injected `isSealedPage(sourceName,
  page)` predicate — a page is sealed once a successor page exists — and marks a page
  immutable only when the predicate says so. It defaults to "no page is sealed" (the safe
  default); the newest, unsealed page is served with `ETag` and `Cache-Control: no-cache`
  instead. A host that wants §7.3 read literally supplies a predicate that always returns
  `true`.
- **Declared `Accept-Ranges: bytes` on blobs, honored.** Digest paths and archive pages
  declare `accept-ranges: bytes` and the handler actually serves single-range `GET` requests
  against them, including a `416` with `Content-Range: bytes */<length>` for an unsatisfiable
  range. A declared range that always 200s the whole body would be a lie to every mirror or
  CDN in the path.
- **SSE with `Last-Event-ID` carrying the relay cursor.** The tail (`/sources/<name>/tail`)
  reads the resume cursor from the `Last-Event-ID` request header — honored on the very first
  request, not only on reconnect — falling back to a `?cursor=` query parameter. Cursors are
  relay-local: a per-process monotone counter in the protocol's fixed-width sequence grammar,
  never the source chain's own sequence.
- **The five-case cursor contract as typed terminal events, then close.** `classifyTailCursor`
  (`src/tail.ts`) decides between live-tail-from-now, start-of-window, replay-then-live,
  cursor-too-old, and typed-error-close; the two terminal cases (`unknown-cursor`,
  `cursor-too-old`) are emitted as one SSE frame followed by stream close, never a silent gap.
  `cursor-too-old` names the cold-sync path (the source's head plus the archive page matching
  the stale cursor) so a consumer never has to guess where to resume.
- **Each source advertises its bounded replay window in the well-known document, refined by
  Finding F3.** `serve`'s `WellKnownSourceEntry` has no typed field for this, so this package
  owns the advertisement type (`ReplayWindowAdvertisement`, `src/advertise.ts`) and decorates
  a copy of the well-known document via `withReplayWindowAdvertisements`. The field rides
  discovery §15's additive-unknown-fields rule; promoting it into `serve`'s typed schema is a
  one-field follow-up to file if a second producer needs it.
- **TUF roles and the OCI registry API.** Neither exists anywhere in this tree; the discovery
  spec's §9.4 dated addendum records the rejection.
- **Ping, refined by Finding F4.** §6.2 groups "ping" with the client-side plugs, but the only
  ping port in the stack is producer-side: `serve`'s `PingTransport.announce(headUrl)`. This
  package implements the emitting half (`createHttpPingTransport`) and nothing else — pings
  are unauthenticated hints that cost latency, never correctness, if lost. Receiving a ping
  and deciding whether to pull is a host loop; the debounce that keeps a flood of pings from
  costing more than the consumer's own configured pull rate already ships in
  `@jinn-network/record-discovery-client` (`createPullDebounce`).

## Mount contract

The handler is a plain `Request`-in/`Response`-out function so the host can mount it under
one Hono route without this package depending on Hono at runtime:

```ts
app.all(base + "/*", (c) => handler(c.req.raw));
```

Nothing else is required on the host side — no separate listener, no additional routing
logic. The handler resolves every request against the injected `BlobReader` and (optionally)
`ArchiveTailSource`.

## Exposure scoping

`parseArchivePath` (`src/paths.ts`) admits exactly five shapes: the well-known document, a
digest path, a source head, an archive page, and the SSE tail. Every other path — including
anything containing `..`, a doubled slash, or a backslash — classifies as `undefined`, and
the handler answers `404` for anything it does not classify. This is a closed grammar, not a
denylist: a host that mounts the handler alongside other routes cannot leak a sibling route
through it, because the handler never forwards or proxies a request it does not recognize as
one of the five shapes itself.

**Bind-host and public-exposure decisions belong to the host, not this package.** This
package binds no port and opens no listener; it works identically behind a `localhost`-only
bind, a public bind, or a separate archive-only bind. Choosing which one, and writing any
operator-facing IP-disclosure copy that decision requires, is cutover-stage work outside this
tree.

## Development

Use Node 22 and Yarn 4.13.0. This package is not published yet (`#2293` tracks the publish
work in parallel), so there is nothing beyond `yarn install`:

```sh
yarn install
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```
