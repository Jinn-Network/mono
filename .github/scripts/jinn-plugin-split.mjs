#!/usr/bin/env node
// Zero-dependency Node 22 helper for the jinn-plugin split-and-mirror workflow.
//
// Purpose: mirror `plugin/frozen/` (in Jinn-Network/mono) to the
// ROOT of the slim release repo `Jinn-Network/jinn-plugin` so that
// `hermes plugins install Jinn-Network/jinn-plugin` (a git clone) yields a
// working plugin. The
// mirror is a deterministic CONTENT-MIRROR (not `git subtree split`): the
// plugin-dir contents become the slim ROOT, deletions are reflected, and an
// unchanged plugin tree produces no new slim commit (idempotent no-op).
//
// Charter Decision 3 (BINDING): NO layer artifact rides the split. The plugin
// dir is published verbatim; the published plugin references the future
// @jinn-network/jinn-layer (C6). Nothing here packages npm/layer artifacts.
//
// The offline-testable functions (validatePluginDir, mirrorContent,
// writeProvenance, treeChanged, buildCommitMessage) plus the local
// orchestrator `run()` are exported and never call process.exit, so the test
// suite drives them offline against temp git repos. Only buildCommitMessage and
// validatePluginDir are genuinely pure; the rest touch the filesystem or a
// local (non-auth) git repo but need no token, network, or process.exit.
// `run()` may call git in slimDir (a local op) but does
// no GitHub-specific side effect. The CLI entry is guarded so `import` is
// side-effect-free; only the CLI block may exit or touch $GITHUB_OUTPUT.

import {
  existsSync,
  statSync,
  realpathSync,
  readdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROVENANCE_FILE = '.jinn-split-source';
const DEFAULT_KEEP = ['.git', PROVENANCE_FILE];

// --- offline-testable logic (exported; free of auth, network, process.exit) --
// These functions are driven by the test suite against temp git repos. Only
// buildCommitMessage and validatePluginDir are genuinely pure; mirrorContent
// (rm+cp), write/inspectProvenance (write/read a file), and treeChanged
// (shells to non-auth git) touch the filesystem or a local repo, but none
// require a GitHub token, network, or process.exit — the auth-git-in-YAML vs
// non-auth-git-in-helper seam. The local orchestrator run() is exported too.

/**
 * Assert the source plugin dir exists and holds the required `plugin.yaml`
 * sentinel. Guards a mono refactor that moves/renames the dir — the split must
 * go RED, never silently publish an empty repo.
 * @param {string} pluginDirPath
 * @returns {string} the path, on success
 * @throws {Error} with a message naming the path (and the missing sentinel)
 */
export function validatePluginDir(pluginDirPath) {
  if (!existsSync(pluginDirPath) || !statSync(pluginDirPath).isDirectory()) {
    throw new Error(`plugin dir not found: ${pluginDirPath} does not exist (or is not a directory)`);
  }
  const sentinel = path.join(pluginDirPath, 'plugin.yaml');
  if (!existsSync(sentinel)) {
    throw new Error(`plugin dir ${pluginDirPath} is missing the required plugin.yaml sentinel`);
  }
  return pluginDirPath;
}

/**
 * Require an unambiguous full Git commit id before it can enter provenance or
 * a commit message.
 * @param {string} monoSha
 * @returns {string}
 */
export function validateMonoSha(monoSha) {
  if (!/^[0-9a-f]{40}$/i.test(monoSha)) {
    throw new Error(`MONO_SHA is not a 40-hex commit SHA: ${monoSha}`);
  }
  return monoSha;
}

/**
 * Guard the destructive mirror destination. It must be the root of a real Git
 * worktree, and it must be disjoint from the source in both directions.
 * Canonical paths prevent symlinks from bypassing the overlap check.
 * @param {string} pluginDir
 * @param {string} slimCheckout
 * @returns {string} canonical destination path
 */
export function validateMirrorDestination(pluginDir, slimCheckout) {
  if (!existsSync(slimCheckout) || !statSync(slimCheckout).isDirectory()) {
    throw new Error(`slim destination is not a Git worktree: ${slimCheckout}`);
  }

  const source = realpathSync(pluginDir);
  const destination = realpathSync(slimCheckout);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (contains(source, destination) || contains(destination, source)) {
    throw new Error(`plugin source and slim destination overlap: ${source} <> ${destination}`);
  }

  let worktreeRoot;
  try {
    worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: destination,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`slim destination is not a Git worktree: ${destination}`);
  }
  if (realpathSync(worktreeRoot) !== destination) {
    throw new Error(`slim destination must be the Git worktree root: ${destination}`);
  }
  return destination;
}

