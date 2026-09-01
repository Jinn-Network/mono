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
| `/.well-known/jinn-record-discovery` | names this workspace's source, its head path, and its newest archive page | rewritten after every announcement |
| `/sources/<name>/head` | the signed source head — current sequence, entry digest, `refreshBy` | rewritten after every announcement |
| `/sources/<name>/entries/<page>` | a signed archive page, one entry per page, linked to its predecessor via `prevArchive` | immutable once written |
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

## Before you announce: the public URL must already serve

```bash
colophon publication configure \
  --workspace <dir> --principal <id> --draft <draftId> \
  --public-base-url https://records.example.org/publication
```

This is a **locator, not identity**. Source identity is the workspace key's
`did:key` plus the source name, both frozen once any append receipt is durable;
the base URL is deliberately mutable and can be re-pointed later with another
`publication configure`. Nothing in the announcement entries names it —
Colophon announces records by digest and never writes a `locations` array — so
moving the archive to a new domain does not invalidate a single published
record.

What it must be is *reachable at announce time*. `publication register`,
`publication accounting`, `publication report`, and `launch` each probe this
base URL for the exact bytes they are about to announce and refuse the stage if the probe does not return
them. So the ordering is: serve (or mirror) first, configure second, announce
third — not because the URL is permanent, but because the announce path checks
it.

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

Give the archive its own origin, not a path on a domain that serves anything
else. Publication artifacts carry the media type the producing venue declared
for them, and the server returns it verbatim; a participant who supplies HTML
bytes and declares `text/html` gets script execution on whatever origin the
archive is mounted on. On a dedicated origin that is inert -- there is no
cookie, no session, and no write route to reach -- which is exactly why it must
not share an origin with something that has any of the three.

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
   from what you publish (as above) and configure the media types yourself:
   `application/vnd.jinn.record-discovery.head.v1+json` for the head,
   `application/vnd.jinn.record-discovery.well-known.v1+json` for the
   well-known document, `application/json` for archive pages, and each record's
   own announced media type for its digest path. Cold sync and returning sync
   do not check the declared type, but consumers that stream the live tail do —
   and a mirror that serves everything as `text/plain` is a mirror nobody can
   build a typed reader against.
2. **Re-sync after every announcement.** Archive pages and record bytes only
   ever appear; the head and the well-known document are rewritten in place. A
   stale head against fresh pages is a chain a consumer reads as behind, not
   broken — but a stale well-known document points at an archive page that is no
   longer the newest, and a cold-syncing consumer silently misses everything
   after it.
3. **Do not serve anything else from the mount.** Publish the archive subtree at
   its own path or origin. The product's handler enforces a closed path grammar;
   a static host enforces whatever directory you point it at.

Neither option is required to be the only one: serving locally while mirroring
statically is fine, because both read the same bytes.

## Verify it from another machine

The acceptance test is a cold sync performed by a consumer that has never seen
this source, on a machine that is not the producer:

1. `GET <base>/.well-known/jinn-record-discovery` — it must name your source's agent
   `did:key`, its name, its head path, and an archive root.
2. `GET <base>/sources/<name>/head` — a DSSE envelope over the source head. Its
   `origin` must match the well-known entry, and `refreshBy` must be in the
   future.
3. Walk the archive from the well-known `archiveRoot` back through each page's
   `prevArchive` to genesis, then run `source-chain-verification` over the head
   plus the entries oldest-first. `coldSync` in
   `@jinn-network/record-discovery-client` performs exactly this walk.
4. For each announcement, `GET` `<base>/records/<sha256>` — the digest path is
   this producer's location — and confirm the returned bytes hash to the
   announced digest. Signed Report payloads and other publication artifacts live
   at `<base>/publication-artifacts/sha256/<sha256>`.

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
