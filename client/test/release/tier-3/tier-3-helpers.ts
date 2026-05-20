import * as net from 'node:net';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon.js';
import { goldPath } from '../../../scripts/release/substrate-paths.js';

const DAILY_DRIVER_PORTS = [7331, 7332];     // ~/.jinn-client and ~/jinn-canary-test default ports

export function resolveGoldDaemonHome(opName: string): string {
  return goldPath(opName);
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
// API binds 127.0.0.1 explicitly (see client/src/api/server.ts — `hostname:
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
}

export interface Tier3Handle {
  daemons: MultiOpHandle;
  teardown: () => Promise<void>;
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
  let daemons: MultiOpHandle;
  try {
    daemons = await spawnMultiOpDaemons({
      ops: [
        { name: 'op-a', home: resolveGoldDaemonHome('op-a'), apiPort: portBase },
        { name: 'op-b', home: resolveGoldDaemonHome('op-b'), apiPort: portBase + 1 },
      ],
      extraEnv: opts.extraEnv,
      readyTimeoutMs: 60000,           // real chain warm-up may be slower than fork
    });
  } catch (err) {
    throw new Error(`Tier 3 daemon spawn failed: ${err instanceof Error ? err.message : String(err)}`);
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
