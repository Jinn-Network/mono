import type { RestorationJob } from '../types/desired-state.js';

/** Returns a freshly-built RestorationJob for this tick, or null to skip. */
export type IntentGenerator = () => Promise<RestorationJob | null>;

export type IntentPostingPolicy =
  | { kind: 'once_per_safe' }
  | { kind: 'once_per_bucket'; bucketKey: string }
  | { kind: 'interval'; intervalMs: number; scopeKey?: string };

export interface IntentCandidate {
  restorationJob: RestorationJob;
  sourceKey: string;
  postingPolicy: IntentPostingPolicy;
  /**
   * IPFS CID of the signed intent document, if already uploaded by the caller
   * (e.g. `jinn submit-intent --spec-file`). When present, the posting service
   * uses it to register the intent on the ERC-8004 Identity Registry after a
   * successful on-chain post (best-effort, Plan E).
   */
  intentCid?: string;
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

  constructor(private readonly desiredStates: RestorationJob[]) {}

  async collect(_now: Date): Promise<IntentCandidate[]> {
    return this.desiredStates.map((restorationJob) => ({
      restorationJob,
      sourceKey: `${this.sourceKey}:${restorationJob.id}`,
      postingPolicy: { kind: 'once_per_safe' },
      sourceMeta: { kind: restorationJob.spec?.kind, note: 'configured' },
    }));
  }
}

export class GeneratedIntentSource implements IntentSource {
  constructor(
    readonly sourceKey: string,
    private readonly generator: IntentGenerator,
  ) {}

  async collect(_now: Date): Promise<IntentCandidate[]> {
    const restorationJob = await this.generator();
    if (!restorationJob) return [];
    const bucketKey = restorationJob.window
      ? `${restorationJob.window.startTs}:${restorationJob.window.endTs}`
      : restorationJob.id;
    return [{
      restorationJob,
      sourceKey: this.sourceKey,
      postingPolicy: { kind: 'once_per_bucket', bucketKey },
      sourceMeta: {
        kind: restorationJob.spec?.kind,
        bucketKey,
        note: 'generated',
      },
    }];
  }
}
