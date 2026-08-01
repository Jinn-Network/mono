# Jinn for Hermes

Evidence capture and federated retrieval, inside your own agent session.

## Install

    hermes plugins install Jinn-Network/jinn-plugin

That is the whole install. On first load the plugin acquires its pinned runtime
with `npm install` into its own directory (Node 22 or newer required) and
registers the runtime's corpus tools with Hermes.

## What it does

- **Capture.** Each session is written to an append-only feed in your Hermes
  home and sealed into a local evidence archive at session end. Nothing leaves
  the machine.
- **Retrieval.** On the first turn of a session, relevant prior evidence is
  projected into context and a `corpus` line names what was searched and
  provided. Silence means nothing relevant was found.
- **Tools.** `corpus_search` and `corpus_fetch` are available to the agent
  mid-session.

## Checks

    hermes jinn-doctor      # from a terminal
    /jinn doctor            # in a session

Print-only. Every failing check names one command that fixes it, or says the
break is not fixable from this machine.

## State

- `~/.hermes/jinn/` — adapter state (first-session marker).
- `~/.hermes/jinn/runtime-home/` — the runtime's archive, catalog, index,
  mirror state, and capture feeds.
- `~/.hermes/plugins/jinn/runtime/` — the pinned runtime package.
- `~/.hermes/config.yaml`, key `mcp_servers.jinn` — the corpus tools' registration.

## Uninstall

    hermes plugins remove jinn

Removing also strips the `mcp_servers.jinn` entry's target, so the corpus tools
disappear from the agent. `hermes plugins disable jinn` stops capture,
retrieval, and the doctor immediately, but leaves that entry in `config.yaml`;
Hermes exposes no plugin-disable hook, so delete the `mcp_servers.jinn` block by
hand if you want the tools gone without uninstalling.

To purge all state: remove `~/.hermes/jinn/` and the `mcp_servers.jinn` block.
