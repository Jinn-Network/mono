# Qualify Inspect-as-specified `one_task` on the in-repo hermetic Task

Operator-only campaign. Success is protocol identity, not an Inspect Hub
score. Default CI and `yarn test` never set the opt-in env and never download
GAIA, Cybench, or other large eval datasets.

Issue: [#2745](https://github.com/Jinn-Network/mono/issues/2745). Decision:
[DR-2026-08-18](../log/decisions/2026-08-18-inspect-as-specified.md).

## What this proves

A human operator, on a machine with Python 3.11+ and `inspect-ai==0.3.255`,
drives the **built Colophon CLI** (core `dist/cli/bin.js`, the same advanced
verb surface as the installable `colophon` command) through select → quote →
lock → launch → collect → View export against:

- In-repo Task `hermetic_eval.py@hermetic_eval`
  (`packages/benchmark-product/core/test/fixtures/inspect-project/`)
- Samples `alpha` and `bravo`; coverage `one_task` = lexicographic first
  sample id from **that catalog** (`alpha`). For this protocol `one_task`
  means one sample.
- Local Python, Inspect's **mockllm** (no model credentials)
- Worker still `epochs: 1`; specified epochs become Jinn replicates (here `1`)

Quote and collect must show `executionConformance: true`, `coverage:
"one_task"`, `leaderboardSubmitReady: false`. View export mode is
`inspection-upload`. Do not treat the log dir as an Inspect Hub row.

## Out of scope

- Full catalog / `ten_task` / `leaderboard_submit_ready`
- GAIA, Cybench, HumanEval, or any `inspect_evals` download
- Inspect Hub / Flow upload; Harbor Hub export
- Cousin `runtime inspect select` wearing this protocol name
- Wiring this into CI

## 1. Python and Inspect pin

```bash
python3 -c "import inspect_ai; print(inspect_ai.__version__)"   # must print 0.3.255
command -v python3   # keep this realpath for selection.json
```

Use the same byte-pinned Inspect the cousin runtime already freezes
(`SUPPORTED_INSPECT_VERSION` / wheel SHA in
`packages/benchmark-product/core/src/runtime/inspect/manifest.ts`). Do not
bump the pin for this qualify.

## 2. Build Colophon core

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON="$(pwd)/dist/cli/bin.js"
PROJECT="$(pwd)/test/fixtures/inspect-project"
```

## 3. Opt-in yarn script

`packages/benchmark-product/core` exposes
`yarn inspect-as-specified-one-task-qualify`. It **fails closed** unless
`COLOPHON_INSPECT_AS_SPECIFIED_ONE_TASK_QUALIFY=1`. Default `yarn test` does
not run it. It never downloads eval datasets. The fixture is the in-repo
hermetic Task.

```bash
cd packages/benchmark-product/core
COLOPHON_INSPECT_AS_SPECIFIED_ONE_TASK_QUALIFY=1 \
  COLOPHON_INSPECT_PYTHON="$(command -v python3)" \
  yarn inspect-as-specified-one-task-qualify
```

Optional:

- `COLOPHON_INSPECT_AS_SPECIFIED_WORKSPACE` — default
  `/tmp/colophon-inspect-as-specified-one-task`
- `JINN_INSPECT_PYTHON` — accepted if `COLOPHON_INSPECT_PYTHON` is unset

The workspace path must not already be a Colophon workspace.

## 4. Manual CLI (same path the script drives)

```bash
WS=/tmp/colophon-inspect-as-specified-one-task
PYTHON="$(command -v python3)"
cat > "$WS/selection.json" <<EOF
{
  "pythonPath": "$PYTHON",
  "projectDir": "$PROJECT",
  "taskReference": "hermetic_eval.py@hermetic_eval",
  "coverage": "one_task",
  "arms": [
    { "armId": "control", "model": "mockllm/model" },
    { "armId": "candidate", "model": "mockllm/model" }
  ],
  "scorer": { "name": "match", "passValue": "C" }
}
EOF

node "$COLOPHON" init --workspace "$WS" --principal operator
node "$COLOPHON" draft create --workspace "$WS" --principal operator \
  --name "Inspect-as-specified one_task" --id inspect-one
node "$COLOPHON" runtime inspect-as-specified select --workspace "$WS" \
  --principal operator --draft inspect-one --file "$WS/selection.json" --json
node "$COLOPHON" quote --workspace "$WS" --principal operator --draft inspect-one --json
node "$COLOPHON" lock --workspace "$WS" --principal operator --draft inspect-one
node "$COLOPHON" launch --workspace "$WS" --principal operator --draft inspect-one
node "$COLOPHON" collect --workspace "$WS" --principal operator --draft inspect-one --json
node "$COLOPHON" runtime inspect-as-specified export --workspace "$WS" \
  --principal operator --draft inspect-one --arm control --json
node "$COLOPHON" report --workspace "$WS" --principal operator --draft inspect-one --json
```

Expect two judged cells (1 sample × 2 arms × 1 replicate). mockllm is local
and usually finishes in seconds.

## 5. Receipt checklist

After collect / View export, write down (do not invent Hub placement):

- Inspect version `0.3.255` from the sealed selection
- Catalog sample ids `alpha`, `bravo`; selected `alpha`
- Quote bits: conforming, `one_task`, not leaderboard-ready; cell count
  `1 × 2 × 1`
- Worker input still `epochs: 1`; suite `replicates` equals specified epochs
- View export mode `inspection-upload`; instructions include the Inspect Hub
  closed sentence
- Report `limitations[]` carries the canonical Inspect-as-specified
  not-as-specified-complete sentence
- Cousin `runtime inspect select` was not used

Useful paths under `$WS`:

- Sealed Inspect-as-specified selection in the workspace sealed-bytes store
- View export: `artifacts/inspect/view-bundle/inspect-one/<armId>/`

Do not run Inspect Hub upload. Do not treat the View bundle as the claim of
record.

The qualify script writes
`$WS/inspect-as-specified-one-task-qualify-receipt.json`.
