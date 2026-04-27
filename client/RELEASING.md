# Releasing @jinn-network/client

This package is published from the monorepo, but operators consume it as a standalone artifact:

- installed CLI: `npm install -g @jinn-network/client@latest`
- no-install trial: `npx @jinn-network/client@latest <verb>`
- legacy no-install form (still supported): `npx -p @jinn-network/client@latest jinn <verb>`
- container: `ghcr.io/jinn-network/client:<version>`

The npm workflow uses one trusted-publishing workflow file: [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml). Stable releases are cut from tags shaped like `client-vX.Y.Z`.

The release flow has four layers:

1. fast CI in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
2. the fork-based local operator gate (`yarn release:operator-gate`)
3. the manual real testnet Docker acceptance gate (`yarn release:testnet-acceptance`; first-time setup: `yarn setup:testnet-acceptance-operator`, see [TESTNET_ACCEPTANCE.md](./TESTNET_ACCEPTANCE.md))
4. the GitHub Release workflows for npm `latest` and GHCR

The old host-installed full acceptance run remains available only as a secondary debug path:

```bash
yarn setup:testnet-acceptance-operator:host
yarn release:testnet-acceptance:host
```

## One-time bootstrap publish

Do this once because the package did not exist on npm initially.

1. Work from a clean `main` commit with the intended `client/package.json` version.
2. Run the local release checks:
   ```bash
   cd client
   yarn typecheck
   yarn test
   yarn build
   yarn pack:smoke
   yarn release:operator-gate
   ```
3. Publish manually:
   ```bash
   npm publish --access public
   ```
4. Verify the registry artifact:
   ```bash
   npm view @jinn-network/client version
   npx @jinn-network/client@latest version --json
   npx @jinn-network/client@latest --help
   ```

## Configure trusted publishing

After the bootstrap publish succeeds:

1. On npm, register a trusted publisher for `@jinn-network/client`.
2. Bind it to:
   - GitHub repo: `Jinn-Network/mono`
   - workflow file: `npm-publish.yml`
   - environment: `npm-publish`
3. Remove any legacy npm token secrets once OIDC publishing is confirmed.

## Canary releases

Every push to `main` that touches `client/**` triggers [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml).

- The workflow builds and tests the package.
- It rewrites the package version in CI to `<package.json version>-canary.<shortsha>`.
- It publishes that artifact with the npm dist-tag `canary`.

Post-publish verification:

```bash
npx @jinn-network/client@canary version --json
npx @jinn-network/client@canary --help
```

## Stable releases

1. Update `client/package.json` to the next stable semver.
2. Merge that version bump to `main`.
3. Prepare the release on the exact release commit:
   ```bash
   cd client
   yarn release:client --prepare
   ```
   This runs the local gates, Docker testnet acceptance, and writes a report
   under `client/release-runs/<version>-<timestamp>/`.
4. Publish from that report:
   ```bash
   yarn release:client --publish --resume release-runs/<version>-<timestamp>
   ```
   The publish step creates `client-vX.Y.Z`, pushes it, creates the GitHub
   release, waits for npm/GHCR workflows, and verifies the published artifacts.

For command-flow validation without the live testnet gate:

```bash
yarn release:client --prepare --skip-acceptance
```

`--skip-acceptance` is not a stable-release gate; it exists to test the runner
itself. The Docker acceptance gate is documented in
[TESTNET_ACCEPTANCE.md](./TESTNET_ACCEPTANCE.md).

Release workflow contract:

- `client-vX.Y.Z` must match `client/package.json` version exactly.
- npm publishes `@jinn-network/client@X.Y.Z` as `latest`.
- Docker publishes:
  - `ghcr.io/jinn-network/client:X.Y.Z`
  - `ghcr.io/jinn-network/client:sha-<shortsha>`
  - `ghcr.io/jinn-network/client:latest`

Post-release verification is performed by `yarn release:client --publish`.
The underlying checks are:

```bash
npm install -g @jinn-network/client@latest
jinn version --json
jinn doctor --json
docker run --rm ghcr.io/jinn-network/client:X.Y.Z version --json
docker run --rm ghcr.io/jinn-network/client:X.Y.Z doctor --json
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
