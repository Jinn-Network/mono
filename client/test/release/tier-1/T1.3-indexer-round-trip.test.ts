import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT13IndexerRoundTrip } from './T1.3-indexer-round-trip.js';

describe('T1.3 indexer-round-trip', () => {
  it('returns skip verdict while Ponder helper is missing', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.3-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.3.log');
    try {
      const verdict = await runT13IndexerRoundTrip({ evidencePath });
      expect(verdict.scenarioId).toBe('T1.3');
      expect(verdict.verdict).toBe('skip');
      expect(verdict.failClass).toBeNull();
      expect(verdict.failNotes).toMatch(/Ponder|helper|341/);
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('skip');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  });
});
