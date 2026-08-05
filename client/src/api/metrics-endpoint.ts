/**
 * `GET /metrics` — Prometheus text exposition (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.2; closes #2420's M1 hand-off: `jinn_loop_admitted{loop}` was noted there as "issue
 * #2404 (WP7)'s scope, not this module's" — `daemon/degraded-recovery.ts`'s docstring).
 *
 * Hand-rolled writer, no new dependency: the exposition format
 * (https://prometheus.io/docs/instrumenting/exposition_formats/) is a handful of lines per
 * series, and a client library for four small series would be a bigger dependency than the
 * text it emits. `jinn_` prefix throughout; gauges/counters only, and every value is read
 * straight off already-computed state — the injected loop snapshot + readiness (see below),
 * and two cheap SQLite reads (`activity_events`, `balance_cache`) — never a fresh RPC call,
 * so a scrape never blocks on chain I/O and `/metrics` is never itself a source of truth. No
 * addresses or filesystem paths in any label value: balance rows key on the existing role
 * string (`service.<index>.agent` / `.multisig`, see `gather-status.ts`), never the address.
 *
 * `getDaemonReadiness` / `getLoopSnapshot` are injected rather than imported from
 * `daemon/loop-heartbeat.js` directly: `client/src/api/` must never import
 * `client/src/daemon/` (architecture boundary, #1584 —
 * `test/architecture/api-daemon-boundary.test.ts`). The production caller (main.ts /
 * daemon.ts's self-start branch) computes the snapshot from `LOOP_REGISTRY` ×
 * `getLoopAdmission` × `getLoopTick`, all owned by that module. Absent (bare/test servers),
 * both metric families are simply omitted — never fabricated.
 */
import type { Hono } from 'hono';
import type { Store } from '../store/store.js';

/** Mirrors `daemon/loop-heartbeat.ts`'s `DaemonReadiness` union — restated, not imported (#1584). */
export type MetricsDaemonReadiness = 'bootstrapping' | 'ready' | 'degraded';

/** One `LOOP_REGISTRY` entry's already-resolved metrics view (spec §5). */
export interface MetricsLoopEntry {
  name: string;
  /** Unix time (seconds) of the loop's last heartbeat, or `null` if it has never ticked. */
  lastTickSeconds: number | null;
  /** Whether the loop is currently admitted to tick (§5 per-loop admission). */
  admitted: boolean;
}

export interface MetricsRoutesConfig {
  getDaemonReadiness?: () => MetricsDaemonReadiness;
  getLoopSnapshot?: () => readonly MetricsLoopEntry[];
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metricHeader(lines: string[], name: string, type: 'gauge' | 'counter', help: string): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

/** Whole-token float from a wei string. Exact `bigint` strings stay on `/v1/status` (spec §6.2). */
function weiToTokenFloat(wei: string | null | undefined): number | null {
  if (wei === null || wei === undefined) return null;
  try {
    return Number(BigInt(wei)) / 1e18;
  } catch {
    return null;
  }
}

/** Builds the exposition text. Exported standalone so the golden test can assert on it directly. */
export function renderMetrics(store: Store, config: MetricsRoutesConfig = {}): string {
  const lines: string[] = [];
  const readiness = (config.getDaemonReadiness ?? ((): MetricsDaemonReadiness => 'ready'))();
  const loops = config.getLoopSnapshot?.() ?? [];

  metricHeader(lines, 'jinn_daemon_ready', 'gauge', 'Whether daemon readiness is exactly `ready` (1) or not (0).');
  lines.push(`jinn_daemon_ready ${readiness === 'ready' ? 1 : 0}`);

  metricHeader(lines, 'jinn_daemon_degraded', 'gauge', 'Whether daemon readiness is exactly `degraded` (1) or not (0).');
  lines.push(`jinn_daemon_degraded ${readiness === 'degraded' ? 1 : 0}`);

  if (loops.length > 0) {
    metricHeader(
      lines,
      'jinn_loop_last_tick_seconds',
      'gauge',
      'Unix time (seconds) of each daemon loop\'s last heartbeat tick.',
    );
    for (const loop of loops) {
      if (loop.lastTickSeconds !== null) {
        lines.push(`jinn_loop_last_tick_seconds{loop="${loop.name}"} ${loop.lastTickSeconds}`);
      }
    }

    metricHeader(
      lines,
      'jinn_loop_admitted',
      'gauge',
      'Whether the loop is currently admitted to tick under the §5 per-loop admission rule (1), or sitting out a degraded window (0).',
    );
    for (const loop of loops) {
      lines.push(`jinn_loop_admitted{loop="${loop.name}"} ${loop.admitted ? 1 : 0}`);
    }
  }

  metricHeader(lines, 'jinn_activity_counter', 'counter', 'Lifetime count of recorded activity events by kind.');
  for (const [kind, count] of Object.entries(store.getActivityCountsByKind())) {
    lines.push(`jinn_activity_counter{kind="${escapeLabelValue(kind)}"} ${count}`);
  }

  metricHeader(
    lines,
    'jinn_balance_native_tokens',
    'gauge',
    'Cached native-token balance (whole tokens) by role. Exact wei strings stay on /v1/status.',
  );
  metricHeader(
    lines,
    'jinn_balance_bond_tokens',
    'gauge',
    'Cached bond-asset (OLAS) balance (whole tokens) by role. Exact wei strings stay on /v1/status.',
  );
  for (const entry of store.getBalanceCache()) {
    const role = escapeLabelValue(entry.role);
    const native = weiToTokenFloat(entry.nativeWei);
    if (native !== null) lines.push(`jinn_balance_native_tokens{role="${role}"} ${native}`);
    const bond = weiToTokenFloat(entry.bondWei);
    if (bond !== null) lines.push(`jinn_balance_bond_tokens{role="${role}"} ${bond}`);
  }

  return `${lines.join('\n')}\n`;
}

export function addMetricsRoutes(app: Hono, store: Store, config: MetricsRoutesConfig = {}): void {
  app.get('/metrics', (c) => {
    return c.text(renderMetrics(store, config), 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });
}
