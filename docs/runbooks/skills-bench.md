# Runbook — skills-bench (Skills Factory MVP)

**Spec:** `docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md` (product definition, rig
design, wave 1/2 semantics, publishing surface). Read §2–§6 before running wave 2 — this runbook
gives exact commands, the spec gives the reasoning behind them.

**Audience:** the operator running the skills-bench rig end to end — pin, slate, run, render,
publish, fork-and-improve. All commands below are run from `client/` unless noted otherwise.

**Scope:** wave 1 (benchmark the incumbents) and wave 2 (fork and improve the empirical target).
Everything through §7 (publish) is a real-money, real-Docker operation once you drop `--dry-run`.

---

## 1. Prerequisites

- **Host:** Linux amd64, ≥100 GB free disk. This is a big-disk-host operation, never a laptop —
  each grade spins up a Docker image per instance and the SWE-rebench images are large.
- **Docker** running and reachable (`docker info` succeeds).
- **Node 22** with `corepack enable` run once (pins Yarn to the `packageManager` field).
- **An isolated `CLAUDE_CONFIG_DIR` with usable claude-code credentials — measured, not optional.**
  `run-bench.ts` spawns real `claude` subprocesses under `--claude-config-dir` (default
  `<repoRoot>/bench/.claude-bench-config`, stable and reusable across `--out` dirs — log into it
  once, not once per run). Isolation is required: without it, the operator's own ambient
  user-level skills/plugins/memory leak into every arm — including the baseline arm's "no skill
  installed" claim — and the receipt stops being reproducible off this operator's machine (measured
  empirically; see §8's skill-visibility matrix). One consequence measured on macOS: an isolated
  `CLAUDE_CONFIG_DIR` severs Keychain-backed auth (`claude-code` on macOS stores credentials in the
  Keychain, service "Claude Code-credentials", not in a `~/.claude/.credentials.json` file), so the
  isolated dir starts with no usable credentials until you supply them via one of:
  1. `export ANTHROPIC_API_KEY=...` — metered API billing; works headless, the route for the Linux
     wave host.
  2. One-time interactive login into the bench config dir:
     `CLAUDE_CONFIG_DIR=<resolved --claude-config-dir path> claude`, then `/login` — keeps
     subscription billing, credentials then persist in that dir across runs.

  `run-bench.ts` runs a cheap auth preflight probe before any real (non-`--dry-run`) solve work and
  aborts the whole run with both remediation routes spelled out if the probe fails — see §8 "Not
  logged in / every solve fails instantly".
- **`JINN_EVAL_DISK_FLOOR_GB=40`** in the environment before any real (non-`--dry-run`) run. The
  grader (`PythonEvalRunner`) reads this env var directly (no CLI flag) and prunes Docker /ABORTS
  the run cleanly if free disk falls below the floor — see §8 Troubleshooting.
- **swe-rebench upstream eval repo checked out.** The grader needs
  `SWE-rebench/SWE-rebench-V2` on disk; point `run-bench.ts` at it with `--upstream-repo-dir
  <path>` (default `~/.jinn-client/SWE-rebench-V2-upstream`). If you've already run
  `jinn harnesses enable swe-rebench-v2-evaluator` on this host, that clone already exists at
  `<engine.implStateDirRoot>/swe-rebench-v2-evaluator/upstream/` — pass that path instead of
  re-cloning.

Every command below assumes `cd client` first, and that `../bench/` resolves to the repo-root
`bench/` directory (i.e. you are running from `client/`, not from the repo root).

---

## 2. Pin the incumbents

One `pin-skill.ts` invocation per wave-1 target. Resolve `--commit` to each repo's HEAD sha on pin
day and record the resolved sha in the pin commit message (the script re-resolves and hard-fails
if a 40-hex `--commit` doesn't match what it checks out, but a branch name or short ref should
still be pinned to the exact sha you saw).

