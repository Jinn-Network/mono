#!/usr/bin/env node
// Zero-dependency Node 22 helper for the push-to-`next` profile-host refresh.
//
// Purpose: mirror one already-built deploy bundle -- the output of
// `build-profile-host-bundle.mjs`, itself built from the same run's attested profile
// roots -- to the ROOT of the static host repository, so that merging a changed spec
// document to `next` results in the live origin serving the new bytes with no human
// action. Like the plugin split it is a deterministic CONTENT-MIRROR: the bundle
// becomes the host ROOT, deletions are reflected (a withdrawn document stops being
// served), and an unchanged bundle produces no new host commit.
//
// COPY ONLY. Nothing here authors a served document. The bundle generator digest-checks
// every byte it copies against the attested `manifest.json`, the signature sidecars ride
// in the artifact, and so the manifest signing key is neither needed nor made available
// to the job that runs this. The one thing this file adds to the published tree is the
// provenance marker.
//
// SAME-RUN BINDING. `validateBundleDir` re-reads `generatedFrom.commit` out of the bytes
// about to be published and requires it to equal the commit this run is publishing. That
// makes "we deployed this commit's attested artifact" a property of the copied bytes
// rather than trust in the download step.
//
// The offline-testable functions (validateSourceSha, validateBundleDir,
// validateHostCheckout, mirrorContent, write/inspectProvenance, treeChanged,
// buildCommitMessage) plus the local orchestrator `run()` are exported and never call
// process.exit, so the test suite drives them offline against temp git repos. `run()`
// may call git in the host checkout -- a local op needing no token -- but does no
// GitHub-specific side effect. Only `git push` is privileged, and it stays in the YAML,
// gated on the `changed` this file emits. The CLI entry is guarded so `import` is
// side-effect-free.
//
// The shape -- validate → mirror → stage → detect change → provenance → local commit,
// with auth git in YAML and non-auth git here -- is taken from
// `jinn-plugin-split.mjs`. It is deliberately kept as a sibling rather than a shared
// module: extracting now would couple the plugin *release* path to the protocol *host*
// path, so a change to one publication surface could break the other. A THIRD MIRROR IS
// THE MOMENT TO EXTRACT.

import {
  appendFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { HOST_CONFIG_FILE_NAME, MANIFEST_FILE_NAME } from './build-profile-host-bundle.mjs';
import { hasGitControlSegment } from './public-surface-assets.mjs';
import { SIGNATURE_FILE_NAME } from './sign-profile-manifest.mjs';

const PROVENANCE_FILE = '.jinn-profile-host-source';
// One rule for the run's SHA and for every commit a manifest claims, so the two sides of
// the same-run binding cannot be compared under different notions of "a commit id".
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
// The marker is kept, not re-created, for the same reason the plugin split keeps its
// own: a marker deleted and rewritten every run would carry a different source SHA every
// run, so every push would read as a content change and idempotency would be gone.
const DEFAULT_KEEP = ['.git', PROVENANCE_FILE];

// --- offline-testable logic (exported; free of auth, network, process.exit) --

/**
 * Require an unambiguous full Git commit id before it can enter a same-run binding
 * check, provenance, or a commit message.
 * @param {string} sourceSha
 * @returns {string}
 */
export function validateSourceSha(sourceSha) {
  if (!COMMIT_SHA_PATTERN.test(sourceSha)) {
    throw new Error(`SOURCE_SHA is not a 40-hex commit SHA: ${sourceSha}`);
  }
  return sourceSha;
}

function readGroupManifest(bundleDir, group) {
  const manifestPath = path.join(bundleDir, group, MANIFEST_FILE_NAME);
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`deploy bundle ${group}/${MANIFEST_FILE_NAME} is not readable JSON: ${error?.message ?? String(error)}`);
  }
}

/**
 * Refuse any bundle entry Git reads as control input, at any depth. `mirrorContent` copies
 * with `cpSync`, whose `force` default is true, so a bundle path whose first segment is
 * `.git` is written INTO the host checkout's real `.git` -- and the push step, which is the
 * one step holding the host token, then reads that `.git/config`. A `.gitignore` or
 * `.gitattributes` is the quieter half of the same defect: Git honors it, so the staged
 * tree stops being the mirrored tree and attested documents are silently unpublished while
 * every gate reports success. `DEFAULT_KEEP` protects `.git` from DELETION only; this is
 * what protects it from being written through.
 *
 * The rule itself is `hasGitControlSegment`, shared with the generator that built these
 * bytes. The walk is recursive because the mirror is: a nested entry lands in the host tree
 * just as surely as a root one.
 * @param {string} directory
 * @param {string} prefix
 */
