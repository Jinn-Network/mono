---
title: Services Discovery
purpose: reference
scope: [gemini-agent, mcp]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/search_services.ts
  - scripts/services/discovery.ts
keywords: [services, discovery, search, filtering, interfaces, deployments]
when_to_read: "Use when searching for services, filtering by capability, or exploring available interfaces"
---

# Services Discovery

The Services Discovery system provides comprehensive search and exploration of registered services across the Jinn platform.

## Overview

Services are organized hierarchically:
- **Ventures** - Top-level entities that own services (e.g., "Jinn")
- **Services** - Individual components with a specific purpose (e.g., "Services Discovery")
- **Deployments** - Running instances of services with health tracking
- **Interfaces** - API endpoints, MCP tools, and other integration points

## MCP Tool: `search_services`

### Modes

| Mode | Description | Required Parameters |
|------|-------------|---------------------|
| `discover` | General service discovery with filters | None (all optional) |
| `mcp_tools` | Find all registered MCP tool interfaces | None |
| `healthy` | Find services with healthy deployments | None |
| `by_venture` | List all services in a venture | `id` (venture ID) |
| `details` | Get full service details | `id` (service ID) |

### Parameters

```typescript
{
  mode: 'discover' | 'mcp_tools' | 'healthy' | 'by_venture' | 'details',
  id?: string,           // Service or venture UUID
  query?: string,        // Full-text search
  ventureId?: string,    // Filter by venture
  serviceType?: 'mcp' | 'api' | 'worker' | 'frontend' | 'library' | 'other',
  status?: 'active' | 'deprecated' | 'archived',
  tags?: string[],       // Filter by tags
  language?: string,     // Filter by primary language
  environment?: 'production' | 'staging' | 'development' | 'preview',
  provider?: 'railway' | 'vercel' | 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'self-hosted' | 'other',
  interfaceType?: 'mcp_tool' | 'rest_endpoint' | 'graphql' | 'grpc' | 'websocket' | 'webhook' | 'other',
  includeDeployments?: boolean,
  includeInterfaces?: boolean,
  limit?: number,
  offset?: number,
}
```

### Examples

**Find all MCP services:**
```json
{ "mode": "discover", "serviceType": "mcp", "status": "active" }
```

**Search by name:**
```json
{ "mode": "discover", "query": "auth" }
```

**Find MCP tools:**
```json
{ "mode": "mcp_tools", "query": "create" }
```

**Get service details:**
```json
{ "mode": "details", "id": "<service-uuid>" }
```

**Find production deployments:**
```json
{ "mode": "healthy", "environment": "production" }
```

## CLI Scripts

### Discovery Script

```bash
# General search
yarn tsx scripts/services/discovery.ts search --serviceType "mcp" --status "active"

# Search by venture
yarn tsx scripts/services/discovery.ts by-venture --ventureId "<uuid>"

# Full-text search
yarn tsx scripts/services/discovery.ts full-text --query "authentication"

# Find MCP tools
yarn tsx scripts/services/discovery.ts mcp-tools --search "create"

# Find healthy deployments
yarn tsx scripts/services/discovery.ts healthy --environment "production"

# Get service details
yarn tsx scripts/services/discovery.ts details --id "<uuid>"
```

## Service Registry Tool

The `service_registry` MCP tool provides CRUD operations:

| Action | Description |
|--------|-------------|
| `create_service` | Register a new service |
| `get_service` | Get service by ID |
| `list_services` | List with filters |
| `update_service` | Update service properties |
| `delete_service` | Remove a service |
| `create_deployment` | Add deployment |
| `list_deployments` | List deployments |
| `update_deployment` | Update deployment |
| `create_interface` | Add interface |
| `list_interfaces` | List interfaces |
| `update_interface` | Update interface |

## Database Schema

### ventures
- `id`, `name`, `slug`, `description`
- `owner_address` - Ethereum address of owner
- `blueprint` - JSONB with invariants array
- `root_workstream_id` - Optional workstream association
- `tags`, `featured`, `status`

### services
- `id`, `venture_id`, `name`, `slug`, `description`
- `service_type` - mcp, api, worker, frontend, library, other
- `repository_url`, `primary_language`, `version`
- `config`, `tags`, `status`

### deployments
- `id`, `service_id`, `environment`, `provider`
- `url`, `urls[]`, `version`
- `health_check_url`, `health_status`, `last_health_check`
- `status` - active, stopped, failed, deploying

### interfaces
- `id`, `service_id`, `name`, `interface_type`
- `mcp_schema` - For MCP tools
- `http_method`, `http_path` - For REST endpoints
- `input_schema`, `output_schema`
- `auth_required`, `auth_type`, `x402_price`
