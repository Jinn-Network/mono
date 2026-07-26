import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = '.jinn-pack-bundled-workspaces';
const STATE_FILE = 'state.json';
const MANIFEST_BACKUP_FILE = 'package.json.original';

const PUBLISH_MANIFEST_FIELDS = [
  'name',
  'version',
  'description',
  'type',
  'license',
  'repository',
  'engines',
  'bin',
  'main',
  'module',
  'browser',
  'types',
  'exports',
  'imports',
  'files',
  'publishConfig',
  'bundledDependencies',
  'scripts',
  'dependencies',
  'optionalDependencies',
];

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function publishManifest(sourceManifest) {
  const manifest = {};
  for (const field of PUBLISH_MANIFEST_FIELDS) {
    if (field === 'scripts') {
      if (typeof sourceManifest.scripts?.postinstall === 'string') {
        manifest.scripts = { postinstall: sourceManifest.scripts.postinstall };
      }
      continue;
    }
    if (Object.hasOwn(sourceManifest, field)) {
      manifest[field] = sourceManifest[field];
    }
  }
  return manifest;
}

function assertInstallableDependencyValue(value, manifestPath) {
  if (typeof value === 'string') {
    if (/^(?:portal|workspace|file):/i.test(value)) {
      throw new Error(`${manifestPath} contains forbidden local dependency value ${value}`);
    }
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
      throw new Error(
        `${manifestPath} contains absolute checkout dependency value ${value}`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertInstallableDependencyValue(item, manifestPath);
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      assertInstallableDependencyValue(nested, manifestPath);
    }
  }
}

export function assertPackageManifestDependencyValues(manifest, manifestPath = 'package.json') {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must contain a JSON object`);
  }

  const visit = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (
        /dependencies$/i.test(key)
        || key === 'resolutions'
        || key === 'overrides'
      ) {
        assertInstallableDependencyValue(nested, manifestPath);
      } else {
        visit(nested);
      }
    }
  };
  visit(manifest);
}

export function assertSafeTarballPackageManifests(entries, readEntry) {
  for (const rawEntry of entries) {
    const entry = rawEntry.replaceAll('\\', '/');
    if (!/(?:^|\/)package\.json$/.test(entry)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readEntry(rawEntry));
    } catch (error) {
      throw new Error(
        `${entry} is not a valid package manifest: ${error?.message ?? String(error)}`,
      );
    }
    assertPackageManifestDependencyValues(manifest, entry);
  }
}

function packageDirectory(packageName) {
  const parts = packageName.split('/');
  if (
    parts.length !== 2 ||
    !parts[0].startsWith('@') ||
    !parts[1] ||
    parts.some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`unsupported bundled workspace name: ${packageName}`);
  }
  return parts;
}

function safePackageEntry(workspaceRoot, entry) {
  if (typeof entry !== 'string' || !entry || path.isAbsolute(entry)) {
    throw new Error(`unsafe bundled workspace files entry: ${String(entry)}`);
  }
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`unsafe bundled workspace files entry: ${entry}`);
  }
  const source = path.resolve(workspaceRoot, normalized);
  if (!source.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) {
    throw new Error(`bundled workspace files entry escaped its package: ${entry}`);
  }
  return { normalized, source };
}

async function copyPublishFiles(workspaceRoot, targetRoot, manifest) {
  await mkdir(targetRoot, { recursive: true });
  const packagedManifest = {};
  for (const field of PUBLISH_MANIFEST_FIELDS) {
    if (
      field === 'scripts'
      || /dependencies$/i.test(field)
    ) {
      continue;
    }
    if (Object.hasOwn(manifest, field)) {
      packagedManifest[field] = manifest[field];
    }
  }
  // These private packages are shipped only inside the client. Their runtime
  // dependencies are deliberately owned by the public client manifest (and
  // checked above); retaining this field would make npm recursively bundle
  // every transitive dependency, including upstream source and test files.
  await writeFile(
    path.join(targetRoot, 'package.json'),
    `${JSON.stringify(packagedManifest, null, 2)}\n`,
  );

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${manifest.name} must declare an explicit files list before it can be bundled`);
  }
  for (const entry of manifest.files) {
    const { normalized, source } = safePackageEntry(workspaceRoot, entry);
    if (!await pathExists(source)) {
      throw new Error(`${manifest.name} publish file does not exist: ${entry}`);
    }
    await cp(source, path.join(targetRoot, normalized), { recursive: true });
  }

  const rootEntries = await readdir(workspaceRoot);
  for (const entry of rootEntries.filter((name) => /^(?:licen[cs]e|readme)(?:\.|$)/i.test(name))) {
    await cp(path.join(workspaceRoot, entry), path.join(targetRoot, entry), { recursive: true });
  }
}

function assertRuntimeDependenciesAreInstallable(clientManifest, workspaceManifest) {
  for (const dependency of Object.keys(workspaceManifest.dependencies ?? {})) {
    if (!clientManifest.dependencies?.[dependency]) {
      throw new Error(
        `${workspaceManifest.name} runtime dependency ${dependency} must also be a client dependency`,
      );
    }
  }
}

