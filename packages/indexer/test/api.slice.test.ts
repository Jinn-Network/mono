/**
 * Tests for the /explorer/slice engine (spec §6 / #611).
 *
 * The route body's pure helpers (`parseSliceParams`, `computeSlice`) live in
 * src/api/slice.ts so they can be tested directly with fixture rows. The Hono
 * route handler in explorer.ts wires the helpers to Drizzle and returns the
 * JSON; that wiring is verified via an integration test in Task 9.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSliceParams,
  computeSlice,
  type SliceParams,
  type SliceInputRow,
} from '../src/api/slice.js';

function row(opts: Partial<SliceInputRow> = {}): SliceInputRow {
  return {
    requestId: '0xfeed',
    operator: '0xabc0',
    createdAtBlock: 100n,
    verdictCode: 1,
    actualPassed: true,
    enrichmentStatus: 'ok',
    mode: 'train',
    harness: 'hermes-agent',
    model: 'claude-haiku-4-5',
    plugins: [],
    ...opts,
  };
}

function urlSearchParams(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe('parseSliceParams', () => {
  it('requires manifestDigest', () => {
    expect(() => parseSliceParams(urlSearchParams(''))).toThrow(/manifestDigest/);
  });

  it('returns defaults when only manifestDigest is provided', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafycid'));
    expect(p).toEqual({
      manifestDigest: 'bafycid',
      group: 'none',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto',
    });
  });

  it('parses group when it is one of the allowed values', () => {
    for (const g of ['none', 'operator', 'harness', 'plugin', 'mode', 'model']) {
      const p = parseSliceParams(urlSearchParams(`manifestDigest=bafy&group=${g}`));
      expect(p.group).toBe(g);
    }
  });

  it('falls back to group=none for unknown group values', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafy&group=banana'));
    expect(p.group).toBe('none');
  });

  it('parses filter[operator] as a comma-separated allow-list', () => {
    const p = parseSliceParams(
      urlSearchParams('manifestDigest=bafy&filter[operator]=0xabc,0xdef'),
    );
    expect(p.filter.operator).toEqual(['0xabc', '0xdef']);
  });

  it('parses multiple filter dimensions', () => {
    const p = parseSliceParams(
      urlSearchParams('manifestDigest=bafy&filter[mode]=train&filter[harness]=hermes-agent'),
    );
    expect(p.filter.mode).toEqual(['train']);
    expect(p.filter.harness).toEqual(['hermes-agent']);
  });

  it('parses includeUnenriched=true from include=raw (URL convention)', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafy&include=raw'));
    expect(p.includeUnenriched).toBe(true);
  });

  it('parses bucket when it is one of the allowed values', () => {
    for (const b of ['auto', 'per-block', 'per-day', 'per-week']) {
      const p = parseSliceParams(urlSearchParams(`manifestDigest=bafy&bucket=${b}`));
      expect(p.bucket).toBe(b);
    }
  });

  it('falls back to bucket=auto for unknown bucket values', () => {
    const p = parseSliceParams(urlSearchParams('manifestDigest=bafy&bucket=fortnight'));
    expect(p.bucket).toBe('auto');
  });
});

describe('computeSlice — group=none', () => {
  const params: SliceParams = {
    manifestDigest: 'bafy',
    group: 'none',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };

  it('returns one series and aggregates KPIs over all rows', () => {
    const rows = [
      row({ requestId: '0x1', actualPassed: true }),
      row({ requestId: '0x2', actualPassed: true }),
      row({ requestId: '0x3', actualPassed: false }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 5 });
    expect(out.series).toHaveLength(1);
    expect(out.series[0].groupValue).toBe(null);
    expect(out.kpis.verdicts).toBe(3);
    expect(out.kpis.verdictsPass).toBe(2);
    expect(out.kpis.resolvedRate).toBeCloseTo(2 / 3);
    expect(out.enrichmentCoverage).toBeCloseTo(3 / 5);
  });

  it('returns rate=null when no verdicts pass the filter', () => {
    const out = computeSlice([], params, { rawVerdictCount: 0 });
    expect(out.kpis.resolvedRate).toBeNull();
    expect(out.series).toHaveLength(1);
    expect(out.series[0].buckets).toEqual([]);
  });

  it('echoes the resolved params back', () => {
    const out = computeSlice([row()], params, { rawVerdictCount: 1 });
    expect(out.params).toEqual(params);
  });
});

describe('computeSlice — group=mode', () => {
  const params: SliceParams = {
    manifestDigest: 'bafy',
    group: 'mode',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };

  it('returns one series per distinct mode', () => {
    const rows = [
      row({ requestId: '0x1', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', mode: 'train', actualPassed: false }),
      row({ requestId: '0x3', mode: 'frozen', actualPassed: true }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 3 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['frozen', 'train']);
    const train = out.series.find((s) => s.groupValue === 'train')!;
    const frozen = out.series.find((s) => s.groupValue === 'frozen')!;
    expect(train.kpis.verdicts).toBe(2);
    expect(train.kpis.verdictsPass).toBe(1);
    expect(frozen.kpis.verdicts).toBe(1);
    expect(frozen.kpis.verdictsPass).toBe(1);
  });

  it('top-level kpis are sums of series kpis', () => {
    const rows = [
      row({ requestId: '0x1', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', mode: 'frozen', actualPassed: false }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 2 });
    expect(out.kpis.verdicts).toBe(2);
    expect(out.kpis.verdictsPass).toBe(1);
    expect(out.kpis.resolvedRate).toBeCloseTo(0.5);
  });

  it('groups rows with null mode under "(unknown)"', () => {
    const rows = [row({ requestId: '0x1', mode: null, actualPassed: true })];
    const out = computeSlice(rows, params, { rawVerdictCount: 1 });
    expect(out.series.map((s) => s.groupValue)).toEqual(['(unknown)']);
  });
});

describe('computeSlice — group=operator/harness/model', () => {
  const baseParams = {
    manifestDigest: 'bafy',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto' as const,
  };

  it('group=operator produces one series per distinct operator', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xA', actualPassed: false }),
      row({ requestId: '0x3', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(rows, { ...baseParams, group: 'operator' }, { rawVerdictCount: 3 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['0xA', '0xB']);
    const a = out.series.find((s) => s.groupValue === '0xA')!;
    expect(a.kpis.verdicts).toBe(2);
    expect(a.kpis.verdictsPass).toBe(1);
  });

  it('group=harness produces one series per distinct harness', () => {
    const rows = [
      row({ requestId: '0x1', harness: 'hermes-agent', actualPassed: true }),
      row({ requestId: '0x2', harness: 'claude-code', actualPassed: true }),
    ];
    const out = computeSlice(rows, { ...baseParams, group: 'harness' }, { rawVerdictCount: 2 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['claude-code', 'hermes-agent']);
  });

  it('group=model produces one series per distinct model', () => {
    const rows = [
      row({ requestId: '0x1', model: 'haiku-4-5', actualPassed: true }),
      row({ requestId: '0x2', model: 'sonnet-4-7', actualPassed: false }),
    ];
    const out = computeSlice(rows, { ...baseParams, group: 'model' }, { rawVerdictCount: 2 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['haiku-4-5', 'sonnet-4-7']);
  });
});

describe('computeSlice — group=plugin', () => {
  const params: SliceParams = {
    manifestDigest: 'bafy',
    group: 'plugin',
    filter: {},
    includeUnenriched: false,
    bucket: 'auto',
  };

  it('one verdict with two plugins contributes to two series', () => {
    const rows = [
      row({ requestId: '0x1', plugins: ['@a/x@0.1', '@b/y@0.2'], actualPassed: true }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 1 });
    expect(out.series.map((s) => s.groupValue).sort()).toEqual(['@a/x@0.1', '@b/y@0.2']);
    expect(out.series[0].kpis.verdicts).toBe(1);
    expect(out.series[1].kpis.verdicts).toBe(1);
  });

  it('rows with no plugins are dropped (do not appear in any series)', () => {
    const rows = [
      row({ requestId: '0x1', plugins: ['@a/x'], actualPassed: true }),
      row({ requestId: '0x2', plugins: [], actualPassed: false }),
    ];
    const out = computeSlice(rows, params, { rawVerdictCount: 2 });
    expect(out.series.map((s) => s.groupValue)).toEqual(['@a/x']);
  });
});

describe('computeSlice — filters', () => {
  it('filter[operator] drops rows from other operators', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      {
        manifestDigest: 'bafy',
        group: 'none',
        filter: { operator: ['0xA'] },
        includeUnenriched: false,
        bucket: 'auto',
      },
      { rawVerdictCount: 2 },
    );
    expect(out.kpis.verdicts).toBe(1);
    expect(out.kpis.verdictsPass).toBe(1);
  });

  it('filter[mode]=train and filter[operator]=0xA AND together', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xA', mode: 'frozen', actualPassed: true }),
      row({ requestId: '0x3', operator: '0xB', mode: 'train', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      {
        manifestDigest: 'bafy',
        group: 'none',
        filter: { operator: ['0xA'], mode: ['train'] },
        includeUnenriched: false,
        bucket: 'auto',
      },
      { rawVerdictCount: 3 },
    );
    expect(out.kpis.verdicts).toBe(1); // only 0xA + train
  });

  it('empty filter list (e.g. operator: []) is treated as no filter', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      {
        manifestDigest: 'bafy',
        group: 'none',
        filter: { operator: [] },
        includeUnenriched: false,
        bucket: 'auto',
      },
      { rawVerdictCount: 2 },
    );
    expect(out.kpis.verdicts).toBe(2);
  });

  it('enrichmentCoverage reflects pre-filter row count, not post-filter (LIM-1)', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xB', actualPassed: true }),
    ];
    const out = computeSlice(
      rows,
      { manifestDigest: 'bafy', group: 'none', filter: { operator: ['0xA'] }, includeUnenriched: false, bucket: 'auto' },
      { rawVerdictCount: 3 },
    );
    expect(out.enrichmentCoverage).toBeCloseTo(2 / 3); // rows.length/rawVerdictCount
    expect(out.kpis.verdicts).toBe(1); // filter applied to KPIs
  });
});

describe('computeSlice — grouped/aggregated invariant', () => {
  it('summing group=operator series counts equals group=none counts', () => {
    const rows = [
      row({ requestId: '0x1', operator: '0xA', actualPassed: true }),
      row({ requestId: '0x2', operator: '0xA', actualPassed: false }),
      row({ requestId: '0x3', operator: '0xB', actualPassed: true }),
      row({ requestId: '0x4', operator: '0xC', actualPassed: true }),
      row({ requestId: '0x5', operator: '0xC', actualPassed: false }),
    ];
    const baseParams = {
      manifestDigest: 'bafy',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto' as const,
    };

    const none = computeSlice(rows, { ...baseParams, group: 'none' }, { rawVerdictCount: 5 });
    const byOp = computeSlice(rows, { ...baseParams, group: 'operator' }, { rawVerdictCount: 5 });

    const sumVerdicts = byOp.series.reduce((a, s) => a + s.kpis.verdicts, 0);
    const sumVerdictsPass = byOp.series.reduce((a, s) => a + s.kpis.verdictsPass, 0);

    expect(sumVerdicts).toBe(none.kpis.verdicts);
    expect(sumVerdictsPass).toBe(none.kpis.verdictsPass);
  });

  it('summing group=mode series counts equals group=none counts', () => {
    const rows = [
      row({ requestId: '0x1', mode: 'train', actualPassed: true }),
      row({ requestId: '0x2', mode: 'train', actualPassed: false }),
      row({ requestId: '0x3', mode: 'frozen', actualPassed: true }),
    ];
    const baseParams = {
      manifestDigest: 'bafy',
      filter: {},
      includeUnenriched: false,
      bucket: 'auto' as const,
    };

    const none = computeSlice(rows, { ...baseParams, group: 'none' }, { rawVerdictCount: 3 });
    const byMode = computeSlice(rows, { ...baseParams, group: 'mode' }, { rawVerdictCount: 3 });

    const sumVerdicts = byMode.series.reduce((a, s) => a + s.kpis.verdicts, 0);
    expect(sumVerdicts).toBe(none.kpis.verdicts);
  });
});
