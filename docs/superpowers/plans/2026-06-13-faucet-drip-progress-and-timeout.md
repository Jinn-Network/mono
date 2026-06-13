# Faucet Drip Progress + Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During first-run onboarding, surface a visible, honest progress state for the faucet drip and a clear terminal status (with retry) when funds do not arrive within a defined deadline — no silent multi-minute wait.

**Architecture:** SPA-side only; the server's synchronous drip loop (`POST /v1/setup/drip`, `DEFAULT_FAUCET_LOOP_TIMEOUT_MS = 5 min`) is left as-is. Three client changes: (1) `jfetch` gains a `signal` pass-through so callers can abort; (2) `api.triggerDrip` accepts an `AbortSignal`; (3) `AwaitingFundingCard` wraps the drip in an `AbortController` with a 5.5-minute deadline, drives a *real* progress bar from the daemon's already-persisted live balance (`bootstrap.funding.eth_balance` / `targetWei`, polled every 2s by `Onboarding`), replaces the misleading "about a minute" copy with honest expected-wait language, and renders a `timed_out` terminal state with a Retry button + manual-faucet fallback.

**Tech Stack:** TypeScript, React, `@tanstack/react-query`, Vitest + `@testing-library/react`, shadcn/ui (`Progress`, `Button`, `Alert`).

---

## Design-note verification (corrections folded in)

All concrete claims in the Stage-1 design note were verified against the code. Confirmed:

- `DEFAULT_FAUCET_LOOP_TIMEOUT_MS = 5 * 60 * 1000` at `client/src/earning/faucet.ts:33`.
- `jfetch` (`client/src/dashboard/spa/src/api/client.ts:60-79`) has **no** `signal`/`AbortController` support; it spreads `init` into `fetch` but no caller passes a signal, and `api.triggerDrip` (lines 133-148) takes no signal.
- `AwaitingFundingCard.tsx` has a `requesting` state, a 1s elapsed-seconds ticker (lines 65-72), and a fabricated time-curve progress bar `Math.round((elapsedSeconds / 60) * 92)` (line 141) with copy promising "about a minute" (lines 246-247). There is **no** client-side timeout.
- `Onboarding.tsx` polls `/v1/bootstrap` every 2000ms (line 129) and renders `AwaitingFundingCard` with `minimumWei={bootstrap.funding?.targetWei ?? '10000000000000000'}` (line 258). **It does not currently pass live balance to the card.**
- The SPA `BootstrapState.funding` type (`client/src/dashboard/spa/src/api/types.ts:131-145`) exposes `eth_balance?`, `eth_required?`, `targetWei?`, `targetMet?`. The server's `/v1/bootstrap` populates `funding.eth_balance` from `bootstrap-funding.json`, which the daemon rewrites each drip (`client/src/api/bootstrap-endpoint.ts:146-160`, `client/src/api/setup-endpoints.ts:260-266`). So real balance-vs-target progress is available on the existing poll.

**Correction to the design note:** the note says the card "can show balance X / target Y climbing" from the bootstrap poll, but `Onboarding.tsx` does **not** pass `funding.eth_balance` into `AwaitingFundingCard` today — only `targetWei` (as `minimumWei`). This plan adds a new `currentBalanceWei` prop wired from `bootstrap.funding?.eth_balance`. The progress bar is driven by that prop while `requesting`, falling back to a small indeterminate floor when the balance has not yet been observed.

**Test-infra notes:** SPA `.test.tsx` files run under the jsdom project of the root client vitest config (`client/vitest.config.ts:19,82`); run them with `yarn test`. Fake timers are already used in the SPA suite (`connection-state.test.tsx`, `Overview.test.tsx`) via `vi.useFakeTimers()` / `vi.advanceTimersByTime()`. The card's deadline test uses fake timers.

---

## File structure