```bash
cd client
yarn tsx scripts/skills-bench/pin-skill.ts \
  --name tdd \
  --source https://github.com/mattpocock/skills \
  --commit <resolved-sha> \
  --skill-path skills/tdd

yarn tsx scripts/skills-bench/pin-skill.ts \
  --name grill-me \
  --source https://github.com/mattpocock/skills \
  --commit <resolved-sha> \
  --skill-path skills/grill-me

yarn tsx scripts/skills-bench/pin-skill.ts \
  --name improve-codebase-architecture \
  --source <upstream-repo-url> \
  --commit <resolved-sha> \
  --skill-path <path-to-skill-in-that-repo>

yarn tsx scripts/skills-bench/pin-skill.ts \
  --name vercel-react-best-practices \
  --source <upstream-repo-url> \
  --commit <resolved-sha> \
  --skill-path <path-to-skill-in-that-repo>

yarn tsx scripts/skills-bench/pin-skill.ts \
  --name frontend-design \
  --source <upstream-repo-url> \
  --commit <resolved-sha> \
  --skill-path <path-to-skill-in-that-repo>
```

Each invocation writes `../bench/skills-under-test/<name>/` (default `--dest`; override with
`--dest <path>` only if you need a different destination) containing the vendored `SKILL.md` tree
plus a `pin.json` (`name`, `source`, `commit`, `skillPath`, `sha256` over the vendored bytes,
`license` parsed from the SKILL.md frontmatter, `repoLicense` detected from a repo-root
LICENSE/LICENSE.md/LICENSE.txt/COPYING file when one exists, `fetchedAt`). The command prints the
same JSON to stdout — capture it in the pin commit message alongside the resolved sha.

Resolve the exact `--source` / `--skill-path` for `improve-codebase-architecture`,
`vercel-react-best-practices`, and `frontend-design` from their skills.sh listing (leaderboard
entry links to the source repo) before running — the spec (§3) names the targets, not the repo
paths.

**License gate.** `license` (frontmatter-only) is the primary signal; `repoLicense` is a repo-level
fallback — a crude label (first non-empty line of whichever license file was found), never parsed
or validated, and never written into `license`. After pinning, read each `pin.json`'s `license`
field and record fork-eligibility in `bench/skills-under-test/LICENSES.md`: one row per skill
(`name`, `license`, `fork-eligible: yes/no`, one-line rationale). Only a skill whose license permits
redistribution and modification is a wave-2 fork candidate; the rest are measure-only for the wave-1
receipt. A `license: null` pin (no `license:` key in the upstream frontmatter) is fork-ineligible
until an operator confirms terms directly with the upstream author — do not assume permissive by
default, and a permissive-looking `repoLicense` next to a null `license` does **not** flip
fork-eligibility on its own; it's a pointer for the operator to go verify, a human judgement call,
not an automatic pass.

---

## 3. Build and freeze the slate

```bash
cd client
yarn tsx scripts/skills-bench/build-slate.ts \
  --seed jinn.skills-bench.v1 \
  --pool-size 60 \
  --out ../bench/slate/slate.json
```

This sources candidates via the same HuggingFace historical-pool path as `build-pilot-slate.ts`,
excludes every active cap-v0 held-out slate id, dedupes to at most 2 instances per repo, seed-ranks
and takes the first `--pool-size` candidates, then splits into a 15-instance feedback half and a
15-instance holdout half (`splitSlate`, fixed at `feedbackSize: 15, holdoutSize: 15` — not
configurable from the CLI). Output: `sha256=<hash> feedback=15 holdout=15` on stdout, and
`../bench/slate/slate.json` on disk.

**Commit `slate.json` — the commit is the freeze.** Nothing downstream (wave 1, wave 2 feedback
rounds, the holdout run) should ever be run against an uncommitted or subsequently-edited
`slate.json`; `render-receipts.ts` will refuse to render if the file's `sha256` doesn't match what
a run's `bench-manifest.json` recorded (§6, §8).

If the wave-1 smoke run (§4) finds an ungradeable instance, remove it from `slate.json` and rebuild
the slate **before** this freeze commit — do not silently drop instances from a slate that has
already been committed and run against.

