# Quickstarts

| Consumer class | What it is | Quickstart | Custody |
| --- | --- | --- | --- |
| CLI operator | Runs the published `jinn` binary; posts and observes Tasks through `jinn tasks submit`. | [`class-1-cli.md`](class-1-cli.md) | `jinn` manages its own local encrypted keystore. |
| Platform implementer | Builds a backend against the published conformance kits and fixtures, without running Jinn's own code. | not yet landed on this branch | n/a |
| Work-client / custody-conscious integrator | Posts Tasks in-process through `@jinn-network/marketplace-work-client`, driven by a caller-supplied signer. | not yet landed on this branch | dedicated signer, dedicated posting Safe, capped funds |
| Read-side composer | Reads discovery + evidence without posting, composing `@jinn-network/record-discovery-client` and `@jinn-network/evidence-retrieval` directly. | not yet landed on this branch | n/a — read-only |

The platform-implementer, work-client, and read-side quickstarts depend on
package trees (`packages/marketplace/`, `packages/task-execution/`,
`packages/discovery/`, `packages/trust/`) that exist on
`integration/evidence-v1` but are not part of this branch. They land here
once that work merges to `next`.
