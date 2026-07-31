# @jinn-network/plugin-runtime

The Jinn Plugin's runtime: one small stack-composed process that captures the host
session as a standard Execution Evidence record into a local archive, and retrieves
relevant evidence back into the agent's context from the local archive and the public
corpus.

The runtime is a **capability container**. Configuration is typed and injected — the
library never reads the ambient environment; only the binary does, and it passes what it
read. Capabilities register against a lifecycle (`start` / `health` / `stop`) and
contribute health checks in the `{ name, ok, detail, remedy }` shape the host adapter's
doctor renders.

**The local evidence archive is opened per operation, never held across `start`/`stop`.**
`openLocalEvidenceRuntime` takes an exclusive lock on the runtime root, and a session may
run two runtime instances at once; a capability holding the archive open would starve its
sibling for the session.

**stdout is reserved** for the MCP stdio transport. Every diagnostic goes to stderr; the
only stdout write in this package is the `health` subcommand's single JSON line.

The binary is `jinn-plugin-runtime`. The host adapter acquires it by exact pin.

See `../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §6.
