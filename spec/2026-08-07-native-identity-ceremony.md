# Native Identity Ceremony — production trust-artifact provisioning

**Version:** 0.1

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
(`client/src/native-consumer/production.ts:68-69`). The seam is therefore
**`openNativeTrustCatalog`'s input**: it gains a required
`settlementOwnershipClient: { isOwner(safe: 0x…, candidate: 0x…): Promise<boolean> }`,
constructed by both compositions from the same public client that supplies `anchorClient`,
using the Safe ABI the daemon already carries (`client/src/contracts/abis.ts:60-65`,
`isOwner(address) → bool`). No new dependency, no client threading through call sites.

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
 * relationship 'controls', scope from NATIVE_ROLE_IDENTITY_REQUIREMENTS,
 * validFrom = anchor block time, anchors = [anchorDigest]), self-signed by the
 * role's DsseSigner. */
export function authorRoleBinding(input: { …see PR1… }): Promise<SealedBindingEntry>;

// ── anchoring ───────────────────────────────────────────────────────────────
/** Live base-sepolia-calldata-v1 anchor: sends `0x<digest-hex>` calldata to the
 * fixed anchor target, returns { transactionHash, contractAddress, inputByteOffset,
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
/** Genesis: seals the v1 TrustPolicy (complete purposes per §6 law 3, signerSet =
 * the catalog authority, refreshBy per §5), the given bindings, and the anchor
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
   key. Deliberately NOT written: `compositionMode` — the flip stays the deploy PR's one
   switch (`native-sections.ts:166-186`).

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
#   (join already updated A's copy in place; B's config gets its 5 keys from join)
# restart both daemons

jinn ceremony show --catalog ~/.jinn-client/trust.json
```

B runs the requester family too even though solver-only in intent: the fleet runtime always
opens requester custody (`native-fleet-runtime.ts:277-289`; the projector's
requester-association resolver needs `requester-submission` — same reasoning as the fixture,
`fixtures/native-fleet/config.ts:127-131`).

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
   session is the norm.
2. **`validFrom = anchor block time`** (and `issuedAt` with it). The resolver computes
   `effectiveStart = max(validFrom, anchorTime)` (`binding-resolver.ts:127-135`), and the
   §7.4a consent-chain leg windows the incumbent `controls` binding at the candidate's
   `validFrom` — its mint time (`binding-resolver.ts:201-212`). A `validFrom` earlier than
   the anchor's block time silently shifts `effectiveStart` to `anchorTime` and breaks the
   incumbent-window checks (§7.4a consent-chain failures); a `validFrom` later than it
   delays every role's boot eligibility. Equal is the only correct value — which is only
   knowable **after** the anchor is mined. This is law 1's reason.
3. **Complete policy purposes.** The genesis (and every successor) policy carries an entry
   for every `native:<role>` purpose any bound key will be verified under, **plus
   `admission-agent`** (the core-registered purpose, `policy.ts:21-31`). Verified against
   the current tree: the evaluator assembly resolves `admission-agent`
   (`native-evaluator-assembly.ts:217,349`) and the consumer resolves `native:admission`
   (`native-consumer/trust.ts:19`); `policyFor` throws on any absent purpose
   (`native-trust-catalog.ts:346-350`). A catalog missing a purpose is a boot-or-verify-time
   refusal, not a degraded mode — so completeness is authored, not discovered. Both
   admission spellings are populated with the admission-agent IRIs.
4. **Wait for `finalized` before declaring success.** The catalog opener accepts only
   anchors below the finalized head (`native-base-sepolia-infrastructure.ts:965-1012`;
   finalized tag read at `:309-311`). On live Base Sepolia that lag is ~10-20 minutes; a
   ceremony that prints success before the wait completes hands the operator a catalog that
   refuses to boot.
5. **Catalog rewrite ⇒ daemon restart.** `assertFresh` refuses to authorize work over a
   changed catalog file (`native-trust-catalog.ts:258-267`). Every ceremony verb that
   rewrites a catalog says so in its output.

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
  `native-trust-catalog.ts` (+ the `settlementOwnershipClient` input) and both composition
  wirings; third-resource authoring in PR1's `performEoaCeremony` activates for settlement
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
- **(d) Should `join` author the joiner's `recordSources` entries?** The five identity keys
  are written back; record sources describe peers, not identity, and today's two-operator
  case hand-writes them. Left open until the third operator exists to generalize from.
