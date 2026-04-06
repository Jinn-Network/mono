# Telegram Venture & Content Streams Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a dedicated Telegram venture with community management and content distribution templates, powered by a new `FEED:*` content stream convention and two new MCP tools.

**Architecture:** Templates produce content artifacts with `FEED:<stream-name>` topics. Two new MCP tools (`search_content_streams`, `read_content_stream`) let agents discover and read streams. A new content distributor template consumes streams and posts to Telegram. The existing commit-summary template is refactored to publish to a stream instead of posting to TG directly.

**Tech Stack:** TypeScript, Zod, Ponder GraphQL, MCP SDK, Vitest

**Design doc:** `docs/plans/2026-02-25-telegram-venture-design.md`

---

### Task 1: `search_content_streams` MCP tool

**Files:**
- Create: `jinn-node/src/agent/mcp/tools/search-content-streams.ts`
- Test: `tests/unit/tools/search-content-streams.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/tools/search-content-streams.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch before importing
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock env
vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: () => 'http://localhost:42069/graphql',
  loadEnvOnce: () => {},
}));

import { searchContentStreams } from 'jinn-node/agent/mcp/tools/search-content-streams.js';

describe('search_content_streams', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns distinct FEED: streams from artifacts', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: {
          artifacts: {
            items: [
              { topic: 'FEED:commit-highlights', name: 'Commit update', id: '1' },
              { topic: 'FEED:commit-highlights', name: 'Commit update 2', id: '2' },
              { topic: 'FEED:research-posts', name: 'Research findings', id: '3' },
            ],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].stream).toBe('FEED:commit-highlights');
    expect(body.data[0].itemCount).toBe(2);
    expect(body.data[1].stream).toBe('FEED:research-posts');
    expect(body.data[1].itemCount).toBe(1);
  });

  it('filters by query keyword', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: {
          artifacts: {
            items: [
              { topic: 'FEED:commit-highlights', name: 'Commit update', id: '1' },
            ],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await searchContentStreams({ query: 'commit' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stream).toBe('FEED:commit-highlights');
  });

  it('returns empty array when no FEED: artifacts exist', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: { artifacts: { items: [] } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it('handles Ponder errors gracefully', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('EXECUTION_ERROR');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `yarn vitest run tests/unit/tools/search-content-streams.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `jinn-node/src/agent/mcp/tools/search-content-streams.ts`:

```typescript
import { z } from 'zod';
import fetch from 'cross-fetch';
import { getPonderGraphqlUrl } from './shared/env.js';

export const searchContentStreamsParams = z.object({
  query: z.string().optional().describe('Optional keyword to filter stream names (case-insensitive).'),
  limit: z.number().int().positive().max(100).optional().default(20).describe('Max streams to return.'),
});

export type SearchContentStreamsParams = z.infer<typeof searchContentStreamsParams>;

export const searchContentStreamsSchema = {
  description: 'Discover available content streams (FEED:* topics). Returns distinct stream names with item counts and latest timestamps. Use this to find what content other templates are producing.',
  inputSchema: searchContentStreamsParams.shape,
};

export async function searchContentStreams(params: unknown) {
  try {
    const parsed = searchContentStreamsParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: [],
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const { query, limit } = parsed.data;
    const PONDER_GRAPHQL_URL = getPonderGraphqlUrl();

    // Query all artifacts with FEED: prefix topic
    // Ponder doesn't support DISTINCT or GROUP BY, so we fetch and aggregate client-side
    const gql = `query SearchFeedArtifacts($limit: Int!) {
      artifacts(where: { topic_starts_with: "FEED:" }, limit: $limit, orderBy: "id", orderDirection: "desc") {
        items { id topic name }
      }
    }`;

    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { limit: 1000 } }),
    });

    const json = await res.json();
    const items = json?.data?.artifacts?.items || [];

    // Aggregate by topic
    const streamMap = new Map<string, { count: number; latestName: string }>();
    for (const item of items) {
      const existing = streamMap.get(item.topic);
      if (existing) {
        existing.count++;
      } else {
        streamMap.set(item.topic, { count: 1, latestName: item.name });
      }
    }

    // Convert to array, filter by query if provided
    let streams = Array.from(streamMap.entries()).map(([stream, { count, latestName }]) => ({
      stream,
      itemCount: count,
      latestItemName: latestName,
    }));

    if (query) {
      const q = query.toLowerCase();
      streams = streams.filter(s => s.stream.toLowerCase().includes(q));
    }

    // Apply limit
    streams = streams.slice(0, limit);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: streams,
          meta: { ok: true, source: 'ponder', type: 'content_streams' },
        }),
      }],
    };
  } catch (e: any) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: [],
          meta: { ok: false, code: 'EXECUTION_ERROR', message: e?.message || String(e) },
        }),
      }],
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `yarn vitest run tests/unit/tools/search-content-streams.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add jinn-node/src/agent/mcp/tools/search-content-streams.ts tests/unit/tools/search-content-streams.test.ts
git commit -m "feat(tools): add search_content_streams MCP tool"
```

---

### Task 2: `read_content_stream` MCP tool

**Files:**
- Create: `jinn-node/src/agent/mcp/tools/read-content-stream.ts`
- Test: `tests/unit/tools/read-content-stream.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/tools/read-content-stream.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: () => 'http://localhost:42069/graphql',
  loadEnvOnce: () => {},
}));

