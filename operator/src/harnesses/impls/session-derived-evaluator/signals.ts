export interface EvaluationSignal {
  present: boolean;
  score: number;
  weight: number;
  reasoning?: string;
}

export interface CompositeEvaluation {
  compositeScore: number;
  presentWeight: number;
  signalsPresent: number;
}

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

export function composite(signals: readonly EvaluationSignal[]): CompositeEvaluation {
  const present = signals.filter((signal) => signal.present);
  const presentWeight = present.reduce((sum, signal) => sum + signal.weight, 0);
  if (present.length === 0 || presentWeight <= 0) {
    return { compositeScore: 0, presentWeight: 0, signalsPresent: 0 };
  }
  const compositeScore = present.reduce(
    (sum, signal) => sum + (clampScore(signal.score) * signal.weight) / presentWeight,
    0,
  );
  return { compositeScore, presentWeight, signalsPresent: present.length };
}
