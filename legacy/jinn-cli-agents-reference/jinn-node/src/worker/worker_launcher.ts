import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHealthcheckServer, initHealthInfo } from './healthcheck.js';

const DEFAULT_WORKER_COUNT = 1;
const WORKER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'mech_worker.js');
const PASSTHROUGH_ARGS = process.argv.slice(2);

function parseWorkerCount(raw: string | undefined): number {
  if (!raw) return DEFAULT_WORKER_COUNT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    console.warn(`[launcher] Invalid WORKER_COUNT "${raw}", defaulting to ${DEFAULT_WORKER_COUNT}.`);
    return DEFAULT_WORKER_COUNT;
  }
  return value;
}

const workerCount = parseWorkerCount(process.env.WORKER_COUNT);
const children: ChildProcess[] = [];
let shutdownRequested = false;
let shutdownCode: number | null = null;

function killAllChildren(signal: NodeJS.Signals): void {
  children.forEach((child, index) => {
    if (!child.killed) {
      child.kill(signal);
      if (signal === 'SIGTERM') {
        console.log(`[launcher] Sent SIGTERM to worker-${index + 1}`);
      }
    }
  });
}

function requestShutdown(reason: string, code: number | null): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  shutdownCode = code ?? 0;
  console.log(reason);
  killAllChildren('SIGTERM');
  setTimeout(() => {
    killAllChildren('SIGKILL');
    process.exit(shutdownCode ?? 0);
  }, 5000);
}

function handleSignals(): void {
  const handler = (signal: NodeJS.Signals) => {
    requestShutdown(`[launcher] Received ${signal}, stopping workers...`, 0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function spawnWorker(workerId: string, inheritOutput: boolean): ChildProcess {
  const child = spawn(process.execPath, [WORKER_ENTRY, ...PASSTHROUGH_ARGS], {
    env: { ...process.env, WORKER_ID: workerId },
    stdio: inheritOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  if (!inheritOutput) {
    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          console.log(`[${workerId}] ${line}`);
        }
      });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          console.error(`[${workerId}] ${line}`);
        }
      });
    });
  }

  child.on('exit', (code, signal) => {
    const exitInfo = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.log(`[${workerId}] Exited with ${exitInfo}`);

    if (!shutdownRequested && (signal || (code ?? 0) !== 0)) {
      requestShutdown(`[launcher] ${workerId} exited unexpectedly; stopping all workers.`, code ?? 1);
    }
  });

  return child;
}

async function main(): Promise<void> {
  // Keep healthcheck live in both single-worker and multi-worker modes.
  const workerId = process.env.WORKER_ID || 'default';
  initHealthInfo(workerId);
  startHealthcheckServer();

  if (workerCount <= 1) {
    handleSignals();

    const explicitId = process.env.WORKER_ID?.trim();
    const workerLabel = explicitId && explicitId.length > 0 ? explicitId : 'default';
    const env = { ...process.env };
    if (explicitId && explicitId.length > 0) {
      env.WORKER_ID = explicitId;
    } else {
      delete env.WORKER_ID;
    }
    const child = spawn(process.execPath, [WORKER_ENTRY, ...PASSTHROUGH_ARGS], {
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.exit(1);
      }
      process.exit(code ?? 0);
    });

    children.push(child);
    console.log(`[launcher] Started single worker (${workerLabel})`);
    return;
  }

  handleSignals();

  const baseWorkerId = (process.env.WORKER_ID || 'worker').trim();
  console.log(`[launcher] Starting ${workerCount} parallel workers with base ID "${baseWorkerId}"`);

  for (let i = 1; i <= workerCount; i++) {
    const workerId = `${baseWorkerId}-${i}`;
    const child = spawnWorker(workerId, false);
    children.push(child);
    console.log(`[launcher] ${workerId} started (PID: ${child.pid})`);
  }

  await Promise.all(children.map(child => new Promise<void>(resolve => {
    child.on('exit', () => resolve());
  })));

  if (!shutdownRequested) {
    console.log('[launcher] All workers exited.');
  }
}

main().catch((err) => {
  console.error('[launcher] Error:', err);
  requestShutdown('[launcher] Unhandled error; stopping workers.', 1);
});
