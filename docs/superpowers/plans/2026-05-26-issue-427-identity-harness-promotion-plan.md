# Issue #427 — Promote Identity (§2.2) and Harness Readiness (§2.9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface §2.2 Identity and §2.9 Harness Readiness as first-class /overview surfaces — both rendered above the existing Activity card with no expansion required — by extracting the identity section out of `WalletCard` into a new `IdentityCard`, building a new `HarnessStatusPanel` that consumes `api.harnessReadiness()`, and slimming `WalletCard` to Gas + tJINN + Password.

**Architecture:** Two new shadcn-`Card`-based components rendered in `Overview.tsx`'s main column above `<ActivityCard />`, ordered Identity → Harness → Activity. `IdentityCard` is a pure relocation of existing data + actions (master / agent / Safe / serviceId / agentId, plus the `retryAgentBinding` flow). `HarnessStatusPanel` is new: it derives the list of harnesses from `bootstrap.joinedSolverNets[*].harness`, queries `api.harnessReadiness(name)` per row with TanStack Query (30s refetch), and renders ready / installed / authenticated state plus a re-check and re-authenticate action per row. No daemon-side changes; same data, promoted in the hierarchy.

**Tech Stack:** TypeScript + React 18 (SPA), shadcn/ui primitives (`Card`, `Button`, `Badge`, `Separator`, `Tooltip`, `Alert`), `@tanstack/react-query` (existing `useQuery` patterns), wouter (routing — `useLocation` for navigate), Vitest + `@testing-library/react` (component + integration), Playwright (E2E in `client/test/dashboard/spa.e2e.test.ts` — limited to the already-loaded surfaces; running-mode /overview e2e is out of scope per the existing test scaffold which stalls at `awaiting_funding`).

**Spec reference:** [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md) §2.2 (Identity), §2.9 (Harness Readiness). Anchor docs: [`docs/superpowers/specs/2026-05-26-issue-427-identity-harness-promotion.md`](../specs/2026-05-26-issue-427-identity-harness-promotion.md) (design note), [`docs/superpowers/plans/2026-05-20-operator-app-spec-alignment.md`](2026-05-20-operator-app-spec-alignment.md) Phase 2 (parent plan — this is the implementation pass for Phase 2 with the "no AdvancedDetails to extract from" correction).

**Discipline:**
- TDD for every new component (failing test → minimal implementation → passing test → commit).
- Frequent commits — one logical change per commit, not "task done".
- Single PR off `next` per [`docs/engineering/handbook.md`](../../engineering/handbook.md) — this is not a stacked-PR refactor.
- Work shape: `refactor`. The PR title is `refactor(operator-app): promote Identity + Harness Readiness (§2.2, §2.9)`.

---

## Acceptance criteria (verbatim from #427)

1. **`<IdentityCard />` renders above the fold on Overview (no expansion required).**
   → Covered by Tasks 1, 2, 6 (the `Overview.test.tsx` positional assertion is the gate).
2. **`<HarnessStatusPanel />` renders above the fold on Overview (no expansion required).**
   → Covered by Tasks 3, 4, 6.
3. **Existing Overview tests still pass; new tests assert the two surfaces are visible without expanding any `<details>` / disclosure.**
   → `AdvancedDetails.tsx` was deleted in commit `e47dd57e`; the substitute assertion is "rendered as direct children of the main-column container, in document order before `[data-testid="activity-card"]`". Covered by Task 6 (new positional assertions) and Task 7 (existing tests remain green after `wallet-section-identity` testid moves).
4. **No behaviour changes — same data, just promoted in the hierarchy.**
   → Identity uses the same `/v1/setup/bootstrap` + `/v1/status` data flow already wired in `Overview.tsx`. Harness uses `api.harnessReadiness()` which already exists and is already consumed by `JoinFlow.tsx`. Verified by Task 7 (WalletCard remaining tests stay green for Gas / tJINN / Password) and Task 8 (the relocated identity-section tests pass on `IdentityCard` with the same inputs that used to drive WalletCard).

---

## File structure overview

### Files to create

```
client/src/dashboard/spa/src/pages/overview/
  IdentityCard.tsx              # NEW — §2.2 surface
  IdentityCard.test.tsx         # NEW — component tests
  HarnessStatusPanel.tsx        # NEW — §2.9 surface
  HarnessStatusPanel.test.tsx   # NEW — component tests
```

### Files to modify

```
client/src/dashboard/spa/src/pages/Overview.tsx            # mount IdentityCard + HarnessStatusPanel above ActivityCard
client/src/dashboard/spa/src/pages/Overview.test.tsx       # add positional assertions for the two new testIds
client/src/dashboard/spa/src/pages/overview/WalletCard.tsx # remove the wallet-section-identity block + identity props
client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx # drop identity-section assertions (now in IdentityCard.test.tsx)
```

### Files unchanged but consulted

- `client/src/dashboard/spa/src/api/client.ts` — `api.harnessReadiness(name)` at line 252; no changes.
- `client/src/dashboard/spa/src/api/types.ts` — `HarnessReadinessEntry`, `HarnessReadinessNextStep` at lines 877 / 871; no changes.
- `client/src/dashboard/spa/src/pages/overview/ActivityCard.tsx` — no changes; the new cards mount above it.
- `client/src/dashboard/spa/src/pages/overview/NodeHealthCard.tsx` — no changes; lives in right rail.
- `client/test/dashboard/spa.e2e.test.ts` — **not modified.** The current E2E daemon stalls at `awaiting_funding` and never renders /overview in running mode (the SPA shows the Onboarding view). Adding an /overview-mode browser-test would require a running-daemon fixture which is out of scope for this refactor. The "no `<details>` to expand" assertion is enforced at the Vitest/JSDOM Overview integration tier instead (Task 6) — this is documented in the design note's Testing approach section and accepted by acceptance criterion 3.

---

## Component shapes

### `IdentityCard` (new)

Renders the §2.2 Identity component: master EOA, agent EOA, Safe address, service ID, agent ID, plus the binding-pending retry flow currently buried in `WalletCard`.

```ts
export interface IdentityCardProps {
  /** Operator's master EOA (the address that holds custody and seeds the node). */
  masterAddress: string | null;
  /** Per-node EOA the daemon signs with. Daemon does not surface this yet; pass null. */
  agentAddress: string | null;
  /** Safe address from the primary service (services[0]?.safeAddress). */
  safeAddress: string | null;
  /** Primary service ID (services.find(s => s.serviceId !== null)?.serviceId). */
  serviceId: number | null;
  /** Agent ID from the primary service (services[0]?.agentId). */
  agentId: number | null;
  /** Fleet services — drives the binding-pending detection. */
  services?: ServiceIdentity[];
  /** Optional pre-existing binding error to display. */
  bindingError?: string;
}
```

