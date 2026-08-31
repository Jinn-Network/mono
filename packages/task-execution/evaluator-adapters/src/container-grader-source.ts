// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, rm } from "node:fs/promises";
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

/**
 * OOM bound on the grader's report file (P0-4 N7, the package half). It mirrors the host driver's
 * `maxStdoutBytes` bound on the log channel — the two channels an untrusted container controls get
 * the same ceiling. It is deliberately not the swe-rebench adapter's 1 MiB `maxTestLogBytes`: that
 * one tail-caps *published evidence*, downstream of this read and after the whole file is already
 * in memory, so it never bounded anything here.
 */
export const DEFAULT_MAX_GRADER_REPORT_BYTES = 4 * 1024 * 1024;

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

/**
 * The argument validators below end with `(?![\s\S])` — an end-of-input assertion that reads the
 * same whatever flags the pattern carries. It is *not* a fix for a `$` defect: JavaScript's `$`,
 * unlike Perl's and Python's, already asserts end-of-input and does not match before a trailing
 * newline, so a `$`-anchored twin refuses `"grader-image\n--privileged"` identically. The two are
 * equivalent here and the lookahead is chosen only for saying so unambiguously.
 *
 * The flag hazard these patterns really face is `m`, and it is not confined to the end anchor:
 * under `m` the leading `^` matches after a newline too, so `^…(?![\s\S])` with `m` accepts
 * `"grader-image\n--privileged"` by matching the *second* line. Swapping the end anchor buys
 * nothing against that. **These patterns must never carry the `m` flag** — that, not the choice
 * of end anchor, is the property the newline test cases pin.
 */

