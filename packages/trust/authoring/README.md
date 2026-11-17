# @jinn-network/trust-authoring

Production **authoring** of the Jinn native trust artifacts — the third layer of the trust family
(`spec/2026-08-07-native-identity-ceremony.md` §3).

| Package | Owns |
| --- | --- |
| `@jinn-network/trust-core` | primitives: canonical spellings, DSSE sealing, ceremony verification, policy-chain verification |
| `@jinn-network/trust-resolve` | verification-side composition: at-time binding resolution, anchor resolution, chain facts |
| `@jinn-network/trust-authoring` | artifact **production**: identity-store custody codec, ceremonies, key bindings, anchor submission, catalog + policy succession |

The dependency direction is one-way: `authoring` depends on `core`; `resolve` never depends on
`authoring`. Verification never gains signing capability.

## What it produces

- **Role custody** — `openRoleSigners` opens (or mints) the encrypted `jinn.native-role-identities/2`
  store the daemon boots from, and returns per-role `DsseSigner`s. It NEVER clobbers: an existing
  store is opened, never rewritten, and a concurrent first-create is settled by an exclusive hard
  link. `openCatalogAuthority` is the same custody for the dedicated policy-signing key (§5), in its
  own file under its own store-format tag.
- **Ceremonies** — `performEoaCeremony` builds and EIP-191-signs the profiled SIWE message.
  `message.address` is always the actual signer; a settlement-scoped binding's ceremony declares the
  service Safe as a third `did:pkh` resource (§2.3b) instead of pretending the Safe signed, and the
  final resource commits to the binding's terms (`urn:jinn:trust:binding-terms:v1:sha256:…`,
  `ceremony-currency/v1` §2).
- **Bindings** — `authorRoleBinding` seals the self-signed `KeyBinding`, vouched by the ceremony EOA,
  scoped from the role's record families, anchored on-chain; `roleBindingTerms` derives the terms a
  role's ceremony commits to.
- **Anchors** — `submitAnchor` writes the calldata anchor and returns the block time;
  `waitForFinalizedAnchor` polls the injected reader until it reads back finalized.
- **Catalog** — `authorCatalog` (genesis, refuses to overwrite), `appendOperator` (late join:
  append + hash-linked policy successor, genesis digest unchanged), `sealPolicySuccessor` (refresh
  and authority rotation).
- **Re-authoring**: `authorCatalog` given `previousCatalogPath`, the catalog it replaces, writes every
  revocation that catalog holds verbatim, with the binding each names and the anchors both reference,
  so no retired key binds again. It refuses, writing nothing, a revocation it cannot carry intact, an
  anchor declared differently from the replaced catalog, and a binding of a key a carried revocation
  retired. `revocationsToCarry` and `assertNoRetiredKeyBound` run the same checks before an anchor.
- **Role key rotation**: two acts, each under its own fresh anchor, in this order. `rebindRoles`
  appends replacement bindings for new keys, authored by `authorRoleBinding` under the same voucher.
  Then `planRevocation` checks the voucher can revoke the retiring bindings and names the act's
  `revocation-anchor/v1` digest (`revocationAnchorDigest`), and `revokeBinding` seals and appends one
  revocation per retiring binding. Neither seals a policy successor: the policy names Agent IRIs,
  and a rotation keeps them.

## Sequencing law (§6), enforced where it can be

1. **Anchor first.** `validFrom` must be the anchor's block time, and `submitAnchor` is the only
   thing that knows it.
2. **`validFrom` is the VERBATIM string** `submitAnchor` returned — the resolver compares these
   timestamps lexicographically, so `…00Z` vs `…00.000Z` changes outcomes. `authorRoleBinding`
   refuses a binding whose `validFrom` is not the ceremony's own `issuedAt`.
3. **Complete purposes.** `completePolicyPurposes` emits every `native:<role>`, BOTH admission
   spellings, and `evaluator-eligibility`. A missing purpose is a boot refusal, not a degraded mode.
4. **Wait for `finalized`** before declaring success.
5. **A catalog rewrite means a daemon restart.**

## What it deliberately does not do

No RPC configuration (clients are injected as narrow structural ports), no password handling (the
caller supplies it), no config write-back (the `jinn ceremony` CLI owns that), and no network
selection — the calldata profile literal is `base-sepolia-calldata-v1`, matching the catalog schema's
single admitted profile. A future chain is a new profile, not a parameter.

**Who signs a revocation.** `revokeBinding` takes the target binding's **voucher account**, the
ceremony EOA that `authorRoleBinding` named as the binding's `did:pkh` voucher, and signs through
`voucherAccountSigner`: `revokedBy` and the DSSE `keyid` are that `did:pkh`, and the signature is a
65-byte EIP-191 `personal_sign` over the DSSE pre-authentication encoding. It never takes the catalog
authority. The signer signs revocations and nothing else, and refuses a signature that does not
recover to the voucher's address; `revokeBinding` refuses, before signing, a voucher that is not
every target's voucher. Under [key authority section 8](https://github.com/Jinn-Network/spec/blob/main/documents/profiles/key-authority/v1/specification.md)
a revocation counts only from the voucher account, from the bound key itself when its record holds
`bindings` scope, or from a standing `bindings` key of the Agent. No native role binding holds
`bindings` scope, so neither the bound key nor any other role key of the Agent can revoke one, and
the voucher account is the one signer whose revocation of a native role binding has effect. The
catalog authority's key holds no binding to any Agent, and a revocation it signed would revoke
nothing.

**Why the rebind comes first.** A replacement binding draws its authority from a binding of the same
Agent under the same voucher that stands at the replacement's effective start (key authority
section 7). Rebound first, the replacement draws on the binding it replaces, and the later
revocation takes nothing back (section 6). Revoked first, an Agent whose only binding was the
retired one, as an admission Agent's is, has no authority left, and its replacement fails the
consent chain; `rebindRoles` refuses that order.

**What rotation cannot do.** The voucher account is the only account that can revoke the bindings
it vouched for, and it can vouch for new keys of the same Agent. If that account's key is the one
compromised, a rotation by the same account cannot shut its holder out: each side can revoke and
rebind what the other binds. A binding under a new account needs consent from a `bindings` key of
the Agent, and no native role binding holds one. What remains lies outside rotation: the catalog
authority seals a policy successor that no longer accepts the Agent IRI, and the operator
provisions a new Agent IRI under a new account (ceremony spec §7).
