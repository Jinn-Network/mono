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

One command:

```bash
hermes plugins install Jinn-Network/jinn-plugin
```

The jinn-agent fork loads it automatically from its bundled path — no install
step there.

## What this does today

Reading the corpus works now, and every session's evidence is captured and
distilled locally — that is the live value. Nothing leaves this machine:
contribution is parked (`/jinn status` shows `contribution: parked — nothing
leaves this machine`). Earning OLAS is verification-gated and the verification
economy is not live on testnet yet, so contribution and earning are the forward
path, not a day-one return.

## Uninstall

`hermes plugins disable jinn`, then remove the plugin. Plugin state lives under
`$HERMES_HOME/jinn/` **and** `~/.jinn-client/`; remove both directories to purge
all local state.

Full model, fork relationship, and upstream-merge discipline: see
[JINN.md](../../JINN.md).
