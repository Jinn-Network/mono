---
id: DR-2026-05-20-b
title: Issue taxonomy — first-principles redesign; one canonical surface per axis
date: 2026-05-20
verb: Choose
status: ratified
authors: opus (proposed), oak (Captain ratified 2026-05-20)
spec: "#422 (INTERACTIVE DESIGN)"
amends: "DR-2026-05-11-b (Epic single-select field retired); DR-2026-05-18 (shape → Issue Type, priority → Project field, blocked-by Open item resolved)"
---

## Context

The engineering issue taxonomy grew by accretion. DR-2026-05-11-b established the "Jinn engineering" Project (v2) with Status / Sprint / Epic fields and a bd→GitHub mirror that minted `epic:*`, `sprint:*`, and `agent:*` labels. DR-2026-05-18 retired `bd`, made GitHub Issues + sub-issues + the Project the single source of truth, retired the `epic:*` label convention, and mandated a `shape:*` label and a `priority:<P0..P4>` label.

The result carries the same fact on two or three surfaces at once, and leaves two facts with no home at all. Issue #422 enumerates the overlaps:

- `epic:*` labels duplicated the Epic Project field (the label is retired; the field and sub-issues both still claim the axis).
- `sprint:*` labels duplicate the Sprint Project field.
- `agent:*` labels conflate "who executes this" with "how strong a model it needs."
- Work shape lives only in a free-text `## Run-mode` body section — invisible to every query.
- There is no surface for effort / model-routing, and none for a readiness / blocked signal.

#422 explicitly rejects the bolt-on framing (add a `needs-human` flag and an `effort:*` label) as deepening the tangle, and calls for a first-principles pass: enumerate the orthogonal axes, give each exactly one canonical surface, and resolve the two missing axes as first-class.

