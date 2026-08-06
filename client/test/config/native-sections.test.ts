import { describe, expect, it } from 'vitest';
import {
  NativeEvaluatorConfigSchema,
  NativeFinalityConfigSchema,
  NativeIdentityStoresConfigSchema,
  NativeTrustPolicyGenesisDigestSchema,
  NativeTrustRootsPathSchema,
} from '../../src/config/native-sections.js';

const DIGEST = `sha256:${'ab'.repeat(32)}` as const;
const OTHER_DIGEST = `sha256:${'cd'.repeat(32)}` as const;

function evaluatorBlock(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deploymentModule: '/opt/jinn/prediction-market-deployment.mjs',
    moduleDigest: DIGEST,
    signerHandle: 'verdict',
    evaluationMethodDigest: OTHER_DIGEST,
    ...extra,
  };
}

describe('dark shape-v2 native sections — evaluator', () => {
  it('accepts a single-digest deployment block', () => {
    const parsed = NativeEvaluatorConfigSchema.parse(evaluatorBlock());
    expect(parsed.evaluationMethodDigest).toBe(OTHER_DIGEST);
    expect(parsed.enabled).toBeUndefined();
    expect(parsed.graderReportSources).toBeUndefined();
  });

  // PR #2463: `evaluationMethodDigest` is `sha256-string | Record<registrationId, sha256-string>`.
  it('accepts a per-registration digest map', () => {
    const parsed = NativeEvaluatorConfigSchema.parse(
      evaluatorBlock({
        evaluationMethodDigest: { prediction: DIGEST, 'swe-rebench': OTHER_DIGEST },
      }),
    );
    expect(parsed.evaluationMethodDigest).toEqual({
      prediction: DIGEST,
      'swe-rebench': OTHER_DIGEST,
    });
  });

  it('accepts deployment-owned grader bindings keyed by registrationId or method URI', () => {
    const parsed = NativeEvaluatorConfigSchema.parse(
      evaluatorBlock({
        graderReportSources: {
          'swe-rebench': 'deployment-owned',
          'https://spec.jinn.network/evaluation-method/swe-rebench': 'deployment-owned',
        },
      }),
    );
    expect(parsed.graderReportSources?.['swe-rebench']).toBe('deployment-owned');
  });

  it('accepts a file: URL deployment module', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse(
        evaluatorBlock({ deploymentModule: 'file:///opt/jinn/deployment.mjs' }),
      ),
    ).not.toThrow();
  });

  it('accepts an explicit enabled flag in either position', () => {
    expect(NativeEvaluatorConfigSchema.parse(evaluatorBlock({ enabled: true })).enabled).toBe(true);
    expect(NativeEvaluatorConfigSchema.parse(evaluatorBlock({ enabled: false })).enabled).toBe(false);
  });

  it('refuses a relative deployment module', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse(evaluatorBlock({ deploymentModule: './deployment.mjs' })),
    ).toThrow();
  });

  it('refuses a non-sha256 module digest', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse(evaluatorBlock({ moduleDigest: '0xdeadbeef' })),
    ).toThrow();
  });

  it('refuses an uppercase-hex digest (canonical form is lowercase)', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse({
        ...evaluatorBlock(),
        evaluationMethodDigest: `sha256:${'AB'.repeat(32)}`,
      }),
    ).toThrow();
  });

  it('refuses a digest map entry that is not a sha256 digest', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse(
        evaluatorBlock({ evaluationMethodDigest: { prediction: 'not-a-digest' } }),
      ),
    ).toThrow();
  });

  // Only the production binding is expressible in a config file: a live host
  // GraderReportSource object cannot cross the spawned-child boundary
  // (#2467 / Finding P0-5-A).
  it('refuses a grader binding other than "deployment-owned"', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse(
        evaluatorBlock({ graderReportSources: { 'swe-rebench': 'host-owned' } }),
      ),
    ).toThrow();
  });

  it('refuses a half-declared deployment (digest without a module)', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse({
        moduleDigest: DIGEST,
        signerHandle: 'verdict',
        evaluationMethodDigest: OTHER_DIGEST,
      }),
    ).toThrow();
  });

  it('refuses an enabled-only block with no deployment', () => {
    expect(() => NativeEvaluatorConfigSchema.parse({ enabled: true })).toThrow();
  });

  it('refuses an unrecognized key (the sub-object is strict)', () => {
    expect(() =>
      NativeEvaluatorConfigSchema.parse(evaluatorBlock({ workspaceRoot: '/tmp/work' })),
    ).toThrow();
  });
});

