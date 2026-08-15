// node --test suite for jinn-plugin-split.mjs — zero-dependency, offline.
//
// All fixtures are real temp git repos built in the test with `git init` (no
// network). Proves the mirror decision logic: first-commit, idempotent no-op,
// deletion handling, missing-dir fail-fast, commit-message + provenance shape.
// Run: `cd .github/scripts && node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as split from './jinn-plugin-split.mjs';

const {
  validatePluginDir,
  mirrorContent,
  writeProvenance,
  treeChanged,
  buildCommitMessage,
  run,
} = split;

// --- temp-repo helpers ------------------------------------------------------

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
  monoSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  workflowPath: '.github/workflows/jinn-plugin-split.yml',
};
const NEXT_PROV = {
  ...PROV,
  monoSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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
    mirrorContent(pluginDir, slim);
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
    mirrorContent(pluginDir, slim);
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'mirror']);

    // Re-run with identical inputs.
    mirrorContent(pluginDir, slim);
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
    mirrorContent(pluginDir, slim);
    writeProvenance(slim, PROV);
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'mirror']);

    // Delete files (top-level and nested) from the source.
    rmSync(path.join(pluginDir, 'README.md'));
    rmSync(path.join(pluginDir, 'skin', 'foo'));

    mirrorContent(pluginDir, slim);
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
      'chore(plugin-split): mirror plugin/frozen @ abc123',
      '',
      'Source: Jinn-Network/mono@abc123',
      'Generated by .github/workflows/jinn-plugin-split.yml — edit in mono, not here.',
    ].join('\n'),
  );
});

// --- (f) provenance file content ---------------------------------------------

test('(f) writeProvenance emits the exact two-line source/generator contract at ROOT', () => {
  const slim = makeSlimRepo();
  try {
    writeProvenance(slim, PROV);
    const provPath = path.join(slim, '.jinn-split-source');
    assert.ok(existsSync(provPath), '.jinn-split-source at slim ROOT');
    const content = readFileSync(provPath, 'utf8');
    assert.equal(
      content,
      `source: Jinn-Network/mono@${PROV.monoSha}\n` +
        `generated-by: ${PROV.workflowPath}\n`,
      'provenance is exactly the source and generator contract',
    );
  } finally {
    cleanup(slim);
  }
});

test('(f2) writeProvenance is deterministic within the same promotion', () => {
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

test('(h) identical plugin content at a new mono SHA preserves provenance and creates no commit', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    run({ ...PROV, pluginDir, slimDir: slim });
    const afterFirst = commitCount(slim);
    const originalProvenance = readFileSync(path.join(slim, '.jinn-split-source'), 'utf8');

    const second = run({ ...NEXT_PROV, pluginDir, slimDir: slim });

    assert.equal(second.changed, false);
    assert.equal(commitCount(slim), afterFirst, 'same plugin content must not create a commit');
    assert.equal(
      readFileSync(path.join(slim, '.jinn-split-source'), 'utf8'),
      originalProvenance,
      'provenance describes the promotion that last changed plugin content',
    );
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(h2) identical plugin content repairs a legacy three-line provenance marker once', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    run({ ...PROV, pluginDir, slimDir: slim });
    const legacy = [
      `source: Jinn-Network/mono@${PROV.monoSha}`,
      `generated-by: ${PROV.workflowPath}`,
      'DO NOT EDIT HERE — edit apps/jinn-agent/plugins/jinn/ in Jinn-Network/mono.',
      '',
    ].join('\n');
    writeFileSync(path.join(slim, '.jinn-split-source'), legacy);
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'legacy provenance fixture']);
    const beforeRepair = commitCount(slim);

    const repair = run({ ...NEXT_PROV, pluginDir, slimDir: slim });

    assert.equal(repair.changed, true, 'legacy provenance must produce one repair commit');
    assert.equal(commitCount(slim), String(Number(beforeRepair) + 1));
    assert.equal(
      readFileSync(path.join(slim, '.jinn-split-source'), 'utf8'),
      `source: Jinn-Network/mono@${PROV.monoSha}\n` +
        `generated-by: ${PROV.workflowPath}\n`,
      'repair preserves the last valid source SHA while normalizing the contract',
    );

    const idempotent = run({ ...NEXT_PROV, pluginDir, slimDir: slim });
    assert.equal(idempotent.changed, false, 'canonical repaired provenance must then no-op');
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(h2b) malformed provenance repair uses the current mono SHA, never an embedded SHA', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    run({ ...PROV, pluginDir, slimDir: slim });
    const attackerSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const malformed = [
      `source: Jinn-Network/mono@${attackerSha}`,
      'generated-by: attacker',
      'UNTRUSTED TEXT',
      '',
    ].join('\n');
    writeFileSync(path.join(slim, '.jinn-split-source'), malformed);
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'malformed provenance fixture']);

    const repair = run({ ...NEXT_PROV, pluginDir, slimDir: slim });

    assert.equal(repair.changed, true, 'malformed provenance must produce one repair commit');
    assert.equal(
      readFileSync(path.join(slim, '.jinn-split-source'), 'utf8'),
      `source: Jinn-Network/mono@${NEXT_PROV.monoSha}\n` +
        `generated-by: ${NEXT_PROV.workflowPath}\n`,
      'repair must bind malformed provenance to the currently validated mono SHA',
    );
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(h3) identical plugin content recreates missing provenance from the current mono SHA', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    run({ ...PROV, pluginDir, slimDir: slim });
    rmSync(path.join(slim, '.jinn-split-source'));
    git(slim, ['add', '-A']);
    git(slim, ['commit', '-q', '-m', 'missing provenance fixture']);
    const beforeRepair = commitCount(slim);

    const repair = run({ ...NEXT_PROV, pluginDir, slimDir: slim });

    assert.equal(repair.changed, true, 'missing provenance must produce one repair commit');
    assert.equal(commitCount(slim), String(Number(beforeRepair) + 1));
    assert.equal(
      readFileSync(path.join(slim, '.jinn-split-source'), 'utf8'),
      `source: Jinn-Network/mono@${NEXT_PROV.monoSha}\n` +
        `generated-by: ${NEXT_PROV.workflowPath}\n`,
    );
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(i) validateMirrorDestination requires the destination to be a Git worktree root', () => {
  const pluginDir = makePluginDir();
  const plainDir = mkdtempSync(path.join(tmpdir(), 'jinn-plugin-not-git-'));
  try {
    assert.throws(
      () => split.validateMirrorDestination(pluginDir, plainDir),
      /Git worktree/i,
    );
  } finally {
    cleanup(pluginDir, plainDir);
  }
});

