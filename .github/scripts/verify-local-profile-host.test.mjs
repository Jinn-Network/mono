// node --test suite: the live-host gate, over a real socket, before spec.jinn.network exists.
//
// `verify-live-profile-host.test.mjs` proves the gate's logic against an injected `fetch`.
// That leaves the host-level failure modes -- extensionless served paths, `@`-prefixed
// fixture directories, path normalization, trailing-slash redirects, whether a 404 is a
// real 404 -- proven by nothing, because a fake `fetch` cannot get them wrong. This suite
// closes that half: it builds the real profile root, signs it, generates the deploy
// bundle, serves the bundle from a real TLS listener on an ephemeral loopback port, and
// runs the gate's own CLI against it as a subprocess, over the real `globalThis.fetch`.
// There is no injected fetch anywhere in this file, and every case is an exit code.
//
// One accommodation is load-bearing and it weakens nothing; it is written up in
// docs/runbooks/jinn-network-profile-hosting.md. `normalizeOrigin` refuses anything that
// is not `https`, at every lane, and it is right to. So the listener is a real TLS
// listener with a throwaway self-signed Ed25519 certificate, generated per run, and the
// gate subprocess is handed exactly that certificate through `NODE_EXTRA_CA_CERTS`.
// Nothing about the gate is relaxed; the trust anchor is narrowed to one process, one
// certificate, one run.
//
// These runs use the repository's own catalog and its real registered-identifier
// register. That is the point of the identity/location split the gate makes: every
// identifier resolves against `IDENTIFIER_ORIGIN` and the served path it yields is
// fetched at the loopback origin, so a preview host verifies exactly as the canonical one
// does. `verifies the real identifier register under a loopback origin` and `identity
// resolution is bit-identical at the stable origin` below are the two halves of that.
//
// Run: `cd .github/scripts && node --test verify-local-profile-host.test.mjs`.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { buildProfileRoot, manifestBytes } from './build-profile-root.mjs';
import {
  HOST_CONFIG_FILE_NAME,
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  buildProfileHostBundle,
  entityTag,
} from './build-profile-host-bundle.mjs';
import { catalogSha256 } from './build-prepublication-bundle.mjs';
import { PLATFORM_CATALOG_PATH, loadPlatformCatalog } from './platform-catalog.mjs';
import {
  DEFAULT_PUBLIC_KEY_PATH,
  loadBundleRoutes,
  selfSignedLoopbackCertificate,
  startProfileHost,
} from './serve-profile-host.mjs';
import { SIGNATURE_FILE_NAME, signManifest } from './sign-profile-manifest.mjs';
import {
  IDENTIFIER_ORIGIN,
  STABLE_ORIGIN,
  canonicalPublicKeySha256,
  selfIdentifyingClaim,
  servedPathForIdentifier,
} from './verify-live-profile-host.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const gateScript = join(import.meta.dirname, 'verify-live-profile-host.mjs');
const KEY_ID = 'jinn-local-conformance';
const sourceSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const catalogDigest = catalogSha256(repoRoot);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const temporaries = [];
after(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

// --- shared state built once ------------------------------------------------

let tls;
let caCertPath;
/** The catalog's registered identifiers that the platform-v1 release set owns. */
let registered;
let full;
let subset;

/** Sign a profile root in place and return the sidecar bytes. */
function signRoot(root, privateKeyPem) {
  const envelope = signManifest(readFileSync(join(root, 'manifest.json')), privateKeyPem, KEY_ID);
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, SIGNATURE_FILE_NAME), bytes);
  return bytes;
}

/**
 * A signed, attested profile root plus the deploy bundle built from it and the
 * verification receipt that names both.
 */
function attestedFixture(root, manifest) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const localManifestBytes = readFileSync(join(root, 'manifest.json'));
  const signatureBytes = signRoot(root, privateKeyPem);

  const bundle = join(temporaryDirectory('jinn-local-host-bundle-'), 'deploy');
  const built = buildProfileHostBundle({ profileRoot: root, outDir: bundle });

  const receipt = {
    schemaVersion: 1,
    sourceSha,
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
    surfaces: {
      profile: {
        manifestSha256: sha256(localManifestBytes),
        documentCount: manifest.documents.length,
        documents: manifest.documents,
        signature: { keyids: [KEY_ID], sha256: sha256(signatureBytes) },
      },
    },
    conclusions: Object.fromEntries(
      ['catalog', 'artifacts', 'artifact-attestation', 'external-consumer'].map((gate) => [gate, 'success']),
    ),
  };
  const receiptPath = join(temporaryDirectory('jinn-local-host-receipt-'), 'verification-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  return {
    root,
    bundle,
    built,
    manifest,
    manifestBytes: localManifestBytes,
    signatureBytes,
    privateKeyPem,
    publicKeyPem,
    publicKeySha256: canonicalPublicKeySha256(publicKeyPem).sha256,
    receipt,
    receiptPath,
  };
}

