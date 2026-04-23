import type { DesiredState } from '../types/desired-state.js';

/** Returns a freshly-built DesiredState for this tick, or null to skip. */
export type IntentGenerator = () => Promise<DesiredState | null>;

export type IntentPostingPolicy =
  | { kind: 'once_per_safe' }
  | { kind: 'once_per_bucket'; bucketKey: string }
  | { kind: 'interval'; intervalMs: number; scopeKey?: string };

export interface IntentCandidate {
  desiredState: DesiredState;
  sourceKey: string;
  postingPolicy: IntentPostingPolicy;
  sourceMeta?: {
    kind?: string;
    bucketKey?: string;
    note?: string;
  };
}

export interface IntentSource {
  sourceKey: string;
  collect(now: Date): Promise<IntentCandidate[]>;
}

export class StaticConfiguredIntentSource implements IntentSource {
  readonly sourceKey = 'configured';

  constructor(private readonly desiredStates: DesiredState[]) {}

  async collect(_now: Date): Promise<IntentCandidate[]> {
    return this.desiredStates.map((desiredState) => ({
      desiredState,
      sourceKey: `${this.sourceKey}:${desiredState.id}`,
      postingPolicy: { kind: 'once_per_safe' },
      sourceMeta: { kind: desiredState.spec?.kind, note: 'configured' },
    }));
  }
}

export class GeneratedIntentSource implements IntentSource {
  constructor(
    readonly sourceKey: string,
    private readonly generator: IntentGenerator,
  ) {}

  async collect(_now: Date): Promise<IntentCandidate[]> {
    const desiredState = await this.generator();
    if (!desiredState) return [];
    const bucketKey = desiredState.window
      ? `${desiredState.window.startTs}:${desiredState.window.endTs}`
      : desiredState.id;
    return [{
      desiredState,
      sourceKey: this.sourceKey,
      postingPolicy: { kind: 'once_per_bucket', bucketKey },
      sourceMeta: {
        kind: desiredState.spec?.kind,
        bucketKey,
        note: 'generated',
      },
    }];
  }
}