import { readContentStream } from 'jinn-node/agent/mcp/tools/read-content-stream.js';

describe('read_content_stream', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns artifacts from a specific stream', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: {
          artifacts: {
            items: [
              { id: '1', name: 'Latest commit update', topic: 'FEED:commit-highlights', contentPreview: 'Added dark mode...', cid: 'Qm1', requestId: 'req-1' },
              { id: '2', name: 'Older commit update', topic: 'FEED:commit-highlights', contentPreview: 'Fixed login bug...', cid: 'Qm2', requestId: 'req-2' },
            ],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await readContentStream({ stream: 'FEED:commit-highlights' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].name).toBe('Latest commit update');
    expect(body.data[0].cid).toBe('Qm1');
  });

  it('validates stream parameter starts with FEED:', async () => {
    const result = await readContentStream({ stream: 'not-a-feed' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('VALIDATION_ERROR');
  });

  it('requires stream parameter', async () => {
    const result = await readContentStream({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('VALIDATION_ERROR');
  });

  it('handles empty stream gracefully', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: { artifacts: { items: [] } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await readContentStream({ stream: 'FEED:empty-stream' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `yarn vitest run tests/unit/tools/read-content-stream.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `jinn-node/src/agent/mcp/tools/read-content-stream.ts`:

```typescript
import { z } from 'zod';
import fetch from 'cross-fetch';
import { getPonderGraphqlUrl } from './shared/env.js';

export const readContentStreamParams = z.object({
  stream: z.string().min(1).refine(s => s.startsWith('FEED:'), {
    message: 'Stream name must start with "FEED:"',
  }).describe('The stream topic to read (e.g., "FEED:commit-highlights").'),
  since: z.string().optional().describe('ISO timestamp — only return items created after this time. Defaults to last 24 hours.'),
  limit: z.number().int().positive().max(100).optional().default(20).describe('Max items to return.'),
});

export type ReadContentStreamParams = z.infer<typeof readContentStreamParams>;

export const readContentStreamSchema = {
  description: 'Read items from a specific content stream. Returns artifacts ordered by most recent first. Use search_content_streams first to discover available streams.',
  inputSchema: readContentStreamParams.shape,
};

export async function readContentStream(params: unknown) {
  try {
    const parsed = readContentStreamParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: [],
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const { stream, since, limit } = parsed.data;
    const PONDER_GRAPHQL_URL = getPonderGraphqlUrl();

    // Default to last 24h if no since provided
    const sinceTs = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const gql = `query ReadContentStream($topic: String!, $limit: Int!) {
      artifacts(where: { topic: $topic }, limit: $limit, orderBy: "id", orderDirection: "desc") {
        items { id name topic contentPreview cid requestId }
      }
    }`;

    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { topic: stream, limit } }),
    });

    const json = await res.json();
    const items = (json?.data?.artifacts?.items || []).map((item: any) => ({
      name: item.name,
      contentPreview: item.contentPreview,
      cid: item.cid,
      requestId: item.requestId,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: items,
          meta: { ok: true, source: 'ponder', type: 'content_stream', stream, since: sinceTs },
        }),
      }],
    };
  } catch (e: any) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: [],
          meta: { ok: false, code: 'EXECUTION_ERROR', message: e?.message || String(e) },
        }),
      }],
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `yarn vitest run tests/unit/tools/read-content-stream.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add jinn-node/src/agent/mcp/tools/read-content-stream.ts tests/unit/tools/read-content-stream.test.ts
git commit -m "feat(tools): add read_content_stream MCP tool"
```

