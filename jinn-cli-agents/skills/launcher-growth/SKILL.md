---
name: launcher-growth
description: >
  Strategic context for Jinn launcher growth — narrative positioning,
  target user stories, product gaps, and marketing language guidelines.
  Use when working on website copy, app onboarding, growth experiments,
  or anything related to acquiring new launchers (people who create agents on Jinn).
allowed-tools: Read, Glob, Grep
---

# Launcher Growth

## Narrative Position

**Tagline:** Own What You Know

**Thesis:** AI is reshaping every industry. Most people feel this as a vague
anxiety — "AI is coming for my job." Jinn's answer isn't "protect your job."
It's: that thing you know deeply — chess, rare diseases, wine, robotics,
whatever — make it into something real. An autonomous AI agent that researches,
creates, and works for you.

**Narrative structure:**
1. **Hook:** AI is changing everything. Your expertise is at risk.
2. **Bridge:** But you have something valuable — deep knowledge in things you
   genuinely care about. Not necessarily your day job.
3. **Solution:** Jinn lets you turn that into an autonomous agent. Start with
   what you know.

**Tone:** Empowering but urgent. Not fear-mongering, but make people feel the
weight of what they're losing. Lead with expertise/AI. De-emphasize crypto —
it's the "how" not the "why." Mention OLAS/Base only in "powered by" contexts.

**Key insight:** The pitch is NOT "protect your work knowledge" — most people's
work knowledge is either too specialized/confidential or not something they
think of as extractable. The pitch is about the things people care about
*disproportionately* — their obsessions, passions, and side interests that
currently live unproductively in their heads, browser tabs, and group chats.

**What we are NOT saying:**
- "Become a founder" (too startup-bro)
- "Launch a token" (too crypto)
- "AI agents handle execution" (too abstract)
- "Protect your job from AI" (too fear-based, and people don't believe it yet)

## Target User Stories

### Story 1: The Chess-Obsessed Accountant

**Profile:** Professional accountant at a large firm. Not interested in
productizing his accounting knowledge (confidential, specialized, boring).
BUT: deeply passionate about chess. Has a YouTube channel teaching openings.
Follows GM games obsessively. Has strong opinions about what beginners get
wrong.

**What Jinn does for him:** Creates a chess content agent that monitors
Lichess, chess24, top GM channels, r/chess, FIDE — and produces weekly
digests with *his* editorial angle ("The London System is underrated for club
players"). His agent sounds like him, not like generic AI.

**Current product fit:** The content-template + wizard handles this today.
The `contentBrief` field carries his perspective. Sources are just URLs.
Cadence is weekly.

**What's missing:**
- He'd eventually want his agent to watch his own YouTube transcripts and
  incorporate his teaching style (source type works, but not obvious in UI)
- No way to share his agent's output beyond the Jinn explorer (email digest,
  RSS, embeddable widget would unlock distribution)

**Status:** Can launch today with current product. Copy improvements in
JINN-387 make the wizard feel right for him.

### Story 2: The Genetics Researcher (First External Launcher)

**Profile:** Data scientist by training, PhD from Cambridge. Can't get a PM
job right now. His son has an unpredictable rare genetic condition (Cantu
syndrome). Dreams of building a predictive model (genotype -> disease
progression). Near-term: just wants to aggregate and synthesize research for
the patient community.

**What Jinn does for him:** Transforms him from "unemployed PM" into "AI-powered
super-researcher" — someone who produces genuine research synthesis that the
patient community values. His Cambridge training + deep personal motivation =
exactly the kind of disproportionate insight that makes Jinn agents valuable.

**Current product fit:** The content-template + wizard gets him a weekly
PubMed/ClinicalTrials.gov digest. This is useful but basic — it's content
aggregation, not deep research.

**What he really wants:** `content-research` behavior — recursive fan-out,
deep source discovery, cross-referencing papers. But that template requires
blog infrastructure (git repo, domain, `blog_create_post`) he doesn't need.

**Product gap — "Deep Research" mode:**
There's no middle ground between:
- Simple content stream (`content-template`): monitor URLs, produce digest
- Full blog operation (`content-research`): recursive fan-out, blog infra

He needs `content-research`'s depth (8+ threads, 10+ independent sources,
recursive fan-out) but outputting structured artifacts, not blog posts. This
is a template gap — a "deep research" variant without blog dependency.

**Status:** Can launch a basic digest today. Deep research mode is a future
template to build (separate issue).

## Product Capability Map

What the platform can do vs what launchers see:

| Capability | Exists in Templates | Exposed in Wizard |
|-----------|-------------------|-------------------|
| Source monitoring + synthesis | Yes (content-template) | Yes |
| Cron scheduling | Yes (content-venture-template) | Yes (4 presets) |
| Format rules (word limits, sections, citations) | Yes (content-template) | Yes (JINN-387) |
| Recursive fan-out research | Yes (content-research) | No |
| Blog publishing | Yes (blog-growth-template) | No |
| Multi-workstream orchestration | Yes (venture-orchestrator) | No |
| Agent composition (feeds into) | Yes (via dispatch_new_job) | No |
| Distribution (Telegram, RSS) | Partial (Telegram in blog-growth) | No |

## Key Files

| Area | Path |
|------|------|
| Website copy | `frontend/website/src/app/page.tsx`, `frontend/website/src/components/` |
| App wizard | `frontend/app/src/components/create-venture-form.tsx` |
| App server action | `frontend/app/src/app/actions.ts` |
| Content template | `blueprints/content-template.json` |
| Content venture template | `blueprints/content-venture-template.json` |
| Deep research template | `blueprints/content-research.json` |
| Blog growth template | `blueprints/blog-growth-template.json` |
| Venture orchestrator | `blueprints/venture-orchestrator.json` |

## Growth Hypotheses (from JINN-387 Linear issue)

Testing:
1. Many business owners want content marketing but don't have time
2. Agent owners use their agents to curate updates on their interests already
3. People are tired of relying on biased sources (newspapers, podcasts)
4. Agent owners want ways to monetize agent outputs
5. People prefer updates directly relevant to their interests over traditional outlets

## Future Work

- **Deep research template** — `content-research` without blog dependency
- **Distribution channels** — email digest, RSS feed, embeddable widget for agent output
- **Agent composition UI** — let users chain agents ("my weekly digest feeds into my monthly analysis")
- **Monetization** — x402 pay-per-read for agent output, subscriptions
- **Onboarding for non-technical users** — the OLAS staking requirement is a major barrier; sponsored staking or x402 pay-per-execution would remove it
