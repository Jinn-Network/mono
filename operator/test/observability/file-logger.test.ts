/**
 * Tests for the rotating daemon file logger (issue #420 §1).
 *
 * Drives rotation deterministically with a tiny size bound against a
 * tmpdir() log directory. Verifies rotation, oldest-drop at N, listLogFiles
 * order, age-based cleanup, and pre-redaction of log bytes.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLogger } from '../../src/observability/file-logger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jinn-filelogger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileLogger', () => {
  it('creates the log directory and the active daemon.log file', () => {
    const logger = new FileLogger({ logDir: join(dir, 'logs') });
    logger.write('first line');
    logger.close();
    expect(existsSync(join(dir, 'logs', 'daemon.log'))).toBe(true);
    expect(readFileSync(join(dir, 'logs', 'daemon.log'), 'utf8')).toContain('first line');
  });

  it('appends a newline per write', () => {
    const logger = new FileLogger({ logDir: dir });
    logger.write('line a');
    logger.write('line b');
    logger.close();
    const content = readFileSync(join(dir, 'daemon.log'), 'utf8');
    expect(content.split('\n').filter(Boolean)).toEqual(['line a', 'line b']);
  });

  it('rotates the active file when it crosses the size bound', () => {
    const logger = new FileLogger({ logDir: dir, maxBytes: 200, maxFiles: 5 });
    // Each line ~50 bytes; after ~5 lines we cross 200 bytes -> rotate.
    for (let i = 0; i < 20; i++) {
      logger.write(`log entry number ${i} padding padding padding`);
    }
    logger.close();
    expect(existsSync(join(dir, 'daemon.log'))).toBe(true);
    expect(existsSync(join(dir, 'daemon.log.1'))).toBe(true);
  });

  it('drops the oldest rotated file once maxFiles is reached', () => {
    const logger = new FileLogger({ logDir: dir, maxBytes: 100, maxFiles: 3 });
    for (let i = 0; i < 80; i++) {
      logger.write(`entry ${i} ${'x'.repeat(40)}`);
    }
    logger.close();
    // Keep daemon.log + .1 + .2 (maxFiles=3); .3 must never exist.
    expect(existsSync(join(dir, 'daemon.log'))).toBe(true);
    expect(existsSync(join(dir, 'daemon.log.3'))).toBe(false);
  });

  it('listLogFiles returns active file first, then rotated in order', () => {
    const logger = new FileLogger({ logDir: dir, maxBytes: 100, maxFiles: 5 });
    for (let i = 0; i < 40; i++) {
      logger.write(`entry ${i} ${'y'.repeat(40)}`);
    }
    const files = logger.listLogFiles();
    logger.close();
    expect(files[0]).toBe(join(dir, 'daemon.log'));
    expect(files.length).toBeGreaterThan(1);
    expect(files[1]).toBe(join(dir, 'daemon.log.1'));
    // All listed files must exist on disk.
    for (const f of files) expect(existsSync(f)).toBe(true);
  });

  it('deletes rotated files older than the age bound on startup', () => {
    // Plant a stale rotated file with an mtime 30 days in the past.
    const stale = join(dir, 'daemon.log.4');
    writeFileSync(stale, 'ancient logs');
    const thirtyDaysAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(stale, thirtyDaysAgo, thirtyDaysAgo);
    // Constructing a logger triggers the startup age sweep.
    const logger = new FileLogger({ logDir: dir, maxAgeDays: 14 });
    logger.close();
    expect(existsSync(stale)).toBe(false);
  });

  it('keeps rotated files newer than the age bound', () => {
    const fresh = join(dir, 'daemon.log.2');
    writeFileSync(fresh, 'recent logs');
    const logger = new FileLogger({ logDir: dir, maxAgeDays: 14 });
    logger.close();
    expect(existsSync(fresh)).toBe(true);
  });

  it('pre-redacts secret-shaped content before writing to disk', () => {
    const logger = new FileLogger({ logDir: dir });
    const privKey = '0x' + 'ab'.repeat(32);
    logger.write(`connecting with key ${privKey}`);
    logger.write('rpc error at https://rpc.example.com/v3/SECRETKEYSEGMENT12345');
    logger.close();
    const content = readFileSync(join(dir, 'daemon.log'), 'utf8');
    expect(content).not.toContain(privKey);
    expect(content).not.toContain('SECRETKEYSEGMENT12345');
  });
});
