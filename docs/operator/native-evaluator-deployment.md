# Native evaluator deployment module (prediction profile)

How an operator running the native evaluator role host points `evaluator.deploymentModule`
at a real, digest-pinned production module. Target audience: you are filling in the
`evaluator` block of `native-config.json` (`client/src/daemon/native-product-config.ts:88-93`)
for a `role: "evaluator"` deployment.

## What ships

`client/deployments/evaluator/` holds two committed, digest-pinnable artifacts:

- `prediction-market-deployment.mjs` — the production ES module. It exports
  `evaluationHarnessDeployment` with exactly one registration
  (`registrationId: "prediction-market"`), a real durable evidence writer, and the fixed
  `signerHandle` literal `prediction-market-evaluator-verdict`.
- `prediction-market-evaluation-method.v1.json` — the evaluation-method descriptor. Its
  sha256 (hashed live by the module at import time, not hardcoded) is the
  `evaluationMethod.digest.sha256` the composition layer stamps into every verdict
  statement.

Both are plain committed files, not `tsc` build artifacts — their bytes (and therefore
their digests) are exactly what is in git. You do not need to run `yarn build` to compute
or verify either digest, though the file must of course be present on disk at the path you
give `deploymentModule` (true for a repo checkout, and true for the npm-published package
since `deployments/` ships unconditionally — see `client/package.json`'s `files` array).

## Config wiring

```json
"evaluator": {
  "deploymentModule": "/absolute/path/to/client/deployments/evaluator/prediction-market-deployment.mjs",
  "moduleDigest": "sha256:<see below>",
  "signerHandle": "prediction-market-evaluator-verdict",
  "evaluationMethodDigest": "sha256:<see below>"
}
```

`deploymentModule` must be an absolute path or a `file:` URL
(`client/src/daemon/native-evaluator-composition.ts:164-174`). Resolve the absolute path to
your installed copy:

- **Repo checkout / contributor dev**: `<repo>/client/deployments/evaluator/prediction-market-deployment.mjs`.
- **Published package** (`npm install -g @jinn-network/client`): join the installed
  package root with the same relative path, e.g.
  `node -e "console.log(require.resolve('@jinn-network/client/package.json').replace('package.json', 'deployments/evaluator/prediction-market-deployment.mjs'))"`.

## Computing the two digests

Both digests are `sha256:` + the lowercase hex digest of the exact file bytes
(`documentDigest` in `@jinn-network/task-execution-protocol`, the same helper the
composition layer uses to verify them). A plain `shasum`/`sha256sum` one-liner is
sufficient and is exactly what CI pins against:

```bash
printf 'sha256:%s\n' "$(shasum -a 256 client/deployments/evaluator/prediction-market-deployment.mjs | cut -d' ' -f1)"
printf 'sha256:%s\n' "$(shasum -a 256 client/deployments/evaluator/prediction-market-evaluation-method.v1.json | cut -d' ' -f1)"
```

The same values are available programmatically (and are what
`client/test/native-evaluator/prediction-deployment.test.ts` asserts against) via
`client/src/native-evaluator/deployment-paths.ts`:

```ts
import {
  predictionEvaluatorModuleDigest,
  predictionEvaluatorMethodDigest,
} from './native-evaluator/deployment-paths.js';

const moduleDigest = await predictionEvaluatorModuleDigest();       // -> evaluator.moduleDigest
const evaluationMethodDigest = await predictionEvaluatorMethodDigest(); // -> evaluator.evaluationMethodDigest
```

## Required environment variables

The module reads two environment variables at **import time** (once per process, before
`evaluationHarnessDeployment` is constructed):

| Env var | Required | Purpose |
|---|---|---|
| `JINN_NATIVE_EVALUATOR_AGENT` | yes | The evaluator's own persistent Agent IRI. Must equal `operator.native.agent` in `native-config.json` — the composition layer refuses the deployment otherwise (`native-evaluator-composition.ts:221-223`). |
| `JINN_NATIVE_EVALUATOR_CLAIM_EVIDENCE_DIR` | no | Root directory for the durable claim-evidence filesystem repository. Defaults to `~/.jinn-client/native-evaluator/claim-evidence`. |

## The identity-parameterization design, and why

`evaluatorIdentity.id` (inside the module's registration) must equal the operator's own
Agent IRI, but `moduleDigest` pins the module's exact file bytes — and that identity is
different for every operator. Two mechanisms would satisfy both constraints:

1. **The module reads the identity from configuration external to the file** (an
   environment variable), so the file's bytes — and therefore its digest — never change
   across operators. *(chosen)*
2. **A committed generator emits a personalized module per operator**, with each operator
   computing and pinning their own, distinct `moduleDigest`.

This module uses (1): `JINN_NATIVE_EVALUATOR_AGENT`. Reasoning:

- **One published digest, not N.** Every operator running a given release of this exact
  file has the identical `moduleDigest` — it's a single value the project can publish in
  release notes and every operator can diff their local file against, rather than each
  operator's digest being unverifiable against anyone else's.
- **No generated-file operational surface.** There is nothing to run, gitignore, or
  re-generate on upgrade; the shipped file is the whole artifact.
- **Matches the existing convention for `signerHandle`.** `EvaluatorDeploymentOptions`
  (`packages/task-execution/evaluator-adapters/src/deployment.ts:20-21`) already documents
  `signerHandle` as "deployment-owned, resolved by later host-owned composition" — i.e. a
  value the module declares and the operator's config is expected to match, not a value
  baked into Task material. `signerHandle` here is a fixed literal for the same reason:
  it's a stable handle name, not a secret or a per-operator identity, so it needs no
  parameterization at all.

The composition layer never weakens its checks to accommodate this — `moduleDigest` still
pins exact bytes, `evaluatorIdentity.id` is still cross-checked against
`operator.native.agent` on every construction, and reading `JINN_NATIVE_EVALUATOR_AGENT`
happens entirely outside the digest-pinned file.
