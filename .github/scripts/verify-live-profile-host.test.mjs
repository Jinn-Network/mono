// node --test suite for verify-live-profile-host.mjs -- zero-dependency, offline.
//
// The fake host is built from a real `buildProfileRoot` output in a temp directory and
// signed with a throwaway Ed25519 key, so the happy path exercises the sealed-platform-v1
// public surface (hundreds of documents, including extensionless profiles,
// fixture documents whose `profile` field is a vocabulary name rather than a served
// path, and both document- and prefix-resolution registered identifiers). Every
// adversarial case mutates exactly one thing about that host and asserts the gate
// refuses. Run: `cd .github/scripts && node --test`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { buildProfileRoot, manifestBytes } from './build-profile-root.mjs';
import { canonicalJsonBytes, catalogSha256 } from './build-prepublication-bundle.mjs';
import { PLATFORM_CATALOG_PATH, loadPlatformCatalog } from './platform-catalog.mjs';
import { fixtureCatalog, fixtureRepo } from './platform-catalog-test-fixture.mjs';
import { createVerificationReceipt, verificationGateConclusionIds } from './platform-verification-receipt.mjs';
import { SIGNATURE_FILE_NAME, signManifest } from './sign-profile-manifest.mjs';
import {
  MANIFEST_FILE_NAME,
  STABLE_ORIGIN,
  canonicalPublicKeySha256,
  checkReceiptIdentity,
  mediaTypeMatches,
  normalizeOrigin,
  originForLane,
  parseMediaType,
  selfIdentifyingClaim,
  servedPathForIdentifier,
  verifyLiveProfileHost,
} from './verify-live-profile-host.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const scriptPath = join(import.meta.dirname, 'verify-live-profile-host.mjs');
// The fake host serves the *real* public surface, whose documents and whose registered
// `resolvableIdentifiers` name spec.jinn.network after the DR-2026-08-04 re-seal
// (component C2). A fake host on any other origin cannot serve them coherently.
const ORIGIN = STABLE_ORIGIN;
// A neutral origin, deliberately neither the canonical one nor the retired apex. It carries
// the "the origin is a parameter" proofs and the stable lane's refusal of anything but
// STABLE_ORIGIN -- both of which need an origin that is not STABLE_ORIGIN.
const OTHER_ORIGIN = 'https://profiles.example';
const PUBLIC_KEY_URL = 'https://keys.example/profile-manifest.pem';
const KEY_ID = 'jinn-profile-manifest-test';

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
const sourceSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// --- fake host --------------------------------------------------------------

function response(status, contentType, bytes, redirected = false) {
  return {
    status,
    redirected,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => bytes,
  };
}

/**
 * A fake host: an exact URL -> served-bytes map plus the published public key.
 * `catchAll` models the single-page-application host that answers 200 everywhere.
 */
function makeFetch(routes, { publicKeyPem, catchAll = false, throwFor = null } = {}) {
  const fn = async (url) => {
    const target = String(url);
    fn.calls.push(target);
    if (throwFor && throwFor(target)) throw new TypeError('fetch failed');
    if (target === PUBLIC_KEY_URL) {
      return response(200, 'application/x-pem-file', Buffer.from(publicKeyPem, 'utf8'));
    }
    const entry = routes.get(target);
    if (entry) return response(entry.status, entry.contentType, entry.bytes, entry.redirected ?? false);
    if (catchAll) return response(200, 'text/html', Buffer.from('<!doctype html><div id="app"></div>'));
    return response(404, 'text/plain', Buffer.from('not found'));
  };
  fn.calls = [];
  return fn;
}

// --- fixtures ---------------------------------------------------------------

let cached;

