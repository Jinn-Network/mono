import type { BroadcastConfig } from './config.js';
import { StateStore, type BotState, type SourceState } from './state/store.js';
import { makeGithubClient } from './sources/github.js';
import { fetchReleases } from './sources/github-releases.js';
import { fetchMergedPrs } from './sources/github-prs.js';
import { fetchDiscussions } from './sources/github-discussions.js';
import { fetchOnchain } from './sources/onchain.js';
import { ClaudeComposer, assertClaudeAvailable } from './composer/claude.js';
import { StdoutPoster } from './poster/stdout.js';
import { XPoster, loadXCredentialsFromEnv } from './poster/x.js';
import type { Poster } from './poster/poster.js';
import type { BroadcastEvent } from './types.js';

export interface RunOnceOptions {
  config: BroadcastConfig;
  statePath: string;
}

export interface RunOnceSummary {
  posted: number;
  skipped: number;
  lintFailures: Array<{ dedupeKey: string; reason: string }>;
}

export async function runOnce(opts: RunOnceOptions): Promise<RunOnceSummary> {
  const { config } = opts;
  const store = new StateStore(opts.statePath);
  const state = store.load();

  // Preflight: claude CLI must be present + authenticated. Fail loud before we
  // do any network I/O, so a misconfigured fork doesn't burn API calls before
  // hitting the friendly error.
  await assertClaudeAvailable(config.composer.claudePath);

  const composer = new ClaudeComposer({
    claudePath: config.composer.claudePath,
    model: config.composer.model,
    maxChars: config.composer.maxChars,
    timeoutMs: config.composer.timeoutMs,
  });
  const poster = buildPoster(config);

  const events = await collectEvents(config, state);
  console.log(`[broadcast-bot] collected ${events.length} new events`);

  const lintFailures: RunOnceSummary['lintFailures'] = [];
  let posted = 0;
  let skipped = 0;

  for (const event of events) {
    try {
      const result = await composer.compose(event);
      if (result.lintError) {
        lintFailures.push({ dedupeKey: event.dedupeKey, reason: result.lintError });
        skipped++;
        console.warn(
          `[broadcast-bot] skipping ${event.dedupeKey}: lint failed twice (${result.lintError})`,
        );
        // Don't advance watermark for skipped events — they'll retry next run.
        continue;
      }
      if (config.poster.dryRun) {
        console.log(`[broadcast-bot] dry-run, would post: ${event.dedupeKey}\n${result.text}`);
      } else {
        await poster.post(event, result.text);
      }
      applyEventToState(state, event);
      posted++;
    } catch (err) {
      console.error(`[broadcast-bot] event ${event.dedupeKey} failed:`, (err as Error).message);
      skipped++;
    }
  }

  store.save(state);

  return { posted, skipped, lintFailures };
}

function buildPoster(config: BroadcastConfig): Poster {
  if (config.poster.backend === 'stdout' || config.poster.dryRun) {
    return new StdoutPoster();
  }
  const creds = loadXCredentialsFromEnv();
  return new XPoster(creds);
}

async function collectEvents(
  config: BroadcastConfig,
  state: BotState,
): Promise<BroadcastEvent[]> {
  const gh = makeGithubClient();
  const events: BroadcastEvent[] = [];

  if (config.github.sources.includes('releases')) {
    const releases = await fetchReleases(gh, {
      repo: config.github.repo,
      watermark: state.github.releases.watermark,
      postedIds: new Set(state.github.releases.posted),
    });
    events.push(...releases);
  }

  if (config.github.sources.includes('prs')) {
    const prs = await fetchMergedPrs(gh, {
      repo: config.github.repo,
      baseBranches: config.github.prs.baseBranches,
      excludeAuthors: config.github.prs.excludeAuthors,
      excludePrefixes: config.github.prs.excludePrefixes,
      watermark: state.github.prs.watermark,
      postedIds: new Set(state.github.prs.posted),
    });
    events.push(...prs);
  }

  if (config.github.sources.includes('discussions')) {
    const discussions = await fetchDiscussions(gh, {
      repo: config.github.repo,
      categories: config.github.discussions.categories,
      watermark: state.github.discussions.watermark,
      postedIds: new Set(state.github.discussions.posted),
    });
    events.push(...discussions);
  }

  if (config.onchain.enabled) {
    if (!config.onchain.rpcUrl || !config.onchain.chainId || !config.onchain.contracts.identityRegistry) {
      throw new Error(
        'onchain.enabled = true but onchain.rpc_url, onchain.chain_id, and onchain.contracts.identity_registry must all be set',
      );
    }
    const result = await fetchOnchain({
      rpcUrl: config.onchain.rpcUrl,
      chainId: config.onchain.chainId,
      identityRegistry: config.onchain.contracts.identityRegistry as `0x${string}`,
      sources: config.onchain.sources,
      lastBlock: state.onchain.watermark,
      postedKeys: new Set(state.onchain.posted),
      blockChunk: config.onchain.blockChunk,
    });
    events.push(...result.events);
    if (result.newWatermark != null) {
      state.onchain.watermark = result.newWatermark;
    }
  }

  return events;
}

function applyEventToState(state: BotState, event: BroadcastEvent): void {
  switch (event.type) {
    case 'release':
      advance(state.github.releases, event);
      break;
    case 'pr':
      advance(state.github.prs, event);
      break;
    case 'discussion':
      advance(state.github.discussions, event);
      break;
    case 'solvernet-manifest':
    case 'plugin':
      state.onchain.posted.push(event.dedupeKey);
      break;
  }
}

function advance(s: SourceState<string>, event: BroadcastEvent): void {
  if (!s.watermark || event.timestamp > s.watermark) s.watermark = event.timestamp;
  s.posted.push(event.dedupeKey);
}
