import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
