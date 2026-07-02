# Design notes — 1319 · Terminal splash

**Surface 3 · TUI.** Renders at harness launch, before anything else — before first-run consent (#1312) on first boot. A greeting, not a loading screen: it draws instantly and carries live status, not decoration.

Preview: [`1319-terminal-splash.html`](./1319-terminal-splash.html) — self-contained. Shows the full-fidelity truecolor splash, the 80-col / 16-colour fallback, and the four status lines across every state.

Source: Claude Design project `frontends` (`019e2715-c4bc-7eae-af28-e178b95e5156`), file `1319-terminal-splash.html`. Filed bundled with the #1312 run per issue #1319's body.

---

## Intent & constraints

- **Instant.** The splash is a greeting, not a loading screen. It draws in one paint from static art + a single status snapshot. Status lines that aren't ready yet show `checking…` and settle without redrawing the frame or shifting layout.
- **No emoji.** Iconography is the sigil, the box glyphs, and the words. Status uses colour + word, never a symbol.
- **Degrades.** Truecolor line-art (3.1) → 16-colour ASCII (3.2) chosen automatically on `$COLORTERM` unset or `$COLUMNS < 100`. The fallback fits 80×24 with the four status lines visible without scroll.
- **Sigil is derived, not invented.** Circle (r), inscribed upward triangle (apex top, base bottom), horizon line through centre, centre point — the five elements of `docs/design/jinn-design-system/project/assets/logo-sigil.svg`, transcribed to a character grid. No new mark.

## Colour → ANSI token mapping

| Role | Token | Truecolor | 16-colour fallback |
|---|---|---|---|
| structure (circle, triangle, horizon, frame) | sky | `--blue-400 #7aa7dc` | cyan |
| accent (centre point, wordmark rule, version) | gold | `--gold-400 #dcb866` | bright yellow |
| ok / on / running / connected | green | `--vow-green #6a9b8f` | green |
| warn / degraded | amber | `--wane #b8802f` | yellow |
| error / unreachable / not running | red | `--break-red #a85a5a` | red |
| secondary / labels / off | dim | `--slate-400 #7d8ba3` | bright-black (grey) |

Gold appears exactly twice in the full splash: the centre point of the sigil and the version string. That scarcity is the point — one lamplight accent, everything else structure.

## Status lines — exact copy, every state

Label column is fixed-width (15 chars), lower-case, dim. Value carries the colour. Ordering is fixed: network, corpus, contribution, node.

| Line | State | Rendered string | Colour |
|---|---|---|---|
| `network` | testnet | `network        base-sepolia · testnet` | sky |
| `network` | mainnet | `network        base · mainnet` | gold |
| `corpus` | connected | `corpus         connected · 1,284,902 envelopes` | green |
| `corpus` | unreachable | `corpus         unreachable — retrying` | red |
| `corpus` | checking | `corpus         checking…` | dim |
| `contribution` | on | `contribution   on · 1,284 traces published` | green |
| `contribution` | off | `contribution   off · reader only` | dim |
| `node` | running | `node           running · vessel-0x91be…44a2` | green |
| `node` | not running | `node           not running` | dim |

**Pre-consent (first boot).** The `contribution` line is *not shown at all* before consent is recorded — the splash simply omits it and shows network, corpus, and node. It appears only once the operator has accepted or declined in the 1312 first-run flow.

**Contribution count semantics.** The count is *traces this machine has published*, not the corpus total — the corpus total lives on the `corpus` line. Both are shown so the operator can see their contribution against the whole at a glance.

## Wordmark & version

The brand wordmark is italic serif; a terminal can't render it, so the splash uses a lower-case mono `jinn` with a gold rule beneath, then the tagline and version. Version string format: `harness v<semver> · <network>`. On an out-of-date build the version renders amber with ` · update available` appended (the only status the wordmark row ever carries).

## Resolved in review & remaining questions

- **Resolved.** Splash persistence and clear-on-launch *mirror the Hermes agent* — jinn-layer inherits whatever Hermes already does at launch; no new rule invented here.
- **Resolved.** No `contribution` line pre-consent — the splash omits it entirely until consent is recorded. It appears only after the operator accepts or declines in the 1312 flow.
- **Open — implementer's call.** Fallback trigger threshold (`$COLUMNS < 100`) is a placeholder; the true minimum for the line-art variant is ~96 columns. Left to the harness's terminal-capability probe.
