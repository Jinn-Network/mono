# Cutover Stage 6 — Headless Console and F1 Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the operator human surface from the daemon-served SPA to a separate Next.js console that consumes the versioned read/control contract, then retire leftover application routes, extract the three named kits, and run the breaking F1 identity rename last. Tracking issue: [#2727](https://github.com/Jinn-Network/mono/issues/2727).

**Architecture:** Stacked trains into `next`. Contract gaps and remote-access gates land before the first console HTTP call. CloudEvents SSE lands while the SPA still exists, in the same PR that updates `operator/src/dashboard/spa/src/api/events.ts`. SPA departure is a strangler: console e2e is green and the two gate scripts are re-pointed before the SPA and `resolveDashboardDir()` are deleted. Extractions wait until the console is a second consumer. F1 is last.

**Tech Stack:** TypeScript / Node 22 / Yarn 4.13.0; vitest; Playwright; Hono; Zod v4; Next.js App Router 16 + shadcn/ui (match `apps/website`); GitHub Actions.

## Global Constraints

- Branch target: `next`. Merge-only cascade; never rebase the stack.
- Depends on Stage 5 merged (`67f068208`). Daemon tree is `operator/`.
- Design is law: `docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md` (ratified by DR-2026-08-04-b even though the file header still says Proposed — Task 6 fixes the header) and composition design §10 stage-6 row.
- DR-2026-08-05 decision 5: never a green-less e2e commit. `e2e:app-flow` and `e2e:funding-sequence` stay green at every merge.
- American English. Dated historical docs are not retro-edited.
- Topology files only via `node .github/scripts/generate-architecture.mjs`.
- Human CODEOWNER review on `/operator/` and `/apps/operator-console/`. No agent self-merge.
- Plugin C9 / `core`–`layer`–`plugin` portal is out. #2709 stays open. Leftover census rows `marketplace-pipeline` (migrating) and `legacy-task-submission-synthesis` (planned) are not flipped. Never rename `packages/discovery/client`. F2 CI job names (`client-compat`) stay even during F1.
- No fleet console, no OLAS fleet-ops extraction, no keystore packaging, no protocol-surface change (headless §16).
- Every task ends with the named tests run locally; outputs shown.

## Stacked PRs

| PR | Branch | Train |
| --- | --- | --- |
| 1 | `claude/stage6-pr1-contract` | Train 0 — §8 close-out |
| 2 | `claude/stage6-pr2-readplane` | Train 1a — CloudEvents SSE + Last-Event-ID |
| 3 | `claude/stage6-pr3-remote-cli` | Train 1b — §9 remote-access + control CLI twins |
| 4 | `claude/stage6-pr4-console` | Train 2 — `apps/operator-console` |
| 5 | `claude/stage6-pr5-e2e-spa` | Train 3 — re-home e2e, stop serving SPA |
| 6 | `claude/stage6-pr6-retire-routes` | Train 4 — retire application routes |
| 7 | `claude/stage6-pr7-extract` | Train 5 — kits 2, 3, 5 |
| 8 | `claude/stage6-pr8-f1` | Train 6 — F1 identity |

Each child merges its parent. Never rebase.

## Baseline assumptions (verify before Task 1)

1. Stage 5 has landed on `next`: `operator/` is the daemon tree; top-level `client/` is gone from git; `packages/discovery/client` remains.
2. §8 artifacts 2, 5, 6 are done. Artifact 1 is partial (status stamped; notifications not). Artifact 4 exists as `yarn release:tier-1:T1.3` but is not in `.github/workflows/release-tier-1.yml`. Artifact 3 is the console (Train 2).
3. §11 / §14 "now" bucket is landed. Do not re-open unless a task's census finds a hole.
4. Support/earning loops stay. Re-derivation is surface-only (console + CLI consume the contract).

## Findings carried into this plan (proposed dispositions)

