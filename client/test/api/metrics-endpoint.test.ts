/**
 * `GET /metrics` — Prometheus text exposition (spec/2026-08-04-headless-operator-rederivation-design.md
 * §6.2; issue #2404). Golden exposition-format tests against `renderMetrics` directly (no
 * HTTP round-trip needed for the format assertions) plus one route-level content-type check.
 *
 * `getDaemonReadiness` / `getLoopSnapshot` are injected (api→daemon architecture boundary,
 * #1584 — `client/src/api/` must never import `client/src/daemon/`; this test file is NOT
 * under `src/api/`, so it can import `buildLoopMetricsSnapshot` from the real
 * `daemon/loop-heartbeat.js` and wire it straight through, exactly like the production
 * caller in main.ts / daemon.ts's self-start branch — one shared implementation, not a
 * third verbatim copy of the admission expression (review finding N5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import { renderMetrics } from '../../src/api/metrics-endpoint.js';
import {
  LOOP_REGISTRY,
  buildLoopMetricsSnapshot,
  getDaemonReadiness,
  recordLoopTick,
  setDaemonReadiness,
} from '../../src/daemon/loop-heartbeat.js';

let store: Store;

function loopSnapshot() {
  return buildLoopMetricsSnapshot(store);
}

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
  setDaemonReadiness('ready');
});

describe('renderMetrics — exposition format', () => {
  it('carries the jinn_ prefix on every metric line and no others', () => {
    const text = renderMetrics(store, { getDaemonReadiness, getLoopSnapshot: loopSnapshot });
    const metricLines = text.split('\n').filter((l) => l && !l.startsWith('#'));
    for (const line of metricLines) {
      expect(line).toMatch(/^jinn_/);
    }
  });

  it('emits HELP + TYPE lines for every metric family it writes samples for', () => {
    const text = renderMetrics(store, { getDaemonReadiness, getLoopSnapshot: loopSnapshot });
    const names = ['jinn_daemon_ready', 'jinn_daemon_degraded', 'jinn_loop_last_tick_seconds', 'jinn_loop_admitted', 'jinn_activity_events_total', 'jinn_balance_native_tokens', 'jinn_balance_bond_tokens'];
    for (const name of names) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toMatch(new RegExp(`# TYPE ${name} (gauge|counter)`));
    }
  });

  it('omits the loop metric families entirely when no snapshot is wired (bare/test server)', () => {
    const text = renderMetrics(store);
    expect(text).not.toContain('jinn_loop_last_tick_seconds');
    expect(text).not.toContain('jinn_loop_admitted');
    // Readiness still defaults to ready and the other families still render.
    expect(text).toContain('jinn_daemon_ready 1');
    expect(text).toContain('jinn_activity_events_total');
  });

  it('reports jinn_daemon_ready=1 / jinn_daemon_degraded=0 when readiness is ready', () => {
    setDaemonReadiness('ready');
    const text = renderMetrics(store, { getDaemonReadiness });
    expect(text).toContain('jinn_daemon_ready 1');
    expect(text).toContain('jinn_daemon_degraded 0');
  });

  it('reports jinn_daemon_ready=0 / jinn_daemon_degraded=1 when readiness is degraded', () => {
    setDaemonReadiness('degraded');
    const text = renderMetrics(store, { getDaemonReadiness });
    expect(text).toContain('jinn_daemon_ready 0');
    expect(text).toContain('jinn_daemon_degraded 1');
  });

  it('emits jinn_loop_admitted=1 for every loop when ready', () => {
    setDaemonReadiness('ready');
    const text = renderMetrics(store, { getDaemonReadiness, getLoopSnapshot: loopSnapshot });
    for (const loop of LOOP_REGISTRY) {
      expect(text).toContain(`jinn_loop_admitted{loop="${loop.name}"} 1`);
    }
  });

  it('emits jinn_loop_admitted=0 only for ready-only loops when degraded', () => {
    setDaemonReadiness('degraded');
    const text = renderMetrics(store, { getDaemonReadiness, getLoopSnapshot: loopSnapshot });
    for (const loop of LOOP_REGISTRY) {
      const expected = loop.admission === 'always' ? 1 : 0;
      expect(text).toContain(`jinn_loop_admitted{loop="${loop.name}"} ${expected}`);
    }
  });

  it('omits jinn_loop_last_tick_seconds for a loop that has never ticked, and includes it once it has', () => {
    const before = renderMetrics(store, { getDaemonReadiness, getLoopSnapshot: loopSnapshot });
    expect(before).not.toMatch(/jinn_loop_last_tick_seconds\{loop="checkpoint"\}/);

    recordLoopTick(store, 'checkpoint');
    const after = renderMetrics(store, { getDaemonReadiness, getLoopSnapshot: loopSnapshot });
    expect(after).toMatch(/jinn_loop_last_tick_seconds\{loop="checkpoint"\} \d+(\.\d+)?/);
  });

  it('derives jinn_activity_events_total from store.getActivityCountsByKind, one line per kind', () => {
    store.recordActivityEvent({ ts: new Date().toISOString(), kind: 'restoration_delivered' });
    store.recordActivityEvent({ ts: new Date().toISOString(), kind: 'restoration_delivered' });
    store.recordActivityEvent({ ts: new Date().toISOString(), kind: 'evaluation_delivered' });

    const text = renderMetrics(store);
    expect(text).toContain('jinn_activity_events_total{kind="restoration_delivered"} 2');
    expect(text).toContain('jinn_activity_events_total{kind="evaluation_delivered"} 1');
  });

  it('derives balance gauges from the cache as whole-token floats, no raw wei/address', () => {
    store.upsertBalanceCache({
      role: 'service.0.agent',
      address: '0xAgentAddressShouldNeverAppearInMetrics',
      nativeWei: '1500000000000000000', // 1.5 tokens
      fetchedAt: new Date().toISOString(),
    });
    store.upsertBalanceCache({
      role: 'service.0.multisig',
      address: '0xSafeAddressShouldNeverAppearInMetrics',
      nativeWei: '2000000000000000000', // 2 tokens
      bondWei: '3000000000000000000', // 3 tokens
      fetchedAt: new Date().toISOString(),
    });

    const text = renderMetrics(store);
    expect(text).toContain('jinn_balance_native_tokens{role="service.0.agent"} 1.5');
    expect(text).toContain('jinn_balance_native_tokens{role="service.0.multisig"} 2');
    expect(text).toContain('jinn_balance_bond_tokens{role="service.0.multisig"} 3');
    expect(text).not.toContain('0xAgentAddressShouldNeverAppearInMetrics');
    expect(text).not.toContain('0xSafeAddressShouldNeverAppearInMetrics');
  });

  it('does not interleave the native and bond balance families (OpenMetrics contiguity)', () => {
    store.upsertBalanceCache({
      role: 'service.0.agent',
      address: '0xAgent',
      nativeWei: '1000000000000000000',
      fetchedAt: new Date().toISOString(),
    });
    store.upsertBalanceCache({
      role: 'service.0.multisig',
      address: '0xSafe',
      nativeWei: '2000000000000000000',
      bondWei: '3000000000000000000',
      fetchedAt: new Date().toISOString(),
    });

    const lines = renderMetrics(store).split('\n').filter(Boolean);
    const nativeIdx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('jinn_balance_native_tokens{') || l === '# TYPE jinn_balance_native_tokens gauge')
      .map(({ i }) => i);
    const bondIdx = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('jinn_balance_bond_tokens{') || l === '# TYPE jinn_balance_bond_tokens gauge')
      .map(({ i }) => i);
    // Every native-family line index must come before every bond-family line index —
    // i.e. the two families occupy disjoint contiguous blocks, never interleaved.
    expect(Math.max(...nativeIdx)).toBeLessThan(Math.min(...bondIdx));
  });

  it('ends with a trailing newline (exposition-format requirement)', () => {
    expect(renderMetrics(store).endsWith('\n')).toBe(true);
  });
});

describe('GET /metrics — route', () => {
  let server: ApiServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('serves text/plain; version=0.0.4 and the rendered body, unauthenticated', async () => {
    server = await startApiServer({
      port: 0,
      store,
      apiToken: 'test-token',
      getDaemonReadiness,
      getLoopSnapshot: loopSnapshot,
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    const body = await res.text();
    expect(body).toContain('jinn_daemon_ready');
  });
});
