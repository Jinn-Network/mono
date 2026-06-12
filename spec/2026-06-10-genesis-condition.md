# The genesis condition — testnet→mainnet recommendation

- **Version:** 0.1 (discussion draft)
- **Date:** 2026-06-10
- **Author:** Oak (drafted with assistant), for Ritsu review
- **Status:** Proposal for a new canonical doc (`GENESIS.md`). Open for discussion. Lands in canon via the Discussion + CODEOWNERS route.
- **Related:** [`spec/2026-05-14-launch-gating-criteria.md`](2026-05-14-launch-gating-criteria.md) (the question-set this partially answers, on the Tech axis — T4, T6, T7; audits (T2), bug bounty (T3), stability window (T5), dependency-resilience (T9), and all Community/Economics gates are handled separately); [`docs/2026-06-09-simplified-launch-logic.md`](../docs/2026-06-09-simplified-launch-logic.md) (the path); [`docs/2026-06-10-genesis-bootstrap-circularity.md`](../docs/2026-06-10-genesis-bootstrap-circularity.md) (forked); `PRINCIPLES.md`; `SPEC.md` §Tokenomics.

## What this is

The single recommended condition under which Oak and Ritsu propose moving from testnet to sovereign-mainnet genesis. The north star: **a legitimate birth of a network that coordinates independent agentic inference productively.**

It is a **recommendation, not an enforced gate.** Any participant who can coordinate an operator set is free to coordinate around a different condition. We publish this because a Schelling point left to emerge on its own emerges too slowly — not because we own the launch decision. To keep the *assessment* founder-independent even though the *proposal* is not, every condition below is verifiable by anyone, on-chain or by public reproduction.

## The split: three categories

Testnet can prove the **machine works** — the client runs, the loop closes, the chain holds, joining is easy, the work is real. Testnet *cannot* prove the **equilibrium holds** — no harmful concentration, no founder capture, security under economic attack — because the adversary only exists once the token has value. Separate from both is whether the system is **safe to ship** — audited, bountied, tested, resilient to its dependencies. Three categories, not two:

- **Machine works** (this doc) — four simple, testnet-observable rows. One row (3, security) straddles into the equilibrium category: its mechanism half is testnet-provable, its demand half is an equilibrium bet — flagged in the row itself.
- **Safe to ship** (this doc) — security & operational readiness gates. Not testnet-mechanics and not economic design — a distinct readiness track. See "Safe to ship" below.
- **Equilibrium holds** (forked) — the non-capture problem, built into genesis mechanism and monitored after. Not a condition row. See "Economic design" below.

Throughout, magic numbers are replaced by mechanism properties wherever one exists; each surviving number is flagged.

## The four conditions

**Proving period.** All four conditions must *hold continuously* across a minimum proving period D — peaking once does not count — and testnet must run for at least D before promotion. One parameter serves both the stability-window requirement (T5) and the minimum-testnet-duration requirement (part of T8). *(D: TBD — Oak/Ritsu.)*

### 1. Blockchain — the chain runs

- Per-validator voting power is handled (cap or distribution) such that no single party can halt or forge. *(The mechanism sets the minimum colluding-party count; sizing is a genesis-config call — see Economic design.)*
- The chain auto-recovers from a validator dropping, with no consensus halt across the observation window. *(Fault tolerance, demonstrated — replaces an uptime percentage.)*
- Genesis config is fixed and published.

### 2. Inference — independent coordination, mechanically

This reads the *mechanics* of the same loop as condition 4; condition 4 reads its *output*.

- **Coordination.** The protocol loop closes: one address posts a task, a second executes it, the result is verified (oracle and/or a third evaluator address), and reward mints only on pass. The roles are distinct on-chain. *(Distinct addresses are the coordination claim — a single address claiming reward for its own task is a faucet, not coordination.)*
- **Permissionless by construction.** No step in bootstrap→earn is access-gated — no allowlist, no founder signature, no privileged registration. Verifiable by reading the contracts. Founders hold no lever a stranger lacks, so "helped vs independent" stops mattering: anyone can do exactly what a helped operator did.
- **Verifiably easy — earning at a defined floor.** The execution envelope records the hardware and inference class that produced it, so the floor at which earning happened is legible on-chain. A public reference node runs at that floor and earns, so anyone can replicate by acquiring the same commodity setup. *(The envelope is a legible claim; the public reference node is what makes it credible — TEE attestation would be overkill and anti-neutral. Open: the inference floor is undecided — see below.)*

### 3. Security — the economy cycles

This is the one row that straddles the machine-works / equilibrium-holds line, and saying so is more Legible than implying the row closes the question.

- **What testnet proves (mechanism runs).** Earning (beyond the genesis bootstrap round) and emissions-direction are reachable **only through bonding/locking** — the sink sits on the critical path, so emitted JINN structurally cycles rather than emitting into a void. *(The "beyond the bootstrap round" carve-out exists because of the genesis circularity — see the forked brief.)*
- **What testnet cannot prove (equilibrium bet).** On a valueless testnet, bonding demonstrates only that the mechanism runs — never that bonding *demand* survives contact with a token worth attacking. This is the one genuinely relevant unknown at launch (parent doc, closing section), and it is settled only by standing the network up, not by pre-proving it on testnet.

