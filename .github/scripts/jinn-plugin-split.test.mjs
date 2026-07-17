// node --test suite for jinn-plugin-split.mjs — zero-dependency, offline.
//
// All fixtures are real temp git repos built in the test with `git init` (no
// network). Proves the mirror decision logic: first-commit, idempotent no-op,
// deletion handling, missing-dir fail-fast, commit-message + provenance shape.
// Run: `cd .github/scripts && node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  validatePluginDir,
  mirrorContent,
  writeProvenance,
  treeChanged,
  buildCommitMessage,
  run,
} from './jinn-plugin-split.mjs';

// --- temp-repo helpers ------------------------------------------------------

const KEEP = ['.git', '.jinn-split-source'];

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Create a temp source plugin dir with the given { relPath: content } map.
 *  Always writes plugin.yaml; a nested skin/foo proves mirrorContent recurses. */
function makePluginDir(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-plugin-src-'));
  const merged = {
    'plugin.yaml': 'name: jinn\nversion: 0.0.0\n',
    'skin/foo': 'nested-skin-content\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(merged)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** git init a temp "slim" repo with an initial commit so it has a HEAD. */
function makeSlimRepo(initialFiles = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-plugin-slim-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const files = { 'OLD.md': 'stale slim content\n', ...initialFiles };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

const PROV = {
  monoSha: 'abc123def456',
  workflowPath: '.github/workflows/jinn-plugin-split.yml',
};

/** Count commits reachable from HEAD in a git repo. */
function commitCount(dir) {
  return git(dir, ['rev-list', '--count', 'HEAD']).trim();
}

// --- (a) first mirror of a fresh slim repo → tree changed → commit happens ---

test('(a) first mirror: tree changes, plugin files land at slim ROOT verbatim', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    mirrorContent(pluginDir, slim, { keep: KEEP });
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);

    assert.equal(treeChanged(slim), true, 'a fresh mirror must register as changed');

    // Commit, then assert files exist at ROOT.
    git(slim, ['commit', '-q', '-m', 'mirror']);
    assert.ok(existsSync(path.join(slim, 'plugin.yaml')), 'plugin.yaml at slim ROOT');
    assert.equal(
      readFileSync(path.join(slim, 'plugin.yaml'), 'utf8'),
      readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8'),
      'plugin.yaml content mirrored verbatim',
    );
    // nested subdir recursed
    assert.ok(existsSync(path.join(slim, 'skin', 'foo')), 'nested skin/foo mirrored');
    assert.equal(readFileSync(path.join(slim, 'skin', 'foo'), 'utf8'), 'nested-skin-content\n');
    // pre-existing slim-only file removed (mirror, not overlay)
    assert.ok(!existsSync(path.join(slim, 'OLD.md')), 'stale slim file removed by mirror');
    // .git survived the wipe
    assert.ok(existsSync(path.join(slim, '.git')), '.git preserved');
  } finally {
    cleanup(pluginDir, slim);
  }
});

// --- (b) second mirror of identical content → treeChanged false (idempotency) -

test('(b) idempotent no-op: re-mirroring identical content leaves treeChanged false', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    mirrorContent(pluginDir, slim, { keep: KEEP });
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'mirror']);

    // Re-run with identical inputs.
    mirrorContent(pluginDir, slim, { keep: KEEP });
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);

    assert.equal(treeChanged(slim), false, 'identical content must be an idempotent no-op');
  } finally {
    cleanup(pluginDir, slim);
  }
});

// --- (c) deletion handling: file removed in source → removed in slim ---------

test('(c) deletion: a file removed from the plugin dir is removed from the slim mirror', () => {
  const pluginDir = makePluginDir({ 'README.md': 'readme\n' });
  const slim = makeSlimRepo();
  try {
    mirrorContent(pluginDir, slim, { keep: KEEP });
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'mirror']);

    // Delete files (top-level and nested) from the source.
    rmSync(path.join(pluginDir, 'README.md'));
    rmSync(path.join(pluginDir, 'skin', 'foo'));

    mirrorContent(pluginDir, slim, { keep: KEEP });
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);

    assert.ok(!existsSync(path.join(slim, 'README.md')), 'deleted top-level file gone from slim');
    assert.ok(!existsSync(path.join(slim, 'skin', 'foo')), 'deleted nested file gone from slim');
    assert.equal(treeChanged(slim), true, 'a deletion is a change');
  } finally {
    cleanup(pluginDir, slim);
  }
});

