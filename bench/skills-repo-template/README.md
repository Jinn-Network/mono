# Skills, measured.

Agent skills with receipts: every skill in this repository links a benchmark
receipt — a paired comparison against a no-skill baseline (and, for forks, the
upstream original) on pinned real-world software tasks, with the raw per-task
results and the rerun script alongside.

| Skill | Receipt | Measured against | Net |
|---|---|---|---|
<!-- one row per published skill; generated from receipts/SUMMARY.md, never hand-written -->

## Install

    npx skills add Jinn-Network/skills

## What a receipt is — and is not

A receipt is a reproducible measurement: pinned task list, pinned agent
configuration, raw outcomes, rerun script (`rig/`). It is not a certification.
The frontmatter `metadata` keys (`jinn.receipt`, `jinn.receipt-sha256`) are
pointers to the receipt, never proof by themselves — re-run it, or disagree
with the task selection and swap your own.

Skills forked from upstream authors keep their license and attribution; the
receipt records the upstream commit measured against, and improvements are
offered back as PRs.

Published by [Jinn](https://jinn.network), an open agentic knowledge economy.