- `client/src/dashboard/spa/src/api/client.ts` — add `signal?: AbortSignal` pass-through to `jfetch` (already spreads `init`, so the change is type-surface + an explicit `signal` forward) and to `api.triggerDrip`.
- `client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx` — new `currentBalanceWei?` prop; `AbortController` + deadline; real balance-driven progress; honest copy; `timed_out` state with Retry + manual-faucet fallback link.
- `client/src/dashboard/spa/src/regions/Onboarding.tsx` — pass `currentBalanceWei={bootstrap.funding?.eth_balance}` into `AwaitingFundingCard`.
- `client/src/dashboard/spa/src/regions/AwaitingFundingCard.test.tsx` — new behavior tests (timeout state, real progress, honest copy).
- `client/src/dashboard/spa/src/regions/Onboarding.test.tsx` — assert the live-balance prop is wired through (no regression to existing tests).

---

## Task 1: Failing regression tests for the card (TDD red)

**Files:**
- Test: `client/src/dashboard/spa/src/regions/AwaitingFundingCard.test.tsx`

The existing file mocks `../api/client.js` with a static `triggerDrip`. We need per-test control of the drip promise (to leave it pending while we advance fake timers) and fake timers. Add a controllable mock and three new tests. Keep the existing three shared-RPC tests intact.

- [ ] **Step 1: Replace the static mock with a controllable `triggerDrip` and add fake-timer setup**

Replace the current `vi.mock` block (lines 11-15) and add imports/teardown. The new top-of-file looks like:

