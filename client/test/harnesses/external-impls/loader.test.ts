import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { canonicaliseManifest } from '../../../src/harnesses/manifest/index.js';
import { loadExternalImpl } from '../../../src/harnesses/external-impls/loader.js';
import { computePackageHash } from '../../../src/harnesses/external-impls/package-hash.js';

ed.hashes.sha512 = (m: Uint8Array) => sha512(m);

let TMP: string;
let PKG_ROOT: string;
let PUBKEY_B64: string;
let SECRET_KEY: Uint8Array;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'jinn-loader-'));
  PKG_ROOT = join(TMP, 'fake-impl');
  mkdirSync(join(PKG_ROOT, 'dist'), { recursive: true });
  writeFileSync(
    join(PKG_ROOT, 'dist', 'index.js'),
    `export default function createHarness(env) {
      return {
        name: env.implName,
        version: env.implVersion,
        supports: ({ solverType }) => solverType === 'prediction.v0',
        run: async () => ({ venueRef: { name: 'fake' }, gating: {} })
      };
    }`,
  );

  SECRET_KEY = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(SECRET_KEY);
  PUBKEY_B64 = Buffer.from(pk).toString('base64');

  // Compute the real package-content hash now that the entry module is
  // on disk; the loader recomputes and compares (Finding 2).
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
  const body = canonicaliseManifest(manifest);
  const sig = await ed.signAsync(new TextEncoder().encode(body), SECRET_KEY);
  manifest.signature.sig = Buffer.from(sig).toString('base64');
  writeFileSync(
    join(PKG_ROOT, 'jinn.manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function envFor(implName: string) {
  return {
    implName,
    implVersion: '0.1.0',
    network: 'base-sepolia',
    implStateDir: TMP,
    secrets: Object.freeze({}),
    log: () => {},
    stub: false,
  };
}

describe('loadExternalImpl', () => {
  it('loads + constructs an external impl from a signed package', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/harness', entry: PKG_ROOT },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: envFor('@fake/harness'),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.impl.name).toBe('@fake/harness');
      expect(result.impl.supports({ solverType: 'prediction.v0' })).toBe(true);
      expect(result.manifest.version).toBe('0.1.0');
    }
  });

  it('rejects an impl whose signature is not in trustedSigners', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/harness', entry: PKG_ROOT },
      trustedSigners: [
        {
          alg: 'ed25519',
          publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        },
      ],
      env: envFor('@fake/harness'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-trust');
    }
  });

  it('rejects an impl whose declared name mismatches the manifest', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/wrong-name', entry: PKG_ROOT },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: envFor('@fake/wrong-name'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-identity-mismatch');
    }
  });

  it('returns impl-load-failed for a missing package directory', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@nope/x', entry: join(TMP, 'does-not-exist') },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: envFor('@nope/x'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-load-failed');
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — package-content hash verification
// ---------------------------------------------------------------------------

