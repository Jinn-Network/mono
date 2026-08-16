#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
swe-rebench-v2 container grader entrypoint — implements the `jinn.grader-context.v1`
container contract (issue #2543).

This script runs INSIDE a digest-pinned grader image that is built FROM a single
swe-rebench instance's published eval image (see Dockerfile + build-grader-image.sh in
this directory). The instance image supplies the checked-out repository at
`manifest.repo_dir` (`/testbed`) and a ready test environment (python + pytest on PATH);
this script supplies the jinn-context reading, subject-digest verification, patch-apply,
and transition arithmetic — i.e. the same grading the legacy host-driven runner performs
(`operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts`), re-homed inside the
container so it reads the jinn context instead of being host-orchestrated.

The M4c Docker driver (`operator/src/daemon/native-evaluator-container-runtime.ts`) runs this
with the mount target as the working directory, `--network none`, `--cap-drop ALL`,
`--read-only` relaxed to false (so the grade's pytest can touch the image rootfs). The
package's `containerGraderReportSource`
(`packages/task-execution/evaluator-adapters/src/container-grader-source.ts`) writes the
context + subject bytes into that workdir and reads `grader-output.json` back out.

CONTRACT (each numbered step below maps to a step in the issue):
  1. Read `<workdir>/evaluation-context.json` (schema `jinn.grader-context.v1`).
  2. Verify every declared subject digest (task + each result) against the bytes on disk.
     A mismatch is fatal: nothing is graded.
  3. Apply the Result subject (candidate patch) to the instance repo.
  4. Apply the baked gold test patch, then run the declared fail-to-pass + pass-to-pass
     transitions with the instance's real pytest.
  5. Write `<workdir>/grader-output.json` in the upstream swe-rebench report-item shape.
  6. Exit with pytest's aggregate code (0 = every named test passed, nonzero otherwise) —
     a nonzero exit is NORMAL for a failing grade; the host parser decides pass/fail.

WHY THE GRADING PARAMETERS ARE BAKED, NOT READ FROM THE CONTEXT: the shipped
`jinn.grader-context.v1` context file carries only `{schema, attempt, task, results,
specification:{family,platform,timeoutSeconds}}`. It does NOT convey the transitions,
the gold test patch, or the instance identity — those live in the sealed
`EvaluationSpec.familyBlock` on the host, which never reaches the container. Because the
grader image is digest-pinned PER INSTANCE (its digest is what the EvaluationSpec's
`familyBlock.image` commits to), the instance's grading parameters are baked into the image
at build time (`/jinn/grader/manifest.json` + `/jinn/grader/test.patch`). A generic grader
image is impossible under this contract; that is a property of the shipped schema, recorded
in the README as a design fact.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

CONTEXT_SCHEMA = "jinn.grader-context.v1"
CONTEXT_NAME = "evaluation-context.json"
OUTPUT_NAME = "grader-output.json"
MANIFEST_PATH = Path("/jinn/grader/manifest.json")
TEST_PATCH_PATH = Path("/jinn/grader/test.patch")

# Pytest short-summary lines under `-rA`: "PASSED <nodeid>", "FAILED <nodeid>", "ERROR <nodeid>".
_SUMMARY_LINE = re.compile(r"^(PASSED|FAILED|ERROR)\s+(\S+)")


def _log(message: str) -> None:
    """Diagnostics go to stdout — the driver captures it as the grader LOG channel
    (`RawGraderReport.log`), which the host parser scans for infrastructure signatures."""
    print(message, flush=True)


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_output(workdir: Path, report: dict) -> None:
    (workdir / OUTPUT_NAME).write_text(json.dumps(report), encoding="utf-8")


def _fatal_report(workdir: Path, instance_id: str, error: str) -> "int":
    """A grade that never happened: a declared `error` string makes the host parser return
    `ungradeable` (eval_setup_error), never a failing verdict. Exit nonzero."""
    _log(f"[grader] FATAL: {error}")
    _write_output(
        workdir,
        {
            "instance_id": instance_id,
            "from_fail_to_pass": [],
            "failed_from_pass_to_pass": [],
            "passed_match": False,
            "exit_code": 1,
            "error": error,
        },
    )
    return 1


def _load_context(workdir: Path) -> dict:
    context = json.loads((workdir / CONTEXT_NAME).read_text(encoding="utf-8"))
    if not isinstance(context, dict):
        raise ValueError(f"{CONTEXT_NAME} is not a JSON object")
    schema = context.get("schema")
    if schema != CONTEXT_SCHEMA:
        raise ValueError(f"unexpected context schema {schema!r}, want {CONTEXT_SCHEMA!r}")
    return context


def _verify_subject(workdir: Path, entry: dict, label: str) -> bytes:
    """Read a declared subject and verify its bytes against the declared sha256 (step 2)."""
    rel = entry.get("path")
    declared = entry.get("digest")
    if not isinstance(rel, str) or not isinstance(declared, str):
        raise ValueError(f"{label} context entry is missing path/digest")
    if not declared.startswith("sha256:"):
        raise ValueError(f"{label} digest is not sha256-prefixed: {declared!r}")
    data = (workdir / rel).read_bytes()
    actual = f"sha256:{_sha256_hex(data)}"
    if actual != declared:
        raise ValueError(
            f"{label} digest mismatch: declared {declared}, bytes on disk {actual}"
        )
    _log(f"[grader] verified {label} digest {declared} ({len(data)} bytes)")
    return data


def _bash_login(command: str, cwd: Path, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    """Run a command through a bash LOGIN shell (`bash -lc`) so the instance eval image's own
    conda activation applies. swe-rebench `sweb.eval.*` images set `CONDA_DEFAULT_ENV=testbed`
    and put the base conda first on PATH, so a bare `python`/`python3` from a non-login process
    (this entrypoint) resolves to the base env, which lacks pytest and the repo's deps. A login
    shell activates the `testbed` env, where `python -m pytest` and the repo are importable —
    the same environment the tests are meant to run in. This is why the entrypoint shells out
    rather than importing pytest in-process."""
    return subprocess.run(
        ["bash", "-lc", f"cd {shlex.quote(str(cwd))} && {command}"],
        input=stdin,
        capture_output=True,
    )


def _git_apply(repo_dir: Path, patch_bytes: bytes, label: str) -> None:
    """Apply a patch with `git apply`. On failure the git stderr (which carries the
    'patch does not apply' / 'error: patch failed:' signatures the host parser classifies)
    is surfaced on stdout, then the error propagates."""
    result = _bash_login("git apply --verbose -", repo_dir, stdin=patch_bytes)
    if result.stdout:
        _log(result.stdout.decode("utf-8", "replace"))
    if result.returncode != 0:
        _log(result.stderr.decode("utf-8", "replace"))
        raise RuntimeError(f"{label} did not apply cleanly (git apply exit {result.returncode})")
    _log(f"[grader] {label} applied")


def _passed_ids(pytest_stdout: str) -> set:
    """The set of node ids pytest reported as PASSED in its `-rA` short summary."""
    passed = set()
    for line in pytest_stdout.splitlines():
        match = _SUMMARY_LINE.match(line.strip())
        if match and match.group(1) == "PASSED":
            passed.add(match.group(2))
    return passed


def _is_passed(node_id: str, passed: set) -> bool:
    """Exact node-id match, or a parametrized child (`<id>[params]`) of it."""
    if node_id in passed:
        return True
    prefix = node_id + "["
    return any(p.startswith(prefix) for p in passed)


def main() -> int:
    workdir = Path(os.getcwd())
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    instance_id = str(manifest.get("instance_id", ""))
    fail_to_pass = list(manifest.get("fail_to_pass", []))
    pass_to_pass = list(manifest.get("pass_to_pass", []))
    repo_dir = Path(manifest.get("repo_dir", "/testbed"))

    _log(f"[grader] {CONTEXT_SCHEMA} instance={instance_id} workdir={workdir}")

    # Step 1 + 2: read the context, verify every declared subject digest.
    try:
        context = _load_context(workdir)
        task_entry = context["task"]
        result_entries = context["results"]
        _verify_subject(workdir, task_entry, "task subject")
        result_bytes = [
            _verify_subject(workdir, entry, f"result subject {index}")
            for index, entry in enumerate(result_entries)
        ]
    except Exception as error:  # noqa: BLE001 — any failure here means "could not grade".
        return _fatal_report(workdir, instance_id, f"context/subject verification failed: {error}")

    if len(result_bytes) != 1:
        return _fatal_report(
            workdir, instance_id, f"expected exactly one result subject, got {len(result_bytes)}"
        )
    candidate_patch = result_bytes[0]

    # Cross-check the baked instance identity against the task subject when it is plain JSON
    # (defense in depth; never fatal on a shape we don't recognise).
    try:
        task_json = json.loads((workdir / task_entry["path"]).read_bytes())
        task_instance = task_json.get("instance_id") if isinstance(task_json, dict) else None
        if isinstance(task_instance, str) and task_instance and task_instance != instance_id:
            return _fatal_report(
                workdir,
                instance_id,
                f"task subject instance_id {task_instance!r} != baked {instance_id!r}",
            )
    except Exception:  # noqa: BLE001 — task subject need not be JSON; skip the cross-check.
        pass

    # Step 3: apply the candidate patch. An empty/whitespace-only submission applies nothing
    # (a real "no fix" attempt) and grades as an ordinary fail, not an infrastructure error.
    if candidate_patch.strip():
        normalized = candidate_patch if candidate_patch.endswith(b"\n") else candidate_patch + b"\n"
        try:
            _git_apply(repo_dir, normalized, "candidate patch")
        except Exception as error:  # noqa: BLE001
            # A malformed/non-applying patch: emit the classifiable signature (already on
            # stdout from _git_apply) and a nothing-passed report so the host classifies it.
            _log(f"[grader] candidate patch failed to apply: {error}")
            _write_output(
                workdir,
                {
                    "instance_id": instance_id,
                    "from_fail_to_pass": [],
                    "failed_from_pass_to_pass": list(pass_to_pass),
                    "passed_match": False,
                    "exit_code": 1,
                    "error": "",
                },
            )
            return 1
    else:
        _log("[grader] candidate patch is empty — grading the unmodified repository")

    # Step 4a: apply the baked gold test patch (adds/updates the declared tests).
    try:
        _git_apply(repo_dir, TEST_PATCH_PATH.read_bytes(), "gold test patch")
    except Exception as error:  # noqa: BLE001
        return _fatal_report(workdir, instance_id, f"gold test patch did not apply: {error}")

    # Step 4b: run exactly the declared node ids with the instance's real pytest, in the
    # `-rA` summary format the transition arithmetic parses (matches the legacy runner's
    # buildTestCommands override).
    node_ids = list(fail_to_pass) + list(pass_to_pass)
    if not node_ids:
        return _fatal_report(workdir, instance_id, "manifest declares no transitions to run")
    pytest_cmd = " ".join([
        "python", "-m", "pytest",
        "--no-header", "-rA", "--tb=no", "-p", "no:cacheprovider",
        *(shlex.quote(node_id) for node_id in node_ids),
    ])
    _log(f"[grader] $ bash -lc '{pytest_cmd}'")
    proc = _bash_login(pytest_cmd, repo_dir)
    pytest_stdout = proc.stdout.decode("utf-8", "replace")
    pytest_stderr = proc.stderr.decode("utf-8", "replace")
    _log(pytest_stdout)
    if pytest_stderr.strip():
        _log(pytest_stderr)
    pytest_exit = proc.returncode

    # Step 5: transition arithmetic → upstream report-item shape.
    passed = _passed_ids(pytest_stdout)
    from_fail_to_pass = [t for t in fail_to_pass if _is_passed(t, passed)]
    failed_from_pass_to_pass = [t for t in pass_to_pass if not _is_passed(t, passed)]
    passed_match = (
        len(from_fail_to_pass) == len(fail_to_pass) and len(failed_from_pass_to_pass) == 0
    )
    _write_output(
        workdir,
        {
            "instance_id": instance_id,
            "from_fail_to_pass": from_fail_to_pass,
            "failed_from_pass_to_pass": failed_from_pass_to_pass,
            "passed_match": passed_match,
            "exit_code": pytest_exit,
            "error": "",
        },
    )
    _log(
        f"[grader] passed_match={passed_match} "
        f"f2p={len(from_fail_to_pass)}/{len(fail_to_pass)} "
        f"p2p_broken={len(failed_from_pass_to_pass)}/{len(pass_to_pass)} pytest_exit={pytest_exit}"
    )

    # Step 6: exit with pytest's aggregate code (0 iff every named test passed).
    return 0 if pytest_exit == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
