# `.example` — placeholder, not a report

This directory is not a measured skill. It exists so the layout under `reports/` is unambiguous
before any real report is committed. When the first real evaluation lands, this directory stays —
it documents the shape new evaluations follow, it is never renamed into a real `<skill>@<sha>`
directory.

A real evaluation directory is named `reports/<skill>@<sha>/`, where `<skill>` is the pinned skill's
`name` (`pin.json`, which must equal the run's treatment-arm name) and `<sha>` is the short
(8-character) form of its pinned upstream commit — for example `reports/tdd@a1b2c3d4/`. It is
produced in one pass by
`client/scripts/skills-bench/render-report.ts` and contains:

```
report.md      narrative report — no figures (see the repo README's "What a capability report is")
card.svg       the numbers — identity, three metrics, cohort line, honesty footer
badge.svg      small three-axis badge, meant for the author's own README
rank-badge.svg optional — cohort rank badge, present only when a niche cohort was measured
embed.md       badge + card embed snippets, report link, jinn.* metadata block
data/          attempts.jsonl, bench-manifest.json, set.json, per-task.md (and transcripts/ if opted in)
```

Nothing in a real evaluation directory is ever edited or overwritten after it is committed. A
revised skill measures as a new commit, and a new commit gets a new `<sha>` and therefore a new
directory alongside this one — never a change to an existing one.
