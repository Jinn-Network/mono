// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  GraderReportRequest,
  GraderReportSource,
  RawGraderReport,
} from "@jinn-network/task-execution-evaluator-adapters";
import type { ExactEvaluationMaterial } from "@jinn-network/task-execution-evaluation-harness";
import type {
  DeterministicProcessBlock,
  EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes, sha256Hex } from "./canonical.js";
import { refuse, refuseSubjectDigest } from "./errors.js";
import { SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES } from "./grader-program.js";
import { PINNED_IMAGE_BODY, type PinnedOciGraderInput } from "./invocation.js";
import { runPinnedOciGrader, type PinnedOciRunnerOptions } from "./runner.js";

export const SWE_REBENCH_PUBLIC_NETWORK_EXTENSION =
  "network.jinn.oci-grader.requires-public-network" as const;

const MAX_LOG_BYTES = 1024 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/** Same OCI-reference grammar `invocation.ts` refuses by, wrapped in the `docker://` URI form. */
const PINNED_IMAGE_URI = new RegExp(`^docker://(${PINNED_IMAGE_BODY})$`, "u");

interface EvaluationRowMaterial {
  readonly instance_id: string;
  readonly base_commit: string;
  readonly test_patch: string;
  readonly FAIL_TO_PASS: readonly string[];
  readonly PASS_TO_PASS: readonly string[];
  readonly install_config: {
    readonly install: readonly string[];
    readonly test_cmd: readonly string[];
    readonly log_parser: string;
  };
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!CANONICAL_BASE64.test(value)) refuse("test material is not canonical base64");
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) refuse("test material base64 spelling moved");
  return bytes;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    refuse(`${label} is not a string array`);
  }
  return [...value] as string[];
}

function rowMaterial(specification: EvaluationSpec): EvaluationRowMaterial {
  if (specification.family !== "deterministic-process") refuse("EvaluationSpec is not deterministic-process");
  const block = specification.familyBlock as DeterministicProcessBlock;
  const descriptor = block.testMaterial.find((entry) => entry.name === "swe-rebench-evaluation-row");
  if (descriptor?.content === undefined) refuse("EvaluationSpec carries no exact public row material");
  const bytes = decodeCanonicalBase64(descriptor.content);
  if (`sha256:${sha256Hex(bytes)}` !== `sha256:${descriptor.digest?.sha256 ?? ""}`) {
    refuseSubjectDigest("public row material digest does not match its descriptor");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse("public row material is not UTF-8 JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !canonicalJsonBytes(value).every((byte, index) => byte === bytes[index])
    || canonicalJsonBytes(value).length !== bytes.length) {
    refuse("public row material is not exact canonical data");
  }
  const row = value as Record<string, unknown>;
  const install = row["install_config"];
  if (typeof row["instance_id"] !== "string" || typeof row["test_patch"] !== "string"
    || typeof row["base_commit"] !== "string" || !/^[a-f0-9]{40}$/u.test(row["base_commit"])
    || typeof install !== "object" || install === null || Array.isArray(install)) {
    refuse("public row material is incomplete");
  }
  const config = install as Record<string, unknown>;
  if (typeof config["log_parser"] !== "string") refuse("public row log parser is missing");
  return {
    instance_id: row["instance_id"],
    base_commit: row["base_commit"],
    test_patch: row["test_patch"],
    FAIL_TO_PASS: stringArray(row["FAIL_TO_PASS"], "FAIL_TO_PASS"),
    PASS_TO_PASS: stringArray(row["PASS_TO_PASS"], "PASS_TO_PASS"),
    install_config: {
      install: stringArray(config["install"], "install_config.install"),
      test_cmd: stringArray(config["test_cmd"], "install_config.test_cmd"),
      log_parser: config["log_parser"],
    },
  };
}

/**
 * Preserve the benchmark's exact test command. Some pytest parameter ids contain spaces, so the
 * public transition names intentionally use the same whitespace-truncated spelling emitted by
 * SWE-rebench's parser; treating those names as standalone pytest node ids makes valid rows
 * uncollectable.
 */
export function exactSweRebenchTestCommands(input: {
  readonly logParser: string;
  readonly commands: readonly string[];
}): string[] {
  if (input.logParser !== "parse_log_pytest") {
    refuse(`unsupported sealed log parser ${input.logParser}`);
  }
  if (input.commands.length === 0
    || input.commands.some((command) => command.length === 0 || command.includes("\0"))) {
    refuse("sealed test command is empty or invalid");
  }
  return [...input.commands];
}

function profileRequiresPublicNetwork(specification: EvaluationSpec): boolean {
  if (specification.family !== "deterministic-process") refuse("EvaluationSpec is not deterministic-process");
  const block = specification.familyBlock as DeterministicProcessBlock & Record<string, unknown>;
  const value = block[SWE_REBENCH_PUBLIC_NETWORK_EXTENSION];
  if (value !== undefined && value !== true) refuse("public-network extension is not true");
  return value === true;
}

function patchResult(results: readonly ExactEvaluationMaterial[]): ExactEvaluationMaterial {
  const matches = results.filter((result) =>
    result.descriptor.name === "result.patch" || result.descriptor.name === "patch");
  if (matches.length !== 1) refuse("evaluator requires exactly one solver patch Result");
  return matches[0]!;
}

export function pinnedSweRebenchImage(specification: EvaluationSpec): {
  readonly image: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly timeoutMs: number;
} {
  if (specification.family !== "deterministic-process") refuse("EvaluationSpec is not deterministic-process");
  const block = specification.familyBlock as DeterministicProcessBlock;
  const uri = block.image.uri;
  const match = typeof uri === "string" ? PINNED_IMAGE_URI.exec(uri) : null;
  if (match === null) refuse("grader image is not an exact docker sha256 reference");
  if (block.platform !== "linux/amd64" && block.platform !== "linux/arm64") {
    refuse("grader platform is unsupported");
  }
  if (!Number.isSafeInteger(block.timeout) || block.timeout < 1 || block.timeout > 3600) {
    refuse("grader timeout is outside the bounded live-host range");
  }
  return { image: match[1]!, platform: block.platform, timeoutMs: block.timeout * 1000 };
}

function exactRawReport(bytes: Uint8Array): RawGraderReport {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse("grader emitted non-JSON bytes"); }
  const canonical = canonicalJsonBytes(value);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    refuse("grader output is not exact canonical data");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("grader output is not an object");
  const record = value as Record<string, unknown>;
  if (typeof record["log"] !== "string" || typeof record["report"] !== "object"
    || record["report"] === null || Array.isArray(record["report"])) {
    refuse("grader output has no raw report and log");
  }
  return { report: record["report"], log: record["log"].slice(-MAX_LOG_BYTES) };
}