// The docker distribution reference grammar for the repository half of an image reference:
//   name := [domain '/'] path-component ['/' path-component]*
// A container reference reaches a driver in the positional argument slot, where anything that
// is not a valid reference is parsed as an option instead — `--mount=type=bind,src=/,dst=/hostfs`
// in that slot bind-mounts the host into the grader. Unlike a subject name (whose grammar is
// open, which is why those are positional on disk), the reference grammar is total: a validator
// built from it refuses nothing legitimate.
const DOMAIN_COMPONENT = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`;
const PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*";
const TAG = "[A-Za-z0-9_][A-Za-z0-9._-]{0,127}";
const IMAGE_REPOSITORY = new RegExp(
  `^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*(?::${TAG})?(?![\\s\\S])`,
);
/** The docker reference spec's own limit on the repository half. */
const IMAGE_REPOSITORY_MAX_LENGTH = 255;

/** `os/arch[/variant]`, the OCI platform shape. Every real value is lowercase alphanumeric. */
const PLATFORM = /^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?(?![\s\S])/;

/** Linux `PATH_MAX`, the same role the 255 above plays for the image reference. */
const CONTAINER_PATH_MAX_LENGTH = 4096;

/** One segment of an absolute container path; `.`/`..` are excluded separately. */
const CONTAINER_PATH_SEGMENT = /^[A-Za-z0-9._-]+(?![\s\S])/;

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
  /**
   * OOM bound on the grader's report file. A hostile or buggy grader can write a multi-GB
   * `grader-output.json`; reading it whole would exhaust the attempt process. Defaults to
   * {@link DEFAULT_MAX_GRADER_REPORT_BYTES}.
   */
  readonly maxReportBytes?: number;
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

function refuseSubjectDigest(safeDetail: string): never {
  throw new EvaluationOperationalError({
    canonicalCode: "INVALID_ARGUMENT",
    reason: "subject-digest-mismatch",
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
  if (typeof reference !== "string" || reference.length === 0) {
    refuse("the deterministic-process image carries no repository reference");
  }
  const at = reference.indexOf("@");
  const repository = at === -1 ? reference : reference.slice(0, at);
  if (repository.length > IMAGE_REPOSITORY_MAX_LENGTH || !IMAGE_REPOSITORY.test(repository)) {
    refuse("the deterministic-process image reference is not a docker repository reference");
  }
  if (at === -1) return `${repository}@sha256:${digest}`;
  if (reference.slice(at + 1) !== `sha256:${digest}`) {
    refuse("the deterministic-process image reference and its digest pin different images");
  }
  return reference;
}

/** The platform reaches the driver as its own argument, so it is validated like the reference. */
function pinnedPlatform(block: DeterministicProcessBlock): string {
  const platform = block.platform;
  if (typeof platform !== "string" || !PLATFORM.test(platform)) {
    refuse("the deterministic-process platform is not an os/arch[/variant] identifier");
  }
  return platform;
}

/**
 * The container working directory is also the mount target, so it reaches the driver as an
 * argument twice over. It must be absolute, must contain no `.`/`..` segment (a mount target is
 * resolved, so `..` escapes the intended location), and must carry nothing a shell would read.
 */
function isContainerPath(value: string): boolean {
  if (!value.startsWith("/") || value.length > CONTAINER_PATH_MAX_LENGTH) return false;
  const segments = value.slice(1).split("/");
  return segments.length > 0 && segments.every((segment) =>
    segment !== "." && segment !== ".." && CONTAINER_PATH_SEGMENT.test(segment));
}

function containerWorkdir(block: DeterministicProcessBlock): string {
  const root = (block.workspace as { root?: unknown }).root;
  if (root === undefined) return DEFAULT_GRADER_CONTAINER_WORKDIR;
  if (typeof root !== "string" || !isContainerPath(root)) {
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
    refuseSubjectDigest(`the ${label} carries no well-formed sha256 digest`);
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
  // A root this source creates is private like everything under it. A root the host already
  // owns keeps the mode the host chose — `mkdir` reports whether it created anything.
  if (await mkdir(workspaceRoot, { recursive: true, mode: 0o700 }) !== undefined) {
    await chmod(workspaceRoot, 0o700);
  }
  const workdir = join(workspaceRoot, randomUUID());
  await mkdir(workdir, { mode: 0o700 });
  await chmod(workdir, 0o700);
  const subjects = join(workdir, SUBJECT_DIRECTORY_NAME);
  await mkdir(subjects, { mode: 0o700 });
  await chmod(subjects, 0o700);
  return workdir;
}

type ReportRead =
  | { readonly ok: true; readonly report: unknown }
  | { readonly ok: false; readonly detail: string; readonly cause?: unknown };

type BoundedRead =
  | { readonly overBound: true }
  | { readonly overBound: false; readonly bytes: Uint8Array };

/**
 * Reads at most `maxBytes` from a file the container wrote, reporting rather than truncating when
 * there is more. It reads through a handle into one `maxBytes + 1` buffer — the extra byte is what
 * distinguishes "exactly at the bound" from "over it" — so a multi-GB report costs the bound, not
 * the file size. A truncated read is never returned: a partial report would parse as a different
 * grading, so over-bound is a failure, not a prefix.
 */
async function readBounded(path: string, maxBytes: number): Promise<BoundedRead> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { overBound: true };
    return { overBound: false, bytes: buffer.subarray(0, filled) };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the container's report without deciding anything. It reports rather than throws so the
 * caller can weigh a complete report against an elapsed deadline.
 */
async function readReport(
  directory: string,
  exitCode: number,
  maxBytes: number,
): Promise<ReportRead> {
  const suffix = `(container exit ${exitCode})`;
  let read: BoundedRead;
  try {
    read = await readBounded(join(directory, GRADER_OUTPUT_NAME), maxBytes);
  } catch (cause) {
    return { ok: false, detail: `the grader container wrote no ${GRADER_OUTPUT_NAME} ${suffix}`, cause };
  }
  if (read.overBound) {
    return {
      ok: false,
      detail: `${GRADER_OUTPUT_NAME} exceeds the ${maxBytes}-byte report bound ${suffix}`,
    };
  }
  const bytes = read.bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    return { ok: false, detail: `${GRADER_OUTPUT_NAME} is not valid UTF-8 ${suffix}`, cause };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, detail: `${GRADER_OUTPUT_NAME} is not valid JSON ${suffix}`, cause };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: `${GRADER_OUTPUT_NAME} is not a JSON object ${suffix}` };
  }
  return { ok: true, report: parsed };
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
 * (`operator/src/daemon/native-evaluator-composition.ts`). Nothing here reads a grant, and
 * nothing here reads `process.env`.
 */
export function containerGraderReportSource(
  options: ContainerGraderReportSourceOptions,
): GraderReportSource {
  const maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_GRADER_REPORT_BYTES;
  if (!Number.isSafeInteger(maxReportBytes) || maxReportBytes <= 0) {
    throw new TypeError("maxReportBytes must be a positive whole number of bytes");
  }
  return {
    async read(request: GraderReportRequest): Promise<RawGraderReport> {
      const block = deterministicProcessBlock(request.specification);
      const image = pinnedImageReference(block);
      const platform = pinnedPlatform(block);
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
            platform,
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
          platform,
          workdir,
          mounts: [{ source: hostWorkdir, target: workdir, readOnly: false }],
          env: options.env ?? {},
          timeoutSignal,
        });
      } catch (cause) {
        if (timeoutSignal.aborted) abortedRun(cause);
        fail("UNAVAILABLE", "the grader container could not be run", cause);
      }

      // A complete report is a grading the container actually performed, so it is never thrown
      // away for a deadline that elapsed at return time. Only when nothing gradeable came back
      // does an elapsed deadline get to classify the failure.
      const outcome = await readReport(hostWorkdir, result.exitCode, maxReportBytes);
      if (outcome.ok) return { report: outcome.report, log: result.stdout };
      if (timeoutSignal.aborted) abortedRun();
      fail("UNAVAILABLE", outcome.detail, outcome.cause);
    },
  };
}
