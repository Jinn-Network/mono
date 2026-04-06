/**
 * Unit Test: Credential Filter (Worker-Side)
 * Module: jinn-node/src/worker/filters/credentialFilter.ts
 *
 * Tests pure functions: getRequiredCredentials, isJobEligibleForWorker,
 * jobRequiresCredentials, and TOOL_CREDENTIAL_MAP coverage.
 */

import { describe, expect, it } from 'vitest';
import {
  TOOL_CREDENTIAL_MAP,
  getRequiredCredentials,
  isJobEligibleForWorker,
  jobRequiresCredentials,
} from '../../../../jinn-node/src/worker/filters/credentialFilter.js';

describe('TOOL_CREDENTIAL_MAP', () => {
  it('does not map GitHub tools (operator-level, not bridge-scoped)', () => {
    expect(TOOL_CREDENTIAL_MAP['get_file_contents']).toBeUndefined();
    expect(TOOL_CREDENTIAL_MAP['search_code']).toBeUndefined();
    expect(TOOL_CREDENTIAL_MAP['list_commits']).toBeUndefined();
  });

  it('maps Telegram tools to telegram provider', () => {
    expect(TOOL_CREDENTIAL_MAP['telegram_send_message']).toEqual(['telegram']);
  });

  it('maps Twitter tools to twitter provider', () => {
    expect(TOOL_CREDENTIAL_MAP['twitter_post_tweet']).toEqual(['twitter']);
    expect(TOOL_CREDENTIAL_MAP['twitter_get_mentions']).toEqual(['twitter']);
    expect(TOOL_CREDENTIAL_MAP['twitter_get_timeline']).toEqual(['twitter']);
  });

  it('maps Umami tools to umami provider', () => {
    expect(TOOL_CREDENTIAL_MAP['blog_get_stats']).toEqual(['umami']);
  });

  it('maps OpenAI tools to openai provider', () => {
    expect(TOOL_CREDENTIAL_MAP['embed_text']).toEqual(['openai']);
    expect(TOOL_CREDENTIAL_MAP['search_similar_situations']).toEqual(['openai']);
  });

  it('maps meta-tools to correct providers', () => {
    expect(TOOL_CREDENTIAL_MAP['telegram_messaging']).toEqual(['telegram']);
    expect(TOOL_CREDENTIAL_MAP['fireflies_meetings']).toEqual(['fireflies']);
    expect(TOOL_CREDENTIAL_MAP['railway_deployment']).toEqual(['railway']);
  });
});

describe('getRequiredCredentials', () => {
  it('returns empty array for tools with no credential mapping', () => {
    expect(getRequiredCredentials(['unknown_tool', 'another_tool'])).toEqual([]);
  });

  it('returns unique providers for tools', () => {
    const result = getRequiredCredentials([
      'telegram_send_message',
      'telegram_send_photo',
      'twitter_post_tweet',
    ]);
    expect(result).toHaveLength(2);
    expect(result).toContain('telegram');
    expect(result).toContain('twitter');
  });

  it('deduplicates providers from same-provider tools', () => {
    const result = getRequiredCredentials([
      'blog_get_stats',
      'blog_get_top_pages',
      'blog_get_referrers',
    ]);
    expect(result).toEqual(['umami']);
  });

  it('returns empty array for empty tools list', () => {
    expect(getRequiredCredentials([])).toEqual([]);
  });
});

describe('isJobEligibleForWorker', () => {
  it('returns true when job has no tools', () => {
    expect(isJobEligibleForWorker(undefined, new Set(['github']))).toBe(true);
    expect(isJobEligibleForWorker([], new Set(['github']))).toBe(true);
  });

  it('returns true when job requires no credentials', () => {
    expect(isJobEligibleForWorker(['unknown_tool'], new Set())).toBe(true);
  });

  it('returns true when worker has all required credentials', () => {
    expect(isJobEligibleForWorker(
      ['twitter_post_tweet', 'telegram_send_message'],
      new Set(['twitter', 'telegram', 'openai']),
    )).toBe(true);
  });

  it('returns false when worker is missing a required credential', () => {
    expect(isJobEligibleForWorker(
      ['twitter_post_tweet', 'telegram_send_message'],
      new Set(['twitter']), // missing telegram
    )).toBe(false);
  });

  it('returns false when worker has no credentials but job requires some', () => {
    expect(isJobEligibleForWorker(
      ['telegram_send_message'],
      new Set(),
    )).toBe(false);
  });
});

describe('jobRequiresCredentials', () => {
  it('returns false for no tools', () => {
    expect(jobRequiresCredentials(undefined)).toBe(false);
    expect(jobRequiresCredentials([])).toBe(false);
  });

  it('returns false for tools with no credential mapping', () => {
    expect(jobRequiresCredentials(['unknown_tool'])).toBe(false);
  });

  it('returns true for tools that require credentials', () => {
    expect(jobRequiresCredentials(['twitter_post_tweet'])).toBe(true);
    expect(jobRequiresCredentials(['telegram_send_message'])).toBe(true);
  });
});
