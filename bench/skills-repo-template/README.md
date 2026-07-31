# Jinn skills-eval — capability reports

Reproducible, paired measurements of publicly published agent skills. No skill lives here — the
skill stays the author's, unforked, wherever it already is. This repository holds only the
reports, and everything in it is public.

| Skill | Sha | Measured | Net | Report |
|---|---|---|---|---|
<!-- one row per reports/<skill>@<sha>/, generated from the reports index, never hand-written -->

## What a capability report is

A capability report is three artifacts, one identity — every one pinned to `<skill>@<sha>`, where
`sha` is the short form of the skill's resolved upstream commit (`pin.json`'s `commit`, not a
branch):

- **`badge.svg`** — a small, three-axis SVG: `[ jinn ][ <effect> ][ loads x/n ][ <±cost>% ]`. Meant
  for the author's own README.
- **`card.svg`** — a larger SVG that carries the numbers: identity and date, what was evaluated,
  the three metrics, a cohort line when one was measured, and the honesty footer. **The card is
  where the figures live.**
- **`report.md`** — narrative only. It does not repeat the card's numbers; it states the paired
  outcome in words, the trigger-rate diagnosis, any conditional pattern (labelled hypothesis, not
  finding), scope, and how to reproduce or request a re-evaluation.

Both `badge.svg` and `card.svg` are self-contained images, not markup — GitHub issues strip HTML
and CSS, so a card built as markup could not render where it is delivered (see `DELIVERY.md`).

None of the three is certification. The `jinn.receipt` / `jinn.receipt-sha256` metadata keys a
skill's own frontmatter carries are pointers to the report here, never proof by themselves. Re-run
it with the command `report.md` prints, or disagree with the task selection and build your own.

## How to read one

**Start with the card.** It carries every number: tasks solved (baseline versus with-skill), how
often the skill loaded, and the cost overhead — each with the honesty caveat (`n=<n>, intervals
overlap — direction, not proof`) on its face. Then read `report.md` for the narrative: what the
paired outcome means in plain language, where the skill did or did not load, and what — if
anything — a revision might change. The per-task table lives at `data/per-task.md`, not in the
report body, so the narrative stays short while the run stays fully reproducible. `data/` also
holds the raw attempts log, run manifest, and task set the numbers were computed from; `rig/`
points at the code that computed them.

**Trigger-rate honesty rule.** Every report distinguishes "the skill made no difference" from "the
skill never loaded on these tasks." When the trigger rate is low, both the card and the report
render **not exercised on this task set** — never *no effect*. A null result only reads as *no
effect* when the trigger rate is high enough that the skill actually had its chance.

**Immutability rule.** A revised skill gets a new resolved commit and therefore a new `<sha>` —
never an update to an existing `reports/<skill>@<sha>/` directory. Nothing here is ever
overwritten, so a report and the exact skill version it measured stay permanently paired. If a
skill's frontmatter later points `jinn.receipt` at a newer sha than any report directory here, the
badge is stale; `jinn.receipt-sha256` is a hash of the report file the pointer names, so a stale
badge is mechanically detectable — recompute the hash of the report at the sha the badge claims and
compare.

## Requesting an evaluation or re-evaluation

Open an issue against [`Jinn-Network/mono`](https://github.com/Jinn-Network/mono) naming the skill
and its repository. If you've already been measured and have since revised the skill, name the
commit or tag of the revision — re-evaluation runs on tasks the prior diagnosis was never derived
from, never on the tasks that produced it.

## Hosting

Artifacts here are served as static files: `raw.githubusercontent.com` links, or a GitHub Pages
build over this repository, resolve `badge.svg`, `card.svg`, and `report.md` directly. There is no
service in front of them and no `reports.jinn.network` endpoint today — that domain is a possible
future CNAME over the same static files, not a live service, and nothing here should be read as
implying one exists.

## Layout

```
reports/<skill>@<sha>/report.md     narrative report — no figures, see "What a capability report is"
reports/<skill>@<sha>/card.svg      the numbers — identity, three metrics, cohort line, honesty footer
reports/<skill>@<sha>/badge.svg     small three-axis badge — the distribution artifact for READMEs
reports/<skill>@<sha>/rank-badge.svg  optional — cohort rank, only when a niche cohort was measured
reports/<skill>@<sha>/embed.md      badge + card embed snippets, report link, jinn.* metadata block
reports/<skill>@<sha>/data/         pinned task set, run manifest, raw per-task results, per-task.md
rig/                                the orchestration script — open, so reports are reproducible, not claimed
README.md                          reports index (skill, sha, date, headline delta) — generated, never hand-written
DELIVERY.md                        template for the GitHub-issue body used to hand a report to its author
```

`reports/.example/` shows the shape with no live content — copy it, do not commit to it directly.

## Versioning

A new measured sha for a skill gets a new `reports/<skill>@<sha>/` directory. Nothing here is ever
overwritten, so a report and the skill version it measured stay permanently paired.

Published by [Jinn](https://jinn.network), an open agentic knowledge economy.
