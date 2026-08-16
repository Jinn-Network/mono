/**
 * Native-backed {@link VerdictTallyReadModel} (one-swap R2, umbrella #2461,
 * DR-2026-08-05).
 *
 * `api/gather-status.ts` enriches each COMPLETE solve run's task-relative
 * `outcome` from per-task verdict tallies. In legacy mode those tallies come
 * from the network indexer through `DiscoveryAPI.getVerdictTallies`. In native
 * mode (`compositionMode: "native"`) the legacy `discovery/` tree never runs, so
 * this read model repoints the SAME outcome enrichment at the native projector's
 * canonical observation store — the surface the native projector writes from the
 * marketplace event stream (`native_canonical_observations`, M3/M6; verdict
 * announcements closed by M4b).
 *
 * SOURCE: the projector emits one `attempt-terminal.v1` observation per
 * `VerdictDeliveryClaimed` it accepts, carrying the SOLVER attempt's verdict
 * outcome in `data.state` (see `@jinn-network/marketplace-projector` `observe.ts`
 * `verdictTerminal()`):
 *   - `state: "delivered"`                       → verdictCode Pass  → `pass`
 *   - `state: "rejected", detail: "verdict-fail"` → verdictCode Fail  → `fail`
 * Those two shapes are emitted ONLY by the verdict path; every other
 * `attempt-terminal.v1` (expiry / cancel / content-corruption / invalid-
 * reference / protocol-violation / result-unavailable) uses a different
 * `state`/`category`, so they never leak into either pole. This matches the
 * legacy `VerdictTallyResult` contract: PASS and FAIL only; INVALID /
 * INDETERMINATE / UNKNOWN excluded from both poles.
 *
 * JOIN: a verdict observation carries a content-addressed `taskdigest`
 * (`sha256:…`), not the decimal on-chain taskId (its `subject` attempt URI is an
 * opaque UUID). The decimal taskId the status plane keys on comes from the
 * operator's OWN solve engagements (`native_engagements.task_digest →
 * .task_id`), so this read model joins observation `taskdigest` back to taskId
 * through `native_engagements` — which naturally scopes the tally to the
 * operator's own posted/solved tasks (native carries no network-wide verdict
 * index; that is the honest cross-operator boundary, mirroring the legacy
 * on-chain floor's empty Map).
 *
 * This lives under `store/` (not `api/`): `Store` is the neutral seam and the
 * #1584 boundary forbids `api/` from reaching store internals or `daemon/`.
 * `api/` only ever sees the port returned by `Store.verdictTallyReadModel()`.
 * The read model reads raw SQLite + `JSON.parse` only — no `daemon/` import —
 * so it does not depend on anything the retirement wave deletes.
 *
 * Tolerant: a missing `native_canonical_observations` / `native_engagements`
 * table (fresh boot, evaluator-only / requester-only deployment) yields an empty
 * Map — every requested task degrades to `'awaiting'`, never a wrong `'fail'`.
 */
import type { Database as DatabaseType } from 'better-sqlite3';
import type { VerdictTally, VerdictTallyReadModel } from '../types/verdict-tally-read-model.js';

/** The projector observation type carrying a solver attempt's terminal outcome. */
const ATTEMPT_TERMINAL_TYPE = 'network.jinn.task-execution.attempt-terminal.v1';

interface RawObservationRow {
  observation_json: string;
}

interface RawEngagementDigestRow {
  task_id: string;
  task_digest: string;
}

/**
 * Classify a decoded `attempt-terminal.v1` observation's `data` into a verdict
 * pole, or `undefined` when it is not a decision-grade verdict terminal (or is
 * an excluded INVALID / INDETERMINATE / non-verdict terminal). Deliberately
 * narrow: only the two shapes `verdictTerminal()` emits for Pass / Fail count.
 */
function verdictPole(data: unknown): 'pass' | 'fail' | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as { state?: unknown; detail?: unknown };
  if (d.state === 'delivered') return 'pass';
  if (d.state === 'rejected' && d.detail === 'verdict-fail') return 'fail';
  return undefined;
}

export class NativeVerdictTallyReadModel implements VerdictTallyReadModel {
  constructor(private readonly db: DatabaseType) {}

  private tableExists(name: string): boolean {
    return (
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) !== undefined
    );
  }

  getVerdictTallies(args: { taskIds: string[] }): Map<string, VerdictTally> {
    const out = new Map<string, VerdictTally>();
    if (args.taskIds.length === 0) return out;
    if (!this.tableExists('native_canonical_observations') || !this.tableExists('native_engagements')) {
      return out;
    }

    // digest → the requested taskIds carrying it. A content-addressed digest is
    // 1:1 with a taskId for an operator's distinct tasks; the Set guards the
    // pathological identical-content-posted-twice case (both taskIds tally the
    // observation) rather than silently dropping one.
    const requested = new Set(args.taskIds);
    const taskIdsByDigest = new Map<string, Set<string>>();
    const engagementRows = this.db
      .prepare(`SELECT task_id, task_digest FROM native_engagements`)
      .all() as RawEngagementDigestRow[];
    for (const row of engagementRows) {
      if (!requested.has(row.task_id)) continue;
      const set = taskIdsByDigest.get(row.task_digest) ?? new Set<string>();
      set.add(row.task_id);
      taskIdsByDigest.set(row.task_digest, set);
    }
    if (taskIdsByDigest.size === 0) return out;

    const observationRows = this.db
      .prepare(`SELECT observation_json FROM native_canonical_observations ORDER BY rowid`)
      .all() as RawObservationRow[];
    for (const { observation_json } of observationRows) {
      let observation: { type?: unknown; taskdigest?: unknown; data?: unknown };
      try {
        observation = JSON.parse(observation_json);
      } catch {
        continue;
      }
      if (observation.type !== ATTEMPT_TERMINAL_TYPE) continue;
      const digest = observation.taskdigest;
      if (typeof digest !== 'string') continue;
      const taskIds = taskIdsByDigest.get(digest);
      if (taskIds === undefined) continue;
      const pole = verdictPole(observation.data);
      if (pole === undefined) continue;
      for (const taskId of taskIds) {
        const tally = out.get(taskId) ?? { pass: 0, fail: 0 };
        tally[pole] += 1;
        out.set(taskId, tally);
      }
    }
    return out;
  }
}
