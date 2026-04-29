# X/Twitter Algorithm & Cold-Start Playbook

10 April 2026. Research notes for growing Jinn's X presence from near-zero.

---

## How the Algorithm Works Now

In October 2025, Musk announced full transition from heuristic-based recommendations to a Grok-powered AI model. In January 2026, X open-sourced the new algorithm ([xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) — Rust 63%, Python 37%). The architecture: Home Mixer (orchestration), Thunder (in-memory post storage), Phoenix (Grok-based transformer ranking), and Candidate Pipeline (retrieval). It reads every post and watches every video to match users with content via the same transformer architecture as Grok.

### Engagement Scoring Weights (from Jan 2026 source code)

| Signal | Weight | Notes |
|--------|--------|-------|
| **Reply-to-reply** (conversation) | **+75** | A reply that gets a reply back from the author. By far the strongest signal. |
| **Reposts** | ~20x a Like | Signals share-worthiness. |
| **Replies** | ~13.5x a Like | Starting a conversation. But the real prize is the +75 when the author replies back. |
| **Profile clicks** | ~12x a Like | Signals curiosity about you. |
| **Link clicks** | ~11x a Like | People actually clicking through. |
| **Bookmarks** | ~10x a Like | Less gameable. Signals "I want to come back to this." |
| **Likes** | 1x (baseline) | The lowest-value engagement signal. |

The critical insight: **a reply that generates a reply from the author is 150x more valuable than a like.** Conversation depth is the strongest signal. This rewards genuine back-and-forth, not broadcast.

### Penalty Weights (from source code)

| Signal | Weight |
|--------|--------|
| **Tweet report** (spam/abuse) | **-369x** |
| **Block / mute / "show less"** | **-74x** |

A small number of reports can kill a post's distribution entirely.

### Grok Sentiment Analysis (New)

