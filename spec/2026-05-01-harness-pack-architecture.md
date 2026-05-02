# SolverNet architecture — Harness, SolverNet contracts, plugin packs, and Task semantics

- **Date:** 2026-05-01
- **Author:** opus (drafted on jinn-mono-dwqm; Captain ritsukai)
- **Status:** Proposal
- **Version:** 0.9
- **Tracks:** Phase A.2 reframe — supersedes the wrapper-with-specialist construct introduced in PR #63; replaces `spec/2026-04-30-plug-in-surface.md` Path 1 with a harness-agnostic SolverPlugin mechanism that extends existing AI-tool plugin formats.

**Sibling specs (load-bearing pre-reads):**

- `spec/2026-04-28-restorer-architecture.md` — ADR: specialists-first; `claude-code-learner` is one impl among many. This spec re-aligns the implementation with the ADR after a drift in PR #63.
- `spec/2026-04-30-plug-in-surface.md` — the spec this one supersedes for Path 1. Path 2 commitments hold under the renames in §11.
- `spec/2026-05-external-restorer-impls.md` / `spec/2026-05-executor-trust-boundary.md` / `spec/2026-05-registry-discovery.md` / `spec/2026-05-schema-versioning.md` — Path 2 substrate. All five hold under the rename `RestorerImpl → Harness`.
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — the seven-phase pipeline. Stays as the bundled learner's internal architecture; the wrapper layer is removed.

**Discussion lineage:**

