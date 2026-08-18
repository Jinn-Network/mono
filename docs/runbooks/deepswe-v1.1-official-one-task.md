# Qualify DeepSWE v1.1 `one_task` on the git pin

Operator-only campaign. Success is protocol identity, not a Datacurve
leaderboard score. Default CI and `yarn test` never clone the 113-task tree
and never invoke real Pier.

Issue: [#2771](https://github.com/Jinn-Network/mono/issues/2771). Decision:
[DR-2026-08-18](../../log/decisions/2026-08-18-deep-swe-v1.1-official-suite.md).

## What this proves

A human operator, on a machine with Pier 0.3.1.x and Docker (or Modal),
drives the **built Colophon CLI** (core `dist/cli/bin.js`) through select →
quote → lock → launch → collect → `deepswe export` against:

- Dataset git commit `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`
  (`DEEP_SWE_V11_GIT_SHA`)
- `tasks/` tree SHA `66df25a1b382017d0ae014d94cadb2698baaed48`
  (`DEEP_SWE_V11_TASKS_TREE_SHA`) — select recomputes the git tree SHA over the
  material you supply and seals what it computed. A one-task subtree seals its
  own SHA, which is not the official pin, so this campaign can never be
  leaderboard-ready. That is the intended result, not a defect.
- Coverage `one_task` = lexicographic first task directory name from **that
  pinned tree**, not a random `--n-tasks 10` sample
- Real Pier `0.3.1.x`, adapter id `pier`, agent `mini-swe-agent` only
- Planned k = 4

Quote and collect must show `executionConformance: true`, `coverage:
"one_task"`, `leaderboardSubmitReady: false`. Export mode is `inspection`.
Email to `serena@datacurve.ai` is not a Colophon action. Do not run Hub
`lb submit`.

## Out of scope

- Full 113-task / `ten_task` / `leaderboard_submit_ready`
- Harbor 0.21 on these tasks; Pier + Claude Code / Codex / gemini-cli / opencode
- DeepSWE v1 (shared verifier env)
- Wiring this into CI or cloning the 113-task corpus in GitHub Actions
- Placing a Datacurve leaderboard row

## 1. Pier 0.3.1.x

```bash
# install datacurve-pier 0.3.1.x on the operator host
pier --version   # must print 0.3.1 or 0.3.1.x
command -v pier  # keep this realpath for selection.json
```

## 2. One task package only

Check out **git commit** `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9` of
`datacurve-ai/deep-swe`. Copy **only the lexicographic first** `tasks/<name>/`
directory (the directory that contains `task.toml`) into an operator path.
Do not point Colophon at the full 113-task tree. Do not use `@latest`.

Confirm the tree SHA of upstream `tasks/` at that commit still equals
`66df25a1b382017d0ae014d94cadb2698baaed48` before treating the pin as live.

The `runtime deep-swe-v1.1 select --file` payload takes an optional
`expectedTasksTreeSha`: the git tree SHA of the directory you are handing
Colophon (`git write-tree` over those bytes). Select refuses when the material
does not hash to what you declared. Leave it unset and select still recomputes
and seals the real SHA; declaring it only turns a silent drift into a refusal.
`full` coverage is separately refused unless the material is the whole 113-task
tree at the official pin.

## 3. Digest pin (operator Docker, never inside select)

Read `docker_image` from that task's `task.toml`. Pull and inspect **before**
select; select itself never talks to Docker. Put `repo@sha256:…` in
`selection.json` `environment.image`.

## 4. Built CLI and workspace

Workspace lives **outside** the repo (for example
`/tmp/colophon-deepswe-one-task`). Compile still requires ≥2 arms. Two Pier
AgentConfigs that both use `mini-swe-agent` with distinct `model_name`
values. `nConcurrent: 1`. Official env: `environment.configuration: {}`.
Retry policy comes from DeepSWE v1.1 select (`nAttempts: 4`, `maxRetries: 3`).
Wall-clock bound is 9000s per trial.

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON="$PWD/dist/cli/bin.js"
WS=/tmp/colophon-deepswe-one-task
mkdir -p "$WS"
```

Fail-closed driver (never downloads the corpus):

```bash
COLOPHON_DEEPSWE_ONE_TASK_QUALIFY=1 \
  COLOPHON_DEEPSWE_PIER=/absolute/path/to/pier \
  COLOPHON_DEEPSWE_TASK_MATERIAL=/absolute/path/to/one-task-parent \
  COLOPHON_DEEPSWE_IMAGE='repo@sha256:…' \
  COLOPHON_DEEPSWE_MODEL=your/model-id \
  yarn deepswe-v1.1-one-task-qualify
```

`COLOPHON_DEEPSWE_TASK_MATERIAL` is the parent directory that contains
`<lexFirstTask>/task.toml`. The script never clones `datacurve-ai/deep-swe`.
Without `COLOPHON_DEEPSWE_ONE_TASK_QUALIFY=1` it exits 2.

## Success

- Quote: `executionConformance: true`, `coverage: "one_task"`,
  `leaderboardSubmitReady: false`, `replicates: 4`, Pier version `0.3.1.x`
- Two planned Pier jobs, `n_attempts: 4`, `max_retries: 3`, agent
  `mini-swe-agent`
- `deepswe export` mode `inspection`; instructions name Datacurve email and
  refuse Hub `lb submit`
- Receipt written next to the workspace
