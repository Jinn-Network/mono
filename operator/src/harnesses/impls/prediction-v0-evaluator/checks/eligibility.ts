import type { Check } from '../types.js';
import type { Window } from '../../../../types/task.js';

export function checkSubmissionWithinWindow(
  submittedAt: number,
  window: Window,
): Check {
  const within = submittedAt >= window.startTs && submittedAt <= window.endTs;
  return {
    name: 'eligibility.submission_within_window',
    status: within ? 'PASS' : 'FAIL',
    detail: within ? undefined : {
      submittedAt,
      startTs: window.startTs,
      endTs: window.endTs,
    },
  };
}
