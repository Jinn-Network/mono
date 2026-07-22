import { applyDispositions, assertNoRejectPublish, shouldRejectPublish } from './apply-dispositions.js';
import type { Detector, Finding } from './finding.js';
import { DEFAULT_POLICY, type PolicyTable } from './policy.js';
import {
  UnresolvedFlagError,
  createReviewQueueStore,
  type ReviewQueueStore,
} from './review-queue.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

export { shouldRejectPublish, assertNoRejectPublish };

export interface ScrubPipelineOptions {
  policy?: PolicyTable;
  /** Check-mode: any non-pass disposition rejects (design §6.5). */
  checkMode?: boolean;
  /**
   * Review-queue store for flag resolutions (#1973). Defaults to the
   * operator-local `~/.jinn-client/scrub-review/queue.jsonl` store in
   * redact-mode. Pass an in-memory store in tests.
   */
  reviewStore?: ReviewQueueStore;
  /**
   * When true (default in redact-mode), unresolved flags enqueue + throw
   * {@link UnresolvedFlagError}. Check-mode leaves this off.
   */
  failClosedOnUnresolvedFlags?: boolean;
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
  private readonly reviewStore: ReviewQueueStore | undefined;
  private readonly failClosedOnUnresolvedFlags: boolean;

  constructor(
    detectorsOrStages: Array<Detector | ScrubStage>,
    opts: ScrubPipelineOptions = {},
  ) {
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.checkMode = opts.checkMode ?? false;
    this.reviewStore = opts.reviewStore;
    this.failClosedOnUnresolvedFlags =
      opts.failClosedOnUnresolvedFlags ?? !this.checkMode;
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
    const unresolvedFlags = [...flat.unresolvedFlags];
    let rejected = flat.rejected;
    for (const [key, value] of Object.entries(flat.attributes)) {
      out[key] =
        typeof value === 'string'
          ? value
          : await this.scrubNested(key, value, redactions, findings, unresolvedFlags);
    }
    if (this.checkMode && redactions.length > 0) rejected = true;
    const result: ScrubResult = {
      attributes: out,
      redactions,
      findings,
      rejected,
      unresolvedFlags,
    };
    // Publish altitude: reject-publish classes abort loudly with a class name.
    // Check-mode distill maps redactions → rejection reasons without throwing.
    if (!this.checkMode) assertNoRejectPublish(result, this.policy);
    if (!this.checkMode && this.failClosedOnUnresolvedFlags) {
      this.assertAndEnqueueUnresolvedFlags(result.unresolvedFlags ?? [], attributes);
    }
    return result;
  }

  private assertAndEnqueueUnresolvedFlags(
    unresolved: Finding[],
    attributes: Attributes,
  ): void {
    if (unresolved.length === 0) return;
    // Lazy default: operator-local queue so unattended publishes leave a
    // reviewable trail. Tests inject `reviewStore` (memory) or disable
    // fail-closed via `failClosedOnUnresolvedFlags: false`.
    const store = this.reviewStore ?? createReviewQueueStore();
    const enqueued = store.enqueue(
      unresolved.map((finding) => {
        const value = attributes[finding.span.key];
        const text = typeof value === 'string' ? value : '';
        const snippet = text.slice(
          Math.max(0, finding.span.start - 40),
          Math.min(text.length, finding.span.end + 40),
        );
        return {
          finding,
          context: { attributeKey: finding.span.key, snippet },
        };
      }),
    );
    throw new UnresolvedFlagError(
      unresolved,
      enqueued.map((e) => e.id),
    );
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
    unresolvedFlags: Finding[];
  }> {
    const findings: Finding[] = [];
    for (const detector of this.detectors!) {
      findings.push(...(await detector.detect(attributes)));
    }
    return applyDispositions(attributes, findings, {
      policy: this.policy,
      checkMode: this.checkMode,
      reviewStore: this.reviewStore,
    });
  }

  private async scrubNested(
    key: string,
    value: unknown,
    redactions: RedactionRecord[],
    findings: Finding[],
    unresolvedFlags: Finding[],
  ): Promise<unknown> {
    if (typeof value === 'string') {
      const result = await this.runDetectDispose({ [key]: value });
      redactions.push(...result.redactions);
      findings.push(...result.findings);
      unresolvedFlags.push(...result.unresolvedFlags);
      const scrubbed = result.attributes[key];
      return typeof scrubbed === 'string' ? scrubbed : value;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        items.push(await this.scrubNested(key, item, redactions, findings, unresolvedFlags));
      }
      return items;
    }
    if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        entries[k] = await this.scrubNested(key, v, redactions, findings, unresolvedFlags);
      }
      return entries;
    }
    return value;
  }
}
