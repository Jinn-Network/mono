import { describe, it, expect, vi } from 'vitest';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../../src/harnesses/names.js';
import { HarnessRegistry } from '../../../src/harnesses/engine/registry.js';
import type { Harness } from '../../../src/harnesses/types.js';

const ENV = {
  stub: true as const,
  rpcUrl: 'http://stub',
  claudePath: 'claude',
  claudeModel: 'claude-haiku-4-5-20251001',
};

function makeFake(name: string): Harness {
  return {
    name,
    version: '0.1.0',
    supports: () => false,
    isReady: async () => ({ ok: true }),
    async run() {
      throw new Error('stub');
    },
  } as unknown as Harness;
}

function makeEvaluatorFake(name: string): Harness {
  return {
    name,
    version: '0.0.0-test',
    supports: (ctx: { solverType: string; role?: 'restoration' | 'evaluation' }) =>
      ctx.solverType === 'swe-rebench-v2.v1' && ctx.role === 'evaluation',
    isReady: async () => ({ ok: true }),
    async run() {
      throw new Error('test evaluator fake: run not used');
    },
  } as unknown as Harness;
}

describe('buildHarnesses — external impls + disabledNames', () => {
  it('appends external impls into the constructed list', () => {
    const fake = makeFake('@example/forecaster');
    const impls = buildHarnesses({ ...ENV, externalImpls: [fake] });
    expect(impls.some((i) => i.name === '@example/forecaster')).toBe(true);
  });

  it('omits impls whose name appears in disabledNames', () => {
    const baseline = buildHarnesses({ ...ENV });
    const someInRepoName = baseline[0]!.name; // first in-repo impl
    const filtered = buildHarnesses({
      ...ENV,
      disabledNames: [someInRepoName],
    });
    expect(filtered.some((i) => i.name === someInRepoName)).toBe(false);
    expect(filtered.length).toBe(baseline.length - 1);
  });

  it('combines: external impls minus disabledNames', () => {
    const fakeA = makeFake('@example/alpha');
    const fakeB = makeFake('@example/beta');
    const impls = buildHarnesses({
      ...ENV,
      externalImpls: [fakeA, fakeB],
      disabledNames: ['@example/beta'],
    });
    expect(impls.some((i) => i.name === '@example/alpha')).toBe(true);
    expect(impls.some((i) => i.name === '@example/beta')).toBe(false);
  });

  it('no externalImpls / disabledNames is identical to baseline length', () => {
    const a = buildHarnesses({ ...ENV });
    const b = buildHarnesses({ ...ENV, externalImpls: [], disabledNames: [] });
    expect(a.length).toBe(b.length);
  });

  it('registers codex as an explicit peer without moving the default Claude Code harness', () => {
    // C6: `learnerRouting` is forwarded to both LearnerHarness instances, so the
    // codex peer claims the same explicit allowlist the claude-code default does.
    // Before explicit routing (product design §10) this assertion passed on the
    // retired wrap-every-SolverType default and proved nothing about forwarding.
    const impls = buildHarnesses({
      ...ENV,
      learnerRouting: { solverTypes: ['swe-rebench-v2.v1'] },
    });
    const learnerIndex = impls.findIndex((impl) => impl.name === CLAUDE_CODE_HARNESS);
    const codexIndex = impls.findIndex((impl) => impl.name === CODEX_HARNESS);

    expect(learnerIndex).toBeGreaterThanOrEqual(0);
    expect(codexIndex).toBeGreaterThan(learnerIndex);
    expect(impls[codexIndex]!.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
    expect(impls[learnerIndex]!.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
  });

  it('leaves both learner instances claiming nothing when no routing is configured', () => {
    // The retired default was "claim every non-evaluation SolverType". An
    // unconfigured learner now claims nothing; `main.ts` supplies the allowlist
    // derived from the operator's joined SolverNets.
    const impls = buildHarnesses({ ...ENV });
    for (const name of [CLAUDE_CODE_HARNESS, CODEX_HARNESS]) {
      const impl = impls.find((candidate) => candidate.name === name);
      expect(impl, `${name} should be registered`).toBeDefined();
      expect(impl!.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(false);
    }
  });

  it('accepts legacy learner names in disabledNames', () => {
    const impls = buildHarnesses({
      ...ENV,
      disabledNames: ['codex-code-learner'],
    });
    expect(impls.some((impl) => impl.name === CODEX_HARNESS)).toBe(false);
    expect(impls.some((impl) => impl.name === CLAUDE_CODE_HARNESS)).toBe(true);
  });

  it('inherits a per-SolverNet semantic runtime resolver without choosing a provider', () => {
    const semanticEvaluatorRunnerResolver = {
      resolve: vi.fn().mockReturnValue(undefined),
    };
    const impls = buildHarnesses({
      ...ENV,
      semanticEvaluatorRunnerResolver,
    });
    const evaluator = impls.find((impl) => impl.name === 'jinn-repo-evaluator');
    expect((evaluator as unknown as {
      semanticAgentRunnerResolver?: unknown;
    }).semanticAgentRunnerResolver).toBe(semanticEvaluatorRunnerResolver);
  });

  it('wires the production immutable verifier into the exact-head evaluator', () => {
    const immutableMechanicalVerifier = {
      verify: vi.fn(),
    };
    const impls = buildHarnesses({
      ...ENV,
      immutableMechanicalVerifier,
    });
    const evaluator = impls.find((impl) => impl.name === 'jinn-repo-evaluator');
    const mechanicalRunner = (evaluator as unknown as {
      mechanicalRunner: { immutableVerifier?: unknown };
    }).mechanicalRunner;
    expect(mechanicalRunner.immutableVerifier).toBe(immutableMechanicalVerifier);
  });
});

describe('buildHarnesses — testHarnessReplacements', () => {
  it('displaces swe-rebench-v2-evaluator at the same index when JINN_TEST_MODE=1', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      const baseline = buildHarnesses({ ...ENV });
      const idx = baseline.findIndex((h) => h.name === 'swe-rebench-v2-evaluator');
      expect(idx).toBeGreaterThanOrEqual(0);

      const fake = makeEvaluatorFake('swe-rebench-v2-evaluator');
      const replaced = buildHarnesses({
        ...ENV,
        testHarnessReplacements: [fake],
      });

      const matches = replaced.filter((h) => h.name === 'swe-rebench-v2-evaluator');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(fake);
      expect(replaced[idx]).toBe(fake);
      expect(fake.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(true);
      expect(replaced.length).toBe(baseline.length);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('HarnessRegistry first-match picks the replacement for swe-rebench-v2 evaluation', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      const fake = makeEvaluatorFake('swe-rebench-v2-evaluator');
      const list = buildHarnesses({
        ...ENV,
        testHarnessReplacements: [fake],
      });
      const registry = new HarnessRegistry({});
      for (const h of list) registry.register(h);
      expect(registry.findFor({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(fake);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('throws when replacements are non-empty and JINN_TEST_MODE is not "1"', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      delete process.env['JINN_TEST_MODE'];
      expect(() =>
        buildHarnesses({
          ...ENV,
          testHarnessReplacements: [makeEvaluatorFake('swe-rebench-v2-evaluator')],
        }),
      ).toThrow(/JINN_TEST_MODE/);

      process.env['JINN_TEST_MODE'] = 'true';
      expect(() =>
        buildHarnesses({
          ...ENV,
          testHarnessReplacements: [makeEvaluatorFake('swe-rebench-v2-evaluator')],
        }),
      ).toThrow(/JINN_TEST_MODE/);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('throws when a replacement name matches no in-repo harness', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      expect(() =>
        buildHarnesses({
          ...ENV,
          testHarnessReplacements: [makeFake('@example/does-not-exist')],
        }),
      ).toThrow(/testHarnessReplacements/);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('omitting testHarnessReplacements leaves baseline names and length unchanged', () => {
    const a = buildHarnesses({ ...ENV });
    const b = buildHarnesses({ ...ENV, testHarnessReplacements: [] });
    expect(a.map((h) => h.name)).toEqual(b.map((h) => h.name));
    expect(a.length).toBe(b.length);
  });

  it('applies replacements before disabledNames (replaced stub can still be disabled)', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      const fake = makeEvaluatorFake('swe-rebench-v2-evaluator');
      const list = buildHarnesses({
        ...ENV,
        testHarnessReplacements: [fake],
        disabledNames: ['swe-rebench-v2-evaluator'],
      });
      expect(list.some((h) => h.name === 'swe-rebench-v2-evaluator')).toBe(false);
      expect(list.includes(fake)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });
});
