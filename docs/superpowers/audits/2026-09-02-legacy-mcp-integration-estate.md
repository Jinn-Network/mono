# Audit: the legacy MCP / host-integration estate

- **Date:** 2026-09-02
- **Issue:** [#2930](https://github.com/Jinn-Network/mono/issues/2930) — `chore(devx): audit and remove legacy MCP/integration bloat`
- **Shape:** `chore` (audit; the decision record for the deletion boundary)
- **Supersedes:** #2414 (document and preserve the MCP front-end), #2417 (expand unverified host stop-hook support)
- **Discharges:** the follow-up filed but not done by
  [`2026-08-04-agent-artifacts-replacement-design.md`](../specs/2026-08-04-agent-artifacts-replacement-design.md)
  §7 — *"an audit of the legacy operator MCP server's tools against the role-gating principle …
  it belongs to whoever owns the legacy client's sunset."*

> **Scope note.** This document is the audit and the removal plan. It deletes nothing.
> Per #2930's constraints, implementation follows only after the boundary below is agreed.
> Everything under `legacy/jinn-cli-agents-reference/` is out of scope (read-only reference
> subtree). SolverPlugin-side MCP (`plugin/runtime`, `packages/layer`, `operator/plugins/*/mcp/*.mjs`,
> the `claude-mcp-*` venue harnesses) is a different surface and is out of scope.

## 1. Headline

The estate is not one thing. It is **four** things with sharply different dispositions, and the
issue's premise — that this is uniformly "bloat" — holds for only one of them.

| # | Surface | Verdict |
|---|---|---|
| A | `hook-installers/{codex,cursor,gemini-cli}.ts` | **Dead code. Remove now.** Zero production callers; unverified against real host schemas. |
| B | `jinn integrations` + its seven host adapters + the `jinn-operator` skill | **Already ruled: sunset whole.** Deletion is a *ratified, unexecuted* build task, not an open question. |
| C | `jinn mcp` + `operator/src/mcp/operator-server.ts` (22 tools) | **Legacy, reachable only via B.** Removable once B lands; owned by the client sunset. |
| D | `operator/src/mcp/server.ts` + `/api/stop-hook` chain | **Live infrastructure. Not bloat. Do not remove.** |

The single most consequential finding: **the deletion boundary for surface B was already decided.**
`2026-08-04-agent-artifacts-replacement-design.md` is *"Ruled — all dispositions decided by the
operator (Ritsu), 2026-08-04"*, and its §8 build task **B3** is exactly "sunset the whole
`jinn integrations` surface". B3 has **not landed** (`operator/src/cli/index.ts:97` still registers
the command; `architecture/transitions/` holds no integrations entry). #2930 should therefore not
re-open that boundary — it should record it, add what the 2026-08-04 spec left out (surfaces A, C,
D), and sequence execution.

## 2. Inventory and callers

### 2.1 Surface A — unwired hook installers

| File | Lines | Production callers | Tests |
|---|---|---|---|
| `operator/src/cli/hook-installers/common.ts` | 48 (24 after Wave 0) | `commands/integrations.ts:10` | indirect |
| `operator/src/cli/hook-installers/claude-code.ts` | 74 | `commands/integrations.ts:11` | `test/scripts/install-hooks.test.ts`, `test/cli/commands/integrations-hook-install.test.ts` |
| `operator/src/cli/hook-installers/codex.ts` | 33 | **none** | `test/scripts/install-hooks.test.ts:3` |
| `operator/src/cli/hook-installers/cursor.ts` | 25 | **none** | `test/scripts/install-hooks.test.ts:5` |
| `operator/src/cli/hook-installers/gemini-cli.ts` | 33 | **none** | `test/scripts/install-hooks.test.ts:4` |

`integrations.ts:12-18` states why the three are unwired: their hook file formats *"are not
independently verified against those tools' real hook schemas (claude-code's WAS wrong before
verification caught it)"*. #2417 proposed to verify and wire them; #2930 supersedes it. With that
reversal, 91 lines of patcher plus their test blocks have no forward path — they encode guesses at
third-party schemas that nothing calls.

### 2.2 Surface B — `jinn integrations`

