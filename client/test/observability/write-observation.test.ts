/**
 * Tests for the Class O (observation) container primitive (issue #2409,
 * spec/2026-08-04-headless-operator-rederivation-design.md §7/§14.7).
 *
 * The one behavior that must be a tested assertion, not a convention: every write lands with
 * mode 0600 by default. Everything else exercises the atomic-rename idiom itself.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeObservation } from '../../src/observability/write-observation.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jinn-write-observation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeObservation', () => {
  it('writes the file with mode 0600 by default', () => {
    const path = join(dir, 'observation.json');
    writeObservation(path, '{"a":1}\n');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes the given contents readable back from the final path', () => {
    const path = join(dir, 'observation.json');
    writeObservation(path, '{"a":1}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });

  it('creates the parent directory recursively', () => {
    const path = join(dir, 'nested', 'deeper', 'observation.json');
    writeObservation(path, 'contents');
    expect(existsSync(path)).toBe(true);
  });

  it('honors an explicit mode override regardless of the process umask (F9)', () => {
    // A restrictive umask (e.g. 0077, common in hardened containers) would otherwise mask group
    // bits off the mode passed to open()/writeFileSync — assert the mode actually landed rather
    // than assuming a lenient umask in whatever environment runs this test.
    const path = join(dir, 'observation.json');
    writeObservation(path, 'contents', { mode: 0o640 });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it('does not collide with a stale pid+timestamp-named leftover (F4)', () => {
    // The prior temp-name scheme (`${path}.${pid}.${Date.now()}.tmp`) could collide across
    // containers/hosts sharing a pid and a millisecond clock tick; a second writer's `wx` open
    // would EEXIST, and its `finally` cleanup would then delete the FIRST writer's still-in-flight
    // temp file out from under it. Simulate the collision surface directly: pre-create a file at
    // exactly the path the old scheme would have chosen and confirm the current implementation
    // (which no longer derives its temp name from pid/Date.now()) neither collides with it nor
    // depends on it.
    const path = join(dir, 'observation.json');
    const now = 1700000000000;
    const staleCollision = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync(staleCollision, 'unrelated leftover from another writer');
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      expect(() => writeObservation(path, 'contents')).not.toThrow();
    } finally {
      Date.now = originalNow;
    }
    expect(readFileSync(path, 'utf8')).toBe('contents');
    // The stale collision file is untouched — the fix must not depend on cleaning it up, only on
    // never generating the same name in the first place.
    expect(readFileSync(staleCollision, 'utf8')).toBe('unrelated leftover from another writer');
  });

  it('leaves no temp file behind after a successful write', () => {
    const path = join(dir, 'observation.json');
    writeObservation(path, 'contents');
    const entries = readdirSync(dir);
    expect(entries).toEqual(['observation.json']);
  });

  it('atomically replaces an existing file at the target path', () => {
    const path = join(dir, 'observation.json');
    writeObservation(path, 'first');
    writeObservation(path, 'second');
    expect(readFileSync(path, 'utf8')).toBe('second');
    expect(readdirSync(dir)).toEqual(['observation.json']);
  });
});
