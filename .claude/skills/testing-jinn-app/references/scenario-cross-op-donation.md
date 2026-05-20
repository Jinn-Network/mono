# Scenario T2.1 — Cross-operator donation

**Tier:** 2 (substrate-derived workspace, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** x402 + ERC-8128 handshake regressions, corpus indexer attribution bugs, payment-gated artifact access bugs.

## Goal

op-a produces a corpus artifact, indexer picks it up, op-b queries Discovery API for the artifact, op-b pays x402 USDC, op-b retrieves the artifact, signature + payload validate end-to-end.

This is the gate that should have caught the #310 silent breakage (donation-consumption gate was passing because op-a wasn't producing, so consumption couldn't verify).

## Implementation location

`client/test/release/tier-2/T2.1-cross-op-donation.ts`

## Setup

- substrate workspace via `copyWorkspace({ ops: ['op-a', 'op-b'] })`
- both daemons spawned with substrate-derived HOMEs, distinct apiPorts (7732, 7733)
- Anvil-fork RPC (forks Base Sepolia); both daemons' configs point at this fork URL
- op-a config: `solverNets.<name>.roles = ['solving']` for the chosen SolverNet
- op-b config: joined to the same SolverNet via `joinedSolverNets[<manifestCid>]`

## Steps

```typescript
// 1. Spawn daemons + workspace (see multi-op-playwright.md template)
const workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
const daemons = await spawnMultiOpDaemons({
  ops: [
    { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
    { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
  ],
});

// 2. op-a produces a corpus artifact
//    Either: trigger via daemon API (POST /v1/corpus/produce) or wait for natural production tick
const opARes = await fetch(`http://127.0.0.1:7732/v1/corpus/produce`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ solverNetManifestCid: KNOWN_MANIFEST_CID, payload: SAMPLE_PAYLOAD }),
});
const { artifactCid } = await opARes.json();

// 3. Wait for indexer to pick it up (poll Discovery API)
const indexedCid = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:7733/v1/discovery/corpus?cid=${artifactCid}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body.cid === artifactCid ? body : null;
}, { timeoutMs: 60000, intervalMs: 2000 });
expect(indexedCid).toBeTruthy();

// 4. op-b queries Discovery API for the artifact (no payment yet — gated)
const previewRes = await fetch(`http://127.0.0.1:7733/v1/corpus/${artifactCid}`);
expect(previewRes.status).toBe(402);   // Payment required

// 5. op-b initiates x402 payment
const paymentRes = await fetch(`http://127.0.0.1:7733/v1/corpus/${artifactCid}/pay`, {
  method: 'POST',
});
const { paymentTx } = await paymentRes.json();
expect(paymentTx).toMatch(/^0x[a-fA-F0-9]{64}$/);

// 6. op-b retrieves the artifact (with payment proof)
const retrievedRes = await fetch(`http://127.0.0.1:7733/v1/corpus/${artifactCid}`, {
  headers: { 'x-x402-payment': paymentTx },
});
expect(retrievedRes.status).toBe(200);
const retrieved = await retrievedRes.json();
expect(retrieved.payload).toEqual(SAMPLE_PAYLOAD);

// 7. Verify the ERC-8128 signature on the artifact
const sigValid = await verifyErc8128Signature(retrieved);
expect(sigValid).toBe(true);

// 8. Cleanup
await daemons.teardown();
await workspace.teardown();
```

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | op-a produces an artifact with a valid CID | producer side works |
| A2 | indexer attributes the artifact to op-a within 60s | indexer cross-op visibility |
| A3 | op-b's unpaid query returns 402 | gating works |
| A4 | op-b's payment tx is mined | x402 payment side works |
| A5 | op-b's paid retrieval returns 200 + correct payload | gating releases after payment |
| A6 | ERC-8128 signature on retrieved artifact validates | end-to-end provenance |

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| op-a never produces artifact | real-bug | BLOCKING — producer side broken |
| indexer never sees artifact within 60s | flake-timing first attempt; real-bug on second | retry; if persistent, blocking |
| op-b's preview returns 200 (no gate) | real-bug | BLOCKING — gate bypass |
| Payment tx fails | flake-infra or real-bug | retry; if persistent, check x402 contract |
| Paid retrieval returns 402 | real-bug | BLOCKING — payment not honored |
| Signature mismatch | real-bug | BLOCKING — provenance broken |
| RPC saturation mid-test | flake-infra | retry once with jittered delay |

## Wall-clock

~5 minutes:
- 30s daemon spawn
- 60s artifact production + indexer
- 60s payment + retrieval
- 30s signature verification
- ~30s setup/teardown overhead

## Dependencies

- Substrate workspace via Plan A's `substrate-copy`
- Daemon HTTP API endpoints: `/v1/corpus/produce`, `/v1/corpus/:cid`, `/v1/corpus/:cid/pay`, `/v1/discovery/corpus` (these mostly exist in v0.1.6; verify shape at implementation time)
- Anvil-fork-of-Base-Sepolia RPC (existing pattern in client/test/e2e/)
- KNOWN_MANIFEST_CID — the substrate-pinned SolverNet manifest that both ops are joined to (read from op-a's manifest.json or config.json)
- Existing helper: `verifyErc8128Signature` (or implement inline using the existing ERC-8128 module)

## What this scenario does NOT catch

- Real-network token economics (use Tier 3 for that)
- Indexer behavior under high write load (this scenario is one writer, one reader)
- Cross-chain donation scenarios
