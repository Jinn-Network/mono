# Expose last keystore-password rotation on /v1/status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `status.security.lastPasswordRotationAt` (ISO timestamp or `null`) on the daemon's `GET /v1/status` so the operator-app `password_rotation_due` notification can fire after 90 days.

**Architecture:** Thread a `passwordRotation` descriptor (`{ source, filePath? }`) from `main.ts`'s existing `resolveOrGenerateKeystorePassword()` result into both `StatusGatherConfig` sites. `gatherGatheredStatusRaw` reads the keystore-password file's mtime **at request time** (`statSync(filePath).mtime.toISOString()`), fully `try/catch`-guarded, and stashes the resolved ISO-or-null onto `GatheredStatusRaw`. The pure `assembleStatusV1(raw)` projects that into an always-present `security: { lastPasswordRotationAt }`. The SPA's `useNotifications` adapter reads `status.security?.lastPasswordRotationAt` and passes it to the already-shipped deriver.

**Tech Stack:** TypeScript, Node `node:fs` `statSync`, Vitest. Daemon side: `client/src/api/*`, `client/src/main.ts`. SPA side: `client/src/dashboard/spa/src/notifications/*`.

**Design source:** Stage-1 approved note (file-mtime, Option A). Degrade to `null` for env-source (`JINN_PASSWORD`, no file) and for a missing/unreadable file. Never throw, never 500.

**Why the read lives in `gatherGatheredStatusRaw`, not the pure `assembleStatusV1`:** `status-build.ts`'s header contract is "pure assembly… testable without RPC or filesystem", and `assembleStatusV1(raw)` is a pure function of `raw`. The gather layer already performs request-time FS reads (`readDaemonRuntime`, `gatherPortfolioV0Status`). Doing the `statSync` there — and threading only the resolved value onto `raw` — keeps the assembler pure while still satisfying the design's "read-at-request-time" requirement. The descriptor (`source` + `filePath`) is what gets threaded through `StatusGatherConfig`; the file read happens once per request inside gather.

---

## Acceptance criteria → task map

- **AC1** — `/v1/status` response carries a top-level `security` object with `lastPasswordRotationAt: string | null`, always present. → Task 1 (type), Task 4 (assembler).
- **AC2** — When the password came from the on-disk keystore-password file, the value is that file's mtime as an ISO string. → Task 3 (gather read), Task 5 (gather test, file case).
- **AC3** — When the password came from `JINN_PASSWORD` (env, no file) the value is `null`. → Task 3, Task 5 (env case).
- **AC4** — A missing or unreadable file yields `null` and never throws / never 500s. → Task 3 (try/catch), Task 5 (missing-file case).
- **AC5** — `main.ts` populates the descriptor at both `StatusGatherConfig` sites from the existing `passwordResolution`. → Task 6.
- **AC6** — The SPA `useNotifications` adapter feeds `status.security.lastPasswordRotationAt` into the deriver, replacing the hardcoded `undefined`, so `password_rotation_due` fires for a >90-day file. → Task 7 (adapter), Task 8 (adapter test).

---

## File structure

- `client/src/api/status-build.ts` — add `PasswordRotationConfig` type, add `passwordRotation?` to `GatheredStatusRaw`, add `security` to `StatusV1Response`, project it in `assembleStatusV1`.
- `client/src/api/gather-status.ts` — add `passwordRotation?` to `StatusGatherConfig`, read mtime at request time, set `raw.passwordRotation`.
- `client/src/main.ts` — populate `passwordRotation` in both `status:` config blocks from `passwordResolution`.
- `client/src/dashboard/spa/src/notifications/useNotifications.ts` — read `status.security?.lastPasswordRotationAt` in `mapStatusToDeriveInput`.
- `client/test/api/gather-status.test.ts` — new tests for file / env / missing-file cases.
- `client/src/dashboard/spa/src/notifications/derive.test.ts` (or a `useNotifications` test) — adapter mapping test.

**No SPA-side status type addition needed:** `api.getStatus()` returns `unknown` and `mapStatusToDeriveInput` casts to `Record<string, any>` (`s.security?.lastPasswordRotationAt`), so the adapter line typechecks without a new interface. The deriver's `DeriveInput.status.passwordRotatedAt?: string` and the `password_rotation_due` branch already exist (`derive.ts:19,105-116`) — no `derive.ts` change.

---

### Task 1: Add the wire type — `security` on `StatusV1Response`

**Files:**
- Modify: `client/src/api/status-build.ts` (interface `StatusV1Response`, lines 233-331; add field near the end of the interface, after `harness`)

