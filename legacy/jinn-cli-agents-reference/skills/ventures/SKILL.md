---
name: ventures
description: Use when minting a new venture, viewing information about existing ventures, updating venture details or status, or shutting down (archiving/deleting) a venture. Use when working with venture blueprints, invariants, or owner addresses in the Jinn platform registry.
allowed-tools: venture_mint venture_query venture_update venture_delete
---

# Ventures Registry

You have access to ventures management tools for the Jinn platform. Ventures are project entities that own workstreams and services.

## Architecture

```
Agent -> MCP Tools / Scripts -> Supabase Database
```

## Available Operations

### CREATE - Mint a New Venture

Create a new venture with a blueprint defining success criteria.

**Required parameters:**
- `name`: Venture display name
- `ownerAddress`: Ethereum address (0x...)
- `blueprint`: JSON string with invariants array

**Optional parameters:**
- `slug`: URL-friendly identifier (auto-generated from name)
- `description`: Venture description
- `rootWorkstreamId`: Associated workstream UUID
- `rootJobInstanceId`: Associated root job instance UUID
- `status`: 'active', 'paused', or 'archived' (default: active)

**Token parameters (all optional):**
- `tokenAddress`: Token contract address on Base
- `tokenSymbol`: Token symbol (e.g., GROWTH, AMP2)
- `tokenName`: Token display name
- `stakingContractAddress`: Staking contract address
- `tokenLaunchPlatform`: Launch platform (e.g., "doppler")
- `tokenMetadata`: Platform-specific metadata JSON string (poolId, curves, safeAddress, etc.)
- `governanceAddress`: Governance contract address (e.g., Doppler governance)
- `poolAddress`: Liquidity pool address (e.g., GROWTH/OLAS Uniswap pool)

**Example (basic):**
```json
{
  "name": "My Venture",
  "ownerAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "blueprint": "{\"invariants\":[{\"id\":\"INV-001\",\"description\":\"Test invariant\"}]}",
  "status": "active"
}
```

**Example (with token):**
```json
{
  "name": "Growth Agency",
  "ownerAddress": "0x...",
  "blueprint": "{\"invariants\":[{\"id\":\"INV-001\",\"description\":\"Generate growth services\"}]}",
  "tokenAddress": "0x...",
  "tokenSymbol": "GROWTH",
  "tokenName": "Growth Agency Token",
  "tokenLaunchPlatform": "doppler",
  "poolAddress": "0x..."
}
```

### READ - View Venture Information

**Get by ID:**
```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

**Get by slug:**
```json
{ "slug": "my-venture" }
```

**List with filters:**
```json
{ "status": "active", "limit": 20, "offset": 0 }
```

### UPDATE - Modify Venture Details

Update any combination of venture fields. Only provided fields are modified. Supports all token fields (tokenAddress, tokenSymbol, tokenName, stakingContractAddress, tokenLaunchPlatform, tokenMetadata, governanceAddress, poolAddress).

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Updated Name",
  "status": "paused"
}
```

### DELETE - Shut Down a Venture

**Soft delete (archive)** - can be restored:
```json
{ "id": "<uuid>", "mode": "soft" }
```

**Hard delete (permanent)** - cannot be undone:
```json
{ "id": "<uuid>", "mode": "hard", "confirm": true }
```

## Blueprint Format

Blueprints define success criteria (invariants) for a venture. Use `category` and `problem` fields alongside the invariants array:

```json
{
  "category": "Research",
  "problem": "The specific problem this venture solves.",
  "invariants": [
    {
      "id": "GOAL-001",
      "type": "BOOLEAN",
      "condition": "You operate exactly one Jinn template",
      "assessment": "Count registered templates for this venture. Must equal exactly 1."
    },
    {
      "id": "GOAL-002",
      "type": "FLOOR",
      "metric": "monthly_revenue_usd",
      "min": 10000,
      "assessment": "Sum total revenue from all paid executions in the current calendar month"
    }
  ]
}
```

### Invariant Types

| Type | Required Fields | Use when |
|------|----------------|----------|
| **BOOLEAN** | `condition`, `assessment` | Yes/no check |
| **FLOOR** | `metric`, `min`, `assessment` | Minimum threshold |
| **CEILING** | `metric`, `max`, `assessment` | Maximum limit |
| **RANGE** | `metric`, `min`, `max`, `assessment` | Bounded value |

