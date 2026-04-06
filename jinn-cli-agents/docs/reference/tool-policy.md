---
title: Tool Policy Reference
purpose: reference
scope: [gemini-agent]
last_verified: 2026-01-30
related_code:
  - gemini-agent/toolPolicy.ts
  - gemini-agent/agent.ts
keywords: [tools, meta-tools, enabledTools, universal tools, coding tools]
when_to_read: "Use when configuring which tools an agent can use, or debugging UNAUTHORIZED_TOOLS errors"
---

# Tool Policy Reference

Quick reference for tool enablement, meta-tools, and troubleshooting.

---

## Tool Enablement Hierarchy

Tools are enabled at three levels:

### 1. Universal Tools (Always Enabled)

Every agent automatically has these tools - no configuration needed:

**Job Management:**
- `list_tools` - Discover available tools
- `get_details` - Retrieve on-chain records
- `dispatch_new_job` - Create new job definitions
- `dispatch_existing_job` - Re-run existing jobs
- `inspect_situation` - Inspect memory for a request

**Artifacts:**
- `create_artifact` - Upload content to IPFS
- `create_measurement` - Record invariant measurements
- `search_jobs` - Search job definitions
- `search_artifacts` - Search artifacts

**Web:**
- `google_web_search` - Web search
- `web_fetch` - Fetch URL content

**Read-Only File Operations:**
- `list_directory`, `read_file`, `read_many_files`, `search_file_content`, `glob`

### 2. Coding Tools (Coding Jobs Only)

If job has `isCodingJob: true`, these are also enabled:
- `process_branch` - Git branch operations
- `write_file` - Write files
- `replace` - Edit files
- `run_shell_command` - Execute shell commands

### 3. Template Tools

Templates define which additional tools are available via a `tools` list:

```json
{
  "tools": [
    { "name": "telegram_messaging", "required": true },
    { "name": "blog_create_post", "required": false },
    { "name": "blog_list_posts" }
  ]
}
```

**`required: true`** → Always enabled for ALL jobs in workstream
**`required: false`** (or omitted) → Available in whitelist, must be enabled at dispatch

---

## Enabling Tools at Dispatch

When dispatching a child job, specify which whitelist tools to enable:

```typescript
dispatch_new_job({
  jobName: "Content Writer",
  enabledTools: ["blog_create_post", "blog_list_posts"],
  blueprint: "..."
})
```

**Rules:**
- Only tools in template's whitelist can be enabled
- Parent cannot give child tools it doesn't have access to
- Universal tools are always included (don't list them)
- `required: true` tools are always included (don't need to list them)

---

## Meta-Tools

Some tools are "meta-tools" that expand to multiple individual tools at runtime:

| Meta-Tool | Expands To |
|-----------|------------|
| `telegram_messaging` | `telegram_send_message`, `telegram_send_photo`, `telegram_send_document` |
| `fireflies_meetings` | `fireflies_search`, `fireflies_get_transcripts`, `fireflies_get_summary` |
| `content_streams` | `search_content_streams`, `read_content_stream` |
| `browser_automation` | 26 Chrome DevTools tools |
| `railway_deployment` | 24 Railway management tools |
| ~~`nano_banana`~~ | Deprecated — silently ignored |

**Important:** Always use the meta-tool name in templates and `enabledTools`. The expansion happens automatically at runtime.

---

## Common Errors

### UNAUTHORIZED_TOOLS

**Error:** `enabledTools not allowed by template policy: telegram_send_message...`

**Cause:** Job tried to enable tools not in template whitelist.

**Common scenarios:**

1. **Tool not in template** - The tool isn't listed in template's `tools` array
   - Fix: Add the tool to the template

2. **Used individual tool instead of meta-tool** - Requested `telegram_send_message` instead of `telegram_messaging`
   - Fix: Use the meta-tool name in `enabledTools`

3. **Parent doesn't have the tool** - Parent tried to give child a tool it doesn't have access to
   - Fix: Ensure parent has the tool enabled, or add to template

**Debugging steps:**
1. Check template's `tools` list - is the tool there?
2. If using Telegram/Fireflies/etc, are you using the meta-tool name?
3. Check parent's `enabledTools` - does it have access?

---

## Tool Flow Summary

```
Template defines:
  tools: [
    { name: "telegram_messaging", required: true },   ← Always enabled
    { name: "blog_create_post" }                      ← Whitelist only
  ]

At dispatch:
  dispatch_new_job({
    enabledTools: ["blog_create_post"]   ← From whitelist
  })

Agent receives:
  - Universal tools (automatic)
  - telegram_messaging (required: true)
  - blog_create_post (explicitly enabled)

  Meta-tool expansion:
  - telegram_send_message, telegram_send_photo, telegram_send_document
```

---

## Related Documentation

- Template structure: `docs/guides/blueprints_and_templates.md`
- Tool implementation: `gemini-agent/toolPolicy.ts`
- System architecture: `docs/context/system-overview.md`
