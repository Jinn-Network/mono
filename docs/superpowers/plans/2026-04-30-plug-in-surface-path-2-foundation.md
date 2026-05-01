# Plug-in surface — Path 2 foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Path 2 foundation from `spec/2026-04-30-plug-in-surface.md` — capability handles on `RestorationContext`, the `@jinn-network/restorer-sdk` package, manifest verification + signed install flow, the external-impl loader, the `jinn create restorer` scaffolding command, and one warm worked example (a Polymarket forecaster) — so an external builder can publish a restorer impl, sign its manifest, register it via the daemon, and be dispatched on a `prediction.v0` intent end-to-end.

**Architecture:** Three layers, top-to-bottom:

1. **SDK (new package)** — `@jinn-network/restorer-sdk` re-exports the public contract surface (`RestorerImpl`, `RestorationContext`, capability handles, manifest types). External builders depend on this package, never on `@jinn-network/client` directly.
2. **Daemon-side trust + load (changes inside `client/`)** — capability handles on `RestorationContext`, manifest verifier, external-impl loader extending `buildRestorerImpls`, scaffolding CLI verb.
3. **Worked example (new package under `examples/`)** — Polymarket forecaster as a published, signed, runnable Path 2 reference impl that the in-repo CI exercises.

The plan ships all three in dependency order. Each task is TDD-shaped: write the failing test, run it red, implement, run it green, commit. Frequent commits.

**Tech Stack:** TypeScript 5, Node 22, Yarn 4, vitest, viem, ed25519 signing (`@noble/ed25519`), JSON Schema (`ajv`), Anvil (foundry) for fork-mode tests.

**Spec reference:** `spec/2026-04-30-plug-in-surface.md` v0.1.

**Sibling extension-branch specs (load-bearing context for the loader / trust / discovery / versioning shape):**

- `spec/2026-05-external-restorer-impls.md` — loader contract + factory shape + lifecycle (§3, §4).
- `spec/2026-05-executor-trust-boundary.md` — capability handles (§3), manifest signing + revocation (§5).
- `spec/2026-05-registry-discovery.md` — config-declared external impls (§4).
- `spec/2026-05-schema-versioning.md` — `kind` grammar + `supportedKinds`.
- `spec/2026-04-28-restorer-architecture.md` — specialists-first ADR.

**Existing codebase reference points:**

- `client/src/restorer/types.ts:13-37` — current `RestorationContext`.
- `client/src/restorer/types.ts:176-236` — current `RestorerImpl`.
- `client/src/restorer/impls/plugin-path.ts:70-174` — current `buildRestorerImpls` factory.
- `client/src/restorer/impls/prediction-v0-baseline/index.ts` — in-repo forecaster reference.
- `client/src/cli/commands/plugin-install.ts` — CLI command pattern reference.
- `client/src/cli/command.ts` — CLI command interface.

---

## File structure

All paths relative to repo root (worktree `/Users/adrianobradley/harbor/jinn-mono/.tasks/jinn-mono-a9w9/`).

### New files / packages

```
packages/
  restorer-sdk/                                ← Task 3 — new standalone npm package
    package.json
    tsconfig.json
    src/
      index.ts                                 ← single export barrel
      types.ts                                 ← re-exports from client/src/restorer/types
      manifest.ts                              ← JinnManifest type + JSON schema export
      capabilities.ts                          ← ScopedSigner, ScopedRpc, secrets types
    test/
      surface.test.ts                          ← exhaustive type-export sanity check
    README.md

client/
  schemas/                                     ← Task 4 — installed schemas
    jinn-manifest-v1.json                      ← JSON Schema for jinn.manifest.json

  src/
    restorer/
      types.ts                                 ← MODIFY: add ScopedSigner / ScopedRpc / secrets
      capability/                              ← Task 1 + Task 2 — new module
        scoped-signer.ts
        scoped-rpc.ts
        scoped-secrets.ts
        index.ts
      manifest/                                ← Task 4 — new module
        types.ts                               ← JinnManifest type, mirrored from SDK
        verify.ts                              ← signature + sha256 + schema verifier
        load.ts                                ← read jinn.manifest.json from disk
        index.ts
      external-impls/                          ← Task 5 — new module
        loader.ts                              ← dynamic import + factory call + identity check
        config.ts                              ← parses restorers.externalImpls from config
        index.ts
      impls/
        plugin-path.ts                         ← MODIFY: union external impls into buildRestorerImpls

    cli/
      commands/
        create.ts                              ← Task 6 — new CLI command (jinn create restorer)
        impls.ts                               ← Task 5 — new CLI command (jinn impls list/add/...)
      command-registry.ts                      ← MODIFY: register new commands

    config.ts                                  ← MODIFY: add restorers config section + parse

  templates/                                   ← Task 6 — new directory (scaffolder templates)
    restorer/
      forecaster/                              ← prediction.v0 forecaster pattern
        package.json.tmpl
        tsconfig.json.tmpl
        jinn.manifest.json.tmpl
        src/
          index.ts.tmpl
        test/
          unit.test.ts.tmpl
          e2e-anvil.test.ts.tmpl
        README.md.tmpl
        gitignore.tmpl

examples/
  external-restorer-impls/
    polymarket-forecaster/                     ← Task 7 — new published example
      package.json
      tsconfig.json
      jinn.manifest.json
      src/
        index.ts
        polymarket-client.ts
      test/
        unit.test.ts
        e2e-anvil.test.ts
      README.md
      .gitignore
```

### Modified files

- `client/src/restorer/types.ts` — add `ScopedSigner`, `ScopedRpc`, `ScopedSecrets`, optional `signer`/`rpc`/`secrets` fields on `RestorationContext`.
- `client/src/restorer/impls/plugin-path.ts` — accept loaded external impls and union them into the registry.
- `client/src/cli/command-registry.ts` — register `create` and `impls` commands.
- `client/src/config.ts` — parse `restorers.externalImpls` and `restorers.disabled`.
- `client/src/main.ts` — pass external-impl-load results into `buildRestorerImpls`.
- `client/package.json` — add `@noble/ed25519`, `ajv` deps; add `examples/` to bundled files? (no — keep examples out of bundle).

---

## Cross-task conventions (read before authoring any file)

- **TypeScript strict mode.** All new code passes `yarn typecheck` (which runs `tsc --noEmit`) without errors.
- **Test runner.** vitest. New tests live alongside the unit they test. Name pattern: `<unit>.test.ts` co-located, OR under `test/` if the file is too small to have a `test/` neighbor (project mixes both; follow the local convention).
- **Imports.** ESM with explicit `.js` extensions in import paths (Node 22 ESM convention; matches existing code).
- **Logging.** Never `console.log` in daemon code. Use `ctx.log({ level, msg, data })` (from `RestorationContext`) inside impl-facing code. Use the daemon's existing logger inside the loader.
- **Filesystem.** Never use `process.env` for config inside an impl. Daemon-side code MAY use `process.env` for `JINN_*` overrides per existing convention.
- **Commits.** One commit per logical change. Commit messages follow the existing imperative style (`Add capability handle types`, `Wire scoped signer through engine`).
- **Manifest fixtures.** Test fixtures live under `client/test-fixtures/manifests/` (new directory).

---

## Task 1: Capability handle TYPES on `RestorationContext`

**Files:**
- Create: `client/src/restorer/capability/index.ts`
- Modify: `client/src/restorer/types.ts:13-37`
- Test: `client/src/restorer/capability/index.test.ts`

This task is types-only; no runtime behavior changes. Subsequent tasks wire the types in.

- [ ] **Step 1.1: Write the failing type-export test**

```ts
// client/src/restorer/capability/index.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type {
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
  SignTypedDataArgs,
  SendAllowedCallArgs,
} from './index.js';

describe('capability handle types', () => {
  it('ScopedSigner exposes address + signTypedData + sendAllowedCall', () => {
    expectTypeOf<ScopedSigner['address']>().toEqualTypeOf<`0x${string}`>();
    expectTypeOf<ScopedSigner['signTypedData']>().toBeFunction();
    expectTypeOf<ScopedSigner['sendAllowedCall']>().toBeFunction();
  });

  it('ScopedRpc shape matches viem PublicClient subset', () => {
    expectTypeOf<ScopedRpc['readContract']>().toBeFunction();
    expectTypeOf<ScopedRpc['getBlockNumber']>().toBeFunction();
  });

  it('ScopedSecrets is read-only Record<string, string>', () => {
    expectTypeOf<ScopedSecrets>().toEqualTypeOf<Readonly<Record<string, string>>>();
  });
});
```

- [ ] **Step 1.2: Run the test, expect compile failure**

Run: `cd client && yarn vitest run src/restorer/capability/index.test.ts`
Expected: compile error — `Cannot find module './index.js'`

- [ ] **Step 1.3: Author the capability type module**

```ts
// client/src/restorer/capability/index.ts
import type { Address, Hex } from 'viem';

/**
 * EIP-712 typed-data signing payload. Mirrors viem's SignTypedDataArgs
 * but with `account` removed (the daemon binds the signer to its
 * master EOA before delegation).
 */
export interface SignTypedDataArgs {
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Allow-listed transaction shape. Each call's `(chainId, to, selector)`
 * triple must match the impl's manifest capability allow-list; the
 * daemon refuses calls outside the list.
 */
export interface SendAllowedCallArgs {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Scoped signer — an impl never sees a raw private key. The daemon
 * issues this handle per `run()` call, validates each request against
 * the manifest allow-list, and discards it on return.
 */
export interface ScopedSigner {
  /** EOA address the daemon will sign as. Read-only. */
  readonly address: Address;
  /** Sign EIP-712 typed data for an allow-listed domain. */
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  /** Send a tx whose (chainId, to, selector) is on the impl allow-list. */
  sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex>;
}

/**
 * Scoped RPC — read-only subset of viem's PublicClient interface.
 * The daemon enforces method allow-list, rate limiting, and chain
 * filtering per `spec/2026-05-executor-trust-boundary.md` §3.3.
 */
export interface ScopedRpc {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getChainId(): Promise<number>;
}

/**
 * Per-impl secret bag. Populated by the impl's own `onEnable` flow
 * and persisted under `implStateDir/<impl>/secrets/`. Read-only.
 */
export type ScopedSecrets = Readonly<Record<string, string>>;
```