```tsx
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable drip mock: tests set `dripImpl` to resolve, reject, or hang.
let dripImpl: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
const triggerDrip = vi.fn((opts?: { signal?: AbortSignal }) => dripImpl(opts));

vi.mock('../api/client.js', () => ({
  api: {
    triggerDrip: (opts?: { signal?: AbortSignal }) => triggerDrip(opts),
  },
}));

const { AwaitingFundingCard } = await import('./AwaitingFundingCard.js');

const BASE_PROPS = {
  address: '0x1111111111111111111111111111111111111111',
  minimumWei: '10000000000000000',
  chainExplorerBase: 'https://sepolia.basescan.org',
};

beforeEach(() => {
  triggerDrip.mockClear();
  // Default: a drip that never resolves — lets the deadline fire.
  dripImpl = () => new Promise(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Add the deadline/timeout test (AC2)**

Append inside the file:

```tsx
describe('AwaitingFundingCard — drip deadline (issue #979)', () => {
  it('surfaces a timeout status with a retry button after the deadline elapses', async () => {
    vi.useFakeTimers();
    // A drip request that aborts when its signal fires (mirrors fetch abort).
    dripImpl = (opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });

    render(<AwaitingFundingCard {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));

    // Before the deadline: still in the pending/requesting state.
    expect(screen.getByRole('button', { name: /funding/i })).toBeTruthy();
    expect(screen.queryByTestId('drip-timed-out')).toBeNull();

    // Advance past the 5.5-minute client deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5.5 * 60 * 1000 + 100);
    });

    const timeout = screen.getByTestId('drip-timed-out');
    expect(timeout.textContent).toMatch(/still arriving|taking longer|hasn't arrived/i);
    // Retry affordance is present and the faucet button is clickable again.
    expect(screen.getByRole('button', { name: /try again|retry|fund from faucet/i })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Add the real-progress test (AC1)**

```tsx
describe('AwaitingFundingCard — real balance progress (issue #979)', () => {
  it('drives the progress bar from currentBalanceWei vs target, not a time curve', () => {
    vi.useFakeTimers();
    render(
      <AwaitingFundingCard
        {...BASE_PROPS}
        minimumWei="10000000000000000"
        currentBalanceWei="5000000000000000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));

    // Balance is 50% of target → progressbar value ~50 immediately, with the
    // fake clock NOT advanced (proves it is balance-driven, not elapsed-time).
    const bar = screen.getByRole('progressbar');
    const value = Number(bar.getAttribute('aria-valuenow') ?? bar.getAttribute('data-value'));
    expect(value).toBeGreaterThanOrEqual(45);
    expect(value).toBeLessThanOrEqual(55);
  });

  it('shows balance-vs-target text while requesting', () => {
    render(
      <AwaitingFundingCard
        {...BASE_PROPS}
        minimumWei="10000000000000000"
        currentBalanceWei="5000000000000000"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));
    expect(screen.getByText(/balance .* \/ target/i)).toBeTruthy();
  });
});
```

> Note: shadcn's `Progress` renders a `role="progressbar"`. If the value attribute differs (some shadcn versions omit `aria-valuenow` and use `data-value`/transform), the test reads either `aria-valuenow` or `data-value`; Task 4 ensures the component sets one of them. If neither is exposed, Task 4 adds `data-testid="drip-progress"` + `data-value` to the `Progress` for a deterministic assertion, and this test reads `screen.getByTestId('drip-progress').getAttribute('data-value')`.

- [ ] **Step 4: Add the honest-copy test (AC1)**

```tsx
describe('AwaitingFundingCard — honest expected-wait copy (issue #979)', () => {
  it('does not promise "about a minute" and sets expectation of several minutes', () => {
    render(<AwaitingFundingCard {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));
    // The old misleading copy is gone.
    expect(screen.queryByText(/about a minute/i)).toBeNull();
    // Honest rate-limited expectation is present.
    expect(screen.getByText(/rate-limited|a few minutes/i)).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run the new tests to verify they FAIL**

Run:
```bash
cd client && yarn test src/dashboard/spa/src/regions/AwaitingFundingCard.test.tsx
```
Expected: the three NEW `describe` blocks FAIL — `drip-timed-out` testid not found (no client deadline), progress bar value is time-driven (0 with clock not advanced, or unrelated to balance because `currentBalanceWei` prop does not exist), and the "about a minute" copy still present. The existing shared-RPC tests still PASS.

---

## Task 2: `jfetch` + `api.triggerDrip` signal pass-through

**Files:**
- Modify: `client/src/dashboard/spa/src/api/client.ts:60-79` (jfetch), `:133-148` (triggerDrip)

- [ ] **Step 1: Forward `signal` in `jfetch`**

`jfetch` already spreads `init` last into the `fetch` options, so a `signal` placed on `init` already reaches `fetch`. The only change needed is to let `triggerDrip` accept and forward a signal. No structural change to `jfetch` is required — confirm the spread order keeps `...init` after the static defaults (it does: `credentials`, `headers`, then `...init`). Leave `jfetch` as-is.

> Rationale (Rule 2 — Simplicity First): `init.signal` is already honored by `fetch` via the existing spread. Adding an explicit `signal` parameter to `jfetch` would be redundant. The minimal change is at the `triggerDrip` wrapper.

- [ ] **Step 2: Add an `AbortSignal` to `triggerDrip`**

Change the `triggerDrip` signature (currently lines 133-148) to accept a signal and pass it through `init`:

```ts
  triggerDrip: (opts?: { singleDrip?: boolean; signal?: AbortSignal }) =>
    jfetch<{
      ok: boolean;
      address?: string;
      txHash?: string;
      txHashes?: string[];
      attempts?: number;
      balanceWei?: string;
      targetWei?: string;
      deltaWei?: string;
      reason?: string;
      rateLimited?: boolean;
    }>(
      opts?.singleDrip ? '/v1/setup/drip?singleDrip=true' : '/v1/setup/drip',
      { method: 'POST', signal: opts?.signal },
    ),
```

- [ ] **Step 3: Typecheck the api change in isolation**

Run:
```bash
cd client && yarn build:sdk && npx tsc --noEmit -p src/dashboard/spa/tsconfig.json 2>/dev/null || npx tsc --noEmit
```
Expected: no new type errors from `client.ts`. (If the SPA has no standalone tsconfig, the repo-level `yarn typecheck` in Task 5 covers it; this step is a fast local sanity check.)

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/api/client.ts
git commit -m "fix(spa): let triggerDrip accept an AbortSignal (#979)"
```

---

## Task 3: AwaitingFundingCard — deadline, real progress, honest copy, timeout state

**Files:**
- Modify: `client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx`

- [ ] **Step 1: Add the `currentBalanceWei` prop and the `timed_out` drip state**

Extend `Props` (after `onSharedDefaultRpc`, around line 21):

```tsx
  /**
   * Live master-EOA balance in wei, sourced from the daemon's already-persisted
   * funding gate (`bootstrap.funding.eth_balance`, rewritten each drip and
   * polled by Onboarding every 2s). Drives a REAL progress bar during a drip
   * request instead of a fabricated elapsed-time curve. Issue #979.
   */
  currentBalanceWei?: string;
```

Add it to the destructured params (around line 37):

```tsx
  onSharedDefaultRpc = false,
  currentBalanceWei,
}: Props): JSX.Element {
```

Extend the `dripStatus` union (lines 50-63) with a timeout variant:

```tsx
    | { state: 'rate_limited'; reason: string }
    | { state: 'failed'; reason: string }
    | { state: 'timed_out' }
  >({ state: 'idle' });
```

- [ ] **Step 2: Define the client deadline constant**

Add near the top of the module (after `eyebrow`, around line 30):

```tsx
// Client-side drip deadline. Slightly exceeds the server loop cap
// (DEFAULT_FAUCET_LOOP_TIMEOUT_MS = 5 min) so a stalled request always
// resolves to a surfaced state instead of hanging the button forever. #979.
const DRIP_DEADLINE_MS = 5.5 * 60 * 1000;
```

- [ ] **Step 3: Wrap `requestDrip` in an AbortController with the deadline**

Replace `requestDrip` (lines 80-109) with:

```tsx
  const requestDrip = async (): Promise<void> => {
    hasOptedInRef.current = true;
    setFundingStartedAt(Date.now());
    setElapsedSeconds(0);
    setDripStatus({ state: 'requesting' });
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), DRIP_DEADLINE_MS);
    try {
      const r = await api.triggerDrip({ signal: controller.signal });
      window.clearTimeout(deadline);
      setFundingStartedAt(null);
      if (r.ok) {
        setDripStatus({
          state: 'sent',
          txHash: r.txHash ?? r.txHashes?.at(-1),
          txHashes: r.txHashes,
          attempts: r.attempts,
          balanceWei: r.balanceWei,
          targetWei: r.targetWei,
        });
      } else if (r.rateLimited || (r.reason && /rate|claimed|429/i.test(r.reason))) {
        setDripStatus({ state: 'rate_limited', reason: r.reason ?? 'faucet rate-limited' });
      } else {
        setDripStatus({ state: 'failed', reason: r.reason ?? 'faucet funding failed' });
      }
    } catch (err) {
      window.clearTimeout(deadline);
      setFundingStartedAt(null);
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        setDripStatus({ state: 'timed_out' });
      } else {
        setDripStatus({
          state: 'failed',
          reason: err instanceof Error ? err.message : 'drip failed',
        });
      }
    }
  };
```

- [ ] **Step 4: Replace the fabricated progress curve with real balance-driven progress**

Replace `fundingProgress` (lines 137-142) with:

```tsx
  const fundingProgress = useMemo(() => {
    if (dripStatus.state !== 'requesting') return 0;
    // Real progress: live balance vs target, sourced from the daemon's funding
    // gate via the Onboarding poll. Falls back to a small indeterminate floor
    // until the first balance reading lands. #979.
    try {
      if (currentBalanceWei !== undefined && minimumWei) {
        const target = BigInt(minimumWei);
        if (target > 0n) {
          const balance = BigInt(currentBalanceWei);
          const pct = Number((balance * 100n) / target);
          return Math.min(99, Math.max(5, pct));
        }
      }
    } catch {
      // fall through to floor
    }
    return 8;
  }, [dripStatus.state, currentBalanceWei, minimumWei]);
```

- [ ] **Step 5: Make the Fund button re-enabled after a timeout, and re-fire on retry**

The Fund button's `disabled` (line 186) is `dripStatus.state === 'requesting' || targetReached`. A `timed_out` state is neither, so the existing button label/onClick already re-enables and re-fires `requestDrip` — no change needed there. Confirm the label branch (lines 189-195) falls through to `'Fund from faucet'` for `timed_out` (it does, since `timed_out` is not `requesting`/`targetReached`/`partialDrip`).

- [ ] **Step 6: Replace the misleading "about a minute" copy in the requesting block**

Replace the `requesting` block (lines 239-250) with honest copy + a balance-vs-target readout + the progressbar testid:

```tsx
      {dripStatus.state === 'requesting' && (
        <div className="flex flex-col gap-2">
          <Progress
            data-testid="drip-progress"
            data-value={fundingProgress}
            value={fundingProgress}
            className="h-1.5 rounded-full [&>div]:bg-[var(--accent-gold)]"
          />
          <p className="font-mono text-[11px] text-[var(--fg-muted)]">
            Requesting faucet drips for {trunc(address)}. Faucet drips are small
            and rate-limited; this can take a few minutes.
            {currentBalanceWei !== undefined
              ? ` Balance ${formatEth(currentBalanceWei)} / target ${minimumEth}.`
              : ''}{' '}
            Elapsed {elapsedSeconds}s.
          </p>
        </div>
      )}
```

- [ ] **Step 7: Render the `timed_out` terminal state with Retry + manual-faucet fallback**

Add a block after the `failed` block (after line 258):

```tsx
      {dripStatus.state === 'timed_out' && (
        <div data-testid="drip-timed-out" className="flex flex-col gap-2">
          <p className="font-mono text-[11px] text-[var(--accent-gold)]">
            Funds are still arriving. The faucet is slow and rate-limited; this
            can take several minutes. You can retry, or send ETH manually to the
            address above.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={requestDrip}
              className="bg-[var(--accent-gold)] text-[var(--bg)] hover:bg-[var(--accent-gold-hover)]"
            >
              Try again
            </Button>
            <Button asChild variant="ghost">
              <a
                href={`${chainExplorerBase}/address/${address}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink />
                Check balance on explorer
              </a>
            </Button>
          </div>
        </div>
      )}
```

- [ ] **Step 8: Run the card tests to verify they PASS**

Run:
```bash
cd client && yarn test src/dashboard/spa/src/regions/AwaitingFundingCard.test.tsx
```
Expected: all tests PASS — the three new `describe` blocks (`drip deadline`, `real balance progress`, `honest expected-wait copy`) and the three existing shared-RPC tests.

> If the `real balance progress` test cannot read the value via `role="progressbar"`/`aria-valuenow`, switch its assertion to read `screen.getByTestId('drip-progress').getAttribute('data-value')` (the `data-value` set in Step 6).

- [ ] **Step 9: Commit**

```bash
git add client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx client/src/dashboard/spa/src/regions/AwaitingFundingCard.test.tsx
git commit -m "fix(spa): faucet drip deadline + real balance progress + honest copy (#979)"
```

---

## Task 4: Wire live balance through Onboarding

**Files:**
- Modify: `client/src/dashboard/spa/src/regions/Onboarding.tsx:255-263`
- Test: `client/src/dashboard/spa/src/regions/Onboarding.test.tsx`

- [ ] **Step 1: Add a failing test asserting the live-balance prop reaches the card**

The Onboarding test already renders the funding card when phase 2 is active. Add a test that supplies a setup-mode bootstrap with `currentStep: 'awaiting_funding'`, a `master_address`, and a `funding` block with `eth_balance`, then asserts the balance-vs-target text appears once the drip is requested. Add to the bottom of `Onboarding.test.tsx`:

```tsx
describe('Onboarding — funding card live balance (issue #979)', () => {
  it('passes funding.eth_balance into AwaitingFundingCard', async () => {
    bootstrapOverride = {
      mode: 'setup',
      currentStep: 'awaiting_funding',
      steps: ['wallet', 'safe_predicted', 'awaiting_funding'],
      master_address: '0x2222222222222222222222222222222222222222',
      funding: {
        eth_balance: '5000000000000000',
        eth_required: '5000000000000000',
        targetWei: '10000000000000000',
        targetMet: false,
      },
    };
    render(withQueryClient(<Onboarding />));
    await screen.findByText(/Fund your wallet/i);
    fireEvent.click(screen.getByRole('button', { name: /fund from faucet/i }));
    // Balance-vs-target readout proves the live balance reached the card.
    expect(await screen.findByText(/balance .* \/ target/i)).toBeTruthy();
  });
});
```

> The shared `vi.mock('../api/client.js', …)` in this file does not stub `triggerDrip`. Add `triggerDrip: async () => new Promise<never>(() => {})` (a hanging promise) to the mocked `api` object so the card stays in the `requesting` state for the assertion. Place it alongside the existing `getBootstrap`/`solvernets`/`operator` mock members.

- [ ] **Step 2: Run the new test to verify it FAILS**

Run:
```bash
cd client && yarn test src/dashboard/spa/src/regions/Onboarding.test.tsx -t "live balance"
```
Expected: FAIL — the card receives no `currentBalanceWei`, so it renders no balance-vs-target text.

- [ ] **Step 3: Pass `currentBalanceWei` from the bootstrap poll**

In `Onboarding.tsx`, add the prop to the `AwaitingFundingCard` render (lines 256-262):

```tsx
                    <AwaitingFundingCard
                      address={masterAddress}
                      minimumWei={bootstrap.funding?.targetWei ?? '10000000000000000'}
                      currentBalanceWei={bootstrap.funding?.eth_balance}
                      chainExplorerBase={explorer}
                      chain={bootstrap.chain}
                      onSharedDefaultRpc={bootstrap.rpcUrl === bootstrap.defaultRpcUrl}
                    />
```

- [ ] **Step 4: Run the Onboarding tests to verify they PASS**

Run:
```bash
cd client && yarn test src/dashboard/spa/src/regions/Onboarding.test.tsx
```
Expected: all PASS, including the new `live balance` test and the pre-existing 5-step / statusFor tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/regions/Onboarding.tsx client/src/dashboard/spa/src/regions/Onboarding.test.tsx
git commit -m "fix(spa): wire live funding balance into AwaitingFundingCard (#979)"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole client**

Run:
```bash
cd client && yarn typecheck
```
Expected: zero errors.

- [ ] **Step 2: Run the two touched SPA test files**

Run:
```bash
cd client && yarn test src/dashboard/spa/src/regions/AwaitingFundingCard.test.tsx src/dashboard/spa/src/regions/Onboarding.test.tsx
```
Expected: all PASS.

- [ ] **Step 3: Run the full SPA test scope to catch regressions**

Run:
```bash
cd client && yarn test src/dashboard/spa
```
Expected: all PASS (no regression in connection-state / Overview / other region tests).

- [ ] **Step 4: Build the SPA bundle to confirm it compiles**

Run:
```bash
cd client && yarn build:spa
```
Expected: build succeeds, no type/bundle errors.

---

## Acceptance criteria → task mapping

- **AC1 — faucet request shows a visible pending/progress state until funds arrive (no silent wait):**
  - Task 3 Step 4 (real balance-driven progress bar) + Step 6 (honest requesting copy with live balance-vs-target readout, elapsed seconds).
  - Task 4 (wire `funding.eth_balance` from the 2s `/v1/bootstrap` poll into the card so the bar reflects real funds climbing).
  - Tests: Task 1 Steps 3-4 (real-progress + honest-copy), Task 4 Step 1 (live balance reaches the card).

- **AC2 — if funds have not arrived within a defined timeout, the UI surfaces a clear status (retry / expected wait), not a blank wait:**
  - Task 2 (signal pass-through enabling abort) + Task 3 Step 2 (`DRIP_DEADLINE_MS = 5.5 min`), Step 3 (AbortController fires the deadline → `timed_out` state), Step 5 (button re-enables), Step 7 (`timed_out` terminal block with expected-wait copy, Retry button, and manual-faucet/explorer fallback).
  - Tests: Task 1 Step 2 (after the deadline the card shows `drip-timed-out` + a retry button).

---

## Self-review

- **Spec coverage:** Both ACs map to concrete tasks above. ✔
- **Placeholder scan:** No TBD/"handle edge cases"/"similar to" — every code step shows full code. ✔
- **Type consistency:** `triggerDrip({ signal })` signature in Task 2 matches the call site in Task 3 Step 3; `currentBalanceWei` prop name is identical across the card (Task 3), Onboarding (Task 4), and tests (Tasks 1, 4); `timed_out` state string is consistent across the union, the setter, and the render block. ✔
- **Correction noted:** Onboarding did not previously pass live balance to the card — Task 4 adds it (folded into the plan, not assumed). ✔
