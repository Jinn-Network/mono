# Ten distinct operators have each earned 25 tJINN, clearing Jinn's pre-mainnet operator gate

**The operator count the network needs before mainnet is now something anyone can check on the public ledger, not a number we ask you to trust.**

## The short version

Jinn is a network where operators run AI agents, get their work checked, and earn tokens for it. To be worth launching for real, it needs operators who stick around — not one, and not a crowd of wallets that show up once and vanish.

So we set a bar: ten different operators, each having earned at least 25 testnet tokens over the life of the test network. The floor is the point — a wallet can earn a token by luck, but 25 takes coming back and doing real work. Counting wallets above the line counts committed operators, not drive-by ones.

Today ten have cleared it. You needn't take our word: every token earned is written to a public ledger, and a short script in our open repository counts the qualifying wallets. Run it yourself and you should get ten.

---

**DD Month YYYY** — Jinn Network today reached a pre-set target on its public test network: ten distinct operators have each earned at least 25 testnet JINN (tJINN) in total. This is the operator-count milestone the network committed to before considering a real-money launch, measured straight from the chain rather than asserted.

This fixes a common dodge. Plenty of networks claim "we have N operators"; almost none let you count them. The figure is usually a private dashboard number — easy to round up, impossible to audit. Jinn's posture is the opposite: if we cannot show it on a public ledger, we do not claim it. The milestone turns "we have operators" into "here are ten wallets, each above the floor, and here is how to count them."

## How the count works

- **One contract issues the tokens, and every issue is public.** The token contract on the Sepolia test chain (`0xaC9C…Bfe6`) mints directly to each operator's shared wallet — a "Safe", controlled by keys rather than one private key. No off-ledger step; every mint is a permanent public record.
- **"Operator" means the wallet that received the tokens.** Restart a service under a new ID and the wallet is unchanged — same operator. This stops the count being gamed by churn.
- **The floor is a lifetime total, not a recent burst.** It counts wallets whose all-time earned total is at least 25 tJINN — enough to require sustained work, not one lucky payout. That is what makes a cleared wallet evidence of a real operator.
- **The count comes from the ledger, not from us.** No Jinn service reports it; `client/scripts/check-milestone-3.ts` sums it from the public mint records and prints it against the target of ten.

## The receipts

Ten operator wallets, each with a lifetime earned total at or above 25 tJINN. Figures are as at publication.

| Operator wallet | Lifetime tJINN earned | A claim transaction |
|-----------------|----------------------:|---------------------|
| `0x0e76…24fc` | `<filled at publish>` | `<filled at publish>` |
| `0x26e9…0638` | `<filled at publish>` | `<filled at publish>` |
| `0x60d2…581e` | `<filled at publish>` | `<filled at publish>` |
| `0x33c9…8e77` | `<filled at publish>` | `<filled at publish>` |
| `<6 further wallets — filled at publish>` | | |

As at this draft, four of the ten are already over the line and a fifth sits at 24 tJINN, one short. The remaining places fill as operators keep running the loop.

Reproduce the count two ways: run `check-milestone-3.ts`, or read the mint records off the token contract and add up the per-wallet totals. Both return ten.

## What's different

The bottleneck is measured, not asserted. The hard part of launching a network like this is not the code — it is showing that real operators turned up and stayed. Tying the milestone to a public, per-wallet lifetime total makes "ten committed operators" something a stranger can check and a marketer cannot inflate.

The floor is cheap to verify and expensive to fake. Reading the count costs nothing; manufacturing it means genuinely running the loop, repeatedly, through the one contract that issues tokens — the activity the network wanted anyway.

## What this does not yet prove

- **The milestone is not yet reached at the time of drafting.** This is a proactive write-up — the announcement we will publish when the count hits ten. As at the draft date, four operators clear the floor. Do not publish until `check-milestone-3.ts` reports ten of ten.
- **The chain proves distinct wallets, not distinct people.** Ten different wallets are verifiably ten different addresses doing different transactions. That ten different real-world parties control them cannot be proven from the chain alone. The full operator-legitimacy test — an active staked service, a check of distinct identity, and a funding-source heuristic — is owned by a separate methodology specification and is not closed by this count.
- **This is the test network. tJINN has no economic value.** Real-money emissions depend on a separate set of decisions and are not the subject of this release.
- **The cross-chain step still uses a test stand-in.** The token accounting is correct; the bridge that carries proof of work between chains is a testnet mock and will be replaced before mainnet.

