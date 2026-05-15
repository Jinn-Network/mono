# SolverNet architecture — Harness, SolverPlugin, and Task semantics

- **Date:** 2026-05-01
- **Author:** opus (drafted on jinn-mono-dwqm; Captain ritsukai)
- **Status:** Proposal
- **Version:** 0.9
- **Tracks:** Phase A.2 reframe — supersedes the wrapper-with-specialist construct introduced in PR #63; replaces `spec/2026-04-30-plug-in-surface.md` Path 1 with a harness-agnostic SolverPlugin mechanism that extends existing AI-tool plugin formats.
- **v0.9 changelog (2026-05-04):** Schemas removed from plugins; SolverNet contract registry is the protocol authority for Task/Solution/Verdict shapes (§5.6). `jinn.solverType` (singular) replaced with `jinn.supports: string[]`, with the `["jinn.runtime"]` mode for shared runtime plugins. SolverNet config drops `canonicalPlugin`; substrate is layered (auto-injected Network Tools + contract `defaultRuntimePlugins` + operator `plugins[]`) with `provenance: 'default' | 'configured'`. Two-manifest split (`jinn.plugin.json` sidecar + host plugin manifest) committed.

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

## 1. Purpose and scope

### 1.1 What this spec commits

Five coordinated architectural moves that re-align the implementation with what the Phase A.2 spec already said and what the original learner design intended:

1. **Delete the universal wrapper.** `claude-code-learner` becomes a peer Harness in the registry, not a substrate that wraps every SolverType. Its `supports()` returns `true` for any non-evaluation restoration; it is the registry's *default* when no other Harness claims a SolverType. It owns its `run()` end-to-end.
2. **Rename `RestorerImpl → Harness`** and the protocol role **`Restorer → Solver`**. The thing-an-operator-runs is a Harness; the protocol role they fulfil is Solver. The rename disambiguates role from implementation and unifies the vocabulary cluster (SolverNet / SolverType / SolverPlugin / Solver / Solution).
3. **Introduce SolverPlugins.** A SolverPlugin is a harness-agnostic package supplying *substrate* — MCP-tool servers and skills an operator plugs into their Harness. Each SolverNet contract declares its `defaultRuntimePlugins` (the substrate the network expects every operator running this SolverType to have); operators add their own via `solverNets.*.plugins`. **A SolverPlugin ships a `jinn.plugin.json` sidecar alongside any host plugin manifests** (`.claude-plugin/plugin.json`, `gemini-extension.json`) — host runtimes load the host manifest, the Jinn daemon reads only the sidecar; the same package serves multiple consumers. SolverPlugins do not dictate flow, tunables, schemas, or Harness — those live elsewhere (Harness owns flow + tunables; **SolverNet contract registry owns schemas**; SolverNet config carries the starting Harness). See §5.6.
4. **Introduce SolverNets and Tasks as distinct levels.** A SolverNet is the campaign / group / objective. A Task is one posted item — the on-chain unit a Solver claims and produces a Solution for. The SolverNet declares one SolverType; many Tasks of that SolverType flow through it.
5. **Ship the Prediction SolverNet as the first instance.** `@jinn-network/prediction-plugin` ships in-repo, on by default for new operators. The starting Harness (the learner) plus the prediction plugin is what the GTM in #57 calls the "client as meta-harness" running against the Polymarket-derived Task stream.

### 1.2 In scope

- The SolverPlugin manifest shape (extension of existing host plugin formats).
- The Harness interface (renamed from `RestorerImpl`) and its plugin-loader.
- The Task vocabulary (renamed from `intent` / `RestorationJob`).
- The Solution / Verdict output vocabulary (renamed from `RestorationOutput`).
- Registry resolution rules (`bySolverType` + default; Path 2 trumps default).
- The `@jinn-network/prediction-plugin` content for v1 of the Prediction SolverNet.
- Migration of `prediction-v0-baseline`, the existing `client/src/intents/kinds/` modules, and the wrapper code paths.
- Trust-boundary disposition (SolverPlugin content vs. Harness code vs. operator state).
- The "SolverNet" composition pattern (SolverType + objective + starting plugin + starting Harness + Task generator).

### 1.3 Out of scope

- Implementation of the rename PR itself (the renames are *committed* here; mechanical execution lives in follow-up beads).
- Per-component royalty / pricing / DRM (continues to be off the roadmap per DR-2026-04-30).
- Multi-evaluator consensus mechanics (Phase B).
- Hot-reload of SolverPlugins or Harnesses inside a running daemon (Phase 2+; consistent with `2026-05-external-restorer-impls.md` §3.4).
- An on-chain SolverPlugin registry (Phase 2+; analogous to the impl-registry deferral).
- Tight coupling of Task-on-chain to a specific SolverPlugin CID (loose-association in v1; tight is Phase B+).
- Path 1 in its previous form. The phase-agent-override / topic-explorer / hook / memory-backend slot taxonomy from `spec/2026-04-30-plug-in-surface.md` §4.2 is *retired* in favour of the SolverPlugin mechanism. Path 1's recruit story becomes "ship a SolverPlugin" (harness-agnostic) or "fork the learner template" (harness-specific). See §11.6.

### 1.4 Non-goals

- This spec does not commit a marketplace.
- This spec does not redefine the protocol layer. JinnRouter, IdentityRegistry, ValidationRegistry, ReputationRegistry, ClaimRegistry, x402, ERC-8004 — all unchanged in shape; only the Task payload's `spec.kind` moves to top-level `solverType` (carrying the SolverType identifier) per §11.4.
- This spec does not define a new Harness alongside `claude-code-learner`. Alternative Harnesses (Pi.dev / Codex / Gemini-CLI ports) are recruit targets — they ship their own plugin-loaders when they appear.

---

## 2. Glossary

