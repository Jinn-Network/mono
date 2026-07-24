/**
 * Production ReviewFollowUpPort — ordinary triage-complete issues, not children.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { FIX_ISSUE_TYPE_ID } from './child-issues-production.js';
import { createProjectTriageApplier } from './project-triage.js';
import {
  type ReviewFollowUpPort,
  type ReviewFollowUpType,
} from './review-follow-ups.js';

/** Org-level Issue Type node ids (see file-issue gh-taxonomy). */
export const CHORE_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4BvpyJ';
export const FEAT_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4BvpyL';
export const REFACTOR_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4CAgNe';

const ISSUE_TYPE_IDS: Record<ReviewFollowUpType, string> = {
  chore: CHORE_ISSUE_TYPE_ID,
  fix: FIX_ISSUE_TYPE_ID,
  feat: FEAT_ISSUE_TYPE_ID,
  refactor: REFACTOR_ISSUE_TYPE_ID,
};

const UPDATE_ISSUE_TYPE_MUTATION = `
mutation($issueId: ID!, $typeId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $typeId }) {
    issue { number issueType { name } }
  }
}
`;

export interface ProductionReviewFollowUpPortOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
  readonly issueTypeIds?: Partial<Record<ReviewFollowUpType, string>>;
}

function parseIssueList(raw: string): readonly {
  readonly number: number;
  readonly body: string;
}[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed review-follow-up list readback');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Malformed review-follow-up list readback');
  }
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Malformed review-follow-up list entry');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.number !== 'number' || typeof record.body !== 'string') {
      throw new Error('Malformed review-follow-up list entry fields');
    }
    return {
      number: record.number,
      body: record.body,
    };
  });
}

function parseCreatedIssueNumber(raw: string): number {
  const match = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (match !== null) {
    return Number(match[1]);
  }
  const asNumber = Number(raw.trim());
  if (Number.isSafeInteger(asNumber) && asNumber > 0) {
    return asNumber;
  }
  throw new Error(`Could not parse created issue number from: ${raw.trim()}`);
}

export function makeProductionReviewFollowUpPort(
  options: ProductionReviewFollowUpPortOptions = {},
): ReviewFollowUpPort {
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  const issueTypeIds: Record<ReviewFollowUpType, string> = {
    ...ISSUE_TYPE_IDS,
    ...options.issueTypeIds,
  };
  const triageApplier = createProjectTriageApplier(runner, { repo });
  let openIssuesCache: readonly { readonly number: number; readonly body: string }[] | undefined;

  const loadOpenIssues = async (): Promise<
    readonly { readonly number: number; readonly body: string }[]
  > => {
    if (openIssuesCache !== undefined) return openIssuesCache;
    const raw = await runner('gh', [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,body',
    ]);
    openIssuesCache = parseIssueList(raw);
    return openIssuesCache;
  };

  return {
    async searchOpenByMarker(marker) {
      const open = await loadOpenIssues();
      return open
        .filter((issue) => issue.body.includes(marker))
        .map((issue) => ({ number: issue.number }));
    },

    async createIssue(input) {
      const raw = await runner('gh', [
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        input.title,
        '--body',
        input.body,
      ]);
      return { number: parseCreatedIssueNumber(raw) };
    },

    async ensureTriageComplete(input) {
      const typeId = issueTypeIds[input.type];
      const idRaw = await runner('gh', [
        'issue',
        'view',
        String(input.issueNumber),
        '--repo',
        repo,
        '--json',
        'id',
        '--jq',
        '.id',
      ]);
      const issueId = idRaw.trim();
      if (issueId.length === 0) {
        throw new Error(`Missing node id for issue #${input.issueNumber}`);
      }
      await runner('gh', [
        'api',
        'graphql',
        '-f',
        `query=${UPDATE_ISSUE_TYPE_MUTATION}`,
        '-f',
        `issueId=${issueId}`,
        '-f',
        `typeId=${typeId}`,
      ]);

      await triageApplier.applyMachineTriage({
        issueNumber: input.issueNumber,
        effort: input.effort,
        priority: input.priority,
      });
    },
  };
}
