# Jinn plugin — installable into a stock upstream Hermes (design)

- **Version:** 0.1
- **Date:** 2026-07-08
- **Author:** opus (drafted); Oak (direction)
- **Shape:** `feat`
- **Status:** design — awaiting review; feeds `writing-plans`
- **Repo:** `jinn-agent`, branch `feat/plugin-stock-hermes`
- **Related:** [`JINN.md`](../../JINN.md) (fork ownership + thin-fork discipline);
  mono `spec/2026-07-06-distillation-v1.md` (the capability bet this plugin is a rail for);
  mono `spec/2026-07-02-jinn-harness-network.md` §5 (two-layer model).

---

## 1. Product rationale — why build this

The plugin is a **rail**, not a product in itself. Its job is to let the Jinn
layer ride *any* harness, starting with stock upstream Hermes, so a user keeps
their harness and gains corpus consumption, consent-gated contribution, and
(deferred) earning — without adopting the whole `jinn-agent` fork.

Framing that survived an incentive interrogation (2026-07-08 session; see the
Ritsu writeup):

- **Publish ≠ earn.** Anchoring a trace mints nothing; OLAS settles only on
  evaluator-verified completed-loop work. So the plugin's contribution path is
  economically inert-until-verified by design — which is also its anti-farming
  property.
- **The pitch is consumption-in-loop, not contribute-to-earn.** The plugin's
  day-one value is pulling the right corpus skill into the task at the moment
  it's relevant. Contribution is the *exhaust* of a useful consumption product,
  never the ask — because early users cannot justify publishing their work
  before the product helps them (the chicken-and-egg).
- **The rail is worth building regardless of the distillation verdict.** The
  plugin's *strategic* value is gated on `distillation-v1` proving that
  corpus knowledge measurably uplifts an agent (its §11 three-arm test). But the
  rail itself is low-cost substrate: it is the same artifact that serves the
  fork today, and it is how the network reaches harnesses it does not own. Build
  the rail; let the measurement decide how loud the "earn" story gets.

One artifact, two consumers: the fork loads it from its bundled path unchanged;
a stock Hermes user installs it as a pip package. **Do not fork the plugin per
harness.**

## 2. Goal & hard constraints

**Goal.** Make `plugins/jinn/` installable into an unmodified upstream Hermes
install, while the same artifact keeps serving the fork's bundled path unchanged.

**Hard constraints (from the task brief):**

1. **Boundary is sacrosanct.** All scrubbing, consent conversion, publishing,
   anchoring, ledger, and corpus-read logic stays in the `jinn-layer` CLI
   (`@jinn-network/client` / `@jinn-network/harness-layer`). The plugin is a thin
   adapter. Moving leaked logic back to the layer is in scope; growing the plugin
   is not.
2. **Stock-Hermes compatibility.** No assumption of `~/.jinn-agent`, `setup.sh`,
   or any fork-owned file. Feature-detect, never fork-detect.
3. **No auto-onboarding at install.** First plugin load (or first `/jinn`) offers
   the consent flow; every contribute path is inert until consent is recorded.
   No silent trace capture, ever.
4. **Remote skills are manual-approval by default.** Auto-adopt exists only as an
   explicit opt-in setting.
5. **String hygiene.** No "paid/payment/compensation" — "earn" (operator-side) or
   protocol verbs (mints to, distributes). No emoji.
6. **One distribution channel, decided with rationale** (see §4).

## 3. Boundary & compatibility audit (findings)

