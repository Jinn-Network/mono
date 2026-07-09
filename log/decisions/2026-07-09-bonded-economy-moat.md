---
id: DR-2026-07-09
title: The durable moat is the live bonded economy — narrow the blanket "no moat claims" to the two false moats it was guarding (archival-data corpus, self-sustenance); the bonded economy is durable only insofar as a bad bond loses money
date: 2026-07-09
verb: Decide
status: proposed
authors: Oak (design session — issue #1487); opus (drafted)
spec: spec/2026-07-02-jinn-harness-network.md
relates-to: >
  spec/2026-07-02-jinn-harness-network.md §2 (the reconciled moat framing) + §10 (non-goals) + §13 (the DR flag this ratifies),
  issue #1487 (the design session that reconciled the moat position),
  issue #1488 (Distiller interface — builds the local/network symmetry this frames),
  issue #1489 (local loop — the rung-1 increment),
  DR-2026-06-30 (tokenless, OLAS-native — the economic layer the bonded economy rides on)
amends: "spec/2026-07-02-jinn-harness-network.md §2 (v0.3 blanket \"no moat claims\" → v0.4 named bonded-economy moat)"
---

## Context

The harness-network design (`spec/2026-07-02-jinn-harness-network.md`) shipped its earlier v0.3
context section with a blanket **"no moat claims"** posture. That posture was internally
contradictory: the same bullet named **"live bonded participation"** a durable asset while the
section as a whole disclaimed any moat. The contradiction surfaced in the 2026-07-09 design session
(issue #1487) alongside the **rung-1 local-distillation** increment — the single-player,
frontier-distil → cheap-run arbitrage the harness ships before any network verb. Rung 1 is
deliberately mirrorable (a user distils their own captures; nothing about it is a moat), which forced
the question the blanket disclaimer had been dodging: *if the solo tool is mirrorable, what — if
anything — is not?*

The blanket disclaimer was over-broad. It was guarding against two specific over-claims that a
credibly-neutral, no-enclosure protocol must never make — but in guarding those it also disowned the
one asset the design does hold.

## Decision

**The durable moat is the live bonded economy.**

Costly, money-backed human choice — a **creator bonds** that a task matters, a **solver stakes** on
an attempt, an **evaluator bonds** a verdict — is the asset. This narrows the former blanket "no moat
claims" (v0.3 §2) into two specific, still-standing rejections:

1. **The archival-data corpus moat is rejected.** A public corpus is absorbed by frontier models —
   the Stack Overflow precedent. Corpus value is *live consumption* (freshness + integration in the
   tool the user is holding), never an archival asset to sell. No enclosure, no take-rate — ever.
2. **The self-sustenance claim is rejected.** OLAS emissions are **finite bootstrap capital**, named
   as such. Runway is not a moat and must never be framed as one.

What survives both rejections — and what the blanket disclaimer wrongly disowned — is the **live
bonded economy**. No token depends on any of this; JINN optionality stays parked
(`spec/2026-07-02-jinn-harness-network.md` §10).

## Rationale

Two properties make the bonded economy durable where the archive and the runway are not:

- **Bonds label data that scraping cannot.** A creator bonding that a task matters, a solver staking
  an attempt, and an evaluator bonding a verdict together produce **priority- and quality-labelled**
  training data. Raw scraped data carries neither label — nobody paid to assert that any of it
  mattered or was correct. The label is the money at risk.
- **A market of independent parties' financial choices is not single-operator-simulable.** This is
  the direct answer to the "no data moat / mirrorable / single-operator-simulable" objection that
  rung 1 sharpened. A single operator can mirror the solo distillation tool and can simulate its own
  demand — but it cannot manufacture a *live market of independent parties* each risking their own
  money. The independence of the bonders is the thing that cannot be faked cheaply.

**The moat holds only insofar as a bad bond loses money.** It is conditioned entirely on the
**verification-before-eligibility / eviction gate** (`spec/2026-07-02-jinn-harness-network.md` §6.1):
that gate is what makes a bond a *signal* rather than noise. Without it, bonds are farmable — a
participant recovers a bad bond and the "costly choice" costs nothing — and there is no moat at all.
The claim is therefore not "bonds are a moat" but "**bonds that can lose money** are a moat, and only
while they can."

**Credible neutrality and legitimacy sit alongside it** as durable assets: the operator cannot be the
house (PRINCIPLES → Neutral), and legitimacy is not something a mirror inherits. These are social and
structural, not archival — they share the bonded economy's non-mirrorable character.

## Consequences

- **Spec updated to v0.4** (`spec/2026-07-02-jinn-harness-network.md`): §2 states the reconciled
  moat framing; §10 rewrites the non-goal to reject the *archival-data* moat and the
  *self-sustenance* claim specifically (not the bonded-economy moat); §13 flags this DR. This DR
  discharges that flag.
- **Rung 2 (selling distilled skills) is rejected as a corollary** (§5.1 D12, §10): a distilled skill
  is a **non-excludable information good** — public-domain on first sale; paywalling it leaks
  immediately and breaks corpus-as-public-good. The moat is the *live bonded market that produces the
  skills*, never the skills themselves.
- **Downstream work builds the symmetry this frames.** Issue **#1488** (the Distiller interface —
  symmetric `LocalDistiller` / `NetworkDistiller`) and **#1489** (the local loop — the rung-1
  increment) implement the local/network symmetry: rung 1 is the mirrorable solo tool; rung 3 points
  the same distillation at the bonded network's verified evidence. The moat lives at rung 3, and this
  DR is why.
- **Claim discipline.** External copy may now state that Jinn's durable asset is the live bonded
  economy — but every such claim must carry the conditioning clause (*only insofar as a bad bond
  loses money*, gated by verification/eviction) and must not revert to the rejected archival-data or
  self-sustenance framings.

## Status / next

`proposed` — goes out with the draft PR that carries the spec v0.4 amendment (closes issue #1487).
Ratifies on CODEOWNERS sign-off of the moat position change in that PR.
