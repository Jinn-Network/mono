# Phase D observation-window collector

Automates the "human scraping each host" method the #2380 gap analysis called out, and produces
the durable receipt that backs the Phase D manifest's zero-use claim
(`architecture/transitions/phase-d-native-operator.v1.json`). See that manifest, the issue
(#2380), and `client/src/monitoring/phase-d-observation-window.ts` for the underlying model.

## What it proves, and what it does not

The manifest's `zeroDefinition`s are propositions about **the enumerated first-party fleet**, not
about the network in general. This collector's receipt names that boundary explicitly
(`supportBoundary.claim: "first-party-operational"`, `disclaims: ["unknown-independent-operators"]`)
and never widens it. A receipt with `verdict.zeroUse: true` supports the claim "legacy use was zero
across the fleet named in the manifest for the approved window" — it does not, and cannot, prove
anything about operators outside that enumeration.

The window is **dated, not traffic-triggered**: it runs for the approved calendar span regardless
of whether traffic has moved to native. "Traffic has moved to native" is not itself a claimable
proposition; "legacy use was zero for the approved window" is.

## Continuity, not just presence

A durable counter file that goes missing, becomes corrupt, or is reset (deleted and recreated,
restarting its `observationWindowStartedAt`) cannot vouch for the days it didn't observe. The
collector enforces this per instance:

- **missing / corrupt** — a fetch failure, non-2xx response, or unparseable body is recorded as a
  snapshot with `durable: false, observationWindowStartedAt: null`.
- **reset** — a `observationWindowStartedAt` that changes between two consecutive snapshots for
  the same instance is counted (`resets`) and invalidates completeness from that point on.

An instance is `complete` only when every one of its collected snapshots is durable and reports
the same `observationWindowStartedAt`. The overall `verdict.zeroUse` is `true` only when **every**
instance in the receipt is complete AND every legacy signal observed reads zero — an incomplete
instance always forces `zeroUse: false`, even if every observed count so far is zero. A coverage
gap is never evidence of zero use.

## The fleet

The population to enumerate is the first-party fleet — see
[`docs/runbooks/cutover-stage-1-drain.md`](cutover-stage-1-drain.md) for the current gold
operators (op-c evaluator / op-d solver, at time of writing; op-a/op-b are excluded — their Safes
are stOLAS-distributor-owned, see GS026) plus the Railway-hosted services. Re-check that runbook
for the live roster before starting a window; it is prose, not machine-readable, by design (the
fleet composition changes as cutover stages progress).

## Fleet manifest

A JSON file (not checked in — it names live hosts/tokens) describing the window and the
instances to scrape:

```json
{
  "windowId": "phase-d-2026-08-04",
  "approvedBy": "ritsuKai2000",
  "startedAt": "2026-08-04T00:00:00.000Z",
  "endedAt": null,
  "instances": [
    {
      "instanceId": "op-c",
      "imageDigest": "sha256:...",
      "reportedSourceSha": "de8ac3750",
      "source": { "kind": "http-status", "url": "http://op-c-host:7331/v1/status", "tokenEnv": "OP_C_STATUS_TOKEN" }
    },
    {
      "instanceId": "op-d",
      "imageDigest": "sha256:...",
      "reportedSourceSha": "de8ac3750",
      "source": { "kind": "file-snapshot", "path": "/mnt/op-d-state/phase-d-status-snapshot.v1.json" }
    }
  ]
}
```

Two source kinds:

- `http-status` — a legacy instance's authenticated, localhost-bound `GET /v1/status`. `tokenEnv`
  names an environment variable the collector reads for the bearer token; omit it for an
  unauthenticated endpoint (not recommended off localhost).
- `file-snapshot` — a native instance's durable status snapshot
  (`<stateDir>/phase-d-status-snapshot.v1.json`, written by
  `client/src/daemon/native-phase-d-observability.ts`'s periodic loop — native has no
  `/v1/status`). The path must be reachable from wherever the collector runs (a shared/mounted
  volume, or run the collector on the host itself).

`endedAt` stays `null` while the window is open; set it once the window closes.

## Running it

```bash
cd client
yarn phase-d-observe -- --fleet ./phase-d-fleet.json --receipt ./phase-d-observation-receipt.json
```

Each run reads the existing receipt (if present), appends one snapshot per fleet instance dated
`--now` (defaults to the real current time), recomputes `complete`/`resets`/`verdict`, and writes
the receipt back atomically (durable temp+rename, same pattern as
`phase-d-transition-usage.ts`). A single instance's fetch failure never fails the run — it is
recorded as a missing/corrupt snapshot and invalidates only that instance's completeness. The
collector exits non-zero only on a setup failure: a missing/invalid fleet manifest, or a corrupt
existing receipt (which is never silently overwritten — fix or move it before re-running).

## Receipt contract

```json
{
  "schemaVersion": 1,
  "kind": "jinn.phase-d-observation-window",
  "windowId": "phase-d-2026-08-04",
  "approvedBy": "ritsuKai2000",
  "startedAt": "2026-08-04T00:00:00.000Z",
  "endedAt": null,
  "supportBoundary": {
    "claim": "first-party-operational",
    "disclaims": ["unknown-independent-operators"]
  },
  "instances": [
    {
      "instanceId": "op-c",
      "imageDigest": "sha256:...",
      "reportedSourceSha": "de8ac3750",
      "snapshots": [
        {
          "at": "2026-08-04T09:00:00.000Z",
          "observationWindowStartedAt": "2026-07-30T00:00:00.000Z",
          "durable": true,
          "counters": [{ "signal": "marketplace-pipeline-invocation", "count": 0 }]
        }
      ],
      "complete": true,
      "resets": 0
    }
  ],
  "verdict": { "zeroUse": true, "signalsCovered": ["marketplace-pipeline-invocation"] }
}
```

`verdict.signalsCovered` names the legacy signals actually observed (present in at least one
instance's latest snapshot) — the auditable evidence backing the `zeroUse` claim, distinguishing
"observed and zero" from "silently absent". `native-operator-composition` is deliberately excluded
from both `signalsCovered` and the `zeroUse` computation: it is positive native-presence evidence,
not a legacy-use counter, and a native instance recording activity there must never suppress a
zero-use verdict.

## Cron setup

Same shape as [`net-liveness.md`](net-liveness.md)'s cron guidance — pick a daily cadence (the
window is dated, not traffic-triggered, so more-than-daily collection buys nothing):

```
cron schedule: 0 9 * * *
start command: cd client && yarn phase-d-observe -- --fleet /etc/jinn/phase-d-fleet.json --receipt /var/jinn/phase-d-observation-receipt.json
```

Set the `*_STATUS_TOKEN` environment variables named by the fleet manifest's `tokenEnv` fields as
service secrets. The receipt file should live somewhere durable across collector runs (a mounted
volume, not ephemeral container storage) — losing it mid-window discards the snapshot history
collected so far and restarts completeness from scratch.
