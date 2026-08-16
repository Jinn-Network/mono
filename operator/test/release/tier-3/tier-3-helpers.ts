import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon.js';
import { goldPath } from '../../../scripts/release/substrate-paths.js';

const DAILY_DRIVER_PORTS = [7331, 7332];     // ~/.jinn-client and ~/jinn-canary-test default ports

export function resolveGoldDaemonHome(opName: string): string {
  return goldPath(opName);
}

/**
 * The two substrate ops the producer/evaluator loop runs as, resolved from the
 * environment so the gate can run against ops that are NOT the live daily-driver
 * identity. Defaults preserve the historical `op-a` (creator + evaluator) /
 * `op-b` (solver) pairing; the env suite overrides them (e.g. producer=op-c) so
 * it never spawns a second copy of the Railway-live op-a and never has to
 * clobber its gold home. The names must match gold homes under
 * `~/jinn-dev/operators/<name>` (env suite restores them there).
 */
export function tierOpNames(): { producer: string; solver: string } {
  return {
    producer: process.env['JINN_TIER_PRODUCER_OP']?.trim() || 'op-a',
    solver: process.env['JINN_TIER_SOLVER_OP']?.trim() || 'op-b',
  };
}

export interface IsDailyDriverOptions {
  ports?: number[];
}

export async function isDailyDriverRunning(opts: IsDailyDriverOptions = {}): Promise<boolean> {
  const ports = opts.ports ?? DAILY_DRIVER_PORTS;
  for (const port of ports) {
    const inUse = await isPortInUse(port);
    if (inUse) return true;
  }
  return false;
}

// Liveness check by *connecting* rather than binding. The daily-driver daemon's
// API binds 127.0.0.1 explicitly (see operator/src/api/server.ts — `hostname:
// config.bindHost ?? '127.0.0.1'`). A bind-based probe on the default interface
// (`::`) does not reliably collide with a 127.0.0.1-only listener on macOS, so
// it would silently miss a running daily driver and defeat the mutex. A TCP
// connect to 127.0.0.1 is unambiguous: it succeeds iff something is listening.
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export interface Tier3SetupOptions {
  scenarioId: string;
  mode: 'human-invoked' | 'autonomous';
  portBase?: number;                  // daemons get portBase, portBase+1
  dailyDriverPorts?: number[];        // override the default mutex check
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Directory under which each spawned daemon's stdout + stderr is streamed
   * for its full lifetime. The helper appends `${scenarioId}-daemons/` so
   * multiple scenarios sharing a single evidenceDir do not stomp on each
   * other's daemon logs. Omit to keep the legacy in-memory-tail-only behaviour.
   *
   * Typical caller pattern from a Tier-3 scenario:
   *   evidenceDir: path.dirname(opts.evidencePath)
   */
  evidenceDir?: string;
}

export interface Tier3Handle {
  daemons: MultiOpHandle;
  teardown: () => Promise<void>;
}

interface HarnessReadinessEntry {
  harnessName?: string;
  ready?: boolean;
  reason?: string;
  nextStep?: {
    cli?: string;
    description?: string;
    url?: string;
  };
}

