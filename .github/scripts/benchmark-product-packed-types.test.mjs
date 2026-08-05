// Compiles a TypeScript consumer against the Benchmark Product family's packed public entrypoints
// (the same npm-pack-then-install-from-tarball technique as
// `benchmarking-packed-types.test.mjs` / `record-discovery-packed-types.test.mjs`): the guard that
// what a real external consumer would install actually type-resolves, not just what the monorepo's
// own workspace linking happens to resolve.
//
// The product is `private: true` (product design §2: publication disabled, `publishPolicy:
// "never"`) -- which is exactly why this uses `npm pack`, not `yarn pack`: npm packs a private
// package fine, yarn refuses. `npm pack --ignore-scripts` ships whatever `dist/` is already on
// disk, so CI builds every package (product and its cross-tree portal dependencies) before this
// script runs; this script does not build anything itself.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const familyRoot = join(root, 'packages', 'benchmark-product');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-benchmark-product-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  ['core', '@jinn-network/benchmark-product-core'],
];

const codeEntrypoints = [
  '@jinn-network/benchmark-product-core',
];

// Cross-tree Jinn dependencies the product references, packed as `file:` deps so NodeNext resolves
// them (program plan §4.1; record-discovery-packed-types.test.mjs precedent).
// `task-execution-protocol` is the transitive `benchmarking-records` depends on, and the only
// reason it needs packing here at all -- it is not on the registry. Each `npm pack` is independent
// (the product is packed first, then these), and `--ignore-scripts` ships whatever `dist/` is on
// disk -- CI builds all three before this script runs.
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
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
      reject(new Error(
        `${command} exited with ${code}:\n${output}${errorOutput}`,
      ));
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

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [directory, name] of packages) {
    archives.set(name, await packOne(join(familyRoot, directory), name));
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
      ['vitest', '^4.1.8'],
    ]),
  }, null, 2));
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumerRoot },
  );

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type BenchmarkProductEntrypoints = [\n${codeEntrypoints
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
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoint across all ${packages.length} benchmark-product packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
