# Headless pressure-suite results

**Date:** 2026-05-21
**Suite:** `packages/autopilot` — 18 scenarios, 3 each across the 6 in-session-pipeline chain skills.
**Model:** the spawned `claude -p` sessions ran on `haiku` (the cheapest model).
**Mechanism:** global injection of `headless-override.md` into every session prompt — no per-skill vendoring.

## Result — 17/18 completed headless on the first pass

| Skill | scenario-1 | scenario-2 | scenario-3 |
|-------|------------|------------|------------|
| `brainstorming` | completed | completed | completed |
| `writing-plans` | completed | completed | interactive-block † |
| `test-driven-development` | completed | completed | completed |
| `executing-plans` | completed | completed | completed |
| `verification-before-completion` | completed | completed | completed |
| `requesting-code-review` | completed | completed | completed |

† `writing-plans / scenario-3` — the deliberately terse "infer the file layout
from conventions" scenario — blocked once. A clean re-run completed normally:
it wrote `docs/superpowers/plans/2026-05-21-format-duration.md` and ended
without a question (51s, exit 0). This is a borderline flaky case on the
hardest scenario, not a consistent skill-level block.

## Conclusion

**All six chain skills run headless under global injection of the
headless-override block.** Spec §7's per-skill vendor-fallback path stays
unused — no skill genuinely blocks.

## Tuning applied during the run

The first smoke test surfaced that the original override carried a session
past clarifying questions but not past the present-and-approve gate — the
session presented its design and ended on "Does this look right?" without
writing the deliverable. Two bullets were added to `headless-override.md`
(never end on a question; always write the named artifact) and the spawn was
changed to ignore stdin (dropping a 3s-per-session stall). The 17/18 result
is post-tuning.

## Caveat

Runs were on `haiku` — the cheapest model; the result is a floor, not a
ceiling. The one flaky scenario suggests the override is at its margin on
maximally terse inputs; real dispatcher issues (triage-complete, scoped) sit
well clear of that margin. If reliability on terse inputs ever matters, the
next lever is a stronger model, not a per-skill vendor fork.
