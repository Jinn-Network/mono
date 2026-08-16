/**
 * Read-only verdict-tally port consumed by the status/build outcome enrichment
 * (one-swap R2, umbrella #2461, DR-2026-08-05).
 *
 * `api/gather-status.ts` enriches each COMPLETE solve run's task-relative
 * `outcome` (spec/2026-05-22-run-outcome.md) from per-task verdict tallies. In
 * legacy mode those tallies come from the network indexer via
 * `DiscoveryAPI.getVerdictTallies`; in native mode (`compositionMode: "native"`)
 * the legacy discovery tree never runs, so the native projector's canonical
 * observation store is the source instead. This neutral port is what native mode
 * reads through — `Store.verdictTallyReadModel()` hands one to the composition
 * seam, keeping `api/` free of any `store/`-internal or `daemon/` import (#1584),
 * and keeping the outcome logic anchored on a type that survives the eventual
 * `discovery/` deletion (D-wave).
 *
 * The row shape is structurally identical to `discovery`'s `VerdictTallyResult`
 * and `api/run-outcome`'s `VerdictTally` (`{ pass, fail }`), so a native tally
 * Map feeds `applyOutcomes` / `deriveSolveOutcome` unchanged. `pass` / `fail`
 * count only decision-grade PASS / FAIL verdicts; INVALID / INDETERMINATE /
 * non-verdict terminals are excluded from both poles (see the native read
 * model for the observation → pole mapping).
 */
export interface VerdictTally {
  pass: number;
  fail: number;
}

export interface VerdictTallyReadModel {
  /**
   * Resolved verdict tallies for a set of tasks, keyed by decimal taskId.
   * DISPLAY/advisory signal — a task with no resolved verdicts is simply
   * absent from the Map (callers map absence to `'awaiting'`, never a wrong
   * `'fail'`). Empty `taskIds` → empty Map.
   */
  getVerdictTallies(args: { taskIds: string[] }): Map<string, VerdictTally>;
}
