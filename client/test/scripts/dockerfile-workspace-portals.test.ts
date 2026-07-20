import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(clientRoot, '..');
const dockerfile = readFileSync(resolve(clientRoot, 'Dockerfile'), 'utf8');
const clientPackage = JSON.parse(
  readFileSync(resolve(clientRoot, 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  bundledDependencies?: string[];
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  resolutions?: Record<string, string>;
  scripts?: Record<string, string>;
};

const externalPortalPackages = Object.entries({
  ...clientPackage.dependencies,
  ...clientPackage.devDependencies,
  ...clientPackage.optionalDependencies,
  ...clientPackage.resolutions,
})
  .filter(([, version]) => version.startsWith('portal:'))
  .map(([name, version]) => {
    const packageRoot = resolve(clientRoot, version.slice('portal:'.length));
    const packageManifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { files?: string[] };
    return {
      name,
      repoPath: relative(repoRoot, packageRoot).split(sep).join('/'),
      publishFiles: packageManifest.files ?? [],
    };
  });

function dockerfilePrefixBefore(command: string): string {
  const commandIndex = dockerfile.indexOf(command);
  expect(commandIndex, `Dockerfile must contain ${command}`).toBeGreaterThanOrEqual(0);
  return dockerfile.slice(0, commandIndex);
}

function copiedSources(dockerfilePrefix: string): string[] {
  return dockerfilePrefix
    .split('\n')
    .filter((line) => line.startsWith('COPY '))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
}

function sourceIsCopied(source: string, copied: string[]): boolean {
  const normalizedSource = source.replace(/\/+$/, '');
  return copied.some((candidate) => {
    const normalizedCandidate = candidate.replace(/\/+$/, '');
    return normalizedCandidate === normalizedSource
      || (
        candidate.endsWith('/')
        && normalizedSource.startsWith(`${normalizedCandidate}/`)
      );
  });
}

function buildScriptClosure(): string[] {
  const scripts = clientPackage.scripts ?? {};
  const pending = ['build'];
  const visited = new Set<string>();
  const commands: string[] = [];

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name) || scripts[name] === undefined) continue;
    visited.add(name);
    const command = scripts[name];
    commands.push(command);
    for (const match of command.matchAll(/\byarn\s+([a-zA-Z0-9:_-]+)/g)) {
      pending.push(match[1]);
    }
  }

  return commands;
}

describe('client Docker build context', () => {
  it('covers every external portal package before install and build', () => {
    expect(externalPortalPackages.length).toBeGreaterThan(0);

    const beforeInstall = dockerfilePrefixBefore(
      'RUN corepack enable && cd client && yarn install --immutable',
    );
    const beforeBuild = dockerfilePrefixBefore('RUN yarn build');

    for (const { name, repoPath } of externalPortalPackages) {
      expect(
        beforeInstall,
        `${name} package manifest must be copied before client yarn install`,
      ).toContain(`${repoPath}/package.json`);
      expect(
        beforeInstall,
        `${name} lockfile must be copied before client yarn install`,
      ).toContain(`${repoPath}/yarn.lock`);
      expect(
        beforeInstall,
        `${name} Yarn config must be copied before client yarn install`,
      ).toContain(`${repoPath}/.yarnrc.yml`);
      expect(
        beforeBuild,
        `${name} TypeScript config must be copied before client yarn build`,
      ).toContain(`${repoPath}/tsconfig.json`);
      expect(
        beforeBuild,
        `${name} sources must be copied before client yarn build`,
      ).toContain(`${repoPath}/src/`);
    }
  });

  it('copies every client TypeScript project used by the build', () => {
    const requiredConfigs = new Set(['tsconfig.json']);
    for (const command of buildScriptClosure()) {
      for (const match of command.matchAll(/(?:-p|--project)\s+([^\s]+\.json)/g)) {
        requiredConfigs.add(match[1]);
      }
    }

    const beforeBuild = dockerfilePrefixBefore('RUN yarn build');
    const copied = copiedSources(beforeBuild);
    for (const config of requiredConfigs) {
      const source = `client/${config}`;
      expect(
        sourceIsCopied(source, copied),
        `${config} must be copied before client yarn build`,
      ).toBe(true);
    }
  });

  it('materializes bundled portal packages before the runtime copy', () => {
    const bundledDependencies = clientPackage.bundledDependencies ?? [];
    const runtimePortalPackages = externalPortalPackages.filter(
      ({ name }) => clientPackage.dependencies?.[name] !== undefined,
    );
    expect(runtimePortalPackages.length).toBeGreaterThan(0);
    expect(bundledDependencies).toEqual(
      expect.arrayContaining(runtimePortalPackages.map(({ name }) => name)),
    );

    const buildIndex = dockerfile.indexOf('RUN yarn build');
    const materializeIndex = dockerfile.indexOf(
      'RUN node scripts/materialize-bundled-workspaces.mjs prepare',
    );
    const runtimeCopyIndex = dockerfile.indexOf(
      'COPY --from=build /app/client/node_modules node_modules/',
    );

    expect(buildIndex, 'Dockerfile must build the client').toBeGreaterThanOrEqual(0);
    expect(
      materializeIndex,
      'Dockerfile must materialize bundled workspace links',
    ).toBeGreaterThan(buildIndex);
    expect(
      runtimeCopyIndex,
      'Dockerfile must copy materialized node_modules into the runtime image',
    ).toBeGreaterThan(materializeIndex);

    const copiedBeforeMaterialize = copiedSources(
      dockerfile.slice(0, materializeIndex),
    );
    for (const { name, repoPath, publishFiles } of runtimePortalPackages) {
      for (const entry of publishFiles) {
        const normalized = entry.replace(/\/+$/, '');
        if (normalized === 'dist') continue;
        expect(
          sourceIsCopied(`${repoPath}/${normalized}`, copiedBeforeMaterialize),
          `${name} publish file ${entry} must be copied before materialization`,
        ).toBe(true);
      }
    }
  });
});
