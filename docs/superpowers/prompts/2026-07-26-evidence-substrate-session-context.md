# Evidence substrate — shared session context

**Date:** 2026-07-26

> **Design-session archive; non-normative.** This file grounded the completed derivation and IPFS
> design sessions and contains pre-consolidation assumptions. Do not execute any instruction
> below. Implementation starts with
> `2026-07-26-evidence-substrate-implementation-foundation.md`, followed by the final designs and
> implementation plans. The remainder preserves historical session language.
>
> **Historical purpose.** Common grounding for the then-remaining evidence-substrate design
> sessions. Each item prompt in this directory said "read this file first" and then added only what was specific to its
> item. This file is deliberately the single place the shared context lives — per `CLAUDE.md`, do
> not restate canonical content locally, link to it.
>
> **Historical item prompts:**
> - `2026-07-26-evidence-derivation-design-prompt.md`
> - `2026-07-26-evidence-repository-ipfs-design-prompt.md`
>
> These two are the whole of the remaining substrate design. See §6.1 for a third item that was
> investigated and closed without work.

---

## 1. What is being built, and why it looks the way it does

Jinn is rebuilding its evidence layer from the ground up as a **parallel stack**, one component at a
time. The legacy path — `EpisodeV1` plus a 1,710-line `packages/layer/src/publish.ts` — is still
running in production and is **not** being refactored in place. The new stack is being built beside
it, component by component, and will be adopted later by porting only the pieces that earn their
way across.

This shape is a deliberate reaction to a failed attempt. An earlier effort tried to land a whole
architecture in one pass and produced a map nobody could execute against; it has since been deleted
from the repo. The current approach has produced a materially stronger foundation because each
component is designed, argued, and bounded on its own before anything is written.

**You are continuing that method, not starting something new.** Your session ends with a design
document, and possibly an implementation plan. It does not end with code.

## 2. The principles that thread through the rebuild

These are not style preferences. Each one exists because its absence caused a specific problem.

**One component at a time, and no big-bang cutover.** A design that requires several packages to
land together is mis-scoped. Split it.

**Every package declares what it refuses.** The publication design opens with a table of concerns
that MUST NOT enter the package, derived by reading its 1,710-line predecessor and asking which
half was not publication. That table is the diagnostic used in review when a package starts
growing. Your design produces one too.

**Architectural role is asserted, not drawn in directories.** Role follows from package
dependencies, public entrypoints, and guarded source imports together. A consolidated package may
contain separately guarded contract and binding subpaths. Directories nest by *domain* (stable),
never by *layer* (mutable). See `2026-07-25-evidence-layer-architecture.md`.

**Substrate stops where credentials start.** Anything requiring an operator key, wallet, or
registry identity belongs to the application, not the shared layer. A port is substrate; its
credentialed binding is not. See the layer architecture spec §7.

**Protocol non-goals are load-bearing.** `evidence-protocol` explicitly disclaims collection
manifests, registries, store APIs, and distribution APIs. When a problem looks like it would be
solved by adding a format to the protocol, that is a signal you have mislocated the problem, not a
reason to amend §16.

**A port ships as a contract plus a conformance kit.** The pattern is established by
`evidence-repository/testing` and `evidence-catalog/testing`. Any new port you define ships a
`describeXContract(factory)` suite that every binding must pass.

**Prior art over invention, and name the pattern.** The publication design closes with a section
identifying every mechanism it composes — write-ahead log, plan/apply, idempotency keys, opaque
continuation tokens, transactional outbox. If you cannot name what you are composing, you are
probably inventing something you should not.

**Read the incumbent as prior art.** The legacy code encodes hard-won operational lessons. Extract
the disciplines (save-before-effect, compare-and-swap, freeze the clock, canonical comparison on
resume) and refuse the non-domain concerns. Do not start from a blank page when a battle-tested
implementation exists.

**Grade guarantees; do not overclaim.** Where a medium cannot provide an absolute property, state
the tiers explicitly — required, best-effort, and conditional-on-medium — rather than asserting one
strong claim that some binding will quietly violate.

**Naming collisions across the layer are defects.** Two meanings of one word inside one layer will
cause damage. Check the names you introduce against what the stack already exports.

## 3. Required reading, in order

Some of these live only in the unmerged PR stack — §5 explains how to read those.

