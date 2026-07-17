import { describe, expect, it } from 'vitest';
import {
  HERMES_STATELESS_LAUNCHER,
  assertHermesBillingRoute,
  assertHermesRuntimeFiles,
  assertHermesRuntimeReady,
  hermesChatArgs,
} from '../../src/dispatcher/hermes-runtime.js';

describe('hermesChatArgs', () => {
  it('builds a stateless non-interactive chat invocation with an explicit provider', () => {
    expect(hermesChatArgs('PROMPT', {
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
    })).toEqual([
      HERMES_STATELESS_LAUNCHER,
      'chat', '-q', 'PROMPT', '-Q', '--yolo', '--accept-hooks',
      '--model', 'gpt-5.6-sol',
      '--provider', 'openai-codex',
    ]);
  });
});

describe('assertHermesRuntimeFiles', () => {
  it('fails loudly when the Hermes Python interpreter is missing', () => {
    expect(() => assertHermesRuntimeFiles('/missing/python', () => false))
      .toThrow(/Hermes Python interpreter.*missing/);
  });

  it('fails loudly when the Jinn stateless launcher is missing', () => {
    expect(() => assertHermesRuntimeFiles('/present/python', (path) => (
      path === '/present/python'
    ))).toThrow(/Hermes stateless launcher.*missing/);
  });
});

describe('assertHermesRuntimeReady', () => {
  it('probes the configured interpreter for both required Hermes imports', () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    assertHermesRuntimeReady('/opt/hermes/python', {
      exists: () => true,
      probe: (command, args) => {
        calls.push({ command, args: [...args] });
        return { status: 0, stderr: '' };
      },
    });

    expect(calls).toEqual([{
      command: '/opt/hermes/python',
      args: [
        '-c',
        'import gateway.session_context; import hermes_cli.main',
      ],
    }]);
  });

  it('fails with the interpreter, import error, and remediation on nonzero exit', () => {
    expect(() => assertHermesRuntimeReady('/broken/hermes/python', {
      exists: () => true,
      probe: () => ({
        status: 1,
        stderr: "ModuleNotFoundError: No module named 'hermes_cli'",
      }),
    })).toThrow(
      /\/broken\/hermes\/python.*ModuleNotFoundError.*JINN_DISPATCHER_HERMES_PYTHON.*install Hermes/s,
    );
  });

  it('fails with the interpreter, spawn error, and remediation when probing cannot start', () => {
    expect(() => assertHermesRuntimeReady('/unusable/hermes/python', {
      exists: () => true,
      probe: () => ({
        status: null,
        stderr: '',
        error: new Error('spawn EACCES'),
      }),
    })).toThrow(
      /\/unusable\/hermes\/python.*spawn EACCES.*JINN_DISPATCHER_HERMES_PYTHON.*install Hermes/s,
    );
  });

  it('keeps Python traceback diagnostics concise', () => {
    let message = '';
    try {
      assertHermesRuntimeReady('/broken/hermes/python', {
        exists: () => true,
        probe: () => ({
          status: 1,
          stderr: [
            'Traceback (most recent call last):',
            '  File "<string>", line 1, in <module>',
            "ModuleNotFoundError: No module named 'gateway'",
          ].join('\n'),
        }),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("ModuleNotFoundError: No module named 'gateway'");
    expect(message).not.toContain('Traceback');
  });
});

describe('assertHermesBillingRoute', () => {
  it('rejects an org-prefixed model id', () => {
    expect(() => assertHermesBillingRoute('openai/gpt-5.6-sol', 'openai-codex'))
      .toThrow(/bare.*JINN_DISPATCHER_HERMES_MODEL/i);
  });

  it('rejects any provider other than the subscription provider', () => {
    expect(() => assertHermesBillingRoute('gpt-5.6-sol', 'openrouter'))
      .toThrow(/openai-codex.*JINN_DISPATCHER_HERMES_PROVIDER/i);
  });

  it('accepts a bare model id with the explicit subscription provider', () => {
    expect(() => assertHermesBillingRoute('gpt-5.6-sol', 'openai-codex'))
      .not.toThrow();
  });
});
