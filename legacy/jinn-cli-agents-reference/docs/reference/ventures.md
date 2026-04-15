---
title: Ventures Overview
purpose: reference
scope: [gemini-agent, mcp]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/venture_mint.ts
  - gemini-agent/mcp/tools/venture_query.ts
  - gemini-agent/mcp/tools/venture_update.ts
  - skills/ventures/SKILL.md
keywords: [ventures, registry, organization, projects, ownership]
when_to_read: "Use when understanding ventures architecture or getting started with venture management"
---

# Ventures

Ventures are the top-level organizational units in Jinn. Each venture represents a distinct project, product, or initiative that owns services, workstreams, and other resources.

## Overview

A venture is defined by:
- **Identity**: Name, slug, description
- **Ownership**: Ethereum address of the owner
- **Blueprint**: Invariants (success criteria) that define the venture's goals
- **Resources**: Services, workstreams, and configurations

## Quick Start

### Creating a Venture

```bash
# Using CLI script
yarn tsx scripts/ventures/mint.ts \
  --name "My Project" \
  --ownerAddress "0x1234..." \
  --blueprint '{"invariants": [{"id": "inv-1", "name": "Uptime", "type": "availability"}]}'
```

### Using MCP Tool

```json
{
  "tool": "venture_mint",
  "params": {
    "name": "My Project",
    "ownerAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "blueprint": "{\"invariants\": [{\"id\": \"inv-1\", \"name\": \"Uptime\"}]}",
    "tags": ["project", "demo"]
  }
}
```

## Venture Lifecycle

1. **Create** - Mint a new venture with blueprint
2. **Configure** - Set up services, deployments, interfaces
3. **Operate** - Monitor invariants, manage workstreams
4. **Archive** - Archive when complete

## Documentation

- [Creating Ventures](./creating-ventures.md) - Detailed guide
- [Services Overview](../services/README.md) - Managing services
- [Discovery](../services/discovery.md) - Finding services

## Database Schema

```sql
CREATE TABLE ventures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_address TEXT NOT NULL,
  blueprint JSONB NOT NULL DEFAULT '{}',
  root_workstream_id UUID,
  job_template_id UUID,
  config JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  featured BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

## Related Tools

| Tool | Description |
|------|-------------|
| `venture_mint` | Create new venture |
| `venture_update` | Update venture properties |
| `service_registry` | Manage services |
| `search_services` | Discover services |
