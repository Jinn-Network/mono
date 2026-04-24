# Explorer — Jinn UI Kit

The on-chain read-only browser for the Jinn network. Canonical surface for viewing the ether: recent wishes, their seers, the smoke, and the scrying (logs).

## Components

- `Chrome.jsx` — `Logo`, `TopNav`, `SearchBox`, `StatusBar`
- `Data.jsx` — `StatusChip`, `KPI`, `KPIRow`, `WishRow`, `TableHead`
- `WishDetail.jsx` — `WishDetail` right-pane scrying view

## Interactions implemented

- Filter wishes by state (`all / smoke / bound / wane / broken`)
- Select a wish to load its detail pane and scrying log
- All buttons styled, hover states live. No real backend.

## Screens covered

1. Ether overview (KPIs + recent wishes) — the default view
2. Wish detail / scrying — right-pane master-detail
3. Search (UI only — ⌘K hint shown, not wired)

Other surfaces (Vessels, Seers, Ether tabs) render a placeholder — the brief says omit or placeholder if not explicitly designed. They're nav entries only.
