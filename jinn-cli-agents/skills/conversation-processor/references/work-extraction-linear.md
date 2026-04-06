# Work Extraction → Linear

Reference guide for extracting workstreams from conversations and mapping them to Linear.

## Extraction Heuristics

### What counts as a workstream?

1. **Active work** — "I did X", "I'm working on X", "I deployed X"
2. **Planned work** — "I'm going to X today", "next step is X"
3. **Blocked work** — "waiting on X", "can't proceed until X"
4. **Ideas with traction** — discussed for >2 minutes with concrete next steps
5. **Recurring themes** — topics that come up across multiple conversations

### What does NOT count?

- Casual chit-chat, personal updates
- Pure speculation without any proposed action ("wouldn't it be cool if...")
- Already-completed one-off tasks with no follow-up

## Matching Against Linear

### Search Strategy

1. **Exact match** — issue title or description matches the topic
2. **Semantic match** — issue covers the same functional area even if framed differently
3. **Project match** — topic belongs to an existing project even if no specific issue exists
4. **Gap** — no existing issue or project covers this topic

### Decision Matrix

| Conversation Signal | Linear State | Action |
|-------------------|--------------|--------|
| "I did X" (completed) | Issue exists, open | Update status → Done |
| "I did X" (completed) | No issue | Skip (already done, no tracking needed) |
| "I'm doing X" | Issue exists, not started | Update status → In Progress, assign |
| "I'm doing X" | No issue | Create issue, status = In Progress |
| "We should do X" (concrete) | Issue exists | Update description/priority if new info |
| "We should do X" (concrete) | No issue | Create issue, status = Todo/Backlog |
| "We should do X" (vague) | No issue | Create issue in Triage or skip |
| "X is blocked by Y" | Issue exists | Add blocker note, link issues |
| Strategic/future idea | No issue | Create issue, label = strategic, low priority |

## Proposal Format

```markdown
### [CREATE] Title
- **Priority**: Urgent / High / Medium / Low
- **Status**: Todo / In Progress / Backlog / Triage
- **Assignee**: person (or unassigned)
- **Project**: existing-project or "none"
- **Description**: What needs to happen
- **Rationale**: Why create this — what was said in the conversation

### [UPDATE] JINN-XXX: Title
- **Changes**: What fields to update
- **Rationale**: What new information from the conversation

### [CLOSE] JINN-XXX: Title
- **Rationale**: Why this is done or no longer needed
```

## Speaker → Linear User Mapping

Maintain a mapping of conversation speakers to Linear handles:

| Speaker | Linear Handle | Notes |
|---------|--------------|-------|
| Oak Tan / Oaksprout | Oaksprout | |
| Ritsu Kai / ritsu | ritsu | |

## Project Taxonomy

When assigning to projects, prefer existing projects. Current active projects:

- **Infinitely running autonomous business** — reliability, always-on ops
- **Ventures & Services Registry** — data layer, MCP tools, discovery
- **Agent Optimization** — runtime improvements, integrations
- **Productized Ventures** — self-serve launching, monetization
- **Venture Experimentation** — rapid iteration, keep/sunset
- **Protocol improvement** — blueprints, dispatch, orchestration
- **UX improvements** — observability, explorer
- **Prepare Node for External Operators** — external readiness

Create new projects only when a workstream clearly doesn't fit any existing one AND is large enough to warrant a project (3+ issues expected).
