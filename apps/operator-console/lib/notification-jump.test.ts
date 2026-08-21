import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleJumpHref } from './notification-jump';

test('maps daemon /overview onto this console Overview route', () => {
  assert.equal(consoleJumpHref('/overview'), '/');
});

test('keeps Claim policy, Network, and Security jumps', () => {
  assert.equal(consoleJumpHref('/operator/claim-policy'), '/operator/claim-policy');
  assert.equal(consoleJumpHref('/operator/network'), '/operator/network');
  assert.equal(consoleJumpHref('/operator/security'), '/operator/security');
});

test('drops missing, off-console, and open-redirect jumps', () => {
  assert.equal(consoleJumpHref(undefined), null);
  assert.equal(consoleJumpHref('https://evil.example/'), null);
  assert.equal(consoleJumpHref('//evil.example'), null);
  assert.equal(consoleJumpHref('/operator/memberships'), null);
});

test('does not treat Object.prototype keys as console routes', () => {
  assert.equal(consoleJumpHref('__proto__'), null);
  assert.equal(consoleJumpHref('constructor'), null);
  assert.equal(consoleJumpHref('toString'), null);
  assert.equal(consoleJumpHref(''), null);
});

test('maps bootstrap jump / onto Overview', () => {
  assert.equal(consoleJumpHref('/'), '/');
});
