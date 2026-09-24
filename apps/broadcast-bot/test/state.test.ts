import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore, emptyState, POSTED_CAP } from '../src/state/store.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'jinn-bcast-state-'));
}

describe('StateStore', () => {
  it('round-trips empty state', () => {
    const dir = tmp();
    try {
      const store = new StateStore(join(dir, 'state.json'));
      const initial = store.load();
      expect(initial).toEqual(emptyState());
      store.save(initial);
      const reloaded = store.load();
      expect(reloaded).toEqual(initial);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves watermarks and posted IDs', () => {
    const dir = tmp();
    try {
      const store = new StateStore(join(dir, 'state.json'));
      const state = emptyState();
      state.github.releases.watermark = '2026-05-12T09:00:00Z';
      state.github.releases.posted.push('release:1', 'release:2');
      state.onchain.watermark = 21345678;
      state.onchain.posted.push('solvernet-manifest:bafy...');
      store.save(state);

      const reloaded = store.load();
      expect(reloaded.github.releases.watermark).toBe('2026-05-12T09:00:00Z');
      expect(reloaded.github.releases.posted).toEqual(['release:1', 'release:2']);
      expect(reloaded.onchain.watermark).toBe(21345678);
      expect(reloaded.onchain.posted).toEqual(['solvernet-manifest:bafy...']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps posted arrays at POSTED_CAP', () => {
    const dir = tmp();
    try {
      const store = new StateStore(join(dir, 'state.json'));
      const state = emptyState();
      const oversized = Array.from({ length: POSTED_CAP + 50 }, (_, i) => `release:${i}`);
      state.github.releases.posted = oversized;
      store.save(state);
      const reloaded = store.load();
      expect(reloaded.github.releases.posted.length).toBe(POSTED_CAP);
      // Should keep the newest entries (end of array).
      expect(reloaded.github.releases.posted[POSTED_CAP - 1]).toBe(
        `release:${POSTED_CAP + 49}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty state when file does not exist', () => {
    const dir = tmp();
    try {
      const store = new StateStore(join(dir, 'missing.json'));
      expect(store.load()).toEqual(emptyState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('materializes empty state from the workflow bootstrap object', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'state.json');
      writeFileSync(path, '{}\n');
      expect(new StateStore(path).load()).toEqual(emptyState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed persisted state', () => {
    const dir = tmp();
    try {
      const path = join(dir, 'state.json');
      writeFileSync(path, '{"github":{"releases":{"watermark":null,"posted":"bad"}}}\n');
      expect(() => new StateStore(path).load()).toThrow('github.releases.posted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
