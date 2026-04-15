---
name: services
description: Use when creating, managing, or querying services in the Jinn platform. Services are APIs owned by ventures. Use when working with service deployments, interfaces (MCP tools, REST endpoints), or documentation.
allowed-tools: service_registry
---

# Services Registry

You have access to services management tools for the Jinn platform. Services are API entities owned by ventures, with deployments, interfaces, and documentation.

## Architecture

```
Agent -> MCP Tool (service_registry) -> Supabase Database
```

## Available Operations

### SERVICES

#### create_service
Register a new service under a venture.

**Required:** `ventureId`, `name`
**Optional:** `slug`, `description`, `repositoryUrl`

```json
{
  "action": "create_service",
  "ventureId": "<venture-uuid>",
  "name": "My API Service",
  "description": "Handles user authentication"
}
```

#### get_service
Get service by ID.

```json
{ "action": "get_service", "id": "<service-uuid>" }
```

#### list_services
List services with optional filters.

```json
{
  "action": "list_services",
  "ventureId": "<venture-uuid>",
  "search": "auth",
  "limit": 20
}
```

#### update_service
Update service fields.

```json
{
  "action": "update_service",
  "id": "<service-uuid>",
  "description": "Updated description"
}
```

#### delete_service
Permanently delete a service.

```json
{ "action": "delete_service", "id": "<service-uuid>" }
```

---

### DEPLOYMENTS

Deployments track where services are running (Railway, Vercel, etc.).

#### create_deployment
**Required:** `serviceId`, `environment`, `provider`
**Optional:** `url`, `urls`, `version`, `config`, `healthCheckUrl`, `status`

```json
{
  "action": "create_deployment",
  "serviceId": "<service-uuid>",
  "environment": "production",
  "provider": "railway",
  "url": "https://my-service.up.railway.app"
}
```

**Environments:** `production`, `staging`, `development`, `preview`
**Providers:** `railway`, `vercel`, `cloudflare`, `aws`, `gcp`, `azure`, `self-hosted`, `other`

#### list_deployments
```json
{
  "action": "list_deployments",
  "serviceId": "<service-uuid>",
  "environment": "production"
}
```

#### update_deployment
```json
{
  "action": "update_deployment",
  "id": "<deployment-uuid>",
  "healthStatus": "healthy",
  "version": "1.2.0"
}
```

#### delete_deployment
```json
{ "action": "delete_deployment", "id": "<deployment-uuid>" }
```

---

### INTERFACES

Interfaces describe what a service exposes (MCP tools, REST endpoints, etc.).

#### create_interface
**Required:** `serviceId`, `name`, `interfaceType`
**Optional:** `description`, `mcpSchema`, `httpMethod`, `httpPath`, `inputSchema`, `outputSchema`, `authRequired`, `authType`, `rateLimit`, `x402Price`, `tags`, `status`

```json
{
  "action": "create_interface",
  "serviceId": "<service-uuid>",
  "name": "search_users",
  "interfaceType": "mcp_tool",
  "description": "Search for users by query",
  "authRequired": true,
  "authType": "bearer"
}
```

**Interface Types:** `mcp_tool`, `rest_endpoint`, `graphql`, `grpc`, `websocket`, `webhook`, `other`
**Auth Types:** `bearer`, `api_key`, `oauth`, `x402`, `none`

#### list_interfaces
```json
{
  "action": "list_interfaces",
  "serviceId": "<service-uuid>",
  "interfaceType": "mcp_tool"
}
```

#### update_interface
```json
{
  "action": "update_interface",
  "id": "<interface-uuid>",
  "status": "deprecated"
}
```

#### delete_interface
```json
{ "action": "delete_interface", "id": "<interface-uuid>" }
```

---

### DOCS

Documentation for services (guides, API docs, runbooks, etc.).

#### create_doc
**Required:** `serviceId`, `title`, `docType`, `content`
**Optional:** `slug`, `contentFormat`, `parentId`, `sortOrder`, `author`, `version`, `externalUrl`, `config`, `tags`, `docStatus`

```json
{
  "action": "create_doc",
  "serviceId": "<service-uuid>",
  "title": "Getting Started",
  "docType": "guide",
  "content": "# Getting Started\n\nWelcome to..."
}
```

**Doc Types:** `readme`, `guide`, `reference`, `tutorial`, `changelog`, `api`, `architecture`, `runbook`, `other`
**Content Formats:** `markdown`, `html`, `plaintext`
**Doc Status:** `draft`, `published`, `archived`

#### get_doc
```json
{ "action": "get_doc", "id": "<doc-uuid>" }
```

#### list_docs
```json
{
  "action": "list_docs",
  "serviceId": "<service-uuid>",
  "docType": "guide",
  "docStatus": "published"
}
```

#### update_doc
```json
{
  "action": "update_doc",
  "id": "<doc-uuid>",
  "docStatus": "published"
}
```

#### delete_doc
```json
{ "action": "delete_doc", "id": "<doc-uuid>" }
```

---

## CLI Scripts

```bash
# Services
yarn tsx scripts/services/crud.ts create --ventureId "<uuid>" --name "My Service"
yarn tsx scripts/services/crud.ts list --ventureId "<uuid>"
yarn tsx scripts/services/crud.ts update --id "<uuid>" --description "Updated"
yarn tsx scripts/services/crud.ts delete --id "<uuid>"

# Deployments
yarn tsx scripts/services/deployments.ts create --serviceId "<uuid>" --environment production --provider railway
yarn tsx scripts/services/deployments.ts list --serviceId "<uuid>"

# Interfaces
yarn tsx scripts/services/interfaces.ts create --serviceId "<uuid>" --name "my_tool" --interfaceType mcp_tool
yarn tsx scripts/services/interfaces.ts list --serviceId "<uuid>"

# Docs
yarn tsx scripts/services/docs.ts create --serviceId "<uuid>" --title "Guide" --docType guide --content "# Guide"
yarn tsx scripts/services/docs.ts list --serviceId "<uuid>"
```

## Best Practices

1. **One service per API** - Each distinct API should be its own service
2. **Use meaningful slugs** - Slugs appear in URLs, keep them short and descriptive
3. **Track all interfaces** - Register MCP tools, REST endpoints, etc. for discoverability
4. **Keep docs updated** - Link docs to service interfaces for better developer experience
5. **Monitor health status** - Update deployment health via health check endpoints