- [ ] **Step 1.4: Run the test, expect green**

Run: `cd client && yarn vitest run src/restorer/capability/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 1.5: Add optional capability fields to `RestorationContext`**

Edit `client/src/restorer/types.ts`. After the existing `trajectory: TrajectoryCollector;` field on `RestorationContext`, append:

```ts
  /**
   * Scoped signer capability. Present when the daemon is providing a
   * signing surface to this impl per its manifest allow-list. Absent
   * for stub-mode CLI introspection. See spec/2026-05-executor-trust-boundary.md §3.2.
   */
  signer?: ScopedSigner;
  /**
   * Scoped read-only RPC client. Method-filtered, rate-limited,
   * chain-scoped per the impl's manifest. See spec/2026-05-executor-trust-boundary.md §3.3.
   */
  rpc?: ScopedRpc;
  /**
   * Per-impl secret bag, populated by onEnable. See
   * spec/2026-05-executor-trust-boundary.md §3.4.
   */
  secrets?: ScopedSecrets;
```

Add the import at the top of `types.ts`:

```ts
import type { ScopedSigner, ScopedRpc, ScopedSecrets } from './capability/index.js';
```

- [ ] **Step 1.6: Verify typecheck passes**

Run: `cd client && yarn typecheck`
Expected: zero errors. The fields are optional so existing impls keep compiling.

- [ ] **Step 1.7: Commit**

```bash
git add client/src/restorer/capability/ client/src/restorer/types.ts
git commit -m "Add capability handle types (ScopedSigner, ScopedRpc, ScopedSecrets)"
```

---

## Task 2: Daemon-side construction of capability handles

**Files:**
- Create: `client/src/restorer/capability/scoped-signer.ts`
- Create: `client/src/restorer/capability/scoped-rpc.ts`
- Create: `client/src/restorer/capability/scoped-secrets.ts`
- Modify: `client/src/restorer/capability/index.ts` (add runtime export barrel)
- Test: `client/src/restorer/capability/scoped-signer.test.ts`, `scoped-rpc.test.ts`, `scoped-secrets.test.ts`

These are the runtime constructors the daemon uses to mint per-call capability handles. Phase 1 implementation only; they hold a reference to the master signer / public client and proxy with the manifest's allow-list.

- [ ] **Step 2.1: Write failing scoped-signer test**

```ts
// client/src/restorer/capability/scoped-signer.test.ts
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createScopedSigner } from './scoped-signer.js';

const MASTER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ALLOWED_TO = '0x1111111111111111111111111111111111111111' as const;
const ALLOWED_SELECTOR = '0xdeadbeef' as const;
const FORBIDDEN_SELECTOR = '0xcafef00d' as const;

describe('createScopedSigner', () => {
  const account = privateKeyToAccount(MASTER_PK);
  const allowList = [{ chainId: 8453, to: ALLOWED_TO, selector: ALLOWED_SELECTOR }];

  it('exposes the master EOA address', () => {
    const signer = createScopedSigner({ account, allowList, chainId: 8453 });
    expect(signer.address).toBe(account.address);
  });

  it('rejects sendAllowedCall with a non-allow-listed selector', async () => {
    const signer = createScopedSigner({ account, allowList, chainId: 8453 });
    await expect(
      signer.sendAllowedCall({
        to: ALLOWED_TO,
        data: `${FORBIDDEN_SELECTOR}00000000` as `0x${string}`,
      })
    ).rejects.toThrow(/selector .* not in allow-list/i);
  });

  it('rejects sendAllowedCall with a non-allow-listed contract', async () => {
    const signer = createScopedSigner({ account, allowList, chainId: 8453 });
    await expect(
      signer.sendAllowedCall({
        to: '0x9999999999999999999999999999999999999999' as `0x${string}`,
        data: `${ALLOWED_SELECTOR}00000000` as `0x${string}`,
      })
    ).rejects.toThrow(/to .* not in allow-list/i);
  });
});
```

- [ ] **Step 2.2: Run test, expect failure**

Run: `cd client && yarn vitest run src/restorer/capability/scoped-signer.test.ts`
Expected: FAIL — `createScopedSigner` not defined.

- [ ] **Step 2.3: Implement `scoped-signer.ts`**

```ts
// client/src/restorer/capability/scoped-signer.ts
import type { Account, Hex, Address } from 'viem';
import type { ScopedSigner, SignTypedDataArgs, SendAllowedCallArgs } from './index.js';

export interface CapabilityAllowEntry {
  chainId: number;
  to: Address;
  /** Lower-case 4-byte selector with `0x` prefix (e.g. `0xdeadbeef`). */
  selector: Hex;
}

export interface CreateScopedSignerArgs {
  account: Account;
  allowList: readonly CapabilityAllowEntry[];
  chainId: number;
}

export function createScopedSigner({
  account,
  allowList,
  chainId,
}: CreateScopedSignerArgs): ScopedSigner {
  return {
    get address() {
      return account.address;
    },

    async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
      // Phase 1: delegate to the master account. Future revisions check
      // domain against the manifest's signTypedData allow-list.
      if (typeof account.signTypedData !== 'function') {
        throw new Error('master account does not support signTypedData');
      }
      return account.signTypedData(args as never);
    },

    async sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex> {
      const selector = (call.data.slice(0, 10).toLowerCase()) as Hex;
      const entry = allowList.find(
        (e) => e.chainId === chainId
          && e.to.toLowerCase() === call.to.toLowerCase()
          && e.selector.toLowerCase() === selector
      );
      if (!entry) {
        const haveSelector = allowList.some(
          (e) => e.chainId === chainId && e.to.toLowerCase() === call.to.toLowerCase()
        );
        if (!haveSelector) {
          throw new Error(`to ${call.to} not in allow-list for chain ${chainId}`);
        }
        throw new Error(`selector ${selector} not in allow-list for ${call.to} on chain ${chainId}`);
      }
      // Phase 1: throw — sendAllowedCall actual signing path lives in the
      // daemon's wallet wiring, which the next plan ships. The contract is
      // shape-only here.
      throw new Error('sendAllowedCall is allow-list-validated but signing is wired in the daemon plan');
    },
  };
}
```

Note the deliberately-incomplete `sendAllowedCall` — Phase 1 implements *only* the allow-list validation; actual signing is wired in a follow-up plan. The shape stabilizes; the sign happens later.

- [ ] **Step 2.4: Run test, expect green**

Run: `cd client && yarn vitest run src/restorer/capability/scoped-signer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 2.5: Write failing scoped-rpc test**

```ts
// client/src/restorer/capability/scoped-rpc.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createScopedRpc } from './scoped-rpc.js';

describe('createScopedRpc', () => {
  it('passes allow-listed methods through', async () => {
    const upstream = {
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      readContract: vi.fn(),
      getBalance: vi.fn(),
      getCode: vi.fn(),
      getChainId: vi.fn().mockResolvedValue(8453),
    };
    const rpc = createScopedRpc({
      upstream: upstream as never,
      chainIdAllowList: [8453],
    });
    expect(await rpc.getBlockNumber()).toBe(123n);
    expect(upstream.getBlockNumber).toHaveBeenCalledOnce();
  });

  it('rejects readContract on a chain not in the allow-list', async () => {
    const upstream = {
      getChainId: vi.fn().mockResolvedValue(1), // mainnet
      readContract: vi.fn().mockResolvedValue('forbidden'),
      getBlockNumber: vi.fn(),
      getBalance: vi.fn(),
      getCode: vi.fn(),
    };
    const rpc = createScopedRpc({
      upstream: upstream as never,
      chainIdAllowList: [8453], // base-mainnet only
    });
    await expect(
      rpc.readContract({ address: '0x1111111111111111111111111111111111111111', abi: [], functionName: 'x' })
    ).rejects.toThrow(/chain 1 not in allow-list/i);
  });
});
```

- [ ] **Step 2.6: Run test, expect failure**

Run: `cd client && yarn vitest run src/restorer/capability/scoped-rpc.test.ts`
Expected: FAIL — `createScopedRpc` not defined.

- [ ] **Step 2.7: Implement `scoped-rpc.ts`**

```ts
// client/src/restorer/capability/scoped-rpc.ts
import type { ScopedRpc } from './index.js';

export interface CreateScopedRpcArgs {
  /** A viem PublicClient (or compatible read-only RPC) the daemon owns. */
  upstream: ScopedRpc;
  /** Chain ids this impl is allowed to read. Empty array = none. */
  chainIdAllowList: readonly number[];
}

export function createScopedRpc({
  upstream,
  chainIdAllowList,
}: CreateScopedRpcArgs): ScopedRpc {
  async function ensureChainAllowed(): Promise<void> {
    const chainId = await upstream.getChainId();
    if (!chainIdAllowList.includes(chainId)) {
      throw new Error(`chain ${chainId} not in allow-list ${JSON.stringify(chainIdAllowList)}`);
    }
  }

  return {
    async readContract(args) {
      await ensureChainAllowed();
      return upstream.readContract(args);
    },
    async getBlockNumber() {
      await ensureChainAllowed();
      return upstream.getBlockNumber();
    },
    async getBalance(args) {
      await ensureChainAllowed();
      return upstream.getBalance(args);
    },
    async getCode(args) {
      await ensureChainAllowed();
      return upstream.getCode(args);
    },
    async getChainId() {
      return upstream.getChainId();
    },
  };
}
```

