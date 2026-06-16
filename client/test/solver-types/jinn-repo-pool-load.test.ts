import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJinnRepoPool, resolveJinnRepoSlate } from '../../src/solver-types/_jinn-repo-pool.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SAMPLE = join(__dirname, '../fixtures/jinn-repo/pool.sample.json');

describe('loadJinnRepoPool', () => {
  it('parses pool items from a JSON file', () => {
    const pool = loadJinnRepoPool({ path: SAMPLE });
    expect(pool.length).toBeGreaterThan(0);
    expect(pool[0]!.gold_tests).toBeDefined();
  });
  it('resolves slate instance ids to full pool items', () => {
    const pool = loadJinnRepoPool({ path: SAMPLE });
    const resolved = resolveJinnRepoSlate(pool, new Set(['Jinn-Network__mono-1042']));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.gold_tests).toBeDefined();
  });
});