export interface SweRebenchOciGraderSourceOptions {
  readonly runtime?: "docker" | "podman";
  readonly attemptWorkRoot?: () => string;
  readonly runner?: PinnedOciRunnerOptions;
  /**
   * Test seam: replaces the real pinned-OCI runner entirely, so this source is testable on a
   * machine with no container runtime installed. Defaults to the real `runPinnedOciGrader`,
   * called with `options.runner`. Deliberately takes only the grader input — a test double never
   * needs the runtime-launch options (`spawn`, `dockerPath`) that `runPinnedOciGrader`'s own
   * second parameter carries, because it replaces the runtime instead of configuring it.
   */
  readonly runPinnedOciGraderForTesting?: (input: PinnedOciGraderInput) => Promise<Uint8Array>;
}

/** Host-owned source used by the evaluator adapter; fixture context can never enter it. */
export function sweRebenchOciGraderReportSource(
  options: SweRebenchOciGraderSourceOptions = {},
): GraderReportSource {
  return {
    async read(request: GraderReportRequest): Promise<RawGraderReport> {
      request.deadlineSignal.throwIfAborted();
      const row = rowMaterial(request.specification);
      const image = pinnedSweRebenchImage(request.specification);
      const result = patchResult(request.results);
      const base = options.attemptWorkRoot?.()
        ?? process.env["JINN_ATTEMPT_WORK"];
      if (base === undefined || base.length === 0) refuse("evaluator Attempt work root is unavailable");
      mkdirSync(base, { recursive: true, mode: 0o700 });
      const root = mkdtempSync(join(base, "grader-"));
      const inputs = join(root, "inputs");
      const output = join(root, "output");
      mkdirSync(inputs, { mode: 0o700 });
      mkdirSync(output, { mode: 0o700 });
      const patchPath = join(inputs, "patch.diff");
      const testPatchPath = join(inputs, "test-patch.diff");
      const configPath = join(inputs, "config.json");
      const programPath = join(inputs, "grader.py");
      try {
        writeFileSync(patchPath, result.bytes, { mode: 0o600, flag: "wx" });
        writeFileSync(testPatchPath, row.test_patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
        writeFileSync(configPath, canonicalJsonBytes({
          base_commit: row.base_commit,
          fail_to_pass: [...row.FAIL_TO_PASS],
          instance_id: row.instance_id,
          log_parser: row.install_config.log_parser,
          pass_to_pass: [...row.PASS_TO_PASS],
          test_cmd: exactSweRebenchTestCommands({
            commands: row.install_config.test_cmd,
            logParser: row.install_config.log_parser,
          }),
        }), { mode: 0o600, flag: "wx" });
        writeFileSync(programPath, SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES, { mode: 0o500, flag: "wx" });
        const run = options.runPinnedOciGraderForTesting
          ?? ((input: PinnedOciGraderInput) => runPinnedOciGrader(input, options.runner));
        const emitted = await run({
          runtime: options.runtime ?? "docker",
          image: image.image,
          platform: image.platform,
          inputs: [
            { source: configPath, targetName: "config.json" },
            { source: patchPath, targetName: "patch.diff" },
            { source: programPath, targetName: "grader.py" },
            { source: testPatchPath, targetName: "test-patch.diff" },
          ],
          outputDirectory: output,
          entrypoint: "python3",
          command: [
            "/jinn/input/grader.py",
          ],
          timeoutMs: image.timeoutMs,
          profileRequiresNetwork: profileRequiresPublicNetwork(request.specification),
        });
        request.deadlineSignal.throwIfAborted();
        return exactRawReport(emitted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
