# Post-merge lane monitor

Turns a silently red post-merge lane on `next` into an Issue. Implements #2812.

## What it watches

A **post-merge-only lane** is a workflow that runs after merge to `next` — a `push` trigger
matching `next`, or a `workflow_run` trigger filtered to `next` — and has no
`pull_request` or `merge_group` trigger, so no pull request can go red on its behalf.
These lanes publish to mutable tags that consumers pull, which is what makes their
silence expensive: a lane that stops publishing is indistinguishable from a lane with
nothing to publish. `Operator Images` was red for 47 consecutive runs across 25 days
(2026-07-24 → 2026-08-17) before an unrelated adversarial sweep found it (#2809).

The watched set is the registry `MONITORED_LANES` in
[`.github/scripts/post-merge-lane-health.mjs`](../../.github/scripts/post-merge-lane-health.mjs):
`Operator Images`, `SDK npm Publish`, `Layer Packages npm Publish`, `Stack npm Publish`.

Every other post-merge-only lane on `next` is in `EXCLUDED_LANES` in the same file with its
reason, and the test enumerates the workflows so a new lane that is in neither fails
pre-merge. Two are excluded today:

- `npm Publish` already has `.github/workflows/npm-publish-monitor.yml`, which understands
  its canary/stable trains; two monitors on one lane would file competing issues.
- `main-next ancestor check` publishes no mutable artifact, so nothing goes stale while it
  is red, and it files its own issue when it fails.

Release-triggered lanes (`docker.yml`, `promote-main.yml`, `changelog-mirror.yml`) are out of
scope here: they are not push-to-`next` lanes, they run on a different cadence, and "the last
run failed" does not mean the same thing for a lane that fires a handful of times a year. They
have the same silence problem and need their own answer.

## The signal

[`.github/workflows/post-merge-lane-monitor.yml`](../../.github/workflows/post-merge-lane-monitor.yml)
runs when a watched lane completes, every six hours, and on demand. It reads Actions
metadata only — it never executes code from a monitored revision — and maintains at most
one open Issue per lane, labelled `automated:post-merge-lane-failure`.

It reads the newest 100 `push` runs of the lane on `next`. Runs that decide nothing are
discarded first: `cancelled` (concurrency superseded it) and `skipped` (a path filter declined
it) are neither failures nor recoveries, and a run that is not yet `completed` decides nothing
whatever conclusion it carries. Then:

| Observation | Result |
|---|---|
| Latest decisive run succeeded | Any open alert is commented and closed |
| No decisive run in the window | Nothing — an open alert stays open; nothing proved recovery |
| Two or more consecutive failing runs | Alert, **confirmed** |
| One failing run, less than 24h old | Wait — a blip that the next push turns green never files |
| One failing run, no success in 24h | Alert, **unconfirmed** |
| One failing run whose timestamps do not parse | Alert, **unconfirmed** — it cannot prove it is fresh |

So a genuine infrastructure blip costs nothing, and a real break reaches the issue tracker
within 24 hours plus one six-hourly tick — inside one working day.

The verdict is the **run-level conclusion**. A run that concludes `success` while its publishing
job was skipped reads healthy here: `stack-npm-publish.yml` gates `canary-publish` on
`vars.PLATFORM_CANARY_PUBLISH_ENABLED`, and while that flag is off (DR-2026-08-17-d documents the
off position) the lane is deliberately not publishing rather than failing. Resolving jobs per
run, the way `npm-publish-monitor.yml` does for its one lane, is a separate decision (#4257); until
then a green-but-not-publishing lane is not covered by this monitor.

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

When the streak fills the window — no success among the 100 runs read — the body says so: the
count becomes "at least N", the first-failure row becomes "oldest failure in the observed
window", and the last-success row says the window did not reach one rather than that the lane
never succeeded. Find the last successful run in the Actions tab in that case; the monitor does
not page further back.

The body is derived from run data only, never from the current time. The marker line at the
bottom names the latest failing run and its attempt, and the monitor rewrites the body (and posts the new body
as a comment) only when that marker changes, so a scheduled re-evaluation never comments and
**a new comment means a new failing run** (or a failing re-run of one). Put notes in comments, not the body: the body is
rewritten on the next failing run, and an alert whose marker line is edited away is no longer
recognised as the lane's alert.

Fix or re-run the lane. Only a later successful **`push` run on `next`** closes the alert — a
new push, or a re-run of the failed push run. `workflow_dispatch` runs are not counted: on these
lanes a dispatch is the stable-release path with its own inputs, not a canary publish, so a green
dispatch says nothing about the push lane. Once closed, the alert stays closed; if the lane goes
red again — including on a later re-run of the same run — a **new issue** is opened. Closing an
alert by hand while the lane is still red defers the next alert to the next failing run or re-run:
the monitor remembers the failing run attempt a closed alert named and does not re-file for it.

## The monitor's own health

One lane's failed read cannot suppress the others: each lane is reconciled inside its own
try/catch, and collected errors are rethrown at the end so the run still goes red. What the
monitor cannot do is alert on its own total failure — nothing watches the watchman, and
building a second monitor to do it only moves the problem. Two things bound that residual gap:
the registry test runs pre-merge in `Repository structure`, so the realistic drift (a lane
renamed, moved, or deleted out from under the registry, or a new post-merge-only lane added
without being registered or excluded) is caught before it can land; and the
monitor re-runs the same test as its first step, so a run that gets that far has already proved
its own registry.

## Adding a lane

Add the entry to `MONITORED_LANES` — `workflow` (the `name:` of the workflow, which is what
`workflow_run` matches on), `file`, `branch`, and a `staleArtifact` sentence saying what
keeps resolving to an old artifact while the lane is red — and add the same workflow name to
the monitor's `workflow_run.workflows` list.
`.github/scripts/post-merge-lane-health.test.mjs` pins the registry and that list to each
other, rejects a lane that turns out to have pre-merge coverage or no `push` trigger on its
declared branch, and fails when a post-merge-only lane on `next` is in neither
`MONITORED_LANES` nor `EXCLUDED_LANES`. A lane that should not be watched goes in
`EXCLUDED_LANES` with its reason.
