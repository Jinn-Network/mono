# @jinn-network/plugin-runtime

The Jinn Plugin runtime skeleton for C3: a small capability container with typed
configuration injection, health reporting, and structured logging. C5 adds corpus
library surfaces on top of that scaffold; later components add capture, publication,
relevance, and MCP.

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
