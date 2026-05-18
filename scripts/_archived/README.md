# Archived scripts

Tooling kept for historical reference after retirement. The scripts here are not invoked by current CI and are not maintained — they exist so the git history reads as a renamed-not-deleted change for tools whose surface still has consumers in archived references (DRs, old PRs, etc.).

## `bd-mirror`

Retired by DR-2026-05-18 / waxs.2 (PR `chore/waxs.2-retire-bd-mirror`). The helper mirrored `bd` issues to GitHub Issues + the "Jinn engineering" Project (v2) under the dual-substrate model from DR-2026-05-11-b. Since `bd` retires as the issue-tracking substrate (DR-2026-05-18), the mirror has no upstream and the script is no longer invoked. The Friday triage workflow (`.github/workflows/friday-triage.yml`) that wrapped this script is deleted in the same PR.

See `log/decisions/2026-05-18-bd-vs-gh-substrate.md` for the substrate change and rationale.
