# Scenario T2.1 — Cross-operator donation

**Tier:** 2 (substrate-derived workspace, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** x402 + ERC-8128 handshake regressions, corpus indexer attribution bugs, payment-gated artifact access bugs.

## Goal

op-a produces a corpus artifact, the indexer attributes it on-chain, op-b discovers the envelope via the `Corpus` library, op-b pays x402 USDC, op-b retrieves the artifact bytes, and the ERC-8128 signature + payload validate end-to-end with USDC balance deltas confirmed on both operators.

This is the gate that should have caught the #310 silent breakage (donation-consumption gate was passing because op-a wasn't producing, so consumption couldn't verify).

## Implementation location

`operator/test/release/tier-2/T2.1-cross-op-donation.ts`

## Real API surface

There is **no `/v1/corpus/*` REST surface** — corpus production is a side effect of task execution, not a REST call. T2.1 drives the surface operators actually use, proven by `operator/test/e2e/corpus-x402.ts`:

- `GET /v1/artifacts/:sha256/content` — x402-gated artifact serving (`operator/src/x402/handler.ts`). Keyed by sha256, dynamic per-row price, real 402 → verify → settle → 200 + `PAYMENT-RESPONSE` header.
- The `Corpus` library (`operator/src/corpus/index.ts`) — envelope discovery via the injected `DiscoveryAPI` (Ponder HTTP primary + on-chain `MetadataSet`-log floor via `withFallback`).
- `acquireArtifactWithPayment` (`operator/src/x402/acquire.ts`) — the buyer-side x402 dance.

Note the production daemon does **not** wire x402 onto its own `ApiServer` (`DaemonConfig.x402` is never set in `main.ts`), so the x402-gated serving route only exists on an `ApiServer` started with an explicit `x402` config. T2.1 hosts the producer's `ApiServer` + served-artifact store inside the substrate workspace, exactly as `corpus-x402.ts` does.

## Setup

- substrate workspace + Anvil fork of Base Sepolia + op-a/op-b daemons via `setupTier2Scenario({ scenarioId: 'T2.1', portBase: 7750 })` (`operator/test/release/tier-2/tier-2-helpers.ts`)
- producer (op-a) and consumer (op-b) are deterministic test keys funded on the fork via anvil cheatcodes — `anvil_setBalance` for producer gas, USDC storage-slot manipulation for consumer USDC
- the producer's served-artifact store is seeded directly (`saveServedArtifact` + a hand-built `SignedEnvelope`) rather than by driving a full task execution — the latter adds Anvil task-lifecycle flakiness for no extra coverage of the donation handshake

## Steps

1. `setupTier2Scenario` — substrate workspace copy + Anvil fork of Base Sepolia + two booted operator daemons.
2. Fund producer ETH + consumer USDC on the fork.
3. op-a produces a corpus artifact: seed `served_artifacts`, build the ERC-8128-signed envelope, start an x402-configured `ApiServer` for op-a.
4. Publish an on-chain `MetadataSet` attribution event; the `DiscoveryAPI` on-chain floor indexes it.
5. op-b discovers the envelope through the `Corpus` library, pays x402, retrieves + sha256-verifies the bytes.
6. Verify USDC balance deltas (producer +price, consumer −price) and the producer's `paid_served` access event.

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | op-a's served artifact + signed envelope are produced | producer side works |
| A2 | the `DiscoveryAPI` floor attributes the envelope to op-a | indexer cross-op visibility |
| A3 | op-b's unpaid `GET /v1/artifacts/:sha256/content` returns 402 | gating works |
| A4 | op-b's x402 payment settles on-chain | x402 payment side works |
| A5 | op-b's paid retrieval returns 200 + sha256-correct bytes | gating releases after payment |
| A6 | the discovered envelope's secp256k1 signature validates to op-a | end-to-end provenance |
| A7 | USDC deltas: producer +price, consumer −price; `paid_served` event recorded | settlement is real |

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| op-a never produces artifact | real-bug | BLOCKING — producer side broken |
| indexer never attributes the envelope | flake-timing first attempt; real-bug on second | retry; if persistent, blocking |
| op-b's unpaid read returns 200 (no gate) | real-bug | BLOCKING — gate bypass |
| x402 settlement fails | flake-infra or real-bug | retry; if persistent, check x402/USDC |
| Paid retrieval returns 402 | real-bug | BLOCKING — payment not honored |
| Signature mismatch | real-bug | BLOCKING — provenance broken |
| RPC saturation mid-test | flake-infra | retry once with jittered delay |

## Wall-clock

~5 minutes:
- ~60s substrate copy + Anvil fork + daemon boot
- ~30s artifact production + on-chain attribution
- ~60s x402 payment + retrieval
- ~30s signature + balance-delta verification
- ~30s setup/teardown overhead

## Dependencies

- Substrate workspace via `substrate-copy` (`operator/scripts/release/substrate-copy.ts`) — needs the gold operator homes under `~/jinn-dev/operators/`
- `BASE_SEPOLIA_RPC_URL` set to a Base Sepolia RPC endpoint (the scenario forks it; absent → clean `skip`)
- Built `dist/bin/jinn.js` (the daemons are spawned subprocesses)
- The x402-gated serving route, `Corpus` library, and `acquireArtifactWithPayment` — all proven by `operator/test/e2e/corpus-x402.ts`

## What this scenario does NOT catch

- Real-network token economics (use Tier 3 for that)
- Indexer behavior under high write load (this scenario is one writer, one reader)
- Cross-chain donation scenarios
- Corpus production via real task execution (driven directly here; Tier 3 exercises the full lifecycle)