export interface WaitForHarnessReadyOptions {
  opName: string;
  apiPort: number;
  harnessName: string;
  uiToken: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function readUiTokenForOp(opName: string): Promise<string> {
  const tokenPath = path.join(resolveGoldDaemonHome(opName), '.jinn-client', 'ui-token');
  try {
    return (await fs.readFile(tokenPath, 'utf-8')).trim();
  } catch (err) {
    throw new Error(
      `Tier 3 evaluator harness readiness infra-blocked on ${opName}: ` +
        `cannot read UI token at ${tokenPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readinessFailureMessage(opName: string, entry: HarnessReadinessEntry): string {
  const next = entry.nextStep?.cli ?? entry.nextStep?.description ?? entry.nextStep?.url;
  return [
    `Tier 3 evaluator harness readiness infra-blocked on ${opName}: ${entry.reason ?? 'not ready'}`,
    next ? `Next: ${next}` : null,
  ].filter(Boolean).join('. ');
}

export async function waitForHarnessReady(opts: WaitForHarnessReadyOptions): Promise<HarnessReadinessEntry> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'not checked';
  let lastBody = '';

  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${opts.apiPort}/v1/harnesses/${opts.harnessName}/readiness`, {
      headers: { 'x-jinn-ui-token': opts.uiToken },
    });
    lastStatus = `${res.status}`;
    lastBody = await res.text().catch(() => '');

    if (res.status === 200) {
      const entry = JSON.parse(lastBody) as HarnessReadinessEntry;
      if (entry.ready === true) return entry;
      throw new Error(readinessFailureMessage(opts.opName, entry));
    }
    if (res.status !== 404 && res.status !== 503) {
      throw new Error(
        `Tier 3 evaluator harness readiness infra-blocked on ${opts.opName}: ` +
          `/v1/harnesses/${opts.harnessName}/readiness returned ${res.status}: ${lastBody.slice(0, 300)}`,
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Tier 3 evaluator harness readiness infra-blocked on ${opts.opName}: ` +
      `readiness endpoint did not populate within ${timeoutMs}ms ` +
      `(last status ${lastStatus}: ${lastBody.slice(0, 300)})`,
  );
}

export async function setupTier3Scenario(opts: Tier3SetupOptions): Promise<Tier3Handle> {
  // 1. Daily-driver mutex check. Either mode refuses to run while the daily
  // driver holds a substrate-shared port — we never auto-SIGTERM from here
  // because that requires permission over a process we don't own. Autonomous
  // mode tells the caller to stop it; human-invoked mode defers the SIGTERM to
  // release-readiness's own daemon-mutex Phase 5 logic.
  const dailyUp = await isDailyDriverRunning({ ports: opts.dailyDriverPorts });
  if (dailyUp && opts.mode === 'autonomous') {
    throw new Error(
      'daily driver appears to be running on one of the substrate-shared ports. ' +
      'Autonomous mode refuses to SIGTERM it. Re-run in human-invoked mode or stop the daily driver first.',
    );
  }
  if (dailyUp) {
    throw new Error(
      'daily driver is running on a substrate-shared port. ' +
      'In human-invoked mode, release-readiness should SIGTERM it before invoking Tier 3.',
    );
  }

  // 2. Spawn daemons against gold paths (no workspace copy)
  const portBase = opts.portBase ?? 7350;
  // When the caller supplied an evidenceDir, stream per-daemon stdout/stderr
  // into ${evidenceDir}/${scenarioId}-daemons/${op.name}-daemon.log for the
  // daemon's full lifetime — Tier 3's 25-min budget makes a post-mortem log
  // load-bearing, since the failure mode is usually a stall many minutes in.
  const logDir = opts.evidenceDir
    ? `${opts.evidenceDir.replace(/\/+$/, '')}/${opts.scenarioId}-daemons`
    : undefined;
  const { producer, solver } = tierOpNames();
  let daemons: MultiOpHandle;
  try {
    daemons = await spawnMultiOpDaemons({
      ops: [
        { name: producer, home: resolveGoldDaemonHome(producer), apiPort: portBase },
        { name: solver, home: resolveGoldDaemonHome(solver), apiPort: portBase + 1 },
      ],
      extraEnv: opts.extraEnv,
      readyTimeoutMs: 60000,           // real chain warm-up may be slower than fork
      logDir,
    });
    const evaluatorOp = producer;
    await waitForHarnessReady({
      opName: evaluatorOp,
      apiPort: daemons.daemons[evaluatorOp]!.apiPort,
      harnessName: 'swe-rebench-v2-evaluator',
      uiToken: await readUiTokenForOp(evaluatorOp),
    });
  } catch (err) {
    if (daemons) {
      try { await daemons.teardown(); } catch { /* best-effort cleanup after setup failure */ }
    }
    throw new Error(`Tier 3 daemon setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let torn = false;
  return {
    daemons,
    teardown: async () => {
      if (torn) return;
      torn = true;
      await daemons.teardown();
    },
  };
}
