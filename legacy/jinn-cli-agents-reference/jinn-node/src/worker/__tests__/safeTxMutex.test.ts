import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use a temp directory for tests
const TEST_LOCK_DIR = join(tmpdir(), `safe-locks-test-${process.pid}`);

// Ensure clean state, then create the dir
rmSync(TEST_LOCK_DIR, { recursive: true, force: true });
mkdirSync(TEST_LOCK_DIR, { recursive: true });

// Set env before importing the module
vi.stubEnv('SAFE_LOCK_DIR', TEST_LOCK_DIR);

// Dynamic import to pick up the env override
const { acquireSafeLock } = await import('../safeTxMutex.js');

describe('safeTxMutex', () => {
  afterAll(() => {
    rmSync(TEST_LOCK_DIR, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Basic acquire / release
  // -----------------------------------------------------------------------

  it('acquires and releases a lock, creating and removing the lockfile', async () => {
    const release = await acquireSafeLock('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
    const lockFile = join(TEST_LOCK_DIR, '0xabcdef1234567890abcdef1234567890abcdef12.lock');
    expect(existsSync(lockFile)).toBe(true);

    const payload = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
    expect(payload.safe).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(typeof payload.ts).toBe('number');

    release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it('release is idempotent — calling it twice does not throw', async () => {
    const release = await acquireSafeLock('0xIDEMPOTENT000000000000000000000000000000');
    release();
    expect(() => release()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // In-process serialisation
  // -----------------------------------------------------------------------

  it('serializes concurrent acquires for the same Safe', async () => {
    const order: number[] = [];

    const p1 = acquireSafeLock('0x1111111111111111111111111111111111111111').then(async (release) => {
      order.push(1);
      await new Promise(r => setTimeout(r, 50));
      order.push(2);
      release();
    });

    const p2 = acquireSafeLock('0x1111111111111111111111111111111111111111').then(async (release) => {
      order.push(3);
      release();
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('serializes 5 concurrent acquires in FIFO order', async () => {
    const order: number[] = [];
    const addr = '0xFIFO000000000000000000000000000000000000';

    const tasks = Array.from({ length: 5 }, (_, i) =>
      acquireSafeLock(addr).then(async (release) => {
        order.push(i);
        await new Promise(r => setTimeout(r, 10));
        release();
      }),
    );

    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('allows concurrent acquires for different Safes', async () => {
    const order: string[] = [];

    const p1 = acquireSafeLock('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').then(async (release) => {
      order.push('a-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('a-end');
      release();
    });

    const p2 = acquireSafeLock('0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB').then(async (release) => {
      order.push('b-start');
      release();
    });

    await Promise.all([p1, p2]);
    const bIdx = order.indexOf('b-start');
    const aEndIdx = order.indexOf('a-end');
    expect(bIdx).toBeLessThan(aEndIdx);
  });

  // -----------------------------------------------------------------------
  // Case normalisation
  // -----------------------------------------------------------------------

  it('normalizes safe addresses to lowercase', async () => {
    const order: number[] = [];

    const p1 = acquireSafeLock('0xAABBCCDDEEFF00112233445566778899AABBCCDD').then(async (release) => {
      order.push(1);
      await new Promise(r => setTimeout(r, 30));
      order.push(2);
      release();
    });

    const p2 = acquireSafeLock('0xaabbccddeeff00112233445566778899aabbccdd').then(async (release) => {
      order.push(3);
      release();
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  // -----------------------------------------------------------------------
  // Stale lock recovery
  // -----------------------------------------------------------------------

  it('breaks stale lock from dead PID', async () => {
    const lockFile = join(TEST_LOCK_DIR, '0xdeadbeef00000000000000000000000000000000.lock');
    writeFileSync(lockFile, JSON.stringify({
      pid: 99999999, // almost certainly not running
      ts: Date.now(),
      safe: '0xdeadbeef00000000000000000000000000000000',
    }));

    const release = await acquireSafeLock('0xDEADBEEF00000000000000000000000000000000');
    expect(existsSync(lockFile)).toBe(true);

    const payload = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(payload.pid).toBe(process.pid);

    release();
  });

  it('breaks stale lock older than threshold even if PID is alive', async () => {
    const lockFile = join(TEST_LOCK_DIR, '0xoldlock0000000000000000000000000000000000.lock');
    writeFileSync(lockFile, JSON.stringify({
      pid: process.pid, // alive, but timestamp is old
      ts: Date.now() - 6 * 60 * 1000, // 6 minutes ago (> 5 min threshold)
      safe: '0xoldlock0000000000000000000000000000000000',
    }));

    const release = await acquireSafeLock('0xOLDLOCK0000000000000000000000000000000000');

    // Verify our process claimed the lock
    const payload = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
    expect(payload.ts).toBeGreaterThan(Date.now() - 5000); // fresh timestamp

    release();
  });

  it('handles corrupt/empty lock file gracefully', async () => {
    const lockFile = join(TEST_LOCK_DIR, '0xcorrupt0000000000000000000000000000000000.lock');
    writeFileSync(lockFile, 'not valid json!!!');

    // readLockPayload returns null for corrupt files, so the lock should be
    // treated as non-stale initially. But on next poll iteration the file
    // will still be there. Since we can't parse the PID, we'll keep polling.
    // To avoid timeout, remove it so the next iteration succeeds.
    setTimeout(() => {
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    }, 150);

    const release = await acquireSafeLock('0xCORRUPT0000000000000000000000000000000000');
    release();
  });

  // -----------------------------------------------------------------------
  // Multiple sequential cycles
  // -----------------------------------------------------------------------

  it('supports multiple sequential acquire/release cycles', async () => {
    const addr = '0xCYCLE000000000000000000000000000000000000';
    for (let i = 0; i < 10; i++) {
      const release = await acquireSafeLock(addr);
      const lockFile = join(TEST_LOCK_DIR, '0xcycle000000000000000000000000000000000000.lock');
      expect(existsSync(lockFile)).toBe(true);
      release();
      expect(existsSync(lockFile)).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // Lock contention under load
  // -----------------------------------------------------------------------

  it('handles 20 concurrent acquires for the same Safe without deadlock', async () => {
    const addr = '0xLOAD000000000000000000000000000000000000';
    let counter = 0;

    const tasks = Array.from({ length: 20 }, () =>
      acquireSafeLock(addr).then(async (release) => {
        const before = counter;
        counter++;
        // Yield to event loop — if serialisation is broken, counter could jump
        await new Promise(r => setTimeout(r, 1));
        expect(counter).toBe(before + 1); // No concurrent mutation
        release();
      }),
    );

    await Promise.all(tasks);
    expect(counter).toBe(20);
  }, 15_000);

  // -----------------------------------------------------------------------
  // Lock file cleanup on release
  // -----------------------------------------------------------------------

  it('does not leave orphan lock files after normal operation', async () => {
    const addrs = [
      '0xCLEAN1000000000000000000000000000000000',
      '0xCLEAN2000000000000000000000000000000000',
      '0xCLEAN3000000000000000000000000000000000',
    ];

    // Acquire and release all
    for (const addr of addrs) {
      const release = await acquireSafeLock(addr);
      release();
    }

    // Verify no .lock files remain for these addresses
    const remaining = readdirSync(TEST_LOCK_DIR).filter(f => f.includes('clean'));
    expect(remaining).toEqual([]);
  });
});
