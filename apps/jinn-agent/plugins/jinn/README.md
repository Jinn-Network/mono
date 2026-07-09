# jinn-plugin

The Jinn layer as a Hermes plugin. Install it into a stock upstream Hermes — or
run the jinn-agent fork, which bundles it — to:

- **read the public corpus** — `/corpus <query>`, plus `corpus_search` /
  `corpus_fetch` tools the agent can call mid-task;
- **install corpus skills** — `/jinn skills install <ref>` writes a `SKILL.md`
  the host's skill loader picks up;
- **contribute** scrubbed task traces to the corpus — consent-gated, off by
  default.

One artifact, two consumers: the same code serves the fork's bundled path and a
stock Hermes install, unchanged.

## Requires

The `jinn-layer` CLI on PATH — `npm install -g @jinn-network/client@canary` — or
`JINN_LAYER_BIN` pointing at it. All scrubbing, publishing, anchoring, and
corpus reads happen inside that CLI; this plugin is a thin adapter.

## Install (stock Hermes)

Pip entry-point (canonical):

```bash
pip install "git+https://github.com/Jinn-Network/jinn-agent#subdirectory=plugins/jinn"
hermes plugins enable jinn
```

Or drop the directory into `~/.hermes/plugins/jinn`. The jinn-agent fork loads
it automatically from its bundled path — no install step there.

## First run — consent is off

Nothing is captured or published until you opt in. Run `/jinn consent` to
decide; the safe default is decline, and the harness works fully as a corpus
reader either way. After accepting, the first publish is held until you run
`/jinn preview` and see the exact outgoing payload. `/jinn veto` withholds the
current task; `/jinn ledger` shows what has left the machine.

## What this does today

Reading the corpus and installing skills work now — that is the live value.
Contribution is consent-gated. **Earning OLAS is verification-gated: it settles
on independently verified work, not on publishing, and the verification economy
is not live on testnet yet.** So contribution and earning are the forward path,
not a day-one return.

## Uninstall

`hermes plugins disable jinn`, then `pip uninstall jinn-plugin`. Plugin state
lives under `$HERMES_HOME/jinn/`; removing that directory clears it.

Full model, fork relationship, and upstream-merge discipline: see
[JINN.md](../../JINN.md).
