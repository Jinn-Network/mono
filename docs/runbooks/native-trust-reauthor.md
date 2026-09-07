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
> have one yet.** Treat the steps below as a description of intent, not a runbook to execute,
> until that lands.

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
the default is that it does not: on the only path that runs, `reusableAnchor` matches and
`session.submit` is never called (`operator/src/cli/commands/ceremony.ts:976`, `:985`), so the
signatures are over the **original** anchor's block time — `validFrom` is assigned straight from
the reused locator (`:1029`) and handed to `authorBindings` as both `validFrom` and `issuedAt`
(`:1030-1036`, `:741`), which is what §6 law 2 requires be the same verbatim string. A new
transaction is sent only when the run receipt is moved aside as well. Read the next section
before running anything.

### Reuse or mint: state the choice, record the reason

A re-author touches no key, store, or Agent IRI, so all five terms of the `ceremony-anchor/v1`
preimage are unchanged and the digest is **identical** to the original ceremony's. Ceremony spec
§3.2b requires this runbook to state which anchor the re-author takes and the operator to record
why. This section settles **only** that question; the procedure-level defects are flagged above
and remain unowned.

**Neither verb runs the re-author today.** `jinn ceremony init` refuses the moment the catalog
exists — "a trust catalog already exists …; genesis never overwrites"
(`operator/src/cli/commands/ceremony.ts:949-966`). `join` refuses too, though for a different
reason: it is built to append to an existing catalog, so what stops it is this operator's own
run receipt (`:1221-1226` → `:840-870`), and all three of its conditions must hold — an operator
whose receipt is absent gets no refusal from `join`, it appends, which is the binding conflict
"Why wholesale, not `appendOperator`" warns about. There is no `--force` on either verb.

**Any path past the guard reuses the original anchor, by default rather than by decision.** The
only way through is to move the existing catalog aside. Doing that leaves the run receipt in
place — it lives at `<dir>/ceremony/receipt.json` (`:266-270`), not in the catalog — so the
re-run recomputes the identical digest, `reusableAnchor` matches it (`:333-349`), and the
ceremony resumes onto the **already-mined** anchor. The run does say so, on both surfaces —
`ceremony_anchor_reused` and `anchor reused <hash> at <time> (from a previous run's receipt)`
(`:1002`, `:1010`) — so this is not silent. It is unchosen: nothing asked the operator which
anchor they wanted, and the answer follows from a file they moved for an unrelated reason.

The two options, and how to actually take each:

- **Reuse the existing anchor** — what happens by default on any path that runs at all, and
  permitted by §6 law 1 because the digest matches. It preserves the original `validFrom` and
  effective window, so there is no coverage gap. The cost is retroactivity: the *widened* scope
  is claimed back over evidence signed before the widening, including evidence a verifier
  refused at the time for want of that very scope.
- **Mint a fresh anchor** — requires moving `<dir>/ceremony/receipt.json` aside as well as the
  catalog, so that `reusableAnchor` finds nothing. The re-authored bindings then carry the new
  anchor's block time and the widened scope is claimed only from the moment it was widened. The
  cost is a coverage gap between the old anchor time and the new one: evidence signed inside
  that window resolves against neither the old bindings (replaced) nor the new ones (not yet
  effective).

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

Neither is right in general — it is a retroactive-authority judgment, left open at ceremony spec
§10 (e) and owned by [#4172](https://github.com/Jinn-Network/mono/issues/4172). Whichever is
taken, **write the reason into the re-author's record** alongside the anchor transaction hash,
and state explicitly whether the receipt was moved aside, since that single act is what decides
it.

## Why wholesale, not `appendOperator`

Do **not** try to append the re-authored bindings to the existing catalog. `appendOperator` is
additive, so the old narrow-scope binding would remain alongside the new wide-scope one for the same
`(key, agent)` pair — which is precisely a binding conflict. `createBindingResolver` reports it and
`openNativeTrustCatalog` refuses with `conflicting bindings for <key> and <agent>`, leaving the
operator no better off. `authorCatalog`, which the ceremony command uses, rewrites the catalog and
does not have this problem.

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
