# Route a skilled human onto every load-bearing human surface via CODEOWNERS

- **id:** DR-2026-06-03
- **Date:** 2026-06-03
- **Author:** opus
- **Status:** Accepted — GitHub path list for enqueue superseded by [DR-2026-08-20](./2026-08-20-human-surface-enqueue-gate.md) (render dirs dropped from the gate; product-canon specs retained). Mechanism (CODEOWNERS + require-code-owner-review) retained on that shrunk set.
- **Verb:** Steer

## Summary

We have one review pipeline for two kinds of change that are no longer the same
kind of thing. **Code** is increasingly *black-boxable*: a passing test stands
in for a human reading the diff, and agent review-parity (AI workflow rule 4)
covers the rest. **Human surfaces** — UI copy, the design system, external
comms — are black-boxable *by definition* never: their correctness is "does a
person reading or using this get the right meaning, voice, and trust?" and no
test answers that. The only verifier is a skilled human.

But not every human surface is worth a human's scarce attention. The governing
test is not "is this a human surface" — it is "is this a **load-bearing** human
surface": one whose failure misleads a real reader or breaks trust because it is
*currently visible* to users or is canon the rest of the repo derives from. We
do not have the context to infer load-bearingness from paths automatically, so
for now the set is **manually encoded** by the operator (this DR).

The solution is **not** a new system. It is to use the one gate that already
works — `.github/CODEOWNERS` path entries + the "require Code Owner review"
branch protection — and point it at the manually-named load-bearing set, so a
skilled human's review is *required* (not merely invited) on those PRs, plus the
one rule that makes it real: **an agent's approval never satisfies this gate.**

## Context

The operator's observation: the way we review code changes is being applied,
unchanged, to changes on critical human surfaces — and that is now a mismatch.
Code verification is migrating to tests and agents; that is good, and it frees
the scarce resource (skilled human attention) to go where it cannot be
delegated. Today nothing *routes* that attention. A press release, a brand
move, or an operator-app copy change flows through the same PR → CI → merge path
as a refactor, and an agent can be the only reviewer on either.

We already solved exactly this for canonical docs. `.github/CODEOWNERS` lists
`PRINCIPLES.md … README.md` against `@oaksprout @ritsukai`; branch protection
makes that review *required*; `canonical-docs-check.yml` adds a CI guard that a
Discussion link justifying the change is present. That stack is the human-surface
gate. It just only covers one surface. Per Gall's Law, the move is to evolve the
working simple system, not design a new complex one from scratch.

## The distinction (the litmus test)

A change is a **human surface** change if a passing test cannot prove it is
*good* — if the only judge is a person reading or using the artifact. Voice,
clarity, taste, trust, and "does this read as a promise we can keep" are not
test-checkable. A human surface is **load-bearing** when it is, right now, in
front of users (currently-visible UI) or is canon other work derives from
(README, canonical docs). Those are the ones that get the gate.

Load-bearingness is a judgment we cannot yet read off the file tree, so the set
is **enumerated by hand** rather than inferred. Two consequences, both
accepted: we gate only the *render* directories of the live frontends (the parts
that reach a screen), leaving the data/logic dirs (`api/ hooks/ lib/
notifications/`) agent-reviewable; and a **new render directory must be added to
CODEOWNERS by hand** — the glob does not infer it. The known leak is that a value
formatted in `lib/` or a message chosen in a `hook` can change the screen without
tripping the gate; reviewer judgment and the operator-app spec carry that edge
until it proves worth tightening.

## Decision

1. **The manually-encoded load-bearing set** (operator-directed, 2026-06-03),
   all owned by `@oaksprout @ritsukai` in `.github/CODEOWNERS`:

   - `README.md` and every canonical doc (`PRINCIPLES SPEC THESIS BRAND GROWTH
     GLOSSARY CLAUDE`) — *already gated*; no change needed.
   - The currently-visible (render) parts of the **operator app**
     (`client/src/dashboard/spa/src/`): `App.tsx`, `routes.ts`, `pages/`,
     `components/`, `regions/`, `shell/`, `styles/`.
   - The currently-visible (render) parts of the **network explorer**
     (`packages/indexer/explorer/src/`): `App.tsx`, `views/`, `components/`,
     `styles/`.

   The two `legacy/…` explorers and the design-system reference kit are *not*
   currently visible to users and are deliberately excluded.

2. **The one rule that makes it real** (to be stated in the handbook via a
   separate Discussion-gated docs PR): *Code review may be delegated to an
   agent; load-bearing human-surface review may not.* On these paths the
   CODEOWNERS approval cannot be satisfied by agent review-parity. This is
   already true mechanically — CODEOWNERS requires a named human account, the
   "require Code Owner review" branch protection that backs the canonical-doc
   lines makes it non-bypassable, and rule 4 forbids agent self-merge — so the
   handbook change records the policy; it does not build new enforcement.

