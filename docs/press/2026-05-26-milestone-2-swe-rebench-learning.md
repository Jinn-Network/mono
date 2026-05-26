# Solvers improved on Jinn's SWE-rebench v2 net while the language model held still

**With harness and model pinned, the lift is what the network is learning.**

**[DD Month YYYY at gate-crossing]** — On Jinn's SWE-rebench v2 SolverNet, the trailing-30 envelope-only verdict-success rate is at least 10 percentage points above its level 99 verdicts earlier, with the language model (`gpt-5.4-mini`) and execution harness (`codex`) held fixed across both windows. The bar was published before achievement; the measurement runs against the public indexer.

Most agent-system demos improve because the underlying language model improved. This one cannot. With both pinned, the remaining variable is what the network itself accumulates between rounds. The lift is attributable to the substrate, not the LM.

## How the gate works

The condition is one line: the most recent 30 envelope-enriched verdicts at `harness=codex, model=gpt-5.4-mini` pass at a rate at least 10 percentage points above the rate of the 30 envelope-enriched verdicts ending 99 verdicts earlier, on a SolverNet with at least 130 such verdicts in total.

Each clause is load-bearing.

- **Envelope-enriched only.** The on-chain `verdictCode` defaulted to `Pass(1)` for some failed evaluations in the early-period daemon — a known contamination corrected by the envelope-truth indexer fix (commit `b56b9a34`, 2026-05-14). The gate reads only verdicts where the evaluator's full envelope is pinned to IPFS and `actualPassed` is the truth source. Unenriched verdicts are dropped.
- **One harness, one model.** The variable controlled for is "we switched to a smarter LM". With both pinned, any sustained lift is the network's, not the model's.
- **Trailing-30 vs t-99.** Two non-overlapping windows, separated by at least 39 verdicts. Wide enough to flush short-run noise.
- **≥130 verdicts on the net.** The two windows together require 60 enriched verdicts. The 130-floor adds enough sample to make the comparison meaningful at all.

## The receipts

The slice driving the claim:

```
GET /explorer/slice
  ?manifestDigest=bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi
  &filter[harness]=codex
  &filter[model]=gpt-5.4-mini
  &group=none
```

on the public indexer at <https://jinn-indexer-production.up.railway.app/>.

- SolverNet: SWE-rebench v2 (`bafkrei…shpi`).
- Manifest CID, harness, and model are pinned in the URL — anyone can re-derive the trailing-30 number with one `curl` and read what Jinn reads.
- Trailing-30 envelope-only pass rate: **[N]%**, over **[total]** enriched verdicts.
- Trailing-30 rate ending 99 verdicts earlier: **[N₀]%**.
- Delta: **[Δ] percentage points** above the +10pp gate.
- Verdict-level IPFS envelopes are pinned via the OLAS registry; representative CIDs in the appendix.

No Jinn service reports these numbers. The indexer reads them from chain.

## What's different

The bitter lesson: systems that search and learn outperform systems that encode taste. Jinn's bet is that this generalises beyond gradient descent — to how a network of distinct solvers gets better at producing solutions. The headline above is the first time the bet is observable on chain with the LM held constant. The network's contribution to performance is no longer narrated by anyone running it; the indexer shows it.

The pinned-LM frame rules out the easy win: swap a stronger model in, claim the higher number. For one SolverNet, one harness, one model, one period, the network did the work.

## What this does not yet prove

- **Testnet.** All figures are Base Sepolia / Sepolia. Mainnet emissions are gated separately.
- **One slice.** The claim holds for `codex + gpt-5.4-mini` on SWE-rebench v2. Other harnesses and models will be measured on their own terms.
- **Donation-consumption attribution is not yet wired into the indexer.** Cross-operator artifact donation ships, but the indexer does not yet mark "this attempt consumed donated artifact X". The lift is consistent with the donation hypothesis; the chain does not yet single out donations as the cause.
- **No comparator network.** The gate is internal — this network against its earlier self. Not a claim that Jinn beats any other agent system on this benchmark.

## Quote

> "Pinning the model was the move. When you can't credit a smarter LM for the lift, the only thing left to credit is the substrate. That's what we wanted to be able to measure." — Jinn contributor

## Availability and next

Anyone can re-derive the milestone number from the indexer URL above. The check script lives at `client/scripts/check-milestone-2.ts` and produces a markdown snapshot for the tracking issue.

Next: extend the gate shape to a second SolverNet; wire donation-consumption attribution into the indexer; widen the harness and model matrix.

The Jinn network explorer is live at <https://jinn-indexer-production.up.railway.app/>. Source, specifications, and the gate definition are in the `Jinn-Network/mono` repository.

## About Jinn Network

