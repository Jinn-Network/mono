# Releasing @jinn-network/client

This package is published from the monorepo, but operators consume it as a standalone artifact:

- installed CLI: `npm install -g @jinn-network/client@latest`
- no-install trial: `npx -p @jinn-network/client@latest jinn <verb>` (the `-p` flag is required: the package ships two bins, `jinn` and `jinn-mcp`, and plain `npx @jinn-network/client@latest` exits with `could not determine executable to run`)
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
   npx -p @jinn-network/client@latest jinn version --json
   npx -p @jinn-network/client@latest jinn --help
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
npx -p @jinn-network/client@canary jinn version --json
npx -p @jinn-network/client@canary jinn --help
```

## Stable releases

1. Update `client/package.json` to the next stable semver.
2. Merge that version bump to `main`.
3. Run the exact release gates on the release commit:
   ```bash
   cd client
   yarn typecheck
   yarn test
   yarn build
   yarn pack:smoke
   yarn release:operator-gate
   yarn setup:testnet-acceptance-operator
   yarn release:testnet-acceptance
   ```
   The Docker acceptance gate is documented in [TESTNET_ACCEPTANCE.md](./TESTNET_ACCEPTANCE.md).
4. Create the Git tag and GitHub release using the package-specific tag shape:
   ```bash
   git tag client-vX.Y.Z
   git push origin client-vX.Y.Z
   gh release create client-vX.Y.Z --title "client vX.Y.Z"
   ```

Release workflow contract:

- `client-vX.Y.Z` must match `client/package.json` version exactly.
- npm publishes `@jinn-network/client@X.Y.Z` as `latest`.
- Docker publishes:
  - `ghcr.io/jinn-network/client:X.Y.Z`
  - `ghcr.io/jinn-network/client:sha-<shortsha>`
  - `ghcr.io/jinn-network/client:latest`

Post-release verification:

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
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-..." >> .env
docker compose up -d
```
