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
  const packagedManifest = { ...manifest };
  // These private packages are shipped only inside the client. Their runtime
  // dependencies are deliberately owned by the public client manifest (and
  // checked above); retaining this field would make npm recursively bundle
  // every transitive dependency, including upstream source and test files.
  delete packagedManifest.dependencies;
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

export async function restoreBundledWorkspaces({ clientRoot }) {
  const stateRoot = path.join(clientRoot, STATE_DIR);
  const statePath = path.join(stateRoot, STATE_FILE);
  if (!await pathExists(statePath)) return;

  const state = await readJson(statePath);
  for (const packageName of [...state.packageNames].reverse()) {
    const parts = packageDirectory(packageName);
    const target = path.join(clientRoot, 'node_modules', ...parts);
    const backup = path.join(stateRoot, 'links', ...parts);
    if (!await pathExists(backup)) continue;
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await rename(backup, target);
  }
  await rm(stateRoot, { recursive: true, force: true });
}

export async function materializeBundledWorkspaces({ clientRoot }) {
  await restoreBundledWorkspaces({ clientRoot });

  const clientManifest = await readJson(path.join(clientRoot, 'package.json'));
  const packageNames = clientManifest.bundledDependencies;
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    throw new Error('client package.json must declare bundledDependencies');
  }

  const stateRoot = path.join(clientRoot, STATE_DIR);
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    path.join(stateRoot, STATE_FILE),
    `${JSON.stringify({ packageNames }, null, 2)}\n`,
  );

  try {
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
      assertRuntimeDependenciesAreInstallable(clientManifest, workspaceManifest);

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
