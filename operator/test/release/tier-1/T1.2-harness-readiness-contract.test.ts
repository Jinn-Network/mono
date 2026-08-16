import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runT12HarnessReadinessContract } from './T1.2-harness-readiness-contract.js';

describe('T1.2 harness-readiness-contract', () => {
  it('returns pass verdict when /v1/harnesses/readiness contract holds', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.2-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.2.log');
    try {
      const verdict = await runT12HarnessReadinessContract({ evidencePath });
      expect(verdict.scenarioId).toBe('T1.2');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.failClass).toBeNull();
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('contract OK');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 90000);
});
