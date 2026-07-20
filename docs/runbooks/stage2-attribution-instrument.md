# Stage 2 corpus-autoload attribution instrument

This runbook is the operator handoff for GitHub issue
[#1843](https://github.com/Jinn-Network/mono/issues/1843). The repository tool
validates and analyzes recorded facts. It does not launch a fleet, spend
inference budget, read an operator store, or interpret the result.

The ratified design is a matched 3×2 experiment:

- marketplace loadout: `seedsOnly`, `rawEvidence`, `distilled`
- treatment: corpus autoload `off`, `on`
- one preregistered primary outcome:
  `completed-with-accepted-diff`
- the same verdict-grounded task IDs in every cell
- the same pinned runtime and grader in every cell
- the same corpus snapshot in the off/on pair for each marketplace loadout

The order of `cells` in the preregistration is the frozen execution order. The
facts file must retain that order. Choose and record the order before the first
run; `executionOrderSeed` records how it was selected.

## 1. Preregister before the window opens

Create `preregistration.json` outside the repository in the operator's run
directory. It must have this exact shape:

```json
{
  "schema": "jinn.attribution-preregistration.v1",
  "instrumentId": "stage2-c12-first-readout",
  "registeredAt": "2026-07-20T08:00:00.000Z",
  "design": "matched-crossed-3x2",
  "window": {
    "startsAt": "2026-07-21T08:00:00.000Z",
    "endsAt": "2026-07-22T08:00:00.000Z"
  },
  "primaryOutcome": "completed-with-accepted-diff",
  "primaryMarketplaceArm": "rawEvidence",
  "alpha": 0.05,
  "minimumMatchedPairs": 6,
  "minimumDiscordantPairs": 6,
  "executionOrderSeed": "sha256:record-the-order-selection-seed-here",
  "runtime": {
    "modelRef": "provider/model@immutable-version",
    "harnessRef": "swe-rebench-v2.v1",
    "graderRef": "eval-semantics:immutable-version",
    "taskSourceRef": "held-out-slate:content-address",
    "sourceRevision": "git-commit-used-by-all-six-cells"
  },
  "population": {
    "instanceIds": [
      "the-first-verdict-grounded-instance",
      "the-second-verdict-grounded-instance",
      "the-third-verdict-grounded-instance",
      "the-fourth-verdict-grounded-instance",
      "the-fifth-verdict-grounded-instance",
      "the-sixth-verdict-grounded-instance"
    ]
  },
  "cells": [
    {
      "marketplaceArm": "seedsOnly",
      "autoload": "off",
      "corpusSnapshotRef": "content-address-of-seeds-snapshot"
    },
    {
      "marketplaceArm": "rawEvidence",
      "autoload": "on",
      "corpusSnapshotRef": "content-address-of-raw-evidence-snapshot"
    },
    {
      "marketplaceArm": "distilled",
      "autoload": "off",
      "corpusSnapshotRef": "content-address-of-distilled-snapshot"
    },
    {
      "marketplaceArm": "seedsOnly",
      "autoload": "on",
      "corpusSnapshotRef": "content-address-of-seeds-snapshot"
    },
    {
      "marketplaceArm": "distilled",
      "autoload": "on",
      "corpusSnapshotRef": "content-address-of-distilled-snapshot"
    },
    {
      "marketplaceArm": "rawEvidence",
      "autoload": "off",
      "corpusSnapshotRef": "content-address-of-raw-evidence-snapshot"
    }
  ]
}
```

The values above illustrate the schema; they are not a powered design or a
recommended N. Before freezing the file, the operator/statistical design owner
must select and name:

1. the real verdict-grounded task population and its content-addressed source;
2. the minimum matched-pair and discordant-pair bar;
3. one primary marketplace arm (the other two remain exploratory);
4. immutable model, harness, grader, source-revision, and corpus-snapshot refs;
5. a fixed start/end window and execution order.

Do not change the file after the first cell starts. Preserve its byte digest:

```bash
RUN_DIR=/absolute/path/to/new-c12-run-directory
PREREG="$RUN_DIR/preregistration.json"
test ! -e "$RUN_DIR/preregistration.json.sha256"
shasum -a 256 "$PREREG" > "$RUN_DIR/preregistration.json.sha256"
```

## 2. Run the six fleet cells

The fleet launcher is operator infrastructure and is intentionally not wired
into this repository command. It may spend money, use credentials, and touch
live stores; this analyzer may not.

For each preregistered cell, in the recorded order:

1. create a fresh isolated operator home and result store;
2. install exactly the cell's content-addressed corpus snapshot;
3. pin the preregistered source revision, runtime model, harness, grader, task
   source, and task IDs;
4. set `JINN_ENGINE_KNOWLEDGE_AUTOLOAD=false` for `off` or
   `JINN_ENGINE_KNOWLEDGE_AUTOLOAD=true` for `on`;
5. run the full task population without reading an interim comparison;
6. record the authoritative verdict reference, accepted-diff outcome, and
   automatically delivered refs for every instance;
7. retain logs and receipts under the cell's run directory.

Do not reuse an operator store across cells. Do not stop because one arm looks
good or bad. Do not add a repo/packet subgroup after seeing results.

## 3. Export the recorded facts

Create `facts.json` with the exact runtime and cell order from the
preregistration. One cell is shown below to make the row mapping legible; the
actual file must repeat this structure for all six preregistered cells:

```json
{
  "schema": "jinn.attribution-facts.v1",
  "instrumentId": "stage2-c12-first-readout",
  "completedAt": "2026-07-22T09:00:00.000Z",
  "runtime": {
    "modelRef": "provider/model@immutable-version",
    "harnessRef": "swe-rebench-v2.v1",
    "graderRef": "eval-semantics:immutable-version",
    "taskSourceRef": "held-out-slate:content-address",
    "sourceRevision": "git-commit-used-by-all-six-cells"
  },
  "cells": [
    {
      "marketplaceArm": "seedsOnly",
      "autoload": "off",
      "corpusSnapshotRef": "content-address-of-seeds-snapshot",
      "results": [
        {
          "instanceId": "the-first-verdict-grounded-instance",
          "passed": true,
          "unscorable": false,
          "sessionKind": "user",
          "origin": "marketplace",
          "verdictRef": "authoritative-verdict-reference",
          "deliveredRefs": []
        }
      ]
    }
  ]
}
```

Repeat the result object for every preregistered instance and repeat the cell
object for all six cells. `passed=true` means the authoritative marketplace
verdict accepted the diff; `false` means a definitive rejected outcome.
Use `passed=null, unscorable=true` only for an unscorable/infra outcome. Every
row still names the verdict-grounding reference. `deliveredRefs` contains only
refs automatically injected for that run, not the preinstalled snapshot;
autoload-off rows must therefore be empty.

The analyzer rejects:

- a window that has not closed;
- a changed runtime, cell order, snapshot, or task population;
- missing/duplicate cells or instances;
- `host-internal` or synthetic-origin observations;
- a missing verdict reference;
- delivered refs in an autoload-off observation.

## 4. Produce and preserve the first readout

Wait until `window.endsAt`, then run both renderings:

```bash
RUN_DIR=/absolute/path/to/existing-c12-run-directory
PREREG="$RUN_DIR/preregistration.json"
FACTS="$RUN_DIR/facts.json"
READOUT_JSON="$RUN_DIR/readout.json"
READOUT_MD="$RUN_DIR/readout.md"

test ! -e "$READOUT_JSON"
test ! -e "$READOUT_MD"
test ! -e "$RUN_DIR/readout-artifacts.sha256"

yarn --cwd client attribution:analyze \
  --prereg "$PREREG" \
  --facts "$FACTS" \
  --format json > "$READOUT_JSON"

yarn --cwd client attribution:analyze \
  --prereg "$PREREG" \
  --facts "$FACTS" \
  --format markdown > "$READOUT_MD"

shasum -a 256 "$PREREG" "$FACTS" "$READOUT_JSON" "$READOUT_MD" \
  > "$RUN_DIR/readout-artifacts.sha256"
```

The readout names the design, planned and matched N, preregistered bar, exact
paired McNemar facts, marginal Wilson context, runtime identity, normalized
input digests, and delivered-ref identities. `no-difference-detected` means the
preregistered bar was met but this test did not detect a directional
difference; it is not an equivalence proof. `inconclusive` means the observed
matched/discordant bar was not met.

## 5. Human-only closeout

The code/tooling task ends before these steps. The operator must:

1. review `readout.md` with the full run receipts and classify the first
   readout without widening its claim;
2. comment on issue #1843 with the design, planned N, matched N, signal, both
   normalized input digests, and an artifact link;
3. run the committed embeddings design session against this readout;
4. decide C13's interactive-holdback posture;
5. record the Stage 2 proceed/iterate/stop judgment on the tracking issue.

Passing repository tests or running the analyzer on fabricated facts does not
satisfy issue #1843 and is not the first Stage 2 readout.
