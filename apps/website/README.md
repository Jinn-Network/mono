# apps/website — jinn.network

The Jinn landing page. One static file, no build step, no framework.

- `index.html` — the whole site.
- **Deploy:** Vercel CLI from this directory — `vercel deploy --prod` (team `jinn-a6b5fa9d`, project `jinn-website`). `jinn.network` and `www.jinn.network` are attached to that project. There is no git integration; deploys are manual.
- **Copy** derives from the [platform one-pager](../../docs/positioning/2026-07-29-jinn-platform-one-pager.md); check any copy change against it before shipping. Design spec: [2026-07-30-jinn-website-redesign-design.md](../../docs/superpowers/specs/2026-07-30-jinn-website-redesign-design.md). Primary CTA: the Telegram group; the explorer and GitHub carry the evidence links.
- **Live numbers:** one inline script fetches counts from `GET https://jinn-indexer-production.up.railway.app/explorer/network` (the endpoint the explorer uses). It renders a metric only when its value is above zero, and falls back to a plain "Watch the network live" explorer link on any failure — no zeros, no spinners.
- **Domain model** (per the frontend spec rule): one read-only page. State — the live network counts (render-or-omit). State messages — none; the fetch-failure state is expressed structurally, not as a message. Collections — none. Actions — outbound links only (Telegram, explorer, GitHub), no lifecycle.
- **Stack deviation, deliberate:** plain static HTML, not Next.js + shadcn. A single-page brochure with no state doesn't justify an app framework; revisit if it grows beyond one page.
