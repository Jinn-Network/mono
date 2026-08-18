# Qualify SWE-bench Verified `one_task` on the HuggingFace pin

Operator-only campaign. Success is protocol identity, not a leaderboard
score. Default CI and `yarn test` never download the dataset and never pull
Verified images.

Issue: [#2744](https://github.com/Jinn-Network/mono/issues/2744).

## What this proves

A human operator, on a machine with `swebench` 4.1.x and Docker, drives the
**built Colophon CLI** (core `dist/cli/bin.js`) through select → quote →
lock → grade → export against:

- Dataset id `princeton-nlp/SWE-bench_Verified`
- Revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`
  (`SWE_BENCH_VERIFIED_DATASET_REVISION` in
  `packages/benchmark-product/core/src/runtime/swe-bench-verified/manifest.ts`)
- Coverage `one_task` = lexicographic first `instance_id` from **that
  snapshot**, not from a hand-picked JSON
- Real `python -m swebench.harness.run_evaluation`, local Docker

Quote must show `executionConformance: true`, `coverage: "one_task"`,
`leaderboardSubmitReady: false`. Predictions export mode is
`inspection-upload`. Do not run `sb submit`. An empty or wrong patch is
allowed if the harness ran and the cell is accounted.

## Out of scope

- Full 500-instance / `ten_task` / `leaderboard_submit_ready`
- Paid coding agents, Modal, `sb submit`
- Wiring this into CI or downloading Verified images in GitHub Actions
- Renaming swe-rebench; Inspect-as-specified (#2745); mini-SWE-agent

## 1. swebench 4.1.x

```bash
python3 -m pip install 'swebench==4.1.0'
python3 -m swebench --version   # or: python3 -c "import swebench; print(swebench.__version__)"
command -v python3              # keep this realpath for selection.json
```

The selection executable is the Python that can run
`-m swebench.harness.run_evaluation`. The fake harness used in `yarn test`
never downloads images.

## 2. Registry metadata at the pin (instance ids only)

Dump HuggingFace `princeton-nlp/SWE-bench_Verified` at revision
`c104f840cc67f8b6eec6f759ebc8b2693d585d4a`. Write UTF-8 JSON matching
`SwebenchVerifiedRegistryMetadataSchema`: `name`, `revision`, `instance_ids`.

Do not download evaluation images for this metadata dump.

```bash
python3 - <<'PY'
from datasets import load_dataset
import json, sys
ds = load_dataset(
    "princeton-nlp/SWE-bench_Verified",
    split="test",
    revision="c104f840cc67f8b6eec6f759ebc8b2693d585d4a",
)
out = {
    "name": "princeton-nlp/SWE-bench_Verified",
    "revision": "c104f840cc67f8b6eec6f759ebc8b2693d585d4a",
    "instance_ids": [row["instance_id"] for row in ds],
}
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
```

## 3. Fail-closed qualify

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON_SWEBENCH_VERIFIED_ONE_TASK_QUALIFY=1 \
  COLOPHON_SWEBENCH_PYTHON=/path/to/python3 \
  COLOPHON_SWEBENCH_REGISTRY_METADATA=/path/to/verified-metadata.json \
  yarn swebench-verified-one-task-qualify
```

The script never downloads the dataset. It refuses unless the env flag and
operator paths are set. Success is `one_task`, conforming, not ready.
