# Autopilot issue #1697 protocol fixture

This fixture applies the Jinn Execution Evidence Protocol candidate to one real Autopilot run:
Claude Code session `1b110a92-0095-4cd5-b230-847c7f0d6ba2`, which implemented GitHub issue
#1697 and opened draft PR #1704 on 2026-07-14.

It is deliberately a **source-backed conformance trial**, not a golden conforming record. The raw
trace proves that the task, implementation, review, review-driven fix, YAML check, push, and PR
creation occurred. It does not contain everything v1 requires, and this fixture does not invent
the missing facts.

## Outcome

The run maps cleanly to the protocol's conceptual entities:

| Protocol entity | Source-backed representation |
| --- | --- |
| Task | Issue #1697 title and body reconstructed from the `gh issue view` result; public derivative in `artifacts/task.public.md`. |
| Executor Agent | Observed Claude Code session Agent. |
| Runtime Specification | Observed Claude Code version, model service name, workflow, tools, and child stages in `artifacts/executor.observed.json`. |
| Execution | Source session UUID, start/end times, completed lifecycle, Agent, and duration in `candidate-execution-graph.json`. |
| Inputs | Repository, branch, target base, and changed-file preimage in `artifacts/repository-input.observed.json`. |
| Result | Exact final patch from the transcript in `artifacts/result.patch`. |
| Trace | Private source commitment plus an 11-event public projection in `artifacts/trace.public.json`. |
| Evaluation | Initial-patch approval plus final-patch YAML validation; insufficient for a final `pass`, so the defensible result verdict is `inconclusive`. |
| Verification | Enough evidence exists for a later narrow process verification, but no signed verification was emitted by the run. |

Full v1 Execution Evidence conformance fails for two substantive reasons:

1. the original repository base commit/tree was never captured; and
2. producer-controlled workflow, skill, prompt, and effective configuration inputs were not
   preserved as content-bound artifacts; the hosted model was identified only by its service label
   and had no provider attestation.

The exact result patch survives independently of later Git history. The two commit IDs reported by
the execution no longer resolve in the current local object database after branch-history
rewriting, which is a concrete reason to make the patch/result manifest content-bound at capture
time.

## Privacy result

The 549,916-byte native trace is not included. A check-only run of the current scrub pipeline
found 559 findings requiring 411 redactions, primarily identities, paths, addresses, and
credential-shaped values. Only category counts are recorded.

The public trace is therefore a lossy task-event projection. It preserves the source digest,
event order, result lineage, and limitations, while excluding startup hooks, local paths, tool
payloads, and unrelated operator context.

A second scrub check over the public fixture still rejects five technical strings as high-entropy:
the long public branch name, a pinned nightly version inside the exact Result patch, a Git blob
identifier, and a long structural field name. These appear to be false positives, but the fixture
does not silently alter the Result to make the check pass. The candidate therefore remains
publication-blocked pending an allowlist or detector correction. This fixture does **not**
authorize publication.

## Files

- `source-observations.json` records only facts directly recoverable from the source.
- `candidate-execution-graph.json` shows where those facts land in the RO-Crate/PROV model without
  claiming Jinn profile conformance.
- `conformance-report.json` evaluates every relevant v1 requirement and records the protocol
  findings.
- `artifacts/` contains the safe derived Task, exact Result patch, observed Executor and repository
  inputs, public trace projection, and scrub receipt.

The source commitments are:

| Artifact | SHA-256 |
| --- | --- |
| Private native transcript | `96ab38d496a593d9217aefd7e9d37538c8e94bcf4d78650127ca0b8a892f5a00` |
| Reconstructed private Task | `e756ba2396b38269c424e753938da5a0d5cbdc508a83965bd9fd8f9e8eb19462` |
| Final Result patch | `8ee8ef8ca507ca4c83d0b693404ec7ed36fd0f67df9551d8172dcca125d718f3` |

## What this says about Autopilot capture

Future Autopilot runs can produce conforming evidence directly if the attempt manifest seals, at
start and completion:

- exact Task bytes and source identity;
- repository URL, base commit, and base tree;
- immutable Runtime Specification artifacts plus declared hosted-service identifiers;
- Execution ID, Executor Agent, timestamps, and resource measurements;
- native trace digest and scrub provenance;
- final result manifest containing patch, head commit, and relevant output digests; and
- test reports, reviews, or other evaluations as separate claims over exact Task/Result subjects.

Older transcripts remain useful experience evidence, but their import must carry limitations and
must not be upgraded to full v1 conformance by reconstructing unobserved facts from current state.
