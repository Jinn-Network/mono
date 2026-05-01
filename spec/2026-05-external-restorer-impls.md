# External Restorer Impls — Technical Spec

> Version: 1
> Date: 2026-04-28
> Author: Captain (opus, dispatched on jinn-mono-7zz)
> Status: Proposed (not yet adopted)
> Supersedes: none
> Audit: `jinn-mono-j75` §7.2.1, §8 decision #1 (loader half)
> Sibling specs: `spec/2026-05-schema-versioning.md`,
> `spec/2026-05-registry-discovery.md`,
> `spec/2026-05-executor-trust-boundary.md`
> Predecessor bead: `jinn-mono-y6w` (closed as merged into jinn-mono-7zz)

## Vocabulary note

The audit (`jinn-mono-j75`) and earlier draft language called this surface
"plug-ins." This spec drops that word for two reasons:

1. The codebase has been on `RestorerImpl` / `impl` since day one
   (`client/src/restorer/types.ts`, `buildRestorerImpls`,
   `client/src/restorer/impls/`, the `jinn impls *` CLI verbs proposed
   in `spec/2026-05-executor-trust-boundary.md` §7.2 / §5.6). "Impl" is
   the established term; "plug-in" was the audit's gloss, not the
   codebase's.
2. `jinn plugin install` already exists in the CLI
   (`client/src/cli/commands/plugin-install.ts`) for a different surface
   — it installs the Jinn MCP server / skill into AI hosts (Claude
   Code, Codex, Cursor). Reusing "plug-in" for operator-supplied
   restorer impls would collide with an unrelated existing verb.

This spec therefore uses **"external restorer impl"** (or, where
context disambiguates, just "external impl") for what the audit called
a "plug-in," and **`restorers.externalImpls`** as the config field
formerly drafted as `restorers.plugins`. Sibling specs on the same
branch (`spec/extension-model`) carry the rename in the same merge.

## 1. Purpose and scope

This spec records the **Phase 1 loader and execution model** for an
operator-supplied `RestorerImpl` (or `EvaluatorImpl`) — i.e. the
mechanism the daemon uses to take a config-declared external impl entry
from `spec/2026-05-registry-discovery.md` §4.2 and end up with a live
`RestorerImpl` instance in the same registry the in-repo factory
feeds.

The audit (`jinn-mono-j75` §7.2.1 / §8 decision #1) framed this as a
choice between four candidates: stay-in-repo, in-process dynamic
import, fork template, and out-of-process executor (MCP / HTTP). The
registry-discovery spec already chose **config-declared external
impls** as the *source of candidates*; this spec picks the **loader**
that turns a candidate into a callable impl.

### 1.1 In scope

- Phase 1 loader mechanism: how `restorers.externalImpls[<i>].entry`
  becomes a constructed `RestorerImpl`.
- The external impl package's module contract (default export shape,
  factory signature, lifecycle).
- The shape of `restorers.externalImpls[].entry` (filesystem path; no
  remote URL in v1).
- Forward-compatibility with the trust-boundary spec's §6
  out-of-process seams — the upgrade path, and what we MUST NOT do
  now to keep it cheap.
- Hand-off into follow-up beads.

### 1.2 Out of scope

- The candidate-source contract (which entries the loader is fed) —
  that is `spec/2026-05-registry-discovery.md` §4.
- Trust verification of a manifest (CID, signature, allow-list ceiling,
  revocation) — that is `spec/2026-05-executor-trust-boundary.md` §5.
- The schema-versioning policy for `kind` strings and manifest
  `schemaVersion` — that is `spec/2026-05-schema-versioning.md`.
- The Phase 2 out-of-process execution model itself — only its
  Phase 1 seams. A later spec covers the wire protocol, lifecycle, and
  sandbox primitive.
- Naming. The public-facing surface this spec defines
  (`restorers.externalImpls`, `RestorerImpl`, `jinn impls *`, the
  package contract) MAY be renamed before ship per `jinn-mono-juw` /
  GitHub issue #43 (Restorer → Solver, outcome → solution). This spec
  uses the current vocabulary; a single rename pass will retarget the
  surface before any external operator publishes an impl. See §8.1.