This DR is the output of that pass. It is a design decision only — no labels, fields, or handbook text change here (#422 acceptance criterion 4).

## Decision

**Every issue carries a fixed set of orthogonal axes. Each axis has exactly one canonical surface. Native GitHub primitives are preferred wherever one fits the axis; labels are reserved for flat tags with no native equivalent; the body holds narrative only.**

Surfaces, in preference order:

- **Issue-native** — lives on the issue, queryable via `gh issue list` / search: Issue Type, sub-issues, assignee, labels, open/closed state.
- **Project-layer** — lives on the "Jinn engineering" Project (v2), queryable via the Projects API (`gh project item-list`): the Status field and custom single-select / iteration fields.
- **Body** — free-text narrative.

The per-axis assignment:

| Axis | What it answers | Canonical surface | Tier |
|------|-----------------|-------------------|------|
| Work shape | What kind of work / which SOP | **Issue Type** (org-level, single-select) | issue-native |
| Status | Where in the workflow | **Project Status field** (Todo / In Progress / In Review / Done) — **view only for Autopilot lifecycle decisions** per [`2026-07-21-single-surface-lifecycle.md`](../../docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md) (amends this axis for machine paths; triage fields remain board-canonical) | Project |
| Sprint | Which week | **Project Iteration field** | Project |
| Epic / parent | Which program; parent issue | **Native sub-issues** | issue-native |
| Area | Which part of the system | **Area label** (`engineering`, `operator-app`, `ux`, …) | issue-native |
| Assignee | Who/what executes it | **Native assignee** | issue-native |
| Blocked on | What gates the start | **Project single-select** — Nothing / Human / Another issue | Project |
| Effort | How hard / model routing | **Project single-select** — Low / Medium / High | Project |
| Priority | How urgent | **Project single-select** — P0 … P4 | Project |
| Release impact | Release-readiness relevance | **`release:*` label** | issue-native |
| Context / impact / acceptance | The problem narrative | **Issue body** | body |
| Parent / child tree | Decomposition hierarchy | **Native sub-issues** | issue-native |

Concretely:

- **Work shape → Issue Type.** The nine work shapes become org-level Issue Types on `Jinn-Network`: `feat`, `fix`, `refactor`, `spike`, `chore`, `docs`, `test`, `incident`, `design`. Issue Type is single-select (enforced), shows as a native badge, and is queryable with the `type:` search qualifier and `gh issue list --type`. The `shape:*` label mandated by DR-2026-05-18 §Decision is not adopted — it was never created, and Issue Type (which matured after DR-2026-05-18) is the purpose-built primitive.
- **Blocked on → new Project single-select**, values **Nothing / Human / Another issue**. This resolves the readiness axis #422 asked for and closes DR-2026-05-18's Open item on a first-class `blocked-by` signal (the `blocked:true` label v0 is not adopted). When the value is "Another issue," the specific blocker is named with a native issue-dependency / tracked-by link; the field is the queryable tri-state, the link is the specific edge.
- **Effort → new Project single-select**, values **Low / Medium / High**. This is the model-routing signal — Low routes to a cheap/fast model, High to a strong one — decoupled from "is this agent work," which was the `agent:*` conflation.
- **Priority → Project single-select**, values **P0 … P4**, replacing the `priority:*` label mandated by DR-2026-05-18.
- **Epic → native sub-issues.** Every epic is itself an issue; the sub-issue tree is the canonical hierarchy. The Epic Project single-select field from DR-2026-05-11-b is retired (see Risk for the board-grouping contingency).
- **Assignee → native assignee.** The `agent:*` label retires: its model-strength meaning moves to Effort; its executor meaning is the native assignee where the executor has a GitHub identity, otherwise untracked (agents self-select from the Todo queue).
- **Labels shrink to flat tags with no native primitive**: area labels, `release:*`, and GitHub's community labels (`good first issue`, `help wanted`). GitHub's default type-ish labels (`bug`, `enhancement`, `documentation`) retire into the corresponding Issue Types.
- **Issue body** holds context / impact / acceptance criteria only. The `## Run-mode` section is retained but slimmed — see next section.

## How it composes with the work-shape taxonomy

The work-shape taxonomy itself is unchanged. The nine shapes, their per-shape SOPs, the skill chains, and the Conventional-Commits PR-title prefixes (`docs/engineering/handbook.md` §The shapes of work) all stand. What changes is only the *surface* shape is declared on:

- **Keep:** the nine shapes and their SOPs; the PR-title Conventional-Commit prefix convention; the `## Run-mode` body section as a *pointer*.
- **Change:** shape's canonical declaration moves from the free-text `## Run-mode` body section to the native Issue Type. The `## Run-mode` section stays in the issue template but slims to a one-line pointer to the handbook SOP for the declared type (e.g. "Type: `fix` — see handbook §fix for the skill chain"). It is no longer the source of truth, so it cannot drift from the Issue Type.
- **`fix(incident)`** maps to the `incident` Issue Type. If GitHub's per-org Issue Type cap (see Risk) cannot hold nine types, `incident` folds into the `fix` type plus an `incident` label — it is the lowest-frequency shape and the safest to demote.

## What this amends

**DR-2026-05-11-b** (engineering substrate). The Status field and the Sprint Iteration field survive unchanged. The **Epic single-select field is retired** in favour of native sub-issues. DR-2026-05-11-b's "GitHub Project (v2) as the canonical sprint surface" claim is reinforced, not weakened.

**DR-2026-05-18** (single-track on GitHub). Three amendments:

1. §Decision "Run-mode / shape … plus a `shape:<…>` label" → shape's canonical surface is the **Issue Type**; the `shape:*` label is not adopted (never created — no migration cost).
2. §Decision "Priority lives on a `priority:<P0..P4>` label" → Priority is a **Project single-select field**.
3. §Open "first-class `blocked-by` semantic … `blocked:true` label is fine for v0" → **resolved** by the "Blocked on" Project field.

Everything else in both DRs — single-track on GitHub, sub-issues for hierarchy, no bulk migration of bd-archive, the cadence machinery — stands.

## Rationale

Three reasons, in order of weight:

- **One canonical surface per axis is the whole point.** The triage ambiguity #422 names — the same fact in two places or in none — is a direct consequence of axes without a single home. Assigning each axis exactly one surface is not a style preference; it is the property that makes the taxonomy machine-usable for routing (model selection, the daily brief, autonomous-vs-human gating).
- **The native floor moved; the taxonomy did not follow it.** Issue Types and sub-issues matured after this taxonomy formed. They are single-select-enforced, render on the issue, and are queryable — labels were a workaround for primitives that did not exist. Going native-maximal retires the workaround. Labels shrink to what they are genuinely good at: flat tags (area, release, community) with no native equivalent.
- **The two missing axes deserve first-class homes, not bolt-ons.** Effort (model routing) and Blocked on (readiness) are real routing signals. As Project single-selects they get enforced single-select and board-native grouping; `eng-day` already reads the board via the Projects API, so there is no tooling regression. Bolting them on as labels — the framing #422 rejects — would reproduce the exact drift this DR exists to end.

## Alternatives considered and rejected

- **Bolt on a `needs-human` flag and an `effort:*` label.** The original framing, rejected by #422 itself: it deepens the label/field tangle and leaves the duplication (`epic:*`/`sprint:*` vs fields, `agent:*` conflation) untouched.
- **All routing axes as labels** (queryable from plain `gh issue list`). Considered in design. Rejected: labels do not enforce single-select, so a tri-state can be double-set or unset; labels cannot express the Issue Type badge or the sub-issue hierarchy; and `eng-day` already uses the Projects API, so the "plain `gh`" advantage is marginal.
- **Keep shape body-only (`## Run-mode`), no Issue Type.** Rejected: body sections are invisible to every query; shape is the single most-routed-on attribute and must be machine-readable.
- **Keep the Epic Project field as canonical (status quo).** Rejected: every epic is itself an issue, the sub-issue tree is the real hierarchy, and a parallel flat field is the exact duplication #422 exists to remove. (Retained only as a derived projection if board grouping requires it — see Risk.)
- **Milestones for Sprint.** Considered — Milestones are issue-native and visible in `gh issue list`. Rejected: the Iteration field is purpose-built for rolling sprints (auto-advance, duration), DR-2026-05-11-b/-18 already established it, and re-platforming Sprint is needless churn.

## Migration plan

No implementation lands under #422 (acceptance criterion 4). Implementation is two follow-up issues, filed as sub-issues of #422; both are gated on ratification of this DR before work starts:

1. **#424 (`docs`) — Revise the engineering canon for the redesigned taxonomy.** Update `docs/engineering/handbook.md` (§The shapes of work, the `## Run-mode` convention, AI workflow rule 3, the daily-loop sections) and the `CLAUDE.md` handbook recap to describe Issue Type as the shape surface, the three new/changed Project fields, and the retired labels. Update the Issue templates (slim the `## Run-mode` section; set Issue Type at create).
2. **#425 (`chore`) — Provision and migrate the taxonomy surfaces.** Create the nine org-level Issue Types; create the "Blocked on", "Effort", and "Priority" Project single-select fields; retire the Epic field and the `sprint:*` / `agent:*` / `priority:*` / redundant-default labels; backfill Issue Type + the new fields on all open issues in one pass; update the `eng-day` skill's queries to read Issue Type and the new fields.

(#422 acceptance criterion 3 calls both follow-ups "`docs`-shape"; the provisioning / migration work is mechanically a `chore` and is filed as such.)

## Consequences

- **Issue Types are org-level.** Defining the nine types is an org-owner action on `Jinn-Network`, shared by every repo in the org. This is a coordination point, not just a repo change.
- **Project-layer fields are not visible in plain `gh issue list`** or on the issue page — Effort, Blocked on, Priority, Status, and Sprint need the Projects API. The `eng-day` skill already reads the board via `gh project item-list`, so the daily brief is unaffected; the handbook's documented `gh issue list` fallback will not see these axes, which is acceptable for a fallback.
- **The `eng-day` skill changes.** Its queries must read Issue Type (`--type`) and the new Project fields; the "ready queue" definition (`Status=Todo ∧ no open tracked-by`) extends to also exclude `Blocked on ∈ {Human, Another issue}`.
- **Issue templates change.** The `## Run-mode` section slims to a handbook pointer; the template prompts for Issue Type at create-time.
- **PR machinery is unaffected.** The Conventional-Commit PR-title prefix and the release-notes scaffold that reads it are unchanged.
- **One backfill pass** over open issues sets Issue Type and the new fields; tracked in the `chore` follow-up.

## Risk assessment

- **GitHub Issue Type per-org cap.** GitHub caps custom Issue Types per org. Nine types is expected to fit, but the cap must be verified at implementation. Fallback: fold `incident` into `fix` + an `incident` label (lowest-frequency shape). Risk: low.
- **Board grouping by sub-issue parent.** Retiring the Epic field assumes the Project (v2) board can group / roadmap by sub-issue parent. If it cannot, the Epic single-select field is retained — but explicitly as a *derived board projection*, not a canonical surface, kept in sync from the sub-issue parent at sprint-pull time. The `chore` follow-up verifies this before retiring the field. Risk: medium, contained.
- **Org-level blast radius.** Issue Types apply to every repo in `Jinn-Network`. Other repos inherit the nine types; if that is unwanted, the redesign is still repo-correct but the type set should be named to read sensibly org-wide. Risk: low.
- **Project-API dependency for routing.** Effort / Blocked on / Priority are only queryable through the Projects API. If a future tool needs them from plain `gh issue list`, it cannot. Accepted: `eng-day` is the routing consumer and already uses the Projects API. Risk: tolerable.
- **Migration backfill effort.** Backfilling Issue Type + three fields across all open issues is a manual-ish one-pass cost. Risk: low, one-time.

## Open

- **Persistent executor record.** The native assignee covers humans and any agent with a GitHub identity. If a durable "which agent executed this" record is wanted, add a Project "Executor" single-select — not mandated in v0; revisit if friction surfaces.
- **Effort scale.** Low / Medium / High is the v0 scale. If model-routing needs finer buckets (or a numeric estimate), revisit.
- **`release:*` label.** Kept as a flat tag in v0. It may be foldable into the work shape + PR-prefix that already drive release-notes generation; decide at migration time.
- **Exact Issue Type cap.** Verify GitHub's current per-org limit at implementation; it governs the `incident`-as-type vs `incident`-as-label fallback.

## Status

Proposed by opus on 2026-05-20 as the output of #422 (INTERACTIVE DESIGN). The taxonomy model — native-maximal surface assignment, the "Blocked on" axis name, Effort as Low / Medium / High, Priority moving to a Project field — was co-designed in-session with Captain oak on 2026-05-20, and ratified by Captain oak on 2026-05-20. The two follow-up implementation issues — #424 (`docs`) and #425 (`chore`) — are filed as sub-issues of #422 and unblocked for execution.

**Amendment (2026-07-21, single-surface lifecycle):** For Autopilot lifecycle
*decisions*, Project **Status** is outbound paint only (scheduled board painter).
Effort, Priority, Blocked on, Sprint, and Issue Type assignments in this DR are
unchanged. See `docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md`
§2 and §9.