| Document | Where | Why |
| --- | --- | --- |
| `specs/2026-07-23-jinn-execution-evidence-protocol-design.md` | local | Record families, conformance tiers, and the §16 non-goals that bound every design |
| `specs/2026-07-25-evidence-layer-architecture.md` | local | The seven roles, consolidated source-region rules, directory rationale, substrate/authority boundary |
| `specs/2026-07-25-evidence-publication-design.md` | local | **The worked example.** Match its shape, rigor, and honesty |
| `plans/2026-07-25-evidence-publication.md` | local | The worked example of the plan that follows a design |
| `plans/2026-07-25-evidence-package-consolidation.md` | local | The post-consolidation package inventory and directory layout your design targets |
| `specs/2026-07-24-jinn-evidence-discovery-layer-design.md` | PR #2150 | The read side: catalog, indexer, announcements, sources |
| `specs/2026-07-24-jinn-execution-recorder-design.md` | PR #2150 | Producer-side conventions |
| `specs/2026-07-24-jinn-attestation-issuer-design.md` | PR #2150 | Producer-side conventions, DSSE handling |
| `specs/2026-07-25-jinn-local-evidence-runtime-design.md` | PR #2150 | How composition roots are written |
| `docs/engineering/handbook.md` | local | Work shapes, TDD expectations, review gates |

Read the publication design closely even though it is not your item. It is the reference for the
level of argument expected: every choice justified, every rejected alternative named with its
reason, and every guarantee stated at the strength it can actually be held to.

## 4. Where the work lives

The design work from the previous session was created outside `next`. The implementation
foundation records the clean base and import procedure without relying on a particular workstation
path or dirty checkout.

**Legacy prior art, on `next` today:**

| Path | Lines | What it is |
| --- | --- | --- |
| `packages/layer/src/publish.ts` | 1,710 | The incumbent publish pipeline — recovery, batching, anchoring, and much that is not publication |
| `packages/core/src/scrub/` | 6,839 across 35 files | The secret-detection and redaction engine |
| `packages/layer/src/ipfs-cid.ts` | 169 | Strict canonical CIDv1 raw sha2-256 parsing and validation |
| `packages/indexer/src/ipfs.ts` | — | Ponder-side IPFS fetch |
| `client/src/adapters/mech/ipfs.ts` | — | Operator-side IPFS upload/download via the Autonolas gateway |

## 5. Reading the unmerged PR stack

The new evidence packages are not on `next`. They live in a stack of open PRs on
`Jinn-Network/mono`. To read any of them:

```bash
REF=$(gh pr view <PR> --json headRefOid --jq .headRefOid)

# list the tree
gh api "repos/Jinn-Network/mono/git/trees/$REF?recursive=1" --jq '.tree[].path' | rg 'packages/evidence'

# read one file
gh api "repos/Jinn-Network/mono/contents/<path>?ref=$REF" \
  | python3 -c 'import sys,json,base64; print(base64.b64decode(json.load(sys.stdin)["content"]).decode())'
```

PR #2161 has the most complete package set; use it when you want to see the whole stack at once.
PR #2150 carries the design and plan documents.

**Evidence-stack PRs:** #2091–#2095 (protocol), #2122–#2125 (repository + fs + OCI),
#2142–#2145 (execution recorder), #2150 (designs), #2151–#2154 (catalog, indexer, announcements,
CI), #2157 (attestation issuer), #2158 (SQLite catalog), #2159 (announcement journal),
#2160–#2161 (local runtime), #2167 (consolidation plan), #2168 (architecture guard test).

## 6. Ownership map — what owns what today

Package names are given at their **post-consolidation** home, since the consolidation plan is a
precondition for new work. Pre-consolidation equivalents are noted where they differ.

| Package | Layer | Owns | Pre-consolidation name |
| --- | --- | --- | --- |
| `evidence-protocol` | Semantics | Record families, conformance, digests, integrity, canonical serialization | same |
| `execution-recorder` | Producer | Execution Evidence written from a run | same |
| `attestation-issuer` | Producer | Result Evaluation and Execution Verification statements; DSSE prepare/commit; the `DsseSigner` port | same |
| `evidence-repository` | Contract + fs binding | Exact-byte put/get by digest | `evidence-repository` + `evidence-repository-fs` |
| `evidence-repository-oci` | Binding | ORAS/OCI registry storage | same |
| `evidence-discovery` | Contract + Pipeline | Catalog projections, `EvidenceRecordAnnouncement`, `AnnouncementSource`, indexer, local announcement journal | `evidence-catalog` + `evidence-indexer` + `evidence-announcement-journal` |
| `evidence-catalog-sqlite` | Binding | Durable catalog on `better-sqlite3` | same |
| `evidence-local-runtime` | Composition | Local deployment wiring | same |
| `publication` | Pipeline | `AnnouncementSink` port, bundle pipeline, recovery journal | **designed, unimplemented** |

**Still missing, and the subject of these prompts:** derivation and the IPFS repository binding.

**Deliberately outside the substrate:** chain announcement sinks, EOA signers, and anything else
holding an operator credential. Those live under `client/`.

### 6.1 Signature verification — investigated and closed, do not re-open as substrate work

Recorded here because it looks like a gap twice over and is not one.

`evidence-protocol` already ships the tier-3 primitive from protocol §6.10, exported through the
barrel's `export * from "./claims.js"`: `dssePreAuthEncoding` and
`verifyDsseSignatures(envelopeBytes, verifier)`, returning a per-signature `DsseSignatureReport`.
The cryptographic check itself is an **injected** `DsseSignatureVerifier`, which is what keeps a
crypto library out of a package whose layer test requires zero runtime dependencies. On the write
side `attestation-issuer` ships the matching `DsseSigner`. Both halves exist.

