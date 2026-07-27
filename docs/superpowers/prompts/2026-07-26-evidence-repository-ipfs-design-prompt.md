# Design prompt — the `repository-ipfs` binding

**Date:** 2026-07-26

> **Design-session archive; non-normative.** This file is retained only as historical rationale.
> Do not execute any instruction below. Implementation starts with
> `2026-07-26-evidence-substrate-implementation-foundation.md`, followed by the final design and
> implementation plan. The remainder preserves the completed session's original prompt language.
>
> **Historical prerequisite:** `2026-07-26-evidence-substrate-session-context.md`. It carried the rebuild's
> principles, the required reading list, the ownership map, how to read the unmerged PR stack, the
> non-negotiables, and the self-review checklist. This prompt adds only what is specific to the
> IPFS binding.
>
> **Historical outputs, completed:** a design at
> `docs/superpowers/specs/2026-07-26-evidence-repository-ipfs-design.md` and an implementation
> plan at `docs/superpowers/plans/2026-07-26-evidence-repository-ipfs.md`. This item was small
> enough that both should land in one session.

---

## 1. The item

`EvidenceRepository` is exact-byte content-addressed storage. It has a filesystem binding and an
OCI binding. It has no IPFS binding. IPFS is a useful optional public repository rail, but it is
not a prerequisite for publication and it is not the mandatory public transport; OCI already
provides a standards-based remote repository binding.

This is the **Binding** layer: one medium, one heavyweight dependency.

## 2. Prior art — read all of it before designing

Three IPFS implementations already exist in this repository. Read them; do not start from a blank
page.

| Path | What to take from it |
| --- | --- |
| `packages/layer/src/ipfs-cid.ts` (169 lines) | Strict canonical CIDv1 raw sha2-256 parsing and validation. Its 256 KiB comment conflates Kubo's default UnixFS chunk size with the standard raw-block ceiling and must not be carried forward. |
| `client/src/adapters/mech/ipfs.ts` | Operator-side upload and download against the Autonolas gateway and registry — the production path in use today |
| `packages/indexer/src/ipfs.ts` | Ponder-side fetch, i.e. the read path under indexer conditions |

Also read the consolidated `packages/evidence/repository/` contract, its `/fs` binding and
conformance kit (`describeEvidenceRepositoryContract`), and
`packages/evidence/repository-oci/` as the existing bindings whose shape you should match.

## 3. The questions this design has to answer

**Digest and CID must agree.** The repository addresses records by `sha256:<hex>`; IPFS addresses
blocks by CID. `ipfs-cid.ts` already pins the canonical form — CIDv1, raw codec, sha2-256 — which
makes the mapping total and reversible. Confirm that in source rather than assuming it, state the
mapping explicitly, and say what happens when a caller presents a CID outside the canonical form.

**What does "durably stored" mean on a medium with no acknowledgment?** This is the substantive
question in the item. A filesystem write returns when it is durable and an OCI push returns a
digest, but adding a block to IPFS tells you very little about whether anyone else can retrieve it.
Decide what the binding promises on a successful `putRecord`, and be honest about what it cannot
promise. The graded-guarantee discipline from the publication design (§4) is the model to follow.

**Pinning and garbage collection.** Related but separate: whether the binding pins, whether pinning
is part of `putRecord` or a distinct operation, what happens when a pin service rejects or expires,
and whether unpinning is ever the binding's business.

**Gateway or node?** The three prior implementations do not all make the same choice. Decide what
the binding requires of its operator, and whether read and write can differ — a gateway read with a
node or pinning-service write is a plausible shape.

**The block size ceiling.** Kubo's 256 KiB default is a UnixFS chunk size, not the maximum raw
block. The final design uses the standard 2 MiB raw-block ceiling, declares it through
`EvidenceRepository.capabilities.maxObjectBytes`, rejects larger objects before I/O, and prohibits
`allow-big-block`. Announcement-frame sizing is independent and comes from exact sink preparation.

**Does it pass the updated contract kit unmodified?** `describeEvidenceRepositoryContract` is the
gate after the repository-capabilities prerequisite lands. If IPFS semantics cannot satisfy an
assertion, surface that finding rather than working around it.

## 4. Intersections to get right

- **`evidence-repository`** — the explicit capabilities prerequisite is the only widening. After it
  lands, implement the contract and pass its kit without IPFS-specific exceptions.
- **`publication`** — the remote repository its store phase writes into. Read
  `2026-07-25-evidence-publication-design.md` §6 for what the pipeline expects, particularly that
  it hands over exact bytes and expects a digest-addressed put.
- **A future IPFS announcement medium** — separate from this binding, and not your item. But
  `2026-07-25-evidence-publication-design.md` §3.2 requires a medium package to pair its sink with
  its source over one framing codec, and that package will sit next to this one. Note anything you
  build that it will need — the CID helpers most obviously — and say whether those belong here, in
  the medium package, or shared.
- **`packages/layer/src/ipfs-cid.ts`** — decide whether the new binding imports it, copies it, or
  supersedes it. All three are defensible; pick one and justify it. Note that `packages/layer` is
  legacy and the substrate should not take a dependency on it.

## 5. Watch for

**Do not smuggle in the announcement path.** Storing bytes so they are fetchable is this item.
Anchoring, announcing, and framing bundles are not. If your design starts describing what gets
written on chain, you have crossed into the medium package.

**Do not let "IPFS is eventually consistent" become a shrug.** The interesting part of this design
is stating precisely what the binding guarantees and what it delegates to the operator's
infrastructure. A design that hedges everywhere is not usable by the publication pipeline, which
needs to know whether a store phase can be treated as complete.
