# Operator App — Spec Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the operator app SPA (`client/src/dashboard/spa/`) with the canonical model in [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md) by executing the six highest-leverage moves identified in the 2026-05-20 spec-vs-implementation walk.

**Architecture:** Six independently-shippable phases. Each phase is one mergeable PR with its own GitHub Issue and tests. Phase 1 (Notifications) is foundational — others should be ordered after it. Phases 2–6 can ship in any order once Phase 1 is live.

**Tech stack:** TypeScript + React 18 (SPA), Vitest (component tests), Playwright (E2E), Hono (daemon HTTP), `useEventStream` (SSE; already implemented at `client/src/dashboard/spa/src/api/events.ts`).

**Spec reference:** Every task references the canonical spec by `§N.N` (component) or `§3.N` (cross-cutting). Re-read [`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md) before starting.

**Discipline:**
- TDD for all new code (failing test → minimal implementation → passing test → commit).
- Frequent commits — one logical change per commit, not "phase done."
- Each phase is one PR off `next` per [`docs/engineering/handbook.md`](../../engineering/handbook.md).
- Per-phase work-shape: declare in the GitHub Issue body's `## Run-mode` section. `feat` for Phase 1; `refactor` for Phases 2–5; `chore` for Phase 6.
- Each phase opens its own GitHub Issue first (per AI Workflow Rule 3), framed as **problem, not solution**.

---

## File structure overview

New files (across phases):

```
client/src/dashboard/spa/src/notifications/                    [Phase 1]
  taxonomy.ts                  # canonical 12 categories + OperatorNotification type
  severity.ts                  # Blocking | Warning | Info
  derive.ts                    # deriveNotifications(state) -> OperatorNotification[]
  useNotifications.ts          # hook
  components/
    NotificationsList.tsx      # global panel
    NotificationsList.test.tsx
    NotificationItem.tsx
    NotificationItem.test.tsx

client/src/dashboard/spa/src/pages/overview/                   [Phase 3]
  FundsCard.tsx                # ETH only, per-role drill-down
  FundsCard.test.tsx
  RewardsCard.tsx              # claimable + claimed + claim action
  RewardsCard.test.tsx

client/src/dashboard/spa/src/components/                       [Phase 4]
  EventStreamList.tsx          # shared list reading from useEventStream()
  EventStreamList.test.tsx

client/src/dashboard/spa/src/pages/operator/                   [Phase 5]
  MembershipsTab.tsx           # joined SolverNets editing
  MembershipsTab.test.tsx
  RegistryTab.tsx              # SolverNet registry browse + join
  RegistryTab.test.tsx
  NetworkTab.tsx               # RPC + chain config
  NetworkTab.test.tsx
  SecurityTab.tsx              # password rotation
  SecurityTab.test.tsx
  OperatorSubNav.tsx           # left-rail nav within /operator
  OperatorSubNav.test.tsx
```

Modified files:

```
client/src/dashboard/spa/src/App.tsx                           # add /operator/* routes  [Phase 5]
client/src/dashboard/spa/src/routes.ts                         # extend ROUTES array     [Phase 5]
client/src/dashboard/spa/src/pages/Overview.tsx                # restructure              [Phases 2,3,6]
client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx# strip promoted cards     [Phase 2]
client/src/dashboard/spa/src/pages/overview/HeroStats.tsx      # drop OLAS, slim          [Phase 3]
client/src/dashboard/spa/src/pages/OverviewActivity.tsx        # consume useEventStream() [Phase 4]
client/src/dashboard/spa/src/pages/Operator.tsx                # router shell, not page   [Phase 5]
client/src/dashboard/spa/src/shell/OfflineBanner.tsx           # emit notification        [Phase 1]
client/src/dashboard/spa/src/shell/RestartBanner.tsx           # emit notification        [Phase 1]
client/src/dashboard/spa/src/shell/AppShell.tsx                # mount NotificationsList  [Phase 1]
```

Deleted:

```
client/src/dashboard/spa/src/pages/overview/AlertBand.tsx      # replaced by Notifications [Phase 1]
client/src/dashboard/spa/src/pages/overview/LiveNowBand.tsx    # superseded by Notifications [Phase 6 (depends)]
```

---

## Phase 0: Prep (one-time, per phase)

**Files:** None modified yet.

- [ ] **Step 1: Pull latest `next`**

```bash
git checkout next
git pull --ff-only
```

- [ ] **Step 2: Create the phase's worktree and branch**

Use `superpowers:using-git-worktrees`. Convention: `../jinn-mono_worktrees/<phase-slug>/` with branch `<shape>/<issue-id>-<phase-slug>`.

- [ ] **Step 3: Open the phase's GitHub Issue**

Frame as **problem + acceptance criteria**, not solution. Use the template from [`docs/engineering/handbook.md`](../../engineering/handbook.md) §The shipping machine. Issue title mirrors PR title; `## Run-mode` body declares the shape.

- [ ] **Step 4: Install + build to confirm clean baseline**

```bash
cd client
yarn install --immutable
yarn typecheck
yarn test
```

Expected: all pass on clean `next`.

---

## Phase 1: Notifications surface (§2.10, §3.4, §3.5)

**Why first:** Every other phase benefits from being able to raise notifications through one canonical surface. The `harness_not_ready` warning currently renders three times across `/overview`, `/overview/activity`, and `/operator`; Phase 1 collapses that and unblocks every other phase from inventing its own banners.

**Work shape:** `feat`. New infrastructure, TDD throughout.

**Spec sections covered:** §2.10 (Notifications), §3.4 (derived, not durable), §3.5 (severity).

### Task 1.1: Create the canonical taxonomy + severity types

**Files:**
- Create: `client/src/dashboard/spa/src/notifications/severity.ts`
- Create: `client/src/dashboard/spa/src/notifications/taxonomy.ts`
- Create: `client/src/dashboard/spa/src/notifications/taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/dashboard/spa/src/notifications/taxonomy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANONICAL_KINDS, isCanonicalKind } from './taxonomy.js';

describe('taxonomy', () => {
  it('lists exactly the 12 canonical kinds from OPERATOR-APP-SPEC §2.10', () => {
    expect(CANONICAL_KINDS).toEqual([
      'funding_low',
      'password_rotation_due',
      'harness_not_ready',
      'bootstrap_blocked',
      'service_evicted',
      'restart_required',
      'update_available',
      'rpc_unreachable',
      'no_solvernets_joined',
      'safe_binding_pending',
      'claim_available',
      'claim_failed',
    ]);
  });

  it('isCanonicalKind accepts known kinds and rejects unknown', () => {
    expect(isCanonicalKind('harness_not_ready')).toBe(true);
    expect(isCanonicalKind('made_up_kind')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
cd client && yarn vitest run src/dashboard/spa/src/notifications/taxonomy.test.ts
```

Expected: fail with module not found.

- [ ] **Step 3: Implement severity + taxonomy**

`client/src/dashboard/spa/src/notifications/severity.ts`:

```ts
export const SEVERITIES = ['blocking', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
```

`client/src/dashboard/spa/src/notifications/taxonomy.ts`:

```ts
import type { Severity } from './severity.js';

export const CANONICAL_KINDS = [
  'funding_low',
  'password_rotation_due',
  'harness_not_ready',
  'bootstrap_blocked',
  'service_evicted',
  'restart_required',
  'update_available',
  'rpc_unreachable',
  'no_solvernets_joined',
  'safe_binding_pending',
  'claim_available',
  'claim_failed',
] as const;

export type CanonicalKind = (typeof CANONICAL_KINDS)[number];

export function isCanonicalKind(s: string): s is CanonicalKind {
  return (CANONICAL_KINDS as readonly string[]).includes(s);
}

export interface OperatorNotification {
  kind: CanonicalKind;
  severity: Severity;
  message: string;
  jumpTo?: string; // route path the operator can click to resolve
  details?: Record<string, unknown>;
}
```

- [ ] **Step 4: Run test, confirm pass**

Same command. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/
git commit -m "feat(notifications): canonical taxonomy + severity types per OPERATOR-APP-SPEC §2.10"
```

### Task 1.2: Implement `deriveNotifications` from component state

**Files:**
- Create: `client/src/dashboard/spa/src/notifications/derive.ts`
- Create: `client/src/dashboard/spa/src/notifications/derive.test.ts`

- [ ] **Step 1: Write the failing test**

`client/src/dashboard/spa/src/notifications/derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveNotifications } from './derive.js';

