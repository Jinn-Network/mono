# Jinn Trust and Identity Layer v1

**Date:** 2026-07-27

**Status:** design approved section-by-section in session; architecture and adversarial review
findings resolved; written review pending

**Shape:** `design`

**Scope:** the identity, key-binding, authorization, and trust-policy substrate beneath the
Evidence Protocol and the Task Execution Protocol — canonical identity spellings, the
key-binding statement, the authorization statement family (including the open-fleet adoption
authorization and capability-grant resolution), trust-policy documents, and the independence
model

**Out of scope:** implementation and migration planning, reputation scoring, Sybil and
challenge economics (Phase B.2), accreditation ecosystems, any smart-contract change, DID
resolution infrastructure, Verifiable Credential issuance, and key-custody/HSM operational
guidance

## 1. Problem statement

Both settled protocols are deliberately identity-scheme-neutral and defer trust outward. The
Evidence Protocol (§5.1, §6.10) names Agents by IRI, separates signature validity from
identity binding from consumer trust, and defers canonical external-identity mappings to
profiles above it. The Task Execution Protocol (§6.2, §20, §28) inherits the same rules and
leaves two named follow-ups: the identity mapping profile and the open-fleet adoption
authorization object. The profiles design adds three more hooks (admission-agent issuer
acceptability, evaluator identity for distinctness, private-grader credit controls). A
requirements audit across the five settled designs found **twenty deferred trust hooks**
(R1–R20, §12) and nine cross-document tensions.

Meanwhile the current reality beneath those protocols:

- **Three uncoordinated identity planes** carry authority — GitHub logins (Autopilot
  invariants, `receiptAuthors`), on-chain addresses (Safe/EOA), and protocol Agent IRIs —
  with no mapping objects anywhere.
- **The signer/actor split is structural**: execution envelopes and task documents are signed
  by the agent EOA while settlement authority is the operator Safe, and nothing binds the
  two. Anchoring writes go directly from the EOA while settlement goes through the Safe —
  which is how incident #1401 (an ERC-8004 agentId owned by a rotated-away key) silently
  broke 100% of verdict anchoring for weeks while settlement looked healthy.
- **Chain identity cannot rotate.** Everything derives from one HD mnemonic; the agent EOA
  owns the agentId NFT; no rotation story exists, and one recovery path *prescribes* rotating
  the EOA — the exact move that orphans the identity.
