- **Date:** 2026-04-28
- **Author:** Oak
- **Status:** Proposal
- **Version:** 0.1

## Motivation

Working with AI generates documents at a rate humans never could. That's mostly good — more thinking gets captured, more options get explored, more context survives the gap between sessions. But it has a failure mode that compounds quietly: **overlap and drift**.

The same idea gets restated in three specs with subtly different framings. A term gets defined inline in one doc, then redefined slightly differently in the next. A brand rule articulated in `DESIGN.md` gets contradicted in a marketing draft because nobody knew `DESIGN.md` was the source of truth. Every restatement is a fork; every fork is a future merge conflict in the team's collective head.

The repo already shows symptoms:

- `PRODUCT.md` and `DESIGN.md` exist at root but aren't formally labelled as authoritative — they read like "one of the docs" rather than "the doc."
- `AGENTS.md` exists in parallel to `CLAUDE.md` and the relationship is undefined.
- `docs/design/jinn-design-system/` has its own `SKILL.md` whose non-negotiables already conflict with the root `DESIGN.md` (the corner-radius rule), and the README has had to explicitly note the override.
- `spec/` accumulates dated proposals that may or may not have been ratified, with no signal about which ones are now load-bearing.
- Lexicon (*vessel, vow, summon, smoke, seer, wane*) is defined in multiple places, with the design system claiming protocol-level immutability and no single file you can point at as the dictionary.

None of this is broken yet. It will be, and the fix gets more expensive every week we wait. Agents are particularly susceptible: they read whatever they happen to find, and without a clear "read this first" signal they confidently produce work that contradicts decisions made elsewhere in the repo.

The proposal is to introduce a small, deliberate, approval-gated set of **canonical docs** — repo-level constants — and route the agentic workflow through them via `CLAUDE.md`.

## What "canonical" means

A **canonical doc** is a root-level `CAPITALISED.md` file that:

1. Names a stable, repo-wide source of truth on a single topic.
2. Is referenced from `CLAUDE.md` with explicit triggers, so agents reliably consult it before producing related work.
3. Changes only via an approved PR (CODEOWNERS review + a linked GitHub Discussion that justifies the change).
4. Is referenced from non-canonical docs via a "Canonical references" footer, making drift greppable.

Think of canonical docs as the repo's `const` declarations. Most of the codebase (and most of `docs/`) is `let` — it changes freely. Canonical docs change rarely and require the equivalent of a code review for a constant: a deliberate, recorded act.

The set is intentionally small. The whole value comes from being able to point at a short list and say "these are the things you do not get to silently restate."

## The canonical set

| File | Topic | Disposition |
|---|---|---|
| `PRINCIPLES.md` | Principles that govern every design and operational decision in Jinn — upstream of all other canonical docs | **Privileged**: read at the start of every agent session; decision-making runs through these principles |
| `SPEC.md` | Protocol spec — the loop, roles, on-chain primitives, current phase boundaries | New; consolidates ratified material from `spec/` |
| `THESIS.md` | Why Jinn exists; the bet; non-goals; what we are *not* | New; supersedes `PRODUCT.md` |
| `BRAND.md` | Visual + voice canon; lexicon-adjacent style; non-negotiables | New; supersedes `DESIGN.md` (and absorbs voice from the design system) |
| `GROWTH.md` | Distribution strategy; channels; metrics that matter; what we will not chase | New; will absorb pieces of `growth/` |
| `GLOSSARY.md` | Authoritative definitions for Jinn-specific terms (vessel, vow, summon, smoke, seer, wane, …) | New |

`AGENTS.md` is deleted. `PRODUCT.md` and `DESIGN.md` remain in place until their successors (`THESIS.md`, `BRAND.md`) are populated through the new approval process — at which point they're deleted in the same PR that lands the successor.

`README.md` and `CLAUDE.md` are also root-level capitalised files but are treated as **meta**: they describe the repo and the agent contract respectively, and are exempt from the spec-proposal requirement (though still CODEOWNERS-reviewed). See open questions.

## Format

Free-form Markdown. No fixed schema. The "canonical" property is provided by the approval gate, not by the layout — trying to mechanically enforce structure would either be too loose to matter or too rigid to fit five different topics.

Each canonical doc SHOULD start with a one-paragraph **"What this doc is / is not"** preamble. This serves two purposes: it lets a human (or agent) verify in five seconds whether they're in the right place, and it makes the doc's scope explicit so adjacent material doesn't get smuggled in over time.

## Approval gate

Two requirements, both enforced.

### 1. CODEOWNERS

`.github/CODEOWNERS` requires review from designated owners for any PR that modifies canonical files. Bootstrap owners are `@oaksprout` and `@ritsukai` directly — a `@Jinn-Network/canon` team can be introduced later if/when the canon group grows beyond two people.

