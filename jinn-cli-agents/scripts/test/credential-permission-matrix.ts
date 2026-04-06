#!/usr/bin/env npx tsx
/**
 * Credential Permission Matrix Runner (E2E helper)
 *
 * Purpose:
 * - Validate grant/revoke behavior against the credential bridge endpoint that
 *   the worker uses for capability discovery (/credentials/capabilities).
 * - Exercise permission toggles without changing runtime logic.
 *
 * Default matrix (global ACL):
 *   1) revoke -> provider must be absent
 *   2) grant  -> provider must be present
 *   3) revoke -> provider must be absent
 *
 * Optional venture matrix:
 * - Requires admin/operator signing keys and a requestId that resolves to the
 *   target venture context.
 *
 * Usage:
 *   yarn test:e2e:permissions --cwd <jinn-node-clone>
 *   yarn test:e2e:permissions --cwd <clone> --provider supabase
 *   yarn test:e2e:permissions --cwd <clone> --no-restore
 *
 * Venture mode (optional):
 *   yarn test:e2e:permissions --cwd <clone> --venture \
 *     --venture-id <uuid> --request-id <0x...> --admin-private-key <0x...>
 */

import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { privateKeyToAccount } from 'viem/accounts';
import { createPrivateKeyHttpSigner, signRequestWithErc8128 } from 'jinn-node/http/erc8128';
import { getServicePrivateKey } from 'jinn-node/env/operate-profile.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_ACL_PATH = resolve(MONOREPO_ROOT, '.env.e2e.acl.json');
const DEFAULT_GATEWAY_URL = process.env.X402_GATEWAY_URL || 'http://localhost:3001';
const DEFAULT_REPORT_PATH = '/tmp/jinn-e2e-logs/credential-permission-matrix.json';
const E2E_LOCAL_PONDER_URL = 'http://localhost:42069/graphql';

dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.e2e'), override: true, quiet: true });

type ScenarioStatus = 'PASS' | 'FAIL' | 'SKIP';

interface ScenarioResult {
  scenario: string;
  status: ScenarioStatus;
  expected: string;
  observed: string;
  details?: string;
}

interface AclGrant {
  nangoConnectionId: string;
  pricePerAccess: string;
  expiresAt: string | null;
  active: boolean;
}

interface AclFile {
  grants?: Record<string, Record<string, AclGrant>>;
  connections?: Record<string, { provider?: string; metadata?: Record<string, unknown> }>;
}

interface ParsedArgs {
  flags: Record<string, string>;
  bools: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const token = arg.slice(2);
    const [key, inlineValue] = token.split('=');

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
      continue;
    }

    bools.add(key);
  }

  return { flags, bools };
}

