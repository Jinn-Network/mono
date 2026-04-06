---
title: Creating Ventures
purpose: guide
scope: [gemini-agent, mcp]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/venture_mint.ts
  - gemini-agent/mcp/tools/venture_update.ts
  - gemini-agent/mcp/tools/venture_delete.ts
  - scripts/ventures/mint.ts
keywords: [ventures, create, mint, update, delete, CRUD, ownership]
when_to_read: "Use when creating new ventures, updating existing ones, or managing venture lifecycle"
---

# Creating Ventures

This guide covers how to create, query, update, and delete ventures in the Jinn platform.

## Prerequisites

- Valid Ethereum address for ownership
- Blueprint defining your venture's invariants
- Understanding of your service architecture

## Blueprint Design

A blueprint defines the success criteria (invariants) for your venture:

```json
{
  "invariants": [
    {
      "id": "inv-availability",
      "name": "Service Availability",
      "description": "All production services maintain 99.9% uptime",
      "type": "availability",
      "threshold": 0.999
    },
    {
      "id": "inv-latency",
      "name": "Response Time",
      "description": "API latency under 200ms p95",
      "type": "performance",
      "threshold": 200
    },
    {
      "id": "inv-security",
      "name": "Security Compliance",
      "description": "All endpoints require authentication",
      "type": "security"
    }
  ]
}
```

### Invariant Types

| Type | Description |
|------|-------------|
| `availability` | Uptime and reliability metrics |
| `performance` | Latency, throughput, resource usage |
| `security` | Authentication, authorization, encryption |
| `quality` | Code coverage, documentation, standards |
| `cost` | Budget constraints, resource limits |

## MCP Tools Overview

The ventures registry provides four MCP tools for complete CRUD operations:

| Tool | Operation | Description |
|------|-----------|-------------|
| `venture_mint` | CREATE | Create a new venture |
| `venture_query` | READ | Query ventures by ID, slug, workstream, or list all |
| `venture_update` | UPDATE | Modify venture fields |
| `venture_delete` | DELETE | Archive (soft) or permanently delete a venture |

---

## Creating Ventures

### Via CLI

```bash
yarn tsx scripts/ventures/mint.ts \
  --name "My Venture" \
  --ownerAddress "0x1234567890abcdef1234567890abcdef12345678" \
  --blueprint '{"invariants": []}'
```

### Via MCP Tool (venture_mint)

```json
{
  "tool": "venture_mint",
  "params": {
    "name": "My Venture",
    "slug": "my-venture",
    "description": "Description of the venture",
    "ownerAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "blueprint": "{\"invariants\": [...]}",
    "rootWorkstreamId": "optional-workstream-uuid",
    "rootJobInstanceId": "optional-job-instance-uuid",
    "status": "active"
  }
}
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Venture display name |
| `ownerAddress` | Yes | Ethereum address (0x...) |
| `blueprint` | Yes | JSON string with invariants array |
| `slug` | No | URL-friendly identifier (auto-generated from name) |
| `description` | No | Long description |
| `rootWorkstreamId` | No | Associated workstream UUID |
| `rootJobInstanceId` | No | Associated root job instance UUID |
| `status` | No | active, paused, archived (default: active) |

---

## Querying Ventures

### Via MCP Tool (venture_query)

The `venture_query` tool supports four modes:

#### Get by ID
```json
{
  "tool": "venture_query",
  "params": {
    "mode": "get",
    "id": "<venture-uuid>"
  }
}
```

#### Get by Slug
```json
{
  "tool": "venture_query",
  "params": {
    "mode": "by_slug",
    "slug": "my-venture"
  }
}
```

#### Get by Workstream ID
```json
{
  "tool": "venture_query",
  "params": {
    "mode": "by_workstream",
    "workstreamId": "<workstream-uuid>"
  }
}
```

#### List Ventures
```json
{
  "tool": "venture_query",
  "params": {
    "mode": "list",
    "status": "active",
    "limit": 20,
    "offset": 0
  }
}
```

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `mode` | No | get, list, by_slug, by_workstream (default: list) |
| `id` | For get | Venture UUID |
| `slug` | For by_slug | Venture slug |
| `workstreamId` | For by_workstream | Root workstream UUID |
| `status` | No | Filter by status (active, paused, archived) |
| `limit` | No | Max results for list mode (default: 20) |
| `offset` | No | Pagination offset |

---

## Updating Ventures

### Via CLI

```bash
yarn tsx scripts/ventures/update.ts \
  --id "<venture-uuid>" \
  --status "paused" \
  --description "Updated description"
```

### Via MCP Tool (venture_update)

```json
{
  "tool": "venture_update",
  "params": {
    "id": "<venture-uuid>",
    "name": "New Name",
    "description": "Updated description",
    "status": "paused"
  }
}
```

### Update Parameters

All fields except `id` are optional - only provided fields are updated:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | Yes | Venture UUID to update |
| `name` | No | New venture name |
| `slug` | No | New URL-friendly identifier |
| `description` | No | New description |
| `blueprint` | No | New JSON blueprint string |
| `rootWorkstreamId` | No | New workstream UUID |
| `rootJobInstanceId` | No | New root job instance UUID |
| `status` | No | active, paused, archived |

---

## Deleting Ventures

### Via MCP Tool (venture_delete)

The `venture_delete` tool supports two modes:

#### Soft Delete (Archive)
Sets status to 'archived' - venture can be restored:
```json
{
  "tool": "venture_delete",
  "params": {
    "id": "<venture-uuid>",
    "mode": "soft"
  }
}
```

#### Hard Delete (Permanent)
Permanently removes the venture - **cannot be undone**:
```json
{
  "tool": "venture_delete",
  "params": {
    "id": "<venture-uuid>",
    "mode": "hard",
    "confirm": true
  }
}
```

### Delete Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `id` | Yes | Venture UUID to delete |
| `mode` | No | soft (default) or hard |
| `confirm` | For hard | Must be `true` for permanent deletion |

### Important Notes

- **Prefer soft delete**: Use `mode: "soft"` to archive ventures that may need to be restored
- **Hard delete constraint**: Cannot hard delete ventures that have associated services
- **Hard delete requires confirmation**: Must set `confirm: true` as a safety measure

---

## Post-Creation Steps

After creating a venture, register your services:

1. **Register Services**
   ```json
   {
     "tool": "service_registry",
     "params": {
       "action": "create_service",
       "ventureId": "<venture-uuid>",
       "name": "API Service",
       "serviceType": "api"
     }
   }
   ```

2. **Add Deployments**
   ```json
   {
     "tool": "service_registry",
     "params": {
       "action": "create_deployment",
       "serviceId": "<service-uuid>",
       "environment": "production",
       "provider": "railway"
     }
   }
   ```

3. **Register Interfaces**
   ```json
   {
     "tool": "service_registry",
     "params": {
       "action": "create_interface",
       "serviceId": "<service-uuid>",
       "name": "get_users",
       "interfaceType": "rest_endpoint"
     }
   }
   ```

---

## Best Practices

1. **Define Clear Invariants**: Be specific about success criteria
2. **Use Meaningful Slugs**: Enable clean URLs and easy lookups
3. **Document Services**: Add descriptions to ventures and services
4. **Monitor Health**: Track deployment health status
5. **Prefer Soft Delete**: Archive ventures rather than permanently deleting
6. **Use Workstream Links**: Associate ventures with workstreams for automation