test('(j) validateMirrorDestination rejects equal and overlapping source/destination paths', () => {
  const pluginDir = makePluginDir();
  git(pluginDir, ['init', '-q']);
  const nestedPlugin = path.join(pluginDir, 'nested-plugin');
  mkdirSync(nestedPlugin);
  writeFileSync(path.join(nestedPlugin, 'plugin.yaml'), 'name: nested\n');

  const slim = makeSlimRepo();
  const nestedSlim = path.join(pluginDir, 'nested-slim');
  mkdirSync(nestedSlim);
  git(nestedSlim, ['init', '-q']);
  try {
    assert.throws(() => split.validateMirrorDestination(pluginDir, pluginDir), /overlap/i);
    assert.throws(() => split.validateMirrorDestination(nestedPlugin, pluginDir), /overlap/i);
    assert.throws(() => split.validateMirrorDestination(pluginDir, nestedSlim), /overlap/i);
    assert.doesNotThrow(() => split.validateMirrorDestination(pluginDir, slim));
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(k) run requires a 40-hex MONO_SHA before touching the destination', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    assert.throws(
      () => run({ ...PROV, monoSha: '', pluginDir, slimDir: slim }),
      /MONO_SHA.*40-hex/i,
    );
    assert.throws(
      () => split.validateMonoSha('abc123'),
      /MONO_SHA.*40-hex/i,
    );
    assert.ok(existsSync(path.join(slim, 'OLD.md')), 'validation must precede mirror deletion');
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(k2) CLI fails loud when MONO_SHA is absent and leaves the destination untouched', () => {
  const pluginDir = makePluginDir();
  const slim = makeSlimRepo();
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./jinn-plugin-split.mjs', import.meta.url))], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PLUGIN_DIR: pluginDir,
        SLIM_DIR: slim,
        MONO_SHA: '',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::MONO_SHA is not a 40-hex commit SHA/);
    assert.ok(existsSync(path.join(slim, 'OLD.md')), 'CLI validation must precede mirror deletion');
  } finally {
    cleanup(pluginDir, slim);
  }
});

test('(l) workflow dispatch is token-free dry-run; only a main push can publish', () => {
  const workflow = readFileSync(
    new URL('../workflows/jinn-plugin-split.yml', import.meta.url),
    'utf8',
  );

  assert.match(
    workflow,
    /PUBLISH:\s*\$\{\{\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s*\}\}/,
    'publish eligibility must be derived exclusively from the triggering event and exact ref',
  );
  assert.doesNotMatch(workflow, /inputs\.dry_run|DRY_RUN/);
  assert.match(
    workflow,
    /ref:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && inputs\.source_ref \|\| github\.sha\s*\}\}/,
    'source_ref must only affect manual dry-runs',
  );

  const jobEnv = workflow.match(/jobs:\n[\s\S]*?\n    env:\n([\s\S]*?)\n    steps:/)?.[1] ?? '';
  assert.doesNotMatch(jobEnv, /JINN_PLUGIN_PUSH_TOKEN|secrets\./);

  const slimCheckout = workflow.match(/- name: Checkout the slim repo\n([\s\S]*?)(?=\n      - name:)/)?.[1] ?? '';
  assert.match(slimCheckout, /persist-credentials:\s*false/);
  assert.doesNotMatch(slimCheckout, /JINN_PLUGIN_PUSH_TOKEN|secrets\./);

  const tokenGuard = workflow.match(/- name: Token guard[\s\S]*?(?=\n      - name:)/)?.[0] ?? '';
  assert.match(tokenGuard, /if:\s*env\.PUBLISH == 'true'/);
  assert.match(tokenGuard, /JINN_PLUGIN_PUSH_TOKEN:\s*\$\{\{\s*secrets\.JINN_PLUGIN_PUSH_TOKEN\s*\}\}/);

  const pushStep = workflow.match(/- name: Push to the slim[\s\S]*$/)?.[0] ?? '';
  assert.match(pushStep, /if:\s*env\.PUBLISH == 'true'/);
  assert.match(pushStep, /JINN_PLUGIN_PUSH_TOKEN:\s*\$\{\{\s*secrets\.JINN_PLUGIN_PUSH_TOKEN\s*\}\}/);
  assert.match(pushStep, /https:\/\/github\.com\/Jinn-Network\/jinn-plugin\.git/);
  assert.match(pushStep, /HEAD:refs\/heads\/main/);
  assert.doesNotMatch(pushStep, /DEFAULT_BRANCH/);
  assert.equal(
    workflow.match(/secrets\.JINN_PLUGIN_PUSH_TOKEN/g)?.length,
    2,
    'the write token may appear only in the explicit guard and final push steps',
  );
});
