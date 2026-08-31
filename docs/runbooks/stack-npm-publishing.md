# Platform stack npm publishing runbook

**Scope:** the catalog-derived stack-published release groups `sealed-platform-v1` (14 packages)
and `implementations-v1` (60 packages). Their exact package sets, runtime waves,
trusted-publisher inputs, and policy are generated in the
[live platform topology](../../architecture/generated/platform-topology.md#release-and-trusted-publishers).
Workflow: `.github/workflows/stack-npm-publish.yml`. Verified publisher:
`.github/scripts/publish-verified-platform.mjs`.

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
- The trusted-publisher set is the union of both groups: **73** rows, one registration each,
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

For every generated row, configure npmjs with:

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

An npm scope owner must complete this once for every generated registration:

- [x] Confirm the operator belongs to a team in the `@jinn-network` npm organization. (`ritsukai` / `@jinn-network:developers`)
- [x] Regenerate the list and compare it with the generated release view. (73 names; topology union)
- [x] Add every registration using the exact fields above, including Environment `npm-publish`.
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
