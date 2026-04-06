#!/usr/bin/env npx tsx
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { createPrivateKeyHttpSigner, signRequestWithErc8128 } from 'jinn-node/http/erc8128';
import { getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import {
  asInt,
  normalizeAddress,
  normalizeHexKey,
  nowIso,
  parseArgs,
  providerList,
  runCommand,
  runRailwayJson,
  summarizeError,
  withRailwayContext,
  writeJson,
} from './common.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.e2e'), override: true, quiet: true });

type Tier = 'trusted' | 'untrusted' | null;
type MatrixMode = 'auth' | 'filtering' | 'all';

interface ScenarioResult {
  scenario: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  expected: string;
  observed: string;
  details?: string;
}

function usage(exitCode: number = 1): never {
  console.error(
    [
      'Usage: yarn tsx scripts/test/railway/canary-credential-matrix.ts --workstream <id> [options]',
      '',
      'Options:',
      '  --mode auth|filtering|all              Default: all',
      '  --provider <name>                      Default: supabase',
      '  --workstream <id>                      Required workstream id',
      '  --request-id <0x...>                   Optional request id for venture context probe',
      '  --operate-dir <path>                   Default: /Users/adrianobradley/jinn-nodes/jinn-node/.operate',
      '  --chain-id <id>                        Default: 8453',
      '  --worker-project <name>                Default: jinn-worker',
      '  --worker-env <name>                    Default: production',
      '  --worker-service <name>                Default: canary-worker-2',
      '  --gateway-project <name>               Default: jinn-shared',
      '  --gateway-env <name>                   Default: production',
      '  --gateway-service <name>               Default: x402-gateway-canary',
      '  --gateway-url <url>                    Optional gateway URL override',
      '  --admin-private-key <0x...>            Optional admin signing key override',
      '  --artifact <path>                      Optional JSON report path',
      '  --dispatch-timeout-seconds <n>         Default: 360 (auth) / 300 (filtering)',
      '',
      'This script snapshots operator/policy state and restores it at the end.',
    ].join('\n'),
  );
  process.exit(exitCode);
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

  return { status: response.status, json, text };
}

async function resolveGatewayUrl(args: {
  override?: string;
  project: string;
  environment: string;
  service: string;
}): Promise<string> {
  if (args.override) return args.override.replace(/\/$/, '');

  return withRailwayContext({
    project: args.project,
    environment: args.environment,
    service: args.service,
    work: async (cwd) => {
      const status = await runRailwayJson<any>({ cwd, argv: ['status', '--json'] });
      const envEdges = status?.environments?.edges;
      if (!Array.isArray(envEdges)) {
        throw new Error('Unable to resolve gateway URL from Railway status (missing environments)');
      }

      for (const edge of envEdges) {
        const envNode = edge?.node;
        if (envNode?.name !== args.environment) continue;
        const serviceEdges = envNode?.serviceInstances?.edges;
        if (!Array.isArray(serviceEdges)) continue;

        for (const serviceEdge of serviceEdges) {
          const node = serviceEdge?.node;
          if (node?.serviceName !== args.service) continue;
          const domains = node?.domains?.serviceDomains;
          if (Array.isArray(domains) && domains.length > 0) {
            const first = domains[0];
            const domain = typeof first === 'string' ? first : first?.domain;
            if (typeof domain === 'string' && domain.length > 0) {
              return `https://${domain.replace(/^https?:\/\//, '')}`;
            }
          }
        }
      }

      throw new Error('Could not resolve gateway domain from Railway service domains');
    },
  });
}

async function fetchGatewayVars(args: {
  project: string;
  environment: string;
  service: string;
}): Promise<Record<string, string>> {
  return withRailwayContext({
    project: args.project,
    environment: args.environment,
    service: args.service,
    work: async (cwd) => runRailwayJson<Record<string, string>>({
      cwd,
      argv: ['variables', '--json', '-s', args.service, '-e', args.environment],
    }),
  });
}

