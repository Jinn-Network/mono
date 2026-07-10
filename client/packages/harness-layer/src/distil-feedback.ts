import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type DistilFeedbackVerdict = 'helped' | 'hurt' | 'mixed' | 'unused';

export interface DistilFeedbackInput {
  skillName: string;
  verdict: DistilFeedbackVerdict;
  sessionId?: string;
  notes?: string;
  acceptedChanges?: string[];
  recordedAt?: string;
}

export interface DistilFeedbackRecord extends DistilFeedbackInput {
  schema: 'jinn.distil.feedback.v1';
  recordedAt: string;
}

export const DEFAULT_DISTIL_FEEDBACK_PATH = join(homedir(), '.jinn-client', 'harness-layer', 'distil-feedback.jsonl');

export function distilFeedbackPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['JINN_LAYER_DISTIL_FEEDBACK_PATH'] ?? DEFAULT_DISTIL_FEEDBACK_PATH;
}

export function recordDistilFeedback(
  input: DistilFeedbackInput,
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {},
): DistilFeedbackRecord {
  const record: DistilFeedbackRecord = {
    schema: 'jinn.distil.feedback.v1',
    skillName: input.skillName,
    verdict: input.verdict,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.acceptedChanges && input.acceptedChanges.length > 0 ? { acceptedChanges: input.acceptedChanges } : {}),
  };
  const path = opts.path ?? distilFeedbackPathFromEnv(opts.env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function readDistilFeedback(path = DEFAULT_DISTIL_FEEDBACK_PATH): DistilFeedbackRecord[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DistilFeedbackRecord);
}
