import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(clientRoot, '..');
const dockerfile = readFileSync(resolve(clientRoot, 'Dockerfile'), 'utf8');
const clientLockfile = readFileSync(resolve(clientRoot, 'yarn.lock'), 'utf8');
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
      hasYarnConfig: existsSync(resolve(packageRoot, '.yarnrc.yml')),
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

function buildContextCopySources(): string[] {
  const instructions: string[] = [];
  let continued = '';

  for (const rawLine of dockerfile.split('\n')) {
    const line = rawLine.trim();
    if (continued === '' && (line === '' || line.startsWith('#'))) continue;
    const hasContinuation = line.endsWith('\\');
    continued += `${continued === '' ? '' : ' '}${
      hasContinuation ? line.slice(0, -1).trimEnd() : line
    }`;
    if (!hasContinuation) {
      instructions.push(continued);
      continued = '';
    }
  }

  return instructions.flatMap((instruction) => {
    if (!/^COPY\s/iu.test(instruction)) return [];
    let args = instruction.replace(/^COPY\s+/iu, '');
    const options: string[] = [];
    while (args.startsWith('--')) {
      const option = args.match(/^--[^\s]+\s*/u);
      if (option === null) break;
      options.push(option[0].trim());
      args = args.slice(option[0].length);
    }
    if (options.some((option) => option.startsWith('--from='))) {
      return [];
    }

    if (args.startsWith('[')) {
      const paths = JSON.parse(args) as string[];
      return paths.slice(0, -1);
    }

    const paths = args.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/gu) ?? [];
    return paths.slice(0, -1).map((path) => path.replace(/^(['"])(.*)\1$/u, '$2'));
  });
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
  it('ships the verified Claude safe-mode release and probes its capability at build time', () => {
    expect(dockerfile).toContain(
      'npm install -g @anthropic-ai/claude-code@2.1.216',
    );
    expect(dockerfile).toContain('claude --version');
    expect(dockerfile).toContain("grep -F -- '--safe-mode'");
  });

  it('does not retain the extracted harness-layer workspace', () => {
    expect(
      clientLockfile.includes(
        '@jinn-network/harness-layer@workspace:packages/harness-layer',
      ),
    ).toBe(false);
  });

  it('does not lock deleted client workspaces', () => {
    const missing = [...clientLockfile.matchAll(/resolution: "[^"]+@workspace:([^"]+)"/gu)]
      .map((match) => match[1]!)
      .filter((workspace) => !existsSync(resolve(clientRoot, workspace, 'package.json')));

    expect(missing).toEqual([]);
  });

  it('references only existing repository build-context sources', () => {
    const missing = buildContextCopySources()
      .filter((source) => !source.includes('$'))
      .filter((source) => {
        const repoPath = source.replace(/^\/+/u, '').replace(/\/+$/u, '');
        return !existsSync(resolve(repoRoot, repoPath));
      });

    expect(missing).toEqual([]);
  });

  it('covers every external portal package before install and build', () => {
    expect(externalPortalPackages.length).toBeGreaterThan(0);

    const beforeInstall = dockerfilePrefixBefore(
      'RUN corepack enable && cd operator && yarn install --immutable',
    );
    const beforeBuild = dockerfilePrefixBefore('RUN yarn build');

    for (const { name, repoPath, hasYarnConfig } of externalPortalPackages) {
      expect(
        beforeInstall,
        `${name} package manifest must be copied before client yarn install`,
      ).toContain(`${repoPath}/package.json`);
      expect(
        beforeInstall,
        `${name} lockfile must be copied before client yarn install`,
      ).toContain(`${repoPath}/yarn.lock`);
      if (hasYarnConfig) {
        expect(
          beforeInstall,
          `${name} Yarn config must be copied before client yarn install`,
        ).toContain(`${repoPath}/.yarnrc.yml`);
      }
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

  it('copies every stack-build script and tsconfig.build.json before yarn build', () => {
    // Operator Images on next died at `RUN yarn build` because build:stack
    // invokes `node scripts/build.mjs` / `tsc -p tsconfig.build.json` on
    // portal packages, and those inputs were not in the Docker context.
    // Recensus from operator package.json scripts, not a hardcoded file list.
    const beforeBuild = dockerfilePrefixBefore('RUN yarn build');
    const copied = copiedSources(beforeBuild);
    const stackPackages = [
      ...buildScriptClosure().join('\n').matchAll(/yarn --cwd \.\.\/(packages\/[^\s]+) build/g),
    ].map((match) => match[1]!);

    expect(stackPackages.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const repoPath of stackPackages) {
      const packageRoot = resolve(repoRoot, repoPath);
      const manifest = JSON.parse(
        readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      const buildCommand = manifest.scripts?.build ?? '';
      for (const match of buildCommand.matchAll(/(?:node|tsx)\s+((?:scripts|src)\/[^\s]+)/g)) {
        const source = `${repoPath}/${match[1]}`;
        if (!sourceIsCopied(source, copied)) missing.push(source);
      }
      if (existsSync(resolve(packageRoot, 'tsconfig.build.json'))) {
        const source = `${repoPath}/tsconfig.build.json`;
        if (!sourceIsCopied(source, copied)) missing.push(source);
      }
    }

    expect(missing).toEqual([]);
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
      const source = `operator/${config}`;
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
      'COPY --from=build /app/operator/node_modules node_modules/',
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

  it('prunes every non-runtime portal before relocating node_modules', () => {
    const runtimeNames = new Set([
      ...Object.keys(clientPackage.dependencies ?? {}),
      ...Object.keys(clientPackage.optionalDependencies ?? {}),
    ]);
    const nonRuntimePortals = externalPortalPackages.filter(
      ({ name }) => !runtimeNames.has(name),
    );
    expect(nonRuntimePortals.length).toBeGreaterThan(0);

    const buildIndex = dockerfile.indexOf('RUN yarn build');
    const pruneIndex = dockerfile.indexOf(
      'RUN yarn workspaces focus @jinn-network/operator --production',
    );
    const materializeIndex = dockerfile.indexOf(
      'RUN node scripts/materialize-bundled-workspaces.mjs prepare',
    );
    const runtimeCopyIndex = dockerfile.indexOf(
      'COPY --from=build /app/operator/node_modules node_modules/',
    );

    expect(pruneIndex).toBeGreaterThan(buildIndex);
    expect(materializeIndex).toBeGreaterThan(pruneIndex);
    expect(runtimeCopyIndex).toBeGreaterThan(materializeIndex);
    for (const { name } of nonRuntimePortals) {
      expect(clientPackage.bundledDependencies ?? []).not.toContain(name);
    }
  });
});
