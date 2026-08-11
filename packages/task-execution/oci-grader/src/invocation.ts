// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { refuse } from "./errors.js";
import { ensurePrivateDirectory } from "./private-fs.js";

/**
 * OCI reference grammar (docker/distribution `reference` package), restricted to lowercase
 * registry-host and path components. A grader image is identified by its digest, never a mutable
 * tag — and the grammar itself must admit only real references, never a docker-flag-shaped string
 * such as `--volume=/:/hostfs@sha256:<hex>`, which `docker run` would parse as a flag, not an
 * image, because `familyBlock.image.uri` is untrusted specification data.
 */
const REGISTRY = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?`;
const COMPONENT = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`;
/** Non-anchored so `swe-rebench-source.ts` can wrap it in its own `docker://(...)` capture. */
export const PINNED_IMAGE_BODY =
  `(?:${REGISTRY}/)?${COMPONENT}(?:/${COMPONENT})*@sha256:[a-f0-9]{64}`;
export const PINNED_IMAGE = new RegExp(`^${PINNED_IMAGE_BODY}$`, "u");
const SAFE_TARGET = /^\/jinn\/(?:input\/[a-z0-9][a-z0-9._-]*|out)$/u;
const SECRET_SEGMENT = /^(?:\.aws|\.config|\.docker|\.gnupg|\.ssh|credentials?|keys?|secrets?)$/iu;
const MAX_TIMEOUT_MS = 3_600_000;

export interface PinnedOciGraderInput {
  readonly runtime: "docker" | "podman";
  readonly image: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly inputs: readonly { readonly source: string; readonly targetName: string }[];
  readonly outputDirectory: string;
  readonly command: readonly [string, ...string[]];
  /** Overrides an image's deployment entrypoint with a reviewed executable inside the image. */
  readonly entrypoint?: string;
  readonly timeoutMs: number;
  readonly profileRequiresNetwork: boolean;
  /** Must be an explicit isolated runtime network, never `host`. */
  readonly allowedNetwork?: string;
}

export interface PinnedOciInvocation {
  readonly command: "docker" | "podman";
  readonly args: readonly string[];
  readonly containerName: string;
  readonly statementPath: string;
}

function assertNoSymlinksOrSecrets(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) refuse("grader input contains a symbolic link");
  if (SECRET_SEGMENT.test(basename(path))) {
    refuse("credential or signer material cannot enter the grader sandbox");
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) assertNoSymlinksOrSecrets(join(path, entry));
}

/** Pure command builder so the security posture is reviewable and testable without a daemon. */
export function buildPinnedOciInvocation(input: PinnedOciGraderInput): PinnedOciInvocation {
  if (input.image.startsWith("-")) refuse("grader image must not begin with a dash");
  if (!PINNED_IMAGE.test(input.image)) refuse("grader image must be pinned by sha256 digest");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) {
    refuse("grader timeout must be a positive bounded duration");
  }
  if (input.command.length === 0 || input.command.some((part) => part.length === 0)) {
    refuse("grader command is empty");
  }
  // Matches the source's check (grader-oci.ts:97): a NUL or newline in an argv element is the
  // injection-shaped input worth refusing. A space is legitimate in an entrypoint path and is
  // safe here because every element reaches the runtime as its own argv slot, never via a shell.
  if (input.entrypoint !== undefined
    && (input.entrypoint.length === 0 || /[\0\r\n]/u.test(input.entrypoint))) {
    refuse("grader entrypoint is invalid");
  }
  const network = input.profileRequiresNetwork ? input.allowedNetwork : "none";
  if (network === undefined || network === "" || network === "host") {
    refuse("network is disabled unless the profile explicitly requires an isolated network");
  }
  const output = ensurePrivateDirectory(input.outputDirectory);
  assertNoSymlinksOrSecrets(output);
  const mounts: string[] = [];
  const targets = new Set<string>();
  for (const item of input.inputs) {
    const target = `/jinn/input/${item.targetName}`;
    if (!SAFE_TARGET.test(target) || targets.has(target)) {
      refuse("grader input target is unsafe or duplicated");
    }
    assertNoSymlinksOrSecrets(item.source);
    const source = realpathSync(item.source);
    targets.add(target);
    mounts.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
  }
  const containerName = `jinn-oci-grader-${randomUUID()}`;
  const args = [
    "run", "--rm", "--pull", "never", "--name", containerName,
    "--platform", input.platform,
    "--network", network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "4g",
    "--cpus", "2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m",
    "--env", "HOME=/tmp/jinn-grader-home",
    ...mounts,
    "--mount", `type=bind,src=${output},dst=/jinn/out`,
    ...(input.entrypoint === undefined ? [] : ["--entrypoint", input.entrypoint]),
    input.image,
    ...input.command,
  ];
  return { command: input.runtime, args, containerName, statementPath: join(output, "verdict") };
}
