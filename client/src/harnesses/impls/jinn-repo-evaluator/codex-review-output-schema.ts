const gitOid = {
  type: 'string',
  pattern: '^[0-9a-f]{40}$',
} as const;

const uuid = {
  type: 'string',
  format: 'uuid',
} as const;

const printableString = {
  type: 'string',
  minLength: 1,
  pattern: '^[\\x20-\\x7e]+$',
} as const;

function boundedText(maxLength: number) {
  return {
    type: 'string',
    minLength: 1,
    maxLength,
    pattern: '^[^\\u0000]+$',
  } as const;
}

function boundedSingleLine(maxLength: number) {
  return {
    type: 'string',
    minLength: 1,
    maxLength,
    pattern: '^[^\\r\\n\\u0000]+$',
  } as const;
}

const reviewBody = boundedText(48 * 1024);
const reviewTitle = boundedSingleLine(240);
const reviewPath = boundedText(1_024);
const humanDetail = boundedText(8 * 1024);

const correlation = {
  type: 'object',
  additionalProperties: false,
  required: [
    'taskId',
    'attemptIndex',
    'requestId',
    'deliveryEnvelopeCid',
    'v2AttemptId',
    'claimOid',
    'prNumber',
    'expectedHead',
    'resultingHead',
    'reviewedHead',
    'reviewGeneration',
    'reviewRefOid',
  ],
  properties: {
    taskId: printableString,
    attemptIndex: { type: 'integer', minimum: 0 },
    requestId: printableString,
    deliveryEnvelopeCid: printableString,
    v2AttemptId: uuid,
    claimOid: gitOid,
    prNumber: { type: 'integer', minimum: 1 },
    expectedHead: gitOid,
    resultingHead: gitOid,
    reviewedHead: gitOid,
    reviewGeneration: uuid,
    reviewRefOid: gitOid,
  },
} as const;

const followUp = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'body', 'effort', 'priority'],
  properties: {
    type: { enum: ['feat', 'chore', 'fix', 'refactor'] },
    title: reviewTitle,
    body: reviewBody,
    effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    priority: { enum: ['p0', 'p1', 'p2', 'p3', 'p4'] },
  },
} as const;

const finding = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: reviewTitle,
    body: reviewBody,
    path: reviewPath,
    line: { type: 'integer', minimum: 1 },
  },
} as const;

const humanReason = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'detail'],
  properties: {
    code: printableString,
    detail: humanDetail,
  },
} as const;

/**
 * Trusted output contract passed directly to `codex exec --output-schema`.
 * The SDK Zod schema remains the authoritative parser after execution; this
 * schema narrows generation at the provider boundary and mirrors every object
 * level as closed (`additionalProperties: false`).
 */
export const CODEX_REVIEW_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'outcome', 'correlation', 'body'],
      properties: {
        schemaVersion: { const: 'jinn-autopilot-review-result.v1' },
        outcome: { const: 'approve' },
        correlation,
        body: reviewBody,
        followUps: {
          type: 'array',
          maxItems: 5,
          items: followUp,
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'outcome', 'correlation', 'findings'],
      properties: {
        schemaVersion: { const: 'jinn-autopilot-review-result.v1' },
        outcome: { const: 'request-changes' },
        correlation,
        findings: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: finding,
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'outcome', 'correlation', 'reason'],
      properties: {
        schemaVersion: { const: 'jinn-autopilot-review-result.v1' },
        outcome: { const: 'human' },
        correlation,
        reason: humanReason,
      },
    },
  ],
} as const;
