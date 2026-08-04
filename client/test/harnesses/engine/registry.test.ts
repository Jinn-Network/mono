import { describe, expect, it } from 'vitest';
import { HarnessRegistry } from '../../../src/harnesses/engine/registry.js';
import type { Harness } from '../../../src/harnesses/types.js';

function makeHarness(name: string, solverTypes: string[]): Harness {
  return {
    name,
    version: '1.0.0',
    supports: ({ solverType }) => solverTypes.includes(solverType),
    run: async () => {
      throw new Error('not implemented in test');
    },
  };
}

function stubHarness(name: string, supports: Harness['supports']): Harness {
  return {
    name,
    version: '0.0.0',
    supports,
    run: async () => {
      throw new Error('not used in dispatch tests');
    },
  };
}

describe('HarnessRegistry', () => {
  it('registers and lists harnesses, including disabled harnesses', () => {
    const reg = new HarnessRegistry({ disabled: ['alpha'] });
    reg.register(makeHarness('alpha', ['portfolio.v0']));
    reg.register(makeHarness('beta', ['portfolio.v1']));
    expect(reg.list().map((impl) => impl.name)).toEqual(['alpha', 'beta']);
  });

  it('uses first-match dispatch when no solverTypeHarnesses/default applies', () => {
    const reg = new HarnessRegistry();
    reg.register(makeHarness('alpha', ['portfolio.v0']));
    reg.register(makeHarness('beta', ['portfolio.v0']));
    expect(reg.findFor({ solverType: 'portfolio.v0' })?.name).toBe('alpha');
    expect(reg.findFor({ solverType: 'unknown.v1' })).toBeUndefined();
  });

  it('solverTypeHarnesses wins over registration order when the named harness supports the request', () => {
    const reg = new HarnessRegistry({ solverTypeHarnesses: { 'portfolio.v0': 'beta' } });
    reg.register(makeHarness('alpha', ['portfolio.v0']));
    reg.register(makeHarness('beta', ['portfolio.v0']));
    expect(reg.findFor({ solverType: 'portfolio.v0' })?.name).toBe('beta');
  });

  it('solverTypeHarnesses falls through when the named harness is missing, disabled, or unsupported', () => {
    const missing = new HarnessRegistry({ solverTypeHarnesses: { 'portfolio.v0': 'missing' } });
    missing.register(makeHarness('alpha', ['portfolio.v0']));
    expect(missing.findFor({ solverType: 'portfolio.v0' })?.name).toBe('alpha');

    const disabled = new HarnessRegistry({
      solverTypeHarnesses: { 'portfolio.v0': 'alpha' },
      disabled: ['alpha'],
    });
    disabled.register(makeHarness('alpha', ['portfolio.v0']));
    expect(disabled.findFor({ solverType: 'portfolio.v0' })).toBeUndefined();

    const unsupported = new HarnessRegistry({
      solverTypeHarnesses: { x: 'x-rest' },
      default: 'catch-all',
    });
    unsupported.register(stubHarness('x-rest', ({ solverType, role }) => solverType === 'x' && role !== 'evaluation'));
    unsupported.register(stubHarness('catch-all', () => true));
    expect(unsupported.findFor({ solverType: 'x', role: 'evaluation' })?.name).toBe('catch-all');
  });

  it('uses the configured default before first-match when no explicit solverType mapping applies', () => {
    const reg = new HarnessRegistry({ default: 'beta' });
    reg.register(makeHarness('alpha', ['portfolio.v0']));
    reg.register(makeHarness('beta', ['portfolio.v0', 'portfolio.v1']));
    expect(reg.findFor({ solverType: 'portfolio.v1' })?.name).toBe('beta');
    expect(reg.findFor({ solverType: 'portfolio.v0' })?.name).toBe('beta');
  });

  it('matches legacy learner harness aliases to canonical harness names', () => {
    const reg = new HarnessRegistry({
      solverTypeHarnesses: { 'swe-rebench-v2.v1': 'codex-code-learner' },
      default: 'claude-code-learner',
    });
    reg.register(makeHarness('claude-code', ['prediction.v1']));
    reg.register(makeHarness('codex', ['swe-rebench-v2.v1']));

    expect(reg.findFor({ solverType: 'swe-rebench-v2.v1' })?.name).toBe('codex');
    expect(reg.findFor({ solverType: 'prediction.v1' })?.name).toBe('claude-code');
  });

  it('honors legacy learner aliases in disabled harnesses', () => {
    const reg = new HarnessRegistry({ disabled: ['codex-code-learner'] });
    reg.register(makeHarness('codex', ['swe-rebench-v2.v1']));
    expect(reg.findFor({ solverType: 'swe-rebench-v2.v1' })).toBeUndefined();
  });

  it('falls through from default when default is disabled or unsupported', () => {
    const disabled = new HarnessRegistry({ default: 'beta', disabled: ['beta'] });
    disabled.register(makeHarness('alpha', ['portfolio.v0']));
    disabled.register(makeHarness('beta', ['portfolio.v0']));
    expect(disabled.findFor({ solverType: 'portfolio.v0' })?.name).toBe('alpha');

    const unsupported = new HarnessRegistry({ default: 'beta' });
    unsupported.register(makeHarness('alpha', ['portfolio.v0']));
    unsupported.register(makeHarness('beta', ['portfolio.v1']));
    expect(unsupported.findFor({ solverType: 'portfolio.v0' })?.name).toBe('alpha');
  });

  it('ctx.harnessName wins over solverTypeHarnesses/default when it supports the request (issue #2039)', () => {
    const reg = new HarnessRegistry({
      solverTypeHarnesses: { 'prediction.v1': 'claude-code' },
      default: 'claude-code',
    });
    reg.register(makeHarness('claude-code', ['prediction.v1']));
    reg.register(makeHarness('codex', ['prediction.v1']));

    expect(reg.findFor({ solverType: 'prediction.v1', harnessName: 'codex' })?.name).toBe('codex');
  });

  it('fails closed when ctx.harnessName is missing, disabled, or unsupported', () => {
    const missing = new HarnessRegistry({ solverTypeHarnesses: { 'prediction.v1': 'claude-code' } });
    missing.register(makeHarness('claude-code', ['prediction.v1']));
    expect(missing.findFor({ solverType: 'prediction.v1', harnessName: 'nonexistent' })).toBeUndefined();

    const disabled = new HarnessRegistry({ disabled: ['codex'], default: 'claude-code' });
    disabled.register(makeHarness('claude-code', ['prediction.v1']));
    disabled.register(makeHarness('codex', ['prediction.v1']));
    expect(disabled.findFor({ solverType: 'prediction.v1', harnessName: 'codex' })).toBeUndefined();

    const unsupported = new HarnessRegistry({ default: 'claude-code' });
    unsupported.register(makeHarness('claude-code', ['prediction.v1']));
    unsupported.register(makeHarness('codex', ['swe-rebench-v2.v1']));
    expect(unsupported.findFor({ solverType: 'prediction.v1', harnessName: 'codex' })).toBeUndefined();
  });

  it('matches legacy learner aliases via ctx.harnessName', () => {
    const reg = new HarnessRegistry();
    reg.register(makeHarness('codex', ['swe-rebench-v2.v1']));
    expect(reg.findFor({ solverType: 'swe-rebench-v2.v1', harnessName: 'codex-code-learner' })?.name).toBe('codex');
  });

  it('dispatches restoration and evaluation by role without a universal wrapper', () => {
    const reg = new HarnessRegistry({ solverTypeHarnesses: { x: 'x-rest' } });
    reg.register(stubHarness('x-rest', ({ solverType, role }) => solverType === 'x' && role !== 'evaluation'));
    reg.register(stubHarness('x-eval', ({ solverType, role }) => solverType === 'x' && role === 'evaluation'));

    expect(reg.findFor({ solverType: 'x', role: 'restoration' })?.name).toBe('x-rest');
    expect(reg.findFor({ solverType: 'x' })?.name).toBe('x-rest');
    expect(reg.findFor({ solverType: 'x', role: 'evaluation' })?.name).toBe('x-eval');
  });
});
