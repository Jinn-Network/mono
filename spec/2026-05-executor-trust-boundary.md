# Executor Trust Boundary — Technical Spec

> Version: 1.2
> Date: 2026-04-27 (rev 2026-04-28: vocabulary — "plug-in" → "external impl")
> Author: Ale (rev: opus on jinn-mono-7zz)
> Status: Proposed (not yet adopted)
> Supersedes: v1.1 (vocabulary-only retarget); v1 (2026-05-04) added
> §5.6 revocation (signer untrust, manifest revoke, maintainer
> revocation list, trust-pin expiry, and quarantine semantics for
> revoked impl state)
> Informs: `jinn-mono-7zz` (first-class operator-supplied restorers / external-impl flow)
> Audit: `jinn-mono-j75` §7.2.4, §8 decision #3
> Sibling specs: `spec/2026-05-schema-versioning.md`, `spec/2026-05-registry-discovery.md`, `spec/2026-05-external-restorer-impls.md`

> Vocabulary status: this spec predates
> `spec/2026-05-01-harness-pack-architecture.md`. Read
> `RestorerImpl` as `Harness`, `RestorationContext` as `HarnessContext`,
> `RestorationOutput` as `Solution`, `intentCid` as `taskCid`, and
> `client/src/restorer/` as `client/src/harnesses/`. The old terms remain
> below only to preserve the original decision record.

## Vocabulary note (2026-04-28)

v1.2 retargets "plug-in" → "external impl" throughout, matching the
codebase's `RestorerImpl` / `impl` vocabulary and avoiding collision
with the unrelated existing `jinn plugin install` verb (which
installs the Jinn MCP server / skill into AI hosts). The
trust-boundary contract is unchanged.

## 1. Purpose and scope

This spec defines the **trust boundary between the Jinn daemon and a
restorer/evaluator implementation** (`RestorerImpl`, `client/src/restorer/types.ts`).

It answers three questions a downstream implementer must be able to
read off of one document:

1. What credentials, network access, and filesystem access does the
   daemon hand an impl?
2. What MUST the daemon never expose to an impl?
3. How does the daemon decide an impl is allowed to load in the first
   place (provenance), and what is the install-time vs runtime split?

The boundary established here is the contract `jinn-mono-7zz`
(operator-supplied external impls) builds against. It is intentionally
conservative: a Phase 1 in-process impl is treated as **untrusted code
running with the daemon's PID**. The seams below let us tighten that
to out-of-process (option C in the registry-discovery spec) without
re-cutting the API.

### 1.1 In scope

- Threat model for impls (in-process Node modules) in Phase 1.
- Credential surface: signer, RPC client, intent-specific secrets
  injected via `onEnable`.
- Filesystem surface: working dir, impl-state dir, what is read-only
  and what is writable.
- Provenance: how impls are registered, signed, and verified at
  install time vs run time, and how trust is **withdrawn** when a
  signer or specific manifest must be invalidated (§5.6).
- Forward-compatibility seams for moving impls out-of-process (MCP /
  HTTP service) without breaking the contract.

### 1.2 Out of scope

- Choice between dynamic-import / fork-template / out-of-process / MCP
  for the Phase 1 external-impl mechanism — that is
  `spec/2026-05-external-restorer-impls.md`. This spec gives that
  decision a constraint set, not a verdict.
- The schema-versioning policy for `kind` strings — that is
  `spec/2026-05-schema-versioning.md`.
- Where impls live (in-repo vs config-declared vs on-chain registry)
  — that is `spec/2026-05-registry-discovery.md`.
- Master-wallet hygiene at the daemon level (keystore encryption,
  password handling, Safe deployment). This spec only covers what
  crosses the daemon → impl boundary.
- Path 1 plug-ins (`spec/2026-04-30-plug-in-surface.md` §4.3) inherit
  trust from the host harness (`claude-code-learner` impl) and do not
  carry their own capability allow-list. The trust contract this spec
  defines applies to Path 2 RestorerImpls only; Path 1 plug-ins run
  inside the harness's existing capability surface and add no
  incremental capabilities.

### 1.3 Non-goals

