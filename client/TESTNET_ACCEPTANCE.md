# Docker-First Testnet Acceptance Gate

This runbook is the manual release-manager gate that sits after the existing
fork-based checks and before creating a stable `client-vX.Y.Z` release.

The acceptance standard is now Docker-first:

1. build the local release-candidate image from `client/Dockerfile`
2. run the daemon through `docker-compose.acceptance.yml`
3. reuse one dedicated Docker data volume and one dedicated Claude auth volume
4. observe two successful protocol cycles on Base Sepolia
5. inspect `status`, `fleet`, `rewards`, and `history`
6. execute `jinn claim-rewards`
7. retain evidence under `client/acceptance-runs/`

The old host-installed full acceptance flow is no longer the release gate. It
remains available only as a debug/smoke path:

```bash
yarn setup:testnet-acceptance-operator:host
yarn release:testnet-acceptance:host
```

## Inputs

Create `client/.env.acceptance` from the checked-in example:

```bash
cd client
cp .env.acceptance.example .env.acceptance
```

**Keystore password** — set `JINN_PASSWORD` (or `JINN_TESTNET_ACCEPTANCE_PASSWORD`) in `.env.acceptance` *or* rely on the same file the CLI uses after `jinn run`:

- `~/.jinn-client/keystore-password`

The acceptance scripts read that file automatically when the env vars are unset, so you do not need to paste the password into `.env` on every run.

RPC source:

```bash
set -a && . ./.env && set +a
```

The Docker acceptance scripts merge:

1. `client/.env`
2. `client/.env.acceptance`
3. the current shell environment

`JINN_TESTNET_ACCEPTANCE_RPC_URL` is optional. If unset, the gate falls back to
`BASE_SEPOLIA_RPC_URL` from `client/.env`.

## Generated files and persistent state

The setup and release scripts generate:

```text
client/.acceptance/config.json
client/.acceptance/docker-compose.env
```

Do not edit `client/.acceptance/docker-compose.env` by hand. It is regenerated
from `client/.env`, `client/.env.acceptance`, and the current shell environment
on every setup or release run. Durable secrets for acceptance, including
`CLAUDE_CODE_OAUTH_TOKEN`, belong in `client/.env.acceptance` or in the shell
environment for a single run. Do not paste OAuth tokens into chat, issue
trackers, or release reports; use the ignored `.env.acceptance` file or an
operator secret manager.

The dedicated Docker acceptance environment persists state in these named volumes:

- `jinn-acceptance-data-volume`
- `jinn-acceptance-claude-auth-volume`

These are intentionally distinct from the normal operator compose volumes.

## Minimal checklist

1. Prepare env:
   ```bash
   cd client
   cp -n .env.acceptance.example .env.acceptance
   set -a && . ./.env && set +a
   ```
2. One-time setup and bootstrap. On Base Sepolia, bootstrap attempts the
   bundled CDP faucet automatically; manual ETH funding is only a fallback if
   the faucet is unavailable or rate-limited:
   ```bash
   yarn setup:testnet-acceptance-operator --bootstrap
   ```
3. Authenticate Claude for Docker (one-time, on your host machine):
   ```bash
   claude setup-token
   ```
   Add the resulting `sk-*` token to `client/.env.acceptance`:
   ```bash
   echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env.acceptance
   ```
   Do not share this token in chat. Treat it as operator-local release
   infrastructure.
   Do not put this only in `.acceptance/docker-compose.env`; the next run will
   overwrite that file.
4. Run the steady-state release gate:
   ```bash
   yarn release:testnet-acceptance
   ```
5. Review `client/acceptance-runs/<timestamp>-<runId>/summary.json`.

## First-time setup

Before the first acceptance run on a machine, initialize the dedicated Docker
acceptance environment:

```bash
cd client
yarn setup:testnet-acceptance-operator
```

That script:

- writes `client/.acceptance/config.json`
- writes `client/.acceptance/docker-compose.env`
- builds the local image used for acceptance
- initializes the operator keystore inside `jinn-acceptance-data-volume`
- prints Base Sepolia funding requirements

To complete bootstrap, run:

```bash
yarn setup:testnet-acceptance-operator --bootstrap
```

