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

Required in `.env.acceptance` or your shell:

```bash
JINN_PASSWORD=your-keystore-password
```

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
2. One-time setup and funding checklist:
   ```bash
   yarn setup:testnet-acceptance-operator
   ```
3. Fund what `fund-requirements` printed, then finish bootstrap:
   ```bash
   yarn setup:testnet-acceptance-operator --bootstrap
   ```
4. Authenticate Claude for Docker (one-time, on your host machine):
   ```bash
   claude setup-token
   ```
   Add the resulting `sk-*` token to `client/.env.acceptance`:
   ```bash
   echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env.acceptance
   ```
5. Run the steady-state release gate:
   ```bash
   yarn release:testnet-acceptance
   ```
6. Review `client/acceptance-runs/<timestamp>-<runId>/summary.json`.

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

After funding, finish bootstrap:

```bash
yarn setup:testnet-acceptance-operator --bootstrap
```

Then authenticate Claude for Docker (on your host machine, one-time):

```bash
claude setup-token
```

Add the resulting token to `client/.env.acceptance`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-..." >> .env.acceptance
```

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
- pending rewards are visible before claim
- `jinn claim-rewards --yes` submits at least one claim

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
