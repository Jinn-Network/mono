# Releasing @jinn-network/operator

This package is published from the monorepo, but operators consume it as a standalone artifact:

- installed CLI: `npm install -g @jinn-network/operator@latest`
- no-install trial: `npx @jinn-network/operator@latest <verb>`
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
   npx @jinn-network/operator@latest version --json
   npx @jinn-network/operator@latest --help
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
npx @jinn-network/operator@canary version --json
npx @jinn-network/operator@canary --help
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

For Captain-driven GitHub Release publishes, the gate is **two SHA-bound
check-runs on the release commit** — nothing you type in the Release body:

- `hermetic-gate` — the native job of `.github/workflows/hermetic-gate.yml`.
- `environment-suite` — posted by
  `operator/scripts/release/post-check-run-verdict.mjs` from
  `.github/workflows/environment-suite.yml`.

`npm-publish.yml`'s stable-publish step resolves the release SHA, queries both
check-runs on that exact SHA, and refuses the publish unless both are
`success`-for-this-SHA. It re-runs nothing, and it parses no Release body. A
check-run bound to a different `head_sha` is stale and does not count, so a
rebase invalidates a stale verdict automatically. See the two-gate redesign
([`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md`](../docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md)
§7) and the guard itself at `.github/workflows/npm-publish.yml`.

Both gates carry a transitional repo-variable waiver —
`JINN_HERMETIC_GATE_WAIVED` and `JINN_ENVIRONMENT_SUITE_WAIVED`. When one is
`'true'` the guard logs the waiver loudly and skips that verdict. Unset is the
steady state; treat a set waiver as a cut you are publishing without that gate.

Before publishing, confirm both verdicts are green on the tagged commit:

```bash
for name in hermetic-gate environment-suite; do
  gh api -X GET repos/Jinn-Network/mono/commits/<release-sha>/check-runs \
    -f check_name="$name" -f per_page=100 \
    --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion) \(.head_sha)"'
done
```

Filter by `check_name` and raise `per_page` — the endpoint defaults to 30 results
and a release SHA on `next` carries far more check-runs than that, so an unfiltered
query can page right past both verdicts and print nothing.

A `jinn-release-evidence:v1` block may still appear in a Release body or in a
generated handoff under `docs/release/`. It is **diagnostic-only** — the same
annotation `writeHandoffDoc()` and
[`handoff-doc-template.md`](../.claude/skills/release-readiness/references/handoff-doc-template.md)
carry. Nothing parses it, and its absence or staleness blocks no publish.

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

If that run goes red, re-run it: `.github/workflows/docker.yml` takes a manual
`workflow_dispatch` with a `version` input, launched **from the release tag**
(#2811). The version must match the tag it was launched from and
`operator/package.json` at it, so a re-run publishes the released commit and
nothing else. Dispatching an *older* release tag is therefore also the rollback
lever: it moves `:latest` back to that release's commit. Tags cut before this
trigger landed cannot be dispatched at all — the workflow file runs as it exists
on the selected ref.

Re-running `yarn release:client --publish` afterwards completes the release: its
`docker.yml` wait accepts a successful `workflow_dispatch` run for the release
commit, not only a `release`-triggered one, so a dispatched republish clears the
`publish-wait-docker-workflow` step it would otherwise stay stuck on.

**Release checklist, after the first cut that publishes under
`ghcr.io/jinn-network/operator`:** verify `:latest` resolves anonymously
(`docker pull ghcr.io/jinn-network/operator:latest` with no registry auth), then
repoint the run-it-now examples in `DEPLOY.md`, `deploy/README.md` and
`operator/docker-compose.yml` from `:next` back to `:latest`, and drop the
"not published under this name yet" notes in the first two. They name `:next`
only because the stable tags do not exist under this name yet.

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
