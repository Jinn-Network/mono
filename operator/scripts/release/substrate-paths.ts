import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export function defaultSubstrateRoot(): string {
  return path.join(process.env.HOME || os.homedir(), 'jinn-dev');
}

/**
 * Recursively copy a directory tree, preserving file modes (so chmod-600
 * files like keystore-password stay locked down). Symlinks are recreated
 * as symlinks (a symlinked keystore-password must not be silently dropped).
 * When `exclude` is given, any entry it returns true for is skipped.
 */
export async function copyTree(
  srcDir: string,
  dstDir: string,
  exclude?: (name: string) => boolean,
): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (exclude?.(ent.name)) continue;
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    if (ent.isSymbolicLink()) {
      const target = await fs.readlink(srcPath);
      await fs.symlink(target, dstPath);
    } else if (ent.isDirectory()) {
      await copyTree(srcPath, dstPath, exclude);
    } else if (ent.isFile()) {
      await fs.copyFile(srcPath, dstPath);
      const stat = await fs.stat(srcPath);
      await fs.chmod(dstPath, stat.mode);
    }
  }
}

export function goldPath(opName: string, substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(substrateRoot, 'operators', opName);
}

export function workspacesRoot(substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(substrateRoot, 'workspaces');
}

export function workspacePath(runId: string, opName: string, substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(workspacesRoot(substrateRoot), runId, opName);
}

export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}