### 1.3 Non-goals

- This spec does **not** sandbox impls. Phase 1 in-process Node has no
  capability isolation against a determined T1 attacker
  (trust-boundary §2.4); provenance + capability narrowing
  (trust-boundary §3 / §5) are the Phase 1 mitigation. This spec
  preserves the seams that let process isolation slot in later, and
  nothing more.
- This spec is not a marketplace, runtime hot-reload, or cross-fleet
  impl browser. Operators install with their existing package
  manager; the daemon resolves at boot.

## 2. The decision

For Phase 1 the daemon loads each config-declared external impl by
**dynamic ESM import of a local filesystem path** (audit option B /
§7.2.1.B). The same `RestorationContext` and `RestorerImpl` shape used
by in-repo impls applies. Out-of-process execution (audit option C) is
the Phase 2 evolution; this spec enumerates the §6 seams we must hold
to in Phase 1 to keep that upgrade trivial.

The other three candidates are rejected for Phase 1:

| Candidate | Phase 1 disposition |
|---|---|
| **Stay in-repo** (audit option A) | Already the in-repo factory (Source A in `spec/2026-05-registry-discovery.md` §4.1). Doesn't satisfy this bead's premise — operators with their own restorer would still need to maintain a long-lived fork of the daemon. |
| **Fork template** | Same long-lived-fork problem under a different name. Surfaced as a candidate in this bead's description; rejected on the explicit user requirement ("without maintaining a long-lived fork of the repo"). |
| **MCP-only** | MCP is a tool-protocol, not a general impl-RPC channel. Its message shape (tools / resources / prompts) does not cleanly carry `RestorationContext` or `RestorationOutput`, and committing to it would foreclose non-MCP out-of-process variants the trust-boundary spec wants to keep open. MCP remains the right *internal* transport for in-repo impls that talk to Claude (the existing `claude-mcp-*` family); it is not the right surface for external impls. |
| **Out-of-process executor (audit option C)** | The right Phase 2 endpoint. Not the right Phase 1 *first* step: shipping it now also requires the wire protocol, child-process lifecycle, serialisation contracts, and a port of the existing in-repo impls' assumptions. Phase 1 dynamic-import lets the manifest, trust flow, and capability handles ship first, then Phase 2 swaps the loader without changing impl-author code if §6 holds. |

The case **for** dynamic import in Phase 1, in plain terms:

- The current `RestorerImpl` interface (`client/src/restorer/types.ts`)
  works as-is. No new ceremony for impl authors.
- TypeScript IDE / type-checking carry through the package boundary —
  operators publish a plain npm package and get the same DX as in-repo
  authors.
- The trust contract (manifest signing, capability handles, install /
  runtime checks) is already cut by the sibling specs and applies
  identically to dynamic-import external impls.
- The §6 seams cost nothing extra to enforce now, and they make the
  Phase 2 lift "swap the loader" rather than "redesign the contract".

The case **against**, acknowledged: in-process Node grants any loaded
module the daemon's PID. A T1 (trust-boundary §2.1) impl that escapes
the §3 / §4 wrappers can do real harm. Phase 1 makes this **harder
and noisier** (provenance + capability allow-lists + revocation),
not impossible. The trust-boundary spec is explicit (§2.4, §6) that
real isolation is a Phase 2 lift; this spec inherits that posture.

## 3. Loader contract

### 3.1 External impl package layout

An external impl is shipped as an npm-style package the operator
installs into their `node_modules` (typically with `yarn add` or as a
tarball pinned by `package.cid`). At its root:

```
my-restorer/
  package.json
  jinn.manifest.json        # spec/2026-05-executor-trust-boundary.md §5.2
  dist/
    index.js                # default-exports a factory (§3.2)
    index.d.ts              # optional TS types
```

- `jinn.manifest.json` `entry` (e.g. `./dist/index.js`) is the module
  the loader resolves with dynamic `import()`. `entry` is a path
  **relative to the package root**; absolute paths and `..` segments
  are install-time refusals.