/** A signed, attested profile root of the real public surface, built once. */
function realFixture() {
  if (cached) return cached;
  const root = temporaryDirectory('jinn-live-host-root-');
  const catalogDigest = catalogSha256(repoRoot);
  const manifest = buildProfileRoot({
    repoRoot,
    outDir: root,
    commit: sourceSha,
    catalogDigest,
    releaseGroup: 'sealed-platform-v1',
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const localManifestBytes = readFileSync(join(root, MANIFEST_FILE_NAME));
  const envelope = signManifest(localManifestBytes, privateKeyPem, KEY_ID);
  const signatureBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, SIGNATURE_FILE_NAME), signatureBytes);

  const receipt = {
    schemaVersion: 1,
    sourceSha,
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: catalogDigest },
    releaseGroup: 'sealed-platform-v1',
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

  const routes = new Map();
  routes.set(`${ORIGIN}/${MANIFEST_FILE_NAME}`, { status: 200, contentType: 'application/json', bytes: localManifestBytes });
  routes.set(`${ORIGIN}/${SIGNATURE_FILE_NAME}`, { status: 200, contentType: 'application/json', bytes: signatureBytes });
  for (const { path, mediaType } of manifest.documents) {
    routes.set(`${ORIGIN}/${path}`, {
      status: 200,
      contentType: mediaType,
      bytes: readFileSync(join(root, ...path.split('/'))),
    });
  }

  cached = {
    root,
    manifest,
    manifestBytes: localManifestBytes,
    signatureBytes,
    publicKeyPem,
    privateKeyPem,
    receipt,
    catalogDigest,
    routes,
    resolvableIdentifiers: (loadPlatformCatalog(repoRoot).resolvableIdentifiers ?? [])
      .filter(({ owner }) => manifest.packages.includes(owner)),
  };
  return cached;
}

/** Base arguments for a run against the real fixture; `routes` is per-case. */
function runArgs(fixture, { routes, receipt, fetchOptions = {}, ...overrides } = {}) {
  return {
    profileRoot: fixture.root,
    receipt: receipt ?? fixture.receipt,
    receiptSha256: 'f'.repeat(64),
    sourceSha,
    catalogDigest: fixture.catalogDigest,
    releaseGroup: 'sealed-platform-v1',
    lane: 'canary',
    origin: ORIGIN,
    publicKeyUrl: PUBLIC_KEY_URL,
    expectPublicKeySha256: canonicalPublicKeySha256(fixture.publicKeyPem).sha256,
    resolvableIdentifiers: fixture.resolvableIdentifiers,
    fetch: makeFetch(routes ?? new Map(fixture.routes), { publicKeyPem: fixture.publicKeyPem, ...fetchOptions }),
    retryDelayMs: 0,
    attempts: 2,
    ...overrides,
  };
}

const clonedRoutes = (fixture) => new Map(fixture.routes);

async function expectFailure(args, pattern) {
  const result = await verifyLiveProfileHost(args);
  assert.equal(result.ok, false, `expected a refusal, got: ${result.reason}`);
  assert.match(result.reason, pattern);
  assert.equal(result.receipt, undefined, 'a refused run must not emit a live-host receipt');
  return result;
}

// --- pure logic -------------------------------------------------------------