- **F-notifications-version.** `GET /v1/notifications` stamps `schemaVersion: 1` only. *Disposition: Task 2 stamps `CURRENT_CONTRACT_VERSION`. Additive; SPA may ignore the extra field.*
- **F-T1.3-ci.** T1.3 exists and is boot-less, but `release-tier-1.yml` runs only T1.1 + T1.2. *Disposition: Task 5 adds T1.3 as the first (cheapest) step. T1.3 also gains a notifications producer assertion in Task 4.*
- **F-unknown-kind-title.** Contract comments say render unknown kinds from `severity` + `title`. `NotificationItem` renders `severity` + `message` and never displays `title`. Events `eventKindMeta` already prefers `wire.title`. *Disposition: Task 3 makes `NotificationItem` show `title` (message remains supporting copy) so an unknown kind is legible from envelope fields.*
- **F-sse-vocab.** `GET /v1/events` emits in-memory `StructuredEvent` (`intent`/`reward`/`fleet`/…). Spec §6.4 mints CloudEvents types from `LIFECYCLE_KINDS`. SPA `useEventStream` (`dashboard/spa/src/api/events.ts`) opens EventSource `/v1/events` with `withCredentials: true`. *Disposition: Task 7–8 rewrite the operator-contract SSE to LifecycleKind CloudEvents + `Last-Event-ID`. The structured ring stays private for `claim_failed` counting. Same PR updates `useEventStream`. Dual-emit is rejected.*
- **F-cors-cross-origin.** Next.js console on `:3000` talking to daemon `:7331` is cross-origin. Today's `cors()` is wildcard; handshake sets a cookie. *Disposition: Task 9 lands §9 before Train 2. Cookie remains local convenience; contract is header token. No `Access-Control-Allow-Credentials`.*
- **F-token-path.** `defaultTokenPath()` uses `homedir() + '.jinn-client'`, not daemon state. `rotateUiToken()` is unwired. UI-token compare is `!==`. No `expiresAt`. *Disposition: Task 9–10.*
- **F-cli-twins.** `jinn policy show` and `jinn wiring list|show` are read-only. No `jinn restart`. `jinn auth` does not rotate the UI token. *Disposition: Task 11.*
- **F-leftover-application.** One-swap left launcher / solvernets / captures HTTP, `/api/agent/ws`, and SPA launcher pages mounted. Join HTTP is gone. *Disposition: they dissolve in Task 17; they do not move to the console. Recensus at Task 17 start.*
- **F-dead-on-arrival.** Unmounted `leaderboard-api.ts`, `not_implemented` loop pause/resume, route-less `updateHarnessMode`, `'live-closure-validated'` until a verifier exists. *Disposition: delete in Task 17.*
- **F-spec-status.** Headless spec header still says Proposed. DR-2026-08-04-b ratified it. *Disposition: Task 6.*

## File structure

**Train 0 (modified):** `operator/src/api/contract/notifications.ts`, `operator/src/api/notifications-endpoint.ts`, `operator/test/api/notifications-endpoint.test.ts`, `operator/src/dashboard/spa/src/notifications/components/NotificationItem.tsx` (+ test), `operator/test/release/tier-1/T1.3-contract-conformance.ts`, `.github/workflows/release-tier-1.yml`, `docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md`, `operator/openapi.v1.json` (regen).

**Train 1a (new):** `operator/src/api/contract/lifecycle-cloudevents.ts` — kebab map + CE schema. **Modified:** `events-endpoint.ts`, SPA `api/events.ts`, events tests.

**Train 1b (new):** `operator/src/intents/claim-policy-write.ts`, `operator/src/intents/execution-wiring-write.ts`, `operator/src/intents/restart.ts`, `operator/src/cli/commands/restart.ts`; auth rotate subverb. **Modified:** `ui-token.ts`, `handshake.ts`, `server.ts` CORS, config schema for `apiInsecureRemote` / CORS origins / trusted proxy, `cli/commands/auth.ts`, `cli/commands/policy.ts`, `cli/index.ts`.

**Train 2 (new tree):** `apps/operator-console/` (Next.js + shadcn). OPERATOR-APP-SPEC migrates here. CODEOWNERS render dirs.

**Train 3:** console Playwright specs; re-point `operator/package.json` scripts; then delete SPA + static serve.

**Train 4:** delete leftover application routes listed in Task 17 census.

**Train 5:** three packages + guard trio + in-tree fake kit each.

**Train 6:** npm / OCI / homedir rename with compat window.

---

### Task 1: Record leftover-application census (this document)

Already executed against `origin/next` @ `67f068208`. Do not re-litigate. If a later train's recensus disagrees, treat the new grep as truth and amend the task, not the design.

**Still mounted (dissolve, do not port):**

- `addLauncherRoutes` — `operator/src/api/launcher-endpoints.ts`
- `addSolverNetsRoutes` — `operator/src/api/solvernets-endpoint.ts` (and `solvernets-endpoints.ts`)
- `addCapturesRoutes` — `operator/src/api/captures.ts`
- `ws /api/agent/ws` — `operator/src/agent/agent-ws.ts`
- SPA pages: `Launcher`, `LauncherCreate`, `LauncherLaunched`, `operator-catalog`, `leaderboard/`, `/captures`, `/build`

