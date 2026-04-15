# Node Config System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all `process.env` reads and `getXxx()` config getters in jinn-node with a typed `config` object backed by `jinn.yaml`.

**Architecture:** YAML config file → env var overrides → Zod validation → frozen typed singleton. Secrets stay in `.env`. Runtime context (`JINN_CTX_*`) moves to a separate typed module. Clean break — no backwards-compatible bridge.

**Tech Stack:** TypeScript, Zod, `yaml` npm package, Vitest

**Design doc:** `docs/plans/2026-03-02-node-config-system-design.md`

---

## Scope Summary

- **407** `process.env` reads across **71 files** in `jinn-node/src/`
- ~112 of those are `JINN_CTX_*` runtime context (separate module, not YAML)
- ~30 are secret reads (`OPERATE_PASSWORD`, API keys) — stay as `.env` reads via `config.secrets`
- ~265 are config reads that move to `config.<section>.<key>`

---

### Task 1: Add `yaml` dependency

**Files:**
- Modify: `jinn-node/package.json`

**Step 1: Install yaml parser**

```bash
cd jinn-node && yarn add yaml
```

**Step 2: Commit**

```bash
git add jinn-node/package.json jinn-node/yarn.lock
git commit -m "chore: add yaml dependency for config system"
```

---

### Task 2: Create Zod schema for jinn.yaml

**Files:**
- Create: `jinn-node/src/config/schema.ts`
- Test: `tests-next/unit/config/schema.test.ts`

**Step 1: Write the failing test**

```typescript
// tests-next/unit/config/schema.test.ts
import { describe, it, expect } from 'vitest';
import { configSchema, type NodeConfig } from '../../jinn-node/src/config/schema.js';

describe('configSchema', () => {
  it('parses a minimal valid config with defaults', () => {
    const result = configSchema.parse({
      chain: { rpc_url: 'https://mainnet.base.org', chain_id: 8453 },
    });
    expect(result.chain.rpc_url).toBe('https://mainnet.base.org');
    expect(result.worker.poll_base_ms).toBe(30000);
    expect(result.blueprint.enable_beads).toBe(false);
    expect(result.filtering.workstreams).toEqual([]);
  });

  it('rejects missing rpc_url', () => {
    expect(() => configSchema.parse({ chain: { chain_id: 8453 } })).toThrow();
  });

  it('rejects invalid sandbox value', () => {
    expect(() => configSchema.parse({
      chain: { rpc_url: 'https://x.com', chain_id: 8453 },
      agent: { sandbox: 'invalid' },
    })).toThrow();
  });

  it('coerces string numbers to numbers', () => {
    const result = configSchema.parse({
      chain: { rpc_url: 'https://x.com', chain_id: '8453' },
      worker: { poll_base_ms: '15000' },
    });
    expect(result.chain.chain_id).toBe(8453);
    expect(result.worker.poll_base_ms).toBe(15000);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
yarn vitest run tests-next/unit/config/schema.test.ts
```

Expected: FAIL — module not found

**Step 3: Write schema.ts**

Create `jinn-node/src/config/schema.ts` with Zod schemas for each YAML section:
- `chainSchema` — `rpc_url: z.string().url()`, `chain_id: z.coerce.number().int().default(8453)`
- `workerSchema` — all polling/cycle defaults from design doc
- `stakingSchema` — `contract: z.string().default('')`
- `filteringSchema` — workstreams/ventures arrays, earning schedule
- `agentSchema` — sandbox enum, stdout/chunk limits
- `dependenciesSchema` — stale/cooldown/fail ms values
- `heartbeatSchema` — min_interval_sec
- `servicesSchema` — ponder_url, control_api_url, ipfs defaults
- `gitSchema` — branch, remote, github_api defaults
- `loggingSchema` — level enum, format enum, mcp_level
- `blueprintSchema` — all enable_* booleans with correct defaults

Merge all into `configSchema`. Export `type NodeConfig = z.infer<typeof configSchema>`.

