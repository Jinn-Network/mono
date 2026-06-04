# DR-2026-06-04 — The bring-your-own-plugin journey: walked end-to-end

- **Date:** 2026-06-04
- **Author:** Ritsu
- **Status:** Finding (spike output for [#1033](https://github.com/Jinn-Network/mono/issues/1033))
- **Shape:** `spike` — output is this finding, not code.

## Frame (amended from the issue)

The issue scoped this as a *bring-your-own-**RL**-plugin* walk. On review the
RL framing is too narrow: the journey a builder walks is the same regardless of
what the plugin does. So this finding walks the **generic** plugin-builder
journey — "how you get any plugin working in Jinn, end-to-end" — and treats
RL-on-harness as one worked example (the plugin type we think is most viable,
per [#689]/[#824]/[#692]), not the lens. AC#2 is answered inside that worked
example (§4).

## TL;DR — the premise is inverted

The issue's open question was *"whether these pieces compose into a seamless
path."* They do. **The substrate is substantially complete and composes.** The
full loop — scaffold → validate → pack → publish (ERC-8004 + lazy Stage-1
bootstrap) → discover → index → Discovery API → operator-app panels → explorer
comparison-by-plugin — is shipped on `origin/next` today. The earlier internal
map under-reported this because it read a stale local checkout; reading
`origin/next` directly corrected it.

The real gaps are narrower and more specific than "does it compose":

1. **No agent-driven on-ramp.** Only the CLI scaffold exists. There is no
   conversational "create a plugin" skill. *(This is the AC#3 deliverable; §5.)*
2. **The `/build` SPA is feature-gated OFF by default.** A builder following the
   docs is told to "open the `/build` route" but sees a redirect unless the
   daemon was started with `JINN_ENABLE_PLUGIN_BUILDER_UI=1`.
3. **The scaffold is a bare placeholder.** `skills/example/SKILL.md` ships the
   text "This skill is a placeholder." There is no opinionated starting point
   for a real plugin — and nothing that points an RL builder at the learner
   substrate or the held-out exam.
4. **Comparison is plugin-granular, not builder-granular.** You can group/filter
   learning curves by plugin; you cannot rank or browse "everything this builder
   published." The `/builders/:address/artifacts` API exists; the explorer UI
   exposes no by-builder dimension.
5. **Publish UX papercuts.** The documented happy path requires a public
   `npm publish` first; `validate` silently materializes the plugin into a
   global directory.

## §1 — The walk

Persona: an external builder bringing a plugin (skills + MCP) to improve solve
quality. Method (per the spike's agreed scope): run live what runs cheaply,
trace what writes on-chain or needs Docker/disk.

| Step | Surface (file:line) | Result |
|------|--------------------|--------|
| **1. Scaffold** | `client/src/cli/commands/create.ts`; templates `client/templates/plugins/solver-type-plugin/` | **LIVE.** `jinn create plugin @ritsu/my-rl-plugin --pattern solver-type-plugin --solver-type prediction.v1` emitted a 7-file package with a valid `jinn.plugin.json` (`supports: ["prediction.v1"]`, `skills: ["skills/example/SKILL.md"]`). Clean. |
| **2. Validate + pack** | `jinn solver-plugins {validate,pack}`; `client/src/plugins/validator.ts`, `digest.ts` | **LIVE.** Both returned `ok:true` with a stable `sha256`. **Friction:** `validate` materialized the plugin into `~/.jinn-client/solver-plugins/my-rl-plugin/` — a global side effect for what reads as a pure check. |
| **3. Publish** | `client/src/cli/commands/solver-plugins-publish.ts`; `client/src/erc8004/plugin-registry.ts`; `FleetBootstrapper.ensureStage1` | **TRACED** (writes on-chain). 6-step pipeline: resolve → pack → `ensureStage1` (lazy ETH-only identity bootstrap) → IPFS pin → write `plugin:<cid>` on the ERC-8004 IdentityRegistry. Surfaces an `ensure_stage1_failed` envelope with a funding hint when the EOA is unfunded. **Friction:** quickstart step 3 tells the builder to `npm publish --access public` *first*; the local-path/`.tgz` source works too but the docs lead with the npm round-trip. |
| **4. Join + load** | `client/src/config.ts` `joinedSolverNets[].plugins`; `client/src/plugins/registry.ts:24` `loadSolverPlugins`, `:15` `forSolverType` | **LIVE (loader).** A probe calling the daemon's own `loadSolverPlugins(['file:…/my-rl-plugin'])` registered the plugin and resolved it for `prediction.v1` — and correctly returned `[]` for `swe-rebench-v2.v1`. The `supports` gating works. (Full daemon+Anvil scored run traced, not run — the heavy boundary.) |
| **5. Score + compare** | `client/src/harnesses/engine/envelope-assembly.ts` (`executor.plugins[]`); `client/src/corpus/envelope-projection.ts`; `packages/indexer/src/api/slice.ts:266` `computePluginSeries`, `:254` `applyFilters` | **TRACED (all shipped).** The signed envelope carries `executor.plugins[]` (name/version/cid/sha256); the indexer projects it; `/explorer/slice` groups and filters learning curves by `plugin`. |

### Indexing + discovery (shipped, verified on `origin/next`)

- **Ponder model:** `packages/indexer/ponder.schema.ts:490-535` — `pluginPublication`
  (builderAgentId, pluginCid, pluginName/version/sha256, supports[], publishedAt,
  revoked, revokedReason). Handler parses `plugin:<cid>` MetadataSet events
  (`packages/indexer/src/handlers.ts`), v1 publish + v2 revoke.
- **Discovery API:** `packages/indexer/src/api/{index,routes}.ts:121-212` —
  `GET /plugins?solverNet=` / `?builder=`, `/plugins/:cid/scores`,
  `/builders/:address/artifacts`.
- **CLI read verbs:** `jinn solver-plugins {discover,status,list-feedback}` —
  discovery is *not* a gap; it exists at the CLI against the DiscoveryAPI.
- **Operator-trust surface:** `endorse/warn/block/review/respond` write ERC-8004
  ReputationRegistry feedback anchored to `plugin:<cid>`.
- **Builder docs:** a full `client/docs/build/` tree exists (quickstart,
  shape-reference, examples, publishing-flow, identity, compatibility).

## §2 — Does the journey compose? Verdict

Yes, mechanically. A CLI-fluent builder can go scaffold → publish → see their
plugin scored and compared without hitting a missing surface. The friction is
not missing pieces; it is **discoverability and on-ramp**:

- The most discoverable surface (`/build` SPA) is dark by default (gap #2).
- The lowest-friction on-ramp (a guided/agent flow) doesn't exist (gap #1).
- The scaffold gives a builder an empty room, not a worked starting point (#3).

## §3 — Comparison UI verdict (AC#4)

The existing `/explore` → `/solvernet/<cid>` filterable-learning-curves UI **is
sufficient for config comparison** and already treats `plugin` as a first-class
filter and group dimension (`packages/indexer/explorer/src/lib/url-state.ts`
`FILTER_DIMS` / `GROUP_VALUES` both include `plugin`). A bespoke side-by-side or
graph view is **not** justified — the curve overlay already does side-by-side by
group key.

The one missing axis is **builder granularity**: the UI exposes
operator/harness/plugin/mode/model but no by-builder-agentId dimension, so a
builder cannot see "all my plugins, ranked." The backing data
(`/builders/:address/artifacts`) ships; only the UI control is missing. That is
a small, justified addition — recommended as F4, not a new view.

## §4 — Worked example: an RL-flavored plugin (answers AC#2)

Per [#689] (DR: "the harness *is* the policy"), Jinn has two RL-tractable layers
— **retrieval/RAG** and **harness-parameter mutations** (the learner's 7-tier
action surface in `client/plugins/learner/skills/learn/promoter-prompt.md`);
model weights are out of reach. A SolverPlugin is, by construction, **skills +
MCP tools with the wire schemas frozen** (`validator.ts` rejects `schemas`/
`solverType` on a plugin — the SolverNet contract owns those).

So the generic journey serves an RL builder, with one **framing** gap, not a
code gap:

- A plugin is a **tool/skill contribution** — it feeds the retrieval and tool
  layers the policy exploits. It is *not* the policy.
- The **policy** — the thing that mutates and improves — is the **learner
  harness** (Path 2), not the plugin. An RL researcher whose mental model is "I
  bring a policy/algorithm" will look for a hook that isn't there, because the
  mutation loop lives in the harness.
- The only honest "did my plugin improve anything?" signal is the **held-out
  exam** ([#824]); the journey never points the builder at it.

Nothing in the scaffold or docs says this. The fix is framing + an opinionated
template (F3) and a docs page (F5), not new substrate.

## §5 — Agent on-ramp spec: `.claude/skills/create-plugin/` (answers AC#3)

A human-invoked Claude Code skill (modeled on `.claude/skills/file-issue/`),
the conversational front door to the shipped CLI. **It writes no new substrate —
it drives `jinn create plugin`, the `solver-plugins` verbs, and a config edit,
and verifies the result.**

**Trigger / description:** "create a plugin", "build a Jinn plugin", "start a
solver plugin", `/create-plugin`.

**Inputs it collects (cap the interview at 3–4 questions):**

| Slot | What it needs | Default if missing |
|------|---------------|--------------------|
| Package name | npm-style `@you/name` | ask — required |
| What the plugin does | one line; used to draft the skill body | ask — required |
| Pattern | `solver-type-plugin` vs `runtime-plugin` (skill vs MCP) | infer from "skill" vs "tool/server" language |
| Target SolverType | e.g. `prediction.v1`, `swe-rebench-v2.v1` | `swe-rebench-v2.v1` (ignored for runtime) |

**What it does, in order:**

1. **Scaffold** — `jinn create plugin <name> --pattern <p> --solver-type <st> --out-dir <cwd>`.
2. **Fill the placeholder** — replace `skills/example/SKILL.md` body with content
   drafted from the builder's one-liner (do *not* leave the "placeholder" text);
   for a runtime plugin, draft the `.mcp.json` + a server stub instead.
3. **Validate** — `jinn solver-plugins validate <path>`; surface `ok`/errors;
   loop with the builder until green.
4. **Verify it loads** — run the daemon loader against the local path (the §1
   step-4 probe) and confirm `forSolverType(<st>)` resolves the plugin. This is
   the skill's "did it actually load" gate.
5. **Publish (optional, gated on confirmation)** — explain it writes on-chain and
   lazily completes Stage-1; only on explicit yes run
   `jinn solver-plugins publish <path-or-source>`; relay the `pluginCid` + txHash,
   or the `ensure_stage1_failed` funding hint.
6. **Join (operator path, optional)** — offer to add the plugin to a joined
   SolverNet via `jinn solver-nets add-plugin <net> <source>` and remind that a
   daemon restart is required (no hot-reload).
7. **Point at scoring** — tell the builder where the score shows up (`/build`
   panels if the flag is on; `jinn solver-plugins status <cid>`; the
   `/explore?filter[plugin]=…` curve) and, for a learning plugin, at the
   held-out exam ([#824]).

**RL-aware branch:** if the builder says "RL", "policy", "learner", or
"training", the skill states the §4 framing up front — plugin = tool/skill
contribution, policy = harness — so they build the right thing.

This is implementable as a follow-up without further design.

## §6 — Prioritized follow-ups (AC#5)

Each notes the shipped issue it **extends** so no closed work is re-filed.
All six filed 2026-06-04.

| Issue | Pri | Shape | Follow-up | Extends |
|-------|-----|-------|-----------|---------|
| [#1048] | P1 | feat | Ship `.claude/skills/create-plugin/` per §5 — the agent on-ramp. Highest leverage for cold-start builders. | [#201] (scaffold CLI) |
| [#1049] | P2 | feat | Opinionated scaffold variants: a real worked skill instead of "This is a placeholder", plus (for the learner path) a held-out-probe stub and a pointer to the learner substrate. | [#201] |
| [#1050] | P3 | feat | Add a **by-builder-agentId** group/filter dimension to the explorer so a builder can rank/browse their own plugins. Backing API (`/builders/:address/artifacts`) already ships; only the UI control is missing. | [#656] |
| [#1051] | P3 | docs | `client/docs/build/` page: "is your plugin a policy or a tool?" — map the RL mental model onto harness-is-policy ([#689]) + the held-out exam ([#824]). Closes the §4 framing gap. | [#205] |
| [#1052] | P3 | fix | Publish-UX papercuts: document/support the local-path/`.tgz` publish path so a public `npm publish` isn't implied-mandatory; make `validate`'s global-dir materialization explicit or opt-in. | [#201] |
| [#1053] | P2 | chore | Decide and fix `/build` SPA gating: flip `pluginBuilderUi` on by default, or gate it behind an explicit but discoverable path. Today the docs reference a route that redirects away. **Blocked on [#1048], [#1049], [#1050], [#1051], [#1052].** This is the "open the doors" move — it must land *last*. Turning the surface on before the on-ramp, worked scaffold, framing docs, and builder comparison ship would route builders straight into the empty-room/placeholder experience. | [#205] / #327 |

[#1048]: https://github.com/Jinn-Network/mono/issues/1048
[#1049]: https://github.com/Jinn-Network/mono/issues/1049
[#1050]: https://github.com/Jinn-Network/mono/issues/1050
[#1051]: https://github.com/Jinn-Network/mono/issues/1051
[#1052]: https://github.com/Jinn-Network/mono/issues/1052
[#1053]: https://github.com/Jinn-Network/mono/issues/1053
[#199]: https://github.com/Jinn-Network/mono/issues/199
[#201]: https://github.com/Jinn-Network/mono/issues/201
[#205]: https://github.com/Jinn-Network/mono/issues/205
[#656]: https://github.com/Jinn-Network/mono/issues/656
[#689]: https://github.com/Jinn-Network/mono/issues/689
[#824]: https://github.com/Jinn-Network/mono/issues/824
[#692]: https://github.com/Jinn-Network/mono/issues/692
