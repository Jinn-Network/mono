# Jinn skills-eval — capability reports

Reproducible, paired measurements of publicly published agent skills. No skill lives here — the
skill stays the author's, unforked, wherever it already is. This repository holds only the
reports.

| Skill | Sha | Measured | Net | Report |
|---|---|---|---|---|
<!-- one row per reports/<skill>@<sha>/, generated from the reports index, never hand-written -->

## What a capability report is

A capability report (`reports/<skill>@<sha>/report.md`) is a paired comparison: the skill's author
publishes it, but the number comes from a domain-matched task set, a no-skill baseline, a pinned
agent configuration, and a deterministic verifier — all included in `data/` next to the report, and
all rerunnable with the command the report prints. A capability report is public evaluation, not
certification: the `jinn.receipt` / `jinn.receipt-sha256` metadata keys a skill's frontmatter
carries are pointers to this report, never proof by themselves. Re-run it, or disagree with the
task selection and build your own.

Each report also states the skill's **trigger rate** — whether it actually loaded during the
measured attempts, distinct from whether it changed the outcome. A null result with a low trigger
rate reads as *not exercised on this task set*, never as *no effect*; the report says which one
happened.

Every author also receives a private annex, delivered directly and never published here: a
per-failure-mode diagnosis (never triggered, triggered but vague, triggered and harmful) and
suggested edits. The annex is how the number moves; the report is only the receipt of where it
stood.

## How to read one

Start with the fenced summary block at the top of `report.md` — baseline and with-skill resolve
rates, the paired delta, the Wilson interval, and the trigger rate. The per-task table below it
breaks the same numbers out by task and repeat. `data/` holds the exact attempts log, run manifest,
and task set the report was computed from; `rig/` points at the code that computed it.

## Requesting an evaluation or re-evaluation

Open an issue against [`Jinn-Network/mono`](https://github.com/Jinn-Network/mono) naming the skill
and its repository. If you've already been measured and have since revised the skill, name the
commit or tag of the revision — re-evaluation runs on tasks the prior diagnosis was never derived
from, never on the tasks that produced it.

## Versioning

A new measured commit (sha) of a skill gets a new `reports/<skill>@<sha>/` directory. Nothing here
is ever overwritten, so a report and the exact skill version it measured stay permanently paired.
`jinn.receipt-sha256` in the skill's own frontmatter is a hash of the report file it points at — if
the skill's author publishes a newer sha without a matching new report directory here, the badge
and the metadata go stale and `jinn.receipt-sha256` no longer matches, which is how a stale badge is
detected.

Published by [Jinn](https://jinn.network), an open agentic knowledge economy.