Full schema reference: [docs/guides/writing-invariants.md](../../docs/guides/writing-invariants.md)

## Writing Good Invariants

Invariants shape WHAT a venture must achieve in the world. The network works out HOW.

### Think like a venture investor, not a developer

**Bad (implementation specs):**
- "Resolve APY from on-chain data or official protocol APIs"
- "Cover Aave V3, Compound V3, Morpho, Spark, Fluid"
- "Rate data staleness under 1 hour"

**Good (product outcomes and business success):**
- "You operate exactly one Jinn template" (product shape)
- "$10k+ monthly revenue" (business viability)
- "Accurate APY snapshot for all wallet positions" (core value proposition)
- "4.5+ average feedback on 8004 marketplace" (market validation)
- "Cover top 5 EVM chains by DeFi TVL" (durable scope, not a hardcoded list)

### Key principles

1. **Outcomes over implementation.** Describe what success looks like from the outside. Don't prescribe which protocols, data sources, or methods to use — the network figures that out.

2. **Business reality matters.** Revenue and marketplace feedback are the actual measures of whether a venture matters. A technically perfect product nobody pays for is a failed venture.

3. **Use system-native language.** Reference things that exist in the platform — Jinn templates, the 8004 marketplace, feedback scores. Hook into the system's own measurement infrastructure.

4. **Stay durable.** "Top 5 EVM chains by TVL" beats "Ethereum, Base, Arbitrum" because the top 5 will shift over time. Invariants should stay correct as the world changes.

5. **Encode sensible structural constraints.** Some invariants aren't strictly product outcomes but are practical architectural choices — "exactly 1 template", "template must be published", etc. These shape how the venture operates within the current system and are valid.

6. **Every invariant needs an assessment.** The assessment explains HOW to measure. Use imperative voice: "Count...", "Verify...", "Sum...". Name specific data sources or tools when relevant.

### Minimum requirements

- At least 2 invariants per venture (enforced by frontend before token launch)
- Every invariant MUST have an `assessment` field
- Use second person for conditions: "You must...", "You produce..."

## CLI Scripts

```bash
# Mint a venture
yarn tsx scripts/ventures/mint.ts \
  --name "My Venture" \
  --ownerAddress "0x..." \
  --blueprint '{"invariants":[]}'

# Update a venture
yarn tsx scripts/ventures/update.ts \
  --id "<uuid>" \
  --status "paused"
```

## Dispatch Schedule — Input & Output Validation

When adding or updating schedule entries, **always check the template's `input_schema` and `output_spec`** in the `templates` table first. Schedule entry `input` fields must match the template's required inputs exactly — wrong field names or missing fields will cause silent failures at dispatch time.

**Checklist before writing a schedule entry:**
1. Query the template: `SELECT input_schema, output_spec FROM templates WHERE id = '<templateId>'`
2. Map every `required` field from `input_schema` into the schedule entry's `input` object
3. Use the exact field names from the schema (e.g., `telegramTopicId` not `telegramThreadId`)
4. Set `timePeriod` to match the cron cadence (e.g., `"3 hours"` for a 3-hour cron)
5. Check `output_spec` to understand what the template produces — useful for chaining templates or verifying results

**Example — correct entry for `commit-summary-telegram`:**
```json
{
  "id": "entry-commit-summary-telegram",
  "templateId": "499ff31f-e38b-45f9-9a77-26525c260e9b",
  "cron": "0 8,11,14,17,20 * * 1-5",
  "label": "Commit Summary Telegram",
  "enabled": true,
  "input": {
    "repoUrl": "Jinn-Network/jinn-cli-agents",
    "timePeriod": "3 hours",
    "telegramChatId": "-1003682777125",
    "telegramTopicId": "555"
  }
}
```

## Best Practices

1. **Use soft delete by default** - Archive ventures rather than permanently deleting
2. **Validate blueprints** - Ensure blueprint JSON has an `invariants` array
3. **Use slugs for lookups** - Slugs are human-readable and unique
4. **Link to workstreams** - Associate ventures with workstreams for automation
5. **Always check template schema before writing schedule inputs** - See "Dispatch Schedule — Input & Output Validation" above
