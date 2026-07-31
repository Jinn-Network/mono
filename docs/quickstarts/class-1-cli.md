# Quickstart: post a Task with the `jinn` CLI

This is the process-invocation path: install the published `jinn` binary,
let it manage its own keystore, and submit a Task with `jinn tasks submit`.

**Custody note.** `jinn run` generates the master wallet mnemonic on first
run and keeps it in a local encrypted keystore under `~/.jinn-client/`. The
keystore password is auto-generated and stored at
`~/.jinn-client/keystore-password` unless you set `JINN_PASSWORD` yourself.
That is the right tradeoff for an individual operator running the daemon on
their own machine. If your organization requires posting through a KMS/HSM
signer under a dedicated posting Safe instead of a machine-local keystore,
that is a different consumption path — it is not documented in this
worktree yet (see the note at the end of this page).

## 1. Install

```bash
npm install -g @jinn-network/client@latest
```

This installs the `jinn` (and `client`) binaries, which run the compiled
`dist/` tree — daemon plus the bundled operator dashboard SPA.

## 2. First run

```bash
jinn run
```

On first run this walks the earning bootstrap (wallet → Safe → service →
staking → mech) and then starts the daemon. Two things happen automatically:

- A keystore password is generated and saved to
  `~/.jinn-client/keystore-password` — you do not need to supply one. Set
  `JINN_PASSWORD` yourself only if you want to manage the password outside
  the auto-generated file (CI, a secrets manager).
- If the wallet needs funding, the bootstrap **pauses at the
  `awaiting_funding` step** rather than failing. `jinn bootstrap` exits
  `10` with a `funding_required` envelope in that state, and `jinn
  fund-requirements` lists exactly which address needs which asset:

  ```bash
  jinn fund-requirements
  jinn fund-requirements --human
  ```

Check readiness before or after any of this with `jinn doctor` (a
non-mutating check — it always exits `0`; read the `ok` field and the
`checks` array to see what's blocking):

```bash
jinn doctor --human
```

Fund the reported addresses, then re-run `jinn bootstrap` (or `jinn run`
again) — both are idempotent and resume from wherever the state machine
left off.

## 3. Configure a Task

Point `jinn` at a config file (default `~/.jinn-client/config.json`) that
lists the Tasks you want it to post. A minimal `prediction.v1` Task looks
like:

```json
{
  "rpcUrl": "https://sepolia.base.org",
  "tasks": [
    {
      "id": "test-1",
      "description": "The service is healthy and responding.",
      "solverType": "prediction.v0",
      "role": "restoration",
      "spec": {}
    }
  ]
}
```

`jinn tasks list` and `jinn tasks show <id>` read this config directly —
no chain call, no daemon required:

```bash
jinn tasks list --json
jinn tasks show test-1 --json
```

## 4. Post a Task with `jinn tasks submit`

`jinn tasks submit` posts a Task on-chain through the same creator Safe the
daemon uses. It is idempotent on `--id`: re-posting the same id from the
same creator Safe returns the existing request id instead of sending a new
transaction.

`--solver-type` targets a registered SolverType directly and needs no other
setup. `--solver-net <name>` targets a SolverNet you have already joined
(`jinn solver-nets list` / `jinn solver-nets join`) and fails with `Unknown
SolverNet: <name>` otherwise — reach for `--solver-type` first:

```bash
jinn tasks submit \
  --id usdc-apy \
  --description "Aave APY" \
  --solver-type prediction.apy.v0 \
  --spec-file fixtures/prediction-apy-v0-intent.example.json \
  --yes
```

Two flags shape the on-chain claim slots, both defaulting to `1`:

- `--max-claims <n>` — number of attempt slots. The default of `1` is
  brittle on a shared network: one non-delivering claimer permanently locks
  the Task. Pass `--max-claims 5` (or similar) to let other operators still
  claim it.
- `--required-verdicts <n>` — number of verdict-claim slots per attempt.
  Raise this on a shared/adversarial network so an honest evaluator can
  still claim a verdict slot when others have been squatted (the
  per-evaluator cap stays `1`, so no single claimer takes them all).

`--spec-file` accepts typed fields for the registered SolverTypes
(`portfolio.v0`, `prediction.v1`, `prediction.apy.v0`) and resolves two
sentinels at post time: `window.startTs: 0` becomes `Date.now()`, and a
`spec.question.threshold` of `"current"` / `"current+0.5%"` /
`"current-2%"` / `"current+100"` reads the named Chainlink feed and
resolves it against the live price.

Run `--dry-run` first if you want to see what would be posted without
sending a transaction:

```bash
jinn tasks submit --id usdc-apy --description "Aave APY" \
  --solver-type prediction.apy.v0 --spec-file fixtures/prediction-apy-v0-intent.example.json \
  --dry-run
```

## 5. Observe the delivery

```bash
jinn status --detail --human
jinn history --limit 20 --human
```

`jinn status` gives the roll-up (daemon liveness, RPC reachability, fleet
`needsAttention` count, pending earnings) — the three fields a monitoring
loop needs are `rpc.ok`, `fleet.needsAttention`, and `exit.blocking`.
`jinn history` returns the event log itself (`task_posted`,
`request_claimed`, `delivery_submitted`, `evaluation_submitted`,
`reward_claimed`). Or open the operator dashboard directly:

```bash
jinn ui
```

## A note on scope

This page documents the CLI/keystore path as it exists in this branch
today (`client/src/cli/commands/tasks.ts`, verified against a running
`jinn` build). The marketplace-surfaces design introduces a further
consumer-class split — a platform-implementer path (build a backend
against published conformance kits), a custody-conscious work-client path
(KMS/HSM signer, dedicated posting Safe), and a read-only composition path
(discovery + evidence retrieval, no posting). Those trees
(`packages/marketplace/`, `packages/task-execution/`, `packages/discovery/`,
`packages/trust/` and their conformance kits) live on
`integration/evidence-v1` and are not present on this branch yet. This page
will gain siblings and a cross-linking index once that work lands on
`next`.
