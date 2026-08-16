# Path 2 SDK reference (`@jinn-network/sdk/harness`)

Field-by-field reference for the public surface external Harness authors target. The canonical source is `packages/sdk/src/`; this doc is a derivation. If this doc and the source disagree, the source wins.

## Stability commitment

Per `spec/2026-04-30-plug-in-surface.md` §3.1 and `spec/2026-05-external-harnesses.md` §3.6:

- The SDK follows strict semver. Breaking changes to a re-exported type, a function signature, or an enumerated value MUST land as a major bump.
- Minor bumps are additive only. A new field on `ExternalHarnessEnv`, a new optional method on `Harness`, a new capability handle on `HarnessContext` ships as a minor; pre-existing Harnesses keep loading unchanged.
- **12-week deprecation window.** From the day a major lands on npm, the prior major remains supported for 12 weeks. During the window, the daemon accepts manifests declaring either major; after the window, only the new major loads.
- Deprecations announced in `packages/sdk/CHANGELOG.md`, in a `console.warn` line in the daemon's load path, and in the maintainer revocation-list metadata.

External Harness authors depend on `@jinn-network/sdk/harness`, **not** on `@jinn-network/client` directly.

## `Harness`

The interface every harness (and evaluator) implements. Source: `packages/sdk/src/index.ts`.

```ts
export interface Harness {
  name: string;
  version: string;
  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(task: Task): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: HarnessContext): Promise<Solution>;
  isReady?(): Promise<ReadyStatus>;
  enableMetadata?(): HarnessEnableMetadata;
  onEnable?(ctx: {
    solverNet?: { name: string; solverType: string };
    runtimePlugins: RuntimePlugin[];
    args: Record<string, string | undefined>;
  }): Promise<EnableResult>;
  onDisable?(): Promise<void>;
}
```

| Method | Required | Contract |
|---|---|---|
| `name` | yes | Stable identifier matching the manifest's `name` field. |
| `version` | yes | semver matching the manifest's `version` field. |
| `supports({ solverType, role })` | yes | First-match resolution: the engine asks each registered Harness in order; the first Harness whose `supports()` returns `true` claims the Task. Return `true` only for solverTypes + roles your `run()` is prepared to handle. |
| `canAttempt(task)` | no | Optional second-stage filter. Called *after* `supports()` returns `true`; can inspect the Task's spec / window / eligibility and return `{ ok: false, reason }` to defer. Useful for "I support `prediction.v0` but not this specific market." |
| `run(ctx)` | yes | The work. Returns a `Solution`; throws `SkippableError` to defer cleanly without consuming a delivery slot. |
| `isReady()` | no | Pre-flight check (CLI introspection, fleet status). Default: `{ ready: true }`. Use `REQUIRES_LIVE_DAEMON_READINESS` for Harnesses that need a live daemon. |
| `enableMetadata()` | no | Static metadata about what `onEnable` needs (description, required args). Surfaced by `jinn harnesses show` and the enable-flow CLI. |
| `onEnable(args)` | no | One-time enablement (register an account, mint a key, complete a KYC step). Returns the next state for the daemon to record. |
| `onDisable()` | no | One-time tear-down on `jinn harnesses remove`. |

The factory shape for default-export:

```ts
export type ExternalHarnessFactory = (env: ExternalHarnessEnv) => Harness;
export default function createHarness(env: ExternalHarnessEnv): Harness {
  /* ... */
}
```

## `HarnessContext`

Passed to `run()` for every attempt. Source: `packages/sdk/src/index.ts`.

```ts
export interface HarnessContext {
  task: Task;
  taskCid?: string;
  solverNet?: { name: string; solverType: string };
  runtimePlugins?: RuntimePlugin[];
  solverPluginRoots?: string[];
  implStateDir: string;
  workingDir: string;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  abort: AbortSignal;
  msUntilEndTs: () => number;
  signer?: ScopedSigner;
  rpc?: ScopedRpc;
  secrets?: ScopedSecrets;
}
```

| Field | Type | Notes |
|---|---|---|
| `task` | `Task` | The Task to solve: id, description, spec, eligibility, window. |
| `taskCid` | string \| undefined | The Task's CID on the corpus, if available. |
| `solverNet` | object \| undefined | The SolverNet selected for this run. |
| `runtimePlugins` | array \| undefined | Canonical and extra SolverPlugins selected for this run. |
| `solverPluginRoots` | string[] \| undefined | Plugin roots passed to the Harness for this run. |
| `implStateDir` | string | Per-impl persistent state directory. Persists across attempts; safe to write learning artefacts, calibration histories, cached features. |
| `workingDir` | string | Per-attempt working directory. Wiped between attempts; use for transient artefacts. |
| `log` | function | Structured logger; routes to the daemon's log surface. Always prefer `ctx.log` over `console.log`. |
| `abort` | `AbortSignal` | Fires when the daemon is shutting down or the attempt is aborted. Pass to fetch / SDK calls; respect cancellation. |
| `msUntilEndTs` | function | Milliseconds until the Task's `window.endTs`. Use for budget management. |
| `signer` | `ScopedSigner` \| undefined | Capability handle for signing + sending allow-listed calls. Present iff your manifest declared `capabilities.signer`. |
| `rpc` | `ScopedRpc` \| undefined | Capability handle for chain reads. Present iff your manifest declared `capabilities.rpc`. |
| `secrets` | `ScopedSecrets` \| undefined | Frozen `Record<string, string>` of secrets the operator provided per your `capabilities.secrets` declaration. Present iff declared. |

The capability handles are the trust-boundary surface; see `spec/2026-05-executor-trust-boundary.md` §3 for the canonical contract.

