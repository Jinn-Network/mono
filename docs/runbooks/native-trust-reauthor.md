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

### Reuse or mint: state the choice, record the reason

A re-author touches no key, store, or Agent IRI, so all five terms of the `ceremony-anchor/v1`
preimage are unchanged and the digest is **identical** to the original ceremony's. Ceremony spec
§3.2b requires this runbook to state which anchor the re-author takes and the operator to record
why. State first what the CLI actually does, because it is not what the choice suggests:

**There is no supported re-author path today.** `jinn ceremony init` refuses the moment the
catalog exists — "a trust catalog already exists …; genesis never overwrites"
(`operator/src/cli/commands/ceremony.ts:949-966`). `join` refuses the re-author too, though for
a different reason: it is built to append to an existing catalog, so what stops it is this
operator's own run receipt, which makes it refuse rather than append a second set of bindings
for the same operator (`:1224` → `:840-862`). There is no `--force` on either. So "re-run the
existing ceremony" above does not run: it stops at a guard and mints nothing.

**Any path past the guard reuses the original anchor, silently.** The only way through is to
move the existing catalog aside. Doing that leaves the run receipt in place — it lives at
`<dir>/ceremony/receipt.json` (`:266-270`), not in the catalog — so the re-run recomputes the
identical digest, `reusableAnchor` matches it (`:333-349`), and the ceremony resumes onto the
**already-mined** anchor, reporting `ceremony_anchor_reused` (`:1002`). The operator gets reuse
without choosing it.

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