---

## 4. Wave 1 smoke

Cheap, small model, capped instance count — verifies the wiring (real claude solve, real Docker
grade) before spending the full wave-1 budget.

```bash
cd client
yarn tsx scripts/skills-bench/run-bench.ts \
  --slate ../bench/slate/slate.json \
  --arms ../bench/arms/wave1.json \
  --model claude-haiku-4-5-20251001 \
  --max-instances 2 \
  --out ../bench/runs/smoke
```

`../bench/arms/wave1.json` is an array with a `baseline` arm (`skillDir: null`) plus one entry per
pinned wave-1 skill, e.g.:

```json
[
  { "name": "baseline", "skillDir": null },
  { "name": "tdd", "skillDir": "../bench/skills-under-test/tdd" },
  { "name": "grill-me", "skillDir": "../bench/skills-under-test/grill-me" },
  { "name": "improve-codebase-architecture", "skillDir": "../bench/skills-under-test/improve-codebase-architecture" },
  { "name": "vercel-react-best-practices", "skillDir": "../bench/skills-under-test/vercel-react-best-practices" },
  { "name": "frontend-design", "skillDir": "../bench/skills-under-test/frontend-design" }
]
```

Verify before proceeding to §5:

- The command exits 0 (no grade failures reported to stderr).
- `../bench/runs/smoke/transcripts/` contains a `<instanceId>|<arm>|<repeat>.json` file per attempt.
- `../bench/runs/smoke/attempts.jsonl` has at least one outcome that came from a **completed Docker
  eval**. A `"passed": false` line is NOT sufficient on its own: the runner short-circuits an empty
  patch to `false` without ever entering the container, so a smoke in which every real grade timed
  out can still show a `false` and look healthy. Confirm against the log that at least one instance
  logged `graded <id> arm=<name> → passed` or `→ failed` *without* a preceding
  `empty patch for <id>` or `ungradeable (eval_timeout)` line for that same attempt. Until that
  holds, the grading path is unproven and the wave-1 budget must not be spent.
- **No `.claude/` hunk in any treatment patch.** The skill is mounted into the checkout and must be
  unmounted before the patch is recovered; if it leaks, every treatment patch installs the skill
  inside the eval container and the arms stop being comparable. Check every transcript:

  ```bash
  cd ../bench/runs/smoke/transcripts
  python3 -c "
import json,glob
for f in sorted(glob.glob('*.json')):
    p = json.load(open(f)).get('patch','') or ''
    bad = [l for l in p.split('\n') if l.startswith(('+++ b/','--- a/')) and '.claude/' in l]
    print(f, 'LEAK:' if bad else 'clean', bad)
"
  ```

- **Resume works:** re-run the exact same command. It should print `no runnable attempts — every
  attempt key already present in attempts.jsonl (resumed).` and do no new solving or grading.

**Apple Silicon / aarch64 hosts: raise the timeout, they do work.** The SWE-rebench eval images are
amd64 and run under Docker Desktop's Rosetta emulation (confirm `UseVirtualizationFrameworkRosetta`
is on — without it, emulation is far slower). A grade that takes a few minutes natively took
**17.3 minutes** emulated in a measured run, so the 10-minute default and even a 20-minute
`--grade-timeout-ms` return spurious `ungradeable (eval_timeout)` results. Pass
`--grade-timeout-ms 3600000` (60 min) on such a host. A timeout is indistinguishable from a genuinely
ungradeable instance in the outcome log, so an under-set timeout silently destroys slate coverage.

**Disk cycles hard during grading.** One emulated grade took free space from 42 GB to 21 GB before
the runner's per-round prune reclaimed it. Keep `JINN_EVAL_DISK_FLOOR_GB` above the transient peak
(~22-25 GB with ~50 GB free) so the run aborts cleanly rather than exhausting the disk — on macOS,
disk exhaustion during a full slate has crashed the host. Run `docker system prune -af --volumes`
before a wave.

