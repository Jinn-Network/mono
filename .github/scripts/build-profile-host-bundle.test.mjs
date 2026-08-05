// node --test suite for build-profile-host-bundle.mjs -- zero-dependency, offline.
//
// The bundle is built from a real buildProfileRoot output in a temp directory, so the
// byte-equality and determinism assertions run against the actual public surface
// rather than a hand-written stand-in. Run: `cd .github/scripts && node --test`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { buildProfileRoot } from './build-profile-root.mjs';
import { SIGNATURE_FILE_NAME } from './sign-profile-manifest.mjs';
import {
  HOST_CONFIG_FILE_NAME,
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_FILE_NAME,
  MANIFEST_MEDIA_TYPE,
  REVALIDATE_CACHE_CONTROL,
  ROUTE_LIMIT,
  ROUTE_WARNING_THRESHOLD,
  assertLiteralRoutePath,
  buildProfileHostBundle,
  entityTag,
  hostConfig,
  hostConfigBytes,
  routeWarnings,
} from './build-profile-host-bundle.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const temporaries = [];

function temporaryDirectory(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

after(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

const sourceSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

let cachedProfileRoot;
/** A real attested profile root, built once and reused. */
function realProfileRoot() {
  if (!cachedProfileRoot) {
    cachedProfileRoot = temporaryDirectory('jinn-host-bundle-source-');
    buildProfileRoot({ repoRoot, outDir: cachedProfileRoot, commit: sourceSha });
  }
  return cachedProfileRoot;
}

function walk(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(join(directory, entry.name), path));
    else files.push(path);
  }
  return files.sort();
}

const document = (path, sha256, mediaType = 'application/json') => ({ path, sha256, mediaType });
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

// --- pure logic -------------------------------------------------------------

test('entityTag renders a strong quoted sha256 entity tag', () => {
  assert.equal(entityTag(digestA), `"sha256-${digestA}"`);
});

test('entityTag rejects anything that is not a lowercase sha256', () => {
  assert.throws(() => entityTag('A'.repeat(64)), /lowercase SHA-256/u);
  assert.throws(() => entityTag('abc'), /lowercase SHA-256/u);
});

