import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  canonicaliseManifest,
  verifyManifestSignature,
} from '../../../src/harnesses/manifest/verify.js';
import type { JinnManifest } from '../../../src/harnesses/manifest/types.js';

ed.hashes.sha512 = (m: Uint8Array) => sha512(m);

function makeManifest(): JinnManifest {
  return {
    schemaVersion: '1.0.0',
    name: '@example/forecaster',
    version: '0.1.0',
    supportedSolverTypes: ['prediction.v0>=1.0.0'],
    entry: './dist/index.js',
    package: {
      cid: 'bafyexample',
      hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const,
    },
    capabilities: {},
    signature: { alg: 'ed25519', publicKey: '', sig: '' },
  };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('verifyManifestSignature', () => {
  it('accepts a manifest signed by a trusted key', async () => {
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const manifest = makeManifest();
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature = {
      alg: 'ed25519',
      publicKey: b64(pk),
      sig: b64(sig),
    };

    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: b64(pk) },
    ]);
    expect(ok).toBe(true);
  });

  it('rejects a manifest signed by an untrusted key', async () => {
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const manifest = makeManifest();
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature = {
      alg: 'ed25519',
      publicKey: b64(pk),
      sig: b64(sig),
    };

    const ok = await verifyManifestSignature(manifest, [
      {
        alg: 'ed25519',
        publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects a manifest whose signature does not match its body', async () => {
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const manifest = makeManifest();
    // Sign over a tampered body, then put the original name back to
    // simulate a body/signature mismatch.
    const tamperedBody = canonicaliseManifest({ ...manifest, name: '@evil/spoof' });
    const sig = await ed.signAsync(new TextEncoder().encode(tamperedBody), sk);
    manifest.signature = {
      alg: 'ed25519',
      publicKey: b64(pk),
      sig: b64(sig),
    };

    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: b64(pk) },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects a non-ed25519 signature alg', async () => {
    const manifest = makeManifest();
    const tampered: JinnManifest = {
      ...manifest,
      signature: {
        alg: 'rsa' as 'ed25519',
        publicKey: 'AAAA',
        sig: 'BBBB',
      },
    };
    const ok = await verifyManifestSignature(tampered, [
      { alg: 'ed25519', publicKey: 'AAAA' },
    ]);
    expect(ok).toBe(false);
  });
});

describe('canonicaliseManifest', () => {
  it('produces stable output regardless of key order', () => {
    const a = makeManifest();
    const b: JinnManifest = {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      ...(JSON.parse(JSON.stringify(a)) as JinnManifest),
    };
    expect(canonicaliseManifest(a)).toBe(canonicaliseManifest(b));
  });

  it('strips the signature field from the canonicalised output', () => {
    const m = makeManifest();
    m.signature = { alg: 'ed25519', publicKey: 'X', sig: 'Y' };
    const out = canonicaliseManifest(m);
    expect(out).not.toContain('"signature"');
    expect(out).not.toContain('"X"');
    expect(out).not.toContain('"Y"');
  });

  it('serialises nested objects (regression: array-form replacer collapsed nested keys)', () => {
    const m = makeManifest();
    const out = canonicaliseManifest(m);
    // RFC 8785 JCS recursively sorts keys at every depth — nested
    // package fields MUST appear in the pre-image. The previous
    // `JSON.stringify(body, Object.keys(body).sort())` filtered keys
    // globally so nested objects collapsed to `{}`; this regression
    // test guards against re-introducing that bug.
    expect(out).toContain('"cid"');
    expect(out).toContain('"hash"');
    expect(out).toContain(m.package.cid);
    expect(out).toContain(m.package.hash);
  });
});

// ---------------------------------------------------------------------------
// Regression: nested-field tampering must invalidate the signature.
// Pre-fix `JSON.stringify(body, Object.keys(body).sort())` filtered keys at
// every depth so `package`, `capabilities`, `author` collapsed to `{}`. A
// signature over the original would still verify against a manifest with a
// mutated `package.hash` / `capabilities.signer.selectors[*]` / `author.url`.
// These tests pin the JCS-canonicalised behaviour.
// ---------------------------------------------------------------------------

describe('verifyManifestSignature — nested tamper detection', () => {
  async function signed(): Promise<{ manifest: JinnManifest; pkB64: string }> {
    const sk = ed.utils.randomSecretKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const m: JinnManifest = {
      ...makeManifest(),
      capabilities: {
        signer: {
          selectors: [
            {
              chainId: 8453,
              to: '0x1111111111111111111111111111111111111111',
              selector: '0xdeadbeef',
            },
          ],
        },
      },
      author: { name: 'example', url: 'https://example.com' },
    };
    const body = canonicaliseManifest(m);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    m.signature = {
      alg: 'ed25519',
      publicKey: b64(pk),
      sig: b64(sig),
    };
    return { manifest: m, pkB64: b64(pk) };
  }

  it('rejects mutation of manifest.package.hash', async () => {
    const { manifest, pkB64 } = await signed();
    manifest.package.hash =
      ('sha256:' + 'f'.repeat(64)) as `sha256:${string}`;
    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: pkB64 },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects mutation of manifest.capabilities.signer.selectors[0].selector', async () => {
    const { manifest, pkB64 } = await signed();
    // Mutate a deeply nested allow-list selector.
    const selectors = manifest.capabilities.signer!.selectors as unknown as Array<{
      selector: `0x${string}`;
    }>;
    selectors[0].selector = '0xcafef00d';
    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: pkB64 },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects mutation of manifest.author.url', async () => {
    const { manifest, pkB64 } = await signed();
    manifest.author = { ...(manifest.author ?? { name: 'x' }), url: 'https://evil.invalid' };
    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: pkB64 },
    ]);
    expect(ok).toBe(false);
  });
});
