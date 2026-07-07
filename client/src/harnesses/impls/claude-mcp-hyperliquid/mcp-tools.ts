/**
 * MCP tool definitions for claude-mcp-hyperliquid — §8.2.
 *
 * 5 read tools (public HL data, no auth):
 *   hl_clearinghouse_state, hl_user_fills, hl_meta, hl_all_mids, hl_portfolio
 *
 * 4 write tools (require API wallet; safety rails enforced here):
 *   hl_open_position, hl_close_position, hl_modify_position, hl_cancel_orders
 *
 * This module exports a factory function that takes dependencies and returns a
 * list of McpToolDefinition objects. The session orchestrator registers these
 * into the MCP server for each session.
 *
 * It also exports `startMcpServer(config)` — the entry point used by the
 * generated hl-server.mjs wrapper. This is THE live code path for write tools.
 *
 * Safety rails (§8.3) are enforced at the tool boundary before any network call.
 * Claude cannot bypass them through reasoning.
 */

import { z } from 'zod/v3';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HyperliquidClient } from '../../../venues/hyperliquid/client.js';
import { getUnifiedAccountValue } from '../../../venues/hyperliquid/account-value.js';
import type { SafetyConfig, RateLimitState } from './safety-rails.js';
import {
  checkRateLimit,
  createRateLimitState,
  validateOpenPosition,
  validateClosePosition,
  validateModifyPosition,
  DEFAULT_SAFETY_CONFIG,
} from './safety-rails.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Config passed into startMcpServer() — matches what _writeHlMcpServerScript
 * serialises as JSON and what the generated wrapper passes as process.argv[2].
 */
export interface McpServerConfig {
  hlBaseUrl: string;
  apiWalletPrivateKey: string;
  apiWalletAddress: string;
  masterAddress: string;
  safetyConfig?: Partial<SafetyConfig>;
}

export interface McpToolContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
}

export type McpToolHandler<TArgs> = (args: TArgs) => Promise<McpToolResult>;

export interface ToolDeps {
  hlClient: HyperliquidClient;
  /** HL exchange base URL (for write calls: POST /exchange) */
  hlBaseUrl: string;
  /** API wallet private key (0x-prefixed) for signing write operations */
  apiWalletPrivateKey: string;
  /** API wallet address */
  apiWalletAddress: string;
  /** Master account address (used as default for read tools) */
  masterAddress: string;
  /** Safety config (defaults to DEFAULT_SAFETY_CONFIG) */
  safetyConfig?: SafetyConfig;
  /** Rate-limit state (shared across all tools in a session) */
  rateLimitState: RateLimitState;
  /** Callback when a write op completes (for fill tracking) */
  onWriteOp?: (op: WriteOpRecord) => void;
}

export interface WriteOpRecord {
  /** Tool name */
  tool: string;
  /** Epoch ms when the op was submitted */
  submittedAt: number;
  /** Params sent to HL */
  params: Record<string, unknown>;
  /** HL response */
  response: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ok(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolErr(code: string, message: string): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: true, code, message }),
      },
    ],
  };
}

// ── Asset index cache ─────────────────────────────────────────────────────────

/**
 * Module-level cache for coin → asset index lookups (from HL meta endpoint).
 * Populated on first write-tool call per process.
 */
const assetIndexCache = new Map<string, number>();

/**
 * Resolve a coin name (e.g. "BTC") to its HL asset index via the meta endpoint.
 * Results are cached in-process so subsequent calls are free.
 *
 * Throws with a clear message if the coin is not in the universe.
 */
async function resolveAssetIndex(
  coin: string,
  hlClient: HyperliquidClient,
): Promise<number> {
  if (assetIndexCache.has(coin)) {
    return assetIndexCache.get(coin)!;
  }

  const meta = await hlClient.meta();
  meta.universe.forEach((asset, idx) => {
    assetIndexCache.set(asset.name, idx);
    assetSzDecimalsCache.set(asset.name, asset.szDecimals);
  });

  if (!assetIndexCache.has(coin)) {
    throw new Error(
      `Coin "${coin}" not found in HL universe. Available: ${meta.universe.map((u) => u.name).join(', ')}`,
    );
  }

  return assetIndexCache.get(coin)!;
}

/**
 * Per-asset size decimals (populated alongside assetIndexCache). HL's perps
 * require px to have ≤ (6 - szDecimals) decimals and sz to have ≤ szDecimals
 * decimals; violating either returns HTTP 422 or a "tick size" business error.
 */
const assetSzDecimalsCache = new Map<string, number>();

function getSzDecimals(coin: string): number {
  const d = assetSzDecimalsCache.get(coin);
  // Conservative default if cache is empty (caller should have hit resolveAssetIndex first).
  return d ?? 3;
}

