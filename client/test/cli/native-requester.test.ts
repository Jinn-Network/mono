import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { createNativeRequesterCommand } from '../../src/cli/commands/native-requester.js';
import type { CommandContext } from '../../src/cli/command.js';

function captureIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit: (code: number) => { exits.push(code); },
    writes,
    exits,
  };
}

function context(argv: string[]) {
  const io = captureIo();
  return {
    io,
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: io.writer,
      exit: io.exit,
      env: {},
    } satisfies CommandContext,
  };
}

describe('native requester CLI surface', () => {
  it('registers the accepted native-vertical request spelling', async () => {
    const io = captureIo();

    await runCli([
      'native-vertical', 'request',
      '--network', 'base-sepolia',
      '--fixture', 'prediction-forecast-golden.json',
      '--run-id', 'operator-run-20260802',
    ], { writer: io.writer, exit: io.exit, stdoutIsTty: false });

    const result = JSON.parse(io.writes.at(-1)!);
    expect(result.code).not.toBe('invalid_invocation');
    expect(result.details?.state).not.toBe('feature-disabled');
  });

  it('documents the accepted request shape', async () => {
    const io = captureIo();

    await runCli(['native-vertical', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });

    expect(io.writes.join('')).toContain(
      'jinn native-vertical request --network base-sepolia --fixture prediction-forecast-golden.json --run-id <run-id>',
    );
    expect(io.exits).toEqual([]);
  });

  it('reports read-only readiness without loading execution authority', async () => {
    const events: string[] = [];
    const command = createNativeRequesterCommand({
      async preflightRequest() {
        events.push('preflight');
        return {
          chainId: 84532,
          contractsVerified: true,
          contractCodeVerified: true,
          fundingVerified: true,
          transactionCapsVerified: true,
        };
      },
      async loadExecutor() {
        events.push('load-executor');
        throw new Error('execution authority must not load during readiness');
      },
    });
    const { ctx, io } = context([
      'request',
      '--network', 'base-sepolia',
      '--fixture', 'prediction-forecast-golden.json',
      '--run-id', 'operator-run-20260802',
    ]);

    await command.run(ctx);

    expect(events).toEqual(['preflight']);
    expect(JSON.parse(io.writes.join(''))).toEqual({
      schemaVersion: 1,
      kind: 'native_vertical_request_readiness',
      network: 'base-sepolia',
      fixture: 'prediction-forecast-golden.json',
      runId: 'operator-run-20260802',
      executeAuthorized: false,
      sideEffects: false,
      preflight: {
        chainId: 84532,
        contractsVerified: true,
        contractCodeVerified: true,
        fundingVerified: true,
        transactionCapsVerified: true,
      },
    });
    expect(io.exits).toEqual([]);
  });

  it('fails preflight without loading keys or transaction authority', async () => {
    const events: string[] = [];
    const command = createNativeRequesterCommand({
      async preflightRequest() {
        events.push('preflight');
        throw new Error('configured coordinator has no contract code');
      },
      async loadExecutor() {
        events.push('load-executor');
        throw new Error('must not load');
      },
    });
    const { ctx, io } = context([
      'request',
      '--network', 'base-sepolia',
      '--fixture', 'prediction-forecast-golden.json',
      '--run-id', 'operator-run-20260802',
    ]);

    await command.run(ctx);

    expect(events).toEqual(['preflight']);
    expect(JSON.parse(io.writes.join(''))).toMatchObject({
      code: 'bootstrap_incomplete',
      details: {
        feature: 'native-vertical',
        state: 'preflight-refused',
        sideEffects: false,
        reason: 'configured coordinator has no contract code',
      },
    });
    expect(io.exits).toEqual([20]);
  });

  it('loads execution authority only after preflight and two explicit authorizations', async () => {
    const events: string[] = [];
    const command = createNativeRequesterCommand({
      installShutdownHandlers(close) {
        events.push('shutdown-handlers');
        expect(close).toEqual(expect.any(Function));
      },
      async preflightRequest() {
        events.push('preflight');
        return {
          chainId: 84532,
          contractsVerified: true,
          contractCodeVerified: true,
          fundingVerified: true,
          transactionCapsVerified: true,
        };
      },
      async loadExecutor(input) {
        events.push(`load-executor:${input.password}`);
        return {
          async close() { events.push('close'); },
          async request(request) {
            events.push(`request:${request.runId}`);
            return {
              taskDigest: `sha256:${'1'.repeat(64)}` as const,
              submissionDigest: `sha256:${'2'.repeat(64)}` as const,
              taskId: '42',
              transactionHash: `0x${'3'.repeat(64)}` as const,
              sourceSequence: '7',
              sourceEntryDigest: `sha256:${'4'.repeat(64)}` as const,
            };
          },
        };
      },
    });
    const { ctx, io } = context([
      'request',
      '--network', 'base-sepolia',
      '--fixture', 'prediction-forecast-golden.json',
      '--run-id', 'operator-run-20260802',
      '--execute',
    ]);
    ctx.env.JINN_NATIVE_VERTICAL_EXECUTE = '1';
    ctx.env.JINN_PASSWORD = 'keystore-secret';

    await command.run(ctx);

    expect(events).toEqual([
      'preflight',
      'load-executor:keystore-secret',
      'shutdown-handlers',
      'request:operator-run-20260802',
    ]);
    expect(JSON.parse(io.writes.join(''))).toEqual({
      schemaVersion: 1,
      kind: 'native_vertical_request_announced',
      network: 'base-sepolia',
      fixture: 'prediction-forecast-golden.json',
      runId: 'operator-run-20260802',
      executeAuthorized: true,
      sideEffects: true,
      result: {
        taskDigest: `sha256:${'1'.repeat(64)}`,
        submissionDigest: `sha256:${'2'.repeat(64)}`,
        taskId: '42',
        transactionHash: `0x${'3'.repeat(64)}`,
        sourceSequence: '7',
        sourceEntryDigest: `sha256:${'4'.repeat(64)}`,
      },
    });
    expect(io.exits).toEqual([]);
  });

  it('refuses --execute without the independent environment authorization', async () => {
    const events: string[] = [];
    const command = createNativeRequesterCommand({
      async preflightRequest() {
        events.push('preflight');
        return {
          chainId: 84532,
          contractsVerified: true,
          contractCodeVerified: true,
          fundingVerified: true,
          transactionCapsVerified: true,
        };
      },
      async loadExecutor() {
        events.push('load-executor');
        throw new Error('must not load');
      },
    });
    const { ctx, io } = context([
      'request',
      '--network', 'base-sepolia',
      '--fixture', 'prediction-forecast-golden.json',
      '--run-id', 'operator-run-20260802',
      '--execute',
    ]);
    ctx.env.JINN_PASSWORD = 'keystore-secret';

    await command.run(ctx);

    expect(events).toEqual(['preflight']);
    expect(JSON.parse(io.writes.join(''))).toMatchObject({
      code: 'invalid_invocation',
      details: { state: 'execute-authority-missing', sideEffects: false },
    });
    expect(io.exits).toEqual([11]);
  });
});
