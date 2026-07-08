# jinn-agent into mono + CLI free of hermes — design

- **Version:** 0.1 (draft for review)
- **Date:** 2026-07-07
- **Author:** Oak (design session)
- **Shape:** `design` — output is this spec; implementation lands as per-phase plans and Issues
- **Governing spec:** [`spec/2026-07-02-jinn-harness-network.md`](../../../spec/2026-07-02-jinn-harness-network.md) (decisions D1–D2 constrain this work)

## 1. Summary

Two sequenced changes, CLI only (the Electron/desktop app is out of scope):

1. **Migrate** the `jinn-agent` fork into this monorepo as `apps/jinn-agent/`, via a squashed
   subtree import.
2. **Finish** making the CLI's **main path** free of any user-visible `hermes` / `Nous` / `Hermes
   Agent` branding, so a jinn-agent user never meets the upstream name in normal use — while a
   person who already runs stock `hermes` can still install and run jinn-agent without collision.

The work **deliberately excludes** a deep `hermes_* → jinn_*` internal rename. The Jinn layer stays
a liftable package (harness-network **D2**: "the same layer becomes the plugin for other
harnesses"); the hermes substrate stays swappable underneath. Goal 3 ("internals use jinn for the
most important stuff") is **already satisfied** — the product-defining code (consent, capture,
publish, ledger, corpus, onboarding, skin) lives in `plugins/jinn/` and is already jinn-named.

## 2. Context

- **The fork today** is a thin fork of `NousResearch/Hermes-Agent`. All Jinn-specific logic is
  confined to `plugins/jinn/` plus a skin YAML, riding on hermes's extension seams. Core stays
  close to byte-identical to upstream so merges stay a rebase (harness-network **D2**).
- **This session's pivot.** We give up *cheap upstream merges* — moving into mono means upstream
  changes become a manual port, not a `git merge`. We **keep** architectural liftability: the Jinn
  layer must remain extractable onto another harness. This is a *partial* abandonment of thin-fork
  discipline — we spend merge-convenience, not the portability asset.
- **Why mono.** The agent is the product surface of the harness-network thesis; it belongs beside
  `contracts/`, `client/`, `packages/harness-layer`, and the governing spec. Coordination already
  happens in mono issues (the fork's own commits cite `mono#1358`, `#1369`, `#1386`, …).

### 2.1 Verified ground truth (surface-map, 2026-07-07)

A parallel code-map over launch/boot, setup, TUI, doctor/auth, and the skin mechanism established:

