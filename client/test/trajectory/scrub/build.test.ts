import { describe, expect, test } from 'vitest';
import {
  buildScrubPipeline,
  buildSeedScrubPipeline,
} from '../../../src/trajectory/scrub/build.js';

describe('pipeline builders (#1409 / #1970 / #1971 / #1972 / #1973)', () => {
  const ownedCore = [
    'plain-patterns',
    'git-identity',
    'known-identity',
    'url-credentials',
    'reject-classes',
    'checksummed-instruments',
    'ip-address',
    'gitleaks',
    'secretlint',
  ];

  test('default buildScrubPipeline is owned detectors only (openredaction retired)', () => {
    const names = buildScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', ...ownedCore]);
    expect(names).not.toContain('openredaction');
  });

  test('seed pipeline matches the owned inventory (no openredaction)', () => {
    const names = buildSeedScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', ...ownedCore]);
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

  test('owned detectors cover former openredaction structured PII (email, card)', async () => {
    const pipeline = buildScrubPipeline({ failClosedOnUnresolvedFlags: false });
    const result = await pipeline.run({
      content:
        'Email jane.doe@corp.com and card 4111 1111 1111 1111 must not publish raw.',
    });
    const text = String(result.attributes.content);
    expect(text).not.toContain('jane.doe@corp.com');
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('[CARD]');
  });
});
