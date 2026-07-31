# @jinn-network/evidence-trajectory

The sealed Trajectory record kind: a portable structure for what happened inside an agent
execution.

A Trajectory record is a list of OpenTelemetry-shaped spans under a Jinn-owned vocabulary
profile, derived from a digest-bound native trace by a named decoder. The record is a pure
function of its inputs — no wall clock, no randomness — so the same trace decoded by the
same decoder version always produces the same bytes and the same digest.

Identifiers are deterministic order/reference keys derived from declared inputs. Byte identity
is the sealed record digest. Attribution is the Trajectory derivation attestation (DSSE over
an in-toto Statement). Factual faithfulness to the source requires L4 replay — this package
implements L1–L3 only.

## Four-layer verification

| Layer | What it checks | Implemented here |
| --- | --- | --- |
| L1 | Structural envelope and statement shape | `verifyTrajectoryDerivationAttestation` |
| L2 | Injected authority port (signature/key binding) | `verifyTrajectoryDerivationAttestation` |
| L3 | Digest, field, and forward-link binding | `verifyTrajectoryDerivationAttestation` |
| L4 | Replay against native source | Always `not-evaluated` / `replay-required` |

## Public API

- Record: `TrajectoryRecordSchema`, `parseTrajectory`, `sealTrajectory`
- Identity: `deriveTraceId`, `deriveSpanId` (order/reference only)
- Attestation: `buildTrajectoryDerivationStatement`, `sealTrajectoryDerivationAttestation`,
  `verifyTrajectoryDerivationAttestation`
- Conformance: `describeTrajectoryRecordConformance` from `@jinn-network/evidence-trajectory/testing`

See `../../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §7.2 and
`../../../docs/superpowers/plans/2026-07-30-plugin-c1-trajectory-record.md` §2026-07-31.
