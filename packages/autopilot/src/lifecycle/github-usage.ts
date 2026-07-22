import { createHash } from 'node:crypto';
import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';

/** GraphQL points reserved to finish a complete lifecycle scan safely. */
export const FULL_SCAN_RESERVE = 450;

/** GraphQL points reserved for one exact, targeted pull-request read. */
export const TARGETED_PR_RESERVE = 10;

/** GraphQL points reserved for one single-issue Project-item lookup. */
export const TARGETED_PROJECT_ITEM_RESERVE = 1;

/** GraphQL points reserved for one targeted issue-to-closing-PR relation read. */
export const TARGETED_RELATION_RESERVE = 2;

/** Conservative modeled span for an opaque higher-level `gh` command. */
export const OPAQUE_GH_COMMAND_RESERVE = 10;

export interface GitHubUsage {
  /** Explicit GraphQL responses whose rate-limit evidence was decoded. */
  readonly graphqlRequests: number;
  readonly graphqlCost: number;
  readonly graphqlRemaining: number | null;
  readonly graphqlResetAt: string | null;
  readonly restRequests: number;
  readonly restNotModified: number;
  readonly cacheHits: number;
  /**
   * Whether every metered command this cycle contributed complete before/after
   * quota evidence. GitHub's `rateLimit.used`/`remaining` counters are
   * eventually consistent under concurrency, so this can be `false` for a cycle
   * whose commands all succeeded and whose numbers are otherwise correct. It is
   * observability only — never a correctness gate and never a reason to fail a
   * command or crash the loop.
   */
  readonly accountingComplete: boolean;
  /** Human-readable reason accounting was incomplete; set only when incomplete. */
  readonly incompleteReason?: string;
}

export const EMPTY_GITHUB_USAGE: GitHubUsage = Object.freeze({
  graphqlRequests: 0,
  graphqlCost: 0,
  graphqlRemaining: null,
  graphqlResetAt: null,
  restRequests: 0,
  restNotModified: 0,
  cacheHits: 0,
  accountingComplete: true,
});

export class GitHubUsageDecodeError extends Error {
  constructor(detail: string) {
    super(`GitHub GraphQL rateLimit evidence is incomplete: ${detail}`);
    this.name = 'GitHubUsageDecodeError';
  }
}

export class GitHubUsageIncompleteError extends Error {
  constructor(detail: string) {
    super(`GitHub cycle usage is incomplete: ${detail}`);
    this.name = 'GitHubUsageIncompleteError';
  }
}

export class GitHubRateLimitReserveError extends Error {
  constructor(
    readonly remaining: number,
    readonly required: number,
    readonly reserve: number,
  ) {
    super(
      `GitHub rate-limit budget low: ${remaining} remaining; ${required} required `
        + `(${required - reserve} floor + ${reserve} reserve)`,
    );
    this.name = 'GitHubRateLimitReserveError';
  }
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubUsageDecodeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function resetTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new GitHubUsageDecodeError('resetAt must be an ISO-8601 timestamp');
  }
  return value;
}

function rateLimitEvidence(response: unknown): {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: string;
} {
  if (typeof response !== 'object' || response === null) {
    throw new GitHubUsageDecodeError('response must be an object');
  }
  const data = (response as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    throw new GitHubUsageDecodeError('data must be an object');
  }
  const rateLimit = (data as { rateLimit?: unknown }).rateLimit;
  if (typeof rateLimit !== 'object' || rateLimit === null) {
    throw new GitHubUsageDecodeError('data.rateLimit must be an object');
  }
  const values = rateLimit as Record<string, unknown>;
  return {
    cost: nonNegativeInteger(values.cost, 'cost'),
    remaining: nonNegativeInteger(values.remaining, 'remaining'),
    resetAt: resetTimestamp(values.resetAt),
  };
}

