# Runtime-hosted Inspect task sandbox proof — 2026-08-13

This is the sanitized, credential-free proof for the Benchmark Product's
versioned `jinn-oci` Inspect sandbox extension. It proves the narrow task-level
Docker-sandbox slice without adding a Docker socket or provider credential to
the Inspect worker.

## Result

- **Unmodified Inspect Evals task: PASS.** `inspect_evals/humaneval` version 2,
  selected through its registered task reference with no task arguments,
  retained its default `generate()` solver, `verify()` scorer, and declared
  `sandbox="docker"`.
- **Runtime-hosted sandbox: PASS.** Inspect's public sandbox extension invoked
  the sealed `jinn-oci` provider. The trusted product host created the nested
  container; the worker and task received neither a Docker socket nor a Docker
  command surface.
- **Complete lifecycle: PASS.** Selection, preview, quote, lock, official
  launch, collection, Report production, workspace verification, publication,
  source-workspace deletion, and detached verification completed with two
  expected and two judged cells.
- **Native compatibility: PASS.** Inspect `0.3.255`'s public
  `read_eval_log()` accepted both exact `.eval` files. Each contained one
  `HumanEval/0` sample, the native `verify` score, and the effective
  `jinn-oci` sandbox. `inspect view bundle` generated an offline viewer with
  networking disabled.
- **Isolation and cleanup probes: PASS.** The hermetic malicious-task fixture
  could use Inspect `exec`, `read_file`, and `write_file`, but could not see the
  host sentinel, credential locations, ambient OpenAI variables, Docker
  socket, or provider network. Cancellation reaped a live worker and nested
  sandbox. The fake Responses proof also passed with the broker and sandbox
  enabled together.

The HumanEval mock model deliberately returned invalid code. Both unchanged
native scorers returned incorrect, which Jinn recorded as two attributable
fail verdicts. This is an execution/isolation proof, not a model-quality claim.

## Pinned method

- Canonical base: `807568b4aea313280b932e181736766a24a3300d`
- Implementation branch: `codex/inspect-task-sandbox`
- Worker and sandbox image ID:
  `sha256:147ee4c385d0c0459c0971d520b395f9066786807591d56e57b79e150f19946d`
- Platform: `linux/amd64`
- Python: `3.11.9`
- Inspect AI: `0.3.255`
- Inspect Evals: `0.16.0`
- OpenAI Python SDK: `2.53.0`
- Docker client/server: `28.5.1`; API: `1.51`
- Sandbox extension package: `jinn-inspect-sandbox==0.1.0`
- Sandbox protocol: `jinn.network/inspect-sandbox-host/1`
- Sandbox provider source SHA-256:
  `ea77640c1005fccca38b7533e7e00566556dcd2097af28d34f4ad0374db6f937`
- Trusted controller source SHA-256:
  `db8582f854d1dc5cfe502c98ab5d88ad70b2859e7f9f8213fb54da13481956e2`
- Fixed policy SHA-256:
  `8671d19c70cb9942f5a4bd2350384a53bc8258853c33b638ac19db65de6d4c12`

The policy runs one environment as `65532:65532`, with a read-only root,
capabilities dropped, no new privileges, no network, no host mounts, one
256 MiB scratch filesystem, one CPU, 512 MiB memory, 32 processes, at most 64
operations, a 30-second command limit, and a 120-second environment limit.
The worker itself remained in the existing separately bounded OCI policy.

## HumanEval selection and evidence

The dataset was prefetched without a model credential from
`openai/openai_humaneval` at revision
`7dce6050a7d6d172f3cc5c32aa97f52fa1a2e544`. Hugging Face's link-based cache
was materialized into an ordinary-file-only tree before selection. The sealed
cache digest was
`8e61c85311243c25dd2d886cd12669c3287c5c35de564c0f8519c86714a0ada1`.
The exact sample was `HumanEval/0`; its ordered sample digest was
`4b49142dd49230245b2d9711f4a4fa08f1f99863def166313db296a203d34117`.

The selected task had these two separately recorded identities:

- declared sandbox: `{ "type": "docker", "config": null }`;
- effective sandbox: `jinn-oci` with the exact image, platform, and policy
  digest above.

The main evidence identities were:

- selection manifest:
  `4edb9f1f3fdb93f90031c75163e928e2eedc5164bc04afd3fc6f9487bbde7c60`
- Benchmark:
  `86c678a82fdff63287adbefe5fe2ed12fed4e346c28ae18f85dc829de952117f`
- Run: `80c72f4f1c98223bd06e5e6dc20c81e3ab5ece1dc1da3d6e309305d4ccaba056`
- Matrix:
  `b3b20e2165c0486cc8d0a38c7a20a6f044c0da0d6acb931047205e424d78509d`
- Report:
  `3199ed51b9ac8f0d1aa8652cb5125e4d6e37c3d8150ff138c2a1daa4077a7015`
- Report envelope:
  `90f2649384d7aeddbe2038983aef06e858b3a16d1ba9ecdcca6cf025a03969de`
- bundle manifest:
  `8a5ea895d3203f852951dd8b6d89114be0af20508445baa5e244fba281a3f5a5`
- native logs:
  `bc4b5f5c586c4042fb9c0b764dc20034cfe7b6a8ba66f39967480425b06ba7d0`
  and
  `e8088f77ef43ba10363f752b419bef5d2f9e579999a27d5bb25ef821c4a27392`

The Matrix disclosed isolation as `unverifiable` for both cells. Operational
containment and native sandbox events do not become positive Tier 1–3
isolation attestations merely because the product controlled the containers.
The evaluator remained
`urn:jinn:benchmark-product:inspect-runtime:same-execution-scorer`, never an
independent evaluator.

## Verification surfaces

Ordinary CI covers the versioned protocol and controller budgets with fake
processes, the real OCI extension with the hermetic task, cancellation and
orphan cleanup, broker composition, official native-log reading, Inspect View,
the two-arm product lifecycle, source-workspace deletion, and detached bundle
verification. The HumanEval test is opt-in because it requires separately
prefetched pinned dataset bytes; after prefetch, its worker, task sandbox,
native-log checks, viewer, and verifier all run without network access.

No credential or provider request was used. The generated viewer, downloaded
and materialized caches, detached bundle, temporary workspaces, sentinels, and
transient containers were retained only long enough to record these sanitized
observations and were then removed. None is a repository artifact.

## Limits and deferrals

This slice accepts only a task-level default Docker sandbox with no config and
one environment. It refuses per-sample sandbox overrides, `Sample.files`,
`Sample.setup`, custom Docker/compose configuration, arbitrary providers,
multiple environments, direct task network, and worker-chosen images or
policy. Coding agents, richer tools, egress mediation, multiple sandbox
providers, remote workers, and positive per-cell isolation evidence remain
separate work.
