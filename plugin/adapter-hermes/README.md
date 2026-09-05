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

## What the record binds

Beside the turns and tool calls, each sealed record binds the session's **base repository
state** — the origin remote as a credential-free IRI, the base commit, the base tree, and
the branch and target base when the checkout has them — and the hosted model's **service
identity**, so a verifier reads a deployment rather than a label.

It also binds the session's **producer-controlled inputs** by content, not by name. Which
inputs those are is a decision, so it is written down here rather than left in the code:

| Role | Name | Media type | What it binds |
| --- | --- | --- | --- |
| `config` | `effective-capture-config.json` | `application/json` | The configuration this capture ran under: adapter and feed version, host name and version, model provider/name/service, the controlled-input bounds, the repository-observation budget, and the pinned runtime package and version. |
| `prompt` | `initial-user-message.md` | `text/markdown` | The exact bytes of the first user message — the instruction that drove the session. |

Nothing is bound for the `workflow` and `skill` roles. The host hook API hands this adapter
neither, and reading a guess out of the working directory would seal a confident wrong answer
to the one question a controlled-input artifact exists to answer. An absent input is a gap a
verifier can see; a fabricated one is not.

Two properties hold by construction rather than by a later scrub. The configuration document
is assembled field by field from values the adapter itself computed — no filesystem path, no
environment, no credential — with sorted keys and no whitespace, so one configuration has one
digest. The prompt bytes are already in the feed as a `user-turn`, so binding them adds no
disclosure surface; it only makes them content-addressed.

The runtime bounds each input at 256 KiB and each session at 32 inputs. The selection produces
two, so the count is never a factor, and an unusually large first message is dropped rather
than truncated — it costs itself, never the capture.

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