Five findings. A–C must-fix and fixable entirely in this repo; D should-fix; the
residual is honestly cross-repo. Everything else audits clean: `jinn_layer.py`
is a pure subprocess wrapper; `consent.py` stores only consent *state* (a local
gating decision the layer cannot make) under `get_hermes_home()`;
`ledger_view.py` renders the layer's `ledger --json`; `capture_buffer` assembles
the layer's documented `CapturedTask` *input* (a legitimate wire format).

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| **A** | `style.py:21` imports fork-only private symbols `_FB / _TC / supports_truecolor` from `hermes_cli.banner`. Upstream `banner.py` has only `_RST` → **the plugin fails to import on stock Hermes** (`consent` imports `style`; `__init__` imports `consent`). | Blocker | Vendor the ~30-line palette + truecolor probe into `style.py`. Depend on nothing under `hermes_cli`. Also closes a private-symbol reach-in. |
| **B** | `skills_install._extract_trace` does base64-decode + **sha256 verification** + envelope parsing in Python — a trust op duplicating the layer's existing `jinn-layer skills install`. Echoed in `_tool_corpus_fetch` and `pickup`. | Boundary leak | `/jinn skills install` shells to `jinn-layer skills install <ref>` (run with `cwd` = the host skills dir; the layer slugs, verifies, writes). Plugin keeps only: dir placement, the `.jinn-ref` fence, list/uninstall. No layer change — the verb exists and supports `--out`/`--json`. |
| **C** | `capture_buffer.HARNESS_NAME = "jinn-agent"` is hardcoded → stock traces + `distributionTags` mislabelled in the public corpus. | Correctness | Resolve `JINN_HARNESS_NAME` (fork's `bin/jinn-agent` exports it) with honest default `hermes-agent` + host version via `importlib.metadata`. Tags follow the resolved name. |
| **D** | User-facing copy asserts "jinn-agent is an open coding harness…" and prints `jinn-agent onboarding --replay` — false on a stock host. | Honesty | Resolve a harness label + CLI-command name once; template the ~6 false strings. Rule: no string claims the user runs jinn-agent when they run a foreign harness. |
| **Residual** | Fully purging envelope-schema knowledge from `corpus_fetch` / `pickup` *display* plucking needs the layer to expose an interpreted `corpus get` projection. | Flagged | Cross-repo (mono / harness-layer). Out of scope here; named, not silently left. |

**Coordination note (for Ritsu).** `distillation-v1` §13 lists the `/jinn skills
install` command as "contract defined (§9), build deferred", yet the fork already
ships it. Finding B's fix (defer to `jinn-layer skills install`) aligns the plugin
onto §9's contract rather than the plugin's older `jinn.trace-envelope.v0`
extraction. Resolve the shipped-vs-deferred discrepancy in the writeup.

## 4. Architecture — one artifact, three routes

A `pyproject.toml` inside `plugins/jinn/` maps import name `jinn_plugin` → `.`
(the package dir). That one directory is simultaneously:

1. **Fork bundled plugin** — host discovers it by path (`plugins/jinn/plugin.yaml`),
   loads `__init__.py` as a synthetic package. Adding the pyproject changes
   nothing here. Unchanged.
2. **Pip package (canonical channel)** — `pip install
   "git+https://github.com/Jinn-Network/jinn-agent#subdirectory=plugins/jinn"`
   → importable `jinn_plugin` exposing `register`. Entry point:
   `[project.entry-points."hermes_agent.plugins"] jinn = "jinn_plugin"`.
   Verified: the host's `_load_entrypoint_module` calls `ep.load()` and expects a
   **module** with `register(ctx)`; the ep **name** `jinn` matches the
   `plugins.enabled` key the fork already uses.
3. **Directory drop (documented fallback)** — `cp -r plugins/jinn
   ~/.hermes/plugins/jinn`; `plugin.yaml` already makes it valid.

**Channel decision (constraint 6): pip entry-point is canonical; dir-drop is the
documented fallback.** Rationale: the entry-point route is the only one with a
real dependency declaration (pyyaml), version metadata, and a clean uninstall
(`pip uninstall`). It costs one `pyproject.toml` and does not change the bundled
path, so the "one artifact" invariant holds. A separate published package (its own
repo) is rejected — it would fork the artifact from the fork's bundled copy, the
exact thing the constraint forbids. **PyPI registration + release automation is a
deliberate follow-up** (outward-facing, irreversible name claim); this spec stops
at a pip-installable artifact verified cold against stock upstream.

**Version pinning / API drift (constraint 6).** No version pin — there is no
upstream *package* to pin against (Hermes installs from git). Instead the plugin
**feature-detects the host API in `register()`** (`hasattr(ctx,
"register_cli_command")`, etc.) and degrades loudly-but-gracefully. Confirmed all
four hooks (`on_session_start`, `pre_llm_call`, `post_tool_call`,
`on_session_end`) and all four `PluginContext` methods the plugin uses exist in
upstream today, so the happy path is fully native; the guard is purely for future
drift.

**Activation is the host's own path.** Entry-point plugins are opt-in via
`plugins.enabled`, so on stock the user runs `hermes plugins enable jinn`. We never
write their config. Install ≠ enable ≠ consent — three deliberate steps, which is
what satisfies constraint 3.

## 5. Behaviour changes

- **Pickup → suggest-only everywhere (constraint 4).** Replace the
  `autoAdoptTier`-defaults-to-`evaluator-verified` behaviour with an
  `autoAdopt: false` flag (explicit opt-in). Suggest-only is the default on both
  consumers; the auto-adopt path stays but is dormant unless opted in.
- **Harness identity (Finding C).** New resolver: `JINN_HARNESS_NAME` env →
  fork exports `jinn-agent`; unset default is `hermes-agent` + host version. Feeds
  `environment.harness`, `distributionTags[0]`, and the copy label.
- **Copy (Finding D).** The same resolver supplies a harness label + CLI-command
  name to the false strings in `consent.py` / `onboarding.py`. Verbatim design
  copy stays where it is harness-agnostic; only the false assertions get templated.

## 6. Testing (tests-first)

Written before the fix they cover:

- **Stock-load smoke (guards A)** — import the plugin with a `hermes_cli.banner`
  stub exposing *only* `_RST`; assert it imports and `register()` runs. The
  regression fence for the blocker.
- **Consent gating** — capture inert when `unset`/`declined`; extend
  `test_jinn_plugin.py`.
- **Hook buffer assembly across a session** — first-turn + tool steps + assemble,
  with the resolved-harness-label assertion; extend `test_jinn_capture_buffer.py`.
- **Skill-install file-drop (post-B)** — install shells to the layer and drops
  `SKILL.md` + `.jinn-ref`; uninstall refuses unmarked dirs. Rework
  `test_jinn_skills_install.py`.
- **Entry-point discovery** — assert `pyproject.toml` declares the ep in group
  `hermes_agent.plugins` → module `jinn_plugin` exposing `register`, and the
  host's `_scan_entry_points` builds the manifest.

**Cold e2e against real upstream** (`scripts/` + fixture): clone stock
`NousResearch/hermes-agent` into a temp venv, `pip install` the plugin, `hermes
plugins enable jinn`, run a session with `JINN_LAYER_BIN` pointed at a **stub
binary** (canned success JSON, records argv — no real corpus writes; live publish
requires `JINN_LAYER_*` keys anyway). Assert: discovered+loaded, first-run consent
offered, trace submitted via the stub, `corpus_search`/`corpus_fetch` callable,
skill install drops a loader-visible `SKILL.md`, uninstall leaves no orphaned
state. Fork suite (`tests/plugins`, `tests/dehermes`) stays green — no
branding-swept file is touched.

## 7. What a stock Hermes user runs

```
pip install "git+https://github.com/Jinn-Network/jinn-agent#subdirectory=plugins/jinn"
npm install -g @jinn-network/client@canary        # the jinn-layer CLI
hermes plugins enable jinn                          # host's native activation
hermes chat                                         # first session: consent offered, inert until accepted
  /jinn consent accept confirm                      # opt in (default is decline)
  … run a task …  /jinn preview  → publishes on next task end
  /corpus <query> · /jinn skills install <ref> · /jinn ledger
```

## 8. Out of scope / follow-ups

- **Bulk import of old traces** — a `jinn-layer` capability (bulk = scrub/
  publish/provenance = layer-side) on the existing `seed plan`/`seed execute`
  rails; plugin share is a thin `/jinn import`. Separate task.
- **Produce-side `distill → publish`** (`/jinn skills publish`) — must align with
  `distillation-v1` §5 (`jinn.skill.v1`) and §9 (consumption contract). The
  thesis-carrying feature, gated on the §11 verdict. Separate task.
- **Federated skill evaluation** — refine skills against others' skills via
  local, private benchmarks; only outcomes/refined artifacts propagate. Design
  thread, not scoped.
- **Interpreted `corpus get` projection** (the §3 residual) — mono/harness-layer.
- **Open-weight runtime-tier measurement axis** — see the experiment delta note.
- **PyPI registration + release automation.**

## 9. Success criteria

- Cold test against stock upstream passes end to end (§6 e2e).
- Fork suite stays green; the fork loads the same plugin from its bundled path.
- Boundary audit clean: no scrub/consent/publish/verify logic in the plugin
  (Finding A vendored, Finding B deferred to the layer).
- Tests-first for: consent gating, hook buffer assembly, skill-install file-drop,
  entry-point discovery — all written before their implementation.