/**
 * Format a price for HL perps: ≤5 significant figures AND ≤(6-szDecimals) decimals.
 * Strips trailing zeros so the string is canonical (HL's deserializer accepts
 * "123" and "123.45" but rejects "123.00").
 */
function formatPxForHl(px: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  // Round to 5 sig figs (HL rule), then clamp decimal places.
  const sigFigsRounded = parseFloat(px.toPrecision(5));
  const clamped = parseFloat(sigFigsRounded.toFixed(maxDecimals));
  // Number → string; JS omits trailing zeros for non-exponential magnitudes (0.01 to 1e21).
  return clamped.toString();
}

/**
 * Format a size for HL: ≤szDecimals decimal places. Keeps trailing zeros stripped
 * (HL's deserializer is lenient about size trailing zeros but canonical is cleaner).
 */
function formatSzForHl(size: number, szDecimals: number): string {
  return parseFloat(size.toFixed(Math.max(0, szDecimals))).toString();
}

// ── Open orders helper ────────────────────────────────────────────────────────

interface HlOpenOrder {
  coin: string;
  oid: number;
  /** The 'a' field = asset index in HL's internal numbering */
  asset?: number;
}

/** Timeout for fetchOpenOrders and other raw fetch calls (mirrors HyperliquidClient default) */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch open orders for an address from HL info endpoint.
 * Returns an array of open orders (may be empty).
 * Uses an AbortController-based timeout matching HyperliquidClient.post().
 */
async function fetchOpenOrders(
  baseUrl: string,
  address: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<HlOpenOrder[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'openOrders', user: address }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`HL open orders error: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
    }
    return resp.json() as Promise<HlOpenOrder[]>;
  } finally {
    clearTimeout(timer);
  }
}

// ── HL L1-action signing ───────────────────────────────────────────────────────

/**
 * Params for signing a Hyperliquid L1 action.
 */
export interface SignHlActionParams {
  /** 0x-prefixed private key */
  privateKey: string;
  /** The action object (will be msgpack-encoded) */
  action: Record<string, unknown>;
  /** Nonce (typically epoch ms) */
  nonce: number;
  /** Optional vault address (20 bytes hex, 0x-prefixed) */
  vaultAddress?: string | null;
  /** Optional expiry timestamp (epoch ms) */
  expiresAfter?: number | null;
  /** true = mainnet (source "a"), false = testnet (source "b") */
  isMainnet: boolean;
}

/**
 * Sign a Hyperliquid L1 action using the canonical algorithm from hyperliquid-python-sdk.
 *
 * Algorithm (mirrors sign_l1_action in hyperliquid/utils/signing.py):
 *
 * 1. action_hash = keccak256(
 *      msgpack(action)
 *      || uint64_be(nonce)
 *      || vault_flag_byte           // 0x01 if vaultAddress present, 0x00 otherwise
 *      || vault_address_20_bytes    // only if vaultAddress present
 *      || (0x01 || uint64_be(expiresAfter))  // only if expiresAfter present
 *    )
 *
 * 2. EIP-712 typed-data:
 *      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0...0 }
 *      primaryType: "Agent"
 *      types: Agent: [{name:"source",type:"string"},{name:"connectionId",type:"bytes32"}]
 *      message: { source: isMainnet ? "a" : "b", connectionId: action_hash }
 *
 * 3. Sign with viem signTypedData.
 *
 * 4. Decode 65-byte sig into { r, s, v }.
 */
export async function signHlAction(params: SignHlActionParams): Promise<{ r: string; s: string; v: number }> {
  const { privateKey, action, nonce, vaultAddress, expiresAfter, isMainnet } = params;
  const { signTypedData } = await import('viem/accounts');
  const { keccak256 } = await import('viem');

  // 1. Build the preimage buffer
  const actionBytes = msgpackEncode(action);

  // uint64 big-endian nonce (8 bytes)
  const nonceBuf = Buffer.alloc(8);
  // Use BigInt to handle the full uint64 range safely
  const nonceBig = BigInt(nonce);
  nonceBuf.writeBigUInt64BE(nonceBig);

  const parts: Uint8Array[] = [actionBytes, nonceBuf];

  if (vaultAddress && vaultAddress !== '0x0000000000000000000000000000000000000000') {
    // vault_flag_byte = 0x01 + 20-byte address
    parts.push(new Uint8Array([0x01]));
    const addrHex = vaultAddress.startsWith('0x') ? vaultAddress.slice(2) : vaultAddress;
    parts.push(Buffer.from(addrHex.padStart(40, '0'), 'hex'));
  } else {
    // vault_flag_byte = 0x00
    parts.push(new Uint8Array([0x00]));
  }

  if (expiresAfter != null) {
    // 0x01 || uint64_be(expiresAfter)
    const expiryBuf = Buffer.alloc(8);
    expiryBuf.writeBigUInt64BE(BigInt(expiresAfter));
    parts.push(new Uint8Array([0x01]));
    parts.push(expiryBuf);
  }

  // Concatenate all parts
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const preimage = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    preimage.set(p, offset);
    offset += p.length;
  }

  // keccak256 of preimage → connectionId (bytes32)
  const actionHash = keccak256(preimage);

  // 2. Build EIP-712 typed data
  // Note: chainId 1337 is HL's constant for both mainnet and testnet — NOT the EVM chain ID
  const domain = {
    chainId: 1337,
    name: 'Exchange',
    verifyingContract: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    version: '1',
  } as const;

  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  } as const;

  // source: "a" = mainnet, "b" = testnet
  const source = isMainnet ? 'a' : 'b';

  // 3. Sign
  const sig = await signTypedData({
    privateKey: privateKey as `0x${string}`,
    domain,
    types,
    primaryType: 'Agent',
    message: {
      source,
      connectionId: actionHash as `0x${string}`,
    },
  });

  // 4. Decode 65-byte signature: r (32 bytes) + s (32 bytes) + v (1 byte)
  // sig is 0x-prefixed hex, 132 hex chars = 66 bytes including 0x prefix
  const r = `0x${sig.slice(2, 66)}`;
  const s = `0x${sig.slice(66, 130)}`;
  const v = parseInt(sig.slice(130, 132), 16);

  return { r, s, v };
}

// ── HL exchange write helper ───────────────────────────────────────────────────

/**
 * POST to /exchange endpoint using canonical Hyperliquid L1-action signing.
 *
 * Signing follows hyperliquid-python-sdk's sign_l1_action:
 *   connectionId = keccak256(msgpack(action) || nonce_u64_be || vault_flag || [vault_addr] || [expiry_flag || expiry_u64_be])
 *   EIP-712 Agent{source, connectionId} with domain chainId=1337 (HL constant).
 *
 * @param isMainnet - true for mainnet (source "a"), false for testnet (source "b")
 */
async function hlExchangePost(
  baseUrl: string,
  privateKey: string,
  action: Record<string, unknown>,
  vaultAddress?: string,
  isMainnet: boolean = false,
): Promise<unknown> {
  const nonce = Date.now();

  const { r, s, v } = await signHlAction({
    privateKey,
    action,
    nonce,
    vaultAddress,
    expiresAfter: null,
    isMainnet,
  });

  const body: Record<string, unknown> = {
    action,
    nonce,
    signature: { r, s, v },
  };

  if (vaultAddress) {
    body['vaultAddress'] = vaultAddress;
  }

  const resp = await fetch(`${baseUrl}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HL exchange error: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
  }

  return resp.json();
}

