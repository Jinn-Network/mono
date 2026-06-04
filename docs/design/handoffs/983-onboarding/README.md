# #983 onboarding — design handoff

Claude Design export for [#983](https://github.com/Jinn-Network/mono/issues/983) (onboarding completeness). Vendored from the operator's `Frontends-handoff.zip` so the implementation has durable access to the source.

**Build against the source, not the screenshots.** The medium is HTML/CSS/JSX — recreate it in the SPA's React + shadcn stack (match visual output, reuse existing components). Screenshots in `screens/` are pre-final and for reference only.

## Files

- `Onboarding-Prototype.html` — the clickable takeover (provision → fund → join → choose SolverNet → set up harness + model → "you're live").
- `State-Matrix-and-Variations.html` — the full state set + the three harness-legibility approaches.
- `Component-Inventory-and-Notes.md` — shadcn primitives per surface; flagged snowflakes (`TierDots`, `TierChain`); the original (self-)rubric map.
- `app/*.jsx` — the prototype source. `harness.jsx` and `solvernet.jsx` are the load-bearing new surfaces; `onboarding.jsx` is the takeover shell; `primitives.jsx` holds the data (`harnessSet`, `registrySet`).
- `jinn-app.css` — the prototype's recreated tokens; the real build uses the SPA's `globals.css` tokens.

## Build-time deltas (apply against the amended spec)

These corrections were agreed after the export and supersede the prototype where they conflict. The spec (`client/OPERATOR-APP-SPEC.md` §2.8/§2.9, amended for #983) is the source of truth.

1. **Harness legibility approach:** ship **Approach A — Status column** (`ApproachColumn`). Drop B/C from production.
2. **One harness, evaluator hidden:** onboarding surfaces a single solver harness + model. The evaluator harness is manifest-bound and runs automatically (Docker for swe-rebench-v2) — never surfaced or chosen. Remove the residual evaluator section in `ApproachGrouped` (moot once A ships).
3. **Defaults:** harness = Codex; model = **GPT-5.4 Mini** (`gpt-5.4-mini`). Replace the prototype's placeholder Codex model list (`['ChatGPT 4.5 mini', 'GPT-5.2 Codex', 'GPT-5.2']`) with the real set from `client/src/dashboard/spa/src/pages/configuration/claudeModels.ts`: GPT-5.4 Mini, GPT-5.5, GPT-5.4, GPT-5.3 Codex, GPT-5.3 Codex Spark.
4. **SolverNet step:** onboarding shows only `swe-rebench-v2`, preselected/joined ("pick your first SolverNet; add more later"). Full registry stays the post-onboarding surface.
5. **Headline overlap:** the big serif headline ("Welcome to Jinn." / "You're live.") overlaps its subtitle in every screenshot — verify in a real browser and fix if real.
6. **Copy:** don't imply the chosen harness evaluates ("the harness and model your node uses for its work" is fine).

## Out of scope (split to #1024)

The Settings harness-home and the removal of the legacy `/overview` `HarnessStatusPanel` are the #983 follow-up ([#1024](https://github.com/Jinn-Network/mono/issues/1024)). #983 ships the onboarding rendering + the `no_solvernets_joined` residue fix only.
