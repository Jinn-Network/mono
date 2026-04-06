---
title: Managing Services
purpose: guide
scope: [gemini-agent, mcp]
last_verified: 2026-01-30
related_code:
  - gemini-agent/mcp/tools/service_registry.ts
  - scripts/services/crud.ts
  - scripts/services/deployments.ts
  - scripts/services/interfaces.ts
keywords: [services, CRUD, create, update, delete, deployments, interfaces, documentation]
when_to_read: "Use when creating, updating, or managing services and their deployments/interfaces"
---

# Managing Services

This guide covers the full lifecycle of managing services in the Jinn registry.

## Service CRUD Operations

### Creating Services

**CLI:**
```bash
yarn tsx scripts/services/crud.ts create \
  --ventureId "550e8400-e29b-41d4-a716-446655440000" \
  --name "Auth Service" \
  --serviceType "api" \
  --description "Authentication and authorization" \
  --repositoryUrl "https://github.com/org/auth-service" \
  --primaryLanguage "typescript" \
  --version "1.0.0" \
  --tags "auth,security"
```

**MCP Tool:**
```json
{
  "tool": "service_registry",
  "params": {
    "action": "create_service",
    "ventureId": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Auth Service",
    "serviceType": "api",
    "description": "Authentication and authorization",
    "repositoryUrl": "https://github.com/org/auth-service",
    "primaryLanguage": "typescript",
    "version": "1.0.0",
    "tags": ["auth", "security"]
  }
}
```

### Listing Services

```bash
# All services
yarn tsx scripts/services/crud.ts list

# Filter by venture
yarn tsx scripts/services/crud.ts list --ventureId "..."

# Filter by type
yarn tsx scripts/services/crud.ts list --serviceType "mcp"

# Search
yarn tsx scripts/services/crud.ts list --search "auth"
```

### Updating Services

```bash
yarn tsx scripts/services/crud.ts update \
  --id "service-uuid" \
  --version "2.0.0" \
  --status "active"
```

### Deleting Services

```bash
yarn tsx scripts/services/crud.ts delete --id "service-uuid"
```

## Deployment Management

### Adding Deployments

```bash
yarn tsx scripts/services/deployments.ts create \
  --serviceId "service-uuid" \
  --environment "production" \
  --provider "railway" \
  --url "https://api.example.com" \
  --healthCheckUrl "https://api.example.com/health"
```

### Health Tracking

```bash
# Update health status
yarn tsx scripts/services/deployments.ts update \
  --id "deployment-uuid" \
  --healthStatus "healthy"

# List by health
yarn tsx scripts/services/deployments.ts list \
  --healthStatus "unhealthy"
```

### Environment Management

```bash
# Production deployments
yarn tsx scripts/services/deployments.ts list --environment "production"

# All Railway deployments
yarn tsx scripts/services/deployments.ts list --provider "railway"
```

## Interface Registration

### MCP Tools

```bash
yarn tsx scripts/services/interfaces.ts create \
  --serviceId "service-uuid" \
  --name "create_user" \
  --interfaceType "mcp_tool" \
  --description "Creates a new user account" \
  --mcpSchema '{"type":"object","properties":{"email":{"type":"string"}}}'
```

### REST Endpoints

```bash
yarn tsx scripts/services/interfaces.ts create \
  --serviceId "service-uuid" \
  --name "GET /users/:id" \
  --interfaceType "rest_endpoint" \
  --httpMethod "GET" \
  --httpPath "/api/users/:id" \
  --authRequired true \
  --authType "bearer"
```

### x402 Pricing

```bash
yarn tsx scripts/services/interfaces.ts create \
  --serviceId "service-uuid" \
  --name "premium_analysis" \
  --interfaceType "mcp_tool" \
  --authType "x402" \
  --x402Price 1000000  # Price in wei
```

## Documentation

### Creating Docs

```bash
yarn tsx scripts/services/docs.ts create \
  --serviceId "service-uuid" \
  --title "Getting Started" \
  --docType "guide" \
  --content "# Getting Started\n\nWelcome to..."
```

### Doc Types

| Type | Description |
|------|-------------|
| `readme` | Main README |
| `guide` | How-to guides |
| `reference` | API reference |
| `tutorial` | Step-by-step tutorials |
| `changelog` | Version history |
| `api` | API documentation |
| `architecture` | Architecture docs |
| `runbook` | Operations runbooks |

### Publishing

```bash
yarn tsx scripts/services/docs.ts publish --id "doc-uuid"
```

### Hierarchical Docs

```bash
# Create parent doc
yarn tsx scripts/services/docs.ts create \
  --serviceId "..." \
  --title "API Reference" \
  --docType "reference"

# Create child doc
yarn tsx scripts/services/docs.ts create \
  --serviceId "..." \
  --title "User Endpoints" \
  --docType "reference" \
  --parentId "parent-doc-uuid" \
  --sortOrder 1
```

## Discovery

### Search Services

```bash
# Full-text search
yarn tsx scripts/services/discovery.ts full-text --query "authentication"

# By type
yarn tsx scripts/services/discovery.ts by-type --serviceType "mcp"

# By tags
yarn tsx scripts/services/discovery.ts by-tag --tags "auth,security"
```

### Find MCP Tools

```bash
yarn tsx scripts/services/discovery.ts mcp-tools --search "create"
```

### Health Monitoring

```bash
yarn tsx scripts/services/discovery.ts healthy --environment "production"
```

## Best Practices

1. **Use Descriptive Names**: Clear, action-oriented names for interfaces
2. **Document Everything**: Add docs for all public interfaces
3. **Version Services**: Use semantic versioning
4. **Monitor Health**: Set up health check URLs
5. **Tag for Discovery**: Use consistent tagging conventions
6. **Secure Endpoints**: Mark auth requirements accurately