function opaqueRateLimitEvidence(response: unknown): {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly used: number;
  readonly limit: number;
} {
  const evidence = rateLimitEvidence(response);
  const data = (response as { data: { rateLimit: Record<string, unknown> } }).data;
  const used = nonNegativeInteger(data.rateLimit.used, 'used');
  const limit = nonNegativeInteger(data.rateLimit.limit, 'limit');
  if (used > limit || evidence.remaining > limit) {
    throw new GitHubUsageDecodeError('used and remaining must not exceed limit');
  }
  return { ...evidence, used, limit };
}

/** Mutable, cycle-scoped request meter. `read()` always returns a frozen copy. */
export class GitHubUsageMeter {
  private graphqlRequests = 0;
  private graphqlCost = 0;
  private readonly quotaByCredential = new Map<string, {
    readonly remaining: number;
    readonly resetAt: string;
  }>();
  private restRequests = 0;
  private restNotModified = 0;
  private cacheHits = 0;
  private incompleteReason: string | null = null;
  private opaqueQueue: Promise<void> = Promise.resolve();

  private recordQuotaEvidence(
    remaining: number,
    resetAt: string,
    credentialKey: string,
  ): void {
    const current = this.quotaByCredential.get(credentialKey);
    if (
      current === undefined
      || Date.parse(resetAt) > Date.parse(current.resetAt)
    ) {
      this.quotaByCredential.set(credentialKey, { remaining, resetAt });
    } else if (resetAt === current.resetAt) {
      this.quotaByCredential.set(credentialKey, {
        remaining: Math.min(current.remaining, remaining),
        resetAt: current.resetAt,
      });
    }
  }

  recordGraphQlResponse(response: unknown, credentialKey = 'ambient'): void {
    const evidence = rateLimitEvidence(response);
    this.graphqlRequests += 1;
    this.graphqlCost += evidence.cost;
    this.recordQuotaEvidence(evidence.remaining, evidence.resetAt, credentialKey);
  }

  /** Records quota authority from REST `/rate_limit` without charging GraphQL usage. */
  recordGraphQlQuotaEvidence(
    remainingValue: unknown,
    resetAtValue: unknown,
    credentialKey = 'ambient',
  ): void {
    const remaining = nonNegativeInteger(remainingValue, 'remaining');
    const resetAt = resetTimestamp(resetAtValue);
    this.recordQuotaEvidence(remaining, resetAt, credentialKey);
  }

  recordRestRequest(status?: number): void {
    if (
      status !== undefined
      && (!Number.isSafeInteger(status) || status < 100 || status > 599)
    ) {
      throw new Error(`Invalid GitHub REST status: ${String(status)}`);
    }
    this.restRequests += 1;
    if (status === 304) this.restNotModified += 1;
  }

  recordOpaqueGraphQlSpan(
    before: unknown,
    after: unknown,
    credentialKey = 'ambient',
  ): void {
    // Structural decode failures (missing/negative rateLimit fields) still
    // throw — they are corrupt evidence, not skew. Everything past this point
    // is best-effort accounting that must never throw: GitHub's used/remaining
    // counters are eventually consistent, so under concurrent reads the
    // before/after probes legitimately disagree even though the command
    // succeeded. Inconsistency is surfaced via markIncomplete, never raised.
    const start = opaqueRateLimitEvidence(before);
    const end = opaqueRateLimitEvidence(after);
    const startReset = Date.parse(start.resetAt);
    const endReset = Date.parse(end.resetAt);
    let hiddenCost = 0;
    if (endReset === startReset) {
      const remainingDelta = start.remaining - end.remaining;
      const usedDelta = end.used - start.used;
      if (
        end.limit !== start.limit
        || remainingDelta < end.cost
        || usedDelta < end.cost
        || remainingDelta !== usedDelta
      ) {
        this.markIncomplete(
          'opaque-command quota evidence was inconsistent '
            + '(eventually-consistent rate-limit counter skew)',
        );
      } else {
        hiddenCost = usedDelta - end.cost;
      }
    } else if (endReset > startReset) {
      if (end.used < end.cost) {
        this.markIncomplete('opaque-command quota evidence straddled a reset inconsistently');
      } else {
        // The exact old-window spend is unknowable across a reset. Treat every
        // point that remained at the first probe as potentially spent, then add
        // evidenced new-window usage before the closing probe. This
        // intentionally over-counts rather than understating a straddling cycle.
        hiddenCost = start.remaining + end.used - end.cost;
      }
    } else {
      this.markIncomplete('opaque-command closing probe belonged to an older reset window');
    }
    // Always advance best-effort quota evidence from both probes so
    // remaining/reset/requests/cost keep moving even when accounting is soft.
    this.recordGraphQlResponse(before, credentialKey);
    this.recordGraphQlResponse(after, credentialKey);
    this.graphqlCost += hiddenCost;
  }