**Already gone:** `POST/DELETE /v1/operator/join/:cid`

**Keep (not console-owned):** `POST /api/stop-hook` (gated), `POST /artifacts` + `POST /v1/artifacts/acquire` (MCP bearer).

- [ ] **Step 1: Confirm the mounts still exist before Train 4**

```bash
git grep -n 'addLauncherRoutes\|addSolverNetsRoutes\|addCapturesRoutes\|/api/agent/ws' -- operator/src/api/server.ts operator/src/agent
```

Expected: the four hits above, until Task 17 deletes them.

- [ ] **Step 2: Commit is this plan file**

```bash
git add docs/superpowers/plans/2026-08-16-cutover-stage-6-headless-console.md
git commit -m "$(cat <<'EOF'
docs(cutover): add Stage 6 headless-console implementation plan

The dated plan sequences contract close-out, remote-access gates, the
operator console, SPA strangler, leftover-route retirement, kit
extraction, and the F1 identity rename.

EOF
)"
```

---

### Task 2: Stamp `contractVersion` on notifications

**Files:**
- Modify: `operator/src/api/contract/notifications.ts`
- Modify: `operator/src/api/notifications-endpoint.ts`
- Modify: `operator/test/api/notifications-endpoint.test.ts`
- Test: same test file, plus regen `operator/openapi.v1.json`

**Interfaces:**
- Consumes: `contractVersionSchema`, `CURRENT_CONTRACT_VERSION` from `operator/src/api/contract/version.ts`
- Produces: `notificationsV1ResponseSchema` includes `contractVersion: { major, minor }`

- [ ] **Step 1: Write the failing test**

In `operator/test/api/notifications-endpoint.test.ts`, extend the envelope test:

```typescript
    const body = await res.json() as {
      schemaVersion: number;
      generatedAt: string;
      notifications: unknown[];
      contractVersion?: { major: number; minor: number };
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.contractVersion).toEqual({ major: 1, minor: 0 });
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd operator && yarn vitest run test/api/notifications-endpoint.test.ts
```

Expected: FAIL — `contractVersion` is undefined.

- [ ] **Step 3: Minimal implementation**

`notifications.ts` — import `contractVersionSchema` and add it to the envelope:

```typescript
import { contractVersionSchema } from './version.js';

export const notificationsV1ResponseSchema = z.looseObject({
  schemaVersion: z.literal(1),
  contractVersion: contractVersionSchema,
  generatedAt: z.string(),
  notifications: z.array(notificationSchema),
});
```

`notifications-endpoint.ts` — stamp the constant on both 200 and 500 bodies:

```typescript
import { CURRENT_CONTRACT_VERSION } from './contract/version.js';

const body: NotificationsV1Response = {
  schemaVersion: 1,
  contractVersion: CURRENT_CONTRACT_VERSION,
  generatedAt: new Date(nowMs).toISOString(),
  notifications,
};
```

Error path: same `contractVersion` field so a failed gather still handshakes.

This is additive (`minor` stays 0 unless the team treats a required new field as breaking — it is required on a previously-unversioned envelope, so bump **minor** only if status already advertised 1.0 as "every read payload". Status is the handshake source of truth at 1.0; adding the field to notifications is completing artifact 1, not a new contract generation. Keep `{1, 0}`).

- [ ] **Step 4: Regen OpenAPI and pass tests**

```bash
cd operator && yarn generate:openapi && yarn vitest run test/api/notifications-endpoint.test.ts test/release/tier-1/T1.3-contract-conformance.test.ts
```

Expected: PASS. T1.3 OpenAPI freshness will fail until the regen is committed — that is intended.

- [ ] **Step 5: Commit**

```bash
git add operator/src/api/contract/notifications.ts operator/src/api/notifications-endpoint.ts operator/test/api/notifications-endpoint.test.ts operator/openapi.v1.json
git commit -m "$(cat <<'EOF'
fix(operator): stamp contractVersion on GET /v1/notifications

Complete §8 artifact 1 for the notifications envelope so a console
handshake can see the same version the status payload already carries.

EOF
)"
```

---

### Task 3: Unknown-kind rendering shows `title`

**Files:**
- Modify: `operator/src/dashboard/spa/src/notifications/components/NotificationItem.tsx`
- Modify: `operator/src/dashboard/spa/src/notifications/components/NotificationItem.test.tsx`

**Interfaces:**
- Consumes: `NotificationV1.title` (already required on the wire)
- Produces: visible `title`; `message` remains; unknown `kind` still sets `data-kind` and never drops the row

- [ ] **Step 1: Write the failing test**