| Term | Definition |
|---|---|
| **SolverNet** | A composition: (SolverType + objective + starting Harness + optional Task generator + operator-configured substrate plugins). The campaign / group level. The Prediction SolverNet is the first instance. Defined in operator config; the SolverType-level authority (schemas, evaluator, default substrate) lives in the SolverNet contract registry (§5.6). Not a protocol object. |
| **Objective** | The public scalar a SolverNet rallies around. For the Prediction SolverNet: spread vs. Polymarket consensus. Trend matters more than level (#57 §5). |
| **SolverType** | The schema-versioned identifier a Task's spec conforms to. Examples: `prediction.v1`, `portfolio.v0`. Grammar per `spec/2026-05-schema-versioning.md`. The SolverType's wire shape (Task / Solution / Verdict schemas) is owned by the in-tree **SolverNet contract registry** (`client/src/solver-nets/contracts.ts`). The on-chain `solverType` string is the protocol-level join key. |
| **SolverPlugin** | A harness-agnostic substrate package — MCP servers and skills the daemon hands to a Harness's host runtime. Either a SolverType plugin (`jinn.supports: ["prediction.v1"]`) or a runtime plugin (`jinn.supports: ["jinn.runtime"]`); the two modes are exclusive. Manifested as a `jinn.plugin.json` sidecar alongside host plugin manifests (Claude Code, Gemini). Read-only at runtime. Distributable via npm, plugin marketplace, git release, local path, or IPFS. *Plugins do not own schemas or protocol authority; they are runtime tools and skills only.* |
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
─── Protocol authority (in-tree, source of truth) ──────────────────────────
     SolverNet contract registry (client/src/solver-nets/contracts.ts)
       For each SolverType (e.g. "prediction.v1"):
         ├── schemas              → Task / Solution / Verdict shapes
         ├── claimPolicyDefaults
         ├── evaluationFunction   → deterministic scoring
         ├── aggregationFunction  → objective rollup
         └── defaultRuntimePlugins → substrate the daemon auto-resolves

─── Level 1 (group / persistent operator config) ───────────────────────────
     SolverNet (operator config)
       ├── name
       ├── solverType         → schema-versioned identifier (e.g., "prediction.v1")
       ├── harness            → recommended Harness for new operators (operators DO swap this)
       ├── plugins[]          → operator-configured substrate plugins (added on top of contract defaults)
       ├── objective          → defined by the SolverNet contract's aggregationFunction
       └── taskGenerator      → posts Tasks on a cadence (optional)

─── Level 2 (per-item / ephemeral) ──────────────────────────────────────────
     Task (one per posted item; many per SolverNet)
       ├── on-chain           → JinnRouter object with escrow + eligibility
       └── Task payload (IPFS) → solverType + per-Task spec fields

       Solver claims Task → Harness runs → Solution submitted
       Evaluator scores Solution → Verdict produced
       Verdict's score contributes to SolverNet's Objective

─── Operator-installed primitives (substrate that makes a SolverNet runnable) ──
     SolverPlugins (resolved per SolverNet at config load)
       Auto-injected:  bundled:network-tools  (jinn.runtime, every SolverNet gets it)
       From contract:  contract.defaultRuntimePlugins  (provenance: 'default')
       From config:    solverNets.<name>.plugins[]      (provenance: 'configured')

       Each carries:
         ├── jinn.supports     → ["jinn.runtime"] OR [SolverType identifiers]
         ├── jinn.mcpServers   → MCP server entries
         ├── jinn.skills       → skill paths
         └── (no jinn.schemas — schemas live in the contract registry)

     Harness (npm package)
       └── owns flow + improve-phase + tunables (Harness-internal)
```

- **Protocol authority is in-tree.** A SolverType's wire shape, evaluator, and default substrate live in the contract registry. Plugins, configs, and Harnesses do not redefine them.
- **Level 1 is persistent.** A SolverNet is defined once and runs continuously. Its objective accumulates as Tasks resolve.
- **Level 2 is ephemeral.** Each Task is posted, claimed, solved, scored, settled, indexed.
- **The join key is the SolverType identifier (a string).** The IPFS Task payload carries top-level `solverType`; the daemon looks up the contract by that key, validates `task.spec` against the contract's schemas, and dispatches to the SolverNet's Harness (or operator-overridden Harness via `bySolverType`).
- **Plugins are layered, not unique-per-SolverNet.** Network Tools is auto-injected. Contract `defaultRuntimePlugins` come next. Operator-configured plugins come last. De-dup by source and by name. Substrate composes; no single primary-plugin slot.
- **SolverPlugin and Harness are independent.** Plugin ships substrate; Harness owns the runtime (flow, improve-phase, tunables).

The clean separation: **SolverNet contract registry supplies *shape and protocol authority*; SolverPlugin supplies *substrate (tools + skills)*; Harness supplies *how to actually run it*; SolverNet config supplies *what we're trying to improve and which substrate to add*; Task supplies *the specific thing to solve right now*.**

---

## 4. The SolverNet

### 4.1 Definition

A SolverNet is a composition pattern declared in operator config:

```jsonc
{
  "prediction": {
    "enabled": true,
    "solverType": "prediction.v1",
    "harness": "claude-code-learner",
    "plugins": [],
    "taskGenerator": { "enabled": true }
  }
}
```

The SolverType-level data the operator does not see in this config — the schemas, evaluator, aggregation function, and default substrate — is fixed by the SolverNet contract registry (§5.6). The operator does not declare schemas; the contract owns them, and the daemon auto-resolves `defaultRuntimePlugins` plus the auto-injected Network Tools plugin. The operator's `plugins[]` array adds substrate on top.

A SolverNet is **not a protocol object**. JinnRouter doesn't know about SolverNets; it knows about Tasks with `solverType` identifiers. The SolverNet is operator-side coordination — the way a daemon decides "for a Task whose `solverType` matches a SolverNet I have enabled, here is the substrate (contract defaults + auto-injected runtime + my configured extras), the Harness to start with, and the Objective to roll the verdict score into."

### 4.2 What a SolverNet declares

| Field | Purpose |
|---|---|
| `name` | Map key in `solverNets`. Human-readable label used for dashboards, prose, and the `<name> SolverNet` proper-noun in docs. |
| `enabled` | Boolean. When `false`, the daemon skips contract resolution and substrate loading for this SolverNet. |
| `solverType` | The schema-versioned SolverType identifier (e.g., `prediction.v1`). Per `spec/2026-05-schema-versioning.md` grammar. Daemon looks up the matching SolverNet contract; an unregistered SolverType is a config error. |
| `harness` | The Harness this operator wants to use for the SolverType. Defaults to `claude-code-learner` for the bundled experience. Operators are *expected* to override if they want to compete with a different runtime — Harness competition is the whole point of the SolverNet. |
| `plugins[]` | Operator-configured substrate plugins, added on top of contract defaults and the auto-injected Network Tools plugin. Each entry is a string source spec (`bundled:...`, `path:...`, `npm:...`, `github:...`, `claude:...`) or a `{ name?, source, version? }` object. Each plugin's `jinn.supports` MUST include this `solverType` (or be `["jinn.runtime"]`). |
| `taskGenerator.enabled` | When `true`, the auto-poster (today: `creator.ts` + `getTestnetAutoConfig`) runs for this SolverNet. Operators can disable to consume Tasks posted by others without contributing to creation. |

**Where the `objective`, schemas, evaluator, and default substrate live:** in the SolverNet contract registry, keyed by `solverType` (§5.6). The operator config does not redeclare them.

### 4.3 Multiple SolverNets per daemon

A daemon can run more than one SolverNet at a time — e.g., Prediction + Portfolio. Each SolverNet routes Tasks by `solverType` to the SolverNet contract that owns that type, then to the operator's chosen Harness. SolverNets do not compete inside one daemon; they coexist. Cross-SolverNet selection ("which SolverNet should this generic Task go to?") is not a protocol concern — Tasks identify their SolverNet by their type identifier.

---

## 5. The SolverPlugin

### 5.1 What a SolverPlugin is

A SolverPlugin is **what an operator plugs into their Harness to handle a particular SolverType, or to provide shared runtime capabilities to every SolverType.** It is *substrate* — tools and skills. It does not prescribe how to use them, and it does not own the SolverType's wire shape.

A SolverPlugin contains:

- **MCP-tool servers** — process-based tools any MCP-aware Harness can spawn.
- **Skills** — markdown files with frontmatter that plugin-aware host runtimes register (in Claude Code / Gemini, the host plugin format's standard `skills` field). Knowledge files (forecasting techniques, calibration approaches, etc.) are shipped as skills — there's no separate "knowledge" concept.

A SolverPlugin does NOT contain:

- **Schemas.** Task / Solution / Verdict shapes are owned by the **SolverNet contract registry** (`client/src/solver-nets/contracts.ts`), not by plugins. The contract is the protocol-level authority for a SolverType's wire shape; plugins are deliberately demoted to "runtime tools and skills only" so substrate authors can't accidentally redefine the protocol. See §5.6.
- **Flow** — the Harness owns the pipeline. Mandating flow at the plugin level would prescribe how to solve, contradicting the SolverNet's purpose of discovering what works.
- **Tunables** — the Harness owns its improve-phase contract; tunables describe what the *Harness* mutates, not what the plugin ships.
- **Starting Harness** — plugin is harness-neutral. The SolverNet's operator config carries a starting Harness for ergonomics; the plugin itself doesn't bind to one.

The `jinn` extension on a SolverPlugin manifest is **one required field**: `supports: string[]`. Each entry is either a SolverType identifier (e.g. `"prediction.v1"`) — meaning "this plugin provides substrate for that SolverType" — or the literal string `"jinn.runtime"`, meaning "this plugin provides shared runtime tools every SolverType can use." A single plugin's `supports` array MUST be either all SolverType identifiers OR the singleton `["jinn.runtime"]`; mixing the two in one plugin is rejected at load time.

### 5.2 Format — host plugin manifests + a `jinn.plugin.json` sidecar

A SolverPlugin package ships **two manifests** that the daemon and the host runtime consume independently:

- A host-plugin manifest (`.claude-plugin/plugin.json`, `gemini-extension.json`) — contains *only* the standard host plugin fields (`mcpServers`, `skills`, optionally `agents`, `hooks`). The host runtime loads the plugin via this manifest at subprocess start and never reads `jinn.*`.
- A `jinn.plugin.json` sidecar — declares the Jinn-side capability surface: `name`, `version`, and the `jinn` extension (`supports`, optional `capabilities`, `mcpServers`, `skills`). The Jinn daemon's plugin loader reads this file and uses it for plugin discovery, supports-check, and provenance recording. The daemon does not need to parse host manifests; the host runtime does not need to parse the sidecar.

The two-file split is what makes "same package, multiple consumers" work without forcing the host plugin schema to admit a Jinn-specific field. It also lets the network-tools plugin ship a Claude-Code-loadable MCP wrapper *without* declaring a SolverType in its host manifest — its `jinn.plugin.json` declares `supports: ["jinn.runtime"]`, and Claude Code stays oblivious.

The full Prediction SolverPlugin sidecar (`jinn.plugin.json`):

```jsonc
{
  "name": "@jinn-network/prediction-plugin",
  "version": "0.2.0",
  "description": "Prediction plugin pack for prediction.v1 Polymarket forecasting tasks.",
  "jinn": {
    "supports": ["prediction.v1"],
    "capabilities": {
      "tools": {
        "polymarket": ["market.read", "orderbook.read"]
      }
    },
    "mcpServers": {
      "polymarket": {
        "command": "node",
        "args": ["mcp/polymarket-server.mjs"]
      }
    },
    "skills": [
      "skills/base-rate-forecasting/SKILL.md",
      "skills/calibration/SKILL.md",
      "skills/common-biases/SKILL.md",
      "skills/prediction-corpus-retrieval/SKILL.md",
      "skills/polymarket-task-handling/SKILL.md"
    ]
  }
}
```

The matching `.claude-plugin/plugin.json` in the same package carries only host fields (`name`, `version`, `description`, `mcpServers`, `skills`) — no `jinn` field.

**Field semantics for the `jinn` extension:**

| Field | Purpose |
|---|---|
| `jinn.supports` | Required `string[]`. Either a list of SolverType identifiers this plugin provides substrate for (per `spec/2026-05-schema-versioning.md` grammar) or the singleton `["jinn.runtime"]` for shared runtime plugins. The two modes are exclusive: a single plugin cannot mix SolverType-specific entries with `jinn.runtime`. |
| `jinn.capabilities` | Optional. Free-form documentation of the tools/skills this plugin exposes, indexed by MCP server name. Informational; not enforced by the loader. |
| `jinn.mcpServers` | Optional. Jinn-side declaration of MCP servers; lets the daemon describe the shared runtime tool surface (e.g. `network-tools` declares `providedBy: "jinn-client-runtime"` to mark its MCP server as daemon-provided rather than spawned by the host). |
| `jinn.skills` | Optional. Skill manifest paths — same content the host manifest's `skills` field carries, repeated here so the daemon can resolve them without reading the host manifest. |

The sidecar is JSON-Schema validated at install time and at session start. Unknown `jinn.*` keys fail loud (forward-compat).

### 5.3 No-substrate-plugin-installed behaviour

A Task's wire shape is validated against the SolverNet contract registry's schemas (§5.6), not against a plugin. So plugin absence is a substrate concern, not a validation concern:

- If a Task arrives for a SolverType whose substrate plugin isn't installed, the daemon still validates the Task spec against the contract's schemas and dispatches normally.
- The Harness decides whether it can attempt the Task without that substrate: refuse via `canAttempt → { ok: false, reason: 'no substrate for prediction.v1' }`, or proceed with reduced capability (no domain-specific MCP tools or skills loaded).
- For first-party SolverNets like Prediction, the default daemon ships `@jinn-network/prediction-plugin` pre-installed — so this case is moot in practice.
- Network Tools (`@jinn-network/network-tools`, `supports: ["jinn.runtime"]`) is auto-injected into every SolverNet at config load (§5.6). It does not need to be declared in `solverNets.*.plugins`.
- Permissionless operators introducing new SolverNets ship a substrate plugin alongside the new SolverType's contract definition. The contract owns the wire shape; the plugin owns the substrate.

### 5.4 Distribution and install

The SolverPlugin format is distribution-agnostic. The daemon's `jinn plugins add` verb supports multiple resolvers:

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

1. The `jinn.plugin.json` sidecar parses.
2. `jinn.supports` is a non-empty `string[]`; entries are either valid SolverType identifiers (per `spec/2026-05-schema-versioning.md` grammar) or the singleton `["jinn.runtime"]`. The two modes are exclusive.
3. Optional `jinn.skills` paths exist; optional `jinn.mcpServers` entries are well-formed.
4. If a host manifest is present (`.claude-plugin/plugin.json`, `gemini-extension.json`), it parses against the host plugin schema, but the loader does not enforce a relationship between host fields and `jinn.*` — they're consumed by different runtimes.
5. The plugin is associated with whichever SolverNet contract(s) match a `jinn.supports` entry, plus auto-injected as a runtime plugin into every SolverNet if `supports: ["jinn.runtime"]`.

**Default daemon defaults are baked into the SolverNet contract registry, not a config field.** Each contract carries `defaultRuntimePlugins: string[]`; the daemon resolves those entries automatically at SolverNet load time, with provenance `'default'`. Operators add their own substrate via `solverNets.*.plugins`, with provenance `'configured'`. Network Tools is auto-injected ahead of the contract defaults so every SolverNet gets the shared runtime tools without declaring them. See §5.6 and §11.6 for the loader semantics.

### 5.5 Versioning + compatibility

- **SolverPlugin content** (`@jinn-network/prediction-plugin` itself) follows semver. Breaking changes to substrate bump the major; new tools / skills are minor; bug fixes are patches. Schemas don't ship with plugins (§5.6) so plugin majors are not gated on protocol-level shape changes.
- **The `jinn` extension's own schema** follows semver with a 12-week deprecation window. v1 ships with one required field (`supports`) and three optional ones (`capabilities`, `mcpServers`, `skills`); minor adds won't break existing plugins.
- **Operators receive new plugin versions** via the same upgrade path as any npm dep / plugin-marketplace package. The SolverNet curator pins a version range; the curator updates that range as substrate evolves.

### 5.6 Schema authority lives with the SolverNet contract, not the plugin

A SolverType's wire shape (Task / Solution / Verdict) is owned by an in-tree **SolverNet contract** in `client/src/solver-nets/contracts.ts`, not by a plugin's `jinn.schemas`. The contract registry maps each SolverType to a `SolverNetContract` carrying:

- `schemas: { task, solution, verdict }` — Zod schemas the daemon validates against at dispatch (Task spec) and envelope-assembly (Solution payload). The protocol's authoritative shape.
- `claimPolicyDefaults` — claim-policy semantics for Tasks of this SolverType.
- `evaluationFunction` / `aggregationFunction` — deterministic evaluator + objective rollup.
- `defaultRuntimePlugins: string[]` — substrate plugins the daemon auto-resolves for any SolverNet declaring this SolverType. Today: `['bundled:jinn-prediction-plugin']` for `prediction.v1`.

The contract is *protocol authority*: a SolverType's shape changes when the contract changes, not when a plugin ships. This is the point — substrate authors can iterate on tools and skills without redefining the wire format, and the loop's deterministic evaluator can rely on a stable shape.

Plugins are demoted to **runtime substrate**: tools, skills, and the operator's permission to install them. They cannot redefine `prediction.v1`'s Task shape any more than a JIT can redefine an opcode.

This is a design pivot from earlier drafts of this spec, which placed `jinn.schemas` on the plugin manifest. The pivot is deliberate:

- It separates protocol authority (SolverNet contract) from substrate authority (plugin), giving each a clean owner.
- It makes plugin install permissionless — no plugin can claim authority over an existing SolverType.
- It moves "what does the wire look like for prediction.v1" from "fetch this plugin and read schemas/" to "look at the in-tree registry," which is much easier to reason about under audit.

Permissionless SolverType creation in v1 therefore requires a contract PR in addition to a plugin release. This is the same trade-off the protocol layer (JinnRouter, ValidationRegistry, etc.) already makes. Phase B+ may relax this with an on-chain SolverNet contract registry.

The SolverNet config + plugin loader contract under this model is:

```
┌─ SolverNet contract registry (in-tree, protocol authority) ──────────────
│   prediction.v1 → { schemas, evaluationFn, aggFn, defaultRuntimePlugins }
└──────────────────────────────────────────────────────────────────────────

┌─ Operator config (solverNets.prediction) ────────────────────────────────
│   { enabled, solverType, harness, plugins, taskGenerator }
│      └── plugins[] are operator-configured runtime plugins,
│          *added on top of* the contract's defaultRuntimePlugins
│          and the auto-injected Network Tools plugin.
└──────────────────────────────────────────────────────────────────────────

┌─ Plugin loader (client/src/plugins, client/src/solver-nets/registry) ────
│   For each enabled SolverNet:
│     1. Auto-inject @jinn-network/network-tools (provenance: 'default').
│     2. Resolve contract.defaultRuntimePlugins (provenance: 'default').
│     3. Resolve operator config plugins[] (provenance: 'configured').
│     De-dup by source and by name; runtime plugins skip the
│     supports-includes-solverType check (they support 'jinn.runtime').
└──────────────────────────────────────────────────────────────────────────
```

The `provenance` field on the loaded `RuntimePlugin` is what downstream consumers (dashboard, executor envelope, diagnostics) use to show whether a plugin came in through the contract default or the operator's explicit config.

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

The Task payload is the JSON-stored description of *what* this specific Task is asking for. It carries a top-level `solverType` field identifying the SolverType, plus a nested `spec` object whose shape is validated against the SolverNet contract registry's schemas (§5.6):

```jsonc
// example: a single Polymarket-derived Prediction Task (shape per the
// prediction.v1 contract in client/src/solver-nets/contracts.ts)
{
  "solverType": "prediction.v1",
  "role": "restoration",
  "spec": {
    "question": { "kind": "binary", "text": "Will the Fed cut by 50bps before July 2026?" },
    "source": { "type": "prediction-market", "venue": "polymarket", "identifiers": { "conditionId": "0x..." } },
    "resolution": { "expectedResolutionTime": "2026-07-01T00:00:00Z", "rulesUrl": "https://polymarket.com/event/..." },
    "consensusSnapshot": { "sampledAt": "2026-04-30T00:00:00Z", "probabilityYes": "0.62" }
  }
}
```

The `solverType` field on the Task is the **join key** between protocol and operator-side. The daemon receives the Task, reads the Task payload from IPFS, looks up the SolverNet contract for that `solverType`, validates `task.spec` against the contract's task schema, and dispatches to the operator's chosen Harness for the SolverType (or the operator's per-SolverType override).

### 6.3 What changes vs. today

Field renames only. The shape of the on-chain object and the IPFS-stored Task are otherwise unchanged. The protocol-level loop (Creator → Solver → Evaluator) operates identically; we are renaming, not redesigning. Deployed contract identifiers (`createRestorationJob`, `deliverToMarketplace`, etc.) stay because they're tied to live contracts; only the conceptual role label and TypeScript-level identifiers change.

---

## 7. The Harness

### 7.1 Renames

- **Type:** `RestorerImpl → Harness`. Interface in `client/src/restorer/types.ts` renamed; directory `client/src/restorer/` → `client/src/harnesses/`; `RestorationContext → HarnessContext`; `RestorationOutput → Solution`; `restorationPayload → solutionPayload`.
- **Path 2 SDK:** `@jinn-network/restorer-sdk` → `@jinn-network/harness-sdk`, dual-publish for 12 weeks.
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

- **Substrate (tools + skills) lands through the host plugin system, but the daemon still does placement and launch wiring.** `claude-code-learner` spawns a Claude Code subprocess. The daemon resolves SolverPlugins, places them on disk, and points the subprocess at the relevant plugin roots / MCP config (today via `--plugin-dir`, `--mcp-config`, and `JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT`). Claude Code's native loader then loads skills, MCP servers, and hooks from those locations. Gemini-CLI Harnesses inherit the same pattern for Gemini's plugin loader: Jinn resolves and points; the host runtime loads.
- **Schema validation is the daemon's job, against the SolverNet contract registry.** When a Task arrives, the daemon reads the contract for its `solverType`, validates the spec, dispatches. When a Solution comes back, the daemon validates it against the same contract's `solution` schema before envelope assembly. Plugins do not own schemas; Harnesses don't need to do schema work themselves.
- **Path 2 specialists** (e.g., a hardcoded `prediction-v0-baseline` that doesn't run a Claude Code subprocess) simply don't read the plugin directory. There's no flag to declare; they just don't engage with the substrate.

So plugin handling distributes naturally:
- Daemon: resolves plugins, validates `jinn.plugin.json` sidecars, validates Task/Solution shapes against contract schemas, ensures plugin content lives where the host runtime expects, and passes the host-specific launch pointers.
- Host runtime (Claude Code / Gemini): loads plugin tools/skills natively at subprocess start.
- Harness: just runs.

No `PluginLoader` interface, no `HarnessRuntimeArtifacts` type, no `pluginAware` flag. Less spec surface, less code, fewer concepts to keep aligned.

### 7.5 The default learner under this model

`claude-code-learner` runs the seven-phase pipeline (per `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md`) end-to-end — the pipeline (orient → strategize → plan → execute → debrief → improve → memory-consolidation) is **the Harness's flow, not the SolverPlugin's**. When the learner spawns its Claude Code subprocess, Claude Code natively loads the operator's installed plugins; the auto-injected Network Tools, the contract-default substrate plugin, and any operator-configured extras all become available to the pipeline's agents.

Schema validation happens at the daemon boundary against the SolverNet contract registry, not inside the learner and not against plugin manifests. The daemon validates incoming Task specs against `contract.schemas.task`; the learner produces a Solution payload; the daemon validates it against `contract.schemas.solution` before envelope assembly. The learner doesn't need to import schemas itself.

Without the contract-default SolverPlugin installed for a Task's SolverType, the daemon still validates the Task against the contract registry's schemas and dispatches; the Harness can refuse via `canAttempt` if it can't operate without the substrate. For first-party SolverNets, the default plugin is pre-resolved via `contract.defaultRuntimePlugins`; this is a non-issue in practice.

The improve phase mutates `implStateDir/`. The mutation surfaces are:
- **`implStateDir/skills/<name>/SKILL.md`** — operator-learned skills. Loaded alongside plugin-shipped skills; on name collision, operator-learned wins (override semantics below).
- **`implStateDir/agents/<name>.md`** — operator-learned agents. Same override semantics.
- **`implStateDir/tunables/<tunable>.json`** — operator-learned values for *Harness-declared* tunables (the learner declares its own knobs — calibration aggressiveness, ensemble size for its own ensemble step, corpus-lookup top-k, etc.). Tunables are a Harness contract, not a plugin contract; alternative Harnesses define different tunables relevant to their own pipelines.
- **`implStateDir/configs/<name>.json`** — operator-learned config overrides.

**Override semantics:** at subprocess start, Claude Code natively loads plugin-shipped skills (from the host plugin directory) alongside operator-learned skills (from `implStateDir/skills/`). On name collision, the operator-learned skill wins per the host's existing override rules. The plugin-shipped skill remains on disk for inspection / `git diff` purposes; it is just not the one loaded when an override exists. Clean separation: "from the plugin" (read-only, inspectable) vs. "operator-learned" (loaded, mutable).

### 7.6 Daemon's plugin responsibility (minimal)

The daemon's plugin handling is small and entirely outside the Harness:

1. **Resolve.** For each enabled SolverNet, resolve the auto-injected Network Tools plugin, the contract's `defaultRuntimePlugins`, and the operator's `solverNets.<name>.plugins[]` (npm / marketplace / git / local / bundled / IPFS) and ensure each plugin's contents are unpacked where the host runtime expects.
2. **Validate sidecars.** Parse `jinn.plugin.json`, confirm `jinn.supports` is a valid `string[]` (per §5.1 grammar), confirm `jinn.skills` paths exist and `jinn.mcpServers` entries are well-formed.
3. **Look up schemas from the contract registry.** Schemas are not registered from plugins; they're already in `client/src/solver-nets/contracts.ts`. The daemon validates Task specs at dispatch and Solution payloads at envelope assembly against `contract.schemas.{task,solution}`.
4. **Wire subprocess launch inputs.** For host-backed Harnesses, pass the host-specific plugin roots / MCP config to the subprocess. Today `claude-code-learner` uses `--plugin-dir`, `--mcp-config`, and `JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT`; future Gemini/Codex Harnesses use their host's equivalent.
5. **Health-check plugins on install** (sidecar parses, supports list valid, MCP entry files exist). Runtime health (do the MCP servers actually start? do skills load?) is the host runtime's domain after launch.

That's it. No Harness-side `PluginLoader` interface, no `HarnessRuntimeArtifacts` translation, no `pluginAware` flag. When the learner spawns its Claude Code subprocess, Claude Code does the work of loading plugin tools/skills natively. Path 2 specialists that don't run a Claude Code subprocess simply don't engage with plugins — no negotiation needed.

The `client/src/plugins/` module (§11.6) is small for the same reason — it's resolvers + sidecar validator + CLI verbs. No translation layer, no schema registration step.

---

## 8. Trust boundaries

The reframe gives three named surfaces with clear ownership:

| Surface | Owner | Mutability | How signed |
|---|---|---|---|
| SolverNet contract (schemas + evaluator + default substrate) | Protocol (in-tree) | Read-only at runtime; changes via PR | Repo + release process; on-chain delegation deferred to Phase B+ |
| SolverPlugin content (sidecar + tools + skills) | Plugin author | Read-only at runtime | Plugin-marketplace publish / npm publish + (Phase B) signed manifest per `spec/2026-05-executor-trust-boundary.md` |
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
| SolverType | `prediction.v1` (operator config; matched to a contract in `client/src/solver-nets/contracts.ts`) |
| SolverNet contract | `PREDICTION_V1_SOLVER_NET_CONTRACT` — owns task/solution/verdict schemas, claim policy, deterministic Brier-loss evaluator, trailing-mean-brier-spread aggregation. `defaultRuntimePlugins: ['bundled:jinn-prediction-plugin']`. |
| Default substrate | `@jinn-network/network-tools` (auto-injected) + `@jinn-network/prediction-plugin` (contract default). Both at `client/plugins/`. Provenance: `'default'`. |
| Operator-configured substrate | None by default; operators add via `solverNets.prediction.plugins[]` with provenance `'configured'`. |
| Objective | Brier-spread vs. Polymarket consensus, rolling 84-day window, lower-is-better (#57 §5). Owned by the contract's `aggregationFunction`. |
| Task generator | Polymarket-derived auto-poster (Phase A.3 — separate plan). Toggled via `solverNets.prediction.taskGenerator.enabled`. |
| Starting Harness | `claude-code-learner` (the bundled default; operators are expected to override via `bySolverType` to compete with their own runtime) |
| Public dashboard | `https://jinn.network/solvernets/prediction` (separate plan) |

**Out-of-the-box state for a default operator:**

The daemon resolves Network Tools + the prediction plugin from `contract.defaultRuntimePlugins`, the learner becomes the Harness for `prediction.v1`, the creator loop posts Polymarket-derived Tasks, the loop runs end-to-end. No additional configuration needed.

**v1 contents of `@jinn-network/prediction-plugin`:**

- `mcp/polymarket-server.mjs` ships read-only Polymarket tools (`polymarket_get_market`, `polymarket_get_orderbook`) for the current task's identifiers.
- `skills/` populated with: `base-rate-forecasting`, `calibration`, `common-biases`, `polymarket-task-handling`, `prediction-corpus-retrieval`. Each skill is a markdown file with frontmatter — domain knowledge embedded as instruction, consumable by any Claude Code-shaped Harness.
- `jinn.plugin.json` declares `supports: ["prediction.v1"]`, the polymarket MCP server, and the skill list. No `jinn.schemas` — schemas live in the contract registry.
- `.claude-plugin/plugin.json` (host manifest) carries the polymarket MCP server pointer for Claude Code's native loader and the same skill list. No `jinn` field in the host manifest.
- Claude Code natively loads the plugin when the learner's subprocess starts; daemon validates Task specs and Solutions against `PREDICTION_V1_SOLVER_NET_CONTRACT.schemas` at the dispatch and envelope-assembly boundaries.
- An end-to-end e2e test posts a fake `prediction.v1` Task on Anvil and asserts the learner produces a `Solution.solutionPayload` validated against the contract's solution schema.

**v1 contents of `@jinn-network/network-tools`:**

- `mcp/jinn-client-server.mjs` — wrapper that the Claude Code host manifest points at; resolves the Jinn client's MCP server (`search_records`, `inspect_record`, `acquire_artifact`, `get_task`) for the current daemon.
- `jinn.plugin.json` declares `supports: ["jinn.runtime"]`, marks the MCP server as `providedBy: "jinn-client-runtime"`, and lists the four tools.
- Auto-injected into every SolverNet at config load (`registry.ts:JINN_NETWORK_TOOLS_PLUGIN`).

**What is NOT in either v1 plugin** (lives elsewhere):

- Schemas → owned by the SolverNet contract registry (§5.6).
- The seven-phase flow → owned by `claude-code-learner` (its existing pipeline; uses plugin tools and skills as resources).
- Calibration / ensemble / corpus-lookup tunables → owned by `claude-code-learner` and declared in its own manifest, populated with operator-learned values under `implStateDir/tunables/` over time.
- The Task generator → declared in the SolverNet config (§4 / §11.8).

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
- Rename `@jinn-network/restorer-sdk` → `@jinn-network/harness-sdk`. Dual-publish for 12 weeks; the old package re-exports from the new with a deprecation `console.warn`.
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

### 11.5 SolverType authority lives in the SolverNet contract registry

The existing `client/src/intents/kinds/<kind>/` modules contain Zod schemas + TypeScript types for first-party SolverTypes. Under this spec:

- The Zod schemas migrate to `client/src/solver-nets/contracts.ts` as the SolverNet contract registry's canonical schemas (§5.6). For `prediction.v1`: `PREDICTION_V1_SOLVER_NET_CONTRACT.schemas.{task,solution,verdict}`.
- The contract registry is the single source of truth for a SolverType's wire shape. Plugins, configs, and Harnesses reference it; they do not redefine it.
- The directory `client/src/intents/kinds/` is renamed to `client/src/solver-types/` and holds *adapter* modules (auto-poster wiring, helpers) only — no canonical schema content.

The auto-poster wiring in `client/src/intents/kinds/index.ts` is vocabulary-renamed (`SOLVER_TYPES`, `getTestnetAutoConfig`, `collectTestnetAutoIntentGenerators`). A later cleanup may move those adapter modules to `client/src/solver-types/`; this PR keeps the path stable to reduce churn while removing canonical schema authority from it.

### 11.6 SolverPlugin mechanism

- Module: `client/src/plugins/`.
  - `resolvers.ts` — multi-format resolvers (`bundled:`, `path:`/`file:`, `npm:`, `git:`, `github:`, `claude:`). Each takes a spec string and an entry name, fetches the package via the appropriate handler, materializes it into the operator's vendor root (`~/.jinn-client/solver-plugins/<name>/`), and returns a normalized `LoadedSolverPlugin`. Bundled plugins refresh-on-drift via a sha256 marker; concurrent resolutions hold a directory-based lock per plugin name.
  - `manifest.ts` — loads and validates the `jinn.plugin.json` sidecar (preferred) or falls back to a host manifest extended with a `jinn` field if no sidecar is present.
  - `digest.ts` — computes plugin sha256 over directory contents.
  - `types.ts` — `SolverPluginManifest`, `LoadedSolverPlugin`, `SolverPluginEntry`, `SolverPluginSourceKind`.
  - `cli.ts` — `jinn plugins list / add / remove / show` (verbs land alongside `solver-nets`).
- The SolverNet loader (`client/src/solver-nets/registry.ts`) calls into `resolvers.ts` for each SolverNet:
  1. auto-inject `bundled:network-tools` (`provenance: 'default'`),
  2. resolve each entry in `contract.defaultRuntimePlugins` (`provenance: 'default'`),
  3. resolve each entry in `solverNets.<name>.plugins[]` (`provenance: 'configured'`),
  4. de-dup by source and by name; runtime plugins (`supports: ["jinn.runtime"]`) skip the supports-includes-solverType check.
- Daemon `main.ts` initialises the SolverNetRegistry before constructing the Harness registry. Plugin contents are pre-vendored under `~/.jinn-client/solver-plugins/`; subprocess launch wiring (e.g. `claude-code-learner`'s `--plugin-dir` flags) points the host runtime at those vendor paths.
- `@jinn-network/prediction-plugin` ships at `client/plugins/jinn-prediction-plugin/`, `@jinn-network/network-tools` at `client/plugins/network-tools/`. Both carry a `jinn.plugin.json` sidecar plus a Claude-Code-loadable `.claude-plugin/plugin.json`.
- Schemas are *not* registered from plugins — the SolverNet contract registry already holds them (§5.6). The plugin loader does shape-validation of `jinn.plugin.json` only.
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
      "harness": "claude-code-learner",
      "plugins": [],
      "taskGenerator": { "enabled": true }
    }
  }
}
```

The schemas, evaluator, aggregation function, and default substrate (`bundled:jinn-prediction-plugin` plus the auto-injected `bundled:network-tools`) come from the SolverNet contract registry (§5.6). Operators do not declare them.

Existing operators on testnet receive a one-time config-migration prompt at daemon start (`jinn migrate-config`) that produces the above shape.

---

## 12. What we're explicitly deferring

- **Tight Task-plugin association on-chain.** A Task does not currently reference a recommended plugin. v1 is loose-association: operator config maps SolverTypes to plugins. Tight association (e.g., a `recommendedPluginCid` field on the Task) is Phase B+.
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
3. **Path 2 builders losing the slot ergonomics — is "fork the learner" actually a viable recruit path?** This is the most genuine concern of the Path 1 retirement. Mitigation: the learner repo includes a `learner-template/` directory with a stripped-down skeleton; the recruit story becomes "fork the template, swap your specialist code in, optionally re-use the same `@jinn-network/harness-sdk` SDK." If recruits report this is too high-friction, Phase A.4 retro re-opens the slot taxonomy as a follow-up.
4. **Curator role formalization.** The SolverNet curator (the entity who lands a SolverNet contract PR — schemas, evaluator, default substrate, objective — and the Task generator) is named implicitly in this spec but not formalized as a distinct role. Whether it surfaces in code (e.g., a curator address recorded with each SolverNet contract), in canonical docs (Creator / Solver / Evaluator / Curator), or stays implicit — open. Worth its own pass, especially as the in-tree contract registry becomes the bottleneck for permissionless SolverType creation.
5. **Should `solverNets[]` config be operator-side declarative as shown in §11.9, or should SolverNet definitions ship as their own npm packages (e.g., `@jinn-network/prediction-solvernet`) that bundle objective + Task-generator config + plugin reference together?** Lean: operator-side config in v1 (simpler); promote to dedicated SolverNet packages if multiple SolverNets ship and the bundling reduces operator burden.
6. **Solver as a noun in code.** The role rename to Solver is committed; should it surface in code (e.g., a `Solver` class composing `Harness` + identity), or stay a role-label only? Lean: role-label only in v1; the operator entity is already represented by the Safe + Harness pair.
7. **Cross-host plugin-format mapping.** Claude Code uses `.claude-plugin/plugin.json`; Gemini uses `gemini-extension.json`; Codex has its own. The shapes are similar but field names differ. v1 commits to: a plugin ships *one* canonical host-shape (Claude Code plugin in v1, since that's what Jinn's daemon spawns); other hosts can read the same package via field-mapping shims. A formal multi-host manifest spec is a follow-up bead if we ship a Gemini-CLI Harness and discover the shim is too lossy.

---

## 14. Acceptance criteria

This spec is accepted when:

1. **Merged under `spec/`.**
2. **Cross-references added** to the sibling specs (§ lineage list) and to `spec/2026-04-30-plug-in-surface.md` marking §4 (Path 1) superseded.
3. **`@jinn-network/harness-sdk` v1.0.0 published** (renamed from `restorer-sdk`); 12-week dual-publish window declared.
4. **Wrapper code deleted** per §11.1.
5. **Rename PR merged** per §11.2 + §11.3 + §11.4; `jinn-mono-juw` / GH#43 closed.
6. **`client/src/plugins/` module shipped** with resolvers, loader, validator, CLI, and unit tests.
7. **Envelope executor fields updated** per §9.1: `executor.codeDigest` retains build-time semantics, `executor.runtimeBundleDigest` is populated at envelope-creation time from the Harness build + resolved plugin set, and `executor.plugins[]` lists the loaded plugin breakdown. Implementation preserves `client/src/build-info.ts` as the build digest source and extends envelope assembly for runtime-derived fields.
8. **`@jinn-network/prediction-plugin` v0.1.0 shipped** at `client/plugins/jinn-prediction-plugin/` with the §10 contents — schemas + tools + skills + `jinn` extension — and passing CI.
9. **e2e validation** — the existing `yarn e2e` script extended to assert: Network Tools auto-injects, the prediction plugin resolves from `contract.defaultRuntimePlugins`, daemon validates Task spec against `PREDICTION_V1_SOLVER_NET_CONTRACT.schemas.task`, Claude Code subprocess loads both plugins natively, the learner produces a `solutionPayload` validated against `contract.schemas.solution`, `executor.codeDigest` remains the build digest, `executor.runtimeBundleDigest` is populated, and `executor.plugins[]` correctly lists the loaded plugins (with provenance).
10. **Specialists re-disposed** per §11.8; `examples/external-harnesses/` directory created.
11. **Retired Path 1 implementation deleted** per §11.7: `client/src/restorer/plug-ins/`, `examples/learner-plug-ins/@jinn-examples/`, the `jinn plug-ins` slot-taxonomy CLI surface, and `JINN_SLOT_REGISTRY_JSON` launch wiring are gone or replaced by SolverPlugin equivalents.
12. **Default config updated** per §11.9; `jinn migrate-config` verb shipped.
13. **In-repo SolverType modules migrated** per §11.5 (schemas live in the plugin; in-repo holds adapter / auto-poster wiring only).

The campaign-launch gate (#57 §1) is *not* acceptance for this spec — it is acceptance for Phase A.4. This spec ships the architecture that makes the campaign run.

---

*End of v0.8.*
