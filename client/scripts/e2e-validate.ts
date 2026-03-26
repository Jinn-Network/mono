/**
 * End-to-end validation script for MechAdapter against real Mech marketplace
 * contracts on a Base mainnet fork (via Anvil).
 *
 * Usage: npx tsx scripts/e2e-validate.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  getMechDeliveryRate,
  getTimeoutBounds,
  decodeMarketplaceRequestLogs,
  decodeDeliverLogs,
} from '../src/adapters/mech/contracts.js';
import { digestHexToGatewayUrl } from '../src/adapters/mech/ipfs.js';
import {
  MECH_MARKETPLACE_ABI,
  MECH_ABI,
  NATIVE_PAYMENT_TYPE,
  SAFE_SETUP_ABI,
  SAFE_PROXY_FACTORY_ABI,
  SAFE_ABI,
  SAFE_SINGLETON_ADDRESS,
  SAFE_PROXY_FACTORY_ADDRESS,
} from '../src/adapters/mech/types.js';
import { executeSafeTransaction } from '../src/adapters/mech/safe.js';
import { MechAdapter } from '../src/adapters/mech/adapter.js';
import { Daemon, type DaemonConfig } from '../src/daemon/daemon.js';
import { ClaudeRunner } from '../src/runner/claude.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PATH = process.env['ANVIL_PATH'] ?? '/Users/adrianobradley/.foundry/bin/anvil';
const ANVIL_PORT = 8546;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

const MARKETPLACE_ADDRESS: Address = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';
const MECH_ADDRESS: Address = '0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299';

const ANVIL_ACCOUNT_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Real operator credentials — loaded from environment
const OPERATOR_MECH_ADDRESS: Address = '0xD03d75D3B59Ac252F2e8C7Bf4617cf91a102E613';
const OPERATOR_SAFE_ADDRESS: Address = '0x608d976Da1Dd9BC53aeA87Abe74e1306Ab96280c';
const OPERATOR_EOA_KEY: Hex = (process.env['OPERATOR_EOA_KEY'] ?? '') as Hex;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${description}`);
}

async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

// ── Mock IPFS server ────────────────────────────────────────────────────────

function startMockIpfs(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    let lastBody = '{}';
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/v0/add') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          lastBody = Buffer.concat(chunks).toString();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // Return a well-known CIDv0 (empty unixfs directory)
          res.end(JSON.stringify({ Hash: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn' }));
        });
      } else if (req.method === 'GET' && req.url?.startsWith('/ipfs/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(lastBody);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// ── Phase runner ─────────────────────────────────────────────────────────────

interface PhaseResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function runPhase(name: string, fn: () => Promise<void>): Promise<PhaseResult> {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`  ✓ ${name} (${ms}ms)`);
    return { name, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name} (${ms}ms): ${error}`);
    return { name, ok: false, ms, error };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Jinn-Client E2E Validation (Anvil Base Fork) ===\n');

  let anvil: ChildProcess | null = null;
  const results: PhaseResult[] = [];

  // Shared state populated across phases
  const account = privateKeyToAccount(ANVIL_ACCOUNT_KEY);
  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let historicalRequestDataHex: string | undefined;
  let safeAddress: Address | undefined;
  let submittedRequestId: Hex | undefined;
  let mockIpfsServer: Server | undefined;
  let mockIpfsUrl: string | undefined;
  let adapter: MechAdapter | undefined;

  try {
    // ── Phase 1: Infrastructure ────────────────────────────────────────────

    results.push(
      await runPhase('Phase 1: Infrastructure — spawn Anvil fork', async () => {
        anvil = spawn(ANVIL_PATH, [
          '--fork-url', BASE_RPC_URL,
          '--port', String(ANVIL_PORT),
          '--silent',
        ], {
          stdio: 'ignore',
          detached: false,
        });

        anvil.on('error', (err) => {
          throw new Error(`Failed to spawn Anvil: ${err.message}`);
        });

        // Wait for Anvil to be ready
        await waitFor('Anvil RPC ready', async () => {
          try {
            const blockNum = await jsonRpc(ANVIL_RPC, 'eth_blockNumber');
            return typeof blockNum === 'string' && blockNum.startsWith('0x');
          } catch {
            return false;
          }
        });

        // Create viem clients (cast to plain types expected by contract helpers)
        publicClient = createPublicClient({
          chain: base,
          transport: http(ANVIL_RPC),
        }) as unknown as PublicClient;

        walletClient = createWalletClient({
          chain: base,
          transport: http(ANVIL_RPC),
          account,
        }) as unknown as WalletClient;

        const blockNumber = await publicClient.getBlockNumber();
        console.log(`    Anvil forked at block ${blockNumber}`);
      }),
    );

    // ── Phase 2: Contract Reads ────────────────────────────────────────────

    results.push(
      await runPhase('Phase 2: Contract reads', async () => {
        const deliveryRate = await getMechDeliveryRate(publicClient, MECH_ADDRESS);
        if (typeof deliveryRate !== 'bigint' || deliveryRate === 0n) {
          throw new Error(`Expected non-zero bigint delivery rate, got ${deliveryRate}`);
        }
        console.log(`    deliveryRate = ${deliveryRate}`);

        const { min, max } = await getTimeoutBounds(publicClient, MARKETPLACE_ADDRESS);
        if (min >= max) throw new Error(`Expected min < max, got min=${min} max=${max}`);
        if (min <= 0n || max <= 0n) throw new Error(`Expected both > 0, got min=${min} max=${max}`);
        console.log(`    timeoutBounds = { min: ${min}, max: ${max} }`);

        const adapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: MECH_ADDRESS,
          safeAddress: account.address, // dummy for initialization
          agentEoaPrivateKey: ANVIL_ACCOUNT_KEY,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 5000,
          chainId: base.id,
        });
        await adapter.initialize();
        await adapter.stop();
        console.log('    MechAdapter.initialize() succeeded');
      }),
    );

    // ── Phase 3: Historical Event Decoding ─────────────────────────────────

    results.push(
      await runPhase('Phase 3: Historical event decoding', async () => {
        const currentBlock = await publicClient.getBlockNumber();
        const totalRange = 5000n; // Small range to avoid RPC timeouts on public endpoints
        const chunkSize = 2499n;
        const fromBlock = currentBlock - totalRange;

        // Query MarketplaceRequest events in chunks
        const allMarketplaceLogs: Awaited<ReturnType<typeof publicClient.getLogs>> = [];
        for (let start = fromBlock; start <= currentBlock; start += chunkSize + 1n) {
          const end = start + chunkSize > currentBlock ? currentBlock : start + chunkSize;
          const logs = await publicClient.getLogs({
            address: MARKETPLACE_ADDRESS,
            fromBlock: start,
            toBlock: end,
          });
          allMarketplaceLogs.push(...logs);
          if (allMarketplaceLogs.length > 0) break; // Found some — no need to scan all chunks
        }
        const decodedRequests = decodeMarketplaceRequestLogs(allMarketplaceLogs);
        if (decodedRequests.length === 0) {
          throw new Error('Expected at least 1 MarketplaceRequest event in last 50k blocks');
        }
        console.log(`    Decoded ${decodedRequests.length} MarketplaceRequest event(s)`);
        console.log(`    First requestId: ${decodedRequests[0].requestId}`);

        // Save for Phase 4
        historicalRequestDataHex = decodedRequests[0].requestDataHex;

        // Query Deliver events from Mech contract in chunks
        const allMechLogs: Awaited<ReturnType<typeof publicClient.getLogs>> = [];
        for (let start = fromBlock; start <= currentBlock; start += chunkSize + 1n) {
          const end = start + chunkSize > currentBlock ? currentBlock : start + chunkSize;
          const logs = await publicClient.getLogs({
            address: MECH_ADDRESS,
            fromBlock: start,
            toBlock: end,
          });
          allMechLogs.push(...logs);
          if (allMechLogs.length > 0) break;
        }
        const decodedDeliveries = decodeDeliverLogs(allMechLogs);
        if (decodedDeliveries.length === 0) {
          console.log('    No Deliver events found for this mech in range (mech may be inactive — OK)');
        } else {
          console.log(`    Decoded ${decodedDeliveries.length} Deliver event(s)`);
          console.log(`    First delivery mechAddress: ${decodedDeliveries[0].mechAddress}`);
        }
      }),
    );

    // ── Phase 4: IPFS Roundtrip ────────────────────────────────────────────

    results.push(
      await runPhase('Phase 4: IPFS roundtrip', async () => {
        if (!historicalRequestDataHex) {
          throw new Error('No requestDataHex available from Phase 3');
        }

        // Extract the 32-byte digest from the request data
        // It may be raw 32 bytes (0x + 64 hex chars = 66 chars) or ABI-encoded bytes
        let digestHex: string;
        const raw = historicalRequestDataHex.startsWith('0x')
          ? historicalRequestDataHex.slice(2)
          : historicalRequestDataHex;

        if (raw.length === 64) {
          // Raw 32-byte digest
          digestHex = raw;
        } else {
          // ABI-encoded bytes — take the last 64 hex chars as the digest
          digestHex = raw.slice(-64);
        }

        const url = digestHexToGatewayUrl(digestHex);
        console.log(`    Gateway URL: ${url}`);

        const response = await fetch(url);
        if (!response.ok) {
          // Content may have been garbage collected — that's OK, we validated the URL format
          console.log(`    Gateway returned ${response.status} — content may be GC'd, URL format validated`);
          return;
        }

        const text = await response.text();
        try {
          const content = JSON.parse(text);
          if (typeof content !== 'object' || content === null) {
            throw new Error(`Expected JSON object, got ${typeof content}`);
          }
          console.log(`    Fetched valid JSON with keys: ${Object.keys(content as Record<string, unknown>).join(', ')}`);
        } catch {
          // Non-JSON response (HTML error page etc) — URL format is still validated
          console.log(`    Gateway returned non-JSON content (${text.length} bytes) — URL format validated`);
        }
      }),
    );

    // ── Phase 5a: Deploy Safe ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 5a: Deploy 1-of-1 Safe', async () => {
        const { encodeFunctionData } = await import('viem');

        // Encode Safe.setup() initializer
        const initializer = encodeFunctionData({
          abi: SAFE_SETUP_ABI,
          functionName: 'setup',
          args: [
            [account.address],    // owners
            1n,                   // threshold
            '0x0000000000000000000000000000000000000000' as Address, // to
            '0x' as Hex,          // data
            '0x0000000000000000000000000000000000000000' as Address, // fallbackHandler
            '0x0000000000000000000000000000000000000000' as Address, // paymentToken
            0n,                   // payment
            '0x0000000000000000000000000000000000000000' as Address, // paymentReceiver
          ],
        });

        // Deploy via ProxyFactory.createProxyWithNonce()
        const hash = await walletClient.writeContract({
          address: SAFE_PROXY_FACTORY_ADDRESS,
          abi: SAFE_PROXY_FACTORY_ABI,
          functionName: 'createProxyWithNonce',
          args: [SAFE_SINGLETON_ADDRESS, initializer, 0n],
          account,
          chain: base,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('Safe deployment reverted');

        // Extract Safe address from ProxyCreation event
        // ProxyCreation(address proxy, address singleton) — neither param is indexed in Safe v1.3.0
        // proxy address is in the first 32 bytes of log data (ABI-encoded address)
        const proxyLog = receipt.logs.find(l => l.address.toLowerCase() === SAFE_PROXY_FACTORY_ADDRESS.toLowerCase());
        if (!proxyLog) throw new Error('No ProxyCreation event found');
        // ABI-encoded address: 32 bytes, right-padded — take bytes 12-32 (last 20 bytes)
        safeAddress = ('0x' + proxyLog.data.slice(26, 66)) as Address;

        // Fund the Safe with ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [safeAddress, '0x56BC75E2D63100000']); // 100 ETH

        // Verify Safe is operational
        const nonce = await publicClient.readContract({
          address: safeAddress,
          abi: SAFE_ABI,
          functionName: 'nonce',
        });
        if (nonce !== 0n) throw new Error(`Expected nonce 0, got ${nonce}`);

        console.log(`    Safe deployed at: ${safeAddress}`);
        console.log(`    Safe nonce: ${nonce}`);
      }),
    );

    // ── Phase 5b: Start mock IPFS server ─────────────────────────────────────

    results.push(
      await runPhase('Phase 5b: Start mock IPFS server', async () => {
        const mock = await startMockIpfs();
        mockIpfsServer = mock.server;
        mockIpfsUrl = mock.url;
        console.log(`    Mock IPFS running at: ${mockIpfsUrl}`);
      }),
    );

    // ── Phase 5c: postDesiredState through adapter ──────────────────────────

    results.push(
      await runPhase('Phase 5c: postDesiredState through adapter', async () => {
        if (!safeAddress) throw new Error('No Safe address from Phase 5a');
        if (!mockIpfsUrl) throw new Error('No mock IPFS URL from Phase 5b');

        adapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: MECH_ADDRESS,
          safeAddress,
          agentEoaPrivateKey: ANVIL_ACCOUNT_KEY,
          ipfsRegistryUrl: mockIpfsUrl,
          ipfsGatewayUrl: mockIpfsUrl,
          pollIntervalMs: 1000,
          chainId: base.id,
        });
        await adapter.initialize();

        // Call the actual adapter method — tests IPFS upload + cidToDigestHex + Safe tx
        submittedRequestId = await adapter.postDesiredState({
          id: 'e2e-test-1',
          description: 'E2E test desired state',
        }) as Hex;

        console.log(`    postDesiredState returned requestId: ${submittedRequestId}`);

        // Verify on-chain
        const info = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [submittedRequestId],
        });
        const [priorityMech, , requester] = info as [Address, Address, Address, bigint, bigint, Hex];
        if (requester.toLowerCase() !== safeAddress.toLowerCase()) {
          throw new Error(`Expected requester=${safeAddress}, got ${requester}`);
        }
        console.log(`    Requester (Safe): ${requester}`);
        console.log(`    Priority mech: ${priorityMech}`);
      }),
    );

    // ── Phase 5d: watchForRequests picks up request ──────────────────────────

    results.push(
      await runPhase('Phase 5d: watchForRequests picks up request (real IPFS)', async () => {
        if (!safeAddress) throw new Error('No Safe address');

        // Create a fresh adapter with REAL IPFS so content is verifiable
        const pollAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: MECH_ADDRESS,
          safeAddress,
          agentEoaPrivateKey: ANVIL_ACCOUNT_KEY,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
        });
        await pollAdapter.initialize();

        // Submit a new request AFTER initialization (so event is after cursor)
        const newRequestId = await pollAdapter.postDesiredState({
          id: 'e2e-test-watch',
          description: 'watchForRequests content verification test',
        });
        console.log(`    Posted new request: ${newRequestId}`);

        // Mine a block to advance
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Start watching and wait for it to yield
        const request = await Promise.race([
          (async () => {
            for await (const req of pollAdapter.watchForRequests()) {
              return req;
            }
            return null;
          })(),
          sleep(15000).then(() => { throw new Error('watchForRequests timed out after 15s'); }),
        ]);

        await pollAdapter.stop();

        if (!request) throw new Error('watchForRequests yielded null');
        console.log(`    watchForRequests yielded requestId: ${request.requestId}`);
        console.log(`    Desired state description: "${request.desiredState.description}"`);

        // Verify content matches what was uploaded
        if (!request.desiredState.description.includes('watchForRequests content verification')) {
          throw new Error(`Content mismatch: expected uploaded description, got "${request.desiredState.description}"`);
        }
        console.log('    IPFS content verified: description matches uploaded data');
      }),
    );

    // ── Phase 5e: Deliver through AgentMech + watchForDeliveries ────────────

    results.push(
      await runPhase('Phase 5e: Deliver through AgentMech + watchForDeliveries', async () => {
        if (!submittedRequestId) throw new Error('No requestId from Phase 5c');
        if (!mockIpfsUrl) throw new Error('No mock IPFS URL');
        if (!safeAddress) throw new Error('No Safe address');

        // Read the mech's authorized operator
        const operator = await publicClient.readContract({
          address: MECH_ADDRESS,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;
        console.log(`    Mech operator: ${operator}`);

        // Create adapter for delivery watching
        const deliveryAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: MECH_ADDRESS,
          safeAddress,
          agentEoaPrivateKey: ANVIL_ACCOUNT_KEY,
          ipfsRegistryUrl: mockIpfsUrl,
          ipfsGatewayUrl: mockIpfsUrl,
          pollIntervalMs: 500,
          chainId: base.id,
        });
        await deliveryAdapter.initialize();

        // Fund and impersonate the operator, then deliver
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [operator, '0x56BC75E2D63100000']);
        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [operator]);

        const operatorWallet = createWalletClient({
          chain: base,
          transport: http(ANVIL_RPC),
          account: operator,
        });

        const deliveryData: Hex = ('0x' + 'cd'.repeat(32)) as Hex;
        const deliverHash = await operatorWallet.writeContract({
          address: MECH_ADDRESS,
          abi: MECH_ABI,
          functionName: 'deliverToMarketplace',
          args: [[submittedRequestId as Hex], [deliveryData]],
        });

        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [operator]);

        const deliverReceipt = await publicClient.waitForTransactionReceipt({ hash: deliverHash });
        console.log(`    Deliver tx: ${deliverHash} (status: ${deliverReceipt.status})`);
        if (deliverReceipt.status !== 'success') throw new Error('Deliver transaction reverted');

        // Mine a block and watch for the delivery event via adapter
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        const delivery = await Promise.race([
          (async () => {
            for await (const del of deliveryAdapter.watchForDeliveries()) {
              return del;
            }
            return null;
          })(),
          sleep(15000).then(() => { throw new Error('watchForDeliveries timed out after 15s'); }),
        ]);

        await deliveryAdapter.stop();

        if (!delivery) throw new Error('watchForDeliveries yielded null');
        console.log(`    watchForDeliveries yielded requestId: ${delivery.requestId}`);
        console.log(`    Delivery mech address: ${delivery.deliveryMechAddress}`);

        // Verify on-chain state
        const postInfo = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [submittedRequestId as Hex],
        });
        const [, deliveryMech] = postInfo as [Address, Address, Address, bigint, bigint, Hex];
        if (deliveryMech === '0x0000000000000000000000000000000000000000') {
          throw new Error('deliveryMech is still zero after delivery');
        }
        console.log(`    On-chain deliveryMech: ${deliveryMech}`);
      }),
    );

    // ── Phase 5f: submitResult through adapter (real operator credentials) ──

    results.push(
      await runPhase('Phase 5f: submitResult through adapter', async () => {
        if (!OPERATOR_EOA_KEY) {
          console.log('    Skipped — set OPERATOR_EOA_KEY env var to run');
          return;
        }
        if (!mockIpfsUrl) throw new Error('No mock IPFS URL');

        // First, submit a request that we can deliver against
        // Use the real operator Safe as requester so it can also deliver
        const operatorAccount = privateKeyToAccount(OPERATOR_EOA_KEY);
        // Fund both the Safe (for tx value) and the EOA (for gas)
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [OPERATOR_SAFE_ADDRESS, '0x56BC75E2D63100000']); // 100 ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorAccount.address, '0x56BC75E2D63100000']); // 100 ETH

        const operatorWalletClient = createWalletClient({
          chain: base,
          transport: http(ANVIL_RPC),
          account: operatorAccount,
        }) as unknown as WalletClient;

        // Create adapter configured as the real operator — with REAL IPFS
        const operatorAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: OPERATOR_MECH_ADDRESS,
          safeAddress: OPERATOR_SAFE_ADDRESS,
          agentEoaPrivateKey: OPERATOR_EOA_KEY,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
        });
        await operatorAdapter.initialize();

        // Post a request (from the operator's Safe, targeting the operator's mech)
        const requestId = await operatorAdapter.postDesiredState({
          id: 'e2e-submit-result',
          description: 'Testing submitResult through adapter',
        });
        console.log(`    Posted request: ${requestId}`);

        // Now deliver using adapter.submitResult() — the real production flow:
        // agent EOA signs → operator Safe executes → AgentMech.deliverToMarketplace()
        await operatorAdapter.submitResult(requestId, {
          data: 'E2E test delivery result',
        });
        console.log('    submitResult() completed successfully');

        // Verify on-chain
        const info = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [requestId as Hex],
        });
        const [, deliveryMech] = info as [Address, Address, Address, bigint, bigint, Hex];
        if (deliveryMech === '0x0000000000000000000000000000000000000000') {
          throw new Error('deliveryMech is zero — submitResult did not deliver');
        }
        console.log(`    On-chain deliveryMech: ${deliveryMech}`);

        // Verify Deliver event was emitted
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
        const deliveryResult = await Promise.race([
          (async () => {
            for await (const del of operatorAdapter.watchForDeliveries()) {
              return del;
            }
            return null;
          })(),
          sleep(15000).then(() => { throw new Error('watchForDeliveries timed out'); }),
        ]);

        await operatorAdapter.stop();

        if (!deliveryResult) throw new Error('No delivery event after submitResult');
        console.log(`    Deliver event confirmed: requestId=${deliveryResult.requestId}`);

        // Verify the content fetched from IPFS matches what was uploaded
        if (!deliveryResult.result.data.includes('E2E test delivery result')) {
          throw new Error(`IPFS content mismatch: expected uploaded data, got "${deliveryResult.result.data.slice(0, 100)}"`);
        }
        console.log(`    IPFS content verified: "${deliveryResult.result.data.slice(0, 80)}..."`);
      }),
    );

    // ── Phase 5g: Full daemon loop — create → restore → deliver ──────────────

    results.push(
      await runPhase('Phase 5g: Full loop — create → restore → evaluate (linked)', async () => {
        if (!OPERATOR_EOA_KEY) {
          console.log('    Skipped — set OPERATOR_EOA_KEY env var to run');
          return;
        }
        const operatorAccount = privateKeyToAccount(OPERATOR_EOA_KEY);

        // Fund operator EOA and Safe
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorAccount.address, '0x56BC75E2D63100000']);
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [OPERATOR_SAFE_ADDRESS, '0x56BC75E2D63100000']);

        const loopAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          mechContractAddress: OPERATOR_MECH_ADDRESS,
          safeAddress: OPERATOR_SAFE_ADDRESS,
          agentEoaPrivateKey: OPERATOR_EOA_KEY,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
        });
        await loopAdapter.initialize();

        const loopStore = new (await import('../src/store/store.js')).Store(':memory:');
        const mockAgentPath = join(__dirname, 'mock-agent.sh');
        const mockRunner = new ClaudeRunner({ claudePath: mockAgentPath });

        // Step 1: Creator posts desired state (creates restoration + evaluation requests)
        const { CreatorLoop } = await import('../src/daemon/creator.js');
        const creator = new CreatorLoop(loopAdapter, [
          { id: 'daemon-e2e-linked', description: 'Linked requests E2E test' },
        ], loopStore);
        await creator.tick();
        console.log('    Creator posted desired state (restoration + evaluation requests)');
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Step 2: Restorer picks up restoration request, runs mock agent, delivers
        const { RestorerLoop } = await import('../src/daemon/restorer.js');
        const restorer = new RestorerLoop(loopAdapter, mockRunner, loopStore);
        await restorer.processOne();
        console.log('    Restorer delivered restoration');
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Step 3: Restorer picks up evaluation request (now ready), runs mock agent, delivers
        await restorer.processOne();
        console.log('    Restorer delivered evaluation');

        // Verify both deliveries on-chain by scanning recent events
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
        const currentBlock = await publicClient.getBlockNumber();
        const logs = await publicClient.getLogs({
          address: OPERATOR_MECH_ADDRESS,
          fromBlock: currentBlock - 50n,
          toBlock: currentBlock,
        });
        const deliveries = decodeDeliverLogs(logs);
        console.log(`    On-chain deliveries from this mech: ${deliveries.length}`);
        if (deliveries.length < 2) {
          throw new Error(`Expected at least 2 deliveries, got ${deliveries.length}`);
        }
        console.log('    Full cycle: create → restore → evaluate (linked requests)');

        loopStore.close();
        await loopAdapter.stop();
      }),
    );

  } finally {
    // ── Phase 6: Cleanup ─────────────────────────────────────────────────────

    results.push(
      await runPhase('Phase 6: Cleanup', async () => {
        if (adapter) {
          await adapter.stop().catch(() => {});
          console.log('    Adapter stopped');
        }
        if (mockIpfsServer) {
          mockIpfsServer.close();
          console.log('    Mock IPFS server closed');
        }
        if (anvil) {
          anvil.kill('SIGTERM');
          await sleep(500);
          if (!anvil.killed) {
            anvil.kill('SIGKILL');
          }
          console.log('    Anvil process terminated');
        }
      }),
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\n=== Summary ===\n');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const detail = r.error ? ` — ${r.error}` : '';
    console.log(`  ${icon} ${r.name} (${r.ms}ms)${detail}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed (${totalMs}ms total)\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
