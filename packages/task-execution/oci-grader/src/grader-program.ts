// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "./canonical.js";

// TypeScript twin of the frozen Python `normalize_test_name` below. Host preflight imports this
// helper so identities are checked under the same timing-suffix semantics the measuring
// instrument uses. It deliberately lives beside the frozen implementation: moving the Python
// body behind generated interpolation would risk changing already-published grader bytes.
const SWE_REBENCH_TIMING_PATTERNS = [
  /\s*\[\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\]\s*$/giu,
  /\s+in\s+\d+(?:\.\d+)?\s+(?:msec|sec)\b/giu,
  /\s*\(\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\)\s*$/giu,
] as const;

/** Normalize a transition identity exactly as the frozen grader does before score lookup. */
export function normalizeSweRebenchTestIdentity(identity: string): string {
  let normalized = identity;
  for (const pattern of SWE_REBENCH_TIMING_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }
  return normalized.trim();
}

/**
 * The reviewed program mounted read-only into the already-pinned task image. It copies the
 * image's repository into the grader-only output mount, applies only the exact solver and public
 * test patches, runs the source row's commands with network disabled by the outer host, and emits
 * one canonical unsigned raw report. No host path, credential, or signer material enters it.
 *
 * FROZEN ARTIFACT. This program is the grading logic, and it is NOT pre-committed by the
 * EvaluationSpec — it is pinned by `graderProgramDigest()` instead. That digest is published in
 * the locked method document before any official cell runs, and recorded on every verdict. Any
 * edit to these bytes is a change to the measuring instrument: it requires a deliberate review,
 * a new published digest, and an updated lock-freeze expectation in `grader-program.test.ts`.
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

/** The program's exact UTF-8 bytes — what the digest covers and what the mount receives. */
export const SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES: Uint8Array =
  new TextEncoder().encode(SWE_REBENCH_OCI_GRADER_PROGRAM);

const DIGEST = `sha256:${sha256Hex(SWE_REBENCH_OCI_GRADER_PROGRAM_BYTES)}` as const;

/**
 * The grader program's published identity. Freeze this at method lock, print it in the report,
 * and record it on every verdict so a published result binds to a specific grader.
 */
export function graderProgramDigest(): `sha256:${string}` {
  return DIGEST;
}
