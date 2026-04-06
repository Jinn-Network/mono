---
title: MCP Tool Development
purpose: runbook
scope: [gemini-agent, mcp]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/server.ts
  - gemini-agent/mcp/tools/index.ts
  - gemini-agent/mcp/tools/shared/types.ts
  - gemini-agent/toolPolicy.ts
keywords: [MCP, tools, tool development, Zod schema, tool registration]
when_to_read: "Use when creating a new MCP tool, modifying existing tools, or understanding tool architecture"
---

# MCP Tool Development

How to build, register, and extend MCP tools in the Jinn agent server.

## Discovering Available Tools

Do NOT maintain static tool lists in documentation - tools change frequently.

**Runtime discovery:**
```bash
# Use the list_tools MCP tool
list_tools(include_parameters=true)
```

**Code inspection:**
- Tool registration: `gemini-agent/mcp/server.ts`
- Tool implementations: `gemini-agent/mcp/tools/`
- Each tool file is self-documenting via Zod schemas

## File Structure

```
gemini-agent/mcp/
├── server.ts              # Tool registration + MCP server setup
├── tools/
│   ├── index.ts           # Tool exports
│   ├── list-tools.ts      # Tool discovery
│   ├── get-details.ts     # Data fetching with pagination
│   ├── dispatch_new_job.ts
│   ├── create_artifact.ts
│   └── shared/
│       ├── context-management.ts  # Pagination, cursors, tokens
│       ├── env.ts                 # Environment config (re-exports from config/)
│       ├── ipfs.ts                # IPFS content resolution
│       ├── control_api.ts         # Control API client
│       ├── types.ts               # Shared type definitions
│       └── ...
```

## Creating a New Tool

### Step 1: Define the Schema

Use Zod with `.describe()` for parameter documentation:

```typescript
import { z } from 'zod';

const myToolParams = z.object({
  required_param: z.string().describe('What this param does'),
  optional_param: z.number().optional().describe('Optional context'),
});

export type MyToolParams = z.infer<typeof myToolParams>;

export const myToolSchema = {
  description: 'What this tool does overall',
  inputSchema: myToolParams.shape,
};
```

### Step 2: Implement the Handler

```typescript
export async function myTool(params: MyToolParams) {
  // Validate with safeParse for detailed errors
  const parseResult = myToolParams.safeParse(params);
  if (!parseResult.success) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          code: 'VALIDATION_ERROR',
          message: parseResult.error.message,
          details: parseResult.error.flatten?.()
        })
      }]
    };
  }

  // Implementation
  const result = await doWork(parseResult.data);

  // Return success
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        data: result,
        meta: { ok: true }
      })
    }]
  };
}
```

### Step 3: Export from Index

Add to `gemini-agent/mcp/tools/index.ts`:

```typescript
export { myTool, myToolSchema, myToolParams } from './my-tool.js';
```

### Step 4: Register in Server

Add to `serverTools` array in `gemini-agent/mcp/server.ts`:

```typescript
serverTools = [
  // ... existing tools
  { name: 'my_tool', schema: tools.myToolSchema, handler: tools.myTool },
];
```

Also add to `REGISTERED_MCP_TOOLS` array for validation.

## Response Format

### Success Response

```typescript
{
  content: [{
    type: 'text',
    text: JSON.stringify({
      data: <result>,
      meta: { ok: true, cursor?: string, tokens?: number }
    })
  }]
}
```

### Error Response

```typescript
{
  isError: true,
  content: [{
    type: 'text',
    text: JSON.stringify({
      ok: false,
      code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'UNEXPECTED_ERROR',
      message: 'Human-readable description'
    })
  }]
}
```

## Shared Utilities

### Pagination (context-management.ts)

For tools returning large datasets:

```typescript
import {
  composeSinglePageResponse,
  encodeCursor,
  decodeCursor
} from './shared/context-management.js';

// Decode incoming cursor
const keyset = decodeCursor<{ offset: number }>(params.cursor) ?? { offset: 0 };

// Fetch data
const allItems = await fetchData();

// Build paginated response
const { data, meta } = composeSinglePageResponse(allItems, {
  startOffset: keyset.offset,
  pageTokenBudget: 50000,       // Max tokens per page
  truncateChars: 300,           // Truncate long strings
});

return { content: [{ type: 'text', text: JSON.stringify({ data, meta }) }] };
```

### Environment Access (env.ts)

Environment getters are re-exported from `config/index.js`:

```typescript
import { getPonderGraphqlUrl, getRequiredMechAddress } from './shared/env.js';

const ponderUrl = getPonderGraphqlUrl();
const mechAddress = getRequiredMechAddress(); // Throws if missing
```

### IPFS Resolution (ipfs.ts)

```typescript
import { resolveRequestIpfsContent } from './shared/ipfs.js';

const content = await resolveRequestIpfsContent(cid);
```

### Control API (control_api.ts)

For on-chain workflows, tools must use the Control API client:

```typescript
import { controlApiClient } from './shared/control_api.js';

await controlApiClient.createArtifact({ ... });
```

Direct database writes are prohibited for on-chain workflows.

## Validation Patterns

Always use `safeParse()` for user-facing validation:

```typescript
const parseResult = schema.safeParse(input);
if (!parseResult.success) {
  // Return detailed error, don't throw
  return errorResponse('VALIDATION_ERROR', parseResult.error.message);
}
```

This provides:
- Detailed error messages to agents
- No exception stack traces in responses
- Flattened error details for debugging

## Testing

Run the MCP server locally:

```bash
cd gemini-agent && yarn dev
```

Test via:
- MCP inspector tool
- Direct JSON-RPC calls to stdio
- Integration tests in `gemini-agent/mcp/tools/__tests__/`
