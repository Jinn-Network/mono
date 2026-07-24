# Autopilot Semantic Evaluator Hardening Design

**Date:** 2026-07-24

## Goal

Make the marketplace semantic evaluator fail closed at every trust boundary while
preserving exact accepted-Solution correlation, full effective-PR review
semantics, and per-SolverNet runtime choice. This branch prepares the APIs but
does not wire the daemon's adoption-receipt observer, evaluation-context
resolver, or semantic runtime composition.

## Mechanical trust boundary

`ExactHeadMechanicalRunner` may perform only trusted Git operations needed to
clone the repository, fetch the two immutable OIDs, detach at the accepted
resulting head, verify that exact head, and enumerate the full
`targetBaseOid...resultingHead` diff. Every subprocess receives a minimal
allowlisted environment with an isolated HOME and no daemon credentials.

The runner rejects prohibited paths and any path outside the complete supported
package policy, including mixed supported/unsupported diffs. It never runs
candidate-controlled dependency installation, lifecycle hooks, package scripts,
test files, or configuration on the host.

A typed `ImmutableMechanicalVerifier` port may be supplied by a future
production composition that owns a genuinely isolated, immutable verifier. In
its absence, a mechanically eligible code change is unscorable. This is
intentional: repository identity and path checks alone cannot justify a
mechanical pass.

After immutable verification passes, the trusted host captures a bounded
complete `base...head` diff with external diff drivers and text-conversion
drivers disabled. Git path discovery is NUL-delimited and validates the exact
raw paths before package policy checks; paths are never trimmed or normalized.

## Semantic trust boundary

The Claude semantic adapter runs from an isolated HOME with a credential
allowlist and an empty isolated working directory. It enables Claude safe mode,
disables slash-command skills, supplies an empty strict MCP configuration, does
not load project settings, and disables every tool. The bounded trusted
`base...head` diff and strict evaluation context are supplied through stdin,
never through an argv path or candidate checkout.

The review prompt embeds the trusted review methodology. It does not ask the
agent to discover or execute a `review-pr` skill from the candidate checkout.
Candidate `CLAUDE.md`, settings, hooks, agents, skills, plugins, MCP servers, and
commands therefore cannot become evaluator control-plane input. Candidate
prompt injection cannot read a host path, follow a checkout symlink, or turn a
Git inspection command into a write because the semantic process has no file or
shell tools and never receives the checkout as its working directory.

## Per-SolverNet runtime resolution

`JinnRepoEvaluatorHarness` receives a resolver rather than one global semantic
runner. At execution time it passes the exact task manifest CID together with
the engine's SolverNet name, solver type, and configured model. The resolver
returns a provider-labelled runtime and runner for that exact SolverNet.

The harness fails closed when the resolver is absent or returns no runtime.
The chosen model is passed per invocation, so one daemon can evaluate distinct
SolverNets with different provider/model configurations without mutating a
singleton runner. Production resolver construction remains outside this branch.

## Full-head base OID

Mutation application and review comparison need different Git anchors:

- `baseSha` remains the parent of the mutation claim. For child work this is the
  prior PR head and is required to apply the child patch safely.
- `targetBaseOid` is the separately resolved OID of the PR's target branch and
  is the base of the evaluator's complete effective-PR diff.

`targetBaseOid` is a required field in new session inputs and the strict SDK
session snapshot. The evaluation context binds `reviewTarget.baseOid` to
`taskSnapshot.targetBaseOid`, never to `baseSha`. Both initial and child
executors resolve the target-base head explicitly before starting a marketplace
session.

## Cancellation and cleanup

Git and semantic subprocesses run as detached process groups. Cancellation sends
SIGTERM to the group, waits a bounded grace period, escalates to SIGKILL, and
waits a second bounded period for the child close event. Cleanup occurs only
after the child is reaped. Failure to reap is an infrastructure failure and
must not become a graded result or race deletion of a live process's HOME or
checkout. Cleanup-unsafety is propagated through the semantic-runner port so
orchestration preserves both resources after an unreaped timeout.

## Verification

Regression coverage must first fail against the integrated baseline for:

- inherited mechanical credentials and candidate package execution;
- unsupported paths hidden inside a mixed diff;
- absent immutable verifier behavior;
- candidate Claude project control-plane loading;
- per-SolverNet manifest/model runtime resolution;
- SIGTERM escalation, SIGKILL escalation, reaping, and cleanup ordering;
- child sessions binding review base to target-base OID rather than prior PR
  head.

Final verification consists of the focused SDK, Autopilot producer, and client
semantic-evaluator suites plus the complete client TypeScript typecheck under
Node 22.
