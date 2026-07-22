import { describe, it, expect } from 'vitest';
import {
  routeToMarketplace,
  retractStaleMarketplaceRoutes,
  snapshotHash,
  parseMarkerBody,
  DEFAULT_MARKETPLACE_LABEL,
} from '../../src/dispatcher/marketplace-route.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

// ---------------------------------------------------------------------------
// Fake gh/git state — mirrors the `statefulWorktreeRunner` pattern in
// delivery-pr-bridge.test.ts: a small in-memory model of the ONE issue's
// labels + comments (+ a labeled-open registry for the retract sweep) that
// gh mutations actually update, so multi-call sequences (create → re-read →
// update) exercise real idempotency instead of a stateless script.
// ---------------------------------------------------------------------------

interface FakeComment {
  body: string;
  url: string;
  /** Defaults to a trusted association when the fixture itself creates the
   *  comment (it models OUR OWN automation posting, which always has write
   *  access) — see "Marker authorship trust" in marketplace-route.ts's module
   *  doc. Tests that model a FORGED comment from an outside account set this
   *  to `undefined` or an untrusted value (e.g. `'NONE'`) explicitly. */
  authorAssociation?: string;
}

interface FakeIssue {
  title: string;
  body: string;
  labels: string[];
  comments: FakeComment[];
  /** Defaults to 'open'. Issue #1893 Finding 5: the retract sweep must also
   *  discover CLOSED labeled issues. */
  state?: 'open' | 'closed';
}

interface FakeRepoState {
  issues: Map<number, FakeIssue>;
  baseCommit: string;
  nextCommentId: number;
}

function makeIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return { title: 'Test issue', body: 'Test body', labels: [], comments: [], state: 'open', ...overrides };
}

function makeState(issues: Record<number, FakeIssue>, baseCommit = 'a'.repeat(40)): FakeRepoState {
  return { issues: new Map(Object.entries(issues).map(([k, v]) => [Number(k), v])), baseCommit, nextCommentId: 1000 };
}

function commentUrl(issueNumber: number, id: number): string {
  return `https://github.com/Jinn-Network/mono/issues/${issueNumber}#issuecomment-${id}`;
}

