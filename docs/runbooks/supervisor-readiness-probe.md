# Supervising the operator daemon with `/ready`

How a process supervisor (Railway, Kubernetes, systemd, Docker `HEALTHCHECK`)
should consume the operator daemon's readiness probe — and the one state that
makes a naive configuration restart-loop a healthy daemon.

Nothing in this repository points a healthcheck at `/ready` today. Read this
before the first deploy config adopts it.

## The two probes

Both are ungated (no token) on the daemon's API port
(`apiPort`, default 7331), alongside `/metrics`.

| Route | Question it answers | Wire to |
|---|---|---|
| `GET /health` | Is the process alive and serving? Always `200 {"ok": true}`. | **liveness** — restart on failure |
| `GET /ready` | Should traffic/work be routed here, and is the daemon still converging? | **readiness** — do *not* restart on failure |

`GET /ready` body:

```json
{ "reason": "ready" | "degraded" | "bootstrapping", "cause": "funding_required", "accepting_work": true }
```

- `reason` is the sole discriminator. `cause` appears only when a persisted
  bootstrap-halt envelope exists; it is never fabricated.
- `accepting_work` is `true` only for `ready`. It is a separate field precisely
  so readiness and work admission can never be conflated.

Status mapping:

| `reason` | HTTP | Meaning | Supervisor action |
|---|---|---|---|
| `ready` | 200 | Bootstrap completed; every loop admitted. | route work |
| `degraded` | 200 | Bootstrap halted on an economic cause (funding shortfall, incomplete fleet, …). The daemon is parked, retrying, and is expected to recover once the operator funds it. | **leave it running** |
| `bootstrapping` | 503 | Bootstrap has not resolved, or halted on an integrity-class cause (fail-closed by design). | do not route work |

## Do not restart on `/ready`

`degraded` is the daemon telling you it is waiting on the operator — usually
for ETH or OLAS to land in the master EOA. Restarting it does not add funds; it
just re-runs the same bootstrap into the same halt. Configure `/ready` as a
**readiness** probe only, and let `/health` own the restart decision.

Kubernetes:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 7331 }
readinessProbe:
  httpGet: { path: /ready, port: 7331 }
```

Never set `livenessProbe` to `/ready`.

## `degraded` with no recovery loops running (issue #2425)

On an economic halt the daemon starts a small standalone set of recovery loops
(eviction-check, checkpoint, balance-topup, reward-claim) for the part of the
fleet that is already operational, so a self-healing condition does not compound
while the halt is retried.

If that startup itself fails, readiness is **still** `degraded` — `/ready`
answers 200 and the supervisor correctly leaves the parked daemon alone — but
no recovery loops are running, so the fleet will not self-heal until the halt
clears. The failure is not on the `/ready` wire (its shape is a fixed, minimal
supervisor contract; the restart decision is identical either way). It is in the
daemon log, as:

```
[main] Failed to start degraded recovery loops — readiness is `degraded` with NO recovery
loops running (/ready answers 200 so a supervisor does not restart this parked daemon;
the fleet will not self-heal until the halt is retried): <error>
```

If you see that line, treat it as an operator-attention event: the halt named by
`/ready`'s `cause` still needs resolving, and the usual degraded-mode
self-healing is not available in the meantime.

Before #2425 this state left readiness at `bootstrapping` → `/ready` 503 → a
supervisor pointed at `/ready` restart-looped a daemon that was correctly
waiting for funding.

## Related

- `spec/2026-08-04-headless-operator-rederivation-design.md` §6.1, §14.5 — the
  probe contract.
- `operator/src/api/health-endpoint.ts` — the routes.
- `operator/src/daemon/loop-heartbeat.ts` — the readiness holder and per-loop
  `admission` classes.
