import { describe, it, expect } from 'vitest';
import { fetchAttemptedInstanceIds } from '../../src/eval/screen-discovery.js';

type Page = { items: { instanceId: string }[]; hasNextPage: boolean; endCursor: string | null };

function pagedFetch(pages: Page[]): typeof fetch {
  let call = 0;
  return (async () => {
    const p = pages[Math.min(call++, pages.length - 1)];
    return new Response(
      JSON.stringify({ data: { verdictEnvelopeMetas: { items: p.items, pageInfo: { hasNextPage: p.hasNextPage, endCursor: p.endCursor } } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('fetchAttemptedInstanceIds', () => {
  it('collects instanceIds across pages and dedupes', async () => {
    const ids = await fetchAttemptedInstanceIds('https://idx.example', 'cid', pagedFetch([
      { items: [{ instanceId: 'a' }, { instanceId: 'b' }], hasNextPage: true, endCursor: 'c1' },
      { items: [{ instanceId: 'b' }, { instanceId: 'c' }], hasNextPage: false, endCursor: null },
    ]));
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
  });

  it('appends /graphql when the url lacks it', async () => {
    let seen = '';
    const f = (async (u: string) => {
      seen = u;
      return new Response(JSON.stringify({ data: { verdictEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await fetchAttemptedInstanceIds('https://idx.example/', 'cid', f);
    expect(seen).toBe('https://idx.example/graphql');
  });

  it('throws on HTTP error (never silently returns an empty set)', async () => {
    const f = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchAttemptedInstanceIds('https://idx.example', 'cid', f)).rejects.toThrow(/HTTP 503/);
  });

  it('throws on GraphQL errors', async () => {
    const f = (async () => new Response(JSON.stringify({ errors: [{ message: 'bad' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(fetchAttemptedInstanceIds('https://idx.example', 'cid', f)).rejects.toThrow(/query errors/);
  });
});
