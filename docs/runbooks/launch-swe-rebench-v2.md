# Runbook — Launching swe-rebench-v2 SolverNet

**Audience:** Jinn-team launcher operator (only). swe-rebench-v2 is a single-launcher SolverNet — operators discover the canonical launched manifest CID via this runbook's broadcast step rather than launching their own copy.

**Spec:** `spec/2026-05-05-solvernet-creation-and-launch.md` (creation + launch experience), `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` (swe-rebench-v2 contract shape).

**Public operator flow:** after launch, operators should use
[`docs/runbooks/swe-rebench-v2-public-testnet.md`](./swe-rebench-v2-public-testnet.md).

**Why this runbook exists:** The launcher SPA wizard supports the swe-rebench-v2 template via the `?template=swe-rebench-v2.v1` URL parameter. There is no UI affordance to discover this template — that is intentional, to avoid community-launched parallel copies that would dilute the task pool. Anyone with launcher credentials can navigate directly to the URL; this doc captures the rest of the steps so the launch is reproducible.

---

## Pre-flight

1. **Daemon up, bootstrap complete.** `~/.jinn-client/earning/earning_state.json` shows `step: 'complete'`. Master Safe is funded with enough ETH to anchor a `setMetadata` tx (≈0.0005 Base Sepolia ETH plus runway for posting tasks at the prices you'll set in Step 4).
2. **SPA bundle current.** From `operator/`: `yarn build` produces `dist/dashboard/`. Re-bundle if `templates.ts` or any Step file changed since the last run.
3. **Daemon launched against testnet.** `network: 'testnet'` in `~/.jinn-client/config.json`, `apiPort: 7332` (or the value you've been running with). Run `node dist/bin/jinn.js run` and wait until the SPA serves at `http://127.0.0.1:7332/dashboard/`.
4. **UI session active.** Open `http://127.0.0.1:7332/dashboard/` and accept the disclaimer / log in so the SPA holds a UI token. The launch endpoint is gated by that token.

## Launch

1. Navigate to `http://127.0.0.1:7332/dashboard/launcher/create?template=swe-rebench-v2.v1`. Step 1 should show the empty define form. If the page renders "Unknown SolverNet template" check the URL — the only valid keys are `prediction.v1` and `swe-rebench-v2.v1`.
2. **Step 1 — Define.** Set `name: SWE-rebench v2 (Jinn)` and a short `description` (the manifest is signed and published; pick wording you're happy publishing).
3. **Step 2 — Review contract.** Confirm the card shows `swe-rebench-v2.v1` as `data-template-id`. Schemas, `swe-rebench-v2.docker-test-suite.v1` evaluation function, and `swe-rebench-v2.multi-winrate.v1` aggregation function should all be present. Click **Next** — the daemon persists `templateContractId: 'swe-rebench-v2'`, `templateContractVersion: 'v1'` to the draft.
4. **Step 3 — Configure generator.** Three numeric inputs:
   - `N_target_successes` — default 3. The number of `score=1` Verdicts that saturate a Task and stop reposting it.
   - `N_max_postings_per_task` — default 10. Hard ceiling per Task, prevents unbounded spend on impossible instances.
   - `cooldown_ms` — default 86 400 000 (24 h). Minimum gap before reposting the same Task. Drop to a small value (e.g. 60 000 = 60 s) for a smoke test, then update via `PATCH /v1/solvernets/launched/:id/generator-config` once you've confirmed the loop works.
   Click **Next**.
5. **Step 4 — Configure pricing.** The `Per-Task cost` hint shows `solution + verdict × maxClaimsPerOperator (5)` — that's the swe-rebench-v2 default `maxClaimsPerOperator: 5`. Enter solution and verdict prices (wei). The runway projection updates from the master Safe's balance. Click **Next**.
6. **Step 5 — Review & launch.** Confirm the manifest summary header reads `swe-rebench-v2.v1`. Generator summary should show `Target successes`, `Max postings / Task`, `Cooldown` (no Polymarket-specific fields). Open roles default to `solver` + `evaluator`. Click **Launch**. Watch the phase strip walk through `pinning → recording → broadcasting → confirming → spawning`. On success the SPA navigates to `/launcher/launched/<solverNetId>`.

## Verify on-chain

7. **`setMetadata` tx.** Open the BaseScan link at the tx hash shown in `LauncherLaunched` (or read it from `~/.jinn-client/solvernets/launched/<solverNetId>.json` → `registry.metadataTxHash`). Confirm:
   - The event key is `solvernet-manifest:<cid>` (the `<cid>` matches `manifestCid` in the launched record).
   - The `msg.sender` is the launcher's agent EOA (matches `manifest.launcher.agentEoa`).
8. **Subgraph indexed.** Wait one indexer cycle, then query the Jinn subgraph for `Registered` events with `key LIKE 'solvernet-manifest:%'`. The new event should appear with the correct agentId.

## Verify generator + smoke-test the loop

9. **Generator spawned.** Daemon logs include a line like `[swe-rebench-v2-gen] generator spawned for <solverNetId>`. Restart the daemon (`Ctrl-C`, then `node dist/bin/jinn.js run` again) and confirm the generator is re-spawned from the persisted launched record (the legacy `JINN_SWE_REBENCH_V2_LAUNCHER_ENABLED` env-flag path is bypassed once the launched record exists — the launched record is authoritative).
10. **One Task posts.** With a small `cooldown_ms` and `N_max_postings_per_task` you can trigger a posting within seconds. Watch for `[swe-rebench-v2-gen] posting <instance_id>` in the logs and the corresponding `JinnRouter.submitRestorationJob` tx on BaseScan.

## Broadcast for operators

11. **Share the `manifestCid`.** This is the canonical address of the SolverNet.
    Operators should join from `/operator` once the manifest appears in
    Discover. The app writes the manifest-keyed participation entry, defaults
    solver joins to Claude Code, default-includes the SWE-rebench v2 runtime
    plugin, and derives evaluator harness selection from the SolverNet
    contract.

    Manual fallback, only when the app cannot write config:
    ```json
    "joinedSolverNets": {
      "<manifestCid>": {
        "manifestCid": "<manifestCid>",
        "name": "SWE-rebench v2 (Jinn)",
        "contract": { "id": "swe-rebench-v2", "version": "v1" },
        "roles": ["solver"],
        "harness": "claude-code-learner",
        "model": "claude-haiku-4-5-20251001"
      }
    }
    ```
    The daemon auto-loads default runtime plugins unless listed in
    `disabledDefaultPlugins`. Operators must restart their daemon for the entry
    to take effect (the daemon does not hot-reload `joinedSolverNets`).

## Operator setup — evaluator role

12. The evaluator harness (`SweRebenchV2EvaluatorHarness`) ships in `@jinn-network/client` and is registered in `buildHarnesses()`. The daemon derives evaluator dispatch from the SolverNet contract; operators do not choose a solver harness for evaluator-only participation. Operators who want to join `roles: ['evaluator']` for swe-rebench-v2 must still prepare local evaluator dependencies:

    ```bash
    jinn harnesses enable swe-rebench-v2-evaluator
    ```

    The enable flow validates that Docker is reachable (`docker info`) and `python3` is on PATH, then clones `https://github.com/SWE-rebench/SWE-rebench-V2.git` into `<engine.implStateDirRoot>/swe-rebench-v2-evaluator/upstream/`. The marker file at `<engine.implStateDirRoot>/swe-rebench-v2-evaluator/state.json` records `{ enabled: true, upstreamRepoDir }`.

    Re-running the command is idempotent. If Docker isn't running or Python is missing, the harness returns `status: 'waiting_for_external_action'` with installation pointers and no disk side effects until both prerequisites are present.

    Per-Task evaluation cost is metered as monotonic `grade()` elapsed time × `JINN_EVAL_COMPUTE_USD_PER_HOUR` (unset → 0.20 USD/hr default; invalid or zero rates and non-finite computed costs → records `0` with a warning, never blocks the eval) and written to the verdict's `evaluator_cost_usd` (#1828).

## Lifecycle controls

- **Pause** generator: `PATCH /v1/solvernets/launched/:id/lifecycle` with `{"target": "paused"}`. Existing Tasks drain naturally; no new Tasks post.
- **Resume**: same endpoint with `{"target": "launched"}`.
- **Retire** (terminal): `{"target": "retired"}`. There is no un-retire — relaunching means a new SolverNet with a new id. Keep in mind that retiring this SolverNet means the Jinn-team operational launch is gone; do not retire without team consensus.
- **Update generator config** on the fly: `PATCH /v1/solvernets/launched/:id/generator-config` with the new shape (e.g. `{ "cooldown_ms": 86400000 }` to bring the cooldown back up after a smoke test).