Use snake_case in the schema (matching YAML) — the loader will transform to camelCase for the TypeScript API.

**Step 4: Run test to verify it passes**

```bash
yarn vitest run tests-next/unit/config/schema.test.ts
```

**Step 5: Commit**

```bash
git add jinn-node/src/config/schema.ts tests-next/unit/config/schema.test.ts
git commit -m "feat(config): add Zod schema for jinn.yaml"
```

---

### Task 3: Create defaults.ts and YAML auto-generation

**Files:**
- Create: `jinn-node/src/config/defaults.ts`
- Test: `tests-next/unit/config/defaults.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { getDefaultYaml, generateDefaultConfig } from '../../jinn-node/src/config/defaults.js';

describe('defaults', () => {
  it('getDefaultYaml returns valid YAML string', () => {
    const yaml = getDefaultYaml();
    expect(yaml).toContain('chain:');
    expect(yaml).toContain('rpc_url:');
    expect(yaml).toContain('poll_base_ms: 30000');
  });

  it('generateDefaultConfig returns a config matching schema defaults', () => {
    const config = generateDefaultConfig();
    expect(config.worker.poll_base_ms).toBe(30000);
    expect(config.blueprint.enable_beads).toBe(false);
    expect(config.agent.sandbox).toBe('sandbox-exec');
  });
});
```

**Step 2: Implement defaults.ts**

- `generateDefaultConfig()` — returns a plain object with all defaults
- `getDefaultYaml()` — serializes defaults to YAML string with section comments
- `writeDefaultConfigIfMissing(dir: string)` — writes `jinn.yaml` to dir if not present, returns path

**Step 3: Run tests, commit**

---

### Task 4: Create aliases.ts for legacy env var mapping

**Files:**
- Create: `jinn-node/src/config/aliases.ts`
- Test: `tests-next/unit/config/aliases.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveEnvOverrides } from '../../jinn-node/src/config/aliases.js';

describe('resolveEnvOverrides', () => {
  it('maps RPC_URL to chain.rpc_url', () => {
    const overrides = resolveEnvOverrides({ RPC_URL: 'https://example.com' });
    expect(overrides.chain?.rpc_url).toBe('https://example.com');
  });

  it('maps legacy MECHX_CHAIN_RPC to chain.rpc_url', () => {
    const overrides = resolveEnvOverrides({ MECHX_CHAIN_RPC: 'https://example.com' });
    expect(overrides.chain?.rpc_url).toBe('https://example.com');
  });

  it('maps WORKER_POLL_BASE_MS to worker.poll_base_ms', () => {
    const overrides = resolveEnvOverrides({ WORKER_POLL_BASE_MS: '15000' });
    expect(overrides.worker?.poll_base_ms).toBe('15000');
  });

  it('canonical name takes priority over legacy alias', () => {
    const overrides = resolveEnvOverrides({
      RPC_URL: 'https://canonical.com',
      MECHX_CHAIN_RPC: 'https://legacy.com',
    });
    expect(overrides.chain?.rpc_url).toBe('https://canonical.com');
  });
});
```

**Step 2: Implement aliases.ts**

Export `resolveEnvOverrides(env: Record<string, string | undefined>)` that returns a partial config object built from env vars.

The alias table maps:
- `RPC_URL`, `MECHX_CHAIN_RPC`, `MECH_RPC_HTTP_URL`, `BASE_RPC_URL` → `chain.rpc_url`
- `CHAIN_ID` → `chain.chain_id`
- `WORKER_POLL_BASE_MS` → `worker.poll_base_ms`
- `WORKER_POLL_MAX_MS` → `worker.poll_max_ms`
- ... (all existing env var names from the inventory)
- `BLUEPRINT_ENABLE_SYSTEM` → `blueprint.enable_system`
- `PONDER_GRAPHQL_URL` → `services.ponder_url`
- `CONTROL_API_URL` → `services.control_api_url`
- `LOG_LEVEL` → `logging.level`
- etc.

