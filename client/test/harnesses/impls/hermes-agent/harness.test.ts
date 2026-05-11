// client/test/harnesses/impls/hermes-agent/harness.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { HERMES_AGENT_HARNESS } from '../../../../src/harnesses/names.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

describe('HermesHarness', () => {
  it('reports name = hermes-agent', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.name).toBe(HERMES_AGENT_HARNESS);
    expect(h.name).toBe('hermes-agent');
  });

  it('supports() rejects evaluation role', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('supports() accepts SWE-rebench v2 restoration role', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
  });

  it('supports() rejects non-SWE solver types for v1', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(false);
  });
});
