import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';
import { applyPublishManifest } from './stack-publish-manifest.mjs';

const LOCAL_SPECIFIER = /^(portal|link|file|workspace):/u;

// Belt-and-suspenders check on the acceptance criterion's headline claim: no
// portal:/link:/file:/workspace: specifier survives into a packed manifest.
// transformManifestForPublish only rewrites in-set dependency specifiers and
// strips portal: resolutions; an out-of-set devDependency carrying one of these
// specifiers today would pack, publish, and 404 every consumer's install on a
// path that does not exist on their disk, with CI green throughout. This runs
// inside the mutation window that already exists between applyPublishManifest
// and restore().
function assertNoLocalSpecifiers(manifest, directory) {
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [dependency, spec] of Object.entries(manifest[section] ?? {})) {
      if (typeof spec === 'string' && LOCAL_SPECIFIER.test(spec)) {
        throw new Error(`${directory}: packed manifest ${section}.${dependency} still carries local specifier ${spec}`);
      }
    }
  }
}

export function defaultExec(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: publishEnv() });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function publishEnv() {
  const env = { ...process.env };
  delete env.NODE_AUTH_TOKEN;
  return env;
}

function requireSuccess(result, directory, label) {
  if (result.status !== 0) {
    throw new Error(`${directory}: ${label} failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
  }
  return result;
}

export async function packWave(wave, options) {
  const { repoRoot, version, gitHead, inSetNames, tarballsDir, exec = defaultExec } = options;
  const artifacts = [];
  for (const entry of wave) {
    const packageRoot = resolve(repoRoot, entry.directory);
    requireSuccess(exec('yarn', ['install', '--immutable'], packageRoot), entry.directory, 'yarn install --immutable');
    requireSuccess(exec('yarn', ['build'], packageRoot), entry.directory, 'yarn build');
    const { restore } = applyPublishManifest(entry.manifestPath, { version, gitHead, inSetNames });
    let packed;
    try {
      assertNoLocalSpecifiers(JSON.parse(readFileSync(entry.manifestPath, 'utf8')), entry.directory);
      const result = requireSuccess(
        exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballsDir], packageRoot),
        entry.directory,
        'npm pack',
      );
      const entries = JSON.parse(result.stdout);
      if (!Array.isArray(entries) || entries.length !== 1) {
        throw new Error(`${entry.directory}: npm pack returned ${Array.isArray(entries) ? entries.length : 'non-array'} entries`);
      }
      [packed] = entries;
    } finally {
      restore();
    }
    if (packed?.name !== entry.name || packed.version !== version || typeof packed.filename !== 'string') {
      throw new Error(
        `npm pack produced ${packed?.name ?? '<missing>'}@${packed?.version ?? '<missing>'}, expected ${entry.name}@${version}`,
      );
    }
    const tarball = join(tarballsDir, basename(packed.filename));
    const bytes = readFileSync(tarball);
    artifacts.push({
      name: entry.name,
      spec: `${entry.name}@${version}`,
      directory: entry.directory,
      tarball,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }
  return artifacts;
}

const RETRY_ATTEMPTS = Number.parseInt(process.env.JINN_NPM_REGISTRY_RETRY_ATTEMPTS ?? '12', 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.JINN_NPM_REGISTRY_RETRY_DELAY_MS ?? '5000', 10);

function sleepSync(ms) {
  if (ms <= 0) return;
  spawnSync('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))], { stdio: 'ignore' });
}

function viewJson(args, { exec, npmCommand = 'npm', repoRoot, attempts = 1, delayMs = 0 }, label) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = exec(npmCommand, args, repoRoot);
    if (result.status === 0) {
      const stdout = result.stdout.trim();
      // `npm view <published-package> dist-tags.<unset-tag> --json` exits 0 with empty
      // stdout when the package exists but the field is unset — distinct from the
      // package-not-found case (E404), but the same "nothing there" signal to the caller.
      if (stdout === '') return null;
      try {
        return JSON.parse(stdout);
      } catch (error) {
        throw new Error(`registry returned invalid JSON for ${label}: ${error?.message ?? String(error)}`);
      }
    }
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/\bE404\b|404 Not Found/u.test(output)) {
      throw new Error(`npm ${args.join(' ')} failed: ${output.trim()}`);
    }
    if (attempt < attempts - 1) sleepSync(delayMs);
  }
  return null;
}

export function registryIntegrity(spec, context) {
  return viewJson(['view', spec, 'dist.integrity', '--json'], context, spec);
}

export function registryDistTag(name, distTag, context) {
  return viewJson(['view', name, `dist-tags.${distTag}`, '--json'], context, name);
}

function assertIntegrity(artifact, actual, phase) {
  if (actual !== artifact.integrity) {
    throw new Error(`${phase} integrity mismatch for ${artifact.spec}: local ${artifact.integrity}, registry ${actual ?? '<missing>'}`);
  }
}

function assertDistTag(artifact, actual, expectedVersion, distTag, phase) {
  if (actual !== expectedVersion) {
    throw new Error(
      `${phase} ${distTag} mismatch for ${artifact.name}: expected ${expectedVersion}, got ${actual ?? '<missing>'}; `
      + 'OIDC cannot repair an immutable version via npm dist-tag, refusing further publication',
    );
  }
}

export async function publishWave(artifacts, options) {
  const { distTag, exec = defaultExec, npmCommand = 'npm', repoRoot } = options;
  const context = { exec, npmCommand, repoRoot };
  const version = artifacts[0]?.spec.slice(artifacts[0].spec.lastIndexOf('@') + 1);
  const missing = [];
  for (const artifact of artifacts) {
    const actual = registryIntegrity(artifact.spec, context);
    if (actual === null) {
      missing.push(artifact);
      continue;
    }
    assertIntegrity(artifact, actual, 'preflight');
    assertDistTag(artifact, registryDistTag(artifact.name, distTag, context), version, distTag, 'preflight');
    console.log(`already published with matching integrity: ${artifact.spec}`);
  }
  for (const artifact of missing) {
    const result = exec(npmCommand, ['publish', artifact.tarball, '--access', 'public', '--provenance', '--tag', distTag], repoRoot);
    if (result.status !== 0) {
      throw new Error(`npm publish ${artifact.spec} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    const retrying = { ...context, attempts: RETRY_ATTEMPTS, delayMs: RETRY_DELAY_MS };
    assertIntegrity(artifact, registryIntegrity(artifact.spec, retrying), 'post-publish');
    assertDistTag(artifact, registryDistTag(artifact.name, distTag, retrying), version, distTag, 'post-publish');
    console.log(`published ${artifact.spec} at ${distTag}`);
  }
}

export function verifyCoherentSet(artifacts, options) {
  const { distTag, version, exec = defaultExec, npmCommand = 'npm', repoRoot } = options;
  const context = { exec, npmCommand, repoRoot };
  for (const artifact of artifacts) {
    const actual = registryIntegrity(artifact.spec, context);
    if (actual === null) {
      throw new Error(`partially-published platform set at ${version}: ${artifact.name} is missing from the registry`);
    }
    assertIntegrity(artifact, actual, 'final');
    assertDistTag(artifact, registryDistTag(artifact.name, distTag, context), version, distTag, 'final');
  }
  console.log(`verified coherent platform set ${version} at ${distTag} across ${artifacts.length} packages`);
}

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export async function runPublish(plan, args) {
  // gitHead in the published manifest exists to record the source commit (plan
  // decision D6). args.sha is undefined whenever the caller forgets --sha (the
  // stable lane historically did); silently substituting plan.version there would
  // write a semver string into a field whose entire purpose is a commit sha, so
  // this refuses instead.
  if (!COMMIT_SHA.test(String(args.sha))) {
    throw new Error(`runPublish requires a 40-character commit sha via --sha, got ${args.sha ?? '<missing>'}`);
  }
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-stack-publish-'));
  const allArtifacts = [];
  try {
    for (const [index, wave] of plan.waves.entries()) {
      const artifacts = await packWave(wave, {
        repoRoot: args.repoRoot,
        version: plan.version,
        gitHead: args.sha,
        inSetNames: plan.inSetNames,
        tarballsDir,
      });
      console.log(`wave ${index}: packed ${artifacts.length} packages`);
      await publishWave(artifacts, { distTag: plan.distTag, npmCommand: args.npmCommand, repoRoot: args.repoRoot });
      allArtifacts.push(...artifacts);
    }
    verifyCoherentSet(allArtifacts, {
      distTag: plan.distTag,
      version: plan.version,
      npmCommand: args.npmCommand,
      repoRoot: args.repoRoot,
    });
  } finally {
    rmSync(tarballsDir, { recursive: true, force: true });
  }
}
