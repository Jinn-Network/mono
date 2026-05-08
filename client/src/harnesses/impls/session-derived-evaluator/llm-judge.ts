import { clampScore, type EvaluationSignal } from './signals.js';

export interface LlmJudgeInput {
  problemStatement: string;
  candidatePatch?: string | null;
  referencePatch?: string | null;
  judge: (input: {
    problemStatement: string;
    candidatePatch?: string | null;
    referencePatch?: string | null;
  }) => Promise<{ score: number; reasoning: string }>;
  weight?: number;
}

export async function llmJudgeSignal(input: LlmJudgeInput): Promise<EvaluationSignal> {
  const weight = input.weight ?? 0.2;
  const judged = await input.judge({
    problemStatement: input.problemStatement,
    candidatePatch: input.candidatePatch,
    referencePatch: input.referencePatch,
  });
  return {
    present: true,
    score: clampScore(judged.score),
    weight,
    reasoning: judged.reasoning,
  };
}
