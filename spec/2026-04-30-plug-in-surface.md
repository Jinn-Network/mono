# Plug-in surface — default-harness pluggable slots + scaffolding for both recruitment paths

- **Date:** 2026-04-30
- **Author:** opus (drafted on jinn-mono-a9w9; Captain ritsukai)
- **Status:** Proposal
- **Version:** 0.1
- **Tracks:** Phase A.2 of the knowledge-market roadmap

**Sibling specs (load-bearing pre-reads — this spec composes with them, does not redesign them):**

- `spec/2026-04-30-knowledge-market-vision-discussion.md` — Phase A.2 sits in §5 as the open-substrate invitation; this spec is the §6 workstream "Default-harness plug-in surface."
- `log/decisions/2026-04-30-knowledge-market-vision-framing.md` — DR-2026-04-30 framing choice α6 (slot architecture scoped to the default harness implementation; protocol stays narrow; two recruitment paths).
- `spec/2026-04-28-restorer-architecture.md` — ADR: specialists-first; the `claude-code-learner` is one `RestorerImpl` among many, not a substrate wrapper.
- `spec/2026-05-external-restorer-impls.md` — Path 2 loader: dynamic ESM import + factory + `jinn.manifest.json`.
- `spec/2026-05-registry-discovery.md` — Path 2 candidate source: in-repo factory + `restorers.externalImpls`.
- `spec/2026-05-executor-trust-boundary.md` — Path 2 trust: per-impl capability handles + manifest signing + revocation.
- `spec/2026-05-schema-versioning.md` — `kind` grammar + `supportedKinds`.
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — the seven-phase pipeline this spec exposes as plug-in surface.
- `docs/superpowers/plans/2026-04-25-default-learner-plugin.md` — how `claude-code-learner` is structured today.

**Discussion lineage:**

