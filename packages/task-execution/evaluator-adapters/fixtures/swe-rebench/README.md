# swe-rebench fixtures

Behavioral oracles for the swe-rebench parser (Task 4). Composition design §6.6: legacy
behavior enters this package as test fixtures and assertions only — no file under
`client/src/harnesses/impls/swe-rebench-v2-evaluator/` is ported, copied, or adapted as code.
The 18 entries in `../../src/swe-rebench/fixtures.ts` (`SWE_REBENCH_FIXTURES`) are each cited
to the exact legacy file and line range they were transcribed from; every citation was checked
against the real legacy bytes before this fixture module was written (see §Provenance
corrections below for the two the plan got wrong).

## The two upstream report shapes

`client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:6-13` documents the two
shapes of one `report.json` → `items[]` entry, produced by the upstream SWE-rebench-V2
`scripts/eval.py`:

- **success**: `{ instance_id, from_fail_to_pass, failed_from_pass_to_pass, passed_match,
  exit_code, log_path, error: "" }`
- **setup error**: `{ instance_id, from_fail_to_pass: [], failed_from_pass_to_pass: [...all
  PASS_TO_PASS...], error: "<message>" }` (no `exit_code` / `passed_match` / `log_path`)

Both shapes are constructed by `build_report_item` in the upstream stub at
`client/test/harnesses/impls/swe-rebench-v2-evaluator/fixtures/eval.py:356-382` — the success
shape at `:374-382`, the setup-error shape at `:363-368`.

## Resolution rule

`eval-runner.ts:555-559`: a report is **resolved** (verdict `passed: true`) iff every declared
`failToPass` transition now passes *and* no declared `passToPass` transition broke. This is a
deliberate re-derivation, not a trust of the upstream `passed_match` field — the doc comment at
`eval-runner.ts:14-21` explains why: `passed_match` is an exact-set comparison (`{observed
passing tests} == {FAIL_TO_PASS ∪ PASS_TO_PASS}`), which makes any instance whose test command
runs extra tests structurally unscorable and penalizes a solver for adding a passing test.
`asStringArray` (`eval-runner.ts:251-253`) filters non-string entries out of the transition
arrays before the comparison, so a malformed report can't manufacture a false resolution by
smuggling non-string noise into `from_fail_to_pass` / `failed_from_pass_to_pass`.

## Ungradeable rule

`eval-runner.ts:539-553`: a report is ungradeable-by-infrastructure-signature iff the container
exited non-zero **and** no expected test of either kind was observed to pass (`from_fail_to_pass`
empty and every declared `passToPass` landed in `failed_from_pass_to_pass`) **and** the captured
output (`stdout` + container log, tail-capped by `capLogTail`, `eval-runner.ts:256-261`) matches
one of the `INFRA_SIGNATURES` regexes (`eval-runner.ts:216-242`). A genuine wrong-answer run
still shows the `failToPass` test failing inside a normal pytest report with no infra signature,
and a partially-passing run is clearly a real result — both go through as graded verdicts, never
ungradeable.

Two further paths raise `EvalCouldNotGradeError` outside that gate:

- the upstream item carries a non-empty `error` string (setup-error shape) →
  `eval_setup_error` (`eval-runner.ts:496-500`);
- the item lacks a numeric `exit_code` (including a degenerate/non-object item, which defaults
  to `{}` via `items.find(...) ?? items[0] ?? {}`) → `eval_report_malformed`
  (`eval-runner.ts:491-507`).

And two paths short-circuit before an item is ever extracted (added per Task 2 finding E3 — not
covered by a fixture here, since Task 3's fixture list is scoped to report/log inputs, not
process-level timeout/parse failure):

- the eval subprocess exceeds its wall-clock timeout → `eval_timeout` (`eval-runner.ts:470-476`);
- `report.json` never parses as JSON at all → `matchInfraSignature(stderr + stdout) ??
  'eval_no_report'` (`eval-runner.ts:478-489`).

## Provenance corrections

Two of the plan's cited ranges did not support the fixture they were attached to; both were
verified against the real files and corrected before this module shipped:

1. **`adversarial-report-is-not-an-object`** cited `eval-runner.ts:478-489`. That range is the
   `JSON.parse` **failure** branch (unparseable/missing `report.json`), which throws
   `matchInfraSignature(...) ?? 'eval_no_report'` — a different reason code than the fixture
   expects. The branch that actually classifies a non-object/malformed report *item* (parsed
   successfully as JSON, but not shaped as an item) as `eval_report_malformed` is
   `eval-runner.ts:491-507`. Corrected to that range.
2. **`adversarial-truncated-log-with-no-marker`** carried `failed_from_pass_to_pass: []`,
   which fails the `noTestPassed` gate (`eval-runner.ts:546-547`, since the declared
   `passToPass` test isn't reported as broken) before `matchInfraSignature` is ever called —
   so the fixture reached its expected outcome (`graded, passed: false`) via the ordinary
   resolution-rule path, not by actually exercising log-signature matching against a truncated,
   marker-less log as its name claims. Corrected the report so the declared `passToPass` test is
   reported broken, opening the gate: the truncated log is now genuinely matched against
   `INFRA_SIGNATURES`, finds no signature, and falls through to the same graded-failure outcome
   for the right reason.

Four more citations (the `venv_collision` / `pytest_missing` / `requests_dep_mismatch` /
`conftest_import_error` triage-constant fixtures) were each off by two lines from the real
`eval-runner.test.ts` declarations — the plan undercounted the section's leading comment and
blank lines. Corrected to the verified line numbers (`:578-582`, `:584-585`, `:587-588`,
`:590-591` respectively); the fixture *content* (the literal fingerprint strings) was already
byte-accurate.

One citation in the Task 3 plan prose (not attached to a specific fixture) pointed at
`client/test/harnesses/impls/swe-rebench-v2-evaluator/fixtures/eval.py:88-101` for "the two
upstream report shapes". Those lines are HF-rows pagination logic (`load_specs_from_hf`),
unrelated to report-item construction. The real report-shape logic is `build_report_item` at
`fixtures/eval.py:356-382`, cited above.

## Coverage gap (not fixed here)

Per Task 2 finding E3, the semantics document's `ungradeable.classes` list includes
`eval_timeout` and `eval_no_report` (real `EvalCouldNotGradeError` reason codes at
`eval-runner.ts:470-476` and `:478-489`), but neither has a fixture in this module — both are
process-level failures (subprocess wall-clock timeout; `report.json` never parses) rather than
report/log content the parser inspects, and the plan's 18-fixture list did not include them.
Task 4 (the parser) should decide whether these two classes are even reachable from a
`GraderReportSource`-supplied report, or whether they can only ever originate upstream of the
parser boundary.
