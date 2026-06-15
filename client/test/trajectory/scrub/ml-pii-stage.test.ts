import { describe, expect, test } from 'vitest';
import { mlPiiStage, type PiiDetector } from '../../../src/trajectory/scrub/ml-pii-stage.js';
import type { KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';

const policy: KeyPolicy = { safe: ['llm.model'], drop: [] };

// Deterministic stand-in for the real Transformers.js NER detector: returns the
// entity label + matched text (no offsets, mirroring the real pipeline output).
const fakeDetector: PiiDetector = {
  async detect(text: string) {
    const out: Array<{ label: string; text: string }> = [];
    if (text.includes('Alice Johnson')) out.push({ label: 'PER', text: 'Alice Johnson' });
    if (text.includes('London')) out.push({ label: 'LOC', text: 'London' });
    return out;
  },
};

describe('mlPiiStage', () => {
  test('redacts detected entities with [PII:<label>] and records pii redactions', async () => {
    const stage = mlPiiStage(policy, fakeDetector);
    const result = await stage.scrub({
      'tool.output': 'Alice Johnson lives in London',
      'llm.model': 'London', // safe key — not scrubbed
    });

    expect(result.attributes['tool.output']).toBe('[PII:PER] lives in [PII:LOC]');
    expect(result.attributes['llm.model']).toBe('London');
    expect(result.redactions).toEqual([
      { key: 'tool.output', stage: 'ml-pii', kind: 'pii', detail: 'PER' },
      { key: 'tool.output', stage: 'ml-pii', kind: 'pii', detail: 'LOC' },
    ]);
  });

  test('only replaces whole-word matches (does not corrupt substrings)', async () => {
    const stage = mlPiiStage(policy, fakeDetector);
    const result = await stage.scrub({ 'tool.output': 'A Londoner visited London' });
    // "Londoner" must survive; only the standalone "London" is redacted
    expect(result.attributes['tool.output']).toBe('A Londoner visited [PII:LOC]');
  });

  test('passes through non-string and entity-free content unchanged', async () => {
    const stage = mlPiiStage(policy, fakeDetector);
    const result = await stage.scrub({ count: 3, note: 'nothing identifying' });
    expect(result.attributes).toEqual({ count: 3, note: 'nothing identifying' });
    expect(result.redactions).toEqual([]);
  });
});
