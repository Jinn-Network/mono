# External run-record import

How results a *different* harness already produced become a benchmark-product
run. You lock a run here, hand the importer one file of per-attempt records,
and the ordinary product chain — collect, report, publish — does the rest. The
bundle that comes out is not a second, weaker kind of artifact: it is the same
frozen `benchmark-product-public-bundle/2`, and the same public reader accepts
it.

[`PUBLIC-BUNDLE.md`](PUBLIC-BUNDLE.md) is the output format.
[`EXTERNAL-VERIFICATION.md`](EXTERNAL-VERIFICATION.md) is the verification
path. This document is the **input** format.

## What import claims, and what it does not

Read this table first. It is the whole point of the document.

| Claim | Status after import |
| --- | --- |
| Every slot the sealed run pre-registered is accounted for | proven — import refuses a dump that does not cover the slate exactly once |
| The matrix is the correct aggregation of the imported evidence | proven — re-derived byte-exactly by the public reader |
| Each graded cell's verdict is the sealed EvaluationSpec's own rule applied to the imported measurements | proven — recomputed at assembly and again by the reader |
| The evidence files are exactly the bytes the dump named | proven — sealed by digest, carried in the bundle |
| The external harness ran the pinned harness, model, or loadout | **not claimed** — every pinning axis reports `unverifiable` |
| Anyone here observed the attempt | **not claimed** — the evaluator identity transcribed measurements and evaluated nothing |
| The dump is a faithful record of what the external harness did | **not claimed by any tool** — it is the operator's assertion |

The verdict records say the second and third of those in their own
`limitations` field, so a reader of the bundle cannot miss it:

- This evaluator transcribed measurements produced by an external harness outside this workspace. It executed no grader, observed no attempt, and performed no evaluation of its own; the verdict is the sealed EvaluationSpec's verdict rule applied to the transcribed measurements.
- Run pinning was not observed for the imported attempt, so every pinning axis is reported unverifiable rather than matched.

The transcribing identity is `urn:jinn:colophon:external-import-transcriber/v1`,
deliberately unmistakable and distinct from every venue evaluator.

## The per-attempt record shape

One record per expected slot. Both file formats normalize to the same shape,
so a JSONL dump and the equivalent CSV dump import identically.

| Field | Type | Rule |
| --- | --- | --- |
| `cellKey` | string | Required. One coordinate from the sealed slate, verbatim. |
| `outcome` | string | Required. One of `graded`, `ungradeable`, `error`, `timeout`, `unrun`. |
| `reason` | string | Required and non-blank on every outcome except `graded`; forbidden on `graded`. |
| `startedAt` | RFC 3339 | Optional. Calendar-strict. Both-or-neither with `endedAt`. |
| `endedAt` | RFC 3339 | Optional. Calendar-strict, not before `startedAt`. |
| `durationMs` | non-negative integer | Optional. When timestamps are also given it must equal their interval. |
| `evidence` | list of `{name, path}` | Required on `graded` and `ungradeable`; forbidden otherwise. Paths are relative and resolve against the dump file's own directory; an absolute path, or one that resolves outside that directory, is refused naming the row. Names match `[A-Za-z0-9._-]{1,64}` and are unique within a record. |
| `measurements` | map of name to string, finite number, or boolean | Required on `graded`; forbidden otherwise. Names match `[A-Za-z0-9._-]{1,64}` and must be declared by the subject task's sealed EvaluationSpec. Each value is typed against that declaration before the verdict rule reads it. |

Measurement values are typed against the sealed EvaluationSpec's own
declarations, so the two dialects genuinely produce one record. A measurement
declared `boolean` accepts `true`/`false` in either dialect and the strings
`"true"`/`"false"` — nothing else, because `1` and `yes` are guesses. One
declared `number` accepts a number or a decimal string; a decimal a JS number
cannot hold exactly stays the string it was, which the verdict rule compares as
an exact decimal anyway. One declared `string` accepts only a string. Anything
else is refused, naming the measurement, the row, and the declared type.

Evidence paths may not leave the dump file's own directory. An absolute path,
or a relative one that climbs out of the tree, is refused: whatever a dump
names is sealed into the workspace and travels inside the published bundle, so
the boundary of what can be published is the directory you handed the importer.

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
a non-blank reason, and it counts in the denominator like every other slot. A
dump that omits a slot, names a slot outside the slate, or names one twice is
refused. The refusal reports **every** problem in the dump at once, grouped
missing before unknown before duplicate, then the row-level problems in row
order. Repair the whole list and re-run; there is no round-trip where each
attempt reveals one more problem.

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

## What import refuses outright

Each of these is a refusal rather than a best effort, because the alternative
is fabricating the artifact a skeptic reads.

- **A draft that is not locked, or a run whose journal already has entries.**
  Import is not a merge. It writes a run's evidence from scratch and never
  extends a lineage whose dispatch numbering it did not observe.
- **An Inspect or binary-judgment adapter.** Those bundles require native
  Inspect logs, summaries, and selection manifests. A summary synthesized from
  a foreign dump would be a forgery of exactly the artifact a reader checks.
- **`policy.evaluation.minVerdicts > 1`.** A dump carries one result per slot.
  Fanning it across several evaluator legs would manufacture agreement between
  evaluators that never independently existed.
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
published bundle's `records/` closure. A slot imported as `unrun` has no
dispatch and therefore no submission to carry it: its reason stays durable in
the workspace declaration but does not travel in the bundle.
