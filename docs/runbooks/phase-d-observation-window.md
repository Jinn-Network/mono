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

A durable counter file that goes missing, becomes corrupt, is reset (deleted and recreated,
restarting its `observationWindowStartedAt`), or regresses (a count that decreased, or a signal
that disappeared after being present) cannot vouch for the days it didn't genuinely observe. The
collector enforces this per instance:

- **missing / corrupt** — a fetch failure, non-2xx response, unparseable body, or a stale native
  snapshot file (see Freshness below) is recorded as a snapshot with `durable: false,
  observationWindowStartedAt: null`.
- **reset** — a `observationWindowStartedAt` that changes between two consecutive snapshots for
  the same instance is counted (`resets`) and invalidates completeness from that point on.
- **regression** — a signal's count that decreased, or a signal present in an earlier snapshot
  that is absent from a later one, is counted (`regressions`) and invalidates completeness. The
  durable counter file is append-only/monotonic by construction
  (`compatibility/phase-d-transition-usage.ts`); either shape is corrupt or tampered data, never
  legacy use genuinely dropping back down.

An instance is `complete` only when every one of its collected snapshots is durable, reports the
same `observationWindowStartedAt`, and shows no per-signal regression. The overall
`verdict.zeroUse` is `true` only when the window is **closed** (`endedAt !== null`), **every**
instance in the receipt is complete, every instance's collections continuously **cover** the
window (see Window coverage below), and every legacy signal observed reads zero. Any failure of
any of these forces `zeroUse: false` — a coverage gap, an open window, a regressed count, or a
shrunk fleet (see Population integrity below) is never evidence of zero use.

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

  **Point this at the status snapshot file, not the raw counter file.** Native's `stateDir` also
  holds `phase-d-transition-usage.v1.json` — the durable counter file itself, with no `generatedAt`
  and no `phaseDTransitionUsage` wrapper key. A `file-snapshot` entry pointed at that file instead
  of `phase-d-status-snapshot.v1.json` fails the collector's shape check on every single run and
  never says why beyond "missing/corrupt" in the receipt — there is no louder signal than that.
  Double-check the filename in the fleet manifest if an instance never goes `complete`.

`endedAt` stays `null` while the window is open; set it once the window closes.

## Freshness (native only)

