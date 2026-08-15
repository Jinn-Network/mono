// SPDX-License-Identifier: Apache-2.0

export interface CorpusFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface CorpusFilesystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  /** flags may be string ("wx") or numeric bitflags from constants */
  open(path: string, flags: string | number, mode?: number): Promise<CorpusFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<unknown>;
  readonly constants: {
    readonly O_CREAT: number;
    readonly O_EXCL: number;
    readonly O_RDWR: number;
    readonly O_NOFOLLOW?: number;
  };
}

/** Freeze/normalize a host-supplied binding object into the port. */
export function createCorpusFilesystem(bindings: CorpusFilesystem): CorpusFilesystem {
  return Object.freeze({
    mkdir: bindings.mkdir.bind(bindings),
    readFile: bindings.readFile.bind(bindings),
    open: bindings.open.bind(bindings),
    rename: bindings.rename.bind(bindings),
    unlink: bindings.unlink.bind(bindings),
    lstat: bindings.lstat.bind(bindings),
    constants: Object.freeze({ ...bindings.constants }),
  });
}
