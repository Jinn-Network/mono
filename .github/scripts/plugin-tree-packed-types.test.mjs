import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPluginPackages, pluginRoot, root } from './plugin-tree-guard-common.mjs';

const treeRoot = pluginRoot;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-plugin-tree-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = discoverPluginPackages().map((pkg) => [pkg.directory, pkg.name]);
const PACKED_TYPES_PACKAGES = packages.map(([directory]) => directory);

const codeEntrypoints = packages.map(([, name]) => name);

const CROSS_TREE_PACKAGES = [];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(`${command} exited with ${code}:\n${output}${errorOutput}`));
    });
  });
}

async function packOne(directory, name) {
  const packed = JSON.parse(await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
    { cwd: directory },
  ));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  return join(archivesRoot, packed[0].filename);
}

const nestedFixture = mkdtempSync(join(treeRoot, '.plugin-tree-nested-packed-'));
try {
  const nested = join(nestedFixture, 'nested-pkg');
  mkdirSync(join(nested, 'src'), { recursive: true });
  await writeFile(join(nested, 'package.json'), JSON.stringify({
    name: '@jinn-network/nested-packed-fixture',
    version: '0.0.0',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  }, null, 2));
  const discovered = discoverPluginPackages().map((pkg) => pkg.directory);
  if (!discovered.some((directory) => directory.endsWith('nested-pkg'))) {
    throw new Error('nested fixture package must be discovered before packed-types validation');
  }
} finally {
  rmSync(nestedFixture, { recursive: true, force: true });
}

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [directory, name] of packages) {
    archives.set(name, await packOne(join(treeRoot, directory), name));
  }
  for (const [name, directory] of CROSS_TREE_PACKAGES) {
    archives.set(name, await packOne(directory, name));
  }

  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...packages.map(([, name]) => [name, `file:${archives.get(name)}`]),
      ...CROSS_TREE_PACKAGES.map(([name]) => [name, `file:${archives.get(name)}`]),
      ['@types/node', '^22.0.0'],
      ['typescript', '^5.9.3'],
    ]),
  }, null, 2));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type PluginTreeEntrypoints = [\n${codeEntrypoints
        .map((_, index) => `  typeof Entry${index},`)
        .join('\n')}\n];\n`,
  );
  await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['consumer.ts'],
  }, null, 2));

  const typescript = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });

  for (const [directory, name] of packages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
    if (installed.publishConfig?.provenance !== true) {
      throw new Error(`${name} must publish with provenance (custody law C5)`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all ${packages.length} plugin tree packages (${PACKED_TYPES_PACKAGES.join(', ')}).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
