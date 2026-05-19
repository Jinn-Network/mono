---
id: DR-2026-05-18
title: Issue tracking substrate — retire bd, single-track on GitHub Issues
date: 2026-05-18
verb: Choose
status: ratified
authors: opus (proposed), oak (Captain ratified 2026-05-18)
spec: jinn-mono-waxs (spike)
supersedes-context-from: DR-2026-05-11-b (bd-as-SoR with sprint-scoped mirror)
---

## Context

DR-2026-05-11-b ratified a dual-substrate model one month ago: `bd` (Dolt-backed, local-first) as internal source of truth, mirrored one-way to public GitHub Issues + the "Jinn engineering" Project (v2) at sprint-pull time via the `scripts/bd-mirror` helper. The decision rested on three load-bearing claims:

1. **bd's privacy is load-bearing** — exploratory `needs-design-session` framing and captain-internal notes would either self-censor or leak if all bd were public.
2. **GitHub Projects already won on visibility** — splitting roles uses each tool's strength.
3. **Sprint-scoped mirror is cheap and reversible** — a ~30-line bridge with low reversibility cost.

A month of operation under this model produces three observations that re-open the trade.

**Mirror drift is structural, not incidental.** Empirical state on 2026-05-18: 50 open bd issues, 16 mirrored to GitHub (32%), 34 unmirrored (68%). The "sprint-scoped" framing means two-thirds of in-flight work has no public surface. Beyond coverage: closes do not propagate (six bd-closed beads stayed open on GitHub at the v0.1.5 cut on 2026-05-13, manually closed via `gh issue close`); labels, sprint fields, body edits, and dependency edges do not sync after creation. The `bd-mirror` script accumulated mechanical friction (Sprint field GraphQL workaround, label auto-creation, agent-label fallback chain producing `agent:merge-plan@example.invalid`) that is symptomatic of the dual-system path being unmaintained beyond release pressure.

**The original privacy rationale does not hold in practice.** Captain reports the exploratory-leak concern is empirically not a problem on the mirrored beads to date, and the upside of public-by-default — *intentionality discipline at issue-create-time + open surface for community contribution* — outweighs the cost of losing the curated public boundary.

**The GitHub technical gap closed.** Sub-issues are now a first-class GraphQL surface on this repo (`subIssuesSummary`, `addSubIssue` mutation, native UI). The original "bd has parent/child epics, GH doesn't" argument from DR-2026-05-11-b no longer holds. Iteration fields (sprint), single-select fields (epic, status), and saved views were already strong enough; sub-issues closes the last semantic gap.

This decision retires bd as the issue-tracking substrate and collapses to GitHub-native, single-track.

## Decision

**Retire `bd` as the issue-tracking substrate. GitHub Issues + sub-issues + the "Jinn engineering" Project (v2) become the single source of truth for engineering issue tracking. The Dolt remote freezes as a read-only archive. No bulk migration of the existing open bead corpus.**

Concretely:

- **All new issues originate as GitHub Issues** on `Jinn-Network/mono`. No new beads created from 2026-05-18 forward.
- **Parent/child epic relations** use native GitHub sub-issues (`addSubIssue` mutation, native UI). The `epic:<short>` label convention retires.
- **Dependency / "blocks" edges** use GitHub's tracked-by / tasklist semantics where needed; first-class "blocked-by" remains a small expressivity loss documented as Open below.
- **Run-mode / shape** lives in a `## Run-mode` section in the Issue body (the existing convention) plus a `shape:<fix|feat|refactor|spike|chore|docs|test>` label set on the Issue at create-time.
- **Priority** lives on a `priority:<P0..P4>` label (existing convention on the mirrored Issues stays).
- **Sprint** stays on the Project v2 Iteration field (unchanged from DR-2026-05-11-b).
- **Epic** stays on the Project v2 single-select field (unchanged from DR-2026-05-11-b). Option descriptions stop carrying the bd id mapping.
- **Status** stays on Issue open/closed + the Project Status column (Todo / In Progress / In Review / Done) (unchanged).
- **"Ready queue"** = the Project's default view filtered by `Status=Todo` ∧ `no open tracked-by relationship`, surfaced by the `eng-day` skill which already queries via `gh project item-list` + `gh issue list`.
- **Issue templates** capture the Run-mode section + acceptance-criteria body shape so the *bd issue body convention* survives as a *GitHub Issue body convention*.
- **No bulk migration.** The 34 unmirrored open beads stay in bd-archive. If an agent picks one up, it gets a one-off `gh issue create` at pickup time and the bd issue closes. Most will close in bd as stale or no-longer-relevant during the agent canon rewrite (waxs.4 below).
- **Dolt remote freezes** as `bd-archive-2026-05-18`. The `.beads/` checkout stays in-tree as historical context. `bd` CLI stays installed for read-only lookups; the auto-export git hook decommissions so new bd writes do not pollute git state.
- **The `bd remember` / `bd memories` agent-memory primitive is out of scope** per the bead's explicit clause. We don't actively use it. If a replacement memory substrate is needed it lands as a separate spike.

## Rationale

Three reasons, in order of weight:

- **Drift is the steady state, not an exception.** 68% of open work invisible externally, mirror script printing "manual fix needed" on every Sprint write, six close-propagation failures in a single release cut. The dual-system path is unmaintained beyond release pressure; deferring the spike defers nothing but compounded cost. The original DR-2026-05-11-b claim "sprint-scoped mirror is cheap and reversible" is true in isolation; what is not cheap is the *labels / sprint / body / dep-edge / close* drift that accumulates between mirror invocations.
- **Public-by-default is a feature, not a cost.** Captain assessment: tracking issues in public makes us more intentional about what we file, and opens the surface to community contribution at the time the issue exists, not after Captain hand-publishes. The DR-2026-05-11-b "privacy is load-bearing" claim was a hypothesis; a month of mirrored use shows it was not the real constraint. This is consistent with the headless-brand posture in [`BRAND.md`](../../BRAND.md): the public surface *is* the engineering substrate.
- **The technical floor moved.** GitHub's 2025 sub-issues rollout closes the parent/child gap that was the strongest non-privacy argument for bd in DR-2026-05-11-b. Iteration + single-select fields were already strong enough. The remaining bd advantages — sub-second CLI latency, local-first, Dolt history — are real but small; the `eng-day` daily-brief skill already absorbs the per-day GH-query cost, and historical bd state continues to read fine through the archived `.beads/` checkout.

## Alternatives considered and rejected

- **Reaffirm DR-2026-05-11-b (status quo with the sprint-scoped mirror).** Rejected: 68% drift is not "occasional close-propagation gap"; it is the default state. The privacy argument that justified the dual-system is empirically not load-bearing.
- **Drop the mirror but keep bd internal-only.** Stop the Friday cron + retire `bd-mirror`; bd stays as the team CLI; GH Issues exist only when Captain hand-publishes. Cheaper and more reversible than full retire. Rejected because it addresses drift without addressing the *dual-system maintenance tax* that the bead names as the load-bearing concern. The dual-system cost compounds with every new bead regardless of mirror state. Also forfeits the intentionality + community-fixable upside of public-by-default.
- **Two-way sync (bd ↔ GH).** Rejected: dependency, body, status, label, and assignee drift are all real-time concerns; even a healthy bidirectional sync is more code than it produces value over single-track. Pure yak shave.
- **Bulk-mirror the 34 unmirrored open beads as part of retirement.** Rejected per Captain direction. Stale beads die in bd-archive; live work either gets picked up and `gh issue create`'d at that moment, or it was never going to ship. Bulk-mirror would re-publish exploratory framing without intentionality review — exactly the "low-fidelity content erodes the public surface" cost the original DR was guarding against.
- **Migrate to Linear / GitLab / Jira / etc.** Rejected: the `jinn-mono-2cl` umbrella commits to building-in-public on GitHub-native substrate (Issues, Discussions, Releases, Projects). Substrate-shopping is out of scope.