**Wave-scale feasibility is the real aarch64 limit, not correctness.** At ~17 min per grade, serial
grading, wave 1's ~180 attempts is roughly 50 hours of grading alone. Use the Linux amd64 host for
waves; an aarch64 machine is fine for smoke runs and for proving the pipeline.

A slate instance that proves ungradeable in this smoke run must be removed from `slate.json` and
the slate rebuilt (§3) **before** the freeze commit — this is the last gradeability check before
`slate.json` becomes immutable.

`../bench/runs/smoke` is a real (non-dry-run) `--out` dir; it cannot be reused for `--dry-run`
testing and a dry-run `--out` dir cannot later be reused for this smoke run — `assertManifestCompatible`
rejects the mismatch (`dryRun: true` is part of the manifest bytes it compares).

---

## 5. Wave 1 full

Same command, full model, full slate, fresh `--out`. Wave 1 measures the incumbents' effect across
the whole slate, so pass `--half both` explicitly — do not rely on the `feedback` default here:

```bash
cd client
yarn tsx scripts/skills-bench/run-bench.ts \
  --slate ../bench/slate/slate.json \
  --half both \
  --arms ../bench/arms/wave1.json \
  --model claude-sonnet-5 \
  --out ../bench/runs/wave1
```

`--half both` also seeds `bench/holdout-ledger.json` with a `<pre-candidate>` entry per the
ledger's audit-trail design; see §8 and `src/skills-bench/holdout-guard.ts`. `run-bench.ts` records
the `--half` it actually ran with into `bench-manifest.json`'s `half` field — this is what
`render-receipts.ts` (§6) reads to label the receipt's scope, not an operator-typed flag, so there
is no way for the published receipt to disagree with what was actually run. Because wave 1 touches
the holdout half, **§9's diagnosis step must read feedback-half transcripts only** — see §9's filter
step before starting wave 2.

**Budget note:** ≈30 tasks × 6 arms ≈ 180 solves + grades. Expect this to take days, not hours —
each attempt is a real claude-code solve followed by a real Docker-based eval. It is safe to
interrupt (Ctrl-C) and resume: rerunning the identical command skips every attempt key already
present in `attempts.jsonl` and only runs what's missing.

If any attempt hits an unexpected grade error (Docker/disk/network infra failure, not a legitimate
ungradeable verdict), the run logs it loudly, continues the rest of the batch, and exits non-zero
with a summary line listing the failed attempt keys. Those keys are absent from `attempts.jsonl`,
so a plain rerun of the same command retries exactly them.

`--solve-concurrency N` (default 1) parallelizes across instances if the host has headroom; grading
itself is always serialized through an internal queue regardless of `--solve-concurrency`.

---

## 6. Render + review receipts

```bash
cd client
yarn tsx scripts/skills-bench/render-receipts.ts \
  --run ../bench/runs/wave1 \
  --slate ../bench/slate/slate.json \
  --measured-on 2026-08-01 \
  --out ../bench/runs/wave1/receipts \
  --agent claude-code
```

