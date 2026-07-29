import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";

export interface SecretForwardDeclaration {
  readonly grantKey: string;
  readonly target: string;
}

export interface SecretForwardResolver {
  resolve(
    input: {
      readonly attempt: AttemptIdentity;
      readonly grantKey: string;
      readonly descriptor: unknown;
    },
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

export async function materializeSecretForwards(input: {
  readonly attempt: AttemptIdentity;
  readonly secrets: string;
  readonly forwards: readonly SecretForwardDeclaration[];
  readonly grants: ReadonlyMap<string, unknown>;
  readonly resolver: SecretForwardResolver;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const targets = new Set<string>();
  const grantKeys = new Set<string>();
  for (const forward of input.forwards) {
    if (!validTarget(forward.target)) throw new Error("secret forward target must be a portable basename");
    if (targets.has(forward.target) || grantKeys.has(forward.grantKey)) {
      throw new Error("secret forward declarations must have unique targets and grant keys");
    }
    if (!input.grants.has(forward.grantKey)) throw new Error("secret forward declares a missing grant");
    targets.add(forward.target);
    grantKeys.add(forward.grantKey);
  }
  await mkdir(input.secrets, { recursive: true, mode: 0o700 });
  const directory = await lstat(input.secrets);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) {
    throw new Error("secrets directory must be a non-symlink 0700 directory");
  }
  for (const forward of input.forwards) {
    let resolved: Uint8Array | undefined;
    let snapshot: Uint8Array | undefined;
    try {
      resolved = await input.resolver.resolve({
        attempt: input.attempt,
        grantKey: forward.grantKey,
        descriptor: input.grants.get(forward.grantKey),
      }, { signal: input.signal });
      snapshot = Uint8Array.from(resolved);
      const file = await open(
        join(input.secrets, forward.target),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(snapshot);
        await file.sync();
      } finally {
        await file.close();
      }
    } finally {
      if (snapshot !== undefined) zero(snapshot);
      if (resolved !== undefined) zero(resolved);
    }
  }
}
