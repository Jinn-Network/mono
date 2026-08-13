# Inspect runtime adapter

Inspect is an optional evaluation runtime for the Benchmark Product. It is not
a dependency of the native runtime and it is not a second product lifecycle.
Both runtimes use the same draft, quote, lock, launch, accounting, Report,
publication, and verification operations. The native runtime remains the
compatibility and regression path.

The supported first slice is deliberately narrow:

- `inspect-ai==0.3.255` under Python 3.11 or newer;
- one real task reference resolving to exactly one task, either
  `path/to/file.py@task_name` in an existing project or a registered task from
  an installed evaluation package;
- at least two Jinn arms, each selecting an Inspect model or agent model
  reference;
- one named scalar scorer and an explicit pass value;
- one Inspect execution per Jinn cell with `epochs=1`; Jinn `replicates` owns
  the repetition axis;
- local native `.eval` logs produced and accepted by Inspect's official
  `read_eval_log` API.

The optional OCI host narrows this further to Python `3.11.9`, Inspect Evals
`0.16.0`, OpenAI SDK `2.53.0`, `linux/amd64`, and one exact `sampleId`.

The adapter is implemented against Inspect's official
[Python/CLI reference](https://inspect.aisi.org.uk/reference/),
[task reference documentation](https://inspect.aisi.org.uk/tasks.html),
[running options](https://inspect.aisi.org.uk/running.html),
[scoring APIs](https://inspect.aisi.org.uk/scoring.html),
[eval-set behavior](https://inspect.aisi.org.uk/eval-sets.html),
[log APIs and viewer](https://inspect.aisi.org.uk/eval-logs.html), and
[extension model](https://inspect.aisi.org.uk/extensions.html). Inspect itself
declares Python 3.10 or newer; this adapter intentionally supports the narrower
Python 3.11+ range. Inspect is MIT-licensed in its
[official source repository](https://github.com/UKGovernmentBEIS/inspect_ai).
The product neither vendors nor redistributes Inspect or selected evaluation
packages. Operators remain responsible for the license and redistribution
terms of tasks, datasets, model outputs, and native logs they select or publish.

Inspect remains responsible for task and dataset loading, solvers or agents,
tools, scoring, sandbox semantics, sample execution, native logs, and Inspect
View. Jinn seals the selected method, creates every expected arm × task ×
repetition cell, supervises attempts, retains exact artifacts, attributes the
score, accounts for non-results, produces the signed Report, and verifies the
portable bundle.

## Installation and selection

Install the optional Python runtime in a dedicated, customer-controlled
environment. The Node packages and lockfiles do not install Python or Inspect.
The supported upstream wheel SHA-256 is
`958e773a8d0cc8873314e3f96d1143cbb4e0b9e4bacc2cbec6b4d5576ceecf2c`.
CI verifies that wheel before installing it.

Create a JSON file such as:

```json
{
  "pythonPath": "/absolute/path/to/venv/bin/python",
  "projectDir": "/absolute/path/to/existing-inspect-project",
  "taskReference": "evals/hermetic.py@hermetic",
  "taskArgs": {},
  "arms": [
    { "armId": "control", "model": "mockllm/model" },
    { "armId": "candidate", "model": "mockllm/model" }
  ],
  "scorer": { "name": "match", "passValue": "C" },
  "runOptions": { "maxSubprocesses": 2 }
}
```

For the optional credential-isolated Luna path, configure the host with a
fresh capped key in an owner-only file outside both the repository and product
workspace. The key is never accepted in selection JSON, CLI arguments, or the
web form:

```bash
chmod 600 /absolute/private/path/openai-api-key
export BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE=/absolute/private/path/openai-api-key
```

Use the sealed provider profile on each arm:

```json
{
  "execution": "oci",
  "dockerPath": "/absolute/path/to/docker",
  "imageDigest": "sha256:<local-image-id>",
  "projectDir": "/absolute/path/to/project-or-empty-directory",
  "datasetCacheDir": "/absolute/path/to/prefetched-cache",
  "taskReference": "inspect_evals/arc_easy",
  "arms": [
    {
      "armId": "luna-none",
      "model": "jinn-openai/gpt-5.6-luna",
      "provider": {
        "surface": "openai-responses",
        "upstreamModel": "gpt-5.6-luna",
        "reasoningEffort": "none",
        "maxOutputTokens": 128,
        "store": false,
        "background": false,
        "stream": false,
        "serviceTier": "default",
        "tools": [],
        "fallbackModels": [],
        "retries": 0,
        "persistedConversation": false,
        "metadata": null,
        "promptCacheIdentifier": null
      }
    },
    {
      "armId": "luna-low",
      "model": "jinn-openai/gpt-5.6-luna",
      "provider": {
        "surface": "openai-responses",
        "upstreamModel": "gpt-5.6-luna",
        "reasoningEffort": "low",
        "maxOutputTokens": 128,
        "store": false,
        "background": false,
        "stream": false,
        "serviceTier": "default",
        "tools": [],
        "fallbackModels": [],
        "retries": 0,
        "persistedConversation": false,
        "metadata": null,
        "promptCacheIdentifier": null
      }
    }
  ],
  "scorer": { "name": "choice", "passValue": "C" },
  "runOptions": {
    "sampleId": "Mercury_417466",
    "maxSamples": 1,
    "retryOnError": 0
  }
}
```

`sampleId` is the exact selected row. `maxSamples` is only Inspect's
sample-concurrency limit; it never selects or truncates the dataset. Quote
preflight validates Docker, the digest-pinned image, dataset bytes, runtime
identity, broker health, and credential-file metadata without making a model
request. Preview and official launch make real calls.

Then select it on a mutable draft:

```bash
benchmark-product runtime inspect select \
  --workspace /absolute/path/to/workspace \
  --principal sponsor-1 \
  --draft my-draft \
  --file /absolute/path/to/inspect-selection.json
```

The web product exposes the same `selectInspectEvaluation` operation as a raw
selection form. It does not provide a task, solver, scorer, or sandbox editor.

To run task code in the product-owned OCI boundary, first build the local
worker image for the supported platform, prefetch any selected dataset into a
dedicated cache, and select the immutable local image ID rather than its tag:

```bash
docker build --platform linux/amd64 \
  --tag jinn-inspect-worker:0.3.255-local \
  packages/benchmark-product/core/src/runtime/inspect
docker image inspect --format '{{.Id}}' jinn-inspect-worker:0.3.255-local
```

```json
{
  "execution": "oci",
  "dockerPath": "/absolute/path/to/docker",
  "imageDigest": "sha256:<local-image-id>",
  "projectDir": "/absolute/path/to/existing-inspect-project",
  "datasetCacheDir": "/absolute/path/to/prefetched-read-only-cache",
  "taskReference": "evals/hermetic.py@hermetic",
  "arms": [
    { "armId": "control", "model": "mockllm/model" },
    { "armId": "candidate", "model": "mockllm/model" }
  ],
  "scorer": { "name": "match", "passValue": "C" },
  "runOptions": { "sampleId": "alpha", "maxSamples": 1 }
}
```

Selection binds the image ID, platform, exact Python and package versions,
worker source, Docker executable and engine/API versions, project/task/scorer
identity, selected-sample digest, complete dataset-cache tree digest, mounts,
network policy, and resource limits. Later probes use `--pull=never`; missing
or changed inputs fail as method drift rather than falling back to host Python.

Selection calls Inspect's public programmatic `eval` interface. The local path
can resolve metadata without running samples; the OCI path runs its locked
exact sample with Inspect's mock provider so it can bind the ordered sample
bytes without external model access. It then seals a public-safe manifest. The
manifest binds the adapter and worker, exact Inspect version,
installed Inspect distribution content, Python executable and installed-package
environment, task reference and arguments, source file, local project tree or
installed distribution, dataset metadata, arm model configuration, scorer, and
material run options. The supported wheel digest is a distribution reference;
the separately sealed installed-distribution digest identifies the bytes that
actually execute. The environment fingerprint hashes installed distribution
files rather than trusting version or `RECORD` metadata alone. Launch re-probes
the same selection before dispatch, and the
worker revalidates the runtime, worker, resolved task/scorer metadata, dataset,
and source/environment fingerprints after Inspect returns but before artifacts
are accepted. Drift therefore fails the attempt instead of silently entering a
Matrix or Report.

Some installed registry tasks, including `inspect_evals/arc_easy`, expose no
individual `task_file` through Inspect's public EvalSpec or registry metadata.
For those tasks the source identity is the complete installed distribution
tree and digest; the adapter does not invent a module filename.

The local project-tree digest excludes only runtime-generated or environment
directories: `.git`, `.inspect_ai`, `.mypy_cache`, `.pytest_cache`, `.venv`,
`__pycache__`, and `.pyc` files. Code or data intentionally loaded from an
excluded directory is unsupported in this slice. Installed task packages must
expose resolvable distribution metadata.

## Supported run semantics

The material option allowlist is `sampleId`, `maxSamples`, `maxSubprocesses`,
`maxSandboxes`, `retryOnError`, `failOnError`, `messageLimit`, `tokenLimit`,
and `timeLimit`. `sampleId` selects one exact dataset row. `maxSamples` is
Inspect's concurrent-sample limit and never selects or truncates the dataset.
Inspect owns the behavior of those options. Task-defined and
run-option sandboxes are refused in this slice because a provider name or
mutable image tag is not strong enough for the lock guarantee. Custom sandbox
providers require a follow-up that binds the provider, complete configuration,
and immutable image/environment identity; the adapter does not silently
coerce them to local execution.

Inspect epochs are intentionally not configurable. One Jinn repetition is one
expected cell and invokes Inspect with one epoch. This prevents one sample from
being counted once as an Inspect epoch and again as a Jinn repetition.
Multiple scorers, score reducers, deferred rescoring, eval-set orchestration,
resume/reuse, and ingestion of already-completed logs are explicit follow-up
capabilities. The first slice refuses or leaves them unconfigured rather than
coercing them into one score.

The worker invokes Inspect once for a cell. A `success` log is scored only when
the observed sample count equals Inspect's expected count, no sample has an
error, every sample has the selected scalar score, and the log is not
invalidated. The configured verdict is pass only when every selected score
equals `passValue`; otherwise it is fail.

| Inspect/runtime condition | Jinn accounting |
|---|---|
| successful, complete, scalar scores present | delivered cell plus an attributable pass/fail verdict |
| error/cancelled/invalidated log, incomplete samples, sample errors, or absent/non-scalar selected score | delivered but `could-not-grade`; never omitted from the Matrix |
| worker/process failure or missing/invalid native log | failed execution attempt; the expected cell remains present |
| supervisor cancellation before a usable log | cancelled attempt; the expected cell remains present |
| Inspect internal `retryOnError` | one Jinn attempt with one final native log; no extra Jinn cell |
| a later Jinn retry or resume | a new attempt for the same expected cell; journal identity prevents double counting |

Inspect's same-run scorer is represented by
`urn:jinn:benchmark-product:inspect-runtime:same-execution-scorer`. It is an
attributable evaluation claim, but it is not called independent and cannot
satisfy a distinct-evaluator quorum. A future external evaluator can append a
separate Result Evaluation over the retained execution/delivery evidence; it
must not overwrite the Inspect-native score or pretend it was produced by the
same execution.

## Execution and credential boundary

Task imports, tools, solvers, model providers, sandboxes, and scorers run in a
supervised runtime host, never in the Next.js request process. The original
local-Python host remains available for trusted, credential-free compatibility
runs. The OCI host runs task code with a read-only root, no Linux capabilities,
no new privileges, no direct external network, bounded CPU/memory/process/scratch resources,
an ephemeral home, and only the selected project/cache plus current attempt
directories mounted. It never mounts the host home, keyring, repository root,
Docker socket, or credential files.

The worker receives a minimal environment and no ambient credential variables.
Hugging Face's processed dataset bytes remain on the digest-locked read-only
cache mount. Because the `datasets` library creates lock files even for cached
offline reads, the worker builds only a temporary symlink index and lock root
inside its bounded scratch filesystem; writes cannot reach the mounted dataset
bytes.
For `jinn-openai/gpt-5.6-luna`, the runtime host creates one trusted broker
sidecar and one private internal network per execution attempt. The worker sees
only a random, per-attempt capability. The API key is copied through the
trusted host process into a separate ephemeral Docker volume, mounted read-only
only in the broker. Its bytes and host path do not appear in worker mounts,
Docker command arguments, product state, sealed records, or native logs. The
broker has the only external network path and its trusted implementation can
issue only the locked synchronous request to `api.openai.com`; arbitrary task
code cannot choose an endpoint. Every attempt removes its worker, broker,
private network, capability volume, and credential volume, including on
cancellation.

The broker accepts only ordered developer/user text and the sealed Luna
configuration. It refuses tools, images, audio, assistant/tool history,
structured output, multiple choices, background or streaming responses,
fallbacks, persisted conversation, metadata, and prompt-cache identifiers. It
allows one concurrent call and one total call per cell, caps output at 128
tokens and input at 32 KiB, times out at 120 seconds, and disables both OpenAI
SDK and Inspect retries. A Jinn resume is a distinct execution attempt.

The broker uses Inspect's public `ModelAPI` extension and returns Inspect's
public `(ModelOutput, ModelCall)` form. The genuine `.eval` transcript therefore
contains the upstream request and sanitized Responses body, never a synthesized
log. Local-Python process separation is not a hostile-code sandbox; it remains
a trusted compatibility path, and provider-backed arms are refused there.

ChatGPT/Codex subscription authentication remains unsupported. Inspect SWE's
Codex bridge does not reuse a local ChatGPT subscription, and mounting Codex
state into task code is outside this security contract.

Luna currently exposes only the mutable alias `gpt-5.6-luna`, not a dated
snapshot. Jinn locks that identifier and rejects a different returned model,
but cannot prove that OpenAI did not update weights behind an unchanged alias.
See the official [Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model),
and [synchronous cancellation/background behavior](https://developers.openai.com/api/docs/guides/background).

## Native logs, publication, and Inspect View

The complete `.eval` file is retained by exact SHA-256 as a private source
artifact and bound to its Jinn Task Delivery, summary, verdict, Matrix, and
Report closure. The bounded `inspect-summary.json` is a Jinn projection; it is
not an EvalLog.

Inspect-backed publication is refused unless the caller explicitly supplies
`--include-native-artifacts` or checks the equivalent web approval. Approved
bundles copy each exact log to `native/inspect/<sha256>.eval`. After copying a
bundle and deleting the product workspace, the normal bundle verifier checks
the log digest and evidence binding. With the pinned Inspect environment, the
native directory can be opened directly:

```bash
inspect view --log-dir /absolute/path/to/bundle/native/inspect
```

Native logs can contain prompts, responses, tool calls, transcripts, model
metadata, and content supplied by the evaluation. Jinn does not promise to
scrub that content. Keep logs private or inspect them before giving explicit
publication approval.

## Guarantees and limitations

Inspect guarantees the behavior of its pinned task/run/scoring/log APIs and
native viewer. Jinn guarantees locked selection identity, expected-cell
accounting, attempt and evaluator attribution, evidence integrity, Report
recomputation, portable closure verification, and explicit trust disclosures.
A self-run campaign shows that the identified local operator produced the
identified evidence. It does not prove that the operator is independent, that
the host was uncompromised, or that distinct keys belong to distinct
real-world parties. Stronger claims require a genuinely separate evaluator,
attester, or future market venue.

The adapter boundary is intentionally runtime-neutral: the lifecycle stores an
adapter id plus a sealed selection digest and constructs a venue through the
shared runtime registry. A later framework can implement task selection,
execution, and native-artifact handling behind that seam without adding a
second Benchmark Product lifecycle.

Isolation accounting is deliberately narrower than operational containment.
Native and local-Python Runs admit only the `unrestricted` policy and retain
their documented singleton-inventory result. An OCI Inspect Run admits both
`unrestricted` and `oci-container`, so its Matrix isolation axis is
`unverifiable`: admission proves that both policies are available, not which
one produced a particular cell or how strong that containment was. The Report,
claim package, workspace verifier, and detached-bundle verifier all derive the
same disclosure from the sealed Run. Stronger isolation claims require
positive per-cell evidence and are outside this slice.