Grok now monitors the tone of every post. Positive/constructive messaging gets wider distribution. Negative/combative tones get reduced visibility even if engagement is high. This is a meaningful change — rage-bait is less effective than it used to be. (Confidence: medium — multiple sources reference this but exact mechanics aren't fully transparent.)

### How Distribution Works

1. Your post goes to a small test audience (~5-15% of your followers + algorithmically selected).
2. If engagement in the **first 30-60 minutes** is good relative to that audience, distribution expands.
3. The "For You" feed mixes roughly 50% in-network (people you follow) with 50% out-of-network recommendations.
4. Out-of-network recs are driven by **interest clusters** — groups of accounts the algorithm bundles together based on follow/engagement patterns.
5. Crypto Twitter and AI Twitter are distinct clusters with some overlap. A Jinn account needs to decide which cluster to be in (or bridge both, which is harder).
6. New accounts have a low **Tweepcred score** (account-level reputation). It builds over time through genuine engagement and follower quality. This means new accounts face a cold-start problem — even good posts may reach only 50-100 impressions initially.

### What the Algorithm Penalises

- **External links in tweets.** X wants people on-platform. Links in the main tweet get suppressed. Workaround: put the link in a reply to your own post.
- **Mutes, blocks, "Not interested" clicks.** Very negative signal.
- **Unfollows after seeing your content.**
- **Hashtag stuffing.** One or two is fine. More signals spam.
- **Near-duplicate content.** Don't post the same thing repeatedly.
- **Cross-platform watermarks** (e.g. TikTok logo on video). Deprioritised.
- **Low engagement rate.** The algorithm tracks your *rate*, not just total. 20 mediocre posts that get no engagement will drag your account down worse than posting nothing.

### X Premium Is Mandatory

For a serious growth effort, X Premium is table stakes now. Without it:
- Your replies get buried under Premium subscribers' replies (30-40% lower reply impressions).
- Premium accounts get roughly **2-4x visibility boost** for in-network and **2x for out-of-network** content.
- Multiple analyses report Premium accounts getting **~10x more reach per post** than free accounts (Buffer study of 18M+ posts confirms the gap is real).
- Since March 2025, **non-Premium link posts get near-zero engagement** — median engagement rate of 0%.
- You can't use long-form posts or Articles.

Basic tier ($8/mo) is sufficient. This is not optional anymore.

---

## Cold Start: 0 to 1,000 Followers

### X Communities (The Biggest Cold-Start Lever Right Now)

As of February 2026, Community posts are now visible to everyone on X — they appear in the For You feed, global search, and followers' timelines. This is a major change. Previously they were siloed.

**Practical implication:** Post into Communities when you have under 3,000-5,000 followers. Your content gets distribution to community members regardless of whether they follow you. One reported case: a creator gained ~2,000 followers in 30 days by posting exclusively into the "Build in Public" community.

Relevant communities for Jinn: AI/ML, crypto/Web3, developer, and agent-infrastructure communities. Creating a community requires Premium; joining doesn't.

### The Reply Strategy (Still Top Tier)

Replying to larger accounts in your niche remains one of the most effective cold-start tactics. The mechanics:

1. **Identify 20-30 accounts** in your niche (crypto-AI, agent infrastructure, OLAS ecosystem, decentralised AI). Target 5K-100K follower accounts — big enough to have an audience, small enough that your reply isn't buried in 500 others.
2. **Turn on notifications** for the top 10.
3. **Reply within 30 minutes** of their posts. Early replies have a much higher chance of being surfaced as "top replies."
4. **Add substance.** "Great point!" gets nothing. What works:
   - A specific data point or personal experience
   - A respectful counter-perspective
   - Extending their point with a concrete example
   - A genuinely interesting follow-up question
5. **Be consistent.** People who see your replies across multiple threads start recognising your name. That's when they click your profile.

**The flywheel:** Great replies → profile visits → follows → your own posts get more initial engagement → algorithm distributes wider → more people see your replies → more profile visits.

### Posting Cadence

- **5-10 posts per day** during the cold-start phase (mix of original posts into Communities + replies). Can reduce once past 3K-5K followers.
- Consistency matters more than volume. The algorithm tracks posting regularity. Space activity across the day — don't dump 10 posts in an hour then go silent.
- **Peak hours for crypto/AI/tech:** Tuesday-Thursday, 9am-2pm in your target audience's timezone (likely US/EU). Saturday is the worst day. Evenings (6-11pm) see significant drops.
- Reply to 20-30 relevant accounts per day *in addition to* your own posts.
- **Warm-up period:** New accounts need 2-4 weeks of consistent activity before the algorithm starts trusting them.

### Profile Basics

- **Bio:** Clear and specific. Not clever, not vague. "Building [X] — [what it does]." People decide to follow from the profile page in about 2 seconds.
- **Pinned post:** Your best/most representative content. Update it regularly.
- **Real photo or distinctive avatar.** Consistent visual identity helps recognition in reply threads.
- Don't neglect this. A high impressions-to-follows ratio usually means people are seeing your content but your profile isn't converting them.

### Early Seeding

- Ask the handful of people you know to engage with your first few posts. Not an engagement pod — just getting the initial signal so the algorithm has something to work with.
- Cross-pollinate from wherever you have existing presence (Telegram group, OLAS Discord, etc.).
- Engage back with everyone who engages with you. Bilateral engagement compounds in the algorithm.

---

## Content Formats (What Gets Distribution)

There's a nuance here: text posts get higher engagement *rates* (because they spark replies, which are weighted heavily). Video gets more raw *reach/impressions* (because X is strategically pushing it). For a small account focused on growth, **text + reply-driving content is likely more efficient** than video production. Video matters more as you scale.

Ranked by practical value for cold-start growth:

1. **Text posts that drive replies** — Conversation starters, hot takes, questions, "here's what we learned" posts. Short (71-100 chars) for engagement rate, or near-max (240-259 chars) for depth. Text outperforms video by ~30% on engagement rate — X is the only major platform where this is true.
2. **Image + substantive text** — Screenshots, diagrams, architecture visuals paired with a strong take. Images stop the scroll.
3. **Threads (3-5 posts)** — 40-60% more total impressions than the same content as standalone posts. Best for complex topics. Get indexed in search. Still effective — just no longer the *default* format.
4. **Native short video (<2 min)** — Gets raw reach (80%+ of user sessions include video, 29% increase in daily video views in 2025). High production cost relative to text for a 2-person team.
5. **Long-form posts / Articles** — Rewarded for dwell time. 150K+ new posts generating 3B daily impressions. Good for establishing authority. Requires Premium.
6. **Polls** — Low-friction engagement but low-quality signal. Useful occasionally.
7. **External links** — Actively deprioritised. Put links in replies.

### X Spaces (Underexplored)

Described as "one of the most underused growth tools on X." Recurring Spaces build loyal live audiences and boost session time. Good fit for technical protocol discussions once you have a small base. Low competition.

---

## Crypto/AI Niche Specifics

- **"Smart followers" matter more than follower count.** Engagement from verified Premium users and industry figures is exponentially more valuable algorithmically. One engaged Premium follower is reportedly worth 100 casual followers for algorithmic boost and ad revenue sharing.
- **Building in public** performs well. Share what you're actually working on — code, architecture decisions, problems you're solving. Founder accounts that show real work outperform pure commentary accounts.
- **Contrarian takes on mainstream AI narratives** get outsized engagement. "Why [conventional wisdom] is wrong" format. AI Twitter thrives on debate.
- **Technical deep-dives** establish credibility fast. A single well-crafted technical post can drive hundreds of follows from the right audience. "Here's what we built and why" outperforms "here's our product."
- **The crypto-AI intersection is hot.** This is Jinn's sweet spot. AIXBT (an AI agent) commands 3% of total crypto Twitter mindshare — proof that this category has attention. Decentralised AI, AI agent infrastructure, token-incentivised compute sits at the junction of two highly engaged communities.
- **"Us vs. them" framing** (positioning against centralised AI) resonates in crypto circles. But being too adversarial can alienate AI developers who use those tools daily. The brain dump's framing — "your AI's experience is worth something, right now Anthropic keeps it" — hits the right nerve without being obnoxious.
- **Newsjacking works.** When major crypto/AI news breaks, having a fast, relevant take gets distribution from the trending topic.
- **Don't lead with token/price.** Projects that succeed on CT focus on consistent content and real community engagement, not hype. Aligns with Jinn's "no token on mainnet yet" positioning.

### Two-Account Strategy (From the Brain Dump)

The insight about keeping @tannedoaksprout OLAS-focused and the Jinn account AI-developer-focused is algorithmically sound. Each account optimises for its own interest cluster. Trying to bridge crypto and AI audiences from one account confuses the algorithm's clustering.

---

## What Not To Do

- **Don't buy followers or use bots.** Detected and penalised. Fake followers dilute engagement rate, which tanks distribution.
- **Don't over-post low-quality content.** The algorithm cares about your engagement *rate*. Bad posts actively hurt your account.
- **Don't use engagement pods.** The algorithm has gotten better at detecting coordinated inauthentic engagement. Organic support from people you know is fine; organised pods are risky.
- **Don't mass-follow/unfollow.** Detected and penalised.
- **Don't post without engaging.** Posting into the void without replying to others signals a broadcast account. The algorithm deprioritises these.
- **Don't use link shorteners** (bit.ly etc.) — associated with spam.

---

## Practical First-Month Plan

**Week 1-2: Foundation**
- Get X Premium for the Jinn account ($8/mo Basic tier)
- Optimise profile (bio, avatar, pinned post)
- Follow 100-200 relevant accounts (OLAS ecosystem, AI agent builders, decentralised AI, crypto-infra)
- Join relevant X Communities (AI/ML, crypto/Web3, Build in Public, developer communities)
- Start replying to 20-30 accounts daily (quality replies, within 30 min of their posts)
- Post 3-5 original posts per day into Communities (building in public, technical insights, protocol philosophy)

**Week 3-4: Cadence**
- Maintain Community posting + reply cadence
- Turn on notifications for your top 10 target accounts
- Notice what formats get traction with *your* audience specifically
- Engage with everyone who engages with you — bilateral engagement compounds
- Find 10-20 accounts at a similar stage and build genuine mutual engagement

**Month 2: Double Down**
- Focus on formats that are working
- Attempt 1-2 "swing for the fences" posts (deep technical content, contrarian takes)
- Consider a recurring X Space for protocol discussions
- Start posting more to your own timeline (not just Communities) as follower count grows

---

## Honest Caveats

- Much of this is based on observed behaviour, third-party analysis, and the (now outdated) open-source algorithm code. X changes things without announcement.
- The specific weights and tactics may shift. The principles — genuine engagement, valuable content, consistency, being part of conversations not just broadcasting — are durable.
- Growing from zero is slow. Expect 2-3 months before momentum becomes noticeable. The compounding is real but it's back-loaded.
- For a 2-person team, the time cost is real. Budget 1-2 hours/day for this during the growth phase. If that's not feasible, it's not feasible — better to do less consistently than burn out after a week.
