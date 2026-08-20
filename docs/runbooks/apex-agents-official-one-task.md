# Qualify APEX-Agents `one_task` on the HuggingFace pin

Operator-only campaign. Success is protocol identity, not a leaderboard
score. Default CI and `yarn test` never download the dataset and never pull
Archipelago worlds.

Issue: [#2770](https://github.com/Jinn-Network/mono/issues/2770).

## What this proves

A human operator, on a machine with Archipelago at the sealed commit, drives
the **built Colophon CLI** (core `dist/cli/bin.js`) through method → quote →
lock → export against:

`colophon method --help` lists per-suite `--host` keys; `--n` selects the
first N registry ids (code-point order) and is mutually exclusive with
`--slice` and `--ids`.

- Dataset id `mercor/apex-agents`
- Revision `92c86856cf1b11f9833a8a076b3a45a63afa3929`
  (`APEX_AGENTS_DATASET_REVISION` in
  `packages/benchmark-product/core/src/runtime/apex-agents/manifest.ts`)
- Coverage `one_task` = lexicographic first `task_id` from **that
  snapshot**, not from a hand-picked JSON
- Real Archipelago executable (`--version` prints the sealed commit)

Quote must show `executionConformance: true`, `coverage: "one_task"`,
`leaderboardSubmitReady: false`. Inspection export mode is
`inspection-upload`. Colophon does not place the Mercor row. This qualify
does not launch the Archipelago grader.

## Out of scope

- Full 480-task / `ten_task` / `leaderboard_submit_ready`
- AA Stirrup (452 tasks, drop worlds 244 and 246, k=3)
- Claude Code / Codex as the APEX agent; Harbor; Inspect
- Mercor 8-run mean Pass@1 / Pass@8; demo `max_steps=50`
- Wiring this into CI or downloading gated HuggingFace data in GitHub Actions

## 1. Archipelago at the sealed commit

```bash
command -v archipelago
archipelago --version
# must print 0cb5c476c219a9df637e0bd37fb86b2361f4ab89
```

Keep this realpath for `host.json`. The fake executable used in
`yarn test` never downloads worlds.

## 2. Registry metadata at the pin (task ids only)

Dump HuggingFace `mercor/apex-agents` at revision
`92c86856cf1b11f9833a8a076b3a45a63afa3929`. Write UTF-8 JSON matching
`ApexAgentsRegistryMetadataSchema`: `name`, `revision`, `task_ids`.

Do not download evaluation worlds for this metadata dump.

```bash
python3 - <<'PY'
from datasets import load_dataset
import json, sys
ds = load_dataset(
    "mercor/apex-agents",
    split="test",
    revision="92c86856cf1b11f9833a8a076b3a45a63afa3929",
)
out = {
    "name": "mercor/apex-agents",
    "revision": "92c86856cf1b11f9833a8a076b3a45a63afa3929",
    "task_ids": [row["task_id"] for row in ds],
}
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
```

## 3. Fail-closed qualify

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON_APEX_AGENTS_ONE_TASK_QUALIFY=1 \
  COLOPHON_APEX_ARCHIPELAGO=/path/to/archipelago \
  COLOPHON_APEX_REGISTRY_METADATA=/path/to/apex-agents-metadata.json \
  yarn apex-agents-one-task-qualify
```

The script never downloads the dataset. It refuses unless the env flag and
operator paths are set. Success is `one_task`, conforming, not ready.
