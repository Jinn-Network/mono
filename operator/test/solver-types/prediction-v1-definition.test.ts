import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLVER_TYPES } from '../../src/solver-types/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Reproduces the `--spec-file` wrapper `jinn tasks submit` builds around a raw
 * JSON file (`operator/src/cli/commands/tasks.ts`): the raw file's top-level
 * fields, plus `id`/`description`/`solverType`, are merged, and `spec` is
 * replaced by the raw file's own `spec` object, before `parseSpec` sees it.
 */
function simulateSpecFileWrapper(raw: Record<string, unknown>): Record<string, unknown> {
  const solverTypeStr = typeof raw['solverType'] === 'string' ? raw['solverType'] : undefined;
  const rawSpec =
    raw['spec'] && typeof raw['spec'] === 'object' && !Array.isArray(raw['spec'])
      ? (raw['spec'] as Record<string, unknown>)
      : {};
  return {
    id: 'cli-submitted-task',
    description: 'CLI-submitted task',
    ...raw,
    solverType: solverTypeStr,
    spec: rawSpec,
  };
}

describe('prediction.v1 SolverTypeDefinition registration', () => {
  it('is registered in SOLVER_TYPES under "prediction.v1"', () => {
    const def = SOLVER_TYPES['prediction.v1'];
    expect(def).toBeDefined();
    expect(def.solverType).toBe('prediction.v1');
  });

  it('the shipped prediction-v1-task.example.json fixture posts via the --spec-file wrapper (#2314 AC1/AC2)', async () => {
    const fixturePath = join(__dirname, '../../fixtures/prediction-v1-task.example.json');
    const raw = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
    const overlay = await SOLVER_TYPES['prediction.v1'].parseSpec(simulateSpecFileWrapper(raw));

    expect(overlay.spec).toMatchObject({
      question: { kind: 'binary', yesLabel: 'YES', noLabel: 'NO' },
      source: { type: 'prediction-market', venue: 'polymarket' },
      consensusSnapshot: { method: 'best-bid-ask-midpoint', source: 'polymarket-clob' },
    });
    expect(overlay.window!.endTs).toBeGreaterThan(overlay.window!.startTs);
  });

  it('rejects the legacy Chainlink-threshold shape the fixture used to carry (#2314 regression)', async () => {
    const chainlinkShaped = simulateSpecFileWrapper({
      solverType: 'prediction.v1',
      window: { startTs: 0, endTs: 0 },
      spec: {
        oracle: {
          venue: 'chainlink-base-sepolia',
          feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
          feedDescription: 'ETH / USD',
        },
        question: { kind: 'threshold', operator: 'GT', threshold: 'current', resolveTs: 0 },
      },
      eligibility: { maxSubmissionDelayMs: 60000 },
    });
    await expect(SOLVER_TYPES['prediction.v1'].parseSpec(chainlinkShaped)).rejects.toThrow();
  });
});
