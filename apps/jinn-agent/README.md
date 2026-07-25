# jinn-agent

**jinn-agent** is an open coding harness with the Jinn plugin built in. It
brings relevant evidence from retained local episodes and Jinn's public,
on-chain-anchored corpus into ordinary agent work, then captures the resulting
session as local evidence for reuse and local distillation.

Stage 2 is deliberately local-only on the outbound side. Contribution is
parked: nothing derived from your work leaves this machine. Old Stage-1 consent
files may remain for conservative migration, but they do not enable
publication.

## Quickstart

```bash
git clone https://github.com/Jinn-Network/jinn-agent
cd jinn-agent
./setup.sh             # one-time: dependencies, sandboxing, repo-local venv
bin/jinn-agent setup   # choose a model provider
bin/jinn-agent         # start
```

Provider auth lives in `~/.jinn-agent/.env` (for example,
`OPENROUTER_API_KEY=…`). `bin/jinn-agent setup` selects the model. All
jinn-agent state stays under `~/.jinn-agent/`.

## The product loop

- Start normal work. On the first turn, Jinn searches retained local episodes
  and the public corpus, then visibly supplies relevant evidence when it finds
  any.
- The complete session is captured locally as canonical evidence for later
  automatic pickup.
- Local distillation can turn captured evidence into reusable local knowledge.
  `/jinn distill` shows or runs that workflow.
- `/jinn session` shows the active session; `/jinn history` shows finalized
  sessions; `/jinn status` shows capture, learning, and the parked contribution
  state.

No account or wallet is required for this loop. A retrieval-source failure
never blocks the underlying agent, and a healthy source can still provide
evidence.

## Contribution is parked

The current product records the complete episode and a reusable contribution
candidate locally, but performs zero outbound publication. The live status is:

```text
contribution: parked — nothing leaves this machine
```

This is independent of any retained consent value. A future contribution era
will introduce its own designed authorization and disclosure surface; the
deleted Stage-1 flow is not active.

## Install Jinn into stock Hermes

The same standalone plugin used by the fork installs into an unmodified Hermes:

```bash
hermes plugins install Jinn-Network/jinn-plugin
```

Answer `y` at Hermes's enable prompt. The plugin carries its required Jinn
layer; verify it with `hermes jinn-doctor`. If the doctor reports a stale or
missing layer, refresh the plugin with `hermes plugins update jinn`. The
canonical install, update, disable, and state-purge instructions live in the
[plugin README](plugins/jinn/README.md).

## Already run the upstream agent?

There is no state conflict. jinn-agent defaults to `~/.jinn-agent`, installs
into a repo-local venv, and does not touch `~/.hermes` or an existing global
install. The `jinn-agent` entrypoint establishes that state home; invoking an
underlying upstream binary directly bypasses it.

The fork relationship, owned-file boundary, and upstream-merge procedure are
documented in [JINN.md](JINN.md). The wider protocol lives at
[Jinn-Network/mono](https://github.com/Jinn-Network/mono).

Testnet only for now. No tokens are required to use the Stage-2 product.
