# `@jinn-network/record-discovery-transport-http`

Production HTTP transports for the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §7). This package
is the tier-3 adapter tree that supplies every production plug the record-discovery
serve/client pair leaves as an injected port: a filesystem `BlobStore`, an HTTP handler over
`serve`'s static layout, and client-side `Transport` / `StreamTransport` / ping
implementations.

Full documentation lands with the package's implementation tasks; this is a placeholder.
