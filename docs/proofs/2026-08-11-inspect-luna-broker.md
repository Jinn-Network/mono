# Credential-isolated Inspect Luna verification — 2026-08-11

This is the sanitized verification record for the Benchmark Product's
credential-isolated `jinn-openai/gpt-5.6-luna` runtime.

## Erratum — 2026-08-12

The real provider calls, exact returned model identities, Inspect-native log
observations, and technical end-to-end lifecycle result below remain valid.
The pre-fix Matrix, Report, Report envelope, and public-bundle identities are
superseded as publication evidence: the venue advertised only the
`unrestricted` isolation policy even though the sealed OCI Run admitted both
unrestricted and OCI-container execution. That singleton inventory produced
an unearned isolation `match` which the venue could not prove per cell.

The corrected implementation derives a multi-policy inventory from the sealed
Run and reports OCI isolation as `unverifiable`; it does not manufacture new
per-cell isolation evidence. The credential-free correction proof is recorded
in [Truthful Inspect OCI isolation accounting](./2026-08-12-inspect-isolation-accounting.md).

The reused capped test key was an explicitly accepted exception for this
technical proof. Because that key had previously appeared in chat, this record
is not evidence of never-exposed credential handling; no fresh-key rerun is
claimed or required for the correction. The detached live bundle previously
listed at `/private/tmp/jinn-inspect-luna-approved-bundle-final-20260811` is no
longer present. Its recorded digests remain historical observations, but the
bundle cannot now be independently reverified from the repository.

## Result

- **Credential-free production-shaped lifecycle: PASS.** The real Inspect
  worker and broker ran as separate OCI containers, an unmodified Inspect
  `generate()` solver called the public `jinn-openai` `ModelAPI` extension,
  genuine logs survived publication, and the copied bundle verified after the
  source workspace was deleted.
- **Live Luna technical lifecycle: PASS.** The unmodified
  `inspect_evals/arc_easy` task ran through selection, preview, quote, lock,
  official launch, collection, reporting, publication, and detached
  verification. Both official provider calls resolved exactly to
  `gpt-5.6-luna`; no fallback or implicit retry occurred.
- **Fresh-credential handling exception: ACCEPTED FOR THIS TECHNICAL PROOF.** At
  the operator's explicit direction, the live run reused a capped test key that
  had previously appeared in chat. The product received it only through the
  required owner-only file, and that file was deleted immediately after the
  official launch, but this run cannot prove that the credential was never
  exposed outside the runtime host. No fresh-key rerun is part of this proof;
  the product/runtime behavior itself is proven subject to this limitation.

The live result supersedes the earlier
[direct Luna smoke](./2026-08-10-inspect-runtime/luna-smoke.md), which did not
exercise the broker or complete Benchmark Product lifecycle.

## Pinned implementation and method

- Base Inspect adapter commit: `4ce6fecbd`
- OCI-host refactor commit: `94347983b`
- Broker feature commit before this verification amendment: `6cd10bb27`
- Worker image ID:
  `sha256:621da2991c09b2088bad2e9e00671ca48819c4a6e008d702234fb4f172bc3a64`
- Platform: `linux/amd64`
- Python: `3.11.9`
- Inspect AI: `0.3.255`
- Inspect Evals: `0.16.0`
- OpenAI Python SDK: `2.53.0`
- Docker client/server: `28.5.1`; API: `1.51`
- Worker source SHA-256:
  `beececb438e1d820634e554f56745a64446eb29875914f3c069d762c2c3350c1`
- Broker source SHA-256:
  `74d5aad7c442b2878a5551ae22680a13b2ee2a0f533bcb6288c99d32e49111f1`
- Inspect model-provider source SHA-256:
  `5899c2f3315c28574422addbc2676522ff45eca82b6af959aa48db6877841a2e`
- OCI runtime-host source SHA-256:
  `567e1958e255bf4193f076f7150cfa99e7192180c170d1ec3575089d3a928682`

The live selection sealed:

- task `inspect_evals/arc_easy`, resolved task version `2`;
- unchanged `multiple_choice()` solver and `choice()` scorer;
- dataset `allenai/ai2_arc`, prefetched at revision
  `210d026faf9955653af8916fad021475a3f00453`;
