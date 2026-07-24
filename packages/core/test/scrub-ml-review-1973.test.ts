import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildScrubPipeline,
  createMemoryReviewQueueStore,
  createReviewQueueStore,
  mlPiiDetector,
  scoreToBand,
  sharedDetectorInventory,
  UnresolvedFlagError,
  DEFAULT_KEY_POLICY,
  DEFAULT_GLINER_MODEL,
  resolveOnnxModelId,
  type PiiDetector,
  ScrubPipeline,
  DEFAULT_POLICY,
} from '../src/scrub/index.js';

describe('scoreToBand (#1973)', () => {
  it('maps scores onto DLP bands', () => {
    expect(scoreToBand(0.9)).toBe('VERY_HIGH');
    expect(scoreToBand(0.85)).toBe('VERY_HIGH');
    expect(scoreToBand(0.7)).toBe('HIGH');
    expect(scoreToBand(0.55)).toBe('MEDIUM');
    expect(scoreToBand(0.4)).toBe('LOW');
    expect(scoreToBand(undefined)).toBe('VERY_HIGH');
  });
});

describe('GLiNER model pin (#1973)', () => {
  it('resolves the urchade pin to the onnx-community mirror', () => {
    expect(DEFAULT_GLINER_MODEL).toBe('urchade/gliner_multi_pii-v1');
    expect(resolveOnnxModelId(DEFAULT_GLINER_MODEL)).toBe(
      'onnx-community/gliner_multi_pii-v1',
    );
  });
});

describe('openredaction retirement (#1973)', () => {
  it('shared inventory never includes openredaction', () => {
    const names = sharedDetectorInventory(DEFAULT_KEY_POLICY).map((d) => d.name);
    expect(names).not.toContain('openredaction');
    expect(buildScrubPipeline().components.map((c) => c.name)).not.toContain('openredaction');
  });
});

describe('review queue (#1973)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('enqueues, lists, and resolves flags on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-review-'));
    dirs.push(dir);
    const store = createReviewQueueStore(join(dir, 'queue.jsonl'));
    const finding = {
      class: 'B3' as const,
      span: { key: 'content', start: 4, end: 13 },
      confidence: 'HIGH' as const,
      evidence: ['ml:person'],
      detector: { name: 'ml-pii', version: '0.3.0' },
    };
    const [item] = store.enqueue([
      { finding, context: { attributeKey: 'content', snippet: 'Ask Bob Smith' } },
    ]);
    expect(item).toBeDefined();
    expect(store.listFlagged({ status: 'pending' })).toHaveLength(1);
    const resolved = store.resolveFlag(item!.id, 'redact-instance');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution?.decision).toBe('redact-instance');
    expect(store.resolutionFor(finding)).toBe('redact-instance');
  });

  it('fail-closes unattended redact-mode when a mid-band name is flagged', async () => {
    const mock: PiiDetector = {
      async detect(text) {
        if (!text.includes('Carol Jones')) return [];
        const start = text.indexOf('Carol Jones');
        return [
          {
            label: 'person',
            text: 'Carol Jones',
            start,
            end: start + 'Carol Jones'.length,
            score: 0.74,
          },
        ];
      },
    };
    const store = createMemoryReviewQueueStore();
    const pipeline = new ScrubPipeline(
      [...sharedDetectorInventory(DEFAULT_KEY_POLICY), mlPiiDetector(DEFAULT_KEY_POLICY, mock)],
      {
        policy: DEFAULT_POLICY,
        checkMode: false,
        reviewStore: store,
        failClosedOnUnresolvedFlags: true,
      },
    );
    await expect(
      pipeline.run({ content: 'Please ping Carol Jones about the outage.' }),
    ).rejects.toBeInstanceOf(UnresolvedFlagError);
    expect(store.listFlagged({ status: 'pending' })).toHaveLength(1);
  });

  it('honors redact-instance resolution on the next scrub', async () => {
    const mock: PiiDetector = {
      async detect(text) {
        if (!text.includes('Carol Jones')) return [];
        const start = text.indexOf('Carol Jones');
        return [
          {
            label: 'person',
            text: 'Carol Jones',
            start,
            end: start + 'Carol Jones'.length,
            score: 0.74,
          },
        ];
      },
    };
    const store = createMemoryReviewQueueStore();
    const detectors = [
      ...sharedDetectorInventory(DEFAULT_KEY_POLICY, { entropyFallback: false }),
      mlPiiDetector(DEFAULT_KEY_POLICY, mock),
    ];
    const pipeline = new ScrubPipeline(detectors, {
      policy: DEFAULT_POLICY,
      checkMode: false,
      reviewStore: store,
      failClosedOnUnresolvedFlags: true,
    });
    try {
      await pipeline.run({ content: 'Please ping Carol Jones about the outage.' });
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvedFlagError);
    }
    const pending = store.listFlagged({ status: 'pending' });
    expect(pending).toHaveLength(1);
    store.resolveFlag(pending[0]!.id, 'redact-instance');

    const second = await pipeline.run({
      content: 'Please ping Carol Jones about the outage.',
    });
    expect(String(second.attributes.content)).toContain('[NAME]');
    expect(String(second.attributes.content)).not.toContain('Carol Jones');
  });

  it('B3 free-prose name with VERY_HIGH score auto-redacts (mock ML)', async () => {
    const mock: PiiDetector = {
      async detect(text) {
        if (!text.includes('Dana Lee')) return [];
        const start = text.indexOf('Dana Lee');
        return [
          {
            label: 'person',
            text: 'Dana Lee',
            start,
            end: start + 'Dana Lee'.length,
            score: 0.91,
          },
        ];
      },
    };
    const pipeline = buildScrubPipeline({
      piiDetector: mock,
      failClosedOnUnresolvedFlags: false,
    });
    const result = await pipeline.run({
      content: 'Dana Lee filed the incident report.',
    });
    expect(String(result.attributes.content)).toBe('[NAME] filed the incident report.');
  });
});