function assertNoGitControlPath(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (hasGitControlSegment(entry.name)) {
      throw new Error(`the deploy bundle carries the Git control path ${relativePath}, which the host checkout would read as control rather than serve`);
    }
    if (entry.isDirectory()) assertNoGitControlPath(path.join(directory, entry.name), relativePath);
  }
}

/**
 * The fail-closed gate on bytes that are about to become public. The bundle generator
 * already enforces most of this; re-asserting it here puts the check immediately before
 * publication, where the bytes being published are the ones being read.
 * @param {string} bundleDir
 * @param {{ sourceSha: string }} expected
 * @returns {{ groups: string[], lane: string, sourceCommit: string }}
 */
export function validateBundleDir(bundleDir, { sourceSha }) {
  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    throw new Error(`deploy bundle not found: ${bundleDir} does not exist (or is not a directory)`);
  }

  // A generator that silently produced nothing must go RED, never publish an empty host.
  if (!existsSync(path.join(bundleDir, HOST_CONFIG_FILE_NAME))) {
    throw new Error(`deploy bundle ${bundleDir} is missing the generated ${HOST_CONFIG_FILE_NAME} sentinel`);
  }

  // The bundle root is reserved: each group's inventory lives under its own name, and
  // the live-host gate probes both root paths as must-404s. The provenance marker joins
  // them because `writeProvenance` clobbers that exact path -- a document served there
  // would be unpublishable by construction, and the host would answer a manifest-digested
  // path with provenance bytes.
  for (const reserved of [MANIFEST_FILE_NAME, SIGNATURE_FILE_NAME, PROVENANCE_FILE]) {
    if (existsSync(path.join(bundleDir, reserved))) {
      throw new Error(`the deploy bundle root is reserved, but it carries ${reserved}`);
    }
  }

  assertNoGitControlPath(bundleDir);

  const groups = readdirSync(bundleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(bundleDir, entry.name, MANIFEST_FILE_NAME)))
    .map((entry) => entry.name)
    .sort();
  if (groups.length === 0) {
    throw new Error(`deploy bundle ${bundleDir} declares no release group (no <group>/${MANIFEST_FILE_NAME})`);
  }

  let lane;
  let sourceCommit;
  for (const group of groups) {
    const manifest = readGroupManifest(bundleDir, group);
    // The namespacing law, checked at the deploy boundary: a group's root files live
    // under the name the group itself claims, or the live-host gate would byte-compare
    // one group's inventory against the other's.
    if (manifest.releaseGroup !== group) {
      throw new Error(`deploy bundle directory ${group} holds a manifest claiming release group ${manifest.releaseGroup}`);
    }
    // Presence before agreement. `undefined` is the "no group seen yet" sentinel below, so
    // a manifest that simply omits the field would be adopted from a later group instead of
    // refused: the bundle would validate clean while publishing a group whose bytes carry no
    // lane and no commit binding, and the same-run check below would be reading a different
    // group's commit. Requiring both here also makes `groups[0]` in the messages below the
    // group the retained value actually came from.
    if (manifest.lane !== 'canary' && manifest.lane !== 'stable') {
      throw new Error(`deploy bundle ${group}/${MANIFEST_FILE_NAME} declares no lane: ${manifest.lane ?? '<missing>'}`);
    }
    const commit = manifest.generatedFrom?.commit;
    if (typeof commit !== 'string' || !COMMIT_SHA_PATTERN.test(commit)) {
      throw new Error(`deploy bundle ${group}/${MANIFEST_FILE_NAME} names no source commit: ${commit ?? '<missing>'}`);
    }
    if (lane === undefined) lane = manifest.lane;
    else if (manifest.lane !== lane) {
      throw new Error(`deploy bundle mixes lanes: ${groups[0]} is ${lane} and ${group} is ${manifest.lane}`);
    }
    if (sourceCommit === undefined) sourceCommit = commit;
    else if (commit !== sourceCommit) {
      throw new Error(`deploy bundle mixes source commits: ${groups[0]} is ${sourceCommit} and ${group} is ${commit}`);
    }
  }

  // The same-run binding. Everything above proves the bundle is internally coherent;
  // this proves it is *this* run's bundle.
  if (sourceCommit !== sourceSha) {
    throw new Error(`deploy bundle was generated from commit ${sourceCommit}, but this run publishes ${sourceSha}`);
  }

  return { groups, lane, sourceCommit };
}

