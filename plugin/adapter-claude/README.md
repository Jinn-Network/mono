# Jinn for Claude Code

Evidence capture, inside your own agent session. Each session is sealed into a local
Execution Evidence record on your machine. Nothing leaves it.

## Install

This directory **is** the plugin: `.claude-plugin/plugin.json` plus the four hooks it
registers. Install it the way Claude Code installs any local plugin, from a checkout of this
repository. It is not yet published to a plugin marketplace, so there is no one-line install
command to quote here; when it is, this section names it.

The plugin needs the Jinn plugin runtime, which it **resolves but never acquires**: Claude
Code runs no dependency install for a plugin, and a hook that ran one would turn a session
start into a several-minute wait. Install the runtime once, into the plugin's own directory:

    npm install --prefix "<plugin directory>" @jinn-network/plugin-runtime@0.1.0

`node <plugin directory>/src/main.mjs doctor` prints one line per check and, for each failure,
the one command that fixes it — including this one, with the directory filled in.

## What it does

Four hooks, one job each:

| Hook | What it writes |
| --- | --- |
| `SessionStart` | Opens a capture session; writes the host and model identity, the base repository state, and the producer-controlled inputs. |
| `UserPromptSubmit` | The turn, and — once — the first prompt as a bound input. |
| `PostToolUse` | The tool call, its arguments, its result, and its status. |
| `SessionEnd` | Closes the feed and seals it into the local archive. |

Everything mid-session is an append to a feed file whose path the runtime computed; only the
open and the seal go to the runtime over MCP. Autopilot spawns `claude`, these hooks fire
inside it, and Autopilot itself imports no evidence package.

## What the record binds

The session's **base repository state** — the origin remote as a credential-free IRI, the base
commit, the base tree, and the branch and target base when the checkout has them — and the
hosted model's **service identity**, so a verifier reads a deployment rather than a label. The
model is read from the host's own model environment (`ANTHROPIC_MODEL`, and the Bedrock,
Vertex, and base-URL switches that decide the provider), because Claude Code's hook payloads
carry no model. When the model is not knowable the session still opens and the deployment is
simply not named.

It also binds the session's **producer-controlled inputs** by content, not by name. Which
inputs those are is a decision, so it is written down here rather than left in the code:

| Role | Name | Media type | What it binds |
| --- | --- | --- | --- |
| `config` | `effective-capture-config.json` | `application/json` | The configuration this capture ran under: adapter and feed version, host name and version, model provider/name/service, the controlled-input bound, the repository-observation budget, and the pinned runtime package and version. |
| `workflow` | `CLAUDE.md` | `text/markdown` | The project instruction Claude Code loads from the session's working directory — a producer-controlled instruction the host documents that it reads, not a guess about one. |
| `prompt` | `initial-user-prompt.md` | `text/markdown` | The exact bytes of the first prompt — the instruction that drove the session. |

Nothing is bound for the `skill` role: the hook payloads name no skill, and reading a guess out
of the working directory would seal a confident wrong answer to the one question a
controlled-input artifact exists to answer. An absent input is a gap a verifier can see; a
fabricated one is not.

Two properties hold by construction rather than by a later scrub. The configuration document is
assembled field by field from values the adapter itself computed — no filesystem path, no
environment, no credential — with sorted keys and no whitespace, so one configuration has one
digest. The prompt bytes are already in the feed as a `user-turn`, so binding them adds no
disclosure surface; it only makes them content-addressed.

The runtime bounds each input at 256 KiB and each session at 32 inputs. An input that would
exceed either is dropped rather than truncated: half an instruction binds to nothing a verifier
can check.

## What it does not emit

**Assistant turns and token counts.** Claude Code's hook payloads carry neither, and the only
other source is the session transcript — an internal host format this adapter must not couple
to. The trace therefore carries user turns and tool calls, and the record says so rather than
implying a completeness it does not have.

**A success verdict.** `SessionEnd` reports why the session ended, never whether the work
succeeded, so a session left at its own prompt is recorded as completed and a logout as
abandoned. A session killed hard fires no hook at all; its feed stays staged and the runtime's
own stranded-feed sweep seals it at the start of a later session.

## Privacy posture

The feed and the archive are **owner-only** and stay on this machine. This adapter **does not
scrub at capture time** — it binds what it is given — so secrets are kept out at the source
instead: the repository IRI is stripped of userinfo before it is written, a remote that names a
repository only on this machine is not written at all, and the configuration artifact is
assembled rather than copied. Projecting a record publicly is a separate, later decision with
its own pipeline.

## State

- `~/.claude/jinn/` — adapter state: one marker file per session, named by the **digest** of the
  session id, so no host-controlled string is ever a path component.
- `~/.claude/jinn/runtime-home/` — the runtime's archive, catalog, index, and capture feeds.

`CLAUDE_CONFIG_DIR` moves both, so two Claude Code homes on one machine never share an archive.

## Rules this adapter holds

- **No hook ever fails into the host.** stdout stays empty — a `SessionStart` hook's stdout is
  added to the session's context — and the exit code stays 0.
- **A broken runtime degrades the product to silence, never to a broken session.**
- **No feed-derived value reaches the filesystem as a path.** The feed path is minted by the
  runtime and asserted absolute before it is opened.
- **No host-controlled string can forge the executor, producer, task, result, or trace
  entities.** The host name is a constant, and a model service identity that would collide with
  the executor or the producer is refused.

## Uninstall

Remove the plugin from Claude Code. Its hooks go with it, so capture stops immediately. To
purge what it wrote, remove `~/.claude/jinn/` — that is the archive as well as the state, so
the records go too.
