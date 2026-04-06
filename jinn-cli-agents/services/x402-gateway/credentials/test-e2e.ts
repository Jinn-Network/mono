/**
 * Credential Bridge E2E (ERC-8128)
 *
 * Runs focused auth + job-context + payment scenarios against a spawned gateway.
 *
 * Usage:
 *   tsx services/x402-gateway/credentials/test-e2e.ts
 *
 * Notes:
 * - Replay test runs only when REDIS_URL is set.
 * - Uses local spawned gateway instances with per-test ACL JSON files.
 */

import 'dotenv/config';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { createPrivateKeyHttpSigner, signRequestWithErc8128 } from '../../../jinn-node/dist/http/erc8128.js';
import { createTestPaymentHeader } from './x402-verify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const GATEWAY_DIR = resolve(REPO_ROOT, 'services', 'x402-gateway');
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_ADDRESS = TEST_ACCOUNT.address.toLowerCase();
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001';
const PAYMENT_ADDRESS = '0x1234567890123456789012345678901234567890';
const CHAIN_ID = 8453;

const signer = createPrivateKeyHttpSigner(TEST_PRIVATE_KEY, CHAIN_ID);

type AuditRecord = Record<string, unknown>;

type GatewayHandle = {
  port: number;
  logs: string[];
  stop: () => Promise<void>;
  findAudit: (action: string) => AuditRecord[];
};

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(message: string): void {
  passed += 1;
  console.log(`[PASS] ${message}`);
}

function fail(message: string): void {
  failed += 1;
  console.log(`[FAIL] ${message}`);
}

function skip(message: string): void {
  skipped += 1;
  console.log(`[SKIP] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate port');
  }
  const port = address.port;
  server.close();
  return port;
}

async function startMockControlApi(mode: 'match' | 'mismatch'): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await getFreePort();
  const server = createServer((req, res) => {
    if (req.url !== '/graphql' || req.method !== 'POST') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const workerAddress = mode === 'match' ? TEST_ADDRESS : OTHER_ADDRESS;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        getRequestClaim: {
          request_id: '0xabc',
          worker_address: workerAddress,
          status: 'IN_PROGRESS',
          claimed_at: new Date().toISOString(),
        },
      },
    }));
  });

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');

  return {
    url: `http://127.0.0.1:${port}/graphql`,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function createAclFile(pricePerAccess: string): Promise<{ dir: string; aclPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'jinn-cred-e2e-'));
  const aclPath = join(dir, 'acl.json');
  const acl = {
    connections: {
      conn_github: { provider: 'github' },
    },
    grants: {
      [TEST_ADDRESS]: {
        github: {
          nangoConnectionId: 'conn_github',
          pricePerAccess,
          expiresAt: null,
          active: true,
        },
      },
    },
  };
  await writeFile(aclPath, JSON.stringify(acl, null, 2), 'utf8');
  return { dir, aclPath };
}

function parseAuditLine(line: string): { action: string; payload: AuditRecord } | null {
  const match = line.match(/^\[audit\]\s+([a-z_]+)\s+(.+)$/i);
  if (!match) return null;
  try {
    return {
      action: match[1],
      payload: JSON.parse(match[2]) as AuditRecord,
    };
  } catch {
    return null;
  }
}

async function startGateway(opts: {
  requireJobContext: boolean;
  aclPath: string;
  controlApiUrl: string;
  x402DevMode?: boolean;
}): Promise<GatewayHandle> {
  const port = await getFreePort();
  const logs: string[] = [];
  const env = {
    ...process.env,
    PORT: String(port),
    REQUIRE_JOB_CONTEXT: opts.requireJobContext ? 'true' : 'false',
    CREDENTIAL_ACL_PATH: opts.aclPath,
    CONTROL_API_URL: opts.controlApiUrl,
    CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY: TEST_PRIVATE_KEY,
    CHAIN_ID: String(CHAIN_ID),
    X402_NETWORK: 'base',
    X402_DEV_MODE: opts.x402DevMode ? 'true' : 'false',
    GATEWAY_PAYMENT_ADDRESS: PAYMENT_ADDRESS,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || 'ghp_dummy',
    NANGO_HOST: process.env.NANGO_HOST || 'http://localhost:3003',
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY || 'nango-dev-secret-key',
  };

  const proc = spawn('tsx', ['index.ts'], {
    cwd: GATEWAY_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const capture = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        logs.push(trimmed);
      }
    }
  };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);

  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (logs.some((line) => line.includes(`x402 Gateway running on :${port}`))) {
      break;
    }
    if (proc.exitCode !== null) {
      throw new Error(`Gateway exited early with code ${proc.exitCode}\n${logs.join('\n')}`);
    }
    await sleep(100);
  }

  if (!logs.some((line) => line.includes(`x402 Gateway running on :${port}`))) {
    proc.kill('SIGTERM');
    throw new Error(`Gateway did not start in time\n${logs.join('\n')}`);
  }

  return {
    port,
    logs,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        await once(proc, 'exit').catch(() => undefined);
      }
    },
    findAudit: (action: string) => {
      return logs
        .map(parseAuditLine)
        .filter((entry): entry is { action: string; payload: AuditRecord } => entry !== null)
        .filter((entry) => entry.action === action)
        .map((entry) => entry.payload);
    },
  };
}

