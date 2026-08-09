import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
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
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface RuntimeWorkspace {
  readonly runId: string;
  readonly ownershipToken: string;
  readonly runRoot: string;
  readonly workspaceDir: string;
  readonly copiedBundleDir: string;
  readonly ownershipMarker: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const OWNERSHIP_BRAND: unique symbol = Symbol("benchmark-product-browser-ownership");

/**
 * This object is returned only to the Playwright setup controller and captured
 * by its teardown closure. No filesystem content can recreate its authority.
 */
export interface RuntimeWorkspaceOwnership {
  readonly [OWNERSHIP_BRAND]: true;
  readonly runId: string;
  readonly ownershipToken: string;
  readonly runRoot: string;
  readonly markerPath: string;
  readonly markerBytes: string;
  readonly rootIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
  cleanupBlocked: boolean;
  cleanupCompleted: boolean;
}

/** Deterministic race points used only by the ownership regression suite. */
export interface RuntimeWorkspaceCleanupTestHooks {
  readonly afterQuarantine?: (paths: Readonly<{ original: string; quarantine: string }>) => void;
  readonly afterFirstValidation?: (paths: Readonly<{ original: string; quarantine: string }>) => void;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MARKER_NAME = ".bp50-browser-owner.json";
const MARKER_FORMAT = "benchmark-product-browser-owner/1";
const ALLOWED_ROOT_DIRECTORIES = new Set([
  "workspace",
  "copied-public-bundle",
  "copied-cancelled-public-bundle",
]);

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function markerBytes(runtime: RuntimeWorkspace): string {
  return `${JSON.stringify({ format: MARKER_FORMAT, runId: runtime.runId, ownershipToken: runtime.ownershipToken })}\n`;
}

function identity(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  if (constants.O_NOFOLLOW === undefined) throw new Error("browser workspace ownership requires O_NOFOLLOW");
  return openSync(path, flags | constants.O_NOFOLLOW, mode);
}

function fsyncDirectory(path: string): void {
  const descriptor = openNoFollow(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function directoryIdentity(path: string, label: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not an exact directory`);
  return identity(stat);
}

function markerSnapshot(path: string): Readonly<{ identity: FileIdentity; bytes: string }> {
  const descriptor = openNoFollow(path, constants.O_RDONLY);
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

function assertMarker(root: string, owner: RuntimeWorkspaceOwnership): void {
  let marker: Readonly<{ identity: FileIdentity; bytes: string }>;
  try {
    marker = markerSnapshot(join(root, MARKER_NAME));
  } catch (cause) {
    throw new Error(`ownership marker validation failed: ${message(cause)}`);
  }
  if (!sameIdentity(marker.identity, owner.markerIdentity)) throw new Error("ownership marker identity changed");
  if (marker.bytes !== owner.markerBytes) throw new Error("ownership marker bytes changed");
}

function assertAllowedRootChildren(root: string): void {
  for (const name of readdirSync(root)) {
    if (name === MARKER_NAME) continue;
    if (!ALLOWED_ROOT_DIRECTORIES.has(name)) throw new Error(`unproven root entry ${name} blocks recursive cleanup`);
    const stat = lstatSync(join(root, name), { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`owned root child ${name} is not an exact directory`);
    }
  }
}

function assertOwnedRoot(root: string, owner: RuntimeWorkspaceOwnership): void {
  const actualRoot = directoryIdentity(root, "browser cleanup root");
  if (!sameIdentity(actualRoot, owner.rootIdentity)) throw new Error("browser cleanup root identity changed");
  assertMarker(root, owner);
  assertAllowedRootChildren(root);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function quarantinePath(target: string, token: string): string {
  return join(dirname(target), `.${basename(target)}.quarantine-${token}-${randomUUID()}`);
}

function retainQuarantine(
  owner: RuntimeWorkspaceOwnership,
  original: string,
  quarantine: string,
  reason: string,
): never {
  owner.cleanupBlocked = true;
  let restoration: string;
  let restorationCreated = false;
  try {
    // Exclusive creation restores reachability without overwriting an occupant.
    // The quarantine remains the evidence authority and is never deleted again.
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

function assertOwnershipMatchesRuntime(runtime: RuntimeWorkspace, owner: RuntimeWorkspaceOwnership): void {
  if (owner[OWNERSHIP_BRAND] !== true
    || owner.runId !== runtime.runId
    || owner.ownershipToken !== runtime.ownershipToken
    || owner.runRoot !== runtime.runRoot
    || owner.markerPath !== runtime.ownershipMarker
    || owner.markerBytes !== markerBytes(runtime)) {
    throw new Error("browser cleanup ownership does not match this runtime");
  }
}

export function deriveRuntimeWorkspace(input: {
  readonly baseDir: string;
  readonly runId: string;
  readonly ownershipToken: string;
}): RuntimeWorkspace {
  if (!RUN_ID.test(input.runId)) throw new Error("browser run id must be a UUID");
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(input.ownershipToken)) throw new Error("browser ownership token is invalid");
  const runRoot = resolve(input.baseDir, `jinn-bp50-browser-${input.runId}`);
  return {
    runId: input.runId,
    ownershipToken: input.ownershipToken,
    runRoot,
    workspaceDir: join(runRoot, "workspace"),
    copiedBundleDir: join(runRoot, "copied-public-bundle"),
    ownershipMarker: join(runRoot, MARKER_NAME),
  };
}

/**
 * Exclusive creation means a stale/crashed invocation is never reused. A setup
 * failure retains its partial root instead of acquiring blind recursive authority.
 */
export function prepareRuntimeWorkspace(runtime: RuntimeWorkspace): RuntimeWorkspaceOwnership {
  mkdirSync(runtime.runRoot);
  try {
    const rootIdentity = directoryIdentity(runtime.runRoot, "browser run root");
    const bytes = markerBytes(runtime);
    const markerDescriptor = openNoFollow(
      runtime.ownershipMarker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let markerIdentity: FileIdentity;
    try {
      writeFileSync(markerDescriptor, bytes, { encoding: "utf8" });
      fsyncSync(markerDescriptor);
      markerIdentity = identity(fstatSync(markerDescriptor, { bigint: true }));
    } finally {
      closeSync(markerDescriptor);
    }
    mkdirSync(runtime.workspaceDir);
    fsyncDirectory(runtime.runRoot);
    fsyncDirectory(dirname(runtime.runRoot));
    return {
      [OWNERSHIP_BRAND]: true,
      runId: runtime.runId,
      ownershipToken: runtime.ownershipToken,
      runRoot: runtime.runRoot,
      markerPath: runtime.ownershipMarker,
      markerBytes: bytes,
      rootIdentity,
      markerIdentity,
      cleanupBlocked: false,
      cleanupCompleted: false,
    };
  } catch (cause) {
    throw new Error(`browser workspace preparation failed; partial evidence retained at ${runtime.runRoot}: ${message(cause)}`);
  }
}

/**
 * Quarantines the path, then compares it with setup-controller memory twice
 * before the only recursive deletion. Filesystem contents never assert authority.
 */
export function cleanupRuntimeWorkspace(
  runtime: RuntimeWorkspace,
  owner: RuntimeWorkspaceOwnership,
  testHooks?: RuntimeWorkspaceCleanupTestHooks,
): void {
  if (owner.cleanupBlocked) throw new Error("browser cleanup is blocked by retained unproven evidence");
  if (owner.cleanupCompleted) throw new Error("browser cleanup ownership was already consumed");
  assertOwnershipMatchesRuntime(runtime, owner);

  const expectedRootName = `jinn-bp50-browser-${runtime.runId}`;
  if (basename(runtime.runRoot) !== expectedRootName
    || dirname(runtime.ownershipMarker) !== runtime.runRoot
    || basename(runtime.ownershipMarker) !== MARKER_NAME) {
    throw new Error("refusing browser cleanup outside the exact per-run boundary");
  }
  const resolvedBase = realpathSync(dirname(runtime.runRoot));
  const baseStat = lstatSync(resolvedBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error("browser cleanup parent is not an exact directory");
  }

  const quarantine = quarantinePath(runtime.runRoot, runtime.ownershipToken);
  if (pathExists(quarantine)) throw new Error("refusing an occupied browser cleanup quarantine");
  try {
    renameSync(runtime.runRoot, quarantine);
  } catch (cause) {
    owner.cleanupBlocked = true;
    throw new Error(`browser cleanup quarantine rename failed; target retained: ${message(cause)}`);
  }
  const paths = Object.freeze({ original: runtime.runRoot, quarantine });

  try {
    fsyncDirectory(dirname(runtime.runRoot));
    testHooks?.afterQuarantine?.(paths);
    assertOwnedRoot(quarantine, owner);
    testHooks?.afterFirstValidation?.(paths);
  } catch (cause) {
    retainQuarantine(owner, runtime.runRoot, quarantine, message(cause));
  }

  // Immediate second validation catches quarantine ABA/replacement before rm.
  try {
    assertOwnedRoot(quarantine, owner);
  } catch (cause) {
    retainQuarantine(owner, runtime.runRoot, quarantine, message(cause));
  }

  try {
    rmSync(quarantine, { recursive: true, force: false });
    fsyncDirectory(dirname(runtime.runRoot));
    owner.cleanupCompleted = true;
  } catch (cause) {
    owner.cleanupBlocked = true;
    const evidence = pathExists(quarantine)
      ? `retained evidence at ${quarantine}`
      : `quarantine at ${quarantine} was only partially removable`;
    throw new Error(`validated browser quarantine removal failed; ${evidence}: ${message(cause)}`);
  }
}