- [ ] **Step 1: Write the failing test (assembler default → null)**

Add to `client/test/api/gather-status.test.ts` inside the top-level `describe('gatherStatusForApi', …)` block (the file already imports `withTempStore` and `gatherStatusForApi` per-test via dynamic `import`):

```ts
  it('always emits security.lastPasswordRotationAt (null when no rotation config)', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, undefined);
      expect(status.security).toEqual({ lastPasswordRotationAt: null });
    });
  });
```

- [ ] **Step 2: Run it — verify it fails on the type/shape**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts -t 'always emits security'`
Expected: FAIL — `status.security` is `undefined` (property does not exist) and/or a TS error that `security` is not on `StatusV1Response`.

- [ ] **Step 3: Add the `security` field to the interface**

In `client/src/api/status-build.ts`, inside `interface StatusV1Response` (after the `harness: HarnessRollup;` field at ~line 330, before the closing `}`), add:

```ts
  /**
   * Security posture sub-object — always present. `lastPasswordRotationAt`
   * is the ISO mtime of the on-disk keystore-password file (the proxy for
   * "when the password was last set/rotated"), or `null` when the password
   * is env-sourced (`JINN_PASSWORD`, no file) or the file is missing /
   * unreadable. Consumed by the operator-app `password_rotation_due`
   * notification (issue #441).
   */
  security: { lastPasswordRotationAt: string | null };
```

- [ ] **Step 4: Project it in `assembleStatusV1` (minimal — null for now)**

In `client/src/api/status-build.ts`, in the object returned by `assembleStatusV1` (the `return { … }` at ~line 588), add a `security` property next to `harness`:

```ts
    security: { lastPasswordRotationAt: raw.passwordRotationAt ?? null },
```

(`raw.passwordRotationAt` is added in Task 2; for now TS will flag it — that is expected and resolved in Task 2. If executing tasks strictly one-at-a-time and you need this step green in isolation, temporarily use `lastPasswordRotationAt: null` and switch to `raw.passwordRotationAt ?? null` in Task 2. Prefer doing Task 1 + Task 2 in one commit.)

- [ ] **Step 5: Run the test**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts -t 'always emits security'`
Expected: PASS (`security` equals `{ lastPasswordRotationAt: null }`).

- [ ] **Step 6: Commit (combine with Task 2 — see Task 2 Step 5)**

---

### Task 2: Add the resolved field to `GatheredStatusRaw`

**Files:**
- Modify: `client/src/api/status-build.ts` (interface `GatheredStatusRaw`, lines 124-231)

- [ ] **Step 1: Add the field to the raw interface**

In `client/src/api/status-build.ts`, inside `interface GatheredStatusRaw` (anywhere among the optional fields, e.g. after `daemonRuntime`), add:

```ts
  /**
   * Resolved ISO mtime of the keystore-password file, or `null` when the
   * password is env-sourced or the file is missing/unreadable. Computed at
   * request time in `gatherGatheredStatusRaw` from the threaded
   * `passwordRotation` descriptor; projected into `security.lastPasswordRotationAt`
   * by `assembleStatusV1`. Absent on `raw` ⇒ assembler emits `null` (issue #441).
   */
  passwordRotationAt?: string | null;
```

- [ ] **Step 2: Confirm `assembleStatusV1` reads it**

Ensure the `assembleStatusV1` return (Task 1 Step 4) uses:

```ts
    security: { lastPasswordRotationAt: raw.passwordRotationAt ?? null },
```

- [ ] **Step 3: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors (the `raw.passwordRotationAt` reference now resolves).

- [ ] **Step 4: Run the Task-1 test**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts -t 'always emits security'`
Expected: PASS.

- [ ] **Step 5: Commit Tasks 1 + 2 together**

```bash
git add client/src/api/status-build.ts client/test/api/gather-status.test.ts
git commit -m "feat(#441): add security.lastPasswordRotationAt to /v1/status response shape

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Read file mtime at request time in `gather-status`

**Files:**
- Modify: `client/src/api/gather-status.ts` (`StatusGatherConfig` interface ~lines 222-277; `gatherGatheredStatusRaw` ~lines 1011-1264; `statSync` import at the top fs import ~line 6)

- [ ] **Step 1: Add the descriptor type + config field**

In `client/src/api/gather-status.ts`, add an exported type and a config field. Add the type just above `export interface StatusGatherConfig`:

