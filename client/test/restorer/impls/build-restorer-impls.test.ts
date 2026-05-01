import { describe, it, expect } from 'vitest';
import { buildRestorerImpls } from '../../../src/restorer/impls/index.js';
import type { RestorerImpl } from '../../../src/restorer/types.js';

const ENV = {
  stub: true as const,
  rpcUrl: 'http://stub',
  claudePath: 'claude',
  claudeModel: 'claude-haiku-4-5-20251001',
};

function makeFake(name: string): RestorerImpl {
  return {
    name,
    version: '0.1.0',
    supports: () => false,
    isReady: async () => ({ ok: true }),
    async run() {
      throw new Error('stub');
    },
  } as unknown as RestorerImpl;
}

describe('buildRestorerImpls — external impls + disabledNames', () => {
  it('appends external impls into the constructed list', () => {
    const fake = makeFake('@example/forecaster');
    const impls = buildRestorerImpls({ ...ENV, externalImpls: [fake] });
    expect(impls.some((i) => i.name === '@example/forecaster')).toBe(true);
  });

  it('omits impls whose name appears in disabledNames', () => {
    const baseline = buildRestorerImpls({ ...ENV });
    const someInRepoName = baseline[0]!.name; // first in-repo impl
    const filtered = buildRestorerImpls({
      ...ENV,
      disabledNames: [someInRepoName],
    });
    expect(filtered.some((i) => i.name === someInRepoName)).toBe(false);
    expect(filtered.length).toBe(baseline.length - 1);
  });

  it('combines: external impls minus disabledNames', () => {
    const fakeA = makeFake('@example/alpha');
    const fakeB = makeFake('@example/beta');
    const impls = buildRestorerImpls({
      ...ENV,
      externalImpls: [fakeA, fakeB],
      disabledNames: ['@example/beta'],
    });
    expect(impls.some((i) => i.name === '@example/alpha')).toBe(true);
    expect(impls.some((i) => i.name === '@example/beta')).toBe(false);
  });

  it('no externalImpls / disabledNames is identical to baseline length', () => {
    const a = buildRestorerImpls({ ...ENV });
    const b = buildRestorerImpls({ ...ENV, externalImpls: [], disabledNames: [] });
    expect(a.length).toBe(b.length);
  });
});
