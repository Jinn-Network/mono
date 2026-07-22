import { applyDispositions, assertNoRejectPublish, shouldRejectPublish } from './apply-dispositions.js';
import type { Detector, Finding } from './finding.js';
import { DEFAULT_POLICY, type PolicyTable } from './policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

export { shouldRejectPublish, assertNoRejectPublish };

export interface ScrubPipelineOptions {
  policy?: PolicyTable;
  /** Check-mode: any non-pass disposition rejects (design §6.5). */
  checkMode?: boolean;
}

function isDetector(item: Detector | ScrubStage): item is Detector {
  return typeof (item as Detector).detect === 'function';
}

/**
 * Runs one detector inventory, then one disposition pass (#1969).
 *
 * Nested values (#1378): after the flat detect→dispose pass, surviving
 * object/array values are walked and every string leaf is scrubbed through
 * the same detect→dispose path, keyed by the TOP-LEVEL attribute key.
 *
 * Constructor also accepts legacy {@link ScrubStage} arrays (stage.scrub chain)
 * so existing unit tests and injectors keep working through the migration.
 */
export class ScrubPipeline {
  private readonly policy: PolicyTable;
  private readonly checkMode: boolean;
  private readonly detectors: Detector[] | null;
  private readonly stages: ScrubStage[] | null;

  constructor(
    detectorsOrStages: Array<Detector | ScrubStage>,
    opts: ScrubPipelineOptions = {},
  ) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.checkMode = opts.checkMode ?? false;
    if (detectorsOrStages.length > 0 && detectorsOrStages.every(isDetector)) {
      this.detectors = detectorsOrStages;
      this.stages = null;
    } else {
      this.detectors = null;
      this.stages = detectorsOrStages as ScrubStage[];
    }
  }

  get components(): Array<{ name: string; version: string }> {
    const items = this.detectors ?? this.stages ?? [];
    return items.map((d) => ({ name: d.name, version: d.version }));
  }

  async run(attributes: Attributes): Promise<ScrubResult> {
    if (this.stages) {
      return this.runLegacyStages(attributes);
    }
    const flat = await this.runDetectDispose(attributes);
    const out: Attributes = {};
    const redactions = [...flat.redactions];
    const findings = [...flat.findings];
    let rejected = flat.rejected;
    for (const [key, value] of Object.entries(flat.attributes)) {
      out[key] =
        typeof value === 'string' ? value : await this.scrubNested(key, value, redactions, findings);
    }
    if (this.checkMode && redactions.length > 0) rejected = true;
    const result: ScrubResult = { attributes: out, redactions, findings, rejected };
    // Publish altitude: reject-publish classes abort loudly with a class name.
    // Check-mode distill maps redactions → rejection reasons without throwing.
    if (!this.checkMode) assertNoRejectPublish(result, this.policy);
    return result;
  }

  /** Legacy ScrubStage chain (tests / residual injectors). */
  private async runLegacyStages(attributes: Attributes): Promise<ScrubResult> {
    const flat = await this.runStagesFlat(attributes);
    const out: Attributes = {};
    const redactions = [...flat.redactions];
    for (const [key, value] of Object.entries(flat.attributes)) {
      out[key] = typeof value === 'string' ? value : await this.scrubNestedLegacy(key, value, redactions);
    }
    return { attributes: out, redactions };
  }

  private async runStagesFlat(attributes: Attributes): Promise<ScrubResult> {
    let current = attributes;
    const redactions: RedactionRecord[] = [];
    for (const stage of this.stages!) {
      const result = await stage.scrub(current);
      current = result.attributes;
      redactions.push(...result.redactions);
    }
    return { attributes: current, redactions };
  }

  private async scrubNestedLegacy(
    key: string,
    value: unknown,
    redactions: RedactionRecord[],
  ): Promise<unknown> {
    if (typeof value === 'string') {
      const result = await this.runStagesFlat({ [key]: value });
      redactions.push(...result.redactions);
      const scrubbed = result.attributes[key];
      return typeof scrubbed === 'string' ? scrubbed : value;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await this.scrubNestedLegacy(key, item, redactions));
      return items;
    }
    if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        entries[k] = await this.scrubNestedLegacy(key, v, redactions);
      }
      return entries;
    }
    return value;
  }

  private async runDetectDispose(attributes: Attributes): Promise<{
    attributes: Attributes;
    redactions: RedactionRecord[];
    findings: Finding[];
    rejected: boolean;
  }> {
    const findings: Finding[] = [];
    for (const detector of this.detectors!) {
      findings.push(...(await detector.detect(attributes)));
    }
    return applyDispositions(attributes, findings, {
      policy: this.policy,
      checkMode: this.checkMode,
    });
  }

  private async scrubNested(
    key: string,
    value: unknown,
    redactions: RedactionRecord[],
    findings: Finding[],
  ): Promise<unknown> {
    if (typeof value === 'string') {
      const result = await this.runDetectDispose({ [key]: value });
      redactions.push(...result.redactions);
      findings.push(...result.findings);
      const scrubbed = result.attributes[key];
      return typeof scrubbed === 'string' ? scrubbed : value;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await this.scrubNested(key, item, redactions, findings));
      return items;
    }
    if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        entries[k] = await this.scrubNested(key, v, redactions, findings);
      }
      return entries;
    }
    return value;
  }
}