There is no `--half` flag on this script — the receipt's `slateHalf` is read directly from
`--run`'s `bench-manifest.json` (`half`, recorded by `run-bench.ts` when the run started), so it can
never disagree with what was actually run (§5). `--measured-on` is a plain `YYYY-MM-DD` string, not
validated against anything — set it to the date the run completed. `--agent` defaults to
`claude-code`; only pass `--forked-from <owner/repo@sha>` for a wave-2 fork
receipt (§9), never for wave-1 (wave 1 has no fork). Pass `--skill-source <owner/repo@sha>` (the
pinned original's `source`/`commit` from its `pin.json`, §2) to record which upstream bytes were
measured on the receipt's `scope:` line — `skillSha256` is populated automatically from the run's
`bench-manifest.json` arm entry, `--skill-source` is the human-readable pointer alongside it.

The renderer refuses to run against a dry-run manifest (`dryRun: true` in
`bench-manifest.json`) and refuses if `slate.json`'s `sha256` doesn't match the `slateSha256`
recorded in `bench-manifest.json` — both are integrity checks, not something to work around by
editing either file. If either fires, you're pointing `--run` or `--slate` at the wrong pair; fix
the paths rather than the files.

Output: one `receipts/<arm-name>.md` per non-baseline arm in the manifest (the baseline arm is
whichever manifest arm has `skillSha256: null`), plus `receipts/SUMMARY.md` — a `| skill | baseline
| with skill | net |` table, generated, never hand-edited.

**Human review gate — mandatory before §7.** Read every rendered receipt against the spec's
no-overclaim rules (design doc §1.6, §2 "Statistics posture", §8 risk 3): N, resolve rates, paired
delta, CI, and the plain-words caveat must all be present; no claim of significance beyond what the
interval supports; a `frontend-design` / `vercel-react-best-practices` receipt whose slate turned
out to have too few applicable (Python-heavy SWE) tasks must say so rather than imply a measured
effect it can't support (spec §8 risk 5). Do not proceed to publish until every receipt in the
render output has been read and passes this check.

---

## 7. Publish (wave 1)

Publishing is an **external, human-gated action** — creating a public GitHub repo and pushing to
it. Nothing in this runbook automates it; an operator performs each step and pushes deliberately,
per the repo's external-communication rules (`CLAUDE.md` §External Communication).

1. Create `Jinn-Network/skills` from `bench/skills-repo-template/` (copy the template's
   `README.md`, `skills/`, `receipts/`, `rig/` layout as the starting tree).
2. Copy the reviewed receipts (§6) into `receipts/<name>.md`, and copy `receipts/data/` — the frozen
   `slate.json`, the run's `attempts.jsonl`, `bench-manifest.json`, `transcripts/`, and
   `bench/holdout-ledger.json` (tracked in this repo, not gitignored — see `.gitignore`) — so every
   receipt is reproducible from the repo alone and the ledger is a complete audit trail a reader of
   the receipt can inspect (spec §1.6 success test).
3. Regenerate the README's summary table from `receipts/SUMMARY.md` (never hand-write it — see
   `bench/skills-repo-template/README.md`'s comment).
4. **Do not copy the skill directories into `skills/<name>/` yet.** Wave 1 publishes measurements,
   not forks — the `skills/` tree stays empty (`.gitkeep` only) until a wave-2 fork wins its holdout
   run (§9).
5. Push and make the repo public. This is the human-gated step: confirm the receipts passed the
   §6 review gate before pushing, and confirm no PII or secrets are in `receipts/data/transcripts/`
   (transcripts are raw claude-code session output).

---

## 8. Troubleshooting

**Not logged in / every solve fails instantly.** Symptom: every attempt fails immediately with
`claude exited 1` / `"Not logged in · Please run /login"` in the solve error, `total_cost_usd: 0`,
`num_turns: 1` (or the process never gets far enough to emit a turn) — zero spend, because nothing
actually ran. Root cause (measured, see §1): the isolated `--claude-config-dir` has no usable
credentials — on macOS this is expected the first time, because claude-code stores credentials in
the Keychain (service "Claude Code-credentials"), not in a file the isolated dir can inherit. Fix
with one of the two routes from §1 (`ANTHROPIC_API_KEY` or one-time interactive login into the
resolved `--claude-config-dir` path), then re-run. As of this fix, `run-bench.ts` catches this
*before* spending anything: it runs a one-shot auth preflight probe before any real solve work and
aborts loud with both routes spelled out, rather than burning the whole slate on instant failures.

**Run exits 0 with an empty (or near-empty) `attempts.jsonl`.** Prior to the live-smoke fixes this
could happen silently — every solve failed but nothing tracked it as a run-level failure, so the
process exited 0 and looked like a clean no-op. `run-bench.ts` now tracks solve failures the same
way it tracks grade failures (`solveFailures`, logged and non-zero-exiting), and separately checks
whether the run wrote **zero** outcomes to `attempts.jsonl` across a non-empty runnable set — that
condition alone forces a loud "NOTHING WAS RECORDED" line and a non-zero exit, even if no individual
attempt happened to land in either failure list (e.g. every instance failed at fetch/checkout,
before any solve was attempted). Treat any non-zero exit from `run-bench.ts` as "this run needs
attention," not just the previously-documented grade-failure case.

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
it cannot serve as the treatment arm. This is why isolation is a hard requirement (§1), not a nice-
to-have: without it, the baseline arm's "no skill installed" claim is false on this operator's
machine, and a receipt measured with ambient leakage isn't reproducible off it.

**Docker wedge / grade timeout.** `PythonEvalRunner` raises `EvalCouldNotGradeError` on a genuine
grading failure (image pull failure, timeout at `--grade-timeout-ms`, log-parse failure); `run-bench.ts`
converts that into `passed: null` (`unscorable: true`) and logs `ungradeable (<reason>)` — this is a
normal, publishable outcome, not an error, and the run continues. Raise `--grade-timeout-ms` (default
600000 = 10 min) if timeouts are frequent and the host is just slow, not actually wedged.

**Disk floor abort.** If free disk on the grading host drops below `JINN_EVAL_DISK_FLOOR_GB` (env,
default effectively required at 40 for this rig — see §1), the grader prunes Docker first and, if
still short, raises `InsufficientDiskError` and the run for that attempt aborts (logged as an
unexpected grade error per §5 — the attempt key is not written and will retry on resume). Free disk
manually (`docker system prune`, clear old `../bench/runs/*` work dirs) and rerun the same command.

**Manifest mismatch.** `assertManifestCompatible` byte-compares the JSON manifest it would write
against what's already at `<out>/bench-manifest.json`. A mismatch (slate sha changed, model
changed, arms file changed, or dry-run/real status flipped) throws `skills-bench manifest mismatch:
... Use a fresh --out dir for a changed run.` This is a hard stop, not a warning — pick a new
`--out` directory rather than editing the existing manifest or `attempts.jsonl` to match.

