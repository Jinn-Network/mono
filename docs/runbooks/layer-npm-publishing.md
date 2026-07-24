# Layer npm trusted publishing runbook

This runbook configures and diagnoses OIDC publication for the extracted Jinn
packages. The workflow is `.github/workflows/layer-npm-publish.yml`; it publishes
automatic canaries and manually approved stable package sets without an npm
access token.

## npmjs trusted publisher configuration

Configure the same trusted publisher separately in the npmjs package settings
for all three packages:

- `@jinn-network/plugin`
- `@jinn-network/core`
- `@jinn-network/jinn-layer`

Use these exact values for each package:

The repository identity is `Jinn-Network/mono`.

| npmjs field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Jinn-Network` |
| Repository | `mono` |
| Workflow filename | `layer-npm-publish.yml` |
| Allowed action | `npm publish` |
| Optional Environment | **Leave blank** |

The optional npmjs **Environment field MUST be blank**.
npm permits only one trusted publisher configuration per package, while this one
workflow publishes
from two GitHub environments: canaries use `npm-publish` and stable releases use
`npm-stable-publish`. Entering either environment in npmjs prevents the other
lane from authenticating. The workflow filename and repository remain part of
the OIDC identity even when the optional environment claim is omitted.

Do not add `NODE_AUTH_TOKEN` or another long-lived npm credential. Current npm
OIDC authenticates `npm publish`, but not `npm dist-tag`; the workflow therefore
publishes directly to the requested tag and verifies the result between every
package. See the [official npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
for the current provider fields, allowed actions, and command limitations.

## GitHub environment controls

The two GitHub environments have different purposes:

- `npm-publish` is the automatic canary lane on pushes to `next`.
- `npm-stable-publish` is the manual stable lane. It supplies the required
  reviewer gate and a custom deployment branch policy limited to `next`.

The stable environment's required reviewer and branch policy are GitHub controls;
they do not belong in npmjs's optional Environment field. A stable dispatch must
start from `refs/heads/next`, and its `layer-v<semver>` tag must resolve to the
exact `release_sha` input before the environment-protected publish step runs.

## Verify the configuration

Before the first live run, open each package's npmjs **Settings → Trusted
Publisher** page and compare every field with the table above. In particular,
confirm that the Environment input is empty and `npm publish` is allowed.

After an authorized canary run, verify the rolling tag:

```bash
npm view @jinn-network/plugin dist-tags.canary --json
npm view @jinn-network/core dist-tags.canary --json
npm view @jinn-network/jinn-layer dist-tags.canary --json
```

After a stable run for version `VERSION`, verify both the immutable tarball SRI
and the final tag for every package:

```bash
npm view @jinn-network/plugin@"$VERSION" dist.integrity --json
npm view @jinn-network/plugin dist-tags.latest --json
npm view @jinn-network/core@"$VERSION" dist.integrity --json
npm view @jinn-network/core dist-tags.latest --json
npm view @jinn-network/jinn-layer@"$VERSION" dist.integrity --json
npm view @jinn-network/jinn-layer dist-tags.latest --json
```

Each `dist-tags.latest` value must equal `VERSION`. Compare each
`dist.integrity` value with the corresponding local SRI printed by the stable
publisher. The workflow performs these checks after each publication and again
across the complete package set.

## Failure symptoms and recovery

- **`E404`, `ENEEDAUTH`, or HTTP `403` during `npm publish`:** first check the
  package's npmjs trusted publisher fields. Common causes are a non-blank
  Environment field, the wrong repository/workflow filename, or `npm publish`
  not being selected as an allowed action. Also confirm the job still has
  `id-token: write` and runs on a GitHub-hosted runner.
- **Stable job is waiting before any publish step:** approve the deployment in
  the GitHub `npm-stable-publish` environment as the required reviewer. Check
  that the dispatch ref is `next`; do not weaken the branch policy.
- **Stable job is skipped:** dispatch the workflow from `refs/heads/next`. A run
  from another branch is intentionally rejected before environment approval.
- **`preflight latest tag mismatch`:** an integrity-identical immutable version
  already exists, but `latest` is missing or selects another version. The OIDC
  lane cannot repair it with `npm dist-tag` or republish the version, so the
  script refuses every registry mutation. A logged-in npm maintainer must
  reconcile the tag interactively, record the evidence, then rerun the same
  tag/SHA inputs.
- **`post-publish latest tag mismatch` or integrity mismatch:** stop the release
  train. Do not advance to another version. Inspect the two `npm view` values
  above; after registry state is correct, rerun the exact same tag/SHA. Matching
  immutable versions are skipped, and only missing downstream packages resume.
- **Final verification fails after a partial run:** the package set may be
  temporarily split across `latest`. Keep the stable environment closed to a
  new version, repair any tag requiring interactive npm authority, and rerun the
  same version until all six verification commands agree.

Never delete or overwrite an immutable version to recover a run. Any SRI
mismatch is a fail-closed supply-chain event and requires investigation before
another publication attempt.