describe('dark shape-v2 native sections — identityStores', () => {
  it('accepts an empty block (nothing configured)', () => {
    expect(NativeIdentityStoresConfigSchema.parse({})).toEqual({});
  });

  it('accepts the full native role set', () => {
    const parsed = NativeIdentityStoresConfigSchema.parse({
      requester: '/var/lib/jinn/identity/requester.json',
      admission: '/var/lib/jinn/identity/admission.json',
      solver: '/var/lib/jinn/identity/solver.json',
      evaluator: '/var/lib/jinn/identity/evaluator.json',
    });
    expect(parsed.solver).toBe('/var/lib/jinn/identity/solver.json');
  });

  it('refuses a relative store path', () => {
    expect(() => NativeIdentityStoresConfigSchema.parse({ solver: 'identity/solver.json' })).toThrow();
  });

  it('refuses a role outside the native role set', () => {
    expect(() =>
      NativeIdentityStoresConfigSchema.parse({ launcher: '/var/lib/jinn/identity/launcher.json' }),
    ).toThrow();
  });

  // Admission custody is deliberately separate from requester custody; sharing
  // one store collapses two distinct signing authorities onto one key file.
  it('refuses requester and admission sharing one store', () => {
    expect(() =>
      NativeIdentityStoresConfigSchema.parse({
        requester: '/var/lib/jinn/identity/shared.json',
        admission: '/var/lib/jinn/identity/shared.json',
      }),
    ).toThrow();
  });
});

describe('dark shape-v2 native sections — trust roots and finality', () => {
  it('accepts an absolute trust-roots path', () => {
    expect(NativeTrustRootsPathSchema.parse('/var/lib/jinn/trust-roots.json')).toBe(
      '/var/lib/jinn/trust-roots.json',
    );
  });

  it('refuses a relative trust-roots path', () => {
    expect(() => NativeTrustRootsPathSchema.parse('trust-roots.json')).toThrow();
  });

  it('accepts a sha256 trust-policy genesis digest', () => {
    expect(NativeTrustPolicyGenesisDigestSchema.parse(DIGEST)).toBe(DIGEST);
  });

  it('refuses a bare hex trust-policy genesis digest', () => {
    expect(() => NativeTrustPolicyGenesisDigestSchema.parse('ab'.repeat(32))).toThrow();
  });

  it('accepts a positive confirmation depth', () => {
    expect(NativeFinalityConfigSchema.parse({ confirmations: 12 }).confirmations).toBe(12);
  });

  it('refuses a zero, negative, or fractional confirmation depth', () => {
    expect(() => NativeFinalityConfigSchema.parse({ confirmations: 0 })).toThrow();
    expect(() => NativeFinalityConfigSchema.parse({ confirmations: -1 })).toThrow();
    expect(() => NativeFinalityConfigSchema.parse({ confirmations: 1.5 })).toThrow();
  });

  it('refuses an unrecognized finality key (the sub-object is strict)', () => {
    expect(() =>
      NativeFinalityConfigSchema.parse({ confirmations: 12, announceAt: 'safe' }),
    ).toThrow();
  });

  // DR-2026-08-05 decision 8 (mainnet refuse-and-pin): none of these sections
  // name a network, a chainId, or a contract address, so no combination of them
  // can express "native on mainnet". The refusal is the boot gate's job
  // (`assertNativeDeployment`), never a schema-level coupling that could be
  // relaxed into a silent fallback.
  it('carries no network, chain, or contract coupling', () => {
    const shapes = JSON.stringify([
      NativeEvaluatorConfigSchema.parse(evaluatorBlock()),
      NativeIdentityStoresConfigSchema.parse({ solver: '/s.json' }),
      NativeFinalityConfigSchema.parse({ confirmations: 3 }),
    ]);
    for (const forbidden of ['network', 'chainId', 'mainnet', 'taskCoordinator', 'generation']) {
      expect(shapes).not.toContain(forbidden);
    }
  });
});