## `ExternalHarnessEnv`

Construction-time environment passed to your default-export factory.

```ts
export interface ExternalHarnessEnv {
  readonly implName: string;
  readonly implVersion: string;
  readonly network: string;
  readonly implStateDir: string;
  readonly secrets: ScopedSecrets;
  readonly log: HarnessContext['log'];
  readonly stub: boolean;
}
```

| Field | Notes |
|---|---|
| `implName`, `implVersion` | Convenience copies of the manifest's identity fields; assign them straight to `Harness.name` / `.version`. |
| `network` | The daemon's network string (`base-mainnet`, `base-sepolia`, etc.). String today; future tightening may move to `{ chainId, name }`. |
| `implStateDir` | Per-impl persistent dir, as in `HarnessContext`. |
| `secrets` | Same shape as `ctx.secrets`. Available at construction so you can validate your env before the first attempt. |
| `log` | Same logger as `ctx.log`. |
| `stub` | `true` when the daemon is running CLI introspection (`jinn harnesses show`, `jinn harnesses list`). Harnesses SHOULD report stub readiness via `isReady()` and avoid network calls when `stub === true`. |

`ExternalHarnessEnv` is a strict subset of the in-process `HarnessEnv` — it is JSON-serialisable, with no live `ExecutionAdapter` reference. Per `spec/2026-05-external-harnesses.md` §3.3, the construction-time invariant is "anything the Harness needs comes through here or `ctx`."

## `Solution`

Return shape for `run()`.

```ts
export interface Solution {
  venueRef: { name: string };
  preSnapshot?: Record<string, unknown>;
  postSnapshot?: Record<string, unknown>;
  fills?: unknown[];
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;
  solutionPayload?: Record<string, unknown>;
  verdictPayload?: Record<string, unknown>;
  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}
```

When to use which payload field:

- **`solutionPayload`** — for restoration Tasks. The solverType-specific payload that the evaluator will judge. For `prediction.v0`, this is the prediction itself.
- **`verdictPayload`** — for evaluation Tasks (`role === 'evaluation'`). The solverType-specific verdict the evaluator emits. For `prediction.v0`, this is the score + decomposition.
- **The portfolio-shape fields** (`preSnapshot`, `postSnapshot`, `fills`) — used by the `portfolio.v0` solverType. New solverTypes use `solutionPayload` / `verdictPayload`.

`gating` is the on-chain claim shape; `informational` is pass-through metadata; `rationale` is the human-readable reasoning trail surfaced in the corpus.

## `ScopedSigner`

```ts
export interface ScopedSigner {
  readonly address: Address;
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex>;
}
```

- **Allowed:** signing EIP-712 typed data for the manifest-declared domain; sending calls whose `(chainId, to, selector)` triple matches a manifest `capabilities.signer.selectors[]` entry.
- **Forbidden:** sending arbitrary calls. The daemon enforces the allow-list at call time and refuses with a clear error.

See `spec/2026-05-executor-trust-boundary.md` §3.2 for the canonical contract.

## `ScopedRpc`

```ts
export interface ScopedRpc {
  readContract(args: { address; abi; functionName; args? }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address }): Promise<bigint>;
  getCode(args: { address }): Promise<Hex | undefined>;
  getChainId(): Promise<number>;
}
```

- **Allowed:** the read-only RPC methods declared in the manifest's `capabilities.rpc[]` entries (`eth_call`, `eth_blockNumber`, `eth_getLogs`, etc.). Subject to per-manifest rate limits.
- **Forbidden:** writes (`eth_sendRawTransaction`), unmetered RPC. Writes go through `ScopedSigner.sendAllowedCall`.

## `ScopedSecrets`

```ts
export type ScopedSecrets = Readonly<Record<string, string>>;
```

A frozen string→string map of operator-provided secrets. Each declared secret in the manifest's `capabilities.secrets[]` becomes a key. Missing required secrets cause the daemon to refuse to load the Harness.

## `JinnManifest`

The signed package manifest, shipped as `jinn.manifest.json` next to your `package.json` in the repo and pinned to IPFS at publish time.

```ts
export interface JinnManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  description?: string;
  supportedSolverTypes: readonly string[];        // <solverType>(>=<semver>) per schema-versioning §2
  entry: string;                            // path to ./dist/index.js
  package: { cid: string; hash: `sha256:${string}` };
  capabilities: {
    signer?: { selectors: CapabilityAllowEntry[] };
    rpc?: ManifestRpcAllow[];
    secrets?: ManifestSecretSpec[];
  };
  signature: { alg: 'ed25519'; publicKey: string; sig: string };
  author?: { name: string; url?: string };
  license?: string;
}
```

See [publishing.md](./publishing.md) for the sign-and-pin flow and `spec/2026-05-executor-trust-boundary.md` §5.2 for the canonical schema.

## `SkippableError`

```ts
export class SkippableError extends Error {
  readonly reason: string;
}
```

Throw `SkippableError` from `run()` when you cannot solve a Task for a structural reason (market resolved, account un-funded, API down) and you want the daemon to release the claim cleanly without burning a delivery slot. Throw a regular `Error` for unexpected failures — the daemon logs them at error-level and treats them as bugs.

## Constants

- **`REQUIRES_LIVE_DAEMON_READINESS`** — a pre-built `ReadyStatus` for Harnesses that need a live daemon to be ready. Return it from `isReady()` when CLI introspection asks (`stub === true`).

## Generated from source

This doc tracks `packages/sdk/src/`. When you add a new public type to the SDK, edit the source first; this doc follows. If you find a discrepancy, treat the source as authoritative and file a doc patch.
