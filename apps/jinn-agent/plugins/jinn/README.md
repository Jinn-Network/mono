# jinn-plugin

The Jinn layer as a Hermes plugin. Install it into a stock upstream Hermes — or
run the jinn-agent fork, which bundles it — to:

- **read the public corpus** — `/corpus <query>`, plus `corpus_search` /
  `corpus_fetch` tools the agent can call mid-task;
- **capture** task traces locally — scrubbed on this machine, fail-closed, and
  distilled into reusable skills with `/jinn distill`.

One artifact, two consumers: the same code serves the fork's bundled path and a
stock Hermes install, unchanged.

## Requires

The `jinn-layer` CLI on PATH — it arrives with the plugin; refresh it with
`hermes plugins update jinn` — or `JINN_LAYER_BIN` pointing at a local build.
Corpus reads, local capture, scrubbing, and distillation happen behind that
layer boundary; this plugin is a thin adapter. Retained outbound machinery is
forced disabled in Stage 2.

## Install (stock Hermes)

One command, total:

```bash
hermes plugins install Jinn-Network/jinn-plugin
```

Answer `y` when Hermes offers to enable `jinn`. The install carries the Jinn
layer; there is no separate package-manager step. Verify the resulting install
from a terminal:

```bash
hermes jinn-doctor
```

Inside a Hermes session, `/jinn doctor` runs the same full check set. Both
doctors are print-only: a failed check names one command to run but never
executes it.

## Update

```bash
hermes plugins update jinn
```

Run `hermes jinn-doctor` again after updating.

The jinn-agent fork loads it automatically from its bundled path — no install
step there.

## What this does today

Reading the corpus works now, and every session's evidence is captured and
distilled locally — that is the live value. Nothing leaves this machine:
contribution is parked (`/jinn status` shows `contribution: parked — nothing
leaves this machine`). Earning OLAS is verification-gated and the verification
economy is not live on testnet yet, so contribution and earning are the forward
path, not a day-one return.

## Disable, remove, or purge

Disable Jinn to stop future hooks and state writes. Removing the plugin leaves
its retained local state intact:

```bash
hermes plugins disable jinn
hermes plugins remove jinn
```

Jinn state spans **both**
`${HERMES_HOME:-$HOME/.hermes}/jinn/` and `$HOME/.jinn-client/`. To make a
reversible backup before a full purge, first end active Hermes sessions and
disable the plugin, then run:

```bash
JINN_STATE_BACKUP="$HOME/jinn-state-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p -- "$JINN_STATE_BACKUP"
for path in "${HERMES_HOME:-$HOME/.hermes}/jinn" "$HOME/.jinn-client"; do
  [ ! -e "$path" ] || cp -a -- "$path" "$JINN_STATE_BACKUP/"
done
find "$JINN_STATE_BACKUP" -maxdepth 2 -print
```

After checking that listing, purge both state roots:

```bash
rm -rf -- "${HERMES_HOME:-$HOME/.hermes}/jinn" "$HOME/.jinn-client"
```

This permanently removes local captures, episodes, candidates, and other Jinn
state from those roots. To roll back the purge, keep Jinn disabled and copy the
two backed-up directories to their original paths before re-enabling it.

Full model, fork relationship, and upstream-merge discipline: see
[JINN.md](../../JINN.md).
