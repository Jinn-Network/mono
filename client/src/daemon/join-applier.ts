/**
 * Hot-apply a SolverNet join to the RUNNING daemon (#1037).
 *
 * Five subsystems consume `joinedSolverNets`. Three re-read their config object
 * live (the MechAdapter task-discovery cid array, the engine's
 * JoinedSolverNetsView, and the learner's routing allowlist); two are frozen at
 * construction (the HarnessReadinessRegistry cid→harness map and the
 * SolverNetRegistry). This applier mutates all five on the live instances so a
 * join applied to a running daemon takes effect within one claim poll — no
 * restart.
 *
 * Wired in main.ts via `joinApplierHolder` (eager-register/late-populate,
 * mirroring harnessReadinessRegistryHolder). The join endpoint
 * (POST /v1/operator/join/:cid) calls it after writing config to disk.
 */

import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import type { JoinedSolverNetsView } from '../harnesses/engine/engine.js';
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
  /**
   * The learner harnesses' live routing allowlist — the same array object both
   * `LearnerHarness` instances hold, so a push is visible to `supports()` on the
   * next claim poll.
   *
   * `null` when the operator pinned an explicit `harness.routing.solverTypes`
   * allowlist. That is a deliberate refusal, not an omission: at boot an
   * explicit allowlist wins outright and joined nets are never folded into it,
   * so widening it here would make the live routing disagree with the routing
   * the same config produces after a restart. Silent divergence between those
   * two is the exact failure the readiness map's (c) comment below was written
   * about; one instance of it in this file is enough.
   */
  learnerRouting: { solverTypes: string[] } | null;
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

    // (a2) learner routing allowlist — solver role only, and only when routing
    // is derived from joined nets (see `learnerRouting` on the deps type).
    // Mirrors main.ts's boot derivation exactly, including the `contract` guard:
    // an entry without a contract yields no SolverType, so boot skips it and so
    // does this. Since C6 the learner claims only what it is routed to, which
    // means without this push a hot join lands on every other surface and then
    // finds no harness willing to claim the task.
    if (deps.learnerRouting && entry.roles.includes('solver') && entry.contract) {
      const solverType = `${entry.contract.id}.${entry.contract.version}`;
      if (!deps.learnerRouting.solverTypes.includes(solverType)) {
        deps.learnerRouting.solverTypes.push(solverType);
      }
    }

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
