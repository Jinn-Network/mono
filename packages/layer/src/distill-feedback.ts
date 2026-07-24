import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type DistillFeedbackVerdict = 'helped' | 'hurt' | 'mixed' | 'unused';

export interface DistillFeedbackInput {
  skillName: string;
  verdict: DistillFeedbackVerdict;
  sessionId?: string;
  notes?: string;
  acceptedChanges?: string[];
  recordedAt?: string;
}

export interface DistillFeedbackRecord extends DistillFeedbackInput {
  schema: 'jinn.distill.feedback.v1';
  recordedAt: string;
}

export const DEFAULT_DISTILL_FEEDBACK_PATH = join(homedir(), '.jinn-client', 'harness-layer', 'distill-feedback.jsonl');

export function distillFeedbackPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['JINN_LAYER_DISTILL_FEEDBACK_PATH'] ?? DEFAULT_DISTILL_FEEDBACK_PATH;
}

export function recordDistillFeedback(
  input: DistillFeedbackInput,
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): DistillFeedbackRecord {
  const record: DistillFeedbackRecord = {
    schema: 'jinn.distill.feedback.v1',
    skillName: input.skillName,
    verdict: input.verdict,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.acceptedChanges && input.acceptedChanges.length > 0 ? { acceptedChanges: input.acceptedChanges } : {}),
  };
  const path = opts.path ?? distillFeedbackPathFromEnv(opts.env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function readDistillFeedback(path = DEFAULT_DISTILL_FEEDBACK_PATH): DistillFeedbackRecord[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DistillFeedbackRecord);
}