test('normalizeOrigin accepts a bare https origin and refuses everything else', () => {
  assert.deepEqual(normalizeOrigin('https://spec.jinn.network/'), { origin: STABLE_ORIGIN });
  assert.deepEqual(normalizeOrigin('https://spec.jinn.network'), { origin: STABLE_ORIGIN });
  for (const bad of ['', 'spec.jinn.network', 'http://spec.jinn.network', 'https://spec.jinn.network/v1', 'https://a.b?x=1']) {
    assert.ok(normalizeOrigin(bad).error, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('the stable lane may only verify the dedicated identifier origin', () => {
  assert.deepEqual(originForLane('https://spec.jinn.network', 'stable'), { origin: STABLE_ORIGIN });
  assert.match(originForLane('https://jinn.network', 'stable').error, /stable lane must verify/u);
  assert.match(originForLane('https://staging.example', 'stable').error, /stable lane must verify/u);
  // The canary lane is where a staging origin is legitimate.
  assert.deepEqual(originForLane('https://staging.example', 'canary'), { origin: 'https://staging.example' });
  assert.match(originForLane('https://spec.jinn.network', 'production').error, /lane must be canary or stable/u);
});

test('media types compare on type and subtype, ignoring parameters', () => {
  assert.equal(parseMediaType('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(parseMediaType(''), null);
  assert.equal(parseMediaType(undefined), null);
  assert.equal(mediaTypeMatches('application/json; charset=utf-8', 'application/json'), true);
  assert.equal(mediaTypeMatches('application/json', 'application/schema+json'), false);
  assert.equal(mediaTypeMatches(undefined, 'application/json'), false);
});

test('servedPathForIdentifier reuses the canonical path rule under a parameterized origin', () => {
  assert.deepEqual(
    servedPathForIdentifier(`${STABLE_ORIGIN}/profiles/trace-vocabulary/v1`, STABLE_ORIGIN),
    { servedPath: 'profiles/trace-vocabulary/v1' },
  );
  assert.deepEqual(
    servedPathForIdentifier(`${OTHER_ORIGIN}/profiles/task-execution/1.0`, OTHER_ORIGIN),
    { servedPath: 'profiles/task-execution/1.0' },
  );
  assert.ok(servedPathForIdentifier(`${OTHER_ORIGIN}/x`, STABLE_ORIGIN).error, 'origin mismatch must be refused');
  for (const bad of [`${STABLE_ORIGIN}/`, `${STABLE_ORIGIN}/a/../b`, `${STABLE_ORIGIN}/a?x=1`, `${STABLE_ORIGIN}/manifest.json`]) {
    assert.ok(servedPathForIdentifier(bad, STABLE_ORIGIN).error, `expected ${bad} to be refused`);
  }
});

test('a fixture document declaring a vocabulary profile is not read as a served-path claim', () => {
  const bytes = Buffer.from(JSON.stringify({ profile: `${OTHER_ORIGIN}/task-profiles/example-domain/1.0` }));
  assert.equal(selfIdentifyingClaim('@jinn-network/x/fixtures/golden/minimal.json', bytes, OTHER_ORIGIN), null);
  assert.deepEqual(
    selfIdentifyingClaim('profiles/thing/1.0/x.json', bytes, OTHER_ORIGIN),
    { field: 'profile', identifier: `${OTHER_ORIGIN}/task-profiles/example-domain/1.0` },
  );
  assert.equal(selfIdentifyingClaim('profiles/thing/1.0/x.md', bytes, OTHER_ORIGIN), null);
  assert.match(selfIdentifyingClaim('profiles/a.json', Buffer.from('{'), OTHER_ORIGIN).error, /does not parse/u);
  assert.match(
    selfIdentifyingClaim('profiles/a.json', Buffer.from(JSON.stringify({ $id: `${OTHER_ORIGIN}/a`, profile: `${OTHER_ORIGIN}/b` })), OTHER_ORIGIN).error,
    /multiple self-identifying claims/u,
  );
});

test('canonicalPublicKeySha256 normalizes PEM whitespace and refuses non-ed25519 keys', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const digest = canonicalPublicKeySha256(pem);
  assert.match(digest.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(canonicalPublicKeySha256(`${pem}\n\n   `).sha256, digest.sha256);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'pem' }).toString();
  assert.match(canonicalPublicKeySha256(rsa).error, /must be ed25519/u);
  assert.match(canonicalPublicKeySha256('not a key').error, /not a readable key/u);
});

test('checkReceiptIdentity refuses drift and any non-success conclusion', () => {
  const base = {
    sourceSha: '0'.repeat(40),
    catalog: { sha256: '1'.repeat(64) },
    releaseGroup: 'platform-v1',
    lane: 'stable',
    conclusions: { catalog: 'success' },
  };
  const expected = { sourceSha: '0'.repeat(40), catalogDigest: '1'.repeat(64), releaseGroup: 'platform-v1', lane: 'stable' };
  assert.deepEqual(checkReceiptIdentity(base, expected), { ok: true });
  assert.match(checkReceiptIdentity({ ...base, lane: 'canary' }, expected).reason, /lane is canary/u);
  assert.match(checkReceiptIdentity({ ...base, conclusions: {} }, expected).reason, /no gate conclusions/u);
  assert.match(
    checkReceiptIdentity({ ...base, conclusions: { catalog: 'skipped' } }, expected).reason,
    /gate catalog is skipped/u,
  );
});

// --- the gate, against a real signed profile root ---------------------------

test('happy path: the host serves the attested manifest, every document and a verifying signature', async () => {
  const fixture = realFixture();
  const result = await verifyLiveProfileHost(runArgs(fixture));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.receipt.origin, ORIGIN);
  assert.equal(result.receipt.sourceSha, sourceSha);
  assert.equal(result.receipt.catalogDigest, fixture.catalogDigest);
  assert.equal(result.receipt.releaseGroup, 'sealed-platform-v1');
  assert.equal(result.receipt.lane, 'canary');
  assert.equal(result.receipt.verificationReceiptSha256, 'f'.repeat(64));
  assert.equal(result.receipt.profileManifestSha256, sha256(fixture.manifestBytes));
  assert.equal(result.receipt.documentsVerified, fixture.manifest.documents.length);
  assert.ok(result.receipt.documentsVerified > 100, 'expected the real public surface, not a stub');
  assert.equal(result.receipt.resolvableIdentifiersVerified, fixture.resolvableIdentifiers.length);
  assert.deepEqual(result.receipt.signature.keyids, [KEY_ID]);
  assert.equal(result.receipt.signature.publicKeyUrl, PUBLIC_KEY_URL);
  assert.match(result.receipt.verifiedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/u);
  assert.equal(canonicalJsonBytes(result.receipt), canonicalJsonBytes(result.receipt));
});

test('a charset parameter on an otherwise exact media type is conformant', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const manifestUrl = `${ORIGIN}/${MANIFEST_FILE_NAME}`;
  routes.set(manifestUrl, { ...routes.get(manifestUrl), contentType: 'application/json; charset=utf-8' });
  const result = await verifyLiveProfileHost(runArgs(fixture, { routes }));
  assert.equal(result.ok, true, result.reason);
});

test('manifest whitespace drift is refused even though the JSON is equivalent', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const reformatted = Buffer.from(`${JSON.stringify(fixture.manifest, null, 4)}\n`, 'utf8');
  assert.notEqual(Buffer.compare(reformatted, fixture.manifestBytes), 0);
  routes.set(`${ORIGIN}/${MANIFEST_FILE_NAME}`, {
    status: 200,
    contentType: 'application/json',
    bytes: reformatted,
  });
  await expectFailure(runArgs(fixture, { routes }), /bytes differ from the attested artifact/u);
});

test('one drifted document digest is refused, and the drift is not retried', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const victim = fixture.manifest.documents.find(({ path }) => path.endsWith('.json'));
  const url = `${ORIGIN}/${victim.path}`;
  routes.set(url, { status: 200, contentType: victim.mediaType, bytes: Buffer.from('{"tampered":true}\n') });
  const args = runArgs(fixture, { routes });
  await expectFailure(args, new RegExp(`${victim.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}.*bytes differ`, 'u'));
  assert.equal(args.fetch.calls.filter((call) => call === url).length, 1, 'a content failure must never be retried');
});

