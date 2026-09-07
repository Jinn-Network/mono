# Post-merge lane monitor

Turns a silently red post-merge lane on `next` into an Issue. Implements #2812.

## What it watches

A **post-merge-only lane** is a workflow that runs after merge to `next` and has no
`pull_request` or `merge_group` trigger, so no pull request can go red on its behalf.
These lanes publish to mutable tags that consumers pull, which is what makes their
silence expensive: a lane that stops publishing is indistinguishable from a lane with
nothing to publish. `Operator Images` was red for 47 consecutive runs across 25 days
(2026-07-24 → 2026-08-17) before an unrelated adversarial sweep found it (#2809).

The watched set is the registry `MONITORED_LANES` in
[`.github/scripts/post-merge-lane-health.mjs`](../../.github/scripts/post-merge-lane-health.mjs):
`Operator Images`, `SDK npm Publish`, `Layer Packages npm Publish`, `Stack npm Publish`.

`npm Publish` is **not** in it. It already has `.github/workflows/npm-publish-monitor.yml`,
which understands its canary/stable trains; two monitors on one lane would file competing
issues.

## The signal

[`.github/workflows/post-merge-lane-monitor.yml`](../../.github/workflows/post-merge-lane-monitor.yml)
runs when a watched lane completes, every six hours, and on demand. It reads Actions
metadata only — it never executes code from a monitored revision — and maintains at most
one open Issue per lane, labelled `automated:post-merge-lane-failure`.

Runs that decide nothing are discarded first: `cancelled` (concurrency superseded it) and
`skipped` (a path filter declined it) are neither failures nor recoveries. Then:

| Observation | Result |
|---|---|
| Latest decisive run succeeded | Any open alert is commented and closed |
| Two or more consecutive failing runs | Alert, **confirmed** |
| One failing run, less than 24h old | Wait — a blip that the next push turns green never files |
| One failing run, no success in 24h | Alert, **unconfirmed** |

So a genuine infrastructure blip costs nothing, and a real break reaches the issue tracker
within 24 hours plus one six-hourly tick — inside one working day.

## When it starts working

GitHub runs `workflow_run`, `schedule`, and `workflow_dispatch` workflows from the
**default branch only**. This repository promotes `main` from `next` at the Monday named
cut, so the monitor is inert between merging to `next` and that promotion. After the first
promotion that carries it, validate it with one `workflow_dispatch` run before trusting it
— the same "enable after a manual run validates" discipline as `indexer-monitor.yml` and
`broadcast-bot.yml`. A dispatch against healthy lanes is a no-op that logs one line per lane.

## Reading an alert

The body names the failing run, the first failure of the streak, and the **last successful
run with its commit and date**, plus which mutable tags that success is still feeding. That
is the answer to "are the hosted operators on a stale image" without opening the Actions tab:
compare the commit the alert names against what the service pins.

The body is derived from run data only, never from the current time, so a scheduled
re-evaluation that sees no new run re-renders it identically and does not comment. A new
comment means a new failing run.

Fix or re-run the lane. A later successful run closes the alert; it reopens on its own if
the lane goes red again. Closing it by hand without fixing the lane only defers the next
alert to the next failing run.

## The monitor's own health

One lane's failed read cannot suppress the others: each lane is reconciled inside its own
try/catch, and collected errors are rethrown at the end so the run still goes red. What the
monitor cannot do is alert on its own total failure — nothing watches the watchman, and
building a second monitor to do it only moves the problem. Two things bound that residual gap:
the registry test runs pre-merge in `Repository structure`, so the realistic drift (a lane
renamed, moved, or deleted out from under the registry) is caught before it can land; and the
monitor re-runs the same test as its first step, so a run that gets that far has already proved
its own registry.

## Adding a lane

Add the entry to `MONITORED_LANES` — `workflow` (the `name:` of the workflow, which is what
`workflow_run` matches on), `file`, `branch`, and a `staleArtifact` sentence saying what
keeps resolving to an old artifact while the lane is red — and add the same workflow name to
the monitor's `workflow_run.workflows` list.
`.github/scripts/post-merge-lane-health.test.mjs` pins the registry and that list to each
other, and rejects a lane that turns out to have pre-merge coverage.
