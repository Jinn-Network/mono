---
name: ponder
description: >
  Build and maintain Ponder indexers — schema definitions, indexing functions,
  config, API endpoints, and query patterns. Use when writing ponder.config.ts,
  ponder.schema.ts, src/index.ts, or src/api/index.ts files. Covers onchainTable,
  factory contracts, multi-chain, Store API, GraphQL, and deployment config.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Ponder Indexer Development

Reference for building custom Ethereum indexers with Ponder (v0.9+). Ponder is a TypeScript framework that transforms onchain events into queryable Postgres tables via Drizzle ORM, Hono HTTP, and Viem.

---

## Project Structure

```
ponder.config.ts      # Chains, RPCs, contracts, ABIs, database
ponder.schema.ts      # Tables, views, enums, relations (Drizzle-based)
src/
  index.ts            # Indexing functions (ponder.on(...))
  api/
    index.ts          # Custom Hono API + GraphQL endpoint
abis/
  MyContract.ts       # ABI arrays (must use `as const`)
ponder-env.d.ts       # Auto-generated type file — commit it
```

---

## ponder.config.ts

```ts
import { createConfig } from "ponder";

export default createConfig({
  ordering: "multichain",  // "omnichain" | "multichain" | "experimental_isolated"
  database: { ... },
  chains: { ... },
  contracts: { ... },
  accounts: { ... },       // optional
  blocks: { ... },         // optional
});
```

### Database

```ts
// Local dev (default when DATABASE_URL unset)
database: { kind: "pglite", directory: ".ponder/pglite" }

// Production
database: {
  kind: "postgres",
  connectionString: process.env.DATABASE_URL,
  poolConfig: { max: 30 },
}
```

- `DATABASE_SCHEMA` env var or `--schema` CLI flag sets the Postgres schema
- `ponder dev` defaults to schema `"public"`; `ponder start` has NO default — must set explicitly
- Two instances CANNOT share the same schema

### Chains

```ts
chains: {
  mainnet: {
    id: 1,
    rpc: process.env.PONDER_RPC_URL_1,       // string, string[], or Viem Transport
    ws: "wss://...",                           // optional, lower-latency realtime
    pollingInterval: 1000,                     // ms
    disableCache: false,                       // true for Anvil/dev nodes
  },
  base: {
    id: 8453,
    rpc: [process.env.PONDER_RPC_URL_8453, "https://base.llamarpc.com"],
  },
}
```

Multiple RPC URLs = built-in load balancing. Also supports Viem transports (`http`, `webSocket`, `fallback`, `loadBalance`, `rateLimit`).

### Contracts

```ts
contracts: {
  Blitmap: {
    abi: BlitmapAbi,                // required, must be `as const`
    chain: "mainnet",               // string or multi-chain object
    address: "0x8d04...",           // string, array, or factory()
    startBlock: 12439123,           // ALWAYS set to deployment block (default 0 scans entire chain)
    endBlock: undefined,            // undefined = live indexing
    filter: {                       // optional: narrow by indexed param values
      event: "Transfer",
      args: { from: "0x28c6..." },
    },
    includeCallTraces: false,       // enable call trace indexing
    includeTransactionReceipts: false,
  },
}
```

#### Multi-chain contract

```ts
chain: {
  mainnet: { address: "0x1F98...", startBlock: 12369621 },
  base:    { address: "0x3312...", startBlock: 1371680 },
},
```

Chain-specific config overrides top-level. `context.chain` narrows per handler.

#### Factory pattern

```ts
import { createConfig, factory } from "ponder";
import { parseAbiItem } from "viem";

address: factory({
  address: "0xb16c...",
  event: parseAbiItem("event NewPair(address poolAddress)"),
  parameter: "poolAddress",
})
```

Limitations: parameter must be a single `address` type (not array/tuple), one nesting level only.

#### Merged ABIs (proxy/upgradable)

```ts
import { mergeAbis } from "ponder";
abi: mergeAbis([ERC1967ProxyAbi, NameRegistryV1Abi, NameRegistryV2Abi])
```

### Accounts

Index transactions or native transfers sent to/from an address.

```ts
accounts: {
  BeaverBuild: {
    chain: "mainnet",
    address: "0x9522...",
    startBlock: 20000000,
  },
}
```

Events: `AccountName:transaction:from`, `AccountName:transaction:to`, `AccountName:transfer:from`, `AccountName:transfer:to`.

