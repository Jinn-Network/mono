/**
 * Cross-process lock verification.
 *
 * Spawns child processes that contend for the same Safe lock via file-based
 * locking and verifies they serialize correctly (no overlapping critical sections).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_LOCK_DIR = join(tmpdir(), `safe-locks-xproc-${process.pid}`);
const SHARED_LOG = join(tmpdir(), `safe-locks-xproc-log-${process.pid}.jsonl`);
const SAFE_ADDR = '0xcrossprocess0000000000000000000000000000';

// Worker script path — use .mjs for native ESM top-level await support
const WORKER_SCRIPT = join(tmpdir(), `safe-lock-worker-${process.pid}.mjs`);

describe('safeTxMutex cross-process', () => {
  afterAll(() => {
    rmSync(TEST_LOCK_DIR, { recursive: true, force: true });
    try { rmSync(SHARED_LOG); } catch { /* ignore */ }
    try { rmSync(WORKER_SCRIPT); } catch { /* ignore */ }
  });

  it('prevents overlapping critical sections across 3 child processes', async () => {
    // Set up dirs
    rmSync(TEST_LOCK_DIR, { recursive: true, force: true });
    mkdirSync(TEST_LOCK_DIR, { recursive: true });
    writeFileSync(SHARED_LOG, '');

    // Write the child worker script as plain ESM JS (no TS, no imports from project)
    writeFileSync(WORKER_SCRIPT, `
import { open, readFile, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_DIR = process.env.SAFE_LOCK_DIR;
const SAFE_ADDR = '${SAFE_ADDR}';
const POLL_INITIAL_MS = 50;
const POLL_MAX_MS = 800;
const POLL_TIMEOUT_MS = 30000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function lockPath(key) { return join(LOCK_DIR, key + '.lock'); }

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isLockStale(p) {
  return !isPidAlive(p.pid) || Date.now() - p.ts > STALE_THRESHOLD_MS;
}

async function readLockPayload(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

async function tryBreakStaleLock(lp, key) {
  const tmp = join(LOCK_DIR, key + '.' + process.pid + '.' + Date.now() + '.tmp');
  try {
    await writeFile(tmp, JSON.stringify({ pid: process.pid, ts: Date.now(), safe: key }));
    await rename(tmp, lp);
    return true;
  } catch { try { unlinkSync(tmp); } catch {} return false; }
}

async function acquireLock() {
  const key = SAFE_ADDR;
  const lp = lockPath(key);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = POLL_INITIAL_MS;

  while (true) {
    try {
      const fd = await open(lp, 'wx', 0o644);
      await fd.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now(), safe: key }));
      await fd.close();
      return () => { try { unlinkSync(lp); } catch {} };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const existing = await readLockPayload(lp);
    if (existing && isLockStale(existing)) {
      if (await tryBreakStaleLock(lp, key)) {
        return () => { try { unlinkSync(lp); } catch {} };
      }
    }

    if (Date.now() >= deadline) throw new Error('Lock timeout');
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

const workerId = process.argv[2];
const logFile = process.argv[3];

for (let i = 0; i < 3; i++) {
  const release = await acquireLock();
  const enterTs = Date.now();
  await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
  const exitTs = Date.now();
  appendFileSync(logFile, JSON.stringify({ workerId, i, enterTs, exitTs }) + '\\n');
  release();
}

process.exit(0);
`);

    // Spawn 3 child processes
    const children = Array.from({ length: 3 }, (_, i) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER_SCRIPT, String(i), SHARED_LOG], {
          env: { ...process.env, SAFE_LOCK_DIR: TEST_LOCK_DIR },
          stdio: 'pipe',
        });

        let stderr = '';
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => {
          if (stderr) console.error(`[child-${i} stderr]`, stderr.slice(0, 500));
          if (code === 0) resolve();
          else reject(new Error(`Child ${i} exited with code ${code}`));
        });
        child.on('error', reject);
      });
    });

    await Promise.all(children);

    // Parse the log and check for overlaps
    const logContent = readFileSync(SHARED_LOG, 'utf-8').trim();
    const entries = logContent.split('\n').map(line => JSON.parse(line));

    // We expect 3 workers × 3 iterations = 9 entries
    expect(entries.length).toBe(9);

    // Sort by enterTs to check for overlaps
    entries.sort((a, b) => a.enterTs - b.enterTs);

    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      // Each entry's enterTs should be >= previous entry's exitTs
      // (allowing 2ms of clock resolution)
      expect(curr.enterTs).toBeGreaterThanOrEqual(prev.exitTs - 2);
    }

    // Verify all 3 workers participated
    const workers = new Set(entries.map(e => e.workerId));
    expect(workers.size).toBe(3);
  }, 60_000);
});