- `package.json`'s `main` / `exports` are not consulted by the loader.
  The manifest `entry` is the single source of truth (so an impl
  cannot present one entrypoint to Node and a different one to
  reviewers).
- `package.cid` from the trust-boundary manifest pins the tarball; the
  loader operates on the *unpacked* tarball at the location named by
  `restorers.externalImpls[<i>].entry` in operator config.

### 3.2 Module shape

The loaded module MUST default-export a factory function:

```ts
// my-restorer/dist/index.ts
import type {
  RestorerImpl,
  ExternalRestorerEnv,    // new — see §3.3
} from '@jinn-network/restorer-sdk';   // typed re-exports of client/src/restorer/types

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return new MyRestorer(env);
}
```

Constraints on the factory:

1. **Pure construction.** The factory MAY validate `env` and throw on
   misconfiguration. It MUST NOT perform network I/O, signer use,
   keystore reads, filesystem writes outside `env.implStateDir`, or
   any other side effect. Side-effecting work belongs in `onEnable` /
   `run` / `isReady`, all of which receive scoped capability handles
   per the trust-boundary spec.
2. **No module-level state across `run` calls.** The returned impl
   MAY hold state on its own instance, but per-attempt state belongs
   in `ctx.workingDir` and durable state in `ctx.implStateDir`
   (trust-boundary §4). This is constraint §6.2.4 of the trust-boundary
   spec; out-of-process Phase 2 may cold-start the impl per call.
3. **No `process.env`, no `Config` object capture, no raw signer.** The
   factory's only inputs are `env` (described in §3.3) and the runtime
   `RestorationContext` its returned impl receives in `run()`. See
   trust-boundary §3.5.

The default export is a function (not a class) to keep the contract
JSON-describable in Phase 2 — a factory call serialises to "spawn
process, send `init` with `env`" without any class-instance plumbing.
A class export would force the loader to discriminate
"constructor-ness" across language runtimes.

### 3.3 `ExternalRestorerEnv`

The env object passed to the factory is the external-impl analog of
`RestorerEnv` (`client/src/restorer/impls/index.ts`), narrowed to
what an external impl is allowed to receive at construction time. It
is **not** `RestorationContext`; that is per-call.

```ts
export interface ExternalRestorerEnv {
  /** Manifest-declared name (matches RestorerImpl.name). */
  readonly implName: string;
  /** Manifest-declared semver. */
  readonly implVersion: string;
  /** Operator-chosen network (e.g. 'base-sepolia', 'base-mainnet'). */
  readonly network: string;
  /** Daemon-issued root for this impl's durable state.
   *  Equal to implStateDirRoot/<implName>; created and chmodded by daemon. */
  readonly implStateDir: string;
  /** Read-only secrets bag populated by the impl's onEnable flow.
   *  Same identity as ctx.secrets at run() time; surfaced here so
   *  isReady / enableMetadata can answer without a full ctx. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Daemon-side logger. Same shape as ctx.log. */
  readonly log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** True when constructed under the CLI introspection path
   *  (`jinn intents list / status`). Impls report
   *  REQUIRES_LIVE_DAEMON_READINESS from isReady() in stub mode. */
  readonly stub: boolean;
}
```

Two notes:

- `ExternalRestorerEnv` is **not** `RestorerEnv`. The in-repo factory
  takes `RestorerEnv` (which contains `pk`, `safe`, `runner`, raw
  RPC URLs); external impls do not get those. An external impl that
  needs RPC reads or signing receives them per-call via `ctx.rpc` and
  `ctx.signer` (trust-boundary §3.2 / §3.3); an external impl that
  needs a credential receives it via `ctx.secrets` after `onEnable`.
- The shape is **JSON-serialisable**. No functions, no class
  instances, no Buffers, no Promises (constraint §6.2.2 of the
  trust-boundary spec). `log` is the one exception, and it is the
  exact shape an out-of-process child receives as a wire callback in
  Phase 2.

### 3.4 Lifecycle

