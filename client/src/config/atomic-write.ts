import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

function basicTimestamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;
}

/** temp-file + fsync + rename in the config file's own directory. Preserves the target's mode. */
export function writeConfigFileAtomic(filePath: string, value: unknown): void {
  // Serialize first: a cyclic or unserializable value must never touch the filesystem.
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  const directory = dirname(filePath);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, filePath);
  const directoryFd = openSync(directory, 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

/** Copies filePath to `<filePath>.backup-<ISO-basic-timestamp>` with the source's exact mode. */
export function backupConfigFile(
  filePath: string,
  now: () => Date = () => new Date(),
): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const backupPath = `${filePath}.backup-${basicTimestamp(now())}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

/** Stage-1 atomic-write backup: `<filePath>.backup-<ISO-basic>`. */
const MIGRATION_BACKUP_PATTERN = /^config\.json\.backup-\d{8}T\d{6}Z$/u;

/**
 * Stage-5 completion of the config migration: prune timestamped pre-v2
 * backups once the legacy keys are gone. The backups can carry paid RPC
 * keys, so they do not linger indefinitely.
 */
export function pruneMigrationBackups(configDir: string): { removed: string[] } {
  if (!existsSync(configDir)) return { removed: [] };
  const removed: string[] = [];
  for (const entry of readdirSync(configDir)) {
    if (!MIGRATION_BACKUP_PATTERN.test(entry)) continue;
    rmSync(join(configDir, entry), { force: true });
    removed.push(entry);
  }
  return { removed: removed.sort() };
}
