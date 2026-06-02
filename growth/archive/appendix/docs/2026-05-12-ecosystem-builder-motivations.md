# Ecosystem builder motivations — 2026-05-12

Research input for the upcoming GROWTH.md §3 rewrite. Per-ecosystem motivation profiles for eleven open-source agentic-harness ecosystems plus the ERC-8004 ecosystem, followed by cross-ecosystem synthesis. The §3 rewrite is downstream of this file and out of scope here.

*Revision 2026-05-12 (post-initial): added OpenClaw (the actual predecessor mantle-holder, sold to OpenAI February 2026; the task brief named OpenCode as predecessor but the field-evidence shows it was OpenClaw). Diaspora-mapping for OpenClaw added as the most consequential single ecosystem finding; synthesis updated.*

## Method

Tools used: `bird` (X CLI) for builder timelines and bios; `gh` for GitHub orgs, contributor graphs, issues, and code search; WebSearch / WebFetch for landing pages, READMEs, blog posts, podcasts, EIP discussions. Five parallel research agents covered the ten ecosystems concurrently; each agent ran the same eight-question template, kept STATED quotes verbatim with attribution, and inferred motivations separately. Composition + synthesis by main thread.

Time spent: ~75 minutes wall-clock total (parallelised; each agent ran ~45–75 minutes of search; OpenClaw added in a second pass after Oak flagged the omission).

Confidence per ecosystem (self-reported by agents, cross-validated where possible):
- **OpenClaw:** medium-high. High on macro facts (acquisition, foundation, license, contributor stratification, Hermes overtaking on OpenRouter, the `hermes claw migrate` command). Medium on specific diaspora percentages (30% Hermes migration is a Reddit-sentiment figure cited in trade press, not a measured number). Medium on named-individual-with-current-affiliation mapping.
- **Hermes / Nous:** high. First-party READMEs, contributor graphs, founder podcasts/interviews, curated awesome-list with named maintainer, X timelines pulled today. Residual uncertainty: internal Discord channel topology.
- **OpenCode:** high on ecosystem shape, ARR, plugin top-ten, maintainer identities. Medium on motivation mix (inferred from plugin types, no interviews). Low on whether token-tolerance would flip under a maintainer endorsement.
- **Aider:** high on contributor concentration, named integration authors, Paul's tonality. Medium on his exact financial/equity motivation. Medium-low on token-tolerance signal.
- **OpenHands:** medium-high. Strong on maintainer identity and recognition loops. Weaker on the long-tail SKILL.md author surface.
- **Cline:** high on builder pool, motivations, and token-tolerance (the MCP marketplace gives a verifiable submission feed). Medium on the co-maintainer set (low public profile).
- **ERC-8004:** high on canon, leader question, top builders, and the validator-economics gap. High on token-pump vs real-builder classification. Medium on long-tail GitHub-only contributors.
- **Continue.dev:** medium-high. Single named external builder profiled, motivation language read rather than stated.
- **Roo Code:** high on artefact, motivations-as-revealed-by-README. Medium on the human behind the (anonymous) handle. Token-tolerance inferred from pseudonymity, not stated.
- **Goose:** high on the single builder profile and recipe count. Medium on motivations (read from project shape). Medium on token-tolerance (platform-vs-contributor distinction is real).
- **SWE-agent:** high on maintainer identity, motivations, and token-allergy. Medium-low on third-party artefact builders — the ecosystem genuinely does not have a clear non-maintainer extension culture, which is itself a finding.

Nothing was skipped. The lighter-sample ecosystems got proportionally less depth, as scoped in the task.

## Cluster summary (TL;DR)

The cross-ecosystem synthesis below crystallises into four builder clusters, plus a crosscutting gateway pattern. This table is the compact form; full per-cluster narrative is in *Cross-ecosystem synthesis → Load-bearing motivation*.

| Cluster | Motivation | Phenotype | Ecosystems they show up in |
|---|---|---|---|
| **A. Distribution-as-validation** | Be seen by the maintainer; land on the canonical surface; reach is the prize. | Ships plugins / skills / recipes for the in-vogue harness; high public posting cadence; followers grow on shipping; cross-ecosystem prolific authors common. | Hermes, OpenCode, Cline, Goose, OpenClaw loyalist-stayers |
| **B. Research-output / citation** | Produce a citeable result; the harness is the substrate of a paper. | arxiv submissions, leaderboard runs, NeurIPS/ICLR cadence, group affiliation visible in bio, won't touch crypto. | OpenHands, SWE-agent, latent in Hermes via Quesnelle/Peng line |
| **C. Substrate-capture** | Become the layer all agent infra terminates against (the ERC-20-for-agents bet). | Ships SDKs, indexers, contracts, registries; talks composability; sharp internal norms separating building from token-pumping; tracks who the canon authors RT. | ERC-8004 real-builder subset (agent0lab, Phala, Nexum, ACTA), latent in Hermes via Atropos/$NOUS |
| **D. Sovereignty / governance-distrust** | Not being absorbed; substrate that cannot be acquired. | Forks projects post-acquisition with stricter security/posture; switches dependencies away from concentrated vendors; explicit objections to sponsor-controlled foundations; pseudonymity-tolerant; ideologically primed for credibly-neutral substrate even when not crypto-loud. | OpenClaw Sovereign-forkers (NanoClaw, ZeroClaw, Nanobot), OpenClaw Hermes-migrators (depth subset), Roo Code pseudonymity layer, latent in OpenCode anti-rent-extraction sub-cluster |

Plus the crosscut: **workflow scratching** — the gateway pattern through which most builders enter any cluster. The first artefact is almost always a personal itch (memory bank, scheduler, notifier, prompt library). It is not itself a cluster; it is an entry shape. What distinguishes a future recruit from a one-shot author is whether the itch generalises.

**Highest-fit recruit shape per body:** Sovereignty (D) and Substrate-capture (C). Small in absolute terms but pre-converted on the thesis — they have already paid a cost to act on the suspicion that single-vendor agent infra is bad (D) or that the missing layer in their canon is exactly what Jinn ships (C). Distribution (A) is the largest pool but requires more bridge work. Research (B) is the highest-status per builder but token-allergic.

---

## Per-ecosystem profiles

### 0. OpenClaw (predecessor, sold to OpenAI February 2026)

- **LEADER STATUS:** Sold but not killed. Peter Steinberger announced on 14 February 2026 he was joining OpenAI; the project was transferred to an independent non-profit foundation with OpenAI as lead financial sponsor (alongside GitHub, NVIDIA, Vercel, Blacksmith, Convex). MIT-licensed, still on `github.com/openclaw/openclaw`, ~247–370k stars depending on source, ~47k forks. **As of May 2026 it has been overtaken on daily OpenRouter inference volume by Hermes (Hermes 224B tokens/day vs OpenClaw 186B).** The mantle of "the open agent that everyone is building on" has clearly transferred. Hermes ships `hermes claw migrate` (with `--preset full --migrate-secrets`) — a permanent monument-in-code to the defection.

- **WHO MAINTAINED:** Maintainer set was thin at the top. **Peter Steinberger** (`@steipete`, Austrian, Vienna ↔ London, ex-PSPDFKit founder who sold to Insight Partners for ~€100M in 2021) is the sole creator. Mario Zechner credited for support. Tomas Taylor co-hosted ClawCon SF (15–17 Jan 2026, 1,200 attendees, 34 countries). A community-side maintainer known only as "Shadow" raised early safety warnings on Discord. Named community speakers from ClawCon: Josh Palmer (senior engineer at Spotify), Luke Wang (AI infrastructure, MIT Media Lab). Top-of-graph GitHub contributors below Steinberger: vincentkoc, Takhoffman, obviyus, gumadeiras. Geography skewed European — European devs went from 12% to 38% of PRs in a year. Rebrand chain (Clawdbot → Moltbot → OpenClaw) in Jan 2026 happened in days, suggesting a small, tight decision-making core.

- **ARTEFACT BUILDERS (≥3, with post-acquisition trajectory):**
  - **Vincent Koc** (`vincentkoc`) — maintainer of `awesome-openclaw`, plus `dotskills` (skills for Codex + OpenClaw workflow automation, debugging, agent-assisted dev patterns) and `openamnesia` (memory). **Trajectory: stayed**, hedging across Codex and OpenClaw.
  - **VoltAgent** (`VoltAgent/awesome-openclaw-skills`) — curated 5,400+ skills filtered from the official ClawHub registry. Org, not individual. **Trajectory: stayed.**
  - **`xquik-dev`** — TweetClaw + x-twitter-scraper (social-media skills). Integration archetype.
  - **`linked-api`** — LinkedIn skill set.
  - **`team-telnyx`** — ClawdTalk (phone/SMS rail). Integration-vendor archetype; tracks whichever platform ships volume.
  - **`memulabs`** — memU, persistent memory plugin. Memory is exactly where Hermes wins; **highest-flight-risk archetype**.
  - **`comet-ml`** — `opik-openclaw` observability. Vendor-of-tooling; multi-platform by default.
  - **`atxp-dev`** — ATXP, funded identity platform.
  - **`resemble-ai`** — Resemble Detect (deepfake detection).
  - **`andrewchen` (LightClaw), `emperormew` (Voidly Agent Relay), `Ramsbaby` (self-healing system + Discord bridge), `c5huracan` (meyhem-search MCP), `OzorOwn` (defi-mcp), `adityasugandhi` (skillsync-mcp security auditing)** — independent skill/MCP authors.
  - **Hard-fork archetype: `nanocoai/nanoclaw`** — explicit security-hardened fork (containerised skill execution, mandatory permission gates, runs on Anthropic Agents SDK). This is the contributor who looked at the foundation-with-OpenAI-money structure and chose to fork rather than trust it. **Highest-signal recruit profile in the entire diaspora.**

  **Post-acquisition diaspora landing zones**, in order of volume:
  1. **Hermes** (~30% of users migrated per Reddit sentiment surveys — the `hermes claw migrate` command exists specifically because the volume justified it).
  2. **NemoClaw** (NVIDIA reference stack, March 2026).
  3. **ZeroClaw** (Rust, <10ms startup, 3.4MB binary).
  4. **Nanobot** (Hong Kong, 4k lines of Python, 26.8k stars).
  5. **NanoClaw** (the security fork).

  The lobster-emoji crowd on X is now dominated by Solana memecoin "OpenClawAI" impersonators (`@OpenClawAIX`), which the real community treats as noise.

- **STATED MOTIVATIONS:**
  - Steinberger, on his choice (`steipete.me`, Feb 2026): *"I want to change the world, not build a large company and teaming up with OpenAI is the fastest way to bring this to everyone."*
  - Steinberger, on the next mission: *"My next mission is to build an agent that even my mum can use. That'll need a much broader change, a lot more thought on how to do it safely, and access to the very latest models and research."*
  - Steinberger, on independence: *"It's always been important to me that OpenClaw stays open source and given the freedom to flourish... To get this into a proper structure I'm working on making it a foundation. It will stay a place for thinkers, hackers and people that want a way to own their data."*
  - Steinberger, on money (Implicator.ai, regarding bidder offers): *"I don't give a fuck."*
  - Steinberger, on stewardship by a company: *"I think this is too important to just give to a company and make it theirs"* — said while joining a company.
  - Altman, on OpenAI's open-source posture (Backaitis, Medium, Feb 2026): *"I personally think we have been on the wrong side of history here and need to figure out a different open source strategy."*
  - Community framing on X: *"OpenClaw experience is flawless"*; *"Openclaw is so boring. It just works these days."* — praise pattern is harness quality, not mission.

- **INFERRED MOTIVATIONS:** Read the diaspora and the contradiction in Steinberger's own quotes. He says "too important to give to a company" while joining a company — the foundation is the legitimacy device that lets him do both. Contributors who stayed are the integration-vendor archetype (Telnyx, Resemble, Comet) who only need a platform with volume, plus loyalists who like the harness ergonomics ("the lobster way", a soft cultural register OpenAI did not take away). Contributors who left fall in three clean buckets:
  - **Builders who wanted depth/memory** went to Hermes (the "self-improving learning loop" framing wins exactly the people who were the most serious about building agents that improve, not just run).
  - **Builders who wanted sovereignty** went to NanoClaw (containerised security, Anthropic SDK — explicitly an "I don't trust this stack with OpenAI in the foundation" fork).
  - **Builders who wanted hardware/perf primacy** went to NemoClaw (NVIDIA) and ZeroClaw (Rust).

  **The motivation that recurs in the dissent is *governance distrust*** — the "ClosedClaw" joke captures it precisely, and Reddit threads reference Elasticsearch and MongoDB as precedents for what happens when a sponsor-controlled foundation absorbs the project.

