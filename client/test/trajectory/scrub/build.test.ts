import { describe, expect, test } from 'vitest';
import {
  buildScrubPipeline,
  buildSeedScrubPipeline,
} from '../../../src/trajectory/scrub/build.js';

describe('pipeline builders (#1409)', () => {
  // Trace-side no-regression pin: the default composition is unchanged.
  test('default buildScrubPipeline composition is key-policy → openredaction → plain-patterns → secretlint', () => {
    const names = buildScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', 'openredaction', 'plain-patterns', 'secretlint']);
  });

  test('seed pipeline drops the probabilistic stages: key-policy → plain-patterns → secretlint', () => {
    const names = buildSeedScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', 'plain-patterns', 'secretlint']);
  });

  // #1415 regression: secretlint pass-1 does not detect bare AWS access-key
  // IDs (the aws rule ships enableIDScanRule: false) or GCP `AIza…` API keys,
  // so with the entropy fallback off the seed profile must catch these
  // deterministic prefix shapes itself.
  test('seed pipeline redacts bare AWS access-key IDs and GCP AIza API keys (#1415)', async () => {
    const pipeline = buildSeedScrubPipeline();
    const result = await pipeline.run({
      'skill.md':
        'Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE then call ?key=AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe',
    });
    const text = String(result.attributes['skill.md']);
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe');
  });

  test('seed pipeline keeps deterministic redaction (email) and skips entropy sweep', async () => {
    const pipeline = buildSeedScrubPipeline();
    const result = await pipeline.run({
      'skill.md': 'Contact alice@example.com about PublicNetworkAccessDisabled quota.',
    });
    const text = String(result.attributes['skill.md']);
    expect(text).not.toContain('alice@example.com'); // plain-patterns still fires
    expect(text).toContain('PublicNetworkAccessDisabled'); // entropy fallback off
  });
});
