import type { PiiDetector, PiiEntity } from './ml-pii-stage.js';

/** Default Transformers.js-compatible ONNX NER model (person/org/location/misc). */
export const DEFAULT_NER_MODEL = 'Xenova/bert-base-NER';

/**
 * Entity groups treated as PII to redact. Structured PII (emails, cards, SSNs)
 * is handled upstream by openredaction; this tier catches the free-text
 * entities regex can't — names, organizations, places. MISC is excluded (noisy).
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
 * Real ML PII detector — the production implementation of the `PiiDetector`
 * seam. Wraps a Transformers.js token-classification (NER) pipeline running an
 * ONNX model entirely in-process (no Python, no separate process). Loaded lazily
 * (or eagerly via `init()`); the heavy onnxruntime-node dependency is pulled in
 * only when the detector is actually used.
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
      out.push({ label: r.entity_group, text: t });
    }
    return out;
  }
}