- **STATUS / RECOGNITION LOOPS:**
  - **Pre-acquisition:** ship a skill → land in `awesome-openclaw` (vincentkoc) or `awesome-openclaw-skills` (VoltAgent) → ClawHub official registry → Steinberger reposts on X (49.7k followers) → speak at ClawCon SF/Vienna/Shanghai. The Steinberger retweet was the apex recognition unit.
  - **Post-acquisition:** Steinberger keeps the audience but his time is now sponsored-by-OpenAI; he speaks at OpenAI/Snowflake Dev Day rather than only ClawCon. ClawHub continues; the foundation maintains the registry. The recognition surface for new contributors is thinner because the founder's attention is elsewhere — described on X by `@LakeDaniel11` and `@Tfalwell` as needing an "official OpenClaw helper agent" / "10 mins on phone to share my thoughts," i.e. the comments-from-the-back signal that the maintainer feedback loop has narrowed.
  - On the Hermes side: OpenRouter #1 spot is itself the recognition device; Nous's announcement (`@NousResearch` 9 May 2026) thanking *"contributors, supporters, and users"* is the recruitment surface. The community on X is openly weighing the two — `@RoboAlchemist`: *"I have been using Hermes and OpenClaw side by side... Hermes is better experience so far. I have 1 Hermes and 2 OpenClaws. May need to migrate one of the OpenClaws into Hermes."*

- **UNMET WANTS:**
  - **Trust signal beyond MIT + foundation.** *"Who controls the foundation?"* / *"Is 'supported by OpenAI' the same thing as 'independent from OpenAI'?"* (Kilo.ai blog) — no contributor has a mechanism to verify governance.
  - **Friction-free non-developer UX.** `@LakeDaniel11`: *"The system is just way way too hard to use currently for non-technical users."*
  - **Self-improvement / persistent memory.** The thing 30% of users left for. Hermes shipped it; OpenClaw is bolting it on after the migration.
  - **Skill safety / supply-chain hygiene.** Cisco found skills doing *"data exfiltration and prompt injection without user awareness"*; China restricted state use citing *"unauthorised data deletion and leaks."* NanoClaw exists precisely because the official skill registry has no real vetting.
  - **From OpenAI, specifically: not getting deeper model integration.** Contributors got "subscription access" — they did not get a guarantee of OpenAI-grade research support flowing back into the open project. The foundation is a black box on this point.

- **TOKEN-TOLERANCE:** Low at the centre, mixed at the edges. Steinberger is Austrian/UK, ex-mobile-PDF-SDK, runs a paid macOS toolbox (Peekaboo, Trimmy, CodexBar), takes 44 GitHub sponsors — classic European product-software founder. No public crypto signal. His framing and "I don't give a fuck" about money pattern toward open-source legitimacy, not tokenisation. Named community speakers (Josh Palmer / Spotify, Luke Wang / MIT Media Lab, Vincent Koc) are mainstream-tech, not crypto-native. **However:** the OpenClaw brand has been comprehensively colonised on X by Solana memecoin actors (`@OpenClawAIX` and a wave of *"Was Made Using - @OpenClawAIX"* shill posts) — the broader ambient name carries crypto residue the maintainers do not want. The **Hermes-migrator diaspora** is meaningfully more decentralisation-friendly because Nous itself is partially aligned with that tradition. The **fork-and-stay-sovereign cluster (NanoClaw, ZeroClaw)** is ideologically primed for credibly-neutral substrate arguments even if not token-pilled.

- **ENGAGEMENT SURFACES:**
  - GitHub: `github.com/openclaw/openclaw`, `github.com/openclaw/clawhub` (official skill directory), `openclaw/Peekaboo`, `openclaw/mcporter`.
  - Curators: `github.com/vincentkoc/awesome-openclaw`, `github.com/VoltAgent/awesome-openclaw-skills`, `github.com/SamurAIGPT/awesome-openclaw`, `github.com/LeoYeAI/openclaw-master-skills`.
  - Forks: **`github.com/nanocoai/nanoclaw`** — the principled fork; highest-signal handle to engage.
  - Conferences: ClawCon SF (Jan), ClawCon Vienna (30 Jan), ClawCon Shanghai (May). Hosted by OpenClaw foundation; OpenAI sponsorship visible. Still the most concentrated builder-density surface.
  - Discord: still alive, official OpenClaw server.
  - X: `@steipete` (49.7k), `@openclaw` (project), `@NousResearch` (Hermes target community).
  - Migration command: `hermes claw migrate` — every operator who runs this is, by definition, a diaspora touchpoint.
  - Steinberger's blog: `steipete.me`.

- **DIASPORA SUMMARY:** This is the core finding. The OpenClaw community split, in May 2026, into five buckets:
  1. **Loyalist-stayers** (~50% inferred) — like the harness, like the lobster aesthetic, don't engage with the governance question. Recruit-shape: weak. They will follow wherever Steinberger goes.
  2. **Hermes migrators** (~30% per Reddit) — wanted depth, self-improving memory, less-bound-to-OpenAI alignment. Recruit-shape: **strong**. These people have already done the costly act of migrating off the dominant platform once, and Nous is decentralisation-friendly. They are pre-converted to the "the agent that doesn't get acquired" thesis. **This is Jinn's primary recruitable bucket from the OpenClaw diaspora.**
  3. **Sovereign-forkers** (NanoClaw, ZeroClaw cohort, low double-digit count) — looked at the foundation structure, decided trust was not present, forked with a different security/perf posture. Recruit-shape: **highest signal-per-person.** They have explicit, articulated objections to the OpenAI-foundation pattern. NanoClaw's choice of Anthropic SDK + containers + permission gates is a concrete, technical statement of "I will not run this with single-vendor ambient trust." These are the people who would understand verifiable artefacts and credibly-neutral substrate before you finished the sentence.
  4. **Hardware-aligned (NemoClaw / NVIDIA)** — went where the silicon went. Recruit-shape: weak; they're chasing perf, not governance.
  5. **Memecoin imposters** (`@OpenClawAIX` etc.) — not a real community, ignore.

  The pattern: **the OpenClaw acquisition is the freshest, most legible empirical example in the agentic-tooling world of "open project gets absorbed by a frontier lab; what remains for builders is a sponsored foundation."** Hermes-migrators and Sovereign-forkers are people who have already paid a cost to act on the suspicion that this pattern repeats. They are Jinn's directly addressable recruit shape — and crucially, they do not need to be taught the problem.

- **CONFIDENCE:** medium-high.

---

### 1. Hermes / Nous Research

- **LEADER STATUS:** current, with a caveat. Hermes Agent (`NousResearch/hermes-agent`) is the mantle holder of "leading open general-purpose agent harness" as of May 2026 — 145k stars, 22k forks, 1000+ contributors, ranked #1 globally on OpenRouter token throughput (9 May 2026), surpassing OpenClaw after OpenClaw's founder sold to OpenAI in February 2026. Launched February 2026; crossed 110k stars in under ten weeks. **Caveat:** Hermes is not a coding-specific harness in the SWE-bench sense — it is a general agent with a learning loop, gateways (Telegram/Discord/Slack/WhatsApp/Signal/LINE/Email), cron, MCP, and skills. For pure code work it actively delegates to OpenCode CLI or Claude Code. If the recruit hypothesis is "ecosystem builders shipping verifiable artefacts on top of the leading open agentic harness," Hermes is the correct ecosystem for breadth and momentum; **Atropos** (the underlying RL-environments framework, 1.2k stars / 360 forks) is the more precise leader for verifiable training-artefact culture, and is the closest structural analogue to Jinn's loop.

- **WHO MAINTAINS:** four named co-founders, US-distributed.
  - **Teknium** (`@Teknium`, GitHub `teknium1`) — Head of Post-Training. Pseudonymous, ex-Stability AI. Dominant external voice for Hermes Agent; 4,246 contributions, 7× the next contributor. Author of nearly every release note.
  - **Karan Malhotra** (`@karan4d`, reads "mephisto") — Head of Behavior, co-founder. Ex-Stanford Brain Stimulation Lab. The cultural voice — WebSim/WorldSim podcast circuit, the "open-source and crypto ethos are aligned" quote.
  - **Jeffrey Quesnelle** (`@jquesnelle`) — CEO, co-founder. UMich-Dearborn MS CS. Co-author of DeMo (with Bowen Peng and Kingma) and YaRN. Less code, more research/infra.
  - **Shivani Mitra** — co-founder, low public profile.
  - **Bowen Peng** — researcher, co-author of DeMo and DisTrO; key to Psyche distributed-training.
  - Other prominent core contributors: `OutThisLife` / `@outsource_` (618 commits, built hermes-workspace), `J-SUPHA` (275 on Atropos), `shannonsands`, `dmahan93`, `interstellarninja`, `SHL0MS`, `pefontana`.

- **ARTEFACT BUILDERS (≥5):** drawn from `awesome-hermes-agent`, Atropos community environments, and current X traffic. None are core Nous maintainers.
  1. **wondelai** — `wondelai/skills` (380+ stars). Cross-platform agentskills.io skills library used by Hermes and Claude Code. Marked production.
  2. **42-evey** ("Evey") — `hermes-plugins` (goal management, inter-agent bridge, cost control), `evey-bridge-plugin` (Claude Code ↔ Hermes), `evey-setup` (29-plugin one-command install). Most prolific external plug-in author.
  3. **Lethe044** — `hermes-incident-commander` (autonomous SRE agent), `hermes-skill-marketplace`, `hermes-life-os`, `hermes-legal`.
  4. **mr-r0b0t** (`@mr_r0b0t`) — DGX Spark / GB10-tuned ComfyUI skill, publishes NVFP4-quantised models to HuggingFace alongside the skill.
  5. **GabinFay** — three Atropos community environments: `lean_proof_env` (Lean 4 theorem proving), `router_env` (multi-agent routing with MCP tools), `philosophical_rlaif_env`.
  6. **yoniebans** — `poker_holdem` Atropos environment with paired HuggingFace dataset `yoniebans/6max-nlh-poker`. Verifiable-reward + dataset-as-artefact pattern; structurally closest to Jinn.
  7. **edmundman** — `ufc_prediction_env` Atropos environment + `UFC_FIGHT_PREDICTOR` repo (7,440-record dataset).
  8. **joshuajerin** + **Tvpower** — `selcube` Atropos environment for Rubik's-cube reasoning, with publicly logged WandB curves at five difficulty levels.
  9. **outsourc-e** (`@outsource_`) — `hermes-workspace` (500+ stars). Built at Nous Hackathon 2026.
  10. **Hmbown** — `Wizards-of-the-Ghosts` (D&D-themed dev skill pack), `NemoHermes` (NVIDIA capability registry).
  11. **vivek100**, **krishpop**, **JakeBoggs**, **iyaja**, **metonym**, **jeannemtl** — additional Atropos environment builders.

  Verifiable-artefact builders comfortably ≥30 active GitHub identities; ≥10 with paired X presence.

- **STATED MOTIVATIONS:**
  - Karan Malhotra (Fortune, April 2025): *"to take the power back from people like OpenAI and Anthropic"* and *"stuff to be able to run easy for everyone"*.
  - Karan Malhotra (same): *"It's quite clear to me that the ideals of open-source and the crypto ethos are extremely aligned in having total transparency, recognizing the importance of the individual, and treating people as a node in themselves."*
  - Hermes Agent README: *"The self-improving AI agent built by Nous Research. It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions."*
  - Atropos README: *"The goal: provide a flexible, scalable, and standardized platform to accelerate LLM-based RL research across diverse, interactive settings."*
  - Teknium (recurring, 12 May 2026): *"Super grateful to the nearly 1000 contributors who've helped"* — milestone framing as community.

- **INFERRED MOTIVATIONS:**
  - **Replace OpenAI/Anthropic on cultural-moral grounds, not technical grounds.** The "take the power back" framing is shared between maintainers and the most active builders. They lost OpenClaw to OpenAI in February 2026; `hermes claw migrate` exists as a permanent monument to that defection. The community is self-consciously chasing "the agent that doesn't get acquired."
  - **Distribution-as-validation.** Teknium's feed is rank-milestones: #1 OpenRouter, 145k stars, 1000 contributors, meet-ups, Kevin Rose tweet. Recognition currency is *distribution*, not paper citations.
  - **Self-improvement identity.** The recurring builder phrase is "self-improving / skill from experience / rebuilt the skill from scratch, 3× faster." Builders gain identity from showing the agent improving its own skills.
  - **Crypto upside, kept off the main marketing surface.** Paradigm-led $50M Series A at $1B valuation; Psyche on Solana; explicit tokenless-waitlist airdrop posture. The split is deliberate — Hermes is the consumer surface, Psyche/$NOUS is the latent token-economy surface.
  - **Research output as long-term position** for Quesnelle/Peng — DeMo, DisTrO, YaRN.
  - **Identity-and-character (Karan track)** — WorldSim/WebSim, Egregore/AscensionMaze RLAIF artefacts. A parallel subculture; does not overlap cleanly with Jinn's recruit shape.

