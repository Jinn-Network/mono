/**
 * NDJSON progress events for a `distill` run (#1533).
 *
 * A run is a silent multi-minute blocking call (one frontier subprocess per
 * cluster), so any wrapper — the harness plugin's background runner, a script,
 * CI — needs a machine-readable event stream to show progress ambiently. The
 * emitter writes one JSON object per line to the given stream (the CLI passes
 * stderr; stdout stays reserved for the `--json` result), stamping every line
 * with a schema version, timestamp, and run id.
 *
 * Consumers MUST ignore lines that do not parse as JSON or lack the `v` field:
 * the stream is shared with plain-text warnings (e.g. malformed-capture skips).
 *
 * Ordering guarantee: `run_start` → `cluster_plan` → (`cluster_start` →
 * `heartbeat`* → `cluster_end`)* → `run_end`; `run_end` is always last and is
 * emitted on every terminal branch, so a watcher can treat it as the single
 * end-of-run signal.
 */

import { randomBytes } from 'node:crypto';

/** Anything line-writable — `process.stderr` in production, a sink in tests. */
export interface ProgressStream {
  write(chunk: string): unknown;
}

/** Mint a per-invocation run id: `distill-<unixms>-<4hex>`. */
export function newRunId(): string {
  return `distill-${Date.now()}-${randomBytes(2).toString('hex')}`;
}

export interface RunStartFields {
  capturesConsidered: number;
  toDistill: number;
  resume: boolean;
  distillProvider: string;
  distillModel: string;
  capturesDir?: string;
  stagingDir?: string;
  activeDir?: string;
}

export interface ClusterPlanFields {
  clusterCount: number;
  clusters: Array<{ clusterId: string; index: number; captureCount: number; label?: string }>;
}

export interface ClusterStartFields {
  clusterId: string;
  index: number;
  total: number;
  label?: string;
}

export interface ClusterEndFields extends ClusterStartFields {
  outcome: 'published' | 'rejected' | 'error';
  skillName?: string;
  reason?: string;
  error?: string;
  durationMs?: number;
}

export interface RunEndFields {
  outcome: 'ok' | 'partial' | 'empty';
  clusterCount: number;
  published: string[];
  rejectedCount: number;
  errorCount: number;
  installed: string[];
  stagingDir?: string;
}

export interface NdjsonProgressEmitter {
  runStart(fields: RunStartFields): void;
  clusterPlan(fields: ClusterPlanFields): void;
  clusterStart(fields: ClusterStartFields): void;
  clusterEnd(fields: ClusterEndFields): void;
  /** Always the last event; clears any live heartbeat and stamps the run duration. */
  runEnd(fields: RunEndFields): void;
}

export interface ProgressEmitterOpts {
  /** Heartbeat period while a cluster's LLM call is in flight. Default 15s. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export function createNdjsonProgressEmitter(
  stream: ProgressStream,
  runId: string,
  opts: ProgressEmitterOpts = {},
): NdjsonProgressEmitter {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const runStartedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function emit(event: string, fields: Record<string, unknown>): void {
    stream.write(JSON.stringify({ v: 1, event, ts: new Date().toISOString(), runId, ...fields }) + '\n');
  }

  function clearHeartbeat(): void {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  return {
    runStart(fields) {
      emit('run_start', { ...fields });
    },
    clusterPlan(fields) {
      emit('cluster_plan', { ...fields });
    },
    clusterStart(fields) {
      emit('cluster_start', { ...fields });
      clearHeartbeat();
      const clusterStartedAt = Date.now();
      heartbeat = setInterval(() => {
        emit('heartbeat', {
          clusterId: fields.clusterId,
          index: fields.index,
          total: fields.total,
          elapsedMs: Date.now() - clusterStartedAt,
        });
      }, heartbeatMs);
      // Liveness only — never keep the process alive for a heartbeat.
      heartbeat.unref?.();
    },
    clusterEnd(fields) {
      clearHeartbeat();
      emit('cluster_end', { ...fields });
    },
    runEnd(fields) {
      clearHeartbeat();
      emit('run_end', { ...fields, durationMs: Date.now() - runStartedAt });
    },
  };
}
