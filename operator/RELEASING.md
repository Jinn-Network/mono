# Releasing @jinn-network/operator

This package is published from the monorepo, but operators consume it as a standalone artifact:

- installed CLI: `npm install -g @jinn-network/operator@latest`
- no-install trial: `npx -p @jinn-network/operator@latest jinn <verb>`
- container: `ghcr.io/jinn-network/operator:<version>`

The npm workflow uses one trusted-publishing workflow file: [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml). Stable releases are cut from tags shaped like `v<semver>` (new, produced by the Monday scaffold workflow) or `client-v<semver>` (legacy). The engineering handbook ([`docs/engineering/handbook.md`](../docs/engineering/handbook.md)) is the canonical reference for the cadence.

The release flow has six layers:

1. fast CI in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
2. the fork-based local operator gate (`yarn release:operator-gate`) — **now runs automatically in `npm-publish.yml` on stable publishes** (jinn-mono-2cl.7); previously manual
3. the tokenless OLAS rails smoke gate (`yarn release:olas-rails-smoke`) — **runs during `yarn release:client --prepare` in dry-run mode** and must be attached as release evidence before publishing; use `yarn release:olas-rails-smoke --execute` for live Base Sepolia proof (see [docs/runbooks/sepolia-olas-rails-smoke.md](../docs/runbooks/sepolia-olas-rails-smoke.md))
4. the contracts release gate (`cd ../contracts && yarn test`, `forge install foundry-rs/forge-std --no-git`, then `forge test --match-contract Invariant`)
5. the manual app-first SWE-rebench v2 and data-donation testnet acceptance gate, with Docker diagnostics retained as supporting evidence (see [TESTNET_ACCEPTANCE.md](./TESTNET_ACCEPTANCE.md))
6. the GitHub Release workflows for npm `latest` and GHCR

The package's `prepublishOnly` script (`yarn typecheck`) runs on every `npm publish` as a final type-check safety net. The workflow (`npm-publish.yml`) explicitly runs `yarn typecheck`, `yarn build`, and `yarn test` as unconditional steps before publish, and on stable publishes additionally reruns layer 2 above. Layer 3 remains mandatory release-prep evidence because it depends on live local operator state. Keeping `prepublishOnly` to just `yarn typecheck` avoids a redundant rebuild in CI between the gate steps and the actual `npm publish` call — the artifact npm packs is the same one the gates validated. **If you run `npm publish` locally (e.g. from a clean checkout), make sure to `yarn build` first** — the workflow handles this automatically.

The old host-installed full acceptance run remains available only as a secondary debug path:

```bash
yarn setup:testnet-acceptance-operator:host
yarn release:testnet-acceptance:host
```

## One-time bootstrap publish

Do this once because the package did not exist on npm initially.

1. Work from a clean `main` commit with the intended `operator/package.json` version.
2. Run the local release checks:
   ```bash
   cd operator
   yarn typecheck
   yarn test
   yarn build
   yarn pack:smoke
   yarn release:operator-gate
   yarn release:olas-rails-smoke
   cd ../contracts
   yarn test
   forge install foundry-rs/forge-std --no-git
   forge test --match-contract Invariant
   ```
3. Publish manually:
   ```bash
   npm publish --access public
   ```
4. Verify the registry artifact:
   ```bash
   npm view @jinn-network/operator version
   npx -p @jinn-network/operator@latest jinn version --json
   npx -p @jinn-network/operator@latest jinn --help
   ```

## Configure trusted publishing

After the bootstrap publish succeeds:

1. On npm, register a trusted publisher for `@jinn-network/operator`.
2. Bind it to:
   - GitHub repo: `Jinn-Network/mono`
   - workflow file: `npm-publish.yml`
   - environment: `npm-publish`
3. Remove any legacy npm token secrets once OIDC publishing is confirmed.

## Canary releases

Every push to `next` that touches `operator/**` triggers [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml).

- The workflow builds and tests the package.
- It rewrites the package version in CI to `<package.json version>-canary.<shortsha>`.
- It publishes that artifact with the npm dist-tag `canary`.

Post-publish verification:

```bash
npx -p @jinn-network/operator@canary jinn version --json
npx -p @jinn-network/operator@canary jinn --help
```

## Stable releases

1. Update `operator/package.json` to the next stable semver.
2. Merge that version bump to `main`.
3. Prepare the release on the exact release commit:
   ```bash
   cd operator
   yarn release:client --prepare
   ```
   This runs the local client gates, the fork-based operator gate, contract
   gates, Docker testnet acceptance setup with bootstrap, the Docker diagnostic
   gate, the OLAS rails smoke gate, and writes a report under
   `client/release-runs/<version>-<timestamp>/`. The app-first SWE-rebench v2
   and donated-data proof in [TESTNET_ACCEPTANCE.md](./TESTNET_ACCEPTANCE.md)
   must be attached to the release evidence before publishing.
4. Publish from that report:
   ```bash
   yarn release:client --publish --resume release-runs/<version>-<timestamp>
   ```
   The publish step creates `client-vX.Y.Z`, pushes it, creates the GitHub
   release, waits for npm/GHCR workflows, and verifies the published artifacts.

For Captain-driven GitHub Release publishes, add this exact evidence marker to
the Release body before clicking Publish. `release-commit` must be the commit
the `vX.Y.Z` tag points at:

```text
<!-- jinn-release-evidence:v1
release-tag=vX.Y.Z
release-commit=<git sha>
release-client-prepare=passed
olas-rails-smoke=passed
app-first-testnet-acceptance=passed
-->
```

`npm-publish.yml` refuses stable publishes when this marker is absent or points
at a different commit.

For command-flow validation without the live testnet gate:

```bash
yarn release:client --prepare --skip-acceptance
```

`--skip-acceptance` is not a stable-release gate; it exists to test the runner
itself. The current app-first testnet acceptance gate is documented in
[TESTNET_ACCEPTANCE.md](./TESTNET_ACCEPTANCE.md).

Release workflow contract:

- `client-vX.Y.Z` must match `operator/package.json` version exactly.
- npm publishes `@jinn-network/operator@X.Y.Z` as `latest`.
- Docker publishes:
  - `ghcr.io/jinn-network/operator:X.Y.Z`
  - `ghcr.io/jinn-network/operator:sha-<shortsha>`
  - `ghcr.io/jinn-network/operator:latest`

Post-release verification is performed by `yarn release:client --publish`.
The underlying checks are:

```bash
npm install -g @jinn-network/operator@latest
jinn version --json
jinn doctor --json
docker run --rm ghcr.io/jinn-network/operator:X.Y.Z version --json
docker run --rm ghcr.io/jinn-network/operator:X.Y.Z doctor --json
```

The real end-to-end daemon loop stays manual and local. It is intentionally not moved into GitHub Actions CI.

Also verify the documented Docker auth flow exactly as shipped:

```bash
claude setup-token                          # on host — produces sk-ant-oat01-...
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-..." >> .env.acceptance
docker compose up -d
```

Do not paste Claude OAuth tokens into chat or issue trackers. Keep durable
release auth in ignored local files such as `client/.env.acceptance`, a local
secret manager, or a one-run shell environment.
