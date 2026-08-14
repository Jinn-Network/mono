import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HostSecretForwardDeclaration } from "@jinn-network/task-execution-launchers";
import { fsyncBestEffort, type AttemptIdentity } from "@jinn-network/task-execution-supervisor";

export interface HostSecretAuthorization {
  readonly attempt: AttemptIdentity;
  readonly launcherId: string;
  readonly taskDigest: `sha256:${string}`;
  readonly submission: `urn:uuid:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly taskProfile: string;
  readonly deadline: string;
}

export interface HostSecretResolver {
  resolve(
    input: HostSecretAuthorization & HostSecretForwardDeclaration,
    options: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>;
}

function validTarget(target: string): boolean {
  return target.length > 0
    && basename(target) === target
    && target !== "."
    && target !== ".."
    && !target.includes("/")
    && !target.includes("\\")
    && !target.includes("\u0000");
}

function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** Materializes deployment-owned authority without consulting requester capability grants. */
export async function materializeHostSecretForwards(input: {
  readonly authorization: HostSecretAuthorization;
  readonly secrets: string;
  readonly forwards: readonly HostSecretForwardDeclaration[];
  readonly resolver: HostSecretResolver;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const targets = new Set<string>();
  const handles = new Set<string>();
  for (const forward of input.forwards) {
    if (!validTarget(forward.target)) throw new Error("host secret target must be a portable basename");
    if (!validTarget(forward.handle)) throw new Error("host secret handle must be a portable logical handle");
    if (forward.role === "evaluator" && (forward.evaluator === undefined || forward.evaluator.trim().length === 0)) {
      throw new Error("evaluator host secret authority must name a deployment-owned evaluator");
    }
    if (forward.role !== "evaluator" && forward.role !== "harness") {
      throw new Error("host secret authority role is unsupported");
    }
    if (targets.has(forward.target) || handles.has(forward.handle)) {
      throw new Error("host secret declarations must have unique targets and handles");
    }
    targets.add(forward.target);
    handles.add(forward.handle);
  }
  try {
    input.signal?.throwIfAborted();
    await mkdir(input.secrets, { recursive: true, mode: 0o700 });
    const directory = await lstat(input.secrets);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) {
      throw new Error("secrets directory must be a non-symlink 0700 directory");
    }
    for (const forward of input.forwards) {
      input.signal?.throwIfAborted();
      let resolved: Uint8Array | undefined;
      let snapshot: Uint8Array | undefined;
      try {
        resolved = await input.resolver.resolve({ ...input.authorization, ...forward }, { signal: input.signal });
        input.signal?.throwIfAborted();
        snapshot = Uint8Array.from(resolved);
        const file = await open(
          join(input.secrets, forward.target),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(snapshot);
          await fsyncBestEffort(file);
        } finally {
          await file.close();
        }
      } finally {
        if (snapshot !== undefined) zero(snapshot);
        if (resolved !== undefined) zero(resolved);
      }
    }
  } catch (error) {
    await rm(input.secrets, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
