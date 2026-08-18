# Qualify Terminal-Bench 2.1 `one_task` on the leaderboard pin

Operator-only campaign. Success is protocol identity, not a leaderboard
score. Default CI and `yarn test` never download the dataset and never invoke
real Harbor.

Issue: [#2754](https://github.com/Jinn-Network/mono/issues/2754). Stacked on
the Harbor retry-bind work in [#2752](https://github.com/Jinn-Network/mono/issues/2752).

## What this proves

A human operator, on a machine with Harbor 0.21 and Docker, drives the **built
Colophon CLI** (core `dist/cli/bin.js`, the same advanced verb surface as the
installable `colophon` command) through method → quote → lock → launch →
collect → export against:

- Dataset id `terminal-bench/terminal-bench-2-1`
- Revision `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`
  (`TERMINAL_BENCH_2_1_DATASET_REF` in
  `packages/benchmark-product/core/src/runtime/terminal-bench-2-1/manifest.ts`),
  the same pin as maintainer `leaderboard/src/leaderboard/core/hub.py`
- Coverage `one_task` = lexicographic first name from **that registry
  snapshot**, not from GitHub `main/tasks/`
- Real Harbor `0.21.x` on `PATH`, local Docker, Harbor's built-in **oracle**
  (no model credentials)

Quote and collect must show `executionConformance: true`, `coverage:
"one_task"`, `leaderboardSubmitReady: false`. Hub export mode is
`inspection-upload`. Do not run `lb submit`.

## Out of scope

- Full 89-task / `ten_task` / `leaderboard_submit_ready`
- Paid coding agents, Daytona, Hub upload/submit
- Wiring this into CI or downloading TB 2.1 in GitHub Actions
- Forking Harbor; rewriting Hub jobs; SWE-bench Verified / Inspect official

## 1. Harbor 0.21

```bash
uv tool install harbor
harbor --version   # must print 0.21.x
command -v harbor  # keep this realpath for host.json
```

Use the same byte-pinned binary later used for publication rehearsal if you
already have one.

## 2. Registry metadata at the pin (metadata only)

Dump Harbor registry metadata the same way `hub.py` `dataset_task_digests`
does: `PackageDatasetClient().get_dataset_metadata`. Write UTF-8 JSON matching
`TerminalBench21RegistryMetadataSchema`: `name`,
`dataset_version_content_hash` equal to `DATASET_REF`, and `task_ids[]` with
`org: "terminal-bench"`, `name`, `ref`.

```bash
REF=sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a
python3 - <<'PY'
import asyncio, json, sys
from harbor.registry.client.package import PackageDatasetClient

DATASET = "terminal-bench/terminal-bench-2-1"
REF = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"

async def main() -> None:
    meta = await PackageDatasetClient().get_dataset_metadata(f"{DATASET}@{REF}")
    out = {
        "name": DATASET,
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
`/tmp/colophon-tb21-one-task/registry-metadata.json`. `task_ids.length` on the
real pin is tens of tasks, not 1. If `org` is not `terminal-bench`, stop —
do not rewrite the snapshot to make select succeed.

## 3. Named slice from the snapshot

`one_task` is the lexicographic first name Colophon already uses:
`namedSliceTaskNames(task_ids.map(name), "one_task")`. Do not trust GitHub
`main`. Confirm the name from the JSON you just dumped.

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

Download **only that task's package** (Harbor cache under
`~/.cache/harbor/tasks/`, or `harbor datasets download` then copy one
directory). `taskMaterialPath` is a directory containing
`<taskName>/task.toml` and the rest of that package. Do not point Colophon at
the full 89-task tree.

Confirm Colophon's Packager hash equals the registry `task_ids[].ref` for
that name:

```bash
node --input-type=module - <<'JS'
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { computeHarbor021TaskContentHash } from "./packages/benchmark-product/core/dist/index.js";
const meta = JSON.parse(readFileSync(process.env.REGISTRY_METADATA, "utf8"));
const name = process.env.TASK_NAME;
const got = `sha256:${computeHarbor021TaskContentHash(join(process.env.TASK_MATERIAL, name)).contentHash}`;
const want = meta.task_ids.find((t) => t.name === name).ref;
if (got !== want) {
  console.error(`hash mismatch: computed ${got} registry ${want}`);
  process.exit(1);
}
process.stdout.write(`${name} ${got}\n`);
JS
```

If it does not match, the cache is the wrong revision — stop. Do not use a
GitHub `main` checkout. Do not rewrite `task.toml` (that would change the
Harbor 0.21 Packager hash).

If hashing refuses a custom `.gitignore`, the bytes still have to come from
the registry package; do not strip the file to make the JS hasher happy.

## 5. Digest pin (operator Docker, never inside select)

Official tasks often pin a registry **tag** in `task.toml`, for example
`docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"`. Colophon
select still records a digest in `environment.image`. Pull and inspect
**before** select; select itself never talks to Docker.

```bash
docker pull alexgshaw/adaptive-rejection-sampler:20251031
docker image inspect alexgshaw/adaptive-rejection-sampler:20251031 \
  --format '{{index .RepoDigests 0}}'
```

Put that `repo@sha256:…` in `host.json` `environment.image`. The
repository name must match `task.toml`; the digest is the operator's pin of
the same image.

## 6. Built CLI and workspace

Workspace lives **outside** the repo (for example
`/tmp/colophon-tb21-one-task`). Compile still requires ≥2 arms. Mirror the
publication rehearsal: two Harbor AgentConfigs that both use `oracle` with
distinct `model_name` values (`oracle-a`, `oracle-b`). `nConcurrent: 1` for
the first qualify. Official env: `environment.configuration: {}`. Retry
policy comes from TB 2.1 select (`nAttempts: 5`, `maxRetries: 3`).

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON="$PWD/dist/cli/bin.js"
WS=/tmp/colophon-tb21-one-task
mkdir -p "$WS"
```

`host.json` is the incomplete catalog host document (paths, arms, image).
Coverage is `--slice 1`, which seals `one_task`:

```json
{
  "executable": "/absolute/path/to/harbor",
  "registryMetadataPath": "/tmp/colophon-tb21-one-task/registry-metadata.json",
  "datasetRevision": "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a",
  "taskMaterialPath": "/tmp/colophon-tb21-one-task/task-material",
  "nConcurrent": 1,
  "arms": [
    {
      "armId": "oracle-a",
      "agent": { "id": "oracle", "configuration": {} },
      "model": { "id": "oracle-a", "configuration": {} },
      "jobAgent": { "name": "oracle", "model_name": "oracle-a" }
    },
    {
      "armId": "oracle-b",
      "agent": { "id": "oracle", "configuration": {} },
      "model": { "id": "oracle-b", "configuration": {} },
      "jobAgent": { "name": "oracle", "model_name": "oracle-b" }
    }
  ],
  "environment": {
    "type": "docker",
    "image": "alexgshaw/adaptive-rejection-sampler@sha256:REPLACE_WITH_INSPECT_DIGEST",
    "configuration": {}
  },
  "outputs": [
    {
      "name": "prediction",
      "mediaType": "application/json",
      "artifact": { "source": "/logs/artifacts/prediction.json", "destination": "prediction.json" },
      "nativePath": "artifacts/prediction.json"
    }
  ]
}
```

Replace `executable`, paths, and the digest. Keep `--slice 1` and
empty `configuration`.

```bash
node "$COLOPHON" init --workspace "$WS" --principal operator
node "$COLOPHON" draft create --workspace "$WS" --principal operator --name "TB21 one_task pin" --id tb21-one
node "$COLOPHON" arm add --workspace "$WS" --principal operator --draft tb21-one \
  --arm oracle-a --pinning '{"harness":{"id":"harbor-oracle-a","version":"1.0.0"}}'
node "$COLOPHON" arm add --workspace "$WS" --principal operator --draft tb21-one \
  --arm oracle-b --pinning '{"harness":{"id":"harbor-oracle-b","version":"1.0.0"}}'
node "$COLOPHON" method terminal-bench-2.1 --workspace "$WS" --principal operator \
  --draft tb21-one --slice 1 --host "$WS/host.json" --json
node "$COLOPHON" quote --workspace "$WS" --principal operator --draft tb21-one --json
node "$COLOPHON" lock --workspace "$WS" --principal operator --draft tb21-one
node "$COLOPHON" launch --workspace "$WS" --principal operator --draft tb21-one
node "$COLOPHON" collect --workspace "$WS" --principal operator --draft tb21-one --json
node "$COLOPHON" export --workspace "$WS" --principal operator --draft tb21-one --arm oracle-a --json
node "$COLOPHON" export --workspace "$WS" --principal operator --draft tb21-one --arm oracle-b --json
node "$COLOPHON" report --workspace "$WS" --principal operator --draft tb21-one --json
```

Launch starts **one** `harbor run` per arm (planned job). Expect about 10
judged cells (1 task × 2 arms × 5). Oracle usually succeeds, so in-job retries
may not fire; that is acceptable — #2752 already binds wipe-and-recreate under
fake Harbor. If Harbor retries, dispatch 2+ must stay in the **planned** job
(no follow-up job name for a Harbor-retryable failure).

Wall clock: first Docker pull of the task image, then oracle trials (task
agent timeout is 900s; oracle `solve.sh` is usually much shorter). Sequential
`nConcurrent: 1` can still take a long sitting.

## 7. Receipt checklist

After collect / Hub export, write down (do not invent Hub placement):

- Harbor `--version` and executable sha256 from the sealed selection
- Registry snapshot sha256 and `dataset.taskCount` (real pin is tens of tasks, not 1)
- Selected task name and Packager ref
- Quote bits: conforming, `one_task`, not leaderboard-ready
- Planned JobConfig: `n_attempts: 5`, `retry.max_retries: 3`,
  `n_concurrent_trials: 1`, `task_names: [<slice>]`
- Mapping count: 10 by-dispatch files if both arms complete without extra
  salvage dispatches
- Hub `jobDir` equals `harborArmJobName(runSha256, armId)` (planned job),
  mode `inspection-upload`, instructions include the community-submissions-closed
  sentence
- Report `limitations[]` carries the canonical not-leaderboard sentence

Useful paths under `$WS`:

- Sealed selection and TB 2.1 profile in the workspace sealed-bytes store
- Harbor jobs: `artifacts/harbor/jobs/<runSha256>/jinn-<run24>-<armId>/config.json`
- Mappings: `artifacts/harbor/mappings/by-dispatch/`
- Hub export: `artifacts/harbor/hub-export/tb21-one/<armId>/`

Do not run `harbor upload` or `uv run lb submit`.

## 8. Recorded receipt (2026-08-17 operator run)

Live values from workspace `/tmp/colophon-tb21-one-task-run-5` (not a Hub
leaderboard placement). Harbor 0.21.0 on this machine; dataset pin
`sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`;
image pin
`alexgshaw/adaptive-rejection-sampler@sha256:985bed39e8448bc95f138b5f766b59003a95c4be171c96af8e76448338f3dd8f`.

| Field | Value |
| --- | --- |
| Harbor version | `0.21.0` |
| Executable sha256 | `f3e65697df975c6ce2cdd31d459654fde96c5aea2576d891db345e6b807f8648` |
| Registry snapshot sha256 | `dd4abf49a8b686198713cd6db0e63cd62b8de48650393e06311d8054002d3f81` |
| `dataset.taskCount` | 89 |
| Selected task | `adaptive-rejection-sampler` |
| Packager ref | `sha256:bcaa2399985cd57666018025846289ab25e193ae0dd8fb7f0ffab2410c24d4de` |
| Quote | `executionConformance: true`, `coverage: "one_task"`, `leaderboardSubmitReady: false` |
| Planned JobConfig | `n_attempts: 5`, `retry.max_retries: 3`, `n_concurrent_trials: 1`, `task_names: ["adaptive-rejection-sampler"]` |
| Mapping count | 10 |
| Hub export | mode `inspection-upload`; `jobDir` is the planned job `jinn-f0b7ad7c1dd06ed4f5040203-oracle-a` / `…-oracle-b` |
| Report sha256 | `be5209f6d2222e6d02ff26f088f36175b19d25434982a3ca9060edd3711349dd` |
| Selection manifest sha256 | `a3e1d2d2394d1e6ebc0fade0cec5475f18118b540152c733860cf04b01c9b582` |

Report `limitations[]` includes the canonical not-leaderboard sentence. The
qualify script also writes `$WS/tb21-one-task-qualify-receipt.json`.

## Opt-in yarn script

`packages/benchmark-product/core` exposes `yarn tb21-one-task-qualify`. It
**fails closed** unless `COLOPHON_TB21_ONE_TASK_QUALIFY=1` and the operator
paths below exist. Default `yarn test` does not run it. It never downloads
the dataset.

```bash
cd packages/benchmark-product/core
COLOPHON_TB21_ONE_TASK_QUALIFY=1 \
  COLOPHON_TB21_HARBOR="$(command -v harbor)" \
  COLOPHON_TB21_REGISTRY_METADATA=/tmp/colophon-tb21-one-task/registry-metadata.json \
  COLOPHON_TB21_TASK_MATERIAL=/tmp/colophon-tb21-one-task/task-material \
  COLOPHON_TB21_IMAGE='repo@sha256:…' \
  COLOPHON_TB21_WORKSPACE=/tmp/colophon-tb21-one-task \
  yarn tb21-one-task-qualify
```
