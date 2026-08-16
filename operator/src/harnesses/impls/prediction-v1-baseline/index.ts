/**
 * prediction-v1-baseline — deterministic reference forecaster.
 *
 * Uses the Task's posted-time consensus snapshot as the forecast. This is not
 * meant to beat the market; it provides a zero-credential Harness that keeps
 * the prediction.v1 loop executable and testable.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSolutionOutput } from '@jinn-network/sdk/solvernets/prediction-v1';
import type { Harness, HarnessContext, ReadyStatus, Solution } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { Task } from '../../../types/task.js';
import { PredictionV1TaskSchema } from '../../../types/prediction-v1.js';

export interface PredictionV1BaselineConfig {
  stub?: boolean;
}

export class PredictionV1BaselineImpl implements Harness {
  readonly name = 'prediction-v1-baseline';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV1BaselineConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.v1' && ctx.role !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(task: Task): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = PredictionV1TaskSchema.safeParse(task);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.v1 task: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false, reason: 'window already closed' };
    return { ok: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('prediction-v1-baseline: stub registry cannot run (requires live daemon)');
    }
    const parsed = PredictionV1TaskSchema.parse(ctx.task);
    const probabilityYes = parsed.spec.consensusSnapshot.probabilityYes;
    const submittedAt = new Date().toISOString();
    const modelId = 'prediction-v1-baseline/consensus';
    const payload = {
      probabilityYes,
      submittedAt,
      format: 'decimal',
      modelId,
      confidence: 'medium',
      methodology: 'Used the Task posted-time Polymarket consensus snapshot.',
      sourceRefs: [
        {
          title: 'Polymarket market',
          url: parsed.spec.source.url,
        },
      ],
    };

    writeFileSync(join(ctx.workingDir, 'prediction-v1-solution.json'), JSON.stringify(payload, null, 2));

    return buildSolutionOutput({
      solverType: 'prediction.v1',
      venueName: 'polymarket',
      payload,
      gating: {
        probabilityYes,
        submittedAt,
        modelId,
      },
      informational: {
        source: parsed.spec.source,
        consensusSnapshot: parsed.spec.consensusSnapshot,
      },
      artifacts: [
        { path: 'prediction-v1-solution.json', artifactType: 'prediction_v1_solution' },
      ],
    }) as Solution;
  }
}

export default PredictionV1BaselineImpl;
