# Native Identity Ceremony — production trust-artifact provisioning

**Version:** 0.4 (§3.2b amendment — the anchor target policy and anchor digest content,
per DR-2026-09-06; v0.3 added §3.2a — the authored role → scope map and the #2527
announce-plane ruling; v0.2 revised v0.1 per independent design review, see §10 review
record)

**Date:** 2026-08-07

**Author:** Jinn contributor

**Shape:** `design`

**Status:** proposed — charters the identity-provisioning dependency of the DR-2026-08-05
gate (umbrella [#2461](https://github.com/Jinn-Network/mono/issues/2461)); operator ruling
2026-08-07: build the proper architecture, not an expedient script

**Scope:** the production path that CREATES the trust artifacts the one-swap native fleet
daemon verifies — role-identity stores, the shared trust catalog, the on-chain anchor — plus
one trust-layer amendment (the settlement-authority association) that provisioning cannot
proceed without. Register and vocabulary follow the trust-layer design
([`docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md`](../docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md)).

**Out of scope:** revocation/rotation implementation (surface designed here, execution
deferred to a follow-up issue), catalog distribution beyond file copy, mainnet provisioning
(DR-2026-08-05 decision 8: native mode refuses mainnet), Sybil economics, HSM custody.

---

## 1. Motivation: the verification/production asymmetry

The one-swap native estate shipped a complete trust **verification** layer and no production
path to **create** what it verifies.

What exists, verify-side:

- `client/src/daemon/role-identities.ts` — encrypted per-role Ed25519 custody
  (`IdentityStore`, store format `jinn.native-role-identities/2`), and `RoleIdentitySet.open`,
  which refuses to boot any role whose key lacks an effective-time, policy-scoped,
  non-revoked binding (`role-identities.ts:466-542`).
- `client/src/daemon/native-trust-catalog.ts` — `openNativeTrustCatalog`, which fail-closed
  parses the `jinn.native-trust-catalog/2` file, verifies the hash-linked policy chain
  against a pinned genesis digest, requires every binding's anchor to read back **finalized**
  from the canonical chain reader, and exposes the `NativeTrustAuthority` every native
  component authorizes through.
- `packages/trust/core` + `packages/trust/resolve` — the primitives (DSSE sealing, SIWE
  ceremony verification, policy chains) and the at-time binding resolver.

What exists, produce-side: **e2e fixtures only.**
`client/test/e2e/fixtures/native-fleet/{identity,trust-catalog,config,anchor}.ts` mint
stores, author catalogs, and submit fork anchors — by shadow-implementing the production
formats byte-for-byte (`identity.ts:11-16` says so explicitly). The gap stayed invisible
precisely because the fixtures are good: every e2e leg passes, so nothing ever exercised the
question "how does a real operator get these files?"

The consequences, verified on the current tree:

- The config surface is complete (`client/src/config/native-sections.ts` accepts `agentIri`,
  `identityStores`, `trustRootsPath`, `trustPolicyGenesisDigest`, and the rest) but the
  loaders validate **format only** — nothing creates the files those paths point at.
- The only production keygen is `jinn native-vertical identity`
  (`client/src/cli/commands/native-requester.ts:131-185`): it mints a store and prints
  `role → did:key` ids. It authors no binding, no policy, no anchor — a store alone is a set
  of keys no catalog accepts.
- The real operators (Base Sepolia services 72 and 75) have OLAS earning identities (agent
  EOA + service Safe) and **no native identities**. The DR-2026-08-05 gate (G-loop: a
  natively-posted task solved by a second operator) cannot run.

This spec resolves the asymmetry with three deliverables: a trust-layer amendment (§2), an
authoring package (§3), and an operator-facing ceremony CLI (§4), governed by §5 and the
normative sequencing law in §6.

## 2. The settlement-authority association amendment

### 2.1 The shipped check is defective — stated plainly

`NativeTrustAuthority.verifyOnchainAuthority` (`native-trust-catalog.ts:411-429`) is the
check that binds an on-chain settlement address to the agent claiming a settlement. As
shipped, it compares the ceremony's `message.address` — the SIWE "sign in with your Ethereum
account" line — to the settlement address under verification:

```ts
const ceremonyAddress = resolved?.ceremonyEvidence?.message.address;
if (ceremonyAddress === undefined || ceremonyAddress.toLowerCase() !== value.address.toLowerCase()) {
  throw new NativeTrustCatalogError(`settlement authority ${value.key} is not ceremony-bound to ${value.address}`);
}
```

But the settlement address in production is a **service Safe** — a contract account — and a
Safe cannot produce the EIP-191 signature the ceremony leg requires. The catalog hard-refuses
non-EOA ceremonies twice over: `parseBinding` rejects any `ceremony.type !== 'eoa'`
(`native-trust-catalog.ts:159-161`), and the witness verifier is closed
(`CLOSED_WITNESS_VERIFIER`, `:179-183`: "Phase B file trust catalog admits only
offline-verifiable EOA ceremonies"). So a ceremony whose `message.address` names the Safe can
only verify if an **EOA pretending to be the Safe** signed it — which is exactly what the e2e
rig does: the ceremony account and the "Safe" are the same Anvil EOA
(`client/test/e2e/native-fleet-loop.ts:88,114,118` — `ceremonyAccount: account`,
`aSafeAddress: account.address`). The rig's conflation is the only reason the check has ever
passed. For a real operator whose Safe is a contract, the check is unsatisfiable.

One mitigating fact, and the reason this amendment is cheap **now** and expensive later: **no
production catalog exists.** This check has never verified a real artifact; every catalog it
has ever opened was a fixture. There is no live-artifact migration burden — the amendment
changes what future catalogs say and what the verifier demands, and nothing deployed breaks,
because nothing deployed exists. After the gate run, every deployed operator would carry a
sealed, anchored binding whose ceremony bytes are immutable; amending then means re-running
every ceremony and re-anchoring. This is why the amendment lands before, not after, the first
production ceremony.

### 2.2 The honest chain of custody

The design replaces the address-equality fiction with the chain of custody that actually
exists:

```
role key K  ←(DSSE self-signature on the sealed KeyBinding
              + EOA SIWE ceremony over [agent, K, safe])—  agent EOA E
agent EOA E ←(on-chain Safe ownership: Safe.isOwner(E))—   service Safe X
```

Each link is independently verifiable: the first offline forever from the ceremony bytes
(`packages/trust/core/src/ceremony.ts` — `verifyEoaCeremony` recovers the EIP-191 signer and
requires it to equal the binding's voucher account), the second from chain state.

### 2.3 Normative changes

**(a) `message.address` is always the actual signer.** The SIWE ceremony message's `address`
field names the agent EOA that produces the EIP-191 signature — never a contract account,
never any address that did not sign. This is already what `verifyEoaCeremony` implies (the
recovered signer must equal the voucher's `did:pkh` account, and the binding's voucher IS the
EOA), and what `verifyReCapCeremony` enforces explicitly (`ceremony.ts` — "the ceremony
evidence must not lie about who signed it"). The amendment makes it a stated invariant for
EOA key-binding ceremonies too.

**(b) The service Safe becomes a third declared resource.** The profiled EOA key-binding
ceremony's `resources` array (trust design §7.2: `[Agent IRI, did:key URI]`) gains, for
settlement-scoped bindings, a third entry naming the settlement authority:

```
Resources:
- <Agent IRI>
- <did:key of the role key>
- did:pkh:eip155:84532:<EIP-55 checksummed Safe address>
```

The URI scheme is `did:pkh` — the trust design's canonical spelling for Safe/EOA accounts on
an EVM chain (§5 identity table: `did:pkh:eip155:<chainId>:0x<EIP-55-checksummed>`), produced
by trust-core's own `didPkh` helper (`packages/trust/core/src/spellings.ts:71`). No new
grammar is introduced.

Cardinality is strict: bindings whose scope includes `settlements` (roles
`solver-settlement`, `evaluator-settlement` per `NATIVE_ROLE_IDENTITY_REQUIREMENTS`,
`role-identities.ts:39-49`) declare **exactly three** resources; all other role bindings
declare exactly two. The declared Safe rides inside the EIP-191-signed bytes:
`matchCeremonyContent` re-serializes the structured message and byte-compares it against
`messageBytes` before trusting any field (`ceremony.ts` — the §7.2 mandatory content match),
so the third resource is signed by the EOA and cannot be swapped after the fact.
`matchCeremonyContent` itself needs no change — it destructures only the first two resources
(`const [agentResource, keyResource] = ceremony.message.resources`) and the byte-equality
check already covers the rest.

**(c) `verifyOnchainAuthority` re-specified.** The check becomes (full replacement of the
`:411-429` body's semantics):

> `verifyOnchainAuthority({ key, agent, address, atTime, purpose })`:
>
> 1. Run the existing `verified()` pipeline unchanged (policy purpose, family
>    `settlements`, DSSE + ceremony + §7.4a consent-chain verification, freshness).
> 2. Resolve the binding at `atTime`; require `ceremonyEvidence` present.
> 3. Recover the ceremony's EIP-191 signer from
>    `(ceremonyEvidence.messageBytes, ceremonyEvidence.signature)`
>    (`recoverEip191Address`, trust-core). Require it to equal
>    `ceremonyEvidence.message.address` (the ceremony must not lie about its signer; the
>    `verified()` step has already required it to equal the binding's voucher account).
> 4. Require the ceremony's **third resource** to parse as
>    `did:pkh:eip155:84532:0x<address>` and its address to equal the `address` under
>    verification (case-insensitive comparison; authored as EIP-55). A settlement-purpose
>    binding with no third resource, or a mismatched one, refuses with a distinct error.
> 5. Read the chain **at verification time**: require
>    `Safe(address).isOwner(recoveredSigner) === true`. A `false` or a read failure
>    refuses (fail-closed), each with a distinct error.
> 6. Return `{ bindingDigest }`.

Step 5's read is current-state, not at-`atTime` — deliberately mirroring the recorded
precedent in `trust-resolve` (`binding-resolver.ts:30-37`: `ChainFactResolver.ownerOf` "reads
the registry's CURRENT owner, not the owner at `atTime`"; recorded as a finding, not silently
patched). The same finding is recorded here (§10, open question c).

**Where the read comes from.** The brief's premise that the call sites hold chain clients is
true one level up, not at the call sites themselves — verified as follows.
`buildNativeEvaluatorSubjectAuthority` (`native-evaluator-assembly.ts:207-250`) takes only
`{ roles, trust, safeAddress }`, and `client/src/native-consumer/trust.ts` is a pure adapter
over `NativeTrustAuthority`; neither holds a client. The compositions that build the `trust`
authority do: `buildFleetNativeRuntime` holds `input.publicClient` and already derives the
anchor client from it (`native-fleet-runtime.ts:295-301`), and the consumer's production
driver creates its own `PublicClient` and does the same
(`client/src/native-consumer/production.ts:68-70`, catalog open at `:70`). The seam is
therefore **`openNativeTrustCatalog`'s input**: it gains a **required**
`settlementOwnershipClient: { isOwner(safe: 0x…, candidate: 0x…): Promise<boolean> }` —
required, not optional, so every construction site must supply the read at compile time and
no site can leave a silent runtime hole. There are **four** production call sites, not two:
the fleet runtime (`native-fleet-runtime.ts:295`) and the consumer driver
(`native-consumer/production.ts:70`) hold a public client directly and construct the read
from it, using the Safe ABI the daemon already carries (`client/src/contracts/abis.ts:59-66`,
`isOwner(address) → bool`); the parallel native-main deployment path opens the catalog twice
more (`native-production-deployment.ts:399` and `:494`) and receives only
`infrastructure.anchorClient` from `NativeInfrastructurePrimitives` — no public client or
ownership primitive is surfaced there — so the amendment ALSO extends `openInfrastructure`
to surface the Safe-ownership read alongside the anchor client. That deployment path retires
at stage 5 per DR-2026-08-05, but it must compile and run until then. No new dependency, no
client threading through verification call sites.

**(d) ERC-1271 remains refused.** A contract signature's validity is a function of mutable
contract state: owners rotate, modules change, the contract upgrades — so an ERC-1271
"signature" that verified yesterday can be unverifiable today and vice versa. That is
retroactively mutable evidence, and it breaks the effective-time semantics the whole resolver
is built on (`effectiveStart = max(validFrom, anchorTime)`, revocations with effective
times). The EOA ceremony is offline-verifiable forever from its bytes; the Safe's role is
confined to the one link that is honestly chain-state-dependent (step 5), where the check
says so instead of laundering it through a signature. `CLOSED_WITNESS_VERIFIER` stays.

### 2.4 Migration

- **The e2e rig stops conflating.** `buildTwoOperatorNativeSetup` stops passing the ceremony
  EOA as `aSafeAddress`; the fork rig deploys a real 1-of-1 Safe owned by the ceremony EOA
  (the earning stack's Safe deployment helpers already run against the same fork) and passes
  its address. The settlement ceremony gains the third resource; `verifyOnchainAuthority`'s
  step 5 then exercises a real `isOwner` read on the fork.
- **Unit tests updated** wherever they authored two-resource settlement ceremonies or
  asserted the old address-equality message (`native-trust-catalog` and
  `native-evaluator-assembly` suites, the consumer's settlement-authority tests).
- **No live-artifact migration** — per §2.1, no production catalog exists to migrate. This is
  the whole reason the amendment is safe now.

## 3. `@jinn-network/trust-authoring` — the missing third layer

The trust family becomes three packages with one-directional flow:

| Package | Owns |
| --- | --- |
| `packages/trust/core` | primitives: canonical spellings, DSSE sealing, ceremony verification, policy-chain verification |
| `packages/trust/resolve` | verification-side composition: at-time binding resolution, anchor resolution, chain facts |
| `packages/trust/authoring` (new) | artifact **production**: identity-store custody codec, catalog authoring, anchor submission, policy succession |

`authoring` depends on `core` (sealing, digests, spellings) and optionally on `resolve` types
for round-trip tests; `resolve` never depends on `authoring`. The client already consumes
workspace trust packages, so it adds `@jinn-network/trust-authoring` the same way.

### 3.1 The store codec moves; the daemon's verification does not

The encrypted identity-store format (`StoredIdentitySetV3` inside the scrypt/AES-256-GCM
envelope) is today implemented **twice**: production (`role-identities.ts:101-452`) and
fixture shadow (`fixtures/native-fleet/identity.ts:32-135`) — proof that the format is a
shared artifact, not daemon-internal. The codec — envelope encrypt/decrypt, store
parse/validate, `IdentityStore` with its exclusive-link create and atomic rewrite — extracts
into `trust-authoring`'s `identity-store` module. `role-identities.ts` re-imports it and
keeps everything verification-side (`RoleIdentitySet`, binding checks, `merge`) unchanged.
The fixture's shadow copy deletes (§3.4).

### 3.2 Public surface

Signatures at the level of the other trust packages' type surfaces:

```ts
// ── custody ─────────────────────────────────────────────────────────────────
/** Opens (or, with create, mints) the encrypted role store and returns per-role
 * DsseSigners over the SAME loadOrCreate path production boot uses. NEVER clobbers:
 * an existing store is opened, never rewritten; a concurrent first-create is settled
 * by IdentityStore's exclusive hard-link (EEXIST → reread), so no interleaving
 * replaces existing key material. A store whose owned-role set differs from
 * `ownedRoles` refuses (the loader's own invariant). */
export function openRoleSigners(input: {
  readonly storePath: string;          // absolute
  readonly password: string;
  readonly ownedRoles: readonly NativeRoleIdentityRole[];
  readonly create: boolean;            // false → ENOENT is a refusal, not a mint
}): Promise<ReadonlyMap<NativeRoleIdentityRole, RoleSigner>>;

export interface RoleSigner {
  readonly role: NativeRoleIdentityRole;
  readonly keyId: string;              // did:key:z…
  readonly dsseSigner: DsseSigner;     // trust-core signer; private bytes never exposed
}

/** Dedicated catalog-authority custody (§5): same envelope format, one Ed25519 key,
 * its own file. Same never-clobber semantics. */
export function openCatalogAuthority(input: {
  readonly storePath: string;
  readonly password: string;
  readonly create: boolean;
}): Promise<{ readonly keyId: string; readonly dsseSigner: DsseSigner }>;

// ── ceremony + binding authoring ────────────────────────────────────────────
/** Builds and EOA-signs the profiled SIWE ceremony (§2.3a/b): message.address =
 * signer.address always; resources = [agent, didKey] plus, when settlementSafe is
 * given, didPkh(84532, settlementSafe). */
export function performEoaCeremony(input: {
  readonly signer: { readonly address: `0x${string}`;
    signMessage(m: { readonly message: { readonly raw: Uint8Array } }): Promise<`0x${string}`> };
  readonly agent: string;
  readonly didKey: string;
  readonly issuedAt: string;           // = validFrom = anchor block time (§6)
  readonly nonce: string;              // §7 nonce scheme
  readonly settlementSafe?: `0x${string}`;
}): Promise<EoaCeremonyEvidence>;

/** Seals one role binding: KeyBinding (voucher = didPkh of the ceremony EOA,
 * relationship 'controls', scope from NATIVE_ROLE_IDENTITY_REQUIREMENTS (§3.2a),
 * validFrom = anchor block time, anchors = [anchorDigest]), self-signed by the
 * role's DsseSigner. */
export function authorRoleBinding(input: { …see PR1… }): Promise<SealedBindingEntry>;

// ── anchoring ───────────────────────────────────────────────────────────────
/** Live base-sepolia-calldata-v1 anchor: sends `0x<digest-hex>` calldata to the
 * declared anchor target, returns { transactionHash, contractAddress, inputByteOffset,
 * anchorTime } with anchorTime = the mined block's timestamp. */
export function submitAnchor(input: {
  readonly walletClient: WalletClientLike;   // injected; package holds no RPC config
  readonly publicClient: PublicClientLike;
  readonly target: `0x${string}`;
  readonly digest: `sha256:${string}`;
}): Promise<AnchorLocator>;

/** Polls the injected finalized-anchor reader until the anchor reads back
 * finalized:true, or times out. On live Base Sepolia the `finalized` tag trails
 * ~10-20 minutes (see §6). */
export function waitForFinalizedAnchor(input: {
  readonly anchorClient: NativeFinalizedAnchorReadClient;   // the production reader
  readonly digest: `sha256:${string}`;
  readonly locator: AnchorLocator;
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<FinalizedAnchorObservation>;

// ── catalog authoring ───────────────────────────────────────────────────────
/** Genesis: seals the v1 TrustPolicy (complete purposes per §6 law 3 — every
 * `native:<role>`, both admission spellings, AND `evaluator-eligibility` — with
 * signerSet = the catalog authority, refreshBy per §5), the given bindings, and the anchor
 * declarations into a jinn.native-trust-catalog/2 file. Refuses to overwrite an
 * existing catalog path. */
export function authorCatalog(input: {
  readonly path: string;
  readonly authority: { readonly keyId: string; readonly dsseSigner: DsseSigner };
  readonly purposes: TrustPolicy['purposes'];
  readonly refreshBy: string;
  readonly bindings: readonly SealedBindingEntry[];
  readonly anchors: readonly AnchorDeclaration[];
}): Promise<{ readonly policyGenesisDigest: `sha256:${string}` }>;

/** Late join (§4 `join`): reads an existing catalog, appends new bindings + their
 * anchor, and seals a policy SUCCESSOR (predecessor = current newest digest,
 * version+1, purposes' accepted lists extended, same-or-updated signerSet, fresh
 * refreshBy) signed by the catalog authority. Genesis digest is unchanged by
 * construction — existing operators' pins stay valid. Atomic rewrite
 * (temp + rename); refuses if the on-disk catalog changed since read (digest
 * compare), so concurrent joins fail loudly instead of forking. */
export function appendOperator(input: { …catalogPath, authority, newBindings,
  newAnchor, refreshBy… }): Promise<{ readonly newestPolicyVersion: number }>;

/** Succession without membership change — the §5 refresh tool. */
export function sealPolicySuccessor(input: { … }): Promise<…>;

// ── designed, implementation deferred (follow-up issue) ─────────────────────
/** Seals a Revocation targeting a binding digest (schema + resolver support
 * already shipped: catalog schema `revocations`, native-trust-catalog.ts:57,77,
 * 298-306; binding-resolver applies anchored revocations at effective time), and
 * the rebind flow (revoke + authorRoleBinding for the replacement key + new
 * anchor). Surface fixed here so rotation needs no schema change. */
export function revokeBinding(input: { … }): Promise<…>;
```

### 3.2a Authored binding scope (normative amendment, ruled 2026-08-07)

`authorRoleBinding` seals each binding's `scope` from `NATIVE_ROLE_IDENTITY_REQUIREMENTS`
(`packages/trust/authoring/src/roles.ts`), which is the single source of truth and is the map
below. A scope is not a synonym for a trust-core record family: it is any entry some verifier
checks the binding under, and four of the nine roles carry one that is not a family at all.

| Role | Authored scope |
| --- | --- |
| `requester-submission` | `authorizations` |
| `admission` | `https://spec.jinn.network/trust-scopes/admission-receipts/v1` |
| `requester-discovery` | `observations`, `jinn:discovery-announcements` |
| `solver-delivery` | `deliveries` |
| `solver-settlement` | `settlements` |
| `solver-discovery` | `observations`, `jinn:discovery-announcements` |
| `evaluator-verdict` | `verdicts`, `deliveries` |
| `evaluator-settlement` | `settlements` |
| `evaluator-discovery` | `observations`, `jinn:discovery-announcements` |

**The discovery roles carry two scopes, and this ceremony is the document that was wrong.**
v0.2 mapped roles to trust-core record families alone, so the three `*-discovery` roles were
minted with `observations` only. The Record Discovery client will not treat a key as an
announcement signer unless its **binding** declares `jinn:discovery-announcements`
(`packages/discovery/client/src/trust-adapter.ts`, filtering on `DISCOVERY_SIGNING_SCOPE` from
`packages/discovery/protocol/src/identifiers.ts`; stack implementation program §7.11,
[`docs/superpowers/plans/2026-07-28-stack-implementation-program.md`](../docs/superpowers/plans/2026-07-28-stack-implementation-program.md)). No key
this ceremony minted could pass that filter, so `keys.resolve` returned an empty set and every
native head verified as `unauthorized-signer` — at any catalog, on any host. Confirmed against
the live DR-2026-08-05 gate catalog: all 14 bindings across both operators carried exactly one
scope, and none carried the announce plane.

The conflict between two ratified documents — this ceremony's §3.2 and program §7.11 — was
ruled **in favour of §7.11** ([#2527](https://github.com/Jinn-Network/mono/issues/2527)). The
discovery keys were already being used to sign announcements; their scope simply never said so,
so declaring it is strictly additive: nothing checked before is checked less, and
`RoleIdentitySet.open` runs one authority gate per required scope. The rejected alternative was
making `DISCOVERY_SIGNING_SCOPE` host-injectable so native could nominate `observations` as its
announcement scope — an interop divergence disguised as a config knob, with nothing downstream
able to detect the drift.

`admission` carries the admission-receipt trust scope rather than `authorizations` for the same
class of reason, under its own later ruling: every receipt verifier — the fleet evaluator, the
canonical marketplace-binding consumer, and the native consumer — checks the admission key's
binding under that scope, so an `authorizations`-scoped binding satisfied none of them.

**Widening a role's scope invalidates already-authored bindings.** `RoleIdentitySet.open`
refuses at boot, naming the role and the missing scope, until the catalog's bindings are
re-signed. Keys, identity stores and Agent IRIs are all preserved, so the recovery is a
re-author and not a re-mint —
[`docs/runbooks/native-trust-reauthor.md`](../docs/runbooks/native-trust-reauthor.md).

The map is pinned on both sides of the deliberate cross-tree literal duplication:
`packages/trust/authoring/src/roles.test.ts` pins every role's scope inside the trust tree, and
`operator/test/daemon/trust-authoring-round-trip.test.ts` imports both `DISCOVERY_SIGNING_SCOPE`
and the requirements table, asserts they agree, and drives a head one operator signed through
the other operator's `createTrustAdapter(...).keys.resolve` over a real authored catalog. That
second file is the poll-time coverage whose absence hid the conflict: the two-operator boot
test states outright that its trust double never reaches poll-time resolution, so until the
round-trip block was added nothing in the repository drove `keys.resolve` against a catalog
this ceremony actually mints.

### 3.2b Anchor target and anchor digest content (normative amendment, DR-2026-09-06)

**The anchor target is *declared*, not constrained; the anchor digest commits to the act it
anchors.** Two things this document left unsaid — what address an anchor transaction may be
sent to, and what its digest is a digest of — are settled here. The first is settled by
declining to constrain it. The second by pinning one preimage per ceremony act, byte for byte.

Which clauses are **protocol** (they cross in substance to the anchor-locator profile
document, authored in `Jinn-Network/spec` under DR-2026-09-03, when it is written): the target
is declared and unconstrained; both digest preimages and their canonicalization; R1–R5; the
exactly-one-anchor rule; the enforcement split. Which are **mono-side operational defaults**
(they do not cross): the self-send default, the `--anchor-target` flag, and the re-author
runbook's reuse-vs-fresh choice.

**The target is declared and unconstrained.** No protocol-wide anchor-target constant exists,
and none is created. `contractAddress` is a *consistency* field: it forces the locator's author
to declare the recipient and fails the read closed on mismatch
(`operator/src/daemon/native-base-sepolia-infrastructure.ts:1460`). It is not evidence. The
anchor surface owes exactly three properties — append-only writes, tamper-evidence, and a
consistent observable order
([`2026-07-27-trust-and-identity-layer-design.md`](../docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md):290-295)
— and a finalized Base Sepolia transaction supplies all three from the block, not from the
recipient. The transaction hash already identifies the transaction uniquely; the `to` address
contributes to none of the three.

A fixed constant would cost three things, in descending order of seriousness:

1. **It re-introduces the liveness coupling rule 4 forbids** (`:197-199`: "Identity must not be
   liveness-coupled … the capture-anchor incident lesson"). The bare-calldata anchor is named
   at `:292-295` precisely as the candidate that satisfies rule 4. A shared constant is a
   single external address every operator's identity creation depends on: if it holds code, an
   anchor carrying 32 arbitrary calldata bytes hits its fallback, a contract without an
   accepting fallback reverts, and the reader requires `receipt.status === 'success'`
   (`native-base-sepolia-infrastructure.ts:1458`). Fixing an address makes "can anyone create a
   native identity?" a function of that address's current code.
2. **It makes anchor validity mutable after the fact.** Any constraint phrased over chain state
   at the target — "MUST have no code", most obviously — can flip: an address with no code
   today can hold code tomorrow (`CREATE2`). A rule whose answer changes for an already-mined
   anchor is the defect §2.3d rejects for ERC-1271 ceremonies, and it would silently un-verify
   catalogs that booted yesterday.
3. **It buys nothing measurable.** An inert burn-address constant dissolves costs 1 and 2 and
   still purchases nothing: no `from` check exists, so it adds no attributability, and it makes
   anchors enumerable by scanning one address — which the catalog already provides by naming
   the transaction hash outright.

The **default** is the operator's own agent EOA
(`operator/src/cli/commands/ceremony.ts:640-644`), and the reason recorded inline there is
hereby the ratified reason, not merely an implementation choice: no external address to trust,
misconfigure, fund, or keep alive; a recipient that structurally cannot revert; gas paid by the
operator's own key. `--anchor-target` (`operator/src/cli/commands/ceremony.ts:73`, validated
at `:619-622`, help text at `:1575`) stays, and is an override of a default rather than an
escape from a rule. The only anchor-target constant in the tree is the e2e fixture's own test
target (`operator/test/e2e/fixtures/native-fleet/anchor.ts:24`), which is a fixture value and
not a profile constant.

This is not over-flexibility. §3.3 fixes the unit of change — a future chain is a new profile,
not a parameter — and the *profile* pins chain, encoding, and the shape of the evidence. The
target is a per-anchor datum inside that profile, on the same footing as the transaction hash;
elevating it to a profile constant over-fixes the wrong axis. The sibling anchor family agrees
by construction: Colophon's RFC 3161 and OpenTimestamps profiles carry no target concept at all
(`packages/benchmark-product/core/src/anchor/profiles.ts:30-35`), because a self-contained
proof does not need one.

**`contractAddress` is a misnomer, and the wire key is frozen anyway.** No contract need exist
at the target; contract-*creation* transactions are structurally refused, because the reader's
`sameHex` rejects a `null` left operand
(`native-base-sepolia-infrastructure.ts:681-683`) and `to` is nullable by the port's own type
(`:574`); the field holds a plain recipient. The correct name is `to`. The wire key stays
`contractAddress` for `base-sepolia-calldata-v1`: it is a `z.literal`-pinned profile
(`operator/src/daemon/native-trust-catalog.ts:60-70`) with a live operator-held catalog behind
it, and renaming a field is exactly the "new profile, not a parameter" change §3.3 governs. The
corrected name is carried forward as a requirement on the anchor-locator profile document,
which does not yet exist in any repository — the cheapest place to spell it right the first
time. `inputByteOffset` and its 1 MiB bound (`native-trust-catalog.ts:68`) are kept: the field
is what lets a digest ride inside a larger transaction Jinn did not compose, and the reader
checks exact bytes at the declared offset (`native-base-sepolia-infrastructure.ts:1468-1471`),
so the flexibility costs nothing on its own. It does widen the residual named below, which is
an argument for the digest rule and not against the offset.

**The anchor digest can never be the sealed record's own digest.** `KeyBinding.anchors` is a
required field of the record it would have to hash
(`packages/trust/core/src/key-binding.ts:73`), and `Revocation.anchors` likewise
(`packages/trust/core/src/revocation.ts:27`), so a record that must contain its anchor's digest
cannot be that digest's preimage. The binding case is doubly forced: §6 law 2 requires
`validFrom` to be the anchor's block time verbatim, which is unknowable before the anchor
mines. §7.3 of the trust-layer design says "The binding's digest receives a time anchor"
(`2026-07-27-trust-and-identity-layer-design.md:290`); the implementation cannot do that, and
the reason is circularity, not laziness. For every path the digest must commit to content
outside the record. That freedom is what §6 law 1's anchor-first ordering exists to make
workable.

**Genesis (`init`) and join: the `ceremony-anchor/v1` preimage, pinned.** `ceremonyAnchorDigest`
(`operator/src/cli/commands/ceremony.ts:412-428`), called identically from `init` (`:970-975`)
and `join` (`:1210-1215`), is ratified as authored. Its canonicalization is pinned here,
because an unpinned canonicalization is a silent interop break. The preimage is ECMA-262
`JSON.stringify` with no replacer and no `space`, over an object whose keys are inserted in
exactly this order:

| # | Key | Value | Source |
| --- | --- | --- | --- |
| 1 | `protocol` | the literal `https://spec.jinn.network/trust/ceremony-anchor/v1` | `operator/src/cli/commands/ceremony.ts:419` |
| 2 | `agent` | the operator's Agent IRI | `operator/src/cli/commands/ceremony.ts:420` |
| 3 | `admissionAgent` | the minted admission Agent IRI — **omitted entirely** when absent, never `null` | `operator/src/cli/commands/ceremony.ts:421` |
| 4 | `settlementSafe` | the service Safe address, ASCII-lowercased `0x` + 40 hex | `operator/src/cli/commands/ceremony.ts:422` |
| 5 | `keys` | array of objects carrying exactly `role` then `keyId`, sorted ascending by `role` | `operator/src/cli/commands/ceremony.ts:423-425` |

The bytes are UTF-8 encoded, hashed with sha256, and spelled `sha256:<64 lowercase hex>`
(`operator/src/cli/commands/ceremony.ts:427` through
`packages/trust/core/src/hashing.ts:10-12`). Three canonicalization rules the implementation
satisfies without stating, which a non-JavaScript implementation needs in order to reproduce
the bytes:

- The `role` sort compares with JavaScript `<`/`>` on strings — UTF-16 code-unit order
  (`operator/src/cli/commands/ceremony.ts:425`). Role values are unique within a session, so
  the sort is total and tie behavior is moot.
- **Every preimage value MUST be ASCII.** `JSON.stringify`'s escaping is minimal and
  unambiguous for ASCII; for non-ASCII it raises the lone-surrogate and escaping questions a
  canonical-JSON profile exists to answer. Agent IRIs are `urn:uuid:` and did:keys are base58,
  so every value is ASCII today. A non-ASCII value is out of profile for v1 and MUST be refused
  at authoring time. This is a new authoring-side rule; nothing checks it yet.
- `sha256:` spelling is lowercase hex, already enforced at
  `packages/trust/authoring/src/anchor.ts:77-83`.

Ratifying rather than replacing is deliberate. The preimage is a real improvement on the opaque
constant the e2e fixture used: it is a deterministic function of the session tuple, which is
what makes `reusableAnchor` (`operator/src/cli/commands/ceremony.ts:333-349`) a correct
crash-resume — a re-run recomputes the same digest and reuses the already-mined anchor instead
of orphaning it and sending a second transaction. That is load-bearing operationally, and
replacing the preimage would cost every existing deployment a re-anchor to buy nothing that is
checked today.

**The defect this preimage carries, stated plainly: it is not third-party recomputable.** The
doc comment at `operator/src/cli/commands/ceremony.ts:400-411` claims the preimage makes the
on-chain transaction say something "true and checkable". True, yes; checkable, only by its
author. `KeyBinding` carries no `role` field
(`packages/trust/core/src/key-binding.ts:55-74`), and the role→scope map of
§3.2a is not invertible — the three `*-discovery` roles share one scope pair and both
settlement roles map to `settlements` — so the `keys: [{role, keyId}]` term cannot be recovered
from a catalog by anyone, and the commitment can never be opened by a third party. Against this
deployment's own posture, that real authentication is **cross-operator** (§7), a commitment
only its author can open is evidentially inert to the parties that matter: it binds the
operator's own tooling and nothing else. The corrective is a recomputable preimage — drop
`role`, or commit to a sorted set of `(agent, keyId)` pairs plus the Safe, all recoverable from
the catalog. It is deliberately **not** ratified here: it buys nothing until a verifier check
exists, the check belongs to the anchor-locator profile document, and changing the preimage
twice is worse than once. The defect is recorded as an input to that document (§10).

**Re-author (the scope-widening path) recomputes the same digest.**
[`docs/runbooks/native-trust-reauthor.md`](../docs/runbooks/native-trust-reauthor.md)
re-signs bindings without touching keys, stores, or Agent IRIs, so none of the five preimage
terms change and the digest is identical. The anchor MAY therefore be reused; the existing
anchor already commits to exactly this tuple and there is no evidentiary reason to mint a
second. Reuse is not automatically correct: the runbook mints a fresh anchor today
(`native-trust-reauthor.md:46-48`), and the two options differ semantically. Reuse preserves
the original `validFrom` and effective window, so the *widened* scope is claimed retroactively
over evidence signed before the widening; a fresh anchor refuses that retroactivity at the cost
of a coverage gap between the old anchor time and the new one. The reuse-vs-fresh choice is a
per-widening judgment the runbook MUST state and the operator MUST record with its reason.
Which is right in general is a retroactive-authority question left open (§10).

**Revocation: the `revocation-anchor/v1` preimage, recomputable by design.** `revokeBinding`'s
body is deferred (§3.2, §9), so no revocation has ever been authored — which is why this is
cheap to fix now and expensive after the first one is anchored. The preimage is
`https://spec.jinn.network/trust/revocation-anchor/v1` under the same encoding discipline as
above (ECMA `JSON.stringify`, no replacer or space, ASCII-only, UTF-8, sha256,
`sha256:<lowercase hex>`), keys inserted in this order:

| # | Key | Value |
| --- | --- | --- |
| 1 | `protocol` | the literal `https://spec.jinn.network/trust/revocation-anchor/v1` |
| 2 | `targets` | the revoked binding digests (`Revocation.target` values), each `sha256:<lowercase hex>`, sorted ascending as strings, no duplicates, at least one |
| 3 | `revokedBy` | the revoking identity exactly as it appears in the records (`did:pkh:…` or `did:key:…`, `packages/trust/core/src/revocation.ts:26`) |

`effectiveFrom` is deliberately excluded. Including it would force it to be chosen before the
anchor exists and would then be a published commitment to a value the resolver clamps away
(`packages/trust/resolve/src/binding-resolver.ts:147`) — a field that looks authoritative and
is not. The block time is the authority; the preimage commits to *what* is revoked and *by
whom*, which are the two things the block time alone cannot say.

Every term is present in the catalog: `targets` are the `target` fields of the revocations
referencing this anchor, `revokedBy` their common signer identity. A verifier can recompute the
digest and refuse an anchor whose digest does not equal it, which collapses R1–R3 below into
one check and makes R2 structurally unfalsifiable rather than merely forbidden — domain
separation means a `revocation-anchor/v1` digest can never equal a `ceremony-anchor/v1` digest,
so a reused binding anchor fails recomputation by construction. The revocation path is
therefore ratified with the property the binding path lost.

**Exactly one anchor per record.** Under `base-sepolia-calldata-v1` a binding and a revocation
each declare exactly one anchor. The schema admits an array
(`key-binding.ts:73`, `revocation.ts:27`), the opener requires at least one
(`operator/src/daemon/native-trust-catalog.ts:327` and `:336`), and the resolver silently takes
the earliest of however many are present (`binding-resolver.ts:111-116`, applied at `:127-135`
and `:137-148`). Everything Jinn authors already writes a single-element array
(`packages/trust/authoring/src/anchor.ts:107-133`), so this invalidates nothing; it closes an
earliest-wins ambiguity that has no legitimate use under this profile and that R2 shows is
dangerous. It is trivially verifier-enforceable and is the cheapest rule in this amendment.

**What the verifier checks, and what it does not.** A specification that does not say which of
its rules are checked is how §3.2a's class of drift happens, so the split is stated outright.

| Rule | Status |
| --- | --- |
| Chain id `84532` | Enforced (`native-base-sepolia-infrastructure.ts:1448`) |
| Transaction and receipt exist; receipt succeeded | Enforced (`:1456-1458`) |
| `transaction.hash` equals the declared hash | Enforced (`:1459`) |
| `transaction.to` equals the declared `contractAddress`, and is non-null | Enforced (`:1460`, `:681-683`) |
| Transaction and receipt agree on block; block at or below the finalized head | Enforced (`:1461-1465`) |
| Canonical block re-read | Enforced (`:1473-1477`) |
| Exact digest bytes at the declared `inputByteOffset` | Enforced (`:1468-1471`) |
| Every referenced anchor is declared in `anchors[]`; at least one per record | Enforced (`native-trust-catalog.ts:326-343`) |
| The `ceremony-anchor/v1` preimage and every canonicalization rule above | Authoring convention. **Permanently** unverifiable by a third party, per the defect above |
| The ASCII-only restriction | Authoring convention |
| The self-send anchor-target default | A default, not a rule |
| `inputByteOffset === 0` for anything Jinn composes | Authoring convention (`packages/trust/authoring/src/anchor.ts:129`) |
| The re-author reuse-vs-fresh choice and its recorded reason | Authoring convention |
| R4 (`effectiveFrom` at or before the anchor's block time) | Authoring convention. Partially enforceable against the observed anchor time, but not ratified as a check: the clamp already makes the anchor govern, and the only harm is a delay the operator chose |
| The `revocation-anchor/v1` preimage (R1–R3) | Authoring convention today; recomputation is possible by construction and is named as implementation work in DR-2026-09-06 §Consequences |

**The residual, stated with its bounds.** Because the digest's meaning is unchecked, an
anchor's timestamp can be borrowed from any pre-existing Base Sepolia transaction: a catalog
author may declare any 32-byte window of any finalized transaction (offset up to 1 MiB) as
their anchor digest and inherit that block's time. Effective start is
`max(validFrom, anchorTime)` (`binding-resolver.ts:127-135`) and earlier-anchored wins conflicts
(§7.3 of the trust-layer design), so an earlier borrowed time is worth something to an
adversary. The exploitability is bounded, and the bounds are not this amendment's to change: it
is a borrowed timestamp and not a forged binding, since the DSSE self-signature and the EIP-191
ceremony are untouched; attaching to someone else's Agent IRI is blocked by the §7.4a consent
chain regardless of anchor time; joins are serialized through the coordinator, who authors the
catalog; and grinding a digest to *match* an existing transaction is a preimage problem, so the
borrowing above is the cheap direction and it only helps within an author's own IRI. What
closes the residual is digest recomputation — which is why the revocation preimage is the
substantive decision here and the binding preimage's defect is recorded rather than shrugged
at.

**This document was wrong about the target.** §3.2's `submitAnchor` comment said the calldata
goes to "the fixed anchor target". Nothing fixed it, in either sense: no production constant
exists in the tree, and the word asserted a constraint that was never built. It now reads
"declared", which is what the code does and what this amendment ratifies.

The rejected alternatives are recorded in DR-2026-09-06. The strongest of them deserves naming
here, because it is the only one a verifier could actually enforce: requiring
`contractAddress` to equal `transaction.from` — a real self-send check, since `from` is
available. Rejected anyway. It couples anchor gas to the ceremony key and forbids a coordinator
or relayer paying it, which is a liveness coupling in miniature; and it buys nothing, because
an adversary who anchors someone else's digest hands them a valid *earlier* timestamp they
cannot exploit — they still cannot produce the binding.

### 3.3 What the package does NOT do

No RPC configuration (clients injected), no password handling (caller supplies), no config
write-back (CLI-owned, §4), no network selection (the calldata profile literal is
`base-sepolia-calldata-v1`, matching the catalog schema's single admitted profile,
`native-trust-catalog.ts:61-62` — a future chain is a new profile, not a parameter).

### 3.4 Fixtures become consumers — named deletions

- `fixtures/native-fleet/identity.ts`: `mintIdentityStore` / `writeIdentityStore` /
  `fixtureKeyId` (the store-format shadow, `:32-135`) delete; the fixture calls
  `openRoleSigners({ create: true })` and keeps only rig-shaped return plumbing.
- `fixtures/native-fleet/trust-catalog.ts`: the hand-rolled policy/binding/catalog assembly
  in `authorNativeTrustCatalog` (`:96-219`) deletes in favor of `performEoaCeremony` /
  `authorRoleBinding` / `authorCatalog`; the fixture keeps only what is genuinely
  rig-specific — the deterministic shared anchor digest, the mock-anchor-client branch, and
  the `bootTime` return contract.
- `fixtures/native-fleet/anchor.ts`: `createForkAnchorSubmitter`'s tx construction delegates
  to `submitAnchor`; the fixture keeps the Anvil-only finality burial (`anvil_mine` past the
  fork's `finalized` tag) in place of the live `waitForFinalizedAnchor`.
- `fixtures/native-fleet/config.ts` keeps its shape but consumes the above.

The invariant that made the fixtures safe — "a drift in the store format reddens this
fixture's own unit test" (`identity.ts:13-15`) — is superseded by the stronger one: there is
exactly one implementation to drift.

## 4. CLI surface: `jinn ceremony init | join | show`

A new `CommandModule` at `client/src/cli/commands/ceremony.ts`, following the
`native-requester.ts:187-379` pattern exactly: deps injection with dynamic production
imports, read-only by default with an explicit `--execute` gate, JSON envelopes via
`emitEnvelope` / `emitResult`, password via `JINN_PASSWORD` only.

### 4.1 `jinn ceremony init` — first operator, genesis

Provisions one operator AND the shared catalog. Inputs: `--dir <operator home>` (default
`~/.jinn-client`), `--config <path>` (default `<dir>/config.json`), `--role-sets
requester,admission,solver[,evaluator]` (the four families of
`native-requester.ts` `ROLE_SETS`), `--authority-store <path>`, `--rpc-url`, `--dry-run`
(default) / `--execute`.

Flow (each step idempotent or refusing, in §6's mandatory order):

1. **Load chain custody.** Open the operator's existing earning keystore (agent EOA — the
   ceremony signer) and read `earning_state.json` for the service Safe
   (`safe_address` / `agent_address`, `client/src/earning/types.ts:78-79`). Preflight:
   `Safe.isOwner(agentEoa)` must already hold on-chain, or init refuses before any mint —
   the §2 amendment makes this the load-bearing link, so it is checked first.
2. **Mint custody.** `openRoleSigners({ create: true })` per requested role family at
   `<dir>/identity/<family>.enc.json`; `openCatalogAuthority({ create: true })` at the
   authority path. Re-running against existing stores opens them (never clobbers).
3. **Mint identity.** One `urn:uuid:` Agent IRI for the operator and a **distinct**
   `urn:uuid:` admission-agent IRI (trust design §5: minted once, never rotated). Persisted
   in the init receipt so a re-run reuses rather than re-mints.
4. **Anchor first.** `submitAnchor` with the catalog's shared anchor digest, from the agent
   EOA; then `waitForFinalizedAnchor` against the production
   `createBaseSepoliaFinalizedAnchorClient` (`native-base-sepolia-infrastructure.ts:965-1012`)
   — on live Base Sepolia the `finalized` tag (`:309-311`) trails head by roughly 10-20
   minutes; init waits, with progress output, and refuses to proceed on timeout.
5. **Author bindings** with `validFrom = issuedAt =` the anchor's block time (§6 law 2), the
   settlement roles carrying the third Safe resource (§2.3b).
6. **Author the catalog**: complete purposes (§6 law 3), authority-signed genesis policy,
   `refreshBy` per §5; write to `<dir>/trust.json` (shared location by copy, §4.2).
7. **Surgical config write-back** of exactly the five native identity keys onto the
   operator's `config.json`: `agentIri`, `admissionAgent`, `identityStores`,
   `trustRootsPath`, `trustPolicyGenesisDigest`. Read-modify-write preserving every other
   key. The ceremony writes the identity keys; the remaining native keys are deploy-config,
   operator-authored — native boot also hard-requires `ipfs.apiUrl` and `publicBaseUrl`
   (`native-fleet-runtime.ts:275-276`) and, effectively, `recordSources` (the discovery
   composition), none of which the ceremony can know. Deliberately NOT written:
   `compositionMode` — the flip stays the deploy PR's one switch
   (`native-sections.ts:166-186`).

The ceremony MUST run with the password the daemon will later resolve. The daemon resolves
`JINN_PASSWORD` first and falls back to the keystore-password file, and the fallback path is
hard-coded to `~/.jinn-client/keystore-password` (`main.ts:178,198`) — so an operator homed
anywhere else (§4.4's operator B at `~/.jinn-client-op-b`) can never use the file fallback
and must supply `JINN_PASSWORD`, at ceremony time and at every daemon start.

`--dry-run` performs steps 1-3's reads plus a full plan print and no chain write, no store
mint, no config write.

### 4.2 `jinn ceremony join` — operator N+1

Runs against an **existing** catalog (`--catalog <path>` + `--genesis <digest>` pin). Same
steps 1-3 for the joining operator's own custody and IRIs; then one new anchor tx (submitted
by the joiner's EOA), finality wait, new bindings, and `appendOperator` — appending bindings
+ anchor and sealing a **policy successor** whose per-purpose `accepted` lists now include
the joiner's IRIs, signed by the catalog authority (the deploy coordinator runs `join`, or
countersigns the prepared successor; the authority store never leaves the coordinator).
Genesis digest is unchanged, so **existing operators' configs are untouched**; distribution
is file copy of the rewritten catalog to each operator's `trustRootsPath` **plus a daemon
restart** — `assertFresh` (`native-trust-catalog.ts:258-267`) makes a changed catalog under
a running daemon a hard refusal by design, so restart-required is stated CLI output, not a
surprise.

### 4.3 `jinn ceremony show` — read-only inspection

No password unless a store listing is requested. Prints: catalog path + genesis digest +
newest policy version + `refreshBy` (with days remaining), purposes with accepted IRIs,
bindings grouped by agent (role scope, keyId, validFrom, anchor digest), anchor status via a
live RPC read (finalized or not), revocations. With `--store <path>` +
`JINN_PASSWORD`: role → keyId listing (public material only, same posture as
`native-vertical identity`).

### 4.4 Worked example — the current two-operator case

One host; operator A = service 72 at `~/.jinn-client`, operator B = service 75 at
`~/.jinn-client-op-b`. Ritsu is both operators and the deploy coordinator.

```bash
# A — genesis (coordinator holds the authority store)
JINN_PASSWORD=… jinn ceremony init \
  --dir ~/.jinn-client \
  --role-sets requester,admission,solver,evaluator \
  --authority-store ~/.jinn-ceremony/authority.enc.json \
  --execute
# … submits anchor, waits ~10-20 min for finality, writes ~/.jinn-client/trust.json,
#   writes the 5 config keys back to ~/.jinn-client/config.json

# B — join (same host, same coordinator, B's own custody + EOA + Safe)
JINN_PASSWORD=… jinn ceremony join \
  --dir ~/.jinn-client-op-b \
  --role-sets requester,solver \
  --catalog ~/.jinn-client/trust.json \
  --genesis sha256:<printed by init> \
  --authority-store ~/.jinn-ceremony/authority.enc.json \
  --execute
# … second anchor tx from B's EOA, finality wait, policy successor v2

# distribute + restart (assertFresh ⇒ restart-required)
cp ~/.jinn-client/trust.json ~/.jinn-client-op-b/trust.json
#   (join already updated A's copy in place; B's config gets its four identity keys
#    from join — no admissionAgent, since B's --role-sets carries no admission family)
# restart both daemons

jinn ceremony show --catalog ~/.jinn-client/trust.json
```

B runs the requester family too even though solver-only in intent: the fleet runtime always
opens requester custody (`native-fleet-runtime.ts:277-289`; the projector's
requester-association resolver needs `requester-submission` — same reasoning as the fixture,
`fixtures/native-fleet/config.ts:127-131`). Both ceremonies and both daemons run under the
same supplied `JINN_PASSWORD` per operator: B, homed at `~/.jinn-client-op-b`, is outside
the hard-coded `~/.jinn-client/keystore-password` fallback (§4.1) and must set the env var
for every run.

## 5. Catalog governance

**One shared catalog, one genesis.** All operators of a deployment verify against the same
file content, pinned by the same `trustPolicyGenesisDigest`. Joins extend it via hash-linked
policy successors (`verifyPolicyChain`'s dual-threshold chain,
`packages/trust/core/src/policy.ts:228-282`); the genesis digest never changes after init.

**A dedicated catalog-authority key signs policies.** One Ed25519 keypair in its own
encrypted store (same envelope format as role stores), held by the deploy coordinator. Never
an operator role key: (a) role keys rotate/revoke on operator events, and policy-update
capability must survive any operator's rotation — a policy chain whose signer was a revoked
role key strands every future successor; (b) the signer set is the one sanctioned
key-not-IRI surface in the policy (`policy.ts:48-58`), so putting operator custody there
collapses the operator/governance separation. The fixture's expedient
(`trust-catalog.ts:143-144` — `policySigner = roleKeys[0]`) is exactly what this rule
forbids in production. Authority rotation is TUF-native: a successor policy carries the new
`signerSet` and is signed to both old and new thresholds (dual-threshold,
`policy.ts:266-271`).

**`refreshBy` = genesis date + ~6 months.** For a 2026-08-07 genesis: `refreshBy:
2027-02-07T00:00:00.000Z`. `openNativeTrustCatalog` hard-refuses an expired policy
(`policy-expired`), so the successor obligation is real: before `refreshBy`, the coordinator
seals a successor (`sealPolicySuccessor`), and any `join` also refreshes (its successor
carries a fresh `refreshBy`). `show` prints days-remaining so the obligation is visible.

**Rejected: per-operator catalogs.** N operators, N genesis digests, N authority pins — and
because every operator must accept every OTHER operator's bindings (B verifies A's requester
source; A verifies B's delivery), every join would have to touch every file anyway, which is
the shared catalog's write pattern with N times the custody surface and N ways to skew.

**Rejected: catalog-per-relationship.** The runtime opens exactly one catalog per process
(`native-fleet-runtime.ts:295-301` — one `trustRootsPath`, one genesis pin); a
per-relationship model has no consumer, and would multiply the §6 sequencing per pair.

## 6. Ceremony sequencing law (normative)

1. **Anchor FIRST.** Submit the anchor calldata tx and read its block time before any
   binding is authored. One shared anchor digest may back multiple bindings (the resolver
   treats anchors per-reference: `binding-resolver.ts:127-135`); one anchor tx per ceremony
   session is the norm. **Reuse of an existing anchor is permitted exactly when the act
   recomputes the same digest** — §3.2b makes `ceremony-anchor/v1` a pure function of the
   session tuple, so a re-run or a scope re-author reproduces it and `reusableAnchor`
   (`operator/src/cli/commands/ceremony.ts:333-349`) correctly resumes onto the already-mined
   transaction rather than orphaning it. Cross-act reuse is refused by domain separation: a
   `revocation-anchor/v1` digest can never equal a `ceremony-anchor/v1` one, so a
   revocation's anchor is always fresh (law 6). Each binding and each revocation declares
   exactly one anchor (§3.2b).
2. **`validFrom = anchor block time`** (and `issuedAt` with it). The resolver computes
   `effectiveStart = max(validFrom, anchorTime)` (`binding-resolver.ts:127-135`), and the
   §7.4a consent-chain leg windows the incumbent `controls` binding at the candidate's
   `validFrom` — its mint time (`binding-resolver.ts:201-212`). A `validFrom` earlier than
   the anchor's block time silently shifts `effectiveStart` to `anchorTime` and breaks the
   incumbent-window checks (§7.4a consent-chain failures); a `validFrom` later than it
   delays every role's boot eligibility. Equal is the only correct value — which is only
   knowable **after** the anchor is mined. This is law 1's reason. Equality is textual:
   `validFrom` MUST be the **verbatim string** `submitAnchor` returns, not merely the same
   instant — the resolver compares these timestamps lexicographically as raw strings
   (`binding-resolver.ts`; only trust-core's `verify.ts` step 4 uses calendar comparison),
   and the production anchor reader emits the millisecond ISO form
   (`new Date(Number(block.timestamp) * 1000).toISOString()`,
   `native-base-sepolia-infrastructure.ts:1005`), so a `…00Z` vs `…00.000Z` drift changes
   lexicographic outcomes.
3. **Complete policy purposes.** The genesis (and every successor) policy carries an entry
   for every `native:<role>` purpose any bound key will be verified under, **plus
   `admission-agent`** (the core-registered purpose, `policy.ts:21-31`), **plus
   `evaluator-eligibility`** (accepted = the evaluator operators' Agent IRIs). Verified
   against the current tree: the evaluator assembly resolves `admission-agent`
   (`native-evaluator-assembly.ts:217,349`) and eagerly resolves
   `input.trust.policy('evaluator-eligibility')` inside `createVerdictGate`
   (`native-evaluator-assembly.ts:350`), executed during
   `assembleNativeEvaluatorComposition` → `buildFleetNativeEvaluator` at daemon boot
   whenever the evaluator section is configured; the consumer resolves `native:admission`
   (`native-consumer/trust.ts:19`); `policyFor` throws on any absent purpose
   (`native-trust-catalog.ts:346-350`). A catalog authored without `evaluator-eligibility`
   therefore boots solver and requester and then fails operator A's **evaluator** boot — the
   exact LEG 6 gate leg. The purpose was missed in v0.1 because the e2e rig exercises only
   LEG 0/1 and never assembles the evaluator, and the fixture authors only `native:<role>`
   purposes (`fixtures/native-fleet/trust-catalog.ts:150-158`) — motivating evidence for
   §3.4's fixtures-become-consumers rule. A catalog missing a purpose is a
   boot-or-verify-time refusal, not a degraded mode — so completeness is authored, not
   discovered. Both admission spellings are populated with the admission-agent IRIs.
4. **Wait for `finalized` before declaring success.** The catalog opener accepts only
   anchors below the finalized head (`native-base-sepolia-infrastructure.ts:965-1012`;
   finalized tag read at `:309-311`). On live Base Sepolia that lag is ~10-20 minutes; a
   ceremony that prints success before the wait completes hands the operator a catalog that
   refuses to boot.
5. **Catalog rewrite ⇒ daemon restart.** `assertFresh` refuses to authorize work over a
   changed catalog file (`native-trust-catalog.ts:258-267`). Every ceremony verb that
   rewrites a catalog says so in its output.
6. **Revocation anchors are act-specific and fresh.** A revocation declares **exactly one**
   anchor, newly submitted for that act, whose digest is the `revocation-anchor/v1` preimage
   over `{protocol, targets[], revokedBy}` (§3.2b). It MUST NOT reference an anchor authored
   for a binding or for a different revocation act — the resolver takes the **earliest**
   anchor time (`binding-resolver.ts:111-116`) and a revocation's effect is
   `max(effectiveFrom, earliest anchor time)` (`:137-148`, clamp at `:147`), so referencing a
   binding's anchor drags the revocation's effect back to the binding's own birth, revoking
   it from the moment it existed. That is a direct violation of "revocation is never
   retroactive: its effect starts at its own anchor time"
   ([`2026-07-27-trust-and-identity-layer-design.md`](../docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md):330-332),
   and it is the sharpest footgun on this surface. One anchor MAY back several revocations
   exactly when they share `revokedBy` and their `target` set is exactly the preimage's
   `targets` — the compromised-EOA case, one act, one transaction, one finality wait — which
   the preimage turns from an assertion into a published commitment. `effectiveFrom` is
   millisecond-ISO UTC and MUST be at or before the anchor's block time: the resolver clamps
   *up*, so an earlier value is harmless and the anchor governs, while a later value silently
   **delays** the revocation, which is the wrong direction for a security act. The
   millisecond form is required for law 2's reason — `:147` compares the two timestamps
   lexicographically as raw strings, and `…T00:00:00Z` versus `…T00:00:00.000Z` diverge at
   index 19 (`Z` = 0x5A > `.` = 0x2E), so a second-precision `effectiveFrom` is selected as
   *greater* than a millisecond-precision anchor time for the same instant. Law 1's
   anchor-first ordering extends to revocations for the same reason it governs bindings: the
   effective time is not knowable until the anchor mines.

## 7. Security considerations

**Clobber and fork risk.** Store creation is exclusive (hard-link `EEXIST` settles races,
`role-identities.ts:433-451`); `openRoleSigners` inherits it — there is no code path that
replaces existing key material. Catalog genesis refuses an existing path. `join` is
read-check-rewrite with a digest compare, so two concurrent joins produce one winner and one
loud refusal — and even a lost race that somehow published two successors with the same
predecessor is fail-closed at every verifier (`rollback-detected`, `policy.ts:259`). Joins
are serialized through the coordinator; the failure mode of getting this wrong is refusal,
never split trust.

**Authority-key custody.** The catalog authority store is coordinator-held, offline-capable
(nothing in the daemon reads it), and absent from every operator config. Loss of the
authority key before `refreshBy` strands policy succession — the catalog then expires into
refusal at `refreshBy`, which is the intended failure direction (fail-closed, bounded).
Recovery is a new genesis + re-pin (the §4 flow re-run), which is why `refreshBy` is months,
not years.

**Nonce scheme.** Each ceremony message's `nonce` is 16 random bytes, lowercase hex,
generated per ceremony. Replay across (agent, key) pairs is already impossible — the content
match binds the signed bytes to the exact Agent IRI and did:key (`ceremony.ts`,
`matchCeremonyContent`) — so the nonce's job is uniqueness of the signed bytes across
re-runs of the *same* pair, keeping every ceremony's evidence digest distinct. The fixture's
derived nonce (`native-e2e-${didKey.slice(-8)}`) is replaced by the random scheme in the
authoring package. `expirationTime` stays absent: ceremony evidence is verified offline
forever (`verifyEoaCeremony` reads no expiry), and an expiring ceremony would reintroduce
exactly the retroactive-invalidity problem §2.3d refuses.

**What an attacker with config-write can and cannot do.** `config.json` carries both
`trustRootsPath` and `trustPolicyGenesisDigest`, so config-write on an operator host equals
trust-root substitution **for that operator's own process** — the pin is not independent of
the file that names it. This is the same posture already recorded for the evaluator
deployment digest (M1 review note 7, restated at `native-fleet-runtime.ts:257-264`: "anyone
who can write the config can write both… it authenticates no one"): the catalog's genesis
pin is integrity-against-drift locally, and real authentication is **cross-operator** — every
other operator verifies against their own copy under their own pin, and the on-chain legs
don't move. Concretely, an attacker with config-write (but not key custody) can redirect the
local daemon to a forged catalog and disrupt/misdirect that one operator; they **cannot**
make any other operator accept a forged binding (other operators' pins don't change), cannot
produce a ceremony for a key they don't hold (EIP-191 recovery), cannot satisfy §2.3c step 5
for a Safe they don't own (`isOwner` is chain state), and cannot mint an acceptable policy
successor (authority key is not on the host). Key custody files are `0o600` under `0o700`
dirs (`role-identities.ts:331-333,386-393`); the password never enters config
(`JINN_PASSWORD` env-only).

**Ceremony signer compromise.** The agent EOA signs ceremonies and owns the Safe link; its
compromise is an operator-level incident (it already controls settlement on-chain). The
trust layer's answer is revocation + rebind (§3.2 deferred surface) — the catalog schema and
resolver already enforce anchored, effective-time revocations
(`native-trust-catalog.ts:57,77,298-306`), so the artifact model needs no change when the
rotation flow ships.

## 8. Rejected alternatives

1. **Expedient provisioning script** (promote the e2e fixtures into a
   `scripts/provision.ts`): rejected by operator ruling 2026-08-07. It would triple-implement
   the store format (production, fixture, script), leave the §2 defect load-bearing, and
   have no join/refresh story — every operator addition a hand-run re-authoring.
2. **Per-operator catalogs / catalog-per-relationship** — §5, with reasons.
3. **ERC-1271 Safe ceremonies** (bind the Safe directly as signer): §2.3d — retroactively
   mutable signature validity breaks effective-time semantics.
4. **Keeping `message.address = Safe`** with the EOA merely recovering: rejected — the SIWE
   message would assert an identity for a party that never signed it, and
   `verifyReCapCeremony`'s self-consistency rule shows the layer already refuses that shape
   elsewhere. Honest declaration (signer = EOA, Safe = declared resource) costs nothing and
   keeps every field of the ceremony literally true.
5. **Authoring inside `trust-resolve`**: rejected — resolve is the verification boundary
   consumed by verifiers that must never hold signing capability; production capability gets
   its own package and its own dependency direction.

## 9. Implementation plan

PR train into `integration/evidence-v1`, stacked, each green alone:

- **PR1 — `@jinn-network/trust-authoring` + fixture consumption.** Package with the §3.2
  surface (minus `revokeBinding`'s body); store codec extracted from `role-identities.ts`
  (daemon re-imports; zero behavior change, existing role-identity tests prove it); fixture
  deletions per §3.4; round-trip tests: authored catalog → `openNativeTrustCatalog` accepts;
  authored store → `RoleIdentitySet.open` accepts.
- **PR2 — settlement-authority association amendment.** §2.3 in
  `native-trust-catalog.ts` (+ the required `settlementOwnershipClient` input) and **all
  four** catalog-open wirings (§2.3c): fleet runtime, consumer driver, and both
  `native-production-deployment.ts` sites — the latter two via the `openInfrastructure`
  extension surfacing the Safe-ownership read on `NativeInfrastructurePrimitives` (the
  deployment path retires at stage 5 per DR-2026-08-05 but must compile and run until
  then); third-resource authoring in PR1's `performEoaCeremony` activates for settlement
  roles; e2e rig un-conflation (real 1-of-1 Safe on the fork); unit-test updates per §2.4.
- **PR3 — `jinn ceremony` CLI + config write-back.** `init | join | show` per §4;
  surgical five-key write-back with a read-back assertion; CLI tests over injected deps
  (the `native-requester.ts` test pattern).
- **Follow-up issue (filed at PR3 merge): rotation.** `revokeBinding` + rebind flow +
  `jinn ceremony rotate`, on the §3.2 surface. Implementation deferred; schema and resolver
  already support it.

Guards: docs-only artifacts of this spec (this file + the DR addendum) trip neither
`generate-architecture.mjs --check` nor `phase-d-transition-deletion.test.mjs`; the train
PRs run both, and PR2's rig changes stay inside `client/test/e2e/`.

## 10. Open questions

- **(a) Authority threshold at genesis.** `signerSet.threshold` supports >1
  (`policy.ts:53-58`). One coordinator key is proposed for the two-operator present; whether
  genesis should already be 2-of-N (second key offline) is a custody-appetite call for the
  operator, not a technical blocker either way.
- **(b) Catalog distribution channel.** File copy + restart is specified and sufficient for
  one host. Whether the public archive listener (G-archive surface) should eventually serve
  the catalog to joining operators is deliberately unresolved — it changes the trust
  bootstrap (fetching trust roots over a channel those roots authenticate) and needs its own
  design.
- **(c) At-time Safe ownership.** §2.3c step 5 reads current chain state, matching the
  recorded `ChainFactResolver.ownerOf` finding. Whether Phase B verifiability tiers need
  historical ownership proof (timestamp→block mapping) is open there, not here.
- **(d) Should `join` author the joiner's `recordSources` entries?** The identity keys
  are written back; record sources describe peers, not identity, and today's two-operator
  case hand-writes them. Left open until the third operator exists to generalize from.
- **(e) Should the re-author path reuse its anchor or mint a fresh one?** §3.2b makes the
  digest a pure function of the session tuple, so both are available and the runbook must
  state its choice. Reuse preserves the original `validFrom` and effective window, which
  claims the *widened* scope retroactively over evidence signed before the widening; a fresh
  anchor refuses that retroactivity and pays a coverage gap between the old anchor time and
  the new one. Which is right in general is a retroactive-authority policy question that
  exceeds an anchor-format ratification, and it is not settled here.
- **(f) Should a successor binding-anchor preimage be third-party recomputable, and when is
  the re-anchor worth paying?** §3.2b records, as a named defect, that `ceremony-anchor/v1`
  commits to a `role` term no third party can recover from a catalog, so the commitment can
  never be opened by anyone but its author. The corrective is a recomputable preimage — drop
  `role`, or commit to a sorted set of `(agent, keyId)` pairs plus the Safe — but it buys
  nothing until a verifier checks it, and it costs every existing deployment a re-anchor.
  Reserved as an input to the anchor-locator profile document authored in `Jinn-Network/spec`
  under DR-2026-09-03, together with the `contractAddress` → `to` rename, so the first
  published version is right rather than compatible with a mistake.

### Review record (v0.2)

The v0.1 design was independently reviewed on 2026-08-07. Its highest-risk claim — that a
`join`'s new bindings satisfy the §7.4a consent-chain leg without any incumbent standing in
their way — was adversarially verified per-agent against the resolver, not assumed:
`resolveBinding` starts from `listBindingsForAgent(query.agent)` (`binding-resolver.ts:236`),
and both `isGenesisAmong` (`:217-223`) and `findIncumbentControlVoucher` (`:201-212`)
operate only within that per-agent set — so a joiner's fresh `urn:uuid:` Agent IRI gets its
own genesis binding (equal-`effectiveStart` batch settled by the digest tiebreak,
`:219-221`), same-session peer bindings pass because the incumbent window admits equality
(`:150-154`) and the voucher is the same EOA (`verify.ts:176-180`), and the first operator's
bindings are never anyone else's incumbent. Governance succession was verified against the
dual-threshold chain (`policy.ts:266-271`); the genesis signer set needs no binding or
anchor of its own (`policy.ts:247-250`). The v0.2 changes are the review's findings: the
`evaluator-eligibility` purpose (§6 law 3, §3.2), the four-site
`settlementOwnershipClient` seam scope (§2.3c, §9 PR2), the verbatim-`validFrom` rule
(§6 law 2), the password-identity and config-write-back completions (§4.1, §4.4), and cite
corrections (`abis.ts:59-66`, `production.ts:70`).