const baseState = {
  bootstrap: { mode: 'running' as const },
  status: {
    funds: { eth: '1.0', runwayDays: 30 },
    rewards: { claimableWei: '0' },
    harness: { ready: true, name: 'claude-code' },
    rpc: { reachable: true },
    restartPending: false,
    daemonVersion: '0.1.5',
    latestVersion: '0.1.5',
    services: [{ evicted: false, safeBound: true }],
    joinedSolverNets: { 'bafkreic-x': {} },
  },
};

describe('deriveNotifications', () => {
  it('returns empty when everything is healthy', () => {
    expect(deriveNotifications(baseState)).toEqual([]);
  });

  it('emits funding_low when runway < 3 days', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, funds: { eth: '0.001', runwayDays: 1 } },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'funding_low',
      severity: 'warning',
    }));
  });

  it('emits harness_not_ready when harness is unavailable', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, harness: { ready: false, name: 'claude-code', reason: 'not authenticated' } },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'harness_not_ready',
      severity: 'blocking',
      message: expect.stringContaining('claude-code'),
    }));
  });

  it('emits no_solvernets_joined when joinedSolverNets is empty', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, joinedSolverNets: {} },
    });
    expect(out.map(n => n.kind)).toContain('no_solvernets_joined');
  });

  it('emits restart_required when restartPending is true', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, restartPending: true },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'restart_required',
      severity: 'warning',
    }));
  });

  it('emits update_available when daemonVersion < latestVersion', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, daemonVersion: '0.1.4', latestVersion: '0.1.5' },
    });
    expect(out.map(n => n.kind)).toContain('update_available');
  });

  it('does not duplicate categories (each canonical kind emits at most once)', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, restartPending: true },
    });
    const kinds = out.map(n => n.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
yarn vitest run src/dashboard/spa/src/notifications/derive.test.ts
```

Expected: fail.

- [ ] **Step 3: Implement `deriveNotifications`**

`client/src/dashboard/spa/src/notifications/derive.ts`:

```ts
import type { OperatorNotification } from './taxonomy.js';

// Loose shape — refine to the concrete BootstrapState + StatusSnapshot types
// when wiring this up in Task 1.4. Kept loose here so the deriver can be tested
// in isolation without dragging the full status schema into the notifications module.
export interface DeriveInput {
  bootstrap: { mode: string; blockingReason?: string };
  status: {
    funds: { eth: string; runwayDays: number };
    rewards: { claimableWei: string };
    harness: { ready: boolean; name: string; reason?: string };
    rpc: { reachable: boolean };
    restartPending: boolean;
    daemonVersion: string;
    latestVersion?: string;
    services: { evicted: boolean; safeBound: boolean }[];
    joinedSolverNets: Record<string, unknown>;
    passwordRotatedAt?: string; // ISO
  };
}

const RUNWAY_LOW_THRESHOLD_DAYS = 3;
const PASSWORD_ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 90;

export function deriveNotifications(input: DeriveInput): OperatorNotification[] {
  const out: OperatorNotification[] = [];
  const s = input.status;

  if (input.bootstrap.mode !== 'running') {
    out.push({
      kind: 'bootstrap_blocked',
      severity: 'blocking',
      message: input.bootstrap.blockingReason ?? 'Bootstrap incomplete',
      jumpTo: '/',
    });
  }

  if (s.funds.runwayDays < RUNWAY_LOW_THRESHOLD_DAYS) {
    out.push({
      kind: 'funding_low',
      severity: 'warning',
      message: `Runway is ${s.funds.runwayDays} day(s). Top up gas to keep claiming work.`,
      jumpTo: '/overview',
    });
  }

  if (!s.harness.ready) {
    out.push({
      kind: 'harness_not_ready',
      severity: 'blocking',
      message: `Harness ${s.harness.name} is not ready${s.harness.reason ? `: ${s.harness.reason}` : ''}.`,
      jumpTo: '/operator/memberships',
    });
  }

  if (!s.rpc.reachable) {
    out.push({
      kind: 'rpc_unreachable',
      severity: 'blocking',
      message: 'RPC endpoint is unreachable.',
      jumpTo: '/operator/network',
    });
  }

  if (Object.keys(s.joinedSolverNets).length === 0 && input.bootstrap.mode === 'running') {
    out.push({
      kind: 'no_solvernets_joined',
      severity: 'info',
      message: 'No SolverNets joined. Browse the registry to start earning.',
      jumpTo: '/operator/registry',
    });
  }

  if (s.services.some(svc => svc.evicted)) {
    out.push({
      kind: 'service_evicted',
      severity: 'blocking',
      message: 'A service has been evicted from staking. Re-stake to resume.',
      jumpTo: '/overview',
    });
  }

  if (s.services.some(svc => !svc.safeBound)) {
    out.push({
      kind: 'safe_binding_pending',
      severity: 'warning',
      message: 'Safe wallet binding is pending.',
      jumpTo: '/overview',
    });
  }

  if (s.restartPending) {
    out.push({
      kind: 'restart_required',
      severity: 'warning',
      message: 'A configuration change is pending — restart to apply.',
      jumpTo: '/overview',
    });
  }

  if (s.latestVersion && s.latestVersion !== s.daemonVersion) {
    out.push({
      kind: 'update_available',
      severity: 'info',
      message: `Daemon ${s.latestVersion} available (running ${s.daemonVersion}).`,
    });
  }

  if (s.passwordRotatedAt) {
    const age = Date.now() - new Date(s.passwordRotatedAt).getTime();
    if (age > PASSWORD_ROTATION_INTERVAL_MS) {
      out.push({
        kind: 'password_rotation_due',
        severity: 'info',
        message: 'Keystore password is over 90 days old.',
        jumpTo: '/operator/security',
      });
    }
  }

  if (BigInt(s.rewards.claimableWei) > 0n) {
    out.push({
      kind: 'claim_available',
      severity: 'info',
      message: 'JINN rewards are claimable.',
      jumpTo: '/overview',
    });
  }

  return out;
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
yarn vitest run src/dashboard/spa/src/notifications/derive.test.ts
```

Expected: all 7 cases pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/derive.ts client/src/dashboard/spa/src/notifications/derive.test.ts
git commit -m "feat(notifications): pure deriver from bootstrap + status snapshot"
```

### Task 1.3: `useNotifications` hook

**Files:**
- Create: `client/src/dashboard/spa/src/notifications/useNotifications.ts`
- Create: `client/src/dashboard/spa/src/notifications/useNotifications.test.tsx`

- [ ] **Step 1: Write the failing test**

`client/src/dashboard/spa/src/notifications/useNotifications.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotifications } from './useNotifications.js';

vi.mock('../api/client.js', () => ({
  api: {
    getStatus: vi.fn().mockResolvedValue({
      funds: { eth: '0.001', runwayDays: 1 },
      rewards: { claimableWei: '0' },
      harness: { ready: true, name: 'claude-code' },
      rpc: { reachable: true },
      restartPending: false,
      daemonVersion: '0.1.5',
      services: [],
      joinedSolverNets: {},
    }),
    getBootstrap: vi.fn().mockResolvedValue({ mode: 'running' }),
  },
}));

describe('useNotifications', () => {
  it('returns derived notifications, ordered blocking-first then warning then info', async () => {
    const { result } = renderHook(() => useNotifications());
    // wait a tick for queries to resolve
    await new Promise(r => setTimeout(r, 50));
    const severities = result.current.map(n => n.severity);
    const expected = [...severities].sort((a, b) => {
      const order = { blocking: 0, warning: 1, info: 2 };
      return order[a] - order[b];
    });
    expect(severities).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
yarn vitest run src/dashboard/spa/src/notifications/useNotifications.test.tsx
```

Expected: fail.

- [ ] **Step 3: Implement the hook**

`client/src/dashboard/spa/src/notifications/useNotifications.ts`:

```ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { deriveNotifications, type DeriveInput } from './derive.js';
import type { OperatorNotification } from './taxonomy.js';

const SEVERITY_ORDER: Record<OperatorNotification['severity'], number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};

export function useNotifications(): OperatorNotification[] {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
    refetchInterval: 5000,
  });
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 5000,
  });

  return useMemo(() => {
    if (!status.data || !bootstrap.data) return [];
    const derived = deriveNotifications({
      bootstrap: bootstrap.data as DeriveInput['bootstrap'],
      status: status.data as DeriveInput['status'],
    });
    return [...derived].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }, [status.data, bootstrap.data]);
}
```

- [ ] **Step 4: Run test, confirm pass**

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/useNotifications.*
git commit -m "feat(notifications): useNotifications hook (queries status + bootstrap, returns sorted)"
```

### Task 1.4: `NotificationsList` component

**Files:**
- Create: `client/src/dashboard/spa/src/notifications/components/NotificationsList.tsx`
- Create: `client/src/dashboard/spa/src/notifications/components/NotificationsList.test.tsx`
- Create: `client/src/dashboard/spa/src/notifications/components/NotificationItem.tsx`

- [ ] **Step 1: Write failing test**

`client/src/dashboard/spa/src/notifications/components/NotificationsList.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotificationsList } from './NotificationsList.js';
import type { OperatorNotification } from '../taxonomy.js';

const notices: OperatorNotification[] = [
  { kind: 'harness_not_ready', severity: 'blocking', message: 'Claude not authenticated', jumpTo: '/operator/memberships' },
  { kind: 'funding_low', severity: 'warning', message: '1 day runway' },
  { kind: 'no_solvernets_joined', severity: 'info', message: 'No SolverNets joined' },
];

describe('NotificationsList', () => {
  it('renders nothing when there are no notices', () => {
    const { container } = render(<NotificationsList notices={[]} />, { wrapper: MemoryRouter });
    expect(container.firstChild).toBeNull();
  });

  it('renders one item per notice, grouped by severity', () => {
    render(<NotificationsList notices={notices} />, { wrapper: MemoryRouter });
    expect(screen.getByText(/claude not authenticated/i)).toBeTruthy();
    expect(screen.getByText(/1 day runway/i)).toBeTruthy();
    expect(screen.getByText(/no solvernets joined/i)).toBeTruthy();
  });

  it('renders the jump-to link only when jumpTo is set', () => {
    render(<NotificationsList notices={notices} />, { wrapper: MemoryRouter });
    expect(screen.getAllByRole('link').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm fails**

```bash
yarn vitest run src/dashboard/spa/src/notifications/components/NotificationsList.test.tsx
```

- [ ] **Step 3: Implement components**

`client/src/dashboard/spa/src/notifications/components/NotificationItem.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { OperatorNotification } from '../taxonomy.js';

export function NotificationItem({ notice }: { notice: OperatorNotification }): JSX.Element {
  return (
    <li
      data-kind={notice.kind}
      data-severity={notice.severity}
      style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}
    >
      <span style={{ textTransform: 'uppercase', fontSize: 11 }}>
        {notice.severity}
      </span>
      <span style={{ flex: 1 }}>{notice.message}</span>
      {notice.jumpTo ? <Link to={notice.jumpTo}>resolve →</Link> : null}
    </li>
  );
}
```

`client/src/dashboard/spa/src/notifications/components/NotificationsList.tsx`:

```tsx
import type { OperatorNotification } from '../taxonomy.js';
import { NotificationItem } from './NotificationItem.js';

export function NotificationsList({ notices }: { notices: OperatorNotification[] }): JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <section aria-label="Notifications" role="region">
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {notices.map((n, i) => (
          <NotificationItem notice={n} key={`${n.kind}-${i}`} />
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

Expected: all three cases pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/notifications/components/
git commit -m "feat(notifications): NotificationsList + NotificationItem components"
```

### Task 1.5: Mount NotificationsList in AppShell

**Files:**
- Modify: `client/src/dashboard/spa/src/shell/AppShell.tsx`
- Modify: `client/src/dashboard/spa/src/shell/AppShell.test.tsx`

- [ ] **Step 1: Add a failing test in AppShell.test.tsx**

Add to existing file:

```tsx
import { useNotifications } from '../notifications/useNotifications.js';
vi.mock('../notifications/useNotifications.js', () => ({
  useNotifications: vi.fn(() => [
    { kind: 'harness_not_ready', severity: 'blocking', message: 'X', jumpTo: '/operator/memberships' },
  ]),
}));

it('mounts NotificationsList with derived notices', () => {
  render(<AppShell {...defaultProps()}><div>child</div></AppShell>);
  expect(screen.getByRole('region', { name: /notifications/i })).toBeTruthy();
  expect(screen.getByText('X')).toBeTruthy();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Wire into AppShell**

In `AppShell.tsx`, above the routed main region:

```tsx
import { NotificationsList } from '../notifications/components/NotificationsList.js';
import { useNotifications } from '../notifications/useNotifications.js';

// inside the component:
const notices = useNotifications();

// in the layout:
<header>{/* existing */}</header>
<NotificationsList notices={notices} />
<TopTabs ... />
<main>...</main>
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/shell/AppShell.*
git commit -m "feat(notifications): mount NotificationsList in AppShell above main"
```

### Task 1.6: Retire the three duplicated `harness_not_ready` banners

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — remove inline "NEEDS ATTENTION" banner
- Modify: `client/src/dashboard/spa/src/pages/OverviewActivity.tsx` — remove inline `NOW · NEEDS ATTENTION`
- Modify: `client/src/dashboard/spa/src/pages/Operator.tsx` — remove inline `NOW · NEEDS ATTENTION`
- Delete: `client/src/dashboard/spa/src/pages/overview/AlertBand.tsx` + its test
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — drop `<AlertBand />` import + usage

- [ ] **Step 1: Update each page's test to assert the inline banner is gone**

For each of `Overview.test.tsx`, `OverviewActivity.test.tsx`, `Operator.test.tsx`:

```tsx
it('does not render an inline NEEDS ATTENTION banner — notifications handle it', () => {
  render(<Page {...withHarnessUnready()} />);
  expect(screen.queryByText(/NEEDS ATTENTION/i)).toBeNull();
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
yarn vitest run src/dashboard/spa/src/pages/
```

- [ ] **Step 3: Remove inline banners + AlertBand**

```bash
git rm client/src/dashboard/spa/src/pages/overview/AlertBand.tsx \
       client/src/dashboard/spa/src/pages/overview/AlertBand.test.tsx
```

In `Overview.tsx`, `OverviewActivity.tsx`, `Operator.tsx`: delete the `NOW · NEEDS ATTENTION` JSX blocks and their conditional imports.

- [ ] **Step 4: Run, confirm tests pass + nothing else broke**

```bash
yarn test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(notifications): retire 3 duplicated NEEDS ATTENTION banners + AlertBand"
```

### Task 1.7: Convert OfflineBanner + RestartBanner to derive-and-emit

Right now `OfflineBanner` and `RestartBanner` render themselves directly. Convert them to push their condition into the notification deriver instead, then delete the standalone components.

**Files:**
- Modify: `client/src/dashboard/spa/src/notifications/derive.ts` — add `rpc_unreachable` (already there) + `restart_required` (already there) inputs from connection-state hook
- Modify: `client/src/dashboard/spa/src/shell/AppShell.tsx` — remove `<OfflineBanner />` and `<RestartBanner />` imports
- Delete: `OfflineBanner.tsx`, `RestartBanner.tsx` and their tests
- Modify: `useNotifications.ts` — extend to pull connection state

- [ ] **Step 1: Failing test**

In `useNotifications.test.tsx`, add a case that simulates dead daemon → `rpc_unreachable` emitted.

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Wire connection-state into the deriver input**

In `useNotifications.ts`, add a third query (or reuse `useConnectionState()`) and feed `status.rpc.reachable` from it.

- [ ] **Step 4: Delete the two standalone banner components + their imports**

```bash
git rm client/src/dashboard/spa/src/shell/OfflineBanner.* client/src/dashboard/spa/src/shell/RestartBanner.*
```

- [ ] **Step 5: Run full test, confirm pass + remove dead imports**

```bash
yarn typecheck && yarn test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(notifications): fold OfflineBanner + RestartBanner into deriver"
```

### Task 1.8: Phase 1 E2E

**Files:**
- Create: `client/test/dashboard/notifications.e2e.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { test, expect } from '@playwright/test';
import { spawnDaemon, mockDaemonApi } from './helpers/index.js';

test.describe('Notifications surface', () => {
  test('harness_not_ready renders once globally, not per-page', async ({ page, context }) => {
    const handshakeUrl = await spawnDaemon();
    await mockDaemonApi(page, {
      status: {
        harness: { ready: false, name: 'claude-code', reason: 'not authenticated' },
        // ...other healthy fields
      },
    });
    await page.goto(handshakeUrl);

    // Overview
    await expect(page.getByText(/claude-code/i)).toHaveCount(1);

    // Activity
    await page.getByRole('link', { name: /activity/i }).click();
    await expect(page.getByText(/claude-code/i)).toHaveCount(1);

    // Operator
    await page.getByRole('link', { name: /settings/i }).click();
    await expect(page.getByText(/claude-code/i)).toHaveCount(1);
  });
});
```

- [ ] **Step 2: Run, confirm pass on the integrated stack**

```bash
yarn build && yarn playwright test test/dashboard/notifications.e2e.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add client/test/dashboard/notifications.e2e.test.ts
git commit -m "test(notifications): single-source-of-truth E2E (no duplication across pages)"
```

### Task 1.9: PR + canonical-doc reference footer

- [ ] **Step 1: Add "Canonical references" footer to any new doc you wrote**

If you added README-style docs alongside the notifications module, end with:

```markdown
---
**Canonical references:** [OPERATOR-APP-SPEC.md](../../../../OPERATOR-APP-SPEC.md) §2.10, §3.4, §3.5
```

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin <branch>
gh pr create --base next --title "feat(operator-app): canonical notifications surface (§2.10)" \
  --body "$(cat <<'EOF'
## Summary

Implements the §2.10 Notifications surface from OPERATOR-APP-SPEC.md as a single, derived-from-state, severity-ordered panel mounted in AppShell. Retires the three duplicated `NOW · NEEDS ATTENTION` banners on /overview, /overview/activity, and /operator, plus the standalone OfflineBanner and RestartBanner.

## Test plan
- [ ] Notifications panel renders only when there are notices
- [ ] `harness_not_ready` appears once globally (E2E)
- [ ] Severity ordering: blocking → warning → info
- [ ] `restart_required` jumps to /overview; `harness_not_ready` jumps to /operator/memberships
EOF
)"
```

---

## Phase 2: Promote Identity (§2.2) and Harness Readiness (§2.9) out of Advanced Details

**Why:** Both are load-bearing — Identity defines who the operator is on-chain; Harness Readiness gates everything they can do. Burying them under `▶ ADVANCED DETAILS` makes them feel optional. The spec models them as first-class components.

**Work shape:** `refactor`. No new functionality — just hierarchy correction.

**Spec sections covered:** §2.2 (Identity), §2.9 (Harness Readiness).

### Task 2.1: Move IdentityCard out of AdvancedDetails

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — render `<IdentityCard />` above the fold
- Modify: `client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx` — drop IdentityCard
- Modify: `client/src/dashboard/spa/src/pages/Overview.test.tsx` + `AdvancedDetails.test.tsx`

- [ ] **Step 1: Failing test in `Overview.test.tsx`**

```tsx
it('renders Identity card at top level, not behind AdvancedDetails', () => {
  render(<Overview {...defaultProps()} />);
  // Identity should be in the DOM before any [details] element opens.
  const details = screen.queryByText(/advanced details/i)?.closest('details');
  expect(details).toBeTruthy();
  // master / agent / Safe labels should be visible without expanding details
  expect(screen.getByText(/master address/i)).toBeTruthy();
  expect(screen.getByText(/agent address/i)).toBeTruthy();
  expect(screen.getByText(/safe address/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Restructure Overview.tsx**

```tsx
// In Overview.tsx — pseudocode for the relevant block:
<section>
  <HeroStats {...heroProps} />
  <div className="card-grid">
    {/* "Process" pane stays inside HeroStats for now — its extraction to a
        dedicated DaemonCard is out of scope for these six phases. */}
    <FundsCard ... />          {/* Phase 3 */}
    <RewardsCard ... />        {/* Phase 3 */}
    <MembershipCard ... />
  </div>
  <IdentityCard {...identityProps} />
  <HarnessStatusPanel {...harnessProps} />
  <RecentActivity ... />
  <AdvancedDetails>
    {/* anything that's actually advanced — RPC raw, build sha, runtime flags */}
  </AdvancedDetails>
</section>
```

In `AdvancedDetails.tsx`, delete the IdentityCard render and its props.

- [ ] **Step 4: Run, confirm pass**

```bash
yarn vitest run src/dashboard/spa/src/pages/Overview.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(overview): promote IdentityCard out of AdvancedDetails (§2.2)"
```

### Task 2.2: Move HarnessStatusPanel out of AdvancedDetails

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx`
- Modify: `client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx`
- Modify: `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx` (create a `*.test.tsx` if missing)

- [ ] **Step 1: Failing test**

```tsx
// in Overview.test.tsx
it('renders HarnessStatusPanel at top level', () => {
  render(<Overview {...defaultProps()} />);
  expect(screen.getByText(/harness/i)).toBeTruthy();
  expect(screen.queryByText(/advanced details/i)?.closest('details')?.contains(screen.getByText(/harness/i)))
    .toBeFalsy();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Move the panel out of AdvancedDetails**

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(overview): promote HarnessStatusPanel out of AdvancedDetails (§2.9)"
```

### Task 2.3: Phase 2 E2E + PR

- [ ] **Step 1: Update existing overview E2E**

Assert Identity + Harness sections are visible without expanding any `<details>`.

- [ ] **Step 2: Push + PR**

```bash
gh pr create --base next --title "refactor(operator-app): promote Identity + Harness Readiness (§2.2, §2.9)"
```

---

## Phase 3: Split the Wallet card into Funds (§2.3) + Rewards (§2.7)

**Why:** The current "Wallet" card on /overview fuses ETH (Funds), JINN claimable (Rewards), and OLAS bond (system-internal, excluded by spec). Spec separates Funds and Rewards into distinct components with distinct lifecycles and actions.

**Work shape:** `refactor`.

**Spec sections covered:** §2.3 (Funds, ETH only), §2.7 (Rewards, with claimable/claimed/history).

### Task 3.1: Create `FundsCard` (ETH only, per-role drill-down)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/FundsCard.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/FundsCard.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FundsCard } from './FundsCard.js';

function defaultProps() {
  return {
    totalEth: '0.0500',
    runwayDays: 5,
    perRole: {
      master: '0.0400',
      agent: '0.0070',
      safe: '0.0030',
    },
    lastPasswordRotationAt: '2026-02-20T00:00:00Z',
    onTopUp: () => undefined,
    onChangePassword: () => undefined,
  };
}

describe('FundsCard', () => {
  it('renders ETH only — no OLAS, no JINN', () => {
    render(<FundsCard {...defaultProps()} />);
    expect(screen.getByText('0.0500')).toBeTruthy();
    expect(screen.queryByText(/OLAS/i)).toBeNull();
    expect(screen.queryByText(/JINN/i)).toBeNull();
  });

  it('renders per-role drill-down on expansion', () => {
    render(<FundsCard {...defaultProps()} />);
    fireEvent.click(screen.getByText(/per role/i));
    expect(screen.getByText('0.0400')).toBeTruthy();
    expect(screen.getByText('0.0070')).toBeTruthy();
    expect(screen.getByText('0.0030')).toBeTruthy();
  });

  it('exposes Top up + Change password actions', () => {
    render(<FundsCard {...defaultProps()} />);
    expect(screen.getByRole('button', { name: /top up/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /change password/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react';

interface Props {
  totalEth: string;
  runwayDays: number;
  perRole: { master: string; agent: string; safe: string };
  lastPasswordRotationAt: string;
  onTopUp: () => void;
  onChangePassword: () => void;
}

export function FundsCard(props: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <article aria-label="Funds">
      <header>FUNDS</header>
      <p>{props.totalEth} ETH · {props.runwayDays}d runway</p>
      <button onClick={() => setOpen(!open)}>per role</button>
      {open && (
        <dl>
          <dt>master</dt><dd>{props.perRole.master}</dd>
          <dt>agent</dt><dd>{props.perRole.agent}</dd>
          <dt>safe</dt><dd>{props.perRole.safe}</dd>
        </dl>
      )}
      <button onClick={props.onTopUp}>Top up</button>
      <button onClick={props.onChangePassword}>Change password</button>
    </article>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(overview): FundsCard component (ETH only, per-role drill-down) §2.3"
```

### Task 3.2: Create `RewardsCard` (claimable + claimed + history teaser)

**Files:**
- Create: `client/src/dashboard/spa/src/pages/overview/RewardsCard.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/RewardsCard.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RewardsCard } from './RewardsCard.js';

const defaultProps = () => ({
  claimableJinn: '12.34',
  claimedJinnLifetime: '100.00',
  lastClaimAt: '2026-05-19T10:00:00Z',
  onClaim: vi.fn(),
});

describe('RewardsCard', () => {
  it('renders claimable + claimed lifetime', () => {
    render(<RewardsCard {...defaultProps()} />);
    expect(screen.getByText(/claimable/i)).toBeTruthy();
    expect(screen.getByText('12.34')).toBeTruthy();
    expect(screen.getByText(/claimed/i)).toBeTruthy();
    expect(screen.getByText('100.00')).toBeTruthy();
  });

  it('Claim button is disabled when claimable is 0', () => {
    render(<RewardsCard {...defaultProps()} claimableJinn="0" />);
    expect(screen.getByRole('button', { name: /claim/i })).toHaveProperty('disabled', true);
  });

  it('does not render ETH or OLAS', () => {
    render(<RewardsCard {...defaultProps()} />);
    expect(screen.queryByText(/ETH/i)).toBeNull();
    expect(screen.queryByText(/OLAS/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Implement**

`client/src/dashboard/spa/src/pages/overview/RewardsCard.tsx`:

```tsx
interface Props {
  claimableJinn: string;       // formatted decimal, e.g. "12.34"
  claimedJinnLifetime: string; // formatted decimal
  lastClaimAt: string | null;
  onClaim: () => void;
}

export function RewardsCard(props: Props): JSX.Element {
  const canClaim = parseFloat(props.claimableJinn) > 0;
  return (
    <article aria-label="Rewards">
      <header>REWARDS</header>
      <dl>
        <dt>claimable</dt>
        <dd>{props.claimableJinn} JINN</dd>
        <dt>claimed (lifetime)</dt>
        <dd>{props.claimedJinnLifetime} JINN</dd>
        {props.lastClaimAt ? (
          <>
            <dt>last claim</dt>
            <dd><time dateTime={props.lastClaimAt}>{props.lastClaimAt}</time></dd>
          </>
        ) : null}
      </dl>
      <button onClick={props.onClaim} disabled={!canClaim}>Claim</button>
    </article>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(overview): RewardsCard component (claimable + claimed lifetime) §2.7"
```

### Task 3.3: Replace Wallet in `Overview.tsx`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — replace wallet card with `<FundsCard />` + `<RewardsCard />`
- Modify: `client/src/dashboard/spa/src/pages/overview/HeroStats.tsx` — drop JINN-claimable + OLAS lines if those still live here

- [ ] **Step 1: Failing test in `Overview.test.tsx`**

```tsx
it('renders Funds and Rewards as separate cards, no Wallet, no OLAS', () => {
  render(<Overview {...defaultProps()} />);
  expect(screen.getByRole('region', { name: /funds/i })).toBeTruthy();
  expect(screen.getByRole('region', { name: /rewards/i })).toBeTruthy();
  expect(screen.queryByText(/wallet/i)).toBeNull();
  expect(screen.queryByText(/OLAS/i)).toBeNull();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Swap Wallet card for FundsCard + RewardsCard; delete OLAS code paths**

- [ ] **Step 4: Run, confirm pass + nothing else broke**

```bash
yarn test
```

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(overview): replace Wallet with FundsCard + RewardsCard; remove OLAS"
```

### Task 3.4: Phase 3 E2E + PR

- [ ] **Step 1: E2E walks /overview and asserts neither OLAS nor JINN appears under Funds**

- [ ] **Step 2: PR**

```bash
gh pr create --base next --title "refactor(overview): split Wallet into Funds + Rewards (§2.3, §2.7)"
```

---

## Phase 4: Render the real event stream on /overview/activity (§3.3)

**Why:** `useEventStream` exists in production code ([api/events.ts](../../../client/src/dashboard/spa/src/api/events.ts)) but zero running-mode pages consume it. Activity shows polled `status.activity.recent` snapshots instead of the real SSE feed. Spec §3.3: streams across components share a single event vocabulary; we should have at least one component reading it.

**Work shape:** `refactor` (replacing polled with streamed).

### Task 4.1: `EventStreamList` shared component

**Files:**
- Create: `client/src/dashboard/spa/src/components/EventStreamList.tsx`
- Create: `client/src/dashboard/spa/src/components/EventStreamList.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventStreamList } from './EventStreamList.js';
import type { StructuredEvent } from '../api/types.js';

const events: StructuredEvent[] = [
  { id: '1', ts: '2026-05-20T11:45:38Z', kind: 'intent', message: 'CLAIMED', details: { requestId: '0xabc' } },
  { id: '2', ts: '2026-05-20T11:44:45Z', kind: 'system', message: 'STARTUP', details: {} },
];

describe('EventStreamList', () => {
  it('renders one row per event with timestamp, kind, message', () => {
    render(<EventStreamList events={events} />);
    expect(screen.getByText(/CLAIMED/i)).toBeTruthy();
    expect(screen.getByText(/STARTUP/i)).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBe(2);
  });

  it('renders empty state when no events', () => {
    render(<EventStreamList events={[]} />);
    expect(screen.getByText(/no events/i)).toBeTruthy();
  });

  it('filters by kind when filterKind prop set', () => {
    render(<EventStreamList events={events} filterKind="intent" />);
    expect(screen.queryByText(/STARTUP/i)).toBeNull();
    expect(screen.getByText(/CLAIMED/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Implement**

```tsx
import type { StructuredEvent } from '../api/types.js';

interface Props {
  events: StructuredEvent[];
  filterKind?: string;
}

export function EventStreamList({ events, filterKind }: Props): JSX.Element {
  const filtered = filterKind ? events.filter(e => e.kind === filterKind) : events;
  if (filtered.length === 0) {
    return <p>No events.</p>;
  }
  return (
    <ul>
      {filtered.map(e => (
        <li key={e.id}>
          <time>{e.ts}</time> <code>{e.kind}</code> {e.message}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(components): EventStreamList shared component (§3.3)"
```

### Task 4.2: Wire `useEventStream` into `OverviewActivity`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/OverviewActivity.tsx`
- Modify: `client/src/dashboard/spa/src/pages/OverviewActivity.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { vi } from 'vitest';
vi.mock('../api/events.js', () => ({
  useEventStream: vi.fn(() => ({
    events: [{ id: '1', ts: '2026-05-20T11:45:38Z', kind: 'intent', message: 'CLAIMED', details: {} }],
    connected: true,
  })),
}));

it('renders the real SSE stream, not the polled snapshot', async () => {
  render(<OverviewActivity />);
  expect(await screen.findByText(/CLAIMED/i)).toBeTruthy();
  // No reliance on status.activity.recent
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Replace polled recent with `useEventStream`**

In `OverviewActivity.tsx`:

```tsx
import { useEventStream } from '../api/events.js';
import { EventStreamList } from '../components/EventStreamList.js';

export function OverviewActivity(): JSX.Element {
  const { events, connected } = useEventStream();
  return (
    <section>
      <h1>Activity</h1>
      <p data-testid="stream-status">{connected ? 'live' : 'disconnected'}</p>
      <h2>In flight</h2>
      {/* ... in-flight section reads from useQuery on /v1/status — keep that polled */}
      <h2>Recent</h2>
      <EventStreamList events={events} />
    </section>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(activity): consume useEventStream — replace polled status.activity.recent"
```

### Task 4.3: E2E + PR

- [ ] **Step 1: Playwright E2E**

Mock `/v1/events` SSE → assert events appear in real-time, no flicker from polling.

- [ ] **Step 2: PR**

```bash
gh pr create --base next --title "refactor(activity): render real SSE event stream (§3.3)"
```

---

## Phase 5: Decompose `/operator` into sub-routes per spec component

**Why:** `/operator` currently bundles five spec components (Memberships, Registry, Network, Security, Data Donation) into one route with collapsible sections. Spec wants each as its own component. Sub-routes give each one a stable URL and let the page own one concern.

**Work shape:** `refactor`. Routing change.

**Spec sections covered:** §2.4 Memberships, §2.5 Registry, §2.11 Settings (Network), Funds (password — Security), §2.13 (Artifact Serving — Data Donation as optional).

### Task 5.1: Routes scaffold + redirect

**Files:**
- Modify: `client/src/dashboard/spa/src/App.tsx`
- Modify: `client/src/dashboard/spa/src/routes.ts`

- [ ] **Step 1: Failing test**

In `App.routing.test.tsx`:

```tsx
it('exposes /operator/memberships, /operator/registry, /operator/network, /operator/security', () => {
  expect(ROUTES.find(r => r.path === '/operator/memberships')).toBeTruthy();
  expect(ROUTES.find(r => r.path === '/operator/registry')).toBeTruthy();
  expect(ROUTES.find(r => r.path === '/operator/network')).toBeTruthy();
  expect(ROUTES.find(r => r.path === '/operator/security')).toBeTruthy();
});

it('redirects bare /operator to /operator/memberships', () => {
  render(<MemoryRouter initialEntries={['/operator']}><App /></MemoryRouter>);
  expect(screen.getByTestId('memberships-tab')).toBeTruthy();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Add routes + redirect**

In `App.tsx`, replace the current `/operator` route with:

```tsx
<Route path="/operator" element={<OperatorShell />}>
  <Route index element={<Navigate to="memberships" replace />} />
  <Route path="memberships" element={<MembershipsTab />} />
  <Route path="registry" element={<RegistryTab />} />
  <Route path="network" element={<NetworkTab />} />
  <Route path="security" element={<SecurityTab />} />
  <Route path="execution-data" element={<ExecutionData />} />
  <Route path="join/:cid" element={<JoinFlow />} />
</Route>
```

In `routes.ts`, add the four new paths.

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(operator): scaffold sub-routes + index redirect"
```

### Task 5.2: `OperatorSubNav` sidebar

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator/OperatorSubNav.tsx`
- Create: `client/src/dashboard/spa/src/pages/operator/OperatorSubNav.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it('renders one nav link per spec-aligned tab, with active indicator on current route', () => {
  render(<OperatorSubNav />, { wrapper: ({ children }) => <MemoryRouter initialEntries={['/operator/network']}>{children}</MemoryRouter> });
  expect(screen.getByRole('link', { name: /memberships/i })).toBeTruthy();
  expect(screen.getByRole('link', { name: /registry/i })).toBeTruthy();
  expect(screen.getByRole('link', { name: /network/i })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: /security/i })).toBeTruthy();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Implement**

```tsx
import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/operator/memberships', label: 'Memberships' },
  { to: '/operator/registry', label: 'Registry' },
  { to: '/operator/network', label: 'Network' },
  { to: '/operator/security', label: 'Security' },
];

export function OperatorSubNav(): JSX.Element {
  // react-router-dom v6 sets aria-current="page" automatically on active NavLinks.
  return (
    <nav aria-label="Operator sections">
      <ul>
        {TABS.map(t => (
          <li key={t.to}>
            <NavLink to={t.to}>{t.label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(operator): OperatorSubNav sidebar"
```

### Tasks 5.3 – 5.6: Extract each tab

Each tab repeats the same shape, but the source component differs. Existing source mapping (confirmed in the 2026-05-20 SPA walk):

| Task | New tab file | Source to extract from | Renders |
|------|--------------|------------------------|---------|
| 5.3  | `pages/operator/MembershipsTab.tsx` | `pages/configuration/SolverNetsSection.tsx` (JOINED block + `JoinedNetCard`) | Joined SolverNets editing |
| 5.4  | `pages/operator/RegistryTab.tsx`    | `pages/configuration/SolverNetsSection.tsx` (DISCOVER block + `RegistryCatalog`) | SolverNet registry browse + join |
| 5.5  | `pages/operator/NetworkTab.tsx`     | `pages/configuration/NetworkSection.tsx`  | RPC + chain settings |
| 5.6  | `pages/operator/SecurityTab.tsx`    | `pages/configuration/SecuritySection.tsx` | Keystore password rotation |

**Files per task:**
- Create: `client/src/dashboard/spa/src/pages/operator/<TabName>.tsx`
- Create: `client/src/dashboard/spa/src/pages/operator/<TabName>.test.tsx`
- Modify: `client/src/dashboard/spa/src/pages/Operator.tsx` — strips the moved block; becomes the `OperatorShell` rendering `<OperatorSubNav />` + `<Outlet />` after all four extractions land

Per tab, repeat (using `MembershipsTab` as the worked example — substitute names for 5.4–5.6):

- [ ] **Step 1: Failing test in `pages/operator/MembershipsTab.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MembershipsTab } from './MembershipsTab.js';

const joined = [{ name: 'SWE-rebench v2', manifestCid: 'bafkreic-shpi', roles: ['solver','evaluator'], harness: 'hermes-agent' }];

it('renders the JOINED list only — no Network, Security, or Discover blocks', () => {
  render(<MembershipsTab joined={joined} />, { wrapper: MemoryRouter });
  expect(screen.getByText(/SWE-rebench v2/)).toBeTruthy();
  expect(screen.queryByText(/network/i)).toBeNull();
  expect(screen.queryByText(/security/i)).toBeNull();
  expect(screen.queryByText(/discover/i)).toBeNull();
});
```

- [ ] **Step 2: Run, confirm fails**

```bash
yarn vitest run src/dashboard/spa/src/pages/operator/MembershipsTab.test.tsx
```

- [ ] **Step 3: Extract**

Move the `JOINED · N` block out of `SolverNetsSection.tsx` into `MembershipsTab.tsx` verbatim — same JSX, same props. Strip the block from `SolverNetsSection.tsx`. Delete `SolverNetsSection.tsx` after both 5.3 and 5.4 land (it's now empty).

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(operator): extract MembershipsTab from SolverNetsSection"
```

For Tasks 5.4 / 5.5 / 5.6, swap names and source per the table above. The shape is identical: failing test → mechanical extraction → passing test → commit.

### Task 5.7: Move Data Donation under Artifact Serving (§2.13 Optional)

**Files:**
- Delete: existing data-donation block from `MembershipsTab` (the legacy /operator sprawl)
- Modify: `client/src/dashboard/spa/src/pages/Operator.tsx` → fold into `/operator/execution-data` page (which already exists)

- [ ] **Step 1: Failing test**

```tsx
// in OperatorRouting.test.tsx
it('Data donation toggle lives on /operator/execution-data, not on /operator/memberships', () => {
  render(<MemoryRouter initialEntries={['/operator/memberships']}><App /></MemoryRouter>);
  expect(screen.queryByText(/data donation/i)).toBeNull();
  // ... and now navigate to /operator/execution-data and assert it IS visible there
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Move the donation toggle to ExecutionData page**

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(operator): consolidate Data Donation under Artifact Serving §2.13"
```

### Task 5.8: PR

```bash
gh pr create --base next --title "refactor(operator): decompose /operator into spec-aligned sub-routes (§2.4, §2.5, §2.11, §2.13)"
```

---

## Phase 6: Retire BEHAVIOUR / Drifting banner + spawn follow-up

**Why:** The BEHAVIOUR banner on /overview shows the `participation health` derived metric — explicitly removed from the spec in the 2026-05-20 ratification (§2.4). It also surfaces output stats ("20 solutions, 0 verdicts in 26 tasks") that have no spec home. Either the spec acquires a "Performance" component or the banner retires; the spec hasn't been amended, so retire and file a follow-up.

**Work shape:** `chore`.

### Task 6.1: Delete the banner

**Files:**
- Delete: `client/src/dashboard/spa/src/pages/overview/LiveNowBand.tsx` + its test
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx` — remove `<LiveNowBand />` reference

- [ ] **Step 1: Failing test in `Overview.test.tsx`**

```tsx
it('does not render the BEHAVIOUR / Drifting banner (participation health removed from spec)', () => {
  render(<Overview {...defaultProps()} />);
  expect(screen.queryByText(/behaviour/i)).toBeNull();
  expect(screen.queryByText(/drifting/i)).toBeNull();
});
```

- [ ] **Step 2: Run, confirm fails**

- [ ] **Step 3: Delete + remove imports**

```bash
git rm client/src/dashboard/spa/src/pages/overview/LiveNowBand.*
```

- [ ] **Step 4: Run, confirm pass + nothing else broke**

```bash
yarn typecheck && yarn test
```

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(overview): retire BEHAVIOUR/Drifting banner — participation health removed from spec"
```

### Task 6.2: File follow-up Issue for "Performance / Output Stats" spec extension

Open a GitHub Issue (not in this plan's PR):

> **Title:** Should OPERATOR-APP-SPEC.md gain a "Performance / Output Stats" component?
>
> **Body:** The retired BEHAVIOUR banner surfaced aggregate output metrics ("20 solutions, 0 verdicts in 26 tasks") that have no current spec home. Open question: are these worth a first-class component, or should they continue to be inferable from the activity stream + claimed-rewards? If first-class: propose §2.14 with static/streams/actions/state-messages axes. If not: close.

### Task 6.3: PR

```bash
gh pr create --base next --title "chore(overview): retire BEHAVIOUR banner (§2.4 ratification)"
```

---

## Sequencing & dependency notes

- **Phase 1 must ship first.** Phases 2, 3, 5, 6 each depend on the Notifications surface existing so their cleanup of inline banners doesn't regress state-message coverage.
- **Phases 2 and 3 can ship in either order**, both touch `Overview.tsx`. If shipped in parallel, the second one rebases on the first.
- **Phase 4 is fully independent** — touches only `OverviewActivity.tsx`.
- **Phase 5 is the biggest** — bundles four sub-route extractions and a data-donation relocation. Consider splitting into 5a (routes scaffold + Memberships) and 5b (Registry + Network + Security + Data Donation) if reviewers find it unwieldy.
- **Phase 6 is the smallest** — file ~15 lines + test. Lands last so its retirement is the final visible change.

## Per-PR canonical-doc reference footer

Any markdown doc added or modified by these phases (READMEs in new modules, ADRs if you write them) ends with:

```markdown
---
**Canonical references:** [OPERATOR-APP-SPEC.md](../../../../OPERATOR-APP-SPEC.md) §<sections>
```

This makes downstream drift greppable per [`spec/2026-04-28-canonical-docs.md`](../../../spec/2026-04-28-canonical-docs.md) §Drift policy.

## Definition of done (whole plan)

- [ ] Phases 1–6 all merged to `next`.
- [ ] `useEventStream` is consumed by at least one running-mode page.
- [ ] No inline `NEEDS ATTENTION` / state-message banner exists outside `client/src/dashboard/spa/src/notifications/`.
- [ ] `/overview` does not render OLAS or JINN in a "Wallet" card; Funds and Rewards are distinct.
- [ ] `IdentityCard` and `HarnessStatusPanel` render above the fold on `/overview`.
- [ ] `/operator/memberships`, `/operator/registry`, `/operator/network`, `/operator/security` resolve to distinct, single-concern pages.
- [ ] BEHAVIOUR / Drifting banner is gone; follow-up Issue exists for the open spec question.
- [ ] All Vitest + Playwright suites green on each phase's PR.
- [ ] Each canonical-doc-touching PR cites a GitHub Discussion (none of these phases should touch canonical root docs; if any does, the Discussion gate applies per [`spec/2026-04-28-canonical-docs.md`](../../../spec/2026-04-28-canonical-docs.md)).
