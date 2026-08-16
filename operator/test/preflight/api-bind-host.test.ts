/**
 * §14.4 — apiBindHost resolution: env override wins, else config, else
 * loopback. Regression for the dead config-file knob (main.ts used to read
 * only `process.env['JINN_API_BIND_HOST']`, ignoring `config.apiBindHost`).
 */
import { describe, expect, it } from 'vitest';
import { resolveApiBindHost, isLoopbackBindHost } from '../../src/preflight/api-bind-host.js';

describe('resolveApiBindHost', () => {
  it('falls back to loopback when neither env nor config set it', () => {
    expect(resolveApiBindHost(undefined, {})).toBe('127.0.0.1');
  });

  it('activates the config-file value when env is unset — the dead-knob fix', () => {
    expect(resolveApiBindHost('0.0.0.0', {})).toBe('0.0.0.0');
  });

  it('env override wins over a configured value', () => {
    expect(resolveApiBindHost('0.0.0.0', { JINN_API_BIND_HOST: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('env override wins even when config is unset', () => {
    expect(resolveApiBindHost(undefined, { JINN_API_BIND_HOST: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('ignores an empty-string env override', () => {
    expect(resolveApiBindHost('0.0.0.0', { JINN_API_BIND_HOST: '' })).toBe('0.0.0.0');
  });

  it('ignores an empty-string config value', () => {
    expect(resolveApiBindHost('', {})).toBe('127.0.0.1');
  });
});

describe('isLoopbackBindHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]'])('treats %s as loopback', (host) => {
    expect(isLoopbackBindHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '10.0.0.5', 'example.com'])('treats %s as non-loopback', (host) => {
    expect(isLoopbackBindHost(host)).toBe(false);
  });
});
