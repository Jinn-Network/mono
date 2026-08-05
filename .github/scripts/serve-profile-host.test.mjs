// node --test suite for serve-profile-host.mjs -- zero-dependency, loopback only.
//
// The unit half drives the pure helpers. The socket half starts the real listener on an
// ephemeral port and proves the strictness claims over real HTTP, including the request
// targets `fetch` refuses to send unnormalized (`//`, `/./`, `/../`), which are issued
// through `http.request` so the raw target reaches the server verbatim.
// Run: `cd .github/scripts && node --test serve-profile-host.test.mjs`.

import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { buildProfileHostBundle } from './build-profile-host-bundle.mjs';
import {
  DEFAULT_PUBLIC_KEY_PATH,
  FAULTS,
  NOT_FOUND_BODY,
  applyFault,
  assertKnownFault,
  documentHeaders,
  loadBundleRoutes,
  parseArgs,
  requestedPath,
  respondTo,
  selfSignedLoopbackCertificate,
  startProfileHost,
} from './serve-profile-host.mjs';
import { SIGNATURE_FILE_NAME } from './sign-profile-manifest.mjs';

const temporaries = [];
after(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A miniature profile root carrying every path shape a static host guesses wrong about:
// an extensionless profile, a `.schema.json`, an `@`-prefixed fixture directory, and a
// dot-version segment.
const SAMPLE = [
  ['profiles/sample-task/v1', 'application/json', '{\n  "$id": "https://spec.jinn.network/profiles/sample-task/v1"\n}\n'],
  ['schemas/sample.schema.json', 'application/schema+json', '{\n  "type": "object"\n}\n'],
  ['task-profiles/sample-domain/1.0', 'application/json', '{\n  "profile": "x"\n}\n'],
  ['@jinn-network/sample/fixtures/golden/minimal.json', 'application/json', '{\n  "a": 1\n}\n'],
  ['@jinn-network/sample/fixtures/golden/notes.md', 'text/markdown', '# notes\n'],
];

function sampleBundle({ signed = true } = {}) {
  const root = temporaryDirectory('jinn-serve-root-');
  const documents = SAMPLE.map(([path, mediaType, body]) => {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, 'utf8');
    return { path, sha256: sha256(Buffer.from(body, 'utf8')), mediaType, sourcePackage: '@jinn-network/sample' };
  });
  const manifest = {
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit: '0'.repeat(40) },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packages: ['@jinn-network/sample'],
    documents,
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (signed) writeFileSync(join(root, SIGNATURE_FILE_NAME), '{\n  "payloadType": "x"\n}\n', 'utf8');
  const bundle = join(temporaryDirectory('jinn-serve-bundle-'), 'out');
  buildProfileHostBundle({ profileRoot: root, outDir: bundle });
  return { root, bundle, manifest };
}