test('a correct digest served with the wrong media type is refused (extensionless profile)', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const extensionless = fixture.manifest.documents.find(({ path }) => !path.split('/').at(-1).includes('.'));
  assert.ok(extensionless, 'expected an extensionless served document');
  assert.notEqual(extensionless.mediaType, 'application/octet-stream');
  // A static host with no extension to infer from falls back to octet-stream. That is
  // the exact failure the generated host configuration exists to prevent.
  const url = `${ORIGIN}/${extensionless.path}`;
  routes.set(url, { ...routes.get(url), contentType: 'application/octet-stream' });
  await expectFailure(
    runArgs(fixture, { routes }),
    new RegExp(`served content-type application/octet-stream, expected ${extensionless.mediaType.replace('+', '\\+')}`, 'u'),
  );
});

test('a schema served as application/json instead of application/schema+json is refused', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const schema = fixture.manifest.documents.find(({ mediaType }) => mediaType === 'application/schema+json');
  assert.ok(schema, 'expected a schema document');
  const url = `${ORIGIN}/${schema.path}`;
  routes.set(url, { ...routes.get(url), contentType: 'application/json' });
  await expectFailure(runArgs(fixture, { routes }), /expected application\/schema\+json/u);
});

test('a trailing-slash redirect is refused rather than followed', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const victim = fixture.manifest.documents[0];
  routes.set(`${ORIGIN}/${victim.path}`, {
    status: 301,
    contentType: 'text/plain',
    bytes: Buffer.from(''),
  });
  await expectFailure(runArgs(fixture, { routes }), /returned 301, expected 200/u);
});

