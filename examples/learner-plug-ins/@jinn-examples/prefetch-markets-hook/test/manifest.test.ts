import { describe, it, expect } from 'vitest';
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugInManifest } from '@jinn-network/client/dist/restorer/plug-ins/manifest.js';

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('@jinn-examples/prefetch-markets-hook manifest', () => {
  it('validates and references an executable hook script', async () => {
    const m = await loadPlugInManifest(PKG_ROOT);
    expect(m.slots).toHaveLength(1);
    const slot = m.slots[0];
    if (slot.type !== 'hook') throw new Error('wrong slot type');
    expect(slot.event).toBe('pre-phase');
    expect(slot.phase).toBe('orient');
    const hookAbs = join(PKG_ROOT, slot.entry);
    expect(existsSync(hookAbs)).toBe(true);
    // posix executable bit
    const mode = statSync(hookAbs).mode & 0o111;
    expect(mode).toBeGreaterThan(0);
  });
});

describe('hooks/pre-orient behaviour', () => {
  it('writes markets.json under workingDir/.cache for prediction.v0', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prefetch-hook-'));
    try {
      execFileSync(join(PKG_ROOT, 'hooks/pre-orient'), [], {
        env: {
          ...process.env,
          JINN_INTENT_ID: 'intent-test-1',
          JINN_INTENT_KIND: 'prediction.v0',
          JINN_PHASE: 'orient',
          JINN_WORKING_DIR: tmp,
          JINN_IMPL_STATE_DIR: tmp,
          PATH: process.env.PATH,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const cached = JSON.parse(
        readFileSync(join(tmp, '.cache/markets.json'), 'utf8'),
      ) as { intentId: string; stub: boolean; markets: unknown[] };
      expect(cached.intentId).toBe('intent-test-1');
      expect(cached.stub).toBe(true);
      expect(cached.markets).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is a no-op for non-prediction kinds', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prefetch-hook-'));
    try {
      execFileSync(join(PKG_ROOT, 'hooks/pre-orient'), [], {
        env: {
          ...process.env,
          JINN_INTENT_ID: 'intent-test-2',
          JINN_INTENT_KIND: 'restoration.v0',
          JINN_WORKING_DIR: tmp,
          JINN_IMPL_STATE_DIR: tmp,
          PATH: process.env.PATH,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      expect(existsSync(join(tmp, '.cache/markets.json'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