function assertBundledWorkspaceDependencyVersion(clientManifest, workspaceManifest) {
  const packageName = workspaceManifest.name;
  const workspaceVersion = workspaceManifest.version;
  if (typeof workspaceVersion !== 'string' || !workspaceVersion) {
    throw new Error(`${packageName} bundled workspace must declare a version`);
  }

  const declaredVersion = clientManifest.dependencies?.[packageName];
  if (declaredVersion !== workspaceVersion) {
    throw new Error(
      `${packageName} bundled workspace version ${workspaceVersion} must be declared as exact client dependency ${workspaceVersion}; found ${declaredVersion ?? 'missing'}`,
    );
  }
}

export async function restoreBundledWorkspaces({ clientRoot }) {
  const stateRoot = path.join(clientRoot, STATE_DIR);
  const statePath = path.join(stateRoot, STATE_FILE);
  if (!await pathExists(statePath)) return;

  const state = await readJson(statePath);
  let restoreError;
  for (const packageName of [...state.packageNames].reverse()) {
    try {
      const parts = packageDirectory(packageName);
      const target = path.join(clientRoot, 'node_modules', ...parts);
      const backup = path.join(stateRoot, 'links', ...parts);
      if (!await pathExists(backup)) continue;
      await rm(target, { recursive: true, force: true });
      await mkdir(path.dirname(target), { recursive: true });
      await rename(backup, target);
    } catch (error) {
      restoreError ??= error;
    }
  }

  const manifestBackup = path.join(stateRoot, MANIFEST_BACKUP_FILE);
  if (state.manifestSnapshot && await pathExists(manifestBackup)) {
    try {
      await writeFile(
        path.join(clientRoot, 'package.json'),
        await readFile(manifestBackup),
      );
    } catch (error) {
      restoreError ??= error;
    }
  }

  if (restoreError) {
    throw restoreError;
  }
  await rm(stateRoot, { recursive: true, force: true });
}

export async function materializeBundledWorkspaces({ clientRoot }) {
  await restoreBundledWorkspaces({ clientRoot });

  const packagePath = path.join(clientRoot, 'package.json');
  const sourceManifestBytes = await readFile(packagePath);
  const clientManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
  const packageNames = clientManifest.bundledDependencies;
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    throw new Error('client package.json must declare bundledDependencies');
  }

  const workspaces = [];
  for (const packageName of packageNames) {
    const parts = packageDirectory(packageName);
    const target = path.join(clientRoot, 'node_modules', ...parts);
    const targetStat = await lstat(target);
    if (!targetStat.isSymbolicLink()) {
      throw new Error(`${packageName} must be a workspace link before packing`);
    }
    const workspaceRoot = await realpath(target);
    const workspaceManifest = await readJson(path.join(workspaceRoot, 'package.json'));
    if (workspaceManifest.name !== packageName) {
      throw new Error(
        `workspace link for ${packageName} resolves to ${workspaceManifest.name ?? 'an unnamed package'}`,
      );
    }
    assertBundledWorkspaceDependencyVersion(clientManifest, workspaceManifest);
    assertRuntimeDependenciesAreInstallable(clientManifest, workspaceManifest);
    workspaces.push({
      packageName,
      parts,
      target,
      workspaceRoot,
      workspaceManifest,
    });
  }

  const stateRoot = path.join(clientRoot, STATE_DIR);
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, MANIFEST_BACKUP_FILE), sourceManifestBytes);
  await writeFile(
    path.join(stateRoot, STATE_FILE),
    `${JSON.stringify({ packageNames, manifestSnapshot: true }, null, 2)}\n`,
  );

  try {
    await writeFile(
      packagePath,
      `${JSON.stringify(publishManifest(clientManifest), null, 2)}\n`,
    );

    for (const {
      parts,
      target,
      workspaceRoot,
      workspaceManifest,
    } of workspaces) {
      const backup = path.join(stateRoot, 'links', ...parts);
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(target, backup);
      await copyPublishFiles(workspaceRoot, target, workspaceManifest);
    }
  } catch (error) {
    await restoreBundledWorkspaces({ clientRoot });
    throw error;
  }
}

export function assertSafeTarballEntries(entries) {
  for (const rawEntry of entries) {
    if (!rawEntry) continue;
    const entry = rawEntry.replaceAll('\\', '/');
    const segments = entry.split('/');
    if (
      !entry.startsWith('package/') ||
      entry.startsWith('/') ||
      segments.some((segment) => segment === '..' || segment === '.')
    ) {
      throw new Error(`tarball contains an unsafe path: ${rawEntry}`);
    }
    if (
      /^package\/(?:src|test)(?:\/|$)/.test(entry) ||
      /^package\/node_modules\/@jinn-network\/(?:core|plugin)\/(?:src|test|node_modules)(?:\/|$)/.test(entry)
    ) {
      throw new Error(`tarball contains source or test workspace files: ${rawEntry}`);
    }
  }
}