The daemon resolves and constructs each external impl at boot, in the
following order. Failure of any step excludes that impl only; other
impls and the engine are unaffected (registry-discovery §4.3).

1. **Read** the operator's `restorers.externalImpls[<i>]`.
2. **Resolve manifest.** Read the locally pinned `jinn.manifest.json`
   from the install directory (registry-discovery §4.3.2a).
3. **Trust check.** Run trust-boundary §5.4 runtime checks: tarball
   sha256 vs `package.hash`; manifest signature vs
   `trustedImplSigners`; revocation status (signer untrusted?
   manifest revoked? trust-pin within `2 * maxPinAgeSeconds`?);
   capability allow-list within daemon ceiling. Failure → exclude with
   `status.fleet.needsAttention.reason in {"impl-trust", "impl-revoked",
   "impl-needs-revalidation"}`.
4. **Dynamic import.** `await import(<absolute path to entry>)`. The
   path is the join of `restorers.externalImpls[<i>].entry` and the
   manifest's `entry` field. Failure (module not found, syntax error,
   default export missing or non-function) → exclude with
   `reason: "impl-load-failed"`.
5. **Construct.** Call the default export with `ExternalRestorerEnv`.
   Construction throws → exclude with `reason: "impl-construction-failed"`.
6. **Validate identity.** The returned `RestorerImpl.name` MUST equal
   `manifest.name`; `RestorerImpl.version` MUST equal `manifest.version`.
   Mismatch → exclude with `reason: "impl-identity-mismatch"` (this
   defends against an external impl that signed one manifest but ships
   code claiming a different identity).
7. **Validate `supportedKinds`.** Every kind the impl claims via
   `supports()` for the kinds in `manifest.supportedKinds` MUST match.
   We implement this as: for each entry `<kind>>=<semver>` in the
   manifest, the daemon calls `impl.supports({ kind, type })` for
   every `(kind, type)` pair the daemon knows about; the result MUST
   be consistent with the manifest claim. Inconsistency is a defect,
   not a security violation, but it is loud — exclude with
   `reason: "impl-supports-mismatch"`.
8. **Register.** Insert the impl into the same in-memory registry
   `buildRestorerImpls` populates. Duplicate `name` collisions across
   sources are an operator-fixable error (registry-discovery §4.3.3);
   the in-repo impl wins by default and the external impl is excluded
   with `reason: "impl-name-collision"`. Operators resolve by editing
   `restorers.disabled` or removing the external impl.

The lifecycle is **once-per-process**. An external impl does not
hot-reload; to swap an impl version, the operator runs the install
verb against a new manifest CID and restarts the daemon. Hot-reload
is a Phase 2+ concern explicitly because revocation (trust-boundary
§5.6.2) MUST clear in-memory capability handles — which Phase 1 does
by exiting the impl's slot in `buildRestorerImpls` and rebuilding the
registry, which in turn requires an engine reload anyway. Reloading
the whole daemon is the simpler invariant.

### 3.5 What `entry` is, and is not

`restorers.externalImpls[<i>].entry` (registry-discovery §4.2) is a
**local filesystem path** the daemon's loader resolves with dynamic
`import()` joined to the manifest's `entry` field. It is typically a
`node_modules` subdirectory the operator has populated with their
package manager.

It is **not**:

- A remote URL (`https://...`, `ipfs://...`). The trust-boundary spec
  keeps boot offline-safe (§5.4); a remote `entry` would couple boot to
  network availability and inject a runtime fetch into a path that is
  meant to operate on already-pinned local content. The manifest's
  `package.cid` is the canonical remote pointer, resolved at install,
  not at boot.
- An MCP server URL. See §2; MCP is the right transport for some
  *internal* in-repo impls, not for the external-impl surface this
  spec defines.
- A descriptor for an out-of-process child (e.g. `{ command: '...',
  args: [...] }`). Phase 2 may extend `entry` with a discriminated-union
  shape for that, but Phase 1 keeps it a string.

Reopening any of the above requires a new spec, the same way
registry-discovery §4.4 reopens its deferrals.

