---
name: conversation-processor
description: >
  Process conversation transcripts (standups, planning sessions, brainstorms)
  to extract actionable work items, sync with Linear, and produce community-facing
  digests. Use when given a meeting transcript, audio transcription, or conversation
  log that needs to be turned into tracked work and/or a shareable update.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, ToolSearch, Task, mcp__linear__list_issues, mcp__linear__get_issue, mcp__linear__create_issue, mcp__linear__update_issue
user-invocable: true
---

# Conversation Processor

Extracts workstreams, decisions, and action items from conversation transcripts. Two output modes: **Linear sync** (internal) and **daily digest** (external).

## Workflow

1. **Parse transcript** — identify speakers, topics, decisions, and action items
2. **Extract workstreams** — group related topics into discrete workstreams (existing or new)
3. **Match against Linear** — query Linear for overlapping issues, projects, and cycles
4. **Generate outputs** — based on what the user asks for:
   - **Linear proposals** — create/update/close proposals for review, then execute on approval
   - **Daily digest** — community-facing summary written to `digests/YYYY-MM-DD.md`
   - **Both** — do Linear sync first (for context gathering), then write the digest
5. **Compress key language** — before finalizing digests, apply the JPEG pass (see below)

## Available References

- `references/work-extraction-linear.md` — Detailed guide for extracting workstreams and mapping them to Linear issues

## Conversation Types

| Type | Focus |
|------|-------|
| Daily standup | Status updates, blockers, quick decisions |
| Planning session | Sprint/cycle planning, priority setting |
| Brainstorm | Open-ended ideation, strategic direction |
| Debrief | Retrospective, lessons learned |

---

## Output: Linear Proposals

Proposals should be structured as:

```
### [ACTION] JINN-XXX: Title
- **Action**: Create / Update / Close / Defer
- **Rationale**: Why this change
- **Details**: Description, assignee, priority, project
```

## Tips for Linear extraction

- Look for implicit workstreams (topics discussed at length but not explicitly called "work")
- Flag strategic/future ideas separately from immediate action items
- Match speaker names to Linear user handles for assignment
- Cross-reference with existing projects to avoid duplication
- Distinguish between "we should do X" (future) and "I did X / I'm doing X" (active)

---

## Output: Daily Digests

Three separate digests, each targeting a different audience. All written to a single file `digests/YYYY-MM-DD.md` separated by `---` dividers. Also output inline for review.

### Audiences and network actors

| Audience | Who they are | What they care about |
|----------|-------------|---------------------|
| **Jinn community** | Operators, Launchers, Consumers, Governors | Product updates, how to participate, what's coming |
| **OLAS community** | veOLAS holders, OLAS operators, ecosystem watchers | Ecosystem activity, staking opportunities, governance |
| **Contributors** | Developers, protocol researchers, go-to-market collaborators | Codebase changes, architecture decisions, open questions |

### Network actors

Know who each item is relevant to, and weave it into the language naturally — never use bracket tags like `[Operators]`. Instead, mention the actor in the sentence itself (e.g. "no more manual top-ups for node operators" not "no more manual top-ups [Operators]").

- **Operators** — run nodes, stake services, earn rewards
- **Launchers** — create ventures, design templates. The consumer-to-launcher pipeline is key: if a consumer wishes a content stream existed, the answer is "create it" — always link to the create page.
- **Consumers** — read/use venture outputs (content streams, research, data). Consumers are one step from becoming launchers.
- **Governors** — veOLAS voters, resource allocation, protocol decisions
- **Contributors** — code, protocol design, go-to-market

### Terminology autocorrect

- **stOLAS** — always spell as "stOLAS" (not "STOL-less", "STOLless", "stol-less", etc.). This is the name for staking without holding OLAS.

### Gathering links

For anything mentioned in the transcript, find **publicly accessible** links:

- Use `mcp__linear__list_issues` to understand context — but **NEVER link to Linear** in the digest (issues are private)
- Search for commits/branches via `git log --oneline --since="2 days ago"`
- Search for GitHub repos mentioned (spec repos, PRs) — these are linkable
- Check deployed URLs from memory and codebase:
  - Website: `https://jinn.network`
  - App / launcher: `https://app.jinn.network`
  - Explorer: `https://explorer.jinn.network`
  - ADW spec: `https://github.com/Jinn-Network/adw-spec`
  - jinn-node: `https://github.com/Jinn-Network/jinn-node`
- Look for on-chain transactions or contract addresses referenced
- **Only link to things the public can actually visit.** No private repos, no Linear, no internal dashboards.

---

### Digest 1: Jinn Daily

Short community update. Hyper-prioritise — only the most impactful items make the cut.

**Length**: Max 5 single-sentence bullet points total across all sections. Readable in 20 seconds.