  serializeOpaque<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.opaqueQueue.then(operation);
    this.opaqueQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  markIncomplete(detail: string): void {
    this.incompleteReason ??= detail;
  }

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  reset(): void {
    this.graphqlRequests = 0;
    this.graphqlCost = 0;
    this.quotaByCredential.clear();
    this.restRequests = 0;
    this.restNotModified = 0;
    this.cacheHits = 0;
    this.incompleteReason = null;
  }

  read(): GitHubUsage {
    // read() never throws on incomplete accounting: GitHub's used/remaining
    // counters are eventually consistent, so accounting can be incomplete for a
    // fully-correct cycle. Completeness is surfaced as a flag, not raised — a
    // throw here would fail a command that succeeded and crash the active loop.
    let lowest: { readonly remaining: number; readonly resetAt: string } | undefined;
    for (const quota of this.quotaByCredential.values()) {
      if (lowest === undefined || quota.remaining < lowest.remaining) lowest = quota;
    }
    return Object.freeze({
      graphqlRequests: this.graphqlRequests,
      graphqlCost: this.graphqlCost,
      graphqlRemaining: lowest?.remaining ?? null,
      graphqlResetAt: lowest?.resetAt ?? null,
      restRequests: this.restRequests,
      restNotModified: this.restNotModified,
      cacheHits: this.cacheHits,
      accountingComplete: this.incompleteReason === null,
      ...(this.incompleteReason === null ? {} : { incompleteReason: this.incompleteReason }),
    });
  }
}

const OPAQUE_USAGE_PROBE = [
  'query OpaqueGitHubUsageProbe {',
  '  rateLimit { cost remaining resetAt used limit }',
  '}',
].join('\n');

function ephemeralCredentialKey(options?: { env?: Record<string, string> }): string {
  const token = options?.env?.GH_TOKEN;
  if (token === undefined) return 'ambient';
  return `token:${createHash('sha256').update(token).digest('hex')}`;
}