---

### Task 3: Register new tools in server, index, and tool policy

**Files:**
- Modify: `jinn-node/src/agent/mcp/tools/index.ts` (add exports at line ~95)
- Modify: `jinn-node/src/agent/mcp/server.ts` (add to REGISTERED_MCP_TOOLS at line ~73, add to serverTools at line ~181)
- Modify: `jinn-node/src/agent/toolPolicy.ts` (add to VALID_JOB_TOOLS, add meta-tool expansion + constant)

**Step 1: Add exports to `index.ts`**

After the dispatch schedule exports (line 94), add:

```typescript
// Content stream tools
export { searchContentStreams, searchContentStreamsParams, searchContentStreamsSchema, type SearchContentStreamsParams } from './search-content-streams.js';
export { readContentStream, readContentStreamParams, readContentStreamSchema, type ReadContentStreamParams } from './read-content-stream.js';
```

**Step 2: Add to `REGISTERED_MCP_TOOLS` in `server.ts`**

After `'update_dispatch_schedule'` (line 73), add:

```typescript
  // Content stream tools
  'search_content_streams',
  'read_content_stream',
```

**Step 3: Add to `serverTools` array in `server.ts`**

After the dispatch schedule tools entry (line 181), add:

```typescript
      // Content stream tools
      { name: 'search_content_streams', schema: tools.searchContentStreamsSchema, handler: tools.searchContentStreams },
      { name: 'read_content_stream', schema: tools.readContentStreamSchema, handler: tools.readContentStream },
```

**Step 4: Add to tool policy in `toolPolicy.ts`**

Add a new constant after `TELEGRAM_TOOLS` (line 273):

```typescript
/**
 * Content stream discovery and reading tools (custom MCP tools)
 * Used to discover and read FEED:* content streams between templates
 */
export const CONTENT_STREAM_TOOLS = [
  'search_content_streams',
  'read_content_stream',
] as const;

/**
 * Check if content streams are enabled in the tools list
 */
export function hasContentStreams(enabledTools: string[]): boolean {
  return enabledTools.includes('content_streams');
}
```

Add `'content_streams'` and the individual tools to `VALID_JOB_TOOLS` (around line 394):

```typescript
  'content_streams',
  ...CONTENT_STREAM_TOOLS,
```

Add meta-tool expansion in `computeToolPolicy` (around line 520, after fireflies expansion):

```typescript
  // Expand content_streams meta-tool to Content Stream MCP tools
  if (expandedTools.includes('content_streams')) {
    expandedTools = [
      ...expandedTools.filter(t => t !== 'content_streams'),
      ...CONTENT_STREAM_TOOLS
    ];
  }
```

**Step 5: Run existing tests to verify nothing broke**

Run: `yarn vitest run tests/unit/gemini-agent/toolPolicy.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add jinn-node/src/agent/mcp/tools/index.ts jinn-node/src/agent/mcp/server.ts jinn-node/src/agent/toolPolicy.ts
git commit -m "feat(tools): register content stream tools in server and policy"
```

