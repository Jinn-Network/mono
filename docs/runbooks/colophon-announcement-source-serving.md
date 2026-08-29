# Serving the Colophon announcement source

Colophon announces every evidence record it publishes onto a signed Record
Discovery source chain held in the workspace. This runbook takes that chain from
local emission to a public HTTP surface any discovery client can cold-sync, and
ends where operator work begins: provisioning the host and domain.

## What is being served

Under `<workspace>/publication/public/` the product maintains the standard
Record Discovery serving layout:

| Path | What it is | Mutability |
|------|------------|------------|
| `/.well-known/record-discovery` | names this workspace's source, its head path, and its newest archive page | rewritten after every announcement |
| `/sources/<name>/head` | the signed source head — current sequence, entry digest, `refreshBy` | rewritten after every announcement |
| `/sources/<name>/entries/<page>` | a signed archive page; each links to its predecessor via `prevArchive` | append-only; the newest page is rewritten until it seals |
| `/records/<sha256>` | the exact announced record bytes | immutable |
| `/publication-artifacts/sha256/<sha256>` | exact publication artifact bytes | immutable |

Everything a consumer trusts is signed or digest-addressed, so serving is a
read-only static problem. There is no write route, no session, and no
credential: the archive subtree is public by construction.

The well-known document is the one derived object. It exists so a first-time
consumer can find the newest archive page without being told its name —
`coldSync` starts there and walks `prevArchive` back to genesis. It is rewritten
from the writer's committed position after every append, and rebuilt at serve
time for any workspace whose announcements predate this serving path.

## Before you announce: fix the public URL first

Announced records carry their locations. Those locations are the base URL
configured *at announcement time*, and the chain is append-only — you cannot
rewrite them later.

```bash
colophon publication configure \
  --workspace <dir> --principal <id> --draft <draftId> \
  --public-base-url https://records.example.org/publication
```

Set this to the exact mount the archive will finally be served from, including
any path prefix, before `publication register`. A workspace that announced
against `http://127.0.0.1:8787` has locations naming loopback for good.

## Option A — run the server

```bash
colophon publication serve --workspace <dir> --principal <id> \
  [--source <name>] [--host <address>] [--port <n>]
```

It binds `127.0.0.1:8787` by default, refreshes the well-known document, serves
until SIGINT/SIGTERM, and prints the bound URL. `--port 0` binds an ephemeral
port.

This process terminates plain HTTP only. Put it behind a reverse proxy that
terminates TLS and forwards the archive mount path unchanged; the served paths
are exactly the table above, so the proxy needs no rewriting beyond stripping
its own prefix if you mount below the origin root. Bind to a non-loopback
address only when the proxy is on another host and the network between them is
one you control.

## Option B — publish the tree statically

The layout is immutable files; nothing in it requires a running product. For a
durable public source this is the better shape — copy or sync
`<workspace>/publication/public/` to any static host or object store:

```bash
rsync -a --exclude '*.content-type' \
  <workspace>/publication/public/ <static-root>/publication/
```

Three things the static host must get right:

1. **Content types.** The product stores each object's declared type in a
   `<path>.content-type` sidecar, which the HTTP handler reads and the archive
   path grammar never serves. A static host does neither: exclude the sidecars
   from what you publish (as above) and configure the media types yourself —
   `application/vnd.jinn.record-discovery.head+json` for the head,
   `application/vnd.jinn.record-discovery.archive+json` for archive pages,
   `application/vnd.jinn.record-discovery.well-known+json` for the well-known
   document. Cold sync and returning sync do not check the declared type, but
   consumers that stream the live tail do.
2. **Re-sync after every announcement.** The head and the newest archive page
   are rewritten in place. A stale head against fresh pages is a chain a
   consumer will read as behind, not broken; a stale well-known document points
   at an archive page that is no longer newest, and a cold-syncing consumer
   silently misses everything after it.
3. **Do not serve anything else from the mount.** Publish the archive subtree at
   its own path or origin. The product's handler enforces a closed path grammar;
   a static host enforces whatever directory you point it at.

Neither option is required to be the only one: serving locally while mirroring
statically is fine, because both read the same bytes.

## Verify it from another machine

The acceptance test is a cold sync performed by a consumer that has never seen
this source, on a machine that is not the producer:

1. `GET <base>/.well-known/record-discovery` — it must name your source's agent
   `did:key`, its name, its head path, and an archive root.
2. `GET <base>/sources/<name>/head` — a DSSE envelope over the source head. Its
   `origin` must match the well-known entry, and `refreshBy` must be in the
   future.
3. Walk the archive from the well-known `archiveRoot` back through each page's
   `prevArchive` to genesis, then run `source-chain-verification` over the head
   plus the entries oldest-first. `coldSync` in
   `@jinn-network/record-discovery-client` performs exactly this walk.
4. For each announcement, `GET` every location it names and confirm the returned
   bytes hash to the announced digest.

Steps 1–4 are what `publication-serve.test.ts` performs against a real socket in
CI, so a failure here is an environment or hosting fault rather than a product
one. If step 4 fails while steps 1–3 pass, the locations were configured after
the fact — see "fix the public URL first" above.

## Disclosure: why this producer has no disclosure gate

Colophon routes around `packages/evidence/contribution` — the disclosure
authorization surface — entirely. That is correct *for this producer*: every
record Colophon announces is part of a bundle built to be public, and there is
no private-by-default corpus behind it to leak.

**Do not copy this path for a producer whose records are private by default.**
Serving a source chain publishes the announcement entries, the record bytes at
their digest paths, and the locations naming where more can be fetched. A
producer that holds records some parties may not see must run its announcements
through a disclosure gate before the durable writer, not after — once an entry
is signed into the chain it is append-only, and withdrawal announces the
withdrawal rather than unpublishing the bytes.

## What remains an operator step

This runbook ends at a served archive. Choosing the domain, obtaining the
certificate, provisioning the host or bucket, and setting the DNS record are
operator acts the product does not perform and holds no credentials for. Do
them before `publication configure`, so the base URL you announce is the one
that will still be true a year from now.
