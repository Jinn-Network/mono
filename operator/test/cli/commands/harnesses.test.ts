/**
 * `jinn harnesses list/add/remove` — config-mutating CLI for operator-supplied
 * external Harness packages.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import harnesses from '../../../src/cli/commands/harnesses.js';
import { canonicaliseManifest } from '../../../src/harnesses/manifest/index.js';
import { computePackageHash } from '../../../src/harnesses/external-impls/package-hash.js';
import { makeCommandCtx } from '@test/cli.js';

const MOCKS = vi.hoisted(() => ({
  buildHarnesses: vi.fn(),
}));

vi.mock('../../../src/harnesses/impls/index.js', () => ({
  buildHarnesses: MOCKS.buildHarnesses,
}));

ed.hashes.sha512 = (m: Uint8Array) => sha512(m);

let TMP: string;
let CONFIG_PATH: string;
let PKG_ROOT: string;
let PUBKEY_B64: string;
let SECRET_KEY: Uint8Array;

beforeEach(async () => {
  MOCKS.buildHarnesses.mockReset();
  TMP = mkdtempSync(join(tmpdir(), 'jinn-harnesses-cli-'));
  CONFIG_PATH = join(TMP, 'config.json');

  // Build a valid signed manifest package on disk so `add` can verify.
  PKG_ROOT = join(TMP, 'fake-impl');
  mkdirSync(join(PKG_ROOT, 'dist'), { recursive: true });
  writeFileSync(
    join(PKG_ROOT, 'dist', 'index.js'),
    'export default function (env) { return { name: env.implName, version: env.implVersion, supports: () => false, run: async () => ({}) }; }',
  );
  SECRET_KEY = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(SECRET_KEY);
  PUBKEY_B64 = Buffer.from(pk).toString('base64');
  // Compute the real package-content hash so `add` accepts it (Finding 2).
  const packageHash = computePackageHash(PKG_ROOT);
  const manifest = {
    schemaVersion: '1.0.0' as const,
    name: '@fake/harness',
    version: '0.1.0',
    supportedSolverTypes: ['prediction.v0>=1.0.0'],
    entry: './dist/index.js',
    package: { cid: 'bafyfake', hash: packageHash },
    capabilities: {},
    signature: { alg: 'ed25519' as const, publicKey: PUBKEY_B64, sig: '' },
  };
  const sig = await ed.signAsync(
    new TextEncoder().encode(canonicaliseManifest(manifest)),
    SECRET_KEY,
  );
  manifest.signature.sig = Buffer.from(sig).toString('base64');
  writeFileSync(
    join(PKG_ROOT, 'jinn.manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
});

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
}

describe('jinn harnesses', () => {
  it('list: emits empty list when no entries configured', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    const made = makeCommandCtx({ argv: ['list', '--config', CONFIG_PATH, '--json'] });
    await harnesses.run(made.ctx);
    const joined = made.writes.join('');
    const parsed = JSON.parse(joined.split('\n').find((l) => l.startsWith('{'))!);
    expect(parsed.entries).toEqual([]);
  });

  it('add: appends an entry to harnesses.externalImpls and registers signer', async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        trustedImplSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      }),
    );
    const made = makeCommandCtx({
      argv: ['add', PKG_ROOT, '--config', CONFIG_PATH, '--json'],
    });
    await harnesses.run(made.ctx);
    const cfg = readConfig();
    const list = (cfg.harnesses as { externalImpls: Array<{ name: string; entry: string }> })
      .externalImpls;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('@fake/harness');
    expect(list[0].entry).toBe(PKG_ROOT);
  });

  it('add: refuses to add when manifest signer is not trusted', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ trustedImplSigners: [] }));
    const made = makeCommandCtx({
      argv: ['add', PKG_ROOT, '--config', CONFIG_PATH, '--json'],
    });
    await harnesses.run(made.ctx);
    expect(made.exits).toContain(1);
    const cfg = readConfig();
    expect(cfg.harnesses).toBeUndefined();
  });

  it('add: refuses when the on-disk package does not match manifest.package.hash (Finding 2)', async () => {
    // Re-publish the manifest with a hash that will never match the
    // actual package contents — the CLI must catch this before mutating
    // config.
    const manifest = {
      schemaVersion: '1.0.0' as const,
      name: '@fake/harness',
      version: '0.1.0',
      supportedSolverTypes: ['prediction.v0>=1.0.0'],
      entry: './dist/index.js',
      package: {
        cid: 'bafyfake',
        hash: ('sha256:' + 'a'.repeat(64)) as `sha256:${string}`,
      },
      capabilities: {},
      signature: { alg: 'ed25519' as const, publicKey: PUBKEY_B64, sig: '' },
    };
    const sig = await ed.signAsync(
      new TextEncoder().encode(canonicaliseManifest(manifest)),
      SECRET_KEY,
    );
    manifest.signature.sig = Buffer.from(sig).toString('base64');
    writeFileSync(
      join(PKG_ROOT, 'jinn.manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        trustedImplSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      }),
    );
    const made = makeCommandCtx({
      argv: ['add', PKG_ROOT, '--config', CONFIG_PATH, '--json'],
    });
    await harnesses.run(made.ctx);
    expect(made.exits).toContain(1);
    const out = made.writes.join('');
    const errLine = out.split('\n').find((l) => l.includes('package_hash_mismatch'));
    expect(errLine).toBeTruthy();
    const cfg = readConfig();
    expect(cfg.harnesses).toBeUndefined();
  });

  it('list: shows the entry after add', async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        trustedImplSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
        harnesses: {
          externalImpls: [{ name: '@fake/harness', entry: PKG_ROOT }],
        },
      }),
    );
    const made = makeCommandCtx({ argv: ['list', '--config', CONFIG_PATH, '--json'] });
    await harnesses.run(made.ctx);
    const out = made.writes.join('');
    const parsed = JSON.parse(out.split('\n').find((l) => l.startsWith('{'))!);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].name).toBe('@fake/harness');
  });

  it('remove: removes the named entry', async () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        harnesses: {
          externalImpls: [
            { name: '@fake/harness', entry: PKG_ROOT },
            { name: '@other/imp', entry: '/tmp/x' },
          ],
        },
      }),
    );
    const made = makeCommandCtx({
      argv: ['remove', '@fake/harness', '--config', CONFIG_PATH, '--json'],
    });
    await harnesses.run(made.ctx);
    const cfg = readConfig();
    const list = (cfg.harnesses as { externalImpls: Array<{ name: string }> }).externalImpls;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('@other/imp');
  });

  it('remove: errors when name is not present', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ harnesses: { externalImpls: [] } }));
    const made = makeCommandCtx({
      argv: ['remove', '@nope/none', '--config', CONFIG_PATH, '--json'],
    });
    await harnesses.run(made.ctx);
    expect(made.exits).toContain(1);
  });

  it('enable: runs a first-party harness onEnable flow without mutating harness selection', async () => {
    const onEnable = vi.fn(async () => ({
      status: 'ready' as const,
      details: { upstreamRepoDir: '/tmp/swe-rebench-v2-evaluator/upstream' },
    }));
    MOCKS.buildHarnesses.mockReturnValue([
      {
        name: 'swe-rebench-v2-evaluator',
        version: '1.0.0',
        supports: () => false,
        run: async () => { throw new Error('not used'); },
        onEnable,
      },
    ]);
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        configShapeVersion: 2,
        executionWiring: [{
          workKind: 'swe-rebench-v2.v1',
          harness: 'codex-code-learner',
          model: 'gpt-5.4-mini',
          plugins: ['bundled:swe-rebench-v2-runtime'],
          credentialRef: 'codex-code-learner-default',
          isolationPolicy: 'process',
          legacyManifestDigest: 'bafyfixture',
        }],
        engine: { implStateDirRoot: join(TMP, 'impl-state') },
      }),
    );

    const made = makeCommandCtx({
      argv: ['enable', 'swe-rebench-v2-evaluator', '--config', CONFIG_PATH, '--json'],
    });
    await harnesses.run(made.ctx);

    expect(MOCKS.buildHarnesses).toHaveBeenCalledWith(expect.objectContaining({
      stub: true,
      implStateDirRoot: join(TMP, 'impl-state'),
    }));
    expect(onEnable).toHaveBeenCalledWith({
      runtimePlugins: [],
      args: {},
    });
    const parsed = JSON.parse(made.writes.join(''));
    expect(parsed).toMatchObject({
      verb: 'harnesses enable',
      name: 'swe-rebench-v2-evaluator',
      enableResult: {
        status: 'ready',
        details: { upstreamRepoDir: '/tmp/swe-rebench-v2-evaluator/upstream' },
      },
    });
    const cfg = readConfig();
    expect((cfg.executionWiring as any)[0].harness).toBe('codex-code-learner');
  });

  it('enable: errors for unknown harness names', async () => {
    MOCKS.buildHarnesses.mockReturnValue([]);
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    const made = makeCommandCtx({
      argv: ['enable', 'missing-harness', '--config', CONFIG_PATH, '--json'],
    });

    await harnesses.run(made.ctx);

    expect(made.exits).toContain(1);
    const parsed = JSON.parse(made.writes.join(''));
    expect(parsed.error.code).toBe('unknown_harness');
  });
});