// Every path shape a static host guesses wrong about, selected from the real manifest by
// predicate rather than by name so the selection cannot quietly go stale.
const HAZARD_SHAPES = [
  ['an extensionless facts profile', ({ path }) => /^facts\/[^/]+\/v1$/u.test(path)],
  ['an extensionless task-execution profile', ({ path }) => /^profiles\/[^/]+\/v1$/u.test(path)],
  ['a dot-version segment', ({ path }) => /^task-profiles\/[^/]+\/\d+\.\d+$/u.test(path)],
  ['an @-prefixed fixture document', ({ path }) => path.startsWith('@jinn-network/') && path.endsWith('.json')],
  ['a deep @-prefixed fixture path', ({ path }) => path.startsWith('@jinn-network/') && path.split('/').length >= 8],
  ['a .schema.json document', ({ path }) => path.endsWith('.schema.json')],
  ['a markdown document', ({ path }) => path.endsWith('.md')],
  ['an extension a host would guess wrong', ({ path, mediaType }) => (
    mediaType === 'application/octet-stream' && /\.(mjs|ts|pem|patch)$/u.test(path)
  )],
];

function hazardDocuments(manifest) {
  const chosen = new Map();
  for (const [label, predicate] of HAZARD_SHAPES) {
    const document = manifest.documents.find(predicate);
    assert.ok(document, `the real public surface no longer contains ${label}`);
    chosen.set(label, document);
  }
  return chosen;
}

/**
 * A small profile root carved out of the real one, carrying every hazardous path shape
 * and every registered identifier's entry point -- so the fault cases below exercise the
 * same gate steps the full sweep does, only over a dozen documents instead of 541.
 */
function subsetRoot(source, manifest) {
  const entryPoints = new Set(registered.map(({ entryPoint }) => entryPoint));
  const documents = [...new Set([
    ...hazardDocuments(manifest).values(),
    ...manifest.documents.filter(({ path }) => entryPoints.has(path)),
  ])].sort((left, right) => (left.path < right.path ? -1 : 1));
  const root = temporaryDirectory('jinn-local-host-subset-');
  for (const { path } of documents) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, ...path.split('/')), target);
  }
  const subsetManifest = { ...manifest, documents };
  writeFileSync(join(root, 'manifest.json'), manifestBytes(subsetManifest), 'utf8');
  return { root, manifest: subsetManifest };
}

before(() => {
  tls = selfSignedLoopbackCertificate();
  caCertPath = join(temporaryDirectory('jinn-local-host-ca-'), 'loopback-ca.pem');
  writeFileSync(caCertPath, tls.cert, 'utf8');

  const fullRoot = temporaryDirectory('jinn-local-host-root-');
  const manifest = buildProfileRoot({ repoRoot, outDir: fullRoot, commit: sourceSha, catalogDigest });
  const releasePackages = new Set(manifest.packages);
  registered = (loadPlatformCatalog(repoRoot).resolvableIdentifiers ?? [])
    .filter(({ owner }) => releasePackages.has(owner));
  assert.ok(registered.length > 0, 'the platform-v1 release set must own registered identifiers');
  const carved = subsetRoot(fullRoot, manifest);
  full = attestedFixture(fullRoot, manifest);
  subset = attestedFixture(carved.root, carved.manifest);
});

// --- running the real gate against a real socket ----------------------------

/**
 * Serve one bundle on an ephemeral loopback port.
 *
 * TLS by default, because the gate refuses a non-https origin and only the gate's
 * subprocess is handed the trust anchor. `secure: false` is for this file's own direct
 * assertions, which run in the test process: what they check -- served paths, media types,
 * entity tags, bytes, and which requests are hard 404s -- is transport-independent, so
 * cleartext is the honest way to make them without widening this process's trust store.
 */
function serve(fixture, { fault = null, publicKeyPem, secure = true } = {}) {
  return startProfileHost({
    bundleDir: fixture.bundle,
    fault,
    tls: secure ? tls : null,
    publicKey: { pem: publicKeyPem ?? fixture.publicKeyPem },
  });
}

/**
 * Run the gate's own CLI as a subprocess against a live origin. The only environment
 * change is the one trust anchor for this run's certificate.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, receipt: object | null }>}
 */
