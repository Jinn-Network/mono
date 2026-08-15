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
  service Safe as a third `did:pkh` resource (§2.3b) instead of pretending the Safe signed.
- **Bindings** — `authorRoleBinding` seals the self-signed `KeyBinding`, vouched by the ceremony EOA,
  scoped from the role's record families, anchored on-chain.
- **Anchors** — `submitAnchor` writes the calldata anchor and returns the block time;
  `waitForFinalizedAnchor` polls the injected reader until it reads back finalized.
- **Catalog** — `authorCatalog` (genesis, refuses to overwrite), `appendOperator` (late join:
  append + hash-linked policy successor, genesis digest unchanged), `sealPolicySuccessor` (refresh
  and authority rotation).

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

`revokeBinding` is designed here and implemented in a follow-up (§3.3): its surface is fixed so
rotation needs no schema change.