// ── Status inspection helper ───────────────────────────────────────────────────

/**
 * Inspect response.response?.data?.statuses from an HL exchange response.
 * Throws if any status is an error object.
 * Success statuses: { filled: {...} }, { resting: {...} }, { cancelled: {...} }
 */
function checkResponseStatuses(response: unknown): void {
  const resp = response as Record<string, unknown> | null;
  if (!resp) return;

  const inner = resp['response'] as Record<string, unknown> | undefined;
  if (!inner) return;

  const data = inner['data'] as Record<string, unknown> | undefined;
  if (!data) return;

  const statuses = data['statuses'] as Array<unknown> | undefined;
  if (!Array.isArray(statuses)) return;

  const errors: string[] = [];
  for (const status of statuses) {
    const s = status as Record<string, unknown>;
    if (s && typeof s['error'] === 'string') {
      errors.push(s['error']);
    }
  }

  if (errors.length > 0) {
    throw new Error(`HL order error(s): ${errors.join('; ')}`);
  }
}

// ── Tool factory ───────────────────────────────────────────────────────────────

/**
 * Build tool handlers for registration with a McpServer.
 *
 * Returns an array of { name, description, schema, handler } objects.
 * The session orchestrator calls server.tool(name, description, schema, handler)
 * for each.
 */
