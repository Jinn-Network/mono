---
name: eng-day
description: Daily aggregator + human-attention router for Jinn engineering work — reads open GitHub Issues, open PRs, and the "Jinn engineering" GitHub Project (v2) board, and (in the autopilot era) splits work into what the autonomous dispatcher can handle vs what needs the operator's personal attention. Surfaces sprint progress against the upcoming Monday cut, a "Needs you" track (decisions / design / spikes / reviews / Discussion-anchored docs), an engine-queue summary (autonomous-ready count + dispatcher status), yesterday's shipped, and drift flags (canary status, done-but-open issues, non-buildable items in the ready queue, sprint age/bloat, stale PRs). Not a dispatcher — does not run `yarn autopilot` or invoke action skills; the operator picks from the brief. Triggers on "eng day", "morning engineering standup", "what should I do today", "what needs my attention", "daily eng check", "what's pending", "start of day engineering", "let's plan today's work", "plan my week", "engineering check-in", "what's next". Reads Issue Type via GraphQL (not `gh issue list --json issueType`, which fails), open PRs via `gh pr list`, and the board via `gh project item-list --limit 800`. Refuses to produce a plan if no active sprint exists (fail-loud). Per DR-2026-05-18 the prior `bd ready` / `bd list` reads are retired.
---

# Engineering day

The daily aggregator + **human-attention router** for Jinn engineering work. Run by the operator at the start of an engineering block. Reads operational state (open GitHub Issues, open PRs, the "Jinn engineering" Project board) and routes it: **what the autonomous dispatcher handles vs what needs the operator personally.** Not a dispatcher — surfaces the brief; the operator picks and invokes (or launches `yarn autopilot`) from it.

**Autopilot-era reframe.** With the autonomous engine (`packages/autopilot`, the Autopilot dispatcher) able to take a clean `feat`/`fix` from Todo → green draft PR unattended, the operator's daily question is no longer "what should I implement" — it's **"what needs *me*, that the engine can't do?"** So this brief leads with the **Needs-you** track (decisions, design, spikes, reviews, Discussion-anchored docs) and demotes autonomous work to an **engine-queue summary** the operator just keeps fed and running. That split is the point of the skill — it's how the operator plans the day *and the week* around their own attention.

Modeled on the `growth-day` skill — same Tier-A discipline, same drift-flag pattern, same fail-loud sprint precondition.

**Substrate note (2026-05-18):** Per DR-2026-05-18, the issue-tracking substrate is GitHub Issues + native sub-issues + the "Jinn engineering" Project (v2). `bd` is retired; the `.beads/` checkout stays in-tree as a read-only archive.

## Read first

- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md) §The shipping machine, §The shapes of work, §Sprint surface.
- [`CLAUDE.md`](../../../CLAUDE.md) — agent-canonical project guide.
- **Open Issues:** `gh issue list --repo Jinn-Network/mono --state open --json number,title,labels,assignees,createdAt,updatedAt --limit 300`. NOTE: **`gh issue list`/`gh issue view` cannot return `issueType`** (`Unknown JSON field: "issueType"`). Read the Issue Type — the shape source — via **GraphQL**: the search qualifier (`gh api graphql -f query='{ search(query:"repo:Jinn-Network/mono is:issue is:open type:design", type:ISSUE, first:60){ nodes{ ... on Issue{ number issueType{name} } } } }'`) or an aliased `issue(number:N){ issueType{name} }` query. The `## Run-mode` body section is a fallback only for pre-cutover issues.
- **Open PRs:** `gh pr list --search 'is:open draft:false' --json number,title,author,createdAt,updatedAt,reviewDecision,mergeable,isDraft`.
- **GitHub Project board:** `gh project item-list 1 --owner Jinn-Network --format json --limit 800`. **Use a limit above the item count** — the board exceeds 300 items, and a low `--limit` silently truncates and produces wrong sprint counts. Filter to the current `Sprint` iteration.

## Sprint precondition (fail-loud)

Refuses to produce a plan unless an **active sprint** exists = ≥1 board item with `Sprint = <upcoming-monday-date>`. No active sprint = declare one or take an explicit rest day.

