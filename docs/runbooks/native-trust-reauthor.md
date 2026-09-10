# Re-authoring a native trust catalog after a role-scope widening

When a native role's entry in `NATIVE_ROLE_IDENTITY_REQUIREMENTS` gains a scope, every catalog
authored before that change becomes unbootable for that role. This runbook is the recovery.

It was written for one specific widening — the three `*-discovery` roles gaining
`jinn:discovery-announcements` (issue #2525) — but nothing below is specific to that scope.

## Why a widening breaks an existing catalog

A role's scope list is signed *inside* the KeyBinding envelope, and it is checked in two places at
boot: `RoleIdentitySet.open` compares the resolved binding's `scope` against the requirements table
and refuses on any missing entry (`native role "<role>" binding lacks required <scope> scope` —
pinned by `operator/test/daemon/role-identities.test.ts`), and `verifyRoleBinding` then runs trust-core
§7.5 once per required family. Neither reads the requirements table from the catalog, so an old
catalog and new code disagree, and the daemon fails closed.

The failure is loud and immediate, at boot, naming the role and the missing scope. There is no
silent-degradation window.

## What is NOT required

- **Not new keys.** The did:keys are unaffected; only the signed bindings that describe them are.
- **Not new identity stores.** The encrypted role stores are reused as-is.
- **Not a new Agent IRI.** Operator identity is preserved, so no peer's configuration changes.
- **Not a policy successor.** Scope is not expressible in a trust-policy document — `TrustPolicy`
  carries `purposes[].accepted` and `requiredStrength` and nothing else. There is no way to widen a
  binding's scope without re-signing the binding.

## The operation

> **This procedure does not execute as written, and the defects run deeper than the anchor
> choice below.** `jinn ceremony init` refuses while the catalog exists
> (`operator/src/cli/commands/ceremony.ts:949-966`) and there is no `--force`, so the command
> below stops at a guard. Moving the catalog aside to get past it has consequences this runbook
> does not yet cover: `authorCatalog` seals a **version-1 genesis** rather than continuing the
> policy chain (`packages/trust/authoring/src/catalog.ts:198-215`), which moves
> `policyGenesisDigest` and fails every *other* operator closed against their pin
> (`operator/src/daemon/native-trust-catalog.ts:305-307`); and it writes only the re-authoring
> operator's bindings, so a shared catalog comes back single-operator. A **joined** operator has
> no path at all, since `join` needs the catalog it appends to. Only the anchor question below
> was in scope for DR-2026-09-06; **the rest of this procedure needs its own fix and does not
> have one yet.** A further defect lands once revocations exist: `authorCatalog` writes
> `revocations: []`, so a wholesale re-author un-revokes everything — see
> "Why wholesale, not `appendOperator`" below. Treat the steps below as a description of intent,
> not a runbook to execute, until that lands.

Re-run the existing ceremony against the same directory:

```
jinn ceremony <same arguments as the original run>
```

It is already idempotent on custody and requires no new tooling. Specifically:

- `mintCustody` **opens** an existing identity store rather than minting a fresh one, through the
  same exclusive-hard-link path production boot uses — so every role key is preserved.
- The Agent IRI is read back from the existing native config (falling back to the run receipt), so a
  re-run keeps the operator's identity.
- The catalog authority key is likewise reopened, so the policy chain continues rather than forking.

What the re-run does produce: fresh EIP-191 ceremony signatures and a rewritten `trust.json`.
Whether it also produces a **new on-chain anchor transaction** depends on the choice below, and
the default is that it does not: unless the receipt is moved aside, `reusableAnchor` matches and
`session.submit` is never called (`operator/src/cli/commands/ceremony.ts:976`, `:985`), so the
signatures are over the **original** anchor's block time — `validFrom` is assigned straight from
the reused locator (`:1029`) and handed to `authorBindings` as both `validFrom` and `issuedAt`
(`:1030-1036`, `:741`), which is what §6 law 2 requires be the same verbatim string. A new
transaction is sent only when the run receipt is moved aside as well. Read the next section
before running anything.

### Reuse or mint: state the choice, record the reason

A re-author touches no key, store, or Agent IRI, so all five terms of the `ceremony-anchor/v1`
preimage are unchanged and the digest is **identical** to the original ceremony's. The ratified
position is ceremony spec §3.2b's: the anchor MAY therefore be reused, and the reuse-vs-fresh
choice is a per-widening judgment "the runbook MUST state and the operator MUST record with its
reason"
([`spec/2026-08-07-native-identity-ceremony.md §3.2b:653`](../../spec/2026-08-07-native-identity-ceremony.md)).
Both anchors are reachable, and a single act decides which one you get. This section states the
choice and both options' costs; a proposed rule that would remove the judgment is marked as such
below. The procedure-level defects are flagged above and remain unowned.

**Neither verb runs the re-author today.** `jinn ceremony init` refuses the moment the catalog
exists — "a trust catalog already exists …; genesis never overwrites"
(`operator/src/cli/commands/ceremony.ts:949-966`). `join` refuses too, though for a different
reason: it is built to append to an existing catalog, so what stops it is this operator's own
run receipt (`:1221-1226` → `:840-870`), and all three of its conditions must hold — an operator
whose receipt is absent gets no refusal from `join`, it appends, which is the binding conflict
"Why wholesale, not `appendOperator`" warns about. There is no `--force` on either verb.

**Reuse, and the hazard that it arrives by default rather than by decision.** The only way
through the guard is to move the existing catalog aside. Doing that leaves the run receipt in
place — it lives at `<dir>/ceremony/receipt.json` (`:266-270`), not in the catalog — so the
re-run recomputes the identical digest, `reusableAnchor` matches it (`:333-349`), and the
ceremony resumes onto the **already-mined** anchor. The run does say so, on both surfaces —
`ceremony_anchor_reused` and `anchor reused <hash> at <time> (from a previous run's receipt)`
(`:1002`, `:1010`) — so this is not silent. Nothing refuses it either. Reuse is therefore also
what happens to an operator who moves the catalog and forgets the receipt, which is why it must
be taken as a decision and recorded as one. Its benefit is that it preserves the original
`validFrom` and effective window, so there is no coverage gap at all; its cost is retroactivity,
the *widened* scope claimed back over evidence signed before the widening, including evidence a
verifier refused at the time for want of that very scope.

**Taking the fresh anchor.** Move `<dir>/ceremony/receipt.json` aside as well as the catalog, so
that `reusableAnchor` finds nothing. The re-authored bindings then carry the new anchor's block
time and the widened scope is claimed only from the moment it was widened. The cost is a
coverage gap between the old anchor time and the new one, and the gap is **wholesale**: because
the re-author rewrites the catalog and §6 law 2 gives *every* re-authored binding the new
anchor's block time, evidence signed inside that window de-attributes for **every role**, not
only the widened one. It resolves against neither the old bindings (replaced) nor the new ones
(not yet effective).

**A proposed rule would remove the judgment: mint fresh whenever the act's bindings change.** It
is **proposed**, not adopted, in
[`spec/2026-09-09-recoverable-binding-anchor.md`](../../spec/2026-09-09-recoverable-binding-anchor.md)
§6, which argues it from non-retroactivity of authority and shows that under the successor
preimage it stops being a judgment and becomes a mechanism. Until that document is adopted, the
currently ratified `ceremony-anchor/v1` still carries ceremony spec §3.2b's MUSTs above — state
the choice, record the reason — so record one whichever anchor you take.

Under the proposed rule, moving the receipt aside stops being optional, which would put the
following footgun on the on-path procedure rather than beside it. Read it before moving
anything, whichever anchor you take.

  > **Before moving the receipt aside, confirm the native config carries `agentIri` — and
  > `admissionAgent`, if this operator provisions admission.** The receipt is the *fallback*
  > source for both: identity resolution prefers the config and falls back to the receipt, and
  > if neither has them it **mints a fresh `urn:uuid:`**
  > (`operator/src/cli/commands/ceremony.ts:376-389`). With both the config keys and the receipt
  > gone, the re-author silently becomes a re-mint — a new operator identity, every peer's
  > configuration invalidated — which is precisely what this runbook exists to avoid. The
  > dangerous state is the one `refuseConfigWriteBackPending` flags: sealed on chain, config
  > write-back never completed. There the receipt is the *only* record of the Agent IRI, and
  > moving it aside destroys it. Copy it somewhere, do not delete it.

Because making that step mandatory promotes this failure onto the on-path procedure, the proposed
ruling carries one implementation requirement with it — a refusal on the re-author path when the
Agent IRI is recoverable from neither the native config nor an accessible receipt, rather than a
silent re-mint. It is specified at
[`spec/2026-09-09-recoverable-binding-anchor.md`](../../spec/2026-09-09-recoverable-binding-anchor.md)
§6.5, which names it as a follow-up with no owner and as a blocker on the ruling's *execution*
rather than on its adoption.

**What to write into the re-author's record.** Four things whichever anchor you took:

- the scope change, and the code change that caused it;
- the **transaction hash of the anchor the resulting catalog references** — the freshly minted one
  or the reused one. Writable on both paths, and the only item that identifies which on-chain
  anchor the catalog is standing on; without it a reuse re-author's record does not say;
- the **reason** for the anchor you took. Ceremony spec §3.2b's MUST is unretired: the proposed
  ruling would replace it with fixed contents only once adopted, so until then write it;
- explicitly whether the receipt was moved aside, since that single act is what decides which
  anchor you got.

If you minted fresh, add the three items that presuppose one — the rest of what
[`spec/2026-09-09-recoverable-binding-anchor.md`](../../spec/2026-09-09-recoverable-binding-anchor.md)
§6.4 would make the fixed record contents, its fourth being the scope change already above:

- the fresh anchor's block time (its transaction hash is already in the unconditional list above);
- the outgoing anchor's transaction hash and block time;
- the resulting window `[old anchor time, new anchor time)`, stated explicitly as a window in
  which evidence de-attributes **for every role**, not only the widened one.

None of the three is writable under reuse: nothing is minted, nothing goes out, and there is no
window — the original `validFrom` is preserved, which is exactly the retroactivity that is reuse's
cost. That is why the transaction hash of the anchor the catalog references sits in the
unconditional list above rather than here: under reuse it is the *incoming* anchor's hash, and it
is writable.

The retroactive-authority question these answer is left open at ceremony spec §10 (e) and owned
by [#4172](https://github.com/Jinn-Network/mono/issues/4172), whose output is the document
above.

## Why wholesale, not `appendOperator`

Do **not** try to append the re-authored bindings to the existing catalog. `appendOperator` is
additive, so the old narrow-scope binding would remain alongside the new wide-scope one for the same
`(key, agent)` pair — which is precisely a binding conflict. `createBindingResolver` reports it and
`openNativeTrustCatalog` refuses with `conflicting bindings for <key> and <agent>`, leaving the
operator no better off. `authorCatalog`, which the ceremony command uses, rewrites the catalog and
does not have this problem.

It has a different one, and it belongs on the defect list at the top of this runbook.
`authorCatalog` writes `revocations: []` (`packages/trust/authoring/src/catalog.ts:216`), so a
wholesale re-author **un-revokes everything**. `appendOperator` does not have this problem — it
rewrites around the loaded file and preserves `revocations` — so this is specific to the verb the
ceremony command actually uses. Jinn cannot author a revocation yet (`revokeBinding`'s body is
unimplemented, ceremony spec §3.2, §9), though a hand-written catalog entry resolves today because
the schema carries `revocations` and the opener honors them. DR-2026-09-06 does not itself make
revocations authorable; it unblocks the §9 rotation follow-up that will. Either way this procedure
needs its own fix before the first revocation exists.

## Cost and sequencing

Per operator: a finality wait and a daemon restart. On the reuse path there is no anchor
transaction — the wait still runs (`operator/src/cli/commands/ceremony.ts:1014`, unconditional)
but resolves at once against an already-finalized anchor. Minting fresh adds one anchor
transaction and a real finality wait. Nothing else.

The window between deploying the code change and completing the re-run is a **hard boot refusal**,
not a degradation. Sequence accordingly: on a shared deployment, re-author before rolling the code,
or accept the downtime deliberately.

## Verification

After the re-run, before restarting the fleet:

1. The daemon boots — `RoleIdentitySet.open` is the check that was failing.
2. Cross-operator discovery resolves. The pinned regression for this is
   `operator/test/daemon/trust-authoring-round-trip.test.ts` ("cross-operator discovery key resolution
   over a real catalog"), which drives `createTrustAdapter(...).keys.resolve` over a two-operator
   authored catalog and asserts the discovery keys come back rather than an empty array.
