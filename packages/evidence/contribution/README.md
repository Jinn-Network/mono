# `@jinn-network/evidence-contribution`

Host-neutral disclosure authorization and publication workflow for Jinn
Evidence. It prepares one exact Evidence record for disclosure, binds
authorization to its disclosure and destinations, publishes through the
existing Evidence substrate, and reports recoverable per-destination
outcomes.

The root entrypoint defines the durable workflow: request creation,
preparation, authorization, standing grants, Publication, decline, and
deactivation. `@jinn-network/evidence-contribution/testing` provides a
portable host-integration contract kit
(`describeEvidenceContributionContract`) and in-memory doubles for it.

This package uses `Attempt` as the Jinn user-facing noun for the workflow's
subject. A standalone Task submission is not, by itself, an Evidence
Contribution -- Contribution begins once an Attempt has produced one Evidence
record (Execution, Evaluation, or Verification) that a host wants disclosed.

## One-record boundary and three record families

Every request names exactly one primary Evidence record: `execution-evidence`,
`result-evaluation`, or `execution-verification`. A host that wants to
disclose several related records -- for example an Execution and a later
Evaluation of it -- issues one independent request per record. There is no
multi-record bundle and no fourth record family.

## Preparation, authorization, Publication, and admission are different things

- **Preparation** resolves the exact source bytes, verifies a source-bound
  disclosure-policy decision, and (for `execution-evidence`) invokes
  `EvidenceDeriver` under that policy. It produces a private, immutable
  manifest and a **preview fingerprint** -- or pauses at `review-required`,
  or resolves to `withheld` with content-free reasons. Preparation never
  calls Publication.
- **Authorization** binds an actor's decision to the exact preview
  fingerprint, for a chosen subset of destinations. `interactive-exact` means
  a host asserts a human saw the exact preview; `organization-exact` never
  claims that; a **standing grant** is an explicit, scoped, revocable
  prospective authorization the caller deliberately created in advance.
- **Publication** calls the existing `@jinn-network/evidence-publication`
  package once per authorized destination. A destination is `published` only
  after a completed `PublicationReceipt`, including confirmed announcement
  placement.
- **Admission** -- trust, search visibility, reputation, marketplace
  acceptance, reward, or corpus membership -- is not decided here.
  Contribution's receipt says so explicitly; it never implies any of these.

## Minimal examples

### Interactive exact authorization

```ts
import {
  createContributionRequest,
  prepareContribution,
  authorizeContribution,
  resumeContribution,
} from "@jinn-network/evidence-contribution";

const created = await createContributionRequest(proposal, dependencies);
const prepared = await prepareContribution(created.requestId, dependencies);

// Render `prepared.manifestBytes` / `prepared.previewFingerprint` to the
// user, then submit their decision:
await authorizeContribution(
  prepared.requestId,
  {
    mode: "interactive-exact",
    authorityId: "https://host.example/authority",
    actorId: "user-1",
    previewFingerprint: prepared.previewFingerprint!,
    allowedDestinationIds: [/* chosen destination IDs */],
    decidedAt: new Date().toISOString(),
    proofDigest,
    proofBytes,
    exactPreviewPresented: true,
  },
  dependencies,
);

const result = await resumeContribution(prepared.requestId, dependencies);
```

### Standing-grant authorization

```ts
import {
  createStandingAuthorizationGrant,
  applyStandingAuthorization,
} from "@jinn-network/evidence-contribution";

const grant = await createStandingAuthorizationGrant(scopedSubmission, dependencies);
await applyStandingAuthorization(requestId, grant.grantId, dependencies);
```

A standing grant is matched only after a request reaches `preview-ready`; it
never matches `review-required` or `withheld`, and the scope is always
exactly what the caller declared -- never inferred.

## Resume is always safe to call again

Every mutating command is retry-safe. `resumeContribution` advances every
currently-eligible destination in deterministic destination-IRI order,
reusing an already-checkpointed Publication operation identity rather than
starting a new one, and continues past a classified per-destination failure
instead of throwing. `retryContributionDestination` re-enters one
`retryable-failure` or interrupted destination.

## Per-destination outcomes are independent and non-atomic

Publication runs once per authorized destination. Two destinations on the
same request can be in entirely different states at once -- one `published`,
another `retryable-failure`, a third still `awaiting-authorization`. Reading
a request's outcome always means reading its per-destination array, never a
single request-wide status alone.

## Signed records: unchanged, or withheld

Evaluation and Verification records are signed DSSE envelopes. Contribution
never transforms them: a source-bound policy either discloses the exact
envelope bytes unchanged (plus any policy-listed companion artifacts) or
withholds it. There is no derived or partially-redacted signed record.

## Deactivation is not deletion

`deactivateContribution` / `deactivateContributionDestination` record that no
new external effect may begin, let an already-started Publication finish
reconciling, and attempt an optional binding-specific availability-withdrawal
capability where the resolved destination supports it. This is **honest
about its limits**:

- one source can never retract another source's availability observation;
- OCI, IPFS, caches, mirrors, and downloaded copies may remain retrievable
  after a withdrawal succeeds;
- the historical Evidence record is never rewritten; and
- local staging bytes are never deleted by Contribution -- the host owns
  retention and garbage collection, guided by the receipt's
  `stagingRetention` field.

Declining is different from deactivating: `declineContribution` only
succeeds before any destination has started Publication. Once Publication has
begun anywhere, use deactivation instead.

## Injected ports and credential isolation

Contribution has no concrete Repository, Publication sink, wallet, or
network dependency of its own. Every effectful capability is an injected
port: `ContributionStore`, `RepositoryResolver`, `DisclosurePolicyAuthority`,
`DerivationResolver`, `PublicationResolver`, `AuthorizationAuthority`, and
`ReviewReferenceStore`. Credentials, secret detector configuration, and
private findings never cross into Contribution state, errors, events, or
receipts -- they stay behind the host's ports, represented at most by a
content-bound digest.

## Using `/testing`

```ts
import { describeEvidenceContributionContract } from "@jinn-network/evidence-contribution/testing";
import { InMemoryEvidenceContributionDriver } from "@jinn-network/evidence-contribution/testing";

describeEvidenceContributionContract(() => new InMemoryEvidenceContributionDriver());
```

`describeEvidenceContributionContract` is a portable Vitest suite: any host
that implements the same driver shape (an in-memory fixture, or one wired to
real infrastructure) can run it to prove its integration behaves like every
other conformant host. `/testing` requires Vitest; the root entrypoint (`.`)
never does.

## Non-goals

This package deliberately does not implement:

- a service, daemon, queue, RPC wrapper, or worker scheduler;
- a concrete `ContributionStore`, filesystem binding, database, or wallet;
- plugin migration, legacy consent import, or product-specific rollout;
- a fourth Evidence record family, a second Evidence format, a Publication
  bundle format, a Repository, an announcement frame, a Derivation algorithm,
  or a Publication journal; or
- deletion of Evidence bytes, or any claim of search visibility, trust,
  admission, or reward.

See `docs/superpowers/specs/2026-07-26-evidence-contribution-design.md` for
the full design.