function runGate(fixture, origin, {
  lane = 'canary',
  expectPublicKeySha256 = fixture.publicKeySha256,
  publicKeyPath = DEFAULT_PUBLIC_KEY_PATH,
} = {}) {
  const outputPath = join(temporaryDirectory('jinn-local-host-out-'), 'live-host-receipt.json');
  const argv = [
    gateScript,
    '--root', fixture.root,
    '--receipt', fixture.receiptPath,
    '--repo-root', repoRoot,
    '--source-sha', sourceSha,
    '--catalog-digest', catalogDigest,
    '--release-group', 'platform-v1',
    '--lane', lane,
    '--origin', origin,
    '--public-key-url', `${origin}/${publicKeyPath}`,
    '--expect-public-key-sha256', expectPublicKeySha256,
    '--out', outputPath,
  ];
  return new Promise((done) => {
    execFile(
      process.execPath,
      argv,
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: caCertPath }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let receipt = null;
        try {
          receipt = JSON.parse(readFileSync(outputPath, 'utf8'));
        } catch {
          receipt = null;
        }
        done({ code: error ? error.code ?? 1 : 0, stdout, stderr, receipt });
      },
    );
  });
}

async function gateAgainst(fixture, options = {}, gateOptions = {}) {
  const server = await serve(fixture, options);
  try {
    return await runGate(fixture, server.origin, gateOptions);
  } finally {
    await server.close();
  }
}

// --- the happy path, over the whole real surface ----------------------------

test('the gate passes against a real socket serving the whole real profile root', async () => {
  const server = await serve(full);
  let result;
  try {
    result = await runGate(full, server.origin);
  } finally {
    await server.close();
  }
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^OK: /u);

  // Not a vacuous pass, and not on the sweeper's own word: the listener's request log has
  // to show every declared document actually fetched and answered 200.
  const documentCount = full.manifest.documents.length;
  const answered = new Set(server.requests
    .filter(({ status }) => status === 200)
    .map(({ target }) => target.slice(1)));
  for (const { path } of full.manifest.documents) {
    assert.ok(answered.has(path), `the gate never fetched ${path}`);
  }
  // Step 8's anti-fallback probes are the reason none of the above is vacuous, so they
  // have to be shown reaching the host and being refused -- by their actual shapes, not
  // by "some 404 happened".
  const refused = new Set(server.requests.filter(({ status }) => status === 404).map(({ target }) => target));
  for (const [label, shape] of [
    ['a random path', /^\/[0-9a-f-]{36}$/u],
    ['a digest sidecar beside the manifest', /^\/manifest\.json\.sha256$/u],
    ['an unpublished package manifest', /^\/@jinn-network\/not-a-published-package-[0-9a-f-]{36}\/package\.json$/u],
  ]) {
    assert.ok([...refused].some((target) => shape.test(target)), `no anti-fallback probe for ${label} was refused`);
  }

  assert.ok(documentCount > 500, `the real surface should be ~541 documents, saw ${documentCount}`);
  assert.ok(result.receipt, 'a passing run must emit a live-host receipt');
  assert.equal(result.receipt.documentsVerified, documentCount);
  assert.equal(result.receipt.profileManifestSha256, sha256(full.manifestBytes));
  assert.equal(result.receipt.signature.sidecarSha256, sha256(full.signatureBytes));
  assert.equal(result.receipt.signature.publicKeySha256, full.publicKeySha256);
  assert.deepEqual(result.receipt.signature.keyids, [KEY_ID]);
  assert.equal(result.receipt.lane, 'canary');
  assert.match(result.receipt.origin, /^https:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(result.stdout, new RegExp(`${documentCount} documents`, 'u'));
  // The real register, dereferenced at the loopback origin. Not zero, and not a number
  // the harness chose: the count the catalog actually declares for this release set.
  assert.equal(result.receipt.resolvableIdentifiersVerified, registered.length);
  assert.ok(registered.length > 0);
});

// --- the hazardous path shapes, byte for byte, over the wire ----------------

