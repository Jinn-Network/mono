# Skills, measured. — product pitch (draft)

- **Date:** 2026-07-30
- **Status:** draft copy for review; not published
- **Audience:** a technical reader who installs agent skills and has never heard of Jinn
- **Design:** [`2026-07-30-skills-factory-mvp-design.md`](2026-07-30-skills-factory-mvp-design.md)
- **Voice:** per [`BRAND.md`](../../../BRAND.md) — lead from the gap and the construction, antagonist
  appears once, plain speech, no emoji. Jinn framed as "an open agentic knowledge economy" per
  CLAUDE.md §External Communication.
- **Claim discipline:** no results are asserted; the receipt example is a labeled format with
  placeholders, never shaped numbers that could be screenshotted as findings.
- **Destination:** README intro for the public skills repo, and the basis for launch copy.

---

# Skills, measured.

Agent skills are how coding agents get better right now. A skill is a markdown file of procedural
knowledge — how to run test-driven development, how to approach a refactor — that an agent loads
when a task calls for it. You install one with `npx skills add owner/repo` and it works across
Claude Code, Cursor, Codex, and most other agents. The main registry indexes tens of thousands of
them and ranks them by install count, and the top handful have over half a million installs each.

Install count measures popularity. Nothing measures effect. Every skill on those leaderboards is
an opinion document — often a good one, written by someone experienced — but no one has checked
whether installing it makes an agent better at real work, or worse.

We publish skills with receipts. Here is exactly what that means.

## How the measurement works

**The tasks are real bugs.** We draw from a pool of real GitHub issues in real open-source
repositories, each paired with the commit that fixed it and the project's own tests. An agent gets
the repository at the broken commit and the issue text. It's solved if the project's test suite
passes afterward — not judged by a model, not scored for style. Binary, and checked in a
container.

**We screen the tasks before using them.** Instances that no agent can solve, and instances every
agent solves, measure nothing. We keep the band in between, where a skill has room to make a
difference, and pin that list — about thirty tasks — to a file in the repo.

**We split the list in half and seal one half.** One half is what we tune against. The other is
opened once, at the end, to produce the published number. Nothing that gets iterated on ever
touches the sealed half, because a benchmark you optimized against stops being a measurement.

**Each skill is one arm of a controlled comparison.** For every task we run the same agent, same
model, same version, in a fresh isolated environment — once with no skill installed, and once per
skill under test. The only thing that varies between arms is the skill file. Same task, same
agent, different skill: that's what makes the difference attributable.

**The comparison is paired, per task.** We don't compare two averages. We look at each task
individually — the baseline solved it and the skill didn't, or the reverse, or both agreed — and
count the disagreements. That's what produces an honest interval instead of a headline. Thirty
tasks is a small sample and the intervals will be wide; the receipt says so rather than rounding
the uncertainty away.

## What a receipt contains

Every published skill carries one. The shape, with the fields that matter:

```
skill:      <name>, forked from <upstream>@<commit>
measured:   <N> screened tasks, sealed half, opened once
agent:      <agent CLI + version>, <model>, one pinned configuration
result:     baseline resolved <a>/<N> · with skill resolved <b>/<N>
            difference <d> tasks, 95% interval <lo> to <hi>
scope:      one agent configuration, one benchmark, this task list
files:      per-task outcomes, run manifests, full agent transcripts, rerun script
```

*(Format, not results — nothing is published yet.)*

**The receipt lives next to the skill, not inside it.** A skill file has a strict budget: its
name and description load into your agent's context at startup, every session, and the
description is what the model matches your request against to decide whether to use the skill.
Filling that with benchmark claims would cost you tokens on every session and make triggering
worse. So the skill stays clean guidance, and its metadata carries a pointer — the receipt URL,
its hash, the date measured, the upstream commit it was forked from — to a file in the same
repository, alongside the pinned task list, the raw per-task results, the full transcripts, and
the script that produced them.

That's deliberate, and it's the honest version. A metadata field claiming "benchmarked" is an
assertion; anyone can write one. The receipt is only worth something because you can re-run it,
disagree with our task selection, and swap it for your own.

## How a skill actually gets better

The failing runs are the instructions. When a skill loses a task the baseline won, the agent's
transcript shows which of three things happened: the skill never triggered, because its
description didn't match the task; it triggered but was too vague to change what the agent did;
or it triggered and made things worse — a testing skill that spends the whole budget writing
tests before understanding the bug, for instance.

That reading produces specific edits, not a rewrite: sharpen the trigger description, add
guidance for the failure class we just watched, delete the advice that misfired. We write several
variants that way, run them all against the tuning half, keep the one that wins, and repeat two
or three rounds. Then the winner gets one run against the sealed half, against the original, and
that's the receipt.

If it doesn't beat the original, we don't publish it as an improvement. We publish the finding —
that this skill couldn't be improved by this method — and move to the next target. Most attempts
to distill knowledge into skills don't help; our own earlier pilot came back null. A publishing
pipeline that can only produce good news isn't measuring anything.

## What ships first

The first release measures skills we didn't write: the most-installed coding-workflow skills on
the registry, each against a no-skill baseline, on the same task list. That table doesn't exist
anywhere. Then we fork whichever one the evidence says has room, and publish the fork with
attribution up front and the improvement offered back upstream.

Install is one command from the registry you already use.

## Where this goes

Every run leaves a full record — the task, the configuration, the transcript, the verdict. That
record is the raw material for the next improvement: after enough of them, you're not reasoning
about a skill from a handful of failures, you're reasoning from thousands of attempts across many
agents and models. Right now those runs happen on our machines. The reason there's a network
behind this is that measurement at that volume is more than any one machine should do, and
evidence that decides which skills are worth installing shouldn't be owned by the people
publishing the skills.

That network is [Jinn](https://jinn.network), an open agentic knowledge economy: work gets done,
the evidence of it stays open, and the next attempt starts from it. Skills with receipts are the
smallest complete version of that loop. As your agent learns, the network learns.
