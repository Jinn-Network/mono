import { describe, expect, test } from 'vitest';
import { TransformersPiiDetector } from '../../../src/trajectory/scrub/transformers-detector.js';

// Gated integration test: downloads a real ONNX NER model (~50 MB) and runs
// inference. Skipped unless JINN_TEST_TRANSFORMERS_NER=1, per the repo's
// convention for tests that need heavy external resources.
const gated = process.env.JINN_TEST_TRANSFORMERS_NER === '1' ? describe : describe.skip;

gated('TransformersPiiDetector (real model)', () => {
  test('detects person, organization, and location entities', async () => {
    const detector = new TransformersPiiDetector();
    const entities = await detector.detect('Alice Johnson works at Google in London.');
    const byLabel = new Map(entities.map((e) => [e.label, e.text]));

    expect(byLabel.get('PER')).toContain('Alice');
    expect(byLabel.get('ORG')).toBe('Google');
    expect(byLabel.get('LOC')).toBe('London');
  }, 180_000);

  test('returns nothing for entity-free text', async () => {
    const detector = new TransformersPiiDetector();
    const entities = await detector.detect('the build finished in four hundred milliseconds');
    expect(entities).toEqual([]);
  }, 180_000);
});
