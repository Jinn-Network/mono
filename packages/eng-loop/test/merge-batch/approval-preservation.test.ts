import { describe, expect, it } from 'vitest';
import { classifyApprovalPreservation } from '../../src/merge-batch/approval-preservation.js';

describe('classifyApprovalPreservation', () => {
  it('preserves approval when range-diff reports equal commits', () => {
    const output = [
      '1:  abc123 = 1:  def456 fix(api): correct pagination',
      '2:  bcd234 = 2:  efg567 test(api): cover pagination',
    ].join('\n');

    expect(classifyApprovalPreservation(output)).toEqual({
      kind: 'preserved',
      reason: 'range-diff shows patch-equivalent commits',
    });
  });

  it('requires review when range-diff reports changed commits', () => {
    const output = [
      '1:  abc123 ! 1:  def456 fix(api): correct pagination',
      '    @@ client/src/api/server.ts @@',
    ].join('\n');

    expect(classifyApprovalPreservation(output)).toEqual({
      kind: 'requires-review',
      reason: 'range-diff shows changed patch content',
    });
  });

  it('requires review when conflict resolution added commits', () => {
    const output = [
      '1:  abc123 = 1:  def456 fix(api): correct pagination',
      '-:  ------ > 2:  efg567 fix merge conflict',
    ].join('\n');

    expect(classifyApprovalPreservation(output)).toEqual({
      kind: 'requires-review',
      reason: 'range-diff shows added or removed commits',
    });
  });
});
