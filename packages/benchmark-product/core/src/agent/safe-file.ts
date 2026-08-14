import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export interface RegularFilePolicy {
  readonly maximumBytes?: number;
  readonly requiredMode?: number;
  readonly requireCurrentUser?: boolean;
}

function openRegularNoFollow(path: string, policy: RegularFilePolicy): { readonly fd: number; readonly size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("path must identify a regular file");
    if (stat.size < 1) throw new Error("file must not be empty");
    if (policy.maximumBytes !== undefined && stat.size > policy.maximumBytes) {
      throw new Error(`file must be no larger than ${policy.maximumBytes} bytes`);
    }
    if (policy.requiredMode !== undefined && (stat.mode & 0o777) !== policy.requiredMode) {
      throw new Error(`file mode must be ${policy.requiredMode.toString(8)}`);
    }
    if (policy.requireCurrentUser === true && process.getuid !== undefined && stat.uid !== process.getuid()) {
      throw new Error("file must be owned by the current user");
    }
    return { fd, size: stat.size };
  } catch (cause) {
    closeSync(fd);
    throw cause;
  }
}

/** Reads one descriptor snapshot; the checked path is never reopened by this operation. */
export function readRegularFileNoFollow(path: string, policy: RegularFilePolicy = {}): Uint8Array {
  const { fd } = openRegularNoFollow(path, policy);
  try {
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/** Readiness check over the same descriptor that was opened with O_NOFOLLOW. */
export function regularFileIsReady(path: string, policy: RegularFilePolicy = {}): boolean {
  try {
    const { fd } = openRegularNoFollow(path, policy);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
