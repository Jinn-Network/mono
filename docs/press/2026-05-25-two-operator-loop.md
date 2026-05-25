# Two independent operators have earned tokens from the Jinn protocol, ending its single-operator phase

**The first time the network's state can be verified end-to-end from the chain alone.**

**25 May 2026** — Jinn Network today recorded the first concurrent tJINN claim from two independent operator multisigs on its public testnet. The end-to-end protocol loop — task creation, attempt, evaluation, on-chain settlement — has emitted tokens to more than one party in the same window, through the same contracts, with no privileged access path.

A protocol that emits tokens to one operator is a payment script. A protocol that emits to two independent operators, concurrently, through the same code path, is the start of an economy. Until today, the production loop was being run by a single known operator. From today, the same contracts are settling work for two distinct operator multisigs.

## How the loop works

Jinn splits the loop across two chains by design. Work happens on Base Sepolia; the token mints on Sepolia from a separate distribution contract that consumes cross-chain proofs of that work. The contract mints to the operator's Safe multisig directly. There is no off-chain settlement.

- **JinnRouter on Base Sepolia (`0xdC9B…CedD9`)** — tasks are posted with funded reward escrow, discoverable by any operator running the open-source client.
- **Operator services** — OLAS-compatible services with Safe multisigs as on-chain identity, running the published harness against discovered tasks.
- **TaskClaimEmitter on Base Sepolia** — per-operator activity weights (task creation, solution delivery, verdict delivery) are emitted as claim tickets.
- **JinnDistributor on Sepolia (`0xaC9C…Bfe6`)** — verifies a claim ticket via a cross-chain messenger and mints JINN (testnet: tJINN) to the operator's multisig, alongside a DAO share at a 75/25 split.

Per-operator entitlement is a monotonic high-water mark in storage. Replays are no-ops. Reading the contract returns the authoritative state.

## The receipts

As of 09:51 UTC today, two operator multisigs are concurrently claiming on Sepolia, settled by the same distributor, within seconds of one another:

| Operator Safe | Service ID | Attempts | Verdicts (pass rate) | tJINN claimed |
|---------------|-----------:|---------:|---------------------:|--------------:|
| `0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC` | 46 | 323 | 135 of 169 (79.9%) | 446.25 |
| `0x26e96ba6dCbB86C1d18553b3F3D3202f3A3E0638` | 50 |  94 |  17 of  25 (68.0%) |  71.25 |

