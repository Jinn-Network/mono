# Running the corpus mirror as a standing service

`jinn-plugin-runtime mirror` follows one or more public Record Discovery
sources for as long as the process runs: every cycle it verifies each followed
archive's announcement chain, imports what is new, and indexes the mirrored
records so an agent's `corpus_search` can answer over them. This runbook takes
that from a served source to a supervised process, and ends where operator work
begins.

## 1. What this service is, and what it is not

It is a follower. It holds no source of its own, publishes nothing, and signs
nothing.

It is deliberately **not**:

- **An HTTP query API.** The `mirror` process exposes no port and no MCP
  surface. It exists to keep the mirror and the relevance index current.
- **A web explorer.** There is no page to open.
- **A registration surface.** Nothing calls in to be followed. Sources are
  configuration: an archive is followed because this install's configuration
  file names it, and is dropped by removing it from that file.

The service is free to query, because there is no query path on it to charge
for. Reads stay on the existing `corpus_search` and `corpus_fetch` MCP tools,
which the host spawns per client (`jinn-plugin-runtime serve --role tools`)
against the same `JINN_PLUGIN_HOME`. A mirror process and any number of clients
share one home; the mirror writes, the clients read.

## 2. Prerequisites

A source that is already served over HTTPS, with a reachable well-known
document, head, archive pages, and record bytes. For a Colophon workspace, see
[Serving the Colophon announcement source](colophon-announcement-source-serving.md);
that runbook owns the serving layout, the content types, and the cold-sync
acceptance walk, and this one does not restate them.

## 3. Collect four values from the served feed

Every value below is read from the feed itself, so a mistyped one fails loudly
rather than silently following the wrong archive.

```bash
curl -s https://<base>/.well-known/jinn-record-discovery | jq
```

That document gives three of them:

| Value | Where it comes from |
|-------|---------------------|
| `agent` | the source's agent `did:key` in the well-known entry |
| `name` | the source name in the same entry |
| `archiveRootUrl` | the archive root the entry names — the newest page, which the mirror walks back from on a cold sync |

The fourth is the key you are agreeing to trust:

```bash
curl -s https://<base>/sources/<name>/head | jq '.signatures[].keyid'
```

The head is a DSSE envelope. Its signature `keyid` is the `did:key` that signs
for this source, and it is what you declare under `signingKeys`. Following an
archive and trusting a key to speak for it are two separate acts: an archive
declared with no signing key resolves its head against no candidate and is
refused `unauthorized-signer`.

Two further values are yours to choose rather than to read: `servingRoot` is the
base URL you fetched the two documents from, and `repositoryId` is a stable
identifier for this archive within this install. It must be unique across the
followed sources, and it is what orders retrieval fallback after the local
mirror.

Write the `servingRoot` with the scheme and port the archive actually answers
on. Everything the source introduces — its `archiveRoot`, and every redirect it
posts — is held inside the origin of this value, because that origin is the one
thing about the destination that you chose rather than the peer. A scheme or
port that differs from where the archive really lives is therefore a refusal,
not a redirect the client will chase. The single exception is the shape a real
host almost always presents: a plain `http://<host>` that answers `301` up to
`https://<host>`, both on their default ports, resolves — the hostname is
unchanged and the peer picks neither host nor port, so the upgrade can only
increase assurance. An explicit non-default port on either side is outside that
exception; name the final origin and you never meet it.

The trust-policy anchor — `trust.genesisDigest` and the signed version chain
that goes in `trust.policyDirectory` — is not published on the serving plane.
Get it from the source's publisher and store the chain as one file per version,
named so that name order is version order.

## 4. Configure the `corpus` block

The document is `config.json` inside `JINN_PLUGIN_HOME` — `~/.jinn-plugin/config.json`
unless the environment names another home. It is optional: a default install
has none and runs on the schema defaults, following no archives. An ABSENT file
is the only thing that reads as no document — an unreadable one, a non-JSON
one, and a file containing `null` are all startup failures, so a corrupt
`corpus` block never degrades into silently following nothing.