## Quote

> "It is easy to say a network has operators. It is hard to let anyone count them and get the same answer you do. Picking a number, publishing the method, and holding ourselves to it in public is the whole point — the milestone is worth less than the fact that you can check it." — Jinn contributor

## Availability and next

The client (`@jinn-network/client`) is open source and on npm. `jinn run` takes any operator through the same setup as those above; default settings target the Base Sepolia and Sepolia test chains. Joining the count is the same path as joining the network — no shortcut.

Next: surfacing this count on the public network explorer alongside the active and sustained-operator figures; the production cross-chain bridge; and the wider operator-legitimacy methodology that this count sits beneath.

The Jinn network explorer is live at <https://jinn-indexer-production.up.railway.app/>. Contracts, the counting script, and deployment details are in the `Jinn-Network/mono` repository.

## About Jinn Network

Jinn Network is an open agentic knowledge economy. The protocol defines a four-step loop — Creation, Execution, Evaluation, Knowledge — in which intents are published with reward escrow, distinct operators attempt to fulfil them, distinct evaluators verify outcomes, and the resulting knowledge accumulates on chain. JINN is the protocol's emission token. The architecture is governance-minimal, permissionless, and verifiable end-to-end. Source code, specifications, and design system are public.

---

## Appendix A — Production notes (not for publication)

**STATUS: HELD — not for publication until the gate reports HIT (current: 4 of 10).** Rename the file to its actual publish date when shipped; the `2026-06-04` date is the draft date, not the publish date.

### Screenshots

Spec only — the explorer cannot show the hit state until the count reaches ten. Capture at publish time (Step 9).

1. **Explorer — operators view.** <https://jinn-indexer-production.up.railway.app/operators>. Once issue #1029 ships the third KPI card, capture it reading 10. Until then, capture the operators table showing ten wallets with lifetime earned ≥ 25 tJINN.
2. **Script output.** `cd client && yarn tsx scripts/check-milestone-3.ts`. Capture the verdict block reading "Operators ≥ 25 tJINN (lifetime): 10 / 10 — MILESTONE HIT."
3. **Sepolia Etherscan — Claimed events.** <https://sepolia.etherscan.io/address/0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6#events>. The fallback receipt path — mint events for the qualifying wallets, no Jinn surface needed.

### Assumptions

- Attribution stays role-only by default (`— Jinn contributor`). Named attribution only on explicit contributor sign-off.
- Operator wallets are pseudonymous. Public addresses are valid receipts; do not attach names.
- "Operator" = recipient Safe multisig, matching the Milestone 1 definition and `check-milestone-3.ts`.

### Claims to verify before publication

1. **Count is exactly ten.** `check-milestone-3.ts` reports 10/10 against the same indexer the explorer uses.
2. **Lifetime totals in the receipts table** match the script output to the wei at capture time.
3. **The 25-tJINN floor** is still the gate on milestone #3 and has not been re-swept.
4. **Each receipts-table claim transaction** resolves on Sepolia Etherscan and credits the stated wallet.
5. **The cross-chain messenger** is still the testnet mock at publish (confirm no silent swap).
6. **`@jinn-network/client`** current version is published and `Jinn-Network/mono` is the canonical source before linking.
7. **Distinct-not-independent caveat** still holds — the methodology spec has not shipped and closed the identity gap.

### Alternative headlines

- **Technical** — *Ten distinct operator multisigs each pass a 25 tJINN lifetime-earned floor on Jinn's testnet*
- **Ecosystem** — *Jinn clears its pre-mainnet operator-count target, and the count is auditable from the chain*
- **Media-friendly** — *Jinn's open knowledge economy now has ten committed operators — and you can count them yourself*

### Principles touched

- **Legible** — the count is summed from public mint records and reproducible by an open script; nothing is asserted.
- **Neutral** — the floor is cheap to verify and expensive to fake; no operator gets a privileged path to the count.
- **Prestige** — places in the count are earned by sustained work, not conferred.
