import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  PAYLOAD_TYPE,
  preAuthenticationEncoding,
  signManifest,
  verifyEnvelope,
} from './sign-profile-manifest.mjs';

const script = resolve(import.meta.dirname, 'sign-profile-manifest.mjs');

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

test('the pre-authentication encoding follows the DSSE specification', () => {
  const pae = preAuthenticationEncoding('http://example.com/t', Buffer.from('hello'));
  assert.equal(pae.toString('utf8'), 'DSSEv1 20 http://example.com/t 5 hello');
});

test('a signed envelope verifies with the matching public key', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const payload = Buffer.from('{"version":1}\n', 'utf8');
  const envelope = signManifest(payload, privateKeyPem, 'jinn-profile-root-2026');
  assert.equal(envelope.payloadType, PAYLOAD_TYPE);
  assert.equal(Buffer.from(envelope.payload, 'base64').toString('utf8'), '{"version":1}\n');
  assert.equal(envelope.signatures[0].keyid, 'jinn-profile-root-2026');
  assert.equal(verifyEnvelope(envelope, publicKeyPem), true);
});

test('a tampered payload fails verification', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const envelope = signManifest(Buffer.from('{"version":1}\n'), privateKeyPem, 'k');
  envelope.payload = Buffer.from('{"version":2}\n').toString('base64');
  assert.equal(verifyEnvelope(envelope, publicKeyPem), false);
});

test('a signature from a different key fails verification', () => {
  const first = keyPair();
  const second = keyPair();
  const envelope = signManifest(Buffer.from('{"version":1}\n'), first.privateKeyPem, 'k');
  assert.equal(verifyEnvelope(envelope, second.publicKeyPem), false);
});

test('the CLI writes a sidecar when a key is present and leaves manifest.json byte-identical', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const root = mkdtempSync(join(tmpdir(), 'jinn-sign-'));
  try {
    const manifest = '{\n  "version": 1\n}\n';
    writeFileSync(join(root, 'manifest.json'), manifest, 'utf8');
    const result = spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, JINN_PROFILE_MANIFEST_SIGNING_KEY: privateKeyPem, JINN_PROFILE_MANIFEST_KEY_ID: 'k1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'manifest.json'), 'utf8'), manifest);
    const envelope = JSON.parse(readFileSync(join(root, 'manifest.dsse.json'), 'utf8'));
    assert.equal(verifyEnvelope(envelope, publicKeyPem), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('signing identical payload bytes with one key is byte-reproducible across runs', () => {
  const { privateKeyPem } = keyPair();
  const payload = Buffer.from('{\n  "version": 1\n}\n', 'utf8');
  const first = signManifest(payload, privateKeyPem, 'k1');
  const second = signManifest(Buffer.from(payload), privateKeyPem, 'k1');
  assert.deepEqual(second, first);
});

test('the CLI exits 0 and writes no sidecar when no key is provisioned', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-sign-'));
  try {
    writeFileSync(join(root, 'manifest.json'), '{}\n', 'utf8');
    const env = { ...process.env };
    delete env.JINN_PROFILE_MANIFEST_SIGNING_KEY;
    const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no profile-manifest signing key provisioned; wrote no sidecar/);
    assert.equal(existsSync(join(root, 'manifest.dsse.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
