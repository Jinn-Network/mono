import {
  GlinerPiiDetector,
  type GlinerPiiDetectorOptions,
  DEFAULT_GLINER_MODEL,
} from './gliner-detector.js';
import type { PiiDetector } from './ml-pii-stage.js';

export interface PiiDetectionConfig {
  /**
   * When true (default for publish lanes), build and warm the GLiNER detector.
   * Explicit `false` disables the ML tier (deterministic detectors only).
   * When enabled, a model-load failure fails closed at publish altitude.
   */
  enabled: boolean;
  /**
   * Optional GLiNER / ONNX model id. Defaults to
   * {@link DEFAULT_GLINER_MODEL} (`urchade/gliner_multi_pii-v1`).
   * Alternate: `knowledgator/gliner-pii-edge-v1.0` (benchmark before switching).
   */
  model?: string;
}

export interface PiiDetectorLoader extends PiiDetector {
  init(): Promise<void>;
}

export interface PiiDetectorFactoryPort {
  create(options: GlinerPiiDetectorOptions): PiiDetectorLoader;
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
 * Builds the ML PII detector (GLiNER ONNX, in-process) when enabled, warming
 * up the model. Default factory is {@link GlinerPiiDetector}; tests inject a
 * mock factory so CI never hits the network.
 *
 * Failure altitude is **publish-time, not boot-time** (per
 * `spec/2026-06-15-ts-trajectory-scrub-stack.md`, §"Failure posture": "if any
 * stage errors or the model fails to load, the trajectory is **not**
 * published"). Three cases:
 *
 * - Disabled (`enabled: false`): returns `undefined` — deterministic inventory
 *   only, no ML PII tier and no error.
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
      return new GlinerPiiDetector(options);
    },
  },
): Promise<PiiDetector | undefined> {
  if (!cfg.enabled) return undefined;
  try {
    const detector = factory.create(
      cfg.model ? { model: cfg.model } : { model: DEFAULT_GLINER_MODEL },
    );
    await detector.init();
    log(
      `[scrub] ML PII detection (GLiNER ONNX, model=${cfg.model ?? DEFAULT_GLINER_MODEL}) enabled.`,
    );
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