Add to `NotificationItem.test.tsx`:

```typescript
  it('renders an unknown kind from envelope title and severity rather than dropping the row', () => {
    const notice: OperatorNotification = {
      kind: 'brand_new_kind_from_newer_daemon',
      severity: 'warning',
      title: 'New daemon notice',
      message: 'A kind this build does not know.',
    };
    const { container } = render(wrap(<NotificationItem notice={notice} />));
    const li = container.querySelector('li');
    expect(li?.getAttribute('data-kind')).toBe('brand_new_kind_from_newer_daemon');
    expect(screen.getByText('New daemon notice')).toBeTruthy();
    expect(screen.getByText('A kind this build does not know.')).toBeTruthy();
  });
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd operator && yarn vitest run src/dashboard/spa/src/notifications/components/NotificationItem.test.tsx
```

Expected: FAIL — `New daemon notice` is not in the document (only `message` is).

- [ ] **Step 3: Minimal implementation**

In the `<li>`, keep the severity chip, then render `notice.title` as the primary text and `notice.message` as the supporting span. Do not map `kind` to copy.

- [ ] **Step 4: Run tests**

```bash
cd operator && yarn vitest run src/dashboard/spa/src/notifications/components/NotificationItem.test.tsx
```

Expected: PASS. Existing tests that match `message` in `aria-label` stay green (keep message in the aria-label).

- [ ] **Step 5: Commit**

```bash
git add operator/src/dashboard/spa/src/notifications/components/NotificationItem.tsx operator/src/dashboard/spa/src/notifications/components/NotificationItem.test.tsx
git commit -m "$(cat <<'EOF'
fix(operator): render notification title for unknown kinds

Honor the §8 unknown-kind rule: a kind this build does not know still
renders from envelope title and severity instead of being dropped.

EOF
)"
```

---

### Task 4: T1.3 asserts notifications `contractVersion`

**Files:**
- Modify: `operator/test/release/tier-1/T1.3-contract-conformance.ts`

**Interfaces:**
- Consumes: `notificationsV1ResponseSchema`, `CURRENT_CONTRACT_VERSION`
- Produces: Phase 5 that parses a notifications envelope fixture (not a tautology on a hand-built `contractVersion` — stamp via the same constant the producer uses, and parse)

Because `addNotificationsRoutes` needs a Hono app + store, assert the **schema** requires `contractVersion` by parsing a payload that omits it (must throw) and one that includes `CURRENT_CONTRACT_VERSION` (must pass). That is not a producer tautology: a schema that forgot the field accepts the omit.

- [ ] **Step 1: Write the failing assertion** (will pass after Task 2; if Task 2 is not merged yet this is the red)

```typescript
    log('Phase 5: notifications envelope requires contractVersion');
    const { notificationsV1ResponseSchema } = await import('../../../src/api/contract/notifications.js');
    const omitted = notificationsV1ResponseSchema.safeParse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      notifications: [],
    });
    if (omitted.success) {
      throw new Error('notificationsV1ResponseSchema accepted a payload without contractVersion');
    }
    const stamped = notificationsV1ResponseSchema.parse({
      schemaVersion: 1,
      contractVersion: CURRENT_CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      notifications: [],
    });
    if (stamped.contractVersion.major !== CURRENT_CONTRACT_VERSION.major) {
      throw new Error('notifications contractVersion did not round-trip');
    }
```

- [ ] **Step 2–4: Run `yarn release:tier-1:T1.3` — expect PASS after Task 2**

- [ ] **Step 5: Commit with Task 2 if same PR, else its own commit**

---

### Task 5: Wire T1.3 into release-tier-1.yml

**Files:**
- Modify: `.github/workflows/release-tier-1.yml`

T1.3 is boot-less (no Anvil, no `yarn build`). Run it **before** T1.2.

- [ ] **Step 1: Add the step** (workflow YAML; no unit test — verify by reading the file)

```yaml
      - name: T1.3 — read-contract conformance
        run: yarn release:tier-1:T1.3
```

Place after `yarn install`, before `yarn build` (T1.3 does not need `dist/`). Update the workflow `name:` and the job `name:` to mention T1.3.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release-tier-1.yml
git commit -m "$(cat <<'EOF'
ci: run T1.3 contract conformance in release-tier-1

The scenario already existed and is boot-less; leaving it uninvoked let
the read contract rot between release-prep runs.