/** GET one raw request target, bypassing the client-side URL normalization `fetch` does. */
function getRaw(origin, target) {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        bytes: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// --- pure logic -------------------------------------------------------------

test('requestedPath refuses every shape of normalization', () => {
  assert.deepEqual(requestedPath('/profiles/sample-task/v1'), { path: 'profiles/sample-task/v1' });
  assert.deepEqual(requestedPath('/manifest.json?v=1'), { path: 'manifest.json' });
  assert.deepEqual(requestedPath('/manifest.json#frag'), { path: 'manifest.json' });
  for (const bad of [
    '', 'profiles/x', '/', '/profiles/sample-task/v1/', '//profiles/x', '/profiles//x',
    '/profiles/./x', '/profiles/../x', '/profiles%2Fx', '/profiles/%2e%2e/x', '/profiles\\x',
  ]) {
    assert.ok(requestedPath(bad).error, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('loadBundleRoutes serves exactly the manifest, its sidecar and its documents', () => {
  const { bundle, manifest } = sampleBundle();
  const { routes } = loadBundleRoutes(bundle);
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['manifest.json', SIGNATURE_FILE_NAME, ...manifest.documents.map(({ path }) => path)].sort(),
  );
  // `vercel.json` sits in the bundle and is configuration, never a served document.
  assert.equal(routes.has('vercel.json'), false);
  const profile = routes.get('profiles/sample-task/v1');
  assert.equal(profile.kind, 'document');
  assert.equal(profile.mediaType, 'application/json');
  assert.equal(profile.cacheControl, 'public, max-age=31536000, immutable');
  assert.equal(routes.get('manifest.json').cacheControl, 'public, max-age=0, must-revalidate');
  assert.equal(routes.get(SIGNATURE_FILE_NAME).cacheControl, 'public, max-age=0, must-revalidate');
});

test('loadBundleRoutes refuses a bundle that cannot be served', () => {
  assert.throws(() => loadBundleRoutes(temporaryDirectory('jinn-serve-empty-')), /has no manifest\.json/u);
  const { bundle } = sampleBundle();
  rmSync(join(bundle, 'schemas/sample.schema.json'));
  assert.throws(() => loadBundleRoutes(bundle), /missing declared document schemas\/sample\.schema\.json/u);
});

test('loadBundleRoutes optionally serves the published signing key', () => {
  const { bundle } = sampleBundle();
  const { routes } = loadBundleRoutes(bundle, { publicKey: { pem: '-----BEGIN PUBLIC KEY-----\n' } });
  assert.equal(routes.get(DEFAULT_PUBLIC_KEY_PATH).kind, 'key');
  assert.equal(routes.get(DEFAULT_PUBLIC_KEY_PATH).mediaType, 'application/x-pem-file');
});

test('documentHeaders pin exactly what the generated host configuration declares', () => {
  const bytes = Buffer.from('{}\n');
  assert.deepEqual(documentHeaders({
    mediaType: 'application/schema+json',
    sha256: sha256(bytes),
    cacheControl: 'public, max-age=31536000, immutable',
    bytes,
  }), {
    'content-type': 'application/schema+json',
    etag: `"sha256-${sha256(bytes)}"`,
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': '3',
  });
});

test('applyFault changes one thing and only documents', () => {
  const { bundle } = sampleBundle();
  const { routes } = loadBundleRoutes(bundle);
  assert.throws(() => assertKnownFault('nonsense'), /unknown fault/u);
  assert.equal(assertKnownFault(null), null);

  const clean = applyFault(routes, null);
  assert.equal(clean.catchAll, false);
  assert.equal(clean.redirectDocuments, false);

  assert.equal(applyFault(routes, 'spa-catchall').catchAll, true);
  assert.equal(applyFault(routes, 'redirect-trailing-slash').redirectDocuments, true);

  const extensionless = applyFault(routes, 'mistype-extensionless').routes;
  assert.equal(extensionless.get('profiles/sample-task/v1').mediaType, 'application/octet-stream');
  assert.equal(extensionless.get('task-profiles/sample-domain/1.0').mediaType, 'application/json');
  assert.equal(extensionless.get('manifest.json').mediaType, 'application/json');

  const schema = applyFault(routes, 'mistype-schema').routes;
  assert.equal(schema.get('schemas/sample.schema.json').mediaType, 'application/json');

  const charset = applyFault(routes, 'charset-suffix').routes;
  assert.equal(charset.get('manifest.json').mediaType, 'application/json; charset=utf-8');

  const drifted = applyFault(routes, 'drift-one-document').routes;
  const target = [...routes.values()].filter(({ kind }) => kind === 'document')
    .map(({ path }) => path).sort()[0];
  assert.notEqual(sha256(drifted.get(target).bytes), sha256(routes.get(target).bytes));
  assert.equal(drifted.get(target).sha256, routes.get(target).sha256, 'the pinned ETag must not move with the bytes');
  const untouched = [...drifted.values()].filter(({ path }) => path !== target);
  for (const route of untouched) assert.equal(Buffer.compare(route.bytes, routes.get(route.path).bytes), 0);
});

test('respondTo answers documents exactly and everything else 404', () => {
  const { bundle } = sampleBundle();
  const host = applyFault(loadBundleRoutes(bundle).routes, null);
  const ok = respondTo(host, '/profiles/sample-task/v1');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/json');

  for (const target of [
    '/profiles/sample-task/v1/', '/Profiles/sample-task/v1', '/profiles/sample-task',
    '/profiles/sample-task/v1.json', '/profiles', '/', '/vercel.json', '/index.html',
  ]) {
    const response = respondTo(host, target);
    assert.equal(response.status, 404, `${target} must be a hard 404`);
    assert.equal(response.body.toString('utf8'), NOT_FOUND_BODY);
  }
  assert.equal(respondTo(host, '/manifest.json', 'POST').status, 405);
});

test('parseArgs takes a bundle, an optional port and a known fault', () => {
  assert.deepEqual(parseArgs(['--bundle', 'out']), { bundleDir: 'out', port: 0, fault: null });
  assert.deepEqual(parseArgs(['--bundle', 'out', '--port', '8080', '--fault', 'spa-catchall']),
    { bundleDir: 'out', port: 8080, fault: 'spa-catchall' });
  assert.throws(() => parseArgs([]), /--bundle/u);
  assert.throws(() => parseArgs(['--bundle', 'out', '--port', 'x']), /--port/u);
  assert.throws(() => parseArgs(['--bundle', 'out', '--fault', 'x']), /unknown fault/u);
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown argument/u);
});

test('selfSignedLoopbackCertificate assembles a parseable loopback trust anchor', () => {
  const { key, cert } = selfSignedLoopbackCertificate();
  const parsed = new X509Certificate(cert);
  assert.equal(parsed.ca, true);
  assert.equal(parsed.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1');
  assert.equal(parsed.subject, 'CN=jinn-local-profile-host');
  assert.equal(parsed.issuer, parsed.subject);
  assert.ok(new Date(parsed.validTo).getTime() > Date.now());
  assert.match(key, /^-----BEGIN PRIVATE KEY-----/u);
});

// --- over a real socket -----------------------------------------------------

test('the listener serves the bundle over HTTP and refuses everything else', async () => {
  const { bundle, manifest } = sampleBundle();
  const server = await startProfileHost({ bundleDir: bundle });
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.notEqual(server.port, 0, 'an ephemeral port must be reported back');
    assert.equal(server.documentCount, manifest.documents.length);

    for (const { path, mediaType, sha256: digest } of manifest.documents) {
      const response = await fetch(`${server.origin}/${path}`, { redirect: 'manual' });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), mediaType, path);
      assert.equal(response.headers.get('etag'), `"sha256-${digest}"`, path);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(Buffer.compare(bytes, readFileSync(join(bundle, ...path.split('/')))), 0, path);
    }

    // The strictness claims, over the wire. `fetch` normalizes these away client-side, so
    // the ones with `.`/`..`/`//` are issued as raw request targets.
    for (const target of [
      '/profiles/sample-task/v1/', '/profiles/sample-task/v1.json', '/PROFILES/sample-task/v1',
      '/profiles', '/profiles/', '/', '/index.html', '/vercel.json',
      '/profiles/./sample-task/v1', '/profiles/../profiles/sample-task/v1',
      '//profiles/sample-task/v1', '/profiles%2Fsample-task%2Fv1',
    ]) {
      const response = await getRaw(server.origin, target);
      assert.equal(response.status, 404, `${target} must be a hard 404 over the wire`);
      assert.equal(response.bytes.toString('utf8'), NOT_FOUND_BODY, target);
    }
  } finally {
    await server.close();
  }
});

test('the listener records what it was asked for', async () => {
  const { bundle } = sampleBundle();
  const server = await startProfileHost({ bundleDir: bundle });
  try {
    await fetch(`${server.origin}/manifest.json`, { redirect: 'manual' });
    await fetch(`${server.origin}/nope`, { redirect: 'manual' });
    assert.deepEqual(server.requests, [
      { target: '/manifest.json', method: 'GET', status: 200 },
      { target: '/nope', method: 'GET', status: 404 },
    ]);
  } finally {
    await server.close();
  }
});

test('every fault changes observable host behavior over the socket', async () => {
  const { bundle } = sampleBundle();
  const observed = new Map();
  for (const fault of FAULTS) {
    const server = await startProfileHost({ bundleDir: bundle, fault });
    try {
      const profile = await fetch(`${server.origin}/profiles/sample-task/v1`, { redirect: 'manual' });
      const schema = await fetch(`${server.origin}/schemas/sample.schema.json`, { redirect: 'manual' });
      const unknown = await fetch(`${server.origin}/definitely-not-a-document`, { redirect: 'manual' });
      observed.set(fault, {
        profileStatus: profile.status,
        profileType: profile.headers.get('content-type'),
        profileLocation: profile.headers.get('location'),
        schemaType: schema.headers.get('content-type'),
        unknownStatus: unknown.status,
      });
    } finally {
      await server.close();
    }
  }
  assert.equal(observed.get('redirect-trailing-slash').profileStatus, 308);
  assert.equal(observed.get('redirect-trailing-slash').profileLocation, '/profiles/sample-task/v1/');
  assert.equal(observed.get('spa-catchall').unknownStatus, 200);
  assert.equal(observed.get('mistype-extensionless').profileType, 'application/octet-stream');
  assert.equal(observed.get('mistype-schema').schemaType, 'application/json');
  assert.equal(observed.get('charset-suffix').profileType, 'application/json; charset=utf-8');
  assert.equal(observed.get('drift-one-document').profileStatus, 200);
});

test('the listener serves https when handed a certificate', async () => {
  const { bundle } = sampleBundle();
  const tls = selfSignedLoopbackCertificate();
  const server = await startProfileHost({ bundleDir: bundle, tls });
  try {
    assert.match(server.origin, /^https:\/\/127\.0\.0\.1:\d+$/u);
  } finally {
    await server.close();
  }
});
