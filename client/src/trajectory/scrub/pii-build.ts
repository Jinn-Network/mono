import { TransformersPiiDetector } from './transformers-detector.js';
import type { PiiDetector } from './ml-pii-stage.js';

export interface PiiDetectionConfig {
  enabled: boolean;
  /** Optional Transformers.js NER model id (defaults to Xenova/bert-base-NER). */
  model?: string;
}

/**
 * Builds the ML PII detector (Transformers.js NER, in-process) when enabled,
 * warming up the model.
 *
 * - Disabled (the default): returns `undefined` — the scrub pipeline runs the
 *   structural key policy + openredaction + secretlint/entropy stages only, with
 *   no ML PII tier and no error.
 * - Enabled but the model fails to load: **fails closed** by rethrowing. The
 *   spec's failure posture (`spec/2026-06-15-ts-trajectory-scrub-stack.md`,
 *   §"Failure posture") requires that if a stage errors or the model fails to
 *   load, the trajectory is not published. An operator who explicitly turned ML
 *   PII on must not silently degrade to a weaker scrub — that would publish
 *   under-redacted traces while believing NER was running.
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
    const message = err instanceof Error ? err.message : String(err);
    log(
      '[scrub] ML PII detection is enabled but the model failed to load; failing closed ' +
        `(no trajectories will publish until this is resolved or piiDetection is disabled): ${message}`,
    );
    throw err instanceof Error ? err : new Error(message);
  }
}
