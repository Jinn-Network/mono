import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod/v3';
import {
  REQUIRES_LIVE_DAEMON_READINESS,
  SkippableError,
} from '../src/index.js';
import type {
  Task,
  Solution,
} from '../src/index.js';
import type {
  Harness,
  HarnessContext,
  ExternalHarnessEnv,
  ExternalHarnessFactory,
  JinnManifest,
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
} from '../src/harness.js';
import {
  SolverNetManifestV1Schema,
  validateSolverNetManifest,
  zodToJsonSchema,
  jsonSchemaToZod,
} from '../src/solvernets/index.js';
import type {
  SolverNetManifestV1,
  ManifestValidationResult,
  JsonSchema,
} from '../src/solvernets/index.js';
describe('@jinn-network/sdk surface', () => {
  it('root exports generic protocol types', () => {
    const task: Task = { id: 'i', description: 'test', solverType: 'test.v0' };
    const out: Solution = { venueRef: { name: 'x' }, gating: {} };
    expect(task.solverType).toBe('test.v0');
    expect(out.venueRef.name).toBe('x');
  });

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

  it('exposes manifest helpers + JSON Schema converters via @jinn-network/sdk/solvernets', () => {
    // Public exports must be reachable, not undefined, from the solvernets
    // subpath. This guards against a regression where the value-level helpers
    // are only re-exported as types.
    expect(typeof SolverNetManifestV1Schema.safeParse).toBe('function');
    expect(typeof validateSolverNetManifest).toBe('function');
    expect(typeof zodToJsonSchema).toBe('function');
    expect(typeof jsonSchemaToZod).toBe('function');

    // Type-level: the inferred SolverNetManifestV1 carries the v1 marker.
    expectTypeOf<SolverNetManifestV1['schemaVersion']>().toEqualTypeOf<'solvernet.manifest.v1'>();
    expectTypeOf<ManifestValidationResult>().not.toBeAny();

    // JsonSchema is a permissive object alias.
    const schema: JsonSchema = zodToJsonSchema(z.object({ x: z.number() }));
    expect(schema.type).toBe('object');
    const zodBack = jsonSchemaToZod(schema);
    expect(zodBack.safeParse({ x: 1 }).success).toBe(true);
  });

});
