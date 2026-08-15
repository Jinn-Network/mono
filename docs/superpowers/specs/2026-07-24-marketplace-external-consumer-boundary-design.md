# Marketplace External Consumer Boundary

> **Amended 2026-07-30** by the
> [marketplace-surfaces design](./2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md):
> the boundary is re-derived as a key-custody law. What this document preserves: schemas +
> the `jinn` CLI remain the default external on-ramp; the CLI remains the only key-loading
> surface offered to external consumers; `@jinn-network/sdk` never gains tx code; the
> packed acceptance discipline (§7) extends to the work client. What is superseded: the
> implied prohibition on tx-capable published libraries (§2.2's "no programmatic
> transaction client" as a package-shape rule) — published packages are consumable under
> the custody law, with the threat model on the record there (its §3).

- **Date:** 2026-07-24
- **Status:** design approved; written review pending
- **Shape:** `design`
- **Scope:** make the existing Jinn SDK and one-shot client CLI sufficient for
  an external Autopilot installation to publish and adopt marketplace Tasks
  without a `jinn-mono` checkout

## 1. Summary

The first external marketplace consumer is the standalone
`Jinn-Network/autopilot` product. It must consume released Jinn artifacts in
the same way as any unrelated Node application:

```text
@jinn-network/sdk       protocol codecs and golden fixtures
@jinn-network/client    installed `jinn` one-shot CLI
```

No consumer may import `jinn-mono` source paths, rely on Yarn portals, start a
local Jinn daemon, or call an unpublished client module. The external process
constructs and validates immutable request files with the SDK, invokes the
packaged CLI, and parses the CLI's strict JSON results with the SDK.

The existing marketplace execution design remains authoritative for lifecycle
semantics. This design only defines and proves the package boundary required
to move its Autopilot host implementation to the standalone repository.

## 2. Goals and non-goals

### 2.1 Goals

1. Publish every Autopilot marketplace wire contract through stable SDK
   subpath exports.
2. Publish the corresponding golden fixtures so two repositories can test the
   same bytes and failure cases.
3. Package the existing machine-facing Task submission and delivery
   observation commands in the public `jinn` binary.
4. Generalize the new Autopilot session branch so its schema does not require
   a baked-in `Jinn-Network/mono` repository identity.
5. Preserve all existing `jinn-repo.v1` legacy task compatibility.
6. Prove the SDK and CLI from packed tarballs in a temporary consumer project
   outside the monorepo.
7. Publish new package versions and validate exact-SHA canaries before a
   stable release.

### 2.2 Non-goals

This pass does not:

- create `@jinn-network/marketplace` or another package;
- add a programmatic transaction client to the SDK;
- expose client internals as a JavaScript library;
- add a launcher URL, launcher token, or client daemon requirement;
- let external consumers bypass the creator Safe, keystore, escrow, network,
  or SolverNet checks already owned by the CLI;
- define arbitrary creator-supplied verification commands;
- claim that the official SolverNet supports every public GitHub repository;
- add a new SolverType; or
- port the host-side Autopilot implementation into the standalone repository.

The standalone port is the immediate consumer of this boundary, but remains a
separate pull request.

## 3. Public package boundary

### 3.1 `@jinn-network/sdk`

The SDK is the sole JavaScript protocol dependency for an external consumer.
It exposes:

- `jinn-autopilot-session.v1`;
- `jinn-autopilot-mutation-result.v1`;
- `jinn-autopilot-review-result.v1`;
- `jinn-autopilot-marketplace-adoption.v1`;
- the complete correlation tuple and matching helper;
- adoption receipt comment formatting and parsing;
- `jinn-task-submit-request.v1`;
- Autopilot delivery expectation and machine result schemas; and
- the golden fixtures for all accepted, rejected, Human, pending,
  contradictory, and correlation-failure cases.

The primary consumer import is:

```ts
import {
  AutopilotSessionCapsuleSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotAdoptionReceiptSchema,
  TaskSubmitRequestV1Schema,
  AutopilotDeliveryExpectationSchema,
  AutopilotDeliveryObservationSchema,
} from '@jinn-network/sdk/autopilot';
```

`@jinn-network/sdk/solvernets/jinn-repo` continues to re-export the
SolverNet-specific task, Solution, Verdict, and Autopilot schemas used by the
client. This preserves the existing role-oriented SDK layout while giving
host applications a direct protocol entry point.

No external consumer imports `src/`, `dist/` internals, or a relative path
into `packages/sdk`.

### 3.2 Published fixtures

Canonical fixture files live under:

```text
packages/sdk/fixtures/autopilot/
```

They are included in the npm tarball and exported through:

```text
@jinn-network/sdk/fixtures/autopilot/*
```

The SDK's own tests and external-consumer pack test read these exact files.
There is one fixture manifest containing:

- fixture path;
- schema or disposition represented;
- SHA-256 of the raw file; and
- whether decoding must succeed or fail.

The manifest prevents two repositories from silently maintaining
lookalike-but-different "golden" payloads.

### 3.3 `@jinn-network/client`

The client remains the implementation of all stateful marketplace access. Its
published `jinn` binary provides:

```text
jinn tasks submit \
  --request-file <path> \
  --yes \
  --json \
  [--dry-run]

jinn tasks observe-autopilot-delivery \
  --expectation-file <path> \
  --json
```

The CLI owns:

- creator Safe and keystore loading;
- escrow/funds validation;
- official network defaults and environment overrides;
- RPC, gateway, indexer, registry, contract, and Mech configuration;
- unique live SolverNet selection;
- canonical signing and IPFS publication;
- crash-safe Task posting and `TaskCreated` recovery;
- exact solution and verdict discovery;
- RPC verification of the actual Mech delivery event; and
- strict machine error classification.

The consumer never supplies a launcher endpoint and never starts a local
daemon.

## 4. Wire compatibility

### 4.1 Submit request

The existing `jinn-task-submit-request.v1` wire format moves from a
client-private validator to the SDK. The client imports that validator rather
than maintaining a second copy.

The machine command continues to return:

- marketplace Task ID;
- Task CID;
- creation transaction hash;
- creation block;
- selected SolverNet manifest CID; and
- idempotency status.

The SDK exports the output schema as part of the same public contract.

### 4.2 Delivery observation

The expectation file and all CLI outcomes are SDK-owned schemas. The outcomes
remain:

```text
pending
verified
contradiction
```

Verified results preserve the complete task, attempt, request, envelope,
transaction, session, result, and correlation provenance. A malformed or
unknown output is never treated as pending.

### 4.3 Repository identity

Legacy `merged-pr` and `live-issue` branches of `jinn-repo.v1` retain their
current `Jinn-Network/mono` and TypeScript restrictions.

The new `autopilot-session` branch instead validates:

- a safe `owner/name` GitHub repository slug;
- a non-empty normalized language identifier; and
- a non-empty immutable verification profile identifier.

`jinn-autopilot-session.v1` carries the same repository, language, and
verification profile. The outer Task and inner session values must match.

This is an additive generalization of an unreleased branch, not a weakening
of existing published legacy task validation.

### 4.4 Verification profile policy

The official first profile remains:

```text
jinn-mono.v1
```

The official solver and evaluator must reject a Task when the selected profile
is unsupported or when `jinn-mono.v1` is paired with a repository other than
`Jinn-Network/mono`.

The profile identifier is a capability binding, not a shell command. Future
non-mono profiles require their own reviewed solver/evaluator and host
implementation. They do not require another protocol packaging redesign.

## 5. Consumer workflow

An external host performs:

1. import SDK schemas from a declared package subpath;
2. construct and validate the canonical request;
3. write the immutable request beside its own durable attempt state;
4. invoke `jinn tasks submit` with an allowlisted environment;
5. persist the strict JSON result;
6. invoke `jinn tasks observe-autopilot-delivery` during recovery/adoption;
7. validate the observation with the SDK; and
8. perform its application-specific adoption protocol.

The Jinn CLI configuration directory remains machine-local. GitHub
credentials, target worktrees, and host lifecycle state are not Jinn client
configuration and are never forwarded to the CLI.

## 6. Packaging and versions

The release versions become:

- `@jinn-network/sdk@0.1.1`;
- `@jinn-network/client@0.2.1`.

The SDK package includes `dist/`, `fixtures/`, and its README. Its export map
contains every public subpath named by this design.

The client package continues bundling its runtime implementation into the
published artifact. The published manifest must contain no `portal:`,
`workspace:`, absolute checkout path, or unpublished SDK dependency.

Canary publication order is:

1. SDK exact-SHA canary;
2. client exact-SHA canary;
3. external-consumer acceptance against those exact versions; and
4. stable SDK followed by stable client.

## 7. Packed external-consumer acceptance

One acceptance test creates a temporary directory outside every Yarn
workspace, then:

1. packs the SDK and client with their real prepack hooks;
2. inspects both tarball manifests for forbidden local dependency references;
3. installs the tarballs with Node 22 and npm;
4. imports `@jinn-network/sdk/autopilot`;
5. imports `@jinn-network/sdk/solvernets/jinn-repo`;
6. reads and hashes every exported golden fixture;
7. decodes the fixture corpus according to its manifest;
8. invokes the installed `jinn` binary;
9. proves the tasks help exposes both machine commands; and
10. exercises request parsing with a deliberately invalid or expired fixture
    that is rejected before network or wallet setup.

The packed acceptance must not reach through an unpublished client module or
inject a test-only adapter. It must not require live funds, a real Safe
transaction, a daemon, or access to the source checkout after installation.
The existing command-level tests continue to cover successful dry-run
preflight with injected deterministic adapters.

Separate existing Anvil and live-canary tests continue proving transaction and
delivery behavior.

## 8. Failure behavior

- Missing SDK exports or fixtures fail package smoke tests.
- A CLI too old to recognize either machine command fails Autopilot preflight.
- A request/observation schema mismatch fails before host mutation.
- Unsupported verification profiles fail closed.
- Packaged artifacts containing local paths or workspace protocols fail the
  release gate.
- Network, Safe, funds, catalog, indexer, gateway, RPC, or Mech failures keep
  their existing structured CLI classifications.

There is no local agent fallback and no alternate submission transport.

## 9. Test strategy

Implementation follows test-first slices:

1. failing SDK export and fixture-pack tests;
2. failing generic Autopilot-session codec tests while legacy fixtures remain
   unchanged;
3. failing client tests importing submit and observation schemas from the SDK;
4. failing client tarball/bin smoke tests;
5. failing external temporary-project acceptance;
6. focused SDK/client suites and typechecks; and
7. the existing Autopilot marketplace, Anvil, and packaging regression suites.

The acceptance gate proves the actual published shape, not only monorepo
source compatibility.

## 10. Follow-on work

After this boundary is released:

1. port the Autopilot host backend to `Jinn-Network/autopilot`;
2. replace every `../../../sdk/src/...` import with the released SDK subpath;
3. add standalone configuration and doctor checks for the installed CLI;
4. prove the standalone consumer against the exact canaries; and
5. remove the mono Autopilot package as an independently edited source once
   the standalone cutover is complete.

A lightweight marketplace package can be considered later if multiple
consumers demonstrate that process invocation is the wrong boundary.
