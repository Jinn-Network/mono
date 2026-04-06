/**
 * Twitter/X Social MCP Tools
 *
 * Provides tools for AI agents to post tweets, get mentions, and reply.
 * OAuth tokens are fetched dynamically via the Credential Bridge —
 * the agent only needs its crypto private key, not Twitter API credentials.
 *
 * Environment variables:
 * - X402_GATEWAY_URL: URL of the x402-gateway credential bridge
 * - WORKER_PRIVATE_KEY: Agent's private key (for signing credential requests)
 */

import { z } from 'zod';
import { getCredential, clearCredentialCache } from '../../shared/credential-client.js';

// ============================================
// Schema Definitions
// ============================================

export const twitterPostTweetParams = z.object({
  text: z.string().min(1).max(280).describe('Tweet text (max 280 chars)'),
  reply_to: z.string().optional().describe('Tweet ID to reply to (optional)'),
  quote_tweet_id: z.string().optional().describe('Tweet ID to quote (optional)'),
});

export const twitterPostTweetSchema = {
  description: `Post a tweet to Twitter/X.

Text limit is 280 characters. Optionally reply to or quote another tweet.

Returns: { tweet_id, text, created_at } on success`,
  inputSchema: twitterPostTweetParams.shape,
};

export const twitterGetMentionsParams = z.object({
  since_id: z.string().optional().describe('Only return tweets newer than this ID (optional)'),
  max_results: z.number().min(5).max(100).optional().describe('Number of results (5-100, default 10)'),
});

export const twitterGetMentionsSchema = {
  description: `Get recent mentions of the authenticated Twitter/X account.

Returns a list of tweets mentioning this account, newest first.

Returns: { mentions: [{ id, text, author_username, created_at }] }`,
  inputSchema: twitterGetMentionsParams.shape,
};

export const twitterGetTimelineParams = z.object({
  max_results: z.number().min(5).max(100).optional().describe('Number of results (5-100, default 10)'),
});

export const twitterGetTimelineSchema = {
  description: `Get the authenticated account's recent tweets (timeline).

Returns: { tweets: [{ id, text, created_at, public_metrics }] }`,
  inputSchema: twitterGetTimelineParams.shape,
};

// ============================================
// Helper Functions
// ============================================

const TWITTER_API_BASE = 'https://api.twitter.com/2';

async function twitterApiCall<T>(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<T> {
  const accessToken = await getCredential('twitter');

  const url = new URL(`${TWITTER_API_BASE}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);

  if (response.status === 401) {
    // Token might be stale — clear cache and retry once
    clearCredentialCache('twitter');
    const freshToken = await getCredential('twitter');
    options.headers = {
      'Authorization': `Bearer ${freshToken}`,
      'Content-Type': 'application/json',
    };
    const retryResponse = await fetch(url.toString(), options);
    if (!retryResponse.ok) {
      const errorText = await retryResponse.text();
      throw new Error(`Twitter API error: ${retryResponse.status} - ${errorText}`);
    }
    return retryResponse.json() as Promise<T>;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twitter API error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get the authenticated user's ID (cached per session).
 */
let cachedUserId: string | null = null;
async function getAuthenticatedUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const data = await twitterApiCall<{ data: { id: string } }>('GET', '/users/me');
  cachedUserId = data.data.id;
  return cachedUserId;
}

// ============================================
// Tool Implementations
// ============================================

function wrapResult(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ data, meta: { ok: true } }),
    }],
  };
}

function wrapError(message: string, code = 'EXECUTION_ERROR') {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ data: null, meta: { ok: false, code, message } }),
    }],
  };
}

export async function twitterPostTweet(args: unknown) {
  try {
    const parsed = twitterPostTweetParams.safeParse(args);
    if (!parsed.success) {
      return wrapError(parsed.error.message, 'VALIDATION_ERROR');
    }

    const { text, reply_to, quote_tweet_id } = parsed.data;

    const body: Record<string, unknown> = { text };
    if (reply_to) {
      body.reply = { in_reply_to_tweet_id: reply_to };
    }
    if (quote_tweet_id) {
      body.quote_tweet_id = quote_tweet_id;
    }

    const result = await twitterApiCall<{
      data: { id: string; text: string; created_at?: string };
    }>('POST', '/tweets', body);

    return wrapResult({
      tweet_id: result.data.id,
      text: result.data.text,
      created_at: result.data.created_at,
    });
  } catch (error: unknown) {
    return wrapError(error instanceof Error ? error.message : String(error));
  }
}

export async function twitterGetMentions(args: unknown) {
  try {
    const parsed = twitterGetMentionsParams.safeParse(args);
    if (!parsed.success) {
      return wrapError(parsed.error.message, 'VALIDATION_ERROR');
    }

    const userId = await getAuthenticatedUserId();
    const params: Record<string, string> = {
      'tweet.fields': 'created_at,author_id',
      'expansions': 'author_id',
      'user.fields': 'username',
      'max_results': String(parsed.data.max_results || 10),
    };
    if (parsed.data.since_id) {
      params.since_id = parsed.data.since_id;
    }

    const result = await twitterApiCall<{
      data?: Array<{ id: string; text: string; author_id: string; created_at?: string }>;
      includes?: { users?: Array<{ id: string; username: string }> };
    }>('GET', `/users/${userId}/mentions`, undefined, params);

    const userMap = new Map(
      (result.includes?.users || []).map(u => [u.id, u.username])
    );

    const mentions = (result.data || []).map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      author_username: userMap.get(tweet.author_id) || tweet.author_id,
      created_at: tweet.created_at,
    }));

    return wrapResult({ mentions });
  } catch (error: unknown) {
    return wrapError(error instanceof Error ? error.message : String(error));
  }
}

export async function twitterGetTimeline(args: unknown) {
  try {
    const parsed = twitterGetTimelineParams.safeParse(args);
    if (!parsed.success) {
      return wrapError(parsed.error.message, 'VALIDATION_ERROR');
    }

    const userId = await getAuthenticatedUserId();
    const params: Record<string, string> = {
      'tweet.fields': 'created_at,public_metrics',
      'max_results': String(parsed.data.max_results || 10),
    };

    const result = await twitterApiCall<{
      data?: Array<{
        id: string;
        text: string;
        created_at?: string;
        public_metrics?: { retweet_count: number; reply_count: number; like_count: number; quote_count: number };
      }>;
    }>('GET', `/users/${userId}/tweets`, undefined, params);

    const tweets = (result.data || []).map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      public_metrics: tweet.public_metrics,
    }));

    return wrapResult({ tweets });
  } catch (error: unknown) {
    return wrapError(error instanceof Error ? error.message : String(error));
  }
}
