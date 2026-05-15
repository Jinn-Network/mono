- **Date:** 2026-05-15
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1

> Provenance: GitHub Discussion [#222](https://github.com/Jinn-Network/mono/discussions/222) §**C2** (which viewpoints must be represented) and §**C5** (diversity maintained over time). Follows [`spec/2026-05-15-growth-principles-alignment.md`](2026-05-15-growth-principles-alignment.md) in the post-PRINCIPLES alignment pass.

## Motivation

Discussion #222 raises group composition as a launch-quality question. Working through the seven candidate attributes against [`PRINCIPLES.md`](../PRINCIPLES.md), the honest read is: composition matters, but as a **diagnostic** signal — not as a launch gate or a per-candidate recruiting filter. The principles-side argument:

- *Governance Minimal* — codifying attribute thresholds as launch-gating numbers adds a governance surface (who interprets edge cases?) rather than reducing one.
- *Permissionless* — screening each candidate against multiple attributes before they join shifts selection logic toward what the audit values, not what the protocol values.
- *Learning Maximised* — picking which attributes matter in advance is encoded cleverness about a critique surface we cannot fully predict; the audit must remain mutable as evidence accumulates.
- *Legible* — most candidate attributes are interpreted, not on-chain. They cannot serve as legible launch claims even if we wanted them to.

The defensible role is **periodic composition sampling during Refine**, treating gaps as questions to push back into upstream design / tooling / recruiting choices — never as recruiting filters or gate failures.

This spec lands the *function* in canon and lets the *detail* (attribute list, draft thresholds) evolve in the working appendix without further canonical PRs.

## What this proposal changes

### §5 Refine — one new paragraph

Append a paragraph to the existing `### Refine — growth-refine` subsection:

> **Composition heuristic.** Periodically, as one input to Refine, the operator-set composition is sampled against a small set of diagnostic attributes (founder-proximity, founder economic alignment, financial/professional independence, jurisdiction, crypto exposure, technical savvy, skillset coverage). The attributes are heuristics, not gates: a gapped attribute surfaces a question about what upstream design or recruiting choice produced the gap, not a recruiting filter to apply per candidate. The attribute list and any working thresholds live in [`growth/`](growth/), not as canonical gates — codifying them as launch-gating numbers would add a governance surface in tension with [`PRINCIPLES.md`](PRINCIPLES.md) *Governance Minimal* and *Permissionless*.

That is the entire canonical change.

### New working-appendix doc — `growth/composition-attributes.md`

Lands in the same PR as a non-canonical working doc. Carries the seven attributes (with the per-operator / set-level split), draft composition targets, the diagnostic-not-gate framing repeated for the reader who lands here directly, and a versioning note explaining that attribute and threshold edits do *not* require canonical-doc PRs — they require the same operational review any `growth/` file gets.

The seven attributes at v0.1:

1. Social proximity to Oak/Ritsu (binary, per-operator)
2. Founder economic alignment — how much Oak/Ritsu stand to gain from this operator's participation (none / indirect / direct, per-operator)
3. Financial / professional independence — operator is not employer-captured in a way that shapes what they can publicly do or say (independent / employed-neutral / employed-conflicted, per-operator)
4. Jurisdiction of primary residence (categorical, per-operator)
5. Crypto exposure (none / single / multi-project, per-operator)
6. Technical savvy — could this operator plausibly have joined if the tools required deep developer skill (high / mid / low-with-tooling-support, per-operator)
7. Capability / skillset class — engineering / design / writing / research-eval / domain-expert / coordination (tag, per-operator → set-level coverage check)

Draft composition targets (working v0.1, all contestable, none canonical):

- **#1** ≥7/10 no pre-existing proximity
- **#2** ≥8/10 "none"; 0/10 "direct"
- **#3** ≥6/10 independent or employed-neutral; 0/10 conflicted-and-unmitigated
- **#4** ≥3 distinct jurisdictions
- **#5** all three categories represented (≥1 of each)
- **#6** ≥2/10 low-with-tooling-support; 0/10 high-savvy structurally required
- **#7** ≥3 distinct skillset classes; ≥2 operators contributing non-engineering value

## What this proposal does *not* change

- §1, §2, §3, §4, §6, §7, §8, §9, §10 — untouched
- §5 Understand / Teach / Engage — untouched (only the Refine subsection gains one paragraph)
- The headline metric in §7 — unchanged; composition is explicitly *not* elevated to a supporting metric, because §7 metrics carry targets and the whole point here is no targets in canon
- The §3 target cluster, bridge model, or rotation trigger — unchanged
- The seven attributes are *not* canonical claims. They are working v0.1 in `growth/`.
- No launch gate, no recruiting filter, no per-candidate selection criterion.

## Why not §7 or §3

- **§7 Metrics.** §7 carries metrics *with targets*. Elevating a deliberately-targetless heuristic into §7 would either (a) pollute the section's metric-with-target shape or (b) drift toward acquiring a target over time, which is the slip we are explicitly trying to avoid. The principle-aligned home is §5, where Refine already analyses the loop without target language.
- **§3 Target recruit.** §3 is about *who we set out to recruit*. Composition is *what we end up with* — a downstream property of the loop, not an input choice. Putting composition under §3 would imply we recruit on the attributes, which is the per-candidate-filter failure mode the spec exists to refuse.

## Risks and limitations

- **Drift into gate-shape over time.** The most obvious failure mode: as composition targets are sampled repeatedly, operational pressure pushes them toward becoming numeric gates. Mitigation: the canonical paragraph explicitly names this failure mode and references the *Governance Minimal* principle; `growth/composition-attributes.md` repeats the framing. If the working doc starts accumulating gate-shaped language, that's the signal to revisit the canonical paragraph, not to ratify the drift.

- **Audit-as-recruiting-filter.** The second failure mode: the daily loop quietly starts screening candidates against attributes before they reach engagement. Mitigation: the canonical paragraph explicitly forbids per-candidate filtering. `growth-refine` is the only function permitted to consume the audit; recruiting-stage skills (`discover-twitter-recruits`, `x-post-builder`, warm-list management) do not reference it.

- **Attribute set ages poorly.** The v0.1 list reflects our current best guess at the critique surface. Bittensor's critique surface looks different from Numerai's looks different from ours. Mitigation: attribute and threshold edits do not require canonical-doc PRs — they happen in `growth/composition-attributes.md` as the loop accumulates evidence. The canonical paragraph names the function, not the list.

- **Priority inversion.** If composition audits start consuming Refine cycles disproportionate to their priority (5–15% of launch-gate work per our current read), they crowd out higher-leverage refine work. Mitigation: the audit is *periodic*, not per-sprint. Cadence is operator-discretion within `growth-refine`; if cadence drifts up, that's a `growth-refine` skill-level conversation, not a canonical one.

## Open questions

- **Cadence.** How often does Refine actually run the audit? The spec deliberately doesn't specify — "periodically" is the canonical commitment, operational cadence lives in `growth-refine` and adapts. Open to redirect if a fixed cadence is preferred upfront.

- **Where does the result live?** Each audit produces a snapshot. Proposed: `growth/.local/composition-audits/YYYY-MM-DD.md` (per-audit, gitignored working notes). Open to a committed-history alternative if the snapshot itself is meant to be legible to outside reviewers (e.g. for launch-time disclosure).

- **Relationship to a future launch-time disclosure.** At mainnet launch, the §7 operator-legitimacy methodology spec (the Change-1 forward pointer from [`spec/2026-05-15-growth-principles-alignment.md`](2026-05-15-growth-principles-alignment.md)) will need to surface an on-chain-derivable operator count. The composition audit is *not* a substitute for that. The relationship: the audit informs whether the operator set the on-chain methodology is counting is also diverse enough for the launch narrative. Two different artefacts, two different purposes.

## Sequencing

1. **This spec lands.** Approval gate per [`spec/2026-04-28-canonical-docs.md`](2026-04-28-canonical-docs.md).
2. **Same PR ships the GROWTH.md paragraph and the `growth/composition-attributes.md` working doc.**
3. **First audit happens at a `growth-refine` invocation when Sprint #3 produces a non-trivial pool to sample.** No fixed deadline.
4. **A short comment on Discussion #222** linking the merged PR as the C2/C5 contribution, with the priority caveat (5–15% of launch-gate work). The Discussion comment is operational, not canonical, and lands after the PR merges.
