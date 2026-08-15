import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openOperatorEvidence } from '../../src/daemon/evidence-join.js';

describe('operator evidence join', () => {
  it('produces EvidenceBindingPorts backed by the local runtime', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-evidence-'));
    const evidence = await openOperatorEvidence({ rootDir });
    try {
      expect(evidence.ports.repository).toBe(evidence.runtime.repository);
      expect(evidence.ports.catalog).toBe(evidence.runtime.catalog);
      expect(typeof evidence.ports.awaitIndexed).toBe('function');
    } finally {
      await evidence.close();
    }
  });

  it('closes the runtime exactly once', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-evidence-'));
    const evidence = await openOperatorEvidence({ rootDir });
    await evidence.close();
    await expect(evidence.close()).resolves.toBeUndefined();
  });
});