- **STATUS / RECOGNITION LOOPS:**
  - **Teknium retweet / quote-tweet.** Highest-value status event. Canonical "you have arrived" signal.
  - **Nous Research RT.** Second tier, organisational stamp.
  - **Inclusion in `awesome-hermes-agent` with a maturity tag** (`experimental → beta → production`). Maintained by `0xNyk` / `@nyk_builderz`.
  - **Star count + visibility on Hermes Atlas** (community directory, 790 stars).
  - **HuggingFace model release co-branded with Nous** — `NousResearch/DeepHermes-X-Atropos`. Highest single recognition event in the RL/training-artefact world: authoring an Atropos environment whose checkpoint becomes a published NousResearch model.
  - **Hermes Agent Jam (Discord, biweekly Tuesday 16:00 EST)** — live demo slot.
  - **Hackathon prizes** ($25k Hermes Agent Creative Hackathon, Kimi/Moonshot sponsorship, MiniMax-sponsored prizes).
  - **In-person meetups** (Seoul, NYC, Toronto in planning).

- **UNMET WANTS:**
  - **Multi-user / multi-tenant gateway control.** `alt-glitch`'s P2 issue (20 comments). Operators want to host Hermes for *other people*.
  - **Heartbeat / liveness configurability.** `thesammygit`'s gateway feature (59 comments) — busiest open thread.
  - **External / semantic memory.** Multiple competing vector-memory plug-ins (honcho, hindsight, mnemo-hermes, yantrikdb, flowstate-qmd, mempalace, mempalace-guard). Nous has not picked a canonical one.
  - **Verifiable evaluation of skill quality.** `SkillClaw` (705 stars) exists *specifically* because skills self-improve but the community has no shared way to score whether the improvement is real. **This is the most direct overlap with Jinn's evaluator-verification loop.**
  - **Reliable cross-agent handoff.** `hermes-agent-acp-skill`, `zouroboros-swarm-executors`, `opencode-hermes-multiagent`, `bigiron`, Kanban multi-agent — multiple competing approaches, no canonical winner.
  - **Native Windows + Termux + DGX hardware paths.**
  - **Cost & token-budget controls.** `42-evey`'s plugins target this directly. Community runs Hermes on $5 VPSes and serverless; cost forecasting > performance.

- **TOKEN-TOLERANCE:**
  - **Maintainer: very high, explicit, public.** Paradigm-led $50M at $1B; Psyche on Solana; explicit tokenless-airdrop posture; Karan's quote on the record. Peers in this bucket: Bittensor, Prime Intellect, Pluralis, Gensyn.
  - **Broader builder: high but bifurcated.** Two cohorts — (a) crypto-adjacent: `hermes-payguard`, `hermes-blockchain-oracle` (Solana intelligence MCP), `mercury` (multi-chain), `ripley-xmr-gateway` (Monero), `AgentCash` (x402+MPP). All on the awesome-list without controversy. (b) AI-research / dev-tooling: Atropos environment builders, skills authors, RL-curriculum people — neither pro- nor anti-crypto. No observable anti-crypto subculture (unlike HuggingFace or Claude Code orbits).
  - **Test signal:** the awesome-list (maintained by `@nyk_builderz`) accepts x402, USDC, Solana, Monero integrations as on-topic with maturity tags but no ideological filter.
  - **Implication for Jinn:** cultural distance is small. Jinn's token-and-evaluator vocabulary will land without translation overhead. The flip side: competitive overlap with Nous's own decentralised-training roadmap is real.

- **ENGAGEMENT SURFACES:**
  - **Discord:** `discord.gg/NousResearch`. "Hermes Agent Jam" recurring Tuesdays 16:00 EST. Channel topology only observable from inside.
  - **X / Twitter:** `@NousResearch`. Maintainer handles: `@Teknium`, `@karan4d`, `@jquesnelle`, `@SHL0MS`, `@outsource_`. Builder cluster: `@mr_r0b0t`, `@aadi29494`, `@kylejeong`, `@Saboo_Shubham_`, `@nateherk`, `@spicydesign`, `@zeroxkyle`, `@KamsTheCreator`, `@nyk_builderz` (awesome-list curator), `@chenzeling4` (Hermes Atlas).
  - **GitHub orgs:** `NousResearch` (hermes-agent, atropos, autonovel, hermes-paperclip-adapter, hermes-agent-self-evolution, tinker-atropos). Community: `0xNyk/awesome-hermes-agent`, `chenzeling4/hermes-atlas`. Atropos `environments/community/` is the closest structural analogue to a Jinn corpus.
  - **HuggingFace org:** `huggingface.co/NousResearch`. Releases use the `-Atropos` / `-Specialist-Atropos` suffix as recognition convention.
  - **Leaderboards:** OpenRouter token-rank (de-facto adoption). No skill-quality leaderboard — the unmet-want.
  - **Conferences / events:** Nous Hackathon 2026 (March, MiniMax + Kimi/Moonshot). Hermes meet-ups (Seoul May 2026, NYC, Toronto planned). Tool Use Podcast featured Karan April 2026.
  - **Long-form audio:** Latent Space, Practical AI #255, Tool Use, GLOSAIC.

- **CONFIDENCE:** high.

---

### 2. OpenCode (sst/opencode → anomalyco/opencode)

- **LEADER STATUS:** current leader of open-source agentic CLI coding harnesses by every visible metric. 158,846 stars, 18,575 forks, 6,621 open issues. **Distinct from the *original* "opencode"** — that was built in Go by Kujtim Hoxha (`@h_kujtim`), got rebranded as Crush (24,183 stars, now Charmbracelet), and Hoxha is now at Grafana. The current OpenCode is the TypeScript reimplementation led by Dax Raad (`@thdxr`) and the SST team, spun off into a company called Anomaly. Naming collision is a real source of confusion in 2025–26 tweets. Mantle: contested historically, decisively settled in favour of anomalyco by H1 2026. Commercially, OpenCode is at ~$25M ARR per Dax's tweet 2026-05-11.

- **WHO MAINTAINS:** Anomaly. Named staff (GitHub commits + `@anomalyco` bios): Dax Raad (`@thdxr`, founder, ex-SST, US, 2,105 commits), Adam (`@adamdotdev`, 1,860, US), Aiden Cline (`@rekram11`, 1,198, US, plugin-hooks lead), Kit Langton (`@kitlangton`, 782, US, ex-Effect ecosystem), Brendan Allan (`@brendonovich`, 250), Shoubhit Dash (`@nexxeln`, India), Jay Air (`@jayair`, 355, SST co-founder), Frank Wang (292, SST co-founder), David Hill (`@iamdavidhill`, 564), Hona (154). Heavy US concentration, JavaScript/TypeScript culture, ex-serverless infra. The `opencode-agent[bot]` is the 6th-highest committer (722) — OpenCode is being heavily developed by OpenCode itself.

- **ARTEFACT BUILDERS (≥4):**
  1. **Daniel Dislers / IndyDevDan** (`@disler`, 3,837 GH followers, Australia) — YouTube AI educator. Ships `claude-code-hooks-mastery` (3,654 stars), `aider-mcp-server` (296), `just-prompt` MCP, `infinite-agentic-loop`, `benchy`. Multi-ecosystem; motivation is channel growth + career bet ("Betting the next 10 years of my career on AGENTIC software").
  2. **Josh Thomas** (`@joshuadavidthomas`, Senior web dev @westerveltco, Django) — `opencode-agent-skills` (200), `opencode-beads` (231 — issue tracker integration). Workflow itch from day job.
  3. **Griffin Martin** (`@griffinmartin`, US) — `opencode-claude-auth` (976 stars). Most-starred third-party OpenCode plugin. "Use your existing Claude Code sub instead of paying API rates." Capture-the-frustration play; one-shot author.
  4. **Zhafron Adani Kautsar** (`@tickernelz`, Indonesia) — `opencode-mem` (674). Persistent memory via local vector DB. 31 GH followers — solo, scratching an itch.
  5. **Vlad Temian** (`@vtemian`, Timisoara, Romania) — `micode` (387, "Structured Brainstorm → Plan → Implement workflow"). Repurposed plugin hooks into an opinionated team workflow.
  6. **different-ai / Benjamin Shafii** (`@benjaminshafii`) — `opencode-browser` (403, Chrome automation), `opencode-scheduler` (339, launchd/systemd cron). Two top-100 plugins. Bio: "Fun with LLMs".
  7. **Mohak S** (`@mohak34`) — `opencode-notifier` (555). Desktop notifications.
  8. **Shady Khalifa** (`@shekohex`) — `opencode-pty` (400, PTY/background process management). Sophisticated plugin.
  9. **Bruno Brasil** (`@brunobrasilweb`) — `Codnia`, an Electron IDE with OpenCode + Claude Code as embedded terminals.
  10. **Goni Zahavi** (`@gonizahavy`) — `opencode-local-provider` (MLX-VLM, llama-swap integration). Public thanks to `@rekram11` for plugin-hooks help — Anomaly staff directly support community plugin authors.

- **STATED MOTIVATIONS:**
  - thdxr (11 May 2026): *"as of last week opencode's run rate is 15M / our goal is to hit 100M by end of year"*. Money, ambitious. Not OSS-as-passion.
  - thdxr (12 May 2026): *"v2 plugin api cost $51.32 so far, hope it's worth it!"* — treats plugin API as deliberate investment in third-party builders.
  - thdxr (1 April 2026): *"claude code source is 512K lines / opencode is 118K"* — status competition framed as efficiency virtue.
  - IndyDevDan GH bio: *"Betting the next 10 years of my career on AGENTIC software. Join the journey on YT."*
  - `@ByNskha`: *"I just canceled @claudeai MAX and switched to @opencode with the get-shit-done plugin. That thing ran for almost two hours and gave me a clear plan"* — community sentiment that OpenCode + plugins outperforms incumbents.

- **INFERRED MOTIVATIONS:**
  - **Staff:** equity in a fast-growing commercial OSS company. SST-veteran cohort doing their second startup; playbook is "open-source product, paid LLM-routing service" (OpenCode subscription). They openly discuss ARR.
  - **Plugin builders, four sub-clusters:**
    - **Status/distribution.** `opencode-claude-auth` (976 stars) shows a one-day plugin can outrank 99% of GitHub. Ecosystem page = low-effort distribution surface.
    - **Workflow scratching.** Notifications, memory, persistence, browser, scheduler — personal itches.
    - **Capture-the-anger.** `opencode-claude-auth`, `opencode-openai-codex-auth`, `opencode-gemini-auth`, `opencode-antigravity-auth` are explicitly "use your existing sub instead of API billing." Anti-rent-extraction posture.
    - **Adjacent commerce.** Daytona, Helicone, Morph, Supermemory, Sentry, JFrog, Firecrawl — SaaS vendors paying distribution tax.
  - **Across the board:** confidence that OpenCode is winning, and writing-against-the-winner is highest-EV use of OSS time right now.

- **STATUS / RECOGNITION LOOPS:**
  - Listing on `opencode.ai/docs/ecosystem/` (curated).
  - GitHub stars on a niche plugin — easy to crack 100–500 within weeks if the plugin scratches a real itch.
  - Maintainer retweets/mentions; `@rekram11` publicly thanked on Twitter by plugin authors.
  - **Hiring funnel into Anomaly.** Brendan Allan and Shoubhit Dash joined Anomaly *after* contributing visibly. `@dillon_mulroy` publicly tweeted "people ask why i don't work at opencode" — there's a known employment funnel.
  - Plugin in the "Examples" section of the official docs.

- **UNMET WANTS:**
  - Persistent memory / cross-session context (opencode-mem 674, opencode-plugin-simple-memory, opencode-supermemory).
  - **RAM / performance** — `@OmarBessa`: "charm crush 40MB / claude code 400MB / opencode 32000MB". `@wgw_eth`: "starts to eat too much RAM". Known resource problem.
  - Skill / agent / sub-agent orchestration (agent-skills, opencode-skillful, opencode-workspace, sjzsdu/OpencodePlugins, ApplauseLab — no canonical answer).
  - Auth-routing / "use my existing subscription" — frustration with both API pricing and OpenCode's own subscription.
  - Background / scheduled agents (`opencode-scheduler` 339, `opencode-background-agents`).

- **TOKEN-TOLERANCE:** Low to neutral. Maintainer cohort shows zero crypto signal — thdxr's "tokens" are LLM tokens; `@adamdotdev` tweets about the AI bubble (anti-VC, not anti-crypto); Anomaly's stack is straight infra-SaaS. Broader plugin-builder cohort is similarly silent — Indonesia, Romania, Brazil, India, Australia mix, but tweets are about workflow plugins, not chain incentives. No hostility; just absence. Crypto-flavoured plugins would not be vetoed (ecosystem is npm-driven and uncurated upstream of the docs page) but would be culturally unsurprising-coded as outliers. **Maintainer tolerance = indifference; broader-builder tolerance = permissive but unprimed.**

- **ENGAGEMENT SURFACES:**
  - `opencode.ai/discord` (official Discord, ID 1391832426048651334).
  - X: `@opencode`, `@thdxr`, `@adamdotdev`, `@rekram11`, `@kitlangton`, `@brendonovich`, `@nexxeln`, `@jayair`, `@fwang`, plus `@OpenCodeLog`.
  - GitHub org: `github.com/anomalyco`.
  - `opencode.ai/docs/ecosystem/` — curated awesome-list. Inclusion is the canonical recognition surface.
  - npm registry — `opencode-*` prefix; package.json install is the default distribution.
  - AI Engineer Code Summit (NYC 2026).