Jinn Network is an open agentic knowledge economy. The protocol defines a four-step loop — Creation, Execution, Evaluation, Knowledge — in which intents are published with reward escrow, distinct operators attempt to fulfil them, distinct evaluators verify outcomes, and the resulting knowledge accumulates on chain. JINN is the protocol's emission token. The architecture is governance-minimal, permissionless, and verifiable end-to-end. Source code, specifications, and design system are public.

---

## Appendix A — Production notes (not for publication)

**Status: working-backwards future PR.** This document is the Amazon-style press release for [milestone #2](https://github.com/Jinn-Network/mono/milestone/2), written before achievement and dated for the day the gate is crossed. It powers three downstream comms moments:

1. **Announce the milestone.** Adapt the headline and first three paragraphs into a forward-looking frame — *"Jinn has set a measurable bar for solver learning. The bar: trailing-30 envelope-only pass rate +10pp above the t-99 baseline, harness and model pinned, on SWE-rebench v2."* The receipts block becomes *"what we will publish at completion"*. Link to milestone #2 + tracking issue #647.
2. **Significant-update comms.** Once [#611](https://github.com/Jinn-Network/mono/issues/611) lands and `/explorer/slice` is live, paste the first snapshot from `check-milestone-2.ts` ([#648](https://github.com/Jinn-Network/mono/issues/648)) and report distance-to-gate. Headline shape: *"trailing-30 at X%, baseline Y%, Δ Zpp, needs +10pp"*.
3. **Milestone-complete comms.** Publish this document with figures filled in.

Until completion, the `[N]%`, `[N₀]%`, `[Δ]pp`, and `[total]` placeholders in the body remain unfilled. Do not publish with placeholders in place — Legibility does not survive missing numbers.

### Screenshots (spec'd; capture at completion)

1. **Explorer — slice view at the gate-crossing block.** `https://jinn-indexer-production.up.railway.app/explore/bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi?filter[harness]=codex&filter[model]=gpt-5.4-mini` (route per spec §5.3). Trailing-30 rate visible; sparkline showing the rise; verdict-count ≥ 130 at the pinned slice.
2. **Explorer — SolverNet view (default engine consumer).** Same SolverNet, default params, envelope-only filter active. Confirm the headline rate matches the slice URL.
3. **`check-milestone-2.ts` snapshot.** Inline screenshot of the script's markdown output pasted into tracking issue #647 the day the gate is crossed.
4. **Sepolia Etherscan — JinnDistributor (`0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6`) — Settled events.** Filter to the SolverNet's settlement window; show settlement continued throughout the measurement window.
5. **Two representative IPFS envelopes** — one from the trailing-30, one from the baseline. Resolve at `https://gateway.autonolas.tech/ipfs/<cid>`; both with `enrichmentStatus: ok`.

### Assumptions

- Attribution stays role-only by default. Named contributor only on explicit sign-off.
- "The LM is pinned" assumes `codex` (harness) and `gpt-5.4-mini` (model) are correctly enforced for every counted verdict. If the filter drops a row whose harness or model fields are missing, the slice is implicitly safer; if it includes such a row, the claim weakens. Verify the SQL semantics at completion.
- The 99-verdict offset assumes verdicts are ordered by block (not by indexer arrival). Confirm in the slice engine.
- Tracking-issue snapshots are the canonical historical record; this file is the canonical announcement.

### Claims to verify before publication

1. The slice endpoint exists and returns the shape specified in `spec/2026-05-25-demonstrate-solver-learning.md` §6 with `enrichmentCoverage` ≥ a defensible threshold across both windows.
2. Trailing-30 vs t-99 is computed on **non-overlapping** windows. Confirm in the check-script output.
3. Both windows enforce `harness=codex` AND `model=gpt-5.4-mini`. No silent fallback.
4. ≥130 envelope-enriched verdicts at the pinned harness+model on the net. Don't round.
5. The headline rate matches the slice URL to the percentage point at publication time.
6. The envelope CIDs referenced are still resolvable on the Autonolas IPFS gateway at publication time.
7. No `paid` / `pays` / `team` / `co-founder` / dateline city has slipped in.
8. `What this does not yet prove` enumerates every load-bearing gap, including any new ones introduced since drafting.

### Alternative headlines

- **Technical** — *On Jinn's SWE-rebench v2 SolverNet, the trailing-30 envelope-only pass rate is +10pp above the t-99 baseline at pinned harness + model*
- **Ecosystem** — *Jinn produces its first measured solver lift on testnet with the language model held constant*
- **Media-friendly** — *Jinn's agent network got better at writing code with the AI model held still*

### Principles touched

- **Legible** — every claim recoverable from one indexer URL plus the spec.
- **Learning Maximised** — the gate is the bitter lesson made measurable on a public network.
- **Neutral** — the bar is published before achievement; no goalpost movement.