**Holdout guard refusal.** `--half holdout` without `--candidate-id <id>` fails argument parsing
immediately (`--half holdout requires --candidate-id <id>`). A `--half holdout` run for a
`--candidate-id` that already has an entry in `bench/holdout-ledger.json` (resolved from the repo
root, not CWD) throws `holdout already consumed for candidate '<id>' ...` — the holdout is one-shot
per candidate by design (spec §4 step 5, §9 below); an aborted run still burns the slot because the
ledger records intent before grading starts. Use `--force-holdout-rerun` only when the prior run for
that exact candidate aborted before grading anything — it skips the guard with a loud warning, not
silently.

---

## 9. Wave 2 loop (fork and improve)

Design reference: spec §4. Only a license-eligible target (§2) qualifies. Choose the target from
the wave-1 receipts (§6) — the skill with the clearest demonstrated headroom or the clearest
demonstrated failure, not a guess.

1. **Diagnose from traces — feedback-half transcripts only.** Wave 1 ran `--half both` (§5), so
   `../bench/runs/wave1/transcripts/` contains **both** feedback- and holdout-instance transcripts.
   Diagnosis must read feedback-half transcripts exclusively. Filter explicitly before opening
   anything — do not eyeball filenames:

   ```bash
   # 1. The feedback-half instance ids from the frozen slate — the only ids safe to read for
   #    wave-2 diagnosis.
   jq -r '.feedback[].instance_id' ../bench/slate/slate.json | sort > /tmp/feedback-ids.txt

   # 2. Transcript filenames are `<instanceId>|<arm>|<repeat>.json` — keep only the ones whose
   #    instanceId (the part before the first `|`) is in the feedback set, further filtered to
   #    the target arm and passed=false via attempts.jsonl.
   for f in ../bench/runs/wave1/transcripts/*.json; do
     id="$(basename "$f" | cut -d'|' -f1)"
     grep -qxF "$id" /tmp/feedback-ids.txt && echo "$f"
   done
   ```

   Cross-check each candidate id against `attempts.jsonl` (`arm=<target>`, `passed=false`) before
   reading it, and read only that filtered list for the dominant failure mode: never triggered,
   guidance too vague to act on, or actively harmful on a task class.

   **Warning — this is an information boundary, not just a run-count guard.** The one-shot holdout
   ledger (§8) blocks a second `--half holdout` *run* for a given candidate; it cannot un-read a
   transcript. Opening a holdout-instance transcript at this step spends the holdout in information
   terms — a variant designed with knowledge of a holdout failure is no longer a clean one-shot
   against that half, even though every mechanical gate (ledger, manifest) stays green. Treat the
   filtered list above as the entire diagnosis corpus; do not browse
   `../bench/runs/wave1/transcripts/` directly.