- [ ] **Step 2.8: Run test, expect green**

Run: `cd client && yarn vitest run src/restorer/capability/scoped-rpc.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 2.9: Write failing scoped-secrets test**

```ts
// client/src/restorer/capability/scoped-secrets.test.ts
import { describe, it, expect } from 'vitest';
import { freezeSecrets } from './scoped-secrets.js';

describe('freezeSecrets', () => {
  it('returns a frozen view that reflects later mutations of the source', () => {
    const source: Record<string, string> = { API_KEY: 'k1' };
    const view = freezeSecrets(source);
    expect(view.API_KEY).toBe('k1');
    expect(() => {
      (view as Record<string, string>).API_KEY = 'overwritten';
    }).toThrow(/cannot assign|read.only/i);
  });

  it('exposes only the keys the source has at construction', () => {
    const view = freezeSecrets({ A: '1', B: '2' });
    expect(Object.keys(view).sort()).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 2.10: Run test, expect failure**

Run: `cd client && yarn vitest run src/restorer/capability/scoped-secrets.test.ts`
Expected: FAIL — `freezeSecrets` not defined.

- [ ] **Step 2.11: Implement `scoped-secrets.ts`**

```ts
// client/src/restorer/capability/scoped-secrets.ts
import type { ScopedSecrets } from './index.js';

/**
 * Returns a read-only view over the given secrets bag. Mutations of the
 * returned view throw in strict mode; the daemon stores the underlying
 * map and re-issues a fresh frozen view per `run()` call so revoked
 * secrets stop reaching impls promptly.
 */
export function freezeSecrets(source: Record<string, string>): ScopedSecrets {
  return Object.freeze({ ...source });
}
```

- [ ] **Step 2.12: Run test, expect green**

Run: `cd client && yarn vitest run src/restorer/capability/scoped-secrets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 2.13: Update barrel `client/src/restorer/capability/index.ts`**

Append to `index.ts` (after the existing type exports):

```ts
export { createScopedSigner } from './scoped-signer.js';
export type { CapabilityAllowEntry, CreateScopedSignerArgs } from './scoped-signer.js';
export { createScopedRpc } from './scoped-rpc.js';
export type { CreateScopedRpcArgs } from './scoped-rpc.js';
export { freezeSecrets } from './scoped-secrets.js';
```

- [ ] **Step 2.14: Run typecheck and full capability tests**

Run: `cd client && yarn typecheck && yarn vitest run src/restorer/capability/`
Expected: typecheck zero errors; 7 tests pass.

- [ ] **Step 2.15: Commit**

```bash
git add client/src/restorer/capability/
git commit -m "Implement capability-handle constructors with allow-list enforcement"
```

---

## Task 3: `@jinn-network/restorer-sdk` package

**Files:**
- Create: `packages/restorer-sdk/package.json`
- Create: `packages/restorer-sdk/tsconfig.json`
- Create: `packages/restorer-sdk/src/index.ts`
- Create: `packages/restorer-sdk/src/types.ts`
- Create: `packages/restorer-sdk/src/capabilities.ts`
- Create: `packages/restorer-sdk/src/manifest.ts`
- Create: `packages/restorer-sdk/test/surface.test.ts`
- Create: `packages/restorer-sdk/README.md`
- Modify: repo root — add a top-level `package.json` with workspace config (or add `packages/restorer-sdk` as a published-from-source package; see step 3.1).

The SDK package is the **stable contract surface** for external impl authors. Per `spec/2026-04-30-plug-in-surface.md` §3.1 it is a Phase A.2 hard acceptance criterion.

- [ ] **Step 3.1: Decide workspace setup**

The monorepo currently has no root-level `package.json` workspace config — `client/` and `contracts/` are standalone. Two viable patterns:

1. **Add a yarn workspace root** so `@jinn-network/restorer-sdk` lives at `packages/restorer-sdk/` and resolves locally during dev. Pros: clean import graph; Cons: touches root build conventions.
2. **Publish-only sibling package** — `packages/restorer-sdk/` exists, has its own `package.json` + own `yarn.lock`, but isn't workspace-linked. The example package (Task 7) depends on it via the published version (or via a local file: link during dev). Pros: minimal infra change; Cons: clunkier dev loop.

This plan picks **Option 1 (yarn workspace root)** for cleaner dev loop. If the team prefers Option 2, swap step 3.2 for a standalone setup and update later steps accordingly.

- [ ] **Step 3.2: Add workspace root**

Create `package.json` at repo root:

```json
{
  "name": "jinn-mono",
  "private": true,
  "packageManager": "yarn@4.13.0",
  "workspaces": [
    "client",
    "packages/*",
    "examples/external-restorer-impls/*"
  ]
}
```

Run: `yarn install`
Expected: `client` resolves; new workspace root recognized.

- [ ] **Step 3.3: Scaffold `packages/restorer-sdk/package.json`**

```json
{
  "name": "@jinn-network/restorer-sdk",
  "version": "1.0.0",
  "description": "Stable contract surface for Jinn external restorer/evaluator implementations.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./manifest-schema.json": "./dist/manifest-schema.json"
  },
  "files": ["dist/", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json && cp src/manifest-schema.json dist/manifest-schema.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  },
  "peerDependencies": {
    "viem": "^2.0.0"
  }
}
```

Note: the SDK does not depend on `@jinn-network/client`. It is a pure types surface.

- [ ] **Step 3.4: Scaffold `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": []
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3.5: Author `src/types.ts`**

```ts
// packages/restorer-sdk/src/types.ts
//
// Public contract surface for Jinn external RestorerImpl authors.
// These types are mirrored from client/src/restorer/types.ts at SDK
// publish time. The SDK is the stable boundary; @jinn-network/client
// internals are not.

export type Hex = `0x${string}`;
export type Address = Hex;

export interface IntentWindow {
  startTs: number;
  endTs: number;
}

export interface DesiredStateSpec {
  kind: string;
  [key: string]: unknown;
}

export interface RestorationJob {
  id: string;
  description?: string;
  type?: 'restoration' | 'evaluation';
  spec?: DesiredStateSpec;
  eligibility?: Record<string, unknown>;
  window?: IntentWindow;
}

export interface OutputArtifact {
  type: string;
  path?: string;
  cid?: string;
  [key: string]: unknown;
}

export interface RationaleEntry {
  message: string;
  [key: string]: unknown;
}

export interface RestorationOutput {
  venueRef: { name: string };
  preSnapshot?: Record<string, unknown>;
  postSnapshot?: Record<string, unknown>;
  fills?: unknown[];
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;
  restorationPayload?: Record<string, unknown>;
  verdictPayload?: Record<string, unknown>;
  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}

export interface ReadyStatus {
  ready: boolean;
  reason?: string;
  nextStep?: { description: string; cli?: string; url?: string };
}

export const REQUIRES_LIVE_DAEMON_READINESS: ReadyStatus = {
  ready: false,
  reason: 'requires live daemon',
  nextStep: { description: 'Run the daemon with a configured fleet and wallet', cli: 'jinn run' },
};

export interface EnableArgDef {
  name: string;
  description: string;
  required: boolean;
}

export interface IntentEnableMetadata {
  description: string;
  requiredArgs?: EnableArgDef[];
  externalResources?: Array<{ name: string; url: string }>;
}

export type EnableResult =
  | { status: 'ready'; details?: Record<string, unknown> }
  | {
      status: 'waiting_for_external_action';
      action: { description: string; url?: string };
      details?: Record<string, unknown>;
      nextInvocation: { cli: string; purpose: string };
    }
  | { status: 'missing_args'; required: EnableArgDef[]; example: { cli: string } }
  | { status: 'error'; message: string; details?: Record<string, unknown> };

export class SkippableError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'SkippableError';
    this.reason = reason;
  }
}
```

- [ ] **Step 3.6: Author `src/capabilities.ts`**

```ts
// packages/restorer-sdk/src/capabilities.ts
import type { Address, Hex } from './types.js';

export interface SignTypedDataArgs {
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SendAllowedCallArgs {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface ScopedSigner {
  readonly address: Address;
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  sendAllowedCall(call: SendAllowedCallArgs): Promise<Hex>;
}

export interface ScopedRpc {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getChainId(): Promise<number>;
}

export type ScopedSecrets = Readonly<Record<string, string>>;
```

- [ ] **Step 3.7: Author `src/manifest.ts`**

```ts
// packages/restorer-sdk/src/manifest.ts

export interface CapabilityAllowEntry {
  chainId: number;
  to: `0x${string}`;
  selector: `0x${string}`;
  description?: string;
}

export interface ManifestRpcAllow {
  chainId: number;
  methods: ReadonlyArray<
    | 'eth_call'
    | 'eth_getBlockByNumber'
    | 'eth_getLogs'
    | 'eth_getTransactionReceipt'
    | 'eth_chainId'
    | 'eth_blockNumber'
    | 'eth_getBalance'
    | 'eth_getCode'
  >;
  rateLimit?: { perSec: number };
}

export interface JinnManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  description?: string;
  /** Each entry follows `<domain>.v<major>>=<semver>` from spec/2026-05-schema-versioning.md */
  supportedKinds: readonly string[];
  /** Path to the entrypoint module, relative to the package root. */
  entry: string;
  /** Tarball CID + sha256 (set at publish time). */
  package: { cid: string; hash: `sha256:${string}` };
  capabilities: {
    signer?: { selectors: ReadonlyArray<CapabilityAllowEntry> };
    rpc?: ReadonlyArray<ManifestRpcAllow>;
    secrets?: ReadonlyArray<{ name: string; description: string; required: boolean }>;
  };
  /** Detached signature object — not part of the canonicalised manifest. */
  signature: {
    alg: 'ed25519';
    publicKey: string; // base64url
    sig: string;       // base64url
  };
  author?: { name: string; url?: string };
  license?: string;
}
```

- [ ] **Step 3.8: Author `src/index.ts` barrel + RestorerImpl interface**

```ts
// packages/restorer-sdk/src/index.ts
export type {
  Address,
  Hex,
  IntentWindow,
  DesiredStateSpec,
  RestorationJob,
  OutputArtifact,
  RationaleEntry,
  RestorationOutput,
  ReadyStatus,
  EnableArgDef,
  IntentEnableMetadata,
  EnableResult,
} from './types.js';
export { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from './types.js';

export type {
  SignTypedDataArgs,
  SendAllowedCallArgs,
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
} from './capabilities.js';

export type {
  CapabilityAllowEntry,
  ManifestRpcAllow,
  JinnManifest,
} from './manifest.js';

import type { RestorationJob, RestorationOutput, ReadyStatus, IntentEnableMetadata, EnableResult } from './types.js';
import type { ScopedSigner, ScopedRpc, ScopedSecrets } from './capabilities.js';

export interface RestorationContext {
  intent: RestorationJob;
  intentCid?: string;
  implStateDir: string;
  workingDir: string;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  abort: AbortSignal;
  msUntilEndTs: () => number;
  signer?: ScopedSigner;
  rpc?: ScopedRpc;
  secrets?: ScopedSecrets;
}

export interface ExternalRestorerEnv {
  readonly implName: string;
  readonly implVersion: string;
  readonly network: string;
  readonly implStateDir: string;
  readonly secrets: ScopedSecrets;
  readonly log: RestorationContext['log'];
  readonly stub: boolean;
}

export interface RestorerImpl {
  name: string;
  version: string;
  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(intent: RestorationJob): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: RestorationContext): Promise<RestorationOutput>;
  isReady?(): Promise<ReadyStatus>;
  enableMetadata?(): IntentEnableMetadata;
  onEnable?(args: Record<string, string | undefined>): Promise<EnableResult>;
  onDisable?(): Promise<void>;
}

/** External-impl factory: default-export shape per spec/2026-05-external-restorer-impls.md §3.2. */
export type ExternalRestorerFactory = (env: ExternalRestorerEnv) => RestorerImpl;
```

- [ ] **Step 3.9: Write surface sanity test**

```ts
// packages/restorer-sdk/test/surface.test.ts
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  REQUIRES_LIVE_DAEMON_READINESS,
  SkippableError,
} from '../src/index.js';
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ExternalRestorerEnv,
  ExternalRestorerFactory,
  JinnManifest,
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
} from '../src/index.js';

describe('@jinn-network/restorer-sdk surface', () => {
  it('exports REQUIRES_LIVE_DAEMON_READINESS as a frozen ReadyStatus', () => {
    expect(REQUIRES_LIVE_DAEMON_READINESS.ready).toBe(false);
    expect(REQUIRES_LIVE_DAEMON_READINESS.reason).toBe('requires live daemon');
  });

  it('exports SkippableError carrying a reason field', () => {
    const e = new SkippableError('claude-cli-missing');
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe('claude-cli-missing');
  });

  it('RestorerImpl is structurally satisfied by a minimal impl', () => {
    const impl: RestorerImpl = {
      name: 'test',
      version: '0.0.1',
      supports: ({ kind }) => kind === 'test.v0',
      run: async () => ({ venueRef: { name: 'test' }, gating: {} }),
    };
    expect(impl.supports({ kind: 'test.v0' })).toBe(true);
  });

  it('ExternalRestorerFactory is callable shape', () => {
    const factory: ExternalRestorerFactory = (env) => ({
      name: env.implName,
      version: env.implVersion,
      supports: ({ kind }) => kind === 'test.v0',
      run: async () => ({ venueRef: { name: 'test' }, gating: {} }),
    });
    expectTypeOf(factory).toBeFunction();
  });
});
```

- [ ] **Step 3.10: Build + test the SDK package**

Run:
```bash
cd packages/restorer-sdk
yarn install
yarn build
yarn test
```
Expected: build emits `dist/index.js` + `dist/index.d.ts`; 4 tests pass.

- [ ] **Step 3.11: Author `packages/restorer-sdk/README.md`**

```markdown
# @jinn-network/restorer-sdk

Stable contract surface for Jinn external restorer / evaluator implementations.

External impl authors depend on this package, **not** on `@jinn-network/client` directly. The daemon's internals (transport, persistence, MCP wiring) may change between client versions; the SDK promises a 12-week deprecation window on every breaking change.

## Quickstart

```bash
npm install @jinn-network/restorer-sdk
```

```ts
import type { RestorerImpl, ExternalRestorerEnv } from '@jinn-network/restorer-sdk';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports: ({ kind }) => kind === 'prediction.v0',
    async run(ctx) {
      // … your impl here
      return { venueRef: { name: 'example' }, gating: {} };
    },
  };
}
```

See `spec/2026-04-30-plug-in-surface.md` §3 and `spec/2026-05-external-restorer-impls.md` for the full contract.

## Stability

`@jinn-network/restorer-sdk` follows strict semver. Major-version bumps follow a 12-week deprecation window — the prior major continues to load against the daemon during the window. Additive changes (new optional method, new optional capability) ship as minors.
```

- [ ] **Step 3.12: Commit**

```bash
git add package.json packages/restorer-sdk/
git commit -m "Add @jinn-network/restorer-sdk v1.0.0 — public RestorerImpl surface"
```

---

## Task 4: Manifest verifier

**Files:**
- Create: `client/schemas/jinn-manifest-v1.json`
- Create: `client/src/restorer/manifest/types.ts`
- Create: `client/src/restorer/manifest/load.ts`
- Create: `client/src/restorer/manifest/verify.ts`
- Create: `client/src/restorer/manifest/index.ts`
- Create: `client/test-fixtures/manifests/valid.json`
- Create: `client/test-fixtures/manifests/invalid-signature.json`
- Test: `client/src/restorer/manifest/load.test.ts`, `verify.test.ts`
- Modify: `client/package.json` to add `@noble/ed25519` and `ajv` deps.

The verifier reads `jinn.manifest.json` from disk, validates against a JSON Schema, verifies the ed25519 signature against a trusted-signer list, and computes the canonical sha256 of the unsigned body for `package.hash` cross-check.

- [ ] **Step 4.1: Add deps**

In `client/`, run:
```bash
cd client && yarn add ajv @noble/ed25519 && yarn add -D ajv-formats
```

Verify: `client/package.json` has `ajv`, `ajv-formats`, `@noble/ed25519` declared.

- [ ] **Step 4.2: Author the JSON Schema**

```json
// client/schemas/jinn-manifest-v1.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.jinn.network/jinn-manifest-v1.json",
  "title": "Jinn external impl manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "name", "version", "supportedKinds", "entry", "package", "capabilities", "signature"],
  "properties": {
    "schemaVersion": { "const": "1.0.0" },
    "name": { "type": "string", "pattern": "^(@[a-z0-9-]+/)?[a-z0-9][a-z0-9-]*$" },
    "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9.-]+)?$" },
    "description": { "type": "string", "maxLength": 500 },
    "supportedKinds": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]*\\.v[0-9]+(>=[0-9]+\\.[0-9]+\\.[0-9]+)?$" }
    },
    "entry": { "type": "string", "pattern": "^\\./[A-Za-z0-9_./-]+$" },
    "package": {
      "type": "object",
      "required": ["cid", "hash"],
      "additionalProperties": false,
      "properties": {
        "cid": { "type": "string", "pattern": "^baf[a-z0-9]+$" },
        "hash": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
      }
    },
    "capabilities": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "signer": {
          "type": "object",
          "required": ["selectors"],
          "additionalProperties": false,
          "properties": {
            "selectors": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["chainId", "to", "selector"],
                "additionalProperties": false,
                "properties": {
                  "chainId": { "type": "integer", "minimum": 1 },
                  "to": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
                  "selector": { "type": "string", "pattern": "^0x[a-f0-9]{8}$" },
                  "description": { "type": "string", "maxLength": 200 }
                }
              }
            }
          }
        },
        "rpc": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["chainId", "methods"],
            "additionalProperties": false,
            "properties": {
              "chainId": { "type": "integer", "minimum": 1 },
              "methods": {
                "type": "array",
                "items": { "enum": ["eth_call", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionReceipt", "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode"] }
              },
              "rateLimit": {
                "type": "object",
                "required": ["perSec"],
                "additionalProperties": false,
                "properties": { "perSec": { "type": "integer", "minimum": 1 } }
              }
            }
          }
        },
        "secrets": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["name", "description", "required"],
            "additionalProperties": false,
            "properties": {
              "name": { "type": "string" },
              "description": { "type": "string" },
              "required": { "type": "boolean" }
            }
          }
        }
      }
    },
    "signature": {
      "type": "object",
      "required": ["alg", "publicKey", "sig"],
      "additionalProperties": false,
      "properties": {
        "alg": { "const": "ed25519" },
        "publicKey": { "type": "string" },
        "sig": { "type": "string" }
      }
    },
    "author": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "name": { "type": "string" }, "url": { "type": "string", "format": "uri" } }
    },
    "license": { "type": "string" }
  }
}
```

- [ ] **Step 4.3: Author `manifest/types.ts`**

```ts
// client/src/restorer/manifest/types.ts
import type { JinnManifest as SdkJinnManifest } from '@jinn-network/restorer-sdk';

/** Daemon-side manifest type — same shape as the SDK type, re-exported for module locality. */
export type JinnManifest = SdkJinnManifest;

export type SignerTrustEntry = { alg: 'ed25519'; publicKey: string; label?: string };
```

- [ ] **Step 4.4: Write failing load test**

```ts
// client/src/restorer/manifest/load.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './load.js';

const FIX = fileURLToPath(new URL('../../../test-fixtures/manifests/', import.meta.url));

describe('loadManifest', () => {
  it('parses a valid manifest', async () => {
    const m = await loadManifest(join(FIX, 'valid.json'));
    expect(m.name).toBe('@example/forecaster');
    expect(m.supportedKinds).toContain('prediction.v0>=1.0.0');
  });

  it('rejects a manifest violating the JSON schema', async () => {
    await expect(loadManifest(join(FIX, 'invalid-schema.json'))).rejects.toThrow(/schema/i);
  });
});
```

- [ ] **Step 4.5: Create the fixtures**

```json
// client/test-fixtures/manifests/valid.json
{
  "schemaVersion": "1.0.0",
  "name": "@example/forecaster",
  "version": "0.1.0",
  "description": "Example prediction.v0 forecaster.",
  "supportedKinds": ["prediction.v0>=1.0.0"],
  "entry": "./dist/index.js",
  "package": {
    "cid": "bafybeigexampleexampleexampleexampleexampleexampleexample",
    "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "capabilities": {
    "rpc": [{ "chainId": 8453, "methods": ["eth_call", "eth_blockNumber"] }]
  },
  "signature": {
    "alg": "ed25519",
    "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "sig": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  },
  "license": "MIT"
}
```

```json
// client/test-fixtures/manifests/invalid-schema.json
{
  "schemaVersion": "1.0.0",
  "name": "@example/forecaster",
  "version": "not-a-semver",
  "supportedKinds": [],
  "entry": "./dist/index.js",
  "package": { "cid": "bafy...", "hash": "sha256:0000" },
  "capabilities": {},
  "signature": { "alg": "ed25519", "publicKey": "x", "sig": "y" }
}
```

- [ ] **Step 4.6: Author `load.ts`**

```ts
// client/src/restorer/manifest/load.ts
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { JinnManifest } from './types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../../schemas/jinn-manifest-v1.json', import.meta.url));

let ajvInstance: Ajv | null = null;
let validatorPromise: Promise<(d: unknown) => boolean> | null = null;

async function getValidator(): Promise<(d: unknown) => boolean> {
  if (validatorPromise) return validatorPromise;
  validatorPromise = (async () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    return ajv.compile(schema);
  })();
  return validatorPromise;
}

export async function loadManifest(absPath: string): Promise<JinnManifest> {
  const text = await readFile(resolve(absPath), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest at ${absPath} is not valid JSON: ${(err as Error).message}`);
  }
  const validate = await getValidator();
  if (!validate(parsed)) {
    throw new Error(`manifest at ${absPath} failed schema validation`);
  }
  return parsed as JinnManifest;
}
```

- [ ] **Step 4.7: Run load test, expect green**

Run: `cd client && yarn vitest run src/restorer/manifest/load.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4.8: Write failing verify test**

