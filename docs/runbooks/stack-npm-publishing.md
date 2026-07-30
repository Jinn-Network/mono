# Platform stack npm publishing runbook

**Scope:** the 45 platform packages under `packages/{task-execution,evidence,trust,discovery,marketplace,benchmarking}`. Issue #2293. Workflow: `.github/workflows/stack-npm-publish.yml`. Driver: `.github/scripts/publish-stack.mjs`.

## What publishes, and when

| Trigger | Version | Dist-tag | Environment |
| --- | --- | --- | --- |
| Push to `integration/evidence-v1` or `next` | `<setVersion>-canary.sha.<commit>` | `canary` | `npm-publish` |
| Release published with a `stack-v<semver>` tag | `<semver>` | `latest` | `npm-stable-publish` |

The whole set publishes every time, in dependency-graph order (8 waves). Nothing is
partially released: a wave verifies before the next starts, and a final pass reverifies
every package's tarball integrity and dist-tag together.

## Branch awareness

The 45 packages live on `integration/evidence-v1` and are not yet on `next`. The workflow
triggers on both branches and no-ops where the package set is absent, so it starts
publishing today and continues from `next` after the integration merge with no edit.

## Inspecting the plan without publishing

```bash
node .github/scripts/publish-stack.mjs --mode canary --sha "$(git rev-parse HEAD)" --dry-run
```

## npmjs trusted-publisher configuration

The registration list is generated, never hand-maintained. Download the
`stack-trusted-publishers` artifact from any run of the workflow, or generate it locally:

```bash
node .github/scripts/stack-trusted-publishers.mjs --out /tmp/registrations
```

`trusted-publishers.md` in that directory is the operator-facing checklist. It states the
exact npmjs field values and why the optional Environment field must be blank.

## Recovery

A failed publish is safe to re-run: every step is idempotent on exact tarball integrity, and
an already-published version with matching integrity is skipped. A version published with
*different* bytes is unrecoverable through this workflow by design — npm versions are
immutable and OIDC cannot repair a dist-tag. Cut a new version instead.

## Human checklist: npm trusted-publisher registration

An operator with npm owner rights on the `@jinn-network` scope must do this once per
package before the first canary of that package can publish. It cannot be automated:
npmjs has no API for trusted-publisher configuration.

- [ ] Confirm the operator is on a team in the `@jinn-network` org. A scope owner on **no**
      team gets a 404 on first publish, not a permission error. Fix with
      `npm team add @jinn-network:developers <user>`.
- [ ] Regenerate the list: `node .github/scripts/stack-trusted-publishers.mjs --out /tmp/jinn-registrations`
- [ ] For every row in `trusted-publishers.md`, open the npmjs package settings and add a
      trusted publisher with the exact field values in the table above.
- [ ] Leave the optional **Environment** field blank on every one of them.
- [ ] Add no `NODE_AUTH_TOKEN` and no long-lived npm credential anywhere.
- [ ] Confirm the two GitHub environments exist: `npm-publish` (canary, automatic) and
      `npm-stable-publish` (stable, required reviewer, branch policy).
- [ ] Record the date and the operator's handle in this file when complete.

For every row, in the npmjs package settings, add a trusted publisher with:

| npmjs field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Jinn-Network` |
| Repository | `mono` |
| Workflow filename | `stack-npm-publish.yml` |
| Allowed action | `npm publish` |
| Optional Environment | **Leave blank** |

The optional npmjs **Environment field MUST be blank**. npm permits one trusted
publisher configuration per package, and this one workflow publishes from two
GitHub environments: canaries from `npm-publish`, stable from `npm-stable-publish`.
Naming either environment in npmjs breaks the other lane.

| Package | Workflow filename |
| --- | --- |
| `@jinn-network/attestation-issuer` | `stack-npm-publish.yml` |
| `@jinn-network/benchmarking-aggregate` | `stack-npm-publish.yml` |
| `@jinn-network/benchmarking-interop` | `stack-npm-publish.yml` |
| `@jinn-network/benchmarking-marketplace` | `stack-npm-publish.yml` |
| `@jinn-network/benchmarking-records` | `stack-npm-publish.yml` |
| `@jinn-network/benchmarking-run` | `stack-npm-publish.yml` |
| `@jinn-network/benchmarking-testing` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-catalog-sqlite` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-contribution` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-derivation` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-discovery` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-local-runtime` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-protocol` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-publication` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-repository` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-repository-ipfs` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-repository-oci` | `stack-npm-publish.yml` |
| `@jinn-network/evidence-retrieval` | `stack-npm-publish.yml` |
| `@jinn-network/execution-recorder` | `stack-npm-publish.yml` |
| `@jinn-network/execution-recorder-bridge` | `stack-npm-publish.yml` |
| `@jinn-network/marketplace-binding` | `stack-npm-publish.yml` |
| `@jinn-network/marketplace-pipeline` | `stack-npm-publish.yml` |
| `@jinn-network/marketplace-projector` | `stack-npm-publish.yml` |
| `@jinn-network/marketplace-testing` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-client` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-facts-benchmarking` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-facts-evidence` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-facts-task-execution` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-facts-trust` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-protocol` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-serve` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-source-evidence-journal` | `stack-npm-publish.yml` |
| `@jinn-network/record-discovery-testing` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-backend` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-backend-local` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-evaluation-harness` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-launchers` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-profiles` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-protocol` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-supervisor` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-testing` | `stack-npm-publish.yml` |
| `@jinn-network/task-execution-workspace` | `stack-npm-publish.yml` |
| `@jinn-network/trust-core` | `stack-npm-publish.yml` |
| `@jinn-network/trust-resolve` | `stack-npm-publish.yml` |
| `@jinn-network/trust-testing` | `stack-npm-publish.yml` |
