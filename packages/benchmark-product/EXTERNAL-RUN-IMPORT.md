# External run-record import

How results a *different* harness already produced become a benchmark-product
run. You lock a run here, then either hand the importer a named harness's
finished output (`--from harbor` for Harbor 0.21 jobs and trials, `--from inspect`
for Inspect `read_eval_log` JSON) or a file of generic per-attempt records. The
ordinary product chain — collect, then report — reads that evidence exactly as
it reads a driven run's.

> **An imported run publishes as composed `/10` declaring `external-import`.**
> `colophon publish`, the GUI's `run.publish`, and managed signed-Report
> publication all succeed on a run whose evidence was imported. The public
> marker, dump digest, and import-aware disclosure are **issue #3417**. Read
> [How an imported run publishes](#how-an-imported-run-publishes-issue-3417)
> before planning around this document. `composedFormat: false` is refused:
> an imported run has no enumerated-cell form whose disclosure is honest.

[`PUBLIC-BUNDLE.md`](PUBLIC-BUNDLE.md) is the output format.
[`EXTERNAL-VERIFICATION.md`](EXTERNAL-VERIFICATION.md) is the verification
path. This document is the **input** format.

## What import claims, and what it does not

Read this table first. It is the whole point of the document.

| Claim | Status after import |
| --- | --- |
| Every slot the sealed run pre-registered is accounted for | proven — import refuses a dump that does not cover the slate exactly once |
| The matrix is the correct aggregation of the imported evidence | proven — re-derived byte-exactly, by the workspace verifier and by the public reader over a materialized bundle |
| Each graded cell's verdict is the sealed EvaluationSpec's own rule applied to the imported measurements | proven — recomputed at assembly and again by the reader |
| The evidence files are exactly the bytes the dump named | proven — sealed by digest, carried in the record closure |
| The external harness ran the pinned harness, model, or loadout | **not claimed** — every pinning axis reports `unverifiable` |
| Anyone here observed the attempt | **not claimed** — the evaluator identity transcribed measurements and evaluated nothing |
| The dump is a faithful record of what the external harness did | **not claimed by any tool** — it is the operator's assertion |
| The run can be published as a public bundle | proven — composed `/10` declaring `external-import`; see [below](#how-an-imported-run-publishes-issue-3417) |

The verdict records say the second and third of the "not claimed" rows in their
own `limitations` field, so a reader cannot miss them:

- This evaluator transcribed measurements produced by an external harness outside this workspace. It executed no grader, observed no attempt, and performed no evaluation of its own; the verdict is the sealed EvaluationSpec's verdict rule applied to the transcribed measurements.
- Run pinning was not observed for the imported attempt, so every pinning axis is reported unverifiable rather than matched.

The transcribing identity is `urn:jinn:colophon:external-import-transcriber/v1`,
deliberately unmistakable and distinct from every venue evaluator.

## How an imported run publishes (issue #3417)

Every Report this product seals carries the local-venue disclosure, and its
third line on a driven run reads:

> Run pinning on the harness, model, and loadout axes is enforced by an
> admission gate at dispatch time.

For an imported run that sentence is false. No venue dispatched these cells and
no admission gate ever ran — while the same bundle's own cells report every
pinning axis as `unverifiable`. Publishing that sentence would put a
self-contradicting claim inside a signed disclosure.

The workspace verifier and the shipped reader both derive the *expected*
disclosure from the sealed Run record (`localVenueLimitsForRun`), and the Run
record is sealed at `lock` — before the import exists. `RunState`'s
`externalImportSha256` and the `external-import` run-journal entry are
workspace-local: neither enters the bundle closure, and the reader rejects
bundle members it does not expect. An honest bundle therefore needs a
reader-visible import marker.

That marker is **issue #3417**. `external-import` is a capability under the
composed `/10` generation. An imported run's `report` / `publish` path:

- Forces composed `/10`. `composedFormat: false` is refused: there is no
  enumerated cell whose disclosure is honest for an imported run.
- Declares `external-import` in the capability vector. The mandatory member is
  `external-import.json`: dump digest (`sha256` + `byteLength`), declaration
  digest, source, and one `{cellKey, outcome, reason?}` row per sealed Matrix
  cell.
- Rebuilds `venueHonesty.limits[2]` as `IMPORTED_RUN_PINNING_LIMIT` in both
  claim-consistency implementations, so the sealed disclosure says pinning is
  unverifiable rather than admission-gated.
- Declares `owner-controlled-publication`, as every composed run does (issue
  #3401), so the sixth venue sentence follows the import-aware five.
- Hashes `--file` and `--from inspect` pointing at a file by those file bytes;
  a directory (`--from harbor`, `--from inspect` at a dir) hashes the canonical
  JSON of the normalized records. In-memory tests hash the records.
- Caps a hostile dump: 10_000 rows and 8 MiB per evidence file. All evidence
  together is capped at 64 MiB unless the import is given a larger figure. The
  Harbor reader works one out for its run: 4 MiB for each cell the locked run
  expects, and never less than 64 MiB.

`colophon publish` and the GUI's `run.publish` succeed. Managed signed Report
v2 publication (`colophon publication report`) seals the same import-aware
five venue sentences; the sixth is a `/10` bundle capability and Report v2
does not carry it. Both durable signals are still consulted so a crash after the
journal marker but before `RunState.externalImportSha256` still reads as
imported. The public reader accepts the published bundle; the extra check is
`external-import`. Proven in `core/src/operations/run-import.bundle.test.ts`.

## The per-attempt record shape

One record per expected slot. Both file formats normalize to the same shape,
so a JSONL dump and the equivalent CSV dump import identically.

| Field | Type | Rule |
| --- | --- | --- |
| `cellKey` | string | Required. One coordinate from the sealed slate, verbatim. |
| `outcome` | string | Required. One of `graded`, `ungradeable`, `error`, `timeout`, `unrun`. |
| `reason` | string | Required and non-blank on every outcome except `graded`; forbidden on `graded`. |
| `startedAt` | RFC 3339 | Optional. Calendar-strict. Both-or-neither with `endedAt`. Inside the sealed run window (below). |
| `endedAt` | RFC 3339 | Optional. Calendar-strict, not before `startedAt`. Inside the sealed run window (below). |
| `durationMs` | non-negative integer | Optional. When timestamps are also given it must equal their interval. |
| `evidence` | list of `{name, path}` | Required on `graded` and `ungradeable`; forbidden otherwise. Paths are relative and resolve against the dump file's own directory; an absolute path, one that resolves outside that directory, or one that is a symbolic link is refused naming the row. Names match `[A-Za-z0-9._-]{1,64}` and are unique within a record. |
| `measurements` | map of name to string, finite number, or boolean | Required on `graded`; forbidden otherwise. Names match `[A-Za-z0-9._-]{1,64}` and must be declared by the subject task's sealed EvaluationSpec. Each value is typed against that declaration before the verdict rule reads it. |

Measurement values are typed against the sealed EvaluationSpec's own
declarations, so the two dialects genuinely produce one record. A measurement
declared `boolean` accepts `true`/`false` in either dialect and the strings
`"true"`/`"false"` — nothing else, because `1` and `yes` are guesses. One
declared `number` accepts a number or a decimal string. A whole number is
sealed as a number: `1`, `"1"`, and `"1.0"` all seal the number `1`. Any other
value is sealed as a decimal string, because a sealed number must be whole. A
decimal string stays the string it was, so `"0.50"` stays `"0.50"`. A number
is written as the shortest decimal that reads back as the same value, with no
exponent, so `0.5` becomes `"0.5"` and `1e-7` becomes `"0.0000001"`. A whole
number too large for a sealed number to hold exactly, above 2^53 - 1 in
magnitude, is sealed as a decimal string as well. The verdict rule compares a
decimal string as an exact decimal, so `"0.50"` equals `0.5`. One declared
`string` accepts only a string. Anything else is refused, naming the
measurement, the row, and the declared type.

Evidence paths may not leave the dump file's own directory. An absolute path,
or a relative one that climbs out of the tree, is refused: whatever a dump
names is sealed into the workspace and travels inside the bundle closure, so
the boundary of what could ever be published is the directory you handed the
importer.

Evidence is read without following links. A dump and its evidence tree come
from a different harness and often arrive as one archive, so a symbolic link
inside that tree is a path the archive chose, not one you did — and
`evidence/log.txt -> ~/.ssh/id_rsa` would otherwise be sealed and published.
Every evidence entry must be a regular file; a symlink is refused naming the
row. Copy what you mean to publish into the dump directory.

**Imported timestamps are bounded by the sealed run window.** `startedAt` and
`endedAt` must fall at or after the instant the run was locked, and at or
before the earlier of the run's `closeAt` and the moment you run the import.
They are not decoration: they become the run journal's own timestamps, the
sealed delivery's `createdAt`, and the `evaluatedAt` inside the signed verdict.
Unbounded, a dump could produce a signed attestation claiming a result was
evaluated before the run record it is evidence for was sealed — a result dated
before its own pre-registration — or after the moment the signature was made.
Nothing downstream re-checks either bound, so import is where they are
enforced.

There is no pass/fail column, and adding one would be a mistake rather than a
convenience. The verdict is computed from the subject task's own sealed
EvaluationSpec verdict rule over the measurements you supply, and the
computation is re-checked at assembly and again by the public reader. A
supplied verdict could only ever be laundered or ignored, so the format does
not accept one. For the same reason the matrix outcome is derived, never
declared: the importer writes down what happened and the outcome falls out of
the evidence.

| Import outcome | What is written | Derived matrix outcome |
| --- | --- | --- |
| `graded` | dispatch, solve submission, delivery, evaluation task, signed verdict | `judged` |
| `ungradeable` | dispatch, solve submission, delivery, could-not-grade terminal | `unscorable` |
| `error` | dispatch, solve submission, error terminal | `expired`, one dispatch |
| `timeout` | dispatch, solve submission, error terminal | `expired`, one dispatch |
| `unrun` | error terminal only | `expired`, zero dispatches |

`graded` means the external harness's grader ran and produced measurements. It
does not mean the result was good: a measurement set that makes the sealed rule
return `fail` or `inconclusive` is still `graded`, because the rule ran and its
answer was recorded.

## Every slot appears exactly once, and there is no exclude flag

A run's denominator is fixed when you lock it. An import that let you drop the
slots your harness could not produce would let you publish a number computed
over a slate you chose after seeing the results — the exact move the sealed
slate exists to prevent.

So a slot you cannot supply is recorded as `error`, `timeout`, or `unrun` with
a non-blank reason, and it stays in the run's accounting as one of its arm's
planned slots. It does not enter the pass rate, which is taken over judged
cells only; the report page shows both counts. A dump that omits a slot, names
a slot outside the slate, or names one twice is refused. The refusal reports
**every** problem in the dump at once, grouped missing before unknown before
duplicate, then the row-level problems in row order. Repair the whole list and
re-run; there is no round-trip where each attempt reveals one more problem.

## File formats

### JSONL

One JSON object per line. UTF-8 without a byte order mark, LF endings, exactly
one trailing LF, no blank lines. Unknown fields are refused. Lines need not be
canonical, sorted, or unique — the records are re-serialized into sealed
records anyway, and duplicates are reported by the slate validator naming both
row numbers.

```
{"cellKey":"<taskDigest>/baseline/1","outcome":"graded","evidence":[{"name":"prediction","path":"cell-1/prediction.json"}],"measurements":{"integrity":true,"resolved":true}}
{"cellKey":"<taskDigest>/sample/1","outcome":"timeout","reason":"exceeded the harness's own 30 minute wall clock"}
```

### CSV

A deliberately restricted dialect: one `,` separator, **no quoting and no
escapes**. A field may not contain `,`, `"`, or any control character, and may
not carry leading or trailing whitespace — nothing is silently trimmed. An
embedded comma therefore surfaces as a field-count disagreement with the
header, naming the row, rather than as a silently shifted column. Same line
hygiene as JSONL: UTF-8 without a BOM, LF endings, one trailing LF, no blank
lines.

The header declares the fixed columns it uses — `cellKey` and `outcome` are
mandatory, the rest optional — plus one `m.<name>` column per measurement.
Column order is free; duplicate columns and unknown columns are refused. An
empty field means the value is absent, never the empty string.

```
cellKey,outcome,reason,evidence,m.integrity,m.resolved
<taskDigest>/baseline/1,graded,,prediction=cell-1/prediction.json,true,true
<taskDigest>/sample/1,timeout,exceeded the harness's own 30 minute wall clock,,,
```

`evidence` is `name=path` pairs separated by `;`, so a path may contain neither
`;` nor `=`. CSV carries no type information at the file level, but a CSV
measurement column is not stuck as a string: each value is typed against the
sealed EvaluationSpec declaration for that measurement, so `true` in an
`m.integrity` column of a `boolean`-declared measurement imports as the boolean
`true` and produces the same verdict as the equivalent JSONL row.

## The `--template` workflow

The slate is the thing a hand-written dump gets wrong. Print it instead:

```bash
colophon run import --template \
  --workspace ./ws --principal me --draft draft-1 --format csv
```

That emits one blank row per expected coordinate, with the fixed columns and
the `m.<name>` columns each task's sealed EvaluationSpec declares. The JSONL
template leaves `outcome` blank — it is the one field you must choose — and
emits no `reason` key, because `reason` is forbidden on `graded`; add it on the
rows whose outcome requires one. Fill in the
outcomes, reasons, evidence paths, and measurements, then import:

```bash
colophon run import \
  --workspace ./ws --principal me --draft draft-1 \
  --file ./records.csv --format csv --source my-harness
```

`--format` defaults to `jsonl`. `--source` names the harness the results came
from and is sealed verbatim into the import declaration. Relative `evidence`
paths resolve against the dump file's directory, so a dump and the artifacts it
names move as one tree.

The template also removes any need for a mapping from your harness's task ids
to task digests. The sealed benchmark record cannot supply one — its items
carry a task *reference*, not a foreign id — so the coordinates in the template
are the only names import accepts.

## Named readers — Harbor and Inspect

DR-2026-09-04 decision 3: an adapter is a reader, one per harness, from that
harness's native finished output into the sealed per-attempt record. Generic
JSONL/CSV (#2979) stays as the dump dialect a named reader normalizes *into*,
not as the product path for a brought Harbor or Inspect run.

Harbor is the first named reader:

```bash
colophon run import --from harbor ./jobs \
  --workspace ./ws --principal me --draft draft-1
```

`--from harbor` takes the jobs directory, not `--file` / `--source` /
`--format`. It walks Harbor 0.21 job roots (a directory of jobs, or one job
directory) and their trial subdirectories. One finished trial becomes one
per-attempt record. Trial identity is the same mapping the orchestrated Harbor
path already uses: `harborTrialTaskName` / `assignHarborTrialAttempt` (Harbor
0.21 often omits `attempt_number`) and the suite-protocol name table in
`from-harbor.ts` (`taskNameByDigestFromSuite` / `digestByTaskNameFromSuite`).
This issue does not invent a second Harbor mapper.

Outcomes are the closed vocabulary above. On a draft bound with
`method terminal-bench-2.1`, each Task seals an `external-verifier`
EvaluationSpec that declares one measurement, `reward`. It is the same-named
key of Harbor's raw reward map, the object at `verifier_result.rewards` in the
trial `result.json`. A finished trial whose map holds that key as a finite
number is imported as `graded`, with the reward as its measurement. A whole
reward is sealed as a number and any other as a decimal string, by the number
rule above. The reader supplies no verdict. The sealed rule gives it: pass at
1, fail at 0, inconclusive for any other value. An inconclusive cell is left
out of the pass rate.

A trial is graded by its reward whatever exception Harbor also recorded. A
trial that ran to `AgentTimeoutError`, and whose work the verifier then scored,
has a reward and is graded by it. The exception stays in the
`trial-result.json` the record carries. A trial whose reward map lacks the
`reward` key, or holds something other than a finite number there, is not
graded. It is imported as `ungradeable` with a reason that names the key. The
reader never fills a reward in.

A trial with no reward map is not graded either. `AgentTimeoutError` and
`VerifierTimeoutError` are `timeout`. `RewardFileNotFoundError`,
`RewardFileEmptyError` and `VerifierOutputParseError` are `ungradeable`. Other
terminal Harbor failures are `error`. The exception type is read from
`exception_info.exception_type`, where Harbor 0.21 writes it, or from a
top-level `exception_type`. A slot the jobs directory did not contain is
written as `unrun` with a reason, so it stays in the run's accounting. There is
no exclude flag.

On a draft bound any other way no trial is graded. Its Tasks declare no
measurement that Harbor's reward could be read into, so a finished trial with a
verifier reward or a prediction artifact is imported as `ungradeable`, and this
reader does not invent measurements.

The reader accepts only a job written by Harbor 0.21.0. It is tested against a
real jobs directory of each version it accepts, and it has none of any other.
A job's version is the one its `lock.json` states (`harbor.version`). A job
that states another version, or none, is refused by name. The same file must
state `retry.max_retries` as 0, and a job `result.json` that counts retries
(`stats.n_retries`) must count 0. No real record shows how Harbor lays out a
retried trial, so a job that allowed retries is refused by name. Retries off is
Harbor's default (`harbor run --max-retries 0`). A directory that holds no job
is refused too.

More than one trial of a task fills that many replicates. Harbor does not
number the attempts of a task (`harbor run --n-attempts <k>`): they are sibling
trial directories that differ in a random suffix. The reader numbers them from
1 in code-point order of the directory names, for each arm, so the numbering
does not depend on the locale of the machine that runs the import. A run locked
with two replicates takes two trials of each task from each arm. A third trial
of a task has no slot, and the import is refused.

Timings (`started_at` / `finished_at`) and evidence paths (`result.json`,
`config.json`, `verifier/reward.txt`, prediction and trajectory artifacts) are
carried on the record. Evidence paths are relative to the jobs directory you
passed. The #2979 sealed-run window still applies: an imported timestamp must
fall at or after lock and at or before import. Harbor timestamps from a run
that finished before you locked this draft will be refused for that reason —
omit them from the trial `result.json`, or lock the Colophon run so its window
covers the Harbor times.

A trial whose Harbor task name is not on the locked slate is left as an
unknown-slot cellKey for the #2979 validator to refuse. Duplicate trials for
the same expected coordinate are likewise the validator's `duplicate-slot`.
Missing, unknown, extra, and duplicate slots are refused together, with the
whole problem list, exactly as a JSONL dump is.

Task names come from the locked run. A draft bound with
`method terminal-bench-2.1` carries the official Terminal-Bench 2.1 slate, and
each of its Tasks seals `payload.taskName`, the name Harbor writes as
`terminal-bench/<taskName>`. A name alone does not place a trial on that
slate. The trial's `task.ref` must equal the `packageRef` its Task seals, and a
job `config.json` that records a dataset `ref` must record the sealed
`datasetRevision`. A mismatch is refused with both values, so run Harbor
against the revision the slate seals:
`harbor run -d 'terminal-bench/terminal-bench-2-1@<datasetRevision>'`.
Prediction-shaped intake, including the bundled sample, uses each Task's
`payload.forecast.marketId` as the Harbor task name. A Harbor suite-protocol
selection is the name table when the locked run has one. A draft whose Tasks
carry none of these is refused by `--from harbor`; bring that run as a generic
dump with `--file`.

Each trial is placed on an arm by its Harbor agent: the arm whose id equals
the Harbor agent name, or whose pinning carries `agent.id` and `model.id` equal
to the Harbor agent name and `model_name`. The agent is read per trial, from
the trial `result.json` (`config.agent`), then the trial `config.json`, then
the job `lock.json` (`trials[].agent`), and last the job `config.json` when it
names exactly one agent. Harbor leaves its default agent out of the job
`config.json`, so that file alone cannot name the arm. The Harbor version
recorded as the import source is the one the job `lock.json` states
(`harbor.version`).

Inspect is the second named reader. Bringing a completed Inspect evaluation is
the product path; orchestrating Inspect per cell is the service's.

```bash
colophon run import --from inspect ./eval-logs \
  --workspace ./ws --principal me --draft draft-1
```

`--from inspect` takes one EvalLog file or a directory of them, not `--file` /
`--source` / `--format`. The in-process shape is Inspect's official
`read_eval_log` dump (JSON EvalLog, including Inspect `log_format=json`). One
sample becomes one per-attempt record. Sample identity is the suite-protocol
name table in `from-inspect.ts` (`sampleIdByDigestFromSuite` /
`digestBySampleIdFromSuite`). Scorer outputs are projected into the
pre-registered measurements the Inspect adapter already uses for orchestrated
cells — that can be `graded` when the sealed EvaluationSpec types those
measurements. A Harbor import is graded the same way where the Task's sealed
spec declares Harbor's reward, as every Task of the official Terminal-Bench 2.1
slate does.

A zip `.eval` container is refused rather than unpacked. Convert it with
Inspect to JSON (`log_format=json` / an EvalLog dump) so the reader stays on
the official shape without a second parser.

A slot the logs did not contain is written as `unrun` with a reason so it
stays in the denominator. Extra and duplicate samples are left for the
`#2979` validator (`unknown-slot` / `duplicate-slot`). There is no exclude
flag.

`--from inspect` pointing at an eval-log file hashes those file bytes into the
declaration and the public marker; a directory hashes the canonical JSON of
the normalized records. These readers feed the same `#2979` import declaration;
they do not change what a sealed import record means.

## What import refuses outright

Each of these is a refusal rather than a best effort, because the alternative
is fabricating the artifact a skeptic reads.

- **A draft that is not locked, or a run whose journal already has entries.**
  Import is not a merge. It writes a run's evidence from scratch and never
  extends a lineage whose dispatch numbering it did not observe.
- **An Inspect or binary-judgment adapter, except `--from inspect`.** Generic
  dumps of those runs would have to synthesize native Inspect summaries. The
  named Inspect reader brings real EvalLogs and projects sealed scorers; it
  does not invent `inspect-summary`. Binary-judgment stays refused.
- **`policy.evaluation.minVerdicts > 1`.** A dump carries one result per slot.
  Fanning it across several evaluator legs would manufacture agreement between
  evaluators that never independently existed.
- **A generic dump into a draft on the official Terminal-Bench 2.1 slate.** A
  draft bound with `method terminal-bench-2.1` accepts `--from harbor` and
  nothing else. The Harbor reader holds each trial's package ref and dataset
  revision against what the slate seals for its task. A `--file` row names a
  slot and nothing else, so `--source harbor` on a generic dump does not open
  the slate.
- **A `graded` row for a task that binds no EvaluationSpec.** There is no rule
  to check the measurements against, and the importer has no standing to supply
  one. Import it as `ungradeable` with a reason.
- **A `graded` row whose measurements the sealed verdict rule cannot read.**
  The refusal names the missing measurement.
- **A measurement name the sealed EvaluationSpec does not declare, or a value
  its declared type cannot accept.** The rule can read only declared names, so
  an undeclared one is a typo or a column with nowhere to land; a value with no
  unambiguous reading under the declared type is refused rather than guessed at.
- **An evidence path that is absolute or escapes the dump directory.** A dump
  names its own tree; it does not get to seal arbitrary host files into a
  published bundle.
- **An evidence path that is a symbolic link.** The evidence tree arrives from
  another harness, often as one archive, so a link inside it can name any file
  the importing account can read. Evidence is read no-follow; copy the file in
  instead.
- **A `startedAt` or `endedAt` outside the sealed run window.** Before the run
  was locked, after it closed, or after the import instant. An imported
  timestamp is signed into the verdict, so it cannot claim a moment the run had
  not reached.
- **A `--source` string that is empty, longer than 256 characters, padded with
  whitespace, or carrying a control character.** It is sealed verbatim into two
  annotations per cell and into the import declaration, so it gets the same
  discipline the dump's own strings get.

Every one of these is resolved before anything is written. A dump refused for
any reason leaves the draft exactly as it was — still locked, journal still
empty — so you fix the dump and import again.

## Where the imported facts live afterwards

Import seals an `ExternalRunImportDeclaration` into the workspace and records
workspace authorship over it — over the declaration only, because the workspace
genuinely authored that and did not author the external harness's evidence
bytes. It carries the source, the import time, and every row's outcome, reason,
timings, and evidence digests, and the run journal names it by digest.

The reason behind each dispatched non-graded slot also rides the sealed
submission and delivery as a namespaced annotation, so it travels inside the
bundle's `records/` closure. A slot imported as `unrun` has no
dispatch and therefore no submission to carry it: its reason stays durable in
the workspace declaration but does not travel in the bundle.
