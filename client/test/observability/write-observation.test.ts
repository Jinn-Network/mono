/**
 * Tests for the Class O (observation) container primitive (issue #2409,
 * spec/2026-08-04-headless-operator-rederivation-design.md §7/§14.7).
 *
 * The one behavior that must be a tested assertion, not a convention: every write lands with
 * mode 0600 by default. Everything else exercises the atomic-rename idiom itself.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

  it('honors an explicit mode override', () => {
    const path = join(dir, 'observation.json');
    writeObservation(path, 'contents', { mode: 0o640 });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o640);
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
