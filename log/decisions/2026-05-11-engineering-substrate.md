---
id: DR-2026-05-11-b
title: Engineering substrate — bd as internal SoR; GitHub Projects (v2) as the public sprint surface; sprint-scoped bd→GH-Issue mirror
date: 2026-05-11
verb: Choose
status: proposed
authors: opus (proposed), oak (Captain attached)
spec: docs/superpowers/specs/2026-05-11-engineering-handbook-codesign.md (this design)
supersedes-context-from: (none — establishes substrate)
---

## Context

The 2026-05-11 backlog narrowing pass promoted jinn-mono-2cl (engineering handbook v1) from P2 decision to P1 task. The umbrella body locks the cadence (auto-canary on every merge to main; Monday named-minor release with build-in-public devlog) and lists nine AI workflow rules. It defers two structural picks to a co-design with the v1 release epics: (i) what container holds the weekly sprint, and (ii) how that container relates to bd, the existing internal issue tracker.

The handbook also commits to a *building-in-public substrate* — GitHub Projects (v2) for the public roadmap, public Issues with templates, GitHub Releases + auto-generated notes as the devlog, repo-as-docs, and GitHub Discussions for RFCs/Q&A through Phase 2. That commitment leaves the bd-vs-GitHub boundary ambiguous: is bd sunset in favor of GitHub Issues, mirrored to GitHub Issues, or kept as a private parallel tracker?

This decision picks the boundary.

## Decision

**bd remains the internal system of record. GitHub Projects (v2) is the public sprint surface. The bridge is a sprint-scoped one-shot mirror: when (and only when) a bd issue is pulled into an upcoming sprint, it is mirrored to a public GitHub Issue and added to the Project board.**

Concretely:

- All engineering work originates as a bd issue. Backlog, drafts, exploratory needs-design-session bodies, and not-yet-scoped items live in bd only and are not visible publicly.
- A single GitHub Project (v2) on `Jinn-Network/mono`, named "Jinn engineering", is the canonical sprint surface. Columns: Open / In Progress / In Review / Shipped. Custom fields: `Sprint` (date of the upcoming Monday cut) and `Epic` (one of `uy6v` / `8psp` / `jnw9` / `9iq3` / `2cl`, expandable as new epics file).
- The default view is the current sprint's Status board. A secondary Roadmap view groups all open items by Epic in Now / Next / Later columns.
- When a bd issue is pulled into the upcoming sprint, a small helper (jinn-mono-2cl.12 `bd-mirror` script) opens a public GitHub Issue with a curated subset of the bd body, applies labels (`epic:<id>`, `sprint:<date>`, `agent:opus`/`codex`/`human` for ownership), adds the Issue to the Project board, and sets `Sprint = <next-monday-date>`. The Issue body ends with `Internal tracking: jinn-mono-<bd-id>`.
- A Friday cron (jinn-mono-2cl.11) auto-mirrors the top-N priority bd issues (default: all P0, capped P1) for the upcoming sprint. Captain reviews on Friday and **rejects** anything that doesn't belong (close the Issue, remove the sprint label). Captain adds Issues by exception only. The default flow is reject, not select.
- On PR merge, the linked Issue closes automatically; Project automation moves it to Shipped.
- bd issue close (`bd close <id>`) is the SoR signal that work is done. The Project mirror moves on PR-merge automation; the bd close is the canonical record.
- The daily brief skill `eng-day` (jinn-mono-2cl.8) reads the Project board state via `gh project item-list`, joins with `bd ready` and `gh pr list`, and surfaces a top-3 guidance line for the Captain. The skill does not auto-dispatch.

## Rationale

Three reasons, in order of weight:

- **bd's privacy is load-bearing.** bd issue bodies frequently contain exploratory `needs-design-session` framing, half-formed acceptance criteria, captain-internal notes, and references to runbooks that are not appropriate for an external audience. Forcing all of bd public would either (a) cause Captain to self-censor in bd and lose the exploratory cheapness, or (b) publish low-fidelity content that erodes the public surface's signal. Keeping bd private preserves the cost-of-thought advantage; mirroring only when scope-locked keeps the public surface curated.
- **GitHub Projects already won on visibility.** The 2cl umbrella commits to building-in-public; GitHub Projects (v2), Issues, and Releases are the substrate every external contributor and AI agent already knows. A private bd UI would have to compete with that, and bd's value is the CLI ergonomics, not its UI. Splitting roles — bd for CLI-driven work, Projects for the public board — uses each tool's strength.
- **Sprint-scoped mirror is cheap and reversible.** A one-shot bd → GitHub Issue creation script (`bd-mirror`) is ~30 lines. If the boundary later shifts (e.g., toward all-bd-public or all-GitHub-only), the script's call sites are a single cron + manual one-shots. Reversibility cost is low.

