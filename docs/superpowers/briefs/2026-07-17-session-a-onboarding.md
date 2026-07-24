# Session brief A — Jinn Plugin onboarding design

Design session. Output is a spec, not implementation. **Read
`docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md` first and follow it** — working
assumptions W1–W4, the seams table, output conventions, and process constraints all apply.

## Mission

Design the **complete-but-minimal onboarding experience** for Jinn Plugin users: a person with a
working Hermes install gets from "never heard of Jinn" to their first visible
`◇ corpus — provided …` moment with the smallest possible surface area.

The gate to design toward (adjust with justification if investigation says otherwise):

> Fresh machine with Hermes installed → first evidence packet visibly provided in a real session
> in **under 5 minutes**, with **one install command per ecosystem**, **zero consent questions**
> (W1), and a **self-verifying** setup (a doctor tells you what is wrong and prints the one
> command to fix it — no README archaeology).

## Context: what onboarding is today, and what a live setup actually hit

Current flow (verify all of this against code — it changed this week): pip install from the repo
subdirectory (`apps/jinn-agent/plugins/jinn/`, pip package `jinn-plugin`, not on PyPI) +
`hermes plugins enable jinn` + `npm i -g @jinn-network/client` for the `jinn-layer` CLI; a
terminal-blocking onboarding CLI (`onboarding.py`, reduced to 3 steps after the rescope removed
the rewards step); `/jinn status` as the install doctor; a contract handshake
(`jinn_layer.py`, `contract --json` → v1) that degrades the bridge when the layer is missing or
incompatible.

A real setup pass on 2026-07-17 (operator's machine, recorded in #1654's walkthrough comments)
required manual intervention at four points — treat these as the empirical gap list:

1. **The published canary was stale/broken for users** (#1797): plugin-only merges don't
   republish the bundling client, so `npm i -g @jinn-network/client@canary` handed out a build
   with a known product-breaking bug. Until that class of gap is closed, no npm-based
   instruction is honest.
2. **`jinn-layer` discovery**: the plugin finds the layer via `$JINN_LAYER_BIN` or PATH; the
   live fix was a hand-made symlink. What is the designed answer for a real user?
3. **The wheel is not on PyPI** — repo-subdir installs are dogfooder-only.
4. **Nothing self-verifies**: the setup only worked after hand-checks of the layer contract,
   the plugin build actually installed (a stale wheel was silently in place!), and corpus
   reachability. `/jinn status` exists but the user must know to run it and interpret it.

Also inherited context: locked decision P2 (acceptance target is stock upstream Hermes + the
pip-installed plugin — the fork is batteries-included, not the target), and the cold-stock gate
(`apps/jinn-agent/scripts/cold-stock-e2e.sh`) which already automates a from-scratch install.

## Investigate before designing

- The install/first-run code paths: `apps/jinn-agent/plugins/jinn/{onboarding.py,__init__.py,
  jinn_layer.py,consent.py}`, `plugin.yaml`, `pyproject.toml`; the cold-stock script; the
  runbooks. What does the 3-step onboarding actually say now, and what survives under W1?
- Distribution mechanics: what PyPI publication of `jinn-plugin` takes (versioning, who cuts
  it, CI); the npm dist-tag reality (#1797); whether the plugin should locate/install the layer
  itself (weigh: invasiveness vs. minimality — auto-running npm from a pip package is a real
  trade-off, take a position).
- Doctor candidates: what `/jinn status` covers today vs. what the four gaps needed (layer
  found + contract v1 + **installed plugin build matches expectation** + corpus reachable +
  relevant-content-present + model provider sane). Note which checks belong to the plugin, the
  layer, or the host — the A↔C seam.
- The first-session experience with a sparse corpus: what does an honest, valuable first
  session look like when the user's repo has no matching seeds (A↔B seam)? Design the empty
  state as a first-class moment, not a failure.
- The disable/uninstall story as shipped (product design §4.8) — onboarding's mirror.

## Questions the spec must answer

1. The exact install story, per ecosystem, as commands a user types — and what cuts a release
   of each artifact.
2. The first-run flow under W1: with no consent to ask, what (if anything) does first-run say?
   Is there an onboarding flow at all, or just a doctor?
3. The doctor: invocation, checks, output contract (one next-command per failure), placement.
4. The first-session aha: what the user sees when content matches, and the designed empty
   state when it doesn't. What A needs B to guarantee (named in the seams register).
5. What existing onboarding surface gets deleted (prefer deletion; the rescope's precedent).
6. The onboarding acceptance gate: presumably a fresh-machine e2e — does the cold-stock gate
   extend, or does a separate user-journey gate exist? Who runs it and when?
7. Explicit non-goals (multi-host onboarding, accounts, telemetry — confirm none, per privacy).

## Output

Per the framing packet: spec at `docs/superpowers/specs/2026-07-XX-jinn-plugin-onboarding-design.md`
with the Seams & assumptions register and the Proposed issues table (do not file). End with the
recommended verification moment: the operator runs the designed onboarding on a clean
environment as its acceptance.
