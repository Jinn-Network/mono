import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../src');

describe('stage 2 retirement', () => {
  it('has no delivery-watcher module', () => {
    expect(existsSync(join(root, 'daemon/delivery-watcher.ts'))).toBe(false);
  });

  it('has no evaluation-opportunity machinery in the mech adapter', () => {
    const source = readFileSync(join(root, 'adapters/mech/adapter.ts'), 'utf8');
    expect(source).not.toMatch(/evaluationOpportunit|pendingEvaluationSolutions|claimEvaluationWithTerminalPrune/);
  });

  it('leaves exactly one verdict transaction path — the venue-base verdict ports', () => {
    const source = readFileSync(join(root, 'adapters/mech/contracts.ts'), 'utf8');
    expect(source).not.toMatch(/functionName: 'claimEvaluation'/);
  });
});
