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

  it('has no TaskEngine', () => {
    expect(existsSync(join(root, 'harnesses/engine/engine.ts'))).toBe(false);
    expect(existsSync(join(root, 'harnesses/engine/recovery.ts'))).toBe(false);
  });

  it('keeps task_runs readable for the API until stage 5', () => {
    expect(existsSync(join(root, 'harnesses/engine/persistence.ts'))).toBe(true);
  });

  it('starts no engine loops', () => {
    const source = readFileSync(join(root, 'daemon/daemon.ts'), 'utf8');
    expect(source).not.toMatch(/TaskEngine|runTickLoop|_runEngineWatcherLoop|recoverInFlight/);
  });
});
