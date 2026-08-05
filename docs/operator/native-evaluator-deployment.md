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

A third file lives beside them but is **not committed**:
`prediction-market-deployment.local.json`, the per-operator identity sidecar — see
[The identity sidecar](#the-identity-sidecar-and-why-not-an-env-var) below.

Both committed artifacts are plain files, not `tsc` build artifacts — their bytes (and
therefore their digests) are exactly what is in git. You do not need to run `yarn build`
to compute or verify either digest, though the file must of course be present on disk at
the path you give `deploymentModule` (true for a repo checkout, and true for the
npm-published package since `deployments/` ships unconditionally — see
`client/package.json`'s `files` array).

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

**The sidecar file is deliberately not included in `moduleDigest`.** `moduleDigest` pins
this module's *logic*, which is identical for every operator; the sidecar carries only
per-operator *parameters* (identity, evidence root) — the same relationship
`native-config.json` itself already has to the rest of the trusted deployment (config
isn't digest-pinned either). Identity correctness doesn't depend on hashing the sidecar:
see [The identity sidecar](#the-identity-sidecar-and-why-not-an-env-var).

## The identity sidecar, and why not an env var

This module is imported **twice**: once by the daemon (parent) process building the
evaluator composition, and once more by the evaluation-harness **child process** the
daemon spawns for every attempt
(`packages/task-execution/evaluation-harness/src/runtime.ts`'s
`deploymentFromEnvironment()`, invoked from the compiled `dist/bin.js` the launcher
spawns). The child's environment is **reconstructed from scratch**, not inherited from
the daemon's shell:

- `packages/task-execution/evaluation-harness/src/launcher.ts`'s `launchPlan` sets a
  fixed, small set of `JINN_ATTEMPT_*` keys.
- `packages/task-execution/backend-local/workspace/src/dir-provisioner.ts`'s
  `executionEnv()` is an explicit ~20-name allowlist with no slot for an arbitrary
  operator variable.
- `packages/task-execution/backend-local/supervisor/src/shim-script.ts` spawns the
  harness with full env replacement, not a merge with the parent's `process.env`.

**An environment variable set for the daemon therefore never reaches the spawned
harness that actually produces a verdict.** (An earlier revision of this module used
`JINN_NATIVE_EVALUATOR_AGENT` for exactly this reason and was wrong — the daemon booted
fine, but every spawned evaluation attempt failed to import the module, invisibly: the
harness maps that failure to `infrastructure`-blamed `evaluation-operational-failure`
with nothing on stderr, by design.)

Instead, the module reads its per-operator identity from a **sidecar file next to
itself on disk**, resolved via `import.meta.url`:
`prediction-market-deployment.local.json`. A file on disk is visible identically to
both processes: the spawned child imports the *exact same absolute path* as the parent
(the launcher forwards the parent's resolved specifier unchanged), and dynamic
`import()` reads are not sandboxed to the spawned attempt's own workspace directory.

```json
{
  "agent": "<the evaluator's own persistent Agent IRI — must equal operator.native.agent>",
  "claimEvidenceDir": "<optional absolute path; defaults to ~/.jinn-client/native-evaluator/claim-evidence>"
}
```

Create it with `writePredictionEvaluatorSidecar` (`client/src/native-evaluator/deployment-paths.ts`)
or by hand at
`client/deployments/evaluator/prediction-market-deployment.local.json` (published-package
path: alongside the resolved `deploymentModule` path above). It is **not committed** —
see `client/.gitignore`.

Two independent guards mean a wrong or tampered sidecar cannot produce a trusted
verdict, even though it isn't digest-pinned:

1. **Boot-time**: the parent composition (`native-evaluator-composition.ts`) cross-checks
   this module's declared `evaluatorIdentity.id` against the trusted
   `operator.native.agent` config value on every construction. A sidecar naming the
   wrong agent means the daemon refuses to start the evaluator role at all — loud, and
   before a single attempt is spawned.
2. **Harvest-time**: even a sidecar that differs *only* for the spawned child (e.g.
   tampered with independently of the parent) cannot forge a trusted verdict. The
   verdict statement's `evaluator.id` comes from this same registration, and the
   parent's harvest step separately requires `predicate.evaluator.id === roles.agent`
   before it will seal and publish anything
   (`native-evaluator-composition.ts`'s `stateBackedProvisioner` harvest contract).

The composition layer's checks are otherwise untouched by this design — `moduleDigest`
still pins exact module-logic bytes; only where the per-operator *parameter* lives
changed, from (wrong) process env to a sidecar file both processes read identically.

**The sidecar is read once, at import.** Editing it does not take effect for an
already-running daemon process, nor for an evaluation attempt already spawned; both
pick up an edit only on their own next process start / next spawn.

## Alternatives considered

Two other mechanisms would also satisfy "one committed file, per-operator identity":

- **A committed generator emits a personalized module per operator**, each operator
  computing and pinning their own, distinct `moduleDigest`. Rejected: every operator
  running a shared release would have a *different* digest, unverifiable against each
  other, and there would be a generated-file operational surface (run it, don't
  gitignore the wrong thing, regenerate on upgrade) this design avoids entirely.
- **Widen the spawned child's env allowlist** to forward an operator-chosen variable.
  Rejected without even prototyping it: that allowlist is a security boundary (it is
  also what prevents a Task from steering which secrets a harness process can see), and
  widening it for this deployment's convenience is a broader change than one deployment
  module should make.
