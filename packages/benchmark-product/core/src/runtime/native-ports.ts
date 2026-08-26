import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  FixedNativeInvocation,
  IdempotentNativeLauncher,
  NativeLaunchResult,
  NativeSnapshot,
  NativeSnapshotPort,
  NativeSource,
  SnapshotPolicy,
} from "@jinn-network/benchmarking-native-capture";
import type { NativeSnapshotEntry, NativeSnapshotReader } from "@jinn-network/benchmarking-native-capture";

/**
 * Provider-backed filesystem and process bindings for the native-capture ports.
 *
 * PR #2712 shipped `NativeSnapshotPort` and `IdempotentNativeLauncher` with test doubles only, and
 * named provider-backed bindings as follow-up integration. They are Colophon's to own — the
 * evidence-first design assigns local storage and process orchestration to tier 4 — and they are
 * shared: Harbor and Inspect need exactly the same two ports that SkillsBench does.
 *
 * Neither binding runs a container. The snapshot port walks a directory; the launcher spawns a
 * process. What the invocation points at is the caller's business.
 */
export const NATIVE_SNAPSHOT_ALGORITHM = "jinn.native-snapshot.sha256-tree@1" as const;

/** The refusals the design requires: no link-following, no special files, no archive bombs. */
export const STRICT_SNAPSHOT_POLICY: SnapshotPolicy = {
  followSymlinks: false,
  allowHardlinks: false,
  allowSpecialFiles: false,
  maximumBytes: 2 * 1024 * 1024 * 1024,
  maximumEntries: 200_000,
};

export class NativeSnapshotRefusedError extends Error {
  readonly code = "snapshot-refused" as const;
  constructor(reason: string) {
    super(`native snapshot refused: ${reason}`);
    this.name = "NativeSnapshotRefusedError";
  }
}

export class NativeSourceMutatedError extends Error {
  readonly code = "source-mutated" as const;
  constructor(readonly snapshotId: string) {
    super(`native source mutated after snapshot ${snapshotId}; the pinned bytes are no longer what was captured`);
    this.name = "NativeSourceMutatedError";
  }
}

interface WalkResult {
  readonly entries: readonly NativeSnapshotEntry[];
  readonly digests: ReadonlyMap<string, string>;
  readonly bytes: number;
}

function walk(root: string, policy: SnapshotPolicy): WalkResult {
  const entries: NativeSnapshotEntry[] = [];
  const digests = new Map<string, string>();
  let bytes = 0;

  const descend = (absolute: string, prefix: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      const child = join(absolute, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const stats = lstatSync(child);

      if (stats.isSymbolicLink()) {
        // Following a link would let content outside the snapshot root into the digest, and the
        // digest is the whole point of a snapshot.
        throw new NativeSnapshotRefusedError(`"${path}" is a symbolic link and followSymlinks is false`);
      }
      if (stats.isDirectory()) {
        descend(child, path);
        continue;
      }
      if (!stats.isFile()) {
        throw new NativeSnapshotRefusedError(`"${path}" is not a regular file or directory`);
      }
      if (!policy.allowHardlinks && stats.nlink > 1) {
        throw new NativeSnapshotRefusedError(`"${path}" is a hardlink (nlink=${stats.nlink}) and allowHardlinks is false`);
      }
      if (entries.length >= policy.maximumEntries) {
        throw new NativeSnapshotRefusedError(`entry count exceeds the policy maximum of ${policy.maximumEntries}`);
      }
      bytes += stats.size;
      if (bytes > policy.maximumBytes) {
        throw new NativeSnapshotRefusedError(`total size exceeds the policy maximum of ${policy.maximumBytes} bytes`);
      }
      entries.push({ path, kind: "file", size: stats.size });
      digests.set(path, createHash("sha256").update(readFileSync(child)).digest("hex"));
    }
  };

  descend(root, "");
  return { entries, digests, bytes };
}