EOF
)"
```

---

### Task 6: Ratify the headless spec header

**Files:**
- Modify: `docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md` lines 4–7 only

- [ ] **Step 1: Change Status**

From `Proposed — awaiting operator approval` to `Ratified (DR-2026-08-04-b)`. Version line: drop `(proposed; …)` parenthetical; keep v0.2 and the review-log pointer.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md
git commit -m "$(cat <<'EOF'
docs: mark headless operator spec ratified

DR-2026-08-04-b already ratified the design; the file header was stale.

EOF
)"
```

Train 0 PR is Tasks 1–6 on `claude/stage6-pr1-contract`.

---

### Task 7: Lifecycle CloudEvents + Last-Event-ID

**Files:**
- Create: `operator/src/api/contract/lifecycle-cloudevents.ts`
- Create: `operator/test/api/lifecycle-cloudevents.test.ts`
- Create: `operator/test/api/events-endpoint.test.ts` (extend if one exists)
- Modify: `operator/src/api/events-endpoint.ts`

**Interfaces:**
- Produces:

```typescript
export function lifecycleKindToKebab(kind: LifecycleKind): string;
export function lifecycleCloudEventType(kind: LifecycleKind): `network.jinn.operator-lifecycle.${string}.v1`;
export const operatorLifecycleCloudEventSchema: z.ZodType<OperatorLifecycleCloudEvent>;
export interface OperatorLifecycleCloudEvent {
  specversion: '1.0';
  id: string;
  source: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  type: string; // network.jinn.operator-lifecycle.<kebab>.v1
  data: {
    kind: string; // original snake kind, or unknown string
    title: string;
    severity: 'info' | 'success' | 'warning' | 'error' | 'neutral';
    message: string;
    detail?: Record<string, unknown>;
  };
}
```

`subject` is the operator/service URI. `source` is the daemon instance URI. Envelope follows TEP observation profile field names (`specversion`, `datacontenttype` required) without importing TEP's 11 task-execution types.

SSE:

- Honor `Last-Event-ID` (header) as the resume cursor against the lifecycle activity stream (the SQLite `activity_events` id, stringified). If the store is unavailable, resume from the in-memory mapping of the same ids — do not silently restart from "last 50" when the header is present and the id is unknown; emit from the next known id or an empty backfill plus a comment `id-not-in-buffer`.
- `id:` SSE field = the resume cursor.
- `data:` = JSON CloudEvent. Do not set a custom `event:` name (SPA `onmessage` only fires for default/`message`).
- Query `?kinds=` filters by snake `LifecycleKind`, not kebab.

The private `StructuredEvent` ring (`events/emitter.ts`) is **unchanged** (notifications `claim_failed` still reads it).

- [ ] **Step 1: Failing tests** for kebab (`task_posted` → `task-posted` → type `network.jinn.operator-lifecycle.task-posted.v1`), unknown kind still produces a CE with `data.title` required, and SSE resume: second request with `Last-Event-ID` of the first event does not re-send it.

- [ ] **Step 2: Run tests — expect FAIL** (module missing).

- [ ] **Step 3: Implement schema + endpoint.**

- [ ] **Step 4: Tests pass.**

- [ ] **Step 5: Commit** `feat(operator): emit lifecycle CloudEvents SSE with Last-Event-ID`.

---

### Task 8: SPA `useEventStream` consumes CloudEvents

**Files:**
- Modify: `operator/src/dashboard/spa/src/api/events.ts`
- Modify: `operator/src/dashboard/spa/src/regions/LoadingScreen.tsx` if it depends on `StructuredEvent` fields
- Test: add `events.test.ts` next to `events.ts` or extend LoadingScreen tests

Parse `msg.data` as `OperatorLifecycleCloudEvent`. Keep `connected`. Drop `withCredentials` (Task 9 will forbid credentialed CORS; Train 1a can stop sending cookies on this EventSource now — header auth for EventSource is awkward, so local SPA may keep cookie until Task 9; **do not add `withCredentials` on the console**). For the SPA-in-same-origin window, cookie still works.

If LoadingScreen only needs `connected`, it must not crash when `data` is a CE.

- [ ] **Steps 1–5:** failing test that a CE payload is accepted; implement; `yarn vitest run` on the spa events tests; commit `fix(operator): parse lifecycle CloudEvents in useEventStream`.

Train 1a PR is Tasks 7–8.

---

### Task 9: Remote-access gates (§9)

**Files:**
- Modify: `operator/src/api/server.ts` (CORS, bind, non-loopback gate)
- Modify: `operator/src/api/handshake.ts` (`timingSafeEqual`; cookie `secure` when attested TLS)
- Modify: `operator/src/config.ts` / shape-v2: `apiInsecureRemote: boolean` (default false), `apiCorsOrigins: string[]` (default `['http://127.0.0.1:3000', 'http://localhost:3000']`), `apiTrustedProxies: string[]` (default empty)
- Test: `operator/test/api/remote-access.test.ts`