function includedRestStatus(raw: string): number | undefined {
  const match = /^(?:HTTP\/1\.[01]|HTTP\/2(?:\.0)?) ([1-5][0-9]{2})(?:[ \r\n])/.exec(raw);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** stdout retained by Node's exec-file rejection, when one is available. */
export function commandErrorStdout(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const stdout = (error as Record<string, unknown>).stdout;
  return typeof stdout === 'string' ? stdout : null;
}

/**
 * Meter every GitHub CLI call crossing one production command boundary.
 * Explicit REST and GraphQL calls are recorded directly. Higher-level `gh`
 * commands have opaque transport internals, so authenticated before/after
 * GraphQL probes reconcile their observed cost without assigning a guessed
 * fixed cost. The original command options are reused for both probes, which
 * keeps selected credential overlays intact.
 */
export function makeGitHubUsageCommandRunner(
  run: CommandRunner,
  meter: GitHubUsageMeter,
  config: { readonly rateLimitFloor?: number } = {},
): CommandRunner {
  const probeArgs = ['api', 'graphql', '-f', `query=${OPAQUE_USAGE_PROBE}`];
  return async (command, args, options) => {
    if (command !== 'gh') return run(command, args, options);
    if (args[0] === 'api' && args[1] !== 'graphql') {
      if (args.includes('--paginate')) {
        meter.markIncomplete('an explicit REST command hid its response page count');
        throw new GitHubUsageIncompleteError(
          'explicit REST pagination must use one observable command per page',
        );
      }
      if (!args.includes('--include')) {
        meter.recordRestRequest();
        return run(command, args, options);
      }
      try {
        const raw = await run(command, args, options);
        meter.recordRestRequest(includedRestStatus(raw));
        return raw;
      } catch (error) {
        const stdout = commandErrorStdout(error);
        meter.recordRestRequest(stdout === null ? undefined : includedRestStatus(stdout));
        throw error;
      }
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const credentialKey = ephemeralCredentialKey(options);
      try {
        const raw = await run(command, args, options);
        meter.recordGraphQlResponse(JSON.parse(raw) as unknown, credentialKey);
        return raw;
      } catch (error) {
        meter.markIncomplete('an explicit GraphQL command lacked rate-limit evidence');
        throw error;
      }
    }

    return meter.serializeOpaque(async () => {
      if (config.rateLimitFloor !== undefined) {
        const cachedRemaining = meter.read().graphqlRemaining;
        if (cachedRemaining !== null) {
          assertRateLimitReserve(
            cachedRemaining,
            OPAQUE_GH_COMMAND_RESERVE,
            config.rateLimitFloor,
          );
        }
      }
      const credentialKey = ephemeralCredentialKey(options);
      let before: unknown;
      let opening: ReturnType<typeof opaqueRateLimitEvidence>;
      try {
        before = JSON.parse(await run('gh', probeArgs, options)) as unknown;
        opening = opaqueRateLimitEvidence(before);
      } catch (error) {
        meter.markIncomplete('the opening opaque-command quota probe failed');
        throw error;
      }
      if (config.rateLimitFloor !== undefined) {
        try {
          assertRateLimitReserve(
            opening.remaining,
            OPAQUE_GH_COMMAND_RESERVE,
            config.rateLimitFloor,
          );
        } catch (error) {
          // The opening probe is a real GraphQL request even when it prevents
          // the opaque command. Keep that complete evidence in cycle usage.
          meter.recordGraphQlResponse(before, credentialKey);
          throw error;
        }
      }
      let result: string | undefined;
      let commandError: unknown;
      try {
        result = await run(command, args, options);
      } catch (error) {
        commandError = error;
      }
      // The closing quota probe and its span are best-effort accounting, never
      // the command's result. A probe that fails to transport or a probe span
      // that is skewed/unparseable must never fail a command that already
      // succeeded, and must never crash the loop — it only marks accounting
      // incomplete. The command's own failure is the sole reason to throw.
      let probeError: unknown;
      let after: unknown;
      try {
        after = JSON.parse(await run('gh', probeArgs, options)) as unknown;
      } catch (error) {
        probeError = error;
        meter.markIncomplete('the closing opaque-command quota probe failed');
      }
      if (after !== undefined) {
        try {
          meter.recordOpaqueGraphQlSpan(before, after, credentialKey);
        } catch (error) {
          // A structurally-undecodable closing probe is still accounting-only.
          meter.markIncomplete(
            `the closing opaque-command quota probe was unusable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (commandError !== undefined) {
        if (probeError !== undefined) {
          throw new AggregateError(
            [commandError, probeError],
            'GitHub command and usage probe failed',
          );
        }
        throw commandError;
      }
      return result!;
    });
  };
}

export function requiredRateLimitRemaining(reserve: number, floor = DEFAULT_FLOOR): number {
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new Error('GitHub rate-limit reserve must be a non-negative integer');
  }
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new Error('GitHub rate-limit floor must be a non-negative integer');
  }
  return Math.max(DEFAULT_FLOOR, floor) + reserve;
}

export function assertRateLimitReserve(
  remaining: number,
  reserve: number,
  floor = DEFAULT_FLOOR,
): void {
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error('GitHub rate-limit remaining must be a non-negative integer');
  }
  const required = requiredRateLimitRemaining(reserve, floor);
  if (remaining < required) {
    throw new GitHubRateLimitReserveError(remaining, required, reserve);
  }
}
