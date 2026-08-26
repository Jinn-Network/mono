import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimPolicySurface } from './claim-policy-surface';
import { SURFACE_COPY, surfaceMessage } from './surface-state';

test('claim policy 404/error is error, not loading', () => {
  const state = claimPolicySurface({
    loading: false,
    data: null,
    error: 'daemon 404',
  });
  assert.equal(state, 'error');
  assert.equal(surfaceMessage('claimPolicy', state), SURFACE_COPY.claimPolicy.error);
});

test('claim policy in-flight with no data is loading', () => {
  const state = claimPolicySurface({
    loading: true,
    data: null,
    error: null,
  });
  assert.equal(state, 'loading');
});

test('claim policy with data is ready even if a later reload is in flight', () => {
  const state = claimPolicySurface({
    loading: true,
    data: { claimPolicy: { mode: 'claim-nothing' } },
    error: null,
  });
  assert.equal(state, 'ready');
});