- selected sample `Mercury_417466`;
- ordered selected-sample digest
  `b5af9ee371839d7f4a83726f419953b6955ce9ca68a5424466e47ebe78108e85`;
- read-only processed dataset-cache digest
  `4ec3565c81442e2b1238e0bc22b905e280af9e9455cce2532c04a2699728d1cc`;
- installed Inspect Evals distribution digest
  `a456b272ba279be7b85a4d6b0b0cdcd2d8189fc013d2b1d7643d5c159feabdf1`;
- `luna-none` with reasoning effort `none` and `luna-low` with effort
  `low`;
- exact provider surface `openai-responses`, 128 output-token maximum,
  `store:false`, `background:false`, `stream:false`, zero retries, no tools,
  and no fallback models; and
- the complete worker/broker resource, mount, network, and source policy.

The selection manifest SHA-256 is
`c354d282cabe8977a17ed771e3cc2bf38db49229951ac1057d3e0369a210f70e`.
The Task record binds that exact identity.

## Live observations

Preview ran one selected sample across both arms and delivered two of two
cells in 92.210 seconds. Quote preflight verified the image, dataset, broker,
and credential-file metadata without making a provider request. Lock then
sealed run
`f5587767b8995a625308f097ab863644bff9935bb15ab7e1bbcd0e24cbc997ab`.

The official launch produced exactly two expected cells. Each had one dispatch,
one delivery, one provider call, and one same-execution scorer verdict:

| Arm | Resolved model | Usage | Native log SHA-256 | Result |
| --- | --- | --- | --- | --- |
| `luna-none` | `gpt-5.6-luna` | 109 input, 7 output, 116 total | `4e907f75e455966195bc90755f3bf2163d7dad64f5d21216481a72bc0ecc5a47` | choice `C`, pass |
| `luna-low` | `gpt-5.6-luna` | 109 input, 7 output, 116 total | `ffd69aeb163d488b69f67f84a46c1c4b205b4f3b912ad2e702bbbf32bb23abd3` | choice `C`, pass |

No cell was missing, failed, retried, cancelled, invalidated, or unscorable.
The final identities were:

- Benchmark:
  `97db563e88aec392f9afa2f38218651e890d4a898fc97af3390e80b37ca3ec86`
- Matrix:
  `4265d398c09013f906be726f5c4958a1e1a6b56229bd6a9c4fe29915513ad24e`
- Report:
  `e3d0ddf3bc2c711bbe66b131a202c82d3056a7fa30d080c490a86ce8d112b4ff`
- Report envelope:
  `a80d935a9c31f8f6d75cac7afba9a44e3d3baa1bd3fb1fa2541e8b8cb751f9cb`
- Public bundle:
  `a2193138661ddc6c86e5e73e6024c2e7302023ba81e35048914dc48f0d326bcd`

## Native-log and portable-bundle proof

Inspect `0.3.255`'s official `read_eval_log()` API accepted both published
`.eval` files. Each log reported `success`, exactly one sample with id
`Mercury_417466`, exactly one public `ModelEvent`/`ModelCall`, exact request and
response model `gpt-5.6-luna`, and the native `choice` score. `inspect view
bundle` produced a matching offline viewer with network disabled.

The first otherwise-successful live publication exposed a real closure defect:
the bundle retained the Task and native logs but omitted the sealed Inspect
selection manifest. That publication was rejected as final evidence. The
bundle materializer and independent verifier now require the exact canonical
selection bytes under the `runtime-selection` evidence role and check selected
arm/provider evidence against them.

After that fix, the final bundle included the exact selection bytes at
`records/c354d282cabe8977a17ed771e3cc2bf38db49229951ac1057d3e0369a210f70e.bin`.
The source product workspace was then deleted. From the copied directory alone:

- all six Jinn checks passed: manifest, evidence closure, trust, Matrix
  re-derivation, Report verification, and claim consistency;
- both native logs still passed `read_eval_log()`; and
- Inspect View still produced a viewer.

