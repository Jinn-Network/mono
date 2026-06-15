import { TransformersPiiDetector } from './transformers-detector.js';
import type { PiiDetector } from './ml-pii-stage.js';

export interface PiiDetectionConfig {
  enabled: boolean;
  /** Optional Transformers.js NER model id (defaults to Xenova/bert-base-NER). */
  model?: string;
}

/**
 * Builds the ML PII detector (Transformers.js NER, in-process) when enabled,
 * warming up the model. Returns `undefined` — degrading the scrub pipeline to
 * secretlint + openredaction + entropy — if disabled OR if the model fails to
 * load, so a model-download failure never breaks publishing.
 */
export async function maybeBuildPiiDetector(
  cfg: PiiDetectionConfig,
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<PiiDetector | undefined> {
  if (!cfg.enabled) return undefined;
  try {
    const detector = new TransformersPiiDetector(cfg.model ? { model: cfg.model } : {});
    await detector.init();
    log('[scrub] ML PII detection (Transformers.js NER) enabled.');
    return detector;
  } catch (err) {
    log(
      '[scrub] ML PII detection unavailable; degrading to secretlint + openredaction: ' +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