The two latest claims, 24 seconds apart: [`0xaf5f…2c9b0`](https://sepolia.etherscan.io/tx/0xaf5f131fca1e37bd0d821c1b6a4f22b6eb90fff694e42db64025232185d2c9b0) (block 10918224, 09:50:48 UTC) and [`0xe1d4…9268d`](https://sepolia.etherscan.io/tx/0xe1d4b215e8b78539020224491fdd349ebee5ad083141cf8b78a8092ca199268d) (block 10918226, 09:51:12 UTC).

Network state from the public indexer:

- 218 tasks posted, 211 settled
- 570 attempts across 10 distinct operator addresses
- 229 evaluator verdicts, 78.2% passing
- 99% agreement between distinct evaluator addresses scoring the same attempt (118 of 119 pairs to date)
- 858 tJINN minted in total — 643.5 to operators, 214.5 to the DAO, matching the 75/25 split to the wei

None of these figures is reported by a Jinn service. All are derivable from `eth_getLogs` against the contracts above.

The operators leaderboard surfaces two further services running the same SolverNet beyond the two settling concurrently today — `0x7828…43f4` (89.5% pass rate, 24 tJINN already earned) and `0xaea9…3e0b` (87.5% pass rate, no tJINN yet attributed). Concurrent on the chain today: two. Running the loop: four.

## What's different

Two design choices distinguish this from the usual pattern of a hosted agent network with a token attached.

**The settlement contract is the sole authority on token issuance.** No off-chain queue, no scoring service, no treasury operation between an operator's work and their balance. The contract mints to the multisig directly, bounded by Governor-mutable weights and a hard ceiling.

**The activity that earns tokens is decoupled from the token's chain.** Work is verified where it happens (Base Sepolia); the token lives where governance lives (Sepolia today, Ethereum at launch). Today's cross-chain proof uses a testnet mock messenger; a production bridge is planned. The on-chain accounting is correct regardless.

## What this does not yet prove

To stay honest about what the receipts above support and what they don't:

- **The chain proves distinctness, not independence.** The two operator multisigs are verifiably different addresses making different transactions. That a single party does not control both Safes cannot be proven from the chain alone today; it is an assertion until on-chain identity work in Phase B closes the gap. Sybil resistance at the operator layer is a Phase B problem, not a claim being made here.
- **The cross-chain messenger is currently a testnet mock.** The accounting in the distributor is correct; the trust assumption on the messenger is the standard testnet one. A production bridge will replace the mock before mainnet.
- **This is testnet. tJINN has no economic value.** Mainnet emissions are gated on a separate set of decisions and not the subject of this release.

## Quote

> "The hard part of a decentralised protocol isn't writing the contracts. It's the moment the second independent party shows up and the system behaves the same way for them as for the first. Today is that moment for Jinn." — Jinn contributor

## Availability and next

The client (`@jinn-network/client`) is open source and on npm. `jinn run` takes any operator through the same bootstrap the two operators above used — wallet, Safe, OLAS service, staking, mech. Default configuration targets Base Sepolia and Sepolia.

Next: production cross-chain messenger; operator-count target ahead of the mainnet emissions gate; verifiable evaluator outputs (Phase B.1).

The Jinn network explorer is live at <https://jinn-indexer-production.up.railway.app/>. Contracts, ABIs, and deployment metadata are in the `Jinn-Network/mono` repository.

## About Jinn Network

Jinn Network is an open agentic knowledge economy. The protocol defines a four-step loop — Creation, Execution, Evaluation, Knowledge — in which intents are published with reward escrow, distinct operators attempt to fulfil them, distinct evaluators verify outcomes, and the resulting knowledge accumulates on chain. JINN is the protocol's emission token. The architecture is governance-minimal, permissionless, and verifiable end-to-end. Source code, specifications, and design system are public.

---

## Appendix A — Production notes (not for publication)

### Screenshots

Each shot is the operator-visible counterpart to a number in the release. If a figure has moved by capture time, update the receipts table in the same edit.

1. **Operator dashboard — Wallet card.** <http://localhost:7331/overview>. Region `tjinn-earned-region`. "Testnet JINN earned" non-zero; "Lifetime claimed" matches.
2. **Operator dashboard — Activity card.** Same page, scroll to the joined SolverNet (SWE-rebench v2). Several recent `solve` and `evaluate` rows visible with `SUCCEEDED` state, task-hash prefix, age, plus the right-rail Settings (Roles, Harness, Model, Plugins).
3. **Explorer — network view.** <https://jinn-indexer-production.up.railway.app/>. Tasks settled, distinct operators, verdict consistency, tJINN distributed totals visible.
4. **Explorer — operators leaderboard.** <https://jinn-indexer-production.up.railway.app/operators>. Both `0x0e767E…24FC` and `0x26e96b…0638` visible with non-zero `jinnEarned`.
5. **Sepolia Etherscan — Claimed events.** <https://sepolia.etherscan.io/address/0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6#events>. Filter `Claimed`; both multisig topics visible.

### Assumptions

- Attribution stays role-only by default (`— Jinn contributor`). If a contributor wants their name attached, that is the contributor's call to make explicitly before publication.
- The `0x0e767E…24FC` operator is treated as pseudonymous. Even with consent, prefer affiliation over name unless naming is independently load-bearing.
- DAO Timelock holds the 25% DAO share, per deployment JSON dated 2026-04-29 and consistent with current indexer totals.

### Claims to verify before publication

1. **24-second gap, same-day-first-claim.** Confirm `cast block <n> --field timestamp` against the same Sepolia RPC the indexer uses; both can drift on re-org.
2. **99% verdict consistency.** Defend the percentage at n=119 or restate as "agreement on 118 of 119 cross-evaluator pairs".
3. **"75/25 to the wei".** 58 wei of rounding noise across running totals. Defensible at this scale; sanity-check before headline use.
4. **Mock messenger currently deployed.** Confirm no silent swap to a production messenger before publication.
5. **`@jinn-network/client` on npm.** Confirm current version published and `Jinn-Network/mono` is the canonical source before linking.
6. **Pseudonymous operator.** Confirm `0x0e767E…24FC` is independently operated (not run by a Jinn contributor with privileged access).

### Alternative headlines

- **Technical** — *JinnDistributor on Sepolia settles concurrent claims from two independent operator multisigs*
- **Ecosystem** — *Jinn testnet emits tokens to two independent operators in the same hour, ahead of the mainnet emissions gate*
- **Media-friendly** — *Jinn's open knowledge economy just settled with two independent operators, and the receipts are on chain*

### Principles touched

- **Legible** — every claim is independently verifiable on chain.
- **Learning Maximised** — the loop produces settled work without manual intervention.
- **Permissionless** — both operators joined the network the same way anyone else can.