`operator/src/cli/commands/integrations.ts` (1318 lines), registered at
`operator/src/cli/index.ts:48,97`. Three subverbs: `install`, `remove`, `doctor`
(`:1258-1264`; the `doctor` handler is confusingly named `runList` and there is no `list` subverb).

Seven host targets (`TARGETS`, `:371-716`): `claude-code`, `claude-desktop`, `cursor`, `vscode`,
`gemini-cli`, `antigravity`, `codex`. Each install writes (a) an MCP server entry pointing at
`jinn mcp` (`{"jinn":{"command":"jinn","args":["mcp"]}}`, `:66`/`:91`/`:732`) and (b) a copy of
`operator/skills/jinn-operator/SKILL.md` into a host-specific location or sentinel block
(`<!-- jinn-operator-start -->`, `:196-197`). Only `claude-code` also gets stop-hook wiring
(`:420-428`).

Callers and references:

- **Runtime: one live caller, and it is a published CLI verb.** `jinn update` imports the command
  module (`operator/src/cli/commands/update.ts:18`), binds it as an injected dep
  (`:99`, `:107`), and **executes `integrations install --json`** as its step 3
  (`:449-472`), gated only by `--skip-plugins`. `update.ts:64-94` even carries a bespoke
  `parseIntegrationsOutput` that tolerates pre-stop-hook installer output shapes. This is the
  estate's only non-documentation runtime edge, and it is easy to miss: the import is
  same-directory relative, so a repo-wide grep for `commands/integrations` does not find it.
  Nothing else invokes it — no CI workflow, no
  `quickstart`/`init`/`doctor`/`wiring`/`onboarding-complete` path, no operator-console code. The
  remaining references are two human/agent-facing *prompts*:
  `operator/src/mcp/operator-server.ts:649` (the `jinn_update` tool description) and
  `operator/src/cli/commands/update.ts:370` (post-update guidance text).
- **Tests:** `test/cli/commands/update.test.ts:41,117-180` covers the `jinn update` step-3 path;
  `test/cli/commands/integrations-hook-install.test.ts` imports the command module directly; and
  `test/scripts/install-hooks.test.ts` covers the claude-code patcher. **No test covers
  `runInstall`, `runRemove`, or `runList` end-to-end, and none covers any of the six
  non-`claude-code` targets.**
- **Published docs:** `operator/README.md:140,144,146,278`, `operator/ARCHITECTURE.md:30,46,91,278`,
  `docs/operator-testnet.md:74`.
- **Published skill:** `operator/skills/jinn-operator/SKILL.md:88,102,147` instruct agents to run
  `jinn integrations install`; `:42,76` recommend `jinn mcp`. `/skills/` is in
  `operator/package.json:31` `files`, so this ships in the npm tarball.

### 2.3 Surface C — `jinn mcp` and the operator MCP server

`operator/src/cli/commands/mcp.ts` is 22 lines: `createOperatorServer()` over
`StdioServerTransport`. Registered at `operator/src/cli/index.ts:38,85`.

`operator/src/mcp/operator-server.ts` (848 lines) registers **22** tools — `jinn_auth`,
`jinn_doctor`, `jinn_fund_requirements`, `jinn_status`, `jinn_fleet`, `jinn_balance`,
`jinn_history`, `jinn_logs`, `jinn_rewards`, `jinn_solver_nets_list`, `jinn_solver_nets_show`,
`jinn_init`, `jinn_run`, `jinn_bootstrap`, `jinn_tasks_submit`, `jinn_claim_rewards`,
`jinn_update`, `jinn_start_daemon`, `jinn_stop_daemon`, `activity_list`, `bootstrap_state`,
`daemon_restart`. (The 2026-08-04 spec says "21"; the registry is 22. Drift, not a discrepancy that
changes any disposition.)

**Every tool has a non-MCP equivalent.** The first seventeen are literal wrappers around the same
imported `CommandModule` objects the CLI dispatches, so `jinn <verb>` is byte-for-byte the same code
path. `activity_list` / `bootstrap_state` / `daemon_restart` are wrappers over daemon HTTP routes
reached with the stored UI token (`operator/src/api/server.ts`), and `daemon_restart` additionally
duplicates `jinn restart`. There is **no capability behind `jinn mcp` that the CLI or daemon HTTP
API does not already supply** — this is the load-bearing fact for surface C's removability, and it
is why C is bloat rather than infrastructure.

