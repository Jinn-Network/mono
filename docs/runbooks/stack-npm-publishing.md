# Platform stack npm publishing runbook

**Scope:** the catalog-derived stack-published release groups `sealed-platform-v1` (11 packages)
and `implementations-v1` (53 packages). Their exact package sets, runtime waves,
trusted-publisher inputs, and policy are generated in the
[live platform topology](../../architecture/generated/platform-topology.md#release-and-trusted-publishers).
Workflow: `.github/workflows/stack-npm-publish.yml`. Verified publisher:
`.github/scripts/publish-verified-platform.mjs`.
The count contract is pinned by `.github/scripts/stack-trusted-publishers.test.mjs`.

## Current release policy

- Both stack-published groups are catalog-permitted for receipt-gated canary and for a later
  stable cut (`canary-and-stable`, `stable: true`). A push to `integration/evidence-v1` or `next`
  uses the `canary` dist-tag and the `npm-publish` GitHub environment, and the canary job is a
  matrix over both groups.
- Canary publication is **operationally enabled** as of 2026-08-17
  ([DR-2026-08-17-d](../../log/decisions/2026-08-17-platform-canary-publish-enabled.md)):
  repository variable `PLATFORM_CANARY_PUBLISH_ENABLED=true`. The next push to `next` or
  `integration/evidence-v1` whose same-run verification succeeds will publish
  `0.1.0-canary.sha.<fullSha>` under dist-tag `canary`. That is not `latest` and not a
  `stack-v*` cut.
- The trusted-publisher set is the union of both groups: **64** rows, one registration each,
  bound to `stack-npm-publish.yml` and `npm-publish`. Per-group publication receipts are a subset
  of that list. The generated topology is authoritative for membership.
- The two `experimental-policy` packages remain disabled and are not part of either
  stack-published set. Native-role closure is test evidence, not a canary publication promise.
- Stable publication is still mechanically disabled. A stable event may run read-only tag
  resolution, same-run verification, and `stable-live-host-verification`, but no stable publisher
  job exists for `stable-publish-gate` to unblock. The hold remains until live `spec.jinn.network`
  profile hosting is deployed and that gate is observed green against it.
- Legacy and product packages remain independent release lines (or private/never-published) under
  their catalog policies and existing workflows. This runbook does not change the layer, SDK,
  client, plugin, or other independent publication paths.

The generated topology is authoritative for current membership and counts.

## Canary verification and publication

One workflow run performs the whole chain:

1. Check out and bind the source SHA and catalog digest.
2. Run every catalog-selected domain gate and require exact success.
3. Validate catalog-declared public surfaces and assemble the profile root.
4. Pack the exact catalog release set into manifest-derived runtime waves. Development-only edges
   never affect the order.
5. Record every exact tarball and its SHA-512 integrity, then install those tarballs from a clean
   external consumer.
6. Emit and attest an immutable verification receipt binding source, catalog, lane, package order,
   waves, tarballs, public surfaces, profile manifest, and exact job conclusions.
7. In the dependent publisher job, independently reconstruct the receipt, recheck the exact
   artifact inventory and trusted-publisher set, and publish only the receipt-bound tarballs.
8. Re-read registry version, integrity, and dist-tag, then emit and attest the publication receipt.

No workflow-run polling or replacement packing is allowed. The package bytes published to npm are
the bytes verified earlier in the same run.

## Inspecting generated order

Regenerate or check the tracked topology without publishing:

```bash
node .github/scripts/generate-architecture.mjs
node .github/scripts/generate-architecture.mjs --check
```

The generated runtime waves are the current publication plan.

## npm trusted-publisher configuration

The registration list is generated from the same exact release set:

```bash
node .github/scripts/stack-trusted-publishers.mjs --out /tmp/jinn-registrations
```

The generator is not proof that npmjs has the row. A catalog package with no name
reservation and no trusted-publisher binding fails `npm publish` with `ENEEDAUTH`
(or `E404` / HTTP `403`). `.github/scripts/publish-verified-platform.mjs` walks
receipt waves in order and throws on that failure, so every subsequent package in
the walk is not published. Between 2026-08-29 and 2026-09-01, unregistered
`@jinn-network/evidence-offer` failed mid-walk and truncated that canary walk;
`evidence-offer` was registered 2026-09-01 and that failure is resolved. The same
failure is recurring now: `@jinn-network/contract-abis`, `@jinn-network/evidence-gate`,
and `@jinn-network/record-discovery-facts-offers` have no npm registration, and the
`implementations-v1` canary has failed with `ENEEDAUTH` on every push since
2026-09-01T17:34Z, currently truncated at `@jinn-network/contract-abis` (the first of
the three in wave order). Complete the CLI (or web UI) registration **before** merging a
catalog addition; see the completion checklist below for the three still outstanding.

npm trusted-publisher configuration requires the package to already exist on the
registry. For each generated name that is not yet on npmjs, reserve it first with a
throwaway placeholder package, not the workspace package directory: every generated
`package.json` on `next` is already version `0.1.0` with a `prepack: yarn build` step,
so publishing from the package directory would publish built `0.1.0` bytes under the
`bootstrap` tag and burn the future stable version; and the four evidence packages
(`evidence-gate`, `evidence-offer`, `evidence-trace`, `evidence-trace-decode`) set
`publishConfig.provenance: true`, which a local `npm publish` cannot satisfy
(`EUSAGE: Automatic provenance generation not supported for provider`). Reserve from an
empty temporary directory instead (npm 11.15+; an npm scope owner, locally, with 2FA):

```bash
mkdir /tmp/jinn-reserve-<package> && cd /tmp/jinn-reserve-<package>
cat > package.json <<'EOF'
{
  "name": "@jinn-network/<package>",
  "version": "0.0.0",
  "description": "Name reservation for npm trusted-publisher setup. Not a platform receipt.",
  "publishConfig": { "access": "public" }
}
EOF
npm publish --access public --tag bootstrap
npm trust github @jinn-network/<package> \
  --repo Jinn-Network/mono \
  --file stack-npm-publish.yml \
  --environment npm-publish \
  --allow-publish
```

This placeholder has no `provenance` field, so the reservation publish itself never
hits the provenance error above. Publishing it under `--tag bootstrap` also sets
`latest` to `0.0.0`: npm tags a package's first published version `latest` regardless
of which tag the publish names, so `latest` stays `0.0.0` until the first real publish.

`npm trust github` is the CLI equivalent of the npmjs Trusted Publisher form.
Both paths must produce these exact fields:

| npmjs field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Jinn-Network` |
| Repository | `mono` |
| Workflow filename | `stack-npm-publish.yml` |
| Allowed action | `npm publish` |
| Environment | `npm-publish` |

The Environment field must equal `npm-publish`, and the allowed action must be exactly
`npm publish`. This binds registry authority to the final protected publication job; build,
external-consumer, receipt-construction, and stable-verification jobs never enter that environment.
The stable lane remains on hold and does not publish from `npm-stable-publish`. There is still no
stable publisher job.

See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

An npm scope owner must complete this once for every generated registration:

- [x] Confirm the operator belongs to a team in the `@jinn-network` npm organization. (`ritsukai` / `@jinn-network:developers`)
- [ ] Regenerate the list and compare it with the generated release view (64 names;
  topology union), then add every registration using the CLI path above (or the npmjs
  web UI with the same fields), including Environment `npm-publish`. **Incomplete**: 61
  of the 64 generated names are registered; three are not: `@jinn-network/contract-abis`,
  `@jinn-network/evidence-gate`, and `@jinn-network/record-discovery-facts-offers`
  (`npm view <name> version` returns `E404` for each). The `implementations-v1` canary is
  currently truncated at the first of them in wave order, `@jinn-network/contract-abis`
  (wave 1), and stays truncated until a scope owner reserves and binds all three, using
  the reservation method above. Reserving and binding these names is an operator action;
  it is not performed by this runbook change.
- [x] `@jinn-network/evidence-offer` registered 2026-09-01 by `ritsukai` via CLI: bootstrap `0.0.0` (`npm publish --tag bootstrap`) then `npm trust github` (GitHub Actions / `Jinn-Network/mono` / `stack-npm-publish.yml` / environment `npm-publish` / allow publish). The package joined the release catalog on 2026-08-29 (#3217).
- [ ] Protect the `npm-publish` GitHub environment with required reviewers and allowed branches. **Explicitly skipped 2026-08-17** — shared with operator/client canary; see [DR-2026-08-17-d](../../log/decisions/2026-08-17-platform-canary-publish-enabled.md).
- [x] Add no `NODE_AUTH_TOKEN` or other long-lived npm credential.
- [x] Run the full hosted verifier and record its exact successful source SHA. (`b546aa40fe82aab95552bbb7270846f0500fdf10`, [run 32065136927](https://github.com/Jinn-Network/mono/actions/runs/32065136927))
- [x] Set repository variable `PLATFORM_CANARY_PUBLISH_ENABLED=true` only after every preceding item is recorded.
- [x] Record the operator and completion date in the operational change record. ([DR-2026-08-17-d](../../log/decisions/2026-08-17-platform-canary-publish-enabled.md))

## Recovery

Publication is idempotent only when an existing registry version has the exact receipt integrity
and dist-tag. Matching bytes are skipped; missing bytes are published in receipt wave order. If a
version already exists with different bytes, stop and cut a new version—npm versions are immutable.
Never repair the mismatch by repacking, moving a tag, or weakening receipt verification.

**`ENEEDAUTH`, `E404`, or HTTP `403` during `npm publish`:** a generated catalog name is missing
from npmjs or has no trusted-publisher row bound to `stack-npm-publish.yml` / `npm-publish`.
`publish-verified-platform.mjs`'s `publishMissingTarballs` throws out of both the per-wave
and the per-package loop, so every later package in that release group's walk (the rest of
the wave and all later waves) is not published; the other matrix group (`sealed-platform-v1`
or `implementations-v1`, whichever did not fail) is unaffected, since `canary-publish` runs
both release groups as a `fail-fast: false` matrix. Register the missing package with the CLI
path above, then rerun. Rerunning only works while this run's `platform-verification-artifacts`
artifact still exists (`retention-days: 1` in `platform-verification.yml`); once that window
passes, the next push to `next` is the retry, not a manual rerun of the old run. Do not treat
a partial walk as a successful canary.