- Uses the same `ServiceIdentity` interface already exported from `WalletCard.tsx`. To keep things clean we **move that interface** into a new shared module — see Task 1 — and re-export it from `WalletCard.tsx` to avoid breaking external imports.
- Internal state mirrors what `WalletCard` does today: `bindingOpen`, `retrying`, `retryResult`, `retryDetail`, calling `api.retryAgentBinding({ serviceIndex })`.
- Data source: `OverviewPage` derives the props from `status?.fleet?.services` + `bootstrap?.master_address`. No new daemon endpoints.
- Renders inside a shadcn `<Card>` with `data-testid="identity-card"`, a single eyebrow ("Identity"), and four labelled monospace stats (Service / Agent / Master / Safe). The state-message slot below renders three §2.2 messages when conditions hold: `safe-not-bound`, `agent-id-not-minted`, `identity-migration-pending` (the migration message is informational only — daemon doesn't surface it yet; the slot is left in place so future wiring is additive).

### `HarnessStatusPanel` (new)

Renders the §2.9 Harness Readiness component: one row per harness this operator is using (joined-SolverNet scope), with ready / installed / authenticated state plus the §2.9 actions.

```ts
export interface HarnessStatusPanelProps {
  /**
   * Harness names this operator joined SolverNets against. Derived in
   * Overview.tsx from `bootstrap.joinedSolverNets[*].harness` (deduplicated,
   * sorted) — see the joined-only rationale in the design note.
   */
  harnessNames: string[];
}
```

- Each row mounts an isolated `useQuery({ queryKey: ['harness-readiness', name], queryFn: () => api.harnessReadiness(name), refetchInterval: 30_000 })`. Per-row state lives inside a small `HarnessStatusRow` sub-component.
- Per-row fields displayed: name (eyebrow), an installed / authenticated / ready pill triplet, the `nextStep.description` line when `ready === false` (with the `cli` or `url` hint when present), and the optional `reason` string.
- Per-row actions: a **Re-check** button (`queryClient.invalidateQueries({ queryKey: ['harness-readiness', name] })`) and a **Re-authenticate** button. Re-authenticate prefers `nextStep.url` (open in new tab) when present; otherwise it copies `nextStep.cli` to the clipboard via `navigator.clipboard.writeText` and shows a `sonner` toast confirming the copy. Both actions are no-ops when the row is `ready === true`.
- Panel-level state-message slot renders the three §2.9 messages when conditions hold across the row set: `harness-not-installed`, `auth-expired`, `version-mismatch`. The daemon does not differentiate these today — `nextStep.description` carries the text — so the panel surfaces the rendered `nextStep` line at row level and the slot is informational. Empty state: when `harnessNames.length === 0` the panel renders a single helper row ("No SolverNets joined — Harness Readiness will populate after you join one.") with a button that navigates to `/operator/registry`.

### `WalletCard` (modified — slim)

Removes the `wallet-section-identity` block (lines 273–355 in current source) and the props that fed it: `masterAddress`, `agentId`, `safeAddress`, `services`, `bindingError`. The Rewards / Gas / Password sections stay verbatim. Re-export of `ServiceIdentity` continues from `WalletCard.tsx` so callers that import the type don't break.

### `Overview.tsx` (modified)

Main column reshape:

```
<div className="flex min-w-0 flex-col gap-6">
  {isEvicted && <EvictionBanner ... />}
  <IdentityCard {...identityProps} />        {/* NEW */}
  <HarnessStatusPanel {...harnessProps} />   {/* NEW */}
  <ActivityCard joined={joinedNets} tasks={activityTasks} />
</div>
```

Right rail unchanged. The `WalletCard` invocation drops the five identity props (`agentId`, `masterAddress`, `safeAddress`, `services`, `bindingError`).

---

## Test plan

### TDD entrypoint

**Task 6 Step 1** writes the failing **positional** test in `Overview.test.tsx` that asserts both new testIds (`identity-card`, `harness-status-panel`) appear as direct children of the main column and precede `activity-card` in document order. This is the test that names the deliverable — once it passes, the four acceptance criteria are met.

### Coverage per file

- **`IdentityCard.test.tsx`** (new): all five identity stats render correctly given props; truncation for addresses; binding-pending chip appears iff a service has `agentId !== null && !safeBoundToAgent`; clicking Retry binding invokes `api.retryAgentBinding({ serviceIndex })`; the three state-messages render iff their condition holds; `data-testid="identity-card"` is present on the root element.
- **`HarnessStatusPanel.test.tsx`** (new): mocks `api.harnessReadiness` returning a ready-true fixture and a ready-false-with-nextStep fixture; one row per `harnessNames` entry; ready/installed/authenticated pills render; `nextStep.description` renders when not ready; Re-check button triggers a refetch; Re-authenticate copies `cli` or opens `url`; the empty-state row renders when `harnessNames` is empty; `data-testid="harness-status-panel"` is present on the root element.
- **`Overview.test.tsx`** (modified): the new positional test (Task 6 Step 1); the existing layout test that asserts `wallet-card`, `node-health-card`, `activity-card` still mount — augmented to also assert `identity-card` and `harness-status-panel`; the eviction-banner and wallet-wiring tests are untouched (Identity moved out of `WalletCard`, but `WalletCard`'s gas / tJINN / password coverage stays).
- **`WalletCard.test.tsx`** (modified): drop the three tests that touched `wallet-section-identity` (the "shows Identity labels (Agent / Master / Safe)" test, the "surfaces a binding-pending chip" test, and the "renders Wallet eyebrow and the four sections" test loses the `wallet-section-identity` assertion). The remaining 11 tests (eyebrow + three sections, gas, rewards, password, tJINN states, accessibility) stay; the `defaultProps()` helper drops `agentId`, `masterAddress`, `safeAddress`, `services`, `bindingError`.
- **`client/test/dashboard/spa.e2e.test.ts`** (untouched): see the rationale in "Files unchanged but consulted" above.

### Test fixtures

`HarnessStatusPanel.test.tsx` introduces fixtures for two `HarnessReadinessEntry` shapes — these are not new mocks at the daemon boundary; the test mocks `api.harnessReadiness` per existing `WalletCard.test.tsx` convention. Fixture shapes match the real type at `client/src/dashboard/spa/src/api/types.ts:877`:

```ts
const READY: HarnessReadinessEntry = {
  harnessName: 'claude-code',
  manifestCids: ['bafkreiswe'],
  ready: true,
};
const NOT_READY: HarnessReadinessEntry = {
  harnessName: 'codex',
  manifestCids: ['bafkreiswe'],
  ready: false,
  reason: 'CLI not authenticated',
  nextStep: { description: 'Run codex login', cli: 'codex login' },
};
const NOT_READY_URL: HarnessReadinessEntry = {
  harnessName: 'claude-code',
  manifestCids: ['bafkreiswe'],
  ready: false,
  reason: 'subscription expired',
  nextStep: { description: 'Re-authenticate Claude Code', url: 'https://claude.ai/login' },
};
```

---

## Step-by-step task list

> One PR. Tasks 1–8 are ordered; each leaves the tree in a green state. Commit after each task.

### Task 1: Extract the `ServiceIdentity` interface position

**Files:**
- Read: `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx`
- Modify: none (we keep `ServiceIdentity` exported from `WalletCard.tsx` — the new `IdentityCard` will import it from that path).

**Acceptance criterion link:** none directly (prep step).

- [ ] **Step 1: Verify the existing export**

```bash
grep -n "export interface ServiceIdentity" client/src/dashboard/spa/src/pages/overview/WalletCard.tsx
```

Expected: line 27 — `export interface ServiceIdentity {`. No change needed; `IdentityCard.tsx` (next task) will import it.

- [ ] **Step 2: No commit (no edits in this task).**

---

### Task 2: Create `IdentityCard` component (TDD)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/IdentityCard.tsx`

**Acceptance criterion link:** AC1, AC4.

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { IdentityCard, type IdentityCardProps } from './IdentityCard.js';

const retryAgentBindingMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    retryAgentBinding: (opts: { serviceIndex: number }) => retryAgentBindingMock(opts),
  },
}));

