/**
 * A gateway base that carries a query string (#3452).
 *
 * `normalizeIpfsGatewayBase` did string surgery on the raw base, so
 * `https://gw.example/ipfs?apiKey=SECRET` became
 * `https://gw.example/ipfs?apiKey=SECRET/ipfs/` — the CID landed inside the
 * query and the #3440 prefix guard refused the candidate, naming the wrong
 * cause. Normalizing through `URL` fixes the shape; re-attaching the base's
 * query in `resolveGatewayCandidateUrl` is what makes an authenticated gateway
 * actually reachable, because `new URL(cidPath, base)` drops the base's query
 * unconditionally.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytesFromIpfs, normalizeIpfsGatewayBase } from '../src/corpus-read/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

function ok(): Response {
  return new Response('payload', { status: 200, headers: { 'content-type': 'text/plain' } });
}

/** Every URL handed to `fetch` for one primary-only read. */
async function requestedUrls(gatewayBase: string, cid = CID): Promise<string[]> {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return ok();
    }),
  );
  await fetchBytesFromIpfs(gatewayBase, cid, { fallbackGatewayBase: false }).catch(() => undefined);
  return requested;
}

describe('normalizeIpfsGatewayBase (#3452)', () => {
  // Query-free shapes: every one of these must be byte-identical to the
  // pre-#3452 output. They are the regression fence for AC2.
  const unchanged: Array<readonly [string, string]> = [
    ['https://gw.example', 'https://gw.example/ipfs/'],
    ['https://gw.example/', 'https://gw.example/ipfs/'],
    ['https://gw.example/ipfs', 'https://gw.example/ipfs/'],
    ['https://gw.example/ipfs/', 'https://gw.example/ipfs/'],
    ['https://gw.example/ipfs///', 'https://gw.example/ipfs/'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/ipfs/'],
    ['https://proj:SECRET@gw.example', 'https://gw.example/ipfs/'],
    ['', 'https://gateway.autonolas.tech/ipfs/'],
    // Not an absolute URL: the raw-string path stays exactly as it was, so the
    // candidate still fails as `candidate URL could not be parsed` rather than
    // escaping as a bare TypeError (`corpus-read-ipfs-bounds.test.ts`).
    ['not-a-url', 'not-a-url/ipfs/'],
    ['ipfs://QmFoo', 'ipfs://QmFoo/ipfs/'],
  ];

  for (const [input, expected] of unchanged) {
    it(`leaves ${input === '' ? '(empty)' : input} unchanged`, () => {
      expect(normalizeIpfsGatewayBase(input)).toBe(expected);
    });
  }

  const fixed: Array<readonly [string, string]> = [
    ['https://gw.example/ipfs?k=S', 'https://gw.example/ipfs/?k=S'],
    ['https://gw.example/gw?a=1', 'https://gw.example/gw/ipfs/?a=1'],
    ['https://gw.example?a=1', 'https://gw.example/ipfs/?a=1'],
    // A fragment is never transmitted, and today it corrupts the `/ipfs`
    // suffix test into appending a second segment. Dropping it is the only
    // reading that is both correct and lossless in transit.
    ['https://gw.example/ipfs#frag', 'https://gw.example/ipfs/'],
    ['https://proj:SECRET@gw.example/ipfs?apiKey=KEY', 'https://gw.example/ipfs/?apiKey=KEY'],
  ];

  for (const [input, expected] of fixed) {
    it(`puts the CID path before the query for ${input}`, () => {
      expect(normalizeIpfsGatewayBase(input)).toBe(expected);
    });
  }
});

describe('gateway base query reaches the wire (#3452)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the CID on the path and the base query as a query', async () => {
    const requested = await requestedUrls('https://gw.example/ipfs?apiKey=SECRET');

    expect(requested).toEqual([`https://gw.example/ipfs/${CID}?apiKey=SECRET`]);
  });

  it('appends /ipfs to a query-bearing base that lacks it', async () => {
    const requested = await requestedUrls('https://gw.example/gw?a=1');

    expect(requested).toEqual([`https://gw.example/gw/ipfs/${CID}?a=1`]);
  });

  it('keeps the base query while still dropping embedded credentials', async () => {
    const requested = await requestedUrls('https://proj:SECRET@gw.example/ipfs?apiKey=KEY');

    expect(requested).toEqual([`https://gw.example/ipfs/${CID}?apiKey=KEY`]);
  });

  it('issues an unchanged request for every query-free base', async () => {
    for (const [base, expected] of [
      ['https://gw.example', `https://gw.example/ipfs/${CID}`],
      ['https://gw.example/', `https://gw.example/ipfs/${CID}`],
      ['https://gw.example/ipfs', `https://gw.example/ipfs/${CID}`],
      ['https://gw.example/ipfs/', `https://gw.example/ipfs/${CID}`],
      ['http://127.0.0.1:8080', `http://127.0.0.1:8080/ipfs/${CID}`],
      ['https://proj:SECRET@gw.example', `https://gw.example/ipfs/${CID}`],
    ] as const) {
      expect(await requestedUrls(base)).toEqual([expected]);
      vi.restoreAllMocks();
    }
  });

  it('still reports an unparseable base without contacting anything', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return ok();
      }),
    );

    await expect(
      fetchBytesFromIpfs('not-a-url', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/primary: candidate URL could not be parsed/);

    expect(requested).toEqual([]);
  });

  it('does not let a manifest CID path override the base query', async () => {
    // Two query strings cannot be merged unambiguously, and the CID path is
    // manifest-supplied — so the operator's gateway credentials win.
    const requested = await requestedUrls('https://gw.example/ipfs?apiKey=SECRET', `${CID}?evil=1`);

    expect(requested).toEqual([`https://gw.example/ipfs/${CID}?apiKey=SECRET`]);
  });
});