async function signedCredentialRequest(
  port: number,
  provider: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const request = await signRequestWithErc8128({
    signer,
    input: `http://127.0.0.1:${port}/credentials/${provider}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    },
  });
  const response = await fetch(request);
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

async function run(): Promise<void> {
  console.log('=== Credential Bridge E2E (ERC-8128) ===');

  // 1) Unsigned request rejected
  {
    const acl = await createAclFile('0');
    const gateway = await startGateway({
      requireJobContext: false,
      aclPath: acl.aclPath,
      controlApiUrl: 'http://127.0.0.1:9/graphql',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/credentials/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response.status === 401) pass('Unsigned credential request is rejected');
      else fail(`Expected 401 for unsigned request, got ${response.status}`);
    } finally {
      await gateway.stop();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  // 2) Missing requestId denied when job context required
  {
    const acl = await createAclFile('0');
    const controlApi = await startMockControlApi('match');
    const gateway = await startGateway({
      requireJobContext: true,
      aclPath: acl.aclPath,
      controlApiUrl: controlApi.url,
    });
    try {
      const res = await signedCredentialRequest(gateway.port, 'github', {});
      if (res.status === 403) pass('Missing requestId returns 403 when REQUIRE_JOB_CONTEXT=true');
      else fail(`Expected 403 for missing requestId, got ${res.status}`);
    } finally {
      await gateway.stop();
      await controlApi.close();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  // 3) Claim mismatch denied (403)
  {
    const acl = await createAclFile('0');
    const controlApi = await startMockControlApi('mismatch');
    const gateway = await startGateway({
      requireJobContext: true,
      aclPath: acl.aclPath,
      controlApiUrl: controlApi.url,
    });
    try {
      const res = await signedCredentialRequest(gateway.port, 'github', { requestId: '0xabc' });
      if (res.status === 403) pass('Claim mismatch returns 403');
      else fail(`Expected 403 for claim mismatch, got ${res.status}`);
    } finally {
      await gateway.stop();
      await controlApi.close();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  // 4) Control API outage denied (503 fail-closed)
  {
    const acl = await createAclFile('0');
    const gateway = await startGateway({
      requireJobContext: true,
      aclPath: acl.aclPath,
      controlApiUrl: 'http://127.0.0.1:9/graphql',
    });
    try {
      const res = await signedCredentialRequest(gateway.port, 'github', { requestId: '0xabc' });
      if (res.status === 503) pass('Control API outage returns deny (503)');
      else fail(`Expected 503 when Control API unavailable, got ${res.status}`);
    } finally {
      await gateway.stop();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  // 5) Free provider success + structured audit
  {
    const acl = await createAclFile('0');
    const gateway = await startGateway({
      requireJobContext: false,
      aclPath: acl.aclPath,
      controlApiUrl: 'http://127.0.0.1:9/graphql',
    });
    try {
      const res = await signedCredentialRequest(gateway.port, 'github', {});
      if (res.status === 200 && res.body?.access_token) {
        pass('Free provider request succeeds');
      } else {
        fail(`Expected free provider success, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
      await sleep(100);
      const audit = gateway.findAudit('token_issued').at(-1);
      if (audit?.verificationState === 'not_required') {
        pass('Token-issued audit includes verification attribution');
      } else {
        fail(`Missing verification attribution on token_issued audit: ${JSON.stringify(audit)}`);
      }
    } finally {
      await gateway.stop();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  // 6-8) Paid provider flows + structured audit
  {
    const acl = await createAclFile('1000');
    const gateway = await startGateway({
      requireJobContext: false,
      aclPath: acl.aclPath,
      controlApiUrl: 'http://127.0.0.1:9/graphql',
      x402DevMode: true,
    });
    try {
      const missingPayment = await signedCredentialRequest(gateway.port, 'github', {});
      if (missingPayment.status === 402) pass('Paid provider returns 402 when payment missing');
      else fail(`Expected 402 for missing payment, got ${missingPayment.status}`);

      const invalidPayment = await signedCredentialRequest(
        gateway.port,
        'github',
        {},
        { 'X-Payment': 'not-valid-base64!!!' },
      );
      if (invalidPayment.status === 402 && invalidPayment.body?.code === 'PAYMENT_INVALID') {
        pass('Paid provider returns PAYMENT_INVALID for malformed payment');
      } else {
        fail(`Expected PAYMENT_INVALID, got ${invalidPayment.status}: ${JSON.stringify(invalidPayment.body)}`);
      }

      const paymentHeader = createTestPaymentHeader({
        from: TEST_ADDRESS,
        to: PAYMENT_ADDRESS,
        value: '1000',
        network: 'base',
      });
      const paidSuccess = await signedCredentialRequest(
        gateway.port,
        'github',
        {},
        { 'X-Payment': paymentHeader },
      );
      if (paidSuccess.status === 200 && paidSuccess.body?.access_token) {
        pass('Paid provider request succeeds with valid payment');
      } else {
        fail(`Expected paid success, got ${paidSuccess.status}: ${JSON.stringify(paidSuccess.body)}`);
      }

      await sleep(100);
      const requiredAudit = gateway.findAudit('payment_required').at(-1);
      const invalidAudit = gateway.findAudit('payment_invalid').at(-1);
      const issuedAudit = gateway.findAudit('token_issued').at(-1);

      if (requiredAudit?.paymentRequiredAmount === '1000' && requiredAudit?.paymentNetwork === 'base') {
        pass('payment_required audit has typed payment attribution');
      } else {
        fail(`payment_required audit missing typed attribution: ${JSON.stringify(requiredAudit)}`);
      }

      if (invalidAudit?.paymentErrorCode && invalidAudit?.paymentRequiredAmount === '1000') {
        pass('payment_invalid audit has typed error attribution');
      } else {
        fail(`payment_invalid audit missing typed attribution: ${JSON.stringify(invalidAudit)}`);
      }

      if (issuedAudit?.paymentPaidAmount === '1000' && issuedAudit?.paymentPayer === TEST_ADDRESS) {
        pass('token_issued audit has typed paid attribution');
      } else {
        fail(`token_issued audit missing paid attribution: ${JSON.stringify(issuedAudit)}`);
      }
    } finally {
      await gateway.stop();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  // 9) Static umami provider returns JWT (when UMAMI_HOST set)
  if (!process.env.UMAMI_HOST || !process.env.UMAMI_USERNAME || !process.env.UMAMI_PASSWORD) {
    skip('Umami static provider test skipped (UMAMI_HOST/USERNAME/PASSWORD not set)');
  } else {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-cred-e2e-'));
    const aclPath = join(dir, 'acl.json');
    const acl = {
      connections: {
        conn_umami: { provider: 'umami' },
      },
      grants: {
        [TEST_ADDRESS]: {
          umami: {
            nangoConnectionId: 'conn_umami',
            pricePerAccess: '0',
            expiresAt: null,
            active: true,
          },
        },
      },
    };
    await writeFile(aclPath, JSON.stringify(acl, null, 2), 'utf8');

    const gateway = await startGateway({
      requireJobContext: false,
      aclPath,
      controlApiUrl: 'http://127.0.0.1:9/graphql',
    });
    try {
      const res = await signedCredentialRequest(gateway.port, 'umami', {});
      if (res.status === 200 && res.body?.access_token) {
        pass('Static umami provider returns JWT');
      } else {
        fail(`Expected umami JWT, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
    } finally {
      await gateway.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 10) Replay rejection (only when Redis is configured)
  if (!process.env.REDIS_URL) {
    skip('Replay test skipped (REDIS_URL not set)');
  } else {
    const acl = await createAclFile('0');
    const gateway = await startGateway({
      requireJobContext: false,
      aclPath: acl.aclPath,
      controlApiUrl: 'http://127.0.0.1:9/graphql',
    });
    try {
      const request = await signRequestWithErc8128({
        signer,
        input: `http://127.0.0.1:${gateway.port}/credentials/github`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      });

      const first = await fetch(request.clone());
      const second = await fetch(request.clone());

      if (first.status !== 401 && second.status === 401) {
        pass('Replay of identical signed request is rejected');
      } else {
        fail(`Expected replay rejection on second request, got first=${first.status} second=${second.status}`);
      }
    } finally {
      await gateway.stop();
      await rm(acl.dir, { recursive: true, force: true });
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
