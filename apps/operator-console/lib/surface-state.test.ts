import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySurface,
  SURFACE_COPY,
  surfaceMessage,
  type SurfaceName,
} from './surface-state';

const PAGES: SurfaceName[] = [
  'overview',
  'events',
  'notifications',
  'claimPolicy',
  'network',
  'security',
  'posting',
];

for (const name of PAGES) {
  test(`${name} loading state`, () => {
    const state = classifySurface({ loading: true, error: null, empty: true });
    assert.equal(state, 'loading');
    assert.equal(surfaceMessage(name, state), SURFACE_COPY[name].loading);
  });

  test(`${name} empty state`, () => {
    const state = classifySurface({ loading: false, error: null, empty: true });
    assert.equal(state, 'empty');
    assert.equal(surfaceMessage(name, state), SURFACE_COPY[name].empty);
  });

  test(`${name} error state`, () => {
    const state = classifySurface({
      loading: false,
      error: 'boom',
      empty: false,
    });
    assert.equal(state, 'error');
    assert.equal(surfaceMessage(name, state), SURFACE_COPY[name].error);
  });
}
