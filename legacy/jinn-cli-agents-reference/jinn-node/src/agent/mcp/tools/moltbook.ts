/**
 * Moltbook MCP Tools
 *
 * Provides tools for AI agents to interact with Moltbook, the agent social network.
 * Moltbook is a Reddit-style platform where AI agents post, comment, vote, and
 * participate in topic communities called "submolts."
 *
 * API base: https://www.moltbook.com/api/v1
 * Rate limits: 100 req/min, 1 post/30 min, 50 comments/hr
 *
 * Credentials: API key fetched via credential bridge (provider: 'moltbook')
 */

import { z } from 'zod';
import { getCredential } from '../../shared/credential-client.js';

// ============================================
// Helper Functions
// ============================================

async function getMoltbookConfig() {
    const apiKey = await getCredential('moltbook');
    return { apiKey };
}

const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';

async function moltbookApiCall<T>(
    httpMethod: 'GET' | 'POST' | 'DELETE',
    path: string,
    apiKey: string,
    body?: Record<string, unknown>
): Promise<T> {
    const url = `${MOLTBOOK_BASE_URL}${path}`;

    const response = await fetch(url, {
        method: httpMethod,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...(body && { 'Content-Type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Moltbook API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    return data as T;
}

function formatMcpResponse(data: unknown, ok = true) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                data: ok ? data : null,
                meta: ok ? { ok: true } : data,
            }),
        }],
    };
}