- **The interactive first-run is already de-hermesed, via the skin — not core edits.** Splash
  (#1417), guided onboarding (#1405), consent + contribution ledger (#1418), welcome, response
  label, tips, and the no-key recovery screen are all skin-driven and already say jinn. Decisive
  chain: `bin/jinn-agent:115` defaults fresh installs to `display.skin = "jinn"`;
  `cli.py:_jinn_splash_active()` gates `print_jinn_splash()`; the upstream `NOUS HERMES` banner
  (`cli.py:3488`) is **unreachable** on the jinn path at every terminal width. The "own the
  first-run needs core edits, trading against liftability" tension was a **false premise** and is
  dropped.
- **What remains: 34 distinct user-visible `hermes` strings, all in surfaces the skin
  structurally cannot reach** (argparse, direct `print()`, `--version`, docstrings). Size **M** —
  a bounded core-string sweep across ~12 files, no new machinery, nothing hidden left to find.

## 3. Goals / non-goals

**Goals**

- **G1 — coexistence.** A stock-`hermes` user installs and runs jinn-agent with no collision:
  separate home (`~/.jinn-agent`), separate auth/config/sessions/skills; their hermes install is
  untouched; an explicit escape hatch (`HERMES_HOME`) shares state on purpose. *Largely already
  built in `bin/jinn-agent`; this work verifies and hardens it.*
- **G2 — no hermes on the main path.** A normal user never reads "hermes"/"Nous"/"Hermes Agent" on
  screen during install, first run, help, version, status, doctor, setup, auth, update, or
  uninstall.
- **G3 — internals use jinn for the most important stuff.** *Already met* — the Jinn layer is
  jinn-named. Recorded here so it is not silently assumed.

**Non-goals (explicit, documented — not silent omissions)**

- Deep `hermes_* → jinn_*` rename of core modules, tests, or i18n docs (spends portability; ~69k
  references; buys nothing a user sees).
- The Electron/desktop app (`apps/desktop`) — it travels with the migration but is not de-hermesed.
- Importing an existing hermes user's config/auth (G1 is coexistence, not adoption).
- Degraded-path fallback branding (fires only when the skin engine raises or the user opts into the
  `default` skin — off the main path; risk accepted, see §7).
- Packaging: the Homebrew formula and upstream-attribution links (legitimate, likely licence-
  required; see §7).

## 4. Phase 1 — Migration ("the first part")

- **Import mechanics.** `git subtree add --squash` into `apps/jinn-agent/`. Precedent:
  `legacy/jinn-cli-agents-reference/` is a squashed subtree (27M, 3 commits touch it). One clean
  import commit; mono history stays linear and the `main`-is-ancestor-of-`next` backstop
  (`main-next-ancestor-check.yml`) is unaffected. Preserving the 14,348-commit graph buys nothing —
  `git merge upstream` is already surrendered; the old repo is archived read-only for blame.
- **Polyglot island.** The agent keeps its own `pyproject.toml` / `uv.lock` / `package.json` /
  `Dockerfile` and toolchain entirely under `apps/jinn-agent/`. Its nested `apps/desktop`,
  `ui-tui`, and `web` workspaces ride along untouched. No entanglement with mono's root — mono has
  no monolithic root workspace, and per-package tooling is the established pattern.
- **CI.** One `apps/jinn-agent-ci.yml`, **path-filtered to `apps/jinn-agent/**`**, following the
  per-package pattern (`sdk-ci.yml`, `broadcast-bot.yml`, `indexer-ci.yml`). It must not fire on
  unrelated mono changes, and unrelated pipelines must not fire on agent changes.
- **Root-config bleed guard.** mono has burned on this before (`#846`: a root `railway.toml` broke
  the indexer). Keep every agent-specific config (`railway.toml`, `.dockerignore`, `Dockerfile`
  contexts) inside `apps/jinn-agent/`; add nothing to mono root on the agent's behalf.
- **Branch / flow.** Feature branch off `next`; PR into `next` (mono cadence: PRs target `next`,
  not `main`).
- **Verify.** Fresh clone of mono → `apps/jinn-agent/bin/jinn-agent` launches and runs a query;
  the new agent CI is green; mono's existing CI is unaffected by the import.

## 5. Phase 2 — CLI free of hermes (main path)

### 5.1 Scope (verified inventory)

34 distinct user-visible strings, all **core-owned** (skin cannot reach them), in ~12 files:

| Surface group | Count | Where |
|---|---|---|
| argparse `--help` / usage / epilog / subcommand descriptions | 8 | `hermes_cli/_parser.py`, `hermes_cli/subcommands/*` |
| `--version` output | 2 | `hermes_cli/main.py:233`, `cli.py:3499` |
| `status` / `doctor` headers | 3 | `hermes_cli/status.py:111`, `doctor.py:557` |
| setup / config / tools-config wizard headers | 5 | `setup.py`, `config.py`, `tools_config.py` |
| post-install bootstrap + update flow | 5 | `main.py`, `cli_commands_mixin.py` |
| auth / login flow messages | 4 | `hermes_cli/auth.py`, `status.py:238` |
| uninstall headers + goodbye | 2 | `hermes_cli/uninstall.py` |
| `cli.py` module docstrings (IDE hover) + degraded fallbacks | 3 | `cli.py`, `cli_commands_mixin.py` |
| non-interactive installer internals (framed) | 1 | `setup-hermes.sh` |
| gateway / integration wizards (lower-traffic) | 1 | `hermes_cli/gateway.py`, `setup_whatsapp_cloud.py` |

Already done (skin-owned, for reference, **not** re-touched): splash, onboarding, consent/ledger,
welcome, response label, tips, no-key recovery, installer bookend — 11 surfaces.

### 5.2 The correctness fix (priority, not merely cosmetic)

argparse `prog="hermes"` (`_parser.py:92`) makes every `--help` example read `hermes …`. Per the
fork's own design, `hermes` resolves to a **stock upstream install**, not this fork — so a user who
copies a help example runs the wrong binary. **`prog` must become `jinn-agent`** (the real
launcher). This settles the command-name question by fact, not preference, and ripples into the
epilog examples and argparse error messages.

### 5.3 Policy decision (§7-1 — the one real judgement call)

These 34 strings live in **hermes core chrome**, not in `plugins/jinn/` — so **liftability is
untouched either way** (the portable layer is not involved), and cheap merges are already
surrendered. The decision therefore reduces to whether "default skin == pristine upstream" stays an
invariant:

- **Recommended — extend the existing brand mechanism.** The codebase already routes branding
  through `cli_name` / `agent_name` / `get_branding()` with a hermes fallback (that is how every
  prior de-hermes edit was done). Route the reachable Python surfaces (status, doctor, setup,
  uninstall, version, auth, update, bootstrap) through that helper; **hard-code only argparse**,
  which is constructed before the skin loads. Follows the code's own discipline (Chesterton's
  Fence), keeps the `default` skin clean, and keeps upstream translation mechanical.
