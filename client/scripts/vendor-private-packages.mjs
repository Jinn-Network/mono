import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const distRoot = join(clientRoot, 'dist');

const packages = [
  {
    sourceRoot: resolve(clientRoot, '../packages/plugin'),
    targetRoot: join(distRoot, 'vendor/@jinn-network/plugin'),
  },
  {
    sourceRoot: resolve(clientRoot, '../packages/core'),
    targetRoot: join(distRoot, 'vendor/@jinn-network/core'),
  },
];

function packagedManifest(source) {
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    type: source.type,
    license: source.license,
    main: source.main,
    types: source.types,
    exports: source.exports,
    dependencies: source.dependencies,
  };
}

for (const entry of packages) {
  const sourceManifest = JSON.parse(
    await readFile(join(entry.sourceRoot, 'package.json'), 'utf8'),
  );
  await rm(entry.targetRoot, { recursive: true, force: true });
  await mkdir(entry.targetRoot, { recursive: true });
  await cp(join(entry.sourceRoot, 'dist'), join(entry.targetRoot, 'dist'), {
    recursive: true,
  });
  await writeFile(
    join(entry.targetRoot, 'package.json'),
    `${JSON.stringify(packagedManifest(sourceManifest), null, 2)}\n`,
  );
}

const importTargets = new Map([
  [
    '@jinn-network/plugin/testing',
    join(distRoot, 'vendor/@jinn-network/plugin/dist/testing.js'),
  ],
  [
    '@jinn-network/plugin',
    join(distRoot, 'vendor/@jinn-network/plugin/dist/index.js'),
  ],
  [
    '@jinn-network/core',
    join(distRoot, 'vendor/@jinn-network/core/dist/index.js'),
  ],
]);

function relativeImport(fromFile, toFile) {
  let specifier = relative(dirname(fromFile), toFile).split(sep).join('/');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return specifier;
}

async function rewritePrivateImports(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await rewritePrivateImports(path);
        return;
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts'))
      ) {
        return;
      }

      let source = await readFile(path, 'utf8');
      const original = source;
      for (const [specifier, target] of importTargets) {
        const replacement = relativeImport(path, target);
        source = source.replaceAll(`'${specifier}'`, `'${replacement}'`);
        source = source.replaceAll(`"${specifier}"`, `"${replacement}"`);
      }
      if (source !== original) await writeFile(path, source);
    }),
  );
}

await rewritePrivateImports(distRoot);
