# Official LoCoMo judge-report run

Operator-only campaign. Success is a cold-verifiable claim of record: three
published bundles over one Run and one Matrix. Default CI and `yarn test`
never spend, never bind a live judge, and never publish.

Issue: [#2848](https://github.com/Jinn-Network/mono/issues/2848). Program
packet P9. Spec §9 in
[`docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md`](../superpowers/specs/2026-08-19-judge-path-delta-contracts.md).
Grammar:
[DR-2026-08-18-f](../../log/decisions/2026-08-18-colophon-method-cli.md)
plus its 2026-08-20 amendment. N-bundle packaging is G1-D-C option 5
(packet P5).

Older material that says `runtime inspect bind-judge` is stale. That verb
exits 2 with `unknown command "runtime inspect bind-judge"`. The bind is the
`method` file operand below.

## What this proves

A human operator, on a machine with Docker and operator-owned judge
credentials, drives the **built Colophon CLI** (core `dist/cli/bin.js`)
through import → draft pin → snapshot-serving probe → method bind → quote →
lock → freeze post → launch → collect → report → export → publish →
standalone `bundle verify`.

- Binding file is the `method` operand. No `--file`. No `--host` on this
  path. Bind writes the six-arm panel from the sealed selection.
- `k = 3` scientific replicates. Primary readout `binary-instrument@1`.
  Additional readouts `pairwise-disagreement@1` and
  `paired-majority-delta@1`. All three are pre-registered by one
  `draft update` patch. Computation is a side effect of `report`. There is
  no `method compute` verb.
- `publish --include-native-artifacts` is mandatory. Per-cell logs land at
  `native/inspect/<sha256>.eval` inside each bundle.
- `export` on a judge draft succeeds in mode `inspection-upload`. It is not
  the claim of record. Certification names the sealed Matrix `runOutcome`.
- Claim of record: one `report` emits three sealed Reports; one `publish`
  emits three bundle directories; `bundle verify --bundle <dir> [--json]`
  is standalone (no workspace, no principal). A reader checks the three
  bundles are one run by comparing `runSha256` and `matrixSha256` (equal)
  against distinct `reportSha256` and bundle identity.

## Out of scope

- Catalog-suite qualify (`terminal-bench-3.0`, SWE-bench Verified, APEX,
  Inspect eval `one_task`)
- Wiring this into CI
- Secrets, API keys, or bank bytes in this repository
- Treating `export` or workspace `verify` as the claim of record
- Restarting after a second infrastructure failure without a dated public
  amendment in the thread

## 1. Built CLI and workspace

Workspace lives **outside** the repo.

```bash
cd packages/benchmark-product/core
yarn build
COLOPHON="$(pwd)/dist/cli/bin.js"
WS=/tmp/colophon-judge-official
DRAFT=locomo-judge
mkdir -p "$WS"
```

```bash
node "$COLOPHON" init --workspace "$WS" --principal operator
node "$COLOPHON" draft create --workspace "$WS" --principal operator \
  --name "LoCoMo judge official" --id "$DRAFT"
```

Omitted `method` ref lists the catalog (not a bind, not this run):

```bash
node "$COLOPHON" method --json
```

Catalog-id binds (not this run) use the four-flag surface. `--n`,
`--slice`, `--ids`, and `--host` are catalog-id-only and are refused on a
file operand. Pass exactly one of `--slice`, `--ids`, or `--n`; `--host` is
required:

```bash
node "$COLOPHON" method terminal-bench-3.0 --workspace "$WS" --principal operator \
  --draft <catalog-draft-id> --slice 1 --host "$WS/host.json"
```

Write operand-first on every `method` line, including the judge bind.

## 2. Credential and spend

Operator-owned. No secrets in the repo, no secrets in the sealed
selection, no secrets in the published bundle.

The judge adapter is OCI. The broker reads the OpenAI key from a host file
the runtime host supplies (mounted at `/run/secrets/openai-api-key` inside
the broker, never into the worker argv). Keep that file outside the
workspace and outside git. `agent credentials` is the Claude Code / Codex
grant path; this run does not use it.

Spend is authorized against the posted call budget (~5,300 calls) before
G4. `quote` prints `expectedCellCount`. Do not launch above the authorized
budget.

Identity and plumbing preflight is an operator action within the
setup-call budget, immediately before bind: confirm the dated-snapshot
model is the identity the freeze named, on the same provider path the
broker will use. There is no Colophon verb for that check. Record the
resolved identity with the freeze notes.

## 3. Import the admitted bank

Admission closure is a G4 box. The operator imports the already-admitted
bank; screening and hand-check are research-side and already done.

Paths below are operator paths, not repo paths.

```bash
node "$COLOPHON" import item-bank --workspace "$WS" --principal operator \
  --profile binary-judgment@2 --draft "$DRAFT" \
  --items "$WS/items.jsonl" --sources "$WS/sources.jsonl" \
  --admissions "$WS/admissions.jsonl" --json
```

`--profile` must be `binary-judgment@2`. Success: imported N admitted
binary items as a benchmark; excluded and held-back counts printed.

If a last-mile human-truth admit is still required on this draft:

```bash
node "$COLOPHON" human-review admit --workspace "$WS" --principal operator \
  --draft "$DRAFT" --file "$WS/admission-manifest.json" --json
```

## 4. Pin k, analyses, retry, and floor

Set only via `draft update --file`. No `--replicates` flag. No `--method`
flag. `k` is `replicates` (derived into analysis parameters at lock;
caller-supplied `parameters.k` is refused). Patch keys replace wholesale:
include the full `assurance` and `policy` objects.

```bash
cat > "$WS/draft-pin.json" <<'EOF'
{
  "replicates": 3,
  "analysis": {
    "method": "jinn.benchmarking.method/binary-instrument",
    "version": "1"
  },
  "additionalAnalyses": [
    {
      "method": "jinn.benchmarking.method/pairwise-disagreement",
      "version": "1"
    },
    {
      "method": "jinn.benchmarking.method/paired-majority-delta",
      "version": "1"
    }
  ],
  "assurance": {
    "preset": "direct-check",
    "overrides": { "maxInfrastructureRetries": 1 }
  },
  "policy": {
    "completenessFloor": "1",
    "cellWindowMs": 3600000,
    "replacement": { "allowed": false },
    "closeAfterMs": 86400000
  }
}
EOF

node "$COLOPHON" draft update --workspace "$WS" --principal operator \
  --draft "$DRAFT" --file "$WS/draft-pin.json"
node "$COLOPHON" draft show --workspace "$WS" --principal operator \
  --draft "$DRAFT" --json
```

Success: `replicates` is 3; primary analysis is
`jinn.benchmarking.method/binary-instrument` version `1`;
`additionalAnalyses` names the two companions above;
`assurance.overrides.maxInfrastructureRetries` is 1;
`policy.completenessFloor` is `"1"`. Do this before quote.

## 5. Snapshot-serving probe, then bind

The probe is a lock input. Run it immediately before bind. Bind refuses
`outcome: "not-serving"` (typed `conflict`; that branch changes the design
in public first), a `probedAt` in the future relative to the bind clock,
or a probe older than 24 hours (`SNAPSHOT_PROBE_MAX_AGE_MS`). Required
when any bound arm's model is a dated snapshot; forbidden otherwise.

Probe shape (sealed by the profiles package, carried on the binding file):

```
protocol: "https://spec.jinn.network/binary-judgment/snapshot-serving-probe/v1"
requestedModel / resolvedModel / responseId / eventSha256 / probedAt / outcome
```

`outcome` is `"serving"` if and only if `resolvedModel === requestedModel`.
Put the probe object on the binding as `snapshotProbe` and its sealed
digest on the manifest as `snapshotProbeSha256`. Host binding stays inside
the same file (`host.dockerPath` must be absolute).

```bash
node "$COLOPHON" method "$WS/judge-binding.json" --workspace "$WS" --principal operator \
  --draft "$DRAFT" --json
```

Success: `bound custom inspect-binary-judge method <selectionManifestSha256>`.
The selection digest flows into `draft.spec.evaluationRuntime.selectionManifestSha256`
and from there into the sealed Run at lock.

## 6. Quote, then lock

```bash
node "$COLOPHON" quote --workspace "$WS" --principal operator --draft "$DRAFT" --json
node "$COLOPHON" lock --workspace "$WS" --principal operator --draft "$DRAFT" --json
```

`--ack-provider-network-costs` is required only when a draft arm is a
Claude Code or Codex agent. This judge bind does not use those harnesses.

Success: quote `ok=true` with `expectedCellCount` inside the authorized
budget; lock prints `locked draft locomo-judge: run <runSha256>, closes <closeAt>`.
That `runSha256` is the top-level lock digest for the freeze post.

## 7. Freeze post and OpenTimestamps

Do this after lock, before launch. Judging has not started.

The freeze comment carries three things and nothing else that is
load-bearing:

1. Archive URL of the public freeze registration (a link alone can point at
   mutable content; the archive is the registration pointer).
2. The top-level lock digest inline in the comment body (the `runSha256`
   from lock).
3. One-sentence immutability clause: `Nothing in the sealed freeze moves once judging starts.`

Independently timestamp the same lock digest with OpenTimestamps. The stamp
lives outside the bundle.

```bash
printf '%s\n' "$LOCK_DIGEST" > "$WS/lock-digest.txt"
ots stamp "$WS/lock-digest.txt"
```

Keep `$WS/lock-digest.txt.ots` with the operator freeze notes, not inside
the published bundle.

## 8. Launch, status, and the run-stop rule

```bash
node "$COLOPHON" launch --workspace "$WS" --principal operator --draft "$DRAFT"
node "$COLOPHON" status --workspace "$WS" --principal operator --draft "$DRAFT" --json
```

Run-stop is an operator action. Engineering makes the stop visible in
artifacts. First retryable infrastructure failure on a cell leg consumes
the sealed retry (`maxInfrastructureRetries: 1`). A second failure on the
same cell leg terminalizes it as `could-not-grade` with `failureCategory`,
which forces Matrix `runOutcome: "partial"` when the run is collected
without a cancel marker. Do not `resume` after that. Do not keep spending.
Post a dated public amendment in the thread before any restart.

Reporting vocabulary for those cells (journal category → report class):

| Journal `category` | Report class |
|---|---|
| `backend-unavailable` | `provider-unavailable` |
| `dependency-unavailable` | `broker-error` |
| `transport-failure` | `transport-timeout` |

Integrity failures (`invalid-evaluator-output`, `subject-digest-mismatch`,
`subject-not-found`) map to no class, terminalize `could-not-grade` with
`failureCategory`, and are never retried.

`cancel` aborts remaining dispatch and seals `runOutcome: "cancelled"`
instead of `partial`. Use it only when remaining cells must not dispatch.

```bash
node "$COLOPHON" cancel --workspace "$WS" --principal operator --draft "$DRAFT"
```

## 9. Collect, report, export, publish, verify

Order is fixed. `report` computes the three pre-registered methods.
`export` is inspection-upload, not the claim of record. `publish` plus
`bundle verify` is the claim of record.

```bash
node "$COLOPHON" collect --workspace "$WS" --principal operator --draft "$DRAFT" --json
node "$COLOPHON" report --workspace "$WS" --principal operator --draft "$DRAFT" --json
node "$COLOPHON" arm list --workspace "$WS" --principal operator --draft "$DRAFT"
```

For each `armId` from `arm list`:

```bash
node "$COLOPHON" export --workspace "$WS" --principal operator --draft "$DRAFT" \
  --arm "$ARM" --json
```

Export success: `exported inspect-view (inspection-upload)`. Instructions
include the completeness certification naming the sealed Matrix
`runOutcome` and counts (`complete|partial|cancelled` run of the selection
sealed at lock `<runSha256>: <judged> of <expected> cells judged`). Logs
plus `INSTRUCTIONS.txt` land at
`$WS/artifacts/inspect/view-bundle/$DRAFT/<armId>/`.

```bash
node "$COLOPHON" publish --workspace "$WS" --principal operator --draft "$DRAFT" \
  --include-native-artifacts --json
```

Without `--include-native-artifacts`, publish refuses. Human-mode stdout
names the canonical bundle; `--json` also carries `additionalBundles`
(P5). Three sibling directories:

```
$WS/artifacts/$DRAFT/public-bundles/<manifest-sha256>
```

Per-cell `.eval` logs: `native/inspect/<sha256>.eval` inside each bundle.

```bash
node "$COLOPHON" bundle verify --bundle "$BUNDLE_DIR" --json
```

Repeat for each of the three directories. No `--workspace`. No
`--principal`. Success: `verified public bundle <identity>` with the
verifier checks present.

Workspace `verify` is not the claim of record:

```bash
node "$COLOPHON" verify --workspace "$WS" --principal operator --draft "$DRAFT" --json
```

## 10. Three-bundle reader check

A reader with only the published directories, no workspace, confirms one
run. Equal `runSha256` and `matrixSha256` across all three;
`reportSha256` and bundle identity distinct.

```bash
node --input-type=module - <<'JS'
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.BUNDLES_ROOT;
const dirs = readdirSync(root).map((name) => join(root, name));
if (dirs.length !== 3) {
  throw new Error(`expected 3 bundle directories, found ${dirs.length}`);
}
const records = dirs.map((dir) => {
  const claim = JSON.parse(readFileSync(join(dir, "claim-package.json"), "utf8"));
  return { identity: dir, ...claim.records };
});
const runs = new Set(records.map((row) => row.runSha256));
const matrices = new Set(records.map((row) => row.matrixSha256));
const reports = new Set(records.map((row) => row.reportSha256));
if (runs.size !== 1 || matrices.size !== 1) {
  throw new Error("runSha256 and matrixSha256 must be equal across bundles");
}
if (reports.size !== 3) {
  throw new Error("reportSha256 must be distinct per bundle");
}
process.stdout.write(`${JSON.stringify({ ok: true, runSha256: [...runs][0], matrixSha256: [...matrices][0], reportSha256: [...reports] }, null, 2)}\n`);
JS
```

Set `BUNDLES_ROOT="$WS/artifacts/$DRAFT/public-bundles"`.

## 11. G4 go/no-go

Every box, then the operator calls it. Reproduced from program §6, not
redesigned.

1. G2 and G3 green on `next` (P5 N-bundle landed, or its companion-analysis
   fallback disclosed).
2. Research-side: bank built with reserve; screening pass complete; flagged
   items plus random sample hand-checked; agreement rate computed;
   exclusions listed; admission closure complete; seeded sampling script
   sealed; corrupt-key module (20 × 2) and gate probes (12) built.
3. Freeze manifest cut; freeze post carries the archive URL, the inline
   lock digest, the immutability clause, and the out-of-band OTS stamp.
4. In-thread asks closed: missing-judges question (silence keeps the
   default), the Backboard prompt's provenance recorded per the license
   brief, per-prompt license register sealed.
5. Live preflights green and recorded as lock inputs: snapshot-serving
   probe immediately before the run; identity/plumbing preflight within
   the setup-call budget.
6. Spend authorized against the posted call budget (~5,300 calls);
   credential custody confirmed.
7. Zero pending design deltas. Anything that changes the posted design is
   a dated amendment in the thread **before** the run.
8. Interpretation table already sealed (it is part of the posted design).

Do not launch until every box is true.
