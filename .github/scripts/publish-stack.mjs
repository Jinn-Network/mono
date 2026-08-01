#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  buildDependencyGraph,
  discoverStackPackages,
  topologicalWaves,
} from './stack-package-graph.mjs';
import { resolvePublishVersion } from './stack-publish-manifest.mjs';

const FLAGS_WITH_VALUES = new Set(['--mode', '--sha', '--release-tag', '--npm', '--root']);

export function parsePublishArgs(argv) {
  const parsed = {
    mode: undefined,
    sha: undefined,
    releaseTag: undefined,
    dryRun: false,
    npmCommand: 'npm',
    repoRoot: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--mode') parsed.mode = value;
    if (flag === '--sha') parsed.sha = value;
    if (flag === '--release-tag') parsed.releaseTag = value;
    if (flag === '--npm') parsed.npmCommand = value;
    if (flag === '--root') parsed.repoRoot = value;
  }
  if (!parsed.mode) throw new Error('--mode is required (canary or stable)');
  return parsed;
}

// Exit code reserved for "the platform package set is genuinely absent from this ref" —
// the one case where the canary workflow's existence guard is meant to no-op instead of
// failing the job. Every other planning failure (version skew, a dependency cycle, a
// malformed manifest) throws a plain Error and must fail the job loudly.
export const EMPTY_PACKAGE_SET_EXIT_CODE = 3;

export class EmptyPackageSetError extends Error {}

export function buildPublishPlan({ repoRoot, mode, sha, releaseTag }) {
  const packages = discoverStackPackages(repoRoot);
  if (packages.length === 0) {
    throw new EmptyPackageSetError('no platform packages found under the six stack roots');
  }
  const baseVersions = new Set(packages.map((pkg) => pkg.manifest.version));
  if (baseVersions.size !== 1) {
    throw new Error(
      `the platform package set must carry one version; found ${[...baseVersions].sort().join(', ')}`,
    );
  }
  const [baseVersion] = [...baseVersions];
  const { version, distTag } = resolvePublishVersion({ mode, baseVersion, sha, releaseTag });
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const waves = topologicalWaves(buildDependencyGraph(packages)).map((wave) => wave.map((name) => {
    const pkg = byName.get(name);
    return {
      name,
      directory: pkg.directory,
      manifestPath: resolve(repoRoot, pkg.directory, 'package.json'),
      spec: `${name}@${version}`,
    };
  }));
  return { version, distTag, waves, inSetNames: new Set(byName.keys()) };
}

export function renderPlan(plan) {
  const lines = [`publish version ${plan.version} at ${plan.distTag}`];
  plan.waves.forEach((wave, index) => {
    lines.push(`wave ${index}: ${wave.map((entry) => entry.name).join(', ')}`);
  });
  lines.push(`${plan.waves.flat().length} packages in ${plan.waves.length} waves`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parsePublishArgs(process.argv.slice(2));
    const plan = buildPublishPlan(args);
    console.log(renderPlan(plan));
    if (!args.dryRun) {
      const { runPublish } = await import('./publish-stack-run.mjs');
      await runPublish(plan, args);
    }
  } catch (error) {
    if (error instanceof EmptyPackageSetError) {
      console.log(error.message);
      process.exitCode = EMPTY_PACKAGE_SET_EXIT_CODE;
    } else {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    }
  }
}