Priority: first matching canonical name wins.

**Step 3: Run tests, commit**

---

### Task 5: Create secrets.ts for .env secret loading

**Files:**
- Create: `jinn-node/src/config/secrets.ts`
- Test: `tests-next/unit/config/secrets.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSecrets, type Secrets } from '../../jinn-node/src/config/secrets.js';

describe('loadSecrets', () => {
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('reads secrets from process.env', () => {
    process.env.OPERATE_PASSWORD = 'test123';
    process.env.GEMINI_API_KEY = 'key-abc';
    const secrets = loadSecrets();
    expect(secrets.operatePassword).toBe('test123');
    expect(secrets.geminiApiKey).toBe('key-abc');
  });

  it('returns undefined for unset secrets', () => {
    delete process.env.OPERATE_PASSWORD;
    const secrets = loadSecrets();
    expect(secrets.operatePassword).toBeUndefined();
  });
});
```

**Step 2: Implement secrets.ts**

Typed `Secrets` interface with all secret env vars. `loadSecrets()` reads from `process.env` (populated by dotenv from `.env`). No YAML involved.

```typescript
export interface Secrets {
  operatePassword?: string;
  geminiApiKey?: string;
  geminiOauthCredentials?: string;
  openaiApiKey?: string;
  githubToken?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseAnonKey?: string;
  x402GatewayUrl?: string;
  civitaiApiKey?: string;
  zoraApiKey?: string;
  moltbookApiKey?: string;
  tenderlyAccessKey?: string;
  tenderlyAccountSlug?: string;
  tenderlyProjectSlug?: string;
  snykToken?: string;
}
```

**Step 3: Run tests, commit**

---

### Task 6: Create context.ts for JINN_CTX_* runtime vars

**Files:**
- Create: `jinn-node/src/config/context.ts`
- Test: `tests-next/unit/config/context.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getJobContext, setJobContext, clearJobContext } from '../../jinn-node/src/config/context.js';

describe('jobContext', () => {
  beforeEach(() => clearJobContext());

  it('returns undefined for unset context', () => {
    expect(getJobContext().requestId).toBeUndefined();
  });

  it('sets and gets context values', () => {
    setJobContext({ requestId: '0x123', mechAddress: '0xabc' });
    expect(getJobContext().requestId).toBe('0x123');
    expect(getJobContext().mechAddress).toBe('0xabc');
  });

  it('clearJobContext resets all values', () => {
    setJobContext({ requestId: '0x123' });
    clearJobContext();
    expect(getJobContext().requestId).toBeUndefined();
  });
});
```

**Step 2: Implement context.ts**

Replace the current pattern of writing `JINN_CTX_*` to `process.env`. Use an in-memory typed object instead. The existing `metadata/jobContext.ts` writes 20+ vars to `process.env` and `shared/context.ts` reads them back — both converge on this new module.

**Step 3: Run tests, commit**

---

### Task 7: Create loader.ts — the main config loading pipeline

**Files:**
- Create: `jinn-node/src/config/loader.ts`
- Test: `tests-next/unit/config/loader.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadNodeConfig } from '../../jinn-node/src/config/loader.js';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import YAML from 'yaml';

describe('loadNodeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jinn-config-test-'));
  });

  it('loads config from jinn.yaml', () => {
    const yaml = YAML.stringify({
      chain: { rpc_url: 'https://test.com', chain_id: 8453 },
    });
    writeFileSync(join(tmpDir, 'jinn.yaml'), yaml);
    const config = loadNodeConfig(tmpDir);
    expect(config.chain.rpcUrl).toBe('https://test.com');
    expect(config.worker.pollBaseMs).toBe(30000); // default
  });

  it('auto-generates jinn.yaml when missing', () => {
    const config = loadNodeConfig(tmpDir);
    expect(config.worker.pollBaseMs).toBe(30000);
    // jinn.yaml should now exist
    const { existsSync } = require('fs');
    expect(existsSync(join(tmpDir, 'jinn.yaml'))).toBe(true);
  });

  it('env vars override yaml values', () => {
    const yaml = YAML.stringify({
      chain: { rpc_url: 'https://from-yaml.com', chain_id: 8453 },
    });
    writeFileSync(join(tmpDir, 'jinn.yaml'), yaml);
    process.env.RPC_URL = 'https://from-env.com';
    const config = loadNodeConfig(tmpDir);
    expect(config.chain.rpcUrl).toBe('https://from-env.com');
    delete process.env.RPC_URL;
  });

  it('throws on invalid config', () => {
    const yaml = YAML.stringify({
      chain: { rpc_url: 'not-a-url', chain_id: -1 },
    });
    writeFileSync(join(tmpDir, 'jinn.yaml'), yaml);
    expect(() => loadNodeConfig(tmpDir)).toThrow();
  });
});
```