export function buildHlTools(deps: ToolDeps): HlToolDefinition[] {
  const config = deps.safetyConfig ?? DEFAULT_SAFETY_CONFIG;
  const masterAddr = deps.masterAddress;

  // Detect mainnet vs testnet from the base URL
  const isMainnet = deps.hlBaseUrl.includes('hyperliquid.xyz') && !deps.hlBaseUrl.includes('testnet');

  // ── Read tools ─────────────────────────────────────────────────────────────

  const clearinghouseStateTool: HlToolDefinition = {
    name: 'hl_clearinghouse_state',
    description: 'Get the current clearinghouse (margin) state for an HL account. Returns account value, positions, margin summary.',
    schema: z.object({
      address: z.string().optional().describe('HL account address. Defaults to the master account.'),
    }),
    handler: async ({ address }) => {
      try {
        const result = await deps.hlClient.clearinghouseState(address ?? masterAddr);
        return ok(result);
      } catch (e) {
        return toolErr('HL_API_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const userFillsTool: HlToolDefinition = {
    name: 'hl_user_fills',
    description: 'Get recent fills for an HL account, in descending time order.',
    schema: z.object({
      address: z.string().optional().describe('HL account address. Defaults to the master account.'),
      startTime: z.number().optional().describe('Filter fills after this epoch ms timestamp.'),
      endTime: z.number().optional().describe('Filter fills before this epoch ms timestamp.'),
      limit: z.number().optional().describe('Maximum number of fills to return.'),
    }),
    handler: async ({ address, startTime, endTime, limit }) => {
      try {
        let fills;
        if (startTime !== undefined) {
          const result = await deps.hlClient.userFillsByTime(address ?? masterAddr, startTime, endTime);
          fills = result.fills;
        } else {
          fills = await deps.hlClient.userFills(address ?? masterAddr);
        }
        if (limit !== undefined) {
          fills = fills.slice(0, limit);
        }
        return ok(fills);
      } catch (e) {
        return toolErr('HL_API_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const metaTool: HlToolDefinition = {
    name: 'hl_meta',
    description: 'Get metadata for all HL perpetual markets (names, max leverage, size decimals).',
    schema: z.object({}),
    handler: async () => {
      try {
        const result = await deps.hlClient.meta();
        return ok(result);
      } catch (e) {
        return toolErr('HL_API_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const allMidsTool: HlToolDefinition = {
    name: 'hl_all_mids',
    description: 'Get current mid prices for all HL assets.',
    schema: z.object({}),
    handler: async () => {
      try {
        const result = await deps.hlClient.allMids();
        return ok(result);
      } catch (e) {
        return toolErr('HL_API_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const portfolioTool: HlToolDefinition = {
    name: 'hl_portfolio',
    description: 'Get historical portfolio data (account value history, PnL history) for an HL account.',
    schema: z.object({
      address: z.string().optional().describe('HL account address. Defaults to the master account.'),
    }),
    handler: async ({ address }) => {
      try {
        const result = await deps.hlClient.portfolio(address ?? masterAddr);
        return ok(result);
      } catch (e) {
        return toolErr('HL_API_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const accountUnifiedTool: HlToolDefinition = {
    name: 'hl_account_unified',
    description:
      'Preferred single-call account read. Returns unified equity (perps + spot USDC), ' +
      'perps-only account value, spot USDC, withdrawable, open positions, and open orders. ' +
      'Use this instead of hl_clearinghouse_state for decisions — the latter omits spot USDC ' +
      'and will mislead you when the master has been spot-funded (perps accountValue reads 0 ' +
      'but cross-margining still lets you trade).',
    schema: z.object({}),
    handler: async () => {
      try {
        const [unified, openOrders] = await Promise.all([
          getUnifiedAccountValue(deps.hlClient, masterAddr),
          fetchOpenOrders(deps.hlBaseUrl, masterAddr).catch(() => [] as HlOpenOrder[]),
        ]);
        // HL's assetPositions is typed as unknown[] upstream — each entry is
        // {position: {coin, szi, entryPx, unrealizedPnl, leverage: {...}, liquidationPx, marginUsed}}.
        // We pass the raw structure through so Claude sees the same shape as the
        // info endpoint returns; we also surface the summary fields separately.
        return ok({
          unifiedAccountValue: unified.accountValue,
          perpsAccountValue: unified.perpsAccountValue,
          spotUsdc: unified.spotUsdc,
          withdrawable: unified.clearinghouseState.withdrawable,
          positions: unified.clearinghouseState.assetPositions ?? [],
          openOrders,
        });
      } catch (e) {
        return toolErr('HL_API_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  // ── Write tools ────────────────────────────────────────────────────────────

  const openPositionTool: HlToolDefinition = {
    name: 'hl_open_position',
    description: 'Open a new perpetual position on HL. Safety rails enforced: max 25% of account per position, max 10x leverage, max 50 bps slippage.',
    schema: z.object({
      coin: z.string().describe('Asset name, e.g. "BTC"'),
      side: z.enum(['long', 'short']).describe('Position direction'),
      size: z.number().positive().describe('Size in base asset units'),
      leverage: z.number().positive().describe('Desired leverage (1-10)'),
      slippageBps: z.number().int().min(1).max(100).describe('Max slippage in basis points (1-50 enforced)'),
      tp: z.number().positive().optional().describe('Take-profit price in USD. REQUIRED unless bypassRiskRails=true. For a long: tp > entry; for a short: tp < entry.'),
      sl: z.number().positive().optional().describe('Stop-loss price in USD. REQUIRED unless bypassRiskRails=true. For a long: sl < entry; for a short: sl > entry.'),
      bypassRiskRails: z.boolean().optional().describe('Explicitly open without TP/SL. Use only for very short-lived scalps you intend to close this turn. Logged as a deliberate override.'),
    }),
    handler: async ({ coin, side, size, leverage, slippageBps, tp, sl, bypassRiskRails }) => {
      // Rate limit check
      const rlResult = checkRateLimit(deps.rateLimitState, config);
      if (!rlResult.ok) return toolErr(rlResult.code, rlResult.message);

      // Re-fetch account value immediately before the notional check to tighten
      // the TOCTOU window. Size against unified equity (perps margin + spot USDC)
      // so spot-funded accounts aren't gated to zero notional.
      let accountValue: number;
      let midPrice: number;
      try {
        const [unified, mids] = await Promise.all([
          getUnifiedAccountValue(deps.hlClient, masterAddr),
          deps.hlClient.allMids(),
        ]);
        accountValue = parseFloat(unified.accountValue);
        const mid = mids[coin];
        if (!mid) {
          return toolErr('UNKNOWN_COIN', `No mid price for coin "${coin}"`);
        }
        midPrice = parseFloat(mid);
      } catch (e) {
        return toolErr('HL_API_ERROR', `Failed to fetch market data: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Safety rails — percentage-based cap
      const validation = validateOpenPosition(
        { coin, side, size, leverage, midPrice, accountValue, slippageBps, tp, sl },
        config,
      );
      if (!validation.ok) return toolErr(validation.code, validation.message);

      // Hard absolute notional cap (finding #15): effective cap = min(pctCap, maxNotionalUsd)
      const notionalUsd = size * midPrice;
      const pctCap = config.maxPositionFraction * accountValue;
      const effectiveCap = config.maxNotionalUsd != null
        ? Math.min(pctCap, config.maxNotionalUsd)
        : pctCap;

      if (notionalUsd > effectiveCap) {
        return toolErr(
          'NOTIONAL_EXCEEDED',
          `Notional $${notionalUsd.toFixed(2)} exceeds hard cap $${effectiveCap.toFixed(2)} (min of ${(config.maxPositionFraction * 100).toFixed(0)}% of $${accountValue.toFixed(2)} = $${pctCap.toFixed(2)}${config.maxNotionalUsd != null ? ` and maxNotionalUsd=$${config.maxNotionalUsd}` : ''})`,
        );
      }

      // Resolve asset index from coin name
      let assetIdx: number;
      try {
        assetIdx = await resolveAssetIndex(coin, deps.hlClient);
      } catch (e) {
        return toolErr('UNKNOWN_COIN', e instanceof Error ? e.message : String(e));
      }

      // Build HL order action
      const isBuy = side === 'long';
      const slippage = slippageBps / 10000;
      const limitPx = isBuy
        ? midPrice * (1 + slippage)
        : midPrice * (1 - slippage);

      const szDec = getSzDecimals(coin);

      // Tool-level risk rail: both TP and SL must be set on every open, or the
      // caller must explicitly acknowledge they're opening bare via
      // bypassRiskRails=true. Prevents silent open-without-stop scenarios where
      // a Claude session could skip mentioning sl and leave tail risk unbounded
      // until its next ~30-min wakeup.
      const hasTp = tp !== undefined;
      const hasSl = sl !== undefined;
      if ((!hasTp || !hasSl) && !bypassRiskRails) {
        return toolErr(
          'TPSL_REQUIRED',
          `hl_open_position requires both tp (take-profit) and sl (stop-loss). ` +
          `Got tp=${tp}, sl=${sl}. For a ${side}: sl must be ${isBuy ? 'below' : 'above'} the mid ($${midPrice}) and tp must be ${isBuy ? 'above' : 'below'} it. ` +
          `If you intentionally want to open bare (e.g. a scalp you will close this same turn), pass bypassRiskRails=true.`,
        );
      }

      // Sanity: tp/sl on the correct sides of mid.
      if (hasTp) {
        if (isBuy && tp! <= midPrice) {
          return toolErr('TP_INVALID', `tp ${tp} must be > mid ${midPrice} for a long`);
        }
        if (!isBuy && tp! >= midPrice) {
          return toolErr('TP_INVALID', `tp ${tp} must be < mid ${midPrice} for a short`);
        }
      }
      if (hasSl) {
        if (isBuy && sl! >= midPrice) {
          return toolErr('SL_INVALID', `sl ${sl} must be < mid ${midPrice} for a long`);
        }
        if (!isBuy && sl! <= midPrice) {
          return toolErr('SL_INVALID', `sl ${sl} must be > mid ${midPrice} for a short`);
        }
      }

      // Parent position-opening order (IOC for slippage control).
      // HL's inline-trigger + positionTpsl grouping rejects with opaque
      // "Trigger order has unexpected type" errors on some testnets, so we
      // submit the parent first and then attach TP/SL as standalone
      // reduce-only trigger orders — simpler wire shape, easier to debug.
      const parentOrder: Record<string, unknown> = {
        a: assetIdx,
        b: isBuy,
        p: formatPxForHl(limitPx, szDec),
        s: formatSzForHl(size, szDec),
        r: false,
        t: { limit: { tif: 'Ioc' } },
      };

      const parentAction: Record<string, unknown> = {
        type: 'order',
        orders: [parentOrder],
        grouping: 'na',
      };

      const submittedAt = Date.now();
      let parentResponse: unknown;
      try {
        parentResponse = await hlExchangePost(deps.hlBaseUrl, deps.apiWalletPrivateKey, parentAction, undefined, isMainnet);
        checkResponseStatuses(parentResponse);
      } catch (e) {
        return toolErr('HL_EXCHANGE_ERROR', e instanceof Error ? e.message : String(e));
      }

      // If the operator chose to bypass the risk rails, we're done — just the parent.
      if (!hasTp && !hasSl) {
        const record: WriteOpRecord = { tool: 'hl_open_position', submittedAt, params: { coin, side, size, leverage, slippageBps, tp, sl, bypassRiskRails }, response: parentResponse };
        deps.onWriteOp?.(record);
        return ok({ submitted: true, response: parentResponse, submittedAt });
      }

      // Place TP/SL as standalone reduce-only trigger orders. HL binds them to
      // the resulting position because r=true + same asset + opposite side.
      const triggerOrders: Array<Record<string, unknown>> = [];
      if (hasTp) {
        triggerOrders.push({
          a: assetIdx,
          b: !isBuy,
          p: formatPxForHl(tp!, szDec),
          s: formatSzForHl(size, szDec),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: formatPxForHl(tp!, szDec), tpsl: 'tp' } },
        });
      }
      if (hasSl) {
        triggerOrders.push({
          a: assetIdx,
          b: !isBuy,
          p: formatPxForHl(sl!, szDec),
          s: formatSzForHl(size, szDec),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: formatPxForHl(sl!, szDec), tpsl: 'sl' } },
        });
      }

      let triggerResponse: unknown = null;
      let triggerError: string | null = null;
      if (triggerOrders.length > 0) {
        const triggerAction: Record<string, unknown> = {
          type: 'order',
          orders: triggerOrders,
          grouping: 'na',
        };
        try {
          triggerResponse = await hlExchangePost(deps.hlBaseUrl, deps.apiWalletPrivateKey, triggerAction, undefined, isMainnet);
          checkResponseStatuses(triggerResponse);
        } catch (e) {
          triggerError = e instanceof Error ? e.message : String(e);
        }
      }

      const record: WriteOpRecord = {
        tool: 'hl_open_position',
        submittedAt,
        params: { coin, side, size, leverage, slippageBps, tp, sl, bypassRiskRails },
        response: { parent: parentResponse, triggers: triggerResponse, triggerError },
      };
      deps.onWriteOp?.(record);

      if (triggerError) {
        // Parent filled but triggers failed — surface the failure so the caller
        // can decide to manually close or re-submit triggers. The position is
        // LIVE and UNPROTECTED at this point.
        return toolErr(
          'TRIGGERS_FAILED',
          `Parent order submitted successfully but TP/SL trigger orders failed: ${triggerError}. Position is open WITHOUT protection — close immediately via hl_close_position or retry triggers.`,
        );
      }

      return ok({ submitted: true, parent: parentResponse, triggers: triggerResponse, submittedAt });
    },
  };

  const closePositionTool: HlToolDefinition = {
    name: 'hl_close_position',
    description: 'Close an existing perpetual position on HL.',
    schema: z.object({
      coin: z.string().describe('Asset name, e.g. "BTC"'),
      sizeOrAll: z.union([z.number().positive(), z.literal('all')]).describe('Size to close, or "all" to close entire position'),
    }),
    handler: async ({ coin, sizeOrAll }) => {
      const rlResult = checkRateLimit(deps.rateLimitState, config);
      if (!rlResult.ok) return toolErr(rlResult.code, rlResult.message);

      const validation = validateClosePosition({ coin, sizeOrAll });
      if (!validation.ok) return toolErr(validation.code, validation.message);

      // Build close action — reduce-only order at market
      let mids: Record<string, string>;
      try {
        mids = await deps.hlClient.allMids();
      } catch (e) {
        return toolErr('HL_API_ERROR', `Failed to fetch mids: ${e instanceof Error ? e.message : String(e)}`);
      }

      const mid = mids[coin];
      if (!mid) {
        return toolErr('UNKNOWN_COIN', `No mid price for coin "${coin}"`);
      }

      const midPrice = parseFloat(mid);
      const slippage = config.maxSlippageBps / 10000;

      // Resolve asset index from coin name
      let assetIdx: number;
      try {
        assetIdx = await resolveAssetIndex(coin, deps.hlClient);
      } catch (e) {
        return toolErr('UNKNOWN_COIN', e instanceof Error ? e.message : String(e));
      }

      // For close, determine direction from existing position
      // We use reduce-only flag and set price conservatively
      const closeSz = sizeOrAll === 'all' ? '0' : formatSzForHl(sizeOrAll, getSzDecimals(coin));
      const action: Record<string, unknown> = {
        type: 'order',
        orders: [
          {
            a: assetIdx,
            b: false, // sell to close long (conservative; works for both if r=true)
            p: formatPxForHl(midPrice * (1 - slippage), getSzDecimals(coin)),
            s: closeSz,
            r: true, // reduce-only
            t: { limit: { tif: 'Ioc' } },
            // cloid omitted — see hl_open_position for rationale.
          },
        ],
        grouping: 'na',
      };

      const submittedAt = Date.now();
      try {
        const response = await hlExchangePost(deps.hlBaseUrl, deps.apiWalletPrivateKey, action, undefined, isMainnet);
        // Inspect per-order statuses — throw if any order reported an error
        checkResponseStatuses(response);
        const record: WriteOpRecord = { tool: 'hl_close_position', submittedAt, params: { coin, sizeOrAll }, response };
        deps.onWriteOp?.(record);
        return ok({ submitted: true, response, submittedAt });
      } catch (e) {
        return toolErr('HL_EXCHANGE_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const modifyPositionTool: HlToolDefinition = {
    name: 'hl_modify_position',
    description: 'Modify an existing position on HL: change leverage, or update TP/SL.',
    schema: z.object({
      coin: z.string().describe('Asset name, e.g. "BTC"'),
      leverage: z.number().optional().describe('New leverage (1-10)'),
      tp: z.number().optional().describe('New take-profit price in USD'),
      sl: z.number().optional().describe('New stop-loss price in USD'),
    }),
    handler: async ({ coin, leverage, tp, sl }) => {
      const rlResult = checkRateLimit(deps.rateLimitState, config);
      if (!rlResult.ok) return toolErr(rlResult.code, rlResult.message);

      const validation = validateModifyPosition({ coin, leverage, tp, sl }, config);
      if (!validation.ok) return toolErr(validation.code, validation.message);

      if (leverage === undefined && tp === undefined && sl === undefined) {
        return toolErr('NO_OP', 'No modification parameters provided (leverage, tp, or sl required)');
      }

      // TP/SL modification: the correct HL action shape for updating TP/SL on an
      // existing position is not yet confirmed. The 'updateLeverage' type used in v0
      // was incorrect. Returning a structured error until the correct action shape
      // is verified and implemented.
      // TODO: implement TP/SL update once correct HL action shape is confirmed.
      if (tp !== undefined || sl !== undefined) {
        return toolErr(
          'TPSL_NOT_IMPLEMENTED',
          'TP/SL modification is not yet implemented in v0 — the correct HL exchange action shape needs verification. Use hl_open_position with tp/sl params for new positions.',
        );
      }

      // Resolve asset index from coin name
      let assetIdx: number;
      try {
        assetIdx = await resolveAssetIndex(coin, deps.hlClient);
      } catch (e) {
        return toolErr('UNKNOWN_COIN', e instanceof Error ? e.message : String(e));
      }

      const submittedAt = Date.now();
      const ops: Array<{ action: Record<string, unknown>; label: string }> = [];

      if (leverage !== undefined) {
        ops.push({
          label: 'leverage',
          action: {
            type: 'leverage',
            asset: assetIdx,
            isCross: true,
            leverage,
          },
        });
      }

      try {
        const results: unknown[] = [];
        for (const op of ops) {
          const response = await hlExchangePost(deps.hlBaseUrl, deps.apiWalletPrivateKey, op.action, undefined, isMainnet);
          results.push({ label: op.label, response });
        }
        const record: WriteOpRecord = { tool: 'hl_modify_position', submittedAt, params: { coin, leverage, tp, sl }, response: results };
        deps.onWriteOp?.(record);
        return ok({ submitted: true, results, submittedAt });
      } catch (e) {
        return toolErr('HL_EXCHANGE_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  const cancelOrdersTool: HlToolDefinition = {
    name: 'hl_cancel_orders',
    description: 'Cancel open orders on HL. Optionally filter by coin.',
    schema: z.object({
      coin: z.string().optional().describe('Cancel orders only for this asset. If omitted, cancels all open orders.'),
    }),
    handler: async ({ coin }) => {
      const rlResult = checkRateLimit(deps.rateLimitState, config);
      if (!rlResult.ok) return toolErr(rlResult.code, rlResult.message);

      // Fetch open orders to get real order IDs
      let openOrders: HlOpenOrder[];
      try {
        openOrders = await fetchOpenOrders(deps.hlBaseUrl, masterAddr);
      } catch (e) {
        return toolErr('HL_API_ERROR', `Failed to fetch open orders: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Filter by coin if specified
      const ordersToCancel = coin
        ? openOrders.filter((o) => o.coin === coin)
        : openOrders;

      if (ordersToCancel.length === 0) {
        return ok({ submitted: false, cancelled: 0, message: coin ? `No open orders for ${coin}` : 'No open orders to cancel' });
      }

      // Resolve asset indices for all unique coins in the orders to cancel
      const coinAssetMap = new Map<string, number>();
      try {
        const meta = await deps.hlClient.meta();
        meta.universe.forEach((asset, idx) => {
          assetIndexCache.set(asset.name, idx);
          coinAssetMap.set(asset.name, idx);
        });
      } catch (e) {
        return toolErr('HL_API_ERROR', `Failed to fetch meta for asset index: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Build cancel entries: { a: assetIndex, o: orderId }
      const cancels: Array<{ a: number; o: number }> = [];
      for (const order of ordersToCancel) {
        const assetIdx = coinAssetMap.get(order.coin);
        if (assetIdx === undefined) {
          return toolErr('UNKNOWN_COIN', `No asset index for coin "${order.coin}" in open order`);
        }
        cancels.push({ a: assetIdx, o: order.oid });
      }

      const action: Record<string, unknown> = {
        type: 'cancel',
        cancels,
      };

      const submittedAt = Date.now();
      try {
        const response = await hlExchangePost(deps.hlBaseUrl, deps.apiWalletPrivateKey, action, undefined, isMainnet);
        // Inspect per-order statuses — throw if any cancel reported an error
        checkResponseStatuses(response);
        const record: WriteOpRecord = { tool: 'hl_cancel_orders', submittedAt, params: { coin, cancelCount: cancels.length }, response };
        deps.onWriteOp?.(record);
        return ok({ submitted: true, cancelled: cancels.length, response, submittedAt });
      } catch (e) {
        return toolErr('HL_EXCHANGE_ERROR', e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    accountUnifiedTool,
    clearinghouseStateTool,
    userFillsTool,
    metaTool,
    allMidsTool,
    portfolioTool,
    openPositionTool,
    closePositionTool,
    modifyPositionTool,
    cancelOrdersTool,
  ];
}

// ── Type definition ────────────────────────────────────────────────────────────

export interface HlToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  handler: McpToolHandler<z.infer<TSchema>>;
}

// ── MCP server entry point ─────────────────────────────────────────────────────

/**
 * Start the HL MCP server on stdio using the provided config.
 *
 * This is THE live code path for write tools in production. The generated
 * hl-server.mjs wrapper imports and calls this function — no stub signing,
 * no duplication, no split-brain.
 *
 * Stays alive until stdin closes (child process lifecycle).
 */
export async function startMcpServer(config: McpServerConfig): Promise<void> {
  const hlClient = new HyperliquidClient(config.hlBaseUrl);
  const rateLimitState = createRateLimitState();

  const safetyConfig = config.safetyConfig
    ? { ...DEFAULT_SAFETY_CONFIG, ...config.safetyConfig }
    : DEFAULT_SAFETY_CONFIG;

  const deps: ToolDeps = {
    hlClient,
    hlBaseUrl: config.hlBaseUrl,
    apiWalletPrivateKey: config.apiWalletPrivateKey,
    apiWalletAddress: config.apiWalletAddress,
    masterAddress: config.masterAddress,
    safetyConfig,
    rateLimitState,
  };

  const tools = buildHlTools(deps);

  const server = new McpServer({ name: 'jinn-hl', version: '1.0.0' });

  // Use 'any' cast for handler registration to avoid fighting MCP's CallToolResult
  // index-signature requirement. McpToolResult is structurally compatible at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerTool = server.tool.bind(server) as (...args: any[]) => void;

  for (const tool of tools) {
    // Extract the Zod shape from the z.object() schema for MCP server registration.
    // All HlToolDefinition schemas are z.object() instances.
    const schema = tool.schema as z.ZodObject<z.ZodRawShape>;
    const shape = schema.shape ?? {};

    registerTool(
      tool.name,
      tool.description,
      shape,
      async (args: z.infer<z.ZodObject<z.ZodRawShape>>) => tool.handler(args),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep alive until stdin closes
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
}