test('a single-page-application catch-all cannot make the gate pass vacuously', async () => {
  const fixture = realFixture();
  // A host that answers 200 with the same body everywhere: it never reaches a document.
  await expectFailure(
    runArgs(fixture, { routes: new Map(), fetchOptions: { catchAll: true } }),
    /bytes differ from the attested artifact|served content-type/u,
  );
  // A host that serves every attested byte correctly but also answers 200 on unknown
  // paths still cannot pass: the registered-prefix check and the anti-fallback probes
  // both refuse it. The prefix check happens to fire first on the real surface.
  await expectFailure(
    runArgs(fixture, { fetchOptions: { catchAll: true } }),
    /registered prefix but the host answers 200|answers 200; the host has a catch-all/u,
  );
});

test('a host answering 200 at manifest.json.sha256 is refused', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  routes.set(`${ORIGIN}/${MANIFEST_FILE_NAME}.sha256`, {
    status: 200,
    contentType: 'text/plain',
    bytes: Buffer.from(`${sha256(fixture.manifestBytes)}\n`),
  });
  await expectFailure(runArgs(fixture, { routes }), /manifest\.json\.sha256 answers 200/u);
});

test('a registered prefix identifier that answers 200 at its bare URI is refused', async () => {
  const fixture = realFixture();
  const prefix = fixture.resolvableIdentifiers.find(({ resolution }) => resolution === 'prefix');
  assert.ok(prefix, 'expected a prefix-resolution registered identifier');
  const routes = clonedRoutes(fixture);
  const bare = prefix.identifier.replace(`${ORIGIN}/`, `${ORIGIN}/`);
  routes.set(bare, { status: 200, contentType: 'text/html', bytes: Buffer.from('index') });
  await expectFailure(runArgs(fixture, { routes }), /registered prefix but the host answers 200/u);
});

test('a missing hosted signature sidecar is refused', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  routes.delete(`${ORIGIN}/${SIGNATURE_FILE_NAME}`);
  await expectFailure(runArgs(fixture, { routes }), /manifest\.dsse\.json returned 404/u);
});

test('an attested root with no signature sidecar is refused: there is no unsigned path', () => {
  const unsigned = temporaryDirectory('jinn-live-host-unsigned-');
  const catalogDigest = catalogSha256(repoRoot);
  buildProfileRoot({
    repoRoot,
    outDir: unsigned,
    commit: sourceSha,
    catalogDigest,
    releaseGroup: 'sealed-platform-v1',
  });
  assert.ok(!existsSync(join(unsigned, SIGNATURE_FILE_NAME)));
  const fixture = realFixture();
  return expectFailure(
    runArgs(fixture, { profileRoot: unsigned }),
    /is not the artifact the verification receipt names|has no manifest\.dsse\.json/u,
  );
});

test('a signature over different bytes than the host serves is refused', async () => {
  const fixture = realFixture();
  const routes = clonedRoutes(fixture);
  const otherManifest = { ...fixture.manifest, lane: 'stable' };
  const otherEnvelope = signManifest(
    Buffer.from(manifestBytes(otherManifest), 'utf8'),
    fixture.privateKeyPem,
    KEY_ID,
  );
  routes.set(`${ORIGIN}/${SIGNATURE_FILE_NAME}`, {
    status: 200,
    contentType: 'application/json',
    bytes: Buffer.from(`${JSON.stringify(otherEnvelope, null, 2)}\n`, 'utf8'),
  });
  // The sidecar must be the attested sidecar before its payload is even considered.
  await expectFailure(runArgs(fixture, { routes }), /bytes differ from the attested artifact/u);
});

