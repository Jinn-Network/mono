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
import { dirname, join, resolve } from 'node:path';
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
  assertReleaseGroupSegment,
  buildProfileHostBundle,
  entityTag,
  hostConfig,
  hostConfigBytes,
  parseArgs,
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

const SEALED_GROUP = 'sealed-platform-v1';
const IMPLEMENTATIONS_GROUP = 'implementations-v1';

let cachedProfileRoot;
/** A real attested profile root, built once and reused. */
function realProfileRoot() {
  if (!cachedProfileRoot) {
    cachedProfileRoot = temporaryDirectory('jinn-host-bundle-source-');
    buildProfileRoot({
      repoRoot,
      outDir: cachedProfileRoot,
      commit: sourceSha,
      releaseGroup: SEALED_GROUP,
    });
  }
  return cachedProfileRoot;
}

let cachedImplementationsRoot;
/** The other stack-published release group, so the merge cases are two real roots. */
function implementationsProfileRoot() {
  if (!cachedImplementationsRoot) {
    cachedImplementationsRoot = temporaryDirectory('jinn-host-bundle-impl-source-');
    buildProfileRoot({
      repoRoot,
      outDir: cachedImplementationsRoot,
      commit: sourceSha,
      releaseGroup: IMPLEMENTATIONS_GROUP,
    });
  }
  return cachedImplementationsRoot;
}

/** Where a sealed profile root's file lands in the bundle: root files move under the group. */
const bundlePathFor = (path) => (
  path === MANIFEST_FILE_NAME || path === SIGNATURE_FILE_NAME ? `${SEALED_GROUP}/${path}` : path
);

/** A hand-written profile root, so a collision case needs no real release group. */
function syntheticRoot(releaseGroup, documents) {
  const root = temporaryDirectory(`jinn-host-bundle-${releaseGroup}-`);
  const declared = documents.map(([path, body]) => {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, 'utf8');
    return {
      path,
      sha256: createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
      mediaType: 'application/json',
    };
  });
  writeFileSync(
    join(root, MANIFEST_FILE_NAME),
    `${JSON.stringify({ version: 1, releaseGroup, documents: declared }, null, 2)}\n`,
    'utf8',
  );
  return root;
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

