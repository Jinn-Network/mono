# @jinn-network/plugin-runtime

The Jinn Plugin runtime skeleton for C3: a small capability container with typed
configuration injection, health reporting, and structured logging. Later components add
capture, retrieval, corpus mirror, relevance, and MCP surfaces on top of this scaffold.

There is no capture, retrieval, publication, or MCP capability in this package yet.

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
