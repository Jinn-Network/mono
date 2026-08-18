# Qualify Terminal-Bench 3.0 `one_task` on the Hub pin

Operator-only campaign. Success is protocol identity, not a leaderboard
score. Default CI and `yarn test` never download the dataset and never invoke
real Harbor.

Issue: [#2769](https://github.com/Jinn-Network/mono/issues/2769). Decision:
[DR-2026-08-18-b](../../log/decisions/2026-08-18-terminal-bench-3-0-official-suite.md).

## What this proves

A human operator, on a machine with Harbor 0.21 and Docker, drives the **built
Colophon CLI** (core `dist/cli/bin.js`) through method → quote → lock → launch →
collect → export against:

- Dataset id `terminal-bench/terminal-bench`
- Revision `sha256:a32a61879ea94eb9dc16fa1fbeb398759f0c07ca633d9d1f6aec760207036da3`
  (`TERMINAL_BENCH_3_0_DATASET_REF` in
  `packages/benchmark-product/core/src/runtime/terminal-bench-3-0/manifest.ts`),
  Hub version string `3.0.0`. Never `@latest`. Select refuses every other
  revision, and refuses a snapshot that names a different Hub version: the
  dataset id is rolling, so bumping the pin is an Issue plus a constant bump,
  never a silent select.
- Coverage `one_task` = lexicographic first name from **that registry
  snapshot**, not from GitHub `v3.0.0` or `main/tasks/`
- Real Harbor `0.21.x` on `PATH`, local Docker, Harbor's built-in **oracle**
  (no model credentials)

Quote and collect must show `protocol: "terminal-bench-3.0"`,
`executionConformance: true`, `coverage: "one_task"`,
`leaderboardSubmitReady: false`. Hub export mode is `inspection-upload`.
Instructions use `harbor upload`. Do not copy 2.1 `lb submit` or community-
submissions-closed copy.

## Out of scope

- Full-suite / `ten_task` / `leaderboard_submit_ready`
- Paid coding agents, Daytona, live Hub upload
- Wiring this into CI or downloading TB 3.0 in GitHub Actions
- Wearing 3.0 on a 2.1 lock, TB 2.0, SWE-bench Verified, or Inspect

## 1. Harbor 0.21

```bash
uv tool install harbor
harbor --version   # must print 0.21.x
command -v harbor  # keep this realpath for host.json
```

## 2. Registry metadata at the pin (metadata only)

Dump Harbor registry metadata with `PackageDatasetClient().get_dataset_metadata`.
Write UTF-8 JSON matching `TerminalBench30RegistryMetadataSchema`: `name`,
`version` (`3.0.0`), `dataset_version_content_hash` equal to the pin, and
`task_ids[]` with `org: "terminal-bench"`, `name`, `ref`.

```bash
python3 - <<'PY'
import asyncio, json, sys
from harbor.registry.client.package import PackageDatasetClient

DATASET = "terminal-bench/terminal-bench"
REF = "sha256:a32a61879ea94eb9dc16fa1fbeb398759f0c07ca633d9d1f6aec760207036da3"

async def main() -> None:
    meta = await PackageDatasetClient().get_dataset_metadata(f"{DATASET}@{REF}")
    out = {
        "name": DATASET,
        "version": getattr(meta, "version", "3.0.0"),
        "dataset_version_content_hash": REF,
        "task_ids": [
            {"org": t.org, "name": t.name, "ref": t.ref} for t in meta.task_ids
        ],
    }
    json.dump(out, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")

asyncio.run(main())
PY
```

Write that JSON to an operator path (not the repo), e.g.
`/tmp/colophon-tb30-one-task/registry-metadata.json`. If `org` is not
`terminal-bench`, stop — do not rewrite the snapshot to make select succeed.

## 3. Named slice from the snapshot

`one_task` is the lexicographic first name from **this** pin's `task_ids`.
Those names are not Terminal-Bench 2.1 task names.

```bash
node --input-type=module - <<'JS'
import { readFileSync } from "node:fs";
import { namedSliceTaskNames } from "./packages/benchmark-product/core/dist/index.js";
const meta = JSON.parse(readFileSync(process.env.REGISTRY_METADATA, "utf8"));
const names = namedSliceTaskNames(meta.task_ids.map((t) => t.name), "one_task");
process.stdout.write(`${JSON.stringify(names)}\n`);
JS
```

Set `REGISTRY_METADATA` to the dump path and run from the repo root after
`yarn --cwd packages/benchmark-product/core build`.

## 4. One task package only

Download **only that task's package**. `taskMaterialPath` is a directory
containing `<taskName>/task.toml` and the rest of that package. Do not point
Colophon at the full 3.0 dataset tree.

Confirm Colophon's Packager hash equals the registry `task_ids[].ref` for
that name. If it does not match, the cache is the wrong revision — stop. Do
not use a GitHub checkout. Do not rewrite `task.toml`.

## 5. Digest pin (operator Docker, never inside select)

Official tasks often pin a registry tag in `task.toml`. Pull and inspect
**before** select; select itself never talks to Docker. Put `repo@sha256:…`
in `host.json` `environment.image`.

`colophon method --help` lists per-suite `--host` keys; `--n` selects the
first N registry ids (code-point order) and is mutually exclusive with
`--slice` and `--ids`.

## 6. Built CLI and workspace

Workspace lives **outside** the repo (for example
`/tmp/colophon-tb30-one-task`). Compile still requires ≥2 arms. Two Harbor
AgentConfigs that both use `oracle` with distinct `model_name` values
(`oracle-a`, `oracle-b`). `nConcurrent: 1`. Official env:
`environment.configuration: {}`. Retry policy comes from TB 3.0 select
(`nAttempts: 5`, `maxRetries: 3`).

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON="$(pwd)/dist/cli/bin.js"
WS=/tmp/colophon-tb30-one-task
```

```bash
node "$COLOPHON" init --workspace "$WS" --principal operator
node "$COLOPHON" draft create --workspace "$WS" --principal operator --name "TB30 one_task pin" --id tb30-one
node "$COLOPHON" arm add --workspace "$WS" --principal operator --draft tb30-one \
  --arm oracle-a --pinning '{"harness":{"id":"harbor-oracle-a","version":"1.0.0"}}'
node "$COLOPHON" arm add --workspace "$WS" --principal operator --draft tb30-one \
  --arm oracle-b --pinning '{"harness":{"id":"harbor-oracle-b","version":"1.0.0"}}'
node "$COLOPHON" method terminal-bench-3.0 --workspace "$WS" --principal operator \
  --draft tb30-one --slice 1 --host "$WS/host.json" --json
node "$COLOPHON" quote --workspace "$WS" --principal operator --draft tb30-one --json
node "$COLOPHON" lock --workspace "$WS" --principal operator --draft tb30-one
node "$COLOPHON" launch --workspace "$WS" --principal operator --draft tb30-one
node "$COLOPHON" collect --workspace "$WS" --principal operator --draft tb30-one --json
node "$COLOPHON" export --workspace "$WS" --principal operator --draft tb30-one --arm oracle-a --json
node "$COLOPHON" export --workspace "$WS" --principal operator --draft tb30-one --arm oracle-b --json
node "$COLOPHON" report --workspace "$WS" --principal operator --draft tb30-one --json
```

Launch starts **one** `harbor run` per arm (planned job). Expect about 10
judged cells (1 task × 2 arms × 5).

## 7. Receipt checklist

After collect / Hub export, write down (do not invent Hub placement):

- Harbor `--version` and executable sha256 from the sealed selection
- Registry snapshot sha256 and `dataset.taskCount` (real pin is tens of tasks, not 1)
- Selected task name and Packager ref
- Quote bits: protocol `terminal-bench-3.0`, conforming, `one_task`, not leaderboard-ready
- Planned JobConfig: `n_attempts: 5`, `retry.max_retries: 3`,
  `n_concurrent_trials: 1`, `task_names: [<slice>]`
- Hub `jobDir` is the planned job, mode `inspection-upload`, instructions
  include `harbor upload` and do **not** include 2.1 `lb submit` or
  community-submissions-closed copy
- Report `limitations[]` carries the canonical Terminal-Bench 3.0
  not-leaderboard sentence

Do not run `harbor upload` from CI. Do not run `lb submit`.

## Opt-in yarn script

`packages/benchmark-product/core` exposes `yarn tb30-one-task-qualify`. It
**fails closed** unless `COLOPHON_TB30_ONE_TASK_QUALIFY=1` and the operator
paths below exist. Default `yarn test` does not run it. It never downloads
the dataset.

```bash
cd packages/benchmark-product/core
COLOPHON_TB30_ONE_TASK_QUALIFY=1 \
  COLOPHON_TB30_HARBOR="$(command -v harbor)" \
  COLOPHON_TB30_REGISTRY_METADATA=/tmp/colophon-tb30-one-task/registry-metadata.json \
  COLOPHON_TB30_TASK_MATERIAL=/tmp/colophon-tb30-one-task/task-material \
  COLOPHON_TB30_IMAGE='repo@sha256:…' \
  COLOPHON_TB30_WORKSPACE=/tmp/colophon-tb30-one-task \
  yarn tb30-one-task-qualify
```