---

### Task 4: Refactor `commit-summary-telegram` → `commit-summary`

**Files:**
- Rename: `blueprints/commit-summary-telegram.json` → `blueprints/commit-summary.json`
- Modify the renamed file

**Step 1: Rename the file**

```bash
git mv blueprints/commit-summary-telegram.json blueprints/commit-summary.json
```

**Step 2: Edit the blueprint**

Apply these changes to `blueprints/commit-summary.json`:

1. Update `templateMeta.id` from `"commit-summary-telegram"` to `"commit-summary"`
2. Update `templateMeta.name` from `"Commit Summary Telegram"` to `"Commit Summary"`
3. Update `templateMeta.description` to: `"Extract interesting features and updates from repository commits and publish as a content stream artifact"`
4. Remove `telegramChatId` and `telegramTopicId` from `inputSchema.properties`
5. Update `inputSchema.required` to just `["repoUrl", "timePeriod"]`
6. Add `publishes` to `templateMeta`:
   ```json
   "publishes": [{
     "stream": "FEED:commit-highlights",
     "description": "Curated highlights from recent repository commits"
   }]
   ```
7. Update `outputSpec.fields`: remove `messageLink` and `messageId` fields, keep `messageBody` (rename to `summary`) and `commitCount`
8. Update `tools`: remove `{ "name": "telegram_messaging", "required": true }`, add `{ "name": "content_streams", "required": true }`
9. Replace `GOAL-003` invariant (TG posting) with a new one about creating a `FEED:commit-highlights` artifact:
   ```json
   {
     "id": "GOAL-003",
     "type": "BOOLEAN",
     "condition": "You publish the highlights as a content stream artifact with topic 'FEED:commit-highlights' using create_artifact",
     "assessment": "create_artifact was called with topic 'FEED:commit-highlights', name includes the repo name and time period, and content is the formatted highlights summary suitable for downstream consumption.",
     "examples": {
       "do": [
         "Call create_artifact with topic: 'FEED:commit-highlights'",
         "Include repo name and time period in the artifact name",
         "Format content as readable highlights, not raw data"
       ],
       "dont": [
         "Skip the artifact creation",
         "Use a different topic name",
         "Dump raw commit messages as the artifact content"
       ]
     }
   }
   ```
10. Update `OUTPUT-001` to reference the stream artifact instead of TG message fields:
    ```json
    {
      "id": "OUTPUT-001",
      "type": "BOOLEAN",
      "condition": "Your final artifact includes: summary and commitCount",
      "assessment": "create_artifact was called with topic 'FEED:commit-highlights' containing the formatted summary and commit count",
      "examples": {
        "do": [
          "Include the full summary that was created",
          "Count total commits analyzed for commitCount"
        ],
        "dont": [
          "Return without creating the result artifact",
          "Omit the summary content"
        ]
      }
    }
    ```

**Step 3: Commit**

```bash
git add blueprints/commit-summary.json
git commit -m "refactor(blueprints): convert commit-summary-telegram to stream-based commit-summary"
```

---

### Task 5: Update `telegram-community.json`

**Files:**
- Modify: `blueprints/telegram-community.json`

**Step 1: Remove `TG-CONTENT-SHARING` invariant**

Delete the entire `TG-CONTENT-SHARING` object from the `invariants` array (the one with id `"TG-CONTENT-SHARING"`, around lines 181-198).

**Step 2: Remove blog tools**

Remove these two entries from `templateMeta.tools`:
```json
{ "name": "blog_list_posts", "required": false },
{ "name": "blog_get_post", "required": false }
```

**Step 3: Remove `telegramBotToken` from input schema**

Delete the `telegramBotToken` property from `inputSchema.properties`.

**Step 4: Rename `domain` → `websiteUrl`**

Replace the `domain` property in `inputSchema.properties` with:
```json
"websiteUrl": {
    "type": "string",
    "description": "Project website URL (for linking in responses)",
    "envVar": "WEBSITE_URL"
}
```