test('a sidecar whose payload is not the hosted manifest is refused', async () => {
  const fixture = realFixture();
  const drifted = temporaryDirectory('jinn-live-host-drifted-sidecar-');
  const catalogDigest = catalogSha256(repoRoot);
  const manifest = buildProfileRoot({
    repoRoot,
    outDir: drifted,
    commit: sourceSha,
    catalogDigest,
    releaseGroup: 'sealed-platform-v1',
  });
  const otherEnvelope = signManifest(
    Buffer.from(manifestBytes({ ...manifest, lane: 'stable' }), 'utf8'),
    fixture.privateKeyPem,
    KEY_ID,
  );
  const sidecarBytes = Buffer.from(`${JSON.stringify(otherEnvelope, null, 2)}\n`, 'utf8');
  writeFileSync(join(drifted, SIGNATURE_FILE_NAME), sidecarBytes);
  const localManifest = readFileSync(join(drifted, MANIFEST_FILE_NAME));

  const routes = clonedRoutes(fixture);
  routes.set(`${ORIGIN}/${SIGNATURE_FILE_NAME}`, { status: 200, contentType: 'application/json', bytes: sidecarBytes });
  const receipt = {
    ...fixture.receipt,
    surfaces: {
      profile: {
        ...fixture.receipt.surfaces.profile,
        manifestSha256: sha256(localManifest),
        signature: { keyids: [KEY_ID], sha256: sha256(sidecarBytes) },
      },
    },
  };
  await expectFailure(
    runArgs(fixture, { routes, receipt, profileRoot: drifted }),
    /does not envelope the exact bytes the host serves/u,
  );
});

test('a published key whose digest is not the pinned one is refused', async () => {
  const fixture = realFixture();
  await expectFailure(
    runArgs(fixture, { expectPublicKeySha256: '0'.repeat(64) }),
    /SPKI PEM sha256 is [0-9a-f]{64}, expected 0{64}/u,
  );
});

test('a key that does not verify the envelope is refused even when its digest is pinned', async () => {
  const fixture = realFixture();
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await expectFailure(
    runArgs(fixture, {
      expectPublicKeySha256: canonicalPublicKeySha256(other).sha256,
      fetchOptions: { publicKeyPem: other },
    }),
    /does not verify against the key published at/u,
  );
});

test('a receipt naming a different source SHA is refused', async () => {
  const fixture = realFixture();
  const receipt = { ...fixture.receipt, sourceSha: 'a'.repeat(40) };
  await expectFailure(runArgs(fixture, { receipt }), /receipt source SHA is a{40}/u);
});

test('a receipt with any gate conclusion other than success is refused', async () => {
  const fixture = realFixture();
  const receipt = {
    ...fixture.receipt,
    conclusions: { ...fixture.receipt.conclusions, 'external-consumer': 'skipped' },
  };
  await expectFailure(runArgs(fixture, { receipt }), /gate external-consumer is skipped, not success/u);
});

test('a local manifest that is not the one the receipt names is refused', async () => {
  const fixture = realFixture();
  const receipt = {
    ...fixture.receipt,
    surfaces: { profile: { ...fixture.receipt.surfaces.profile, manifestSha256: '0'.repeat(64) } },
  };
  await expectFailure(runArgs(fixture, { receipt }), /not the artifact the verification receipt names/u);
});

test('a receipt document inventory that differs from the local manifest is refused', async () => {
  const fixture = realFixture();
  const receipt = {
    ...fixture.receipt,
    surfaces: {
      profile: { ...fixture.receipt.surfaces.profile, documents: fixture.manifest.documents.slice(1) },
    },
  };
  await expectFailure(runArgs(fixture, { receipt }), /documents differ from the verification receipt inventory/u);
});

test('the stable lane refuses any origin other than spec.jinn.network', async () => {
  const fixture = realFixture();
  await expectFailure(
    runArgs(fixture, { lane: 'stable', origin: OTHER_ORIGIN }),
    /stable lane must verify https:\/\/spec\.jinn\.network/u,
  );
});

