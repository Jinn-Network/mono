# Demo-1 E4 preregistration adapter

**Status:** implemented adapter and offline verification surface; no live anchor submitted

**Lifecycle stage:** after final lock, before any official run-journal activity

**Boundary:** ordering witness only; not report publication or Record Discovery

## Exact commitment

The benchmark product accepts one strict object with exactly four fields:

- `runSha256`: SHA-256 of the exact sealed Run bytes;
- `methodSummarySha256`: SHA-256 of the operator-signed frozen method summary;
- `graderProgramSha256`: SHA-256 of the sealed grader program;
- `sourceCommit`: the full lowercase 40-character source Git commit.

Unknown fields, shortened commits, prefixed digests, uppercase digests, or missing values are
refused before the injected boundary is called. The submitted content is the canonical JSON bytes
of those four fields and nothing else.

## Existing generic-anchor seam

`Demo1PreregistrationAnchorBoundary` is a product-owned structural port. Its composition adapter
maps the three calls to the existing generic path:

1. place the exact commitment bytes behind the generic IPFS manifest upload;
2. anchor the resulting manifest CID through the existing ERC-8004 manifest transaction path;
3. read the anchored CID, transaction, exact content bytes, and the transaction block back.

The benchmark product does not import `@jinn-network/evidence-publication`, `jinn-layer`, or the
client; it does not own an RPC endpoint, IPFS endpoint, wallet, or credential lookup. No API in
`@jinn-network/evidence-publication` is changed. A live composition is intentionally absent from
this packet; tests inject an in-memory fake boundary.

Read-back succeeds only when the canonical bytes, their SHA-256, manifest CID, and transaction hash
all match exactly. Timestamp evidence must identify a canonical UTC timestamp from a concrete
ERC-8004 transaction block, with chain ID, decimal block number, and block hash. A missing result,
local-clock label, malformed block identity, or any mismatch is `venue-unverifiable`.

The returned witness is a local handoff artifact. It is not a new Evidence Protocol record kind,
does not change Tier 1-3 semantics, and does not mean Demo-1 or its report is published.

## Required ordering sequence

1. Finish P5 and every pre-lock method/E3 decision.
2. Seal the final Benchmark and Run; record the Run digest and `lockedAt`.
3. Invoke the adapter through the operator-supplied generic manifest boundary and preserve the
   canonical witness bytes.
4. Run the command below. It reads the real locked Run state and append-only run journal. It fails
   unless the witness binds the same Run, the external block does not predate lock, `launchedAt` is
   absent, and the run journal is empty.
5. Only after a successful command may the first official cell dispatch.
6. Once that dispatch is durably journaled, run
   `verifyDemo1PreregistrationRunOrdering` over the append-only journal. It derives the first real
   solve dispatch from the earliest solve `submission-accepted`/`cell-event:dispatch` fact and
   requires the external block timestamp to be strictly earlier. Equal, late, missing, or
   evaluation-only evidence fails closed.

The one-command pre-dispatch gate is:

```text
colophon demo1 prereg verify \
  --workspace <workspace> \
  --draft <draft-id> \
  --witness <witness.json> \
  --method-summary-sha256 <sha256> \
  --grader-program-sha256 <sha256> \
  --source-commit <full-git-oid> \
  --json
```

It is read-only and performs no IPFS, RPC, wallet, or other network operation. Any failure is a
hard no-dispatch result; there is no inferred witness, local timestamp fallback, or publication
claim.