- **Alternative — hard-replace** every literal to `jinn-agent`. Fewer edits, but breaks the
  "default skin == upstream" invariant every prior edit preserved, for no liftability gain.

### 5.4 Per-surface approach

- **argparse** (`prog`, `description`, `_EPILOGUE`, subcommand `description`s): hard-set to the
  jinn-agent brand (built before the skin exists). Highest-value — seen on every `--help`.
- **Python direct-print chrome** (status/doctor/setup/config/uninstall/gateway headers, `--version`,
  auth, update, bootstrap): route through the brand helper with the existing hermes fallback.
- **Boxed ASCII headers** (status, doctor, setup, uninstall): re-pad for the width delta — "Hermes
  Agent" (12 ch) → "jinn-agent" (10 ch) shifts fixed-width borders; centring must be recomputed or
  the box misaligns.
- **`cli.py` module docstrings** (IDE hover / source): replace text; lowest priority, cosmetic.
- **`setup-hermes.sh`**: rewrite the user-facing **next-step commands** it prints (`hermes setup` →
  `jinn-agent setup`) — a correctness fix (same wrong-binary issue as §5.2). Leave its internal
  mechanics; the `setup.sh` bookend already frames the headers. (Decision §7-2.)

### 5.5 Verification (success criteria — loop until met)

- **G2.** On a fresh `~/.jinn-agent`, drive the full main path and assert **no** `hermes` /
  `Hermes` / `Nous` reaches the screen: `--help` (top-level **and** each subcommand), `--version`,
  `status`, `doctor`, `setup`, `auth`, `update`, `uninstall`. Automated string-assertion where
  feasible; the acceptance test is a script that greps captured output.
- **G1.** A stock-`hermes` user runs jinn-agent → homes do not collide (`~/.jinn-agent` vs
  `~/.hermes`), the hermes install is byte-untouched, and `HERMES_HOME=~/.hermes jinn-agent` shares
  state on purpose.
- **G3.** Already met; assert the Jinn layer remains jinn-named and unmoved.

## 6. Sequencing (Gall's Law)

Phase 1 then Phase 2 — each independently shippable and verifiable. Migrate the working system
first; sweep hermes in mono second. (If migration slips, Phase 2 can land in the old repo and travel
with the import — but the default order is migrate-then-sweep.)

## 7. Resolved decisions (approved 2026-07-07)

1. **Brand policy** (§5.3): **extend the existing brand mechanism** (guarded, hermes fallback), and
   hard-code **only** argparse (constructed before the skin loads). Not blunt hard-replace — the
   `default` skin stays byte-identical to upstream.
2. **`setup-hermes.sh`** (§5.4): **rewrite the printed next-step commands** to `jinn-agent`. It is a
   correctness fix — install scrollback must not tell users to run `hermes`, a different binary.
3. **Tree name**: **`apps/jinn-agent/`** — matches the launcher command.
4. **Import**: **squashed subtree** (`git subtree add --squash`), per the
   `legacy/jinn-cli-agents-reference` precedent.

## 8. Risks

- **Byte-identical invariant.** Editing argparse/`prog` and direct-print headers diverges core from
  upstream. Mitigated by the guarded policy (§5.3) for reachable surfaces; argparse is an accepted
  hard divergence.
- **argparse `prog` is load-bearing.** It appears in every help example and error message and must
  match the command actually on PATH (`jinn-agent`). Verified: the launcher is `bin/jinn-agent`.
- **ASCII box re-padding** (§5.4) — width delta misaligns borders if not recomputed.
- **Installer scrollback.** `setup-hermes.sh` internals are only bookended; a user reading
  scrollback still sees upstream `hermes` mid-stream unless §7-2 rewrites the commands.
- **Degraded-path fallbacks** still say "Hermes Agent" but fire only on skin failure / the `default`
  skin — off the main path. **Risk accepted**, recorded not hidden.
- **Packaging.** Homebrew formula + README upstream link brand as `NousResearch/hermes-agent`.
  Attribution is legitimate; **out of scope** unless we publish a jinn-agent formula.
