/**
 * Production ReviewFollowUpPort — ordinary triage-complete issues, not children.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { ORG, PROJECT_NUMBER, REPO } from '../dispatcher/constants.js';
import { PROJECT_ID } from '../dispatcher/field-cache.js';
import { FIX_ISSUE_TYPE_ID } from './child-issues-production.js';
import {
  type ReviewFollowUpEffort,
  type ReviewFollowUpPort,
  type ReviewFollowUpPriority,
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

const EFFORT_PROJECT_NAME: Record<ReviewFollowUpEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

const PRIORITY_PROJECT_NAME: Record<ReviewFollowUpPriority, string> = {
  p0: 'P0',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  p4: 'P4',
};

export interface ProductionReviewFollowUpPortOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
  readonly issueTypeIds?: Partial<Record<ReviewFollowUpType, string>>;
}

interface TriageFields {
  readonly projectId: string;
  readonly blockedOn: { readonly fieldId: string; readonly nothingOptionId: string };
  readonly effort: { readonly fieldId: string; readonly options: Record<string, string> };
  readonly priority: { readonly fieldId: string; readonly options: Record<string, string> };
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

function parseItemAddId(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed project item-add readback');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Malformed project item-add readback');
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Malformed project item-add readback: missing id');
  }
  return id;
}

function parseTriageFields(raw: string): TriageFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed project field-list readback');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Malformed project field-list readback');
  }
  const fields = (parsed as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) {
    throw new Error('Malformed project field-list readback: missing fields');
  }

  const byName = new Map<string, { id: string; options: Map<string, string> }>();
  for (const field of fields) {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) {
      continue;
    }
    const record = field as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string') {
      continue;
    }
    const options = new Map<string, string>();
    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        if (
          typeof option === 'object'
          && option !== null
          && typeof (option as { id?: unknown }).id === 'string'
          && typeof (option as { name?: unknown }).name === 'string'
        ) {
          options.set(
            (option as { name: string }).name,
            (option as { id: string }).id,
          );
        }
      }
    }
    byName.set(record.name, { id: record.id, options });
  }

  const blockedOn = byName.get('Blocked on');
  const effort = byName.get('Effort');
  const priority = byName.get('Priority');
  if (blockedOn === undefined) {
    throw new Error('Blocked on field not found in project field-list');
  }
  if (effort === undefined) {
    throw new Error('Effort field not found in project field-list');
  }
  if (priority === undefined) {
    throw new Error('Priority field not found in project field-list');
  }
  const nothingOptionId = blockedOn.options.get('Nothing');
  if (nothingOptionId === undefined) {
    throw new Error('"Nothing" option not found in Blocked on field');
  }

  const effortOptions: Record<string, string> = {};
  for (const name of Object.values(EFFORT_PROJECT_NAME)) {
    const id = effort.options.get(name);
    if (id === undefined) {
      throw new Error(`"${name}" option not found in Effort field`);
    }
    effortOptions[name] = id;
  }
  const priorityOptions: Record<string, string> = {};
  for (const name of Object.values(PRIORITY_PROJECT_NAME)) {
    const id = priority.options.get(name);
    if (id === undefined) {
      throw new Error(`"${name}" option not found in Priority field`);
    }
    priorityOptions[name] = id;
  }

  return {
    projectId: PROJECT_ID,
    blockedOn: { fieldId: blockedOn.id, nothingOptionId },
    effort: { fieldId: effort.id, options: effortOptions },
    priority: { fieldId: priority.id, options: priorityOptions },
  };
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
  let triageFields: TriageFields | undefined;
  let openIssuesCache: readonly { readonly number: number; readonly body: string }[] | undefined;

  const loadTriageFields = async (): Promise<TriageFields> => {
    if (triageFields !== undefined) return triageFields;
    const raw = await runner('gh', [
      'project', 'field-list', String(PROJECT_NUMBER),
      '--owner', ORG,
      '--format', 'json',
    ]);
    triageFields = parseTriageFields(raw);
    return triageFields;
  };

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
      const args = [
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        input.title,
        '--body',
        input.body,
      ];
      for (const label of input.labels) {
        args.push('--label', label);
      }
      const raw = await runner('gh', args);
      return { number: parseCreatedIssueNumber(raw) };
    },

    async ensureTriageComplete(input) {
      const typeId = issueTypeIds[input.type];
      const fieldsPromise = loadTriageFields();
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

      const issueUrl = `https://github.com/${repo}/issues/${input.issueNumber}`;
      const itemRaw = await runner('gh', [
        'project',
        'item-add',
        String(PROJECT_NUMBER),
        '--owner',
        ORG,
        '--url',
        issueUrl,
        '--format',
        'json',
      ]);
      const itemId = parseItemAddId(itemRaw);
      const fields = await fieldsPromise;

      const effortName = EFFORT_PROJECT_NAME[input.effort];
      const priorityName = PRIORITY_PROJECT_NAME[input.priority];
      const effortOptionId = fields.effort.options[effortName];
      const priorityOptionId = fields.priority.options[priorityName];
      if (effortOptionId === undefined || priorityOptionId === undefined) {
        throw new Error('Resolved triage option ids are incomplete');
      }

      const edits: Array<{ fieldId: string; optionId: string }> = [
        {
          fieldId: fields.blockedOn.fieldId,
          optionId: fields.blockedOn.nothingOptionId,
        },
        { fieldId: fields.effort.fieldId, optionId: effortOptionId },
        { fieldId: fields.priority.fieldId, optionId: priorityOptionId },
      ];
      await Promise.all(edits.map((edit) => runner('gh', [
        'project',
        'item-edit',
        '--id',
        itemId,
        '--project-id',
        fields.projectId,
        '--field-id',
        edit.fieldId,
        '--single-select-option-id',
        edit.optionId,
      ])));
    },
  };
}