test('a mid-fetch network error is a failure, never a skip', async () => {
  const fixture = realFixture();
  const victim = fixture.manifest.documents[3];
  const url = `${ORIGIN}/${victim.path}`;
  const args = runArgs(fixture, { fetchOptions: { throwFor: (target) => target === url } });
  await expectFailure(args, /network error: fetch failed/u);
  assert.equal(args.fetch.calls.filter((call) => call === url).length, 2, 'transport errors are retried, then fatal');
});

test('a transport flake is absorbed by retry, but a persistent 503 stays fatal', async () => {
  const fixture = realFixture();
  const victim = fixture.manifest.documents[2];
  const url = `${ORIGIN}/${victim.path}`;

  const flaky = clonedRoutes(fixture);
  const served = flaky.get(url);
  let attempt = 0;
  const flakyFetch = makeFetch(flaky, { publicKeyPem: fixture.publicKeyPem });
  const wrapped = async (target, init) => {
    if (String(target) === url) {
      attempt += 1;
      if (attempt === 1) return response(503, 'text/plain', Buffer.from('unavailable'));
    }
    return flakyFetch(target, init);
  };
  const ok = await verifyLiveProfileHost(runArgs(fixture, { routes: flaky, fetch: wrapped }));
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(attempt >= 2, true, 'expected the flake to have been retried');

  const persistent = clonedRoutes(fixture);
  persistent.set(url, { ...served, status: 503 });
  await expectFailure(runArgs(fixture, { routes: persistent }), /returned 503/u);
});

// --- shape contract with the real receipt producer --------------------------