Warning: account indexing uses `eth_getBlockByNumber` and `debug_traceBlockByNumber` which don't support filtering — large backfills are expensive.

### Block Intervals

```ts
blocks: {
  OracleUpdate: {
    chain: "mainnet",
    interval: 10,        // every 10 blocks
    startBlock: 19750000,
  },
}
```

Event: `"OracleUpdate:block"`. The event object only has `event.block`.

### Ordering Strategies

| Strategy | Cross-chain order | Constraints |
|---|---|---|
| `"omnichain"` | Deterministic (timestamp, chainId, blockNum) | None |
| `"multichain"` (default) | Non-deterministic | No cross-chain writes unless commutative |
| `"experimental_isolated"` | Non-deterministic | No cross-chain reads/writes; all PKs need `chainId` |

---

## ponder.schema.ts

Built on Drizzle ORM. All tables, views, enums, and relations must be **named exports**.

```ts
import { onchainTable, onchainEnum, onchainView, relations, primaryKey, index } from "ponder";
```

### Tables

```ts
export const account = onchainTable(
  "account",
  (t) => ({
    address: t.hex().primaryKey(),
    balance: t.bigint().notNull(),
    nickname: t.text(),
    age: t.integer(),
    score: t.real(),
    active: t.boolean().notNull(),
    createdAt: t.timestamp(),
    metadata: t.json().$type<{ name: string }>(),
    tags: t.text().array(),
    livesRemaining: t.integer().default(9),
  }),
  (table) => ({
    nameIdx: index().on(table.nickname),
  }),
);
```

#### Column types

| Type | Stores | TS type |
|---|---|---|
| `t.hex()` | addresses, bytes | `` `0x${string}` `` |
| `t.bigint()` | uint256/int256 | `bigint` (stored as `NUMERIC(78,0)`) |
| `t.text()` | strings | `string` |
| `t.integer()` | 4-byte int | `number` |
| `t.real()` | float | `number` |
| `t.boolean()` | bool | `boolean` |
| `t.timestamp()` | datetime | `Date` |
| `t.json()` | arbitrary JSON | `unknown` (use `.$type<T>()`) |

Modifiers: `.primaryKey()`, `.notNull()`, `.default(value)`, `.$default(() => fn())`, `.array()`, `.$type<T>()`

#### Composite primary keys

```ts
export const allowance = onchainTable(
  "allowance",
  (t) => ({
    owner: t.hex().notNull(),
    spender: t.hex().notNull(),
    amount: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.owner, table.spender] }),
  }),
);
```

#### Indexes

Create on columns used in filters, joins, sorts. Indexes build **after** backfill completes. Relations do NOT auto-create indexes — add them explicitly.

### Enums

```ts
export const color = onchainEnum("color", ["ORANGE", "BLACK"]);

export const cats = onchainTable("cats", (t) => ({
  name: t.text().primaryKey(),
  color: color("color"),
}));
```

### Relations

Affect GraphQL API and Drizzle Query API only. Do NOT create FK constraints.

```ts
export const personsRelations = relations(persons, ({ many }) => ({
  dogs: many(dogs),
}));

export const dogsRelations = relations(dogs, ({ one }) => ({
  owner: one(persons, { fields: [dogs.ownerName], references: [persons.name] }),
}));
```

Always define both sides. The `one` side specifies `fields` (local FK) and `references` (target PK).

### Views

```ts
import { sql, sum } from "drizzle-orm";

export const hourlyBucket = onchainView("hourly_bucket").as((qb) =>
  qb
    .select({
      hour: sql`FLOOR(${transferEvent.timestamp} / 3600) * 3600`.as("hour"),
      totalVolume: sum(transferEvent.amount).as("total_volume"),
    })
    .from(transferEvent)
    .groupBy(sql`FLOOR(${transferEvent.timestamp} / 3600)`),
);
```

Views: no Store API, no singular GraphQL query, offset pagination only (no cursor). Re-execute SQL on every query — index underlying tables.

---

## src/index.ts — Indexing Functions

```ts
import { ponder } from "ponder:registry";
import { account, transferEvent } from "ponder:schema";

ponder.on("ContractName:EventName", async ({ event, context }) => {
  const { db, chain, client, contracts } = context;
  // ...
});
```

### Event name formats

