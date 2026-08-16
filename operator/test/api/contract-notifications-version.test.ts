import { describe, expect, it } from 'vitest';
import { notificationsV1ResponseSchema } from '../../src/api/contract/notifications.js';
import { CURRENT_CONTRACT_VERSION } from '../../src/api/contract/version.js';

describe('notificationsV1ResponseSchema contractVersion', () => {
  it('rejects an envelope that omits contractVersion', () => {
    const parsed = notificationsV1ResponseSchema.safeParse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      notifications: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts CURRENT_CONTRACT_VERSION on the envelope', () => {
    const parsed = notificationsV1ResponseSchema.parse({
      schemaVersion: 1,
      contractVersion: CURRENT_CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      notifications: [],
    });
    expect(parsed.contractVersion).toEqual({ major: 1, minor: 0 });
  });
});
