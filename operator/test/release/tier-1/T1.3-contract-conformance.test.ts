import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT13ContractConformance } from './T1.3-contract-conformance.js';

describe('T1.3 contract conformance', () => {
  it('passes: fixture StatusV1 payload validates, contractVersion present, openapi.v1.json clean', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.3-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.3.log');
    try {
      const verdict = await runT13ContractConformance({ evidencePath });
      expect(verdict.scenarioId).toBe('T1.3');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.failClass).toBeNull();
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('contract conformance OK');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 30000);
});
