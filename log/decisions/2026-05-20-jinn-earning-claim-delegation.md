# JINN Earning Claim Delegation

Date: 2026-05-20
Issue: #220
Status: accepted

## Decision

Use a standing relayer for public testnet JINN earning.

Operators emit cheap `TaskClaimEmitter.ClaimTicket` events on Base Sepolia. A team-run relayer watches those events, validates each snapshot against `claimSnapshotHashes`, writes the Sepolia `MockMessenger` fixture with the owner key, and submits `JinnDistributor.claim`. The operator's Safe remains the tJINN mint recipient recovered from the claim ticket.

## Alternatives

Path A, standing relayer:
Fast settlement, works with the current MockMessenger deployment, and satisfies the operator acceptance loop: work completed, claim emitted, tJINN minted, dashboard balance updated. It requires a small hosted service and custody of the MockMessenger owner key.

Path B, canonical OP-Stack messenger:
Permissionless and avoids key custody, but Base Sepolia to Sepolia finality is multi-day. That is acceptable for a trust-minimized bridge path, but it does not satisfy the current public-testnet acceptance requirement that operators see earned tJINN shortly after work completes.

Rejected paths:
Do not ship the MockMessenger owner key in the client. Do not deploy a permissionless mock messenger. Both turn the testnet distributor into an unlimited free-mint surface.

## Consequences

The relayer must be operated as production infrastructure for the public testnet. It must redact secrets from health/status endpoints, fail startup unless its signer owns `MockMessenger`, and stay idempotent across replays, fixture reuse, and no-delta claims.

This decision is testnet-specific. A later canonical or succinct messenger can replace the relayer when multi-day settlement is acceptable or when a faster permissionless proof path is available.
