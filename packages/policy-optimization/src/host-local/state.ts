// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

export class HostStateError extends Error {
  constructor(readonly code: "unsafe-state-path" | "state-locked" | "state-io", message: string) {
    super(message);
    this.name = "HostStateError";
  }
}

export function defaultHostStateRoot(input: {
  readonly explicit?: string;
  readonly xdgStateHome?: string;
} = {}): string {
  if (input.explicit !== undefined && input.explicit.length > 0) return resolve(input.explicit);
  const base = input.xdgStateHome === undefined || input.xdgStateHome.length === 0
    ? join(homedir(), ".local", "state")
    : input.xdgStateHome;
  return resolve(base, "jinn", "policy-optimization");
}

function refuseSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new HostStateError("unsafe-state-path", "state path contains a symbolic link");
  }
}

/** Resolve only an OS-controlled root alias such as macOS `/var` -> `/private/var`. */
function resolveRootAlias(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const [first, ...rest] = relative(root, absolute).split(sep);
  if (first === undefined || first.length === 0) return absolute;
  const firstPath = join(root, first);
  return existsSync(firstPath) && lstatSync(firstPath).isSymbolicLink()
    ? resolve(realpathSync(firstPath), ...rest)
    : absolute;
}

/** Creates a private directory and refuses symlinked roots or children. */
export function ensurePrivateDirectory(path: string): string {
  const absolute = resolveRootAlias(path);
  const lineage: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    lineage.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const directory of lineage) {
    if (existsSync(directory)) {
      refuseSymlink(directory);
      if (!lstatSync(directory).isDirectory()) {
        throw new HostStateError("unsafe-state-path", "state path crosses a non-directory");
      }
      continue;
    }
    mkdirSync(directory, { mode: 0o700 });
    refuseSymlink(directory);
  }
  if (!lstatSync(absolute).isDirectory()) {
    throw new HostStateError("unsafe-state-path", "state path is not a directory");
  }
  chmodSync(absolute, 0o700);
  return absolute;
}

/** Exact no-follow read of a private regular file. */
export function secureRead(path: string): Uint8Array {
  const absolute = resolve(path);
  refuseSymlink(absolute);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new HostStateError("unsafe-state-path", "state artifact is not a regular file");
    }
    return new Uint8Array(readFileSync(descriptor));
  } catch (cause) {
    if (cause instanceof HostStateError) throw cause;
    throw new HostStateError("state-io", "secure state read failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Atomic, no-follow, mode-0600 write. Immutable mode refuses changing existing bytes. */
export function secureAtomicWrite(path: string, bytes: Uint8Array, immutable = false): void {
  const absolute = resolve(path);
  const parent = ensurePrivateDirectory(dirname(absolute));
  refuseSymlink(absolute);
  if (existsSync(absolute)) {
    const existing = secureRead(absolute);
    if (immutable) {
      if (!sameBytes(existing, bytes)) {
        throw new HostStateError("state-io", "immutable artifact already exists with different bytes");
      }
      return;
    }
  }
  const temporary = join(parent, `.jinn-write-${crypto.randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    refuseSymlink(absolute);
    renameSync(temporary, absolute);
    chmodSync(absolute, 0o600);
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* best-effort cleanup of an unpublished temporary */ }
    if (cause instanceof HostStateError) throw cause;
    throw new HostStateError("state-io", "secure state write failed");
  }
}

const ADVISORY_LOCK_PROGRAM = String.raw`
import fcntl, os, sys
path = sys.argv[1]
flags = os.O_RDWR | os.O_CREAT
if hasattr(os, "O_NOFOLLOW"): flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
try:
  fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
  print("busy", flush=True)
  sys.exit(73)
print("locked", flush=True)
sys.stdin.buffer.read()
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;

/**
 * Holds a real OS advisory lock for the entire replay → side-effects → append critical section.
 * Node has no flock binding, so a tiny isolated Python helper owns the descriptor; inability to
 * obtain that primitive is a stable refusal, never a silent lock-file downgrade.
 */
export async function withHostAdvisoryLock<T>(stateRoot: string, operation: () => Promise<T>): Promise<T> {
  const root = ensurePrivateDirectory(stateRoot);
  const lockPath = join(root, "host.lock");
  refuseSymlink(lockPath);
  const child = spawn("python3", ["-I", "-c", ADVISORY_LOCK_PROGRAM, lockPath], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {},
  });
  const status = await new Promise<string>((resolveStatus, reject) => {
    let line = "";
    const fail = () => reject(new HostStateError("state-locked", "host advisory lock is unavailable"));
    child.once("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      line += chunk;
      const newline = line.indexOf("\n");
      if (newline >= 0) resolveStatus(line.slice(0, newline));
    });
    child.once("exit", () => { if (line.length === 0) fail(); });
  });
  if (status !== "locked") {
    child.stdin.end();
    throw new HostStateError("state-locked", "another jinn-optimize process holds this campaign");
  }
  try {
    return await operation();
  } finally {
    child.stdin.end();
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
}
