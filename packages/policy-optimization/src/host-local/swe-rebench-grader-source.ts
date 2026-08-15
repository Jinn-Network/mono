// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import type {
  DeterministicProcessBlock,
  EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import type {
  GraderReportRequest,
  GraderReportSource,
  RawGraderReport,
} from "@jinn-network/task-execution-evaluator-adapters";
import type { ExactEvaluationMaterial } from "@jinn-network/task-execution-evaluation-harness";
import { HostStateError } from "./state.js";
import { runPinnedOciGrader } from "./grader-oci.js";

export const LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN =
  "network.jinn.policy-optimization.swe-rebench-oci-evaluator/1.1" as const;

export const SWE_REBENCH_PUBLIC_NETWORK_EXTENSION =
  "network.jinn.policy-optimization.requires-public-network" as const;

const MAX_LOG_BYTES = 1024 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PINNED_IMAGE_URI = /^docker:\/\/([^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64})$/u;

/**
 * The reviewed program mounted read-only into the already-pinned task image. It copies the
 * image's repository into the grader-only output mount, applies only the exact solver and public
 * test patches, runs the source row's commands with network disabled by the outer host, and emits
 * one canonical unsigned raw report. No host path, credential, or signer material enters it.
 */
export const SWE_REBENCH_OCI_GRADER_PROGRAM = String.raw`#!/usr/bin/env python3
import json
import pathlib
import re
import shutil
import subprocess
import sys

OUT = pathlib.Path("/jinn/out")
WORK = OUT / "work"
MAX_LOG = 1024 * 1024

def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")

def run(argv, cwd):
    completed = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, check=False)
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")

def emit(report, log):
    encoded = log.encode("utf-8", errors="replace")
    if len(encoded) > MAX_LOG:
        encoded = encoded[-MAX_LOG:]
        log = encoded.decode("utf-8", errors="replace")
    (OUT / "verdict").write_bytes(canonical({"log": log, "report": report}))

TIMING_PATTERNS = [
    re.compile(r"\s*\[\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\]\s*$", re.IGNORECASE),
    re.compile(r"\s+in\s+\d+(?:\.\d+)?\s+(?:msec|sec)\b", re.IGNORECASE),
    re.compile(r"\s*\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)\s*$", re.IGNORECASE),
]

def normalize_test_name(name):
    for pattern in TIMING_PATTERNS:
        name = pattern.sub("", name)
    return name.strip()

def parse_pytest(log):
    statuses = {}
    valid = {"PASSED", "FAILED", "SKIPPED", "ERROR", "XFAIL", "XPASS"}
    for line in log.splitlines():
        fields = line.split()
        if len(fields) > 1 and fields[0] in valid:
            statuses[normalize_test_name(fields[1])] = fields[0]
    return statuses

def safe_patch_path(raw):
    try:
        value = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise ValueError("patch path is not UTF-8")
    path = pathlib.PurePosixPath(value)
    if value == "" or path.is_absolute() or "." in path.parts or ".." in path.parts:
        raise ValueError("patch path escapes the repository")
    return value

def patch_source_paths(patch):
    completed = subprocess.run(
        ["git", "apply", "--numstat", "-z", str(patch)], cwd=WORK,
        capture_output=True, check=False,
    )
    if completed.returncode != 0:
        raise ValueError("public test patch has invalid file metadata")
    chunks = completed.stdout.split(b"\0")
    paths = []
    index = 0
    while index < len(chunks) and chunks[index] != b"":
        fields = chunks[index].split(b"\t", 2)
        if len(fields) != 3:
            raise ValueError("public test patch has invalid numstat data")
        if fields[2] != b"":
            paths.append(safe_patch_path(fields[2]))
            index += 1
        else:
            if index + 2 >= len(chunks):
                raise ValueError("public test patch has incomplete rename data")
            paths.append(safe_patch_path(chunks[index + 1]))
            safe_patch_path(chunks[index + 2])
            index += 3
    return sorted(set(paths))

config = json.loads(pathlib.Path("/jinn/input/config.json").read_text(encoding="utf-8"))
instance = config["instance_id"]
base_commit = config["base_commit"]
f2p = config["fail_to_pass"]
p2p = config["pass_to_pass"]
log = ""

try:
    if WORK.exists():
        shutil.rmtree(WORK)
    shutil.copytree("/testbed", WORK, symlinks=True)
except Exception as error:
    emit({"error": "workdir setup failed", "failed_from_pass_to_pass": p2p,
          "from_fail_to_pass": [], "instance_id": instance}, str(error))
    sys.exit(0)

code, text = run(["git", "rev-parse", "HEAD"], WORK)
log += text
if code != 0 or text.strip() != base_commit:
    emit({"error": "benchmark base commit mismatch", "failed_from_pass_to_pass": p2p,
          "from_fail_to_pass": [], "instance_id": instance}, log)
    sys.exit(0)

code, text = run(["git", "reset", "--hard", base_commit], WORK)
log += text
if code != 0:
    emit({"error": "fatal: not a git repository (or any of the parent directories): .git",
          "failed_from_pass_to_pass": p2p, "from_fail_to_pass": [], "instance_id": instance}, log)
    sys.exit(0)

patch = pathlib.Path("/jinn/input/patch.diff")
if patch.stat().st_size > 0:
    code, text = run(["git", "apply", "--check", "--recount", "--whitespace=nowarn",
                      str(patch)], WORK)
    log += text
    if code != 0:
        emit({"error": "patch does not apply", "failed_from_pass_to_pass": p2p,
              "from_fail_to_pass": [], "instance_id": instance}, log)
        sys.exit(0)
    code, text = run(["git", "apply", "--recount", "--whitespace=nowarn", str(patch)], WORK)
    log += text
    if code != 0:
        emit({"error": "patch application failed", "failed_from_pass_to_pass": p2p,
              "from_fail_to_pass": [], "instance_id": instance}, log)
        sys.exit(0)

test_patch = pathlib.Path("/jinn/input/test-patch.diff")
if test_patch.stat().st_size > 0:
    try:
        public_sources = patch_source_paths(test_patch)
    except ValueError as error:
        emit({"error": "public test patch metadata is invalid", "failed_from_pass_to_pass": p2p,
              "from_fail_to_pass": [], "instance_id": instance}, str(error))
        sys.exit(0)
    for source in public_sources:
        exists = subprocess.run(
            ["git", "cat-file", "-e", base_commit + ":" + source], cwd=WORK,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if exists.returncode != 0:
            continue
        code, text = run(["git", "checkout", base_commit, "--", source], WORK)
        log += text
        if code != 0:
            emit({"error": "public test file reset failed", "failed_from_pass_to_pass": p2p,
                  "from_fail_to_pass": [], "instance_id": instance}, log)
            sys.exit(0)
    code, text = run(["git", "apply", "--check", "--recount", "--whitespace=nowarn",
                      str(test_patch)], WORK)
    log += text
    if code != 0:
        emit({"error": "public test patch does not apply", "failed_from_pass_to_pass": p2p,
              "from_fail_to_pass": [], "instance_id": instance}, log)
        sys.exit(0)
    code, text = run(["git", "apply", "--recount", "--whitespace=nowarn", str(test_patch)], WORK)
    log += text
    if code != 0:
        emit({"error": "public test patch application failed", "failed_from_pass_to_pass": p2p,
              "from_fail_to_pass": [], "instance_id": instance}, log)
        sys.exit(0)

test_code = 0
for command in config["test_cmd"]:
    activated = "source /opt/conda/bin/activate && conda activate testbed && " + command
    test_code, text = run(["/bin/bash", "-lc", activated], WORK)
    log += text
    if test_code != 0:
        break

if config["log_parser"] != "parse_log_pytest":
    emit({"error": "unsupported sealed log parser", "failed_from_pass_to_pass": p2p,
          "from_fail_to_pass": [], "instance_id": instance}, log)
    sys.exit(0)

statuses = parse_pytest(log)
passed_actual = {name for name, status in statuses.items() if status == "PASSED"}
f2p_normalized = {normalize_test_name(name): name for name in f2p}
p2p_normalized = {normalize_test_name(name): name for name in p2p}
from_fail_to_pass = sorted(
    original for normalized, original in f2p_normalized.items() if normalized in passed_actual
)
failed_from_pass_to_pass = sorted(
    original for normalized, original in p2p_normalized.items() if normalized not in passed_actual
)
emit({"error": "", "exit_code": test_code,
      "failed_from_pass_to_pass": failed_from_pass_to_pass,
      "from_fail_to_pass": from_fail_to_pass,
      "instance_id": instance}, log)
`;

