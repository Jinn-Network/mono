# apps/website — jinn.network

The Jinn landing page. One static file, no build step, no framework.

- `index.html` — the whole site.
- **Deploy:** Vercel CLI from this directory — `vercel deploy --prod` (team `jinn-a6b5fa9d`, project `jinn-website`). `jinn.network` and `www.jinn.network` are attached to that project. There is no git integration; deploys are manual.
- **Copy** derives from the [positioning spine](../../docs/positioning/2026-07-07-jinn-positioning-spine.md); check any copy change against it (and `GROWTH.md` §3) before shipping. Single CTA: the Telegram group.
- **Domain model** (per the frontend spec rule, stated for completeness): one read-only page; no state, no collections; one action — the outbound Telegram link (no lifecycle).
- **Stack deviation, deliberate:** this is plain static HTML, not Next.js + shadcn. A single-page brochure with zero state doesn't justify an app framework; revisit if it grows beyond one page.

Design source: Claude Design handoff "Jinn.network landing page" (bet-first hero variant), implemented 2026-07-07.