**Rules (all in one PR with Task 10 so CORS cannot ship without the token gates):**

1. Operator-class response to a non-loopback peer requires `X-Forwarded-Proto: https` from a declared trusted proxy **or** `apiInsecureRemote: true`. Otherwise 403 `{ error: 'remote_access_disabled' }`.
2. CORS: `origin` allowlist from config; **no** `Access-Control-Allow-Credentials`.
3. Loopback (`127.0.0.1`, `::1`) is always allowed.

- [ ] **Step 1: Failing tests** — request with `Host`/`X-Forwarded-For` simulating a public peer and no opt-in → 403; with `apiInsecureRemote: true` → 200 on `/v1/status` given a valid token; CORS `Access-Control-Allow-Origin` echoes an allowlisted origin and does not send `Access-Control-Allow-Credentials: true`.

- [ ] **Steps 2–5:** implement, pass, commit `fix(operator): gate non-loopback operator-class access`.

---

### Task 10: Token file, expiry, rotate, timingSafeEqual

**Files:**
- Modify: `operator/src/api/ui-token.ts`
- Modify: `operator/src/cli/commands/auth.ts`
- Modify: `operator/src/cli/index.ts` if a new verb is registered
- Test: `operator/test/api/ui-token.test.ts`, CLI auth tests

**Interfaces:**

```typescript
export function defaultTokenPath(stateDir?: string): string;
// default: join(stateDir ?? join(homedir(), '.jinn-client'), 'ui-token')
// Resolution order for readers: process.env.JINN_UI_TOKEN, else the file.

export interface UiTokenRecord {
  token: string;
  expiresAt: string; // RFC3339
}
export function ensureUiToken(path?: string, now?: () => Date): string;
export function rotateUiToken(path?: string, now?: () => Date): string;
export function readUiTokenRecord(path?: string): UiTokenRecord | null;
```

On-disk format becomes JSON `{ token, expiresAt }` with mode 0600. Readers accept the legacy raw-hex file for one minor: if the file is a 64-char hex line, treat as unexpired and rewrite JSON on next `ensureUiToken`. Expiry default: 30 days. Expired token fails `requireUiToken` with 401.

`requireUiToken` compares with `timingSafeEqual` on equal-length buffers (if lengths differ, fail closed without throwing).

`jinn auth rotate` (daemon-down OK) calls `rotateUiToken()` and prints the token once. Pairing intent: `jinn auth token` prints the current token (or rotates if missing) without requiring the daemon.

- [ ] **Steps 1–5:** failing tests for expiry, legacy-file rewrite, rotate, timing-safe compare; implement; commit `fix(operator): expire and rotate the UI token`.

---

### Task 11: Control-route CLI twins

**Files:**
- Create: `operator/src/intents/claim-policy-write.ts`, `operator/src/intents/execution-wiring-write.ts`, `operator/src/intents/restart.ts`
- Modify: `operator/src/cli/commands/policy.ts` (add `set` subverb), `wiring.ts` (add `set`), new `restart.ts`, `cli/index.ts`
- Modify: `operator/src/api/claim-policy-endpoints.ts` and `admin-endpoint.ts` to call the new intents (routes stay thin)
- Test: intent unit tests + `operator/test/architecture/api-cli-boundary.test.ts` still forbids `cli/commands` imports from `src/api/`

`jinn restart` POSTs `/api/admin/restart` when daemon-up (token header); daemon-down it is a no-op error `daemon_not_running` (the existing stop/pidfile path is not a restart). Do not have the HTTP route import the CLI module.

`jinn policy set` writes claim-policy via the same intent the PUT route uses. `jinn wiring set` likewise.

- [ ] **Steps 1–5:** red tests that the PUT handlers import from `intents/` not `cli/commands/`; implement; commit `feat(operator): add claim-policy, wiring, and restart CLI twins`.

Train 1b PR is Tasks 9–11.

---

### Task 12: Console scaffold + handshake (artifact 3)

**Files (create):**

