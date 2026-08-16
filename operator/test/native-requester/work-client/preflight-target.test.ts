import { describe, expect, it } from 'vitest';
import { RequesterError } from '../../../src/native-requester/work-client/errors.js';
import { selectLiveTarget } from '../../../src/native-requester/work-client/preflight/target.js';

const repo = { postingKey: 'repo', workKind: 'repository-work', profileUri: 'urn:p:1', live: true };
const evalNet = { postingKey: 'eval', workKind: 'evaluation', profileUri: 'urn:p:2', live: true };
const dark = { postingKey: 'dark', workKind: 'repository-work', profileUri: 'urn:p:1', live: false };

function codeOf(run: () => unknown): string {
  try {
    run();
    throw new Error('expected a throw');
  } catch (err) {
    expect(err).toBeInstanceOf(RequesterError);
    return (err as RequesterError).code;
  }
}

describe('selectLiveTarget', () => {
  it('selects the single live candidate', () => {
    expect(selectLiveTarget({ candidates: [repo, dark] }).postingKey).toBe('repo');
  });

  it('honors an explicit posting key', () => {
    expect(
      selectLiveTarget({ candidates: [repo, evalNet], explicitPostingKey: 'eval' }).postingKey,
    ).toBe('eval');
  });

  it('rejects an unknown explicit key', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [repo], explicitPostingKey: 'nope' })))
      .toBe('explicit-unknown');
  });

  it('rejects an explicit key that is not live', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [repo, dark], explicitPostingKey: 'dark' })))
      .toBe('explicit-not-live');
  });

  it('narrows by work kind', () => {
    expect(
      selectLiveTarget({ candidates: [repo, evalNet], requestedWorkKind: 'evaluation' }).postingKey,
    ).toBe('eval');
  });

  it('refuses to guess between two live candidates', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [repo, evalNet] }))).toBe('ambiguous-target');
  });

  it('reports an empty live set distinctly', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [dark] }))).toBe('no-live-target');
  });
});
