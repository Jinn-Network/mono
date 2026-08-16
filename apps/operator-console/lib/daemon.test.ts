import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPERATOR_URL, operatorUrl, UI_TOKEN_HEADER } from './daemon';

test('operator URL defaults to loopback :7331', () => {
  const previousPublic = process.env.NEXT_PUBLIC_JINN_OPERATOR_URL;
  const previousEnv = process.env.JINN_OPERATOR_URL;
  delete process.env.NEXT_PUBLIC_JINN_OPERATOR_URL;
  delete process.env.JINN_OPERATOR_URL;
  try {
    assert.equal(operatorUrl(), DEFAULT_OPERATOR_URL);
  } finally {
    if (previousPublic !== undefined) process.env.NEXT_PUBLIC_JINN_OPERATOR_URL = previousPublic;
    if (previousEnv !== undefined) process.env.JINN_OPERATOR_URL = previousEnv;
  }
});

test('JINN_OPERATOR_URL wins when the public env is unset', () => {
  const previousPublic = process.env.NEXT_PUBLIC_JINN_OPERATOR_URL;
  const previousEnv = process.env.JINN_OPERATOR_URL;
  delete process.env.NEXT_PUBLIC_JINN_OPERATOR_URL;
  process.env.JINN_OPERATOR_URL = 'http://127.0.0.1:9331/';
  try {
    assert.equal(operatorUrl(), 'http://127.0.0.1:9331');
  } finally {
    if (previousPublic !== undefined) process.env.NEXT_PUBLIC_JINN_OPERATOR_URL = previousPublic;
    else delete process.env.NEXT_PUBLIC_JINN_OPERATOR_URL;
    if (previousEnv !== undefined) process.env.JINN_OPERATOR_URL = previousEnv;
    else delete process.env.JINN_OPERATOR_URL;
  }
});

test('UI token travels as x-jinn-ui-token, never a cookie name', () => {
  assert.equal(UI_TOKEN_HEADER, 'x-jinn-ui-token');
});