### 3.6 SDK package

To make the contract discoverable, the daemon repo MAY publish (in a
follow-up bead, §7) a small `@jinn-network/restorer-sdk` package that
re-exports the public types: `RestorerImpl`, `RestorationContext`,
`RestorationOutput`, `ReadyStatus`, `EnableResult`, `IntentEnableMetadata`,
`SkippableError`, the `signer` / `rpc` / `secrets` / `fs` capability
handle types from trust-boundary §3, and `ExternalRestorerEnv` from
§3.3 above.

External-impl authors depend on `@jinn-network/restorer-sdk`, not on
`@jinn-network/client` directly. This separation is what lets the
daemon implementation evolve (refactors, extra in-repo glue, internal
deps) without breaking external-impl authors. The SDK package's semver
becomes the contract surface external-impl authors track; today, the
boundary is implicit in `client/src/restorer/types.ts`.

The SDK package is **not** required for Phase 1 to function — an
external-impl author can copy the relevant types or import from the
unstable internal path. But shipping the SDK is part of the "feels
first-class" goal in this bead's description and belongs in the
follow-up.

## 4. Conformance with the trust-boundary §6 seams

Trust-boundary §6.2 lists six constraints the Phase 1 design must
satisfy to keep the option-C upgrade trivial. The external-impl flow
above satisfies them as follows.

| §6.2 constraint | How this spec satisfies it |
|---|---|
| 1. Capabilities are functions, not config. | `RestorationContext.signer.signTypedData / sendAllowedCall`, `ctx.rpc` (a `viem` `PublicClient` interface), and `ctx.log` are async functions in Phase 1; they become RPCs in Phase 2 with the same signatures. The external-impl factory takes `ExternalRestorerEnv` (config) and returns an impl that uses capability handles only at call time — never captures a raw signer. |
| 2. Inputs and outputs are JSON-serialisable. | `ExternalRestorerEnv` (§3.3) is JSON-serialisable. `RestorationContext` already is (per portfolio v0 design). `RestorationOutput` already is. The external-impl flow adds nothing JS-only. |
| 3. Manifests describe capabilities declaratively. | The external impl uses `jinn.manifest.json` `capabilities` (trust-boundary §5.2) verbatim. The loader does not synthesise capabilities at runtime; the manifest is the only source. |
| 4. No global state. | Factory contract §3.2 forbids module-level state across `run` calls. Per-attempt state goes in `ctx.workingDir` (cleared between attempts); durable state goes in `ctx.implStateDir`. |
| 5. Logging is structured. | `ctx.log({ level, msg, data })` is the only logging contract surfaced to external impls. The SDK package (§3.6) does NOT re-export `console`. External-impl authors who reach for `console.log` are out of policy; their output is unobserved when out-of-process. |
| 6. No environment-variable inheritance. | `ExternalRestorerEnv` (§3.3) deliberately omits `process.env`. External impls MUST NOT call `process.env` for credentials or config; secrets come via `ctx.secrets` after `onEnable`. The daemon does not propagate environment to in-process impls (other than what Node itself inherits, which is invisible to a well-behaved impl). Out-of-process Phase 2 will spawn children with `env: {}`. |

The Phase 2 swap, restated: replace step §3.4(4) (`await import(...)`)
with `spawn(<entry>)` + a wire protocol; replace step §3.4(5)
(call factory with env) with an `init` message carrying the same
env shape; everything else — manifest, trust check, identity check,
registry insertion — is unchanged.

## 5. Worked example

An operator wants to run a third-party Aave-rebalance restorer
(`@some-operator/aave-restorer`) for kind `lending-health.v0`.

1. **Author publishes.** The author packages their external impl,
   computes the tarball CID, writes `jinn.manifest.json` with
   `name: "@some-operator/aave-restorer"`, `version: "1.0.0"`,
   `supportedKinds: ["lending-health.v0>=1.0.0"]`,
   `entry: "./dist/index.js"`, the tarball pin, and the capability
   allow-list (chains, signer selectors, RPC methods, rate limit).
   They sign the manifest with their `ed25519` key, pin the tarball
   on IPFS, and publish the manifest CID.

