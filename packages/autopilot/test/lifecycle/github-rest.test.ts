import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  ConditionalRestClient,
  ConditionalRestProtocolError,
  type ConditionalRestCacheEntry,
} from '../../src/lifecycle/github-rest.js';
import { GitHubUsageMeter } from '../../src/lifecycle/github-usage.js';

function included(
  status: 200 | 304,
  body = '',
  headers: readonly string[] = [],
): string {
  return [
    `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Not Modified'}`,
    'etag: "etag-v1"',
    'x-ratelimit-remaining: 4998',
    'x-ratelimit-used: 2',
    'x-ratelimit-reset: 1784725200',
    'x-ratelimit-resource: core',
    ...(status === 200 ? ['content-type: application/json; charset=utf-8'] : []),
    ...headers,
    '',
    body,
  ].join('\r\n');
}

function commandFailure(stdout?: string): Error & {
  readonly stdout?: string;
  readonly stderr: string;
  readonly code: number;
} {
  return Object.assign(new Error('Command failed: gh api --include'), {
    ...(stdout === undefined ? {} : { stdout }),
    stderr: 'gh: HTTP 304',
    code: 1,
  });
}

describe('ConditionalRestClient', () => {
  it('uses the pinned API version and decodes one strict 200 page', async () => {
    const calls: string[][] = [];
    const meter = new GitHubUsageMeter();
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      return included(200, '[{"number":42}]', [
        'link: <https://api.github.com/repos/Jinn-Network/mono/issues?per_page=100&page=2>; rel="next"',
      ]);
    };
    const client = new ConditionalRestClient(run, { usageMeter: meter });

    await expect(client.getJson('repos/Jinn-Network/mono/issues?per_page=100&page=1'))
      .resolves.toMatchObject({
        body: [{ number: 42 }],
        etag: '"etag-v1"',
        status: 200,
        nextEndpoint: 'repos/Jinn-Network/mono/issues?per_page=100&page=2',
        rateLimit: { remaining: 4_998, used: 2 },
      });
    expect(calls).toEqual([[
      'api',
      '--include',
      'repos/Jinn-Network/mono/issues?per_page=100&page=1',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
    ]]);
    expect(meter.read()).toMatchObject({ restRequests: 1, restNotModified: 0, cacheHits: 0 });
  });

  it('sends If-None-Match and reuses a valid cached representation on 304', async () => {
    const calls: string[][] = [];
    const responses = [included(200, '{"changed":false}'), included(304)];
    const meter = new GitHubUsageMeter();
    const client = new ConditionalRestClient(async (_command, args) => {
      calls.push(args);
      return responses.shift()!;
    }, { usageMeter: meter });

    const first = await client.getJson('repos/Jinn-Network/mono/issues/42');
    const second = await client.getJson('repos/Jinn-Network/mono/issues/42');

    expect(second).toMatchObject({
      body: first.body,
      status: 304,
      etag: '"etag-v1"',
    });
    expect(calls[1]).toContain('If-None-Match: "etag-v1"');
    expect(meter.read()).toMatchObject({ restRequests: 2, restNotModified: 1, cacheHits: 1 });
  });

  it.each([
    ['weak to strong', 'W/"opaque"', '"opaque"'],
    ['strong to weak', '"opaque"', 'W/"opaque"'],
  ] as const)(
    'recovers a thrown gh 304 with %s ETag equivalence and adopts the response validator',
    async (_label, cachedEtag, responseEtag) => {
      const endpoint = 'repos/Jinn-Network/mono/issues/42';
      const meter = new GitHubUsageMeter();
      let call = 0;
      const client = new ConditionalRestClient(async () => {
        call += 1;
        if (call === 1) {
          return included(200, '{"changed":false}')
            .replace('etag: "etag-v1"', `etag: ${cachedEtag}`);
        }
        throw commandFailure(
          included(304).replace('etag: "etag-v1"', `etag: ${responseEtag}`),
        );
      }, { usageMeter: meter });
      await client.getJson(endpoint);
      meter.reset();

      await expect(client.getJson(endpoint)).resolves.toMatchObject({
        body: { changed: false },
        status: 304,
        etag: responseEtag,
      });
      expect(meter.read()).toMatchObject({
        restRequests: 1,
        restNotModified: 1,
        cacheHits: 1,
      });
      expect(client.exportCache()).toEqual([{
        endpoint,
        etag: responseEtag,
        body: '{"changed":false}',
        nextEndpoint: null,
      }]);
    },
  );

  it('rejects a thrown 304 whose opaque ETag does not match the cached validator', async () => {
    const endpoint = 'repos/Jinn-Network/mono/issues/42';
    const meter = new GitHubUsageMeter();
    let call = 0;
    const client = new ConditionalRestClient(async () => {
      call += 1;
      if (call === 1) {
        return included(200, '{}').replace('etag: "etag-v1"', 'etag: W/"cached"');
      }
      throw commandFailure(included(304).replace('etag: "etag-v1"', 'etag: "different"'));
    }, { usageMeter: meter });
    await client.getJson(endpoint);
    meter.reset();

    await expect(client.getJson(endpoint)).rejects.toThrow(/304.*matching cache/i);
    expect(meter.read()).toMatchObject({
      restRequests: 1,
      restNotModified: 1,
      cacheHits: 0,
    });
    expect(client.exportCache()[0]?.etag).toBe('W/"cached"');
  });

  it.each([
    ['non-304 included response', commandFailure(
      included(200, '{}').replace('200 OK', '500 Internal Server Error'),
    )],
    ['malformed included stdout', commandFailure('HTTP/2.0 304 Not Modified\r\nbroken')],
    ['missing stdout', commandFailure()],
  ] as const)('does not recover a thrown command with %s', async (_label, failure) => {
    const client = new ConditionalRestClient(async () => {
      throw failure;
    });

    await expect(client.getJson('repos/Jinn-Network/mono/issues/42')).rejects.toBe(failure);
  });

  it.each([
    ['missing rate-limit header', included(304).replace(
      'x-ratelimit-remaining: 4998\r\n',
      '',
    )],
    ['non-empty body', included(304, '{}')],
  ] as const)('fails closed on a thrown 304 with %s', async (_label, stdout) => {
    const endpoint = 'repos/Jinn-Network/mono/issues/42';
    const cache = new Map<string, ConditionalRestCacheEntry>([[endpoint, {
      etag: '"etag-v1"',
      body: '{}',
      nextEndpoint: null,
    }]]);
    const client = new ConditionalRestClient(async () => {
      throw commandFailure(stdout);
    }, { cache });

    await expect(client.getJson(endpoint)).rejects.toBeInstanceOf(ConditionalRestProtocolError);
    expect(client.exportCache()[0]?.etag).toBe('"etag-v1"');
  });

  it('rejects a 304 without a matching valid cached body', async () => {
    const cache = new Map<string, ConditionalRestCacheEntry>();
    const endpoint = 'repos/Jinn-Network/mono/issues/42';
    cache.set(endpoint, { etag: '"etag-v1"', body: '{broken', nextEndpoint: null });
    const client = new ConditionalRestClient(async () => included(304), { cache });

    await expect(client.getJson(endpoint)).rejects.toThrow(/cached.*JSON|cache/i);
    await expect(new ConditionalRestClient(async () => included(304)).getJson(endpoint))
      .rejects.toThrow(/304.*cache/i);
  });

  it('rejects corrupted cached pagination metadata before reusing a 304', async () => {
    const endpoint = 'repos/Jinn-Network/mono/issues/42';
    const cache = new Map<string, ConditionalRestCacheEntry>([[endpoint, {
      etag: '"etag-v1"',
      body: '{}',
      nextEndpoint: 'https://example.com/steal',
    }]]);
    const client = new ConditionalRestClient(async () => included(304), { cache });

    await expect(client.getJson(endpoint)).rejects.toThrow(/cache|endpoint/i);
  });

  it('exports and restores exact conditional representations across a restart', async () => {
    const endpoint = 'repos/Jinn-Network/mono/issues?per_page=100&page=1';
    const first = new ConditionalRestClient(async () => included(200, '[{"number":42}]'));
    await first.getJson(endpoint);

    const persisted = first.exportCache();
    const calls: string[][] = [];
    const restarted = new ConditionalRestClient(async (_command, args) => {
      calls.push(args);
      return included(304);
    });
    restarted.restoreCache(persisted);

    await expect(restarted.getJson(endpoint)).resolves.toMatchObject({
      body: [{ number: 42 }],
      status: 304,
    });
    expect(calls[0]).toContain('If-None-Match: "etag-v1"');
    expect(persisted).toEqual([{
      endpoint,
      etag: '"etag-v1"',
      body: '[{"number":42}]',
      nextEndpoint: null,
    }]);
  });

  it('rejects an invalid restored representation atomically', async () => {
    const endpoint = 'repos/Jinn-Network/mono/issues/42';
    const client = new ConditionalRestClient(async () => included(304));

    expect(() => client.restoreCache([{
      endpoint,
      etag: 'not-an-etag',
      body: '{}',
      nextEndpoint: null,
    }])).toThrow(/ETag/i);
    expect(client.exportCache()).toEqual([]);
  });

  it.each([
    ['malformed status', 'status: 200\r\netag: "x"\r\n\r\n{}'],
    ['unexpected status', included(200, '{}').replace('200 OK', '204 No Content')],
    ['missing ETag', included(200, '{}').replace('etag: "etag-v1"\r\n', '')],
    ['duplicate ETag', included(200, '{}', ['ETag: "other"'])],
    ['wrong content type', included(200, '{}').replace('application/json', 'text/plain')],
    ['malformed JSON', included(200, '{broken')],
    ['unexpected rate-limit resource', included(200, '{}').replace(
      'x-ratelimit-resource: core',
      'x-ratelimit-resource: search',
    )],
    ['304 with body', included(304, '{}')],
    [
      'foreign next link',
      included(200, '[]', ['link: <https://example.com/page/2>; rel="next"']),
    ],
  ])('fails closed on %s', async (_label, raw) => {
    const client = new ConditionalRestClient(async () => raw);

    await expect(client.getJson('repos/Jinn-Network/mono/issues')).rejects.toThrow();
  });
});
