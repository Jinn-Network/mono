// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  EvaluationOperationalError,
  type ExactEvaluationMaterial,
} from "@jinn-network/task-execution-evaluation-harness";
import type {
  DeterministicProcessBlock,
  EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import type {
  GraderReportRequest,
  GraderReportSource,
  RawGraderReport,
} from "./swe-rebench/adapter.js";

/** The file the grader container writes its report to, inside its working directory. */
export const GRADER_OUTPUT_NAME = "grader-output.json";

/** The index the source writes so the container can find the subject material it grades. */
export const EVALUATION_CONTEXT_NAME = "evaluation-context.json";

/** Subject material lives one level down so the two written names can never collide. */
export const SUBJECT_DIRECTORY_NAME = "subject";

/** Versioned shape of `evaluation-context.json`; a grader image pins the version it reads. */
export const GRADER_CONTEXT_SCHEMA = "jinn.grader-context.v1";

/** Container-side working directory used when the specification declares no `workspace.root`. */
export const DEFAULT_GRADER_CONTAINER_WORKDIR = "/jinn/evaluation";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * On-disk subject filenames are positional, never the declared descriptor name. Descriptor
 * names arrive in Task material, so using one as a path component would put a separator, a
 * NUL, or a `..` on the write path; and neither validating nor sanitizing them is total — a
 * validator has to refuse a legitimately-named Result, and a sanitizer has to resolve
 * collisions it invented. Positions have neither problem. `evaluation-context.json` carries
 * the declared name alongside the path, so nothing is lost.
 */
const TASK_SUBJECT_PATH = "task";

/** An absolute, printable, space-free container path. */
const CONTAINER_PATH = /^\/[\x21-\x7e]*$/;

/** One host directory made visible to the container: host-side `source`, container-side `target`. */
export interface ContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface ContainerRunRequest {
  /** A digest-pinned image reference, e.g. `repo@sha256:<64 hex>`. Never a mutable tag. */
  readonly image: string;
  /** The platform the specification pins, e.g. `linux/amd64`. */
  readonly platform?: string;
  /** The container's working directory (container-side path), also the mount target below. */
  readonly workdir: string;
  readonly mounts?: readonly ContainerMount[];
  /** The complete container environment. The runtime adds nothing of its own to it. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Abort means terminate: the runtime SIGTERMs the container and settles promptly. It never
   * leaves a container running past this signal.
   */
  readonly timeoutSignal?: AbortSignal;
}

export interface ContainerRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * The host-supplied container driver. This package never shells out: it composes a run request
 * and reads what the container leaves on disk. The concrete driver (Docker, or any other
 * runtime) is host work, injected here.
 */
export interface ContainerRuntime {
  run(request: ContainerRunRequest): Promise<ContainerRunResult>;
}

export interface ContainerGraderReportSourceOptions {
  readonly runtime: ContainerRuntime;
  /**
   * Host-owned directory under which each read provisions its own isolated workspace. In the
   * spawned evaluation harness this is the attempt's writable `work` directory, whose lifetime
   * the host's per-attempt teardown owns — this source provisions but never removes.
   */
  readonly workspaceRoot: string;
  /** The complete container environment. Nothing is read from `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

function fail(
  canonicalCode: "UNAVAILABLE" | "CANCELLED" | "DEADLINE_EXCEEDED",
  safeDetail: string,
  cause?: unknown,
): never {
  throw new EvaluationOperationalError({
    canonicalCode,
    reason: "provider-unavailable",
    recoveryAdvice: canonicalCode === "CANCELLED" ? "resume-attempt" : "new-attempt-required",
    safeDetail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function refuse(safeDetail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "FAILED_PRECONDITION",
    reason: "unsupported-specification",
    recoveryAdvice: "do-not-retry",
    safeDetail,
  });
}

function refuseSubject(safeDetail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "INVALID_ARGUMENT",
    reason: "subject-not-found",
    recoveryAdvice: "do-not-retry",
    safeDetail,
  });
}

function deterministicProcessBlock(specification: EvaluationSpec): DeterministicProcessBlock {
  if (specification.family !== "deterministic-process") {
    refuse("the container grader source serves deterministic-process specifications only");
  }
  return specification.familyBlock as DeterministicProcessBlock;
}

/**
 * A grader image is identified by its digest, never by a mutable tag: the digest is the
 * semantic commitment the specification seals, so an unpinned image is refused rather than
 * silently resolved to whatever the registry serves today.
 */
function pinnedImageReference(block: DeterministicProcessBlock): string {
  const image = block.image as { name?: string; uri?: string; digest?: Record<string, string> };
  const digest = image.digest?.["sha256"];
  if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
    refuse("the deterministic-process image carries no sha256 digest, so it is not pinned");
  }
  const reference = image.uri ?? image.name;
  if (typeof reference !== "string" || reference.trim().length === 0) {
    refuse("the deterministic-process image carries no repository reference");
  }
  const at = reference.indexOf("@");
  if (at === -1) return `${reference}@sha256:${digest}`;
  if (reference.slice(at + 1) !== `sha256:${digest}`) {
    refuse("the deterministic-process image reference and its digest pin different images");
  }
  return reference;
}

function containerWorkdir(block: DeterministicProcessBlock): string {
  const root = (block.workspace as { root?: unknown }).root;
  if (root === undefined) return DEFAULT_GRADER_CONTAINER_WORKDIR;
  if (typeof root !== "string" || !CONTAINER_PATH.test(root)) {
    refuse("the deterministic-process workspace root is not an absolute container path");
  }
  return root;
}

interface SubjectEntry {
  readonly name?: string;
  readonly digest: string;
  /** Container-relative path, always positional (see `TASK_SUBJECT_PATH`). */
  readonly path: string;
}

function subjectEntry(
  material: ExactEvaluationMaterial,
  filename: string,
  label: string,
): SubjectEntry {
  const digest = material.descriptor.digest?.["sha256"];
  if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
    refuseSubject(`the ${label} carries no sha256 digest`);
  }
  const name = material.descriptor.name;
  return {
    ...(typeof name === "string" ? { name } : {}),
    digest: `sha256:${digest}`,
    path: `${SUBJECT_DIRECTORY_NAME}/${filename}`,
  };
}