2. **Operator trusts the signer.** The operator runs:
   ```
   jinn impls trust ed25519:... --label some-operator
   ```
   The daemon adds the entry to `trustedImplSigners` (trust-boundary §5.3).

3. **Operator installs.** The operator runs:
   ```
   yarn add @some-operator/aave-restorer
   jinn impls add ipfs://bafy...manifest
   ```
   `jinn impls add` (a follow-up bead, §7) runs the install-time checks
   (trust-boundary §5.4): resolves the CID, pins the tarball, verifies
   the signature, checks the capability allow-list against the daemon
   ceiling. On success it appends to `restorers.externalImpls`:
   ```jsonc
   {
     "name": "@some-operator/aave-restorer",
     "package": "ipfs://bafy...manifest",
     "entry": "./node_modules/@some-operator/aave-restorer"
   }
   ```

4. **Daemon boot.** §3.4 runs: trust check passes, dynamic import
   resolves `./node_modules/@some-operator/aave-restorer/dist/index.js`,
   the default export is called with `ExternalRestorerEnv`, the returned
   impl identifies as `@some-operator/aave-restorer@1.0.0` matching
   the manifest, and the impl is registered alongside the in-repo
   impls.

5. **Engine dispatches.** When a `lending-health.v0` intent arrives,
   the engine matches via `impl.supports({ kind: 'lending-health.v0',
   type: 'restoration' })`, constructs a `RestorationContext` with
   per-call `signer` / `rpc` / `secrets` / `fs` handles, and calls
   `impl.run(ctx)`. The external impl does its work using only those
   handles.

6. **Operator revokes (optional path).** Two months later the operator
   reads of a bug in `@some-operator/aave-restorer@1.0.0`:
   ```
   jinn impls revoke @some-operator/aave-restorer
   ```
   On the next runtime check the impl is excluded; `implStateDir/<impl>`
   is moved to the quarantine path; capability handles bound to it
   are invalidated (trust-boundary §5.6.2). The daemon continues
   running with the rest of the fleet. Once the author ships a fix
   at a new manifest CID, the operator runs `jinn impls add <new CID>`
   to install the new version, and `jinn impls forget` to shred the
   quarantined state.

## 6. What is NOT decided here

- The Phase 2 out-of-process wire protocol. This spec promises the
  upgrade is cheap if §4 holds; it does not prescribe the protocol.
- Hot-reload of external impls inside a running daemon. Out of scope;
  §3.4 commits to once-per-process construction.
- Multi-version coexistence (e.g. running `@x/foo@1` and `@x/foo@2`
  side by side). The §3.4 duplicate-name rule rejects this. If a real
  use case appears, a follow-up spec can add a `--alias` flag to the
  install verb.
- External-impl inter-dependencies (impl A wanting to consume impl B's
  output beyond the existing engine artifact channel). Trust-boundary
  §7.3 already calls this out as a future bead; the loader does not
  introduce a dependency graph.
- The CLI verb shape for `jinn impls *` beyond the verb names already
  named by trust-boundary §7.2 / §5.6 (`trust`, `untrust`, `add`,
  `remove`, `revoke`, `revalidate`, `forget`, `list`, `show`). Verb
  details are a follow-up bead (§7).

## 7. Acceptance and downstream impact

### 7.1 Acceptance

This spec is accepted when:

