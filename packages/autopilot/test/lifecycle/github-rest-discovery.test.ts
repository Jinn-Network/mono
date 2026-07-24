import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import { GitHubRestDiscoveryReader } from '../../src/lifecycle/github-rest-discovery.js';
import { ConditionalRestClient } from '../../src/lifecycle/github-rest.js';
import { GitHubUsageMeter } from '../../src/lifecycle/github-usage.js';

const FIELDS_ENDPOINT = 'orgs/Jinn-Network/projectsV2/1/fields?per_page=100';
const ITEMS_ENDPOINT =
  'orgs/Jinn-Network/projectsV2/1/items?fields=11,12,13,14,15,16&per_page=100';
const ISSUE_INDEX_ENDPOINT =
  'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc&per_page=100&page=1';
const OPEN_PR_ENDPOINT =
  'repos/Jinn-Network/mono/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1';
const CLOSED_PR_ENDPOINT =
  'repos/Jinn-Network/mono/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1';
const NOW = Date.parse('2026-07-22T12:00:00.000Z');

function included(
  body: unknown,
  options: {
    readonly status?: 200 | 304;
    readonly etag?: string;
    readonly next?: string;
    readonly link?: string;
  } = {},
): string {
  const status = options.status ?? 200;
  return [
    `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Not Modified'}`,
    `etag: ${options.etag ?? '"stable"'}`,
    'x-ratelimit-remaining: 4990',
    'x-ratelimit-used: 10',
    'x-ratelimit-reset: 1784725200',
    'x-ratelimit-resource: core',
    ...(status === 200 ? ['content-type: application/json'] : []),
    ...(options.link !== undefined
      ? [`link: ${options.link}`]
      : options.next === undefined
        ? []
        : [`link: <https://api.github.com/${options.next}>; rel="next"`]),
    '',
    status === 200 ? JSON.stringify(body) : '',
  ].join('\r\n');
}

function projectFields(overrides: Record<string, unknown> = {}): unknown[] {
  const fields: Record<string, unknown>[] = [
    { id: 11, name: 'Status', data_type: 'single_select' },
    { id: 12, name: 'Priority', data_type: 'single_select' },
    { id: 13, name: 'Effort', data_type: 'single_select' },
    { id: 14, name: 'Blocked on', data_type: 'single_select' },
    {
      id: 15,
      name: 'Sprint',
      data_type: 'iteration',
      configuration: {
        iterations: [
          { id: 'past', start_date: '2026-07-06', duration: 7 },
          { id: 'current', start_date: '2026-07-20', duration: 7 },
          { id: 'future', start_date: '2026-07-27', duration: 7 },
        ],
      },
    },
    { id: 16, name: 'Type', data_type: 'issue_type' },
  ];
  return fields.map((field) => ({ ...field, ...(overrides[field.name as string] ?? {}) }));
}

function select(id: number, name: string, value: string | null) {
  return {
    id,
    name,
    data_type: 'single_select',
    value: value === null ? null : { id: `${id}-${value}`, name: { raw: value, html: value } },
  };
}

function issueItem(input: {
  readonly number: number;
  readonly blockedOn: 'Nothing' | 'Human' | 'Another issue';
  readonly sprint?: string | null;
}) {
  const sprint = input.sprint === undefined ? 'current' : input.sprint;
  return {
    id: 1000 + input.number,
    node_id: `PVTI_${input.number}`,
    content_type: 'Issue',
    content: { number: input.number },
    fields: [
      select(11, 'Status', 'Todo'),
      select(12, 'Priority', 'P1'),
      select(13, 'Effort', 'Medium'),
      select(14, 'Blocked on', input.blockedOn),
      {
        id: 15,
        name: 'Sprint',
        data_type: 'iteration',
        value: sprint === null
          ? null
          : { id: sprint, title: { raw: 'Sprint', html: 'Sprint' }, start_date: '2026-07-20', duration: 7 },
      },
      {
        id: 16,
        name: 'Type',
        data_type: 'issue_type',
        value: { id: 410, node_id: 'IT_fix', name: 'fix' },
      },
    ],
  };
}