The approved detached bundle was retained locally at the time of the proof at
`/private/tmp/jinn-inspect-luna-approved-bundle-final-20260811`. As recorded in
the erratum, that path is no longer present; the bundle was never a committed
repository fixture.

## Credential and isolation observations

The host key file was absolute, outside the repository and product workspace,
regular, non-symlink, and mode `0400`. Its path was provided only through
`BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE`. The web/product process checked file
metadata but did not read credential bytes. The runtime host copied the bytes
over standard input into a broker-only ephemeral volume; the worker received
only a per-attempt capability and broker-only network.

The key was not placed in command arguments, selection JSON, product state,
worker environment, worker mounts, native logs, public records, or bundle
metadata. Scans found no API-key-shaped value, authorization header, or host
key-file path in the workspace or final bundle. The local key file was deleted
immediately after the official calls. No `jinn-inspect-*` container, network,
or volume remained.

Credential-free malicious-task coverage separately probes environment
variables, `/proc`, host paths, home/keyring locations, the Docker socket,
credential mounts, and a host sentinel. It also proves model/config/call-budget
enforcement and cross-attempt capability isolation. The live ARC task was kept
unmodified and therefore was not replaced with this attack fixture.

The run does **not** rehabilitate the credential's prior chat exposure. The
accepted exception proves only the technical runtime behavior and cannot be
cited as evidence that a credential was never exposed.

## Defects found and corrected during the live proof

1. Hugging Face `datasets` creates lock files during cached offline reads, so a
   fully read-only cache root failed. The worker now creates only a temporary
   writable lock/index root under bounded scratch while the selected dataset
   bytes remain digest-locked and read-only.
2. Installed registry tasks such as `inspect_evals/arc_easy` can expose no
   `task_file` through Inspect's public metadata. The adapter now binds the
   complete installed distribution tree rather than inventing a module path.
3. The portable evidence closure omitted the sealed Inspect selection. The
   materializer and verifier now require and validate it as described above.

Each defect has regression coverage. No Inspect-private API, solver
replacement, synthetic EvalLog, worker-visible credential, model fallback, or
Tier 1–3 record change was required.

## Sanitized verification commands

```bash
docker build --platform linux/amd64 \
  --tag jinn-inspect-worker:0.3.255-luna \
  packages/benchmark-product/core/src/runtime/inspect

JINN_INSPECT_OCI_IMAGE=sha256:621da2991c09b2088bad2e9e00671ca48819c4a6e008d702234fb4f172bc3a64 \
JINN_INSPECT_OCI_DATASET_CACHE=/absolute/path/to/credential-free-test-cache \
yarn vitest run \
  src/runtime/inspect/broker.integration.test.ts \
  src/runtime/inspect/oci.integration.test.ts

colophon bundle verify \
  --bundle /path/to/copied-bundle \
  --json
```

All paths and outputs retained in this document are sanitized. Credentials,
raw diagnostics, unapproved logs, viewer caches, dataset caches, and transient
Docker resources are not repository artifacts.

Final verification after the live fixes:

- real OCI worker/broker integration: 5 passed;
- core: 701 passed, 13 expected opt-in skips;
- core typecheck, build, parity generation check, and packed-package smoke:
  passed;
- web: 79 passed; typecheck, lint, and production build passed;
- production browser journeys: 3 passed;
- package inventory: 5 passed;
- source-boundary guard: 8 passed;
- packed public TypeScript consumer: passed; and
- generated architecture catalog and `git diff --check`: passed.

## Claim limits

The Inspect score is `same-execution-scorer`, not independent evaluation. The
broker preserves Inspect-native transcript evidence but does not turn the same
process owner into an external evaluator. Luna exposes the mutable alias
`gpt-5.6-luna` rather than a dated snapshot: Jinn rejects a different returned
identifier, but cannot prove that provider weights behind an unchanged alias
did not change. This was a one-sample integration proof, not a statistically
meaningful model comparison.

Subscription-backed Codex, tools, coding agents, task-defined sandboxes,
multi-turn tool history, hosted secret management, and marketplace execution
remain out of scope.
