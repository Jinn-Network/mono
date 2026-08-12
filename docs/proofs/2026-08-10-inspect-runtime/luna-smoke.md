# Inspect Luna live smoke — 2026-08-10

This is a sanitized record of a manual, opt-in external-provider smoke test.
It supplements the retained credential-free Benchmark Product proof in this
directory. It does not replace that proof and it does not claim that the
Benchmark Product currently forwards provider credentials.

## Result

PASS. A real, unmodified Inspect Evals task called OpenAI's Luna model through
Inspect's public OpenAI model provider, produced a genuine native Inspect log,
and opened successfully in the matching Inspect View.

- Inspect AI: `0.3.255`
- Inspect Evals: `0.16.0`
- Python: `3.11.9`
- OpenAI Python SDK: `2.53.0`
- Model reference: `openai/gpt-5.6-luna`
- Task reference: `inspect_evals/arc_easy`
- Task version: `2`
- Dataset: `allenai/ai2_arc`
- Dataset revision: `210d026faf9955653af8916fad021475a3f00453`
- Sample limit: `1`
- Sample id: `Mercury_417466`
- Solver: the task's unchanged `multiple_choice()` solver
- Scorer: the task's unchanged deterministic `choice()` scorer
- Target: `A`
- Model answer: `A`
- Inspect score: `C`
- Inspect status: `success`
- Usage: 109 input tokens, 7 output tokens, 116 total tokens
- Native `.eval` bytes: `6472`
- Native `.eval` SHA-256:
  `42a75cf5e550c12ce8d3e2d94441fc4b0c3f007068eb8f1d71462ce925cf4314`

Inspect's official `read_eval_log()` API read the artifact and reported one
successful sample with no run or sample error. Inspect View `0.3.255` loaded
the same artifact and displayed the task, Luna model identity, sample, native
transcript, score, accuracy `1.0`, and 116-token model call.

## Isolation and limits

The run executed in a disposable container with a read-only root filesystem,
all Linux capabilities dropped, `no-new-privileges`, a 128-process limit,
2 GiB memory, 2 CPUs, one sample, one model connection, a 2,048-token run
limit, a 120-second time limit, and low reasoning effort. The repository and
host home directory were not mounted. The dataset was prefetched at the pinned
revision before the provider call.

The credential was supplied only to the disposable container as
`OPENAI_API_KEY`. A scan found the complete credential in zero generated files
in the transient evidence directory. A preliminary failed request, caused by a
local credential-prompt length limit, recorded the provider's masked credential
representation in its private error log. After the corrected run was
validated, the temporary Keychain entry, successful and failed native logs,
stdout and stderr, dataset cache, viewer container, and test image were
deleted.

## Proof boundary

This smoke proves that the pinned official Inspect stack can execute the
selected unmodified task against Luna, retain a valid native log, and render it
in Inspect View. The score is same-execution Inspect scoring and is not an
independent evaluation.

This smoke invoked Inspect directly inside the isolated container. The current
Benchmark Product first slice deliberately strips ambient credentials and
supports credential-free runtimes only. Therefore this result does **not**
prove a production credential port, hostile-code isolation, subscription-backed
Codex execution, or an end-to-end credentialed run through the Benchmark
Product lifecycle. Those remain separate follow-up decisions.
