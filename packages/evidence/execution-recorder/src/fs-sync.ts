// SPDX-License-Identifier: Apache-2.0

/** Yarn PnP hardened mode and some virtualized filesystems stub `FileHandle.sync` with ENOSYS. */
export function isFsyncUnsupportedError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { code: unknown }).code === "string"
      ? (cause as { code: string }).code
      : "";
  return (
    code === "ENOSYS" ||
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    message === "Method not implemented."
  );
}

/** Best-effort data/directory fsync: real failures remain poison; unsupported stubs are ignored. */
export async function fsyncBestEffort(
  file: { sync(): Promise<void> },
): Promise<void> {
  try {
    await file.sync();
  } catch (cause) {
    if (!isFsyncUnsupportedError(cause)) {
      throw cause;
    }
  }
}