```ts
/**
 * Keystore-password provenance descriptor threaded from `main.ts`'s
 * `resolveOrGenerateKeystorePassword()` (issue #441). `gatherGatheredStatusRaw`
 * uses it to resolve `security.lastPasswordRotationAt`:
 *   - `source: 'file' | 'generated'` with a `filePath` → statSync(filePath).mtime ISO
 *   - `source: 'env'` (or no `filePath`) → null
 */
export interface PasswordRotationConfig {
  source: 'env' | 'file' | 'generated';
  filePath?: string;
}
```

Then inside `interface StatusGatherConfig`, add (near the other optional fields):

```ts
  /**
   * Keystore-password provenance — threaded from `main.ts`. Drives
   * `security.lastPasswordRotationAt` on `/v1/status`. Optional: test callers
   * and sqlite-only contexts omit it ⇒ `null` (issue #441).
   */
  passwordRotation?: PasswordRotationConfig;
```

- [ ] **Step 2: Add the `statSync` import**

In `client/src/api/gather-status.ts`, extend the existing `node:fs` import (line 6) from:

```ts
import { existsSync, readFileSync } from 'node:fs';
```

to:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
```

- [ ] **Step 3: Add the request-time resolver helper**

In `client/src/api/gather-status.ts`, add a small helper near `readDaemonRuntime` (~line 187):

```ts
/**
 * Resolve `security.lastPasswordRotationAt` from the password provenance
 * descriptor. File mtime is read at request time. Never throws: a missing,
 * unreadable, or env-sourced password yields `null` (issue #441).
 */
