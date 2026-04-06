// Centralized context management helpers: cursor encoding, token estimation, single-page builder

export interface TokenEstimate {
  tokens: number;
  estimated: boolean;
}

export function estimateTokensFromJSON(payload: any): TokenEstimate {
  // Simple heuristic: ~4 chars per token
  const json = JSON.stringify(payload);
  const chars = json ? json.length : 0;
  const tokens = Math.ceil(chars / 4);
  return { tokens, estimated: true };
}

export function encodeCursor<T extends object>(keyset: T): string {
  const json = JSON.stringify({ v: 1, k: keyset });
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeCursor<T = any>(cursor?: string): T | undefined {
  if (!cursor) return undefined;
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed.k as T;
  } catch {
    return undefined;
  }
}

export function deepTruncateStrings(value: any, maxChars: number): any {
    if (value == null) return value;
    if (typeof value === 'string') {
      if (maxChars <= 0) return value;
      return value.length > maxChars ? value.slice(0, maxChars) + '... [truncated]' : value;
    }
    if (Array.isArray(value)) return value.map(v => deepTruncateStrings(v, maxChars));
    if (typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = deepTruncateStrings(v, maxChars);
      }
      return out;
    }
    return value;
  }
  
  export type TruncationPolicy = Record<string, number>;
  
  export function deepTruncateByField(value: any, policy: TruncationPolicy): any {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(v => deepTruncateByField(v, policy));
    if (typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        const limit = policy[k];
        if (typeof v === 'string' && typeof limit === 'number' && limit >= 0) {
          out[k] = v.length > limit ? v.slice(0, limit) + '... [truncated]' : v;
        } else {
          out[k] = deepTruncateByField(v, policy);
        }
      }
      return out;
    }
    return value;
  }
  export interface BuildSinglePageOptions {
    startOffset?: number;                  // simple offset-based cursor for phase 1
    pageTokenBudget?: number;              // default 50k
    truncateChars?: number;                // default 300 if no policy provided
    truncationPolicy?: TruncationPolicy;   // field-aware truncation if provided
    // Hard clamps & enforcement
    perFieldMaxChars?: number;             // global clamp for any string field (e.g., 10k). Applied after policy/generic.
    enforceHardPageBudget?: boolean;       // ensure a page never exceeds the budget (default true)
    enforceHardFieldClamp?: boolean;       // ensure no single string field exceeds perFieldMaxChars (default true)
    upstreamLimit?: number;                // database result limit (prevents false has_more when offset >= limit)
  }
  
  export interface BuildSinglePageResult {
    pageItems: any[];
    nextCursor?: string;
    tokens: TokenEstimate;
  }
export function buildSinglePageFromItems(
  allItems: any[],
  opts: BuildSinglePageOptions = {}
): BuildSinglePageResult {
  const pageTokenBudget = opts.pageTokenBudget ?? 15_000;
  const truncateChars = opts.truncateChars ?? 200;
  const startOffset = opts.startOffset ?? 0;
  const policy = opts.truncationPolicy;
  const enforceHardBudget = opts.enforceHardPageBudget ?? true;
  const enforceFieldClamp = opts.enforceHardFieldClamp ?? true;
  const perFieldMaxChars = enforceFieldClamp ? (opts.perFieldMaxChars ?? 4_000) : undefined;

  const applyPolicyThenClamp = (item: any): any => {
    // Apply field-aware policy first, else generic per-item truncation
    const policyApplied = policy
      ? deepTruncateByField(item, policy)
      : (truncateChars >= 0 ? deepTruncateStrings(item, truncateChars) : item);
    // Then apply the global field clamp (if enabled)
    return typeof perFieldMaxChars === 'number'
      ? deepTruncateStrings(policyApplied, perFieldMaxChars)
      : policyApplied;
  };

  const page: any[] = [];
  let runningTokens = 0;

  for (let i = startOffset; i < allItems.length; i++) {
    const candidate = applyPolicyThenClamp(allItems[i]);
    const nextPage = [...page, candidate];
    const est = estimateTokensFromJSON(nextPage);

    if (enforceHardBudget && est.tokens > pageTokenBudget) {
      // If we already have items, stop before overflowing
      if (page.length > 0) {
        break;
      }
      // Single-item overflow at current offset, even after clamp → skip-and-advance
      const nextCursor = encodeCursor({ offset: i + 1 });
      return {
        pageItems: [],
        nextCursor,
        tokens: { tokens: 0, estimated: true },
      };
    }

    // Safe to include
    page.push(candidate);
    runningTokens = est.tokens;
  }

  const nextOffset = startOffset + page.length;
  let hasMore = nextOffset < allItems.length;
  
  // If upstreamLimit is set, check if we've exhausted the database results
  // This prevents false has_more signals when client token budget < database page size
  if (opts.upstreamLimit !== undefined && nextOffset >= opts.upstreamLimit) {
    hasMore = false;
  }
  
  const nextCursor = hasMore ? encodeCursor({ offset: nextOffset }) : undefined;

  return {
    pageItems: page,
    nextCursor,
    tokens: { tokens: runningTokens, estimated: true }
  };
}

export interface BuildSinglePageResult {
  pageItems: any[];
  nextCursor?: string;
  tokens: TokenEstimate;
}

export interface ComposeSinglePageOptions extends BuildSinglePageOptions {
  warnThresholdTokens?: number; // default 500k
  requestedMeta?: Record<string, any>; // e.g., { cursor, max_page_tokens }
}

export interface ComposeSinglePageResult {
  meta: {
    requested?: Record<string, any>;
    tokens: {
      page_tokens: number;
      full_tokens: number;
      budget_tokens: number;
      estimated: boolean;
    };
    has_more: boolean;
    next_cursor?: string;
    warnings?: string[];
  };
  data: any[];
}

export function composeSinglePageResponse(
  allItems: any[],
  opts: ComposeSinglePageOptions = {}
): ComposeSinglePageResult {
  const budget = opts.pageTokenBudget ?? 15_000;
  const warnAt = opts.warnThresholdTokens ?? 100_000;

  const page = buildSinglePageFromItems(allItems, opts);

  // Compute full tokens using the same truncation policy as the page
  const truncateOne = (item: any) => {
    const hasPolicy = Boolean(opts.truncationPolicy);
    const perItemMax = opts.truncateChars ?? 200;
    const clampEnabled = opts.enforceHardFieldClamp ?? true;
    const clampMax = clampEnabled ? (opts.perFieldMaxChars ?? 4_000) : undefined;

    let v = hasPolicy
      ? deepTruncateByField(item, opts.truncationPolicy as TruncationPolicy)
      : (perItemMax >= 0 ? deepTruncateStrings(item, perItemMax) : item);

    if (typeof clampMax === 'number') {
      v = deepTruncateStrings(v, clampMax);
    }
    return v;
  };
  const truncatedAll = allItems.map(truncateOne);
  const fullEst = estimateTokensFromJSON(truncatedAll);

  const warnings: string[] = [];
  if (fullEst.tokens > warnAt) {
    warnings.push(
      `Full results estimated at ~${fullEst.tokens.toLocaleString()} tokens; including them may inflate context.`
    );
  }

  const meta = {
    requested: opts.requestedMeta,
    tokens: {
      page_tokens: page.tokens.tokens,
      full_tokens: fullEst.tokens,
      budget_tokens: budget,
      estimated: true,
    },
    has_more: Boolean(page.nextCursor),
    next_cursor: page.nextCursor,
    warnings: warnings.length ? warnings : undefined,
  };

  return { meta, data: page.pageItems };
}