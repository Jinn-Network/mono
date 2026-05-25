# Retire the legacy short-name-keyed `solverNets` config block

**Date:** 2026-05-25
**Author:** Stage 1 design subagent (issue #421)
**Status:** Design
**Run-mode:** `refactor`
**Related:**
- Issue #421 — refactor: Retire the legacy short-name-keyed solverNets config block (Task 22)
- Spec `spec/2026-05-05-solvernet-creation-and-launch.md` §§11–12 — manifest-CID-keyed `joinedSolverNets`
- DR-2026-04-30 — knowledge-market substrate framing (Phase A umbrella)

## Problem

The operator config carries two parallel SolverNet shapes that never finished collapsing:

- **Legacy `solverNets`** — short-name-keyed (`solverNets.prediction`, `solverNets["swe-rebench-v2"]`). Conflates the SolverNet *definition* (`solverType`, generator enablement, contract id derived from `solverType`) with the operator's *participation choices* (roles / harness / model / plugins). Schema defined in `client/src/config.ts:465-509`. Default value is `{}` (per Decision 5 of the launch spec — fresh installs no longer seed entries).
- **`joinedSolverNets`** — manifest-CID-keyed (`client/src/config.ts:526-547`). Populated by `POST /v1/operator/join/:cid`. Carries only participation choices, pointing at a manifest CID; the SolverNet definition lives in the IPFS manifest and is loaded by `loadSolverNets` via `getSolverNetContract`.

`config.ts:521-525` is explicit: *"Kept structurally separate from legacy `solverNets` for now… Task 22 collapses both branches into a single manifest-keyed shape once the legacy block is fully drained."* The drain is now possible because: (1) `DEFAULT_SOLVER_NETS = {}`; (2) the launched-record subsystem owns generator ownership (no `taskGenerator.enabled` gate is needed in operator config); (3) `loadSolverNets` already builds `LoadedSolverNet` entries from `joinedSolverNets` (`registry.ts:256-278`); (4) the engine's claim-eligibility filter is already manifest-digest keyed (`main.ts:2463-2471`).

The dual shape leaks: the v0.1.6 wave-2 smoke pass surfaced an Overview "SOLVING ON prediction" stale-label after an operator left every joined SolverNet, because `Overview.tsx` falls through to `bootstrap.solverNets` (`Overview.tsx:340-361`) and `derivePredictionSolverNetName` (`gather-status.ts:254-263`) still prefers legacy keys. Beyond the symptom there are 17 readers of `config.solverNets` across `main.ts`, `prediction-operator-ux.ts`, `registry.ts`, `gather-status.ts`, `launcher-status.ts`, `launcher-tasks.ts`, `cli/commands/tasks.ts`, `cli/task-native-readiness.ts`, `scripts/donation-consumption-acceptance.ts`, and `api/server.ts`. Every one of them must handle both shapes today.

## Chosen approach

**Hard-remove `solverNets` from the schema; load-time auto-migrate any legacy on-disk block into `joinedSolverNets` and warn once.** Then delete every legacy reader and route everything through `joinedSolverNets` keyed by `manifestCid`.

The strangler-fig framing in the issue is honoured by the *migration step* (a one-release loader that translates legacy entries forward), not by keeping the dual schema. Pre-mainnet, with `DEFAULT_SOLVER_NETS = {}` and the prediction SolverNet already deprecated, there is no production audience that legitimately needs the legacy shape to keep working as a first-class write target — only as a graceful read of older on-disk configs. Keeping two shapes parallel is what created the wave-2 bug; the longer we keep both, the longer Overview, prediction-operator-ux, the launcher status surface, and the CLI all have to pick a branch.

### Why hard-remove rather than a deprecation flag

A "legacy shape still parses, joined shape takes precedence" flag does not buy us anything — `loadSolverNets` already iterates both blocks (`registry.ts:256-282`). The cost of keeping the schema field is that the SPA, CLI, and status payloads continue to fork on shape. The cost of removing it is bounded: a load-time migration is mechanical (legacy `solverNets[name] = { solverType: 'x.y', roles, harness, ... }` maps cleanly to `joinedSolverNets[<derived-cid-or-synthetic-key>] = { contract: { id: 'x', version: 'y' }, roles: <mapped>, harness, ... }`), and no production deployment depends on the legacy block: the v0.1.6 dogfood pool is the only at-scale audience, and they are reachable via the CHANGELOG.

### Sub-question answers

**1. Deprecation path vs hard-remove?** Hard-remove the schema field; keep a *load-time auto-migration* for one release. The loader walks any `solverNets` block found in `~/.jinn-client/config.json`, projects each entry into the `joinedSolverNets` shape (legacy short-name becomes the manifest-key only when no manifest CID is available — we synthesise a placeholder key `legacy:<short-name>` so the engine's manifest-digest gate continues to filter rather than gate-open), emits one `console.warn` line per legacy entry pointing at the SPA "Join SolverNet" flow, and continues. The schema does *not* re-emit `solverNets` on write. Operators who restart see their previous selection respected; operators who rejoin via the SPA replace the synthetic key with the real manifest CID. Generators are launched-record-driven anyway, so the dropped `taskGenerator.enabled` field is correctly ignored.

**2. How does `prediction-operator-ux.ts` resolve manifest CIDs?** It already has `findPredictionJoined` (`prediction-operator-ux.ts:225-232`) which scans `joinedSolverNets` for `contract.id === 'prediction'`. That becomes the *only* lookup; the `const legacy = config.solverNets[name]` branch (line 265) and the `synthesizeFromJoined` path becomes the default. The function signature loses the `name = 'prediction'` parameter — callers stop passing a short name and instead pass nothing; the SolverNet's display name is read from `joined.name` (cached in config per spec §12). The diagnostic `configField` strings change from `solverNets.${name}.enabled` to `joinedSolverNets.${manifestCid}.roles` etc. `derivePredictionSolverNetName` in `gather-status.ts` collapses to "first prediction-contract joined entry's name (or CID), else absent".

**3. What shape does `/v1/bootstrap` render?** Drop the `solverNets` echo (`main.ts:1077`). Bootstrap returns only `joinedSolverNets` in the spec §12 shape. The SPA's `BootstrapWithSolverNets` interface in `Overview.tsx:21-48` loses its `solverNets?:` member; `ActivityCard`'s `joinedNets` derivation (`Overview.tsx:305-363`) loses the legacy fallback branch (lines 340-361). Any joined entry with a synthetic `legacy:<short-name>` manifest key still renders — the `name` field carries the display string and `manifestCid` reads the synthetic key — so the migrated-but-not-yet-rejoined operator still sees their net on the Overview.

**4. How does Overview signal "no active SolverNet" (the wave-2 bug)?** Once the legacy fallback in `joinedNets` is gone, `joinedNets` is empty exactly when `joinedSolverNets` is empty. `ActivityCard` (which renders the "SOLVING ON …" eyebrow) already takes `joined: ActivityJoinedNet[]` and is the right surface to render an empty-state. The fix is two-fold: (a) remove the legacy fallback; (b) `ActivityCard` renders a "No active SolverNet — join one to start solving" empty-state when `joined.length === 0`. The bug closes naturally — there is no second branch that can fall through.

**5. Single PR vs stacked?** **Stacked, three PRs**, but each one ships independently and is testable end-to-end:

1. **PR-A (foundation):** Add the load-time auto-migration (`solverNets` → `joinedSolverNets`) in `config.ts`, leaving the legacy schema field intact for now; remove the SPA's legacy-shape fallback in `Overview.tsx`'s `joinedNets` (the bug-fix half — operators who joined via the SPA see the correct empty-state immediately) and add the `ActivityCard` empty-state copy. Migration is exercised by config-loader tests; integration test covers the empty-`joinedSolverNets` Overview shape. **This PR alone closes the wave-2 symptom.**
2. **PR-B (drain readers):** Migrate every `config.solverNets` reader to `config.joinedSolverNets`: `prediction-operator-ux.ts` (drop `legacy` branch and `name` parameter); `gather-status.ts` (`derivePredictionSolverNetName` → joined-only); `launcher-status.ts` (iterate joined); `main.ts` (lines 1276, 1283, 1290, 1295 — launcher route now reads joined); `cli/commands/tasks.ts` (`--solver-net` looks up by `joined.name` or manifestCid); `cli/task-native-readiness.ts`; `scripts/donation-consumption-acceptance.ts`. Bootstrap payload (`main.ts:1077`) stops echoing `config.solverNets`. Integration tests cover each migrated surface against a `joinedSolverNets`-only config.
3. **PR-C (schema removal):** Remove the `solverNets` field from `JinnConfigSchema` and `DefaultSolverNetConfig`. The load-time migration keeps doing its work — it now writes directly into `joinedSolverNets` without ever materialising a legacy field on the validated config. Delete `DEFAULT_SOLVER_NETS`. Update `loadSolverNets` to stop iterating `config.solverNets` (`registry.ts:280-282`); remove `SolverNetConfig`'s public `enabled`/`taskGenerator` carriers if no internal user remains. Drop the SPA's `BootstrapWithSolverNets.solverNets?:` member.

The handbook's `refactor` shape (`CLAUDE.md` §The shapes of work) calls for stacked PRs with strangler-fig discipline. Three PRs satisfies that without overshooting; PR-A is the bug-fix half (mergeable on its own, closes the wave-2 ticket), PR-B is the migration body (mergeable on its own — schema still tolerates legacy reads), PR-C is the cleanup (mergeable once PR-B is on `next` and a canary cycle has shaken out any reader we missed).

## Migration strategy for existing on-disk configs

`~/.jinn-client/config.json` files in the wild may contain a `solverNets` block (the dogfood pool's primary shape pre-Task 21). The loader auto-migrates without operator intervention:

```ts
// config.ts loader (post-schema-parse, pre-return)
if (rawConfig.solverNets && typeof rawConfig.solverNets === 'object') {
  for (const [name, entry] of Object.entries(rawConfig.solverNets)) {
    const synthetic = `legacy:${name}`;
    const { id, version } = parseSolverTypeRef(entry.solverType) ?? { id: name, version: 'v1' };
    rawConfig.joinedSolverNets ??= {};
    if (!rawConfig.joinedSolverNets[synthetic]) {
      rawConfig.joinedSolverNets[synthetic] = {
        manifestCid: synthetic,
        name,
        contract: { id, version },
        roles: (entry.roles ?? ['solving']).map((r) =>
          r === 'solving' ? 'solver' : 'evaluator'),
        ...(entry.harness ? { harness: entry.harness } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        plugins: entry.plugins ?? [],
        disabledDefaultPlugins: [],
      };
    }
  }
  delete rawConfig.solverNets;
  console.warn(
    '[config] Migrated legacy solverNets entries to joinedSolverNets. ' +
    'Open Operator > SolverNets in the dashboard to re-join via the registry ' +
    '(replaces the synthetic legacy:* keys with real manifest CIDs).');
}
```

Migration is in-memory only; the config file on disk is not rewritten unless the operator triggers a write through an existing settings flow (which already emits the modern shape). Restarting after a re-join naturally replaces the synthetic key. The engine's manifest-digest claim filter (`main.ts:2463-2471`) is unaffected: synthetic keys produce a non-matching digest, so the operator only claims real launched-record tasks — the migrated entry exists for diagnostic surfaces (Overview, prediction-operator-status) until the operator rejoins, which matches today's behavior where legacy entries don't claim anything either.

## Trade-offs

- **Auto-migrate vs require operator action:** Auto-migrate. Forcing operators to manually rejoin on upgrade is a worse experience than a `console.warn`. The synthetic-key approach makes the migration observable (UIs show `legacy:prediction` until the operator rejoins) without breaking the daemon's startup.
- **One-PR vs three-PR stack:** Three. PR-A is independently valuable (closes the wave-2 bug) and de-risks PR-B; PR-C is mechanical cleanup. A single PR would touch ~12 files, mix the bug-fix and the schema removal, and is harder to review than three focused PRs. The handbook's strangler-fig rule was written for this shape of change.
- **Synthetic-key carrier vs drop-on-load:** Carry a `legacy:<short-name>` synthetic key. Dropping legacy entries on load is simpler but silently empties the Overview for any operator with only legacy config — the same UX failure mode as the wave-2 bug, just one layer up.

## Out of scope

- Migrating `solverType` to manifest-CID-only at the on-chain task level (spec §14, Decision 6) — separate task, not gated by this refactor.
- The `solverNetsLauncher` / launcher-creation flow — Task 22 already retired the launcher-mode PATCH route; the remaining launcher reads in `launcher-status.ts` are about the launched-record subsystem, which keys on launched records, not operator config (the legacy `solverNets` reads there are vestigial and removed by PR-B).
- Removing the `solverType` field from internal types (`SolverNetConfig.solverType`, `LoadedSolverNet.solverType`) — spec §14 keeps a derived alias during the migration window; this refactor doesn't introduce new dependencies on it but doesn't remove existing ones either.

## Acceptance criteria mapping

- "Legacy short-name-keyed `solverNets` block is removed from the config schema and all readers" → PR-C removes the schema field; PR-B drains the readers.
- "Prediction operator-UX, `/v1/bootstrap` payload, and Overview SOLVING ON detection are driven solely by `joinedSolverNets`" → PR-B (operator-UX, bootstrap) + PR-A (Overview).
- "Existing `~/.jinn-client/config.json` files containing a `solverNets` block still load without an operator-facing break" → load-time migration in PR-A, schema-permissive (legacy field accepted as raw input even though it's gone from the validated shape) through PR-C.
- "Leaving all SolverNets shows the no-active-SolverNet state on Overview" → PR-A (legacy fallback removed; `ActivityCard` empty-state added).