2. **Write K variant skill dirs** under `../bench/variants/<target>-v<k>/`, one per candidate fix —
   full revised `SKILL.md` files, not patches (spec §4 step 2). Build each variant's frontmatter
   with `buildSkillFrontmatter` from `src/skills-bench/frontmatter.ts` (six allowed keys only;
   `name`/`description` required; `metadata` is a flat string map) so it stays spec-valid.
3. **Build the wave-2 arms file** `../bench/arms/wave2-<target>.json`: the original pinned skill
   plus each variant, e.g.:

   ```json
   [
     { "name": "baseline", "skillDir": null },
     { "name": "<target>-original", "skillDir": "../bench/skills-under-test/<target>" },
     { "name": "<target>-v1", "skillDir": "../bench/variants/<target>-v1" },
     { "name": "<target>-v2", "skillDir": "../bench/variants/<target>-v2" }
   ]
   ```

4. **Run on the feedback half only:**

   ```bash
   cd client
   yarn tsx scripts/skills-bench/run-bench.ts \
     --slate ../bench/slate/slate.json \
     --half feedback \
     --arms ../bench/arms/wave2-<target>.json \
     --model claude-sonnet-5 \
     --out ../bench/runs/wave2-r<round>
   ```

5. **Render and compare** (§6's command, same `--half feedback`, pointed at
   `../bench/runs/wave2-r<round>`). Keep the variant with the best net (`treatment.passed -
   baseline.passed`, as `render-receipts.ts`'s `summaryRow` computes it) against the original.
6. **Iterate** up to 3 rounds total (`wave2-r1`, `wave2-r2`, `wave2-r3`), each a fresh `--out`,
   narrowing the variant set each round. The winner after the final round is the fork candidate.

**`--half feedback` never touches the holdout ledger** — only `--half holdout` and `--half both`
record into `bench/holdout-ledger.json` (§8). Iterate on the feedback half as many times as the
round budget allows without any one-shot risk.

---

## 10. Wave 2 holdout (one shot)

The holdout half is touched exactly once per candidate. This is the number that goes in the
receipt.

```bash
cd client
yarn tsx scripts/skills-bench/run-bench.ts \
  --slate ../bench/slate/slate.json \
  --half holdout \
  --candidate-id <target>-fork-v<k> \
  --arms ../bench/arms/wave2-<target>-holdout.json \
  --model claude-sonnet-5 \
  --out ../bench/runs/wave2-holdout
```

`../bench/arms/wave2-<target>-holdout.json` contains only the baseline, the original, and the
winning variant from §9 — no other variants (a holdout run is not another feedback round).
`--candidate-id` is the ledger key; pick a stable id (e.g. `<target>-fork-v3`) before running, since
a second `--half holdout` attempt with the same id fails the one-shot guard (§8) unless the first
attempt aborted before grading anything.

Render the receipt with `--forked-from <owner/repo@sha>` (the pinned original's `source`/`commit`
from its `pin.json`, §2) and `--skill-source` for the same pointer on the `scope:` line. `slateHalf`
is read from `bench-manifest.json`'s `half` field (recorded as `holdout` because §10's run above
passed `--half holdout` — no `--half` flag on this script, see §6):

