import { describe, expect, it } from 'vitest';
import {
  buildLayer2ScrubPipeline,
  buildScrubPipeline,
  buildSeedScrubPipeline,
  shouldRejectPublish,
} from '../src/scrub/index.js';

const FAKE_ADDRESS = `0x${'0'.repeat(40)}`;
const GIT_SHA = 'd'.repeat(40);
const TX_HASH = `0x${'b'.repeat(64)}`;

describe('scrub one-pass inventory (#1969)', () => {
  it('seed / layer2 / trace all stub C1 wallets from the shared inventory', async () => {
    for (const pipeline of [
      buildSeedScrubPipeline(),
      buildLayer2ScrubPipeline(),
      buildScrubPipeline(),
    ]) {
      const result = await pipeline.run({
        content: `Relayer top-up sent to ${FAKE_ADDRESS} on Base.`,
      });
      const out = String(result.attributes.content);
      expect(out).not.toContain(FAKE_ADDRESS);
      expect(out).toMatch(/\[ETH_ADDR_\d+\]/);
      expect(result.redactions.some((r) => r.detail === 'eth-address')).toBe(true);
    }
  });

  it('leaves bare 40-hex git SHA and 0x+64 tx hash intact on every builder', async () => {
    for (const pipeline of [
      buildSeedScrubPipeline(),
      buildLayer2ScrubPipeline(),
      buildScrubPipeline(),
    ]) {
      const result = await pipeline.run({
        content: `Fixed at commit ${GIT_SHA}; anchored in tx ${TX_HASH}.`,
      });
      const out = String(result.attributes.content);
      expect(out).toContain(GIT_SHA);
      expect(out).toContain(TX_HASH);
    }
  });

  it('redacts email (B1) and home path (D1) on the shared inventory', async () => {
    const result = await buildSeedScrubPipeline().run({
      content: 'Contact jane.doe@example-corp.com under /Users/jane/project.',
    });
    const out = String(result.attributes.content);
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('/users/anon');
    expect(out).not.toContain('jane.doe@example-corp.com');
    expect(out).not.toContain('/Users/jane');
  });

  it('exposes the same core detector names; openredaction remains trace-only until #1973', () => {
    const core = ['key-policy', 'plain-patterns', 'git-identity', 'known-identity', 'secretlint'];
    expect(buildSeedScrubPipeline().components.map((c) => c.name)).toEqual(core);
    expect(buildLayer2ScrubPipeline().components.map((c) => c.name)).toEqual(core);
    expect(buildScrubPipeline().components.map((c) => c.name)).toEqual([
      'key-policy',
      'openredaction',
      'plain-patterns',
      'git-identity',
      'known-identity',
      'secretlint',
    ]);
  });

  it('always registers credential-ID shapes (A1) — seed catches bare AKIA without entropy', async () => {
    const akia = 'AKIAIOSFODNN7EXAMPLE';
    const result = await buildSeedScrubPipeline().run({ content: `key=${akia}` });
    expect(String(result.attributes.content)).not.toContain(akia);
    expect(result.redactions.some((r) => r.detail === 'aws-access-key-id')).toBe(true);
  });

  it('shouldRejectPublish is true for check-mode when a non-pass finding was applied', async () => {
    const layer2 = buildLayer2ScrubPipeline();
    const hit = await layer2.run({ content: `fee to ${FAKE_ADDRESS}` });
    expect(shouldRejectPublish(hit)).toBe(true);

    const clean = await layer2.run({ content: 'ordinary technical prose' });
    expect(shouldRejectPublish(clean)).toBe(false);
  });
});