- [#57](https://github.com/Jinn-Network/mono/discussions/57) — Unified GTM around the Prediction SolverNet (Oak). The first-integrator-experience constraint in §3 is addressed in §6 below.
- [#59](https://github.com/Jinn-Network/mono/discussions/59) — Knowledge-market roadmap. Phase A.2 in §5.

---

## 1. Purpose and scope

This spec defines the **plug-in surface** that lets external builders contribute to Jinn without forking the daemon. It commits to **two recruitment paths**, both designed for ergonomics:

- **Path 1 — contribute a plug-in into the `claude-code-learner` impl.** A builder ships one component (a markdown agent, a skill bundle, an MCP tool, a memory backend, a hook) into the seven-phase pipeline of the bundled learning restorer. Lower entry cost; the builder reuses the learner's harness, capabilities, and corpus integration.
- **Path 2 — bring your own restorer impl.** A builder ships a full `RestorerImpl` (or `EvaluatorImpl`) as an npm package, loaded by the daemon via the external-impl loader. Higher control; the builder owns the entire `run(ctx)` surface and competes as a peer of in-repo impls.

Both paths produce supply for the same corpus. Neither requires builders to refactor existing work into a Jinn taxonomy.

### 1.1 In scope

- **Path 1:** plug-in manifest schema, slot taxonomy (mechanical shapes), discovery + install, plug-in lifecycle, scaffolding, prediction-first worked examples.
- **Path 2:** a synthesis layer over the five extension-branch specs — stability commitments, scaffolding (`jinn create restorer`), prediction-first worked examples, recruit-facing documentation shape.
- Cross-cutting: documentation shape per path; integration with the `2026-05-*` family; first-integrator-experience treatment per #57 §3.

### 1.2 Out of scope

- Implementation of any new harness or slot mechanism (this is design-only; implementation lives in follow-up beads).
- Per-component pricing, royalty splits, DRM-style enforcement (off the roadmap per DR-2026-04-30 framing choice 3 — "no royalties / no DRM / single-creator-single-payment").
- Multi-evaluator consensus mechanics (Phase B).
- On-chain plug-in / impl registry (Phase 2 per `2026-05-registry-discovery.md` §3.3).
- Heavy capability allow-listing for Path 1 plug-ins (Path 1 inherits trust from the harness; allow-listing applies only to Path 2 — see §4.3).
- Hot-reload of plug-ins or impls inside a running daemon (Phase 2+; consistent with `2026-05-external-restorer-impls.md` §3.4 once-per-process construction).
- New intent kinds beyond what the codebase already declares (`prediction.v0`, `prediction.apy.v0`, `portfolio.v0`). The worked examples in §3.3 imply Numerai-shape and SN6-shape kinds; their schemas are out-of-scope follow-ups.
- Renames of `RestorerImpl` → `Solver` etc. tracked in `jinn-mono-juw` / GH#43.

### 1.3 Non-goals

- This is not a marketplace spec. Paths 1 and 2 commit **install paths**; a curated marketplace is Phase 2+.
- This is not a recruitment campaign spec. Phase A.4 of the knowledge-market roadmap owns that, in coordination with #57.
- This is not a meta-harness spec. The ADR explicitly rejects substrate-first; the `claude-code-learner` is one impl among many, with a publicly pluggable internal pipeline.

---

## 2. Two recruitment paths

The two paths exist because the recruit population for Phase A.2's Prediction SolverNet is heterogeneous, and forcing them through a single integration shape would mean either (a) heavy ceremony for builders shipping markdown, or (b) refactoring requirements for builders with a working monolith.

### 2.1 Why two

The Phase A.2 audience (per `discover-twitter-recruits/references/audience-profile.md` §2.4 and #57 §1.1) divides cleanly into two cohorts:

- **Cohort with an end-to-end forecaster already running** — Polymarket / Kalshi bot operators, Numerai-orbit forecasters, MiroFish-orbit quants, Bittensor SN6 (Numinous Signals) miners, prediction-tool builders. They have a working pipeline and a question: *"how do I point my bot at Jinn's intent stream?"* — Path 2 fits.
- **Cohort with a single component, not a whole forecaster** — calibration-model authors (isotonic, Platt scaling), ensemble-strategy authors, context-aggregation tool builders, skill authors writing forecasting techniques as prompts, memory-substrate builders. They have a *piece* and a question: *"how do I drop my piece into a working restorer?"* — Path 1 fits.

Path 2 is expected to dominate Phase A.2 by absolute count; Path 1 is the route for builders without a full forecaster, plus the route through which the seven-phase pipeline accumulates community-shipped components.

### 2.2 What both paths share

- **Same protocol surface.** Both paths produce envelopes the corpus indexes the same way; both interact with `JinnRouter` and the existing payment / claim / delivery rails.
- **Same `RestorationContext` shape.** Path 1 runs inside the learner's context (inheriting capabilities); Path 2 receives its own context constructed by the daemon (per `2026-05-executor-trust-boundary.md` §3).
- **Same kind versioning.** Per `2026-05-schema-versioning.md`, both paths declare `supportedKinds` and follow `<domain>.v<major>` grammar.

### 2.3 What the paths do not share

- **Trust model.** Path 2 manifests are signed and trust-pinned per `2026-05-executor-trust-boundary.md` §5. Path 1 plug-ins inherit the learner's trust surface — see §4.3.
- **Discovery.** Path 2 candidates come from the daemon's `restorers.externalImpls` config. Path 1 plug-ins come from npm packages the operator installs into the learner (see §4.4).
- **Capability surface.** Path 2 impls receive scoped capability handles (`signer`, `rpc`, `secrets`, `fs`). Path 1 plug-ins use the harness's existing tools (`Bash`, `Read`, `Write`, `Skill`, `Agent`, `Monitor`) — they cannot widen the capability surface.

---

## 3. Path 2 — bring your own restorer impl

This section is a **synthesis layer** over the five extension-branch specs. Mechanism is defined there; this section commits the additions Phase A.2 needs to make Path 2 recruit-ready.

### 3.1 Stability commitments

External impl authors target a contract surface. Without explicit stability commitments, Phase A.2's recruitment is asking builders to track a moving boundary.

**Phase A.2 commits the following:**

- **`@jinn-network/restorer-sdk` is the contract surface.** Per `2026-05-external-restorer-impls.md` §3.6, the SDK package re-exports `RestorerImpl`, `RestorationContext`, `RestorationOutput`, `ReadyStatus`, `EnableResult`, `IntentEnableMetadata`, `SkippableError`, the capability handle types from trust-boundary §3, and `ExternalRestorerEnv` from §3.3. Builders depend on `@jinn-network/restorer-sdk`, **not** on `@jinn-network/client` directly.
- **Semver discipline.** The SDK follows strict semver. Any breaking change to a re-exported type, a function signature, or an enumerated value MUST land as a major bump.
- **Deprecation window.** From the date a major bump is published, the prior major remains supported for **12 weeks** (consistent with #57 §5.1's component-side reversion threshold). During the window, the daemon accepts manifests declaring either major; after the window, only the new major loads.
- **Additive-only minor bumps.** A new field on `ExternalRestorerEnv`, a new optional method on `RestorerImpl`, a new capability handle on `RestorationContext` ships as a minor — never a major — and pre-existing impls continue to load unchanged.
- **Deprecation surface.** Deprecations are announced in the SDK's `CHANGELOG.md`, a `console.warn` line in the daemon's load path naming the impl + the deprecated surface, and a corresponding entry in the maintainer revocation-list metadata (informational only, not coercive).

**Phase A.2 acceptance includes shipping `@jinn-network/restorer-sdk` v1.0.0 before campaign launch (#57 §5.1 component-side timer starts at SDK ship + first external integration possible).** This is a hard criterion, not a follow-up — see §7.

### 3.2 Scaffolding — `jinn create restorer`

A builder runs:

```bash
jinn create restorer @some-operator/polymarket-forecaster
```

(Verb chosen for ergonomics with the existing `jinn` CLI; if the team prefers a separate `npx create-jinn-restorer` binary the substance is unchanged.)

The scaffolder produces:

```
@some-operator/polymarket-forecaster/
├── package.json                      # depends on @jinn-network/restorer-sdk
├── jinn.manifest.json                # signed at publish time; trust-boundary §5.2
├── src/
│   └── index.ts                      # default-exports the factory
├── test/
│   ├── unit.test.ts                  # vitest, runs against mocked context
│   └── e2e-anvil.test.ts             # spawns Anvil fork, runs full attempt
├── .github/workflows/
│   ├── ci.yml                        # typecheck + test + manifest verify
│   └── publish.yml                   # signs manifest + pins tarball + emits CID
├── README.md                         # filled with the chosen pattern's quickstart
├── tsconfig.json
└── .gitignore
```

The scaffolder asks three questions:

1. **Pattern** — `forecaster` / `evaluator` / `alternative-harness`. Drives the index.ts skeleton (see §3.3).
2. **Kind** — `prediction.v0` / `prediction.apy.v0` / `portfolio.v0` / `<custom>`. Generates the right `supports()` shape and `manifest.supportedKinds` entry. Custom kinds emit a flag pointing to `2026-05-schema-versioning.md` for the kind-design follow-up.
3. **Network** — `base-sepolia` / `base-mainnet` / `<custom>`. Configures the test harness's RPC endpoint.

The scaffolder pre-populates a working test that spawns an Anvil fork, posts a fake intent matching the chosen kind, runs the impl's `run()` against a synthetic `RestorationContext`, and asserts the impl produces a well-formed `RestorationOutput`. The first command after `cd` should be `yarn test` and it should pass.

### 3.3 Worked examples (prediction-first; address #57 §3 first-integrator-experience constraint)

Each pattern below is the seed example shipped under `examples/` in the daemon repo. Phase A.2 acceptance includes that all three are running in CI before campaign launch.

#### 3.3.1 `forecaster` — Polymarket bot wrapper

**Recruit shape:** Polymarket / Kalshi bot operator with a working forecasting pipeline.

**What they ship:** a `RestorerImpl` for `prediction.v0` whose `run()` calls their existing pipeline.

```ts
// @some-operator/polymarket-forecaster/src/index.ts
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ExternalRestorerEnv,
} from '@jinn-network/restorer-sdk';
import { fetchMarketState, computeForecast } from './lib.js';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === 'prediction.v0' && type !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      const market = await fetchMarketState(ctx.intent, ctx.rpc);
      const probability = await computeForecast(market);
      return {
        venueRef: { name: 'polymarket' },
        gating: { probability, marketId: market.id },
        restorationPayload: { /* prediction.v0 payload */ },
      };
    },
  };
}
```

**Manifest:** `supportedKinds: ["prediction.v0>=1.0.0"]`, capability allow-list narrowed to `rpc.method ∈ {eth_call, eth_blockNumber}` (no signer, no writes).

**Anchor:** the existing `client/src/restorer/impls/prediction-v0-baseline/` is the in-repo equivalent — Path 2 builders see a working reference.

#### 3.3.2 `evaluator` — custom scoring rule

**Recruit shape:** evaluator-builder with an alternative scoring approach (log-loss instead of Brier; calibration-decomposition; Numerai-shape continuous loss).

**What they ship:** an `EvaluatorImpl` (`RestorerImpl` with `type='evaluation'`) for an existing kind, producing a `verdictPayload` that conforms to the kind's verdict schema.

The skeleton differs from the forecaster only in `supports()` returning `true` for `type === 'evaluation'` and using `verdictPayload` instead of `restorationPayload`. Manifest declares `capabilities.rpc.methods` covering whatever oracle reads the score requires; no signer. The pre-baked Anvil test posts a synthetic envelope and asserts the evaluator's verdict matches the expected score.

**Anchor:** `client/src/restorer/impls/prediction-v0-evaluator/` is the in-repo reference — deterministic Brier scorer over `oraclePriceAtResolveTs`. Builders see exactly what an evaluator looks like in production.

#### 3.3.3 `alternative-harness` — non-Claude-Code learner

**Recruit shape:** harness builder running Pi.dev, Codex, Gemini CLI, or a custom runtime, who wants to ship the seven-phase pipeline against their environment.

**What they ship:** a `RestorerImpl` that implements the seven-phase pipeline (Orient / Strategize / Plan / Execute / Debrief / Improve / Memory) using their harness's primitives. The `HarnessAdapter` interface in `client/src/restorer/impls/claude-code-learner/types.ts` is the contract reference; the worked example provides a generic Pi.dev sketch.

**Manifest:** `supportedKinds` covers the kinds the harness chooses to claim; capability allow-list mirrors the bundled `claude-code-learner`'s.

**Anchor:** `client/plugins/claude-code-learner/` is the working reference implementation. Builders fork its layout, swap the harness adapter, and target the same `RestorerImpl` contract.

### 3.4 Documentation shape (Path 2)

Builder consumes:

1. **`/docs/path-2/quickstart.md`** — 60-second walkthrough: `jinn create restorer` → edit `src/index.ts` → `yarn test` → publish + sign manifest → `jinn impls add ipfs://...`.
2. **`/docs/path-2/sdk-reference.md`** — generated from the `@jinn-network/restorer-sdk` types. Covers `RestorerImpl`, `RestorationContext`, capability handles, manifest schema.
3. **`/docs/path-2/patterns/<forecaster|evaluator|alternative-harness>.md`** — one walkthrough per pattern, each anchored on the in-repo reference impl.
4. **`/docs/path-2/publishing.md`** — manifest signing, tarball pinning, IPFS publish, sample CI config.
5. **The five `2026-05-*` specs** — load-bearing reference for builders who need to reason about trust, versioning, or registry mechanics.

The README in each scaffold links back to (1)–(4); `jinn create restorer` prints the quickstart URL on completion.

---

## 4. Path 1 — contribute a plug-in into the `claude-code-learner` impl

Path 1 is net-new design. It exposes the `claude-code-learner`'s seven-phase pipeline as a publicly pluggable surface so builders can ship a single component without writing a whole `RestorerImpl`.

### 4.1 Framing — reconciling the ADR with the framing DR

The ADR (`spec/2026-04-28-restorer-architecture.md`) drops the "default" framing from "default-learning-restorer" — the `claude-code-learner` is one impl among many in the registry, opt-in like every other impl. The framing DR α6 says the "default harness implementation has internal slots that get publicly pluggable so external component-builders can drop refiners / judges / planners in without forking."

**Both true. Reconciled:**

- At the **registry / engine level**, the `claude-code-learner` is one impl. It declares `supports()` for the kinds it claims; the engine dispatches to it the same way it dispatches to any specialist.
- At the **plug-in surface level**, the learner has a publicly pluggable internal architecture (the seven-phase pipeline). Builders ship plug-ins INTO that one impl's package; they do not ship into a substrate that wraps every kind.

**The scope of "default" is narrower than the framing DR's wording suggested:** the learner is the *bundled reference implementation* (the harness Phase A.2 ships, the Phase A.4 campaign demonstrates around) without being the *engine-level default* (it's not first-match; it competes via `supports()` like every other impl). This is a vocabulary tightening, not a reversal.

### 4.2 Slot taxonomy — mechanical shapes

The plug-in surface inside `claude-code-learner` decomposes into seven mechanical shapes. Each shape has a fixed material form (markdown vs TS vs MCP server), fixed integration point (which phase / boundary), and fixed inputs/outputs.

| Slot | What you ship | Where it lands | Inputs | Outputs |
|---|---|---|---|---|
| **Phase-agent override** | A markdown agent file with frontmatter (`agents/<role>.md`) | Replaces or augments one of `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator` for declared kinds | Phase-skill spawn prompt + `RestorationContext` slice | Phase artifact under `workingDir/.<phase>/` |
| **Topic explorer** | A markdown agent file + a topic registration in `jinn-plugin.json` | Adds a new topic to Orient and/or Debrief's fan-out | Topic name + scope + intent | `workingDir/.<phase>/<topic>.json` |
| **MCP tool package** | A standalone MCP server (any language; typically TS) declared in `jinn-plugin.json` | Loaded by the harness; tools become available to all phase agents | MCP tool calls | MCP tool responses |
| **Skill bundle** | One or more markdown skills (`skills/<name>/SKILL.md`) declared in `jinn-plugin.json` | Loaded into the harness's skill registry; phase agents can invoke via the `Skill` tool | Skill invocation prompt | Skill response in-session |
| **Memory backend** | A TS module exporting a backend interface (`{ embed, query, prune }`) declared in `jinn-plugin.json` | Replaces or augments the consolidator's storage strategy for `implStateDir` | Per-attempt artifacts + curation policy | Mutations to `implStateDir/memory/<backend>/` |
| **Hook** | A shell script or Node executable declared in `jinn-plugin.json` under `hooks.<event>` | Invoked at session-start, pre-phase, post-phase, or session-end | Phase + context env vars | Side effects + exit code |
| **Full plug-in bundle** | Multiple of the above in one package | Convenient for plug-ins that span multiple slots (e.g., a topic explorer + its MCP tool) | Per-slot | Per-slot |

**Constraints on every slot:**

- **No widening of the daemon's capability surface.** A slot cannot introduce a new RPC endpoint that bypasses `ctx.rpc`, a new signer, or a new filesystem-write target outside `implStateDir/**` and `workingDir/**`. Builders who need new daemon-level capabilities ship Path 2 instead.
- **MCP tool slots are an explicit exception** to the constraint above: an MCP tool runs in its own process and exposes whatever surface the operator vouched for at install time. The harness's MCP-client allow-list is the operator's controlling surface; per-slot allow-listing within Jinn is a §8 open question.
- **No nesting of subagents from inside a spawned subagent.** The phase pattern is one-level-deep; slot agents inherit this constraint.
- **No mutation of the strategy artifact's frozen success criteria + timing posture mid-run.** Per the default-learning-restorer spec §10, the constitutional snapshot is immutable after Strategize.

### 4.3 Trust model — host-inheritance

Path 1 plug-ins **inherit trust from the `claude-code-learner` impl**. There is no per-plug-in capability allow-list, no per-plug-in manifest signature, no per-plug-in revocation. The trust surface that matters is:

1. **The operator decides which plug-ins to install.** `jinn plug-ins add @builder/<pkg>` is an explicit operator action, parallel to `yarn add` — the operator vouches by virtue of installing.
2. **The plug-in inherits the harness's existing capabilities.** Whatever `Bash` / `Read` / `Write` / `Skill` / `Agent` / `Monitor` etc. the harness exposes is what the plug-in's agents and skills can use. The plug-in cannot add new capability surface.
3. **The plug-in's identity is its npm package name + version.** Disambiguation happens by `name` collision rules (same as Path 2's `2026-05-external-restorer-impls.md` §3.4 step 8: name collision excludes the second; operator resolves via uninstall).

**This is intentionally weaker than Path 2's trust model.** The threats Path 2 defends against — capability widening (a malicious impl gaining RPC methods it shouldn't have), key compromise (a signer's manifests retroactively suspect), provenance forgery (a tarball mismatching its CID) — do not apply to a markdown agent that runs inside the learner's existing context with no new capability surface.

The trust-boundary spec (`spec/2026-05-executor-trust-boundary.md`) applies to Path 2 only. A one-paragraph forward-pointer in that spec's §1.2 (out-of-scope) is recommended as a follow-up bead, but the trust contract itself is unchanged.

**Operator-level mitigations Path 1 inherits:**

- **Allow-list at install time.** `jinn plug-ins add` runs an install-time integrity check on the package (the npm tarball's hash matches the package.json, the `jinn-plugin.json` parses, declared slots are recognized).
- **Disable list.** `restorers.disabled` (per `2026-05-registry-discovery.md` §4.1) extends to plug-ins via an analogous `learnerPlugIns.disabled` field. Operators flip a plug-in off without uninstalling.
- **Quarantine on misbehavior.** If a plug-in emits artifacts outside its declared paths, the harness logs and excludes it from the next session.

### 4.4 Plug-in mechanism — manifest, distribution, install

#### 4.4.1 Plug-in manifest (`jinn-plugin.json`)

Every Path 1 plug-in is an npm package with a `jinn-plugin.json` file at its root, alongside the existing `.claude-plugin/plugin.json` (which declares the harness-shaped contents — skills, agents, hooks). The `jinn-plugin.json` is the **Jinn-side declaration** of what the plug-in contributes:

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@some-operator/calibration-refiner",
  "version": "0.1.0",
  "description": "Isotonic-calibration refiner that runs inside Execute on prediction.v0 forecasts.",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0", "prediction.apy.v0"]
  },
  "slots": [
    {
      "type": "phase-agent-override",
      "phase": "execute",
      "agent": "step-worker",
      "scope": { "matchKinds": ["prediction.v0", "prediction.apy.v0"] },
      "entry": "agents/calibration-refiner.md"
    }
  ],
  "author": { "name": "Some Operator", "url": "https://example.com" },
  "license": "MIT",
  "homepage": "https://github.com/some-operator/calibration-refiner"
}
```

**Field semantics:**

| Field | Purpose |
|---|---|
| `schemaVersion` | The plug-in manifest's own schema version. Phase A.2 ships `1.0.0`. Breaking changes follow the same 12-week deprecation window as the SDK. |
| `name`, `version` | npm package identity. Both MUST match `package.json`. Mismatch → install-time refusal. |
| `compatibility.claudeCodeLearner` | semver range against the learner package's version. Out-of-range → loaded with a warning, expected to break. |
| `compatibility.supportedKinds` | Per `2026-05-schema-versioning.md` grammar. The plug-in declares which kinds its slots apply to. |
| `slots[]` | Array of slot declarations. Each entry names the slot type (per §4.2 taxonomy), the integration point (phase + agent for phase-agent overrides; phase + topic for topic explorers; etc.), an optional `scope` predicate (matching kinds, intent specs, or operator policy), and the `entry` path within the package. |
| `author`, `license`, `homepage` | Standard metadata. Surfaced in `jinn plug-ins list`. |

**The `jinn-plugin.json` is JSON-schema validated at install time and at session start.** A plug-in with an unrecognized `slot.type` is excluded with a clear error referencing the §4.2 taxonomy.

#### 4.4.2 Distribution

Path 1 plug-ins distribute as **npm packages**. Builders publish to npm (or GitHub Packages, or any npm-compatible registry). Operators install via npm:

```bash
yarn add @some-operator/calibration-refiner
jinn plug-ins add @some-operator/calibration-refiner
```

The two-step shape mirrors Path 2's `yarn add` + `jinn impls add`. The `jinn plug-ins add` step:

1. Reads `node_modules/@some-operator/calibration-refiner/jinn-plugin.json`.
2. Validates `name` and `version` match `package.json`.
3. Validates the compatibility range against the bundled learner version.
4. Validates each `slots[]` entry's `entry` path exists.
5. Appends to `~/.jinn-client/config.json` under `learnerPlugIns[]`.

**Per the `jinn plugin install` collision** (existing CLI verb that installs the Jinn MCP server / skill into AI hosts): Path 1 uses the **plural** verb `jinn plug-ins ...` to disambiguate. The two commands are explicitly distinct surfaces in the CLI help text.

#### 4.4.3 Discovery + load at session start

The `claude-code-learner` impl, at session start, walks `config.learnerPlugIns[]` and:

1. For each plug-in entry, resolves the package, reads `jinn-plugin.json`, validates compatibility against the running learner version.
2. For each declared slot, registers it into the harness's slot registry for the session.
3. The phase skills, when sequenced by the coordinator, consult the slot registry: if a phase-agent override matches the current `(phase, agent, kind)` tuple, the override agent is spawned in place of the bundled agent. Topic explorers extend the orient/debrief topic set. MCP tools are registered with the harness's MCP client. Skill bundles register with the `Skill` tool. Memory backends and hooks plug in at their respective integration points.
4. Misbehaving plug-ins (emitting artifacts outside declared paths, claiming kinds outside their `supportedKinds`, throwing during slot construction) are excluded for the rest of the session; the failure is logged and surfaced via `status.fleet.needsAttention`.

#### 4.4.4 Lifecycle

Path 1 plug-ins follow the same **once-per-process** lifecycle as Path 2 impls (per `2026-05-external-restorer-impls.md` §3.4). The learner reads `config.learnerPlugIns[]` at boot; changes require a daemon restart. Hot-reload is Phase 2+, consistent with the rest of the substrate.

#### 4.4.5 Versioning + compatibility

- The **plug-in manifest schema** (`jinn-plugin.json` shape) follows semver with the same 12-week deprecation window as the SDK.
- The **`claude-code-learner` package** (the bundled harness) follows semver. Breaking changes to the slot registration interface, the phase-agent contracts, or the manifest schema bump the major.
- A plug-in's `compatibility.claudeCodeLearner` field declares which learner majors the plug-in supports. The learner refuses to load a plug-in that declares an out-of-range compatibility, with an actionable error message pointing at the upgrade path.

The seven-phase pipeline contract is the de facto **stable surface for plug-in authors**, mirroring `RestorerImpl` for Path 2 authors. Phase A.2 commits to not breaking it before Phase A campaign launch.

### 4.5 Layer→shape mapping (recruit-facing translation of #57's component map)

Oak's #57 §3 names component layers (forecaster / refiner / judge / registry / ground-truth / marketplace / model / harness / skill-config). The mechanical shapes in §4.2 are the **canonical surface**; the mapping below translates Oak's vocabulary for recruits who think in those terms. The mapping is illustrative, not normative — a builder's actual contribution may span multiple shapes.

| #57 layer | Path 1 shape | Path 2 shape | Notes |
|---|---|---|---|
| **Forecaster** | (typically full impl) | Full `RestorerImpl` | Most prediction recruits land here. |
| **Refiner** | Phase-agent override (Execute step-worker, or a post-Execute pass via the `analyst` override pattern) | — | Calibration models, adversarial CoT, ensemble strategies. |
| **Judge** | (collapses with evaluator) | Evaluator `RestorerImpl` (`type='evaluation'`) | For prediction-shaped intents, judge + ground-truth = deterministic evaluator. |
| **Registry** | (not a slot) | (not a slot) | Infrastructure layer; consumed by Orient/Debrief topics via MCP tools or the corpus library (Phase A.1). |
| **Ground-truth** | MCP tool package (oracle wrapper) | (built into the evaluator impl) | Polymarket resolution API, Pyth, Chainlink, etc. |
| **Marketplace** | (not a slot) | (not a slot) | Downstream app outside the protocol. |
| **Model** | (not a slot) | (configured by harness) | Runtime configuration, not code. |
| **Harness** | (not a slot — that's the learner itself) | `alternative-harness` pattern in §3.3.3 | Pi.dev, Codex, Gemini CLI implementations of the seven-phase pipeline. |
| **Skill-config** | Skill bundle | (impl-internal) | Markdown skills the strategist / planner / etc. can load. |

**Layers that are explicitly not slots:** Registry (infra; consumed via tools), Marketplace (downstream app), Model (config), Judge-as-separate-from-evaluator (collapsed for prediction-shaped intents). Builders working on those surfaces are not Phase A.2 targets — they ship at the infra or app layer.

### 4.6 Scaffolding — `jinn create plug-in`

A builder runs:

```bash
jinn create plug-in @some-operator/calibration-refiner
```

The scaffolder asks two questions:

1. **Slot type** — `phase-agent-override` / `topic-explorer` / `mcp-tool` / `skill-bundle` / `memory-backend` / `hook` / `bundle`. Drives the per-slot template.
2. **Phase / agent / topic** — the integration point for slots that need it (`phase-agent-override` → which phase + which agent; `topic-explorer` → which phase + topic name; etc.). Defaults to the most common pick per slot type.

The scaffolder generates:

```
@some-operator/calibration-refiner/
├── package.json
├── .claude-plugin/
│   └── plugin.json                   # Claude Code-shaped declaration
├── jinn-plugin.json                  # Jinn-side declaration
├── agents/                           # for phase-agent-override / topic-explorer
│   └── calibration-refiner.md
├── skills/                           # for skill-bundle
│   └── (empty)
├── tools/                            # for mcp-tool
│   └── (empty)
├── hooks/                            # for hook
│   └── (empty)
├── test/
│   └── plugin.test.ts                # validates manifest + entry paths + simulates session-start load
├── README.md                         # filled with the chosen slot's quickstart
└── tsconfig.json
```

The scaffolder pre-populates a working test that loads the plug-in's `jinn-plugin.json`, simulates the learner's session-start discovery, and asserts the plug-in registers cleanly. The first command after `cd` is `yarn test` and it should pass.

### 4.7 Worked examples (prediction-first; one per slot category)

Each example below ships under `examples/learner-plug-ins/` in the daemon repo. Phase A.2 acceptance includes that all six examples are working in CI before campaign launch.

#### 4.7.1 Phase-agent override — isotonic-calibration refiner

**Recruit shape:** calibration-model author (Silverarrow-shape) with an isotonic regression that improves any forecaster's probability estimates.

**Slot:** `phase-agent-override`, phase `execute`, agent `step-worker`, scope `{ matchKinds: ['prediction.v0'] }`.

**What they ship:** a markdown agent file that, when spawned by Execute as the step-worker for a `prediction.v0` step, takes the forecaster's raw probability + a calibration history (read from `implStateDir/calibration/history.json`), applies isotonic regression, and writes the calibrated probability to `workingDir/.execute/<step-id>/output.json` with a `calibration_diff` field for Debrief's analyst.

The agent's frontmatter declares `tools: [Bash, Read, Write]`; no new capabilities. The plug-in's README includes a sample `implStateDir/calibration/history.json` so operators can validate the agent end-to-end before posting real intents.

#### 4.7.2 Topic explorer — `news-context` topic in Orient

**Recruit shape:** context-aggregation builder with a curated news + macro feed.

**Slot:** `topic-explorer`, phase `orient`, topic `news-context`, scope `{ matchKinds: ['prediction.v0'] }`.

**What they ship:** a markdown agent that, when spawned by Orient with topic `news-context`, fetches relevant news (via an MCP tool also shipped in the package — see §4.7.3 for the cross-reference shape) for the prediction window, extracts entities + sentiment, and writes `workingDir/.orient/news-context.json` for Strategize to consume.

The plug-in's `jinn-plugin.json` declares both the topic explorer and an `mcp-tool` slot for the news-fetcher; the two compose by `bundle` shape (§4.2).

#### 4.7.3 MCP tool package — `polymarket` tool surface

**Recruit shape:** prediction-tool builder with a Polymarket API integration.

**Slot:** `mcp-tool`, exposed as a standalone MCP server.

**What they ship:** an MCP server with tools `polymarket_market_state`, `polymarket_resolution`, `polymarket_recent_volume`. The plug-in's `jinn-plugin.json` declares the MCP tool slot pointing at the server's entrypoint; the harness loads the server at session-start and registers its tools.

The MCP tool runs in its own process per the existing MCP convention; capabilities scoped at the server level. (This is the one slot category where the plug-in adds capability surface — by virtue of being a separate process. The trust posture is "the operator vouched by installing it." Operators with stricter requirements run an MCP allow-list at the harness's MCP-client level — see §8 open question 4.)

#### 4.7.4 Skill bundle — `forecasting-techniques` for the strategist

**Recruit shape:** skill author with documented forecasting techniques (calibration, base rates, reference-class forecasting, prediction-market-specific patterns).

**Slot:** `skill-bundle`, skills available to all phase agents via the `Skill` tool.

**What they ship:** a directory of `skills/<name>/SKILL.md` files with frontmatter and prompt bodies. The strategist subagent, when generating candidate approaches, can `Skill `forecasting-techniques:reference-class-forecasting`` to load the technique into context. The plug-in's `jinn-plugin.json` declares the skill bundle; the harness registers each skill into its loadable-skills index at session-start.

#### 4.7.5 Memory backend — vector-store consolidator

**Recruit shape:** memory-substrate builder with a vector-store + embedding-service integration.

**Slot:** `memory-backend`, replaces or augments the bundled consolidator's storage strategy.

**What they ship:** a TS module exporting `{ embed, query, prune }` against a vector store (Pinecone, Weaviate, local FAISS, etc.). The bundled consolidator agent, when curating prior debrief artifacts, calls the backend's `embed` to index them and `query` to retrieve analogous cases for future Orient passes. The plug-in's `jinn-plugin.json` declares the backend module's path; the harness loads it at session-start and the consolidator picks it up via a small adapter shim.

This is the slot category most likely to need additional capability scoping (network access to a hosted vector store). The §4.3 "host-inheritance" trust model still holds: the operator vouched by installing; if the operator wants stricter controls, they run a local backend instead.

#### 4.7.6 Hook — `pre-orient` market state pre-fetch

**Recruit shape:** infrastructure-tool author with a pre-fetch optimization.

**Slot:** `hook`, event `pre-phase`, phase `orient`.

**What they ship:** a shell script that runs before Orient is invoked, pre-fetches the relevant Polymarket / Kalshi market state, and writes it to `workingDir/.cache/markets.json`. Orient's explorers read from the cache instead of re-fetching, saving budget on the time-sensitive boundary.

The hook script's frontmatter declares its event + phase; the harness invokes it via the existing session-start hook conventions (`client/plugins/claude-code-learner/hooks/session-start` is the exact reference shape).

### 4.8 Documentation shape (Path 1)

Builder consumes:

1. **`/docs/path-1/quickstart.md`** — 60-second walkthrough: `jinn create plug-in` → edit slot file → `yarn test` → publish to npm → `jinn plug-ins add` on operator side.
2. **`/docs/path-1/slot-reference.md`** — generated from §4.2 taxonomy; includes per-slot integration points, inputs, outputs, capability constraints.
3. **`/docs/path-1/manifest-reference.md`** — generated from §4.4.1 schema; includes the JSON schema source and validation examples.
4. **`/docs/path-1/examples/<slot>.md`** — one walkthrough per slot category, anchored on the §4.7 worked examples.
5. **`/docs/path-1/compatibility.md`** — version compatibility, deprecation policy, upgrade path.

The README in each scaffold links back to (1)–(4); `jinn create plug-in` prints the quickstart URL on completion.

---

## 5. Cross-cutting integration with the `2026-05-*` family

This spec composes with the five extension-branch specs. Net-zero correctness changes are required to any of them; the additions below are recommended as follow-up beads.

### 5.1 `2026-04-28-restorer-architecture.md` (ADR)

- **No change required.** The ADR's specialists-first decision is consistent with §4.1 of this spec.
- **Recommended follow-up bead:** add a forward-pointer in §1.1 to this spec as the place where the `claude-code-learner`'s internal plug-in surface is formalized.

### 5.2 `2026-05-external-restorer-impls.md` (Path 2 loader)

- **No change required.** The loader contract holds.
- **Promotion in this spec:** §3.6 (the `@jinn-network/restorer-sdk` package) moves from "follow-up bead" to **Phase A.2 hard acceptance criterion** (see §3.1 + §7 below).
- **Recommended follow-up bead:** add the prediction-shaped worked examples from §3.3 to the loader spec's §5.

### 5.3 `2026-05-registry-discovery.md` (Path 2 candidate source)

- **No change required.** The two-source model holds for Path 2.
- **Recommended follow-up bead:** add a §1.2 cross-reference noting that Path 1 plug-ins have a separate discovery mechanism (npm + `jinn-plugin.json`) defined in this spec's §4.4.

### 5.4 `2026-05-executor-trust-boundary.md` (Path 2 trust)

- **No change required.** The trust contract applies to Path 2 only.
- **Recommended follow-up bead:** add a §1.2 (out-of-scope) line clarifying that Path 1 plug-ins inherit trust from the host harness and do not carry their own capability allow-list, with a forward-pointer to this spec's §4.3.

### 5.5 `2026-05-schema-versioning.md` (kind grammar)

- **No change required.** The grammar applies uniformly to both paths' `supportedKinds` declarations.
- **Note for kind-design follow-ups:** Numerai-shape continuous-numeric and SN6-style time-series asset forecasts will need new kinds (e.g., `prediction-numeric.v0`, `prediction-asset-return.v0`); their schemas are out-of-scope here but follow the existing grammar.

### 5.6 Default-learning-restorer design spec

- **No change required.** The seven-phase pipeline this spec exposes as plug-in surface is the v1.1 design.
- **Recommended follow-up bead:** add a §13 cross-reference to this spec as the place where the pipeline becomes publicly pluggable.

---

## 6. First-integrator-experience constraint (#57 §3)

Per #57 §3: *"The first integrator at any layer should have at least as good an experience as the second. Pre-bake at least one worked example per layer at the warmest existing candidate before the campaign begins recruiting at that layer. The proof point that unlocks the next recruit must not also be the highest-friction recruit."*

Phase A.2 addresses this by:

1. **Per-slot worked examples (§4.7)** — six examples, each anchored on a recruit shape from `discover-twitter-recruits/references/audience-profile.md` §2.4. Each example is a working npm package shipped under `examples/learner-plug-ins/` with passing CI.
2. **Per-pattern Path 2 worked examples (§3.3)** — three examples (forecaster, evaluator, alternative-harness) anchored on existing in-repo references. Each is a working scaffold shipped under `examples/external-restorer-impls/` with passing CI.
3. **Both scaffolders produce passing tests on first run.** `jinn create restorer` and `jinn create plug-in` generate packages whose `yarn test` passes immediately. Builders' first 60 seconds are a working build.
4. **Both paths' documentation links to the in-repo references** (`prediction-v0-baseline`, `prediction-v0-evaluator`, `claude-code-learner`). Builders see real working code, not just type signatures.
5. **Specific candidate-naming is deferred to the discovery skill.** This spec defines the per-shape templates; Oak's `discover-twitter-recruits` skill identifies the warmest concrete candidates per layer + their conversion shape. The pre-baked examples are calibrated to the recruit profiles in the audience-profile doc rather than to one named individual.

The campaign-launch gate (#57 §5.1) starts when the technical surface is in place, which Phase A.2 acceptance defines as **all eight examples passing CI + both scaffolders shipping + `@jinn-network/restorer-sdk` v1.0.0 published + Path 1 + Path 2 documentation indices complete**.

---

## 7. Acceptance criteria

This spec is accepted when:

1. **It is merged under `spec/`.**
2. **The five extension-branch specs receive their cross-references** (see §5; recommended follow-up beads, not gating).
3. **`@jinn-network/restorer-sdk` v1.0.0 is published** with the public types from `2026-05-external-restorer-impls.md` §3.6, semver-tracked. (Phase A.2 hard criterion.)
4. **Both scaffolders ship and produce passing tests on first run:** `jinn create restorer` (Path 2) and `jinn create plug-in` (Path 1).
5. **Three Path 2 worked examples** under `examples/external-restorer-impls/` (forecaster, evaluator, alternative-harness) with passing CI.
6. **Six Path 1 worked examples** under `examples/learner-plug-ins/` (one per slot category in §4.2) with passing CI.
7. **Documentation indices complete:** `/docs/path-1/` and `/docs/path-2/` per §3.4 and §4.8.
8. **The plug-in manifest JSON schema (§4.4.1) is published** under `client/schemas/jinn-plugin.json` and validated by both the install verb and the session-start loader.
9. **CLI verbs ship:** `jinn create restorer`, `jinn create plug-in`, `jinn plug-ins list / add / remove / show`. (The Path 2 `jinn impls *` verbs are scoped by `2026-05-external-restorer-impls.md` §7.2.)
10. **The framing-DR reconciliation in §4.1 is reflected in the default-learning-restorer design spec's §13** as a cross-reference.

The campaign-launch gate (#57 §1) is **not** acceptance for this spec — it is acceptance for Phase A.4. This spec ships the surface that makes Phase A.4 possible.

---

## 8. Open questions

1. **CLI verb naming for Path 1 install.** This spec proposes `jinn plug-ins add @builder/<pkg>` (plural noun) to disambiguate from the existing `jinn plugin install` (singular verb, for AI-host plugins). If the team prefers fully renaming one to remove ambiguity (e.g., `jinn plug-ins add` ↔ `jinn host-plugin install`), that's a CLI follow-up bead, not a substrate change.
2. **Scaffolding command shape.** This spec proposes `jinn create restorer` and `jinn create plug-in`, using the existing `jinn` CLI. An alternative is a separate `npx create-jinn-restorer` / `npx create-jinn-plug-in` per the npm community convention. Both are viable; `jinn create *` keeps single-tool ergonomics.
3. **Memory-backend capability scoping.** Path 1's host-inheritance model is right for the §4.7.5 vector-store example only when the operator vouched. Operators wanting stricter controls (no network egress from a memory backend) may need a per-plug-in capability declaration. Phase A.2 defers; if a recruit hits this, the resolution is "ship a local memory backend (FAISS) or move to Path 2."
4. **MCP tool allow-listing.** Path 1's MCP tool slot (§4.7.3) is the slot category with the largest implicit capability surface (an MCP server runs in its own process with whatever the OS grants it). Operators with stricter requirements may want to allow-list MCP tool slots at the harness level. Phase A.2 punts to the harness's MCP-client allow-list (already a Claude Code feature for first-party plugins); a Jinn-specific layer is a follow-up.
5. **Numerai-shape and SN6-shape kinds.** §3.3.1's forecaster example uses `prediction.v0`. Worked examples for Numerai-orbit and SN6 recruits will need `prediction-numeric.v0` (continuous outcome) and `prediction-asset-return.v0` (time-series) kinds. Their design lives in their own beads; Phase A.2 worked examples ship the shapes the codebase already supports (`prediction.v0`, `prediction.apy.v0`) until those new kinds land.
6. **Plug-in marketplace.** Phase A.2 distributes via npm. A curated marketplace (operator-discoverable list of vetted plug-ins) is Phase 2+ and aligns with the on-chain registry deferral in `2026-05-registry-discovery.md` §3.3 / §3.4.
7. **Cross-plug-in dependencies.** A Path 1 plug-in MAY depend on another Path 1 plug-in (e.g., a topic explorer that needs an MCP tool). Phase A.2 defers an explicit dependency-graph mechanism; the §4.7.2 + §4.7.3 example uses the `bundle` shape (one package, multiple slots) as the workaround. If real cross-package dependencies emerge, a follow-up extends `compatibility.requires`.
8. **Operator-side selection within a slot.** When two installed plug-ins both declare a `phase-agent-override` for the same `(phase, agent, kind)` tuple, the harness needs a tie-break. Phase A.2 defers; the tentative resolution is operator-config-ordered (last-installed wins, configurable). The §4.4.3 lifecycle's "name collision excludes the second" rule applies for now.

---

*End of v0.1.*
