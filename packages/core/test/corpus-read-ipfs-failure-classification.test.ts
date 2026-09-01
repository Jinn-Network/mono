/**
 * Failure classification for the IPFS read path (#3451).
 *
 * Every candidate failure used to arrive as one opaque `Error` whose only structure was a joined
 * message, so a caller could not tell a byte-cap refusal (positive evidence the content EXISTS)
 * from a 404 (genuine absence) from a 503 (nothing learned). These tests pin the three answers;
 * collapsing them back into one turns them red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyIpfsFetchFailure,
  fetchBytesFromIpfs,
  IpfsContentNotFoundError,
  IpfsFetchFailedError,
  IpfsResponseTooLargeError,
} from '../src/corpus-read/ipfs.js';

/** 64 hex chars -- expands to two CID path candidates, so four attempts across two gateways. */
const HEX_CID = 'a'.repeat(64);
const CAP = 8 * 1024 * 1024;

function status(code: number): Response {
  return new Response('nope', { status: code, statusText: 'x' });
}

function oversizedByHeader(): Response {
  return new Response('x', {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(CAP + 1) },
  });
}

/** Runs the real fetch path against a stubbed gateway and returns the thrown error. */
async function failureOf(respond: (attempt: number) => Response): Promise<unknown> {
  let attempt = 0;
  vi.stubGlobal('fetch', vi.fn(async () => respond(attempt++)));
  try {
    await fetchBytesFromIpfs('https://gateway.example', HEX_CID);
    throw new Error('expected the fetch to reject');
  } catch (error) {
    return error;
  }
}

describe('classifyIpfsFetchFailure (#3451)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports a byte-cap refusal as too-large, not as absence', async () => {
    const error = await failureOf(() => oversizedByHeader());
    expect(error).toBeInstanceOf(IpfsFetchFailedError);
    expect(classifyIpfsFetchFailure(error)).toBe('too-large');
  });

  it('reports every-candidate-404 as genuine absence', async () => {
    const error = await failureOf(() => status(404));
    expect(classifyIpfsFetchFailure(error)).toBe('not-found');
  });

  it('reports a transport-class status as unavailable, not as absence', async () => {
    const error = await failureOf(() => status(503));
    expect(classifyIpfsFetchFailure(error)).toBe('unavailable');
  });

  it('lets one size refusal outrank any number of not-found answers', async () => {
    // A size refusal is positive proof the content exists, so it dominates.
    const error = await failureOf((attempt) => (attempt === 0 ? oversizedByHeader() : status(404)));
    expect(classifyIpfsFetchFailure(error)).toBe('too-large');
  });

  it('refuses to call a mixed 404/503 run absence -- one candidate never answered', async () => {
    const error = await failureOf((attempt) => (attempt === 0 ? status(404) : status(503)));
    expect(classifyIpfsFetchFailure(error)).toBe('unavailable');
  });

  it('classifies a bare cause as well as an aggregate', () => {
    expect(classifyIpfsFetchFailure(new IpfsResponseTooLargeError(CAP))).toBe('too-large');
    expect(classifyIpfsFetchFailure(new IpfsContentNotFoundError('gone', 410))).toBe('not-found');
    expect(classifyIpfsFetchFailure(new Error('socket hang up'))).toBe('unavailable');
  });

  it('never calls an empty aggregate absence', () => {
    expect(classifyIpfsFetchFailure(new IpfsFetchFailedError('nothing tried', []))).toBe('unavailable');
  });

  it('keeps the aggregate message shape callers already log', async () => {
    const error = await failureOf(() => status(404));
    expect((error as Error).message).toContain('IPFS raw bytes fetch failed after all candidates');
  });
});
