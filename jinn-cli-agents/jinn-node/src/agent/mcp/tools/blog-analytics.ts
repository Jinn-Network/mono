/**
 * Blog Analytics MCP Tools
 *
 * Provides tools for AI agents to query analytics data from Umami,
 * enabling data-driven content strategy decisions.
 *
 * Environment variables:
 * - JINN_JOB_UMAMI_WEBSITE_ID: Default Umami website ID (fallback when websiteId arg omitted)
 *
 * Credential bridge:
 * - Provider: umami
 * - Static config: UMAMI_HOST
 */

import { z } from 'zod';
import { getCredentialBundle } from '../../shared/credential-client.js';

// ============================================
// Type Definitions
// ============================================

interface StatsValue {
  value: number;
  prev: number;
}

interface Stats {
  pageviews: StatsValue;
  visitors: StatsValue;
  visits: StatsValue;
  bounces: StatsValue;
  totaltime: StatsValue;
}

interface PageMetric {
  x: string; // URL path or metric value
  y: number; // Count
}

interface TimeSeriesPoint {
  x: string; // Date string
  y: number;
}

interface PageviewsData {
  pageviews: TimeSeriesPoint[];
  sessions: TimeSeriesPoint[];
}

type MetricType = 'url' | 'referrer' | 'browser' | 'os' | 'device' | 'country' | 'event';

// ============================================
// Schema Definitions
// ============================================

const websiteIdParam = z.string().optional().describe('Umami website ID. If omitted, uses JINN_JOB_UMAMI_WEBSITE_ID env var.');

export const blogGetStatsParams = z.object({
  websiteId: websiteIdParam,
  days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
});

export const blogGetStatsSchema = {
  description: `Get overall website statistics for the blog.

Returns pageviews, visitors, visits, bounces, and total time with
current and previous period values for trend comparison.

REQUIRED: credential bridge provider "umami"
Pass websiteId per call for multi-site queries, or set JINN_JOB_UMAMI_WEBSITE_ID as default.

Returns: {
  stats: { pageviews, visitors, visits, bounces, totaltime },
  period: { start, end }
}`,
  inputSchema: blogGetStatsParams.shape,
};

export const blogGetTopPagesParams = z.object({
  websiteId: websiteIdParam,
  days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
  limit: z.number().optional().default(10).describe('Maximum number of pages to return (default: 10)'),
});

export const blogGetTopPagesSchema = {
  description: `Get the top performing pages on the blog by view count.

Use this to identify popular content and understand what resonates with readers.
Pages are sorted by view count in descending order.

REQUIRED: credential bridge provider "umami"
Pass websiteId per call for multi-site queries, or set JINN_JOB_UMAMI_WEBSITE_ID as default.

Returns: { pages: [{ url, views }], count, period }`,
  inputSchema: blogGetTopPagesParams.shape,
};

export const blogGetReferrersParams = z.object({
  websiteId: websiteIdParam,
  days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
  limit: z.number().optional().default(10).describe('Maximum referrers to return (default: 10)'),
});

export const blogGetReferrersSchema = {
  description: `Get traffic referrer sources for the blog.

Shows where readers are coming from (search engines, social media, direct links, etc.).
Use this to understand traffic sources and optimize distribution strategy.

REQUIRED: credential bridge provider "umami"
Pass websiteId per call for multi-site queries, or set JINN_JOB_UMAMI_WEBSITE_ID as default.

Returns: { referrers: [{ source, visits }], count, period }`,
  inputSchema: blogGetReferrersParams.shape,
};

export const blogGetMetricsParams = z.object({
  websiteId: websiteIdParam,
  type: z.enum(['path', 'referrer', 'browser', 'os', 'device', 'country', 'event'])
    .describe('Type of metric to retrieve'),
  days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
  limit: z.number().optional().default(20).describe('Maximum results to return (default: 20)'),
});

export const blogGetMetricsSchema = {
  description: `Get specific metrics by type for the blog.

Types available:
- url: Page views by URL
- referrer: Traffic sources
- browser: Browser distribution
- os: Operating system distribution
- device: Device type (desktop, mobile, tablet)
- country: Geographic distribution
- event: Custom events

REQUIRED: credential bridge provider "umami"
Pass websiteId per call for multi-site queries, or set JINN_JOB_UMAMI_WEBSITE_ID as default.

Returns: { metrics: [{ name, count }], type, count, period }`,
  inputSchema: blogGetMetricsParams.shape,
};

export const blogGetPageviewsParams = z.object({
  websiteId: websiteIdParam,
  days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
  unit: z.enum(['day', 'hour']).optional().default('day').describe('Time unit for data points'),
});

