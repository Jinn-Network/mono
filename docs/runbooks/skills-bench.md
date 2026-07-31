# Runbook — skills-bench (Skills Factory MVP)

**Spec:** `docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md` (v0.2 — capability-report
product, measurement method, per-skill pilot flow, publishing surface). Read §1–§4 before running a
pilot skill end to end — this runbook gives exact commands, the spec gives the reasoning behind them.

**Audience:** the operator running the skills-bench rig for one pilot skill at a time: pin the
skill, author a domain-matched task set for it, validate and screen that task set, run the paired
measurement on Haiku, render the public report, deliver the private annex, and — if the author
revises — re-evaluate. All commands below are run from `client/` unless noted otherwise.

**v0.1 wave flow retired, not deleted.** Through 2026-07-30 this runbook described a wave-1
(benchmark five incumbents) / wave-2 (fork and improve the winner) flow. The spec's v0.2 revision
note drops that model: Jinn does not fork skills and publishes no installable catalog — see the
spec header for why (SWE-Skills-Bench already measured 49 skills at a scale a from-scratch wave 1
could not match, and the author-first pivot). §2–§9 below are the per-skill pilot flow that
replaces it. §10 keeps the swe-rebench-v2 slate machinery this runbook used to build wave 1 around,
condensed: it survives as the screening/holdout substrate for general coding-workflow skills that
don't warrant a bespoke task set, not as the primary or only measurement path.

**Scope:** §2–§9 (per-skill pilot flow), §10 (generic-slate substrate, condensed), §11 (pilot-prep
facts), §12 (troubleshooting). Everything from §6 onward (any real, non-`--dry-run` `run-bench.ts`
invocation) is real-money, real-Docker.

---

## 1. Prerequisites

- **Host:** Linux amd64, ≥100 GB free disk. This is a big-disk-host operation, never a laptop —
  each grade spins up a Docker image per task and the pinned repo images can be large.
- **Docker** running and reachable (`docker info` succeeds).
- **Node 22** with `corepack enable` run once (pins Yarn to the `packageManager` field).
- **An isolated `CLAUDE_CONFIG_DIR` with usable claude-code credentials — measured, not optional.**
  `run-bench.ts` spawns real `claude` subprocesses under `--claude-config-dir` (default
  `<repoRoot>/bench/.claude-bench-config`, stable and reusable across `--out` dirs — log into it
  once, not once per run). Isolation is required: without it, the operator's own ambient
  user-level skills/plugins/memory leak into every arm — including the baseline arm's "no skill
  installed" claim — and the report stops being reproducible off this operator's machine (measured
  empirically; see §12's skill-visibility matrix). One consequence measured on macOS: an isolated
  `CLAUDE_CONFIG_DIR` severs Keychain-backed auth (`claude-code` on macOS stores credentials in the
  Keychain, service "Claude Code-credentials", not in a `~/.claude/.credentials.json` file), so the
  isolated dir starts with no usable credentials until you supply them via one of:
  1. `export ANTHROPIC_API_KEY=...` — metered API billing; works headless, the route for the Linux
     pilot host.
  2. One-time interactive login into the bench config dir:
     `CLAUDE_CONFIG_DIR=<resolved --claude-config-dir path> claude`, then `/login` — keeps
     subscription billing, credentials then persist in that dir across runs.

  `run-bench.ts` runs a cheap auth preflight probe before any real (non-`--dry-run`) solve work and
  aborts the whole run with both remediation routes spelled out if the probe fails — see §12 "Not
  logged in / every solve fails instantly".
- **`JINN_EVAL_DISK_FLOOR_GB=40`** in the environment before any real (non-`--dry-run`) run. The
  grader reads this env var directly (no CLI flag) and prunes Docker / aborts the run cleanly if
  free disk falls below the floor — see §12 Troubleshooting. Both grade paths (the swe-rebench-v2
  `PythonEvalRunner` and the authored-task-set `custom-grade.ts`) share this same disk-floor
  plumbing.
- **swe-rebench upstream eval repo checked out — §10 (generic slate) only.** The `--slate` grade
  path needs `SWE-rebench/SWE-rebench-V2` on disk; point scripts at it with `--upstream-repo-dir
  <path>` (default `~/.jinn-client/SWE-rebench-V2-upstream`). If you've already run
  `jinn harnesses enable swe-rebench-v2-evaluator` on this host, that clone already exists at
  `<engine.implStateDirRoot>/swe-rebench-v2-evaluator/upstream/` — pass that path instead of
  re-cloning. An authored task set (§3–§9) needs no upstream repo — each task's own `image` already
  carries (or can `git clone` on demand) its pinned `repo`@`commit`.

Every command below assumes `cd client` first, and that `../bench/` resolves to the repo-root
`bench/` directory (i.e. you are running from `client/`, not from the repo root).

---

## 2. Pin the skill

One `pin-skill.ts` invocation for the pilot-cohort skill you're about to measure (see §11 for the
cohort):

```bash
cd client
yarn tsx scripts/skills-bench/pin-skill.ts \
  --name tdd \
  --source https://github.com/mattpocock/skills \
  --commit <resolved-sha> \
  --skill-path skills/tdd
```