Two things are genuinely absent, and both are **Phase B.1 (verifiability tier activation)** in
`CLAUDE.md`, not substrate completion:

1. **No `DsseSignatureVerifier` implementation exists** anywhere in the stack, so
   `verifyDsseSignatures` is uncallable in practice. Writing one is small but blocked: the protocol
   does not normatively pin a signature algorithm — §11's worked example uses Ed25519 — so choosing
   one is an identity-profile decision, not a binding author's.
2. **Nothing calls it, and the substrate structurally cannot.** Verification needs a public key,
   and resolving the right key for a claim is tier 4 (identity binding), which §6.10 places above
   the protocol and the layer architecture places in the still-unplaced Policy layer.

The substrate is therefore complete on this axis: it implemented tier 3, made the crypto injectable,
and stopped at the tier-4 boundary the protocol told it not to cross.

**Method note.** The first pass on this concluded the opposite, by grepping the protocol's
`index.ts` for symbol names. That file is a barrel of `export *` lines, so the grep matched nothing
and the absence was misread as a gap. Check modules, not barrels — see §9.5.

## 7. Non-negotiables for every session

- **No implementation.** The deliverable is a design document. Write an implementation plan only if
  the item prompt asks for one.
- **No cutover.** Do not wire `client/`, `packages/layer`, Autopilot, or the plugin. Do not touch
  `EpisodeV1`.
- **No protocol amendment.** If your design seems to need a change to `evidence-protocol`, stop and
  escalate rather than writing one.
- **No credentials in the substrate.** If your component needs a key to function, you have drawn
  the boundary in the wrong place.
- **American English**, per `CLAUDE.md` Rule 5 — `distill`, not `distil`.
- **Surgical scope.** Do not improve adjacent designs you happen to read.
- **Do not use bare letters for this rebuild's stages.** `CLAUDE.md` already owns phase letters
  (A.1–A.4, B.1–B.2, C, 2, 3) and they are canon. Earlier sessions used an unrelated A–E scheme for
  the rebuild's own stages, which collides — "Phase B" and "stage B" meant different things in the
  same sentence. Say **substrate completion**, **application bindings**, and **cutover**. Reserve
  letters for `CLAUDE.md` phases.

## 8. Deliverable shape

Write the design to `docs/superpowers/specs/2026-07-26-<topic>.md`, following the structure of the
publication design:

1. Header with date, status, scope, and an explicit out-of-scope list
2. The decision, stated in a paragraph
3. **What this package refuses** — the table
4. The substantive design sections
5. Errors and failure semantics
6. Testing, including the conformance kit if you define a port
7. Prior art — name every pattern you compose
8. Settled decisions, and any open questions you could not close

If the item prompt asks for a plan too, write it to `docs/superpowers/plans/2026-07-26-<topic>.md`
following `2026-07-25-evidence-publication.md`: numbered tasks, each with files, interfaces, a
failing test written first, implementation steps, verification commands, and a commit message.

## 9. Self-review before you finish

The previous session's design shipped with a real defect that survived several passes: the bundle
document was described as "a cross-operator wire artifact" and then assigned to sink-private
ownership, with **no reader named anywhere**. A second defect rode along with it — the word "batch"
collided with `AnnouncementBatch`, an existing read-side type with an unrelated meaning. Both were
caught only by going back and reading the consuming packages directly rather than trusting the
design's own account of them.

So before you declare a design done, run these checks explicitly and report what each one found:

1. **Every artifact your design produces — who reads it?** Name the reader, in a package. If the
   answer is "the thing that wrote it," you have a leak.
2. **Every name you introduce — does the stack already use it?** Grep the packages, not just your
   own document.
3. **Every boundary you draw — does it survive the layering rules?** Check your dependency edges
   against the layer architecture spec §2, and say which layer your component lands in and why.
4. **Every guarantee you state — can the weakest binding actually hold it?** If not, grade it.
5. **Every claim you make about another package — did you read that package's source?** Not its
   design document, and not only its barrel. A barrel of `export * from "./x.js"` lines contains
   none of the symbol names it exports, so grepping one for a symbol returns a false negative. This
   has already produced one wrong conclusion in this rebuild (§6.1). Grep the modules, or import
   the built package and enumerate its exports.

## 10. How this session will be evaluated

- The design's boundaries are stated as refusals, not just as inclusions.
- Every rejected alternative is named with the reason it was rejected.
- Every cross-package claim is grounded in source that was actually read.
- Guarantees are graded where the medium requires it.
- The §9 self-review was performed and its findings reported, including any that required changing
  the design.
- The document is executable: a competent implementer could write the plan from it without
  needing to re-derive any decision.
