# Telegram Venture & Content Streams Design

## Problem

Telegram community management and content distribution are currently mixed into other ventures' configs. There's no formalized way for templates to expose content for consumption by other templates — discovery is ad-hoc via `search_artifacts` keyword guessing.

## Solution

1. A dedicated Telegram venture with two templates on separate cadences
2. A content stream convention (`FEED:<name>`) for inter-template content sharing
3. Two new MCP tools for stream discovery and reading
4. Refactoring the commit-summary template to produce stream content instead of posting directly to TG

---

## Content Stream Convention

**Topic naming:** `FEED:<stream-name>` — lowercase kebab-case (e.g., `FEED:commit-highlights`, `FEED:research-posts`).

**Producer contract:** Templates use `create_artifact` with `topic: "FEED:<stream-name>"` for content intended for the stream.

**Template manifest:** Producing templates declare streams in `templateMeta`:
```json
"publishes": [{
  "stream": "FEED:commit-highlights",
  "description": "Curated highlights from recent repository commits"
}]
```

**Consumer input:** Consuming templates accept:
```json
"subscribedStreams": ["FEED:commit-highlights", "FEED:research-posts"]
```

---

## New MCP Tools

### `search_content_streams`

Discover available `FEED:*` streams.

```json
{
  "query": "commit",  // optional keyword filter
  "limit": 20
}
```

Returns: `stream`, `description`, `latestItemAt`, `itemCount`.

Implementation: aggregates distinct `FEED:*` topics from the Ponder artifacts table. Description sourced from producing template's `publishes` manifest if found in the templates table.

Location: `jinn-node/src/agent/mcp/tools/search-content-streams.ts`

### `read_content_stream`

Read items from a specific stream.

```json
{
  "stream": "FEED:commit-highlights",
  "since": "2026-02-24T00:00:00Z",  // optional, defaults to last 24h
  "limit": 20
}
```

Returns artifacts ordered by creation time (newest first): `name`, `contentPreview`, `cid`, `requestId`, `createdAt`.

Location: `jinn-node/src/agent/mcp/tools/read-content-stream.ts`

---

## Template Changes

### `commit-summary-telegram` → retired (replaced by `content-template`)

The standalone `commit-summary` template is retired. Its behavior is now expressed as a `content-template` instance configured with GitHub sources:

```json
{
  "name": "Commit Highlights",
  "streamName": "commit-highlights",
  "sources": ["https://github.com/oaksprout/jinn-gemini"],
  "lookbackPeriod": "7 days",
  "contentBrief": "Curate interesting features and updates from recent repository commits..."
}
```

The venture dispatch enables `list_commits` and `get_file_contents` via `enabledTools`.

Changes to `content-template.json`:
- Rename `outputTopic` → `streamName` — enforces `FEED:{streamName}` topic convention
- Add `list_commits`, `get_file_contents`, `content_streams` as optional tools
- GOAL-002 invariant updated: artifact topic MUST be `FEED:{{streamName}}`

### `telegram-community.json` (modified)

- Remove `TG-CONTENT-SHARING` invariant (content distribution is now the distributor's job)
- Remove `blog_list_posts` and `blog_get_post` from tools
- Remove `telegramBotToken` from input schema (handled by credential system)
- Rename `domain` → `websiteUrl`, envVar `BLOG_DOMAIN` → `WEBSITE_URL`, drop `default: "$provision"`

### `telegram-content-distributor.json` (new)

Input schema:
- `subscribedStreams` (required): array of `FEED:*` stream names
- `telegramChatId` (env: `TELEGRAM_CHAT_ID`)
- `telegramTopicId` (env: `TELEGRAM_TOPIC_ID`, optional)
- `personality` (optional): tone/voice for formatting
- `lookbackPeriod` (optional, default `"3 hours"`): how far back to check

Invariants:
- `DIST-001`: Read subscribed streams via `search_content_streams` / `read_content_stream` for items since last cycle
- `DIST-002`: Per item, decide whether to share directly, summarize into a digest, or transform — based on content type and volume
- `DIST-003`: Post to Telegram with appropriate formatting. Don't repost content already posted in previous cycles (use `search_similar_situations`)
- `DIST-004`: Create `FEED:tg-distribution-log` artifact logging what was posted

Enabled tools: `search_content_streams`, `read_content_stream`, `telegram_messaging`, `search_similar_situations`, `create_artifact`

---

## Telegram Venture

**Name:** Telegram Community & Content

**Blueprint invariants:**

- `GOAL-001` (FLOOR, metric: `content_visibility_score`, min: 7): "The Telegram community has visibility into what Jinn agents are building and shipping. Assess: coverage of active ventures' output (are highlights from all subscribed streams surfacing?), freshness (content posted within 24h of production), and clarity (a non-technical community member can understand what happened)."

- `GOAL-002` (FLOOR, metric: `response_quality_score`, min: 7): "Community questions about Jinn are answered accurately and promptly. Assess: response time (within one cycle), accuracy (grounded in docs/verified sources), helpfulness (question fully addressed, not deflected), and tone (consistent with venture personality)."

- `GOAL-003` (FLOOR, metric: `monthly_active_participants`, min: 50): "The Telegram group sustains meaningful community engagement month over month."

- `GOAL-004` (BOOLEAN): "The venture operates autonomously — no human intervention required for day-to-day community and content operations."

**Dispatch schedule:**

| Label | Template | Cron | Notes |
|-------|----------|------|-------|
| Community Management | `telegram-community` | `0 */4 * * *` (every 4h) | Reads messages, answers questions |
| Content Distribution | `telegram-content-distributor` | `0 9,17 * * *` (9am & 5pm UTC) | Checks streams, posts to TG |

**Initial distributor input:**
```json
{
  "subscribedStreams": ["FEED:commit-highlights"],
  "lookbackPeriod": "8 hours",
  "telegramChatId": "-1003682777125"
}
```

---

## Files Changed

**New:**
- `jinn-node/src/agent/mcp/tools/search-content-streams.ts`
- `jinn-node/src/agent/mcp/tools/read-content-stream.ts`
- `blueprints/telegram-content-distributor.json`

**Modified:**
- `blueprints/content-template.json` (rename `outputTopic` → `streamName`, add tools, update GOAL-002)
- `blueprints/content-venture-template.json` (rename `outputTopic` → `streamName`)
- `blueprints/telegram-community.json`
- `jinn-node/src/agent/mcp/server.ts` (register new tools)
- `jinn-node/src/agent/toolPolicy.ts` (add new tools to registry)

**Deleted:**
- `blueprints/commit-summary-telegram.json` (retired — replaced by content-template instance)

**Created:**
- `blueprints/inputs/content-template-commit-highlights.json` (replacement config)

## Operational Steps (post-code)

1. Re-seed updated `content-template` to Supabase (schema changed: `outputTopic` → `streamName`)
2. Seed new `telegram-content-distributor` template to Supabase
3. Create the TG venture with invariants and dispatch schedule
4. Verify `telegram-community` template is already seeded
5. Update any existing content ventures to use `streamName` instead of `outputTopic`
