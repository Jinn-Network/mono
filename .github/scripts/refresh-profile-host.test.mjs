// node --test suite for refresh-profile-host.mjs -- zero-dependency, offline.
//
// Every fixture is a real temp git repo built with `git init` under the OS tmpdir,
// never under the checkout: `node --test` schedules a batch in parallel, and a
// fixture materialized inside the repository is a path `git ls-files` can never
// return for a sibling suite walking the tree. Staying in tmpdir is also what lets
// this suite ride the `platform-release-surface` batch (workflow-script-tests.mjs
// pins the rule).
//
// What it proves: the deploy bundle's fail-closed validations, the mirror's
// replace-don't-overlay contract, and the idempotency rule that keeps a
// same-content push from minting a commit. No network, no token, no host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCommitMessage,
  inspectProvenance,
  mirrorContent,
  run,
  treeChanged,
  validateBundleDir,
  validateHostCheckout,
  validateSourceSha,
  writeProvenance,
} from './refresh-profile-host.mjs';

const HELPER = path.join(import.meta.dirname, 'refresh-profile-host.mjs');
const WORKFLOW_PATH = '.github/workflows/stack-npm-publish.yml';
const SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);

// --- temp-fixture helpers ---------------------------------------------------

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function writeFile(dir, relativePath, content) {
  const absolute = path.join(dir, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/**
 * A deploy bundle in the shape `build-profile-host-bundle.mjs` emits: the generated
 * `vercel.json` sentinel at the root, one `<group>/manifest.json` per release group,
 * and the served documents at their identifier paths.
 */
function makeBundle({
  groups = ['implementations-v1', 'sealed-platform-v1'],
  lane = 'canary',
  commit = SHA,
  documents = { 'schemas/task.schema.json': '{"$id":"task"}\n' },
  manifestOverrides = {},
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-profile-host-bundle-'));
  writeFile(dir, 'vercel.json', '{"headers":[]}\n');
  for (const group of groups) {
    const manifest = {
      generatedFrom: { repository: 'Jinn-Network/mono', commit },
      releaseGroup: group,
      lane,
      documents: Object.keys(documents).map((servedPath) => ({ path: servedPath })),
      ...(manifestOverrides[group] ?? {}),
    };
    writeFile(dir, `${group}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const [servedPath, content] of Object.entries(documents)) {
    writeFile(dir, servedPath, content);
  }
  return dir;
}

/** A host repository with a HEAD, holding whatever the previous refresh left behind. */
function makeHostRepo(initialFiles = { 'stale.json': 'previously published\n' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-profile-host-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [relativePath, content] of Object.entries(initialFiles)) {
    writeFile(dir, relativePath, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function commitCount(dir) {
  return Number(git(dir, ['rev-list', '--count', 'HEAD']).trim());
}

function refresh(bundleDir, hostDir, sourceSha = SHA) {
  return run({ bundleDir, hostDir, sourceSha, workflowPath: WORKFLOW_PATH });
}

// --- the mirror ------------------------------------------------------------

test('first refresh commits the bundle to the host root byte-identically', () => {
  const bundle = makeBundle();
  const host = makeHostRepo();
  const before = commitCount(host);

  const result = refresh(bundle, host);

  assert.equal(result.changed, true);
  assert.equal(commitCount(host), before + 1);
  assert.deepEqual(result.groups, ['implementations-v1', 'sealed-platform-v1']);
  assert.equal(result.lane, 'canary');
  for (const relativePath of [
    'vercel.json',
    'implementations-v1/manifest.json',
    'sealed-platform-v1/manifest.json',
    'schemas/task.schema.json',
  ]) {
    assert.equal(
      readFileSync(path.join(host, relativePath), 'utf8'),
      readFileSync(path.join(bundle, relativePath), 'utf8'),
      `${relativePath} must land byte-identical`,
    );
  }
  cleanup(bundle, host);
});

test('a re-run at the same source SHA is an idempotent no-op', () => {
  const host = makeHostRepo();
  const first = makeBundle();
  refresh(first, host);
  const after = commitCount(host);

  // A re-run rebuilds the same bundle from the same commit, so the bytes are identical.
  // Rewriting provenance here would make every refresh look like a content change and
  // destroy idempotency outright.
  const rerun = makeBundle();
  const result = refresh(rerun, host);

  assert.equal(result.changed, false);
  assert.equal(commitCount(host), after, 'a re-run must not mint a duplicate host commit');
  assert.match(
    readFileSync(path.join(host, '.jinn-profile-host-source'), 'utf8'),
    new RegExp(`^source: Jinn-Network/mono@${SHA}$`, 'mu'),
    'the last content-changing source SHA is retained',
  );
  cleanup(first, rerun, host);
});

test('a new source SHA is a content change, because every group manifest names the commit', () => {
  // `build-profile-root.mjs` writes `generatedFrom.commit` (and the catalog digest) into
  // each group's manifest.json, and that manifest is a published byte. So two bundles
  // built from different commits are never byte-identical even when no served document
  // moved, and the no-op above is the re-run case rather than the next-push case. This
  // is asserted rather than assumed: a refresh that treated a new SHA as unchanged would
  // leave the host serving a manifest naming a stale commit, which the live-host gate
  // byte-compares.
  const host = makeHostRepo();
  const first = makeBundle();
  refresh(first, host);
  const after = commitCount(host);

  const documents = { 'schemas/task.schema.json': '{"$id":"task"}\n' };
  const next = makeBundle({ commit: NEXT_SHA, documents });
  const result = refresh(next, host, NEXT_SHA);

  assert.equal(result.changed, true);
  assert.equal(commitCount(host), after + 1);
  assert.equal(
    readFileSync(path.join(host, 'schemas/task.schema.json'), 'utf8'),
    documents['schemas/task.schema.json'],
    'no served document moved; only the commit the manifests name did',
  );
  cleanup(first, next, host);
});

test('a changed document produces exactly one commit naming the new SHA and groups', () => {
  const host = makeHostRepo();
  const first = makeBundle();
  refresh(first, host);
  const after = commitCount(host);

  const second = makeBundle({
    commit: NEXT_SHA,
    documents: { 'schemas/task.schema.json': '{"$id":"task","title":"revised"}\n' },
  });
  const result = refresh(second, host, NEXT_SHA);

  assert.equal(result.changed, true);
  assert.equal(commitCount(host), after + 1);
  const message = git(host, ['log', '-1', '--format=%B']);
  assert.match(message, new RegExp(NEXT_SHA, 'u'));
  assert.match(message, /Release groups: implementations-v1, sealed-platform-v1/u);
  assert.match(
    readFileSync(path.join(host, '.jinn-profile-host-source'), 'utf8'),
    new RegExp(`^source: Jinn-Network/mono@${NEXT_SHA}$`, 'mu'),
  );
  cleanup(first, second, host);
});

test('a document dropped from the bundle is deleted from the host', () => {
  const host = makeHostRepo();
  const first = makeBundle({
    documents: {
      'schemas/task.schema.json': '{"$id":"task"}\n',
      'schemas/withdrawn.schema.json': '{"$id":"withdrawn"}\n',
    },
  });
  refresh(first, host);
  assert.ok(existsSync(path.join(host, 'schemas/withdrawn.schema.json')));

  const second = makeBundle({
    commit: NEXT_SHA,
    documents: { 'schemas/task.schema.json': '{"$id":"task"}\n' },
  });
  const result = refresh(second, host, NEXT_SHA);

  assert.equal(result.changed, true);
  assert.equal(
    existsSync(path.join(host, 'schemas/withdrawn.schema.json')),
    false,
    'a mirror replaces the host tree; an overlay would serve the withdrawn document forever',
  );
  cleanup(first, second, host);
});

test('the mirror keeps .git and the provenance marker and drops a hand-added stray', () => {
  const bundle = makeBundle();
  const host = makeHostRepo();
  refresh(bundle, host);
  writeFile(host, 'HAND-EDITED.md', 'someone edited the generated repo\n');

  mirrorContent(bundle, host);

  assert.ok(existsSync(path.join(host, '.git')), '.git must survive the mirror');
  assert.ok(existsSync(path.join(host, '.jinn-profile-host-source')), 'provenance must survive the mirror');
  assert.equal(existsSync(path.join(host, 'HAND-EDITED.md')), false);
  cleanup(bundle, host);
});

// --- validateBundleDir: the fail-closed gate on public bytes ----------------

test('validateBundleDir refuses a missing directory, a missing sentinel, and a groupless bundle', () => {
  const missing = path.join(tmpdir(), 'jinn-profile-host-absent-directory');
  assert.throws(
    () => validateBundleDir(missing, { sourceSha: SHA }),
    (error) => error.message.includes(missing),
  );

  const noSentinel = makeBundle();
  rmSync(path.join(noSentinel, 'vercel.json'));
  assert.throws(() => validateBundleDir(noSentinel, { sourceSha: SHA }), /vercel\.json/u);

  const noGroups = makeBundle({ groups: [] });
  assert.throws(() => validateBundleDir(noGroups, { sourceSha: SHA }), /release group/u);
  cleanup(noSentinel, noGroups);
});

test('validateBundleDir refuses a bundle whose reserved root carries a manifest', () => {
  for (const reserved of ['manifest.json', 'manifest.dsse.json']) {
    const bundle = makeBundle();
    writeFile(bundle, reserved, '{}\n');
    assert.throws(
      () => validateBundleDir(bundle, { sourceSha: SHA }),
      new RegExp(reserved.replace('.', '\\.'), 'u'),
      `a root ${reserved} must be refused; the live-host gate probes it as a must-404`,
    );
    cleanup(bundle);
  }
});

test('validateBundleDir refuses a manifest whose releaseGroup disagrees with its directory', () => {
  const bundle = makeBundle({ groups: ['sealed-platform-v1'] });
  writeFile(
    bundle,
    'sealed-platform-v1/manifest.json',
    `${JSON.stringify({
      generatedFrom: { commit: SHA },
      releaseGroup: 'implementations-v1',
      lane: 'canary',
      documents: [],
    })}\n`,
  );
  assert.throws(() => validateBundleDir(bundle, { sourceSha: SHA }), /sealed-platform-v1/u);
  cleanup(bundle);
});

test('validateBundleDir refuses groups that disagree on lane or on the source commit', () => {
  const laneSplit = makeBundle({
    manifestOverrides: { 'sealed-platform-v1': { lane: 'stable' } },
  });
  assert.throws(() => validateBundleDir(laneSplit, { sourceSha: SHA }), /lane/u);

  const commitSplit = makeBundle({
    manifestOverrides: {
      'sealed-platform-v1': { generatedFrom: { repository: 'Jinn-Network/mono', commit: NEXT_SHA } },
    },
  });
  assert.throws(() => validateBundleDir(commitSplit, { sourceSha: SHA }), /commit/u);
  cleanup(laneSplit, commitSplit);
});

test('validateBundleDir refuses a bundle built from a different commit than this run publishes', () => {
  // The same-run binding. Without it "we deployed the attested bytes" is trust in
  // the download step rather than a property read out of the copied bytes.
  const bundle = makeBundle({ commit: NEXT_SHA });
  assert.throws(
    () => validateBundleDir(bundle, { sourceSha: SHA }),
    (error) => error.message.includes(SHA) && error.message.includes(NEXT_SHA),
  );
  cleanup(bundle);
});

test('validateBundleDir returns the sorted groups, the agreed lane, and the commit', () => {
  const bundle = makeBundle({ groups: ['sealed-platform-v1', 'implementations-v1'] });
  assert.deepEqual(validateBundleDir(bundle, { sourceSha: SHA }), {
    groups: ['implementations-v1', 'sealed-platform-v1'],
    lane: 'canary',
    sourceCommit: SHA,
  });
  cleanup(bundle);
});

// --- the other guards -------------------------------------------------------

test('validateSourceSha requires an unambiguous 40-hex commit id', () => {
  assert.equal(validateSourceSha(SHA), SHA);
  for (const invalid of ['', 'abc', 'z'.repeat(40), `${SHA}0`]) {
    assert.throws(() => validateSourceSha(invalid), /SOURCE_SHA/u);
  }

  const bundle = makeBundle();
  const host = makeHostRepo();
  const before = git(host, ['rev-parse', 'HEAD']).trim();
  assert.throws(() => refresh(bundle, host, 'not-a-sha'), /SOURCE_SHA/u);
  assert.equal(git(host, ['rev-parse', 'HEAD']).trim(), before, 'the destination is untouched');
  assert.ok(existsSync(path.join(host, 'stale.json')), 'nothing was mirrored before the guard fired');
  cleanup(bundle, host);
});

test('validateHostCheckout requires a disjoint Git worktree root', () => {
  const bundle = makeBundle();
  const host = makeHostRepo();
  assert.equal(validateHostCheckout(bundle, host), realpathSync(host));

  const notGit = mkdtempSync(path.join(tmpdir(), 'jinn-profile-host-plain-'));
  assert.throws(() => validateHostCheckout(bundle, notGit), /Git worktree/u);

  const subdirectory = path.join(host, 'schemas');
  mkdirSync(subdirectory, { recursive: true });
  assert.throws(() => validateHostCheckout(bundle, subdirectory), /worktree root/u);

  assert.throws(() => validateHostCheckout(host, host), /overlap/u);
  const nested = path.join(host, 'nested-bundle');
  mkdirSync(nested, { recursive: true });
  assert.throws(() => validateHostCheckout(nested, host), /overlap/u);

  cleanup(bundle, host, notGit);
});

test('buildCommitMessage names the source SHA, the lane, and the sorted groups', () => {
  assert.equal(
    buildCommitMessage({ sourceSha: SHA, lane: 'canary', groups: ['sealed-platform-v1', 'implementations-v1'] }),
    [
      `chore(profile-host): publish attested profile host @ ${SHA}`,
      '',
      `Source: Jinn-Network/mono@${SHA}`,
      'Lane: canary',
      'Release groups: implementations-v1, sealed-platform-v1',
      'Generated by .github/workflows/stack-npm-publish.yml — edit in mono, not here.',
    ].join('\n'),
  );
});

test('provenance is deterministic for one source SHA and reads back canonically', () => {
  const host = makeHostRepo();
  const fields = { sourceSha: SHA, lane: 'canary', groups: ['sealed-platform-v1', 'implementations-v1'], workflowPath: WORKFLOW_PATH };

  writeProvenance(host, fields);
  const first = readFileSync(path.join(host, '.jinn-profile-host-source'), 'utf8');
  writeProvenance(host, fields);
  assert.equal(readFileSync(path.join(host, '.jinn-profile-host-source'), 'utf8'), first, 'no timestamps');
  assert.equal(first, [
    `source: Jinn-Network/mono@${SHA}`,
    `generated-by: ${WORKFLOW_PATH}`,
    'lane: canary',
    'release-groups: implementations-v1, sealed-platform-v1',
    '',
  ].join('\n'));
  assert.deepEqual(inspectProvenance(host, WORKFLOW_PATH), { canonical: true, sourceSha: SHA });

  for (const malformed of [
    'source: Jinn-Network/mono@nope\n',
    `source: Jinn-Network/mono@${SHA}\n`,
    `source: Jinn-Network/mono@${SHA}\nsource: Jinn-Network/mono@${NEXT_SHA}\ngenerated-by: ${WORKFLOW_PATH}\nlane: canary\nrelease-groups: a\n`,
    `generated-by: ${WORKFLOW_PATH}\nsource: Jinn-Network/mono@${SHA}\nlane: canary\nrelease-groups: a\n`,
    `source: Jinn-Network/mono@${SHA}\ngenerated-by: other.yml\nlane: canary\nrelease-groups: a\n`,
  ]) {
    writeFileSync(path.join(host, '.jinn-profile-host-source'), malformed);
    assert.deepEqual(
      inspectProvenance(host, WORKFLOW_PATH),
      { canonical: false, sourceSha: null },
      `must be non-canonical: ${JSON.stringify(malformed)}`,
    );
  }
  cleanup(host);
});

test('a host whose provenance marker was deleted is repaired without a content change', () => {
  const host = makeHostRepo();
  const bundle = makeBundle();
  refresh(bundle, host);
  const after = commitCount(host);

  rmSync(path.join(host, '.jinn-profile-host-source'));
  git(host, ['add', '-A']);
  git(host, ['commit', '-q', '-m', 'hand-deleted the marker']);

  // Same source SHA, so the mirrored content is unchanged and the only reason to commit
  // is the missing marker. The repair uses the current source SHA, never an embedded one:
  // there is none to trust, and the mirrored tree was just proven equivalent.
  const result = refresh(makeBundle(), host);

  assert.equal(result.changed, true);
  assert.equal(commitCount(host), after + 2, 'exactly one repair commit on top of the hand edit');
  assert.deepEqual(inspectProvenance(host, WORKFLOW_PATH), { canonical: true, sourceSha: SHA });
  cleanup(bundle, host);
});

test('treeChanged is the idempotency oracle over the staged host tree', () => {
  const host = makeHostRepo();
  assert.equal(treeChanged(host), false);
  writeFile(host, 'new.json', '{}\n');
  git(host, ['add', '-A']);
  assert.equal(treeChanged(host), true);
  cleanup(host);
});

// --- the CLI shell ----------------------------------------------------------

test('the CLI fails loudly on a missing SOURCE_SHA and leaves the host untouched', () => {
  const bundle = makeBundle();
  const host = makeHostRepo();
  const before = git(host, ['rev-parse', 'HEAD']).trim();

  const result = spawnSync(process.execPath, [HELPER], {
    encoding: 'utf8',
    env: { ...process.env, BUNDLE_DIR: bundle, HOST_DIR: host, SOURCE_SHA: '', WORKFLOW_PATH },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /::error::/u);
  assert.equal(git(host, ['rev-parse', 'HEAD']).trim(), before);
  cleanup(bundle, host);
});

test('the CLI emits changed= to $GITHUB_OUTPUT and importing the module runs nothing', () => {
  const bundle = makeBundle();
  const host = makeHostRepo();
  const outputFile = path.join(mkdtempSync(path.join(tmpdir(), 'jinn-profile-host-output-')), 'github-output');
  writeFileSync(outputFile, '');

  const result = spawnSync(process.execPath, [HELPER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BUNDLE_DIR: bundle,
      HOST_DIR: host,
      SOURCE_SHA: SHA,
      WORKFLOW_PATH,
      GITHUB_OUTPUT: outputFile,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(outputFile, 'utf8'), /^changed=true$/mu);

  // The import at the top of this file already ran; if the CLI block were
  // unguarded it would have thrown on the absent env before any test started.
  assert.equal(commitCount(host), 2, 'the CLI committed exactly once');
  cleanup(bundle, host, path.dirname(outputFile));
});