function mapRunner(
  responses: ReadonlyMap<string, string | (() => string)>,
  calls: string[] = [],
): CommandRunner {
  return async (_command, args) => {
    const endpoint = args[2]!;
    calls.push(endpoint);
    const response = responses.get(endpoint);
    if (response === undefined) throw new Error(`unexpected endpoint: ${endpoint}`);
    return typeof response === 'function' ? response() : response;
  };
}

describe('GitHubRestDiscoveryReader project discovery', () => {
  it('reads one native issue, its dependency list, and one lightweight PR conditionally', async () => {
    const issueEndpoint = 'repos/Jinn-Network/mono/issues/42';
    const dependencyEndpoint =
      'repos/Jinn-Network/mono/issues/42/dependencies/blocked_by?per_page=100&page=1';
    const prEndpoint = 'repos/Jinn-Network/mono/pulls/101';
    const calls: string[] = [];
    const responses = new Map<string, string>([
      [issueEndpoint, included({
        number: 42,
        title: 'Live issue',
        state: 'open',
        user: { login: 'oaksprout' },
        labels: [{ name: 'engine:ready' }],
      })],
      [dependencyEndpoint, included([{ number: 7 }])],
      [prEndpoint, included({
        number: 101,
        state: 'open',
        title: 'Live PR',
        body: 'Closes #42',
        user: { login: 'oaksprout' },
        draft: true,
        head: { ref: 'autopilot/42', sha: 'a'.repeat(40) },
        base: { ref: 'next' },
        labels: [{ name: 'engine:review' }],
      })],
    ]);
    const reader = new GitHubRestDiscoveryReader(
      new ConditionalRestClient(mapRunner(responses, calls)),
    );

    await expect(reader.readIssueForAction(42)).resolves.toEqual({
      number: 42,
      title: 'Live issue',
      open: true,
      author: 'oaksprout',
      labels: ['engine:ready'],
    });
    await expect(reader.readBlockedByIssueNumbersForAction(42)).resolves.toEqual([7]);
    await expect(reader.readPullRequestForAction(101)).resolves.toEqual({
      number: 101,
      headRefName: 'autopilot/42',
      headOid: 'a'.repeat(40),
      baseRefName: 'next',
      draft: true,
      labels: ['engine:review'],
      body: 'Closes #42',
    });
    expect(calls).toEqual([issueEndpoint, dependencyEndpoint, prEndpoint]);
  });

  it('discovers field IDs, follows bounded pages, derives Sprint, and reads only declared dependencies', async () => {
    const itemPage2 = `${ITEMS_ENDPOINT}&after=cursor-2`;
    const numericOrganizationItemLink =
      'organizations/123456/projectsV2/1/items?fields=11,12,13,14,15,16'
      + '&per_page=100&after=cursor-2';
    const dependencyPage1 =
      'repos/Jinn-Network/mono/issues/42/dependencies/blocked_by?per_page=100&page=1';
    const dependencyPage2 =
      'repos/Jinn-Network/mono/issues/42/dependencies/blocked_by?per_page=100&page=2';
    const calls: string[] = [];
    const blockers = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
    const responses = new Map<string, string>([
      [FIELDS_ENDPOINT, included(projectFields())],
      [ITEMS_ENDPOINT, included([issueItem({ number: 42, blockedOn: 'Another issue' })], {
        next: numericOrganizationItemLink,
      })],
      [itemPage2, included([issueItem({ number: 43, blockedOn: 'Nothing', sprint: null })])],
      [dependencyPage1, included(blockers, { next: dependencyPage2 })],
      [dependencyPage2, included([{ number: 999 }])],
    ]);
    const reader = new GitHubRestDiscoveryReader(
      new ConditionalRestClient(mapRunner(responses, calls)),
    );

    const snapshot = await reader.readProjectSnapshot({ nowMs: NOW });

    expect(snapshot.currentSprintIterationId).toBe('current');
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        id: 'PVTI_42',
        number: 42,
        contentType: 'Issue',
        status: 'Todo',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
        sprintIterationId: 'current',
        blockedByIssues: [...Array.from({ length: 100 }, (_, index) => index + 1), 999],
      }),
      expect.objectContaining({
        id: 'PVTI_43',
        number: 43,
        blockedOn: 'Nothing',
        blockedByIssues: [],
        sprintIterationId: null,
      }),
    ]);
    expect(calls).toEqual([
      FIELDS_ENDPOINT,
      ITEMS_ENDPOINT,
      itemPage2,
      dependencyPage1,
      dependencyPage2,
    ]);
    expect(calls.some((endpoint) => endpoint.includes('/issues/43/dependencies'))).toBe(false);
  });

  it('confines a numeric-repository dependency Link to the original named page-only endpoint', async () => {
    const dependencyPage1 =
      'repos/Jinn-Network/mono/issues/42/dependencies/blocked_by?per_page=100&page=1';
    const dependencyPage2 =
      'repos/Jinn-Network/mono/issues/42/dependencies/blocked_by?per_page=100&page=2';
    const numericPage2 =
      'repositories/1190804373/issues/42/dependencies/blocked_by?per_page=100&page=2';
    const calls: string[] = [];
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [dependencyPage1, included([{ number: 41 }], { next: numericPage2 })],
      [dependencyPage2, included([{ number: 40 }])],
    ]), calls)));

    await expect(reader.readBlockedByIssueNumbersForAction(42)).resolves.toEqual([41, 40]);
    expect(calls).toEqual([dependencyPage1, dependencyPage2]);
  });

  it('discovers Project fields across after-cursor pages while retaining the original endpoint', async () => {
    const fieldPage2 = `${FIELDS_ENDPOINT}&after=field-cursor-2`;
    const numericOrganizationFieldLink =
      'organizations/123456/projectsV2/1/fields?per_page=100&after=field-cursor-2';
    const fields = projectFields();
    const calls: string[] = [];
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(fields.slice(0, 3), { next: numericOrganizationFieldLink })],
      [fieldPage2, included(fields.slice(3))],
      [ITEMS_ENDPOINT, included([])],
    ]), calls)));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).resolves.toMatchObject({ items: [] });
    expect(calls).toEqual([FIELDS_ENDPOINT, fieldPage2, ITEMS_ENDPOINT]);
  });

  it('rejects an unknown query key on a Project fields after-cursor Link', async () => {
    const next =
      'organizations/123456/projectsV2/1/fields?per_page=100&after=field-cursor-2&extra=1';
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(projectFields().slice(0, 3), { next })],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).rejects.toThrow(/query|pagination/i);
  });

  it('rejects a non-progressing Project fields after cursor', async () => {
    const fieldPage2 = `${FIELDS_ENDPOINT}&after=field-cursor-2`;
    const numericOrganizationFieldLink =
      'organizations/123456/projectsV2/1/fields?per_page=100&after=field-cursor-2';
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(projectFields().slice(0, 3), {
        next: numericOrganizationFieldLink,
      })],
      [fieldPage2, included(projectFields().slice(3), { next: numericOrganizationFieldLink })],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).rejects.toThrow(/cursor|pagination/i);
  });

  it('observes dependency changes while reusing unchanged Project pages on 304', async () => {
    const dependencyEndpoint =
      'repos/Jinn-Network/mono/issues/42/dependencies/blocked_by?per_page=100&page=1';
    const counts = new Map<string, number>();
    const meter = new GitHubUsageMeter();
    const run: CommandRunner = async (_command, args) => {
      const endpoint = args[2]!;
      const count = (counts.get(endpoint) ?? 0) + 1;
      counts.set(endpoint, count);
      if (endpoint === FIELDS_ENDPOINT) {
        return count === 1 ? included(projectFields()) : included(null, { status: 304 });
      }
      if (endpoint === ITEMS_ENDPOINT) {
        return count === 1
          ? included([issueItem({ number: 42, blockedOn: 'Another issue' })])
          : included(null, { status: 304 });
      }
      if (endpoint === dependencyEndpoint) {
        return count === 1
          ? included([{ number: 41 }], { etag: '"dep-v1"' })
          : included([{ number: 43 }], { etag: '"dep-v2"' });
      }
      throw new Error(`unexpected endpoint: ${endpoint}`);
    };
    const reader = new GitHubRestDiscoveryReader(
      new ConditionalRestClient(run, { usageMeter: meter }),
    );

    const before = await reader.readProjectSnapshot({ nowMs: NOW });
    const after = await reader.readProjectSnapshot({ nowMs: NOW });

    expect(before.items[0]?.blockedByIssues).toEqual([41]);
    expect(after.items[0]?.blockedByIssues).toEqual([43]);
    expect(meter.read()).toMatchObject({
      restRequests: 6,
      restNotModified: 2,
      cacheHits: 2,
    });
  });

  it('preserves PullRequest and DraftIssue snapshot semantics and drops deleted content', async () => {
    const base = issueItem({ number: 42, blockedOn: 'Nothing' });
    const withoutType = base.fields.map((field) => (
      field.name === 'Type' ? { ...field, value: null } : field
    ));
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(projectFields())],
      [ITEMS_ENDPOINT, included([
        { ...base, node_id: 'PVTI_pr', content_type: 'PullRequest', content: { number: 101 }, fields: withoutType },
        { ...base, node_id: 'PVTI_draft', content_type: 'DraftIssue', content: {}, fields: withoutType },
        { ...base, node_id: 'PVTI_deleted', content: null },
      ])],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).resolves.toMatchObject({
      items: [
        { id: 'PVTI_pr', number: 101, contentType: 'PullRequest', issueType: null },
        { id: 'PVTI_draft', number: -1, contentType: 'DraftIssue', issueType: null },
      ],
    });
  });

  it.each([
    [
      'a required field is missing',
      projectFields().filter((field) => (field as { name: string }).name !== 'Blocked on'),
    ],
    [
      'a required field has the wrong data type',
      projectFields({ Sprint: { data_type: 'date' } }),
    ],
    [
      'a required field is duplicated',
      [...projectFields(), { id: 99, name: 'Status', data_type: 'single_select' }],
    ],
  ])('fails closed when %s', async (_label, fields) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(fields)],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).rejects.toThrow(/field|schema/i);
  });

  it('fails closed on unknown or incomplete Project item shapes', async () => {
    const malformed = {
      ...issueItem({ number: 42, blockedOn: 'Nothing' }),
      content_type: 'Discussion',
    };
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(projectFields())],
      [ITEMS_ENDPOINT, included([malformed])],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).rejects.toThrow(/content.type|Project item/i);
  });

  it.each([
    ['Status', 'Waiting'],
    ['Priority', 'Urgent'],
    ['Effort', 'Tiny'],
    ['Blocked on', 'Maybe'],
    ['Type', 'proposal'],
  ])('fails closed on an unknown %s taxonomy option', async (fieldName, unknownValue) => {
    const item = issueItem({ number: 42, blockedOn: 'Nothing' });
    const field = item.fields.find((candidate) => candidate.name === fieldName)!;
    if (fieldName === 'Type') {
      field.value = { id: 999, node_id: 'IT_unknown', name: unknownValue };
    } else {
      field.value = {
        id: `unknown-${fieldName}`,
        name: { raw: unknownValue, html: unknownValue },
      };
    }
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(projectFields())],
      [ITEMS_ENDPOINT, included([item])],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW }))
      .rejects.toThrow(new RegExp(`${fieldName}.*unknown|unknown.*${fieldName}`, 'i'));
  });

  it.each([
    ['all single-select fields are null', ['Status', 'Priority', 'Effort', 'Blocked on']],
    ['Status alone is null', ['Status']],
  ])('matches the full reader schema-drift guard when %s across three issues', async (
    _label,
    nullFields,
  ) => {
    const items = [42, 43, 44].map((number) => {
      const item = issueItem({ number, blockedOn: 'Nothing' });
      for (const field of item.fields) {
        if (nullFields.includes(field.name)) field.value = null;
      }
      return item;
    });
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(projectFields())],
      [ITEMS_ENDPOINT, included(items)],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW }))
      .rejects.toThrow(/ProjectFieldSchemaError|schema.*Status|single-select.*null/i);
  });

  it('enforces an explicit page cap and rejects pagination loops', async () => {
    const client = new ConditionalRestClient(async () => included(projectFields(), {
      next: FIELDS_ENDPOINT,
    }));
    const reader = new GitHubRestDiscoveryReader(client, { maxPages: 2 });

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).rejects.toThrow(/pagination|loop/i);
  });

  it.each([
    ['2026-02-30'],
    ['2027-02-29'],
    ['2026-13-01'],
  ])('rejects impossible Sprint configuration date %s', async (startDate) => {
    const fields = projectFields({
      Sprint: {
        configuration: {
          iterations: [{ id: 'invalid', start_date: startDate, duration: 7 }],
        },
      },
    });
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(fields)],
      [ITEMS_ENDPOINT, included([])],
    ]))));

    await expect(reader.readProjectSnapshot({ nowMs: NOW })).rejects.toThrow(/Sprint|date/i);
  });

  it('accepts leap-day Sprint dates and derives the window in UTC', async () => {
    const fields = projectFields({
      Sprint: {
        configuration: {
          iterations: [{ id: 'leap', start_date: '2028-02-29', duration: 2 }],
        },
      },
    });
    const item = issueItem({ number: 42, blockedOn: 'Nothing', sprint: 'leap' });
    const sprintField = item.fields.find((field) => field.name === 'Sprint')!;
    Object.assign(sprintField.value!, { start_date: '2028-02-29', duration: 2 });
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [FIELDS_ENDPOINT, included(fields)],
      [ITEMS_ENDPOINT, included([item])],
    ]))));

    await expect(reader.readProjectSnapshot({
      nowMs: Date.parse('2028-03-01T23:59:59.999Z'),
    })).resolves.toMatchObject({ currentSprintIterationId: 'leap' });
  });
});

