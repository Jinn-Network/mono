import { describe, expect, it } from 'vitest';
import { mapStatusToDeriveInput } from './useNotifications.js';

describe('mapStatusToDeriveInput — password rotation (#441)', () => {
  it('maps security.lastPasswordRotationAt into passwordRotatedAt', () => {
    const iso = '2024-01-02T03:04:05.000Z';
    const mapped = mapStatusToDeriveInput(
      { security: { lastPasswordRotationAt: iso } },
      {},
      false,
    );
    expect(mapped.passwordRotatedAt).toBe(iso);
  });

  it('maps a null/absent rotation to undefined (notification stays silent)', () => {
    expect(
      mapStatusToDeriveInput({ security: { lastPasswordRotationAt: null } }, {}, false)
        .passwordRotatedAt,
    ).toBeUndefined();
    expect(
      mapStatusToDeriveInput({}, {}, false).passwordRotatedAt,
    ).toBeUndefined();
  });
});
