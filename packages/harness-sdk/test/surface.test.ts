import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  REQUIRES_LIVE_DAEMON_READINESS,
  SkippableError,
} from '../src/index.js';
import type {
  Harness,
  HarnessContext,
  Solution,
  ExternalHarnessEnv,
  ExternalHarnessFactory,
  JinnManifest,
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
} from '../src/index.js';

describe('@jinn-network/harness-sdk surface', () => {
  it('exports REQUIRES_LIVE_DAEMON_READINESS', () => {
    expect(REQUIRES_LIVE_DAEMON_READINESS.ready).toBe(false);
    expect(REQUIRES_LIVE_DAEMON_READINESS.reason).toBe('requires live daemon');
  });

  it('exports SkippableError carrying a reason', () => {
    const e = new SkippableError('claude-cli-missing');
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe('claude-cli-missing');
    expect(e.name).toBe('SkippableError');
  });

  it('Harness is structurally satisfied by a minimal impl', () => {
    const impl: Harness = {
      name: 'test',
      version: '0.0.1',
      supports: ({ solverType }) => solverType === 'test.v0',
      run: async () => ({ venueRef: { name: 'test' }, gating: {} }),
    };
    expect(impl.supports({ solverType: 'test.v0' })).toBe(true);
    expect(impl.supports({ solverType: 'other.v0' })).toBe(false);
  });

  it('ExternalHarnessFactory is callable shape', () => {
    const factory: ExternalHarnessFactory = (env) => ({
      name: env.implName,
      version: env.implVersion,
      supports: ({ solverType }) => solverType === 'test.v0',
      run: async () => ({ venueRef: { name: 'test' }, gating: {} }),
    });
    expectTypeOf(factory).toBeFunction();
    const env: ExternalHarnessEnv = {
      implName: '@x/y',
      implVersion: '0.0.1',
      network: 'base-sepolia',
      implStateDir: '/tmp/x',
      secrets: Object.freeze({}),
      log: () => {},
      stub: false,
    };
    const impl = factory(env);
    expect(impl.name).toBe('@x/y');
  });

  it('JinnManifest type carries signature + capabilities', () => {
    const manifest: JinnManifest = {
      schemaVersion: '1.0.0',
      name: '@x/y',
      version: '0.1.0',
      supportedSolverTypes: ['prediction.v0>=1.0.0'],
      entry: './dist/index.js',
      package: {
        cid: 'bafyabc',
        hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      capabilities: {},
      signature: { alg: 'ed25519', publicKey: '', sig: '' },
    };
    expect(manifest.signature.alg).toBe('ed25519');
  });

  it('ScopedSigner / ScopedRpc / ScopedSecrets are exposed', () => {
    expectTypeOf<ScopedSigner['signTypedData']>().toBeFunction();
    expectTypeOf<ScopedRpc['getChainId']>().toBeFunction();
    expectTypeOf<ScopedSecrets>().toEqualTypeOf<Readonly<Record<string, string>>>();
  });

  it('HarnessContext shape allows optional capability handles', () => {
    const ctx: HarnessContext = {
      task: { id: 'i', description: 'test', solverType: 'test.v0' },
      implStateDir: '/tmp/x',
      workingDir: '/tmp/y',
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 0,
      trajectory: { addSpan: () => ({}) },
    };
    expect(ctx.signer).toBeUndefined();
  });

  it('Solution shape compiles with minimal fields', () => {
    const out: Solution = { venueRef: { name: 'x' }, gating: {} };
    expect(out.venueRef.name).toBe('x');
  });
});
