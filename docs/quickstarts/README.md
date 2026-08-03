# Quickstarts

| Class | Consumer class | What it is | Quickstart | Custody |
| --- | --- | --- | --- | --- |
| 1 | CLI operator | Runs the published `jinn` binary; posts and observes Tasks through `jinn tasks submit`. | [`class-1-cli.md`](class-1-cli.md) | `jinn` manages its own local encrypted keystore. |
| 2 | Platform implementer | Builds a backend against the published conformance kits and fixtures, without running Jinn's own code. | not yet landed on this branch | n/a |
| 3 | Work-client / custody-conscious integrator | Posts Tasks in-process through `@jinn-network/marketplace-work-client`, driven by a caller-supplied signer. | not yet landed on this branch | dedicated signer, dedicated posting Safe, capped funds |
| 4 | Read-side composer | Reads discovery + evidence without posting, composing `@jinn-network/record-discovery-client` and `@jinn-network/evidence-retrieval` directly. | not yet landed on this branch | n/a — read-only |