- Sandboxing Node.js against a determined attacker. In-process
  isolation in Node is best-effort, not a security boundary. Phase 1
  treats provenance + capability narrowing as defense-in-depth, with
  process isolation deferred to Phase 2.
- Defining a full external-impl marketplace. The provenance rules
  below cover the **single operator install path**; a multi-operator
  registry is `spec/2026-05-registry-discovery.md` Phase 2.

## 2. Threat model

Three failure modes drive the design. The numbering is referenced by
later sections.

### 2.1 T1 — Malicious impl

An impl is authored or substituted with intent to harm. Possible
goals: drain the master wallet, exfiltrate the keystore, exfiltrate
other impls' API keys (e.g. Hyperliquid api-wallet keys at
`implStateDir/<other-impl>/`), pivot to the operator's machine.

**Likely vector:** an operator npm-installs a malicious package, or a
benign package's dependency is compromised (T3 below). Less likely:
in-repo impl reviewed by the team is malicious — code review is the
mitigation there, not the daemon.

### 2.2 T2 — Buggy impl

An impl is honest but defective. It may:

- Sign a transaction it shouldn't (wrong amount, wrong recipient,
  wrong contract).
- Burn through RPC budget in a tight loop.
- Write outside its state dir (path traversal in a CID-derived
  filename).
- Leak secrets via `log()` (which the daemon persists and later may
  publish to subgraph / IPFS).

**Likely vector:** every impl at some point. Treat as the common
case, not the exception. T2 mitigations should not depend on the impl
being well-written.

### 2.3 T3 — Dependency compromise

A transitive dependency of an impl ships a malicious update (the
`event-stream` / `node-ipc` / `xz` pattern). The impl itself is
unchanged; the supply chain underneath it is poisoned.

**Likely vector:** any npm-installed impl with a non-trivial dep
graph. T3 is the reason provenance (§5) pins to a content hash, not a
version range, and the reason the runtime surface (§3, §4) is narrow
even for "trusted" impls.

### 2.4 What this spec does *not* defend against

- Operator-side compromise. If the operator's machine is owned, the
  master keystore is owned; the daemon has no countermeasure and
  shouldn't pretend otherwise.
- A determined T1 in-process impl in Phase 1. Node has no real
  capability isolation; a malicious in-process module can monkey-patch
  `fs`, walk the V8 heap, or shell out. Phase 1 makes this **harder
  and noisier**, not impossible. The §6 seams exist so Phase 2 can
  make it actually impossible.

## 3. Credential scoping

The daemon owns one master signer per service (the EOA from
`client/src/earning/`) and a Safe multisig that owns the staked
service. The boundary rule:

> An impl never sees a raw private key. An impl signs by calling
> handles the daemon issues; the daemon decides whether each call is
> permitted.

### 3.1 What the daemon hands an impl

The structured form is `RestorationContext` today
(`client/src/restorer/types.ts`). This spec adds three capability
handles to it. Each is a function-shaped object, not a config blob —
so the daemon can revoke, rate-limit, or proxy without changing the
signature.

| Handle | Purpose | Phase 1 implementation |
|---|---|---|
| `intent` | The `DesiredState` and its IPFS CID. | Frozen object; `Object.freeze` at handoff. |
| `workingDir`, `implStateDir` | Filesystem capability (§4). | Node `fs` paths, scoped at call sites. |
| `log(event)` | Structured logging into the daemon event stream. | Existing function. |
| `abort`, `msUntilEndTs()` | Window deadline. | Existing. |
| **`signer`** (new) | Scoped signer capability (§3.2). | Wrapper around the master signer with a selector allow-list. |
| **`rpc`** (new) | Scoped read-only RPC client (§3.3). | Wrapper around the public client with method + rate limits. |
| **`secrets`** (new) | Per-impl secret bag, populated by the impl's own `onEnable` flow (§3.4). | Read-only `Record<string, string>`, scoped to the calling impl. |

The rule, restated as a hard invariant:

- An impl **must not** receive: `process.env`, the parsed `Config`
  object, the keystore path or password, a raw `viem` `WalletClient`
  bound to the master EOA, any other impl's `secrets` or
  `implStateDir`.