/**
 * Mirror (not overlay) the full contents of `pluginDir` into `slimCheckout`:
 * remove every top-level slim entry not in DEFAULT_KEEP, then recursively copy
 * the plugin-dir tree in. Result: slim tree === plugin tree + kept files. Does
 * NOT run git itself — the CLI orchestrator (run()) does the staging
 * (`git add -A`); this helper only rearranges files on disk.
 * @param {string} pluginDir
 * @param {string} slimCheckout
 * @param {{ keep?: string[] }} [opts]
 */
export function mirrorContent(pluginDir, slimCheckout, { keep = DEFAULT_KEEP } = {}) {
  for (const entry of readdirSync(slimCheckout)) {
    if (keep.includes(entry)) continue;
    rmSync(path.join(slimCheckout, entry), { recursive: true, force: true });
  }
  cpSync(pluginDir, slimCheckout, { recursive: true });
}

/**
 * Write the single provenance marker at the slim ROOT. It is deterministic for
 * the same promotion (no timestamps). run() calls it after a plugin-content
 * change or a one-time marker-contract repair. A later same-content promotion
 * with a canonical marker does not rewrite provenance merely because its mono
 * SHA differs.
 * @param {string} slimCheckout
 * @param {{ monoSha: string, workflowPath: string }} fields
 */
export function writeProvenance(slimCheckout, { monoSha, workflowPath }) {
  const content = [
    `source: Jinn-Network/mono@${monoSha}`,
    `generated-by: ${workflowPath}`,
    '',
  ].join('\n');
  writeFileSync(path.join(slimCheckout, PROVENANCE_FILE), content);
}

/**
 * Inspect the existing marker without trusting malformed content. Preserve a
 * source SHA only when the marker matches the complete canonical contract or
 * the one complete legacy contract emitted by this workflow. Missing,
 * duplicate, or otherwise malformed markers fall back to the current mono SHA
 * in run(), whose mirrored tree was just verified equivalent.
 * @param {string} slimCheckout
 * @param {string} workflowPath
 * @returns {{ canonical: boolean, sourceSha: string | null }}
 */
export function inspectProvenance(slimCheckout, workflowPath) {
  const provenancePath = path.join(slimCheckout, PROVENANCE_FILE);
  if (!existsSync(provenancePath)) {
    return { canonical: false, sourceSha: null };
  }

  const content = readFileSync(provenancePath, 'utf8');
  const withoutOneFinalNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = withoutOneFinalNewline.split('\n');
  const sourcePattern = /^source: Jinn-Network\/mono@([0-9a-fA-F]{40})$/;
  const sourceMatches = lines
    .map((line) => sourcePattern.exec(line))
    .filter((match) => match !== null);
  const exactSourceLine = sourceMatches.length === 1 && lines[0] === sourceMatches[0][0];
  const exactGeneratorLine = lines[1] === `generated-by: ${workflowPath}`;
  const canonical =
    lines.length === 2 &&
    exactSourceLine &&
    exactGeneratorLine;
  // The legacy third line is a HISTORICAL contract: it is the exact text an
  // earlier workflow generation wrote into the slim repo. It names the adapter's
  // pre-relocation path on purpose and must never be re-pointed.
  const knownLegacy =
    lines.length === 3 &&
    exactSourceLine &&
    exactGeneratorLine &&
    lines[2] === 'DO NOT EDIT HERE — edit apps/jinn-agent/plugins/jinn/ in Jinn-Network/mono.';
  const sourceSha = canonical || knownLegacy ? sourceMatches[0][1] : null;
  return { canonical, sourceSha };
}

