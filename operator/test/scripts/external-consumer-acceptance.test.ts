import { describe, expect, it } from 'vitest';
import * as acceptance from '../../scripts/external-consumer-acceptance.mjs';

describe('external consumer acceptance helpers', () => {
  it('defaults to local tarballs and requires exact registry package versions', () => {
    expect(acceptance.parseAcceptanceArgs).toBeTypeOf('function');
    expect(acceptance.parseAcceptanceArgs!([])).toEqual({ mode: 'local' });
    expect(acceptance.parseAcceptanceArgs!([
      '--registry',
      '--sdk-spec',
      '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      '--client-spec',
      '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    ])).toEqual({
      mode: 'registry',
      sdkSpec: '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      clientSpec: '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    });
    expect(() => acceptance.parseAcceptanceArgs!([
      '--registry',
      '--sdk-spec',
      '@jinn-network/sdk@canary',
      '--client-spec',
      '@jinn-network/operator@^0.2.1',
    ])).toThrow(/exact version/);
  });

  it('requires the installed CLI malformed-input probe to return invalid_invocation', () => {
    expect(acceptance.assertInvalidInvocation).toBeTypeOf('function');
    expect(() => acceptance.assertInvalidInvocation!(
      { status: 11, stdout: '{"code":"invalid_invocation"}\n', stderr: '' },
      'submit',
    )).not.toThrow();
    expect(() => acceptance.assertInvalidInvocation!(
      { status: 1, stdout: '{"code":"transient_error"}\n', stderr: '' },
      'observation',
    )).toThrow(/observation.*invalid_invocation/);
  });

  it('resolves manifest schema names through the public SDK modules', () => {
    const submitSchema = { safeParse: () => ({ success: true }) };
    const sessionSchema = { safeParse: () => ({ success: true }) };
    const commentParser = () => ({ receipt: {}, canonicalJson: '{}' });
    expect(acceptance.resolveFixtureSchema).toBeTypeOf('function');
    expect(acceptance.resolveFixtureSchema!(
      'jinn-task-submit-request.v1',
      { TaskSubmitRequestV1Schema: submitSchema },
      {},
    )).toBe(submitSchema);
    expect(acceptance.resolveFixtureSchema!(
      'jinn-autopilot-session.v1',
      { AutopilotSessionCapsuleSchema: sessionSchema },
      {},
    )).toBe(sessionSchema);
    expect(acceptance.resolveFixtureSchema!(
      'AutopilotAdoptionReceiptComment',
      { parseAutopilotAdoptionReceiptComment: commentParser },
      {},
    )).toBe(commentParser);
  });

  it('writes Yarn consumer dependencies as bare versions, not name@version descriptors', () => {
    expect(acceptance.yarnConsumerManifest!({
      sdkSpec: '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      clientSpec: '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    })).toEqual({
      private: true,
      packageManager: 'yarn@4.13.0',
      dependencies: {
        '@jinn-network/sdk': '0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
        '@jinn-network/operator': '0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      },
    });
  });
});