| Type | Format | Requires |
|---|---|---|
| Log event | `"Contract:Event"` | contract in config |
| Setup | `"Contract:setup"` | contract in config |
| Call trace | `"Contract.function()"` | `includeCallTraces: true` |
| Tx from | `"Account:transaction:from"` | account in config |
| Tx to | `"Account:transaction:to"` | account in config |
| Transfer from | `"Account:transfer:from"` | account in config |
| Transfer to | `"Account:transfer:to"` | account in config |
| Block | `"Source:block"` | block interval in config |

### Event object shapes

**Log event:**
```ts
{
  name: string;
  args: { from: `0x${string}`; to: `0x${string}`; value: bigint };
  log: Log;           // address, topics, data, logIndex
  block: Block;       // number, timestamp, hash
  transaction: Transaction;
  transactionReceipt?: TransactionReceipt;  // if includeTransactionReceipts
}
```

**Call trace:**
```ts
{
  args: [...];        // decoded inputs
  result: ...;        // decoded output
  trace: Trace;       // from, to, gas, gasUsed, input, output
  block: Block;
  transaction: Transaction;
}
```

**Transfer:**
```ts
{
  transfer: { from, to, value };
  block: Block;
  transaction: Transaction;
  trace: Trace;
}
```

**Block:** `{ block: Block }`

### Setup events

Run once before indexing begins. Seed singletons or initial state.

```ts
ponder.on("MyContract:setup", async ({ context }) => {
  await context.db.insert(config).values({ id: 1, initialized: true });
});
```

Only `context` available (no `event`). RPC calls use `startBlock`.

### Reorgs

Handled automatically. Ponder rolls back to common ancestor and re-indexes. No special logic needed.

---

## Store API (Database Writes)

All writes happen in indexing functions via `context.db`.

```ts
// Insert
await db.insert(account).values({ address: "0x7Df1", balance: 0n });

// Insert many
await db.insert(account).values([
  { address: "0x7Df2", balance: 10n },
  { address: "0x7Df3", balance: 20n },
]);

// Find by primary key
const row = await db.find(account, { address: "0x7Df1" });
// Composite PK
const row = await db.find(allowance, { owner: "0x7Df1", spender: "0x7Df2" });

// Update
await db.update(account, { address: "0x7Df1" }).set({ balance: 100n });
// Update with function
await db.update(account, { address: "0x7Df1" }).set((row) => ({
  balance: row.balance + 100n,
}));

// Delete
const deleted = await db.delete(account, { address: "0x7Df1" });

// Upsert
await db.insert(account).values({ address: "0x7Df1", balance: 0n })
  .onConflictDoNothing();

await db.insert(account).values({ address: "0x7Df1", balance: 0n })
  .onConflictDoUpdate({ balance: 200n });

await db.insert(account).values({ address: "0x7Df1", balance: 0n })
  .onConflictDoUpdate((row) => ({ balance: row.balance + 50n }));
```

Store API is 100-1000x faster than raw SQL (in-memory + `COPY` flushes).

### Raw SQL (escape hatch, much slower)

```ts
import { eq, sql } from "drizzle-orm";

await db.sql.update(accounts).set({ points: sql`${accounts.points} + 100` }).where(...);
const rows = await db.sql.query.tradeEvents.findMany({ where: ..., with: { account: true } });
```

---

## Reading Contract Data

```ts
ponder.on("Blitmap:Mint", async ({ event, context }) => {
  const { client, contracts } = context;

  // Read configured contract (block auto-set to event.block.number)
  const uri = await client.readContract({
    abi: contracts.Blitmap.abi,
    address: contracts.Blitmap.address,
    functionName: "tokenURI",
    args: [event.args.tokenId],
  });

  // Read at specific block
  const supply = await client.readContract({
    abi: contracts.Blitmap.abi,
    address: contracts.Blitmap.address,
    functionName: "totalSupply",
    blockNumber: 15439123n,
  });

  // External contract (not in config — still cached)
  const price = await client.readContract({
    abi: ChainlinkAbi,
    address: "0x547a...",
    functionName: "latestRoundData",
  });

  // Multicall
  const results = await client.multicall({ contracts: [...] });
});
```

**NEVER create your own Viem client** (`createPublicClient`). Always use `context.client` — it handles caching and historical block state.

Factory contracts: `context.contracts.Pool` has no `address`. Use `event.log.address`.

---

## API Layer (src/api/index.ts)

Must default-export a Hono app.

### GraphQL

```ts
import { db } from "ponder:api";
import schema from "ponder:schema";
import { graphql } from "ponder";
import { Hono } from "hono";

const app = new Hono();
app.use("/graphql", graphql({ db, schema }));
export default app;
```