/**
 * Idempotency oracle: is there any staged/unstaged change in the slim repo?
 * The caller must have run `git add -A` first so deletions register.
 * @param {string} slimCheckout
 * @returns {boolean}
 */
export function treeChanged(slimCheckout) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: slimCheckout, encoding: 'utf8' });
  return out.trim().length > 0;
}

/**
 * Pure commit-message builder. The mono SHA is complete, unambiguous provenance.
 * @param {{ monoSha: string }} fields
 * @returns {string}
 */
export function buildCommitMessage({ monoSha }) {
  return [
    `chore(plugin-split): mirror plugin/frozen @ ${monoSha}`,
    '',
    `Source: Jinn-Network/mono@${monoSha}`,
    'Generated by .github/workflows/jinn-plugin-split.yml — edit in mono, not here.',
  ].join('\n');
}

/**
 * Local orchestrator: validate → mirror → stage → detect plugin-content change
 * → update provenance + commit when content changed OR provenance needs one
 * repair (all in slimDir). A later same-content promotion with canonical
 * provenance retains the last content-changing source and creates no commit.
 * `git commit` on a local checkout needs no token, so it folds in here; only
 * `git push` (in the YAML) is privileged. Pure of GitHub-specific side effects
 * — no `::error::`, no `process.exit`, no `$GITHUB_OUTPUT`.
 * @param {{ pluginDir: string, slimDir: string, monoSha: string, workflowPath: string }} args
 * @returns {{ changed: boolean, message: string }}
 */
export function run({ pluginDir, slimDir, monoSha, workflowPath }) {
  validateMonoSha(monoSha);
  validatePluginDir(pluginDir);
  validateMirrorDestination(pluginDir, slimDir);
  mirrorContent(pluginDir, slimDir);
  execFileSync('git', ['add', '-A'], { cwd: slimDir });

  const contentChanged = treeChanged(slimDir);
  const provenance = inspectProvenance(slimDir, workflowPath);
  const changed = contentChanged || !provenance.canonical;
  const message = buildCommitMessage({ monoSha });
  if (changed) {
    writeProvenance(slimDir, {
      monoSha: contentChanged ? monoSha : (provenance.sourceSha ?? monoSha),
      workflowPath,
    });
    execFileSync('git', ['add', '-A'], { cwd: slimDir });
    execFileSync('git', ['commit', '-F', '-'], { cwd: slimDir, input: message });
  }
  return { changed, message };
}

// --- CLI entry (guarded so `import` is side-effect-free) ---------------------
//
// Thin env→args adapter around run(): read env, call run() (validate → mirror →
// provenance → local commit), and translate the outcome to GitHub Actions
// signals ($GITHUB_OUTPUT + ::notice::/::error::). The privileged `git push`
// stays in the YAML, gated on the emitted `changed`.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pluginDir = process.env.PLUGIN_DIR ?? 'plugin/frozen';
  const slimDir = process.env.SLIM_DIR ?? 'slim';
  const monoSha = process.env.MONO_SHA ?? '';
  const workflowPath = process.env.WORKFLOW_PATH ?? '.github/workflows/jinn-plugin-split.yml';

  let changed;
  try {
    ({ changed } = run({ pluginDir, slimDir, monoSha, workflowPath }));
  } catch (e) {
    console.log(`::error::${e?.message ?? e}`);
    process.exit(1);
  }

  // Machine-readable signal for the YAML PUSH step to branch on.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
  console.log(`changed=${changed}`);
  console.log(changed ? '::notice::slim tree changed — committed the mirror' : '::notice::slim tree unchanged — idempotent no-op');
}
