# Qualify APEX-SWE-dev `one_task` on the HuggingFace pin

Operator-only campaign. Success is protocol identity, not a Mercor
leaderboard score. Default CI and `yarn test` never download the dataset,
never pull Git LFS, and never spin compose stacks.

Issue: [#2779](https://github.com/Jinn-Network/mono/issues/2779). Protocol
identity: [#2774](https://github.com/Jinn-Network/mono/issues/2774).

## What this proves

A human operator, on a machine with Mercor's `apex-swe` harness, Docker, and
the **built Colophon CLI** (core `dist/cli/bin.js`) drives method → quote →
lock → dual-Mercor grade (`apx` or `run_e2e.py` for the lexicographic first
task) → export against:

- Dataset id `mercor/APEX-SWE`
- Revision `4d7aeb2b829ca348c224992da803bca6502235f4`
  (`APEX_SWE_DEV_DATASET_REVISION` in
  `packages/benchmark-product/core/src/runtime/apex-swe-dev/manifest.ts`)
- Coverage `one_task` = lexicographic first `taskId` across **both**
  integration and observability names from **that snapshot** (likely an
  observability id starting `0x…`)
- Dual Mercor wrap: `apx run --n-trials 1 --timeout 3600` and
  `python run_e2e.py --trial 1 --time-limit 3600 --message-limit 250`

Quote must show `executionConformance: true`, `coverage: "one_task"`,
`leaderboardSubmitReady: false`. Export mode is `inspection-upload`. Do not
claim a Mercor APEX-SWE leaderboard row. The public 50 cannot wear the
200-task board.

## Where execution happens

Colophon owns method bind, quote, lock, and export. It does **not** drive the
Mercor harnesses. The `apx` and `run_e2e.py` wrap runs on this operator host,
between lock and export, driven by `yarn apex-swe-dev-one-task-qualify` (or by
hand with the same pinned arguments). `run launch` refuses a locked
`apex-swe-dev` draft with a typed `venue-unavailable` error pointing back
here: the local venue registers no launcher for this adapter, by design, and a
launcher that re-entered their agent loop would be the cousin this protocol
exists to refuse.

## Out of scope

- Full 200 / Mercor holdout / `leaderboard_submit_ready`
- `ten_task` / full-50 live runs
- APEX-Agents, rubric LM-judge as the cell score
- Wiring this into CI or downloading the 2.08 GB dataset in GitHub Actions
- Changing Colophon's Inspect `0.3.255` pin

## 1. Dual Mercor harness

Pin `Mercor-Intelligence/apex-swe` at
`7cfa580dd59704ff15cf558bda80257c23b6cb04`. Install **their** integration
`apx` venv and **their** observability venv (the one that imports
`run_e2e.py`). Do not point observability python at Colophon Inspect.

```bash
apx --version
python3 -c "import inspect_ai; print(inspect_ai.__version__)"
test -f /path/to/apex-swe/observability/run_e2e.py
```

Keep realpaths for `selection.json`.

## 2. Registry metadata at the pin (ids + types only)

Dump HuggingFace `mercor/APEX-SWE` at revision
`4d7aeb2b829ca348c224992da803bca6502235f4`. Write UTF-8 JSON matching
`ApexSweDevRegistryMetadataSchema`: `name`, `revision`, `tasks: [{ taskId,
taskType }]`. Official pin is exactly 25 integration + 25 observability.
Do not download evaluation blobs for this metadata dump.

## 3. Materialize **one** task dir (LFS)

Git LFS pointers fail closed at select. Pull LFS only for the lexicographic
first task (qualify only needs that task's harness). If `one_task` is
observability, materialize that observability task; keep the integration
dir present and empty of pointers.

## 4. Fail-closed qualify

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON_APEX_SWE_DEV_ONE_TASK_QUALIFY=1 \
  COLOPHON_APEX_SWE_DEV_APX=/path/to/apx \
  COLOPHON_APEX_SWE_DEV_PYTHON=/path/to/observability/venv/bin/python \
  COLOPHON_APEX_SWE_DEV_REGISTRY_METADATA=/path/to/apex-metadata.json \
  COLOPHON_APEX_SWE_DEV_INTEGRATION_DIR=/path/to/apex-swe/Integration \
  COLOPHON_APEX_SWE_DEV_OBSERVABILITY_DIR=/path/to/apex-swe/observability \
  yarn apex-swe-dev-one-task-qualify
```

The script never downloads the dataset. It refuses unless the env flag and
operator paths are set. After lock it wraps **their** harness for the single
`one_task` id (wall-clock up to 3600s; Docker required) and then exports
`inspection-upload`. Success is `one_task`, conforming, not ready, with
Mercor JSON present. Inspect locally; do not claim a Mercor row.