Resolve `--commit` to the repo's HEAD sha on pin day and record the resolved sha in the pin commit
message (the script re-resolves and hard-fails if a 40-hex `--commit` doesn't match what it checks
out, but a branch name or short ref should still be pinned to the exact sha you saw).

The invocation writes `../bench/skills-under-test/<name>/` (default `--dest`; override with
`--dest <path>` only if you need a different destination) containing the vendored `SKILL.md` tree
plus a `pin.json` (`name`, `source`, `commit`, `skillPath`, `sha256` over the vendored bytes,
`license` parsed from the SKILL.md frontmatter, `repoLicense` detected from a repo-root
LICENSE/LICENSE.md/LICENSE.txt/COPYING file when one exists, `fetchedAt`). The command prints the
same JSON to stdout — capture it in the pin commit message alongside the resolved sha.

**License gate.** `license` (frontmatter-only) is the primary signal; `repoLicense` is a repo-level
fallback — a crude label (first non-empty line of whichever license file was found), never parsed
or validated, and never written into `license`. This gate matters less under the v0.2 model than it
did for a fork (Jinn never forks the skill — §1.1 of the spec), but still record it: a null
`license` (no `license:` key in the upstream frontmatter) means the report's embed snippet points
back at a skill whose redistribution terms for its own content are unclear, which is worth a
one-line note in the report, not a blocker to measuring it.

A re-evaluation (§9) re-pins the revised commit the same way, under the same `--name` (the vendored
`pin.json`'s `sha256` changes; the lineage identity for the reeval-guard ledger, §9, is the skill
`--name`, unaffected by the re-pin).

---

## 3. Author the task set

Build a `SkillTaskSetV1` (`client/src/skills-bench/task-set.ts`) for the skill — a domain-matched
task set, not a draw from the generic swe-rebench pool (spec §2.2). Human-plus-agent work: author
roughly twenty candidate tasks per skill, expecting the discrimination gate (§5) to keep roughly a
dozen.

**On-disk layout**, one directory per skill under `../bench/task-sets/<skill>/`:

```
../bench/task-sets/<skill>/
  set.json
  verifiers/
    <task-id>_test.py       # one or more pytest verifier files per task
  patches/
    <task-id>.patch         # one known-good reference patch per task
```

`set.json` shape (`SkillTaskSetV1`):

```json
{
  "version": "skill-task-set.v1",
  "skill": "tdd",
  "domain": "python",
  "tasks": [
    {
      "id": "fix-widget-0001",
      "repo": "org/widget-repo",
      "commit": "<40-hex sha>",
      "image": "org/widget-task:0001",
      "requirement": {
        "background": "...",
        "requirement": "...",
        "fileOps": "...",
        "acceptance": "..."
      },
      "verifierFiles": ["verifiers/fix-widget-0001_test.py"],
      "referencePatchFile": "patches/fix-widget-0001.patch",
      "timeoutMs": 600000
    }
  ],
  "sha256": "<computed — see below>"
}
```

Per task:

- **`repo`/`commit`/`image`** — a pinned repository, an exact commit, and a Docker image
  `custom-grade.ts` can start (it reconciles `/workspace` to `repo`@`commit` via `git fetch`/
  `checkout` if the image already bakes a checkout, or `git clone`s fresh if it doesn't — either
  way the image must be able to reach `repo` over the network at grade time).
- **`requirement`** — the four-part document spec §2.2 requires: `background`, `requirement`,
  `fileOps`, `acceptance`. All four are mandatory (`validateTaskSet` refuses a task missing any
  part). **Never name the skill under test** (or the arm name it will be mounted under) in any of
  the four parts — `validateTaskSet` and, separately, `run-bench.ts`'s `assertNoArmNameLeak` both
  fail loud on a leak, case-insensitively. An agent told "use test-driven development" in its task
  prompt is not measuring whether `tdd` helps; it is measuring whether an instruction helps.
- **`verifierFiles`** — one or more pytest files, paths relative to the task-set directory. A task
  with zero verifier files is refused (`validateTaskSet`) — it can never grade.
- **`referencePatchFile`** — a known-good fix, path relative to the task-set directory. This is
  what the gradeability gate (§4) applies to prove the verifiers actually discriminate pass/fail.
- **`timeoutMs`** (optional) — per-task grade wall-clock cap; falls back to the CLI's
  `--grade-timeout-ms` / `custom-grade.ts`'s 10-minute default otherwise.

**Computing `sha256`.** `hashTaskSet` (task-set.ts) hashes set membership plus every requirement,
verifier file, and reference-patch file's bytes; `loadTaskSet` refuses to load a `set.json` whose
declared `sha256` doesn't match a fresh recomputation. There is no dedicated CLI for this yet
(task authoring is manual/agent work, not a shipped pipeline step) — compute and write it with a
short throwaway script:

