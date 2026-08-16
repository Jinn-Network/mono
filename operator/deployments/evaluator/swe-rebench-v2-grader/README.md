# swe-rebench-v2 grader image — `jinn.grader-context.v1`

The real grader image the shipped `network.jinn.evaluation-method.swe-rebench-v2` method
promises but did not previously produce (issue #2543; the gap is FINDING 2 of the artifact-(ii)
evidence). It implements the `jinn.grader-context.v1` container contract that
`packages/task-execution/evaluator-adapters/src/container-grader-source.ts` and the M4c Docker
driver `operator/src/daemon/native-evaluator-container-runtime.ts` consume.

## What the image is

A grader image is built **per instance, FROM that instance's published swe-rebench eval image**
(`swerebench/sweb.eval.x86_64.<instance>`). The base image supplies the checked-out repository at
`/testbed` and a ready pytest environment; this directory supplies the jinn grading logic
(`grade.py`) and the instance's baked grading parameters. The result is a digest-pinned image
whose digest is what an `EvaluationSpec`'s `familyBlock.image` commits to.

This is the same grading the legacy host-driven runner performs
(`operator/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts` → upstream `scripts/eval.py`),
re-homed **inside** a container that reads the jinn context, instead of being orchestrated from the
host. The transition arithmetic (`from_fail_to_pass` / `failed_from_pass_to_pass`, SWE-bench
"resolved" semantics) matches, so `parseSweRebenchReport`
(`packages/task-execution/evaluator-adapters/src/swe-rebench/parse.ts`) agrees.

## The contract `grade.py` implements

Run by the M4c driver with the bound workspace as the working directory:

1. Read `<workdir>/evaluation-context.json` (schema `jinn.grader-context.v1`).
2. Verify every declared subject digest (task + each result) against the bytes on disk; abort on mismatch.
3. Apply the Result subject (candidate patch) to `/testbed`.
4. Apply the baked gold test patch, then run the declared fail-to-pass + pass-to-pass node ids with the instance's real pytest (`-rA` summary format).
5. Write `<workdir>/grader-output.json` in the upstream report-item shape
   `{instance_id, from_fail_to_pass[], failed_from_pass_to_pass[], passed_match, exit_code, error}`.
6. Exit with pytest's aggregate code (0 iff every named test passed).

## Why the grading parameters are baked, not read from the context (design fact)

The shipped `jinn.grader-context.v1` context file carries only
`{schema, attempt, task, results, specification:{family, platform, timeoutSeconds}}`. It does **not**
convey the transitions, the gold test patch, or the instance identity — those live in the sealed
`EvaluationSpec.familyBlock` on the host and never cross into the container (the deployment passes
`env: {}` and `--network none`). Because the grader image is digest-pinned per instance, the
instance's grading parameters are baked into the image at build time (`/jinn/grader/manifest.json` +
`/jinn/grader/test.patch`). **A single generic grader image cannot satisfy this contract** — that is
a property of the shipped schema, not a choice here. (A future context-schema revision that carried
the transitions + test material would allow one generic grader image; that is out of scope for #2543,
which conforms to the shipped contract rather than changing it.)

## Isolation note

The driver runs the container `--network none --cap-drop ALL --no-new-privileges --pids-limit
--memory --cpus` with a `noexec,nosuid` `/tmp`. The swe-rebench method relaxes `--read-only` to
false (the grade's pytest touches the image's site-packages). Because `--network none` forbids
grade-time network, the grader does **no** package installs at grade time and relies on the eval
image being fully provisioned (the `sweb.eval.*` images are). If pytest is genuinely absent it cannot
be installed offline, and the run is classified `ungradeable:pytest_missing` — the correct outcome.

## Build

```bash
./build-grader-image.sh \
  --row <hf-row.json> \
  --tag <registry>/jinn-swe-grader-<instance>:v1 \
  --push          # push so `docker` reports a real repo-digest (the only form the source accepts)
```

`<hf-row.json>` is a swe-rebench HF row (see `hf-fetcher.ts`) carrying at least
`{ instance_id, image_name, FAIL_TO_PASS[], PASS_TO_PASS[], test_patch }`. The script pulls the
instance image, digest-pins it into the grader's `FROM`, bakes the manifest + test patch, builds,
and (with `--push`) prints the `repo@sha256:<digest>` reference for the `EvaluationSpec`.

## Wiring into an EvaluationSpec

`familyBlock.image` in a per-instance `deterministic-process` `EvaluationSpec` references this
grader image by digest. `sweRebenchRowToTaskAndSpec`
(`packages/task-execution/profiles/src/documents/swe-rebench.ts`) sets `familyBlock.image = row.image`
— so a minting pipeline that adopts container grading sets `row.image` to the **grader** image built
here (which transitively pins the instance image), not the raw instance image. The successor method
descriptor `../swe-rebench-v2-evaluation-method.v2.json` documents this and how it is selected
without disturbing the v1 descriptor's pinned identity.