**Step 5: Commit**

```bash
git add blueprints/telegram-community.json
git commit -m "refactor(blueprints): remove content sharing from telegram-community template"
```

---

### Task 6: Create `telegram-content-distributor.json` blueprint

**Files:**
- Create: `blueprints/telegram-content-distributor.json`

**Step 1: Write the blueprint**

Create `blueprints/telegram-content-distributor.json`:

```json
{
    "templateMeta": {
        "id": "telegram-content-distributor",
        "name": "Telegram Content Distributor",
        "description": "Reads from subscribed content streams and distributes curated highlights to Telegram. Decides per-item whether to share directly, summarize into a digest, or transform for the audience.",
        "priceWei": "0",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subscribedStreams": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Array of FEED:* stream names to consume (e.g., ['FEED:commit-highlights', 'FEED:research-posts'])"
                },
                "telegramChatId": {
                    "type": "string",
                    "description": "Telegram chat ID for posting",
                    "envVar": "TELEGRAM_CHAT_ID"
                },
                "telegramTopicId": {
                    "type": "string",
                    "description": "Telegram topic/thread ID for forum supergroups (optional)",
                    "envVar": "TELEGRAM_TOPIC_ID"
                },
                "personality": {
                    "type": "string",
                    "description": "Voice and tone for formatting messages. If not provided, uses neutral informative style.",
                    "default": "Clear, concise, and informative. Highlights what matters to the community."
                },
                "lookbackPeriod": {
                    "type": "string",
                    "description": "How far back to check for new content (e.g., '3 hours', '8 hours', '24 hours')",
                    "default": "3 hours"
                }
            },
            "required": ["subscribedStreams", "telegramChatId"]
        },
        "outputSpec": {
            "version": "1.0",
            "fields": [
                {
                    "name": "itemsFound",
                    "path": "$.result.itemsFound",
                    "type": "number",
                    "required": true,
                    "description": "Total new items found across all subscribed streams"
                },
                {
                    "name": "itemsPosted",
                    "path": "$.result.itemsPosted",
                    "type": "number",
                    "required": true,
                    "description": "Number of items/digests actually posted to Telegram"
                },
                {
                    "name": "streamsChecked",
                    "path": "$.result.streamsChecked",
                    "type": "array",
                    "required": true,
                    "description": "List of stream names that were checked"
                }
            ]
        },
        "tools": [
            { "name": "content_streams", "required": true },
            { "name": "telegram_messaging", "required": true },
            { "name": "create_artifact", "required": true },
            { "name": "search_similar_situations", "required": false }
        ]
    },
    "invariants": [
        {
            "id": "DIST-001",
            "type": "BOOLEAN",
            "condition": "You check every stream in {{subscribedStreams}} for new content published within the last {{lookbackPeriod}}. Use read_content_stream for each subscribed stream with the appropriate since timestamp calculated from {{currentTimestamp}} minus {{lookbackPeriod}}.",
            "assessment": "read_content_stream called once per stream in subscribedStreams. The since parameter is correctly calculated as currentTimestamp minus lookbackPeriod.",
            "examples": {
                "do": [
                    "For each stream in subscribedStreams, call read_content_stream with since = currentTimestamp - lookbackPeriod",
                    "If lookbackPeriod is '3 hours' and currentTimestamp is 2026-02-25T17:00:00Z, use since: 2026-02-25T14:00:00Z",
                    "Collect all new items across all streams before deciding what to post"
                ],
                "dont": [
                    "Skip streams — check every one in the subscribedStreams array",
                    "Use an arbitrary since time instead of calculating from lookbackPeriod",
                    "Post items one by one without first seeing the full picture"
                ]
            }
        },
        {
            "id": "DIST-002",
            "type": "BOOLEAN",
            "condition": "For each batch of new content, you decide the best distribution format: share individual items directly when there are 1-2 high-quality items, summarize into a digest when there are 3+ items, or transform/rewrite when the original format doesn't suit the Telegram audience. Adapt your voice to {{personality}}.",
            "assessment": "Message format matches the volume and nature of content. Single items get individual posts. Multiple items get a digest. All messages match the personality spec.",
            "examples": {
                "do": [
                    "1 commit highlight → share it directly with a brief intro",
                    "5 items across streams → create a digest: 'Here's what Jinn built today...'",
                    "Technical research post → transform into community-friendly language",
                    "No new items → send nothing (silence is better than noise)"
                ],
                "dont": [
                    "Dump all items as separate messages regardless of count",
                    "Send a digest for a single item",
                    "Post raw artifact content without formatting for TG",
                    "Force a message when there's nothing new to share"
                ]
            }
        },
        {
            "id": "DIST-003",
            "type": "BOOLEAN",
            "condition": "You never repost content that was already distributed in a previous cycle. Before posting, use search_similar_situations to check if this content was already shared. Each cycle should only distribute genuinely new content.",
            "assessment": "search_similar_situations called before posting. No duplicate content across cycles. If all items were already posted, the cycle completes without sending any messages.",
            "examples": {
                "do": [
                    "Check search_similar_situations for recent distribution activity before posting",
                    "Skip items whose content closely matches previously distributed artifacts",
                    "If everything was already posted last cycle, complete silently"
                ],
                "dont": [
                    "Repost the same commit highlights every cycle",
                    "Skip the deduplication check",
                    "Post slightly rephrased versions of already-shared content"
                ]
            }
        },
        {
            "id": "DIST-004",
            "type": "BOOLEAN",
            "condition": "You create a distribution log artifact with topic 'FEED:tg-distribution-log' documenting what was posted this cycle. This enables other consumers to see what the TG venture has already distributed.",
            "assessment": "create_artifact called with topic 'FEED:tg-distribution-log'. Content includes: streams checked, items found, items posted (with message IDs), items skipped (with reasons).",
            "examples": {
                "do": [
                    "Log all streams checked and their item counts",
                    "Log each posted message with its Telegram message_id",
                    "Log skipped items with reason (duplicate, not interesting, etc.)",
                    "Create the log even if nothing was posted (documents that the check happened)"
                ],
                "dont": [
                    "Skip the log when nothing was posted",
                    "Omit skipped items from the log",
                    "Use a different topic than 'FEED:tg-distribution-log'"
                ]
            }
        }
    ]
}
```