```markdown
# Jinn Daily — [Date]

> [One-sentence hook]

- [Most important thing, with actor woven into the sentence naturally]. [Link if available]
- [Second most important].
- [Third].
- [Fourth if warranted].
- [Fifth max].

Get involved: [One sentence with the single highest-value CTA and link]
```

**Prioritisation**: Ship > What's next > Thinking. If only 2 things shipped, that's fine — 2 bullets. Never pad.

---

### Digest 2: OLAS Community Update

Same brevity as Jinn Daily. OLAS community cares about staking, governance, and ecosystem activity.

**Length**: Max 5 single-sentence bullet points. Readable in 20 seconds.

```markdown
# OLAS Community Update — [Date]

> [One-sentence hook — most relevant thing for OLAS holders]

- [Bullet 1 — staking/services/governance]
- [Bullet 2]
- [Bullet 3 if warranted]

Might interest you: [One sentence CTA — run a node, vote, read streams]
```

---

### Digest 3: Contributors Update

Technical and strategic. For people who care about the codebase and protocol direction.

**Length**: Can be the most detailed on technical matters. OK to reference issue IDs (but still no Linear links).

```markdown
# Contributors Update — [Date]

> [One-sentence hook — most interesting technical/strategic development]

## What changed

- [Code changes, bug fixes, deploys — with commit/PR links where available]

## Architecture decisions

- [Decisions made, rationale, tradeoffs]

## What's next

- [Technical work in progress, what's blocked]

## Open questions

- [Things that need input, unresolved design questions]
```

---

### Content sensitivity

Digests are public-facing. Before publishing, filter out:

- Disparaging or critical comments about other projects, protocols, or competitors
- Strategic plans that would be disadvantageous if revealed (e.g. competitive positioning)
- Internal frustrations or complaints about external parties
- Anything that reads as internal-only context not meant for public consumption

When in doubt, leave it out. Reframe internal context into positive, forward-looking language.

### Founders

- **Oaksprout the Tan** — [@tannedoaksprout](https://x.com/tannedoaksprout)
- **Ritsu Kai** — no public Twitter

In digest body, use "we" voice — no individual attribution. Do NOT include "DM us" or personal contact handles in digests.

### Shared style guidelines

- **Lead with the benefit.** Say what it means for people first, then what it is. Bad: "ADW contracts live on Base — every artifact now gets on-chain provenance." Good: "ADW — the protocol we're building to give ventures better distribution and cognition — is now live on-chain and integrated with Jinn!"
- **Simple language.** Write like a tweet thread, not a blog post. Minimize jargon.
- **Concrete.** Link where possible, but ONLY to publicly accessible URLs.
- **Honest.** "Debugging X" is fine. Don't oversell.
- **No emojis** unless the user asks for them.
- **"We" voice.** Not "Oak did X" or "Ritsu built Y". Just "we".
- **"Get involved" not "How you can help"** — frame it as things people might find interesting, not asks.
- Internal-only topics (middleware replacement, env var cleanup) go in **Contributors**, not Jinn Daily — unless they have direct user impact.

### JPEG pass — compress before publishing

After drafting the digests, apply the `jpeg-your-ideas` skill principles to sharpen the language. This is a **subtle** editorial pass, not full sloganeering. Target:

1. **Hooks** (the `>` lines) — these are the highest-leverage compression targets. Each hook should survive three hops of retransmission. Apply: brevity, metaphor, contrast, rhythm.
2. **CTA lines** — the "Get involved" / "Might interest you" closers. Should feel like an invitation, not a press release.
3. **Any phrase that names a concept** — if the transcript contains a memorable framing (e.g. "strategically muddle along"), preserve or sharpen it rather than flattening into generic language.

**Process:**
- Draft the digests first with straightforward language
- Identify 2-4 phrases across all three digests that would benefit from compression
- For each, generate 2-3 candidate formulations varying the rhetorical device (metaphor, contrast, alliteration, etc.)
- Present the candidates inline to the user for approval — format as:
  ```
  **JPEG candidates:**
  1. Hook (Jinn Daily): "Original draft" →
     - a) "Compressed option A" (device: metaphor)
     - b) "Compressed option B" (device: contrast)
  2. CTA: "Original" →
     - a) ...
  ```
- User picks or tweaks, then finalize the digest file

**Restraint:** Don't compress everything. Most bullet points should stay clear and direct. Only compress where a phrase will be retransmitted (hooks, CTAs, concept names). The goal is 2-4 sharper phrases per digest set, not wall-to-wall rhetoric.

### Digest output

Write all three digests to `digests/YYYY-MM-DD.md` separated by `---` dividers.
Also output the full text inline so the user can review before publishing.
