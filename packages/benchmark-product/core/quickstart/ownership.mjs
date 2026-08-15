import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const rootPrefix = "benchmark-product-public-quickstart-";
const markerName = ".benchmark-product-public-quickstart-owner.json";
const markerFormat = "benchmark-product-public-quickstart-owner/1";

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryIdentity(path, label) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not an exact directory`);
  }
  return identity(stat);
}

function fsyncDirectory(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function markerSnapshot(path) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error("ownership marker is not a sole regular file");
    }
    return { identity: identity(stat), bytes: readFileSync(descriptor, "utf8") };
  } finally {
    closeSync(descriptor);
  }
}

function assertPathIdentity(path, expected, label) {
  const actual = directoryIdentity(path, label);
  if (!sameIdentity(actual, expected)) throw new Error(`${label} identity changed`);
}

function assertMarker(owner, root) {
  let actual;
  try {
    actual = markerSnapshot(join(root, markerName));
  } catch (cause) {
    throw new Error(`ownership marker validation failed: ${message(cause)}`);
  }
  if (!sameIdentity(actual.identity, owner.markerIdentity)) {
    throw new Error("ownership marker identity changed");
  }
  if (actual.bytes !== owner.markerBytes) throw new Error("ownership marker bytes changed");
}

function assertRoot(owner, root = owner.root) {
  assertPathIdentity(root, owner.rootIdentity, "cleanup root");
  assertMarker(owner, root);
}

function assertExactChildPath(owner, path, name) {
  if (path !== join(owner.root, name) || dirname(path) !== owner.root) {
    throw new Error(`refusing non-owned ${name} path`);
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

function retainedFailure(owner, original, quarantine, reason) {
  owner.cleanupBlocked = true;
  let restoration;
  let restorationCreated = false;
  try {
    // The relative symlink is an atomic, exclusive, non-overwriting restoration
    // of reachability to the exact quarantined inode. The quarantine remains the
    // evidence authority and a poisoned owner can never clean it recursively.
    symlinkSync(basename(quarantine), original, "dir");
    restorationCreated = true;
    fsyncDirectory(dirname(original));
    const restored = lstatSync(original);
    if (!restored.isSymbolicLink() || readlinkSync(original) !== basename(quarantine)) {
      throw new Error("exclusive restoration link did not preserve the quarantine target");
    }
    restoration = `reachability restored without overwrite at ${original}`;
  } catch (cause) {
    restoration = !restorationCreated && pathExists(original)
      ? `original path occupied; restoration refused (${message(cause)})`
      : `restoration or parent fsync failed (${message(cause)})`;
  }
  throw new Error(`${reason}; retained evidence at ${quarantine}; ${restoration}`);
}

function quarantinePath(target, token) {
  return join(dirname(target), `.${basename(target)}.quarantine-${token}-${randomUUID()}`);
}

function quarantineAndRemove(owner, target, validateMoved) {
  const quarantine = quarantinePath(target, owner.token);
  if (pathExists(quarantine)) throw new Error("refusing an occupied cleanup quarantine");
  try {
    renameSync(target, quarantine);
  } catch (cause) {
    owner.cleanupBlocked = true;
    throw new Error(`cleanup quarantine rename failed; target retained at ${target}: ${message(cause)}`);
  }

  try {
    fsyncDirectory(dirname(target));
    validateMoved(quarantine);
  } catch (cause) {
    retainedFailure(owner, target, quarantine, message(cause));
  }

  // Revalidate immediately before the only recursive deletion. A unique,
  // invocation-tokened quarantine is never accepted on marker bytes alone.
  try {
    validateMoved(quarantine);
  } catch (cause) {
    retainedFailure(owner, target, quarantine, message(cause));
  }

  try {
    rmSync(quarantine, { recursive: true, force: false });
  } catch (cause) {
    owner.cleanupBlocked = true;
    const evidence = pathExists(quarantine)
      ? `retained evidence at ${quarantine}`
      : `quarantine at ${quarantine} was only partially removable`;
    throw new Error(`validated quarantine removal failed; ${evidence}: ${message(cause)}`);
  }
  try {
    fsyncDirectory(dirname(target));
  } catch (cause) {
    owner.cleanupBlocked = true;
    throw new Error(`validated quarantine was removed but parent fsync failed: ${message(cause)}`);
  }
}

function trackedChild(owner, name) {
  if (name === "source-workspace") return owner.workspace;
  if (name === "copied-public-bundle") return owner.portableBundle;
  return undefined;
}

function assertRootChildren(owner, movedRoot) {
  const names = readdirSync(movedRoot).sort();
  const allowed = new Set([markerName]);
  for (const [name, record] of [
    ["source-workspace", owner.workspace],
    ["copied-public-bundle", owner.portableBundle],
  ]) {
    if (record?.state === "present") allowed.add(name);
    if (record?.state === "removed" && names.includes(name)) {
      throw new Error(`${name} reappeared after identity-bound cleanup`);
    }
  }
  for (const name of names) {
    if (!allowed.has(name)) throw new Error(`unproven root entry ${name} blocks recursive cleanup`);
    const record = trackedChild(owner, name);
    if (record?.state === "present") {
      assertPathIdentity(join(movedRoot, name), record.identity, name);
    }
  }
  for (const name of allowed) {
    if (!names.includes(name)) throw new Error(`tracked root entry ${name} is missing`);
  }
}

export function createOwnedRoot({ temporaryBase } = {}) {
  const base = realpathSync(temporaryBase);
  const baseStat = lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error("temporary base must be an exact directory");
  }
  const root = realpathSync(mkdtempSync(join(base, rootPrefix)));
  if (dirname(root) !== base || !basename(root).startsWith(rootPrefix)) {
    throw new Error("mkdtemp returned a path outside the approved temporary root");
  }
  const token = randomUUID();
  const markerBytes = `${JSON.stringify({ format: markerFormat, token })}\n`;
  const markerPath = join(root, markerName);
  writeFileSync(markerPath, markerBytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const markerDescriptor = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(markerDescriptor);
  } finally {
    closeSync(markerDescriptor);
  }
  fsyncDirectory(root);
  fsyncDirectory(base);
  const rootIdentity = directoryIdentity(root, "cleanup root");
  const marker = markerSnapshot(markerPath);
  return {
    root,
    temporaryBase: base,
    token,
    markerPath,
    markerBytes,
    rootIdentity,
    markerIdentity: marker.identity,
    workspace: undefined,
    portableBundle: undefined,
    cleanupBlocked: false,
  };
}

export function captureOwnedWorkspace(owner, path) {
  if (owner.cleanupBlocked) throw new Error("cleanup owner is blocked by unproven retained evidence");
  assertRoot(owner);
  if (path !== join(owner.root, "source-workspace")) throw new Error("unexpected source-workspace path");
  owner.workspace = { identity: directoryIdentity(path, "source-workspace"), state: "present" };
}

export function captureOwnedPortableBundle(owner, path) {
  if (owner.cleanupBlocked) throw new Error("cleanup owner is blocked by unproven retained evidence");
  assertRoot(owner);
  if (path !== join(owner.root, "copied-public-bundle")) throw new Error("unexpected copied-public-bundle path");
  owner.portableBundle = { identity: directoryIdentity(path, "copied-public-bundle"), state: "present" };
}

export function removeOwnedWorkspace(owner, path) {
  if (owner.cleanupBlocked) throw new Error("cleanup is blocked by unproven retained evidence");
  if (owner.workspace?.state !== "present") throw new Error("source-workspace identity was not captured");
  assertRoot(owner);
  assertExactChildPath(owner, path, "source-workspace");
  quarantineAndRemove(owner, path, (moved) => {
    assertRoot(owner);
    assertPathIdentity(moved, owner.workspace.identity, "source-workspace");
  });
  owner.workspace.state = "removed";
}

export function removeOwnedRoot(owner) {
  if (owner.cleanupBlocked) throw new Error("cleanup is blocked by unproven retained evidence");
  if (dirname(owner.root) !== owner.temporaryBase || !basename(owner.root).startsWith(rootPrefix)) {
    throw new Error("cleanup root is outside the approved temporary parent");
  }
  quarantineAndRemove(owner, owner.root, (moved) => {
    assertRoot(owner, moved);
    assertRootChildren(owner, moved);
  });
}

export function combinePrimaryAndCleanupFailure(primary, cleanup) {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  const combined = new Error(
    `${message(primary)}; owner-fenced cleanup also failed: ${message(cleanup)}`,
    { cause: new AggregateError([primary, cleanup], "primary operation and cleanup both failed") },
  );
  if (typeof primary?.exitCode === "number") combined.exitCode = primary.exitCode;
  else if (typeof cleanup?.exitCode === "number") combined.exitCode = cleanup.exitCode;
  return combined;
}