**Declaring a sprint safely (read before touching iterations).** To *create* the Sprint iteration, use the Project **UI → Sprint field → "+ Add iteration"** button. **Never** create or edit iterations via `updateProjectV2Field` with `iterationConfiguration` — that mutation **full-replaces** the field config and **irreversibly clears every item's sprint assignment board-wide** (incident 2026-06-01; there is no undo). It also regenerates iteration IDs, orphaning all existing assignments. Assign issues to a sprint *only* with item-level `updateProjectV2ItemFieldValue` (`value:{iterationId:"<id>"}`, var typed `String!` not `ID!`). **Recommendation:** pre-create a quarter of future iterations once via the UI — then this fail-loud stops recurring weekly, the current-sprint pointer advances by date automatically, and you get planning runway.

## Autonomy triage (classify every ready item)

For each open/ready item, assign one lane. This is what makes the brief route attention rather than list tasks.

- 🤖 **Autonomous** — the dispatcher can take it unattended. Issue Type ∈ {`feat`, `fix`, `refactor`, `test`, `chore`}, **not** an epic/tracker, single-session-sized (Effort `Low`/`Medium`), `Status = Todo`, `Blocked-on = Nothing`, acceptance criteria present. Operator's only job: keep `yarn autopilot` running and unblocked.
- 👤 **Needs you** — requires the operator's judgment/input. Any of:
  - Issue Type ∈ {`design`, `spike`, `incident`} (decision / research / judgment);
  - **epic** (title `EPIC:` or has sub-issues) — needs decomposition, not implementation;
  - **tracker** (title `Tracker:`/`Tracking:`) — human-curated snapshots;
  - `docs` touching **canonical / Discussion-anchored** content (SPEC / PRINCIPLES / BRAND / GLOSSARY / a milestone / a Discussion #) — needs sign-off;
  - `Blocked-on = Human`;
  - `Effort = High` on a feat/refactor — usually needs decomposition into stacked sub-issues *before* it's dispatchable (else the shape-blind dispatcher produces a mega-PR);
  - **under-specified** — no acceptance criteria, or a "decision / open-question" marker — needs scoping before it can be dispatched.
- 🔍 **Review** (a Needs-you sub-lane, usually the biggest demand on operator time) — open PRs awaiting review. Per AI-workflow rule #4 **no agent self-merges**, so review is always human. The engine produces PRs faster than they're reviewed, so this queue grows — surface it prominently.

## Output shape

A five-section brief, **Needs-you first**:

1. **Sprint context** — window (Monday cut), days elapsed, % closed vs queued, and the **autonomy split**: `N 🤖 autonomous-ready · M 👤 needs-you · K 🔍 PRs in review`.
2. **Needs you today** (the operator's actual plan) — the top 👤/🔍 items, ranked: blockers → decisions/design/spikes → Discussion-anchored docs → under-specified-needs-scoping → the review queue (flag **engine-produced** PRs). This replaces the old "top-3 to implement" — those don't need the operator's per-item attention any more.
3. **Engine queue** (🤖, runs in parallel to you) — count of dispatcher-eligible issues + **dispatcher status**: is `yarn autopilot` running? is backpressure tripped (open ready PRs > cap)? what would it pick at the current `--cap`? The operator action here is *keep it fed/running*, not implement item-by-item.
4. **Yesterday shipped** — PRs merged in the last 24h (shape prefix + author; flag engine-produced), Issues closed.
5. **Drift flags** — surface only the active ones (below).

## How to assemble

1. Read state in parallel (commands in §Read first — Issue Type via **GraphQL**, board via `--limit 800`, + `gh release list --repo Jinn-Network/mono --limit 1 --json publishedAt,tagName` for the canary baseline).
2. **Classify** every ready item into 🤖 / 👤 / 🔍 (per §Autonomy triage). Join Project fields (Status, Priority, Effort, Blocked-on) by issue number.
3. Build **Needs you today** from the 👤/🔍 lanes, ranked: stale-PR-review-needed → sprint-blocker → decision/design/spike → Discussion-anchored docs → under-specified → other 👤. Tag each with shape + Effort. Cap ~3–5.
4. Build the **Engine queue** summary from the 🤖 lane (count by priority) + dispatcher status (probe `yarn autopilot --dry-run` reasoning: ready-Todo-unblocked-allowlisted count, backpressure vs open-PR count).
5. Compute drift flags. Format; output to terminal; **do not dispatch or run `yarn autopilot`.**

## Routing signals

- **Priority** — `P0`>`P1`>…; within a lane, ranks order. An off-sprint `P0` overrides the non-sprint cap.
- **Effort** — surfaced inline; also feeds autonomy triage (`High` feat/refactor → 👤 decompose-first).
- **Blocked on** — `Nothing` / `Human` / `Another issue`. Only `Nothing` is dispatch-eligible (🤖); `Human` is the explicit park-it-for-the-operator signal (and the safe way to keep non-buildables out of the dispatcher's reach); `Another issue` surfaces as a dependency. `Human`/`Another issue` blocked > 3 days → drift flag.

## Drift flags

Surface only the active ones:

- **Canary** publish broken on the most recent merge.
- **npm `latest` mismatch** — no Monday Release in 8+ days.
- **Stale PR** — open > 3 days without review activity.
- **Sprint age** > 7 days (Monday cut should reset weekly).
- **Sprint bloat** — sprint carries more than ~15 items (over-committed; the operator can't review that much engine output in a week — bias to fewer, higher-priority items).
- **In-Progress with no movement** — Project Status = In Progress, no commits / PR activity in 5+ days (cross-check the dispatcher's worktree drift).
- **Done-but-open** — an issue with a **merged** PR referencing it that is still `OPEN` (a `Closes #N` keyword was omitted — recurring trap that left #789/#809/#828/#827/#766 falsely open). Close it.
- **Designed-but-unimplemented** — a closed `design` issue with no merged implementation and no open implementation issue (e.g. #921→#923).
- **Non-buildable in the ready queue** — an epic / tracker / spike that is `Todo` + `Blocked-on = Nothing`. It reads as "ready" but the shape-blind dispatcher would waste a session on it — park it (`Blocked-on = Human`) or it'll be mis-picked.
- **Top item already in PR** — the highest-priority ready item already has an open PR (e.g. #912 had #933); flag so it isn't re-picked, and route it to the review lane instead.

## Failure modes

- **No active sprint.** Print: *No active sprint declared. Per docs/engineering/handbook.md §Sprint surface, add at least one Issue to the "Jinn engineering" Project (v2) with `Sprint = <upcoming-monday>` (create the iteration via the UI "+ Add iteration" button — never via the `iterationConfiguration` API), or take an explicit rest day.*
- **Project number mismatch.** Assumes project `1` on `Jinn-Network`. If `gh project item-list 1` errors or returns an unrelated board, run `gh project list --owner Jinn-Network --format json` to find the real number and surface it — don't emit a misleading "no sprint."
- **`gh` unauthenticated.** Print `gh auth login` + `gh auth refresh -s project`; don't block.
- **Board unreachable.** One-line note; fall back to the open-Issue queue alone.

## v0 vs v1

This is the v0 skill. v1 will: auto-detect the Project number; compute the suggested-semver bump (always-patch; minor on epic close); fully automate the autonomy classifier (currently heuristic — verify epics / canonical-docs by hand). Friction → file a GitHub Issue under the engineering-handbook umbrella.

## Composition

- Composes with `growth-day` at the operator's invocation level only (no shared state).
- Composes downstream with the action skills it lists but does not invoke (`brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `requesting-code-review`, …).
- **Autopilot dispatcher (`packages/autopilot`, `yarn autopilot`)** reads the *same* ready definition this skill uses (`Status = Todo` + `Blocked-on = Nothing` + author-allowlist). So eng-day's drift flags double as dispatcher hygiene, and the 🤖/👤 split mirrors what the dispatcher will/won't pick. eng-day only *surfaces* the engine queue + status — the operator runs `yarn autopilot` separately. Keep non-buildables out of the dispatcher's reach by setting `Blocked-on = Human`.
- **PR-vs-issue caution.** When triaging or before closing anything as a duplicate, verify the object's `__typename` via GraphQL — an implementation **PR** can look like an issue by title; closing it as a "duplicate issue" discards real work (incident 2026-06-01).
- Composes with the Friday triage flow (handbook §Weekly retrace).
