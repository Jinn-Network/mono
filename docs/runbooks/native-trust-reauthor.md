# Re-authoring a native trust catalog after a role-scope widening

When a native role's entry in `NATIVE_ROLE_IDENTITY_REQUIREMENTS` gains a scope, every catalog
authored before that change becomes unbootable for that role. This runbook is the recovery.

It was written for one specific widening — the three `*-discovery` roles gaining
`jinn:discovery-announcements` (issue #2525) — but nothing below is specific to that scope.

## Why a widening breaks an existing catalog

A role's scope list is signed *inside* the KeyBinding envelope, and it is checked in two places at
boot: `RoleIdentitySet.open` compares the resolved binding's `scope` against the requirements table
and refuses on any missing entry (`native role "<role>" binding lacks required <scope> scope` —
pinned by `client/test/daemon/role-identities.test.ts`), and `verifyRoleBinding` then runs trust-core
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

What the re-run does produce: one **new on-chain anchor transaction**, fresh EIP-191 ceremony
signatures over the new anchor's block time (§6 law 2 requires `validFrom`, the ceremony's
`issuedAt`, and the anchor block time to be the same verbatim string), and a rewritten `trust.json`.

## Why wholesale, not `appendOperator`

Do **not** try to append the re-authored bindings to the existing catalog. `appendOperator` is
additive, so the old narrow-scope binding would remain alongside the new wide-scope one for the same
`(key, agent)` pair — which is precisely a binding conflict. `createBindingResolver` reports it and
`openNativeTrustCatalog` refuses with `conflicting bindings for <key> and <agent>`, leaving the
operator no better off. `authorCatalog`, which the ceremony command uses, rewrites the catalog and
does not have this problem.

## Cost and sequencing

Per operator: one anchor transaction plus its finality wait, and a daemon restart. Nothing else.

The window between deploying the code change and completing the re-run is a **hard boot refusal**,
not a degradation. Sequence accordingly: on a shared deployment, re-author before rolling the code,
or accept the downtime deliberately.

## Verification

After the re-run, before restarting the fleet:

1. The daemon boots — `RoleIdentitySet.open` is the check that was failing.
2. Cross-operator discovery resolves. The pinned regression for this is
   `client/test/daemon/trust-authoring-round-trip.test.ts` ("cross-operator discovery key resolution
   over a real catalog"), which drives `createTrustAdapter(...).keys.resolve` over a two-operator
   authored catalog and asserts the discovery keys come back rather than an empty array.
