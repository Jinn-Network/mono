# jinn-agent — the Jinn harness

**jinn-agent** is an open coding harness plugged into the Jinn network: it
reads from the public corpus, and (with consent) contributes scrubbed task
traces back to it. The product name is `jinn-agent`, everywhere a human
looks; this repository is technically a thin fork of an upstream agent core
([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent))
— that name is provenance, not product, and no user-facing surface should
use it. Spec: `spec/2026-07-02-jinn-harness-network.md` in
[Jinn-Network/mono](https://github.com/Jinn-Network/mono) (decisions D1/D2),
issue #1312.

## Run

```bash
./setup.sh            # one-time: deps, sandboxing, agent core
bin/jinn-agent        # start the harness
```

In-session: `/jinn consent` to decide about contributing (default: decline —
reader only), `/corpus <query>` to search the network's knowledge,
`/jinn ledger` for the receipt trail of anything that left your machine.

First run: `jinn-agent onboarding` walks the core loop once, one confirmed
step at a time — consent → your first publish → rewards → corpus signals.
It is remembered per machine and never repeats (a returning operator with
consent recorded and a non-empty ledger sees nothing); `jinn-agent
onboarding --replay` re-shows all four screens without re-asking consent.

## Coexists with a stock upstream install

Already running the upstream agent? No conflict:

- **Separate state home.** jinn-agent defaults to `~/.jinn-agent` (config,
  auth, skills, memories, sessions) — it never reads or writes `~/.hermes`.
  Corpus-installed skills therefore never leak into a stock install, and
  version skew between the two cannot corrupt shared state. Override with
  `JINN_AGENT_HOME`, or set `HERMES_HOME` explicitly to share state with a
  stock install on purpose.
- **Repo-local install.** `setup.sh` builds a venv inside this repo — no
  global package, so an existing upstream install (and its `hermes` command)
  is untouched.
- **One caution:** don't hand both installs the same messaging-platform bot
  tokens and run both gateways — the platform will get duplicate replies.
  That's true of any two agent instances, not specific to this fork.

Provider keys go in the jinn-agent home on first run (`~/.jinn-agent/.env`).

## Install into a stock upstream Hermes

The Jinn layer also ships as a standalone **plugin** (`plugins/jinn/`) that
installs into an *unmodified* upstream Hermes — the user keeps their harness and
gains corpus reads, skill install, and consent-gated contribution. It is the
**same artifact** the fork loads from its bundled path; the plugin is never
forked per harness.

```bash
pip install "git+https://github.com/Jinn-Network/jinn-agent#subdirectory=plugins/jinn"
hermes plugins enable jinn
```

The plugin feature-detects its host (never fork-detects): it imports nothing
fork-only, writes only under `$HERMES_HOME`, and resolves its harness identity
from `JINN_HARNESS_NAME` — the fork's `bin/jinn-agent` sets it; unset (a stock
host) it honestly reports `hermes-agent`, so nothing published or displayed
claims the user runs jinn-agent when they do not. All scrubbing / publishing /
anchoring / corpus-read logic stays in the `jinn-layer` CLI; the plugin is a
thin adapter. Details: [`plugins/jinn/README.md`](plugins/jinn/README.md).

## What the Jinn layer adds — one integration surface