test('every hazardous path shape is served exactly, from the real profile root', async () => {
  const server = await serve(full, { secure: false });
  try {
    const chosen = hazardDocuments(full.manifest);
    assert.equal(chosen.size, HAZARD_SHAPES.length);
    for (const [label, document] of chosen) {
      const url = `${server.origin}/${document.path}`;
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, 200, `${label} (${document.path})`);
      assert.equal(response.redirected, false, `${label} must not redirect`);
      assert.equal(response.headers.get('content-type'), document.mediaType, `${label} media type`);
      assert.equal(response.headers.get('etag'), entityTag(document.sha256), `${label} entity tag`);
      assert.equal(response.headers.get('cache-control'), IMMUTABLE_CACHE_CONTROL, `${label} cache lifetime`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(bytes), document.sha256, `${label} bytes`);
      assert.equal(
        Buffer.compare(bytes, readFileSync(join(full.root, ...document.path.split('/')))),
        0,
        `${label} bytes differ from the attested root`,
      );

      // The near-misses a guessing host would answer anyway.
      for (const near of [`${url}/`, `${url}.json`, url.replace(/\/([^/]+)$/u, '/$1.html')]) {
        if (near === url) continue;
        assert.equal((await fetch(near, { redirect: 'manual' })).status, 404, `${near} must be a hard 404`);
      }
    }

    // The anti-fallback probes must be real 404s, or every byte comparison above is vacuous.
    for (const probe of ['/definitely-not-a-document', '/manifest.json.sha256', '/@jinn-network/not-a-package/package.json']) {
      assert.equal((await fetch(`${server.origin}${probe}`, { redirect: 'manual' })).status, 404, probe);
    }
  } finally {
    await server.close();
  }
});

// --- the generated host configuration, read against what the server enforces --

test('the generated vercel.json declares exactly the headers the reference host serves', () => {
  // This validates OUR READING of Vercel's documented `headers` / `cleanUrls` /
  // `trailingSlash` semantics against the reference behavior above. It does not validate
  // Vercel's implementation of them -- nothing local can. That residual gap closes at the
  // first real deploy, and the live-host gate is what closes it.
  const config = JSON.parse(readFileSync(join(full.bundle, HOST_CONFIG_FILE_NAME), 'utf8'));
  const { routes } = loadBundleRoutes(full.bundle);

  assert.equal(config.cleanUrls, false);
  assert.equal(config.trailingSlash, false);
  assert.equal(config.rewrites, undefined, 'a rewrite is a catch-all by another name');
  assert.equal(config.redirects, undefined, 'a redirect makes exact-path serving unprovable');

  const declared = new Map(config.headers.map((entry) => [entry.source, entry]));
  assert.equal(declared.size, config.headers.length, 'a repeated source is an ambiguous route');
  assert.deepEqual(
    [...declared.keys()].sort(),
    [...routes.keys()].map((path) => `/${path}`).sort(),
    'every served path needs exactly one headers entry, and nothing else may have one',
  );

  for (const [source, entry] of declared) {
    const route = routes.get(source.slice(1));
    assert.ok(!/[:*?]/u.test(source), `${source} would be read as a pattern, not a literal path`);
    const headers = Object.fromEntries(entry.headers.map(({ key, value }) => [key, value]));
    assert.deepEqual(Object.keys(headers).sort(), ['Cache-Control', 'Content-Type', 'ETag']);
    assert.equal(headers['Content-Type'], route.mediaType, source);
    assert.equal(headers.ETag, entityTag(route.sha256), source);
    assert.equal(
      headers['Cache-Control'],
      route.kind === 'document' ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL,
      source,
    );
  }
});

// --- a conformant variation the gate must still accept ----------------------

test('a host appending charset=utf-8 is conformant and still passes', async () => {
  const result = await gateAgainst(subset, { fault: 'charset-suffix' });
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.equal(result.receipt.documentsVerified, subset.manifest.documents.length);
});

test('the same small bundle passes unfaulted, so every refusal below is the fault', async () => {
  const result = await gateAgainst(subset);
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.equal(result.receipt.documentsVerified, subset.manifest.documents.length);
});

// --- every fault is a non-zero exit -----------------------------------------

const HOST_FAULTS = [
  ['a trailing-slash redirect', 'redirect-trailing-slash', /returned 308, expected 200/u],
  // Two independent probes can reach a catch-all: step 7's bare-identifier probe for a
  // registered prefix, and step 8's anti-fallback probes. The small bundle carries
  // registered prefixes, so step 7 gets there first. Either way a 200 where the host must
  // have nothing is fatal, which is the property under test.
  ['a single-page-application catch-all', 'spa-catchall', /answers 200 at the bare identifier/u],
  ['a mistyped extensionless profile', 'mistype-extensionless', /served content-type application\/octet-stream, expected application\/json/u],
  ['a mistyped .schema.json document', 'mistype-schema', /served content-type application\/json, expected application\/schema\+json/u],
  ['one drifted document', 'drift-one-document', /bytes differ from the attested artifact/u],
];

