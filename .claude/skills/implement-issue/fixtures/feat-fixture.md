Issue Type: feat | Effort: Medium

Title: Format lastClaimAt as a human-readable date in RewardsCard

**Context.** `client/src/dashboard/spa/src/pages/overview/RewardsCard.tsx` renders the `lastClaimAt` ISO timestamp verbatim inside a `<time>` element:

```tsx
<time dateTime={lastClaimAt} style={{ color: 'var(--fg-muted)' }}>
  {lastClaimAt}
</time>
```

When `lastClaimAt` is `'2026-05-19T10:00:00Z'`, the dashboard shows the raw string `2026-05-19T10:00:00Z` instead of a human-readable representation. The `FundsCard` at `client/src/dashboard/spa/src/pages/overview/FundsCard.tsx` has the same pattern for `lastPasswordRotationAt`. Both fields are operator-facing status information — showing machine strings is a paper cut that makes the dashboard harder to read at a glance.

The `liveNowState.ts` module already contains a `formatTimeOfDay` helper that converts an ISO timestamp to `HH:MM`. A suitable approach for the Rewards and Funds cards would be a slightly richer format: e.g. `19 May · 10:00` or relative formatting (`3 days ago`) — whichever is clearest and fits the mono compact style.

**Impact.** Every operator who has claimed JINN rewards sees an opaque UTC string on the primary dashboard view. For most operators this is the first and only date they see on the Overview page, making the UX worse than a simple "never" fallback.

**Acceptance criteria.**
- [ ] After the change, when `RewardsCard` receives `lastClaimAt='2026-05-19T10:00:00Z'`, the rendered text inside the `<time>` element is not the raw ISO string — it is a formatted date string that a non-technical operator can read without parsing (e.g. `19 May · 10:00` or `3 days ago`).
- [ ] The `RewardsCard.test.tsx` unit test file includes at least one test asserting that a non-null `lastClaimAt` does not render the raw ISO string and does render a human-readable alternative; this test passes under `yarn test` run from `client/`.

**Files/components.** `client/src/dashboard/spa/src/pages/overview/RewardsCard.tsx` (the `<time>` element at line 135–137), `client/src/dashboard/spa/src/pages/overview/RewardsCard.test.tsx` — operator-visible dashboard SPA surface.