**Step 2: Implement loader.ts**

```typescript
export function loadNodeConfig(baseDir?: string): FrozenNodeConfig {
  // 1. Find or auto-generate jinn.yaml
  // 2. Parse YAML
  // 3. Deep-merge with env var overrides (via aliases.ts)
  // 4. Validate with Zod schema
  // 5. Transform snake_case → camelCase for TypeScript API
  // 6. Freeze and return
}
```

Key: The return type uses camelCase (`rpcUrl` not `rpc_url`) even though YAML/env use snake_case. The schema validates snake_case, then a transform step converts.

**Step 3: Run tests, commit**

---

### Task 8: Rewrite config/index.ts — the public API

**Files:**
- Modify: `jinn-node/src/config/index.ts` (full rewrite)
- Test: `tests-next/unit/config/index.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('config singleton', () => {
  beforeEach(async () => {
    // Reset module to force re-load
    vi.resetModules();
  });

  it('exports a frozen config object', async () => {
    const { config } = await import('../../jinn-node/src/config/index.js');
    expect(config.chain).toBeDefined();
    expect(config.worker).toBeDefined();
    expect(() => { (config as any).chain = {} }).toThrow(); // frozen
  });

  it('exports secrets separately', async () => {
    const { secrets } = await import('../../jinn-node/src/config/index.js');
    expect(secrets).toBeDefined();
  });

  it('exports job context module', async () => {
    const { getJobContext, setJobContext } = await import('../../jinn-node/src/config/index.js');
    expect(typeof getJobContext).toBe('function');
    expect(typeof setJobContext).toBe('function');
  });
});
```

**Step 2: Rewrite index.ts**

Delete the entire existing contents (Zod schemas, `loadConfig()`, all `getXxx()` exports). Replace with:

```typescript
import { loadNodeConfig } from './loader.js';
import { loadSecrets } from './secrets.js';
export { getJobContext, setJobContext, clearJobContext } from './context.js';
export type { NodeConfig } from './schema.js';
export type { Secrets } from './secrets.js';

// Singleton — initialized on first import
export const config = loadNodeConfig();
export const secrets = loadSecrets();
```

This is the clean break. All 60+ `getXxx()` function exports are gone.

**Step 3: Run test, commit**

---

### Task 9: Migrate mech_worker.ts (39 process.env reads)

**Files:**
- Modify: `jinn-node/src/worker/mech_worker.ts`

This is the largest single file. Replace all 39 `process.env` reads and all `getXxx()` config function calls with `config.*` property access.

**Key replacements:**
```
parseInt(process.env.WORKER_POLL_BASE_MS || '30000')  →  config.worker.pollBaseMs
parseInt(process.env.WORKER_POLL_MAX_MS || '300000')   →  config.worker.pollMaxMs
parseFloat(process.env.WORKER_POLL_BACKOFF_FACTOR || '1.5')  →  config.worker.pollBackoffFactor
process.env.EARNING_SCHEDULE?.trim() || null           →  config.filtering.earningSchedule || null
process.env.WORKSTREAM_FILTER                          →  config.filtering.workstreams
process.env.VENTURE_FILTER                             →  config.filtering.ventures
process.env.AUTO_RESTAKE !== 'false'                   →  config.worker.autoRestake
process.env.OPERATE_PASSWORD                           →  secrets.operatePassword
getPonderGraphqlUrl()                                  →  config.services.ponderUrl
getOptionalControlApiUrl()                             →  config.services.controlApiUrl
getUseControlApi()                                     →  config.services.useControlApi
getMechAddress()                                       →  (from operate-profile — service identity, separate concern)
```

