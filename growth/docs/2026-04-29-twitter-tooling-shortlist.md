# Twitter tooling shortlist for @oaksprout

29 April 2026. Stress-tested shortlist of agent tools (skills, MCPs, APIs, patterns) to maximise exposure on Oak's personal handle. Sequenced by leverage, not by category.

The algorithm playbook (`2026-04-10-x-algorithm-playbook.md`) names the actions. This doc names the tools that make those actions cheap. No new strategy — only execution leverage.

---

## What's already on the bench

- **Typefully MCP** — connected. Drafts, scheduling, queue, follower + post analytics, cross-post to LinkedIn/Threads. The drafting and scheduling layer is solved.
- **`oak-content-strategy` skill** — voice, mental models, thematic anchors, content-generation process. Pulls Typefully RSS at start.
- **`marketing` plugin skills** — `draft-content`, `brand-review`, `email-sequence`, `competitive-brief`, etc. Generic, but `brand-review` is reusable as a tone gate.
- **`brand-voice` plugin** — `enforce-voice`, `generate-guidelines`. Useful only once a hard voice doc exists; `oak-content-strategy` is currently filling that role.
- **`bird` CLI** — referenced in `find-open-twitter-convos-agentic-ai-gap.md`. Already used to search tweets from terminal. Provenance unclear — confirm what API key it sits on (likely the limiter when scaling).
- **The find-open-conversations prompt** — already-written gold. Not yet a skill.

The gap is not "another writing tool". The gap is **execution surface for the reply game** and **fast feedback on what's working**.

---

## Install-now (this week)

### 1. A Twitter/X read+post MCP

Typefully posts; it doesn't *read* the timeline, mentions, replies, or run searches inside Cowork. To run the reply game from a Claude session, you need read access.

Three open-source options, ranked:

- **`0xGval/twitter-X-mcp-server`** — natural-language search with Twitter operators (user, date, engagement filters). Lightweight, exactly the surface needed for "find me 5 open conversations on X" loops.
- **`nirholas/XActions`** — fuller toolkit (scrape + actions, no API fees, browser-based). More power, more surface area to misuse. Useful if you want analytics scraping without paying API costs.
- **`EnesCinr/twitter-mcp`** / **`rafaljanicki/x-twitter-mcp-server`** — post + search via official API. Smithery install. Cleanest, costs API credits.

Recommendation: start with `0xGval/twitter-X-mcp-server` for read, keep posting on Typefully. Avoids action-side automation that the algorithm penalises.

### 2. Black Magic ($7.99/mo)

The cheap, sharp Twitter analytics + social CRM. Tracks who engages with you over time, smart-follower segmentation, time-of-day heatmaps. The "smart followers matter more than count" insight in your playbook is operationalised here. Founder-built, not enterprise bloat. Cheaper than ilo.so and more useful for the reply game specifically.

### 3. X Premium Basic ($8/mo)

Already flagged in the playbook as table stakes. 4–8x reach multiplier, Premium replies surface above non-Premium. Binary lever. If not already on, do this before anything else.

### 4. Productionise the find-conversations prompt as a skill

Convert `growth/prompts/find-open-twitter-convos-agentic-ai-gap.md` into a Cowork skill that takes (a) a take/thesis snippet and (b) a time window, and returns 5 ranked open conversations. Run it during the 14:00 switching block. Pair with the Twitter MCP above so it doesn't depend on `bird`.

This is the single highest-leverage build. Reply quality drives 70–80% of cold-start growth on small accounts; you already do this manually.

### 5. A scheduled task: morning + afternoon reply briefing

Use the `schedule` skill. Two runs:

- **08:30** — overnight mentions, who engaged with last 48h posts, what's hot in your interest cluster (LunarCrush feed if installed, otherwise the Twitter MCP).
- **14:00** — output of the find-conversations skill, plus any unanswered replies on your own posts (the +75 "author replies back" signal).

Outputs land in chat at the start of each block. No new threads, just queued action.

---

## High-leverage skills to build (small, weekend-sized)

These are not standalone products — they're prompts that sit in your skills folder and run inside Cowork. They turn the playbook's actions into one-line invocations.

- **`hook-stress-test`** — takes a draft tweet, returns 5 hook variants using the 4-part formula (Bold / Tension / Twist / Credibility), grades each on first-3-second clarity. Stress-test gate before queueing.
- **`thread-shaper`** — takes a long-form take, returns a 7–10 tweet thread with the structure: hook, paradox, mechanism, stakes, proof, position, open question. Pairs with `oak-content-strategy` for voice.
- **`reply-shaper`** — takes a target tweet + your angle, returns one substantive reply in your voice. Refuses "Great point!" replies. Adds a callback to your prior work where the connection is real.
- **`pre-publish-lint`** — runs before queueing in Typefully: checks for external links in main post (move to reply), emoji, hashtag stuffing, near-duplicate of recent post, negative-tone signals (Grok punishes combative tone now). One-screen output.
- **`engagement-debrief`** — daily, runs at 16:00. Pulls Typefully analytics + Twitter MCP impressions for the last 24h, identifies top performer + bottom performer, names the single thing that explains the gap. Feeds tomorrow's queue.

