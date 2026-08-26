import type Database from 'better-sqlite3';

export interface EvalResultRecord {
  checkpoint_cid: string;
  slate_hash: string;
  slate_version: string;
  instance_id: string;
  /** Pass/fail; ignored (stored NULL) when `unscorable` is true. */
  passed: boolean | null;
  unscorable: boolean;
  code_digest: string;
  run_at_ms: number;
  test_log_excerpt?: string | null;
}

/** A persisted eval result read back from the store (same shape as the record written). */
export type EvalResultRow = EvalResultRecord;

export interface EvalAggregate {
  passed: number;
  scorable: number;
  unscorable: number;
}

interface RawEvalResultRow {
  checkpoint_cid: string;
  slate_hash: string;
  slate_version: string;
  instance_id: string;
  passed: number | null;
  unscorable: number;
  code_digest: string;
  run_at_ms: number;
  test_log_excerpt: string | null;
}

export class EvalResultsStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Upsert one held-out eval result (issue #818). PK is
   * `(checkpoint_cid, slate_version, instance_id)` so a re-run overwrites.
   * `passed` is null for `unscorable` rows.
   */
  recordEvalResult(args: EvalResultRecord): void {
    this.db
      .prepare(
        `INSERT INTO eval_results
           (checkpoint_cid, slate_hash, slate_version, instance_id, passed, unscorable, code_digest, run_at_ms, test_log_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkpoint_cid, slate_version, instance_id) DO UPDATE SET
           slate_hash = excluded.slate_hash,
           passed = excluded.passed,
           unscorable = excluded.unscorable,
           code_digest = excluded.code_digest,
           run_at_ms = excluded.run_at_ms,
           test_log_excerpt = excluded.test_log_excerpt`,
      )
      .run(
        args.checkpoint_cid,
        args.slate_hash,
        args.slate_version,
        args.instance_id,
        args.unscorable ? null : args.passed ? 1 : 0,
        args.unscorable ? 1 : 0,
        args.code_digest,
        args.run_at_ms,
        args.test_log_excerpt ?? null,
      );
  }

  /**
   * Aggregate the eval results for a (checkpoint, slate version):
   * `scorable` = rows with `unscorable = 0`; `passed` = scorable rows with
   * `passed = 1`. Unscorable rows are counted separately and never enter the
   * denominator. A checkpoint with no rows yields all-zero (the orchestrator
   * reads this to detect a not-yet-evaluated parent).
   */
  getEvalAggregate(checkpoint_cid: string, slate_version: string): EvalAggregate {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN unscorable = 0 AND passed = 1 THEN 1 ELSE 0 END), 0) AS passed,
           COALESCE(SUM(CASE WHEN unscorable = 0 THEN 1 ELSE 0 END), 0) AS scorable,
           COALESCE(SUM(CASE WHEN unscorable = 1 THEN 1 ELSE 0 END), 0) AS unscorable
         FROM eval_results
         WHERE checkpoint_cid = ? AND slate_version = ?`,
      )
      .get(checkpoint_cid, slate_version) as { passed: number; scorable: number; unscorable: number };
    return { passed: row.passed, scorable: row.scorable, unscorable: row.unscorable };
  }

  /**
   * Distinct `slate_hash` values recorded for a (checkpoint, slate version).
   * The eval orchestrator reads this to detect slate-content drift under a
   * stable version label — the held-out exam is only an honest before/after
   * when the parent and child were scored on the SAME slate content (defeating
   * confounder #1, task-selection). Empty when the checkpoint has no rows.
   */
  getEvalSlateHashes(checkpoint_cid: string, slate_version: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT slate_hash
         FROM eval_results
         WHERE checkpoint_cid = ? AND slate_version = ?
         ORDER BY slate_hash`,
      )
      .all(checkpoint_cid, slate_version) as { slate_hash: string }[];
    return rows.map((r) => r.slate_hash);
  }

  /** Per-task eval results for a (checkpoint, slate version), ordered by instance_id. */
  getEvalResults(checkpoint_cid: string, slate_version: string): EvalResultRow[] {
    const rows = this.db
      .prepare(
        `SELECT checkpoint_cid, slate_hash, slate_version, instance_id, passed, unscorable, code_digest, run_at_ms, test_log_excerpt
         FROM eval_results
         WHERE checkpoint_cid = ? AND slate_version = ?
         ORDER BY instance_id`,
      )
      .all(checkpoint_cid, slate_version) as RawEvalResultRow[];
    return rows.map((r) => ({
      checkpoint_cid: r.checkpoint_cid,
      slate_hash: r.slate_hash,
      slate_version: r.slate_version,
      instance_id: r.instance_id,
      passed: r.passed === null ? null : r.passed === 1,
      unscorable: r.unscorable === 1,
      code_digest: r.code_digest,
      run_at_ms: r.run_at_ms,
      test_log_excerpt: r.test_log_excerpt,
    }));
  }
}