describe('loadExternalImpl — package-hash verification', () => {
  it('rejects a package whose contents do not match manifest.package.hash', async () => {
    const root = join(TMP, 'tampered-impl');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'index.js'),
      `export default (env) => ({ name: env.implName, version: env.implVersion, supports: () => false, run: async () => ({}) });`,
    );
    // Sign a manifest with a hash that does NOT match the package.
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const pkB64 = Buffer.from(pk).toString('base64');
    const manifest = {
      schemaVersion: '1.0.0' as const,
      name: '@tampered/harness',
      version: '0.1.0',
      supportedSolverTypes: ['prediction.v0>=1.0.0'],
      entry: './dist/index.js',
      package: {
        cid: 'bafyfake',
        hash: ('sha256:' + 'f'.repeat(64)) as `sha256:${string}`,
      },
      capabilities: {},
      signature: { alg: 'ed25519' as const, publicKey: pkB64, sig: '' },
    };
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature.sig = Buffer.from(sig).toString('base64');
    writeFileSync(
      join(root, 'jinn.manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    const result = await loadExternalImpl({
      entry: { name: '@tampered/harness', entry: root },
      trustedSigners: [{ alg: 'ed25519', publicKey: pkB64 }],
      env: envFor('@tampered/harness'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-package-hash-mismatch');
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 4a — manifest.entry path traversal
// ---------------------------------------------------------------------------

describe('loadExternalImpl — manifest.entry path traversal', () => {
  it('rejects manifest.entry that escapes the package root', async () => {
    const root = join(TMP, 'escape-impl');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'index.js'),
      `export default (env) => ({ name: env.implName, version: env.implVersion, supports: () => false, run: async () => ({}) });`,
    );
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const pkB64 = Buffer.from(pk).toString('base64');

    const packageHash = computePackageHash(root);
    // The schema regex now rejects `..` so `loadManifest` itself fails
    // first with `impl-load-failed` (schema validation error). Either
    // failure mode is correct: the contract is that the loader does
    // NOT import an arbitrary path on disk.
    const manifest = {
      schemaVersion: '1.0.0' as const,
      name: '@escape/harness',
      version: '0.1.0',
      supportedSolverTypes: ['prediction.v0>=1.0.0'],
      entry: './../../etc/passwd.js',
      package: { cid: 'bafyfake', hash: packageHash },
      capabilities: {},
      signature: { alg: 'ed25519' as const, publicKey: pkB64, sig: '' },
    };
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature.sig = Buffer.from(sig).toString('base64');
    writeFileSync(
      join(root, 'jinn.manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    const result = await loadExternalImpl({
      entry: { name: '@escape/harness', entry: root },
      trustedSigners: [{ alg: 'ed25519', publicKey: pkB64 }],
      env: envFor('@escape/harness'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(['impl-entry-escape', 'impl-load-failed']).toContain(result.reason);
    }
  });

  it('accepts a manifest entry whose filename contains a literal ".." (segment-aware guard)', async () => {
    // Regression for the over-broad `(?!.*\.\.)` lookahead that rejected
    // legitimate filenames like `./dist/foo..bar.js`. The segment-aware
    // lookahead `(?!(?:.*/)?\.\.(?:/|$))` blocks `..` only as a complete
    // path segment, so a filename that contains `..` mid-string is allowed.
    const root = join(TMP, 'mid-dot-impl');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'foo..bar.js'),
      `export default (env) => ({ name: env.implName, version: env.implVersion, supports: ({ solverType }) => solverType === 'prediction.v0', run: async () => ({ venueRef: { name: 'fake' }, gating: {} }) });`,
    );
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const pkB64 = Buffer.from(pk).toString('base64');
    const packageHash = computePackageHash(root);
    const manifest = {
      schemaVersion: '1.0.0' as const,
      name: '@dots/harness',
      version: '0.1.0',
      supportedSolverTypes: ['prediction.v0>=1.0.0'],
      entry: './dist/foo..bar.js',
      package: { cid: 'bafyfake', hash: packageHash },
      capabilities: {},
      signature: { alg: 'ed25519' as const, publicKey: pkB64, sig: '' },
    };
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature.sig = Buffer.from(sig).toString('base64');
    writeFileSync(
      join(root, 'jinn.manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    const result = await loadExternalImpl({
      entry: { name: '@dots/harness', entry: root },
      trustedSigners: [{ alg: 'ed25519', publicKey: pkB64 }],
      env: envFor('@dots/harness'),
    });
    expect(result.kind).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Finding 10 — operator-pinned version mismatch
// ---------------------------------------------------------------------------

describe('loadExternalImpl — pinned version', () => {
  it('rejects a manifest version that does not match entry.version', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/harness', entry: PKG_ROOT, version: '0.0.1' },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: envFor('@fake/harness'),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-version-mismatch');
    }
  });

  it('accepts a manifest when entry.version matches exactly', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/harness', entry: PKG_ROOT, version: '0.1.0' },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: envFor('@fake/harness'),
    });
    expect(result.kind).toBe('ok');
  });
});