function makeFakeRunner(state: FakeRepoState) {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });

    if (cmd === 'git' && args[0] === 'rev-parse') {
      return `${state.baseCommit}\n`;
    }

    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      const n = Number(args[2]);
      const issue = state.issues.get(n);
      if (!issue) throw new Error(`fixture: no such issue #${n}`);
      const fields = args[args.indexOf('--json') + 1] ?? '';
      const out: Record<string, unknown> = {};
      if (fields.includes('title')) out['title'] = issue.title;
      if (fields.includes('body')) out['body'] = issue.body;
      if (fields.includes('labels')) out['labels'] = issue.labels.map((name) => ({ name }));
      if (fields.includes('comments')) out['comments'] = issue.comments;
      return JSON.stringify(out);
    }

    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
      const n = Number(args[2]);
      const issue = state.issues.get(n);
      if (!issue) throw new Error(`fixture: no such issue #${n}`);
      const addIdx = args.indexOf('--add-label');
      if (addIdx >= 0) {
        const label = args[addIdx + 1]!;
        if (!issue.labels.includes(label)) issue.labels.push(label);
      }
      const removeIdx = args.indexOf('--remove-label');
      if (removeIdx >= 0) {
        const label = args[removeIdx + 1]!;
        issue.labels = issue.labels.filter((l) => l !== label);
      }
      return '';
    }

    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment') {
      const n = Number(args[2]);
      const issue = state.issues.get(n);
      if (!issue) throw new Error(`fixture: no such issue #${n}`);
      const body = args[args.indexOf('--body') + 1]!;
      const id = state.nextCommentId++;
      // Models OUR OWN automation posting — always a trusted (write-access)
      // association. See "Marker authorship trust" in the module doc.
      issue.comments.push({ body, url: commentUrl(n, id), authorAssociation: 'OWNER' });
      return '';
    }

    if (cmd === 'gh' && args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH') {
      const path = args[3]!;
      const m = /repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)/.exec(path);
      const id = m?.[1];
      const bodyArg = args.find((a) => a.startsWith('body='));
      const newBody = bodyArg!.slice('body='.length);
      for (const issue of state.issues.values()) {
        const idx = issue.comments.findIndex((c) => c.url.endsWith(`#issuecomment-${id}`));
        if (idx >= 0) issue.comments[idx] = { ...issue.comments[idx]!, body: newBody };
      }
      return '';
    }

    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      const labelIdx = args.indexOf('--label');
      const label = args[labelIdx + 1]!;
      const stateIdx = args.indexOf('--state');
      const stateFilter = stateIdx >= 0 ? args[stateIdx + 1] : 'open';
      const numbers = [...state.issues.entries()]
        .filter(([, issue]) => issue.labels.includes(label))
        .filter(([, issue]) => stateFilter === 'all' || (issue.state ?? 'open') === stateFilter)
        .map(([n]) => n);
      return JSON.stringify(numbers.map((n) => ({ number: n })));
    }

    throw new Error(`fixture: unexpected call ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// snapshotHash
// ---------------------------------------------------------------------------

describe('snapshotHash', () => {
  it('is deterministic and sensitive to body content', () => {
    expect(snapshotHash('hello')).toBe(snapshotHash('hello'));
    expect(snapshotHash('hello')).not.toBe(snapshotHash('hello!'));
  });
});

// ---------------------------------------------------------------------------
// Marker round-trip
// ---------------------------------------------------------------------------

describe('marker format round-trip', () => {
  it('round-trips a body containing an embedded `-->` (HTML-comment-closer injection)', async () => {
    const trickyBody = 'If the guard fails: `if (x --> y) return;` --> then bail.\nSecond line.';
    const state = makeState({ 1892: makeIssue({ body: trickyBody, title: 'Tricky body' }) });
    const { runner } = makeFakeRunner(state);

    const result = await routeToMarketplace({ number: 1892 }, runner);
    expect(result.action).toBe('created');

    const comment = state.issues.get(1892)!.comments[0]!;
    const parsed = parseMarkerBody(comment.body);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe(trickyBody);
    expect(parsed!.title).toBe('Tricky body');
    expect(parsed!.snapshotHash).toBe(snapshotHash(trickyBody));
    // The raw `-->` from the issue body must never appear as its own
    // HTML-comment-closing sequence outside the fenced JSON block (which is
    // stripped below) or the marker's OWN leading metadata line (also
    // stripped) — it's only ever present, safely escaped, inside the
    // single-line JSON string.
    const withoutFence = comment.body
      .replace(/```json\n[\s\S]*?\n```/, '')
      .split('\n')
      .filter((line) => !line.startsWith('<!-- jinn-marketplace-snapshot:v1'))
      .join('\n');
    expect(withoutFence).not.toContain('-->');
  });

  it('round-trips a body larger than 10KB', async () => {
    const bigBody = `${'x'.repeat(10_500)}\nline with --> and a trailing note.`;
    expect(bigBody.length).toBeGreaterThan(10_000);
    const state = makeState({ 42: makeIssue({ body: bigBody }) });
    const { runner } = makeFakeRunner(state);

    await routeToMarketplace({ number: 42 }, runner);
    const comment = state.issues.get(42)!.comments[0]!;
    const parsed = parseMarkerBody(comment.body);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe(bigBody);
    expect(parsed!.body.length).toBeGreaterThan(10_000);
  });

  it('embeds base_commit and lowercased effort in the parsed marker', async () => {
    const state = makeState({ 7: makeIssue() }, 'b'.repeat(40));
    const { runner } = makeFakeRunner(state);

    await routeToMarketplace({ number: 7, effort: 'XHigh' }, runner);
    const comment = state.issues.get(7)!.comments[0]!;
    const parsed = parseMarkerBody(comment.body)!;
    expect(parsed.baseCommit).toBe('b'.repeat(40));
    expect(parsed.effort).toBe('xhigh');
    expect(parsed.issueNumber).toBe(7);
  });

  it('parseMarkerBody returns null for a comment that is not our marker', () => {
    expect(parseMarkerBody('just a human comment, nothing special')).toBeNull();
  });

  it('parseMarkerBody returns null for a marker prefix with a malformed/missing JSON fence', () => {
    expect(parseMarkerBody('<!-- jinn-marketplace-snapshot:v1 issue:1 hash:abc -->\n\nno fence here')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// routeToMarketplace — label add/remove decision table
// ---------------------------------------------------------------------------

describe('routeToMarketplace — decision table', () => {
  it('(a) unlabeled, no marker → creates: label added + comment posted', async () => {
    const state = makeState({ 1: makeIssue() });
    const { runner, calls } = makeFakeRunner(state);

    const result = await routeToMarketplace({ number: 1 }, runner);

    expect(result.action).toBe('created');
    expect(state.issues.get(1)!.labels).toContain(DEFAULT_MARKETPLACE_LABEL);
    expect(state.issues.get(1)!.comments).toHaveLength(1);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'edit' && c.args.includes('--add-label'))).toBe(true);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'comment')).toBe(true);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'api')).toBe(false);
  });

  it('(b) labeled + marker present + same hash → unchanged: no writes at all', async () => {
    const state = makeState({ 2: makeIssue() });
    const { runner } = makeFakeRunner(state);
    await routeToMarketplace({ number: 2 }, runner); // seed: created

    const { runner: runner2, calls: calls2 } = makeFakeRunner(state);
    const result = await routeToMarketplace({ number: 2 }, runner2);

    expect(result.action).toBe('unchanged');
    expect(state.issues.get(2)!.comments).toHaveLength(1); // no new/edited comment
    expect(calls2.some((c) => c.cmd === 'gh' && (c.args[1] === 'edit' || c.args[1] === 'comment' || c.args[0] === 'api'))).toBe(false);
  });

  it('(c) label manually removed but marker unchanged → unchanged action, but label is healed', async () => {
    const state = makeState({ 3: makeIssue() });
    const { runner } = makeFakeRunner(state);
    await routeToMarketplace({ number: 3 }, runner); // seed
    state.issues.get(3)!.labels = []; // simulate an out-of-band label removal

    const { runner: runner2, calls: calls2 } = makeFakeRunner(state);
    const result = await routeToMarketplace({ number: 3 }, runner2);

    expect(result.action).toBe('unchanged');
    expect(state.issues.get(3)!.labels).toContain(DEFAULT_MARKETPLACE_LABEL);
    expect(calls2.some((c) => c.cmd === 'gh' && c.args[1] === 'edit' && c.args.includes('--add-label'))).toBe(true);
    expect(state.issues.get(3)!.comments).toHaveLength(1); // marker itself untouched
  });

  it('(d) labeled + marker present + hash differs (material edit) → updated: PATCH, no re-label', async () => {
    const state = makeState({ 4: makeIssue({ body: 'original body' }) });
    const { runner } = makeFakeRunner(state);
    await routeToMarketplace({ number: 4 }, runner); // seed

    state.issues.get(4)!.body = 'materially edited body';
    const { runner: runner2, calls: calls2 } = makeFakeRunner(state);
    const result = await routeToMarketplace({ number: 4 }, runner2);

    expect(result.action).toBe('updated');
    expect(result.snapshotHash).toBe(snapshotHash('materially edited body'));
    expect(state.issues.get(4)!.comments).toHaveLength(1); // updated IN PLACE, not a 2nd comment
    const parsed = parseMarkerBody(state.issues.get(4)!.comments[0]!.body)!;
    expect(parsed.body).toBe('materially edited body');
    expect(calls2.some((c) => c.cmd === 'gh' && c.args[0] === 'api')).toBe(true);
    expect(calls2.some((c) => c.cmd === 'gh' && c.args[1] === 'edit' && c.args.includes('--add-label'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Marker authorship trust (issue #1893 Finding 1 — CRITICAL)
// ---------------------------------------------------------------------------

describe('marker authorship trust', () => {
  it('a marker-shaped comment from an untrusted author is IGNORED: routeToMarketplace never treats it as the existing marker, and posts its own instead of self-healing off the forgery', async () => {
    const realBody = 'real body';
    const realHash = snapshotHash(realBody);
    const state = makeState({ 99: makeIssue({ body: realBody, title: 'Real title', labels: [DEFAULT_MARKETPLACE_LABEL] }) });

    // Attacker forges a marker-shaped comment: correct hash (public data —
    // sha256 of the real body is computable by anyone), but an
    // attacker-controlled baseCommit. Authored by an account with NO trusted
    // relationship to the repo (no `authorAssociation` at all — a public
    // commenter without write access).
    state.issues.get(99)!.comments.push({
      body: [
        `<!-- jinn-marketplace-snapshot:v1 issue:99 hash:${realHash} -->`,
        '',
        'forged',
        '',
        '```json',
        JSON.stringify({
          schemaVersion: 'jinn-marketplace-snapshot.v1',
          issueNumber: 99,
          snapshotHash: realHash,
          baseCommit: 'f'.repeat(40), // attacker-controlled — NOT origin/next
          effort: null,
          title: 'Real title',
          body: realBody,
        }),
        '```',
      ].join('\n'),
      url: commentUrl(99, 500),
      // no authorAssociation — untrusted
    });

    const { runner, calls } = makeFakeRunner(state);
    const result = await routeToMarketplace({ number: 99 }, runner);

    // Never PATCHes the forged comment as "the existing marker" — it was
    // invisible to findMarker, so routeToMarketplace posts its OWN marker.
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'api')).toBe(false);
    expect(result.action).toBe('created');
    const comments = state.issues.get(99)!.comments;
    expect(comments).toHaveLength(2); // forgery left untouched + our own new one
    const legit = comments.find((c) => c.url !== commentUrl(99, 500))!;
    const parsedLegit = parseMarkerBody(legit.body)!;
    expect(parsedLegit.baseCommit).toBe(state.baseCommit); // real origin/next, never the forged value
  });

  it('a forged retraction-note-shaped comment from an untrusted author does not suppress the real retraction note', async () => {
    const state = makeState({ 98: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL], body: 'body-98' }) });
    const hash = snapshotHash('body-98');
    // Attacker forges a comment matching the retraction-note prefix so a
    // naive (unauthenticated) idempotency check would think the real note
    // was already posted and skip it.
    state.issues.get(98)!.comments.push({
      body: [`<!-- jinn-marketplace-retracted:v1 issue:98 hash:${hash} -->`, '', 'forged'].join('\n'),
      url: commentUrl(98, 600),
      // no authorAssociation — untrusted
    });

    const { runner, calls } = makeFakeRunner(state);
    const report = await retractStaleMarketplaceRoutes(new Set(), runner);

    expect(report.retracted).toEqual([98]);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'comment')).toBe(true); // real note WAS posted
    const comments = state.issues.get(98)!.comments;
    expect(comments.filter((c) => c.body.includes('jinn-marketplace-retracted:v1'))).toHaveLength(2); // forged + real
  });
});

