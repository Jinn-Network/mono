import { describe, expect, it } from 'vitest';
import {
  PayloadValidationException,
  assertSolutionPayload,
  buildSolutionOutput,
  buildVerdictOutput,
  getSolverNetContract,
  validateSolutionPayload,
  validateTask,
  validateVerdictPayload,
} from '../src/solvernets/prediction-v1.js';

const baseTask = {
  id: 'polymarket:0xcondition',
  description: 'Forecast whether the event resolves YES.',
  solverType: 'prediction.v1',
  role: 'restoration',
  window: { startTs: Date.parse('2026-05-02T00:00:00.000Z'), endTs: Date.parse('2026-05-02T01:00:00.000Z') },
  claimPolicy: {
    kind: 'parallel',
    maxClaims: 25,
    maxClaimsPerSolver: 1,
    claimWindow: 'task-window',
    selection: 'all-valid-solutions-scored',
    economics: 'testnet-flat',
  },
  spec: {
    question: {
      kind: 'binary',
      text: 'Will the example event happen?',
      yesLabel: 'YES',
      noLabel: 'NO',
    },
    source: {
      type: 'prediction-market',
      venue: 'polymarket',
      url: 'https://polymarket.com/event/example',
      identifiers: {
        marketId: 'market-1',
        conditionId: '0xcondition',
        yesTokenId: 'yes-token',
        noTokenId: 'no-token',
      },
    },
    resolution: {
      expectedResolutionTime: '2026-05-03T00:00:00.000Z',
      rulesText: 'Resolves YES if the event happens.',
      rulesUrl: 'https://polymarket.com/event/example',
    },
    consensusSnapshot: {
      sampledAt: '2026-05-02T00:00:00.000Z',
      probabilityYes: '0.42',
      method: 'best-bid-ask-midpoint',
      bestBidYes: '0.40',
      bestAskYes: '0.44',
      spread: '0.04',
      source: 'polymarket-clob',
    },
    eligibilitySnapshot: {
      sampledAt: '2026-05-02T00:00:00.000Z',
      timeToResolutionHours: 24,
      liquidityUsd: '10000',
      volume24hUsd: '2500',
      orderbookAgeSeconds: 10,
      selectionReason: 'Fixture market meets launch thresholds.',
    },
  },
};

const solutionPayload = {
  probabilityYes: '0.41',
  submittedAt: '2026-05-02T00:10:00.000Z',
  format: 'decimal',
  modelId: 'fixture-model',
  confidence: 'medium',
};

const verdictPayload = {
  verdict: 'SCORED',
  outcome: 'YES',
  resolvedAt: '2026-05-03T00:10:00.000Z',
  resolutionSource: {
    venue: 'polymarket',
    url: 'https://polymarket.com/event/example',
    marketId: 'market-1',
    conditionId: '0xcondition',
  },
  task: {
    cid: 'bafytask',
    id: 'polymarket:0xcondition',
  },
  solutionEnvelope: {
    cid: 'bafysolution',
    sha256: 'a'.repeat(64),
  },
  claimed: {
    probabilityYes: '0.41',
    submittedAt: '2026-05-02T00:10:00.000Z',
    modelId: 'fixture-model',
  },
  benchmark: {
    probabilityYes: '0.42',
    sampledAt: '2026-05-02T00:00:00.000Z',
    method: 'best-bid-ask-midpoint',
  },
  scores: {
    scoreBasis: 'brier-loss.v1',
    solverBrier: '0.3481',
    consensusBrier: '0.3364',
    brierSpread: '0.0117',
  },
  checks: [{ name: 'schema', status: 'PASS' }],
};

describe('payload helpers', () => {
  it('exposes the prediction.v1 SolverNet contract', () => {
    const contract = getSolverNetContract('prediction.v1');
    expect(contract?.solverType).toBe('prediction.v1');
    expect(contract?.evaluationFunction.id).toBe('prediction.brier-loss.v1');
    expect(contract?.aggregationFunction.windowDays).toBe(84);
  });

  it('validates prediction.v1 Task, Solution, and Verdict payloads', () => {
    expect(validateTask('prediction.v1', baseTask).ok).toBe(true);
    expect(validateSolutionPayload('prediction.v1', solutionPayload).ok).toBe(true);
    expect(validateVerdictPayload('prediction.v1', verdictPayload).ok).toBe(true);
  });

  it('returns useful validation failures', () => {
    const invalid = validateSolutionPayload('prediction.v1', {
      ...solutionPayload,
      probabilityYes: '1.5',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('invalid_payload');
      expect(invalid.error.issues.some((issue) => issue.path === 'probabilityYes')).toBe(true);
    }
  });

  it('throws useful assertion errors', () => {
    expect(() => assertSolutionPayload('prediction.v1', { ...solutionPayload, format: 'percent' })).toThrow(
      PayloadValidationException,
    );
  });

  it('fails unknown SolverTypes explicitly', () => {
    const invalid = validateTask('unknown.v0', baseTask);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('unsupported_solver_type');
  });

  it('builds Solution outputs with typed payload fields', () => {
    const out = buildSolutionOutput({
      solverType: 'prediction.v1',
      venueName: 'polymarket',
      payload: solutionPayload,
      gating: { modelId: 'fixture-model' },
    });
    expect(out.solutionPayload).toEqual(solutionPayload);
    expect(out.verdictPayload).toBeUndefined();

    const verdict = buildVerdictOutput({
      solverType: 'prediction.v1',
      payload: verdictPayload,
    });
    expect(verdict.verdictPayload).toEqual(verdictPayload);
    expect(verdict.solutionPayload).toBeUndefined();
  });
});
