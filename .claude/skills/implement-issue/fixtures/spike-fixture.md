Issue Type: spike | Effort: Medium

Title: Audit network-error classifier duplication between discovery/with-fallback.ts and chain-read-errors.ts

**Context.** The codebase contains two independent network-error classifier functions that have drifted apart:

1. `client/src/chain-read-errors.ts` → `isTransientEthReadError` — classifies RPC transport failures for the bootstrap reconciliation loop. Covers HTTP codes (429, 502, 503), JSON-RPC codes (-32603, -32005), socket errors (econnreset, etimedout, socket hang up, fetch failed, network error, connection refused, connect timeout), and ethers-style `.code` values (SERVER_ERROR, TIMEOUT, NETWORK_ERROR).

2. `client/src/discovery/with-fallback.ts` → `isNetworkError` (internal) — classifies failures for the DiscoveryAPI fallback wrapper. Covers a subset of the same signals but with differences: adds `DiscoveryUnavailableError` (absent from chain-read-errors), omits `timeout` as a substring match (present in chain-read-errors), and has different ordering and coverage of JSON-RPC error codes.

These two classifiers were written independently and have no shared implementation despite conceptually classifying the same class of errors ("transient infrastructure failure, not a logical error"). As the daemon adds more subsystems that need fallback behaviour, keeping two diverging classifiers in sync by hand will produce subtle inconsistencies — a new transient error pattern added to one will silently miss the other.

The `with-fallback` classifier also does not call `flattenErrorMessage` from `tx-retry.ts`, meaning nested `.cause` chains that `isTransientEthReadError` would catch are invisible to the discovery fallback.

**Impact.** Inconsistent fallback behaviour: an RPC transport failure that triggers fleet-level transient handling may not trigger DiscoveryAPI fallback, or vice versa. The risk grows as new error shapes appear in the wild (new node providers, proxy errors, gRPC-mapped HTTP codes).

**Acceptance criteria.**
- [ ] The spike produces a written finding (a comment in a bd note or a short doc) that answers: (a) what signals are in one classifier but missing from the other; (b) whether `DiscoveryUnavailableError` should be incorporated into `isTransientEthReadError` or remain separate; (c) whether a single shared helper is safe to introduce without breaking either consumer; (d) a recommended next action (consolidate / keep separate with a sync test / accept divergence with documented rationale).
- [ ] No production code is changed — the output is a finding only.

**Files/components.** `client/src/chain-read-errors.ts` (`isTransientEthReadError`), `client/src/discovery/with-fallback.ts` (`isNetworkError`), `client/src/tx-retry.ts` (`flattenErrorMessage`), `client/test/chain-read-errors.test.ts` (existing coverage baseline).
