/**
 * Shared Project-field triage for machine-filed issues (children, follow-ups).
 * DR-2026-05-20-b: Blocked on / Effort / Priority live on the Project board.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { ORG, PROJECT_NUMBER, REPO } from '../dispatcher/constants.js';
import { PROJECT_ID } from '../dispatcher/field-cache.js';

export type MachineTriageEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type MachineTriagePriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';

export const EFFORT_PROJECT_NAME: Record<MachineTriageEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export const PRIORITY_PROJECT_NAME: Record<MachineTriagePriority, string> = {
  p0: 'P0',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  p4: 'P4',
};

interface TriageFields {
  readonly projectId: string;
  readonly blockedOn: { readonly fieldId: string; readonly nothingOptionId: string };
  readonly effort: { readonly fieldId: string; readonly options: Record<string, string> };
  readonly priority: { readonly fieldId: string; readonly options: Record<string, string> };
}

export function parseItemAddId(raw: string): string {
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

export function parseTriageFields(raw: string): TriageFields {
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

export interface ProjectTriageApplier {
  applyMachineTriage(input: {
    readonly issueNumber: number;
    readonly effort: MachineTriageEffort;
    readonly priority: MachineTriagePriority;
  }): Promise<void>;
}

export function createProjectTriageApplier(
  runner: CommandRunner,
  options: { readonly repo?: string } = {},
): ProjectTriageApplier {
  const repo = options.repo ?? REPO;
  let triageFields: TriageFields | undefined;

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

  return {
    async applyMachineTriage(input) {
      const fields = await loadTriageFields();
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
