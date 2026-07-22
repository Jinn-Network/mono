import type { PiiDetector, PiiEntity } from './ml-pii-stage.js';

/**
 * Legacy Transformers.js NER model. Retired as the default ML path in #1973
 * (replaced by GLiNER via {@link GlinerPiiDetector}). Kept for unit tests and
 * explicit opt-in via a custom {@link PiiDetectorFactoryPort}.
 */
export const DEFAULT_NER_MODEL = 'Xenova/bert-base-NER';

/**
 * Entity groups treated as PII. Deterministic detectors own email/card/SSN
 * shapes; this legacy NER tier only covers free-text PER/ORG/LOC. MISC is
 * excluded (noisy).
 */
export const DEFAULT_PII_ENTITY_GROUPS = ['PER', 'ORG', 'LOC'];

export interface TransformersPiiDetectorOptions {
  model?: string;
  /** Minimum NER confidence to redact (0–1). */
  threshold?: number;
  /** Entity groups to treat as PII. */
  entityGroups?: string[];
}

type NerPipeline = (
  text: string,
  opts: { aggregation_strategy: string },
) => Promise<Array<{ entity_group: string; word: string; score: number }>>;

/**
 * Legacy Transformers.js NER detector (bert-base-NER). Not the default path —
 * production uses {@link GlinerPiiDetector}. Retained for tests and explicit
 * factory injection.
 */
export class TransformersPiiDetector implements PiiDetector {
  private pipe: NerPipeline | undefined;
  private initPromise: Promise<NerPipeline> | undefined;
  private readonly model: string;
  private readonly threshold: number;
  private readonly entityGroups: Set<string>;

  constructor(opts: TransformersPiiDetectorOptions = {}) {
    this.model = opts.model ?? DEFAULT_NER_MODEL;
    this.threshold = opts.threshold ?? 0.6;
    this.entityGroups = new Set(opts.entityGroups ?? DEFAULT_PII_ENTITY_GROUPS);
  }

  /** Model id for the policy hash (#1974). */
  get modelId(): string {
    return this.model;
  }

  /** Entity-group label set for the policy hash (#1974). */
  get labelSet(): readonly string[] {
    return [...this.entityGroups].sort((a, b) => a.localeCompare(b));
  }

  /** Eagerly load the model (e.g. at daemon boot) so the first publish isn't slow. */
  async init(): Promise<void> {
    await this.ensureReady();
  }

  private ensureReady(): Promise<NerPipeline> {
    if (this.pipe) return Promise.resolve(this.pipe);
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const pipe = (await pipeline('token-classification', this.model)) as unknown as NerPipeline;
        this.pipe = pipe;
        return pipe;
      })();
    }
    return this.initPromise;
  }

  async detect(text: string): Promise<PiiEntity[]> {
    if (!text.trim()) return [];
    const pipe = await this.ensureReady();
    const results = await pipe(text, { aggregation_strategy: 'simple' });
    const out: PiiEntity[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (r.score < this.threshold) continue;
      if (!this.entityGroups.has(r.entity_group)) continue;
      const t = r.word.trim();
      if (!t) continue;
      const key = `${r.entity_group}:${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: r.entity_group, text: t, score: r.score });
    }
    return out;
  }
}