## Alternatives considered and rejected

- **Sunset bd; move all engineering to GitHub Issues + Projects.** Rejected for v1: bd's CLI ergonomics (`bd ready`, `bd remember`, `bd memories`, parent-child epics, sub-day pivots) are the daily-loop substrate; replacing them mid-release would slow uy6v's path to public testnet. May revisit after Phase 2.
- **Mirror every bd issue to a GitHub Issue automatically.** Rejected: floods the public surface with exploratory bodies; defeats the curation that makes the Project board useful; leaks pre-design state to external readers.
- **Keep bd entirely private and rely on Releases as the only public surface.** Rejected: the 2cl umbrella's building-in-public commitment is explicit, and Releases alone are a lagging artifact — visible only after work ships. Public Issues + Project make in-flight work legible, which is the substrate the BRAND.md headless-brand posture rests on.
- **Use GitHub Milestones instead of Projects.** Rejected: Milestones are flat per-repo collections with limited views and no custom fields. Projects (v2) supports the Sprint + Epic fields and the Roadmap secondary view that this design needs.

## Consequences

- **bd** continues unchanged as the internal SoR. No data migration. The Friday cron and `bd-mirror` helper read from bd but do not write to it.
- **GitHub Projects (v2) board** must be created at jinn-mono-2cl.9 implementation time, with the Status / Sprint / Epic schema and the two views (current sprint Status board + Roadmap grouped by Epic).
- **PR template** (jinn-mono-2cl.3) gains a checkbox for "linked bd id" — written into the PR body as `Closes jinn-mono-<id>` so merge auto-closes the mirrored GitHub Issue.
- **CONTRIBUTING.md / handbook** (jinn-mono-2cl.5 / 2cl.4) documents the mirror flow so external contributors know the public Issue's `Internal tracking:` footer points to private bd state they cannot read; the handbook also documents what they *can* expect (Issue body is sufficient context to file a PR).
- **`eng-day` skill** (jinn-mono-2cl.8) implementation reads Project state via `gh project item-list`; the GitHub CLI requires a Project-scope PAT or fine-grained token. Document the auth setup once at skill author time.
- **Discoverability** for external contributors: the GitHub Project board is the canonical "what is being worked on right now" surface; the Releases page is the lagging "what shipped" surface; GitHub Discussions is the RFC / Q&A surface. bd is invisible to them by design.
- **Cost of misalignment**: if the Friday cron mirrors something Captain later rejects, the public Issue is closed within hours — minor noise. If Captain forgets to mirror a piece of work, it ships without a public surface footprint; the Release notes will still cite the PR and closed bd issues. Loss is graceful.

## Open

- **2cl.11 cron threshold.** Top-N defaults to "all P0 + capped P1." The cap value is itself open. Starting heuristic: 8 Issues per sprint; calibrate after two sprints.
- **Mirror script location.** `cargo/scripts/bd-mirror` (shell or TypeScript) — decide at 2cl.12 implementation time.
- **bd → Project sync direction.** This decision specifies write-only from bd to Project (via the mirror at sprint-pull time). If `bd close <id>` should also update the Project state directly (e.g., move the Project item to Shipped before PR merge auto-closes the Issue), that's a future optimization, not v1.
- **Public-Issue body curation.** What gets stripped from the bd body when mirroring (captain-internal notes, references to private runbooks, exploratory framing) is a per-issue judgment today. A template or strip-rule may emerge; 2cl.12 implementation captures whatever pattern Captain finds useful.

## Status

Proposed by opus 2026-05-11 as the engineering-substrate decision paired with `docs/superpowers/specs/2026-05-11-engineering-handbook-codesign.md`. Ratification by Captain oak gates promotion to status=ratified.