A native instance's `file-snapshot` source is a snapshot on disk, not a live request — a process
that died or a box that quietly flipped back to legacy can leave a frozen file behind that looks
identical to a live one unless its age is checked. The collector rejects a snapshot whose own
`generatedAt` is more than ~15 minutes old relative to the collection time (`readFileStatusSnapshot`
in `src/monitoring/phase-d-observation-window.ts`; ~3x native's 5-minute snapshot-loop interval).
A `http-status` legacy instance doesn't need this check — a dead process simply refuses the
connection, which already fails closed.

The freshness check also fails closed on `generatedAt` being **ahead of** the collection time —
even by a single second — not just stale in the ordinary sense. This is deliberate (a clock
running ahead is just as untrustworthy as a frozen file) but it has an accepted false-negative
cost: an instance whose clock genuinely runs fast relative to the collector's cannot go
`complete`, ever, until the clock is fixed. If a native instance never clears `complete: false`
despite a healthy, ticking snapshot loop, check its clock before assuming the collector is wrong.

## Window coverage

`zeroUse` is never `true` while `endedAt` is `null`, and never `true` unless every instance's
collected snapshots continuously cover `[startedAt, endedAt]` with no gap wider than ~2 days. One
lucky collector run against a freshly-added instance is not evidence for a multi-week window — the
receipt has to show the collector actually watched the whole span. Close the window (set `endedAt`
in the fleet manifest) only once collection has run daily across the whole approved period.

The coverage gate also refuses a degenerate window outright — `startedAt`/`endedAt`/a snapshot's
collection timestamp that fails to parse, a zero-length window (`startedAt === endedAt`), an
inverted one (`endedAt` before `startedAt`), or one shorter than one day (the collector's cadence)
— regardless of how clean the collected snapshots otherwise look. `loadFleetManifest` also
validates `startedAt`/`endedAt` parse to real dates at load time, so a human typo (a swapped month,
transposed digits) surfaces as an immediate setup error rather than a receipt that silently never
covers.

## Population integrity

An instance that has ever appeared in the receipt's history stays represented in every later run,
even after it drops out of the fleet manifest (a legacy host decommissioned mid-drain, for
example). It is carried forward as a missing observation, which invalidates its completeness —
shrinking the fleet never improves the verdict. To genuinely retire an instance's history, start a
new window (a new `windowId`); do not repoint an old receipt at a shorter instance list.

`loadFleetManifest` also rejects a fleet manifest with a duplicate `instanceId` (a copy-pasted
entry) as a setup error — fix the manifest rather than relying on it working anyway. The
underlying merge the library falls back to for a duplicate that does reach it (defense in depth,
not the primary path) is conservative: it keeps the highest count per signal across the
duplicates and never trusts a merge whose entries disagree about `observationWindowStartedAt`.

## Running it

```bash
cd client
yarn phase-d-observe -- --fleet ./phase-d-fleet.json --receipt ./phase-d-observation-receipt.json
```

Each run validates the existing receipt (if present — schemaVersion/kind/`windowId`/`approvedBy`/
`startedAt` must all match what's being requested), appends one snapshot per fleet instance dated
`--now` (defaults to the real current time), recomputes `complete`/`resets`/`regressions`/`verdict`
for every instance the receipt has ever seen (not just today's fetch list — see Population
integrity above), and writes the receipt back atomically (durable temp+rename, same pattern as
`phase-d-transition-usage.ts`). A single instance's fetch failure never fails the run — it is
recorded as a missing/corrupt snapshot and invalidates only that instance's completeness. The
collector exits non-zero only on a setup failure: a missing/invalid fleet manifest, a corrupt
existing receipt, or an existing receipt with the wrong shape/window/approver (none of which are
ever silently overwritten — fix or move the file before re-running).

## Receipt contract

```json
{
  "schemaVersion": 1,
  "kind": "jinn.phase-d-observation-window",
  "windowId": "phase-d-2026-08-04",
  "approvedBy": "ritsuKai2000",
  "startedAt": "2026-07-30T00:00:00.000Z",
  "endedAt": "2026-08-13T00:00:00.000Z",
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
          "at": "2026-07-30T09:00:00.000Z",
          "observationWindowStartedAt": "2026-07-30T00:00:00.000Z",
          "durable": true,
          "counters": []
        },
        {
          "at": "2026-08-13T09:00:00.000Z",
          "observationWindowStartedAt": "2026-07-30T00:00:00.000Z",
          "durable": true,
          "counters": []
        }
      ],
      "complete": true,
      "resets": 0,
      "regressions": 0
    }
  ],
  "verdict": {
    "zeroUse": true,
    "signalsCovered": [
      "legacy-evaluator-delivery-watcher-loaded",
      "legacy-operator-composition",
      "legacy-task-submission-synthesis",
      "legacy-wiring-config-field",
      "marketplace-pipeline-invocation"
    ]
  }
}
```

(Real receipts collect roughly daily across the window — this example elides the intervening days
for brevity; `zeroUse: true` requires no gap between them wider than the coverage tolerance below.)

`verdict.signalsCovered` names the legacy signals for which durable, live instrumentation was
confirmed — at least one instance's latest snapshot reported `durable: true` — regardless of
whether that signal ever fired. This is deliberate: the durable counter file never persists an
explicit zero-count row (a signal that never fires simply never appears in its `counters` array —
see `compatibility/phase-d-transition-usage.ts`), so "present in a snapshot's counters" cannot be
the coverage signal — it would be empty exactly when `zeroUse` is true, the one case this field
exists to back up. `durable: true` instead confirms the counter mechanism itself was live and
would have shown these signals had they fired. `native-operator-composition` is deliberately
excluded from both `signalsCovered` and the `zeroUse` computation: it is positive native-presence
evidence, not a legacy-use counter, and a native instance recording activity there must never
suppress a zero-use verdict.

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