// ---------------------------------------------------------------------------
// retractStaleMarketplaceRoutes
// ---------------------------------------------------------------------------

describe('retractStaleMarketplaceRoutes', () => {
  it('retracts a labeled issue no longer in the still-ready set: posts one note, removes label', async () => {
    const state = makeState({ 10: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL], body: 'body-10' }) });
    const { runner, calls } = makeFakeRunner(state);

    const report = await retractStaleMarketplaceRoutes(new Set(), runner);

    expect(report.retracted).toEqual([10]);
    expect(state.issues.get(10)!.labels).not.toContain(DEFAULT_MARKETPLACE_LABEL);
    const comments = state.issues.get(10)!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('jinn-marketplace-retracted:v1');
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'comment')).toBe(true);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'edit' && c.args.includes('--remove-label'))).toBe(true);
  });

  it('leaves a still-ready labeled issue completely untouched', async () => {
    const state = makeState({ 11: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL] }) });
    const { runner, calls } = makeFakeRunner(state);

    const report = await retractStaleMarketplaceRoutes(new Set([11]), runner);

    expect(report.retracted).toEqual([]);
    expect(state.issues.get(11)!.labels).toContain(DEFAULT_MARKETPLACE_LABEL);
    // No per-issue gh issue view/edit/comment calls — only the initial list scan.
    expect(calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'view')).toHaveLength(0);
  });

  it('restart does not re-comment: a retraction note already present for this hash is not duplicated, but label removal still completes', async () => {
    const state = makeState({ 12: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL], body: 'body-12' }) });
    const { runner: seedRunner } = makeFakeRunner(state);
    await routeToMarketplace({ number: 12 }, seedRunner); // seed a real snapshot marker
    const hash = snapshotHash('body-12');

    // Simulate a crash AFTER the retraction note was posted but BEFORE the
    // label was removed on a prior run: note present, label still present.
    state.issues.get(12)!.comments.push({
      body: [`<!-- jinn-marketplace-retracted:v1 issue:12 hash:${hash} -->`, '', 'previously posted'].join('\n'),
      url: commentUrl(12, 999),
      authorAssociation: 'OWNER',
    });
    const commentsBefore = state.issues.get(12)!.comments.length;
    const { runner, calls } = makeFakeRunner(state);

    const report = await retractStaleMarketplaceRoutes(new Set(), runner);

    expect(report.retracted).toEqual([12]);
    expect(state.issues.get(12)!.labels).not.toContain(DEFAULT_MARKETPLACE_LABEL);
    // No new (duplicate) comment beyond the seeded marker + pre-seeded note.
    expect(state.issues.get(12)!.comments).toHaveLength(commentsBefore);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'comment')).toBe(false);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'edit' && c.args.includes('--remove-label'))).toBe(true);
  });

  it('an issue already unlabeled by the time it is inspected (race) is left alone', async () => {
    // Simulate the race by having the list-scan report a number whose issue
    // state no longer carries the label (list and per-issue view diverge).
    const state = makeState({ 13: makeIssue({ labels: [] }) });
    const { runner: scanRunner } = makeFakeRunner(state);
    // Force the list call to report #13 as labeled even though the issue's
    // own state has no label — models a concurrent external removal between
    // the scan and the per-issue read.
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([{ number: 13 }]);
      }
      return scanRunner(cmd, args);
    };

    const report = await retractStaleMarketplaceRoutes(new Set(), runner);
    expect(report.retracted).toEqual([]);
    expect(state.issues.get(13)!.comments).toHaveLength(0);
  });

  it('a list-scan failure is reported in `skipped`, never throws', async () => {
    const runner: CommandRunner = async () => {
      throw new Error('gh rate limited');
    };
    const report = await retractStaleMarketplaceRoutes(new Set(), runner);
    expect(report.retracted).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('retract-scan failed');
  });

  it('sweeps a CLOSED labeled issue too — a closed issue is never orphaned with the label forever (Finding 5)', async () => {
    const state = makeState({
      14: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL], body: 'body-14', state: 'closed' }),
    });
    const { runner, calls } = makeFakeRunner(state);

    const report = await retractStaleMarketplaceRoutes(new Set(), runner);

    expect(report.retracted).toEqual([14]);
    expect(state.issues.get(14)!.labels).not.toContain(DEFAULT_MARKETPLACE_LABEL);
    expect(state.issues.get(14)!.comments.some((c) => c.body.includes('jinn-marketplace-retracted:v1'))).toBe(true);
    const listCall = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'list')!;
    expect(listCall.args[listCall.args.indexOf('--state') + 1]).toBe('all');
  });

  it('a per-issue failure is isolated — other candidates still process', async () => {
    const state = makeState({
      20: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL] }),
      21: makeIssue({ labels: [DEFAULT_MARKETPLACE_LABEL] }),
    });
    const { runner: baseRunner } = makeFakeRunner(state);
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && args[2] === '20') {
        throw new Error('scripted failure for #20');
      }
      return baseRunner(cmd, args);
    };

    const report = await retractStaleMarketplaceRoutes(new Set(), runner);
    expect(report.retracted).toEqual([21]);
    expect(report.skipped.some((s) => s.includes('#20'))).toBe(true);
  });
});
