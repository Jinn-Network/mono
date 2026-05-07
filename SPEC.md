# SPEC

**What this doc is / is not.** This is the canonical specification of the Jinn protocol — the loop, roles, on-chain primitives, and current phase boundaries. It is not a changelog of design exploration, an implementation plan, or a place for ratified material to be silently restated; ratified material is consolidated here. Changes go through CODEOWNERS review with a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions); see [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).

<!-- Other sections to be populated as they ratify; see GitHub Discussions for upstream proposals. -->

## Tokenomics

> Provenance: GitHub Discussion [#69](https://github.com/Jinn-Network/mono/discussions/69), refined in [comment 16806259](https://github.com/Jinn-Network/mono/discussions/69#discussioncomment-16806259).

### Frame

The knowledge substrate Jinn produces is a public good — readable, mirrorable, inspectable. JINN does not capture value by enclosing access to it. JINN captures value by attaching to the scarce coordination surfaces around it: the live, bonded economy that keeps extending the graph.

### JINN's jobs

JINN does five things, and only these.

1. **Direction.** veJINN locks vote on a gauge that directs JINN emissions across staking contracts.
2. **Publication.** Writing canonical Jinn attestations requires a veJINN-backed staking-contract slot. Enforced on-chain.
3. **Execution claims.** Operators post a JINN bond when claiming rewarded work. Valid work returns the bond; clear abuse slashes it. Wrong-but-serious work reduces reward and reputation without losing stake.
4. **Evaluation claims.** Evaluators post JINN bonds against their evaluations. Slashable for clear abuse; reputation-degraded for poor calls.
5. **Priority service.** Apps consume the substrate freely. Apps locking JINN against the indexer side of the gauge are entitled to a proportional share of indexer throughput.

A Jinn attestation is therefore not "someone wrote this to the canonical registry." It is "someone made this claim under a known evaluation regime while putting JINN at risk."

### Roles

**Launcher.** Specifies a *solvernet*: an objective, an evaluation function, and a training mechanism. Locks JINN against the solvernet's gauge to direct emissions and bears the convergence bet.

**Operator.** Runs a node that executes whatever solvernet it is staked on, stores and serves the executions it produces, posts execution bonds, and writes attestations. Operators are infrastructure — interchangeable, paid by emissions.

**Evaluator.** Scores executions under the launcher-defined eval, under bond.

**App.** Consumes the substrate. Locks JINN for service-tier reads when needed. Service tier is enforced by indexer self-interest, not by chain-level access control.

### Technically enforced vs. economically held

**Technically enforced.** Attestation issuance is gated by veJINN-backed staking-contract slots. Bonds are held, returned, or slashed by contract.

**Economically held.** Storage, query gating, and priority service tier are enforced by operator self-interest. Operators honor the priority equilibrium because emissions are funded by veJINN locks, and locks only exist if the system is honored.

Fork resistance is coordination, not code. A fork inherits zero substrate, zero attestation lineage, zero locked apps. The protocol provides the Schelling point; the equilibrium provides the staying power.

### Slot rent

Every staking contract pays a recurring rent denominated in an exogenous decentralised stable, scaling with unredistributed or unpublished emissions. Slots that publish attested executions pay the floor; slots that hoard pay more. Rent prevents dead occupancy; it is not a primary funding source.

### Out of scope

- **No technical access gate on the substrate.** Storage is operator-served; access is economically gated, not technically locked. The hard anchor is attestation issuance, not content encryption.
- **No Jinn-issued stable.** Rent denominates in an exogenous stable.
- **No transaction-layer rent.** No marketplace cuts, settlement fees, or x402 take. Transactions stay forkable.
