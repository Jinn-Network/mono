# @jinn-network/plugin-runtime

The Jinn Plugin runtime: a capability container with typed configuration injection, health
reporting, structured logging, MCP serving, and session capture. C4 adds capture; C5 adds
corpus library surfaces; C6 adds relevance and projection; C7 ships the MCP surface
(`tools` and `session` roles). Publication and registry acquisition remain deferred to C8.

**MCP (C7).** `jinn-plugin-runtime serve` starts an MCP server on stdio. Two roles:

- **`tools`** (default) — read-only corpus tools (`inspect_record`, `acquire_artifact`,
  `pickup_context`). No capture signer required.
- **`session`** — the same tools plus session capture. Requires the composition root to
  inject `captureSigner` on `BinIo` (F-C4-T13-2); the runtime never acquires key material
  itself.

Use `jinn-plugin-runtime-session` (F-C7-T20-1) when the host needs the session role: that
entry loads an ephemeral local Ed25519 key and invokes `serve --role session` with
`captureSigner` injected. The bare `jinn-plugin-runtime` binary defaults to `tools`.

**Corpus library (C5).** Exported from the package root (`src/corpus/`, re-exported
via `index.ts`): `createCorpusCapability` composes mirror, retrieval, reader, and health
checks; lower-level entry points include `createCorpusMirror`, `createCorpusRetrieval`,
`createCorpusReader`, `openCorpusMirrorStore` / `withCorpusMirrorStore`, plus admission
and chain-verification helpers. See the corpus module exports for the full surface.

**Finding F1 (chain verification).** This package ships no announcement-chain verification
driver. Default posture is fail-closed: with `corpus.acknowledgeUnverifiedChain` left at
its default (`false`), the mirror indexes nothing. Operators who accept an unverified
posture set `corpus.acknowledgeUnverifiedChain: true` in config; driver wiring is
deferred.

**Binary wiring.** `bin.ts` registers MCP on `serve` and wires corpus, relevance, and
capture capabilities when the composition root supplies the required ports and signer.
The `health` command reports capture checks only when `captureSigner` is injected on
`BinIo`; without it, the check list is empty. Corpus ports are optional on `serve` —
retrieval is fail-closed when they are absent.

**Relevance and projection (C6).** Exported from the package root: `openRelevanceIndex`,
`runPickup`, `projectContext`, `renderFencedBlock`, `rebuildIndex`, sensitivity
classification, and corpus admission helpers. See the Relevance index section below.

The runtime is a **capability container**. Configuration is typed and injected — the
library never reads the ambient environment; only the binary does, and it passes what it
read. Capabilities register against a lifecycle (`start` / `health` / `stop`) and
contribute health checks in the `{ name, ok, detail, remedy }` shape the host adapter's
doctor renders.

**stdout contract:** `serve` writes nothing to stdout — stdout stays empty while the
runtime waits for shutdown. The only deliberate stdout writes are the explicit CLI outputs
`--version` (one version line) and `health` (one JSON report line). Every diagnostic goes
to stderr.

The binary is `jinn-plugin-runtime`. The host adapter acquires it by exact pin.