- An impl **may** receive: the three handles above plus the existing
  `RestorationContext` fields. The daemon constructs these per-call
  and discards them when the call returns.

### 3.2 Scoped signer

`ctx.signer` exposes only the operations an impl needs to deliver a
restoration or evaluation result. It does **not** expose generic
`signTransaction` / `eth_sign`.

Phase 1 surface:

```ts
interface ScopedSigner {
  /** EOA address the daemon will sign as. Read-only. */
  readonly address: `0x${string}`;

  /**
   * Sign EIP-712 typed data for an allowed domain. The daemon
   * validates `domain` against an allow-list (e.g. exchange-specific
   * api-wallet approval payloads). Throws if the domain is unknown.
   */
  signTypedData(args: SignTypedDataArgs): Promise<`0x${string}`>;

  /**
   * Send a transaction whose `to` + 4-byte selector pair is on the
   * impl's allow-list. The daemon constructs the tx envelope, sets
   * gas, and signs. The impl never sees the raw key.
   */
  sendAllowedCall(call: {
    to: `0x${string}`;
    data: `0x${string}`;     // selector + ABI-encoded args
    value?: bigint;          // 0 unless allow-list permits
  }): Promise<`0x${string}`>; // tx hash
}
```

Each impl declares an allow-list at registration time. The daemon
refuses to load an impl whose allow-list isn't present and refuses
calls that don't match. The allow-list is keyed by `(chainId, to,
selector)` so a single impl can hold capabilities on multiple chains
(e.g. a Hyperliquid impl with a Base-Sepolia api-wallet approval and
an Arbitrum order-router).

The allow-list lives in the impl's manifest (§5.2) and is reviewed at
install time, not negotiated at runtime. An impl cannot expand its
own allow-list; expansion requires reinstalling at a new manifest CID.

**Open question for `jinn-mono-7zz`:** whether the scoped signer is
implemented as

  (a) a JS wrapper around the master signer (Phase 1 default — easy,
      no on-chain change), or
  (b) a Safe module with the selector allow-list enforced on-chain
      (more secure, more cost, requires Safe-module governance).

This spec does not require (b), but **the API above is shaped so (b)
can replace (a) without changing impl code.** The selector allow-list
is the integration point.

### 3.3 Scoped RPC

`ctx.rpc` is a read-only RPC handle. The daemon owns the upstream
RPC connection (Base mainnet / Sepolia / etc.) and proxies impl calls
through a wrapper that:

1. Filters by JSON-RPC method. Phase 1 allow-list:
   `eth_call`, `eth_getBlockByNumber`, `eth_getLogs`,
   `eth_getTransactionReceipt`, `eth_chainId`, `eth_blockNumber`,
   `eth_getBalance`, `eth_getCode`. No `eth_sendRawTransaction`,
   `eth_sign*`, `personal_*`, `debug_*`, or provider-specific custom
   methods. Signing goes through `ctx.signer` (§3.2).
2. Rate-limits per impl (default: 30 requests / 10s, configurable per
   impl in the manifest within a hard ceiling enforced by the daemon).
3. Filters by chain. An impl declares which chains it speaks to in
   its manifest; the daemon refuses requests for other chains.
4. Strips multiplexed credentials. The upstream URL (which may carry
   an Alchemy / QuickNode key in the path) is **never** observable by
   the impl — only the parsed RPC interface is exposed.

The impl-facing shape is a `viem` `PublicClient` interface (so existing
code in `client/src/restorer/impls/` keeps working), but constructed
by the daemon with a transport that enforces 1–4.

### 3.4 Per-impl secrets

Some impls need credentials the daemon doesn't own — Hyperliquid
api-wallet private keys, an exchange API key/secret pair, an LLM
provider token. Today these are collected by the impl's `onEnable`
flow and persisted under `implStateDir/<impl>/`.

The trust-boundary rule:

- Each impl owns its own secret bag at `implStateDir/<impl>/secrets/`.
- The daemon mediates **read** access via `ctx.secrets`, scoped to
  the calling impl. An impl never reads another impl's secrets, even
  though they live on the same disk.
- Write access is via the existing `onEnable` / `onDisable` flow.
  Writes go through the daemon, which guarantees the path is inside
  the calling impl's `implStateDir`.

Impls SHOULD NOT log secrets via `ctx.log` (which is persisted and
may be published). The daemon's logging wrapper performs a best-effort
redaction pass on values that match the secret bag, but this is a
backstop, not a guarantee — see T2 above.

### 3.5 What stays daemon-internal

The daemon does not, under any circumstance, hand an impl:

- The encrypted keystore file path or its decryption password
  (`JINN_PASSWORD`).
- A constructed `WalletClient` bound to the master EOA (only the
  scoped wrappers from §3.2).
- The full `Config` object. Specific resolved values (e.g.
  `chainId`, `subgraphUrl`) MAY appear in `ctx`; secrets and paths
  outside the impl's scope MUST NOT.
- Other impls' `implStateDir`, `secrets`, or in-flight context.
- Network handles that bypass §3.3 (e.g. raw `fetch` with the upstream
  RPC URL, IPFS gateway tokens, evaluator-only RPC creds).

This is a *daemon* invariant: the daemon enforces it at the call
site that constructs `RestorationContext`. An impl that captures
references via dynamic `require` / global walks defeats the
in-process boundary; that is T1 territory and is mitigated by §5
(provenance) and §6 (out-of-process evolution), not by this list.

## 4. Filesystem scoping

Two roots, set in config:

| Config key | Default | Purpose |
|---|---|---|
| `engine.workingDirRoot` | `~/.jinn-client/engine/work` | Per-attempt scratch space. Cleared between attempts. |
| `engine.implStateDirRoot` | `~/.jinn-client/engine/impl-state` | Durable per-impl state. Persisted across attempts. |

### 4.1 Per-attempt working dir

For each attempt, the engine creates `workingDirRoot/<intent-cid>/`
(or a deterministic hash of `(intentId, attemptNonce)` when no CID is
available). This is the only path passed as `ctx.workingDir`.

Rules:
- The engine creates and removes the directory; the impl writes
  freely inside it.
- The directory is cleared before re-attempts (T2: a previous attempt
  must not leak state into the next).
- An impl MUST NOT persist anything it expects to survive across
  attempts here. Cross-attempt state belongs in `implStateDir`.

### 4.2 Durable per-impl state dir

`ctx.implStateDir = implStateDirRoot/<impl-name>/`, where `<impl-name>`
is the manifest-declared name (§5.2). The daemon creates the dir on
first use and chmods it 0700.

Rules:
- An impl reads/writes freely inside its own `implStateDir`.
- The daemon does not look inside this dir except via documented
  per-impl conventions (e.g. `secrets/`, the doctor checks in
  `client/src/api/portfolio-v0-doctor.ts`).
- Two impls never share an `implStateDir`. If two impls want to share
  state, they coordinate via the daemon (intent registry, shared
  output artifacts), not via the filesystem.

### 4.3 Phase 1 enforcement: capability wrapper

In-process Node has no real filesystem isolation; a determined T1
impl can `import('node:fs')` directly. Phase 1 mitigation is a
capability wrapper, not a sandbox:

- The daemon passes `workingDir` and `implStateDir` as plain absolute
  paths (existing behaviour).
- A `ctx.fs` helper (new, optional) wraps `fs/promises` such that any
  path argument is normalised and rejected if it escapes the impl's
  two roots. Buggy impls (T2) get a clear error; honest impls get
  a path-traversal-safe API for free.
- Impls that use raw `node:fs` are not blocked but are **out of policy**
  — the audit log records each impl's filesystem use; reviewers can
  flag impls that escape their roots.

Both `ctx.fs` and direct `fs` co-exist. We do not break existing impls
to introduce the wrapper.

### 4.4 Forward path: process isolation

The capability wrapper is **not** a security boundary against T1.
The full mitigation is process isolation (§6), where the impl runs as
a separate process with its only filesystem access being the two roots
(via OS-level controls: `chroot`, macOS sandbox-exec, Linux
namespaces, or simply running impls as a different uid). The Phase 1
wrapper exists so impl code that targets it works unchanged when the
impl moves out-of-process.

## 5. Provenance

Provenance answers: "Should the daemon load this code at all?" The
question is asked at install time (when the operator opts an impl
into their fleet) and re-checked at runtime (when the daemon starts).

This section assumes the **option (b)** registry-discovery model from
§8 decision #1: in-repo directory + config-declared external impls,
with no on-chain registry in Phase 1.

### 5.1 Sources of impls

Phase 1 has two impl sources, with different provenance requirements:

| Source | Provenance | Verification |
|---|---|---|
| **In-repo** (`client/src/restorer/impls/<name>/`) | The repo's commit history; review by the Jinn maintainers. | Implicit — if the binary was built from this repo, the impl is trusted to the same level as the daemon. |
| **Config-declared external impl** (operator names a package + CID) | Manifest signed by a key the operator has chosen to trust. | Explicit — described in §5.2–§5.4. |

In-repo impls are out of scope for the rest of §5 — they ship and are
verified with the daemon binary itself.

### 5.2 External-impl manifest

Every config-declared external impl ships a `jinn.manifest.json` at
the root of its package:

```jsonc
{
  "schemaVersion": "1",
  "name": "@some-operator/restorer-foo",   // unique; matches RestorerImpl.name
  "version": "1.4.2",                       // semver; matches RestorerImpl.version
  "supportedKinds": ["foo.v0>=1.0.0"],     // see schema-versioning spec
  "entry": "./dist/index.js",               // module that default-exports a RestorerImpl factory
  "package": {
    "cid": "bafy...abc",                    // IPFS CID of the packed tarball; pinned at install
    "size": 184321,                         // bytes; sanity check
    "hash": "sha256:..."                    // sha256 of tarball; cross-check vs CID derivation
  },
  "capabilities": {
    "chains": [11155111, 84532],
    "signer": {
      "calls": [
        { "chainId": 84532, "to": "0xff...", "selector": "0xa9059cbb" }
      ],
      "typedDomains": [
        { "name": "HyperliquidApproval", "version": "1" }
      ]
    },
    "rpc": {
      "methods": ["eth_call", "eth_getBlockByNumber"],
      "rateLimit": { "requests": 30, "windowMs": 10000 }
    }
  },
  "signer": {
    "publicKey": "ed25519:...",             // who signed THIS manifest (see §5.3)
    "signature": "..."                      // signature over the canonical manifest minus this field
  }
}
```

Notes:

- `package.cid` pins **what** runs. `signer.publicKey` + `signer.signature`
  pin **who said it's OK**. Both must verify.
- `capabilities` is the source of truth for §3.2 / §3.3 allow-lists.
  The daemon refuses any call outside this set. Operators reviewing a
  manifest can read off "this impl is allowed to call selector X on
  chain Y" without reading code.
- `schemaVersion` is the manifest schema, distinct from the
  `kind`-versioning policy in `spec/2026-05-schema-versioning.md`.

### 5.3 Trusted signer set

The operator's config declares a list of public keys the daemon will
accept manifest signatures from:

```jsonc
// ~/.jinn-client/config.json
{
  "trustedImplSigners": [
    { "publicKey": "ed25519:...", "label": "jinn-team" },
    { "publicKey": "ed25519:...", "label": "self" }   // operator's own key, optional
  ],
  "impls": [
    { "manifest": "ipfs://bafy...manifest" }
  ]
}
```

A signer key is added by an explicit operator action (`jinn impls
trust <key> --label <name>`). The daemon never auto-trusts a key it
sees in a manifest. The Jinn maintainer key is shipped as the only
default trust anchor, distinct enough from the daemon code that an
operator can replace or extend the set without recompiling.

### 5.4 Install-time vs runtime checks

| Check | Install (`jinn impls add ...`) | Runtime (every daemon boot) |
|---|---|---|
| Manifest signature verifies against `trustedImplSigners` | **YES** (refuse install) | YES (refuse load) |
| Tarball CID resolves and matches `package.cid` | **YES** (pin tarball locally) | NO — local pinned copy is canonical |
| Tarball sha256 matches `package.hash` | YES | YES (defends T3 / on-disk tamper) |
| `supportedKinds` parses, satisfies any current intent | YES (warn if no overlap) | NO |
| Allow-list constraints satisfiable on configured chains | YES | NO |
| Impl factory loads without throwing | NO (lazy) | YES |
| Allow-list does not exceed daemon-enforced ceiling (e.g. no `eth_sendRawTransaction`) | YES (refuse install) | YES (refuse load) |

The split is:

- **Install** is human-in-the-loop. The operator runs a CLI verb,
  reviews the manifest's `capabilities`, and accepts. Network-bound
  checks (CID resolution) happen here, once.
- **Runtime** is automated. It re-verifies the locally pinned bits
  (tarball hash + manifest signature) but does not re-fetch from
  IPFS. This makes daemon boot offline-safe and removes IPFS gateway
  availability from the daemon's critical path.

If a runtime check fails, the daemon refuses to load the impl, logs
to the event stream, and keeps running — other impls and the engine
are unaffected. Failure is loud (`status.fleet.needsAttention` per
the client-surface spec) but not fatal.

### 5.5 What this does and does not buy us

It buys us:
- T3 mitigation: a poisoned dep-chain that re-publishes under the same
  package name fails sig-check, because the tarball hash changed.
- A reviewable surface: the operator looks at one manifest, not a
  full audit of `node_modules`.
- Forward compatibility: the `package.cid` field is the integration
  point for a Phase 2 on-chain registry (see
  `spec/2026-05-registry-discovery.md`).

It does not buy us:
- Protection against an authorised signer publishing a malicious
  manifest. That's a key-management problem, not a protocol problem
  — but the daemon MUST give operators a way to **withdraw** trust
  from a compromised signer and invalidate the impls it signed. See
  §5.6.
- Protection against an in-process impl that, once loaded, escapes
  the §3 / §4 wrappers via Node internals. See §6.

### 5.6 Revocation

The §5.3 trust-anchor list is necessary but not sufficient. An
authorised signer's key can be lost, stolen, or burned by a
maintainer who later turns hostile; a previously-installed impl can
be retroactively recognised as malicious. The daemon MUST provide a
way to **withdraw trust** from a signer and to **invalidate specific
impl manifests** without requiring the operator to wipe their
config or rebuild the binary.

Revocation has three layers, in order of operator effort:

#### 5.6.1 Operator-driven signer revocation (mandatory, Phase 1)

Symmetric to `jinn impls trust` (§5.3), the daemon ships:

- `jinn impls untrust <publicKey | label>` — remove an entry from
  `trustedImplSigners`. Idempotent; succeeds even if the entry is
  already gone.
- `jinn impls revoke <manifestCid | implName>` — append the
  identifier to a local **revocation list** at
  `~/.jinn-client/impls/revoked.json`, regardless of which signer
  signed the manifest. Use case: a specific bad release where the
  signing key itself is still trusted (e.g. an honest maintainer who
  pushed a buggy build).

Both verbs take effect on the next runtime check (§5.4) and trigger
an immediate engine reload — the daemon does NOT continue executing
attempts under a now-untrusted impl. In-flight calls within the
impl are aborted via `ctx.abort` and their results are discarded.

The cascade rule: when `jinn impls untrust <signer>` runs, every
installed impl whose manifest is signed by that key is treated as
revoked. The operator does not need to enumerate impls.

#### 5.6.2 Behaviour on a revoked impl

Fail-closed semantics. When the daemon detects that a previously
installed impl is no longer trusted (untrusted signer, revoked CID,
or expired pin per §5.6.4):

1. **Refuse to load.** The impl is excluded from `buildRestorerImpls`
   for the current process. `status.fleet.needsAttention` flags the
   impl with reason `"revoked"` (per the client-surface spec).
2. **Quarantine `implStateDir`.** The daemon moves
   `implStateDirRoot/<impl-name>/` to
   `implStateDirRoot/.revoked/<impl-name>-<timestamp>/` and chmods it
   0700. Secrets are NOT auto-shredded — the operator may need them
   to migrate to a successor impl — but they are removed from the
   live secrets path so no other impl can pick them up.
3. **Clear in-memory state.** The capability wrappers (§3.2 / §3.3)
   bound to the revoked impl are invalidated; subsequent calls
   throw. Any pending tx the impl had requested but the daemon had
   not yet broadcast is dropped.
4. **Emit a structured event.** A single `impl.revoked` log line
   with `{ implName, manifestCid, signerPublicKey, reason,
   quarantinedTo }` is written to the daemon event stream and (if
   configured) the operator's notification channel.

`jinn impls forget <impl-name>` is the counterpart that finalises
quarantine: it shreds the quarantined state dir after operator
review. The daemon never auto-deletes secrets.

#### 5.6.3 Maintainer-published revocation list (optional, Phase 1)

The Jinn-team trust anchor MAY publish a signed revocation list at
a well-known IPNS or CID, structured as:

```jsonc
{
  "schemaVersion": "1",
  "publishedAt": "2026-05-21T10:00:00Z",
  "ttlSeconds": 604800,
  "revokedSigners": [
    { "publicKey": "ed25519:...", "reason": "key compromise", "since": "2026-05-20" }
  ],
  "revokedManifests": [
    { "cid": "bafy...bad", "reason": "malicious payload", "since": "2026-05-20" }
  ],
  "signature": "..."   // signed by a maintainer key from trustedImplSigners
}
```

When configured (`config.implRevocationList = "ipns://..."` or a
fixed CID), the daemon refreshes the list:

- At install time (`jinn impls add ...`) — refuse to install a
  manifest whose CID or signer appears in the current list.
- At runtime, opportunistically — if the local cached copy is older
  than `ttlSeconds`, attempt a refresh in the background; failure
  to refresh is logged but does not block engine boot (offline
  safety).
- On `jinn upgrade` — always refresh as part of the upgrade
  sequence; refusal to upgrade if the list cannot be fetched and the
  cached copy has expired (so a forked / stale daemon cannot indefinitely
  ignore revocations after an upgrade attempt).

The list signature MUST verify against a key currently in
`trustedImplSigners`. A revocation list signed by a key the operator
has already untrusted is itself ignored — preventing a
post-compromise attacker from "un-revoking" their own keys.

This layer is **optional** in Phase 1 (operators who self-curate may
disable it). Phase 2 promotes the list to mandatory, with the
on-chain registry from `spec/2026-05-registry-discovery.md` as the
canonical publication channel.

#### 5.6.4 Trust pinning expiry

Manifest signatures pinned at install time are not eternal. Each
trust-anchor entry carries an optional `maxPinAgeSeconds`:

```jsonc
{
  "trustedImplSigners": [
    {
      "publicKey": "ed25519:...",
      "label": "jinn-team",
      "maxPinAgeSeconds": 7776000   // 90 days
    }
  ]
}
```

The default for a freshly added signer is **90 days**; the operator
may set `0` to disable expiry (long-lived pin) or any positive value
to shorten it.

When a pinned manifest's age (time since `jinn impls add`) exceeds
`maxPinAgeSeconds`:

- The impl is flagged `needsRevalidation` in
  `status.fleet.needsAttention`.
- Runtime continues to load the impl until age exceeds
  `2 * maxPinAgeSeconds` (grace window). After the grace window the
  impl is treated as revoked per §5.6.2.
- `jinn impls revalidate <impl-name>` re-runs install-time checks
  (§5.4): refetches the tarball CID, re-verifies the signature
  against the current `trustedImplSigners`, re-checks the revocation
  list (§5.6.3), and resets the pin clock. Revalidation requires
  network and is the operator's opportunity to notice that a signer
  they once trusted is no longer reachable, has rotated keys, or has
  been quietly compromised.

Expiry is the backstop for the case where a key is compromised but
no revocation list is published (or the operator is not subscribed
to one). It also forces operators to periodically re-engage with
their fleet — defense against silent decay.

## 6. Evolution to out-of-process (option C)

The audit (`jinn-mono-j75` §8 decision #1) lists three options for
external-impl delivery: dynamic import (in-process), fork template,
out-of-process service (option C — MCP / HTTP). This spec does not
pick one, but it requires that **the design we ship now does not
foreclose option C**.

### 6.1 What changes when impls run out-of-process

In an out-of-process world (Phase 2-likely), the daemon launches each
impl as a child process or connects to a long-running MCP / HTTP
service. The trust model becomes:

- Credentials cross a process boundary as RPC, not as JS object
  references. The §3 capability handles become **wire protocols**;
  every call is observable and can be authorised individually.
- The OS enforces filesystem and network isolation. The Phase 1
  capability wrapper (§4.3) is replaced by `chroot` / namespace /
  sandbox-exec, with the wire protocol mediating all access.
- The `ctx.signer` allow-list becomes a per-message authorisation
  check on a request bus (the Safe-module variant from §3.2(b)
  becomes more attractive because it shifts authorisation on-chain).

### 6.2 Seams to design for now

To keep option C cheap later, Phase 1 follows these constraints:

1. **Capabilities are functions, not config.** `ctx.signer.sendAllowedCall`
   is shaped as an async call returning a serialisable result. It can
   become an RPC tomorrow; a property bag couldn't.
2. **Inputs and outputs are JSON-serialisable.** `RestorationContext`
   already passes `intent`, `intentCid`, paths, and primitive values.
   `RestorationOutput` is JSON-serialisable per the portfolio v0
   design. We MUST NOT add JS-only handles to either (Promises,
   class instances with methods that aren't on the capability list,
   `Buffer` without an explicit base64/hex contract).
3. **Manifests describe capabilities declaratively.** §5.2's
   `capabilities` object is the same shape an out-of-process daemon
   would consult to provision a child process's environment. The
   selector allow-list, RPC method allow-list, and rate-limit are all
   "what would a reverse proxy need to enforce this?" — answerable
   without reading impl code.
4. **No global state.** An impl MUST NOT rely on module-level state
   surviving across `run()` calls; durable state goes in
   `implStateDir` (§4.2). Out-of-process impls may be cold-started
   per call.
5. **Logging is structured.** `ctx.log({ level, msg, data })` is the
   only logging contract. `console.log` from an impl is unobserved
   when out-of-process; structured logs survive the boundary.
6. **No environment-variable inheritance.** An out-of-process child
   inherits no env from the daemon by default. Phase 1 in-process
   impls already MUST NOT read `process.env` for credentials or
   config (§3.5); secrets come via `ctx.secrets`.

If `jinn-mono-7zz` picks option (a) in-process dynamic import for
Phase 1, these six constraints are the ones that keep the option C
upgrade trivial. If it picks option C directly, these are already
the right shape.

## 7. Acceptance and downstream impact

### 7.1 Acceptance

This spec is accepted when:

1. It is merged under `spec/`.
2. `jinn-mono-7zz` description is updated to reference this spec as
   its trust-boundary input.
3. The (closed) `jinn-mono-y6w` close-reason notes that the
   trust-boundary contract for first-class external impls is defined
   here.

### 7.2 Downstream tasks (informational, not committed by this spec)

- `jinn-mono-7zz` picks an in-process / fork / out-of-process model
  for Phase 1 and references §6 constraints in its decision.
- A follow-up bead implements `ctx.signer`, `ctx.rpc`, and `ctx.fs`
  as additive fields on `RestorationContext` (existing in-repo impls
  keep working unchanged; new fields are opt-in until a future spec
  makes them mandatory).
- A follow-up bead implements `jinn impls trust` / `jinn impls add`
  CLI verbs per §5.3 / §5.4, and the revocation verbs `jinn impls
  untrust` / `jinn impls revoke` / `jinn impls revalidate` / `jinn
  impls forget` per §5.6, including the quarantine + state-clearing
  cascade in §5.6.2.
- A follow-up bead defines the maintainer revocation-list
  publication channel (IPNS vs fixed-CID rotation) per §5.6.3, and
  the `config.implRevocationList` wiring.

### 7.3 Open questions deferred

- Safe-module on-chain enforcement of the selector allow-list
  (§3.2(b)) — design and gas-cost analysis is its own bead.
- Cross-impl artefact sharing (e.g. evaluator reading restorer
  output) — handled today via the engine, not via the filesystem; a
  full read/write artefact model is out of scope here.
- IPFS pinning durability for manifest CIDs — the registry-discovery
  spec owns this.