function resolvePasswordRotationAt(
  cfg: PasswordRotationConfig | undefined,
): string | null {
  if (!cfg || cfg.source === 'env' || !cfg.filePath) return null;
  try {
    return statSync(cfg.filePath).mtime.toISOString();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Populate `raw.passwordRotationAt` in `gatherGatheredStatusRaw`**

In `client/src/api/gather-status.ts`, in `gatherGatheredStatusRaw`, set the field on `baseRaw` (so it flows to both the `!status` early-return and the full path). In the `baseRaw` object literal (~lines 1097-1122), add:

```ts
    passwordRotationAt: resolvePasswordRotationAt(status?.passwordRotation),
```

Because `raw` is built via `{ ...baseRaw, … }`, the full path inherits it automatically — no second write needed.

- [ ] **Step 5: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Run the existing status suite (regression)**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts`
Expected: PASS (existing assertions unaffected; new Task-1 test still green with `null`).

- [ ] **Step 7: Commit**

```bash
git add client/src/api/gather-status.ts
git commit -m "feat(#441): resolve keystore-password mtime at request time in gather-status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gather-status tests — file / env / missing-file (TDD core)

**Files:**
- Modify: `client/test/api/gather-status.test.ts`

**TDD note:** This is the central behavioral spec. The file-case test (asserting the ISO equals the mocked file mtime) is written first; it fails until Task 3 is in place. Since Task 3 already landed, write all three here as a guard set and confirm they pass. Use a real temp file + `utimesSync` to control mtime deterministically (no `vi.mock` of `node:fs` needed — `statSync` reads a real file we own). `mockStatusRpc()` is already defined in this file (see its use at line 216) — reuse it so no live RPC is attempted.

- [ ] **Step 1: Write the file-source test**

Add inside the `describe('gatherStatusForApi', …)` block:

```ts
  it('security.lastPasswordRotationAt is the keystore-password file mtime (file source)', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const { writeFileSync, utimesSync } = await import('node:fs');
    await withTempStore(async (store) => {
      const dir = mkdtempSync(join(tmpdir(), 'jinn-pw-'));
      const pwPath = join(dir, 'keystore-password');
      writeFileSync(pwPath, 'deadbeef\n', { mode: 0o600 });
      // Pin mtime to a known instant (2024-01-02T03:04:05Z).
      const when = new Date('2024-01-02T03:04:05.000Z');
      utimesSync(pwPath, when, when);

      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-earn-')),
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        passwordRotation: { source: 'file', filePath: pwPath },
      });

      expect(status.security.lastPasswordRotationAt).toBe('2024-01-02T03:04:05.000Z');
    });
  });
```

- [ ] **Step 2: Write the env-source test (→ null)**

```ts
  it('security.lastPasswordRotationAt is null when the password is env-sourced', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-earn-')),
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        passwordRotation: { source: 'env' },
      });
      expect(status.security.lastPasswordRotationAt).toBeNull();
    });
  });
```

- [ ] **Step 3: Write the missing-file test (→ null, no throw)**

```ts
  it('security.lastPasswordRotationAt is null when the keystore-password file is missing', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-earn-')),
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        passwordRotation: {
          source: 'file',
          filePath: join(tmpdir(), 'definitely-absent-jinn-keystore-password'),
        },
      });
      expect(status.security.lastPasswordRotationAt).toBeNull();
    });
  });
```

- [ ] **Step 4: Run all three + the Task-1 default test**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts -t 'lastPasswordRotationAt'`
Expected: PASS (3 tests). Also run `-t 'always emits security'` → PASS.

If `mockStatusRpc` is not in scope at the location you inserted (it is a `const`/`function` defined within the describe — confirm via the existing call at line 216), insert these tests *after* that definition. The whole-file run in Step 5 catches ordering issues.

- [ ] **Step 5: Run the full gather-status file**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts`
Expected: PASS (all, including the 3 new + pre-existing).

- [ ] **Step 6: Commit**

```bash
git add client/test/api/gather-status.test.ts
git commit -m "test(#441): cover security.lastPasswordRotationAt file/env/missing cases

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Thread `passwordRotation` from `main.ts` (both sites)

**Files:**
- Modify: `client/src/main.ts` — `status:` block for `setupApiServer` (~lines 1348-1368) and `status:` block for `Daemon` (~lines 2548-2575). Source: `passwordResolution` (`main.ts:181`).

**Note:** `passwordResolution` (`{ password, source, filePath? }`) is already in module scope at line 181. Both `status:` blocks need the same one-line addition. The `/v1/status` route is served by the API server (`server.ts:442`) reading `liveStatus`, which is initially `config.status` (the `setupApiServer` block) and is swapped to the Daemon's block via `setStatusConfig` at runtime — so **both** sites must carry the field for the value to be present before and after the swap.

- [ ] **Step 1: Add to the `setupApiServer` status block**

In `client/src/main.ts`, inside the `status: { … }` object at ~line 1348, add (e.g. after `configPath:`):

```ts
        passwordRotation: {
          source: passwordResolution.source,
          filePath: passwordResolution.filePath,
        },
```

- [ ] **Step 2: Add to the `Daemon` status block**

In `client/src/main.ts`, inside the `status: { … }` object at ~line 2548, add (e.g. after `configPath:`):

```ts
      passwordRotation: {
        source: passwordResolution.source,
        filePath: passwordResolution.filePath,
      },
```

- [ ] **Step 3: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors (`PasswordRotationConfig.filePath` is optional; `passwordResolution.filePath` is `string | undefined` — matches).

- [ ] **Step 4: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(#441): thread keystore-password provenance into both status configs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: SPA adapter — feed `security.lastPasswordRotationAt` to the deriver

**Files:**
- Modify: `client/src/dashboard/spa/src/notifications/useNotifications.ts` (lines 113-115 + the comment block at 44-48)

- [ ] **Step 1: Replace the hardcoded `undefined`**

In `client/src/dashboard/spa/src/notifications/useNotifications.ts`, replace lines 113-115:

```ts
    // No /v1/status field for last password rotation today; follow-up Issue
    // tracks adding it. Until then, password_rotation_due never fires.
    passwordRotatedAt: undefined,
```

with:

```ts
    // `security.lastPasswordRotationAt` is the ISO mtime of the keystore-password
    // file (issue #441); null/absent ⇒ password_rotation_due stays silent.
    passwordRotatedAt:
      typeof s.security?.lastPasswordRotationAt === 'string'
        ? s.security.lastPasswordRotationAt
        : undefined,
```

- [ ] **Step 2: Update the stale doc comment**

In the same file, the `mapStatusToDeriveInput` jsdoc bullet (~lines 46-47) currently reads:

```ts
 * - `password_rotation_due` has no `/v1/status` field today; the default below
 *   keeps it silent until the daemon surfaces the input.
```

Replace with:

```ts
 * - `password_rotation_due` reads `s.security.lastPasswordRotationAt` (#441) —
 *   the keystore-password file's ISO mtime, or null when env-sourced/missing.
```

- [ ] **Step 3: Typecheck the SPA**

Run: `cd client && yarn vitest run src/dashboard/spa/src/notifications/derive.test.ts` (sanity that imports still compile) — or the SPA typecheck command if separate. The `s` object is `Record<string, any>`, so `s.security?.lastPasswordRotationAt` typechecks without a new interface.
Expected: existing tests PASS, no TS error.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/useNotifications.ts
git commit -m "feat(#441): wire security.lastPasswordRotationAt into password_rotation_due

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: SPA adapter test — mapping fires `password_rotation_due`

**Files:**
- Create or modify: `client/src/dashboard/spa/src/notifications/useNotifications.test.ts` (new) OR extend `derive.test.ts`. Prefer a focused test on `mapStatusToDeriveInput` if it is exported; if it is **not** exported (it is currently a module-local `function`), export it for testability OR assert via the deriver with a hand-built input.

**Decision:** `mapStatusToDeriveInput` is module-private. The cheapest, behavior-true test is to (a) `export` `mapStatusToDeriveInput` from `useNotifications.ts`, and (b) assert it maps a `security.lastPasswordRotationAt` of 91 days ago into a `passwordRotatedAt` that the existing deriver turns into a `password_rotation_due` notification. The deriver branch is already covered by `derive.test.ts:137-149`; this test guards the *adapter mapping* specifically.

- [ ] **Step 1: Export the adapter**

In `client/src/dashboard/spa/src/notifications/useNotifications.ts`, change:

```ts
function mapStatusToDeriveInput(
```

to:

```ts
export function mapStatusToDeriveInput(
```

- [ ] **Step 2: Write the failing test**

Create `client/src/dashboard/spa/src/notifications/useNotifications.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapStatusToDeriveInput } from './useNotifications.js';

describe('mapStatusToDeriveInput — password rotation (#441)', () => {
  it('maps security.lastPasswordRotationAt into passwordRotatedAt', () => {
    const iso = '2024-01-02T03:04:05.000Z';
    const mapped = mapStatusToDeriveInput(
      { security: { lastPasswordRotationAt: iso } },
      {},
      false,
    );
    expect(mapped.passwordRotatedAt).toBe(iso);
  });

  it('maps a null/absent rotation to undefined (notification stays silent)', () => {
    expect(
      mapStatusToDeriveInput({ security: { lastPasswordRotationAt: null } }, {}, false)
        .passwordRotatedAt,
    ).toBeUndefined();
    expect(
      mapStatusToDeriveInput({}, {}, false).passwordRotatedAt,
    ).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd client && yarn vitest run src/dashboard/spa/src/notifications/useNotifications.test.ts`
Expected: PASS (export from Task 7 + Step 1 + the Task-7 mapping make all three assertions green).

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/useNotifications.ts client/src/dashboard/spa/src/notifications/useNotifications.test.ts
git commit -m "test(#441): adapter maps security.lastPasswordRotationAt to passwordRotatedAt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full verification

- [ ] **Step 1: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Targeted tests**

Run: `cd client && yarn vitest run test/api/gather-status.test.ts src/dashboard/spa/src/notifications/`
Expected: all PASS.

- [ ] **Step 3: Full suite (regression)**

Run: `cd client && yarn test`
Expected: all PASS.

- [ ] **Step 4: Re-read the issue + design note against the diff**

Confirm AC1-AC6 above each map to landed code. Confirm `security` is **always present** (Task 1 default), env→null (Task 5), missing-file→null without throw (Task 5), and the SPA adapter no longer hardcodes `undefined` (Task 7).

---

## Self-review

- **Spec coverage:** AC1 (always-present `security`) → T1/T4. AC2 (file mtime) → T3/T5. AC3 (env→null) → T3/T5. AC4 (missing→null, no throw) → T3 try/catch + T5. AC5 (main.ts both sites) → T6. AC6 (SPA adapter) → T7/T8. All covered.
- **Placeholder scan:** no TBD/"handle edge cases"; every code step shows the literal change.
- **Type consistency:** `PasswordRotationConfig` (defined T3) is used in `StatusGatherConfig.passwordRotation` (T3) and populated in `main.ts` (T6). `GatheredStatusRaw.passwordRotationAt` (T2) is set in gather (T3) and read in `assembleStatusV1` (T1). `StatusV1Response.security.lastPasswordRotationAt` (T1) is consumed by `mapStatusToDeriveInput` (T7) and asserted in tests (T5, T8). `DeriveInput.status.passwordRotatedAt` (pre-existing, `derive.ts:19`) is the deriver contract — unchanged.
- **SPA type flag:** No new SPA status interface needed — `getStatus()` is `unknown`, adapter casts to `Record<string, any>`. Flagged in Task 7 Step 3.
- **Both main.ts sites flagged** (Task 6) because `liveStatus` starts as the API-server block and is swapped to the Daemon block via `setStatusConfig`; missing either leaves a window with `null`.
