# @jinn-network/plugin-runtime

The Jinn Plugin runtime: a capability container with typed configuration injection, health
reporting, structured logging, and session capture. C5 adds corpus library surfaces on top of
that scaffold; later components add publication, relevance, and MCP.

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

**Binary wiring.** `bin.ts` / `jinn-plugin-runtime` still registers `capabilities: []`
until a later wave wires corpus into the process. `health` therefore reports an empty
check list today; pack-smoke expects that. Use the library API directly until then.

Capture, publication, and MCP are not in this package yet.

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
`BinIo` / `io.captureSigner`. The default `jinn-plugin-runtime` entry omits it until C7 wires
the host adapter signer.

Capture turns one observed agent session into two sealed products in your local archive: an
**Execution Evidence record** — the same record family every producer on the platform writes
— and a **Trajectory record** describing what happened inside it. Nothing leaves the machine;
there is no outbound lane in this build.

### What is written, and where

| Path | Contents | Lifetime |
| --- | --- | --- |
| `<home>/capture/sessions/<id>/feed.ndjson` | the session feed the host adapter appends to, verbatim | swept once older than the retention window |
| `<home>/capture/workspaces/<id>/` | the recorder's staging workspace, holding a copy of every captured byte | swept once older than the retention window |
| `<home>/capture/derivation-links/<digest>.json` | durable execution-to-trajectory attestation link | same lifetime as the local archive; not swept by retention |
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
2. **Feed lines are never reordered or rewritten**, and every trajectory span carries
   `jinn.trajectory.source.ordinal` — the 0-based line ordinal. An exclusion decision taken
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
