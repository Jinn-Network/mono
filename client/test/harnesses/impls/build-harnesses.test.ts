import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../../src/harnesses/names.js';
import { probeCodexDoctor } from '../../../src/api/codex-doctor-endpoint.js';
import type { Harness } from '../../../src/harnesses/types.js';

vi.mock('../../../src/api/codex-doctor-endpoint.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/api/codex-doctor-endpoint.js')>();
  return {
    ...actual,
    probeCodexDoctor: vi.fn(),
  };
});

const ENV = {
  stub: true as const,
  rpcUrl: 'http://stub',
  claudePath: 'claude',
  claudeModel: 'claude-haiku-4-5-20251001',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    const impls = buildHarnesses({ ...ENV });
    const learnerIndex = impls.findIndex((impl) => impl.name === CLAUDE_CODE_HARNESS);
    const codexIndex = impls.findIndex((impl) => impl.name === CODEX_HARNESS);

    expect(learnerIndex).toBeGreaterThanOrEqual(0);
    expect(codexIndex).toBeGreaterThan(learnerIndex);
    expect(impls[codexIndex]!.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
  });

  it('accepts legacy learner names in disabledNames', () => {
    const impls = buildHarnesses({
      ...ENV,
      disabledNames: ['codex-code-learner'],
    });
    expect(impls.some((impl) => impl.name === CODEX_HARNESS)).toBe(false);
    expect(impls.some((impl) => impl.name === CLAUDE_CODE_HARNESS)).toBe(true);
  });

  it('threads local Codex provider config into the Codex harness readiness', async () => {
    vi.mocked(probeCodexDoctor).mockReturnValue({
      installed: true,
      authenticated: false,
      authStatus: 'not_configured',
      exitCode: 0,
      stdout: 'codex 1.2.3',
      stderr: '',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const impls = buildHarnesses({
      ...ENV,
      codexBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    const codex = impls.find((impl) => impl.name === CODEX_HARNESS);

    expect(codex).toBeDefined();
    await expect(codex!.isReady!({ solverType: 'swe-rebench-v2.v1', role: 'restoration' }))
      .resolves.toEqual({ ready: true });
  });
});
