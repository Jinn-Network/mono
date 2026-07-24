import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  formatAutopilotAdoptionReceiptComment,
  parseAutopilotAdoptionReceiptComment,
} from '../src/autopilot-adoption-comment.js';
import {
  AutopilotAdoptionReceiptSchema,
} from '../src/autopilot-session.js';

const fixtureDirectory = fileURLToPath(
  new URL('./fixtures/autopilot-session/', import.meta.url),
);

function receiptFixture() {
  return AutopilotAdoptionReceiptSchema.parse(JSON.parse(readFileSync(
    `${fixtureDirectory}receipt-solution-accepted.json`,
    'utf8',
  )) as unknown);
}

describe('Autopilot adoption receipt comment codec', () => {
  it('formats the accepted Solution fixture byte-for-byte as the golden comment', () => {
    const receipt = receiptFixture();
    const golden = readFileSync(
      `${fixtureDirectory}receipt-solution-accepted-comment.txt`,
      'utf8',
    ).trimEnd();

    expect(formatAutopilotAdoptionReceiptComment(receipt)).toBe(golden);
    expect(parseAutopilotAdoptionReceiptComment(golden)).toEqual({
      receipt,
      canonicalJson: JSON.stringify(receipt),
    });
  });

  it('requires the whole canonical comment and rejects lookalike markers', () => {
    const receipt = receiptFixture();
    const body = formatAutopilotAdoptionReceiptComment(receipt);

    expect(parseAutopilotAdoptionReceiptComment(`prefix\n${body}`)).toBeNull();
    expect(parseAutopilotAdoptionReceiptComment(`${body}\nsuffix`)).toBeNull();
    expect(parseAutopilotAdoptionReceiptComment(
      body.replace('adoption-receipt:v1', 'adoption-receipt:v10'),
    )).toBeNull();
  });

  it('rejects non-canonical JSON and marker/payload disagreements', () => {
    const receipt = receiptFixture();
    const body = formatAutopilotAdoptionReceiptComment(receipt);

    expect(parseAutopilotAdoptionReceiptComment(
      body.replace(
        JSON.stringify(receipt),
        JSON.stringify(receipt, null, 2),
      ),
    )).toBeNull();
    expect(parseAutopilotAdoptionReceiptComment(
      body.replace('"taskId":"501"', '"taskId":"502"'),
    )).toBeNull();
  });
});
