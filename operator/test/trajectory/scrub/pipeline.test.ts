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

  // #1378: nested attribute values (e.g. `tool.args` as an object) must go
  // through the same stages as flat string values — string leaves inside
  // objects/arrays are scrubbed under their top-level key's classification.
  test('scrubs string leaves inside nested object/array values (#1378)', async () => {
    const pipeline = new ScrubPipeline([upper]);
    const result = await pipeline.run({
      'tool.args': { path: 'secret', list: ['a', { deep: 'b' }], n: 1, ok: true, none: null },
      'plain': 'flat',
    });

    expect(result.attributes['tool.args']).toEqual({
      path: 'SECRET',
      list: ['A', { deep: 'B' }],
      n: 1,
      ok: true,
      none: null,
    });
    expect(result.attributes['plain']).toBe('FLAT');
  });

  test('a stage-dropped key is dropped before its nested values are walked (#1378)', async () => {
    const pipeline = new ScrubPipeline([dropX]);
    const result = await pipeline.run({ x: { nested: 'gone' }, y: 'keep' });
    expect(result.attributes).toEqual({ y: 'keep' });
  });

  test('exposes stage name+version pairs for local pipeline-profile inspection', () => {
    const pipeline = new ScrubPipeline([upper, dropX]);
    expect(pipeline.components).toEqual([
      { name: 'upper', version: '1' },
      { name: 'dropX', version: '1' },
    ]);
  });
});