Build order: `pre-publish-lint` → `hook-stress-test` → `engagement-debrief` → `reply-shaper` → `thread-shaper`. Lint and stress-test pay back fastest because they prevent waste at the top of the funnel.

---

## Medium leverage

- **LunarCrush MCP** (free tier exists). Real-time crypto/AI social signals, creator and topic time-series. Use for newsjacking and to surface rising AI/crypto narratives before they peak. Particularly strong fit for your beachhead (Prediction SolverNet → token outcomes). Connect when newsjacking becomes a deliberate cadence, not before.
- **Apify MCP** — generic scraping platform with Tweet Scraper V2 at ~$0.50/1000 tweets. Useful if you want competitive listening (track 50 target accounts' best posts/month) outside the official API. Set up only when you have a defined research question — otherwise it becomes data hoarding.
- **`ahrefs:brand-radar`** (already in plugin set) — tracks brand mentions across the web, including LLM citations. Marginal for personal-handle growth; high value once Jinn the project has surface area worth tracking. Park for later.

---

## Tools to skip

- **Tweet Hunter** ($49/mo). AI ghostwriter trained on viral tweets. Will pull your voice towards the median viral tweet, which is the opposite of your edge. `oak-content-strategy` already covers ideation in your voice.
- **Hypefury, Buffer, SuperX, Postel**. Typefully covers scheduling and crossposting. Switching costs > marginal feature gain.
- **Reply Guy / SocialPlug / Teract auto-reply**. Algorithmic risk plus voice contamination. The whole point of your reply game is that the replies sound like you. Automating them defeats the +75 "author replies back" loop you're trying to provoke.
- **Brandwatch**. Enterprise listening with X Firehose access. Massive overkill until Jinn has paid customers.
- **ilo.so** ($10/mo). Black Magic does the same for less and includes the CRM angle.

---

## API choice (when MCP isn't enough)

If a custom build needs raw tweet data:

- **GetXAPI** — ~$0.05 / 1000 tweets. Cheapest non-official.
- **TwitterAPI.io** — $0.15 / 1000 tweets. Pay-as-you-go, fast setup.
- **Apify Tweet Scraper V2** — ~$0.50 / 1000 tweets. Higher cost, but plays nice with the Apify MCP and other scrapers (LinkedIn, Farcaster).
- **Official X API v2 (pay-per-use, Jan 2026)** — $0.005 per post read, $0.01 per post created. Hard cap of 2M reads/month. Most expensive but most stable. Use only if you need the official channel for a published agent.

For a single user running a handful of skills, GetXAPI or TwitterAPI.io is the right floor.

---

## Patterns worth stealing into the skills

- **Hook 4-part formula**: Bold Statement → Tension → Twist → Credibility, ending on an open loop. 30–40% of writing time should be the hook.
- **Thread sweet spot**: 7–12 tweets. Singletons compete for likes; threads compete for bookmarks and reposts (each worth ~10–20x a like).
- **70/30 reply rule**: 70–80% of social time on replies to accounts 2–10x your size; 20–30% on original posts.
- **First-15-minutes window**: replies in the first 15 minutes of someone's tweet land in "top replies". Notifications on for the top 10 target accounts.
- **Author-replies-back trap**: the +75 reply-to-reply signal is the single biggest weight in the algorithm. Engineer replies that *invite* the original author to push back or extend. Specific data, respectful counter, concrete extension.
- **Link-in-reply not main**: reach drops 50–90% on tweets with external links. Always reply-with-link.
- **No Saturday posts**: peak windows for crypto/AI are Tue–Thu, 09:00–14:00 target-tz. The playbook already names this — feed it into the Typefully scheduler defaults.

---

## Recommended order of operations

1. **Today** — install Twitter/X MCP (`0xGval`), confirm Premium is on, sign up to Black Magic.
2. **This week** — convert find-conversations prompt to skill; wire up the two scheduled briefings.
3. **Next week** — build `pre-publish-lint` and `hook-stress-test`. Run them on every queued post for two weeks before judging.
4. **Week after** — `engagement-debrief` daily at 16:00. This becomes your one weekly stress-test against the playbook.
5. **Park** — LunarCrush, Apify, thread-shaper, reply-shaper. Add only when the bottleneck is clearly a tool gap, not a discipline gap.

---

## Honest stress-tests

- **You don't have a tool problem; you have a reply-time problem.** Most of the leverage is in 14:00–15:30 reply-game discipline. If that block isn't being protected, no MCP fixes that.
- **Typefully + Premium + 30 minutes of disciplined replies a day will outperform any of these tools used alone.** The skills compound the reply-game; they don't replace it.
- **Voice contamination is the silent risk** with any AI-assisted drafting. The hook-stress-test and brand-review gates exist to catch it. If you start sounding like a Tweet Hunter ghostwriter, kill the relevant skill.
- **No `oak-content-strategy` for the Jinn account.** Two-account strategy is in the playbook; the personal voice skill won't transfer cleanly. Separate skills if/when @JinnNetwork goes active.
