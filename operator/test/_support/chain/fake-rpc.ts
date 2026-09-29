/**
 * In-process JSON-RPC boundary fake for the fleet bootstrap tests.
 *
 * A *boundary* fake, not an internal mock: `docs/runbooks/testing.md` names
 * the chain RPC as a boundary and sanctions a fake there. Pointing a real
 * `createJinnPublicClient` / `createJinnWalletClient` at this server means the
 * real `viemSendTransactionWithRetry`, `waitForTransactionReceiptWithRetry`
 * and `waitForNativeBalanceAtLeast` all execute, so an ordering assertion
 * falls out of the server's own method log rather than out of which internal
 * helper the test chose to spy. `spawnAnvilFork` is unusable for this: the
 * anvil-spawning suites are excluded from the default `yarn test` run.
 *
 * Chain id is Base Sepolia (84532), so every consumer builds its bootstrapper
 * or `StepContext` with `chain: 'base-sepolia'`.
 *
 * Two constraints a caller's fixtures must respect:
 * - `eth_blockNumber` must stay >= the receipt's `blockNumber`, or viem's
 *   `confirmations: 1` check never settles and the test hangs to the timeout.
 * - `eth_getTransactionReceipt` must carry `status: '0x1'` unless the test is
 *   deliberately exercising a reverted receipt.
 */
import { createServer, type Server } from 'node:http';
import { allocateAnvilPort } from './port-allocator.js';

/** Base Sepolia. Must match `jinnChain('base-sepolia').id`. */
export const FAKE_RPC_CHAIN_ID_HEX = '0x14a34';

const BLOCK_NUMBER_HEX = '0x10';

const BLOCK = {
  number: BLOCK_NUMBER_HEX,
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  nonce: '0x0000000000000000',
  sha3Uncles: `0x${'00'.repeat(32)}`,
  logsBloom: `0x${'00'.repeat(256)}`,
  transactionsRoot: `0x${'00'.repeat(32)}`,
  stateRoot: `0x${'00'.repeat(32)}`,
  receiptsRoot: `0x${'00'.repeat(32)}`,
  miner: `0x${'00'.repeat(20)}`,
  difficulty: '0x0',
  totalDifficulty: '0x0',
  extraData: '0x',
  size: '0x3e8',
  gasLimit: '0x1c9c380',
  gasUsed: '0x5208',
  baseFeePerGas: '0x3b9aca00',
  timestamp: '0x65000000',
  uncles: [],
  transactions: [],
};

function receiptFor(hash: string): Record<string, unknown> {
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: BLOCK.hash,
    blockNumber: BLOCK_NUMBER_HEX,
    from: `0x${'00'.repeat(20)}`,
    to: `0x${'00'.repeat(20)}`,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    contractAddress: null,
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    effectiveGasPrice: '0x3b9aca00',
    type: '0x2',
  };
}

export type FakeRpcHandler = (params: unknown[]) => unknown;

export interface FakeRpc {
  readonly url: string;
  /** Every JSON-RPC method served, in call order. */
  readonly methods: readonly string[];
  /** Params of every request served, positionally aligned with `methods`. */
  readonly calls: ReadonlyArray<{ method: string; params: unknown[] }>;
  /** Override or add a handler after start. */
  on(method: string, handler: FakeRpcHandler): void;
  close(): Promise<void>;
}

/**
 * Start the fake on a free loopback port. The default handler table is the
 * measured happy-path surface for `viemSendTransactionWithRetry` +
 * `waitForTransactionReceiptWithRetry` + `waitForNativeBalanceAtLeast`
 * against a real viem client — twelve methods, no more. If a caller needs a
 * thirteenth, that is the signal to stop growing the fake (see the plan's
 * §2a tripwire), not to add one here.
 */
export async function startFakeRpc(
  overrides: Record<string, FakeRpcHandler> = {},
): Promise<FakeRpc> {
  const methods: string[] = [];
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let sentCount = 0;

  const handlers = new Map<string, FakeRpcHandler>(Object.entries({
    eth_chainId: () => FAKE_RPC_CHAIN_ID_HEX,
    // Equal pending/latest keeps `recoverStuckNonceIfNeeded` from broadcasting
    // a spurious recovery transaction.
    eth_getTransactionCount: () => '0x0',
    eth_getBlockByNumber: () => BLOCK,
    eth_blockNumber: () => BLOCK_NUMBER_HEX,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x3b9aca00',
    eth_estimateGas: () => '0x5208',
    eth_sendRawTransaction: () => `0x${(++sentCount).toString(16).padStart(64, '0')}`,
    eth_getTransactionReceipt: (params: unknown[]) => receiptFor(String(params[0])),
    eth_getBalance: () => '0x0',
    eth_getCode: () => '0x60006000',
    eth_call: () => '0x',
  } as Record<string, FakeRpcHandler>));

  for (const [method, handler] of Object.entries(overrides)) {
    handlers.set(method, handler);
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: { id?: unknown; method?: string; params?: unknown[] };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const method = body.method ?? '';
      const params = body.params ?? [];
      methods.push(method);
      calls.push({ method, params });
      const handler = handlers.get(method);
      const payload = handler === undefined
        ? { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: `fake-rpc: unhandled ${method}` } }
        : { jsonrpc: '2.0', id: body.id ?? null, result: handler(params) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  const port = await allocateAnvilPort();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    calls,
    on(method, handler) { handlers.set(method, handler); },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
