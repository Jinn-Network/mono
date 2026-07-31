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

`jinn run` already sequences the steps above (password, bootstrap, fleet
state machine, then the daemon) as one command — that is what "on first run
this walks the earning bootstrap" above means in practice. `jinn quickstart`
is a legacy compatibility alias for the same zero-to-running flow; new
operators should use `jinn run` as shown here, not `jinn quickstart`.

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
no chain call, no daemon required. `show` echoes the full entry; `list`
projects each task down to `id`, `description`, `solverType`, and `role`
(verified against both commands' output on this config):

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
manifestCid)` — if it cannot resolve one. There is no setup-free path.
There is currently no `jinn solver-nets join` CLI verb — joining happens
through the operator dashboard's Settings tab → Registry
(`jinn ui`, then `/operator/registry`), which writes the entry to
`joinedSolverNets` in your config. Once joined, `jinn solver-nets list`
shows the name and CID.

Two ways to supply the CID, and they are not interchangeable:

- **`--solver-net <name>` (recommended).** Resolves both the manifest CID
  *and* the SolverType from the SolverNet you joined — you do not pass
  `--solver-type` at all, so the two values cannot disagree. An unjoined
  name fails with `Unknown SolverNet: <name>`.
- **`--solver-type <type>` + `--manifest-cid <cid>`.** Targets a registered
  SolverType directly and supplies the manifest CID yourself. **Nothing
  cross-checks that the two agree** — `jinn tasks submit` resolves the
  SolverType and the manifest CID independently, so pairing a SolverType
  with a manifest CID from a *different* SolverNet posts a Task that
  claim eligibility routes to the wrong operators (whoever joined the
  SolverNet the CID actually names, running that net's harness, against a
  contract they never joined for). It is claimed and then goes nowhere —
  §5 below never fires. Use this form only when the manifest CID you pass
  is the CID of the SolverNet that declares this exact SolverType.

Save the spec to a file — the published `@jinn-network/client` package does
not ship the repo's `fixtures/` directory, so write it yourself rather than
pointing at a path that will not exist on your machine. (`prediction.v1`
is not used for this worked example: its committed spec-file schema is a
Polymarket binary-question shape, not the Chainlink-threshold shape a
`prediction.v1` config entry might suggest — see the note at the end of
this section. `prediction.apy.v0`'s schema is what is shown below,
end to end, against a real dry run.)

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

Then post it with `--solver-net <name>` — no `--solver-type`, no
`--manifest-cid`, so both resolve from the same joined entry and cannot
disagree:

```bash
jinn tasks submit \
  --id usdc-apy \
  --description "Aave APY" \
  --solver-net <name-from-jinn-solver-nets-list> \
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
(`portfolio.v0`, `prediction.v1`, `prediction.apy.v0`) and resolves one
sentinel at post time for `prediction.apy.v0`: `window.startTs: 0` becomes
`Date.now()`.

If you have no joined SolverNet yet, or you need a SolverType your joined
net does not declare, use the secondary form on the same file — with the
same manifest-CID caveat as above:

```bash
jinn tasks submit \
  --id usdc-apy \
  --description "Aave APY" \
  --solver-type prediction.apy.v0 \
  --manifest-cid <manifest-cid-of-the-net-declaring-prediction.apy.v0> \
  --spec-file apy-task.json \
  --yes
```

Run `--dry-run` first if you want to see what would be posted without
sending a transaction — either form accepts it:

```bash
jinn tasks submit --id usdc-apy --description "Aave APY" \
  --solver-net <name-from-jinn-solver-nets-list> \
  --spec-file apy-task.json --dry-run
```

**`--dry-run` does not validate the manifest CID on the direct
`--solver-type`/`--manifest-cid` invocation** — that check runs only on the
real submit path (and, separately, on the `--request-file` machine-request
path). A dry run of that form omitting `--manifest-cid` will still print a
plan; it is not proof the real submit will succeed, and it cannot catch a
SolverType/manifest-CID mismatch either way. Always include the manifest
CID (or a joined `--solver-net`) in both your dry run and your real
invocation.

**A note on `prediction.v1` and this section's `--solver-net prediction`
naming.** The registered `prediction.v1` SolverType (`SOLVER_TYPES['prediction.v1']`
in `client/src/solver-types/index.ts`) validates spec files against a
Polymarket binary-question schema (`question.kind: "binary"`,
`source.venue: "polymarket"`, plus `resolution`/`consensusSnapshot`/
`eligibilitySnapshot` blocks) — confirmed by running `jinn tasks submit
--dry-run` against both a Chainlink-shaped spec and the repo's own
`fixtures/prediction-v1-task.example.json` (which is Chainlink-shaped) on
this branch: both fail `parseSpec` with the same schema errors. The
Chainlink-threshold shape shown in §3's config example belongs to a
separate, unregistered `legacyChainlinkPredictionV1` definition
(`client/src/solver-types/prediction-v0.ts`) kept only for spec-parsing
reuse by other code, not for `jinn tasks submit`. §3's example is accurate
for `jinn tasks list`/`show` (which echo config verbatim without SolverType
validation) but would not pass `jinn tasks submit` as written today. This
is a repo-level fixture/schema mismatch, not a quickstart-authoring choice
— filed as [#2314](https://github.com/Jinn-Network/mono/issues/2314) rather
than patched here.

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
running `jinn` CLI for `tasks list`/`show`, `solver-nets list`, and
`tasks submit --dry-run` (both the `--solver-net` and
`--solver-type`/`--manifest-cid` forms, driven against a `prediction.apy.v0`
spec file, reaching past SolverType/spec validation). Classes 2–4's package trees
(`packages/marketplace/`, `packages/task-execution/`, `packages/discovery/`,
`packages/trust/`) live on `integration/evidence-v1` and land here once
merged to `next` — see [`README.md`](README.md).
