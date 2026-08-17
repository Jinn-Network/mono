# @jinn-network/chain-state-extraction

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

Drafts chain environment **candidates** and drives them to convergence.

## What this package produces, exactly

`extractEnvironment` returns a **candidate**: a chain environment record body, a state
artifact, and an E13 coverage manifest, together with the connected-fork baseline
observation they were derived from. A candidate is a proposal. It is not verified, and this
package never says it is.

`widenAndReverify` runs the design §7 loop: it asks
`@jinn-network/chain-environment-verification` to run the closed-state protocol against the
candidate under blackhole, compares the resulting observation with the connected baseline,
and — when they differ because the committed slice is too narrow — localizes the missing
accounts and slots, widens the artifact, re-seals, and repeats. It terminates either with a
converged candidate carrying **CE3's** attestation, or with a typed failure naming what
would not close.

`converged` means exactly: *the blackholed runs CE3 performed produced the same canonical
observation digest as the connected baseline.* Any stronger reading — fidelity to the
public chain, task solvability, provider honesty — belongs to the coverage manifest, the
E5 anchor bound, or nobody.

## Why the loop exists

A fork backend fetches missing state lazily, so a state dump taken from a forked instance
contains only what execution happened to touch, and dump fidelity has a real bug history
(family design §10). Closure is therefore earned by reproducing the baseline offline, not
asserted by taking a dump. Out-of-slice reads in a sealed instance return *empty,
deterministically*, so a too-narrow slice makes the world **stably wrong** — which is what
makes the divergence signal decidable rather than flaky.

## The one network dependency

`ArchiveRpcPort` is injected, is used at authoring time only, and is wrapped in a budget
before any module sees it: `maxCalls`, `maxBytes`, and `maxWidenings`, all ceilinged. No
file in `src/` opens a socket, holds a URL, or names a provider.

## Conformance kit

The published kit lives at `@jinn-network/chain-state-extraction/testing`. It runs on fakes
only — no Anvil, Docker, or network — and drives the full extract → widen loop through CE3's
real `verifyChainEnvironment`.

Exports include `buildFakeTrieWorld`, `createFakeArchive`, `createFakeChainRuntime`,
`createFakeStateDumpPort`, `createInMemoryArtifactStore`, `createFixedClock`,
`createFakeExtractionDeps`, `fakeExtractionRequest`, `fakeStateArtifact`, `fakeBaseline`,
the `FAKE_*` constants, and `describeChainExtractionConformance({ signer })`. The host
supplies a `DsseSigner`; the kit holds no key material.

Five scenarios are asserted end-to-end: first-pass convergence, convergence after two
widenings, bound exhaustion under infinite hidden reads, archive self-disagreement refusal,
and dump omission detection without shipping a broken artifact.