It must be owner-only. This document is the sole place the followed-source
list, its signing keys, the trust policy, and the verification posture are
declared, so a mode any other local user can write is a way to become a
trusted publisher of everything this install injects into an agent's context.
The runtime refuses to start on anything looser and tells you the mode it
found:

```bash
chmod 600 "$JINN_PLUGIN_HOME/config.json"
```

The document may itself carry a `home` key, which relocates the runtime's data
tree. It does not relocate the document: the file is always read from the home
the environment names, because finding it any other way would mean reading it
to learn where to read it from.

```json
{
  "corpus": {
    "sources": [
      {
        "agent": "did:key:z6Mk…",
        "name": "attempts",
        "servingRoot": "https://records.example.org/publication",
        "archiveRootUrl": "https://records.example.org/publication/sources/attempts/entries/0000000000000042",
        "repositoryId": "records.example.org/attempts",
        "signingKeys": [
          { "keyid": "did:key:z6Mk…", "validFrom": "2026-07-01T00:00:00.000Z" }
        ]
      }
    ],
    "chainVerification": "verified",
    "trust": {
      "genesisDigest": "sha256:…",
      "policyDirectory": "corpus-trust"
    },
    "syncIntervalMs": 300000
  }
}
```

`chainVerification: "verified"` is the default and the only posture a mirror
over a remote feed may take. `unverified` is reachable only by also writing
`acknowledgeUnverifiedChain: true`, and is for local development.

`policyDirectory` resolves relative to `JINN_PLUGIN_HOME`. `syncIntervalMs`
defaults to 300000 (5 minutes); the floor is 1000 and the ceiling is 24 hours.
`syncTimeoutMs` bounds one cycle and defaults to 30000.

Every key here is file-only, with no environment override — which archives may
inject content into an agent's context is authority, and authority is not
acquired ambiently. The reasoning is recorded in
[`docs/superpowers/plans/2026-07-30-plugin-c5-mirror-and-retrieval.md`](../superpowers/plans/2026-07-30-plugin-c5-mirror-and-retrieval.md)
and restated at the schema in `plugin/runtime/src/config.ts`.

## 5. Run

```bash
JINN_PLUGIN_HOME=/var/lib/jinn-plugin jinn-plugin-runtime mirror
```

The process runs until SIGINT or SIGTERM, logs one line per cycle, and exposes
no port. `JINN_PLUGIN_HOME` defaults to `~/.jinn-plugin`.

Under a supervisor, restart-always is the correct policy:

```ini
[Service]
Environment=JINN_PLUGIN_HOME=/var/lib/jinn-plugin
ExecStart=/usr/bin/jinn-plugin-runtime mirror
Restart=always
RestartSec=10
```

Restarting is safe at any moment. Each cycle resumes from the durable
high-water mark, so a process killed mid-import re-walks from the last position
it committed rather than from genesis, and imports are addressed by digest, so
re-importing a record it already holds is a no-op. Only one process may sync a
given home at a time; a second one takes no lock, skips its cycle, and says so.

## 6. On-disk state

Everything is under `JINN_PLUGIN_HOME`:

| Path | What it is |
|------|-----------|
| `mirror-state.json` | the high-water mark per followed source — the sync position, and the `issuedAt` floor the next head has to clear |
| `mirror-sync-status.json` | the service's own report: when the last cycle completed, its status, and the last sync or failure per source |
| `mirror/catalog.sqlite` | the mirrored records' catalog projections |
| `mirror/objects/` | the mirrored record bytes, addressed by digest |
| `mirror-sync.lock` | the exclusive sync lock |
| `index.sqlite` | the relevance index `corpus_search` reads |
| `config.json` | this install's configuration document, including the `corpus` block above |