function formatMcpError(code: string, message: string) {
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

// ============================================
// Schema Definitions
// ============================================

// --- Search ---

export const moltbookSearchParams = z.object({
    query: z.string().min(1).describe('Search query'),
    limit: z.number().min(1).max(50).optional()
        .describe('Max results to return (default: 25)'),
});

export const moltbookSearchSchema = {
    description: `Search Moltbook for posts, agents, and submolts.

Returns matching content across the platform. Use this to discover relevant conversations, communities, and agents.`,
    inputSchema: moltbookSearchParams.shape,
};

// --- Feed ---

export const moltbookGetFeedParams = z.object({
    sort: z.enum(['hot', 'new', 'top', 'rising']).optional()
        .describe('Sort order (default: hot)'),
    limit: z.number().min(1).max(50).optional()
        .describe('Max posts to return (default: 25)'),
});

export const moltbookGetFeedSchema = {
    description: `Get the personalised feed from subscribed submolts and followed agents.

Shows posts relevant to the agent based on subscriptions. Use 'new' sort to see the latest activity, 'hot' for trending.`,
    inputSchema: moltbookGetFeedParams.shape,
};

// --- Submolts ---

export const moltbookGetSubmoltParams = z.object({
    name: z.string().min(1).describe('Submolt name (e.g. "ai-agents", "crypto")'),
});

export const moltbookGetSubmoltSchema = {
    description: `Get information and recent posts from a specific submolt (community).

Returns submolt description, subscriber count, and recent posts.`,
    inputSchema: moltbookGetSubmoltParams.shape,
};

export const moltbookListSubmoltsParams = z.object({
    limit: z.number().min(1).max(50).optional()
        .describe('Max submolts to return (default: 25)'),
});

export const moltbookListSubmoltsSchema = {
    description: `Browse available submolts on Moltbook.

Returns a list of communities with their names, descriptions, and subscriber counts. Use this to discover relevant communities to participate in.`,
    inputSchema: moltbookListSubmoltsParams.shape,
};

export const moltbookSubscribeParams = z.object({
    name: z.string().min(1).describe('Submolt name to subscribe to'),
});

export const moltbookSubscribeSchema = {
    description: `Subscribe to a submolt to include its posts in your feed.

Subscribing shows interest in the community and lets you see its content in your personalised feed.`,
    inputSchema: moltbookSubscribeParams.shape,
};

// --- Posts ---

export const moltbookCreatePostParams = z.object({
    title: z.string().min(1).max(300).describe('Post title'),
    content: z.string().optional().describe('Post body text (for text posts)'),
    url: z.string().optional().describe('URL (for link posts)'),
    submolt: z.string().min(1).describe('Submolt to post in'),
});

export const moltbookCreatePostSchema = {
    description: `Create a new post in a submolt.

Either text post (with content) or link post (with url). Rate limited to 1 post per 30 minutes.

Returns the created post with its ID and URL.`,
    inputSchema: moltbookCreatePostParams.shape,
};

export const moltbookGetPostParams = z.object({
    id: z.string().min(1).describe('Post ID'),
});

export const moltbookGetPostSchema = {
    description: `Read a specific post and its comments.

Returns the full post content, vote count, and comment thread.`,
    inputSchema: moltbookGetPostParams.shape,
};

// --- Comments ---

export const moltbookCreateCommentParams = z.object({
    post_id: z.string().min(1).describe('Post ID to comment on'),
    content: z.string().min(1).describe('Comment text'),
    parent_id: z.string().optional().describe('Parent comment ID for nested replies'),
});

export const moltbookCreateCommentSchema = {
    description: `Add a comment to a post, or reply to an existing comment.

Use parent_id to create nested replies. Rate limited to 50 comments per hour.

Returns the created comment with its ID.`,
    inputSchema: moltbookCreateCommentParams.shape,
};

// --- Voting ---

export const moltbookUpvoteParams = z.object({
    target_type: z.enum(['post', 'comment']).describe('Whether to upvote a post or comment'),
    target_id: z.string().min(1).describe('ID of the post or comment to upvote'),
});

export const moltbookUpvoteSchema = {
    description: `Upvote a post or comment.

Upvoting signals that the content is valuable to the community. Use judiciously — karma reflects genuine engagement.`,
    inputSchema: moltbookUpvoteParams.shape,
};

// --- Profile ---

export const moltbookGetProfileParams = z.object({});

export const moltbookGetProfileSchema = {
    description: `Get your own agent profile on Moltbook.

Returns your agent name, karma score, post count, comment count, and subscription list. Use this to track your standing in the community.`,
    inputSchema: moltbookGetProfileParams.shape,
};

// ============================================
// Verification Challenge Solver
// ============================================

// Moltbook uses garbled "lobster math" captchas to verify posts/comments.
// The challenge text has random punctuation, case alternation, and letter
// repetitions. We degarble it, extract numbers, detect the operation, and
// return the answer as "X.XX".

const WORD_CORRECTIONS: Record<string, string> = {
    thre: 'three', fourten: 'fourteen', fiften: 'fifteen',
    sixten: 'sixteen', seventen: 'seventeen', eighten: 'eighteen',
    nineten: 'nineteen', twety: 'twenty', thrty: 'thirty',
    fty: 'fifty', sxty: 'sixty', sevnty: 'seventy',
    eghty: 'eighty', nnety: 'ninety',
    hundrd: 'hundred', thousnd: 'thousand',
    lobstr: 'lobster', twnty: 'twenty', thrte: 'thirty',
    fife: 'five', fve: 'five', hre: 'three',
    hirty: 'thirty', irty: 'thirty', hirteen: 'thirteen',
    ourteen: 'fourteen', ifteen: 'fifteen', ixteen: 'sixteen',
    ighteen: 'eighteen', ineteen: 'nineteen',
    wenty: 'twenty', enty: 'twenty',
    orty: 'forty', ighty: 'eighty', inety: 'ninety',
    sped: 'speed', gans: 'gains', gan: 'gain',
};

const NUMBER_WORDS: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

const NUMBER_TARGETS = new Set([
    ...Object.keys(NUMBER_WORDS),
    'total', 'force', 'distance', 'lobster', 'newtons', 'meters', 'seconds',
    'minutes', 'centimeters', 'kilometers', 'increases', 'decreases',
    'accelerates', 'decelerates', 'molting', 'antenna', 'exerts',
]);

function degarble(challenge: string): { cleaned: string; explicitOp: string | null } {
    // Detect explicit math operators in raw text
    let explicitOp: string | null = null;
    if (/\d\s*\+\s*\d/.test(challenge)) explicitOp = 'add';
    else if (/\d\s*[*\u00d7]\s*\d/.test(challenge) || /[*\u00d7]/.test(challenge)) explicitOp = 'multiply';
    else if (/\d\s*\/\s*\d/.test(challenge)) explicitOp = 'divide';
    else if (/\d\s+-\s+\d/.test(challenge)) explicitOp = 'subtract';

    // Strip non-alphanumeric, lowercase, collapse repeated chars
    let clean = challenge.replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase();
    clean = clean.replace(/(.)\1{2,}/g, '$1');
    clean = clean.replace(/(.)\1+/g, '$1');

    // Apply word corrections
    let words = clean.split(/\s+/).map(w => WORD_CORRECTIONS[w] ?? w);

    // Rejoin space-split number fragments
    const rejoined: string[] = [];
    let i = 0;
    while (i < words.length) {
        let matched = false;
        for (const span of [5, 4, 3, 2]) {
            if (i + span <= words.length) {
                const combined = words.slice(i, i + span).join('');
                const corrected = WORD_CORRECTIONS[combined] ?? combined;
                if (NUMBER_TARGETS.has(combined) || NUMBER_TARGETS.has(corrected)) {
                    rejoined.push(NUMBER_TARGETS.has(combined) ? combined : corrected);
                    i += span;
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) { rejoined.push(words[i]); i++; }
    }

    return { cleaned: rejoined.join(' '), explicitOp };
}

function extractNumbers(raw: string, cleaned: string): number[] {
    const digitNums: number[] = [];
    let digitMatch: RegExpExecArray | null;
    const digitRe = /\b(\d+(?:\.\d+)?)\b/g;
    while ((digitMatch = digitRe.exec(raw)) !== null) {
        digitNums.push(parseFloat(digitMatch[1]));
    }

    const words = cleaned.split(/\s+/);
    const found: number[] = [];
    let i = 0;
    while (i < words.length) {
        const w = words[i].toLowerCase();
        if (w in NUMBER_WORDS) {
            let val = NUMBER_WORDS[w];
            if (i + 1 < words.length && words[i + 1].toLowerCase() in NUMBER_WORDS) {
                const nextVal = NUMBER_WORDS[words[i + 1].toLowerCase()];
                if (val >= 20 && nextVal < 10) { val += nextVal; i++; }
                else if (val >= 100 && nextVal < 100) { val += nextVal; i++; }
            }
            found.push(val);
        }
        i++;
    }

    return [...found, ...digitNums];
}

function solveChallenge(challenge: string): string | null {
    const { cleaned, explicitOp } = degarble(challenge);
    const foundNums = extractNumbers(challenge, cleaned);

    // Deduplicate preserving order
    const sameNumPattern = /(\d+)\s*[+\-*/\u00d7]\s*\1/.test(challenge);
    let uniqueNums: number[];
    if (sameNumPattern) {
        uniqueNums = foundNums.slice(0, 2);
    } else {
        const seen = new Set<number>();
        uniqueNums = [];
        for (const n of foundNums) {
            if (!seen.has(n)) { seen.add(n); uniqueNums.push(n); }
        }
    }

    if (uniqueNums.length < 2) return null;

    const [a, b] = uniqueNums;

    // Priority 1: Explicit operator
    if (explicitOp) {
        let result: number;
        if (explicitOp === 'add') result = a + b;
        else if (explicitOp === 'subtract') result = a - b;
        else if (explicitOp === 'multiply') result = a * b;
        else result = b !== 0 ? a / b : 0;
        return result.toFixed(2);
    }

    const text = cleaned;

    // Priority 2: Rate * time pattern
    const rateWords = ['per second', 'per sec', 'per minute', 'per min', 'per hour', 'cm per', 'meters per'];
    const subtractWords = ['slow', 'slows', 'reduce', 'reduces', 'resistance', 'decelerate', 'loses',
        'drops', 'decreases', 'minus', 'subtract', 'less', 'gave away', 'spent', 'remaining', 'left over'];
    const hasRate = rateWords.some(w => text.includes(w));
    const hasSubtract = subtractWords.some(w => text.includes(w));

    const numWordsPattern = Object.keys(NUMBER_WORDS).filter(w => NUMBER_WORDS[w] <= 100).join('|');
    const durationRe = new RegExp(`\\bfor\\s+(\\d+|${numWordsPattern})\\s+(seconds?|minutes?|hours?|secs?|mins?)\\b`);
    const durationMatch = text.match(durationRe);

    if (hasRate && durationMatch && !hasSubtract) {
        const durStr = durationMatch[1];
        const timeVal = /^\d+$/.test(durStr) ? parseFloat(durStr) : (NUMBER_WORDS[durStr] ?? 0);
        if (timeVal) return (a * timeVal).toFixed(2);
    }

    // Priority 3: Keyword-based operation detection
    if (text.includes('each')) return (a * b).toFixed(2);

    const addWords = ['plus', 'added', 'adds', 'more than', 'additional', 'gained', 'gains', 'gain',
        'accelerates', 'faster', 'increases', 'speeds', 'more', 'earns', 'collects', 'gathers', 'receives', 'gets'];
    if (addWords.some(w => text.includes(w))) return (a + b).toFixed(2);
    if (hasSubtract) return (a - b).toFixed(2);

    const mulWords = ['times', 'multiply', 'multiplied', 'multiplies', 'multi'];
    if (mulWords.some(w => text.includes(w))) return (a * b).toFixed(2);

    const divWords = ['divided', 'divide', 'split', 'shared equally'];
    if (divWords.some(w => text.includes(w))) return (b !== 0 ? a / b : 0).toFixed(2);

    // Default: sum
    return uniqueNums.reduce((s, n) => s + n, 0).toFixed(2);
}

interface VerificationChallenge {
    challenge_text?: string;
    verification_code?: string;
}

/**
 * Auto-verify content after creation if a verification challenge is returned.
 * One-shot only — never retries to avoid account suspension.
 */
async function autoVerify(
    apiKey: string,
    verification: VerificationChallenge | undefined,
): Promise<{ verified: boolean; answer?: string; error?: string }> {
    if (!verification?.challenge_text || !verification?.verification_code) {
        return { verified: false, error: 'No verification challenge in response' };
    }

    const answer = solveChallenge(verification.challenge_text);
    if (answer === null) {
        return { verified: false, error: 'Could not solve challenge — left content pending to avoid suspension' };
    }

    try {
        const resp = await fetch(`${MOLTBOOK_BASE_URL}/verify`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                verification_code: verification.verification_code,
                answer,
            }),
            signal: AbortSignal.timeout(15000),
        });

        const data = await resp.json() as { success?: boolean };
        return { verified: !!data.success, answer };
    } catch (err) {
        return { verified: false, answer, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Extract verification challenge from a nested API response.
 * The challenge can be at result.verification, result.post.verification,
 * or result.comment.verification.
 */
function extractVerification(result: unknown): VerificationChallenge | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const r = result as Record<string, unknown>;
    for (const key of ['verification', 'post', 'comment', 'data']) {
        const obj = r[key];
        if (obj && typeof obj === 'object') {
            const o = obj as Record<string, unknown>;
            if ('challenge_text' in o) return o as VerificationChallenge;
            if ('verification' in o && typeof o.verification === 'object') {
                return o.verification as VerificationChallenge;
            }
        }
    }
    return undefined;
}

// ============================================
// Tool Implementations
// ============================================

export async function moltbookSearch(args: unknown) {
    try {
        const parsed = moltbookSearchParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const { query, limit } = parsed.data;
        const params = new URLSearchParams({ q: query });
        if (limit) params.set('limit', String(limit));

        const result = await moltbookApiCall<unknown>('GET', `/search?${params}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetFeed(args: unknown) {
    try {
        const parsed = moltbookGetFeedParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const { sort, limit } = parsed.data;
        const params = new URLSearchParams();
        if (sort) params.set('sort', sort);
        if (limit) params.set('limit', String(limit));

        const queryStr = params.toString();
        const result = await moltbookApiCall<unknown>('GET', `/feed${queryStr ? `?${queryStr}` : ''}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetSubmolt(args: unknown) {
    try {
        const parsed = moltbookGetSubmoltParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('GET', `/submolts/${encodeURIComponent(parsed.data.name)}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookListSubmolts(args: unknown) {
    try {
        const parsed = moltbookListSubmoltsParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const params = new URLSearchParams();
        if (parsed.data.limit) params.set('limit', String(parsed.data.limit));

        const queryStr = params.toString();
        const result = await moltbookApiCall<unknown>('GET', `/submolts${queryStr ? `?${queryStr}` : ''}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookSubscribe(args: unknown) {
    try {
        const parsed = moltbookSubscribeParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('POST', `/submolts/${encodeURIComponent(parsed.data.name)}/subscribe`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookCreatePost(args: unknown) {
    try {
        const parsed = moltbookCreatePostParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const { title, content, url, submolt } = parsed.data;

        const result = await moltbookApiCall<unknown>('POST', '/posts', config.apiKey, {
            title,
            submolt,
            ...(content && { content }),
            ...(url && { url }),
        });

        // Auto-verify if challenge is present
        const verification = extractVerification(result);
        if (verification) {
            const verifyResult = await autoVerify(config.apiKey, verification);
            return formatMcpResponse({
                ...(typeof result === 'object' ? result : { raw: result }),
                _verification: verifyResult,
            });
        }

        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetPost(args: unknown) {
    try {
        const parsed = moltbookGetPostParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('GET', `/posts/${encodeURIComponent(parsed.data.id)}`, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookCreateComment(args: unknown) {
    try {
        const parsed = moltbookCreateCommentParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const { post_id, content, parent_id } = parsed.data;

        const result = await moltbookApiCall<unknown>('POST', `/posts/${encodeURIComponent(post_id)}/comments`, config.apiKey, {
            content,
            ...(parent_id && { parent_id }),
        });

        // Auto-verify if challenge is present
        const verification = extractVerification(result);
        if (verification) {
            const verifyResult = await autoVerify(config.apiKey, verification);
            return formatMcpResponse({
                ...(typeof result === 'object' ? result : { raw: result }),
                _verification: verifyResult,
            });
        }

        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookUpvote(args: unknown) {
    try {
        const parsed = moltbookUpvoteParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const { target_type, target_id } = parsed.data;

        const path = target_type === 'post'
            ? `/posts/${encodeURIComponent(target_id)}/upvote`
            : `/comments/${encodeURIComponent(target_id)}/upvote`;

        const result = await moltbookApiCall<unknown>('POST', path, config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}

export async function moltbookGetProfile(args: unknown) {
    try {
        const parsed = moltbookGetProfileParams.safeParse(args);
        if (!parsed.success) return formatMcpError('VALIDATION_ERROR', parsed.error.message);

        const config = await getMoltbookConfig();
        const result = await moltbookApiCall<unknown>('GET', '/agents/me', config.apiKey);
        return formatMcpResponse(result);
    } catch (error: unknown) {
        return formatMcpError('EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
    }
}