function usage(exitCode: number = 1): never {
  console.error(
    [
      'Usage:',
      '  yarn test:e2e:permissions --cwd <jinn-node-clone> [options]',
      '',
      'Options:',
      '  --cwd <path>                 Path to jinn-node standalone clone (.operate lives here)',
      `  --gateway-url <url>         Credential gateway URL (default: ${DEFAULT_GATEWAY_URL})`,
      `  --acl-file <path>           ACL JSON file (default: ${DEFAULT_ACL_PATH})`,
      '  --provider <name>            Provider to test (default: umami)',
      '  --connection <id>            Connection id for grants (default: e2e-<provider>)',
      '  --chain-id <id>              ERC-8128 chain id (default: 8453)',
      '  --operator-private-key <0x>  Override signer key (default: active service key from .operate)',
      `  --report <path>             JSON report output (default: ${DEFAULT_REPORT_PATH})`,
      '  --no-restore                 Keep ACL modifications after run',
      '',
      'Optional venture-scoped matrix:',
      '  --venture                    Enable full venture matrix',
      '  --venture-id <uuid>          Venture id (optional; auto-resolved if omitted)',
      '  --request-id <0x...>         Request id (optional; latest for sender if omitted)',
      '  --admin-private-key <0x...>  Admin signer key (optional; owner-mode used if omitted)',
      '',
      'Examples:',
      '  yarn test:e2e:permissions --cwd "$CLONE_DIR"',
      '  yarn test:e2e:permissions --cwd "$CLONE_DIR" --provider supabase',
      '  yarn test:e2e:permissions --cwd "$CLONE_DIR" --no-restore',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

function normalizeHexKey(value: string): `0x${string}` {
  const key = value.trim().toLowerCase();
  const normalized = key.startsWith('0x') ? key : `0x${key}`;
  if (!/^0x[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error('Invalid private key format. Expected 0x-prefixed 64 hex chars.');
  }
  return normalized as `0x${string}`;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readAcl(aclPath: string): Promise<{ acl: AclFile; existed: boolean; raw: string | null }> {
  try {
    const raw = await fs.readFile(aclPath, 'utf-8');
    const acl = JSON.parse(raw) as AclFile;
    return { acl, existed: true, raw };
  } catch (err) {
    const message = summarizeError(err);
    if (!message.includes('ENOENT')) {
      throw new Error(`Failed to read ACL file ${aclPath}: ${message}`);
    }
    const acl: AclFile = { grants: {}, connections: {} };
    return { acl, existed: false, raw: null };
  }
}

async function writeAcl(aclPath: string, acl: AclFile): Promise<void> {
  await fs.mkdir(dirname(aclPath), { recursive: true });
  await fs.writeFile(aclPath, `${JSON.stringify(acl, null, 2)}\n`, 'utf-8');
}

function ensureConnection(acl: AclFile, provider: string, connectionId: string): void {
  if (!acl.connections) acl.connections = {};
  const existing = acl.connections[connectionId] || {};
  acl.connections[connectionId] = {
    provider,
    metadata: {
      ...(existing.metadata || {}),
      scope: 'permission-matrix',
    },
  };
}

function setGrant(
  acl: AclFile,
  address: string,
  provider: string,
  connectionId: string,
  active: boolean,
): void {
  if (!acl.grants) acl.grants = {};
  const key = normalizeAddress(address);
  const grantsForAddress = acl.grants[key] || {};

  grantsForAddress[provider] = {
    nangoConnectionId: connectionId,
    pricePerAccess: '0',
    expiresAt: null,
    active,
  };

  acl.grants[key] = grantsForAddress;
}

async function signedJsonRequest(args: {
  signer: ReturnType<typeof createPrivateKeyHttpSigner>;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  let bodyString: string | undefined;

  if (args.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyString = JSON.stringify(args.body);
  }

  const request = await signRequestWithErc8128({
    signer: args.signer,
    input: args.url,
    init: {
      method: args.method,
      headers,
      body: bodyString,
    },
  });

  const response = await fetch(request);
  const text = await response.text();

  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return {
    status: response.status,
    json,
    text,
  };
}

async function fetchCapabilities(args: {
  gatewayUrl: string;
  signer: ReturnType<typeof createPrivateKeyHttpSigner>;
  requestId?: string;
}): Promise<{ status: number; providers: string[]; raw: any }> {
  const url = `${args.gatewayUrl.replace(/\/$/, '')}/credentials/capabilities`;
  const response = await signedJsonRequest({
    signer: args.signer,
    url,
    method: 'POST',
    body: args.requestId ? { requestId: args.requestId } : {},
  });

  const providers = Array.isArray(response.json?.providers)
    ? response.json.providers.filter((p: unknown): p is string => typeof p === 'string')
    : [];

  return {
    status: response.status,
    providers,
    raw: response.json ?? response.text,
  };
}

async function postGraphql(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GraphQL ${url} failed: HTTP ${response.status} ${text.slice(0, 240)}`);
  }
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GraphQL ${url} returned non-JSON response`);
  }
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(`GraphQL ${url} errors: ${JSON.stringify(json.errors).slice(0, 240)}`);
  }
  return json;
}

async function findLatestRequestIdForSender(sender: string): Promise<string | null> {
  // Force local E2E Ponder endpoint to avoid .env/.env.test bleed (e.g. :42070).
  const ponderUrl = E2E_LOCAL_PONDER_URL;
  const normalizedSender = normalizeAddress(sender);

  try {
    const json = await postGraphql(
      ponderUrl,
      `
        query SenderRequests($sender: String!, $limit: Int!) {
          requests(
            where: { sender: $sender }
            orderBy: "blockTimestamp"
            orderDirection: "desc"
            limit: $limit
          ) {
            items { id }
          }
        }
      `,
      { sender: normalizedSender, limit: 25 },
    );

    const items = Array.isArray(json?.data?.requests?.items) ? json.data.requests.items : [];
    const first = items[0]?.id;
    return typeof first === 'string' && first.length > 0 ? first : null;
  } catch {
    // Fallback for schema variants that may reject sender filtering.
    const json = await postGraphql(
      ponderUrl,
      `
        query RecentRequests($limit: Int!) {
          requests(orderBy: "blockTimestamp", orderDirection: "desc", limit: $limit) {
            items { id sender }
          }
        }
      `,
      { limit: 100 },
    );
    const items = Array.isArray(json?.data?.requests?.items) ? json.data.requests.items : [];
    const found = items.find((item: any) => normalizeAddress(String(item?.sender || '')) === normalizedSender);
    const id = found?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
}

function getSupabaseRestConfig(): { baseUrl: string; serviceRoleKey: string } {
  const baseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!baseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for auto venture provisioning');
  }
  return { baseUrl, serviceRoleKey };
}

async function resolveVentureIdForOwner(ownerAddress: string): Promise<string | null> {
  const { baseUrl, serviceRoleKey } = getSupabaseRestConfig();
  const url =
    `${baseUrl}/rest/v1/ventures` +
    `?owner_address=eq.${normalizeAddress(ownerAddress)}` +
    '&status=eq.active' +
    '&select=id' +
    '&limit=1';

  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Venture lookup failed: HTTP ${response.status} ${text.slice(0, 240)}`);
  }

  let json: any;
  try {
    json = text ? JSON.parse(text) : [];
  } catch {
    throw new Error('Venture lookup returned non-JSON response');
  }
  if (!Array.isArray(json) || json.length === 0) {
    return null;
  }
  const ventureId = json[0]?.id;
  return typeof ventureId === 'string' && ventureId.length > 0 ? ventureId : null;
}

async function createTemporaryVenture(ownerAddress: string): Promise<string> {
  const { baseUrl, serviceRoleKey } = getSupabaseRestConfig();
  const now = Date.now();
  const payload = {
    id: randomUUID(),
    name: `E2E Perm Matrix ${now}`,
    slug: `e2e-perm-matrix-${now}`,
    owner_address: normalizeAddress(ownerAddress),
    blueprint: { invariants: [] },
    status: 'active',
  };

  const response = await fetch(`${baseUrl}/rest/v1/ventures`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`Failed to create temporary venture: HTTP ${response.status} ${text.slice(0, 240)}`);
  }

  let json: any;
  try {
    json = text ? JSON.parse(text) : [];
  } catch {
    throw new Error('Temporary venture creation returned non-JSON response');
  }
  const ventureId = Array.isArray(json) ? json[0]?.id : json?.id;
  if (typeof ventureId !== 'string' || ventureId.length === 0) {
    throw new Error('Temporary venture creation response missing venture id');
  }
  return ventureId;
}

async function deleteVentureById(ventureId: string): Promise<void> {
  const { baseUrl, serviceRoleKey } = getSupabaseRestConfig();
  const url = `${baseUrl}/rest/v1/ventures?id=eq.${ventureId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      prefer: 'return=minimal',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to delete temporary venture ${ventureId}: HTTP ${response.status} ${text.slice(0, 240)}`);
  }
}

async function runGlobalMatrix(args: {
  aclPath: string;
  acl: AclFile;
  operatorAddress: string;
  provider: string;
  connectionId: string;
  gatewayUrl: string;
  signer: ReturnType<typeof createPrivateKeyHttpSigner>;
}): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  const scenarios: Array<{ name: string; active: boolean; expectedPresent: boolean }> = [
    {
      name: 'global-revoke-denies-provider',
      active: false,
      expectedPresent: false,
    },
    {
      name: 'global-grant-allows-provider',
      active: true,
      expectedPresent: true,
    },
    {
      name: 'global-revoke-removes-provider-again',
      active: false,
      expectedPresent: false,
    },
  ];

  for (const scenario of scenarios) {
    try {
      ensureConnection(args.acl, args.provider, args.connectionId);
      setGrant(args.acl, args.operatorAddress, args.provider, args.connectionId, scenario.active);
      await writeAcl(args.aclPath, args.acl);

      const probe = await fetchCapabilities({
        gatewayUrl: args.gatewayUrl,
        signer: args.signer,
      });

      if (probe.status !== 200) {
        results.push({
          scenario: scenario.name,
          status: 'FAIL',
          expected: `HTTP 200 + provider present=${scenario.expectedPresent}`,
          observed: `HTTP ${probe.status}`,
          details: typeof probe.raw === 'string'
            ? probe.raw.slice(0, 240)
            : JSON.stringify(probe.raw).slice(0, 240),
        });
        continue;
      }

      const hasProvider = probe.providers.includes(args.provider);
      const observed = `providers=[${probe.providers.join(', ')}]`;

      if (hasProvider !== scenario.expectedPresent) {
        results.push({
          scenario: scenario.name,
          status: 'FAIL',
          expected: `provider present=${scenario.expectedPresent}`,
          observed,
          details: `operator=${args.operatorAddress} provider=${args.provider}`,
        });
      } else {
        results.push({
          scenario: scenario.name,
          status: 'PASS',
          expected: `provider present=${scenario.expectedPresent}`,
          observed,
          details: `operator=${args.operatorAddress}`,
        });
      }
    } catch (err) {
      results.push({
        scenario: scenario.name,
        status: 'FAIL',
        expected: `provider present=${scenario.expectedPresent}`,
        observed: 'exception',
        details: summarizeError(err),
      });
    }
  }

  return results;
}

async function runVentureMatrix(args: {
  enabled: boolean;
  gatewayUrl: string;
  chainId: number;
  provider: string;
  connectionId: string;
  operatorAddress: string;
  operatorSigner: ReturnType<typeof createPrivateKeyHttpSigner>;
  adminPrivateKey?: string;
  ventureId?: string;
  requestId?: string;
  aclPath: string;
  acl: AclFile;
}): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  if (!args.enabled) {
    return results;
  }

  if (!args.ventureId || !args.requestId) {
    results.push({
      scenario: 'venture-matrix',
      status: 'SKIP',
      expected: 'ventureId + requestId resolved',
      observed: 'missing required venture inputs',
      details: 'Pass --venture-id/--request-id or let auto-resolution populate them.',
    });
    return results;
  }

  const adminSigner = args.adminPrivateKey
    ? createPrivateKeyHttpSigner(normalizeHexKey(args.adminPrivateKey), args.chainId)
    : null;
  const ventureSigner = adminSigner ?? args.operatorSigner;
  const minTrustTier = adminSigner ? 'trusted' : 'untrusted';
  const base = args.gatewayUrl.replace(/\/$/, '');

  // Register operator (self-service) so venture access checks can evaluate the caller.
  const register = await signedJsonRequest({
    signer: args.operatorSigner,
    url: `${base}/admin/operators`,
    method: 'POST',
    body: {},
  });

  if (register.status < 200 || register.status >= 300) {
    results.push({
      scenario: 'venture-register-operator',
      status: 'FAIL',
      expected: '2xx from POST /admin/operators',
      observed: `HTTP ${register.status}`,
      details: register.text.slice(0, 240),
    });
    return results;
  }

  results.push({
    scenario: 'venture-register-operator',
    status: 'PASS',
    expected: '2xx from POST /admin/operators',
    observed: `HTTP ${register.status}`,
  });

  if (adminSigner) {
    const tier = await signedJsonRequest({
      signer: adminSigner,
      url: `${base}/admin/operators/${args.operatorAddress}`,
      method: 'PUT',
      body: { tierOverride: 'trusted' },
    });

    if (tier.status < 200 || tier.status >= 300) {
      results.push({
        scenario: 'venture-set-operator-tier',
        status: 'FAIL',
        expected: '2xx from PUT /admin/operators/:address',
        observed: `HTTP ${tier.status}`,
        details: tier.text.slice(0, 240),
      });
      return results;
    }

    results.push({
      scenario: 'venture-set-operator-tier',
      status: 'PASS',
      expected: '2xx from PUT /admin/operators/:address',
      observed: `HTTP ${tier.status}`,
    });
  } else {
    results.push({
      scenario: 'venture-set-operator-tier',
      status: 'SKIP',
      expected: 'Admin signer provided',
      observed: 'No admin signer; using venture owner mode with minTrustTier=untrusted',
    });
  }

  // Configure venture credential in strict venture_only mode.
  const ventureCred = await signedJsonRequest({
    signer: ventureSigner,
    url: `${base}/admin/venture-credentials`,
    method: 'POST',
    body: {
      ventureId: args.ventureId,
      provider: args.provider,
      nangoConnectionId: args.connectionId,
      minTrustTier,
      accessMode: 'venture_only',
      pricePerAccess: '0',
    },
  });

  if (ventureCred.status < 200 || ventureCred.status >= 300) {
    results.push({
      scenario: 'venture-configure-provider',
      status: 'FAIL',
      expected: '2xx from POST /admin/venture-credentials',
      observed: `HTTP ${ventureCred.status}`,
      details: ventureCred.text.slice(0, 240),
    });
    return results;
  }

  results.push({
    scenario: 'venture-configure-provider',
    status: 'PASS',
    expected: '2xx from POST /admin/venture-credentials',
    observed: `HTTP ${ventureCred.status}`,
  });

  // Scenario 1: venture_only + blocked + global grant ON => still denied (fallback blocked).
  ensureConnection(args.acl, args.provider, args.connectionId);
  setGrant(args.acl, args.operatorAddress, args.provider, args.connectionId, true);
  await writeAcl(args.aclPath, args.acl);

  const blockedVentureOnly = await signedJsonRequest({
    signer: ventureSigner,
    url: `${base}/admin/venture-credentials/${args.ventureId}/${args.provider}/operators`,
    method: 'POST',
    body: { addresses: [args.operatorAddress], status: 'blocked' },
  });

  if (blockedVentureOnly.status >= 200 && blockedVentureOnly.status < 300) {
    const probe = await fetchCapabilities({
      gatewayUrl: args.gatewayUrl,
      signer: args.operatorSigner,
      requestId: args.requestId,
    });

    const hasProvider = probe.providers.includes(args.provider);
    results.push({
      scenario: 'venture-only-blocked-denies-even-with-global',
      status: probe.status === 200 && !hasProvider ? 'PASS' : 'FAIL',
      expected: 'HTTP 200 and provider absent',
      observed: `HTTP ${probe.status} providers=[${probe.providers.join(', ')}]`,
      details: hasProvider ? 'venture_only block should prevent global fallback.' : undefined,
    });
  } else {
    results.push({
      scenario: 'venture-only-blocked-denies-even-with-global',
      status: 'FAIL',
      expected: '2xx from operator blocklist update',
      observed: `HTTP ${blockedVentureOnly.status}`,
      details: blockedVentureOnly.text.slice(0, 240),
    });
  }

  // Scenario 2: venture_only + allowed + global grant OFF => allowed via venture credential.
  setGrant(args.acl, args.operatorAddress, args.provider, args.connectionId, false);
  await writeAcl(args.aclPath, args.acl);

  const allowed = await signedJsonRequest({
    signer: ventureSigner,
    url: `${base}/admin/venture-credentials/${args.ventureId}/${args.provider}/operators`,
    method: 'POST',
    body: { addresses: [args.operatorAddress], status: 'allowed' },
  });

  if (allowed.status >= 200 && allowed.status < 300) {
    const probeAllowed = await fetchCapabilities({
      gatewayUrl: args.gatewayUrl,
      signer: args.operatorSigner,
      requestId: args.requestId,
    });

    const allowedHasProvider = probeAllowed.providers.includes(args.provider);
    results.push({
      scenario: 'venture-only-allowed-permits-without-global',
      status: probeAllowed.status === 200 && allowedHasProvider ? 'PASS' : 'FAIL',
      expected: 'HTTP 200 and provider present',
      observed: `HTTP ${probeAllowed.status} providers=[${probeAllowed.providers.join(', ')}]`,
      details: !allowedHasProvider ? 'Provider should be present for allowed operator in venture_only mode.' : undefined,
    });
  } else {
    results.push({
      scenario: 'venture-only-allowed-permits-without-global',
      status: 'FAIL',
      expected: '2xx from operator allowlist update',
      observed: `HTTP ${allowed.status}`,
      details: allowed.text.slice(0, 240),
    });
  }

  // Scenario 3: union_with_global + blocked + global grant ON => allowed via global fallback.
  const unionMode = await signedJsonRequest({
    signer: ventureSigner,
    url: `${base}/admin/venture-credentials/${args.ventureId}/${args.provider}`,
    method: 'PUT',
    body: {
      minTrustTier,
      accessMode: 'union_with_global',
      pricePerAccess: '0',
      active: true,
    },
  });

  if (unionMode.status < 200 || unionMode.status >= 300) {
    results.push({
      scenario: 'venture-union-configure',
      status: 'FAIL',
      expected: '2xx from PUT /admin/venture-credentials/:ventureId/:provider',
      observed: `HTTP ${unionMode.status}`,
      details: unionMode.text.slice(0, 240),
    });
    return results;
  }

  const blockedUnion = await signedJsonRequest({
    signer: ventureSigner,
    url: `${base}/admin/venture-credentials/${args.ventureId}/${args.provider}/operators`,
    method: 'POST',
    body: { addresses: [args.operatorAddress], status: 'blocked' },
  });

  if (blockedUnion.status < 200 || blockedUnion.status >= 300) {
    results.push({
      scenario: 'venture-union-blocked-fallback',
      status: 'FAIL',
      expected: '2xx from operator blocklist update',
      observed: `HTTP ${blockedUnion.status}`,
      details: blockedUnion.text.slice(0, 240),
    });
    return results;
  }

  setGrant(args.acl, args.operatorAddress, args.provider, args.connectionId, true);
  await writeAcl(args.aclPath, args.acl);

  const probeUnionFallback = await fetchCapabilities({
    gatewayUrl: args.gatewayUrl,
    signer: args.operatorSigner,
    requestId: args.requestId,
  });
  const unionHasProvider = probeUnionFallback.providers.includes(args.provider);
  results.push({
    scenario: 'venture-union-blocked-falls-back-to-global',
    status: probeUnionFallback.status === 200 && unionHasProvider ? 'PASS' : 'FAIL',
    expected: 'HTTP 200 and provider present via global fallback',
    observed: `HTTP ${probeUnionFallback.status} providers=[${probeUnionFallback.providers.join(', ')}]`,
    details: !unionHasProvider ? 'union_with_global should allow fallback when venture denies.' : undefined,
  });

  return results;
}

async function writeReport(path: string, payload: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));

  if (bools.has('help') || bools.has('h')) {
    usage(0);
  }

  const cloneDir = flags.cwd ? resolve(flags.cwd) : undefined;
  const gatewayUrl = flags['gateway-url'] || DEFAULT_GATEWAY_URL;
  const aclPath = resolve(flags['acl-file'] || DEFAULT_ACL_PATH);
  const provider = (flags.provider || 'umami').trim();
  const connectionId = (flags.connection || `e2e-${provider}`).trim();
  const chainId = Number(flags['chain-id'] || process.env.CHAIN_ID || '8453');
  const noRestore = bools.has('no-restore');
  const reportPath = resolve(flags.report || DEFAULT_REPORT_PATH);
  const ventureEnabled = bools.has('venture');

  if (!provider) {
    throw new Error('--provider cannot be empty');
  }

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid --chain-id: ${flags['chain-id']}`);
  }

  let operatorPrivateKey: `0x${string}`;

  if (flags['operator-private-key']) {
    operatorPrivateKey = normalizeHexKey(flags['operator-private-key']);
  } else {
    if (!cloneDir) {
      throw new Error('--cwd is required when --operator-private-key is not provided');
    }

    // Point operate-profile resolution at the standalone clone.
    process.env.OPERATE_PROFILE_DIR = resolve(cloneDir, '.operate');
    const key = getServicePrivateKey();
    if (!key) {
      throw new Error(
        `Could not resolve active service private key from ${process.env.OPERATE_PROFILE_DIR}. ` +
        'Set OPERATE_PASSWORD if keys are encrypted or pass --operator-private-key directly.',
      );
    }
    operatorPrivateKey = normalizeHexKey(key);
  }

  const operatorAccount = privateKeyToAccount(operatorPrivateKey);
  const operatorAddress = normalizeAddress(operatorAccount.address);
  const operatorSigner = createPrivateKeyHttpSigner(operatorPrivateKey, chainId);
  // Admin key: explicit flag > env from start-e2e-stack > none (tier tests will SKIP)
  const adminPrivateKey = flags['admin-private-key'] || process.env.E2E_ADMIN_PRIVATE_KEY || undefined;
  let resolvedVentureId = flags['venture-id'];
  let resolvedRequestId = flags['request-id'];
  let temporaryVentureId: string | null = null;

  if (ventureEnabled) {
    if (!resolvedRequestId) {
      resolvedRequestId = await findLatestRequestIdForSender(operatorAddress) || undefined;
    }

    if (!resolvedVentureId) {
      resolvedVentureId = await resolveVentureIdForOwner(operatorAddress) || undefined;
      if (!resolvedVentureId) {
        temporaryVentureId = await createTemporaryVenture(operatorAddress);
        resolvedVentureId = await resolveVentureIdForOwner(operatorAddress) || temporaryVentureId;
      }
    }
  }

  console.log('Credential permission matrix configuration:');
  console.log(`  gateway: ${gatewayUrl}`);
  console.log(`  aclFile: ${aclPath}`);
  console.log(`  provider: ${provider}`);
  console.log(`  connection: ${connectionId}`);
  console.log(`  chainId: ${chainId}`);
  console.log(`  operator: ${operatorAddress}`);
  if (ventureEnabled) {
    console.log('  venture mode: enabled');
    console.log(`  ventureId: ${resolvedVentureId || '(unresolved)'}`);
    console.log(`  requestId: ${resolvedRequestId || '(unresolved)'}`);
    console.log(`  adminKey: ${adminPrivateKey ? 'provided' : '(none — tier tests will SKIP)'}`);
    if (temporaryVentureId) {
      console.log(`  temporaryVentureId: ${temporaryVentureId}`);
    }
  }

  const aclState = await readAcl(aclPath);
  const workingAcl = JSON.parse(JSON.stringify(aclState.acl)) as AclFile;
  const startedAt = new Date().toISOString();

  const results: ScenarioResult[] = [];

  try {
    const globalResults = await runGlobalMatrix({
      aclPath,
      acl: workingAcl,
      operatorAddress,
      provider,
      connectionId,
      gatewayUrl,
      signer: operatorSigner,
    });
    results.push(...globalResults);

    const ventureResults = await runVentureMatrix({
      enabled: ventureEnabled,
      gatewayUrl,
      chainId,
      provider,
      connectionId,
      operatorAddress,
      operatorSigner,
      adminPrivateKey,
      ventureId: resolvedVentureId,
      requestId: resolvedRequestId,
      aclPath,
      acl: workingAcl,
    });
    results.push(...ventureResults);
  } finally {
    if (!noRestore) {
      if (aclState.existed && aclState.raw !== null) {
        await fs.writeFile(aclPath, aclState.raw, 'utf-8');
      } else if (!aclState.existed) {
        await fs.rm(aclPath, { force: true });
      }
    }
    if (temporaryVentureId) {
      try {
        await deleteVentureById(temporaryVentureId);
      } catch (err) {
        console.error(`Warning: failed to delete temporary venture ${temporaryVentureId}: ${summarizeError(err)}`);
      }
    }
  }

  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const skipCount = results.filter(r => r.status === 'SKIP').length;

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    gatewayUrl,
    aclPath,
    provider,
    connectionId,
    chainId,
    operatorAddress,
    requestId: resolvedRequestId || null,
    ventureId: resolvedVentureId || null,
    temporaryVentureId,
    restoreAcl: !noRestore,
    ventureMode: ventureEnabled,
    summary: {
      total: results.length,
      pass: passCount,
      fail: failCount,
      skip: skipCount,
    },
    results,
  };

  await writeReport(reportPath, report);

  console.log('\nCredential permission matrix results:');
  for (const result of results) {
    const detail = result.details ? ` (${result.details})` : '';
    console.log(`  [${result.status}] ${result.scenario}: ${result.observed}${detail}`);
  }

  console.log(`\nSummary: PASS=${passCount} FAIL=${failCount} SKIP=${skipCount}`);
  console.log(`Report: ${reportPath}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Credential permission matrix failed:', summarizeError(err));
  process.exit(1);
});