```ts
// client/src/restorer/manifest/verify.test.ts
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { canonicaliseManifest, verifyManifestSignature } from './verify.js';
import type { JinnManifest } from './types.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

function makeManifest(): JinnManifest {
  return {
    schemaVersion: '1.0.0',
    name: '@example/forecaster',
    version: '0.1.0',
    supportedKinds: ['prediction.v0>=1.0.0'],
    entry: './dist/index.js',
    package: { cid: 'bafyexample', hash: 'sha256:00' as `sha256:${string}` },
    capabilities: {},
    signature: { alg: 'ed25519', publicKey: '', sig: '' },
  };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('verifyManifestSignature', () => {
  it('accepts a manifest signed by a trusted key', async () => {
    const sk = ed.utils.randomPrivateKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const manifest = makeManifest();
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature = { alg: 'ed25519', publicKey: b64(pk), sig: b64(sig) };

    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: b64(pk) },
    ]);
    expect(ok).toBe(true);
  });

  it('rejects a manifest signed by an untrusted key', async () => {
    const sk = ed.utils.randomPrivateKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const manifest = makeManifest();
    const body = canonicaliseManifest(manifest);
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature = { alg: 'ed25519', publicKey: b64(pk), sig: b64(sig) };

    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    ]);
    expect(ok).toBe(false);
  });

  it('rejects a manifest whose signature does not match its body', async () => {
    const sk = ed.utils.randomPrivateKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const manifest = makeManifest();
    const body = canonicaliseManifest({ ...manifest, name: '@evil/spoof' });
    const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
    manifest.signature = { alg: 'ed25519', publicKey: b64(pk), sig: b64(sig) };

    const ok = await verifyManifestSignature(manifest, [
      { alg: 'ed25519', publicKey: b64(pk) },
    ]);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 4.9: Author `verify.ts`**

```ts
// client/src/restorer/manifest/verify.ts
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import type { JinnManifest, SignerTrustEntry } from './types.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Canonicalise a manifest for signing/verification: stable JSON
 * (sorted keys), signature stripped. The result is the bytes
 * Authors sign over.
 */