```bash
cd client
yarn tsx scripts/skills-bench/render-receipts.ts \
  --run ../bench/runs/wave2-holdout \
  --slate ../bench/slate/slate.json \
  --measured-on <date> \
  --out ../bench/runs/wave2-holdout/receipts \
  --agent claude-code \
  --forked-from <owner>/<repo>@<sha> \
  --skill-source <owner>/<repo>@<sha>
```

**Publish only if the fork wins** (net positive against the original on the holdout half, within
the receipt's own stated caveats — do not round a noisy delta up to a claim): copy the fork's skill
directory into the public repo's `skills/<name>/` (§7 step 4, now unblocked for this one skill) plus
its receipt and data. If it does not win, publish the finding anyway — a receipt showing the
optimization loop found nothing is still an honest, publishable result (spec §8 risk 2) — but do
not publish the fork as an installable skill.

**Frontmatter packaging — spec §5.1 / §6 L3.** Before copying the winning fork's `SKILL.md` into
`skills/<name>/`, rebuild its frontmatter with the `jinn.*` receipt-pointer block so the published
skill points back at the receipt that measured it, composing `buildJinnReceiptMetadata` with
`buildSkillFrontmatter` (`src/skills-bench/frontmatter.ts`):

```ts
import { buildJinnReceiptMetadata, buildSkillFrontmatter } from './src/skills-bench/frontmatter.js';

const jinnMetadata = await buildJinnReceiptMetadata({
  receiptUrl: 'https://github.com/Jinn-Network/skills/blob/main/receipts/<name>.md',
  receiptFilePath: '../bench/runs/wave2-holdout/receipts/<name>.md',
  measuredOn: '<date>', // same value passed to --measured-on above
  forkedFrom: '<owner>/<repo>@<sha>',
});

const frontmatter = buildSkillFrontmatter({
  name: '<name>',
  description: '<the fork\'s final description>',
  license: '<license>',
  metadata: jinnMetadata,
});
```

`jinnMetadata` carries `jinn.receipt` (the receipt's public URL), `jinn.receipt-sha256` (sha256 of
the published receipt file — compute this against the receipt's *final* path in the public repo,
after §7 step 2's copy, so the hash matches what a reader downloads), `jinn.measured-on`, and
`jinn.forked-from`. Prepend `frontmatter` to the fork's body content to produce the final
`SKILL.md` written into `skills/<name>/`.

Offer the winning diff back to the original author as a PR regardless of outcome-driven publishing
decisions above (spec §4, §6 L4) — this is also a human-gated external action (opening a PR against
a repo Jinn does not own), not something to automate.

---

## Appendix — command reference

| Script | Required flags | Key optional flags |
|---|---|---|
| `pin-skill.ts` | `--name --source --commit --skill-path` | `--dest` (default `../bench/skills-under-test`) |
| `build-slate.ts` | `--seed` | `--pool-size` (default 60), `--out` (default `../bench/slate/slate.json`) |
| `run-bench.ts` | `--slate --arms --out` | `--dry-run`, `--half` (default `feedback`), `--model` (default `claude-sonnet-5`), `--repeats` (default 1), `--max-turns` (default 40), `--max-instances` (default unlimited), `--grade-timeout-ms` (default 600000), `--upstream-repo-dir` (default `~/.jinn-client/SWE-rebench-V2-upstream`), `--solve-concurrency` (default 1), `--candidate-id` (required with `--half holdout`), `--force-holdout-rerun`, `--claude-config-dir` (default `<repoRoot>/bench/.claude-bench-config` — stable, reusable across `--out` dirs; see §1) |
| `render-receipts.ts` | `--run --slate --measured-on --out` | `--agent` (default `claude-code`), `--forked-from`, `--skill-source` — no `--half`: `slateHalf` is read from `--run`'s `bench-manifest.json` (`half`, recorded by `run-bench.ts`) |

All flags verified 2026-07-30, re-verified 2026-07-30 (final-review.md fix round), re-verified
2026-07-31 (live-smoke fix round: `--claude-config-dir` added) against
`client/scripts/skills-bench/{pin-skill,build-slate,run-bench,render-receipts}.ts`.