async function runDispatchScript(args: {
  scenario: 'credential' | 'noncredential' | 'baseline';
  workstream: string;
  operateDir: string;
  expectDelivered: boolean;
  timeoutSeconds: number;
  workerProject: string;
  workerEnvironment: string;
  workerService: string;
  scratchDir: string;
  extraFlags?: string[];
}): Promise<any> {
  const artifact = resolve(args.scratchDir, `dispatch-${args.scenario}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const cmdArgs = [
    'tsx',
    'scripts/test/railway/canary-dispatch.ts',
    '--scenario',
    args.scenario,
    '--workstream',
    args.workstream,
    '--operate-dir',
    args.operateDir,
    '--expect-delivered',
    args.expectDelivered ? 'true' : 'false',
    '--timeout-seconds',
    String(args.timeoutSeconds),
    '--worker-project',
    args.workerProject,
    '--worker-env',
    args.workerEnvironment,
    '--worker-service',
    args.workerService,
    '--artifact',
    artifact,
  ];

  if (args.extraFlags && args.extraFlags.length > 0) {
    cmdArgs.push(...args.extraFlags);
  }

  const result = runCommand({
    cmd: 'yarn',
    argv: cmdArgs,
    cwd: MONOREPO_ROOT,
    timeoutMs: (args.timeoutSeconds + 120) * 1000,
    env: process.env,
  });

  if (!result.ok) {
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n---STDERR---\n');
    throw new Error(`Dispatch script failed (${args.scenario}):\n${combined}`);
  }

  const raw = await readFile(artifact, 'utf-8');
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has('help') || bools.has('h')) usage(0);

  const mode = (flags.mode || 'all') as MatrixMode;
  if (!['auth', 'filtering', 'all'].includes(mode)) {
    throw new Error(`Invalid --mode: ${mode}`);
  }

  const workstream = flags.workstream;
  if (!workstream) {
    throw new Error('--workstream is required');
  }

  const provider = (flags.provider || 'supabase').trim();
  const operateDir = resolve(flags['operate-dir'] || '/Users/adrianobradley/jinn-nodes/jinn-node/.operate');
  const chainId = asInt(flags['chain-id'], 8453);

  const workerProject = flags['worker-project'] || 'jinn-worker';
  const workerEnvironment = flags['worker-env'] || 'production';
  const workerService = flags['worker-service'] || 'canary-worker-2';
  const gatewayProject = flags['gateway-project'] || 'jinn-shared';
  const gatewayEnvironment = flags['gateway-env'] || 'production';
  const gatewayService = flags['gateway-service'] || 'x402-gateway-canary';
  const dispatchTimeoutSeconds = Math.max(120, asInt(flags['dispatch-timeout-seconds'], 360));

  process.env.OPERATE_PROFILE_DIR = operateDir;
  const operatorPrivateKeyRaw = getServicePrivateKey();
  if (!operatorPrivateKeyRaw) {
    throw new Error(`No service private key resolved from ${operateDir}`);
  }

  const operatorPrivateKey = normalizeHexKey(operatorPrivateKeyRaw);
  const operatorAddress = normalizeAddress(privateKeyToAccount(operatorPrivateKey).address);
  const operatorSigner = createPrivateKeyHttpSigner(operatorPrivateKey, chainId);

  const gatewayVars = await fetchGatewayVars({
    project: gatewayProject,
    environment: gatewayEnvironment,
    service: gatewayService,
  });

  const gatewayUrl = await resolveGatewayUrl({
    override: flags['gateway-url'] || process.env.CANARY_GATEWAY_URL,
    project: gatewayProject,
    environment: gatewayEnvironment,
    service: gatewayService,
  });

  const adminKeyRaw = flags['admin-private-key']
    || gatewayVars.CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY
    || gatewayVars.PRIVATE_KEY;
  if (!adminKeyRaw) {
    throw new Error('Admin private key is required (pass --admin-private-key or set gateway key vars).');
  }

  const adminPrivateKey = normalizeHexKey(adminKeyRaw);
  const adminSigner = createPrivateKeyHttpSigner(adminPrivateKey, chainId);
  const adminAddress = normalizeAddress(privateKeyToAccount(adminPrivateKey).address);

  const supabaseUrl = gatewayVars.SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = gatewayVars.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be available on gateway vars for temporary venture setup.');
  }

  const startedAt = nowIso();
  const results: ScenarioResult[] = [];
  const scratchDir = await mkdtemp(resolve(tmpdir(), 'jinn-canary-matrix-'));

  const policiesUrl = `${gatewayUrl}/admin/policies`;
  const operatorUrl = `${gatewayUrl}/admin/operators/${operatorAddress}`;
  const capsUrl = `${gatewayUrl}/credentials/capabilities`;

  let temporaryVentureId: string | null = null;
  let requestIdForContext = flags['request-id'];

  let operatorBefore: { tierOverride: Tier } | null = null;
  let policyBefore: any = null;

  const restoreSteps: Array<() => Promise<void>> = [];

  try {
    const register = await signedJsonRequest({
      signer: operatorSigner,
      url: `${gatewayUrl}/admin/operators`,
      method: 'POST',
      body: {},
    });

    if (register.status < 200 || register.status >= 300) {
      throw new Error(`Failed to register operator: HTTP ${register.status} ${register.text.slice(0, 240)}`);
    }

    const opBefore = await signedJsonRequest({
      signer: adminSigner,
      url: operatorUrl,
      method: 'GET',
    });

    if (opBefore.status === 200) {
      operatorBefore = {
        tierOverride: (opBefore.json?.tierOverride ?? null) as Tier,
      };
    }

    const policyList = await signedJsonRequest({
      signer: adminSigner,
      url: policiesUrl,
      method: 'GET',
    });
    if (policyList.status >= 200 && policyList.status < 300) {
      const list = Array.isArray(policyList.json?.policies) ? policyList.json.policies : [];
      policyBefore = list.find((item: any) => item?.provider === provider) || null;
    }

    restoreSteps.push(async () => {
      if (operatorBefore) {
        await signedJsonRequest({
          signer: adminSigner,
          url: operatorUrl,
          method: 'PUT',
          body: { tierOverride: operatorBefore.tierOverride },
        });
      }
    });

    restoreSteps.push(async () => {
      if (policyBefore) {
        await signedJsonRequest({
          signer: adminSigner,
          url: `${gatewayUrl}/admin/policies/${provider}`,
          method: 'PUT',
          body: {
            minTrustTier: policyBefore.minTrustTier,
            autoGrant: policyBefore.autoGrant,
            requiresApproval: policyBefore.requiresApproval,
            defaultPrice: policyBefore.defaultPrice,
            defaultNangoConnection: policyBefore.defaultNangoConnection ?? null,
            maxRequestsPerMinute: policyBefore.maxRequestsPerMinute,
            metadata: policyBefore.metadata ?? null,
          },
        });
      }
    });

    // Venture owner_address must match the on-chain request sender (operator EOA).
    // Both canary and production dispatch via marketplaceInteract with the service key,
    // making the on-chain sender the operator EOA. The Safe is only used for delivery.
    const venturePayload = {
      id: crypto.randomUUID(),
      name: `Canary Matrix ${Date.now()}`,
      slug: `canary-matrix-${Date.now()}`,
      owner_address: operatorAddress,
      blueprint: { invariants: [] },
      status: 'active',
    };

    const ventureCreate = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/ventures`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify(venturePayload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!ventureCreate.ok) {
      const text = await ventureCreate.text();
      throw new Error(`Failed to create temporary venture: HTTP ${ventureCreate.status} ${text.slice(0, 240)}`);
    }

    const ventureRows = await ventureCreate.json() as Array<{ id?: string }>;
    temporaryVentureId = ventureRows[0]?.id || venturePayload.id;

    restoreSteps.push(async () => {
      if (!temporaryVentureId) return;
      await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/ventures?id=eq.${temporaryVentureId}`, {
        method: 'DELETE',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          prefer: 'return=minimal',
        },
        signal: AbortSignal.timeout(15_000),
      });
    });

    if (!requestIdForContext) {
      const baselineDispatch = await runDispatchScript({
        scenario: 'baseline',
        workstream,
        operateDir,
        expectDelivered: true,
        timeoutSeconds: dispatchTimeoutSeconds,
        workerProject,
        workerEnvironment,
        workerService,
        scratchDir,
        extraFlags: ['--job-name', `canary-context-${Date.now()}`],
      });
      requestIdForContext = baselineDispatch.requestId;
    }

    if (!requestIdForContext) {
      throw new Error('Could not resolve requestId context for venture capability checks.');
    }

    async function putOperatorTier(tierOverride: Tier): Promise<void> {
      const response = await signedJsonRequest({
        signer: adminSigner,
        url: operatorUrl,
        method: 'PUT',
        body: { tierOverride },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`PUT /admin/operators failed: HTTP ${response.status} ${response.text.slice(0, 240)}`);
      }
    }

    async function upsertPolicy(policy: {
      minTrustTier: 'trusted' | 'untrusted';
      autoGrant: boolean;
      requiresApproval: boolean;
    }): Promise<void> {
      const response = await signedJsonRequest({
        signer: adminSigner,
        url: `${gatewayUrl}/admin/policies`,
        method: 'POST',
        body: {
          provider,
          minTrustTier: policy.minTrustTier,
          autoGrant: policy.autoGrant,
          requiresApproval: policy.requiresApproval,
          defaultPrice: '0',
          maxRequestsPerMinute: 100,
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`POST /admin/policies failed: HTTP ${response.status} ${response.text.slice(0, 240)}`);
      }
    }

    async function upsertVentureCredential(credential: {
      accessMode: 'venture_only' | 'union_with_global';
      minTrustTier: 'trusted' | 'untrusted';
    }): Promise<void> {
      const response = await signedJsonRequest({
        signer: adminSigner,
        url: `${gatewayUrl}/admin/venture-credentials`,
        method: 'POST',
        body: {
          ventureId: temporaryVentureId,
          provider,
          nangoConnectionId: `canary-${provider}`,
          minTrustTier: credential.minTrustTier,
          accessMode: credential.accessMode,
          pricePerAccess: '0',
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`POST /admin/venture-credentials failed: HTTP ${response.status} ${response.text.slice(0, 240)}`);
      }
    }

    async function setOperatorStatus(status: 'allowed' | 'blocked'): Promise<void> {
      const response = await signedJsonRequest({
        signer: adminSigner,
        url: `${gatewayUrl}/admin/venture-credentials/${temporaryVentureId}/${provider}/operators`,
        method: 'POST',
        body: {
          addresses: [operatorAddress],
          status,
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`POST operator status failed: HTTP ${response.status} ${response.text.slice(0, 240)}`);
      }
    }

    async function probeCapabilities(): Promise<{ status: number; providers: string[]; raw: any }> {
      const response = await signedJsonRequest({
        signer: operatorSigner,
        url: capsUrl,
        method: 'POST',
        body: { requestId: requestIdForContext },
      });

      return {
        status: response.status,
        providers: providerList(response.json?.providers),
        raw: response.json,
      };
    }

    const runAuth = mode === 'auth' || mode === 'all';
    const runFiltering = mode === 'filtering' || mode === 'all';

    if (runAuth) {
      await upsertPolicy({ minTrustTier: 'untrusted', autoGrant: true, requiresApproval: false });
      await putOperatorTier('trusted');
      await upsertVentureCredential({ accessMode: 'venture_only', minTrustTier: 'trusted' });
      await setOperatorStatus('blocked');

      const s1 = await probeCapabilities();
      results.push({
        scenario: 'venture_only_blocked_denies_even_with_global',
        status: s1.status === 200 && !s1.providers.includes(provider) ? 'PASS' : 'FAIL',
        expected: `HTTP 200 and ${provider} absent`,
        observed: `HTTP ${s1.status} providers=[${s1.providers.join(', ')}]`,
      });

      await upsertPolicy({ minTrustTier: 'trusted', autoGrant: false, requiresApproval: false });
      await setOperatorStatus('allowed');

      const s2 = await probeCapabilities();
      results.push({
        scenario: 'venture_only_allowed_permits_without_global',
        status: s2.status === 200 && s2.providers.includes(provider) ? 'PASS' : 'FAIL',
        expected: `HTTP 200 and ${provider} present`,
        observed: `HTTP ${s2.status} providers=[${s2.providers.join(', ')}]`,
      });

      await upsertPolicy({ minTrustTier: 'untrusted', autoGrant: true, requiresApproval: false });
      await upsertVentureCredential({ accessMode: 'union_with_global', minTrustTier: 'trusted' });
      await setOperatorStatus('blocked');

      const s3 = await probeCapabilities();
      results.push({
        scenario: 'union_with_global_blocked_falls_back_to_global',
        status: s3.status === 200 && s3.providers.includes(provider) ? 'PASS' : 'FAIL',
        expected: `HTTP 200 and ${provider} present via global fallback`,
        observed: `HTTP ${s3.status} providers=[${s3.providers.join(', ')}]`,
      });

      await upsertPolicy({ minTrustTier: 'trusted', autoGrant: false, requiresApproval: false });
      await upsertVentureCredential({ accessMode: 'venture_only', minTrustTier: 'trusted' });
      await setOperatorStatus('allowed');
      await putOperatorTier('trusted');

      const trustedDispatch = await runDispatchScript({
        scenario: 'credential',
        workstream,
        operateDir,
        expectDelivered: true,
        timeoutSeconds: dispatchTimeoutSeconds,
        workerProject,
        workerEnvironment,
        workerService,
        scratchDir,
        extraFlags: ['--job-name', `canary-auth-trusted-${Date.now()}`],
      });

      results.push({
        scenario: 'trusted_operator_can_execute_credential_job',
        status: trustedDispatch?.summary?.pass ? 'PASS' : 'FAIL',
        expected: 'credential job delivered successfully',
        observed: trustedDispatch?.summary?.pass
          ? `delivered request=${trustedDispatch.requestId}`
          : `dispatch failed request=${trustedDispatch?.requestId || 'n/a'}`,
      });

      await putOperatorTier('untrusted');
      await setOperatorStatus('blocked');

      const untrustedDispatch = await runDispatchScript({
        scenario: 'credential',
        workstream,
        operateDir,
        expectDelivered: false,
        timeoutSeconds: Math.min(dispatchTimeoutSeconds, 300),
        workerProject,
        workerEnvironment,
        workerService,
        scratchDir,
        extraFlags: ['--job-name', `canary-auth-untrusted-${Date.now()}`],
      });

      results.push({
        scenario: 'untrusted_operator_denied_credential_job',
        status: untrustedDispatch?.summary?.pass ? 'PASS' : 'FAIL',
        expected: 'credential job skipped/denied and not delivered within timeout',
        observed: untrustedDispatch?.summary?.pass
          ? `not-delivered request=${untrustedDispatch.requestId}`
          : `unexpected delivery or missing skip evidence request=${untrustedDispatch?.requestId || 'n/a'}`,
      });
    }

    if (runFiltering) {
      await upsertPolicy({ minTrustTier: 'trusted', autoGrant: false, requiresApproval: false });
      await upsertVentureCredential({ accessMode: 'venture_only', minTrustTier: 'trusted' });
      await setOperatorStatus('blocked');
      await putOperatorTier('untrusted');

      const credUntrusted = await runDispatchScript({
        scenario: 'credential',
        workstream,
        operateDir,
        expectDelivered: false,
        timeoutSeconds: Math.min(dispatchTimeoutSeconds, 300),
        workerProject,
        workerEnvironment,
        workerService,
        scratchDir,
        extraFlags: ['--job-name', `canary-filter-untrusted-cred-${Date.now()}`],
      });
      results.push({
        scenario: 'filtering_untrusted_skips_credential_jobs',
        status: credUntrusted?.summary?.pass ? 'PASS' : 'FAIL',
        expected: 'credential job not delivered for untrusted operator',
        observed: credUntrusted?.summary?.pass
          ? `not-delivered request=${credUntrusted.requestId}`
          : `unexpected delivery request=${credUntrusted?.requestId || 'n/a'}`,
      });

      const nonCredUntrusted = await runDispatchScript({
        scenario: 'noncredential',
        workstream,
        operateDir,
        expectDelivered: true,
        timeoutSeconds: dispatchTimeoutSeconds,
        workerProject,
        workerEnvironment,
        workerService,
        scratchDir,
        extraFlags: ['--job-name', `canary-filter-untrusted-noncred-${Date.now()}`],
      });
      results.push({
        scenario: 'filtering_untrusted_still_processes_noncredential_jobs',
        status: nonCredUntrusted?.summary?.pass ? 'PASS' : 'FAIL',
        expected: 'non-credential job delivered',
        observed: nonCredUntrusted?.summary?.pass
          ? `delivered request=${nonCredUntrusted.requestId}`
          : `failed request=${nonCredUntrusted?.requestId || 'n/a'}`,
      });

      await setOperatorStatus('allowed');
      await putOperatorTier('trusted');

      const credTrusted = await runDispatchScript({
        scenario: 'credential',
        workstream,
        operateDir,
        expectDelivered: true,
        timeoutSeconds: dispatchTimeoutSeconds,
        workerProject,
        workerEnvironment,
        workerService,
        scratchDir,
        extraFlags: ['--job-name', `canary-filter-trusted-cred-${Date.now()}`],
      });
      results.push({
        scenario: 'filtering_trusted_processes_credential_jobs',
        status: credTrusted?.summary?.pass ? 'PASS' : 'FAIL',
        expected: 'credential job delivered for trusted operator',
        observed: credTrusted?.summary?.pass
          ? `delivered request=${credTrusted.requestId}`
          : `failed request=${credTrusted?.requestId || 'n/a'}`,
      });
    }
  } finally {
    while (restoreSteps.length > 0) {
      const restore = restoreSteps.pop();
      if (!restore) continue;
      try {
        await restore();
      } catch {
        // best effort restore
      }
    }
    await rm(scratchDir, { recursive: true, force: true });
  }

  const report = {
    startedAt,
    finishedAt: nowIso(),
    mode,
    provider,
    chainId,
    workstream,
    gatewayUrl,
    adminAddress,
    operatorAddress,
    requestId: requestIdForContext,
    temporaryVentureId,
    summary: {
      total: results.length,
      pass: results.filter((result) => result.status === 'PASS').length,
      fail: results.filter((result) => result.status === 'FAIL').length,
      skip: results.filter((result) => result.status === 'SKIP').length,
      passAll: results.every((result) => result.status !== 'FAIL'),
    },
    results,
  };

  const artifactPath = flags.artifact ? resolve(flags.artifact) : undefined;
  if (artifactPath) {
    await writeJson(artifactPath, report);
  }

  console.log(JSON.stringify(report, null, 2));

  if (!report.summary.passAll) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`canary-credential-matrix failed: ${summarizeError(err)}`);
  process.exit(1);
});
