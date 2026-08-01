/**
 * Hot-apply a SolverNet join to the RUNNING daemon (#1037).
 *
 * Four subsystems consume `joinedSolverNets`. Two re-read their config object
 * live (the MechAdapter task-discovery cid array and the engine's
 * JoinedSolverNetsView); two are frozen at construction (the
 * HarnessReadinessRegistry cid→harness map and the SolverNetRegistry). This
 * applier mutates all four on the live instances so a join applied to a
 * running daemon takes effect within one claim poll — no restart.
 *
 * Wired in main.ts via `joinApplierHolder` (eager-register/late-populate,
 * mirroring harnessReadinessRegistryHolder). The join endpoint
 * (POST /v1/operator/join/:cid) calls it after writing config to disk.
 */

import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import type { JoinedSolverNetsView } from '../harnesses/engine/joined-solver-nets-view.js';
import {
  SolverNetRegistry,
  registerJoinedNet,
  type JoinedSolverNetConfig,
} from '../solver-nets/registry.js';

export interface JoinApplierDeps {
  /** The MechAdapter's live taskDiscovery object (cid array is pushed onto). */
  taskDiscovery: { solverNetManifestCids: string[] };
  /** The engine's mutable joined view. */
  view: JoinedSolverNetsView;
  /** The live readiness registry. */
  readiness: HarnessReadinessRegistry;
  /** The live SolverNet registry. */
  registry: SolverNetRegistry;
  /** The in-memory operator config block (kept consistent for launcher reads). */
  config: { joinedSolverNets?: Record<string, JoinedSolverNetConfig> };
  /**
   * #547: flip the MechAdapter's evaluator gate on live when an evaluator-role
   * join lands. A join never removes a role, so there is no "off" counterpart.
   */
  enableEvaluator?: () => void;
}

export type JoinApplier = (entry: JoinedSolverNetConfig) => Promise<void>;

export function createJoinApplier(deps: JoinApplierDeps): JoinApplier {
  return async (entry: JoinedSolverNetConfig): Promise<void> => {
    const cid = entry.manifestCid;

    // (a) task-discovery cid set — solver role only (mirrors main.ts), deduped
    // so a re-apply does not double-push.
    if (entry.roles.includes('solver') && !deps.taskDiscovery.solverNetManifestCids.includes(cid)) {
      deps.taskDiscovery.solverNetManifestCids.push(cid);
    }

    // #547: an evaluator-role join enables the adapter's evaluation scan live.
    if (entry.roles.includes('evaluator')) deps.enableEvaluator?.();

    // (b) engine eligibility view.
    deps.view.set(cid, { roles: entry.roles });

    // (c) readiness gate map — mirror boot's buildHarnessReadinessRegistry
    // (main.ts), which adds an entry whenever `entry.harness` is truthy,
    // role-agnostic. The endpoint persists `harness` for evaluator-only joins
    // too, so gating this on the solver role made the live map diverge from the
    // post-restart map and silently blocked evaluator-only claims.
    if (entry.harness) {
      await deps.readiness.setJoined(cid, { harnessName: entry.harness, roles: entry.roles });
    }

    // (d) SolverNet registry — shared boot/live registration (Task 1).
    // Clear any prior registration under this net's name first so a re-join
    // updates in place rather than inserting a phantom `name#2` duplicate
    // (registerJoinedNet → register is non-idempotent by name). Boot rebuilds
    // from scratch and never re-applies, so this only affects the live path.
    deps.registry.unregister(entry.name ?? cid);
    await registerJoinedNet(deps.registry, cid, entry);

    // Keep the in-memory config consistent so launcher read-callbacks and any
    // in-process re-read see the new entry. The on-disk write is owned by the
    // join endpoint.
    if (!deps.config.joinedSolverNets) deps.config.joinedSolverNets = {};
    deps.config.joinedSolverNets[cid] = entry;
  };
}
