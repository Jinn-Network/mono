/**
 * prediction-v1-evaluator — deterministic Brier scorer for Polymarket Tasks.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { SignedEnvelopeSchema, normalizeEnvelopeRole } from '../../../types/envelope.js';
import { PredictionV1TaskSchema } from '../../../types/prediction-v1.js';
import {
  PredictionV1RestorationPayloadSchema,
  type PredictionV1RestorationPayload,
} from '../../../types/payloads/prediction-v1.js';
import { canonicalJson } from '../../../util/canonical-json.js';
import { resolveExpectedSolutionTaskCid, resolveSolutionEnvelopeCid } from '../evaluation-context.js';
import {
  checkManifestSignature,
  checkTaskRef,
  checkTaskRefMissingExpected,
  recomputeTopLevelSignatureHash,
} from '../prediction-v0-evaluator/checks/integrity.js';
import {
  getResolution,
  type ResolutionSnapshot,
} from '../../../venues/polymarket/client.js';

type Check = {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'INDETERMINATE';
  detail?: string | Record<string, unknown>;
};

export interface PredictionV1EvaluatorConfig {
  stub?: boolean;
  gammaBaseUrl?: string;
  clobBaseUrl?: string;
  _testDeps?: {
    getResolution?: typeof getResolution;
  };
}

export class PredictionV1Evaluator implements Harness {
  readonly name = 'prediction-v1-evaluator';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV1EvaluatorConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.v1' && ctx.role === 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (task.solverType !== 'prediction.v1') return { ok: false, reason: 'solverType is not prediction.v1' };
    if (task.role !== 'evaluation') return { ok: false, reason: 'role is not evaluation' };
    if (typeof task.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    if (resolveExpectedSolutionTaskCid(task).kind === 'missing') {
      return { ok: false, reason: 'context.solutionTaskCid required' };
    }
    return { ok: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('prediction-v1-evaluator: stub registry cannot run evaluation (requires live daemon)');
    }
    const task = PredictionV1TaskSchema.parse(ctx.task);
    const ids = task.spec.source.identifiers;
    const checks: Check[] = [];

    const manifestJson = ctx.task.context!['restorationResult'] as string;
    const rawEnvelope = JSON.parse(manifestJson) as Record<string, unknown>;
    const solutionEnvelopeSha256 = createHash('sha256').update(canonicalJson(rawEnvelope)).digest('hex');
    const solutionEnvelopeCid =
      resolveSolutionEnvelopeCid(ctx.task)
      ?? ctx.task.restorationRequestId
      ?? '';

    let solution: PredictionV1RestorationPayload | null = null;
    try {
      const envelope = SignedEnvelopeSchema.parse(rawEnvelope);
      if (
        envelope.solverType !== 'prediction.v1' ||
        normalizeEnvelopeRole(envelope.role) !== 'solution'
      ) {
        checks.push({
          name: 'solution.envelope',
          status: 'FAIL',
          detail: `expected prediction.v1/solution, got ${envelope.solverType}/${envelope.role}`,
        });
      } else {
        checks.push({ name: 'solution.envelope', status: 'PASS' });
      }
      checks.push(await checkManifestSignature(recomputeTopLevelSignatureHash(rawEnvelope), envelope.signature));
      const expectedTaskCid = resolveExpectedSolutionTaskCid(ctx.task);
      if (expectedTaskCid.kind === 'resolved') {
        checks.push(checkTaskRef(envelope.task!.cid, expectedTaskCid.cid));
      } else {
        checks.push(checkTaskRefMissingExpected());
      }
      solution = PredictionV1RestorationPayloadSchema.parse(envelope.payload);
      checks.push({ name: 'solution.schema', status: 'PASS' });
    } catch (err) {
      checks.push({
        name: 'solution.schema',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    if (solution) {
      const submittedAt = Date.parse(solution.submittedAt);
      if (Number.isFinite(submittedAt) && submittedAt >= task.window.startTs && submittedAt <= task.window.endTs) {
        checks.push({ name: 'solution.window', status: 'PASS' });
      } else {
        checks.push({
          name: 'solution.window',
          status: 'FAIL',
          detail: { submittedAt: solution.submittedAt, window: task.window },
        });
      }
    }

    const resolution = await this.readResolution(ids.marketId, ids.conditionId, task.spec.source.url);
    checks.push(checkResolutionIdentity(resolution, ids));
    if (resolution.status === 'resolved') {
      checks.push({ name: 'market.resolution', status: 'PASS' });
    } else if (resolution.status === 'unresolved') {
      checks.push({ name: 'market.resolution', status: 'INDETERMINATE' });
    } else {
      checks.push({ name: 'market.resolution', status: 'FAIL', detail: resolution.status });
    }
    const verdict = deriveVerdict(checks, resolution);
    const scores = verdict === 'SCORED' && solution && resolution.outcome
      ? scoreBrier(solution.probabilityYes, task.spec.consensusSnapshot.probabilityYes, resolution.outcome)
      : undefined;

    const payload: Record<string, unknown> = {
      verdict,
      ...(resolution.outcome ? { outcome: resolution.outcome } : verdict === 'INVALID' ? { outcome: 'INVALID' } : {}),
      ...(resolution.resolvedAt ? { resolvedAt: resolution.resolvedAt } : {}),
      resolutionSource: {
        venue: 'polymarket',
        url: resolution.sourceUrl,
        marketId: ids.marketId,
        conditionId: ids.conditionId,
      },
      task: {
        cid: ctx.taskCid ?? '',
        id: task.id,
      },
      solutionEnvelope: {
        cid: solutionEnvelopeCid,
        sha256: solutionEnvelopeSha256,
      },
      ...(solution
        ? {
            claimed: {
              probabilityYes: solution.probabilityYes,
              submittedAt: solution.submittedAt,
              modelId: solution.modelId,
            },
          }
        : {}),
      benchmark: {
        probabilityYes: task.spec.consensusSnapshot.probabilityYes,
        sampledAt: task.spec.consensusSnapshot.sampledAt,
        method: task.spec.consensusSnapshot.method,
      },
      ...(scores ? { scores } : {}),
      checks,
    };

    writeFileSync(join(ctx.workingDir, 'prediction-v1-verdict.json'), JSON.stringify(payload, null, 2));

    return {
      venueRef: { name: 'polymarket' },
      gating: {
        verdict,
        outcome: resolution.outcome ?? resolution.status,
        ...(scores ?? {}),
      },
      informational: {
        resolution,
      },
      verdictPayload: payload,
      artifacts: [
        {
          path: 'prediction-v1-verdict.json',
          artifactType: 'prediction_v1_verdict',
          metadata: { verdict, ...(scores ?? {}) },
          access: { priceUsdc: '0' },
        },
      ],
    };
  }

  private async readResolution(
    marketId: string,
    conditionId: string,
    sourceUrl: string,
  ): Promise<ResolutionSnapshot> {
    const read = this.config._testDeps?.getResolution ?? getResolution;
    return read({
      marketId,
      conditionId,
      sourceUrl,
      ...(this.config.gammaBaseUrl ? { gammaBaseUrl: this.config.gammaBaseUrl } : {}),
      ...(this.config.clobBaseUrl ? { clobBaseUrl: this.config.clobBaseUrl } : {}),
    });
  }
}

function deriveVerdict(checks: Check[], resolution: ResolutionSnapshot): 'SCORED' | 'REJECTED' | 'INVALID' | 'INDETERMINATE' {
  if (checks.some((check) => check.status === 'FAIL' && check.name !== 'market.resolution')) return 'REJECTED';
  if (checks.some((check) => check.status === 'INDETERMINATE')) return 'INDETERMINATE';
  if (resolution.status === 'resolved' && resolution.outcome) return 'SCORED';
  if (resolution.status === 'unresolved') return 'INDETERMINATE';
  return 'INVALID';
}

function checkResolutionIdentity(
  resolution: ResolutionSnapshot,
  ids: { marketId: string; conditionId: string },
): Check {
  const marketMatches = resolution.marketId === ids.marketId;
  const conditionMatches = resolution.conditionId.toLowerCase() === ids.conditionId.toLowerCase();
  if (marketMatches && conditionMatches) {
    return { name: 'market.identity', status: 'PASS' };
  }
  return {
    name: 'market.identity',
    status: 'FAIL',
    detail: {
      expectedMarketId: ids.marketId,
      actualMarketId: resolution.marketId,
      expectedConditionId: ids.conditionId,
      actualConditionId: resolution.conditionId,
    },
  };
}

function scoreBrier(
  probabilityYes: string,
  consensusProbabilityYes: string,
  outcome: 'YES' | 'NO',
): {
  scoreBasis: 'brier-loss.v1';
  solverBrier: string;
  consensusBrier: string;
  brierSpread: string;
} {
  const target = outcome === 'YES' ? 1 : 0;
  const solver = Number(probabilityYes);
  const consensus = Number(consensusProbabilityYes);
  const solverBrier = (solver - target) ** 2;
  const consensusBrier = (consensus - target) ** 2;
  return {
    scoreBasis: 'brier-loss.v1',
    solverBrier: solverBrier.toFixed(6),
    consensusBrier: consensusBrier.toFixed(6),
    brierSpread: (solverBrier - consensusBrier).toFixed(6),
  };
}

export default PredictionV1Evaluator;
