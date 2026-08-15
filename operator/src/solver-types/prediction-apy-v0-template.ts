import {
  PredictionApyV0TaskSchema,
  type PredictionApyV0Task,
} from '../types/prediction-apy.js';

export interface PredictionApyTemplateDeps {
  windowDurationMs?: number;
  resolveGapMs?: number;
}

export const DEFAULT_WINDOW_DURATION_MS = 600_000;
export const DEFAULT_RESOLVE_GAP_MS = 300_000;

export async function resolvePredictionApyV0Template(
  template: unknown,
  deps: PredictionApyTemplateDeps = {},
): Promise<PredictionApyV0Task> {
  if (typeof template !== 'object' || template === null) {
    throw new Error('resolvePredictionApyV0Template: template must be an object');
  }
  const stub = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  const windowMs = deps.windowDurationMs ?? DEFAULT_WINDOW_DURATION_MS;
  const resolveMs = deps.resolveGapMs ?? DEFAULT_RESOLVE_GAP_MS;
  const win = stub['window'] as { startTs?: number; endTs?: number } | undefined;
  if (win && win.startTs === 0) {
    const now = Date.now();
    win.startTs = now;
    win.endTs = now + windowMs;
    const spec = stub['spec'] as { question?: { resolveTs?: number } } | undefined;
    if (spec?.question) spec.question.resolveTs = now + windowMs + resolveMs;
  }
  return PredictionApyV0TaskSchema.parse(stub);
}