async function atomicWrite(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const target = join(directory, name);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  try {
    // `link` never clobbers, so a name already present fails loudly instead of overwriting.
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(target, 0o600);
}

async function provisionWorkspace(workspaceRoot: string): Promise<string> {
  await mkdir(workspaceRoot, { recursive: true });
  const workdir = join(workspaceRoot, randomUUID());
  await mkdir(workdir, { mode: 0o700 });
  await chmod(workdir, 0o700);
  const subjects = join(workdir, SUBJECT_DIRECTORY_NAME);
  await mkdir(subjects, { mode: 0o700 });
  await chmod(subjects, 0o700);
  return workdir;
}

function parseReport(bytes: Uint8Array, exitCode: number): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    fail("UNAVAILABLE", `${GRADER_OUTPUT_NAME} is not valid UTF-8 (container exit ${exitCode})`, cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    fail("UNAVAILABLE", `${GRADER_OUTPUT_NAME} is not valid JSON (container exit ${exitCode})`, cause);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("UNAVAILABLE", `${GRADER_OUTPUT_NAME} is not a JSON object (container exit ${exitCode})`);
  }
  return parsed;
}

/**
 * Executes a `deterministic-process` grader container and returns what it produced.
 *
 * The verdict decision is not made here. A nonzero container exit is *normal* for a grader
 * whose subject failed its tests: as long as the container left a readable report, that report
 * is returned verbatim and the adapter's parser decides pass, fail, or ungradeable. Only the
 * cases where nothing gradeable exists — no runtime, no report, an unreadable report, an
 * elapsed deadline — raise `EvaluationOperationalError`, which the harness turns into an
 * infrastructure failure with no verdict written.
 *
 * Capability grants have no channel into this source, by construction: the native evaluator
 * path seals evaluation Submissions grant-free and the host refuses a non-empty grant set
 * (`client/src/daemon/native-evaluator-composition.ts`). Nothing here reads a grant, and
 * nothing here reads `process.env`.
 */
export function containerGraderReportSource(
  options: ContainerGraderReportSourceOptions,
): GraderReportSource {
  return {
    async read(request: GraderReportRequest): Promise<RawGraderReport> {
      const block = deterministicProcessBlock(request.specification);
      const image = pinnedImageReference(block);
      const workdir = containerWorkdir(block);
      const task = subjectEntry(request.task, TASK_SUBJECT_PATH, "Task subject");
      const results = request.results.map((result, index) =>
        subjectEntry(result, `result-${index}`, "Result subject"));

      if (request.deadlineSignal.aborted) {
        fail("CANCELLED", "the evaluation deadline elapsed before the grader container started");
      }

      const hostWorkdir = await provisionWorkspace(options.workspaceRoot);
      const subjects = join(hostWorkdir, SUBJECT_DIRECTORY_NAME);
      await atomicWrite(subjects, TASK_SUBJECT_PATH, request.task.bytes);
      for (const [index, result] of request.results.entries()) {
        await atomicWrite(subjects, `result-${index}`, result.bytes);
      }
      await atomicWrite(
        hostWorkdir,
        EVALUATION_CONTEXT_NAME,
        // The attempt nonce is deliberately absent: the container has no use for it, and it is
        // the part of the attempt identity that authenticates the attempt.
        new TextEncoder().encode(JSON.stringify({
          schema: GRADER_CONTEXT_SCHEMA,
          attempt: {
            attemptUri: request.attempt.attemptUri,
            attemptNumber: request.attempt.attemptNumber,
          },
          task,
          results,
          specification: {
            family: "deterministic-process",
            platform: block.platform,
            timeoutSeconds: block.timeout,
          },
        })),
      );

      const timeoutSignal = AbortSignal.any([
        request.deadlineSignal,
        AbortSignal.timeout(block.timeout * 1000),
      ]);

      function abortedRun(cause?: unknown): never {
        if (request.deadlineSignal.aborted) {
          fail("CANCELLED", "the evaluation deadline elapsed while the grader container ran", cause);
        }
        fail(
          "DEADLINE_EXCEEDED",
          `the grader container exceeded the specification's ${block.timeout}s timeout`,
          cause,
        );
      }

      let result: ContainerRunResult;
      try {
        result = await options.runtime.run({
          image,
          platform: block.platform,
          workdir,
          mounts: [{ source: hostWorkdir, target: workdir, readOnly: false }],
          env: options.env ?? {},
          timeoutSignal,
        });
      } catch (cause) {
        if (timeoutSignal.aborted) abortedRun(cause);
        fail("UNAVAILABLE", "the grader container could not be run", cause);
      }
      if (timeoutSignal.aborted) abortedRun();

      let bytes: Uint8Array;
      try {
        bytes = await readFile(join(hostWorkdir, GRADER_OUTPUT_NAME));
      } catch (cause) {
        fail(
          "UNAVAILABLE",
          `the grader container wrote no ${GRADER_OUTPUT_NAME} (container exit ${result.exitCode})`,
          cause,
        );
      }
      return { report: parseReport(bytes, result.exitCode), log: result.stdout };
    },
  };
}