- [#57](https://github.com/Jinn-Network/mono/discussions/57) — Prediction SolverNet GTM. The "client as meta-harness" framing is *implemented as registry-default-Harness + plugin-aware loading*, not as an every-SolverType wrapper.
- [#59](https://github.com/Jinn-Network/mono/discussions/59) — knowledge-market roadmap. The "harness-level compounding" claim is what the learner does end-to-end inside its own implStateDir; this spec resolves how that fits with peer Harnesses that don't learn.

**Bead lineage:**

- `jinn-mono-dwqm` — "Learning loop excludes Path 2 specialist behaviour." This spec resolves that bead by *removing the construct that created the problem* (the universal wrapper) rather than patching around it.
- `jinn-mono-juw` / GH#43 — `RestorerImpl → Harness` rename. Lands as part of this spec.

---

## 0.1 2026-05-02 contract-registry amendment

The implementation now treats the `SolverNetContract` registry as the authority for a SolverNet's schemas, credential requirements, evaluation function, aggregation function, and claim defaults. Portable first-party contract definitions live in `@jinn-network/sdk/solvernets` and first-party SolverNet helpers live under SolverNet subpaths such as `@jinn-network/sdk/solvernets/prediction-v1`. Plugin packs are optional substrate for Harnesses and host runtimes. They may declare `jinn.supports: ["<solverType>"]`, MCP servers, skills, and capabilities, but they do not define canonical schemas or validity rules.

This amendment supersedes older "canonical SolverPlugin" language in this document:

- A SolverNet is `solverType + SolverNetContract + starting Harness + optional runtime plugin packs + optional Task generator`.
- `canonicalPlugin` is not part of config or runtime provenance.
- `jinn.solverType` and `jinn.schemas` are removed from Jinn plugin manifests.
- Schema validation is client-owned and keyed by the loaded SolverNet contract.
- The protocol does not constrain solver-side external data use. Solvers may bring their own Harnesses, plugins, tools, memories, and data subscriptions.
- Three functions are distinct: eligibility function (`candidate -> Task/no Task`), evaluation function (`Task + Solution + resolution -> Verdict`), and aggregation function (`Verdicts -> SolverNet score/ranking/dashboard metric`).

---

## 1. Purpose and scope

### 1.1 What this spec commits

Five coordinated architectural moves that re-align the implementation with what the Phase A.2 spec already said and what the original learner design intended:

1. **Delete the universal wrapper.** `claude-code-learner` becomes a peer Harness in the registry, not a substrate that wraps every SolverType. Its `supports()` returns `true` for any non-evaluation restoration; it is the registry's *default* when no other Harness claims a SolverType. It owns its `run()` end-to-end.
2. **Rename `RestorerImpl → Harness`** and the protocol role **`Restorer → Solver`**. The thing-an-operator-runs is a Harness; the protocol role they fulfil is Solver. The rename disambiguates role from implementation and unifies the vocabulary cluster (SolverNet / SolverType / SolverPlugin / Solver / Solution).
3. **Introduce SolverNet contracts and plugin packs.** A SolverNet contract is the SDK-backed authority for a SolverType's schemas, credential requirements, evaluation function, aggregation function, and claim defaults. Plugin packs are harness-agnostic optional substrate — MCP-tool servers, skills, and host packaging that an operator may plug into their Harness. A plugin pack can be a Claude Code plugin, a Gemini extension, and a Jinn-supporting pack at the same time, but its `jinn` section declares support/capabilities, not canonical schema authority.
4. **Introduce SolverNets and Tasks as distinct levels.** A SolverNet is the campaign / group / objective. A Task is one posted item — the on-chain unit a Solver claims and produces a Solution for. The SolverNet declares one SolverType; many Tasks of that SolverType flow through it.
5. **Ship the Prediction SolverNet as the first instance.** `prediction.v1` ships as an in-repo SolverNet contract. `@jinn-network/prediction-plugin` ships as an optional reference pack. The starting Harness plus optional pack is what the GTM in #57 calls the "client as meta-harness" running against the Polymarket-derived Task stream.

### 1.2 In scope

- The SolverNet contract shape and the plugin-pack manifest shape (extension of existing host plugin formats).
- The Harness interface (renamed from `RestorerImpl`) and its plugin-loader.
- The Task vocabulary (renamed from `intent` / `RestorationJob`).
- The Solution / Verdict output vocabulary (renamed from `RestorationOutput`).
- Registry resolution rules (`bySolverType` + default; Path 2 trumps default).
- The `prediction.v1` SolverNet contract and optional `@jinn-network/prediction-plugin` reference pack.
- Migration of `prediction-v0-baseline`, the existing `client/src/intents/kinds/` modules, and the wrapper code paths.
- Trust-boundary disposition (SolverPlugin content vs. Harness code vs. operator state).
- The "SolverNet" composition pattern (SolverType + SolverNet contract + objective/aggregation + starting Harness + optional runtime plugins + Task generator).

### 1.3 Out of scope

- Implementation of the rename PR itself (the renames are *committed* here; mechanical execution lives in follow-up beads).
- Per-component royalty / pricing / DRM (continues to be off the roadmap per DR-2026-04-30).
- Multi-evaluator consensus mechanics (Phase B).
- Hot-reload of SolverPlugins or Harnesses inside a running daemon (Phase 2+; consistent with `2026-05-external-restorer-impls.md` §3.4).
- An on-chain SolverPlugin registry (Phase 2+; analogous to the impl-registry deferral).
- Tight coupling of Task-on-chain to a specific plugin-pack CID (plugins are optional helper packs in v1).
- Path 1 in its previous form. The phase-agent-override / topic-explorer / hook / memory-backend slot taxonomy from `spec/2026-04-30-plug-in-surface.md` §4.2 is *retired* in favour of the SolverPlugin mechanism. Path 1's recruit story becomes "ship a SolverPlugin" (harness-agnostic) or "fork the learner template" (harness-specific). See §11.6.

### 1.4 Non-goals

- This spec does not commit a marketplace.
- This spec does not redefine the protocol layer. JinnRouter, IdentityRegistry, ValidationRegistry, ReputationRegistry, ClaimRegistry, x402, ERC-8004 — all unchanged in shape; only the Task payload's `spec.kind` moves to top-level `solverType` (carrying the SolverType identifier) per §11.4.
- This spec does not define a new Harness alongside `claude-code-learner`. Alternative Harnesses (Pi.dev / Codex / Gemini-CLI ports) are recruit targets — they ship their own plugin-loaders when they appear.

---

## 2. Glossary

| Term | Definition |
|---|---|
| **SolverNet** | A composition: (SolverType + SolverNet contract + objective/aggregation + starting Harness + optional runtime plugin packs + optional Task generator). The campaign / group level. The Prediction SolverNet is the first instance. Defined in operator config and a reference in-repo; not a protocol object. The daemon loads the repo-native SolverNet contract by `solverType`. |
| **SolverNetContract** | The repo-native authority for a SolverNet: Task/Solution/Verdict schemas, claim-policy defaults, credential requirements by role, evaluation-function ID/implementation, aggregation-function ID, and optional reference plugin packs. |
| **Objective** | The public scalar a SolverNet rallies around. For the Prediction SolverNet: spread vs. Polymarket consensus. Trend matters more than level (#57 §5). |
| **SolverType** | The schema-versioned identifier a Task's spec conforms to. Examples: `prediction.v1`, `prediction.apy.v0`, `portfolio.v0`. Grammar per `spec/2026-05-schema-versioning.md`. The on-chain `solverType` carries this identifier as the protocol-level join key; the in-repo SolverNet contract defines schemas and evaluation semantics for first-party SolverTypes. |
| **SolverPlugin / plugin pack** | An optional harness-agnostic package for a SolverNet — supplies MCP servers, skills, host packaging, and optional capabilities. It may declare `jinn.supports` for one or more SolverTypes. It is not authoritative for schemas or evaluation rules. |
| **Task** | The on-chain posted item. Today: `JinnRouter.createRestorationJob`'s product. Carries a `taskCid` referencing the IPFS-stored Task. The Solver claims a Task, runs it via their Harness, and submits a Solution. |
| **Solution** | The Solver's output for a Task. The thing today called `RestorationOutput`. |
| **Verdict** | The Evaluator's output scoring a Solution. Carries a `verdictPayload` (kept; protocol-level field). |
| **Harness** | The runtime an operator runs to claim and solve Tasks. The thing today called `RestorerImpl`. Implements the Solver protocol role. May or may not be plugin-aware; may or may not learn. Owns its flow, improve-phase, and tunables. |
| **HarnessContext** | The runtime context the daemon hands to a Harness's `run()` method — the bundle of inputs and capabilities a Harness has to do its work. Carries: the `Task`, the `taskCid`, an `implStateDir` (the Harness's persistent state directory), a `workingDir` (ephemeral, cleared between attempts), a `log` callback, an `abort` `AbortSignal`, an `msUntilEndTs` deadline accessor, a `trajectory` collector for span emission, and (when the daemon is providing them per the Harness's manifest allow-list) scoped `signer` / `rpc` / `secrets` capability handles per `spec/2026-05-executor-trust-boundary.md` §3. Defined in `client/src/harnesses/types.ts`. See §7.2.1. |
| **Solver** | A protocol role (Creator / Solver / Evaluator) — and the operator who fulfils it. The Solver claims a Task, runs it via their Harness, and submits a Solution. Renamed from `Restorer` (the on-chain function name `createRestorationJob` and other deployed-contract identifiers stay; the conceptual role label changes — see §11.2). |

---

## 3. First-principles model

Two levels with distinct concerns; primitives at each level keep clean boundaries:

```
─── Level 1 (group / persistent definition) ────────────────────────────────
     SolverNet (operator config + reference in-repo)
       ├── name
       ├── solverType         → schema-versioned identifier (e.g., "prediction.v0")
      ├── contract           → SDK-backed SolverNetContract for schemas/eval/credentials/defaults
       ├── objective          → public scalar + aggregation rule
       ├── taskGenerator      → posts Tasks on a cadence (optional)
       ├── plugins            → optional runtime/helper packs
       └── startingHarness    → recommended Harness for new operators (operators DO swap this)

     `solverType` MUST resolve to a registered SolverNetContract. Runtime
     plugin packs are validated against `jinn.supports` when present, but
     they do not make a SolverNet valid.

─── Level 2 (per-item / ephemeral) ──────────────────────────────────────────
     Task (one per posted item; many per SolverNet)
       ├── on-chain           → JinnRouter object with escrow + eligibility
       └── Task payload (IPFS) → solverType + per-Task spec fields (predicate, window, ...)

       Solver claims Task → Harness runs → Solution submitted
       Evaluator scores Solution → Verdict produced
       Verdict's score contributes to SolverNet's Objective

─── Operator-installed primitives (the things that make a SolverNet runnable) ─
     SolverPlugin / plugin pack (optional; zero or more per SolverNet)
       ├── jinn.supports     → SolverTypes this pack claims to help with
       ├── mcpServers        → standard host-plugin field
       └── skills            → standard host-plugin field (knowledge embedded as skill content)

     Other plugins (operator-installed; not SolverNet-authoritative)
       Standard Claude Code / Gemini plugins. The host runtime loads them; the
       Harness can use their tools/skills like any plugin's. They are not part
       of any SolverNet definition.

     Harness (npm package)
       └── owns flow + improve-phase + tunables (Harness-internal)
```

- **Level 1 is persistent.** A SolverNet is defined once and runs continuously. Its SolverNet contract and Objective don't change between Tasks; its scalar accumulates as Tasks resolve.
- **Level 2 is ephemeral.** Each Task is posted, claimed, solved, scored, settled, indexed.
- **The join key is the SolverType identifier (a string).** The IPFS Task payload carries top-level `solverType`. The daemon looks up the enabled SolverNet and repo-native SolverNet contract for that type, validates the nested `spec`, and dispatches to the SolverNet's starting Harness (or operator-overridden Harness via `bySolverType`).
- **No plugin is canonical.** The SolverNet contract is the source of truth for SolverType shape, credential requirements, and evaluation/aggregation semantics. Operators may install any compatible plugin packs for additional tools/skills.
- **Plugin packs and Harnesses are independent.** Plugin packs ship optional substrate; Harnesses own runtime flow, improve-phase, tunables, and external data policy. The starting Harness is just a recommendation operators can override.

The clean separation: **SolverNetContract supplies *shape, credentials, evaluation, and aggregation*; plugin packs supply optional *tools + skills*; Harness supplies *how to actually run it*; Task supplies *the specific thing to solve right now*.**

---

## 4. The SolverNet

### 4.1 Definition

A SolverNet is a composition pattern declared in operator config and (for first-party SolverNets) defined as a reference in-repo:

```jsonc
{
  "name": "Prediction",
  "solverType": "prediction.v1",
  "harness": "prediction-v1-baseline",
  "plugins": ["bundled:jinn-prediction-plugin"],
  "objective": {
    "scalar": "brier-spread-vs-polymarket",
    "polarity": "lower-is-better",
    "rollingWindowDays": 84
  },
  "taskGenerator": "polymarket-derived-auto-poster",
  "startingHarness": "claude-code-learner",
  "publicDashboard": "https://jinn.network/solvernets/prediction"
}
```

A SolverNet is **not a protocol object**. JinnRouter doesn't know about SolverNets; it knows about Tasks with type identifiers. The SolverNet is operator-side coordination — the way a daemon decides "for a Task whose `solverType` matches my SolverNet's `solverType`, here is the SolverNet contract, optional runtime packs, the Harness to start with, and the Objective to roll up the verdict score into."

### 4.2 What a SolverNet declares

| Field | Purpose |
|---|---|
| `name` | Human-readable label. Used for dashboards, prose, and the `<name> SolverNet` proper-noun in docs. |
| `solverType` | The schema-versioned SolverType identifier (e.g., `prediction.v1`). Per `spec/2026-05-schema-versioning.md` grammar. Daemon validates that an enabled SolverNet's `solverType` resolves to a registered SolverNet contract. |
| `plugins` | Optional runtime/helper packs. If a pack declares `jinn.supports`, the daemon validates that it includes the SolverNet's `solverType`. |
| `objective` | The public scalar definition: how to compute it, polarity, rolling window. Used by the dashboard and (eventually) by Solvers' improve phases as the meta-feedback signal. |
| `taskGenerator` | The auto-poster (today: `creator.ts` + `getTestnetAutoConfig`). Optional — operators can disable to consume Tasks posted by others without contributing to creation. |
| `startingHarness` | The Harness a new operator's daemon uses by default. Operators are *expected* to override via `harnesses.bySolverType` if they want to compete with a different runtime — Harness competition is the whole point of the SolverNet. |
| `publicDashboard` | Informational. Where the rolling Objective trend is rendered. |

**Why `solverType` is enough in config:** `solverType` resolves into a repo-native SolverNet contract. Plugin packs may support the same type, but they do not make the SolverNet valid.

### 4.3 Multiple SolverNets per daemon

A daemon can run more than one SolverNet at a time — e.g., Prediction + Portfolio. Each enabled SolverNet has a `solverType` that resolves to a SolverNet contract; the daemon's registry routes incoming Tasks by `solverType` to the correct SolverNet's Harness. SolverNets do not compete inside one daemon; they coexist. Cross-SolverNet selection ("which SolverNet should this generic Task go to?") is not a protocol concern — Tasks identify their SolverNet by their type identifier.

---

## 5. Plugin packs

### 5.1 What a plugin pack is

A plugin pack is **what an operator may plug into their Harness to help handle one or more SolverTypes**. It is optional substrate — tools, skills, and host packaging. It does not prescribe how to use them, and it does not define validity.

A plugin pack can contain:

- **MCP-tool servers** — process-based tools any MCP-aware Harness can spawn.
- **Skills** — markdown files with frontmatter that plugin-aware host runtimes register (in Claude Code / Gemini, the host plugin format's standard `skills` field). Knowledge files (forecasting techniques, calibration approaches, etc.) are shipped as skills — there's no separate "knowledge" concept.
- **Capabilities metadata** — optional machine-readable declarations of helper surfaces.

A plugin pack does NOT contain:

- **Canonical schemas** — the SolverNet contract owns Task / Solution / Verdict schemas.
- **Credential requirements** — the SolverNet contract declares role requirements; Harnesses enforce their own operational readiness.
- **Evaluation rules** — the SolverNet contract names the deterministic evaluation function and in-client implementation.
- **Flow** — the Harness owns the pipeline. Mandating flow at the plugin level would prescribe how to solve, contradicting the SolverNet's purpose of discovering what works.
- **Tunables** — the Harness owns its improve-phase contract; tunables describe what the *Harness* mutates, not what the plugin ships.
- **Starting Harness** — plugin is harness-neutral. The SolverNet's operator config carries a starting Harness for ergonomics; the plugin itself doesn't bind to one.

The `jinn` extension on a plugin pack manifest is support/capability metadata. The only SolverType-related field is `supports`.

### 5.2 Format — extension of existing AI-tool plugin manifests

A SolverPlugin is a superset of existing AI-tool plugin formats with a minimal `jinn` field. **Same artifact, multiple consumers** — Claude Code and Gemini consume the standard plugin fields; the Jinn daemon's plugin-aware Harnesses additionally read `jinn.*`. Other plugin hosts ignore `jinn.*`.

This avoids fragmenting the AI-tool plugin ecosystem. Plugin authors who already ship Claude Code plugins extend with one field and they're done. New plugin authors get marketplace install UX, format documentation, and tooling for free.

The full Prediction SolverPlugin manifest:

```jsonc
// .claude-plugin/plugin.json (also valid as gemini-extension.json with field-name shim)
{
  "name": "@jinn-network/prediction-plugin",
  "version": "0.1.0",
  "description": "Substrate for the Prediction SolverNet — Polymarket-style binary forecasts.",

  // Standard plugin fields — Claude Code / Gemini consume.
  "mcpServers": {
    "polymarket": {
      "command": "node",
      "args": ["./mcp-servers/polymarket-api/server.js"]
    }
  },
  "skills": [
    "skills/forecasting-techniques/SKILL.md",   // domain knowledge as skill content
    "skills/calibration-approaches/SKILL.md",
    "skills/base-rates/SKILL.md",
    "skills/common-biases/SKILL.md",
    "skills/polymarket-specifics/SKILL.md"
  ],

  // Jinn extension — support/capability metadata.
  "jinn": {
    "supports": ["prediction.v1"],
    "capabilities": {
      "tools": {
        "polymarket": ["market.read", "orderbook.read"]
      }
    }
  }
}
```

**Field semantics for the `jinn` extension:**

| Field | Purpose |
|---|---|
| `jinn.supports` | SolverType identifiers this pack claims to help with. Optional; when present, the daemon validates configured runtime packs against the SolverNet's `solverType`. |
| `jinn.capabilities` | Optional structured metadata describing helper surfaces. Non-authoritative. |

`jinn.solverType` and `jinn.schemas` are intentionally absent. The SolverNet contract registry owns those concerns.

The standard plugin fields (`mcpServers`, `skills`, optionally `agents`, `hooks`, etc.) carry the substrate.

The manifest is JSON-Schema validated at install time and at session start. Unknown `jinn.*` keys fail loud (forward-compat).

### 5.3 No-plugin-installed behaviour

If a Task arrives for a SolverType whose optional plugin pack is not installed:

- The daemon can still validate the Task/Solution/Verdict against the SolverNet contract.
- The Task is dispatched to whichever Harness claims that type.
- The Harness may solve from Task contents alone or use other operator-provided tools/data.
- For first-party SolverNets like Prediction, the default config includes the bundled reference pack for convenience, not validity.
- Permissionless operators introducing new first-party SolverTypes need a SolverNet contract entry. Plugin packs can be distributed independently.

### 5.4 Distribution and install

The plugin-pack format is distribution-agnostic. The daemon's `jinn plugins add` verb supports multiple resolvers:

```bash
# npm registry
jinn plugins add @jinn-network/prediction-plugin

# Claude Code plugin marketplace
jinn plugins add cc:jinn-network/prediction-plugin

# git release
jinn plugins add github:jinn-network/prediction-plugin@v0.1.0

# local path (development)
jinn plugins add ./client/plugins/jinn-prediction-plugin

# IPFS CID (Phase B+)
jinn plugins add ipfs://bafy...
```

Each resolver fetches the package and validates:

1. Manifest parses (whichever of `.claude-plugin/plugin.json`, `gemini-extension.json`, or a standalone `jinn.plugin.json` is present).
2. `jinn.supports`, when present, is a string array.
3. Removed authority fields (`jinn.solverType`, `jinn.schemas`) fail loud.
4. Standard plugin fields parse against the host plugin schema (skills paths exist, MCP entries are well-formed, etc.).
5. The plugin is associated with whichever SolverNet config(s) name it via `plugins`.

**Default operator config installs `@jinn-network/prediction-plugin` automatically for new daemons** so the Prediction SolverNet works out of the box. Migration handling for existing operators: §11.8.

### 5.5 Versioning + compatibility

- **Plugin-pack content** (`@jinn-network/prediction-plugin` itself) follows semver. New tools / skills are minor; bug fixes are patches. Breaking host-packaging changes bump the major.
- **The `jinn` extension's own schema** follows semver with a 12-week deprecation window.
- **Operators receive new plugin versions** via the same upgrade path as any npm dep / plugin-marketplace package. The SolverNet config can pin entries in `plugins`.

---

## 6. The Task

### 6.1 The on-chain object

A Task is what `JinnRouter.createRestorationJob` produces today, with the rename `RestorationJob → Task`. Its on-chain form (post-rename, semantics unchanged):

| Field | Source | Notes |
|---|---|---|
| `taskId` | router | Unique identifier. |
| `creator` | router | Address that posted the Task. |
| `escrow` | router | Funds held until resolution. |
| `eligibility` | router | Eligibility-checker contract. |
| `window` | router | Deadlines. |
| `taskCid` | task | IPFS CID pointing to the full posted Task payload. (Renamed from `intentCid`.) |

### 6.2 The IPFS-stored Task

The Task payload is the JSON-stored description of *what* this specific Task is asking for. It carries a top-level `solverType` field identifying the SolverType, plus a nested `spec` object whose shape is validated against the SolverNet contract's Task schema:

```jsonc
// example: a single Polymarket-derived Prediction Task
{
  "solverType": "prediction.v1",
  "role": "restoration",
  "spec": {
    "predicate": "Will the Fed cut by 50bps before July 2026?",
    "resolutionMarket": "0x...",
    "resolutionTime": "2026-07-01T00:00:00Z",
    "resolutionSource": "polymarket"
  }
}
```

The `solverType` field on the Task is the **join key** between protocol and operator-side. The daemon receives the Task, reads the Task payload from IPFS, looks up the enabled SolverNet and SolverNet contract for that type, validates `task.spec`, then dispatches to that SolverNet's starting Harness (or the operator's per-SolverType override).

### 6.3 What changes vs. today

Field renames only. The shape of the on-chain object and the IPFS-stored Task are otherwise unchanged. The protocol-level loop (Creator → Solver → Evaluator) operates identically; we are renaming, not redesigning. Deployed contract identifiers (`createRestorationJob`, `deliverToMarketplace`, etc.) stay because they're tied to live contracts; only the conceptual role label and TypeScript-level identifiers change.

---

## 7. The Harness

### 7.1 Renames

- **Type:** `RestorerImpl → Harness`. Interface in `client/src/restorer/types.ts` renamed; directory `client/src/restorer/` → `client/src/harnesses/`; `RestorationContext → HarnessContext`; `RestorationOutput → Solution`; `restorationPayload → solutionPayload`.
- **Path 2 SDK:** `@jinn-network/restorer-sdk` / the draft Harness SDK surface is consolidated into `@jinn-network/sdk` with Harness types under `@jinn-network/sdk/harness`.
- **Protocol role:** `Restorer → Solver`. The conceptual role-label in docs and TypeScript-level identifiers change. Deployed contract identifiers (e.g., `JinnRouter.createRestorationJob`, `RestorationActivityChecker`, `restorationPayload` field on submitted manifests) stay — they're pinned to live contracts; renaming them would force a redeployment for cosmetic reasons. Future contract revisions may rename; this spec doesn't.

The role-vs-implementation split is preserved: a Solver (role) runs a Harness (implementation). The Solver vocabulary is now consistent everywhere — SolverNet / SolverType / SolverPlugin / Solver / Solution.

### 7.2 Interface (post-rename)

```ts
export interface Harness {
  readonly name: string;
  readonly version: string;
  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean;
  isReady(spec?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus>;
  canAttempt?(task: Task): Promise<{ ok: true } | { ok: false; reason: string }>;
  onEnable?(args: Record<string, string | undefined>, spec?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<EnableResult>;
  onDisable?(spec?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<void>;
  run(ctx: HarnessContext): Promise<Solution>;
}
```

**Field-name note:** the old shape was `{ kind: string; type?: 'restoration' | 'evaluation' }`. This spec renames `kind → solverType` and `type → role`; `'restoration' | 'evaluation'` is semantically a *role*, not a *type*. The role values themselves stay as protocol-level strings until contract redeployment lets them shift to `'solution'` / `'evaluation'`. Migration mechanics: §11.4.

### 7.2.1 What HarnessContext carries

The `HarnessContext` object the daemon hands to `run()` is the Harness's full input + capability bundle:

```ts
export interface HarnessContext {
  /** The Task this Harness is being asked to handle. */
  task: Task;

  /** IPFS CID of the full posted Task payload (renamed from `intentCid`). */
  taskCid?: string;

  /** Persistent directory for Harness-specific state. The improve phase mutates here. */
  implStateDir: string;

  /** Ephemeral working directory; cleared between attempts. */
  workingDir: string;

  /** Logger callback. */
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;

  /** Fires at window.endTs. */
  abort: AbortSignal;
  msUntilEndTs: () => number;

  /**
   * In-run trajectory collector. Harnesses call ctx.trajectory.addSpan(...) to
   * emit spans; the daemon emits the collected trajectory to IPFS before
   * envelope assembly and populates envelope.trajectory with { cid, sha256 }.
   */
  trajectory: TrajectoryCollector;

  /**
   * Scoped capability handles, present only when the daemon is providing the
   * surface per the Harness's manifest allow-list. Absent for stub-mode CLI.
   * Trust contract: `spec/2026-05-executor-trust-boundary.md` §3.
   */
  signer?: ScopedSigner;
  rpc?: ScopedRpc;
  secrets?: ScopedSecrets;
}
```

The Harness reads from the context, does its work, returns a `Solution`. Mutations the Harness wants to persist between runs go to `implStateDir/`. Ephemeral artifacts (intermediate tool calls, partial outputs) go to `workingDir/` which the daemon clears between attempts. Capability handles are scoped per the Harness's manifest — the daemon enforces the allow-list, the Harness sees only the surface area its manifest declared.

This shape is unchanged from today's `RestorationContext` modulo the field renames in §11.4 — the rename is mechanical, not architectural.

### 7.3 Selection (registry resolution)

The registry resolves a Harness for a Task by:

1. **`config.harnesses.bySolverType[task.solverType]`** — explicit per-SolverType binding wins. Used by operators who want a Path 2 specialist for a specific SolverType.
2. **Default Harness** — `claude-code-learner`. Claims any non-evaluation Task that wasn't routed to a specialist.
3. **Disabled list** — `config.harnesses.disabled[]` excludes a Harness from selection regardless.

**The wrapper is gone.** `wrapWith` config and `DEFAULT_WRAP_WITH` are removed. The first-match-wrapper-with-specialist construct in `wrapper.ts` is deleted.

### 7.4 Plugins land via daemon placement + host-runtime loading

Earlier drafts of this spec introduced an explicit `pluginAware: true` flag and `pluginLoader` interface on Harnesses. Both are removed in v0.6 because they were over-engineered:

- **Substrate (tools + skills) lands through the host plugin system, but the daemon still does placement and launch wiring.** `claude-code-learner` spawns a Claude Code subprocess. The daemon resolves configured plugin packs, places them on disk, and points the subprocess at the relevant plugin roots / MCP config (today via `--plugin-dir`, `--mcp-config`, and `JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT`). Claude Code's native loader then loads skills, MCP servers, and hooks from those locations. Gemini-CLI Harnesses inherit the same pattern for Gemini's plugin loader: Jinn resolves and points; the host runtime loads.
- **Schema validation is the daemon's job.** When a Task arrives, the daemon reads the SolverNet contract, validates the spec, dispatches. When a Solution comes back, the daemon validates it before envelope assembly. Harnesses don't need to do schema work themselves.
- **Path 2 specialists** (e.g., a hardcoded `prediction-v0-baseline` that doesn't run a Claude Code subprocess) simply don't read the plugin directory. There's no flag to declare; they just don't engage with the substrate.

So plugin handling distributes naturally:
- Daemon: resolves optional plugins, validates manifests/support metadata, validates Task/Solution shapes against the SolverNet contract, ensures plugin content lives where the host runtime expects, and passes the host-specific launch pointers.
- Host runtime (Claude Code / Gemini): loads plugin tools/skills natively at subprocess start.
- Harness: just runs.

No `PluginLoader` interface, no `HarnessRuntimeArtifacts` type, no `pluginAware` flag. Less spec surface, less code, fewer concepts to keep aligned.

### 7.5 The default learner under this model

`claude-code-learner` runs the seven-phase pipeline (per `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md`) end-to-end — the pipeline (orient → strategize → plan → execute → debrief → improve → memory-consolidation) is **the Harness's flow, not the plugin pack's**. When the learner spawns its Claude Code subprocess, Claude Code natively loads the operator's configured plugins; reference-pack tools and skills become available to the pipeline's agents alongside any other operator-installed plugins.

Schema validation happens at the daemon boundary, not inside the learner. The daemon validates incoming Task specs against the SolverNet contract's Task schema; the learner produces a Solution payload; the daemon validates it against the SolverNet contract's Solution schema before envelope assembly. The learner doesn't need to import schemas itself.

Without any configured plugin pack for a Task's SolverType, the daemon can still dispatch if the SolverNet contract and Harness are present. Plugins improve ergonomics; they are not validity requirements.

The improve phase mutates `implStateDir/`. The mutation surfaces are:
- **`implStateDir/skills/<name>/SKILL.md`** — operator-learned skills. Loaded alongside plugin-shipped skills; on name collision, operator-learned wins (override semantics below).
- **`implStateDir/agents/<name>.md`** — operator-learned agents. Same override semantics.
- **`implStateDir/tunables/<tunable>.json`** — operator-learned values for *Harness-declared* tunables (the learner declares its own knobs — calibration aggressiveness, ensemble size for its own ensemble step, corpus-lookup top-k, etc.). Tunables are a Harness contract, not a plugin contract; alternative Harnesses define different tunables relevant to their own pipelines.
- **`implStateDir/configs/<name>.json`** — operator-learned config overrides.

**Override semantics:** at subprocess start, Claude Code natively loads plugin-shipped skills (from the host plugin directory) alongside operator-learned skills (from `implStateDir/skills/`). On name collision, the operator-learned skill wins per the host's existing override rules. The plugin-shipped skill remains on disk for inspection / `git diff` purposes; it is just not the one loaded when an override exists. Clean separation: "from the plugin" (read-only, inspectable) vs. "operator-learned" (loaded, mutable).

### 7.6 Daemon's plugin responsibility (minimal)

The daemon's plugin handling is small and entirely outside the Harness:

1. **Resolve.** For each SolverNet in `config.solverNets[]`, resolve configured `plugins` (npm / marketplace / git / local / IPFS) and ensure plugin contents are unpacked where the host runtime expects (e.g., the operator's Claude Code plugin directory).
2. **Validate manifests.** Parse the plugin manifest, reject removed authority fields (`jinn.solverType`, `jinn.schemas`), validate `jinn.supports` when present, and confirm standard plugin fields (`mcpServers`, `skills`) reference real paths.
3. **Register SolverNet contracts in-memory** keyed by SolverType identifier. Used by the daemon to validate Task specs at dispatch and Solution payloads at envelope assembly.
4. **Wire subprocess launch inputs.** For host-backed Harnesses, pass the host-specific plugin roots / MCP config to the subprocess. Today `claude-code-learner` uses `--plugin-dir`, `--mcp-config`, and `JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT`; future Gemini/Codex Harnesses use their host's equivalent.
5. **Health-check plugins on install** (manifest parses, schemas valid, MCP entry files exist). Runtime health (do the MCP servers actually start? do skills load?) is the host runtime's domain after launch.

That's it. No Harness-side `PluginLoader` interface, no `HarnessRuntimeArtifacts` translation, no `pluginAware` flag. When the learner spawns its Claude Code subprocess, Claude Code does the work of loading plugin tools/skills natively. Path 2 specialists that don't run a Claude Code subprocess simply don't engage with plugins — no negotiation needed.

The `client/src/plugins/` module (§11.6) is small for the same reason — it's resolvers + manifest validator + schema-by-type lookup + CLI verbs. No translation layer.

---

## 8. Trust boundaries

The reframe gives three named surfaces with clear ownership:

| Surface | Owner | Mutability | How signed |
|---|---|---|---|
| SolverPlugin content (manifest + schemas + tools + skills) | Plugin author | Read-only at runtime | Plugin-marketplace publish / npm publish + (Phase B) signed manifest per `spec/2026-05-executor-trust-boundary.md` |
| Harness code (and its declared tunables list) | Harness author | Read-only at runtime | npm publish + Path 2 manifest signing per existing trust-boundary spec |
| Operator state (`implStateDir/`, including tunable *values*) | Operator | Mutable by Harness's improve phase | Git-history within the operator's local implStateDir; no external attestation |

This resolves the `jinn-mono-dwqm` contradiction directly: there is no "signed code that learns at runtime." Signed code (Harness, plugin) doesn't mutate. Operator state mutates. The improve phase's action surface is bounded to operator state.

A Path 2 specialist that doesn't want to use plugins continues to be signed-and-immutable. A Path 2 specialist that wants learning either templates the learner or implements its own learning loop — its choice. Neither path requires the network to relax the signature on its code.

---

## 9. Three layers of compounding (restated against the model)

Per #59 §1, "two layers of compounding: corpus-level and harness-level." Under this model the picture is:

1. **Per-operator (harness-level)** — operator's implStateDir mutates run over run. The improve phase is bounded to operator-state surfaces (§7.5). Compounds within one operator's deployment.
2. **Network (corpus-level)** — trajectories land in the corpus library (Phase A.1). All Harnesses can read the corpus during orient/debrief. Compounds across operators.
3. **Author-mediated (plugin-level)** — plugin authors observe trajectories, ship new plugin versions. Operators upgrade via `yarn upgrade @jinn-network/prediction-plugin`. Compounds across the SolverNet.

The 26-week reversion threshold from #57 §5 reads (1)+(2)+(3) together: if Brier-spread doesn't trend positive, *one of these three layers is failing to compound*. The dashboard tells us which.

### 9.1 Plugin lineage on envelopes

For (3) to actually compound, downstream consumers (indexer, corpus library, future agents, plugin authors observing their own work) need to know which plugins ran for which envelope. This spec commits three related executor-block semantics in the envelope schema (extending `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md`):

1. **`executor.codeDigest` keeps its current build-time meaning.** Today `client/src/build-info.ts` hashes `dist/main.js` at build time. Keep that semantics for the attested tier: it identifies the reproducible harness/client build. A TEE rebuilding from a source bundle can reproduce this digest without needing an operator's runtime-installed plugins.
2. **`executor.runtimeBundleDigest` is added for what actually ran.** The daemon derives this at envelope-creation time from the resolved Harness build plus the plugin set handed to the host runtime. This is the plugin-inclusive digest: "everything the run was launched with." Because it is runtime-derived, it is not used as the attested-tier build reproducibility anchor.
3. **`executor.plugins[]` is added as a queryable breakdown** — explicit per-plugin entries: `{ name, version, cid, sha256 }` for each installed plugin loaded during the run. This lets indexers and the corpus library answer queries like "show me all envelopes that used `@some-author/polymarket-extras`" without re-deriving `runtimeBundleDigest`. The list is what's *inside* the runtime digest, surfaced for query convenience.

Together: `codeDigest` is the reproducible build anchor; `runtimeBundleDigest` is the runtime integrity hash; `plugins[]` is the readable manifest. All three ship in `executor`; `runtimeBundleDigest` and `plugins[]` are populated at envelope-creation time by the daemon.

**On the granularity choice (plugin-level rather than per-skill / per-MCP-server / per-tool):** the plugin is the unit of versioned, network-wide identity — sub-elements (skills, MCP servers, tools, hooks) have identity *as part of* a plugin and don't carry independent semvers, so sub-plugin queries fall out via plugin lookup; per-call activity (which tool was actually invoked) lives in the trajectory layer; and operator-private state in `implStateDir` is intentionally not in the envelope (a separate opt-in concern).

The schema change to `executor` is small and lands as a follow-up plan extending the envelope-tee-scope spec — implementation is not in scope for this design but the commitment is.

---

## 10. The Prediction SolverNet (v1 worked example)

| Component | Concrete |
|---|---|
| Name | `Prediction` |
| SolverType | `prediction.v1` |
| SolverNetContract | `SOLVER_NET_CONTRACTS["prediction.v1"]` in the client. Defines Task/Solution/Verdict schemas, claim defaults, credential requirements, `prediction.brier-loss.v1`, and trailing 84-day mean aggregation. |
| Reference plugin pack | Optional `@jinn-network/prediction-plugin`, lives at `client/plugins/jinn-prediction-plugin/`. Declares `jinn.supports: ["prediction.v1"]` and helper tools/skills. |
| Objective | Brier-spread vs. Polymarket consensus, rolling 84-day window, lower-is-better (#57 §5) |
| Task generator | Polymarket-derived auto-poster (Phase A.3 — separate plan) |
| Starting Harness | `prediction-v1-baseline` in the launch config; operators are expected to override via SolverNet Harness config to compete with their own runtime. |
| Public dashboard | `https://jinn.network/solvernets/prediction` (separate plan) |

**Out-of-the-box state for a default operator:**

The daemon loads the `prediction.v1` SolverNet contract, configures the reference pack by default, selects the starting Harness, the creator loop posts Polymarket-derived Tasks, and the loop runs end-to-end. Removing the plugin pack should not make Solutions invalid.

**v1 contents of `@jinn-network/prediction-plugin`:**

- `mcp-servers/polymarket-api/` ships and tests pass against the live Polymarket API on testnet. Provides task-scoped read tools.
- `skills/` populated with at least: `forecasting-techniques`, `calibration-approaches`, `base-rates`, `common-biases`, `polymarket-specifics`. Each skill is a markdown file with frontmatter — domain knowledge embedded as instruction, consumable by any Claude Code-shaped Harness.
- `jinn.supports: ["prediction.v1"]` populated.
- Claude Code natively loads the pack when the learner's subprocess starts; daemon validates Task specs and Solutions against the SolverNet contract at the dispatch and envelope-assembly boundaries.
- An end-to-end e2e test posts a fake `prediction.v1` Task on Anvil and asserts the Harness produces a `Solution.solutionPayload` validated against the SolverNet contract's solution schema.

**What is NOT in the v1 plugin** (lives elsewhere):

- The seven-phase flow → owned by `claude-code-learner` (its existing pipeline; uses plugin tools and skills as resources).
- Calibration / ensemble / corpus-lookup tunables → owned by `claude-code-learner` and declared in its own manifest, populated with operator-learned values under `implStateDir/tunables/` over time.
- The Objective and Task generator → declared in the SolverNet config (§4 / §11.8).

---

## 11. Migration from current state

### 11.1 Wrapper deletion

- Delete `client/src/restorer/impls/claude-code-learner/wrapper.ts`.
- Delete `synthesizeExecuteSummaryFromSpecialist` (no longer needed — specialists run alone, write their own outputs directly).
- Remove `DEFAULT_WRAP_WITH = 'claude-code-learner'` from `intent-registry-access.ts`.
- Remove `wrapWith` from `JinnConfig.restorers`.
- Remove `resolveEffectiveWrapWith` and call sites.
- Remove the `wrapWith` registry construction option in `RestorerImplRegistry`.

### 11.2 RestorerImpl → Harness rename + Restorer → Solver role rename

- Move `client/src/restorer/types.ts` → `client/src/harnesses/types.ts`. Type rename.
- Rename `client/src/restorer/` → `client/src/harnesses/`. Update all imports (~ a few dozen call sites; mechanical).
- Rename `JinnConfig.restorers` → `JinnConfig.harnesses` (config-file migration helper writes a one-time conversion).
- Consolidate the draft Harness SDK into `@jinn-network/sdk`. Harness types live under `@jinn-network/sdk/harness`; no compatibility package is kept for the draft SDK.
- Update prose / comment / docstring usages of "Restorer" (the protocol role) to "Solver." Examples: `client/src/daemon/daemon.ts` orchestration comments, JSDoc on the Harness interface, README content.
- Update `BRAND.md` / `SPEC.md` / `GLOSSARY.md` cross-references in a follow-up canonical-doc PR (separate from this spec's merge — canonical docs change via approved PRs per `spec/2026-04-28-canonical-docs.md`).
- **Deployed contract identifiers stay:** `JinnRouter.createRestorationJob`, `RestorationActivityChecker`, the `restorationPayload` envelope field, ABI artifacts, etc. Renaming these forces a redeployment + migration. Future contract revisions may rename; this spec doesn't.
- Closes `jinn-mono-juw` / GH#43.

### 11.3 Output / context renames

- `RestorationOutput → Solution`.
- `restorationPayload → solutionPayload`.
- `RestorationContext → HarnessContext`.
- All field-level usages updated.
- Tests and e2e are in scope, not a cleanup afterthought. At minimum, update every current `client/test/` reference to the renamed surfaces:
  - `RestorationJob` call sites and fixtures become `Task`.
  - `intentCid` call sites and persisted expectations become `taskCid`.
  - `RestorationContext` fixtures become `HarnessContext`.
  - `RestorationOutput` assertions become `Solution`.
  - `byKind` config helpers become `bySolverType`.
  - `wrapWith` tests are deleted with the wrapper path, except for config-migration tests that prove legacy `wrapWith` is removed or ignored.
- E2e fixtures and manifest assertions must use `Task` / `taskCid` / `solutionPayload` vocabulary while preserving compatibility with deployed contract names.

### 11.4 Task / spec field renames

- `RestorationJob → Task` (the on-chain object's TypeScript name).
- `intentCid → taskCid` on the Task struct + ABIs.
- `spec.kind → solverType` in the IPFS-stored Task format (carries the SolverType identifier).
- `type: 'restoration' | 'evaluation'` → `role: 'restoration' | 'evaluation'`.
- `byKind → bySolverType` in operator config.
- Path 2 Harness manifests declare which SolverTypes they handle via their existing per-Type structures (no `supportsSolverTypes` array — Path 2 specialists already declare per-Type handling in their manifests).

The schema-versioning grammar in `spec/2026-05-schema-versioning.md` continues to apply — only the field name changes; values like `'prediction.v0'` are unchanged.

### 11.5 SolverType modules → SolverNet contracts

The existing `client/src/intents/kinds/<kind>/` modules contain Zod schemas + TypeScript types for first-party SolverTypes. Under the SolverNet-contract model:

- Portable first-party canonical schemas live in `@jinn-network/sdk/solvernets` and SolverNet-specific subpaths, where external Harness authors can validate and build typed payloads without importing `@jinn-network/client`.
- The client keeps thin re-export modules and references the SDK-backed SolverNet contract registry for runtime validation.
- The directory `client/src/intents/kinds/` is renamed to `client/src/solver-types/` and contains adapter/generator modules. First-party schema authority is explicit in the SolverNet contract registry.

The auto-poster wiring in `client/src/intents/kinds/index.ts` is vocabulary-renamed (`SOLVER_TYPES`, `getTestnetAutoConfig`, `collectTestnetAutoIntentGenerators`). A later cleanup may move those adapter modules to `client/src/solver-types/`; this PR keeps the path stable to reduce churn while removing canonical schema authority from it.

### 11.6 SolverPlugin mechanism

- New module: `client/src/plugins/`.
  - `resolvers/` — multi-format resolvers: `npm.ts`, `cc-marketplace.ts`, `git.ts`, `local.ts`, (Phase B+) `ipfs.ts`. Each resolver takes a spec string, fetches the package, and returns a normalized `SolverPluginManifest` regardless of which host-format (Claude Code plugin / Gemini extension / standalone) the package uses.
  - `loader.ts` — reads `config.solverNets[]`, resolves each SolverNet's configured `plugins` references via the appropriate resolver, validates the `jinn.*` extension, builds an in-memory runtime pack set keyed by SolverNet.
  - `validator.ts` — rejects removed plugin authority fields and validates support metadata. Task/Solution validation uses the SolverNet contract registry.
  - `types.ts` — `SolverPluginManifest`.
  - `cli.ts` — `jinn plugins list / add / remove / show`.
- Daemon `main.ts` initialises the SolverPluginRegistry before constructing the Harness registry. Plugins are placed on disk where the host plugin runtime expects (e.g., the Claude Code plugin directory) so when the learner spawns its subprocess, Claude Code natively loads them.
- `@jinn-network/prediction-plugin` ships at `client/plugins/jinn-prediction-plugin/` as the first concrete plugin — a Claude Code plugin with the `jinn` extension populated per §5.2.
- **No Jinn-specific plugin-loader inside the Harness.** Removed in v0.6 — the host runtime's native plugin loading does the work. See §7.4.

`executor.codeDigest` keeps its build-time semantics; `executor.runtimeBundleDigest` covers the resolved plugin set; `executor.plugins[]` ships per §9.1. Implementation extends envelope assembly to populate the runtime-derived fields while preserving `client/src/build-info.ts` as the build digest source. See §9.1 for the schema commitment; mechanical implementation is a follow-up plan extending the envelope-tee-scope spec.

### 11.7 Path 1 retirement

The slot taxonomy from `spec/2026-04-30-plug-in-surface.md` §4.2 (phase-agent-override / topic-explorer / mcp-tool / skill-bundle / memory-backend / hook / bundle) is **retired**. Recruits who would have shipped Path 1 plug-ins now pick one of:

- **Ship a SolverPlugin** — for substrate that is genuinely SolverType-specific and harness-agnostic (schemas, MCP tool servers, skills with embedded domain knowledge).
- **Fork the learner** — for harness-specific extensions (a custom planner agent, a specialised step-worker). The learner is open-source; forking is a recruit-friendly path for skill / agent / memory-backend authors who want to ship something claude-code-learner-shaped without the network needing a per-harness slot taxonomy.
- **Ship a Harness** (Path 2 — unchanged) — for builders with a working monolith.

The cost of retirement is real: phase-agent-overrides and skill-bundles were the lowest-friction recruit shape in the prior spec. The benefit is that the substrate is now portable across Harnesses (and reusable as Claude Code plugins outside Jinn entirely), which is what the Phase A.2 ambition required all along.

PR #63 already shipped part of the retired Path 1 mechanism. The migration must delete it, not just supersede it in prose:

- Delete `client/src/restorer/plug-ins/` entirely, including loader, manifest parsing, registry, serialisation, types, and barrel exports.
- Delete `examples/learner-plug-ins/@jinn-examples/` and its six worked-example plug-in packages.
- Delete the `jinn plug-ins` CLI surface and scaffolder tests that target the retired slot taxonomy, or replace them with the new `jinn plugins` SolverPlugin commands in §11.6.
- Remove `JINN_SLOT_REGISTRY_JSON` and the Path 1 slot-registry launch wiring from `claude-code-learner`; keep only host-plugin launch wiring for SolverPlugins and ordinary host plugins.

`spec/2026-04-30-plug-in-surface.md` §4 (Path 1) is marked superseded by this spec. The §3 Path 2 commitments (SDK, scaffolding, worked examples) hold under the renames.

### 11.8 Specialists currently in-tree

| Today | Disposition |
|---|---|
| `claude-code-learner` (with wrapper) | Wrapper deleted; learner is now a peer Harness, default in registry. |
| `prediction-v0-baseline` | Moves to `examples/external-harnesses/prediction-v0-baseline/`. Becomes the worked-example "Harness without plugins" — a Path 2 monolith that ignores plugins. Operators who want it register via `bySolverType`. Remains compiled in CI as an example. |
| `prediction-apy-v0-baseline` | Same disposition as `prediction-v0-baseline`. |
| `claude-mcp-hyperliquid` | Stays in-tree as a default-disabled Path 2 specialist (existing behaviour); not plugin-aware; portfolio.v0 plugin is a future bead. |
| `claude-mcp-prediction` / `claude-mcp-prediction-apy` | Stay in-tree for now; revisit once `@jinn-network/prediction-plugin` is producing comparable or better results. Candidates for the same disposition as the baselines. |
| `legacy-claude` | Stays as an unrelated Harness; not plugin-aware; not affected by this spec. |
| `*-evaluator` impls | All evaluator Harnesses stay in-tree. Evaluation is deterministic per SolverType; plugins do not currently provide evaluator substrate. (Evaluator plugins are a future-bead question.) |

### 11.9 Default config for new operators

```jsonc
{
  "harnesses": {
    "bySolverType": {},
    "disabled": []
  },
  "solverNets": {
    "prediction": {
      "enabled": true,
      "solverType": "prediction.v1",
      "harness": "prediction-v1-baseline",
      "plugins": ["bundled:jinn-prediction-plugin"],
      "taskGenerator": { "enabled": true }
    }
  }
}
```

Existing operators on testnet receive a one-time config-migration prompt at daemon start (`jinn migrate-config`) that produces the above shape.

---

## 12. What we're explicitly deferring

- **Tight Task-plugin association on-chain.** A Task does not currently reference a recommended plugin. v1 is loose-association: operator config may map SolverTypes to optional plugin packs. Tight association (e.g., a `recommendedPluginCid` field on the Task) is Phase B+.
- **An on-chain SolverPlugin registry.** Distribution is npm / marketplace / git / IPFS in v1. A curated marketplace and on-chain pinning are Phase 2+.
- **Cross-plugin dependencies.** A plugin does not declare it depends on another plugin. If a future plugin genuinely needs another's MCP tools, the recommendation is to vendor or to ship a single bundled plugin.
- **Hot reload.** Plugins and Harnesses load once per process, consistent with Path 2's existing once-per-process lifecycle.
- **Plugin content signing.** v1 trusts npm publish + operator vouch-by-install. Path 2-shaped manifest signing extended to plugins is a follow-up bead.
- **Tunable-mutation policy.** v1 lets the Harness's improve phase write any Harness-declared tunable. Per-tunable policy (rate limits, validation, attestation) is Phase B+.
- **Author-mediated improvement velocity.** This spec assumes plugin authors observe trajectories and ship new versions on their own cadence. Tooling for "publish a new plugin version from operator-trajectory data" is out of scope.
- **Evaluator plugins.** Today evaluators are deterministic and don't need substrate. If a future evaluator wants knowledge or tools (e.g., a probabilistic verifier), the same plugin mechanism applies — no architecture change needed.

---

## 13. Open questions

1. **Should the default config silently install `@jinn-network/prediction-plugin`, or surface a one-line consent prompt at first boot?** Lean: silent install for new operators; one-line prompt on `jinn migrate-config` for existing operators.
2. **Where do Harness-declared tunables live?** Each Harness declares its own tunables (calibration aggressiveness, ensemble size, corpus-lookup top-k for the learner). Format: in the Harness's `package.json` `jinn` field? In a separate `harness.tunables.json`? Lean: in the Harness's `package.json` `jinn.tunables[]` array. Keeps the declaration close to the code that reads them.
3. **Path 2 builders losing the slot ergonomics — is "fork the learner" actually a viable recruit path?** This is the most genuine concern of the Path 1 retirement. Mitigation: the learner repo includes a `learner-template/` directory with a stripped-down skeleton; the recruit story becomes "fork the template, swap your specialist code in, optionally re-use `@jinn-network/sdk/harness` and SolverNet helpers from `@jinn-network/sdk/solvernets/*`." If recruits report this is too high-friction, Phase A.4 retro re-opens the slot taxonomy as a follow-up.
4. **Curator role formalization.** The SolverNet curator (the entity who proposes the SolverNet contract, objective/aggregation, and Task generator) is named in this spec but not formalized as a distinct role. Whether it surfaces in code (e.g., a curator address recorded with each SolverNet config), in canonical docs (Creator / Solver / Evaluator / Curator), or stays implicit — open. Worth its own pass.
5. **Should `solverNets[]` config be operator-side declarative as shown in §11.9, or should SolverNet definitions ship as their own npm packages (e.g., `@jinn-network/prediction-solvernet`) that bundle objective + Task-generator config + plugin reference together?** Lean: operator-side config in v1 (simpler); promote to dedicated SolverNet packages if multiple SolverNets ship and the bundling reduces operator burden.
6. **Solver as a noun in code.** The role rename to Solver is committed; should it surface in code (e.g., a `Solver` class composing `Harness` + identity), or stay a role-label only? Lean: role-label only in v1; the operator entity is already represented by the Safe + Harness pair.
7. **Cross-host plugin-format mapping.** Claude Code uses `.claude-plugin/plugin.json`; Gemini uses `gemini-extension.json`; Codex has its own. The shapes are similar but field names differ. v1 commits to: a plugin ships *one* canonical host-shape (Claude Code plugin in v1, since that's what Jinn's daemon spawns); other hosts can read the same package via field-mapping shims. A formal multi-host manifest spec is a follow-up bead if we ship a Gemini-CLI Harness and discover the shim is too lossy.

---

## 14. Acceptance criteria

This spec is accepted when:

1. **Merged under `spec/`.**
2. **Cross-references added** to the sibling specs (§ lineage list) and to `spec/2026-04-30-plug-in-surface.md` marking §4 (Path 1) superseded.
3. **`@jinn-network/sdk` v1.0.0 published** with Harness, SolverNet, Prediction v1, and plugin helper subpaths.
4. **Wrapper code deleted** per §11.1.
5. **Rename PR merged** per §11.2 + §11.3 + §11.4; `jinn-mono-juw` / GH#43 closed.
6. **`client/src/plugins/` module shipped** with resolvers, loader, validator, CLI, and unit tests.
7. **Envelope executor fields updated** per §9.1: `executor.codeDigest` retains build-time semantics, `executor.runtimeBundleDigest` is populated at envelope-creation time from the Harness build + resolved plugin set, and `executor.plugins[]` lists the loaded plugin breakdown. Implementation preserves `client/src/build-info.ts` as the build digest source and extends envelope assembly for runtime-derived fields.
8. **`@jinn-network/prediction-plugin` v0.1.0 shipped** at `client/plugins/jinn-prediction-plugin/` with the §10 contents — schemas + tools + skills + `jinn` extension — and passing CI.
9. **e2e validation** — the existing `yarn e2e` script extended to assert: prediction SolverNet contract resolves, optional prediction plugin pack resolves, daemon validates Task spec against the contract Task schema, Claude Code subprocess loads the plugin pack natively when configured, the learner produces a `solutionPayload` validated against the contract Solution schema, `executor.codeDigest` remains the build digest, `executor.runtimeBundleDigest` is populated, and `executor.plugins[]` correctly lists loaded runtime packs.
10. **Specialists re-disposed** per §11.8; `examples/external-harnesses/` directory created.
11. **Retired Path 1 implementation deleted** per §11.7: `client/src/restorer/plug-ins/`, `examples/learner-plug-ins/@jinn-examples/`, the `jinn plug-ins` slot-taxonomy CLI surface, and `JINN_SLOT_REGISTRY_JSON` launch wiring are gone or replaced by SolverPlugin equivalents.
12. **Default config updated** per §11.9; `jinn migrate-config` verb shipped.
13. **In-repo SolverType modules migrated** per §11.5 (schemas live in the plugin; in-repo holds adapter / auto-poster wiring only).

The campaign-launch gate (#57 §1) is *not* acceptance for this spec — it is acceptance for Phase A.4. This spec ships the architecture that makes the campaign run.

---

*End of v0.8.*