test('assertReleaseGroupSegment refuses anything that is not one literal URL segment', () => {
  assert.equal(assertReleaseGroupSegment('sealed-platform-v1'), 'sealed-platform-v1');
  // The property that matters is what the segment resolves to once it is in a URL: a
  // group that survives the guard must address itself, never the bundle root.
  for (const bad of ['a/b', 'a*', '..', '', '%2e%2e', '.%2e', '%2E%2E', 'a%2Fb', '%2f']) {
    assert.throws(
      () => assertReleaseGroupSegment(bad),
      /release group/u,
      `expected release group ${JSON.stringify(bad)} to be refused`,
    );
  }
  for (const traversal of ['%2e%2e', '.%2e', '%2E%2E']) {
    assert.equal(
      new URL(`https://spec.jinn.network/${traversal}/${MANIFEST_FILE_NAME}`).pathname,
      `/${MANIFEST_FILE_NAME}`,
      'this input must stay refused: it resolves to the forbidden root manifest',
    );
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
  assert.deepEqual(bundleFiles, [...sourceFiles.map((path) => bundlePathFor(path)), HOST_CONFIG_FILE_NAME].sort());
  assert.equal(result.documentCount + 1, sourceFiles.length);

  for (const path of sourceFiles) {
    const before = readFileSync(join(source, ...path.split('/')));
    const after = readFileSync(join(out, ...bundlePathFor(path).split('/')));
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
  assert.ok(bySource.has(`/${SEALED_GROUP}/${MANIFEST_FILE_NAME}`));
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
  const manifest = buildProfileRoot({
    repoRoot,
    outDir: source,
    commit: sourceSha,
    releaseGroup: SEALED_GROUP,
  });
  const envelope = `${JSON.stringify({ payload: 'e30=', payloadType: 'x', signatures: [] }, null, 2)}\n`;
  writeFileSync(join(source, SIGNATURE_FILE_NAME), envelope, 'utf8');
  const out = temporaryDirectory('jinn-host-bundle-signed-out-');
  const result = buildProfileHostBundle({ profileRoot: source, outDir: out });

  const sidecarPath = `${SEALED_GROUP}/${SIGNATURE_FILE_NAME}`;
  assert.ok(existsSync(join(out, ...sidecarPath.split('/'))));
  assert.equal(readFileSync(join(out, ...sidecarPath.split('/')), 'utf8'), envelope);
  assert.equal(result.routeCount, manifest.documents.length + 2);
  const config = JSON.parse(readFileSync(join(out, HOST_CONFIG_FILE_NAME), 'utf8'));
  const sidecar = config.headers.find(({ source: path }) => path === `/${sidecarPath}`);
  assert.deepEqual(sidecar.headers, [
    { key: 'Content-Type', value: MANIFEST_MEDIA_TYPE },
    { key: 'ETag', value: `"sha256-${createHash('sha256').update(envelope).digest('hex')}"` },
    { key: 'Cache-Control', value: REVALIDATE_CACHE_CONTROL },
  ]);
});

test('an undeclared file, a digest drift and a non-empty output directory are all refused', () => {
  const stray = temporaryDirectory('jinn-host-bundle-stray-');
  buildProfileRoot({
    repoRoot,
    outDir: stray,
    commit: sourceSha,
    releaseGroup: 'sealed-platform-v1',
  });
  writeFileSync(join(stray, 'unexpected.txt'), 'x', 'utf8');
  assert.throws(
    () => buildProfileHostBundle({ profileRoot: stray, outDir: temporaryDirectory('jinn-host-bundle-stray-out-') }),
    /undeclared file unexpected\.txt/u,
  );

  const drifted = temporaryDirectory('jinn-host-bundle-drift-');
  const driftManifest = buildProfileRoot({
    repoRoot,
    outDir: drifted,
    commit: sourceSha,
    releaseGroup: 'sealed-platform-v1',
  });
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

// --- one origin, one bundle, one namespace per release group ----------------
//
// Two stack-published groups deploy to the same origin and their documents are disjoint,
// but each group's own inventory is called `manifest.json`. Left at the bundle root the
// second write would clobber the first, so the root files -- and only the root files --
// live under the group that authored them.

test('the bundle namespaces the root manifest under its release group', () => {
  const source = realProfileRoot();
  const out = temporaryDirectory('jinn-host-bundle-namespace-');
  buildProfileHostBundle({ profileRoot: source, outDir: out });

  assert.ok(existsSync(join(out, SEALED_GROUP, MANIFEST_FILE_NAME)));
  assert.ok(!existsSync(join(out, MANIFEST_FILE_NAME)), 'the bundle root must not carry a manifest');

  const config = JSON.parse(readFileSync(join(out, HOST_CONFIG_FILE_NAME), 'utf8'));
  const entry = config.headers.find(({ source: path }) => path === `/${SEALED_GROUP}/${MANIFEST_FILE_NAME}`);
  assert.ok(entry, 'the group-namespaced manifest needs its own headers entry');
  assert.equal(
    entry.headers.find(({ key }) => key === 'Cache-Control').value,
    REVALIDATE_CACHE_CONTROL,
    'the group manifest is still the mutable pointer to an immutable set',
  );
  assert.ok(
    !config.headers.some(({ source: path }) => path === `/${MANIFEST_FILE_NAME}`),
    'a root manifest route would be the collision this namespacing removes',
  );
});

test('a profile root whose manifest names no release group is refused', () => {
  const root = temporaryDirectory('jinn-host-bundle-groupless-');
  writeFileSync(join(root, MANIFEST_FILE_NAME), `${JSON.stringify({
    version: 1,
    documents: [document('profiles/sample/v1', digestA)],
  }, null, 2)}\n`, 'utf8');
  assert.throws(
    () => buildProfileHostBundle({
      profileRoot: root,
      outDir: temporaryDirectory('jinn-host-bundle-groupless-out-'),
    }),
    /release group/u,
  );
  // `%2e%2e` and `.%2e` survive a literal-path check -- the metacharacter class has no
  // `%` -- and the URL parser then resolves them as dot-dot segments, putting the group
  // manifest back at the bundle root the namespacing exists to keep empty.
  for (const bad of ['a/b', 'a*', '..', '', '%2e%2e', '.%2e', '%2E%2E', 'a%2Fb']) {
    const rejected = temporaryDirectory('jinn-host-bundle-badgroup-');
    writeFileSync(join(rejected, MANIFEST_FILE_NAME), `${JSON.stringify({
      version: 1,
      releaseGroup: bad,
      documents: [document('profiles/sample/v1', digestA)],
    }, null, 2)}\n`, 'utf8');
    assert.throws(
      () => buildProfileHostBundle({
        profileRoot: rejected,
        outDir: temporaryDirectory('jinn-host-bundle-badgroup-out-'),
      }),
      /release group/u,
      `expected release group ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test('parseArgs accumulates repeated --root and requires one --out', () => {
  assert.deepEqual(parseArgs(['--root', 'a', '--out', 'd']), { profileRoots: ['a'], outDir: 'd' });
  assert.deepEqual(parseArgs(['--root', 'a', '--root', 'b', '--out', 'd']), { profileRoots: ['a', 'b'], outDir: 'd' });
  assert.throws(() => parseArgs(['--out', 'd']), /--root/u);
  assert.throws(() => parseArgs(['--root', 'a']), /--out/u);
  assert.throws(() => parseArgs(['--root', 'a', '--out', 'd', '--out', 'e']), /--out/u);
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown argument/u);
  assert.throws(() => parseArgs(['--root']), /requires a value/u);
});

test('two profile roots merge into one bundle, each manifest under its own group', () => {
  const sealed = realProfileRoot();
  const implementations = implementationsProfileRoot();
  const out = temporaryDirectory('jinn-host-bundle-merged-');
  const result = buildProfileHostBundle({ profileRoots: [sealed, implementations], outDir: out });

  const groups = [[sealed, SEALED_GROUP], [implementations, IMPLEMENTATIONS_GROUP]];
  let documentCount = 0;
  for (const [root, group] of groups) {
    assert.ok(existsSync(join(out, group, MANIFEST_FILE_NAME)), `${group} manifest is missing`);
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE_NAME), 'utf8'));
    documentCount += manifest.documents.length;
    for (const { path } of manifest.documents) {
      assert.equal(
        Buffer.compare(
          readFileSync(join(root, ...path.split('/'))),
          readFileSync(join(out, ...path.split('/'))),
        ),
        0,
        `${group} document ${path} is not the attested bytes`,
      );
    }
  }
  assert.ok(!existsSync(join(out, MANIFEST_FILE_NAME)), 'a merged bundle has no root manifest to collide on');
  assert.ok(documentCount > 700, `expected both real surfaces, saw ${documentCount} documents`);

  const config = JSON.parse(readFileSync(join(out, HOST_CONFIG_FILE_NAME), 'utf8'));
  // Two unsigned roots: every document, plus one manifest route per group.
  assert.equal(config.headers.length, documentCount + 2);
  assert.equal(result.routeCount, config.headers.length);
  assert.equal(result.documentCount, documentCount);
  assert.deepEqual(result.groups, [IMPLEMENTATIONS_GROUP, SEALED_GROUP]);
  const sources = config.headers.map(({ source: path }) => path);
  assert.equal(new Set(sources).size, sources.length, 'a repeated source is an ambiguous route');
  assert.deepEqual(routeWarnings(config.headers.length), [], 'the merged route count is still well under the cap');
  assert.deepEqual(result.warnings, []);
});

test('a document claiming a bundle-root manifest path is refused', () => {
  // Before the root files were namespaced, hostConfig's root-collision check refused this.
  // Now nothing else would: the paths no longer collide, and the gate's must-404 probe at
  // the origin root depends on no group being able to put a manifest there.
  for (const reserved of [MANIFEST_FILE_NAME, SIGNATURE_FILE_NAME]) {
    const root = syntheticRoot(`group-reserving-${reserved.split('.')[1]}`, [[reserved, '{\n  "a": 1\n}\n']]);
    const out = temporaryDirectory('jinn-host-bundle-reserved-out-');
    assert.throws(
      () => buildProfileHostBundle({ profileRoot: root, outDir: out }),
      /bundle root is reserved/u,
      `expected a document at ${reserved} to be refused`,
    );
    assert.deepEqual(readdirSync(out), [], 'a refused build must write nothing at all');
  }
});

test('a document path claimed by two release groups is refused, naming both', () => {
  const shared = 'profiles/shared/v1';
  const first = syntheticRoot('group-alpha', [[shared, '{\n  "a": 1\n}\n']]);
  const second = syntheticRoot('group-beta', [[shared, '{\n  "b": 2\n}\n']]);
  const out = temporaryDirectory('jinn-host-bundle-collision-out-');
  assert.throws(
    () => buildProfileHostBundle({ profileRoots: [first, second], outDir: out }),
    (error) => (
      error.message.includes('group-alpha')
      && error.message.includes('group-beta')
      && error.message.includes(shared)
    ),
  );
  assert.deepEqual(readdirSync(out), [], 'a refused merge must write nothing at all');
});
