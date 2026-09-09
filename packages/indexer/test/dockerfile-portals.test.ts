import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The image's build context root is packages/ (the Dockerfile COPYs the indexer
// tree and its portal siblings, matching CI's `docker build -f
// indexer/deploy/Dockerfile .` run from packages/), so every path this file
// compares against the Dockerfile is context-relative.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contextRoot = resolve(packageRoot, '..');
const dockerfile = readFileSync(resolve(packageRoot, 'deploy/Dockerfile'), 'utf8');
const railwayConfig = readFileSync(resolve(packageRoot, 'deploy/railway.toml'), 'utf8');

interface PortalEdge {
  name: string;
  consumer: string;
  target: string;
}

function portalEntries(manifest: Record<string, unknown>): Map<string, string> {
  const portals = new Map<string, string>();
  for (const field of [
    'resolutions',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    const group = manifest[field] as Record<string, string> | undefined;
    for (const [name, version] of Object.entries(group ?? {})) {
      if (version.startsWith('portal:')) portals.set(name, version.slice('portal:'.length));
    }
  }
  return portals;
}

// Each nested install resolves that package's OWN portal resolutions, and those
// targets are never named in indexer/package.json — so a depth-1 sweep cannot
// see them. Walk the whole closure off disk (no node_modules required).
function reachablePortalEdges(): PortalEdge[] {
  const edges: PortalEdge[] = [];
  const walked = new Set<string>();

  const walk = (consumerRoot: string): void => {
    const manifestPath = resolve(consumerRoot, 'package.json');
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    for (const [name, target] of portalEntries(manifest)) {
      const targetRoot = resolve(consumerRoot, target);
      edges.push({
        name,
        consumer: contextRelative(consumerRoot),
        target: contextRelative(targetRoot),
      });
      if (walked.has(targetRoot)) continue;
      walked.add(targetRoot);
      walk(targetRoot);
    }
  };

  walk(packageRoot);
  return edges;
}

function contextRelative(packagePath: string): string {
  return relative(contextRoot, packagePath).split(sep).join('/');
}

function copyManifestIndex(contextPath: string): number {
  return dockerfile.indexOf(`COPY ${contextPath}/package.json`);
}

function watchPatterns(): string[] {
  const block = /watchPatterns\s*=\s*\[([^\]]*)\]/u.exec(railwayConfig);
  expect(block, 'railway.toml must declare watchPatterns').not.toBeNull();
  return [...block![1]!.matchAll(/"([^"]*)"/gu)].map((match) => match[1]!);
}

describe('indexer deploy image portal completeness', () => {
  const edges = reachablePortalEdges();

  it('walks a non-empty portal closure', () => {
    expect(edges.length).toBeGreaterThan(0);
  });

  it('copies every reachable portal manifest before the install that resolves it', () => {
    const missing: string[] = [];

    for (const { name, consumer, target } of edges) {
      const consumerIndex = copyManifestIndex(consumer);
      expect(
        consumerIndex,
        `Dockerfile must contain COPY ${consumer}/package.json`,
      ).toBeGreaterThanOrEqual(0);

      const targetIndex = copyManifestIndex(target);
      if (targetIndex < 0) {
        missing.push(`${name} (${target})`);
      } else if (targetIndex > consumerIndex) {
        missing.push(`${name} (${target}): copied after ${consumer}/package.json`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('watches every reachable portal package and the image package itself', () => {
    const patterns = new Set(watchPatterns());
    const watched = [contextRelative(packageRoot), ...edges.map(({ target }) => target)];
    const missing = [...new Set(watched)]
      .map((contextPath) => `packages/${contextPath}/**`)
      .filter((pattern) => !patterns.has(pattern));

    expect(missing).toEqual([]);
  });
});
