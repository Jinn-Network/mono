import { describe, expect, test } from 'vitest';
import { mlPiiStage, type PiiDetector } from '../../../src/trajectory/scrub/ml-pii-stage.js';
import type { KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';

const policy: KeyPolicy = { safe: ['llm.model'], drop: [] };

// Deterministic stand-in for the real GLiNER detector.
const fakeDetector: PiiDetector = {
  async detect(text: string) {
    const out: Array<{ label: string; text: string; start?: number; end?: number; score?: number }> =
      [];
    if (text.includes('Alice Johnson')) {
      const start = text.indexOf('Alice Johnson');
      out.push({
        label: 'person',
        text: 'Alice Johnson',
        start,
        end: start + 'Alice Johnson'.length,
        score: 0.92,
      });
    }
    if (text.includes('London')) {
      out.push({ label: 'LOC', text: 'London', score: 0.9 });
    }
    return out;
  },
};

describe('mlPiiStage (#1973 offsets + bands)', () => {
  test('redacts high-confidence person names with [NAME] (B3 VERY_HIGH)', async () => {
    const stage = mlPiiStage(policy, fakeDetector);
    const result = await stage.scrub({
      'tool.output': 'Alice Johnson lives in London',
      'llm.model': 'London', // safe key — not scrubbed
    });

    // B3 VERY_HIGH (≥0.85) → redact; B6 LOC is flag-by-policy (text left).
    expect(result.attributes['tool.output']).toBe('[NAME] lives in London');
    expect(result.attributes['llm.model']).toBe('London');
    expect(result.redactions).toEqual([
      { key: 'tool.output', stage: 'ml-pii', kind: 'pii', detail: 'person' },
    ]);
    expect(result.unresolvedFlags?.some((f) => f.class === 'B6')).toBe(true);
  });

  test('uses detector offsets when present; word-search fallback otherwise', async () => {
    const stage = mlPiiStage(policy, fakeDetector);
    const result = await stage.scrub({ 'tool.output': 'A Londoner visited London' });
    // "Londoner" must survive; only the standalone "London" is considered
    expect(String(result.attributes['tool.output'])).toContain('Londoner');
    expect(result.unresolvedFlags?.some((f) => f.span.start > 0)).toBe(true);
  });

  test('passes through non-string and entity-free content unchanged', async () => {
    const stage = mlPiiStage(policy, fakeDetector);
    const result = await stage.scrub({ count: 3, note: 'nothing identifying' });
    expect(result.attributes).toEqual({ count: 3, note: 'nothing identifying' });
    expect(result.redactions).toEqual([]);
  });

  test('mid-band person scores flag rather than redact (B3 HIGH)', async () => {
    const midBand: PiiDetector = {
      async detect(text) {
        if (!text.includes('Bob Smith')) return [];
        const start = text.indexOf('Bob Smith');
        return [
          {
            label: 'person',
            text: 'Bob Smith',
            start,
            end: start + 'Bob Smith'.length,
            score: 0.72,
          },
        ];
      },
    };
    const stage = mlPiiStage(policy, midBand);
    const result = await stage.scrub({ content: 'Ask Bob Smith about the flake.' });
    expect(result.attributes.content).toBe('Ask Bob Smith about the flake.');
    expect(result.unresolvedFlags).toHaveLength(1);
    expect(result.unresolvedFlags![0]!.confidence).toBe('HIGH');
    expect(result.unresolvedFlags![0]!.class).toBe('B3');
  });
});