```
apps/operator-console/package.json          # @jinn-network/operator-console, private, yarn 4.13.0, next 16
apps/operator-console/tsconfig.json
apps/operator-console/next.config.ts        # no rewrite that would proxy around the token
apps/operator-console/app/layout.tsx
apps/operator-console/app/page.tsx          # handshake gate then Overview
apps/operator-console/lib/contract-version.ts  # CONSOLE_CONTRACT_VERSION = { major: 1, minor: 0 }
apps/operator-console/lib/daemon.ts         # fetch with x-jinn-ui-token; base URL from env JINN_OPERATOR_URL default http://127.0.0.1:7331
apps/operator-console/lib/handshake.ts      # GET /v1/status, compare contractVersion
apps/operator-console/components/IncompatibleContract.tsx
apps/operator-console/OPERATOR-APP-SPEC.md  # git mv from operator/OPERATOR-APP-SPEC.md
```

Leave a stub at `operator/OPERATOR-APP-SPEC.md` that is a one-line pointer to the new path (live operational doc, not a historical rewrite).

**Handshake rules:**

- major mismatch → full-page incompat UI, no further fetches.
- server minor < console minor → warn banner, continue.
- server minor > console minor → warn banner (unknown additive fields), continue.
- `/health` and `/ready` are not the handshake (they omit `contractVersion` by design).

shadcn + DESIGN.md tokens. No emoji. No helper-text cruft. CODEOWNERS:

```
/apps/operator-console/app/        @oaksprout @ritsukai
/apps/operator-console/components/ @oaksprout @ritsukai
```

- [ ] **Step 1: Failing test** `apps/operator-console/lib/handshake.test.ts` — `{major:2,minor:0}` vs console `{1,0}` → `incompatible`; `{1,0}` → `ok`.

- [ ] **Steps 2–5:** implement; `yarn --cwd apps/operator-console test`; commit `feat(console): scaffold operator console with contract handshake`.

Do not fetch the daemon until Task 9 is on the same stack.

---

### Task 13: Inherited console surfaces

Port, do not lift-and-shift. Pages:

- Overview (bootstrap / funding / rewards as projections of `/v1/status` + `/v1/rewards` + `/v1/bootstrap`)
- Events (CE SSE + `/v1/activity-events` read)
- Notifications (`GET /v1/notifications`; unknown kinds via Task 3 rule)
- Claim policy + execution wiring (GET + PUT)
- Network, Security
- Read-only posting view (`/v1/status` posting projection — no mutating posting routes)

**Not ported:** Launcher, captures UI, agent WS, leaderboard, fleet view.

Match OPERATOR-APP-SPEC axes (State / Streams / Actions / State messages) in the migrated spec. Amend the spec in the same PR as the pages.

- [ ] **Steps 1–5:** one failing test per page that the route renders the empty/loading/error states; implement with shadcn; commit `feat(console): port inherited operator surfaces`.

Train 2 PR is Tasks 12–13.

---

### Task 14: Console e2e asserting the same mutations

**Files:**
- Create: `apps/operator-console/e2e/claim-policy-flow.e2e.ts`, `apps/operator-console/e2e/posting-status.e2e.ts`, `apps/operator-console/e2e/funding-sequence.e2e.ts`
- Keep existing SPA specs passing

Mirror `operator/test/dashboard/claim-policy-flow.e2e.test.ts`, `posting-status.e2e.test.ts`, `funding-sequence.e2e.test.ts` against the console origin. Same mutations, same assertions.

- [ ] **Steps 1–5:** author specs; run them against a daemon + `next start`; commit `test(console): add claim-policy, posting-status, and funding e2e`.

---

### Task 15: Re-point `e2e:app-flow` and `e2e:funding-sequence`

**Files:**
- Modify: `operator/package.json` scripts (or a root helper that the CI already invokes)

After Task 14 is green, point the two script names at the console specs. Leave SPA spec files on disk until Task 16.

- [ ] **Step 1:** change the scripts; run both; expect PASS on console.
- [ ] **Step 2: Commit** `ci: re-point app-flow and funding-sequence e2e onto the console`.

---

### Task 16: Stop serving the SPA

**Files:**
- Delete: `operator/src/dashboard/spa/` (the app)
- Delete: SPA e2e specs under `operator/test/dashboard/*.e2e.test.ts` that target the SPA
- Modify: `operator/src/api/server.ts` — remove `resolveDashboardDir`, `GET /`, `GET /assets/*`; `GET /` returns 404 JSON `{ error: 'no_human_surface' }`
- Modify: `DEPLOY.md` — daemon/SPA same-origin ruling superseded by headless §9
- Modify: handbook paired-flow runbook pointer (`.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md` → a console scenario; do not retro-edit dated plans)

- [ ] **Steps 1–5:** after scripts already point at console, delete SPA; `yarn typecheck` in operator; commit `refactor(operator): stop serving the dashboard SPA`.

Train 3 PR is Tasks 14–16 (14+15 can land first so 16 never voids the gates).

---