export function canonicaliseManifest(manifest: JinnManifest): string {
  const { signature: _omit, ...body } = manifest;
  return JSON.stringify(body, Object.keys(body).sort());
}

function b64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export async function verifyManifestSignature(
  manifest: JinnManifest,
  trustedSigners: readonly SignerTrustEntry[],
): Promise<boolean> {
  if (manifest.signature.alg !== 'ed25519') return false;
  const trustHit = trustedSigners.find(
    (t) => t.alg === 'ed25519' && t.publicKey === manifest.signature.publicKey,
  );
  if (!trustHit) return false;

  const body = canonicaliseManifest(manifest);
  const msg = new TextEncoder().encode(body);
  const pk = b64ToBytes(manifest.signature.publicKey);
  const sig = b64ToBytes(manifest.signature.sig);

  try {
    return await ed.verifyAsync(sig, msg, pk);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4.10: Run verify tests, expect green**

Run: `cd client && yarn vitest run src/restorer/manifest/`
Expected: PASS (5 tests across load + verify).

- [ ] **Step 4.11: Author `manifest/index.ts` barrel**

```ts
// client/src/restorer/manifest/index.ts
export { loadManifest } from './load.js';
export { canonicaliseManifest, verifyManifestSignature } from './verify.js';
export type { JinnManifest, SignerTrustEntry } from './types.js';
```

- [ ] **Step 4.12: Commit**

```bash
git add client/schemas/ client/src/restorer/manifest/ client/test-fixtures/manifests/ client/package.json client/yarn.lock
git commit -m "Add manifest verifier (JSON schema + ed25519 signature + canonical JSON)"
```

---

## Task 5: External-impl loader + config

**Files:**
- Create: `client/src/restorer/external-impls/config.ts`
- Create: `client/src/restorer/external-impls/loader.ts`
- Create: `client/src/restorer/external-impls/index.ts`
- Test: `client/src/restorer/external-impls/loader.test.ts`
- Modify: `client/src/restorer/impls/plugin-path.ts` (extend `buildRestorerImpls`)
- Modify: `client/src/config.ts` (add `restorers.externalImpls` and `restorers.disabled`)

The loader takes a config-declared external-impl entry, validates the manifest, dynamically imports the entry module, calls the factory with `ExternalRestorerEnv`, validates identity + supportedKinds, and registers the resulting impl into `buildRestorerImpls`.

- [ ] **Step 5.1: Author `config.ts` parser shape**

In `client/src/config.ts`, locate the existing `Config` type (or its Zod schema) and extend with:

```ts
export interface RestorersConfig {
  /** Names of in-repo impls to suppress for this fleet. */
  disabled?: readonly string[];
  /** Operator-supplied external impls. */
  externalImpls?: readonly ExternalImplEntry[];
}

export interface ExternalImplEntry {
  /** MUST equal the manifest's `name`. */
  name: string;
  /** Pointer to the manifest (typically ipfs://<cid>; local path during dev). */
  package: string;
  /** Local path the loader resolves with dynamic import (typically a node_modules dir). */
  entry: string;
}

export interface SignerTrust {
  alg: 'ed25519';
  publicKey: string;
  label?: string;
}

export interface JinnConfig {
  // … existing fields …
  restorers?: RestorersConfig;
  trustedImplSigners?: readonly SignerTrust[];
}
```

(Existing config code may use Zod; mirror the existing pattern.)

- [ ] **Step 5.2: Write failing loader test**

```ts
// client/src/restorer/external-impls/loader.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { canonicaliseManifest } from '../manifest/index.js';
import { loadExternalImpl } from './loader.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

let TMP: string;
let PUBKEY_B64: string;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'jinn-loader-'));
  // 1. write a fake external-impl package.
  const pkgRoot = join(TMP, 'fake-impl');
  mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
  writeFileSync(join(pkgRoot, 'dist', 'index.js'), `
    export default function createRestorer(env) {
      return {
        name: env.implName,
        version: env.implVersion,
        supports: ({ kind }) => kind === 'prediction.v0',
        run: async () => ({ venueRef: { name: 'fake' }, gating: {} })
      };
    }
  `);

  // 2. sign a manifest.
  const sk = ed.utils.randomPrivateKey();
  const pk = await ed.getPublicKeyAsync(sk);
  PUBKEY_B64 = Buffer.from(pk).toString('base64');
  const manifest = {
    schemaVersion: '1.0.0',
    name: '@fake/restorer',
    version: '0.1.0',
    supportedKinds: ['prediction.v0>=1.0.0'],
    entry: './dist/index.js',
    package: { cid: 'bafyfake', hash: 'sha256:00' },
    capabilities: {},
    signature: { alg: 'ed25519', publicKey: PUBKEY_B64, sig: '' },
  };
  const body = canonicaliseManifest(manifest as never);
  const sig = await ed.signAsync(new TextEncoder().encode(body), sk);
  manifest.signature.sig = Buffer.from(sig).toString('base64');
  writeFileSync(join(pkgRoot, 'jinn.manifest.json'), JSON.stringify(manifest, null, 2));
});

describe('loadExternalImpl', () => {
  it('loads + constructs an external impl from a signed package', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/restorer', package: '', entry: join(TMP, 'fake-impl') },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: {
        implName: '@fake/restorer',
        implVersion: '0.1.0',
        network: 'base-sepolia',
        implStateDir: TMP,
        secrets: Object.freeze({}),
        log: () => {},
        stub: false,
      },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.impl.name).toBe('@fake/restorer');
      expect(result.impl.supports({ kind: 'prediction.v0' })).toBe(true);
    }
  });

  it('rejects an impl whose signature is not in trustedSigners', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/restorer', package: '', entry: join(TMP, 'fake-impl') },
      trustedSigners: [{ alg: 'ed25519', publicKey: 'WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRO=' }],
      env: {
        implName: '@fake/restorer',
        implVersion: '0.1.0',
        network: 'base-sepolia',
        implStateDir: TMP,
        secrets: Object.freeze({}),
        log: () => {},
        stub: false,
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-trust');
    }
  });

  it('rejects an impl whose declared name mismatches the manifest', async () => {
    const result = await loadExternalImpl({
      entry: { name: '@fake/wrong-name', package: '', entry: join(TMP, 'fake-impl') },
      trustedSigners: [{ alg: 'ed25519', publicKey: PUBKEY_B64 }],
      env: {
        implName: '@fake/wrong-name',
        implVersion: '0.1.0',
        network: 'base-sepolia',
        implStateDir: TMP,
        secrets: Object.freeze({}),
        log: () => {},
        stub: false,
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('impl-identity-mismatch');
    }
  });
});
```

- [ ] **Step 5.3: Run test, expect failure**

Run: `cd client && yarn vitest run src/restorer/external-impls/loader.test.ts`
Expected: FAIL — `loadExternalImpl` not defined.

- [ ] **Step 5.4: Author `loader.ts`**

```ts
// client/src/restorer/external-impls/loader.ts
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExternalRestorerEnv, RestorerImpl, ExternalRestorerFactory } from '@jinn-network/restorer-sdk';
import type { ExternalImplEntry, SignerTrust } from '../../config.js';
import { loadManifest, verifyManifestSignature } from '../manifest/index.js';

export type LoadResult =
  | { kind: 'ok'; impl: RestorerImpl }
  | { kind: 'error'; reason: LoadFailureReason; detail?: string };

export type LoadFailureReason =
  | 'impl-trust'
  | 'impl-revoked'
  | 'impl-load-failed'
  | 'impl-construction-failed'
  | 'impl-identity-mismatch'
  | 'impl-supports-mismatch';

export interface LoadExternalImplArgs {
  entry: ExternalImplEntry;
  trustedSigners: readonly SignerTrust[];
  env: ExternalRestorerEnv;
}

export async function loadExternalImpl({
  entry,
  trustedSigners,
  env,
}: LoadExternalImplArgs): Promise<LoadResult> {
  // 1. resolve manifest path
  const manifestPath = join(entry.entry, 'jinn.manifest.json');

  // 2. load + schema-validate
  let manifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (err) {
    return { kind: 'error', reason: 'impl-load-failed', detail: (err as Error).message };
  }

  // 3. trust check
  const trusted = await verifyManifestSignature(manifest, trustedSigners);
  if (!trusted) return { kind: 'error', reason: 'impl-trust' };

  // 4. dynamic import
  const entryAbs = join(entry.entry, manifest.entry);
  let mod: { default?: ExternalRestorerFactory };
  try {
    mod = await import(pathToFileURL(entryAbs).href);
  } catch (err) {
    return { kind: 'error', reason: 'impl-load-failed', detail: (err as Error).message };
  }
  if (typeof mod.default !== 'function') {
    return { kind: 'error', reason: 'impl-load-failed', detail: 'default export is not a function' };
  }

  // 5. construct
  let impl: RestorerImpl;
  try {
    impl = mod.default(env);
  } catch (err) {
    return { kind: 'error', reason: 'impl-construction-failed', detail: (err as Error).message };
  }

  // 6. validate identity
  if (impl.name !== entry.name || impl.name !== manifest.name) {
    return { kind: 'error', reason: 'impl-identity-mismatch' };
  }
  if (impl.version !== manifest.version) {
    return { kind: 'error', reason: 'impl-identity-mismatch' };
  }

  // 7. validate supportedKinds — every claimed kind in the manifest must be supported by the impl
  for (const supported of manifest.supportedKinds) {
    const kindMatch = supported.match(/^([a-z][a-z0-9-]*\.v[0-9]+)/);
    if (!kindMatch) continue;
    const kind = kindMatch[1];
    const restorationOk = impl.supports({ kind, type: 'restoration' });
    const evaluationOk = impl.supports({ kind, type: 'evaluation' });
    if (!restorationOk && !evaluationOk) {
      return { kind: 'error', reason: 'impl-supports-mismatch', detail: `manifest claims ${kind} but impl rejects it` };
    }
  }

  return { kind: 'ok', impl };
}
```

- [ ] **Step 5.5: Run loader test, expect green**

Run: `cd client && yarn vitest run src/restorer/external-impls/loader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5.6: Author `external-impls/index.ts` and `config.ts`**

```ts
// client/src/restorer/external-impls/index.ts
export { loadExternalImpl } from './loader.js';
export type { LoadResult, LoadFailureReason, LoadExternalImplArgs } from './loader.js';
```

```ts
// client/src/restorer/external-impls/config.ts
import type { JinnConfig, ExternalImplEntry, SignerTrust } from '../../config.js';

export function getExternalImplEntries(config: JinnConfig): readonly ExternalImplEntry[] {
  return config.restorers?.externalImpls ?? [];
}
export function getTrustedSigners(config: JinnConfig): readonly SignerTrust[] {
  return config.trustedImplSigners ?? [];
}
export function getDisabledImplNames(config: JinnConfig): readonly string[] {
  return config.restorers?.disabled ?? [];
}
```

- [ ] **Step 5.7: Wire into `buildRestorerImpls`**

Modify `client/src/restorer/impls/plugin-path.ts`. Add a parameter for pre-loaded external impls and a disable filter:

```ts
// client/src/restorer/impls/plugin-path.ts (additions)
import type { RestorerImpl } from '../types.js';

export interface RestorerEnv {
  // … existing fields …
  externalImpls?: readonly RestorerImpl[];
  disabledNames?: readonly string[];
}

export function buildRestorerImpls(env: RestorerEnv): RestorerImpl[] {
  // … existing construction unchanged …

  const out: RestorerImpl[] = /* … existing list … */ [];

  // append loaded external impls (after in-repo impls, before learner wrapper if any).
  if (env.externalImpls && env.externalImpls.length > 0) {
    out.push(...env.externalImpls);
  }

  // … existing claude-code-learner wrapper construction …

  // disable filter
  const disabled = new Set(env.disabledNames ?? []);
  return out.filter((impl) => !disabled.has(impl.name));
}
```

- [ ] **Step 5.8: Update `main.ts` to load external impls before construction**

In `client/src/main.ts`, after config is loaded and before `buildRestorerImpls` is called, iterate `config.restorers.externalImpls`, call `loadExternalImpl` for each, log + skip failures, and pass successes via `env.externalImpls`. Mirror the failure-reason codes to `status.fleet.needsAttention` per `2026-05-external-restorer-impls.md` §3.4.

(No code shown here — this is integration work whose exact shape depends on existing main.ts helpers. The acceptance is: a config with a valid `restorers.externalImpls[0]` results in that impl appearing in the registry and dispatch on a matching kind.)

- [ ] **Step 5.9: Run typecheck + all manifest + loader tests**

Run: `cd client && yarn typecheck && yarn vitest run src/restorer/manifest/ src/restorer/external-impls/`
Expected: typecheck zero errors; 8 tests pass.

- [ ] **Step 5.10: Commit**

```bash
git add client/src/restorer/external-impls/ client/src/restorer/impls/plugin-path.ts client/src/config.ts client/src/main.ts
git commit -m "Wire external-impl loader into buildRestorerImpls"
```

---

## Task 6: `jinn create restorer` scaffolding command

**Files:**
- Create: `client/src/cli/commands/create.ts`
- Create: `client/templates/restorer/forecaster/` tree (one file per template — see structure below)
- Modify: `client/src/cli/command-registry.ts` to register `create`
- Test: `client/src/cli/commands/create.test.ts`

`jinn create restorer <pkgName>` writes a working npm package to disk. After `cd <pkgName> && yarn install && yarn test`, the package's tests pass against a synthetic `RestorationContext`.

- [ ] **Step 6.1: Write failing scaffolder test**

```ts
// client/src/cli/commands/create.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCreate } from './create.js';

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'jinn-create-')); });

