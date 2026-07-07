# Spike: driving jinn-agent headlessly for the capability-eval v0 rig

- **Date:** 2026-07-07
- **Shape:** `spike` (output is a finding; no code merges)
- **Author:** Jinn contributor
- **Question:** Can we drive the jinn-agent fork headlessly to solve ONE SWE-rebench-V2 instance in
  **both arms** (A = empty skill loadout, B = one skill pre-installed) and capture
  **provider-actual per-solve token counts** for each? Grading a jinn-agent patch is a stretch goal.

## Verdict: GO

All four acceptance criteria PASS (including the stretch grading goal). The load-bearing integration
seams for Plan 2 (headless invocation, arm differentiation, per-solve token capture, upstream grading)
are all proven on one real task. Approx budget spent: **~$0.056** (2 solves + 2 pre-existing smoke
sessions; arm A $0.0225, arm B $0.0338, estimated by the agent's own cost model).

| Acceptance criterion            | Result | Evidence |
|---------------------------------|--------|----------|
| Headless solve                  | PASS   | Both arms ran `jinn-agent chat -q … -Q --yolo`, edited source, exited rc=0 |
| Arms distinct (A vs B)          | PASS   | Sole differing input = one preloaded skill; +117k input tokens, +5 tool calls, extra file touched in B |
| Per-solve token capture         | PASS   | `sessions export --session-id … -` → clean `input_tokens`/`output_tokens`/`cache_*`/`reasoning_tokens`/`estimated_cost_usd` per session |
| Grading (stretch)               | PASS   | Upstream `scripts/eval.py` graded a jinn-agent patch end-to-end; golden control PASS (11/11), arm-A patch FAIL with a legible root cause |

---

## Environment (confirmed, don't rediscover)

- Binary: `/Users/adrianobradley/.local/bin/jinn-agent` → Hermes Agent **v0.18.0**, model
  `deepseek/deepseek-v4-flash` via OpenRouter (key in `~/.jinn-agent/.env`).
- Session store: SQLite, `jinn-agent sessions {list,export,stats}`. Export is one JSON object per line.
- Dataset: `ibragim-bad/SWE-rebench-V2-sample`, config `default`, split `train` (20 rows), pulled via the
  HF datasets-server `/rows` endpoint (same path as `client/.../swe-rebench-v2-evaluator/hf-fetcher.ts`).
- Upstream grader: `~/.jinn-client/SWE-rebench-V2-upstream/scripts/eval.py`. Docker 28.5.1, ~45 GB free.

## Chosen instance

`pilosus__pip-license-checker-119` — repo `pilosus/pip-license-checker`,
base_commit `22d2f959e31e0d967ec4c19dc312f46e49e0e112`. Picked because it is the smallest/cheapest
gradeable row in the sample: `easy`, 260-char problem statement, 836 KB / 40-file repo, 11 FAIL_TO_PASS.
**Language is Clojure** (the `pip-license-checker` name is misleading — tests are `lein test`). That is
fine for the spike (the four seams are language-agnostic), and it exposed a useful grading nuance (below).

Problem statement (verbatim): *"GitHub API versioning … we may need to pin the version with a request header"*.

---

## Criterion 1 — Headless solve: PASS

### Exact working command (arm A / control)

Run from **inside a clean checkout of the target repo at base_commit** so the produced patch is just `git diff`:

```bash
# one clean copy per arm from a base checkout at base_commit
cp -R repo-base armA && cd armA
PROMPT="$(cat prompt.txt)"   # = instruction wrapper + the row's problem_statement
jinn-agent chat -q "$PROMPT" -Q --yolo --ignore-rules --pass-session-id --max-turns 20
# → stderr line: "session_id: 20260707_103508_da8b11"
git diff > armA.patch        # recover the patch
```

Flag semantics (all confirmed against `jinn-agent chat --help`):

- `-q QUERY` — single non-interactive query (no REPL).
- `-Q` — quiet: suppress banner/spinner/tool previews; emit only the final reply + session info.
- `--yolo` — bypass dangerous-command approval prompts (required for unattended file edits).
- `--ignore-rules` — skip auto-injection of AGENTS.md / SOUL.md / memory / preloaded skills. **This is
  what makes arm A a clean empty loadout.** (Without it, the agent injects the operator's memory and any
  cwd AGENTS.md, which would confound the A/B comparison.)
- `--pass-session-id` — include the session id in the run so it is recoverable; it is also printed to
  stderr as `session_id: <id>`, and `sessions list` shows the newest sessions.
- `--max-turns N` — cap tool-calling iterations (cost bound). 20 was ample; arm A used 17 tool calls.

The agent produced a correct-in-spirit source edit to `src/pip_license_checker/github.clj` (added the
`X-GitHub-Api-Version: 2022-11-28` header to `get-headers`) and exited rc=0 in ~2.5 min.

**Gotchas found:**
- `timeout`/`gtimeout` is not installed on this macOS host — use `--max-turns` for the cost bound rather
  than a shell timeout wrapper.
- At process exit the agent prints a harmless `RuntimeError: Event loop is closed` asyncio teardown
  traceback on stderr. rc is still 0; ignore it.
- The agent's own "⚠️ File-mutation verifier: 1 file(s) were NOT modified" footer refers only to a temp
  *verification script* it was refused permission to write under `/var/folders/...` — **not** the source
  edit. Always confirm the real patch with `git diff`, not the agent's prose.

## Criterion 2 — Arms distinct: PASS

Arm B is identical to arm A **plus one preloaded skill**, isolating the loadout as the sole variable:

```bash
cp -R repo-base armB && cd armB
jinn-agent chat -q "$PROMPT" -Q --yolo --ignore-rules -s systematic-debugging --pass-session-id --max-turns 20
# → session_id: 20260707_103811_d893e4
```

- **Skill mechanism = `-s SKILLS`** (repeatable / comma-separable). `systematic-debugging` is a builtin
  skill (72 builtins ship; `jinn-agent skills list`), on disk at
  `~/.hermes/skills/software-development/systematic-debugging/SKILL.md` (**10,480 bytes ≈ 2.6k tokens**).
  Preloading a builtin needs **no** network fetch. (Note: `jinn-agent skills inspect <name>` resolves
  against the *remote* registry and shows community forks — don't use it to size the local builtin; read
  the on-disk SKILL.md instead. `prompt-size` does **not** accept `-s`, so the loadout delta can't be
  measured offline; the real proof is the per-session token delta below.)

### Distinctness evidence (from the two session exports)

| Metric              | Arm A (empty) | Arm B (+skill) | Δ (B−A) |
|---------------------|--------------:|---------------:|--------:|
| input_tokens        | 186,114       | 303,347        | +117,233 |
| output_tokens       | 6,207         | 5,992          | −215 |
| cache_read_tokens   | 258,944       | 302,464        | +43,520 |
| reasoning_tokens    | 1,675         | 1,836          | +161 |
| api_call_count      | 18            | 20             | +2 |
| tool_call_count     | 17            | 22             | +5 |
| est_cost_usd        | 0.02253       | 0.03382        | +0.01130 |
| files touched       | `github.clj`  | `github.clj` **+ `github_test.clj`** | — |

The +117k input-token jump is far larger than the ~2.6k skill text alone: the `systematic-debugging`
loadout also changed the agent's *behavior* (more investigation turns, and it proactively updated the
test file to match the new behavior). Arms are unambiguously distinct in both footprint and output.

