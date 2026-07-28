# @jinn-network/task-execution-testing

The Jinn Task Execution Protocol (TEP) v1 conformance kit. Ships design §24's Layers 1 and 2:
protocol conformance over the golden + adversarial fixtures, the backend contract sanity suite,
and the in-memory fake backend that both are proven against first. Depends on
`@jinn-network/task-execution-protocol` and `@jinn-network/task-execution-backend`.

See the design: `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md`
§24 (conformance and fixture strategy). Carried-amendment implementation notes:
`docs/superpowers/specs/2026-07-28-tep-v1-implementation-addendum.md`.

## What ships here

- **`createInMemoryBackend()` / `InMemoryTaskExecutionBackend`** — a durable-in-memory
  `TaskExecutionBackend` reference implementation (single-party Attempt minting, §9.2). This is
  the kit's own proof surface: both conformance layers below are proven against it *before* any
  real binding exists (design §26).
- **`TestableBackend`** — the frozen `TaskExecutionBackend` contract plus a minimal, documented
  test-only seam (`drive`, `recordDelivery`, `simulateReconciliation`) that lets the Layer-2
  suite drive lifecycle facts and force `recover` outcomes without widening the frozen §22
  contract itself. A binding wanting to run the Layer-2 suite against itself implements this
  seam alongside the real contract.
- **`describeProtocolConformance()`** — a vitest `describe` block asserting the §24 Layer-1
  rules (schema validation of all five families, producer-/consumer-side seal and digest rules,
  reference and cardinality rules, extension preservation, observation ordering and fold
  correctness, Delivery binding, and the full adversarial minimum set) over the golden
  local+marketplace scenario pair and the adversarial fixtures
  `@jinn-network/task-execution-protocol` ships.
- **`describeTaskExecutionBackendContract(makeBackend)`** — the csi-sanity-style Layer-2 suite:
  byte-exact idempotent submit, honest `observe`, `recover` across all three reconciliation
  outcomes, cancel races including cancel-after-terminal, unsupported-requirement rejection
  naming the field, failure-category mapping (operational error vs. Attempt outcome), result
  retrieval on terminal Attempts, and concurrent Attempts within declared bounds.

## Using the kit from a binding

```ts
import { describeProtocolConformance, describeTaskExecutionBackendContract } from "@jinn-network/task-execution-testing";

describeProtocolConformance();
describeTaskExecutionBackendContract(() => createMyBinding());
```

Both are ordinary vitest `describe` blocks — run them from any `.test.ts` file under the
consumer's own vitest configuration. `vitest` is an optional peer dependency of this package: a
consumer already running vitest need not install anything extra.

## The kit-precedes-bindings rule (design §26)

The in-memory fake is proven against `describeTaskExecutionBackendContract` first, in this
package, before any real binding is written. A binding is conformant once it passes the same
suite against itself.

## Two honestly-Layer-3 boundaries

Two adversarial cases are *not* caught by Layer-1 protocol structure alone — dispatch-context
grafting into a re-sealed crate, and capability-grant misuse via a leaked-Task resubmission. The
kit documents this boundary explicitly (§24) rather than faking a catch: both require the
Layer-3 `dispatch-binding` verification check, which compares a crate's captured inputs against
the backend's own dispatch record — out of this package's scope.