// --- (d) missing / renamed plugin dir → validatePluginDir throws clearly -----

test('(d1) validatePluginDir throws on a nonexistent dir, naming the path', () => {
  assert.throws(
    () => validatePluginDir('/nonexistent/plugin/path'),
    /\/nonexistent\/plugin\/path/,
  );
  assert.throws(
    () => validatePluginDir('/nonexistent/plugin/path'),
    /not found|missing|does not exist/i,
  );
});

test('(d2) validatePluginDir throws when plugin.yaml is absent, naming the sentinel', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jinn-plugin-nosentinel-'));
  try {
    writeFileSync(path.join(dir, 'something.py'), 'x\n');
    assert.throws(() => validatePluginDir(dir), /plugin\.yaml/i);
  } finally {
    cleanup(dir);
  }
});

test('(d3) validatePluginDir succeeds on a valid plugin dir', () => {
  const pluginDir = makePluginDir();
  try {
    assert.doesNotThrow(() => validatePluginDir(pluginDir));
  } finally {
    cleanup(pluginDir);
  }
});

// --- (e) buildCommitMessage is the exact expected string --------------------

test('(e) buildCommitMessage produces the canonical string from the mono SHA', () => {
  const msg = buildCommitMessage({ monoSha: 'abc123' });
  assert.equal(
    msg,
    [
      'chore(plugin-split): mirror apps/jinn-agent/plugins/jinn @ abc123',
      '',
      'Source: Jinn-Network/mono@abc123',
      'Generated by .github/workflows/jinn-plugin-split.yml — edit in mono, not here.',
    ].join('\n'),
  );
});

// --- (f) provenance file content ---------------------------------------------

test('(f) writeProvenance emits .jinn-split-source at ROOT with sha/path/do-not-edit', () => {
  const slim = makeSlimRepo();
  try {
    writeProvenance(slim, PROV);
    const provPath = path.join(slim, '.jinn-split-source');
    assert.ok(existsSync(provPath), '.jinn-split-source at slim ROOT');
    const content = readFileSync(provPath, 'utf8');
    assert.match(content, /abc123def456/, 'contains the mono SHA');
    assert.doesNotMatch(content, /release:/, 'no release: line (tag axis dropped)');
    assert.match(content, /\.github\/workflows\/jinn-plugin-split\.yml/, 'contains the workflow path');
    assert.match(content, /do not edit here/i, 'contains a do-not-edit line');
  } finally {
    cleanup(slim);
  }
});

test('(f2) writeProvenance is deterministic (no timestamps → idempotent)', () => {
  const slim = makeSlimRepo();
  try {
    writeProvenance(slim, PROV);
    const first = readFileSync(path.join(slim, '.jinn-split-source'), 'utf8');
    writeProvenance(slim, PROV);
    const second = readFileSync(path.join(slim, '.jinn-split-source'), 'utf8');
    assert.equal(first, second, 'identical inputs → identical provenance file');
  } finally {
    cleanup(slim);
  }
});

// --- (g) run() end-to-end: commits on first run, no-op on identical re-run ----

test('(g) run() commits the mirror on first run, then is an idempotent no-op', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    const before = commitCount(slim);

    // First run: mirror + commit.
    const first = run({ ...PROV, pluginDir, slimDir: slim });
    assert.equal(first.changed, true, 'first run registers a change');
    assert.equal(commitCount(slim), String(Number(before) + 1), 'first run adds one commit');
    // Plugin files (incl. nested skin/foo) land at slim ROOT.
    assert.ok(existsSync(path.join(slim, 'plugin.yaml')), 'plugin.yaml at slim ROOT');
    assert.ok(existsSync(path.join(slim, 'skin', 'foo')), 'nested skin/foo at slim ROOT');
    assert.ok(!existsSync(path.join(slim, 'OLD.md')), 'stale slim file removed by mirror');

    const afterFirst = commitCount(slim);

    // Second identical run: no new commit.
    const second = run({ ...PROV, pluginDir, slimDir: slim });
    assert.equal(second.changed, false, 'identical re-run is a no-op');
    assert.equal(commitCount(slim), afterFirst, 'no new commit on the idempotent re-run');
  } finally {
    cleanup(pluginDir, slim);
  }
});