/**
 * Guard the destructive mirror destination. It must be the root of a real Git worktree,
 * and it must be disjoint from the source in both directions. Canonical paths prevent a
 * symlink from bypassing the overlap check.
 * @param {string} bundleDir
 * @param {string} hostDir
 * @returns {string} canonical destination path
 */
export function validateHostCheckout(bundleDir, hostDir) {
  if (!existsSync(hostDir) || !statSync(hostDir).isDirectory()) {
    throw new Error(`host destination is not a Git worktree: ${hostDir}`);
  }

  const source = realpathSync(bundleDir);
  const destination = realpathSync(hostDir);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (contains(source, destination) || contains(destination, source)) {
    throw new Error(`deploy bundle and host destination overlap: ${source} <> ${destination}`);
  }

  let worktreeRoot;
  try {
    worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: destination,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`host destination is not a Git worktree: ${destination}`);
  }
  if (realpathSync(worktreeRoot) !== destination) {
    throw new Error(`host destination must be the Git worktree root: ${destination}`);
  }
  return destination;
}

/**
 * Mirror (not overlay) the full contents of `bundleDir` into `hostDir`: remove every
 * top-level host entry not in DEFAULT_KEEP, then recursively copy the bundle in. Result:
 * host tree === bundle tree + kept files. An overlay would leave a document withdrawn
 * from the catalog served forever. Does NOT run git itself -- run() owns the staging.
 *
 * That result holds only because `validateBundleDir` has already refused a bundle carrying
 * a Git control path: the copy is `force: true`, so a `.git/...` entry would be written
 * THROUGH the kept `.git` rather than beside it.
 * @param {string} bundleDir
 * @param {string} hostDir
 * @param {{ keep?: string[] }} [opts]
 */
export function mirrorContent(bundleDir, hostDir, { keep = DEFAULT_KEEP } = {}) {
  for (const entry of readdirSync(hostDir)) {
    if (keep.includes(entry)) continue;
    rmSync(path.join(hostDir, entry), { recursive: true, force: true });
  }
  cpSync(bundleDir, hostDir, { recursive: true });
}

/**
 * Write the single provenance marker at the host ROOT. Deterministic for one source SHA
 * (no timestamps), so a same-content refresh does not churn it. `lane` is recorded
 * alongside the SHA because the automatic refresh runs on the canary lane while the
 * stable live-host gate compares stable bytes: without it, that mismatch is diagnosed by
 * reasoning about which job last ran rather than by reading the host.
 * @param {string} hostDir
 * @param {{ sourceSha: string, lane: string, groups: string[], workflowPath: string }} fields
 */
export function writeProvenance(hostDir, { sourceSha, lane, groups, workflowPath }) {
  const content = [
    `source: Jinn-Network/mono@${sourceSha}`,
    `generated-by: ${workflowPath}`,
    `lane: ${lane}`,
    `release-groups: ${[...groups].sort().join(', ')}`,
    '',
  ].join('\n');
  writeFileSync(path.join(hostDir, PROVENANCE_FILE), content);
}

/**
 * Inspect the existing marker without trusting malformed content. `canonical` is what
 * run() branches on: a missing, duplicated, reordered, or otherwise malformed marker is
 * a repair, not a preserved value. This file has no published history, so there is no
 * legacy contract to honor. `sourceSha` is the parse result, returned so a caller (today
 * only the suite) can assert the marker round-trips; it is null exactly when the marker
 * is not canonical.
 * @param {string} hostDir
 * @param {string} workflowPath
 * @returns {{ canonical: boolean, sourceSha: string | null }}
 */
export function inspectProvenance(hostDir, workflowPath) {
  const provenancePath = path.join(hostDir, PROVENANCE_FILE);
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
  const canonical =
    lines.length === 4 &&
    sourceMatches.length === 1 &&
    lines[0] === sourceMatches[0][0] &&
    lines[1] === `generated-by: ${workflowPath}` &&
    /^lane: (?:canary|stable)$/.test(lines[2]) &&
    /^release-groups: \S.*$/.test(lines[3]);
  return { canonical, sourceSha: canonical ? sourceMatches[0][1] : null };
}

/**
 * Stage the whole host tree, ignore rules included. See the call site in `run()` for why
 * `--force` is load-bearing rather than defensive.
 * @param {string} hostDir
 */
function stageEverything(hostDir) {
  execFileSync('git', ['add', '-A', '--force'], { cwd: hostDir });
}

