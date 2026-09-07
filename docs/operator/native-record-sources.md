# Native record sources and origin containment

How an operator configures the `sources` block of `native-config.json`, and the one deployment
requirement that block silently imposes: **a peer's announced record locator must sit under the
exact `baseUrl` you configured for that peer.**

Target audience: you are filling in `operator.native.sources` for a `native-v1` deployment
(`operator/src/daemon/native-product-config.ts`), or you are staring at an IPFS
"block was not found" for a record you know a peer is serving.

## What `sources` is

Each entry names one signed public record source this operator consumes:

```json
"sources": [
  {
    "role": "requester",
    "agent": "urn:jinn:agent:requester-a",
    "name": "requester-records",
    "baseUrl": "https://requester-a.example"
  },
  {
    "role": "solver",
    "agent": "urn:jinn:agent:solver-b",
    "name": "solver-records",
    "baseUrl": "https://solver-b.example"
  }
]
```

At least one entry is required, a source identity (`agent` + `name`) may not appear twice, and
`baseUrl` must be `http:` or `https:`. Which roles a deployment requires depends on the loops it
runs: the solver path needs exactly one `requester` source; the evaluator path needs exactly one
`requester` and one `solver`.

## The containment requirement

Peers announce records by locator, and a locator is attacker-influenced by construction. The
daemon therefore refuses any record destination that is not contained by an origin the operator
already chose. The admitted set is exactly:

- this operator's own `publicBaseUrl`, plus
- every `sources[].baseUrl`.

Containment is checked on **scheme, host, port and path prefix**, before any request is made, and
again at every redirect hop. A redirect from one configured root to another configured root is
admitted; a redirect anywhere else is not.

So the requirement, stated exactly: **every locator a peer announces must resolve to a URL under
the `baseUrl` you configured for that peer, spelled the same way** — same scheme, same host, same
port, and within the same path prefix. Configure the URL the peer actually advertises, not a
proxy hostname, an alias, or a pre-redirect address.

`ipfs.apiUrl` is held to its own origin by the same rule.

## Three ways a valid-looking configuration refuses everything

Each of these parses, boots, and then refuses every record from the affected peer. Because native
records are published only to the HTTP record plane and are **never pinned to IPFS**, the daemon
falls through to the IPFS plane and the visible symptom is an IPFS "block was not found" — which
names neither the destination nor the refusal.

1. **A peer configured by one hostname while it advertises another.** `baseUrl` is
   `https://b.example` and the peer announces `https://records.b.example/records/<hex>`. Different
   host, so nothing under it is admitted.
   *Remedy:* configure the origin the peer advertises.

2. **An `http://` root behind a server that redirects to `https://`.** Containment compares
   origin, and origin includes the scheme, so the hop off `http://` leaves the configured root.
   Both schemas permit `http:`, so this configuration is legal and still refuses everything.
   *Remedy:* configure the post-redirect `https://` URL.

3. **The same, for `ipfs.apiUrl`.** An `http://ipfs.internal:5001` behind a proxy that redirects
   to `https://` worked before the destination policy landed and is now refused.
   *Remedy:* configure the post-redirect URL.

## Reading the logs

Both refusal classes name themselves on `console.warn`, prefixed `[native-records]`.

A refused destination, emitted per refusal at each of the five peer-supplied fetch paths:

```
[native-records] peer-announced record location: refused destination https://records.b.example/records/ab12: it is not contained by any configured record origin (publicBaseUrl / recordSources[].baseUrl)
```

The context before the colon says which path refused it — `peer-announced record location`,
`delivery card location`, or `fleet delivery serving plane`. When the detail says the refusal came
from `the configured IPFS API origin (ipfs.apiUrl)`, the problem is `ipfs.apiUrl`, not `sources`.

A configured root that can never admit anything — a `baseUrl` written without its scheme, or with
a non-HTTP(S) one — is named once, at startup:

```
[native-records] configured record origin "records.peer.example" is unusable: it is not an absolute URL; every locator announced under it is refused (publicBaseUrl / recordSources[].baseUrl)
```

If you see that line, the configuration entry is the cause, not the peer.

## Related

- [`docs/operator/native-evaluator-deployment.md`](native-evaluator-deployment.md) — the
  `evaluator` block of the same config file.
