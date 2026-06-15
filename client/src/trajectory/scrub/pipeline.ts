import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

/**
 * Runs scrub stages in order over a span's attributes: each stage's output
 * attributes feed the next, and redaction records accumulate across the whole
 * chain. Stages may be async (e.g. the ML PII stage). The `components` list
 * (stage name + pinned version) is what the signed provenance manifest records.
 */
export class ScrubPipeline {
  constructor(private readonly stages: ScrubStage[]) {}

  get components(): Array<{ name: string; version: string }> {
    return this.stages.map((s) => ({ name: s.name, version: s.version }));
  }

  async run(attributes: Attributes): Promise<ScrubResult> {
    let current = attributes;
    const redactions: RedactionRecord[] = [];
    for (const stage of this.stages) {
      const result = await stage.scrub(current);
      current = result.attributes;
      redactions.push(...result.redactions);
    }
    return { attributes: current, redactions };
  }
}
