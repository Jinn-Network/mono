import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareContractVersion } from './handshake';
import { CONSOLE_CONTRACT_VERSION } from './contract-version';

test('major 2 vs console 1.0 is incompatible', () => {
  const verdict = compareContractVersion({ major: 2, minor: 0 });
  assert.equal(verdict.status, 'incompatible');
  if (verdict.status === 'incompatible') {
    assert.equal(verdict.reason, 'major_mismatch');
    assert.deepEqual(verdict.console, CONSOLE_CONTRACT_VERSION);
    assert.deepEqual(verdict.server, { major: 2, minor: 0 });
  }
});

test('matching 1.0 is ok', () => {
  const verdict = compareContractVersion({ major: 1, minor: 0 });
  assert.equal(verdict.status, 'ok');
});

test('server minor behind console minor is warn, not incompatible', () => {
  const verdict = compareContractVersion(
    { major: 1, minor: 0 },
    { major: 1, minor: 1 },
  );
  assert.equal(verdict.status, 'warn');
  if (verdict.status === 'warn') {
    assert.equal(verdict.reason, 'minor_mismatch');
  }
});

test('server minor ahead of console minor is warn, not incompatible', () => {
  const verdict = compareContractVersion({ major: 1, minor: 2 });
  assert.equal(verdict.status, 'warn');
});
