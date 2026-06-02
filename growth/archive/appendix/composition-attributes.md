# Operator-set composition attributes

- **Version:** v0.1 (working notes — not canonical)
- **Date introduced:** 2026-05-15
- **Canonical reference:** [`GROWTH.md`](../GROWTH.md) §5 Refine "Composition heuristic"
- **Origin spec:** [`spec/2026-05-15-growth-composition-heuristic.md`](../spec/2026-05-15-growth-composition-heuristic.md)
- **Provenance:** GitHub Discussion [#222](https://github.com/Jinn-Network/mono/discussions/222) §C2 / §C5

## What this doc is / is not

This is a working appendix to GROWTH.md §5 Refine's composition heuristic. It carries the **current draft** of attributes and thresholds the audit samples against. It is *not* canonical and edits to this file do *not* require canonical-doc PRs — they require the same operational review any [`growth/`](.) file gets.

This is also explicitly *not* a launch gate, a recruiting filter, or a per-candidate selection criterion. See the *How NOT to use this* section below before doing anything with these numbers.

## Why we sample composition at all

Diversity is one signal of the operator set's structural neutrality. The launch-narrative critiques that have stuck to past fair-launches (Bittensor distribution, Numerai hedge-fund coupling, every founder-cabal narrative) attached because *the operator set at t=0 was visibly downstream of a structural advantage*. Sampling composition against a small attribute set lets Refine catch when that downstream shape is forming in time to push the question back into upstream design — tooling, recruiting loop, cluster strategy, harness accessibility — rather than treat the recruiting loop as the locus of correction.

Per [`PRINCIPLES.md`](../PRINCIPLES.md): the actual launch-legitimacy work lives in *mechanism*. This audit is a diagnostic that runs *alongside* mechanism work and surfaces when mechanism is producing a non-neutral operator set.

## The seven attributes (v0.1)

Six per-operator attributes plus one set-level coverage check.

| # | Attribute | Values | Layer |
|---|---|---|---|
| 1 | **Social proximity to Oak/Ritsu** — pre-existing personal relationship, warm intro through Oak/Ritsu, or current/recent compensation from either | Binary (`no proximity` / `proximity`) | Per-operator |
| 2 | **Founder economic alignment** — how much Oak/Ritsu's positions appreciate if this operator participates | Categorical (`none` / `indirect` / `direct`) | Per-operator |
| 3 | **Financial / professional independence** — whether the operator is employer-captured in a way that shapes what they can publicly do or say | Categorical (`independent` / `employed-neutral` / `employed-conflicted`) | Per-operator |
| 4 | **Jurisdiction** — primary residence jurisdiction | Categorical (US / EU / UK / LATAM / E.Asia / S.Asia / Africa / Oceania / hostile-crypto / other) | Per-operator |
| 5 | **Crypto exposure** — prior public crypto involvement | Categorical (`none` / `single project` / `multi-project`) | Per-operator |
| 6 | **Technical savvy** — could this operator plausibly have joined if the tools required deep developer skill | Categorical (`high` / `mid` / `low-with-tooling-support`) | Per-operator |
| 7 | **Capability / skillset class** — primary skill class the operator contributes beyond just running the client | Tag (`engineering` / `design` / `writing` / `research-eval` / `domain-expert` / `coordination`) | Per-operator tag → **set-level coverage** |

## Draft composition targets (v0.1)

All thresholds are working numbers and explicitly contestable. **Do not codify in any canonical doc.**

- **#1 Social proximity:** ≥7/10 `no proximity`
- **#2 Founder economic alignment:** ≥8/10 `none`; 0/10 `direct`
- **#3 Financial / professional independence:** ≥6/10 `independent` or `employed-neutral`; 0/10 `employed-conflicted` without an explicit mitigation
- **#4 Jurisdiction:** ≥3 distinct categories represented
- **#5 Crypto exposure:** all three categories represented (≥1 of each)
- **#6 Technical savvy:** ≥2/10 in `low-with-tooling-support`; 0/10 cases where `high` savvy was structurally required to participate
- **#7 Capability / skillset:** ≥3 distinct skillset classes represented; ≥2 operators contributing non-engineering value

## How to use this

- **`growth-refine` consumes it periodically.** Cadence is operator-discretion within the skill; the canonical commitment is "periodically," not a fixed schedule.
- **A gapped attribute is a question, not a finding.** *Why* did the operator set produce this gap? Tooling? Recruiting loop bias? Cluster handle too tight? The answer informs upstream design changes — to the loop, to the §3 cluster, to the harness onboarding shape, to the engagement rungs. Not to the recruiting funnel's per-candidate selection.
- **Audit snapshots live in `growth/.local/composition-audits/YYYY-MM-DD.md`** (working notes, gitignored). Per-audit results are not committed history; if a launch-time disclosure of composition becomes required, the §7 operator-legitimacy methodology spec will own that artefact, not this doc.

## How NOT to use this

- **Not a launch gate.** Composition targets are not numeric gates that "the operator set must hit before mainnet." That's the audit-as-gate failure mode the GROWTH §5 canonical paragraph explicitly refuses.
- **Not a per-candidate recruiting filter.** Candidates are not screened against attributes before they join. That's the audit-as-recruiting-filter failure mode the canonical paragraph explicitly refuses.
- **Not a substitute for mechanism work.** Founder economic pre-commitments (Discussion #222 §C7), governance surface minimisation (§C17–C19), distribution-shape mechanism design (§E1–E7) all do more legitimacy work than this audit. If composition audit work is consuming time that should be going to those, the priority has inverted.
- **Not a substitute for the §7 operator-legitimacy methodology.** That's a separate, on-chain-derivable artefact that counts whether operators exist. This is a diagnostic on the operators that are counted.

## Versioning

This file evolves freely. Significant changes — adding or removing an attribute, materially shifting a threshold — should land via PRs that explain the rationale, but they do not require canonical-doc spec proposals or CODEOWNERS-canonical approval. The canonical commitment in GROWTH.md §5 names the function, not the attribute list.

If this file starts accumulating gate-shaped language ("operators must satisfy," "blocks launch unless," etc.) — that's the signal to revisit the canonical paragraph in GROWTH.md §5, not to ratify the drift.

## Related

- [`GROWTH.md`](../GROWTH.md) §5 Refine — the canonical commitment
- [`spec/2026-05-15-growth-composition-heuristic.md`](../spec/2026-05-15-growth-composition-heuristic.md) — origin spec
- [`spec/2026-05-15-growth-principles-alignment.md`](../spec/2026-05-15-growth-principles-alignment.md) — sibling alignment-pass spec; carries §7's operator-legitimacy methodology forward-pointer that this doc is *not* a substitute for
- [`PRINCIPLES.md`](../PRINCIPLES.md) *Governance Minimal*, *Permissionless*, *Learning Maximised*, *Legible* — the load-bearing principles
- GitHub Discussion [#222](https://github.com/Jinn-Network/mono/discussions/222) §C2 / §C5 — launch-gating discussion this audit contributes to