## Consequences

- **DR-2026-05-11-b is partially superseded.** The internal-SoR claim retires. The "GitHub Project (v2) is the canonical sprint surface" claim survives unchanged; bd→GH-mirror sections retire in favor of native GitHub Issue create.
- **The agent canon rewrites.** Highest-blast-radius surfaces:
  - `CLAUDE.md` references bd across the Daily entry point + Engineering handbook recap + Repository Structure. Rewrite.
  - [`docs/engineering/handbook.md`](../../docs/engineering/handbook.md) §Daily loop, §Weekly retrace, §Sprint surface, §Eight ratified AI workflow rules (rule 3 specifically) rewrite.
  - `.claude/skills/eng-day/SKILL.md` carries 16 bd references; rewrite to read from `gh issue list` / `gh project item-list` directly.
  - **Operator-local SessionStart / PreCompact hooks.** `.claude/settings.json` is gitignored (per the `.claude/*` ignore rule, with `.claude/skills/` excepted), so the `bd prime` hook many operators currently have configured cannot be removed via a tracked PR. The canon explicitly tells operators to remove `bd prime` from their local `.claude/settings.json`; cleanup is per-operator.
- **AI workflow rule 3 rewrites.** "bd-as-SoR, not `MEMORY.md`" → "GitHub Issues as single SoR" (the rule's name and intent change). The original rule's *don't-fragment-memory* sub-argument is orthogonal and out of scope.
- **Tooling delta:**
  - `scripts/bd-mirror` retires; relocate to `scripts/_archived/bd-mirror` for git history; do not delete.
  - `.github/workflows/friday-triage.yml` retires its mirror call. The Friday triage *idea* (Captain reviews candidate Issues for the upcoming Sprint) can survive as a labeling pass over open Issues — file as a follow-up bead/Issue if Captain wants the affordance.
  - `.github/workflows/release-notes-scaffold.yml` already reads closed PRs and aggregates per-Conventional-Commits prefix; verify it does not have a `bd close` read path that needs swapping.
  - `.github/workflows/changelog-mirror.yml` already reads the GitHub Release body; no bd coupling expected — verify.
- **No CI gate.** Nothing currently blocks merges on bd state; nothing needs adding or removing on the gate side.
- **External references continue to resolve.** PR descriptions, DRs, spec docs cite `jinn-mono-<id>` strings (e.g., `Closes jinn-mono-uy6v.5.1`). The `.beads/` checkout stays in-tree so `bd show <id>` reads the archived state for as long as historical lookup remains useful.
- **CLI ergonomic regression for agents.** `bd ready` (~ms local) → `gh search issues` / `gh issue list` (HTTP). The `eng-day` skill caches per-day; per-action `gh issue view <N>` calls multiply per session. Acceptable cost.
- **Public-draft pollution risk.** Without the mirror's curation gate, exploratory framing lands public at create-time. Captain assessment: this is the intent, not a cost — see Rationale. No special `draft:` label is mandated; if friction surfaces, file a follow-up.

## Migration plan

No bulk migration. Implementation children file beneath `jinn-mono-waxs` as GitHub Issues (not new beads):

1. **waxs.1 — Rewrite agent canon (highest priority).**
   - Rewrite `CLAUDE.md` Daily entry point + cross-cutting bd references.
   - Rewrite `docs/engineering/handbook.md` §Daily loop, §Weekly retrace, §Sprint surface, AI workflow rule 3.
   - Rewrite `.claude/skills/eng-day/SKILL.md` to drop bd reads.
   - Document the operator-local cleanup step (`bd prime` SessionStart + PreCompact hooks in `.claude/settings.json` are gitignored; each operator removes them locally).
2. **waxs.2 — Retire `scripts/bd-mirror` + friday-triage workflow.** Move script to `scripts/_archived/`. Update or retire the friday-triage workflow.
3. **waxs.3 — Verify release-notes-scaffold + changelog-mirror workflows are bd-free.** Sweep for any remaining `bd ` reads.
4. **waxs.4 — Close-or-port sweep of the 34 unmirrored open beads.** One pass: each bead either closes in bd (stale, no-longer-relevant, subsumed) or becomes a fresh `gh issue create` if Captain or an agent intends to pick it up.
5. **waxs.5 — Freeze the Dolt remote as archive.** Tag remote head `bd-archive-2026-05-18`. Disable the bd auto-export git hook to prevent further commits to `.beads/`. Add a one-line note in the repo README or handbook pointing at this DR for the rationale.
6. **waxs.6 — Issue templates.** Add Issue templates capturing the `## Run-mode` section + acceptance-criteria body shape so the convention survives.

Children file as GitHub Issues, parented to a top-level "Retire bd, single-track on GitHub" tracking Issue (created at DR-ratification time). The bead `jinn-mono-waxs` itself closes when the children land.

## Risk assessment

- **Historical reference resolution.** PR bodies, DRs, and specs cite `jinn-mono-<id>` strings; some external readers cannot resolve these. Mitigation: keep `.beads/` in-tree as the archive; reference DR-2026-05-18 from the handbook + README so external readers know `jinn-mono-<id>` strings index into the archived corpus.
- **Memory primitive loss.** `bd remember` / `bd memories` go cold. Confirmed unused per the bead and Captain. If agent-memory substrate becomes needed, file a separate spike. Risk: low.
- **Per-action CLI latency for agents.** `gh issue view <N>` HTTP cost on every `bd show <id>` equivalent. Mitigation: skills cache per-session where appropriate; daily brief absorbs the orientation cost. Risk: tolerable.
- **One currently-blocked bead** (`jinn-mono-vh74.2` per current state). The bd `blocked` state has no first-class GH equivalent; carries via label `blocked:true` or a `blocks-on:` tracked-by tasklist row if the bead ports to GH per waxs.4. Risk: small expressivity loss documented as Open below.
- **Tooling fan-out missed in the sweep.** Other workflows or scripts may read `bd` state that the sweep doesn't surface. Mitigation: waxs.3 explicitly enumerates the workflow sweep; any miss surfaces as a workflow error post-Dolt-freeze and gets patched in-flight.
- **External contributors and the new-issue surface.** Once `bd` retires, every external contributor lands on GitHub Issues without indirection. Existing Issue templates need to be reviewed for clarity (not a regression, but worth a pass).

## Open

- **First-class `blocked-by` semantic on GitHub.** Tracked-by and tasklists cover most uses but no clean "this Issue is blocked by this other Issue, do not surface in ready queue" primitive exists. Label convention `blocked:true` is fine for v0; revisit if friction surfaces.
- **Friday triage replacement.** DR-2026-05-11-b's friday-triage cron mirrored top-N priority beads into public Issues for the upcoming sprint. Under this DR there are no beads to mirror; if Captain wants a "candidate Issues for sprint" surface, the cron retargets to label open Issues with `sprint:candidate` for review. Decide at waxs.2 implementation time.
- **Dolt-archive longevity.** The `.beads/` checkout in-tree carries some size; at some future date it may be worth migrating to a tag-only branch or a separate `mono-archive` repo. Not urgent.
- **Issue template strictness.** Whether the `## Run-mode` section is template-required vs convention-only is a waxs.6 implementation decision.

## Status

Proposed by opus 2026-05-18 as the spike output for `jinn-mono-waxs`. Captain oak's input (bd privacy not load-bearing; intentionality + community-fixability of public-by-default; no bulk migration) was incorporated, and the DR was ratified by Captain oak on 2026-05-18. Implementation tracked under the umbrella GitHub Issue created at ratification; children waxs.1–.6 land as sub-issues of that umbrella.

Note on `.claude/settings.json`: the `bd prime` SessionStart + PreCompact hooks are operator-local (gitignored under `.claude/*`), so they cannot be removed via a tracked PR. Operators clean up their own settings; the canon (CLAUDE.md, handbook) documents that the hooks are no longer recommended.
