import {
  TransformersPiiDetector,
  type TransformersPiiDetectorOptions,
} from './transformers-detector.js';
import type { PiiDetector } from './ml-pii-stage.js';

export interface PiiDetectionConfig {
  enabled: boolean;
  /** Optional Transformers.js NER model id (defaults to Xenova/bert-base-NER). */
  model?: string;
}

export interface PiiDetectorLoader extends PiiDetector {
  init(): Promise<void>;
}

export interface PiiDetectorFactoryPort {
  create(options: TransformersPiiDetectorOptions): PiiDetectorLoader;
}

/** Thrown by the fail-closed detector on every scrub call when ML PII was enabled but the model never loaded. */
export class MlPiiUnavailableError extends Error {
  constructor(cause: string) {
    super(
      'ML PII detection was enabled but the model failed to load; failing closed — ' +
        `this trajectory is NOT published (disable captures.piiDetection or fix the model to publish): ${cause}`,
    );
    this.name = 'MlPiiUnavailableError';
  }
}

/**
 * A detector that hard-throws on every `detect()` call. Used when ML PII is
 * enabled but the model failed to load: the failure is narrowed to **publish
 * altitude** — the throw propagates through the ML scrub stage and aborts the
 * one publish in flight (capture publish aborts; task-trajectory ref drops to
 * null), so no raw trajectory is ever published. The daemon's other loops
 * (earning, claim, engine, balance-topup) are unaffected because the failure
 * is no longer raised at construction/boot.
 */
function failClosedDetector(cause: string): PiiDetector {
  return {
    detect() {
      return Promise.reject(new MlPiiUnavailableError(cause));
    },
  };
}

/**
 * Builds the ML PII detector (Transformers.js NER, in-process) when enabled,
 * warming up the model.
 *
 * Failure altitude is **publish-time, not boot-time** (per
 * `spec/2026-06-15-ts-trajectory-scrub-stack.md`, §"Failure posture": "if any
 * stage errors or the model fails to load, the trajectory is **not**
 * published"). Three cases:
 *
 * - Disabled (the default): returns `undefined` — the scrub pipeline runs the
 *   structural key policy + openredaction + secretlint/entropy stages only, with
 *   no ML PII tier and no error. Exactly the legacy behaviour.
 * - Enabled and the model loads: returns the real detector.
 * - Enabled but the model fails to load: does NOT throw at construction. Returns
 *   a fail-closed detector that hard-throws on every scrub call, so each affected
 *   publish aborts (fails closed — never publishes under-redacted/raw) while the
 *   rest of the daemon keeps running. A loud one-time boot warning is emitted so
 *   the degraded posture is visible in logs; the per-publish throw carries its own
 *   clear error so aborted publishes are never silent.
 */
export async function maybeBuildPiiDetector(
  cfg: PiiDetectionConfig,
  log: (msg: string) => void = (m) => console.warn(m),
  factory: PiiDetectorFactoryPort = {
    create(options) {
      return new TransformersPiiDetector(options);
    },
  },
): Promise<PiiDetector | undefined> {
  if (!cfg.enabled) return undefined;
  try {
    const detector = factory.create(cfg.model ? { model: cfg.model } : {});
    await detector.init();
    log('[scrub] ML PII detection (Transformers.js NER) enabled.');
    return detector;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      '[scrub] WARNING: ML PII detection is enabled but the model failed to load. ' +
        'Failing closed at publish altitude: trajectory/capture publishing will ABORT ' +
        '(no raw trajectories are published) until this is resolved or captures.piiDetection ' +
        `is disabled. The daemon's other loops continue running. Cause: ${message}`,
    );
    return failClosedDetector(message);
  }
}
