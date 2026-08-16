# Task creator environment publication

`task-creator:environment-publish` constructs and publishes one evaluated
environment from a strict recipe JSON document. It is deliberately a manual
operator action: the default mode is validation-only, and it does not build,
scan, contact GitHub/IPFS, invoke the signer, or push an image.

## Preconditions

- Docker Buildx, Trivy `0.66.0`, and Syft `1.31.0` are installed locally.
- Docker's external credential helper is already configured for the target
  registry. Do not place registry credentials in the config file.
- The source repository is public and has rights evidence accepted by the
  publication policy.
- An absolute-path signer executable is available to the operator. The
  executable owns its signing material outside this CLI.

## Strict config

Create a JSON file containing only the following top-level fields:

```json
{
  "recipe": {
    "schemaVersion": "jinn.environment-build-recipe.v1",
    "recipeId": "jinn-mono.v1",
    "source": {
      "repo": "Jinn-Network/mono",
      "repoUrl": "https://github.com/Jinn-Network/mono.git",
      "baseCommit": "<40-lowercase-hex-commit>"
    },
    "platform": "linux/amd64",
    "baseImage": { "reference": "<digest-qualified-image>", "digest": "<sha256-digest>" },
    "workspace": "/testbed",
    "installCommands": ["<structured CommandSpec entries>"],
    "smokeCommands": ["<structured CommandSpec entries>"],
    "testCommands": ["<structured CommandSpec entries>"],
    "parser": { "id": "vitest-json.v1", "version": "v1", "digest": "<sha256-digest>", "bundleId": "<bundle>" },
    "inputRights": ["<structured InputRightsRef entries>"],
    "timeoutSeconds": 300,
    "environment": { "CI": "1" }
  },
  "ipfsRegistryUrl": "https://registry.autonolas.tech",
  "operatorSafe": "0x<40-hex-address>",
  "signer": { "command": "/absolute/path/to/environment-attestor" },
  "imageRepository": "ghcr.io/jinn-network/task-environment"
}
```

The `recipe` value is the full `EnvironmentBuildRecipeV1` object, not the
illustrative placeholder strings above. Reuse a resolved preset recipe and
replace only its already-validated source commit and rights bindings.

The config parser rejects unknown fields and secret-bearing fields, including
private keys, tokens, Docker config, registry credentials, passwords, and
access keys. The IPFS URL must be credential-free HTTPS. `imageRepository` is
optional and defaults to `ghcr.io/jinn-network/task-environment`.

## Preflight

From `operator/`:

```sh
yarn task-creator:environment-publish --config ./environment.json
```

This prints a `preflight` result after parsing the recipe, endpoints, Safe, and
signer command. It makes no external side effect.

## Execute

Only after reviewing the preflight, opt in explicitly:

```sh
JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE=1 \
  yarn task-creator:environment-publish \
    --config ./environment.json \
    --output "$HOME/secure/jinn-signed-environment.json"
```

The executor builds from a Dockerfile-only context, scans locally, generates
the SBOM, pushes through Docker's preconfigured credential helper, then uploads
artifacts only after all controller gates. The output includes the published
image reference, canonical environment hash, and `environmentCid`. In execute
mode, `--output` atomically writes the exact canonical signed environment
artifact used for later receipt generation. Record all three values; the output
file and CID must describe the same signed artifact.

## Handoff to the Jinn differential proof

For the reviewed Jinn base
`ae8093a8848e70e581f46d66dcdb56789c0808a3`, publication is only complete when
the returned digest-qualified `imageReference`, `environmentCid`, and local
signed-environment output have been recorded. Before generating a receipt, use
the operator's normal Docker credential helper to pull and inspect that exact
reference:

```sh
docker pull --platform linux/amd64 '<imageReference returned by publication>'
docker image inspect '<same digest-qualified imageReference>' --format '{{json .}}'
```

The inspect result must report `Os: linux`, `Architecture: amd64`, an immutable
`Id`, and a `RepoDigests` entry exactly equal to the returned digest-qualified
reference. Do not substitute a tag. The differential command repeats this
pull/inspect gate using ambient Docker authentication before its runner starts;
the eight evaluator executions themselves use `--pull=never`.

Continue with the exact receipt/CID/SHA/offline-verification sequence in the
public-repository proof runbook. Never use the builder's isolated Docker config
for this pull: it deliberately excludes registry credentials.

## External signer protocol

The signer command must be an absolute executable path. It receives exactly
one positional argument: `sha256:<environment-hash>`. Its environment contains
only `PATH`; it receives no private key, registry credential, Docker config,
or arbitrary CLI configuration.

It must write one JSON `Eip191EnvironmentAttestationV1` object to stdout. Its
signature must be EIP-191 over:

```text
jinn.task-environment.v1:sha256:<environment-hash>
```

The CLI parses the response, checks the requested hash and configured Safe,
and verifies the recovered signer before continuing.
