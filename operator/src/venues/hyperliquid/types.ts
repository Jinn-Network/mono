/**
 * Hyperliquid public REST API response shapes.
 *
 * Only fields we actively use are typed precisely; complex/variable sub-objects
 * are left as `unknown` to avoid over-modelling a rapidly-changing API.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A fill record returned by userFills / userFillsByTime. */
export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: 'A' | 'B'; // Ask (sell) or Bid (buy)
  time: number; // epoch ms
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
  twapId: number | null;
}

// ---------------------------------------------------------------------------
// clearinghouseState
// ---------------------------------------------------------------------------

export interface HlMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HlClearinghouseState {
  marginSummary: HlMarginSummary;
  crossMarginSummary: HlMarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: unknown[];
  time: number;
}

// ---------------------------------------------------------------------------
// spotClearinghouseState
// ---------------------------------------------------------------------------

export interface HlSpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}

export interface HlSpotClearinghouseState {
  balances: HlSpotBalance[];
}

// ---------------------------------------------------------------------------
// userFills / userFillsByTime
// ---------------------------------------------------------------------------

export type HlUserFills = HlFill[];

// userFillsByTime result — includes clamp metadata added by the client.
export interface HlUserFillsByTimeResult {
  fills: HlFill[];
  /** True when the API silently clamped startTime to its retention horizon. */
  startTimeClamped: boolean;
}

// ---------------------------------------------------------------------------
// portfolio
// ---------------------------------------------------------------------------

/**
 * [timestamp_ms, value_str] tuple as returned in accountValueHistory.
 */
export type HlGridPoint = [number, string];

export interface HlPeriodData {
  accountValueHistory: HlGridPoint[];
  pnlHistory: HlGridPoint[];
  vlm: string;
}

export type HlPortfolioPeriod =
  | 'day'
  | 'week'
  | 'month'
  | 'allTime'
  | 'perpDay'
  | 'perpWeek'
  | 'perpMonth'
  | 'perpAllTime';

/**
 * portfolio response is an array of [periodName, periodData] tuples.
 * e.g. [["day", {...}], ["week", {...}], ...]
 */
export type HlPortfolioResponse = [string, HlPeriodData][];

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export interface HlPerpMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId: number;
  isDelisted?: boolean;
}

export interface HlMetaResponse {
  universe: HlPerpMeta[];
}

// ---------------------------------------------------------------------------
// allMids
// ---------------------------------------------------------------------------

/** Map from asset name to mid-price string. */
export type HlAllMidsResponse = Record<string, string>;
