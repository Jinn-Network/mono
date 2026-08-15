/**
 * Read-only Hyperliquid public API client.
 *
 * All endpoints are POST /info with a JSON body. No authentication required.
 * This client is intentionally read-only — write paths are out of scope.
 */

import type {
  HlAllMidsResponse,
  HlClearinghouseState,
  HlMetaResponse,
  HlPeriodData,
  HlPortfolioPeriod,
  HlPortfolioResponse,
  HlSpotClearinghouseState,
  HlUserFills,
  HlUserFillsByTimeResult,
} from './types.js';

export const HL_MAINNET_BASE_URL = 'https://api.hyperliquid.xyz';
export const HL_TESTNET_BASE_URL = 'https://api.hyperliquid-testnet.xyz';

export class HyperliquidClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(baseUrl: string = HL_MAINNET_BASE_URL, timeoutMs: number = 15_000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/info`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const excerpt = await res.text().then((t) => t.slice(0, 200));
        throw new Error(
          `Hyperliquid API error: HTTP ${res.status} ${res.statusText} — ${excerpt}`,
        );
      }

      try {
        return (await res.json()) as T;
      } catch (err) {
        throw new Error(
          `Hyperliquid API error: could not parse JSON response from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Hyperliquid API timeout after ${this.timeoutMs}ms calling ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  // -------------------------------------------------------------------------
  // Public endpoints
  // -------------------------------------------------------------------------

  /**
   * Returns the current clearinghouse (margin) state for a user.
   * This reflects the LIVE state — there is no historical point-in-time lookup.
   */
  async clearinghouseState(user: string): Promise<HlClearinghouseState> {
    return this.post<HlClearinghouseState>({ type: 'clearinghouseState', user });
  }

  /**
   * Returns the current spot (non-perps) clearinghouse state for a user.
   * Includes USDC and other spot token balances.
   */
  async spotClearinghouseState(user: string): Promise<HlSpotClearinghouseState> {
    return this.post<HlSpotClearinghouseState>({ type: 'spotClearinghouseState', user });
  }

  /**
   * Returns recent fills for a user, in descending time order.
   */
  async userFills(user: string): Promise<HlUserFills> {
    return this.post<HlUserFills>({ type: 'userFills', user });
  }

  /**
   * Returns fills for a user in ascending time order, with optional pagination.
   *
   * The HL API silently clamps `startTime` to its retention horizon (typically
   * ~30 days). When clamping occurs the first fill's `.time` will be greater
   * than the requested `startTime`. This method detects that and sets
   * `result.startTimeClamped = true`.
   *
   * @param user           Ethereum address of the account.
   * @param startTime      Start of the window in epoch milliseconds.
   * @param endTime        Optional end of the window in epoch milliseconds.
   * @param aggregateByTime Passed directly to the API (default false).
   */
  async userFillsByTime(
    user: string,
    startTime: number,
    endTime?: number,
    aggregateByTime: boolean = false,
  ): Promise<HlUserFillsByTimeResult> {
    const body: Record<string, unknown> = {
      type: 'userFillsByTime',
      user,
      startTime,
      aggregateByTime,
    };
    if (endTime !== undefined) {
      body['endTime'] = endTime;
    }

    const fills = await this.post<HlUserFills>(body);

    // Clamp detection: if the first fill's time is strictly greater than the
    // requested startTime, HL quietly moved the window forward to its retention
    // horizon. An empty result is NOT treated as clamped — we can't tell.
    const startTimeClamped =
      fills.length > 0 && fills[0] !== undefined && fills[0].time > startTime;

    return { fills, startTimeClamped };
  }

  /**
   * Returns historical account-value snapshots (~140-minute grid) for a user.
   *
   * The response is an array of [periodName, periodData] tuples where period
   * is one of "day", "week", "month", "allTime".
   */
  async portfolio(user: string): Promise<HlPortfolioResponse> {
    return this.post<HlPortfolioResponse>({ type: 'portfolio', user });
  }

  /**
   * Fetches the portfolio response and extracts a specific period bucket.
   * Returns null if the period is not present in the response.
   */
  async portfolioPeriod(user: string, period: HlPortfolioPeriod): Promise<HlPeriodData | null> {
    const response = await this.portfolio(user);
    const entry = response.find(([name]) => name === period);
    return entry ? entry[1] : null;
  }

  /**
   * Returns the universe of perpetual markets (metadata).
   */
  async meta(): Promise<HlMetaResponse> {
    return this.post<HlMetaResponse>({ type: 'meta' });
  }

  /**
   * Returns current mid prices for all assets.
   */
  async allMids(): Promise<HlAllMidsResponse> {
    return this.post<HlAllMidsResponse>({ type: 'allMids' });
  }
}
