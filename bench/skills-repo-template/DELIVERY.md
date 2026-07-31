# Delivery template — GitHub-issue body

**Delivery is a human action.** This tooling renders `report.md`, `card.svg`, and `badge.svg` into
`reports/<skill>@<sha>/`; nothing in the rig opens an issue, posts a comment, or otherwise reaches
into someone else's repository. The person delivering a report — filling in this template and
posting it — is responsible for what it says and where it lands, the same as posting any other
issue on a repository they do not own.

Fill in the placeholders, paste the result as a new issue on the skill's own repository, and
confirm every link resolves before posting.

---

## Issue title

```
Capability report: <skill>@<sha> — <one-line finding, not the flat number>
```

Use the report's own title line (`report.md`'s `# ` heading) — it already leads with the diagnosis,
not the number, per the null-variant framing in
`docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md` §6.1.

## Issue body

```markdown
[![jinn capability card: <skill>](<card-url>)](<report-url>)

<paste report.md's body here, starting at "## Opener">

---

Rendered by [Jinn](https://jinn.network), an open agentic knowledge economy. This report, its raw
data, and the command to reproduce it are public at <report-url>.
```

`<card-url>` and `<report-url>` come from `embed.md` in the same evaluation directory —
`render-report.ts`'s `--base-url` argument, not a URL assembled by hand. Use a raw-content or Pages
URL (a GitHub "blob" URL serves an HTML page, not the image, and the card will not render).

## Before posting, confirm

- The card image renders as an image, not a broken link, when you preview the issue body.
- `report.md`'s title and opener match what you are about to post (a rendered report is
  immutable once written, but re-check the file did not get edited by hand after render).
- If this is a re-evaluation, the issue references the prior report (`<skill>@<old-sha>`) and states
  what changed, per `docs/runbooks/skills-bench.md` §9.
- You are prepared for the author, or anyone reading the issue, to disagree publicly with the task
  selection — everything is public and reproducible, so an objection is answered by rerunning the
  rig, not by editing the report.

## What this template does not decide

Whether to post unsolicited, or to notify the author privately first and give them a window before
the issue goes up, is a judgment call for the person delivering, made case by case. Nothing in the
rig gates on it — the report is public by construction the moment it exists in this repository,
independent of whether or when it is delivered as an issue.
