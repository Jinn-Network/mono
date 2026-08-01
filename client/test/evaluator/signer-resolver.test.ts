import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEvaluatorSignerResolver } from '../../src/evaluator/signer-resolver.js';

describe('evaluator signer resolver', () => {
  it('resolves exactly the declared grant key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-signer-'));
    const keyPath = join(dir, 'evaluator.pem');
    writeFileSync(keyPath, 'PRIVATE-KEY-BYTES');
    const resolver = createEvaluatorSignerResolver({ keyPath, grantKey: 'evaluator-signer' });
    const bytes = await resolver.resolve(
      { attempt: { attemptId: 'urn:uuid:0' } as never, grantKey: 'evaluator-signer', descriptor: {} },
      {},
    );
    expect(new TextDecoder().decode(bytes)).toBe('PRIVATE-KEY-BYTES');
  });

  it('refuses any other grant key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-signer-'));
    const keyPath = join(dir, 'evaluator.pem');
    writeFileSync(keyPath, 'PRIVATE-KEY-BYTES');
    const resolver = createEvaluatorSignerResolver({ keyPath, grantKey: 'evaluator-signer' });
    await expect(resolver.resolve(
      { attempt: { attemptId: 'urn:uuid:0' } as never, grantKey: 'private-grader', descriptor: {} },
      {},
    )).rejects.toThrow(/not a configured secret forward/);
  });
});
