- **Date:** 2026-05-15
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1

> Provenance: [`PRINCIPLES.md`](../PRINCIPLES.md) landed via GitHub Discussion [#222](https://github.com/Jinn-Network/mono/discussions/222) on 2026-05-14 as the seventh, privileged canonical doc. This spec retrofits [`GROWTH.md`](../GROWTH.md) against that doc.

## Motivation

`PRINCIPLES.md` was introduced as the upstream canonical doc — read at the start of every session, expected to govern decision-making in every other doc. `GROWTH.md` predates it. A pass over GROWTH against the seven principles surfaces a consistent pattern: GROWTH is well-aligned at the *negative* level (§6.1's permanent rules read like principles applied to brand surface) and under-delivers at the *positive* level (the active loop in §3, §5, §7).

Seven specific gaps. Each maps to one or two principles, each lands as a small additive edit (or in one case a §7 replace). No §-jumping; conventions matched.

1. **§7 headline metric is not legible.** "Independent, identifiable, technically credible" is Oak-judged, not mechanism-derived. Per *Legible*, the count must be auditable; per *Neutral*, the criteria must be cheap-to-signal and expensive-to-fake.

2. **§5 Engage has no slot for out-of-cluster inbound.** An operator who self-identifies from outside §3 today gets parked rather than advanced. Per *Permissionless*, the path from outsider to participant must have no privileged shortcuts — including no penalty for arriving from the "wrong" cluster.

3. **§3 cluster rotation is Oak-discretion, not mechanism-triggered.** Per *Governance Minimal*, rotation must not accumulate as human-taste deferral; sustained negative evidence should *force* the proposal flow rather than merely inform it.

4. **§5 has no constraint preventing Engage from outpacing Teach.** A funnel-shaped recruiting loop with low Teach output and high Engage volume inverts the recruiting shape from prestige-coded to dominance-coded. Per *Prestige*, deference must be freely conferred from demonstrated competence, not the residue of relational pressure.

5. **§5 Teach has no neutral-surface mirror requirement.** Every Teach artefact's canonical home is currently a centralised, algorithmically-curated platform. Per *Neutral*, the network's surfaces should not structurally benefit any single intermediary.

6. **§3 pitch buries the strongest on-chain-verifiable claim Jinn owns.** No VC, no pre-sale, no team keys, no allocation are cheap-to-signal / expensive-to-fake — the canonical *Legible* + *Neutral* claim. Currently treated as "communicated plainly when it comes up" (§6.1) without §3-side guidance that this *is* the lead when it comes up.

7. **§3 Bridge model is not falsifiable.** The current shape allows non-uptake to be re-interpreted as "we haven't said it well yet." Per *Learning Maximised*, the bridge must be allowed to *fail* and be replaced; insulating it from negative evidence is encoded cleverness, not search.

The fixes are coherent — they reach into §3, §5, §7 only, leave §1, §2, §4, §6, §8, §9 untouched at the canonical level (§9 picks up one operational implication, called out below). The spec lands and the GROWTH.md PR follows in the same change-set.

## What this proposal changes

### §3 — rotation trigger (Change 3)

A new paragraph after the *"During PMF search…"* disposition preamble, before the `### Current target cluster:` subheading:

> **Rotation trigger.** A spec proposal to rewrite §3 is *required* — not merely available — when two consecutive sprint postmortems show zero Tier-A WARM advances *and* at least one substantive inbound from a non-targeted cluster shows up in the same window. The trigger does not pick the next cluster; it forces the proposal flow. Per [`PRINCIPLES.md`](PRINCIPLES.md) *Governance Minimal*, cluster rotation must not accumulate as Oak-discretion — the loop's own evidence triggers the proposal.

The trigger is conjunctive (zero WARM advances *and* out-of-cluster inbound) so that a low-evidence sprint doesn't force rotation by itself. The two-sprint horizon is calibrated to Sprint #3-era cadence (1–2 week windows); if sprint span changes materially, this number gets a follow-up.

### §3 — verifiable claims are not background (Change 6)

A new paragraph immediately after the two pitch blockquotes, before the *"The umbrella generalises…"* paragraph:

> **Verifiable claims are not background.** No VC, no pre-sale, no team keys, no allocation — these are on-chain-checkable facts and the strongest cheap-to-signal / expensive-to-fake claim Jinn owns. When they come up — in replies, DMs, calls — they are led with and *shown* (link to chain or to the relevant address), not hedged as "and by the way." The pitches above frame the *work*; the no-pre-mine facts frame the *neutrality of the rails*. Per [`PRINCIPLES.md`](PRINCIPLES.md) *Legible* + *Neutral*, the strongest legibility claim we own should be surfaced, not buried — §6.1's *communicated plainly because it is a real differentiator* applies here, not only as a refusal of slogans.

The pitch blockquotes themselves are unchanged. This paragraph is the operational rule that governs when the §6.1 differentiator surfaces inside §3-shaped conversations.

### §3 — bridge falsifiability (Change 7)

A new paragraph at the end of the `### Bridge model` subsection, after the existing *Frame this cluster currently holds* / *Frame Jinn offers* / *The bridge* paragraphs:

> **Falsifiability.** What would have to be true for this bridge to be *wrong*, not merely *underdelivered*? If sustained Teach output naming the gap produces no cluster-side resonance — no replies adopting the frame, no quote-tweets extending it, no inbound that references it — the falsification signal is the *absence*, not a counter-argument. Two consecutive sprints of zero bridge-uptake trigger a §3 Bridge model rewrite proposal, not a §5 wording tweak. Per [`PRINCIPLES.md`](PRINCIPLES.md) *Learning Maximised*, the bridge must be allowed to fail and be replaced; insulating it by treating non-uptake as "we haven't said it well yet" is encoded cleverness, not search.

Same two-sprint horizon as Change 3 for the same reason.

### §5 Teach — neutral-surface mirror (Change 5)

A new paragraph appended to the Teach subsection, after the existing `…scores drafts against §8 channel canon before posting.`:

> Every Teach artefact has a canonical home outside X. Long-form lands in the repo (or a self-hosted mirror); shorter form is cross-posted to at least one cluster-relevant neutral surface (Farcaster, the repo's Discussions, or equivalent). X is a distribution megaphone, not the canonical home of the work. Per [`PRINCIPLES.md`](PRINCIPLES.md) *Neutral*, the network's surfaces should not structurally benefit any single intermediary — including the one we currently rely on most for distribution.

§8 (Channel canon) is untouched; X stays primary for distribution. The change is where the *canonical* artefact lives, not where it gets megaphoned.

### §5 Engage — out-of-cluster inbound rung (Change 2)

A new paragraph at the end of the Engage subsection, after the closing-structure paragraph (`…Read the specs, run the client, open a PR or an issue.`):

> **Out-of-cluster inbound is the cheapest path.** Operators who arrive from outside the §3 cluster — via Teach distribution that reached beyond the intended audience, or through unsolicited inbound — advance to a direct call by default, regardless of cluster fit. The warm-contacts ladder is the *push* surface into the §3 cluster; out-of-cluster inbound is *pull from anywhere*. Per [`PRINCIPLES.md`](PRINCIPLES.md) *Permissionless*, the path from outsider to participant has no privileged shortcuts — including no penalty for arriving from the "wrong" cluster.

### §5 Engage — prestige ratio constraint (Change 4)

A new paragraph immediately after Change 2's paragraph:

> **Engage cannot outpace Teach.** Within a sprint, the count of direct-offer engagements (DMs sent, calls scheduled, intros made) must not exceed the count of public Teach artefacts shipped. The constraint enforces the prestige shape mechanically: recruiting volume that outruns visible work inverts the funnel from *operators self-identify against visible competence* into *operators agreed after sustained outreach*. Per [`PRINCIPLES.md`](PRINCIPLES.md) *Prestige*, deference must be freely conferred from demonstrated competence, not the residue of relational pressure.

§9 implication, called out: sprint inputs in §9 already count "teach posts" but do not count Engage actions. This change implies Engage counts become a tracked input alongside Teach counts. That's an operational change to `growth-log` §6 sprint declarations and to `growth-day`'s daily check; the canonical §9 text doesn't need to change because its examples (*6 teach posts*, *reply cascades after each*, *1 bridge post*) are already non-exhaustive.

### §7 — headline metric becomes on-chain derivable (Change 1)

Replace the existing `**Headline: external testnet operators.**` paragraph:

> **Headline: external testnet operators.** Independent, identifiable, technically credible people running the client. Target ~10 before mainnet. This is the §2 bottleneck made measurable.

With:

> **Headline: external testnet operators, on-chain derivable.** Operator legitimacy is a composite of verifiable on-chain criteria — staked service active across a defined epoch window, on-chain attestation of distinct identity (ENS / GitHub-linked attestation / equivalent), and a unique funding-source heuristic. The exact criteria and the derived view are owned by a follow-up methodology spec; until that ships, the manual count is published *with its methodology made explicit* so a third party can audit it. Target ~10 before mainnet. This is the §2 bottleneck made measurable; per [`PRINCIPLES.md`](PRINCIPLES.md) *Legible*, the count must be auditable rather than asserted, and per *Neutral*, the criteria must be cheap to verify and expensive to fake.

The follow-up methodology spec is a forward pointer, not written here. Until it lands, the obligation on §7 is that the *manual* count carries its methodology — i.e. the §7 supporting metric isn't a Notion cell, it's a documented derivation a third party can reproduce.

## What this proposal does *not* change

- §1 The bet — unchanged
- §2 The bottleneck — unchanged
- §3 cluster handle, pitch blockquotes, bridge model frames, GTM phase sequence — unchanged (only additive paragraphs land in §3)
- §4 GTM sequence — unchanged
- §6 What we will not chase — unchanged (§6.1's *communicated plainly* rule is referenced, not edited)
- §8 Channel canon — unchanged (Teach mirror is *where canonical lives*, not which channel distributes)
- §9 Sprint discipline shape — unchanged at canonical level; operational sprint-input list in `growth-log` §6 gains Engage counts (non-canonical)
- §10 — unchanged

The canonical-doc governance from [`spec/2026-04-28-canonical-docs.md`](2026-04-28-canonical-docs.md) is unchanged; this spec follows it.

## Risks and limitations

- **Two-sprint horizon is calibrated, not derived.** Both Change 3 (rotation trigger) and Change 7 (bridge falsifiability) use "two consecutive sprints" as the threshold. That's a guess at the right cadence for Sprint #3-era 1–2 week windows. If sprint span changes materially (e.g. shifts to 4-week windows post-mainnet), the threshold needs revisiting. Mitigation: surface this as a `growth-refine` candidate at the first sprint postmortem after either trigger fires.

- **Change 1's methodology spec is unscoped.** §7's new headline points to "a follow-up methodology spec" without committing to authorship or shape. The risk is that the placeholder ages without resolution — the §7 paragraph reads as legible but the actual derivation stays manual. Mitigation: the new §7 text *requires* methodology to be explicit even in the manual interim, so the audit path exists from day one; the follow-up spec hardens it rather than enables it.

- **Change 4 (Engage ≤ Teach) tightens the Engage rate during low-Teach weeks.** A week where Oak's Teach output is unusually low (illness, travel, a launch-week sprint) implicitly caps Engage. The intended shape is exactly that — visible work paces recruiting — but the operational cost is real. Mitigation: the constraint is per *sprint*, not per *day*, so within-sprint smoothing is allowed. If a sprint structurally cannot produce enough Teach (e.g. a closed-door build sprint), the sprint declaration in `growth-log` §6 can name an alternate prestige-surface count (e.g. shipped repo commits, public PRs landed) to satisfy the constraint. The spec does not enumerate alternates; `growth-refine` proposes them as the loop encounters cases.

- **Change 5 (neutral-surface mirror) adds a per-artefact step.** Every Teach artefact gets a second posting location. Operational overhead is the cost of the *Neutral* principle being load-bearing. Mitigation: Farcaster cross-posting and repo-Discussions posting both have low-friction tooling; the marginal time per artefact is small. Tracked in `growth-log` §5 as part of the daily plan.

- **Change 2 (out-of-cluster inbound) loosens the cluster filter.** A loud out-of-cluster inbound could consume Engage capacity that would otherwise go to §3 push. Mitigation: the rule advances to a *call*, not to *operator*; the call qualifies whether the inbound becomes a recruit. Cluster discipline is preserved at the conversion stage, not the contact stage.

## Open questions

- **Is *"two consecutive sprints"* the right horizon, or should it be *"two consecutive sprints OR 30 calendar days, whichever is longer"*?** Proposed: two sprints as drafted. Calendar-day alternates create ambiguity during sprint pauses. Revisit if the first time either trigger nearly fires, the operational instinct says it's too early or too late.

- **Should Change 5's neutral-surface mirror be one-of (Farcaster *or* repo-Discussions *or* mirror) or one-of-each?** Proposed: one-of. The intent is to ensure no single intermediary owns the canonical artefact; one neutral mirror is sufficient for that. Each-of would be process-heavy without principled return.

- **Should Change 4 count Engage at the rung-change level (advances) or the action level (DMs sent)?** Proposed: action level, as drafted. Rung-changes lag actions and would let high-volume low-conversion outreach skirt the constraint. Open if operational experience shows action-counting penalises legitimate relationship work.

- **Should the §3 retirement-archive rule (the *"When the target changes, this section is rewritten via a spec proposal and the prior content is moved to `growth/.local/growth-log.md` §1"* rule) apply to the additive paragraphs landed in this spec, if they are later removed?** Proposed: yes. The retirement rule is about preserving rationale, not specifically about the cluster handle. If Change 3, 6, or 7's paragraphs are ever removed, archival applies.

## Sequencing

1. **This spec lands.** Approval gate per [`spec/2026-04-28-canonical-docs.md`](2026-04-28-canonical-docs.md).
2. **GROWTH.md PR linked to this spec** ships in the same change-set. Updates §3 (three additive paragraphs), §5 Teach (one additive paragraph), §5 Engage (two additive paragraphs), §7 (headline replace). No other sections touched.
3. **`growth-log` §6 Sprint #3 declaration gains an Engage-action count input** alongside the existing Teach-artefact count. Non-canonical operational change, same PR.
4. **Forward pointer — operator-legitimacy methodology spec.** Not in this PR; followed up when the §7 manual interim makes the criteria concrete enough to commit.