test('assertLiteralRoutePath rejects traversal, absolutes and pattern metacharacters', () => {
  assert.equal(assertLiteralRoutePath('profiles/task-execution/1.0'), 'profiles/task-execution/1.0');
  assert.equal(assertLiteralRoutePath('@jinn-network/x/fixtures/a.json'), '@jinn-network/x/fixtures/a.json');
  for (const bad of ['', '/leading', 'a/../b', 'a//b', 'a\\b', 'a/:id/b', 'a/(b)/c', 'a/*']) {
    assert.throws(() => assertLiteralRoutePath(bad), /served path/u, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('hostConfig pins cleanUrls, trailingSlash and declares no rewrite or redirect surface', () => {
  const config = hostConfig({
    documents: [document('profiles/task-execution/1.0', digestA)],
    rootDocuments: [{
      path: MANIFEST_FILE_NAME,
      mediaType: MANIFEST_MEDIA_TYPE,
      sha256: digestB,
      cacheControl: REVALIDATE_CACHE_CONTROL,
    }],
  });
  assert.equal(config.cleanUrls, false);
  assert.equal(config.trailingSlash, false);
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'cleanUrls', 'headers', 'trailingSlash']);
  for (const key of ['rewrites', 'redirects', 'routes', 'cleanUrlsRedirect', 'fallback']) {
    assert.ok(!(key in config), `configuration must not declare ${key}`);
  }
});

test('hostConfig emits one entry per served path with media type, entity tag and lifetime', () => {
  const config = hostConfig({
    documents: [document('b/second.md', digestB, 'text/markdown'), document('a/first', digestA, 'application/json')],
    rootDocuments: [{
      path: MANIFEST_FILE_NAME,
      mediaType: MANIFEST_MEDIA_TYPE,
      sha256: digestB,
      cacheControl: REVALIDATE_CACHE_CONTROL,
    }],
  });
  assert.deepEqual(config.headers.map(({ source }) => source), ['/manifest.json', '/a/first', '/b/second.md']);
  assert.deepEqual(config.headers[1].headers, [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'ETag', value: `"sha256-${digestA}"` },
    { key: 'Cache-Control', value: IMMUTABLE_CACHE_CONTROL },
  ]);
  assert.equal(config.headers[2].headers[0].value, 'text/markdown');
  // The root manifest is the mutable pointer to an immutable set.
  assert.equal(config.headers[0].headers[2].value, REVALIDATE_CACHE_CONTROL);
});

test('hostConfig rejects duplicate paths, root collisions and a served vercel.json', () => {
  const root = [{
    path: MANIFEST_FILE_NAME,
    mediaType: MANIFEST_MEDIA_TYPE,
    sha256: digestB,
    cacheControl: REVALIDATE_CACHE_CONTROL,
  }];
  assert.throws(
    () => hostConfig({ documents: [document('a', digestA), document('a', digestB)], rootDocuments: root }),
    /repeats document path/u,
  );
  assert.throws(
    () => hostConfig({ documents: [document(MANIFEST_FILE_NAME, digestA)], rootDocuments: root }),
    /collides with a served document/u,
  );
  assert.throws(
    () => hostConfig({ documents: [document(HOST_CONFIG_FILE_NAME, digestA)], rootDocuments: root }),
    /reads as configuration/u,
  );
  assert.throws(() => hostConfig({ documents: [], rootDocuments: root }), /no documents/u);
});

test('routeWarnings stays silent below the threshold and names the headroom above it', () => {
  assert.deepEqual(routeWarnings(541), []);
  assert.deepEqual(routeWarnings(ROUTE_WARNING_THRESHOLD - 1), []);
  assert.equal(routeWarnings(ROUTE_WARNING_THRESHOLD).length, 1);
  assert.match(routeWarnings(ROUTE_WARNING_THRESHOLD)[0], new RegExp(String(ROUTE_LIMIT)));
  assert.match(routeWarnings(ROUTE_LIMIT + 1)[0], /exceeds/u);
});

// --- bundle against a real attested profile root ----------------------------

test('the bundle is the exact attested bytes plus one generated configuration file', () => {
  const source = realProfileRoot();
  const out = temporaryDirectory('jinn-host-bundle-out-');
  const result = buildProfileHostBundle({ profileRoot: source, outDir: out });

  const sourceFiles = walk(source);
  const bundleFiles = walk(out);
  assert.deepEqual(bundleFiles, [...sourceFiles, HOST_CONFIG_FILE_NAME].sort());
  assert.equal(result.documentCount + 1, sourceFiles.length);

  for (const path of sourceFiles) {
    const before = readFileSync(join(source, ...path.split('/')));
    const after = readFileSync(join(out, ...path.split('/')));
    assert.equal(Buffer.compare(before, after), 0, `bundle rewrote ${path}`);
  }
});

test('the generated configuration covers every manifest document with its declared media type', () => {
  const source = realProfileRoot();
  const out = temporaryDirectory('jinn-host-bundle-media-');
  buildProfileHostBundle({ profileRoot: source, outDir: out });
  const manifest = JSON.parse(readFileSync(join(source, MANIFEST_FILE_NAME), 'utf8'));
  const config = JSON.parse(readFileSync(join(out, HOST_CONFIG_FILE_NAME), 'utf8'));
  const bySource = new Map(config.headers.map((entry) => [entry.source, entry.headers]));

  assert.equal(config.headers.length, manifest.documents.length + 1);
  assert.ok(bySource.has(`/${MANIFEST_FILE_NAME}`));
  for (const { path, sha256, mediaType } of manifest.documents) {
    const headers = bySource.get(`/${path}`);
    assert.ok(headers, `no host configuration entry for ${path}`);
    assert.deepEqual(headers, [
      { key: 'Content-Type', value: mediaType },
      { key: 'ETag', value: `"sha256-${sha256}"` },
      { key: 'Cache-Control', value: IMMUTABLE_CACHE_CONTROL },
    ]);
  }
  // Extensionless documents are the reason the configuration exists at all.
  const extensionless = manifest.documents.filter(({ path }) => !path.split('/').at(-1).includes('.'));
  assert.ok(extensionless.length > 0, 'expected at least one extensionless served document');
  for (const { path, mediaType } of extensionless) {
    assert.equal(bySource.get(`/${path}`)[0].value, mediaType);
  }
});

test('the bundle is deterministic: the same profile root yields identical bytes', () => {
  const source = realProfileRoot();
  const first = temporaryDirectory('jinn-host-bundle-first-');
  const second = temporaryDirectory('jinn-host-bundle-second-');
  buildProfileHostBundle({ profileRoot: source, outDir: first });
  buildProfileHostBundle({ profileRoot: source, outDir: second });
  const files = walk(first);
  assert.deepEqual(files, walk(second));
  for (const path of files) {
    assert.equal(
      Buffer.compare(readFileSync(join(first, ...path.split('/'))), readFileSync(join(second, ...path.split('/')))),
      0,
      `nondeterministic bytes at ${path}`,
    );
  }
});

test('a signature sidecar is carried into the bundle and given a revalidating entry', () => {
  const source = temporaryDirectory('jinn-host-bundle-signed-');
  const manifest = buildProfileRoot({ repoRoot, outDir: source, commit: sourceSha });
  const envelope = `${JSON.stringify({ payload: 'e30=', payloadType: 'x', signatures: [] }, null, 2)}\n`;
  writeFileSync(join(source, SIGNATURE_FILE_NAME), envelope, 'utf8');
  const out = temporaryDirectory('jinn-host-bundle-signed-out-');
  const result = buildProfileHostBundle({ profileRoot: source, outDir: out });

  assert.ok(existsSync(join(out, SIGNATURE_FILE_NAME)));
  assert.equal(readFileSync(join(out, SIGNATURE_FILE_NAME), 'utf8'), envelope);
  assert.equal(result.routeCount, manifest.documents.length + 2);
  const config = JSON.parse(readFileSync(join(out, HOST_CONFIG_FILE_NAME), 'utf8'));
  const sidecar = config.headers.find(({ source: path }) => path === `/${SIGNATURE_FILE_NAME}`);
  assert.deepEqual(sidecar.headers, [
    { key: 'Content-Type', value: MANIFEST_MEDIA_TYPE },
    { key: 'ETag', value: `"sha256-${createHash('sha256').update(envelope).digest('hex')}"` },
    { key: 'Cache-Control', value: REVALIDATE_CACHE_CONTROL },
  ]);
});

test('an undeclared file, a digest drift and a non-empty output directory are all refused', () => {
  const stray = temporaryDirectory('jinn-host-bundle-stray-');
  buildProfileRoot({ repoRoot, outDir: stray, commit: sourceSha });
  writeFileSync(join(stray, 'unexpected.txt'), 'x', 'utf8');
  assert.throws(
    () => buildProfileHostBundle({ profileRoot: stray, outDir: temporaryDirectory('jinn-host-bundle-stray-out-') }),
    /undeclared file unexpected\.txt/u,
  );

  const drifted = temporaryDirectory('jinn-host-bundle-drift-');
  const driftManifest = buildProfileRoot({ repoRoot, outDir: drifted, commit: sourceSha });
  const victim = driftManifest.documents[0].path;
  writeFileSync(join(drifted, ...victim.split('/')), 'tampered', 'utf8');
  assert.throws(
    () => buildProfileHostBundle({ profileRoot: drifted, outDir: temporaryDirectory('jinn-host-bundle-drift-out-') }),
    /digest does not match the manifest/u,
  );

  const occupied = temporaryDirectory('jinn-host-bundle-occupied-');
  mkdirSync(join(occupied, 'nested'), { recursive: true });
  assert.throws(
    () => buildProfileHostBundle({ profileRoot: realProfileRoot(), outDir: occupied }),
    /non-empty directory/u,
  );
});

test('a profile root without a manifest is refused', () => {
  assert.throws(
    () => buildProfileHostBundle({
      profileRoot: temporaryDirectory('jinn-host-bundle-empty-'),
      outDir: temporaryDirectory('jinn-host-bundle-empty-out-'),
    }),
    /has no manifest\.json/u,
  );
});