- **Everything above the address layer is client-side and advisory.** On-chain enforcement is
  exactly: self-evaluation address equality, operator/mech binding, and loop-completion
  credit. Provenance checks, profile policy, adoption waits, and admission gates are
  official-client behavior a non-official operator can skip. The marketplace-session design
  states this explicitly for adoption ("GitHub authorship alone is not an open-network
  cryptographic authority") and names a launcher-signed authorization as the open-fleet
  requirement.
- **Trust decisions live in hard-coded allowlists** (`receiptAuthors`, the official-profile
  policy, dispatcher author lists, plugin trusted signers), and each new design was about to
  mint another one.

This specification defines the layer that closes those gaps — without changing either
protocol's identity rules, without any contract change, and without becoming a reputation or
economics system.

## 2. Decision summary

1. **Approach B: compose Final-status grammars, skip Draft-status containers.** CAIP-2/10
   spellings (wrapped as `did:pkh`) for accounts, CAIP-19 for ERC-8004 agents, OIDC workflow
   subjects for machine GitHub identity; SIWE (EIP-4361) and EIP-712/191/1271/6492 as
   ceremony formats; UCAN's *semantics* and TUF's *rotation and freshness patterns* adopted
   as shapes. DSSE + in-toto remains the **only** envelope and canonicalization world — no VC
   stack, no UCAN DAG-CBOR container, no DID resolution dependency. Jinn authors exactly two
   record families (key-binding, authorization) plus the trust-policy document. (§3.)
2. **The Agent IRI is the durable identity; everything real attaches to it.** Accounts,
   agentIds, logins, and keys are auxiliary identifiers joined by binding evidence. The
   ERC-8004 agentId is registry *evidence about* an Agent — never the Agent, because the NFT
   is transferable and historical evidence must not change referent on sale. The on-chain
   enforcement anchor remains the Safe address; identity policy layers above it. (§5.)
3. **Accounts vouch, keys sign.** Working keys (rotatable) sign all evidence — offline-
   verifiable forever. Accounts (Safe/EOA) sign only chain-native ceremonies; binding
   statements — anchored in time — connect account → working key → Agent IRI. Only ceremonies
   confer voucher authority; a working key is never a voucher. The agent EOA becomes the
   first working key and gains a rotation story; the #1401 failure class closes structurally.
   Safe (EIP-1271) signatures never appear on evidence envelopes. (§6, §7.)
4. **One authorization object family with UCAN semantics**, expressed as in-toto Statements;
   the open-fleet adoption authorization gets a **dual representation** — an EIP-712 typed
   struct as the chain-verifiable enforcement form and a deterministically-derived in-toto
   Statement as the evidence form, both **irrevocable-until-expiry**. Capability grants
   become authorization statements with a defined issuer-binding resolution rule. (§8.)
5. **Trust-policy documents replace every allowlist**: one sealed, TUF-version-chained,
   dual-threshold-signed, **freshness-bounded** document shape naming acceptable Agent IRIs
   per purpose. Credit streams declare their regime (loop-completion vs pass-gated) in an
   optional policy block. (§9.)
6. **Independence is modeled at three levels** — address-distinct (chain-enforced,
   unchanged), agent-distinct (a *declared-identity* check: deployments require participants
   to declare and prove their Agent IRI; undeclared fails closed), and party-independent
   (unprovable here; B.2's job — this layer supplies the stable identities stakes attach
   to). (§10.)

## 3. Standards audit

Primary sources fetched 2026-07-27; versions pinned in Appendix A.

### 3.1 Selected

| Slot | Standard | Adoption |
| --- | --- | --- |
| Account spelling | CAIP-2 + CAIP-10 (Final), wrapped as `did:pkh` (CCG Draft) | Grammar verbatim; profile adds mandatory EIP-55 checksum and a contract-account flag (CAIP-10 erases the EOA/contract distinction; did:pkh's derived verification method is meaningless for a Safe) |
| Working-key spelling | `did:key` (CCG v0.9) | The standard spelling for a bare key, used wherever a key must appear as a URI (e.g. inside SIWE `resources`) |
| ERC-8004 agent spelling | CAIP-19 asset ID (Review) | `eip155:<chainId>/erc721:0x<identityRegistry>/<agentId>` |
| GitHub identity | OIDC workflow subject (machine); login URI + immutable numeric ID (human, weak) | Fulcio SAN practice; RFC 7565 `acct:` as alternative spelling |
| Org identities | `did:web` now; `did:webvh` v1.0 (DIF) when verifiable history matters | Transcribed, never resolved as a dependency |
| Binding/authorization envelope | DSSE v1 + in-toto Statement v1 | Unchanged from both protocols; one envelope, one canonicalization world |
| Wallet ceremonies | SIWE (EIP-4361, Final) + EIP-191 (EOA) / EIP-1271 (Safe) + ERC-6492 (counterfactual edge case) | Message template profiled (§7.2): pinned ceremony domain/URI, `resources` = [Agent IRI, `did:key` of the working key] |
| Wallet-facing authorization ceremony | SIWE + EIP-5573 ReCap (Draft) | Human-readable capability statement; transcribed into the Jinn predicate. Jinn flattens ReCap's resource-keyed `att` structure to (subject, capability-string) pairs and does not adopt qualification arrays |
| Chain-verifiable authorization | EIP-712 (Final) typed struct | The enforcement form of the adoption authorization |
| Delegation semantics | UCAN 1.0 (issuer/audience/subject, attenuation, expiry+nonce, proof chains, revocation) | Semantics only — the DAG-CBOR/Varsig container is not adopted; Jinn defines its own attenuation order (§8.1) |
| Rotation + freshness of root-of-trust artifacts | TUF (spec v1.0.35): version-chained metadata, N+1 signed by thresholds of both old and new key sets; timestamp-role freshness | Both patterns for trust-policy chains (§9) |
| Short-lived-key + durable-identity shape | Sigstore/Fulcio + Rekor | Shape only: keys rotate freely, identity persists, bindings are time-anchored; no Fulcio/Rekor infrastructure |
| GitHub machine key binding | OpenPubkey / Fulcio-style OIDC key commitment | For Autopilot CI identity; trust-on-archival caveat named (§7.2) |
| ERC-8004 (Draft; mainnet deployments live; v2 planned) | Registry as on-chain identity *evidence*: agentId + owner + `setAgentWallet` (EIP-712/1271-authenticated; auto-cleared on transfer) + registration file | Evidence source and anchor surface; the on-transfer auto-clear is embraced as the re-binding trigger |

### 3.2 Rejected

| Candidate | Why not |
| --- | --- |
| W3C VC 2.0 as binding envelope | Same shape as an in-toto Statement but a second envelope, second canonicalization regime (RDF Data Integrity), IRI subjects instead of digest subjects — zero verification-power gain. Kept as a **projection target** for future SSI interop |
| UCAN 1.0 container | DAG-CBOR + Varsig + CID addressing + DID principals = a second canonicalization universe beside DSSE/exact-bytes; small ecosystem. Semantics adopted, container skipped |
| CACAO (CAIP-74) | Same IPLD-container objection; the SIWE+ReCap *message* is profiled instead |
| did:ethr / ERC-1056 | Semantically closest DID method (owner rotation + delegates under stable identifier) but drags a third on-chain identity surface and resolver stack; its *shape* informs the binding rules |
| ERC-8004 agentId as the Agent identity | Transferable NFT: the referent can change owners; historical evidence must not change attribution on sale. Registry evidence, not identity |
| EIP-1271 signatures inside DSSE | Verification is an `eth_call` against live contract state: chain-dependent, retroactively invalidatable on owner rotation, unverifiable by any third-party tooling. Rejected as an envelope signature type; 1271 appears only in ceremonies with signed witnesses (§7.2) |
| Running Fulcio/Rekor/DID infrastructure | The public instances don't know Jinn identities and support no EVM signers; the chain already plays the transparency-anchor role |

### 3.3 The confirmed gap

No supply-chain-security ecosystem (Sigstore, in-toto, cosign) supports contract-account
signers at all. A Safe cannot produce an offline-verifiable signature by construction — its
"signature" is a live threshold check against current owners. Where Jinn needs Safe authority
in evidence, Jinn defines the procedure alone; this design does so via ceremonies plus signed
witnesses (§7.2) rather than per-envelope chain queries.

## 4. Position in the stack

```text
Applications            (policy: what work exists, acceptance, budgets)
Backend contract        (verbs; local / marketplace / future bindings)
Task Execution Protocol (prospective records + profiles/EvaluationSpecs)
Evidence Protocol       (retrospective records)
TRUST LAYER — this design:
  Agent IRIs ↔ real identities · key bindings · authorizations · trust policies
  ERC-8004 lives here as one source of identity evidence;
  the chain doubles as timestamp anchor for statements
```

The trust layer is **not a marketplace component**. The marketplace is the adversarial
deployment that *requires* its objects (via its deployment profile); a local development loop
requires none of them and is fully conformant with zero trust machinery — the same
optional-in-core, profile-required pattern as signing and evidence. The objects are neutral:
key bindings serve any evidence consumer, capability grants serve confidential local tasks,
authorization statements serve any two-party binding. Neither protocol package imports the
trust layer (IRIs and digests remain structural); bindings and applications consume it.

## 5. Identity model

The durable identity is the **Agent IRI**, exactly as Evidence §5.1 defines it: minted once
(`urn:uuid:` at bootstrap, or a persistent IRI where one exists), never rotated, never a key,
address, or registry entry. An operator who never touches ERC-8004 — or who runs purely
locally — has a complete, first-class identity. Nothing prevents one party from minting many
Agent IRIs; the layer does not pretend otherwise (see §10 level 3 — Sybil resistance is
economics, not identity mechanics).

Everything real attaches as auxiliary identifiers via binding evidence:

| Real identity | Canonical spelling | Binding evidence |
| --- | --- | --- |
| Safe / EOA on an EVM chain | `did:pkh:eip155:<chainId>:0x<EIP-55-checksummed>`; contract-account flagged | SIWE ceremony (§7.2): EOA via EIP-191; Safe via EIP-1271 + signed witness |
| ERC-8004 agentId | CAIP-19: `eip155:<chainId>/erc721:0x<registry>/<agentId>` | Registry facts **by composition only** (§7.2): valid only alongside an account ceremony to the same IRI |
| GitHub (machine) | Actions OIDC workflow subject (`repo:…:ref:…`) | OIDC token with key commitment (trust-on-archival; JWKS digest anchored) |
| GitHub (human) | `https://github.com/<login>` + immutable numeric ID | GitHub-mediated association — always `strength: weak` |
| Working keys | `did:key` spelling; `keyid` + full key inside the binding | The binding statement itself. A working key is never a voucher |
| Orgs / future DIDs | `did:web` / `did:webvh` | Transcribed DID document |

Standing rules:

1. **The agentId NFT is not part of core identity mechanics.** It is an on-chain discovery
   and reputation anchor, a source of binding facts, and optionally *required by a deployment
   profile* ("operators must hold a registered agentId bound to their settlement Safe") — but
   never the self. If the identity were the NFT, selling it would retroactively transfer the
   seller's execution history and reputation to the buyer; an evidence protocol cannot permit
   historical records to change referent. A transfer is an *event*: the old binding ends at
   the transfer block, a new one begins, and consumers evaluating old evidence resolve
   bindings **as of the evidence's time**. ERC-8004's own on-transfer `agentWallet`
   auto-clear is the natural re-binding trigger.
2. **`sameAs` is never used for control relationships** (Evidence §5.1's rule). The binding
   statement's closed relationship vocabulary (§7.1) is where "controls / operates /
   signs-for" live.
3. **The on-chain enforcement anchor stays the Safe address.** This layer does not push IRIs
   into Solidity; it layers identity policy above address-level enforcement and makes the
   address↔IRI join verifiable.
4. **Identity must not be liveness-coupled.** No identity assertion may require a
   currently-staked service or healthy external registry to *make* (the capture-anchor
   incident lesson); registries are evidence sources, not gatekeepers.

## 6. Signing architecture: accounts vouch, keys sign

Two jobs collide in one word "signature": **evidence** must verify offline, by anyone,
forever; **authority** ("the operator's Safe stands behind this") is an on-chain fact whose
native verification is a live contract call that can change answer after owner rotation.

The division of labor, normative:

- **Working keys sign all evidence and all authorization objects.** Every DSSE envelope —
  deliveries, verdicts, observations, bindings, authorization Statements — and the EIP-712
  adoption-authorization struct (§8.2) is signed by a working key: rotatable, possibly
  short-lived, offline-verifiable forever. Today's agent EOA becomes simply the first
  working key.
- **Accounts sign only chain-native ceremonies**: SIWE binding messages, `setAgentWallet`,
  ReCap grant messages, and actual transactions. The stateful Safe verification happens once
  per ceremony — with a signed witness — never per envelope.
- **Binding statements bridge**: account → working key → Agent IRI, time-anchored, so every
  envelope verification is an offline signature check plus one anchored binding lookup.
- **High-stakes standing ceremonies** (a launcher opening a fleet) MAY additionally use the
  Safe's on-chain message approval (`SignMessageLib`) as the strongest ceremony form.

Rejected alternatives, recorded: profiling EIP-1271 into DSSE (every verification becomes
chain-state-dependent and retroactively fragile; no tooling will ever verify it), and the
status quo plus documentation (the EOA stays effectively un-rotatable; the #1401 class stays
reachable; harness-key delegation has no home).

## 7. The key-binding statement

### 7.1 Record

A sealed record — I-JSON, media type `application/vnd.jinn.trust.key-binding.v1+json`, sealed
per TEP §6.1 — DSSE-signed **by the working key being bound** (TEP §21.2's signed-record
rule; a binding is a first-class record about identities, not an assertion about existing
artifacts). The envelope signature proves possession of the working key only; **binding
authority comes exclusively from the ceremony** — countersignature semantics. A binding
accepted on its envelope signature alone is a conformance failure (negative fixture, §16).

| Field | Content |
| --- | --- |
| `protocol` | trust-layer format URI |
| `agent` | the Agent IRI |
| `key` | the bound working key: full public key + `keyid` + algorithm (+ `did:key` spelling) |
| `voucher` | the vouching identity, canonical spelling per §5. **Only §7.2 ceremony types confer voucher authority; a working key is never a voucher** |
| `relationship` | closed vocabulary: `controls` \| `operates` \| `signs-for` |
| `scope` | closed vocabulary of record families this key may sign for this Agent: `deliveries`, `verdicts`, `observations`, `authorizations`, `bindings` — plus namespaced extensions. `bindings` scope licenses exactly two acts: countersigning IRI-consent (§7.4a) and signing revocations (§7.4b) |
| `validFrom` / `expiresAt?` | validity window; expiry bounds a stolen key's blast radius even without revocation |
| `ceremony` | embedded or digest-referenced ceremony evidence (§7.2) |
| `strength` | **derived from the ceremony type, never producer-asserted**: account ceremonies and OIDC machine ceremonies are `strong`; GitHub-human is `weak` |
| `supersedes?` | digest of the binding this replaces |
| `consent?` | IRI-consent countersignature (§7.4a) where required |
| `anchors` | time-anchor references (§7.3) |
| namespaced extensions | TEP §21.3 rules |

### 7.2 Ceremonies

The SIWE profile pins a dedicated ceremony `domain` and `uri` (so a binding ceremony can
never be cross-replayed as a web login or vice versa), and `resources` = [the Agent IRI, the
working key's `did:key` URI] — both RFC 3986 URIs, as EIP-4361 requires.

| Voucher | Ceremony | Evidence |
| --- | --- | --- |
| EOA | Profiled SIWE message; nonce, issued-at, expiration | Message bytes + EIP-191 signature — offline-verifiable forever |
| Safe | The same SIWE message, EIP-1271-signed (SafeMessage wrap) | Message + signature + **mandatory signed witness** (§7.2a). Optionally `SignMessageLib` on-chain approval for standing bindings. ERC-6492 admitted for counterfactual Safes (its witness requires deploy-simulation re-execution — strictly harder; named cost) |
| ERC-8004 agentId | Registry facts — **valid only by composition**: the agentId's owner or `agentWallet` address MUST itself hold a valid account-ceremony binding to the *same* Agent IRI covering the same time. Registry facts alone never vouch an IRI | `ownerOf` + `getAgentWallet`-at-block + the `setAgentWallet` tx hash. Composition makes competing claims resolvable: the IRI whose account ceremony holds wins; an agentId binding without the account leg binds nothing |
| GitHub machine | Actions OIDC token with the working key committed (OpenPubkey/Fulcio shape) | Token + JWKS reference. Honestly **trust-on-archival**, not offline in the EOA sense: after provider key rotation, verification depends on the archived JWKS — its digest MUST be anchored at binding time |
| GitHub human | Login + immutable numeric ID association | GitHub-mediated; always `strength: weak` |

**The ceremony↔record match is mandatory.** Verification (§7.5 step 3) MUST compare the
ceremony message's contents field-for-field against the record: the SIWE `resources` Agent
IRI equals `agent`; the `resources` `did:key` equals `key`; for ReCap ceremonies (§8.1) the
capabilities equal the statement's. A mismatch means the ceremony binds nothing — this is
what prevents lifting a victim's genuine ceremony into a binding for a different key or IRI.
The real replay defense for ceremonies is this content match plus validity windows, not SIWE
nonce tracking (which assumes a relying-party nonce store that offline verification does not
have).

### 7.2a The 1271 witness

A witness is not bare data. It is a **DSSE-signed statement** by a witness identity —
`{chainId, blockNumber, blockHash, isValidSignature result, verifier}` — and
**witness-verifier acceptability is a §9 policy purpose** (the same machinery as verifier
agents, R16). A consumer that does not accept the witness author has exactly one fallback:
re-execute `isValidSignature` at the witnessed block, which requires an archive node — a real
cost, named here, and the reason witnesses from policy-accepted verifiers are the practical
path. Anchoring proves *when* the witness existed; the witness signature is what makes its
*content* attributable; neither substitutes for the other.

### 7.3 Time anchoring

The binding's digest receives a **time anchor**. Anchor surfaces are designated by the
deployment profile, but MUST provide: append-only writes, tamper-evidence, and a consistent
observable order for all consumers. (One conforming candidate that satisfies §5 rule 4's
liveness-decoupling: a bare calldata anchor transaction from any funded key — no staked
service, no registry authorization required. The registry `setMetadata` surface is
conforming only where the writer's authorization is currently live.)

**Effective time.** For at-time resolution, a binding's effective start is
`max(validFrom, anchor time)` — an unanchored or later-anchored binding never covers earlier
evidence. This kills back-dated attribution: anchoring today with `validFrom` last year
gains nothing. Under profiles that require anchors, an unanchored binding is
**non-resolvable** for at-time queries. Where two bindings conflict over the same (key,
agent) pair, the earlier-anchored binding wins and the conflict is surfaced to policy.

The marketplace profile REQUIRES time anchors for Safe-ceremony bindings specifically — the
anchor plus the signed witness is what stays trustworthy against later owner rotations.

### 7.4 Rotation, consent, and revocation (protocol content)

**(a) IRI consent.** The genesis binding of an Agent IRI stands alone — it is how the IRI
enters the world. Every *subsequent* binding that attaches a new voucher account or new
working key to an existing IRI MUST carry one of:

1. a voucher account that already holds a valid `controls` binding to that IRI
   (self-extension: my own Safe vouches my next key — the account is the incumbent
   authority); or
2. a `consent` countersignature by a working key already bound to that IRI with `scope:
   bindings` (cross-account attachment: a new account joining the IRI needs incumbent
   consent).

Consumers MUST reject subsequent bindings satisfying neither. This closes the
hostile-attachment attack (an attacker's genuine ceremony attaching *their* account to
*your* IRI binds nothing), and it bounds delegation laundering: minting successor bindings
requires either the incumbent account ceremony or a `bindings`-scoped key — operators SHOULD
reserve `bindings` scope for a cold, rarely-used key.

**(b) Revocation.** A revocation statement (companion record) is valid only when signed by:
the binding's voucher account via a fresh ceremony, or a currently-valid working key of the
same Agent with `scope: bindings`. Trade-off named: a compromised `bindings`-scoped key can
revoke the Agent's bindings (denial of service, recoverable via the voucher-account path);
that is why the scope should live on a cold key. Revocation is **never retroactive**: its
effect starts at its own anchor time; evidence signed before revocation stays attributed
(and the stolen-key residual is stated in §14).

**(c) Rotation events.**

- *Working-key rotation*: seal a new binding (consent rules above; optionally `supersedes`).
  Identity, history, reputation ride the Agent IRI, untouched.
- *Safe owner/threshold change*: a Safe-ceremony binding whose witness precedes a known
  owner-set change MUST NOT support evidence signed after that change; the operator issues a
  fresh binding with a fresh witness. Historical attribution is unaffected.
- *agentId transfer*: the registry auto-clears `agentWallet`; the composition leg (§7.2)
  fails from the transfer block, ending the agentId binding; the new owner establishes fresh
  bindings. At-time resolution keeps history attributed correctly.
- *Root-of-trust artifacts* rotate by the TUF pattern (§9).

This model is what structurally closes the #1401 incident class: no identity is welded to an
unrotatable key, and divergence between anchoring and settlement identities becomes
detectable (both are declared, bound identities of one Agent).

### 7.5 Verification procedure (normative)

Given an envelope signed by key K claiming Agent IRI A:

1. Verify the DSSE envelope offline against K.
2. Resolve the binding for the **pair (K, A)** — never by key alone (one key may hold
   bindings to several IRIs; the claim names which is in play) — **at the evidence's
   effective time**, anchor-ordered per §7.3. Under anchor-requiring profiles, unanchored
   bindings do not resolve.
3. Verify the ceremony evidence, including the **mandatory content match** (§7.2): offline
   for EOA; witness-signature plus policy-accepted witness (or archive re-execution) for
   Safe; composition (account leg to the same IRI) for agentId; anchored-JWKS for OIDC.
4. Check the validity window, `scope` (the envelope's record family must be in scope),
   consent chain (§7.4a) for non-genesis bindings, and absence of anchored revocation.
5. Apply the deployment's trust policy (§9) to the vouching identity. (Exception: policy-
   chain verification itself never recurses into this step — §9.)

Rungs stay separate (Evidence §6.10): a valid binding never implies trust.

### 7.5a The settlement join check (R13)

Where a deployment must join an evidence signature to an on-chain actor (the verdict's DSSE
key to the settling Safe): resolve the binding for (envelope key, claimed evaluator IRI) at
the **envelope's** effective time with `scope` covering the record family and `relationship`
∈ {`controls`, `signs-for`}; resolve the settling Safe's binding to the same IRI, valid at
the envelope's time and not revoked at claim time. Both legs must land on the same Agent
IRI. Divergent times or missing legs fail the join — no partial credit.

### 7.5b Requester authentication (R5/R14)

A signed Submission authenticates its `requester` IRI by the same procedure: verify the
Submission's DSSE envelope against its key, resolve (key, requester IRI) at the Submission's
sealing time with `scope: authorizations` or `signs-for`, then apply policy. Capability-grant
resolution (§8.3) and evaluation-task sealer authority both build on this check.

## 8. The authorization statement family

### 8.1 The general object

An **authorization statement** is an in-toto Statement (DSSE, signed by a working key whose
binding covers `scope: authorizations`) carrying UCAN's semantics:

| Field | Content |
| --- | --- |
| issuer | Agent IRI (its signing key bound per §7) |
| audience? | Agent IRI or identity class |
| subjects | the digest-bound objects concerned (task digest, envelope digest, input descriptor, Submission digest) |
| capabilities | capability strings paired with subjects. **Attenuation order, defined**: capability comparison is exact-string set inclusion — a delegate's capability set MUST be a subset of its parent's, no wildcard semantics, no qualification arrays (deliberate simplification of ReCap's `att` structure; anything else is invalid) |
| expiry + nonce | freshness and replay bounds |
| proofs | digest references to parent authorizations — attenuation-only per the order above |
| revocation | companion statement, except where a form is declared irrevocable (§8.2) |

When the issuer is a wallet, the statement embeds a **SIWE + ReCap ceremony** — the wallet
signs one human-readable capability message, and the statement transcribes it (content match
mandatory, §7.2).

Identity-level delegation ("key K may sign deliveries for operator O") deliberately does
**not** use this object — that is the binding's `scope` (§7.1). Bindings answer "who may sign
as me"; authorizations answer "what I authorize to happen." (This deviates in letter from
TEP §20's "signed statements (in-toto)" phrasing for delegated authority; the deviation is
recorded as a carried TEP wording amendment.)

### 8.2 The open-fleet adoption authorization (dual representation)

**This is a marketplace deployment-profile object defined with trust-layer machinery** — its
tuple carries binding-native and application identifiers (`taskId`, `attemptIndex`,
`requestId`, `resultingHead`), so its schema and fixtures live in the marketplace tree, not
in `trust-core` (§17). The trust layer contributes the identity and signature semantics.

Two deterministically-interconvertible forms:

- **Enforcement form**: an **EIP-712 typed struct** over
  `{role, taskId, attemptIndex, requestId, envelopeDigest, resultingHead, reviewGeneration?,
  expiry, nonce}`, signed secp256k1 by the adopter authority's **working key** (bound per §7
  to the launcher/adopter Agent IRI, `scope: authorizations`). A future
  Router/TaskCoordinator policy hook verifies with `ecrecover` against an **on-chain
  expected-signer slot settable by the launcher Safe** (rotation of the working key = a Safe
  transaction updating the slot — the constraint is named here so the future contract design
  does not re-import the #1401 shape; the contract itself remains out of scope).
- **Evidence form**: the in-toto authorization Statement derived from the same tuple,
  carried in the evidence graph. A defined bijection connects the forms; fixtures pin it (in
  the marketplace tree).

**Lifecycle is identical in both forms: irrevocable-until-expiry.** Expiry is the only
kill-switch — keep expiries short. (A revocable evidence form beside an
expiry-only-checking chain hook would let two conforming consumers reach opposite
conclusions about one authorization; declaring irrevocability restores the bijection over
lifecycle, not just content.) Nonce uniqueness: on-chain, the tuple is effectively
single-use (`envelopeDigest`/`attemptIndex`); off-chain consumers track consumed tuples.

Head staleness resolves by construction: the authorization binds an exact head plus expiry; a
superseded head means it is never consumed; the hook checks tuple-equality and expiry only
and never needs a view of GitHub. The GitHub adoption receipt survives as closed-fleet
convenience; `receiptAuthors` becomes a trust-policy entry (§9), not capsule content.

### 8.3 Capability grants

The Submission's `capabilityGrants` map stays `{inputName → grantRef}` (an opaque URI). What
a grantRef resolves to is now defined: a **grant record** — an authorization statement issued
by the resource controller, audience = the backend (or executor class), subjects = the named
input's digest **and SHOULD include the Submission's digest** (binding use to a dispatch;
the Submission exists pre-dispatch, unlike the Attempt URI), capabilities = the access
verbs, bounded by expiry, revocable, delegable by attenuation.

The backend's resolution obligation (the check TEP §7.5 demanded but never specified):

1. the grant's issuer is **bound to the Submission's authenticated requester IRI** (§7.5b);
2. the grant **covers the named input digest** (and, where present, the Submission digest);
3. the grant is unexpired and unrevoked;
4. the redeemer authenticates as the grant's audience (the R18 caller-authentication slot,
   §11);
5. then provision scoped access — and only then.

A leaked Task plus a leaked Submission yields nothing: the replayer's requester identity does
not match the grant issuer's binding. Grant use leaves an audit trail — the resolved input
lands in Execution Evidence as a consumed input, and the dispatch-context artifact binds it
to the Attempt — **for honest backends**; a malicious *authorized* backend redeeming its
grants out-of-band is a named residual (§14), bounded by expiry and Submission-scoping.

## 9. Trust-policy documents

**One policy shape replaces every allowlist.** A trust-policy document is a sealed, versioned
record (`application/vnd.jinn.trust.policy.v1+json`) a deployment publishes, declaring per
**purpose** which **Agent IRIs** are acceptable and what binding strength they require.
Purpose identifiers are namespaced (core registers: `adoption-authority`, `admission-agent`,
`verifier-agent`, `witness-verifier`, `parser-registry`, `receipt-author`, `plugin-signer`,
`dispatcher-author`, `evaluator-eligibility`; deployments extend under their own
namespaces). Entries name IRIs, never keys or logins — with one deliberate exception below.

**Versioning is the TUF pattern**: documents form a hash-linked version chain; version N+1
MUST be signed by thresholds of **both** the old and the new signer sets. **Signer sets are
working keys listed in the previous version** — TUF-native, and the one sanctioned exception
to "entries name IRIs": the chain must be verifiable without recursing into binding
resolution. Policy-chain verification therefore terminates at the genesis ceremony and
**never invokes §7.5 step 5 on its own signers** (otherwise the policy would be needed to
verify the policy). The genesis version's authority is established by a deployment-authority
ceremony (e.g. the launcher Safe signs the genesis policy via SIWE), and the true root of
trust is how consumers obtain the deployment profile that references the chain — an
out-of-band fact, named honestly.

**Freshness (the TUF timestamp role, adopted).** Every policy version carries a `refreshBy`
time. Consumers MUST reject an expired policy version and MUST never accept a version lower
than one they have already seen (anti-rollback). The deployment profile's by-digest
reference pins the **chain genesis**; consumers walk forward to the newest fresh version. A
removed authority therefore ages out at the next `refreshBy` even if stale mirrors keep
serving old versions. Residual, named: compromise of a threshold of the *current* signer set
seizes the chain — recovery is out-of-band re-bootstrap, exactly as TUF itself states for
root-threshold compromise.

**Credit-regime declaration** (optional, namespaced block; resolving tension T7): a
deployment MAY declare each credit stream it operates as **loop-completion**
(verdict-code-agnostic; no grader-honesty controls required) or **pass-gated** (Pass
verdicts treated as value — activating the profiles design's mandatory private-grader
controls and B.2 economics). Local deployments simply omit the block.

## 10. The independence model

Three levels, named honestly:

1. **Address-distinct** — what the chain enforces (`evaluator != attempt.operator` on Safe
   addresses). Unchanged.
2. **Agent-distinct** — a **declared-identity check**, not an open-world search: a deployment
   profile enforcing `distinctEvaluator` REQUIRES each participating Safe to declare its
   Agent IRI (verified by binding, resolved **at claim time**, policy-acceptable under
   `evaluator-eligibility`). Distinctness compares declared-and-verified IRIs; undeclared or
   unverifiable participants **fail closed**. This closes the two-Safes-one-operator bypass
   *for identities the profile forces to be declared* — the standard two-Safe topology makes
   that bypass the default today, not an exploit. An operator who withholds bindings or
   mints fresh IRIs falls into level 3's residual, and the `evaluator-eligibility` policy
   purpose (which fresh, historyless IRIs do not satisfy) is the backstop.
3. **Party-independent** — real-world independence. **Not provable by this layer**; absence
   of a shared binding is not evidence of independence (the Sybil residual the tokenless
   design names as irreducible). This level belongs to B.2 evaluator economics and the
   challenge mechanism; this layer's contribution is stable identities for stakes,
   penalties, and reputation to attach to.

The GitHub plane stays sealed off (R19): logins never cross into protocol identity;
Autopilot's reviewer≠author invariants remain deployment-internal; the open-fleet path runs
through §8.2, not through login allowlists.

## 11. Thin slots (defined, deliberately shallow in v1)

- **Reviewer-qualification claims (R15)**: attestations from policy-accepted accreditation
  issuers, authorization-statement-shaped. The slot exists; the accreditation ecosystem is
  future work.
- **Signed observations (R17)**: observation producers are bound identities; deployment
  profiles toggle the DSSE requirement where spoofed sources matter (multi-party
  transports).
- **Backend caller authentication (R18)**: API callers — including grant redeemers (§8.3) —
  authenticate as bound identities; the existing ERC-8128 wallet-signed HTTP pattern,
  generalized to Agent-IRI resolution.

## 12. Requirements register disposition

| R | Requirement | Disposition |
| --- | --- | --- |
| R1 | Key→Agent binding (ladder rung 4) | §7 binding statement + §7.5 procedure |
| R2 | External-identity mapping profile | §5 table |
| R3 | `sameAs` vs control relationships | §7.1 relationship vocabulary |
| R4 | Consumer trust policy | §9 policy documents |
| R5 | Requester authentication | §7.5b |
| R6 | Capability-grant authority | §8.3 grant records + resolution rule |
| R7 | Delegated authority to harness keys | §7.1 binding `scope` (TEP §20 wording amendment recorded, §8.1) |
| R8 | Open-fleet adoption authorization | §8.2 dual representation |
| R9 | Receipt-author authority | Demoted to §9 policy entry (closed-fleet convenience) |
| R10 | Admission-agent acceptability | §9 policy-listed IRIs |
| R11 | Private-grader credit controls | §9 credit-regime declaration activates them |
| R12 | Evaluator ≠ solver identity basis | §10 declared-identity model |
| R13 | Verdict signing key ↔ settling Safe | §7.5a join check |
| R14 | Evaluation-task sealer authority | §7.5b + §8.3 |
| R15 | Reviewer qualification | §11 slot |
| R16 | Verifier-agent authority | §9 policy purposes (`verifier-agent`, `witness-verifier`) |
| R17 | Signed observations | §11 slot |
| R18 | Caller authentication | §11 slot; consumed by §8.3 step 4 |
| R19 | GitHub plane containment | §10; logins never cross into protocol identity |
| R20 | Operator anchor + activity attribution | §5 rule 3: Safe stays the enforcement anchor, joined to IRIs by bindings |

## 13. Verification walkthroughs

**Old verdict after key rotation.** A 2026 verdict envelope is audited in 2028. The evaluator
rotated working keys twice since. Verification: DSSE offline against the 2026 key; the
binding for (that key, the claimed evaluator IRI) resolved at the envelope's effective time
via anchors — the 2026 binding, superseded but valid then; ceremony content match passes;
window, scope, consent chain, no revocation; policy accepted the evaluator IRI then. The
§7.5a join to the settling Safe lands on the same IRI. Verdict stands, attribution intact.

**Open-fleet adoption settlement.** A non-official operator delivers. The future hook checks
the EIP-712 signature against the launcher-Safe-settable expected-signer slot and the exact
tuple + expiry; off-chain consumers check the Statement twin, resolve the signing key's
binding to the launcher IRI, and check the launcher against the fresh policy chain. No
GitHub login is consulted anywhere; revocation is not consulted either — the form is
irrevocable-until-expiry by design.

**Confidential input, leaked documents.** An attacker replays a leaked Task + Submission.
`submit` authenticates the requester (§7.5b); the grant's issuer binding does not match the
attacker's IRI; resolution fails closed with `access-denied`. The attacker holds bytes, not
authority.

**Two-Safe evaluator distinctness.** A deployment profile requires declared Agent IRIs. An
operator's fleet Safe solves; its staking Safe claims the evaluation, declaring an IRI. Both
Safes' verified declarations resolve to the same Agent IRI → one party →
`distinctEvaluator` unsatisfied. Had the operator declared a fresh, unbound IRI instead, the
`evaluator-eligibility` policy purpose (no history, not listed) rejects it — and an operator
evading both is in the §10 level-3 residual, which this layer does not claim to close.

## 14. Security and adversarial considerations

- **Forged or lifted ceremonies**: authority comes only from ceremonies; the mandatory
  content match (§7.2) makes a lifted ceremony bind nothing (its `resources` name the
  original IRI and key); Safe ceremonies additionally require policy-accepted signed
  witnesses.
- **Hostile attachment**: attaching a new account or key to an existing IRI requires
  incumbent authority (§7.4a); an attacker's genuine ceremony over their own account cannot
  join a victim's IRI.
- **agentId hijack**: registry facts vouch nothing without the composition leg (§7.2); a
  fresh IRI claiming a reputable agentId fails composition; competing claims resolve to the
  IRI holding the account ceremony.
- **Witness fabrication**: witnesses are signed statements from policy-accepted verifiers;
  the skeptic's fallback is archive re-execution, with its cost named (§7.2a).
- **Back-dating**: effective start = `max(validFrom, anchor time)`; unanchored bindings
  don't resolve under anchor-requiring profiles; earlier-anchored wins conflicts (§7.3).
- **Stolen working keys**: bounded by `expiresAt`, `scope`, and revocation; **residual,
  stated**: evidence signed between theft and anchored revocation verifies and attributes to
  the victim's IRI — revocation is never retroactive (retroactive revocation would reopen
  the back-dating door in reverse). Keep working keys short-lived; keep `bindings` scope on
  a cold key.
- **Delegation laundering**: working keys are never vouchers; successor bindings require
  incumbent authority; a stolen `bindings`-scoped key is a bounded DoS (revocation),
  recoverable via the voucher-account path.
- **Retroactive 1271 flapping**: witnesses freeze verification at a block; a witness older
  than a known owner-set change supports no later evidence (§7.4c); owner rotation
  invalidates future reliance, never historical attribution.
- **NFT purchase ≠ identity purchase**: at-time resolution keeps history attributed to the
  party that did the work; composition fails from the transfer block.
- **Authorization widening**: exact-string subset attenuation (§8.1); wider chains are
  invalid; fixtures pin it.
- **Policy capture and rollback**: dual-threshold chaining, `refreshBy` freshness,
  monotonic-version rule; residuals named — current-threshold compromise requires
  out-of-band re-bootstrap; the ultimate root is profile distribution.
- **Honest limits, stated**: agent-distinctness is a declared-identity check — withheld
  bindings and fresh IRIs land in the Sybil residual (B.2), backstopped only by
  eligibility policy; GitHub-human bindings are weak evidence; OIDC ceremonies are
  trust-on-archival; capability grants protect against *unauthorized* access, not against a
  malicious authorized requester **or a malicious authorized backend** (bounded by expiry
  and Submission-scoping); nothing here scores trustworthiness — policy says *acceptable*,
  evidence says *what happened*, and the gap stays visible.

## 15. Impact on existing interfaces (declared)

This design supersedes: hard-coded acceptance lists (`receiptAuthors`, the official-profile
policy, dispatcher author allowlists, plugin trusted-signer lists) with trust-policy
documents; self-asserted envelope `participant` fields with binding references; and the
implicit EOA-signs/Safe-settles relationship with declared, bound identities under one Agent
IRI. It defines the rotation, consent, and re-binding semantics whose absence caused the
#1401 incident class, and the authorization object that replaces GitHub authorship as
settlement authority for the open fleet. Two carried wording amendments are recorded for
absorption: TEP §20's delegated-authority phrasing (now binding `scope`, §8.1) and the
Evidence/TEP scheme-IRI registrations (§20 follow-ups). No smart-contract changes, no
protocol-record changes, and no migration steps are part of this specification;
implementation planning owns sequencing.

## 16. Conformance and fixtures

In the trust packages (§17), extending the established golden/adversarial pattern:

- schema validation for binding, revocation, authorization, and policy records;
- ceremony goldens: EOA SIWE, Safe 1271 + signed witness, `SignMessageLib` approval, OIDC
  machine binding (anchored JWKS), agentId composition;
- at-time resolution: anchor ordering, `max(validFrom, anchorTime)` effective start,
  conflict resolution, unanchored-binding non-resolution under anchor-requiring profiles;
- consent chains: genesis, self-extension, cross-account consent, missing-consent rejection;
- revocation: authorized signers, unauthorized rejection, non-retroactivity;
- the §7.5a join and §7.5b requester checks, positive and negative;
- adversarial: lifted-ceremony content mismatch; hostile attachment; agentId claim without
  composition; unsigned/fabricated witness; back-dated `validFrom`; binding accepted on
  envelope signature alone (MUST fail); scope violations; attenuation widening;
  grant issuer-mismatch, leaked-document replay, audience-authentication failure; policy
  rollback, expired policy, missing dual-threshold, competing genesis;
- the §13 walkthroughs as executable integration fixtures.

The adoption authorization's schema and EIP-712↔Statement bijection fixtures live in the
marketplace tree (§8.2), not here.

## 17. Package and repository structure

The trust layer serves both protocols, so it sits beside them, split by I/O:

```text
packages/trust/
  core/      @jinn-network/trust-core     schemas, sealing, validators, policy-chain
                                          verification, ceremony content-match checks,
                                          and the §7.5 procedure implemented against
                                          injected resolver/anchor interfaces. No I/O.
  resolve/   @jinn-network/trust-resolve  implements those interfaces: chain-fact
                                          resolvers (ownerOf, getAgentWallet-at-block,
                                          promoting the existing publisher-safe-resolver),
                                          1271 witness verification and archive
                                          re-execution, anchor lookups. RPC-dependent.
  testing/   fixtures + conformance kit.
```

The §7.5 split, stated: steps 1, 4, 5 and EOA/ReCap ceremony verification are I/O-free
(`core`); steps 2–3's anchor and chain lookups go through `core`-defined interfaces that
`resolve` implements. `core` depends on nothing Jinn; it re-implements TEP §6.1 sealing and
DSSE handling, and the kit carries **cross-package sealing-equivalence fixtures** against the
task-execution and evidence implementations to hold the drift risk at zero. Evidence and
task-execution packages never import trust; bindings, deployment profiles, and applications
consume it. The graph stays acyclic. The adoption-authorization object lives in the
marketplace tree (§8.2).

## 18. Recommended delivery sequence

Dependency-forced order; implementation planning happens later:

1. **trust-core** — record formats, ceremony content-match, consent/revocation rules, the
   §7.5/§7.5a/§7.5b procedures, fixtures.
2. **trust-resolve** — at-time resolvers, witness verification, anchor lookups.
3. **Identity establishment** — Agent IRI minting and genesis bindings in the operator
   bootstrap (the point where the #1401 class closes).
4. **First policy documents** — replacing `receiptAuthors` and the official-profile policy,
   with freshness and chain rules.
5. **DSSE convergence with binding references** — with the TEP marketplace-binding work.
6. **Adoption authorization** — issued and checked closed-fleet in the marketplace tree; the
   Solidity policy hook (with its launcher-settable expected-signer slot) is a
   separately-designed future marketplace change.
7. **Grant resolution** in backends (unblocks confidential tasks and private graders).
8. **Verifier/admission-agent/witness-verifier policy integration** — staging for B.2.

## 19. Explicit non-goals

This specification does not define: reputation scoring or aggregation; Sybil-resistance,
challenge, or evaluator economics (Phase B.2); accreditation ecosystems for human reviewers;
any smart-contract change; DID resolution infrastructure; Verifiable Credential issuance
(projection only); key custody, HSM, or seed-management operational guidance; migration or
rollout sequencing beyond §18's dependency order.

## 20. Non-blocking follow-ups

- **ERC-8004 v2 tracking** — the registry is Draft with a planned v2; the §5 mapping
  isolates Jinn from schema churn, but the CAIP-19 spelling should be revalidated at v2.
- **The Solidity adoption-authorization hook** — a marketplace contract design consuming
  §8.2's enforcement form, including the launcher-settable expected-signer slot.
- **Scheme IRIs** — register the `identifier` `propertyID` IRIs for did:pkh, did:key,
  CAIP-19, and GitHub spellings stamped into Evidence entities (shared follow-up with TEP
  §28 and the profiles design §17), plus the TEP §20 wording amendment (§8.1).
- **VC 2.0 projection** — a mechanical binding-statement → VC transform when external SSI
  interop is wanted.
- **did:webvh org identities** — when organizational operators need verifiable-history
  DIDs.
- **Reputation and Validation registry integration** (ERC-8004) — Phase B consumers of the
  identity substrate.
- **Anchor-surface unification** — the bare-calldata candidate suffices; a dedicated
  minimal anchor could later serve all record families uniformly.

## Appendix A. Sources used for the design audit

**This branch (`claude/task-execution-protocol-design-d04746`):**
`docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md` (§5.1, §6.10,
§7–§8, §15–§16);
`docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (§6.2, §8,
§16.2, §20, §21.2, §25, §28);
`docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` (§5.2, §7.5,
§7.6, §9, §17);
`docs/superpowers/specs/2026-07-23-autopilot-v2-marketplace-session-backend-design.md` (§4,
§6.2, §9, §13–§14);
`docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md` (I1–I3);
`spec/2026-06-30-tokenless-olas-native.md` (§3–§4, §7, §12);
`docs/operator/rotating-harness-keys.md`.

**origin/next (production behavior, via `git show`):**
`client/src/earning/{wallet,store,bootstrap,safe-adapter,types}.ts` and
`client/src/earning/steps/{fleet-safe-predict,fleet-identity-register}.ts`;
`client/src/erc8004/{addresses,identity,agent-wallet-binding,publisher-safe-resolver}.ts`;
`client/src/solvernets/{registry-client-erc8004,manifest}.ts`;
`client/src/tasks/signing.ts`; `client/src/harnesses/engine/{signing,envelope-assembly}.ts`;
`client/src/adapters/mech/{adapter,contracts}.ts`;
`client/src/autopilot/{official-profile-policy,github-adoption-receipt-observer,marketplace-delivery-observer,autopilot-evaluation-context-resolver}.ts`;
`packages/autopilot/src/lifecycle/{credentials,active-runtime-production}.ts`;
`packages/layer/src/bridge-fetch-evidence.ts`; `client/src/eval/attribution-verdict-evidence.ts`;
`client/src/auth/erc8128.ts`; `client/src/conformance/checks/hash-signature.ts`;
`contracts/src/tasks/TaskCoordinator.sol`; `contracts/src/staking/JinnRouterV3.sol`;
`client/src/harnesses/{manifest/verify.ts,external-impls/loader.ts}`;
`client/src/solver-types/migrate-agent-id.ts`.

**GitHub issues:** #1401 (closed — the rotation-wedge incident whose class this design's
rotation model addresses), #280 (agentId ↔ service Safe binding), #1355 (B.2 evaluator
economics), #1430 + #2041 (attested tier / effective-execution attestation), #2044/#2045
(authoritative and authenticated evidence), #1564 (unwired admission gate — fail-open
precedent), #1963, #642.

**Standards (primary sources, fetched 2026-07-27; versions pinned):**
CAIP-2 (Final), CAIP-10 (Final), CAIP-19 (Review), CAIP-122 (Review), CAIP-74 CACAO (Review;
container rejected), eip155 CAIP-122 namespace (Draft); did:pkh (CCG Draft), did:key (CCG
v0.9), did:web (CCG), did:webvh v1.0 (DIF), did:ethr (DIF; rejected as dependency); W3C DID
1.0 (Rec 2022) / DID 1.1 (CR 2026-03-05); W3C VC 2.0 (Rec 2025-05-15; projection target
only); UCAN 1.0 (semantics adopted, container rejected; Jinn defines its own attenuation
order); EIP-4361 SIWE (Final; resources-as-URIs and per-protocol expected-value checking
verified), EIP-712 (Final), EIP-191 (Final), EIP-1271 (Final), ERC-6492 (Final), EIP-5573
ReCap (Draft; `att` structure deliberately flattened); ERC-8004 (Draft; mainnet reference
deployment 2026-01-29; `setAgentWallet` EIP-712/1271 authentication and on-transfer
auto-clear verified against the draft text; v2 planned); DSSE v1.0.2; in-toto Statement v1;
Sigstore/Fulcio + Rekor (shape only); TUF spec v1.0.35 (rotation and timestamp-role
freshness both adopted); OpenPubkey (Linux Foundation); Safe smart-account signature
documentation (SafeMessage, CompatibilityFallbackHandler, SignMessageLib).