**Note:** Service identity reads (`getMechAddress`, `getServicePrivateKey`, `getServiceSafeAddress`) from `operate-profile.ts` are NOT part of jinn.yaml — they come from `.operate/` directory or `JINN_SERVICE_*` env vars. These keep their existing imports from `operate-profile.ts` for now.

**Step: Run existing tests after migration**

```bash
yarn vitest run tests/unit/worker/ tests-next/unit/worker/
```

**Commit**

---

### Task 10: Migrate agent.ts (17 process.env reads)

**Files:**
- Modify: `jinn-node/src/agent/agent.ts`

**Key replacements:**
```
process.env.GEMINI_SANDBOX                  →  config.agent.sandbox
process.env.AGENT_MAX_STDOUT_SIZE           →  config.agent.maxStdoutSize
process.env.AGENT_MAX_CHUNK_SIZE            →  config.agent.maxChunkSize
process.env.AGENT_REPETITION_WINDOW         →  config.agent.repetitionWindow
process.env.CODE_METADATA_REPO_ROOT         →  config.git.repoRoot (or kept as process.env if it's runtime-set)
process.env.GEMINI_ADDITIONAL_INCLUDE_DIRS  →  config.agent.additionalIncludeDirs
process.env.JINN_TELEMETRY_DIR             →  config.agent.telemetryDir
getSandboxMode()                            →  config.agent.sandbox
```

**Run tests, commit**

---

### Task 11: Migrate MCP tools (shared/context.ts — 50 reads, shared/env.ts — 8 reads)

**Files:**
- Modify: `jinn-node/src/agent/mcp/tools/shared/context.ts`
- Modify: `jinn-node/src/agent/mcp/tools/shared/env.ts`
- Modify: `jinn-node/src/agent/mcp/tools/shared/ipfs.ts`
- Modify: `jinn-node/src/agent/mcp/tools/shared/civitai.ts`

`shared/context.ts` reads ~50 `JINN_CTX_*` vars. These all migrate to `getJobContext()` from `config/context.ts`.

`shared/env.ts` has the deprecated `loadEnvOnce()` — delete entirely, replace all callers with `config` import.

**Run tests, commit**

---

### Task 12: Migrate MCP tool files (individual tools)

**Files:**
- Modify: `jinn-node/src/agent/mcp/tools/dispatch_new_job.ts` (6 reads)
- Modify: `jinn-node/src/agent/mcp/tools/search_similar_situations.ts` (7 reads)
- Modify: `jinn-node/src/agent/mcp/tools/inspect_situation.ts` (7 reads)
- Modify: `jinn-node/src/agent/mcp/tools/register_template.ts` (9 reads)
- Modify: `jinn-node/src/agent/mcp/tools/blog-publish.ts` (3 reads)
- Modify: `jinn-node/src/agent/mcp/tools/blog-analytics.ts` (1 read)
- Modify: `jinn-node/src/agent/mcp/tools/create_artifact.ts` (1 read)
- Modify: `jinn-node/src/agent/mcp/tools/create_measurement.ts` (2 reads)
- Modify: `jinn-node/src/agent/mcp/tools/get-details.ts` (2 reads)
- Modify: `jinn-node/src/agent/mcp/tools/list-tools.ts` (3 reads)
- Modify: `jinn-node/src/agent/mcp/tools/telegram-messaging.ts` (2 reads)
- Modify: `jinn-node/src/agent/mcp/tools/github_tools.ts` (1 read)
- Modify: `jinn-node/src/agent/mcp/tools/civitai-generate-image.ts` (2 reads)
- Modify: `jinn-node/src/agent/mcp/tools/moltbook.ts` (1 read)
- Modify: `jinn-node/src/agent/mcp/tools/send-message.ts` (2 reads)
- Modify: `jinn-node/src/agent/mcp/tools/dispatch_existing_job.ts` (2 reads)