### 4. Productivity — the work is real

- The same loop's output is genuine: an agent's fix to a real Jinn-repo issue passes a **held-out test** that defines "done" — the agent never sees it, so it cannot be gamed. "Merged" is shorthand: the verifiable event is the held-out test passing, not a literal merge to main, which stays a human/governance call outside the loop. Value-to-Jinn is intended, not a flaw — the repo is chosen *because* the work is known-valuable to us at zero trust cost. The only guard is **non-triviality**: tasks must not be make-work selected to inflate the pass rate. The gate is that the work *happens*, **not** that capability *improves* over time — compounding is the deferred moat thesis (parent doc, closing section), tracked but not gated. *(A stranger verifies it via the on-chain task→bond→reward chain plus the public PR, its CI result, and the inspectable diff. Not a benchmark; rebench is the held-out-grading method, not the launch demonstration.)*

## Safe to ship — security & operational readiness

Distinct from the four rows (which prove the machine *works*) and from economic design (which secures the *equilibrium*): these gates prove the system is *safe to ship*. A separate readiness track — owned by engineering alongside the contract port, with standards set by Oak/Ritsu. Framed here; numbers and standards flagged TBD.

- **Audits (T2).** Which contracts are audited, and to what standard. The bar is *higher* than industry-standard because neutrality is load-bearing — a captured or buggy genesis is the "visible from day one" failure. Scope must include the *ported Cosmos EVM* contracts as new code; prior Sepolia audits do not transfer for free. *(Standard / firm: TBD.)*
- **Bug bounty (T3).** Live *before* genesis, not after. *(Scope + size: TBD.)*
- **On-chain testing bar (T8).** Fork / fuzz / invariant / shadow-run coverage on the ported contracts, plus the minimum proving period above. *(Coverage bar: TBD.)*
- **Dependency resilience (T9).** External dependencies degrade, not brick. Highest priority: the frontier-inference dependency that floor A introduces (provider ToS / rate-limit / outage), then RPC and the indexer. Each dependency gets a compatibility statement and a fallback. *(Per-dependency fallback: TBD.)*

## Economic design (forked — not a condition row)

The non-capture problem — concentration, founder capture, and economic security as one thing — cannot be proven on testnet and is handled as genesis mechanism in a separate session. Summary of the direction (full work forked):

- **Reward verified work, not capital.** Work is oracle-gated and therefore sybil-proof; concentration of *earned work* is legitimate (Prestige).
- **No premine, renounce admin keys.** Collapses founder capture into the general problem — founders get no privileged allocation or control surface.
- **Cost the residual capital surfaces (validator stake, veJINN direction) in locked time**, plus self-dealing exclusion on gauges.
- **Monitor in public** — the equilibrium can't be pre-proven, so ship the mechanism and an on-chain concentration monitor.
- **Governance surface.** Cosmos native `x/gov` replaces the Phase 1a EVM DAO governance contracts (Governor/Timelock) — drop them (Governance-Minimal; a simplification dividend). veJINN gauge direction is kept (it is direction, not governance). Open: whether governance is gated on veJINN locks rather than raw validator stake, so consensus power and governance power are not the same thing. Either way, no separate ported EVM Governor stack.
- **Genesis bootstrap circularity** is part of this work — see [`docs/2026-06-10-genesis-bootstrap-circularity.md`](../docs/2026-06-10-genesis-bootstrap-circularity.md).

The open frontier: veJINN gauge capture via sybil identities is mitigated (work-gating, lock cost, monitoring) but not eliminated without an identity system. Named, not solved.

## Open items

- **Condition 2, "verifiably easy" — inference floor decided: (A).** (A) Subscription floor: commodity hardware + spare frontier subscription/key you already have — easy setup, not free inference; matches the spare-subscription operator model (Misha) and real-work productivity. (B) Free-local floor (any computer + ollama + a small model) was rejected for genesis: it only solves trivial tasks and so guts productivity, and it does not even escape the neutrality cost — a local model good enough for real work needs a GPU, relocating the floor from subscription-access to hardware-access rather than removing it. Two caveats stand on (A): it favours those with frontier-inference access (an economic floor, not a permission gate — Permissionless still holds by construction), and it imports a dependency on a few frontier-model providers' ToS / rate limits / geo-policy. Mitigation: keep the envelope inference-source-agnostic so the floor falls as local/free inference improves; free-local is a roadmap tier, not a genesis gate.
- **Condition 1, voting-power cap** — reversible by on-chain governance post-genesis (a param, not an admin-key or genesis-frozen value), so it is not a now-or-never call. The real question is governance-capture resistance on the tuning — handled in the economic-design fork.
- **Safe-to-ship parameters** — the minimum proving period D, the audit standard, and the bug-bounty scope/size are Oak/Ritsu decisions; the testing bar and per-dependency fallbacks execute with the contract port.
- **Contract scope at genesis (T1)** — which contracts ship and are in scope is downstream of the economic-design decisions in progress; parked there, not resolved here.
- All economic-design items above, in the forked session.
