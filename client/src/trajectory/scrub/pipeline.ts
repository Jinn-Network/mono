import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

/**
 * Runs scrub stages in order over a span's attributes: each stage's output
 * attributes feed the next, and redaction records accumulate across the whole
 * chain. Stages may be async (e.g. the ML PII stage). The `components` list
 * (stage name + pinned version) is available for local inspection and tests;
 * the current trace-envelope schema does not publish it.
 *
 * Nested values (#1378): the stages themselves operate on flat string values —
 * a non-string attribute value (e.g. `tool.args` captured as an object) used
 * to pass through every stage untouched and publish verbatim, leaking the
 * exact strings the same pipeline redacted out of `tool.result`. `run()` now
 * walks surviving object/array values after the flat pass and scrubs every
 * string leaf through the same stage chain, keyed by the TOP-LEVEL attribute
 * key so the key policy classifies leaves exactly like the flat value
 * (`jinn.*` structural attributes stay raw; `drop` keys are already gone
 * before the walk). Redactions from leaf runs carry the top-level key, so the
 * redaction manifest and capture redaction diff report `tool.args` as the
 * touched field.
 */
export class ScrubPipeline {
  constructor(private readonly stages: ScrubStage[]) {}

  get components(): Array<{ name: string; version: string }> {
    return this.stages.map((s) => ({ name: s.name, version: s.version }));
  }

  async run(attributes: Attributes): Promise<ScrubResult> {
    const flat = await this.runStages(attributes);
    const out: Attributes = {};
    const redactions = [...flat.redactions];
    for (const [key, value] of Object.entries(flat.attributes)) {
      // Flat strings were scrubbed by the pass above; only container values
      // (objects/arrays) still hold unscrubbed string leaves.
      out[key] = typeof value === 'string' ? value : await this.scrubNested(key, value, redactions);
    }
    return { attributes: out, redactions };
  }

  /** One pass of every stage over a flat attribute bag (the original `run`). */
  private async runStages(attributes: Attributes): Promise<ScrubResult> {
    let current = attributes;
    const redactions: RedactionRecord[] = [];
    for (const stage of this.stages) {
      const result = await stage.scrub(current);
      current = result.attributes;
      redactions.push(...result.redactions);
    }
    return { attributes: current, redactions };
  }

  /**
   * Recursively scrub the string leaves of a nested attribute value through
   * the full stage chain, using the top-level attribute key for policy
   * classification. Non-container, non-string values (numbers, booleans,
   * null) and non-plain objects pass through unchanged.
   */
  private async scrubNested(
    key: string,
    value: unknown,
    redactions: RedactionRecord[],
  ): Promise<unknown> {
    if (typeof value === 'string') {
      const result = await this.runStages({ [key]: value });
      redactions.push(...result.redactions);
      const scrubbed = result.attributes[key];
      // Stages only rewrite strings; a `drop`-classified key never reaches
      // here (dropped in the flat pass), so non-string means untouched.
      return typeof scrubbed === 'string' ? scrubbed : value;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await this.scrubNested(key, item, redactions));
      return items;
    }
    if (value !== null && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value; // non-plain: pass through
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        entries[k] = await this.scrubNested(key, v, redactions);
      }
      return entries;
    }
    return value;
  }
}
