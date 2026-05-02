import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const sdkRoot = resolve(clientRoot, '../packages/sdk');
const distRoot = join(clientRoot, 'dist');
const targetRoot = join(distRoot, 'vendor/@jinn-network/sdk');

const sdkPackageJsonPath = join(sdkRoot, 'package.json');
const sdkPackageJson = JSON.parse(await readFile(sdkPackageJsonPath, 'utf8'));
const packagedSdkPackageJson = {
  name: sdkPackageJson.name,
  version: sdkPackageJson.version,
  description: sdkPackageJson.description,
  type: sdkPackageJson.type,
  license: sdkPackageJson.license,
  main: sdkPackageJson.main,
  types: sdkPackageJson.types,
  exports: sdkPackageJson.exports,
  dependencies: sdkPackageJson.dependencies,
};

await rm(targetRoot, { recursive: true, force: true });
await rm(join(distRoot, 'node_modules/@jinn-network/sdk'), { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await cp(join(sdkRoot, 'dist'), join(targetRoot, 'dist'), { recursive: true });
await cp(join(sdkRoot, 'README.md'), join(targetRoot, 'README.md'));
await writeFile(
  join(targetRoot, 'package.json'),
  `${JSON.stringify(packagedSdkPackageJson, null, 2)}\n`,
);

const sdkExports = new Map([
  ['@jinn-network/sdk/solvernets/prediction-v1', join(targetRoot, 'dist/solvernets/prediction-v1.js')],
  ['@jinn-network/sdk/solvernets', join(targetRoot, 'dist/solvernets/index.js')],
  ['@jinn-network/sdk/plugins', join(targetRoot, 'dist/plugins.js')],
  ['@jinn-network/sdk/harness', join(targetRoot, 'dist/harness.js')],
  ['@jinn-network/sdk', join(targetRoot, 'dist/index.js')],
]);

function relativeImport(fromFile, toFile) {
  let specifier = relative(dirname(fromFile), toFile).split(sep).join('/');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  return specifier;
}

async function rewriteBuiltSdkImports(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await rewriteBuiltSdkImports(path);
        return;
      }

      if (!entry.isFile() || (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts'))) {
        return;
      }

      let text = await readFile(path, 'utf8');
      const original = text;
      for (const [source, target] of sdkExports) {
        const replacement = relativeImport(path, target);
        text = text.replaceAll(`'${source}'`, `'${replacement}'`);
        text = text.replaceAll(`"${source}"`, `"${replacement}"`);
      }

      if (text !== original) {
        await writeFile(path, text);
      }
    }),
  );
}

await rewriteBuiltSdkImports(distRoot);
