---
title: Services Registry Overview
purpose: reference
scope: [gemini-agent, mcp]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/service_registry.ts
  - gemini-agent/mcp/tools/search_services.ts
  - skills/services/SKILL.md
keywords: [services, registry, catalog, discovery, deployments, interfaces]
when_to_read: "Use when understanding the services registry architecture or getting started with service management"
---

# Services Registry

The Services Registry is a centralized catalog of all services running within Jinn ventures. It provides discovery, management, and monitoring capabilities.

## Architecture

```
Venture
  └── Services
        ├── Deployments (running instances)
        ├── Interfaces (APIs, MCP tools)
        └── Documentation
```

## Quick Start

### Register a Service

```bash
yarn tsx scripts/services/crud.ts create \
  --ventureId "<venture-uuid>" \
  --name "My API" \
  --serviceType "api" \
  --description "REST API service"
```

### Add Deployment

```bash
yarn tsx scripts/services/deployments.ts create \
  --serviceId "<service-uuid>" \
  --environment "production" \
  --provider "railway" \
  --url "https://api.example.com"
```

### Register Interface

```bash
yarn tsx scripts/services/interfaces.ts create \
  --serviceId "<service-uuid>" \
  --name "get_users" \
  --interfaceType "rest_endpoint" \
  --httpMethod "GET" \
  --httpPath "/api/users"
```

## Service Types

| Type | Description |
|------|-------------|
| `mcp` | Model Context Protocol server |
| `api` | REST or GraphQL API |
| `worker` | Background job processor |
| `frontend` | Web application |
| `library` | Shared code package |
| `other` | Other service types |

## Deployment Providers

| Provider | Description |
|----------|-------------|
| `railway` | Railway.app |
| `vercel` | Vercel |
| `cloudflare` | Cloudflare Workers |
| `aws` | Amazon Web Services |
| `gcp` | Google Cloud Platform |
| `azure` | Microsoft Azure |
| `self-hosted` | Self-hosted infrastructure |
| `other` | Other providers |

## Interface Types

| Type | Description |
|------|-------------|
| `mcp_tool` | MCP tool function |
| `rest_endpoint` | REST API endpoint |
| `graphql` | GraphQL operation |
| `grpc` | gRPC service |
| `websocket` | WebSocket endpoint |
| `webhook` | Webhook receiver |
| `other` | Other interface types |

## MCP Tools

| Tool | Description |
|------|-------------|
| `service_registry` | CRUD operations for services |
| `search_services` | Discovery and search |

## Documentation

- [Managing Services](./managing-services.md) - Detailed CRUD guide
- [Discovery](./discovery.md) - Search and discovery
- [Ventures](../ventures/README.md) - Venture management

## CLI Scripts

| Script | Description |
|--------|-------------|
| `scripts/services/crud.ts` | Service CRUD |
| `scripts/services/deployments.ts` | Deployment management |
| `scripts/services/interfaces.ts` | Interface registration |
| `scripts/services/docs.ts` | Documentation management |
| `scripts/services/discovery.ts` | Discovery queries |
