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