One destructive act is supported: **delete `mirror-state.json` to cold-sync from
genesis.** That is the repair for a position that has outlived its data — the
`corpus-mirror` health row names it when it detects one. Deleting anything else
by hand, `mirror/catalog.sqlite` above all, produces exactly that state.

## 7. Monitoring

Each cycle writes one JSON line to stderr:

```json
{"status":"synced","indexed":true,"freshness":"ok","level":"info","message":"corpus.mirror.cycle"}
```

`status` is `synced`, `partial`, `failed`, or `skipped-locked`; `indexed` says
whether an index pass followed; a cycle that threw carries `error`; a cycle
that mirrored but whose index pass failed carries `indexError`, and keeps
`status: "synced"` — the mirror succeeded, the pass that makes what it
mirrored searchable did not. `freshness` is the `corpus-mirror-freshness`
verdict for that cycle, `ok` or `stale`. The same facts, plus per-source
timestamps, are in `mirror-sync-status.json`. That file lists only the sources
this install currently follows: drop a source from `corpus.sources` and its
entry goes with it at the next start.

A `stale` verdict is also written on its own line, at `warn`, carrying the
row's full detail and remedy:

```json
{"detail":"1 of 1 followed archive(s) have not synced …","remedy":"…","level":"warn","message":"corpus-mirror-freshness"}
```

The health rows are contributed by the capabilities that are actually
composed, so where you read one depends on which process holds it. The
`mirror` process contributes the four rows below and exposes no surface to
print them, which is why the status file and the cycle line are its channel. A
`serve --role tools` process answers the `health` MCP tool with `corpus-index`
and every row below except `corpus-mirror-freshness`, which only the sync loop
contributes. The `health` command composes neither and reports on capture
alone.

| Row | Contributed by | Red means |
|-----|----------------|-----------|
| `corpus-mirror-freshness` | `mirror` | a followed archive has not synced within two intervals (or one interval plus a sync timeout, whichever is longer); or the cycle mirrored but its index pass failed. The remedy names the cause it observed — a peer holding the sync lock, a failed index pass, or `corpus-chain-verification` |
| `corpus-chain-verification` | `mirror`, `serve` | this install refused a followed archive's chain, or cannot verify one at all. It names the archive and the refusal |
| `corpus-mirror` | `mirror`, `serve` | archives are followed but none has a sync position, or a position survived the catalog it describes |
| `corpus-trust-policy` | `mirror`, `serve` | archives are followed with no trust policy configured, or the configured chain could not be read |
| `corpus-index` | `serve` only | the index was written before and is now empty |

`skipped-locked` on its own is not a fault. It means another process held the
sync lock for that cycle, which is the expected reading when a `serve` process
syncs opportunistically alongside the service, or during a restart overlap. The
freshness row is what turns a run of skipped cycles into a fault, and only once
a source has actually gone stale.

## 8. Verify a fresh client answers

The acceptance test is a client that did no syncing of its own:

```bash
JINN_PLUGIN_HOME=/var/lib/jinn-plugin jinn-plugin-runtime serve --role tools
```

Point an MCP client at that process and call `corpus_search` with a query
describing work the followed source has published. A non-zero `count` whose
candidates are on the `public` plane is the proof: those records reached this
machine through the mirror, and nothing but the mirror put them in the index.

An empty result with a green `corpus-mirror` row means the mirror holds
records and the query simply did not match. `corpus-index` separates the two —
it carries the indexed counts, and an index that has never been written says
so.

## 9. What remains an operator step

This runbook ends at a supervised process. Choosing the host, wiring the
supervisor, sizing the disk for `mirror/objects/` against a growing feed, and
obtaining the source's coordinates — its agent `did:key`, name, serving root,
archive root, signing keyid, and trust-policy chain — are operator acts. The
first five are read from the feed as in §3; the trust chain comes from the
source's publisher. None of them are compiled in, and no default names any
source.
