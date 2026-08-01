import { readFileSync, writeFileSync } from 'node:fs';

import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export function resolvePublishVersion({ mode, baseVersion, sha, releaseTag }) {
  if (!STABLE_SEMVER.test(String(baseVersion))) {
    throw new Error(`the package set version must be a stable semver, got ${baseVersion ?? '<missing>'}`);
  }
  if (mode === 'canary') {
    if (!COMMIT_SHA.test(String(sha))) {
      throw new Error(`canary publishing requires a 40-character commit sha, got ${sha ?? '<missing>'}`);
    }
    return { version: `${baseVersion}-canary.sha.${sha}`, distTag: 'canary' };
  }
  if (mode === 'stable') {
    const tag = String(releaseTag ?? '');
    if (!tag.startsWith('stack-v') || !STABLE_SEMVER.test(tag.slice('stack-v'.length))) {
      throw new Error(`stable platform releases must use stack-v<semver>, got ${tag || '<missing>'}`);
    }
    const version = tag.slice('stack-v'.length);
    if (version !== baseVersion) {
      throw new Error(`release tag ${tag} resolves to ${version}, but the package set is at ${baseVersion}`);
    }
    return { version, distTag: 'latest' };
  }
  throw new Error(`unknown publish mode ${mode ?? '<missing>'}`);
}

export function transformManifestForPublish(manifest, { version, gitHead, inSetNames }) {
  const patched = structuredClone(manifest);
  patched.version = version;
  patched.gitHead = gitHead;
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = patched[section];
    if (!entries) continue;
    for (const dependency of Object.keys(entries)) {
      if (inSetNames.has(dependency)) entries[dependency] = version;
    }
  }
  if (patched.resolutions) {
    for (const [key, value] of Object.entries(patched.resolutions)) {
      if (typeof value === 'string' && value.startsWith('portal:')) delete patched.resolutions[key];
    }
    if (Object.keys(patched.resolutions).length === 0) delete patched.resolutions;
  }
  return patched;
}

export function applyPublishManifest(manifestPath, options) {
  const originalBytes = readFileSync(manifestPath, 'utf8');
  const patched = transformManifestForPublish(JSON.parse(originalBytes), options);
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  return {
    restore() {
      writeFileSync(manifestPath, originalBytes, 'utf8');
    },
  };
}