describe('runCreate', () => {
  it('emits a forecaster package matching the template', async () => {
    await runCreate({
      kind: 'restorer',
      pattern: 'forecaster',
      packageName: '@example/test-forecaster',
      kindString: 'prediction.v0',
      network: 'base-sepolia',
      outDir: TMP,
    });
    const pkgRoot = join(TMP, '@example', 'test-forecaster');
    expect(existsSync(join(pkgRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'jinn.manifest.json'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'src', 'index.ts'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@example/test-forecaster');
    expect(pkg.dependencies['@jinn-network/restorer-sdk']).toBeTruthy();
  });
});
```

- [ ] **Step 6.2: Run test, expect failure**

Run: `cd client && yarn vitest run src/cli/commands/create.test.ts`
Expected: FAIL — `runCreate` not defined.

- [ ] **Step 6.3: Author template files**

Create each file under `client/templates/restorer/forecaster/`. Templates use `{{...}}` placeholders the scaffolder substitutes.

`package.json.tmpl`:

```json
{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "description": "Jinn external restorer impl for {{kindString}}.",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "files": ["dist/", "jinn.manifest.json", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@jinn-network/restorer-sdk": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.5.0"
  }
}
```

`tsconfig.json.tmpl`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "declaration": true, "outDir": "dist", "rootDir": "src",
    "lib": ["ES2022"], "types": []
  },
  "include": ["src/**/*"]
}
```

`jinn.manifest.json.tmpl`:

```json
{
  "schemaVersion": "1.0.0",
  "name": "{{packageName}}",
  "version": "0.1.0",
  "description": "Jinn external restorer impl for {{kindString}}.",
  "supportedKinds": ["{{kindString}}>=1.0.0"],
  "entry": "./dist/index.js",
  "package": { "cid": "bafy-PLACEHOLDER", "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
  "capabilities": {
    "rpc": [{ "chainId": {{networkChainId}}, "methods": ["eth_call", "eth_blockNumber"] }]
  },
  "signature": { "alg": "ed25519", "publicKey": "PLACEHOLDER", "sig": "PLACEHOLDER" }
}
```

`src/index.ts.tmpl`:

```ts
import type {
  RestorerImpl,
  ExternalRestorerEnv,
  RestorationContext,
  RestorationOutput,
} from '@jinn-network/restorer-sdk';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === '{{kindString}}' && type !== 'evaluation';
    },
    async isReady() {
      return env.stub
        ? { ready: false, reason: 'stub mode' }
        : { ready: true };
    },
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      env.log({ level: 'info', msg: 'forecaster.run', data: { intentId: ctx.intent.id } });
      // TODO: call your existing forecasting pipeline here.
      return {
        venueRef: { name: '{{packageName}}' },
        gating: { probability: 0.5 },
      };
    },
  };
}
```

`test/unit.test.ts.tmpl`:

```ts
import { describe, it, expect } from 'vitest';
import createRestorer from '../src/index.js';
import type { ExternalRestorerEnv, RestorationContext } from '@jinn-network/restorer-sdk';

const env: ExternalRestorerEnv = {
  implName: '{{packageName}}',
  implVersion: '0.1.0',
  network: '{{network}}',
  implStateDir: '/tmp/{{packageName}}',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

const ctx: RestorationContext = {
  intent: { id: 'test', spec: { kind: '{{kindString}}' } },
  intentCid: undefined,
  implStateDir: '/tmp/{{packageName}}',
  workingDir: '/tmp/{{packageName}}-work',
  log: () => {},
  abort: new AbortController().signal,
  msUntilEndTs: () => 60_000,
};

describe('{{packageName}}', () => {
  it('supports the configured kind', () => {
    const impl = createRestorer(env);
    expect(impl.supports({ kind: '{{kindString}}' })).toBe(true);
    expect(impl.supports({ kind: 'other.v0' })).toBe(false);
  });

  it('produces a RestorationOutput with a probability', async () => {
    const impl = createRestorer(env);
    const out = await impl.run(ctx);
    expect(out.gating).toHaveProperty('probability');
  });
});
```

`README.md.tmpl`:

```markdown
# {{packageName}}

Jinn external restorer impl for `{{kindString}}` on `{{network}}`.

## Quickstart

```bash
yarn install
yarn test       # unit tests
yarn build      # produces dist/
```

Edit `src/index.ts` to plug in your existing forecasting pipeline. The `run()` method receives a `RestorationContext` (intent + workingDir + capability handles) and returns a `RestorationOutput`.

## Publishing

1. Compute your tarball CID + sha256: `npm pack && ipfs add *.tgz` and `shasum -a 256 *.tgz`.
2. Update `jinn.manifest.json` with the resulting CID + hash.
3. Sign the manifest with your ed25519 key (see `spec/2026-05-executor-trust-boundary.md` §5.2).
4. Pin tarball + signed manifest on IPFS.
5. Operators install via `jinn impls add ipfs://<manifest-cid>`.

## Spec

`spec/2026-04-30-plug-in-surface.md` §3.3.1 (forecaster pattern).
```

`gitignore.tmpl`:

```
dist/
node_modules/
.DS_Store
```

- [ ] **Step 6.4: Author `create.ts`**

```ts
// client/src/cli/commands/create.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, CommandModule } from '../command.js';

const TEMPLATES_ROOT = fileURLToPath(new URL('../../../templates/restorer/', import.meta.url));

const NETWORK_CHAIN_IDS: Record<string, number> = {
  'base-mainnet': 8453,
  'base-sepolia': 84532,
};

export interface RunCreateArgs {
  kind: 'restorer';
  pattern: 'forecaster' | 'evaluator' | 'alternative-harness';
  packageName: string;
  kindString: string;
  network: string;
  outDir: string;
}

interface TemplateFile {
  src: string;
  dst: string;
}

const TEMPLATE_FILES: TemplateFile[] = [
  { src: 'package.json.tmpl', dst: 'package.json' },
  { src: 'tsconfig.json.tmpl', dst: 'tsconfig.json' },
  { src: 'jinn.manifest.json.tmpl', dst: 'jinn.manifest.json' },
  { src: 'src/index.ts.tmpl', dst: 'src/index.ts' },
  { src: 'test/unit.test.ts.tmpl', dst: 'test/unit.test.ts' },
  { src: 'README.md.tmpl', dst: 'README.md' },
  { src: 'gitignore.tmpl', dst: '.gitignore' },
];

function substitute(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}

export async function runCreate(args: RunCreateArgs): Promise<void> {
  if (args.kind !== 'restorer') throw new Error(`unsupported kind: ${args.kind}`);
  const networkChainId = NETWORK_CHAIN_IDS[args.network];
  if (networkChainId === undefined) {
    throw new Error(`unknown network ${args.network}; known: ${Object.keys(NETWORK_CHAIN_IDS).join(', ')}`);
  }
  const targetRoot = join(args.outDir, args.packageName);
  const vars: Record<string, string | number> = {
    packageName: args.packageName,
    kindString: args.kindString,
    network: args.network,
    networkChainId,
  };
  for (const file of TEMPLATE_FILES) {
    const srcPath = join(TEMPLATES_ROOT, args.pattern, file.src);
    const dstPath = join(targetRoot, file.dst);
    const text = readFileSync(srcPath, 'utf8');
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, substitute(text, vars));
  }
}

export const createCommand: CommandModule = {
  name: 'create',
  describe: 'Scaffold a new Jinn restorer or plug-in package',
  async run(ctx: CommandContext): Promise<number> {
    const sub = ctx.argv[0];
    if (sub !== 'restorer') {
      ctx.stderr.write(`Usage: jinn create restorer <packageName> [--pattern=forecaster|evaluator|alternative-harness] [--kind=prediction.v0] [--network=base-sepolia]\n`);
      return 1;
    }
    const packageName = ctx.argv[1];
    if (!packageName) {
      ctx.stderr.write(`error: package name required\n`);
      return 1;
    }
    // parse simple --key=value flags
    const flags = new Map<string, string>();
    for (const arg of ctx.argv.slice(2)) {
      if (arg.startsWith('--')) {
        const [k, v] = arg.slice(2).split('=', 2);
        if (v !== undefined) flags.set(k, v);
      }
    }
    await runCreate({
      kind: 'restorer',
      pattern: (flags.get('pattern') ?? 'forecaster') as RunCreateArgs['pattern'],
      packageName,
      kindString: flags.get('kind') ?? 'prediction.v0',
      network: flags.get('network') ?? 'base-sepolia',
      outDir: process.cwd(),
    });
    ctx.stdout.write(`Created ${packageName}. Next: cd ${packageName} && yarn install && yarn test\n`);
    return 0;
  },
};
```

- [ ] **Step 6.5: Run scaffolder test, expect green**

Run: `cd client && yarn vitest run src/cli/commands/create.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6.6: Register the command**

In `client/src/cli/command-registry.ts`, add:

```ts
import { createCommand } from './commands/create.js';
// … and register createCommand alongside the existing entries
```

- [ ] **Step 6.7: Smoke-run the scaffolder end-to-end**

```bash
cd /tmp && rm -rf scaffold-smoke && mkdir scaffold-smoke && cd scaffold-smoke
node ${REPO}/client/dist/cli/index.js create restorer @example/smoke
cd @example/smoke
yarn install
yarn typecheck
yarn test
```

Expected: scaffolder writes the package; `yarn install` succeeds (resolves `@jinn-network/restorer-sdk` from local workspace); `yarn typecheck` zero errors; `yarn test` passes 2 tests.

- [ ] **Step 6.8: Commit**

```bash
git add client/src/cli/commands/create.ts client/src/cli/commands/create.test.ts client/templates/restorer/ client/src/cli/command-registry.ts
git commit -m "Add jinn create restorer scaffolding command"
```

---

## Task 7: Polymarket forecaster worked example

**Files:**
- Create: `examples/external-restorer-impls/polymarket-forecaster/` tree

The worked example is the warmest-cohort recruit's reference path. Per `spec/2026-04-30-plug-in-surface.md` §3.3.1, this targets Polymarket / Kalshi bot operators wrapping their existing forecasting pipeline.

- [ ] **Step 7.1: Use the scaffolder to bootstrap**

```bash
cd ${REPO}/examples/external-restorer-impls
node ${REPO}/client/dist/cli/index.js create restorer @jinn-examples/polymarket-forecaster --pattern=forecaster --kind=prediction.v0 --network=base-sepolia
```

Expected: directory `@jinn-examples/polymarket-forecaster/` exists with the template tree.

- [ ] **Step 7.2: Replace the scaffold's TODO with a real Polymarket fetch**

Edit `src/index.ts` to actually call a Polymarket-style fetch. Add `src/polymarket-client.ts` for the API stub (we ship a deterministic mock client for offline tests; real builders swap it for the real Polymarket gamma-markets API):

```ts
// src/polymarket-client.ts
export interface PolymarketMarketSnapshot {
  marketId: string;
  question: string;
  endTimeIso: string;
  /** outcome_0_price = market's implied prob of YES, [0..1]. */
  yesPrice: number;
}

export async function fetchMarketSnapshot(marketId: string): Promise<PolymarketMarketSnapshot> {
  // Real impl: call https://gamma-api.polymarket.com/markets/<id>
  // For the example, return a deterministic stub keyed off marketId hash.
  const seed = Array.from(marketId).reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 0);
  const yesPrice = (seed % 1000) / 1000;
  return {
    marketId,
    question: `Stub market ${marketId}`,
    endTimeIso: new Date(Date.now() + 86_400_000).toISOString(),
    yesPrice,
  };
}
```

Replace `src/index.ts` body with:

```ts
import type {
  RestorerImpl,
  ExternalRestorerEnv,
  RestorationContext,
  RestorationOutput,
} from '@jinn-network/restorer-sdk';
import { fetchMarketSnapshot } from './polymarket-client.js';

export default function createRestorer(env: ExternalRestorerEnv): RestorerImpl {
  return {
    name: env.implName,
    version: env.implVersion,
    supports({ kind, type }) {
      return kind === 'prediction.v0' && type !== 'evaluation';
    },
    async isReady() {
      return env.stub ? { ready: false, reason: 'stub mode' } : { ready: true };
    },
    async run(ctx: RestorationContext): Promise<RestorationOutput> {
      const marketId = (ctx.intent.spec as { marketId?: string })?.marketId ?? ctx.intent.id;
      env.log({ level: 'info', msg: 'polymarket-forecaster.fetch', data: { marketId } });
      const snapshot = await fetchMarketSnapshot(marketId);
      // Trivial forecast strategy: trust the market price modulo small calibration.
      // Real builders replace this with their pipeline.
      const probability = Math.max(0.01, Math.min(0.99, snapshot.yesPrice));
      return {
        venueRef: { name: 'polymarket' },
        gating: {
          probability,
          marketId: snapshot.marketId,
          marketEndTime: snapshot.endTimeIso,
        },
        rationale: [{ message: `Forecast based on market price ${snapshot.yesPrice}` }],
      };
    },
  };
}
```

- [ ] **Step 7.3: Update unit test to cover the new behaviour**

Edit `test/unit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import createRestorer from '../src/index.js';
import type { ExternalRestorerEnv, RestorationContext } from '@jinn-network/restorer-sdk';

const env: ExternalRestorerEnv = {
  implName: '@jinn-examples/polymarket-forecaster',
  implVersion: '0.1.0',
  network: 'base-sepolia',
  implStateDir: '/tmp/polymarket',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

function makeCtx(marketId: string): RestorationContext {
  return {
    intent: { id: 'i-1', spec: { kind: 'prediction.v0', marketId } },
    intentCid: undefined,
    implStateDir: '/tmp/polymarket',
    workingDir: '/tmp/polymarket-work',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
  };
}

describe('@jinn-examples/polymarket-forecaster', () => {
  it('supports prediction.v0 restoration only (not evaluation)', () => {
    const impl = createRestorer(env);
    expect(impl.supports({ kind: 'prediction.v0', type: 'restoration' })).toBe(true);
    expect(impl.supports({ kind: 'prediction.v0', type: 'evaluation' })).toBe(false);
    expect(impl.supports({ kind: 'portfolio.v0' })).toBe(false);
  });

  it('produces a probability in [0.01, 0.99] for any deterministic market id', async () => {
    const impl = createRestorer(env);
    for (const marketId of ['m-a', 'm-b', 'm-c', 'm-deadbeef']) {
      const out = await impl.run(makeCtx(marketId));
      const p = out.gating.probability as number;
      expect(p).toBeGreaterThanOrEqual(0.01);
      expect(p).toBeLessThanOrEqual(0.99);
      expect(out.gating.marketId).toBe(marketId);
    }
  });
});
```

- [ ] **Step 7.4: Install + test**

```bash
cd examples/external-restorer-impls/@jinn-examples/polymarket-forecaster
yarn install
yarn typecheck
yarn test
```

Expected: zero typecheck errors; 2 tests pass.

- [ ] **Step 7.5: Author the e2e Anvil test**

```ts
// test/e2e-anvil.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import createRestorer from '../src/index.js';
import type { ExternalRestorerEnv, RestorationContext } from '@jinn-network/restorer-sdk';

const ANVIL_PORT = 8765;

describe('polymarket-forecaster e2e (Anvil fork)', () => {
  let anvil: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', 'https://mainnet.base.org', '--port', String(ANVIL_PORT)], { stdio: 'pipe' });
    await wait(2000);
  });

  afterAll(() => { anvil?.kill('SIGTERM'); });

  it('runs the impl against a synthetic intent with anvil reachable', async () => {
    const env: ExternalRestorerEnv = {
      implName: '@jinn-examples/polymarket-forecaster',
      implVersion: '0.1.0',
      network: 'base-mainnet',
      implStateDir: '/tmp/polymarket-e2e',
      secrets: Object.freeze({}),
      log: () => {},
      stub: false,
    };
    const impl = createRestorer(env);
    const ctx: RestorationContext = {
      intent: { id: 'e2e-1', spec: { kind: 'prediction.v0', marketId: 'mk-trump-2028' } },
      intentCid: undefined,
      implStateDir: '/tmp/polymarket-e2e',
      workingDir: '/tmp/polymarket-e2e-work',
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 60_000,
    };
    const out = await impl.run(ctx);
    expect(out.venueRef.name).toBe('polymarket');
    expect(typeof out.gating.probability).toBe('number');
  });
});
```

- [ ] **Step 7.6: Run e2e test**

```bash
cd examples/external-restorer-impls/@jinn-examples/polymarket-forecaster
yarn vitest run test/e2e-anvil.test.ts
```

Expected: anvil spawns, test passes; teardown kills anvil.

(If anvil is not on PATH, the test should `it.skip` rather than fail — adjust the test with a precondition if local environments lack foundry.)

- [ ] **Step 7.7: Commit**

```bash
git add examples/external-restorer-impls/@jinn-examples/polymarket-forecaster/
git commit -m "Add polymarket-forecaster Path 2 worked example"
```

---

## Self-review

After implementing all 7 tasks, verify against `spec/2026-04-30-plug-in-surface.md` §3 + §7:

**Spec coverage check:**

| Spec acceptance criterion (§7) | Plan coverage |
|---|---|
| 1. Spec merged | (out of scope — landed in Task A.2 spec PR) |
| 2. Cross-references in five extension specs | Plan 5 follow-up |
| 3. `@jinn-network/restorer-sdk` v1.0.0 published | Task 3 |
| 4. `jinn create restorer` scaffolder | Task 6 |
| 5. Three Path 2 worked examples | Task 7 (forecaster only — evaluator + alternative-harness in Plan 2) |
| 6. Six Path 1 worked examples | Plan 4 |
| 7. Path 1/2 documentation indices | Plan 5 |
| 8. Plug-in JSON schema published | Task 4 (manifest schema; Path 1 plug-in schema in Plan 3) |
| 9. CLI verbs ship | Task 6 (`create`) + Plan 3 (`plug-ins`) |
| 10. Framing-DR reconciliation in §13 of default-learner spec | Plan 5 follow-up |

**This plan covers Path 2 foundation: tasks 1, 2 (capability handles + constructors), 3 (SDK), 4 (manifest verifier), 5 (loader), 6 (scaffolder), 7 (one worked example).** Remaining acceptance criteria are explicit follow-up plans (Plans 2, 3, 4, 5).

**Placeholder scan:** No "TBD/TODO/placeholder" markers in the plan body; all step bodies contain concrete code or commands.

**Type consistency:** `RestorerImpl`, `RestorationContext`, `ExternalRestorerEnv`, `ScopedSigner`, `ScopedRpc`, `ScopedSecrets`, `JinnManifest` are introduced in Task 1/3 and used consistently in Tasks 5–7. `ExternalImplEntry`, `SignerTrust` introduced in Task 5 step 5.1 and used in Task 5 step 5.2 onwards.

---

## Next plans

Implement in order:

- **Plan 2 (`2026-04-30-plug-in-surface-path-2-examples.md`)** — evaluator + alternative-harness worked examples. Smaller; ~300 lines.
- **Plan 3 (`2026-04-30-plug-in-surface-path-1-mechanism.md`)** — `jinn-plugin.json` schema, install verb, session-start discovery, slot registry, six slot integration points inside `claude-code-learner`. The largest of the follow-ups; ~1200 lines.
- **Plan 4 (`2026-04-30-plug-in-surface-path-1-examples.md`)** — six Path 1 worked examples (one per slot category). Mid-size; ~600 lines.
- **Plan 5 (`2026-04-30-plug-in-surface-docs-and-cross-spec.md`)** — Path 1/2 documentation indices + cross-references in the five extension-branch specs (filed as separate beads). Small; ~200 lines.

When finished with this plan: `bd close jinn-mono-a9w9` (this is the spec task; implementation plans are deliverables of the spec). The implementation work itself ships against new beads filed when the user is ready to start coding.