```bash
cd client
cat > scripts/skills-bench/.tmp-hash-task-set.mjs <<'EOF'
import { hashTaskSet } from '../../src/skills-bench/task-set.js';
import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const set = JSON.parse(await readFile(`${dir}/set.json`, 'utf8'));
set.sha256 = await hashTaskSet(dir, set);
await writeFile(`${dir}/set.json`, `${JSON.stringify(set, null, 2)}\n`);
console.log(`sha256=${set.sha256}`);
EOF
yarn tsx scripts/skills-bench/.tmp-hash-task-set.mjs ../bench/task-sets/<skill>
rm scripts/skills-bench/.tmp-hash-task-set.mjs
```

Re-run this any time you edit a task's requirement text, a verifier file, or a reference patch —
`gradeability`/`screening` receipts (§4/§5) are deliberately excluded from the hash (they're derived
receipts, written after authoring), so re-validating or re-screening never changes `sha256`, but
editing the authored content always does.

---

## 4. Gradeability gate

Zero-inference, mandatory, before any solve spend (spec §2.3). For every task (or one, with
`--task`), `validate-task-set.ts` grades the known-good reference patch (must pass) and an empty
patch (must fail, as a graded failure, never an error) through the real Docker grade path —
Docker time only, no inference:

```bash
cd client
yarn tsx scripts/skills-bench/validate-task-set.ts --task-set ../bench/task-sets/tdd
# or one task at a time while authoring:
yarn tsx scripts/skills-bench/validate-task-set.ts --task-set ../bench/task-sets/tdd --task fix-widget-0001
```

A passing task gets a `gradeability` receipt written into `set.json` (`status: 'pass'`,
`checkedAt`, `referenceMs`, `emptyMs`, `gradeLogDigest`); a failing task has its (possibly stale)
receipt cleared. Exit code is non-zero if any task in the set lacks a passing receipt after the run
— including tasks this invocation didn't touch. `run-bench.ts --task-set` refuses the whole set
(`assertTaskSetGradeable`) without every task carrying a passing receipt — this script is the only
way to earn one.

**The zarr lesson, generalized.** A verifier that grades fine in isolation can still fail to grade a
real attempt (`conftest_import_error` and friends) — this gate is the direct fix: prove both
directions actually reach a verdict before spending a single paid solve on the task.

---

## 5. Discrimination screen