Most of these read `JINN_CTX_*` context vars and/or secrets. Replace with `getJobContext()` and `secrets.*`.

**Run tests, commit**

---

### Task 13: Migrate worker subsystem files

**Files:**
- Modify: `jinn-node/src/worker/staking/heartbeat.ts` (1 read)
- Modify: `jinn-node/src/worker/staking/epochGate.ts` (if any)
- Modify: `jinn-node/src/worker/filters/stakingFilter.ts` (1 read)
- Modify: `jinn-node/src/worker/filters/credentialFilter.ts` (4 reads)
- Modify: `jinn-node/src/worker/situation_artifact.ts` (3 reads)
- Modify: `jinn-node/src/worker/healthcheck.ts` (5 reads)
- Modify: `jinn-node/src/worker/worker_launcher.ts` (4 reads)
- Modify: `jinn-node/src/worker/constants.ts` (3 reads)
- Modify: `jinn-node/src/worker/control_api_client.ts` (1 read)
- Modify: `jinn-node/src/worker/EoaExecutor.ts` (config getter calls)
- Modify: `jinn-node/src/worker/register-operator.ts` (3 reads)
- Modify: `jinn-node/src/worker/SimplifiedServiceBootstrap.ts` (4 reads)
- Modify: `jinn-node/src/worker/OlasServiceManager.ts` (3 reads)
- Modify: `jinn-node/src/worker/OlasOperateWrapper.ts` (4 reads)
- Modify: `jinn-node/src/worker/ServiceConfigLoader.ts` (1 read)
- Modify: `jinn-node/src/worker/ServiceConfigReader.ts` (1 read)
- Modify: `jinn-node/src/worker/validation.ts` (1 read)
- Modify: `jinn-node/src/worker/delivery/payload.ts` (1 read)

**Run all worker tests, commit**

---

### Task 14: Migrate remaining files

**Files:**
- Modify: `jinn-node/src/worker/orchestration/jobRunner.ts` (8 reads)
- Modify: `jinn-node/src/worker/orchestration/env.ts` (9 reads)
- Modify: `jinn-node/src/worker/metadata/jobContext.ts` (62 writes — migrate to context.ts)
- Modify: `jinn-node/src/worker/status/autoDispatch.ts` (4 reads)
- Modify: `jinn-node/src/worker/git/repoManager.ts` (4 reads)
- Modify: `jinn-node/src/worker/git/push.ts` (2 reads)
- Modify: `jinn-node/src/worker/git/integration.ts` (2 reads)
- Modify: `jinn-node/src/worker/llm/geminiQuota.ts` (6 reads)
- Modify: `jinn-node/src/worker/ventures/ventureWatcher.ts` (1 read)
- Modify: `jinn-node/src/worker/prompt/providers/context/JobContextProvider.ts` (2 reads)
- Modify: `jinn-node/src/worker/prompt/config.ts` (config getter calls → config.blueprint.*)
- Modify: `jinn-node/src/worker/execution/runAgent.ts` (1 read)
- Modify: `jinn-node/src/worker/mcp/tools/git.ts` (2 reads)
- Modify: `jinn-node/src/shared/repo_utils.ts` (2 reads)
- Modify: `jinn-node/src/shared/workstream-utils.ts` (2 reads)
- Modify: `jinn-node/src/logging/config.ts` (5 reads)
- Modify: `jinn-node/src/logging/factory.ts` (1 read)
- Modify: `jinn-node/src/data/supabase.ts` (2 reads)
- Modify: `jinn-node/src/http/erc8128.ts` (config getter call)
- Modify: `jinn-node/src/agent/signing-proxy.ts` (operate-profile calls)
- Modify: `jinn-node/src/agent/shared/credential-client.ts` (5 reads)
- Modify: `jinn-node/src/agent/shared/signing-proxy-client.ts` (2 reads)
- Modify: `jinn-node/src/agent/shared/ipfs-payload-builder.ts` (2 reads)
- Modify: `jinn-node/src/agent/shared/dispatch-core.ts` (1 read)
- Modify: `jinn-node/src/agent/mcp/server.ts` (3 reads)
- Modify: `jinn-node/src/setup/cli.ts` (4 reads)
- Modify: `jinn-node/src/setup/test-isolation.ts` (2 reads)

