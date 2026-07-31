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
you are **class 3, not class 1** — see the class-3 row in
[`docs/quickstarts/README.md`](README.md) (`class-3-work-client.md`, not yet
landed on this branch).

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
like (`prediction.v1`, `prediction.apy.v0`, and `portfolio.v0` are the
registered SolverTypes with typed spec support; see
`client/src/solver-types/index.ts`):

```json
{
  "rpcUrl": "https://sepolia.base.org",
  "tasks": [
    {
      "id": "eth-up",
      "description": "Will ETH/USD be higher one hour from now than it is now?",
      "solverType": "prediction.v1",
      "role": "restoration",
      "window": { "startTs": 0, "endTs": 0 },
      "spec": {
        "oracle": {
          "venue": "chainlink-base-sepolia",
          "feed": "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
          "feedDescription": "ETH / USD"
        },
        "question": {
          "kind": "threshold",
          "operator": "GT",
          "threshold": "current",
          "resolveTs": 0
        }
      },
      "eligibility": { "maxSubmissionDelayMs": 60000 }
    }
  ]
}
```

`jinn tasks list` and `jinn tasks show <id>` read this config directly —
no chain call, no daemon required (verified: both commands echo the entry
above unchanged):

```bash
jinn tasks list --json
jinn tasks show eth-up --json
```

This config entry is enough for `list`/`show`. It is not enough to post on
its own: the same daemon creator loop that reads `config.tasks` still
requires a `solverNetManifestCid` before it will submit — see the manifest
CID requirement in the next section, which applies here too.

## 4. Post a Task with `jinn tasks submit`

`jinn tasks submit` posts a Task on-chain through the same creator Safe the
daemon uses. It is idempotent on `--id`: re-posting the same id from the
same creator Safe returns the existing request id instead of sending a new
transaction.

Every submit needs a **manifest CID**: the on-chain `manifestDigest` is
`keccak256(solverNetManifestCid)`
(spec/2026-05-05-solvernet-creation-and-launch.md §14), and `jinn tasks
submit` refuses with `invalid_invocation` — `--manifest-cid is required (or
--solver-net pointing at an entry in joinedSolverNets with a
manifestCid)` — if it cannot resolve one. There is no setup-free path:

- `--solver-net <name>` resolves the CID from a SolverNet you have already
  **joined**. There is currently no `jinn solver-nets join` CLI verb —
  joining happens through the operator dashboard (`jinn ui`, Operator >
  SolverNets), which writes the entry to `joinedSolverNets` in your config.
  Once joined, `jinn solver-nets list` shows the name and CID, and
  `--solver-net <name>` resolves it for you. An unjoined name fails with
  `Unknown SolverNet: <name>`.
- `--solver-type <type>` targets a registered SolverType directly, but you
  must still pass the manifest CID yourself with `--manifest-cid <cid>`.

Save the spec to a file — the published `@jinn-network/client` package does
not ship the repo's `fixtures/` directory, so write it yourself rather than
pointing at a path that will not exist on your machine:

```bash
cat > apy-task.json <<'EOF'
{
  "solverType": "prediction.apy.v0",
  "window": { "startTs": 0, "endTs": 0 },
  "spec": {
    "oracle": {
      "venue": "aave-v3-base-sepolia",
      "pool": "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
      "reserve": "0x31d3A7711a10C45D72649D51E1c8D74282702572",
      "reserveSymbol": "USDC"
    },
    "metric": {
      "type": "supply-apy-twa-bps",
      "twaWindowSeconds": 3600,
      "sampleCount": 12,
      "toleranceBps": 50
    },
    "question": { "resolveTs": 0 }
  },
  "eligibility": {}
}
EOF
```

Then post it, with a manifest CID from a SolverNet you have joined
(`--manifest-cid <cid>` below stands in for that value — see above):

```bash
jinn tasks submit \
  --id usdc-apy \
  --description "Aave APY" \
  --solver-type prediction.apy.v0 \
  --manifest-cid <manifest-cid> \
  --spec-file apy-task.json \
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
  --solver-type prediction.apy.v0 --manifest-cid <manifest-cid> \
  --spec-file apy-task.json --dry-run
```

**`--dry-run` does not validate the manifest CID on this direct
`--solver-type`/`--id` invocation** — that check runs only on the real
submit path (and, separately, on the `--request-file` machine-request
path). A dry run that omits `--manifest-cid` will still print a plan; it is
not proof the real submit will succeed. Always include `--manifest-cid` (or
a joined `--solver-net`) in both your dry run and your real invocation.

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

Verified against `client/src/cli/commands/tasks.ts` and
`client/src/cli/commands/solver-nets.ts` on this branch, and against a
running `jinn` CLI for `tasks list`/`show`, `--help`, and the
`solver-nets` subverb dispatch. Classes 2–4's package trees
(`packages/marketplace/`, `packages/task-execution/`, `packages/discovery/`,
`packages/trust/`) live on `integration/evidence-v1` and land here once
merged to `next` — see [`README.md`](README.md).