### Task 17: Retire leftover application routes

Recensus at train start (`git grep` the Task 1 list). Delete:

- launcher HTTP + SPA leftovers if any remain
- solvernets HTTP
- captures HTTP (CLI `jinn capture` remains)
- `/api/agent/ws`
- `leaderboard-api.ts`
- admin loop pause/resume stub
- `updateHarnessMode` if still referenced
- `'live-closure-validated'` from the readiness union until a verifier exists

Keep stop-hook and artifact MCP routes.

- [ ] **Steps 1–5:** failing test that `server.ts` source no longer contains `addLauncherRoutes`; delete; typecheck; commit `refactor(operator): retire leftover application routes`.

Train 4 PR is Task 17.

---

### Task 18: Extract notification derivation (kit 2)

Second consumers: console + CLI + (alerting later). Move `buildNotifications` + kinds constants to a package (e.g. `packages/operator-notifications/`) with:

1. allowlist source-boundary guard
2. frozen dependency direction
3. no product-naming identifiers in tier-3 code
4. in-tree fake proving the kit

Operator and console import the package. Guard trio under `.github/scripts/`.

- [ ] **Steps 1–5:** failing inventory guard expecting the new package; extract; `node --test` the guards; commit `refactor: extract operator notification derivation kit`.

---

### Task 19: Extract read-plane kit (kit 3)

Health/ready, freshness middleware, SSE tail helpers, auth-in-constructor, payload classes, OpenAPI generation. Same guard-trio+kit discipline. Indexer health/ready is a partial precedent, not a copy-paste.

- [ ] **Steps 1–5:** analogous to Task 18. Commit `refactor: extract operator read-plane kit`.

---

### Task 20: Extract receipt containers (kit 5)

Class O/A profile + `writeObservation()`. Lives next to trust core (`packages/trust/` or a sibling). Small.

- [ ] **Steps 1–5.** Commit `refactor: extract receipt container kit`.

Train 5 PR may split 18/19/20 as stacked children if diffs are large.

---

### Task 21: F1 breaking identity (last)

**Locked names** (compat window, then Monday named-cut hard drop):

- npm: `@jinn-network/operator` (keep `jinn` bin; `client` bin aliases then drops)
- OCI: `ghcr.io/jinn-network/operator`, dual-push `ghcr.io/jinn-network/client` during the window
- State dir: `~/.jinn-operator`, read-fallback from `~/.jinn-client` if the new path is empty; honor `JINN_STATE_DIR` / `JINN_EARNING_DIR`

**Never:** rename `packages/discovery/client` or `@jinn-network/record-discovery-client`. **Never:** rename F2 job ids.

- [ ] **Step 1: Recensus blast radius**

```bash
git grep -l '@jinn-network/client' | wc -l
git grep -l 'ghcr.io/jinn-network/client' | wc -l
git grep -l '.jinn-client' | wc -l
git grep -n 'packages/discovery/client' | head
```

- [ ] **Step 2: Homedir fallback test** — empty `~/.jinn-operator` + populated `~/.jinn-client` → daemon reads the old dir and logs one line that a future run will copy forward.
- [ ] **Step 3: Dual-publish canary** — `npm-publish.yml` publishes both names during the window; `docker.yml` tags both images.
- [ ] **Step 4: Drop window** is a later Monday cut, not this PR, unless the recensus shows zero external installers. This PR lands the new names + fallback.
- [ ] **Step 5: Commit** `refactor(operator): rename published identity to @jinn-network/operator`.

Train 6 PR is Task 21.

---

## Spec coverage (self-review)

| Spec requirement | Task |
| --- | --- |
| §8 artifact 1 remaining stamp | 2, 4 |
| §8 artifact 3 handshake | 12 |
| §8 artifact 4 in release tiers | 5 |
| §8 unknown-kind | 3 |
| §6 CloudEvents + Last-Event-ID | 7, 8 |
| §9 remote-access | 9, 10 |
| §4.1 / §10 CLI twins | 11 |
| §9 console + inherited surfaces | 12, 13 |
| §13 e2e re-home | 14, 15, 16 |
| §4.2 application-route dissolve | 17 |
| §12 kits 2, 3, 5 | 18, 19, 20 |
| F1 identity | 21 |
| §16 non-goals / plugin C9 / #2709 / leftover rows | Global Constraints |

## Out of this plan

- Plugin C9 portal
- #2709 `legacyManifestDigest`
- Flipping leftover census rows
- Fleet console, OLAS fleet-ops extraction, keystore packaging
- Hosted/Vercel console deploy
- Changing F2 protection-context job names