```
# Canonical docs — require canon-owner review
/PRINCIPLES.md @oaksprout @ritsukai
/SPEC.md       @oaksprout @ritsukai
/THESIS.md     @oaksprout @ritsukai
/BRAND.md      @oaksprout @ritsukai
/GROWTH.md     @oaksprout @ritsukai
/GLOSSARY.md   @oaksprout @ritsukai
/CLAUDE.md     @oaksprout @ritsukai
/README.md     @oaksprout @ritsukai
```

GitHub branch protection on `main` enforces that CODEOWNERS approval is required before merge.

### 2. Linked GitHub Discussion

Any PR that creates or modifies a canonical doc MUST link to a [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions) that justifies the change. Discussions are where upstream reasoning happens; the PR is the ratification act, and the linked discussion is the audit trail. Enforced by:

- A canonical-change section in `.github/PULL_REQUEST_TEMPLATE.md` that prompts for the discussion link and lists the canonical-doc checklist.
- A CI workflow (`.github/workflows/canonical-docs-check.yml`) that fails the PR if any canonical file is in the diff and no `github.com/Jinn-Network/mono/discussions/<n>` URL appears in the PR body.

Trivial edits (typo fixes) still go through CODEOWNERS but may cite an existing discussion (or skip the link if the change is purely cosmetic — reviewer's call). The CI check is path-based, not semantic — reviewers decide whether the cited discussion actually justifies the change.

Dated specs in `spec/` remain available for cases where the upstream thinking is too long-form for a discussion thread, but they are not the default and are not required by CI.

## CLAUDE.md integration

A new top-level section is added to `CLAUDE.md`. References use **triggered** phrasing — each entry names the kind of work that should cause an agent to read the doc — modelled on the existing "Read it before building any UI…" pattern already used for the design system.

```markdown
## Canonical Docs

Canonical docs are the repo's stable sources of truth. They change only via approved PRs (CODEOWNERS review + a linked GitHub Discussion; see `spec/2026-04-28-canonical-docs.md`). Always prefer canonical docs over restated information found elsewhere in the repo, and never redefine canonical content locally — link instead.

[`PRINCIPLES.md`](PRINCIPLES.md) — This document should be read by agents at the beginning of all new sessions. All decision-making should run through these principles. Agents should keep their thinking and actions, as well as attempt to keep their human users' thinking and actions, in line with the principles stated herein.

Other canonical docs:

- `SPEC.md` — read before reasoning about the protocol loop, roles, contracts, or phase boundaries
- `THESIS.md` — read before writing positioning, pitch, strategic copy, or any "why Jinn" framing
- `BRAND.md` — read before producing any user-facing artifact (UI, slides, docs, marketing copy)
- `GROWTH.md` — read before planning distribution, campaigns, channel strategy, or growth experiments
- `GLOSSARY.md` — read whenever a Jinn-specific term appears; never redefine terms locally
```

`PRINCIPLES.md` is privileged among canonical docs: every agent session begins by reading it, and every decision is expected to run through it. Other canonical docs are read on triggered phrases.

The existing `## Design System` section in `CLAUDE.md` is rewritten to defer to `BRAND.md` once `BRAND.md` is populated. In the bootstrap PR (where `BRAND.md` is still a stub) the section keeps its current content with a one-line note that it is being migrated.

## Drift policy

Two rules. Both enforced by review, not CI.

### Link, don't restate

Non-canonical docs that touch a canonical topic link to the canonical doc instead of restating it. The only acceptable restatement is a marked quotation that links back to the source. Reviewers are expected to push back on local redefinitions of canonical material.

### Canonical references footer

Any non-canonical doc that depends on canonical content ends with a footer:

```markdown
---
**Canonical references:** [BRAND.md](BRAND.md), [GLOSSARY.md](GLOSSARY.md)
```

When a canonical doc is changed, the reviewer runs `git grep -l "Canonical references.*BRAND.md"` (or equivalent) to surface every downstream doc that footnoted the changed file, and decides which need re-review. This turns the dependency graph into a one-line shell command — no tooling, no false positives, no graph database.

The PR template for canonical-doc changes includes this as an explicit checklist item.

## Bootstrap PR scope

A single PR lands the policy and the empty shells. Content migration happens in follow-up PRs, each going through the new approval process — which is the precedent we want to set from day one. Ramming five populated canonical docs through in one PR would contradict the policy itself.

The bootstrap PR includes:

- This spec at `spec/2026-04-28-canonical-docs.md`
- `.github/CODEOWNERS` with the canonical-doc rules above
- `.github/PULL_REQUEST_TEMPLATE.md` (new or amended) with a canonical-change checklist
- `.github/workflows/canonical-docs-check.yml` (CI: spec link required when a canonical file is in the diff)
- `CLAUDE.md` — new "Canonical Docs" section inserted near the top of the file; existing "Design System" section gets a one-line migration note
- `SPEC.md`, `THESIS.md`, `BRAND.md`, `GROWTH.md`, `GLOSSARY.md` — each created as a one-paragraph stub with the "What this doc is / is not" preamble and a `<!-- TO BE POPULATED via spec proposal -->` marker
- `AGENTS.md` deleted

`PRODUCT.md` and `DESIGN.md` are explicitly **not** touched in the bootstrap PR. They are deleted in the follow-up PRs that populate `THESIS.md` and `BRAND.md` respectively.

### Suggested content for the CI check

Conceptually:

```yaml
# .github/workflows/canonical-docs-check.yml
name: Canonical docs check
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Verify discussion link for canonical-doc changes
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: |
          CANON='^(SPEC|THESIS|BRAND|GROWTH|GLOSSARY)\.md$'
          changed=$(git diff --name-only origin/${{ github.base_ref }}...HEAD)
          if echo "$changed" | grep -E "$CANON" > /dev/null; then
            if ! echo "$PR_BODY" | grep -E 'github\.com/Jinn-Network/mono/discussions/[0-9]+' > /dev/null; then
              echo "Canonical doc changed but no GitHub Discussion linked in PR body."
              exit 1
            fi
          fi
```

The check is URL-pattern based by design. Semantic checks (does the discussion actually justify the change) are the human reviewer's job.

### Suggested PR template addition

```markdown
### Canonical-doc changes (delete if not applicable)

- [ ] Linked GitHub Discussion: `https://github.com/Jinn-Network/mono/discussions/<n>`
- [ ] CODEOWNERS approval obtained
- [ ] Ran `git grep -l "Canonical references.*<changed-file>"` and re-reviewed downstream docs
- [ ] Updated downstream docs that needed it (or noted why none did)
```

## Rollout

1. **Bootstrap PR** (this proposal + scaffolding above). Lands the policy.
2. **Follow-up: `THESIS.md`** — own spec proposal; populates from `PRODUCT.md`; deletes `PRODUCT.md`.
3. **Follow-up: `BRAND.md`** — own spec proposal; populates from `DESIGN.md` + voice section of `docs/design/jinn-design-system/`; deletes `DESIGN.md`; rewrites `CLAUDE.md`'s Design System section to defer to `BRAND.md`.
4. **Follow-up: `GLOSSARY.md`** — own spec proposal; collects existing lexicon definitions into one place; downstream docs migrate to link rather than restate as they are next touched (no big-bang migration).
5. **Follow-up: `SPEC.md`** — own spec proposal; consolidates ratified material from `spec/` (especially the Phase 1a/1b designs) into a single living document.
6. **Follow-up: `GROWTH.md`** — own spec proposal; consolidates `growth/`.

Order is suggested, not strict. Each follow-up is independent.

## Risks and limitations

- **Approval bottleneck.** A small canon team becomes a chokepoint. Mitigation: keep the canon team small but not single-person; the spec-proposal requirement means most of the thinking happens before review, so review is mostly a yes/no.
- **CI false negatives.** A path-based CI check will pass if someone links any old spec file. The check is a tripwire, not a substitute for review.
- **Stub bloat.** Five empty canonical files at root could feel like clutter before they're populated. Mitigation: each stub's preamble explicitly says it's a stub awaiting its spec, with a link to this proposal.
- **Cultural overhead.** "Yet another rule." Mitigation: canonical docs are a *small* set on purpose, and the policy is meant to feel like the equivalent of constant-folding — invisible most of the time, load-bearing when it matters.
- **Agentic interaction.** Agents may still read non-canonical material first and never reach the canonical doc. Mitigation: triggered references in `CLAUDE.md` are the strongest signal we have today; if it proves insufficient we can revisit (e.g. promote canonical docs to a skills-style routing layer).

## Open questions

- **CODEOWNERS handle.** Resolved: individual handles (`@oaksprout`, `@ritsukai`) for now. A `@Jinn-Network/canon` team is deferred until the canon group has reason to grow.
- **Are `README.md` and `CLAUDE.md` formally canonical?** Proposed: yes — CODEOWNERS-protected, but exempt from the spec-proposal requirement since they're meta. Open to argument that `CLAUDE.md` *should* require a spec given how load-bearing it is for agent behaviour.
- **CI check strictness.** Strict (blocks merge) or advisory (label-only) at first? Proposed: strict, with override via a `canonical-bypass` label that itself requires CODEOWNERS approval to apply.
- **Versioning.** Should canonical docs carry a version + last-changed date in their preamble? Proposed: yes for `SPEC.md` (because phase boundaries matter), optional for the rest.
- **Per-doc owners.** Single canon team for all five, or per-doc owners (e.g. design lead owns `BRAND.md`, growth lead owns `GROWTH.md`)? Proposed: single team for now; split if it becomes a bottleneck.

## Appendix: relationship to existing structure

- `spec/YYYY-MM-DD-*.md` — unchanged. Canonical-doc proposals are a new *use* of this directory, not a new format.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — unchanged. Implementation specs and plans for code work continue to live there.
- `docs/design/jinn-design-system/` — unchanged in the bootstrap. When `BRAND.md` is populated it becomes the entry point and the long-form system in `docs/design/` is its appendix; the existing `SKILL.md` non-negotiables are reconciled at that point.
- `growth/` — unchanged in the bootstrap. Becomes `GROWTH.md`'s long-form appendix when that doc is populated.