/**
 * Idempotency oracle: is there any staged/unstaged change in the host repo? The caller
 * must have run `stageEverything` first so deletions register and no ignore rule can hide
 * a mirrored file from the comparison.
 * @param {string} hostDir
 * @returns {boolean}
 */
export function treeChanged(hostDir) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: hostDir, encoding: 'utf8' });
  return out.trim().length > 0;
}

/**
 * Pure commit-message builder. The source SHA and the release groups are what the host
 * repository's own history must be able to answer for.
 * @param {{ sourceSha: string, lane: string, groups: string[] }} fields
 * @returns {string}
 */
export function buildCommitMessage({ sourceSha, lane, groups }) {
  return [
    `chore(profile-host): publish attested profile host @ ${sourceSha}`,
    '',
    `Source: Jinn-Network/mono@${sourceSha}`,
    `Lane: ${lane}`,
    `Release groups: ${[...groups].sort().join(', ')}`,
    'Generated by .github/workflows/stack-npm-publish.yml — edit in mono, not here.',
  ].join('\n');
}

/**
 * Local orchestrator: validate → mirror → stage → detect content change → update
 * provenance + commit when the content changed OR the marker needs one repair (all in
 * hostDir). A later same-content refresh with a canonical marker retains the last
 * content-changing source SHA because it writes nothing at all -- not writing is the
 * idempotency rule, and it is why the marker never carries a SHA whose bytes are not
 * the ones on disk. When the marker IS rewritten the current source SHA is always the
 * right value: either the content changed, or the marker was not canonical and had no
 * SHA worth preserving. `git commit` on a
 * local checkout needs no token, so it folds in here; only `git push` (in the YAML) is
 * privileged. Pure of GitHub-specific side effects -- no `::error::`, no `process.exit`,
 * no `$GITHUB_OUTPUT`.
 * @param {{ bundleDir: string, hostDir: string, sourceSha: string, workflowPath: string }} args
 * @returns {{ changed: boolean, message: string, groups: string[], lane: string }}
 */
export function run({ bundleDir, hostDir, sourceSha, workflowPath }) {
  validateSourceSha(sourceSha);
  const { groups, lane } = validateBundleDir(bundleDir, { sourceSha });
  validateHostCheckout(bundleDir, hostDir);
  mirrorContent(bundleDir, hostDir);
  // `--force` is what makes the staged tree provably equal the mirrored tree, and so what
  // makes `treeChanged` a sound idempotency oracle rather than a proxy for one: a plain
  // `git add -A` honors every ignore source Git can find -- a bundle-served `.gitignore`,
  // the host's own, `.git/info/exclude`, the user's global one -- and would stage a subset
  // of the attested bytes while reporting success. `validateBundleDir` refuses the
  // bundle-carried case above; this closes the ones no bundle validation can see.
  stageEverything(hostDir);

  const contentChanged = treeChanged(hostDir);
  const provenance = inspectProvenance(hostDir, workflowPath);
  const changed = contentChanged || !provenance.canonical;
  const message = buildCommitMessage({ sourceSha, lane, groups });
  if (changed) {
    writeProvenance(hostDir, { sourceSha, lane, groups, workflowPath });
    stageEverything(hostDir);
    execFileSync('git', ['commit', '-F', '-'], { cwd: hostDir, input: message });
  }
  return { changed, message, groups, lane };
}

// --- CLI entry (guarded so `import` is side-effect-free) ---------------------
//
// Thin env→args adapter around run(): read env, call run() (validate → mirror →
// provenance → local commit), and translate the outcome to GitHub Actions signals
// ($GITHUB_OUTPUT + ::notice::/::error::). The privileged `git push` stays in the YAML,
// gated on the emitted `changed`.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bundleDir = process.env.BUNDLE_DIR ?? '';
  const hostDir = process.env.HOST_DIR ?? 'host';
  const sourceSha = process.env.SOURCE_SHA ?? '';
  const workflowPath = process.env.WORKFLOW_PATH ?? '.github/workflows/stack-npm-publish.yml';

  let result;
  try {
    result = run({ bundleDir, hostDir, sourceSha, workflowPath });
  } catch (error) {
    console.log(`::error::${error?.message ?? error}`);
    process.exit(1);
  }

  // Machine-readable signal for the YAML PUSH step to branch on.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  }
  console.log(`changed=${result.changed}`);
  console.log(result.changed
    ? `::notice::host content changed — committed the ${result.lane} mirror of ${result.groups.join(', ')} @ ${sourceSha}`
    : '::notice::nothing to push — this push to next has the same host content as the last published refresh.');
}