export const blogGetPageviewsSchema = {
  description: `Get pageview time series data for charting.

Returns daily or hourly pageviews and sessions over the specified period.
Useful for visualizing traffic trends and identifying patterns.

REQUIRED: credential bridge provider "umami"
Pass websiteId per call for multi-site queries, or set JINN_JOB_UMAMI_WEBSITE_ID as default.

Returns: { pageviews: [{ date, count }], sessions: [{ date, count }], period }`,
  inputSchema: blogGetPageviewsParams.shape,
};

export const blogGetPerformanceSummaryParams = z.object({
  websiteId: websiteIdParam,
  days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
});

export const blogGetPerformanceSummarySchema = {
  description: `Get a comprehensive performance summary for AI analysis.

Combines stats, top pages, and referrers into a single response.
This is the recommended tool for understanding overall blog performance
and making content strategy decisions.

ANALYSIS TIPS:
- Compare value vs prev to see growth/decline trends
- Look at bounce rate (bounces/visits) for engagement quality
- Cross-reference top pages with referrers to understand traffic sources
- Use this data to inform future content topics and distribution

REQUIRED: credential bridge provider "umami"
Pass websiteId per call for multi-site queries, or set JINN_JOB_UMAMI_WEBSITE_ID as default.

Returns: { stats, topPages, referrers, period, insights }`,
  inputSchema: blogGetPerformanceSummaryParams.shape,
};

// ============================================
// Helper Functions
// ============================================

interface UmamiConfig {
  host: string;
  websiteId: string;
  token: string;
}

async function getUmamiConfig(websiteIdOverride?: string): Promise<UmamiConfig> {
  const bundle = await getCredentialBundle('umami');
  const host = bundle.config.UMAMI_HOST;
  const websiteId = websiteIdOverride || process.env.JINN_JOB_UMAMI_WEBSITE_ID;

  const missing: string[] = [];
  if (!host) missing.push('credential bridge config UMAMI_HOST');
  if (!websiteId) missing.push('websiteId argument or JINN_JOB_UMAMI_WEBSITE_ID env var');

  if (missing.length > 0) {
    throw new Error(`Missing required Umami configuration: ${missing.join(', ')}`);
  }

  return {
    host: host!.replace(/\/$/, ''),
    websiteId: websiteId!,
    token: bundle.access_token,
  };
}

