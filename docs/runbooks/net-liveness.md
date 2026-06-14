# Net-liveness probe

An operator-independent probe that alerts when the network goes silent — no new
on-chain attempt or verdict is being indexed even though the chain is advancing
and the indexer is caught up. This is the externally-observable backstop for the
#1038 silent-stall class.

## What it is, and why it lives outside the daemon

When the shared indexer blips, every operator daemon's discovery loops can wedge
while the indexer-independent loops (jinn-claim, balance-topup) keep emitting
on-chain activity and mask the outage. No single operator can be trusted to
notice their own stall, so liveness must be observed from *outside* any daemon.

The probe is therefore a standalone, stateless script — `client/scripts/net-liveness-probe.ts`,
run as `yarn net-liveness`. It is cron-driven, NOT in-daemon, and holds no state
between runs. It does not touch the daemon, the daemon loops, or `/v1/status`.

## How it decides

The probe reads on-chain truth two ways and cross-references them:

1. **Chain head** — direct RPC `getBlockNumber()` (always live, independent of
   the indexer). Read twice per run to detect whether the chain is advancing.
2. **Latest indexed activity** — the newest `createdAtBlock` across the latest
   `attempt` and the latest `verdict` via the indexer's GraphQL endpoint. (Tasks
   are excluded: a posted-but-unclaimed task is itself the stall condition.)
3. **Indexer head** — the indexer's own indexed head via Ponder's `/status`
   endpoint, to tell a genuine network stall apart from a lagging indexer.

The decision is a pure function. States, in evaluation order — only `stale`
alerts:

| State | Meaning | Alert? |
|-------|---------|--------|
| `indexer-down` | indexer `/status` unreachable, or an indexer read threw | no |
| `indexer-lagging` | indexer is reachable but more than the threshold behind chain head | no |
| `chain-halted` | chain head did not advance between the two reads | no |
| `stale` | chain advancing + indexer caught up, but no attempt/verdict indexed within the threshold | **yes** |
| `healthy` | an attempt or verdict was indexed within the threshold of chain head | no |

A halted chain or a lagging/down indexer is reported (logged) but is NOT a net
stall — those are confounds that would otherwise look like silence, so they are
ruled out before `stale` can fire.

### Healthy cadence

The network is healthy when a new attempt or verdict is indexed within the
threshold minutes of chain head, *provided the chain head is advancing*. Absence
of recent activity is only a net stall once the chain-halted and indexer
confounds are excluded.

### Block-space conversion

The indexer schema carries `createdAtBlock` (a block number), not a timestamp,
so the probe works in block-space. Base produces roughly one block every 2s →
**30 blocks per minute**. The minute threshold is converted as
`thresholdBlocks = minutes × 30`. With the default 30-minute threshold that is
900 blocks.

## Environment

| Env var | Default | Notes |
|---------|---------|-------|
| `JINN_NET_LIVENESS_WEBHOOK_URL` | unset | Generic incoming-webhook URL (Slack-compatible). Unset → NO-OP: the probe still classifies and logs, it just never posts. |
| `JINN_NET_LIVENESS_THRESHOLD_MINUTES` | `30` | Staleness threshold, in minutes. Converted to block-space at 30 blocks/min. |
| `JINN_NET_LIVENESS_HEAD_SAMPLE_DELAY_MS` | `4000` | Delay between the two chain-head reads. Must exceed Base's ~2s blocktime so a live chain advances at least one block between samples (a same-block pair classifies as `chain-halted` and never alerts). Also exceeds viem's ~4s `getBlockNumber` cache window; the reads additionally pass `cacheTime: 0`. |
| `BASE_SEPOLIA_RPC_URL` / `JINN_RPC_URL` | inherited from daemon config | The RPC chain used for the chain-head read. Same #592 fallback chain as the daemon. |
| `JINN_DISCOVERY_URL` | inherited from daemon config | The indexer base URL. If `discovery.mode` is `onchain` and no URL is set, the probe logs "no indexer configured" and exits 0 — there is nothing to cross-reference. |

## Webhook payload

When `stale` and a webhook is configured, the probe POSTs a JSON body that is
Slack-incoming-webhook compatible (`text`) and carries structured fields
alongside (bigints are serialized as strings):

```json
{
  "text": "Jinn net-liveness alert: no on-chain attempt/verdict indexed for ~300 min ...",
  "state": "stale",
  "staleForBlocks": "9000",
  "staleForMinutes": 300,
  "chainHeadBlock": "10000",
  "latestActivityBlock": "1000",
  "runAt": "2026-06-14T00:00:00.000Z"
}
```

## Cron setup

The probe is stateless and holds no de-dup marker. **The cron interval is the
de-dup and rate-limit** — a 15-minute interval means at most one alert per 15
minutes while the stall persists. Pick an interval at or below the threshold so a
stall is caught within one window.

### GitHub Actions (scheduled workflow)

```yaml
name: net-liveness
on:
  schedule:
    - cron: '*/15 * * * *'   # every 15 minutes; this interval is the rate-limit
jobs:
  probe:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: corepack enable
      - run: yarn install --immutable
      - run: yarn net-liveness
        env:
          JINN_NET_LIVENESS_WEBHOOK_URL: ${{ secrets.JINN_NET_LIVENESS_WEBHOOK_URL }}
          JINN_NET_LIVENESS_THRESHOLD_MINUTES: '30'
          BASE_SEPOLIA_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}
          JINN_DISCOVERY_URL: ${{ secrets.JINN_DISCOVERY_URL }}
```

### Railway cron

Configure a Railway cron service whose start command runs the probe on the same
cadence:

```
cron schedule: */15 * * * *
start command:  cd client && yarn net-liveness
```

Set `JINN_NET_LIVENESS_WEBHOOK_URL`, `JINN_NET_LIVENESS_THRESHOLD_MINUTES`,
`BASE_SEPOLIA_RPC_URL`, and `JINN_DISCOVERY_URL` as service variables.

The probe always exits 0 on a completed run — the alert is a side-effect, not a
failure — so a non-zero exit means the probe itself failed to run (bad config or
unreachable RPC chain), which a cron failure policy should surface separately.