3. **Nothing else.** No new Issue Type, no PR-classifier bot, no second
   pipeline, no new CI. The gate is CODEOWNERS + the branch-protection setting
   that already backs the canonical-doc lines.

## Rationale — why this respects Gall's Law

- **One mechanism, already in production.** CODEOWNERS path-gating works today
  for canonical docs. We are changing its *path set*, not its design. A complex
  human-surface-review system built from scratch would not work and could not be
  made to work; this is the simple system that already works, widened.
- **The simplest thing that could possibly work.** The entire enacted change is
  a block of CODEOWNERS lines pointing at a hand-named set. Everything else in
  this DR is the *frame* that tells a contributor why those paths are different
  — which is the part code can't carry.
- **A hand-curated set is the honest v0.** We do not yet have a way to read
  load-bearingness off the tree, so we do not pretend to. The operator names the
  set; the file is the record; it grows by hand as surfaces ship or retire. A
  classifier can come later if the manual list becomes a burden — that is the
  Gall's Law evolution, not the starting point.
- **A clean evolution path, deferred.** v0 assigns the one skilled-human pair we
  have to every load-bearing surface. As specialists appear, split the lines by
  surface (design steward on the explorer, product steward on the operator app)
  — same mechanism, finer ownership. Named as a seed, not built now.
- **It routes scarce attention, it does not add bureaucracy.** The gate fires
  only on the hand-named load-bearing paths — render dirs and canon — so the
  black-boxable majority of PRs, including the frontends' own logic dirs, are
  untouched. It is a router for human attention toward the changes only a human
  can verify — the operator's exact concern.

## Alternatives considered

- **A `human-surface` Issue Type / work shape.** Rejected: shape is declared at
  Issue create-time and is about *how you work* (TDD vs. regression test), not
  *who must approve the diff*. The gate has to bind at the PR/path level, which
  is what CODEOWNERS already does. A new shape would be a parallel taxonomy that
  drifts from the path reality.
- **A CI classifier that diffs each PR and labels it "human-surface."** Rejected
  as the from-scratch complex system Gall's Law warns against: it needs a
  heuristic for "is this copy or code," will mislabel, and reinvents what a
  path glob in CODEOWNERS gives us deterministically and for free.
- **Glob the whole frontend src tree.** Rejected (operator's call, 2026-06-03):
  over-gates code-only changes — a pure data-fetch refactor in `hooks/` would
  need a designer. We gate the render dirs only, accepting that a visible change
  smuggled through a logic dir can slip the gate, and rely on reviewer judgment
  for that edge.
- **Press releases and the design system as load-bearing paths.** Not in the
  operator-named set for this round (`docs/press/` has its own skill + PRINCIPLES
  Legibility check at authoring time; the design-system source is not
  currently-visible product). Candidate future additions — append the line when
  one becomes load-bearing.
- **Extend `canonical-docs-check.yml` to require a Discussion link on the new
  paths.** Deferred: a Discussion link is the right *deliberation* gate for
  canon, but heavy for a one-line UI copy fix. The required-human-review
  primitive is enough; add per-surface CI guards only if a real gap surfaces.

## What this PR enacts (and what remains)

- **Enacted here:** the CODEOWNERS lines for the two frontends' render dirs.
  README and the canonical docs were already gated. Enforcement is automatic —
  the repo's "require Code Owner review" branch protection already backs every
  CODEOWNERS path, so the new lines are non-bypassable the moment they merge; no
  admin toggle is needed (it is the same setting that gates the canonical docs).
- **Remains (separate Discussion-gated docs PR):** state the "code review may be
  delegated; load-bearing human-surface review may not" rule in
  `docs/engineering/handbook.md`, with a one-line pointer from CLAUDE.md
  §Frontends.
- **Remains (by hand, ongoing):** add a CODEOWNERS line when a new render
  directory or load-bearing surface ships; remove one when a surface retires.
- **Later, if the manual list becomes a burden:** revisit owner-splitting
  (design vs. product) and whether a classifier earns its complexity.

## References

- `.github/CODEOWNERS` — the gate being widened
- `.github/workflows/canonical-docs-check.yml` — the canon CI deliberation guard
- `spec/2026-04-28-canonical-docs.md` — the precedent: approval-gated repo constants
- `log/decisions/2026-05-20-holistic-release-review-gate.md` — DR-2026-05-20, the
  "propose the gate, owners ratify their own review burden" precedent
- CLAUDE.md §Frontends (UI-model-change-lands-with-spec), §External Communication
- AI workflow rule 4 (agent PR review parity; no agent self-merge)