Non-`jinn mcp` importers of `createOperatorServer`: `operator/scripts/skill-generate.ts:37` and
`operator/scripts/skill-check.ts:25`. Both introspect the registered tool list to generate and
CI-verify the MCP table inside `operator/skills/jinn-operator/SKILL.md`. **This is the removal's
one non-obvious coupling:** deleting `operator-server.ts` breaks `yarn skill:check` until the
generator's MCP table is dropped. Likewise `test/cli/index.test.ts:78` asserts top-level help
contains `jinn mcp`, and `CLI_COMMANDS` (`operator/src/cli/index.ts`) feeds both scripts.

### 2.4 Surface D — live infrastructure that must survive

**`operator/src/mcp/server.ts` (532 lines) is spawned on two independent live paths** and is not
part of the legacy front-end at all:

1. `operator/src/runner/claude.ts:14-28` resolves `<srcRoot>/mcp/server.js` (or the `tsx` source
   form), writes it into a temp `mcp-config.json` under `mcpServers['jinn-client']` (`:54-88`), and
   passes it to `claude --mcp-config`. `ClaudeRunner` is constructed at `operator/src/main.ts:1314`,
   re-exported from `operator/src/index.ts:13`, and wrapped by the `legacy-claude` and
   `jinn-repo-evaluator` harnesses.
2. `operator/plugins/network-tools/mcp/jinn-client-server.mjs:26-33` probes
   `<root>/dist/mcp/server.js` then `<root>/src/mcp/server.ts`. `network-tools` is mounted as
   `bundled:network-tools` (`operator/src/solver-nets/registry.ts:15,341,407`) and consumed by the
   learner adapter (`harnesses/impls/learner/adapters/codex-workspace.ts:176-269`) and the Hermes
   config builder (`harnesses/impls/hermes-agent/config-builder.ts:101-149`).

Two tests additionally read `src/mcp/server.ts` **as source text**
(`test/mcp/search-records-corpus.test.ts:440,451`) or by path
(`test/architecture/core-corpus-http-ownership.test.ts:11`), so the file is load-bearing for
architecture control as well as runtime.

Its helper modules: `search-records.ts` has a **non-MCP consumer** —
`operator/src/harnesses/engine/corpus-knowledge.ts:28` calls `handleSearchRecords` directly, so it
survives any MCP removal on its own merits. `acquire-artifact.ts` and `get-codedigest-reward.ts`
are called only from `server.ts`, which is itself live.

**The stop-hook chain is live and externally installed.** `DEFAULT_STOP_HOOK_COMMAND`
(`hook-installers/common.ts:1`) names `jinn-stop-hook`, a **published bin**
(`operator/package.json:21` → `dist/bin/jinn-stop-hook.js`). It normalizes stdin
(`operator/src/api/stop-hook.ts`), resolves the daemon bearer, and POSTs `/api/stop-hook`, which
feeds transcript capture ingest (`operator/src/captures/ingest.ts`). The route is explicitly
retained by architecture control (`test/architecture/leftover-application-routes-retired.test.ts:51`
— *"keeps stop-hook and artifact insert/acquire"*), and packaging is asserted in
`test/scripts/pack-workflows.test.ts:221-230`. Stop-hook wiring is **not** bloat; only the three
unverified patchers of §2.1 are.

Per #2930's constraint, the bearer-gated artifact and daemon APIs were checked for independent
callers rather than assumed removable with MCP. They have them: `POST /v1/artifacts/acquire`
(`api/server.ts:721`), `GET /artifacts/:id/content` (`:662`), `POST /artifacts` (`:673`),
`GET /artifacts/search` (`:648`), `/v1/status` (`:426`) are the daemon's own serving plane and are
covered by serving-plane conformance tests. **None of them may be removed as part of this program.**

## 3. Externally meaningful compatibility vs internal dead code

Kept separate, as #2930 requires.

