// SPDX-License-Identifier: MIT

import { ResultEvaluationStatementSchema, type ResultEvaluationStatement } from "@jinn-network/evidence-protocol";
import {
  createEvaluatorDeployment,
  type EvaluatorDeploymentOptions,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  DSSE_PAYLOAD_TYPE,
  parseExactDsseEnvelope,
  sealSignedRecord,
  type DsseSigner,
  type SealedRecord,
} from "@jinn-network/trust-core";
import { canonicalJsonBytes, type JsonValue } from "@jinn-network/policy-identity";
import { spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { ensurePrivateDirectory, HostStateError, secureRead } from "./state.js";

const PINNED_IMAGE = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u;
const SAFE_TARGET = /^\/jinn\/(?:input\/[a-z0-9][a-z0-9._-]*|out)$/u;
const SECRET_SEGMENT = /^(?:\.aws|\.config|\.docker|\.gnupg|\.ssh|credentials?|keys?|secrets?)$/iu;

export interface PinnedOciGraderInput {
  readonly runtime: "docker" | "podman";
  readonly image: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly inputs: readonly { readonly source: string; readonly targetName: string }[];
  readonly outputDirectory: string;
  readonly command: readonly [string, ...string[]];
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
    "run", "--rm", "--name", containerName,
    "--platform", input.platform,
    "--network", network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "4g",
    "--cpus", "2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=512m",
    ...mounts,
    "--mount", `type=bind,src=${output},dst=/jinn/out`,
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

/** Runs one bounded grader and returns only its unsigned canonical statement bytes. */
export async function runPinnedOciGrader(input: PinnedOciGraderInput): Promise<Uint8Array> {
  const invocation = buildPinnedOciInvocation(input);
  const child = spawn(invocation.command, [...invocation.args], {
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
  });
  const exit = await new Promise<{ code: number | null; timedOut: boolean }>((resolveExit, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      const cleanup = spawn(invocation.command, ["rm", "-f", invocation.containerName], {
        stdio: "ignore", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      });
      cleanup.unref();
    }, input.timeoutMs);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("exit", (code) => { clearTimeout(timer); resolveExit({ code, timedOut }); });
  }).catch(() => { throw new HostStateError("state-io", "grader runtime is unavailable"); });
  if (exit.timedOut || exit.code !== 0) {
    throw new HostStateError("state-io", exit.timedOut ? "grader exceeded its bounded time" : "grader failed");
  }
  return secureRead(invocation.statementPath);
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
  if (!parsed.success || !sameBytes(canonicalJsonBytes(parsed.data as JsonValue), input.statementBytes)) {
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
  const sealed = await sealSignedRecord({
    record: statement,
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