#### Filtering

```graphql
persons(where: { age_gt: 32, name_not_ends_with: "y" }) { items { name } }
persons(where: { AND: [{ name_contains: "ll" }, { age_gte: 50 }] }) { items { name } }
persons(where: { OR: [{ age_gt: 60 }, { name_starts_with: "A" }] }) { items { name } }
```

Operators: `_not`, `_in`, `_not_in`, `_gt`, `_lt`, `_gte`, `_lte`, `_contains`, `_starts_with`, `_ends_with`, `_has` (arrays), plus `_not_` variants.

#### Pagination

Cursor: `before`/`after` + `pageInfo.startCursor`/`endCursor`. Fast, consistent.

Offset: `offset` + `limit`. Simpler, slower for large datasets.

Both return `{ items, pageInfo { startCursor, endCursor, hasPreviousPage, hasNextPage }, totalCount }`.

`totalCount` can be slow — only request on first page.

### SQL over HTTP

```ts
import { client } from "ponder";
app.use("/sql/*", client({ db, schema }));
```

Client-side with `@ponder/client`:

```ts
import { createClient } from "@ponder/client";
import * as schema from "../../ponder/ponder.schema";

const client = createClient("http://localhost:42069/sql", { schema });
const result = await client.db.select().from(schema.account);
```

### Custom endpoints

```ts
import { db, publicClients } from "ponder:api";
import { accounts } from "ponder:schema";
import { eq } from "ponder";

app.get("/account/:address", async (c) => {
  const account = await db.select().from(accounts)
    .where(eq(accounts.address, c.req.param("address")));
  return c.json(account);
});
```

`db` is read-only Drizzle. `publicClients` is a `Record<chainName, PublicClient>`.

---

## CLI Commands

```bash
ponder dev             # Dev server, hot reload, default schema "public", port 42069
ponder start           # Production, MUST set --schema, no hot reload
ponder serve           # HTTP only (no indexer), for horizontal scaling
ponder codegen         # Regenerate ponder-env.d.ts
ponder db list         # List deployments in DB
ponder db prune        # Drop inactive deployment tables
ponder db create-views --schema=deploy-123 --views-schema=project-name
```

Flags: `--schema`, `--views-schema`, `-p`/`--port`, `-H`/`--hostname`, `-v`/`-vv` (debug/trace), `--log-format`

---

## Production Deployment

### Health endpoints

- `/health` — 200 immediately on start
- `/ready` — 200 when backfill complete, 503 during backfill

Use `/ready` for deploy healthchecks with long timeout (3600s+).

### Schema strategy

Each deployment needs a unique schema:
```bash
ponder start --schema $RAILWAY_DEPLOYMENT_ID
```

### Views for zero-downtime deploys

```bash
ponder start --schema=deploy-123 --views-schema=project-name
```

Downstream queries always target the static `project-name` schema. On new deploy, views auto-update.

### Horizontal scaling

Run multiple `ponder serve --schema=deploy-123` replicas behind a load balancer.

---

## Critical Gotchas

1. **Always set `startBlock`** to the contract deployment block. Default 0 scans the entire chain.
2. **PGlite is dev-only.** Set `DATABASE_URL` for production.
3. **`ponder start` requires `--schema`.** No default. Will fail without it.
4. **ABIs must be `as const`.** Without it, type inference breaks silently.
5. **Commit `ponder-env.d.ts`.** It drives the type system — accept auto-generated changes.
6. **Store API >> raw SQL.** 100-1000x faster in indexing functions. Only use `db.sql` as escape hatch.
7. **Never `createPublicClient`.** Use `context.client` — it caches and tracks block state.
8. **Relations don't create indexes.** Add indexes explicitly on FK columns.
9. **Indexes build after backfill.** No index benefit during initial sync.
10. **`filter` is usually unnecessary.** Ponder only fetches events with registered handlers. Only add `filter` to narrow by indexed parameter values.
11. **`mergeAbis` for proxy contracts.** Merge all implementation ABIs so historical events decode correctly.
12. **`experimental_isolated` requires `chainId` in all PKs.** Build fails otherwise.
13. **Factory parameter must be single `address` type.** No arrays, no tuples.
14. **`totalCount` in GraphQL is slow.** Only request on first page.
15. **Account indexing is expensive.** Uses unfiltered block-level RPCs for backfill.