**Externally meaningful (a user or a user's machine is holding it):**

- `jinn-stop-hook` — a published bin, and every operator who ever ran `jinn integrations install`
  has `jinn-stop-hook --tool claude-code` written into their own `~/.claude` settings. Deleting the
  bin, or deleting the only uninstaller (`jinn integrations remove`) without a replacement cleanup
  path, leaves a dangling hook on user machines. This is the program's **one real migration
  obligation**.
- `operator/skills/jinn-operator/SKILL.md` — ships in the tarball and tells agents to run
  `jinn integrations install`.
- `operator/README.md` — ships in the tarball and documents `jinn integrations install|doctor` and
  `jinn mcp`.
- Any host config a user already has, pointing at `jinn mcp`.
- **`jinn update` re-installs host integrations on every run** (§2.2). This is a live behavior, not
  merely stranded state: until Wave 1 lands, every `jinn update` without `--skip-plugins` rewrites
  the user's host MCP entries, skill copies and claude-code stop-hook line. Wave 1 therefore
  changes what a published verb does, and must say so in its CHANGELOG entry.

Counter-weight, recorded rather than argued: the 2026-08-04 spec §7 already ruled compatibility
**"None"** for surface B — install, remove and doctor are sunset together, and the cleanup step
lives *inside the published host skills* rather than in a surviving subcommand.

**Internal dead code (nothing outside the repo can be holding it):**

- `hook-installers/{codex,cursor,gemini-cli}.ts` — 91 lines, test-only.
- The optional `hookFilePath` / `isHookConfigured` / `installHook` / `removeHook` members of
  `PluginTarget` (`integrations.ts:353-361`), implemented for 1 of 7 targets.
- `runInstall`'s `forceDryRun` parameter (`integrations.ts:850`) — never passed by any caller.
- `runList` named for a `list` subverb that does not exist.

## 4. Ordered removal plan

Each wave is independently reviewable and independently revertible. Waves are ordered so that no
wave removes the last caller of something a later wave still needs.

### Wave 0 — unwired hook patchers *(no dependencies; ready now)*

Delete `operator/src/cli/hook-installers/{codex,cursor,gemini-cli}.ts` and their blocks in
`operator/test/scripts/install-hooks.test.ts`. Retain `claude-code.ts` and `common.ts`, but drop
`common.ts`'s `appendUniqueString`, `removeString`, `appendUniqueCommandObject` and
`removeCommandObject` — those four helpers existed solely for the deleted patchers
(`claude-code.ts` imports only `DEFAULT_STOP_HOOK_COMMAND`, `parseJsonObject`, `stableJson`), so
leaving them behind would leave exactly the unwired bloat this wave removes.

*Validation:* `yarn typecheck` + `yarn test` in `operator/`; confirm
`test/cli/commands/integrations-hook-install.test.ts` still passes (it exercises the claude-code
path only). *Migration/communication:* none — zero callers, nothing published references them.
*Risk:* none identified.

### Wave 1 — execute B3: sunset `jinn integrations` whole *(gated)*

Per the ratified spec §8 B3: delete the command and its seven adapters, deregister it from
`operator/src/cli/index.ts`, update `operator/README.md`, `operator/ARCHITECTURE.md` and
`docs/operator-testnet.md`, and land the transition-manifest entry plus its guard test under
`architecture/transitions/`.

**Wider than the spec's B3 line implies**, because of §2.2's live caller. Deleting the command
alone will not compile: `jinn update` imports and runs it. Wave 1 must also remove, in the same
change, `update.ts`'s step-3 block (`:449-472`), the `integrationsRun` member of `UpdateDeps`
(`:99`) and its production binding (`:107`), `parseIntegrationsOutput`/`summarizeIntegrationInstall`
(`:64-94`), the now-meaningless `--skip-plugins` flag and its help text, the
`integrations-install` step in the emitted step list, and the corresponding cases in
`test/cli/commands/update.test.ts:117-180`. It must also remove the two prompt strings
(`operator/src/mcp/operator-server.ts:649`, `operator/src/cli/commands/update.ts:370`).
Removing the command while leaving `jinn update` compiling but stepless would silently drop the
skill-refresh with no replacement — the replacement is the skill-embedded cleanup step below, and
it must exist first.

*Blocking prerequisite (spec's own):* B2 — the replacement path (published host skills at
`spec.jinn.network` carrying the cleanup step) must exist first. **It does not yet: no integrations
entry exists in `architecture/transitions/`.** Wave 1 must not run ahead of it, because B3 deletes
`jinn integrations remove`, and the skill-embedded cleanup step is then the *only* way a user can
remove an installed MCP entry, sentinel block, or stop-hook line. Shipping the deletion without the
cleanup step converts the compatibility obligation above into stranded state on user machines.

*Validation:* full `operator/` suite; the transition-manifest guard; a manual check that no
published document instructs any `jinn integrations` subverb (the spec's own zero-definition,
`:551`). *Communication:* CHANGELOG entry plus the skill-embedded cleanup step.

### Wave 2 — `jinn mcp` and the operator MCP server *(gated on Wave 1)*

After Wave 1, nothing in the repo installs `jinn mcp` into any host, and every one of its 22 tools
is a wrapper over a CLI verb or daemon route that remains (§2.3). Remove
`operator/src/cli/commands/mcp.ts`, `operator/src/mcp/operator-server.ts`,
`operator/test/mcp/operator-server.test.ts`, and `operator/skills/jinn-operator/`; drop the MCP
table from `operator/scripts/skill-generate.ts` and `skill-check.ts` (or retire both with the skill);
drop `/skills/` from `operator/package.json` `files`; update
`operator/test/cli/index.test.ts:78`; and drop `@modelcontextprotocol/sdk` from `operator` **only
after** confirming `src/mcp/server.ts` no longer needs it — it does, so the dependency stays.

*Ownership:* the 2026-08-04 spec places this with the client/operator-daemon cutover, not with the
agent-artifacts program. **Recommendation: keep it there.** Wave 2 is sequenced here so the cutover
inherits a plan, not so #2930 executes it.

*Validation:* `yarn skill:check` must be removed or made green in the same change; full suite;
`yarn build`. *Communication:* a deprecation window on `jinn mcp` is warranted (unlike surface B,
users may hold hand-written host configs that the skill cleanup step will not touch).

### Never — surface D

`operator/src/mcp/server.ts`, `search-records.ts`, `acquire-artifact.ts`,
`get-codedigest-reward.ts`, `jinn-stop-hook`, `POST /api/stop-hook`, `captures/ingest.ts`, and the
bearer-gated artifact/daemon routes are **out of the removal boundary entirely**. They are named
here so a later reader does not re-derive the question.

## 5. Findings that are not removals

- **Tool-registry drift.** The 2026-08-04 spec says 21 tools; `operator-server.ts` registers 22.
- **Skill drift.** `docs/reviews/2026-04-28-operator-experience-audit.md:111` recorded the
  `jinn-operator` skill documenting tools the server does not expose. If Wave 2 slips, the skill
  keeps drifting — `skill:check` only pins the generated tables, not the prose around them.
- **Untested surface.** Six of the seven host adapters have no test at all. That is an argument for
  deletion, not for backfilling coverage on a surface already ruled sunset.
- **Role-gating (the §7 follow-up's actual question).** `jinn_run`, `jinn_bootstrap`, `jinn_init`,
  `jinn_claim_rewards`, `jinn_update`, `jinn_start_daemon`, `jinn_stop_daemon` and `daemon_restart`
  are state-changing and, in the case of `jinn_claim_rewards`, fund-moving — exposed to any host
  that reads the stdio server, with no role gate beyond the confirm flags a few of them carry. This
  is resolved by removal (Wave 2), which is why no separate gating design is proposed.

## 6. Recommendation

1. Execute **Wave 0** under #2930 — it is the only part of the estate that is both unambiguously
   dead and unblocked.
2. Adopt §4 as the recorded deletion boundary; file **Wave 1** against the existing 2026-08-04 B3
   build task rather than as new scope, and **Wave 2** against the operator-daemon cutover.
3. Close #2414 and #2417 as superseded — both proposed work (documenting, then expanding) on
   surfaces this audit places inside the deletion boundary.