A task every configuration solves, or none solves, measures nothing (spec §2.4 — the step
SWE-Skills-Bench's own construction skipped). `screen-task-set.ts` runs a baseline-only (no skill)
sweep over every gradeability-passing task, Haiku, `--repeats` times, and keeps only the tasks the
baseline fails outright or passes only marginally:

```bash
cd client
yarn tsx scripts/skills-bench/screen-task-set.ts \
  --task-set ../bench/task-sets/tdd \
  --model claude-haiku-4-5-20251001
```

`--repeats` defaults to `2`, `--pass-threshold` to `1` (keep unless the baseline passed *every*
repeat — spec §2.4's literal rule; tighten to e.g. `0.5` to also drop tasks the baseline mostly-but-
not-always solves). `--out` defaults to `<task-set>/.screening-run` (a real, non-dry-run
`run-bench.ts` subprocess this script drives internally with a synthesized
`[{ name: 'baseline', skillDir: null }]` arms file and `--include-screened-out`, so a re-screen
always covers every gradeability-passing task regardless of any prior screening receipts already on
disk).

This writes per-task `screening` receipts (`baselinePasses`, `attempts`, `keep`, `screenedAt`,
`model`) plus a set-level `screeningSummary` (`kept`, `droppedNoHeadroom`, `droppedUngradeable`)
back into `set.json` — membership never changes, a dropped task stays in the file with
`keep: false`, so the screen is auditable, not asserted. `droppedUngradeable` is worth reading: a
task that passed the zero-inference gradeability gate (§4) but produced an ungradeable outcome on a
real baseline attempt is a latent verifier bug, not a screening decision.

A task set with no screening receipts at all is not hard-blocked by `run-bench.ts` (§6) — it logs a
warning and runs unscreened — but skipping this step means an uninterpretable result per spec §2.4;
run it before every measured pass.

---

## 6. Paired measurement

Run the paired comparison on the pinned Haiku profile (spec §2.6), screened tasks only:

```bash
cd client
yarn tsx scripts/skills-bench/run-bench.ts \
  --task-set ../bench/task-sets/tdd \
  --arms ../bench/arms/tdd.json \
  --model claude-haiku-4-5-20251001 \
  --out ../bench/runs/tdd-pilot
```

`../bench/arms/tdd.json` is a two-entry array — baseline plus the one skill under test:

```json
[
  { "name": "baseline", "skillDir": null },
  { "name": "tdd", "skillDir": "../bench/skills-under-test/tdd" }
]
```

Before any real solve work, `run-bench.ts --task-set` refuses loud (dry-run included) if any task
lacks a passing gradeability receipt (§4) or if any non-baseline arm name leaks into a task's
requirement text (`assertNoArmNameLeak` — the arm-name check is distinct from, and in addition to,
`validateTaskSet`'s own `set.skill` check). It then applies the discrimination gate (§5): only
`screening.keep === true` tasks run, unless the set has no screening receipts (warning, runs
unscreened) or `--include-screened-out` is passed (loud warning, not recommended — spec §2.4). The
manifest binds which decision applied (`screeningRespected`, `eligibleTaskIds`), so a screened run
and an `--include-screened-out` run can never silently collide in the same `--out` dir.

Every solve's session JSONL is copied next to its transcript as `<attemptKey>.session.jsonl` —
this is the raw material the trigger-rate parser (`trigger.ts`) reads to detect whether the mounted
skill actually loaded, never from asking the model. A missing/unresolvable session file is a loud
warning, never fatal, and renders later as an *unknown* trigger status, never as "not triggered."

Same resumability, auth-preflight, and manifest-guard posture as the generic-slate path (§10):
`--dry-run` synthesizes fake outcomes and touches nothing real; a real run aborts loud before any
solve if the isolated `--claude-config-dir` has no usable credentials; a rerun of the identical
command skips every attempt key already logged in `attempts.jsonl`; a changed slate/model/arms/
task-set under an existing `--out` throws (`assertManifestCompatible`) rather than silently
resuming a different configuration. `--half` and `--candidate-id`/the holdout ledger are `--slate`-
only concepts (§10) and are ignored for `--task-set` runs (the manifest's `half` field is fixed to
`'feedback'` so the field stays populated without implying a real feedback/holdout split).

**Budget note** (spec §3.3): roughly $10–25 of Haiku inference for the full paired run (baseline
plus skill, about a dozen screened tasks). Docker/grading time, not inference, is the actual
bottleneck — §4's gate is zero-inference precisely so cost falls on compute time before any real
spend, not on solves that later turn out to have graded nothing.

---

## 7. Render + review

```bash
cd client
yarn tsx scripts/skills-bench/render-report.ts \
  --run ../bench/runs/tdd-pilot \
  --task-set ../bench/task-sets/tdd \
  --skill tdd \
  --report-url https://github.com/Jinn-Network/skills-eval/blob/main/reports/tdd@<sha>/report.md \
  --measured-on 2026-08-01
```

`--out` defaults to `<run>/report`; `--agent` defaults to `claude-code`; pass `--skill-source
<owner>/<repo>@<sha>` (the pinned skill's `source`/`commit` from its `pin.json`, §2) to record the
measured bytes on the report's `scope:` line. `--include-transcripts` copies full session
transcripts into `data/` — leave it off by default (transcripts can embed the task repo's own
content) unless you've reviewed them for anything sensitive.

The renderer refuses a dry-run manifest and refuses a `--run`/`--task-set` pair whose sha256s
disagree (both are integrity checks — if either fires, you're pointing at the wrong pair, not
something to work around by editing either file). It writes, into `--out`:

- **`report.md`** — the public capability report: task-set identity, the paired receipt block (N,
  resolve rates, paired delta, Wilson interval), trigger rate, a per-task outcome table, links to
  `data/` and the rerun command.
- **`badge.svg`** — a small self-contained SVG badge.
- **`embed.md`** — the badge image, a link to the report, and the `jinn.*` frontmatter metadata
  block (`buildJinnReceiptMetadata` emits exactly `jinn.receipt`, `jinn.receipt-sha256`,
  `jinn.measured-on` — repointed at the report, not a fork receipt; `jinn.forked-from` is dropped
  entirely, spec §4.1) — this is what the author pastes into their own skill's frontmatter and
  README, not something to hand-assemble. `version` is a separate, ordinary frontmatter key the
  author already owns (see spec §4.1's example block) — it is never generated by this rig.
- **`data/`** — `attempts.jsonl`, `bench-manifest.json`, `set.json` (and `transcripts/` if
  `--include-transcripts`), so the report is reproducible from the repo alone.

**Human review gate — mandatory before §8.** Read the rendered report against the spec's
no-overclaim rules (§1.1, §2.7 "Statistics posture", §7 risk 5): N, resolve rates, paired delta, CI,
and the plain-words caveat must all be present; no claim of significance beyond what the interval
supports. **Trigger-rate reading guidance (spec §2.5, §7 risk 1):** a null result paired with a low
trigger rate must be read and stated as *not exercised on this task set* — a discoverability
problem — never as *no effect*; only report "no effect" against tasks the discrimination gate (§5)
already proved had headroom. Do not proceed to §8 until the report has been read and passes this
check.

---

## 8. Private annex

Manual-first (spec §6: "no LLM-assisted annex authoring in the pilot") — a human reads the failing
transcripts and writes the diagnosis, no automated tooling.

1. **List the working set:**

   ```bash
   cd client
   yarn tsx scripts/skills-bench/list-failing-sessions.ts --run ../bench/runs/tdd-pilot --arm tdd
   ```

   `--arm` selects the treatment arm; omit it and the script infers it when the run has exactly one
   non-baseline arm (refuses to guess otherwise). Lists every treatment-arm attempt that did not
   resolve — `regressed` (baseline passed, treatment didn't — the sharpest diagnosis case),
   `failed` (concordant fail with the baseline, or no paired baseline attempt), or `ungradeable` —
   each with its transcript path, session-JSONL path, and measured `triggered: yes/no/unknown`
   status.

2. **Write the annex** from `docs/templates/skills-eval-annex.md`, reading only the transcripts the
   working set names. Every failing/regressed attempt sorts into exactly one of three failure modes
   (never triggered / triggered but vague / triggered and harmful — spec §2.5, §3.1 step 6); a
   category with no attempts says so plainly rather than being omitted. Suggested edits are
   diff-sized, one per finding, never a rewrite.

3. **Burn the diagnosis tasks for this skill's lineage:**

   ```bash
   cd client
   yarn tsx scripts/skills-bench/record-annex.ts \
     --run ../bench/runs/tdd-pilot --skill tdd --tasks fix-widget-0001,fix-widget-0004
   ```

   List every task id the annex's diagnosis actually reads from (the working set's task ids, or a
   subset if you narrowed it) — these become permanently off-limits for measuring any future
   revision of this skill (§9). `--skill` must name a treatment arm present in the run's
   `bench-manifest.json`; the arm's `skillSha256` is recorded on the ledger entry for audit, but the
   freshness check itself scopes by skill name across every recorded sha, not by this one sha alone
   — see `reeval-guard.ts`'s module doc.

4. **Deliver privately, never publish alongside the report.** The outreach/delivery framing is not
   yet decided (spec §8's open policy question — publish-without-consent vs. private-first window,
   deferred to Ritsu/Oak); `docs/templates/skills-eval-delivery.md` is a reserved stub for that copy,
   not yet written. Until that's resolved, deliver the annex file directly, out of band.

---

## 9. Re-evaluation

If the author revises the skill (spec §3.1 step 7): re-pin the revised commit (§2, same `--name`,
new resolved sha), then measure the revision against task ids that are **not** in §8's burn list —
never the same task-set directory §8 just diagnosed on, unless you've confirmed it holds unburned
tasks (see the practical pattern below).

§8's example burned `fix-widget-0001,fix-widget-0004` for `tdd`'s lineage. A re-eval command that
points `--task-set` back at the same `../bench/task-sets/tdd` directory would try to measure on
those same ids again, and `--reeval-of` throws before any solve work — this is `assertReevalTasksFresh`
(`reeval-guard.ts`) enforcing the boundary, not a suggestion:

```
re-evaluation of 'tdd' would measure on 2 task(s) already burned for this lineage by a prior annex
diagnosis: fix-widget-0001, fix-widget-0004 — a re-evaluation must run on tasks the diagnosis was
never derived from (spec §3.1 step 7). Use a fresh or held-back task set, or pass --force-reeval to
override (loud, not recommended).
```

**There is no `--exclude-tasks` flag.** `run-bench.ts --task-set` always measures every eligible
task in the directory it's pointed at (the discrimination gate, §5, narrows to `screening.keep ===
true`; `--max-instances` only takes a positional prefix of that set) — neither is a per-id exclude,
and editing a task out of `set.json` after the fact changes `sha256` (§3), which breaks the
gradeability/screening receipts already recorded against it. The practical pattern is to **hold back
a reserve at authoring time** (§3): when you screen the ~20 candidates down to the kept dozen, split
the kept set across two task-set directories up front — the one this pilot actually measures
(`../bench/task-sets/tdd`) and a reserve you never touch until a revision needs re-evaluating
(`../bench/task-sets/tdd-reserve`). Because the reserve was never in the measured directory, no id
in it can ever end up in a `record-annex.ts` burn list, so it stays legal for `--reeval-of` by
construction:

```bash
cd client
yarn tsx scripts/skills-bench/run-bench.ts \
  --task-set ../bench/task-sets/tdd-reserve \
  --arms ../bench/arms/tdd.json \
  --model claude-haiku-4-5-20251001 \
  --out ../bench/runs/tdd-pilot-r2 \
  --reeval-of tdd
```

If the reserve is ever exhausted (every held-back task has itself been burned by its own annex),
author a genuinely fresh task set instead (§3) — same command, a new `--task-set` directory.

`--reeval-of <skill>` asserts, before any real solve work (skipped under `--dry-run`, like the
generic-slate path's holdout ledger — §10), that none of this run's eligible task ids were already
burned for `<skill>`'s lineage by a prior annex derivation (`assertReevalTasksFresh`,
`reeval-guard.ts`, ledger at `<repoRoot>/bench/reeval-ledger.json`). Burns are keyed by skill name,
not sha — a task the diagnosis for `tdd@sha1` was derived from stays off-limits for measuring
`tdd@sha2`, `tdd@sha3`, and so on; a normal *first* evaluation of a skill omits `--reeval-of`
entirely, since there's nothing to check yet. A caught overlap throws, listing the offending task
ids (as shown above). `--force-reeval` overrides the check with a loud warning — legitimate only
when you've independently confirmed the overlap is not a genuine information leak (e.g. deliberately
re-running the exact same unrevised task set); it requires `--reeval-of` and is refused otherwise.

**This is an information boundary, not just a ledger entry** — the same caveat the v0.1 holdout
ledger carried (§10): the ledger blocks a second *run* against burned tasks, it cannot un-read a
transcript. Only measure a revision against tasks the annex diagnosis was never derived from.

Render a new report the same way as §7, into a fresh `--out`/report dir — **a new measured sha gets
a new `reports/<skill>@<sha>/` directory, never an overwrite** (spec §4), so a stale badge is
detectable by comparing `jinn.receipt-sha256` against the current report's hash. A revision that
measurably improves earns the badge; a revision that does not is reported honestly, and the offer to
re-run again stands (spec §3.1 step 8).

---

## 10. Generic slate — screening/holdout substrate (condensed)

The swe-rebench-v2 slate (v0.1's original mechanism) is not the primary pilot path — §2–§9 above is
— but it survives as the screening/holdout substrate for general coding-workflow skills that don't
warrant a bespoke authored task set (spec §2.1). Condensed reference, not a deleted capability:

**Zero-inference pre-sweep, mandatory before slate freeze.** The zarr lesson applies here too: an
empty-patch, zero-inference sweep finds ungradeable instances before any solve spend.

```bash
cd client
yarn tsx scripts/skills-bench/sweep-gradeability.ts \
  --slate ../bench/slate/slate.json
```

`--instances id1,id2` scopes to specific instances (default: every slate instance);
`--timeout-ms` (default 3,600,000 = 60 min) and `--upstream-repo-dir` mirror `run-bench.ts`'s own
flags; `--out` defaults to `gradeability-sweep.json` next to the slate. The report is durable/
resumable (rewritten after every instance; a re-run skips instances already classified) and keyed to
the slate's own `sha256` — a re-sweep against a changed slate starts fresh. An ungradeable instance
feeds `build-slate.ts --exclude-instances`/`--exclude-file` below.

**Build/freeze the slate:**

```bash
cd client
yarn tsx scripts/skills-bench/build-slate.ts \
  --seed jinn.skills-bench.v1 \
  --pool-size 60 \
  --out ../bench/slate/slate.json \
  --exclude-instances zarr-developers__zarr-python-2629
```

Sources candidates via the HuggingFace historical-pool path, excludes every active cap-v0 held-out
slate id, applies `--exclude-instances`/`--exclude-file` (recorded in the written slate as
`excluded: [{instance_id, reason}]`, included in the slate hash), dedupes to at most 2 instances per
repo, seed-ranks and takes the first `--pool-size`, then splits into a 15/15 feedback/holdout pair
(`splitSlate`, fixed sizes, not CLI-configurable). **Commit `slate.json` — the commit is the
freeze.** Nothing downstream should run against an uncommitted or subsequently-edited slate;
`render-receipts.ts` refuses to render if the file's `sha256` doesn't match a run's
`bench-manifest.json`.

**Run:**

```bash
cd client
yarn tsx scripts/skills-bench/run-bench.ts \
  --slate ../bench/slate/slate.json \
  --half feedback \
  --arms ../bench/arms/<name>.json \
  --model claude-haiku-4-5-20251001 \
  --out ../bench/runs/<name>
```

`--half feedback|holdout|both` (default `feedback`) selects which slate half to run. `--half
holdout` requires `--candidate-id <id>` and is one-shot per candidate id — a second attempt for the
same id throws (`holdout-guard.ts`'s ledger at `<repoRoot>/bench/holdout-ledger.json`) unless
`--force-holdout-rerun` (legitimate only if the prior run aborted before grading anything). `--half
feedback` never touches this ledger; iterate on the feedback half as many times as budget allows.

**Render:**

```bash
cd client
yarn tsx scripts/skills-bench/render-receipts.ts \
  --run ../bench/runs/<name> \
  --slate ../bench/slate/slate.json \
  --measured-on 2026-08-01 \
  --out ../bench/runs/<name>/receipts \
  --agent claude-code
```

`slateHalf` is read from the run's `bench-manifest.json`, never hand-typed. Pass `--skill-source
<owner>/<repo>@<sha>` for the scope line. Output: one `receipts/<arm>.md` per non-baseline arm plus
`receipts/SUMMARY.md`, generated, never hand-edited. Same human-review gate as §7 applies before any
publication.

**Reports registry (§4 of the spec):** `Jinn-Network/skills-eval` (renamed from v0.1's
`Jinn-Network/skills` — no catalog, only reports). Copy from `bench/skills-repo-template/`:
`reports/<skill>@<sha>/report.md` + `data/`, `rig/`, a generated `README.md` index. No `skills/`
directory, no forked skill code, ever (spec §4).

---

## 11. Pilot-prep facts

Recorded here per the v0.2 plan's execution-gated item (not build scope, reference only):

- **Cohort:** `tdd` and `grill-me` (mattpocock, MIT-licensed, already pinned) anchor the pilot —
  real, leaderboard-ranked coding-workflow skills, both inside the domain the task-authoring
  machinery can measure. A third target is chosen at execution time from **SWE-Skills-Bench's own
  harmful/null list** — deliberately re-measuring a skill the coarse cross-skill study already
  scored zero-effect or actively harmful, on a narrower, better-matched task set (spec §1.4).
- **Cost:** roughly $10–25 of Haiku inference per skill for the full paired run (spec §3.3) — see
  §6's budget note.
- **Host:** Linux amd64 for throughput (see §1) — an aarch64/Apple Silicon host is fine for proving
  the pipeline (§4's gradeability gate, a small `--max-instances`-capped run) but not for a full
  paired measurement at scale; see §12's aarch64 guidance for measured timings.

---

## 12. Troubleshooting

**Not logged in / every solve fails instantly.** Symptom: every attempt fails immediately with
`claude exited 1` / `"Not logged in · Please run /login"` in the solve error, `total_cost_usd: 0`,
`num_turns: 1` (or the process never gets far enough to emit a turn) — zero spend, because nothing
actually ran. Root cause (measured, see §1): the isolated `--claude-config-dir` has no usable
credentials — on macOS this is expected the first time, because claude-code stores credentials in
the Keychain (service "Claude Code-credentials"), not in a file the isolated dir can inherit. Fix
with one of the two routes from §1 (`ANTHROPIC_API_KEY` or one-time interactive login into the
resolved `--claude-config-dir` path), then re-run. `run-bench.ts` catches this *before* spending
anything: it runs a one-shot auth preflight probe before any real solve work and aborts loud with
both routes spelled out, rather than burning the whole run on instant failures.

**Run exits 0 with an empty (or near-empty) `attempts.jsonl`.** Prior to the live-smoke fixes this
could happen silently — every solve failed but nothing tracked it as a run-level failure, so the
process exited 0 and looked like a clean no-op. `run-bench.ts` tracks solve failures the same way it
tracks grade failures (`solveFailures`, logged and non-zero-exiting), and separately checks whether
the run wrote **zero** outcomes to `attempts.jsonl` across a non-empty runnable set — that condition
alone forces a loud "NOTHING WAS RECORDED" line and a non-zero exit, even if no individual attempt
happened to land in either failure list (e.g. every task failed at fetch/checkout, before any solve
was attempted). Treat any non-zero exit from `run-bench.ts` as "this run needs attention," not just
the previously-documented grade-failure case.

**Skill-visibility matrix (measured, haiku, `-p`, scratch dirs) — why isolation is required and why
`--safe-mode` can't be the treatment arm.** `run-bench.ts` uses `--setting-sources project` (via
`buildClaudeArgs`) plus the isolated `CLAUDE_CONFIG_DIR`, not `--safe-mode`, because of this:

| Flags | Ambient user skills (humanizer, file-issue, implement-issue, merge-batch, plugin skills, ...) | Mounted project skill (the arm under test) |
|---|---|---|
| default flags | Leak | Loads |
| `--setting-sources project` | Still leak | Loads |
| `--safe-mode` | Clean (CLI built-ins only) | Does **not** load |

Only the isolated `CLAUDE_CONFIG_DIR` cuts the ambient-skill leak without also killing the mounted
project skill — `--safe-mode` is clean on ambient skills but breaks the mount mechanism itself, so
it cannot serve as the treatment arm. This is why isolation is a hard requirement (§1), not a
nice-to-have: without it, the baseline arm's "no skill installed" claim is false on this operator's
machine, and a report measured with ambient leakage isn't reproducible off it.

**Apple Silicon / aarch64 hosts: raise the timeout, they do work.** The swe-rebench eval images
(§10's generic-slate grade path) are amd64 and run under Docker Desktop's Rosetta emulation (confirm
`UseVirtualizationFrameworkRosetta` is on — without it, emulation is far slower). A grade that takes
a few minutes natively took **17.3 minutes** emulated in a measured run, so the 10-minute default and
even a 20-minute `--grade-timeout-ms` return spurious `ungradeable (eval_timeout)` results. Pass
`--grade-timeout-ms 3600000` (60 min) on such a host. A timeout is indistinguishable from a genuinely
ungradeable instance in the outcome log, so an under-set timeout silently destroys coverage. The
authored-task-set grade path (`custom-grade.ts`, §4–§9) defaults to a 10-minute cap too
(`DEFAULT_CUSTOM_GRADE_TIMEOUT_MS`, overridable per-task via `timeoutMs` in `set.json` or via
`--grade-timeout-ms`) — the same emulation cost applies if a task's `image` is amd64-only.

**Disk cycles hard during grading.** One emulated grade took free space from 42 GB to 21 GB before
the runner's per-round prune reclaimed it. Keep `JINN_EVAL_DISK_FLOOR_GB` above the transient peak
(~22-25 GB with ~50 GB free) so the run aborts cleanly rather than exhausting the disk — on macOS,
disk exhaustion during a large run has crashed the host. Run `docker system prune -af --volumes`
before a pilot run.

**Pilot-scale feasibility is the real aarch64 limit, not correctness.** At ~17 min per grade, serial
grading, even a screened dozen-task pilot run (baseline + skill, a couple of repeats) is hours of
grading. Use the Linux amd64 host for a full paired measurement; an aarch64 machine is fine for
proving the pipeline (§4's gradeability gate, a `--max-instances`-capped smoke) but not for §6/§9 at
pilot scale.

**Docker wedge / grade timeout.** Both grade paths raise a "could not grade" error (never a false
verdict) on a genuine grading failure (image pull failure, timeout, log-parse/pytest-collection
failure) — `EvalCouldNotGradeError` for the generic-slate path, `CustomGradeError` for the
authored-task-set path — and both `run-bench.ts` modes convert it to `passed: null`
(`unscorable: true`), logging `ungradeable (<reason>)`. This is a normal, publishable outcome, not an
error, and the run continues. Raise `--grade-timeout-ms` (default 600000 = 10 min for both paths) if
timeouts are frequent and the host is just slow, not actually wedged.

**Disk floor abort.** If free disk on the grading host drops below `JINN_EVAL_DISK_FLOOR_GB` (env,
default effectively required at 40 for this rig — see §1), the grader prunes Docker first and, if
still short, raises `InsufficientDiskError` and the run for that attempt aborts (logged as an
unexpected grade error — the attempt key is not written and will retry on resume). Free disk
manually (`docker system prune`, clear old `../bench/runs/*` work dirs) and rerun the same command.

**Manifest mismatch.** `assertManifestCompatible` byte-compares the JSON manifest it would write
against what's already at `<out>/bench-manifest.json`. A mismatch (slate/task-set sha changed, model
changed, arms file changed, screening decision changed, or dry-run/real status flipped) throws
`skills-bench manifest mismatch: ... Use a fresh --out dir for a changed run.` This is a hard stop,
not a warning — pick a new `--out` directory rather than editing the existing manifest or
`attempts.jsonl` to match.

**Holdout guard refusal (§10, `--slate` only).** `--half holdout` without `--candidate-id <id>`
fails argument parsing immediately. A `--half holdout` run for a `--candidate-id` that already has
an entry in `bench/holdout-ledger.json` (resolved from the repo root, not CWD) throws `holdout
already consumed for candidate '<id>' ...` — one-shot per candidate by design; an aborted run still
burns the slot because the ledger records intent before grading starts. Use `--force-holdout-rerun`
only when the prior run for that exact candidate aborted before grading anything.

**Reeval guard refusal (§9, `--task-set` only).** `--reeval-of <skill>` throws listing the task ids
if any of this run's eligible tasks were already burned for `<skill>`'s lineage by
`record-annex.ts` — see §9. `--force-reeval` overrides it (requires `--reeval-of`; refused without
it) with a loud warning, not silently.

---

## Appendix — command reference

| Script | Required flags | Key optional flags |
|---|---|---|
| `pin-skill.ts` | `--name --source --commit --skill-path` | `--dest` (default `../bench/skills-under-test`) |
| `validate-task-set.ts` | `--task-set` | `--task` (one task instead of the whole set) |
| `screen-task-set.ts` | `--task-set --model` | `--repeats` (default 2), `--pass-threshold` (default 1), `--out` (default `<task-set>/.screening-run`) |
| `sweep-gradeability.ts` | `--slate` | `--instances` (comma-separated ids), `--timeout-ms` (default 3,600,000), `--upstream-repo-dir`, `--out` (default `<slate-dir>/gradeability-sweep.json`) |
| `build-slate.ts` | `--seed` | `--pool-size` (default 60), `--out` (default `../bench/slate/slate.json`), `--exclude-instances`, `--exclude-file` |
| `run-bench.ts` | `(--slate \| --task-set) --arms --out` | `--dry-run`; `--half` (default `feedback`, `--slate` only), `--candidate-id`/`--force-holdout-rerun` (`--half holdout`, `--slate` only); `--include-screened-out` (`--task-set` only); `--reeval-of`/`--force-reeval` (`--task-set` only); `--model` (default `claude-sonnet-5` — pin to `claude-haiku-4-5-20251001` for the pilot flow, spec §2.6); `--repeats` (default 1), `--max-turns` (default 40), `--max-instances` (default unlimited), `--grade-timeout-ms` (default 600000), `--upstream-repo-dir` (`--slate` only), `--solve-concurrency` (default 1), `--claude-config-dir` (default `<repoRoot>/bench/.claude-bench-config`) |
| `render-report.ts` | `--run --task-set --skill --report-url` | `--out` (default `<run>/report`), `--measured-on` (default today), `--agent` (default `claude-code`), `--skill-source`, `--include-transcripts` |
| `render-receipts.ts` | `--run --slate --measured-on --out` | `--agent` (default `claude-code`), `--forked-from`, `--skill-source` — no `--half`: `slateHalf` is read from `--run`'s `bench-manifest.json` |
| `list-failing-sessions.ts` | `--run` | `--arm` (inferred if the run has exactly one non-baseline arm) |
| `record-annex.ts` | `--run --skill --tasks` | — |
| `regrade-probe.ts` | `--transcript --slate` | `--timeout-ms` (default 3,600,000), `--upstream-repo-dir` |

All flags verified 2026-07-30, re-verified 2026-07-30 (final-review.md fix round), re-verified
2026-07-31 (live-smoke fix round: `--claude-config-dir` added), re-verified 2026-07-31 (v0.2 pivot:
task-set/screening/reeval flags added, wave-flow commands removed) against
`client/scripts/skills-bench/{pin-skill,validate-task-set,screen-task-set,sweep-gradeability,
build-slate,run-bench,render-report,render-receipts,list-failing-sessions,record-annex,
regrade-probe}.ts`.
