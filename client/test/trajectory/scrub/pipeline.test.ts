import { describe, expect, test } from 'vitest';
import { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import type { Attributes, ScrubStage } from '../../../src/trajectory/scrub/types.js';

const upper: ScrubStage = {
  name: 'upper',
  version: '1',
  scrub: (attrs: Attributes) => ({
    attributes: Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [k, typeof v === 'string' ? v.toUpperCase() : v]),
    ),
    redactions: [{ key: 'x', stage: 'upper', kind: 'test' }],
  }),
};

const dropX: ScrubStage = {
  name: 'dropX',
  version: '1',
  scrub: (attrs: Attributes) => {
    const { x, ...rest } = attrs;
    return {
      attributes: rest,
      redactions: x !== undefined ? [{ key: 'x', stage: 'dropX', kind: 'dropped' }] : [],
    };
  },
};

describe('ScrubPipeline', () => {
  test('runs stages in order, threading attributes and accumulating redactions', async () => {
    const pipeline = new ScrubPipeline([upper, dropX]);
    const result = await pipeline.run({ x: 'secret', y: 'keep' });

    expect(result.attributes).toEqual({ y: 'KEEP' });
    expect(result.redactions).toEqual([
      { key: 'x', stage: 'upper', kind: 'test' },
      { key: 'x', stage: 'dropX', kind: 'dropped' },
    ]);
  });

  test('exposes stage name+version pairs for the provenance manifest', () => {
    const pipeline = new ScrubPipeline([upper, dropX]);
    expect(pipeline.components).toEqual([
      { name: 'upper', version: '1' },
      { name: 'dropX', version: '1' },
    ]);
  });
});