for (const [label, fault, expected] of HOST_FAULTS) {
  test(`the gate refuses ${label}`, async () => {
    const result = await gateAgainst(subset, { fault });
    assert.notEqual(result.code, 0, `expected a non-zero exit, got: ${result.stdout}`);
    assert.match(result.stdout, /^FAIL: /u);
    assert.match(result.stdout, expected);
    assert.equal(result.receipt, null, 'a refused run must not write a live-host receipt');
  });
}

test('the gate refuses a host that does not serve the signature sidecar', async () => {
  const stripped = { ...subset, bundle: join(temporaryDirectory('jinn-local-host-unsigned-'), 'deploy') };
  cpSync(subset.bundle, stripped.bundle, { recursive: true });
  rmSync(join(stripped.bundle, SIGNATURE_FILE_NAME));
  const result = await gateAgainst(stripped);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, new RegExp(`${SIGNATURE_FILE_NAME} returned 404, expected 200`, 'u'));
});

test('the gate refuses a sidecar that does not verify against the published key', async () => {
  const other = generateKeyPairSync('ed25519');
  const otherPublicKeyPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const result = await gateAgainst(
    subset,
    { publicKeyPem: otherPublicKeyPem },
    { expectPublicKeySha256: canonicalPublicKeySha256(otherPublicKeyPem).sha256 },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /does not verify against the key published at/u);
});

test('the gate refuses a published key whose digest is not the pinned one', async () => {
  const result = await gateAgainst(subset, {}, { expectPublicKeySha256: 'a'.repeat(64) });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /SPKI PEM sha256 is [0-9a-f]{64}, expected a{64}/u);
});

test('the gate refuses a published key that is not served at all', async () => {
  const result = await gateAgainst(subset, {}, { publicKeyPath: 'nowhere.pem' });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /nowhere\.pem returned 404, expected 200/u);
});

// --- the origin parameter, honestly pinned ----------------------------------

test('the stable lane still refuses a loopback origin', async () => {
  const result = await gateAgainst(subset, {}, { lane: 'stable' });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /stable lane must verify https:\/\/spec\.jinn\.network/u);
});

test('the gate verifies the real identifier register under a loopback origin', async () => {
  // The inverse of what this suite first found. Registered identifiers name
  // spec.jinn.network and always will -- they are protocol names, not addresses -- so the
  // gate resolves them canonically and dereferences the resulting served path at the
  // origin under verification. A preview host is therefore verifiable, which is the whole
  // reason the canary lane exists.
  const server = await serve(subset);
  let result;
  try {
    result = await runGate(subset, server.origin);
  } finally {
    await server.close();
  }
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.equal(result.receipt.resolvableIdentifiersVerified, registered.length);

  // Each registered identifier was actually dereferenced at the loopback origin, and each
  // prefix registration was probed at its bare identifier and refused there.
  const fetched = new Set(server.requests.map(({ target }) => target.slice(1)));
  for (const entry of registered) {
    const { servedPath } = servedPathForIdentifier(entry.identifier, IDENTIFIER_ORIGIN);
    assert.ok(fetched.has(entry.entryPoint), `${entry.identifier} entry point was never fetched`);
    if (entry.resolution === 'prefix') {
      assert.ok(fetched.has(servedPath), `${entry.identifier} bare prefix was never probed`);
      assert.ok(
        server.requests.some(({ target, status }) => target.slice(1) === servedPath && status === 404),
        `${entry.identifier} bare prefix must be refused, not answered`,
      );
    } else {
      assert.equal(servedPath, entry.entryPoint);
    }
  }
});

test('identity resolution is bit-identical at the stable origin', () => {
  // The change that made the two tests above possible splits identity from location. At
  // the stable lane the two coincide, so it must be a no-op there -- proved over the real
  // surface rather than argued: every registered identifier and every document claim
  // resolves the same whether asked canonically or against STABLE_ORIGIN.
  assert.equal(STABLE_ORIGIN, IDENTIFIER_ORIGIN);
  for (const entry of registered) {
    assert.deepEqual(
      servedPathForIdentifier(entry.identifier, IDENTIFIER_ORIGIN),
      servedPathForIdentifier(entry.identifier, STABLE_ORIGIN),
    );
  }
  let claimed = 0;
  for (const { path } of full.manifest.documents) {
    const bytes = readFileSync(join(full.root, ...path.split('/')));
    const canonical = selfIdentifyingClaim(path, bytes);
    assert.deepEqual(canonical, selfIdentifyingClaim(path, bytes, STABLE_ORIGIN), path);
    if (canonical && !canonical.error) claimed += 1;
  }
  // And the claims are actually there -- otherwise the sweep above agrees about nothing.
  assert.ok(claimed > 0, 'the real surface must contain self-identifying documents');
});