The entire Jinn layer lives in the paths below. **Six upstream files are
deliberately owned by the fork** (mono#1358 runtime branding, mono#1388
first-run guidance, mono#1417 terminal splash); each has a fixed
merge-resolution rule so upstream merges stay cheap:

| Owned upstream file | Why | Merge resolution |
|---|---|---|
| `README.md` | The repo's human-facing front page must describe jinn-agent, not the upstream core (upstream's README remains available at the upstream repo) | Ours: `git checkout --ours README.md` |
| `hermes_cli/banner.py` | Two-point skin patch: version label reads `agent_name` from the active skin; the credit line reads `credit` from the active skin (rendered only when non-empty). Default-skin output is unchanged. Additively also carries the jinn terminal-splash render module (mono#1417) — pure display functions, no upstream behaviour changed | Take upstream, re-apply the two-point patch + the appended splash module — re-derivable from `tests/plugins/test_jinn_branding.py` and `tests/plugins/test_jinn_splash.py` |
| `cli.py` | One skin-gated patch point (mono#1417): `_jinn_splash_active()` + a swap in `show_banner` that, only when the jinn skin is active, paints the fork terminal splash instead of the upstream Rich banner. Every other skin keeps upstream behaviour byte-for-byte; any splash error falls through to the upstream banner | Take upstream, re-apply the skin-gated splash swap — re-derivable from `tests/plugins/test_jinn_splash.py` |
| `hermes_cli/tips.py` | Additive fork tail after the upstream `TIPS` list and `get_random_tip`: builds a filtered `_JINN_TIPS` (drops OpenClaw-era and Nous tips, rebrands capital-H "Hermes") and wraps `get_random_tip` skin-gated at selection time — jinn skin draws from the filtered list; every other skin gets upstream behaviour unchanged. Upstream `TIPS` is never mutated | Take upstream list + function wholesale, keep the fork tail (marked `jinn-agent fork tail (mono#1358)`) |
| `hermes_cli/setup.py` | Two-point skin patch (mono#1388): adds `_setup_cli_names()` (resolves the CLI command/display name from the active skin's `cli_name` branding, initialising the skin from config on demand — the first-run guard fires before `cli.py`'s skin init) and threads it through `print_noninteractive_setup_guidance`. Default-skin output is byte-identical | Take upstream, re-apply the patch — re-derivable from `tests/plugins/test_jinn_no_key_guidance.py` |
| `hermes_cli/main.py` | One patch point (mono#1388): the first-run no-key guard in `cmd_chat` prints its recovery command (`… setup`) via `_setup_cli_names()` so the command it names exists on a jinn-agent user's PATH. Everything else (argparse chrome, version fast paths) stays upstream | Take upstream, re-apply the guard patch — re-derivable from `tests/plugins/test_jinn_no_key_guidance.py` |

Every other upstream file is unmodified.

| Path | What it is |
|---|---|
| `bin/jinn-agent`, `setup.sh` | The human-facing entrypoints (run + one-time setup) |
| `plugins/jinn/` | The integration surface: first-run consent flow, capture buffer + payload-agnostic pickup, `jinn-layer` subprocess wrapper, agent tools, `/jinn` + `/corpus` slash commands |
| `plugins/jinn/skin/jinn.yaml` | The jinn-agent skin (branding strings + banner art); installed to `$HERMES_HOME/skins/` by `bin/jinn-agent`, defaulted for fresh installs, never overwrites an explicit skin choice |
| `plugins/jinn/soul/SOUL.md` | The jinn-agent identity template (mono#1386) — the upstream default soul with the identity sentence rewritten; installed to `$HERMES_HOME/SOUL.md` by `bin/jinn-agent` ONLY when SOUL.md is absent. An existing soul (user-written or previously seeded) is never overwritten — unlike the skin sync |
| `tests/plugins/test_jinn_plugin.py` | Consent-gating integration tests |
| `tests/plugins/test_jinn_branding.py` | Runtime-branding regression tests (mono#1358) — first screen says jinn-agent, no upstream brand words in default session chrome |
| `JINN.md` | This document |

Accepted branding residuals (deliberately NOT owned — `cli.py` is owned
only for the mono#1417 skin-gated splash swap in `show_banner`, nothing
else; and `hermes_cli/main.py` is owned only for the first-run no-key
guard, nothing else): the `<30`-column tiny-terminal compact-banner
fallback in `cli.py` (~line 3490) still reads `- Nous Research`; the
`HERMES_FAST_STARTUP_BANNER=1` fast path builds a literal `Hermes Agent v…`
label; and `jinn-agent --version` / `jinn-agent version` print `Hermes
Agent v…` because the version fast paths in `hermes_cli/main.py` run before
`init_skin_from_config`, so the skin-aware version label reads the default
skin. Two further residuals: the argparse `--help` chrome (`usage: hermes`,
the `Hermes Agent - AI assistant with tool-calling capabilities`
description, and subcommand descriptions such as `Nous Portal` and
`OpenClaw migration tools`); and the `/help` output's hardcoded `Tip: Just
type your message to chat with Hermes!` line (`cli.py` ~line 6609). All are
off the default cold-start path or explicit-invocation-only; owning the
`cli.py` / `hermes_cli/main.py` argparse and help surfaces for them would
violate thin-fork discipline.

Everything that touches scrubbing, consent conversion, publishing, anchoring,
the ledger or the corpus lives in the **`@jinn-network/harness-layer`
package** (the `jinn-layer` CLI from `@jinn-network/client`), not in fork
code. The plugin shells out to it. That is the thin-fork discipline: the same
layer becomes the plugin for other harnesses, and upstream merges stay cheap.

## Behaviour

- **Consent is OFF by default.** `unset` and `declined` both mean: nothing is
  buffered, nothing is written, nothing leaves the machine. The harness works
  fully as a corpus **reader** either way. Run `/jinn consent` to decide; the
  flow's safe default (bare Enter) is decline.
- **Capture is harness task traces only** — the plugin buffers the session's
  first user message and its tool calls, never anything outside a task.
- **Scrub is fail-closed and happens locally** inside `jinn-layer` before
  anything can publish. If scrubbing can't finish, nothing sends.
- **Preview-gated first publish**: after accepting, nothing publishes until
  you run `/jinn preview` once and see the exact outgoing envelope.
- **Per-task veto**: `/jinn veto` withholds the current task; the ledger
  records `vetoed (local only)`.
- **Publish failure retains locally**: the assembled trace stays under
  `$HERMES_HOME/jinn/pending/` and the ledger/UI shows
  `publish failed — retained locally`.
- `/jinn ledger` — what left this machine, with anchor links.
- `/corpus <query>` — in-session corpus search.
- **Payload-agnostic auto-pickup** — at task start the harness derives the
  task's distribution, looks up the corpus, and decides per candidate by
  **verification tier, not human keystroke**: payloads at or above the
  configured threshold (default `evaluator-verified`) are adopted
  automatically — verification under bond is the trust gate; anything below
  is surfaced to the agent as injected context, install stays deliberate.
  Adopters are a registry keyed by payload type (`skill` ships in v0;
  loadout recommendations and full loadouts plug in as new adopters — same
  rail, richer payloads). Config: `$HERMES_HOME/jinn/pickup.json`
  (`enabled`, `autoAdoptTier`, `maxCandidates`). Fails open; never
  consent-gated (consuming is always allowed). Today's corpus holds nothing
  verified, so today this runs suggest-only — honestly.
- **Agent tools `corpus_search` / `corpus_fetch`** — the agent itself can
  search the corpus by content and read a record's full text mid-task
  (hash-verified), with or without installing anything.
- **`/jinn skills install <ref>`** — install a corpus-published skill into
  Hermes's native skills: `corpus get` → sha256 verification → SKILL.md
  written to `$HERMES_HOME/skills/<slug>/`; Hermes's loader takes over.
  Consuming is always allowed — no consent needed to install (consent gates
  contributing, never reading). `/jinn skills list` / `uninstall <slug>`
  manage jinn-installed skills only (a `.jinn-ref` marker fences them; a
  user's own skills are never touched).

Requires the `jinn-layer` CLI on PATH (`npm install -g @jinn-network/client`)
or `JINN_LAYER_BIN` pointing at it. Testnet in v0.

## Upstream-merge procedure (the thin-fork proof)

The fork tracks upstream `main`. To take upstream:

```bash
git remote add upstream https://github.com/NousResearch/hermes-agent.git  # once
git fetch upstream
git checkout jinn-layer
git merge upstream/main
```

**Expected conflicts: the six owned files only** — `README.md`,
`hermes_cli/banner.py`, `hermes_cli/tips.py`, `hermes_cli/setup.py`,
`hermes_cli/main.py`, `cli.py`; resolve each per the
merge-resolution rules in the ownership table above. The Jinn layer
otherwise adds files only and modifies zero upstream files, so nothing else
can conflict outside the integration surface. If a merge ever conflicts on
any other upstream file, that is a thin-fork regression — record it in the
merge PR and move the offending change into the plugin or the harness-layer
package.

After each upstream merge, run the fork's own gate:

```bash
python3 -m pytest tests/plugins/test_jinn_plugin.py -q
```

## Licence

Upstream hermes-agent is MIT; this fork keeps the upstream `LICENSE` and adds
the Jinn layer under the same terms.