- **CONFIDENCE:** high on ecosystem shape, ARR, plugin top-ten, maintainer identities. Medium on motivation mix. Low on whether token-tolerance flips with a maintainer endorsement.

---

### 3. Aider (Aider-AI/aider)

- **LEADER STATUS:** mature, active, but vulnerable. 44,687 stars (a quarter of OpenCode's), 4,395 forks, 1,534 open issues, last commit 2026-04-25 by Paul Gauthier himself. Repo is alive — daily issue inflow, multiple model-support PRs and bug fixes in the past week. 6.8M PyPI installs lifetime. README claims "Singularity" badge of 88% — Aider wrote 88% of its own latest release. But it has been overtaken by OpenCode and Claude Code on developer mindshare; multiple 2026 tweets list Aider as "and also" rather than primary. Paul's last public X post is 2026-04-11 (a quantum optics demo), suggesting cooled public cadence even while still committing code. **Verdict: not abandoned, not contested by another maintainer, but quietly losing ground.**

- **WHO MAINTAINS:** Paul Gauthier (`@paulgauthier`). Sole effective maintainer: 12,647 commits vs 461 from all other 169 contributors combined (96% concentration). American, ex-Inktomi (search infra, late 1990s, ~$240M sale to Yahoo 2003 — consensus history, not directly stated by him). Other named contributors are peripheral patchers: ei-grad (Andrew Grigorev, Limassol Cyprus, 47), joshuavial (Joshua Vial, NZ, 32), fry69 (27), caseymcc (19). **There is no "Aider team" in any meaningful sense.**

- **ARTEFACT BUILDERS (≥4):**
  1. **Hotovo** (Slovak software company) — `aider-desk` (1,207 stars). Desktop GUI wrapper. Most-starred non-core Aider extension.
  2. **Matthew "MT" Zeng** (`@MatthewZMD`, U. Waterloo alum, "Free and Open Source Developer / Emacs Hobbyist") — `aidermacs` (893). Identity: lifelong Emacs maintainer.
  3. **Kang Tu** (`@tninja`) — `aider.el` (673). The *other* Emacs integration. Two Emacs integrations = strong signal Aider's CLI is the wrong UX for Emacs users.
  4. **Joshua Vial** (`@joshuavial`, Dev Academy Aotearoa cofounder, NZ) — `aider.nvim` (555, last push 2025-04-17 — stale). #2 upstream contributor.
  5. **Georges Alkhouri** (`@GeorgesAlkhouri`, Germany) — `nvim-aider` (375, pushed 2025-10-28). The *other* Neovim wrapper.
  6. **Jimmie Lee** (`@lee88688`) — `aider-composer` (444). VSCode extension. Solo, 31 GH followers.
  7. **Daniel Dislers / IndyDevDan** (`@disler`) — `aider-mcp-server` (296). Cross-ecosystem builder (also appears in OpenCode).
  8. **Mad Mirrajabi** (`@mirrajabi`, The Hague) — `aider-github-action` (55) + `aider-github-workflows` (36).
  9. **Matt Flower** (`@MattFlower`) — `vscode-aider-extension` (111).
  10. **Aiden Wilson** (`sengokudaikon`, Belgrade) — second-source MCP server. Community is forking the integrations.

- **STATED MOTIVATIONS:**
  - Paul Gauthier (9 Aug 2025): *"Aider v0.86.0 is out with support for all GPT-5 models, Grok-4, Flash Lite. Aider wrote 88% of the code in this release."* — self-improvement loop is the recurring beat.
  - Paul Gauthier (18 Jul 2025): *"Kimi K2 scored 59% on the aider polyglot coding benchmark. Full leaderboard:"* — Paul is a benchmark-curator.
  - Aider README: *"AI Pair Programming in Your Terminal … Aider works best with Claude 3.7 Sonnet, DeepSeek R1 & Chat V3, OpenAI o1, o3-mini & GPT-4o, but can connect to almost any LLM, including local models."* — provider-neutral CLI.
  - Matthew Zeng / Aidermacs README: *"AI Pair Programming in Emacs with Aider"* — Emacs-native identity.
  - **No ARR posts.** Paul does not publicly discuss revenue, hiring, or strategic ambition.

- **INFERRED MOTIVATIONS:**
  - **Paul:** long-arc craftsman. Already wealthy by inference, no fundraising signal, sole maintainer, doesn't engage in flame wars. Legacy-building and curiosity. Treats Aider as a research artefact — the polyglot benchmark is widely cited by model vendors.
  - **Editor-integration builders (MatthewZMD, tninja, joshuavial, GeorgesAlkhouri):** identity defence. "Emacs/Neovim still matter in the AI era." Aider just happens to be the LLM CLI that doesn't fight the editor.
  - **Hotovo (company):** commercial — productising Aider as desktop client; consulting tip-of-the-spear.
  - **One-shot extension authors:** pure workflow itch.
  - **The benchmark leaderboard is the *real* community surface.** People care less about Aider than about whether Claude 4 Opus beats Gemini 2.5 Pro on polyglot.

- **STATUS / RECOGNITION LOOPS:**
  - Aider polyglot leaderboard (`aider.chat/docs/leaderboards/`) — cited by xAI, OpenAI, DeepSeek, Anthropic. Vendor-marketing event.
  - PR merged by Paul (rare, given 96% commit share).
  - Star count on the editor integrations.
  - GH Actions / `Aider-AI/polyglot-benchmark` exercise contributions.
  - **No Discord** that I could find on the canonical landing page. Engagement is GitHub Issues and X @paulgauthier replies.

- **UNMET WANTS:**
  - **A maintained desktop / GUI front-end.** Six different community attempts (aider-desk, aider-composer, vscode-aider-extension, presidio-oss/aider-based-code-generator, p-wegner/coding-aider, etc.) — the terminal-only stance is contested by users.
  - Newer-model support, slowly shipped by Paul.
  - MCP / tool-use protocol parity with Claude Code and OpenCode.
  - Agent / sub-agent orchestration — Aider is unapologetically pair-programming with one model; community-built "agentic" forks fill the gap.
  - Leaderboard freshness — Paul has slowed updates (last seen 2025-08).

- **TOKEN-TOLERANCE:** Low, but neutrally low rather than hostile. Paul's feed has zero crypto content across 2025–26 — only benchmarks, release notes, and a quantum-optics demo. ei-grad in Cyprus reads ML-academic. Joshua Vial has a Holochain POC repo (fringe to broader crypto). None of the major artefact builders publicly identify with crypto. The Aider community is older, calmer, more academic-flavoured (Python, sole-maintainer, Apache 2.0). **Cultural register is closer to scikit-learn than to a Bittensor subnet.** No outrage; no obvious bridges.

- **ENGAGEMENT SURFACES:**
  - GitHub Issues (primary). ~1,500 open, daily inflow.
  - `aider.chat` — landing page, polyglot leaderboard (high-prestige for *model* vendors more than *builders*).
  - `Aider-AI/conventions` (191) — low-friction first contribution.
  - `Aider-AI/polyglot-benchmark` (213) — exercise contribution.
  - X: `@paulgauthier`.
  - No Discord. No conference track. No Twitter Space cadence.

- **CONFIDENCE:** high on contributor concentration, star counts, last-commit dates, named integration authors, Paul's tonality. Medium on his exact financial/equity motivation. Medium-low on tolerance under a token-incentive structure (no precedent either way).

---

### 4. OpenHands / All Hands AI

- **LEADER STATUS:** contested, leaning leader-in-its-niche. One of two or three credible open-source coding-agent harnesses (Aider, Goose, OpenCode the others). 73.2k stars, 9.2k forks, 188+ contributors. v0.9 tech report (arxiv 2407.16741): *"OpenHands is a community project spanning academia and industry with more than 2.1K contributions from over 188 contributors."* SWE-bench-Verified badge: 77.6. **Vulnerability:** Goose harness (Block) being talked about as 8× cheaper and 20× more token-efficient on Terminal Bench 2.0 by Alex Hancock (`@alexjhancock`, 4 May 2026). All Hands has therefore pivoted commercial energy into "Agent Control Plane" (Enterprise) and the "OpenHands Index" — a public LLM-on-SWE benchmark — to defend research-leadership posture rather than win on harness performance alone.

- **WHO MAINTAINS:** Graham Neubig (`@gneubig`) — CMU professor, founder/Chief Scientist, public face. Robert Brennan — co-founder/CEO (low public signal). Xingyao Wang (`@xingyaoww`) — first author of the OpenHands paper, top human committer (622). Engineering core: `@rbren` (Brennan, 478), `@tofarr` (570), `@hieptl` (402), `@amanape` (376), `@malhotra5` (353), `@enyst` (328), `@mamoodi` (297), `@li-boxuan` (142), `@tobitege` (127), `@SmartManoj` (104). Geography: CMU (Pittsburgh) for research head, distributed engineering. Org has a recognisable "Agentic AI Engineer" role — Raj Istics (`@rajistics`) does devrel.

- **ARTEFACT BUILDERS (≥4):**
  1. **NovaSky-AI / SkyRL-OpenHands** — Berkeley SkyLab fork wiring OpenHands into RL training pipelines. Active separate org.
  2. **TheAgentCompany** — CMU-anchored evaluation harness (workplace-task benchmark) treating OpenHands as a first-class evaluation client.
  3. **`@apurvasgandhi` (Apurva Gandhi)** — first author of *Recursive Agent Optimization* (May 2026), built on OpenHands and retweeted by Neubig as the canonical example.
  4. **`@aurickq` (Aurick Qiao, Snowflake AI Research)** — Arctic Inference vLLM plugin: "4× faster LLM inference for coding agents like OpenHands." Vendor-side builder.
  5. **SKILL.md plugin authors** — Anthropic-driven format now adopted by OpenHands alongside Cursor, Goose, Gemini CLI, Copilot, Codex (per `@AIXPROtools`: *"37 agents. 1 skill format."*). `@hsnice16` (Himanshu Singh) ships an Agent Skill that scores codebases and recommends which harness performs best.
  6. **openhands-resolver workflow forks** — voyagegroup (Japan), proventheory/AI-Factory, Sunwood-ai-labs/MysticLibrary, ThunderAgent-org, NovaSky-AI. Sustained long-tail builder pool, mostly Japanese and US small-shop devs.

- **STATED MOTIVATIONS:**
  - OpenHands paper (arxiv 2407.16741): *"OpenHands is a community project spanning academia and industry."*
  - Neubig (`@gneubig`, 30 Apr 2026): *"Really excited about this release! I think it's one of the best ways to run and monitor agents fully locally on your own cluster, and we're adding a bunch of new features to help with agent self improvement and context management as well."*
  - OpenHandsDev (6 May 2026): *"Running agents on laptops is phase 1. Phase 2 is who controls what they access, what they cost, and when they run. That's the Agent Control Plane."*
  - Community call (7 May 2026): *"project updates, demos of what's new, contributor shout-outs, and open Q&A with the community."*

- **INFERRED MOTIVATIONS:**
  - **Core:** protect "open-source Devin alternative" position against the commercial wave (Cursor, Copilot, Claude Code) while monetising Enterprise (Agent Control Plane).
  - **Research-adjacent contributors:** paper publications with OpenHands as substrate (Recursive Agent Optimization, SkyRL, TheAgentCompany). Citations and CMU/Berkeley group affiliation are the currency.
  - **Vendor-side contributors:** name-checked in OpenHands releases as inference partner.
  - **Long-tail resolver forkers:** working agent-CI without a closed vendor; resolver is a credible CI substrate.
  - **The Index/benchmark posture** is a deliberate move to convert "we're the leaderboard" into "we're the kingmaker for model launches" — a recognition loop flattering frontier labs while keeping OpenHands central.

- **STATUS / RECOGNITION LOOPS:**
  - **SWE-bench-Verified rank** (the public 77.6 badge), Terminal-Bench, the OpenHands Index.
  - **Paper citation** — arxiv tagged with OpenHands, Neubig retweets, conference acceptances.
  - **"Contributor shout-outs"** on the monthly community call.
  - **GitHub stars** (73k); Neubig publicly shared "OpenHands authored ~60% of commits to openhands-resolver and ~20% of main repo" in Nov 2024 — itself a status post.
  - **Talks at academic venues** (Neubig at Amazon Research Day).
  - No public token, badge, or sponsorship registry beyond Slack ranks.

- **UNMET WANTS:**
  - GitLab/BitBucket parity — Neubig publicly griped "github has been pretty difficult to work with recently" (29 Apr 2026).
  - Cheaper / smaller / open-weight models that perform on SWE tasks — Index tracks open-model trajectory.
  - Self-improvement / skill-discovery infra (Neubig: *"Phase 2 is who controls what they access, what they cost, and when they run."*)
  - **Reproducible benchmarking across harnesses** — Goose/OpenHands token-efficiency disputes show this is unsolved.
  - Agent-team / sub-agent orchestration (Recursive Agent Optimization, agent profiles, Agent Control Plane all point here).

- **TOKEN-TOLERANCE:** low-to-medium and downside-asymmetric. **Maintainer level:** CMU-anchored, academic publishing track, no evidence of any crypto association in `@gneubig` or `@OpenHandsDev` feeds across hundreds of recent posts. The Enterprise / Agent Control Plane commercial wedge competes for the same buyer crypto-paid-tools target. **Broader builder pool:** heterogeneous — long-tail resolver forks are crypto-indifferent, but academic researchers (NovaSky, TheAgentCompany, RAO) treat "crypto coding tool" as a credibility liability. Approach as verifiability and post-training-data infrastructure story, not as crypto.

- **ENGAGEMENT SURFACES:**
  - **OpenHands Slack** (linked from `@OpenHandsDev`, `slack.openhands.dev`).
  - **GitHub org:** `All-Hands-AI/OpenHands`, `openhands-resolver`, `openhands-aci`, `OpenHands-Cloud`, swe-bench fork, `swe-bench.github.io`.
  - **Monthly Community Call** (12:00–13:00 ET Thursdays).
  - **OpenHands Index** landing, `docs.openhands.dev`, arxiv 2511.03690 (latest tech report).
  - X: `@OpenHandsDev`, `@gneubig`, `@xingyaoww`.
  - **CMU LTI seminar circuit.** Conference adjacency: NeurIPS, ICLR, ACL agent tracks. No conference of their own.

- **CONFIDENCE:** medium-high. Strong on maintainer identity, motivations, recognition loops. Weaker on the long-tail SKILL.md author pool.

---

### 5. Cline

- **LEADER STATUS:** current leader by distribution; vulnerable on infrastructure rebuild. ~62k stars, 6.4k forks, **4,704% YoY contributor growth** (DataChaz, Feb 2026, "Fastest AI project on GitHub"). VS Code Marketplace installs in the millions (referenced repeatedly: *"Cline is what ChatGPT feels like it should have been from day one"*, Xavier Berard; *"Cursor is officially almost dead"*, `@dunik_7`). 30 Apr 2026 announced from-scratch rewrite with plugin architecture: *"We spent the last two months rewriting Cline from the ground up… we built it extension-first for the IDE… the architecture got tightly coupled to IDE semantics, which made it painful to evolve the harness for the CLI and to extend into things like flexible agent profiles and agent teams… built an SDK with better performance and token efficiency, with a plugin architecture for providers, models, LSPs, code search, themes, all of it."* **Roo Code (largest fork) shut down and merged back to Cline (21 Apr 2026):** *"Roo contributed to our community more than any other fork."* Vulnerability: live rebuild — beta channel paying $20 credits + bounties to fix breakage. Saoud (`@sdrzn`) leans on *"era of free tokens is ending"* (28 Apr 2026) as justification for paid Cline credits.

- **WHO MAINTAINS:** Saoud Rizwan (`@sdrzn`) — founder, US. Cline Bot Inc. (Apache 2.0). Top committers: `@saoudrizwan` (1920), `@abeatrix` (774), `@celestial-vault` (374), `@arafatkatze` (279), `@sjf` (272), `@pashpashpash` (207, dormant on X since 2023 — handle may be inactive), `@canvrno` (204), `@BarreiroT` (170), `@0xToshii` (149), `@robinnewhouse` (119, Canada), `@candieduniverse` (80), `@maxpaulus43` (66). Geographies: US-heavy with Canada (robinnewhouse, pashpashpash). Community/devrel: `@nickbaumann98`.

- **ARTEFACT BUILDERS (≥4):** Cline's primary plug-in surface is the **MCP marketplace** (`github.com/cline/mcp-marketplace`, 767 stars, 1.4k open issues, one-click install). Recent submissions:
  1. **`@0xDespot` (US)** — `hyperD v1.0`: 12 paid x402 endpoints + MCP server "drops them straight into Claude Desktop / Cursor / Cline." USDC settlement on Base in ~2 seconds. *"AI agents pay per call instead of registering for API keys. no human in the loop, no OAuth — the signed USDC payment IS the auth."* 23 MCP tools, npm-distributed. Explicit crypto/x402 builder, voluntarily targeting Cline by name.
  2. **`@adityaaidev` (Aditya Gaurav, India)** — `OpalServe v3.4`: self-hosted MIT, "smallest possible fix" for MCP config drift across teams using *"Claude Desktop, Cursor, or Cline."* Sustained May 2026 promotion campaign targeting Cline users.
  3. **`@kiwuuu10` (Serbia)** — first open-source MCP server for Claude Design: *"Paste a handoff URL in Cursor / Claude Code / Cline → bundle materializes in your project. Four tools, ~400 LOC, MIT."*
  4. **`@jackwang3327289`** — `hou-tea/mcp-server`: *"likely the first commerce MCP that pays with real USDC on-chain via x402."* Same x402-into-Cline pattern.
  5. **`@ai_studioxyz / @CatalayerAI`** — MCP Doctor: diagnostic tool for broken MCP configs across "Claude Desktop, Cursor, VS Code, Cline, and AI agents."
  6. **`@DivjakNemanja`** — JustPayAI MCP Server: 45 tools for AI agents to "hire, pay, and get paid — autonomously."
  7. **From the 10–12 May submission queue:** Larshiensch99 (PriceParse), AEGISGOVDAO (SAM.gov contracts), thymikee (agent-device), vibecode1 (household financial distress data), ratamaha-git (n8n-mcp), corewebvitals (CoreDash), eltociear (skill-audit-mcp), hogan-yuan (Longbridge brokerage MCP), carasjung (Korean entertainment data), hlorus (vitrine 3D viewer), goww7 (Halal Terminal — Shariah-compliant screening), dtkmn (MCP ZAP Server). **Submission surface is highly active and crypto-tolerant** — multiple finance/DAO/x402/brokerage entries openly submitted.

- **STATED MOTIVATIONS:**
  - Cline (30 Apr 2026): *"We are offering $20 in credits to get started, plus a bounty program for contributors who help us fix bugs and make plugins. Join the #beta channel in our Discord and build with us!"*
  - Marketplace README: *"Submit your MCP servers for others to easily discover and one-click install with Cline."* Vetting criteria stated as *"Community Adoption", "Developer Credibility", "Project Maturity", "Security Considerations"* with *"heightened scrutiny for sensitive domains like finance and cryptocurrency."*
  - Saoud (28 Apr 2026): *"the era of free tokens is ending."*
  - Saoud (7 Apr 2026): *"You optimized for speed. Your vendor optimized for lock-in. One of you got what they wanted. If swapping your inference provider requires touching more than your config layer, you've already accumulated debt."*

- **INFERRED MOTIVATIONS:**
  - **One-click install + millions of users = distribution that no other coding-agent harness offers.** The marketplace is the *only* MCP registry with a real install path.
  - **Apache-2.0 + bring-your-own-key** stance means agents written for Cline run anywhere, lowering author-side platform risk.
  - **Crypto/x402 builders target Cline because Cline is OpenAI/Anthropic/Coinbase-agnostic** and lets x402 settle without OAuth. Saoud's "lock-in" rhetoric is doctrinally compatible with their payment-instead-of-API-key stance.
  - **Roo migration + bounty programme** = "we will pay you to extend us."
  - **Most builders not motivated by research credibility** (unlike OpenHands) — they're motivated by SaaS distribution, token-monetisation, or "I built a tool I needed."

- **STATUS / RECOGNITION LOOPS:**
  - Marketplace acceptance — one-click install = public visibility + recurring traffic.
  - Bounty / credits payouts during rewrite beta.
  - Cline RTs on `@cline` timeline (very active retweeter of community plugin announcements).
  - Discord roles in #mcp, #beta, #roo-migration.
  - GitHub-star spillover from Cline's visibility.
  - Embedding in `@sdrzn`'s "vendor-lock-in is debt" thesis posts — quote-alignment gets RT'd.
  - **No public leaderboard or paper-track recognition; loops are commercial and audience-driven.**

- **UNMET WANTS:**
  - Token efficiency vs. cost.
  - Multi-agent orchestration that survives the IDE/CLI boundary — the rewrite is explicitly to fix this.
  - MCP config drift across teams (OpalServe is filling this).
  - **Pay-per-call infrastructure for agents** (x402 builders are filling this).
  - MCP debuggability (MCP Doctor).
  - Persistent memory / workspace state across cards (Cline Kanban is the company answer; users keep asking for cross-task memory).
  - Open-source / open-weight model parity (Cline shipped Kimi K2.6 free for 3 days as a soft endorsement).

- **TOKEN-TOLERANCE:** medium-high and rising. **Founder:** Saoud is crypto-quiet but visibly tolerant — never names a token but routinely RTs builders working with x402, USDC settlement, and Base. Marketplace README has *"heightened scrutiny for sensitive domains like finance and cryptocurrency"* — scrutiny, not exclusion; finance MCPs and `@0xDespot`, `@jackwang3327289`, `AEGISGOVDAO` are accepted in the live queue. **Broader pool:** openly crypto-friendly. **This is the only coding-agent ecosystem in our sample where x402 + USDC + Base appear in builder marketing without apology.** For Jinn, this is the lowest-friction substrate among coding-agent ecosystems.

- **ENGAGEMENT SURFACES:**
  - Discord — canonical channel; named channels: `#beta`, `#mcp`, `#roo-migration`.
  - GitHub org: `cline/cline`, `cline/mcp-marketplace`, `cline/cline-docs`.
  - VS Code Marketplace listing (`saoudrizwan.claude-dev`).
  - `r/cline` on Reddit.
  - X: `@cline`, `@sdrzn`.
  - **The MCP marketplace issue queue is the de-facto recruiter funnel** — submission is a public, low-friction act, queue is heavily watched.
  - No conference track; no academic adjacency; no leaderboard.

- **CONFIDENCE:** high on builder pool, motivations, token-tolerance. High on Saoud. Medium on co-maintainer set (low public profile).

---

### 6. ERC-8004 ecosystem

- **LEADER STATUS:** ERC-8004 is the canonising agent-identity standard on Ethereum. Not "one of three competing standards" in any meaningful sense. ERC-7857 (0G Labs, AI-agent NFTs with private metadata) addresses a different problem. Google's A2A protocol is complementary, not competitive — the EIP positions itself as a trust layer above A2A. Standard went live on Ethereum mainnet on 29 January 2026 (Identity + Reputation registries shipped, Validation Registry under development). AgentScan reports 211k+ registered agents across 22 networks, 14k weekly active. Crapis: *"75+ projects have reached out or signaled interest"* three weeks after publication. **No real competitor; contest is over *what builds on top*.**

- **WHO MAINTAINS / CHAMPIONS:** EIP authors are **Marco De Rossi** (`@marco_derossi`, MetaMask), **Davide Crapis** (`@DavideCrapis`, Ethereum Foundation dAI Team lead), **Jordan Ellis**, **Erik Reppel** (Coinbase). ChaosChain (Crapis's commercial vehicle) maintains the reference implementation, Genesis Studio commercial prototype, and `chaoschain-sdk-ts`. **Vitto Rivabella** (`@VittoStack`, EF dAI team) named alongside Crapis on RT chains. **ENS Labs** has published a stated endorsement framing ENS as the canonical name layer. **EF Privacy Team** (`@PrivacyEthereum`) shipped ACTA (Anonymous Credentials for Trustless Agents). The Magicians thread shows engaged commenters: leonprou, spengrah, felixnorden, sbacha, mlegls, daniel-ospina, pcarranzav, KBryan.

- **ARTEFACT BUILDERS (≥5, classified real vs token-pump):**
  - **agent0 Lab** (`@agent0lab`, Spain — `agent0lab/agent0-ts` + subgraph) — **REAL BUILDER.** TypeScript SDK + indexing subgraph. Feed is technical: agent security threat models, MCP-client roadmap, ZK skills, A2A+x402 composition. No token. Cleanest profile in the cluster.
  - **ChaosChain** (Crapis's company) — **REAL BUILDER but founder-aligned.** Reference implementation, USDC-payment commercial prototype, SDK. Default gravitational centre.
  - **Phala Network** (`@PhalaNetwork`) — **REAL BUILDER.** ERC-8004-compliant TEE agent with TEE-registry extension on Phala Cloud. Feed leans on TEE economics and confidential compute partnerships. Has its own token but the feed reads as infra-positioning, not pump.
  - **AgentScan** (`@agentscan_info`) — **REAL BUILDER with marketing veneer.** Singapore-source. ERC-8004 explorer with REST API, MCP server, agent scoring (Service/Freshness/Profile), OASF taxonomy. Posts daily ecosystem stats. Some emoji noise but no token, real product.
  - **8004scan** (`@8004_scan`, 8004scan.io) — **REAL BUILDER.** Singapore. Explorer + "CryptoSkill" (MCP-server registry) + AltLLM (natural-language interface to on-chain agent data). No token.
  - **Nexum** (`@trynexum`) — **REAL BUILDER.** Two-contract protocol on Base Sepolia combining ERC-8004 (identity/reputation) with ERC-8183 (escrow). Models three-party jobs (client/provider/evaluator) where evaluator can be *"an LLM agent, ZK verifier circuit, multisig, or any on-chain address"* and attestation feeds back into 8004 reputation. **Closest existing project to Jinn's loop semantics.** No token mentioned.
  - **Roman Krutovoy** (`@krutovoy`, spawnr CLI + `@mandate_md`) — **REAL BUILDER.** Indonesia/Germany. Spawnr is a CLI for agent discovery against the 8004 registry — Marco De Rossi RT'd it as a missing primitive. Mandate.md is a wallet-policy/observability layer.
  - **EF Privacy Team — ACTA** (`@PrivacyEthereum`) — **REAL BUILDER, institutional.** Anonymous Credentials for Trustless Agents: composable privacy layer above 8004. Endorsed publicly by Crapis and Marco De Rossi.
  - **Eversmile12** (`Eversmile12/create-8004-agent`) — **REAL BUILDER.** `npx create-*` scaffolder for blockchain-registered agents (A2A + MCP + ERC-8004 + USDC across EVM and Solana).
  - **QuantuLabs** (`8004-solana` + `8004-solana-ts`) — **REAL BUILDER.** Solana port.
  - **AIBTC.dev** (`aibtcdev/erc-8004-stacks`) — **REAL BUILDER.** Minimal Clarity port for Stacks.
  - **Stephen-Kimoi + JudyaiLab** — **MIXED.** Real GitHub artefacts but framing skews to performance-marketing.
  - **Helixa** (`@helixaxyz`, $CRED) — **TOKEN PUMP.** Wrote a reputation oracle but feed is *"182m in $CRED rewards & 2x Gems boost"* contests on `@Velvet_Capital`. Confirmed failure case per the audience-profile §3 filter.
  - **The Spawn** (`@Thespawn0a`, $SPWAN) — **TOKEN PUMP on a real artefact.** Directory itself (largest registry of 8004 agents across 27 chains, integrates Krutovoy's spawnr CLI) is genuine; the public feed is dominated by $SPWAN price-talk.
  - **HeyElsa** (`@HeyElsaAI`, $ELSA) — **TOKEN PUMP.** Promoter constellation: `@ray_bam01`, `@Nick_Researcher`. Not a real builder.
  - **StrikeRobot ($SR), AEON, GOAT Network, Likwid** — **MIXED-to-TOKEN-PUMP.** ERC-8004 as one bullet in larger flywheel narratives.

- **STATED MOTIVATIONS:**
  - EIP: *"To foster an open, cross-organizational agent economy, we need mechanisms for discovering and trusting agents in untrusted settings."*
  - **EIP: *"Validator incentives and slashing are managed by specific validation protocols."* And *"Payments are orthogonal to this protocol and not covered here."*** **The standard explicitly excludes the economics layer — structurally identical to Jinn's lane.**
  - Crapis (Sep 2025): *"Over 2,000 community members have viewed and discussed the proposal on the public forum. 75+ projects have reached out or signaled interest in building on top."*
  - ENS Labs: ERC-8004 *"already provides a shared naming standard that many of these ideas can build on"* — without identity, *"how to securely pay an agent or how to know which version is being used"* remain unanswered.
  - Pinata blog (Matthias Jordan): *"We're entering an era of autonomous agents. These systems can act on our behalf, coordinate with others, and make decisions for us. But how do we find agents we can trust?"*
  - Nexum (`@trynexum`): *"the evaluator doesn't have to be human. an LLM can review the work. a ZK circuit can verify the output. a multisig can attest the outcome. AI hiring AI. AI paying AI. AI judging AI. no human required."*
  - Magicians thread consensus: *"Trust is not a universal value of Bob, but a vector from Alice to Bob"*; *"Creating a single (aggregate) reputation score is dangerous… compressing too much into a single metric facilitates monopolistic behaviour."*

- **INFERRED MOTIVATIONS:**
  - **(1) Capture of agent-economy primitives on Ethereum, before the OpenAI/Stripe/Google ACP+AP2 stack absorbs that role.** The dAI team's branding, the Chinese tour, XLayer co-marketing, ACTA — all read as a coordinated bid to make Ethereum the default identity substrate for autonomous economic actors before Coinbase's AP2 or Stripe's Agentic Commerce Protocol settles a centralised alternative.
  - **(2) Compose-onto-Ethereum optionality for AI infrastructure.** agent0lab, Phala, Nexum pitch SDKs, escrow contracts, TEE-runtime layers — the bet is ERC-8004 becomes the substrate all agent infra terminates against, similar to how ERC-20 became the substrate every fundraising mechanism touched.
  - **(3) The validator/reputation economics gap is felt as a real product opportunity, not just a spec footnote.** The Magicians thread, BlockLayer/EigenAI piece, Marcello Politi's profit-driven red-teaming paper (co-authored with Crapis), and Nexum's first-class evaluator role all converge: the registry-as-coordination-layer model needs a paid, slashable validator tier and nobody has shipped one. **This is Jinn's natural bridge.**

- **STATUS / RECOGNITION LOOPS:**
  - **Being referenced by Crapis or Marco De Rossi by name, RT, or retweet** — confers near-immediate ecosystem legitimacy.
  - Being cited in the EIP Magicians thread by name.
  - Being indexed by 8004scan or AgentScan with a high "score" — leaderboard dynamic forming.
  - Devcon/Devconnect/ETHCC stage time on agent-economy tracks.
  - **Token launch with a "trustless agents" narrative** — *this is the failure mode*. Loudest noise, lowest reputation among real-builder subset.
  - Reference-implementation contributions to `ChaosChain/trustless-agents-erc-ri` or `vyperlang/erc-8004-vyper`.

- **UNMET WANTS:**
  - **Validator/evaluator economics with stake and slashing.** Explicitly deferred by the EIP; explicitly asked for in Magicians (*"a way to give incentive to validators to be honest during validation"*); framed in BlockLayer/EigenAI as *"stake-secured re-execution"*; Politi's paper (with Crapis) makes empirical case agents are exploitable without it. **This is Jinn's exact natural bridge. No one in the cluster has shipped a credible validator-economics layer yet.**
  - **Payment + escrow primitives.** Magicians: *"how would funds be escrowed in this scenario?"* Nexum's ERC-8183 + 8004 combination is the closest answer.
  - **Composability of validation results on-chain.** Magicians: *"I don't see a way in the current standard for an arbitrary smart contract to read the result of a validation response."*
  - **Sybil-resistant reputation that isn't a single aggregate score.** Cluster discomfort with single-score framing is explicit; people want context-dependent / requester-relative vectors.
  - **Agent discovery that isn't just scraping the registry** — Krutovoy's spawnr emerged exactly because *"discovery of ERC-8004 agents is still open question."*
  - **Proof of model provenance** — surfaced by ACTA. Adjacent to Jinn's training-data thesis.

- **TOKEN-TOLERANCE:** Cluster is crypto-native by construction so tokens aren't disqualifying in principle — Phala has a token and reads as a real builder; ChaosChain takes USDC. But the cluster *does* distinguish, and the distinction maps cleanly: real-builder norm is **ship SDKs/CLIs/contracts/explorers first, talk about economics second, never lead with price or contests**. Token-pump norm is lead every post with $TICKER, run trading contests, frame ERC-8004 as the "next narrative." **Crapis, De Rossi, and the dAI team studiously avoid endorsing any token project by name; they RT tooling (spawnr, ACTA, agent0lab, Phala TEE).** When token-projects tag them, engagement is one-sided. The clearest in-cluster signal that a project is in the wrong bucket: whether Crapis or De Rossi has publicly endorsed it. Almost none of the token-pump projects clear that bar.

- **ENGAGEMENT SURFACES:**
  - **GitHub orgs:** `github.com/erc-8004` (curated registry contracts), `github.com/ChaosChain`, `github.com/agent0lab`, `github.com/Phala-Network`, `github.com/vyperlang`, `sudeepb02/awesome-erc8004`.
  - **EIP discussion:** `ethereum-magicians.org/t/erc-8004-trustless-agents/25098` — still active, technical, the right place to surface validator-economics work.
  - **Explorers / leaderboards:** `8004scan.io`, AgentScan.
  - **Real-builder X handles:** `@DavideCrapis`, `@marco_derossi`, `@VittoStack`, `@agent0lab`, `@PrivacyEthereum`, `@PhalaNetwork`, `@trynexum`, `@krutovoy`, `@agentscan_info`, `@8004_scan`, `@Marcello_AI`.
  - **Hackathons / conferences:** Devconnect Buenos Aires agent-economy tracks, ETHCC, Casual Hackathon (`CasualHackathon/TrustlessAgents`), IntensiveCoLearning on GitHub, ICLR/AAMAS workshops where Crapis et al. publish red-teaming papers. dAI team has XLayer co-marketing + China tour.
  - **No prominent Discord or Telegram surfaced as canonical for the standard itself** — conversation in Magicians threads, on X, and inside individual project Discords (ChaosChain, Phala, agent0lab).

- **CONFIDENCE:** high.

---

### 7. Continue.dev

- **LEADER STATUS:** contested. ~33k stars, venture-backed (Continue, Inc, SF). One of three or four credible open-source IDE-agent extensions alongside Cline/Roo and Aider. **Continue Hub** launched in 2025 as a public artefact registry for assistants and blocks (models, rules, prompts, MCP, data) — a Hugging-Face-style distribution surface competitors largely lack. Not declining; not dominant either.

- **WHO MAINTAINS:** Founder/CTO **Nate Sesti** (`@NateSesti`, SF, 9,634 commits). Co-maintainers RomneyDa (3,014), Patrick-Erichsen (founding engineer, 1,979), tomasz-stefaniak (1,090), TyDunn (head of community, 579). Bekah Hawrot Weigel (BekahHW) and bdougie on devrel/community. US-based, SF.

- **ARTEFACT BUILDER:** **Daniel Rosehill** (`@danielrosehill` on GitHub, Jerusalem, "DSR Holdings"). Publishes `readme-author` on Continue Hub, maintains `danielrosehill/Continue-Dev-Blocks`, wrote the official Continue blog post *"Creating Rule Blocks on Continue Hub: A Developer's Guide."* Also publishes a 937+ system-prompt library at `prompts.danielrosehill.com`, `RooCode-Mode-Prompts` (21 stars), multiple MCP servers (Google Workspace, Cloud-ASR, Gemini-Transcription). **Cross-ecosystem prolific solo builder.**

- **STATED MOTIVATIONS:** Profile: *"Focus: Agentic AI, MCP, and workflow automation (esp. voice assisted). Exploring: multiagent use-cases for AI & geopol sims."* Prompts site: *"A personal collection of 937+ system prompts I've developed over the past couple of years for AI assistants, autonomous agents, and specialized chatbots... Open source and free to use - attribution appreciated but not required."* — democratisation framing, attribution-light. dev.to bio: building *"an open-source platform that assists with the full breadth of professional GPT work."*

- **INFERRED MOTIVATIONS:** Personal knowledge-management problem made public. Prolific output across Continue, Roo, MCP and HF suggests **platform-agnostic taste-maker positioning** rather than allegiance to one ecosystem. Independent (DSR Holdings is his own holding entity), so reputation accrual and brand-as-portfolio is plausibly dominant. Not chasing venture validation or academic citation. Closer to a "publish-everything, see what catches" practitioner-influencer.

- **STATUS / RECOGNITION LOOPS:** Continue Hub author page (creator-of-record on assistants and blocks); Continue's own blog (he wrote their rule-blocks guide); GitHub stars; dev.to following; personal blog and Medium; Hugging Face Spaces. **Multiple weak loops, no single dominant one.**

- **UNMET WANTS:** No verbatim "I wish" hit, but the surface area of his work — system-prompt library, MCP servers, blocks for multiple ecosystems — implies frustration with prompts trapped in private chats and a desire for **portable, versioned, citeable artefacts**. Likely receptive to anything making a published artefact more measurable.

- **TOKEN-TOLERANCE:** Continue itself is venture-backed (no policy friction either way). Rosehill is independent and ships across web3-adjacent corners (open MCP, HF, voice — no obvious crypto allergy). **Low-to-medium friction; a token wouldn't be a dealbreaker but he isn't visibly looking for one.** Treat as neutral.

- **ENGAGEMENT SURFACES:** GitHub (active, primary), dev.to, Medium, personal site (`danielrosehill.com`), Hugging Face Spaces, Continue Hub author page. No Twitter handle on GitHub profile.

- **CONFIDENCE:** medium-high.

---

### 8. Roo Code

- **LEADER STATUS:** contested-trending-up. Fork of Cline (originally "Roo Cline"), ~24k stars on `RooCodeInc/Roo-Code`. Same cluster as Cline/Aider/Continue but its **mode/custom-instructions surface** (`.roomodes`, custom modes, "Footgun" deep customisation) is the most pluggable of the cohort. Independent (RooCodeInc), no obvious VC tether. *Note: per Cline announcement 21 Apr 2026, "Roo contributed to our community more than any other fork" and largest Roo fork shut down and merged back. Cross-check with Cline section above — this surface is in flux.*

- **WHO MAINTAINS:** Top contributors mrubens (2,059), saoudrizwan (962 — the original Cline author), cte (716), daniel-lxs (444), hannesrudolph (351), samhvw8 (127), KJ7LNW (54), ColemanRoo (42). Org: RooCodeInc. Mixed geography (North America + Europe); doesn't foreground a single founder face.

- **ARTEFACT BUILDER:** **GreatScottyMac** (anonymous GitHub identity — no bio, no Twitter, no location). Ships three of the highest-starred Roo extensions:
  - `roo-code-memory-bank` (1,674 stars) — mode rules + memory file structure for persistent project context across sessions.
  - `RooFlow` (1,152) — "Enhanced Memory Bank System with Footgun Power", five integrated modes.
  - `context-portal` / ConPort (762) — SQLite-backed MCP memory server compatible with Roo, Cline, Cursor, Windsurf.
  - Apache 2.0. Treated as quasi-canonical by parts of the Roo community.

- **STATED MOTIVATIONS:** `roo-code-memory-bank` README: *"Roo Code Memory Bank solves a critical challenge in AI-assisted development: maintaining context across sessions. By providing a structured memory system integrated with VS Code, it ensures your AI assistant maintains a deep understanding of your project across sessions."* — pure utility framing, no manifesto. ConPort README: *"ConPort is your project's memory bank... a tool that helps AI assistants understand your specific software project better by storing important information like decisions, tasks, and architectural patterns."*

- **INFERRED MOTIVATIONS:** Anonymous handle + no bio + Apache 2.0 + heavy diagrams reads as a maintainer who cares about the artefact, not the audience. Scratching a workflow itch (context loss between sessions) that turned out to be load-bearing for others. Progression memory-bank → RooFlow → ConPort (markdown → mode system → MCP server with vector embeddings) is a serious technical trajectory: this is a builder upgrading their own infra in public. Plausible drivers: craft satisfaction, signal-to-employers despite anonymity, standard FOSS dopamine.

- **STATUS / RECOGNITION LOOPS:** GitHub stars (3,500+ cumulative across three repos); cross-tool adoption logos in ConPort README (Roo, Cline, Cursor, Windsurf); a RooCodeInc discussion thread proposing memory bank be implemented directly in Roo Code references this work as the de-facto pattern. **No social media; recognition is entirely artefact-pull.**

- **UNMET WANTS:** No "I wish" verbatim. **Open issue #40 on `roo-code-memory-bank`** is titled *"Should there be a Standard for memory banks?"* — the maintainer is publicly entertaining standardisation, which is exactly the want a verifiable-artefact protocol could meet.

- **TOKEN-TOLERANCE:** Roo independent, no policy friction. GreatScottyMac is anonymous, which is *itself* a signal: **pseudonymity-tolerance is high, and crypto-native protocols are unusually friendly to that posture.** Low friction; possibly high latent fit.

- **ENGAGEMENT SURFACES:** GitHub Issues and Discussions (the only known surface). No Twitter, no blog, no Discord profile linked. Outreach has to be via GitHub.

- **CONFIDENCE:** high on artefact-shape and README-revealed motivations; medium on the human behind the handle (deliberately opaque). Token-tolerance inferred from pseudonymity, not stated.

---

### 9. Goose (Codename Goose)

- **LEADER STATUS:** niche-but-funded. 45k stars, made by Block (Square / Cash App), Apache 2.0. Distinct posture from Continue/Roo because Goose is a **general-purpose desktop agent (not an IDE extension)** with first-class MCP support and a "recipes" system. Stars are high but developer-tool mind-share is lower than Continue/Roo because the surface is broader and less codified.

- **WHO MAINTAINS:** Top contributors zanesq (255), alexhancock (Alex Hancock, 249), michaelneale (Mike Neale, 212, prominent Block engineer), DOsinga (Douwe Osinga, 209 — ex-Google, well-known author), angiejones (Angie Jones, 205, Block devrel VP, US), jamadeo (191), blackgirlbytes (Rizel Scarlett, 183, was at Block, now @EntireHQ), dianed-square (Diane), lifeizhou-ap, lilydelalande, EbonyLouis, yingjiehe-xyz. Strong Block-heavy bench plus visible DevRel faces. US-centric.

- **ARTEFACT BUILDER:** **Arya Pratap Singh** (`@ARYPROGRAMMER`, Mumbai / IIIT Ranchi, pre-final-year undergrad, ex-Acumensa intern, blog at `aryapratapsingh.xyz`, X `@ARYPROGRAMMER`). **Six merged recipes** in `block/goose` (code-review-mentor plus five others) — the largest external contribution to the recipes corpus, ahead of the-matrixneo (4), Better-Boy (4), and Angie Jones (4, internal). Side-projects: Next.js video-gen SaaS, DSA learning app on CopilotKit, mental-wellness app, legal-document reviewer.

- **STATED MOTIVATIONS:** GH bio: *"ex-Full Stack Intern @AcumensaTechnologies | Pre-Final Year @IIITR | Working for Society."* `code-review-mentor` recipe: *"An intelligent code review assistant that learns your preferences and provides personalized, actionable feedback on code changes with improvement suggestions."* — pure utility framing.

- **INFERRED MOTIVATIONS:** Classic high-output Indian engineering-student profile: **portfolio-stacking for early-career placement / international internships**. Repo titles read as deliberately resume-shaped (each project a self-contained "I built X with Y stack"). Recipes for Goose specifically are cheap-to-write, high-prestige-per-effort artefacts (your name lands inside Block's official cookbook). Plausible drivers: status with hiring managers, a shot at Block or a Block-adjacent company noticing, skill development on a fast-moving agent stack.

- **STATUS / RECOGNITION LOOPS:** **Recipe author field is published with the recipe in the Goose docs cookbook** — durable name-on-artefact. GitHub stars on personal repos. X (low engagement, 115 followers). Personal blog. **No academic loop; no token loop. The Goose cookbook is the dominant recognition surface.**

- **UNMET WANTS:** No verbatim "I wish" surfaced. Inferred from profile and project shape: visibly seeking **durable proof of capability that travels beyond GitHub stars** — a verifiable-attribution layer is exactly the artefact shape that would matter to him.

- **TOKEN-TOLERANCE:** Goose is Block — **financial-regulation-heavy environment**. Anything that asks Block engineers to touch a token is hostile. But the *recipe builders* are external and not employed by Block, so friction lives at the platform layer, not the contributor layer. Arya himself is in India where crypto carries no special professional taboo; his personal friction is low. **Risk: reputational coupling to a token-shaped protocol when the surrounding platform (Block-hosted recipes catalogue) is hostile.**

- **ENGAGEMENT SURFACES:** GitHub PRs to `block/goose` (primary), X `@ARYPROGRAMMER` (low traffic), personal blog. Goose runs a Discord (linked from README); recipe authors visible there.

- **CONFIDENCE:** high on builder profile and recipe count; medium on motivations (read from project portfolio); medium on token-tolerance (platform/contributor distinction is real but Jinn must navigate it).

---

### 10. SWE-agent

- **LEADER STATUS:** niche-prestige, declining as an *agent* but ascendant as a *research baseline*. 19k stars on `SWE-agent/SWE-agent`; the more recent **`mini-swe-agent`** (100 lines, no config) is what the team now points researchers at — scores >74% on SWE-bench Verified. Ecosystem is academic-heavy: forks live inside benchmark papers (DARS-Agent, SWE-smith, augment-swebench-agent, ELT-Bench, GitTaskBench). **Third-party "extension" surface is thin compared to Continue/Roo/Goose.**

- **WHO MAINTAINS:** **Kilian Lieret** (`@klieret`, AI Research Scientist at Meta, NYC, ex-Princeton, `lieret.net`) is the de-facto engineering lead and dominant contributor (1,539 commits — >10× the next). Co-authors **Carlos Jimenez** (`@carlosejimenez`, Princeton NLP, SF, 148), **Ofir Press** (`@ofirpress`, Princeton NLP, 77), **John Yang** (`@john-b-yang`, 42). Princeton NLP / Meta / academic origin. The mini-swe-agent line is co-led by klieret and used to construct benchmarks (ProgramBench).

- **ARTEFACT BUILDER:** **There is no clear third-party config/recipe builder analogous to GreatScottyMac or Daniel Rosehill.** SWE-agent's pluggable surface (`SWE_AGENT_CONFIG_ROOT`, YAML configs in `config/`) is overwhelmingly used inside research forks, not by an independent extension community. Closest analogues are research-lab teams (`augment-swebench-agent`, 872 stars; `langtalks/swe-agent`, 630). For a single named individual the strongest candidate is **Kilian Lieret himself** in his "shipping mini-swe-agent as the benchmark-builders' harness" role. **The artefact-builder role is collapsed into the maintainer role in this ecosystem — that absence is itself a finding.**

- **STATED MOTIVATIONS:**
  - klieret on X re: mini-swe-agent and ProgramBench: *"Reason to use mini-swe-agent for ProgramBench: It allows for apple to apples comparison of LMs: super simple, not developed by a LM provider, and hasn't changed much in a year."*
  - klieret: *"We'll definitely open up for submissions soon, but baselines are baselines. They are meant to be easy to interpret, and scientifically rigorous, not to chase minor gains. This is still research on frontier model capabilities, so frameworks should be as simple as possible."*
  - SWE-agent repo description: *"SWE-agent takes a GitHub issue and tries to automatically fix it... [NeurIPS 2024]."* — paper-anchored.

- **INFERRED MOTIVATIONS:** **Scientific-rigour-as-identity.** Klieret's stated objection to using Claude Code as a harness (*"black box 300k+ LoC system that's specifically tuned on Anthropic's models"*) reveals the core motivation: keep the harness boring, reproducible, model-agnostic, citable. Career capital is academic — citations, NeurIPS, ProgramBench. The thin third-party ecosystem is a feature not a bug: the team actively rejects framework complexity. Builders on top of SWE-agent are mostly other researchers running ablations.

- **STATUS / RECOGNITION LOOPS:** Academic — NeurIPS publication, SWE-bench leaderboard, citation counts, GitHub stars on benchmark repos. Twitter is used for research signalling. **No hub, no marketplace, no blog programme.**

- **UNMET WANTS:** From klieret's posts: implicit *"I wish people stopped chasing minor gains on tuned harnesses and ran apples-to-apples comparisons."* Explicit want: **a harness simple enough to *trust* across labs.** A verifiable-artefact protocol producing reproducible attempts on a fixed harness is precisely this shape — but it would have to look like a benchmark, not a marketplace.

- **TOKEN-TOLERANCE:** academic / Meta-employed. **High friction.** Meta researchers won't endorse a token; Princeton lab heritage adds a second layer. Crypto framing actively repels this cluster. Approach via paper / benchmark / dataset framing, never token-framing. **SWE-agent is the most token-allergic of the cohort.**

- **ENGAGEMENT SURFACES:** GitHub Issues and Discussions on `SWE-agent/SWE-agent` and `SWE-agent/mini-swe-agent`; X `@klieret`, `@carlosejimenez`, `@ofirpress`; arxiv / NeurIPS for the formal channel.

- **CONFIDENCE:** high on maintainer identity, motivations, token-allergy. Medium-low on the "single third-party builder" question — because the ecosystem genuinely does not have one in the sense the other three do.

---

## Cross-ecosystem synthesis

### Load-bearing motivation

There is no single load-bearing motivation across all eleven ecosystems. There are **four dominant clusters**, plus a crosscutting fifth that appears everywhere but is rarely dominant alone.

**Cluster A — Distribution-as-validation** (Hermes, OpenCode, Cline; also Goose for the cookbook-recipe shape; loyalist-stayer subset of the OpenClaw community). The recognition currency is being *seen* by the maintainer or being installed via the canonical surface. The Teknium retweet, the @sdrzn marketplace one-click install, the OpenCode docs ecosystem listing, the Goose cookbook author field, the Steinberger retweet pre-acquisition. Builders here ship to *be on the maintainer's surface*, and the maintainer's reach is the prize. Largest cluster by volume of active artefact builders.

**Cluster B — Research-output / academic citation** (OpenHands, SWE-agent; with adjacency to Hermes via Quesnelle/Peng's research line). Currency is arxiv submissions, SWE-bench rank, benchmark citation, NeurIPS acceptance, CMU/Berkeley group affiliation. Builders here ship to *produce a citeable result*; the harness is the substrate of a paper, not a marketplace. Smallest cluster by builder count but highest-status per builder; token-allergic by professional context.

**Cluster C — Capture of agent-economy primitives / substrate optionality** (ERC-8004 real-builder subset — agent0lab, Phala, Nexum, ACTA, ChaosChain; latent presence in Hermes's Atropos/$NOUS roadmap). Currency is being referenced by the canon-author (Crapis, De Rossi) and being the layer that other infra has to terminate against. Builders here ship to *become the substrate*. Highest token-tolerance, also highest token-pump noise that the cluster's own norms filter against.

**Cluster D — Governance distrust / sovereignty** (OpenClaw Sovereign-forkers — NanoClaw, ZeroClaw, Nanobot cohort; OpenClaw Hermes-migrators in the depth/memory bucket; latent in the OpenCode anti-rent-extraction sub-cluster and the Roo Code pseudonymity layer). **This cluster is the OpenClaw acquisition's gift to the field.** Currency is shipping a fork or migration that materially reduces single-vendor dependence — NanoClaw's containerised skill execution + Anthropic SDK switch, the `hermes claw migrate` command itself as an artefact of mass defection, ZeroClaw's Rust-rewrite-for-minimal-binary. Builders here are not motivated by reach or citation; they are motivated by *not being absorbed*. The cluster is empirically pre-converted to "the agent that doesn't get acquired" — they have already paid the cost of switching once.

**Crosscutting — Workflow scratching as the gateway** (GreatScottyMac on Roo, Daniel Rosehill on Continue, the OpenCode plugin top-ten, every "memory bank" / "scheduler" / "notifier" plugin). The first artefact is almost always a personal itch. What distinguishes a future recruit from a one-shot author is whether the itch generalises — GreatScottyMac's memory bank → ConPort MCP server crossing Cline/Cursor/Windsurf is the canonical "scratch turned protocol candidate" arc.

The implication: a Jinn pitch built around any single one of A / B / C / D will not land across the field, because the recognition currency differs structurally between them. A pitch that *uses the surface each cluster already cares about* (maintainer-reach for A, citation for B, canon-author endorsement for C, fork-and-survive credibility for D) is the only shape that travels. **Cluster D is the cluster with the shortest distance between "their motivation" and "Jinn's thesis"** — they do not need to be taught the problem, only shown the substrate.

### Shared unmet want

**The strongest cross-ecosystem unmet want is verifiable, reproducible, cross-harness evaluation that the cluster's own canon trusts.**

Each ecosystem is reaching for this in its own vocabulary, and each is conspicuously *not* getting it:

- **Hermes** — SkillClaw (705 stars) exists exactly because skills self-improve but the community has no shared way to score whether the improvement is real.
- **OpenCode** — no comparable artefact; the gap is mostly visible in cost-and-performance debates rather than capability scoring.
- **Aider** — Paul's polyglot leaderboard *is* the trusted artefact but has slowed (last update Aug 2025); the community has no agency over the cadence.
- **OpenHands** — the OpenHands Index is an explicit attempt to defend research-leadership posture by becoming the kingmaker, but the Goose/OpenHands token-efficiency dispute (May 2026) shows reproducible cross-harness comparison is unsolved.
- **Cline** — no reproducibility artefact at all; the closest signal is `@hsnice16`'s "score which harness fits this codebase" Skill, which arose precisely because the question is open.
- **ERC-8004** — the **single highest-leverage version of this want in the field**: the EIP explicitly defers validator economics, Magicians explicitly asks for stake-and-slashing, Nexum has prototyped first-class evaluators, and no one has shipped a credible validator-economics layer. This is Jinn's exact lane.
- **SWE-agent** — klieret's mini-swe-agent argument is *"apples to apples across labs"*; the cluster wants the harness to disappear so the model can be scored.
- **Roo Code** — open issue #40, *"Should there be a Standard for memory banks?"*, is GreatScottyMac himself entertaining standardisation.
- **Goose** — recipes are publishable but unverified; Arya's profile and the broader cookbook share the implicit want of "durable proof of capability that travels beyond stars."

A secondary shared want is **agent-team / sub-agent orchestration that survives the harness boundary** (visible in Hermes, OpenCode, OpenHands, Cline, Aider — multiple competing approaches in each, no canonical winner). This is real but more crowded; Jinn's leverage here is weaker.

### Token-tolerance differential

Ranked lowest to highest, with the specific signals:

1. **SWE-agent** — Meta + Princeton + NeurIPS publishing context. Crypto framing actively repels. No precedent for crypto association anywhere in the contributor pool.
2. **OpenHands** — CMU-anchored, paper-publishing-as-currency, Agent Control Plane targeting the same enterprise buyer as crypto-paid-tools. Long-tail forkers are crypto-indifferent; academic researchers treat crypto as credibility liability.
3. **Aider** — neutrally low. Paul Gauthier's feed has zero crypto content. Cultural register is scikit-learn-ish.
4. **Goose** — platform-hostile (Block / financial regulation), contributor-neutral. Recipe builders are external and not personally averse.
5. **Continue.dev** — venture-backed, no policy friction either way. Daniel Rosehill is neutral.
6. **OpenCode** — maintainer indifference; broader-builder permissive but unprimed. No crypto signal anywhere in the maintainer cohort; no hostility either. Crypto-flavoured plugins would not be vetoed but would be culturally unsurprising-coded as outliers.
7. **Roo Code** — independent + heavily pseudonymous (GreatScottyMac is the canonical example). Pseudonymity-tolerance is itself a crypto-positive signal; latent fit is likely high.
8. **Cline** — **medium-high and rising.** Founder is crypto-quiet but visibly tolerant; routinely RTs x402 / USDC / Base builders. Marketplace README has *"heightened scrutiny for sensitive domains like finance and cryptocurrency"* — *scrutiny*, not exclusion. x402 builders (@0xDespot, @jackwang3327289, AEGISGOVDAO) accepted live in the queue. **The only coding-agent ecosystem in our sample where x402 + USDC + Base appear in builder marketing without apology.**
9. **OpenClaw centre (foundation, Steinberger, mainstream-tech speakers)** — low. European product-software register; no crypto signal at maintainer level. **OpenClaw memecoin-imposter cloud** is high-tolerance but is not a real builder community; ignore.
10. **OpenClaw Sovereign-forker subset (NanoClaw, ZeroClaw, Nanobot)** — **medium-high latent.** Not token-pilled at the surface, but ideologically primed for credibly-neutral substrate arguments. They have already articulated objections to the OpenAI-sponsored-foundation pattern. The bridge here is not "do you want a token" but "do you want a substrate that cannot be acquired" — and they have answered that question by forking.
11. **OpenClaw Hermes-migrators** — **medium-high inherited from Hermes/Nous.** They self-selected onto a Paradigm-funded Solana-adjacent harness; the cultural ceiling for crypto vocabulary on this cohort is higher than on the OpenClaw centre.
12. **Hermes / Nous** — **very high, explicit, public.** Paradigm-funded $50M at $1B; Psyche on Solana; Karan's "open-source and crypto ethos are aligned" quote on the record; awesome-list accepts Solana / Monero / x402 integrations as on-topic. Peer ecosystem (Bittensor, Prime Intellect, Pluralis, Gensyn) is the only set of AI labs with comparable posture.
13. **ERC-8004 real-builder subset** — **crypto-native by construction.** Tokens not disqualifying in principle; cluster *does* distinguish real builders from token-pumpers cleanly, and the Crapis/De Rossi endorsement is the canonical filter.

**The differential implication for Jinn:** the practical builder-level tolerance ordering is **ERC-8004 (real-builder subset) ≈ Hermes/Nous > OpenClaw Hermes-migrators ≈ Cline > OpenClaw Sovereign-forkers > everything else**. The Sovereign-forker placement is the most interesting — they sit *below* explicit crypto-friendly ecosystems on token-tolerance but *above* mainstream coding-agent ecosystems on substrate-distrust-as-motivation. This is the cluster where Jinn's "credibly neutral" framing carries the most argumentative weight per word. Below the top of the ranking, the field requires reframing the offer away from token vocabulary and toward verifiability / corpus / sovereignty / non-acquirability.

### Bridge implications

Per motivation cluster (one-line directional sketches; not pitch copy):

- **Distribution-cluster (Hermes, OpenCode, Cline):** Jinn's offer is *a marketplace-shaped surface for verifiable artefacts where the corpus is the new distribution surface* — shipping into Jinn is a stronger long-tail distribution signal than a maintainer retweet because the artefact's value compounds with usage. The bridge has to make the corpus visible as a surface, not as a backend.
- **Research-cluster (OpenHands, SWE-agent):** Jinn's offer is *standardised reproducible benchmarking substrate that produces citeable corpus* — "apples-to-apples across labs" with the artefact being the comparison itself, not a vendor's leaderboard slot. Bridge framing has to be a benchmark, never a marketplace.
- **Substrate-cluster (ERC-8004 real builders):** Jinn's offer is *the validator/evaluator economics layer the EIP explicitly defers* — stake-on-the-score is the structural completion of their thesis. The cleanest bridge in the entire field on a *vocabulary* axis; the language already exists inside their canon.
- **Sovereignty-cluster (OpenClaw Sovereign-forkers, OpenClaw Hermes-migrators):** Jinn's offer is *substrate that cannot be acquired — credibly neutral by construction, not by promise*. The bridge is the empirical record: NanoClaw forked because they did not trust the OpenAI-sponsored foundation; the `hermes claw migrate` command is a literal artefact of mass defection. Jinn's no-founder-multisig / no-admin-keys / no-team-allocation posture (THESIS §6) is the *next* answer to the question they have already paid a cost to act on. **The cleanest bridge in the entire field on a *motivation* axis; the problem is already named inside their head.**
- **Workflow-scratching crosscut (Roo memory-bank, Continue prompt-author, OpenCode plugin top-ten, Goose recipes):** Jinn's offer is *the answer to "should there be a Standard for this?" — your scratch-it solution becomes a shared protocol primitive with attribution and stake*. Bridge is identity-defence + portability, not economics.
- **Anti-rent-extraction sub-cluster (Cline x402 builders, OpenCode auth-routing plugins):** Jinn's offer is *pay-per-call infrastructure aligned with stake-backed verification rather than platform-extracted attestation*. This bridges into the existing x402 vocabulary without translation overhead.

These are directional only. The §3 rewrite is the next step; it will need to choose which cluster Jinn leads with and which it picks up via overflow. **The Sovereignty-cluster and the Substrate-cluster together represent the field's highest-fit recruit shape per body** — small in absolute terms (low double-digit NanoClaw/ZeroClaw committers, a few dozen ERC-8004 real builders, the dispersed Hermes-migrator pool) but pre-converted on the *thesis*. Distribution and Research clusters are larger but require more bridge work.

### Open questions

- **OpenClaw Sovereign-forker mapping.** NanoClaw, ZeroClaw, Nanobot are named; the individual contributors behind each fork are not yet GitHub-handle-resolved with current affiliation. A second-pass profile of NanoClaw's commit graph and the human behind the `nanocoai` org is the highest-value follow-up in this whole research file.
- **Hermes-migrator population sampling.** The 30% migration figure is Reddit-sentiment; the actual diaspora is observable by joining the Hermes Discord and looking for `hermes claw migrate` references in #beta / #onboarding channels. Worth doing before §3 rewrite — these are pre-converted recruits with paid migration cost as filter.
- **What Steinberger himself signals next.** He has 49.7k X followers, is now sponsored-by-OpenAI but still positions as a foundation steward. A public post by him about credibly-neutral agent substrate (positive *or* dismissive) would reshape the cluster's appetite materially. Watch `@steipete` cadence.
- **Hermes/Nous competitive overlap.** Nous has Paradigm money, Psyche on Solana, and an explicit decentralised-training roadmap. Would a Jinn pitch land as collaborative (substrate-layer below Nous) or competitive (substrate-layer alongside)? Karan's "ethos aligned" quote is the most positive prior available, but it is one quote.
- **OpenCode plugin marketplace under a crypto endorsement.** Maintainer tolerance is indifference; no precedent for either direction under a high-status crypto plugin landing on the docs page. The first crypto plugin attempt is informative either way.
- **SkillClaw author** (Hermes-skill-quality scoring) — direct contact would confirm whether they see stake-backed scoring as the missing mechanism, or are pursuing a different direction.
- **ERC-8004 real-builder subset** (agent0lab, Phala, Nexum) — do they see the validator-economics layer as something they want a third party (Jinn) to ship and they compose against, or as something they intend to ship themselves and would view Jinn as competitive? Crapis's posture suggests the former (he endorses tooling, not protocols), but this requires direct probing.
- **Internal channel topology.** Discord channel names for Hermes / Cline / OpenCode are only visible from inside. Worth joining each to map the topology before any structured engagement.
- **Aider tolerance under a token-incentive structure.** No precedent in the surrounding repos. The cluster's calm academic register suggests indifference rather than enthusiasm; an experiment would be informative.
- **Goose platform vs contributor distinction.** Block-the-platform is hostile, but recipe authors are external. Can a recipe author publish to Goose's cookbook *and* operate Jinn without coupling reputationally to a Block-hosted artefact? The question is whether Block ever depublishes recipes from contributors whose surrounding work touches crypto.
- **Roo/Cline boundary in flux.** Cline announced Roo's largest fork merged back 21 April 2026; the practical recruit shape of "Roo Code builders" may converge into "Cline plugin authors" by H2 2026. Reassess in three months.
- **Cross-ecosystem builders as a category.** IndyDevDan ships across Aider + OpenCode + Continue + Roo; Daniel Rosehill ships across Continue + Roo + MCP + HF. These are the highest-leverage recruits per body — but they're motivated by audience accrual rather than ecosystem allegiance, which changes the conversion shape. Worth a dedicated profile pass before §3.
