# Plug-in builder entry point — design

- **Date:** 2026-05-13
- **Author:** opus (drafted with Captain `oak`)
- **Status:** Proposal
- **Version:** 0.2
- **Bead:** `jinn-mono-52x3` (epic)
- **Tracks:** Phase A.2 builder-surface layer; sequenced after `jinn-mono-uy6v` (first public release) and `jinn-mono-8psp` (Hermes harness integration).

## 1. Purpose and framing

This spec scopes a single epic — **the builder entry point for plug-ins on the SWE-rebench v2 SolverNet running against the Hermes harness** — and identifies the minimum loop closure required so that the first external builder can ship a plug-in, have it surfaced for operator discovery, and have its score visible on the network explorer with the builder attributed.

The epic is the builder-facing complement to `uy6v` (operator install path) and `8psp` (Hermes harness integration). **The substrate is largely built.** Plug-in attribution is already in the signed execution envelope (`executor.plugins[]` in `jinn.execution.v1`). Cross-operator score aggregation is already shipped under `jinn-mono-ebu7` (network explorer). Reputation slashing is already scoped under `jinn-mono-0www` (Phase B.2). The remaining gap is **discovery + builder-shape surfacing**: builders publish plug-ins to npm but operators can't find them, and the explorer's leaderboard aggregates by operator-running-the-plug-in rather than by builder-shipping-the-plug-in.

