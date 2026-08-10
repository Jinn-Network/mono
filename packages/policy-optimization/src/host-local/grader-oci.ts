// SPDX-License-Identifier: MIT

import { ResultEvaluationStatementSchema, type ResultEvaluationStatement } from "@jinn-network/evidence-protocol";
import { canonicalAttestationJsonBytes } from "@jinn-network/attestation-issuer";
import {
  createEvaluatorDeployment,
  type EvaluatorDeploymentOptions,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  DSSE_PAYLOAD_TYPE,
  parseExactDsseEnvelope,
  sealSignedPayload,
  type DsseSigner,
  type SealedRecord,
} from "@jinn-network/trust-core";
import { spawn } from "node:child_process";
import { constants, accessSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { ensurePrivateDirectory, HostStateError, secureRead } from "./state.js";

const PINNED_IMAGE = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u;
const SAFE_TARGET = /^\/jinn\/(?:input\/[a-z0-9][a-z0-9._-]*|out)$/u;
const SECRET_SEGMENT = /^(?:\.aws|\.config|\.docker|\.gnupg|\.ssh|credentials?|keys?|secrets?)$/iu;

function runtimeExecutable(runtime: "docker" | "podman"): string {
  const candidates = runtime === "docker"
    ? [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/usr/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
      ]
    : ["/usr/local/bin/podman", "/opt/homebrew/bin/podman", "/usr/bin/podman"];
  for (const candidate of candidates) {
    try {
      const exact = realpathSync(candidate);
      accessSync(exact, constants.X_OK);
      return exact;
    } catch {
      // Try the next host-owned installation root; never consult task material.
    }
  }
  return runtime;
}

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

export interface PinnedOciImageIdentity {
  readonly runtime: "docker" | "podman";
  readonly image: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly timeoutMs: number;
}

function assertNoSymlinksOrSecrets(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new HostStateError("unsafe-state-path", "grader input contains a symbolic link");
  if (SECRET_SEGMENT.test(basename(path))) {
    throw new HostStateError("unsafe-state-path", "credential or signer material cannot enter the grader sandbox");
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) assertNoSymlinksOrSecrets(join(path, entry));
}

/** Pure command builder so the security posture is reviewable and testable without a daemon. */
export function buildPinnedOciInvocation(input: PinnedOciGraderInput): PinnedOciInvocation {
  if (!PINNED_IMAGE.test(input.image)) {
    throw new HostStateError("state-io", "grader image must be pinned by sha256 digest");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000) {
    throw new HostStateError("state-io", "grader timeout must be a positive bounded duration");
  }
  if (input.command.length === 0 || input.command.some((part) => part.length === 0)) {
    throw new HostStateError("state-io", "grader command is empty");
  }
  if (input.entrypoint !== undefined
    && (input.entrypoint.length === 0 || /[\u0000\r\n]/u.test(input.entrypoint))) {
    throw new HostStateError("state-io", "grader entrypoint is invalid");
  }
  const network = input.profileRequiresNetwork ? input.allowedNetwork : "none";
  if (network === undefined || network === "" || network === "host") {
    throw new HostStateError("state-io", "network is disabled unless the profile explicitly requires an isolated network");
  }
  const output = ensurePrivateDirectory(input.outputDirectory);
  assertNoSymlinksOrSecrets(output);
  const mounts: string[] = [];
  const targets = new Set<string>();
  for (const item of input.inputs) {
    const target = `/jinn/input/${item.targetName}`;
    if (!SAFE_TARGET.test(target) || targets.has(target)) {
      throw new HostStateError("unsafe-state-path", "grader input target is unsafe or duplicated");
    }
    const source = realpathSync(item.source);
    assertNoSymlinksOrSecrets(source);
    targets.add(target);
    mounts.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
  }
  const containerName = `jinn-optimize-grader-${crypto.randomUUID()}`;
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
  return {
    command: input.runtime,
    args,
    containerName,
    statementPath: join(output, "verdict"),
  };
}

async function boundedRuntimeExit(input: {
  readonly command: "docker" | "podman";
  readonly args: readonly string[];
  readonly timeoutMs: number;
}): Promise<{ readonly code: number | null; readonly timedOut: boolean }> {
  const child = spawn(runtimeExecutable(input.command), [...input.args], {
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  });
  return new Promise<{ readonly code: number | null; readonly timedOut: boolean }>((resolveExit, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("exit", (code) => { clearTimeout(timer); resolveExit({ code, timedOut }); });
  }).catch(() => { throw new HostStateError("state-io", "grader runtime is unavailable"); });
}

/** Fetches only an exact digest and positively re-inspects it before any solver work may begin. */
export async function ensurePinnedOciImage(input: PinnedOciImageIdentity): Promise<void> {
  if (!PINNED_IMAGE.test(input.image)) {
    throw new HostStateError("state-io", "grader image must be pinned by sha256 digest");
  }
  const timeoutMs = Math.min(3_600_000, Math.max(60_000, input.timeoutMs));
  const inspect = () => boundedRuntimeExit({
    command: input.runtime,
    args: ["image", "inspect", input.image],
    timeoutMs: Math.min(30_000, timeoutMs),
  });
  const existing = await inspect();
  if (!existing.timedOut && existing.code === 0) return;
  const pulled = await boundedRuntimeExit({
    command: input.runtime,
    args: ["pull", "--platform", input.platform, input.image],
    timeoutMs,
  });
  if (pulled.timedOut || pulled.code !== 0) {
    throw new HostStateError("state-io", "pinned grader image is unavailable");
  }
  const verified = await inspect();
  if (verified.timedOut || verified.code !== 0) {
    throw new HostStateError("state-io", "pinned grader image could not be verified locally");
  }
}

/** Runs one bounded grader and returns only its unsigned canonical statement bytes. */
export async function runPinnedOciGrader(input: PinnedOciGraderInput): Promise<Uint8Array> {
  await ensurePinnedOciImage(input);
  let ownedNetwork: string | undefined;
  if (input.profileRequiresNetwork && input.allowedNetwork === undefined) {
    ownedNetwork = `jinn-optimize-grader-network-${crypto.randomUUID()}`;
    const created = await boundedRuntimeExit({
      command: input.runtime,
      args: ["network", "create", "--driver", "bridge", ownedNetwork],
      timeoutMs: Math.min(30_000, input.timeoutMs),
    });
    if (created.timedOut || created.code !== 0) {
      throw new HostStateError("state-io", "isolated grader network could not be created");
    }
  }
  try {
    const invocation = buildPinnedOciInvocation({
      ...input,
      ...(ownedNetwork === undefined ? {} : { allowedNetwork: ownedNetwork }),
    });
    const runtime = runtimeExecutable(invocation.command);
    const child = spawn(runtime, [...invocation.args], {
      stdio: "ignore",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const exit = await new Promise<{ code: number | null; timedOut: boolean }>((resolveExit, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
      child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
      child.once("exit", (code) => { clearTimeout(timer); resolveExit({ code, timedOut }); });
    }).catch(() => { throw new HostStateError("state-io", "grader runtime is unavailable"); });
    if (exit.timedOut) {
      await boundedRuntimeExit({
        command: input.runtime,
        args: ["rm", "-f", invocation.containerName],
        timeoutMs: Math.min(30_000, input.timeoutMs),
      });
    }
    if (exit.timedOut || exit.code !== 0) {
      throw new HostStateError("state-io", exit.timedOut ? "grader exceeded its bounded time" : "grader failed");
    }
    return secureRead(invocation.statementPath);
  } finally {
    if (ownedNetwork !== undefined) {
      const removed = await boundedRuntimeExit({
        command: input.runtime,
        args: ["network", "rm", ownedNetwork],
        timeoutMs: Math.min(30_000, input.timeoutMs),
      });
      if (removed.timedOut || removed.code !== 0) {
        throw new HostStateError("state-io", "isolated grader network could not be removed");
      }
    }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function descriptorKey(descriptor: { name: string; digest: { sha256: string } }): string {
  return `${descriptor.name}\0${descriptor.digest.sha256}`;
}

export interface ExpectedEvaluationBindings {
  readonly task: { readonly name: string; readonly digest: { readonly sha256: string } };
  readonly results: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
  readonly evaluatorId: string;
  readonly evaluatorSigningKeyId: string;
  readonly evaluationSpecification: { readonly name: string; readonly digest: { readonly sha256: string } };
  readonly evaluationMethod: { readonly name: string; readonly digest: { readonly sha256: string } };
}

/** Exact-parse every sandbox binding, then and only then invoke the evaluator-role signer. */
export async function validateAndSignEvaluatorStatement(input: {
  readonly statementBytes: Uint8Array;
  readonly expected: ExpectedEvaluationBindings;
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}): Promise<SealedRecord> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.statementBytes)); }
  catch { throw new HostStateError("state-io", "evaluator statement is not UTF-8 JSON"); }
  const parsed = ResultEvaluationStatementSchema.safeParse(value);
  if (!parsed.success || !sameBytes(canonicalAttestationJsonBytes(parsed.data), input.statementBytes)) {
    throw new HostStateError("state-io", "evaluator statement is not exact canonical data");
  }
  const statement: ResultEvaluationStatement = parsed.data;
  const expectedSubjects = [input.expected.task, ...input.expected.results].map(descriptorKey).sort();
  const actualSubjects = statement.subject.map(descriptorKey).sort();
  const predicate = statement.predicate;
  const actualResultNames = [...predicate.resultSubjects].sort();
  const expectedResultNames = input.expected.results.map((result) => result.name).sort();
  if (JSON.stringify(actualSubjects) !== JSON.stringify(expectedSubjects)
    || predicate.taskSubject !== input.expected.task.name
    || JSON.stringify(actualResultNames) !== JSON.stringify(expectedResultNames)
    || predicate.evaluator.id !== input.expected.evaluatorId
    || predicate.evaluationSpecification === undefined
    || descriptorKey(predicate.evaluationSpecification) !== descriptorKey(input.expected.evaluationSpecification)
    || predicate.evaluationMethod === undefined
    || descriptorKey(predicate.evaluationMethod) !== descriptorKey(input.expected.evaluationMethod)) {
    throw new HostStateError("state-io", "evaluator statement binding does not match the exact evaluation dispatch");
  }
  const sealed = await sealSignedPayload({
    payloadBytes: input.statementBytes,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: input.signer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!sameBytes(sealed.payloadBytes, input.statementBytes)) {
    throw new HostStateError("state-io", "host signer did not preserve exact evaluator statement bytes");
  }
  const signedEnvelope = parseExactDsseEnvelope(sealed.envelopeBytes);
  if (input.expected.evaluatorSigningKeyId.length === 0
    || signedEnvelope.signatures.some((signature) =>
      signature.keyid !== input.expected.evaluatorSigningKeyId)) {
    throw new HostStateError("state-io", "evaluator signer key is not bound to the evaluator verdict role");
  }
  return sealed;
}

/** Concrete adapter composition stays private to host-local. */
export function createLiveEvaluatorDeployment(options: EvaluatorDeploymentOptions) {
  return createEvaluatorDeployment(options);
}