**Run full test suite, commit**

---

### Task 15: Delete old config modules

**Files:**
- Delete: `jinn-node/src/env/index.ts` (replaced by loader.ts)
- Delete: `jinn-node/src/env/control.ts` (USE_CONTROL_API now in yaml)
- Delete: `jinn-node/src/agent/mcp/tools/shared/env.ts` (deprecated, replaced)
- Modify: `jinn-node/src/worker/config.ts` (delete re-exports, keep ServiceConfig types only)

**Run full test suite to verify nothing references deleted modules, commit**

---

### Task 16: Update .env.template and .env.example

**Files:**
- Modify: `jinn-node/.env.template` — trim to secrets only
- Modify: `jinn-node/.env.example` — trim to secrets only (or delete if redundant)
- Create: `jinn-node/jinn.yaml` — default config file (auto-generated content, committed as reference)

**Commit**

---

### Task 17: Fix existing tests

**Files:**
- Modify: Tests that set `process.env.*` to override config — update to use `jinn.yaml` test fixtures or `vi.mock('../config/index.js')`

Key test files likely needing updates:
- `tests/unit/rotation/ActivityMonitor.test.ts`
- `tests/unit/rotation/ServiceRotator.test.ts`
- `tests/unit/gemini-agent/toolPolicy.test.ts`
- `tests/unit/tools/*.test.ts`
- `tests-next/unit/worker/*.test.ts`

Pattern: tests that do `process.env.SOME_VAR = 'value'` before calling code need to either:
1. Mock the config module: `vi.mock('../config/index.js', () => ({ config: { ... } }))`
2. Or use `resetConfigForTests()` + write a temp `jinn.yaml`

**Run full test suite, fix all failures, commit**

---

### Task 18: Startup summary logger

**Files:**
- Modify: `jinn-node/src/config/loader.ts`

Add startup logging that prints where each non-default config value came from:

```
[CONFIG] Loaded from: /path/to/jinn.yaml
[CONFIG] chain.rpcUrl = https://... (source: jinn.yaml)
[CONFIG] worker.pollBaseMs = 15000 (source: env WORKER_POLL_BASE_MS)
[CONFIG] services.ponderUrl = https://indexer.jinn.network/graphql (source: default)
[CONFIG] Secrets loaded: operatePassword=set, geminiApiKey=set, githubToken=unset
```

**Commit**

---

### Task 19: Full test suite verification

**Step 1: Run all tests**

```bash
yarn vitest run
```

**Step 2: Run type check**

```bash
npx tsc --noEmit 2>&1 | grep -v node_modules
```

**Step 3: Manual smoke test**

```bash
cd jinn-node && yarn dev:mech --single --dry-run
```

Verify: jinn.yaml auto-generated, startup summary printed, worker runs normally.

**Commit any remaining fixes**

---

### Task 20: Update documentation

**Files:**
- Modify: `docs/reference/environment-variables.md` — rewrite to reference jinn.yaml as primary, .env for secrets
- Modify: `skills/setup-worker/SKILL.md` — update setup flow to mention jinn.yaml
- Modify: `skills/deploy-worker/SKILL.md` — update Railway config to explain YAML + env override pattern

**Commit**