/** Root digest over the sorted `<path>:<sha256>` lines — the same shape the workspace tree hash uses. */
function rootDigest(walked: WalkResult): string {
  const lines = [...walked.digests].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, digest]) => `${path}:${digest}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface FilesystemSnapshotOptions {
  /** Resolves a source locator to an absolute directory. Keeps path policy out of this module. */
  readonly resolveRoot: (source: NativeSource) => string;
  readonly now: () => string;
}

/**
 * Filesystem-backed `NativeSnapshotPort`.
 *
 * `snapshot` captures exact bytes without following links and refuses traversal, special files,
 * hardlinks, and oversize or over-count trees. `assertUnchanged` re-walks and compares the root
 * digest, so a source mutated between capture and use is a hard error rather than a silent
 * substitution.
 */
export function createFilesystemNativeSnapshotPort(
  options: FilesystemSnapshotOptions,
): NativeSnapshotPort & NativeSnapshotReader {
  const captured = new Map<string, { readonly root: string; readonly walked: WalkResult; readonly policy: SnapshotPolicy }>();

  return {
    snapshot(source: NativeSource, policy: SnapshotPolicy): NativeSnapshot {
      const root = options.resolveRoot(source);
      if (!existsSync(root) || !lstatSync(root).isDirectory()) {
        throw new NativeSnapshotRefusedError(`"${source.locator}" does not resolve to a directory`);
      }
      const walked = walk(root, policy);
      const sha256 = rootDigest(walked);
      const snapshotId = `snap-${sha256.slice(0, 32)}`;
      captured.set(snapshotId, { root, walked, policy });
      return {
        snapshotId,
        source,
        root: { name: source.locator, digest: { sha256 }, annotations: { algorithm: NATIVE_SNAPSHOT_ALGORITHM } } as never,
        capturedAt: options.now(),
      };
    },

    assertUnchanged(snapshot: NativeSnapshot): void {
      const held = captured.get(snapshot.snapshotId);
      if (held === undefined) {
        throw new NativeSnapshotRefusedError(`snapshot ${snapshot.snapshotId} was not captured by this port`);
      }
      if (rootDigest(walk(held.root, held.policy)) !== (snapshot.root as { digest: { sha256: string } }).digest.sha256) {
        throw new NativeSourceMutatedError(snapshot.snapshotId);
      }
    },

    list(snapshot: NativeSnapshot): readonly NativeSnapshotEntry[] {
      const held = captured.get(snapshot.snapshotId);
      if (held === undefined) throw new NativeSnapshotRefusedError(`snapshot ${snapshot.snapshotId} is unknown`);
      return held.walked.entries;
    },

    read(snapshot: NativeSnapshot, path: string): Uint8Array {
      const held = captured.get(snapshot.snapshotId);
      if (held === undefined) throw new NativeSnapshotRefusedError(`snapshot ${snapshot.snapshotId} is unknown`);
      const expected = held.walked.digests.get(path);
      if (expected === undefined) throw new NativeSnapshotRefusedError(`"${path}" is not in snapshot ${snapshot.snapshotId}`);
      const bytes = readFileSync(join(held.root, ...path.split("/")));
      if (createHash("sha256").update(bytes).digest("hex") !== expected) {
        throw new NativeSourceMutatedError(snapshot.snapshotId);
      }
      return new Uint8Array(bytes);
    },
  };
}

interface LaunchState {
  readonly launchId: string;
  readonly invocationDigest: string;
  readonly exitCode: number;
  readonly resultLocator: string;
  readonly limitations: readonly string[];
}

export interface ProcessLauncherOptions {
  /** Directory holding one durable state file per launch. */
  readonly stateDir: string;
  /** Where a completed launch's results land. */
  readonly resultLocator: (launchId: string) => string;
  readonly timeoutMs?: number;
}

function invocationDigest(invocation: FixedNativeInvocation): string {
  return createHash("sha256").update(JSON.stringify({
    executable: invocation.executable.path,
    argv: invocation.argv,
    environment: [...invocation.environment].sort((a, b) => (a.name < b.name ? -1 : 1)),
    workingDirectoryPolicy: invocation.workingDirectoryPolicy,
  })).digest("hex");
}

/**
 * Process-backed `IdempotentNativeLauncher`.
 *
 * Idempotency is durable, not in-memory: a completed launch writes a state file, and a repeat
 * `ensureStarted` with the same id returns without spawning anything. Re-running the same id with a
 * *different* invocation is a hard error — that would silently change what a sealed launch id
 * refers to, which is the one thing an idempotency key must never allow.
 */
export function createProcessNativeLauncher(options: ProcessLauncherOptions): IdempotentNativeLauncher {
  mkdirSync(options.stateDir, { recursive: true });
  const statePath = (launchId: string) => resolve(options.stateDir, `${launchId}.json`);

  const readState = (launchId: string): LaunchState | undefined => {
    const path = statePath(launchId);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as LaunchState;
  };

  return {
    ensureStarted(launchId: string, invocation: FixedNativeInvocation): void {
      const digest = invocationDigest(invocation);
      const existing = readState(launchId);
      if (existing !== undefined) {
        if (existing.invocationDigest !== digest) {
          throw new Error(`launch ${launchId} already ran a different invocation; an idempotency key cannot be reused`);
        }
        return;
      }
      // Exactly the sealed invocation's environment and nothing else — including no `TMPDIR`,
      // `TMP` or `TEMP` unless the invocation names them. A fixed native invocation is a record
      // that has to reproduce byte-for-byte from what it declares; a variable injected here from
      // the host would make the same record run differently on two machines, which is the one
      // property this port exists to deny. A caller that needs the child to write somewhere
      // specific declares it in `invocation.environment`.
      const env: Record<string, string> = {};
      for (const { name, value } of invocation.environment) env[name] = value;
      const result = spawnSync(invocation.executable.path, [...invocation.argv], {
        env,
        encoding: "utf8",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
      const limitations: string[] = [];
      if (result.error !== undefined) limitations.push(`launch error: ${result.error.message}`);
      if (result.signal !== null && result.signal !== undefined) limitations.push(`terminated by signal ${result.signal}`);
      const state: LaunchState = {
        launchId,
        invocationDigest: digest,
        // A signalled or errored launch has no meaningful exit code; 70 is recorded rather than a
        // fabricated 0, and the reason travels with it in `limitations`.
        exitCode: result.status ?? 70,
        resultLocator: options.resultLocator(launchId),
        limitations,
      };
      writeFileSync(statePath(launchId), JSON.stringify(state), { mode: 0o600 });
    },

    wait(launchId: string): NativeLaunchResult {
      const state = readState(launchId);
      if (state === undefined) throw new Error(`launch ${launchId} was never started`);
      return {
        exitCode: state.exitCode,
        resultSource: { kind: "filesystem", locator: state.resultLocator },
        limitations: state.limitations,
      };
    },
  };
}