describe('GitHubRestDiscoveryReader issue and PR indexes', () => {
  it('follows the live numeric-repository page+after issue Link on the named endpoint', async () => {
    const after = 'Y3Vyc29yOnYyOpHODqQxMjM0NTY3ODkw';
    const linkedPage2 =
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc'
      + `&per_page=100&page=2&after=${after}`;
    const requestedPage2 =
      'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc'
      + `&per_page=100&page=2&after=${after}`;
    const previous =
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc'
      + `&per_page=100&page=1&before=${after}`;
    const issue = (number: number) => ({
      number,
      state: 'open',
      title: `Issue ${number}`,
      updated_at: '2026-07-22T10:00:00Z',
      user: { login: 'trusted' },
      labels: [],
    });
    const calls: string[] = [];
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([issue(42)], {
        link: `<https://api.github.com/${linkedPage2}>; rel="next"`,
      })],
      [requestedPage2, included([issue(41)], {
        link: `<https://api.github.com/${previous}>; rel="prev"`,
      })],
    ]), calls)));

    await expect(reader.readOpenIssueIndex()).resolves.toEqual([
      expect.objectContaining({ number: 42 }),
      expect.objectContaining({ number: 41 }),
    ]);
    expect(calls).toEqual([ISSUE_INDEX_ENDPOINT, requestedPage2]);
  });

  it.each([
    [
      'a different numeric repository id',
      'repositories/1190804374/issues?state=open&sort=updated&direction=desc&per_page=100&page=2&after=cursor-2',
    ],
    [
      'a mismatched numeric resource tail',
      'repositories/1190804373/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2&after=cursor-2',
    ],
    [
      'a missing after cursor',
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc&per_page=100&page=2',
    ],
    [
      'a duplicated after cursor',
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc&per_page=100&page=2&after=cursor-2&after=cursor-3',
    ],
    [
      'an empty after cursor',
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc&per_page=100&page=2&after=',
    ],
    [
      'an unknown query key',
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc&per_page=100&page=2&after=cursor-2&extra=1',
    ],
    [
      'a skipped page',
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc&per_page=100&page=3&after=cursor-2',
    ],
    [
      'a changed immutable filter',
      'repositories/1190804373/issues?state=closed&sort=updated&direction=desc&per_page=100&page=2&after=cursor-2',
    ],
  ])('rejects the live-shaped issue Link with %s', async (_label, next) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([{
        number: 42,
        state: 'open',
        title: 'Issue',
        updated_at: '2026-07-22T10:00:00Z',
        user: { login: 'trusted' },
        labels: [],
      }], { next })],
    ]))));

    await expect(reader.readOpenIssueIndex()).rejects.toThrow(/pagination|cursor|filter|path|query/i);
  });

  it('rejects a repeated issue after cursor even when the page advances', async () => {
    const page2Link =
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc'
      + '&per_page=100&page=2&after=cursor-2';
    const requestedPage2 =
      'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc'
      + '&per_page=100&page=2&after=cursor-2';
    const repeated =
      'repositories/1190804373/issues?state=open&sort=updated&direction=desc'
      + '&per_page=100&page=3&after=cursor-2';
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([], { next: page2Link })],
      [requestedPage2, included([], { next: repeated })],
    ]))));

    await expect(reader.readOpenIssueIndex()).rejects.toThrow(/cursor|progress|pagination/i);
  });

  it('reads conditional open issues while excluding PR rows', async () => {
    let call = 0;
    const meter = new GitHubUsageMeter();
    const client = new ConditionalRestClient(async () => {
      call += 1;
      return call === 1
        ? included([
            {
              number: 42,
              state: 'open',
              title: 'Issue',
              updated_at: '2026-07-22T10:00:00Z',
              user: { login: 'trusted' },
              labels: [{ name: 'area:autopilot' }],
            },
            {
              number: 43,
              state: 'open',
              title: 'PR row',
              updated_at: '2026-07-22T10:01:00Z',
              user: { login: 'trusted' },
              labels: [],
              pull_request: {
                url: 'https://api.github.com/repos/Jinn-Network/mono/pulls/43',
                html_url: 'https://github.com/Jinn-Network/mono/pull/43',
                diff_url: 'https://github.com/Jinn-Network/mono/pull/43.diff',
                patch_url: 'https://github.com/Jinn-Network/mono/pull/43.patch',
              },
            },
          ])
        : included(null, { status: 304 });
    }, { usageMeter: meter });
    const reader = new GitHubRestDiscoveryReader(client);

    await expect(reader.readOpenIssueIndex()).resolves.toEqual([{
      number: 42,
      title: 'Issue',
      body: '',
      updatedAt: '2026-07-22T10:00:00Z',
      author: 'trusted',
      labels: ['area:autopilot'],
    }]);
    await expect(reader.readOpenIssueIndex()).resolves.toHaveLength(1);
    expect(meter.read()).toMatchObject({ restRequests: 2, restNotModified: 1, cacheHits: 1 });
    expect(ISSUE_INDEX_ENDPOINT).toContain('page=1');
  });

  it.each([
    [
      'a cross-repository path',
      'repos/Other/mono/issues?state=open&sort=updated&direction=desc&per_page=100&page=2',
    ],
    [
      'a cross-resource path',
      'repos/Jinn-Network/mono/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2',
    ],
    [
      'a changed immutable filter',
      'repos/Jinn-Network/mono/issues?state=closed&sort=updated&direction=desc&per_page=100&page=2',
    ],
    [
      'a changed page size',
      'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc&per_page=50&page=2',
    ],
    [
      'an unknown query key',
      'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc&per_page=100&page=2&extra=1',
    ],
    [
      'a duplicate cursor',
      'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc&per_page=100&page=2&page=3',
    ],
    [
      'a cursor that moves backwards',
      'repos/Jinn-Network/mono/issues?state=open&sort=updated&direction=desc&per_page=100&page=0',
    ],
  ])('rejects a next Link with %s', async (_label, next) => {
    const validIssue = {
      number: 42,
      state: 'open',
      title: 'Issue',
      updated_at: '2026-07-22T10:00:00Z',
      user: { login: 'trusted' },
      labels: [],
    };
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([validIssue], { next })],
      [next, included([])],
    ]))));

    await expect(reader.readOpenIssueIndex()).rejects.toThrow(/pagination|cursor|filter|path|query/i);
  });

  it.each([
    ['missing state', {
      number: 42,
      title: 'Issue',
      updated_at: '2026-07-22T10:00:00Z',
      user: { login: 'trusted' },
      labels: [],
    }],
    ['closed state', {
      number: 42,
      state: 'closed',
      title: 'Issue',
      updated_at: '2026-07-22T10:00:00Z',
      user: { login: 'trusted' },
      labels: [],
    }],
    ['null pull_request marker', {
      number: 43,
      state: 'open',
      title: 'PR row',
      updated_at: '2026-07-22T10:01:00Z',
      user: { login: 'trusted' },
      labels: [],
      pull_request: null,
    }],
    ['incomplete pull_request marker', {
      number: 43,
      state: 'open',
      title: 'PR row',
      updated_at: '2026-07-22T10:01:00Z',
      user: { login: 'trusted' },
      labels: [],
      pull_request: { url: 'https://api.github.com/repos/Jinn-Network/mono/pulls/43' },
    }],
  ])('fails closed on an open-issue row with %s', async (_label, row) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([row])],
    ]))));

    await expect(reader.readOpenIssueIndex()).rejects.toThrow(/issue|pull.request|state/i);
  });

  it.each([
    ['2026-02-30T10:00:00Z'],
    ['2026-07-22 10:00:00Z'],
    ['2026-07-22T10:00:00+00:00'],
    ['2026-07-22T24:00:00Z'],
    ['2026-07-22T10:00:00.12Z'],
  ])('rejects non-canonical or impossible UTC timestamp %s', async (updatedAt) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([{
        number: 42,
        state: 'open',
        title: 'Issue',
        updated_at: updatedAt,
        user: { login: 'trusted' },
        labels: [],
      }])],
    ]))));

    await expect(reader.readOpenIssueIndex()).rejects.toThrow(/timestamp|updated/i);
  });

  it.each([
    ['2028-02-29T23:59:59Z'],
    ['2028-02-29T23:59:59.999Z'],
  ])('accepts canonical leap-day UTC timestamp %s', async (updatedAt) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([{
        number: 42,
        state: 'open',
        title: 'Issue',
        updated_at: updatedAt,
        user: { login: 'trusted' },
        labels: [],
      }])],
    ]))));

    await expect(reader.readOpenIssueIndex()).resolves.toEqual([
      expect.objectContaining({ updatedAt }),
    ]);
  });

  it('reads lightweight open and recently-closed PR indexes', async () => {
    const pr = (input: {
      number: number;
      state: 'open' | 'closed';
      updatedAt: string;
      mergedAt?: string | null;
    }) => ({
      number: input.number,
      title: `PR ${input.number}`,
      state: input.state,
      draft: false,
      updated_at: input.updatedAt,
      closed_at: input.state === 'closed' ? input.updatedAt : null,
      merged_at: input.mergedAt ?? null,
      head: { sha: `${input.number}`.padStart(40, '0'), ref: `feature/${input.number}` },
      base: { ref: 'next' },
    });
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [OPEN_PR_ENDPOINT, included([pr({
        number: 101,
        state: 'open',
        updatedAt: '2026-07-22T10:00:00Z',
      })])],
      [CLOSED_PR_ENDPOINT, included([
        pr({
          number: 100,
          state: 'closed',
          updatedAt: '2026-07-22T09:00:00Z',
          mergedAt: '2026-07-22T08:00:00Z',
        }),
        pr({ number: 99, state: 'closed', updatedAt: '2026-07-19T09:00:00Z' }),
      ])],
    ]))));

    await expect(reader.readOpenPullRequestIndex()).resolves.toEqual([expect.objectContaining({
      number: 101,
      state: 'OPEN',
      title: 'PR 101',
      headOid: '0000000000000000000000000000000000000101',
      headRefName: 'feature/101',
      baseRefName: 'next',
      isDraft: false,
    })]);
    await expect(reader.readRecentlyClosedPullRequestIndex('2026-07-21T00:00:00.000Z'))
      .resolves.toEqual([expect.objectContaining({
        number: 100,
        state: 'CLOSED',
      mergedAt: '2026-07-22T08:00:00Z',
    })]);
  });

  it('follows the live numeric-repository closed-PR Link in strict page-only mode', async () => {
    const linkedPage2 =
      'repositories/1190804373/pulls?state=closed&sort=updated&direction=desc'
      + '&per_page=100&page=2';
    const requestedPage2 =
      'repos/Jinn-Network/mono/pulls?state=closed&sort=updated&direction=desc'
      + '&per_page=100&page=2';
    const pr = (number: number, updatedAt: string) => ({
      number,
      title: `PR ${number}`,
      state: 'closed',
      draft: false,
      updated_at: updatedAt,
      closed_at: updatedAt,
      merged_at: null,
      head: { sha: `${number}`.padStart(40, '0'), ref: `feature/${number}` },
      base: { ref: 'next' },
    });
    const calls: string[] = [];
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [CLOSED_PR_ENDPOINT, included([pr(100, '2026-07-22T10:00:00Z')], {
        next: linkedPage2,
      })],
      [requestedPage2, included([pr(99, '2026-07-22T09:00:00Z')])],
    ]), calls)));

    await expect(reader.readRecentlyClosedPullRequestIndex('2026-07-21T00:00:00.000Z'))
      .resolves.toEqual([
        expect.objectContaining({ number: 100 }),
        expect.objectContaining({ number: 99 }),
      ]);
    expect(calls).toEqual([CLOSED_PR_ENDPOINT, requestedPage2]);
  });

  it('does not permit an issue-style after cursor on a pull-request page Link', async () => {
    const next =
      'repositories/1190804373/pulls?state=open&sort=updated&direction=desc'
      + '&per_page=100&page=2&after=cursor-2';
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [OPEN_PR_ENDPOINT, included([], { next })],
    ]))));

    await expect(reader.readOpenPullRequestIndex()).rejects.toThrow(/pagination|cursor|query/i);
  });

  it.each([
    ['open PR with closed_at', {
      number: 101, title: 'PR 101', state: 'open', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: '2026-07-22T09:00:00Z', merged_at: null,
      head: { sha: 'a'.repeat(40), ref: 'feature/101' }, base: { ref: 'next' },
    }],
    ['open PR with merged_at', {
      number: 101, title: 'PR 101', state: 'open', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: null, merged_at: '2026-07-22T09:00:00Z',
      head: { sha: 'a'.repeat(40), ref: 'feature/101' }, base: { ref: 'next' },
    }],
    ['open PR missing title', {
      number: 101, state: 'open', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: null, merged_at: null,
      head: { sha: 'a'.repeat(40), ref: 'feature/101' }, base: { ref: 'next' },
    }],
    ['open PR missing head ref', {
      number: 101, title: 'PR 101', state: 'open', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: null, merged_at: null,
      head: { sha: 'a'.repeat(40) }, base: { ref: 'next' },
    }],
    ['open PR missing base ref', {
      number: 101, title: 'PR 101', state: 'open', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: null, merged_at: null,
      head: { sha: 'a'.repeat(40), ref: 'feature/101' }, base: {},
    }],
    ['open PR missing update time', {
      number: 101, title: 'PR 101', state: 'open', draft: false,
      closed_at: null, merged_at: null,
      head: { sha: 'a'.repeat(40), ref: 'feature/101' }, base: { ref: 'next' },
    }],
  ])('fails closed on %s', async (_label, row) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [OPEN_PR_ENDPOINT, included([row])],
    ]))));

    await expect(reader.readOpenPullRequestIndex()).rejects.toThrow(/pull request/i);
  });

  it.each([
    ['closed PR with null closed_at', {
      number: 100, title: 'PR 100', state: 'closed', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: null, merged_at: null,
      head: { sha: 'b'.repeat(40), ref: 'feature/100' }, base: { ref: 'next' },
    }],
    ['closed PR updated before close', {
      number: 100, title: 'PR 100', state: 'closed', draft: false,
      updated_at: '2026-07-22T08:00:00Z', closed_at: '2026-07-22T09:00:00Z', merged_at: null,
      head: { sha: 'b'.repeat(40), ref: 'feature/100' }, base: { ref: 'next' },
    }],
    ['closed PR merged after close', {
      number: 100, title: 'PR 100', state: 'closed', draft: false,
      updated_at: '2026-07-22T10:00:00Z', closed_at: '2026-07-22T09:00:00Z', merged_at: '2026-07-22T09:01:00Z',
      head: { sha: 'b'.repeat(40), ref: 'feature/100' }, base: { ref: 'next' },
    }],
  ])('fails closed on %s', async (_label, row) => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [CLOSED_PR_ENDPOINT, included([row])],
    ]))));

    await expect(reader.readRecentlyClosedPullRequestIndex('2026-07-21T00:00:00.000Z'))
      .rejects.toThrow(/pull request|closed|merged|updated/i);
  });

  it('fails closed on unknown issue and PR index shapes', async () => {
    const reader = new GitHubRestDiscoveryReader(new ConditionalRestClient(mapRunner(new Map([
      [ISSUE_INDEX_ENDPOINT, included([{ number: '42', state: 'open', title: 'bad' }])],
      [OPEN_PR_ENDPOINT, included([{ number: 101, state: 'unknown' }])],
    ]))));

    await expect(reader.readOpenIssueIndex()).rejects.toThrow(/issue/i);
    await expect(reader.readOpenPullRequestIndex()).rejects.toThrow(/pull request|PR/i);
  });
});
