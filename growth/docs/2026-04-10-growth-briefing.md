# Growth Briefing — Read This First

10 April 2026. One document. Everything from the brain dump, framework, and algorithm research, consolidated.

---

## Where We Are

Two co-founders, no marketing team, no public token, near-zero social presence. The Jinn client and on-chain contracts are deployed. Phase 1a (testnet) is live. The Jinn Twitter account exists but is nearly empty. The personal account (@tannedoaksprout, 3.5k followers) has traction in the OLAS world.

We've been quiet. We're about to not be.

---

## The Three Audiences

They have different motivations, different channels, and different conversion actions. Don't collapse them.

**Operators** — Technical, crypto-native people who will run a Jinn node on testnet. The warmest pool is existing OLAS node operators. They care about earning from their node's accumulated execution knowledge and positioning early before mainnet. The conversion action is: running the client on testnet.

**Contributors** — Developers who want to build on/with Jinn. New clients, templates, integrations. Found on GitHub and in dev communities. They care about interesting technical problems and the fact that fair launch means early contributors actually matter. The conversion action is: a PR, an issue, a fork.

**Launchers** — Non-technical people with deep domain knowledge who want to create agents around their expertise. The chess-obsessed accountant. They're everywhere but the product needs to be further along before we can reach them. **Park this audience for now.**

---

## The One Metric

**Testnet operators.** Everything else is vanity until people are running the client who aren't us.

Goal: 10 external testnet operators before mainnet launch is even considered.

---

## The Pitch

Your AI's experience is worth something. Right now Anthropic keeps it. On Jinn, you sell it.

Your node participates in solving intents, builds up knowledge artifacts from that work, and sells those artifacts to other nodes solving similar intents later. You're literally selling your agent's experience.

The narrative position: Bitcoin had central banks. Bittensor had OpenAI. Jinn has the extractive pattern of centralised AI agents. "The entity replacing all the jobs should not also be the sole owner of the accumulated intelligence."

The tone is empowering but urgent. Not fear-mongering, not crypto-bro, not academic. A developer who cares about ownership and shows real work.

---

## Three Channels to Test First

Bullseye rule: pick 3, run cheap tests, measure, focus. Nothing has earned the inner ring yet.

### 1. OLAS Discord + Direct Outreach → Operators

The warmest pool. These people already run OLAS services. Jinn is built on the OLAS Mech Marketplace. You're known there.

**The loop:** Post about Jinn testnet in OLAS Discord. DM 10 active node operators with a personal invite. Measure: how many replied, how many ran the client, what questions they asked. Decide: do another round or move on.

### 2. GitHub Discoverability → Contributors

Clean up the mono repo README. Label issues ("good first issue"). Write a clear contribution guide. This is zero-cost and high-signal.

**The loop:** Ship the README and contribution guide. Measure: forks, stars, PRs from people who aren't you over the next 2 weeks.

### 3. Hacker News / Reddit → Contributors + Operators

Write one post about the execution memory thesis. Not a launch announcement — a "here's what we're building and why" post. Target r/ClaudeAI, r/LocalLLaMA, HN. AI developers who use coding agents daily already feel the extraction problem intuitively.

**The loop:** Post it. Measure: comments, DMs, testnet signups. One post, not a campaign.

---

## The X/Twitter Play

This is a medium-term channel, not an immediate one. But when you start, here's what matters.

### The Algorithm (January 2026)

X open-sourced a new Grok-powered algorithm in January 2026. The key numbers from the source code:

- **Reply-to-reply (conversation):** +75 weight. A reply that gets the author to reply back is 150x more valuable than a like. This is by far the strongest signal. Genuine back-and-forth is what the algorithm rewards most.
- **Reposts:** 20x a like.
- **Replies:** 13.5x a like.
- **Profile clicks:** 12x a like.
- **Bookmarks:** 10x a like.
- **Likes:** 1x. The least valuable engagement signal.

On the penalty side: a tweet report is -369x. A block/mute/"show less" is -74x. A small number of reports can kill a post's distribution entirely.

**Grok now does sentiment analysis on every post.** Positive/constructive content gets wider distribution. Negative/combative content gets suppressed even if engagement is high. Rage-bait is penalised. This is actually good for us — the pitch is constructive, not angry.

### X Premium Is Mandatory

This is not optional for a serious growth effort:

- Premium accounts get 2-4x visibility boost. Multiple studies show ~10x more reach per post vs. free accounts.
- Premium replies appear higher in threads (30-40% more impressions).
- Since March 2025, non-Premium link posts get a median engagement rate of 0%.
- Basic tier is $8/month. Just do it.

### The Cold-Start Strategy

**X Communities are the biggest lever right now.** Since February 2026, Community posts appear in everyone's For You feed and search — not just community members. For an account with under 3K followers, posting into Communities gives you distribution you can't get any other way. One reported case: 2,000 followers in 30 days posting exclusively into the "Build in Public" community.

**The reply strategy is still top-tier.** Identify 20-30 accounts in the crypto-AI space (5K-100K followers — big enough to have an audience, small enough your reply isn't buried). Turn on notifications for the top 10. Reply within 30 minutes of their posts with something substantive — a data point, a counter-perspective, a concrete example. "Great point!" gets you nothing. The goal is to trigger a reply back from the author (+75 weight) and to become a recognisable name in threads.

**The flywheel:** Great replies → profile visits → follows → your posts get more initial engagement → algorithm distributes wider → more people see your replies.

### Two Accounts, Two Clusters

Keep @tannedoaksprout OLAS-focused. Build the Jinn account for AI developers. This is algorithmically sound — X clusters users into interest graphs, and trying to bridge crypto and AI from one account confuses the clustering. Each account optimises for its own subgraph.

### Content That Works

Text posts that drive replies outperform everything else for cold-start growth. Text beats video by ~30% on engagement rate — X is the only major platform where this is true. Video gets more raw impressions but costs more to produce.

For the crypto-AI niche specifically:
- **Building in public** — share what you're actually working on. Code, architecture decisions, problems.
- **Technical deep-dives** — one well-crafted technical thread can drive hundreds of follows.
- **Contrarian takes on mainstream AI narratives** — AI Twitter thrives on debate.
- **Newsjacking** — fast, relevant take when major crypto/AI news breaks.

Don't lead with token or price. Don't use more than 1-2 hashtags. Don't put links in the main post (put them in a reply). Don't over-post mediocre content — the algorithm tracks your engagement *rate*, and bad posts drag it down.

### Realistic Timeline

- Month 1: 100-300 followers. Finding the rhythm.
- Month 2-3: 300-1,000. Voice solidifies, some posts pop.
- Month 3-6: Compounding kicks in.

Budget 1-2 hours/day during the growth phase. If that's not feasible, do less consistently rather than burning out.

---

## What We're Not Doing Yet

- Building a Telegram community to manage
- Running ads
- Creating a content calendar
- Chasing the launcher audience
- Podcast appearances
- Partnerships

These aren't bad ideas. They're just not first.

---

## Sequencing

**Now:** OLAS Discord outreach + GitHub discoverability + one HN/Reddit post. Measure testnet operators.

**Soon (when testnet has external operators):** Start the Jinn X account seriously. Communities + reply strategy. Build in public.

**Later (when product is more polished):** Launcher audience. Content marketing. Broader reach.

**Throughout:** Close loops, don't plan. One cycle of do → measure → decide should take days, not weeks. If you're planning for longer than you're executing, stop planning.