See `../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §6.

## Capture and local privacy

**F-C4-T13-2:** capture registers only when the composition root injects `captureSigner` on
`BinIo` / `io.captureSigner`. The default `jinn-plugin-runtime` entry omits it. The
`jinn-plugin-runtime-session` host entry loads an ephemeral local Ed25519 key under
`<home>/capture-signer/` and injects it — production key custody remains a residual.

Capture turns one observed agent session into two sealed products in your local archive: an
**Execution Evidence record** — the same record family every producer on the platform writes
— and a **Trace record** describing what happened inside it. Nothing leaves the machine;
there is no outbound lane in this build.

### What is written, and where

| Path | Contents | Lifetime |
| --- | --- | --- |
| `<home>/capture/sessions/<id>/feed.ndjson` | the session feed the host adapter appends to, verbatim | swept once older than the retention window |
| `<home>/capture/workspaces/<id>/` | the recorder's staging workspace, holding a copy of every captured byte | swept once older than the retention window |
| `<home>/capture/derivation-links/<digest>.json` | durable execution-to-trace attestation link | same lifetime as the local archive; not swept by retention |
| `<home>/archive/` | the sealed records and their content-addressed artifacts | append-only; see Retention |

Everything above is created **owner-only** — directories `0700`, files `0600` — which is the
same exposure class the host already keeps its own session logs in. Capture adds a copy
inside that class; it does not open a new one.

### This runtime does not scrub at capture time

Sealing binds the feed's exact bytes, so a capture-time scrub would both destroy the material
and break the binding. The regression that matters locally is not exfiltration — nothing
leaves — it is **re-injection**: a secret pasted in one session resurfacing in a later
session's context, where the agent holds tools. That loop is closed at **index time**, by the
relevance component, using the derivation detector model. This runtime's job is to preserve
what makes that possible:

1. **The feed is kept verbatim** as a digest-bound artifact. The detector needs the real text
   to find anything.
2. **Feed lines are never reordered or rewritten**, and every trace span carries
   `jinn.trace.source.ordinal` — the 0-based line ordinal. An exclusion decision taken
   per feed line therefore has a stable identifier that maps back to spans.
3. **Message content is confined to the feed** — except for two derived artifacts that quote
   the user, and which the index-time detector must therefore also scan:
   `input/session-task.json` and `results/session-summary.json` both embed the session
   summary, which falls back to the first line of the first user turn.
4. **The retention watermark** at `<home>/capture/retention.json` gives the index a time
   boundary: captures older than the window are excluded from retrieval.

### Retention

Session feeds and capture workspaces are duplicates of material already sealed in your
archive; they are deleted once older than the retention window (30 days by default,
`JINN_PLUGIN_CAPTURE_RETENTION_DAYS`). Derivation links under
`<home>/capture/derivation-links/` are not swept — they persist for the same logical
lifetime as the local archive and are removed only when the archive directory is removed.
Sealed records are never deleted — the local archive is append-only — but captures older
than the window are excluded from retrieval, so old sessions stop resurfacing in your
context. Removing a sealed capture today means removing the archive directory; see the
plan's Findings for the tracked gap.

### Two limits worth knowing

Sessions are normally sealed when they end. If that is interrupted — the archive was busy
because a sibling session was writing to it, or the process was killed — the feed stays
staged and is sealed at the **start of your next session**, before your first turn. Two cases
that leaves open, stated rather than hidden:

- **A session cut short by a hard kill carries no end record.** Nothing can honestly say when
  it ended or how it went, so it is not sealed. It stays staged until the retention window
  passes and is then deleted; the doctor reports it if it happens.
- **If your last session strands and you never open another, its feed stays staged.**
  Recovery runs at session start, and there is no background process to run it otherwise —
by design: nothing in this product runs when you are not working. The feed is on disk,
owner-only, and untouched; a later session picks it up whenever you next start one.

### One archive, one holder

The local evidence archive takes an **exclusive** lock. Capture therefore opens it only for
the duration of one seal and closes it again, and never holds a handle across a session. A
seal that finds the archive held waits, and after
`JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS` (10 s by default) reports `capture-archive-busy`.

## Relevance index

The runtime keeps a local full-text index at `config.indexPath` over both evidence planes:
the operator's own archive and the mirrored public corpus. It is a **derived cache** — never
announced, never sealed, never a source of truth — and it can be rebuilt from the planes at
any time with `rebuildIndex`.

Ranking is deliberately local. The record-discovery protocol forbids server-side ranking, so
relevance is the product's own work: terms are derived from the session's first message and
repository, and a record scores by *distinct* term coverage, so repeating a keyword earns
nothing.

**Tokenizer:** SQLite FTS5 `unicode61 remove_diacritics 2`, plus a product-side identifier
expansion that splits camelCase into its parts. `unicode61` already splits on `_`, `.`, `-`,
and `/`, so snake_case and path-shaped identifiers index correctly.

**Known limitation — CJK.** `unicode61` does not segment CJK text: a run of ideographs
becomes one token, so CJK sessions are captured and stored correctly but retrieve poorly.
Adding the `trigram` tokenizer would fix this and is deliberately deferred: it is optional in
some SQLite builds, it doubles the index, and its three-character minimum degrades short
terms. Because the index is a rebuildable cache and its generation records which tokenizer
built it, changing this later costs one rebuild.

**Sensitivity exclusion.** Every excerpt is classified at index time with the
`evidence/derivation` detector model. Material carrying high-confidence credential,
key-shaped, or funds-controlling findings is excluded from the index, so it can never be
ranked and never be projected. Secrets may exist in a sealed record; they do not come back
through pickup.
