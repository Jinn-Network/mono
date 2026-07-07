# jinn-agent

**jinn-agent** is an open coding harness plugged into the Jinn network. It
reads from a public, on-chain-anchored corpus of task knowledge, and — only
if you turn it on — contributes scrubbed traces of its own completed tasks
back to that corpus, so the harness everyone runs keeps getting better.

You keep a full agent either way: reading needs no account, no wallet, no
consent. Contributing is off by default and every safeguard is visible —
scrubbing is mandatory and fails closed, you preview the exact payload
before anything is ever sent, and you can veto any task.

## Quickstart

```bash
git clone https://github.com/Jinn-Network/jinn-agent
cd jinn-agent
./setup.sh          # one-time: deps, sandboxing, agent core (repo-local venv)
bin/jinn-agent setup   # pick a model provider (one-time)
bin/jinn-agent      # start
```

Provider auth: put your model key in `~/.jinn-agent/.env` (e.g.
`OPENROUTER_API_KEY=…`) and select a model with `bin/jinn-agent setup` —
without a configured model the first message fails. jinn-agent keeps all
its state under `~/.jinn-agent/`.

## Reading from the network (works immediately)

- `/corpus <query>` — search the public corpus by content
  (e.g. `/corpus tdd`).
- The agent itself has `corpus_search` / `corpus_fetch` tools and consults
  the corpus mid-task when it decides it needs to.
- `/jinn skills install <ref>` — install a corpus-published skill into the
  agent's native skills (hash-verified; `list` / `uninstall` to manage).
- At task start, jinn-agent looks up the corpus for the kind of task you're
  running. Anything **verified by network evaluators** is adopted
  automatically; anything unverified is only suggested — it never
  self-installs.

`/corpus` and `/jinn skills install` shell out to the `jinn-layer` CLI —
the same install as under Contributing
(`npm install -g @jinn-network/client@canary`). Reading needs the CLI but
no account or consent.

## Contributing (off until you say so)

```
/jinn consent
```

The flow states plainly what would leave your machine (only traces of tasks
this harness runs — never your files, shell, or anything outside a task),
how scrubbing works, and that declining leaves the harness fully functional
as a reader. If you accept: nothing publishes until you run `/jinn preview`
once and read the exact outgoing envelope. After that, completed tasks
publish automatically at session end. `/jinn veto` withholds any single
task; `/jinn ledger` lists everything that ever left, each with its
on-chain anchor link.

Contributing needs two things reading doesn't:

1. **The `jinn-layer` CLI** (scrub, publish, anchor, ledger):
   `npm install -g @jinn-network/client@canary` (Node 22; the jinn-layer
   CLI ships on the canary tag until the next stable release, >= 0.1.10,
   carries it). jinn-agent finds it on PATH, or set `JINN_LAYER_BIN`.
2. **A Jinn testnet identity** to anchor contributions under (an agent id +
   Safe from the Jinn operator bootstrap — `jinn run` walks you through it,
   faucet-funded, testnet only). Export it where you launch jinn-agent:
   `JINN_LAYER_PRIVATE_KEY`, `JINN_LAYER_SAFE_ADDRESS`,
   `JINN_LAYER_AGENT_ID`. Without these, traces are retained locally and
   nothing is lost — publish later. A lighter-weight identity path for
   harness-only users (no operator bootstrap) is on the roadmap.

## Already run the upstream agent?

No conflict: jinn-agent keeps its own state home (`~/.jinn-agent`), installs
into a repo-local venv, and never touches `~/.hermes` or an existing global
install. The isolation is carried by the `jinn-agent` entrypoint, which sets
the state home for everything it spawns — invoking the underlying upstream
`hermes` binary directly (or from an integration that does not pass that
environment through) bypasses it and falls back to the upstream default
(`~/.hermes`). Details and the deliberate-sharing override are in
[JINN.md](JINN.md).

## What this repo is

A thin fork of an upstream agent core
([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent),
MIT) with the whole Jinn layer isolated in one integration surface —
`plugins/jinn/` plus the entrypoints — so upstream merges stay cheap.
Architecture, the upstream-merge procedure, and the full behaviour contract
live in [JINN.md](JINN.md). The wider protocol lives at
[Jinn-Network/mono](https://github.com/Jinn-Network/mono).

Testnet only for now. No tokens are involved in using this software;
verified contributions accrue OLAS-denominated rewards to network operators
per the protocol's staking mechanics — see the mono repo for how that works.