This spec **explicitly reframes** the Skill Oracle v0 framing in [discussion #129](https://github.com/Jinn-Network/mono/discussions/129) from skill-as-unit to plug-in-as-unit, consistent with Ritsu's final comment in that thread ("SolverNet = tasks; Harness family = execution surface; Artifact = the concrete manifest being scored — skill, plug-in, harness config"). The `jinn.plugin.json` schema already in the repo is that "concrete manifest being scored". This epic operationalises the builder side of it for SolverNet 1 without redesigning the manifest, the envelope, or the aggregation.

### Composes with

- **`client/src/types/envelope.ts`** — the `jinn.execution.v1` envelope already carries `executor.plugins[]` (name, version, cid, sha256) per attempt. The epic consumes this; it does not extend it.
- **`jinn-mono-ebu7`** (network explorer) — already ships per-operator + per-SolverNet leaderboards keyed on HarnessCheckpoint (which carries the plug-in set). Builder-side views fold into this; no new aggregation is built.
- **`jinn-mono-0www`** (Phase B.2 evaluator economics + reputation slashing) — owns stake-backed reputation and challenge mechanism. This epic ships record-only attribution and explicitly defers slashing.
- **`spec/2026-04-30-plug-in-surface.md`** — Path 1 plug-in surface (the design-level commitments). The phase-agent-override and topic-explorer slots are Claude-Code-shaped and out of scope here because Hermes drives its own kanban and learning loop.
- **`spec/2026-05-01-harness-pack-architecture.md`** — establishes the runtime/SolverType plug-in distinction enforced by `client/src/plugins/validator.ts`.
- **`spec/2026-04-30-phase-a-umbrella.md`** — Phase A.2 umbrella.
- GitHub Discussion [#129](https://github.com/Jinn-Network/mono/discussions/129) — Sharpening SolverNet 1; this epic is the plug-in-shaped operationalisation.

## 2. What already exists

Before describing the gap, the existing substrate is enumerated so the epic's children remain net-additions rather than rewrites.

### 2.1 Plug-in manifest, validation, resolution

- `jinn.plugin.json` is the canonical plug-in manifest. `client/src/plugins/manifest.ts` declares the lookup order `['jinn.plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']` — `jinn.plugin.json` wins when present.
- `client/src/plugins/validator.ts` enforces the two exclusive modes from `spec/2026-05-01-harness-pack-architecture.md` §5.1:
  - **Runtime plug-in** — `jinn.supports: ['jinn.runtime']` (singleton). Reference: `client/plugins/network-tools/`.
  - **SolverType plug-in** — every entry is a SolverType identifier. Reference: `client/plugins/swe-rebench-v2-runtime/` (`jinn.supports: ['swe-rebench-v2.v1']`).
- `client/src/plugins/resolvers.ts` resolves six source kinds — `bundled`, `local`, `npm`, `git`, `github`, `claude` — into a vendored package under `~/.jinn-client/solver-plugins/` with a materialisation lock and sha256 digest.
- `client/src/plugins/registry.ts` exposes `register`, `get`, `forSolverType`, `list`. `loadSolverPlugins()` is the daemon entry point.

### 2.2 Execution envelope already attributes plug-ins

`client/src/types/envelope.ts:62-67` — every signed `jinn.execution.v1` envelope's `executor` field carries:

```ts
plugins: z.array(z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  cid: z.string().min(1).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})),
```

Per-attempt plug-in attribution is **already published**. The epic does not extend this field; it consumes it.

### 2.3 CLI surface

- `jinn create harness <pkg>` (`client/src/cli/commands/create.ts`) — Path 2 scaffold; three patterns `forecaster | evaluator | alternative-harness`; templates under `client/templates/harnesses/`. The pattern for the new plug-in scaffold to follow.
- `jinn solver-plugins {show, validate, pack}` (`client/src/cli/commands/solver-plugins.ts`) — author/curator tooling. Extended in this epic with a `submit` sub-verb.
- `jinn solver-nets {list, show, enable, disable, set-harness, add-plugin, remove-plugin, doctor, sample, validate-pool}` (`client/src/cli/commands/solver-nets.ts`) — operator-side, unchanged.

### 2.4 Network explorer already aggregates per-plug-in

`jinn-mono-ebu7` (76% complete at time of writing) has shipped:

- **ebu7.4** — Network + Per-SolverNet views, Learning panel, **faceted leaderboard**.
- **ebu7.6** — IPFS envelope-enrichment: **AttemptEnvelopeMeta**, **HarnessRollup**, FreezeViolation, LanguageRollup, **HarnessCheckpoint**.
- **ebu7.7** — Multi-net generalization: SolverNets index, **per-operator view**, cross-net leaderboard, summed network rollups.
- **rdod** — Public aggregate dashboard for SWE-rebench v2 (code complete, awaiting public deploy as a uy6v release gate).

HarnessCheckpoint is the unit the leaderboard ranks by; its enrichment already includes the plug-in set from the envelope's `executor.plugins[]`. **A builder's plug-in CID can already appear on the leaderboard via any operator who runs it.** What's missing is the **builder-side filter** (browse plug-ins submitted for a SolverNet, view scores keyed by a builder address) — a read-shape over the existing aggregation, not new aggregation.

### 2.5 Operator SPA

- Routes wired in `client/src/dashboard/spa/src/App.tsx`: `/overview`, `/overview/activity`, `/operator`, `/operator/join/:cid`, `/operator/execution-data`, `/configuration`, `/launcher`, `/launcher/create`, `/launcher/launched/:solverNetId`.
- `client/src/dashboard/spa/src/pages/leaderboard/` contains `Leaderboard.tsx`, `FrozenLeaderboardTable.tsx`, `TrainLeaderboardTable.tsx`, `VerifiedBadge.tsx`. Components are embedded in other surfaces; **no `/leaderboard` route is wired**. The `/build` route this epic introduces sits alongside.

### 2.6 Hermes harness (the 8psp PR stack #140–#145)

Per `feat(hermes): hermes-agent harness package (2/4)` (PR #141):

- `config-builder.ts: hermesConfigFromSolverPlugins()` translates each `SolverPlugin`'s standard `.mcp.json` (resolving `${CLAUDE_PLUGIN_ROOT}` templates) and `skills/` directory directly into Hermes's `mcp_servers:` and `skills.external_dirs:` config. **It does not consult `jinn.plugin.json`** — that file is daemon-side metadata, orthogonal to the harness↔MCP path.
- `HermesHarness.supports()` is scoped to `swe-rebench-v2.v1` solver role only for v1.
- The Jinn-side `learner` plug-in is **not loaded** under Hermes; Hermes drives its own learning loop.

The key implication: **the SolverPlugin shape is harness-agnostic**. A plug-in's `.mcp.json` and `skills/` directory work across `learner` (claude-code), `learner` (codex-code), and `hermes-agent` automatically. Harness-specific concerns (Hermes `platform_toolsets` allowlist, Claude hooks) live in the harness package, not the plug-in.

### 2.7 Reference plug-ins (the de facto worked examples)

- `client/plugins/swe-rebench-v2-runtime/` — Solver-side orient + plan skills for `swe-rebench-v2.v1`. The canonical example for a SolverType plug-in targeting this epic's SolverNet.
- `client/plugins/network-tools/` — `jinn.runtime` plug-in exposing `search_records`, `inspect_record`, `acquire_artifact`, `get_task` MCP tools.
- `client/plugins/jinn-prediction-plugin/` — combined MCP server (`polymarket`) + skills bundle for `prediction.v1`.
- `client/plugins/learner/` — the bundled harness's own plug-in (Claude/Codex-shaped; not loaded by Hermes).

### 2.8 Reputation is already a Phase B bead

`jinn-mono-0www` — "Phase B: evaluator economics + reputation slashing for harness checkpoints" — owns: evaluator economics design, reputation registry surface for harness operators (slashing on detected freeze-mode violations, untruthful checkpoint publication), challenge mechanism re-homed from the original Phase 1b roadmap. **This epic does not encode stake-backed reputation or slashing**; the read-shape attribution it adds is record-only and feeds 0www when that lands.

## 3. The gap — discovery + builder-shape filter

The substrate ships plug-ins, attributes them per attempt, and aggregates them per operator/SolverNet/HarnessCheckpoint. The bootstrap problem is that **a builder who publishes a plug-in to npm is invisible to operators, and the existing aggregation has no builder-shape view**:

1. **Discovery.** An operator running `jinn solver-nets add-plugin swe-rebench-v2 npm:@builder/<pkg>` works today — but only if they already know the package name. There is no network-level index of "plug-ins submitted for SolverNet X" that an operator can browse. Builders publishing to npm don't surface inside the operator app.
2. **Builder attribution.** Envelopes attribute plug-ins by `{name, version, cid, sha256}`. Nothing on-chain or in the indexer binds those identifiers to a **builder address** (the person who shipped the plug-in). The leaderboard aggregates by operator running the run, not by builder shipping the plug-in.
3. **Cold-start path.** No canonical `/docs/build/` tree; no `jinn create plugin` scaffold (only `jinn create harness` for Path 2 exists). A builder starting cold has no documented walk from "I want to ship a plug-in for SWE-rebench v2" to "my plug-in is running on operator fleets and visible to the network."
4. **Builder-shape SPA surface.** The explorer SPA has per-operator and per-SolverNet views (`ebu7.7`). There is no per-builder filter or "browse submitted plug-ins" landing.

The epic ships the smallest closure of these four.

## 4. End-state acceptance

The epic is shipped when, on testnet, all of the following hold:

1. **First external builder ships a plug-in.** Scaffolds via `jinn create plugin <name>`, edits skills + MCP tools, publishes to npm, registers a submission via `jinn solver-plugins submit` declaring SolverNet compatibility + builder identity. Zero CLI workarounds.
2. **Submission is discoverable in the operator app.** Operator opens the `/build` route (or equivalent surface), browses submitted plug-ins for `swe-rebench-v2.v1`, sees the new plug-in with builder attribution, and installs it via the existing `jinn solver-nets add-plugin` resolver path.
3. **Plug-in runs and scores via the existing pipeline.** Hermes's `hermesConfigFromSolverPlugins()` consumes the plug-in's `.mcp.json` and `skills/`. The attempt completes; the signed envelope's `executor.plugins[]` field carries the plug-in attribution (already in `jinn.execution.v1`); ebu7's HarnessCheckpoint enrichment picks it up.
4. **Score is visible in the builder-shape view.** The `/build` surface filters the existing ebu7 leaderboard by submitted-plug-in and by builder identity; the new plug-in's first verified score is visible alongside other submitted plug-ins for the same SolverNet.
5. **Builder reputation accrues (record-only).** Builder address ↔ submitted plug-in CIDs ↔ aggregated scores is queryable via the Discovery API extension this epic adds. Stake-backed slashing is **explicitly deferred** to `jinn-mono-0www` (Phase B.2).
6. **`/build` SPA route ships** the cold-start walk: intro, plug-in shape catalogue (drawn live from the schema in `client/src/plugins/types.ts`), scaffold instructions, browse-submitted-plug-ins panel (reuses `Leaderboard.tsx`), "your submitted plug-ins" panel for the local operator's builder identity. Reachable from the SPA nav.
7. **Canonical `/docs/build/` tree exists**: quickstart (60-second walk anchored on copying `swe-rebench-v2-runtime/`), shape reference, examples, submission-flow doc, compatibility doc. `jinn create plugin` prints the quickstart URL on completion.
8. **`jinn create plugin <name>` scaffold ships**, producing a package whose `yarn test` passes on first run. Templates under `client/templates/plugins/`. Two patterns: `solver-type-plugin` (modeled on `swe-rebench-v2-runtime`) and `runtime-plugin` (modeled on `network-tools`).
9. **Cold-start E2E acceptance gate green** — a vitest that walks scaffold → publish (local registry) → submit → operator discovers the submission via the Discovery API → operator installs → run task → envelope publishes plug-in attribution → ebu7 reflects it → builder filter on `/build` shows the score. Plus `yarn typecheck` and `yarn build`.

## 5. Children (six problem-shaped beads)

Per `uy6v`'s scope rule, each child is acceptance-criteria-shaped, not solution-shaped. Per-child planning sessions choose the implementation.

### 5.1 Design: submission record + builder-attribution discovery surface

Produces the spec under `spec/`. Decides:

- **Where the submission record lives.** On-chain `SubmissionRegistry` contract vs Discovery-API record (indexed via Ponder per `jinn-mono-280n`) vs IPFS-anchored manifest with on-chain index. Trade-offs around cost, mutability, censorship resistance, and indexer dependence are the planning-session question.
- **Builder identity binding.** Builder address = operator's Safe address (reuses existing identity)? = a separate ed25519 key registered in the submission record (clean separation)? Default for v0: operator's Safe address.
- **Submission record shape.** Minimal: `{ builderAddress, pluginPackageName, pluginVersion, pluginCid, pluginSha256, supports: ['swe-rebench-v2.v1'], submittedAt, signature }`.
- **Discovery API query surface.** Endpoints: list submissions for a SolverNet; list submissions by a builder; join submissions to ebu7's HarnessCheckpoint rollups for score history.
- **Composition with ebu7's existing aggregation.** Cleanly state which fields are sourced from the submission record vs the envelope's `executor.plugins[]` vs HarnessCheckpoint rollups.

Output is a spec (likely `spec/2026-05-<NN>-plug-in-submission-flow.md`) plus a sequence diagram from "builder runs `jinn solver-plugins submit`" → submission record published → Discovery API indexes it → operator browses in `/build` → operator installs → envelope publishes plug-in attribution → ebu7 aggregates → builder filter surfaces score.

### 5.2 `jinn create plugin <name>` scaffold

Extend `client/src/cli/commands/create.ts` with a `plugin` target. Two patterns:

- `solver-type-plugin` — `jinn.supports: [<SolverType>]`; scaffold modeled on `client/plugins/swe-rebench-v2-runtime/`; generates `jinn.plugin.json`, `skills/<name>/SKILL.md`, optional `.mcp.json` + `mcp/<name>-server.mjs`, `package.json`, `test/plugin.test.ts` (validates manifest + tests load via `loadSolverPluginManifest`), `README.md` with a link to the canonical quickstart at `/docs/build/quickstart.md`.
- `runtime-plugin` — `jinn.supports: ['jinn.runtime']`; scaffold modeled on `client/plugins/network-tools/`.

Templates under `client/templates/plugins/<pattern>/`. First-run `yarn install && yarn test` passes. `jinn create plugin --help` documents both patterns and the `--solver-type` / `--out-dir` flags.

### 5.3 Submission registration: `jinn solver-plugins submit`

A new sub-verb on the existing `solver-plugins` command. Inputs: a resolvable plug-in source (npm, git, github, or local path), a target SolverNet, a builder signing key (sourced from the existing operator keystore by default). Outputs: a submission record published to whatever storage §5.1 lands on, plus an emit of the record CID/tx for the operator to retain.

The verb composes with existing `jinn solver-plugins {validate, pack}` — `submit` calls `pack`-equivalent under the hood to compute the package sha256 and CID, then attaches them to the submission claim.

### 5.4 Builder-attribution view in the Discovery API

Discovery API extension. Exposes:

- `GET /submissions?solverNet=<id>` — list submitted plug-ins for a SolverNet, sorted by recency.
- `GET /submissions?builder=<address>` — list a builder's submissions.
- `GET /builders/<address>/scores` — aggregate scores per submitted plug-in for the builder, joining to ebu7's HarnessCheckpoint rollups.

Read-only. The aggregation reuses ebu7's existing rollups by joining on `pluginCid`; no new score aggregation is computed. Implementation likely extends `jinn-mono-280n`'s Ponder indexer with one new entity (`Submission`) and a join, plus thin Discovery-API surfaces over it.

### 5.5 `/build` route in operator SPA + canonical `/docs/build/` tree

Two coupled deliverables; combined because the SPA route's intro card and shape catalogue draw their content live from the docs tree.

- `/build` route: intro card (rendered from `/docs/build/quickstart.md`); plug-in shape catalogue (generated from `SolverPluginManifest` in `client/src/plugins/types.ts` plus the validator's runtime/SolverType mode distinction, so the docs surface stays in sync with the schema by construction); browse-submissions panel (consumes §5.4 API, reuses `client/src/dashboard/spa/src/pages/leaderboard/Leaderboard.tsx`); "your submitted plug-ins" panel (filters by local operator's builder identity).
- `/docs/build/` tree: `quickstart.md` (60-second walk from `swe-rebench-v2-runtime/`-copy through submit), `shape-reference.md` (`jinn.plugin.json` shape, two exclusive modes, `skills/` and `.mcp.json` conventions), `examples.md` (anchored on the in-repo reference plug-ins), `submission-flow.md` (the sequence diagram from §5.1, plain-prose), `compatibility.md` (`jinn.supports` semantics, version pinning, which harnesses load which slots).

`jinn create plugin` prints the `/docs/build/quickstart.md` URL on completion. The `/build` route is added to the SPA nav as a peer of `/operator` and `/launcher`.

### 5.6 Reference competing plug-in + cold-start E2E acceptance gate

Two concerns combined into one bead because they're naturally one piece of evidence:

- A separate published package that demonstrates the full builder loop and serves as the first-integrator artefact (per `spec/2026-04-30-plug-in-surface.md` §6's adaptation of #57 §3 — "the first integrator must have at least as good an experience as the second"). Lives outside `client/plugins/` (either under `examples/plug-ins/<name>/` in this repo or as its own published package). Targets `swe-rebench-v2.v1`. Demonstrates: scaffold → publish → submit → operator install → score.
- A vitest under `client/test/acceptance/` (or wherever the cold-start E2E pattern fits) that walks the loop end-to-end against a stub/fixture daemon: scaffold via `jinn create plugin` → pack → publish to a local npm registry → `jinn solver-plugins submit` → operator's Discovery API surfaces the submission → operator installs (existing path) → stub-Hermes runs a SWE-rebench v2 task with the plug-in loaded → envelope emits `executor.plugins[]` → ebu7-compatible rollup picks it up → `/build` builder-filter shows the score → builder reputation record updates.

## 6. Dependencies

- **`jinn-mono-uy6v`** (first public release) — operator install path and signed-verdict envelope are preconditions for §5.6's E2E. This epic should not begin shipping children until uy6v's release gates are green.
- **`jinn-mono-8psp`** (Hermes harness integration, PR #140–#145) — Hermes is the target harness. The §5.6 E2E and the §4 acceptance both assume `hermesConfigFromSolverPlugins()` is merged and stable.
- **`jinn-mono-280n`** (Discovery API / Ponder indexer) — §5.4 extends it.
- **`jinn-mono-ebu7`** (Network explorer) — §5.4 joins to its HarnessCheckpoint rollups; §5.5 reuses its `Leaderboard.tsx`. ebu7.4, ebu7.6, ebu7.7 are already closed; rdod is awaiting public deploy.

This epic is a **post-v1 epic**. It depends on uy6v's release ship; it does not gate v1.

## 7. Out of scope

- **Path 2 (bring-your-own restorer impl) submission flow** — separate epic for forecaster-shape recruits. The Path 2 substrate (`jinn create harness`, `jinn.manifest.json` schema, capability allow-list, ed25519 signature) already exists; the submission/verification analogue is a parallel epic.
- **Stake-backed reputation slashing** — owned by `jinn-mono-0www` (Phase B.2 evaluator economics).
- **Challenge mechanism** — re-homed to `jinn-mono-0www` from the original Phase 1b roadmap.
- **New cross-operator score aggregation** — already shipped under ebu7.4, ebu7.6, ebu7.7. This epic only adds a builder-shape join over the existing rollups.
- **Verdict envelope extensions for plug-in attribution** — `executor.plugins[]` already exists in `jinn.execution.v1`.
- **Evaluator re-execution with declared plug-in set** — not needed for SWE-rebench v2 (the evaluator scores patches against gold-patch test suites; plug-ins help produce the patch but don't change patch correctness, so re-installing them adds no signal).
- **Cross-harness plug-in travel for non-portable slots** — phase-agent-override and topic-explorer slots live inside the `learner` harness; this epic ships only the harness-portable surface (skills, MCP tools, optional hooks) that Hermes loads via `hermesConfigFromSolverPlugins()`. Wider harness coverage is a follow-on.
- **Plug-in marketplace beyond the browse-submissions panel** — Phase 2+.
- **Hot-reload of plug-ins inside a running daemon** — Phase 2+; consistent with the once-per-process model in `spec/2026-05-external-restorer-impls.md` §3.4.
- **New SolverNets beyond `swe-rebench-v2`** — Ritsu's reframe holds: same SolverNet, different views per harness family. New SolverNets are separate epics.

## 8. Open questions

1. **Submission record location.** Discovery-API row vs on-chain `SubmissionRegistry` contract vs IPFS-anchored manifest with on-chain index. §5.1 is the bead that decides; the design session for that bead should output a DR.
2. **Builder identity binding.** Builder address = operator's Safe address vs a separate ed25519 key. §5.1 needs this decided; defaults to operator's Safe address for v0 simplicity.
3. **`jinn solver-plugins submit` vs a new top-level verb.** Submission is conceptually distinct from the curator-side `show/validate/pack`. Folding under `solver-plugins` (consistent with the current command tree) or splitting to `jinn builder submit` (clearer for the cold-start) are both acceptable; defer to §5.3 planning.
4. **Where the `/build` route lives in the SPA nav.** Top-level alongside `/operator` and `/launcher`, or under a new section. Discussion #129's framing ("the leaderboard doesn't have a single home") suggests `/build` should be a peer of `/operator`, with the builder filter visible from both contexts.
5. **First-integrator candidate.** Section 5.6 commits to publishing one reference plug-in. Which recruit shape it anchors on — Hermes-migrator (per the growth lanes in #129's roadmap comment) vs sovereign-forker vs ERC-8004 builder — is a `GROWTH.md`-touching question; defer to §5.6 planning with input from the growth-target-ecosystem-builders spec.

## 9. References

- `client/src/types/envelope.ts` — the `jinn.execution.v1` envelope with `executor.plugins[]`.
- `client/src/plugins/{manifest,validator,resolvers,registry,digest,index,types}.ts` — existing plug-in runtime.
- `client/src/cli/commands/{create,solver-plugins,solver-nets}.ts` — existing CLI surface to extend.
- `client/templates/harnesses/` — pattern for the new `client/templates/plugins/` analogue.
- `client/plugins/{swe-rebench-v2-runtime,network-tools,jinn-prediction-plugin,learner}/` — reference plug-ins.
- `client/src/dashboard/spa/src/pages/leaderboard/` — existing leaderboard components to reuse.
- `client/src/harnesses/impls/hermes-agent/` (incoming, PR #141) — target harness's plug-in consumption path via `hermesConfigFromSolverPlugins()`.
- `jinn-mono-ebu7` — network explorer (cross-operator aggregation).
- `jinn-mono-0www` — Phase B reputation + challenge mechanism.
- `jinn-mono-280n` — Discovery API + Ponder indexer.
- `spec/2026-04-30-plug-in-surface.md` — Path 1 design parent.
- `spec/2026-05-01-harness-pack-architecture.md` — runtime/SolverType mode distinction.
- `spec/2026-04-30-phase-a-umbrella.md` — Phase A umbrella.
- GitHub Discussion [#129](https://github.com/Jinn-Network/mono/discussions/129) — Sharpening SolverNet 1.
- GitHub Discussion [#59](https://github.com/Jinn-Network/mono/discussions/59) — knowledge-market substrate vision; this epic's compounding-knowledge framing inherits from it.

---

*End of v0.2.*