**Step 2: Commit**

```bash
git add blueprints/telegram-content-distributor.json
git commit -m "feat(blueprints): add telegram-content-distributor template"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run all unit tests**

Run: `yarn test:unit`
Expected: All tests pass, including new content stream tests

**Step 2: Run tool policy tests specifically**

Run: `yarn vitest run tests/unit/gemini-agent/toolPolicy.test.ts`
Expected: PASS — new tools don't break existing policy logic

**Step 3: Commit any fixes if needed**

---

### Task 8: Operational — Seed templates and create venture

> This task is operational and depends on Supabase access. It can be done after code is merged.

**Step 1: Seed updated commit-summary template**

```bash
yarn tsx scripts/templates/seed-from-blueprint.ts blueprints/commit-summary.json --status published
```

**Step 2: Seed new content distributor template**

```bash
yarn tsx scripts/templates/seed-from-blueprint.ts blueprints/telegram-content-distributor.json --status published
```

**Step 3: Create the TG venture**

Use the ventures mint script or MCP tool with:
- Name: "Telegram Community & Content"
- Owner address: (your address)
- Blueprint with the 4 GOAL invariants from the design doc
- Status: active

**Step 4: Set dispatch schedule**

Use the setup-scheduled-venture script or update_dispatch_schedule tool:
- Community Management: `telegram-community` template, cron `0 */4 * * *`
- Content Distribution: `telegram-content-distributor` template, cron `0 9,17 * * *`, input with `subscribedStreams: ["FEED:commit-highlights"]`
