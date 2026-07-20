# #1899 attribution analyzer review hardening

## Scope

Harden the offline Stage 2 daemon-autoload attribution analyzer without
launching a fleet, contacting production, publishing artifacts, or changing the
Human-owned #1843 experiment. The analyzer remains read-only and fail-closed.

## Authoritative verdict evidence

Each observation receipt is a runner export, not an operator-authored outcome.
It carries:

- the canonical signed solution and verdict `jinn.execution.v1` envelopes;
- the embedded runner-exported marketplace attempt and verdict rows, used
  only as join constraints;
- the immutable solution and verdict evidence hashes claimed by the runner;
- experiment-only runtime, isolation, timing, delivered-reference, and cost
  metadata.

The exporter authenticates both canonical envelope signatures with the existing
execution-envelope authenticator. It then requires one exact join:

1. the solution envelope request ID and participant Safe match the marketplace
   attempt;
2. the verdict envelope request ID and participant Safe match the marketplace
   verdict;
3. both marketplace rows share `(chainId, taskId, attemptIndex)`;
4. the receipt instance matches the signed solution and verdict task identity;
5. each marketplace evidence hash matches its signed envelope hash;
6. the embedded marketplace verdict code (`Pass = 1`, `Fail = 2`) agrees with
   the authenticated signed `passed_match`;
7. the authenticated SWE-rebench verdict score agrees with its signed
   `passed_match` payload.

`acceptedDiff` is derived from that authenticated verdict payload. It is not a
receipt input. Arbitrary reference strings, self-consistent outcome JSON, and
permissionless enrichment projections cannot satisfy this contract.

## Resource bounds

Evidence manifests retain the existing per-file bound and gain a practical
aggregate byte bound. Regular files are opened without following symlinks,
checked with `fstat`, and read through a bounded descriptor buffer rather than
`readFileSync`. A file that is initially oversized or grows after the size
check is rejected without allocating beyond the configured cap.

## Preregistration integrity

The two-cell order is derived reproducibly from
`sha256(executionOrderSeed)`: an even low bit selects `off,on`, and an odd low
bit selects `on,off`. Schema validation rejects manually reordered cells. The
runbook derives and verifies the same order before anchoring.

Every GitHub anchor verification checks exact body, issue, creation time, and
`updated_at === created_at`. Any edited preregistration comment invalidates the
run.

## Verification

Tests first demonstrate:

- an out-of-contract/fabricated outcome, reference, or marketplace verdict
  code fails;
- a valid signed solution/verdict plus an exact embedded attempt/verdict join
  passes;
- aggregate evidence overflow, initial oversize, and post-stat growth fail;
- seed/order drift fails and both deterministic seed branches are covered;
- every runbook anchor verification includes the edited-state assertion.

Focused analyzer/exporter tests, client typecheck/build, Bash extraction,
`git diff --check`, and a proportional security audit gate the local commit.