On Base Sepolia, `bootstrap` attempts to fund the master wallet through the
bundled CDP faucet. If the faucet is unavailable, rate-limited, or still cannot
reach the bootstrap floor, the command prints the remaining manual funding
requirement and can be re-run after funding.

Docker acceptance sets testnet-specific gas floors in
`client/.acceptance/config.json` (`minEoaGasWei=0.001 ETH`,
`minSafeEthWei=0.0002 ETH`) so the release gate matches the bundled faucet
budget. Override them with `JINN_TESTNET_ACCEPTANCE_MIN_EOA_GAS_WEI` and
`JINN_TESTNET_ACCEPTANCE_MIN_SAFE_ETH_WEI` only when intentionally testing a
larger runway.

Docker acceptance gates on `prediction.v0` cycles produced by the testnet
auto-intent generator (Chainlink Base Sepolia ETH/USD threshold predictions).
Each cycle requires both a successful `restoration-result` artifact and a
successful `evaluation-verdict` artifact for the same on-chain `request_id`.
The default cycle target is one (smoke test, not soak); bump via
`JINN_TESTNET_ACCEPTANCE_TARGET_CYCLES` if you want a larger sample.

Cycle-shaping params are tuned for the gate via
`JINN_PREDICTION_V0_WINDOW_MS=120000` and `JINN_PREDICTION_V0_RESOLVE_GAP_MS=60000`,
so one full restoration → delivery → evaluation round-trip lands inside the
20-min timeout. Default operator setup uses `600000` / `300000` (10-min window
+ 5-min resolve gap), unchanged.

`prediction.v0` intents post through `JinnRouterV2`, not the shared
`ClaimRegistry` — so the gate does not race third-party operators on the
legacy registry surface.

The acceptance config sets `restorers.wrapWith: null` to disable the
`claude-code-learner` universal wrapper for the gate. The gate's job is to
verify the protocol loop end-to-end via the base prediction.v0 impls
(`prediction-v0-baseline` + `prediction-v0-evaluator`); the wrapper layer is
separately validated and out of gate scope. Default operator setup keeps the
wrapper enabled.

Then authenticate Claude for Docker (on your host machine, one-time):

```bash
claude setup-token
```

Add the resulting token to `client/.env.acceptance`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env.acceptance
```

Do not paste the token into chat or issue trackers. If the token rotates, update
the ignored local `.env.acceptance` file or the operator secret manager.

The release gate checks this before `jinn doctor`. If the generated compose env
has no token and the dedicated Claude auth volume is not already logged in, the
gate stops with the durable `.env.acceptance` fix and the optional volume-login
command.

## Modes

- `steady-state` (default): reuse the existing Docker data and auth volumes
- `fresh-state`: clears the acceptance data volume before the run; use this only for onboarding/regression validation

Run fresh-state explicitly:

```bash
yarn release:testnet-acceptance --mode fresh-state
```

Routine stable-release validation should stay on the default steady-state mode.

## Acceptance criteria

The harness fails unless all of these are true:

- local Docker image build succeeds
- `jinn version` and `jinn --help` succeed from the local image
- `jinn doctor` and `jinn bootstrap` succeed through the acceptance compose environment
- at least one service is `complete`
- the daemon starts and emits a `daemon_started` record
- both run-scoped desired states produce a successful `restoration-result` artifact and a successful `evaluation-verdict` artifact during the run window
- `jinn status`, `jinn fleet`, `jinn rewards`, and `jinn history` remain coherent after the run
- `jinn claim-rewards --yes` is exercised after the run
- when pending rewards are visible, the claim submits at least one transaction
- when no pending rewards are visible, the claim result records the expected idempotent no-pending state

Cycle completion is determined from append-only artifact evidence in the shared
SQLite store, not from `history` deltas.

## Evidence

Each run records:

- image tag and embedded commit
- generated config inputs
- bootstrap result
- daemon startup JSON
- daemon logs
- poll log showing artifact-based cycle progress
- post-run `status`, `fleet`, `rewards`, `history`
- `claim-rewards` result
- final `summary.json`

Review and retain the evidence directory for the exact stable release commit.