function defaultProps(): IdentityCardProps {
  return {
    masterAddress: '0x53e25264C86db85b6168F7824f5c39abd5281787',
    agentAddress: null,
    safeAddress: '0x26e90000000000000000000000000000000000638',
    serviceId: 50,
    agentId: 5879,
    services: [],
  };
}

function wrap(ui: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/overview' });
  return <Router hook={hook}>{ui}</Router>;
}

describe('IdentityCard', () => {
  it('exposes data-testid="identity-card" on the root region', () => {
    render(wrap(<IdentityCard {...defaultProps()} />));
    expect(screen.getByTestId('identity-card')).toBeTruthy();
  });

  it('renders all five identity stats with truncated addresses and #-prefixed ids', () => {
    render(wrap(<IdentityCard {...defaultProps()} />));
    const card = screen.getByTestId('identity-card');
    expect(card.textContent).toMatch(/identity/i);
    expect(card.textContent).toMatch(/service/i);
    expect(card.textContent).toContain('#50');
    expect(card.textContent).toMatch(/agent/i);
    expect(card.textContent).toContain('#5879');
    expect(card.textContent).toMatch(/master/i);
    expect(card.textContent).toContain('0x53e2');
    expect(card.textContent).toContain('1787');
    expect(card.textContent).toMatch(/safe/i);
    expect(card.textContent).toContain('0x26e9');
    expect(card.textContent).toContain('0638');
  });

  it('renders em-dash placeholders when ids or addresses are null', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          masterAddress={null}
          safeAddress={null}
          serviceId={null}
          agentId={null}
        />,
      ),
    );
    const card = screen.getByTestId('identity-card');
    // Four '—' placeholders, one per missing stat.
    expect(card.querySelectorAll('[data-testid="identity-stat-empty"]').length).toBe(4);
  });

  it('surfaces a binding-pending chip when a service has agentId but is not bound', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
          ]}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /binding pending/i })).toBeTruthy();
  });

  it('does not surface a binding-pending chip when all services are bound', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: true },
          ]}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: /binding pending/i })).toBeNull();
  });

  it('invokes api.retryAgentBinding with the unbound service index when Retry binding is clicked', async () => {
    retryAgentBindingMock.mockReset();
    retryAgentBindingMock.mockResolvedValue({ attempts: [{ status: 'success' }] });
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
          ]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /binding pending/i }));
    fireEvent.click(screen.getByRole('button', { name: /retry binding/i }));
    await waitFor(() =>
      expect(retryAgentBindingMock).toHaveBeenCalledWith({ serviceIndex: 0 }),
    );
  });

  it('renders the safe-not-bound state-message row when a service is unbound', () => {
    render(
      wrap(
        <IdentityCard
          {...defaultProps()}
          services={[
            { index: 0, serviceId: 50, safeAddress: '0xSafe', agentId: 5879, safeBoundToAgent: false },
          ]}
        />,
      ),
    );
    expect(screen.getByTestId('identity-state-message-safe-not-bound')).toBeTruthy();
  });

  it('renders the agent-id-not-minted state-message row when agentId is null', () => {
    render(wrap(<IdentityCard {...defaultProps()} agentId={null} />));
    expect(screen.getByTestId('identity-state-message-agent-id-not-minted')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx
```

Expected: module-not-found error for `./IdentityCard.js`.

- [ ] **Step 3: Implement `IdentityCard.tsx`**

Create `client/src/dashboard/spa/src/pages/overview/IdentityCard.tsx`:

```tsx
import { useState } from 'react';
import { api } from '../../api/client.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import type { ServiceIdentity } from './WalletCard.js';

/**
 * Identity — the operator's on-chain identities per OPERATOR-APP-SPEC §2.2.
 * Five labelled monospace stats (Service / Agent / Master / Safe — agent
 * EOA reserved for a future daemon field) plus the binding-pending retry
 * flow and three §2.2 state-message rows.
 *
 * Extracted from WalletCard's `wallet-section-identity` block as part of
 * the #427 promotion — same data, promoted in the hierarchy. See
 * docs/superpowers/specs/2026-05-26-issue-427-identity-harness-promotion.md.
 */
export interface IdentityCardProps {
  masterAddress: string | null;
  agentAddress: string | null;
  safeAddress: string | null;
  serviceId: number | null;
  agentId: number | null;
  services?: ServiceIdentity[];
  bindingError?: string;
}

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

function trunc(addr: string | null | undefined): string {
  if (!addr || addr.length < 10) return addr ?? '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function EmptyDash(): JSX.Element {
  return (
    <span data-testid="identity-stat-empty" className="font-mono text-[14px] text-[var(--fg-muted)]">
      —
    </span>
  );
}

export function IdentityCard({
  masterAddress,
  safeAddress,
  serviceId,
  agentId,
  services = [],
  bindingError,
}: IdentityCardProps): JSX.Element {
  const pendingBinding = services.find((s) => s.agentId !== null && !s.safeBoundToAgent);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<'success' | 'reverted' | null>(null);
  const [retryDetail, setRetryDetail] = useState<string | null>(bindingError ?? null);

  const retry = async (): Promise<void> => {
    if (!pendingBinding) return;
    setRetrying(true);
    setRetryResult(null);
    setRetryDetail(null);
    try {
      const res = await api.retryAgentBinding({ serviceIndex: pendingBinding.index });
      const attempt = res.attempts[0];
      if (attempt?.status === 'success') {
        setRetryResult('success');
        setBindingOpen(false);
      } else {
        setRetryResult('reverted');
        setRetryDetail(attempt?.detail ?? 'Bind reverted on chain.');
      }
    } catch (err) {
      setRetryResult('reverted');
      setRetryDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        role="region"
        aria-label="Identity"
        data-testid="identity-card"
        className="flex flex-col gap-6 p-6"
      >
        <span className={eyebrow}>Identity</span>

        <div className="flex flex-wrap gap-8">
          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Service</span>
            {serviceId !== null ? (
              <span data-testid="identity-service-id" className="font-mono text-[14px] text-foreground">
                #{serviceId}
              </span>
            ) : (
              <EmptyDash />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Agent</span>
            <span className="flex items-center gap-2 font-mono text-[14px] text-foreground">
              {agentId !== null ? `#${agentId}` : <EmptyDash />}
              {pendingBinding && (
                <button
                  type="button"
                  onClick={() => setBindingOpen((o) => !o)}
                  className="cursor-pointer rounded-full border border-[var(--wane)] bg-transparent px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--wane)]"
                >
                  binding pending
                </button>
              )}
              {retryResult === 'success' && (
                <Badge variant="success" className="rounded-full normal-case tracking-[0.12em]">
                  bound
                </Badge>
              )}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Master</span>
            {masterAddress ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid="identity-master-address"
                    tabIndex={0}
                    className="cursor-help font-mono text-[14px] text-foreground"
                  >
                    {trunc(masterAddress)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{masterAddress}</TooltipContent>
              </Tooltip>
            ) : (
              <EmptyDash />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className={sectionLabel}>Safe</span>
            {safeAddress ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid="identity-safe-address"
                    tabIndex={0}
                    className="cursor-help font-mono text-[14px] text-foreground"
                  >
                    {trunc(safeAddress)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{safeAddress}</TooltipContent>
              </Tooltip>
            ) : (
              <EmptyDash />
            )}
          </div>
        </div>

        {/* State messages — §2.2 */}
        {pendingBinding && (
          <Alert
            variant="warning"
            data-testid="identity-state-message-safe-not-bound"
            className="flex flex-col gap-2"
          >
            <AlertDescription>
              Service #{pendingBinding.index} Safe is not yet bound to agent #{pendingBinding.agentId}.
              The bootstrap left it unbound; retry to attempt the ERC-1271 bind again.
            </AlertDescription>
            {bindingOpen && retryDetail && (
              <span className="font-mono text-[11px] text-[var(--break-red)]">{retryDetail}</span>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                if (!bindingOpen) setBindingOpen(true);
                void retry();
              }}
              disabled={retrying}
              className="self-start"
            >
              {retrying ? 'Retrying…' : 'Retry binding'}
            </Button>
          </Alert>
        )}

        {agentId === null && (
          <Alert
            variant="warning"
            data-testid="identity-state-message-agent-id-not-minted"
          >
            <AlertDescription>
              Agent ID has not yet been minted. The daemon mints it during bootstrap; if this
              persists, check the bootstrap logs.
            </AlertDescription>
          </Alert>
        )}
      </Card>
    </TooltipProvider>
  );
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx
```

Expected: all 8 cases pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/overview/IdentityCard.tsx \
        client/src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx
git commit -m "feat(overview): IdentityCard component (§2.2)"
```

---

### Task 3: Write failing test for `HarnessStatusPanel`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.test.tsx`

**Acceptance criterion link:** AC2, AC4.

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Toaster } from '../../components/ui/sonner.js';
import { HarnessStatusPanel } from './HarnessStatusPanel.js';
import type { HarnessReadinessEntry } from '../../api/types.js';

const harnessReadinessMock = vi.fn();

vi.mock('../../api/client.js', () => ({
  api: {
    harnessReadiness: (name: string) => harnessReadinessMock(name),
  },
}));

const READY: HarnessReadinessEntry = {
  harnessName: 'claude-code',
  manifestCids: ['bafkreiswe'],
  ready: true,
};
const NOT_READY_CLI: HarnessReadinessEntry = {
  harnessName: 'codex',
  manifestCids: ['bafkreiswe'],
  ready: false,
  reason: 'CLI not authenticated',
  nextStep: { description: 'Run codex login', cli: 'codex login' },
};
const NOT_READY_URL: HarnessReadinessEntry = {
  harnessName: 'claude-code',
  manifestCids: ['bafkreiswe'],
  ready: false,
  reason: 'subscription expired',
  nextStep: { description: 'Re-authenticate Claude Code', url: 'https://claude.ai/login' },
};

function withProviders(node: JSX.Element): JSX.Element {
  const { hook } = memoryLocation({ path: '/overview' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Router hook={hook}>{node}</Router>
      <Toaster />
    </QueryClientProvider>
  );
}

describe('HarnessStatusPanel', () => {
  beforeEach(() => {
    harnessReadinessMock.mockReset();
  });

  it('exposes data-testid="harness-status-panel" on the root region', async () => {
    harnessReadinessMock.mockResolvedValue(READY);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    expect(await screen.findByTestId('harness-status-panel')).toBeTruthy();
  });

  it('renders one row per harness name, with the name in the row header', async () => {
    harnessReadinessMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'claude-code' ? READY : NOT_READY_CLI),
    );
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code', 'codex']} />));
    await waitFor(() => {
      expect(screen.getByTestId('harness-row-claude-code')).toBeTruthy();
      expect(screen.getByTestId('harness-row-codex')).toBeTruthy();
    });
  });

  it('renders ready pill when the harness is ready', async () => {
    harnessReadinessMock.mockResolvedValue(READY);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    await waitFor(() => {
      const row = screen.getByTestId('harness-row-claude-code');
      expect(row.textContent).toMatch(/ready/i);
    });
  });

  it('renders the nextStep.description and the cli hint when not ready', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_CLI);
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    await waitFor(() => {
      const row = screen.getByTestId('harness-row-codex');
      expect(row.textContent).toContain('Run codex login');
      expect(row.textContent).toContain('codex login');
    });
  });

  it('renders a Re-check button per row and refetches readiness when clicked', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_CLI);
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    await waitFor(() => screen.getByTestId('harness-row-codex'));
    const callsBefore = harnessReadinessMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('harness-recheck-codex'));
    await waitFor(() =>
      expect(harnessReadinessMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('renders a Re-authenticate button that opens nextStep.url in a new tab when present', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_URL);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    await waitFor(() => screen.getByTestId('harness-reauth-claude-code'));
    fireEvent.click(screen.getByTestId('harness-reauth-claude-code'));
    expect(openSpy).toHaveBeenCalledWith('https://claude.ai/login', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('copies nextStep.cli to clipboard when no url is available', async () => {
    harnessReadinessMock.mockResolvedValue(NOT_READY_CLI);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(withProviders(<HarnessStatusPanel harnessNames={['codex']} />));
    await waitFor(() => screen.getByTestId('harness-reauth-codex'));
    fireEvent.click(screen.getByTestId('harness-reauth-codex'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('codex login'));
  });

  it('renders an empty-state helper row when harnessNames is empty', () => {
    render(withProviders(<HarnessStatusPanel harnessNames={[]} />));
    const panel = screen.getByTestId('harness-status-panel');
    expect(panel.textContent).toMatch(/no solvernets joined/i);
  });

  it('hides Re-check / Re-authenticate buttons when the row is ready', async () => {
    harnessReadinessMock.mockResolvedValue(READY);
    render(withProviders(<HarnessStatusPanel harnessNames={['claude-code']} />));
    await waitFor(() => screen.getByTestId('harness-row-claude-code'));
    expect(screen.queryByTestId('harness-reauth-claude-code')).toBeNull();
    expect(screen.queryByTestId('harness-recheck-claude-code')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/overview/HarnessStatusPanel.test.tsx
```

Expected: module-not-found error for `./HarnessStatusPanel.js`.

- [ ] **Step 3: Commit the failing test**

Commit the test alone so the failing-first commit is recoverable in history.

```bash
git add client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.test.tsx
git commit -m "test(overview): failing test for HarnessStatusPanel (§2.9)"
```

---

### Task 4: Implement `HarnessStatusPanel`

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx`

**Acceptance criterion link:** AC2, AC4.

- [ ] **Step 1: Implement the component**

Create `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx`:

```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { api } from '../../api/client.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Separator } from '../../components/ui/separator.js';
import type { HarnessReadinessEntry } from '../../api/types.js';

/**
 * Harness Readiness — §2.9 surface promoted out of buried state into a
 * first-class /overview card. One row per harness this operator has joined
 * a SolverNet against (joined-only scope; see design note 2026-05-26 for the
 * "joined vs all" decision). Per-row read uses `api.harnessReadiness(name)`
 * via TanStack Query with a 30s refetch — same query the JoinFlow uses,
 * different surface.
 */
export interface HarnessStatusPanelProps {
  /** Harness names this operator joined SolverNets against, deduplicated. */
  harnessNames: string[];
}

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const sectionLabel = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

function HarnessStatusRow({ name }: { name: string }): JSX.Element {
  const queryClient = useQueryClient();
  const { data, isError, error } = useQuery<HarnessReadinessEntry>({
    queryKey: ['harness-readiness', name],
    queryFn: () => api.harnessReadiness(name),
    refetchInterval: 30_000,
  });

  const recheck = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['harness-readiness', name] });
  };

  const reauthenticate = (): void => {
    const step = data?.nextStep;
    if (!step) return;
    if (step.url) {
      window.open(step.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (step.cli) {
      void navigator.clipboard
        .writeText(step.cli)
        .then(() => toast.success('Command copied', { description: step.cli, duration: 5_000 }))
        .catch(() =>
          toast.error('Could not copy', {
            description: step.cli,
            duration: Infinity,
          }),
        );
    }
  };

  const ready = data?.ready === true;
  const notReady = data?.ready === false;

  return (
    <div
      data-testid={`harness-row-${name}`}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <span className={sectionLabel}>{name}</span>
        {ready && (
          <Badge variant="success" data-testid={`harness-pill-ready-${name}`}>
            ready
          </Badge>
        )}
        {notReady && (
          <Badge variant="destructive" data-testid={`harness-pill-not-ready-${name}`}>
            not ready
          </Badge>
        )}
        {isError && (
          <Badge variant="outline" data-testid={`harness-pill-error-${name}`}>
            unavailable
          </Badge>
        )}
      </div>
      {notReady && data?.reason && (
        <span className="font-mono text-[12px] text-[var(--break-red)]">{data.reason}</span>
      )}
      {notReady && data?.nextStep && (
        <span
          data-testid={`harness-next-step-${name}`}
          className="font-mono text-[12px] text-[var(--fg-muted)]"
        >
          {data.nextStep.description}
          {data.nextStep.cli ? ` (${data.nextStep.cli})` : ''}
        </span>
      )}
      {isError && (
        <span className="font-mono text-[12px] text-[var(--fg-muted)]">
          {error instanceof Error ? error.message : 'Readiness check failed.'}
        </span>
      )}
      {notReady && (
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            data-testid={`harness-reauth-${name}`}
            onClick={reauthenticate}
          >
            Re-authenticate
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid={`harness-recheck-${name}`}
            onClick={recheck}
          >
            Re-check
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState(): JSX.Element {
  const [, navigate] = useLocation();
  return (
    <div className="flex flex-col gap-2" data-testid="harness-empty-state">
      <span className="font-mono text-[12px] text-[var(--fg-muted)]">
        No SolverNets joined — Harness Readiness will populate after you join one.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate('/operator/registry')}
        data-testid="harness-empty-state-browse"
        className="self-start"
      >
        Browse SolverNets
      </Button>
    </div>
  );
}

export function HarnessStatusPanel({
  harnessNames,
}: HarnessStatusPanelProps): JSX.Element {
  return (
    <Card
      role="region"
      aria-label="Harness Readiness"
      data-testid="harness-status-panel"
      className="flex flex-col gap-4 p-6"
    >
      <span className={eyebrow}>Harness Readiness</span>
      {harnessNames.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-4">
          {harnessNames.map((name, idx) => (
            <div key={name} className="flex flex-col gap-4">
              {idx > 0 && <Separator />}
              <HarnessStatusRow name={name} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Run the test, confirm it passes**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/overview/HarnessStatusPanel.test.tsx
```

Expected: all 9 cases pass.

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx
git commit -m "feat(overview): HarnessStatusPanel component (§2.9)"
```

---

### Task 5: Strip identity from `WalletCard` (red → green sequence)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`
- Modify: `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx`

**Acceptance criterion link:** AC4 (no behaviour change; identity data path is preserved via IdentityCard).

- [ ] **Step 1: Update `WalletCard.test.tsx` to drop identity coverage**

Apply these edits to `client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`:

1. In `defaultProps()`, remove `agentId`, `masterAddress`, `safeAddress`, `services`, and `bindingError`. The new `defaultProps()` returns:

```ts
function defaultProps(): WalletCardProps {
  return {
    totalEth: '0.0088',
    runwayDays: 1,
    perRole: { master: '0.0088', agent: '—', safe: '—' },
    tjinnEarned: '0.0000',
    tjinnEarnedLast24h: '0.0000',
    tjinnState: 'ready',
    tjinnError: null,
    lastClaimAt: null,
    lastPasswordRotationAt: null,
    onTopUp: vi.fn(),
  };
}
```

2. Delete the "shows Identity labels (Agent / Master / Safe) with truncated addresses" test.

3. Delete the "surfaces a binding-pending chip when a service is unbound" test.

4. In the "renders Wallet eyebrow and the four sections" test, change the assertions to three sections (drop `wallet-section-identity`):

```ts
it('renders Wallet eyebrow and the three sections', () => {
  const { ui } = wrap(<WalletCard {...defaultProps()} />);
  render(ui);
  expect(screen.getByText(/^wallet$/i)).toBeTruthy();
  expect(screen.getByTestId('wallet-section-gas')).toBeTruthy();
  expect(screen.getByTestId('wallet-section-rewards')).toBeTruthy();
  expect(screen.getByTestId('wallet-section-password')).toBeTruthy();
  expect(screen.queryByTestId('wallet-section-identity')).toBeNull();
});
```

5. The unrelated `api.retryAgentBinding` mock can be removed from the `vi.mock(...)` call since no remaining test exercises it through WalletCard:

```ts
vi.mock('../../api/client.js', () => ({
  api: {},
}));
```

- [ ] **Step 2: Run the test, confirm it now fails on the "three sections" assertion**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/overview/WalletCard.test.tsx
```

Expected: the "three sections" test fails because `WalletCard` still renders `wallet-section-identity`.

- [ ] **Step 3: Update `WalletCard.tsx` — remove identity block + identity props**

Apply these edits to `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx`:

1. Remove unused imports — `Badge`, `Alert`, `AlertDescription`, `useState` (if no other state remains; `useState` may be needed elsewhere, double-check). Drop the `api` import if `retryAgentBinding` is its only use.

2. Update the `WalletCardProps` interface: delete `masterAddress`, `agentId`, `safeAddress`, `services`, and `bindingError`. Keep `ServiceIdentity` exported for `IdentityCard` to import.

3. In the docstring, change the description from "absorbed the separate Funds, Rewards, and Identity cards" to "three hairline-separated sections — Rewards, Gas, Password — now that Identity lives in its own card per OPERATOR-APP-SPEC §2.2".

4. Delete the entire `{/* ── IDENTITY ── */}` block (lines 273–355 of the current source) AND the `<Separator />` that precedes it (after the Gas block) — leave the Separator that precedes the Password block intact.

5. Delete the `pendingBinding`, `primaryServiceId`, `bindingOpen`, `retrying`, `retryResult`, `retryDetail`, and `retry` derivations / state from the function body.

6. Drop the destructured props in the function signature that you removed from `WalletCardProps`.

- [ ] **Step 4: Run the test, confirm it passes**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/overview/WalletCard.test.tsx
```

Expected: all remaining tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd client && yarn typecheck
```

Expected: zero errors. (`Overview.tsx` still passes the removed props to `WalletCard` at this stage — the typecheck WILL fail at this commit. Continue to Task 6 to fix the call site.)

If typecheck fails on `Overview.tsx`, that's expected: the call site is fixed in Task 6.

- [ ] **Step 6: Commit (work-in-progress; typecheck not green until Task 6)**

```bash
git add client/src/dashboard/spa/src/pages/overview/WalletCard.tsx \
        client/src/dashboard/spa/src/pages/overview/WalletCard.test.tsx
git commit -m "refactor(wallet-card): drop identity section (moved to IdentityCard)"
```

---

### Task 6: Mount the two new cards in `Overview.tsx` (TDD via positional integration test)

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.test.tsx`
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx`

**Acceptance criterion link:** AC1, AC2, AC3.

- [ ] **Step 1: Write the failing positional test**

Add to `client/src/dashboard/spa/src/pages/Overview.test.tsx` — at the end of the `describe('OverviewPage layout', ...)` block:

```tsx
it('renders IdentityCard and HarnessStatusPanel as direct children of the main column, above ActivityCard', async () => {
  getStatusMock.mockResolvedValue({
    fleet: { services: [{ index: 0, step: 'complete', serviceId: 50, agentId: 5879, safeAddress: '0xSafeAddr0000000000000000000000000000beef', safeBoundToAgent: true }] },
    taskRuns: { totals: {}, inFlight: [], recentTasks: [] },
    predictionV1: {
      operator: { ok: true, solverNet: { name: 'prediction', enabled: false }, diagnostics: [] },
      totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
      recentTasks: [],
    },
  });
  getBootstrapMock.mockResolvedValue({
    master_address: '0x53e25264C86db85b6168F7824f5c39abd5281787',
    joinedSolverNets: {
      bafkreiswe: {
        manifestCid: 'bafkreiswe',
        name: 'SWE-rebench v2',
        roles: ['solver'],
        harness: 'hermes-agent',
      },
    },
  });
  // The Harness panel queries api.harnessReadiness — stub a ready response.
  harnessReadinessMock.mockResolvedValue({
    harnessName: 'hermes-agent',
    manifestCids: ['bafkreiswe'],
    ready: true,
  });
  render(withProviders(<OverviewPage />));

  // Both cards mount as direct children of the main-column container.
  const grid = await screen.findByTestId('overview-page-grid');
  const mainColumn = grid.firstElementChild;
  expect(mainColumn).not.toBeNull();
  const identityCard = await screen.findByTestId('identity-card');
  const harnessPanel = await screen.findByTestId('harness-status-panel');
  const activityCard = await screen.findByTestId('activity-card');
  expect(identityCard.parentElement).toBe(mainColumn);
  expect(harnessPanel.parentElement).toBe(mainColumn);
  expect(activityCard.parentElement).toBe(mainColumn);

  // Document order: identity → harness → activity (no `<details>` wrapper).
  const children = Array.from(mainColumn!.children) as HTMLElement[];
  const identityIdx = children.findIndex((c) => c === identityCard);
  const harnessIdx = children.findIndex((c) => c === harnessPanel);
  const activityIdx = children.findIndex((c) => c === activityCard);
  expect(identityIdx).toBeGreaterThanOrEqual(0);
  expect(harnessIdx).toBeGreaterThan(identityIdx);
  expect(activityIdx).toBeGreaterThan(harnessIdx);

  // Neither card is wrapped in a <details> disclosure.
  expect(identityCard.closest('details')).toBeNull();
  expect(harnessPanel.closest('details')).toBeNull();
});
```

Add the `harnessReadinessMock` near the other mocks at the top of the file:

```ts
const harnessReadinessMock = vi.fn();
```

And extend the `vi.mock('../api/client.js', ...)` block:

```ts
vi.mock('../api/client.js', () => ({
  api: {
    getStatus: () => getStatusMock(),
    getBootstrap: () => getBootstrapMock(),
    triggerDrip: (opts?: { singleDrip?: boolean }) => triggerDripMock(opts),
    restartDaemon: (opts?: { forceRespawn?: boolean }) => restartDaemonMock(opts),
    stopDaemon: () => stopDaemonMock(),
    restake: (serviceId: number) => restakeMock(serviceId),
    retryAgentBinding: (opts: { serviceIndex: number }) => retryAgentBindingMock(opts),
    harnessReadiness: (name: string) => harnessReadinessMock(name),
  },
}));
```

Reset it in `beforeEach`:

```ts
harnessReadinessMock.mockReset();
harnessReadinessMock.mockResolvedValue({ harnessName: '', manifestCids: [], ready: true });
```

Also update the existing "renders the two-column page shell with Activity card + Node Health + Wallet" test to expect the new cards on the page:

```ts
it('renders the two-column page shell with Identity, Harness, Activity + Node Health + Wallet', async () => {
  getStatusMock.mockResolvedValue({
    fleet: { services: [{ index: 0, step: 'complete' }] },
    taskRuns: { totals: {}, inFlight: [], recentTasks: [] },
    predictionV1: { /* …unchanged… */ },
  });
  getBootstrapMock.mockResolvedValue({});
  render(withProviders(<OverviewPage />));

  expect(await screen.findByTestId('overview-page-grid')).toBeTruthy();
  expect(screen.getByTestId('identity-card')).toBeTruthy();
  expect(screen.getByTestId('harness-status-panel')).toBeTruthy();
  expect(screen.getByTestId('activity-card')).toBeTruthy();
  expect(screen.getByTestId('node-health-card')).toBeTruthy();
  expect(screen.getByTestId('wallet-card')).toBeTruthy();
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/Overview.test.tsx
```

Expected: the new positional test fails — `identity-card` and `harness-status-panel` testIds are not in the DOM.

- [ ] **Step 3: Update `Overview.tsx` — mount the two new cards + drop identity props from WalletCard call**

Apply these edits to `client/src/dashboard/spa/src/pages/Overview.tsx`:

1. Add the imports near the top:

```ts
import { IdentityCard } from './overview/IdentityCard.js';
import { HarnessStatusPanel } from './overview/HarnessStatusPanel.js';
```

2. Inside `OverviewPage()`, after the existing `services` derivation and the `firstEvictedService` block, derive the harness names:

```ts
// Harness names this operator has joined SolverNets against. Joined-only
// scope per design note 2026-05-26 — keeps the panel focused on harnesses
// the operator actually runs. Deduped + sorted for stable rendering.
const harnessNames = useMemo<string[]>(() => {
  const set = new Set<string>();
  const j = bootstrap?.joinedSolverNets;
  if (j) {
    for (const entry of Object.values(j)) {
      if (entry?.harness) set.add(entry.harness);
    }
  }
  const legacy = bootstrap?.solverNets;
  if (legacy && set.size === 0) {
    for (const entry of Object.values(legacy)) {
      if (entry?.harness) set.add(entry.harness);
    }
  }
  return Array.from(set).sort();
}, [bootstrap]);
```

3. Derive `IdentityCard` props from existing data:

```ts
const primaryServiceId = services.find((s) => s.serviceId !== null)?.serviceId ?? null;
```

4. Replace the main-column body so the children — in document order — are:

```tsx
<div className="flex min-w-0 flex-col gap-6">
  {isEvicted && (
    <EvictionBanner
      serviceId={evictedServiceId}
      onRestake={async (serviceId) => {
        const res = await api.restake(serviceId);
        if (!res.ok) {
          throw new Error(res.error ?? 'Re-stake failed.');
        }
        await queryClient.invalidateQueries({ queryKey: ['status'] });
      }}
    />
  )}

  <IdentityCard
    masterAddress={bootstrap?.master_address ?? null}
    agentAddress={null}
    safeAddress={services[0]?.safeAddress ?? null}
    serviceId={primaryServiceId}
    agentId={services[0]?.agentId ?? null}
    services={services}
  />

  <HarnessStatusPanel harnessNames={harnessNames} />

  <ActivityCard joined={joinedNets} tasks={activityTasks} />
</div>
```

5. Update the `<WalletCard ... />` call in the aside — drop the five removed props:

```tsx
<WalletCard
  totalEth={gasBalanceEth}
  runwayDays={gasRunwayDays}
  actionsDisabled={activeAction !== null}
  perRole={{ master: gasBalanceEth, agent: '—', safe: '—' }}
  tjinnEarned={tjinnEarned}
  tjinnEarnedLast24h={tjinnEarnedLast24h}
  tjinnState={tjinnState}
  tjinnError={tjinnError}
  lastPasswordRotationAt={status?.security?.lastPasswordRotationAt ?? null}
  onTopUp={() => runAction('Top up gas', /* …unchanged… */ )}
/>
```

The `ServiceIdentity[]` derivation can stay (it's used by `IdentityCard`) but `bootstrap?.master_address` is no longer passed to `WalletCard` — only to `IdentityCard`.

- [ ] **Step 4: Run the failing positional test, confirm it passes**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/Overview.test.tsx
```

Expected: all `OverviewPage layout` tests pass, including the new positional test.

- [ ] **Step 5: Run the full SPA vitest**

```bash
cd client && yarn vitest run src/dashboard/spa
```

Expected: green across the dashboard.

- [ ] **Step 6: Run typecheck**

```bash
cd client && yarn typecheck
```

Expected: zero errors. (`WalletCard.tsx` and `Overview.tsx` are both updated; the call site matches the new props.)

- [ ] **Step 7: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.tsx \
        client/src/dashboard/spa/src/pages/Overview.test.tsx
git commit -m "refactor(overview): mount IdentityCard + HarnessStatusPanel above ActivityCard (§2.2, §2.9)"
```

---

### Task 7: Full vitest + typecheck regression sweep

**Files:** none modified — verification only.

**Acceptance criterion link:** AC3 (existing tests still pass).

- [ ] **Step 1: Run the full client test suite**

```bash
cd client && yarn test
```

Expected: green. If anything outside the four touched files fails, fix it in this PR — the failure indicates a missed call site (likely a `WalletCard` consumer in tests/fixtures that still passes the removed props).

- [ ] **Step 2: Run typecheck**

```bash
cd client && yarn typecheck
```

Expected: zero errors.

- [ ] **Step 3: Run the SPA build to confirm the bundle compiles**

```bash
cd client && yarn build:spa
```

Expected: clean Vite output.

- [ ] **Step 4: If a regression surfaced, fix and commit; otherwise no commit.**

If a regression surfaced, add a focused fix commit (e.g. `chore(overview): align <consumer>.test.tsx with WalletCard's slimmed props`).

---

### Task 8: PR

**Files:** none modified.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin refactor/427-operator-app-identity-harness-readiness-buried-under-advance
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base next --title "refactor(operator-app): promote Identity + Harness Readiness (#427, §2.2, §2.9)" --body "$(cat <<'EOF'
## Summary

- Extracts the identity section out of `WalletCard` into a new `IdentityCard` rendered as a first-class /overview surface (§2.2).
- Builds a new `HarnessStatusPanel` that consumes `api.harnessReadiness()` per joined harness and exposes Re-check + Re-authenticate per row (§2.9).
- Slims `WalletCard` to Gas + tJINN + Password.
- Mounts both new cards above `ActivityCard` in the main column; right rail is unchanged.

Closes #427.

## Acceptance criteria

- [x] `<IdentityCard />` renders above the fold on Overview (no expansion required).
- [x] `<HarnessStatusPanel />` renders above the fold on Overview (no expansion required).
- [x] Existing Overview tests still pass; new tests assert the two surfaces are visible without expanding any `<details>` / disclosure.
- [x] No behaviour changes — same data, just promoted in the hierarchy.

## Anchors

- Design note: `docs/superpowers/specs/2026-05-26-issue-427-identity-harness-promotion.md`
- Plan: `docs/superpowers/plans/2026-05-26-issue-427-identity-harness-promotion-plan.md`
- Parent plan (Phase 2 — this PR implements it): `docs/superpowers/plans/2026-05-20-operator-app-spec-alignment.md`
- Spec: `client/OPERATOR-APP-SPEC.md` §2.2, §2.9

## Test plan

- [x] `yarn vitest run src/dashboard/spa/src/pages/overview/IdentityCard.test.tsx`
- [x] `yarn vitest run src/dashboard/spa/src/pages/overview/HarnessStatusPanel.test.tsx`
- [x] `yarn vitest run src/dashboard/spa/src/pages/Overview.test.tsx`
- [x] `yarn vitest run src/dashboard/spa/src/pages/overview/WalletCard.test.tsx`
- [x] `yarn typecheck`
- [x] `yarn test`
- [x] `yarn build:spa`
EOF
)"
```

---

## Risks / non-obvious points

### What could break in existing Overview tests when identity moves out of `WalletCard`

- The current `WalletCard.test.tsx` has three tests that exercise `wallet-section-identity` — they will fail if not deleted (Task 5 deletes them).
- `Overview.test.tsx` has no direct identity-section assertions; the existing layout test references `wallet-card`/`activity-card`/`node-health-card` testIds only — it is augmented in Task 6 rather than gutted.
- Any fixture file or storybook story that constructs `WalletCard` with the now-removed props will fail to typecheck. The repo search at plan-write time turned up no such fixtures, but Task 7's `yarn typecheck` is the gate.
- `Overview.tsx` currently destructures `services` and passes it to `WalletCard`. The variable stays in scope (still consumed by `IdentityCard`) — do not delete the derivation.

### Whether `api.harnessReadiness()` needs new mocks in test fixtures

- `Overview.test.tsx` previously did not mock `api.harnessReadiness` because the page did not call it. Task 6 adds the mock and a `mockReset()` in `beforeEach`. Any existing test that resolves with a missing `harnessReadiness` mock will throw — the `beforeEach` default of `{ ready: true }` keeps the existing tests green even when they do not bother to set a specific response.
- `OverviewPage` only calls `api.harnessReadiness` indirectly via `HarnessStatusPanel`'s per-row query; the call fires once per harness in `bootstrap.joinedSolverNets[*].harness`. Tests with `getBootstrapMock.mockResolvedValue({})` produce zero harness names and zero readiness calls — the empty-state row renders.

### Anything else the design note flagged

- **Spec ambiguity, picked joined-only.** §2.9 says "each supported execution harness" without specifying scope. The design note picks the **joined-only** scope (derive harness names from `bootstrap.joinedSolverNets[*].harness`) because:
  - The §2.9 state messages all describe harnesses the operator is *trying to use*.
  - Enumerating all known harnesses (claude, codex, hermes, prediction-v1-baseline, …) on every operator's /overview creates a wall of "ready: true" rows for harnesses the operator does not care about.
  - If a future spec change demands the full enumeration, the data path is the same — only the iteration source flips from `bootstrap.joinedSolverNets` to a `GET /v1/harnesses` listing.
- **AdvancedDetails is gone — stays gone.** `AdvancedDetails.tsx` was deleted in commit `e47dd57e` (2026-05-21). This plan explicitly does not re-introduce it. If future fields (build sha, runtime flags, raw RPC URL) need a home, the design note maps them to `/operator/network` and `/operator/about` rather than a folded-up /overview disclosure.
- **Visual density.** Stacking two new cards above `ActivityCard` pushes Activity below the viewport on a 768px-tall laptop screen. Accepted: Identity + Harness gate everything else; Activity is already the tallest card; the right rail (Node Health + Wallet) absorbs the at-a-glance read for operators who only want a single screen-full.
- **Ordering — Identity vs Harness on top.** Identity is on top because identity changes rarely (stable address-of-record), Harness changes per auth event (variable); variability sits below stability so the eye lands on the constant first.
- **`api.harnessReadiness()` 404 handling.** Per the comment in `client.ts:248`, a 404 (`harness_not_found`) propagates as a thrown Error with `code === 'harness_not_found'`. `HarnessStatusRow` surfaces this via the `isError` branch which renders an `unavailable` outline badge plus the error message — same row layout, different visual.
- **E2E scope.** `client/test/dashboard/spa.e2e.test.ts` stays untouched. Its current daemon fixture stalls at `awaiting_funding`, so the SPA renders Onboarding, not /overview. Adding a running-mode e2e fixture is materially larger than #427's scope — the positional Overview integration test (Task 6) is the practical substitute for "visible without expanding a `<details>`" and is what acceptance criterion 3 actually pins down in a no-AdvancedDetails world.