test('a receipt written by platform-verification-receipt.mjs is read without adaptation', async () => {
  const fixtureSha = '1'.repeat(40);
  const fixtureRoot = fixtureRepo();
  const catalog = fixtureCatalog();
  const profilePackage = catalog.packages.find(({ name }) => name === '@jinn-network/fixture-protocol');
  profilePackage.publicSurface.schemas = ['schemas'];
  writeFileSync(join(fixtureRoot, PLATFORM_CATALOG_PATH), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  const schemaDirectory = join(fixtureRoot, profilePackage.path, 'schemas');
  mkdirSync(schemaDirectory, { recursive: true });
  writeFileSync(join(schemaDirectory, 'profile.schema.json'), `${JSON.stringify({
    $id: `${ORIGIN}/fixture/profile.schema.json`,
    type: 'object',
  }, null, 2)}\n`, 'utf8');

  const catalogDigest = catalogSha256(fixtureRoot);
  const workspace = temporaryDirectory('jinn-live-host-shape-');
  const profileRoot = join(workspace, 'profile-root');
  const profile = buildProfileRoot({
    repoRoot: fixtureRoot,
    outDir: profileRoot,
    commit: fixtureSha,
    catalogDigest,
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const localManifestBytes = readFileSync(join(profileRoot, MANIFEST_FILE_NAME));
  const envelope = signManifest(
    localManifestBytes,
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    KEY_ID,
  );
  const sidecarBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  writeFileSync(join(profileRoot, SIGNATURE_FILE_NAME), sidecarBytes);

  // The producer validates the pack and public-surface manifests too, so both are
  // built here: this test must exercise the real receipt writer, not a stand-in.
  const packages = catalog.packages
    .filter(({ releaseGroup }) => releaseGroup === 'platform-v1')
    .sort((left, right) => left.path.localeCompare(right.path));
  const firstWave = [
    ...packages.map(({ name }) => name).filter((name) => name.startsWith('@jinn-network/fixture-core-')),
    '@jinn-network/fixture-protocol',
  ].sort();
  const packageOrder = [...firstWave, '@jinn-network/fixture-application'];
  const packRoot = join(workspace, 'pack');
  mkdirSync(join(packRoot, 'tarballs'), { recursive: true });
  const identity = {
    schemaVersion: 1,
    sourceSha: fixtureSha,
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: catalogDigest },
    releaseGroup: 'platform-v1',
    lane: 'canary',
  };
  const packManifestPath = join(packRoot, 'manifest.json');
  writeFileSync(packManifestPath, canonicalJsonBytes({
    ...identity,
    packageVersion: `0.1.0-canary.sha.${fixtureSha}`,
    distTag: 'canary',
    waves: [firstWave, ['@jinn-network/fixture-application']],
    packageOrder,
    tarballs: packageOrder.map((name, index) => {
      const filename = `tarballs/package-${String(index + 1).padStart(2, '0')}.tgz`;
      const bytes = Buffer.from(`live-host-tarball:${name}`);
      writeFileSync(join(packRoot, filename), bytes);
      return { name, filename, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
    }),
  }), 'utf8');
  const publicManifestPath = join(workspace, 'public-surface-manifest.json');
  writeFileSync(publicManifestPath, canonicalJsonBytes({
    ...identity,
    packages: packages.map(({ name, path, publicSurface }) => ({ name, path, publicSurface })),
  }), 'utf8');

  const receiptPath = join(workspace, 'verification-receipt.json');
  const receipt = createVerificationReceipt({
    repoRoot: fixtureRoot,
    sourceSha: fixtureSha,
    catalogDigest,
    releaseGroup: 'platform-v1',
    lane: 'canary',
    packManifestPath,
    publicManifestPath,
    profileManifestPath: join(profileRoot, MANIFEST_FILE_NAME),
    conclusions: Object.fromEntries(
      verificationGateConclusionIds(catalog, 'platform-v1').map((gate) => [gate, 'success']),
    ),
    outputPath: receiptPath,
  });
  assert.equal(receipt.surfaces.profile.signature.sha256, sha256(sidecarBytes));

  const routes = new Map();
  routes.set(`${ORIGIN}/${MANIFEST_FILE_NAME}`, { status: 200, contentType: 'application/json', bytes: localManifestBytes });
  routes.set(`${ORIGIN}/${SIGNATURE_FILE_NAME}`, { status: 200, contentType: 'application/json', bytes: sidecarBytes });
  for (const { path, mediaType } of profile.documents) {
    routes.set(`${ORIGIN}/${path}`, {
      status: 200,
      contentType: mediaType,
      bytes: readFileSync(join(profileRoot, ...path.split('/'))),
    });
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const result = await verifyLiveProfileHost({
    profileRoot,
    receipt,
    receiptSha256: sha256(readFileSync(receiptPath)),
    sourceSha: fixtureSha,
    catalogDigest,
    releaseGroup: 'platform-v1',
    lane: 'canary',
    origin: ORIGIN,
    publicKeyUrl: PUBLIC_KEY_URL,
    expectPublicKeySha256: canonicalPublicKeySha256(publicKeyPem).sha256,
    resolvableIdentifiers: loadPlatformCatalog(fixtureRoot).resolvableIdentifiers ?? [],
    fetch: makeFetch(routes, { publicKeyPem }),
    retryDelayMs: 0,
    attempts: 1,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.receipt.documentsVerified, profile.documents.length);
});

// --- the CLI maps a refusal to a non-zero exit ------------------------------

test('the CLI exits non-zero and prints FAIL when the gate refuses', () => {
  const attempt = (args) => {
    try {
      const stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', cwd: repoRoot });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.status, stdout: String(error.stdout ?? '') };
    }
  };
  const missing = attempt(['--root', '/nonexistent', '--release-group', 'sealed-platform-v1']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stdout, /^FAIL: /mu);

  const wrongOrigin = attempt([
    '--root', realFixture().root,
    '--receipt', join(realFixture().root, MANIFEST_FILE_NAME),
    '--source-sha', sourceSha,
    '--catalog-digest', realFixture().catalogDigest,
    '--release-group', 'sealed-platform-v1',
    '--lane', 'stable',
    '--origin', OTHER_ORIGIN,
    '--public-key-url', PUBLIC_KEY_URL,
    '--expect-public-key-sha256', '0'.repeat(64),
    '--out', join(temporaryDirectory('jinn-live-host-cli-'), 'live-host-receipt.json'),
  ]);
  assert.notEqual(wrongOrigin.code, 0);
  assert.match(wrongOrigin.stdout, /FAIL: .*stable lane must verify https:\/\/spec\.jinn\.network/u);
});