## Criterion 3 — Per-solve token capture: PASS (the load-bearing path)

`jinn-agent sessions export --session-id <ID> -` emits one JSON object with **exactly** the per-solve
provider-actual counts Plan 2 needs. Recover the id from the `session_id:` stderr line (or
`sessions list`), then:

```bash
jinn-agent sessions export --session-id 20260707_103508_da8b11 - \
  | python3 -c 'import json,sys; o=json.loads(sys.stdin.readline()); \
      print({k:o[k] for k in ("input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","reasoning_tokens","estimated_cost_usd","cwd")})'
```

Relevant fields on the exported object (verified present and populated):

`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`,
`api_call_count`, `tool_call_count`, `message_count`, `estimated_cost_usd`, `actual_cost_usd`
(null here — `cost_status: "estimated"`, `cost_source: "provider_models_api"`), `model`, and **`cwd`**
(ties the session to its arm dir unambiguously — the belt-and-suspenders session→arm mapping for the rig).

Caveat for Plan 2: `actual_cost_usd` was null and cost is `estimated` (from the provider models-pricing
API, not a settled OpenRouter invoice). Token *counts* are provider-actual; the USD figure is a modeled
estimate. If Plan 2 needs settled cost, reconcile against OpenRouter's usage API separately — but token
counts alone are sufficient for a per-solve efficiency metric.

## Criterion 4 — Grading (stretch): PASS

