/**
 * GLiNER ONNX ML PII detector (#1973 / design §5.1, §6.3).
 *
 * Local-only inference behind the {@link PiiDetector} seam. Default model is
 * `urchade/gliner_multi_pii-v1` (Apache-2.0, PII-tuned, multilingual). ONNX
 * weights load from the community mirror `onnx-community/gliner_multi_pii-v1`
 * (same weights; Transformers.js-compatible layout).
 *
 * Benchmark note (locked Q3): `urchade/gliner_multi_pii-v1` is the pinned
 * default. The smaller `knowledgator/gliner-pii-edge-v1.0` family remains an
 * alternate via `captures.piiDetection.model` — operators should measure
 * Fβ=2 + latency on their local corpus before switching.
 *
 * Download-on-first-run is intentional (same posture as the retired
 * bert-base-NER path). Init failure is fail-closed via
 * {@link maybeBuildPiiDetector}.
 */

import type { PiiDetector, PiiEntity } from './ml-pii-stage.js';

/**
 * Logical model id operators configure. ONNX weights for the default pin live
 * under the onnx-community mirror (see {@link resolveOnnxModelId}).
 */
export const DEFAULT_GLINER_MODEL = 'urchade/gliner_multi_pii-v1';

/** Alternate smaller pin — set via config `captures.piiDetection.model`. */
export const ALTERNATE_GLINER_EDGE_MODEL = 'knowledgator/gliner-pii-edge-v1.0';

/**
 * Zero-shot labels pinned in config (#1974 will hash these into the policy
 * hash). Keep the list stable and reviewable — do not derive from model
 * metadata at runtime.
 */
export const DEFAULT_GLINER_PII_LABELS: readonly string[] = [
  'person',
  'phone number',
  'email address',
  'street address',
  'credit card number',
  'social security number',
  'organization',
  'username',
  'ip address',
  'date of birth',
];

export interface GlinerPiiDetectorOptions {
  /**
   * Hugging Face model id. Default {@link DEFAULT_GLINER_MODEL}.
   * Pass an onnx-community / knowledgator id to override the pin.
   */
  model?: string;
  /** Zero-shot labels. Defaults to {@link DEFAULT_GLINER_PII_LABELS}. */
  labels?: readonly string[];
  /** Minimum score to emit (pre-band). Default 0.5. */
  threshold?: number;
}

/** Map a logical / source model id onto an ONNX-capable Hugging Face repo. */
export function resolveOnnxModelId(modelId: string): string {
  if (modelId === DEFAULT_GLINER_MODEL || modelId === 'urchade/gliner_multi_pii-v1') {
    return 'onnx-community/gliner_multi_pii-v1';
  }
  // knowledgator edge/base variants often ship ONNX under the same id or an
  // onnx-community mirror; pass through and let fromPretrained fail closed.
  return modelId;
}

type GlinerRuntime = {
  extractEntities(
    text: string,
    labels: readonly string[],
    options?: { threshold?: number },
  ): Promise<
    Array<{ text: string; label: string; start: number; end: number; score: number }>
  >;
};

type GlinerRuntimeModule = {
  GLiNER1ONNXRuntime: {
    fromPretrained(modelId: string): Promise<GlinerRuntime>;
  };
};

/**
 * Production GLiNER PII detector. Loads ONNX weights via `@lmoe/gliner-onnx`
 * (dynamic import so unit tests never pull the runtime). Call {@link init}
 * before {@link detect}; {@link maybeBuildPiiDetector} owns that lifecycle.
 */
export class GlinerPiiDetector implements PiiDetector {
  private runtime: GlinerRuntime | undefined;
  private initPromise: Promise<void> | undefined;
  private readonly model: string;
  private readonly labels: readonly string[];
  private readonly threshold: number;

  constructor(opts: GlinerPiiDetectorOptions = {}) {
    this.model = opts.model ?? DEFAULT_GLINER_MODEL;
    this.labels = opts.labels ?? DEFAULT_GLINER_PII_LABELS;
    this.threshold = opts.threshold ?? 0.5;
  }

  /** Logical model id (hashed into the policy digest — #1974). */
  get modelId(): string {
    return this.model;
  }

  /** Zero-shot labels (hashed into the policy digest — #1974). */
  get labelSet(): readonly string[] {
    return this.labels;
  }

  /** Eagerly load the model (daemon boot / first publish). */
  async init(): Promise<void> {
    await this.ensureReady();
  }

  private ensureReady(): Promise<void> {
    if (this.runtime) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = (async () => {
        let mod: GlinerRuntimeModule;
        try {
          mod = (await import('@lmoe/gliner-onnx')) as unknown as GlinerRuntimeModule;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `GLiNER ONNX runtime unavailable (install @lmoe/gliner-onnx / onnxruntime-node): ${message}`,
          );
        }
        if (!mod.GLiNER1ONNXRuntime?.fromPretrained) {
          throw new Error(
            'GLiNER ONNX runtime loaded but GLiNER1ONNXRuntime.fromPretrained is missing',
          );
        }
        const onnxId = resolveOnnxModelId(this.model);
        this.runtime = await mod.GLiNER1ONNXRuntime.fromPretrained(onnxId);
      })();
    }
    return this.initPromise;
  }

  async detect(text: string): Promise<PiiEntity[]> {
    if (!text.trim()) return [];
    await this.ensureReady();
    const runtime = this.runtime!;
    const entities = await runtime.extractEntities(text, this.labels, {
      threshold: this.threshold,
    });
    const out: PiiEntity[] = [];
    const seen = new Set<string>();
    for (const e of entities) {
      const t = e.text?.trim();
      if (!t) continue;
      const key = `${e.label}:${e.start}:${e.end}:${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        label: e.label,
        text: t,
        start: e.start,
        end: e.end,
        score: e.score,
      });
    }
    return out;
  }
}
