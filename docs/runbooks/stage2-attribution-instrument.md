# Stage 2 daemon-autoload attribution instrument

This is the operator handoff for the analyzer shipped by
[#1899](https://github.com/Jinn-Network/mono/issues/1899). The real fleet run,
first readout, and interpretation remain Human-owned on
[#1843](https://github.com/Jinn-Network/mono/issues/1843). This tooling does
not complete or close #1843.

The capability audit on #1843 re-anchored the executable design to a matched
daemon-level 1×2 experiment: the same frozen verdict-grounded tasks and corpus
snapshot, with `JINN_ENGINE_KNOWLEDGE_AUTOLOAD=false` versus `true`. The older
pilot 3×2 proposal is not executable because that path never constructs the
daemon `TaskEngine`.

The analyzer is read-only. It does not launch a fleet, spend inference budget,
read an operator store, or use credentials.

## 1. Isolate the run

```bash
set -euo pipefail
RUN_DIR=/absolute/path/to/new-daemon-autoload-run
umask 077
test ! -e "$RUN_DIR"
mkdir -p "$RUN_DIR/cells/off" "$RUN_DIR/cells/on"
```

Keep `.env` files, API tokens, keys, wallets, and seed phrases outside
`RUN_DIR`; every retained file under `cells/` is hashed.

## 2. Preregister before the window opens

Create `"$RUN_DIR/preregistration.json"` with this schema and real immutable
values:

```json
{
  "schema": "jinn.attribution-preregistration.v1",
  "instrumentId": "stage2-daemon-autoload-first-readout",
  "registeredAt": "2026-07-20T08:00:00.000Z",
  "design": "matched-daemon-autoload-1x2",
  "window": {
    "startsAt": "2026-07-21T08:00:00.000Z",
    "endsAt": "2026-07-22T08:00:00.000Z"
  },
  "primaryOutcome": "completed-with-accepted-diff",
  "alpha": 0.05,
  "minimumMatchedPairs": 6,
  "minimumDiscordantPairs": 6,
  "executionOrderSeed": "recorded-randomization-seed",
  "runtime": {
    "modelRef": "provider/model@immutable-version",
    "harnessRef": "daemon-task-engine.v1",
    "graderRef": "eval-semantics:immutable-version",
    "taskSourceRef": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sourceRevision": "git-commit-used-by-both-cells"
  },
  "population": {
    "instanceIds": ["task-1", "task-2", "task-3", "task-4", "task-5", "task-6"]
  },
  "cells": [
    {
      "autoload": "off",
      "corpusSnapshotRef": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "treatmentConfigDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    {
      "autoload": "on",
      "corpusSnapshotRef": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "treatmentConfigDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  ]
}
```

The execution order is derived from `sha256(executionOrderSeed)`: an even low
bit means `off,on`; an odd low bit means `on,off`. Order the `cells` array to
match that derivation. The same snapshot must be used in both cells; the
treatment-config digests must differ. Select the real population,
reachable matched/discordant bar, runtime revisions, window, and seed before
the first attempt. The exact analyzer supports at most 1023 instances.

Before freezing, derive the order independently and require the JSON array to
match:

```bash
set -euo pipefail
PREREG="$RUN_DIR/preregistration.json"
DERIVED_CELL_ORDER="$(
  node -e \
    'const {createHash}=require("crypto");const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const odd=createHash("sha256").update(p.executionOrderSeed,"utf8").digest()[0]&1;process.stdout.write((odd?["on","off"]:["off","on"]).join(","))' \
    "$PREREG"
)"
RECORDED_CELL_ORDER="$(
  node -e \
    'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(p.cells.map((cell)=>cell.autoload).join(","))' \
    "$PREREG"
)"
test "$DERIVED_CELL_ORDER" = "$RECORDED_CELL_ORDER"
printf 'Frozen cell order: %s\n' "$DERIVED_CELL_ORDER"
```

Freeze the bytes:

```bash
set -euo pipefail
set -C
PREREG="$RUN_DIR/preregistration.json"
PREREG_DIGEST="$RUN_DIR/preregistration.json.sha256"
TMP="$RUN_DIR/.preregistration.json.sha256.tmp"
test -s "$PREREG"
test ! -e "$PREREG_DIGEST"
test ! -e "$TMP"
trap 'rm -f "$TMP"' EXIT
shasum -a 256 "$PREREG" > "$TMP"
ln "$TMP" "$PREREG_DIGEST"
rm "$TMP"
chmod 0444 "$PREREG" "$PREREG_DIGEST"
trap - EXIT
```

Before the window opens or any solve runs, publish the frozen bytes to #1843.
GitHub authentication must already be configured. The comment is append-only:
never edit it; append a correction and restart with a new run directory.

```bash
set -euo pipefail
set -C
ANCHOR_BODY="$RUN_DIR/preregistration-anchor-comment.md"
ANCHOR_RECORD="$RUN_DIR/preregistration.anchor"
ANCHOR_DIGEST="$RUN_DIR/preregistration-anchor.sha256"
BODY_TMP="$RUN_DIR/.preregistration-anchor-comment.md.tmp"
RECORD_TMP="$RUN_DIR/.preregistration.anchor.tmp"
DIGEST_TMP="$RUN_DIR/.preregistration-anchor.sha256.tmp"
test ! -e "$ANCHOR_BODY"
test ! -e "$ANCHOR_RECORD"
test ! -e "$ANCHOR_DIGEST"
test ! -e "$BODY_TMP"
test ! -e "$RECORD_TMP"
test ! -e "$DIGEST_TMP"
trap 'rm -f "$BODY_TMP" "$RECORD_TMP" "$DIGEST_TMP"' EXIT
(cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
PREREG_HEX="$(shasum -a 256 "$PREREG" | awk '{print $1}')"
{
  printf '%s\n\n' '<!-- stage2-daemon-autoload-preregistration-v1 -->'
  printf 'Frozen preregistration SHA-256: `sha256:%s`\n\n' "$PREREG_HEX"
  printf '%s\n\n' 'The following bytes were frozen before the first solve:'
  printf '%s\n' '<pre>'
  cat "$PREREG"
  printf '\n%s\n' '</pre>'
} > "$BODY_TMP"
LOCAL_BODY_BASE64="$(base64 < "$BODY_TMP" | tr -d '\n')"
ANCHOR_URL="$(
  gh issue comment 1843 --repo Jinn-Network/mono --body-file "$BODY_TMP"
)"
case "$ANCHOR_URL" in
  https://github.com/Jinn-Network/mono/issues/1843#issuecomment-[0-9]*) ;;
  *) printf 'unexpected anchor URL: %s\n' "$ANCHOR_URL" >&2; exit 1 ;;
esac
ANCHOR_COMMENT_ID="${ANCHOR_URL##*-}"
REMOTE_BODY_BASE64="$(
  gh api "repos/Jinn-Network/mono/issues/comments/$ANCHOR_COMMENT_ID" \
    --jq '.body | @base64'
)"
test "$LOCAL_BODY_BASE64" = "$REMOTE_BODY_BASE64"
REMOTE_ISSUE_URL="$(
  gh api "repos/Jinn-Network/mono/issues/comments/$ANCHOR_COMMENT_ID" \
    --jq '.issue_url'
)"
test "$REMOTE_ISSUE_URL" = \
  "https://api.github.com/repos/Jinn-Network/mono/issues/1843"
ANCHOR_CREATED_AT="$(
  gh api "repos/Jinn-Network/mono/issues/comments/$ANCHOR_COMMENT_ID" \
    --jq '.created_at'
)"
ANCHOR_UPDATED_AT="$(
  gh api "repos/Jinn-Network/mono/issues/comments/$ANCHOR_COMMENT_ID" \
    --jq '.updated_at'
)"
test "$ANCHOR_CREATED_AT" = "$ANCHOR_UPDATED_AT"
WINDOW_STARTS_AT="$(
  node -e \
    'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).window.startsAt)' \
    "$PREREG"
)"
node -e \
  'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)process.exit(1)' \
  "$ANCHOR_CREATED_AT" "$WINDOW_STARTS_AT"
ln "$BODY_TMP" "$ANCHOR_BODY"
rm "$BODY_TMP"
BODY_HEX="$(shasum -a 256 "$ANCHOR_BODY" | awk '{print $1}')"
{
  printf 'comment_url=%s\n' "$ANCHOR_URL"
  printf 'comment_created_at=%s\n' "$ANCHOR_CREATED_AT"
  printf 'comment_updated_at=%s\n' "$ANCHOR_UPDATED_AT"
  printf 'preregistration_sha256=sha256:%s\n' "$PREREG_HEX"
  printf 'comment_body_sha256=sha256:%s\n' "$BODY_HEX"
} > "$RECORD_TMP"
ln "$RECORD_TMP" "$ANCHOR_RECORD"
rm "$RECORD_TMP"
(cd "$RUN_DIR" && shasum -a 256 \
  preregistration-anchor-comment.md preregistration.anchor) > "$DIGEST_TMP"
ln "$DIGEST_TMP" "$ANCHOR_DIGEST"
rm "$DIGEST_TMP"
chmod 0444 "$ANCHOR_BODY" "$ANCHOR_RECORD" "$ANCHOR_DIGEST"
trap - EXIT
```

## 3. Run the two daemon cells

The fleet launcher remains operator infrastructure. For each cell, in the
frozen order:

1. use a fresh disposable `JINN_AGENT_HOME`, daemon run ID, and operator store;
2. install the exact frozen corpus snapshot;
3. pin the preregistered source, model, TaskEngine harness, grader, and tasks;
4. apply the recorded treatment configuration and set
   `JINN_ENGINE_KNOWLEDGE_AUTOLOAD=false` or `true`;
5. run the complete population without inspecting intermediate comparisons;
6. retain one immutable receipt per observation under `cells/off` or
   `cells/on`.

Each receipt must be JSON with the following outer fields. Both envelope
objects must be complete canonical signed `jinn.execution.v1` exports from the
runner; the placeholder hexadecimal values below illustrate the joins and
must never be hand-filled:

```json
{
  "schema": "jinn.attribution-verdict-receipt.v1",
  "instrumentId": "stage2-daemon-autoload-first-readout",
  "autoload": "off",
  "corpusSnapshotRef": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "treatmentConfigDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "runtime": {
    "modelRef": "provider/model@immutable-version",
    "harnessRef": "daemon-task-engine.v1",
    "graderRef": "eval-semantics:immutable-version",
    "taskSourceRef": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sourceRevision": "git-commit-used-by-both-cells"
  },
  "isolation": {
    "runId": "unique-daemon-run-id",
    "agentHomeDigest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "storeDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  },
  "cellStartedAt": "2026-07-21T08:00:00.000Z",
  "cellCompletedAt": "2026-07-21T12:00:00.000Z",
  "instanceId": "task-1",
  "startedAt": "2026-07-21T08:05:00.000Z",
  "completedAt": "2026-07-21T08:15:00.000Z",
  "sessionKind": "user",
  "origin": "marketplace",
  "verdictProof": {
    "schema": "jinn.attribution-marketplace-verdict-proof.v1",
    "marketplace": {
      "attempt": {
        "chainId": 84532,
        "taskId": "123",
        "attemptIndex": 0,
        "requestId": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "operator": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "evidenceHash": "0x3333333333333333333333333333333333333333333333333333333333333333"
      },
      "verdict": {
        "chainId": 84532,
        "taskId": "123",
        "attemptIndex": 0,
        "verdictIndex": 0,
        "requestId": "0x2222222222222222222222222222222222222222222222222222222222222222",
        "evaluator": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "verdictCode": 1,
        "evidenceHash": "0x4444444444444444444444444444444444444444444444444444444444444444"
      }
    },
    "solutionEnvelope": {
      "schemaVersion": "jinn.execution.v1",
      "solverType": "swe-rebench-v2.v1",
      "role": "solution",
      "generatedAt": 1753088400000,
      "task": {
        "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3pt5gnxjywjd5dpgzud42n5by",
        "onchainCreationTx": "0x5555555555555555555555555555555555555555555555555555555555555555",
        "onchainCreationBlock": 123,
        "requestId": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "instanceId": "task-1",
        "repo": "owner/repository",
        "baseCommit": "git-commit-used-by-both-cells"
      },
      "participant": {
        "safeAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "agentEoa": "0xcccccccccccccccccccccccccccccccccccccccc"
      },
      "window": {
        "startTs": 1753088000000,
        "endTs": 1753095200000
      },
      "executor": {
        "implName": "codex",
        "implVersion": "immutable-version",
        "clientGitSha": "git-commit-used-by-both-cells",
        "codeDigest": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        "runtimeBundleDigest": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
        "plugins": [],
        "signingKey": {
          "kind": "agent-eoa",
          "pubkey": "0xcccccccccccccccccccccccccccccccccccccccc"
        },
        "mode": "frozen"
      },
      "evidenceTier": "committed",
      "attestation": null,
      "trajectory": null,
      "artifacts": [],
      "payload": {
        "schemaVersion": "swe-rebench-v2-solution.v1",
        "patch": "complete accepted-diff candidate"
      },
      "distributionClass": "restricted-tos",
      "signature": {
        "algo": "secp256k1",
        "signer": "0xcccccccccccccccccccccccccccccccccccccccc",
        "hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
        "sig": "0xcomplete-canonical-signature-from-runner"
      }
    },
    "verdictEnvelope": {
      "schemaVersion": "jinn.execution.v1",
      "solverType": "swe-rebench-v2.v1",
      "role": "verdict",
      "generatedAt": 1753088500000,
      "task": {
        "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3pt5gnxjywjd5dpgzud42n5by",
        "onchainCreationTx": "0x5555555555555555555555555555555555555555555555555555555555555555",
        "onchainCreationBlock": 123,
        "requestId": "0x2222222222222222222222222222222222222222222222222222222222222222",
        "instanceId": "task-1",
        "repo": "owner/repository",
        "baseCommit": "git-commit-used-by-both-cells"
      },
      "participant": {
        "safeAddress": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "agentEoa": "0xdddddddddddddddddddddddddddddddddddddddd"
      },
      "window": {
        "startTs": 1753088000000,
        "endTs": 1753095200000
      },
      "executor": {
        "implName": "swe-rebench-v2-evaluator",
        "implVersion": "immutable-version",
        "clientGitSha": "git-commit-used-by-both-cells",
        "codeDigest": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
        "runtimeBundleDigest": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        "plugins": [],
        "signingKey": {
          "kind": "agent-eoa",
          "pubkey": "0xdddddddddddddddddddddddddddddddddddddddd"
        },
        "mode": "frozen"
      },
      "evidenceTier": "committed",
      "attestation": null,
      "trajectory": null,
      "artifacts": [],
      "payload": {
        "schemaVersion": "swe-rebench-v2-verdict.v1",
        "score": 1,
        "passed_match": true,
        "evaluator_cost_usd": 0.01
      },
      "distributionClass": "restricted-tos",
      "signature": {
        "algo": "secp256k1",
        "signer": "0xdddddddddddddddddddddddddddddddddddddddd",
        "hash": "0x4444444444444444444444444444444444444444444444444444444444444444",
        "sig": "0xcomplete-canonical-signature-from-runner"
      }
    }
  },
  "deliveredRefs": [],
  "cost": {
    "inputTokens": 12345,
    "outputTokens": 2345,
    "usdMicros": 67890,
    "usdMicrosEstimated": false
  }
}
```

Stop and file separate receipt-wiring work if the daemon cannot export these
facts. Do not hand-fill them. The analyzer authenticates both canonical
envelopes and requires exact request, participant Safe, instance, tuple, and
evidence-hash joins. The marketplace convention is `Pass = 1` and `Fail = 2`;
the embedded `verdictCode` must agree with the authenticated signed
`passed_match`. This is a consistency constraint: the signed verdict payload
remains the sole authority for `acceptedDiff`, and the embedded marketplace
rows never independently authenticate or determine the outcome. Off-cell
receipts must have no delivered refs. Cost is the attempt's recorded nonnegative
input/output token usage and USD-micro total; mark the USD value estimated when
the daemon has no final actual-cost row.

## 4. Freeze evidence and export facts

```bash
set -euo pipefail
set -C
CELL_EVIDENCE="$RUN_DIR/cell-evidence.sha256"
TMP="$RUN_DIR/.cell-evidence.sha256.tmp"
test ! -e "$CELL_EVIDENCE"
test ! -e "$TMP"
trap 'rm -f "$TMP"' EXIT
(cd "$RUN_DIR" && find cells -type f -exec shasum -a 256 {} + \
  | LC_ALL=C sort -k 2) > "$TMP"
test -s "$TMP"
ln "$TMP" "$CELL_EVIDENCE"
rm "$TMP"
chmod 0444 "$CELL_EVIDENCE"
trap - EXIT
EVIDENCE_MANIFEST_DIGEST="sha256:$(shasum -a 256 "$CELL_EVIDENCE" | awk '{print $1}')"
```

Export and freeze `facts.json` after the window closes. Set
`FACTS_COMPLETED_AT` to the recorded UTC export time; it is an explicit input
so the same receipts and timestamp always produce the same bytes:

```bash
set -euo pipefail
set -C
FACTS="$RUN_DIR/facts.json"
FACTS_DIGEST="$RUN_DIR/facts.json.sha256"
FACTS_TMP="$RUN_DIR/.facts.json.tmp"
DIGEST_TMP="$RUN_DIR/.facts.json.sha256.tmp"
FACTS_COMPLETED_AT="2026-07-22T09:00:00.000Z"
test ! -e "$FACTS"
test ! -e "$FACTS_DIGEST"
test ! -e "$FACTS_TMP"
test ! -e "$DIGEST_TMP"
PUBLISHED_FACTS=""
PUBLISHED_FACTS_DIGEST=""
cleanup_facts() {
  rm -f "$FACTS_TMP" "$DIGEST_TMP"
  test -z "$PUBLISHED_FACTS" || rm -f "$PUBLISHED_FACTS"
  test -z "$PUBLISHED_FACTS_DIGEST" || rm -f "$PUBLISHED_FACTS_DIGEST"
}
trap cleanup_facts EXIT
(cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
(cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
yarn --cwd operator attribution:export-facts \
  --prereg "$PREREG" \
  --evidence-manifest "$CELL_EVIDENCE" \
  --completed-at "$FACTS_COMPLETED_AT" > "$FACTS_TMP"
(cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
(cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
test -s "$FACTS_TMP"
ln "$FACTS_TMP" "$FACTS"
PUBLISHED_FACTS="$FACTS"
rm "$FACTS_TMP"
shasum -a 256 "$FACTS" > "$DIGEST_TMP"
ln "$DIGEST_TMP" "$FACTS_DIGEST"
PUBLISHED_FACTS_DIGEST="$FACTS_DIGEST"
rm "$DIGEST_TMP"
chmod 0444 "$FACTS" "$FACTS_DIGEST"
PUBLISHED_FACTS=""
PUBLISHED_FACTS_DIGEST=""
trap - EXIT
```

The exporter validates every manifest-listed receipt and writes two cells in
the seed-derived frozen order. Each cell repeats treatment, runtime, isolation,
cell timing, and the full preregistered population. Each observation records
the outcome derived from the authenticated signed verdict and the immutable
verdict reference derived from the exact proof join, plus
`verdictEvidenceDigest`, the SHA-256 of the exact receipt bytes; the top level
binds `evidenceManifestDigest`. It exits nonzero with empty stdout on any
receipt or drift error. Do not edit facts to repair a mismatch.

## 5. Analyze and preserve the deterministic readout

Run from the repository root after `window.endsAt`:

```bash
set -euo pipefail
set -C
READOUT_JSON="$RUN_DIR/readout.json"
READOUT_MD="$RUN_DIR/readout.md"
TMP_JSON="$RUN_DIR/.readout.json.tmp"
TMP_MD="$RUN_DIR/.readout.md.tmp"
test ! -e "$READOUT_JSON"
test ! -e "$READOUT_MD"
test ! -e "$TMP_JSON"
test ! -e "$TMP_MD"
PUBLISHED_JSON=""
PUBLISHED_MD=""
cleanup() {
  rm -f "$TMP_JSON" "$TMP_MD"
  test -z "$PUBLISHED_JSON" || rm -f "$PUBLISHED_JSON"
  test -z "$PUBLISHED_MD" || rm -f "$PUBLISHED_MD"
}
verify() {
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration-anchor.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c facts.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
  RECORDED_PREREG_DIGEST="$(
    sed -n 's/^preregistration_sha256=//p' "$ANCHOR_RECORD"
  )"
  CURRENT_PREREG_DIGEST="sha256:$(shasum -a 256 "$PREREG" | awk '{print $1}')"
  test "$RECORDED_PREREG_DIGEST" = "$CURRENT_PREREG_DIGEST"
  VERIFIED_ANCHOR_URL="$(sed -n 's/^comment_url=//p' "$ANCHOR_RECORD")"
  VERIFIED_COMMENT_ID="${VERIFIED_ANCHOR_URL##*-}"
  LOCAL_BODY_BASE64="$(base64 < "$ANCHOR_BODY" | tr -d '\n')"
  REMOTE_BODY_BASE64="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.body | @base64'
  )"
  test "$LOCAL_BODY_BASE64" = "$REMOTE_BODY_BASE64"
  REMOTE_ISSUE_URL="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.issue_url'
  )"
  test "$REMOTE_ISSUE_URL" = \
    "https://api.github.com/repos/Jinn-Network/mono/issues/1843"
  RECORDED_ANCHOR_CREATED_AT="$(
    sed -n 's/^comment_created_at=//p' "$ANCHOR_RECORD"
  )"
  RECORDED_ANCHOR_UPDATED_AT="$(
    sed -n 's/^comment_updated_at=//p' "$ANCHOR_RECORD"
  )"
  REMOTE_ANCHOR_CREATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.created_at'
  )"
  REMOTE_ANCHOR_UPDATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.updated_at'
  )"
  test "$RECORDED_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_CREATED_AT"
  test "$RECORDED_ANCHOR_UPDATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  test "$REMOTE_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  WINDOW_STARTS_AT="$(
    node -e \
      'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).window.startsAt)' \
      "$PREREG"
  )"
  node -e \
    'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)process.exit(1)' \
    "$REMOTE_ANCHOR_CREATED_AT" "$WINDOW_STARTS_AT"
}
trap cleanup EXIT
verify
yarn --cwd operator attribution:analyze \
  --prereg "$PREREG" --facts "$FACTS" \
  --evidence-manifest "$CELL_EVIDENCE" --format json > "$TMP_JSON"
verify
yarn --cwd operator attribution:analyze \
  --prereg "$PREREG" --facts "$FACTS" \
  --evidence-manifest "$CELL_EVIDENCE" --format markdown > "$TMP_MD"
ln "$TMP_JSON" "$READOUT_JSON"
PUBLISHED_JSON="$READOUT_JSON"
ln "$TMP_MD" "$READOUT_MD"
PUBLISHED_MD="$READOUT_MD"
rm "$TMP_JSON" "$TMP_MD"
PUBLISHED_JSON=""
PUBLISHED_MD=""
trap - EXIT
```

Prove byte stability before publishing the digest package:

```bash
set -euo pipefail
PREREG="$RUN_DIR/preregistration.json"
FACTS="$RUN_DIR/facts.json"
CELL_EVIDENCE="$RUN_DIR/cell-evidence.sha256"
ANCHOR_BODY="$RUN_DIR/preregistration-anchor-comment.md"
ANCHOR_RECORD="$RUN_DIR/preregistration.anchor"
READOUT_JSON="$RUN_DIR/readout.json"
READOUT_MD="$RUN_DIR/readout.md"
REPEAT_JSON="$RUN_DIR/.readout.repeat.json"
REPEAT_MD="$RUN_DIR/.readout.repeat.md"
verify() {
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration-anchor.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c facts.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
  RECORDED_PREREG_DIGEST="$(
    sed -n 's/^preregistration_sha256=//p' "$ANCHOR_RECORD"
  )"
  CURRENT_PREREG_DIGEST="sha256:$(shasum -a 256 "$PREREG" | awk '{print $1}')"
  test "$RECORDED_PREREG_DIGEST" = "$CURRENT_PREREG_DIGEST"
  VERIFIED_ANCHOR_URL="$(sed -n 's/^comment_url=//p' "$ANCHOR_RECORD")"
  VERIFIED_COMMENT_ID="${VERIFIED_ANCHOR_URL##*-}"
  LOCAL_BODY_BASE64="$(base64 < "$ANCHOR_BODY" | tr -d '\n')"
  REMOTE_BODY_BASE64="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.body | @base64'
  )"
  test "$LOCAL_BODY_BASE64" = "$REMOTE_BODY_BASE64"
  REMOTE_ISSUE_URL="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.issue_url'
  )"
  test "$REMOTE_ISSUE_URL" = \
    "https://api.github.com/repos/Jinn-Network/mono/issues/1843"
  RECORDED_ANCHOR_CREATED_AT="$(
    sed -n 's/^comment_created_at=//p' "$ANCHOR_RECORD"
  )"
  RECORDED_ANCHOR_UPDATED_AT="$(
    sed -n 's/^comment_updated_at=//p' "$ANCHOR_RECORD"
  )"
  REMOTE_ANCHOR_CREATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.created_at'
  )"
  REMOTE_ANCHOR_UPDATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.updated_at'
  )"
  test "$RECORDED_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_CREATED_AT"
  test "$RECORDED_ANCHOR_UPDATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  test "$REMOTE_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  WINDOW_STARTS_AT="$(
    node -e \
      'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).window.startsAt)' \
      "$PREREG"
  )"
  node -e \
    'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)process.exit(1)' \
    "$REMOTE_ANCHOR_CREATED_AT" "$WINDOW_STARTS_AT"
}
test ! -e "$REPEAT_JSON"
test ! -e "$REPEAT_MD"
trap 'rm -f "$REPEAT_JSON" "$REPEAT_MD"' EXIT
verify
yarn --cwd operator attribution:analyze \
  --prereg "$PREREG" --facts "$FACTS" \
  --evidence-manifest "$CELL_EVIDENCE" --format json > "$REPEAT_JSON"
verify
yarn --cwd operator attribution:analyze \
  --prereg "$PREREG" --facts "$FACTS" \
  --evidence-manifest "$CELL_EVIDENCE" --format markdown > "$REPEAT_MD"
cmp -s "$READOUT_JSON" "$REPEAT_JSON"
cmp -s "$READOUT_MD" "$REPEAT_MD"
rm "$REPEAT_JSON" "$REPEAT_MD"
trap - EXIT
```

Hash the final package only after another `verify`:

```bash
set -euo pipefail
set -C
READOUT_DIGESTS="$RUN_DIR/readout-artifacts.sha256"
TMP="$RUN_DIR/.readout-artifacts.sha256.tmp"
test ! -e "$READOUT_DIGESTS"
test ! -e "$TMP"
trap 'rm -f "$TMP"' EXIT
verify() {
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration-anchor.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c facts.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
  RECORDED_PREREG_DIGEST="$(
    sed -n 's/^preregistration_sha256=//p' "$ANCHOR_RECORD"
  )"
  CURRENT_PREREG_DIGEST="sha256:$(shasum -a 256 "$PREREG" | awk '{print $1}')"
  test "$RECORDED_PREREG_DIGEST" = "$CURRENT_PREREG_DIGEST"
  VERIFIED_ANCHOR_URL="$(sed -n 's/^comment_url=//p' "$ANCHOR_RECORD")"
  VERIFIED_COMMENT_ID="${VERIFIED_ANCHOR_URL##*-}"
  LOCAL_BODY_BASE64="$(base64 < "$ANCHOR_BODY" | tr -d '\n')"
  REMOTE_BODY_BASE64="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.body | @base64'
  )"
  test "$LOCAL_BODY_BASE64" = "$REMOTE_BODY_BASE64"
  REMOTE_ISSUE_URL="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.issue_url'
  )"
  test "$REMOTE_ISSUE_URL" = \
    "https://api.github.com/repos/Jinn-Network/mono/issues/1843"
  RECORDED_ANCHOR_CREATED_AT="$(
    sed -n 's/^comment_created_at=//p' "$ANCHOR_RECORD"
  )"
  RECORDED_ANCHOR_UPDATED_AT="$(
    sed -n 's/^comment_updated_at=//p' "$ANCHOR_RECORD"
  )"
  REMOTE_ANCHOR_CREATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.created_at'
  )"
  REMOTE_ANCHOR_UPDATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.updated_at'
  )"
  test "$RECORDED_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_CREATED_AT"
  test "$RECORDED_ANCHOR_UPDATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  test "$REMOTE_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  WINDOW_STARTS_AT="$(
    node -e \
      'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).window.startsAt)' \
      "$PREREG"
  )"
  node -e \
    'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)process.exit(1)' \
    "$REMOTE_ANCHOR_CREATED_AT" "$WINDOW_STARTS_AT"
}
verify
shasum -a 256 "$PREREG" "$ANCHOR_BODY" "$ANCHOR_RECORD" \
  "$FACTS" "$CELL_EVIDENCE" \
  "$READOUT_JSON" "$READOUT_MD" > "$TMP"
ln "$TMP" "$READOUT_DIGESTS"
rm "$TMP"
chmod 0444 "$READOUT_JSON" "$READOUT_MD" "$READOUT_DIGESTS"
trap - EXIT
```

The mechanical signal is `helped`, `harmed`, `no-difference-detected`, or
`inconclusive`. “No difference detected” is not equivalence; “inconclusive”
means the preregistered matched or discordant bar was not met. Interpretation,
the embeddings design session, C13 posture, and Stage 2 proceed/iterate/stop
decision remain Human-only on #1843 and tracking issue #1815.

## 6. Recovery

On any rejection, preserve stderr and recheck the immutable inputs:

```bash
set -euo pipefail
PREREG="$RUN_DIR/preregistration.json"
FACTS="$RUN_DIR/facts.json"
CELL_EVIDENCE="$RUN_DIR/cell-evidence.sha256"
ANCHOR_BODY="$RUN_DIR/preregistration-anchor-comment.md"
ANCHOR_RECORD="$RUN_DIR/preregistration.anchor"
ERROR_LOG="$RUN_DIR/analyzer-error.$(date -u +%Y%m%dT%H%M%SZ).log"
verify() {
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration-anchor.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c facts.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
  RECORDED_PREREG_DIGEST="$(
    sed -n 's/^preregistration_sha256=//p' "$ANCHOR_RECORD"
  )"
  CURRENT_PREREG_DIGEST="sha256:$(shasum -a 256 "$PREREG" | awk '{print $1}')"
  test "$RECORDED_PREREG_DIGEST" = "$CURRENT_PREREG_DIGEST"
  VERIFIED_ANCHOR_URL="$(sed -n 's/^comment_url=//p' "$ANCHOR_RECORD")"
  VERIFIED_COMMENT_ID="${VERIFIED_ANCHOR_URL##*-}"
  LOCAL_BODY_BASE64="$(base64 < "$ANCHOR_BODY" | tr -d '\n')"
  REMOTE_BODY_BASE64="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.body | @base64'
  )"
  test "$LOCAL_BODY_BASE64" = "$REMOTE_BODY_BASE64"
  REMOTE_ISSUE_URL="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.issue_url'
  )"
  test "$REMOTE_ISSUE_URL" = \
    "https://api.github.com/repos/Jinn-Network/mono/issues/1843"
  RECORDED_ANCHOR_CREATED_AT="$(
    sed -n 's/^comment_created_at=//p' "$ANCHOR_RECORD"
  )"
  RECORDED_ANCHOR_UPDATED_AT="$(
    sed -n 's/^comment_updated_at=//p' "$ANCHOR_RECORD"
  )"
  REMOTE_ANCHOR_CREATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.created_at'
  )"
  REMOTE_ANCHOR_UPDATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.updated_at'
  )"
  test "$RECORDED_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_CREATED_AT"
  test "$RECORDED_ANCHOR_UPDATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  test "$REMOTE_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  WINDOW_STARTS_AT="$(
    node -e \
      'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).window.startsAt)' \
      "$PREREG"
  )"
  node -e \
    'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)process.exit(1)' \
    "$REMOTE_ANCHOR_CREATED_AT" "$WINDOW_STARTS_AT"
}
test ! -e "$ERROR_LOG"
verify
if yarn --cwd operator attribution:analyze \
  --prereg "$PREREG" --facts "$FACTS" \
  --evidence-manifest "$CELL_EVIDENCE" --format json \
  > /dev/null 2> "$ERROR_LOG"; then
  rm "$ERROR_LOG"
  printf '%s\n' 'analyzer succeeded; no recovery required'
else
  chmod 0444 "$ERROR_LOG"
fi
```

Do not overwrite preregistration, facts, evidence, or readouts. If and only if
the exporter emitted malformed JSON while the retained receipts remain
unchanged, export to a new timestamped path, freeze it, and invoke the analyzer
against that exact path:

```bash
set -euo pipefail
PREREG="$RUN_DIR/preregistration.json"
FACTS="$RUN_DIR/facts.json"
CELL_EVIDENCE="$RUN_DIR/cell-evidence.sha256"
ANCHOR_BODY="$RUN_DIR/preregistration-anchor-comment.md"
ANCHOR_RECORD="$RUN_DIR/preregistration.anchor"
FACTS_COMPLETED_AT="2026-07-22T09:00:00.000Z"
RECOVERY_ID="$(date -u +%Y%m%dT%H%M%SZ)"
verify() {
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c preregistration-anchor.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c facts.json.sha256)
  (cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
  RECORDED_PREREG_DIGEST="$(
    sed -n 's/^preregistration_sha256=//p' "$ANCHOR_RECORD"
  )"
  CURRENT_PREREG_DIGEST="sha256:$(shasum -a 256 "$PREREG" | awk '{print $1}')"
  test "$RECORDED_PREREG_DIGEST" = "$CURRENT_PREREG_DIGEST"
  VERIFIED_ANCHOR_URL="$(sed -n 's/^comment_url=//p' "$ANCHOR_RECORD")"
  VERIFIED_COMMENT_ID="${VERIFIED_ANCHOR_URL##*-}"
  LOCAL_BODY_BASE64="$(base64 < "$ANCHOR_BODY" | tr -d '\n')"
  REMOTE_BODY_BASE64="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.body | @base64'
  )"
  test "$LOCAL_BODY_BASE64" = "$REMOTE_BODY_BASE64"
  REMOTE_ISSUE_URL="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.issue_url'
  )"
  test "$REMOTE_ISSUE_URL" = \
    "https://api.github.com/repos/Jinn-Network/mono/issues/1843"
  RECORDED_ANCHOR_CREATED_AT="$(
    sed -n 's/^comment_created_at=//p' "$ANCHOR_RECORD"
  )"
  RECORDED_ANCHOR_UPDATED_AT="$(
    sed -n 's/^comment_updated_at=//p' "$ANCHOR_RECORD"
  )"
  REMOTE_ANCHOR_CREATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.created_at'
  )"
  REMOTE_ANCHOR_UPDATED_AT="$(
    gh api "repos/Jinn-Network/mono/issues/comments/$VERIFIED_COMMENT_ID" \
      --jq '.updated_at'
  )"
  test "$RECORDED_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_CREATED_AT"
  test "$RECORDED_ANCHOR_UPDATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  test "$REMOTE_ANCHOR_CREATED_AT" = "$REMOTE_ANCHOR_UPDATED_AT"
  WINDOW_STARTS_AT="$(
    node -e \
      'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).window.startsAt)' \
      "$PREREG"
  )"
  node -e \
    'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)process.exit(1)' \
    "$REMOTE_ANCHOR_CREATED_AT" "$WINDOW_STARTS_AT"
}
RECOVERED_FACTS="$RUN_DIR/facts.reexport.$RECOVERY_ID.json"
RECOVERED_DIGEST="$RECOVERED_FACTS.sha256"
RECOVERED_TMP="$RUN_DIR/.facts.reexport.$RECOVERY_ID.json.tmp"
RECOVERED_DIGEST_TMP="$RUN_DIR/.facts.reexport.$RECOVERY_ID.json.sha256.tmp"
test ! -e "$RECOVERED_FACTS"
test ! -e "$RECOVERED_DIGEST"
test ! -e "$RECOVERED_TMP"
test ! -e "$RECOVERED_DIGEST_TMP"
PUBLISHED_RECOVERY=""
PUBLISHED_RECOVERY_DIGEST=""
cleanup_recovery() {
  rm -f "$RECOVERED_TMP" "$RECOVERED_DIGEST_TMP"
  test -z "$PUBLISHED_RECOVERY" || rm -f "$PUBLISHED_RECOVERY"
  test -z "$PUBLISHED_RECOVERY_DIGEST" || rm -f "$PUBLISHED_RECOVERY_DIGEST"
}
trap cleanup_recovery EXIT
(cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
(cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
yarn --cwd operator attribution:export-facts \
  --prereg "$PREREG" \
  --evidence-manifest "$CELL_EVIDENCE" \
  --completed-at "$FACTS_COMPLETED_AT" > "$RECOVERED_TMP"
(cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
(cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
test -s "$RECOVERED_TMP"
ln "$RECOVERED_TMP" "$RECOVERED_FACTS"
PUBLISHED_RECOVERY="$RECOVERED_FACTS"
rm "$RECOVERED_TMP"
shasum -a 256 "$RECOVERED_FACTS" > "$RECOVERED_DIGEST_TMP"
ln "$RECOVERED_DIGEST_TMP" "$RECOVERED_DIGEST"
PUBLISHED_RECOVERY_DIGEST="$RECOVERED_DIGEST"
rm "$RECOVERED_DIGEST_TMP"
chmod 0444 "$RECOVERED_FACTS" "$RECOVERED_DIGEST"
PUBLISHED_RECOVERY=""
PUBLISHED_RECOVERY_DIGEST=""
trap - EXIT
(cd "$RUN_DIR" && shasum -a 256 -c preregistration.json.sha256)
(cd "$RUN_DIR" && shasum -a 256 -c cell-evidence.sha256)
shasum -a 256 -c "$RECOVERED_DIGEST"
verify
yarn --cwd operator attribution:analyze \
  --prereg "$PREREG" --facts "$RECOVERED_FACTS" \
  --evidence-manifest "$CELL_EVIDENCE" --format json
```

Runtime, isolation, timing, population, treatment, receipt, origin, verdict,
or delivery drift requires a new Human decision on #1843; it is never repaired
by relabeling facts.

The CLI reads only the named inputs and manifest-listed files, applies both
per-file and aggregate evidence byte bounds, prints only after complete
validation, and exits nonzero with empty stdout on failure.