The upstream harness scores a jinn-agent-produced patch end-to-end. Mechanism: `eval.py` takes a task
JSON (`--json`), applies the model patch (via `--patches`, **a JSON list of `{instance_id, patch}`**) plus
the row's hidden `test_patch`, runs `install_config.test_cmd` (`lein test`) inside the instance Docker
image, parses the log, and checks FAIL_TO_PASS.

```bash
# image pulls in ~1 min, 3.8 GB
docker pull docker.io/swerebenchv2/pilosus-pip-license-checker:119-22d2f95

# grade arm A's patch (patches file MUST be a list, not a dict)
python3 scripts/eval.py --json task.json --patches armA.patches.json \
  --max-workers 1 --report-json armA.report.json

# golden control (proves harness + image are sound)
python3 scripts/eval.py --json task.json --golden-eval \
  --max-workers 1 --report-json golden.report.json
```

Results:

- **Golden control → PASS**: `all_ok: true`, `passed_match: true`, 11/11 FAIL_TO_PASS, exit 0. Harness,
  image, and task JSON are sound.
- **Arm A patch → FAIL** (correctly): both patches applied cleanly, but `lein test` hit
  `Syntax error compiling … No such var: g/header-github-api-version`. The hidden gold test asserts against
  a **named public var** `header-github-api-version` that the *gold source patch* defines
  (`(def header-github-api-version {"X-GitHub-API-Version" "2022-11-28"})`). Arm A (and arm B) inlined the
  literal string instead of defining that var, so the gold test can't compile. This is a legitimate,
  legible benchmark outcome — the task's hidden test is coupled to a specific named-constant interface —
  **not** a harness bug. The point of the stretch goal ("does the grader score a jinn-agent patch?") is
  proven: it does, and it returns a correct verdict with a diagnosable reason.

Grading gotchas:
- `--patches` root must be a **list** of `{instance_id, patch}` objects (a dict errors
  `"Patches JSON root must be a list."`).
- The image is `linux/amd64`; on Apple Silicon Docker runs it under emulation (a benign platform-mismatch
  warning). A full solve still completed in seconds; no ARM-native image needed for this instance.
- The task JSON must carry `instance_id, repo, base_commit, image_name, patch, test_patch, install_config,
  FAIL_TO_PASS, PASS_TO_PASS` — all available on the HF row.

---

## Implications for Plan 2 (the orchestration layer)

**GO.** Every seam the rig depends on is proven with concrete commands:

1. **Headless invocation** is a single `jinn-agent chat -q … -Q --yolo --ignore-rules --pass-session-id
   --max-turns N` per solve, run inside a per-solve clean repo copy; patch = `git diff`.
2. **Arm A/B differentiation** is `-s <skill>` layered on the identical arm-A command. `--ignore-rules`
   is essential to keep the empty arm actually empty (no memory/AGENTS.md leakage).
3. **Per-solve token capture** is `sessions export --session-id <id> -`, giving provider-actual
   input/output/cache/reasoning tokens keyed by `cwd`. This is clean and scriptable — no log scraping.
4. **Grading** reuses the upstream `eval.py` verbatim with a `{instance_id, patch}` list; Docker images
   pull on demand (~3.8 GB each).

Build recommendations / watch-items for Plan 2:
- Bound each solve with `--max-turns`, not a shell `timeout` (not installed here). No retry-on-failure in
  the loop — a failed solve is a datapoint, not a thing to re-burn.
- Map session→solve via `--pass-session-id` **and** the export's `cwd` field (redundant, robust).
- Treat `estimated_cost_usd` as modeled, not settled; use token counts as the primary efficiency metric.
- Expect real per-instance disk/pull cost for grading (3.8 GB image here). Keep the disk floor honored
  (`JINN_EVAL_DISK_FLOOR_GB`) if grading many instances; prune images between rounds.
- The FAIL here is a reminder that SWE-rebench hidden tests can couple to exact interface names. That is a
  property of the benchmark, not a rig defect — the rig just needs to record PASS/FAIL faithfully, which
  it can.

## Artifacts (scratchpad — not committed)

Under the session scratchpad: `instance.json`, `prompt.txt`, `armA.patch`, `armB.patch`,
`armA.session.json`, `armB.session.json`, `task.json`, `armA.patches.json`, `armA.report.json`,
`golden.report.json`, and the two grade logs. The two solve sessions persist in the jinn-agent SQLite
store as `20260707_103508_da8b11` (arm A) and `20260707_103811_d893e4` (arm B).