export const LOCAL_SWE_REBENCH_EVALUATION_METHOD = Object.freeze({
  name: "Jinn local SWE-rebench OCI evaluator",
  uri: `urn:jinn:method:${LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN}`,
  digest: {
    sha256: prefixedDigest(new TextEncoder().encode(
      `${LOCAL_SWE_REBENCH_EVALUATION_METHOD_TOKEN}\0${SWE_REBENCH_OCI_GRADER_PROGRAM}`,
    )).slice("sha256:".length),
  },
});

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

function fail(detail: string): never {
  throw new HostStateError("state-io", `live SWE-rebench grader refusal: ${detail}`);
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!CANONICAL_BASE64.test(value)) fail("test material is not canonical base64");
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) fail("test material base64 spelling moved");
  return bytes;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} is not a string array`);
  }
  return [...value] as string[];
}

function rowMaterial(specification: EvaluationSpec): EvaluationRowMaterial {
  if (specification.family !== "deterministic-process") fail("EvaluationSpec is not deterministic-process");
  const block = specification.familyBlock as DeterministicProcessBlock;
  const descriptor = block.testMaterial.find((entry) => entry.name === "swe-rebench-evaluation-row");
  if (descriptor?.content === undefined) fail("EvaluationSpec carries no exact public row material");
  const bytes = decodeCanonicalBase64(descriptor.content);
  if (prefixedDigest(bytes) !== `sha256:${descriptor.digest?.sha256 ?? ""}`) {
    fail("public row material digest does not match its descriptor");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("public row material is not UTF-8 JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !canonicalJsonBytes(value as JsonValue).every((byte, index) => byte === bytes[index])
    || canonicalJsonBytes(value as JsonValue).length !== bytes.length) {
    fail("public row material is not exact canonical data");
  }
  const row = value as Record<string, unknown>;
  const install = row["install_config"];
  if (typeof row["instance_id"] !== "string" || typeof row["test_patch"] !== "string"
    || typeof row["base_commit"] !== "string" || !/^[a-f0-9]{40}$/u.test(row["base_commit"])
    || typeof install !== "object" || install === null || Array.isArray(install)) {
    fail("public row material is incomplete");
  }
  const config = install as Record<string, unknown>;
  if (typeof config["log_parser"] !== "string") fail("public row log parser is missing");
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
    fail(`unsupported sealed log parser ${input.logParser}`);
  }
  if (input.commands.length === 0
    || input.commands.some((command) => command.length === 0 || command.includes("\0"))) {
    fail("sealed test command is empty or invalid");
  }
  return [...input.commands];
}

function profileRequiresPublicNetwork(specification: EvaluationSpec): boolean {
  if (specification.family !== "deterministic-process") fail("EvaluationSpec is not deterministic-process");
  const block = specification.familyBlock as DeterministicProcessBlock & Record<string, unknown>;
  const value = block[SWE_REBENCH_PUBLIC_NETWORK_EXTENSION];
  if (value !== undefined && value !== true) fail("public-network extension is not true");
  return value === true;
}

function patchResult(results: readonly ExactEvaluationMaterial[]): ExactEvaluationMaterial {
  const matches = results.filter((result) =>
    result.descriptor.name === "result.patch" || result.descriptor.name === "patch");
  if (matches.length !== 1) fail("evaluator requires exactly one solver patch Result");
  return matches[0]!;
}

export function pinnedSweRebenchImage(specification: EvaluationSpec): {
  readonly image: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly timeoutMs: number;
} {
  if (specification.family !== "deterministic-process") fail("EvaluationSpec is not deterministic-process");
  const block = specification.familyBlock as DeterministicProcessBlock;
  const uri = block.image.uri;
  const match = typeof uri === "string" ? PINNED_IMAGE_URI.exec(uri) : null;
  if (match === null) fail("grader image is not an exact docker sha256 reference");
  if (block.platform !== "linux/amd64" && block.platform !== "linux/arm64") {
    fail("grader platform is unsupported");
  }
  if (!Number.isSafeInteger(block.timeout) || block.timeout < 1 || block.timeout > 3600) {
    fail("grader timeout is outside the bounded live-host range");
  }
  return { image: match[1]!, platform: block.platform, timeoutMs: block.timeout * 1000 };
}

function exactRawReport(bytes: Uint8Array): RawGraderReport {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("grader emitted non-JSON bytes"); }
  const canonical = canonicalJsonBytes(value as JsonValue);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    fail("grader output is not exact canonical data");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("grader output is not an object");
  const record = value as Record<string, unknown>;
  if (typeof record["log"] !== "string" || typeof record["report"] !== "object"
    || record["report"] === null || Array.isArray(record["report"])) {
    fail("grader output has no raw report and log");
  }
  return { report: record["report"], log: record["log"].slice(-MAX_LOG_BYTES) };
}

export interface LiveSweRebenchGraderSourceOptions {
  readonly runtime?: "docker" | "podman";
  readonly attemptWorkRoot?: () => string;
}

/** Host-owned live source used by the evaluator adapter; fixture context can never enter it. */
export function liveSweRebenchGraderReportSource(
  options: LiveSweRebenchGraderSourceOptions = {},
): GraderReportSource {
  return {
    async read(request: GraderReportRequest): Promise<RawGraderReport> {
      request.deadlineSignal.throwIfAborted();
      const row = rowMaterial(request.specification);
      const image = pinnedSweRebenchImage(request.specification);
      const result = patchResult(request.results);
      const base = options.attemptWorkRoot?.()
        ?? process.env["JINN_ATTEMPT_WORK"];
      if (base === undefined || base.length === 0) fail("evaluator Attempt work root is unavailable");
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
        } as JsonValue), { mode: 0o600, flag: "wx" });
        writeFileSync(programPath, SWE_REBENCH_OCI_GRADER_PROGRAM, {
          encoding: "utf8", mode: 0o500, flag: "wx",
        });
        const emitted = await runPinnedOciGrader({
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