1. It is merged under `spec/`.
2. `spec/2026-05-registry-discovery.md` §6.3 ("Open questions
   deferred") is updated to note that `entry` is locked to a local
   filesystem path for Phase 1 by this spec; the remote-target
   variant is deferred to Phase 2 alongside the out-of-process
   loader.
3. `client/src/restorer/types.ts` and
   `client/src/restorer/impls/index.ts` carry doc references to this
   spec and its sibling specs so downstream readers find the
   contract from code.
4. `jinn-mono-7zz` is closed.

### 7.2 Downstream tasks (informational, not committed by this spec)

The follow-ups, ranked roughly in dependency order. They are not
filed in this bead per dispatch discipline; they exist here as the
hand-off list.

1. **Capability handles on `RestorationContext`.** Land
   `ctx.signer`, `ctx.rpc`, `ctx.secrets`, optional `ctx.fs` per
   trust-boundary §3.1. Additive — existing in-repo impls keep
   working unchanged. This is a pre-req for the loader, because the
   external-impl flow above assumes the new fields exist.
2. **Manifest verifier.** Implement install-time and runtime checks
   per trust-boundary §5.4: tarball CID resolution, sha256 match,
   signature verification, allow-list ceiling, revocation.
3. **Loader.** Implement §3.4 above: read `restorers.externalImpls`,
   dynamic-import, validate identity, register. Includes the
   `status.fleet.needsAttention` reason codes named in §3.4.
4. **CLI verbs.** `jinn impls trust|untrust|add|remove|list|show`
   for the install / introspection surface; `jinn impls
   revoke|revalidate|forget` for the revocation surface
   (trust-boundary §5.6); `jinn impls update <name>` per
   registry-discovery §6.3 for external-impl updates.
5. **In-repo disable list.** `restorers.disabled: [...]` per
   registry-discovery §4.1. Small and self-contained; can land
   independently of the external-impl flow.
6. **Maintainer revocation list wiring.** `config.implRevocationList`
   per trust-boundary §5.6.3, including IPNS / fixed-CID rotation
   policy.
7. **`@jinn-network/restorer-sdk` package.** §3.6 above: re-export
   the public contract types, semver-tracked. Includes a minimal
   `RestorerImpl` template / scaffold the way `client/src/restorer/impls/prediction-v0-baseline/`
   is the in-repo template.
8. **Extension guide.** Promote audit §5.3 ("Add a third-party
   impl") into `docs/runbooks/publish-an-external-restorer.md` once
   the loader ships, with the worked example from §5 as the spine.
9. **Naming pass before public ship.** Per `jinn-mono-juw` /
   GitHub issue #43 — once the Restorer → Solver decision lands,
   apply it across `RestorerImpl`, `restorers.externalImpls`,
   `restorers.disabled`, `jinn impls *`, `ExternalRestorerEnv`,
   the SDK package name, and this spec's filename. The external-impl
   surface MUST land under final names; renaming after operators
   publish external impls is a much larger churn event.
10. **Phase 2 out-of-process spec.** A follow-on spec when the
    operator demand or threat model warrants — wire protocol, child
    lifecycle, sandbox primitive (uid / sandbox-exec / namespaces).
    Inherits the manifest, trust flow, capability shape, and §3.5
    `entry` extension from this spec.

Phase A.2 (`spec/2026-04-30-plug-in-surface.md` §3.3) ships three
prediction-shaped worked examples (`forecaster`, `evaluator`,
`alternative-harness`) under `examples/external-restorer-impls/`,
exercising the loader contract end-to-end. The §3.6
`@jinn-network/restorer-sdk` package is promoted from "follow-up" to a
Phase A.2 hard acceptance criterion.

### 7.3 Open questions deferred

- Whether `ExternalRestorerEnv` should carry `network` as an enum
  (`'base-mainnet' | 'base-sepolia' | ...`) or a structured
  `{ chainId, name }`. Today it's a string; a tightening pass
  follows the §7.2.1 work landing.
- Whether to expose a `ctx.intentRegistry` read-only handle so an
  external impl can introspect sibling intents (e.g. an evaluator
  reading a restorer's prior submission). Trust-boundary §7.3
  already flags this; the loader does not enable it today.
- External-impl `peerDependencies` policy: should the SDK enforce a
  semver range against `@jinn-network/restorer-sdk` and refuse to
  load impls built against an incompatible SDK major? Today the
  manifest has no SDK-version field; adding one is a §3 addendum
  when the SDK ships.
- Whether to support a `restorers.externalImpls[].config` field for
  per-impl operator config that is *not* a secret (e.g. an exchange
  API base URL, a feature flag the impl author exposes).
  Registry-discovery §6.3 already flags this; this spec leaves it
  out of `ExternalRestorerEnv` for v1.

## 8. Risks and reservations

### 8.1 Naming churn

`jinn-mono-juw` was closed pending GitHub issue #43; the Restorer →
Solver and outcome → solution renames may land before this spec's
implementation reaches operators. The risk is that we ship external-
impl infrastructure under one vocabulary and then have to rename the
public surface (config keys, CLI verbs, SDK package name) on top of
operators who have already published external impls.

Mitigation: §7.2 step 9 names a single rename pass before any
operator publishes an external impl. The implementation order
ensures naming lands BEFORE the SDK package is published to npm and
BEFORE the worked-example runbook ships. In-repo surface (this spec,
`client/src/restorer/`) may rename internally without external churn.

### 8.2 The "in-process is not a security boundary" reservation

Trust-boundary §2.4 and §6.1 are explicit: in-process Node has no
real isolation. This spec inherits that posture and does not pretend
otherwise. The mitigation is the §5.6 revocation flow: a malicious
external impl is removed by an operator-driven `jinn impls untrust` /
`revoke`, plus the maintainer-published revocation list as a
defense-in-depth layer.

The fail-loud behaviour (§5.6.2 quarantine + state clearing,
`status.fleet.needsAttention`) is the user-visible counterpart.
Operators MUST be able to detect that an external impl went bad and
recover without rebuilding. The loader does not pretend to defend
against an external impl that runs *before* it is recognised as
malicious — that is a Phase 2 process-isolation problem, and §4
keeps the upgrade open.

### 8.3 Dependency-graph surface

An external impl's transitive npm dependencies are part of its trust
surface (trust-boundary §2.3). The manifest pins the tarball, but
the tarball typically excludes `node_modules` — the operator's
package manager resolves dependencies at install. This means a
poisoned transitive dep (the `event-stream` / `node-ipc` / `xz`
pattern) is *not* caught by `package.hash`, because `package.hash`
covers the impl's own source, not the resolved dep tree.

Phase 1 mitigation: capability narrowing (the impl cannot reach
`process.env`, the keystore, sibling impls' state, etc., even
through a poisoned dep, *if* it goes through the boundary). Phase 2
mitigation: process isolation, so a poisoned dep cannot escape the
sandbox even if it tries to.

This spec does not commit a Phase 1 lockfile-pinning rule for
dependencies. A reasonable follow-up is a manifest field
`package.lockfileHash` that pins the resolved dep tree at publish
time; this is left for a future trust-boundary minor revision (§5.7
or successor) rather than this spec.

## 9. References

- `docs/reviews/2026-04-22-architecture-audit-j75.md` — audit; this
  spec records the loader half of §8 decision #1 (audit option B,
  with §6 seams toward option C). The audit's "plug-in" vocabulary
  is dropped here for the reasons in the vocabulary note above.
- `spec/2026-05-schema-versioning.md` — kind grammar, manifest
  semver, `supportedKinds` advertisement. The external impl's
  manifest `supportedKinds` array follows this grammar.
- `spec/2026-05-registry-discovery.md` — the source-of-candidates
  contract this spec consumes (§4.2's `restorers.externalImpls`
  shape).
- `spec/2026-05-executor-trust-boundary.md` — the trust contract
  the external-impl flow builds against. §5.4 install/runtime split,
  §5.6 revocation, §6 out-of-process seams.
- `spec/2026-04-14-client-surface.md` — `status.fleet.needsAttention`
  shape that the loader reports into.
- `client/src/restorer/types.ts` — current `RestorerImpl` shape; the
  external-impl module contract (§3.2) is this interface.
- `client/src/restorer/impls/index.ts` — `buildRestorerImpls`; the
  in-repo Source A whose registry the loader inserts into.
- `jinn-mono-juw` — naming alignment decision (now in GitHub issue
  #43); §7.2 step 9 lists the rename pass.
- `jinn-mono-y6w` — closed predecessor bead, merged into
  jinn-mono-7zz; this spec is its design output.