async function umamiApiCall<T>(
  endpoint: string,
  config: UmamiConfig,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`${config.host}/api/websites/${config.websiteId}${endpoint}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Umami API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      return response.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError!;
}

function getTimeRange(days: number): { startAt: Date; endAt: Date } {
  const endAt = new Date();
  const startAt = new Date();
  startAt.setDate(startAt.getDate() - days);
  return { startAt, endAt };
}

function getTimeParams(startAt: Date, endAt: Date): Record<string, string> {
  return {
    startAt: startAt.getTime().toString(),
    endAt: endAt.getTime().toString(),
  };
}

function formatPeriod(startAt: Date, endAt: Date): { start: string; end: string } {
  return {
    start: startAt.toISOString().split('T')[0],
    end: endAt.toISOString().split('T')[0],
  };
}

/**
 * Generate insights from stats comparison
 */
function generateInsights(stats: Stats): string[] {
  const insights: string[] = [];

  // Pageview trend
  const pvChange = stats.pageviews.prev > 0
    ? ((stats.pageviews.value - stats.pageviews.prev) / stats.pageviews.prev * 100).toFixed(1)
    : 'N/A';
  if (pvChange !== 'N/A') {
    const direction = parseFloat(pvChange) > 0 ? 'increased' : 'decreased';
    insights.push(`Pageviews ${direction} by ${Math.abs(parseFloat(pvChange))}% compared to previous period`);
  }

  // Visitor trend
  const visitorChange = stats.visitors.prev > 0
    ? ((stats.visitors.value - stats.visitors.prev) / stats.visitors.prev * 100).toFixed(1)
    : 'N/A';
  if (visitorChange !== 'N/A') {
    const direction = parseFloat(visitorChange) > 0 ? 'grew' : 'declined';
    insights.push(`Unique visitors ${direction} by ${Math.abs(parseFloat(visitorChange))}%`);
  }

  // Bounce rate
  const bounceRate = stats.visits.value > 0
    ? ((stats.bounces.value / stats.visits.value) * 100).toFixed(1)
    : '0';
  if (parseFloat(bounceRate) > 70) {
    insights.push(`High bounce rate (${bounceRate}%) - consider improving content engagement`);
  } else if (parseFloat(bounceRate) < 40) {
    insights.push(`Excellent bounce rate (${bounceRate}%) - readers are engaging well`);
  }

  // Average time
  const avgTime = stats.visits.value > 0
    ? Math.round(stats.totaltime.value / stats.visits.value / 1000)
    : 0;
  if (avgTime > 180) {
    insights.push(`Strong average session duration (${avgTime}s) - content is holding attention`);
  } else if (avgTime < 30) {
    insights.push(`Short average session (${avgTime}s) - may need more engaging content`);
  }

  return insights;
}

// ============================================
// Tool Implementations
// ============================================

export async function blogGetStats(args: unknown) {
  try {
    const parsed = blogGetStatsParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const config = await getUmamiConfig(parsed.data.websiteId);
    const { days } = parsed.data;
    const { startAt, endAt } = getTimeRange(days);

    const stats = await umamiApiCall<Stats>('/stats', config, getTimeParams(startAt, endAt));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            stats,
            period: formatPeriod(startAt, endAt),
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes('Credential bridge') || message.includes('STATIC_PROVIDER_ERROR')
      ? 'CREDENTIAL_ERROR'
      : 'EXECUTION_ERROR';
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code, message },
        }),
      }],
    };
  }
}

export async function blogGetTopPages(args: unknown) {
  try {
    const parsed = blogGetTopPagesParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const config = await getUmamiConfig(parsed.data.websiteId);
    const { days, limit } = parsed.data;
    const { startAt, endAt } = getTimeRange(days);

    const data = await umamiApiCall<PageMetric[]>('/metrics', config, {
      ...getTimeParams(startAt, endAt),
      type: 'path',
    });

    const pages = data.slice(0, limit).map((item) => ({
      url: item.x,
      views: item.y,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            pages,
            count: pages.length,
            period: formatPeriod(startAt, endAt),
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogGetReferrers(args: unknown) {
  try {
    const parsed = blogGetReferrersParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const config = await getUmamiConfig(parsed.data.websiteId);
    const { days, limit } = parsed.data;
    const { startAt, endAt } = getTimeRange(days);

    const data = await umamiApiCall<PageMetric[]>('/metrics', config, {
      ...getTimeParams(startAt, endAt),
      type: 'referrer',
    });

    const referrers = data.slice(0, limit).map((item) => ({
      source: item.x || '(direct)',
      visits: item.y,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            referrers,
            count: referrers.length,
            period: formatPeriod(startAt, endAt),
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogGetMetrics(args: unknown) {
  try {
    const parsed = blogGetMetricsParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const config = await getUmamiConfig(parsed.data.websiteId);
    const { type, days, limit } = parsed.data;
    const { startAt, endAt } = getTimeRange(days);

    const data = await umamiApiCall<PageMetric[]>('/metrics', config, {
      ...getTimeParams(startAt, endAt),
      type,
    });

    const metrics = data.slice(0, limit).map((item) => ({
      name: item.x || '(unknown)',
      count: item.y,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            metrics,
            type,
            count: metrics.length,
            period: formatPeriod(startAt, endAt),
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogGetPageviews(args: unknown) {
  try {
    const parsed = blogGetPageviewsParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const config = await getUmamiConfig(parsed.data.websiteId);
    const { days, unit } = parsed.data;
    const { startAt, endAt } = getTimeRange(days);

    const data = await umamiApiCall<PageviewsData>('/pageviews', config, {
      ...getTimeParams(startAt, endAt),
      unit,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            pageviews: data.pageviews.map((p) => ({ date: p.x, count: p.y })),
            sessions: data.sessions.map((s) => ({ date: s.x, count: s.y })),
            period: formatPeriod(startAt, endAt),
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}

export async function blogGetPerformanceSummary(args: unknown) {
  try {
    const parsed = blogGetPerformanceSummaryParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const config = await getUmamiConfig(parsed.data.websiteId);
    const { days } = parsed.data;
    const { startAt, endAt } = getTimeRange(days);
    const timeParams = getTimeParams(startAt, endAt);

    // Fetch all data in parallel
    const [stats, topPagesData, referrersData] = await Promise.all([
      umamiApiCall<Stats>('/stats', config, timeParams),
      umamiApiCall<PageMetric[]>('/metrics', config, { ...timeParams, type: 'path' }),
      umamiApiCall<PageMetric[]>('/metrics', config, { ...timeParams, type: 'referrer' }),
    ]);

    const topPages = topPagesData.slice(0, 10).map((item) => ({
      url: item.x,
      views: item.y,
    }));

    const referrers = referrersData.slice(0, 10).map((item) => ({
      source: item.x || '(direct)',
      visits: item.y,
    }));

    const insights = generateInsights(stats);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: {
            stats,
            topPages,
            referrers,
            period: formatPeriod(startAt, endAt),
            insights,
          },
          meta: { ok: true },
        }),
      }],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message },
        }),
      }],
    };
  }
}
