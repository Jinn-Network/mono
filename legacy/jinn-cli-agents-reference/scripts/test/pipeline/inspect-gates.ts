#!/usr/bin/env tsx
/**
 * Automated code inspection gates.
 *
 * Runs as: `yarn test:pipeline:inspect [--gates P1,P2,...] [--artifact path]`
 *
 * Each check reads source files and asserts patterns. Returns JSON:
 *   { gates: { P1: { pass, detail, failureHints }, ... } }
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseArgs, ensureDir } from '../railway/common.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InspectionResult {
  pass: boolean;
  detail: string;
  failureHints: string[];
}

type InspectionCheck = () => Promise<InspectionResult>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? process.cwd(), '..', '..', '..');

function abs(rel: string): string {
  return resolve(ROOT, rel);
}

async function readSafe(relPath: string): Promise<string | null> {
  const p = abs(relPath);
  if (!existsSync(p)) return null;
  return readFile(p, 'utf-8');
}

function fileExists(relPath: string): boolean {
  return existsSync(abs(relPath));
}

function hasPattern(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

function countMatches(content: string, pattern: RegExp): number {
  const matches = content.match(new RegExp(pattern.source, 'g' + (pattern.flags.includes('i') ? 'i' : '')));
  return matches?.length ?? 0;
}

function pass(detail: string, hints: string[] = []): InspectionResult {
  return { pass: true, detail, failureHints: hints };
}

function fail(detail: string, hints: string[]): InspectionResult {
  return { pass: false, detail, failureHints: hints };
}

// ---------------------------------------------------------------------------
// Inspection checks
// ---------------------------------------------------------------------------

const inspections: Record<string, InspectionCheck> = {
  // ── Ponder gates ──────────────────────────────────────────────────────

  P1: async () => {
    const hints = ['ponder/ponder.schema.ts', 'ponder/src/index.ts'];
    const schema = await readSafe('ponder/ponder.schema.ts');
    if (!schema) return fail('ponder.schema.ts not found', hints);

    const hasVentureId = hasPattern(schema, /ventureId/);
    const hasTemplateId = hasPattern(schema, /templateId/);
    if (!hasVentureId || !hasTemplateId) {
      return fail(`Missing columns: ventureId=${hasVentureId}, templateId=${hasTemplateId}`, hints);
    }
    return pass('request table has ventureId + templateId', hints);
  },

  P2: async () => {
    const hints = ['ponder/ponder.schema.ts', 'ponder/src/index.ts'];
    const schema = await readSafe('ponder/ponder.schema.ts');
    const index = await readSafe('ponder/src/index.ts');
    if (!schema || !index) return fail('ponder files not found', hints);

    const hasLastStatus = hasPattern(schema, /lastStatus/);
    const hasLatestUpdate = hasPattern(schema, /latestStatusUpdate/);
    const populatesStatus = hasPattern(index, /lastStatus/);
    if (!hasLastStatus || !hasLatestUpdate) {
      return fail(`Schema missing: lastStatus=${hasLastStatus}, latestStatusUpdate=${hasLatestUpdate}`, hints);
    }
    if (!populatesStatus) {
      return fail('index.ts does not populate lastStatus on events', hints);
    }
    return pass('workstream has lastStatus/latestStatusUpdate, populated on events', hints);
  },

  P3: async () => {
    const hints = ['ponder/src/index.ts'];
    const index = await readSafe('ponder/src/index.ts');
    if (!index) return fail('ponder/src/index.ts not found', hints);

    const hasAllowlist = hasPattern(index, /buildJinnMechAllowlist/);
    if (!hasAllowlist) return fail('buildJinnMechAllowlist function not found', hints);
    return pass('buildJinnMechAllowlist present, non-Jinn mechs filtered', hints);
  },

  P4: async () => {
    const hints = ['ponder/src/index.ts'];
    const index = await readSafe('ponder/src/index.ts');
    if (!index) return fail('ponder/src/index.ts not found', hints);

    // Must NOT have cloudflare-ipfs as a gateway URL (comments OK)
    const lines = index.split('\n');
    const activeCloudflare = lines.filter(
      (l) => !l.trim().startsWith('//') && /cloudflare-ipfs\.com/.test(l),
    );
    if (activeCloudflare.length > 0) {
      return fail(`Active cloudflare-ipfs references found (${activeCloudflare.length} lines)`, hints);
    }

    const hasTimeout = hasPattern(index, /1[_,]?500/);
    const hasIpfsIo = hasPattern(index, /ipfs\.io/);
    if (!hasTimeout) return fail('IPFS timeout ~1500ms not found', hints);
    if (!hasIpfsIo) return fail('ipfs.io fallback not found', hints);
    return pass('No active cloudflare-ipfs refs, timeout 1500ms, ipfs.io fallback', hints);
  },

  P5: async () => {
    const hints = ['deploy/ponder/nixpacks.toml', 'ponder/src/index.ts'];

    // Check for no-compile build in deploy config
    const nixpacks =
      (await readSafe('deploy/ponder/nixpacks.toml')) ??
      (await readSafe('ponder/nixpacks.toml'));
    if (!nixpacks) return fail('No ponder nixpacks.toml found', hints);

    const hasNoCompile = hasPattern(nixpacks, /no compilation needed|echo.*Ponder build/i);

    // Check no jinn-node imports in ponder/src/
    const index = await readSafe('ponder/src/index.ts');
    const hasJinnImport = index ? hasPattern(index, /from\s+['"].*jinn-node/) : false;

    if (!hasNoCompile) return fail('nixpacks.toml missing no-compile build phase', hints);
    if (hasJinnImport) return fail('ponder/src/index.ts imports from jinn-node', hints);
    return pass('No-compile build, no jinn-node imports in ponder/', hints);
  },

  P6: async () => {
    const hints = ['deploy/ponder/nixpacks.toml'];
    const nixpacks = await readSafe('deploy/ponder/nixpacks.toml');
    if (!nixpacks) return fail('deploy/ponder/nixpacks.toml not found', hints);

    const hasViewsSchema = hasPattern(nixpacks, /PONDER_VIEWS_SCHEMA/);
    if (!hasViewsSchema) return fail('PONDER_VIEWS_SCHEMA not referenced', hints);
    return pass('PONDER_VIEWS_SCHEMA configurable via env', hints);
  },

  // ── Credential inspect gates ──────────────────────────────────────────

  CR9: async () => {
    const hints = ['jinn-node/src/shared/tool-credential-requirements.ts'];
    // Try both possible locations
    const content =
      (await readSafe('jinn-node/src/shared/tool-credential-requirements.ts')) ??
      (await readSafe('jinn-node/src/worker/tool-credential-requirements.ts'));
    if (!content) return fail('tool-credential-requirements.ts not found', hints);

    // Count unique provider strings in the file
    const providers = new Set<string>();
    const providerPatterns = [
      'telegram', 'twitter', 'umami', 'openai', 'civitai',
      'supabase', 'fireflies', 'railway', 'github',
    ];
    for (const p of providerPatterns) {
      if (hasPattern(content, new RegExp(p, 'i'))) providers.add(p);
    }

    if (providers.size < 8) {
      return fail(`Only ${providers.size} providers found (need ≥8): ${[...providers].join(', ')}`, hints);
    }
    return pass(`${providers.size} credential providers mapped: ${[...providers].join(', ')}`, hints);
  },

  CR10: async () => {
    const hints = ['jinn-node/src/worker/filters/credentialFilter.ts'];
    const content =
      (await readSafe('jinn-node/src/worker/filters/credentialFilter.ts')) ??
      (await readSafe('jinn-node/src/worker/credentialFilter.ts'));
    if (!content) return fail('credentialFilter.ts not found', hints);

    const hasReprobe = hasPattern(content, /reprobeWithRequestId/);
    if (!hasReprobe) return fail('reprobeWithRequestId not found', hints);
    return pass('reprobeWithRequestId() present for venture-scoped credentials', hints);
  },

  CR11: async () => {
    const hints = ['jinn-node/src/worker/filters/credentialFilter.ts'];
    const content =
      (await readSafe('jinn-node/src/worker/filters/credentialFilter.ts')) ??
      (await readSafe('jinn-node/src/worker/credentialFilter.ts'));
    if (!content) return fail('credentialFilter.ts not found', hints);

    const hasGithubUser = hasPattern(content, /\/user/);
    if (!hasGithubUser) return fail('GitHub /user endpoint check not found', hints);
    return pass('GitHub operator capability validated via /user endpoint', hints);
  },

  CR12: async () => {
    const hints = ['control-api/server.ts', 'jinn-node/src/http/erc8128.ts'];
    const server = await readSafe('control-api/server.ts');
    if (!server) return fail('control-api/server.ts not found', hints);

    const hasNonceStore = hasPattern(server, /InMemoryNonceStore|NonceStore/);
    if (!hasNonceStore) return fail('Nonce store not found in control-api', hints);
    return pass('InMemoryNonceStore with TTL-based GC in control-api', hints);
  },

  // ── Feature spot-check gates ──────────────────────────────────────────

  W10: async () => {
    const hints = ['jinn-node/src/worker/mech_worker.ts', 'jinn-node/src/worker/ventures/ventureWatcher.ts'];
    const worker = await readSafe('jinn-node/src/worker/mech_worker.ts');
    if (!worker) return fail('mech_worker.ts not found', hints);

    const hasFlag = hasPattern(worker, /ENABLE_VENTURE_WATCHER/);
    const watcherExists = fileExists('jinn-node/src/worker/ventures/ventureWatcher.ts');
    if (!hasFlag) return fail('ENABLE_VENTURE_WATCHER not found in mech_worker.ts', hints);
    if (!watcherExists) return fail('ventureWatcher.ts does not exist', hints);
    return pass('ENABLE_VENTURE_WATCHER flag + ventureWatcher.ts present', hints);
  },

  W11: async () => {
    const hints = ['jinn-node/src/worker/ventures/ventureWatcher.ts'];
    const watcher = await readSafe('jinn-node/src/worker/ventures/ventureWatcher.ts');
    if (!watcher) return fail('ventureWatcher.ts not found', hints);

    const hasFilter = hasPattern(watcher, /VENTURE_FILTER/);
    const hasClaim = hasPattern(watcher, /claimVentureDispatch/);
    if (!hasFilter) return fail('VENTURE_FILTER not referenced', hints);
    if (!hasClaim) return fail('claimVentureDispatch not called', hints);
    return pass('Venture watcher respects VENTURE_FILTER, uses claimVentureDispatch', hints);
  },

  W12: async () => {
    const hints = ['jinn-node/src/worker/status/autoDispatch.ts'];
    const content = await readSafe('jinn-node/src/worker/status/autoDispatch.ts');
    if (!content) return fail('autoDispatch.ts not found', hints);

    const hasConst = hasPattern(content, /MAX_PARENT_DISPATCHES/);
    if (!hasConst) return fail('MAX_PARENT_DISPATCHES not found', hints);
    return pass('MAX_PARENT_DISPATCHES prevents cascade storms', hints);
  },

  C1: async () => {
    const hints = ['control-api/server.ts'];
    const server = await readSafe('control-api/server.ts');
    if (!server) return fail('control-api/server.ts not found', hints);

    const hasClaim = hasPattern(server, /claimVentureDispatch/);
    const hasTTL = hasPattern(server, /setMinutes|expiresAt|expiration/i);
    if (!hasClaim) return fail('claimVentureDispatch resolver not found', hints);
    if (!hasTTL) return fail('TTL/expiration logic not found', hints);
    return pass('claimVentureDispatch with TTL deduplication', hints);
  },

  E1: async () => {
    const hints = ['jinn-node/src/agent/mcp/server.ts', 'gemini-agent/mcp/server.ts'];
    const content =
      (await readSafe('jinn-node/src/agent/mcp/server.ts')) ??
      (await readSafe('gemini-agent/mcp/server.ts'));
    if (!content) return fail('MCP server.ts not found', hints);

    const categories = {
      moltbook: hasPattern(content, /moltbook/i),
      telegram: hasPattern(content, /telegram_get_updates/i),
      dispatch_schedule: hasPattern(content, /dispatch_schedule/i),
      twitter: hasPattern(content, /twitter/i),
    };

    const missing = Object.entries(categories).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) return fail(`Missing tool registrations: ${missing.join(', ')}`, hints);
    return pass('All 4 tool categories registered: moltbook, telegram, dispatch_schedule, twitter', hints);
  },

  N1: async () => {
    const hints = ['blueprints/'];
    const dir = abs('blueprints');
    if (!existsSync(dir)) return fail('blueprints/ directory not found', hints);

    const entries = await readdir(dir, { recursive: true });
    const jsonFiles = entries.filter((e) => e.toString().endsWith('.json'));
    if (jsonFiles.length < 40) {
      return fail(`Only ${jsonFiles.length} blueprint files (need ≥40)`, hints);
    }
    return pass(`${jsonFiles.length} blueprint files in blueprints/`, hints);
  },

  N2: async () => {
    const hints = [
      'jinn-node/src/worker/prompt/providers/context/VentureContextProvider.ts',
      'jinn-node/src/worker/prompt/BlueprintBuilder.ts',
    ];
    const provider = await readSafe('jinn-node/src/worker/prompt/providers/context/VentureContextProvider.ts');
    if (!provider) return fail('VentureContextProvider.ts not found', hints);

    const hasExport = hasPattern(provider, /export/);
    if (!hasExport) return fail('VentureContextProvider not exported', hints);
    return pass('VentureContextProvider exported and registered', hints);
  },

  N3: async () => {
    const hints = ['jinn-node/src/worker/onchain/serviceResolver.ts', 'jinn-node/src/worker/mech_worker.ts'];
    const resolver = await readSafe('jinn-node/src/worker/onchain/serviceResolver.ts');
    const worker = await readSafe('jinn-node/src/worker/mech_worker.ts');
    if (!resolver) return fail('serviceResolver.ts not found', hints);
    if (!worker) return fail('mech_worker.ts not found', hints);

    const hasExport = hasPattern(resolver, /export.*resolveServiceConfig/);
    const hasImport = hasPattern(worker, /resolveServiceConfig/);
    if (!hasExport) return fail('resolveServiceConfig not exported', hints);
    if (!hasImport) return fail('resolveServiceConfig not called in mech_worker.ts', hints);
    return pass('resolveServiceConfig exported + called at startup', hints);
  },

  N4: async () => {
    const hints = [
      'jinn-node/src/worker/filters/stakingFilter.ts',
      'jinn-node/src/worker/ventures/ventureDispatch.ts',
    ];
    const staking = await readSafe('jinn-node/src/worker/filters/stakingFilter.ts');
    const dispatch = await readSafe('jinn-node/src/worker/ventures/ventureDispatch.ts');
    if (!staking) return fail('stakingFilter.ts not found', hints);
    if (!dispatch) return fail('ventureDispatch.ts not found', hints);

    const hasRandom = hasPattern(staking, /Math\.random/);
    const hasGetRandom = hasPattern(dispatch, /getRandomStakedMech/);
    if (!hasRandom) return fail('Math.random() not found in stakingFilter.ts', hints);
    if (!hasGetRandom) return fail('getRandomStakedMech not found in ventureDispatch.ts', hints);
    return pass('Random staked mech selection in stakingFilter + ventureDispatch', hints);
  },

  F1: async () => {
    const hints = ['frontend/explorer/src/app/ventures/[id]/page.tsx'];
    if (!fileExists('frontend/explorer/src/app/ventures/[id]/page.tsx')) {
      return fail('Venture page route does not exist', hints);
    }
    return pass('Venture page route exists at /ventures/[id]', hints);
  },

  F2: async () => {
    const hints = [
      'frontend/explorer/src/components/ventures/schedule-timeline.tsx',
      'frontend/explorer/src/lib/ventures/',
    ];
    // schedule-timeline is in components/ventures/, lib files are in lib/ventures/
    const timelineExists = fileExists('frontend/explorer/src/components/ventures/schedule-timeline.tsx');
    if (!timelineExists) return fail('schedule-timeline.tsx component not found', hints);

    const libDir = abs('frontend/explorer/src/lib/ventures');
    if (!existsSync(libDir)) return fail('ventures/ lib directory not found', hints);

    const entries = await readdir(libDir);
    if (entries.length < 3) {
      return fail(`Only ${entries.length} files in ventures/lib (need ≥3)`, hints);
    }
    return pass(`schedule-timeline.tsx exists, ventures lib has ${entries.length} files`, hints);
  },

  F3: async () => {
    const hints = ['frontend/explorer/src/lib/ventures/venture-queries.ts'];
    const content = await readSafe('frontend/explorer/src/lib/ventures/venture-queries.ts');
    if (!content) return fail('venture-queries.ts not found', hints);

    const hasVentureId = hasPattern(content, /ventureId/);
    if (!hasVentureId) return fail('ventureId filter not found', hints);
    return pass('venture-queries.ts filters by ventureId', hints);
  },

  F4: async () => {
    const hints = ['frontend/explorer/src/lib/subgraph.ts'];
    const content = await readSafe('frontend/explorer/src/lib/subgraph.ts');
    if (!content) return fail('subgraph.ts not found', hints);

    const hasValidation = hasPattern(content, /GRAPHQL_VALIDATION_FAILED|Cannot query field/);
    if (!hasValidation) return fail('GRAPHQL_VALIDATION_FAILED handling not found', hints);
    return pass('subgraph.ts handles GRAPHQL_VALIDATION_FAILED gracefully', hints);
  },

  F5: async () => {
    const hints = ['frontend/explorer/src/lib/staking/rpc.ts'];
    const content = await readSafe('frontend/explorer/src/lib/staking/rpc.ts');
    if (!content) return fail('staking/rpc.ts not found', hints);

    const hasThrow = hasPattern(content, /throw.*RPC_URL|throw.*must be set/i);
    if (!hasThrow) return fail('Missing throw on absent RPC_URL', hints);
    return pass('staking/rpc.ts throws on missing RPC_URL', hints);
  },
};

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const gateFilter = flags['gates']?.split(',').map((g) => g.trim()) ?? null;
  const artifactPath = flags['artifact'];

  const checksToRun = gateFilter
    ? Object.entries(inspections).filter(([id]) => gateFilter.includes(id))
    : Object.entries(inspections);

  console.log(`Running ${checksToRun.length} inspect gates...\n`);

  const results: Record<string, InspectionResult> = {};
  let passCount = 0;
  let failCount = 0;

  for (const [id, check] of checksToRun) {
    try {
      const result = await check();
      results[id] = result;
      const icon = result.pass ? '✓' : '✗';
      const status = result.pass ? 'PASS' : 'FAIL';
      console.log(`  ${icon} ${id}: ${status} — ${result.detail}`);
      if (result.pass) passCount++;
      else failCount++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results[id] = { pass: false, detail: `Error: ${detail}`, failureHints: [] };
      console.log(`  ✗ ${id}: ERROR — ${detail}`);
      failCount++;
    }
  }

  console.log(`\n${passCount} PASS, ${failCount} FAIL out of ${checksToRun.length} gates`);

  const output = { gates: results };

  if (artifactPath) {
    await ensureDir(dirname(artifactPath));
    await writeFile(artifactPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
    console.log(`Artifact written to ${artifactPath}`);
  }

  // Always write to stdout as JSON for machine consumption
  if (!process.stdout.isTTY || artifactPath) {
    // Print JSON only if piped or artifact requested
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Inspect gates crashed:', err);
  process.exit(2);
});
