// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import * as github from '../../../src/task-creator/environment/github.js';

type Checker = {
  check(input: { repo: string; baseCommit: string }): Promise<unknown>;
};
type CheckerFactory = (input: {
  fetchImpl: (input: string, init?: { headers?: Record<string, string> }) => Promise<unknown>;
  token?: string;
}) => Checker;

function factoryOrFail(): CheckerFactory | null {
  const factory = (github as Record<string, unknown>)['createGitHubRepoPublicationChecker'];
  expect(factory).toBeTypeOf('function');
  return typeof factory === 'function' ? factory as CheckerFactory : null;
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

describe('GitHub repository publication checker', () => {
  it('uses injected fetch to bind public SPDX evidence to the exact input commit', async () => {
    const factory = factoryOrFail();
    if (!factory) return;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ visibility: 'public', private: false }))
      .mockResolvedValueOnce(response({ license: { spdx_id: 'MIT' } }));
    const baseCommit = 'a'.repeat(40);

    const result = await factory({ fetchImpl, token: 'test-token' }).check({
      repo: 'unjs/destr',
      baseCommit,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://api.github.com/repos/unjs/destr', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer test-token',
      },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/unjs/destr/license?ref=${baseCommit}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer test-token',
        },
      },
    );
    expect(result).toEqual({
      inputRef: `git+https://github.com/unjs/destr.git#${baseCommit}`,
      locator: 'github:unjs/destr',
      visibility: 'public',
      licenseSpdxId: 'MIT',
      evidenceRef: `https://api.github.com/repos/unjs/destr/license?ref=${baseCommit}`,
    });
  });

  it('fails closed when GitHub returns malformed or non-OK evidence', async () => {
    const factory = factoryOrFail();
    if (!factory) return;
    const malformed = vi.fn().mockResolvedValue(response({ visibility: 'public' }));
    const nonOk = vi.fn().mockResolvedValue(response({}, 404));

    await expect(factory({ fetchImpl: malformed }).check({
      repo: 'unjs/destr',
      baseCommit: 'b'.repeat(40),
    })).rejects.toThrow(/malformed GitHub repository metadata/i);
    await expect(factory({ fetchImpl: nonOk }).check({
      repo: 'unjs/destr',
      baseCommit: 'b'.repeat(40),
    })).rejects.toThrow(/GitHub repository metadata request failed/i);
  });
});
