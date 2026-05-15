- **Date:** 2026-05-08
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1

## Motivation

GROWTH §5 *Engage* names the closing structure for an engaged operator: *objective → why important → blockers → three ways in (full operator, light operator, advisory steward) → walk through plan*. The three named paths are all operator-flavoured; the trailing line *"Read the specs, run the client, open a PR or an issue"* implies a contributor path but does not name it.

The 2026-05-08 standup made the contributor path explicit as an intentional second route (operator route + maintainer route), with Oak committing to seed `good-first-issue`-shaped tasks against the repo so the maintainer path becomes a real, low-friction on-ramp pickable by Claude. §7's *Contributors* supporting metric (PRs / issues / forks from non-team) already canonises the conversion shape; §5's closing structure has lagged it.

This is a tightening, not a new direction. The change makes §5's closing structure consistent with §7's metric and with how the network is actually being recruited into right now.

## What this proposal changes

### §5 Engage closing structure: three ways in → four ways in

`three ways in (full operator, light operator, advisory steward)` becomes `four ways in (full operator, light operator, contributor, advisory steward)`.

**Contributor**, in this list, is the path Oak named in the 2026-05-08 standup: someone who picks up a `good-first-issue` (or files one) against `Jinn-Network/mono` without necessarily running a client. Claude-pickable scope is intentional — the path's load-bearing property is that the friction-to-first-merged-PR is low enough for the recruit to act in the same conversation that closes the engagement.

The four-rung warm-contacts ladder (cold / touched / warm / hot, plus parking) is unchanged. The funnel-path line — *first contact → reply → DM → call → operator → contributor* — is unchanged; *contributor* there already named the same conversion shape, but as a downstream state of *operator*, which conflates two distinct entry routes. The closing-structure list is the canonical site of the explicit four-way enumeration.

### Operational consequences

- **`growth-day` Engage tier-A surface** — when a candidate's profile pattern-matches the maintainer path more cleanly than the operator path (active OSS coding-agent contributor with no infra footprint signal, vs. running-things-already signal), the day's recommended ask shifts from "run the client on testnet" to "pick up issue #N." The skill does not need an immediate code change; it consumes §5's enumeration as today.
- **Issue-list seeding** — Oak commits to seeding a small set of `good-first-issue`-shaped tasks against `Jinn-Network/mono` so the path is real, not nominal. The seeded issues are listed in `growth/.local/growth-log.md` §3 once filed; they are not load-bearing on this canonical change.
- **`discover-twitter-recruits`** — the cluster-vocabulary file already encodes a *maintainer-vs-operator sub-rule* (per `2026-05-07-growth-cluster-tightening-coding-agents.md`). That rule is consistent with this change; no skill-side edit is required.

## What this proposal does not change

- §3 cluster handle and definition (locked 2026-05-07 to *open-source coding agent contributors*).
- §3 pitch (umbrella + swe-rebench v2 instance, locked 2026-05-07).
- §4 Phase 1 transition trigger.
- §5's other functions (Understand, Teach, Refine).
- §6 — neither permanent rules nor tactical deferrals are touched.
- §7 metrics — the *Contributors* supporting metric already names this conversion shape; this proposal makes §5 consistent with §7, not the other way around.
- §8 channel canon, §9 sprint discipline.

## Rollout

Single-PR change-set:

- This spec at `spec/2026-05-08-growth-engage-fourth-way-in-contributor.md`.
- `GROWTH.md` §5 *Engage* closing-structure line: three ways in → four ways in (contributor inserted between *light operator* and *advisory steward*).

No skill-file edits in this PR. The next time `growth-refine` runs against Sprint #3 evidence, it can decide whether the contributor path needs further structural support beyond what §5 names.

## Open questions

- **Repo-scoped vs network-scoped contribution.** This proposal scopes *contributor* to `Jinn-Network/mono` PRs / issues. A future SolverNet may surface a parallel contribution shape — submitting evaluation rubrics, harness configs, or task seeds against a SolverNet's manifest CID rather than against the mono repo. Whether that's a fifth path or a sub-shape of *contributor* is deferred until at least one SolverNet is operational and we observe the natural shape of those contributions.
